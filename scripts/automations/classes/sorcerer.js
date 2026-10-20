import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { change, chat, damageTypeLabel, featById, migrated, runAsync } from "../../core/utils.js";
import { onItemUse, onPreDamageRoll } from "../../core/hooks.js";

/**
 * Чародей 2024: Innate Sorcery, Font of Magic, Metamagic (Quickened, Transmuted).
 * После заклинания чародея, сотворённого с тратой ячейки, вызывается хук
 * `featuresAutomation.sorcererSlotSpell({ actor, item, activity })` — на него подписываются подклассы.
 * Флаг актёра `features-automation.transmute` также читает spell-automation (лучевые заклинания).
 */

export const SORCERER_SLOT_SPELL_HOOK = "featuresAutomation.sorcererSlotSpell";
export const TRANSMUTE_TYPES = ["acid", "cold", "fire", "lightning", "poison", "thunder"];
// Font of Magic 2024: стоимость создания ячейки и минимальный уровень чародея
const SLOT_COST = { 1: [2, 2], 2: [3, 3], 3: [5, 5], 4: [6, 7], 5: [7, 9] };

const sorceryPoints = actor => {
  const item = featById(actor, "sorcery-points");
  if (!item) return null;
  const max = Number(item.system.uses?.max) || 0;
  const spent = item.system.uses?.spent ?? 0;
  return { item, max, spent, value: Math.max(0, max - spent) };
};

/* Font of Magic */

async function pointsToSlot(actor) {
  const points = sorceryPoints(actor);
  const sorcererLevel = actor.classes?.sorcerer?.system?.levels ?? 0;
  if (!points) return ui.notifications.warn(`${actor.name}: нет умения Sorcery Points.`);
  const options = Object.entries(SLOT_COST)
    .filter(([, [cost, minLevel]]) => sorcererLevel >= minLevel && points.value >= cost)
    .map(([level, [cost]]) => `<option value="${level}">Ячейка ${level} ур. — ${cost} ОЧ</option>`);
  if (!options.length) return ui.notifications.warn(`${actor.name}: не хватает очков чародейства (${points.value}).`);
  const level = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Font of Magic: создать ячейку" },
    content: `<p>Очки чародейства: <strong>${points.value}/${points.max}</strong></p>`
      + `<select name="level">${options.join("")}</select>`,
    ok: { label: "Создать", callback: (event, button) => Number(button.form.elements.level.value) },
    rejectClose: false,
  });
  if (!level) return;
  const cost = SLOT_COST[level][0];
  const slot = actor.system.spells[`spell${level}`];
  await points.item.update({ "system.uses.spent": points.spent + cost });
  await actor.update({ [`system.spells.spell${level}.value`]: (slot?.value ?? 0) + 1 });
  await chat(actor, `<p><strong>${actor.name}</strong> превращает ${cost} очк. чародейства в ячейку ${level} уровня `
    + `(осталось очков: ${points.value - cost}). Созданная ячейка исчезнет после длинного отдыха.</p>`);
}

async function slotToPoints(actor) {
  const points = sorceryPoints(actor);
  if (!points) return ui.notifications.warn(`${actor.name}: нет умения Sorcery Points.`);
  const room = points.spent;
  const options = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    .filter(level => (actor.system.spells[`spell${level}`]?.value ?? 0) > 0)
    .map(level => `<option value="${level}">Ячейка ${level} ур. (есть ${actor.system.spells[`spell${level}`].value}) → +${Math.min(level, room)} ОЧ</option>`);
  if (!options.length) return ui.notifications.warn(`${actor.name}: нет свободных ячеек.`);
  if (!room) return ui.notifications.warn(`${actor.name}: очки чародейства уже полные (${points.value}/${points.max}).`);
  const level = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Font of Magic: ячейка в очки" },
    content: `<p>Очки чародейства: <strong>${points.value}/${points.max}</strong>. Сверх максимума очки не накапливаются.</p>`
      + `<select name="level">${options.join("")}</select>`,
    ok: { label: "Превратить", callback: (event, button) => Number(button.form.elements.level.value) },
    rejectClose: false,
  });
  if (!level) return;
  const gained = Math.min(level, room);
  await actor.update({ [`system.spells.spell${level}.value`]: actor.system.spells[`spell${level}`].value - 1 });
  await points.item.update({ "system.uses.spent": points.spent - gained });
  await chat(actor, `<p><strong>${actor.name}</strong> тратит ячейку ${level} уровня и получает ${gained} очк. чародейства `
    + `(теперь ${points.value + gained}/${points.max}).</p>`);
}

/* Metamagic */

async function chooseTransmute(actor) {
  const to = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Transmuted Spell" },
    content: `<p>Урон следующего заклинания (кислота, холод, огонь, электричество, яд, звук) станет:</p>`
      + `<select name="to">${TRANSMUTE_TYPES.map(t => `<option value="${t}">${damageTypeLabel(t)}</option>`).join("")}</select>`,
    ok: { label: "Выбрать", callback: (event, button) => button.form.elements.to.value },
    rejectClose: false,
  });
  if (!to) return;
  await actor.setFlag(MODULE_ID, "transmute", to);
  await chat(actor, `<p><strong>${actor.name}</strong>: Transmuted Spell — урон следующего заклинания станет «${damageTypeLabel(to)}».</p>`);
}

