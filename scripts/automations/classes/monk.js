import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { GEAR_FLAG, refreshGearEffects } from "../../core/gear.js";
import { onPreAttackRoll } from "../../core/hooks.js";
import { featById, isEnabled, migrated } from "../../core/utils.js";

/*
 * Монах: боевые искусства (кость монаха и Ловкость в безоружном ударе), Patient Defense
 * (состояние «уклонение» — атаки по монаху с помехой), Stunning Strike (спасбросок Телосложения
 * против СЛ монаха за очко), безоружная защита и передвижение — только без доспехов и щита.
 *
 * Импорт Plutonium оставляет безоружный удар с уроном «1 + @mod» и не даёт уклонению состояния.
 */

const IDS = {
  dodge: "faDodgeEffect000",
  stunUse: "faStunningUse000",
  stunned: "faStunnedEffect0",
};

const unarmedStrike = actor => actor.items.find(item => item.type === "weapon"
  && (item.system.identifier === "unarmed-strike" || /unarmed strike|безоружн/i.test(item.name)));

const focusFeature = actor => featById(actor, "monks-focus") ?? featById(actor, "ki");

/** Кость боевых искусств из шкалы класса: у импорта это @scale.monk.die */
function martialArtsDie(actor) {
  const scale = actor.getRollData?.()?.scale?.monk ?? {};
  for (const key of ["die", "martial-arts", "martialArts"]) {
    if (scale[key]) return `@scale.monk.${key}`;
  }
  return null;
}

const isDodging = actor => !!actor?.statuses?.has?.("dodging");

export default {
  id: "monk",
  kind: "class",
  label: "Монах",
  hint: "Безоружный удар получает кость монаха и свойство «фехтовальное» (Ловкость), Patient Defense даёт "
    + "состояние «уклонение» и помеху атакам по монаху, Stunning Strike — спасбросок Телосложения за очко, "
    + "безоружная защита и передвижение выключаются под доспехом или щитом.",
  identifiers: ["martial-arts", "monks-focus", "ki", "patient-defense", "unarmored-defense", "unarmored-movement"],
  appliesTo: actor => !!featById(actor, "martial-arts"),

  async migrate(actor) {
    // Безоружный удар: кость монаха вместо «1 + @mod» и Ловкость вместо Силы
    const martial = featById(actor, "martial-arts");
    const strike = unarmedStrike(actor);
    const die = martialArtsDie(actor);
    if (martial && strike && die && !migrated(strike, "martialArtsMigrated")) {
      const properties = new Set(strike.system.properties ?? []);
      properties.add("fin");
      await strike.update({
        "system.damage.base.custom.enabled": true,
        "system.damage.base.custom.formula": `${die} + @mod`,
        "system.properties": [...properties],
        [`flags.${MODULE_ID}.martialArtsMigrated`]: MIGRATION_VERSION,
      });
      console.log(`${LOG} боевые искусства у ${actor.name}: безоружный удар ${die} + @mod`);
    }

    // Patient Defense: состояние «уклонение» (dnd5e сам даёт от него преимущество на спасброски Ловкости)
    const patient = featById(actor, "patient-defense");
    if (patient && !migrated(patient, "patientDefenseMigrated")) {
      if (!patient.effects.has(IDS.dodge)) {
        await patient.createEmbeddedDocuments("ActiveEffect", [{
          _id: IDS.dodge,
          name: "Уклонение",
          img: patient.img,
          transfer: false,
          statuses: ["dodging"],
          duration: { rounds: 1 },
          flags: { [MODULE_ID]: { dodge: true } },
        }], { keepId: true });
      }
      const activity = patient.system.activities?.contents?.[0];
      if (activity && !activity.effects?.some(e => e._id === IDS.dodge)) {
        await patient.update({
          [`system.activities.${activity.id}.effects`]: [...(activity.effects ?? []), { _id: IDS.dodge }],
        });
      }
      await patient.update({ [`flags.${MODULE_ID}.patientDefenseMigrated`]: MIGRATION_VERSION });
      console.log(`${LOG} Patient Defense у ${actor.name}: состояние «уклонение»`);
    }

    // Stunning Strike: спасбросок Телосложения против СЛ монаха за очко фокуса
    const stunning = featById(actor, "stunning-strike");
    const focus = focusFeature(actor);
    if (stunning && !migrated(stunning, "stunningStrikeMigrated")) {
      await stunning.update({
        [`system.activities.${IDS.stunUse}`]: {
          _id: IDS.stunUse,
          type: "save",
          name: "Оглушающий удар",
          activation: { type: "special", override: true },
          save: { ability: ["con"], dc: { calculation: "wis", formula: "" } },
          consumption: focus
            ? { targets: [{ type: "itemUses", value: "1", target: focus.id, scaling: {} }], spellSlot: false, scaling: { allowed: false } }
            : { targets: [], spellSlot: false, scaling: { allowed: false } },
          effects: [{ _id: IDS.stunned }],
          description: { chatFlavor: "При провале цель оглушена до конца вашего следующего хода." },
        },
        [`flags.${MODULE_ID}.stunningStrikeMigrated`]: MIGRATION_VERSION,
      });
      if (!stunning.effects.has(IDS.stunned)) {
        await stunning.createEmbeddedDocuments("ActiveEffect", [{
          _id: IDS.stunned,
          name: "Оглушён",
          img: stunning.img,
          transfer: false,
          statuses: ["stunned"],
          duration: { rounds: 1 },
        }], { keepId: true });
      }
      console.log(`${LOG} Stunning Strike у ${actor.name}`);
    }

    // Безоружная защита и передвижение работают, только пока нет доспеха и щита
    for (const [identifier, flagKey] of [["unarmored-defense", "unarmoredDefenseMigrated"],
      ["unarmored-movement", "unarmoredMovementMigrated"]]) {
      const feature = featById(actor, identifier);
      if (!feature || migrated(feature, flagKey)) continue;
      for (const effect of feature.effects) {
        if (effect.getFlag(MODULE_ID, GEAR_FLAG)) continue;
        await effect.update({ [`flags.${MODULE_ID}.${GEAR_FLAG}`]: "noArmorOrShield" });
      }
      await feature.update({ [`flags.${MODULE_ID}.${flagKey}`]: MIGRATION_VERSION });
    }

    // На случай, если монах уже в доспехе
    await refreshGearEffects(actor);
  },

  register() {
    // Атаки по уклоняющемуся — с помехой (dnd5e сам этого не считает)
    onPreAttackRoll((config) => {
      if (!isEnabled("monk")) return;
      for (const token of game.user.targets ?? []) {
        if (isDodging(token.actor)) config.disadvantage = true;
      }
    });
  },
};
