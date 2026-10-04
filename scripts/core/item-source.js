import { LOG } from "./constants.js";

/*
 * Откуда брать предмет по названию.
 *
 * Сначала спрашиваем модуль tables-5e: он берёт предмет прямо из данных 5etools силами Плютониума,
 * поэтому находится всё, что вообще есть в книгах, а не только импортированное в компендиумы.
 * Если его нет — ищем по компендиумам предметов: сперва по точному названию, потом по
 * перевёрнутому («Bottle, Glass» против «Glass Bottle») и по названию без плюсов и запятых.
 */

const normalize = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const variants = (name) => {
  const plain = String(name ?? "");
  const noPlus = plain.replace(/\s*\+\d\s*/g, " ").trim();
  const words = plain.split(/[\s,]+/).filter(Boolean);
  return [...new Set([plain, noPlus, words.slice().reverse().join(" "), `${noPlus} ${plain.match(/\+\d/)?.[0] ?? ""}`]
    .map(normalize).filter(Boolean))];
};

/** Компендиумы предметов: сначала мир, потом система и модули */
const itemPacks = () => game.packs.filter(pack => pack.documentName === "Item")
  .sort((a, b) => (a.metadata.packageType === "world" ? -1 : 0) - (b.metadata.packageType === "world" ? -1 : 0));

/** Данные предмета из компендиума или null */
export async function findItemData(name) {
  const wanted = variants(name);
  for (const pack of itemPacks()) {
    let index;
    try { index = await pack.getIndex(); }
    catch (err) { continue; }
    const entry = index.find(e => wanted.includes(normalize(e.name)));
    if (!entry) continue;
    const doc = await pack.getDocument(entry._id);
    if (doc) return doc.toObject();
  }
  return null;
}

/**
 * Создать предмет у актёра: через Плютониум (tables-5e), иначе из компендиума.
 * @param {Actor} actor
 * @param {{name: string, source?: string, label?: string}} ref
 * @param {{flags?: object, updates?: object}} [options]
 * @returns {Promise<{item: Item|null, how: string, reason?: string}>}
 */
export async function createItemFor(actor, ref, { flags = {}, updates = {} } = {}) {
  const bridge = globalThis.game?.tables5e;
  if (bridge?.importRef && bridge.isReady?.()) {
    const result = await bridge.importRef({
      tag: "item", name: ref.name, source: ref.source, label: ref.label ?? ref.name, count: 1,
    }, { actor });
    const item = result.docs?.[0];
    if (item) {
      await item.update({ ...updates, flags: foundry.utils.mergeObject(item.toObject().flags ?? {}, flags) });
      return { item, how: "плютониум" };
    }
    console.warn(`${LOG} «${ref.name}»: Плютониум не дал предмет (${result.reason}), ищем в компендиумах`);
  }

  const data = await findItemData(ref.name);
  if (!data) return { item: null, how: "нет", reason: `«${ref.name}» не нашёлся ни в данных, ни в компендиумах` };
  delete data._id;
  foundry.utils.mergeObject(data, updates);
  data.flags = foundry.utils.mergeObject(data.flags ?? {}, flags);
  const [item] = await actor.createEmbeddedDocuments("Item", [data]);
  return { item, how: "компендиум" };
}
