import type { GameState } from "../../engine/game";
import type { ContentBundle } from "../../engine/content/defs";
import { needsEnemyTarget } from "../../engine/content/targeting";
import { getCardCost } from "../../engine/combat/preview";
import { buildEventView } from "../text/runlogic";
import type { View } from "./view";

/** An allowlist, never a serialization of the engine or its save envelope. */
export function publicGameState(game: GameState | null, bundle: ContentBundle, view: View) {
  if (!game) return null;
  const { run, combat: c } = game;
  const powers = (items: { id: string; amount: number }[]) =>
    items.filter(p => !bundle.powers.get(p.id)?.hidden).map(p => ({ id: p.id, amount: p.amount }));
  const card = (iid: number, slot: number) => {
    const item = c?.cards[iid];
    return item ? {
      slot, iid, card: item.defId, upgrade: item.upgrades, cost: getCardCost(game, bundle, item),
    } : {
      slot, iid, card: run.deck[iid]?.defId ?? "?", upgrade: run.deck[iid]?.upgrades ?? 0, cost: null,
    };
  };
  const req = game.pending?.request;
  // Choice rows own the addressing, including filtered and paged deck choices.
  const choiceRows = view.overlay?.kind === "choice" ? view.overlay.list.items : [];
  const choices = !req ? null : req.kind === "option"
    ? { kind: req.kind, reason: req.reason, options: [...req.options] }
    : {
      kind: req.kind, reason: req.kind === "cards" ? req.reason : "Scry",
      min: req.kind === "cards" ? req.min : 0,
      max: req.kind === "cards" ? req.max : req.iids.length,
      cards: choiceRows.flatMap(row => {
        const iid = req.iids[row.i];
        return iid === undefined ? [] : [{ key: row.key, ...card(iid, row.i + 1) }];
      }),
    };
  const room = run.room;
  const publicRoom = (() => {
    switch (room?.kind) {
      case "neow": return { kind: room.kind, options: room.options.map((o, i) => ({
        key: String((i + 1) % 10), bonus: o.bonus, drawback: o.drawback,
      })) };
      case "combat": return { kind: room.kind, encounterId: room.encounterId, roomKind: room.roomKind };
      case "event": {
        const event = buildEventView(game, bundle);
        return {
          kind: room.kind, eventId: room.eventId, screen: room.screen,
          eventChoicePending: !!req,
          eventView: event ? {
            summary: event.summary,
            body: view.screen.kind === "event" ? view.screen.intro.slice(1) : event.body,
            options: event.options.map(o => ({ label: o.label, enabled: o.enabled })),
          } : null,
        };
      }
      case "rewards": return { kind: room.kind, entries: room.entries.map((entry, i) => ({
        key: String((i + 1) % 10), kind: entry.kind, taken: entry.taken,
        ...("id" in entry ? { id: entry.id } : {}),
        ...("group" in entry ? { group: entry.group } : {}),
        ...("amount" in entry ? { amount: entry.amount } : {}),
        ...("upgraded" in entry ? { upgraded: entry.upgraded, rarity: entry.rarity } : {}),
      })) };
      case "shop": {
        const stock = (items: { id: string; price: number; sold: boolean }[]) =>
          items.map(s => ({ id: s.id, price: s.price, sold: s.sold }));
        return { kind: room.kind, shop: {
          cards: stock(room.shop.cards), relics: stock(room.shop.relics), potions: stock(room.shop.potions),
          removalCost: room.shop.removalCost, removalUsed: room.shop.removalUsed,
        } };
      }
      case "rest": return { kind: room.kind, used: room.used };
      case "treasure": return { kind: room.kind, opened: room.chest.opened, size: room.chest.size };
      case "gameOver": return { kind: room.kind, victory: room.victory };
      default: return { kind: room?.kind ?? (c ? "combat" : "unknown") };
    }
  })();
  const node = (n: NonNullable<NonNullable<typeof run.map>["rows"][number][number]>) => ({
    x: n.x, y: n.y, kind: n.kind, edges: [...n.edges], burningElite: n.burningElite,
  });
  const current = run.position ? run.map?.rows[run.position[1]]?.[run.position[0]] : null;
  const next = run.map?.rows[run.position ? run.position[1] + 1 : 0] ?? [];
  const combatView = view.screen.kind === "combat" ? view.screen : null;
  const hideIntents = run.relics.some(r => r.defId === "RUNIC_DOME");
  return {
    seed: game.seed, character: run.character, ascension: run.ascension, act: run.act, floor: run.floor,
    hp: run.hp, maxHp: run.maxHp, gold: run.gold,
    keys: { emerald: run.keys.emerald, ruby: run.keys.ruby, sapphire: run.keys.sapphire },
    potions: [...run.potions], relics: run.relics.map(r => ({ id: r.defId, counter: r.counter })),
    deckCount: run.deck.length,
    deck: run.deck.map((d, index) => ({ index, defId: d.defId, upgrades: d.upgrades, misc: d.misc, bottled: d.bottled })),
    room: publicRoom, choices,
    outcome: game.outcome ? { kind: game.outcome.kind } : null,
    map: run.map ? {
      boss: run.map.bossId, position: run.position ? [...run.position] : null,
      paths: next.filter(n => n !== null && (!current || current.edges.includes(n.x))).map(n => node(n!)),
      rows: run.map.rows.map(row => row.map(n => n ? node(n) : null)),
    } : null,
    combat: c ? {
      turn: c.turn, energy: c.player.energy, block: c.player.block, powers: powers(c.player.powers),
      piles: { draw: c.player.piles.draw.length, discard: c.player.piles.discard.length, exhaust: c.player.piles.exhaust.length },
      hand: c.player.piles.hand.map((iid, i) => ({
        ...card(iid, i + 1), playable: combatView?.hand[i]?.playable ?? false,
        targeted: needsEnemyTarget(bundle.cards.get(c.cards[iid]?.defId ?? "")?.target),
      })),
      enemies: c.monsters.flatMap((m, index) => m.id === "GAP" || m.isDead || m.isEscaped ? [] : [{
        index, id: m.id, hp: m.hp, maxHp: m.maxHp, block: m.block, halfDead: m.halfDead,
        intent: hideIntents ? null : m.move,
        intentView: hideIntents ? null : combatView?.enemies[c.monsters.slice(0, index).filter(m => m.id !== "GAP").length]?.intent ?? null,
        powers: powers(m.powers),
      }]).map((m, i) => ({ slot: i + 1, ...m })),
    } : null,
  };
}

export type PublicGameState = ReturnType<typeof publicGameState>;

/** The human pile browser and unopened chest can reveal more than this API allows. */
export function controlSafeView(view: View): View {
  const safe = structuredClone(view);
  if (safe.screen.kind === "treasure" && safe.screen.list.items.some(item =>
    item.action?.kind === "cmd" && item.action.cmd.cmd === "openChest")) {
    safe.screen.intro = ["Chest contents are not exposed by the control bridge."];
    safe.screen.list.items.forEach(item => { item.sub = null; });
    safe.tooltip = null;
  }
  if ((safe.overlay?.kind === "list" && safe.overlay.id === "pile") ||
      (safe.overlay?.kind === "inspect" && safe.overlay.source.of === "pile")) {
    if (safe.overlay.kind === "list") {
      safe.overlay.list.items.forEach(item => {
        item.label = "Pile card (redacted)"; item.sub = null; item.note = null;
      });
    } else {
      safe.overlay.name = "Pile card (redacted)";
      safe.overlay.cost = null; safe.overlay.type = ""; safe.overlay.rules = [];
      safe.overlay.keywords = []; safe.overlay.alt = null; safe.overlay.targeted = false;
    }
    safe.tooltip = null;
  }
  return safe;
}
