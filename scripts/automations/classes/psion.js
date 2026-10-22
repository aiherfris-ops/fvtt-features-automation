import { LOG, MODULE_ID } from "../../core/constants.js";
import { onItemUse, onSpellWorkflowComplete, onWorkflowComplete } from "../../core/hooks.js";
import { applyEffects } from "../../core/midi.js";
import { chat, featById, isActiveGM, runAsync } from "../../core/utils.js";

/*
 * Псионик (Unearthed Arcana 2025, импорт Plutonium). Перенесено из отдельного модуля psion-automation.
 *
 * Кости психической энергии — единственная точка расхода (EnergyDice): кость не тратится, пока правила
 * не говорят, что она израсходована. После каждого броска костей предлагается Psionic Surge.
 * Умения: Telekinetic Propel, Telepathic Connection, Psionic Restoration, дисциплины
 * (Biofeedback, Destructive Thoughts, Inerrant Aim, Psionic Backlash) с правилом «одна дисциплина за ход».
 * Подкласс Metamorph — в subclasses/psion-metamorph.js, он пользуется EnergyDice и TurnState отсюда.
 */

const { DialogV2 } = foundry.applications.api;

export const isPsion = actor => !!actor?.items?.some(i => i.type === "class" && i.system?.identifier === "psion");

/** Старый отдельный модуль включён — не дублируем обработчики */
export const legacyModuleActive = () => !!game.modules.get("psion-automation")?.active;

/* -------------------------------------------- */
/*  Кости психической энергии                   */
/* -------------------------------------------- */

export class EnergyDice {
  static pool(actor) {
    return featById(actor, "psionic-energy-die");
  }

  static faces(actor) {
    return foundry.utils.getProperty(actor, "system.scale.psion.die")?.faces ?? 8;
  }

  /** Неизрасходованные кости */
  static available(actor) {
    const pool = this.pool(actor);
    if (!pool) return 0;
    const uses = pool.system.uses ?? {};
    if (Number.isFinite(uses.value)) return Math.max(0, uses.value);
    return Math.max(0, (Number(uses.max) || 0) - (uses.spent ?? 0));
  }

  static async spend(actor, n = 1) {
    const pool = this.pool(actor);
    if (!pool) {
      ui.notifications?.warn(`${actor.name}: нет умения Psionic Energy Die.`);
      return false;
    }
    if (this.available(actor) < n) {
      ui.notifications?.warn("Не хватает костей психической энергии.");
      return false;
    }
    await pool.update({ "system.uses.spent": (pool.system.uses.spent ?? 0) + n });
    return true;
  }

  static async restoreAll(actor) {
    const pool = this.pool(actor);
    if (pool && (pool.system.uses.spent ?? 0) > 0) await pool.update({ "system.uses.spent": 0 });
  }

  /** Класс с неизрасходованной костью хитов — для Psionic Surge */
  static hitDieClass(actor) {
    return actor.items.find(i => i.type === "class" && ((i.system.levels ?? 0) - (i.system.hd?.spent ?? 0)) > 0) ?? null;
  }

  /**
   * Бросить n костей. Кости НЕ тратит — это решает умение.
   * requireAvailable: отказать, если неизрасходованных костей меньше n (умение нельзя использовать с пустым запасом);
   * false — когда кости уже списаны родным расходом активности (Mutable Form, Psionic Backlash).
   */
  static async roll(actor, n, { flavor = "Кости психической энергии", offerSurge = true, requireAvailable = true } = {}) {
    if (requireAvailable && this.available(actor) < n) {
      ui.notifications?.warn("Все кости психической энергии израсходованы — умение нельзя использовать.");
      return null;
    }
    const roll = await new Roll(`${n}d${this.faces(actor)}`).evaluate();
    const rawResults = roll.dice[0].results.filter(r => r.active !== false).map(r => r.result);

    let surged = false;
    if (offerSurge && featById(actor, "psionic-surge") && rawResults.some(r => r <= 3)) {
      const cls = this.hitDieClass(actor);
      if (cls) {
        surged = await DialogV2.confirm({
          window: { title: "Psionic Surge" },
          content: `<p>Выпало на костях энергии: <b>${rawResults.join(", ")}</b>.</p>`
            + `<p>Потратить кость хитов (${cls.system.hd.denomination}), чтобы считать каждую 1–3 за 4?</p>`,
          rejectClose: false,
        }) === true;
        if (surged) await cls.update({ "system.hd.spent": (cls.system.hd.spent ?? 0) + 1 });
      }
    }

    const results = surged ? rawResults.map(r => Math.max(r, 4)) : rawResults;
    const total = results.reduce((a, b) => a + b, 0);
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: surged ? `${flavor} — Psionic Surge: ${rawResults.join(", ")} → ${results.join(", ")} (итого ${total})` : flavor,
    });
    return { roll, results, rawResults, total, surged };
  }
}

