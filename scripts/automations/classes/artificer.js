import { LOG } from "../../core/constants.js";
import { isLongRest, removeTemporaryItems, temporaryFlags } from "../../core/temporary-items.js";
import { chat, featById, runAsync } from "../../core/utils.js";
import { onItemUse } from "../../core/hooks.js";

/*
 * Изобретатель (Eberron: Forge of the Artificer, 2025).
 * Tinker's Magic: выбор предмета из списка — предмет из компендиума появляется у изобретателя
 * и исчезает после его длинного отдыха.
 */

const TINKER_ITEMS = [
  "Ball Bearings", "Basket", "Bedroll", "Bell", "Blanket", "Block and Tackle", "Glass Bottle", "Bucket",
  "Caltrops", "Candle", "Crowbar", "Flask", "Grappling Hook", "Hunting Trap", "Jug", "Lamp", "Manacles",
  "Net", "Oil", "Paper", "Parchment", "Pole", "Pouch", "Rope", "Sack", "Shovel", "Iron Spikes", "String",
  "Tinderbox", "Torch", "Vial",
];
const PACKS = ["dnd5e.equipment24", "dnd5e.items"];

const normalize = s => s.toLowerCase().replace(/[^a-z]/g, "");

/** Предмет из компендиума по названию (учитывая варианты вида «Bottle, Glass» и «Spikes, Iron») */
async function findItemData(name) {
  const wanted = normalize(name);
  const reversed = normalize(name.split(" ").reverse().join(" "));
  for (const packId of PACKS) {
    const pack = game.packs.get(packId);
    if (!pack) continue;
    const index = await pack.getIndex();
    const entry = index.find(e => [wanted, reversed].includes(normalize(e.name)));
    if (entry) return (await pack.getDocument(entry._id))?.toObject();
  }
  return null;
}

async function tinkersMagic(activity) {
  const feature = activity.item;
  const actor = feature.actor;
  const name = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Tinker's Magic" },
    content: "<p>Какой предмет создать? Он исчезнет после вашего длинного отдыха.</p>"
      + `<select name="item">${TINKER_ITEMS.map(n => `<option value="${n}">${n}</option>`).join("")}</select>`,
    ok: { label: "Создать", callback: (event, button) => button.form.elements.item.value },
    rejectClose: false,
  });
  if (!name) {
    // Отмена — возвращаем потраченный заряд
    const spent = feature.system.uses?.spent ?? 0;
    if (spent > 0) await feature.update({ "system.uses.spent": spent - 1 });
    return;
  }

  const data = (await findItemData(name)) ?? { name, type: "loot", img: feature.img };
  delete data._id;
  data.name = `${data.name} (Tinker's Magic)`;
  data.flags = foundry.utils.mergeObject(data.flags ?? {}, temporaryFlags(actor, "tinker"));
  await actor.createEmbeddedDocuments("Item", [data]);
  await chat(actor, `<p><strong>${actor.name}</strong> мастерит «${name}». Предмет исчезнет после длинного отдыха.</p>`);
}

export default {
  id: "artificer",
  kind: "class",
  label: "Изобретатель",
  hint: "Tinker's Magic: выбор предмета из списка, предмет исчезает после длинного отдыха.",
  identifiers: ["tinkers-magic"],

  register() {
    onItemUse("tinkers-magic", (activity) => runAsync("Tinker's Magic", () => tinkersMagic(activity)));

    Hooks.on("dnd5e.restCompleted", (actor, result, config) => {
      if (!isLongRest(result, config) || !featById(actor, "tinkers-magic")) return;
      runAsync("Tinker's Magic: отдых", async () => {
        const removed = await removeTemporaryItems(actor, "tinker");
        if (removed) console.log(`${LOG} ${actor.name}: исчезло предметов Tinker's Magic: ${removed}`);
      });
    });
  },
};
