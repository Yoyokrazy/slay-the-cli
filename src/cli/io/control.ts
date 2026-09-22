import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseControlRequest, type ControlAction } from "../state/control";
import type { PublicGameState } from "../state/controlState";
import type { publicUi } from "../state/controlUi";

export interface ControlSnapshotBody {
  state: PublicGameState;
  ui: ReturnType<typeof publicUi> & { running: boolean };
  screenText: string;
}
export interface ControlSnapshot extends ControlSnapshotBody { revision: string }
export type DispatchOutcome = "rejected" | "ui-only" | "applied" | "applied-save-failed";
export interface ControlResult extends ControlSnapshot {
  ok: boolean;
  changed: boolean;
  outcome: DispatchOutcome;
  error?: string;
  paintError?: string;
  beforeRevision: string;
  verification?: {
    action: ControlAction;
    identity: string;
    label?: string;
    deckBefore: NonNullable<PublicGameState>["deck"] | null;
    deckAfter: NonNullable<PublicGameState>["deck"] | null;
  };
}
export interface ControlPort {
  snapshot(): ControlSnapshot;
  act(raw: unknown): ControlResult;
  reject(error: string): ControlResult;
}
export interface DispatchResult {
  ok: boolean;
  outcome?: DispatchOutcome;
  error?: string;
  paintError?: string;
  identity?: string;
  label?: string;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** All callbacks are synchronous: revision check, dispatch, save and paint share one event-loop turn. */
export class LiveController implements ControlPort {
  readonly epoch = randomUUID();
  private sequence = 0;
  private fingerprint = "";
  private attempts = new Map<string, { payload: string; result?: string }>();
  private journalBytes = 0;
  private closed = false;
  constructor(
    private readonly read: () => ControlSnapshotBody,
    private readonly dispatch: (action: ControlAction) => DispatchResult,
    private readonly limits = { entries: 1024, bytes: 32 * 1024 * 1024 },
  ) {}

  snapshot(): ControlSnapshot {
    const snapshot = this.read();
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.sequence++;
    }
    return { ...snapshot, revision: `${this.epoch}:${this.sequence}` };
  }

  close(): void { this.closed = true; }

  reject(error: string): ControlResult {
    const snapshot = this.snapshot();
    return { ok: false, changed: false, outcome: "rejected", error, beforeRevision: snapshot.revision, ...snapshot };
  }

  act(raw: unknown): ControlResult {
    let input;
    let invalid: string | undefined;
    let requestId: string;
    let payload: string;
    try { input = parseControlRequest(raw); }
    catch (error) { invalid = message(error); }
    if (input) {
      requestId = input.requestId;
      payload = JSON.stringify(input);
    } else {
      if (!raw || typeof raw !== "object" || !("requestId" in raw) ||
          typeof raw.requestId !== "string" || !raw.requestId.length || raw.requestId.length > 100) {
        return this.reject(invalid!);
      }
      requestId = raw.requestId;
      try { payload = JSON.stringify(raw); }
      catch { return this.reject("INVALID_REQUEST: not JSON data"); }
    }
    const cached = this.attempts.get(requestId);
    if (cached) {
      if (cached.payload !== payload) return this.reject("REQUEST_ID_REUSED: payload differs");
      if (!cached.result) return this.reject("OUTCOME_UNAVAILABLE: request was already attempted; never replay it");
      return JSON.parse(cached.result) as ControlResult;
    }
    if (this.closed) return this.reject("CLOSED: the app has stopped");
    if (this.attempts.size >= this.limits.entries || this.journalBytes >= this.limits.bytes) {
      return this.reject("JOURNAL_FULL: restart the app for a new epoch; no request IDs are evicted");
    }
    const before = this.snapshot();
    const attempt: { payload: string; result?: string } = { payload };
    this.attempts.set(requestId, attempt);
    this.journalBytes += Buffer.byteLength(payload);
    let dispatched: DispatchResult;
    if (!input) {
      dispatched = { ok: false, error: invalid };
    } else if (input.expectedRevision !== before.revision) {
      dispatched = { ok: false, error: "STALE_REVISION: read fresh live state" };
    } else {
      try { dispatched = this.dispatch(input.action); }
      catch (error) { dispatched = { ok: false, error: message(error) }; }
    }
    const after = this.snapshot();
    const result: ControlResult = {
      ok: dispatched.ok, changed: before.revision !== after.revision,
      outcome: dispatched.outcome ?? (dispatched.ok ? "ui-only" : "rejected"),
      ...(dispatched.error ? { error: dispatched.error } : {}),
      ...(dispatched.paintError ? { paintError: dispatched.paintError } : {}),
      beforeRevision: before.revision, ...after,
      ...(dispatched.identity && input ? { verification: {
        action: input.action, identity: dispatched.identity, label: dispatched.label,
        deckBefore: before.state?.deck ?? null, deckAfter: after.state?.deck ?? null,
      } } : {}),
    };
    const serialized = JSON.stringify(result);
    // Keep every attempted response, including partial failures and stale requests.
    // Crossing the byte budget locks out new IDs rather than evicting old ones.
    attempt.result = serialized;
    this.journalBytes += Buffer.byteLength(serialized);
    return result;
  }
}

