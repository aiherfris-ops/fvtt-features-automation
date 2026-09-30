import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { GEAR_FLAG, refreshGearEffects, wearsHeavyArmor } from "../../core/gear.js";
import { onItemUse, onPreAttackRoll } from "../../core/hooks.js";
import { isIncapacitated } from "../../core/native.js";
import { change, chat, debugNote, featById, isActiveGM, isEnabled, migrated, runAsync } from "../../core/utils.js";

/*
 * Варвар 2024: Ярость (преимущество на Силу, продление по правилам 2024, конец от тяжёлого доспеха
 * и недееспособности), Опрометчивая атака (преимущество себе и врагам по себе), Чувство опасности,
 * Быстрое передвижение.
 *
 * Импорт Plutonium даёт эффекту Ярости сопротивления и бонус урона, но не даёт преимущества на Силу,
 * и никак не следит за продлением — этим занимается автоматизация.
 */

const IDS = {
  rageExtend: "faRageExtend0000",
  recklessUse: "faRecklessUse000",
  recklessEffect: "faRecklessEff000",
  dangerSense: "faDangerSense000",
  fastMovement: "faFastMovement00",
};

const RAGE_SECONDS = 600;

/* Поиск умений и эффектов */

const rageFeature = actor => featById(actor, "rage");

/** Действующая Ярость: копия эффекта на актёре */
export const ragingEffect = actor =>
  actor?.effects?.find(e => e.getFlag(MODULE_ID, "rage") && !e.disabled && e.active !== false);

export const isRaging = actor => !!ragingEffect(actor);

const recklessEffect = actor => actor?.effects?.find(e => e.getFlag(MODULE_ID, "reckless") && !e.disabled);

const rageState = actor => actor?.getFlag(MODULE_ID, "rageState") ?? null;

/* Правила эффекта Ярости: те же изменения, что у dnd5e в собственном компендиуме 2024 */

const RAGE_CHANGES = [
  ["system.traits.dr.value", "add", "bludgeoning"],
  ["system.traits.dr.value", "add", "piercing"],
  ["system.traits.dr.value", "add", "slashing"],
  ["system.bonuses.mwak.damage", "add", "+@scale.barbarian.rage-damage"],
  ["system.abilities.str.check.roll.mode", "add", 1],
  ["system.abilities.str.save.roll.mode", "add", 1],
];

const sameChange = (a, b) => a.key === b.key && String(a.value) === String(b.value);

/** Дописать эффекту недостающие изменения, не трогая чужие */
function mergeChanges(effect, wanted) {
  const current = effect.system?.changes ?? [];
  const missing = wanted
    .map(([key, type, value]) => change(key, type, value))
    .filter(want => !current.some(has => sameChange(has, want)));
  return missing.length ? [...current, ...missing] : null;
}

/* Продление Ярости */

const markExtended = (actor) => {
  const state = rageState(actor);
  if (!state) return;
  const round = game.combat?.round ?? null;
  if (state.extendedRound === round) return;
  runAsync("Ярость: продление", () => actor.setFlag(MODULE_ID, "rageState", { ...state, extendedRound: round }));
};

async function endRage(actor, reason) {
  const effect = ragingEffect(actor);
  if (!effect) return;
  if (actor.isOwner) await actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id]);
  await actor.unsetFlag(MODULE_ID, "rageState");
  await chat(actor, `<p><strong>${actor.name}</strong>: ярость заканчивается — ${reason}.</p>`);
  console.log(`${LOG} ярость ${actor.name} закончилась: ${reason}`);
}

/** Конец хода варвара: ярость держится только если её продлили в этом ходу */
async function rageTurnEnd(actor, round) {
  const state = rageState(actor);
  if (!state || !isRaging(actor)) return;
  if ((game.time.worldTime - (state.started ?? 0)) >= RAGE_SECONDS) {
    await endRage(actor, "прошло 10 минут");
    return;
  }
  if (state.extendedRound === round) {
    await actor.setFlag(MODULE_ID, "rageState", { ...state, extendedRound: null });
    return;
  }
  await endRage(actor, "в этом ходу не было ни атаки, ни спасброска по вашей воле, ни бонусного действия");
}

