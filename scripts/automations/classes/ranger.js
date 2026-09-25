import { registerFreeCastLink } from "../../core/free-cast.js";

/** Рейнджер 2024 */
export default {
  id: "ranger",
  kind: "class",
  label: "Рейнджер",
  hint: "Favored Enemy: каст Hunter's Mark за заряд умения вместо ячейки.",

  register() {
    registerFreeCastLink({
      feature: /favored\s+(enemy|foe)|избранн\S*\s+враг/i,
      spell: /hunter'?s?\s+mark|метк\S*\s+охотник\S*/i,
    });
  },
};
