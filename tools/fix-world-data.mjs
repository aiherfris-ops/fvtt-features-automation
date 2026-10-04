/*
 * Починка данных мира после перехода на dnd5e 6 и midi 14.6.
 *
 * Чинит то, на что ругается консоль при загрузке:
 *   1. Изменения эффектов с негодным `type` (в поле типа лежит число вроде "20" или "40" —
 *      последствие старой конвертации Плютониума). Foundry такие эффекты не создаёт вовсе.
 *   2. Классовые предметы на NPC: dnd5e 6 при подготовке NPC читает у них шкалы класса и падает
 *      («Cannot read properties of undefined (reading byType)», «parseUuid(...) is null»).
 *   3. Поведения регионов от выключенных модулей (например multi-token-edit.linkToken).
 *
 * Важно: негодные документы Foundry выбрасывает при загрузке, поэтому в коллекциях
 * (item.effects, region.behaviors) их нет — ищем в исходных данных документа (`_source`),
 * где они лежат ровно как в базе, и правим их обновлением владельца.
 *
 * Запуск (макрос типа «Скрипт», от ГМа):
 *   const fix = await import("/modules/features-automation/tools/fix-world-data.mjs");
 *   await fix.run();                 // только показать, что не так
 *   await fix.run({ apply: true });  // починить изменения эффектов
 *   await fix.run({ apply: true, removeBehaviors: true });   // ещё и убрать осиротевшие поведения
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

/*
 * Всё, у чего бывают эффекты, вместе с документом, через который их чинить.
 * Берём именно `_source`: в коллекции негодного эффекта уже нет.
 */
function effectHolders() {
  const out = [];
  const add = (doc, where) => { if (doc) out.push({ doc, where, sources: doc._source?.effects ?? [] }); };
  for (const item of game.items) add(item, `предмет мира «${item.name}»`);
  for (const actor of game.actors) {
    add(actor, `актёр «${actor.name}»`);
    for (const item of actor.items) add(item, `${actor.name} → «${item.name}»`);
  }
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      if (token.actorLink || !token.actor) continue;
      add(token.actor, `${scene.name} → токен «${token.name}»`);
      for (const item of token.actor.items) add(item, `${scene.name} → токен «${token.name}» → «${item.name}»`);
    }
  }
  return out;
}

function collectBrokenEffects() {
  const found = [];
  for (const holder of effectHolders()) {
    for (const source of holder.sources) {
      const changes = source?.system?.changes ?? [];
      if (!changes.some(isBroken)) continue;

      const fixed = foundry.utils.deepClone(changes);
      const fixes = [];
      for (const change of fixed) {
        if (!isBroken(change)) continue;
        const type = guessType(change);
        fixes.push(`${change.key}: ${JSON.stringify(change.type)} → ${type}`);
        change.type = type;
      }
      const live = holder.doc.effects?.get?.(source._id) ?? null;
      found.push({ holder, source, fixed, fixes, loaded: !!live });
    }
  }
  return found;
}

/*
 * Ссылка на источник, которую Foundry не может разобрать. dnd5e 6 на подготовке предмета
 * складывает его в указатель источников (`actor.sourcedItems`), а там ссылка идёт через
 * parseUuid. Если она негодна — подготовка предмета падает, у него не появляется
 * `advancement`, и следом рушится весь актёр: «Cannot read properties of undefined
 * (reading byType)». В мире такое встретилось у предметов в токенах сцен: при старом
 * переносе от ссылки остался только хвост вида «.EyvewCcPmF2dM2OL».
 */
const SOURCE_FIELDS = ["_stats.compendiumSource", "flags.dnd5e.sourceId"];

/** Разбирается ли ссылка так же, как её разбирает Foundry */
function parsesUuid(uuid) {
  try { return !!foundry.utils.parseUuid(uuid); }
  catch (err) { return false; }
}

