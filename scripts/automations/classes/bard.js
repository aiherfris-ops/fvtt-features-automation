import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { registerRollBoost } from "../../core/roll-boost.js";
import { featById, isEnabled, migrated, runAsync } from "../../core/utils.js";

/*
 * Бард 2024: кость Вдохновения тратится уже после броска d20 — как и сказано в правилах
 * («когда существо провалит проверку, оно может бросить кость и добавить к d20»). Владельцу
 * вдохновлённого персонажа после каждого броска шепчется кнопка «добавить кость».
 *
 * Fount of Inspiration (5 уровень) возвращает использования и в короткий отдых — импорт даёт только длинный.
 */

const INSPIRED = "bardicInspiration";
const DIE = "inspirationDie";

/** Действующее вдохновение на персонаже */
const inspiration = actor => actor?.effects?.find(e => e.getFlag(MODULE_ID, INSPIRED) && !e.disabled);

/** Кость вдохновения: литерал, записанный при наложении, иначе формула барда, иначе d6 */
const dieOf = effect => effect?.getFlag(MODULE_ID, DIE) || "1d6";

/** Вычислить кость по данным барда-источника */
async function resolveDie(effect) {
  try {
    const origin = effect.origin ? await fromUuid(effect.origin) : null;
    const actor = origin?.actor ?? origin;
    const formula = actor ? Roll.replaceFormulaData("@scale.bard.inspiration", actor.getRollData?.() ?? {}) : "";
    return /d\d/.test(formula) ? formula : "1d6";
  } catch (err) {
    console.warn(`${LOG} кость вдохновения:`, err);
    return "1d6";
  }
}

registerRollBoost({
  id: "bardic-inspiration",
  label: "Bardic Inspiration",
  enabled: () => isEnabled("bard"),

  prepare(actor) {
    if (!isEnabled("bard")) return null;
    const effect = inspiration(actor);
    if (!effect) return null;
    const formula = dieOf(effect);
    return {
      label: `Вдохновение барда (+${formula})`,
      formula,
      flavor: "Вдохновение барда",
      spend: async () => {
        if (!actor.isOwner) return false;
        await actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id]);
        return true;
      },
    };
  },
});

export default {
  id: "bard",
  kind: "class",
  label: "Бард",
  hint: "Кость Вдохновения можно потратить кнопкой уже после броска d20 (как в правилах — увидев провал). "
    + "Fount of Inspiration возвращает использования и в короткий отдых.",
  identifiers: ["bardic-inspiration"],

  async migrate(actor) {
    const feature = featById(actor, "bardic-inspiration");
    if (!feature) return;

    // Пометить эффект вдохновения, чтобы его узнавать на цели
    const effect = feature.effects.find(e => /inspir|вдохнов/i.test(e.name ?? "")) ?? feature.effects.contents[0];
    if (effect && !effect.getFlag(MODULE_ID, INSPIRED)) {
      await effect.update({ [`flags.${MODULE_ID}.${INSPIRED}`]: true });
      console.log(`${LOG} вдохновение барда у ${actor.name}: эффект помечен`);
    }

    // Fount of Inspiration: восстановление в короткий отдых
    const font = featById(actor, "font-of-inspiration") ?? featById(actor, "fount-of-inspiration");
    const recovery = feature.system.uses?.recovery ?? [];
    if (font && !migrated(feature, "inspirationRecoveryMigrated") && !recovery.some(r => r.period === "sr")) {
      await feature.update({
        "system.uses.recovery": [...recovery, { period: "sr", type: "recoverAll" }],
        [`flags.${MODULE_ID}.inspirationRecoveryMigrated`]: MIGRATION_VERSION,
      });
      console.log(`${LOG} вдохновение барда у ${actor.name}: восстановление в короткий отдых`);
    }
  },

  register() {
    // Кость барда зависит от его уровня, а не от уровня вдохновлённого — считаем при наложении
    Hooks.on("createActiveEffect", (effect, options, userId) => {
      if (userId !== game.user.id || !effect.getFlag(MODULE_ID, INSPIRED)) return;
      if (/d\d/.test(effect.getFlag(MODULE_ID, DIE) ?? "")) return;
      runAsync("Вдохновение барда: кость", async () => {
        const formula = await resolveDie(effect);
        await effect.update({ [`flags.${MODULE_ID}.${DIE}`]: formula });
      });
    });
  },
};
