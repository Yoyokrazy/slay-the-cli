// Combat rewards, per data/corpus/meta.json (cardRewards, potionDrop,
// goldRewards, relicTierRolls), checked line by line against the decompiled
// game (AbstractDungeon.getRewardCards / rollRarity / returnRandomPotion,
// AbstractRoom.update + addPotionToRewards, MonsterRoomElite.dropReward,
// CombatRewardScreen.setupItemReward), which wins where sts_lightspeed's
// GameContext.cpp disagrees.
// Stream discipline: gold = treasureRng (boss: miscRng), cards = cardRng,
// potions = potionRng, relic tiers = relicRng. Relic identities come from the
// run-start shuffled pools (no rng at obtain time).
//
// ENGINE-GAP: AbstractRelic.canSpawn is not modelled at pool pops (floor caps,
// Ectoplasm act 1, Black Blood/Frozen Core/Holy Water/Ring of the Serpent,
// bottles, campfire relics); the shop applies its own ShopRoom exclusions.

import type { EffectCtx } from "../content/defs";
import type { RunState, RewardEntry, CardRarityRoll, RelicPoolTier } from "./runState";
import type { CardId, CharacterId, PotionId, RelicId } from "../core/ids";

// --- constants (audited against meta.json by tests/audit/metaAudit.test.ts) ----

export const CARD_REWARD = {
  baseCount: 3,
  questionCardModifier: 1,
  bustedCrownModifier: -2,
  rareChance: { elite: 10, nonElite: 3 },
  uncommonChance: { elite: 40, nonElite: 37 },
  pityInitial: 5,
  pityFloor: -40,
} as const;

export const UPGRADE_CHANCES = {
  act1: 0.0,
  act2: { base: 0.25, ascension12Plus: 0.125 },
  act3AndBeyond: { base: 0.5, ascension12Plus: 0.25 },
} as const;

/** AbstractDungeon.colorlessRareChance (Exordium.java:130, every act 0.3F). */
export const COLORLESS_RARE_CHANCE = 0.3;

export const POTION_DROP = {
  baseChance: 40,
  pityStep: 10,
  commonBelow: 65,
  uncommonBelow: 90,
} as const;

export const GOLD_REWARDS = {
  normalMonster: { min: 10, max: 20 },
  elite: { min: 25, max: 35 },
  boss: { base: 100, jitterMin: -5, jitterMax: 5 },
  ascension13BossFactor: 0.75,
  goldenIdolFactor: 0.25,
} as const;

export const RELIC_TIER_ROLLS = {
  combatReward: { commonBelow: 50, uncommonBelow: 83 },
  elite: { commonBelow: 50, rareAbove: 82 },
} as const;

// --- shared helpers -------------------------------------------------------------

export function hasRelic(run: RunState, id: RelicId): boolean {
  return run.relics.some((r) => r.defId === id);
}

export function classColor(character: CharacterId): "red" | "green" | "blue" | "purple" {
  switch (character) {
    case "IRONCLAD":
      return "red";
    case "SILENT":
      return "green";
    case "DEFECT":
      return "blue";
    case "WATCHER":
      return "purple";
  }
}

/** Class card pool of one rarity, in bundle insertion order (the game's static
 *  per-class arrays). Uniform picks index into this with cardRng. */
export function classCardPool(ctx: EffectCtx, rarity: CardRarityRoll): CardId[] {
  const color = classColor(ctx.run.character);
  const out: CardId[] = [];
  for (const c of ctx.bundle.cards.values()) {
    if (c.color === color && c.rarity === rarity) out.push(c.id);
  }
  return out;
}

export function colorlessCardPool(ctx: EffectCtx, rarity: CardRarityRoll): CardId[] {
  const out: CardId[] = [];
  for (const c of ctx.bundle.cards.values()) {
    if (c.color === "colorless" && c.rarity === rarity) out.push(c.id);
  }
  return out;
}

export function cursePool(ctx: EffectCtx): CardId[] {
  const out: CardId[] = [];
  for (const c of ctx.bundle.cards.values()) {
    if (c.type === "curse") out.push(c.id);
  }
  return out;
}

