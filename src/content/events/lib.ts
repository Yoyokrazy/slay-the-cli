// Shared helpers for the events workstream. Run-layer effects mirror the
// engine's own call sites exactly:
//  - HP loss folds onLoseHp (Tungsten Rod) like the interpreter's player path;
//    combat-only triggers (wasHPLost, bloodied hooks) do NOT fire out of combat
//    (they enqueue combat actions that could never drain).
//  - heals fold onHeal (Mark of the Bloom zeroes them), floor, clamp.
//  - card obtains veto through canObtainCard (Omamori, before any onObtainCard
//    fires) and fold egg upgrades, matching runFlow's addCardToDeck; gold gains
//    fold onGainGold (Ectoplasm, Bloody Idol), matching runFlow's gainGold.
//  - "screenless" random relics roll tier with relicRng (50/33/17) and pop the
//    run-start shuffled pool, rerolling BOTTLED_* / WHETSTONE (corpus
//    events.json meta note); popped rerolls are consumed, like the reference.
//  - out-of-run-layer death: at hp<=0 a Fairy in a Bottle, else an unused
//    Lizard Tail, saves the player (AbstractPlayer.damage runs in events too;
//    Mark of the Bloom blocks both); otherwise rt.combatOver="defeat", which
//    game.ts finish() turns into outcome=death + gameOver room.

import type { EffectCtx, EventDef, EventOption, MasterDeckRemovalReason } from "../../engine/content/defs";
import type { RewardEntry, EventRoomData, MasterCard, RoomState } from "../../engine/run/runState";
import type { CardId, PotionId, RelicId } from "../../engine/core/ids";
import { PLAYER } from "../../engine/core/ids";
import { foldHook } from "../../engine/core/hooks";
import { f32mul } from "../../engine/core/math";
import { JavaRandom, javaShuffle } from "../../engine/core/rng";
import { obtainDeckCard, removeDeckCards as removeMasterDeckCards, transformDeckCard as transformMasterDeckCard } from "../../engine/run/deck";
import {
  canObtainPotions,
  cardGroupEntries,
  cardRewardSize,
  colorlessCardPool,
  combatRelicTier,
  createCardReward,
  hasRelic,
  nextRewardGroup,
  obtainRelicFromPool,
  potionPool,
  rollPotionReward,
  withGoldenIdolBonus,
  CARD_REWARD,
  COLORLESS_RARE_CHANCE,
  type RolledCard,
} from "../../engine/run/rewards";
import { canSmith } from "../../engine/run/rest";

export { hasRelic };

// --- room / screen state -----------------------------------------------------------

export function eventRoom(ctx: EffectCtx): Extract<RoomState, { kind: "event" }> {
  const room = ctx.run.room;
  if (room?.kind !== "event") throw new Error("not in an event room");
  return room;
}

export function screenOf(ctx: EffectCtx): string | undefined {
  return eventRoom(ctx).screen;
}

export function dataOf(ctx: EffectCtx): EventRoomData {
  const room = eventRoom(ctx);
  if (!room.data) room.data = {};
  return room.data;
}

/** Read-only data view for build() (which must not mutate state). */
export function peekData(ctx: EffectCtx): EventRoomData {
  return eventRoom(ctx).data ?? {};
}

export function setScreen(ctx: EffectCtx, screen: string): void {
  eventRoom(ctx).screen = screen;
}

export function endEvent(ctx: EffectCtx): void {
  ctx.run.room = { kind: "map" };
}

export const a15 = (ctx: EffectCtx): boolean => ctx.asc >= 15;

// --- HP / gold ----------------------------------------------------------------------

export type Rounding = "floor" | "round" | "ceil";

/** lightspeed fractionMaxHp: float32 multiply, then the given rounding mode. */
export function fractionMaxHp(ctx: EffectCtx, fraction: number, rounding: Rounding = "floor"): number {
  const x = f32mul(ctx.run.maxHp, fraction);
  return rounding === "floor" ? Math.floor(x) : rounding === "round" ? Math.round(x) : Math.ceil(x);
}

