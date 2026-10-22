import { MODULE_ID } from "./constants.js";

/*
 * Ветка под midi-qol. Всё, что в универсальной версии приходилось собирать из родных хуков dnd5e
 * (память о броске атаки, подобие рабочего процесса, опрос проваленных спасбросков, своё снижение
 * урона, перехват rollDamage), здесь делает сам midi: цели, попадания, спасброски и урон берутся
 * из его workflow, снижение урона — из `flags.midi-qol.DR.all`.
 *
 * Отсюда остались только тонкие обёртки над API midi и геометрия, которая от него не зависит.
 */

/** Запрос к ГМу: сдвинуть чужой токен (у midi своего такого вызова нет) */
const MOVE_QUERY = `${MODULE_ID}.moveToken`;

export function installQueries() {
  CONFIG.queries[MOVE_QUERY] = async ({ tokenUuid, x, y }) => {
    const token = await fromUuid(tokenUuid);
    await token?.update({ x, y }, { animate: true });
    return true;
  };
}

/** Наложить эффекты: напрямую, если есть права, иначе руками midi — он сам сходит к ГМу */
export async function applyEffects(actor, effects) {
  if (!actor || !effects?.length) return;
  if (actor.isOwner) return actor.createEmbeddedDocuments("ActiveEffect", effects);
  return globalThis.MidiQOL.createEffects({ actorUuid: actor.uuid, effects, options: {} });
}

/** Снять эффекты по идентификаторам */
export async function removeEffects(actor, ids) {
  if (!actor || !ids?.length) return;
  if (actor.isOwner) return actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  return globalThis.MidiQOL.removeEffects({ actorUuid: actor.uuid, effects: ids });
}

/** Существо не может действовать */
export function isIncapacitated(actor) {
  if (!actor) return true;
  if ((actor.system?.attributes?.hp?.value ?? 1) <= 0) return true;
  return !!globalThis.MidiQOL.checkIncapacitated(actor);
}

/** Расстояние между токенами в футах по сетке сцены */
export function distanceBetween(a, b) {
  if (!a || !b) return Infinity;
  const path = canvas?.grid?.measurePath?.([a.center ?? a, b.center ?? b]);
  if (path?.distance !== undefined) return path.distance;
  const dx = (a.center?.x ?? 0) - (b.center?.x ?? 0);
  const dy = (a.center?.y ?? 0) - (b.center?.y ?? 0);
  const size = canvas?.dimensions?.distance ?? 5;
  return (Math.hypot(dx, dy) / (canvas?.dimensions?.size ?? 100)) * size;
}

/**
 * Токены в пределах `distance` футов от токена.
 * @param {number|null} disposition  1 — только союзники цели, -1 — только её противники, null — все
 */
export function nearbyTokens(token, distance, { disposition = null, includeIncapacitated = false, includeSelf = false } = {}) {
  if (!token || !canvas?.tokens) return [];
  return canvas.tokens.placeables.filter(other => {
    if (!other.actor || (!includeSelf && other === token)) return false;
    if (other.document.hidden) return false;
    if (!includeIncapacitated && isIncapacitated(other.actor)) return false;
    if (disposition !== null) {
      const same = other.document.disposition === token.document.disposition;
      if (disposition > 0 ? !same : same) return false;
    }
    return distanceBetween(token, other) <= distance;
  });
}

/** Оттолкнуть токен от точки на `distance` футов */
export async function pushTokenAway(token, distance, from) {
  if (!token || !from) return;
  const size = canvas?.dimensions?.size ?? 100;
  const per = canvas?.dimensions?.distance ?? 5;
  const dx = token.center.x - from.x;
  const dy = token.center.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const shift = (distance / per) * size;
  const x = Math.round(token.document.x + (dx / length) * shift);
  const y = Math.round(token.document.y + (dy / length) * shift);
  if (token.document.isOwner) return token.document.update({ x, y }, { animate: true });
  const gm = game.users.activeGM;
  return gm?.query(MOVE_QUERY, { tokenUuid: token.document.uuid, x, y }, { timeout: 10_000 });
}
