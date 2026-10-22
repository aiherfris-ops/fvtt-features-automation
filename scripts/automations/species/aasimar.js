import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { nearbyTokens } from "../../core/midi.js";
import { registerDamageBonusProvider, syncDamageBonusMacro } from "../../core/damage-bonus.js";
import { onItemUse } from "../../core/hooks.js";
import { change, chat, damageTypeLabel, featById, isActiveGM, isEnabled, migrated, runAsync, turnKey } from "../../core/utils.js";

/*
 * Вид — Aasimar (PHB 2024), Celestial Revelation (3 уровень персонажа).
 * Импорт: Inner Radiance сразу бил по области и вешал эффект на цели, у Heavenly Wings скорость полёта 1,
 * страх Necrotic Shroud длился минуту. Теперь любой вариант даёт эффект превращения на себя (1 минута),
 * а модуль отвечает за полёт, свет, урон в конце хода и доп. урон раз в ход.
 */

const IDS = {
  wings: "dnd5eactivity000",
  radiance: "faInnerRadiance0",
  shroud: "dnd5eactivity002",
  oldRadiance: "dnd5eactivity001",
  frightened: "celestialRevela2",
};
const FORMS = {
  wings: { label: "Heavenly Wings", damageType: "radiant" },
  radiance: { label: "Inner Radiance", damageType: "radiant" },
  shroud: { label: "Necrotic Shroud", damageType: "necrotic" },
};
const RADIANCE_LIGHT = { bright: 10, dim: 20, color: "#ffe9a8", alpha: 0.35 };

const revelationEffect = actor => actor?.effects?.find(e => e.active && e.getFlag(MODULE_ID, "celestialRevelation"));

async function migrateRevelation(actor) {
  const feature = featById(actor, "celestial-revelation");
  if (!feature || migrated(feature, "celestialMigrated")) return;
  const updates = {
    // Крылья и сияние — только на себя; эффекты накладывает модуль
    [`system.activities.${IDS.wings}.effects`]: [],
    [`system.activities.${IDS.wings}.target.affects`]: { type: "self", count: "", choice: false, special: "" },
    [`system.activities.-=${IDS.oldRadiance}`]: null,
    [`system.activities.${IDS.radiance}`]: {
      _id: IDS.radiance,
      type: "utility",
      name: "Inner Radiance",
      activation: { type: "bonus", value: 1, condition: "", override: false },
      consumption: { targets: [{ type: "itemUses", value: "1", target: "", scaling: {} }], spellSlot: false,
        scaling: { allowed: false } },
      duration: { units: "minute", value: "1", concentration: false, override: false },
      range: { units: "self", override: false },
      target: { affects: { type: "self" }, prompt: false, override: false },
      roll: { prompt: false, visible: false },
    },
    [`flags.${MODULE_ID}.celestialMigrated`]: MIGRATION_VERSION,
  };
  await feature.update(updates);

  // Страх Necrotic Shroud — до конца следующего хода аасимара, а не минуту
  const frightened = feature.effects.get(IDS.frightened);
  if (frightened) await frightened.update({ duration: { value: 1, units: "rounds", expiry: "turnEnd" } });

  // Старые эффекты крыльев и сияния больше не используются
  const obsolete = feature.effects.filter(e => ["celestialRevelat", "celestialRevela1"].includes(e.id)).map(e => e.id);
  if (obsolete.length) await feature.deleteEmbeddedDocuments("ActiveEffect", obsolete);
  console.log(`${LOG} Celestial Revelation у ${actor.name}: варианты превращения исправлены`);
}

async function transform(activity) {
  const item = activity.item;
  const actor = item.actor;
  const form = Object.keys(FORMS).find(key => IDS[key] === activity.id);
  if (!form) return;

  const old = actor.effects.filter(e => e.getFlag(MODULE_ID, "celestialRevelation"));
  if (old.length) await actor.deleteEmbeddedDocuments("ActiveEffect", old.map(e => e.id));

  const walk = Number(actor.system.attributes.movement?.walk) || 30;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: `Celestial Revelation: ${FORMS[form].label}`,
    img: item.img,
    origin: item.uuid,
    duration: { value: 60, units: "seconds" },
    description: `<p>Раз в ход дополнительный урон ${damageTypeLabel(FORMS[form].damageType)} = бонус мастерства `
      + "одной цели атаки или заклинания."
      + (form === "wings" ? " Скорость полёта равна скорости." : "")
      + (form === "radiance" ? " Яркий свет 10 футов, тусклый ещё 10; в конце хода существа в 10 футах получают урон излучением = бонус мастерства." : "")
      + "</p>",
    system: { changes: form === "wings" ? [change("system.attributes.movement.fly", "upgrade", walk)] : [] },
    flags: { [MODULE_ID]: { celestialRevelation: form } },
  }]);
}

