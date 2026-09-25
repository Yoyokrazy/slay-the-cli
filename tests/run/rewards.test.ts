import { test, expect, describe } from "bun:test";
import { advance, createRun, type GameState } from "../../src/engine/game";
import type { RewardEntry, RoomState } from "../../src/engine/run/runState";
import { makeRunTestBundle } from "./runTestBundle";
import { makeTestCtx } from "./runCtx";
import {
  buildCombatRewards,
  classCardPool,
  createCardReward,
  rollGoldReward,
  rollPotionReward,
  returnRandomPotion,
  obtainRelicFromPool,
  obtainRelicFromPoolEnd,
  peekRelicFromPool,
} from "../../src/engine/run/rewards";
import { Rng } from "../../src/engine/core/rng";
import { setupTreasureRoom, openChestContents, CHESTS } from "../../src/engine/run/treasure";
import { generateShop, computeRemovalCost, SHOP } from "../../src/engine/run/shop";
import { handleCombatVictory } from "../../src/engine/run/runFlow";
import { buildCombatState } from "../../src/engine/combat/setup";
import { looter } from "../../src/content/monsters/act1/looter";
import { mugger } from "../../src/content/monsters/act2/mugger";
import { allRelics } from "../../src/content/relics";
import { f32mul } from "../../src/engine/core/math";

const bundle = makeRunTestBundle();
bundle.monsters.set(looter.id, looter);
bundle.monsters.set(mugger.id, mugger);
const courierMembershipBundle = makeRunTestBundle();
for (const r of allRelics.filter((r) => r.id === "THE_COURIER" || r.id === "MEMBERSHIP_CARD")) {
  courierMembershipBundle.relics.set(r.id, r);
}
const notInShopBundle = makeRunTestBundle();
for (const r of allRelics.filter((r) => ["THE_COURIER", "MAW_BANK", "OLD_COIN", "SMILING_MASK"].includes(r.id))) {
  notInShopBundle.relics.set(r.id, r);
}

function ctxFor(seed: string, ascension = 0, content = bundle) {
  const s = createRun({ seed, bundle: content, character: "IRONCLAD", ascension });
  const { ctx } = makeTestCtx(s, content);
  return { s, ctx };
}

function finishThiefCombat(
  seed: string,
  thieves: { id: "LOOTER" | "MUGGER"; stolenGold: number; escaped: boolean }[],
  mutate?: (run: GameState["run"]) => void,
): { entries: RewardEntry[]; before: GameState["rng"]; after: GameState["rng"]; run: GameState["run"] } {
  const s = createRun({ seed, bundle, character: "IRONCLAD" });
  mutate?.(s.run);
  const character = bundle.characters.get(s.run.character)!;
  const combat = buildCombatState(
    s.run,
    bundle,
    thieves.length === 1 ? thieves[0]!.id : "TWO_THIEVES",
    thieves.map((t) => t.id),
    character.startingEnergy,
    character.orbSlots,
    "monster",
  );
  thieves.forEach((thief, i) => {
    const monster = combat.monsters[i]!;
    monster.isDead = !thief.escaped;
    monster.isEscaped = thief.escaped;
    monster.data.stolenGold = thief.stolenGold;
  });
  s.combat = combat;
  s.run.room = { kind: "combat", roomKind: "monster", encounterId: combat.combatFlags.encounterId, burningElite: false };
  const { ctx, registry } = makeTestCtx(s, bundle);
  const before = registry.saveState();
  handleCombatVictory(s, ctx, registry);
  const room = (s.run as { room: RoomState | null }).room;
  if (room?.kind !== "rewards") throw new Error("expected rewards room");
  return { entries: room.entries, before, after: registry.saveState(), run: s.run };
}

function finishThiefCombatRewards(
  seed: string,
  thieves: { id: "LOOTER" | "MUGGER"; stolenGold: number; escaped: boolean }[],
  mutate?: (run: GameState["run"]) => void,
): RewardEntry[] {
  return finishThiefCombat(seed, thieves, mutate).entries;
}

function goldRewardAmounts(entries: RewardEntry[]): number[] {
  return entries.flatMap((e) => e.kind === "gold" ? [e.amount] : []);
}

type TestCtx = ReturnType<typeof ctxFor>["ctx"];

/** Independent replay of AbstractDungeon.getRewardCards (AbstractDungeon.java:
 *  1981-2064) on a copy of cardRng: every card's rarity roll (always drawn,
 *  boss included) and pick, THEN one randomBoolean(cardUpgradedChance) per
 *  non-rare card. Returns what the engine must produce. */
