import { test, expect, describe } from "bun:test";
import { createRun, advance, type GameState } from "../../src/engine/game";
import { transformDeckCard } from "../../src/engine/run/deck";
import { allRelics } from "../../src/content/relics";
import { curseCards } from "../../src/content/cards/curses";
import { makeRunTestBundle } from "./runTestBundle";
import { makeTestCtx, autoWinCombat, stepRun, walkUntil, runSignature } from "./runCtx";
import { generateEncounters, getActDef } from "../../src/engine/run/encounters";
import { resolveUnknownRoom, generateEventId, UNKNOWN_ROOM } from "../../src/engine/run/runFlow";
import { restHealAmount } from "../../src/engine/run/rest";
import { generateShop } from "../../src/engine/run/shop";
import { setupTreasureRoom } from "../../src/engine/run/treasure";
import {
  NEOW_BONUS_TABLE_0,
  NEOW_BONUS_TABLE_1,
  NEOW_BONUS_BY_DRAWBACK,
  NEOW_TIER2_ALL,
  NEOW_DRAWBACKS,
  applyNeowBonus,
} from "../../src/engine/run/neow";
import { RngRegistry } from "../../src/engine/core/rngRegistry";
import { seedFromString } from "../../src/engine/core/rng";
import { MAP_HEIGHT, MAP_WIDTH } from "../../src/engine/run/mapGen";
import type { MapNode } from "../../src/engine/run/runState";
import { buildBaseContentBundle } from "../../src/content/index";

const bundle = makeRunTestBundle();
const courierBundle = makeRunTestBundle();
for (const id of ["THE_COURIER", "MEMBERSHIP_CARD"] as const) {
  const def = allRelics.find((r) => r.id === id);
  if (!def) throw new Error(`missing ${id} relic`);
  courierBundle.relics.set(def.id, def);
}
const courierNoDiscountBundle = makeRunTestBundle();
courierNoDiscountBundle.relics.set("THE_COURIER", {
  id: "THE_COURIER",
  name: "The Courier",
  tier: "uncommon",
  pool: "shared",
  hooks: {},
});
const parasiteBundle = makeRunTestBundle();
const parasiteDef = curseCards.find((c) => c.id === "PARASITE");
if (!parasiteDef) throw new Error("missing PARASITE card def");
parasiteBundle.cards.set(parasiteDef.id, parasiteDef);
const eggBundle = makeRunTestBundle();
for (const id of ["FROZEN_EGG", "MOLTEN_EGG", "TOXIC_EGG"] as const) {
  const def = allRelics.find((r) => r.id === id);
  if (!def) throw new Error(`missing relic ${id}`);
  eggBundle.relics.set(def.id, def);
}
const cursedKeyBundle = makeRunTestBundle();
for (const id of ["CURSED_KEY", "OMAMORI"] as const) {
  const def = allRelics.find((r) => r.id === id);
  if (!def) throw new Error(`missing relic ${id}`);
  cursedKeyBundle.relics.set(def.id, def);
}
for (const def of curseCards) cursedKeyBundle.cards.set(def.id, def);
const matryoshkaBundle = makeRunTestBundle();
const matryoshkaDef = allRelics.find((r) => r.id === "MATRYOSHKA");
if (!matryoshkaDef) throw new Error("missing MATRYOSHKA relic");
matryoshkaBundle.relics.set(matryoshkaDef.id, matryoshkaDef);
const mawBundle = makeRunTestBundle();
const mawDef = allRelics.find((r) => r.id === "MAW_BANK");
if (!mawDef) throw new Error("missing MAW_BANK relic");
mawBundle.relics.set(mawDef.id, mawDef);
const pillowBundle = makeRunTestBundle();
const pillowDef = allRelics.find((r) => r.id === "REGAL_PILLOW");
if (!pillowDef) throw new Error("missing REGAL_PILLOW relic");
pillowBundle.relics.set(pillowDef.id, pillowDef);

const run = (seed: string, ascension = 0): GameState => createRun({ seed, bundle, character: "IRONCLAD", ascension });
const eggRun = (seed: string): GameState => createRun({ seed, bundle: eggBundle, character: "IRONCLAD" });
const cursedKeyRun = (seed: string): GameState => createRun({ seed, bundle: cursedKeyBundle, character: "IRONCLAD" });
const matryoshkaRun = (seed: string): GameState => createRun({ seed, bundle: matryoshkaBundle, character: "IRONCLAD" });

function putTreasureRoom(s: GameState): void {
  s.run.room = {
    kind: "treasure",
    chest: { size: "small", goldPresent: false, relicTier: "common", sapphireKeyAvailable: true, opened: false },
  };
}

function curseCount(s: GameState): number {
  return s.run.deck.filter((c) => cursedKeyBundle.cards.get(c.defId)?.type === "curse").length;
}

function openMatryoshkaChest(s: GameState): { state: GameState; gained: number } {
  putTreasureRoom(s);
  const before = s.run.relics.length;
  let state = advance(s, { cmd: "openChest" }, matryoshkaBundle);
  state = advance(state, { cmd: "takeChestRelic" }, matryoshkaBundle);
  return { state, gained: state.run.relics.length - before };
}

function matryoshkaCounter(s: GameState): number | undefined {
  return s.run.relics.find((r) => r.defId === "MATRYOSHKA")?.counter;
}

function giveMatryoshka(s: GameState): void {
  s.run.relics.push({ defId: "MATRYOSHKA", counter: 2 });
  s.run.pools.uncommonRelics = s.run.pools.uncommonRelics.filter((id) => id !== "MATRYOSHKA");
}

function giveRelic(s: GameState, id: string): void {
  s.run.relics.push({ defId: id, counter: 0 });
  s.run.pools.commonRelics = s.run.pools.commonRelics.filter((r) => r !== id);
  s.run.pools.uncommonRelics = s.run.pools.uncommonRelics.filter((r) => r !== id);
  s.run.pools.rareRelics = s.run.pools.rareRelics.filter((r) => r !== id);
  s.run.pools.shopRelics = s.run.pools.shopRelics.filter((r) => r !== id);
  s.run.pools.bossRelics = s.run.pools.bossRelics.filter((r) => r !== id);
}

function testMapNode(x: number, y: number, kind: MapNode["kind"], edges: number[] = []): MapNode {
  return { x, y, kind, edges, burningElite: false, emeraldKey: false };
}

function wingBootsMapRun(counter: number | null): GameState {
  const s = run("WINGMAP");
  const rows: (MapNode | null)[][] = Array.from({ length: MAP_HEIGHT }, () => new Array<MapNode | null>(MAP_WIDTH).fill(null));
  rows[0]![0] = testMapNode(0, 0, "monster", [0]);
  rows[1]![0] = testMapNode(0, 1, "shop", [0]);
  rows[1]![2] = testMapNode(2, 1, "rest", [0]);
  s.run.map = { act: 1, rows, bossId: "HEXAGHOST", burningEliteBuff: -1 };
  s.run.room = { kind: "map" };
  s.run.position = [0, 0];
  if (counter !== null) s.run.relics.push({ defId: "WING_BOOTS", counter });
  return s;
}

function singingBowlRewardRun(): GameState {
  const s = run("BOWL");
  s.run.hp = 40;
  s.run.maxHp = 80;
  s.run.relics.push({ defId: "SINGING_BOWL", counter: 0 });
  s.run.room = {
    kind: "rewards",
    source: "monster",
    entries: [
      { kind: "card", group: 0, id: "T_COMMON_ATK_A", rarity: "common", upgraded: false, taken: false },
      { kind: "card", group: 0, id: "T_COMMON_SKL_A", rarity: "common", upgraded: false, taken: false },
      { kind: "card", group: 0, id: "T_COMMON_PWR_A", rarity: "common", upgraded: false, taken: false },
    ],
  };
  return s;
}

function cardRemovalRun(defId: string): GameState {
  const s = createRun({ seed: `REMOVE-${defId}`, bundle: parasiteBundle, character: "IRONCLAD" });
  s.run.hp = 80;
  s.run.maxHp = 80;
  s.run.gold = 0;
  s.run.deck = [
    { defId, upgrades: 0, misc: 0, bottled: false },
    { defId: "T_DEFEND", upgrades: 0, misc: 0, bottled: false },
  ];
  s.run.room = {
    kind: "shop",
    shop: { cards: [], relics: [], potions: [], removalCost: 0, removalUsed: false },
  };
  return s;
}

