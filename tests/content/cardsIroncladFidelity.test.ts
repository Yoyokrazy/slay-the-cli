// Java-fidelity regressions for the Ironclad pool: each case pins a behavior
// read from the decompiled game (class named in the describe) where this
// engine used to diverge. Player: 80 HP, 3 energy. T_TANK: 200 HP, attacks 10.

import { test, expect, describe } from "bun:test";
import type { CardDef, ContentBundle } from "../../src/engine/content/defs";
import type { GameState } from "../../src/engine/game";
import { createCombatGame, advance } from "../../src/engine/game";
import { getCardPreviews } from "../../src/engine/combat/preview";
import { makeTestBundle } from "../helpers/testBundle";
import { corePowers } from "../../src/content/powers/core";
import { ironcladCards, ironcladPowers, ironcladEffects } from "../../src/content/cards/ironclad";
import { allRelics, relicSupportPowers } from "../../src/content/relics";
import { buildBaseContentBundle } from "../../src/content/index";
import { act34Monsters, act34Powers } from "../../src/content/monsters/act34/index";
import { assertInvariants } from "../fuzz/helpers";
import {
  bundle,
  ironBundle,
  fight,
  fightWithInHand,
  play,
  endTurn,
  choose,
  choiceIndexOf,
  handNames,
  pileNames,
  monsterHp,
  playerPower,
  monsterPower,
} from "./cardsTestKit";

const strikes = (n: number) => Array(n).fill("STRIKE_RED") as string[];

/** Deal the combat's card instances into exact piles (draw index 0 = top). */
function arrange(s: GameState, piles: { hand: string[]; draw?: string[]; discard?: string[]; exhaust?: string[] }): void {
  const c = s.combat!;
  const used = new Set<number>();
  const take = (defId: string): number => {
    const card = Object.values(c.cards).find((x) => !used.has(x.iid) && x.defId === defId);
    if (!card) throw new Error(`no free ${defId} instance`);
    used.add(card.iid);
    return card.iid;
  };
  c.player.piles.hand = piles.hand.map(take);
  c.player.piles.draw = (piles.draw ?? []).map(take);
  c.player.piles.discard = (piles.discard ?? []).map(take);
  c.player.piles.exhaust = (piles.exhaust ?? []).map(take);
  c.player.piles.limbo = [];
}

const pushPower = (s: GameState, id: string, amount: number, idx?: number): void => {
  const powers = idx === undefined ? s.combat!.player.powers : s.combat!.monsters[idx]!.powers;
  powers.push({ id, amount, justApplied: false, data: null });
};

const cardRolls = (s: GameState): number => s.rng.floor.cardRandomRng.counter;

type LoggedEvent = { event: string; payload?: unknown };

const eventIndex = (s: GameState, pred: (e: LoggedEvent) => boolean): number => s.eventLog.findIndex(pred);

const powerEvent =
  (event: "powerApplied" | "powerRemoved", powerId: string) =>
  (e: LoggedEvent): boolean =>
    e.event === event && (e.payload as { powerId: string }).powerId === powerId;

// --- bundles with relics (the kit bundle carries none) ------------------------

function relicBundle(): ContentBundle {
  const b = ironBundle();
  for (const p of relicSupportPowers) b.powers.set(p.id, p);
  for (const r of allRelics) b.relics.set(r.id, r);
  return b;
}
const RB = relicBundle();

function fightR(opts: { deck: (string | { defId: string; upgrades?: number })[]; relics: string[]; monsters?: string[]; hp?: number }): GameState {
  return createCombatGame({
    seed: "IRONKIT",
    bundle: RB,
    character: "IRONCLAD",
    deck: opts.deck.map((d) => (typeof d === "string" ? { defId: d } : d)),
    relics: opts.relics,
    monsters: opts.monsters ?? ["T_TANK"],
    hp: opts.hp,
    maxHp: 80,
  });
}

function playR(s: GameState, defId: string, target = 0): GameState {
  const idx = handNames(s).indexOf(defId);
  if (idx === -1) throw new Error(`${defId} not in hand: ${handNames(s)}`);
  return advance(s, { cmd: "playCard", handIdx: idx, target }, RB);
}

// ------------------------------------------------------------------------------

