import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { damageTypeLabel, runAsync } from "../../core/utils.js";
import { registerSneakAttackVariant } from "../classes/rogue.js";
import { onItemUse } from "../../core/hooks.js";

/* Плут — Arachnoid Stalker (VSS:PP1), 3 уровень: Venomous Strike, Webbing */

const VENOM_RE = /venomous\s+strike|ядовит\S*\s+удар/i;
const WEBBING_RE = /^\s*(webbing|паутин\S*)\s*$/i;
const PULL_RE = /pull\s+yourself|подтян/i;

// Статичные id (16 символов), чтобы миграция была идемпотентной
const IDS = {
  create: "faWebCreate00000",
  fire: "faWebFire0000000",
  restrained: "faWebRestrained0",
};

const getVenomousStrike = actor =>
  actor?.itemTypes?.feat?.find(f => f.system.identifier === "venomous-strike" || VENOM_RE.test(f.name));

const isWebbing = item => item?.type === "feat" && (item.system.identifier === "webbing" || WEBBING_RE.test(item.name));

/**
 * Импорт Plutonium оставил Webbing недоделанным: у каста Web нет зарядов и стоит основное действие,
 * а у копии заклинания Web спасбросок наносит 2d4 огнём по области при касте.
 */
async function migrateWebbing(webbing) {
  const actor = webbing.actor;
  const cast = webbing.system.activities?.getByType?.("cast")?.[0];
  if (!actor || !cast) return;

  // 1. Каст Web: бонусное действие, 2 заряда (1 за короткий отдых, все за длинный)
  if ((webbing.getFlag(MODULE_ID, "webbingMigrated") ?? 0) < MIGRATION_VERSION) {
    await webbing.update({
      [`system.activities.${cast.id}.activation`]: { type: "bonus", value: null, condition: "", override: true },
      [`system.activities.${cast.id}.uses`]: {
        spent: 0, max: "2",
        recovery: [{ period: "sr", type: "formula", formula: "1" }, { period: "lr", type: "recoverAll" }],
      },
      [`system.activities.${cast.id}.consumption.targets`]: [{ type: "activityUses", value: "1", target: "", scaling: {} }],
      [`flags.${MODULE_ID}.webbingMigrated`]: MIGRATION_VERSION,
    });
    console.log(`${LOG} Webbing у ${actor.name}: каст Web — бонусное действие, 2 заряда`);
  }

  // 2. Копия заклинания Web, созданная кастом
  const spell = cast.cachedSpell;
  if (!spell || (spell.getFlag(MODULE_ID, "webMigrated") ?? 0) >= MIGRATION_VERSION) return;
  const save = spell.system.activities.getByType("save")[0];
  if (!save) return;

  const updates = {
    // Спасбросок: без урона, СЛ = 8 + Лов + БМ, при провале — «Опутан»; запускается только областью
    [`system.activities.${save.id}.name`]: "Спасбросок от паутины",
    [`system.activities.${save.id}.damage.parts`]: [],
    [`system.activities.${save.id}.save.dc`]: { calculation: "", formula: "8 + @abilities.dex.mod + @prof" },
    [`system.activities.${save.id}.effects`]: [{ _id: IDS.restrained, onSave: false }],
    [`system.activities.${save.id}.target`]: {
      override: true, prompt: false,
      template: { count: "", contiguous: false, type: "", size: "", width: "", height: "", units: "ft", stationary: false },
      affects: { count: "1", type: "creature", choice: false, special: "" },
    },
    [`system.activities.${save.id}.consumption.spellSlot`]: false,
    [`system.activities.${save.id}.midiProperties.automationOnly`]: true,
    [`system.activities.${save.id}.midiProperties.identifier`]: "web-save",

    // Сотворение: ставит область; вход в неё и начало хода в ней вызывают спасбросок, выход снимает эффект
    [`system.activities.${IDS.create}`]: {
      _id: IDS.create,
      type: "utility",
      name: "Сотворить паутину",
      sort: -1,
      activation: { override: false },
      duration: { override: false },
      range: { override: false },
      target: { override: false, prompt: true },
      consumption: { spellSlot: true, targets: [], scaling: { allowed: false } },
      roll: { prompt: false, visible: false },
      midiProperties: { identifier: "web-create" },
      regionBehavior: {
        enabled: true,
        dispositionFilter: 0,
        excludeSource: false,
        oncePerTurn: true,
        wallRestriction: "none",
        regionVisibility: CONST.REGION_VISIBILITY.ALWAYS,
        attachToken: "default",
        rules: [
          { trigger: "entry", action: "useActivity", targetId: "web-save" },
          { trigger: "turnStart", action: "useActivity", targetId: "web-save" },
          { trigger: "exit", action: "removeEffect", targetId: IDS.restrained },
        ],
      },
    },

    // Паутина горит: 2d4 огнём существу в подожжённом кубе
    [`system.activities.${IDS.fire}`]: {
      _id: IDS.fire,
      type: "damage",
      name: "Поджечь паутину (2d4 огнём)",
      sort: 10,
      activation: { type: "special", override: true },
      target: {
        override: true, prompt: false,
        template: { count: "", contiguous: false, type: "", size: "", units: "ft", stationary: false },
        affects: { count: "1", type: "creature", choice: false, special: "" },
      },
      consumption: { spellSlot: false, targets: [], scaling: { allowed: false } },
      damage: { critical: { allow: false }, parts: [{ number: 2, denomination: 4, bonus: "", types: ["fire"],
        custom: { enabled: false, formula: "" }, scaling: { mode: "", number: 1 } }] },
    },

    [`flags.${MODULE_ID}.webMigrated`]: MIGRATION_VERSION,
  };

  await spell.update(updates);
  if (!spell.effects.has(IDS.restrained)) {
    await spell.createEmbeddedDocuments("ActiveEffect", [{
      _id: IDS.restrained,
      name: "Опутан паутиной",
      img: spell.img,
      type: "base",
      transfer: false,
      statuses: ["restrained"],
      description: "<p>Существо опутано паутиной. Действием оно может совершить проверку Силы (Атлетика) "
        + "против СЛ паутины, чтобы освободиться. Эффект также снимается, когда существо покидает паутину.</p>",
      flags: { dae: { stackable: "noneName" } },
    }], { keepId: true });
  }
  console.log(`${LOG} Web (из Webbing) у ${actor.name}: область со спасброском, эффект «Опутан»`);
}

