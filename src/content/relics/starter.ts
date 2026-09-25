// Starter relics - values audited vs data/corpus/relics.json.

import type { RelicDef } from "../../engine/content/defs";
import { healPlayer } from "./lib";

export const starterRelics: RelicDef[] = [
  {
    // "At the end of combat, heal 6 HP." Direct heal: onVictory fires just
    // before combatOver halts the interpreter, so the queue would not drain.
    id: "BURNING_BLOOD",
    name: "Burning Blood",
    tier: "starter",
    pool: "red",
    hooks: { onVictory: (ctx) => healPlayer(ctx, 6) },
  },
  {
    // "At the start of each combat, draw 2 additional cards." Its own
    // DrawCardAction behind the opening draw (SnakeRing.atBattleStart).
    id: "RING_OF_THE_SNAKE",
    name: "Ring of the Snake",
    tier: "starter",
    pool: "green",
    hooks: { atBattleStart: (ctx) => ctx.queue.addToBottom({ kind: "draw", n: 2 }) },
  },
  {
    // "At the start of each combat, Channel 1 Lightning." CrackedCore.atPreBattle.
    // DEPENDS: LIGHTNING orb def (Defect workstream); channel fizzles without orb slots.
    id: "CRACKED_CORE",
    name: "Cracked Core",
    tier: "starter",
    pool: "blue",
    hooks: { atBattleStartPreDraw: (ctx) => ctx.queue.addToBottom({ kind: "channelOrb", orbId: "LIGHTNING" }) },
  },
  {
    // "At the start of each combat, add 1 Miracle into your hand." PureWater.atBattleStartPreDraw.
    // DEPENDS: MIRACLE card def (Watcher workstream).
    id: "PURE_WATER",
    name: "Pure Water",
    tier: "starter",
    pool: "purple",
    hooks: {
      atBattleStartPreDraw: (ctx) => {
        if (ctx.bundle.cards.has("MIRACLE")) {
          ctx.queue.addToBottom({ kind: "makeTempCard", defId: "MIRACLE", upgrades: 0, dest: "hand", n: 1 });
        }
      },
    },
  },
];
