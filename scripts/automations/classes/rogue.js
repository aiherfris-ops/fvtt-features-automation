import { LOG, MODULE_ID } from "../../core/constants.js";
import { isIncapacitated, nearbyTokens } from "../../core/native.js";
import { doubleDice, registerDamageBonusProvider, syncDamageBonusMacro } from "../../core/damage-bonus.js";
import { damageTypeLabel, debugNote, isEnabled, turnKey } from "../../core/utils.js";

/* Плут: Sneak Attack через DamageBonus-макрос Midi-QOL */

const SNEAK_RE = /sneak\s*attack|скрытая атака/i;

/**
 * Варианты Sneak Attack от подклассов и черт (например, Venomous Strike).
 * @typedef {object} SneakAttackVariant
 * @property {string} id
 * @property {(actor: Actor) => Item|null|undefined} source  Предмет-источник варианта, если он есть у персонажа
 * @property {(ctx: SneakContext) => {label: string, icon?: string}} button
 * @property {(ctx: SneakContext) => {damageRoll: string, damageType: string, flavor: string}} apply
 * @property {boolean} [preferred]  Выбран по умолчанию, если доступен
 *
 * @typedef {{ actor: Actor, feature: Item, source: Item, formula: string, weaponType: string }} SneakContext
 */

/** @type {SneakAttackVariant[]} */
const variants = [];

export function registerSneakAttackVariant(variant) {
  variants.push(variant);
}

export const getSneakFeature = actor => actor?.itemTypes?.feat?.find(f => SNEAK_RE.test(f.name));

/** Оружие подходит для скрытой атаки: фехтовальное или дальнобойное */
const isSneakWeapon = item =>
  item?.type === "weapon"
  && (item.system.properties?.has?.("fin") || ["simpleR", "martialR"].includes(item.system.type?.value));

/** Формула урона из damage-активности фичи (обычно @scale.rogue.sneak-attack) */
function sneakFormula(feature, actor, isCritical) {
  let formula = null;
  for (const activity of feature.system.activities ?? []) {
    const part = activity.damage?.parts?.[0];
    if (!part) continue;
    if (part.custom?.enabled && part.custom.formula) formula = part.custom.formula;
    else if (part.number && part.denomination) formula = `${part.number}d${part.denomination}`;
    if (formula) break;
  }
  formula ??= "@scale.rogue.sneak-attack";
  try {
    formula = Roll.replaceFormulaData(formula, actor.getRollData());
  } catch (e) { /* оставляем как есть */ }
  return isCritical ? doubleDice(formula) : formula;
}

/** Есть ли рядом с целью боеспособный союзник атакующего (в 5 футах) */
function hasAdjacentAlly(workflow, targetToken) {
  try {
    const attacker = workflow.token;
    if (!attacker) return false;
    const nearby = globalThis.MidiQOL?.findNearby?.(null, targetToken, 5) ?? nearbyTokens(targetToken, 5);
    return nearby.some(t =>
      t.id !== attacker.id
      && t.document.disposition === attacker.document.disposition
      && !(globalThis.MidiQOL?.checkIncapacitated?.(t.actor, false) ?? isIncapacitated(t.actor)));
  } catch (err) {
    console.warn(`${LOG} проверка союзника рядом не удалась:`, err);
    return false;
  }
}

/**
 * Поставщик бонуса урона: общий диспетчер (core/damage-bonus.js) спрашивает обо всех бонусах разом.
 * Варианты подклассов (Venomous Strike и т.п.) показываются выпадающим списком в том же окне.
 */
registerDamageBonusProvider({
  id: "sneak-attack",
  enabled: () => isEnabled("rogue"),

  prepare({ workflow, actor, item, target }) {
    const feature = getSneakFeature(actor);
    if (!feature) return null;
    if (!isSneakWeapon(item)) {
      debugNote(actor, `Sneak Attack: «${item?.name}» не фехтовальное и не дальнобойное оружие — пропуск`);
      return null;
    }

    const key = turnKey();
    if (key && actor.getFlag(MODULE_ID, "sneakUsed") === key) {
      debugNote(actor, "Sneak Attack: уже применена в этом ходу");
      return null;
    }

    const adv = !!workflow.advantage;
    const dis = !!workflow.disadvantage;
    const ally = hasAdjacentAlly(workflow, target);
    if (!((adv && !dis) || (ally && !(dis && !adv)))) {
      debugNote(actor, `Sneak Attack: условия не выполнены (преимущество=${adv}, помеха=${dis}, союзник в 5 фт от цели=${ally})`);
      return null;
    }

    const formula = sneakFormula(feature, actor, !!workflow.isCritical);
    // Тип урона — как у оружия: из уже брошенного урона, иначе из базового урона предмета
    const weaponType = workflow.damageRolls?.[0]?.options?.type
      ?? Array.from(workflow.activity?.damage?.parts?.[0]?.types ?? [])[0]
      ?? Array.from(item.system.damage?.base?.types ?? [])[0]
      ?? "piercing";

    const available = variants
      .map(variant => ({ variant, source: variant.source(actor) }))
      .filter(v => v.source);
    const context = source => ({ actor, feature, source, formula, weaponType });
    const options = [
      { value: "normal", label: `${formula} (${damageTypeLabel(weaponType)})` },
      ...available.map(({ variant, source }) => ({
        value: variant.id,
        label: variant.button(context(source)).label,
      })),
    ];
    const preferred = available.find(v => v.variant.preferred);
    if (preferred) options.unshift(options.splice(options.findIndex(o => o.value === preferred.variant.id), 1)[0]);

    return {
      label: feature.name,
      options,
      async apply(choice) {
        if (key) await actor.setFlag(MODULE_ID, "sneakUsed", key);
        const picked = available.find(v => v.variant.id === choice);
        if (picked) return picked.variant.apply(context(picked.source));
        return { damageRoll: formula, damageType: weaponType, flavor: feature.name };
      },
    };
  },
});

export default {
  id: "rogue",
  kind: "class",
  label: "Плут",
  hint: "Sneak Attack: проверка условий, раз в ход, диалог с вариантами подклассов.",
  appliesTo: actor => actor.type === "character" && !!getSneakFeature(actor),
  watchItem: item => item.type === "feat" && SNEAK_RE.test(item.name),

  // Подключаем DamageBonus-макрос Midi каждому персонажу со Sneak Attack
  async migrate(actor) {
    await syncDamageBonusMacro(actor);
  },
};
