// Power priority: the game keeps every creature's powers sorted by
// AbstractPower.priority (default 5; ApplyPowerAction re-sorts on every new
// power, ties keep application order), and the damage and block folds walk
// that list. So Weak (99) always folds after Strength, Frail (10) after
// Dexterity, and Pen Nib / Double Damage (6) between them, no matter which
// landed first. No Block zeroes card block in the separate modifyBlockLast
// pass, after Dexterity and Frail.

import { test, expect, describe } from "bun:test";
import { createCombatGame, advance, type GameState } from "../../src/engine/game";
import { getIntents } from "../../src/engine/combat/intents";
import { previewCardAt } from "../../src/engine/combat/preview";
import { applyPower } from "../../src/engine/combat/powerRuntime";
import { buildBaseContentBundle } from "../../src/content/index";
import type { EffectCtx } from "../../src/engine/content/defs";
import { ActionQueue } from "../../src/engine/core/queue";
import { RngRegistry, type Stream } from "../../src/engine/core/rngRegistry";
import { PLAYER, monster, type ActorRef } from "../../src/engine/core/ids";

const bundle = buildBaseContentBundle();

/** Apply a power through the same runtime entry the applyPower action uses. */
function apply(s: GameState, target: ActorRef, powerId: string, amount: number, source: ActorRef = target): void {
  const registry = RngRegistry.fromState(s.rng);
  const rt = { pending: null, currentItem: null, combatOver: null } as EffectCtx["rt"];
  const ctx: EffectCtx = {
    run: s.run,
    combat: s.combat,
    queue: new ActionQueue(),
    bundle,
    rt,
    rng: (st: Stream) => registry.get(st),
    asc: s.run.ascension,
    emit: () => {},
    requestChoice: (c) => {
      rt.pending = c;
    },
  };
  applyPower(ctx, source, target, powerId, amount);
}

const playerIds = (s: GameState) => s.combat!.player.powers.map((p) => p.id);
const monsterIds = (s: GameState, idx = 0) => s.combat!.monsters[idx]!.powers.map((p) => p.id);
const monsterHp = (s: GameState, idx = 0) => s.combat!.monsters[idx]!.hp;
const firstCardPreview = (s: GameState) => previewCardAt(s, bundle, s.combat!.player.piles.hand[0]!, 0);
const playFirst = (s: GameState) => advance(s, { cmd: "playCard", handIdx: 0, target: 0 }, bundle);

function heart(): GameState {
  return createCombatGame({
    seed: "PRIO_HEART",
    bundle,
    character: "IRONCLAD",
    ascension: 4, // Blood Shots: 2 x 15
    deck: Array(10).fill({ defId: "DEFEND_RED" }),
    monsters: ["CORRUPT_HEART"],
    hp: 5000,
    maxHp: 5000,
  });
}

function vsJawWorm(defId: string): GameState {
  return createCombatGame({
    seed: "PRIO_PLAYER",
    bundle,
    character: "IRONCLAD",
    deck: Array(10).fill({ defId }),
    monsters: ["JAW_WORM"],
  });
}

