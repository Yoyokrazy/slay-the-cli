// The app loop: owns the GameState + UiState pair, turns key bytes into
// actions (keymap), engine Commands into advance() + save-per-advance, and
// repaints a full frame per keypress (synchronized output, no diffing).

import { createRun, advance, type GameState, type Command, type GameEvent } from "../engine/game";
import { buildBaseContentBundle } from "../content";
import type { ContentBundle } from "../engine/content/defs";
import type { TerminalPort } from "./term/terminal";
import { parseKeys, type Key } from "./term/keys";
import { SYNC_START, SYNC_END, CURSOR_HOME, CLEAR_TO_EOL } from "./term/ansi";
import { renderFrame } from "./render/frame";
import { THEME_256, THEME_PLAIN, type Theme } from "./render/theme";
import { buildView } from "./state/view";
import { initialUiState, resetRunUi, pushLog, pushLogLines, applyUiAction, type UiState } from "./state/uiState";
import { mapKey } from "./input/keymap";
import { isAppAction, type AppUiAction, type KeyAction } from "./input/actions";
import { LiveController, startControlServer, type ControlPort, type ControlServer, type DispatchResult } from "./io/control";
import { controlSafeView, publicGameState } from "./state/controlState";
import { publicUi, resolveControl } from "./state/controlUi";
import {
  bumpSeed,
  cardName,
  chestLootSummary,
  clampAscension,
  eventScope,
  isCharacterId,
  type UICharacterId,
} from "./text/runlogic";
import type { SaveIo } from "./io/saves";
import { randomSeed } from "./io/seed";

export interface AppOptions {
  seed?: string;
  character?: UICharacterId;
  ascension?: number;
  noColor?: boolean;
}

export interface AppDeps {
  term: TerminalPort;
  saves: SaveIo;
  options?: AppOptions;
  bundle?: ContentBundle;
  /** startup update check result (main.ts does the io; see io/update.ts) */
  update?: { behind: number } | null;
  /** Opt-in live control. No save reads or terminal injection by the transport. */
  controlSocket?: string;
  onControlReady?: (port: ControlPort) => void;
  signal?: AbortSignal;
}

