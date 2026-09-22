import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { buildBaseContentBundle } from "../../src/content";
import { createRun, type GameState } from "../../src/engine/game";
import { seedFromString, seedToString } from "../../src/engine/core/rng";
import { runApp } from "../../src/cli/app";
import { randomSeed } from "../../src/cli/io/seed";
import type { SaveIo } from "../../src/cli/io/saves";
import type { ControlPort } from "../../src/cli/io/control";
import { fakeTerminal } from "../../src/cli/term/terminal";
import { buildView } from "../../src/cli/state/view";
import { initialUiState } from "../../src/cli/state/uiState";
import { mapKey } from "../../src/cli/input/keymap";
import { publicUi } from "../../src/cli/state/controlUi";
import { renderFrame } from "../../src/cli/render/frame";
import { THEME_PLAIN } from "../../src/cli/render/theme";
import { bumpSeed } from "../../src/cli/text/runlogic";

const bundle = buildBaseContentBundle();
const cleanup: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

function entropy(value: bigint) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(value);
  const source = spyOn(crypto, "randomBytes").mockImplementation(() => bytes);
  cleanup.push(() => source.mockRestore());
  return source;
}

function app(saved: GameState | null = null) {
  const saves = {
    dir: "memory-only",
    readSave: mock(() => saved),
    readPrefs: mock(() => ({})),
    writeSave: mock((_game: GameState) => {}),
    deleteSave: mock(() => {}),
    writePrefs: mock<SaveIo["writePrefs"]>(() => {}),
  } satisfies SaveIo;
  const term = fakeTerminal();
  let port: ControlPort | undefined;
  const finished = runApp({
    term, saves, bundle, options: { seed: "REPLAY", character: "DEFECT", ascension: 5 },
    onControlReady: controller => { port = controller; },
  });
  if (!port) throw new Error("control was not initialized");
  const controller = port;
  cleanup.push(() => { term.feed("\x03"); return finished; });
  return { term, port: controller, saves };
}

test("random seed uses eight OS-random bytes and canonical unsigned seed formatting", () => {
  const source = entropy(0n);
  for (const value of [0n, 24n, 1n << 63n, (1n << 64n) - 1n]) {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(value);
    source.mockImplementation(() => bytes);
    const seed = randomSeed();
    expect(source).toHaveBeenLastCalledWith(8);
    expect(seed).toBe(seedToString(value));
    expect(seed).toMatch(/^[0-9A-NP-Z]{1,13}$/);
    expect(seedFromString(seed)).toBe(value);
  }
  expect(source).toHaveBeenCalledTimes(4);
});

test("the default seed generator returns a canonical seed from the real OS source", () => {
  const seed = randomSeed();
  expect(seed).toMatch(/^[0-9A-NP-Z]{1,13}$/);
  expect(seedToString(seedFromString(seed))).toBe(seed);
});

for (const via of ["manual", "key", "select"] as const) {
  test(`menu random seed via ${via} only changes the shown seed until Start`, () => {
    const source = entropy((1n << 64n) - 1n);
    const a = app();
    const before = a.port.snapshot();
    const random = before.ui.controls.find(c => c.key === "r")!;
    expect(random.label).toBe("Random seed");
    expect(random.enabled).toBe(true);
    a.term.resize(80, 24);
    expect(a.port.snapshot().screenText).toContain("[r] random");
    expect(source).not.toHaveBeenCalled();
    const saveCalls = [a.saves.readSave.mock.calls.length, a.saves.readPrefs.mock.calls.length];
    if (via === "manual") {
      a.term.feed("r");
    } else {
      const result = a.port.act({
        requestId: "random-seed", expectedRevision: a.port.snapshot().revision,
        action: via === "key" ? { kind: "key", key: "r" } : { kind: "select", id: random.id },
      });
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("ui-only");
      expect(result.changed).toBe(true);
    }
    const after = a.port.snapshot();
    const seed = seedToString((1n << 64n) - 1n);
    expect(after.ui.mode).toBe("menu");
    expect(after.ui.menu).toMatchObject({ seed, character: "DEFECT", ascension: 5 });
    expect(after.screenText).toContain(seed);
    expect(after.state).toBeNull();
    expect(source).toHaveBeenCalledTimes(1);
    expect([a.saves.readSave.mock.calls.length, a.saves.readPrefs.mock.calls.length]).toEqual(saveCalls);
    expect(a.saves.writeSave).not.toHaveBeenCalled();
    expect(a.saves.deleteSave).not.toHaveBeenCalled();
    expect(a.saves.writePrefs).not.toHaveBeenCalled();
    expect(a.port.snapshot()).toEqual(after);
    expect(source).toHaveBeenCalledTimes(1);
    a.term.feed("n");
    expect(a.port.snapshot().state?.seed).toBe(seed);
    expect(a.port.snapshot().ui.mode).toBe("neow");
    expect(source).toHaveBeenCalledTimes(1);
  });
}

