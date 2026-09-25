// Run-layer relic behaviour pinned against the decompiled game: relic pool
// draws (AbstractDungeon.returnRandomRelicKey / returnEndRandomRelicKey with
// canSpawn), room-entry relic hooks, chests, elite rewards and gold rewards.

import { test, expect, describe } from "bun:test";
import { advance, createRun, type GameState } from "../../src/engine/game";
import type { MapNode, RewardEntry, RoomState } from "../../src/engine/run/runState";
import { makeRunTestBundle } from "./runTestBundle";
import { makeTestCtx } from "./runCtx";
import { allRelics } from "../../src/content/relics";
import { buildCombatRewards, obtainRelicFromPool, obtainRelicFromPoolEnd } from "../../src/engine/run/rewards";
import { generateShop } from "../../src/engine/run/shop";
import { applyRest } from "../../src/engine/run/rest";
import { handleCombatVictory } from "../../src/engine/run/runFlow";
import { buildCombatState } from "../../src/engine/combat/setup";
import { MAP_HEIGHT, MAP_WIDTH } from "../../src/engine/run/mapGen";
import { eventCombatRewards } from "../../src/content/events/lib";
import { tinyHousePickup } from "../../src/content/relics/pickup";

const bundle = makeRunTestBundle();
for (const r of allRelics) bundle.relics.set(r.id, r);

const fresh = (seed: string): GameState => createRun({ seed, bundle, character: "IRONCLAD" });
const ctxOf = (s: GameState) => makeTestCtx(s, bundle);
const own = (s: GameState, ...ids: string[]) => {
  for (const id of ids) s.run.relics.push({ defId: id, counter: 0 });
};
const relicEntries = (entries: RewardEntry[]) => entries.flatMap((e) => (e.kind === "relic" ? [e.id] : []));

describe("relic pools: canSpawn and the end-of-pool redraw", () => {
  test("Ectoplasm only spawns in act 1; a refusal is discarded and the boss draw retakes the front", () => {
    const s = fresh("POOLS1");
    const { ctx } = ctxOf(s);
    s.run.act = 2;
    s.run.pools.bossRelics = ["ECTOPLASM", "SOZU", "RUNIC_DOME", "BUSTED_CROWN"];
    expect(obtainRelicFromPool(ctx, "boss")).toBe("SOZU");
    expect(s.run.pools.bossRelics).toEqual(["RUNIC_DOME", "BUSTED_CROWN"]);
    s.run.act = 1;
    s.run.pools.bossRelics = ["ECTOPLASM", "SOZU"];
    expect(obtainRelicFromPool(ctx, "boss")).toBe("ECTOPLASM");
  });

  test("Black Blood needs Burning Blood (the Neow swap loses it first)", () => {
    const s = fresh("POOLS2");
    const { ctx } = ctxOf(s);
    s.run.relics = [];
    s.run.pools.bossRelics = ["BLACK_BLOOD", "SOZU"];
    expect(obtainRelicFromPool(ctx, "boss")).toBe("SOZU");
    s.run.relics = [{ defId: "BURNING_BLOOD", counter: 0 }];
    s.run.pools.bossRelics = ["BLACK_BLOOD", "SOZU"];
    expect(obtainRelicFromPool(ctx, "boss")).toBe("BLACK_BLOOD");
  });

  test("a common refused by its floor limit redraws from the END of the pool", () => {
    const s = fresh("POOLS3");
    const { ctx } = ctxOf(s);
    s.run.floor = 36; // Tiny Chest: floorNum <= 35
    s.run.pools.commonRelics = ["TINY_CHEST", "ANCHOR", "VAJRA", "LANTERN"];
    expect(obtainRelicFromPool(ctx, "common")).toBe("LANTERN");
    expect(s.run.pools.commonRelics).toEqual(["ANCHOR", "VAJRA"]);
  });

  test("bottles need a card to bottle; campfire relics cap at two", () => {
    const s = fresh("POOLS4");
    const { ctx } = ctxOf(s);
    s.run.deck = [{ defId: "T_STRIKE", upgrades: 0, misc: 0, bottled: false }]; // basic only
    s.run.pools.uncommonRelics = ["BOTTLED_FLAME", "KUNAI"];
    expect(obtainRelicFromPool(ctx, "uncommon")).toBe("KUNAI");
    s.run.deck.push({ defId: "T_COMMON_ATK_A", upgrades: 0, misc: 0, bottled: false });
    s.run.pools.uncommonRelics = ["BOTTLED_FLAME", "KUNAI"];
    expect(obtainRelicFromPool(ctx, "uncommon")).toBe("BOTTLED_FLAME");

    own(s, "PEACE_PIPE", "SHOVEL");
    s.run.pools.rareRelics = ["GIRYA", "ICE_CREAM"];
    expect(obtainRelicFromPool(ctx, "rare")).toBe("ICE_CREAM");
  });

  test("the merchant draws from the END, and never rolls Maw Bank / Old Coin / Smiling Mask / Courier", () => {
    const s = fresh("POOLS5");
    const { ctx } = ctxOf(s);
    s.run.pools.commonRelics = ["ANCHOR", "VAJRA", "MAW_BANK"];
    expect(obtainRelicFromPoolEnd(ctx, "common", true)).toBe("VAJRA");
    expect(s.run.pools.commonRelics).toEqual(["ANCHOR"]);
    // outside a shop the front is taken and Maw Bank is fine
    s.run.pools.commonRelics = ["MAW_BANK", "ANCHOR"];
    expect(obtainRelicFromPool(ctx, "common")).toBe("MAW_BANK");
  });

  test("generateShop: each relic slot comes off the end of its pool", () => {
    const s = fresh("POOLS6");
    const { ctx } = ctxOf(s);
    const ends = {
      common: s.run.pools.commonRelics.at(-1),
      uncommon: s.run.pools.uncommonRelics.at(-1),
      rare: s.run.pools.rareRelics.at(-1),
      shop: s.run.pools.shopRelics.at(-1),
    };
    const shop = generateShop(ctx);
    expect(shop.relics[2]!.id).toBe(ends.shop!);
    for (const slot of shop.relics.slice(0, 2)) {
      expect(Object.values(ends)).toContain(slot.id);
    }
  });
});

