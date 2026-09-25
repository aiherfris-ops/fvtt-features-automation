import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { featById, migrated } from "../../core/utils.js";
import { onPreDamageRoll } from "../../core/hooks.js";

/*
 * Черта Fighting Style: Dueling (PHB 2024): +2 к урону рукопашным оружием в одной руке.
 * Импорт давал +2 ко всем рукопашным атакам оружием, включая двуручный меч — эффект выключаем,
 * бонус добавляет хук броска урона только для одноручного хвата.
 * «Нет другого оружия в руках» проверить нельзя: экипированное оружие не значит «в руке».
 */

const hasDueling = actor => !!featById(actor, "fighting-style-dueling");

export default {
  id: "fighting-style-dueling",
  kind: "feat",
  label: "Fighting Style: Dueling",
  hint: "+2 к урону только при атаке рукопашным оружием одной рукой (не двуручным, не двуручным хватом, не метанием).",
  identifiers: ["fighting-style-dueling"],

  async migrate(actor) {
    const feat = featById(actor, "fighting-style-dueling");
    if (!feat || migrated(feat, "duelingMigrated")) return;
    const flat = feat.effects.filter(e => (e.system.changes ?? []).some(c => c.key === "system.bonuses.mwak.damage"));
    if (flat.length) await feat.updateEmbeddedDocuments("ActiveEffect", flat.map(e => ({ _id: e.id, disabled: true })));
    await feat.setFlag(MODULE_ID, "duelingMigrated", MIGRATION_VERSION);
    console.log(`${LOG} Dueling у ${actor.name}: безусловный +2 выключен, бонус только для одноручного хвата`);
  },

  register() {
    onPreDamageRoll((config) => {
      const activity = config?.subject;
      const item = activity?.item;
      if (item?.type !== "weapon" || !hasDueling(item.actor)) return;
      if (activity.attack?.type?.value !== "melee") return;
      const mode = config.attackMode ?? "";
      if (item.system.properties?.has("two") || mode === "twoHanded" || mode.startsWith("thrown")) return;
      const base = config.rolls?.[0];
      if (base?.parts) base.parts.push("2");
    });
  },
};