describe("createRun determinism", () => {
  test("same seed -> byte-identical state; different seed differs", () => {
    expect(JSON.stringify(run("AAA"))).toBe(JSON.stringify(run("AAA")));
    expect(JSON.stringify(run("AAA"))).not.toBe(JSON.stringify(run("BBB")));
  });

  test("same seed + same command walk -> byte-identical mid-run state", () => {
    let a = run("WALK");
    let b = run("WALK");
    for (let i = 0; i < 60; i++) {
      if (a.outcome) break;
      if (a.pending) {
        const req = a.pending.request;
        const picks = req.kind === "cards" ? req.iids.slice(0, req.min) : [0];
        a = advance(a, { cmd: "choose", indices: picks }, bundle);
        b = advance(b, { cmd: "choose", indices: picks }, bundle);
      } else {
        a = stepRun(a, bundle);
        b = stepRun(b, bundle);
      }
      expect(runSignature(a)).toBe(runSignature(b));
    }
  });

  test("JSON round-trip mid-run resumes identically", () => {
    let live = run("SAVE");
    for (let i = 0; i < 8; i++) live = stepRun(live, bundle);
    const restored = JSON.parse(JSON.stringify(live)) as GameState;
    const a = stepRun(live, bundle);
    const b = stepRun(restored, bundle);
    expect(runSignature(a)).toBe(runSignature(b));
  });
});

describe("run initialization", () => {
  test("starts at Neow, floor 0, 99 gold, starter relic, shuffled relic pools", () => {
    const s = run("INIT");
    expect(s.run.room!.kind).toBe("neow");
    expect(s.run.floor).toBe(0);
    expect(s.run.gold).toBe(99);
    expect(s.run.relics.map((r) => r.defId)).toEqual(["T_STARTER"]);
    expect(s.run.pools.commonRelics.length).toBe(6);
    expect(s.run.pools.bossRelics.length).toBe(8);
    expect(s.run.map!.act).toBe(1);
    expect(s.run.potionSlots).toBe(3);
    expect(s.combat).toBeNull();
  });

  test("ascension effects: A6 damaged start, A11 two potion slots, A14 lower max HP", () => {
    const a6 = run("ASC", 6);
    expect(a6.run.hp).toBe(Math.round(999 * 0.9));
    const a11 = run("ASC", 11);
    expect(a11.run.potionSlots).toBe(2);
    expect(a11.run.potions.length).toBe(2);
    const a14 = run("ASC", 14);
    expect(a14.run.maxHp).toBe(999 - 5);
  });

  test("relic pool shuffle consumes exactly 5 relicRng longs", () => {
    const s = run("RELICRNG");
    expect(s.rng.run.relicRng.counter).toBe(5);
  });

  test("unobtainable relics never enter a relic pool", () => {
    const real = buildBaseContentBundle();
    const hidden = [...real.relics.values()].filter((r) => r.unobtainable).map((r) => r.id);
    expect(hidden).toContain("DISCERNING_MONOCLE");
    for (const character of ["IRONCLAD", "SILENT", "DEFECT", "WATCHER"] as const) {
      const p = createRun({ seed: "NOMONOCLE", bundle: real, character }).run.pools;
      const pooled = [...p.commonRelics, ...p.uncommonRelics, ...p.rareRelics, ...p.shopRelics, ...p.bossRelics];
      for (const id of hidden) expect(pooled).not.toContain(id);
    }
  });
});

describe("master deck obtain hooks", () => {
  for (const c of [
    { relic: "FROZEN_EGG", card: "T_UNCOMMON_PWR_A" },
    { relic: "MOLTEN_EGG", card: "T_UNCOMMON_ATK_A" },
    { relic: "TOXIC_EGG", card: "T_UNCOMMON_SKL_A" },
  ] as const) {
    test(`${c.relic} upgrades matching shop card purchases`, () => {
      let s = eggRun(`SHOP-${c.relic}`);
      s.run.gold = 999;
      s.run.relics.push({ defId: c.relic, counter: 0 });
      s.run.room = {
        kind: "shop",
        shop: {
          cards: Array.from({ length: 7 }, () => ({ id: c.card, rarity: "uncommon" as const, price: 1, sold: false, colorless: false })),
          relics: Array.from({ length: 3 }, () => ({ id: "T_RELIC_C_A", tier: "common" as const, price: 999, sold: false })),
          potions: Array.from({ length: 3 }, () => ({ id: "T_POT_C_A", price: 999, sold: false })),
          removalCost: 999,
          removalUsed: false,
        },
      };

      s = advance(s, { cmd: "shopBuy", kind: "card", idx: 0 }, eggBundle);
      const bought = s.run.deck[s.run.deck.length - 1]!;
      expect(bought.defId).toBe(c.card);
      expect(bought.upgrades).toBe(1);
    });
  }
});

describe("Maw Bank", () => {
  function mawShopRun(): GameState {
    const s = createRun({ seed: "MAWBANK", bundle: mawBundle, character: "IRONCLAD" });
    s.run.gold = 500;
    s.run.relics.push({ defId: "MAW_BANK", counter: 0 });
    s.run.room = {
      kind: "shop",
      shop: {
        cards: Array.from({ length: 7 }, () => ({ id: "T_STRIKE", rarity: "common" as const, price: 10, sold: false, colorless: false })),
        relics: Array.from({ length: 3 }, () => ({ id: "T_RELIC_C_A", tier: "common" as const, price: 999, sold: false })),
        potions: Array.from({ length: 3 }, () => ({ id: "T_POT_C_A", price: 10, sold: false })),
        removalCost: 10,
        removalUsed: false,
      },
    };
    return s;
  }

  function climbAfterShop(s: GameState): { before: number; after: number } {
    s = advance(s, { cmd: "proceed" }, mawBundle);
    const before = s.run.gold;
    const x = s.run.map!.rows[0]!.findIndex((n) => n !== null);
    s = advance(s, { cmd: "mapPick", x, y: 0 }, mawBundle);
    return { before, after: s.run.gold };
  }

  test("leaving a shop without spending keeps paying 12 Gold per floor", () => {
    const { before, after } = climbAfterShop(mawShopRun());
    expect(after).toBe(before + 12);
  });

  for (const buy of [
    { cmd: "shopBuy", kind: "card", idx: 0 },
    { cmd: "shopBuy", kind: "potion", idx: 0 },
    { cmd: "shopRemove", deckIdx: 0 },
  ] as const) {
    test(`${buy.cmd}${"kind" in buy ? `:${buy.kind}` : ""} uses it up for later floors`, () => {
      const s = advance(mawShopRun(), buy, mawBundle);
      expect(s.run.relics.find((r) => r.defId === "MAW_BANK")?.counter).toBe(1);
      const { before, after } = climbAfterShop(s);
      expect(after).toBe(before);
    });
  }
});

describe("master deck removal hooks", () => {
  test("shop removal of Parasite lowers max HP and clamps current HP", () => {
    const s = advance(cardRemovalRun("PARASITE"), { cmd: "shopRemove", deckIdx: 0 }, parasiteBundle);

    expect(s.run.maxHp).toBe(77);
    expect(s.run.hp).toBe(77);
    expect(s.run.deck.map((c) => c.defId)).toEqual(["T_DEFEND"]);
  });

  test("transforming Parasite lowers max HP and clamps current HP", () => {
    const s = cardRemovalRun("PARASITE");
    const { ctx, saveRng } = makeTestCtx(s, parasiteBundle);

    transformDeckCard(ctx, 0);
    saveRng();

    expect(s.run.maxHp).toBe(77);
    expect(s.run.hp).toBe(77);
    expect(s.run.deck).toHaveLength(2);
    expect(s.run.deck.some((c) => c.defId === "PARASITE")).toBe(false);
  });

  test("removing a normal card leaves max HP unchanged", () => {
    const s = advance(cardRemovalRun("T_STRIKE"), { cmd: "shopRemove", deckIdx: 0 }, parasiteBundle);

    expect(s.run.maxHp).toBe(80);
    expect(s.run.hp).toBe(80);
    expect(s.run.deck.map((c) => c.defId)).toEqual(["T_DEFEND"]);
  });
});