/* -------------------------------------------- */
/*  Состояние хода: одна дисциплина, Viscera    */
/* -------------------------------------------- */

export class TurnState {
  static #state = new Map(); // uuid актёра → { key, discipline, viscera }

  static #key() {
    const c = game.combat;
    return c?.started ? `${c.id}:${c.round}:${c.turn}` : null;
  }

  static #get(actor) {
    const key = this.#key();
    const cur = this.#state.get(actor.uuid);
    if (cur?.key === key) return cur;
    const fresh = { key, discipline: false, viscera: false };
    this.#state.set(actor.uuid, fresh);
    return fresh;
  }

  /** Одна дисциплина за ход (вне боя без ограничений) */
  static canUseDiscipline(actor) {
    return !this.#key() || !this.#get(actor).discipline;
  }

  static markDiscipline(actor) {
    this.#get(actor).discipline = true;
  }

  /** Viscera Launcher: доп. урон раз в свой ход */
  static canVisceraExtra(actor) {
    const c = game.combat;
    if (!c?.started) return true;
    if (c.combatant?.actor?.uuid !== actor.uuid) return false;
    return !this.#get(actor).viscera;
  }

  static markVisceraExtra(actor) {
    this.#get(actor).viscera = true;
  }
}

/* -------------------------------------------- */
/*  Общие помощники                             */
/* -------------------------------------------- */

export async function applyDamageSafe(target, value, type, label) {
  if (!target || !(value > 0)) return;
  if (target.isOwner) return target.applyDamage([{ value, type }]);
  await ChatMessage.create({
    content: `<p><b>${label}:</b> примените ${value} (${type}) к <b>${target.name}</b> — у игрока нет прав.</p>`,
    whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id),
  });
}

export async function createEffectsSafe(target, effects) {
  if (!target) return;
  if (target.isOwner) return target.createEmbeddedDocuments("ActiveEffect", effects);
  await applyEffects(target, effects);
}

async function pickCount(title, content, max) {
  if (max === 1) return (await DialogV2.confirm({ window: { title }, content, rejectClose: false })) === true ? 1 : 0;
  const choice = await DialogV2.wait({
    window: { title },
    content,
    buttons: [
      ...Array.from({ length: max }, (_, i) => ({ action: String(i + 1), label: `${i + 1}` })),
      { action: "0", label: "Нет" },
    ],
    rejectClose: false,
  });
  return Number(choice) || 0;
}

/* -------------------------------------------- */
/*  Умения класса                               */
/* -------------------------------------------- */

/** Telekinetic Propel: по результату спасброска — 5 футов бесплатно или 5 × кость (кость тратится) */
async function propel(workflow) {
  const actor = workflow.actor;
  const target = workflow.targets?.first?.() ?? null;
  if (!(workflow.failedSaves?.size > 0)) {
    await chat(actor, `<p><b>Telekinetic Propel:</b> ${target?.name ?? "цель"} прошла спасбросок — не сдвинута, кость не потрачена.</p>`);
    return;
  }
  const buttons = [{ action: "basic", label: "5 футов (без кости)", default: true }];
  if (EnergyDice.available(actor) >= 1) buttons.push({ action: "die", label: "Кость энергии: 5 × бросок (кость тратится)" });
  const choice = await DialogV2.wait({
    window: { title: "Telekinetic Propel" },
    content: `<p>${target?.name ?? "Цель"} <b>провалила</b> спасбросок Силы.</p>`,
    buttons,
    rejectClose: false,
  });
  if (!choice) return;
  let distance = 5;
  if (choice === "die") {
    const rolled = await EnergyDice.roll(actor, 1, { flavor: "Telekinetic Propel" });
    if (!rolled) return;
    await EnergyDice.spend(actor, 1);
    distance = 5 * rolled.total;
  }
  await chat(actor, `<p><b>Telekinetic Propel:</b> сдвиньте ${target?.name ?? "цель"} на <b>${distance} футов</b> `
    + `прямо к ${actor.name} или от него (токен двигается вручную).</p>`);
}

