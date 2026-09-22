import { describe, expect, test } from "bun:test";
import { buildBaseContentBundle } from "../../src/content";
import { createRun } from "../../src/engine/game";
import { mapKey } from "../../src/cli/input/keymap";
import { isAppAction, type KeyAction } from "../../src/cli/input/actions";
import { controlKey } from "../../src/cli/state/control";
import { publicUi, resolveControl } from "../../src/cli/state/controlUi";
import { applyUiAction, initialUiState, type UiState } from "../../src/cli/state/uiState";
import { buildView } from "../../src/cli/state/view";
import { renderFrame } from "../../src/cli/render/frame";
import { THEME_PLAIN } from "../../src/cli/render/theme";

const bundle = buildBaseContentBundle();

function merchant(gold = 55, sold = false) {
  const game = createRun({ seed: "SHOP-CONTROLS", bundle, character: "IRONCLAD" });
  game.run.gold = gold;
  game.run.floor = 52;
  const shop = {
    cards: Array.from({ length: 7 }, () => ({
      id: "RAMPAGE", rarity: "uncommon" as const, colorless: false, price: 69, sold,
    })),
    relics: Array.from({ length: 3 }, () => ({
      id: "ANCHOR", tier: "common" as const, price: 69, sold,
    })),
    potions: Array.from({ length: 3 }, () => ({ id: "FIRE_POTION", price: 69, sold })),
    removalCost: 69,
    removalUsed: sold,
  };
  game.run.room = { kind: "shop", shop };
  const ui: UiState = { ...initialUiState(), screen: "run" };
  return { game, shop, ui };
}

function applyUi(ui: UiState, action: KeyAction | null): UiState {
  if (action?.kind !== "ui" || isAppAction(action.act)) throw new Error("expected pure UI action");
  return applyUiAction(ui, action.act);
}

describe("merchant purchase controls", () => {
  for (const { kind, index } of [
    { kind: "card", index: 0 },
    { kind: "relic", index: 7 },
    { kind: "potion", index: 10 },
  ] as const) {
    for (const [gold, sold] of [[55, false], [68, false], [69, false], [100, false], [55, true], [100, true]] as const) {
      test(`${kind}: ${gold}G, sold=${sold}, agrees across row, inspector and public controls`, () => {
        const { game, ui } = merchant(gold, sold);
        const before = structuredClone(game);
        ui.focus = { scope: "shop", idx: index };
        const view = buildView(game, ui, bundle);
        if (view.screen.kind !== "shop") throw new Error("expected shop");
        const note = sold ? "sold" : gold < 69 ? "need 69G" : null;
        const expected: KeyAction = note
          ? { kind: "ui", act: { type: "toast", text: note } }
          : { kind: "cmd", cmd: { cmd: "shopBuy", kind, idx: 0 } };
        const row = view.screen.list.items.find(item => item.i === index)!;
        expect(row.enabled).toBe(note === null);
        expect(row.note).toBe(note);
        if (kind === "card") expect(row.label).toContain("Rampage");
        expect(mapKey(controlKey(row.key!)!, view)).toEqual(expected);
        expect(mapKey({ kind: "enter" }, view)).toEqual(expected);
        const control = publicUi(game, ui, view).controls.find(c => c.key === row.key)!;
        expect(control.enabled).toBe(note === null);
        for (const action of [{ kind: "key", key: row.key! }, { kind: "key", key: "ENTER" }, { kind: "select", id: control.id }] as const) {
          if (note) expect(() => resolveControl(action, game, ui, view, bundle)).toThrow("DISABLED");
          else expect(resolveControl(action, game, ui, view, bundle).action).toEqual(expected);
        }

        const inspecting = applyUi(ui, mapKey({ kind: "char", ch: "i" }, view));
        const inspected = buildView(game, inspecting, bundle);
        expect(mapKey({ kind: "enter" }, inspected)).toEqual(expected);
        const enter = publicUi(game, inspecting, inspected).controls.find(c => c.key === "ENTER")!;
        expect(enter.enabled).toBe(note === null);
        for (const action of [{ kind: "key", key: "ENTER" }, { kind: "select", id: enter.id }] as const) {
          if (note) expect(() => resolveControl(action, game, inspecting, inspected, bundle)).toThrow("DISABLED");
          else expect(resolveControl(action, game, inspecting, inspected, bundle).action).toEqual(expected);
        }
        expect(game).toEqual(before);
      });
    }
  }
});