describe("WeakPower / FrailPower priority (ApplyPowerAction sorts powers)", () => {
  test("Strength applied after Weak still folds first: (6 + 4) * 0.75 = 7", () => {
    let s = fight({ deck: [{ defId: "FLEX", upgrades: 1 }, ...strikes(4)] });
    pushPower(s, "WEAK", 2);
    s = play(s, "FLEX");
    expect(s.combat!.player.powers.map((p) => p.id)).toEqual(["STRENGTH", "LOSE_STRENGTH", "WEAK"]);
    s = play(s, "STRIKE_RED", 0);
    expect(monsterHp(s)).toBe(200 - 7); // insertion order gave 6 * 0.75 + 4 = 8
  });

  test("Heavy Blade under Weak: (14 + 3 * 4) * 0.75 = 19", () => {
    let s = fight({ deck: [{ defId: "FLEX", upgrades: 1 }, "HEAVY_BLADE", ...strikes(3)] });
    pushPower(s, "WEAK", 2);
    s = play(s, "FLEX");
    s = play(s, "HEAVY_BLADE", 0);
    expect(monsterHp(s)).toBe(200 - 19);
  });

  test("Dexterity applied after Frail still folds first: (5 + 4) * 0.75 = 6", () => {
    const b = ironBundle();
    const dex: CardDef = {
      id: "T_DEX4", name: "T Dex", color: "red", type: "skill", rarity: "basic", cost: 0, target: "self",
      values: {}, upgradeValues: {}, keywords: [],
      primitives: [{ do: "applyPower", power: "DEXTERITY", n: 4, target: "self" }],
    };
    b.cards.set(dex.id, dex);
    let s = createCombatGame({
      seed: "IRONKIT", bundle: b, character: "IRONCLAD", monsters: ["T_TANK"],
      deck: [{ defId: "T_DEX4" }, { defId: "DEFEND_RED" }, ...strikes(3).map((defId) => ({ defId }))],
    });
    pushPower(s, "FRAIL", 2);
    const at = (id: string) => handNames(s).indexOf(id);
    s = advance(s, { cmd: "playCard", handIdx: at("T_DEX4") }, b);
    s = advance(s, { cmd: "playCard", handIdx: at("DEFEND_RED") }, b);
    expect(s.combat!.player.block).toBe(6); // insertion order gave 5 * 0.75 + 4 = 7
  });
});

describe("lab report: Rampage under Weak + Flex (AbstractCard.calculateCardDamage, DamageInfo.applyPowers)", () => {
  // Weak (from an enemy) is already on the player when Flex adds Strength.
  // The game folds Strength, then Weak, then the target's Vulnerable, and
  // floors once at the end.
  const weakThenFlex = (deck: string[]): GameState => {
    let s = fight({ deck });
    pushPower(s, "WEAK", 2);
    return play(s, "FLEX");
  };

  test("Rampage + two Strikes deal 7 + 6 + 6 = 19 (not 8 + 6 + 6)", () => {
    let s = weakThenFlex(["FLEX", "RAMPAGE", ...strikes(3)]);
    s = play(s, "RAMPAGE", 0);
    expect(monsterHp(s)).toBe(200 - 7); // floor((8 + 2) * 0.75)
    s = play(s, "STRIKE_RED", 0);
    s = play(s, "STRIKE_RED", 0);
    expect(monsterHp(s)).toBe(200 - 19);
  });

  test("Pummel: 4 x floor((2 + 2) * 0.75) = 12", () => {
    let s = weakThenFlex(["FLEX", "PUMMEL", ...strikes(3)]);
    s = play(s, "PUMMEL", 0);
    expect(monsterHp(s)).toBe(200 - 12);
  });

  test("one floor after Vulnerable too: floor((8 + 2) * 0.75 * 1.5) = 11", () => {
    let s = weakThenFlex(["FLEX", "RAMPAGE", ...strikes(3)]);
    pushPower(s, "VULNERABLE", 2, 0);
    s = play(s, "RAMPAGE", 0);
    expect(monsterHp(s)).toBe(200 - 11); // flooring after Weak would give 10
    s = play(s, "STRIKE_RED", 0);
    expect(monsterHp(s)).toBe(200 - 11 - 9); // (6 + 2) * 0.75 * 1.5 = 9
  });

  test("enemy side: Strength lost after Weak still folds first, one floor at the end", () => {
    let s = fight({ deck: ["DISARM", ...strikes(4)] });
    pushPower(s, "WEAK", 2, 0);
    pushPower(s, "VULNERABLE", 2);
    s = play(s, "DISARM", 0); // -2 Strength lands after the Weak
    expect(s.combat!.monsters[0]!.powers.map((p) => p.id)).toEqual(["STRENGTH", "WEAK"]);
    s = endTurn(s); // T_TANK: floor((10 - 2) * 0.75 * 1.5) = 9
    expect(s.run.hp).toBe(80 - 9); // insertion order gave floor((10 * 0.75 - 2) * 1.5) = 8
  });
});

describe("WHIRLWIND (WhirlwindAction)", () => {
  test("hits are queued when the action resolves: Rage block lands first and soaks Thorns", () => {
    let s = fight({ deck: ["RAGE", "WHIRLWIND", ...strikes(3)] });
    pushPower(s, "THORNS", 3, 0);
    s = play(s, "RAGE");
    s = play(s, "WHIRLWIND"); // X = 3
    expect(monsterHp(s)).toBe(200 - 15);
    // Rage's 3 block came before the 3 hits, so it ate the first Thorns
    expect(s.run.hp).toBe(80 - 6);
    expect(s.combat!.player.block).toBe(0);
  });

  test("Chemical X adds 2 hits", () => {
    let s = fightR({ deck: ["WHIRLWIND", ...strikes(4)], relics: ["CHEMICAL_X"] });
    s = playR(s, "WHIRLWIND");
    expect(monsterHp(s)).toBe(200 - 5 * 5);
    expect(s.combat!.player.energy).toBe(0);
  });

  test("the hand preview still prices the X hits", () => {
    const s = fight({ deck: ["WHIRLWIND", ...strikes(4)] });
    const pv = getCardPreviews(s, bundle, 0)[handNames(s).indexOf("WHIRLWIND")];
    expect(pv).toMatchObject({ damage: 5, hits: 3 });
  });
});