/** Potions obtainable by this class (shared + class pool), insertion order.
 *  PotionHelper.getPotions (PotionHelper.java:46-150) builds this list with no
 *  Sozu check: Sozu only refuses the potion at the moment it would be obtained. */
export function potionPool(ctx: EffectCtx): PotionId[] {
  const color = classColor(ctx.run.character);
  const out: PotionId[] = [];
  for (const p of ctx.bundle.potions.values()) {
    if (p.class === "shared" || p.class === color) out.push(p.id);
  }
  return out;
}

export function canObtainPotions(run: RunState): boolean {
  return !hasRelic(run, "SOZU");
}

// --- relic pools ----------------------------------------------------------------
//
// AbstractDungeon.returnRandomRelicKey / returnEndRandomRelicKey, exactly:
//  - the front of the run-start shuffled tier pool (shops draw from the END);
//  - an empty pool falls through common -> uncommon -> rare -> CIRCLET,
//    shop -> uncommon, boss -> RED_CIRCLET (the end-draw falls back to the
//    FRONT of the next tier, like the game);
//  - a relic whose canSpawn() refuses right now (floor limits, Ectoplasm past
//    act 1, Black Blood without Burning Blood, bottles without a card to
//    bottle, shop-only refusals...) is thrown away and the draw repeats from
//    the END of the same tier (the boss end-draw still takes the front).

const TIER_POOL_KEY: Record<RelicPoolTier, keyof RunState["pools"]> = {
  common: "commonRelics",
  uncommon: "uncommonRelics",
  rare: "rareRelics",
  shop: "shopRelics",
  boss: "bossRelics",
};

function tierPool(run: RunState, tier: RelicPoolTier): RelicId[] {
  return run.pools[TIER_POOL_KEY[tier]] as RelicId[];
}

function relicCanSpawn(ctx: EffectCtx, id: RelicId, inShop: boolean): boolean {
  const def = ctx.bundle.relics.get(id);
  return def?.canSpawn ? def.canSpawn(ctx, inShop) : true;
}

/** Empty-pool fallback shared by both ends (the next tier is always drawn from the front). */
function emptyPoolFallback(ctx: EffectCtx, tier: RelicPoolTier, inShop: boolean): RelicId {
  if (tier === "common" || tier === "shop") return returnRandomRelicKey(ctx, "uncommon", inShop);
  if (tier === "uncommon") return returnRandomRelicKey(ctx, "rare", inShop);
  return tier === "rare" ? "CIRCLET" : "RED_CIRCLET";
}

function returnRandomRelicKey(ctx: EffectCtx, tier: RelicPoolTier, inShop: boolean): RelicId {
  const pool = tierPool(ctx.run, tier);
  const id = pool.length === 0 ? emptyPoolFallback(ctx, tier, inShop) : pool.shift()!;
  return relicCanSpawn(ctx, id, inShop) ? id : returnEndRandomRelicKey(ctx, tier, inShop);
}

function returnEndRandomRelicKey(ctx: EffectCtx, tier: RelicPoolTier, inShop: boolean): RelicId {
  const pool = tierPool(ctx.run, tier);
  const id = pool.length === 0 ? emptyPoolFallback(ctx, tier, inShop) : tier === "boss" ? pool.shift()! : pool.pop()!;
  return relicCanSpawn(ctx, id, inShop) ? id : returnEndRandomRelicKey(ctx, tier, inShop);
}

/** AbstractDungeon.returnRandomRelic: consume a relic from the front of the
 *  pool (elites, chests, bosses, Neow, events, Matryoshka). `inShop` is only
 *  for canSpawn's getCurrRoom() instanceof ShopRoom. */
export function obtainRelicFromPool(ctx: EffectCtx, tier: RelicPoolTier, inShop = false): RelicId {
  return returnRandomRelicKey(ctx, tier, inShop);
}

/** AbstractDungeon.returnRandomRelicEnd: the merchant's draw from the END. */
export function obtainRelicFromPoolEnd(ctx: EffectCtx, tier: RelicPoolTier, inShop = false): RelicId {
  return returnEndRandomRelicKey(ctx, tier, inShop);
}