describe("encounter list generation", () => {
  test("self-golden lists for seed GOLDEN", () => {
    const reg = new RngRegistry(seedFromString("GOLDEN"));
    const gen = generateEncounters(getActDef(bundle.acts, 1), reg.get("monsterRng"));
    expect(gen.monsterList).toEqual([
      "A1_WEAK_2", "A1_WEAK_4", "A1_WEAK_3",
      "A1_STRONG_5", "A1_STRONG_1", "A1_STRONG_4", "A1_STRONG_5", "A1_STRONG_1", "A1_STRONG_4",
      "A1_STRONG_5", "A1_STRONG_1", "A1_STRONG_3", "A1_STRONG_5", "A1_STRONG_1", "A1_STRONG_4", "A1_STRONG_3",
    ]);
    expect(gen.eliteList).toEqual([
      "A1_ELITE_1", "A1_ELITE_3", "A1_ELITE_1", "A1_ELITE_3", "A1_ELITE_2",
      "A1_ELITE_1", "A1_ELITE_3", "A1_ELITE_1", "A1_ELITE_3", "A1_ELITE_2",
    ]);
    expect(gen.bossOrder).toEqual(["A1_BOSS_2", "A1_BOSS_1", "A1_BOSS_3"]);
  });

  test("list shapes: act1 3 weak + 13 strong; 10 elites; boss order is a permutation", () => {
    for (let i = 0; i < 20; i++) {
      const reg = new RngRegistry(seedFromString(`E${i}`));
      const gen = generateEncounters(getActDef(bundle.acts, 1), reg.get("monsterRng"));
      expect(gen.monsterList.length).toBe(16);
      const weakIds = new Set(["A1_WEAK_1", "A1_WEAK_2", "A1_WEAK_3", "A1_WEAK_4"]);
      for (let k = 0; k < 3; k++) expect(weakIds.has(gen.monsterList[k]!)).toBe(true);
      for (let k = 3; k < 16; k++) expect(gen.monsterList[k]!.startsWith("A1_STRONG_")).toBe(true);
      expect(gen.eliteList.length).toBe(10);
      expect([...gen.bossOrder].sort()).toEqual(["A1_BOSS_1", "A1_BOSS_2", "A1_BOSS_3"]);
    }
  });

  test("no-repeat rules: never equal to either of the previous two (weak+strong); elites never repeat consecutively", () => {
    for (let i = 0; i < 40; i++) {
      const reg = new RngRegistry(seedFromString(`R${i}`));
      const gen = generateEncounters(getActDef(bundle.acts, 2), reg.get("monsterRng"));
      for (let k = 1; k < gen.monsterList.length; k++) {
        expect(gen.monsterList[k]).not.toBe(gen.monsterList[k - 1]);
        if (k >= 2) expect(gen.monsterList[k]).not.toBe(gen.monsterList[k - 2]);
      }
      for (let k = 1; k < gen.eliteList.length; k++) {
        expect(gen.eliteList[k]).not.toBe(gen.eliteList[k - 1]);
      }
    }
  });

  test("acts 2/3 generate 2 weak entries", () => {
    const reg = new RngRegistry(seedFromString("W23"));
    const gen2 = generateEncounters(getActDef(bundle.acts, 2), reg.get("monsterRng"));
    expect(gen2.monsterList.length).toBe(15);
    expect(gen2.monsterList[0]!.startsWith("A2_WEAK_")).toBe(true);
    expect(gen2.monsterList[1]!.startsWith("A2_WEAK_")).toBe(true);
    expect(gen2.monsterList[2]!.startsWith("A2_STRONG_")).toBe(true);
  });
});

describe("Neow", () => {
  test("4 options follow the table structure with exclusions", () => {
    for (let i = 0; i < 60; i++) {
      const s = run(`N${i}`);
      const room = s.run.room!;
      if (room.kind !== "neow") throw new Error("not neow");
      const [o0, o1, o2, o3] = room.options;
      expect(room.options.length).toBe(4);
      expect(NEOW_BONUS_TABLE_0).toContain(o0!.bonus);
      expect(o0!.drawback).toBe("NONE");
      expect(NEOW_BONUS_TABLE_1).toContain(o1!.bonus);
      expect(o1!.drawback).toBe("NONE");
      expect(NEOW_DRAWBACKS).toContain(o2!.drawback);
      if (o2!.drawback === "PERCENT_DAMAGE") {
        expect(NEOW_TIER2_ALL).toContain(o2!.bonus);
      } else {
        expect(NEOW_BONUS_BY_DRAWBACK[o2!.drawback as keyof typeof NEOW_BONUS_BY_DRAWBACK]).toContain(o2!.bonus);
      }
      // exclusions
      if (o2!.drawback === "TEN_PERCENT_HP_LOSS") expect(o2!.bonus).not.toBe("TWENTY_PERCENT_HP_BONUS");
      if (o2!.drawback === "NO_GOLD") expect(o2!.bonus).not.toBe("TWO_FIFTY_GOLD");
      if (o2!.drawback === "CURSE") expect(o2!.bonus).not.toBe("REMOVE_TWO");
      expect(o3).toEqual({ bonus: "BOSS_RELIC", drawback: "LOSE_STARTER_RELIC" });
    }
  });

  // seed RUNSEED rolls: [REMOVE_CARD/NONE, HUNDRED_GOLD/NONE, RANDOM_COLORLESS_2/NO_GOLD, BOSS_RELIC/LOSE_STARTER_RELIC]
  test("HUNDRED_GOLD grants 100 gold and returns to the map", () => {
    let s = run("RUNSEED");
    s = advance(s, { cmd: "neowPick", i: 1 }, bundle);
    expect(s.run.gold).toBe(199);
    expect(s.run.room!.kind).toBe("map");
  });

  test("BOSS_RELIC swaps the starter relic for the first shuffled boss relic", () => {
    let s = run("RUNSEED");
    const expected = s.run.pools.bossRelics[0]!;
    s = advance(s, { cmd: "neowPick", i: 3 }, bundle);
    expect(s.run.relics.map((r) => r.defId)).toEqual([expected]);
    expect(s.run.pools.bossRelics.length).toBe(7);
  });

  test("TEN_PERCENT_HP_BONUS raises max HP and heals by the same amount", () => {
    const s = run("NEOWHP10", 6);
    s.run.hp = 72;
    s.run.maxHp = 80;
    const { ctx } = makeTestCtx(s, bundle);

    expect(applyNeowBonus(ctx, "TEN_PERCENT_HP_BONUS")).toBeNull();
    expect(s.run.maxHp).toBe(88);
    expect(s.run.hp).toBe(80);
  });

  test("TWENTY_PERCENT_HP_BONUS uses twice the 10% floor and heals that amount", () => {
    const s = run("NEOWHP20");
    s.run.hp = 50;
    s.run.maxHp = 75;
    const { ctx } = makeTestCtx(s, bundle);

    expect(applyNeowBonus(ctx, "TWENTY_PERCENT_HP_BONUS")).toBeNull();
    expect(s.run.maxHp).toBe(89);
    expect(s.run.hp).toBe(64);
  });

  test("REMOVE_CARD opens a deck choice; choosing removes the card", () => {
    let s = run("RUNSEED");
    s = advance(s, { cmd: "neowPick", i: 0 }, bundle);
    expect(s.pending).not.toBeNull();
    expect(s.pending!.request.kind).toBe("cards");
    s = advance(s, { cmd: "choose", indices: [0] }, bundle);
    expect(s.run.deck.length).toBe(9);
    expect(s.run.room!.kind).toBe("map");
  });

  test("NO_GOLD + RANDOM_COLORLESS_2: gold zeroed, 3 distinct rare colorless offered", () => {
    let s = run("RUNSEED");
    s = advance(s, { cmd: "neowPick", i: 2 }, bundle);
    expect(s.run.gold).toBe(0);
    const room = s.run.room!;
    if (room.kind !== "rewards") throw new Error("expected rewards screen");
    const cards = room.entries.filter((e) => e.kind === "card");
    expect(cards.length).toBe(3);
    for (const c of cards) {
      if (c.kind !== "card") continue;
      expect(c.rarity).toBe("rare");
      expect(bundle.cards.get(c.id)!.color).toBe("colorless");
    }
    expect(new Set(cards.map((c) => (c.kind === "card" ? c.id : ""))).size).toBe(3);
    // take one card: whole group is consumed
    const deckBefore = s.run.deck.length;
    s = advance(s, { cmd: "takeReward", i: 0 }, bundle);
    expect(s.run.deck.length).toBe(deckBefore + 1);
    const after = s.run.room!;
    if (after.kind !== "rewards") throw new Error("still rewards");
    expect(after.entries.every((e) => e.taken)).toBe(true);
    s = advance(s, { cmd: "skipRewards" }, bundle);
    expect(s.run.room!.kind).toBe("map");
  });
});

