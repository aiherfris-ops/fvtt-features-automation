import { LOG, MODULE_ID } from "../../core/constants.js";
import { chat, damageTypeLabel, debugNote, runAsync, turnKey } from "../../core/utils.js";
import { onPreAttackRoll, onPreDamageRoll } from "../../core/hooks.js";
import { applyEffects, attackWorkflow, midiActive, pushTokenAway } from "../../core/native.js";

/*
 * Weapon Mastery (PHB 2024) — свойства мастерства оружия. dnd5e позволяет выбрать свойство в броске атаки
 * (только если у персонажа есть мастерство этим оружием) и сохраняет его в attackRoll.options.mastery;
 * эффекты применяет этот файл после броска атаки (Midi или родной хук dnd5e).
 * Попадание определяется сравнением броска с КД цели (в мире выключена автопроверка попаданий).
 *
 * Cleave  — попадание рукопашной: атака второго существа в 5 футах от цели, без модификатора к урону (раз в ход)
 * Graze   — промах: урон = модификатор характеристики атаки
 * Nick    — только экономия действий, не автоматизируется
 * Push    — попадание: оттолкнуть существо Large и меньше на 10 футов
 * Sap     — попадание: помеха на следующий бросок атаки цели до начала вашего хода
 * Slow    — попадание: скорость цели −10 футов до начала вашего хода (не складывается)
 * Topple  — попадание: спасбросок Телосложения (СЛ 8 + мод. + БМ) или Prone
 * Vex     — попадание: преимущество на следующую атаку по этой цели до конца вашего следующего хода
 */

const PUSHABLE_SIZES = new Set(["tiny", "sm", "med", "lg"]);

/**
 * Модификатор характеристики атаки. У броска из Midi данных броска может не быть (data пустая после
 * сериализации), поэтому основной источник — характеристика активности (для фехтовального — лучшая из Сил/Лов);
 * если в данных броска модификатор больше (Bladework подменяет его на Интеллект), берём его.
 */
function mod(workflow) {
  const ability = workflow.activity?.ability;
  const fromAbility = ability ? Number(workflow.actor?.system.abilities?.[ability]?.mod ?? 0) : 0;
  const fromRoll = Number(workflow.attackRoll?.data?.mod);
  return Number.isFinite(fromRoll) ? Math.max(fromRoll, fromAbility) : fromAbility;
}

const weaponDamageType = (workflow, item) =>
  Array.from(workflow.activity?.damage?.parts?.[0]?.types ?? [])[0]
  ?? Array.from(item?.system.damage?.base?.types ?? [])[0]
  ?? "bludgeoning";

/** Эффект на чужом актёре: напрямую, если есть права, иначе через Midi или ГМа */
const addEffect = (actor, effectData) => applyEffects(actor, [effectData]);

/** До начала следующего хода атакующего (эффект создаётся в его ход) */
const untilYourNextTurn = { value: 1, units: "rounds", expiry: "turnStart" };

/* Отдельные свойства */

async function graze(workflow, target, item) {
  const damage = mod(workflow);
  if (damage <= 0) {
    debugNote(workflow.actor, `Graze: модификатор атаки ${damage} — урона нет`);
    return;
  }
  const type = weaponDamageType(workflow, item);
  const hits = [{ tokenUuid: target.document.uuid, name: target.name, detail: "Graze (промах)",
    damages: [{ value: damage, type }], applied: false }];
  const card = globalThis.spellAutomation?.createDamageCard;
  if (card) await card(workflow.actor, { rolls: [], flavor: `${item.name} — Graze`, hits, detailLabel: "Мастерство" });
  else await chat(workflow.actor, `<p>Graze: ${target.name} получает ${damage} урона (${damageTypeLabel(type)}), несмотря на промах.</p>`);
}

async function sap(workflow, target, item) {
  await addEffect(target.actor, {
    name: "Ослаблен (Sap)", img: item.img, origin: item.uuid, duration: untilYourNextTurn,
    description: "<p>Помеха на следующий бросок атаки до начала хода атаковавшего.</p>",
    // Флаг midi оставлен для миров с midi-qol; без него помеху даёт хук броска атаки по флагу sapped
    system: { changes: [{ key: "flags.midi-qol.disadvantage.attack.all", type: "override", value: "1", phase: "initial" }] },
    flags: { [MODULE_ID]: { sapped: true } },
    flags: { dae: { stackable: "noneName", specialDuration: ["1Attack"] } },
  });
  await chat(workflow.actor, `<p>Sap: у <strong>${target.name}</strong> помеха на следующую атаку.</p>`);
}