describe("HAVOC (Havoc.use + PlayTopCardAction + GameActionManager canUse)", () => {
  test("the random target is rolled at use, even with nothing left to play", () => {
    let s = fight({ deck: ["HAVOC", ...strikes(4)] });
    const rolls = cardRolls(s);
    s = play(s, "HAVOC");
    expect(cardRolls(s)).toBe(rolls + 1);
  });

  test("an unplayable status off the top is exhausted without being played", () => {
    let s = fight({ deck: ["HAVOC", "WOUND", ...strikes(4)] });
    arrange(s, { hand: ["HAVOC", ...strikes(4)], draw: ["WOUND"] });
    s = play(s, "HAVOC");
    expect(pileNames(s, "exhaust")).toEqual(["WOUND"]);
    expect(s.combat!.turnFlags.cardsPlayedThisTurn).toBe(1); // only Havoc counts
    const played = s.eventLog.filter((e) => e.event === "cardPlayed").map((e) => (e.payload as { defId: string }).defId);
    expect(played).toEqual(["HAVOC"]);
  });

  test("Clash that fails canUse is exhausted unplayed", () => {
    let s = fight({ deck: ["HAVOC", "CLASH", "DEFEND_RED", ...strikes(3)] });
    arrange(s, { hand: ["HAVOC", "DEFEND_RED", ...strikes(3)], draw: ["CLASH"] });
    s = play(s, "HAVOC");
    expect(monsterHp(s)).toBe(200);
    expect(pileNames(s, "exhaust")).toEqual(["CLASH"]);
  });
});

describe("DOUBLE_TAP (DoubleTapPower keys off !purgeOnUse)", () => {
  test("a Havoc'd attack is played twice", () => {
    let s = fight({ deck: ["DOUBLE_TAP", "HAVOC", ...strikes(4)] });
    arrange(s, { hand: ["DOUBLE_TAP", "HAVOC", ...strikes(3)], draw: ["STRIKE_RED"] });
    s = play(s, "DOUBLE_TAP");
    s = play(s, "HAVOC");
    expect(monsterHp(s)).toBe(200 - 12);
    expect(playerPower(s, "DOUBLE_TAP")).toBeUndefined();
    expect(pileNames(s, "exhaust")).toEqual(["STRIKE_RED"]);
    expect(s.combat!.player.piles.limbo).toEqual([]);
  });
});

describe("DEMON_FORM / BRUTALITY (atStartOfTurnPostDraw)", () => {
  test("Demon Form's Strength queues after the pre-draw start-of-turn powers", () => {
    let s = fight({ deck: strikes(10) });
    pushPower(s, "DEMON_FORM", 2);
    pushPower(s, "FLAME_BARRIER", 4);
    s = endTurn(s);
    const removed = eventIndex(s, powerEvent("powerRemoved", "FLAME_BARRIER"));
    const strength = eventIndex(s, powerEvent("powerApplied", "STRENGTH"));
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(strength).toBeGreaterThan(removed);
    expect(playerPower(s, "STRENGTH")).toBe(2);
  });

  test("Brutality draws, then loses the HP", () => {
    let s = fight({ deck: strikes(10) });
    pushPower(s, "BRUTALITY", 1);
    pushPower(s, "RUPTURE", 1);
    s = endTurn(s);
    const draws = s.eventLog.map((e, i) => (e.event === "cardDrawn" ? i : -1)).filter((i) => i >= 0);
    expect(draws.length).toBe(6); // 5 + Brutality
    // Rupture's Strength (addToTop off the HP loss) follows Brutality's draw
    expect(eventIndex(s, powerEvent("powerApplied", "STRENGTH"))).toBeGreaterThan(draws[5]!);
    expect(s.run.hp).toBe(80 - 10 - 1);
  });
});

describe("RUPTURE (RupturePower addToTop)", () => {
  test("a Pain loss buffs the Sword Boomerang hits still queued", () => {
    let s = fightWithInHand(["RUPTURE", "PAIN", "SWORD_BOOMERANG"], {
      deck: ["RUPTURE", "PAIN", "SWORD_BOOMERANG", ...strikes(2)],
    });
    s = play(s, "RUPTURE"); // Pain's loss resolves before Rupture exists
    expect(playerPower(s, "STRENGTH")).toBeUndefined();
    s = play(s, "SWORD_BOOMERANG");
    expect(playerPower(s, "STRENGTH")).toBe(1);
    expect(monsterHp(s)).toBe(200 - 3 * 4);
    expect(s.run.hp).toBe(78);
  });
});

