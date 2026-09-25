import { describe, expect, test } from "bun:test";
import { mapKey } from "../../src/cli/input/keymap";
import { isAppAction, type KeyAction } from "../../src/cli/input/actions";
import { renderFrame } from "../../src/cli/render/frame";
import { THEME_256 } from "../../src/cli/render/theme";
import { buildView } from "../../src/cli/state/view";
import { applyUiAction, initialUiState, type UiState } from "../../src/cli/state/uiState";
import type { Key } from "../../src/cli/term/keys";
import { advance, createRun, type GameState } from "../../src/engine/game";
import { bundle, fxCombat } from "./fixtures";

const ENTER: Key = { kind: "enter" };
const ch = (value: string): Key => ({ kind: "char", ch: value });
const holes = new Set([0, 3, 6, 9, 12, 15]);

function freshUi(): UiState {
  return { ...initialUiState({ seed: "CHOICE_MAPPING" }), screen: "run" };
}

function deckGame(): GameState {
  const game = createRun({ seed: "CHOICE_MAPPING", character: "IRONCLAD", bundle });
  game.run.deck = Array.from({ length: 27 }, (_, i) => ({
    defId: i === 25 ? "FIEND_FIRE" : i === 19 ? "DEMON_FORM" : "STRIKE_RED",
    upgrades: holes.has(i) ? 1 : 0,
    misc: i,
    bottled: holes.has(i),
  }));
  return game;
}

function eventChoice(eventId = "UPGRADE_SHRINE", option = 0): GameState {
  const game = deckGame();
  game.run.room = { kind: "event", eventId };
  return advance(game, { cmd: "eventOption", i: option }, bundle);
}

function choose(game: GameState, action: KeyAction | null): GameState {
  if (action?.kind !== "cmd" || action.cmd.cmd !== "choose") throw new Error("expected choose command");
  return advance(game, action.cmd, bundle);
}

function pressUi(game: GameState, ui: UiState, key: Key): UiState {
  const action = mapKey(key, buildView(game, ui, bundle));
  if (action?.kind !== "ui" || isAppAction(action.act)) throw new Error("expected pure UI action");
  return applyUiAction(ui, action.act);
}

function expectChoose(action: KeyAction | null, indices: number[]): void {
  expect(action).toEqual({ kind: "cmd", cmd: { cmd: "choose", indices } });
}

