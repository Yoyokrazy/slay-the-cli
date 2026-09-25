// Act-1 hallway monsters against the decompiled game (monsters/exordium/*.java):
// the rng call order and the exact rng functions, which the corpus-driven
// suite in monstersAct1.test.ts does not pin down.

import { test, expect, describe } from "bun:test";
import { createCombatGame, advance, type GameState } from "../../src/engine/game";
import { buildBaseContentBundle } from "../../src/content/index";
import { act1Monsters, act1Powers } from "../../src/content/monsters/act1/index";
import { acidSlimeL, acidSlimeM } from "../../src/content/monsters/act1/slimes";
import { redSlaver } from "../../src/content/monsters/act1/slavers";
import type { ContentBundle, EffectCtx } from "../../src/engine/content/defs";
import type { MonsterState } from "../../src/engine/combat/combatState";
import { RngRegistry } from "../../src/engine/core/rngRegistry";
import { Rng, seedFromString } from "../../src/engine/core/rng";

function makeBundle(): ContentBundle {
  const b = buildBaseContentBundle();
  for (const m of act1Monsters) b.monsters.set(m.id, m);
  for (const p of act1Powers) if (!b.powers.has(p.id)) b.powers.set(p.id, p);
  return b;
}

const bundle = makeBundle();

function fight(monsters: string[], seed: string, asc = 0): GameState {
  return createCombatGame({
    seed,
    bundle,
    character: "IRONCLAD",
    ascension: asc,
    deck: Array(10).fill({ defId: "DEFEND_RED" }),
    monsters,
    hp: 5000,
    maxHp: 5000,
  });
}

const endTurn = (s: GameState): GameState => advance(s, { cmd: "endTurn" }, bundle);

function monsterState(id: string, moveHistory: string[], data: Record<string, unknown> = {}): MonsterState {
  return {
    id,
    idx: 0,
    hp: 50,
    maxHp: 50,
    block: 0,
    powers: [],
    move: moveHistory[moveHistory.length - 1] ?? null,
    moveHistory,
    isDead: false,
    isEscaped: false,
    halfDead: false,
    data,
  };
}

function aiCtx(seed: string, asc = 0): EffectCtx {
  const registry = new RngRegistry(seedFromString(seed));
  return { asc, rng: (st) => registry.get(st) } as Pick<EffectCtx, "asc" | "rng"> as EffectCtx;
}

describe("louses (LouseNormal.java / LouseDefensive.java)", () => {
  test("each constructor rolls HP then bite damage; Curl Up rolls in usePreBattleAction after both", () => {
    for (let i = 0; i < 8; i++) {
      for (const asc of [0, 7, 17]) {
        const seed = `LOUSEORDER${i}`;
        const s = fight(["RED_LOUSE", "GREEN_LOUSE"], seed, asc);
        const hpRng = new RngRegistry(seedFromString(seed)).get("monsterHpRng");
        const bite = () => (asc >= 2 ? hpRng.randomRange(6, 8) : hpRng.randomRange(5, 7));
        const hp0 = asc >= 7 ? hpRng.randomRange(11, 16) : hpRng.randomRange(10, 15);
        const d0 = bite();
        const hp1 = asc >= 7 ? hpRng.randomRange(12, 18) : hpRng.randomRange(11, 17);
        const d1 = bite();
        const curl = () => (asc >= 17 ? hpRng.randomRange(9, 12) : asc >= 7 ? hpRng.randomRange(4, 8) : hpRng.randomRange(3, 7));
        const c0 = curl();
        const c1 = curl();
        const [red, green] = s.combat!.monsters;
        expect([red!.maxHp, red!.data.biteDamage, green!.maxHp, green!.data.biteDamage]).toEqual([hp0, d0, hp1, d1]);
        expect(red!.powers.find((p) => p.id === "CURL_UP")?.amount).toBe(c0);
        expect(green!.powers.find((p) => p.id === "CURL_UP")?.amount).toBe(c1);
      }
    }
  });
});

describe("Red Slaver (SlaverRed.java:120-157)", () => {
  test("after Entangle, STAB needs roll >= 55", () => {
    const self = monsterState("RED_SLAVER", ["RED_SLAVER_STAB", "RED_SLAVER_ENTANGLE"], { usedEntangle: true });
    const ctx = aiCtx("SLAVER");
    for (let roll = 0; roll < 100; roll++) {
      const move = redSlaver.getMove(ctx, self, roll);
      expect(move).toBe(roll >= 55 ? "RED_SLAVER_STAB" : "RED_SLAVER_SCRAPE");
    }
  });
});

