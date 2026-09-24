import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runApp } from "../../src/cli/app";
import { fakeTerminal } from "../../src/cli/term/terminal";
import { startControlServer, type ControlPort, type ControlResult, type ControlSnapshot } from "../../src/cli/io/control";
import type { SaveIo } from "../../src/cli/io/saves";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
function directory() {
  const dir = join(process.cwd(), `.c-${randomUUID().slice(0, 6)}`);
  mkdirSync(dir, { mode: 0o700 });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function call(socketPath: string, method: string, path: string, body?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { "content-type": "application/json" } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
async function live(socketPath: string, signal?: AbortSignal) {
  const term = fakeTerminal();
  let writes = 0;
  const saves: SaveIo = {
    dir: "memory-only", readSave: () => null, writeSave: () => { writes++; }, deleteSave: () => {},
    readPrefs: () => ({}), writePrefs: () => {},
  };
  let ready!: (p: ControlPort) => void;
  const port = new Promise<ControlPort>(resolve => { ready = resolve; });
  const finished = runApp({ term, saves, controlSocket: socketPath, onControlReady: ready, signal });
  const controller = await Promise.race([port, finished.then(() => { throw new Error("app exited before listen"); })]);
  const stop = async () => { term.feed("\x03"); await finished; };
  cleanup.push(stop);
  return { term, controller, stop, finished, writes: () => writes };
}

test("lifecycle abort closes the owned socket without changing the run", async () => {
  const path = join(directory(), "live.sock");
  const lifecycle = new AbortController();
  const app = await live(path, lifecycle.signal);
  lifecycle.abort();
  await app.finished;
  expect(existsSync(path)).toBe(false);
  expect(app.writes()).toBe(0);
  expect(app.controller.snapshot().ui.running).toBe(false);
});

test("private Unix HTTP transport runs live app actions, reports errors and cleans up", async () => {
  const path = join(directory(), "live.sock");
  const app = await live(path);
  expect(lstatSync(path).isSocket()).toBe(true);
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  const initial = (await call(path, "GET", "/state")).body as ControlSnapshot;
  const input = { requestId: "new", expectedRevision: initial.revision, action: { kind: "key", key: "n" } };
  const response = await call(path, "POST", "/act", JSON.stringify(input));
  const result = response.body as ControlResult;
  expect(response.status).toBe(200);
  expect(result.ok).toBe(true);
  expect(result.state?.room.kind).toBe("neow");
  expect(app.writes()).toBe(1);
  expect(app.term.output.at(-1)).toContain("NEOW");
  expect((await call(path, "POST", "/act", JSON.stringify(input))).body).toEqual(result);
  expect(app.writes()).toBe(1);
  const malformed = await call(path, "POST", "/act", "{");
  expect(malformed.status).toBe(400);
  expect((malformed.body as ControlResult).revision).toBe(result.revision);
  const unknown = await call(path, "POST", "/shell", "{}");
  expect(unknown.status).toBe(404);
  expect((unknown.body as ControlResult).ok).toBe(false);
  const oversized = await call(path, "POST", "/act", JSON.stringify({ text: "x".repeat(10000) }));
  expect(oversized.status).toBe(413);
  expect((oversized.body as ControlResult).state?.room.kind).toBe("neow");
  expect(app.writes()).toBe(1);
  await app.stop();
  expect(existsSync(path)).toBe(false);
});

test("a response lost over the socket can be retried without a second action", async () => {
  const path = join(directory(), "live.sock");
  const app = await live(path);
  const before = app.controller.snapshot();
  const input = JSON.stringify({ requestId: "lost", expectedRevision: before.revision, action: { kind: "key", key: "n" } });
  await new Promise<void>((resolve, reject) => {
    const req = request({ socketPath: path, method: "POST", path: "/act" }, res => {
      res.destroy();
      resolve();
    });
    req.on("error", reject);
    req.end(input);
  });
  const retry = (await call(path, "POST", "/act", input)).body as ControlResult;
  expect(retry.ok).toBe(true);
  expect(retry.state?.room.kind).toBe("neow");
  expect(app.writes()).toBe(1);
});

test("existing files, sockets, unsafe directories and symlinks are never replaced", async () => {
  const dir = directory();
  const file = join(dir, "keep");
  writeFileSync(file, "do not remove");
  const running = await live(join(dir, "l.sock"));
  await expect(startControlServer(file, running.controller)).rejects.toThrow("already exists");
  expect(readFileSync(file, "utf8")).toBe("do not remove");
  const inode = lstatSync(join(dir, "l.sock")).ino;
  await expect(startControlServer(join(dir, "l.sock"), running.controller)).rejects.toThrow("already exists");
  expect(lstatSync(join(dir, "l.sock")).ino).toBe(inode);
  const unsafe = join(dir, "u");
  mkdirSync(unsafe, { mode: 0o755 });
  chmodSync(unsafe, 0o755);
  await expect(startControlServer(join(unsafe, "s"), running.controller)).rejects.toThrow("private");
  const alias = join(dir, "a");
  symlinkSync(dir, alias);
  await expect(startControlServer(join(alias, "s"), running.controller)).rejects.toThrow("private");
  await expect(startControlServer("relative.sock", running.controller)).rejects.toThrow("absolute");
});

test("transport observes manual UI input before accepting a stale request", async () => {
  const path = join(directory(), "live.sock");
  const app = await live(path);
  const before = (await call(path, "GET", "/state")).body as ControlSnapshot;
  app.term.feed("s");
  const failed = (await call(path, "POST", "/act", JSON.stringify({
    requestId: "stale", expectedRevision: before.revision, action: { kind: "key", key: "n" },
  }))).body as ControlResult;
  expect(failed.ok).toBe(false);
  expect(failed.error).toContain("STALE_REVISION");
  expect(failed.ui.mode).toBe("textInput");
  expect(app.writes()).toBe(0);
});

test("shutdown does not remove a file that replaced the owned socket", async () => {
  const path = join(directory(), "live.sock");
  const app = await live(path);
  unlinkSync(path);
  writeFileSync(path, "replacement");
  await app.stop();
  expect(readFileSync(path, "utf8")).toBe("replacement");
});
