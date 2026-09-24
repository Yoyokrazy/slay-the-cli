import { afterEach, expect, test } from "bun:test";
import { advance, createCombatGame, createRun, type GameState } from "../../src/engine/game";
import { buildBaseContentBundle } from "../../src/content";
import { runApp } from "../../src/cli/app";
import { fakeTerminal } from "../../src/cli/term/terminal";
import type { SaveIo } from "../../src/cli/io/saves";
import { LiveController, type ControlPort } from "../../src/cli/io/control";
import { buildView } from "../../src/cli/state/view";
import { applyUiAction, initialUiState, pushLog, type UiState } from "../../src/cli/state/uiState";
import { controlSafeView, publicGameState } from "../../src/cli/state/controlState";
import { liveControls, resolveControl } from "../../src/cli/state/controlUi";
import { mapKey } from "../../src/cli/input/keymap";
import type { ControlAction } from "../../src/cli/state/control";
import { getCardCost } from "../../src/engine/combat/preview";
import { eventScope } from "../../src/cli/text/runlogic";

const bundle = buildBaseContentBundle();
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); });

function memoryEvent() {
  const game = createRun({ seed: "EVENT-FEEDBACK-TEST", bundle, character: "IRONCLAD" });
  game.run.room = {
    kind: "event", eventId: "MATCH_AND_KEEP", data: {
      cards: ["WARCRY", "DEFEND_RED", "FEED", "FIEND_FIRE", "SECRET_TECHNIQUE", "CLASH"],
      board: [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5],
      matched: Array.from({ length: 12 }, () => false), attempts: 0, first: null,
    },
  };
  return game;
}

function combat(deck = Array.from({ length: 8 }, () => "STRIKE_RED")) {
  const game = createCombatGame({
    seed: "CONTROL-TEST", bundle, character: "IRONCLAD",
    deck: deck.map(defId => ({ defId })),
    monsters: ["JAW_WORM", "CULTIST", "CULTIST"],
  });
  game.run.room = { kind: "combat", roomKind: "monster", encounterId: "test", burningElite: false };
  return game;
}

function arrangePiles(
  game: GameState,
  piles: Partial<Record<"draw" | "discard" | "exhaust", { defId: string; upgrades?: number }[]>>,
) {
  const c = game.combat!;
  const available = [
    ...c.player.piles.draw,
    ...c.player.piles.hand,
    ...c.player.piles.discard,
    ...c.player.piles.exhaust,
    ...c.player.piles.limbo,
  ];
  let cursor = 0;
  for (const pile of ["draw", "discard", "exhaust"] as const) {
    const cards = piles[pile] ?? [];
    const iids = available.slice(cursor, cursor + cards.length);
    if (iids.length !== cards.length) throw new Error(`Not enough card instances for ${pile}`);
    c.player.piles[pile] = iids;
    cards.forEach((cardSpec, i) => {
      const card = c.cards[iids[i]!]!;
      card.defId = cardSpec.defId;
      card.upgrades = cardSpec.upgrades ?? 0;
    });
    cursor += cards.length;
  }
  c.player.piles.hand = available.slice(cursor);
  c.player.piles.limbo = [];
}

function app(initial: GameState | null = null) {
  let saved = initial;
  let writes = 0;
  let deletes = 0;
  let failSave = false;
  const saves: SaveIo = {
    dir: "memory-only", readSave: () => saved, readPrefs: () => ({}), writePrefs: () => {},
    writeSave: game => { writes++; if (failSave) throw new Error("synthetic save failure"); saved = game; },
    deleteSave: () => { deletes++; saved = null; },
  };
  const term = fakeTerminal();
  let port: ControlPort | undefined;
  const finished = runApp({ term, saves, bundle, onControlReady: p => { port = p; } });
  if (!port) throw new Error("control was not initialized");
  const controller = port;
  cleanup.push(async () => { term.feed("\x03"); return finished; });
  if (initial) term.feed("c");
  let request = 0;
  const act = (action: ControlAction, revision = controller.snapshot().revision) =>
    controller.act({ requestId: `r${++request}`, expectedRevision: revision, action });
  return { term, port: controller, act, saves, writes: () => writes, deletes: () => deletes, failSave: () => { failSave = true; } };
}

test("live menu, seed entry, semantic selection, manual staleness and UI-only revisions", () => {
  const a = app();
  const initial = a.port.snapshot();
  expect(initial.state).toBeNull();
  expect(initial.ui.mode).toBe("menu");
  expect(initial.screenText).toContain("NEW RUN");
  const hero = initial.ui.controls.find(c => c.id.endsWith("character:SILENT"))!;
  const selected = a.act({ kind: "select", id: hero.id });
  expect(selected.ok).toBe(true);
  expect(selected.outcome).toBe("ui-only");
  expect(selected.ui.menu?.character).toBe("SILENT");
  expect(selected.ui.selected).toContain(hero.id);
  expect(selected.verification?.identity).toBe(hero.id);
  a.term.feed("\x1b[B");
  a.term.feed("\x1b[A");
  expect(a.act({ kind: "key", key: "ENTER" }, selected.revision).error).toContain("STALE_REVISION");
  expect(a.writes()).toBe(0);
  expect(a.act({ kind: "key", key: "s" }).ui.mode).toBe("textInput");
  const typed = a.act({ kind: "key", key: "Z" });
  expect(typed.ui.menu?.seedEdit).toContain("Z");
  expect(typed.changed).toBe(true);
  expect(a.act({ kind: "key", key: "ESC" }).ui.mode).toBe("menu");
  const preResize = a.port.snapshot().revision;
  a.term.resize(120, 36);
  expect(a.port.snapshot().revision).not.toBe(preResize);
});