describe("TRUE_GRIT (ExhaustAction random)", () => {
  test("a lone card in hand is exhausted without a roll", () => {
    let s = fight({ deck: ["TRUE_GRIT", "STRIKE_RED"] });
    const rolls = cardRolls(s);
    s = play(s, "TRUE_GRIT");
    expect(pileNames(s, "exhaust")).toEqual(["STRIKE_RED"]);
    expect(cardRolls(s)).toBe(rolls);
  });

  test("two or more cards: one roll", () => {
    let s = fight({ deck: ["TRUE_GRIT", ...strikes(2)] });
    const rolls = cardRolls(s);
    s = play(s, "TRUE_GRIT");
    expect(pileNames(s, "exhaust")).toEqual(["STRIKE_RED"]);
    expect(cardRolls(s)).toBe(rolls + 1);
  });
});

describe("WARCRY (PutOnDeckAction)", () => {
  test("a lone card in hand goes on top through hand.getRandomCard (one roll)", () => {
    let s = fight({ deck: ["WARCRY", "STRIKE_RED"] });
    const rolls = cardRolls(s);
    s = play(s, "WARCRY"); // nothing left to draw
    expect(s.pending).toBeNull();
    expect(pileNames(s, "draw")).toEqual(["STRIKE_RED"]);
    expect(handNames(s)).toEqual([]);
    expect(cardRolls(s)).toBe(rolls + 1);
  });
});

describe("WILD_STRIKE / RECKLESS_CHARGE (CardGroup.addToRandomSpot)", () => {
  test("an empty draw pile takes the Wound without a roll", () => {
    let s = fight({ deck: ["WILD_STRIKE", ...strikes(4)] });
    const rolls = cardRolls(s);
    s = play(s, "WILD_STRIKE", 0);
    expect(pileNames(s, "draw")).toEqual(["WOUND"]);
    expect(cardRolls(s)).toBe(rolls);
  });

  test("random(size - 1) from the bottom: the new card never lands on top", () => {
    for (const seed of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
      let s = fight({ deck: ["RECKLESS_CHARGE", "DEFEND_RED", ...strikes(4)], seed });
      arrange(s, { hand: ["RECKLESS_CHARGE", ...strikes(4)], draw: ["DEFEND_RED"] });
      const rolls = cardRolls(s);
      s = play(s, "RECKLESS_CHARGE", 0);
      expect(pileNames(s, "draw")).toEqual(["DEFEND_RED", "DAZED"]);
      expect(cardRolls(s)).toBe(rolls + 1);
    }
  });
});

describe("SECOND_WIND (BlockPerNonAttackAction) / SEVER_SOUL (ExhaustAllNonAttackAction)", () => {
  test("Second Wind exhausts the last card first, then gains the blocks", () => {
    let s = fight({ deck: ["SECOND_WIND", "DEFEND_RED", "SHRUG_IT_OFF", ...strikes(2)] });
    arrange(s, { hand: ["SECOND_WIND", "DEFEND_RED", "SHRUG_IT_OFF", ...strikes(2)] });
    s = play(s, "SECOND_WIND");
    expect(pileNames(s, "exhaust")).toEqual(["SHRUG_IT_OFF", "DEFEND_RED"]);
    expect(s.combat!.player.block).toBe(10);
  });

  test("Sever Soul exhausts the last card first", () => {
    let s = fight({ deck: ["SEVER_SOUL", "DEFEND_RED", "SHRUG_IT_OFF", ...strikes(2)] });
    arrange(s, { hand: ["SEVER_SOUL", "DEFEND_RED", "SHRUG_IT_OFF", ...strikes(2)] });
    s = play(s, "SEVER_SOUL", 0);
    expect(pileNames(s, "exhaust")).toEqual(["SHRUG_IT_OFF", "DEFEND_RED"]);
    expect(monsterHp(s)).toBe(200 - 16);
  });

  test("Second Wind's hand preview still prices the block", () => {
    const s = fight({ deck: ["SECOND_WIND", "DEFEND_RED", "SHRUG_IT_OFF", ...strikes(2)] });
    arrange(s, { hand: ["SECOND_WIND", "DEFEND_RED", "SHRUG_IT_OFF", ...strikes(2)] });
    expect(getCardPreviews(s, bundle, 0)[0]).toMatchObject({ block: 10 });
  });
});

describe("SPOT_WEAKNESS (SpotWeaknessAction addToBot)", () => {
  test("the Strength lands after the card itself has resolved", () => {
    let s = fight({ deck: ["SPOT_WEAKNESS", ...strikes(4)] });
    pushPower(s, "CORRUPTION", -1); // the card exhausts, which is observable
    const iid = s.combat!.player.piles.hand.find((i) => s.combat!.cards[i]!.defId === "SPOT_WEAKNESS")!;
    s = play(s, "SPOT_WEAKNESS", 0);
    const exhausted = eventIndex(s, (e) => e.event === "cardExhausted" && (e.payload as { iid: number }).iid === iid);
    expect(exhausted).toBeGreaterThanOrEqual(0);
    expect(eventIndex(s, powerEvent("powerApplied", "STRENGTH"))).toBeGreaterThan(exhausted);
    expect(playerPower(s, "STRENGTH")).toBe(3);
  });
});

