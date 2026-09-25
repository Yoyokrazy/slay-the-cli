import { test, expect, describe } from "bun:test";
import { createCombatGame, advance, type GameState } from "../../src/engine/game";
import type { CardDef, ContentBundle, EffectCtx, StanceDef } from "../../src/engine/content/defs";
import type { CardQueueItem } from "../../src/engine/combat/combatState";
import type { Stream } from "../../src/engine/core/rngRegistry";
import { RngRegistry } from "../../src/engine/core/rngRegistry";
import { ActionQueue } from "../../src/engine/core/queue";
import { queueReplayCopy, runQueue } from "../../src/engine/combat/interpreter";
import { makeTestBundle } from "../helpers/testBundle";
import { corePowers } from "../../src/content/powers/core";
import { ironcladBasics } from "../../src/content/cards/ironclad/basics";
import { ironcladCommons } from "../../src/content/cards/ironclad/common";
import { ironcladUncommons } from "../../src/content/cards/ironclad/uncommon";
import { ironcladEffects } from "../../src/content/cards/ironclad/effects";
import { allRelics, relicSupportPowers } from "../../src/content/relics";
import { allPotions, effectivePotency } from "../../src/content/potions";
import { returnRandomPotion } from "../../src/engine/run/rewards";
import { Rng } from "../../src/engine/core/rng";

// ---------------------------------------------------------------------------
// local bundle (same pattern as relics.test.ts)
// ---------------------------------------------------------------------------

const extraCards: CardDef[] = [
  {
    id: "T_JAB", name: "T Jab", color: "red", type: "attack", rarity: "common", cost: 0, target: "enemy",
    values: { damage: 3 }, upgradeValues: { damage: 5 }, keywords: [], primitives: [{ do: "damage", n: "damage" }],
  },
  {
    id: "T_CANTRIP", name: "T Cantrip", color: "red", type: "skill", rarity: "common", cost: 0, target: "self",
    values: { magic: 1 }, upgradeValues: { magic: 2 }, keywords: [], primitives: [{ do: "draw", n: "magic" }],
  },
  {
    id: "T_POWER", name: "T Power", color: "red", type: "power", rarity: "common", cost: 1, target: "self",
    values: { magic: 1 }, upgradeValues: { magic: 2 }, keywords: [],
    primitives: [{ do: "applyPower", power: "STRENGTH", n: "magic", target: "self" }],
  },
  {
    id: "T_EXHAUST_BLOCK", name: "T Exhaust Block", color: "red", type: "skill", rarity: "common", cost: 1, target: "self",
    values: { block: 4 }, upgradeValues: { block: 6 }, keywords: ["exhaust"], primitives: [{ do: "block", n: "block" }],
  },
];

const stances: StanceDef[] = [
  { id: "CALM", name: "Calm", onExit: (ctx) => ctx.queue.addToTop({ kind: "gainEnergy", n: 2 }) },
  { id: "WRATH", name: "Wrath", damageGiveMultiplier: 2, damageReceiveMultiplier: 2 },
  {
    id: "DIVINITY", name: "Divinity", damageGiveMultiplier: 3, autoExitAtEndOfTurn: true,
    onEnter: (ctx) => ctx.queue.addToTop({ kind: "gainEnergy", n: 3 }),
  },
];

function makeBundle(): ContentBundle {
  const b = makeTestBundle();
  for (const p of corePowers) b.powers.set(p.id, p);
  for (const p of relicSupportPowers) b.powers.set(p.id, p);
  for (const r of allRelics) b.relics.set(r.id, r);
  for (const p of allPotions) b.potions.set(p.id, p);
  for (const c of [...extraCards, ...ironcladBasics]) b.cards.set(c.id, c);
  for (const c of ironcladCommons.filter((c) => c.id === "PERFECTED_STRIKE" || c.id === "POMMEL_STRIKE" || c.id === "SHRUG_IT_OFF")) b.cards.set(c.id, c);
  for (const c of ironcladUncommons.filter((c) => c.id === "INFLAME")) b.cards.set(c.id, c);
  for (const [k, v] of ironcladEffects) b.effects.set(k, v); // Whirlwind resolves through an effect
  for (const s of stances) b.stances.set(s.id, s);
  return b;
}

const B = makeBundle();

function game(opts: {
  seed?: string;
  deck?: { defId: string; upgrades?: number }[];
  relics?: string[];
  hp?: number;
}): GameState {
  return createCombatGame({
    seed: opts.seed ?? "POTIONS",
    bundle: B,
    character: "IRONCLAD",
    deck: opts.deck ?? Array(12).fill({ defId: "T_STRIKE" }),
    relics: opts.relics ?? [],
    monsters: ["T_DUMMY"],
    hp: opts.hp,
    maxHp: 80,
  });
}

/** Use a potion against the live state (the run-layer use site does not exist yet). */
function effectCtx(s: GameState): { ctx: EffectCtx; registry: RngRegistry; rt: EffectCtx["rt"] } {
  const registry = RngRegistry.fromState(s.rng);
  const rt = { pending: null, currentItem: null, combatOver: null } as EffectCtx["rt"];
  const ctx: EffectCtx = {
    run: s.run,
    combat: s.combat,
    queue: new ActionQueue(),
    bundle: B,
    rt,
    rng: (st: Stream) => registry.get(st),
    asc: s.run.ascension,
    emit: () => {},
    requestChoice: (c) => {
      rt.pending = c;
    },
  };
  return { ctx, registry, rt };
}

/** Use a potion against the live state (the run-layer use site does not exist yet). */
function usePotion(s: GameState, id: string, target: number | null = null): GameState {
  const { ctx, registry, rt } = effectCtx(s);
  const def = B.potions.get(id);
  if (!def) throw new Error(`unknown potion ${id}`);
  def.onUse(ctx, target, effectivePotency(ctx, def));
  runQueue(ctx);
  s.rng = registry.saveState();
  s.pending = rt.pending;
  return s;
}

function drainQueue(s: GameState): GameState {
  const { ctx, registry, rt } = effectCtx(s);
  runQueue(ctx);
  s.rng = registry.saveState();
  s.pending = rt.pending;
  return s;
}

