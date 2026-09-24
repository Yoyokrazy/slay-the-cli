// Powers introduced by act-1 monsters (beyond powers/core.ts). Audited against
// data/corpus/monsters-act1.json. SHARP_HIDE is owned by the act-3 workstream
// (The Guardian only applies it when the bundle carries it).
//
// ENGINE-GAP: the interpreter's `loseHp` action on a MONSTER target does not
// fire the wasHPLost hook (only unblocked attack damage does), so direct HP
// loss from cards would not wake Lagavulin, tick Mode Shift, or trigger slime
// splits. Attack damage - the overwhelmingly common path - behaves exactly.

import type { EffectCtx, EffectFn, PowerDef } from "../../engine/content/defs";
import { replaceIntent } from "../monsters/act1/_shared";

function guardianDefensiveModeShift(ctx: EffectCtx, args?: unknown): void {
  if (!args || typeof args !== "object" || !("idx" in args) || typeof args.idx !== "number") return;
  const target = { kind: "monster" as const, idx: args.idx };
  const m = ctx.combat!.monsters[target.idx];
  if (!m || m.isDead || m.isEscaped) return;
  replaceIntent(m, "THE_GUARDIAN_DEFENSIVE_MODE");
  ctx.queue.addToBottom({ kind: "removePower", target, powerId: "MODE_SHIFT" });
  ctx.queue.addToBottom({ kind: "gainBlock", target, amount: 20, fromCard: false });
}

export const act1MonsterEffects: ReadonlyArray<readonly [string, EffectFn]> = [
  ["act1/guardianDefensiveModeShift", guardianDefensiveModeShift],
];

/** Monster id -> its split move id (Split power interrupt targets). */
const SPLIT_MOVES: Record<string, string> = {
  ACID_SLIME_L: "ACID_SLIME_L_SPLIT",
  SPIKE_SLIME_L: "SPIKE_SLIME_L_SPLIT",
  SLIME_BOSS: "SLIME_BOSS_SPLIT",
};

export const act1MonsterPowers: PowerDef[] = [
  {
    // Red Slaver's Entangle: the player cannot play Attacks this turn.
    id: "ENTANGLED",
    name: "Entangled",
    kind: "debuff",
    stacking: "duration",
    turnBased: true,
    hooks: {
      canPlayCard: (ctx, card) => ctx.bundle.cards.get(card.defId)?.type !== "attack",
    },
  },
  {
    // Looter/Mugger marker: gold stolen per attack (15; asc>=17: 20). The steal
    // itself is executed by the thief's attack moves reading this amount.
    id: "THIEVERY",
    name: "Thievery",
    kind: "buff",
    stacking: "intensity",
    turnBased: false,
    hooks: {},
  },
  {
    // Lagavulin: any HP loss while asleep wakes it - ASLEEP removed and
    // METALLICIZE reduced by 8 (corpus adjudication: metallicize is lost on
    // BOTH wake paths; the natural turn-3 wake is handled in LAGAVULIN_SLEEP).
    // The already-queued SLEEP move still executes that turn.
    id: "ASLEEP",
    name: "Asleep",
    kind: "buff",
    stacking: "none",
    turnBased: false,
    hooks: {
      wasHPLost: (ctx) => {
        if (ctx.owner.kind !== "monster") return;
        // addToTop order: ASLEEP removal runs first, then the metallicize cut,
        // both before any further queued damage action.
        ctx.queue.addToTop({ kind: "reducePower", target: ctx.owner, powerId: "METALLICIZE", amount: 8 });
        ctx.queue.addToTop({ kind: "removePower", target: ctx.owner, powerId: "ASLEEP" });
      },
    },
  },
  {
    // The Guardian: amount is the live damage countdown. On every HP loss while
    // open the counter drops by the amount lost; at <= 0 the state-change action
    // is queued behind already-pending actions. When it resolves it swaps the
    // intent to DEFENSIVE_MODE, then queues MODE_SHIFT removal and 20 block.
    id: "MODE_SHIFT",
    name: "Mode Shift",
    kind: "buff",
    stacking: "intensity",
    turnBased: false,
    hooks: {
      wasHPLost: (ctx, _info, amount) => {
        if (ctx.owner.kind !== "monster") return;
        const p = ctx.power!;
        if (p.amount <= 0) return;
        p.amount -= amount;
        if (p.amount > 0) return;
        ctx.queue.addToBottom({ kind: "effect", ref: "act1/guardianDefensiveModeShift", args: { idx: ctx.owner.idx } });
      },
    },
  },
  {
    // Large slimes / Slime Boss: at <= 50% max HP the current intent is
    // immediately replaced with the SPLIT move (exactly once - the monster
    // leaves combat when SPLIT executes).
    id: "SPLIT",
    name: "Split",
    kind: "buff",
    stacking: "none",
    turnBased: false,
    hooks: {
      wasHPLost: (ctx) => {
        if (ctx.owner.kind !== "monster") return;
        const m = ctx.combat!.monsters[ctx.owner.idx]!;
        if (m.isDead || m.hp <= 0) return; // overkill: death wins over split
        if (m.hp > Math.floor(m.maxHp / 2)) return;
        const splitMove = SPLIT_MOVES[m.id];
        if (!splitMove || m.move === splitMove) return;
        if (ctx.combat!.playerTurn) replaceIntent(m, splitMove);
        // own-turn HP loss (thorns): getMove re-checks the threshold after the
        // move executes and returns the split move itself.
      },
    },
  },
];