describe("SHOCKWAVE (per-enemy Weak then Vulnerable)", () => {
  test("applications interleave by enemy", () => {
    let s = fight({ deck: ["SHOCKWAVE", ...strikes(4)], monsters: ["T_TANK", "T_TANK"] });
    s = play(s, "SHOCKWAVE");
    const order = s.eventLog
      .filter((e) => e.event === "powerApplied")
      .map((e) => {
        const p = e.payload as { powerId: string; target: { idx: number } };
        return `${p.powerId}@${p.target.idx}`;
      });
    expect(order).toEqual(["WEAK@0", "VULNERABLE@0", "WEAK@1", "VULNERABLE@1"]);
  });
});

describe("DISARM (negative StrengthPower is a debuff)", () => {
  test("Artifact negates it", () => {
    let s = fight({ deck: ["DISARM", ...strikes(4)] });
    pushPower(s, "ARTIFACT", 1, 0);
    s = play(s, "DISARM", 0);
    expect(monsterPower(s, "STRENGTH")).toBeUndefined();
    expect(monsterPower(s, "ARTIFACT")).toBeUndefined();
  });
});

describe("FEED / REAPER (FeedAction, VampireDamageAllEnemiesAction)", () => {
  test("Feed gives nothing for a Minion-power kill of a normal monster def", () => {
    let s = fight({ deck: ["FEED", ...strikes(4)], monsters: ["T_FRAIL"] });
    pushPower(s, "MINION", 1, 0); // Gremlin Leader's gremlins
    s = play(s, "FEED", 0);
    expect(s.combat!.monsters[0]!.isDead).toBe(true);
    expect(s.run.maxHp).toBe(80);
  });

  test("Reaper's heal takes the normal heal path: Red Skull turns off above half", () => {
    let s = fightR({ deck: ["REAPER", ...strikes(4)], relics: ["RED_SKULL"], monsters: ["T_TANK", "T_TANK"], hp: 40 });
    expect(playerPower(s, "STRENGTH")).toBe(3);
    s = playR(s, "REAPER"); // 4 + 3 to each: heal 14
    expect(s.run.hp).toBe(54);
    expect(playerPower(s, "STRENGTH") ?? 0).toBe(0);
  });

  test("Feed's heal takes the normal heal path too, on the killing blow", () => {
    let s = fightR({ deck: ["FEED", ...strikes(4)], relics: ["RED_SKULL"], monsters: ["T_FRAIL"], hp: 40 });
    s = playR(s, "FEED", 0);
    expect(s.run.maxHp).toBe(83);
    expect(s.run.hp).toBe(43);
    expect(playerPower(s, "STRENGTH") ?? 0).toBe(0);
  });
});

describe("INFERNAL_BLADE (returnTrulyRandomCardInCombat(ATTACK))", () => {
  test("HEALING cards (Feed, Reaper) are never generated", () => {
    const b = makeTestBundle();
    for (const p of [...corePowers, ...ironcladPowers]) b.powers.set(p.id, p);
    for (const [k, v] of ironcladEffects) b.effects.set(k, v);
    for (const c of ironcladCards.filter((d) => ["INFERNAL_BLADE", "STRIKE_RED", "FEED", "REAPER", "CLEAVE"].includes(d.id))) {
      b.cards.set(c.id, c);
    }
    for (const seed of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
      let s = createCombatGame({
        seed, bundle: b, character: "IRONCLAD", monsters: ["T_DUMMY"],
        deck: [{ defId: "INFERNAL_BLADE" }, ...strikes(4).map((defId) => ({ defId }))],
      });
      s = advance(s, { cmd: "playCard", handIdx: handNames(s).indexOf("INFERNAL_BLADE") }, b);
      expect(handNames(s).filter((n) => n !== "STRIKE_RED")).toEqual(["CLEAVE"]);
    }
  });
});

describe("DARK_EMBRACE (DarkEmbracePower: !areMonstersBasicallyDead)", () => {
  test("a half-dead enemy still counts: the exhaust draws", () => {
    let s = fight({ deck: [{ defId: "TRUE_GRIT", upgrades: 1 }, "DEFEND_RED", ...strikes(4)] });
    arrange(s, { hand: ["TRUE_GRIT", "DEFEND_RED", ...strikes(3)], draw: ["STRIKE_RED"] });
    pushPower(s, "DARK_EMBRACE", 1);
    s.combat!.monsters[0]!.halfDead = true; // Awakened One between phases
    s = play(s, "TRUE_GRIT");
    s = choose(s, [choiceIndexOf(s, "DEFEND_RED")]);
    expect(pileNames(s, "exhaust")).toEqual(["DEFEND_RED"]);
    expect(handNames(s).length).toBe(4); // 3 strikes + the Dark Embrace draw
  });
});