describe("run deck choice mapping", () => {
  for (const input of ["hotkey", "enter"] as const) {
    test(`Upgrade Shrine page 2 ${input} upgrades Fiend Fire at deck 25, not Demon Form at 19`, () => {
      const game = eventChoice();
      const request = game.pending!.request;
      if (request.kind !== "cards") throw new Error("expected card choice");
      expect(request.iids).toHaveLength(21);
      expect(request.iids[19]).toBe(25);
      const ui: UiState = {
        ...freshUi(),
        choicePage: 1,
        focus: input === "enter" ? { scope: "choice", idx: 19 } : null,
      };
      const view = buildView(game, ui, bundle);
      if (view.overlay?.kind !== "choice") throw new Error("expected choice overlay");
      expect(view.overlay.selectionValues).toEqual(request.iids);
      expect(view.overlay.list.items[9]).toMatchObject({ key: "0", i: 19, label: "Fiend Fire (2)" });
      const action = mapKey(input === "enter" ? ENTER : ch("0"), view);
      expectChoose(action, [25]);
      const result = choose(game, action);
      expect(result.run.deck).toEqual(game.run.deck.map((card, i) => i === 25 ? { ...card, upgrades: 1 } : card));
      expect(result.run.deck[19]).toEqual(game.run.deck[19]);
      expect(result.pending).toBeNull();
    });

    test(`first-page ${input} skips excluded deck cards`, () => {
      const game = eventChoice();
      const ui: UiState = { ...freshUi(), focus: input === "enter" ? { scope: "choice", idx: 0 } : null };
      const action = mapKey(input === "enter" ? ENTER : ch("1"), buildView(game, ui, bundle));
      expectChoose(action, [1]);
      expect(choose(game, action).run.deck).toEqual(
        game.run.deck.map((card, i) => i === 1 ? { ...card, upgrades: 1 } : card),
      );
    });
  }

  test("arrows cross pages, and inspect follows the same filtered card without activating another", () => {
    const game = eventChoice();
    let ui = freshUi();
    for (let i = 0; i < 20; i++) ui = pressUi(game, ui, { kind: "down" });
    let view = buildView(game, ui, bundle);
    expect(view.focusIdx).toBe(19);
    if (view.overlay?.kind !== "choice") throw new Error("expected choice overlay");
    expect(view.overlay.list.page).toBe(1);
    expect(view.tooltip?.name).toBe("Fiend Fire (2)");
    expect(view.inspect).toEqual({ source: { of: "choice" }, index: 19 });
    expectChoose(mapKey(ENTER, view), [25]);
    expect(mapKey(ENTER, view)).toEqual(mapKey(ch("0"), view));
    ui = pressUi(game, ui, ch("i"));
    view = buildView(game, ui, bundle);
    expect(view.overlay).toMatchObject({ kind: "inspect", name: "Fiend Fire", index: 19 });
    expect(mapKey(ENTER, view)).toBeNull();
    ui = pressUi(game, ui, { kind: "esc" });
    view = buildView(game, ui, bundle);
    expect(view.focusIdx).toBeNull();
    expect(mapKey(ENTER, view)).toBeNull();
  });

  test("multi-selection keeps display indices across pages but commits deck indices in selection order", () => {
    const game = eventChoice();
    const pending = game.pending!;
    if (pending.request.kind !== "cards") throw new Error("expected card choice");
    pending.request.min = pending.request.max = 2;
    pending.resume = "__runDeckChoice";
    pending.resumeArgs = { action: "upgrade" };
    let ui = pressUi(game, freshUi(), ch("n"));
    ui = pressUi(game, ui, ch("0"));
    expect(ui.choiceSel).toEqual([19]);
    ui = pressUi(game, ui, ch("p"));
    ui = pressUi(game, ui, ch("1"));
    expect(ui.choiceSel).toEqual([19, 0]);
    let view = buildView(game, ui, bundle);
    expect(view.overlay).toMatchObject({ kind: "choice", selected: [19, 0] });
    expectChoose(mapKey(ENTER, view), [25, 1]);
    ui = pressUi(game, ui, ch("1"));
    expect(ui.choiceSel).toEqual([19]);
    expect(mapKey(ENTER, buildView(game, ui, bundle))).toEqual({
      kind: "ui", act: { type: "toast", text: "Select at least 2" },
    });
    ui = pressUi(game, ui, ch("1"));
    view = buildView(game, ui, bundle);
    const result = choose(game, mapKey(ENTER, view));
    expect(result.run.deck).toEqual(
      game.run.deck.map((card, i) => i === 1 || i === 25 ? { ...card, upgrades: 1 } : card),
    );
  });

  test("Purifier removes the selected filtered deck card and preserves every other card", () => {
    const game = eventChoice("PURIFIER");
    const view = buildView(game, { ...freshUi(), choicePage: 1 }, bundle);
    const action = mapKey(ch("0"), view);
    expectChoose(action, [25]);
    expect(choose(game, action).run.deck).toEqual(game.run.deck.filter((_, i) => i !== 25));
  });

  test("Transmogrifier transforms the selected filtered deck card, not its displayed ordinal", () => {
    const game = eventChoice("TRANSMORGRIFIER");
    const action = mapKey(ch("0"), buildView(game, { ...freshUi(), choicePage: 1 }, bundle));
    expectChoose(action, [25]);
    const result = choose(game, action);
    expect(result.run.deck.slice(0, -1)).toEqual(game.run.deck.filter((_, i) => i !== 25));
    expect(result.run.deck).toHaveLength(game.run.deck.length);
  });

  test("Augmenter multi-transform changes only the two selected deck cards across pages", () => {
    // DrugDealer lists masterDeck.getPurgeableCards() - bottled cards included -
    // so every one of the 27 cards is a candidate and page 2 key 0 is deck 19
    const game = eventChoice("AUGMENTER", 1);
    const request = game.pending!.request;
    if (request.kind !== "cards") throw new Error("expected card choice");
    expect(request.iids).toEqual(game.run.deck.map((_, i) => i));
    let ui = pressUi(game, freshUi(), ch("n"));
    ui = pressUi(game, ui, ch("0"));
    ui = pressUi(game, ui, ch("p"));
    ui = pressUi(game, ui, ch("2"));
    const action = mapKey(ENTER, buildView(game, ui, bundle));
    expectChoose(action, [19, 1]);
    const result = choose(game, action);
    expect(result.run.deck.slice(0, -2)).toEqual(game.run.deck.filter((_, i) => i !== 1 && i !== 19));
    expect(result.run.deck).toHaveLength(game.run.deck.length);
  });

  test("Peace Pipe uses deck indices, while cancellation still sends no selection", () => {
    const game = eventChoice();
    game.pending!.resume = "__restToke";
    const request = game.pending!.request;
    if (request.kind !== "cards") throw new Error("expected card choice");
    request.canCancel = true;
    const view = buildView(game, { ...freshUi(), choicePage: 1 }, bundle);
    expectChoose(mapKey({ kind: "esc" }, view), []);
    const action = mapKey(ch("0"), view);
    expectChoose(action, [25]);
    expect(choose(game, action).run.deck).toEqual(game.run.deck.filter((_, i) => i !== 25));
  });
});