/* Pull Yourself: выбрать точку в 30 футах и притянуться к ней */

function pickPullPoint(token, maxFt) {
  return new Promise(resolve => {
    const origin = token.center;
    const pxPerFt = canvas.dimensions.size / canvas.dimensions.distance;
    const gfx = new PIXI.Graphics();
    canvas.controls.addChild(gfx);

    const isValid = point => {
      const distance = canvas.grid.measurePath([origin, point]).distance;
      if (distance > maxFt) return false;
      const backends = CONFIG.Canvas.polygonBackends;
      try {
        if (backends.sight.testCollision(origin, point, { type: "sight", mode: "any" })) return false;
        if (backends.move.testCollision(origin, point, { type: "move", mode: "any" })) return false;
      } catch (err) { /* нет стен/бэкенда — считаем путь свободным */ }
      return true;
    };

    const draw = point => {
      gfx.clear();
      gfx.lineStyle(2, 0xffffff, 0.6).drawCircle(origin.x, origin.y, maxFt * pxPerFt);
      if (!point) return;
      const color = isValid(point) ? 0x33cc66 : 0xcc3333;
      gfx.lineStyle(3, color, 0.9).moveTo(origin.x, origin.y).lineTo(point.x, point.y);
      gfx.beginFill(color, 0.5).drawCircle(point.x, point.y, 8).endFill();
    };

    const finish = result => {
      canvas.stage.off("pointermove", onMove);
      canvas.stage.off("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      gfx.destroy();
      resolve(result);
    };
    const onMove = event => draw(event.getLocalPosition(canvas.stage));
    const onDown = event => {
      event.stopPropagation();
      if (event.button === 2) return finish(null);
      if (event.button !== 0) return;
      const point = event.getLocalPosition(canvas.stage);
      if (!isValid(point)) {
        ui.notifications.warn("Точка дальше 30 футов или за препятствием.");
        return;
      }
      finish(point);
    };
    const onKey = event => { if (event.key === "Escape") finish(null); };

    canvas.stage.on("pointermove", onMove);
    canvas.stage.on("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    draw(null);
    ui.notifications.info("Pull Yourself: кликните точку в пределах 30 футов (ПКМ или Esc — отмена).");
  });
}

async function pullYourself(activity) {
  const actor = activity.item.actor;
  const token = actor.getActiveTokens(true)[0];
  if (!token || !canvas.ready) {
    ui.notifications.warn(`${actor.name}: нет токена на текущей сцене — переместите токен вручную.`);
    return;
  }
  const point = await pickPullPoint(token, 30);
  if (!point) return;
  const destination = token.getSnappedPosition({ x: point.x - token.w / 2, y: point.y - token.h / 2 });
  await token.document.update(destination, { animate: true, [MODULE_ID]: { pull: true } });
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p><strong>${actor.name}</strong> выстреливает нитью паутины и притягивается к точке`
      + ` — без провоцирования атак.</p>`,
  });
}

export default {
  id: "rogue-arachnoid-stalker",
  kind: "subclass",
  label: "Плут — Arachnoid Stalker",
  hint: "Venomous Strike (вариант Sneak Attack), Webbing: Pull Yourself и Web без ячейки с областью.",
  appliesTo: actor => actor.itemTypes.feat.some(isWebbing),
  // Копия заклинания Web появляется при первом касте из Webbing
  watchItem: item => isWebbing(item) || (item.type === "spell" && !!item.getFlag("dnd5e", "cachedFor")),

  async migrate(actor) {
    for (const item of actor.itemTypes.feat.filter(isWebbing)) await migrateWebbing(item);
  },

  register() {
    // Venomous Strike: d8 ядом вместо d6 урона оружия
    registerSneakAttackVariant({
      id: "venomous-strike",
      preferred: true,
      source: getVenomousStrike,
      button: ({ source, formula }) => ({
        label: `${source.name}: ${formula.replace(/d6\b/g, "d8")} (${damageTypeLabel("poison")})`,
        icon: "fa-solid fa-spider",
      }),
      apply: ({ source, feature, formula }) => ({
        damageRoll: formula.replace(/d6\b/g, "d8"),
        damageType: "poison",
        flavor: `${feature.name} (${source.name})`,
      }),
    });

    onItemUse("webbing", (activity) => {
      if (activity.type !== "utility" || !PULL_RE.test(activity.name ?? "")) return;
      runAsync("Pull Yourself", () => pullYourself(activity));
    });
  },
};
