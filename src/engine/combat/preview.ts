// Hand-card display numbers - what the game prints on the card itself: the
// damage and block a card would actually produce right now, with Strength,
// Weak, Vulnerable-on-the-target, the stance multiplier and Frail already
// folded in.
//
// Same trick as intents.ts (and the same limits): DRY-RUN the card's own
// effects against a structuredClone of the state with a throwaway queue and a
// poisoned RNG, then read the enqueued actions without applying them. The
// numbers are final in the queue because calcCardDamage/calcBlock run at
// enqueue time. A card that rolls dice or asks a question part way through
// stops there and reports what it already queued (partial), exactly like a
// monster intent whose preview cannot finish.

import type { CardCtx, ContentBundle, EffectCtx } from "../content/defs";
import { needsEnemyTarget } from "../content/targeting";
import type { CardInstance } from "./combatState";
import { vetoHook } from "../core/hooks";
import { PLAYER } from "../core/ids";
import { ActionQueue } from "../core/queue";
import { effectiveCost } from "./interpreter";

function previewCost(ctx: EffectCtx, card: CardInstance): number {
  if (card.cost < 0) return card.cost;
  if (card.freeToPlayOnce) return 0;
  return effectiveCost(ctx, card);
}

/** Current energy cost without running hooks against the live state or RNG. */
export function getCardCost(
  state: { run: EffectCtx["run"]; combat: EffectCtx["combat"] },
  bundle: ContentBundle,
  card: CardInstance,
): number {
  const isolated = structuredClone({ run: state.run, combat: state.combat, card });
  return previewCost(previewCtx(isolated, bundle), isolated.card);
}

/** Hand availability uses the engine's guards, never plays the card or drains a queue. */
export function getCardPlayability(
  state: { run: EffectCtx["run"]; combat: EffectCtx["combat"] },
  bundle: ContentBundle,
  card: CardInstance,
): { cost: number; playable: boolean } {
  const isolated = structuredClone({ run: state.run, combat: state.combat, card });
  const { combat, card: c } = isolated;
  if (!combat || !combat.player.piles.hand.includes(c.iid)) {
    throw new Error("card playability preview requires a card in hand");
  }
  const def = bundle.cards.get(c.defId);
  if (!def) throw new Error(`unknown card def ${c.defId}`);
  const ctx = previewCtx(isolated, bundle);
  const cost = previewCost(ctx, c);
  if (c.cost === -2 || (!c.freeToPlayOnce && combat.player.energy < Math.max(0, cost))) {
    return { cost, playable: false };
  }
  const targets = needsEnemyTarget(def.target)
    ? combat.monsters.flatMap((m, i) => m.isDead || m.isEscaped || m.halfDead ? [] : [i])
    : [null];
  const usable = targets.some(target => !def.canUse || def.canUse({
    ...ctx, card: c, target, energyOnUse: combat.player.energy, upgraded: c.upgrades > 0,
  }));
  return { cost, playable: usable && vetoHook(ctx, PLAYER, "canPlayCard", c) };
}

export interface CardPreview {
  /** per-hit damage aimed at the previewed target (null = deals none) */
  damage: number | null;
  hits: number;
  /** block the card would give you */
  block: number;
  /** the dry-run stopped early: what is here is what the card does FIRST */
  partial: boolean;
}

/** Cards with no damage and no block value have nothing to preview, so they
 *  never pay for a clone (most powers and utility skills). */
function worthPreviewing(bundle: ContentBundle, card: CardInstance): boolean {
  const def = bundle.cards.get(card.defId);
  if (!def) return false;
  return def.values.damage !== undefined || def.values.block !== undefined;
}

export function computeCardPreview(ctx: EffectCtx, iid: number, targetIdx: number): CardPreview | null {
  const combat = ctx.combat;
  if (!combat) return null;
  const card = combat.cards[iid];
  if (!card || !worthPreviewing(ctx.bundle, card)) return null;
  const def = ctx.bundle.cards.get(card.defId);
  if (!def) return null;

  try {
    const combatClone = structuredClone(combat);
    const runClone = structuredClone(ctx.run);
    const queue = new ActionQueue();
    const cardClone = combatClone.cards[iid];
    if (!cardClone) return null;
    const dryCtx: CardCtx = {
      ...ctx,
      run: runClone,
      combat: combatClone,
      queue,
      rng: (() => {
        throw new Error("rng not available in card preview");
      }) as never,
      rt: { pending: null, currentItem: null, combatOver: null },
      emit: () => {},
      requestChoice: () => {
        throw new Error("choice not available in card preview");
      },
      card: cardClone,
      target: targetIdx,
      energyOnUse: combatClone.player.energy,
      upgraded: cardClone.upgrades > 0,
    };

    let partial = false;
    try {
      if (def.primitives) {
        const run = ctx.bundle.effects.get("__primitives");
        if (!run) throw new Error("primitives runner not registered");
        run(dryCtx, def);
      }
      def.onPlay?.(dryCtx);
    } catch {
      partial = true;
    }

    let damage: number | null = null;
    let hits = 0;
    let block = 0;
    for (let a = queue.pop(); a !== undefined; a = queue.pop()) {
      if (a.kind === "damage" && a.target.kind === "monster" && a.info.type === "attack") {
        damage = a.info.amount;
        hits++;
      } else if (a.kind === "damageAllMonsters" && a.info.type === "attack") {
        damage = a.amounts[targetIdx] ?? a.amounts[0] ?? 0;
        hits++;
      } else if (a.kind === "gainBlock" && a.target.kind === "player") {
        block += a.amount;
      }
    }
    if (damage === null && block === 0 && !partial) return null;
    return { damage, hits, block, partial };
  } catch {
    return null; // could not even clone the state: no preview, like the game's
  }
}

/** One card against one target (the targeting screen prices every candidate). */
export function previewCardAt(
  state: { run: EffectCtx["run"]; combat: EffectCtx["combat"] },
  bundle: ContentBundle,
  iid: number,
  targetIdx: number,
): CardPreview | null {
  if (!state.combat) return null;
  return computeCardPreview(previewCtx(state, bundle), iid, targetIdx);
}

/**
 * UI entry point: a preview per hand slot, computed from a bare GameState.
 * `targetIdx` is who the attacks are aimed at (Vulnerable lives on the target),
 * so the caller passes the hovered enemy - or the first living one.
 */
export function getCardPreviews(
  state: { run: EffectCtx["run"]; combat: EffectCtx["combat"] },
  bundle: ContentBundle,
  targetIdx: number,
): (CardPreview | null)[] {
  if (!state.combat) return [];
  const ctx = previewCtx(state, bundle);
  return state.combat.player.piles.hand.map((iid) => computeCardPreview(ctx, iid, targetIdx));
}

/** A read-only EffectCtx over a bare GameState: no rng, no choices, no emits. */
function previewCtx(
  state: { run: EffectCtx["run"]; combat: EffectCtx["combat"] },
  bundle: ContentBundle,
): EffectCtx {
  return {
    run: state.run,
    combat: state.combat,
    queue: new ActionQueue(),
    bundle,
    rt: { pending: null, currentItem: null, combatOver: null },
    rng: (() => {
      throw new Error("rng not available in card preview");
    }) as never,
    asc: state.run.ascension,
    emit: () => {},
    requestChoice: () => {
      throw new Error("choice not available in card preview");
    },
  };
}