function replayJavaCardReward(ctx: TestCtx, room: "monster" | "elite" | "boss") {
  const rng = Rng.fromState(ctx.rng("cardRng").saveState());
  let factor = ctx.run.blizzard.cardRarityFactor;
  const [rare, uncommon] = room === "elite" ? [10, 40] : [3, 37];
  const picks: { id: string; rarity: "common" | "uncommon" | "rare" }[] = [];
  for (let i = 0; i < 3; i++) {
    const roll = rng.random(99) + factor;
    const rarity = room === "boss" || roll < rare ? "rare" : roll < rare + uncommon ? "uncommon" : "common";
    if (rarity === "rare") factor = 5;
    else if (rarity === "common") factor = Math.max(factor - 1, -40);
    const pool = classCardPool(ctx, rarity);
    let id: string;
    do id = pool[rng.random(pool.length - 1)]!;
    while (picks.some((p) => p.id === id));
    picks.push({ id, rarity });
  }
  const act = ctx.run.act;
  const asc = ctx.run.ascension;
  const chance = act <= 1 ? 0 : act === 2 ? (asc >= 12 ? 0.125 : 0.25) : asc >= 12 ? 0.25 : 0.5;
  const cards = picks.map((p) => ({ ...p, upgraded: p.rarity !== "rare" && rng.randomBoolean(chance) }));
  return { cards, counter: rng.counter, factor };
}

describe("card reward pity (cardRarityFactor)", () => {
  test("scripted 10-reward trajectory: -1 per common, reset to 5 on rare (self-golden)", () => {
    const { s, ctx } = ctxFor("PITY");
    expect(s.run.blizzard.cardRarityFactor).toBe(5);
    const factors: number[] = [];
    const rarities: string[][] = [];
    for (let i = 0; i < 10; i++) {
      const cards = createCardReward(ctx, "monster");
      rarities.push(cards.map((c) => c.rarity));
      factors.push(s.run.blizzard.cardRarityFactor);
    }
    expect(factors).toEqual([3, 1, -2, -3, 5, 3, 1, 0, -2, 3]);
    expect(rarities[4]).toContain("rare"); // the reset point
    // replay the update rule from the observed rarities
    let f = 5;
    const replayed: number[] = [];
    for (const reward of rarities) {
      for (const r of reward) {
        if (r === "rare") f = 5;
        else if (r === "common") f = Math.max(f - 1, -40);
      }
      replayed.push(f);
    }
    expect(replayed).toEqual(factors);
  });

  test("factor never drops below the -40 floor", () => {
    const { s, ctx } = ctxFor("FLOOR");
    let sawCommonAtFloor = false;
    for (let i = 0; i < 50; i++) {
      s.run.blizzard.cardRarityFactor = -40;
      const cards = createCardReward(ctx, "monster");
      expect(s.run.blizzard.cardRarityFactor).toBeGreaterThanOrEqual(-40);
      if (cards.some((c) => c.rarity === "common")) sawCommonAtFloor = true;
    }
    expect(sawCommonAtFloor).toBe(true); // max(f-1, -40) actually exercised
  });

  test("forced rare (factor -97 guarantees the first roll) resets factor to 5 immediately", () => {
    const { s, ctx } = ctxFor("RARE");
    s.run.blizzard.cardRarityFactor = -97;
    const cards = createCardReward(ctx, "monster");
    // the FIRST card must be rare; the reset applies before the next roll,
    // so later cards in the same reward roll at factor 5 again
    expect(cards[0]!.rarity).toBe("rare");
    let f = -97;
    for (const c of cards) {
      if (c.rarity === "rare") f = 5;
      else if (c.rarity === "common") f = Math.max(f - 1, -40);
    }
    expect(s.run.blizzard.cardRarityFactor).toBe(f);
  });

  test("forced common (factor 63 pushes every roll past 43) decrements by 3", () => {
    const { s, ctx } = ctxFor("COMMON");
    s.run.blizzard.cardRarityFactor = 63;
    const cards = createCardReward(ctx, "monster");
    expect(cards.every((c) => c.rarity === "common")).toBe(true);
    expect(s.run.blizzard.cardRarityFactor).toBe(60);
  });

  test("boss rewards are always rare, the rarity roll is still consumed, and the factor resets", () => {
    // rollRarity: "int roll = cardRng.random(99);" then MonsterRoomBoss.getCardRarity -> RARE
    const { s, ctx } = ctxFor("BOSSR");
    s.run.blizzard.cardRarityFactor = -12;
    const expected = replayJavaCardReward(ctx, "boss");
    const cards = createCardReward(ctx, "boss");
    expect(cards.every((c) => c.rarity === "rare")).toBe(true);
    expect(s.run.blizzard.cardRarityFactor).toBe(5);
    expect(cards).toEqual(expected.cards);
    expect(ctx.rng("cardRng").counter).toBe(expected.counter);
  });

  test("the reward matches getRewardCards call for call: picks first, then one upgrade roll per non-rare", () => {
    for (const [act, asc] of [
      [1, 0],
      [2, 0],
      [2, 12],
      [3, 0],
      [3, 12],
    ] as const) {
      for (let i = 0; i < 12; i++) {
        const { s, ctx } = ctxFor(`JAVACARDS${act}-${asc}-${i}`, asc);
        s.run.act = act;
        for (const room of ["monster", "elite", "boss"] as const) {
          const expected = replayJavaCardReward(ctx, room);
          expect(createCardReward(ctx, room)).toEqual(expected.cards);
          expect(ctx.rng("cardRng").counter).toBe(expected.counter);
          expect(s.run.blizzard.cardRarityFactor).toBe(expected.factor);
        }
      }
    }
  });

  test("act 1 still burns one upgrade roll per non-rare card (chance 0)", () => {
    const { ctx } = ctxFor("UPGBURN");
    const before = ctx.rng("cardRng").counter;
    const cards = createCardReward(ctx, "monster");
    const nonRare = cards.filter((c) => c.rarity !== "rare").length;
    expect(ctx.rng("cardRng").counter - before).toBeGreaterThanOrEqual(3 + 3 + nonRare);
    expect(cards.every((c) => !c.upgraded)).toBe(true);
  });

  test("3 cards, duplicate-free within one reward", () => {
    for (const seed of ["D1", "D2", "D3", "D4", "D5"]) {
      const { ctx } = ctxFor(seed);
      const cards = createCardReward(ctx, "monster");
      expect(cards.length).toBe(3);
      expect(new Set(cards.map((c) => c.id)).size).toBe(3);
    }
  });

  test("Question Card and Busted Crown compose when sizing card rewards", () => {
    const crown = ctxFor("CROWN");
    crown.s.run.relics.push({ defId: "BUSTED_CROWN", counter: 0 });
    expect(createCardReward(crown.ctx, "monster")).toHaveLength(1);

    const question = ctxFor("QUESTION");
    question.s.run.relics.push({ defId: "QUESTION_CARD", counter: 0 });
    expect(createCardReward(question.ctx, "monster")).toHaveLength(4);

    const both = ctxFor("CROWNQUESTION");
    both.s.run.relics.push({ defId: "QUESTION_CARD", counter: 0 }, { defId: "BUSTED_CROWN", counter: 0 });
    expect(createCardReward(both.ctx, "monster")).toHaveLength(2);
  });

  test("Busted Crown cannot reduce a card reward below one card", () => {
    const { s, ctx } = ctxFor("CROWNMIN");
    s.run.relics.push({ defId: "BUSTED_CROWN", counter: 0 }, { defId: "BUSTED_CROWN", counter: 0 });
    expect(createCardReward(ctx, "monster")).toHaveLength(1);
  });

  test("upgrades: act 1 never; act 3 asc 0 sometimes (never on rares)", () => {
    const { ctx } = ctxFor("UPG1");
    for (let i = 0; i < 20; i++) {
      expect(createCardReward(ctx, "monster").every((c) => !c.upgraded)).toBe(true);
    }
    const { s: s3, ctx: ctx3 } = ctxFor("UPG3");
    s3.run.act = 3; // upgrade chance 0.5
    let upgraded = 0;
    for (let i = 0; i < 30; i++) {
      for (const c of createCardReward(ctx3, "monster")) {
        if (c.upgraded) {
          upgraded++;
          expect(c.rarity).not.toBe("rare");
        }
      }
    }
    expect(upgraded).toBeGreaterThan(10); // ~45 expected of 90 non-rares
  });
});

