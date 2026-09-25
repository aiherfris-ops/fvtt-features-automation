import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { change, featById, migrated, runAsync, turnKey } from "../../core/utils.js";
import { SORCERER_SLOT_SPELL_HOOK } from "../classes/sorcerer.js";

/* Чародей — Wild Magic (PHB 2024), 3 уровень: Wild Magic Surge, Tides of Chaos */

const IDS = {
  tidesUse: "faTidesOfChaos00",
  tidesEffect: "faTidesEffect000",
};

/** Таблица 2024 берётся из описания умения (таблица мира — из PHB 2014, и у игроков нет к ней доступа) */
function surgeTable(feature) {
  const html = feature?.system.description?.value ?? "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("td[data-roll-min]")].map(td => ({
    min: Number(td.dataset.rollMin),
    max: Number(td.dataset.rollMax),
    label: td.textContent.trim(),
    text: td.nextElementSibling?.innerHTML ?? "",
  }));
}

async function rollSurge(actor, reason) {
  const table = surgeTable(featById(actor, "wild-magic-surge"));
  const roll = await new Roll("1d100").evaluate();
  const row = table.find(r => roll.total >= r.min && roll.total <= r.max);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    rolls: [roll],
    flavor: `Wild Magic Surge — ${reason}`,
    content: row
      ? `<p><strong>${row.label}</strong>: ${row.text}</p>`
      : `<p>Результат ${roll.total}: строка не найдена в описании умения — посмотрите таблицу вручную.</p>`,
  });
}

async function onSlotSpell({ actor, item }) {
  if (!featById(actor, "wild-magic-surge")) return;

  // Tides of Chaos потрачен: всплеск автоматически, умение восстанавливается
  const tides = featById(actor, "tides-of-chaos");
  if (tides && (tides.system.uses?.spent ?? 0) > 0) {
    await tides.update({ "system.uses.spent": 0 });
    await rollSurge(actor, `${item.name} после Tides of Chaos (Tides of Chaos восстановлен)`);
    return;
  }

  const key = turnKey();
  if (key && actor.getFlag(MODULE_ID, "surgeChecked") === key) return;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Wild Magic Surge" },
    content: `<p>Бросить d20 на всплеск дикой магии после «${item.name}»? На 20 — бросок по таблице.</p>`
      + `<p><em>Раз в ход.</em></p>`,
    rejectClose: false,
  });
  if (!confirmed) return;
  if (key) await actor.setFlag(MODULE_ID, "surgeChecked", key);
  const d20 = await new Roll("1d20").evaluate();
  await d20.toMessage({ speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `Wild Magic Surge: проверка (${d20.total === 20 ? "всплеск!" : "без всплеска"})` });
  if (d20.total === 20) await rollSurge(actor, item.name);
}

export default {
  id: "sorcerer-wild-magic",
  kind: "subclass",
  label: "Чародей — Wild Magic",
  hint: "Wild Magic Surge (таблица 2024 из описания), Tides of Chaos с автоматическим всплеском.",
  identifiers: ["wild-magic-surge", "tides-of-chaos"],

  // Tides of Chaos: в импорте нет ни одной активности
  async migrate(actor) {
    const tides = featById(actor, "tides-of-chaos");
    if (!tides || migrated(tides, "tidesMigrated")) return;
    await tides.update({
      [`system.activities.${IDS.tidesUse}`]: {
        _id: IDS.tidesUse,
        type: "utility",
        name: "Преимущество на следующий бросок d20",
        activation: { type: "special", value: null, condition: "Перед броском d20", override: false },
        consumption: { targets: [{ type: "itemUses", value: "1", target: "", scaling: {} }], spellSlot: false,
          scaling: { allowed: false } },
        range: { units: "self", override: false },
        target: { affects: { type: "self" }, prompt: false, override: false },
        effects: [{ _id: IDS.tidesEffect }],
        roll: { prompt: false, visible: false },
      },
      [`flags.${MODULE_ID}.tidesMigrated`]: MIGRATION_VERSION,
    });
    if (!tides.effects.has(IDS.tidesEffect)) {
      await tides.createEmbeddedDocuments("ActiveEffect", [{
        _id: IDS.tidesEffect,
        name: "Tides of Chaos",
        img: tides.img,
        transfer: false,
        duration: { value: 60, units: "seconds" },
        description: "<p>Преимущество на следующий тест d20 (атака, спасбросок или проверка).</p>",
        system: { changes: [change("flags.midi-qol.advantage.all", "override", "1")] },
        flags: { dae: { stackable: "noneName", specialDuration: ["1Attack", "isSave", "isCheck", "isSkill", "isInitiative"] } },
      }], { keepId: true });
    }
    console.log(`${LOG} Tides of Chaos у ${actor.name}: активность с преимуществом`);
  },

  register() {
    Hooks.on(SORCERER_SLOT_SPELL_HOOK, (payload) => runAsync("Wild Magic Surge", () => onSlotSpell(payload)));
  },
};