test("Match and Keep shows public pair history and attempts without exposing face-down cards", () => {
  const a = app(memoryEvent());
  a.term.resize(80, 24);
  const flip = (slot: number) => {
    const control = a.port.snapshot().ui.controls.find(c => c.id.endsWith(`:MATCH_AND_KEEP:start:${slot}`));
    if (!control) throw new Error(`Missing flip control for slot ${slot}`);
    return a.act({ kind: "select", id: control.id });
  };
  const start = a.port.snapshot();
  expect(start.screenText).toContain("Attempts left: 5");
  expect(start.screenText).not.toContain("Warcry");
  const first = flip(0);
  expect(first.ok).toBe(true);
  expect(first.screenText).toContain("Card 1: Warcry");
  expect(first.screenText).not.toContain("Card 2: Defend");
  const mismatch = flip(1);
  expect(mismatch.ok).toBe(true);
  expect(mismatch.screenText).toContain("Attempts left: 4");
  expect(mismatch.screenText).toContain("Revealed: Warcry, Defend");
  expect(mismatch.state).toHaveProperty("room.eventView.body", ["Attempts left: 4", "Revealed: Warcry, Defend"]);
  expect(mismatch.ui.controls.filter(c => c.label.startsWith("Flip card"))).toHaveLength(10);
  expect(mismatch.screenText).not.toContain("Card 1: Warcry");
  expect(mismatch.screenText).not.toContain("Card 2: Defend");

  // The previous pair remains observable even after the next first flip clears eventLog.
  expect(flip(2).screenText).toContain("Revealed: Warcry, Defend");
  const secondMismatch = flip(3);
  expect(secondMismatch.screenText).toContain("Attempts left: 3");
  expect(secondMismatch.screenText).toContain("Revealed: Warcry, Defend");
  expect(secondMismatch.screenText).toContain("Revealed: Feed, Fiend Fire");
  expect(secondMismatch.state).toHaveProperty("room.eventView.body", [
    "Attempts left: 3", "Revealed: Warcry, Defend", "Revealed: Feed, Fiend Fire",
  ]);
  for (const publicText of [secondMismatch.screenText, JSON.stringify(secondMismatch.state?.room)]) {
    expect(publicText).not.toContain("Secret Technique");
    expect(publicText).not.toContain("SECRET_TECHNIQUE");
    expect(publicText).not.toContain("Clash");
    expect(publicText).not.toContain('"board"');
    expect(publicText).not.toContain('"matched"');
  }
  for (const size of [{ cols: 100, rows: 30 }, { cols: 132, rows: 45 }]) {
    a.term.resize(size.cols, size.rows);
    expect(a.port.snapshot().screenText).toContain("Revealed: Feed, Fiend Fire");
  }
  const beforeReads = a.port.snapshot();
  expect(a.port.snapshot()).toEqual(beforeReads);
  a.term.resize(80, 24);
  for (let attempt = 0; attempt < 2; attempt++) { flip(0); flip(1); }
  const lastAttempt = a.port.snapshot();
  expect(lastAttempt.screenText).toContain("Attempts left: 1");
  expect(lastAttempt.screenText).toContain("[0] Flip card 10");
  expect(lastAttempt.screenText).toContain("page 1/2");
  expect(lastAttempt.screenText.split("\n")).toHaveLength(24);
  expect(/^[\x00-\x7f]*$/.test(lastAttempt.screenText)).toBe(true);
});

test("Match and Keep projection can recover only the last public reveal from in-memory state", () => {
  let game = memoryEvent();
  game = advance(game, { cmd: "eventOption", i: 0 }, bundle);
  game = advance(game, { cmd: "eventOption", i: 1 }, bundle);
  const before = structuredClone(game);
  const view = buildView(game, { ...initialUiState(), screen: "run" }, bundle);
  expect(publicGameState(game, bundle, view)).toHaveProperty("room.eventView.body", [
    "Attempts left: 4", "Revealed: Warcry, Defend",
  ]);
  expect(game).toEqual(before);
  const a = app(game);
  const next = a.port.snapshot().ui.controls.find(c => c.id.endsWith(":MATCH_AND_KEEP:start:2"))!;
  const firstFlip = a.act({ kind: "select", id: next.id });
  expect(firstFlip.ok).toBe(true);
  expect(firstFlip.state).toHaveProperty("room.eventView.body", ["Attempts left: 4", "Revealed: Warcry, Defend"]);
});

