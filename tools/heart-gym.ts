// Deterministic single-fight gym for the real engine.
//
// Usage:
//   bun tools/heart-gym.ts spec.json
//   bun tools/heart-gym.ts spec.json --cmd "play 3 1; end; potion 1 1"
//   bun tools/heart-gym.ts spec.json --commands commands.json --pretty
//
// Text commands use combat-facing numbers: play <hand-iid> [enemy-slot],
// potion <1-based-potion-slot> [enemy-slot], choose <1-based-choice>[,...], end.
// commands.json may be an array of those strings or raw engine Command objects.

import { readFileSync } from "node:fs";
import { advance, createRun, type Command, type GameState } from "../src/engine/game";
import { buildBaseContentBundle } from "../src/content/index";
import type { ContentBundle } from "../src/engine/content/defs";
import type { ActMap, MapNode, RoomKind } from "../src/engine/run/runState";
import type { CardId, MonsterId, PotionId, RelicId } from "../src/engine/core/ids";
import { needsEnemyTarget } from "../src/engine/content/targeting";
import { getCardCost } from "../src/engine/combat/preview";
import { getIntents } from "../src/engine/combat/intents";

const MAP_HEIGHT = 15;
const MAP_WIDTH = 7;
const ACT4_X = 3;

export interface HeartGymSpec {
  seed: string;
  ascension: number;
  hp: number;
  maxHp: number;
  deck: { defId: CardId; upgrades?: number }[];
  relics: RelicId[];
  potions: (PotionId | null)[];
  encounter?: string;
  gold?: number;
  keys?: Partial<{ emerald: boolean; ruby: boolean; sapphire: boolean }>;
}

export type GymCommandInput = string | Command;

export interface HeartGymOutput {
  seed: string;
  ascension: number;
  encounter: string;
  turn: number | null;
  energy: number | null;
  player: {
    hp: number;
    maxHp: number;
    block: number;
    powers: { id: string; amount: number }[];
  };
  hand: {
    iid: number;
    card: string;
    upgrades: number;
    cost: number | null;
    playable: boolean;
    targeted: boolean;
  }[];
  piles: { draw: number; discard: number; exhaust: number };
  potions: (string | null)[];
  enemies: {
    slot: number;
    id: string;
    hp: number;
    maxHp: number;
    block: number;
    powers: { id: string; amount: number }[];
    intent: { move: string; damage: number | null; hits: number; kind: string } | null;
  }[];
  outcome: "victory" | "death" | "ongoing";
  damageLog: { turn: number; damageDealt: number; damageTaken: number }[];
}

interface StartPlan {
  act: number;
  floorBeforePick: number;
  map: ActMap;
  position: [number, number] | null;
  pick: { x: number; y: number };
  pools?: Partial<GameState["run"]["pools"]>;
}