describe("elite rewards", () => {
  test("Black Star adds a second, non-campfire relic", () => {
    const s = fresh("BSTAR");
    const { ctx } = ctxOf(s);
    own(s, "BLACK_STAR");
    s.run.pools.commonRelics = ["PEACE_PIPE", "SHOVEL", "ANCHOR"];
    s.run.pools.uncommonRelics = ["PEACE_PIPE", "SHOVEL", "KUNAI"];
    s.run.pools.rareRelics = ["PEACE_PIPE", "SHOVEL", "ICE_CREAM"];
    const relics = relicEntries(buildCombatRewards(ctx, "elite", false));
    expect(relics.length).toBe(2);
    expect(relics[0]).toBe("PEACE_PIPE");
    expect(["ANCHOR", "KUNAI", "ICE_CREAM"]).toContain(relics[1]!);
    // without Black Star: one relic
    const t = fresh("BSTAR");
    expect(relicEntries(buildCombatRewards(ctxOf(t).ctx, "elite", false)).length).toBe(1);
  });
});

describe("gold rewards", () => {
  test("Golden Idol adds round(25%) to event gold and Tiny House gold", () => {
    const s = fresh("IDOL");
    const { ctx } = ctxOf(s);
    own(s, "GOLDEN_IDOL");
    const gold = eventCombatRewards(ctx, { gold: 100 }).find((e) => e.kind === "gold");
    expect(gold).toMatchObject({ kind: "gold", amount: 125 });
    s.run.room = { kind: "rewards", entries: [], source: "relic" };
    tinyHousePickup(ctx);
    const room = s.run.room as RoomState;
    if (room.kind !== "rewards") throw new Error("expected rewards");
    expect(room.entries.find((e) => e.kind === "gold")).toMatchObject({ amount: 63 }); // 50 + round(12.5)
  });
});

