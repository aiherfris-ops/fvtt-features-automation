/**
 * Все автоматизации модуля. Чтобы добавить новую — создайте файл в нужной папке
 * (classes/, subclasses/, species/, feats/, rules/) по образцу _template.js и допишите его сюда.
 * Порядок важен только для зависимостей: класс раньше своих подклассов.
 */

import artificer from "./classes/artificer.js";
import paladin from "./classes/paladin.js";
import psion from "./classes/psion.js";
import ranger from "./classes/ranger.js";
import rogue from "./classes/rogue.js";
import sorcerer from "./classes/sorcerer.js";
import wizard from "./classes/wizard.js";

import artificerAlchemist from "./subclasses/artificer-alchemist.js";
import paladinVengeance from "./subclasses/paladin-vengeance.js";
import psionMetamorph from "./subclasses/psion-metamorph.js";
import rogueArachnoidStalker from "./subclasses/rogue-arachnoid-stalker.js";
import sorcererWildMagic from "./subclasses/sorcerer-wild-magic.js";
import wizardBladesinger from "./subclasses/wizard-bladesinger.js";

import aasimar from "./species/aasimar.js";
import gnome from "./species/gnome.js";
import tortle from "./species/tortle.js";

import altered from "./feats/altered.js";
import fightingStyleDueling from "./feats/fighting-style-dueling.js";
import survivor from "./feats/survivor.js";

import weaponMastery from "./rules/weapon-mastery.js";

export default [
  // Классы
  artificer,
  paladin,
  psion,
  ranger,
  rogue,
  sorcerer,
  wizard,

  // Подклассы
  artificerAlchemist,
  paladinVengeance,
  psionMetamorph,
  rogueArachnoidStalker,
  sorcererWildMagic,
  wizardBladesinger,

  // Виды
  aasimar,
  gnome,
  tortle,

  // Черты
  altered,
  fightingStyleDueling,
  survivor,

  // Общие правила
  weaponMastery,
];