function collectBrokenSources() {
  const found = [];
  const look = (item, where) => {
    for (const field of SOURCE_FIELDS) {
      const value = foundry.utils.getProperty(item._source ?? {}, field);
      if (!value || parsesUuid(value)) continue;
      found.push({ item, where, field, value });
    }
  };
  for (const item of game.items) look(item, `предмет мира «${item.name}»`);
  for (const actor of game.actors) for (const item of actor.items) look(item, `${actor.name} → «${item.name}»`);
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      if (token.actorLink || !token.actor) continue;
      for (const item of token.actor.items) look(item, `${scene.name} → токен «${token.name}» → «${item.name}»`);
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
    for (const region of scene._source?.regions ?? []) {
      for (const behavior of region.behaviors ?? []) {
        if (known.has(behavior.type)) continue;
        const mod = game.modules?.get?.(String(behavior.type).split(".")[0]) ?? null;
        found.push({ scene, region, behavior, type: behavior.type, mod });
      }
    }
  }
  return found;
}

/* Починка */

/*
 * Выброшенный документ нельзя поправить обновлением владельца: ни клиент, ни сервер не находят
 * его в коллекции, и правка молча пропадает. Поэтому такой эффект удаляем и заводим заново
 * с тем же id и уже исправленными данными. Загруженные эффекты правятся обычным update.
 */
async function repairHolder(holder, entries) {
  for (const { source, fixed } of entries.filter(e => e.loaded)) {
    await holder.doc.effects.get(source._id).update({ "system.changes": fixed });
  }

  const dropped = entries.filter(e => !e.loaded);
  if (!dropped.length) return;
  await holder.doc.deleteEmbeddedDocuments("ActiveEffect", dropped.map(e => e.source._id));
  const data = dropped.map(({ source, fixed }) => {
    const copy = foundry.utils.deepClone(source);
    copy.system = { ...(copy.system ?? {}), changes: fixed };
    return copy;
  });
  await holder.doc.createEmbeddedDocuments("ActiveEffect", data, { keepId: true });
}

async function fixEffects(found, { apply }) {
  const lines = [];
  const byHolder = new Map();
  for (const entry of found) {
    if (!byHolder.has(entry.holder)) byHolder.set(entry.holder, []);
    byHolder.get(entry.holder).push(entry);
  }

  for (const [holder, entries] of byHolder) {
    for (const { source, fixes, loaded } of entries) {
      const note = loaded ? "" : " (этот эффект из-за ошибки вообще не загрузился)";
      lines.push(`${holder.where}, эффект «${source.name}»: ${fixes.join("; ")}${note}`);
    }
    if (!apply) continue;
    try {
      await repairHolder(holder, entries);
    } catch (err) {
      console.error("[fix-world-data] не вышло починить", holder.where, err);
      lines.push(`${holder.where}: ПОЧИНИТЬ НЕ УДАЛОСЬ — ${err.message}`);
    }
  }
  return lines;
}

/*
 * Негодную ссылку убираем, а не правим: указатель источников нужен только для поиска
 * «откуда взялся предмет», и ссылка предмета на самого себя там ничего не значит.
 */
