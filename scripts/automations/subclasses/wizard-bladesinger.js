import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { change, chat, featById, isActiveGM, migrated } from "../../core/utils.js";
import { ARCANE_RECOVERY_HOOK } from "../classes/wizard.js";
import { onPreAttackRoll, onPreDamageRoll } from "../../core/hooks.js";

/* Волшебник — Bladesinger (FRHoF), 3 уровень: Bladesong, Bladework, Training in War and Song */

const IDS = {
  bladesongUse: "faBladesongUse00",
  bladesongEffect: "faBladesongEff00",
  trainingEffect: "faTrainingWarSng",
};
const INCAPACITATING = new Set(["incapacitated", "paralyzed", "petrified", "stunned", "unconscious"]);
// Воинское рукопашное оружие 2024 без свойств «Двуручное» и «Тяжёлое»
const WAR_AND_SONG_WEAPONS = ["battleaxe", "flail", "longsword", "morningstar", "rapier", "scimitar",
  "shortsword", "trident", "warhammer", "warpick", "whip"];

const bladesongEffects = actor => actor?.effects?.filter(e => e.getFlag(MODULE_ID, "bladesong")) ?? [];
const hasBladesong = actor => bladesongEffects(actor).some(e => e.active);

const wearsArmorOrShield = actor => actor.itemTypes.equipment.some(i =>
  i.system.equipped && (i.system.type?.value in CONFIG.DND5E.armorTypes));

async function endBladesong(actor, reason) {
  const effects = bladesongEffects(actor);
  if (!effects.length) return;
  await actor.deleteEmbeddedDocuments("ActiveEffect", effects.map(e => e.id));
  await chat(actor, `<p>Bladesong у <strong>${actor.name}</strong> заканчивается: ${reason}.</p>`);
}

/**
 * Bladework: атаки оружием, которым владеете, могут использовать Интеллект.
 * У броска атаки данные на момент хука ещё не собраны: dnd5e строит их позже как
 * `{ ...данныеАтаки, ...config.data }`, поэтому заранее записанный `mod` имеет приоритет.
 * У броска урона данные уже есть — перезаписываем в них.
 */
function applyBladework(config) {
  const activity = config?.subject;
  const item = activity?.item;
  const actor = item?.actor;
  if (item?.type !== "weapon" || !hasBladesong(actor)) return null;
  if (!((item.system.prof?.multiplier ?? 0) > 0)) return null;
  const intMod = actor.system.abilities.int?.mod ?? 0;
  const currentMod = actor.system.abilities[activity.ability]?.mod ?? 0;
  if (intMod <= currentMod) return { actor, item };
  if (!config.rolls?.length) config.rolls = [{}];
  for (const roll of config.rolls) roll.data = { ...(roll.data ?? {}), mod: intMod };
  return { actor, item };
}

async function migrateBladesong(actor) {
  // Вместо спасброска Телосложения — бонусное действие, накладывающее эффект на 1 минуту
  const bladesong = featById(actor, "bladesong");
  if (!bladesong || migrated(bladesong, "bladesongMigrated")) return;
  const updates = {
    [`system.activities.${IDS.bladesongUse}`]: {
      _id: IDS.bladesongUse,
      type: "utility",
      name: "Начать Bladesong",
      activation: { type: "bonus", value: 1, condition: "", override: false },
      consumption: { targets: [{ type: "itemUses", value: "1", target: "", scaling: {} }], spellSlot: false,
        scaling: { allowed: false } },
      duration: { units: "minute", value: "1", concentration: false, override: false },
      range: { units: "self", override: false },
      target: { affects: { type: "self", count: "", choice: false, special: "" }, prompt: false, override: false },
      effects: [{ _id: IDS.bladesongEffect }],
      roll: { prompt: false, visible: false },
    },
    [`flags.${MODULE_ID}.bladesongMigrated`]: MIGRATION_VERSION,
  };
  for (const activity of bladesong.system.activities) {
    if (activity.id !== IDS.bladesongUse) updates[`system.activities.-=${activity.id}`] = null;
  }
  await bladesong.update(updates);
  if (!bladesong.effects.has(IDS.bladesongEffect)) {
    await bladesong.createEmbeddedDocuments("ActiveEffect", [{
      _id: IDS.bladesongEffect,
      name: "Bladesong",
      img: bladesong.img,
      transfer: false,
      duration: { value: 60, units: "seconds" },
      description: "<p>КД + мод. Интеллекта (мин. +1), скорость +10 футов, преимущество на Ловкость (Акробатика), "
        + "+ мод. Интеллекта к спасброскам концентрации; атаки оружием, которым вы владеете, могут использовать Интеллект.</p>",
      system: { changes: [
        change("system.attributes.ac.bonus", "add", "+ max(1, @abilities.int.mod)"),
        change("system.attributes.movement.bonus", "add", "+ 10"),
        change("system.skills.acr.roll.mode", "add", 1),
        change("system.attributes.concentration.bonuses.save", "add", "+ @abilities.int.mod"),
      ] },
      flags: { [MODULE_ID]: { bladesong: true }, dae: { stackable: "noneName" } },
    }], { keepId: true });
  }
  console.log(`${LOG} Bladesong у ${actor.name}: бонусное действие с эффектом`);
}