/** Telepathic Connection: первое использование после длинного отдыха не тратит кость */
async function telepathy(activity) {
  const actor = activity.item.actor;
  // Старый модуль psion-automation хранил отметку в своём флаге — учитываем и её
  const free = !actor.getFlag(MODULE_ID, "psionTelepathyFreeUsed") && !actor.flags?.psionAutomation?.tcFreeUsed;
  const rolled = await EnergyDice.roll(actor, 1, { flavor: "Telepathic Connection" });
  if (!rolled) return;
  if (free) await actor.setFlag(MODULE_ID, "psionTelepathyFreeUsed", true);
  else if (!await EnergyDice.spend(actor, 1)) return;

  const bonus = rolled.total * 10;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: `Telepathic Connection (+${bonus} футов)`,
    img: activity.item.img,
    origin: activity.item.uuid,
    duration: { value: 3600, units: "seconds" },
    description: `<p>Дальность телепатии ${30 + bonus} футов на 1 час.</p>`,
  }]);
  await chat(actor, `<p><b>Telepathic Connection:</b> телепатия на <b>${30 + bonus} футов</b> на 1 час`
    + `${free ? " (первое использование после отдыха — кость не потрачена)" : " (1 кость потрачена)"}.</p>`);
}

/* -------------------------------------------- */
/*  Дисциплины                                  */
/* -------------------------------------------- */

// Plutonium даёт дисциплины то как «Psionic Disciplines: X» (psionic-disciplines-x), то просто «X» (x)
const DISCIPLINES = ["biofeedback", "destructive-thoughts", "inerrant-aim", "psionic-backlash", "id-insinuation"];
const DISCIPLINE_IDS = DISCIPLINES.flatMap(name => [`psionic-disciplines-${name}`, name]);
const discipline = (actor, name) => featById(actor, `psionic-disciplines-${name}`) ?? featById(actor, name);

const isPsionSpell = item => String(item?.system?.sourceItem ?? item?._source?.system?.sourceItem ?? "").includes("psion");

/** Biofeedback и Destructive Thoughts — после сотворения заклинания псионика */
async function spellDisciplines(workflow, activity) {
  const actor = workflow.actor;
  const item = activity.item;
  if (!actor?.isOwner || !isPsionSpell(item) || !TurnState.canUseDiscipline(actor)) return;
  const int = actor.system.abilities?.int?.mod ?? 0;
  const maxDice = Math.min(int, EnergyDice.available(actor));
  if (maxDice < 1) return;
  const school = item.system.school;

  if (["nec", "trs"].includes(school) && discipline(actor, "biofeedback")) {
    const n = await pickCount("Biofeedback",
      `<p>Сотворено <b>${item.name}</b> (${school === "nec" ? "некромантия" : "преобразование"}). `
      + `Потратить кости энергии на временные хиты? (до ${maxDice})</p>`, maxDice);
    if (!n || !await EnergyDice.spend(actor, n)) return;
    TurnState.markDiscipline(actor);
    const rolled = await EnergyDice.roll(actor, n, { flavor: "Biofeedback", requireAvailable: false });
    if (!rolled) return;
    const thp = Math.max(1, rolled.total + int);
    const current = actor.system.attributes.hp.temp ?? 0;
    if (thp > current) await actor.update({ "system.attributes.hp.temp": thp });
    await chat(actor, `<p><b>Biofeedback:</b> ${thp} временных хитов${thp <= current ? " (оставлены прежние, их больше)" : ""}.</p>`);
    return;
  }

  if (["con", "evo"].includes(school) && discipline(actor, "destructive-thoughts")) {
    const forcesSave = (workflow.activity?.save?.ability?.size ?? workflow.activity?.save?.ability?.length ?? 0) > 0
      || (workflow.saves?.size ?? 0) > 0 || (workflow.failedSaves?.size ?? 0) > 0;
    const targets = [...(workflow.targets ?? [])].filter(t => t.actor);
    if (!forcesSave || !targets.length) return;
    const n = await pickCount("Destructive Thoughts",
      `<p>Сотворено <b>${item.name}</b> (${school === "con" ? "вызов" : "воплощение"}) со спасброском. `
      + `Потратить кости энергии на психический урон независимо от спасброска? (до ${maxDice})</p>`, maxDice);
    if (!n) return;

    let target = targets[0];
    if (targets.length > 1) {
      const pick = await DialogV2.wait({
        window: { title: "Destructive Thoughts" },
        content: "<p>Выберите цель:</p>",
        buttons: targets.map((t, i) => ({ action: String(i), label: t.name })),
        rejectClose: false,
      });
      if (pick === null || pick === undefined) return;
      target = targets[Number(pick)] ?? targets[0];
    }
    if (!await EnergyDice.spend(actor, n)) return;
    TurnState.markDiscipline(actor);
    const rolled = await EnergyDice.roll(actor, n, { flavor: "Destructive Thoughts", requireAvailable: false });
    if (!rolled) return;
    const damage = Math.max(1, rolled.total + int);
    await applyDamageSafe(target.actor, damage, "psychic", "Destructive Thoughts");
    await chat(actor, `<p><b>Destructive Thoughts:</b> ${target.name} получает <b>${damage} психического урона</b>.</p>`);
  }
}

