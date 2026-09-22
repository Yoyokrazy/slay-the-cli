import type { GameState } from "../../engine/game";
import type { ContentBundle } from "../../engine/content/defs";
import { needsEnemyTarget } from "../../engine/content/targeting";
import type { KeyAction } from "../input/actions";
import { mapKey } from "../input/keymap";
import { controlKey, controlKeys, type ControlAction } from "./control";
import type { UiState, InspectSource } from "./uiState";
import type { View, ListView } from "./view";

export interface PublicControl {
  id: string;
  key?: string;
  label: string;
  enabled: boolean;
  selected: boolean;
  focused: boolean;
}
export interface LiveControl extends PublicControl { action: KeyAction | null }

function cardIdentity(g: GameState | null, index: number): string {
  const card = g?.run.deck[index];
  return `deck:${index}:${card?.defId ?? "missing"}:${card?.upgrades ?? 0}`;
}

function sourceIdentity(g: GameState | null, source: InspectSource, index: number): string {
  switch (source.of) {
    case "deck": return cardIdentity(g, index);
    case "hand": return `hand:${g?.combat?.player.piles.hand[index] ?? "missing"}`;
    case "relics": return `relic:${index}:${g?.run.relics[index]?.defId ?? "missing"}`;
    case "potions": return `potion:${index}:${g?.run.potions[index] ?? "missing"}`;
    // Pile positions are navigation only; never encode hidden card identities.
    case "pile": return `pile:${source.pile}:position:${index}`;
    case "choice": {
      const r = g?.pending?.request;
      const iid = r && r.kind !== "option" ? r.iids[index] : undefined;
      return iid === undefined ? `option:${index}` : g?.combat ? `choice:card:${iid}` : `choice:${cardIdentity(g, iid)}`;
    }
    case "reward": {
      const room = g?.run.room;
      const entries = room?.kind === "rewards" ? room.entries.filter(e => "id" in e) : [];
      const entry = entries[index];
      return `reward:${index}:${entry && "id" in entry ? entry.id : "missing"}`;
    }
    case "shop": {
      const room = g?.run.room;
      const slots = room?.kind === "shop" ? [...room.shop.cards, ...room.shop.relics, ...room.shop.potions] : [];
      return `shop:${index}:${slots[index]?.id ?? "missing"}`;
    }
  }
}

function firstCardRewardIndexForGroup(g: GameState | null, group: number): number | null {
  const room = g?.run.room;
  if (room?.kind !== "rewards") return null;
  const idx = room.entries.findIndex((e) => e.kind === "card" && e.group === group);
  return idx === -1 ? null : idx;
}

function actionIdentity(action: KeyAction, g: GameState | null): string {
  if (action.kind === "cmd") {
    const c = action.cmd;
    switch (c.cmd) {
      case "playCard": return `play:${g?.combat?.player.piles.hand[c.handIdx] ?? "missing"}:target:${c.target ?? "none"}`;
      case "choose": return `choose:${c.indices.join(",")}`;
      case "shopRemove": return `remove:${cardIdentity(g, c.deckIdx)}`;
      case "restOption": return `rest:${c.kind}:${c.deckIdx === undefined ? "" : cardIdentity(g, c.deckIdx)}`;
      case "shopBuy": {
        const room = g?.run.room;
        const slots = room?.kind === "shop" ? c.kind === "card" ? room.shop.cards : c.kind === "relic" ? room.shop.relics : room.shop.potions : [];
        return `buy:${c.kind}:${c.idx}:${slots[c.idx]?.id ?? "missing"}`;
      }
      case "takeReward": {
        const r = g?.run.room;
        const entry = r?.kind === "rewards" ? r.entries[c.i] : null;
        return `reward:${c.i}:${entry?.kind}:${entry && "id" in entry ? entry.id : ""}`;
      }
      case "takeSingingBowlReward":
        return `reward:${firstCardRewardIndexForGroup(g, c.group) ?? c.group}:singingBowl:SINGING_BOWL`;
      case "eventOption": {
        const r = g?.run.room;
        return `event:${r?.kind === "event" ? `${r.eventId}:${r.screen ?? "start"}` : "missing"}:${c.i}`;
      }
      case "neowPick": {
        const r = g?.run.room;
        const option = r?.kind === "neow" ? r.options[c.i] : null;
        return `neow:${c.i}:${option?.bonus}:${option?.drawback}`;
      }
      case "usePotion":
      case "discardPotion":
        return `${c.cmd}:${c.slot}:${g?.run.potions[c.slot] ?? "empty"}:${"target" in c ? c.target : ""}`;
      default: return JSON.stringify(c);
    }
  }
  const a = action.act;
  if (a.type === "toggleChoice") return `toggle:${sourceIdentity(g, { of: "choice" }, a.i)}`;
  if (a.type === "setTargeting" && a.targeting?.kind === "card") {
    return `aim:${g?.combat?.player.piles.hand[a.targeting.handIdx] ?? "missing"}`;
  }
  if (a.type === "openOverlay" && a.overlay.kind === "inspect") {
    return `inspect:${sourceIdentity(g, a.overlay.source, a.overlay.index)}`;
  }
  if (a.type === "openOverlay" && a.overlay.kind === "potionMenu") {
    return `potion:${a.overlay.slot}:${g?.run.potions[a.overlay.slot] ?? "empty"}`;
  }
  return JSON.stringify(a);
}