export default {
  id: "barbarian",
  kind: "class",
  label: "Варвар",
  hint: "Ярость: преимущество на Силу, продление по правилам 2024 (атака, спасбросок по вашей воле или бонусное "
    + "действие), конец от тяжёлого доспеха, недееспособности и через 10 минут. Опрометчивая атака: преимущество "
    + "на атаки Силой и преимущество врагам по вам до начала вашего хода. Чувство опасности и Быстрое передвижение.",
  identifiers: ["rage", "reckless-attack", "danger-sense", "fast-movement"],

  async migrate(actor) {
    // Ярость: дописать эффекту преимущество на Силу и пометить его своим флагом
    const rage = rageFeature(actor);
    const effect = rage?.effects.find(e => /rage|ярост/i.test(e.name ?? "")) ?? rage?.effects.contents[0];
    if (rage && effect && !migrated(rage, "rageMigrated")) {
      const before = effect.system?.changes?.length ?? 0;
      const changes = mergeChanges(effect, RAGE_CHANGES);
      await effect.update({
        ...(changes ? { "system.changes": changes } : {}),
        [`flags.${MODULE_ID}.rage`]: true,
        [`flags.${MODULE_ID}.${GEAR_FLAG}`]: "noHeavyArmor",
        "duration.seconds": RAGE_SECONDS,
      });
      await rage.update({ [`flags.${MODULE_ID}.rageMigrated`]: MIGRATION_VERSION });
      console.log(`${LOG} ярость у ${actor.name}: изменений дописано ${changes ? changes.length - before : 0}`);
    }

    // Бонусное действие «продлить ярость» — третий способ из правил
    if (rage && !rage.system.activities?.get?.(IDS.rageExtend)) {
      await rage.update({
        [`system.activities.${IDS.rageExtend}`]: {
          _id: IDS.rageExtend,
          type: "utility",
          name: "Продлить ярость",
          activation: { type: "bonus", value: 1, override: true },
          consumption: { targets: [], spellSlot: false, scaling: { allowed: false } },
          description: { chatFlavor: "Ярость держится до конца следующего хода." },
        },
      });
    }

    // Опрометчивая атака: своя активность и метка-эффект (dnd5e тоже держит её просто меткой)
    const reckless = featById(actor, "reckless-attack");
    if (reckless && !migrated(reckless, "recklessMigrated")) {
      await reckless.update({
        [`system.activities.${IDS.recklessUse}`]: {
          _id: IDS.recklessUse,
          type: "utility",
          name: "Атаковать опрометчиво",
          activation: { type: "special", override: true },
          consumption: { targets: [], spellSlot: false, scaling: { allowed: false } },
          effects: [{ _id: IDS.recklessEffect }],
          description: { chatFlavor: "Преимущество на атаки Силой; атаки по вам тоже с преимуществом." },
        },
        [`flags.${MODULE_ID}.recklessMigrated`]: MIGRATION_VERSION,
      });
      if (!reckless.effects.has(IDS.recklessEffect)) {
        await reckless.createEmbeddedDocuments("ActiveEffect", [{
          _id: IDS.recklessEffect,
          name: "Опрометчивая атака",
          img: reckless.img,
          transfer: false,
          duration: { rounds: 1 },
          flags: { [MODULE_ID]: { reckless: true } },
        }], { keepId: true });
      }
      console.log(`${LOG} опрометчивая атака у ${actor.name}`);
    }

    // Чувство опасности: преимущество на спасброски Ловкости (импорт Plutonium его не даёт)
    const danger = featById(actor, "danger-sense");
    if (danger && !danger.effects.has(IDS.dangerSense) && !migrated(danger, "dangerSenseMigrated")) {
      await danger.createEmbeddedDocuments("ActiveEffect", [{
        _id: IDS.dangerSense,
        name: "Чувство опасности",
        img: danger.img,
        transfer: true,
        system: { changes: [change("system.abilities.dex.save.roll.mode", "add", 1)] },
      }], { keepId: true });
      await danger.update({ [`flags.${MODULE_ID}.dangerSenseMigrated`]: MIGRATION_VERSION });
      console.log(`${LOG} чувство опасности у ${actor.name}`);
    }

    // Быстрое передвижение: +10 футов, пока не надет тяжёлый доспех
    const fast = featById(actor, "fast-movement");
    if (fast && !fast.effects.has(IDS.fastMovement) && !migrated(fast, "fastMovementMigrated")) {
      await fast.createEmbeddedDocuments("ActiveEffect", [{
        _id: IDS.fastMovement,
        name: "Быстрое передвижение",
        img: fast.img,
        transfer: true,
        system: { changes: [change("system.attributes.movement.walk", "add", 10)] },
        flags: { [MODULE_ID]: { [GEAR_FLAG]: "noHeavyArmor" } },
      }], { keepId: true });
      await fast.update({ [`flags.${MODULE_ID}.fastMovementMigrated`]: MIGRATION_VERSION });
    }

    await refreshGearEffects(actor);
  },

  register() {
    // Вход в ярость: запоминаем время и считаем этот ход продлённым
    onItemUse("rage", (activity) => {
      const actor = activity?.item?.actor;
      if (!actor || activity.id === IDS.rageExtend) return;
      runAsync("Ярость: начало", async () => {
        if (wearsHeavyArmor(actor)) {
          debugNote(actor, "Ярость: в тяжёлом доспехе её нельзя войти");
          ui.notifications.warn("Ярость: в тяжёлом доспехе её нельзя войти.");
        }
        await actor.setFlag(MODULE_ID, "rageState", {
          started: game.time.worldTime,
          extendedRound: game.combat?.round ?? null,
          combat: game.combat?.id ?? null,
        });
        await chat(actor, "<p><strong>Ярость.</strong> Держится до конца следующего хода; продлевается атакой по врагу, "
          + "спасброском по вашей воле или бонусным действием «Продлить ярость». Не больше 10 минут.</p>");
      });
    });

    // Продление: бонусное действие
    onItemUse("rage", (activity) => {
      if (activity?.id !== IDS.rageExtend) return;
      const actor = activity.item.actor;
      if (!isRaging(actor)) {
        debugNote(actor, "Продлить ярость: ярость не активна");
        return;
      }
      markExtended(actor);
    });

    // Продление: атака по врагу или спасбросок по вашей воле
    onPreAttackRoll((config) => {
      const actor = config?.subject?.actor;
      if (actor && rageState(actor)) markExtended(actor);
    });
    Hooks.on("dnd5e.postUseActivity", (activity) => {
      const actor = activity?.item?.actor;
      if (!actor || !activity.save?.ability || !rageState(actor)) return;
      markExtended(actor);
    });

    // Преимущество от опрометчивой атаки — себе на атаки Силой и врагам на атаки по варвару
    onPreAttackRoll((config) => {
      if (!isEnabled("barbarian")) return;
      const activity = config?.subject;
      const attacker = activity?.actor ?? activity?.item?.actor;
      if (attacker && recklessEffect(attacker) && activity?.ability === "str") config.advantage = true;
      for (const token of game.user.targets ?? []) {
        if (token.actor && recklessEffect(token.actor)) config.advantage = true;
      }
    });

    Hooks.on("combatTurnChange", (combat, prior, current) => {
      if (!isActiveGM()) return;
      const ended = combat.combatants.get(prior?.combatantId)?.actor;
      if (ended && rageState(ended)) {
        runAsync("Ярость: конец хода", () => rageTurnEnd(ended, prior?.round ?? combat.round));
      }
      // Опрометчивость держится до начала следующего хода варвара
      const started = combat.combatants.get(current?.combatantId)?.actor;
      const reckless = started && recklessEffect(started);
      const startRound = reckless?.start?.round ?? reckless?.duration?.startRound ?? null;
      if (reckless && startRound && combat.round > startRound) {
        runAsync("Опрометчивая атака: конец", () => started.deleteEmbeddedDocuments("ActiveEffect", [reckless.id]));
      }
    });

    // Недееспособность и тяжёлый доспех заканчивают ярость
    Hooks.on("createActiveEffect", (effect) => {
      if (!isActiveGM()) return;
      const actor = effect.parent instanceof Actor ? effect.parent : null;
      if (!actor || !isRaging(actor) || !isIncapacitated(actor)) return;
      runAsync("Ярость: недееспособность", () => endRage(actor, "вы недееспособны"));
    });

    Hooks.on("updateItem", (item, changes) => {
      if (!isActiveGM() || !("equipped" in (changes.system ?? {}))) return;
      const actor = item.actor;
      if (!actor || !isRaging(actor) || item.system.type?.value !== "heavy" || !item.system.equipped) return;
      runAsync("Ярость: тяжёлый доспех", () => endRage(actor, "надет тяжёлый доспех"));
    });
  },
};
