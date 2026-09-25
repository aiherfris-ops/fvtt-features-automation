import { LOG } from "./constants.js";
import { damageTypeLabel } from "./utils.js";

/*
 * Единый DamageBonus-макрос Midi-QOL. Раньше каждое умение вешало актёру свой макрос и показывало
 * собственное окно: на одно попадание могло выпасть три вопроса подряд. Теперь Midi вызывает один
 * макрос `function.featuresAutomation.damageBonus`, он собирает все доступные бонусы и спрашивает один раз.
 *
 * Поставщик бонуса (provider):
 *   id        — уникальный ключ
 *   automatic — применять без вопроса (например, Hunter's Mark: правила не дают выбора)
 *   prepare({ workflow, actor, item, target }) → null | {
 *     label, icon?, checked?, options?: [{ value, label }],
 *     apply(choice) → { damageRoll, damageType, flavor }   // может быть async, тут же тратит ресурсы
 *   }
 */

export const DAMAGE_BONUS_MACRO = "function.featuresAutomation.damageBonus";
const LEGACY_MACROS = ["sneakAttackBonus", "divineSmiteBonus", "celestialRevelationBonus", "huntersMarkBonus"];

/** @type {Map<string, object>} */
const providers = new Map();

export function registerDamageBonusProvider(provider) {
  providers.set(provider.id, provider);
}

/** Цель, по которой пришлось попадание (при выключенной автопроверке — выбранная цель) */
export function getHitTarget(workflow) {
  const hit = workflow.hitTargets?.first?.();
  if (hit) return hit;
  const autoCheckHit = globalThis.MidiQOL?.configSettings?.()?.autoCheckHit;
  if (!autoCheckHit || autoCheckHit === "none") return workflow.targets?.first?.() ?? null;
  return null;
}

/** Атака рукопашным оружием или безоружный удар */
export function isMeleeWeaponAttack(workflow, item) {
  const attack = workflow.activity?.attack;
  if (attack?.type?.value !== "melee") return false;
  if ((workflow.attackMode ?? "").startsWith("thrown")) return false;
  return item?.type === "weapon" || attack.type.classification === "unarmed";
}

/** Удвоить число костей формулы (критическое попадание) */
export const doubleDice = formula => formula.replace(/(\d+)d(\d+)/g, (m, n, d) => `${Number(n) * 2}d${d}`);

export { damageTypeLabel };

/** Подключить актёру единый макрос и убрать старые по одному на умение */
export async function syncDamageBonusMacro(actor) {
  const current = (actor.getFlag("dnd5e", "DamageBonusMacro") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const kept = current.filter(m => !LEGACY_MACROS.some(legacy => m.endsWith(`.${legacy}`)));
  if (!kept.includes(DAMAGE_BONUS_MACRO)) kept.push(DAMAGE_BONUS_MACRO);
  const value = kept.join(",");
  if (value === current.join(",")) return;
  await actor.setFlag("dnd5e", "DamageBonusMacro", value);
  console.log(`${LOG} ${actor.name}: подключён общий макрос бонусов урона`);
}

/* Диалог со всеми доступными бонусами сразу */

async function askBonuses(entries, target) {
  const rows = entries.filter(e => !e.provider.automatic).map(({ provider, offer }) => {
    const options = offer.options?.length
      ? `<select name="opt-${provider.id}" style="flex:1">`
        + offer.options.map(o => `<option value="${o.value}">${o.label}</option>`).join("") + "</select>"
      : "";
    return `<label style="display:flex;align-items:center;gap:.5em;margin:.25em 0">
      <input type="checkbox" name="use-${provider.id}" ${offer.checked === false ? "" : "checked"}>
      <span style="flex:0 0 auto">${offer.label}</span>${options}</label>`;
  }).join("");
  if (!rows) return new Map();

  const picked = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Дополнительный урон" },
    position: { width: 420 },
    content: `<p>Цель: <strong>${target.name}</strong>. Что добавить к урону?</p>${rows}`,
    ok: {
      label: "Добавить",
      callback: (event, button) => {
        const chosen = new Map();
        for (const { provider, offer } of entries) {
          if (provider.automatic) continue;
          if (!button.form.elements[`use-${provider.id}`]?.checked) continue;
          chosen.set(provider.id, offer.options?.length ? button.form.elements[`opt-${provider.id}`].value : true);
        }
        return chosen;
      },
    },
    rejectClose: false,
  });
  return picked ?? new Map();
}

/** Собственно макрос: Midi вызывает его один раз на бросок урона */
async function damageBonus({ workflow, actor, item }) {
  try {
    if (workflow?.macroPass !== "DamageBonus" || !actor) return;
    const target = getHitTarget(workflow);
    if (!target) return;

    const context = { workflow, actor, item, target };
    const entries = [];
    for (const provider of providers.values()) {
      if (provider.enabled && !provider.enabled()) continue;
      try {
        const offer = await provider.prepare(context);
        if (offer) entries.push({ provider, offer });
      } catch (err) {
        console.error(`${LOG} бонус урона «${provider.id}»:`, err);
      }
    }
    if (!entries.length) return;

    const chosen = await askBonuses(entries, target);
    const results = [];
    for (const { provider, offer } of entries) {
      const choice = provider.automatic ? true : chosen.get(provider.id);
      if (!choice) continue;
      try {
        const result = await offer.apply(choice === true ? null : choice);
        if (result) results.push(result);
      } catch (err) {
        console.error(`${LOG} применение бонуса «${provider.id}»:`, err);
      }
    }
    return results.length ? results : undefined;
  } catch (err) {
    console.error(`${LOG} ошибка damageBonus:`, err);
  }
}

// Midi ищет функцию по имени из флага актёра; старые имена оставлены пустыми,
// чтобы не сыпать ошибками у актёров, которых ещё не тронула миграция
globalThis.featuresAutomation = Object.assign(globalThis.featuresAutomation ?? {}, {
  damageBonus,
  registerDamageBonusProvider,
  syncDamageBonusMacro,
  ...Object.fromEntries(LEGACY_MACROS.map(name => [name, () => undefined])),
});