export interface ControlServer { close(): Promise<void> }
export const MAX_CONTROL_BODY = 8192;

export async function startControlServer(path: string, port: ControlPort): Promise<ControlServer> {
  if (!isAbsolute(path) || path !== resolve(path) || Buffer.byteLength(path) > 103) {
    throw new Error("SLAY_CONTROL_SOCKET must be an absolute normalized Unix path of at most 103 bytes");
  }
  const parent = dirname(path);
  try { mkdirSync(parent, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const dir = lstatSync(parent);
  if (!dir.isDirectory() || dir.isSymbolicLink() || realpathSync(parent) !== parent ||
      (dir.mode & 0o077) !== 0 || (process.getuid && dir.uid !== process.getuid())) {
    throw new Error("SLAY_CONTROL_SOCKET parent must be a private, owned directory (0700), without symlinks");
  }
  try {
    lstatSync(path);
    throw new Error("SLAY_CONTROL_SOCKET already exists; refusing to unlink it");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const send = (status: number, body: unknown) => {
      if (res.writableEnded) return;
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/state") {
      send(200, port.snapshot()); req.resume(); return;
    }
    if (req.method !== "POST" || req.url !== "/act") {
      send(404, port.reject("UNKNOWN_OPERATION: use GET /state or POST /act")); req.resume(); return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CONTROL_BODY) {
        if (!rejected) send(413, port.reject("REQUEST_TOO_LARGE"));
        rejected = true;
        chunks.length = 0;
      } else if (!rejected) chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
      catch { send(400, port.reject("INVALID_JSON")); return; }
      const result = port.act(body);
      send(result.ok ? 200 : 409, result);
    });
    req.on("error", () => { /* An incomplete request has never reached the dispatcher. */ });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 8;
  server.on("connection", socket => socket.unref());
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolveListen(); });
  });
  const owned = lstatSync(path);
  const cleanup = () => {
    try {
      const current = lstatSync(path);
      if (current.isSocket() && current.dev === owned.dev && current.ino === owned.ino &&
          current.birthtimeMs === owned.birthtimeMs) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  try { chmodSync(path, 0o600); }
  catch (error) { server.close(); cleanup(); throw error; }
  process.once("exit", cleanup);
  let closing: Promise<void> | undefined;
  return {
    close: () => closing ??= new Promise<void>((resolveClose, reject) => {
      let replaced = false;
      try {
        const current = lstatSync(path);
        replaced = !current.isSocket() || current.dev !== owned.dev || current.ino !== owned.ino ||
          current.birthtimeMs !== owned.birthtimeMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") { reject(error); return; }
      }
      if (replaced) {
        // net.Server.close itself unlinks its bound name, even when another
        // file replaced it. Retire the now-unreachable listener until exit
        // instead of letting that runtime cleanup delete an unknown inode.
        process.off("exit", cleanup);
        server.unref();
        resolveClose();
        return;
      }
      server.close(error => {
        process.off("exit", cleanup);
        cleanup();
        if (error) reject(error); else resolveClose();
      });
      server.closeIdleConnections();
    }),
  };
}
