import { LOG } from "./constants.js";

/*
 * Диспетчеры хуков. Раньше каждая автоматизация вешала свой слушатель: на любое действие в мире
 * срабатывало полтора десятка обработчиков, каждый заново проверял «моё ли это умение».
 * Теперь на каждый хук один слушатель, а адресация идёт по ключу: идентификатору предмета или id активности.
 */

const byItem = new Map();      // system.identifier предмета → [handler]
const byActivity = new Map();  // id активности → [handler]
const byWorkflowItem = new Map(); // system.identifier → [handler] для завершённой цепочки Midi
const spellWorkflowHandlers = [];
const attackHandlers = [];
const damageHandlers = [];
let installed = false;
let midiInstalled = false;

const push = (map, key, handler) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(handler);
};

const run = (handlers, label, ...args) => {
  for (const handler of handlers ?? []) {
    try {
      const result = handler(...args);
      if (result instanceof Promise) result.catch(err => console.error(`${LOG} ${label}:`, err));
    } catch (err) {
      console.error(`${LOG} ${label}:`, err);
    }
  }
};

/** Использование активности предмета с таким `system.identifier` */
export function onItemUse(identifier, handler) {
  push(byItem, identifier, handler);
  install();
}

/** Использование конкретной активности (по её id) */
export function onActivityUse(activityId, handler) {
  push(byActivity, activityId, handler);
  install();
}

/** Перед броском атаки (config dnd5e) */
export function onPreAttackRoll(handler) {
  attackHandlers.push(handler);
  install();
}

/** Перед броском урона (config dnd5e) */
export function onPreDamageRoll(handler) {
  damageHandlers.push(handler);
  install();
}

/**
 * Цепочка Midi завершена (известны попадания, проваленные спасброски, цели) для предмета
 * с таким `system.identifier`. Обработчик получает (workflow, activity).
 */
export function onWorkflowComplete(identifier, handler) {
  push(byWorkflowItem, identifier, handler);
  installMidi();
}

/** Цепочка Midi завершена для любого заклинания */
export function onSpellWorkflowComplete(handler) {
  spellWorkflowHandlers.push(handler);
  installMidi();
}

function install() {
  if (installed) return;
  installed = true;

  Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) => {
    const identifier = activity?.item?.system?.identifier;
    if (byItem.has(identifier)) run(byItem.get(identifier), `использование ${identifier}`, activity, usageConfig, results);
    if (byActivity.has(activity?.id)) run(byActivity.get(activity.id), `активность ${activity.id}`, activity, usageConfig, results);
  });

  Hooks.on("dnd5e.preRollAttackV2", (config, dialog, message) => run(attackHandlers, "бросок атаки", config, dialog, message));
  Hooks.on("dnd5e.preRollDamageV2", (config, dialog, message) => run(damageHandlers, "бросок урона", config, dialog, message));
}

// Один и тот же workflow Midi может сообщить о завершении повторно — обрабатываем один раз
const seenWorkflows = new Set();

function installMidi() {
  if (midiInstalled) return;
  midiInstalled = true;
  Hooks.on("midi-qol.RollComplete", (workflow) => {
    const activity = workflow?.activity;
    const item = activity?.item;
    if (!item || workflow.aborted) return;
    const key = workflow.uuid ?? workflow.id;
    if (key) {
      if (seenWorkflows.has(key)) return;
      if (seenWorkflows.size > 500) seenWorkflows.clear();
      seenWorkflows.add(key);
    }
    const identifier = item.system?.identifier;
    if (byWorkflowItem.has(identifier)) run(byWorkflowItem.get(identifier), `завершение ${identifier}`, workflow, activity);
    if (item.type === "spell") run(spellWorkflowHandlers, "завершение заклинания", workflow, activity);
  });
}
