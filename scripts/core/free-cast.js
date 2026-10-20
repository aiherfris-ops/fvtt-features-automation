import { BYPASS, LOG } from "./constants.js";
import { debugNote, getRemainingUses } from "./utils.js";

/**
 * Связки «умение с зарядами → заклинание»: заклинание можно сотворить за заряд умения вместо ячейки.
 * Сначала сверяется system.identifier (не зависит от перевода), потом имя на английском или русском.
 * @typedef {{ feature: RegExp, spell: RegExp, featureIds?: string[], spellIds?: string[] }} FreeCastLink
 */

/** @type {FreeCastLink[]} */
const links = [];
let installed = false;

export function registerFreeCastLink(link) {
  links.push(link);
  if (!installed) install();
}

const matches = (item, ids, re) => !!ids?.includes(item.system?.identifier) || re.test(item.name ?? "");
const findLink = spell => links.find(l => matches(spell, l.spellIds, l.spell));
const findFeature = (actor, link) => actor.itemTypes.feat.find(f => matches(f, link.featureIds, link.feature));

function install() {
  installed = true;
  Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
    if (usageConfig?.[BYPASS]) return;

    const item = activity.item;
    const actor = item?.actor;
    if (!actor || item.type !== "spell" || (item.system.level ?? 0) < 1) return;

    const link = findLink(item);
    if (!link) return;

    // Перехватываем только активность, которая тратит ячейку (не вторичный урон и т.п.)
    if (!activity.requiresSpellSlot || !activity.consumption?.spellSlot) return;

    const feature = findFeature(actor, link);
    if (!feature) {
      debugNote(actor, `${item.name}: умение-источник не найдено у ${actor.name} — обычный каст`);
      return;
    }
    const { max, remaining, spent } = getRemainingUses(feature);
    if (max <= 0 || remaining <= 0) {
      debugNote(actor, `${item.name}: у «${feature.name}» нет зарядов (${remaining}/${max}) — обычный каст`);
      return;
    }

    (async () => {
      try {
        const choice = await foundry.applications.api.DialogV2.wait({
          window: { title: item.name },
          content: `<p>Чем оплатить каст <strong>${item.name}</strong>?</p>`,
          buttons: [
            { action: "feature", label: `${feature.name} (${remaining}/${max})`, icon: "fa-solid fa-paw-claws", default: true },
            { action: "slot", label: "Ячейка заклинания", icon: "fa-solid fa-star" },
            { action: "cancel", label: "Отмена", icon: "fa-solid fa-xmark" },
          ],
          rejectClose: false,
        });
        if (!choice || choice === "cancel") return;

        if (choice === "slot") {
          await activity.use({ [BYPASS]: true });
          return;
        }

        // Бесплатный каст за заряд умения: без ячейки, на базовом уровне
        const result = await activity.use(
          { [BYPASS]: true, consume: { spellSlot: false }, scaling: 0 },
          { configure: false },
          {},
        );
        if (!result) return;

        await feature.update({ "system.uses.spent": spent + 1 });
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<p><strong>${actor.name}</strong> использует «${feature.name}»: `
            + `«${item.name}» без траты ячейки (осталось зарядов: ${remaining - 1}/${max}).</p>`,
        });
      } catch (err) {
        console.error(`${LOG} ошибка диалога/каста:`, err);
        ui.notifications?.error("Features Automation: ошибка, кастую обычным способом (см. консоль F12)");
        await activity.use({ [BYPASS]: true });
      }
    })();

    return false;
  });
}
