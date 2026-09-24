// Nemesis - exact port from data/corpus/monsters-act34.json (NEMESIS).
// Intangible cycle: after executing ANY move, if it is not currently
// Intangible it gains INTANGIBLE 2 (applied synchronously so the end-of-round
// duration tick lands the same round, i.e. intangible on every even turn).
// Java: Tri Burn makes 3 Burns, 5 at Ascension 18+.
// Java: scytheCooldown is decremented on each roll, set to 2 when Scythe is
// selected, and only blocks the immediately following roll; Scythe can recur
// after one intervening move.

import type { MonsterDef, EffectCtx } from "../../../engine/content/defs";
import type { MonsterState } from "../../../engine/combat/combatState";
import { applyPower } from "../../../engine/combat/powerRuntime";
import { monster } from "../../../engine/core/ids";
import { firstTurn, lastMove, lastTwoMovesWere } from "../../util";
import { attackPlayer, powerAmount } from "../act1/_shared";
import { statusCardsNow } from "./_shared";

const ATTACK = "NEMESIS_ATTACK";
const SCYTHE = "NEMESIS_SCYTHE";
const DEBUFF = "NEMESIS_DEBUFF";

/** Gains INTANGIBLE 2 after acting on any turn it is not intangible. */
function intangibleCycle(ctx: EffectCtx, self: MonsterState): void {
  if (powerAmount(self, "INTANGIBLE") === 0) {
    applyPower(ctx, monster(self.idx), monster(self.idx), "INTANGIBLE", 2);
  }
}

export const nemesis: MonsterDef = {
  id: "NEMESIS",
  name: "Nemesis",
  category: "elite",
  rollHp: false,
  hp: (asc) => (asc >= 8 ? [200, 200] : [185, 185]),
  moves: {
    NEMESIS_ATTACK: {
      id: ATTACK,
      intent: "attack",
      execute: (ctx, self) => {
        attackPlayer(ctx, self, ctx.asc >= 3 ? 7 : 6, 3);
        intangibleCycle(ctx, self);
      },
    },
    NEMESIS_SCYTHE: {
      id: SCYTHE,
      intent: "attack",
      execute: (ctx, self) => {
        attackPlayer(ctx, self, 45);
        intangibleCycle(ctx, self);
      },
    },
    NEMESIS_DEBUFF: {
      id: DEBUFF,
      intent: "debuff",
      execute: (ctx, self) => {
        statusCardsNow(ctx, "BURN", ctx.asc >= 18 ? 5 : 3, "discard");
        intangibleCycle(ctx, self);
      },
    },
  },
  getMove: (ctx, self, roll) => {
    const cooldown = typeof self.data.scytheCooldown === "number" ? self.data.scytheCooldown : 0;
    self.data.scytheCooldown = cooldown - 1;
    const chooseScythe = (): typeof SCYTHE => {
      self.data.scytheCooldown = 2;
      return SCYTHE;
    };
    if (firstTurn(self)) return roll < 50 ? ATTACK : DEBUFF;
    if (roll < 30) {
      if (lastMove(self) !== SCYTHE && (self.data.scytheCooldown as number) <= 0) return chooseScythe();
      if (ctx.rng("aiRng").randomBoolean()) {
        return lastTwoMovesWere(self, ATTACK) ? DEBUFF : ATTACK;
      }
      return lastMove(self) === DEBUFF ? ATTACK : DEBUFF;
    }
    if (roll < 65) {
      if (!lastTwoMovesWere(self, ATTACK)) return ATTACK;
      if (ctx.rng("aiRng").randomBoolean()) {
        if ((self.data.scytheCooldown as number) > 0) return DEBUFF;
        return chooseScythe();
      }
      return DEBUFF;
    }
    if (lastMove(self) !== DEBUFF) return DEBUFF;
    if (ctx.rng("aiRng").randomBoolean() && (self.data.scytheCooldown as number) <= 0) return chooseScythe();
    return ATTACK;
  },
};
