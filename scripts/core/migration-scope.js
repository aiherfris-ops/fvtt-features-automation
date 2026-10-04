import { LOG, MODULE_ID } from "./constants.js";

/*
 * Кого проверять при загрузке мира. Список персонажей настраивается для каждого игрока отдельно:
 * по умолчанию это назначенный игроку персонаж (User → Персонаж), копии и прочих актёров
 * добавляют галочками в меню «Персонажи игроков». Настройка общая: spell-automation
 * спрашивает этот же фильтр через globalThis.featuresAutomation.shouldMigrate.
 */

export const SCOPES = {
  active: "Персонажи игроков в сети",
  players: "Персонажи всех игроков",
  all: "Все актёры мира",
  manual: "Не проверять автоматически",
};

export const migrationScope = () => {
  try {
    const scope = game.settings.get(MODULE_ID, "migration-scope");
    return scope in SCOPES ? scope : "active";
  } catch (err) {
    return "active";
  }
};

// ГМ тоже получает список: персонажи, которыми владеет только он (ведомые ГМом, как Вайлор Морн)
const players = () => game.users.filter(() => true);

const savedLists = () => {
  try { return game.settings.get(MODULE_ID, "migration-players") ?? {}; }
  catch (err) { return {}; }
};

/** Персонажи игрока: сохранённый список или, если игрока ещё не настраивали, назначенный ему персонаж */
export function playerActorIds(user, lists = savedLists()) {
  if (Array.isArray(lists[user.id])) return lists[user.id];
  return user.character ? [user.character.id] : [];
}

/** id актёров, которых проверяет режим */
export function actorIdsFor(scope = migrationScope()) {
  const lists = savedLists();
  // Проверку выполняет активный ГМ, поэтому списки ГМов учитываются всегда
  const users = scope === "active" ? players().filter(u => u.active || u.isGM) : players();
  return new Set(users.flatMap(u => playerActorIds(u, lists)));
}

/** Нужно ли проверять данные этого актёра */
export function shouldMigrate(actor, scope = migrationScope()) {
  if (scope === "manual") return false;
  if (scope === "all") return true;
  return actorIdsFor(scope).has(actor.id);
}

/* Меню: для каждого игрока — его персонажи с галочками */

const escape = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/*
 * Foundry 14 принимает в registerMenu только FormApplication или ApplicationV2, поэтому
 * наследуемся от ApplicationV2. Своего окна у меню нет — настройка показывается диалогом.
 */
class MigrationPlayersMenu extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = { id: `${MODULE_ID}-migration-players` };

  async render() {
    const lists = savedLists();
    const characters = game.actors.contents.filter(a => a.type === "character")
      .sort((a, b) => a.name.localeCompare(b.name));

    const sections = players().map(user => {
      const checked = new Set(playerActorIds(user, lists));
      // Сначала персонажи, которыми игрок владеет, затем уже отмеченные вручную прочие
      // ГМ владеет всеми — ему показываем только персонажей без владельца-игрока
      const owned = characters.filter(a => checked.has(a.id) || (user.isGM
        ? !game.users.some(u => !u.isGM && a.testUserPermission(u, "OWNER"))
        : a.testUserPermission(user, "OWNER")));
      const rows = owned.map(a => `<label style="display:flex;align-items:center;gap:.5em;margin:.15em 0 .15em 1.2em">
        <input type="checkbox" name="${user.id}" value="${a.id}" ${checked.has(a.id) ? "checked" : ""}>
        <img src="${escape(a.img)}" width="24" height="24" style="border:none">
        <span>${escape(a.name)}</span>
        ${user.character?.id === a.id ? '<em style="opacity:.6;margin-left:auto">назначен</em>' : ""}
      </label>`).join("") || '<p style="margin:.2em 0 .2em 1.2em;opacity:.6"><em>нет персонажей</em></p>';
      const status = user.active ? '<span style="color:#3c3">● в сети</span>' : '<span style="opacity:.5">○ не в сети</span>';
      return `<fieldset style="margin:.4em 0;padding:.3em .5em">
        <legend><strong>${escape(user.name)}</strong>${user.isGM ? " (ГМ)" : ""} ${status}</legend>${rows}</fieldset>`;
    }).join("");

    const picked = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Проверка данных: персонажи игроков" },
      position: { width: 460 },
      content: "<p>Отметьте, чьи данные проверять для каждого игрока. Для ещё не настроенных игроков "
        + "проверяется только назначенный им персонаж.</p>"
        + `<div style="max-height:480px;overflow-y:auto">${sections}</div>`,
      ok: {
        label: "Сохранить",
        callback: (event, button) => Object.fromEntries(players().map(user => [
          user.id,
          [...button.form.querySelectorAll(`input[name="${user.id}"]:checked`)].map(i => i.value),
        ])),
      },
      rejectClose: false,
    });
    if (!picked) return this;
    await game.settings.set(MODULE_ID, "migration-players", picked);
    const total = new Set(Object.values(picked).flat()).size;
    ui.notifications.info(`Проверка данных: сохранено, персонажей в списках — ${total}.`);
    return this;
  }

  /** Закрывать нечего: окно не открывалось */
  async close() { return this; }
}

export function registerMigrationSettings() {
  game.settings.register(MODULE_ID, "migration-scope", {
    name: "Проверка данных: кого проверять",
    hint: "При загрузке мира модуль чинит данные умений (импорт Plutonium оставляет их неполными). "
      + "Списки персонажей для каждого игрока — в меню «Персонажи игроков».",
    scope: "world",
    config: true,
    type: String,
    choices: SCOPES,
    default: "active",
  });

  game.settings.register(MODULE_ID, "migration-players", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });

  game.settings.registerMenu(MODULE_ID, "migration-players-menu", {
    name: "Проверка данных: персонажи игроков",
    label: "Персонажи игроков",
    hint: "Для каждого игрока — какие персонажи проверяются. По умолчанию только назначенный игроку.",
    icon: "fa-solid fa-users-gear",
    type: MigrationPlayersMenu,
    restricted: true,
  });

  console.log(`${LOG} режим проверки данных: ${SCOPES[migrationScope()]}`);
}