export interface AppResult {
  game: GameState | null;
  ui: UiState;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function runApp(deps: AppDeps): Promise<AppResult> {
  const { term, saves } = deps;
  const options = deps.options ?? {};
  const bundle = deps.bundle ?? buildBaseContentBundle();
  const prefs = saves.readPrefs();
  const theme: Theme = options.noColor === true || prefs.color === false ? THEME_PLAIN : THEME_256;
  let game: GameState | null = null;
  let ui: UiState = initialUiState({
    seed: options.seed ?? prefs.seed,
    character: options.character ?? prefs.character,
    ascension: options.ascension ?? prefs.ascension,
    update: deps.update ?? null,
    vimKeys: prefs.vimKeys ?? false,
  });

  /** prefs.json is the menu's memory: whatever the next launch should come
   *  back to. Written on a new run and whenever a setting is flipped. */
  const savePrefs = (): void => {
    saves.writePrefs({
      seed: ui.seed,
      character: ui.character,
      ascension: ui.ascension,
      color: theme !== THEME_PLAIN,
      vimKeys: ui.vimKeys,
    });
  };

  const refreshMenuSave = (): void => {
    const saved = saves.readSave();
    if (!saved) {
      ui = { ...ui, menuSave: null };
      return;
    }
    const name = bundle.characters.get(saved.run.character)?.name ?? saved.run.character;
    const desc =
      saved.run.room?.kind === "gameOver"
        ? "run over"
        : `${name} A${saved.run.ascension} - Floor ${saved.run.floor} - Act ${saved.run.act}`;
    ui = { ...ui, menuSave: { desc } };
  };
  refreshMenuSave();

  /** Monster roster by slot, so the log names creatures instead of "Enemy 1".
   *  The killing blow clears the combat, so the pre-advance state is the
   *  fallback - otherwise the last line of every fight loses its name. */
  const rosterOf = (from: GameState | null): string[] =>
    (from?.combat?.monsters ?? []).map((m) => bundle.monsters.get(m.id)?.name ?? m.id);

  const absorbEvents = (events: GameEvent[], was: GameState | null = null): void => {
    const live = rosterOf(game);
    ui = pushLog(ui, events, bundle, live.length > 0 ? live : rosterOf(was), eventScope(game));
    // a card that lands in the deck with no screen of its own (Neow's random
    // rare, a Neow curse) is otherwise invisible: say so on the hint line
    const gained: string[] = [];
    for (const ev of events) {
      if (ev.event !== "deckCardObtained") continue;
      const p = (ev.payload ?? {}) as { defId?: string; upgrades?: number };
      gained.push(cardName(bundle, p.defId ?? "?", p.upgrades ?? 0));
    }
    if (gained.length > 0) ui = { ...ui, toast: `Obtained ${gained.join(", ")}` };
  };

  const paint = (): void => {
    const cols = term.cols() || 80;
    const rows = term.rows() || 24;
    const view = buildView(game, ui, bundle);
    const lines = renderFrame(view, { cols, rows }, theme);
    const frame = SYNC_START + CURSOR_HOME + lines.map((l) => l + CLEAR_TO_EOL).join("\r\n") + SYNC_END;
    term.write(frame);
  };

  const failure = (error: unknown): DispatchResult => {
    const msg = errMsg(error);
    ui = { ...ui, toast: /invariant/i.test(msg) ? "That can't be used right now" : msg };
    return { ok: false, error: msg };
  };

  const persistRun = (state: GameState): void => {
    if (saves.writeSaveChecked) saves.writeSaveChecked(state);
    else saves.writeSave(state);
  };
  const deleteRunSave = (): void => {
    if (saves.deleteSaveChecked) saves.deleteSaveChecked();
    else saves.deleteSave();
  };

  const doAdvance = (cmd: Command): DispatchResult => {
    if (!game) return failure("No live game");
    const prev = game;
    ui = { ...ui, targeting: null };
    let applied = false;
    let saving = false;
    try {
      const next = advance(game, cmd, bundle);
      game = next;
      applied = true;
      // overlays are the means of picking a command - a successful advance
      // closes them (the web UI closed its menus before advancing too)
      ui = { ...ui, choiceSel: [], choicePage: 0, overlays: [] };
      absorbEvents(next.eventLog, prev);
      if (cmd.cmd === "openChest" || cmd.cmd === "takeChestRelic" || cmd.cmd === "takeSapphireKey") {
        ui = { ...ui, lastLoot: chestLootSummary(prev, next, bundle) };
      } else if (cmd.cmd === "proceed" || cmd.cmd === "mapPick") {
        ui = { ...ui, lastLoot: null };
      }
      if (prev.run.room?.kind !== next.run.room?.kind) {
        ui = { ...ui, page: 0, mapScroll: 0, focus: null };
      }
      saving = true;
      if (next.run.room?.kind === "gameOver") {
        deleteRunSave();
      } else {
        persistRun(next);
      }
      return { ok: true, outcome: "applied" };
    } catch (e) {
      return { ...failure(e), outcome: applied ? saving ? "applied-save-failed" : "applied" : "rejected" };
    }
  };

  const newRun = (): DispatchResult => {
    savePrefs();
    let created: GameState;
    try {
      created = createRun({ seed: ui.seed, bundle, character: ui.character, ascension: ui.ascension });
    } catch (e) {
      return failure(e);
    }
    game = created;
    ui = resetRunUi({ ...ui, screen: "run", log: [] });
    absorbEvents(created.eventLog);
    try { persistRun(created); }
    catch (error) { return { ...failure(error), outcome: "applied-save-failed" }; }
    return { ok: true, outcome: "applied" };
  };

  const continueRun = (): DispatchResult => {
    const restored = saves.readSave();
    if (!restored) {
      return failure("No valid saved run found");
    }
    const prevGame = game;
    const prevUi = ui;
    game = restored;
    ui = resetRunUi({
      ...ui,
      screen: "run",
      seed: restored.seed,
      character: isCharacterId(restored.run.character) ? restored.run.character : ui.character,
      ascension: clampAscension(restored.run.ascension),
    });
    ui = pushLogLines(ui, ["(restored saved run)"]);
    try {
      const scope = eventScope(restored);
      if (scope && !ui.log.some(line => line.eventScope === scope)) {
        ui = pushLog(ui, restored.eventLog.filter(event => event.event === "eventReveal"), bundle, [], scope);
      }
      // stale/incompatible saves from an older engine build blow up on first
      // render - probe once, discard and recover to the menu if so
      renderFrame(buildView(game, ui, bundle), { cols: 100, rows: 30 }, THEME_PLAIN);
    } catch {
      game = prevGame;
      ui = { ...prevUi, screen: "menu", menuSave: null, toast: "Saved run was from an older version - it was discarded" };
      try { deleteRunSave(); }
      catch (error) { return failure(`Saved run is incompatible; could not discard it: ${errMsg(error)}`); }
      return { ok: false, error: ui.toast! };
    }
    return { ok: true, outcome: "applied" };
  };

  const backToMenu = (): void => {
    ui = resetRunUi({ ...ui, screen: "menu" });
    refreshMenuSave();
  };

  const rerun = (): DispatchResult => {
    if (!game) return failure("No live game");
    ui = {
      ...ui,
      seed: bumpSeed(game.seed),
      character: isCharacterId(game.run.character) ? game.run.character : ui.character,
      ascension: clampAscension(game.run.ascension),
    };
    return newRun();
  };

  return new Promise<AppResult>((resolve, reject) => {
    let done = false;
    let server: ControlServer | undefined;
    let control: LiveController | undefined;
    const quit = (): void => {
      if (done) return;
      done = true;
      deps.signal?.removeEventListener("abort", quit);
      term.restore();
      control?.close();
      if (server) void server.close().then(() => resolve({ game, ui }), reject);
      else resolve({ game, ui });
    };

    const handleAppAction = (act: AppUiAction): DispatchResult => {
      switch (act.type) {
        case "randomSeed":
          ui = { ...ui, seed: randomSeed() };
          return { ok: true, outcome: "ui-only" };
        case "newRun":
          return newRun();
        case "continueRun":
          return continueRun();
        case "backToMenu":
          backToMenu();
          return { ok: true, outcome: "ui-only" };
        case "rerun":
          return rerun();
        case "quit":
          quit();
          return { ok: true, outcome: "ui-only" };
      }
    };

    const dispatch = (action: KeyAction): DispatchResult => {
      ui = { ...ui, toast: null };
      try {
        if (action.kind === "cmd") {
          return doAdvance(action.cmd);
        } else if (isAppAction(action.act)) {
          return handleAppAction(action.act);
        } else {
          ui = applyUiAction(ui, action.act);
          if (action.act.type === "toggleVimKeys") savePrefs();
          if (ui.toast) return { ok: false, error: ui.toast };
          return { ok: true, outcome: "ui-only" };
        }
      } catch (error) { return failure(error); }
    };

    const finishInput = (result: DispatchResult): DispatchResult => {
      try { if (!done) paint(); }
      catch (error) {
        const paintError = errMsg(error);
        failure(error);
        result = { ...result, ok: false, paintError, error: result.error ? `${result.error}; paint: ${paintError}` : paintError };
      }
      // Observe every input, not merely reads: away-and-back manual navigation
      // must still invalidate a revision a remote caller already holds.
      control?.snapshot();
      return result;
    };

    const handleKey = (key: Key): void => {
      ui = { ...ui, toast: null };
      if (key.kind === "ctrlC") {
        quit();
        return;
      }
      const action = mapKey(key, buildView(game, ui, bundle));
      finishInput(action ? dispatch(action) : { ok: false, error: "No action for this key" });
    };

    if (deps.controlSocket !== undefined || deps.onControlReady) {
      control = new LiveController(() => {
        const view = controlSafeView(buildView(game, ui, bundle));
        return {
          state: publicGameState(game, bundle, view),
          ui: { ...publicUi(game, ui, view), running: !done },
          screenText: renderFrame(view, { cols: term.cols() || 80, rows: term.rows() || 24 }, THEME_PLAIN).join("\n"),
        };
      }, action => {
        if (done) return { ok: false, error: "CLOSED: the app has stopped" };
        try {
          const resolved = resolveControl(action, game, ui, controlSafeView(buildView(game, ui, bundle)), bundle);
          return { ...finishInput(dispatch(resolved.action)), identity: resolved.identity, label: resolved.label };
        } catch (error) {
          return finishInput(failure(error));
        }
      });
    }

    const start = (): void => {
      if (deps.signal?.aborted) { quit(); return; }
      deps.signal?.addEventListener("abort", quit, { once: true });
      term.setup();
      paint();
      control?.snapshot();
      term.onResize(() => {
        if (!done) { paint(); control?.snapshot(); }
      });
      // fakeTerminal may deliver a complete script synchronously here.
      term.onData(chunk => {
        for (const key of parseKeys(chunk)) {
          if (done) break;
          handleKey(key);
        }
      });
      if (control) deps.onControlReady?.(control);
    };
    if (deps.controlSocket !== undefined && control) {
      void startControlServer(deps.controlSocket, control).then(bound => {
        server = bound;
        try { start(); }
        catch (error) { term.restore(); void bound.close().finally(() => reject(error)); }
      }, reject);
    } else {
      try { start(); }
      catch (error) {
        term.restore();
        reject(error);
      }
    }
  });
}
