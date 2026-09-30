import { LOG, MODULE_ID } from "./constants.js";

/*
 * Условия по снаряжению. Правила вроде «Unarmored Defense», «Unarmored Movement», «Fast Movement»
 * и «Ярость» работают, только пока персонаж не надел доспех (или не тяжёлый доспех). Active Effect
 * такое условие сам не проверяет, поэтому помеченные эффекты включаются и выключаются здесь —
 * при надевании и снятии доспеха или щита.
 *
 * Пометка: flags.features-automation.gearCondition = "noArmor" | "noHeavyArmor" | "noArmorOrShield".
 */

export const GEAR_FLAG = "gearCondition";

const ARMOR_TYPES = new Set(["light", "medium", "heavy"]);

const equipped = actor => actor?.items?.filter(item => item.type === "equipment" && item.system.equipped) ?? [];

export const wearsArmor = actor => equipped(actor).some(i => ARMOR_TYPES.has(i.system.type?.value));
export const wearsHeavyArmor = actor => equipped(actor).some(i => i.system.type?.value === "heavy");
export const wieldsShield = actor => equipped(actor).some(i => i.system.type?.value === "shield");

/** Условие → действует ли помеченный им эффект при нынешнем снаряжении */
export const CONDITIONS = {
  noArmor: actor => !wearsArmor(actor),
  noHeavyArmor: actor => !wearsHeavyArmor(actor),
  noArmorOrShield: actor => !wearsArmor(actor) && !wieldsShield(actor),
};

/** Все эффекты актёра, включая передаваемые с предметов (их выключать нужно на самом предмете) */
const allEffects = actor => [...(actor.effects ?? []), ...(actor.items?.flatMap(item => [...item.effects]) ?? [])];

/** Привести помеченные эффекты в соответствие со снаряжением. Возвращает число изменений. */
export async function refreshGearEffects(actor) {
  if (!actor?.isOwner) return 0;
  let changed = 0;
  for (const effect of allEffects(actor)) {
    const test = CONDITIONS[effect.getFlag(MODULE_ID, GEAR_FLAG)];
    if (!test) continue;
    const allowed = test(actor);
    if (effect.disabled !== allowed) continue; // disabled === allowed означает «состояние неверное»
    await effect.update({ disabled: !allowed });
    changed++;
  }
  if (changed) console.log(`${LOG} снаряжение ${actor.name}: пересчитано эффектов ${changed}`);
  return changed;
}

let installed = false;

/** Следить за снаряжением: один слушатель на мир */
export function installGearConditions() {
  if (installed) return;
  installed = true;
  const refresh = item => {
    const actor = item?.actor;
    if (!actor || item.type !== "equipment") return;
    refreshGearEffects(actor).catch(err => console.error(`${LOG} условия по снаряжению:`, err));
  };
  Hooks.on("updateItem", (item, changes) => {
    if ("equipped" in (changes.system ?? {})) refresh(item);
  });
  Hooks.on("createItem", refresh);
  Hooks.on("deleteItem", refresh);
  // Эффект мог примениться, пока доспех уже надет (Ярость под тяжёлым доспехом)
  Hooks.on("createActiveEffect", (effect) => {
    const actor = effect.parent instanceof Actor ? effect.parent : effect.parent?.actor;
    if (actor && effect.getFlag(MODULE_ID, GEAR_FLAG)) {
      refreshGearEffects(actor).catch(err => console.error(`${LOG} условия по снаряжению:`, err));
    }
  });
}