describe("potion drop pity", () => {
  test("+10 on miss, -10 on drop; base chance 40", () => {
    const { s, ctx } = ctxFor("POTS");
    for (let i = 0; i < 30; i++) {
      const before = s.run.blizzard.potionChance;
      const potion = rollPotionReward(ctx, 1);
      expect(s.run.blizzard.potionChance).toBe(potion ? before - 10 : before + 10);
    }
  });

  test("potionChance 60 guarantees a drop (chance 100); -40 guarantees none", () => {
    const { s, ctx } = ctxFor("POTG");
    s.run.blizzard.potionChance = 60;
    expect(rollPotionReward(ctx, 1)).not.toBeNull();
    s.run.blizzard.potionChance = -40;
    expect(rollPotionReward(ctx, 1)).toBeNull();
    expect(s.run.blizzard.potionChance).toBe(-30);
  });

  test(">= 4 rewards already present forces chance 0 (roll still consumed)", () => {
    const { s, ctx } = ctxFor("POTM");
    s.run.blizzard.potionChance = 60; // would otherwise guarantee a drop
    const counterBefore = ctx.rng("potionRng").counter;
    expect(rollPotionReward(ctx, 4)).toBeNull();
    expect(ctx.rng("potionRng").counter).toBe(counterBefore + 1);
  });

  test("rarity split <65 common, <90 uncommon, else rare - all rarities occur", () => {
    const { ctx } = ctxFor("PRAR");
    const seen = new Set<string>();
    for (let i = 0; i < 80; i++) {
      const id = returnRandomPotion(ctx);
      if (id) seen.add(bundle.potions.get(id)!.rarity);
    }
    expect([...seen].sort()).toEqual(["common", "rare", "uncommon"]);
  });

  test("Sozu does not stop the potion reward roll: it rolls, moves pity, and lands on the screen", () => {
    // AbstractRoom.addPotionToRewards has no Sozu check (AbstractRoom.java:780-815)
    const plain = ctxFor("SOZU-POTION-REWARD");
    const sozu = ctxFor("SOZU-POTION-REWARD");
    sozu.s.run.relics.push({ defId: "SOZU", counter: 0 });
    for (const c of [plain, sozu]) c.s.run.blizzard.potionChance = 60;
    const expected = rollPotionReward(plain.ctx, 1);
    expect(expected).not.toBeNull();
    expect(rollPotionReward(sozu.ctx, 1)).toBe(expected);
    expect(sozu.s.run.blizzard.potionChance).toBe(50);
    expect(sozu.ctx.rng("potionRng").counter).toBe(plain.ctx.rng("potionRng").counter);
  });

  test("Sozu leaves random potion rolls and shop potion stock in place", () => {
    // ShopScreen.initPotions has no Sozu check; StorePotion.purchasePotion refuses the sale
    const { s, ctx } = ctxFor("SOZU-RANDOM-POTION");
    s.run.relics.push({ defId: "SOZU", counter: 0 });
    expect(returnRandomPotion(ctx)).not.toBeNull();
    expect(generateShop(ctx).potions).toHaveLength(3);
  });

  test("Sozu: a potion reward is used up with no potion; a shop potion cannot be bought", () => {
    // RewardItem.claimReward: "if(hasRelic("Sozu")) { flash(); return true; }"
    const reward = ctxFor("SOZU-TAKE-POTION");
    reward.s.run.relics.push({ defId: "SOZU", counter: 0 });
    reward.s.run.potions = ["T_POT_C_A", "T_POT_C_A", "T_POT_C_A"]; // even with a full belt
    reward.s.run.room = {
      kind: "rewards",
      source: "event",
      entries: [{ kind: "potion", id: "T_POT_U_A", taken: false }],
    };
    const took = advance(reward.s, { cmd: "takeReward", i: 0 }, bundle);
    if (took.run.room?.kind !== "rewards") throw new Error("expected rewards");
    expect(took.run.room.entries[0]!.taken).toBe(true);
    expect(took.run.potions).toEqual(["T_POT_C_A", "T_POT_C_A", "T_POT_C_A"]);

    const shop = ctxFor("SOZU-BUY-POTION");
    shop.s.run.relics.push({ defId: "SOZU", counter: 0 });
    shop.s.run.room = {
      kind: "shop",
      shop: {
        cards: [],
        relics: [],
        potions: [{ id: "T_POT_C_A", price: 0, sold: false }],
        removalCost: 0,
        removalUsed: false,
      },
    };
    expect(() => advance(shop.s, { cmd: "shopBuy", kind: "potion", idx: 0 }, bundle)).toThrow(
      "a relic prevents obtaining potions",
    );
  });
});