describe("positional choice contracts stay unchanged", () => {
  test("paged event options use option positions for hotkeys and focused Enter", () => {
    const game = eventChoice();
    game.pending!.request = {
      kind: "option", options: Array.from({ length: 21 }, (_, i) => `Option ${i}`), reason: "Choose an option",
    };
    const view = buildView(game, { ...freshUi(), focus: { scope: "choice", idx: 19 } }, bundle);
    expect(view.overlay).toMatchObject({ selectionValues: Array.from({ length: 21 }, (_, i) => i) });
    expectChoose(mapKey(ch("0"), view), [19]);
    expect(mapKey(ENTER, view)).toEqual(mapKey(ch("0"), view));
    expect(mapKey(ch("i"), view)).toBeNull();
  });

  test("bottled relic picks still send candidate positions and bottle the exact target", () => {
    const game = deckGame();
    game.run.room = { kind: "rewards", entries: [{ kind: "relic", id: "BOTTLED_TORNADO", taken: false }], source: "event" };
    const pending = advance(game, { cmd: "takeReward", i: 0 }, bundle);
    const request = pending.pending!.request;
    if (request.kind !== "cards") throw new Error("expected card choice");
    expect(request.iids).toEqual([19]);
    const view = buildView(pending, { ...freshUi(), focus: { scope: "choice", idx: 0 } }, bundle);
    expect(view.overlay).toMatchObject({ selectionValues: [0] });
    expectChoose(mapKey(ch("1"), view), [0]);
    expect(mapKey(ENTER, view)).toEqual(mapKey(ch("1"), view));
    expect(choose(pending, mapKey(ENTER, view)).run.deck).toEqual(
      game.run.deck.map((card, i) => i === 19 ? { ...card, bottled: true } : card),
    );
  });

  test("Empty Cage multi-pick preserves its positional contract across pages", () => {
    const game = deckGame();
    game.run.room = { kind: "rewards", entries: [{ kind: "bossRelic", group: 0, id: "EMPTY_CAGE", taken: false }], source: "boss" };
    const pending = advance(game, { cmd: "takeReward", i: 0 }, bundle);
    let ui = pressUi(pending, freshUi(), ch("n"));
    ui = pressUi(pending, ui, ch("0"));
    ui = pressUi(pending, ui, ch("p"));
    ui = pressUi(pending, ui, ch("1"));
    const action = mapKey(ENTER, buildView(pending, ui, bundle));
    expectChoose(action, [19, 0]);
    // EmptyCage lists every purgeable card, bottled ones included, so the
    // positions here are the deck indices themselves
    expect(choose(pending, action).run.deck).toEqual(game.run.deck.filter((_, i) => i !== 0 && i !== 19));
  });

  test("combat card picks send candidate positions, not instance IDs", () => {
    const game = fxCombat().game!;
    const combat = game.combat!;
    const iids = combat.player.piles.draw.splice(1, 2).reverse();
    expect(iids).toHaveLength(2);
    expect(iids).not.toEqual([0, 1]);
    combat.player.piles.discard.push(...iids);
    game.pending = {
      request: { kind: "cards", pile: "discard", iids, min: 1, max: 1, canCancel: false, reason: "Headbutt" },
      resume: "ironclad/headbutt",
      resumeArgs: { iids },
    };
    const view = buildView(game, { ...freshUi(), focus: { scope: "choice", idx: 1 } }, bundle);
    expect(view.overlay).toMatchObject({ selectionValues: [0, 1] });
    expectChoose(mapKey(ch("2"), view), [1]);
    expect(mapKey(ENTER, view)).toEqual(mapKey(ch("2"), view));
    const result = choose(game, mapKey(ENTER, view));
    expect(result.combat!.player.piles.draw[0]).toBe(iids[1]);
    expect(result.combat!.player.piles.discard).toContain(iids[0]!);
    expect(result.combat!.player.piles.discard).not.toContain(iids[1]!);
  });

  for (const kind of ["cards", "scry"] as const) {
    test(`combat ${kind} multi-picks keep selection positions and order`, () => {
      const game = fxCombat().game!;
      const iids = [...game.combat!.player.piles.draw].reverse();
      game.pending = {
        request: kind === "scry"
          ? { kind, iids }
          : { kind, pile: "draw", iids, min: 0, max: 2, canCancel: true, reason: "Choose cards" },
        resume: "__scryResolve",
        resumeArgs: { iids },
      };
      let ui = freshUi();
      expectChoose(mapKey(ENTER, buildView(game, ui, bundle)), []);
      ui = pressUi(game, ui, ch("2"));
      ui = pressUi(game, ui, ch("1"));
      expect(ui.choiceSel).toEqual([1, 0]);
      expectChoose(mapKey(ENTER, buildView(game, ui, bundle)), [1, 0]);
    });
  }
});