test("event reveal history never crosses a room or run boundary", () => {
  const game = memoryEvent();
  const ui = pushLog({ ...initialUiState(), screen: "run" }, [
    { event: "eventReveal", payload: { cards: ["WARCRY", "DEFEND_RED"] } },
  ], bundle, [], eventScope(game));
  const before = structuredClone({ game, ui });
  expect(publicGameState(game, bundle, buildView(game, ui, bundle))).toHaveProperty("room.eventView.body", [
    "Attempts left: 5", "Revealed: Warcry, Defend",
  ]);
  for (const change of [
    (next: GameState) => { next.run.floor++; },
    (next: GameState) => { next.run.act = 2; },
    (next: GameState) => { next.seed = "OTHER-RUN"; },
  ]) {
    const next = structuredClone(game);
    change(next);
    expect(publicGameState(next, bundle, buildView(next, ui, bundle))).toHaveProperty("room.eventView.body", ["Attempts left: 5"]);
  }
  expect({ game, ui }).toEqual(before);
});

test("semantic combat play resolves a visible slot to original living enemy index", () => {
  const game = combat();
  game.combat!.monsters[0]!.isDead = true;
  game.combat!.monsters[0]!.hp = 0;
  const a = app(game);
  const before = a.port.snapshot();
  expect(before.state?.combat?.enemies.map(e => e.index)).toEqual([1, 2]);
  const iid = before.state!.combat!.hand[0]!.iid;
  const played = a.act({ kind: "play", iid, target: 2 });
  expect(played.ok).toBe(true);
  expect(played.outcome).toBe("applied");
  expect(played.state!.combat!.enemies[0]!.hp).toBe(before.state!.combat!.enemies[0]!.hp);
  expect(played.state!.combat!.enemies[1]!.hp).toBeLessThan(before.state!.combat!.enemies[1]!.hp);
  expect(played.state!.combat!.hand.some(c => c.iid === iid)).toBe(false);
  expect(a.writes()).toBe(1);
  expect(a.term.output.at(-1)).toContain("\x1b[?2026h");
});

test("Corruption costs agree across hand, inspect, public state and zero-energy play", () => {
  const game = createCombatGame({
    seed: "COST-TEST", bundle, character: "IRONCLAD",
    deck: Array.from({ length: 5 }, () => ({ defId: "DEFEND_RED" })),
    monsters: ["JAW_WORM"],
  });
  game.run.room = { kind: "combat", roomKind: "monster", encounterId: "test", burningElite: false };
  const c = game.combat!;
  c.player.energy = 0;
  c.player.powers.push({ id: "CORRUPTION", amount: 1, justApplied: false, data: null });
  const before = structuredClone(game);
  const view = buildView(game, { ...initialUiState(), screen: "run" }, bundle);
  expect(view.screen.kind).toBe("combat");
  if (view.screen.kind !== "combat") throw new Error("expected combat");
  expect(view.screen.hand.every(card => card.cost === "0" && card.playable)).toBe(true);
  expect(publicGameState(game, bundle, view)?.combat?.hand.every(card => card.cost === 0 && card.playable)).toBe(true);
  expect(game).toEqual(before);
  const a = app(game);
  const iid = c.player.piles.hand[0]!;
  const inspect = a.act({ kind: "key", key: "i" });
  expect(inspect.ok).toBe(true);
  expect(inspect.screenText).toContain("(0)");
  a.act({ kind: "key", key: "ESC" });
  const played = a.act({ kind: "play", iid });
  expect(played.ok).toBe(true);
  expect(played.state?.combat?.energy).toBe(0);
  expect(played.state?.combat?.block).toBe(5);
  expect(played.state?.combat?.piles.exhaust).toBe(1);
});

test("cost previews preserve sentinel costs and isolate dynamic cost hooks", () => {
  const game = combat();
  const card = game.combat!.cards[game.combat!.player.piles.hand[0]!]!;
  card.freeToPlayOnce = true;
  expect(getCardCost(game, bundle, card)).toBe(0);
  for (const sentinel of [-1, -2]) {
    card.cost = sentinel;
    expect(getCardCost(game, bundle, card)).toBe(sentinel);
  }
  card.cost = 1;
  card.freeToPlayOnce = false;
  const local = buildBaseContentBundle();
  const def = local.cards.get(card.defId)!;
  local.cards.set(card.defId, { ...def, dynamicCost: ctx => {
    ctx.run.gold = 0;
    return 2;
  } });
  const before = structuredClone(game);
  expect(getCardCost(game, local, card)).toBe(2);
  expect(game).toEqual(before);
  local.cards.set(card.defId, { ...def, dynamicCost: ctx => {
    ctx.rng("mathUtilRng");
    return 0;
  } });
  expect(() => getCardCost(game, local, card)).toThrow("rng not available");
  expect(game).toEqual(before);
});

