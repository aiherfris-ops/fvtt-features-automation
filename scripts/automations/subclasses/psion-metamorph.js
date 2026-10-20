import { LOG, MODULE_ID } from "../../core/constants.js";
import { registerDamageBonusProvider, syncDamageBonusMacro } from "../../core/damage-bonus.js";
import { onItemUse, onPreAttackRoll, onSpellWorkflowComplete, onWorkflowComplete } from "../../core/hooks.js";
import { chat, featById, isActiveGM, isEnabled, runAsync } from "../../core/utils.js";
import { EnergyDice, TurnState, applyDamageSafe, createEffectsSafe, isPsion, legacyModuleActive } from "../classes/psion.js";

/*
 * Псионик — Metamorph (UA 2025). Перенесено из модуля psion-automation.
 *  - Organic Weapons: одна активная форма, переключение диалогом, атака формой переключает сама;
 *    Bone Blade — преимущество, если рядом с целью союзник; Flesh Maul — помеха на следующий спасбросок
 *    Силы/Телосложения; Viscera Launcher — доп. 1d6 кислотой раз в свой ход (в общем окне бонусов урона).
 *  - Mutable Form: кость тратится родным расходом, временные хиты = кость + Инт, скорость +5 футов;
 *    Flesh Weaver (ещё кость: +2 КД и Empowered Healing), Improved Mutable Form (выбор бонуса, 10 минут).
 *  Досягаемость +5 и касание на 10 футов в данных dnd5e не выразить — только в описании эффекта.
 */

const { DialogV2 } = foundry.applications.api;

const FORMS = {
  "bone-blade": "Bone Blade",
  "flesh-maul": "Flesh Maul",
  "viscera-launcher": "Viscera Launcher",
};

const FORM_ATTACKS = {
  "bone-blade": { attackType: "melee", damage: { number: 1, denomination: 8, types: ["piercing"] }, range: { units: "ft", value: "5" } },
  "flesh-maul": { attackType: "melee", damage: { number: 1, denomination: 10, types: ["bludgeoning"] }, range: { units: "ft", value: "5" } },
  "viscera-launcher": { attackType: "ranged", damage: { number: 1, denomination: 6, types: ["acid"] },
    range: { units: "ft", value: "30", special: "Дальняя дистанция 90 футов (помеха дальше 30)" } },
};

const STONY_TYPES = ["acid", "bludgeoning", "cold", "fire", "lightning", "piercing", "poison", "slashing", "thunder"];
const change = (key, type, value) => ({ key, type, value, phase: "initial" });

/* -------------------------------------------- */
/*  Organic Weapons                             */
/* -------------------------------------------- */

const currentForm = actor => actor.getFlag(MODULE_ID, "organicForm") ?? null;

async function setForm(actor, form, { announce = true } = {}) {
  if (currentForm(actor) === form) return;
  await actor.setFlag(MODULE_ID, "organicForm", form);
  if (!announce) return;
  await chat(actor, form
    ? `<p><b>Organic Weapons:</b> конечность ${actor.name} превращается в <b>${FORMS[form]}</b>.</p>`
    : `<p><b>Organic Weapons:</b> конечность ${actor.name} возвращает обычную форму.</p>`);
}

async function switchForm(activity) {
  const actor = activity.item.actor;
  const owned = Object.keys(FORMS).filter(id => featById(actor, id));
  const choice = await DialogV2.wait({
    window: { title: "Organic Weapons" },
    content: `<p>Сейчас: <b>${FORMS[currentForm(actor)] ?? "обычная конечность"}</b>. Превратить в:</p>`,
    buttons: [...owned.map(id => ({ action: id, label: FORMS[id] })), { action: "revert", label: "Обычная конечность" }],
    rejectClose: false,
  });
  if (choice) await setForm(actor, choice === "revert" ? null : choice);
}

/** Bone Blade: преимущество, если в 5 футах от цели дееспособный союзник */
function boneBladeAdvantage(config) {
  const activity = config?.subject;
  if (activity?.item?.system?.identifier !== "bone-blade" || activity.type !== "attack") return;
  const actor = activity.item.actor;
  const attacker = actor?.getActiveTokens?.()[0];
  const target = (config.workflow?.targets?.size ? config.workflow.targets : game.user.targets)?.first?.();
  if (!attacker || !target?.actor) return;
  const ally = canvas.tokens.placeables.find(t => t !== attacker && t !== target && t.actor
    && t.document.disposition === attacker.document.disposition
    && !t.actor.statuses?.has("incapacitated")
    && canvas.grid.measurePath([t.center, target.center]).distance <= 5);
  if (!ally) return;
  config.advantage = true;
  runAsync("Bone Blade", () => chat(actor, `<p><b>Bone Blade:</b> преимущество — ${ally.name} в 5 футах от ${target.name}.</p>`));
}

