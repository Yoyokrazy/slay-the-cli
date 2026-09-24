import { test, expect, describe } from "bun:test";
import { createRun, advance, type Command, type GameState } from "../../src/engine/game";
import { makeRunTestBundle } from "./runTestBundle";
import { corePowers } from "../../src/content/powers/core";
import { act1Powers } from "../../src/content/monsters/act1";
import { lagavulin } from "../../src/content/monsters/act1/lagavulin";
import { act34Powers } from "../../src/content/monsters/act34";
import type { MonsterDef, PowerDef } from "../../src/engine/content/defs";

// Keys + Act 4 flow: recall, key gating at the act-3 boss, the fixed Act 4
// column (rest -> shop -> Shield & Spear -> Heart), and final victory.

function stubMonster(id: string, hp: number): MonsterDef {
  return {
    id,
    name: id,
    category: "elite",
    hp: () => [hp, hp],
    moves: {
      WAIT: { id: "WAIT", intent: "unknown", execute: () => {} },
    },
    getMove: () => "WAIT",
  };
}

function makeBundle() {
  const bundle = makeRunTestBundle();
  const dummy = bundle.monsters.get("T_DUMMY")!;
  bundle.monsters.set("T_DUMMY", { ...dummy, hp: () => [20, 20] });
  for (const id of ["SPIRE_SHIELD", "SPIRE_SPEAR", "CORRUPT_HEART", "DONU", "DECA"]) {
    bundle.monsters.set(id, stubMonster(id, 3));
  }
  bundle.monsters.set("LAGAVULIN", lagavulin);
  const neededPowers = new Set(["ASLEEP", "METALLICIZE", "REGENERATE"]);
  for (const p of [...corePowers, ...act1Powers, ...act34Powers] as PowerDef[]) {
    if (neededPowers.has(p.id)) bundle.powers.set(p.id, p);
  }
  bundle.acts[0]!.elites.push({ id: "LAGAVULIN_ELITE", monsters: ["LAGAVULIN"] });
  const act3 = bundle.acts.find((a) => a.act === 3)!;
  act3.bossEncounters = [{ id: "DONU_AND_DECA", monsters: ["DONU", "DECA"] }];
  return bundle;
}

const bundle = makeBundle();

const adv = (s: GameState, cmd: Command) => advance(s, cmd, bundle);

/** Pick a Neow option, resolving any deck-choice follow-up it opens. */
function throughNeow(s: GameState): GameState {
  s = adv(s, { cmd: "neowPick", i: 0 });
  let guard = 5;
  while (s.pending && guard-- > 0) s = adv(s, { cmd: "choose", indices: [0] });
  return s;
}

/** Attack with everything, end turn, repeat until the combat resolves. */
function winCombat(s: GameState, guard = 200): GameState {
  while (s.combat && s.run.room?.kind === "combat" && guard-- > 0) {
    const c = s.combat;
    const alive = c.monsters.find((m) => !m.isDead && !m.isEscaped);
    const handIdx = c.player.piles.hand.findIndex((iid) => {
      const card = c.cards[iid]!;
      const def = bundle.cards.get(card.defId)!;
      return def.type === "attack" && c.player.energy >= card.costForTurn;
    });
    if (alive && handIdx !== -1) s = adv(s, { cmd: "playCard", handIdx, target: alive.idx });
    else s = adv(s, { cmd: "endTurn" });
  }
  return s;
}

function enterBurningElite(buff: number, encounterId = "A1_ELITE_1"): GameState {
  let s = createRun({ seed: `BURNBUFF${buff}${encounterId}`, bundle, character: "IRONCLAD" });
  s = throughNeow(s);
  const map = s.run.map!;
  map.burningEliteBuff = buff;
  const x0 = map.rows[0]!.findIndex((n) => n !== null);
  s.run.position = [x0, 0];
  const target = map.rows[1]!.findIndex((n) => n !== null && map.rows[0]![x0]!.edges.includes(n.x));
  map.rows[1]![target]!.kind = "elite";
  map.rows[1]![target]!.burningElite = true;
  s.run.pools.eliteList = [encounterId];
  s.run.room = { kind: "map" };
  s = adv(s, { cmd: "mapPick", x: target, y: 1 });
  expect(s.run.room?.kind).toBe("combat");
  return s;
}

/** Fabricate a run poised at the act-3 boss door. */
function atAct3BossDoor(keys: { emerald: boolean; ruby: boolean; sapphire: boolean }): GameState {
  let s = createRun({ seed: "ACT4TEST", bundle, character: "IRONCLAD" });
  s = throughNeow(s);
  // surgical state setup (plain data): jump to act 3, top of the map
  s.run.act = 3;
  s.run.keys = { ...keys };
  s.run.pools.bossList = ["DONU_AND_DECA"];
  s.run.map!.act = 3;
  s.run.map!.bossId = "DONU_AND_DECA";
  // stand on any row-14 rest node
  const row14 = s.run.map!.rows[14]!;
  const x = row14.findIndex((n) => n !== null);
  s.run.position = [x, 14];
  s.run.room = { kind: "map" };
  return s;
}

