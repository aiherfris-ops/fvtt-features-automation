import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { onActivityUse } from "../../core/hooks.js";
import { change, chat, featById, runAsync } from "../../core/utils.js";

/*
 * Черта Altered (Crooked Moon 2024): одно усиление на выбор.
 *   Aquatic Adaptation — дыхание под водой, скорость плавания = скорости ходьбы;
 *   Natural Armor      — КД 13 + мод. Ловкости или Телосложения (берётся больший);
 *   Natural Weapons    — безоружный удар 1d8 (дробящий, колющий или рубящий);
 *   Night Vision       — тёмное зрение 60 футов или +30, если оно уже есть.
 * Plutonium не сохраняет выбор, поэтому у черты появляется действие «Выбрать усиление»;
 * выбор хранится флагом на предмете, эффект пересоздаётся при смене.
 */

const IDS = {
  choose: "faAlteredChoose0",
  effect: "faAlteredEffect0",
  weapon: "faAlteredWeapon0",
};

const OPTIONS = {
  "natural-armor": "Natural Armor",
  "aquatic-adaptation": "Aquatic Adaptation",
  "natural-weapons": "Natural Weapons",
  "night-vision": "Night Vision",
};

// Выборы, известные со слов игроков (актёр → усиление); остальные выбираются действием на черте
const NATURAL_ARMOR_FORMULA = "13 + max(@abilities.dex.mod, @abilities.con.mod)";

const KNOWN_CHOICES = {
  "Actor.CMMOw4EgcrRO56zZ": "natural-armor", // Вайлор Морн
};

async function applyChoice(feat, choice, { damageType = "bludgeoning" } = {}) {
  const actor = feat.actor;
  const updates = { [`flags.${MODULE_ID}.alteredChoice`]: choice };
  if (feat.system.activities.has(IDS.weapon) && choice !== "natural-weapons") updates[`system.activities.-=${IDS.weapon}`] = null;

  let changes = [];
  let description = "";
  switch (choice) {
    case "natural-armor":
      // Формула КД пишется прямо в актёра: строку с @-ссылками в эффекте DAE подставил бы значениями.
      // Mage Armor при этом по-прежнему переопределяет расчёт на время действия; щит добавляется как обычно.
      await actor.update({ "system.attributes.ac.calc": "custom", "system.attributes.ac.formula": NATURAL_ARMOR_FORMULA });
      break;
    case "aquatic-adaptation":
      changes = [change("system.attributes.movement.swim", "override", "@attributes.movement.walk")];
      description = "<p>Дыхание под водой; скорость плавания равна скорости ходьбы.</p>";
      break;
    case "night-vision": {
      const current = Number(actor.system.attributes.senses?.ranges?.darkvision) || 0;
      changes = [current > 0
        ? change("system.attributes.senses.ranges.darkvision", "add", 30)
        : change("system.attributes.senses.ranges.darkvision", "upgrade", 60)];
      description = current > 0 ? "<p>Тёмное зрение +30 футов.</p>" : "<p>Тёмное зрение 60 футов.</p>";
      break;
    }
    case "natural-weapons":
      updates[`system.activities.${IDS.weapon}`] = {
        _id: IDS.weapon,
        type: "attack",
        name: "Природное оружие",
        activation: { type: "action", value: 1, condition: "", override: false },
        consumption: { targets: [], spellSlot: false, scaling: { allowed: false } },
        range: { units: "ft", value: "5", override: false },
        target: { affects: { type: "creature", count: "1" }, prompt: true, override: false },
        attack: { ability: "str", bonus: "@prof", flat: false, type: { value: "melee", classification: "unarmed" } },
        damage: { includeBase: false, parts: [{ number: 1, denomination: 8, bonus: "@mod", types: [damageType],
          custom: { enabled: false, formula: "" }, scaling: { mode: "", number: 1 } }] },
      };
      description = "<p>Безоружный удар природным оружием: 1d8 + Сила.</p>";
      break;
  }

  const ac = actor.system.attributes.ac;
  if (choice !== "natural-armor" && ac.calc === "custom" && ac.formula === NATURAL_ARMOR_FORMULA) {
    await actor.update({ "system.attributes.ac.calc": "default", "system.attributes.ac.formula": "" });
  }
  await feat.update(updates);
  const existing = feat.effects.get(IDS.effect);
  if (existing) await existing.delete();
  if (changes.length) {
    await feat.createEmbeddedDocuments("ActiveEffect", [{
      _id: IDS.effect,
      name: `Altered: ${OPTIONS[choice]}`,
      img: feat.img,
      transfer: true,
      description,
      system: { changes },
    }], { keepId: true });
  }
  console.log(`${LOG} Altered у ${actor.name}: ${OPTIONS[choice]}`);
}

async function chooseOption(activity) {
  const feat = activity.item;
  const current = feat.getFlag(MODULE_ID, "alteredChoice");
  const picked = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Altered: усиление" },
    content: `<select name="choice" style="width:100%">${Object.entries(OPTIONS)
      .map(([v, l]) => `<option value="${v}" ${v === current ? "selected" : ""}>${l}</option>`).join("")}</select>`
      + '<p style="margin-top:.5em">Тип урона природного оружия: <select name="type">'
      + ["bludgeoning", "piercing", "slashing"].map(t => `<option value="${t}">${CONFIG.DND5E.damageTypes[t]?.label ?? t}</option>`).join("")
      + "</select></p>",
    ok: { label: "Выбрать", callback: (event, button) => ({ choice: button.form.elements.choice.value, type: button.form.elements.type.value }) },
    rejectClose: false,
  });
  if (!picked) return;
  await applyChoice(feat, picked.choice, { damageType: picked.type });
  await chat(feat.actor, `<p><strong>${feat.actor.name}</strong>: Altered — <b>${OPTIONS[picked.choice]}</b>.</p>`);
}

export default {
  id: "altered",
  kind: "feat",
  label: "Altered",
  hint: "Действие «Выбрать усиление» и эффект выбранного варианта: Natural Armor, Aquatic Adaptation, Natural Weapons, Night Vision.",
  identifiers: ["altered"],

  async migrate(actor) {
    const feat = featById(actor, "altered");
    if (!feat) return;
    if (!feat.system.activities.has(IDS.choose)) {
      const updates = {
        [`system.activities.${IDS.choose}`]: {
          _id: IDS.choose,
          type: "utility",
          name: "Выбрать усиление",
          activation: { type: "special", value: null, condition: "При получении черты", override: false },
          consumption: { targets: [], spellSlot: false, scaling: { allowed: false } },
          range: { units: "self", override: false },
          target: { affects: { type: "self" }, prompt: false, override: false },
          roll: { prompt: false, visible: false },
        },
        [`flags.${MODULE_ID}.alteredMigrated`]: MIGRATION_VERSION,
      };
      // Бросок 1d8 без типа урона от Plutonium заменяет атака природным оружием, если её выберут
      for (const activity of feat.system.activities) {
        if (activity.type === "damage") updates[`system.activities.-=${activity.id}`] = null;
      }
      await feat.update(updates);
    }
    const known = KNOWN_CHOICES[actor.uuid];
    if (known && !feat.getFlag(MODULE_ID, "alteredChoice")) await applyChoice(feat, known);
  },

  register() {
    onActivityUse(IDS.choose, (activity) => runAsync("Altered", () => chooseOption(activity)));
  },
};