describe("map flow", () => {
  test("mapPick validates moves and resolves rooms; floor streams reseed per floor", () => {
    let s = run("MAPF");
    s = advance(s, { cmd: "neowPick", i: 1 }, bundle);
    const row5x = s.run.map!.rows[5]!.findIndex((n) => n !== null);
    expect(() => advance(s, { cmd: "mapPick", x: row5x, y: 5 }, bundle)).toThrow("must start on row 0");
    const row0 = s.run.map!.rows[0]!;
    const x = row0.findIndex((n) => n !== null);
    s = advance(s, { cmd: "mapPick", x, y: 0 }, bundle);
    expect(s.run.floor).toBe(1);
    expect(s.run.position).toEqual([x, 0]);
    // row 0 is always a monster fight
    expect(s.run.room!.kind).toBe("combat");
    expect(s.combat).not.toBeNull();
    // floor streams were reseeded for floor 1 (fresh Rng, then combat setup consumed some)
    const reg = RngRegistry.fromState(s.rng);
    expect(reg.seed).toBe(seedFromString("MAPF"));
  });

  test("combat victory produces a rewards screen; gold/card claimable; skip returns to map", () => {
    let s = run("VICT");
    s = advance(s, { cmd: "neowPick", i: 1 }, bundle);
    const x = s.run.map!.rows[0]!.findIndex((n) => n !== null);
    s = advance(s, { cmd: "mapPick", x, y: 0 }, bundle);
    s = autoWinCombat(s, bundle);
    expect(s.combat).toBeNull();
    const room = s.run.room!;
    if (room.kind !== "rewards") throw new Error("expected rewards");
    expect(room.source).toBe("monster");
    const goldIdx = room.entries.findIndex((e) => e.kind === "gold");
    const gold = room.entries[goldIdx]!;
    if (gold.kind !== "gold") throw new Error("no gold");
    expect(gold.amount).toBeGreaterThanOrEqual(10);
    expect(gold.amount).toBeLessThanOrEqual(20);
    const before = s.run.gold;
    s = advance(s, { cmd: "takeReward", i: goldIdx }, bundle);
    expect(s.run.gold).toBe(before + gold.amount);
    expect(() => advance(s, { cmd: "takeReward", i: goldIdx }, bundle)).toThrow("already taken");
    const roomAfterGold = s.run.room!;
    const cardIdx = roomAfterGold.kind === "rewards" ? roomAfterGold.entries.findIndex((e) => e.kind === "card" && !e.taken) : -1;
    const deckBefore = s.run.deck.length;
    s = advance(s, { cmd: "takeReward", i: cardIdx }, bundle);
    expect(s.run.deck.length).toBe(deckBefore + 1);
    s = advance(s, { cmd: "skipRewards" }, bundle);
    expect(s.run.room!.kind).toBe("map");
    expect(s.run.history.combatsThisAct).toBe(1);
  });

  test("Singing Bowl reward raises current and max HP instead of taking a card", () => {
    const s = singingBowlRewardRun();
    const deckBefore = s.run.deck.length;
    const after = advance(s, { cmd: "takeSingingBowlReward", group: 0 }, bundle);
    expect(after.run.maxHp).toBe(82);
    expect(after.run.hp).toBe(42);
    expect(after.run.deck.length).toBe(deckBefore);
    const room = after.run.room;
    if (room?.kind !== "rewards") throw new Error("expected rewards");
    expect(room.entries.every((e) => e.kind !== "card" || e.taken)).toBe(true);
    expect(() => advance(after, { cmd: "takeReward", i: 0 }, bundle)).toThrow("already taken");
  });

  test("Singing Bowl reward cannot be used twice for the same card group", () => {
    const after = advance(singingBowlRewardRun(), { cmd: "takeSingingBowlReward", group: 0 }, bundle);
    expect(() => advance(after, { cmd: "takeSingingBowlReward", group: 0 }, bundle)).toThrow("already taken");
  });

  test("player death in a run sets outcome and gameOver room", () => {
    let s = run("DEATH");
    s.run.hp = 1;
    s.run.maxHp = 1; // survivable-by-nothing
    s = advance(s, { cmd: "neowPick", i: 1 }, bundle);
    const x = s.run.map!.rows[0]!.findIndex((n) => n !== null);
    s = advance(s, { cmd: "mapPick", x, y: 0 }, bundle);
    let guard = 0;
    while (!s.outcome && guard++ < 40) s = advance(s, { cmd: "endTurn" }, bundle);
    expect(s.outcome?.kind).toBe("death");
    expect(s.run.room!.kind).toBe("gameOver");
  });
});

describe("? room resolution", () => {
  function freshCtx(seed: string) {
    const s = run(seed);
    return { s, ...makeTestCtx(s, bundle) };
  }

  test("thresholds use int(chance*100); chosen resets, others escalate", () => {
    for (let i = 0; i < 30; i++) {
      const { s, ctx } = freshCtx(`U${i}`);
      const before = { ...s.run.blizzard };
      const outcome = resolveUnknownRoom(ctx);
      const b = s.run.blizzard;
      expect(Math.abs(b.monsterChance - (outcome === "monster" ? 0.1 : before.monsterChance + 0.1))).toBeLessThan(1e-6);
      expect(Math.abs(b.shopChance - (outcome === "shop" ? 0.03 : before.shopChance + 0.03))).toBeLessThan(1e-6);
      expect(Math.abs(b.treasureChance - (outcome === "treasure" ? 0.02 : before.treasureChance + 0.02))).toBeLessThan(1e-6);
    }
  });

  test("escalation drives outcomes: monsterChance 1.0 forces MONSTER", () => {
    const { s, ctx } = freshCtx("UF");
    s.run.blizzard.monsterChance = 1.0;
    expect(resolveUnknownRoom(ctx)).toBe("monster");
    expect(s.run.blizzard.monsterChance).toBeCloseTo(0.1, 6);
  });

  test("lastRoomWasShop removes the shop share", () => {
    const { s, ctx } = freshCtx("USHOP");
    s.run.blizzard.monsterChance = 0;
    s.run.blizzard.shopChance = 1.0;
    s.run.blizzard.treasureChance = 0;
    s.run.history.lastRoomWasShop = true;
    expect(resolveUnknownRoom(ctx)).toBe("event"); // shop share suppressed
    const { s: s2, ctx: ctx2 } = freshCtx("USHOP");
    s2.run.blizzard.monsterChance = 0;
    s2.run.blizzard.shopChance = 1.0;
    s2.run.blizzard.treasureChance = 0;
    expect(resolveUnknownRoom(ctx2)).toBe("shop");
  });

  test("Tiny Chest forces every 4th ? room to treasure without consuming the roll", () => {
    const { s, ctx, registry } = freshCtx("TINY");
    s.run.relics.push({ defId: "TINY_CHEST", counter: 0 });
    s.run.history.tinyChestCounter = 3;
    const counterBefore = registry.get("eventRng").counter;
    expect(resolveUnknownRoom(ctx)).toBe("treasure");
    expect(registry.get("eventRng").counter).toBe(counterBefore); // bypassed
    expect(s.run.history.tinyChestCounter).toBe(0);
    expect(s.run.blizzard.treasureChance).toBeCloseTo(0.02, 6); // reset as "chosen"
  });

  test("Juzu Bracelet converts MONSTER to EVENT (monster chance still resets)", () => {
    const { s, ctx } = freshCtx("JUZU");
    s.run.relics.push({ defId: "JUZU_BRACELET", counter: 0 });
    s.run.blizzard.monsterChance = 1.0;
    expect(resolveUnknownRoom(ctx)).toBe("event");
    expect(s.run.blizzard.monsterChance).toBeCloseTo(0.1, 6);
  });

  test("event selection runs on an eventRng COPY and removes the pick from its pool", () => {
    const { s, ctx, registry } = freshCtx("EVSEL");
    const counterBefore = registry.get("eventRng").counter;
    const poolBefore = [...s.run.pools.eventList, ...s.run.pools.shrineList, ...s.run.pools.oneTimeEventList];
    const id = generateEventId(ctx);
    expect(id).not.toBeNull();
    expect(poolBefore).toContain(id!);
    expect(registry.get("eventRng").counter).toBe(counterBefore); // main stream untouched
    const poolAfter = [...s.run.pools.eventList, ...s.run.pools.shrineList, ...s.run.pools.oneTimeEventList];
    expect(poolAfter.length).toBe(poolBefore.length - 1);
    expect(poolAfter).not.toContain(id!);
  });

  test("shrine chance constant", () => {
    expect(UNKNOWN_ROOM.base).toEqual({ monster: 0.1, shop: 0.03, treasure: 0.02 });
  });
});