/** Flesh Maul: помеха на следующий спасбросок Силы или Телосложения до начала хода цели */
async function fleshMaulHit(workflow) {
  const actor = workflow.actor;
  for (const target of workflow.hitTargets ?? []) {
    if (!target.actor) continue;
    await createEffectsSafe(target.actor, [{
      name: "Flesh Maul (помеха на спасбросок)",
      img: workflow.item.img,
      origin: workflow.item.uuid,
      duration: { value: 1, units: "rounds" },
      description: "<p>Помеха на следующий спасбросок Силы или Телосложения до начала своего следующего хода.</p>",
      system: { changes: [
        change("flags.midi-qol.disadvantage.save.str", "override", "1"),
        change("flags.midi-qol.disadvantage.save.con", "override", "1"),
      ] },
      flags: {
        dae: { specialDuration: ["isSave.str", "isSave.con"] },
        [MODULE_ID]: { expireOnTurnStart: { actorUuid: target.actor.uuid, combatId: game.combat?.id ?? null } },
      },
    }]);
    await chat(actor, `<p><b>Flesh Maul:</b> у ${target.name} помеха на следующий спасбросок Силы или Телосложения.</p>`);
  }
}

/* -------------------------------------------- */
/*  Mutable Form                                */
/* -------------------------------------------- */

async function chooseImprovedOption(actor, seconds, parentId, origin) {
  const owned = [
    featById(actor, "stony-epidermis") && { action: "stony", label: "Stony Epidermis" },
    featById(actor, "superior-stride") && { action: "stride", label: "Superior Stride" },
    featById(actor, "unnatural-flexibility") && { action: "flex", label: "Unnatural Flexibility" },
  ].filter(Boolean);
  if (!owned.length) return null;

  const choice = await DialogV2.wait({
    window: { title: "Improved Mutable Form" },
    content: "<p>Выберите бонус на это использование Mutable Form:</p>",
    buttons: [...owned, { action: "none", label: "Без бонуса" }],
    rejectClose: false,
  });
  if (!choice || choice === "none") return null;
  const base = { origin, duration: { value: seconds, units: "seconds" }, flags: { [MODULE_ID]: { mutableRider: parentId } } };

  if (choice === "stony") {
    const type = await DialogV2.prompt({
      window: { title: "Stony Epidermis" },
      content: "<p>Сопротивление к типу урона:</p><select name=\"type\" style=\"width:100%\">"
        + STONY_TYPES.map(t => `<option value="${t}">${CONFIG.DND5E.damageTypes[t]?.label ?? t}</option>`).join("") + "</select>",
      ok: { label: "Выбрать", callback: (event, button) => button.form.elements.type.value },
      rejectClose: false,
    });
    if (!type) return null;
    return { ...base, name: `Stony Epidermis (сопротивление: ${CONFIG.DND5E.damageTypes[type]?.label ?? type})`,
      img: featById(actor, "stony-epidermis")?.img,
      description: "<p>Преимущество на спасброски Телосложения для концентрации; сопротивление выбранному урону.</p>",
      system: { changes: [change("system.attributes.concentration.roll.mode", "add", 1), change("system.traits.dr.value", "add", type)] } };
  }
  if (choice === "stride") {
    return { ...base, name: "Superior Stride", img: featById(actor, "superior-stride")?.img,
      description: "<p>Без доспеха: рывок бонусным действием; скорость лазания и плавания равна скорости ходьбы.</p>",
      system: { changes: [
        change("system.attributes.movement.climb", "override", "@attributes.movement.walk"),
        change("system.attributes.movement.swim", "override", "@attributes.movement.walk"),
      ] } };
  }
  return { ...base, name: "Unnatural Flexibility", img: featById(actor, "unnatural-flexibility")?.img,
    description: "<p>+2 КД; протискивание в щели от 1 дюйма и выход из пут/захвата за 5 футов движения (вручную).</p>",
    system: { changes: [change("system.attributes.ac.bonus", "add", "+ 2")] } };
}