const handNames = (s: GameState) => s.combat!.player.piles.hand.map((i) => s.combat!.cards[i]!.defId);
const play = (s: GameState, name: string, target?: number) => {
  const idx = handNames(s).indexOf(name);
  if (idx === -1) throw new Error(`${name} not in hand: ${handNames(s)}`);
  return advance(s, { cmd: "playCard", handIdx: idx, target }, B);
};
const power = (s: GameState, id: string) => s.combat!.player.powers.find((p) => p.id === id);
const monsterHp = (s: GameState) => s.combat!.monsters[0]!.hp;
const relicCounter = (s: GameState, id: string) => s.run.relics.find((r) => r.defId === id)!.counter;

function gameWithIntent(move: string, opts: Parameters<typeof game>[0] = {}): GameState {
  for (let i = 0; i < 30; i++) {
    const s = game({ ...opts, seed: `${opts.seed ?? "PFISH"}${i}` });
    if (s.combat!.monsters[0]!.move === move) return s;
  }
  throw new Error("no seed matched intent");
}

// ---------------------------------------------------------------------------

describe("death-save potions and relics", () => {
  test("Fairy in a Bottle cannot be manually drunk", () => {
    const s = game({});
    s.run.potions[0] = "FAIRY_POTION";
    expect(() => advance(s, { cmd: "usePotion", slot: 0 }, B)).toThrow("cannot be used");
    expect(s.run.potions[0]).toBe("FAIRY_POTION");
  });

  test("Fairy in a Bottle is consumed once when lethal damage lands", () => {
    let s = gameWithIntent("ATTACK", { hp: 1 });
    s.run.potions[0] = "FAIRY_POTION";
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.outcome).toBeNull();
    expect(s.run.hp).toBe(24);
    expect(s.run.potions[0]).toBeNull();

    s.run.hp = 1;
    s.combat!.monsters[0]!.move = "ATTACK";
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.outcome).toEqual({ kind: "death" });
  });

  test("Sacred Bark doubles Fairy in a Bottle's death-save heal", () => {
    let s = gameWithIntent("ATTACK", { hp: 1, relics: ["SACRED_BARK"] });
    s.run.potions[0] = "FAIRY_POTION";
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.outcome).toBeNull();
    expect(s.run.hp).toBe(48);
    expect(s.run.potions[0]).toBeNull();
  });

  test("Fairy in a Bottle has priority over Lizard Tail", () => {
    let s = gameWithIntent("ATTACK", { hp: 1, relics: ["LIZARD_TAIL"] });
    s.run.potions[0] = "FAIRY_POTION";
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.outcome).toBeNull();
    expect(s.run.hp).toBe(24);
    expect(s.run.potions[0]).toBeNull();
    expect(relicCounter(s, "LIZARD_TAIL")).toBe(0);
  });

  test("Fairy in a Bottle heals at least 1 HP (FairyPotion.use: if(healAmt < 1) healAmt = 1)", () => {
    for (let i = 0; i < 30; i++) {
      let s = createCombatGame({
        seed: `FAIRYMIN${i}`,
        bundle: B,
        character: "IRONCLAD",
        deck: Array(12).fill({ defId: "T_STRIKE" }),
        monsters: ["T_DUMMY"],
        hp: 1,
        maxHp: 3,
      });
      if (s.combat!.monsters[0]!.move !== "ATTACK") continue;
      s.run.potions[0] = "FAIRY_POTION";
      s = advance(s, { cmd: "endTurn" }, B);
      expect(s.outcome).toBeNull();
      expect(s.run.hp).toBe(1);
      return;
    }
    throw new Error("no seed opened with ATTACK");
  });

  test("Lizard Tail death-save heals once per run", () => {
    let s = gameWithIntent("ATTACK", { hp: 1, relics: ["LIZARD_TAIL"] });
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.outcome).toBeNull();
    expect(s.run.hp).toBe(40);
    expect(relicCounter(s, "LIZARD_TAIL")).toBe(1);

    s.run.hp = 1;
    s.combat!.monsters[0]!.move = "ATTACK";
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.outcome).toEqual({ kind: "death" });
  });
});

describe("damage & block potions", () => {
  test("Fire Potion: exactly 20 to the target (no Strength/Vulnerable scaling)", () => {
    let s = game({});
    s.combat!.player.powers.push({ id: "STRENGTH", amount: 5, justApplied: false, data: null });
    const hp0 = monsterHp(s);
    s = usePotion(s, "FIRE_POTION", 0);
    expect(monsterHp(s)).toBe(Math.max(0, hp0 - 20));
  });

  test("Sacred Bark doubles Fire Potion to 40", () => {
    let s = game({ relics: ["SACRED_BARK"] });
    s = usePotion(s, "FIRE_POTION", 0);
    expect(monsterHp(s)).toBe(0); // 40 >= max monster hp (25)
    expect(s.combat!.monsters[0]!.isDead).toBe(true);
  });

  test("Explosive Potion: 10 to all enemies", () => {
    let s = game({});
    const hp0 = monsterHp(s);
    s = usePotion(s, "EXPLOSIVE_POTION");
    expect(monsterHp(s)).toBe(hp0 - 10);
  });

  test("Block Potion: 12 block, unaffected by Dexterity/Frail", () => {
    let s = game({});
    s.combat!.player.powers.push({ id: "FRAIL", amount: 2, justApplied: false, data: null });
    s = usePotion(s, "BLOCK_POTION");
    expect(s.combat!.player.block).toBe(12);
  });
});