describe("merchant removal controls", () => {
  for (const [gold, used] of [[55, false], [68, false], [69, false], [100, false], [55, true], [100, true]] as const) {
    test(`${gold}G, used=${used}, agrees across service and deck picker`, () => {
      const { game, ui } = merchant(gold, used);
      const before = structuredClone(game);
      ui.focus = { scope: "shop", idx: 13 };
      const view = buildView(game, ui, bundle);
      if (view.screen.kind !== "shop") throw new Error("expected shop");
      const note = used ? "used" : gold < 69 ? "need 69G" : null;
      const expected: KeyAction = note
        ? { kind: "ui", act: { type: "toast", text: note } }
        : { kind: "ui", act: { type: "openOverlay", overlay: { kind: "deck", mode: "remove", page: 0 } } };
      const row = view.screen.list.items.find(item => item.i === 13)!;
      expect(row.enabled).toBe(note === null);
      expect(row.note).toBe(note);
      expect(mapKey(controlKey(row.key!)!, view)).toEqual(expected);
      expect(mapKey({ kind: "enter" }, view)).toEqual(expected);
      const control = publicUi(game, ui, view).controls.find(c => c.key === row.key)!;
      expect(control.enabled).toBe(note === null);
      for (const action of [{ kind: "key", key: row.key! }, { kind: "key", key: "ENTER" }, { kind: "select", id: control.id }] as const) {
        if (note) expect(() => resolveControl(action, game, ui, view, bundle)).toThrow("DISABLED");
        else expect(resolveControl(action, game, ui, view, bundle).action).toEqual(expected);
      }

      const removing = applyUiAction(ui, { type: "openOverlay", overlay: { kind: "deck", mode: "remove", page: 0 } });
      const deck = buildView(game, removing, bundle);
      const remove: KeyAction = note
        ? { kind: "ui", act: { type: "toast", text: note } }
        : { kind: "cmd", cmd: { cmd: "shopRemove", deckIdx: 0 } };
      expect(mapKey({ kind: "char", ch: "1" }, deck)).toEqual(remove);
      const card = publicUi(game, removing, deck).controls.find(c => c.key === "1")!;
      expect(card.enabled).toBe(note === null);
      if (note) expect(() => resolveControl({ kind: "select", id: card.id }, game, removing, deck, bundle)).toThrow("DISABLED");
      else expect(resolveControl({ kind: "select", id: card.id }, game, removing, deck, bundle).action).toEqual(remove);
      expect(game).toEqual(before);
    });
  }
});

describe("merchant potion shortcut", () => {
  for (const vimKeys of [false, true]) {
    for (const page of [0, 1]) {
      test(`P opens carried potions on page ${page + 1}, vim=${vimKeys}, without stealing p`, () => {
        const { game, ui } = merchant();
        game.run.potions = [null, "FIRE_POTION", "BLOCK_POTION"];
        ui.vimKeys = vimKeys;
        ui.page = page;
        const before = structuredClone(game);
        const view = buildView(game, ui, bundle);
        expect(mapKey({ kind: "char", ch: "p" }, view)).toEqual({ kind: "ui", act: { type: "page", delta: -1 } });
        expect(mapKey({ kind: "char", ch: "n" }, view)).toEqual({ kind: "ui", act: { type: "page", delta: 1 } });
        const open: KeyAction = { kind: "ui", act: { type: "openOverlay", overlay: { kind: "potions" } } };
        expect(mapKey({ kind: "char", ch: "P" }, view)).toEqual(open);
        const shortcut = publicUi(game, ui, view).controls.find(c => c.key === "P")!;
        expect(shortcut.enabled).toBe(true);
        expect(resolveControl({ kind: "select", id: shortcut.id }, game, ui, view, bundle).action).toEqual(open);
        expect(resolveControl({ kind: "key", key: "P" }, game, ui, view, bundle).action).toEqual(open);
        expect(view.hint).toContain("[P] potions");
        const frame = renderFrame(view, { cols: 80, rows: 24 }, THEME_PLAIN).join("\n");
        expect(frame).toContain("[P] potions");
        expect(frame).toContain("[q] quit");

        const potions = applyUi(ui, open);
        const inventory = buildView(game, potions, bundle);
        const potion = publicUi(game, potions, inventory).controls.find(c => c.label.includes("Fire Potion"))!;
        const menu = resolveControl({ kind: "select", id: potion.id }, game, potions, inventory, bundle).action;
        expect(mapKey(controlKey(potion.key!)!, inventory)).toEqual(menu);
        const menuUi = applyUi(potions, menu);
        const menuView = buildView(game, menuUi, bundle);
        const discard: KeyAction = { kind: "cmd", cmd: { cmd: "discardPotion", slot: 1 } };
        expect(mapKey({ kind: "char", ch: "d" }, menuView)).toEqual(discard);
        const discardControl = publicUi(game, menuUi, menuView).controls.find(c => c.key === "d")!;
        expect(resolveControl({ kind: "select", id: discardControl.id }, game, menuUi, menuView, bundle).action).toEqual(discard);
        const closedMenu = applyUi(menuUi, mapKey({ kind: "esc" }, menuView));
        const closed = applyUi(closedMenu, mapKey({ kind: "esc" }, buildView(game, closedMenu, bundle)));
        const restored = buildView(game, closed, bundle);
        expect(restored.mode).toBe("shop");
        expect(publicUi(game, closed, restored).page).toBe(page);
        expect(game).toEqual(before);
      });
    }
  }

  test("p remains a potion shortcut when the run screen has no pagination", () => {
    const { game, shop, ui } = merchant();
    shop.cards.length = 1;
    shop.relics.length = 1;
    shop.potions.length = 1;
    for (const room of [game.run.room, { kind: "map" } as const]) {
      game.run.room = room;
      const view = buildView(game, ui, bundle);
      const open: KeyAction = { kind: "ui", act: { type: "openOverlay", overlay: { kind: "potions" } } };
      expect(mapKey({ kind: "char", ch: "p" }, view)).toEqual(open);
      expect(mapKey({ kind: "char", ch: "P" }, view)).toEqual(open);
    }
  });
});
