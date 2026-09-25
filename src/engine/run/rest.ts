// Rest site: Rest heals 30% of max HP rounded down; Smith upgrades one
// upgradable deck card. (No ascension level changes rest healing; A5 only
// changes the BOSS-transition heal, handled in runFlow.)

import type { EffectCtx } from "../content/defs";
import type { MasterCard } from "./runState";
import { fireHook, foldHook } from "../core/hooks";
import { PLAYER } from "../core/ids";

export const REST = { healFraction: 0.3 } as const;

export function restHealAmount(maxHp: number): number {
  return Math.floor(maxHp * REST.healFraction);
}

/** CampfireSleepEffect: player.heal(amount), so the heal goes through the
 *  relics' onPlayerHeal (Mark of the Bloom zeroes it). */
export function applyRest(ctx: EffectCtx): void {
  const run = ctx.run;
  const healed = Math.floor(foldHook(ctx, PLAYER, "onHeal", restHealAmount(run.maxHp)));
  if (healed > 0) run.hp = Math.min(run.maxHp, run.hp + healed);
  fireHook(ctx, PLAYER, "onRest");
}

/** A deck card can be smithed if never upgraded, or if it multi-upgrades. */
export function canSmith(ctx: EffectCtx, deckIdx: number): boolean {
  const mc = ctx.run.deck[deckIdx];
  if (!mc) return false;
  const def = ctx.bundle.cards.get(mc.defId);
  if (!def) return false;
  if (def.type === "curse" || def.type === "status") return false;
  return mc.upgrades === 0 || def.keywords.includes("multiUpgrade");
}

export function applySmith(ctx: EffectCtx, deckIdx: number): void {
  if (!canSmith(ctx, deckIdx)) throw new Error(`deck card ${deckIdx} cannot be upgraded`);
  ctx.run.deck[deckIdx]!.upgrades++;
  fireHook(ctx, PLAYER, "onSmith");
}

/** CardGroup.getPurgeableCards leaves these three out of every removal. */
const UNPURGEABLE: ReadonlySet<string> = new Set(["NECRONOMICURSE", "CURSE_OF_THE_BELL", "ASCENDERS_BANE"]);

/** Peace Pipe's TOKE list: getGroupWithoutBottledCards(getPurgeableCards()). */
export function tokeableIndices(deck: readonly MasterCard[]): number[] {
  return deck.map((_, i) => i).filter((i) => !deck[i]!.bottled && !UNPURGEABLE.has(deck[i]!.defId));
}