function afterHpLoss(ctx: EffectCtx): void {
  if (ctx.run.hp <= 0) {
    ctx.run.hp = 0;
    if (eventDeathSave(ctx)) return;
    ctx.rt.combatOver = "defeat"; // finish() -> outcome death + gameOver room
  }
}

/** AbstractPlayer.damage at 0 HP, in or out of combat: unless Mark of the
 *  Bloom is owned, a Fairy in a Bottle heals (int)(maxHealth * potency%), min 1
 *  (FairyPotion.use), else an unused Lizard Tail heals maxHealth / 2, min 1
 *  (LizardTail.onTrigger). */
function eventDeathSave(ctx: EffectCtx): boolean {
  const run = ctx.run;
  if (hasRelic(run, "MARK_OF_THE_BLOOM")) return false;
  const slot = run.potions.indexOf("FAIRY_POTION");
  if (slot !== -1) {
    const def = ctx.bundle.potions.get("FAIRY_POTION");
    const bark = def?.sacredBarkDoubles === true && hasRelic(run, "SACRED_BARK");
    const potency = (def?.potency ?? 30) * (bark ? 2 : 1);
    run.potions[slot] = null;
    healHp(ctx, Math.max(1, fractionMaxHp(ctx, potency / 100, "floor")));
    return true;
  }
  const tail = run.relics.find((r) => r.defId === "LIZARD_TAIL");
  if (tail && tail.counter === 0) {
    tail.counter = 1; // used up
    healHp(ctx, Math.max(1, Math.floor(run.maxHp / 2)));
    return true;
  }
  return false;
}

/** Event damage (lightspeed damagePlayer) - folds onLoseHp (Tungsten Rod). */
export function damagePlayer(ctx: EffectCtx, amount: number): void {
  const d = foldHook(ctx, PLAYER, "onLoseHp", amount);
  if (d > 0) ctx.run.hp = Math.max(0, ctx.run.hp - d);
  afterHpLoss(ctx);
}

/** Direct HP loss (lightspeed playerLoseHp) - same out-of-combat semantics. */
export function loseHp(ctx: EffectCtx, amount: number): void {
  damagePlayer(ctx, amount);
}

/** Heal folded through onHeal (Mark of the Bloom), floored and clamped. */
export function healHp(ctx: EffectCtx, amount: number): void {
  const healed = Math.floor(foldHook(ctx, PLAYER, "onHeal", amount));
  if (healed > 0) ctx.run.hp = Math.min(ctx.run.maxHp, ctx.run.hp + healed);
}

export function healToFull(ctx: EffectCtx): void {
  healHp(ctx, ctx.run.maxHp);
}

/** increaseMaxHp: raises the cap AND heals the same amount (game-exact). */
export function gainMaxHp(ctx: EffectCtx, amount: number): void {
  ctx.run.maxHp += amount;
  healHp(ctx, amount);
}

/** decreaseMaxHp: cap floored at 1; current hp clamped to the new cap. */
export function loseMaxHp(ctx: EffectCtx, amount: number): void {
  ctx.run.maxHp = Math.max(1, ctx.run.maxHp - amount);
  ctx.run.hp = Math.min(ctx.run.hp, ctx.run.maxHp);
}

export function gainGold(ctx: EffectCtx, amount: number): void {
  ctx.run.gold += Math.max(0, Math.floor(foldHook(ctx, PLAYER, "onGainGold", amount)));
}

export function loseGold(ctx: EffectCtx, amount: number): void {
  ctx.run.gold = Math.max(0, ctx.run.gold - amount);
}

// --- cards ---------------------------------------------------------------------------

/** Unremovable specials (run-layer rule; card defs carry no flag). */
export const UNREMOVABLE_CURSES: readonly CardId[] = ["ASCENDERS_BANE", "NECRONOMICURSE", "CURSE_OF_THE_BELL"];

