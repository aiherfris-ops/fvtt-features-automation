import { LOG, MODULE_ID } from "./constants.js";

/*
 * Работа без midi-qol: то, что раньше давал его рабочий процесс, собирается из родных хуков dnd5e.
 *
 * 1. Память об атаке. `dnd5e.rollAttackV2` даёт броски атаки: из них видно преимущество, помеху,
 *    критическое попадание, СЛ защиты цели и, значит, попал ли удар. Это запоминается для активности
 *    и используется на шаге урона (бонусы урона, мастерство оружия).
 * 2. Эффекты на чужих актёрах. Раньше их создавал midi от имени ГМа; теперь это запрос `CONFIG.queries`.
 * 3. Перехват броска урона. Хуки dnd5e синхронные, а окно выбора бонусов асинхронное, поэтому
 *    оборачивается сам метод `rollDamage` активностей: до броска можно спросить игрока и дописать кости.
 */

export const midiActive = () => !!game.modules.get("midi-qol")?.active;

/* Память об атаке */

const attacks = new Map();
const MEMORY_MS = 5 * 60 * 1000;

const key = activity => activity?.uuid ?? `${activity?.actor?.uuid}:${activity?.id}`;

function rememberAttack(activity, rolls) {
  const roll = rolls?.[0];
  if (!activity || !roll) return;
  const ac = roll.options?.target ?? null;
  const targets = [...game.user.targets];
  const info = {
    at: Date.now(),
    advantage: !!roll.hasAdvantage,
    disadvantage: !!roll.hasDisadvantage,
    isCritical: !!roll.isCritical,
    isFumble: !!roll.isFumble,
    total: roll.total,
    ac,
    // Попадание известно, только если Foundry знала СЛ защиты цели
    hit: ac === null ? null : roll.isCritical || (!roll.isFumble && roll.total >= ac),
    targets,
  };
  attacks.set(key(activity), info);
  return info;
}

/** Что известно о последней атаке этой активности */
export function lastAttack(activity) {
  const info = attacks.get(key(activity));
  if (!info) return null;
  if (Date.now() - info.at > MEMORY_MS) {
    attacks.delete(key(activity));
    return null;
  }
  return info;
}

/** Цель атаки: та, по которой попали, иначе выбранная игроком */
export function attackTarget(activity) {
  const info = lastAttack(activity);
  return info?.targets?.[0] ?? [...game.user.targets][0] ?? null;
}

/**
 * Подобие рабочего процесса midi для поставщиков бонусов и правил оружия.
 * Поля те же, что использовались раньше: activity, item, token, targets, hitTargets, isCritical, advantage.
 */
export function nativeWorkflow(activity, config = {}) {
  const actor = activity.actor;
  const info = lastAttack(activity);
  const tokens = info?.targets?.length ? info.targets : [...game.user.targets];
  const list = {
    size: tokens.length,
    first: () => tokens[0] ?? null,
    [Symbol.iterator]: () => tokens[Symbol.iterator](),
  };
  return {
    macroPass: "DamageBonus",
    native: true,
    actor,
    item: activity.item,
    activity,
    token: actor?.getActiveTokens?.()[0] ?? null,
    targets: list,
    // Без сведений о СЛ защиты попадание неизвестно — считаем, что удар прошёл, решает игрок
    hitTargets: info?.hit === false ? { size: 0, first: () => null, [Symbol.iterator]: () => [][Symbol.iterator]() } : list,
    attackMode: config.attackMode ?? activity.item?.system?.attackMode,
    isCritical: !!(config.isCritical ?? info?.isCritical),
    advantage: !!info?.advantage,
    disadvantage: !!info?.disadvantage,
    damageRolls: config.rolls,
    attack: info,
  };
}

/* Перехват броска урона */

const patched = new Set();

/**
 * Обернуть `rollDamage` у всех классов активностей: перед броском вызывается `before(activity, config)`,
 * который может дописать `config.rolls` (например, кости скрытой атаки).
 */
export function patchRollDamage(before) {
  const classes = new Set(Object.values(CONFIG.DND5E.activityTypes ?? {}).map(t => t?.documentClass).filter(Boolean));
  let count = 0;
  for (const cls of classes) {
    // Метод объявлен в общем примеси, поэтому оборачиваем объект, которому он принадлежит, один раз
    let proto = cls.prototype;
    while (proto && !Object.hasOwn(proto, "rollDamage")) proto = Object.getPrototypeOf(proto);
    if (!proto || patched.has(proto)) continue;
    patched.add(proto);
    const original = proto.rollDamage;
    proto.rollDamage = async function (config = {}, dialog = {}, message = {}) {
      try { await before(this, config); }
      catch (err) { console.error(`${LOG} подготовка урона:`, err); }
      return original.call(this, config, dialog, message);
    };
    count++;
  }
  console.log(`${LOG} перехват броска урона: ${count}`);
}