describe("gold rewards", () => {
  test("ranges: normal 10-20, elite 25-35, boss 95-105", () => {
    for (let i = 0; i < 40; i++) {
      const { ctx } = ctxFor(`G${i}`);
      const normal = rollGoldReward(ctx, "monster");
      expect(normal).toBeGreaterThanOrEqual(10);
      expect(normal).toBeLessThanOrEqual(20);
      const elite = rollGoldReward(ctx, "elite");
      expect(elite).toBeGreaterThanOrEqual(25);
      expect(elite).toBeLessThanOrEqual(35);
      const boss = rollGoldReward(ctx, "boss");
      expect(boss).toBeGreaterThanOrEqual(95);
      expect(boss).toBeLessThanOrEqual(105);
    }
  });

  test("A13 boss gold = round(gold * 0.75)", () => {
    for (let i = 0; i < 20; i++) {
      const { ctx } = ctxFor(`GA${i}`, 13);
      const boss = rollGoldReward(ctx, "boss");
      expect(boss).toBeGreaterThanOrEqual(Math.round(95 * 0.75));
      expect(boss).toBeLessThanOrEqual(Math.round(105 * 0.75));
    }
  });

  test("Golden Idol adds round(25%) on top (after A13 for bosses)", () => {
    const a = ctxFor("IDOL");
    const plain = rollGoldReward(a.ctx, "monster");
    const b = ctxFor("IDOL");
    b.s.run.relics.push({ defId: "GOLDEN_IDOL", counter: 0 });
    const idol = rollGoldReward(b.ctx, "monster");
    expect(idol).toBe(plain + Math.round(plain * 0.25));
  });

  test("killed Looter refunds stolen gold as an extra reward", () => {
    const entries = finishThiefCombatRewards("THIEF-KILLED", [{ id: "LOOTER", stolenGold: 30, escaped: false }]);
    const amounts = goldRewardAmounts(entries);
    expect(amounts).toContain(30);
    expect(amounts).toHaveLength(2);
  });

  test("a hallway fight whose every monster escaped pays no gold and has potion chance 0", () => {
    // AbstractRoom.java:457 "(this instanceof MonsterRoom) && !haveMonstersEscaped()"
    // gates the gold; AbstractRoom.java:783-795 leaves the potion chance at 0,
    // but "potionRng.random(0, 99) < chance" is still rolled (pity +10)
    const r = finishThiefCombat("THIEF-ESCAPED", [{ id: "LOOTER", stolenGold: 30, escaped: true }], (run) => {
      run.blizzard.potionChance = 60; // would guarantee a drop if the chance applied
    });
    expect(goldRewardAmounts(r.entries)).toEqual([]);
    expect(r.entries.some((e) => e.kind === "potion")).toBe(false);
    expect(r.entries.filter((e) => e.kind === "card").length).toBe(3); // mugged: the card reward stays
    expect(r.after.run.treasureRng.counter).toBe(r.before.run.treasureRng.counter);
    expect(r.after.run.potionRng.counter).toBe(r.before.run.potionRng.counter + 1);
    expect(r.run.blizzard.potionChance).toBe(70);
  });

  test("escaped fight: White Beast Statue still forces the potion", () => {
    const entries = finishThiefCombatRewards(
      "THIEF-ESCAPED-WBS",
      [{ id: "LOOTER", stolenGold: 30, escaped: true }],
      (run) => run.relics.push({ defId: "WHITE_BEAST_STATUE", counter: 0 }),
    );
    expect(entries.some((e) => e.kind === "potion")).toBe(true);
  });

  test("stolen gold is listed before the battle's own gold (Looter.die adds it mid-fight)", () => {
    const entries = finishThiefCombatRewards("THIEF-ORDER", [{ id: "LOOTER", stolenGold: 30, escaped: false }]);
    expect(entries[0]).toEqual({ kind: "gold", amount: 30, taken: false });
    expect(entries[1]!.kind).toBe("gold");
  });

  test("multiple killed thieves combine into one stolen gold reward", () => {
    const entries = finishThiefCombatRewards("TWO-THIEVES", [
      { id: "LOOTER", stolenGold: 15, escaped: false },
      { id: "MUGGER", stolenGold: 20, escaped: false },
    ]);
    const amounts = goldRewardAmounts(entries);
    expect(amounts).toContain(35);
    expect(amounts).toHaveLength(2);
  });
});

