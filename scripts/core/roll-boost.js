import { LOG, MODULE_ID } from "./constants.js";

/*
 * «Добавить кость к уже сделанному броску d20»: Bardic Inspiration, Tactical Mind и подобные умения.
 * Правила разрешают тратить такую кость, уже увидев бросок, поэтому после броска владельцу
 * персонажа шепчется сообщение с кнопкой; нажатие бросает кость, показывает новый итог и тратит ресурс.
 * Решение «провал или успех» остаётся за игроком — СЛ модуль не знает.
 *
 * Поставщик: { id, label, prepare(actor, context) → null | { label, formula, flavor, spend, refund? } }
 * context: { kind: "check"|"save"|"attack", roll, total, ability, skill, tool, activity }
 */

const providers = new Map();
const PROMPT = "rollBoostPrompt";
let installed = false;

export function registerRollBoost(provider) {
  providers.set(provider.id, provider);
  install();
}

const escape = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const whisperSelf = () => [game.user.id];

function ready(actor, context) {
  const options = [];
  for (const provider of providers.values()) {
    try {
      const prepared = provider.prepare(actor, context);
      if (prepared) options.push({ provider, ...prepared });
    } catch (err) {
      console.error(`${LOG} подготовка бонуса ${provider.id}:`, err);
    }
  }
  return options;
}

/** Предложить бонус после броска */
async function offer(actor, context) {
  if (!actor?.isOwner || !providers.size) return;
  const options = ready(actor, context);
  if (!options.length) return;
  const buttons = options.map(option => `<button type="button" data-fa-boost="${escape(option.provider.id)}"`
    + ` data-actor="${escape(actor.uuid)}" data-total="${context.total}" data-kind="${escape(context.kind)}">`
    + `${escape(option.label)}</button>`).join(" ");
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    whisper: whisperSelf(),
    flags: { [MODULE_ID]: { [PROMPT]: true } },
    content: `<p><strong>Бросок: ${context.total}.</strong> Можно улучшить, уже видя результат:</p>`
      + `<div style="display:flex;gap:4px;flex-wrap:wrap">${buttons}</div>`,
  });
}

async function spend(button) {
  const actor = await fromUuid(button.dataset.actor);
  const provider = providers.get(button.dataset.faBoost);
  if (!actor || !provider) return;
  const total = Number(button.dataset.total) || 0;
  const kind = button.dataset.kind;
  const prepared = ready(actor, { kind, total }).find(option => option.provider.id === provider.id);
  if (!prepared) {
    ui.notifications.warn(`${provider.label ?? provider.id}: уже недоступно.`);
    return;
  }
  if ((await prepared.spend()) === false) return;

  const roll = new Roll(prepared.formula, actor.getRollData());
  await roll.evaluate();
  const refund = provider.refund
    ? `<button type="button" data-fa-refund="${escape(provider.id)}" data-actor="${escape(actor.uuid)}">`
      + "Всё равно провал — вернуть ресурс</button>"
    : "";
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `${prepared.flavor ?? prepared.label}: ${total} + бросок`,
    flags: { [MODULE_ID]: { boost: provider.id } },
  });
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p><strong>${escape(prepared.flavor ?? prepared.label)}:</strong> ${total} + ${roll.total} = `
      + `<strong>${total + roll.total}</strong></p>${refund}`,
  });
  const message = button.closest("[data-message-id]")?.dataset?.messageId;
  await game.messages.get(message)?.delete().catch(() => {});
}

async function refund(button) {
  const actor = await fromUuid(button.dataset.actor);
  const provider = providers.get(button.dataset.faRefund);
  if (!actor || !provider?.refund) return;
  await provider.refund(actor);
  button.disabled = true;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p><em>${escape(provider.label ?? provider.id)}: проверка всё равно провалена, ресурс возвращён.</em></p>`,
  });
}

function bind(message, element) {
  // В v14 приходит HTMLElement, в более старых версиях — jQuery
  const root = element?.querySelectorAll ? element : element?.[0];
  if (!root?.querySelectorAll) return;
  root.querySelectorAll("[data-fa-boost]").forEach(button => button.addEventListener("click", () => {
    spend(button).catch(err => console.error(`${LOG} бонус к броску:`, err));
  }));
  root.querySelectorAll("[data-fa-refund]").forEach(button => button.addEventListener("click", () => {
    refund(button).catch(err => console.error(`${LOG} возврат ресурса:`, err));
  }));
}

function install() {
  if (installed) return;
  installed = true;

  const KINDS = {
    "dnd5e.rollSkillV2": "check",
    "dnd5e.rollToolCheckV2": "check",
    "dnd5e.rollAbilityCheckV2": "check",
    "dnd5e.rollSavingThrowV2": "save",
    "dnd5e.rollAttackV2": "attack",
  };
  for (const [hook, kind] of Object.entries(KINDS)) {
    Hooks.on(hook, (rolls, data = {}) => {
      const roll = Array.isArray(rolls) ? rolls[0] : rolls;
      if (!roll) return;
      const actor = kind === "attack" ? data.subject?.actor : data.subject;
      const context = {
        kind, roll, total: roll.total, ability: data.ability, skill: data.skill, tool: data.tool,
        activity: kind === "attack" ? data.subject : null,
      };
      offer(actor, context).catch(err => console.error(`${LOG} предложение бонуса:`, err));
    });
  }

  Hooks.on("renderChatMessageHTML", bind);
  Hooks.on("renderChatMessage", bind);
}