export function controlActionError(action: KeyAction | null): string | null {
  if (!action) return "UNAVAILABLE: no action in this UI context";
  if (action.kind === "ui") {
    if (action.act.type === "toast") return `DISABLED: ${action.act.text}`;
    if (action.act.type === "toggleVimKeys" ||
        (action.act.type === "openOverlay" && action.act.overlay.kind === "settings")) {
      return "DISABLED: settings are controlled only by the human terminal";
    }
  }
  return null;
}

function activeList(view: View): ListView | null {
  if (view.overlay) return "list" in view.overlay ? view.overlay.list : null;
  return "list" in view.screen ? view.screen.list : null;
}

export function liveControls(game: GameState | null, ui: UiState, view: View): LiveControl[] {
  const result: LiveControl[] = [];
  const scope = game?.combat
    ? JSON.stringify([game.seed, game.run.act, game.run.floor, game.combat.combatFlags.encounterId, ui.logEra])
    : game ? JSON.stringify([game.seed, game.run.act, game.run.floor]) : "menu";
  const context = `${view.mode}:${view.overlay?.kind ?? view.screen.kind}:${scope}`;
  const add = (action: KeyAction | null, label: string, key: string | undefined, enabled: boolean,
    focused = false, selected = false, identity?: string) => {
    const id = `${context}:${identity ?? (action ? actionIdentity(action, game) : `inert:${key ?? label}`)}`;
    if (result.some(c => c.id === id)) return;
    result.push({ id, ...(key ? { key } : {}), label, enabled: enabled && !controlActionError(action), focused, selected, action });
  };
  const list = activeList(view);
  if (list) {
    for (const item of list.items) {
      const action = item.action ?? (view.mode === "choice" && item.key ? mapKey(controlKey(item.key)!, view) : null);
      const selected = view.overlay?.kind === "choice" && view.overlay.selected.includes(item.i);
      let identity: string | undefined;
      if (view.mode === "choice") identity = sourceIdentity(game, { of: "choice" }, item.i);
      if (view.overlay?.kind === "list" && view.overlay.id === "relics") {
        identity = `relic:${item.i}:${game?.run.relics[item.i]?.defId ?? "none"}`;
      }
      const atLimit = action?.kind === "ui" && action.act.type === "toggleChoice" &&
        action.act.max !== 1 && ui.choiceSel.length >= action.act.max && !selected;
      add(action, item.label, item.key ?? undefined, item.enabled && !atLimit, list.focusI === item.i, selected, identity);
    }
  } else if (view.mode === "menu" && view.screen.kind === "menu") {
    view.screen.characters.forEach((c, i) => add(mapKey(controlKey(c.key)!, view), c.name, c.key, true,
      view.focusIdx === i, c.selected, `character:${c.id}`));
  } else if (view.mode === "combat" && view.screen.kind === "combat") {
    const screen = view.screen;
    view.screen.hand.forEach((card, i) => {
      const iid = game?.combat?.player.piles.hand[i];
      add(card.key ? mapKey(controlKey(card.key)!, view) : null, card.name, card.key ?? undefined,
        card.playable, view.screen.kind === "combat" && view.screen.focusHand === i, false, `hand:${iid}`);
    });
    screen.enemies.forEach((enemy, i) => add(null, enemy.name, undefined, false,
      screen.focusEnemy === i, false, `enemy:${enemy.combatIndex}:${enemy.id}`));
    screen.potions.forEach((potion, slot) => {
      if (potion) add({ kind: "ui", act: { type: "openOverlay", overlay: { kind: "potionMenu", slot } } },
        potion.name, undefined, true, screen.focusPotionSlot === slot, false, `potion:${slot}:${game?.run.potions[slot]}`);
    });
  } else if (view.mode === "targeting") {
    view.targeting?.targets.forEach((target, i) => add(target.action, target.name, target.key, true,
      view.targeting?.focusIdx === i));
  } else if (view.mode === "map" && view.screen.kind === "map") {
    view.screen.picks.forEach((p, i) => add(mapKey(controlKey(p.key)!, view), `${p.glyph} (${p.x},${p.y})`,
      p.key, true, view.focusIdx === i));
  }
  for (const key of controlKeys) {
    // A seed character is accepted by /act but is not a hundred menu options.
    if (view.mode === "textInput" && key.length === 1) continue;
    if (result.some(c => c.key === key)) continue;
    const action = mapKey(controlKey(key)!, view);
    if (action) {
      const focused = view.mode === "menu" && view.screen.kind === "menu" && action.kind === "ui" &&
        ((action.act.type === "newRun" && view.focusIdx === 4) ||
         (action.act.type === "continueRun" && view.focusIdx === 5) ||
         (action.act.type === "openOverlay" && action.act.overlay.kind === "settings" && view.focusIdx === view.screen.settingsIdx));
      const label = action.kind === "cmd" ? action.cmd.cmd : action.act.type === "randomSeed" ? "Random seed" : action.act.type;
      add(action, label, key, true, focused);
    }
  }
  return result;
}

