import { expect, test } from "bun:test";
import { buildBaseContentBundle } from "../../src/content";
import { createCombatGame } from "../../src/engine/game";
import { getIntents } from "../../src/engine/combat/intents";
import { buildView } from "../../src/cli/state/view";
import { initialUiState } from "../../src/cli/state/uiState";
import { publicGameState } from "../../src/cli/state/controlState";
import { renderFrame } from "../../src/cli/render/frame";
import { THEME_PLAIN } from "../../src/cli/render/theme";

const bundle = buildBaseContentBundle();

// Base damage and ascension thresholds: monsters-act1.json / monsters-act2.json.
const moves = [
  { monster: "LOOTER", move: "LOOTER_MUG", base: 10, asc2: 11 },
  { monster: "LOOTER", move: "LOOTER_LUNGE", base: 12, asc2: 14 },
  { monster: "MUGGER", move: "MUGGER_MUG", base: 10, asc2: 11 },
  { monster: "MUGGER", move: "MUGGER_LUNGE", base: 16, asc2: 18 },
];

function combat(monster: string, move: string, ascension = 5, turn = 1) {
  const game = createCombatGame({
    seed: "THIEVERY-INTENT", bundle, character: "IRONCLAD", ascension,
    deck: [{ defId: "DEFEND_RED" }], monsters: [monster],
  });
  game.run.room = { kind: "combat", roomKind: "monster", encounterId: "thievery-test", burningElite: false };
  game.run.gold = 55;
  game.combat!.turn = turn;
  game.combat!.monsters[0]!.move = move;
  return game;
}

for (const entry of moves) {
  for (const ascension of [0, 2, 5, 17]) {
    for (const turn of [1, 2]) {
      test(`${entry.move} A${ascension} turn ${turn}: public and manual damage agree`, () => {
        const game = combat(entry.monster, entry.move, ascension, turn);
        const before = structuredClone(game);
        const ui = { ...initialUiState(), screen: "run" as const, focus: { scope: "combat", idx: 1 } };
        const damage = ascension >= 2 ? entry.asc2 : entry.base;
        const gold = ascension >= 17 ? 20 : 15;
        const intent = getIntents(game, bundle)[0];
        expect(intent).toMatchObject({ damage, hits: 1, partial: false, goldLoss: gold });
        const view = buildView(game, ui, bundle);
        if (view.screen.kind !== "combat") throw new Error("expected combat");
        const shown = view.screen.enemies[0]!.intent;
        expect(shown).toMatchObject({ kind: "attack", damage, hits: 1, glyph: `/! ${damage}`, partial: false });
        expect(shown?.parts).toContainEqual({ text: `steals up to ${gold}G`, kind: "debuff" });
        expect(view.screen.threat.incoming).toBe(damage);
        expect(view.tooltip?.lines.join(" ")).toContain(`attack for ${damage}`);
        expect(view.tooltip?.lines.join(" ")).toContain(`steal up to ${gold} Gold`);
        expect(publicGameState(game, bundle, view)?.combat?.enemies[0]?.intentView).toEqual(shown);
        for (const [cols, rows] of [[80, 24], [120, 36]] as const) {
          const text = renderFrame(view, { cols, rows }, THEME_PLAIN).join("\n");
          expect(text).toContain(`/! ${damage}`);
          if (rows >= 36) expect(text).toContain(`steals up to ${gold}G`);
          else expect(text).toContain(`Thievery ${gold}`);
        }
        getIntents(game, bundle);
        expect(game).toEqual(before);
      });
    }
  }

  for (const [strength, weak, vulnerable] of [[0, false, false], [3, false, false], [0, true, false], [0, false, true], [3, true, true]] as const) {
    test(`${entry.move}: Strength ${strength}, Weak ${weak}, Vulnerable ${vulnerable}`, () => {
      const game = combat(entry.monster, entry.move);
      const c = game.combat!;
      const self = c.monsters[0]!;
      if (strength) self.powers.push({ id: "STRENGTH", amount: strength, justApplied: false, data: null });
      if (weak) self.powers.push({ id: "WEAK", amount: 1, justApplied: false, data: null });
      if (vulnerable) c.player.powers.push({ id: "VULNERABLE", amount: 1, justApplied: false, data: null });
      c.player.block = 99;
      const before = structuredClone(game);
      const damage = Math.floor((entry.asc2 + strength) * (weak ? 0.75 : 1) * (vulnerable ? 1.5 : 1));
      const intent = getIntents(game, bundle)[0];
      expect(intent).toMatchObject({ damage, hits: 1, goldLoss: 15, partial: false });
      const view = buildView(game, { ...initialUiState(), screen: "run" }, bundle);
      if (view.screen.kind !== "combat") throw new Error("expected combat");
      expect(view.screen.threat).toEqual({ incoming: damage, block: 99 });
      expect(publicGameState(game, bundle, view)?.combat?.enemies[0]?.intentView?.damage).toBe(damage);
      expect(game).toEqual(before);
    });
  }
}