async function mutableForm(activity) {
  const item = activity.item;
  const actor = item.actor;
  const int = actor.system.abilities?.int?.mod ?? 0;

  const stale = actor.effects.filter(e => e.getFlag(MODULE_ID, "mutableForm"));
  if (stale.length) await actor.deleteEmbeddedDocuments("ActiveEffect", stale.map(e => e.id));

  // Кость уже списана родным расходом активности
  const rolled = await EnergyDice.roll(actor, 1, { flavor: "Mutable Form — временные хиты", requireAvailable: false });
  const thp = Math.max(1, (rolled?.total ?? 1) + int);
  const improved = !!featById(actor, "improved-mutable-form");
  const seconds = improved ? 600 : 60;

  let weaver = false;
  if (featById(actor, "flesh-weaver") && EnergyDice.available(actor) >= 1) {
    weaver = await DialogV2.confirm({
      window: { title: "Flesh Weaver" },
      content: "<p>Потратить <b>ещё одну</b> кость энергии на <b>Organic Defense</b> (+2 КД) и <b>Empowered Healing</b>, пока действует Mutable Form?</p>",
      rejectClose: false,
    }) === true;
    if (weaver) weaver = await EnergyDice.spend(actor, 1);
  }

  const [parent] = await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: "Mutable Form",
    img: item.img,
    origin: item.uuid,
    duration: { value: seconds, units: "seconds" },
    description: "<p>Скорость +5 футов (автоматически). <b>Досягаемость +5 футов</b> и <b>заклинания касания действием на 10 футов</b> — вручную.</p>",
    system: { changes: [change("system.attributes.movement.bonus", "add", "+ 5")] },
    flags: { [MODULE_ID]: { mutableForm: true } },
  }]);

  const riders = [];
  if (weaver) {
    riders.push({
      name: "Organic Defense (Flesh Weaver)",
      img: featById(actor, "flesh-weaver")?.img,
      origin: item.uuid,
      duration: { value: seconds, units: "seconds" },
      description: "<p>+2 КД. Empowered Healing: при лечащем заклинании с ячейкой можно потратить кость энергии и добавить её к лечению.</p>",
      system: { changes: [change("system.attributes.ac.bonus", "add", "+ 2")] },
      flags: { [MODULE_ID]: { mutableRider: parent.id, empoweredHealing: true } },
    });
  }
  if (improved) {
    const option = await chooseImprovedOption(actor, seconds, parent.id, item.uuid);
    if (option) riders.push(option);
  }
  if (riders.length) await actor.createEmbeddedDocuments("ActiveEffect", riders);

  const current = actor.system.attributes.hp.temp ?? 0;
  if (thp > current) await actor.update({ "system.attributes.hp.temp": thp });

  await chat(actor, `<p><b>Mutable Form</b> (${improved ? "10 минут" : "1 минута"}):</p><ul>`
    + `<li><b>${thp} временных хитов</b>${thp <= current ? " (оставлены прежние, их больше)" : ""}</li>`
    + "<li>скорость +5 футов; досягаемость +5 и касание на 10 футов — вручную</li>"
    + (weaver ? "<li>Organic Defense: +2 КД, Empowered Healing активно</li>" : "")
    + "</ul>");
}

/** Empowered Healing: лечащее заклинание с ячейкой при активном Flesh Weaver */
async function empoweredHealing(workflow, activity) {
  const actor = workflow.actor;
  if (!actor?.isOwner || activity.type !== "heal") return;
  if (!actor.effects.some(e => e.active && e.getFlag(MODULE_ID, "empoweredHealing"))) return;
  const castLevel = workflow.castData?.castLevel ?? activity.item.system.level ?? 0;
  if (castLevel < 1 || EnergyDice.available(actor) < 1) return;

  const ok = await DialogV2.confirm({
    window: { title: "Empowered Healing" },
    content: "<p>Потратить кость энергии и добавить её к восстановленным хитам?</p>",
    rejectClose: false,
  });
  if (ok !== true || !await EnergyDice.spend(actor, 1)) return;
  const rolled = await EnergyDice.roll(actor, 1, { flavor: "Empowered Healing", requireAvailable: false });
  if (!rolled) return;
  const targets = [...(workflow.targets ?? [])];
  if (!targets.length) {
    await chat(actor, `<p><b>Empowered Healing:</b> добавьте <b>${rolled.total}</b> к лечению вручную (цели не найдены).</p>`);
    return;
  }
  for (const t of targets) await applyDamageSafe(t.actor, rolled.total, "healing", "Empowered Healing");
  await chat(actor, `<p><b>Empowered Healing:</b> +${rolled.total} хитов: ${targets.map(t => t.name).join(", ")}.</p>`);
}

/* -------------------------------------------- */
/*  Миграция данных импорта                     */
/* -------------------------------------------- */

