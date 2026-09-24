import { describe, expect, test } from "bun:test";
import { runHeartGym, type HeartGymSpec } from "../../tools/heart-gym";

const starterDeck = [
  ...Array.from({ length: 5 }, () => ({ defId: "STRIKE_RED" })),
  ...Array.from({ length: 4 }, () => ({ defId: "DEFEND_RED" })),
  { defId: "BASH" },
];

const baseSpec: HeartGymSpec = {
  seed: "GYMTEST",
  ascension: 6,
  hp: 50,
  maxHp: 80,
  deck: starterDeck,
  relics: ["BURNING_BLOOD"],
  potions: [null, null, null],
};

describe("heart gym", () => {
  test("replays deterministically from the same spec and commands", () => {
    const commands = ["end", "end"];
    const a = runHeartGym(baseSpec, commands);
    const b = runHeartGym(baseSpec, commands);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("starts the A6 Heart with 750 HP and Invincible 300", () => {
    const output = runHeartGym(baseSpec);
    expect(output.enemies).toHaveLength(1);
    expect(output.enemies[0]!.id).toBe("CORRUPT_HEART");
    expect(output.enemies[0]!.maxHp).toBe(750);
    expect(output.enemies[0]!.powers).toContainEqual({ id: "INVINCIBLE", amount: 300 });
  });

  test("invalid commands include the failing command index", () => {
    expect(() => runHeartGym(baseSpec, ["play 999"])).toThrow("command 0:");
  });

  test("can start another real encounter", () => {
    const output = runHeartGym({ ...baseSpec, encounter: "DONU_AND_DECA" });
    expect(output.enemies.map((enemy) => enemy.id)).toEqual(["DECA", "DONU"]);
    expect(output.outcome).toBe("ongoing");
  });
});