async function slow(workflow, target, item) {
  await addEffect(target.actor, {
    name: "Замедлен (Slow)", img: item.img, origin: item.uuid, duration: untilYourNextTurn,
    description: "<p>Скорость −10 футов до начала хода атаковавшего.</p>",
    system: { changes: [{ key: "system.attributes.movement.bonus", type: "add", value: "- 10", phase: "initial" }] },
    flags: { dae: { stackable: "noneName" } },
  });
  await chat(workflow.actor, `<p>Slow: скорость <strong>${target.name}</strong> снижена на 10 футов.</p>`);
}

async function vex(workflow, target, item) {
  const actor = workflow.actor;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: `Vex: ${target.name}`, img: item.img, origin: item.uuid,
    duration: { value: 1, units: "rounds", expiry: "turnEnd" },
    description: `<p>Преимущество на следующую атаку по ${target.name}.</p>`,
    flags: { [MODULE_ID]: { vexTarget: target.actor.uuid } },
  }]);
}

async function topple(workflow, target, item) {
  const actor = workflow.actor;
  const targetActor = target.actor;
  const dc = 8 + mod(workflow) + (actor.system.attributes.prof ?? 2);

  let total;
  if (targetActor.isOwner) {
    const rolls = await targetActor.rollSavingThrow({ ability: "con", target: dc }, { configure: false });
    total = rolls?.[0]?.total;
  } else {
    const bonus = targetActor.system.abilities.con?.save?.value ?? targetActor.system.abilities.con?.mod ?? 0;
    const roll = await new Roll(`1d20 + ${bonus}`).evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: targetActor }), flavor: `Спасбросок Телосложения (Topple), СЛ ${dc}` });
    total = roll.total;
  }
  if (total == null) return;
  if (total >= dc) {
    await chat(actor, `<p>Topple: <strong>${target.name}</strong> удерживается на ногах (${total} против СЛ ${dc}).</p>`);
    return;
  }
  if (targetActor.isOwner) await targetActor.toggleStatusEffect("prone", { active: true });
  else {
    const prone = await ActiveEffect.implementation.fromStatusEffect("prone");
    await addEffect(targetActor, prone.toObject());
  }
  await chat(actor, `<p>Topple: <strong>${target.name}</strong> сбит с ног (${total} против СЛ ${dc}).</p>`);
}

async function push(workflow, target) {
  const size = target.actor.system.traits?.size;
  if (size && !PUSHABLE_SIZES.has(size)) return;
  const attacker = workflow.token?.object ?? workflow.token;
  if (!attacker) return;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Push" },
    content: `<p>Оттолкнуть <strong>${target.name}</strong> на 10 футов по прямой от себя?</p>`,
    rejectClose: false,
  });
  if (!confirmed) return;
  if (globalThis.MidiQOL?.moveTokenAwayFromPoint) await globalThis.MidiQOL.moveTokenAwayFromPoint(target, 10, attacker.center, { animate: true });
  else await pushTokenAway(target, 10, attacker.center);
}

async function cleave(workflow, target, item) {
  const actor = workflow.actor;
  const key = turnKey();
  if (actor.getFlag(MODULE_ID, "cleaving") || (key && actor.getFlag(MODULE_ID, "cleaveUsed") === key)) return;
  if (workflow.activity?.attack?.type?.value !== "melee") return;
  const attacker = workflow.token?.object ?? workflow.token;
  if (!attacker) return;

  const reach = item.system.properties?.has("rch") ? 10 : 5;
  const near = (a, b, feet) => canvas.grid.measurePath([a.center, b.center]).distance
    - (Math.max(a.document.width, b.document.width) - 1) * canvas.dimensions.distance <= feet;
  const candidates = (canvas.tokens?.placeables ?? []).filter(t =>
    t.actor && t !== target && t !== attacker && !t.document.hidden
    && t.document.disposition !== attacker.document.disposition
    && near(t, target, 5) && near(t, attacker, reach));
  if (!candidates.length) return;

  const choice = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Cleave" },
    content: "<p>Атаковать второе существо тем же оружием? Урон без модификатора характеристики (если он положительный).</p>"
      + `<select name="target"><option value="">— Не атаковать —</option>`
      + candidates.map(t => `<option value="${t.id}">${t.name}</option>`).join("") + "</select>",
    ok: { label: "Атаковать", callback: (event, button) => button.form.elements.target.value },
    rejectClose: false,
  });
  if (!choice) return;

  if (key) await actor.setFlag(MODULE_ID, "cleaveUsed", key);
  await actor.setFlag(MODULE_ID, "cleaving", item.uuid);
  canvas.tokens.get(choice)?.setTarget(true, { releaseOthers: true });
  try {
    await workflow.activity.use({}, { configure: false }, {});
  } finally {
    // Флаг снимается после броска урона (см. хук ниже); на случай отмены — страховка
    setTimeout(() => actor.getFlag(MODULE_ID, "cleaving") && actor.unsetFlag(MODULE_ID, "cleaving"), 60_000);
  }
}