/** returnRandomNonCampfireRelic (Black Star): Peace Pipe, Shovel and Girya
 *  are drawn and thrown away. */
export function obtainNonCampfireRelic(ctx: EffectCtx, tier: RelicPoolTier): RelicId {
  let id = obtainRelicFromPool(ctx, tier);
  while (id === "PEACE_PIPE" || id === "SHOVEL" || id === "GIRYA") id = obtainRelicFromPool(ctx, tier);
  return id;
}

/** What obtainRelicFromPool would hand over, WITHOUT consuming anything: the
 *  same draw run against copies of the pools (canSpawn reads no rng). */
export function peekRelicFromPool(ctx: EffectCtx, tier: RelicPoolTier, inShop = false): RelicId {
  const tiers = Object.keys(TIER_POOL_KEY) as RelicPoolTier[];
  const saved = tiers.map((t) => [...tierPool(ctx.run, t)]);
  try {
    return obtainRelicFromPool(ctx, tier, inShop);
  } finally {
    tiers.forEach((t, i) => tierPool(ctx.run, t).splice(0, Infinity, ...saved[i]!));
  }
}

// --- card rewards ----------------------------------------------------------------

export type RewardRoomKind = "monster" | "elite" | "boss" | "event" | "rest";

/** rollRarity (AbstractDungeon.java:2206-2214): "int roll = cardRng.random(99);
 *  roll += cardBlizzRandomizer;" is ALWAYS consumed, then the room decides:
 *  MonsterRoomBoss.getCardRarity returns RARE whatever the roll
 *  (MonsterRoomBoss.java:41-44); elite 10/40 (MonsterRoomElite.java:44-45),
 *  every other room 3/37 (AbstractRoom.java:164-165). N'loth's Gift triples the
 *  rare chance except where getCardRarity(roll, false) skips the relic hooks
 *  (RestRoom.java:48-51, ShopRoom.java:58-61). */
export function rollCardRarity(ctx: EffectCtx, room: RewardRoomKind): CardRarityRoll {
  const roll = ctx.rng("cardRng").random(99) + ctx.run.blizzard.cardRarityFactor;
  if (room === "boss") return "rare";
  let rareChance = room === "elite" ? CARD_REWARD.rareChance.elite : CARD_REWARD.rareChance.nonElite;
  const uncommonChance = room === "elite" ? CARD_REWARD.uncommonChance.elite : CARD_REWARD.uncommonChance.nonElite;
  if (room !== "rest" && hasRelic(ctx.run, "NLOTHS_GIFT")) rareChance *= 3;
  if (roll < rareChance) return "rare";
  if (roll < rareChance + uncommonChance) return "uncommon";
  return "common";
}

export function upgradeChance(act: number, ascension: number): number {
  if (act <= 1) return UPGRADE_CHANCES.act1;
  if (act === 2) return ascension >= 12 ? UPGRADE_CHANCES.act2.ascension12Plus : UPGRADE_CHANCES.act2.base;
  return ascension >= 12 ? UPGRADE_CHANCES.act3AndBeyond.ascension12Plus : UPGRADE_CHANCES.act3AndBeyond.base;
}

export interface RolledCard {
  id: CardId;
  rarity: CardRarityRoll;
  upgraded: boolean;
}

/** Reward size: 3 cards, then each relic's changeNumberOfCardsInReward
 *  (QuestionCard.java +1, BustedCrown.java -2). */
export function cardRewardSize(run: RunState): number {
  let numCards: number = CARD_REWARD.baseCount;
  if (hasRelic(run, "QUESTION_CARD")) numCards += CARD_REWARD.questionCardModifier;
  if (hasRelic(run, "BUSTED_CROWN")) numCards += CARD_REWARD.bustedCrownModifier;
  return Math.max(1, numCards);
}

/** getRewardCards (AbstractDungeon.java:1981-2064): per card, rarity roll ->
 *  pity update (common: factor-1 floored at -40; rare: reset to 5) -> uniform
 *  class-pool pick with dupe reroll (id only, not rarity). Only after EVERY card
 *  is picked does the upgrade pass run: "c.rarity != RARE &&
 *  cardRng.randomBoolean(cardUpgradedChance) && c.canUpgrade()" - one cardRng
 *  roll per non-rare card, consumed even in Act 1 where the chance is 0. */
