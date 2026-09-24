// Power application/stacking/removal with the game's exact rules:
//  - Artifact on the target negates a debuff application (decrement artifact).
//  - "intensity" stacking adds amounts (clamped to ±999); "duration" adds turns;
//    "none" refreshes/ignores.
//  - justApplied: turn-based debuffs applied to the PLAYER by a MONSTER skip
//    their first end-of-round tick (the source-based rule the game uses via
//    isSourceMonster in power constructors - e.g. Fungi Beast's death cloud).

import type { ActorRef } from "../core/ids";
import type { EffectCtx } from "../content/defs";
import type { PowerInstance } from "./combatState";
import { fireHook, vetoHook } from "../core/hooks";
import { sameActor } from "../core/ids";

const AMOUNT_CAP = 999;

function powersOf(ctx: EffectCtx, actor: ActorRef): PowerInstance[] {
  return actor.kind === "player" ? ctx.combat!.player.powers : ctx.combat!.monsters[actor.idx]!.powers;
}

export function getPower(ctx: EffectCtx, actor: ActorRef, powerId: string): PowerInstance | undefined {
  return powersOf(ctx, actor).find((p) => p.id === powerId);
}

export function getPowerAmount(ctx: EffectCtx, actor: ActorRef, powerId: string): number {
  return getPower(ctx, actor, powerId)?.amount ?? 0;
}

function powerPriority(ctx: EffectCtx, powerId: string): number {
  return ctx.bundle.powers.get(powerId)?.priority ?? 5;
}

function sortPowers(ctx: EffectCtx, powers: PowerInstance[]): void {
  powers.sort((a, b) => powerPriority(ctx, a.id) - powerPriority(ctx, b.id));
}

function clampedAmount(amount: number): number {
  return Math.max(-AMOUNT_CAP, Math.min(AMOUNT_CAP, amount));
}

function coalesceStackablePower(ctx: EffectCtx, powers: PowerInstance[], powerId: string): PowerInstance | undefined {
  const def = ctx.bundle.powers.get(powerId);
  const matching = powers.filter((p) => p.id === powerId);
  if (matching.length <= 1) return matching[0];
  if ((def?.stacking !== "intensity" && def?.stacking !== "duration") || matching.some((p) => p.data !== null)) {
    return matching[0];
  }

  const keep = matching[0]!;
  keep.amount = clampedAmount(matching.reduce((sum, p) => sum + p.amount, 0));
  keep.justApplied = matching.some((p) => p.justApplied);
  for (let i = powers.length - 1; i >= 0; i--) {
    const p = powers[i]!;
    if (p.id === powerId && p !== keep) powers.splice(i, 1);
  }
  return keep;
}

export function applyPower(
  ctx: EffectCtx,
  source: ActorRef | null,
  target: ActorRef,
  powerId: string,
  amount: number,
): void {
  const def = ctx.bundle.powers.get(powerId);
  if (!def) throw new Error(`unknown power: ${powerId}`);
  const powers = powersOf(ctx, target);

  // target-side veto BEFORE artifact (Ginger/Turnip block Weak/Frail without consuming Artifact)
  if (!vetoHook(ctx, target, "onApplyPower", powerId, target, source)) {
    ctx.emit("powerVetoed", { target, powerId });
    return;
  }

  // Artifact negation: debuffs, and negative applications of can-go-negative
  // buffs (Disarm's -Strength counts as a debuff for Artifact, as in the game)
  const isDebuffApplication = def.kind === "debuff" || (def.canGoNegative === true && amount < 0);
  if (isDebuffApplication) {
    const artifact = powers.find((p) => p.id === "ARTIFACT");
    if (artifact && artifact.amount > 0) {
      artifact.amount--;
      if (artifact.amount <= 0) removePower(ctx, target, "ARTIFACT");
      ctx.emit("artifactNegated", { target, powerId });
      return;
    }
  }

  const justApplied =
    def.turnBased && target.kind === "player" && source !== null && source.kind === "monster";

  const existing = coalesceStackablePower(ctx, powers, powerId);
  if (existing) {
    if (def.stacking === "intensity" || def.stacking === "duration") {
      existing.amount = clampedAmount(existing.amount + amount);
      if (!def.canGoNegative && existing.amount <= 0 && def.stacking === "intensity") {
        removePower(ctx, target, powerId);
        return;
      }
    }
    // "none": no restack
  } else {
    powers.push({ id: powerId, amount, justApplied, data: null });
    sortPowers(ctx, powers);
    def.onApply?.(ctx, target, amount);
  }
  // source-side notification AFTER a successful application (Champion Belt)
  if (source && !sameActor(source, target)) {
    fireHook(ctx, source, "onApplyPower", powerId, target, source);
  }
  ctx.emit("powerApplied", { target, powerId, amount });
}

export function reducePower(ctx: EffectCtx, target: ActorRef, powerId: string, amount: number): void {
  const powers = powersOf(ctx, target);
  const p = coalesceStackablePower(ctx, powers, powerId);
  if (!p) return;
  p.amount -= amount;
  if (p.amount <= 0) removePower(ctx, target, powerId);
}

export function removePower(ctx: EffectCtx, target: ActorRef, powerId: string): void {
  const powers = powersOf(ctx, target);
  const idx = powers.findIndex((p) => p.id === powerId);
  if (idx === -1) return;
  const def = ctx.bundle.powers.get(powerId);
  powers.splice(idx, 1);
  def?.onRemove?.(ctx, target);
  ctx.emit("powerRemoved", { target, powerId });
}

/** End-of-round duration ticks for turn-based powers on one actor. */
export function tickTurnBasedPowers(ctx: EffectCtx, actor: ActorRef): void {
  const powers = powersOf(ctx, actor);
  for (const p of [...powers]) {
    const def = ctx.bundle.powers.get(p.id);
    if (!def?.turnBased) continue;
    if (p.justApplied) {
      p.justApplied = false;
      continue;
    }
    p.amount--;
    if (p.amount <= 0) removePower(ctx, actor, p.id);
  }
  fireHook(ctx, actor, "atEndOfRound");
}
