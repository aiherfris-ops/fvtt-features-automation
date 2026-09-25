import { LOG, MODULE_ID } from "./constants.js";

/*
 * Временные предметы, созданные умениями (Tinker's Magic, Experimental Elixir):
 * помечаются создателем и видом и исчезают, когда создатель заканчивает длинный отдых.
 * Удаляются у всех актёров, которых текущий пользователь может редактировать (переданные союзникам — тоже).
 */

export const temporaryFlags = (creator, kind) => ({ [MODULE_ID]: { temporary: { creator: creator.uuid, kind } } });

const isTemporaryOf = (item, creator, kind) => {
  const data = item.getFlag(MODULE_ID, "temporary");
  return data?.creator === creator.uuid && data.kind === kind;
};

export async function removeTemporaryItems(creator, kind) {
  let removed = 0;
  let skipped = 0;
  for (const actor of game.actors) {
    const items = actor.items.filter(i => isTemporaryOf(i, creator, kind));
    if (!items.length) continue;
    if (!actor.isOwner) { skipped += items.length; continue; }
    await actor.deleteEmbeddedDocuments("Item", items.map(i => i.id));
    removed += items.length;
  }
  if (skipped) console.warn(`${LOG} ${kind}: ${skipped} предмет(ов) у чужих персонажей не удалены — нет прав`);
  return removed;
}

export const isLongRest = (result, config) => config?.type === "long" || !!result?.longRest;