describe("elite rewards", () => {
  test("elite rewards: gold + relic from tier pools + card group; burning adds emerald key", () => {
    const { s, ctx } = ctxFor("ELITE");
    const entries = buildCombatRewards(ctx, "elite", true);
    expect(entries.some((e) => e.kind === "gold")).toBe(true);
    expect(entries.some((e) => e.kind === "relic")).toBe(true);
    expect(entries.some((e) => e.kind === "emeraldKey")).toBe(true);
    expect(entries.filter((e) => e.kind === "card").length).toBe(3);
    // relic came off the front of a run pool
    const relic = entries.find((e) => e.kind === "relic")!;
    expect((relic as { id: string }).id.startsWith("T_RELIC_")).toBe(true);
    expect(s.run.keys.emerald).toBe(false); // granted only when taken
  });

  test("emerald key not offered once owned", () => {
    const { s, ctx } = ctxFor("ELITE2");
    s.run.keys.emerald = true;
    const entries = buildCombatRewards(ctx, "elite", true);
    expect(entries.some((e) => e.kind === "emeraldKey")).toBe(false);
  });

  test("Black Star: a second elite relic off its own tier roll, never a campfire relic", () => {
    // MonsterRoomElite.dropReward: "addNoncampRelicToRewards(returnRandomRelicTier())"
    const { s, ctx } = ctxFor("BLACKSTAR");
    s.run.relics.push({ defId: "BLACK_STAR", counter: 0 });
    s.run.pools.commonRelics = ["PEACE_PIPE", "SHOVEL", "C1", "C2", "C3"];
    s.run.pools.uncommonRelics = ["GIRYA", "U1", "U2"];
    s.run.pools.rareRelics = ["R1", "R2"];
    const relicRng = ctx.rng("relicRng").counter;
    const entries = buildCombatRewards(ctx, "elite", false);
    const relics = entries.flatMap((e) => (e.kind === "relic" ? [e.id] : []));
    expect(relics).toHaveLength(2);
    expect(ctx.rng("relicRng").counter).toBe(relicRng + 2);
    // the main relic is a plain front pop; the second skips (and burns) campfire relics
    expect(["PEACE_PIPE", "SHOVEL", "GIRYA"]).not.toContain(relics[1]!);
  });

  test("the emerald key counts toward rewards.size() >= 4: Black Star + burning elite leaves no potion", () => {
    // gold, relic, Black Star relic, emerald key = 4 RewardItems before addPotionToRewards
    const { s, ctx } = ctxFor("BLACKSTARKEY");
    s.run.relics.push({ defId: "BLACK_STAR", counter: 0 });
    s.run.blizzard.potionChance = 60;
    const potionRng = ctx.rng("potionRng").counter;
    const entries = buildCombatRewards(ctx, "elite", true);
    expect(entries.some((e) => e.kind === "emeraldKey")).toBe(true);
    expect(entries.some((e) => e.kind === "potion")).toBe(false);
    expect(ctx.rng("potionRng").counter).toBe(potionRng + 1); // rolled at chance 0
    expect(s.run.blizzard.potionChance).toBe(70);
  });
});