describe("exhaust trigger order (CardGroup.moveToExhaustPile: relics, powers, card)", () => {
  test("Dead Branch's card is queued ahead of Dark Embrace's draw", () => {
    let s = fightR({ deck: ["DEFEND_RED", ...strikes(10)], relics: ["DEAD_BRANCH"] });
    arrange(s, { hand: ["DEFEND_RED", ...strikes(9)], draw: ["STRIKE_RED"] });
    pushPower(s, "CORRUPTION", -1);
    pushPower(s, "DARK_EMBRACE", 1);
    const created = s.combat!.nextCardInstanceId;
    s = playR(s, "DEFEND_RED"); // free under Corruption, exhausts
    // 9 left + Dead Branch's card = a full hand, so Dark Embrace's draw fizzles
    expect(s.combat!.player.piles.hand).toContain(created);
    expect(s.combat!.player.piles.hand.length).toBe(10);
    expect(pileNames(s, "draw")).toEqual(["STRIKE_RED"]);
  });
});

describe("ARMAMENTS (ArmamentsAction, upgradeBaseCost)", () => {
  test("Blood for Blood already cut below 4 drops one more", () => {
    let s = fight({ deck: ["ARMAMENTS", "BLOOD_FOR_BLOOD", ...strikes(3)] });
    const bfb = Object.values(s.combat!.cards).find((c) => c.defId === "BLOOD_FOR_BLOOD")!;
    bfb.cost = 2; // two HP losses so far
    bfb.costForTurn = 2;
    s = play(s, "ARMAMENTS");
    s = choose(s, [choiceIndexOf(s, "BLOOD_FOR_BLOOD")]);
    const up = s.combat!.cards[bfb.iid]!;
    expect(up.upgrades).toBe(1);
    expect(up.cost).toBe(1);
    expect(up.costForTurn).toBe(1);
  });

  test("the turn's discount survives the new base cost", () => {
    let s = fight({ deck: ["ARMAMENTS", "CORRUPTION", ...strikes(3)] });
    const cor = Object.values(s.combat!.cards).find((c) => c.defId === "CORRUPTION")!;
    cor.costForTurn = 2; // 3 base, 1 off this turn
    s = play(s, "ARMAMENTS");
    s = choose(s, [choiceIndexOf(s, "CORRUPTION")]);
    expect(s.combat!.cards[cor.iid]!.cost).toBe(2);
    expect(s.combat!.cards[cor.iid]!.costForTurn).toBe(1);
  });

  test("the pick comes back after the other candidates, ahead of the held cards", () => {
    let s = fight({ deck: ["ARMAMENTS", "STRIKE_RED", "BODY_SLAM", "WOUND", "DEFEND_RED"] });
    arrange(s, { hand: ["ARMAMENTS", "STRIKE_RED", "BODY_SLAM", "WOUND", "DEFEND_RED"] });
    s = play(s, "ARMAMENTS");
    s = choose(s, [choiceIndexOf(s, "BODY_SLAM")]);
    expect(handNames(s)).toEqual(["STRIKE_RED", "DEFEND_RED", "BODY_SLAM", "WOUND"]);
  });
});

describe("DUAL_WIELD (DualWieldAction, makeStatEquivalentCopy)", () => {
  test("copies carry misc (Rampage growth) and this turn's cost", () => {
    let s = fight({ deck: ["DUAL_WIELD", "RAMPAGE", "DEFEND_RED", "DEFEND_RED", "DEFEND_RED"] });
    const ramp = Object.values(s.combat!.cards).find((c) => c.defId === "RAMPAGE")!;
    ramp.misc = 10;
    ramp.costForTurn = 0;
    s = play(s, "DUAL_WIELD"); // lone candidate: stays, plus one copy
    const copies = s.combat!.player.piles.hand.map((i) => s.combat!.cards[i]!).filter((c) => c.defId === "RAMPAGE");
    expect(copies.length).toBe(2);
    expect(copies.map((c) => [c.misc, c.cost, c.costForTurn])).toEqual([
      [10, 1, 0],
      [10, 1, 0],
    ]);
    s = play(s, "RAMPAGE", 0);
    expect(monsterHp(s)).toBe(200 - 18);
  });

  test("a picked card is replaced by a copy; held cards return first", () => {
    let s = fight({ deck: ["DUAL_WIELD", "STRIKE_RED", "DEFEND_RED", { defId: "BASH", upgrades: 1 }, "SHRUG_IT_OFF"] });
    arrange(s, { hand: ["DUAL_WIELD", "STRIKE_RED", "DEFEND_RED", "BASH", "SHRUG_IT_OFF"] });
    const bash = Object.values(s.combat!.cards).find((c) => c.defId === "BASH")!.iid;
    s = play(s, "DUAL_WIELD");
    s = choose(s, [choiceIndexOf(s, "BASH")]);
    expect(handNames(s)).toEqual(["STRIKE_RED", "DEFEND_RED", "SHRUG_IT_OFF", "BASH", "BASH"]);
    expect(s.combat!.cards[bash]).toBeUndefined();
    const bashes = s.combat!.player.piles.hand.map((i) => s.combat!.cards[i]!).filter((c) => c.defId === "BASH");
    expect(bashes.every((c) => c.upgrades === 1)).toBe(true);
  });
});

