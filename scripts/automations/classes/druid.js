import { LOG, MODULE_ID } from "../../core/constants.js";
import { onItemUse } from "../../core/hooks.js";
import { isIncapacitated } from "../../core/midi.js";
import { chat, debugNote, isActiveGM, isEnabled, runAsync } from "../../core/utils.js";

/*
 * Друид 2024: Дикий облик держится часы, равные половине уровня друида, и заканчивается, если друид
 * стал недееспособен. dnd5e сам за временем не следит, поэтому уровень запоминается до превращения
 * (после него на листе уже звериные данные), а по игровому времени облик снимается.
 */

const STATE = "wildShapeState";

const druidLevel = actor => actor?.classes?.druid?.system?.levels
  ?? actor?.items?.find(i => i.type === "class" && i.system.identifier === "druid")?.system?.levels
  ?? 0;

const state = actor => actor?.getFlag(MODULE_ID, STATE) ?? null;

const formatHours = hours => `${hours} ч`;

/** Вернуть друида в свой облик */
async function revert(actor, reason) {
  const data = state(actor);
  if (!data) return;
  await actor.unsetFlag(MODULE_ID, STATE);
  if (actor.isPolymorphed && actor.revertOriginalForm) {
    await actor.revertOriginalForm();
    await chat(actor, `<p><strong>${actor.name}</strong> возвращается в свой облик — ${reason}.</p>`);
    console.log(`${LOG} дикий облик снят с ${actor.name}: ${reason}`);
    return;
  }
  // Превращение могло быть сделано иначе (другой токен, другой актёр) — тогда только напоминание
  debugNote(actor, `Дикий облик: пора вернуться (${reason}), но превращение сделано не через dnd5e`);
  await chat(actor, `<p><em>${actor.name}: дикий облик должен закончиться — ${reason}.</em></p>`);
}

export default {
  id: "druid",
  kind: "class",
  label: "Друид",
  hint: "Дикий облик: в чат уходит срок (половина уровня друида в часах), по игровому времени облик снимается сам, "
    + "недееспособность прекращает его сразу.",
  identifiers: ["wild-shape"],

  async migrate() {
    // Данные друида править не нужно: активность превращения приходит из импорта рабочей
  },

  register() {
    // Уровень нужно прочитать до превращения: после него на листе уже звериные данные
    Hooks.on("dnd5e.preUseActivity", (activity) => {
      const actor = activity?.item?.actor;
      if (activity?.item?.system?.identifier !== "wild-shape" || !actor?.isOwner) return;
      const level = druidLevel(actor);
      if (level) runAsync("Дикий облик: уровень", () => actor.setFlag(MODULE_ID, `${STATE}Level`, level));
    });

    onItemUse("wild-shape", (activity) => {
      if (!isEnabled("druid")) return;
      const actor = activity.item.actor;
      if (!actor?.isOwner) return;
      runAsync("Дикий облик: начало", async () => {
        const level = actor.getFlag(MODULE_ID, `${STATE}Level`) || druidLevel(actor) || 2;
        const hours = Math.max(1, Math.floor(level / 2));
        await actor.setFlag(MODULE_ID, STATE, { started: game.time.worldTime, hours });
        await chat(actor, `<p><strong>Дикий облик.</strong> Держится ${formatHours(hours)} или до нового превращения, `
          + "недееспособности или смерти. Выйти раньше можно бонусным действием.</p>");
      });
    });

    // Время вышло
    Hooks.on("updateWorldTime", () => {
      if (!isActiveGM()) return;
      for (const actor of game.actors) {
        const data = state(actor);
        if (!data) continue;
        if (game.time.worldTime - (data.started ?? 0) < (data.hours ?? 1) * 3600) continue;
        runAsync("Дикий облик: время", () => revert(actor, "время вышло"));
      }
    });

    // Недееспособность
    Hooks.on("createActiveEffect", (effect) => {
      if (!isActiveGM()) return;
      const actor = effect.parent instanceof Actor ? effect.parent : null;
      if (!actor || !state(actor) || !isIncapacitated(actor)) return;
      runAsync("Дикий облик: недееспособность", () => revert(actor, "друид недееспособен"));
    });

    // Вышел сам — состояние больше не нужно
    Hooks.on("dnd5e.revertOriginalForm", (actor) => {
      if (!state(actor) || !actor.isOwner) return;
      runAsync("Дикий облик: выход", () => actor.unsetFlag(MODULE_ID, STATE));
    });
  },
};
