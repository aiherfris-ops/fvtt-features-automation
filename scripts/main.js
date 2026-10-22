import { LOG, MODULE_ID } from "./core/constants.js";
import { installGearConditions } from "./core/gear.js";
import { registerMigrationSettings, shouldMigrate } from "./core/migration-scope.js";
import { installQueries } from "./core/midi.js";
import { AutomationRegistry } from "./core/registry.js";
import { report } from "./core/report.js";
import { dismissReplicated, replicatedItems } from "./automations/classes/artificer.js";
import { ensureWorldItems, createHolySymbol } from "./items/index.js";
import automations from "./automations/index.js";

/*
 * Features Automation — автоматизация классов, подклассов, видов и черт dnd5e.
 * Каждая автоматизация — отдельный файл в scripts/automations/, список — automations/index.js.
 * Ветка под midi-qol: рабочий процесс, спасброски и урон берутся из его workflow (core/midi.js).
 */

const registry = new AutomationRegistry(automations);

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "debug-chat", {
    name: "Отладка в чат",
    hint: "Шептать в чат причину, по которой автоматизация не сработала (выключи, когда всё заработает)",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.register(MODULE_ID, "create-items", {
    name: "Заводить предметы модуля в мире",
    hint: "При загрузке мира недостающие предметы модуля (например «Символ непреклонного света») "
      + "появляются в папке «Предметы автоматизации» на вкладке предметов. Каждый — один раз: "
      + "удалённый предмет заново не создаётся.",
    scope: "world", config: true, type: Boolean, default: true,
  });
  // Что уже заводили: ключи предметов из items/index.js
  game.settings.register(MODULE_ID, "seeded-items", { scope: "world", config: false, type: Array, default: [] });
  game.settings.register(MODULE_ID, "migration-report", {
    name: "Сообщать о проверке данных",
    hint: "После проверки данных (при загрузке мира и по команде) показывать ГМу итог: у скольких персонажей "
      + "прогнаны автоматизации. «Только при изменениях» — молчит, когда прогонять нечего.",
    scope: "world", config: true, type: String, default: "changes",
    choices: { off: "Молча", changes: "Только при изменениях", always: "Всегда" },
  });
  registerMigrationSettings();
  registry.registerSettings();
  installQueries();
});

// Настройки мира доступны с setup — регистрируем хуки только включённых автоматизаций
Hooks.once("setup", () => {
  if (!game.modules.get("midi-qol")?.active) {
    ui.notifications.error("Features Automation (ветка midiqol) работает только вместе с midi-qol.");
    console.error(`${LOG} midi-qol не найден: эта сборка без него не работает`);
    return;
  }
  registry.registerHooks();
  installGearConditions();
});

registry.watch();

// Предметы модуля заводятся сами: ГМу не нужно помнить про макрос
Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  let enabled = true;
  try { enabled = game.settings.get(MODULE_ID, "create-items") !== false; } catch (err) { /* настройки ещё не готовы */ }
  if (!enabled) return;
  ensureWorldItems().catch(err => console.error(`${LOG} предметы модуля:`, err));
});

globalThis.featuresAutomation = Object.assign(globalThis.featuresAutomation ?? {}, {
  registry,
  shouldMigrate,
  // Ручной запуск проверки данных из макроса: featuresAutomation.runMigration()
  // или только для выбранных: featuresAutomation.runMigration({ actors: ["Вайлор Морн"] })
  runMigration: (options) => registry.migrateAll({ force: true, ...options }),
  // Подробный отчёт: кому что применилось, у всех ли подключён макрос бонусов урона
  report,
  // Создать «Символ непреклонного света»: в предметы мира или сразу жрецу
  createHolySymbol,
  // Завести недостающие предметы модуля вручную: featuresAutomation.createItems({ force: true })
  createItems: ensureWorldItems,
  // Развоплотить всё, созданное изобретателем по чертежам
  dismissReplicated,
  replicatedItems,
});
console.log(`${LOG} загружено автоматизаций: ${automations.length}`);