describe("RAMPAGE (ModifyDamageAction on every same-uuid instance)", () => {
  test("a Double Tap copy grows the original too", () => {
    let s = fight({ deck: ["RAMPAGE", ...strikes(4)] });
    pushPower(s, "DOUBLE_TAP", 1);
    const iid = s.combat!.player.piles.hand.find((i) => s.combat!.cards[i]!.defId === "RAMPAGE")!;
    s = play(s, "RAMPAGE", 0);
    expect(monsterHp(s)).toBe(200 - 8 - 13);
    expect(s.combat!.cards[iid]!.misc).toBe(10); // grown by both plays: next hit is 18
  });
});

describe("EXHUME (ExhumeAction)", () => {
  test("does nothing into a full hand", () => {
    let s = fight({ deck: ["EXHUME", "IMPERVIOUS", "ANGER", ...strikes(9)] });
    arrange(s, { hand: ["ANGER", ...strikes(9)], exhaust: ["IMPERVIOUS"] });
    const exhume = Object.values(s.combat!.cards).find((c) => c.defId === "EXHUME")!.iid;
    // an autoplayed Exhume already waiting in the card queue (Distilled Chaos style)
    s.combat!.player.piles.limbo = [exhume];
    s.combat!.cardQueue.push({
      iid: exhume, target: 0, energyOnUse: 3, ignoreEnergyTotal: true, regardlessOfCost: true,
      purgeOnUse: false, exhaustOnUse: false, autoplayed: true,
    });
    s = play(s, "ANGER", 0); // the queued Exhume resolves first, with 10 in hand
    expect(pileNames(s, "exhaust")).toEqual(["IMPERVIOUS", "EXHUME"]);
    expect(handNames(s)).not.toContain("IMPERVIOUS");
  });
});