describe("Acid Slime (M) and (L): the SPIT reroll is the no-arg aiRng.randomBoolean()", () => {
  test("AcidSlime_M.java:96,133 and AcidSlime_L.java:171 read nextBoolean, not nextFloat < 0.5", () => {
    let differs = 0;
    for (let i = 0; i < 64; i++) {
      const seed = `SLIMEBOOL${i}`;
      const probe = new RngRegistry(seedFromString(seed)).get("aiRng");
      const noArg = Rng.fromState(probe.saveState()).randomBoolean();
      if (noArg !== Rng.fromState(probe.saveState()).randomBoolean(0.5)) differs++;
      const cases: [typeof acidSlimeM, string, number, number, string, string][] = [
        [acidSlimeM, "ACID_SLIME_M_CORROSIVE_SPIT", 10, 0, "ACID_SLIME_M_TACKLE", "ACID_SLIME_M_LICK"],
        [acidSlimeM, "ACID_SLIME_M_CORROSIVE_SPIT", 10, 17, "ACID_SLIME_M_TACKLE", "ACID_SLIME_M_LICK"],
        [acidSlimeL, "ACID_SLIME_L_CORROSIVE_SPIT", 10, 0, "ACID_SLIME_L_TACKLE", "ACID_SLIME_L_LICK"],
      ];
      for (const [def, spit, roll, asc, ifTrue, ifFalse] of cases) {
        const self = monsterState(def.id, [spit, spit]);
        expect(def.getMove(aiCtx(seed, asc), self, roll)).toBe(noArg ? ifTrue : ifFalse);
      }
    }
    expect(differs).toBeGreaterThan(0); // the two bits really are different draws
  });
});

describe("chained moves burn no aiRng after the opening roll", () => {
  // takeTurn sets the next move itself (setMove / SetMoveAction) and queues no
  // RollMoveAction: AcidSlime_S, Looter, GremlinThief/Warrior/Tsundere/Wizard
  for (const id of ["ACID_SLIME_S", "SNEAKY_GREMLIN", "MAD_GREMLIN", "SHIELD_GREMLIN", "GREMLIN_WIZARD"]) {
    test(`${id}: no aiRng draw on later turns`, () => {
      let s = fight([id], `CHAIN-${id}`);
      const after1 = s.rng.floor.aiRng.counter;
      s = endTurn(s);
      if (id === "SHIELD_GREMLIN") {
        // Protect picks its block target with aiRng (GainBlockRandomMonsterAction)
        expect(s.rng.floor.aiRng.counter).toBeLessThanOrEqual(after1 + 1);
      } else {
        expect(s.rng.floor.aiRng.counter).toBe(after1);
      }
      const after2 = s.rng.floor.aiRng.counter;
      for (let t = 0; t < 4; t++) s = endTurn(s);
      if (id !== "SHIELD_GREMLIN") expect(s.rng.floor.aiRng.counter).toBe(after2);
    });
  }

  test("Looter: only the turn-1 dialog roll and the turn-2 Lunge/Smoke Bomb coin", () => {
    let s = fight(["LOOTER"], "CHAIN-LOOTER");
    const c0 = s.rng.floor.aiRng.counter;
    s = endTurn(s); // MUG: randomBoolean(0.6) dialog
    expect(s.rng.floor.aiRng.counter).toBe(c0 + 1);
    s = endTurn(s); // MUG again, then randomBoolean(0.5) picks the follow-up
    expect(s.rng.floor.aiRng.counter).toBe(c0 + 2);
    s = endTurn(s);
    s = endTurn(s);
    expect(s.rng.floor.aiRng.counter).toBe(c0 + 2);
  });

  test("Fat Gremlin still rolls every turn (its takeTurn queues RollMoveAction)", () => {
    let s = fight(["FAT_GREMLIN"], "CHAIN-FAT");
    const c0 = s.rng.floor.aiRng.counter;
    s = endTurn(s);
    s = endTurn(s);
    expect(s.rng.floor.aiRng.counter).toBe(c0 + 2);
  });
});

describe("Fungi Beast (FungiBeast.java:30-41, 68-73)", () => {
  test("Grow: +3 Strength below A2, +4 from A2 (so A6 shows +4), +5 from A17", () => {
    for (const [asc, amount] of [
      [0, 3],
      [2, 4],
      [6, 4],
      [16, 4],
      [17, 5],
    ] as const) {
      let found = false;
      for (let i = 0; i < 30 && !found; i++) {
        let s = fight(["FUNGI_BEAST"], `FUNGI${asc}-${i}`, asc);
        if (s.combat!.monsters[0]!.move !== "FUNGI_BEAST_GROW") continue;
        s = endTurn(s);
        expect(s.combat!.monsters[0]!.powers.find((p) => p.id === "STRENGTH")?.amount).toBe(amount);
        found = true;
      }
      expect(found).toBe(true);
    }
  });
});