describe("power priority (the game's AbstractPower.priority sort)", () => {
  test("priorities match the game's power classes", () => {
    const want: [string, number][] = [
      ["STRENGTH", 5],
      ["DEXTERITY", 5],
      ["VULNERABLE", 5],
      ["VIGOR", 5],
      ["NO_BLOCK", 5],
      ["PEN_NIB", 6],
      ["DOUBLE_DAMAGE", 6],
      ["FRAIL", 10],
      ["FLIGHT", 50],
      ["INTANGIBLE", 75],
      ["WEAK", 99],
    ];
    for (const [id, priority] of want) {
      expect([id, bundle.powers.get(id)!.priority ?? 5]).toEqual([id, priority]);
    }
  });

  test("Heart: Weak applied before a later Strength gain still folds after it", () => {
    let s = heart();
    apply(s, monster(0), "WEAK", 2, PLAYER);
    apply(s, monster(0), "STRENGTH", 4);
    const ids = monsterIds(s);
    expect(ids.indexOf("STRENGTH")).toBeLessThan(ids.indexOf("WEAK"));
    expect(ids.at(-1)).toBe("WEAK");

    s.combat!.monsters[0]!.move = "CORRUPT_HEART_BLOOD_SHOTS";
    // floor((2 + 4) x 0.75) = 4, not floor(2 x 0.75 + 4) = 5
    expect(getIntents(s, bundle)[0]).toMatchObject({ moveId: "CORRUPT_HEART_BLOOD_SHOTS", damage: 4, hits: 15 });
    const hp0 = s.run.hp;
    s = advance(s, { cmd: "endTurn" }, bundle);
    expect(hp0 - s.run.hp).toBe(60);
  });

  test("Heart: player Vulnerable multiplies the Weak-adjusted hit", () => {
    let s = heart();
    apply(s, monster(0), "WEAK", 2, PLAYER);
    apply(s, monster(0), "STRENGTH", 4);
    apply(s, PLAYER, "VULNERABLE", 2, monster(0));
    s.combat!.monsters[0]!.move = "CORRUPT_HEART_BLOOD_SHOTS";
    // floor((2 + 4) x 0.75 x 1.5) = 6, not floor((2 x 0.75 + 4) x 1.5) = 8
    expect(getIntents(s, bundle)[0]).toMatchObject({ damage: 6, hits: 15 });
    const hp0 = s.run.hp;
    s = advance(s, { cmd: "endTurn" }, bundle);
    expect(hp0 - s.run.hp).toBe(90);
  });

  test("player: Weak applied before Strength still folds after it", () => {
    let s = vsJawWorm("STRIKE_RED");
    apply(s, PLAYER, "WEAK", 1, monster(0));
    apply(s, PLAYER, "STRENGTH", 3);
    expect(playerIds(s)).toEqual(["STRENGTH", "WEAK"]);
    // floor((6 + 3) x 0.75) = 6, not floor(6 x 0.75 + 3) = 7
    expect(firstCardPreview(s)?.damage).toBe(6);
    const hp0 = monsterHp(s);
    s = playFirst(s);
    expect(hp0 - monsterHp(s)).toBe(6);
  });

  test("player: Weak before Strength against a Vulnerable target", () => {
    let s = vsJawWorm("STRIKE_RED");
    apply(s, monster(0), "VULNERABLE", 1, PLAYER);
    apply(s, PLAYER, "WEAK", 1, monster(0));
    apply(s, PLAYER, "STRENGTH", 3);
    // floor((6 + 3) x 0.75 x 1.5) = 10, not floor((6 x 0.75 + 3) x 1.5) = 11
    expect(firstCardPreview(s)?.damage).toBe(10);
    const hp0 = monsterHp(s);
    s = playFirst(s);
    expect(hp0 - monsterHp(s)).toBe(10);
  });

  test("target Vulnerable folds on the receive side whenever it landed", () => {
    let s = vsJawWorm("STRIKE_RED");
    apply(s, monster(0), "VULNERABLE", 1, PLAYER);
    apply(s, PLAYER, "STRENGTH", 3);
    // floor((6 + 3) x 1.5) = 13
    expect(firstCardPreview(s)?.damage).toBe(13);
    const hp0 = monsterHp(s);
    s = playFirst(s);
    expect(hp0 - monsterHp(s)).toBe(13);
  });

  test("player: Frail applied before Dexterity still folds after it", () => {
    let s = vsJawWorm("DEFEND_RED");
    apply(s, PLAYER, "FRAIL", 1, monster(0));
    apply(s, PLAYER, "DEXTERITY", 4);
    expect(playerIds(s)).toEqual(["DEXTERITY", "FRAIL"]);
    // floor((5 + 4) x 0.75) = 6, not floor(5 x 0.75 + 4) = 7
    expect(firstCardPreview(s)?.block).toBe(6);
    s = playFirst(s);
    expect(s.combat!.player.block).toBe(6);
  });

  test("Pen Nib keeps folding after Strength and before Weak", () => {
    let s = vsJawWorm("STRIKE_RED");
    apply(s, PLAYER, "PEN_NIB", 1);
    apply(s, PLAYER, "STRENGTH", 3);
    expect(playerIds(s)).toEqual(["STRENGTH", "PEN_NIB"]);
    expect(firstCardPreview(s)?.damage).toBe(18); // (6 + 3) x 2

    s = vsJawWorm("STRIKE_RED");
    apply(s, PLAYER, "WEAK", 1, monster(0));
    apply(s, PLAYER, "PEN_NIB", 1);
    apply(s, PLAYER, "STRENGTH", 3);
    expect(playerIds(s)).toEqual(["STRENGTH", "PEN_NIB", "WEAK"]);
    // floor((6 + 3) x 2 x 0.75) = 13, not floor((6 x 0.75 + 3) x 2) = 15
    expect(firstCardPreview(s)?.damage).toBe(13);
    const hp0 = monsterHp(s);
    s = playFirst(s);
    expect(hp0 - monsterHp(s)).toBe(13);
  });

  test("Double Damage applied before Strength still folds after it", () => {
    let s = vsJawWorm("STRIKE_RED");
    apply(s, PLAYER, "DOUBLE_DAMAGE", 1);
    apply(s, PLAYER, "STRENGTH", 3);
    expect(playerIds(s)).toEqual(["STRENGTH", "DOUBLE_DAMAGE"]);
    // (6 + 3) x 2 = 18, not 6 x 2 + 3 = 15
    expect(firstCardPreview(s)?.damage).toBe(18);
    const hp0 = monsterHp(s);
    s = playFirst(s);
    expect(hp0 - monsterHp(s)).toBe(18);
  });

  test("No Block zeroes card block after Dexterity, whenever it landed", () => {
    let s = vsJawWorm("DEFEND_RED");
    apply(s, PLAYER, "NO_BLOCK", 2);
    apply(s, PLAYER, "DEXTERITY", 2);
    expect(firstCardPreview(s)?.block ?? 0).toBe(0); // not 0 + 2
    s = playFirst(s);
    expect(s.combat!.player.block).toBe(0);
  });
});
