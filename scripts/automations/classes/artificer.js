import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { isLongRest, removeTemporaryItems, temporaryFlags } from "../../core/temporary-items.js";
import { chat, featById, migrated, runAsync } from "../../core/utils.js";
import { onItemUse } from "../../core/hooks.js";
import { createItemFor } from "../../core/item-source.js";
import { limits, planKey, tiersFor } from "./artificer-plans.js";

/*
 * Изобретатель (Eberron: Forge of the Artificer, 2025).
 *
 * Tinker's Magic: выбор предмета из списка — предмет появляется у изобретателя и исчезает
 * после его длинного отдыха.
 *
 * Replicate Magic Item: по нажатию на умение открывается выбор чертежей (сколько их можно знать,
 * считается по уровню). Каждый выбранный чертёж становится отдельным умением «Чертёж: …», а по
 * нажатию на чертёж предмет появляется в инвентаре с пометкой «создан изобретателем».
 * Зарядов столько же, сколько предметов можно держать одновременно (2/3/4/5/6), и восстанавливаются
 * они после длинного отдыха. Правила книги соблюдаются и в мелочах: при попытке превысить предел
 * исчезает самый старый предмет, а если снять чертёж — исчезает всё, что по нему сделано.
 */

const TINKER_ITEMS = [
  "Ball Bearings", "Basket", "Bedroll", "Bell", "Blanket", "Block and Tackle", "Glass Bottle", "Bucket",
  "Caltrops", "Candle", "Crowbar", "Flask", "Grappling Hook", "Hunting Trap", "Jug", "Lamp", "Manacles",
  "Net", "Oil", "Paper", "Parchment", "Pole", "Pouch", "Rope", "Sack", "Shovel", "Iron Spikes", "String",
  "Tinderbox", "Torch", "Vial",
];
const PACKS = ["dnd5e.equipment24", "dnd5e.items"];

const FEATURE = "replicate-magic-item";
const PLAN_ITEM = "artificer-plan";
const PLAN_IMG = "icons/sundries/scrolls/scroll-writing-tan-brown.webp";

// Статичные id активностей — ровно 16 символов, чтобы миграция была идемпотентной
const IDS = {
  choosePlans: "faArtPlansPick00",
  makeItem: "faArtPlanMake000",
};

const normalize = s => String(s ?? "").toLowerCase().replace(/[^a-zа-яё]/g, "");
// Имена записи индекса: переведённое Babele и исходное английское
const entryNames = e => [e.name, e.originalName, e.flags?.babele?.originalName].filter(Boolean).map(normalize);

/** Предмет из компендиума по названию (учитывая варианты вида «Bottle, Glass» и «Spikes, Iron») */
async function findItemData(name) {
  const wanted = normalize(name);
  const reversed = normalize(name.split(" ").reverse().join(" "));
  for (const packId of PACKS) {
    const pack = game.packs.get(packId);
    if (!pack) continue;
    const index = await pack.getIndex();
    const entry = index.find(e => entryNames(e).some(n => n === wanted || n === reversed));
    if (entry) return (await pack.getDocument(entry._id))?.toObject();
  }
  return null;
}

async function tinkersMagic(activity) {
  const feature = activity.item;
  const actor = feature.actor;
  const name = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Tinker's Magic" },
    content: "<p>Какой предмет создать? Он исчезнет после вашего длинного отдыха.</p>"
      + `<select name="item">${TINKER_ITEMS.map(n => `<option value="${n}">${n}</option>`).join("")}</select>`,
    ok: { label: "Создать", callback: (event, button) => button.form.elements.item.value },
    rejectClose: false,
  });
  if (!name) {
    // Отмена — возвращаем потраченный заряд
    const spent = feature.system.uses?.spent ?? 0;
    if (spent > 0) await feature.update({ "system.uses.spent": spent - 1 });
    return;
  }

  const data = (await findItemData(name)) ?? { name, type: "loot", img: feature.img };
  delete data._id;
  data.name = `${data.name} (Tinker's Magic)`;
  data.flags = foundry.utils.mergeObject(data.flags ?? {}, temporaryFlags(actor, "tinker"));
  await actor.createEmbeddedDocuments("Item", [data]);
  await chat(actor, `<p><strong>${actor.name}</strong> мастерит «${name}». Предмет исчезнет после длинного отдыха.</p>`);
}