async function migrateMetamorph(actor) {
  // Без разовой отметки: формы оружия появляются с уровнями и после импорта — проверка идемпотентна
  const core = featById(actor, "organic-weapons") ?? featById(actor, "mutable-form");
  if (!core) return;
  const updates = [];

  // Импорт дал формам только броски урона — добавляем атаки от Интеллекта
  for (const [identifier, blueprint] of Object.entries(FORM_ATTACKS)) {
    const item = featById(actor, identifier);
    if (!item) continue;
    const activities = item._source.system?.activities ?? {};
    if (Object.values(activities).some(a => a?.type === "attack")) continue;
    const _id = foundry.utils.randomID();
    updates.push({ _id: item.id, [`system.activities.${_id}`]: {
      _id,
      type: "attack",
      name: FORMS[identifier],
      activation: { type: "action", value: 1, override: false },
      attack: { ability: "int", bonus: "", critical: {}, flat: false, type: { value: blueprint.attackType, classification: "weapon" } },
      damage: { includeBase: false, critical: {}, parts: [{ ...blueprint.damage, bonus: "@mod" }] },
      range: { override: true, ...blueprint.range },
      target: { override: true, affects: { count: "1", type: "creature" } },
    } });
  }

  // У Viscera Launcher два одинаковых броска урона — второй подписываем
  const viscera = featById(actor, "viscera-launcher");
  const damage = Object.entries(viscera?._source.system?.activities ?? {}).filter(([, a]) => a?.type === "damage");
  if (damage.length === 2 && damage[0][1].name === damage[1][1].name) {
    updates.push({ _id: viscera.id, [`system.activities.${damage[1][0]}.name`]: "Доп. урон кислотой (раз в ход)" });
  }

  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  if (featById(actor, "viscera-launcher")) await syncDamageBonusMacro(actor);
  if (updates.length) console.log(`${LOG} Metamorph у ${actor.name}: органическое оружие исправлено (${updates.length})`);
}

/* Viscera Launcher: доп. урон в общем окне бонусов урона */
registerDamageBonusProvider({
  id: "viscera-launcher",
  enabled: () => isEnabled("psion-metamorph") && !legacyModuleActive(),

  prepare({ workflow, actor, item }) {
    if (item?.system?.identifier !== "viscera-launcher" || workflow.activity?.type !== "attack") return null;
    if (!TurnState.canVisceraExtra(actor)) return null;
    return {
      label: "Viscera Launcher: +1d6 кислотой (раз в ход)",
      apply: () => {
        TurnState.markVisceraExtra(actor);
        return { damageRoll: workflow.isCritical ? "2d6" : "1d6", damageType: "acid", flavor: "Viscera Launcher" };
      },
    };
  },
});

export default {
  id: "psion-metamorph",
  kind: "subclass",
  label: "Псионик — Metamorph",
  hint: "Organic Weapons (формы, Bone Blade, Flesh Maul, Viscera Launcher), Mutable Form, Flesh Weaver, Improved Mutable Form.",
  identifiers: ["organic-weapons", "mutable-form", "bone-blade", "flesh-maul", "viscera-launcher"],
  appliesTo: actor => isPsion(actor) && !!(featById(actor, "organic-weapons") || featById(actor, "mutable-form")),

  migrate: migrateMetamorph,

  register() {
    if (legacyModuleActive()) return;

    onItemUse("organic-weapons", (activity) => runAsync("Organic Weapons", () => switchForm(activity)));
    onItemUse("mutable-form", (activity) => runAsync("Mutable Form", () => mutableForm(activity)));
    onPreAttackRoll(boneBladeAdvantage);
    onWorkflowComplete("flesh-maul", (workflow) => fleshMaulHit(workflow));
    onSpellWorkflowComplete(empoweredHealing);

    // Атака формой сама переключает конечность (правила разрешают перед броском атаки)
    Hooks.on("dnd5e.preUseActivity", (activity) => {
      const identifier = activity?.item?.system?.identifier;
      if (!(identifier in FORMS) || activity.type !== "attack") return;
      const actor = activity.item.actor;
      if (currentForm(actor) !== identifier) runAsync("Organic Weapons", () => setForm(actor, identifier));
    });

    // Flesh Maul: помеха снимается в начале хода цели
    Hooks.on("combatTurnChange", (combat, prior, current) => {
      if (!isActiveGM()) return;
      const turnActor = combat.combatants.get(current.combatantId)?.actor?.uuid;
      for (const combatant of combat.combatants) {
        const actor = combatant.actor;
        const ids = actor?.effects.filter(e => {
          const expiry = e.getFlag(MODULE_ID, "expireOnTurnStart");
          return expiry && expiry.actorUuid === turnActor && (!expiry.combatId || expiry.combatId === combat.id);
        }).map(e => e.id) ?? [];
        if (ids.length) actor.deleteEmbeddedDocuments("ActiveEffect", ids);
      }
    });

    // Конец Mutable Form снимает её бонусы (Flesh Weaver, Improved Mutable Form)
    Hooks.on("deleteActiveEffect", (effect) => {
      if (!isActiveGM() || !effect.getFlag(MODULE_ID, "mutableForm")) return;
      const actor = effect.parent;
      if (!(actor instanceof Actor)) return;
      const riders = actor.effects.filter(e => e.getFlag(MODULE_ID, "mutableRider") === effect.id).map(e => e.id);
      if (riders.length) actor.deleteEmbeddedDocuments("ActiveEffect", riders);
    });
  },
};