/** Inerrant Aim: после промаха — кость к броску атаки; тратится, только если атака стала попаданием */
async function inerrantAim(workflow) {
  const actor = workflow?.actor;
  if (!actor?.isOwner || !discipline(actor, "inerrant-aim")) return;
  if (!workflow.attackRoll || workflow.aborted || !TurnState.canUseDiscipline(actor)) return;
  if (EnergyDice.available(actor) < 1) return;

  const ac = workflow.targets?.first?.()?.actor?.system?.attributes?.ac?.value;
  if (!Number.isFinite(ac)) return;
  const total = workflow.attackRoll.total;
  const d20 = workflow.attackRoll.dice?.[0]?.total;
  if (d20 === 1 || d20 === 20 || total >= ac || total + EnergyDice.faces(actor) < ac) return;

  const ok = await DialogV2.confirm({
    window: { title: "Inerrant Aim" },
    content: `<p>Промах (<b>${total}</b> против КД <b>${ac}</b>). Бросить кость энергии и добавить к атаке? `
      + "Кость тратится, только если атака попадёт.</p>",
    rejectClose: false,
  });
  if (ok !== true) return;
  TurnState.markDiscipline(actor);
  const rolled = await EnergyDice.roll(actor, 1, { flavor: "Inerrant Aim" });
  if (!rolled) return;

  if (total + rolled.total < ac) {
    await chat(actor, `<p><b>Inerrant Aim:</b> +${rolled.total} не хватает (${total + rolled.total} против КД ${ac}). Кость <b>не</b> потрачена.</p>`);
    return;
  }
  await EnergyDice.spend(actor, 1);
  const op = new foundry.dice.terms.OperatorTerm({ operator: "+" });
  const num = new foundry.dice.terms.NumericTerm({ number: rolled.total, options: { flavor: "Inerrant Aim" } });
  await op.evaluate();
  await num.evaluate();
  await workflow.setAttackRoll(Roll.fromTerms([...workflow.attackRoll.terms, op, num]));
  await chat(actor, `<p><b>Inerrant Aim:</b> +${rolled.total} — промах стал <b>попаданием</b> (${total + rolled.total} против КД ${ac}). Кость потрачена.</p>`);
}