/* Репликация магических предметов */

const escape = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export const artificerLevel = actor => actor?.classes?.artificer?.system?.levels ?? 0;

/** Чертежи, которые уже заведены: ключ чертежа → предмет-умение */
export function knownPlans(actor) {
  const out = new Map();
  for (const feat of actor?.itemTypes?.feat ?? []) {
    const plan = feat.getFlag(MODULE_ID, "plan");
    if (plan) out.set(planKey(plan), feat);
  }
  return out;
}

/** Созданные по чертежам предметы, от самых старых к новым */
export function replicatedItems(actor) {
  return (actor?.items?.filter(item => item.getFlag(MODULE_ID, "replicated")) ?? [])
    .sort((a, b) => (a.getFlag(MODULE_ID, "replicated").created ?? 0)
      - (b.getFlag(MODULE_ID, "replicated").created ?? 0));
}

const planDescription = plan => `<p>Чертёж: <strong>${escape(plan.label)}</strong>.</p>`
  + `<p>Нажмите, чтобы создать предмет. ${plan.attune === true ? "Требует настройки — она происходит сразу. "
    : plan.attune === "varies" ? "Настройка зависит от предмета. " : ""}`
  + "Предмет помечается как созданный изобретателем и исчезает, если упереться в предел "
  + "или снять этот чертёж.</p>";

const blueprintData = plan => ({
  name: `Чертёж: ${plan.label}`,
  type: "feat",
  img: PLAN_IMG,
  system: {
    identifier: PLAN_ITEM,
    type: { value: "class", subtype: "" },
    requirements: "Изобретатель 2",
    description: { value: planDescription(plan) },
    activities: {
      [IDS.makeItem]: {
        _id: IDS.makeItem,
        type: "utility",
        name: "Создать предмет",
        activation: { type: "special", override: true },
        consumption: { targets: [], spellSlot: false, scaling: { allowed: false } },
      },
    },
  },
  flags: { [MODULE_ID]: { plan } },
});