for (const { id, companion, inDraw, playable } of [
  { id: "CLASH", companion: "DEFEND_RED", inDraw: false, playable: false },
  { id: "CLASH", companion: "DEMON_FORM", inDraw: false, playable: false },
  { id: "CLASH", companion: "WOUND", inDraw: false, playable: false },
  { id: "CLASH", companion: "NORMALITY", inDraw: false, playable: false },
  { id: "CLASH", companion: "STRIKE_RED", inDraw: false, playable: true },
  { id: "SIGNATURE_MOVE", companion: "STRIKE_RED", inDraw: false, playable: false },
  { id: "SIGNATURE_MOVE", companion: "DEFEND_RED", inDraw: false, playable: true },
  { id: "GRAND_FINALE", companion: "DEFEND_RED", inDraw: true, playable: false },
  { id: "GRAND_FINALE", companion: "DEFEND_RED", inDraw: false, playable: true },
]) {
  test(`${id} with ${companion} in ${inDraw ? "draw" : "hand"} agrees with engine canUse`, () => {
    for (const upgrades of [0, 1]) {
      const game = combat([id, companion]);
      const c = game.combat!;
      const iid = c.player.piles.hand.find(i => c.cards[i]!.defId === id)!;
      c.cards[iid]!.upgrades = upgrades;
      if (inDraw) {
        const other = c.player.piles.hand.find(i => i !== iid)!;
        c.player.piles.hand = c.player.piles.hand.filter(i => i !== other);
        c.player.piles.draw.push(other);
      }
      const handIdx = c.player.piles.hand.indexOf(iid);
      const before = structuredClone(game);
      const ui: UiState = { ...initialUiState(), screen: "run" };
      const view = buildView(game, ui, bundle);
      if (view.screen.kind !== "combat") throw new Error("expected combat");
      const handCard = view.screen.hand[handIdx]!;
      expect(handCard.playable).toBe(playable);
      expect(publicGameState(game, bundle, view)?.combat?.hand[handIdx]?.playable).toBe(playable);
      expect(liveControls(game, ui, view).find(control => control.id.endsWith(`:hand:${iid}`))?.enabled).toBe(playable);
      const play = () => advance(game, { cmd: "playCard", handIdx, target: 0 }, bundle);
      if (playable) {
        expect(play).not.toThrow();
        expect(resolveControl({ kind: "play", iid, target: id === "GRAND_FINALE" ? undefined : 1 },
          game, ui, view, bundle).action.kind).toBe("cmd");
      } else {
        expect(play).toThrow("card cannot be used now");
        expect(() => resolveControl({ kind: "play", iid, target: 1 }, game, ui, view, bundle)).toThrow("DISABLED");
        const toast = { kind: "ui", act: { type: "toast", text: `${handCard.name} cannot be played now` } } as const;
        expect(mapKey({ kind: "char", ch: handCard.key! }, view)).toEqual(toast);
        const inspected = applyUiAction(ui, {
          type: "openOverlay", overlay: { kind: "inspect", source: { of: "hand" }, index: handIdx },
        });
        expect(mapKey({ kind: "enter" }, buildView(game, inspected, bundle))).toEqual(toast);
      }
      expect(game).toEqual(before);
    }
  });
}

for (const guard of ["ENTANGLED", "NORMALITY", "VELVET_CHOKER"]) {
  test(`${guard} veto is reflected in hand, public state and control availability`, () => {
    const game = combat(["STRIKE_RED", "DEFEND_RED", "NORMALITY"]);
    const c = game.combat!;
    const iid = c.player.piles.hand.find(i => c.cards[i]!.defId === "STRIKE_RED")!;
    const handIdx = c.player.piles.hand.indexOf(iid);
    if (guard === "VELVET_CHOKER") game.run.relics.push({ defId: guard, counter: 6 });
    else if (guard === "ENTANGLED") c.player.powers.push({ id: guard, amount: 1, justApplied: false, data: null });
    else c.turnFlags.cardsPlayedThisTurn = 3;
    const before = structuredClone(game);
    const ui: UiState = { ...initialUiState(), screen: "run" };
    const view = buildView(game, ui, bundle);
    if (view.screen.kind !== "combat") throw new Error("expected combat");
    expect(view.screen.hand[handIdx]?.playable).toBe(false);
    expect(publicGameState(game, bundle, view)?.combat?.hand[handIdx]?.playable).toBe(false);
    expect(liveControls(game, ui, view).find(control => control.id.endsWith(`:hand:${iid}`))?.enabled).toBe(false);
    expect(() => resolveControl({ kind: "play", iid, target: 1 }, game, ui, view, bundle)).toThrow("DISABLED");
    expect(() => advance(game, { cmd: "playCard", handIdx, target: 0 }, bundle)).toThrow("a power or relic prevents");
    if (guard === "ENTANGLED") {
      expect(view.screen.hand[c.player.piles.hand.findIndex(i => c.cards[i]!.defId === "DEFEND_RED")]?.playable).toBe(true);
    }
    expect(game).toEqual(before);
  });
}

test("blocked Clash is rejected before dispatch with only the existing error toast", () => {
  const game = combat(["CLASH", "DEFEND_RED", "DEMON_FORM"]);
  const a = app(game);
  const before = a.port.snapshot();
  const clash = before.state!.combat!.hand.find(card => card.card === "CLASH")!;
  const writes = a.writes();
  expect(clash).toMatchObject({ cost: 0, playable: false });
  expect(a.port.snapshot()).toEqual(before);
  expect(a.act({ kind: "play", iid: clash.iid, target: 1 }).error).toContain("DISABLED");
  const after = a.port.snapshot();
  expect(after.state).toEqual(before.state);
  expect(after.revision).not.toBe(before.revision);
  expect(after.ui.toast).toBe("DISABLED: card is not playable");
  expect(a.writes()).toBe(writes);
});

