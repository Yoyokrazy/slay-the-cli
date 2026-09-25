import { test, expect, describe } from "bun:test";
import { createCombatGame, advance, type GameState } from "../../src/engine/game";
import type { CardDef, ContentBundle, EffectCtx, MonsterDef, StanceDef } from "../../src/engine/content/defs";
import type { Stream } from "../../src/engine/core/rngRegistry";
import { RngRegistry } from "../../src/engine/core/rngRegistry";
import { ActionQueue } from "../../src/engine/core/queue";
import { PLAYER, monster } from "../../src/engine/core/ids";
import { runQueue } from "../../src/engine/combat/interpreter";
import { getCardPlayability, previewCardAt } from "../../src/engine/combat/preview";
import { makeTestBundle } from "../helpers/testBundle";
import { corePowers } from "../../src/content/powers/core";
import { ironcladBasics } from "../../src/content/cards/ironclad/basics";
import { statusCards } from "../../src/content/cards/ironclad/index";
import { curseCards } from "../../src/content/cards/curses";
import { allRelics, relicSupportPowers } from "../../src/content/relics";
import { allPotions } from "../../src/content/potions";
import { obtainDeckCard } from "../../src/engine/run/deck";

// ---------------------------------------------------------------------------
// local bundle: makeTestBundle + core powers + this workstream's defs + extras
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
    id: "T_AOE_MULTI", name: "T AoE Multi", color: "red", type: "attack", rarity: "common", cost: 0, target: "allenemy",
    values: { damage: 3, hits: 2 }, upgradeValues: {}, keywords: [],
    primitives: [{ do: "damageAll", n: "damage", hits: "hits" }],
  },
  {
    id: "T_COLORLESS", name: "T Colorless", color: "colorless", type: "skill", rarity: "uncommon", cost: 1, target: "self",
    values: { block: 4 }, upgradeValues: { block: 7 }, keywords: [], primitives: [{ do: "block", n: "block" }],
  },
  {
    id: "T_CURSE", name: "T Curse", color: "curse", type: "curse", rarity: "special", cost: -2, target: "none",
    values: {}, upgradeValues: {}, keywords: [],
  },
  {
    id: "T_HEAL_POWER", name: "T Heal Power", color: "red", type: "power", rarity: "rare", cost: 1, target: "self",
    values: {}, upgradeValues: {}, keywords: ["tag:healing"],
  },
  {
    id: "T_HEAL_COLORLESS", name: "T Heal Colorless", color: "colorless", type: "skill", rarity: "uncommon", cost: 1,
    target: "self", values: {}, upgradeValues: {}, keywords: ["tag:healing"],
  },
  {
    id: "T_X_ATTACK", name: "T X Attack", color: "red", type: "attack", rarity: "common", cost: -1, target: "enemy",
    values: { damage: 4 }, upgradeValues: {}, keywords: [], primitives: [{ do: "damage", n: "damage" }],
  },
];

const tElite: MonsterDef = {
  id: "T_ELITE", name: "T Elite", category: "elite",
  hp: () => [40, 40],
  moves: { WAIT: { id: "WAIT", intent: "unknown", execute: () => {} } },
  getMove: () => "WAIT",
};

const tBoss: MonsterDef = {
  id: "T_BOSS", name: "T Boss", category: "boss",
  hp: () => [50, 50],
  moves: { WAIT: { id: "WAIT", intent: "unknown", execute: () => {} } },
  getMove: () => "WAIT",
};

/** Elite whose pre-battle setup raises its max HP (like the burning-elite buff). */
const tBuffedElite: MonsterDef = {
  id: "T_BUFFED_ELITE", name: "T Buffed Elite", category: "elite",
  hp: () => [40, 40],
  preBattle: (_ctx, m) => {
    m.maxHp += 20;
    m.hp += 20;
  },
  moves: { WAIT: { id: "WAIT", intent: "unknown", execute: () => {} } },
  getMove: () => "WAIT",
};

const tBuffedNormal: MonsterDef = { ...tBuffedElite, id: "T_BUFFED_NORMAL", name: "T Buffed Normal", category: "normal" };

/** First death is a half-death (Darkling / Awakened One style corpse). */
const tPhoenix: MonsterDef = {
  id: "T_PHOENIX", name: "T Phoenix", category: "normal",
  hp: () => [10, 10],
  moves: { WAIT: { id: "WAIT", intent: "unknown", execute: () => {} } },
  getMove: () => "WAIT",
  onDeath: (_ctx, self) => {
    if (self.data.reborn) return;
    self.data.reborn = true;
    self.isDead = false;
    self.halfDead = true;
  },
};

/** Hits for 5, then its move adds a Wound to the hand. */
const tWounder: MonsterDef = {
  id: "T_WOUNDER", name: "T Wounder", category: "normal",
  hp: () => [50, 50],
  moves: {
    HIT: {
      id: "HIT",
      intent: "attack",
      execute: (ctx, self) => {
        ctx.queue.addToBottom({ kind: "damage", target: PLAYER, info: { type: "attack", source: monster(self.idx), amount: 5 } });
        ctx.queue.addToBottom({ kind: "makeTempCard", defId: "WOUND", upgrades: 0, dest: "hand", n: 1 });
      },
    },
  },
  getMove: () => "HIT",
};

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
  for (const c of [...extraCards, ...ironcladBasics, ...statusCards]) b.cards.set(c.id, c);
  for (const c of curseCards) if (c.id === "NECRONOMICURSE" || c.id === "INJURY") b.cards.set(c.id, c);
  b.monsters.set(tElite.id, tElite);
  b.monsters.set(tBoss.id, tBoss);
  for (const m of [tBuffedElite, tBuffedNormal, tPhoenix, tWounder]) b.monsters.set(m.id, m);
  for (const s of stances) b.stances.set(s.id, s);
  return b;
}

const B = makeBundle();

function game(opts: {
  seed?: string;
  deck: { defId: string; upgrades?: number }[];
  relics?: string[];
  monsters?: string[];
  hp?: number;
}): GameState {
  return createCombatGame({
    seed: opts.seed ?? "RELICS",
    bundle: B,
    character: "IRONCLAD",
    deck: opts.deck,
    relics: opts.relics ?? [],
    monsters: opts.monsters ?? ["T_DUMMY"],
    hp: opts.hp,
    maxHp: 80,
  });
}

const handNames = (s: GameState) => s.combat!.player.piles.hand.map((i) => s.combat!.cards[i]!.defId);
const play = (s: GameState, name: string, target?: number) => {
  const idx = handNames(s).indexOf(name);
  if (idx === -1) throw new Error(`${name} not in hand: ${handNames(s)}`);
  return advance(s, { cmd: "playCard", handIdx: idx, target }, B);
};
const power = (s: GameState, id: string) => s.combat!.player.powers.find((p) => p.id === id);
const monsterPower = (s: GameState, idx: number, id: string) =>
  s.combat!.monsters[idx]!.powers.find((p) => p.id === id);
const relicCounter = (s: GameState, id: string) => s.run.relics.find((r) => r.defId === id)!.counter;
const setRelicCounter = (s: GameState, id: string, n: number) => {
  s.run.relics.find((r) => r.defId === id)!.counter = n;
};
const monsterHp = (s: GameState, idx = 0) => s.combat!.monsters[idx]!.hp;
const previewByName = (s: GameState, name: string, target = 0) => {
  const handIdx = handNames(s).indexOf(name);
  if (handIdx === -1) throw new Error(`${name} not in hand: ${handNames(s)}`);
  const iid = s.combat!.player.piles.hand[handIdx]!;
  return previewCardAt(s, B, iid, target);
};

/** Create games with seed prefix until predicate holds on the fresh game (intent fishing). */
function gameWhere(
  opts: Parameters<typeof game>[0],
  pred: (s: GameState) => boolean,
  tries = 30,
): GameState {
  for (let i = 0; i < tries; i++) {
    const s = game({ ...opts, seed: `${opts.seed ?? "FISH"}${i}` });
    if (pred(s)) return s;
  }
  throw new Error("no seed matched predicate");
}

const intends = (move: string) => (s: GameState) => s.combat!.monsters[0]!.move === move;

/** Build a bare EffectCtx over a game state for direct-hook unit checks. */
function makeCtx(s: GameState) {
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
  return ctx;
}

const jabs = (n: number) => Array(n).fill({ defId: "T_JAB" });
const strikes = (n: number) => Array(n).fill({ defId: "T_STRIKE" });

function triggerPenNibBattleStart(s: GameState): GameState {
  const ctx = makeCtx(s);
  const relic = s.run.relics.find((r) => r.defId === "PEN_NIB")!;
  const def = B.relics.get("PEN_NIB")!;
  def.hooks.atBattleStart?.({
    ...ctx,
    owner: PLAYER,
    relicCounter: { get: () => relic.counter, set: (n: number) => (relic.counter = n) },
  });
  runQueue(ctx);
  return s;
}
const defends = (n: number) => Array(n).fill({ defId: "T_DEFEND" });

// ---------------------------------------------------------------------------