describe("power potions", () => {
  test("Strength/Dexterity Potions: +2 each; Sacred Bark makes it +4", () => {
    let s = game({});
    s = usePotion(s, "STRENGTH_POTION");
    s = usePotion(s, "DEXTERITY_POTION");
    expect(power(s, "STRENGTH")?.amount).toBe(2);
    expect(power(s, "DEXTERITY")?.amount).toBe(2);
    let t = game({ relics: ["SACRED_BARK"] });
    t = usePotion(t, "STRENGTH_POTION");
    expect(power(t, "STRENGTH")?.amount).toBe(4);
  });

  test("Weak/Fear Potions apply 3 Weak/Vulnerable to the target", () => {
    let s = game({});
    s = usePotion(s, "WEAK_POTION", 0);
    s = usePotion(s, "FEAR_POTION", 0);
    const m = s.combat!.monsters[0]!;
    expect(m.powers.find((p) => p.id === "WEAK")?.amount).toBe(3);
    expect(m.powers.find((p) => p.id === "VULNERABLE")?.amount).toBe(3);
  });

  test("Ancient Potion: 1 Artifact", () => {
    let s = game({});
    s = usePotion(s, "ANCIENT_POTION");
    expect(power(s, "ARTIFACT")?.amount).toBe(1);
  });

  test("Essence of Steel: 4 Plated Armor", () => {
    let s = game({});
    s = usePotion(s, "ESSENCE_OF_STEEL");
    expect(power(s, "PLATED_ARMOR")?.amount).toBe(4);
  });

  test("Liquid Bronze: 3 Thorns; Heart of Iron: 6 Metallicize; Ghost in a Jar: 1 Intangible", () => {
    let s = game({});
    s = usePotion(s, "LIQUID_BRONZE");
    s = usePotion(s, "HEART_OF_IRON");
    s = usePotion(s, "GHOST_IN_A_JAR");
    expect(power(s, "THORNS")?.amount).toBe(3);
    expect(power(s, "METALLICIZE")?.amount).toBe(6);
    expect(power(s, "INTANGIBLE")?.amount).toBe(1);
  });

  test("Intangible from Ghost in a Jar clamps a 10 attack to 1", () => {
    let s = gameWithIntent("ATTACK", { hp: 60 });
    s = usePotion(s, "GHOST_IN_A_JAR");
    const hp0 = s.run.hp;
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.run.hp).toBe(hp0 - 1);
  });

  test("Flex Potion: +5 Strength now, back to 0 after the turn", () => {
    let s = game({});
    s = usePotion(s, "FLEX_POTION");
    expect(power(s, "STRENGTH")?.amount).toBe(5);
    expect(power(s, "LOSE_STRENGTH")?.amount).toBe(5);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(power(s, "STRENGTH")?.amount ?? 0).toBe(0);
    expect(power(s, "LOSE_STRENGTH")).toBeUndefined();
  });

  test("Speed Potion: +5 Dexterity now, gone after the turn", () => {
    let s = game({});
    s = usePotion(s, "SPEED_POTION");
    expect(power(s, "DEXTERITY")?.amount).toBe(5);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(power(s, "DEXTERITY")?.amount ?? 0).toBe(0);
  });

  test("Regen Potion: heals 5 at end of turn, then ticks down to 4", () => {
    let s = gameWithIntent("HARDEN", { hp: 40 });
    s = usePotion(s, "REGEN_POTION");
    expect(power(s, "REGEN")?.amount).toBe(5);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.run.hp).toBe(45);
    expect(power(s, "REGEN")?.amount).toBe(4);
  });

  test("Cultist Potion: Ritual 1 grants Strength at end of turn", () => {
    let s = game({});
    s = usePotion(s, "CULTIST_POTION");
    expect(power(s, "RITUAL")?.amount).toBe(1);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(power(s, "STRENGTH")?.amount).toBe(1);
  });

  test("Focus Potion: +2 Focus", () => {
    let s = game({});
    s = usePotion(s, "FOCUS_POTION");
    expect(power(s, "FOCUS")?.amount).toBe(2);
  });
});

describe("resource potions", () => {
  function outsideCombat(): GameState {
    const s = game({});
    s.combat = null;
    s.run.room = { kind: "map" };
    return s;
  }

  test("combat-only potions cannot be used outside combat and keep the slot", () => {
    let s = outsideCombat();
    s.run.potions[0] = "REGEN_POTION";
    expect(() => {
      s = advance(s, { cmd: "usePotion", slot: 0 }, B);
    }).toThrow("Regen Potion cannot be used here");
    expect(s.run.potions[0]).toBe("REGEN_POTION");
  });

  test("Blood Potion, Fruit Juice, and Entropic Brew work outside combat", () => {
    let blood = outsideCombat();
    blood.run.hp = 40;
    blood.run.potions[0] = "BLOOD_POTION";
    blood = advance(blood, { cmd: "usePotion", slot: 0 }, B);
    expect(blood.run.hp).toBe(56);
    expect(blood.run.potions[0]).toBeNull();

    let fruit = outsideCombat();
    fruit.run.hp = 40;
    fruit.run.potions[0] = "FRUIT_JUICE";
    fruit = advance(fruit, { cmd: "usePotion", slot: 0 }, B);
    expect(fruit.run.maxHp).toBe(85);
    expect(fruit.run.hp).toBe(45);
    expect(fruit.run.potions[0]).toBeNull();

    let entropic = outsideCombat();
    entropic.run.potions = ["ENTROPIC_BREW", null, null];
    entropic = advance(entropic, { cmd: "usePotion", slot: 0 }, B);
    expect(entropic.run.potions.some((id) => id !== null && id !== "ENTROPIC_BREW")).toBe(true);
  });

  test("combat potion use in combat still resolves queued actions", () => {
    let s = game({});
    s.run.potions[0] = "ENERGY_POTION";
    s = advance(s, { cmd: "usePotion", slot: 0 }, B);
    expect(s.combat!.player.energy).toBe(5);
    expect(s.run.potions[0]).toBeNull();
  });

  test("Toy Ornithopter heals after a choice potion resolves", () => {
    let s = game({ hp: 62, relics: ["TOY_ORNITHOPTER"] });
    s.run.potions[0] = "POWER_POTION";
    s = advance(s, { cmd: "usePotion", slot: 0 }, B);
    expect(s.pending).not.toBeNull();
    expect(s.run.hp).toBe(62);

    s = advance(s, { cmd: "choose", indices: [0] }, B);
    expect(s.pending).toBeNull();
    expect(s.run.hp).toBe(67);
  });

  test("Toy Ornithopter heals exactly once for a non-choice potion", () => {
    let s = game({ hp: 62, relics: ["TOY_ORNITHOPTER"] });
    s.run.potions[0] = "DEXTERITY_POTION";
    s = advance(s, { cmd: "usePotion", slot: 0 }, B);
    expect(power(s, "DEXTERITY")?.amount).toBe(2);
    expect(s.run.hp).toBe(67);
  });

  test("Toy Ornithopter heals immediately outside combat", () => {
    let s = outsideCombat();
    s.run.relics = [{ defId: "TOY_ORNITHOPTER", counter: 0 }];
    s.run.hp = 40;
    s.run.potions[0] = "BLOOD_POTION";
    s = advance(s, { cmd: "usePotion", slot: 0 }, B);
    expect(s.run.hp).toBe(61);
  });

  test("Energy Potion: +2 energy", () => {
    let s = game({});
    s = usePotion(s, "ENERGY_POTION");
    expect(s.combat!.player.energy).toBe(5);
  });

  test("Swift Potion: draw 3", () => {
    let s = game({});
    s = usePotion(s, "SWIFT_POTION");
    expect(s.combat!.player.piles.hand.length).toBe(8);
  });

  test("Blood Potion: heal 20% of max HP (floored)", () => {
    let s = game({ hp: 40 });
    s = usePotion(s, "BLOOD_POTION");
    expect(s.run.hp).toBe(56); // 40 + floor(80 * 0.20)
  });

  test("Fruit Juice: +5 max HP and +5 HP", () => {
    let s = game({ hp: 40 });
    s = usePotion(s, "FRUIT_JUICE");
    expect(s.run.maxHp).toBe(85);
    expect(s.run.hp).toBe(45);
  });

  test("Potion of Capacity: +2 orb slots", () => {
    let s = game({});
    s = usePotion(s, "POTION_OF_CAPACITY");
    expect(s.combat!.player.orbSlots).toBe(2); // Ironclad starts at 0
  });

  test("Snecko Oil: draw 5 and randomize hand costs into 0..3", () => {
    let s = game({});
    s = usePotion(s, "SNECKO_OIL");
    expect(s.combat!.player.piles.hand.length).toBe(10);
    for (const iid of s.combat!.player.piles.hand) {
      const c = s.combat!.cards[iid]!;
      expect(c.cost).toBeGreaterThanOrEqual(0);
      expect(c.cost).toBeLessThanOrEqual(3);
      expect(c.costForTurn).toBe(c.cost);
    }
  });
});

