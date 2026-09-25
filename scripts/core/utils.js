import { LOG, MIGRATION_VERSION, MODULE_ID } from "./constants.js";

/** Причина отказа — в консоль всегда, в чат шёпотом при включённой отладке */
export const debugNote = (actor, message) => {
  console.log(`${LOG} ${message}`);
  try {
    if (!game.settings.get(MODULE_ID, "debug-chat")) return;
    ChatMessage.create({
      content: `<p><em>[FA] ${message}</em></p>`,
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: game.users.filter(u => u.isGM || u.isSelf).map(u => u.id),
    });
  } catch (err) { /* чат недоступен — не мешаем броску */ }
};

/**
 * Включена ли автоматизация. Настройки требуют перезагрузки мира, поэтому значение
 * читается из настроек один раз и дальше берётся из кэша (вызывается в каждом броске).
 */
const enabledCache = new Map();
export const isEnabled = id => {
  if (enabledCache.has(id)) return enabledCache.get(id);
  let value = true;
  try { value = game.settings.get(MODULE_ID, `enabled-${id}`) !== false; }
  catch (err) { return true; } // настройки ещё не зарегистрированы — не кэшируем
  enabledCache.set(id, value);
  return value;
};

export const isActiveGM = () => !!game.users.activeGM?.isSelf;

export const featById = (actor, identifier) => actor?.itemTypes?.feat?.find(f => f.system.identifier === identifier);

export const hasItem = (actor, identifier) => !!actor?.items?.some(i => i.system.identifier === identifier);

/** Изменение Active Effect в формате Foundry v14 */
export const change = (key, type, value) => ({ key, type, value, phase: "initial" });

export const migrated = (doc, key) => (doc.getFlag(MODULE_ID, key) ?? 0) >= MIGRATION_VERSION;

export const turnKey = () => (game.combat ? `${game.combat.id}:${game.combat.round}:${game.combat.turn}` : null);

export const damageTypeLabel = type => CONFIG.DND5E.damageTypes[type]?.label ?? type;

export const getRemainingUses = (feature) => {
  const uses = feature.system.uses ?? {};
  const max = Number(uses.max) || 0;
  const remaining = Number(uses.value ?? (max - (uses.spent ?? 0))) || 0;
  return { max, remaining, spent: uses.spent ?? 0 };
};

export const chat = (actor, content) => ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });

/** Запустить асинхронную работу из синхронного хука, не теряя ошибки */
export const runAsync = (label, task) => {
  Promise.resolve().then(task).catch(err => console.error(`${LOG} ${label}:`, err));
};
