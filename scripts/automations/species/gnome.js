import { LOG } from "../../core/constants.js";
import { change, featById } from "../../core/utils.js";

/* Вид — Gnome (PHB 2024): Gnomish Cunning — преимущество на спасброски Интеллекта, Мудрости и Харизмы */

const IDS = { cunning: "faGnomishCunning" };

export default {
  id: "gnome",
  kind: "species",
  label: "Gnome",
  hint: "Gnomish Cunning: преимущество на спасброски Инт, Мдр, Хар (в импорте эффекта не было).",
  identifiers: ["gnomish-cunning"],

  async migrate(actor) {
    const cunning = featById(actor, "gnomish-cunning");
    if (!cunning || cunning.effects.has(IDS.cunning)) return;
    await cunning.createEmbeddedDocuments("ActiveEffect", [{
      _id: IDS.cunning,
      name: "Gnomish Cunning",
      img: cunning.img,
      transfer: true,
      system: { changes: ["int", "wis", "cha"].map(a => change(`system.abilities.${a}.save.roll.mode`, "add", 1)) },
    }], { keepId: true });
    console.log(`${LOG} Gnomish Cunning у ${actor.name}: преимущество на спасброски Инт/Мдр/Хар`);
  },
};