export function createCardReward(ctx: EffectCtx, room: RewardRoomKind): RolledCard[] {
  const run = ctx.run;
  const cardRng = ctx.rng("cardRng");
  const numCards = cardRewardSize(run);
  // TODO PRISMATIC_SHARD: any-color pool draws (burns an extra cardRng.randomLong per card)

  const picks: { id: CardId; rarity: CardRarityRoll }[] = [];
  for (let i = 0; i < numCards; i++) {
    const rarity = rollCardRarity(ctx, room);
    if (rarity === "rare") run.blizzard.cardRarityFactor = CARD_REWARD.pityInitial;
    else if (rarity === "common") {
      run.blizzard.cardRarityFactor = Math.max(run.blizzard.cardRarityFactor - 1, CARD_REWARD.pityFloor);
    }
    const pool = classCardPool(ctx, rarity);
    if (pool.length === 0) throw new Error(`empty ${rarity} card pool for ${run.character}`);
    let id: CardId;
    let guard = 0;
    do {
      id = pool[cardRng.random(pool.length - 1)]!;
    } while (picks.some((c) => c.id === id) && ++guard < 1000);
    picks.push({ id, rarity });
  }
  const chance = upgradeChance(run.act, run.ascension);
  return picks.map((p) => ({ ...p, upgraded: p.rarity !== "rare" && cardRng.randomBoolean(chance) }));
}

// --- potions ---------------------------------------------------------------------

export interface RandomPotionOptions {
  /** returnRandomPotion(true): the spam check never returns Fruit Juice. */
  limited?: boolean;
}

/** returnRandomPotion (AbstractDungeon.java:1186-1211): rarity d100 (<65
 *  common, <90 uncommon, else rare), then uniform pool draws until the rarity
 *  matches. With `limited`, the spam check starts set, so the first draw is
 *  always redrawn and Fruit Juice never clears it. There is no Sozu check here:
 *  Sozu refuses the potion only where it would be obtained (RewardItem.java
 *  claim, StorePotion.purchasePotion, ObtainPotionAction). */
export function returnRandomPotion(ctx: EffectCtx, options: RandomPotionOptions = {}): PotionId | null {
  const potionRng = ctx.rng("potionRng");
  const roll = potionRng.randomRange(0, 99);
  const rarity: CardRarityRoll =
    roll < POTION_DROP.commonBelow ? "common" : roll < POTION_DROP.uncommonBelow ? "uncommon" : "rare";
  const pool = potionPool(ctx);
  const limited = options.limited === true;
  const matches = (id: PotionId) => ctx.bundle.potions.get(id)!.rarity === rarity;
  if (!pool.some((id) => matches(id) && (!limited || id !== "FRUIT_JUICE"))) return null; // stub-bundle guard
  const draw = () => pool[potionRng.random(pool.length - 1)]!;
  let id = draw();
  let spamCheck = limited;
  while (!matches(id) || spamCheck) {
    spamCheck = limited;
    id = draw();
    if (id !== "FRUIT_JUICE") spamCheck = false;
  }
  return id;
}

/** ObtainPotionAction(returnRandomPotion(...)): the potion is rolled first;
 *  Sozu then refuses it, and a full belt loses it. */
export function obtainRandomPotion(ctx: EffectCtx, options: RandomPotionOptions = {}): PotionId | null {
  const id = returnRandomPotion(ctx, options);
  if (!id || !canObtainPotions(ctx.run)) return null;
  const slot = ctx.run.potions.indexOf(null);
  if (slot === -1) return null;
  ctx.run.potions[slot] = id;
  ctx.emit("potionObtained", { id, slot });
  return id;
}

/** addPotionToRewards (AbstractRoom.java:780-815): chance 40 + potionChance
 *  (White Beast Statue: 100; "rewards.size() >= 4": 0); the d100 roll is always
 *  consumed and pity moves +/-10 on miss/drop. Sozu does not stop any of it: the
 *  potion lands on the screen and Sozu refuses it when claimed. `forceZero` is
 *  the MonsterRoom branch when every monster escaped (chance stays 0). */
