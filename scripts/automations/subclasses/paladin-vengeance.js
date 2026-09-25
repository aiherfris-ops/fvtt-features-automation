import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { featById, isActiveGM, migrated, runAsync } from "../../core/utils.js";
import { onItemUse, onPreAttackRoll } from "../../core/hooks.js";

/*
 * Паладин — Oath of Vengeance (PHB 2024), 3 уровень: Vow of Enmity.
 * Эффект клятвы висит на цели (накладывает Midi); преимущество на атаки по ней даёт хук броска атаки.
 */

const IDS = { transfer: "faVowTransfer000" };
const VOW_EFFECT_ID = "vowOfEnmityxxxxx";

const getVow = actor => featById(actor, "vow-of-enmity");

/** Эффекты клятвы этого паладина на актёре-цели */
const vowEffectsOn = (target, vow) =>
  target?.effects?.filter(e => e.active && e.origin?.startsWith(vow.uuid)) ?? [];

async function removeEffects(actor, effects) {
  if (!effects.length) return;
  if (actor.isOwner) await actor.deleteEmbeddedDocuments("ActiveEffect", effects.map(e => e.id));
  else await globalThis.MidiQOL?.removeEffects?.({ actorUuid: actor.uuid, effects: effects.map(e => e.id) });
}

/** «Или пока вы не используете это умение снова»: снимаем клятву со всех прежних целей */
async function dropOldVows(vow, keepTokens) {
  const keep = new Set(keepTokens.map(t => t.actor?.uuid));
  for (const token of canvas.tokens?.placeables ?? []) {
    const target = token.actor;
    if (!target || keep.has(target.uuid)) continue;
    await removeEffects(target, vowEffectsOn(target, vow));
  }
}

export default {
  id: "paladin-vengeance",
  kind: "subclass",
  label: "Паладин — Oath of Vengeance",
  hint: "Vow of Enmity: преимущество на атаки по цели клятвы, снятие старой клятвы, перенос при падении цели.",
  identifiers: ["vow-of-enmity"],

  // Перенос клятвы без траты Channel Divinity, когда цель падает до 0 хитов
  async migrate(actor) {
    const vow = getVow(actor);
    if (!vow || migrated(vow, "vowMigrated")) return;
    await vow.update({
      [`system.activities.${IDS.transfer}`]: {
        _id: IDS.transfer,
        type: "utility",
        name: "Перенести клятву",
        activation: { type: "special", value: null, condition: "Цель клятвы опустилась до 0 хитов", override: false },
        consumption: { targets: [], spellSlot: false, scaling: { allowed: false } },
        range: { units: "ft", value: "30", override: false },
        target: { affects: { type: "creature", count: "1", choice: false, special: "" }, prompt: true, override: false },
        duration: { units: "minute", value: "1", concentration: false, override: false },
        effects: [{ _id: VOW_EFFECT_ID }],
        roll: { prompt: false, visible: false },
      },
      [`flags.${MODULE_ID}.vowMigrated`]: MIGRATION_VERSION,
    });
    console.log(`${LOG} Vow of Enmity у ${actor.name}: действие переноса клятвы`);
  },

  register() {
    // Преимущество на атаки по цели клятвы
    onPreAttackRoll((config) => {
      const actor = config?.subject?.actor;
      const vow = getVow(actor);
      if (!vow) return;
      const targets = [...(config.workflow?.targets?.size ? config.workflow.targets : game.user.targets)];
      if (targets.some(t => vowEffectsOn(t.actor, vow).length)) config.advantage = true;
    });

    // Новая клятва (или перенос) снимает прежние
    onItemUse("vow-of-enmity", (activity) => runAsync("Vow of Enmity",
      () => dropOldVows(activity.item, [...game.user.targets])));

    // Цель клятвы упала до 0 хитов — напоминаем о переносе
    Hooks.on("updateActor", (target, changes) => {
      if (!isActiveGM() || foundry.utils.getProperty(changes, "system.attributes.hp.value") !== 0) return;
      for (const effect of target.effects.filter(e => e.active && e.origin)) {
        const source = fromUuidSync(effect.origin);
        const vow = source instanceof Item ? source : source?.item;
        if (vow?.system?.identifier !== "vow-of-enmity" || !vow.actor) continue;
        const paladin = vow.actor;
        ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: paladin }),
          whisper: game.users.filter(u => u.isGM || paladin.testUserPermission(u, "OWNER")).map(u => u.id),
          content: `<p>Цель клятвы <strong>${target.name}</strong> повержена. <strong>${paladin.name}</strong> может `
            + `перенести Vow of Enmity на другое существо в 30 футах: выберите цель и используйте «Перенести клятву».</p>`,
        });
      }
    });
  },
};
