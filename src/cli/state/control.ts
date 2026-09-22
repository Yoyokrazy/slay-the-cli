import type { Key } from "../term/keys";

export type ControlAction =
  | { kind: "key"; key: string }
  | { kind: "select"; id: string }
  | { kind: "play"; iid: number; target?: number }
  | { kind: "end" };

export interface ControlRequest {
  requestId: string;
  expectedRevision: string;
  action: ControlAction;
}

const namedKeys: Record<string, Key> = {
  ENTER: { kind: "enter" }, ESC: { kind: "esc" }, TAB: { kind: "tab" },
  SHIFT_TAB: { kind: "shiftTab" }, BACKSPACE: { kind: "backspace" },
  UP: { kind: "up" }, DOWN: { kind: "down" }, LEFT: { kind: "left" }, RIGHT: { kind: "right" },
};

export function controlKey(value: string): Key | null {
  return namedKeys[value] ?? (/^[\x20-\x7e]$/.test(value) ? { kind: "char", ch: value } : null);
}

export const controlKeys = [
  ...Object.keys(namedKeys), ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)),
];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseControlRequest(value: unknown): ControlRequest {
  if (!record(value) || !exact(value, ["requestId", "expectedRevision", "action"]) ||
      !text(value.requestId, 100) || !text(value.expectedRevision, 200) || !record(value.action)) {
    throw new Error("INVALID_REQUEST: expected requestId, expectedRevision and action");
  }
  const a = value.action;
  let action: ControlAction;
  if (a.kind === "key" && exact(a, ["kind", "key"]) && typeof a.key === "string" && controlKey(a.key)) {
    action = { kind: "key", key: a.key };
  } else if (a.kind === "select" && exact(a, ["kind", "id"]) && text(a.id, 2000)) {
    action = { kind: "select", id: a.id };
  } else if (a.kind === "play" && exact(a, ["kind", "iid", "target"]) && positive(a.iid) &&
      (a.target === undefined || positive(a.target))) {
    action = { kind: "play", iid: a.iid, ...(a.target === undefined ? {} : { target: a.target }) };
  } else if (a.kind === "end" && exact(a, ["kind"])) {
    action = { kind: "end" };
  } else {
    throw new Error("INVALID_ACTION: only key, select, play and end are accepted");
  }
  return { requestId: value.requestId, expectedRevision: value.expectedRevision, action };
}