describe("card-manipulation potions", () => {
  test("Blessing of the Forge upgrades the whole hand for the combat", () => {
    let s = game({});
    s = usePotion(s, "BLESSING_OF_THE_FORGE");
    for (const iid of s.combat!.player.piles.hand) {
      expect(s.combat!.cards[iid]!.upgrades).toBe(1);
    }
    const hp0 = monsterHp(s);
    s = play(s, "T_STRIKE", 0);
    expect(monsterHp(s)).toBe(hp0 - 9); // upgraded T_STRIKE deals 9
  });

  test("Distilled Chaos plays the top 3 cards of the draw pile for free", () => {
    let s = game({});
    const hp0 = monsterHp(s);
    const e0 = s.combat!.player.energy;
    s = usePotion(s, "DISTILLED_CHAOS");
    expect(monsterHp(s)).toBe(Math.max(0, hp0 - 18)); // 3 strikes x 6
    expect(s.combat!.player.energy).toBe(e0);
    expect(s.combat!.player.piles.draw.length).toBe(4); // 12 - 5 hand - 3 played
  });

  test("Distilled Chaos: a short draw pile shuffles the discard back in and still plays 3", () => {
    // PlayTopCardAction: an empty draw pile queues EmptyDeckShuffleAction and
    // retries; all `potency` targets are rolled when the potion is drunk
    let s = game({});
    s.combat!.monsters[0]!.hp = 200;
    s.combat!.monsters[0]!.maxHp = 200;
    const piles = s.combat!.player.piles;
    piles.discard.push(...piles.draw.splice(1)); // 1 card left to draw
    const rolls = s.rng.floor.cardRandomRng.counter;
    s = usePotion(s, "DISTILLED_CHAOS");
    expect(monsterHp(s)).toBe(200 - 18);
    // 1 drawn, the 6-card discard shuffled in, 2 more drawn: 4 left, 3 played
    expect(s.combat!.player.piles.draw.length).toBe(4);
    expect(s.combat!.player.piles.discard.length).toBe(3);
    // 3 target rolls up front, then the reshuffle's shuffleRng (not cardRandomRng)
    expect(s.rng.floor.cardRandomRng.counter).toBe(rolls + 3);
  });

  test("Distilled Chaos rolls every target even when the piles run dry", () => {
    let s = game({});
    const piles = s.combat!.player.piles;
    piles.exhaust.push(...piles.draw.splice(1), ...piles.discard.splice(0)); // 1 card to play, no discard
    const rolls = s.rng.floor.cardRandomRng.counter;
    const hp0 = monsterHp(s);
    s = usePotion(s, "DISTILLED_CHAOS");
    expect(monsterHp(s)).toBe(hp0 - 6);
    expect(s.rng.floor.cardRandomRng.counter).toBe(rolls + 3);
  });

  test("Snecko Oil only rewrites a card whose rolled cost differs (RandomizeHandCostAction)", () => {
    let kept = 0;
    for (let i = 0; i < 8; i++) {
      let s = game({ seed: `SNECKO-SAME-${i}` });
      for (const iid of s.combat!.player.piles.hand) s.combat!.cards[iid]!.costForTurn = 0; // made free this turn
      const freeBefore = new Set(s.combat!.player.piles.hand);
      const rng = Rng.fromState(s.rng.floor.cardRandomRng);
      s = usePotion(s, "SNECKO_OIL");
      expect(s.combat!.player.piles.hand).toHaveLength(10);
      for (const iid of s.combat!.player.piles.hand) {
        const c = s.combat!.cards[iid]!;
        const rolled = rng.random(3);
        if (rolled === 1) {
          expect(c.cost).toBe(1);
          expect(c.costForTurn).toBe(freeBefore.has(iid) ? 0 : 1);
          if (freeBefore.has(iid)) kept++;
        } else {
          expect(c.cost).toBe(rolled);
          expect(c.costForTurn).toBe(rolled);
        }
      }
    }
    expect(kept).toBeGreaterThan(0); // the "same cost" branch really happened
  });

  test("Gambler's Brew discards are manual (GamblingChipAction.triggerOnManualDiscard)", () => {
    let s = game({});
    s = usePotion(s, "GAMBLERS_BREW");
    s = advance(s, { cmd: "choose", indices: [0, 1, 2] }, B);
    expect(s.combat!.turnFlags.manualDiscardsThisTurn).toBe(3);
    expect(s.combat!.player.piles.discard.length).toBe(3);
    expect(s.combat!.player.piles.hand.length).toBe(5);
  });

  test("discovery potions never offer a HEALING-tagged card", () => {
    // returnTrulyRandomCardInCombat(type): "!c.hasTag(CardTags.HEALING)"
    const healer: CardDef = {
      id: "T_HEAL_ATTACK", name: "T Heal Attack", color: "red", type: "attack", rarity: "rare", cost: 1, target: "enemy",
      values: { damage: 1 }, upgradeValues: { damage: 2 }, keywords: ["tag:healing"], primitives: [{ do: "damage", n: "damage" }],
    };
    B.cards.set(healer.id, healer);
    try {
      for (let i = 0; i < 40; i++) {
        let s = game({ seed: `DISC-HEAL-${i}` });
        s = usePotion(s, "ATTACK_POTION");
        const options = (s.pending!.request as { kind: "option"; options: string[] }).options;
        expect(options).not.toContain(healer.name);
      }
    } finally {
      B.cards.delete(healer.id);
    }
  });

  test("Distilled Chaos Perfected Strike+ uses PlayTopCardAction pile timing", () => {
    let s = game({
      deck: [
        ...Array(5).fill({ defId: "STRIKE_RED" }),
        { defId: "POMMEL_STRIKE" },
        ...Array(3).fill({ defId: "PERFECTED_STRIKE", upgrades: 1 }),
        { defId: "SHRUG_IT_OFF", upgrades: 1 },
      ],
    });
    s.combat!.monsters[0]!.hp = 200;
    s.combat!.monsters[0]!.maxHp = 200;
    s.combat!.player.powers.push({ id: "STRENGTH", amount: 2, justApplied: false, data: null });

    const perfected = Object.values(s.combat!.cards).filter((c) => c.defId === "PERFECTED_STRIKE");
    const shrug = Object.values(s.combat!.cards).find((c) => c.defId === "SHRUG_IT_OFF")!;
    const otherStrikes = Object.values(s.combat!.cards).filter(
      (c) => c.defId === "STRIKE_RED" || c.defId === "POMMEL_STRIKE",
    );
    s.combat!.player.piles.hand = [];
    s.combat!.player.piles.draw = [shrug.iid, perfected[0]!.iid, perfected[1]!.iid, perfected[2]!.iid, ...otherStrikes.map((c) => c.iid)];
    s.combat!.player.piles.discard = [];
    s.combat!.player.piles.exhaust = [];
    s.combat!.player.piles.limbo = [];

    s = usePotion(s, "DISTILLED_CHAOS");
    expect(monsterHp(s)).toBe(200 - 61);
    expect(handNames(s)).toEqual(["PERFECTED_STRIKE"]);
  });

  test("Duplication Potion: the next card is played twice, paid once", () => {
    let s = game({});
    s = usePotion(s, "DUPLICATION_POTION");
    expect(power(s, "DUPLICATION")?.amount).toBe(1);
    const hp0 = monsterHp(s);
    s = play(s, "T_STRIKE", 0);
    expect(monsterHp(s)).toBe(Math.max(0, hp0 - 12));
    expect(s.combat!.player.energy).toBe(2);
    expect(s.combat!.player.piles.discard.map((iid) => s.combat!.cards[iid]!.defId)).toEqual(["T_STRIKE"]);
    expect(s.combat!.player.piles.limbo).toEqual([]);
    expect(power(s, "DUPLICATION")).toBeUndefined();
  });

  test("Duplication Potion: powers and exhausting skills replay from purge copies", () => {
    let p = game({ deck: [{ defId: "INFLAME", upgrades: 1 }, ...Array(4).fill({ defId: "T_STRIKE" })] });
    p = usePotion(p, "DUPLICATION_POTION");
    p = play(p, "INFLAME");
    expect(power(p, "STRENGTH")?.amount).toBe(6);
    expect(p.combat!.player.piles.discard).toEqual([]);
    expect(p.combat!.player.piles.exhaust).toEqual([]);
    expect(p.combat!.player.piles.limbo).toEqual([]);

    let e = game({ deck: [{ defId: "T_EXHAUST_BLOCK" }, ...Array(4).fill({ defId: "T_STRIKE" })] });
    e = usePotion(e, "DUPLICATION_POTION");
    e = play(e, "T_EXHAUST_BLOCK");
    expect(e.combat!.player.block).toBe(8);
    expect(e.combat!.player.piles.exhaust.map((iid) => e.combat!.cards[iid]!.defId)).toEqual(["T_EXHAUST_BLOCK"]);
    expect(e.combat!.player.piles.limbo).toEqual([]);
  });

  test("Duplication Potion: X-cost copies use original energyOnUse", () => {
    let s = game({ deck: [{ defId: "WHIRLWIND" }, ...Array(4).fill({ defId: "T_STRIKE" })] });
    const hp0 = monsterHp(s);
    s = usePotion(s, "DUPLICATION_POTION");
    s = play(s, "WHIRLWIND");
    expect(monsterHp(s)).toBe(Math.max(0, hp0 - 30)); // 3 energy * 5 damage, twice
    expect(s.combat!.player.energy).toBe(0);
  });

  test("replay copies survive JSON round-trip while queued from limbo", () => {
    const s = game({ deck: [{ defId: "INFLAME", upgrades: 1 }, ...Array(4).fill({ defId: "T_STRIKE" })] });
    const iid = s.combat!.player.piles.hand.find((id) => s.combat!.cards[id]?.defId === "INFLAME");
    if (iid === undefined) throw new Error("INFLAME not in hand");
    const c = s.combat!.cards[iid]!;
    const item: CardQueueItem = {
      iid,
      target: null,
      energyOnUse: s.combat!.player.energy,
      ignoreEnergyTotal: false,
      regardlessOfCost: false,
      purgeOnUse: false,
      exhaustOnUse: false,
      autoplayed: false,
    };
    const { ctx } = effectCtx(s);
    queueReplayCopy(ctx, c, null, item, "DUPLICATION_POTION");
    const copyIid = s.combat!.cardQueue[0]!.iid!;
    expect(s.combat!.player.piles.limbo).toEqual([copyIid]);
    const restored = JSON.parse(JSON.stringify(s)) as GameState;
    const drained = drainQueue(restored);
    expect(power(drained, "STRENGTH")?.amount).toBe(3);
    expect(drained.combat!.cards[copyIid]).toBeUndefined();
    expect(drained.combat!.player.piles.limbo).toEqual([]);
  });

  test("Attack Potion: choose 1 of 3 attacks, added to hand at cost 0", () => {
    let s = game({});
    s = usePotion(s, "ATTACK_POTION");
    expect(s.pending).not.toBeNull();
    expect(s.pending!.request.kind).toBe("option");
    const options = (s.pending!.request as { kind: "option"; options: string[] }).options;
    expect(options.length).toBe(3);
    const hand0 = s.combat!.player.piles.hand.length;
    s = advance(s, { cmd: "choose", indices: [0] }, B);
    expect(s.combat!.player.piles.hand.length).toBe(hand0 + 1);
    const added = s.combat!.player.piles.hand[s.combat!.player.piles.hand.length - 1]!;
    expect(s.combat!.cards[added]!.costForTurn).toBe(0);
    expect(B.cards.get(s.combat!.cards[added]!.defId)!.type).toBe("attack");
  });

  test("Skill and Power Potions offer the right card types", () => {
    let s = game({});
    s = usePotion(s, "POWER_POTION");
    s = advance(s, { cmd: "choose", indices: [0] }, B);
    const last = s.combat!.player.piles.hand[s.combat!.player.piles.hand.length - 1]!;
    expect(B.cards.get(s.combat!.cards[last]!.defId)!.type).toBe("power");
  });

  test("Elixir exhausts the chosen cards", () => {
    let s = game({});
    s = usePotion(s, "ELIXIR_POTION");
    expect(s.pending!.request.kind).toBe("cards");
    s = advance(s, { cmd: "choose", indices: [0, 1, 2] }, B);
    expect(s.combat!.player.piles.exhaust.length).toBe(3);
    expect(s.combat!.player.piles.hand.length).toBe(2);
  });

  test("Gambler's Brew: discard chosen, draw that many", () => {
    let s = game({});
    s = usePotion(s, "GAMBLERS_BREW");
    s = advance(s, { cmd: "choose", indices: [0, 1] }, B);
    expect(s.combat!.player.piles.discard.length).toBe(2);
    expect(s.combat!.player.piles.hand.length).toBe(5);
  });

  test("Liquid Memories: a discard pile no bigger than the potency comes back whole, no screen", () => {
    // BetterDiscardPileToHandAction: "if(player.discardPile.size() <= numberOfCards && !optional)"
    let s = game({});
    s = play(s, "T_STRIKE", 0); // now in discard
    s = usePotion(s, "LIQUID_MEMORIES");
    expect(s.pending).toBeNull();
    expect(s.combat!.player.piles.discard.length).toBe(0);
    expect(s.combat!.player.piles.hand.length).toBe(5);
    const returned = s.combat!.player.piles.hand[4]!;
    expect(s.combat!.cards[returned]!.costForTurn).toBe(0);
  });

  test("Liquid Memories: a bigger discard pile asks for exactly the potency, no cancel", () => {
    let s = game({});
    s = play(s, "T_STRIKE", 0);
    s = play(s, "T_STRIKE", 0);
    s = usePotion(s, "LIQUID_MEMORIES");
    const req = s.pending!.request as { kind: string; min: number; max: number; canCancel: boolean };
    expect(req).toMatchObject({ kind: "cards", min: 1, max: 1, canCancel: false });
    s = advance(s, { cmd: "choose", indices: [1] }, B);
    expect(s.combat!.player.piles.discard.length).toBe(1);
    expect(s.combat!.player.piles.hand.length).toBe(4);
  });
});

