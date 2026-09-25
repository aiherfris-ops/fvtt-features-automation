import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { change, featById, migrated } from "../../core/utils.js";
import { onActivityUse } from "../../core/hooks.js";

/* Вид — Tortle (MPMM): Natural Armor, Shell Defense, Claws */

const IDS = {
  shellEffect: "faShellDefense00",
  shellEmerge: "faShellEmerge000",
  clawsAttack: "faClawsAttack000",
};

// У других видов тоже бывают Claws/Natural Armor с иными правилами — трогаем только черепах
const isTortle = actor => !!actor.itemTypes.race?.some(r => r.system.identifier === "tortle");

async function migrateNaturalArmor(actor) {
  // «Фиксированный» КД игнорирует любые бонусы (Bladesong, Shell Defense, Shield) — нужен «природный»
  const armor = actor.system.attributes.ac;
  if (!featById(actor, "natural-armor") || armor.calc !== "flat") return;
  await actor.update({ "system.attributes.ac.calc": "natural", "system.attributes.ac.flat": armor.flat ?? 17 });
  console.log(`${LOG} ${actor.name}: КД «природный доспех» ${armor.flat ?? 17}, бонусы теперь учитываются`);
}

async function migrateShellDefense(actor) {
  const shell = featById(actor, "shell-defense");
  if (!shell || migrated(shell, "shellMigrated")) return;
  const updates = {
    [`system.activities.${IDS.shellEmerge}`]: {
      _id: IDS.shellEmerge,
      type: "utility",
      name: "Выйти из панциря",
      activation: { type: "bonus", value: 1, condition: "", override: false },
      consumption: { targets: [], spellSlot: false, scaling: { allowed: false } },
      range: { units: "self", override: false },
      target: { affects: { type: "self" }, prompt: false, override: false },
      roll: { prompt: false, visible: false },
    },
    [`flags.${MODULE_ID}.shellMigrated`]: MIGRATION_VERSION,
  };
  for (const activity of shell.system.activities) {
    if (activity.id === IDS.shellEmerge) continue;
    updates[`system.activities.${activity.id}.name`] = "Спрятаться в панцирь";
    updates[`system.activities.${activity.id}.effects`] = [{ _id: IDS.shellEffect }];
    updates[`system.activities.${activity.id}.target.affects.type`] = "self";
    updates[`system.activities.${activity.id}.consumption.spellSlot`] = false;
  }
  await shell.update(updates);
  if (!shell.effects.has(IDS.shellEffect)) {
    await shell.createEmbeddedDocuments("ActiveEffect", [{
      _id: IDS.shellEffect,
      name: "В панцире",
      img: shell.img,
      transfer: false,
      statuses: ["prone"],
      description: "<p>КД +4, преимущество на спасброски Силы и Телосложения, помеха на спасброски Ловкости, "
        + "скорость 0. Нельзя совершать реакции; единственное доступное действие — бонусным действием выйти из панциря.</p>",
      system: { changes: [
        change("system.attributes.ac.bonus", "add", "+ 4"),
        change("system.abilities.str.save.roll.mode", "add", 1),
        change("system.abilities.con.save.roll.mode", "add", 1),
        change("system.abilities.dex.save.roll.mode", "add", -1),
        ...["walk", "burrow", "climb", "fly", "swim"].map(t => change(`system.attributes.movement.${t}`, "override", "0")),
      ] },
      flags: { [MODULE_ID]: { shellDefense: true }, dae: { stackable: "noneName" } },
    }], { keepId: true });
  }
  console.log(`${LOG} Shell Defense у ${actor.name}: эффект и выход из панциря`);
}

async function migrateClaws(actor) {
  // Вместо голого броска урона — рукопашная атака без оружия (1d6 + Сил рубящим)
  const claws = featById(actor, "claws");
  if (!claws || migrated(claws, "clawsMigrated")) return;
  const updates = {
    [`system.activities.${IDS.clawsAttack}`]: {
      _id: IDS.clawsAttack,
      type: "attack",
      name: "Удар когтями",
      activation: { type: "action", value: 1, condition: "", override: false },
      consumption: { targets: [], spellSlot: false, scaling: { allowed: false } },
      range: { units: "ft", value: "5", override: false },
      target: { affects: { type: "creature", count: "1", choice: false, special: "" }, prompt: true, override: false },
      attack: { ability: "str", bonus: "@prof", flat: false, critical: { threshold: null },
        type: { value: "melee", classification: "unarmed" } },
      damage: { includeBase: false, critical: { bonus: "" }, parts: [{
        number: 1, denomination: 6, bonus: "@abilities.str.mod", types: ["slashing"],
        custom: { enabled: false, formula: "" }, scaling: { mode: "", number: 1 },
      }] },
    },
    [`flags.${MODULE_ID}.clawsMigrated`]: MIGRATION_VERSION,
  };
  for (const activity of claws.system.activities) {
    if (activity.id !== IDS.clawsAttack) updates[`system.activities.-=${activity.id}`] = null;
  }
  await claws.update(updates);
  console.log(`${LOG} Claws у ${actor.name}: атака когтями`);
}

export default {
  id: "tortle",
  kind: "species",
  label: "Tortle",
  hint: "Natural Armor (КД с бонусами), Shell Defense (эффект и выход из панциря), Claws (атака).",
  identifiers: ["natural-armor", "shell-defense", "claws"],
  appliesTo: isTortle,
  watchItem: item => item.type === "race" && item.system.identifier === "tortle",

  async migrate(actor) {
    await migrateNaturalArmor(actor);
    await migrateShellDefense(actor);
    await migrateClaws(actor);
  },

  register() {
    onActivityUse(IDS.shellEmerge, (activity) => {
      const actor = activity.item.actor;
      const effects = actor.effects.filter(e => e.getFlag(MODULE_ID, "shellDefense"));
      if (effects.length) actor.deleteEmbeddedDocuments("ActiveEffect", effects.map(e => e.id));
    });
  },
};