/** Окно выбора чертежей: галочки по ярусам, доступным на уровне */
async function choosePlans(feature) {
  const actor = feature.actor;
  const level = artificerLevel(actor);
  const { plans: maxPlans, items: maxItems } = limits(level);
  if (!maxPlans) {
    ui.notifications.warn("Чертежи появляются со 2-го уровня изобретателя.");
    return;
  }

  const known = knownPlans(actor);
  const sections = tiersFor(level).map((tier) => {
    const rows = tier.plans.map((plan) => {
      const key = planKey(plan);
      const mark = plan.attune === true ? " <em style=\"opacity:.6\">настройка</em>"
        : plan.attune === "varies" ? " <em style=\"opacity:.6\">настройка зависит</em>" : "";
      return `<label style="display:flex;align-items:center;gap:.5em;margin:.1em 0 .1em 1.2em">
        <input type="checkbox" name="plan" value="${escape(key)}" ${known.has(key) ? "checked" : ""}>
        <span>${escape(plan.label)}${mark}</span></label>`;
    }).join("");
    return `<fieldset style="margin:.4em 0;padding:.3em .5em"><legend><strong>${escape(tier.title)}</strong></legend>${rows}</fieldset>`;
  }).join("");

  const picked = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Чертежи магических предметов" },
    position: { width: 520 },
    content: `<p>Изобретатель ${level}-го уровня знает <strong>${maxPlans}</strong> чертежей `
      + `и держит одновременно <strong>${maxItems}</strong> созданных предмета.</p>`
      + "<p style=\"opacity:.75\">Снятый чертёж забывается, и созданные по нему предметы исчезают.</p>"
      + `<div style="max-height:460px;overflow-y:auto">${sections}</div>`,
    ok: {
      label: "Сохранить",
      callback: (event, button) => [...button.form.querySelectorAll("input[name=\"plan\"]:checked")].map(i => i.value),
    },
    rejectClose: false,
  });
  if (!picked) return;

  if (picked.length > maxPlans) {
    ui.notifications.warn(`Чертежей можно знать ${maxPlans}, а отмечено ${picked.length}. Ничего не изменил.`);
    return;
  }

  const wanted = new Set(picked);
  const available = new Map(tiersFor(level).flatMap(tier => tier.plans.map(plan => [planKey(plan), plan])));

  const toAdd = [...wanted].filter(key => !known.has(key)).map(key => available.get(key)).filter(Boolean);
  const toRemove = [...known].filter(([key]) => !wanted.has(key)).map(([, feat]) => feat);

  for (const feat of toRemove) await feat.delete();   // предметы по нему уберёт хук удаления
  if (toAdd.length) await actor.createEmbeddedDocuments("Item", toAdd.map(blueprintData));

  const parts = [];
  if (toAdd.length) parts.push(`добавлено: ${toAdd.map(p => p.label).join(", ")}`);
  if (toRemove.length) parts.push(`снято: ${toRemove.map(f => f.name.replace(/^Чертёж: /, "")).join(", ")}`);
  await chat(actor, `<p><strong>${actor.name}</strong> разбирает арканные планы.</p>`
    + `<p>${parts.length ? parts.join("; ") : "ничего не изменилось"}.</p>`
    + `<p style="opacity:.7;font-size:11px">Чертежей: ${wanted.size} из ${maxPlans}.</p>`);
  console.log(`${LOG} чертежи ${actor.name}: ${wanted.size}/${maxPlans}`, { added: toAdd.length, removed: toRemove.length });
}

/** Создание предмета по чертежу */
async function makeFromPlan(blueprint) {
  const actor = blueprint.actor;
  const plan = blueprint.getFlag(MODULE_ID, "plan");
  if (!plan) return;

  const feature = featById(actor, FEATURE);
  if (!feature) {
    ui.notifications.warn("У персонажа нет умения «Replicate Magic Item» — чертёж не из этого набора.");
    return;
  }
  const left = feature.system.uses?.value ?? 0;
  if (left <= 0) {
    ui.notifications.warn("Предметы по чертежам кончились — они восстановятся после длинного отдыха.");
    return;
  }

  let ref = plan;
  if (plan.any) {
    const name = await foundry.applications.api.DialogV2.prompt({
      window: { title: plan.label },
      content: `<p>${escape(plan.label)}.</p><p>Название предмета:</p>`
        + "<input type=\"text\" name=\"name\" placeholder=\"например, Driftglobe\" style=\"width:100%\">",
      ok: { label: "Создать", callback: (event, button) => button.form.elements.name.value.trim() },
      rejectClose: false,
    });
    if (!name) return;
    ref = { name, label: name };
  }

  const { items: cap } = limits(artificerLevel(actor));
  const existing = replicatedItems(actor);
  const vanished = [];
  while (existing.length >= cap && existing.length) {
    const oldest = existing.shift();
    vanished.push(oldest.name);
    await oldest.delete();
  }

  const { item, how, reason } = await createItemFor(actor, ref, {
    flags: { [MODULE_ID]: { replicated: { plan: blueprint.id, label: ref.label, created: Date.now() } } },
    updates: { name: `${ref.label} (изобретатель)` },
  });
  if (!item) {
    ui.notifications.warn(reason ?? "предмет создать не вышло");
    return;
  }
  // Правила разрешают настроиться на предмет сразу, как он создан
  if (item.system?.attunement === "required" && item.system?.attuned === false) {
    await item.update({ "system.attuned": true });
  }

  await feature.update({ "system.uses.spent": (feature.system.uses?.spent ?? 0) + 1 });

  await chat(actor, `<p><strong>${actor.name}</strong> создаёт <strong>${escape(ref.label)}</strong> по чертежу.</p>`
    + (vanished.length ? `<p>Предел достигнут, поэтому исчезает: ${escape(vanished.join(", "))}.</p>` : "")
    + `<p style="opacity:.7;font-size:11px">Осталось созданий до отдыха: ${Math.max(0, left - 1)}. `
    + `Предметов по чертежам: ${replicatedItems(actor).length} из ${cap}.</p>`);
  console.log(`${LOG} ${actor.name} создал «${ref.label}» (${how})`);
}