describe("self-and-enemy target selection", () => {
  function spotWeaknessGame(): GameState {
    const game = fxCombat().game!;
    const combat = game.combat!;
    combat.cards[combat.player.piles.hand[0]!]!.defId = "SPOT_WEAKNESS";
    return game;
  }

  test("Spot Weakness requires a target from hotkeys, focused Enter and inspect Enter", () => {
    const game = spotWeaknessGame();
    let ui: UiState = { ...freshUi(), focus: { scope: "combat", idx: 0 } };
    let view = buildView(game, ui, bundle);
    if (view.screen.kind !== "combat") throw new Error("expected combat");
    expect(view.screen.hand[0]).toMatchObject({ name: "Spot Weakness", targeted: true });
    expect(view.tooltip?.meta).toContain("targets an enemy");
    const targetAction: KeyAction = {
      kind: "ui", act: { type: "setTargeting", targeting: { kind: "card", handIdx: 0 } },
    };
    expect(mapKey(ch("1"), view)).toEqual(targetAction);
    expect(mapKey(ENTER, view)).toEqual(targetAction);
    ui = pressUi(game, ui, ch("i"));
    view = buildView(game, ui, bundle);
    expect(view.overlay).toMatchObject({ kind: "inspect", name: "Spot Weakness", targeted: true });
    expect(mapKey(ENTER, view)).toEqual(targetAction);
  });

  test("Spot Weakness auto-targets the sole living enemy rather than defaulting to slot zero", () => {
    const game = spotWeaknessGame();
    game.combat!.monsters[0]!.isDead = true;
    const view = buildView(game, { ...freshUi(), focus: { scope: "combat", idx: 0 } }, bundle);
    const playAction: KeyAction = { kind: "cmd", cmd: { cmd: "playCard", handIdx: 0, target: 1 } };
    expect(mapKey(ch("1"), view)).toEqual(playAction);
    expect(mapKey(ENTER, view)).toEqual(playAction);
  });
});

