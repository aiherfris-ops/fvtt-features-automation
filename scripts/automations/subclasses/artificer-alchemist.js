import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { isLongRest, removeTemporaryItems, temporaryFlags } from "../../core/temporary-items.js";
import { change, chat, featById, migrated, runAsync } from "../../core/utils.js";
import { onActivityUse } from "../../core/hooks.js";

/*
 * Изобретатель — Alchemist (Eberron: Forge of the Artificer, 2025), 3 уровень.
 * Experimental Elixir: после длинного отдыха — эликсиры по броску d6 (6 — выбор), за ячейку — эликсир на выбор.
 * Эликсир — расходуемый предмет: бонусное действие, выпить самому или дать существу в 5 футах.
 * Tools of the Trade: владение набором травника.
 */

const IDS = {
  slotElixir: "faElixirSlot0000",
  restElixirs: "faElixirRest0000",
};

const ELIXIRS = {
  healing: "Лечение",
  swiftness: "Скорость",
  resilience: "Стойкость",
  boldness: "Смелость",
  flight: "Полёт",
};
const ROLL_TABLE = ["healing", "swiftness", "resilience", "boldness", "flight"]; // 6 — выбор

const artificerLevel = actor => actor.classes?.artificer?.system?.levels ?? 0;
// Сколько эликсиров после длинного отдыха: 2, на 5 уровне 3, на 9 — 4, на 15 — 5
const restElixirCount = level => (level >= 15 ? 5 : level >= 9 ? 4 : level >= 5 ? 3 : 2);

/** Данные предмета-эликсира; числа зависят от уровня и Интеллекта создателя на момент создания */
function elixirData(creator, key, feature) {
  const level = artificerLevel(creator);
  const tier = level >= 15 ? 2 : level >= 9 ? 1 : 0;
  const int = creator.system.abilities.int?.mod ?? 0;
  const activityId = foundry.utils.randomID(16);
  const effectId = foundry.utils.randomID(16);

  const base = {
    _id: activityId,
    activation: { type: "bonus", value: 1, condition: "" },
    consumption: { targets: [{ type: "itemUses", value: "1", target: "" }], spellSlot: false },
    range: { units: "ft", value: "5" },
    target: { affects: { type: "creature", count: "1" }, prompt: true },
  };
  const effect = (seconds, changes, description) => ({
    _id: effectId, name: `Эликсир: ${ELIXIRS[key]}`, img: feature.img, transfer: false,
    duration: { value: seconds, units: "seconds" }, description, system: { changes },
  });

  let activity;
  let effects = [];
  let text;
  switch (key) {
    case "healing": {
      const formula = `${2 + tier}d8 + ${int}`;
      activity = { ...base, type: "heal", name: "Выпить", healing: { custom: { enabled: true, formula }, types: ["healing"] } };
      text = `Выпивший восстанавливает ${formula} хитов.`;
      break;
    }
    case "swiftness": {
      const bonus = [10, 15, 20][tier];
      effects = [effect(3600, [change("system.attributes.movement.bonus", "add", `+ ${bonus}`)], `<p>Скорость +${bonus} футов.</p>`)];
      text = `Скорость выпившего увеличивается на ${bonus} футов на 1 час.`;
      break;
    }
    case "resilience": {
      const seconds = [600, 3600, 28800][tier];
      effects = [effect(seconds, [change("system.attributes.ac.bonus", "add", "+ 1")], "<p>КД +1.</p>")];
      text = `Выпивший получает +1 к КД на ${["10 минут", "1 час", "8 часов"][tier]}.`;
      break;
    }
    case "boldness": {
      const seconds = [60, 600, 3600][tier];
      const bonus = "+ 1d4";
      effects = [effect(seconds, [
        ...["mwak", "rwak", "msak", "rsak"].map(k => change(`system.bonuses.${k}.attack`, "add", bonus)),
        change("system.bonuses.abilities.save", "add", bonus),
      ], "<p>+1d4 к броскам атаки и спасброскам.</p>")];
      text = `Выпивший добавляет 1d4 к броскам атаки и спасброскам на ${["1 минуту", "10 минут", "1 час"][tier]}.`;
      break;
    }
    case "flight": {
      const fly = [10, 20, 30][tier];
      effects = [effect(600, [change("system.attributes.movement.fly", "upgrade", fly)], `<p>Скорость полёта ${fly} футов.</p>`)];
      text = `Выпивший получает скорость полёта ${fly} футов на 10 минут.`;
      break;
    }
  }
  activity ??= { ...base, type: "utility", name: "Выпить", effects: [{ _id: effectId }] };

  return {
    name: `Экспериментальный эликсир: ${ELIXIRS[key]}`,
    type: "consumable",
    img: feature.img,
    system: {
      type: { value: "potion" },
      description: { value: `<p>${text}</p><p><em>Бонусным действием выпить или дать существу в 5 футах. `
        + `Исчезает после длинного отдыха создателя (${creator.name}).</em></p>` },
      quantity: 1,
      weight: { value: 0, units: "lb" },
      uses: { spent: 0, max: "1", autoDestroy: true, recovery: [] },
      activities: { [activityId]: activity },
    },
    effects,
    flags: temporaryFlags(creator, "elixir"),
  };
}

