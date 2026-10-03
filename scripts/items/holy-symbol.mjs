import { LOG, MODULE_ID } from "../core/constants.js";

/*
 * «Символ непреклонного света» — священный символ жреца против потустороннего, сделанный по образцу
 * Книги целителя: предмет с зарядами, который творит заклинания, и при этом остаётся фокусировкой.
 *
 * Отличие от книги: заряды не кончаются навсегда, а возвращаются на рассвете, и у символа есть
 * четвёртая способность — расширить Turn Undead на исчадий и аберраций. Она не текстом, а делом:
 * автоматизация жреца (automations/classes/cleric.js) видит флаг `turnAlsoAffects` и предлагает
 * потратить заряд ровно тогда, когда среди проваливших спасбросок есть такие существа.
 *
 * Создать: featuresAutomation.createHolySymbol()            — в предметы мира
 *          featuresAutomation.createHolySymbol({ actor })   — сразу жрецу
 */

export const HOLY_SYMBOL_NAME = "Символ непреклонного света";

/** Заклинания символа: ключ → как его искать */
const SPELLS = {
  protection: { identifiers: ["protection-from-evil-and-good"], names: ["Protection from Evil and Good", "Защита от зла и добра"] },
  circle: { identifiers: ["magic-circle"], names: ["Magic Circle", "Магический круг"] },
  dispel: { identifiers: ["dispel-evil-and-good"], names: ["Dispel Evil and Good", "Изгнание зла и добра"] },
};

const norm = s => String(s ?? "").toLowerCase().trim();

/** Найти заклинание в мире или компендиумах */
async function findSpell({ identifiers, names }) {
  const wantedIds = identifiers.map(norm);
  const wantedNames = names.map(norm);
  const matches = entry => wantedIds.includes(norm(entry.system?.identifier)) || wantedNames.includes(norm(entry.name));

  const local = game.items.find(item => item.type === "spell" && matches(item));
  if (local) return local.uuid;

  // Сначала мировые компендиумы: там лежит перевод, если он есть
  const packs = [...game.packs.filter(pack => pack.documentName === "Item")]
    .sort((a, b) => Number(b.collection.startsWith("world.")) - Number(a.collection.startsWith("world.")));
  for (const pack of packs) {
    let index;
    try { index = await pack.getIndex({ fields: ["system.identifier", "type"] }); }
    catch (err) { continue; }
    const found = [...index].find(entry => entry.type === "spell" && matches(entry));
    if (found) return found.uuid;
  }
  return null;
}

const castActivity = (id, label, cost, uuid) => [id, {
  _id: id,
  type: uuid ? "cast" : "utility",
  name: `${label} (${cost} зар.)`,
  activation: { type: "action", value: 1, override: true },
  consumption: {
    targets: [{ type: "itemUses", value: String(cost), target: "", scaling: {} }],
    spellSlot: false, scaling: { allowed: false },
  },
  ...(uuid ? { spell: { uuid, challenge: {}, level: null, properties: ["vocal", "somatic"], spellbook: false } } : {}),
  description: { chatFlavor: uuid ? "" : `Прочитайте «${label.toLowerCase()}» с символа.` },
}];

const DESCRIPTION = `<p><em>Чудесный предмет (священный символ, требует настройки жрецом), редкий</em></p>
<p>Тяжёлый символ из белого металла, тёплый на ощупь даже в стылом подземелье. В руках жреца он
служит обычной священной фокусировкой, но против того, что пришло из-за грани, раскрывается иначе.</p>
<p>У символа 7 зарядов. На рассвете он восстанавливает [[/r 1d6 + 1]] зарядов.</p>
<ul>
  <li><strong>1 заряд:</strong> защита от зла и добра;</li>
  <li><strong>2 заряда:</strong> магический круг;</li>
  <li><strong>3 заряда:</strong> изгнание зла и добра;</li>
  <li><strong>1 заряд:</strong> <em>Свет против потустороннего</em> — когда вы обращаете нежить,
    действие распространяется и на исчадий с аберрациями в том же радиусе и с тем же спасброском.</li>
</ul>
<p>Если потратить последний заряд, символ тускнеет до рассвета, но остаётся обычной фокусировкой
и священным символом.</p>`;