test("theft projection uses only current gold and visible Thievery, not stolen-gold history", () => {
  const game = combat("LOOTER", "LOOTER_MUG");
  const self = game.combat!.monsters[0]!;
  self.powers.find(p => p.id === "THIEVERY")!.amount = 20;
  for (const gold of [0, 7, 55]) {
    game.run.gold = gold;
    const expected = Math.min(gold, 20);
    const before = structuredClone(game);
    const intent = getIntents(game, bundle)[0];
    expect(intent).toMatchObject({ goldLoss: expected, damage: 11, partial: false });
    expect(game).toEqual(before);
    self.data.stolenGold = 999;
    expect(getIntents(game, bundle)[0]).toEqual(intent);
  }
});

test("thieving attack previews never execute their move effects", () => {
  for (const entry of moves) {
    const game = combat(entry.monster, entry.move);
    const def = bundle.monsters.get(entry.monster)!;
    const move = def.moves[entry.move]!;
    let executes = 0;
    const isolatedBundle = {
      ...bundle,
      monsters: new Map(bundle.monsters).set(entry.monster, {
        ...def, moves: {
          ...def.moves, [entry.move]: {
            ...move, execute: () => { executes++; throw new Error("move effects must not run"); },
          },
        },
      }),
    };
    const before = structuredClone(game);
    expect(getIntents(game, isolatedBundle)[0]).toMatchObject({ damage: entry.asc2, hits: 1, goldLoss: 15, partial: false });
    expect(executes).toBe(0);
    expect(game).toEqual(before);
  }
});

test("damage-only, failed, and genuinely random previews remain honestly partial", () => {
  const game = combat("LOOTER", "LOOTER_MUG");
  const def = bundle.monsters.get("LOOTER")!;
  const move = def.moves.LOOTER_MUG!;
  for (const displayDamage of [
    () => ({ damage: 11, hits: 1 }),
    () => null,
    () => { throw new Error("unknown"); },
  ]) {
    const isolatedBundle = {
      ...bundle, monsters: new Map(bundle.monsters).set("LOOTER", {
        ...def, moves: { ...def.moves, LOOTER_MUG: { ...move, displayDamage } },
      }),
    };
    expect(getIntents(game, isolatedBundle)[0]?.partial).toBe(true);
  }
  const heart = combat("CORRUPT_HEART", "CORRUPT_HEART_DEBILITATE");
  const before = structuredClone(heart);
  expect(getIntents(heart, bundle)[0]?.partial).toBe(true);
  expect(heart).toEqual(before);
});

test("Runic Dome still hides thief damage, theft, and incoming totals", () => {
  const game = combat("MUGGER", "MUGGER_MUG");
  game.run.relics.push({ defId: "RUNIC_DOME", counter: 0 });
  const view = buildView(game, {
    ...initialUiState(), screen: "run", focus: { scope: "combat", idx: 1 },
  }, bundle);
  if (view.screen.kind !== "combat") throw new Error("expected combat");
  expect(view.screen.enemies[0]?.intent).toBeNull();
  expect(view.screen.threat.incoming).toBeNull();
  expect(publicGameState(game, bundle, view)?.combat?.enemies[0]?.intentView).toBeNull();
  expect(view.tooltip?.lines.join(" ")).not.toContain("steal up to");
  expect(renderFrame(view, { cols: 120, rows: 36 }, THEME_PLAIN).join("\n")).not.toContain("steals up to");
});
