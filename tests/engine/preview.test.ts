// Card previews: the numbers the hand prints on itself. Real Ironclad cards
// over the stub bundle, because the whole point is the live calc pipeline
// (Strength, Frail, Vulnerable-on-the-target, stance).

import { test, expect, describe } from "bun:test";
import { createCombatGame, type GameState } from "../../src/engine/game";
import type { ContentBundle } from "../../src/engine/content/defs";
import { getCardPlayability, getCardPreviews, previewCardAt } from "../../src/engine/combat/preview";
import { makeTestBundle } from "../helpers/testBundle";
import { corePowers } from "../../src/content/powers/core";
import { ironcladBasics } from "../../src/content/cards/ironclad/basics";
import { ironcladCards, ironcladPowers, ironcladEffects } from "../../src/content/cards/ironclad/index";

function makeBundle(): ContentBundle {
  const b = makeTestBundle();
  for (const p of corePowers) b.powers.set(p.id, p);
  for (const p of ironcladPowers) b.powers.set(p.id, p);
  for (const c of [...ironcladBasics, ...ironcladCards]) b.cards.set(c.id, c);
  for (const [k, v] of ironcladEffects) b.effects.set(k, v);
  return b;
}

const B = makeBundle();

function game(deck: string[], monsters = ["T_DUMMY"]): GameState {
  return createCombatGame({
    seed: "PREVIEW",
    bundle: B,
    character: "IRONCLAD",
    deck: deck.map((defId) => ({ defId })),
    monsters,
  });
}

describe("card playability previews", () => {
  test("free and X-cost cards still obey canUse; unplayable sentinel stays blocked", () => {
    const s = game(["CLASH", "DEFEND_RED"]);
    const c = s.combat!;
    const clash = c.cards[c.player.piles.hand.find(iid => c.cards[iid]!.defId === "CLASH")!]!;
    c.player.energy = 0;
    for (const cost of [0, -1, -2]) {
      clash.cost = cost;
      clash.freeToPlayOnce = true;
      expect(getCardPlayability(s, B, clash)).toEqual({ cost, playable: false });
      const hand = c.player.piles.hand;
      c.player.piles.hand = [clash.iid];
      expect(getCardPlayability(s, B, clash)).toEqual({ cost, playable: cost !== -2 });
      c.player.piles.hand = hand;
    }
    clash.cost = -1;
    clash.freeToPlayOnce = false;
    c.player.piles.hand = [clash.iid];
    expect(getCardPlayability(s, B, clash)).toEqual({ cost: -1, playable: true });
  });

  test("canUse and veto hooks share cloned card state, with no live writes or queue execution", () => {
    const b = makeBundle();
    const s = game(["STRIKE_RED"]);
    const c = s.combat!;
    const card = c.cards[c.player.piles.hand[0]!]!;
    card.upgrades = 1;
    const def = b.cards.get(card.defId)!;
    b.cards.set(card.defId, { ...def, canUse: ctx => {
      expect(ctx.card).toBe(ctx.combat!.cards[card.iid]!);
      expect(ctx.energyOnUse).toBe(c.player.energy);
      expect(ctx.upgraded).toBe(true);
      expect(ctx.target).toBe(0);
      ctx.run.gold = 0;
      ctx.card.misc++;
      ctx.combat!.player.block++;
      ctx.queue.addToBottom({ kind: "gainBlock", target: { kind: "player" }, amount: 100, fromCard: true });
      return true;
    }, onPlay: () => { throw new Error("playability must not play the card"); } });
    b.relics.set("PREVIEW_GUARD", {
      id: "PREVIEW_GUARD", name: "Preview guard", tier: "common", pool: "shared",
      hooks: { canPlayCard: (ctx, checked) => {
        expect(checked.misc).toBe(card.misc + 1);
        ctx.relicCounter!.set(7);
        return false;
      } },
    });
    s.run.relics.push({ defId: "PREVIEW_GUARD", counter: 0 });
    const before = structuredClone(s);
    expect(getCardPlayability(s, b, card)).toEqual({ cost: 1, playable: false });
    expect(s).toEqual(before);
  });

  test("guard errors, RNG and choices fail explicitly without changing state", () => {
    const b = makeBundle();
    const s = game(["STRIKE_RED"]);
    const card = s.combat!.cards[s.combat!.player.piles.hand[0]!]!;
    const def = b.cards.get(card.defId)!;
    const before = structuredClone(s);
    b.cards.set(card.defId, { ...def, canUse: ctx => {
      ctx.rng("mathUtilRng");
      return true;
    } });
    expect(() => getCardPlayability(s, b, card)).toThrow("rng not available");
    b.cards.set(card.defId, { ...def, canUse: ctx => {
      ctx.requestChoice({ request: { kind: "option", reason: "test", options: ["test"] }, resume: "test", resumeArgs: {} });
      return true;
    } });
    expect(() => getCardPlayability(s, b, card)).toThrow("choice not available");
    b.cards.set(card.defId, { ...def, canUse: () => { throw new Error("guard failed"); } });
    expect(() => getCardPlayability(s, b, card)).toThrow("guard failed");
    expect(s).toEqual(before);
  });
});