describe("starter relics", () => {
  test("Burning Blood heals exactly 6 on victory", () => {
    let s = game({ deck: jabs(7), relics: ["BURNING_BLOOD"], hp: 50 });
    let guard = 0;
    let hpBefore = s.run.hp;
    while (!s.combat!.monsters[0]!.isDead && guard++ < 40) {
      if (handNames(s).includes("T_JAB")) {
        hpBefore = s.run.hp;
        s = play(s, "T_JAB", 0);
      } else {
        s = advance(s, { cmd: "endTurn" }, B);
      }
    }
    expect(s.combat!.monsters[0]!.isDead).toBe(true);
    expect(s.run.hp).toBe(hpBefore + 6);
  });

  test("Ring of the Snake: +2 draw on the first turn only", () => {
    let s = game({ deck: strikes(12), relics: ["RING_OF_THE_SNAKE"] });
    expect(s.combat!.player.piles.hand.length).toBe(7);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.piles.hand.length).toBe(5);
  });
});

describe("battle-start relics", () => {
  test("Anchor: 10 block at combat start", () => {
    const s = game({ deck: strikes(5), relics: ["ANCHOR"] });
    expect(s.combat!.player.block).toBe(10);
  });

  test("Blood Vial heals 2 at combat start", () => {
    const s = game({ deck: strikes(5), relics: ["BLOOD_VIAL"], hp: 50 });
    expect(s.run.hp).toBe(52);
  });

  test("Akabeko: first attack +8 (Vigor), consumed after one attack", () => {
    let s = game({ deck: strikes(6), relics: ["AKABEKO"] });
    expect(power(s, "VIGOR")?.amount).toBe(8);
    const hp0 = s.combat!.monsters[0]!.hp;
    s = play(s, "T_STRIKE", 0);
    expect(s.combat!.monsters[0]!.hp).toBe(hp0 - 14);
    expect(power(s, "VIGOR")).toBeUndefined();
    const hp1 = s.combat!.monsters[0]!.hp;
    s = play(s, "T_STRIKE", 0);
    expect(s.combat!.monsters[0]!.hp).toBe(hp1 - 6);
  });

  test("Bag of Marbles: 1 Vulnerable on all enemies (strike hits 9)", () => {
    let s = game({ deck: strikes(6), relics: ["BAG_OF_MARBLES"] });
    expect(monsterPower(s, 0, "VULNERABLE")?.amount).toBe(1);
    const hp0 = s.combat!.monsters[0]!.hp;
    s = play(s, "T_STRIKE", 0);
    expect(s.combat!.monsters[0]!.hp).toBe(hp0 - 9); // floor(6 * 1.5)
  });

  test("Bag of Preparation: 7-card opening hand", () => {
    const s = game({ deck: strikes(12), relics: ["BAG_OF_PREPARATION"] });
    expect(s.combat!.player.piles.hand.length).toBe(7);
  });

  test("Bronze Scales: attacker takes exactly 3", () => {
    let s = gameWhere({ deck: strikes(12), relics: ["BRONZE_SCALES"] }, intends("ATTACK"));
    const mhp = s.combat!.monsters[0]!.hp;
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.monsters[0]!.hp).toBe(mhp - 3);
  });

  test("Vajra: strike deals 7; Oddly Smooth Stone: defend gives 6", () => {
    let s = game({ deck: [...strikes(3), ...defends(3)], relics: ["VAJRA", "ODDLY_SMOOTH_STONE"] });
    const hp0 = s.combat!.monsters[0]!.hp;
    while (!handNames(s).includes("T_STRIKE") || !handNames(s).includes("T_DEFEND")) {
      s = advance(s, { cmd: "endTurn" }, B);
    }
    s = play(s, "T_STRIKE", 0);
    expect(s.combat!.monsters[0]!.hp).toBe(hp0 - 7);
    s = play(s, "T_DEFEND");
    expect(s.combat!.player.block).toBe(6);
  });

  test("Clockwork Souvenir: Artifact 1 negates the first debuff", () => {
    const s = game({ deck: strikes(5), relics: ["CLOCKWORK_SOUVENIR", "GREMLIN_VISAGE"] });
    // Gremlin Visage's Weak is negated by the Artifact (obtain order: souvenir first)
    expect(power(s, "WEAK")).toBeUndefined();
    expect(power(s, "ARTIFACT")).toBeUndefined(); // consumed
  });

  test("Gremlin Visage alone: start combat with 1 Weak", () => {
    const s = game({ deck: strikes(5), relics: ["GREMLIN_VISAGE"] });
    expect(power(s, "WEAK")?.amount).toBe(1);
  });

  test("Du-Vu Doll: +1 Strength per curse in deck", () => {
    const s = game({ deck: [...strikes(5), { defId: "T_CURSE" }, { defId: "T_CURSE" }], relics: ["DU_VU_DOLL"] });
    expect(power(s, "STRENGTH")?.amount).toBe(2);
  });

  test("Philosopher's Stone: all enemies start with 1 Strength", () => {
    const s = game({ deck: strikes(5), relics: ["PHILOSOPHERS_STONE"], monsters: ["T_DUMMY", "T_DUMMY"] });
    expect(monsterPower(s, 0, "STRENGTH")?.amount).toBe(1);
    expect(monsterPower(s, 1, "STRENGTH")?.amount).toBe(1);
  });

  test("Preserved Insect: elites spawn at 75% HP (floor)", () => {
    const s = game({ deck: strikes(5), relics: ["PRESERVED_INSECT"], monsters: ["T_ELITE"] });
    const m = s.combat!.monsters[0]!;
    expect(m.maxHp).toBe(40);
    expect(m.hp).toBe(30);
  });

  test("Pantograph heals 25 in boss combats only", () => {
    const boss = game({ deck: strikes(5), relics: ["PANTOGRAPH"], monsters: ["T_BOSS"], hp: 40 });
    expect(boss.run.hp).toBe(65);
    const normal = game({ deck: strikes(5), relics: ["PANTOGRAPH"], hp: 40 });
    expect(normal.run.hp).toBe(40);
  });

  test("Sling of Courage: +2 Strength in elite combats only", () => {
    const elite = game({ deck: strikes(5), relics: ["SLING_OF_COURAGE"], monsters: ["T_ELITE"] });
    expect(power(elite, "STRENGTH")?.amount).toBe(2);
    const normal = game({ deck: strikes(5), relics: ["SLING_OF_COURAGE"] });
    expect(power(normal, "STRENGTH")).toBeUndefined();
  });

  test("Thread and Needle: 4 Plated Armor that decays on unblocked hits", () => {
    let s = gameWhere({ deck: strikes(12), relics: ["THREAD_AND_NEEDLE"] }, intends("ATTACK"));
    expect(power(s, "PLATED_ARMOR")?.amount).toBe(4);
    const hp0 = s.run.hp;
    s = advance(s, { cmd: "endTurn" }, B);
    // end of turn: +4 block, attack 10 -> 6 unblocked, plated armor 4 -> 3
    expect(s.run.hp).toBe(hp0 - 6);
    expect(power(s, "PLATED_ARMOR")?.amount).toBe(3);
  });

  test("Mutagenic Strength: +3 Strength, gone after the first turn", () => {
    let s = game({ deck: strikes(12), relics: ["MUTAGENIC_STRENGTH"] });
    expect(power(s, "STRENGTH")?.amount).toBe(3);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(power(s, "STRENGTH")?.amount ?? 0).toBe(0);
    expect(power(s, "LOSE_STRENGTH")).toBeUndefined();
  });
});

