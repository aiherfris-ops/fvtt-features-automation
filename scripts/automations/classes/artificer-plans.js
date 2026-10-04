/*
 * Чертежи магических предметов изобретателя (Eberron: Forge of the Artificer, 2025).
 *
 * Списки и настройка переписаны из таблиц «Magic Item Plans» книги, прогрессия — из таблицы класса:
 * чертежей 4/5/6/7/8 и предметов 2/3/4/5/6 на уровнях 2/6/10/14/18.
 *
 * Поля чертежа:
 *   name   — название предмета для поиска (как в книге, с плюсом: «+1 Shield»);
 *   source — книга, нужна Плютониуму, чтобы взять ровно этот предмет;
 *   label  — как показываем игроку;
 *   attune — нужна ли настройка;
 *   any    — строка-подстановка «любой предмет такого-то вида»: предмет выбирает игрок,
 *            когда создаёт его по этому чертежу.
 */

const plan = (name, source, attune, label) => ({ name, source, attune, label: label ?? name });

export const PLAN_TIERS = [
  {
    level: 2,
    title: "Чертежи 2-го уровня",
    plans: [
      plan("Alchemy Jug", "XDMG", false),
      plan("Bag of Holding", "XDMG", false),
      plan("Cap of Water Breathing", "XDMG", false),
      { any: "common", attune: "varies", label: "Любой обычный магический предмет (не зелье, не свиток, не проклятый)" },
      plan("Goggles of Night", "XDMG", false),
      plan("Manifold Tool", "EFA", true),
      plan("Repeating Shot", "EFA", true),
      plan("Returning Weapon", "EFA", false),
      plan("Rope of Climbing", "XDMG", false),
      plan("Sending Stones", "XDMG", false),
      plan("+1 Shield", "XDMG", false, "Shield +1"),
      plan("Wand of Magic Detection", "XDMG", false),
      plan("Wand of Secrets", "XDMG", false),
      plan("+1 Wand of the War Mage", "XDMG", true, "Wand of the War Mage +1"),
      plan("+1 Weapon", "XDMG", false, "Weapon +1"),
      plan("+1 Wraps of Unarmed Power", "XDMG", false, "Wraps of Unarmed Power +1"),
    ],
  },
  {
    level: 6,
    title: "Чертежи 6-го уровня",
    plans: [
      plan("+1 Armor", "XDMG", false, "Armor +1"),
      plan("Boots of Elvenkind", "XDMG", false),
      plan("Boots of the Winding Path", "EFA", true),
      plan("Cloak of Elvenkind", "XDMG", true),
      plan("Cloak of the Manta Ray", "XDMG", true),
      plan("Dazzling Weapon", "EFA", true),
      plan("Eyes of Charming", "XDMG", true),
      plan("Eyes of Minute Seeing", "XDMG", false),
      plan("Gloves of Thievery", "XDMG", false),
      plan("Helm of Awareness", "EFA", false),
      plan("Lantern of Revealing", "XDMG", false),
      plan("Mind Sharpener", "EFA", true),
      plan("Necklace of Adaptation", "XDMG", true),
      plan("Pipes of Haunting", "XDMG", false),
      plan("Repulsion Shield", "EFA", false),
      plan("Ring of Swimming", "XDMG", false),
      plan("Ring of Water Walking", "XDMG", false),
      plan("Sentinel Shield", "XDMG", false),
      plan("Spell-Refueling Ring", "EFA", true),
      plan("Wand of Magic Missiles", "XDMG", false),
      plan("Wand of Web", "XDMG", true),
      plan("Weapon of Warning", "XDMG", true),
    ],
  },
  {
    level: 10,
    title: "Чертежи 10-го уровня",
    plans: [
      plan("Armor of Resistance", "XDMG", true),
      plan("Dagger of Venom", "XDMG", false),
      plan("Elven Chain", "XDMG", false),
      plan("Ring of Feather Falling", "XDMG", true),
      plan("Ring of Jumping", "XDMG", true),
      plan("Ring of Mind Shielding", "XDMG", true),
      plan("+2 Shield", "XDMG", false, "Shield +2"),
      { any: "uncommon-wondrous", attune: "varies", label: "Любой необычный чудесный предмет (не проклятый)" },
      plan("+2 Wand of the War Mage", "XDMG", true, "Wand of the War Mage +2"),
      plan("+2 Weapon", "XDMG", false, "Weapon +2"),
      plan("+2 Wraps of Unarmed Power", "XDMG", false, "Wraps of Unarmed Power +2"),
    ],
  },
  {
    level: 14,
    title: "Чертежи 14-го уровня",
    plans: [
      plan("+2 Armor", "XDMG", false, "Armor +2"),
      plan("Arrow-Catching Shield", "XDMG", true),
      plan("Flame Tongue", "XDMG", true),
      { any: "rare-wondrous", attune: "varies", label: "Любой редкий чудесный предмет (не проклятый)" },
      plan("Ring of Free Action", "XDMG", true),
      plan("Ring of Protection", "XDMG", true),
      plan("Ring of the Ram", "XDMG", true),
    ],
  },
];

/** Сколько чертежей знает и сколько предметов может держать изобретатель такого уровня */
export function limits(level) {
  if (level < 2) return { plans: 0, items: 0 };
  const step = Math.floor((Math.min(level, 20) - 2) / 4);
  return { plans: 4 + step, items: 2 + step };
}

/** Ярусы, доступные на этом уровне */
export const tiersFor = level => PLAN_TIERS.filter(tier => tier.level <= level);

/** Все доступные чертежи одним списком */
export const plansFor = level => tiersFor(level).flatMap(tier => tier.plans);

/** Ключ чертежа: по нему сверяем выбор и ищем уже заведённые */
export const planKey = p => (p.any ? `any:${p.any}` : `${p.name}|${p.source}`);
