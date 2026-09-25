import { LOG } from "../../core/constants.js";
import { chat, featById, runAsync } from "../../core/utils.js";

/*
 * Черта Survivor (Grim Hollow: Player's Guide 2024), «Shake It Off»: после короткого отдыха истощение −1,
 * после долгого — −2 (dnd5e сам снимает 1, черта добавляет ещё 1).
 * Снимается только фактическое истощение: истощение от эффектов (Immersion 5e) остаётся.
 * «Hardy» (половина еды в день) — в Immersion 5e, рационы.
 * Проверяем по описанию «Shake It Off», чтобы не спутать с одноимёнными умениями (Survivor чемпиона).
 */

const SHAKE_IT_OFF = /shake it off|стряхнуть/i;

const hasShakeItOff = actor => {
  const feat = featById(actor, "survivor");
  return !!feat && SHAKE_IT_OFF.test(feat.system.description?.value ?? "");
};

const actual = actor => actor.system.attributes?.exhaustionBase ?? actor.system.attributes?.exhaustion ?? 0;

async function shakeItOff(actor, type) {
  if (actual(actor) <= 0) return;
  const before = actual(actor);
  const api = globalThis.immersion5e?.adjustExhaustion;
  if (api) await api(actor, -1);
  else await actor.update({ "system.attributes.exhaustion": Math.max(0, (actor.system.attributes.exhaustion ?? 0) - 1) });
  await chat(actor, `<p><strong>${actor.name}</strong> стряхивает усталость (Survivor): истощение ${before} → ${actual(actor)}`
    + (type === "long" ? " — ещё один уровень сверх обычного долгого отдыха" : "") + ".</p>");
}

export default {
  id: "survivor",
  kind: "feat",
  label: "Survivor (Grim Hollow)",
  hint: "Shake It Off: короткий отдых снимает 1 уровень истощения, долгий — 2 (только фактическое истощение).",
  identifiers: ["survivor"],

  register() {
    Hooks.on("dnd5e.restCompleted", (actor, result, config) => {
      if (!actor?.isOwner || !["short", "long"].includes(config?.type) || !hasShakeItOff(actor)) return;
      runAsync("Survivor", () => shakeItOff(actor, config.type));
    });
  },
};