/** Psionic Backlash: реакция на попадание — снижение урона и психический урон атакующему при проваленном спасброске */
async function backlash(workflow, activity) {
  const actor = workflow.actor;
  TurnState.markDiscipline(actor);
  const int = actor.system.abilities?.int?.mod ?? 0;
  const rolled = await EnergyDice.roll(actor, 1, { flavor: "Psionic Backlash", requireAvailable: false });
  if (!rolled) return;
  const reduction = Math.max(2, 2 * rolled.total + int);

  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: `Psionic Backlash (урон −${reduction})`,
    img: activity.item.img,
    origin: activity.item.uuid,
    duration: { value: 1, units: "rounds" },
    system: { changes: [
      { key: "flags.midi-qol.DR.all", type: "add", value: String(reduction), phase: "initial" },
    ] },
    flags: { dae: { specialDuration: ["isDamaged"] }, [MODULE_ID]: { backlashShield: true } },
  }]);

  const attacker = workflow.targets?.first?.() ?? null;
  if (attacker && workflow.failedSaves?.has?.(attacker)) {
    await actor.setFlag(MODULE_ID, "psionPendingBacklash", { reduction, attackerTokenUuid: attacker.document?.uuid ?? null, ts: Date.now() });
    await chat(actor, `<p><b>Psionic Backlash:</b> входящий урон −<b>${reduction}</b>; ${attacker.name} провалил спасбросок Мудрости и получит психический урон.</p>`);
  } else {
    await chat(actor, `<p><b>Psionic Backlash:</b> входящий урон −<b>${reduction}</b>`
      + `${attacker ? `; ${attacker.name} прошёл спасбросок Мудрости` : "; атакующий не выбран — спасбросок вручную"}.</p>`);
  }
}

async function backlashRetaliation(token, data) {
  const actor = token?.actor;
  const pending = actor?.getFlag(MODULE_ID, "psionPendingBacklash");
  if (!pending || !actor.isOwner) return;
  await actor.unsetFlag(MODULE_ID, "psionPendingBacklash");
  const raw = data?.damageItem?.rawDamage ?? data?.damageItem?.totalDamage ?? null;
  const reduced = Number.isFinite(raw) ? Math.min(pending.reduction, raw + pending.reduction) : pending.reduction;
  const attacker = pending.attackerTokenUuid ? fromUuidSync(pending.attackerTokenUuid)?.actor : null;
  if (!attacker) return;
  await applyDamageSafe(attacker, reduced, "psychic", "Psionic Backlash");
  await chat(actor, `<p><b>Psionic Backlash:</b> ${attacker.name} получает <b>${reduced} психического урона</b>.</p>`);
}

/* -------------------------------------------- */
/*  Миграция данных импорта                     */
/* -------------------------------------------- */

// Умения, которые тратят кость по условию — родной безусловный расход убираем, тратит модуль
const CONDITIONAL_COST = ["telekinetic-propel", "telepathic-connection", "flesh-weaver",
  ...["biofeedback", "destructive-thoughts", "inerrant-aim"].flatMap(name => [`psionic-disciplines-${name}`, name])];

async function migratePsion(actor) {
  // Без разовой отметки: Plutonium дописывает расход уже после создания предметов,
  // поэтому проверка повторяется при каждом прогоне — все правки ниже идемпотентны
  const pool = EnergyDice.pool(actor);
  if (!pool) return;
  const updates = [];

  // Короткий отдых возвращает одну кость
  const recovery = foundry.utils.deepClone(pool._source.system?.uses?.recovery ?? []);
  if (!recovery.some(r => r.period === "sr")) {
    recovery.push({ period: "sr", type: "formula", formula: "1" });
    updates.push({ _id: pool.id, "system.uses.recovery": recovery });
  }

  // У Psionic Power лишние 1/короткий отдых дублировали восстановление запаса
  const power = featById(actor, "psionic-power");
  if (power?._source.system?.uses?.max === "1") {
    updates.push({ _id: power.id, "system.uses.max": "", "system.uses.recovery": [], "system.uses.spent": 0 });
  }

  for (const identifier of CONDITIONAL_COST) {
    const item = featById(actor, identifier);
    if (!item) continue;
    const update = { _id: item.id };
    for (const [id, activity] of Object.entries(item._source.system?.activities ?? {})) {
      const targets = activity?.consumption?.targets ?? [];
      const kept = targets.filter(t => !(t.type === "itemUses" && t.target === pool.id));
      if (kept.length !== targets.length) update[`system.activities.${id}.consumption.targets`] = kept;
    }
    if (Object.keys(update).length > 1) updates.push(update);
  }

  if (!updates.length) return;
  await actor.updateEmbeddedDocuments("Item", updates);
  console.log(`${LOG} Psion у ${actor.name}: данные костей энергии исправлены (${updates.length})`);
}

