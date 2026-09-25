import type { EffectCtx, MasterDeckRemovalReason } from "../content/defs";
import type { CardId } from "../core/ids";
import type { MasterCard } from "./runState";
import { PLAYER } from "../core/ids";
import { fireHook, foldHook, vetoHook } from "../core/hooks";
import { classCardPool } from "./rewards";

export function obtainedCardUpgrades(ctx: EffectCtx, defId: CardId, upgrades: number): number {
  return Math.max(0, Math.floor(foldHook(ctx, PLAYER, "modifyObtainedCardUpgrades", upgrades, defId)));
}

/** ShowCardAndObtainEffect: Omamori negates before any relic's onObtainCard
 *  runs, so a negated curse pays no Ceramic Fish gold and no Darkstone HP. */
export function obtainDeckCard(ctx: EffectCtx, defId: CardId, upgrades = 0, misc = 0): boolean {
  if (!vetoHook(ctx, PLAYER, "canObtainCard", defId)) return false;
  fireHook(ctx, PLAYER, "onObtainCard", defId);
  const finalUpgrades = obtainedCardUpgrades(ctx, defId, upgrades);
  ctx.run.deck.push({ defId, upgrades: finalUpgrades, misc, bottled: false });
  return true;
}

export function removeDeckCard(ctx: EffectCtx, deckIdx: number, reason: MasterDeckRemovalReason = "remove"): MasterCard | null {
  if (deckIdx < 0 || deckIdx >= ctx.run.deck.length) return null;
  const [removed] = ctx.run.deck.splice(deckIdx, 1);
  if (!removed) return null;
  ctx.bundle.cards.get(removed.defId)?.onRemoveFromMasterDeck?.({ ...ctx, card: removed, reason });
  return removed;
}

export function removeDeckCards(ctx: EffectCtx, indices: number[], reason: MasterDeckRemovalReason = "remove"): MasterCard[] {
  const removed: MasterCard[] = [];
  for (const i of [...new Set(indices)].sort((a, b) => b - a)) {
    const card = removeDeckCard(ctx, i, reason);
    if (card) removed.push(card);
  }
  return removed;
}

export function transformDeckCard(ctx: EffectCtx, deckIdx: number, upgrades = 0, reason: MasterDeckRemovalReason = "transform"): boolean {
  const removed = removeDeckCard(ctx, deckIdx, reason);
  if (!removed) return false;
  const pool = [...classCardPool(ctx, "common"), ...classCardPool(ctx, "uncommon"), ...classCardPool(ctx, "rare")];
  if (pool.length > 0) {
    obtainDeckCard(ctx, pool[ctx.rng("miscRng").random(pool.length - 1)]!, upgrades);
  }
  return true;
}