export function obtainCard(ctx: EffectCtx, defId: CardId, upgrades = 0, misc = 0): void {
  obtainDeckCard(ctx, defId, upgrades, misc);
}

/** Curse card ids (corpus-stable) - canSpawn(run) has no bundle access. */
export const CURSE_IDS: ReadonlySet<CardId> = new Set([
  "ASCENDERS_BANE",
  "CLUMSY",
  "CURSE_OF_THE_BELL",
  "DECAY",
  "DOUBT",
  "INJURY",
  "NECRONOMICURSE",
  "NORMALITY",
  "PAIN",
  "PARASITE",
  "PRIDE",
  "REGRET",
  "SHAME",
  "WRITHE",
]);

/** Remove deck cards by index (descending order, duplicates ignored). */
export function removeDeckCards(ctx: EffectCtx, indices: number[], reason: MasterDeckRemovalReason = "event:remove"): void {
  removeMasterDeckCards(ctx, indices, reason);
}

/** Transform: remove, then roll the replacement with miscRng from the pool
 *  matching the removed card's color, excluding the card itself (deck.ts
 *  transformPool) - identical to runFlow's runDeckChoiceResume. */
export function transformDeckCard(ctx: EffectCtx, deckIdx: number, reason: MasterDeckRemovalReason = "event:transform"): void {
  transformMasterDeckCard(ctx, deckIdx, 0, reason);
}

export function upgradeDeckCard(ctx: EffectCtx, deckIdx: number): void {
  const mc = ctx.run.deck[deckIdx];
  if (mc) mc.upgrades++;
}

export function upgradeableIndices(ctx: EffectCtx): number[] {
  return ctx.run.deck.map((_, i) => i).filter((i) => canSmith(ctx, i));
}

/** The upgradable deck cards in deck order, Collections.shuffle'd with a
 *  java.util.Random seeded by miscRng.randomLong() - the game's "upgrade N
 *  random cards" (Shining Light, Designer). The long is drawn even when
 *  nothing is upgradable. */
export function shuffledUpgradeableIndices(ctx: EffectCtx): number[] {
  const idxs = upgradeableIndices(ctx);
  javaShuffle(idxs, new JavaRandom(ctx.rng("miscRng").randomLong()));
  return idxs;
}

/** Cards a removal/transform screen may target: non-bottled, not an
 *  unremovable special curse. */
export function removableIndices(ctx: EffectCtx): number[] {
  return ctx.run.deck
    .map((_, i) => i)
    .filter((i) => {
      const mc = ctx.run.deck[i]!;
      return !mc.bottled && !UNREMOVABLE_CURSES.includes(mc.defId);
    });
}

/** CardGroup.getPurgeableCards without the bottled filter: everything but the
 *  unremovable special curses (Augmenter's transform screen). */
export function purgeableIndices(ctx: EffectCtx): number[] {
  return ctx.run.deck.map((_, i) => i).filter((i) => !UNREMOVABLE_CURSES.includes(ctx.run.deck[i]!.defId));
}

/** Transform several picked cards one at a time in the order they were
 *  selected (gridSelectScreen.selectedCards order), like DrugDealer/Designer.
 *  Each replacement appends, so the picks are tracked by identity. */
export function transformDeckCardsInOrder(ctx: EffectCtx, indices: number[]): void {
  const picked = [...new Set(indices)].map((i) => ctx.run.deck[i]).filter((mc): mc is MasterCard => mc !== undefined);
  for (const mc of picked) {
    const idx = ctx.run.deck.indexOf(mc);
    if (idx !== -1) transformDeckCard(ctx, idx);
  }
}

export function deckIndicesOfType(ctx: EffectCtx, type: "attack" | "skill" | "power"): number[] {
  return ctx.run.deck.map((_, i) => i).filter((i) => ctx.bundle.cards.get(ctx.run.deck[i]!.defId)?.type === type);
}