test("potion menu disables combat-only use outside combat but keeps discard enabled", () => {
  const ui: UiState = { ...initialUiState(), screen: "run", overlays: [{ kind: "potionMenu", slot: 0 }] };

  const blocked = createRun({ seed: "POTION-CONTROLS-BLOCKED", bundle, character: "IRONCLAD" });
  blocked.run.room = { kind: "map" };
  blocked.run.potions[0] = "REGEN_POTION";
  const blockedView = buildView(blocked, ui, bundle);
  if (blockedView.overlay?.kind !== "potionMenu") throw new Error("expected potion menu");
  expect(blockedView.overlay.blocked).toBe("Regen Potion cannot be used here");
  expect(mapKey({ kind: "char", ch: "u" }, blockedView)).toEqual({
    kind: "ui",
    act: { type: "toast", text: "Regen Potion cannot be used here" },
  });
  const blockedControls = liveControls(blocked, ui, blockedView);
  expect(blockedControls.find((control) => control.key === "ENTER")?.enabled).toBe(false);
  expect(blockedControls.find((control) => control.key === "d")?.enabled).toBe(true);

  const fruit = createRun({ seed: "POTION-CONTROLS-FRUIT", bundle, character: "IRONCLAD" });
  fruit.run.room = { kind: "map" };
  fruit.run.potions[0] = "FRUIT_JUICE";
  const fruitView = buildView(fruit, ui, bundle);
  if (fruitView.overlay?.kind !== "potionMenu") throw new Error("expected potion menu");
  expect(fruitView.overlay.blocked).toBeNull();
  expect(mapKey({ kind: "char", ch: "u" }, fruitView)).toEqual({ kind: "cmd", cmd: { cmd: "usePotion", slot: 0 } });
  expect(liveControls(fruit, ui, fruitView).find((control) => control.key === "ENTER")?.enabled).toBe(true);
});

test("card and enemy control IDs are encounter-scoped and use original enemy slots", () => {
  const first = combat();
  const second = combat();
  second.run.floor++;
  const a = app(first);
  const b = app(second);
  const firstHand = a.port.snapshot().ui.controls.find(c => c.key === "1")!;
  const secondHand = b.port.snapshot().ui.controls.find(c => c.key === "1")!;
  expect(firstHand.id).not.toBe(secondHand.id);
  expect(b.act({ kind: "select", id: firstHand.id }).error).toContain("MISSING");
  first.combat!.monsters[0]!.id = "GAP";
  first.combat!.monsters[0]!.isDead = true;
  const enemies = a.port.snapshot().ui.controls.filter(c => c.id.includes(":enemy:"));
  expect(enemies[0]!.id).toContain(":enemy:1:CULTIST");
  expect(enemies[1]!.id).toContain(":enemy:2:CULTIST");
});

test("Spot Weakness requires an enemy target and resolves the chosen living slot", () => {
  const game = combat();
  const c = game.combat!;
  const iid = c.player.piles.hand[0]!;
  c.cards[iid]!.defId = "SPOT_WEAKNESS";
  c.monsters[0]!.isDead = true;
  c.monsters[0]!.hp = 0;
  for (const [index, attacking] of [[1, false], [2, true]] as const) {
    const enemy = c.monsters[index]!;
    const move = Object.entries(bundle.monsters.get(enemy.id)!.moves)
      .find(([, definition]) => definition.intent.startsWith("attack") === attacking);
    if (!move) throw new Error("expected attack and non-attack test moves");
    enemy.move = move[0];
  }
  const a = app(game);
  expect(a.port.snapshot().state!.combat!.hand[0]!.targeted).toBe(true);
  expect(a.act({ kind: "play", iid }).error).toContain("INVALID_TARGET");
  expect(a.writes()).toBe(0);
  const result = a.act({ kind: "play", iid, target: 2 });
  expect(result.ok).toBe(true);
  expect(result.state!.combat!.powers.find(p => p.id === "STRENGTH")?.amount).toBeGreaterThan(0);
  expect(a.writes()).toBe(1);
});

test("Spot Weakness auto-targets the sole living enemy, never a dead original slot", () => {
  const game = combat();
  const c = game.combat!;
  const iid = c.player.piles.hand[0]!;
  c.cards[iid]!.defId = "SPOT_WEAKNESS";
  c.monsters[0]!.isDead = c.monsters[1]!.isDead = true;
  const enemy = c.monsters[2]!;
  const move = Object.entries(bundle.monsters.get(enemy.id)!.moves).find(([, definition]) => definition.intent.startsWith("attack"));
  if (!move) throw new Error("expected an attacking test move");
  enemy.move = move[0];
  const result = app(game).act({ kind: "play", iid });
  expect(result.ok).toBe(true);
  expect(result.state!.combat!.powers.find(p => p.id === "STRENGTH")?.amount).toBeGreaterThan(0);
});

