import { MAP_HEIGHT, MAP_WIDTH } from "./mapGen";
import type { MapNode, RunState } from "./runState";

export interface MapPick {
  x: number;
  y: number;
}

/** y of the boss door (row above the top rest row). */
export const BOSS_DOOR_Y = MAP_HEIGHT;

export type MapPickLegality =
  | { ok: true; target: "boss"; winged: false }
  | { ok: true; target: "node"; node: MapNode; winged: boolean }
  | { ok: false; reason: string };

function wingBootsCounter(run: RunState): number {
  return run.relics.find((r) => r.defId === "WING_BOOTS")?.counter ?? 0;
}

function wingBootsActive(run: RunState): boolean {
  return wingBootsCounter(run) > 0;
}

function currentNode(run: RunState): MapNode | null {
  if (!run.map || run.position === null) return null;
  const [px, py] = run.position;
  return run.map.rows[py]?.[px] ?? null;
}

/** Legal next map nodes, mirroring runFlow's mapPick validation. */
export function legalMapPicks(run: RunState): MapPick[] {
  const map = run.map;
  if (!map) return [];
  if (run.position === null) {
    const out: MapPick[] = [];
    map.rows[0]?.forEach((node, x) => {
      if (node && node.edges.length > 0) out.push({ x, y: 0 });
    });
    return out;
  }

  const [px, py] = run.position;
  if (py >= MAP_HEIGHT - 1) return [{ x: 3, y: BOSS_DOOR_Y }];

  const node = map.rows[py]?.[px];
  if (!node) return [];
  const nextY = py + 1;
  if (wingBootsActive(run) && node.edges.length > 0) {
    const out: MapPick[] = [];
    map.rows[nextY]?.forEach((target, x) => {
      if (target) out.push({ x, y: nextY });
    });
    return out;
  }
  return node.edges.map((ex) => ({ x: ex, y: nextY }));
}

export function mapPickLegality(run: RunState, x: number, y: number): MapPickLegality {
  const map = run.map;
  if (!map) return { ok: false, reason: "no map" };

  if (y === MAP_HEIGHT) {
    if (!run.position || run.position[1] !== MAP_HEIGHT - 1) return { ok: false, reason: "boss is not reachable yet" };
    return { ok: true, target: "boss", winged: false };
  }

  if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) return { ok: false, reason: "off the map" };
  const node = map.rows[y]![x];
  if (!node) return { ok: false, reason: "no room at that position" };

  if (run.position === null) {
    if (y !== 0) return { ok: false, reason: "must start on row 0" };
    return { ok: true, target: "node", node, winged: false };
  }

  const [px, py] = run.position;
  if (y !== py + 1) return { ok: false, reason: "can only move up one row" };
  const from = currentNode(run);
  if (!from) return { ok: false, reason: "no path to that room" };
  if (from.edges.includes(x)) return { ok: true, target: "node", node, winged: false };
  if (wingBootsActive(run) && from.edges.length > 0) return { ok: true, target: "node", node, winged: true };
  return { ok: false, reason: "no path to that room" };
}

export function spendWingBootsCharge(run: RunState): void {
  const relic = run.relics.find((r) => r.defId === "WING_BOOTS");
  if (!relic || relic.counter <= 0) return;
  const remaining = relic.counter - 1;
  relic.counter = remaining === 0 ? -2 : remaining;
}