export function cardName(ctx: EffectCtx, mc: MasterCard): string {
  const def = ctx.bundle.cards.get(mc.defId);
  const base = def?.name ?? mc.defId;
  return mc.upgrades > 0 ? `${base}+` : base;
}

/** Random obtainable curse (rarity "curse" - excludes the special curses),
 *  uniform with cardRng (Match and Keep). */
export function randomCurse(ctx: EffectCtx): CardId | null {
  const pool: CardId[] = [];
  for (const c of ctx.bundle.cards.values()) {
    if (c.type === "curse" && c.rarity === "curse") pool.push(c.id);
  }
  if (pool.length === 0) return null;
  return pool[ctx.rng("cardRng").random(pool.length - 1)]!;
}

/** Colorless pool java-shuffled with a shuffleRng-seeded java.Random; first
 *  card of the wanted rarity (Knowing Skull, Match and Keep). */
export function colorlessViaShuffle(ctx: EffectCtx, rarity: "uncommon" | "rare"): CardId | null {
  const pool: CardId[] = [];
  for (const c of ctx.bundle.cards.values()) if (c.color === "colorless") pool.push(c.id);
  if (pool.length === 0) return null;
  javaShuffle(pool, new JavaRandom(ctx.rng("shuffleRng").randomLong()));
  for (const id of pool) {
    if (ctx.bundle.cards.get(id)!.rarity === rarity) return id;
  }
  return null;
}

/** One colorless card reward (Sensory Stone's RewardItem(CardColor.COLORLESS)):
 *  getColorlessRewardCards (AbstractDungeon.java:1934-1978). Sized like any card
 *  reward (Question Card / Busted Crown); each card rolls
 *  rollRareOrUncommon(colorlessRareChance) = cardRng.randomBoolean(0.3), a RARE
 *  resets cardBlizzRandomizer to its start offset (commons never happen, so the
 *  pity never decrements), then a cardRng pick with dupe reroll. No upgrade roll. */
export function createColorlessCardReward(ctx: EffectCtx): RolledCard[] {
  const run = ctx.run;
  const cardRng = ctx.rng("cardRng");
  const out: RolledCard[] = [];
  const numCards = cardRewardSize(run);
  for (let i = 0; i < numCards; i++) {
    const rarity = cardRng.randomBoolean(COLORLESS_RARE_CHANCE) ? "rare" : "uncommon";
    if (rarity === "rare") run.blizzard.cardRarityFactor = CARD_REWARD.pityInitial;
    const pool = colorlessCardPool(ctx, rarity);
    if (pool.length === 0) throw new Error(`empty colorless ${rarity} pool`);
    let id: CardId;
    let guard = 0;
    do {
      id = pool[cardRng.random(pool.length - 1)]!;
    } while (out.some((c) => c.id === id) && ++guard < 1000);
    out.push({ id, rarity, upgraded: false });
  }
  return out;
}

// --- relics --------------------------------------------------------------------------

export function obtainRelic(ctx: EffectCtx, id: RelicId): void {
  ctx.run.relics.push({ defId: id, counter: 0 });
  ctx.bundle.relics.get(id)?.onEquip?.(ctx);
}

export function removeRelic(ctx: EffectCtx, id: RelicId): void {
  const idx = ctx.run.relics.findIndex((r) => r.defId === id);
  if (idx === -1) return;
  ctx.bundle.relics.get(id)?.onUnequip?.(ctx);
  ctx.run.relics.splice(idx, 1);
}

/** Screenless relics reroll the bottles + Whetstone (they need a follow-up screen). */
const SCREENLESS_REROLL: ReadonlySet<string> = new Set([
  "BOTTLED_FLAME",
  "BOTTLED_LIGHTNING",
  "BOTTLED_TORNADO",
  "WHETSTONE",
]);

/** Pop the tier pool until a non-campfire-screen relic appears (rerolled ids
 *  are consumed, matching the reference's pop-in-loop). */