test("overlays block play/end, disabled keys reject, and exact missing IDs reject", () => {
  const game = combat();
  game.combat!.player.energy = 0;
  const a = app(game);
  const disabled = a.port.snapshot().ui.controls.find(c => c.key === "1")!;
  expect(disabled.enabled).toBe(false);
  expect(a.act({ kind: "select", id: disabled.id }).ok).toBe(false);
  expect(a.act({ kind: "key", key: "1" }).error).toContain("DISABLED");
  expect(a.act({ kind: "key", key: "1" }).outcome).toBe("rejected");
  expect(a.writes()).toBe(0);
  expect(a.act({ kind: "select", id: "not-a-control" }).error).toContain("MISSING");
  expect(a.act({ kind: "key", key: "d" }).ui.overlay?.kind).toBe("list");
  expect(a.act({ kind: "end" }).error).toContain("UI_CONTEXT");
  const iid = a.port.snapshot().state!.combat!.hand[0]!.iid;
  expect(a.act({ kind: "play", iid, target: 1 }).error).toContain("UI_CONTEXT");
  expect(a.act({ kind: "key", key: "ESC" }).ui.mode).toBe("combat");
});

test("partial save failure returns changed state, failure, toast and repainted frame", () => {
  const a = app(combat());
  const before = a.port.snapshot();
  a.failSave();
  const iid = before.state!.combat!.hand[0]!.iid;
  const result = a.act({ kind: "play", iid, target: 1 });
  expect(result.ok).toBe(false);
  expect(result.outcome).toBe("applied-save-failed");
  expect(result.changed).toBe(true);
  expect(result.error).toBe("synthetic save failure");
  expect(result.ui.toast).toBe("synthetic save failure");
  expect(result.state!.combat!.hand.some(c => c.iid === iid)).toBe(false);
  expect(a.term.output.at(-1)).toContain("synthetic save failure");
});

test("paint failure still reports the advanced state and retains the result for retry", () => {
  const a = app(combat());
  const before = a.port.snapshot();
  const write = a.term.write;
  a.term.write = () => { throw new Error("synthetic paint failure"); };
  const request = {
    requestId: "paint", expectedRevision: before.revision,
    action: { kind: "play", iid: before.state!.combat!.hand[0]!.iid, target: 1 },
  };
  try {
    const result = a.port.act(request);
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("applied");
    expect(result.paintError).toBe("synthetic paint failure");
    expect(result.error).toBe("synthetic paint failure");
    expect(result.changed).toBe(true);
    expect(result.state!.combat!.hand).toHaveLength(before.state!.combat!.hand.length - 1);
    expect(a.port.act(request)).toEqual(result);
    expect(a.writes()).toBe(1);
  } finally { a.term.write = write; }
});

test("lost-response retry replays the exact response without a second advance", () => {
  const a = app(combat());
  const before = a.port.snapshot();
  const request = {
    requestId: "retry", expectedRevision: before.revision,
    action: { kind: "play", iid: before.state!.combat!.hand[0]!.iid, target: 1 },
  };
  const first = a.port.act(request);
  expect(first.ok).toBe(true);
  a.term.feed("\t");
  expect(a.port.act(request)).toEqual(first);
  expect(a.writes()).toBe(1);
  expect(a.port.act({ ...request, action: { kind: "end" } }).error).toContain("REQUEST_ID_REUSED");
  expect(a.writes()).toBe(1);
});

test("invalid requests with usable IDs also cannot be corrected into a replayed action", () => {
  const a = app();
  const input = { requestId: "bad", expectedRevision: a.port.snapshot().revision, action: { kind: "shell" } };
  const rejected = a.port.act(input);
  expect(rejected.error).toContain("INVALID_ACTION");
  expect(a.port.act(input)).toEqual(rejected);
  expect(a.port.act({ ...input, action: { kind: "key", key: "n" } }).error).toContain("REQUEST_ID_REUSED");
  expect(a.writes()).toBe(0);
});

test("bounded journals never evict requests; restart changes epoch", () => {
  const a = app();
  const initial = a.port.snapshot();
  let dispatches = 0;
  const controller = new LiveController(() => initial, () => { dispatches++; return { ok: true }; }, { entries: 1, bytes: 1000000 });
  const input = { requestId: "one", expectedRevision: controller.snapshot().revision, action: { kind: "key", key: "TAB" } };
  const first = controller.act(input);
  expect(controller.act({ ...input, requestId: "two" }).error).toContain("JOURNAL_FULL");
  expect(controller.act(input)).toEqual(first);
  expect(dispatches).toBe(1);
  const restarted = new LiveController(() => initial, () => { dispatches++; return { ok: true }; });
  expect(restarted.act(input).error).toContain("STALE_REVISION");
  expect(dispatches).toBe(1);
});

test("settings and arbitrary operations cannot cross the bridge", () => {
  const a = app();
  expect(a.act({ kind: "key", key: "S" }).error).toContain("settings");
  a.term.feed("S");
  expect(a.port.snapshot().ui.overlay?.id).toBe("settings");
  expect(a.act({ kind: "key", key: "ENTER" }).ok).toBe(false);
  const revision = a.port.snapshot().revision;
  for (const action of [
    { kind: "cmd", cmd: "endTurn" }, { kind: "key", key: "\x03" },
    { kind: "end", cmd: "cheat" }, { kind: "play", iid: 1, target: -1 },
    { kind: "key", key: "echo secret" },
  ]) {
    expect(a.port.act({ requestId: "invalid", expectedRevision: revision, action }).ok).toBe(false);
  }
});

