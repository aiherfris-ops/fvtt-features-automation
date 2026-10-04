/*
 * Починка данных мира после перехода на dnd5e 6 и midi 14.6.
 *
 * Чинит то, на что ругается консоль при загрузке:
 *   1. Изменения эффектов с негодным `type` (в поле типа лежит число вроде "20" или "40" —
 *      последствие старой конвертации). Foundry такие эффекты не создаёт вовсе.
 *   2. Классовые предметы на NPC: dnd5e 6 при подготовке NPC читает у них шкалы класса и падает
 *      («Cannot read properties of undefined (reading 'byType')», «parseUuid(...) is null»).
 *   3. Поведения регионов от выключенного модуля (например multi-token-edit.linkToken).
 *
 * Запуск (макрос типа «Скрипт», от ГМа):
 *   const fix = await import("/modules/features-automation/tools/fix-world-data.mjs");
 *   await fix.run();                 // только показать, что не так
 *   await fix.run({ apply: true });  // починить изменения эффектов и убрать осиротевшие поведения
 *   await fix.run({ apply: true, removeClassItems: true });  // ещё и снять классы с NPC
 */

const VALID_TYPES = new Set(["add", "multiply", "override", "upgrade", "downgrade", "custom"]);

/** Каким тип должен быть, если в нём мусор: решаем по смыслу ключа и значения */
export function guessType(change) {
  const key = String(change?.key ?? "");
  const value = String(change?.value ?? "");
  if (/senses\.|\.darkvision|truesight|blindsight|tremorsense/i.test(key)) return "upgrade";
  if (/movement\./i.test(key) && /^@/.test(value)) return "override";
  if (/\.calc$|\.formula$|\.type$|\.units$/i.test(key)) return "override";
  if (/^[+-]/.test(value) || /^\d+$/.test(value) || /^@/.test(value)) return "add";
  return "override";
}

const isBroken = change => !VALID_TYPES.has(change?.type);

/* Сбор проблем */

const effectsOf = (doc) => [...(doc.effects ?? [])];

function collectBrokenEffects() {
  const found = [];
  const look = (effect, where) => {
    const changes = effect.system?.changes ?? [];
    const bad = changes.filter(isBroken);
    if (bad.length) found.push({ effect, where, bad });
  };
  for (const item of game.items) for (const effect of effectsOf(item)) look(effect, `предмет «${item.name}»`);
  for (const actor of game.actors) {
    for (const effect of effectsOf(actor)) look(effect, `актёр «${actor.name}»`);
    for (const item of actor.items) for (const effect of effectsOf(item)) look(effect, `${actor.name} → «${item.name}»`);
  }
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      const actor = token.actor;
      if (!actor || token.actorLink) continue;
      for (const item of actor.items) for (const effect of effectsOf(item)) {
        look(effect, `${scene.name} → токен «${token.name}» → «${item.name}»`);
      }
    }
  }
  return found;
}

function collectClassItemsOnNpcs() {
  const found = [];
  const check = (actor, where) => {
    if (actor?.type !== "npc") return;
    const classes = actor.items.filter(item => ["class", "subclass"].includes(item.type));
    if (classes.length) found.push({ actor, where, items: classes });
  };
  for (const actor of game.actors) check(actor, `актёр «${actor.name}»`);
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      if (token.actorLink) continue;
      check(token.actor, `${scene.name} → токен «${token.name}»`);
    }
  }
  return found;
}

function collectOrphanBehaviors() {
  const known = new Set(Object.keys(CONFIG.RegionBehavior?.dataModels ?? {}));
  const found = [];
  for (const scene of game.scenes) {
    for (const region of scene.regions ?? []) {
      for (const behavior of region.behaviors ?? []) {
        const type = behavior.type ?? behavior._source?.type;
        if (known.has(type)) continue;
        found.push({ scene, region, behavior, type });
      }
    }
  }
  return found;
}

/* Починка */

async function fixEffects(found, { apply }) {
  const lines = [];
  for (const { effect, where, bad } of found) {
    const changes = foundry.utils.deepClone(effect.system.changes ?? []);
    const fixes = [];
    for (const change of changes) {
      if (!isBroken(change)) continue;
      const type = guessType(change);
      fixes.push(`${change.key}: ${JSON.stringify(change.type)} → ${type}`);
      change.type = type;
    }
    lines.push(`${where}, эффект «${effect.name}»: ${fixes.join("; ")}`);
    if (apply) await effect.update({ "system.changes": changes });
  }
  return lines;
}

async function fixNpcs(found, { apply, removeClassItems }) {
  const lines = [];
  for (const { actor, where, items } of found) {
    lines.push(`${where}: ${items.map(item => `${item.name} (${item.type})`).join(", ")}`);
    if (apply && removeClassItems) await actor.deleteEmbeddedDocuments("Item", items.map(item => item.id));
  }
  return lines;
}

async function fixBehaviors(found, { apply }) {
  const lines = [];
  for (const { scene, region, behavior, type } of found) {
    lines.push(`${scene.name} → регион «${region.name ?? region.id}»: поведение ${type}`);
    if (apply) await region.deleteEmbeddedDocuments("RegionBehavior", [behavior.id]);
  }
  return lines;
}

/**
 * Проверить и (по желанию) починить.
 * @param {object} [options]
 * @param {boolean} [options.apply]             Чинить, а не только показывать
 * @param {boolean} [options.removeClassItems]  Снимать классовые предметы с NPC (необратимо)
 */
export async function run({ apply = false, removeClassItems = false } = {}) {
  if (!game.user.isGM) {
    ui.notifications.warn("Чинить данные мира может только ГМ.");
    return null;
  }

  const effects = collectBrokenEffects();
  const npcs = collectClassItemsOnNpcs();
  const behaviors = collectOrphanBehaviors();

  const report = {
    effects: await fixEffects(effects, { apply }),
    npcs: await fixNpcs(npcs, { apply, removeClassItems }),
    behaviors: await fixBehaviors(behaviors, { apply }),
  };

  const total = report.effects.length + report.npcs.length + report.behaviors.length;
  const title = apply ? "Данные мира починены" : "Проверка данных мира (ничего не меняли)";
  const section = (name, lines, note = "") => (lines.length
    ? `<p><strong>${name}</strong> — ${lines.length}${note}</p><ul>${lines.map(l => `<li>${l}</li>`).join("")}</ul>`
    : `<p><strong>${name}</strong> — чисто</p>`);

  const content = `<p><strong>${title}</strong></p>`
    + section("Изменения эффектов с негодным типом", report.effects, apply ? ", исправлено" : ", будет исправлено")
    + section("Классовые предметы на NPC", report.npcs,
      removeClassItems && apply ? ", сняты" : " — снимаются только с removeClassItems: true")
    + section("Поведения регионов от выключенных модулей", report.behaviors,
      apply ? ", убраны" : ", будут убраны")
    + (apply ? "<p>Перезагрузите мир, чтобы Foundry перечитал документы.</p>" : "");

  await ChatMessage.create({ whisper: [game.user.id], content });
  console.log("[fix-world-data]", report);
  ui.notifications.info(total
    ? `${title}: записей ${total}. Подробности в чате.`
    : "Данные мира в порядке — чинить нечего.");
  return report;
}