describe("chests", () => {
  function treasure(s: GameState, sapphire: boolean): void {
    s.run.room = {
      kind: "treasure",
      chest: { size: "small", goldPresent: false, relicTier: "common", sapphireKeyAvailable: sapphire, opened: false },
    };
  }

  test("Matryoshka draws its extra BEFORE the chest's own relic", () => {
    let checked = 0;
    for (let i = 0; i < 12; i++) {
      const s = fresh(`MATRY${i}`);
      s.run.relics.push({ defId: "MATRYOSHKA", counter: 2 });
      s.run.pools.commonRelics = ["ANCHOR", "VAJRA", "LANTERN"];
      s.run.pools.uncommonRelics = ["KUNAI", "SHURIKEN"];
      treasure(s, true);
      const t = advance(s, { cmd: "openChest" }, bundle);
      const room = t.run.room as RoomState;
      if (room.kind !== "treasure") throw new Error("expected treasure");
      if (t.run.relics.some((r) => r.defId === "ANCHOR")) {
        // Matryoshka rolled common: it took the front, the chest the next one
        expect(room.chest.pendingRelicId).toBe("VAJRA");
        checked++;
      } else {
        expect(room.chest.pendingRelicId).toBe("ANCHOR");
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("N'loth's Hungry Face empties the next chest (relic and its Sapphire Key), once", () => {
    const s = fresh("NLOTH");
    s.run.relics.push({ defId: "NLOTHS_HUNGRY_FACE", counter: 1 });
    s.run.pools.commonRelics = ["ANCHOR", "VAJRA"];
    treasure(s, true);
    let t = advance(s, { cmd: "openChest" }, bundle);
    let room = t.run.room as RoomState;
    if (room.kind !== "treasure") throw new Error("expected treasure");
    expect(room.chest.pendingRelicId ?? null).toBeNull();
    expect(room.chest.sapphireKeyAvailable).toBe(false);
    expect(t.run.relics.find((r) => r.defId === "NLOTHS_HUNGRY_FACE")!.counter).toBe(0);
    // spent: the next chest is normal
    treasure(t, false);
    t = advance(t, { cmd: "openChest" }, bundle);
    room = t.run.room as RoomState;
    expect(t.run.relics.some((r) => r.defId === "VAJRA")).toBe(true);
  });

  test("with Matryoshka, N'loth's Hungry Face eats the extra and the chest keeps its relic", () => {
    const s = fresh("NLOTH2");
    s.run.relics.push({ defId: "MATRYOSHKA", counter: 2 }, { defId: "NLOTHS_HUNGRY_FACE", counter: 1 });
    s.run.pools.commonRelics = ["ANCHOR", "VAJRA", "LANTERN"];
    s.run.pools.uncommonRelics = ["KUNAI", "SHURIKEN"];
    treasure(s, false);
    const before = s.run.relics.length;
    const t = advance(s, { cmd: "openChest" }, bundle);
    expect(t.run.relics.length).toBe(before + 1); // only the chest's relic
  });
});

describe("room entry", () => {
  function unknownNodeRun(seed: string): GameState {
    const s = fresh(seed);
    const rows: (MapNode | null)[][] = Array.from({ length: MAP_HEIGHT }, () => new Array<MapNode | null>(MAP_WIDTH).fill(null));
    rows[0]![0] = { x: 0, y: 0, kind: "unknown", edges: [0], burningElite: false, emeraldKey: false };
    rows[1]![0] = { x: 0, y: 1, kind: "rest", edges: [0], burningElite: false, emeraldKey: false };
    s.run.map = { act: 1, rows, bossId: s.run.map!.bossId, burningEliteBuff: -1 };
    s.run.room = { kind: "map" };
    s.run.position = null;
    return s;
  }

  test("Ssserpent Head pays on a ? node even when it rolls a fight", () => {
    const s = unknownNodeRun("SERPENT");
    own(s, "SSSERPENT_HEAD");
    s.run.blizzard.monsterChance = 1.0;
    const gold0 = s.run.gold;
    const t = advance(s, { cmd: "mapPick", x: 0, y: 0 }, bundle);
    expect(t.run.room!.kind).toBe("combat");
    expect(t.run.gold).toBe(gold0 + 50);
  });

  test("Meal Ticket heals when a ? node rolls a shop", () => {
    const s = unknownNodeRun("TICKET");
    own(s, "MEAL_TICKET");
    s.run.blizzard.monsterChance = 0;
    s.run.blizzard.shopChance = 1.0;
    s.run.hp = 100;
    const t = advance(s, { cmd: "mapPick", x: 0, y: 0 }, bundle);
    expect(t.run.room!.kind).toBe("shop");
    expect(t.run.hp).toBe(115);
  });

  test("Tiny Chest ticks its relic counter on a ? node that becomes an event", () => {
    const s = unknownNodeRun("TINYEVENT");
    own(s, "TINY_CHEST");
    s.run.blizzard.monsterChance = 0;
    s.run.blizzard.shopChance = 0;
    s.run.blizzard.treasureChance = 0;
    const t = advance(s, { cmd: "mapPick", x: 0, y: 0 }, bundle);
    expect(t.run.room!.kind).toBe("event");
    expect(t.run.relics.find((r) => r.defId === "TINY_CHEST")!.counter).toBe(1);
  });

  test("Maw Bank pays 12 on entering the boss chest room", () => {
    const s = fresh("MAWBOSS");
    own(s, "MAW_BANK");
    const character = bundle.characters.get(s.run.character)!;
    const combat = buildCombatState(s.run, bundle, "T_DUMMY", ["T_DUMMY"], character.startingEnergy, character.orbSlots, "boss");
    combat.monsters[0]!.isDead = true;
    s.combat = combat;
    s.run.room = { kind: "combat", roomKind: "boss", encounterId: "T_DUMMY", burningElite: false };
    const { ctx, registry } = ctxOf(s);
    const gold0 = s.run.gold;
    handleCombatVictory(s, ctx, registry);
    expect((s.run.room as RoomState).kind).toBe("rewards");
    expect(s.run.gold).toBe(gold0 + 12);
  });
});

describe("merchant discounts (ShopScreen.applyDiscount)", () => {
  const prices = (shop: ReturnType<typeof generateShop>) => [
    ...shop.cards.map((c) => c.price),
    ...shop.relics.map((r) => r.price),
    ...shop.potions.map((p) => p.price),
  ];

  test("The Courier then Membership Card, each pass rounded, whatever the obtain order", () => {
    const plain = prices(generateShop(ctxOf(fresh("DISC")).ctx));
    for (const order of [["THE_COURIER", "MEMBERSHIP_CARD"], ["MEMBERSHIP_CARD", "THE_COURIER"]]) {
      const s = fresh("DISC");
      own(s, ...order);
      const both = prices(generateShop(ctxOf(s).ctx));
      expect(both).toEqual(plain.map((p) => Math.round(Math.round(p * 0.8) * 0.5)));
    }
  });

  test("removal cost: Membership Card's half replaces The Courier's 20% off (not compounded)", () => {
    const s = fresh("PURGE");
    own(s, "THE_COURIER");
    expect(generateShop(ctxOf(s).ctx).removalCost).toBe(60);
    own(s, "MEMBERSHIP_CARD");
    expect(generateShop(ctxOf(s).ctx).removalCost).toBe(38); // round(75 * 0.5)
  });
});

describe("pickup relics", () => {
  test("War Paint / Whetstone: one miscRng.randomLong for a java shuffle, drawn even with nothing to upgrade", () => {
    const s = fresh("PAINT");
    s.run.deck = [
      { defId: "T_COMMON_SKL_A", upgrades: 0, misc: 0, bottled: false },
      { defId: "T_COMMON_SKL_B", upgrades: 1, misc: 0, bottled: false }, // already upgraded: skipped
      { defId: "T_UNCOMMON_SKL_A", upgrades: 0, misc: 0, bottled: false },
      { defId: "T_RARE_SKL_A", upgrades: 0, misc: 0, bottled: false },
    ];
    const { ctx, registry } = ctxOf(s);
    const misc0 = registry.get("miscRng").counter;
    bundle.relics.get("WAR_PAINT")!.onEquip!(ctx);
    expect(registry.get("miscRng").counter).toBe(misc0 + 1);
    expect(s.run.deck.filter((c) => c.upgrades === 1).length).toBe(3); // 2 new + the old one
    // no Attack to sharpen: the long is still drawn
    const misc1 = registry.get("miscRng").counter;
    bundle.relics.get("WHETSTONE")!.onEquip!(ctx);
    expect(registry.get("miscRng").counter).toBe(misc1 + 1);
  });

  test("Dolly's Mirror copies a chosen deck card with its upgrades", () => {
    const s = fresh("DOLLY");
    s.run.deck = [
      { defId: "T_COMMON_ATK_A", upgrades: 1, misc: 0, bottled: true },
      { defId: "T_COMMON_SKL_A", upgrades: 0, misc: 0, bottled: false },
    ];
    s.run.room = { kind: "map" };
    let pending: unknown = null;
    const { ctx } = ctxOf(s);
    ctx.requestChoice = (c) => (pending = c);
    bundle.relics.get("DOLLYS_MIRROR")!.onEquip!(ctx);
    const p = pending as { request: { iids: number[]; min: number }; resume: string; resumeArgs: object };
    expect(p.request.iids).toEqual([0, 1]);
    expect(p.request.min).toBe(1);
    bundle.effects.get(p.resume)!(ctx, { ...p.resumeArgs, chosen: [0] });
    expect(s.run.deck.length).toBe(3);
    expect(s.run.deck[2]).toMatchObject({ defId: "T_COMMON_ATK_A", upgrades: 1, bottled: false });
  });
  test("Dolly's Mirror bought at a shop opens the duplicate pick there, and the copy lands", () => {
    const s = fresh("DOLLYSHOP");
    const { ctx } = ctxOf(s);
    const shop = generateShop(ctx);
    shop.relics[0] = { id: "DOLLYS_MIRROR", tier: "shop", price: 0, sold: false };
    s.run.room = { kind: "shop", shop };
    s.run.deck = [
      { defId: "T_COMMON_ATK_A", upgrades: 1, misc: 0, bottled: false },
      { defId: "T_COMMON_SKL_A", upgrades: 0, misc: 0, bottled: false },
    ];
    let t = advance(s, { cmd: "shopBuy", kind: "relic", idx: 0 }, bundle);
    expect(t.run.relics.some((r) => r.defId === "DOLLYS_MIRROR")).toBe(true);
    const req = t.pending!.request;
    if (req.kind !== "cards") throw new Error("expected a card pick");
    expect(req.iids).toEqual([0, 1]);
    expect(req.reason).toBe("relic:duplicate");
    t = advance(t, { cmd: "choose", indices: [0] }, bundle);
    expect(t.pending).toBeNull();
    expect(t.run.deck.length).toBe(3);
    expect(t.run.deck[2]).toMatchObject({ defId: "T_COMMON_ATK_A", upgrades: 1 });
    expect((t.run.room as RoomState).kind).toBe("shop");
  });
});

describe("rest", () => {
  test("Peace Pipe's Toke leaves bottled cards and unremovable curses out; picks map back to the deck", () => {
    const s = fresh("TOKE");
    own(s, "PEACE_PIPE");
    s.run.deck = [
      { defId: "T_COMMON_ATK_A", upgrades: 0, misc: 0, bottled: true },
      { defId: "NECRONOMICURSE", upgrades: 0, misc: 0, bottled: false },
      { defId: "T_COMMON_SKL_A", upgrades: 0, misc: 0, bottled: false },
    ];
    s.run.room = { kind: "rest", used: false };
    let t = advance(s, { cmd: "restOption", kind: "toke" }, bundle);
    const req = t.pending!.request;
    if (req.kind !== "cards") throw new Error("unreachable");
    expect(req.iids).toEqual([2]);
    t = advance(t, { cmd: "choose", indices: [0] }, bundle);
    expect(t.run.deck.map((c) => c.defId)).toEqual(["T_COMMON_ATK_A", "NECRONOMICURSE"]);
    // nothing left to toke: the option is gone
    t.run.room = { kind: "rest", used: false };
    t.run.deck = t.run.deck.slice(0, 2);
    expect(() => advance(t, { cmd: "restOption", kind: "toke" }, bundle)).toThrow("not available");
  });

  test("resting heals through the heal path: Mark of the Bloom stops it", () => {
    const s = fresh("BLOOM");
    own(s, "MARK_OF_THE_BLOOM", "REGAL_PILLOW");
    s.run.hp = 100;
    applyRest(ctxOf(s).ctx);
    expect(s.run.hp).toBe(100);
    const t = fresh("BLOOM");
    own(t, "REGAL_PILLOW");
    t.run.hp = 100;
    applyRest(ctxOf(t).ctx);
    expect(t.run.hp).toBe(100 + Math.floor(t.run.maxHp * 0.3) + 15);
  });
});