export function rollPotionReward(ctx: EffectCtx, rewardsSoFar: number, forceZero = false): PotionId | null {
  const run = ctx.run;
  let chance = forceZero ? 0 : POTION_DROP.baseChance + run.blizzard.potionChance;
  if (hasRelic(run, "WHITE_BEAST_STATUE")) chance = 100;
  if (rewardsSoFar >= 4) chance = 0;
  if (ctx.rng("potionRng").random(99) >= chance) {
    run.blizzard.potionChance += POTION_DROP.pityStep;
    return null;
  }
  run.blizzard.potionChance -= POTION_DROP.pityStep;
  return returnRandomPotion(ctx);
}

// --- gold ------------------------------------------------------------------------

export function rollGoldReward(ctx: EffectCtx, room: "monster" | "elite" | "boss"): number {
  const run = ctx.run;
  let gold: number;
  if (room === "monster") {
    gold = ctx.rng("treasureRng").randomRange(GOLD_REWARDS.normalMonster.min, GOLD_REWARDS.normalMonster.max);
  } else if (room === "elite") {
    gold = ctx.rng("treasureRng").randomRange(GOLD_REWARDS.elite.min, GOLD_REWARDS.elite.max);
  } else {
    gold = GOLD_REWARDS.boss.base + ctx.rng("miscRng").randomRange(GOLD_REWARDS.boss.jitterMin, GOLD_REWARDS.boss.jitterMax);
    // A13 "Poor bosses" applies BEFORE the Golden Idol bonus
    if (run.ascension >= 13) gold = Math.round(gold * GOLD_REWARDS.ascension13BossFactor);
  }
  return withGoldenIdolBonus(run, gold);
}

/** RewardItem.applyGoldBonus: every non-stolen gold reward outside a treasure
 *  room gets Golden Idol's MathUtils.round(gold * 0.25f) on top (combat, boss,
 *  event and Tiny House gold alike). */
export function withGoldenIdolBonus(run: RunState, gold: number): number {
  return hasRelic(run, "GOLDEN_IDOL") ? gold + Math.round(gold * GOLD_REWARDS.goldenIdolFactor) : gold;
}

// --- relic tier rolls -------------------------------------------------------------

/** returnRandomRelicTierElite (Game.cpp:283-292): <50 common, >82 rare, else uncommon. */
export function eliteRelicTier(ctx: EffectCtx): RelicPoolTier {
  const roll = ctx.rng("relicRng").random(99);
  if (roll < RELIC_TIER_ROLLS.elite.commonBelow) return "common";
  if (roll > RELIC_TIER_ROLLS.elite.rareAbove) return "rare";
  return "uncommon";
}

/** returnRandomRelicTier (Game.cpp:268-281): combat-reward tier roll. */
export function combatRelicTier(ctx: EffectCtx): RelicPoolTier {
  const roll = ctx.rng("relicRng").randomRange(0, 99);
  if (roll < RELIC_TIER_ROLLS.combatReward.commonBelow) return "common";
  if (roll < RELIC_TIER_ROLLS.combatReward.uncommonBelow) return "uncommon";
  return "rare";
}

// --- reward screen assembly --------------------------------------------------------

/** Next unused group id within this rewards screen (kept deterministic -
 *  group ids are per-screen, never process-global). */
export function nextRewardGroup(entries: RewardEntry[]): number {
  let g = 0;
  for (const e of entries) {
    if ((e.kind === "card" || e.kind === "bossRelic") && e.group >= g) g = e.group + 1;
  }
  return g;
}

function pushCardGroup(entries: RewardEntry[], cards: RolledCard[]): void {
  const group = nextRewardGroup(entries);
  for (const c of cards) {
    entries.push({ kind: "card", group, id: c.id, rarity: c.rarity, upgraded: c.upgraded, taken: false });
  }
}

/** AbstractRoom.java:803 "rewards.size() >= 4": every RewardItem already in the
 *  room's list counts (stolen gold, gold, relics, the emerald key); card rewards
 *  are only added later by setupItemReward. */
