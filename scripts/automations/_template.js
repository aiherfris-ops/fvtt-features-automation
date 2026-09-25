import { LOG, MIGRATION_VERSION, MODULE_ID } from "../core/constants.js";
import { onItemUse, onActivityUse, onPreAttackRoll, onPreDamageRoll } from "../core/hooks.js";
import { change, chat, featById, migrated, runAsync } from "../core/utils.js";

/*
 * Шаблон автоматизации. Скопируйте в classes/, subclasses/, species/ или feats/
 * (имя файла: <класс>.js, <класс>-<подкласс>.js, <вид>.js, <черта>.js), поправьте пути импорта
 * на "../../core/..." и подключите в automations/index.js.
 *
 * Правила:
 * - id уникален и не меняется: он ключ настройки «включено» в настройках модуля;
 * - предметы ищем по system.identifier (featById), а не по имени — имена бывают переведены;
 * - статичные id активностей и эффектов — ровно 16 символов, чтобы миграция была идемпотентной;
 * - migrate() выполняет только активный ГМ; каждое изменение помечаем флагом `<ключ>Migrated`;
 * - связи с другими автоматизациями — через экспортируемые API/хуки (см. rogue.js, wizard.js, sorcerer.js);
 * - на события подписываемся через ядро (core/hooks.js): onItemUse, onActivityUse, onPreAttackRoll,
 *   onPreDamageRoll — так на каждое действие в мире работает один общий слушатель, а не по одному на умение;
 * - дополнительный урон (кара, скрытая атака и т.п.) — через registerDamageBonusProvider из core/damage-bonus.js:
 *   все бонусы попадают в одно окно вопроса вместо нескольких подряд.
 */

const IDS = {
  use: "faExampleUse0000",
  effect: "faExampleEffect0",
};

export default {
  id: "example-feat",
  kind: "feat", // "class" | "subclass" | "species" | "feat"
  label: "Пример черты",
  hint: "Что делает автоматизация — видно в настройках модуля.",
  identifiers: ["example-feat"],

  async migrate(actor) {
    const feat = featById(actor, "example-feat");
    if (!feat || migrated(feat, "exampleMigrated")) return;
    await feat.update({
      [`system.activities.${IDS.use}`]: {
        _id: IDS.use,
        type: "utility",
        name: "Использовать",
        activation: { type: "bonus", value: 1, override: false },
        consumption: { targets: [], spellSlot: false, scaling: { allowed: false } },
        effects: [{ _id: IDS.effect }],
      },
      [`flags.${MODULE_ID}.exampleMigrated`]: MIGRATION_VERSION,
    });
    if (!feat.effects.has(IDS.effect)) {
      await feat.createEmbeddedDocuments("ActiveEffect", [{
        _id: IDS.effect,
        name: "Пример",
        img: feat.img,
        transfer: false,
        system: { changes: [change("system.attributes.ac.bonus", "add", "+ 1")] },
      }], { keepId: true });
    }
    console.log(`${LOG} пример у ${actor.name}`);
  },

  register() {
    onActivityUse(IDS.use, (activity) => runAsync("пример", () => chat(activity.item.actor, "<p>Пример сработал.</p>")));
  },
};