test("pile overlays stay visible through the control bridge", () => {
  const game = combat(Array.from({ length: 10 }, () => "STRIKE_RED"));
  arrangePiles(game, {
    draw: [
      { defId: "STRIKE_RED" },
      { defId: "BASH", upgrades: 1 },
      { defId: "DEFEND_RED" },
    ],
  });
  const ui = {
    ...initialUiState(),
    screen: "run" as const,
    overlays: [{ kind: "pile" as const, pile: "draw" as const, page: 0 }],
    focus: { scope: "overlay", idx: 0 },
  };
  const view = controlSafeView(buildView(game, ui, bundle));
  expect(view.overlay?.kind).toBe("list");
  if (view.overlay?.kind !== "list") throw new Error("Expected pile list overlay");
  expect(view.overlay.list.items.map(item => item.label)).toEqual([
    "Bash+ (1) [attack]",
    "Defend (1) [skill]",
    "Strike (1) [attack]",
  ]);
  expect(JSON.stringify(view)).not.toContain("redacted");
  expect(view.tooltip?.name).toBe("Bash+ (1)");

  const inspected = controlSafeView(buildView(game, {
    ...ui,
    overlays: [{ kind: "inspect" as const, source: { of: "pile" as const, pile: "draw" as const }, index: 0 }],
  }, bundle));
  expect(inspected.overlay?.kind).toBe("inspect");
  if (inspected.overlay?.kind !== "inspect") throw new Error("Expected pile inspect overlay");
  expect(inspected.overlay.name).toBe("Bash+");
});

test("draw pile display order is sorted unless Frozen Eye is owned", () => {
  const game = combat(Array.from({ length: 10 }, () => "STRIKE_RED"));
  arrangePiles(game, {
    draw: [
      { defId: "STRIKE_RED" },
      { defId: "BASH", upgrades: 1 },
      { defId: "DEFEND_RED" },
    ],
  });
  const ui = {
    ...initialUiState(),
    screen: "run" as const,
    overlays: [{ kind: "pile" as const, pile: "draw" as const, page: 0 }],
  };
  const labels = () => {
    const view = buildView(game, ui, bundle);
    if (view.overlay?.kind !== "list") throw new Error("Expected pile list overlay");
    return view.overlay.list.items.map(item => item.label);
  };
  expect(labels()).toEqual([
    "Bash+ (1) [attack]",
    "Defend (1) [skill]",
    "Strike (1) [attack]",
  ]);
  expect(publicGameState(game, bundle, buildView(game, ui, bundle))?.combat?.pileCards.draw).toEqual(["Bash+", "Defend", "Strike"]);

  game.run.relics.push({ defId: "FROZEN_EYE", counter: 0 });
  expect(labels()).toEqual([
    "Strike (1) [attack]",
    "Bash+ (1) [attack]",
    "Defend (1) [skill]",
  ]);
  expect(publicGameState(game, bundle, buildView(game, ui, bundle))?.combat?.pileCards.draw).toEqual(["Strike", "Bash+", "Defend"]);
});

test("public combat state includes compact pile card labels", () => {
  const game = combat(Array.from({ length: 10 }, () => "STRIKE_RED"));
  arrangePiles(game, {
    draw: [
      { defId: "STRIKE_RED" },
      { defId: "BASH", upgrades: 1 },
      { defId: "DEFEND_RED" },
    ],
    discard: [
      { defId: "BASH" },
      { defId: "STRIKE_RED" },
    ],
    exhaust: [
      { defId: "WOUND" },
      { defId: "DEFEND_RED", upgrades: 1 },
    ],
  });
  const state = publicGameState(game, bundle, buildView(game, { ...initialUiState(), screen: "run" as const }, bundle));
  expect(state?.combat?.piles).toEqual({ draw: 3, discard: 2, exhaust: 2 });
  expect(state?.combat?.pileCards).toEqual({
    draw: ["Bash+", "Defend", "Strike"],
    discard: ["Bash", "Strike"],
    exhaust: ["Wound", "Defend+"],
  });
});

test("public allowlist excludes RNG, queued outcomes and internal power data", () => {
  const game = combat(Array.from({ length: 10 }, () => "STRIKE_RED"));
  arrangePiles(game, {
    draw: [
      { defId: "STRIKE_RED" },
      { defId: "BASH" },
      { defId: "DEFEND_RED" },
    ],
  });
  game.combat!.monsters[0]!.data.secret = "ENEMY_SECRET";
  game.run.pools.commonRelics = ["FUTURE_RELIC_SECRET"];
  game.combat!.player.powers.push({ id: "STRENGTH", amount: 2, justApplied: false, data: { hidden: "POWER_SECRET" } });
  const ui = { ...initialUiState(), screen: "run" as const };
  const project = () => publicGameState(game, bundle, controlSafeView(buildView(game, ui, bundle)));
  const before = JSON.stringify(project());
  for (const secret of ["ENEMY_SECRET", "FUTURE_RELIC_SECRET", "POWER_SECRET", "\"rng\"", "\"moveHistory\"", "\"cards\":{"]) {
    expect(before).not.toContain(secret);
  }
  game.combat!.player.piles.draw.reverse();
  expect(JSON.stringify(project())).toBe(before);
});

