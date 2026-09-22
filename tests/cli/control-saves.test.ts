import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCombatGame, createRun } from "../../src/engine/game";
import { buildBaseContentBundle } from "../../src/content";
import { runApp } from "../../src/cli/app";
import { fakeTerminal } from "../../src/cli/term/terminal";
import { makeSaveIo } from "../../src/cli/io/saves";
import type { ControlPort } from "../../src/cli/io/control";

const bundle = buildBaseContentBundle();
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
function storage() {
  const dir = join(process.cwd(), `.ctl-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { mode: 0o700 });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, saves: makeSaveIo(dir) };
}
function start(saves: ReturnType<typeof makeSaveIo>) {
  const term = fakeTerminal();
  let port: ControlPort | undefined;
  const finished = runApp({ term, saves, bundle, onControlReady: p => { port = p; } });
  if (!port) throw new Error("control was not initialized");
  cleanup.push(async () => { term.feed("\x03"); await finished; });
  return { term, port };
}

test("checked persistence writes, backs up and deletes only synthetic project-local saves", () => {
  const { dir, saves } = storage();
  const game = createRun({ seed: "CHECKED-SAVE", character: "IRONCLAD", bundle });
  saves.writeSaveChecked!(game);
  expect(saves.readSave()).toEqual(game);
  saves.writeSaveChecked!(game);
  expect(existsSync(join(dir, "save.json.bak"))).toBe(true);
  saves.deleteSaveChecked!();
  expect(existsSync(join(dir, "save.json"))).toBe(false);
  expect(existsSync(join(dir, "save.json.bak"))).toBe(false);
});

test("legacy best-effort persistence stays compatible but checked writes throw", () => {
  const { dir, saves } = storage();
  mkdirSync(join(dir, "save.json"));
  const game = createRun({ seed: "CHECKED-FAIL", character: "IRONCLAD", bundle });
  expect(() => saves.writeSave(game)).not.toThrow();
  expect(() => saves.writeSaveChecked!(game)).toThrow();
  expect(() => saves.deleteSave()).not.toThrow();
  expect(() => saves.deleteSaveChecked!()).toThrow();
});

test("the live app reports actual filesystem write failure after creating the run", () => {
  const { dir, saves } = storage();
  mkdirSync(join(dir, "save.json"));
  const { term, port } = start(saves);
  const request = {
    requestId: "write-failure", expectedRevision: port.snapshot().revision,
    action: { kind: "key", key: "n" },
  };
  const result = port.act(request);
  expect(result.ok).toBe(false);
  expect(result.outcome).toBe("applied-save-failed");
  expect(result.changed).toBe(true);
  expect(result.state?.room.kind).toBe("neow");
  expect(result.ui.toast).not.toBeNull();
  expect(term.output.at(-1)).toContain("NEOW");
  expect(saves.readSave()).toBeNull();
  expect(port.act(request)).toEqual(result);
});

test("a game-over deletion failure keeps the live outcome and reports partial persistence", () => {
  const { dir, saves } = storage();
  const game = createCombatGame({
    seed: "DELETE-FAIL", bundle, character: "IRONCLAD",
    deck: Array.from({ length: 6 }, () => ({ defId: "STRIKE_RED" })), monsters: ["JAW_WORM"],
  });
  game.run.act = 4;
  game.run.room = { kind: "combat", roomKind: "boss", encounterId: "test", burningElite: false };
  game.combat!.monsters[0]!.hp = 1;
  saves.writeSaveChecked!(game);
  const { term, port } = start(saves);
  term.feed("c");
  mkdirSync(join(dir, "save.json.bak"));
  writeFileSync(join(dir, "save.json.bak", "sentinel"), "synthetic obstruction");
  const before = port.snapshot();
  const result = port.act({
    requestId: "delete-failure", expectedRevision: before.revision,
    action: { kind: "play", iid: before.state!.combat!.hand[0]!.iid, target: 1 },
  });
  expect(result.ok).toBe(false);
  expect(result.outcome).toBe("applied-save-failed");
  expect(result.state?.room.kind).toBe("gameOver");
  expect(result.ui.screen).toBe("gameOver");
  expect(existsSync(join(dir, "save.json"))).toBe(false);
  expect(existsSync(join(dir, "save.json.bak", "sentinel"))).toBe(true);
});
