import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { onWorkflowComplete } from "../../core/hooks.js";
import { applyEffects, isIncapacitated, onDamaged, removeEffects } from "../../core/native.js";
import { chat, debugNote, featById, isActiveGM, isEnabled, migrated, runAsync } from "../../core/utils.js";

/*
 * Жрец 2024: Turn Undead. Эффект «Обращён» вешается только на нежить, которая провалила спасброск,
 * и снимается сразу, как только цель получила урон или жрец стал недееспособен — ровно как в правилах.
 * Sear Undead (5 уровень) добавляет излучающий урон обращённым.
 */

const TURNED = "turned";

const undead = actor => (actor?.system?.details?.type?.value ?? "").toLowerCase() === "undead";

const turnedEffectData = (activity, cleric) => {
  const source = activity.item.effects.find(e => /turn|обращ/i.test(e.name ?? "")) ?? activity.item.effects.contents[0];
  const data = source
    ? source.toObject()
    : { name: "Обращён", img: activity.item.img, statuses: ["frightened", "incapacitated"] };
  delete data._id;
  return foundry.utils.mergeObject(data, {
    transfer: false,
    disabled: false,
    origin: activity.item.uuid,
    duration: { seconds: 60 },
    flags: { [MODULE_ID]: { [TURNED]: cleric.uuid } },
  });
};

/** Все обращённые этим жрецом: и на сцене, и в списке актёров */
function turnedBy(cleric) {
  const seen = new Map();
  const candidates = [
    ...game.actors,
    ...(canvas?.tokens?.placeables ?? []).map(token => token.actor).filter(Boolean),
  ];
  for (const actor of candidates) {
    const ids = actor.effects.filter(e => e.getFlag(MODULE_ID, TURNED) === cleric.uuid).map(e => e.id);
    if (ids.length) seen.set(actor, ids);
  }
  return seen;
}

/** Sear Undead: дополнительный излучающий урон обращённым (жрец 5) */
async function searUndead(cleric, targets) {
  const feature = featById(cleric, "sear-undead");
  if (!feature || !targets.length) return null;
  const dice = Math.max(1, cleric.system.abilities?.wis?.mod ?? 1);
  const roll = new Roll(`${dice}d8`, cleric.getRollData());
  await roll.evaluate();
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor: cleric }),
    flavor: `Sear Undead: излучающий урон обращённым (${dice}d8)`,
  });
  for (const token of targets) {
    const actor = token.actor;
    if (!actor) continue;
    if (actor.isOwner) await actor.applyDamage([{ value: roll.total, type: "radiant" }]);
    else debugNote(cleric, `Sear Undead: ${token.name} — урон ${roll.total} применит ГМ`);
  }
  return roll.total;
}

export default {
  id: "cleric",
  kind: "class",
  label: "Жрец",
  hint: "Turn Undead: эффект «Обращён» вешается только на нежить, провалившую спасброск, и снимается от урона "
    + "или недееспособности жреца. Sear Undead добавляет излучающий урон. Эффект убран из списка активности, "
    + "чтобы его не применяли дважды — при выключенной автоматизации верните его вручную.",
  identifiers: ["turn-undead"],

  async migrate(actor) {
    const feature = featById(actor, "turn-undead");
    if (!feature || migrated(feature, "turnUndeadMigrated")) return;
    const save = feature.system.activities?.getByType?.("save")?.[0];
    const updates = { [`flags.${MODULE_ID}.turnUndeadMigrated`]: MIGRATION_VERSION };
    // Эффект применяет автоматизация — только провалившей спасброск нежити
    if (save?.effects?.length) updates[`system.activities.${save.id}.effects`] = [];
    await feature.update(updates);
    console.log(`${LOG} Turn Undead у ${actor.name}: эффект применяет автоматизация`);
  },

  register() {
    onWorkflowComplete("turn-undead", async (workflow, activity) => {
      if (!isEnabled("cleric")) return;
      const cleric = activity.item.actor;
      const failed = [...(workflow.failedSaves ?? [])];
      const targets = [...(workflow.targets ?? [])];
      if (!targets.length) {
        debugNote(cleric, "Turn Undead: цели не выбраны");
        return;
      }

      const turned = [];
      const resisted = [];
      const wrongType = [];
      for (const token of targets) {
        if (!undead(token.actor)) { wrongType.push(token.name); continue; }
        if (!failed.includes(token)) { resisted.push(token.name); continue; }
        turned.push(token);
        await applyEffects(token.actor, [turnedEffectData(activity, cleric)]);
      }

      const lines = [];
      if (turned.length) lines.push(`<li>обращены: ${turned.map(t => t.name).join(", ")}</li>`);
      if (resisted.length) lines.push(`<li>устояли: ${resisted.join(", ")}</li>`);
      if (wrongType.length) lines.push(`<li>не нежить, действие не касается: ${wrongType.join(", ")}</li>`);
      await chat(cleric, `<p><strong>Turn Undead</strong></p><ul>${lines.join("")}</ul>`);
      await searUndead(cleric, turned);
    }, { saves: true });

    // Урон снимает обращение
    onDamaged(async (actor) => {
      const ids = actor.effects?.filter(e => e.getFlag(MODULE_ID, TURNED)).map(e => e.id) ?? [];
      if (!ids.length) return;
      if (actor.isOwner) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
      else await removeEffects(actor, ids);
      console.log(`${LOG} обращение снято с ${actor.name}: получен урон`);
    });

    // Недееспособный жрец теряет власть над обращёнными
    Hooks.on("createActiveEffect", (effect) => {
      if (!isActiveGM()) return;
      const cleric = effect.parent instanceof Actor ? effect.parent : null;
      if (!cleric || !isIncapacitated(cleric)) return;
      runAsync("Turn Undead: жрец недееспособен", async () => {
        for (const [actor, ids] of turnedBy(cleric)) {
          await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
        }
      });
    });
  },
};