describe("turn-structure relics", () => {
  test("Lantern: energy 4 on turn 1 only", () => {
    let s = game({ deck: strikes(12), relics: ["LANTERN"] });
    expect(s.combat!.player.energy).toBe(4);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.energy).toBe(3);
  });

  test("Happy Flower: +1 energy every 3rd turn, counter resets", () => {
    let s = game({ deck: strikes(12), relics: ["HAPPY_FLOWER"] });
    expect(s.combat!.player.energy).toBe(3);
    expect(relicCounter(s, "HAPPY_FLOWER")).toBe(1);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.energy).toBe(3);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.energy).toBe(4);
    expect(relicCounter(s, "HAPPY_FLOWER")).toBe(0);
  });

  test("Art of War: +1 energy after an attack-free turn only", () => {
    let s = game({ deck: strikes(12), relics: ["ART_OF_WAR"] });
    s = advance(s, { cmd: "endTurn" }, B); // no attacks on turn 1
    expect(s.combat!.player.energy).toBe(4);
    s = play(s, "T_STRIKE", 0);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.energy).toBe(3);
  });

  test("Horn Cleat and Captain's Wheel: block on turns 2 and 3 exactly", () => {
    let s = game({ deck: strikes(12), relics: ["HORN_CLEAT", "CAPTAINS_WHEEL"] });
    expect(s.combat!.player.block).toBe(0);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.block).toBe(14);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.block).toBe(18);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.block).toBe(0);
  });

  test("Mercury Hourglass: 3 damage to all enemies at each turn start", () => {
    let s = game({ deck: strikes(12), relics: ["MERCURY_HOURGLASS"], monsters: ["T_DUMMY", "T_DUMMY"] });
    const m0 = s.combat!.monsters[0]!;
    expect(m0.hp).toBe(m0.maxHp - 3);
    expect(s.combat!.monsters[1]!.hp).toBe(s.combat!.monsters[1]!.maxHp - 3);
  });

  test("Ice Cream: unspent energy carries over", () => {
    let s = game({ deck: strikes(12), relics: ["ICE_CREAM"] });
    s = play(s, "T_STRIKE", 0); // 3 -> 2
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.energy).toBe(5);
  });

  test("Runic Pyramid: hand is retained at end of turn", () => {
    let s = game({ deck: strikes(12), relics: ["RUNIC_PYRAMID"] });
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.piles.hand.length).toBe(10); // 5 kept + 5 drawn
  });

  // BattleContext::discardAtEndOfTurn skips the DISCARD for Runic Pyramid, then
  // runs its ethereal loop anyway: a kept hand still burns its Ethereal cards.
  test("Runic Pyramid keeps the hand but Ethereal cards still exhaust", () => {
    // a 5-card deck lands entirely in the opening hand, Dazed included
    let s = game({ deck: [...strikes(4), { defId: "DAZED" }], relics: ["RUNIC_PYRAMID"] });
    expect(handNames(s)).toContain("DAZED");
    s = advance(s, { cmd: "endTurn" }, B);
    expect(handNames(s)).not.toContain("DAZED"); // ethereal burns out of a kept hand
    expect(s.combat!.player.piles.exhaust.length).toBe(1);
    expect(handNames(s)).toEqual(["T_STRIKE", "T_STRIKE", "T_STRIKE", "T_STRIKE"]); // the rest stayed
  });

  test("Snecko Eye: draw 7 and start Confused (costs land in 0..3)", () => {
    const s = game({ deck: strikes(12), relics: ["SNECKO_EYE"] });
    expect(s.combat!.player.piles.hand.length).toBe(7);
    expect(power(s, "CONFUSED")).toBeDefined();
    for (const iid of s.combat!.player.piles.hand) {
      const c = s.combat!.cards[iid]!;
      expect(c.cost).toBeGreaterThanOrEqual(0);
      expect(c.cost).toBeLessThanOrEqual(3);
    }
  });

  test("Ring of the Serpent: +1 draw every turn", () => {
    let s = game({ deck: strikes(12), relics: ["RING_OF_THE_SERPENT"] });
    expect(s.combat!.player.piles.hand.length).toBe(6);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.piles.hand.length).toBe(6);
  });

  test("Calipers: keep block minus 15 across turns", () => {
    let s = gameWhere({ deck: defends(12), relics: ["ANCHOR", "CALIPERS"] }, intends("HARDEN"));
    s = play(s, "T_DEFEND");
    s = play(s, "T_DEFEND");
    expect(s.combat!.player.block).toBe(20); // anchor 10 + 2x5
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.block).toBe(5); // 20 - 15
  });

  test("Orichalcum: 6 block when ending the turn with none", () => {
    let s = gameWhere({ deck: strikes(12), relics: ["ORICHALCUM"] }, intends("ATTACK"));
    const hp0 = s.run.hp;
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.run.hp).toBe(hp0 - 4); // 10 attack - 6 orichalcum block
  });

  test("Stone Calendar: 52 damage to all at the end of turn 7", () => {
    let s = game({ deck: strikes(12), relics: ["STONE_CALENDAR"], hp: 80 });
    for (let t = 0; t < 7; t++) s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.monsters[0]!.isDead).toBe(true); // <=25 hp vs 52
  });

  test("Pocketwatch: 3 or fewer plays -> +3 draw next turn, else normal", () => {
    let s = game({ deck: Array(15).fill({ defId: "T_CANTRIP" }), relics: ["POCKETWATCH"] });
    s = advance(s, { cmd: "endTurn" }, B); // played 0 <= 3
    expect(s.combat!.player.piles.hand.length).toBe(8);
    for (let i = 0; i < 4; i++) s = play(s, "T_CANTRIP"); // 4 plays > 3
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.piles.hand.length).toBe(5);
  });

  test("Incense Burner: Intangible 1 on the 6th turn", () => {
    let s = game({ deck: strikes(12), relics: ["INCENSE_BURNER"], hp: 80 });
    setRelicCounter(s, "INCENSE_BURNER", 5);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(power(s, "INTANGIBLE")?.amount).toBe(1);
    expect(relicCounter(s, "INCENSE_BURNER")).toBe(0);
  });
});

describe("attack/skill pity counters", () => {
  test("Kunai + Shuriken + Ornamental Fan trigger on exactly the 3rd attack", () => {
    let s = game({ deck: jabs(12), relics: ["KUNAI", "SHURIKEN", "ORNAMENTAL_FAN"] });
    s = play(s, "T_JAB", 0);
    s = play(s, "T_JAB", 0);
    expect(power(s, "DEXTERITY")).toBeUndefined();
    s = play(s, "T_JAB", 0);
    expect(power(s, "DEXTERITY")?.amount).toBe(1);
    expect(power(s, "STRENGTH")?.amount).toBe(1);
    expect(s.combat!.player.block).toBe(4);
  });

  test("per-turn counters reset at start of turn", () => {
    let s = game({ deck: jabs(12), relics: ["KUNAI"] });
    s = play(s, "T_JAB", 0);
    s = play(s, "T_JAB", 0);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(relicCounter(s, "KUNAI")).toBe(0);
    s = play(s, "T_JAB", 0);
    expect(power(s, "DEXTERITY")).toBeUndefined(); // 1/3 this turn, not 3/3
  });

  test("Letter Opener: 3 skills deal 5 to all enemies", () => {
    let s = game({ deck: Array(12).fill({ defId: "T_CANTRIP" }), relics: ["LETTER_OPENER"] });
    const mhp = s.combat!.monsters[0]!.hp;
    s = play(s, "T_CANTRIP");
    s = play(s, "T_CANTRIP");
    expect(s.combat!.monsters[0]!.hp).toBe(mhp);
    s = play(s, "T_CANTRIP");
    expect(s.combat!.monsters[0]!.hp).toBe(mhp - 5);
  });

  test("Nunchaku: 10th attack grants 1 energy, counter wraps", () => {
    let s = game({ deck: jabs(12), relics: ["NUNCHAKU"] });
    setRelicCounter(s, "NUNCHAKU", 9);
    s = play(s, "T_JAB", 0); // 0-cost: energy stays 3, +1 from nunchaku
    expect(s.combat!.player.energy).toBe(4);
    expect(relicCounter(s, "NUNCHAKU")).toBe(0);
  });

  test("Pen Nib: exactly the 10th attack is doubled and counter wraps", () => {
    let s = gameWhere(
      { deck: [{ defId: "T_JAB" }, ...strikes(11)], relics: ["PEN_NIB"] },
      (state) => handNames(state).includes("T_JAB") && handNames(state).includes("T_STRIKE"),
    );
    setRelicCounter(s, "PEN_NIB", 8);
    s = play(s, "T_JAB", 0);
    expect(relicCounter(s, "PEN_NIB")).toBe(9);
    expect(power(s, "PEN_NIB")?.amount).toBe(1);
    expect(previewByName(s, "T_STRIKE")?.damage).toBe(12);
    const hp0 = s.combat!.monsters[0]!.hp;
    s = play(s, "T_STRIKE", 0);
    expect(s.combat!.monsters[0]!.hp).toBe(hp0 - 12);
    expect(relicCounter(s, "PEN_NIB")).toBe(0);
    expect(power(s, "PEN_NIB")).toBeUndefined();
    const hp1 = s.combat!.monsters[0]!.hp;
    s = play(s, "T_STRIKE", 0);
    expect(s.combat!.monsters[0]!.hp).toBe(hp1 - 6); // back to normal
    expect(relicCounter(s, "PEN_NIB")).toBe(1);
  });

  test("Pen Nib: doubles after Strength and target Vulnerable", () => {
    let s = gameWhere(
      { deck: [{ defId: "T_JAB" }, ...strikes(11)], relics: ["PEN_NIB"], monsters: ["T_BOSS"] },
      (state) => handNames(state).includes("T_JAB") && handNames(state).includes("T_STRIKE"),
    );
    s.combat!.player.powers.push({ id: "STRENGTH", amount: 5, justApplied: false, data: null });
    s.combat!.monsters[0]!.powers.push({ id: "VULNERABLE", amount: 1, justApplied: false, data: null });
    setRelicCounter(s, "PEN_NIB", 8);
    s = play(s, "T_JAB", 0);
    expect(previewByName(s, "T_STRIKE")?.damage).toBe(33);
    const hp0 = monsterHp(s);
    s = play(s, "T_STRIKE", 0);
    expect(monsterHp(s)).toBe(hp0 - 33);
  });

  test("Pen Nib: Strength gained after arming still folds before the double", () => {
    let s = gameWhere(
      { deck: [{ defId: "T_JAB" }, { defId: "T_POWER" }, ...strikes(10)], relics: ["PEN_NIB"], monsters: ["T_BOSS"] },
      (state) =>
        handNames(state).includes("T_JAB") &&
        handNames(state).includes("T_POWER") &&
        handNames(state).includes("T_STRIKE"),
    );
    setRelicCounter(s, "PEN_NIB", 8);
    s = play(s, "T_JAB", 0);
    s = play(s, "T_POWER");
    expect(power(s, "STRENGTH")?.amount).toBe(1);
    expect(power(s, "PEN_NIB")?.amount).toBe(1);
    expect(s.combat!.player.powers.map((p) => p.id)).toEqual(["STRENGTH", "PEN_NIB"]);
    expect(previewByName(s, "T_STRIKE")?.damage).toBe(14);
    const hp0 = monsterHp(s);
    s = play(s, "T_STRIKE", 0);
    expect(monsterHp(s)).toBe(hp0 - 14);
  });

  test("Pen Nib: doubles every hit against every target", () => {
    let s = gameWhere(
      {
        deck: [{ defId: "T_JAB" }, { defId: "T_AOE_MULTI" }, ...jabs(10)],
        relics: ["PEN_NIB"],
        monsters: ["T_BOSS", "T_BOSS"],
      },
      (state) => handNames(state).includes("T_JAB") && handNames(state).includes("T_AOE_MULTI"),
    );
    setRelicCounter(s, "PEN_NIB", 8);
    s = play(s, "T_JAB", 0);
    expect(previewByName(s, "T_AOE_MULTI")).toMatchObject({ damage: 6, hits: 2 });
    const hp0 = s.combat!.monsters.map((m) => m.hp);
    s = play(s, "T_AOE_MULTI");
    expect(s.combat!.monsters.map((m) => m.hp)).toEqual([hp0[0]! - 12, hp0[1]! - 12]);
    expect(relicCounter(s, "PEN_NIB")).toBe(0);
  });

  test("Pen Nib: combat start re-arms when persistent counter is 9", () => {
    let s = gameWhere(
      { deck: strikes(12), relics: ["PEN_NIB"], monsters: ["T_BOSS"] },
      (state) => handNames(state).includes("T_STRIKE"),
    );
    setRelicCounter(s, "PEN_NIB", 9);
    s = triggerPenNibBattleStart(s);
    expect(power(s, "PEN_NIB")?.amount).toBe(1);
    expect(previewByName(s, "T_STRIKE")?.damage).toBe(12);
    const hp0 = monsterHp(s);
    s = play(s, "T_STRIKE", 0);
    expect(monsterHp(s)).toBe(hp0 - 12);
    expect(relicCounter(s, "PEN_NIB")).toBe(0);
    expect(power(s, "PEN_NIB")).toBeUndefined();
  });

  test("Ink Bottle: draws 1 on every 10th card", () => {
    let s = game({ deck: jabs(12), relics: ["INK_BOTTLE"] });
    setRelicCounter(s, "INK_BOTTLE", 9);
    const hand0 = s.combat!.player.piles.hand.length;
    s = play(s, "T_JAB", 0);
    expect(s.combat!.player.piles.hand.length).toBe(hand0); // -1 played +1 drawn
    expect(relicCounter(s, "INK_BOTTLE")).toBe(0);
  });

  // github.com/anthonykrivonos/slay-the-cli/issues/16: the pickup half of the
  // bottles never ran, so this hook had nothing flagged to find.
  for (const [relic, type, card] of [
    ["BOTTLED_FLAME", "attack", "T_JAB"],
    ["BOTTLED_LIGHTNING", "skill", "T_CANTRIP"],
    ["BOTTLED_TORNADO", "power", "T_POWER"],
  ] as const) {
    test(`${relic}: the bottled ${type} opens the fight in hand`, () => {
      const deck = [...jabs(11), { defId: card, bottled: true }];
      const s = game({ seed: "BOTTLE", deck, relics: [relic] });
      expect(handNames(s)).toContain(card);
    });
  }

  test("a bottle only reaches for its own card type", () => {
    // both are flagged, only the Power is Bottled Tornado's, and the Skill is
    // left to the shuffle (this seed leaves it in the draw pile)
    const deck = [...jabs(10), { defId: "T_CANTRIP", bottled: true }, { defId: "T_POWER", bottled: true }];
    const s = game({ seed: "B1", deck, relics: ["BOTTLED_TORNADO"] });
    expect(handNames(s)).toContain("T_POWER");
    expect(handNames(s)).not.toContain("T_CANTRIP");
  });
});