export function publicUi(game: GameState | null, ui: UiState, view: View) {
  const controls = liveControls(game, ui, view).map(({ action: _action, ...c }) => c);
  const list = activeList(view);
  return {
    mode: view.mode, screen: view.screen.kind,
    overlay: view.overlay ? {
      kind: view.overlay.kind, ...("id" in view.overlay ? { id: view.overlay.id } : {}),
      ...("source" in view.overlay ? { source: view.overlay.source, index: view.overlay.index } : {}),
    } : null,
    ...(list ? { page: list.page, pages: list.pages, total: list.total } : {}),
    focus: controls.filter(c => c.focused).map(c => c.id),
    selected: controls.filter(c => c.selected).map(c => c.id),
    controls, toast: view.toast,
    menu: view.screen.kind === "menu" ? {
      seed: view.screen.seed, seedEdit: view.screen.seedEdit, ascension: view.screen.ascension,
      character: ui.character, canContinue: view.screen.continueDesc !== null,
    } : null,
    targeting: ui.targeting?.kind === "card"
      ? { kind: "card", iid: game?.combat?.player.piles.hand[ui.targeting.handIdx] }
      : ui.targeting ? { kind: "potion", slot: ui.targeting.slot } : null,
  };
}

export function resolveControl(action: ControlAction, game: GameState | null, ui: UiState, view: View, bundle: ContentBundle) {
  if (action.kind === "play" || action.kind === "end") {
    if (view.mode !== "combat" || view.screen.kind !== "combat" || !game?.combat || game.pending) {
      throw new Error("UI_CONTEXT: play/end require unobstructed combat");
    }
    if (action.kind === "end") return { action: { kind: "cmd", cmd: { cmd: "endTurn" } } as KeyAction, identity: "endTurn" };
    const index = game.combat.player.piles.hand.indexOf(action.iid);
    const card = view.screen.hand[index];
    if (!card || !card.key) throw new Error("MISSING: card IID is not in the visible hand");
    if (!card.playable) throw new Error("DISABLED: card is not playable");
    const instance = game.combat.cards[action.iid];
    const targeted = needsEnemyTarget(instance ? bundle.cards.get(instance.defId)?.target : undefined);
    const alive = game.combat.monsters.map((m, i) => ({ m, i })).filter(({ m }) => m.id !== "GAP" && !m.isDead && !m.isEscaped);
    if (!targeted && action.target !== undefined) throw new Error("INVALID_TARGET: card does not target an enemy");
    const target = targeted ? action.target ?? (alive.length === 1 ? 1 : undefined) : undefined;
    if (targeted && (target === undefined || !alive[target - 1])) throw new Error("INVALID_TARGET: choose a current living enemy slot");
    const cmd = { cmd: "playCard" as const, handIdx: index, ...(target ? { target: alive[target - 1]!.i } : {}) };
    return { action: { kind: "cmd", cmd } as KeyAction, identity: `play:${action.iid}:target:${target ?? "none"}` };
  }
  const controls = liveControls(game, ui, view);
  if (action.kind === "select") {
    const control = controls.find(c => c.id === action.id);
    if (!control) throw new Error("MISSING: control ID is not in the current UI");
    if (!control.enabled || !control.action) throw new Error("DISABLED: control is not enabled");
    return { action: control.action, identity: control.id, label: control.label };
  }
  const key = controlKey(action.key);
  const control = controls.find(c => c.key === action.key);
  const mapped = key ? mapKey(key, view) : null;
  const error = controlActionError(mapped);
  if (error || (control && !control.enabled)) throw new Error(error ?? "DISABLED: control is not enabled");
  return { action: mapped!, identity: control?.id ?? `key:${action.key}`, label: control?.label };
}