describe("stance potions", () => {
  test("Stance Potion: Wrath is offered first, Calm second", () => {
    // StancePotion.use: stanceChoices.add(new ChooseWrath()); stanceChoices.add(new ChooseCalm())
    let s = game({});
    s = usePotion(s, "STANCE_POTION");
    expect(s.pending!.request).toMatchObject({ kind: "option", options: ["Wrath", "Calm"] });
    s = advance(s, { cmd: "choose", indices: [0] }, B);
    expect(s.combat!.player.stance).toBe("WRATH");
  });

  test("Ambrosia enters Divinity (+3 energy from onEnter)", () => {
    let s = game({});
    s = usePotion(s, "AMBROSIA");
    expect(s.combat!.player.stance).toBe("DIVINITY");
    expect(s.combat!.player.energy).toBe(6);
  });
});

describe("potency plumbing", () => {
  test("effectivePotency doubles only sacredBarkDoubles potions", () => {
    const withBark = game({ relics: ["SACRED_BARK"] });
    const registry = RngRegistry.fromState(withBark.rng);
    const ctx: EffectCtx = {
      run: withBark.run,
      combat: withBark.combat,
      queue: new ActionQueue(),
      bundle: B,
      rt: { pending: null, currentItem: null, combatOver: null },
      rng: (st: Stream) => registry.get(st),
      asc: 0,
      emit: () => {},
      requestChoice: () => {},
    };
    expect(effectivePotency(ctx, B.potions.get("FIRE_POTION")!)).toBe(40);
    expect(effectivePotency(ctx, B.potions.get("SWIFT_POTION")!)).toBe(6);
    expect(effectivePotency(ctx, B.potions.get("ELIXIR_POTION")!)).toBe(0); // not doubled
    expect(effectivePotency(ctx, B.potions.get("SMOKE_BOMB")!)).toBe(0);
  });

  test("all 42 corpus potions have defs; flagged ones are safe no-ops", () => {
    expect(allPotions.length).toBe(42);
    let s = game({});
    // RUN-LAYER / ENGINE-GAP potions must not crash or corrupt state
    for (const id of ["FAIRY_POTION"]) {
      s = usePotion(s, id);
      expect(s.pending).toBeNull();
    }
  });

  test("only real out-of-combat drinkable potions are flagged", () => {
    expect(allPotions.filter((p) => p.usableOutOfCombat).map((p) => p.id).sort()).toEqual([
      "BLOOD_POTION",
      "ENTROPIC_BREW",
      "FRUIT_JUICE",
    ]);
    expect(B.potions.get("FAIRY_POTION")!.usableOutOfCombat).toBeUndefined();
  });

  describe("Entropic Brew", () => {
    test("fills every empty combat slot, including its own consumed slot", () => {
      const s0 = game({ seed: "BREW-COMBAT" });
      s0.run.potions = ["ENTROPIC_BREW", "FIRE_POTION", null];
      const s = advance(s0, { cmd: "usePotion", slot: 0 }, B);
      expect(s.run.potions[1]).toBe("FIRE_POTION");
      expect(s.run.potions.filter((p) => p !== null)).toHaveLength(3);
      expect(s.run.potions[0]).not.toBeNull();
      expect(s.run.potions[2]).not.toBeNull();
    });

    test("works out of combat", () => {
      const s0 = game({ seed: "BREW-MAP" });
      s0.combat = null;
      s0.run.potions = ["ENTROPIC_BREW", null, "BLOCK_POTION"];
      const s = advance(s0, { cmd: "usePotion", slot: 0 }, B);
      expect(s.combat).toBeNull();
      expect(s.run.potions[2]).toBe("BLOCK_POTION");
      expect(s.run.potions.filter((p) => p !== null)).toHaveLength(3);
    });

    test("Sozu: in combat every slot still rolls, and every potion is refused", () => {
      // EntropicBrew.use queues ObtainPotionAction(returnRandomPotion(true)) per
      // slot before any Sozu check; ObtainPotionAction flashes Sozu instead
      const s0 = game({ seed: "BREW-SOZU", relics: ["SOZU"] });
      s0.run.potions = ["ENTROPIC_BREW", null, null];
      const before = s0.rng.run.potionRng.counter;
      const s = advance(s0, { cmd: "usePotion", slot: 0 }, B);
      expect(s.run.potions).toEqual([null, null, null]);
      expect(s.rng.run.potionRng.counter).toBeGreaterThanOrEqual(before + 3 * 3);
    });

    test("Sozu: out of combat nothing is rolled", () => {
      const s0 = game({ seed: "BREW-SOZU-MAP", relics: ["SOZU"] });
      s0.combat = null;
      s0.run.potions = ["ENTROPIC_BREW", null, null];
      const before = s0.rng.run.potionRng.counter;
      const s = advance(s0, { cmd: "usePotion", slot: 0 }, B);
      expect(s.run.potions).toEqual([null, null, null]);
      expect(s.rng.run.potionRng.counter).toBe(before);
    });

    test("out of combat the rolls are the plain returnRandomPotion(), not the limited one", () => {
      const s0 = game({ seed: "BREW-PLAIN" });
      s0.combat = null;
      s0.run.potions = ["ENTROPIC_BREW", null, null];
      const expected = structuredClone(s0);
      expected.run.potions = [null, null, null];
      const registry = RngRegistry.fromState(expected.rng);
      const ctx: EffectCtx = {
        run: expected.run,
        combat: null,
        queue: new ActionQueue(),
        bundle: B,
        rt: { pending: null, currentItem: null, combatOver: null },
        rng: (st: Stream) => registry.get(st),
        asc: 0,
        emit: () => {},
        requestChoice: () => {},
      };
      const rolls = [returnRandomPotion(ctx), returnRandomPotion(ctx), returnRandomPotion(ctx)];
      const s = advance(s0, { cmd: "usePotion", slot: 0 }, B);
      expect(s.run.potions).toEqual(rolls);
      expect(s.rng.run.potionRng.counter).toBe(registry.get("potionRng").counter);
    });

    test("limited random potions never produce Fruit Juice", () => {
      for (let seed = 0; seed < 60; seed++) {
        const s = game({ seed: `BREW-LIMITED-${seed}` });
        const registry = RngRegistry.fromState(s.rng);
        const ctx: EffectCtx = {
          run: s.run,
          combat: s.combat,
          queue: new ActionQueue(),
          bundle: B,
          rt: { pending: null, currentItem: null, combatOver: null },
          rng: (st: Stream) => registry.get(st),
          asc: s.run.ascension,
          emit: () => {},
          requestChoice: () => {},
        };
        for (let i = 0; i < 20; i++) expect(returnRandomPotion(ctx, { limited: true })).not.toBe("FRUIT_JUICE");
      }
    });

    test("fixed seed is deterministic", () => {
      const setup = () => {
        const s = game({ seed: "BREW-DETERMINISTIC" });
        s.run.potions = ["ENTROPIC_BREW", null, "FIRE_POTION"];
        return advance(s, { cmd: "usePotion", slot: 0 }, B);
      };
      const a = setup();
      const b = setup();
      expect(a.run.potions).toEqual(b.run.potions);
      expect(a.rng.run.potionRng).toEqual(b.rng.run.potionRng);
    });

    const potionCtx = (s: GameState): { ctx: EffectCtx; registry: RngRegistry } => {
      const registry = RngRegistry.fromState(s.rng);
      const ctx: EffectCtx = {
        run: s.run,
        combat: s.combat,
        queue: new ActionQueue(),
        bundle: B,
        rt: { pending: null, currentItem: null, combatOver: null },
        rng: (st: Stream) => registry.get(st),
        asc: s.run.ascension,
        emit: () => {},
        requestChoice: () => {},
      };
      return { ctx, registry };
    };

    test("limited rolls always redraw the first pick (spam check)", () => {
      for (let seed = 0; seed < 40; seed++) {
        const s = game({ seed: `BREW-SPAM-${seed}` });
        const { ctx, registry } = potionCtx(s);
        const rng = registry.get("potionRng");
        const before = rng.counter;
        returnRandomPotion(ctx, { limited: true });
        // rarity roll + the discarded first draw + at least one redraw
        expect(rng.counter - before).toBeGreaterThanOrEqual(3);
        const mid = rng.counter;
        returnRandomPotion(ctx);
        expect(rng.counter - mid).toBeGreaterThanOrEqual(2);
      }
    });

    test("rolls once per potion slot even when only its own slot is free", () => {
      const s0 = game({ seed: "BREW-ROLLS" });
      s0.run.potions = ["ENTROPIC_BREW", "FIRE_POTION", "BLOCK_POTION"];
      const expected = structuredClone(s0);
      expected.run.potions = [null, "FIRE_POTION", "BLOCK_POTION"];
      const { ctx, registry } = potionCtx(expected);
      const first = returnRandomPotion(ctx, { limited: true });
      returnRandomPotion(ctx, { limited: true });
      returnRandomPotion(ctx, { limited: true });

      const s = advance(s0, { cmd: "usePotion", slot: 0 }, B);
      expect(s.run.potions).toEqual([first, "FIRE_POTION", "BLOCK_POTION"]);
      expect(s.rng.run.potionRng.counter).toBe(registry.get("potionRng").counter);
    });
  });

  describe("Smoke Bomb", () => {
    const combatRoom = (roomKind: "monster" | "elite" | "boss") =>
      ({ kind: "combat", roomKind, encounterId: "T_ENC", burningElite: false }) as GameState["run"]["room"];

    test("walks out of a non-boss fight: combat ends, back to the map, no rewards", () => {
      const s0 = game({});
      s0.run.potions[0] = "SMOKE_BOMB";
      s0.run.room = combatRoom("elite");
      const gold = s0.run.gold;
      const s = advance(s0, { cmd: "usePotion", slot: 0 }, B);
      expect(s.combat).toBeNull();
      expect(s.run.room!.kind).toBe("map"); // not a rewards screen
      expect(s.run.gold).toBe(gold);
      expect(s.run.potions[0]).toBeNull();
      expect(s.outcome).toBeNull();
      expect(s.eventLog.some((e) => e.event === "combatEnded" && e.payload === "escape")).toBe(true);
    });

    test("refuses a boss fight without burning the potion", () => {
      const s0 = game({});
      s0.run.potions[0] = "SMOKE_BOMB";
      s0.run.room = combatRoom("boss");
      expect(() => advance(s0, { cmd: "usePotion", slot: 0 }, B)).toThrow("cannot be used");
      expect(s0.run.potions[0]).toBe("SMOKE_BOMB"); // still in the belt
      expect(s0.combat).not.toBeNull();
    });

    test("refuses any fight with a BOSS enemy or a Back Attack enemy, whatever the room", () => {
      // SmokeBomb.canUse: "if(m.hasPower("BackAttack")) return false; if(m.type == BOSS) return false;"
      const bossBundle: ContentBundle = { ...B, monsters: new Map(B.monsters) };
      const dummy = B.monsters.get("T_DUMMY")!;
      bossBundle.monsters.set("T_BOSS_DUMMY", { ...dummy, id: "T_BOSS_DUMMY", category: "boss" });
      const boss = createCombatGame({
        seed: "SMOKE-BOSS",
        bundle: bossBundle,
        character: "IRONCLAD",
        deck: Array(12).fill({ defId: "T_STRIKE" }),
        relics: [],
        monsters: ["T_BOSS_DUMMY"],
        maxHp: 80,
      });
      boss.run.potions[0] = "SMOKE_BOMB";
      boss.run.room = combatRoom("monster"); // e.g. Mind Bloom's boss fight in an event room
      expect(() => advance(boss, { cmd: "usePotion", slot: 0 }, bossBundle)).toThrow("cannot be used");

      const back = game({});
      back.run.potions[0] = "SMOKE_BOMB";
      back.run.room = combatRoom("elite");
      back.combat!.monsters[0]!.powers.push({ id: "BACK_ATTACK", amount: 1, justApplied: false, data: null });
      expect(() => advance(back, { cmd: "usePotion", slot: 0 }, B)).toThrow("cannot be used");
    });

    test("escaping still fires onVictory and rolls the room's gold, relic tier and potion, showing none", () => {
      // endBattle -> player.onVictory; AbstractRoom.update adds the gold,
      // dropReward() and addPotionToRewards(); openCombat(TEXT[1], true) skips
      // setupItemReward, so no card reward is rolled and nothing is claimable
      const s0 = game({ relics: ["BURNING_BLOOD"], hp: 50 });
      s0.run.potions[0] = "SMOKE_BOMB";
      s0.run.room = combatRoom("elite");
      const counters = (g: GameState) => ({
        treasure: g.rng.run.treasureRng.counter,
        relic: g.rng.run.relicRng.counter,
        potion: g.rng.run.potionRng.counter,
        card: g.rng.run.cardRng.counter,
      });
      const before = counters(s0);
      const pity = s0.run.blizzard.potionChance;
      const gold = s0.run.gold;
      const s = advance(s0, { cmd: "usePotion", slot: 0 }, B);
      expect(s.run.room!.kind).toBe("map");
      expect(s.run.hp).toBe(56); // Burning Blood
      expect(s.run.gold).toBe(gold);
      const after = counters(s);
      expect(after.treasure).toBe(before.treasure + 1);
      expect(after.relic).toBe(before.relic + 1);
      expect(after.potion).toBeGreaterThan(before.potion);
      expect(after.card).toBe(before.card);
      expect(Math.abs(s.run.blizzard.potionChance - pity)).toBe(10);
    });

    test("escaping runs Meat on the Bone before onVictory, like a won fight", () => {
      // AbstractRoom.endBattle: Meat on the Bone's onTrigger, then
      // player.onVictory (Burning Blood), so it sees the HP before that heal
      const s0 = game({ relics: ["MEAT_ON_THE_BONE", "BURNING_BLOOD"], hp: 40 });
      s0.run.potions[0] = "SMOKE_BOMB";
      s0.run.room = combatRoom("monster");
      const s = advance(s0, { cmd: "usePotion", slot: 0 }, B);
      expect(s.run.room!.kind).toBe("map");
      expect(s.run.hp).toBe(40 + 12 + 6);
    });
  });
});