describe("damage-pipeline relics", () => {
  test("Torii clamps 5 unblocked to 1, but not 6", () => {
    // 5 unblocked: defend (5 block) vs ATTACK 10
    let s = gameWhere({ deck: defends(12), relics: ["TORII"], hp: 60 }, intends("ATTACK"));
    let hp0 = s.run.hp;
    s = play(s, "T_DEFEND");
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.run.hp).toBe(hp0 - 1);

    // 6 unblocked: -1 Dexterity makes defend give 4 block
    s = gameWhere({ deck: defends(12), relics: ["TORII"], hp: 60, seed: "TORII6" }, intends("ATTACK"));
    s.combat!.player.powers.push({ id: "DEXTERITY", amount: -1, justApplied: false, data: null });
    hp0 = s.run.hp;
    s = play(s, "T_DEFEND");
    expect(s.combat!.player.block).toBe(4);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.run.hp).toBe(hp0 - 6);
  });

  test("Tungsten Rod: lose 1 less HP, stacks after block", () => {
    let s = gameWhere({ deck: defends(12), relics: ["TUNGSTEN_ROD"], hp: 60 }, intends("ATTACK"));
    let hp0 = s.run.hp;
    s = advance(s, { cmd: "endTurn" }, B); // 10 unblocked -> 9
    expect(s.run.hp).toBe(hp0 - 9);
    s = gameWhere({ deck: defends(12), relics: ["TUNGSTEN_ROD"], hp: 60, seed: "ROD2" }, intends("ATTACK"));
    hp0 = s.run.hp;
    s = play(s, "T_DEFEND"); // 5 block -> 5 unblocked -> 4
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.run.hp).toBe(hp0 - 4);
  });

  test("Torii then Tungsten Rod: 5 unblocked -> 1 -> 0", () => {
    let s = gameWhere({ deck: defends(12), relics: ["TORII", "TUNGSTEN_ROD"], hp: 60 }, intends("ATTACK"));
    const hp0 = s.run.hp;
    s = play(s, "T_DEFEND");
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.run.hp).toBe(hp0);
  });

  test("Intangible caps damage before block absorbs it", () => {
    const s = game({ deck: defends(5), hp: 60 });
    s.combat!.player.block = 10;
    s.combat!.player.powers.push({ id: "INTANGIBLE", amount: 1, justApplied: false, data: null });
    const ctx = makeCtx(s);
    ctx.queue.addToBottom({ kind: "damage", target: PLAYER, info: { type: "attack", source: monster(0), amount: 50 } });
    runQueue(ctx);
    expect(s.run.hp).toBe(60);
    expect(s.combat!.player.block).toBe(9);
  });

  test("Intangible caps before Torii and Tungsten Rod", () => {
    const s = game({ deck: defends(5), relics: ["TORII", "TUNGSTEN_ROD"], hp: 60 });
    s.combat!.player.powers.push({ id: "INTANGIBLE", amount: 1, justApplied: false, data: null });
    const ctx = makeCtx(s);
    ctx.queue.addToBottom({ kind: "damage", target: PLAYER, info: { type: "attack", source: monster(0), amount: 50 } });
    runQueue(ctx);
    expect(s.run.hp).toBe(60);
  });

  test("Strike Dummy: strike-keyword cards deal +3", () => {
    let s = game({ deck: Array(6).fill({ defId: "STRIKE_RED" }), relics: ["STRIKE_DUMMY"] });
    const hp0 = s.combat!.monsters[0]!.hp;
    s = play(s, "STRIKE_RED", 0);
    expect(s.combat!.monsters[0]!.hp).toBe(hp0 - 9);
  });

  test("Wrist Blade: 0-cost attacks deal +4", () => {
    let s = game({ deck: jabs(6), relics: ["WRIST_BLADE"] });
    const hp0 = s.combat!.monsters[0]!.hp;
    s = play(s, "T_JAB", 0);
    expect(s.combat!.monsters[0]!.hp).toBe(hp0 - 7);
  });

  test("Fossilized Helix prevents exactly the first HP loss", () => {
    let s = gameWhere({ deck: strikes(12), relics: ["FOSSILIZED_HELIX"], hp: 60 }, intends("ATTACK"));
    expect(power(s, "BUFFER")?.amount).toBe(1);
    const hp0 = s.run.hp;
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.run.hp).toBe(hp0);
    expect(power(s, "BUFFER")).toBeUndefined();
  });
});