describe("rooms: rest / treasure / shop / event stubs", () => {
  function shopOf(state: GameState) {
    const room = state.run.room;
    if (room?.kind !== "shop") throw new Error("expected shop");
    return room.shop;
  }

  function forceRoom(
    seed: string,
    room: (ctx: ReturnType<typeof makeTestCtx>["ctx"], state: GameState) => void,
    content = bundle,
  ): GameState {
    let s = createRun({ seed, bundle: content, character: "IRONCLAD" });
    s = advance(s, { cmd: "neowPick", i: 1 }, content);
    const { ctx, saveRng } = makeTestCtx(s, content);
    room(ctx, s);
    saveRng();
    return s;
  }

  test("rest heals floor(30% max HP); one use per site", () => {
    let s = forceRoom("REST", (ctx) => {
      ctx.run.room = { kind: "rest", used: false };
    });
    s.run.hp = 100;
    const maxHp = s.run.maxHp; // Neow's bonus may have raised it
    const expected = Math.min(maxHp, 100 + restHealAmount(maxHp));
    s = advance(s, { cmd: "restOption", kind: "rest" }, bundle);
    expect(s.run.hp).toBe(expected);
    expect(restHealAmount(maxHp)).toBe(Math.floor(maxHp * 0.3));
    expect(() => advance(s, { cmd: "restOption", kind: "rest" }, bundle)).toThrow("already used");
    s = advance(s, { cmd: "proceed" }, bundle);
    expect(s.run.room!.kind).toBe("map");
  });

  test("Regal Pillow adds exactly 15 HP to one Rest", () => {
    let s = createRun({ seed: "PILLOW", bundle: pillowBundle, character: "IRONCLAD" });
    s.run.relics.push({ defId: "REGAL_PILLOW", counter: 0 });
    s.run.room = { kind: "rest", used: false };
    s.run.hp = 10;
    const expected = 10 + restHealAmount(s.run.maxHp) + 15;
    s = advance(s, { cmd: "restOption", kind: "rest" }, pillowBundle);
    expect(s.run.hp).toBe(expected);
  });

  describe("Dream Catcher", () => {
    function atDreamCatcherRest(seed: string): GameState {
      const s = forceRoom(seed, (ctx) => {
        ctx.run.room = { kind: "rest", used: false };
      });
      s.run.relics.push({ defId: "DREAM_CATCHER", counter: 0 });
      return s;
    }

    test("rest offers a skippable card reward", () => {
      const before = atDreamCatcherRest("DREAM_SKIP");
      const out = advance(before, { cmd: "restOption", kind: "rest" }, bundle);
      const room = out.run.room;
      expect(room?.kind).toBe("rewards");
      if (room?.kind !== "rewards") throw new Error("expected rewards");
      expect(room.source).toBe("relic");
      expect(room.entries.filter((e) => e.kind === "card")).toHaveLength(3);
      const skipped = advance(out, { cmd: "skipRewards" }, bundle);
      expect(skipped.run.deck).toHaveLength(before.run.deck.length);
      expect(skipped.run.room).toEqual({ kind: "map" });
    });

    test("choosing a Dream Catcher card adds it to the deck", () => {
      const before = atDreamCatcherRest("DREAM_TAKE");
      let out = advance(before, { cmd: "restOption", kind: "rest" }, bundle);
      const room = out.run.room;
      if (room?.kind !== "rewards") throw new Error("expected rewards");
      const rewardIndex = room.entries.findIndex((e) => e.kind === "card");
      const reward = room.entries[rewardIndex];
      if (!reward || reward.kind !== "card") throw new Error("expected card reward");
      out = advance(out, { cmd: "takeReward", i: rewardIndex }, bundle);
      expect(out.run.deck).toHaveLength(before.run.deck.length + 1);
      expect(out.run.deck.at(-1)).toMatchObject({ defId: reward.id, upgrades: reward.upgraded ? 1 : 0 });
    });

    test("smithing and recalling do not offer Dream Catcher rewards", () => {
      const smithed = advance(
        atDreamCatcherRest("DREAM_SMITH"),
        { cmd: "restOption", kind: "smith", deckIdx: 0 },
        bundle,
      );
      expect(smithed.run.room).toEqual({ kind: "rest", used: true });

      const recalled = advance(atDreamCatcherRest("DREAM_RECALL"), { cmd: "restOption", kind: "recall" }, bundle);
      expect(recalled.run.keys.ruby).toBe(true);
      expect(recalled.run.room).toEqual({ kind: "rest", used: true });
    });

    test("card-count relics modify the Dream Catcher reward", () => {
      const question = atDreamCatcherRest("DREAM_QUESTION");
      question.run.relics.push({ defId: "QUESTION_CARD", counter: 0 });
      const questionOut = advance(question, { cmd: "restOption", kind: "rest" }, bundle);
      expect(
        questionOut.run.room?.kind === "rewards"
          ? questionOut.run.room.entries.filter((e) => e.kind === "card")
          : [],
      ).toHaveLength(4);

      const crown = atDreamCatcherRest("DREAM_CROWN");
      crown.run.relics.push({ defId: "BUSTED_CROWN", counter: 0 });
      const crownOut = advance(crown, { cmd: "restOption", kind: "rest" }, bundle);
      expect(
        crownOut.run.room?.kind === "rewards"
          ? crownOut.run.room.entries.filter((e) => e.kind === "card")
          : [],
      ).toHaveLength(1);
    });

    test("Dream Catcher reward survives JSON save/load", () => {
      const out = advance(atDreamCatcherRest("DREAM_SAVE"), { cmd: "restOption", kind: "rest" }, bundle);
      const saved = JSON.parse(JSON.stringify(out)) as GameState;
      const room = saved.run.room;
      if (room?.kind !== "rewards") throw new Error("expected rewards");
      const rewardIndex = room.entries.findIndex((e) => e.kind === "card");
      const reward = room.entries[rewardIndex];
      if (!reward || reward.kind !== "card") throw new Error("expected card reward");
      const resumed = advance(saved, { cmd: "takeReward", i: rewardIndex }, bundle);
      expect(resumed.run.deck.at(-1)).toMatchObject({ defId: reward.id, upgrades: reward.upgraded ? 1 : 0 });
    });
  });

  // Issue #7: the option list was hardcoded, so five relics that change what a
  // campfire offers did nothing. Availability follows the reference's bitset.
  describe("relics that change the campfire", () => {
    const atRest = (seed: string, relics: string[]): GameState => {
      const s = forceRoom(seed, (ctx) => {
        ctx.run.room = { kind: "rest", used: false };
      });
      for (const defId of relics) s.run.relics.push({ defId, counter: 0 });
      return s;
    };

    test("Coffee Dripper removes Rest; Fusion Hammer removes Smith", () => {
      const dripper = atRest("DRIP", ["COFFEE_DRIPPER"]);
      expect(() => advance(dripper, { cmd: "restOption", kind: "rest" }, bundle)).toThrow("not available");
      // smithing still works for it
      expect(advance(dripper, { cmd: "restOption", kind: "smith", deckIdx: 0 }, bundle).run.deck[0]!.upgrades).toBe(1);

      const hammer = atRest("HAMMER", ["FUSION_HAMMER"]);
      expect(() => advance(hammer, { cmd: "restOption", kind: "smith", deckIdx: 0 }, bundle)).toThrow("not available");
      expect(advance(hammer, { cmd: "restOption", kind: "rest" }, bundle).run.room).toEqual({ kind: "rest", used: true });
    });

    test("Girya banks a lift, three times and no more", () => {
      let s = atRest("GIRYA1", ["GIRYA"]);
      const girya = () => s.run.relics.find((r) => r.defId === "GIRYA")!;
      for (let i = 1; i <= 3; i++) {
        s = advance(s, { cmd: "restOption", kind: "lift" }, bundle);
        expect(girya().counter).toBe(i);
        s.run.room = { kind: "rest", used: false }; // next campfire
      }
      expect(() => advance(s, { cmd: "restOption", kind: "lift" }, bundle)).toThrow("not available");
      expect(girya().counter).toBe(3);
    });

    test("Shovel digs up a relic from the pool", () => {
      const s = atRest("DIG", ["SHOVEL"]);
      const before = s.run.relics.length;
      const out = advance(s, { cmd: "restOption", kind: "dig" }, bundle);
      expect(out.run.relics.length).toBe(before + 1);
      expect(out.run.room).toEqual({ kind: "rest", used: true });
    });

    test("Peace Pipe removes the chosen card and spends the site", () => {
      const s = atRest("TOKE", ["PEACE_PIPE"]);
      const size = s.run.deck.length;
      const removed = s.run.deck[1]!.defId;
      let out = advance(s, { cmd: "restOption", kind: "toke" }, bundle);
      expect(out.pending).not.toBeNull(); // it asks which card
      out = advance(out, { cmd: "choose", indices: [1] }, bundle);
      expect(out.run.deck.length).toBe(size - 1);
      expect(out.run.deck.filter((c) => c.defId === removed).length).toBeLessThan(
        s.run.deck.filter((c) => c.defId === removed).length,
      );
      expect(out.run.room).toEqual({ kind: "rest", used: true });
    });

    test("without the relics none of the extra options exist", () => {
      const s = atRest("PLAIN", []);
      for (const kind of ["lift", "toke", "dig"] as const) {
        expect(() => advance(s, { cmd: "restOption", kind }, bundle)).toThrow("not available");
      }
    });
  });

  test("smith upgrades a card; upgraded cards cannot smith again", () => {
    let s = forceRoom("SMITH", (ctx) => {
      ctx.run.room = { kind: "rest", used: false };
    });
    s = advance(s, { cmd: "restOption", kind: "smith", deckIdx: 0 }, bundle);
    expect(s.run.deck[0]!.upgrades).toBe(1);
    let s2 = forceRoom("SMITH2", (ctx) => {
      ctx.run.room = { kind: "rest", used: false };
    });
    s2.run.deck[0]!.upgrades = 1;
    expect(() => advance(s2, { cmd: "restOption", kind: "smith", deckIdx: 0 }, bundle)).toThrow("cannot be upgraded");
  });

  test("treasure: openChest reveals relic before linked sapphire-key choice", () => {
    let s = forceRoom("CHESTO", (ctx) => {
      ctx.run.room = { kind: "treasure", chest: setupTreasureRoom(ctx) };
    });
    const room = s.run.room;
    if (room?.kind !== "treasure") throw new Error("expected treasure");
    const expectedRelic = room.chest.relicTier === "common"
      ? s.run.pools.commonRelics[0]!
      : room.chest.relicTier === "uncommon"
        ? s.run.pools.uncommonRelics[0]!
        : s.run.pools.rareRelics[0]!;
    const relicsBefore = s.run.relics.length;
    s = advance(s, { cmd: "openChest" }, bundle);
    expect(s.run.relics.length).toBe(relicsBefore);
    expect(s.run.room?.kind).toBe("treasure");
    if (s.run.room?.kind !== "treasure") throw new Error("expected treasure");
    expect(s.run.room.chest.pendingRelicId).toBe(expectedRelic);
    expect(() => advance(s, { cmd: "openChest" }, bundle)).toThrow("already opened");
  });

  test("treasure: choosing sapphire key forfeits revealed relic", () => {
    let s = forceRoom("CHESTK", (ctx) => {
      ctx.run.room = { kind: "treasure", chest: setupTreasureRoom(ctx) };
    });
    const relicsBefore = s.run.relics.length;
    s = advance(s, { cmd: "openChest" }, bundle);
    s = advance(s, { cmd: "takeSapphireKey" }, bundle);
    expect(s.run.keys.sapphire).toBe(true);
    expect(s.run.relics.length).toBe(relicsBefore);
    expect(() => advance(s, { cmd: "takeChestRelic" }, bundle)).toThrow("already claimed");
  });

  test("treasure: choosing relic leaves sapphire key available for later chests", () => {
    let s = forceRoom("CHESTR", (ctx) => {
      ctx.run.room = { kind: "treasure", chest: setupTreasureRoom(ctx) };
    });
    const relicsBefore = s.run.relics.length;
    s = advance(s, { cmd: "openChest" }, bundle);
    s = advance(s, { cmd: "takeChestRelic" }, bundle);
    expect(s.run.keys.sapphire).toBe(false);
    expect(s.run.relics.length).toBe(relicsBefore + 1);
    expect(() => advance(s, { cmd: "takeSapphireKey" }, bundle)).toThrow("already claimed");

    const { ctx, saveRng } = makeTestCtx(s, bundle);
    ctx.run.room = { kind: "treasure", chest: setupTreasureRoom(ctx) };
    saveRng();
    if (s.run.room?.kind !== "treasure") throw new Error("expected treasure");
    expect(s.run.room.chest.sapphireKeyAvailable).toBe(true);
  });

  test("treasure: no-key-available open still grants relic immediately", () => {
    let s = forceRoom("CHESTNOKEY", (ctx) => {
      ctx.run.keys.sapphire = true;
      ctx.run.room = { kind: "treasure", chest: setupTreasureRoom(ctx) };
    });
    const relicsBefore = s.run.relics.length;
    s = advance(s, { cmd: "openChest" }, bundle);
    expect(s.run.relics.length).toBe(relicsBefore + 1);
    if (s.run.room?.kind !== "treasure") throw new Error("expected treasure");
    expect(s.run.room.chest.pendingRelicId).toBeNull();
  });

  test("treasure: sapphire choice does not change the chest relic roll", () => {
    let choice = forceRoom("CHESTRNG", (ctx) => {
      ctx.run.room = { kind: "treasure", chest: setupTreasureRoom(ctx) };
    });
    let immediate = forceRoom("CHESTRNG", (ctx) => {
      ctx.run.keys.sapphire = true;
      ctx.run.room = { kind: "treasure", chest: setupTreasureRoom(ctx) };
    });
    choice = advance(choice, { cmd: "openChest" }, bundle);
    immediate = advance(immediate, { cmd: "openChest" }, bundle);
    if (choice.run.room?.kind !== "treasure") throw new Error("expected treasure");
    const granted = immediate.run.relics[immediate.run.relics.length - 1]!.defId;
    expect(choice.run.room.chest.pendingRelicId).toBe(granted);
  });

  test("shop: buy card/relic/potion, gold checks, removal escalation across visits", () => {
    let s = forceRoom("SHOPC", (ctx) => {
      ctx.run.room = { kind: "shop", shop: generateShop(ctx) };
    });
    s.run.gold = 5000;
    const room = s.run.room!;
    if (room.kind !== "shop") throw new Error("not shop");
    const cardPrice = room.shop.cards[0]!.price;
    const deckBefore = s.run.deck.length;
    s = advance(s, { cmd: "shopBuy", kind: "card", idx: 0 }, bundle);
    expect(s.run.gold).toBe(5000 - cardPrice);
    expect(s.run.deck.length).toBe(deckBefore + 1);
    expect(() => advance(s, { cmd: "shopBuy", kind: "card", idx: 0 }, bundle)).toThrow("unavailable");

    s = advance(s, { cmd: "shopBuy", kind: "relic", idx: 2 }, bundle);
    expect(s.run.relics.some((r) => r.defId.startsWith("T_RELIC_S_"))).toBe(true); // SHOP tier slot
    expect(s.run.room?.kind === "shop" && s.run.room.shop.relics[2]!.sold).toBe(true);

    s = advance(s, { cmd: "shopBuy", kind: "potion", idx: 0 }, bundle);
    expect(s.run.potions.filter((p) => p !== null).length).toBe(1);
    expect(s.run.room?.kind === "shop" && s.run.room.shop.potions[0]!.sold).toBe(true);

    // removal
    const shopRoom = s.run.room!;
    if (shopRoom.kind !== "shop") throw new Error("not shop");
    expect(shopRoom.shop.removalCost).toBe(75);
    // a bottled card is not purgeable: a REMOVE screen never lists one
    s.run.deck[0]!.bottled = true;
    expect(() => advance(s, { cmd: "shopRemove", deckIdx: 0 }, bundle)).toThrow("bottled");
    s.run.deck[0]!.bottled = false;
    s = advance(s, { cmd: "shopRemove", deckIdx: 0 }, bundle);
    expect(s.run.history.cardRemovesPurchased).toBe(1);
    expect(() => advance(s, { cmd: "shopRemove", deckIdx: 0 }, bundle)).toThrow("already used");

    // a later shop prices removal at 100
    const { ctx, saveRng } = makeTestCtx(s, bundle);
    ctx.run.room = { kind: "shop", shop: generateShop(ctx) };
    saveRng();
    const later = s.run.room!;
    if (later.kind !== "shop") throw new Error("not shop");
    expect(later.shop.removalCost).toBe(100);
  });

  test("shop: Courier restocks bought card, relic, and potion slots", () => {
    let s = forceRoom(
      "COURIER",
      (ctx, state) => {
        giveRelic(state, "THE_COURIER");
        ctx.run.room = { kind: "shop", shop: generateShop(ctx) };
      },
      courierBundle,
    );
    s.run.gold = 5000;
    let shop = shopOf(s);

    const boughtCard = shop.cards[0]!;
    const boughtCardType = courierBundle.cards.get(boughtCard.id)!.type;
    const boughtRelic = shop.relics[0]!.id;
    const boughtPotion = shop.potions[0]!.id;

    s = advance(s, { cmd: "shopBuy", kind: "card", idx: 0 }, courierBundle);
    shop = shopOf(s);
    expect(shop.cards[0]!.sold).toBe(false);
    expect(courierBundle.cards.get(shop.cards[0]!.id)!.type).toBe(boughtCardType);
    expect(s.run.deck.some((c) => c.defId === boughtCard.id)).toBe(true);

    s = advance(s, { cmd: "shopBuy", kind: "relic", idx: 0 }, courierBundle);
    shop = shopOf(s);
    expect(shop.relics[0]!.sold).toBe(false);
    expect(shop.relics[0]!.tier).not.toBe("shop");
    expect(s.run.relics.some((r) => r.defId === boughtRelic)).toBe(true);

    s = advance(s, { cmd: "shopBuy", kind: "potion", idx: 0 }, courierBundle);
    shop = shopOf(s);
    expect(shop.potions[0]!.sold).toBe(false);
    expect(s.run.potions).toContain(boughtPotion);
  });

  test("shop: Courier restock prices use the normal rounded discount path", () => {
    const makeShop = (seed: string, content = courierBundle) =>
      forceRoom(
        seed,
        (ctx, state) => {
          giveRelic(state, "THE_COURIER");
          ctx.run.room = { kind: "shop", shop: generateShop(ctx) };
        },
        content,
      );
    let plain = makeShop("COURIER_PRICE", courierNoDiscountBundle);
    let discounted = makeShop("COURIER_PRICE", courierBundle);
    if (plain.run.room?.kind !== "shop" || discounted.run.room?.kind !== "shop") throw new Error("expected shop");
    plain.run.gold = 5000;
    discounted.run.gold = 5000;
    plain = advance(plain, { cmd: "shopBuy", kind: "card", idx: 0 }, courierNoDiscountBundle);
    discounted = advance(discounted, { cmd: "shopBuy", kind: "card", idx: 0 }, courierBundle);
    if (plain.run.room?.kind !== "shop" || discounted.run.room?.kind !== "shop") throw new Error("expected shop");
    const plainSlot = plain.run.room.shop.cards[0]!;
    const discountedSlot = discounted.run.room.shop.cards[0]!;
    expect(discountedSlot.sold).toBe(false);
    expect(discountedSlot.id).toBe(plainSlot.id);
    expect(discountedSlot.rarity).toBe(plainSlot.rarity);
    expect(discountedSlot.price).toBe(Math.round(plainSlot.price * 0.8));
  });

  test("shop: buying Courier itself does not restock the purchased slot", () => {
    let s = forceRoom(
      "BUY_COURIER",
      (ctx) => {
        ctx.run.room = { kind: "shop", shop: generateShop(ctx) };
        ctx.run.room.shop.relics[0] = { id: "THE_COURIER", tier: "uncommon", price: 10, sold: false };
      },
      courierBundle,
    );
    s.run.gold = 5000;
    s = advance(s, { cmd: "shopBuy", kind: "relic", idx: 0 }, courierBundle);
    if (s.run.room?.kind !== "shop") throw new Error("expected shop");
    expect(s.run.room.shop.relics[0]!.sold).toBe(true);
    expect(s.run.relics.some((r) => r.defId === "THE_COURIER")).toBe(true);
  });

  test("shop: Courier restock is deterministic for a fixed seed", () => {
    const play = () => {
      let s = forceRoom(
        "COURIER_DET",
        (ctx, state) => {
          giveRelic(state, "THE_COURIER");
          ctx.run.room = { kind: "shop", shop: generateShop(ctx) };
        },
        courierBundle,
      );
      s.run.gold = 5000;
      s = advance(s, { cmd: "shopBuy", kind: "card", idx: 0 }, courierBundle);
      s = advance(s, { cmd: "shopBuy", kind: "relic", idx: 0 }, courierBundle);
      s = advance(s, { cmd: "shopBuy", kind: "potion", idx: 0 }, courierBundle);
      return JSON.stringify({ run: s.run, rng: s.rng });
    };
    expect(play()).toBe(play());
  });

  test("shop with empty gold refuses purchases", () => {
    let s = forceRoom("SHOPP", (ctx) => {
      ctx.run.room = { kind: "shop", shop: generateShop(ctx) };
    });
    s.run.gold = 0;
    expect(() => advance(s, { cmd: "shopBuy", kind: "card", idx: 0 }, bundle)).toThrow("not enough gold");
  });

  // Real events live in src/content/events (tests/content/events.test.ts); the
  // run test bundle's fake event ids exercise the leave-only fallback path.
  test("event rooms with unknown event ids fall back to a single leave option (roll consumption stays exact)", () => {
    let s = forceRoom("EVSTUB", (ctx) => {
      ctx.run.room = { kind: "event", eventId: generateEventId(ctx) };
    });
    s = advance(s, { cmd: "eventOption", i: 0 }, bundle);
    expect(s.run.room!.kind).toBe("map");
  });
});