export default {
  id: "psion",
  kind: "class",
  label: "Псионик (UA 2025)",
  hint: "Кости энергии и Psionic Surge, Telekinetic Propel, Telepathic Connection, Psionic Restoration, "
    + "дисциплины (одна за ход): Biofeedback, Destructive Thoughts, Inerrant Aim, Psionic Backlash.",
  identifiers: ["psionic-energy-die"],
  appliesTo: isPsion,

  migrate: migratePsion,

  register() {
    if (legacyModuleActive()) {
      console.warn(`${LOG} включён старый модуль psion-automation — автоматизация псионика здесь отключена, чтобы не дублировать`);
      return;
    }

    onWorkflowComplete("telekinetic-propel", (workflow) => propel(workflow));
    onItemUse("telepathic-connection", (activity) => runAsync("Telepathic Connection", () => telepathy(activity)));
    onItemUse("psionic-restoration", (activity) => runAsync("Psionic Restoration", async () => {
      await EnergyDice.restoreAll(activity.item.actor);
      await chat(activity.item.actor, "<p><b>Psionic Restoration:</b> после минуты медитации все кости энергии восстановлены.</p>");
    }));
    onSpellWorkflowComplete(spellDisciplines);
    for (const id of ["psionic-disciplines-psionic-backlash", "psionic-backlash"]) onWorkflowComplete(id, backlash);
    // Id Insinuation модуль не автоматизирует, но она тоже занимает дисциплину хода
    for (const id of ["psionic-disciplines-id-insinuation", "id-insinuation"]) {
      onItemUse(id, (activity) => TurnState.markDiscipline(activity.item.actor));
    }

    // Нельзя использовать без костей; не больше одной дисциплины за ход
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
      const identifier = activity?.item?.system?.identifier;
      const actor = activity?.item?.actor;
      if (!actor) return;
      // Кость по условию тратит модуль: родной расход из запаса снимаем, даже если миграция ещё не дошла
      if (CONDITIONAL_COST.includes(identifier) && Array.isArray(usageConfig?.consume?.resources)) {
        const poolId = EnergyDice.pool(actor)?.id;
        const targets = activity.consumption?.targets ?? [];
        usageConfig.consume.resources = usageConfig.consume.resources
          .filter(i => !(targets[i]?.type === "itemUses" && targets[i]?.target === poolId));
      }
      if (identifier === "telepathic-connection" && EnergyDice.available(actor) < 1) {
        ui.notifications?.warn("Telepathic Connection: все кости энергии израсходованы.");
        return false;
      }
      if (DISCIPLINE_IDS.includes(identifier) && !TurnState.canUseDiscipline(actor)) {
        ui.notifications?.warn("За ход можно использовать только одну дисциплину.");
        return false;
      }
    });

    Hooks.on("midi-qol.preAttackRollComplete", (workflow) => inerrantAim(workflow)
      .catch(err => console.error(`${LOG} Inerrant Aim:`, err)));
    Hooks.on("midi-qol.isDamaged", (token, data) => backlashRetaliation(token, data)
      .catch(err => console.error(`${LOG} Psionic Backlash:`, err)));

    // Длинный отдых возвращает бесплатное использование Telepathic Connection
    Hooks.on("dnd5e.restCompleted", (actor, result, config) => {
      const long = config?.type === "long" || !!result?.longRest;
      if (!long || !actor.isOwner || !actor.getFlag(MODULE_ID, "psionTelepathyFreeUsed")) return;
      actor.unsetFlag(MODULE_ID, "psionTelepathyFreeUsed");
    });

    // Прерванный Backlash не должен висеть на актёре
    Hooks.on("combatTurnChange", (combat) => {
      if (!isActiveGM()) return;
      for (const combatant of combat.combatants) {
        const pending = combatant.actor?.getFlag(MODULE_ID, "psionPendingBacklash");
        if (pending && Date.now() - (pending.ts ?? 0) > 120000) combatant.actor.unsetFlag(MODULE_ID, "psionPendingBacklash");
      }
    });
  },
};