async function fixSources(found, { apply }) {
  const lines = [];
  const byItem = new Map();
  for (const entry of found) {
    if (!byItem.has(entry.item)) byItem.set(entry.item, []);
    byItem.get(entry.item).push(entry);
  }

  for (const [item, entries] of byItem) {
    lines.push(`${entries[0].where}: ${entries.map(e => `${e.field} = ${JSON.stringify(e.value)}`).join("; ")} → убрано`);
    if (!apply) continue;
    const data = {};
    for (const { field } of entries) {
      if (field === "flags.dnd5e.sourceId") data["flags.dnd5e.-=sourceId"] = null;
      else data[field] = null;
    }
    try {
      await item.update(data);
    } catch (err) {
      console.error("[fix-world-data] не вышло убрать ссылку", entries[0].where, err);
      lines.push(`${entries[0].where}: УБРАТЬ НЕ УДАЛОСЬ — ${err.message}`);
    }
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

async function fixBehaviors(found, { apply, removeBehaviors }) {
  const lines = [];
  for (const { scene, region, behavior, type, mod } of found) {
    const hint = mod ? ` — модуль «${mod.title ?? mod.id}» установлен, но выключен: проще включить его` : "";
    lines.push(`${scene.name} → регион «${region.name || region._id}»: поведение ${type}${hint}`);
    if (!apply || !removeBehaviors) continue;
    const live = scene.regions.get(region._id);
    if (live) await live.deleteEmbeddedDocuments("RegionBehavior", [behavior._id]);
    else lines.push(`${scene.name}: регион ${region._id} не загрузился, поведение не убрано`);
  }
  return lines;
}

/**
 * Проверить и (по желанию) починить.
 * @param {object} [options]
 * @param {boolean} [options.apply]             Чинить, а не только показывать
 * @param {boolean} [options.removeClassItems]  Снимать классовые предметы с NPC (необратимо)
 * @param {boolean} [options.removeBehaviors]   Убирать поведения регионов неизвестного типа (необратимо)
 */
export async function run({ apply = false, removeClassItems = false, removeBehaviors = false } = {}) {
  if (!game.user.isGM) {
    ui.notifications.warn("Чинить данные мира может только ГМ.");
    return null;
  }

  const effects = collectBrokenEffects();
  const sources = collectBrokenSources();
  const npcs = collectClassItemsOnNpcs();
  const behaviors = collectOrphanBehaviors();

  const report = {
    effects: await fixEffects(effects, { apply }),
    sources: await fixSources(sources, { apply }),
    npcs: await fixNpcs(npcs, { apply, removeClassItems }),
    behaviors: await fixBehaviors(behaviors, { apply, removeBehaviors }),
  };

  // Не верим себе на слово: после починки перечитываем данные и смотрим, что осталось
  report.left = apply ? [
    ...collectBrokenEffects().map(e => `${e.holder.where}, эффект «${e.source.name}»`),
    ...collectBrokenSources().map(s => `${s.where}, ссылка ${s.field}`),
  ] : [];

  const total = report.effects.length + report.sources.length + report.npcs.length + report.behaviors.length;
  const title = report.left.length ? "Починить удалось не всё"
    : apply ? "Данные мира починены" : "Проверка данных мира (ничего не меняли)";
  const section = (name, lines, note = "") => (lines.length
    ? `<p><strong>${name}</strong> — ${lines.length}${note}</p><ul>${lines.map(l => `<li>${l}</li>`).join("")}</ul>`
    : `<p><strong>${name}</strong> — чисто</p>`);

  const content = `<p><strong>${title}</strong></p>`
    + section("Изменения эффектов с негодным типом", report.effects, apply ? ", исправлено" : ", будет исправлено")
    + section("Ссылки на источник, которые Foundry не разбирает", report.sources,
      apply ? "" : ", будут убраны")
    + section("Классовые предметы на NPC", report.npcs,
      removeClassItems && apply ? ", сняты" : " — снимаются только с removeClassItems: true")
    + section("Поведения регионов неизвестного типа", report.behaviors,
      removeBehaviors && apply ? ", убраны" : " — убираются только с removeBehaviors: true")
    + (report.left.length
      ? `<p><strong>Осталось непочиненным — ${report.left.length}</strong>: правка не прижилась.`
        + `</p><ul>${report.left.map(l => `<li>${l}</li>`).join("")}</ul>`
      : "")
    + (apply ? "<p>Перезагрузите мир, чтобы Foundry перечитал документы.</p>" : "");

  await ChatMessage.create({ whisper: [game.user.id], content });
  console.log("[fix-world-data]", report);
  if (report.left.length) ui.notifications.warn(`${title}: осталось ${report.left.length}. Подробности в чате.`);
  else ui.notifications.info(total
    ? `${title}: записей ${total}. Подробности в чате.`
    : "Данные мира в порядке — чинить нечего.");
  return report;
}