async function migrateTraining(actor) {
  // Владение воинским рукопашным оружием без «Двуручного»/«Тяжёлого»; навык на выбор отмечает игрок
  const training = featById(actor, "training-in-war-and-song");
  if (!training || training.effects.has(IDS.trainingEffect)) return;
  await training.createEmbeddedDocuments("ActiveEffect", [{
    _id: IDS.trainingEffect,
    name: "Training in War and Song: владение оружием",
    img: training.img,
    transfer: true,
    system: { changes: WAR_AND_SONG_WEAPONS.map(id => change("system.traits.weaponProf.value", "add", id)) },
  }], { keepId: true });
  console.log(`${LOG} Training in War and Song у ${actor.name}: владение воинским оружием`);
}

export default {
  id: "wizard-bladesinger",
  kind: "subclass",
  label: "Волшебник — Bladesinger",
  hint: "Bladesong (эффект, Bladework, досрочное окончание), Training in War and Song.",
  identifiers: ["bladesong", "training-in-war-and-song"],

  async migrate(actor) {
    await migrateBladesong(actor);
    await migrateTraining(actor);
  },

  register() {
    // Нельзя начать в доспехе или со щитом
    Hooks.on("dnd5e.preUseActivity", (activity) => {
      if (activity?.id !== IDS.bladesongUse) return;
      const actor = activity.item.actor;
      if (actor && wearsArmorOrShield(actor)) {
        ui.notifications.warn(`${actor.name}: Bladesong нельзя начать в доспехе или со щитом.`);
        return false;
      }
    });

    onPreAttackRoll((config) => {
      const result = applyBladework(config);
      if (!result) return;
      const twoHanded = config.attackMode === "twoHanded" || result.item.system.properties?.has("two");
      if (twoHanded) setTimeout(() => endBladesong(result.actor, "атака оружием двумя руками"), 0);
    });

    onPreDamageRoll((config) => { applyBladework(config); });

    // Досрочное окончание: недееспособность, надетый доспех или щит (обрабатывает активный ГМ)
    Hooks.on("createActiveEffect", (effect) => {
      if (!isActiveGM()) return;
      const actor = effect.parent;
      if (!(actor instanceof Actor) || !hasBladesong(actor)) return;
      if ([...(effect.statuses ?? [])].some(s => INCAPACITATING.has(s))) endBladesong(actor, "персонаж недееспособен");
    });

    Hooks.on("updateItem", (item, changes) => {
      if (!isActiveGM() || !item.actor || !hasBladesong(item.actor)) return;
      if (changes.system?.equipped !== true || !(item.system.type?.value in CONFIG.DND5E.armorTypes)) return;
      endBladesong(item.actor, `надет ${item.name}`);
    });

    // Arcane Recovery возвращает одно использование Bladesong
    Hooks.on(ARCANE_RECOVERY_HOOK, async (actor) => {
      const bladesong = featById(actor, "bladesong");
      const spent = bladesong?.system.uses?.spent ?? 0;
      if (!bladesong || spent <= 0) return;
      await bladesong.update({ "system.uses.spent": spent - 1 });
      await chat(actor, `<p><strong>${actor.name}</strong> возвращает одно использование Bladesong.</p>`);
    });
  },
};
