// Darkling - exact port from data/corpus/monsters-act34.json (DARKLING).
// CONFLICT HONORED (CHOMP hits): 8x2 (asc2: 9x2) - wiki + spire-archive + the
// decompiled game's two DamageActions; lightspeed's single hit is a bug.
// CONFLICT HONORED (NIP asc2): lightspeed primary - construct rolls
// monsterHpRng.random(9,13) at asc2+ AND the move adds +2 (effective 11-15).
// Life Link / revive cycle: on death, if any OTHER Darkling is still truly
// alive, this one becomes halfDead (untargetable corpse) and revives at 50%
// max HP two of its turns later (REGROW turn, then REINCARNATE) - driven by
// hidden DARKLING_REGROW_DRIVER bookkeeping, since the engine skips halfDead
// monsters in the monster phase. Killing the last living Darkling wins the
// fight even while others are regrowing (the corpses die for real).
// ENGINE-GAP: the reference rolls Nip damage during construction interleaved
// with the HP roll; here all HP rolls precede preBattle (same monsterHpRng
// calls, different stream order).

import type { MonsterDef } from "../../../engine/content/defs";
import { firstTurn, lastMove, lastTwoMovesWere } from "../../util";
import { attackPlayer, prePower, replaceIntent, selfBlock, selfPower } from "../act1/_shared";

const NIP = "DARKLING_NIP";
const CHOMP = "DARKLING_CHOMP";
const HARDEN = "DARKLING_HARDEN";
const REGROW = "DARKLING_REGROW";
const REINCARNATE = "DARKLING_REINCARNATE";

export const darkling: MonsterDef = {
  id: "DARKLING",
  name: "Darkling",
  category: "normal",
  hp: (asc) => (asc >= 7 ? [50, 59] : [48, 56]),
  preBattle: (ctx, self) => {
    prePower(self, "REGROW", 1);
    self.data.nipDamage =
      ctx.asc >= 2 ? ctx.rng("monsterHpRng").randomRange(9, 13) : ctx.rng("monsterHpRng").randomRange(7, 11);
  },
  moves: {
    DARKLING_NIP: {
      id: NIP,
      intent: "attack",
      execute: (ctx, self) =>
        attackPlayer(ctx, self, (self.data.nipDamage as number) + (ctx.asc >= 2 ? 2 : 0)),
    },
    DARKLING_CHOMP: {
      id: CHOMP,
      intent: "attack",
      execute: (ctx, self) => attackPlayer(ctx, self, ctx.asc >= 2 ? 9 : 8, 2),
    },
    DARKLING_HARDEN: {
      id: HARDEN,
      intent: "defend",
      execute: (ctx, self) => {
        selfBlock(ctx, self, 12);
        if (ctx.asc >= 17) selfPower(ctx, self, "STRENGTH", 2);
      },
    },
    DARKLING_REGROW: {
      id: REGROW,
      intent: "unknown",
      execute: () => {}, // does nothing; the revive is driven by the REGROW power
    },
    DARKLING_REINCARNATE: {
      id: REINCARNATE,
      intent: "buff",
      execute: () => {}, // revive handled by the REGROW power's atEndOfRound driver
    },
  },
  getMove: (ctx, self, roll) => {
    if (self.halfDead) {
      // only reached when it dies during its own turn (thorns): the engine
      // still rolls after the move; the corpus forces REINCARNATE while
      // halfDead - REGROW is shown while more than one revive turn remains.
      const driver = self.powers.find((p) => p.id === "DARKLING_REGROW_DRIVER");
      const ticks = (driver?.data?.ticks as number | undefined) ?? 0;
      return ticks > 1 ? REGROW : REINCARNATE;
    }
    if (firstTurn(self)) return roll < 50 ? HARDEN : NIP;
    let r = roll;
    for (;;) {
      if (r < 40) {
        // the middle Darkling (spawn idx 1) never Chomps
        if (lastMove(self) !== CHOMP && self.idx !== 1) return CHOMP;
        r = ctx.rng("aiRng").randomRange(40, 99);
      }
      if (r < 70) {
        return lastMove(self) !== HARDEN ? HARDEN : NIP;
      }
      if (!lastTwoMovesWere(self, NIP)) return NIP;
      r = ctx.rng("aiRng").random(99); // recurse the whole getMove with a fresh roll
    }
  },
  onDeath: (ctx, self) => {
    const combat = ctx.combat!;
    const siblings = combat.monsters.filter((m) => m.id === "DARKLING" && m.idx !== self.idx);
    const anySiblingAlive = siblings.some((m) => !m.isDead && !m.isEscaped && !m.halfDead);
    if (!anySiblingAlive) {
      // killing the last living Darkling wins: regrowing corpses die for real
      for (const s of siblings) {
        if (s.halfDead) {
          s.halfDead = false;
          s.isDead = true;
        }
      }
      return; // stays dead -> checkVictory ends the fight
    }
    self.isDead = false;
    self.halfDead = true;
    if (self.data.regrowing) return; // repeat damage on the corpse: no state reset
    self.data.regrowing = true;
    // Darkling.damage calls powers.clear(): all visible statuses and Regrow
    // are wiped while the corpse waits to reincarnate. The hidden driver keeps
    // the port's end-of-round countdown without showing a power on the corpse.
    self.powers = [{ id: "DARKLING_REGROW_DRIVER", amount: 1, justApplied: false, data: null }];
    // end-of-rounds until revive: REGROW turn + REINCARNATE turn (one more
    // when it died during its own turn, which already passed this round)
    self.powers[0]!.data = { ticks: combat.playerTurn ? 2 : 3 };
    replaceIntent(self, REGROW);
  },
};
