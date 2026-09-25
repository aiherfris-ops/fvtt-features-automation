import { LOG, MIGRATION_VERSION, MODULE_ID } from "../../core/constants.js";
import { removeEffects } from "../../core/native.js";
import { doubleDice, isMeleeWeaponAttack, registerDamageBonusProvider, syncDamageBonusMacro } from "../../core/damage-bonus.js";
import { onItemUse } from "../../core/hooks.js";
import { chat, debugNote, featById, isEnabled, migrated, runAsync, turnKey } from "../../core/utils.js";

/* Паладин 2024: Divine Smite после попадания, Paladin's Smite, Lay on Hands (снятие отравления) */

const UNHOLY_TYPES = new Set(["fiend", "undead"]);

const getSmiteSpell = actor => actor.itemTypes.spell.find(s =>
  s.system.identifier === "divine-smite" && !s.getFlag("dnd5e", "cachedFor"));

const freeSmitesLeft = feature => {
  if (!feature) return 0;
  const max = Number(feature.system.uses?.max) || 0;
  return Math.max(0, max - (feature.system.uses?.spent ?? 0));
};

/**
 * Divine Smite 2024 накладывается бонусным действием сразу после попадания рукопашным оружием
 * или безоружным ударом: 2d8 излучением, +1d8 за уровень ячейки выше 1-го, +1d8 по исчадиям и нежити.
 * Выбор источника (бесплатная кара или ячейка) — выпадающим списком в общем окне бонусов урона.
 */
registerDamageBonusProvider({
  id: "divine-smite",
  enabled: () => isEnabled("paladin"),

  prepare({ workflow, actor, item, target }) {
    const paladinsSmite = featById(actor, "paladins-smite");
    if (!getSmiteSpell(actor) && !paladinsSmite) return null;
    if (!isMeleeWeaponAttack(workflow, item)) return null;

    const key = turnKey();
    if (key && actor.getFlag(MODULE_ID, "smiteUsed") === key) {
      debugNote(actor, "Divine Smite: бонусное действие в этом ходу уже потрачено на кару");
      return null;
    }

    const free = freeSmitesLeft(paladinsSmite);
    const slots = [1, 2, 3, 4, 5].filter(level => (actor.system.spells?.[`spell${level}`]?.value ?? 0) > 0);
    if (!free && !slots.length) return null;

    const unholy = UNHOLY_TYPES.has(target.actor?.system.details?.type?.value);
    const crit = !!workflow.isCritical;
    const formulaFor = level => {
      const formula = `${1 + level + (unholy ? 1 : 0)}d8`;
      return crit ? doubleDice(formula) : formula;
    };

    return {
      label: `Divine Smite${unholy ? " (+1d8 по нежити и исчадиям)" : ""}`,
      checked: false,
      options: [
        ...(free ? [{ value: "free", label: `Paladin's Smite, без ячейки: ${formulaFor(1)}` }] : []),
        ...slots.map(level => ({
          value: `slot${level}`,
          label: `Ячейка ${level} ур. (${actor.system.spells[`spell${level}`].value}): ${formulaFor(level)}`,
        })),
      ],
      async apply(choice) {
        let level = 1;
        if (choice === "free") {
          await paladinsSmite.update({ "system.uses.spent": (paladinsSmite.system.uses?.spent ?? 0) + 1 });
        } else {
          level = Number(String(choice).replace("slot", ""));
          const slot = actor.system.spells[`spell${level}`];
          await actor.update({ [`system.spells.spell${level}.value`]: Math.max(0, slot.value - 1) });
        }
        if (key) await actor.setFlag(MODULE_ID, "smiteUsed", key);
        const source = choice === "free" ? "Paladin's Smite" : `ячейка ${level} ур.`;
        return { damageRoll: formulaFor(level), damageType: "radiant", flavor: `Divine Smite (${source})` };
      },
    };
  },
});

/* Lay on Hands: 5 очков пула снимают отравление */
async function removePoison(actor) {
  const targets = [...game.user.targets].filter(t => t.actor);
  if (!targets.length) {
    ui.notifications.warn("Lay on Hands: выберите цель (таргет), чтобы снять отравление.");
    return;
  }
  for (const token of targets) {
    const target = token.actor;
    const poisoned = target.effects.filter(e => e.statuses?.has("poisoned"));
    if (!poisoned.length) continue;
    if (target.isOwner) await target.deleteEmbeddedDocuments("ActiveEffect", poisoned.map(e => e.id));
    else await removeEffects(target, poisoned.map(e => e.id));
    await chat(actor, `<p><strong>${actor.name}</strong> снимает отравление с <strong>${token.name}</strong>.</p>`);
  }
}

export default {
  id: "paladin",
  kind: "class",
  label: "Паладин",
  hint: "Divine Smite после попадания (ячейка или Paladin's Smite), Lay on Hands снимает отравление.",
  identifiers: ["paladins-smite", "divine-smite", "lay-on-hands"],
  appliesTo: actor => !!(getSmiteSpell(actor) || featById(actor, "paladins-smite")),

  async migrate(actor) {
    await syncDamageBonusMacro(actor);

    // Paladin's Smite: у каста «заряды активности» без максимума — считаем по зарядам умения (1 за длинный отдых)
    const feature = featById(actor, "paladins-smite");
    const cast = feature?.system.activities?.getByType?.("cast")?.[0];
    if (feature && cast && !migrated(feature, "paladinsSmiteMigrated")) {
      await feature.update({
        [`system.activities.${cast.id}.consumption.targets`]: [{ type: "itemUses", value: "1", target: "", scaling: {} }],
        [`flags.${MODULE_ID}.paladinsSmiteMigrated`]: MIGRATION_VERSION,
      });
      console.log(`${LOG} Paladin's Smite у ${actor.name}: расход по зарядам умения`);
    }
  },

  register() {
    onItemUse("lay-on-hands", (activity) => {
      if (!/poison|яд|отрав/i.test(activity.name ?? "")) return;
      runAsync("Lay on Hands", () => removePoison(activity.item.actor));
    });
  },
};