describe("chests", () => {
  test("size distribution over 400 seeds roughly 50/33/17", () => {
    const counts = { small: 0, medium: 0, large: 0 };
    for (let i = 0; i < 400; i++) {
      const { ctx } = ctxFor(`CH${i}`);
      counts[setupTreasureRoom(ctx).size]++;
    }
    expect(counts.small).toBeGreaterThan(150);
    expect(counts.small).toBeLessThan(250);
    expect(counts.medium).toBeGreaterThan(90);
    expect(counts.medium).toBeLessThan(180);
    expect(counts.large).toBeGreaterThan(30);
    expect(counts.large).toBeLessThan(110);
  });

  test("single-roll quirk: gold presence correlates with relic tier", () => {
    for (let i = 0; i < 200; i++) {
      const { ctx } = ctxFor(`CQ${i}`);
      const chest = setupTreasureRoom(ctx);
      // small: gold needs roll<50, uncommon needs roll>=75 - mutually exclusive
      if (chest.size === "small" && chest.relicTier === "uncommon") expect(chest.goldPresent).toBe(false);
      // small chests never hold rare relics
      if (chest.size === "small") expect(chest.relicTier).not.toBe("rare");
      // large: common share is 0
      if (chest.size === "large") expect(chest.relicTier).not.toBe("common");
      // medium: rare needs roll>=85, gold needs roll<35 - mutually exclusive
      if (chest.size === "medium" && chest.relicTier === "rare") expect(chest.goldPresent).toBe(false);
      // large: gold needs roll<50 which is inside the uncommon band
      if (chest.size === "large" && chest.goldPresent) expect(chest.relicTier).toBe("uncommon");
    }
  });

  test("gold amount within 0.9x-1.1x of the size base, rounded", () => {
    for (let i = 0; i < 120; i++) {
      const { ctx } = ctxFor(`CG${i}`);
      const chest = setupTreasureRoom(ctx);
      if (!chest.goldPresent) continue;
      const contents = openChestContents(ctx, chest);
      const base = CHESTS.goldBaseAmount[chest.size];
      expect(contents.gold).toBeGreaterThanOrEqual(Math.round(base * 0.9));
      expect(contents.gold).toBeLessThanOrEqual(Math.round(base * 1.1));
    }
  });

  test("sapphire key choice reveals the relic and consumes it from the pool", () => {
    const { s, ctx } = ctxFor("KEY");
    const chest = setupTreasureRoom(ctx);
    const poolSizeBefore =
      s.run.pools.commonRelics.length + s.run.pools.uncommonRelics.length + s.run.pools.rareRelics.length;
    const contents = openChestContents(ctx, chest);
    expect(contents.pendingChoice).toBe(true);
    expect(contents.relicId).not.toBeNull();
    expect(chest.pendingRelicId).toBe(contents.relicId);
    const poolSizeAfter =
      s.run.pools.commonRelics.length + s.run.pools.uncommonRelics.length + s.run.pools.rareRelics.length;
    expect(poolSizeAfter).toBe(poolSizeBefore - 1);
  });
});

describe("relic pools", () => {
  test("consumed from the front, with exhaustion fallback to CIRCLET", () => {
    const { s, ctx } = ctxFor("POOL");
    const first = s.run.pools.commonRelics[0]!;
    expect(obtainRelicFromPool(ctx, "common")).toBe(first);
    s.run.pools.commonRelics = [];
    s.run.pools.uncommonRelics = ["U1"];
    expect(obtainRelicFromPool(ctx, "common")).toBe("U1"); // common -> uncommon
    s.run.pools.uncommonRelics = [];
    s.run.pools.rareRelics = [];
    expect(obtainRelicFromPool(ctx, "common")).toBe("CIRCLET");
    s.run.pools.bossRelics = [];
    expect(obtainRelicFromPool(ctx, "boss")).toBe("RED_CIRCLET");
  });

  // the chest screen names the relic before you trade it for the key
  test("peek returns what the take would hand over, and consumes nothing", () => {
    const { s, ctx } = ctxFor("PEEK");
    const sizes = () => s.run.pools.commonRelics.length + s.run.pools.uncommonRelics.length;
    for (const tier of ["common", "uncommon", "rare", "shop", "boss"] as const) {
      const before = sizes();
      const peeked = peekRelicFromPool(ctx, tier);
      expect(peekRelicFromPool(ctx, tier)).toBe(peeked); // idempotent
      expect(sizes()).toBe(before);
      expect(obtainRelicFromPool(ctx, tier)).toBe(peeked);
    }
    // the fallback chain matches too
    s.run.pools.commonRelics = [];
    s.run.pools.uncommonRelics = ["U1"];
    expect(peekRelicFromPool(ctx, "common")).toBe("U1");
    s.run.pools.uncommonRelics = [];
    s.run.pools.rareRelics = [];
    expect(peekRelicFromPool(ctx, "common")).toBe("CIRCLET");
    s.run.pools.bossRelics = [];
    expect(peekRelicFromPool(ctx, "boss")).toBe("RED_CIRCLET");
  });
});

