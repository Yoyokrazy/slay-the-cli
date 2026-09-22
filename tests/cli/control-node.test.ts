import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runApp } from "../../src/cli/app";
import { fakeTerminal } from "../../src/cli/term/terminal";
import type { ControlPort, ControlResult, ControlSnapshot } from "../../src/cli/io/control";

// Also run directly with: node --import tsx --test tests/cli/control-node.test.ts
test("Node/tsx: live socket, manual staleness, shared dispatch, retry and cleanup", async () => {
  const dir = join(process.cwd(), `.ctl-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { mode: 0o700 });
  const socketPath = join(dir, "node.sock");
  const term = fakeTerminal();
  let ready!: (port: ControlPort) => void;
  const started = new Promise<ControlPort>(resolve => { ready = resolve; });
  let writes = 0;
  const finished = runApp({
    term, controlSocket: socketPath, onControlReady: ready,
    saves: {
      dir: "memory-only", readSave: () => null, readPrefs: () => ({}), writePrefs: () => {},
      deleteSave: () => {}, writeSave: () => { writes++; },
    },
  });
  const call = (body?: object): Promise<unknown> => new Promise((resolve, reject) => {
    const req = request({ socketPath, method: body ? "POST" : "GET", path: body ? "/act" : "/state" }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString()) as unknown));
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    await Promise.race([started, finished.then(() => { throw new Error("app stopped"); })]);
    const before = await call() as ControlSnapshot;
    assert.equal(before.ui.mode, "menu");
    term.feed("\t");
    const stale = await call({
      requestId: "stale", expectedRevision: before.revision, action: { kind: "key", key: "n" },
    }) as ControlResult;
    assert.equal(stale.ok, false);
    assert.match(stale.error!, /STALE_REVISION/);
    const input = { requestId: "new", expectedRevision: stale.revision, action: { kind: "key", key: "n" } };
    const result = await call(input) as ControlResult;
    assert.equal(result.ok, true);
    assert.equal(result.state?.room.kind, "neow");
    assert.equal(writes, 1);
    assert.deepEqual(await call(input), result);
    assert.equal(writes, 1);
    assert.match(term.output.at(-1)!, /NEOW/);
  } finally {
    term.feed("\x03");
    await finished;
    assert.equal(existsSync(socketPath), false);
    rmSync(dir, { recursive: true, force: true });
  }
});