describe("recall / ruby key", () => {
  test("recall grants the ruby key and consumes the rest site", () => {
    let s = createRun({ seed: "RECALL", bundle, character: "IRONCLAD" });
    s = throughNeow(s);
    s.run.room = { kind: "rest", used: false };
    s = adv(s, { cmd: "restOption", kind: "recall" });
    expect(s.run.keys.ruby).toBe(true);
    expect(s.run.room).toEqual({ kind: "rest", used: true });
    // second recall at another site is rejected
    s.run.room = { kind: "rest", used: false };
    // the campfire availability table now refuses it centrally
    expect(() => adv(s, { cmd: "restOption", kind: "recall" })).toThrow("not available here");
  });
});

describe("act 3 boss gating", () => {
  test("without all keys: victory ends the run", () => {
    let s = atAct3BossDoor({ emerald: true, ruby: true, sapphire: false });
    s = adv(s, { cmd: "mapPick", x: 3, y: 15 });
    expect(s.combat!.monsters.map((m) => m.id)).toEqual(["DONU", "DECA"]); // multi-monster boss
    s = winCombat(s);
    expect(s.outcome?.kind).toBe("victory");
    expect(s.run.room?.kind).toBe("gameOver");
  });

  test("with all keys: the run continues into the fixed Act 4", () => {
    let s = atAct3BossDoor({ emerald: true, ruby: true, sapphire: true });
    s = adv(s, { cmd: "mapPick", x: 3, y: 15 });
    s = winCombat(s);
    expect(s.outcome).toBeNull();
    expect(s.run.act).toBe(4);
    expect(s.run.room?.kind).toBe("map");
    const kinds = s.run.map!.rows.slice(0, 4).map((r) => r[3]?.kind);
    expect(kinds).toEqual(["rest", "shop", "elite", "boss"]);

    // walk the column: rest (recall unavailable - already have ruby) -> shop -> elite -> heart
    s = adv(s, { cmd: "mapPick", x: 3, y: 0 });
    expect(s.run.room?.kind).toBe("rest");
    s = adv(s, { cmd: "restOption", kind: "rest" });
    s = adv(s, { cmd: "proceed" });
    s = adv(s, { cmd: "mapPick", x: 3, y: 1 });
    expect(s.run.room?.kind).toBe("shop");
    s = adv(s, { cmd: "proceed" });
    s = adv(s, { cmd: "mapPick", x: 3, y: 2 });
    expect(s.run.room?.kind).toBe("combat");
    expect(s.combat!.monsters.map((m) => m.id)).toEqual(["SPIRE_SHIELD", "SPIRE_SPEAR"]);
    s = winCombat(s);
    // elite rewards screen, then onward to the Heart
    expect(s.run.room?.kind).toBe("rewards");
    s = adv(s, { cmd: "skipRewards" });
    s = adv(s, { cmd: "mapPick", x: 3, y: 3 });
    expect(s.run.room?.kind).toBe("combat");
    expect(s.combat!.monsters.map((m) => m.id)).toEqual(["CORRUPT_HEART"]);
    s = winCombat(s);
    expect(s.outcome?.kind).toBe("victory");
    expect(s.run.room).toEqual({ kind: "gameOver", victory: true });
  });
});

describe("burning elite buff", () => {
  test("buffed elite carries the rolled buff values (exact table)", () => {
    let s = enterBurningElite(0);
    expect(s.combat!.monsters[0]!.powers.find((p) => p.id === "STRENGTH")?.amount).toBe(1);

    s = enterBurningElite(1);
    expect(s.combat!.monsters[0]!.maxHp).toBe(25);
    expect(s.combat!.monsters[0]!.hp).toBe(25);

    s = enterBurningElite(2);
    expect(s.combat!.monsters[0]!.powers.filter((p) => p.id === "METALLICIZE").map((p) => p.amount)).toEqual([4]);

    s = enterBurningElite(3);
    expect(s.combat!.monsters[0]!.powers.filter((p) => p.id === "REGENERATE").map((p) => p.amount)).toEqual([3]);
  });

  test("burning Lagavulin stacks Metallicize and natural wake leaves the emerald stack", () => {
    let s = enterBurningElite(2, "LAGAVULIN_ELITE");
    expect(s.combat!.monsters[0]!.powers.filter((p) => p.id === "METALLICIZE").map((p) => p.amount)).toEqual([12]);
    s = adv(s, { cmd: "endTurn" });
    s = adv(s, { cmd: "endTurn" });
    s = adv(s, { cmd: "endTurn" });
    expect(s.combat!.monsters[0]!.powers.find((p) => p.id === "ASLEEP")).toBeUndefined();
    expect(s.combat!.monsters[0]!.powers.filter((p) => p.id === "METALLICIZE").map((p) => p.amount)).toEqual([4]);
  });

  test("burning Regenerate heals at monster end of turn and does not decay", () => {
    let s = enterBurningElite(3);
    const m = s.combat!.monsters[0]!;
    m.hp = m.maxHp - 5;
    s = adv(s, { cmd: "endTurn" });
    expect(s.combat!.monsters[0]!.hp).toBe(18);
    expect(s.combat!.monsters[0]!.powers.find((p) => p.id === "REGENERATE")?.amount).toBe(3);
  });
});