describe("potions", () => {
  test("usePotion consumes the slot; discardPotion clears it", () => {
    let s = run("POTU");
    s.run.potions[0] = "T_POT_C_A";
    s.run.potions[1] = "T_POT_U_A";
    s = advance(s, { cmd: "usePotion", slot: 0 }, bundle);
    expect(s.run.potions[0]).toBeNull();
    s = advance(s, { cmd: "discardPotion", slot: 1 }, bundle);
    expect(s.run.potions[1]).toBeNull();
    expect(() => advance(s, { cmd: "usePotion", slot: 0 }, bundle)).toThrow("no potion");
  });
});

describe("Cursed Key", () => {
  test("opening a non-boss chest obtains a random standard curse", () => {
    let s = cursedKeyRun("CK-CHEST");
    s.run.relics.push({ defId: "CURSED_KEY", counter: 0 });
    putTreasureRoom(s);

    s = advance(s, { cmd: "openChest" }, cursedKeyBundle);

    expect(curseCount(s)).toBe(1);
    const obtained = s.run.deck[s.run.deck.length - 1]!;
    expect(cursedKeyBundle.cards.get(obtained.defId)?.rarity).toBe("curse");
  });

  test("opening a chest without Cursed Key does not add a curse", () => {
    let s = cursedKeyRun("CK-NONE");
    putTreasureRoom(s);

    s = advance(s, { cmd: "openChest" }, cursedKeyBundle);

    expect(curseCount(s)).toBe(0);
  });

  test("taking the Sapphire Key still counts as opening the chest", () => {
    let s = cursedKeyRun("CK-SAPPHIRE");
    s.run.relics.push({ defId: "CURSED_KEY", counter: 0 });
    putTreasureRoom(s);

    s = advance(s, { cmd: "openChest" }, cursedKeyBundle);
    s = advance(s, { cmd: "takeSapphireKey" }, cursedKeyBundle);

    expect(s.run.keys.sapphire).toBe(true);
    expect(curseCount(s)).toBe(1);
  });

  test("boss relic rewards do not count as non-boss chests", () => {
    let s = cursedKeyRun("CK-BOSS");
    s.run.relics.push({ defId: "CURSED_KEY", counter: 0 });
    s.run.room = {
      kind: "rewards",
      source: "boss",
      entries: [{ kind: "bossRelic", group: 0, id: "T_RELIC_B_A", taken: false }],
    };

    s = advance(s, { cmd: "takeReward", i: 0 }, cursedKeyBundle);

    expect(s.run.relics.map((r) => r.defId)).toContain("T_RELIC_B_A");
    expect(curseCount(s)).toBe(0);
  });

  test("Cursed Key obtains through the deck-add path so Omamori can veto it", () => {
    let s = cursedKeyRun("CK-OMAMORI");
    s.run.relics.push({ defId: "CURSED_KEY", counter: 0 }, { defId: "OMAMORI", counter: 1 });
    putTreasureRoom(s);

    s = advance(s, { cmd: "openChest" }, cursedKeyBundle);

    expect(curseCount(s)).toBe(0);
    expect(s.run.relics.find((r) => r.defId === "OMAMORI")?.counter).toBe(0);
  });

  test("Omamori from the same chest is not equipped in time to block the curse", () => {
    let s = cursedKeyRun("CK-SAME-CHEST-OMAMORI");
    s.run.relics.push({ defId: "CURSED_KEY", counter: 0 });
    s.run.pools.commonRelics = ["OMAMORI"];
    putTreasureRoom(s);

    s = advance(s, { cmd: "openChest" }, cursedKeyBundle);
    s = advance(s, { cmd: "takeChestRelic" }, cursedKeyBundle);

    expect(curseCount(s)).toBe(1);
    expect(s.run.relics.find((r) => r.defId === "OMAMORI")?.counter).toBe(2);
  });
});

