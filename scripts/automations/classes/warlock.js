import { LOG } from "../../core/constants.js";
import { onWorkflowComplete } from "../../core/hooks.js";
import { pushTokenAway } from "../../core/midi.js";
import { chat, debugNote, isEnabled } from "../../core/utils.js";

/*
 * Колдун: воззвания, двигающие цель Eldritch Blast. Repelling Blast отталкивает попавшую цель
 * на 10 футов, Grasp of Hadar — притягивает. Остальные умения колдуна 1–6 уровней после импорта
 * работают сами (Pact Magic, Magical Cunning, Agonizing Blast как зачарование).
 */

const INVOCATIONS = {
  repelling: { pattern: /repelling[- ]blast/i, distance: 10, label: "Repelling Blast", verb: "отталкивает" },
  grasp: { pattern: /grasp[- ]of[- ]hadar/i, distance: -10, label: "Grasp of Hadar", verb: "притягивает" },
};

const hasInvocation = (actor, pattern) => actor.itemTypes.feat.some(feat =>
  pattern.test(feat.system.identifier ?? "") || pattern.test(feat.name ?? ""));

async function chooseInvocation(options) {
  if (options.length === 1) return options[0];
  const buttons = options.map(option => ({ action: option.label, label: option.label, returnValue: option }));
  const picked = await foundry.applications.api.DialogV2.wait({
    window: { title: "Eldritch Blast" },
    content: "<p>Как двигать цель этим лучом?</p>",
    buttons: [...buttons.map(b => ({ ...b, callback: () => b.returnValue })), { action: "none", label: "Не двигать" }],
    rejectClose: false,
  });
  return typeof picked === "object" ? picked : null;
}

export default {
  id: "warlock",
  kind: "class",
  label: "Колдун",
  hint: "Repelling Blast отталкивает попавшую цель Eldritch Blast на 10 футов, Grasp of Hadar притягивает на 10.",
  identifiers: ["eldritch-invocations", "pact-magic"],
  appliesTo: actor => Object.values(INVOCATIONS).some(inv => hasInvocation(actor, inv.pattern)),

  async migrate() {
    // Данные колдуна править не нужно: воззвания приходят из импорта рабочими
  },

  register() {
    onWorkflowComplete("eldritch-blast", async (workflow, activity) => {
      if (!isEnabled("warlock")) return;
      const actor = activity.item.actor;
      const available = Object.values(INVOCATIONS).filter(inv => hasInvocation(actor, inv.pattern));
      if (!available.length) return;

      const targets = [...(workflow.hitTargets?.size ? workflow.hitTargets : workflow.targets ?? [])];
      const origin = workflow.token?.center ?? actor.getActiveTokens?.()[0]?.center;
      if (!targets.length || !origin) {
        debugNote(actor, "Eldritch Blast: нет попавших целей или токена колдуна");
        return;
      }

      const choice = await chooseInvocation(available);
      if (!choice) return;
      for (const token of targets) {
        await pushTokenAway(token, choice.distance, origin);
        await chat(actor, `<p><strong>${choice.label}:</strong> ${choice.verb} <strong>${token.name}</strong>`
          + ` на ${Math.abs(choice.distance)} футов.</p>`);
      }
      console.log(`${LOG} ${choice.label}: целей ${targets.length}`);
    });
  },
};