describe("hp-loss and heal relics", () => {
  test("Centennial Puzzle: first HP loss draws 3 (once per combat)", () => {
    let s = gameWhere({ deck: strikes(15), relics: ["CENTENNIAL_PUZZLE"], hp: 60 }, intends("ATTACK"));
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.piles.hand.length).toBe(8); // 3 drawn during monster turn + 5
    expect(relicCounter(s, "CENTENNIAL_PUZZLE")).toBe(1);
  });

  test("Self-Forming Clay: HP loss grants 3 block next turn", () => {
    let s = gameWhere({ deck: strikes(12), relics: ["SELF_FORMING_CLAY"], hp: 60 }, intends("ATTACK"));
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.block).toBe(3);
    expect(power(s, "NEXT_TURN_BLOCK")).toBeUndefined();
  });

  test("Runic Cube: draw 1 on HP loss", () => {
    let s = gameWhere({ deck: strikes(15), relics: ["RUNIC_CUBE"], hp: 60 }, intends("ATTACK"));
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.piles.hand.length).toBe(6);
  });

  test("Meat on the Bone: +12 at victory when at or below 50%", () => {
    const kill = (s: GameState) => {
      let guard = 0;
      while (!s.combat!.monsters[0]!.isDead && guard++ < 40) {
        s = handNames(s).includes("T_JAB") ? play(s, "T_JAB", 0) : advance(s, { cmd: "endTurn" }, B);
      }
      return s;
    };
    let s = game({ deck: jabs(7), relics: ["MEAT_ON_THE_BONE"], hp: 30 });
    const hpTrack: number[] = [];
    let guard = 0;
    while (!s.combat!.monsters[0]!.isDead && guard++ < 40) {
      hpTrack.push(s.run.hp);
      s = handNames(s).includes("T_JAB") ? play(s, "T_JAB", 0) : advance(s, { cmd: "endTurn" }, B);
    }
    expect(s.run.hp).toBe(hpTrack[hpTrack.length - 1]! + 12);
    // above 50%: no heal
    let t = game({ deck: jabs(7), relics: ["MEAT_ON_THE_BONE"], hp: 80 });
    t = kill(t);
    expect(t.run.hp).toBe(80 - t.combat!.combatFlags.hpLostThisCombat);
  });

  test("Magic Flower: Burning Blood heals 9 in combat", () => {
    let s = game({ deck: jabs(7), relics: ["BURNING_BLOOD", "MAGIC_FLOWER"], hp: 40 });
    let hpBefore = s.run.hp;
    let guard = 0;
    while (!s.combat!.monsters[0]!.isDead && guard++ < 40) {
      hpBefore = s.run.hp;
      s = handNames(s).includes("T_JAB") ? play(s, "T_JAB", 0) : advance(s, { cmd: "endTurn" }, B);
    }
    expect(s.run.hp).toBe(hpBefore + 9); // floor(6 * 1.5)
  });

  test("Mark of the Bloom: no healing at all", () => {
    let s = game({ deck: jabs(7), relics: ["BURNING_BLOOD", "MARK_OF_THE_BLOOM"], hp: 40 });
    let hpBefore = s.run.hp;
    let guard = 0;
    while (!s.combat!.monsters[0]!.isDead && guard++ < 40) {
      hpBefore = s.run.hp;
      s = handNames(s).includes("T_JAB") ? play(s, "T_JAB", 0) : advance(s, { cmd: "endTurn" }, B);
    }
    expect(s.run.hp).toBe(hpBefore);
  });

  test("Red Skull: +3 Strength while at or below 50% HP", () => {
    const low = game({ deck: strikes(5), relics: ["RED_SKULL"], hp: 40 });
    expect(power(low, "STRENGTH")?.amount).toBe(3);
    const high = game({ deck: strikes(5), relics: ["RED_SKULL"], hp: 41 });
    expect(power(high, "STRENGTH")).toBeUndefined();
  });
});

describe("card-lifecycle relics", () => {
  test("Charon's Ashes: exhausting deals 3 to all enemies", () => {
    let s = game({ deck: [{ defId: "T_EXHAUST_DRAW" }, ...strikes(6)], relics: ["CHARONS_ASHES"] });
    while (!handNames(s).includes("T_EXHAUST_DRAW")) s = advance(s, { cmd: "endTurn" }, B);
    const mhp = s.combat!.monsters[0]!.hp;
    s = play(s, "T_EXHAUST_DRAW");
    expect(s.combat!.monsters[0]!.hp).toBe(mhp - 3);
  });

  test("Dead Branch: exhausting adds a random class card to hand", () => {
    let s = game({ deck: [{ defId: "T_EXHAUST_DRAW" }, ...strikes(6)], relics: ["DEAD_BRANCH"] });
    while (!handNames(s).includes("T_EXHAUST_DRAW")) s = advance(s, { cmd: "endTurn" }, B);
    const hand0 = s.combat!.player.piles.hand.length;
    s = play(s, "T_EXHAUST_DRAW");
    // -1 played, +2 drawn by the card, +1 from Dead Branch
    expect(s.combat!.player.piles.hand.length).toBe(hand0 + 2);
  });

  test("Bird-Faced Urn: playing a power heals 2", () => {
    let s = game({ deck: [{ defId: "T_POWER" }, ...strikes(6)], relics: ["BIRD_FACED_URN"], hp: 50 });
    while (!handNames(s).includes("T_POWER")) s = advance(s, { cmd: "endTurn" }, B);
    const hp0 = s.run.hp;
    s = play(s, "T_POWER");
    expect(s.run.hp).toBe(hp0 + 2);
  });

  test("Mummified Hand: playing a power makes one hand card cost 0 this turn", () => {
    let s = game({ deck: [{ defId: "T_POWER" }, ...strikes(6)], relics: ["MUMMIFIED_HAND"] });
    while (!handNames(s).includes("T_POWER")) s = advance(s, { cmd: "endTurn" }, B);
    s = play(s, "T_POWER");
    const zeroed = s.combat!.player.piles.hand.filter((iid) => s.combat!.cards[iid]!.costForTurn === 0);
    expect(zeroed.length).toBe(1);
  });

  test("Mummified Hand: ignores zero-base-cost and free-to-play cards", () => {
    let s = gameWhere(
      {
        deck: [{ defId: "T_POWER" }, { defId: "T_CANTRIP" }, { defId: "T_COLORLESS" }, ...strikes(7)],
        relics: ["MUMMIFIED_HAND"],
      },
      (st) => ["T_POWER", "T_CANTRIP", "T_COLORLESS"].every((n) => handNames(st).includes(n)),
    );
    const cantrip = s.combat!.player.piles.hand
      .map((iid) => s.combat!.cards[iid]!)
      .find((c) => c.defId === "T_CANTRIP")!;
    cantrip.costForTurn = 2;
    const colorless = s.combat!.player.piles.hand
      .map((iid) => s.combat!.cards[iid]!)
      .find((c) => c.defId === "T_COLORLESS")!;
    colorless.freeToPlayOnce = true;
    s = play(s, "T_POWER");
    expect(cantrip.costForTurn).toBe(2);
    expect(colorless.costForTurn).toBe(1);
  });

  test("Gremlin Horn: enemy death grants 1 energy and 1 draw", () => {
    let s = game({ deck: jabs(12), relics: ["GREMLIN_HORN"], monsters: ["T_DUMMY", "T_DUMMY"] });
    let guard = 0;
    while (!s.combat!.monsters[0]!.isDead && guard++ < 60) {
      if (handNames(s).includes("T_JAB")) {
        const e0 = s.combat!.player.energy;
        s = play(s, "T_JAB", 0);
        if (s.combat!.monsters[0]!.isDead) {
          expect(s.combat!.player.energy).toBe(e0 + 1);
        }
      } else {
        s = advance(s, { cmd: "endTurn" }, B);
      }
    }
    expect(s.combat!.monsters[0]!.isDead).toBe(true);
  });

  test("Velvet Choker: 7th card of a turn is vetoed", () => {
    let s = game({ deck: Array(12).fill({ defId: "T_CANTRIP" }), relics: ["VELVET_CHOKER"] });
    for (let i = 0; i < 6; i++) s = play(s, "T_CANTRIP");
    expect(relicCounter(s, "VELVET_CHOKER")).toBe(6);
    expect(() => play(s, "T_CANTRIP")).toThrow("a power or relic prevents playing this card");
    // resets next turn
    s = advance(s, { cmd: "endTurn" }, B);
    s = play(s, "T_CANTRIP");
    expect(relicCounter(s, "VELVET_CHOKER")).toBe(1);
  });

  test("Unceasing Top: draws when the hand empties during your turn", () => {
    let s = game({ deck: jabs(5), relics: ["UNCEASING_TOP"] });
    for (let i = 0; i < 5; i++) s = play(s, "T_JAB", 0);
    expect(s.combat!.player.piles.hand.length).toBe(1);
  });

  test("Orange Pellets: attack+skill+power in one turn removes debuffs", () => {
    let s = game({ deck: [{ defId: "T_JAB" }, { defId: "T_CANTRIP" }, { defId: "T_POWER" }, ...strikes(2)], relics: ["ORANGE_PELLETS"] });
    s.combat!.player.powers.push({ id: "WEAK", amount: 2, justApplied: false, data: null });
    s.combat!.player.powers.push({ id: "FRAIL", amount: 2, justApplied: false, data: null });
    s = play(s, "T_JAB", 0);
    s = play(s, "T_CANTRIP");
    expect(power(s, "WEAK")).toBeDefined();
    s = play(s, "T_POWER");
    expect(power(s, "WEAK")).toBeUndefined();
    expect(power(s, "FRAIL")).toBeUndefined();
  });

  test("Orange Pellets: resolves after the card (negative Strength is a debuff) and re-arms the same turn", () => {
    const deck = [{ defId: "T_JAB" }, { defId: "T_CANTRIP" }, { defId: "T_POWER" }];
    let s = game({ deck: [...deck, ...deck], relics: ["ORANGE_PELLETS"] });
    s.combat!.player.powers.push({ id: "STRENGTH", amount: -2, justApplied: false, data: null });
    s = play(s, "T_JAB", 0);
    s = play(s, "T_CANTRIP");
    s = play(s, "T_POWER"); // its +1 Strength lands first: -1, still a debuff, then cleared
    expect(power(s, "STRENGTH")).toBeUndefined();
    s.combat!.player.powers.push({ id: "WEAK", amount: 2, justApplied: false, data: null });
    while (!handNames(s).includes("T_JAB") || !handNames(s).includes("T_POWER")) s = play(s, "T_CANTRIP");
    s = play(s, "T_JAB", 0);
    if (handNames(s).includes("T_CANTRIP")) s = play(s, "T_CANTRIP");
    s = play(s, "T_POWER");
    expect(power(s, "WEAK")).toBeUndefined(); // second full set, same turn
  });

  test("Duality: attacks grant 1 temporary Dexterity", () => {
    let s = game({ deck: jabs(12), relics: ["DUALITY"] });
    s = play(s, "T_JAB", 0);
    expect(power(s, "DEXTERITY")?.amount).toBe(1);
    expect(power(s, "LOSE_DEXTERITY")?.amount).toBe(1);
    s = advance(s, { cmd: "endTurn" }, B);
    expect(power(s, "DEXTERITY")?.amount ?? 0).toBe(0);
  });

  test("Necronomicon: first attack costing 2+ each turn is played twice", () => {
    // Lantern for 4 energy so two Bashes fit in one turn; 40-hp elite so the
    // target survives all four resolutions.
    let s = game({ deck: Array(6).fill({ defId: "T_BASH" }), relics: ["NECRONOMICON", "LANTERN"], monsters: ["T_ELITE"] });
    const hp0 = s.combat!.monsters[0]!.hp;
    s = play(s, "T_BASH", 0);
    // first resolution: 8 damage + apply Vulnerable; duplicate recalcs: floor(8*1.5)=12
    expect(s.combat!.monsters[0]!.hp).toBe(hp0 - 8 - 12);
    expect(s.combat!.player.energy).toBe(2); // 4 - 2, paid once
    const hp1 = s.combat!.monsters[0]!.hp;
    s = play(s, "T_BASH", 0); // second 2+ attack this turn: no duplication
    expect(s.combat!.monsters[0]!.hp).toBe(hp1 - 12);
  });
});