/** Preview of the hand slot holding defId (the whole deck is dealt). */
function previewOf(s: GameState, defId: string, target = 0) {
  const idx = s.combat!.player.piles.hand.findIndex((iid) => s.combat!.cards[iid]!.defId === defId);
  if (idx === -1) throw new Error(`${defId} not in hand`);
  return getCardPreviews(s, B, target)[idx] ?? null;
}

const givePower = (s: GameState, id: string, amount: number): void => {
  s.combat!.player.powers.push({ id, amount, justApplied: false, data: null });
};

describe("card previews", () => {
  test("the printed numbers when nothing is modifying them", () => {
    const s = game(["STRIKE_RED", "DEFEND_RED", "BASH", "INFLAME", "CLEAVE"]);
    expect(previewOf(s, "STRIKE_RED")).toEqual({ damage: 6, hits: 1, block: 0, partial: false });
    expect(previewOf(s, "DEFEND_RED")).toEqual({ damage: null, hits: 0, block: 5, partial: false });
    expect(previewOf(s, "BASH")).toEqual({ damage: 8, hits: 1, block: 0, partial: false });
    expect(previewOf(s, "CLEAVE")).toEqual({ damage: 8, hits: 1, block: 0, partial: false });
    expect(previewOf(s, "INFLAME")).toBeNull(); // no damage, no block: nothing to show
  });

  test("Strength raises attacks, Frail cuts block", () => {
    const s = game(["STRIKE_RED", "DEFEND_RED", "BASH", "INFLAME", "CLEAVE"]);
    givePower(s, "STRENGTH", 3);
    givePower(s, "FRAIL", 2);
    expect(previewOf(s, "STRIKE_RED")?.damage).toBe(9);
    expect(previewOf(s, "BASH")?.damage).toBe(11);
    expect(previewOf(s, "DEFEND_RED")?.block).toBe(3); // floor(5 * 0.75)
  });

  test("Weak cuts your attacks, and the preview is per target", () => {
    const s = game(["STRIKE_RED", "DEFEND_RED", "BASH", "INFLAME", "CLEAVE"], ["T_DUMMY", "T_DUMMY"]);
    givePower(s, "WEAK", 2);
    expect(previewOf(s, "STRIKE_RED")?.damage).toBe(4); // floor(6 * 0.75)
    s.combat!.monsters[1]!.powers.push({ id: "VULNERABLE", amount: 2, justApplied: false, data: null });
    expect(previewOf(s, "STRIKE_RED", 0)?.damage).toBe(4);
    expect(previewOf(s, "STRIKE_RED", 1)?.damage).toBe(6); // floor(4 * 1.5)
  });

  test("multi-hit reports per-hit damage and the hit count", () => {
    const s = game(["TWIN_STRIKE", "STRIKE_RED", "STRIKE_RED", "STRIKE_RED", "STRIKE_RED"]);
    const pv = previewOf(s, "TWIN_STRIKE");
    expect(pv?.hits).toBe(2);
    expect(pv?.damage).toBe(5);
  });

  test("a card that needs the rng previews nothing rather than lying", () => {
    const s = game(["SWORD_BOOMERANG", "STRIKE_RED", "STRIKE_RED", "STRIKE_RED", "STRIKE_RED"]);
    const pv = previewOf(s, "SWORD_BOOMERANG");
    // the random-target roll throws in the dry run: partial, no numbers claimed
    expect(pv === null || pv.partial).toBe(true);
  });

  test("previewing never touches the live state", () => {
    const s = game(["STRIKE_RED", "DEFEND_RED", "BASH", "INFLAME", "CLEAVE"]);
    const before = JSON.stringify({ run: s.run, combat: s.combat });
    getCardPreviews(s, B, 0);
    previewCardAt(s, B, s.combat!.player.piles.hand[0]!, 0);
    expect(JSON.stringify({ run: s.run, combat: s.combat })).toBe(before);
  });

  test("no combat means no previews", () => {
    const s = game(["STRIKE_RED", "DEFEND_RED", "BASH", "INFLAME", "CLEAVE"]);
    expect(getCardPreviews({ run: s.run, combat: null }, B, 0)).toEqual([]);
    expect(previewCardAt({ run: s.run, combat: null }, B, 1, 0)).toBeNull();
  });
});