/* Inner Radiance: свет на токенах */

async function setRadianceLight(effect, on) {
  const actor = effect.parent;
  if (!(actor instanceof Actor)) return;
  for (const token of actor.getActiveTokens(false, true)) {
    if (!token.isOwner) continue;
    if (on) {
      await token.setFlag(MODULE_ID, "lightBackup", token.light.toObject());
      await token.update({ light: RADIANCE_LIGHT });
    } else {
      const backup = token.getFlag(MODULE_ID, "lightBackup");
      if (!backup) continue;
      await token.update({ light: backup });
      await token.unsetFlag(MODULE_ID, "lightBackup");
    }
  }
}

/* Inner Radiance: урон существам в 10 футах в конце хода */

async function radianceTurnEnd(combat) {
  const combatant = combat.combatants.get(combat.previous?.combatantId);
  const actor = combatant?.actor;
  if (revelationEffect(actor)?.getFlag(MODULE_ID, "celestialRevelation") !== "radiance") return;
  const token = combatant.token?.object;
  if (!token) return;
  const prof = actor.system.attributes.prof ?? 2;
  const nearby = (globalThis.MidiQOL?.findNearby?.(null, token, 10, { includeIncapacitated: true })
    ?? nearbyTokens(token, 10, { includeIncapacitated: true }))
    .filter(t => t.actor && t.id !== token.id);
  if (!nearby.length) return;

  const hits = nearby.map(t => ({
    tokenUuid: t.document.uuid, name: t.name, detail: "Inner Radiance",
    damages: [{ value: prof, type: "radiant" }], applied: false,
  }));
  const card = globalThis.spellAutomation?.createDamageCard;
  if (card) {
    await card(actor, { rolls: [], flavor: `Inner Radiance — конец хода ${actor.name}`, hits, detailLabel: "Источник" });
  } else {
    await chat(actor, `<p>Inner Radiance: ${nearby.map(t => t.name).join(", ")} получают ${prof} урона излучением.</p>`);
  }
}

/* Доп. урон раз в ход, пока длится превращение */

registerDamageBonusProvider({
  id: "celestial-revelation",
  enabled: () => isEnabled("aasimar"),

  prepare({ actor }) {
    const effect = revelationEffect(actor);
    if (!effect) return null;
    const key = turnKey();
    if (key && actor.getFlag(MODULE_ID, "revelationUsed") === key) return null;
    const form = FORMS[effect.getFlag(MODULE_ID, "celestialRevelation")];
    const prof = actor.system.attributes.prof ?? 2;
    return {
      label: `Celestial Revelation (${form.label}): +${prof} ${damageTypeLabel(form.damageType)}`,
      async apply() {
        if (key) await actor.setFlag(MODULE_ID, "revelationUsed", key);
        return { damageRoll: `${prof}`, damageType: form.damageType, flavor: `Celestial Revelation (${form.label})` };
      },
    };
  },
});

export default {
  id: "aasimar",
  kind: "species",
  label: "Aasimar",
  hint: "Celestial Revelation: полёт, свет и урон Inner Radiance, страх до конца следующего хода, доп. урон раз в ход.",
  identifiers: ["celestial-revelation"],

  async migrate(actor) {
    await migrateRevelation(actor);
    await syncDamageBonusMacro(actor);
  },

  register() {
    onItemUse("celestial-revelation", (activity) => runAsync("Celestial Revelation", () => transform(activity)));

    Hooks.on("createActiveEffect", (effect, options, userId) => {
      if (userId !== game.user.id || effect.getFlag(MODULE_ID, "celestialRevelation") !== "radiance") return;
      runAsync("Inner Radiance: свет", () => setRadianceLight(effect, true));
    });

    Hooks.on("deleteActiveEffect", (effect, options, userId) => {
      if (userId !== game.user.id || effect.getFlag(MODULE_ID, "celestialRevelation") !== "radiance") return;
      runAsync("Inner Radiance: свет", () => setRadianceLight(effect, false));
    });

    Hooks.on("updateCombat", (combat, changes) => {
      if (!isActiveGM() || !("turn" in changes || "round" in changes)) return;
      runAsync("Inner Radiance: конец хода", () => radianceTurnEnd(combat));
    });
  },
};