describe("shuffle relics", () => {
  test("Sundial: 3rd reshuffle grants 2 energy", () => {
    let s = game({ deck: strikes(5), relics: ["SUNDIAL"], hp: 80 });
    s = advance(s, { cmd: "endTurn" }, B); // reshuffle 1 during turn-2 draw
    expect(relicCounter(s, "SUNDIAL")).toBe(1);
    s = advance(s, { cmd: "endTurn" }, B); // 2
    s = advance(s, { cmd: "endTurn" }, B); // 3 -> +2 energy
    expect(s.combat!.player.energy).toBe(5);
    expect(relicCounter(s, "SUNDIAL")).toBe(0);
  });

  test("The Abacus: 6 block on shuffle", () => {
    let s = game({ deck: strikes(5), relics: ["THE_ABACUS"], hp: 80 });
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.combat!.player.block).toBe(6);
  });
});

describe("choice relics", () => {
  test("Gambling Chip: discard chosen cards, draw that many", () => {
    let s = game({ deck: strikes(12), relics: ["GAMBLING_CHIP"] });
    expect(s.pending).not.toBeNull();
    expect(s.pending!.request.kind).toBe("cards");
    s = advance(s, { cmd: "choose", indices: [0, 1] }, B);
    expect(s.combat!.player.piles.hand.length).toBe(5);
    expect(s.combat!.player.piles.discard.length).toBe(2);
    expect(s.pending).toBeNull();
  });

  test("Toolbox: choose 1 of the colorless pool into hand", () => {
    let s = game({ deck: strikes(12), relics: ["TOOLBOX"] });
    expect(s.pending).not.toBeNull();
    expect(s.pending!.request.kind).toBe("option");
    s = advance(s, { cmd: "choose", indices: [0] }, B);
    expect(handNames(s)).toContain("T_COLORLESS");
  });

  test("Nilry's Codex: end of turn offers 3 distinct class cards (skippable), pick shuffles into draw", () => {
    let s = game({ deck: strikes(12), relics: ["NILRYS_CODEX"] });
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.pending).not.toBeNull();
    const req = s.pending!.request as { kind: string; options: string[]; reason: string };
    expect(req.kind).toBe("option");
    expect(req.reason).toBe("Nilry's Codex");
    expect(req.options.length).toBe(4);
    expect(req.options[3]).toBe("Skip");
    expect(new Set(req.options.slice(0, 3)).size).toBe(3);
    expect(req.options).not.toContain("T Heal Power"); // HEALING cards never generated in combat
    const drawBefore = s.combat!.player.piles.draw.length;
    s = advance(s, { cmd: "choose", indices: [0] }, B);
    expect(s.pending).toBeNull();
    expect(s.combat!.turn).toBe(2);
    const created = Object.values(s.combat!.cards).filter((c) => c.masterIdx === null);
    expect(created.length).toBe(1);
    // shuffled into the draw pile before the monster turn; turn 2 then drew 5 of those
    expect(s.combat!.player.piles.draw.length + s.combat!.player.piles.hand.length).toBe(drawBefore + 1);
    // Skip adds nothing
    let t = game({ deck: strikes(12), relics: ["NILRYS_CODEX"] });
    t = advance(t, { cmd: "endTurn" }, B);
    t = advance(t, { cmd: "choose", indices: [3] }, B);
    expect(Object.values(t.combat!.cards).filter((c) => c.masterIdx === null).length).toBe(0);
    expect(t.combat!.turn).toBe(2);
  });
});

describe("hook-side-only relics (engine call site pending)", () => {
  test("Ginger vetoes Weak on the player; Turnip vetoes Frail", () => {
    const s = game({ deck: strikes(5), relics: ["GINGER", "TURNIP"] });
    const ctx = makeCtx(s);
    const hctx = { ...ctx, owner: PLAYER, relicCounter: { get: () => 0, set: () => {} } };
    const ginger = B.relics.get("GINGER")!;
    const turnip = B.relics.get("TURNIP")!;
    expect(ginger.hooks.onApplyPower!(hctx, "WEAK", PLAYER, null)).toBe(false);
    expect(ginger.hooks.onApplyPower!(hctx, "FRAIL", PLAYER, null)).toBeUndefined();
    expect(turnip.hooks.onApplyPower!(hctx, "FRAIL", PLAYER, null)).toBe(false);
    expect(turnip.hooks.onApplyPower!(hctx, "WEAK", PLAYER, null)).toBeUndefined();
    // monster targets are not protected
    expect(ginger.hooks.onApplyPower!(hctx, "WEAK", { kind: "monster", idx: 0 }, PLAYER)).toBeUndefined();
  });

  test("Champion Belt queues 1 Weak alongside player-applied Vulnerable", () => {
    const s = game({ deck: strikes(5), relics: ["CHAMPION_BELT"] });
    const ctx = makeCtx(s);
    const hctx = { ...ctx, owner: PLAYER, relicCounter: { get: () => 0, set: () => {} } };
    const belt = B.relics.get("CHAMPION_BELT")!;
    belt.hooks.onApplyPower!(hctx, "VULNERABLE", { kind: "monster", idx: 0 }, PLAYER);
    expect(ctx.queue.size).toBe(1);
    belt.hooks.onApplyPower!(hctx, "VULNERABLE", PLAYER, { kind: "monster", idx: 0 });
    expect(ctx.queue.size).toBe(1); // monster-applied: no trigger
  });

  test("Ectoplasm zeroes gold gain; Membership Card halves prices", () => {
    const ecto = B.relics.get("ECTOPLASM")!;
    const card = B.relics.get("MEMBERSHIP_CARD")!;
    const s = game({ deck: strikes(5), relics: [] });
    const ctx = makeCtx(s);
    const hctx = { ...ctx, owner: PLAYER, relicCounter: { get: () => 0, set: () => {} } };
    expect(ecto.hooks.onGainGold!(hctx, 25)).toBe(0);
    expect(card.hooks.modifyPrice!(hctx, 100)).toBe(50);
  });

  test("Omamori: onEquip charges 2, vetoes curse obtains while charged", () => {
    const s = game({ deck: strikes(5), relics: ["OMAMORI"] });
    const ctx = makeCtx(s);
    const omamori = B.relics.get("OMAMORI")!;
    omamori.onEquip!(ctx);
    expect(relicCounter(s, "OMAMORI")).toBe(2);
    const rs = s.run.relics.find((r) => r.defId === "OMAMORI")!;
    const hctx = { ...ctx, owner: PLAYER, relicCounter: { get: () => rs.counter, set: (n: number) => (rs.counter = n) } };
    expect(omamori.hooks.canObtainCard!(hctx, "T_CURSE")).toBe(false);
    expect(rs.counter).toBe(1);
    expect(omamori.hooks.canObtainCard!(hctx, "T_STRIKE")).toBeUndefined();
    expect(omamori.hooks.canObtainCard!(hctx, "T_CURSE")).toBe(false);
    expect(omamori.hooks.canObtainCard!(hctx, "T_CURSE")).toBeUndefined(); // charges spent
  });
});

