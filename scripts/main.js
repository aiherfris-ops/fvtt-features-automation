import { LOG, MODULE_ID } from "./core/constants.js";
import { registerMigrationSettings, shouldMigrate } from "./core/migration-scope.js";
import { AutomationRegistry } from "./core/registry.js";
import automations from "./automations/index.js";

/*
 * Features Automation — автоматизация классов, подклассов, видов и черт dnd5e.
 * Каждая автоматизация — отдельный файл в scripts/automations/, список — automations/index.js.
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
  registerMigrationSettings();
  registry.registerSettings();
});

// Настройки мира доступны с setup — регистрируем хуки только включённых автоматизаций
Hooks.once("setup", () => registry.registerHooks());

registry.watch();

globalThis.featuresAutomation = Object.assign(globalThis.featuresAutomation ?? {}, {
  registry,
  shouldMigrate,
  // Ручной запуск проверки данных из макроса: featuresAutomation.runMigration()
  // или только для выбранных: featuresAutomation.runMigration({ actors: ["Вайлор Морн"] })
  runMigration: (options) => registry.migrateAll({ force: true, ...options }),
});
console.log(`${LOG} загружено автоматизаций: ${automations.length}`);