/* Эффекты на чужих актёрах */

const EFFECTS_QUERY = `${MODULE_ID}.createEffects`;

/** ГМ создаёт эффекты на актёре по запросу игрока */
export function installEffectsQuery() {
  CONFIG.queries[EFFECTS_QUERY] = async ({ actorUuid, effects }) => {
    const actor = await fromUuid(actorUuid);
    if (!actor) return false;
    await actor.createEmbeddedDocuments("ActiveEffect", effects);
    return true;
  };
}

/** Наложить эффекты: напрямую, если есть права, иначе через midi или активного ГМа */
export async function applyEffects(actor, effects) {
  if (!actor || !effects?.length) return;
  if (actor.isOwner) return actor.createEmbeddedDocuments("ActiveEffect", effects);
  if (midiActive() && globalThis.MidiQOL?.createEffects) {
    return globalThis.MidiQOL.createEffects({ actorUuid: actor.uuid, effects, options: {} });
  }
  const gm = game.users.activeGM;
  if (!gm) {
    ui.notifications.warn("Эффект на чужом персонаже может наложить только ГМ — сейчас его нет в сети.");
    return;
  }
  return gm.query(EFFECTS_QUERY, { actorUuid: actor.uuid, effects }, { timeout: 10_000 });
}

/* Броски атаки */

/** Подобие рабочего процесса для правил, которым нужен результат броска атаки */
export function attackWorkflow(activity, rolls) {
  const roll = rolls?.[0];
  const workflow = nativeWorkflow(activity, {});
  return Object.assign(workflow, {
    attackRoll: roll,
    attackTotal: roll?.total,
    isCritical: !!roll?.isCritical,
    isFumble: !!roll?.isFumble,
  });
}

/* Спасброски без midi */

const escapeHtml = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * Спросить, кто из целей провалил спасбросок: dnd5e сам их не бросает, поэтому результат отмечает игрок.
 * Заполняет `workflow.failedSaves` и `workflow.saves` (множества токенов), как это делал midi.
 */
export async function askFailedSaves(workflow, { title = "Спасбросок", ability, dc } = {}) {
  const targets = [...(workflow.targets ?? [])].filter(t => t.actor);
  workflow.saves = new Set();
  workflow.failedSaves = new Set();
  if (!targets.length) return workflow;

  const label = ability ? (CONFIG.DND5E.abilities[ability]?.label ?? ability) : "спасбросок";
  const rows = targets.map((t, i) => `<label style="display:flex;align-items:center;gap:.5em;margin:.2em 0">`
    + `<input type="checkbox" name="failed-${i}" checked> ${escapeHtml(t.name)}</label>`).join("");
  const picked = await foundry.applications.api.DialogV2.prompt({
    window: { title },
    content: `<p>Кто <b>провалил</b> ${escapeHtml(label)}${dc ? ` (СЛ ${dc})` : ""}?</p>${rows}`,
    ok: {
      label: "Готово",
      callback: (event, button) => targets.filter((t, i) => button.form.elements[`failed-${i}`]?.checked),
    },
    rejectClose: false,
  });
  const failed = picked ?? [];
  for (const token of targets) (failed.includes(token) ? workflow.failedSaves : workflow.saves).add(token);
  return workflow;
}

/* Снижение урона и реакция на урон */

const DR_FLAG = `flags.${MODULE_ID}.damageReduction`;

/** Сумма снижения урона от эффектов модуля (замена флага midi DR.all) */
function damageReductionOf(actor) {
  return Number(foundry.utils.getProperty(actor, DR_FLAG)) || 0;
}

/** Ключ изменения для эффектов: `flags.<модуль>.damageReduction` */
export const damageReductionKey = DR_FLAG;

/**
 * Снижение урона перед применением: dnd5e даёт хук расчёта урона, из него и вычитаем.
 * Работает и с midi (у него свой DR), поэтому включается только без midi.
 */
export function installDamageReduction() {
  Hooks.on("dnd5e.calculateDamage", (actor, damages) => {
    let left = damageReductionOf(actor);
    if (left <= 0 || !damages?.length) return;
    for (const damage of damages) {
      if (left <= 0) break;
      const cut = Math.min(left, Math.max(0, damage.value));
      damage.value -= cut;
      left -= cut;
    }
  });
}

/** Актёр получил урон (замена midi-qol.isDamaged): handler(actor, amount, options) */
export function onDamaged(handler) {
  Hooks.on("dnd5e.applyDamage", (actor, amount, options) => {
    if (!(amount > 0)) return;
    Promise.resolve().then(() => handler(actor, amount, options))
      .catch(err => console.error(`${LOG} обработка полученного урона:`, err));
  });
}

/** Запомнить бросок атаки (вызывается из регистрации хуков) */
export function installAttackMemory() {
  Hooks.on("dnd5e.rollAttackV2", (rolls, { subject } = {}) => rememberAttack(subject, rolls));
}