test("random seed does not alter a retained game or its RNG when back on the menu", () => {
  const source = entropy(24n);
  const game = createRun({ seed: "REPLAY", bundle, character: "IRONCLAD" });
  game.run.room = { kind: "gameOver", victory: false };
  const original = structuredClone(game);
  const a = app(game);
  a.term.feed("c");
  a.term.feed("m");
  const before = a.port.snapshot();
  const saveReads = a.saves.readSave.mock.calls.length;
  a.term.feed("r");
  const after = a.port.snapshot();
  expect(after.ui.menu?.seed).toBe("P");
  expect(after.state).toEqual(before.state);
  expect(game).toEqual(original);
  expect(a.saves.readSave).toHaveBeenCalledTimes(saveReads);
  expect(a.saves.writeSave).not.toHaveBeenCalled();
  expect(a.saves.writePrefs).not.toHaveBeenCalled();
  expect(source).toHaveBeenCalledTimes(1);
});

test("OS entropy failure preserves the current seed and does not start or save a run", () => {
  const source = entropy(0n);
  source.mockImplementation(() => { throw new Error("OS entropy unavailable"); });
  const a = app();
  const result = a.port.act({
    requestId: "entropy-error", expectedRevision: a.port.snapshot().revision,
    action: { kind: "key", key: "r" },
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("OS entropy unavailable");
  expect(result.ui.menu?.seed).toBe("REPLAY");
  expect(result.state).toBeNull();
  expect(a.saves.writeSave).not.toHaveBeenCalled();
  expect(a.saves.writePrefs).not.toHaveBeenCalled();
});

test("New Run keeps the selected seed without requesting randomness", () => {
  const source = entropy(24n);
  const a = app();
  a.term.feed("\r");
  expect(a.port.snapshot().state?.seed).toBe("REPLAY");
  expect(source).not.toHaveBeenCalled();
});

test("explicit seed editing and empty-commit replay behavior remain unchanged", () => {
  const source = entropy(24n);
  const a = app();
  a.term.feed("s");
  a.term.feed("\x7f".repeat("REPLAY".length));
  a.term.feed("\r");
  expect(a.port.snapshot().ui.menu?.seed).toBe("REPLAY");
  a.term.feed("s");
  a.term.feed("\x7f".repeat("REPLAY".length));
  a.term.feed("3IZ43AWJ52HTE");
  a.term.feed("\r");
  expect(a.port.snapshot().ui.menu?.seed).toBe("3IZ43AWJ52HTE");
  a.term.feed("n");
  expect(a.port.snapshot().state?.seed).toBe("3IZ43AWJ52HTE");
  expect(source).not.toHaveBeenCalled();
});

test("game-over rerun keeps the existing next-seed behavior", () => {
  const source = entropy(24n);
  const game = createRun({ seed: "REPLAY", bundle, character: "IRONCLAD", ascension: 5 });
  game.run.room = { kind: "gameOver", victory: false };
  const a = app(game);
  a.term.feed("c");
  a.term.feed("n");
  expect(a.port.snapshot().state?.seed).toBe(seedToString(seedFromString(bumpSeed(game.seed))));
  expect(a.port.snapshot().ui.mode).toBe("neow");
  expect(source).not.toHaveBeenCalled();
});

test("r stays literal in seed entry, opens relics in a run, and cannot roll through an overlay", () => {
  const game = createRun({ seed: "REPLAY", bundle, character: "IRONCLAD" });
  for (const vimKeys of [false, true]) {
    const ui = initialUiState({ vimKeys });
    const typed = buildView(null, { ...ui, seedEdit: { value: "" } }, bundle);
    expect(mapKey({ kind: "char", ch: "r" }, typed)).toEqual({ kind: "ui", act: { type: "seedEditChar", ch: "r" } });
    const runUi = { ...ui, screen: "run" as const };
    const run = buildView(game, runUi, bundle);
    expect(mapKey({ kind: "char", ch: "r" }, run)).toEqual({ kind: "ui", act: { type: "openOverlay", overlay: { kind: "relics", page: 0 } } });
    const overlayUi = { ...ui, overlays: [{ kind: "settings" as const }] };
    const overlay = buildView(null, overlayUi, bundle);
    expect(mapKey({ kind: "char", ch: "r" }, overlay)).toBeNull();
    expect(publicUi(null, overlayUi, overlay).controls.some(c => c.label === "Random seed")).toBe(false);
  }
});

test("menu renders the full random seed and shortcut at every supported size", () => {
  const source = entropy(0n);
  const seed = seedToString((1n << 64n) - 1n);
  for (const menuSave of [null, { desc: "Ironclad A5 - Floor 52 - Act 3" }]) {
    const ui = { ...initialUiState({ seed }), menuSave };
    const view = buildView(null, ui, bundle);
    expect(publicUi(null, ui, view).menu?.seed).toBe(seed);
    for (const [cols, rows] of [[80, 24], [100, 30], [120, 36], [132, 45]]) {
      const text = renderFrame(view, { cols: cols!, rows: rows! }, THEME_PLAIN).join("\n");
      expect(text).toContain(seed);
      expect(text).toContain("[s] edit  [r] random");
      expect(text).toContain("[s/r] seed");
      expect(text).toContain("[q] quit");
    }
  }
  expect(source).not.toHaveBeenCalled();
});