describe("Matryoshka", () => {
  test("adds an extra relic to the next two non-boss chests, then becomes used up", () => {
    let s = matryoshkaRun("MATRYOSHKA");
    giveMatryoshka(s);

    let opened = openMatryoshkaChest(s);
    s = opened.state;
    expect(opened.gained).toBe(2);
    expect(matryoshkaCounter(s)).toBe(1);

    opened = openMatryoshkaChest(s);
    s = opened.state;
    expect(opened.gained).toBe(2);
    expect(matryoshkaCounter(s)).toBe(-2);

    opened = openMatryoshkaChest(s);
    s = opened.state;
    expect(opened.gained).toBe(1);
    expect(matryoshkaCounter(s)).toBe(-2);
  });

  test("taking the Sapphire Key still grants Matryoshka's extra relic", () => {
    let s = matryoshkaRun("MATRYOSHKA-KEY");
    giveMatryoshka(s);
    putTreasureRoom(s);
    const before = s.run.relics.length;

    s = advance(s, { cmd: "openChest" }, matryoshkaBundle);
    s = advance(s, { cmd: "takeSapphireKey" }, matryoshkaBundle);

    expect(s.run.keys.sapphire).toBe(true);
    expect(s.run.relics.length - before).toBe(1);
    expect(matryoshkaCounter(s)).toBe(1);
  });
});