export function screenlessRelicOfTier(ctx: EffectCtx, tier: "common" | "uncommon" | "rare"): RelicId {
  let id: RelicId;
  let guard = 0;
  do {
    id = obtainRelicFromPool(ctx, tier);
  } while (SCREENLESS_REROLL.has(id) && ++guard < 100);
  return id;
}

/** Screenless random relic: relicRng tier roll 50/33/17, then pool pop. */
export function screenlessRandomRelic(ctx: EffectCtx): RelicId {
  const tier = combatRelicTier(ctx);
  return screenlessRelicOfTier(ctx, tier === "boss" || tier === "shop" ? "rare" : tier);
}

/** AbstractDungeon.returnRandomRelic(returnRandomRelicTier()): the same relicRng
 *  tier roll, then a plain pool pop - bottles and Whetstone are NOT rerolled
 *  (AbstractRoom.addRelicToRewards(tier), Dead Adventurer's ambush loot). */
export function randomRelic(ctx: EffectCtx): RelicId {
  return obtainRelicFromPool(ctx, combatRelicTier(ctx));
}

// --- potions -------------------------------------------------------------------------

/** PotionHelper.getRandomPotion (PotionHelper.java:162-166): uniform over the
 *  class + shared potion list with potionRng - no rarity roll. Rolls even with
 *  Sozu (callers decide what a Sozu owner keeps). */
export function uniformRandomPotion(ctx: EffectCtx): PotionId | null {
  const pool = potionPool(ctx);
  if (pool.length === 0) return null;
  return pool[ctx.rng("potionRng").random(pool.length - 1)]!;
}

/** Reward-screen potions rolled with PotionHelper.getRandomPotion (Lab, The
 *  Woman in Blue): every roll is made; a Sozu owner's rewards vanish on claim
 *  in the game (RewardItem.claimReward), so they are not listed here. */
export function uniformPotionRewards(ctx: EffectCtx, count: number): RewardEntry[] {
  const entries: RewardEntry[] = [];
  for (let i = 0; i < count; i++) {
    const id = uniformRandomPotion(ctx);
    if (id && canObtainPotions(ctx.run)) entries.push({ kind: "potion", id, taken: false });
  }
  return entries;
}

/** Knowing Skull's potion (KnowingSkull.java:226-234): Sozu is checked before
 *  any roll; otherwise one uniform potion, lost when the belt is full
 *  (AbstractPlayer.obtainPotion). */
export function grantPotionDirect(ctx: EffectCtx): PotionId | null {
  if (!canObtainPotions(ctx.run)) return null;
  const id = uniformRandomPotion(ctx);
  if (id) {
    const slot = ctx.run.potions.indexOf(null);
    if (slot !== -1) ctx.run.potions[slot] = id;
  }
  return id;
}

// --- reward screens --------------------------------------------------------------------

export function openRewards(ctx: EffectCtx, entries: RewardEntry[]): void {
  ctx.run.room = { kind: "rewards", entries, source: "event" };
}

/** Assemble an event-combat rewards screen in the standard order
 *  (gold -> relics -> potion roll -> card group), same as buildCombatRewards.
 *  Event fights stay in the EventRoom, so:
 *  - gold is the event's addGoldToRewards total, a RewardItem(gold): Golden
 *    Idol adds round(25%) like any reward gold outside a treasure room
 *    (RewardItem.java:160-163);
 *  - the potion roll uses the EventRoom 40% + pity branch;
 *  - `cardReward` rolls the room's base 3/37 odds (AbstractRoom.java:164-165),
 *    even for elite-trigger fights (Dead Adventurer, Colosseum Nobs):
 *    eliteTrigger only feeds relics. */
