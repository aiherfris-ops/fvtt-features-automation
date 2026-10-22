import { LOG, MIGRATION_VERSION, MODULE_ID } from "./constants.js";
import { DAMAGE_BONUS_MACRO } from "./damage-bonus.js";
import { featById } from "./utils.js";

/*
 * Отчёт «что миграция сделала». Нужен, чтобы не гадать: прошла ли проверка данных,
 * у всех ли подключён общий макрос бонусов урона и легли ли правки в сами предметы.
 *
 * Запуск: featuresAutomation.report()            — по персонажам игроков
 *         featuresAutomation.report({ actors })  — по своему списку
 */

/** Точечные проверки: видно ли на листе результат миграции */
const CHECKS = [
  {
    label: "Ярость: преимущество на Силу",
    item: "rage",
    ok: item => (item.effects.contents[0]?.system?.changes ?? [])
      .some(change => change.key === "system.abilities.str.check.roll.mode"),
  },
  {
    label: "Опрометчивая атака: своя активность",
    item: "reckless-attack",
    ok: item => !!item.system.activities?.get?.("faRecklessUse000"),
  },
  {
    label: "Чувство опасности: эффект",
    item: "danger-sense",
    ok: item => item.effects.has("faDangerSense000"),
  },
  {
    label: "Turn Undead: эффект отдан автоматизации",
    item: "turn-undead",
    ok: item => (item.system.activities?.getByType?.("save")?.[0]?.effects ?? []).length === 0,
  },
  {
    label: "Вдохновение барда: эффект помечен",
    item: "bardic-inspiration",
    ok: item => item.effects.contents.some(effect => effect.getFlag(MODULE_ID, "bardicInspiration")),
  },
  {
    label: "Боевые искусства: кость монаха в безоружном ударе",
    item: "martial-arts",
    ok: (item, actor) => {
      const strike = actor.items.find(i => i.type === "weapon"
        && (i.system.identifier === "unarmed-strike" || /unarmed strike|безоружн/i.test(i.name)));
      return !strike || /@scale\.monk\./.test(strike.system.damage?.base?.custom?.formula ?? "");
    },
  },
  {
    label: "Patient Defense: состояние «уклонение»",
    item: "patient-defense",
    ok: item => item.effects.has("faDodgeEffect000"),
  },
];

const midiVersion = () => game.modules.get("midi-qol")?.version ?? "не найден";

/**
 * Собрать отчёт.
 * @param {object} [options]
 * @param {Actor[]} [options.actors]  По умолчанию — персонажи игроков
 * @param {boolean} [options.chat]    Шепнуть сводку в чат (по умолчанию да)
 */
export async function report({ actors = null, chat = true } = {}) {
  const registry = globalThis.featuresAutomation?.registry;
  const list = actors ?? game.actors.filter(actor => actor.type === "character" && actor.hasPlayerOwner);
  if (!list.length) {
    ui.notifications.warn("Персонажей игроков не нашлось — передайте список: report({ actors: [...] })");
    return null;
  }

  const rows = [];
  const problems = [];

  for (const actor of list) {
    const marks = actor.getFlag(MODULE_ID, "migrated") ?? {};
    const applicable = (registry?.enabled ?? []).filter(automation => {
      try { return registry.appliesTo(automation, actor); } catch (err) { return false; }
    });
    const done = applicable.filter(automation => (marks[automation.id] ?? 0) >= MIGRATION_VERSION);
    const pending = applicable.filter(automation => !done.includes(automation));

    const macro = (actor.getFlag("dnd5e", "DamageBonusMacro") ?? "").includes(DAMAGE_BONUS_MACRO);
    const macroNeeded = applicable.some(automation => ["paladin", "rogue", "weapon-mastery"].includes(automation.id));

    const checks = [];
    for (const check of CHECKS) {
      const item = featById(actor, check.item);
      if (!item) continue;
      checks.push({ label: check.label, ok: !!check.ok(item, actor) });
    }

    rows.push({
      Персонаж: actor.name,
      Автоматизаций: `${done.length}/${applicable.length}`,
      "Не помечено": pending.map(a => a.id).join(", ") || "—",
      "Макрос урона": macroNeeded ? (macro ? "есть" : "НЕТ") : "не нужен",
      "Правки данных": checks.length ? `${checks.filter(c => c.ok).length}/${checks.length}` : "—",
    });

    if (pending.length) problems.push(`${actor.name}: не помечены — ${pending.map(a => a.id).join(", ")}`);
    if (macroNeeded && !macro) problems.push(`${actor.name}: не подключён общий макрос бонусов урона`);
    for (const check of checks.filter(c => !c.ok)) problems.push(`${actor.name}: ${check.label} — не применено`);
  }

  console.log(`${LOG} отчёт о миграции (midi-qol ${midiVersion()}, версия миграций ${MIGRATION_VERSION})`);
  console.table(rows);
  if (problems.length) console.warn(`${LOG} требует внимания:\n` + problems.join("\n"));

  if (chat) {
    const head = `<p><strong>Проверка данных</strong> — персонажей ${list.length}, `
      + `midi-qol ${midiVersion()}.</p>`;
    const body = problems.length
      ? `<p class="notification warning">Не доделано (${problems.length}):</p><ul>`
        + problems.slice(0, 15).map(line => `<li>${line}</li>`).join("") + "</ul>"
      : "<p>Всё на месте: автоматизации помечены, правки в предметах применены"
        + ", общий макрос бонусов урона подключён.</p>";
    await ChatMessage.create({ whisper: [game.user.id], content: head + body });
  }

  return { rows, problems, midi: midiVersion() };
}