describe("act transitions", () => {
  test("boss victory: boss rewards + 3-relic choice, then act 2 with counter jump and resets", () => {
    let s = run("ACTS");
    s = walkUntil(s, bundle, (st) => st.run.room!.kind === "rewards" && st.run.room!.source === "boss");
    const room = s.run.room!;
    if (room.kind !== "rewards") throw new Error("not rewards");
    const gold = room.entries.find((e) => e.kind === "gold");
    if (!gold || gold.kind !== "gold") throw new Error("no boss gold");
    expect(gold.amount).toBeGreaterThanOrEqual(95);
    expect(gold.amount).toBeLessThanOrEqual(105);
    expect(room.entries.filter((e) => e.kind === "bossRelic").length).toBe(3);
    expect(room.entries.filter((e) => e.kind === "card").length).toBe(3); // act 1 -> rare card reward exists
    // boss chest floor bump already applied
    expect(s.run.floor).toBe(17);

    // take one boss relic: the whole group closes
    const relicIdx = room.entries.findIndex((e) => e.kind === "bossRelic");
    s = advance(s, { cmd: "takeReward", i: relicIdx }, bundle);
    const after = s.run.room!;
    if (after.kind !== "rewards") throw new Error("not rewards");
    expect(after.entries.filter((e) => e.kind === "bossRelic").every((e) => e.taken)).toBe(true);

    // dirty the counters/chances so the reset is observable
    expect(s.rng.run.cardRng.counter).toBeLessThan(250);
    s = advance(s, { cmd: "skipRewards" }, bundle);
    expect(s.run.act).toBe(2);
    expect(s.rng.run.cardRng.counter).toBe(250); // the documented counter JUMP
    expect(s.run.position).toBeNull();
    expect(s.run.map!.act).toBe(2);
    expect(s.run.blizzard.potionChance).toBe(0);
    expect(s.run.blizzard.monsterChance).toBeCloseTo(0.1, 6);
    expect(s.run.pools.monsterList.every((e) => e.startsWith("A2_"))).toBe(true);
    expect(s.run.pools.eliteList.every((e) => e.startsWith("A2_"))).toBe(true);
    expect([...s.run.pools.bossList].sort()).toEqual(["A2_BOSS_1", "A2_BOSS_2", "A2_BOSS_3"]);
    expect(s.run.hp).toBe(s.run.maxHp); // full heal below A5
    expect(s.run.history.combatsThisAct).toBe(0);
  });

  test("A5 heals only 75% of missing HP at the transition", () => {
    let s = run("ACT5", 5);
    s = walkUntil(s, bundle, (st) => st.run.room!.kind === "rewards" && st.run.room!.source === "boss");
    s.run.hp = 500; // force a known missing-HP amount
    const expected = 500 + Math.round((s.run.maxHp - 500) * 0.75);
    s = advance(s, { cmd: "skipRewards" }, bundle);
    expect(s.run.act).toBe(2);
    expect(s.run.hp).toBe(expected);
  });

  test("act 3 boss victory ends the run as a victory (Act 4 TODO)", () => {
    let s = run("WINNER");
    s = walkUntil(s, bundle, (st) => st.outcome?.kind === "victory");
    expect(s.run.act).toBe(3);
    expect(s.run.room!.kind).toBe("gameOver");
    if (s.run.room!.kind === "gameOver") expect(s.run.room!.victory).toBe(true);
    expect(() => advance(s, { cmd: "proceed" }, bundle)).toThrow("game is over");
  });

  test("boss door: mapPick to y=15 requires standing on the top rest row", () => {
    let s = run("BOSSD");
    s = advance(s, { cmd: "neowPick", i: 1 }, bundle);
    expect(() => advance(s, { cmd: "mapPick", x: 3, y: MAP_HEIGHT }, bundle)).toThrow("not reachable");
    s = walkUntil(s, bundle, (st) => st.run.room!.kind === "map" && st.run.position?.[1] === MAP_HEIGHT - 1);
    s = advance(s, { cmd: "mapPick", x: 3, y: MAP_HEIGHT }, bundle);
    const room = s.run.room!;
    if (room.kind !== "combat") throw new Error("expected boss combat");
    expect(room.roomKind).toBe("boss");
    expect(room.encounterId).toBe(s.run.map!.bossId);
  });

  test("Wing Boots allows non-connected next-row map picks and spends one charge", () => {
    let s = wingBootsMapRun(3);
    s = advance(s, { cmd: "mapPick", x: 2, y: 1 }, bundle);
    expect(s.run.position).toEqual([2, 1]);
    expect(s.run.room?.kind).toBe("rest");
    expect(s.run.relics.find((r) => r.defId === "WING_BOOTS")?.counter).toBe(2);
  });

  test("Wing Boots does not spend a charge on connected map picks", () => {
    let s = wingBootsMapRun(3);
    s = advance(s, { cmd: "mapPick", x: 0, y: 1 }, bundle);
    expect(s.run.position).toEqual([0, 1]);
    expect(s.run.room?.kind).toBe("shop");
    expect(s.run.relics.find((r) => r.defId === "WING_BOOTS")?.counter).toBe(3);
  });

  test("Wing Boots preserves burning elite handling for non-connected picks", () => {
    let s = wingBootsMapRun(3);
    const target = s.run.map!.rows[1]![2]!;
    target.kind = "elite";
    target.burningElite = true;
    s.run.pools.eliteList = ["A1_ELITE_1"];
    s = advance(s, { cmd: "mapPick", x: 2, y: 1 }, bundle);
    expect(s.run.room?.kind).toBe("combat");
    if (s.run.room?.kind !== "combat") throw new Error("expected elite combat");
    expect(s.run.room.roomKind).toBe("elite");
    expect(s.run.room.burningElite).toBe(true);
    expect(s.run.relics.find((r) => r.defId === "WING_BOOTS")?.counter).toBe(2);
  });

  test("non-connected map picks still reject without active Wing Boots charges", () => {
    expect(() => advance(wingBootsMapRun(null), { cmd: "mapPick", x: 2, y: 1 }, bundle)).toThrow("no path");
    expect(() => advance(wingBootsMapRun(0), { cmd: "mapPick", x: 2, y: 1 }, bundle)).toThrow("no path");
  });
});