/**
 * Создать предмет.
 * @param {object} [options]
 * @param {Actor} [options.actor]  Кому выдать; без него предмет уходит в предметы мира
 * @param {string} [options.name]
 * @returns {Promise<Item|null>}
 */
export async function createHolySymbol({ actor = null, name = HOLY_SYMBOL_NAME } = {}) {
  if (!game.user.isGM) {
    ui.notifications.warn("Создать предмет может только ГМ.");
    return null;
  }
  const existing = actor ? actor.items.getName(name) : game.items.getName(name);
  if (existing) {
    ui.notifications.info(`«${name}» уже есть.`);
    return existing;
  }

  const uuids = {
    protection: await findSpell(SPELLS.protection),
    circle: await findSpell(SPELLS.circle),
    dispel: await findSpell(SPELLS.dispel),
  };

  const data = {
    name,
    type: "equipment",
    img: "icons/magic/holy/symbol-sun-gold.webp",
    system: {
      type: { value: "trinket" },
      rarity: "rare",
      attunement: "required",
      identifier: "symbol-of-unyielding-light",
      price: { value: 3500, denomination: "gp" },
      weight: { value: 1, units: "lb" },
      // foc — фокусировка для заклинаний, mgc — магический предмет
      properties: ["foc", "mgc"],
      uses: {
        max: "7",
        spent: 0,
        recovery: [{ period: "dawn", type: "formula", formula: "1d6 + 1" }],
      },
      description: { value: DESCRIPTION },
      activities: Object.fromEntries([
        castActivity("faSymbolProtect0", "Защита от зла и добра", 1, uuids.protection),
        castActivity("faSymbolCircle00", "Магический круг", 2, uuids.circle),
        castActivity("faSymbolDispel00", "Изгнание зла и добра", 3, uuids.dispel),
        ["faSymbolTurn0000", {
          _id: "faSymbolTurn0000",
          type: "utility",
          name: "Свет против потустороннего (1 зар.)",
          activation: { type: "special", override: true },
          consumption: { targets: [], spellSlot: false, scaling: { allowed: false } },
          description: {
            chatFlavor: "Заряд тратится сам, когда вы обращаете нежить и среди провалившихся есть "
              + "исчадия или аберрации.",
          },
        }],
      ]),
    },
    flags: {
      [MODULE_ID]: {
        // Автоматизация жреца читает этот флаг при обращении нежити
        turnAlsoAffects: ["fiend", "aberration"],
      },
    },
  };

  const [item] = actor
    ? await actor.createEmbeddedDocuments("Item", [data])
    : [await Item.implementation.create(data)];
  const missing = Object.entries(uuids).filter(([, uuid]) => !uuid).map(([key]) => key);
  if (missing.length) {
    console.warn(`${LOG} символ: не нашлись заклинания (${missing.join(", ")}) — остались заметками`);
    ui.notifications.warn(`«${name}» создан, но заклинания ${missing.join(", ")} не найдены — впишите вручную.`);
  } else {
    ui.notifications.info(`«${name}» создан${actor ? ` у ${actor.name}` : " в предметах мира"}.`);
  }
  console.log(`${LOG} создан предмет «${name}»`, uuids);
  return item;
}

/** Предмет с расширением обращения: надетый, настроенный и с зарядами */
export function turnExtender(actor) {
  return actor?.items?.find(item => {
    const types = item.getFlag(MODULE_ID, "turnAlsoAffects");
    if (!types?.length) return false;
    if (item.system.attunement === "required" && item.system.attuned === false) return false;
    const uses = item.system.uses ?? {};
    const left = Number(uses.value ?? (Number(uses.max) || 0) - (uses.spent ?? 0));
    return left > 0;
  }) ?? null;
}
