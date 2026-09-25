import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { chat, featById, migrated, runAsync } from "../../core/utils.js";
import { onItemUse } from "../../core/hooks.js";

/**
 * Волшебник 2024: Arcane Recovery. Та же механика восстановления ячеек — у Natural Recovery друида (Круг Земли).
 * Ячейки суммарным кругом до половины уровня класса (вверх), не выше 5-го; раз за долгий отдых.
 * С вариантом «ячейки короткого отдыха» (Immersion 5e) умение тратит 1 минуту в любой момент,
 * а не срабатывает после короткого отдыха — активация переключается миграцией и возвращается при выключении.
 * После Arcane Recovery вызывается хук `featuresAutomation.arcaneRecovery(actor)` — на него
 * подписываются подклассы (Bladesinger возвращает использование Bladesong).
 */

export const ARCANE_RECOVERY_HOOK = "featuresAutomation.arcaneRecovery";

const RECOVERY = {
  "arcane-recovery": { cls: "wizard", title: "Arcane Recovery" },
  "natural-recovery": { cls: "druid", title: "Natural Recovery" },
};

/** Включён ли вариант «ячейки короткого отдыха» в Immersion 5e */
function shortRestSlotsVariant() {
  if (!game.modules.get("immersion-5e")?.active) return false;
  try { return game.settings.get("immersion-5e", "sr-slots-enabled") !== false; }
  catch (err) { return false; }
}

async function recoverSlots(actor, identifier) {
  const { cls, title } = RECOVERY[identifier];
  const classLevels = actor.classes?.[cls]?.system?.levels ?? 0;
  const budget = Math.ceil(classLevels / 2);
  const slots = [1, 2, 3, 4, 5]
    .map(level => ({ level, data: actor.system.spells?.[`spell${level}`] }))
    .filter(s => s.data?.max > 0 && s.data.value < s.data.max);

  if (budget > 0 && slots.length) {
    const rows = slots.map(s => `<tr><td>${s.level} ур.</td><td>${s.data.value}/${s.data.max}</td>`
      + `<td><input type="number" name="l${s.level}" value="0" min="0" max="${s.data.max - s.data.value}"></td></tr>`).join("");
    const picked = await foundry.applications.api.DialogV2.prompt({
      window: { title },
      content: `<p>Восстановить ячейки суммарным уровнем до <strong>${budget}</strong> (не выше 5-го).</p>`
        + `<table><tr><th>Ячейка</th><th>Сейчас</th><th>Вернуть</th></tr>${rows}</table>`,
      ok: {
        label: "Восстановить",
        callback: (event, button) => slots.map(s => ({ ...s,
          count: Math.max(0, Math.min(s.data.max - s.data.value, Math.floor(Number(button.form.elements[`l${s.level}`].value) || 0))) })),
      },
      rejectClose: false,
    });
    const chosen = (picked ?? []).filter(s => s.count > 0);
    const total = chosen.reduce((sum, s) => sum + s.level * s.count, 0);
    if (total > budget) {
      ui.notifications.warn(`${title}: выбрано уровней ${total}, можно не больше ${budget}. Верните ячейки вручную.`);
    } else if (chosen.length) {
      await actor.update(Object.fromEntries(chosen.map(s => [`system.spells.spell${s.level}.value`, s.data.value + s.count])));
      await chat(actor, `<p><strong>${actor.name}</strong> восстанавливает ячейки: `
        + chosen.map(s => `${s.level} ур. × ${s.count}`).join(", ") + ".</p>");
    }
  }

  if (identifier === "arcane-recovery") Hooks.callAll(ARCANE_RECOVERY_HOOK, actor);
}

/**
 * Активация умения под вариант: «1 минута» с вариантом, исходная — без него.
 * Исходная активация каждой активности запоминается во флаге при первом переключении.
 */
async function syncActivation(actor, item) {
  const variant = shortRestSlotsVariant();
  const mode = variant ? "variant" : "standard";
  if (item.getFlag(MODULE_ID, "recoveryActivation") === (variant ? "variant" : undefined)) return;
  const saved = item.getFlag(MODULE_ID, "recoveryOriginalActivation") ?? {};
  const updates = {};
  for (const activity of item.system.activities) {
    if (variant) {
      saved[activity.id] ??= activity.toObject().activation;
      updates[`system.activities.${activity.id}.activation`] = { type: "minute", value: 1, condition: "", override: false };
    } else if (saved[activity.id]) {
      updates[`system.activities.${activity.id}.activation`] = saved[activity.id];
    }
  }
  if (variant) updates[`flags.${MODULE_ID}.recoveryOriginalActivation`] = saved;
  updates[`flags.${MODULE_ID}.${variant ? "recoveryActivation" : "-=recoveryActivation"}`] = variant ? mode : null;
  await item.update(updates);
  console.log(`${LOG} ${item.name} у ${actor.name}: активация — ${variant ? "1 минута (вариант)" : "исходная"}`);
}

export default {
  id: "wizard",
  kind: "class",
  label: "Волшебник",
  hint: "Arcane Recovery и Natural Recovery: диалог восстановления ячеек, раз за длинный отдых; "
    + "с вариантом «ячейки короткого отдыха» — 1 минута в любой момент.",
  identifiers: Object.keys(RECOVERY),

  // Умения восстанавливаются длинным отдыхом, а не коротким; активация — по варианту ячеек
  async migrate(actor) {
    for (const identifier of Object.keys(RECOVERY)) {
      const recovery = featById(actor, identifier);
      if (!recovery) continue;
      if (!migrated(recovery, "arcaneRecoveryMigrated")) {
        await recovery.update({
          "system.uses.recovery": [{ period: "lr", type: "recoverAll" }],
          [`flags.${MODULE_ID}.arcaneRecoveryMigrated`]: MIGRATION_VERSION,
        });
        console.log(`${LOG} ${recovery.name} у ${actor.name}: восстановление длинным отдыхом`);
      }
      await syncActivation(actor, recovery);
    }
  },

  register() {
    // Вариант ячеек могли включить или выключить после миграции — сверяем активацию при загрузке
    Hooks.once("ready", () => {
      if (!game.users.activeGM?.isSelf) return;
      runAsync("Восстановление ячеек", async () => {
        for (const actor of game.actors.filter(a => a.type === "character")) {
          for (const identifier of Object.keys(RECOVERY)) {
            const item = featById(actor, identifier);
            if (item) await syncActivation(actor, item);
          }
        }
      });
    });
    for (const identifier of Object.keys(RECOVERY)) {
      onItemUse(identifier, (activity) => runAsync(RECOVERY[identifier].title, () => recoverSlots(activity.item.actor, identifier)));
    }
  },
};