describe("combat slots remain separate from displayed enemy panels", () => {
  function gapCombat(): GameState {
    const game = fxCombat().game!;
    const combat = game.combat!;
    const [first, second] = combat.monsters;
    if (!first || !second) throw new Error("expected two enemies");
    const gap = {
      ...structuredClone(first), id: "GAP", hp: 0, maxHp: 0, block: 0,
      powers: [], move: null, moveHistory: [], isDead: false, isEscaped: true, data: {},
    };
    combat.monsters = [
      { ...gap, idx: 0 },
      { ...first, idx: 1, hp: 0, isDead: true },
      { ...structuredClone(gap), idx: 2 },
      { ...second, idx: 3 },
    ];
    return game;
  }

  for (const defId of ["STRIKE_RED", "SPOT_WEAKNESS"]) {
    test(`${defId} hotkey, focused Enter and inspect Enter target original slot 3 after GAP filtering`, () => {
      const game = gapCombat();
      const combat = game.combat!;
      combat.cards[combat.player.piles.hand[0]!]!.defId = defId;
      let ui: UiState = { ...freshUi(), focus: { scope: "combat", idx: 0 } };
      let view = buildView(game, ui, bundle);
      if (view.screen.kind !== "combat") throw new Error("expected combat");
      expect(view.screen.enemies.map((enemy) => enemy.combatIndex)).toEqual([1, 3]);
      const expected: KeyAction = { kind: "cmd", cmd: { cmd: "playCard", handIdx: 0, target: 3 } };
      expect(mapKey(ch("1"), view)).toEqual(expected);
      expect(mapKey(ENTER, view)).toEqual(expected);
      ui = pressUi(game, ui, ch("i"));
      view = buildView(game, ui, bundle);
      const action = mapKey(ENTER, view);
      expect(action).toEqual(expected);
      if (defId === "STRIKE_RED") {
        if (action?.kind !== "cmd") throw new Error("expected play command");
        const result = advance(game, action.cmd, bundle);
        expect(result.combat!.monsters[3]!.hp).toBeLessThan(combat.monsters[3]!.hp);
        expect(result.combat!.monsters.slice(0, 3)).toEqual(combat.monsters.slice(0, 3));
      }
    });
  }

  test("enemy focus highlights the displayed panel while tooltips retain the original enemy", () => {
    const game = gapCombat();
    const ui: UiState = { ...freshUi(), focus: { scope: "combat", idx: game.combat!.player.piles.hand.length } };
    const view = buildView(game, ui, bundle);
    if (view.screen.kind !== "combat") throw new Error("expected combat");
    expect(view.screen.enemies).toHaveLength(2);
    expect(view.screen.focusEnemy).toBe(1);
    expect(view.screen.enemies[view.screen.focusEnemy!]?.combatIndex).toBe(3);
    expect(view.tooltip?.name).toBe(view.screen.enemies[1]!.name);

    const denseGame = structuredClone(game);
    denseGame.combat!.monsters = denseGame.combat!.monsters
      .filter((monster) => monster.id !== "GAP")
      .map((monster, idx) => ({ ...monster, idx }));
    const denseView = buildView(denseGame, ui, bundle);
    expect(renderFrame(view, { cols: 120, rows: 36 }, THEME_256)).toEqual(
      renderFrame(denseView, { cols: 120, rows: 36 }, THEME_256),
    );
  });

  test("explicit target selection still sends original slots across GAP entries", () => {
    const game = gapCombat();
    const first = game.combat!.monsters[1]!;
    first.hp = first.maxHp;
    first.isDead = false;
    const view = buildView(game, {
      ...freshUi(),
      targeting: { kind: "card", handIdx: 0 },
      focus: { scope: "targeting", idx: 1 },
    }, bundle);
    expect(mapKey(ch("1"), view)).toEqual({ kind: "cmd", cmd: { cmd: "playCard", handIdx: 0, target: 1 } });
    expect(mapKey(ch("2"), view)).toEqual({ kind: "cmd", cmd: { cmd: "playCard", handIdx: 0, target: 3 } });
    expect(mapKey(ENTER, view)).toEqual(mapKey(ch("2"), view));
  });
});