describe("DOUBLE_TAP replay whose target is gone (GameActionManager.getNextAction)", () => {
  // The copy keeps the original's monster (no randomTarget), so nothing retargets.
  const act3 = (() => {
    const b = buildBaseContentBundle();
    for (const m of act34Monsters) b.monsters.set(m.id, m);
    for (const p of act34Powers) if (!b.powers.has(p.id)) b.powers.set(p.id, p);
    return b;
  })();
  const playA = (s: GameState, defId: string, target = 0): GameState =>
    advance(s, { cmd: "playCard", handIdx: handNames(s).indexOf(defId), target }, act3);
  const tapTwinStrike = (monsters: string[]): GameState => {
    let s = createCombatGame({
      seed: "IRONKIT", bundle: act3, character: "IRONCLAD", monsters, hp: 80, maxHp: 80,
      deck: ["RAGE", "DOUBLE_TAP", "TWIN_STRIKE", "DEFEND_RED", "DEFEND_RED"].map((defId) => ({ defId })),
    });
    const target = monsters.length - 1;
    s.combat!.monsters[target]!.hp = 6; // Twin Strike's second hit is the kill
    s = playA(s, "RAGE");
    s = playA(s, "DOUBLE_TAP");
    return playA(s, "TWIN_STRIKE", target);
  };

  test("dead target: the copy fizzles, hits nobody else, is not counted", () => {
    let s = fight({ deck: ["RAGE", "DOUBLE_TAP", "TWIN_STRIKE", ...strikes(2)], monsters: ["T_FRAIL", "T_TANK"] });
    s = play(s, "RAGE");
    s = play(s, "DOUBLE_TAP");
    s = play(s, "TWIN_STRIKE", 0); // 5 + 5 into 8 HP
    expect(s.combat!.monsters[0]!.isDead).toBe(true);
    expect(monsterHp(s, 1)).toBe(200);
    expect(s.combat!.player.block).toBe(3); // Rage for the original only
    expect(s.combat!.turnFlags.cardsPlayedThisTurn).toBe(3);
    expect(s.combat!.player.piles.limbo).toEqual([]);
    expect(playerPower(s, "DOUBLE_TAP")).toBeUndefined();
  });

  test("half-dead Darkling: the copy is counted as played, then dropped unused", () => {
    const s = tapTwinStrike(["DARKLING", "DARKLING", "DARKLING"]);
    expect(s.combat!.monsters[2]!.halfDead).toBe(true);
    expect(s.combat!.player.block).toBe(3); // no Rage block for the copy
    expect(s.combat!.turnFlags.cardsPlayedThisTurn).toBe(4);
    expect(s.combat!.player.piles.limbo).toEqual([]);
  });

  test("Awakened One's first death clears the card queue: the copy never plays and leaves limbo", () => {
    const s = tapTwinStrike(["AWAKENED_ONE"]);
    expect(s.combat!.monsters[0]!.halfDead).toBe(true);
    expect(s.combat!.player.block).toBe(3);
    expect(s.combat!.turnFlags.cardsPlayedThisTurn).toBe(3);
    expect(s.combat!.player.piles.limbo).toEqual([]);
  });

  /** Awakened One (5 HP) as the only living target: the appended Cultists are dead. */
  const aoAlone = (deck: { defId: string; upgrades?: number }[]): GameState => {
    const s = createCombatGame({
      seed: "IRONKIT", bundle: act3, character: "IRONCLAD", monsters: ["AWAKENED_ONE"], hp: 80, maxHp: 80, deck,
    });
    for (const m of s.combat!.monsters) {
      if (m.id === "AWAKENED_ONE") m.hp = 5;
      else {
        m.isDead = true;
        m.hp = 0;
      }
    }
    return s;
  };
  const ao = (s: GameState) => s.combat!.monsters.find((m) => m.id === "AWAKENED_ONE")!;

  test("Distilled Chaos: real cards queued behind the killing Strike are lost, records included", () => {
    let s = aoAlone(Array(10).fill({ defId: "STRIKE_RED" }));
    s.run.potions[0] = "DISTILLED_CHAOS";
    s = advance(s, { cmd: "usePotion", slot: 0 }, act3); // top 3 queued; the first kills form 1
    expect(ao(s).halfDead).toBe(true);
    expect(() => assertInvariants(s)).not.toThrow();
    expect(pileNames(s, "draw").length).toBe(2);
    expect(pileNames(s, "discard")).toEqual(["STRIKE_RED"]);
    expect(s.combat!.player.piles.limbo).toEqual([]);
    expect(Object.keys(s.combat!.cards).length).toBe(8);
  });

  test("Havoc: the Havoc'd card that kills form 1 is exhausted; the plays queued behind it are lost", () => {
    let s = aoAlone([{ defId: "HAVOC" }, { defId: "HAVOC" }, ...Array(8).fill({ defId: "STRIKE_RED" })]);
    arrange(s, { hand: [], draw: ["HAVOC", "HAVOC", ...strikes(8)] });
    s.run.potions[0] = "DISTILLED_CHAOS";
    // queued: Havoc, Havoc, Strike. The first Havoc puts the next Strike in
    // front of the queue; that Strike kills form 1.
    s = advance(s, { cmd: "usePotion", slot: 0 }, act3);
    expect(ao(s).halfDead).toBe(true);
    expect(() => assertInvariants(s)).not.toThrow();
    expect(pileNames(s, "discard")).toEqual(["HAVOC"]);
    expect(pileNames(s, "exhaust")).toEqual(["STRIKE_RED"]);
    expect(pileNames(s, "draw").length).toBe(6);
    expect(s.combat!.player.piles.limbo).toEqual([]);
    expect(Object.keys(s.combat!.cards).length).toBe(8);
  });

  test("Omniscience: a pick still in draw when its own play kills form 1 is lost with the queue", () => {
    let s = aoAlone([{ defId: "OMNISCIENCE", upgrades: 1 }, ...Array(5).fill({ defId: "STRIKE_RED" })]);
    arrange(s, { hand: ["OMNISCIENCE", ...strikes(4)], draw: ["STRIKE_RED"] });
    pushPower(s, "A_THOUSAND_CUTS", 5);
    const strike = s.combat!.player.piles.draw[0]!;
    s = playA(s, "OMNISCIENCE"); // queues the Strike twice, then Thousand Cuts kills form 1
    expect(ao(s).halfDead).toBe(true);
    expect(() => assertInvariants(s)).not.toThrow();
    expect(s.combat!.cards[strike]).toBeUndefined();
    expect(s.combat!.player.piles.draw).toEqual([]);
    expect(s.combat!.player.piles.limbo).toEqual([]);
    expect(pileNames(s, "exhaust")).toEqual(["OMNISCIENCE"]);
  });

  test("Omniscience: the card still resolving keeps its record when its second play is dropped", () => {
    let s = aoAlone([{ defId: "OMNISCIENCE", upgrades: 1 }, ...Array(5).fill({ defId: "STRIKE_RED" })]);
    arrange(s, { hand: ["OMNISCIENCE", ...strikes(4)], draw: ["STRIKE_RED"] });
    const strike = s.combat!.player.piles.draw[0]!;
    s = playA(s, "OMNISCIENCE"); // the lone draw card is played twice; its first play kills form 1
    expect(ao(s).halfDead).toBe(true);
    expect(() => assertInvariants(s)).not.toThrow();
    expect(s.combat!.cards[strike]).toBeDefined();
    expect(s.combat!.player.piles.limbo).toEqual([]);
  });
});