async function chooseElixir(title) {
  return foundry.applications.api.DialogV2.prompt({
    window: { title },
    content: `<select name="elixir">${Object.entries(ELIXIRS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>`,
    ok: { label: "Выбрать", callback: (event, button) => button.form.elements.elixir.value },
    rejectClose: false,
  });
}

async function createElixirs(actor, keys, reason) {
  const feature = featById(actor, "experimental-elixir");
  await actor.createEmbeddedDocuments("Item", keys.map(key => elixirData(actor, key, feature)));
  await chat(actor, `<p><strong>${actor.name}</strong> создаёт эликсиры (${reason}): `
    + keys.map(k => ELIXIRS[k]).join(", ") + ".</p>");
}

/** Эликсиры после длинного отдыха: старые исчезают в любом случае, новые — по броску d6 */
async function restElixirs(actor) {
  const removed = await removeTemporaryItems(actor, "elixir");
  if (removed) await chat(actor, `<p>Оставшиеся эликсиры ${actor.name} (${removed}) исчезают.</p>`);

  const count = restElixirCount(artificerLevel(actor));
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Experimental Elixir" },
    content: `<p>Создать ${count} эликсира(ов) после длинного отдыха? Нужны инструменты алхимика в руках.</p>`,
    rejectClose: false,
  });
  if (!confirmed) return;

  const keys = [];
  for (let i = 0; i < count; i++) {
    const roll = await new Roll("1d6").evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `Experimental Elixir №${i + 1}` });
    const key = roll.total <= 5 ? ROLL_TABLE[roll.total - 1] : await chooseElixir(`Эликсир №${i + 1}: выпала 6 — выберите`);
    if (key) keys.push(key);
  }
  if (keys.length) await createElixirs(actor, keys, "длинный отдых");
}

export default {
  id: "artificer-alchemist",
  kind: "subclass",
  label: "Изобретатель — Alchemist",
  hint: "Experimental Elixir: эликсиры после длинного отдыха и за ячейку; Tools of the Trade: набор травника.",
  identifiers: ["experimental-elixir", "tools-of-the-trade"],

  async migrate(actor) {
    // Experimental Elixir: вместо лечения 2d8 — создание эликсиров
    const elixir = featById(actor, "experimental-elixir");
    if (elixir && !migrated(elixir, "elixirMigrated")) {
      const updates = {
        [`system.activities.${IDS.slotElixir}`]: {
          _id: IDS.slotElixir,
          type: "utility",
          name: "Создать эликсир за ячейку",
          activation: { type: "action", value: 1, condition: "", override: false },
          consumption: {
            targets: [{ type: "spellSlots", value: "1", target: "1", scaling: { mode: "level" } }],
            spellSlot: false,
            scaling: { allowed: true, max: "5" },
          },
          range: { units: "self", override: false },
          target: { affects: { type: "self" }, prompt: false, override: false },
          roll: { prompt: false, visible: false },
        },
        [`system.activities.${IDS.restElixirs}`]: {
          _id: IDS.restElixirs,
          type: "utility",
          name: "Создать эликсиры после длинного отдыха",
          activation: { type: "special", value: null, condition: "Сразу после длинного отдыха", override: false },
          consumption: { targets: [], spellSlot: false, scaling: { allowed: false } },
          range: { units: "self", override: false },
          target: { affects: { type: "self" }, prompt: false, override: false },
          roll: { prompt: false, visible: false },
        },
        [`flags.${MODULE_ID}.elixirMigrated`]: MIGRATION_VERSION,
      };
      for (const activity of elixir.system.activities) {
        if (![IDS.slotElixir, IDS.restElixirs].includes(activity.id)) updates[`system.activities.-=${activity.id}`] = null;
      }
      await elixir.update(updates);
      console.log(`${LOG} Experimental Elixir у ${actor.name}: создание эликсиров`);
    }

    // Tools of the Trade: инструменты алхимика и набор травника
    const tools = featById(actor, "tools-of-the-trade");
    if (tools && !migrated(tools, "toolsMigrated")) {
      const updates = {};
      if (!actor.system.tools?.alchemist?.value) updates["system.tools.alchemist"] = { value: 1, ability: "int" };
      if (!actor.system.tools?.herb?.value) updates["system.tools.herb"] = { value: 1, ability: "wis" };
      if (Object.keys(updates).length) await actor.update(updates);
      await tools.setFlag(MODULE_ID, "toolsMigrated", MIGRATION_VERSION);
      console.log(`${LOG} Tools of the Trade у ${actor.name}: владение инструментами`);
    }
  },

  register() {
    onActivityUse(IDS.slotElixir, (activity) => runAsync("Experimental Elixir", async () => {
      const key = await chooseElixir("Эликсир за ячейку");
      if (key) await createElixirs(activity.item.actor, [key], "за ячейку заклинания");
    }));
    onActivityUse(IDS.restElixirs, (activity) =>
      runAsync("Experimental Elixir", () => restElixirs(activity.item.actor)));

    Hooks.on("dnd5e.restCompleted", (actor, result, config) => {
      if (!isLongRest(result, config) || !featById(actor, "experimental-elixir") || !actor.isOwner) return;
      runAsync("Experimental Elixir: отдых", () => restElixirs(actor));
    });
  },
};