export function eventCombatRewards(
  ctx: EffectCtx,
  opts: {
    gold?: number;
    relics?: RelicId[];
    potionRoll?: boolean;
    cardReward?: boolean;
    extraCardGroups?: RolledCard[][];
  },
): RewardEntry[] {
  const entries: RewardEntry[] = [];
  if (opts.gold !== undefined && opts.gold > 0) {
    entries.push({ kind: "gold", amount: withGoldenIdolBonus(ctx.run, opts.gold), taken: false });
  }
  for (const id of opts.relics ?? []) entries.push({ kind: "relic", id, taken: false });
  if (opts.potionRoll) {
    const p = rollPotionReward(ctx, entries.length);
    if (p) entries.push({ kind: "potion", id: p, taken: false });
  }
  if (opts.cardReward) {
    for (const e of cardGroupEntries(createCardReward(ctx, "event"))) entries.push(e);
  }
  for (const group of opts.extraCardGroups ?? []) {
    const g = nextRewardGroup(entries);
    for (const c of group) {
      entries.push({ kind: "card", group: g, id: c.id, rarity: c.rarity, upgraded: c.upgraded, taken: false });
    }
  }
  return entries;
}

// --- pending choices --------------------------------------------------------------------

/** Deck pick: iids carry DECK INDICES; the resume receives them back as
 *  `chosen` (same convention as runFlow's "__runDeckChoice"). */
export function requestDeckChoice(
  ctx: EffectCtx,
  opts: { tag: string; indices: number[]; min: number; max: number; reason: string; extra?: unknown },
): void {
  const eventId = eventRoom(ctx).eventId!;
  const min = Math.min(opts.min, opts.indices.length);
  const max = Math.min(opts.max, opts.indices.length);
  ctx.requestChoice({
    request: { kind: "cards", pile: "custom", iids: opts.indices, min, max, canCancel: false, reason: opts.reason },
    resume: "__eventChoice",
    resumeArgs: { eventId, tag: opts.tag, extra: opts.extra },
  });
}

/** Text-option pick (The Library's 1-of-20); chosen[0] indexes the options. */
export function requestOptionChoice(
  ctx: EffectCtx,
  opts: { tag: string; options: string[]; reason: string; extra?: unknown },
): void {
  const eventId = eventRoom(ctx).eventId!;
  ctx.requestChoice({
    request: { kind: "option", options: opts.options, reason: opts.reason },
    resume: "__eventChoice",
    resumeArgs: { eventId, tag: opts.tag, extra: opts.extra },
  });
}

// --- option builders ---------------------------------------------------------------------

type ChooseFn = EventOption["choose"];

export function option(label: string, choose: ChooseFn, enabled?: (ctx: EffectCtx) => boolean): EventOption {
  return { label, enabled: enabled ?? (() => true), choose };
}

export function leaveOption(label = "Leave: no effect"): EventOption {
  return option(label, (ctx) => endEvent(ctx));
}

/** Guard an option on monster availability: disabled + annotated while the
 *  encounter's monsters have not landed in the bundle. */
export function combatOption(
  label: string,
  monsters: string[],
  choose: ChooseFn,
  enabled?: (ctx: EffectCtx) => boolean,
): EventOption {
  return {
    label,
    enabled: (ctx) => monsters.every((m) => ctx.bundle.monsters.has(m)) && (enabled ? enabled(ctx) : true),
    choose,
  };
}

export function combatPendingLabel(ctx: EffectCtx, label: string, monsters: string[]): string {
  return monsters.every((m) => ctx.bundle.monsters.has(m)) ? label : `${label} (content pending)`;
}

/** Shared EventDef scaffolding for the common single-screen case. */
export function simpleEvent(
  def: Pick<EventDef, "id" | "name" | "pool" | "canSpawn" | "onEnter" | "onCombatVictory" | "onResume"> & {
    summary: string;
    options: (ctx: EffectCtx) => EventOption[];
  },
): EventDef {
  return {
    id: def.id,
    name: def.name,
    pool: def.pool,
    canSpawn: def.canSpawn,
    onEnter: def.onEnter,
    onCombatVictory: def.onCombatVictory,
    onResume: def.onResume,
    build: (ctx) => ({ summary: def.summary, options: def.options(ctx) }),
  };
}