interface CommandReplay {
  commands: GymCommandInput[];
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function parseSpec(value: unknown): HeartGymSpec {
  assertObject(value, "spec");
  const deck = value.deck;
  const relics = value.relics;
  const potions = value.potions;
  if (typeof value.seed !== "string") throw new Error("spec.seed must be a string");
  if (typeof value.ascension !== "number") throw new Error("spec.ascension must be a number");
  if (typeof value.hp !== "number") throw new Error("spec.hp must be a number");
  if (typeof value.maxHp !== "number") throw new Error("spec.maxHp must be a number");
  if (!Array.isArray(deck)) throw new Error("spec.deck must be an array");
  if (!Array.isArray(relics)) throw new Error("spec.relics must be an array");
  if (!Array.isArray(potions)) throw new Error("spec.potions must be an array");
  return {
    seed: value.seed,
    ascension: value.ascension,
    hp: value.hp,
    maxHp: value.maxHp,
    deck: deck.map((entry, i) => {
      assertObject(entry, `spec.deck[${i}]`);
      if (typeof entry.defId !== "string") throw new Error(`spec.deck[${i}].defId must be a string`);
      if (entry.upgrades !== undefined && typeof entry.upgrades !== "number") {
        throw new Error(`spec.deck[${i}].upgrades must be a number`);
      }
      return { defId: entry.defId, upgrades: entry.upgrades ?? 0 };
    }),
    relics: relics.map((id, i) => {
      if (typeof id !== "string") throw new Error(`spec.relics[${i}] must be a string`);
      return id;
    }),
    potions: potions.map((id, i) => {
      if (id !== null && typeof id !== "string") throw new Error(`spec.potions[${i}] must be a string or null`);
      return id;
    }),
    encounter: typeof value.encounter === "string" ? value.encounter : undefined,
    gold: typeof value.gold === "number" ? value.gold : undefined,
    keys: parseKeys(value.keys),
  };
}

function parseKeys(value: unknown): HeartGymSpec["keys"] {
  if (value === undefined) return undefined;
  assertObject(value, "spec.keys");
  return {
    emerald: typeof value.emerald === "boolean" ? value.emerald : undefined,
    ruby: typeof value.ruby === "boolean" ? value.ruby : undefined,
    sapphire: typeof value.sapphire === "boolean" ? value.sapphire : undefined,
  };
}

function emptyRows(): (MapNode | null)[][] {
  return Array.from({ length: MAP_HEIGHT }, () => new Array<MapNode | null>(MAP_WIDTH).fill(null));
}

function act4Map(): ActMap {
  const rows = emptyRows();
  const kinds: MapNode["kind"][] = ["rest", "shop", "elite", "boss"];
  kinds.forEach((kind, y) => {
    rows[y]![ACT4_X] = { x: ACT4_X, y, kind, edges: y < 3 ? [ACT4_X] : [], burningElite: false, emeraldKey: false };
  });
  return { act: 4, rows, bossId: "THE_HEART", burningEliteBuff: -1 };
}

function singleNodeMap(act: number, kind: RoomKind, bossId: MonsterId): ActMap {
  const rows = emptyRows();
  rows[0]![ACT4_X] = { x: ACT4_X, y: 0, kind, edges: [ACT4_X], burningElite: false, emeraldKey: false };
  rows[MAP_HEIGHT - 1]![ACT4_X] = { x: ACT4_X, y: MAP_HEIGHT - 1, kind: "rest", edges: [], burningElite: false, emeraldKey: false };
  return { act, rows, bossId, burningEliteBuff: -1 };
}

function findEncounter(bundle: ContentBundle, encounter: string): { act: number; kind: "monster" | "elite" | "boss" } | null {
  for (const act of bundle.acts) {
    if ([...act.weakEncounters, ...act.strongEncounters].some((e) => e.id === encounter)) {
      return { act: act.act, kind: "monster" };
    }
    if (act.elites.some((e) => e.id === encounter)) return { act: act.act, kind: "elite" };
    if (act.bosses.includes(encounter)) return { act: act.act, kind: "boss" };
  }
  return null;
}

function startPlan(bundle: ContentBundle, encounter: string): StartPlan {
  if (encounter === "THE_HEART" || encounter === "CORRUPT_HEART") {
    return { act: 4, floorBeforePick: 55, map: act4Map(), position: [ACT4_X, 2], pick: { x: ACT4_X, y: 3 } };
  }
  if (encounter === "SHIELD_AND_SPEAR") {
    return { act: 4, floorBeforePick: 54, map: act4Map(), position: [ACT4_X, 1], pick: { x: ACT4_X, y: 2 } };
  }

  const found = findEncounter(bundle, encounter);
  if (found?.kind === "monster") {
    return {
      act: found.act,
      floorBeforePick: 1,
      map: singleNodeMap(found.act, "monster", encounter),
      position: null,
      pick: { x: ACT4_X, y: 0 },
      pools: { monsterList: [encounter] },
    };
  }
  if (found?.kind === "elite") {
    return {
      act: found.act,
      floorBeforePick: 20,
      map: singleNodeMap(found.act, "elite", encounter),
      position: null,
      pick: { x: ACT4_X, y: 0 },
      pools: { eliteList: [encounter] },
    };
  }

  const bossAct = found?.act ?? 3;
  return {
    act: bossAct,
    floorBeforePick: bossAct === 3 ? 50 : 16,
    map: singleNodeMap(bossAct, "boss", encounter),
    position: [ACT4_X, MAP_HEIGHT - 1],
    pick: { x: ACT4_X, y: MAP_HEIGHT },
    pools: { bossList: [encounter] },
  };
}

export function createHeartGymState(spec: HeartGymSpec, bundle: ContentBundle = buildBaseContentBundle()): GameState {
  const encounter = spec.encounter ?? "THE_HEART";
  const plan = startPlan(bundle, encounter);
  let state = createRun({ seed: spec.seed, bundle, character: "IRONCLAD", ascension: spec.ascension });
  state.run.act = plan.act;
  state.run.floor = plan.floorBeforePick;
  state.run.hp = spec.hp;
  state.run.maxHp = spec.maxHp;
  state.run.gold = spec.gold ?? state.run.gold;
  state.run.deck = spec.deck.map((card) => ({ defId: card.defId, upgrades: card.upgrades ?? 0, misc: 0, bottled: false }));
  state.run.relics = spec.relics.map((defId) => ({ defId, counter: 0 }));
  state.run.potions = [...spec.potions];
  state.run.potionSlots = spec.potions.length;
  state.run.keys = {
    emerald: spec.keys?.emerald ?? true,
    ruby: spec.keys?.ruby ?? true,
    sapphire: spec.keys?.sapphire ?? true,
  };
  state.run.map = plan.map;
  state.run.position = plan.position;
  state.run.room = { kind: "map" };
  state.run.pools = { ...state.run.pools, ...plan.pools };
  return advance(state, { cmd: "mapPick", ...plan.pick }, bundle);
}

function parseCommand(input: GymCommandInput, state: GameState): Command {
  if (typeof input !== "string") return input;
  const parts = input.trim().split(/\s+/).filter(Boolean);
  const op = parts[0]?.toLowerCase();
  if (!op) throw new Error("empty command");
  if (op === "end" || op === "endturn") return { cmd: "endTurn" };
  if (op === "play") {
    const iid = Number(parts[1]);
    if (!Number.isInteger(iid)) throw new Error("play requires a hand iid");
    const handIdx = state.combat?.player.piles.hand.indexOf(iid) ?? -1;
    if (handIdx === -1) throw new Error(`play references iid ${iid}, which is not in hand`);
    const target = parts[2] === undefined ? undefined : targetSlotToIndex(state, Number(parts[2]));
    return target === undefined ? { cmd: "playCard", handIdx } : { cmd: "playCard", handIdx, target };
  }
  if (op === "potion") {
    const slot = Number(parts[1]);
    if (!Number.isInteger(slot)) throw new Error("potion requires a 1-based potion slot");
    const target = parts[2] === undefined ? undefined : targetSlotToIndex(state, Number(parts[2]));
    return target === undefined ? { cmd: "usePotion", slot: slot - 1 } : { cmd: "usePotion", slot: slot - 1, target };
  }
  if (op === "discard-potion") {
    const slot = Number(parts[1]);
    if (!Number.isInteger(slot)) throw new Error("discard-potion requires a 1-based potion slot");
    return { cmd: "discardPotion", slot: slot - 1 };
  }
  if (op === "choose") {
    if (parts.length < 2) return { cmd: "choose", indices: [] };
    const indices = parts
      .slice(1)
      .flatMap((part) => part.split(","))
      .filter(Boolean)
      .map((part) => {
        const n = Number(part);
        if (!Number.isInteger(n)) throw new Error(`invalid choice index ${part}`);
        return n - 1;
      });
    return { cmd: "choose", indices };
  }
  throw new Error(`unknown command "${op}"`);
}

function targetSlotToIndex(state: GameState, slot: number): number {
  if (!Number.isInteger(slot) || slot < 1) throw new Error("target slot must be a positive integer");
  const monsters = state.combat?.monsters ?? [];
  let visible = 0;
  for (const monster of monsters) {
    if (monster.id === "GAP" || monster.isDead || monster.isEscaped || monster.halfDead) continue;
    visible++;
    if (visible === slot) return monster.idx;
  }
  throw new Error(`no enemy target slot ${slot}`);
}

function playable(state: GameState, bundle: ContentBundle, iid: number): boolean {
  const combat = state.combat;
  if (!combat) return false;
  const handIdx = combat.player.piles.hand.indexOf(iid);
  if (handIdx === -1) return false;
  const card = combat.cards[iid];
  if (!card || card.cost === -2) return false;
  const targets = combat.monsters.filter((m) => !m.isDead && !m.isEscaped && !m.halfDead);
  const def = bundle.cards.get(card.defId);
  if (!def) return false;
  try {
    if (needsEnemyTarget(def.target)) {
      if (!targets[0]) return false;
      advance(state, { cmd: "playCard", handIdx, target: targets[0].idx }, bundle);
    } else {
      advance(state, { cmd: "playCard", handIdx }, bundle);
    }
    return true;
  } catch {
    return false;
  }
}

function monsterHpTotal(state: GameState): number {
  return (state.combat?.monsters ?? [])
    .filter((monster) => !monster.isDead && !monster.isEscaped)
    .reduce((sum, monster) => sum + monster.hp, 0);
}

function accumulateDamage(
  log: Map<number, { turn: number; damageDealt: number; damageTaken: number }>,
  turn: number,
  before: GameState,
  after: GameState,
): void {
  let entry = log.get(turn);
  if (!entry) {
    entry = { turn, damageDealt: 0, damageTaken: 0 };
    log.set(turn, entry);
  }
  let eventDealt = 0;
  let eventTaken = 0;
  for (const event of after.eventLog) {
    if (event.event !== "damaged") continue;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const target = "target" in payload ? payload.target : null;
    const amount = "amount" in payload && typeof payload.amount === "number" ? payload.amount : 0;
    if (typeof target !== "object" || target === null || !("kind" in target)) continue;
    if (target.kind === "monster") eventDealt += amount;
    if (target.kind === "player") eventTaken += amount;
  }
  entry.damageDealt += Math.max(eventDealt, monsterHpTotal(before) - monsterHpTotal(after));
  entry.damageTaken += Math.max(eventTaken, before.run.hp - after.run.hp);
}

export function runHeartGym(spec: HeartGymSpec, commands: GymCommandInput[] = [], bundle: ContentBundle = buildBaseContentBundle()): HeartGymOutput {
  let state = createHeartGymState(spec, bundle);
  const damageLog = new Map<number, { turn: number; damageDealt: number; damageTaken: number }>();
  for (let i = 0; i < commands.length; i++) {
    const turn = state.combat?.turn ?? 0;
    try {
      const cmd = parseCommand(commands[i]!, state);
      const before = state;
      state = advance(state, cmd, bundle);
      accumulateDamage(damageLog, turn, before, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`command ${i}: ${message}`);
    }
  }
  return summarizeState(state, spec.encounter ?? "THE_HEART", bundle, [...damageLog.values()]);
}

function shownPowers(powers: { id: string; amount: number }[], bundle: ContentBundle): { id: string; amount: number }[] {
  return powers.filter((power) => !bundle.powers.get(power.id)?.hidden).map(({ id, amount }) => ({ id, amount }));
}

function summarizeState(
  state: GameState,
  encounter: string,
  bundle: ContentBundle,
  damageLog: { turn: number; damageDealt: number; damageTaken: number }[],
): HeartGymOutput {
  const combat = state.combat;
  const intents = getIntents(state, bundle);
  return {
    seed: state.seed,
    ascension: state.run.ascension,
    encounter,
    turn: combat?.turn ?? null,
    energy: combat?.player.energy ?? null,
    player: {
      hp: state.run.hp,
      maxHp: state.run.maxHp,
      block: combat?.player.block ?? 0,
      powers: shownPowers(combat?.player.powers ?? [], bundle),
    },
    hand: (combat?.player.piles.hand ?? []).map((iid) => {
      const card = combat?.cards[iid];
      const def = card ? bundle.cards.get(card.defId) : undefined;
      return {
        iid,
        card: card?.defId ?? "?",
        upgrades: card?.upgrades ?? 0,
        cost: card ? getCardCost(state, bundle, card) : null,
        playable: card ? playable(state, bundle, iid) : false,
        targeted: def ? needsEnemyTarget(def.target) : false,
      };
    }),
    piles: {
      draw: combat?.player.piles.draw.length ?? 0,
      discard: combat?.player.piles.discard.length ?? 0,
      exhaust: combat?.player.piles.exhaust.length ?? 0,
    },
    potions: [...state.run.potions],
    enemies: (combat?.monsters ?? [])
      .filter((monster) => monster.id !== "GAP" && !monster.isDead && !monster.isEscaped)
      .map((monster, index) => {
        const intent = intents[monster.idx];
        return {
          slot: index + 1,
          id: monster.id,
          hp: monster.hp,
          maxHp: monster.maxHp,
          block: monster.block,
          powers: shownPowers(monster.powers, bundle),
          intent: intent ? { move: intent.moveId, damage: intent.damage, hits: intent.hits, kind: intent.kind } : null,
        };
      }),
    outcome: summarizeOutcome(state),
    damageLog: damageLog.filter((entry) => entry.damageDealt > 0 || entry.damageTaken > 0),
  };
}

function summarizeOutcome(state: GameState): HeartGymOutput["outcome"] {
  if (state.outcome?.kind === "death") return "death";
  if (state.outcome?.kind === "victory") return "victory";
  if (state.combat) return "ongoing";
  if (state.run.room?.kind === "rewards") return "victory";
  if (state.run.room?.kind === "gameOver" && state.run.room.victory) return "victory";
  return "ongoing";
}

function parseCommandsFromArgs(args: string[]): CommandReplay {
  const commandsFlag = args.indexOf("--commands");
  if (commandsFlag !== -1) {
    const path = args[commandsFlag + 1];
    if (!path) throw new Error("--commands requires a file path");
    const value = readJson(path);
    if (!Array.isArray(value)) throw new Error("commands file must contain an array");
    return { commands: value.map((item, i) => parseCommandInput(item, `commands[${i}]`)) };
  }
  const cmdFlag = args.indexOf("--cmd");
  if (cmdFlag !== -1) {
    const text = args[cmdFlag + 1];
    if (!text) throw new Error("--cmd requires a command string");
    return { commands: text.split(/[;\n]/).map((s) => s.trim()).filter(Boolean) };
  }
  return { commands: [] };
}

function parseCommandInput(value: unknown, label: string): GymCommandInput {
  if (typeof value === "string") return value;
  assertObject(value, label);
  if (typeof value.cmd !== "string") throw new Error(`${label}.cmd must be a string`);
  return value as unknown as Command;
}

function main(): void {
  const args = process.argv.slice(2);
  const specPath = args.find((arg) => !arg.startsWith("--"));
  if (!specPath) {
    console.error("Usage: bun tools/heart-gym.ts spec.json [--commands commands.json | --cmd \"play 3 1; end\"] [--pretty]");
    process.exit(2);
  }
  try {
    const spec = parseSpec(readJson(specPath));
    const { commands } = parseCommandsFromArgs(args);
    const output = runHeartGym(spec, commands);
    console.log(JSON.stringify(output, null, args.includes("--pretty") ? 2 : 0));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) main();