describe("marker/paper relics feed the core power defs", () => {
  test("Paper Phrog: Vulnerable multiplies by 1.75", () => {
    let s = game({ deck: [...strikes(3), ...Array(3).fill({ defId: "T_BASH" })], relics: ["PAPER_PHROG"] });
    while (!(handNames(s).includes("T_BASH") && handNames(s).includes("T_STRIKE"))) {
      s = advance(s, { cmd: "endTurn" }, B);
    }
    s = play(s, "T_BASH", 0);
    const hp0 = s.combat!.monsters[0]!.hp;
    s = play(s, "T_STRIKE", 0);
    expect(s.combat!.monsters[0]!.hp).toBe(hp0 - 10); // floor(6 * 1.75)
  });

  test("Odd Mushroom: player takes x1.25 while Vulnerable", () => {
    let s = gameWhere({ deck: strikes(12), relics: ["ODD_MUSHROOM"], hp: 60 }, intends("ATTACK"));
    s.combat!.player.powers.push({ id: "VULNERABLE", amount: 2, justApplied: false, data: null });
    const hp0 = s.run.hp;
    s = advance(s, { cmd: "endTurn" }, B);
    expect(s.run.hp).toBe(hp0 - 12); // floor(10 * 1.25)
  });
});

// ---------------------------------------------------------------------------
// Java fidelity: behaviours pinned against the decompiled relic classes.
// ---------------------------------------------------------------------------

describe("java fidelity: combat-start timing", () => {
  test("Mark of Pain: the Wounds land after the opening draw (MarkOfPain.atBattleStart addToBot)", () => {
    for (let i = 0; i < 8; i++) {
      const s = game({ seed: `MOP${i}`, deck: strikes(5), relics: ["MARK_OF_PAIN"] });
      expect(handNames(s)).toEqual(Array(5).fill("T_STRIKE"));
      const draw = s.combat!.player.piles.draw.map((iid) => s.combat!.cards[iid]!.defId);
      expect(draw).toEqual(["WOUND", "WOUND"]);
    }
  });

  test("Bag of Preparation draws its 2 in relic order with Mark of Pain", () => {
    // Mark of Pain first: its Wounds are in the pile when the extra draw runs
    const painFirst = game({ deck: strikes(5), relics: ["MARK_OF_PAIN", "BAG_OF_PREPARATION"] });
    expect(handNames(painFirst).filter((n) => n === "WOUND").length).toBe(2);
    expect(handNames(painFirst).slice(0, 5)).toEqual(Array(5).fill("T_STRIKE"));
    // Bag first: the extra draw finds an empty pile, the Wounds come after
    const bagFirst = game({ deck: strikes(5), relics: ["BAG_OF_PREPARATION", "MARK_OF_PAIN"] });
    expect(handNames(bagFirst)).toEqual(Array(5).fill("T_STRIKE"));
    expect(bagFirst.combat!.player.piles.draw.length).toBe(2);
  });

  test("Preserved Insect caps HP after the pre-battle max HP buff, off maxHealth", () => {
    const s = game({ deck: strikes(5), relics: ["PRESERVED_INSECT"], monsters: ["T_BUFFED_ELITE"] });
    expect(s.combat!.monsters[0]!.maxHp).toBe(60);
    expect(monsterHp(s)).toBe(45); // (int)(60 * 0.75f), not 40*0.75 + 20
  });

  test("Neow's Lament is an atBattleStart hook (runs after pre-battle setup)", () => {
    const def = B.relics.get("NEOWS_LAMENT")!;
    expect(def.hooks.atBattleStartPreDraw).toBeUndefined();
    const s = game({ deck: strikes(5), relics: ["NEOWS_LAMENT"], monsters: ["T_BUFFED_NORMAL"] });
    expect(monsterHp(s)).toBe(60); // counter 0: inert
    const ctx = makeCtx(s);
    const r = s.run.relics[0]!;
    r.counter = 3;
    def.hooks.atBattleStart!({ ...ctx, owner: PLAYER, relicCounter: { get: () => r.counter, set: (n) => (r.counter = n) } });
    expect(monsterHp(s)).toBe(1);
    expect(r.counter).toBe(2);
  });

  test("Toolbox resolves before the opening draw; HEALING colorless cards never offered", () => {
    let s = game({ deck: strikes(12), relics: ["TOOLBOX"] });
    expect(s.pending).not.toBeNull();
    expect(s.combat!.player.piles.hand.length).toBe(0);
    expect((s.pending!.request as { options: string[] }).options).toEqual(["T Colorless"]);
    s = advance(s, { cmd: "choose", indices: [0] }, B);
    expect(handNames(s)).toEqual(["T_COLORLESS", ...Array(5).fill("T_STRIKE")]);
  });

  test("Enchiridion adds its Power before the draw, never a HEALING card", () => {
    for (let i = 0; i < 10; i++) {
      const s = game({ seed: `ENCH${i}`, deck: strikes(12), relics: ["ENCHIRIDION"] });
      expect(handNames(s)[0]).toBe("T_POWER");
      expect(handNames(s)).not.toContain("T_HEAL_POWER");
      const c = s.combat!.cards[s.combat!.player.piles.hand[0]!]!;
      expect(c.costForTurn).toBe(0);
    }
  });

  test("Warped Tongs upgrades a card of the drawn hand, off shuffleRng (not miscRng)", () => {
    const withTongs = game({ deck: jabs(10), relics: ["WARPED_TONGS"] });
    const hand = withTongs.combat!.player.piles.hand.map((iid) => withTongs.combat!.cards[iid]!);
    expect(hand.length).toBe(5);
    expect(hand.filter((c) => c.upgrades === 1).length).toBe(1);
    const without = game({ deck: jabs(10), relics: [] });
    expect(JSON.stringify(withTongs.rng.floor.miscRng)).toBe(JSON.stringify(without.rng.floor.miscRng));
    expect(JSON.stringify(withTongs.rng.floor.shuffleRng)).not.toBe(JSON.stringify(without.rng.floor.shuffleRng));
  });

  test("Snecko Eye still confuses the whole opening hand", () => {
    for (let i = 0; i < 5; i++) {
      const s = game({ seed: `SNK${i}`, deck: strikes(12), relics: ["SNECKO_EYE"] });
      expect(power(s, "CONFUSED")).toBeDefined();
      expect(s.combat!.player.piles.hand.length).toBe(7);
    }
  });

  test("Confusion clears freeToPlayOnce on every drawn card it rolls (ConfusionPower.onCardDraw)", () => {
    const s = game({ deck: strikes(14), relics: ["SNECKO_EYE"] });
    for (const iid of s.combat!.player.piles.draw) s.combat!.cards[iid]!.freeToPlayOnce = true;
    const t = advance(s, { cmd: "endTurn" }, B);
    const hand = t.combat!.player.piles.hand.map((iid) => t.combat!.cards[iid]!);
    expect(hand.length).toBe(7);
    expect(hand.every((c) => !c.freeToPlayOnce)).toBe(true);
  });
});