function rewardsSize(entries: RewardEntry[]): number {
  const groups = new Set<number>();
  let n = 0;
  for (const e of entries) {
    if (e.kind === "card" || e.kind === "bossRelic") groups.add(e.group);
    else n++;
  }
  return n + groups.size;
}

function refundedStolenGold(ctx: EffectCtx): number {
  let total = 0;
  for (const m of ctx.combat?.monsters ?? []) {
    if (m.isEscaped) continue;
    const stolenGold = m.data.stolenGold;
    if (typeof stolenGold === "number" && Number.isFinite(stolenGold) && stolenGold > 0) total += stolenGold;
  }
  return total;
}

/** MonsterGroup.haveMonstersEscaped (MonsterGroup.java:171-181): true only
 *  when EVERY monster in the group escaped (the dead do not count as fled). */
function everyMonsterEscaped(ctx: EffectCtx): boolean {
  const monsters = ctx.combat?.monsters ?? [];
  return monsters.length > 0 && monsters.every((m) => m.isEscaped);
}

export interface CombatRewardOptions {
  /** Smoke Bomb: AbstractRoom.update still adds the gold, dropReward() and
   *  addPotionToRewards() (AbstractRoom.java:413-471), but openCombat(TEXT[1],
   *  true) never calls setupItemReward, so no card reward is rolled. */
  smoked?: boolean;
}

/** Build the post-combat rewards screen in the room's own order
 *  (AbstractRoom.java:413-471): stolen gold (added when the thief died), the
 *  end-of-battle gold, dropReward() (elite relic, Black Star relic, emerald
 *  key), addPotionToRewards(), then the card reward(s) from setupItemReward
 *  (CombatRewardScreen.java:73-99). A MonsterRoom whose every monster escaped
 *  pays no gold and its potion chance is 0 (the roll is still consumed). Boss
 *  rooms only add potion/card while act < 3; boss relic choices are appended by
 *  the run flow (boss treasure room), not here. */
export function buildCombatRewards(
  ctx: EffectCtx,
  room: "monster" | "elite" | "boss",
  burningElite: boolean,
  opts: CombatRewardOptions = {},
): RewardEntry[] {
  const run = ctx.run;
  const entries: RewardEntry[] = [];

  const stolenGold = refundedStolenGold(ctx);
  if (stolenGold > 0) entries.push({ kind: "gold", amount: stolenGold, taken: false });
  const allEscaped = room === "monster" && everyMonsterEscaped(ctx);
  if (!allEscaped) entries.push({ kind: "gold", amount: rollGoldReward(ctx, room), taken: false });

  if (room === "elite") {
    entries.push({ kind: "relic", id: obtainRelicFromPool(ctx, eliteRelicTier(ctx)), taken: false });
    // MonsterRoomElite.dropReward: Black Star adds a second, non-campfire
    // relic off a fresh elite tier roll, before the emerald key
    if (hasRelic(run, "BLACK_STAR")) {
      entries.push({ kind: "relic", id: obtainNonCampfireRelic(ctx, eliteRelicTier(ctx)), taken: false });
    }
    if (burningElite && !run.keys.emerald) entries.push({ kind: "emeraldKey", taken: false });
  }

  const wantsPotionAndCard = room !== "boss" || run.act < 3;
  if (wantsPotionAndCard) {
    const potion = rollPotionReward(ctx, rewardsSize(entries), allEscaped);
    if (potion) entries.push({ kind: "potion", id: potion, taken: false });
    if (!opts.smoked) {
      pushCardGroup(entries, createCardReward(ctx, room));
      if (room === "monster" && hasRelic(run, "PRAYER_WHEEL")) {
        pushCardGroup(entries, createCardReward(ctx, room));
      }
    }
  }

  return entries;
}

/** Wrap a pre-rolled card list as a rewards screen card group (Neow, events). */
export function cardGroupEntries(cards: RolledCard[]): RewardEntry[] {
  const entries: RewardEntry[] = [];
  pushCardGroup(entries, cards);
  return entries;
}
