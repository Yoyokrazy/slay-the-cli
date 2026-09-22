import type { CardDef } from "./defs";

export function needsEnemyTarget(target: CardDef["target"] | undefined): boolean {
  return target === "enemy" || target === "selfandenemy";
}