const ON_HIT = { cleave, push, sap, slow, topple, vex };

async function onAttackRollComplete(workflow) {
  const mastery = workflow.attackRoll?.options?.mastery;
  const item = workflow.item;
  if (!mastery || item?.type !== "weapon") return;
  const total = workflow.attackTotal ?? workflow.attackRoll?.total;
  if (total == null) return;

  const targets = [...(workflow.targets ?? [])].filter(t => t.actor);
  if (!targets.length) {
    debugNote(workflow.actor, `Weapon Mastery (${mastery}): нет выбранной цели — эффект не применён`);
    return;
  }
  console.log(`${LOG} Weapon Mastery ${mastery}: бросок ${total}, целей ${targets.length}`);

  for (const target of targets) {
    const ac = target.actor.system.attributes?.ac?.value ?? 0;
    const hit = workflow.isCritical || (!workflow.isFumble && total >= ac);
    try {
      if (!hit && mastery === "graze") await graze(workflow, target, item);
      else if (hit && ON_HIT[mastery]) await ON_HIT[mastery](workflow, target, item);
    } catch (err) {
      console.error(`${LOG} Weapon Mastery ${mastery}:`, err);
    }
    if (mastery === "cleave") break; // вторая атака — одна на ход
  }
}

export default {
  id: "weapon-mastery",
  kind: "rule",
  label: "Weapon Mastery",
  hint: "Свойства мастерства оружия 2024: Cleave, Graze, Push, Sap, Slow, Topple, Vex (Nick — вручную).",
  appliesTo: () => false, // данные не правим, только хуки

  register() {
    if (midiActive()) {
      Hooks.on("midi-qol.AttackRollComplete", (workflow) => runAsync("Weapon Mastery", () => onAttackRollComplete(workflow)));
    } else {
      // Родной путь dnd5e: тот же разбор, но данные берём из броска атаки
      Hooks.on("dnd5e.rollAttackV2", (rolls, { subject } = {}) => {
        if (!subject?.actor?.isOwner) return;
        runAsync("Weapon Mastery", () => onAttackRollComplete(attackWorkflow(subject, rolls)));
      });
    }

    // Sap: помеха на следующий бросок атаки задетого (без midi флаг midi не работает)
    onPreAttackRoll((config) => {
      const actor = config?.subject?.actor;
      const sapped = actor?.effects?.filter(e => e.active && e.getFlag(MODULE_ID, "sapped")) ?? [];
      if (!sapped.length) return;
      config.disadvantage = true;
      setTimeout(() => actor.deleteEmbeddedDocuments("ActiveEffect", sapped.map(e => e.id)), 0);
    });

    // Vex: преимущество на следующую атаку по цели, эффект расходуется
    onPreAttackRoll((config) => {
      const actor = config?.subject?.actor;
      const vexes = actor?.effects?.filter(e => e.active && e.getFlag(MODULE_ID, "vexTarget")) ?? [];
      if (!vexes.length) return;
      const targets = [...(config.workflow?.targets?.size ? config.workflow.targets : game.user.targets)];
      const used = vexes.filter(e => targets.some(t => t.actor?.uuid === e.getFlag(MODULE_ID, "vexTarget")));
      if (!used.length) return;
      config.advantage = true;
      setTimeout(() => actor.deleteEmbeddedDocuments("ActiveEffect", used.map(e => e.id)), 0);
    });

    // Cleave: урон второй атаки без положительного модификатора характеристики
    onPreDamageRoll((config) => {
      const item = config?.subject?.item;
      const actor = item?.actor;
      if (!actor || actor.getFlag(MODULE_ID, "cleaving") !== item.uuid) return;
      for (const roll of config.rolls ?? []) {
        if (typeof roll?.data?.mod === "number" && roll.data.mod > 0) roll.data.mod = 0;
      }
      setTimeout(() => actor.unsetFlag(MODULE_ID, "cleaving"), 0);
    });
  },
};