/** Снятый чертёж забирает с собой созданные по нему предметы */
async function dropItemsOfPlan(blueprint) {
  const actor = blueprint.actor;
  if (!actor?.isOwner) return 0;
  const made = actor.items.filter(item => item.getFlag(MODULE_ID, "replicated")?.plan === blueprint.id);
  if (!made.length) return 0;
  await actor.deleteEmbeddedDocuments("Item", made.map(item => item.id));
  await chat(actor, `<p>Чертёж снят — исчезает: ${escape(made.map(i => i.name).join(", "))}.</p>`);
  return made.length;
}

/** Развоплотить всё, созданное по чертежам (для макроса) */
export async function dismissReplicated(actor) {
  const made = replicatedItems(actor);
  if (!made.length) return 0;
  await actor.deleteEmbeddedDocuments("Item", made.map(item => item.id));
  return made.length;
}

export default {
  id: "artificer",
  kind: "class",
  label: "Изобретатель",
  hint: "Tinker's Magic: предмет из списка, исчезает после длинного отдыха. "
    + "Replicate Magic Item: выбор чертежей по уровню, создание предметов по ним с пометкой "
    + "«создан изобретателем», предел одновременных предметов и исчезновение лишних.",
  identifiers: ["tinkers-magic", FEATURE, PLAN_ITEM],

  async migrate(actor) {
    const feature = featById(actor, FEATURE);
    if (!feature || migrated(feature, "replicateMigrated")) return;
    await feature.update({
      // Зарядов столько же, сколько предметов можно держать: 2/3/4/5/6 на уровнях 2/6/10/14/18
      "system.uses.max": "2 + floor((@classes.artificer.levels - 2) / 4)",
      "system.uses.recovery": [{ period: "lr", type: "recoverAll" }],
      [`system.activities.${IDS.choosePlans}`]: {
        _id: IDS.choosePlans,
        type: "utility",
        name: "Выбрать чертежи",
        activation: { type: "special", override: true },
        consumption: { targets: [], spellSlot: false, scaling: { allowed: false } },
      },
      [`flags.${MODULE_ID}.replicateMigrated`]: MIGRATION_VERSION,
    });
    console.log(`${LOG} чертежи изобретателя готовы у ${actor.name}`);
  },

  register() {
    onItemUse("tinkers-magic", (activity) => runAsync("Tinker's Magic", () => tinkersMagic(activity)));

    onItemUse(FEATURE, (activity) => {
      if (activity.id && activity.id !== IDS.choosePlans) return;
      runAsync("Чертежи: выбор", () => choosePlans(activity.item));
    });

    onItemUse(PLAN_ITEM, (activity) => runAsync("Чертёж: создание", () => makeFromPlan(activity.item)));

    Hooks.on("deleteItem", (item) => {
      if (!item.getFlag?.(MODULE_ID, "plan")) return;
      runAsync("Чертёж: снятие", () => dropItemsOfPlan(item));
    });

    Hooks.on("dnd5e.restCompleted", (actor, result, config) => {
      if (!isLongRest(result, config) || !featById(actor, "tinkers-magic")) return;
      runAsync("Tinker's Magic: отдых", async () => {
        const removed = await removeTemporaryItems(actor, "tinker");
        if (removed) console.log(`${LOG} ${actor.name}: исчезло предметов Tinker's Magic: ${removed}`);
      });
    });
  },
};