describe("shop", () => {
  test("inventory shape: 2A/2S/1P (distinct pairs, power never common), 2 colorless, 3 relics, 3 potions", () => {
    for (const seed of ["S1", "S2", "S3", "S4"]) {
      const { ctx } = ctxFor(seed);
      const shop = generateShop(ctx);
      expect(shop.cards.length).toBe(7);
      const type = (i: number) => bundle.cards.get(shop.cards[i]!.id)!.type;
      expect([type(0), type(1), type(2), type(3), type(4)]).toEqual(["attack", "attack", "skill", "skill", "power"]);
      expect(shop.cards[0]!.id).not.toBe(shop.cards[1]!.id);
      expect(shop.cards[2]!.id).not.toBe(shop.cards[3]!.id);
      expect(shop.cards[4]!.rarity).not.toBe("common"); // promotion
      expect(shop.cards[5]!.colorless).toBe(true);
      expect(shop.cards[5]!.rarity).toBe("uncommon");
      expect(shop.cards[6]!.colorless).toBe(true);
      expect(shop.cards[6]!.rarity).toBe("rare");
      expect(shop.relics.length).toBe(3);
      expect(shop.relics[2]!.tier).toBe("shop");
      expect(shop.potions.length).toBe(3);
    }
  });

  test("exactly one of the 5 class cards is half price", () => {
    for (const seed of ["H1", "H2", "H3"]) {
      const { ctx } = ctxFor(seed);
      const shop = generateShop(ctx);
      let sales = 0;
      for (let i = 0; i < 5; i++) {
        const slot = shop.cards[i]!;
        const base = SHOP.basePrices.cardByRarity[slot.rarity];
        const lo = Math.trunc(base * 0.9);
        if (slot.price < lo) {
          sales++;
          // halved via integer division of the jittered price
          expect(slot.price).toBeGreaterThanOrEqual(Math.trunc(lo / 2));
          expect(slot.price).toBeLessThanOrEqual(Math.trunc((base * 1.1) / 2));
        } else {
          expect(slot.price).toBeLessThanOrEqual(Math.trunc(base * 1.1));
        }
      }
      expect(sales).toBe(1);
    }
  });

  test("colorless cards cost x1.2; relic/potion prices jitter 0.95-1.05 of base", () => {
    const { ctx } = ctxFor("PRICE");
    const shop = generateShop(ctx);
    for (const i of [5, 6]) {
      const slot = shop.cards[i]!;
      const base = SHOP.basePrices.cardByRarity[slot.rarity];
      expect(slot.price).toBeGreaterThanOrEqual(Math.trunc(base * 0.9 * 1.2) - 1);
      expect(slot.price).toBeLessThanOrEqual(Math.trunc(base * 1.1 * 1.2) + 1);
    }
    for (const r of shop.relics) {
      const base = SHOP.basePrices.relicByTier[r.tier];
      expect(r.price).toBeGreaterThanOrEqual(Math.round(base * 0.95) - 1);
      expect(r.price).toBeLessThanOrEqual(Math.round(base * 1.05) + 1);
    }
    for (const p of shop.potions) {
      const base = SHOP.basePrices.potionByRarity[bundle.potions.get(p.id)!.rarity];
      expect(p.price).toBeGreaterThanOrEqual(Math.round(base * 0.95) - 1);
      expect(p.price).toBeLessThanOrEqual(Math.round(base * 1.05) + 1);
    }
  });

  test("removal cost escalates 75 + 25 per purchase", () => {
    const { s, ctx } = ctxFor("REM");
    expect(computeRemovalCost(ctx)).toBe(75);
    s.run.history.cardRemovesPurchased = 1;
    expect(computeRemovalCost(ctx)).toBe(100);
    s.run.history.cardRemovesPurchased = 3;
    expect(computeRemovalCost(ctx)).toBe(150);
  });

  test("A16: every item price is round(1.1x) of the A15 shop; the removal cost is untouched", () => {
    // ShopScreen.init "applyDiscount(1.1F, false)" - affectPurge false
    const a15 = ctxFor("A16", 15);
    const a16 = ctxFor("A16", 16);
    const shop15 = generateShop(a15.ctx);
    const shop16 = generateShop(a16.ctx);
    for (let i = 0; i < 7; i++) expect(shop16.cards[i]!.price).toBe(Math.round(shop15.cards[i]!.price * 1.1));
    for (let i = 0; i < 3; i++) expect(shop16.relics[i]!.price).toBe(Math.round(shop15.relics[i]!.price * 1.1));
    for (let i = 0; i < shop15.potions.length; i++) {
      expect(shop16.potions[i]!.price).toBe(Math.round(shop15.potions[i]!.price * 1.1));
    }
    expect(shop16.removalCost).toBe(75);
    expect(shop15.removalCost).toBe(75);
  });

  test("relics come off the END of the rolled pool, each tier roll followed by its own price roll", () => {
    // ShopScreen.initRelics: returnRandomRelicEnd(rollRelicTier()) then
    // round(price * merchantRng.random(0.95F, 1.05F)), slot by slot
    for (const seed of ["RELEND1", "RELEND2", "RELEND3", "RELEND4"]) {
      const { s, ctx } = ctxFor(seed);
      const pools = structuredClone(s.run.pools);
      const merchant = Rng.fromState(ctx.rng("merchantRng").saveState());
      const shop = generateShop(ctx);
      for (let i = 0; i < 7; i++) merchant.randomFloatRange(0.9, 1.1); // card prices
      merchant.random(4); // sale slot
      const keyOf = { common: "commonRelics", uncommon: "uncommonRelics", rare: "rareRelics", shop: "shopRelics" } as const;
      for (let i = 0; i < 3; i++) {
        let tier: "common" | "uncommon" | "rare" | "shop" = "shop";
        if (i !== 2) {
          const roll = merchant.random(99);
          tier = roll < 48 ? "common" : roll < 82 ? "uncommon" : "rare";
        }
        expect(shop.relics[i]!.tier).toBe(tier);
        expect(shop.relics[i]!.id).toBe(pools[keyOf[tier]].pop()!);
        const base = SHOP.basePrices.relicByTier[tier];
        expect(shop.relics[i]!.price).toBe(Math.round(f32mul(base, merchant.randomFloatRange(0.95, 1.05))));
      }
    }
  });

  test("relics that cannot spawn in a ShopRoom are popped, thrown away and replaced", () => {
    // Courier/MawBank/OldCoin/SmilingMask.canSpawn: "!(getCurrRoom() instanceof ShopRoom)"
    const { s, ctx } = ctxFor("NOTINSHOP", 0, notInShopBundle);
    s.run.pools.commonRelics = ["C1", "MAW_BANK"];
    s.run.pools.uncommonRelics = ["U1", "THE_COURIER"];
    s.run.pools.rareRelics = ["R1", "OLD_COIN"];
    s.run.pools.shopRelics = ["S1", "SMILING_MASK"];
    const shop = generateShop(ctx);
    const ids = shop.relics.map((r) => r.id);
    for (const banned of ["THE_COURIER", "MAW_BANK", "OLD_COIN", "SMILING_MASK"]) expect(ids).not.toContain(banned);
    for (const id of ids.slice(0, 2)) expect(["C1", "U1", "R1", "CIRCLET"]).toContain(id);
    // the shop slot popped SMILING_MASK off the end, threw it away, then took S1
    expect(ids[2]).toBe("S1");
    expect(s.run.pools.shopRelics).toEqual([]);
  });

  test("The Courier and Membership Card each round in turn; removal takes Membership's 0.5 of the base", () => {
    // ShopScreen.init: applyDiscount(0.8F, true) then applyDiscount(0.5F, true)
    const plain = ctxFor("DISCOUNTS");
    const both = ctxFor("DISCOUNTS", 0, courierMembershipBundle);
    both.s.run.relics.push({ defId: "THE_COURIER", counter: 0 }, { defId: "MEMBERSHIP_CARD", counter: 0 });
    const a = generateShop(plain.ctx);
    const b = generateShop(both.ctx);
    const chain = (p: number) => Math.round(Math.round(f32mul(p, 0.8)) * 0.5);
    for (let i = 0; i < 7; i++) expect(b.cards[i]!.price).toBe(chain(a.cards[i]!.price));
    for (let i = 0; i < 3; i++) expect(b.relics[i]!.price).toBe(chain(a.relics[i]!.price));
    for (let i = 0; i < 3; i++) expect(b.potions[i]!.price).toBe(chain(a.potions[i]!.price));
    expect(b.removalCost).toBe(Math.round(75 * 0.5)); // 38, not round(round(75 * 0.8) * 0.5) = 30

    const courierOnly = ctxFor("DISCOUNTS", 0, courierMembershipBundle);
    courierOnly.s.run.relics.push({ defId: "THE_COURIER", counter: 0 });
    courierOnly.s.run.history.cardRemovesPurchased = 1;
    expect(generateShop(courierOnly.ctx).removalCost).toBe(80);
  });

  test("buying Membership Card halves what is left and resets removal from the base cost", () => {
    // StoreRelic.purchaseRelic: "if(relic.relicId.equals("Membership Card")) shopScreen.applyDiscount(0.5F, true)"
    const { s, ctx } = ctxFor("BUYMEMBER", 0, courierMembershipBundle);
    s.run.relics.push({ defId: "THE_COURIER", counter: 0 });
    const shop = generateShop(ctx);
    expect(shop.removalCost).toBe(60);
    shop.relics[0] = { id: "MEMBERSHIP_CARD", tier: "shop", price: 1, sold: false };
    s.run.room = { kind: "shop", shop };
    s.run.gold = 5000;
    const cardsBefore = shop.cards.map((c) => c.price);
    const after = advance(s, { cmd: "shopBuy", kind: "relic", idx: 0 }, courierMembershipBundle);
    if (after.run.room?.kind !== "shop") throw new Error("expected shop");
    expect(after.run.room.shop.cards.map((c) => c.price)).toEqual(cardsBefore.map((p) => Math.round(p * 0.5)));
    expect(after.run.room.shop.removalCost).toBe(38); // round(75 * 0.5), not round(60 * 0.5)
  });

  test("buying Smiling Mask pins the removal cost at 50 on the spot", () => {
    // StoreRelic.purchaseRelic: "if(relic.relicId.equals("Smiling Mask")) ShopScreen.actualPurgeCost = 50"
    const { s, ctx } = ctxFor("BUYMASK");
    s.run.history.cardRemovesPurchased = 3;
    const shop = generateShop(ctx);
    expect(shop.removalCost).toBe(150);
    shop.relics[0] = { id: "SMILING_MASK", tier: "common", price: 1, sold: false };
    s.run.room = { kind: "shop", shop };
    s.run.gold = 5000;
    const after = advance(s, { cmd: "shopBuy", kind: "relic", idx: 0 }, bundle);
    if (after.run.room?.kind !== "shop") throw new Error("expected shop");
    expect(after.run.room.shop.removalCost).toBe(50);
  });

  test("same seed generates an identical shop", () => {
    const a = ctxFor("SAME");
    const b = ctxFor("SAME");
    expect(JSON.stringify(generateShop(a.ctx))).toBe(JSON.stringify(generateShop(b.ctx)));
  });
});
