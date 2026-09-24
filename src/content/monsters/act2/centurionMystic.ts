// Centurion & Mystic - exact ports from data/corpus/monsters-act2.json.
// Encounter layout (CENTURION_AND_HEALER): Centurion slot 0, Mystic slot 1.
//
// CONFLICT HONORED (Centurion hp.asc): Java Centurion.java:35-38 sets [78,83]
// at A7+ (lightspeed's 76 min is a transcription error).
// CONFLICT HONORED (Centurion DEFEND stale intent): Java Centurion.java:77-80
// uses GainBlockRandomMonsterAction, which falls back to self when no other
// non-dying monster remains.
// CONFLICT HONORED (Mystic heal repeat): Java Healer.java:170-179 has a
// lastTwoMoves gate on HEAL despite lightspeed/wiki disagreement.
// CONFLICT HONORED (Mystic heal threshold): Java Healer.java:170-179 uses
// missing HP >20 at A17 and >15 otherwise, i.e. >=21 / >=16.

import type { MonsterDef } from "../../../engine/content/defs";
import { ascTier, firstTurn, lastMove, lastTwoMovesWere } from "../../util";
import { aliveCount, attackPlayer, playerPower, selfPower } from "./_shared";
import { monster } from "../../../engine/core/ids";

const SLASH = "CENTURION_SLASH";
const FURY = "CENTURION_FURY";
const DEFEND = "CENTURION_DEFEND";

export const centurion: MonsterDef = {
  id: "CENTURION",
  name: "Centurion",
  category: "normal",
  hp: (asc) => (asc >= 7 ? [78, 83] : [76, 80]),
  moves: {
    CENTURION_SLASH: {
      id: SLASH,
      intent: "attack",
      execute: (ctx, self) => attackPlayer(ctx, self, ctx.asc >= 2 ? 14 : 12),
    },
    CENTURION_FURY: {
      id: FURY,
      intent: "attack",
      execute: (ctx, self) => attackPlayer(ctx, self, ctx.asc >= 2 ? 7 : 6, 3),
    },
    CENTURION_DEFEND: {
      id: DEFEND,
      intent: "defend",
      execute: (ctx, self) => {
        const ally = ctx.combat!.monsters[1];
        const target = ally && !ally.isDead && !ally.isEscaped ? ally : self;
        ctx.queue.addToBottom({
          kind: "gainBlock",
          target: monster(target.idx),
          amount: ctx.asc >= 17 ? 20 : 15,
          fromCard: false,
        });
      },
    },
  },
  getMove: (ctx, self, roll) => {
    const mysticAlive = aliveCount(ctx) > 1;
    const support = mysticAlive ? DEFEND : FURY;
    if (roll >= 65 && !lastTwoMovesWere(self, DEFEND) && !lastTwoMovesWere(self, FURY)) {
      return support;
    }
    if (!lastTwoMovesWere(self, SLASH)) return SLASH;
    return support;
  },
};

const ATTACK_DEBUFF = "MYSTIC_ATTACK_DEBUFF";
const HEAL = "MYSTIC_HEAL";
const BUFF = "MYSTIC_BUFF";

const mysticHealAmount = (asc: number): number => (asc >= 17 ? 20 : 16);

export const mystic: MonsterDef = {
  id: "MYSTIC",
  name: "Mystic",
  category: "normal",
  hp: (asc) => (asc >= 7 ? [50, 58] : [48, 56]),
  moves: {
    MYSTIC_ATTACK_DEBUFF: {
      id: ATTACK_DEBUFF,
      intent: "attackDebuff",
      execute: (ctx, self) => {
        attackPlayer(ctx, self, ctx.asc >= 2 ? 9 : 8);
        playerPower(ctx, self, "FRAIL", 2);
      },
    },
    MYSTIC_HEAL: {
      id: HEAL,
      intent: "buff",
      execute: (ctx, self) => {
        const amount = mysticHealAmount(ctx.asc);
        for (const m of ctx.combat!.monsters) {
          if (!m.isDead && !m.isEscaped) ctx.queue.addToBottom({ kind: "heal", target: monster(m.idx), amount });
        }
      },
    },
    MYSTIC_BUFF: {
      id: BUFF,
      intent: "buff",
      execute: (ctx, self) => {
        const str = ascTier(ctx.asc, 2, [
          [2, 3],
          [17, 4],
        ]);
        for (const m of ctx.combat!.monsters) {
          if (m.idx === self.idx || m.isDead || m.isEscaped) continue;
          ctx.queue.addToBottom({
            kind: "applyPower",
            source: monster(self.idx),
            target: monster(m.idx),
            powerId: "STRENGTH",
            amount: str,
          });
        }
        selfPower(ctx, self, "STRENGTH", str);
      },
    },
  },
  getMove: (ctx, self, roll) => {
    // note: the A17 heal TRIGGER threshold is 21 while the heal amount is 20
    const healNeed = ctx.asc >= 17 ? 21 : 16;
    const needToHeal = ctx.combat!.monsters
      .filter((m) => !m.isDead && !m.isEscaped)
      .reduce((sum, m) => sum + (m.maxHp - m.hp), 0);
    if (needToHeal >= healNeed && !lastTwoMovesWere(self, HEAL)) return HEAL;
    const debuffGate =
      ctx.asc >= 17 ? lastMove(self) !== ATTACK_DEBUFF : !lastTwoMovesWere(self, ATTACK_DEBUFF);
    if (roll >= 40 && debuffGate) return ATTACK_DEBUFF;
    if (!lastTwoMovesWere(self, BUFF)) return BUFF;
    return ATTACK_DEBUFF;
  },
};