test("Runic Dome hides current move in public state and unopened chests hide future rewards", () => {
  const game = combat();
  game.run.relics.push({ defId: "RUNIC_DOME", counter: 0 });
  const a = app(game);
  expect(a.port.snapshot().state!.combat!.enemies.every(e => e.intent === null && e.intentView === null)).toBe(true);
  const chest = createRun({ seed: "CHEST-CONTROL", character: "IRONCLAD", bundle });
  chest.run.room = { kind: "treasure", chest: { size: "small", opened: false, goldPresent: true, relicTier: "common", sapphireKeyAvailable: true } };
  chest.run.pools.commonRelics = ["FUTURE_RELIC_SECRET"];
  const b = app(chest);
  expect(JSON.stringify(b.port.snapshot())).not.toContain("FUTURE_RELIC_SECRET");
});

test("Runic Dome cannot reveal intents through combat focus or targeting tooltips", () => {
  const game = combat();
  game.run.relics.push({ defId: "RUNIC_DOME", counter: 0 });
  const ui = { ...initialUiState(), screen: "run" as const };
  const focus = { scope: "combat", idx: game.combat!.player.piles.hand.length };
  const combatView = controlSafeView(buildView(game, { ...ui, focus }, bundle));
  expect(combatView.tooltip?.chip).toBe("ENEMY");
  expect(combatView.tooltip?.lines[0]).not.toMatch(/intends to attack|Dark Strike|Chomp/);
  const targeting = { kind: "card" as const, handIdx: 0 };
  const targetingView = controlSafeView(buildView(game, { ...ui, targeting }, bundle));
  expect(targetingView.tooltip?.chip).toBe("ENEMY");
  expect(targetingView.tooltip?.lines[0]).not.toMatch(/intends to attack|Dark Strike|Chomp/);
  const a = app(game);
  for (let i = 0; i <= game.combat!.player.piles.hand.length; i++) a.term.feed("\t");
  expect(a.port.snapshot().screenText).not.toContain("intends to attack");
  a.term.feed("1");
  expect(a.port.snapshot().ui.mode).toBe("targeting");
  expect(a.port.snapshot().screenText).not.toContain("intends to attack");
});

test("live game-over state remains after deleting the save, and returning to menu is observable", () => {
  const game = combat();
  game.run.act = 4;
  game.run.room = { kind: "combat", roomKind: "boss", encounterId: "test", burningElite: false };
  game.combat!.monsters.forEach((m, i) => { m.isDead = i > 0; m.hp = i > 0 ? 0 : 1; });
  const a = app(game);
  const iid = a.port.snapshot().state!.combat!.hand[0]!.iid;
  const over = a.act({ kind: "play", iid, target: 1 });
  expect(over.ok).toBe(true);
  expect(over.state?.room.kind).toBe("gameOver");
  expect(over.ui.screen).toBe("gameOver");
  expect(a.deletes()).toBe(1);
  expect(a.saves.readSave()).toBeNull();
  expect(a.act({ kind: "key", key: "m" }).ui.screen).toBe("menu");
  expect(a.port.snapshot().state?.room.kind).toBe("gameOver");
});

for (const input of ["hotkey", "identity"] as const) {
  test(`filtered paged choice ${input} selects the exact deck identity and verifies the upgrade`, () => {
    let game = createRun({ seed: "BRIDGE-CHOICE", character: "IRONCLAD", bundle });
    const holes = new Set([0, 3, 6, 9, 12, 15]);
    game.run.deck = Array.from({ length: 27 }, (_, i) => ({
      defId: i === 25 ? "FIEND_FIRE" : i === 19 ? "DEMON_FORM" : "STRIKE_RED",
      upgrades: holes.has(i) ? 1 : 0, misc: i, bottled: holes.has(i),
    }));
    game.run.room = { kind: "event", eventId: "UPGRADE_SHRINE" };
    game = advance(game, { cmd: "eventOption", i: 0 }, bundle);
    const a = app(game);
    const page = a.act({ kind: "key", key: "n" });
    expect(page.ui.page).toBe(1);
    const card = page.ui.controls.find(c => c.key === "0")!;
    expect(card.id).toContain("deck:25:FIEND_FIRE");
    const choices = page.state!.choices;
    expect(choices && "cards" in choices ? choices.cards?.find(c => c.key === "0")?.iid : null).toBe(25);
    const result = a.act(input === "identity" ? { kind: "select", id: card.id } : { kind: "key", key: "0" });
    expect(result.ok).toBe(true);
    expect(result.state!.deck[25]!.upgrades).toBe(1);
    expect(result.state!.deck[19]).toEqual(page.state!.deck[19]);
    expect(result.verification?.deckBefore?.[25]?.upgrades).toBe(0);
    expect(result.verification?.deckAfter?.[25]?.upgrades).toBe(1);
    expect(result.state?.choices).toBeNull();
  });
}

test("manual and remote actions share save and paint flow", () => {
  const a = app(combat());
  const b = app(combat());
  a.term.feed("e");
  const ended = b.act({ kind: "end" });
  expect(ended.ok).toBe(true);
  expect(ended.state).toEqual(a.port.snapshot().state);
  expect(ended.screenText).toEqual(a.port.snapshot().screenText);
  expect(b.writes()).toBe(a.writes());
});
