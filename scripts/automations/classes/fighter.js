import { registerRollBoost } from "../../core/roll-boost.js";
import { featById, getRemainingUses, isEnabled } from "../../core/utils.js";

/*
 * Воин 2024: Tactical Mind. При провале проверки характеристики можно потратить использование
 * Second Wind и добавить 1d10 — а если проверка всё равно провалена, использование не тратится
 * (кнопка возврата в сообщении о броске).
 */

const secondWind = actor => featById(actor, "second-wind");

registerRollBoost({
  id: "tactical-mind",
  label: "Tactical Mind",

  prepare(actor, context) {
    if (!isEnabled("fighter") || context.kind !== "check") return null;
    if (!featById(actor, "tactical-mind")) return null;
    const wind = secondWind(actor);
    if (!wind) return null;
    const { remaining } = getRemainingUses(wind);
    if (!remaining) return null;
    return {
      label: `Tactical Mind (+1d10, Second Wind: ${remaining})`,
      formula: "1d10",
      flavor: "Tactical Mind",
      spend: async () => {
        if (!actor.isOwner) return false;
        await wind.update({ "system.uses.spent": (wind.system.uses?.spent ?? 0) + 1 });
        return true;
      },
    };
  },

  async refund(actor) {
    const wind = secondWind(actor);
    if (!wind?.isOwner) return;
    await wind.update({ "system.uses.spent": Math.max(0, (wind.system.uses?.spent ?? 0) - 1) });
  },
});

export default {
  id: "fighter",
  kind: "class",
  label: "Воин",
  hint: "Tactical Mind: при провале проверки характеристики кнопка добавляет 1d10 за использование Second Wind, "
    + "а если проверка всё равно провалена — возвращает использование.",
  identifiers: ["tactical-mind", "second-wind"],
  appliesTo: actor => !!featById(actor, "tactical-mind"),

  async migrate() {
    // Данные воина править не нужно: Second Wind и Action Surge приходят из импорта рабочими
  },

  register() {
    // Всё делает поставщик бонуса выше (registerRollBoost) — свои хуки не нужны
  },
};
