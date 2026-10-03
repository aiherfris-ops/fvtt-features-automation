import { LOG, MODULE_ID } from "../core/constants.js";
import { isActiveGM } from "../core/utils.js";
import { HOLY_SYMBOL_NAME, createHolySymbol } from "./holy-symbol.mjs";

/*
 * Предметы модуля появляются в мире сами: при первой загрузке активный ГМ заводит их
 * в папке «Предметы автоматизации» на вкладке предметов.
 *
 * Каждый предмет создаётся один раз за всю жизнь мира: список уже созданных хранится
 * в настройке `seeded-items`. Удалили предмет — модуль не станет подсовывать его заново.
 */

export const FOLDER_NAME = "Предметы автоматизации";

/** Что модуль умеет создавать */
export const MODULE_ITEMS = [
  { key: "holy-symbol", name: HOLY_SYMBOL_NAME, create: createHolySymbol },
];

async function folder() {
  const existing = game.folders.find(f => f.type === "Item" && f.name === FOLDER_NAME);
  if (existing) return existing;
  return Folder.create({ name: FOLDER_NAME, type: "Item", color: "#5b3a8c" });
}

const seededList = () => {
  try { return game.settings.get(MODULE_ID, "seeded-items") ?? []; } catch (err) { return []; }
};

/**
 * Завести недостающие предметы модуля в мире.
 * @param {object} [options]
 * @param {boolean} [options.force]  Создать заново даже то, что уже заводили
 * @returns {Promise<string[]>} названия созданных
 */
export async function ensureWorldItems({ force = false } = {}) {
  if (!isActiveGM()) return [];
  const seeded = new Set(force ? [] : seededList());
  const made = [];
  let folderId = null;

  for (const entry of MODULE_ITEMS) {
    if (seeded.has(entry.key)) continue;
    if (game.items.getName(entry.name)) { seeded.add(entry.key); continue; }
    folderId ??= (await folder())?.id ?? null;
    const item = await entry.create({ folder: folderId, quiet: true });
    if (!item) continue;
    made.push(item.name);
    seeded.add(entry.key);
  }

  if (made.length) {
    await game.settings.set(MODULE_ID, "seeded-items", [...seeded]);
    ui.notifications.info(`Предметы модуля добавлены в «${FOLDER_NAME}»: ${made.join(", ")}.`);
    console.log(`${LOG} созданы предметы: ${made.join(", ")}`);
  } else if (seeded.size !== seededList().length) {
    await game.settings.set(MODULE_ID, "seeded-items", [...seeded]);
  }
  return made;
}

export { createHolySymbol, HOLY_SYMBOL_NAME };
