export const MODULE_ID = "features-automation";
export const LOG = "[features-automation]";

/** Версия миграций данных: флаги `<ключ>Migrated` ниже этой версии запускают миграцию заново */
export const MIGRATION_VERSION = 1;

/** Маркер повторного вызова activity.use, чтобы собственные хуки не перехватывали его ещё раз */
export const BYPASS = "featuresAutomationBypass";