async function quicken(actor) {
  await actor.setFlag(MODULE_ID, "quickened", true);
  await chat(actor, `<p><strong>${actor.name}</strong>: Quickened Spell — следующее заклинание со временем накладывания `
    + `«действие» накладывается бонусным действием. В этот ход нельзя накладывать другие заклинания 1+ уровня.</p>`);
}

export default {
  id: "sorcerer",
  kind: "class",
  label: "Чародей",
  hint: "Innate Sorcery, Font of Magic (обмен ячеек и очков), Metamagic: Quickened и Transmuted Spell.",
  identifiers: ["innate-sorcery", "font-of-magic", "sorcery-points", "metamagic-quickened-spell", "metamagic-transmuted-spell"],

  async migrate(actor) {
    // Innate Sorcery: в эффекте только +1 к СЛ — добавляем преимущество на атаки заклинаниями
    const innate = featById(actor, "innate-sorcery");
    if (innate && !migrated(innate, "innateMigrated")) {
      for (const effect of innate.effects) {
        const changes = foundry.utils.deepClone(effect.system.changes ?? []);
        for (const key of ["flags.midi-qol.advantage.attack.msak", "flags.midi-qol.advantage.attack.rsak"]) {
          if (!changes.some(c => c.key === key)) changes.push(change(key, "override", "1"));
        }
        await effect.update({ "system.changes": changes });
      }
      await innate.setFlag(MODULE_ID, "innateMigrated", MIGRATION_VERSION);
      console.log(`${LOG} Innate Sorcery у ${actor.name}: преимущество на атаки заклинаниями`);
    }

    // Font of Magic: формулы импорта считают стоимость неверно — расчёт делает диалог модуля
    const font = featById(actor, "font-of-magic");
    if (font && !migrated(font, "fontMigrated")) {
      const updates = { [`flags.${MODULE_ID}.fontMigrated`]: MIGRATION_VERSION };
      for (const activity of font.system.activities) {
        updates[`system.activities.${activity.id}.consumption`] = { targets: [], spellSlot: false, scaling: { allowed: false } };
      }
      await font.update(updates);
      console.log(`${LOG} Font of Magic у ${actor.name}: обмен через диалог`);
    }
  },

  register() {
    // Диалоги Font of Magic и Metamagic
    // Активности Font of Magic: dnd5eactivity000 — Regain Spell Slot, dnd5eactivity001 — Regain Sorcery Points;
    // у самодельных копий решаем по имени (английскому или русскому)
    const toPoints = activity => activity.id === "dnd5eactivity001"
      || (activity.id !== "dnd5eactivity000" && /point|очк/i.test(activity.name ?? ""));
    onItemUse("font-of-magic", (activity) => runAsync(activity.item.name, () => (toPoints(activity)
      ? slotToPoints(activity.item.actor) : pointsToSlot(activity.item.actor))));
    onItemUse("metamagic-transmuted-spell", (activity) =>
      runAsync(activity.item.name, () => chooseTransmute(activity.item.actor)));
    onItemUse("metamagic-quickened-spell", (activity) =>
      runAsync(activity.item.name, () => quicken(activity.item.actor)));

    // Заклинание сотворено: Quickened расходуется, подклассы узнают о касте с ячейкой.
    // У заклинаний разные идентификаторы, поэтому здесь нужен общий хук, а не адресный
    Hooks.on("dnd5e.postUseActivity", (activity, usageConfig) => {
      const item = activity?.item;
      const actor = item?.actor;
      if (!actor || item.type !== "spell") return;
      if (actor.getFlag(MODULE_ID, "quickened")) actor.unsetFlag(MODULE_ID, "quickened");

      const usedSlot = (item.system.level ?? 0) > 0 && item.system.method === "spell"
        && activity.consumption?.spellSlot && usageConfig?.consume?.spellSlot !== false;
      if (usedSlot && actor.classes?.sorcerer) Hooks.callAll(SORCERER_SLOT_SPELL_HOOK, { actor, item, activity });
    });

    // Transmuted Spell: меняем тип урона в следующем броске урона заклинания
    onPreDamageRoll((config) => {
      const item = config?.subject?.item;
      const actor = item?.actor;
      const to = actor?.getFlag(MODULE_ID, "transmute");
      if (!to || item.type !== "spell") return;
      let changed = false;
      for (const roll of config.rolls ?? []) {
        const options = roll.options ?? {};
        if (TRANSMUTE_TYPES.includes(options.type)) {
          options.type = to;
          options.types = [to];
          changed = true;
        }
      }
      if (changed) setTimeout(() => actor.unsetFlag(MODULE_ID, "transmute"), 0);
    });
  },
};