describe("java fidelity: triggers and ordering", () => {
  test("Meat on the Bone checks HP before Burning Blood heals (AbstractRoom.endBattle)", () => {
    const s = game({ deck: jabs(7), relics: ["BURNING_BLOOD", "MEAT_ON_THE_BONE"], hp: 38 });
    s.combat!.monsters[0]!.hp = 1;
    const t = play(s, "T_JAB", 0);
    expect(t.combat!.monsters[0]!.isDead).toBe(true);
    expect(t.run.hp).toBe(38 + 12 + 6);
  });

  test("Centennial Puzzle draws on top of the queue: before the hit's follow-up", () => {
    let s = game({ deck: strikes(12), relics: ["CENTENNIAL_PUZZLE"], monsters: ["T_WOUNDER"], hp: 60 });
    s = advance(s, { cmd: "endTurn" }, B);
    expect(handNames(s).length).toBe(9);
    expect(handNames(s).slice(0, 4)).toEqual(["T_STRIKE", "T_STRIKE", "T_STRIKE", "WOUND"]);
  });

  test("Runic Cube draws on top of the queue: before the hit's follow-up", () => {
    let s = game({ deck: strikes(12), relics: ["RUNIC_CUBE"], monsters: ["T_WOUNDER"], hp: 60 });
    s = advance(s, { cmd: "endTurn" }, B);
    expect(handNames(s).slice(0, 2)).toEqual(["T_STRIKE", "WOUND"]);
  });

  test("Magic Flower rounds (MathUtils.round): Toy Ornithopter's 5 heals 8 in combat", () => {
    const s = game({ deck: strikes(5), relics: ["TOY_ORNITHOPTER", "MAGIC_FLOWER"], hp: 40 });
    s.run.potions[0] = "BLOCK_POTION";
    const t = advance(s, { cmd: "usePotion", slot: 0 }, B);
    expect(t.run.hp).toBe(48);
  });

  test("Face of Cleric's +1 Max HP heals through the heal path (Magic Flower: +2)", () => {
    const s = game({ deck: jabs(7), relics: ["FACE_OF_CLERIC", "MAGIC_FLOWER"], hp: 40 });
    s.combat!.monsters[0]!.hp = 1;
    const t = play(s, "T_JAB", 0);
    expect(t.run.maxHp).toBe(81);
    expect(t.run.hp).toBe(42);
  });

  test("Strawberry / Pear / Mango heal through the heal path (Mark of the Bloom blocks it)", () => {
    for (const [id, n] of [["STRAWBERRY", 7], ["PEAR", 10], ["MANGO", 14]] as const) {
      const bloom = game({ deck: strikes(5), relics: ["MARK_OF_THE_BLOOM"], hp: 50 });
      B.relics.get(id)!.onEquip!(makeCtx(bloom));
      expect(bloom.run.maxHp).toBe(80 + n);
      expect(bloom.run.hp).toBe(50);
      const plain = game({ deck: strikes(5), relics: [], hp: 50 });
      B.relics.get(id)!.onEquip!(makeCtx(plain));
      expect(plain.run.hp).toBe(50 + n);
    }
  });

  test("Gremlin Horn fires on a half-death (Darkling / Awakened One corpse)", () => {
    const s = game({ deck: jabs(12), relics: ["GREMLIN_HORN"], monsters: ["T_PHOENIX", "T_DUMMY"] });
    s.combat!.monsters[0]!.hp = 1;
    const energy0 = s.combat!.player.energy;
    const t = play(s, "T_JAB", 0);
    expect(t.combat!.monsters[0]!.halfDead).toBe(true);
    expect(t.combat!.player.energy).toBe(energy0 + 1);
    expect(t.combat!.player.piles.hand.length).toBe(5); // -1 played, +1 drawn
  });

  test("Dead Branch never makes a HEALING card", () => {
    const s = game({ deck: strikes(5), relics: ["DEAD_BRANCH"] });
    const ctx = makeCtx(s);
    const def = B.relics.get("DEAD_BRANCH")!;
    const hctx = { ...ctx, owner: PLAYER, relicCounter: { get: () => 0, set: () => {} } };
    const card = s.combat!.cards[s.combat!.player.piles.hand[0]!]!;
    for (let i = 0; i < 60; i++) def.hooks.onExhaust!(hctx, card);
    const made = ctx.queue.snapshot().map((a) => (a.kind === "makeTempCard" ? a.defId : ""));
    expect(made.length).toBe(60);
    expect(made).not.toContain("T_HEAL_POWER");
    for (const id of made) {
      const d = B.cards.get(id)!;
      expect(d.color).toBe("red");
      expect(["common", "uncommon", "rare"]).toContain(d.rarity);
    }
  });

  test("Omamori negates before Ceramic Fish / Darkstone Periapt see the curse", () => {
    const s = game({ deck: strikes(5), relics: ["CERAMIC_FISH", "DARKSTONE_PERIAPT", "OMAMORI"], hp: 50 });
    setRelicCounter(s, "OMAMORI", 1);
    const ctx = makeCtx(s);
    expect(obtainDeckCard(ctx, "T_CURSE")).toBe(false);
    expect(s.run.gold).toBe(99);
    expect(s.run.maxHp).toBe(80);
    expect(relicCounter(s, "OMAMORI")).toBe(0);
    // charges spent: the next curse lands and both relics react
    expect(obtainDeckCard(ctx, "T_CURSE")).toBe(true);
    expect(s.run.gold).toBe(99 + 9);
    expect(s.run.maxHp).toBe(86);
    expect(s.run.hp).toBe(56);
  });

  test("Bloody Idol heals on a real gold gain only; never with Ectoplasm, in either relic order", () => {
    const idol = B.relics.get("BLOODY_IDOL")!;
    for (const relics of [["BLOODY_IDOL"], ["BLOODY_IDOL", "ECTOPLASM"], ["ECTOPLASM", "BLOODY_IDOL"]]) {
      const s = game({ deck: strikes(5), relics, hp: 50 });
      const ctx = makeCtx(s);
      const hctx = { ...ctx, owner: PLAYER, relicCounter: { get: () => 0, set: () => {} } };
      expect(idol.hooks.onGainGold!(hctx, 25)).toBe(25);
      expect(s.run.hp).toBe(relics.includes("ECTOPLASM") ? 50 : 55);
      idol.hooks.onGainGold!(hctx, 0);
      expect(s.run.hp).toBe(relics.includes("ECTOPLASM") ? 50 : 55);
    }
  });

  test("Strange Spoon: a card that would exhaust is discarded on a cardRandomRng coin flip", () => {
    const outcomes = new Set<string>();
    for (let i = 0; i < 16; i++) {
      let s = game({ seed: `SPOON${i}`, deck: [{ defId: "T_EXHAUST_DRAW" }, ...strikes(4)], relics: ["STRANGE_SPOON"] });
      s = play(s, "T_EXHAUST_DRAW");
      const piles = s.combat!.player.piles;
      const where = (ids: number[]) => ids.some((iid) => s.combat!.cards[iid]!.defId === "T_EXHAUST_DRAW");
      outcomes.add(where(piles.exhaust) ? "exhaust" : where(piles.discard) ? "discard" : "?");
    }
    expect(outcomes).toEqual(new Set(["exhaust", "discard"]));
    // without the Spoon it always exhausts
    let t = game({ deck: [{ defId: "T_EXHAUST_DRAW" }, ...strikes(4)], relics: [] });
    t = play(t, "T_EXHAUST_DRAW");
    expect(t.combat!.player.piles.exhaust.length).toBe(1);
  });

  test("Blue Candle: a curse becomes playable, costs 1 HP and exhausts (AbstractCard.canUse, BlueCandle.onUseCard)", () => {
    const deck = [{ defId: "INJURY" }, ...strikes(4)];
    const s = game({ deck, relics: ["BLUE_CANDLE"], hp: 50 });
    const injury = s.combat!.cards[s.combat!.player.piles.hand[handNames(s).indexOf("INJURY")]!]!;
    expect(getCardPlayability(s, B, injury).playable).toBe(true);
    const energy0 = s.combat!.player.energy;
    const t = play(s, "INJURY");
    expect(t.run.hp).toBe(49);
    expect(t.combat!.player.energy).toBe(energy0);
    expect(t.combat!.player.piles.exhaust.map((iid) => t.combat!.cards[iid]!.defId)).toEqual(["INJURY"]);
    // without the Candle the curse stays unplayable
    const u = game({ deck, relics: [], hp: 50 });
    const inj = u.combat!.cards[u.combat!.player.piles.hand[handNames(u).indexOf("INJURY")]!]!;
    expect(getCardPlayability(u, B, inj).playable).toBe(false);
    expect(() => play(u, "INJURY")).toThrow("unplayable card");
  });

  test("Medical Kit: a status becomes playable and exhausts, no HP cost; neither relic covers the other type", () => {
    const deck = [{ defId: "WOUND" }, { defId: "INJURY" }, ...strikes(3)];
    const s = game({ deck, relics: ["MEDICAL_KIT"], hp: 50 });
    const cardOf = (st: GameState, name: string) => st.combat!.cards[st.combat!.player.piles.hand[handNames(st).indexOf(name)]!]!;
    expect(getCardPlayability(s, B, cardOf(s, "WOUND")).playable).toBe(true);
    expect(getCardPlayability(s, B, cardOf(s, "INJURY")).playable).toBe(false);
    const t = play(s, "WOUND");
    expect(t.run.hp).toBe(50);
    expect(t.combat!.player.piles.exhaust.map((iid) => t.combat!.cards[iid]!.defId)).toEqual(["WOUND"]);
    const candle = game({ deck, relics: ["BLUE_CANDLE"], hp: 50 });
    expect(getCardPlayability(candle, B, cardOf(candle, "WOUND")).playable).toBe(false);
  });

  test("Necronomicon: its curse goes through the obtain path; X Attacks paid with 2+ replay", () => {
    const charged = game({ deck: strikes(5), relics: ["OMAMORI"] });
    setRelicCounter(charged, "OMAMORI", 2);
    B.relics.get("NECRONOMICON")!.onEquip!(makeCtx(charged));
    expect(charged.run.deck.some((c) => c.defId === "NECRONOMICURSE")).toBe(false);
    expect(relicCounter(charged, "OMAMORI")).toBe(1);

    const s = game({ deck: [{ defId: "T_X_ATTACK" }, ...strikes(4)], relics: ["NECRONOMICON"] });
    const hp0 = monsterHp(s);
    const t = play(s, "T_X_ATTACK", 0);
    expect(monsterHp(t)).toBe(hp0 - 8); // played twice
  });
});
