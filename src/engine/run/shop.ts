// Shop inventory + pricing per data/corpus/meta.json "shop", checked line by
// line against the decompiled game: the Merchant constructor (card picks),
// ShopScreen.init / initCards / initRelics / initPotions / applyDiscount /
// purgeCard / purchaseCard / setPrice / getNewPrice, StoreRelic.purchaseRelic
// and StorePotion.purchasePotion. Streams: card identities/rarities = cardRng
// (the Courier's class-card restock pick is MathUtils.random = mathUtilRng),
// relic tiers + ALL price jitter + sale slot = merchantRng, potions = potionRng.
//
// ASCENSION 16 (settles meta.shop.disputed on the wiki side): ShopScreen.init
// "if(AbstractDungeon.ascensionLevel >= 16) applyDiscount(1.1F, false)" - every
// item price x1.1, rounded; the removal cost is NOT touched (affectPurge false).
//
// DISCOUNTS: applyDiscount rounds after every step, in a fixed order: A16 x1.1,
// then The Courier x0.8, then Membership Card x0.5 (ShopScreen.init). Each
// discount resets the removal cost from the BASE purge cost ("actualPurgeCost =
// MathUtils.round((float)purgeCost * multiplier)"), so with both relics the
// Membership 0.5 wins at setup; Smiling Mask pins it at 50.
//
// COURIER RESTOCK: a bought slot is replaced while The Courier is owned, and
// buying The Courier restocks its own slot (StoreRelic.java:114). Restocks skip
// A16: cards use setPrice, "(int)(base * jitter [* 1.2] [* 0.8] [* 0.5])" in
// float; relics and potions use getNewPrice, round(base * jitter) then
// round(* 0.8), round(* 0.5).

import type { EffectCtx } from "../content/defs";
import type { HookCtx } from "../core/hooks";
import type { ShopState, ShopCardSlot, ShopRelicSlot, ShopPotionSlot, CardRarityRoll, RelicPoolTier } from "./runState";
import type { CardId, PotionId, RelicId } from "../core/ids";
import { PLAYER } from "../core/ids";
import { f32mul } from "../core/math";
import { classCardPool, colorlessCardPool, hasRelic, obtainRelicFromPoolEnd, returnRandomPotion } from "./rewards";

// --- constants (audited against meta.json) -----------------------------------------

export const SHOP = {
  cardRarityRoll: { rareBelow: 9, commonAtOrAbove: 46 }, // BASE_RARE 9, BASE_UNCOMMON 37
  basePrices: {
    cardByRarity: { common: 50, uncommon: 75, rare: 150 },
    relicByTier: { common: 150, uncommon: 250, rare: 300, boss: 999, shop: 150, starter: 300, special: 400 },
    potionByRarity: { common: 50, uncommon: 75, rare: 100 },
  },
  colorlessFactor: 1.2,
  cardJitter: { min: 0.9, max: 1.1 },
  otherJitter: { min: 0.95, max: 1.05 },
  saleSlots: 5, // saleIdx = merchantRng.random(4)
  removal: { basePrice: 75, increasePerPurchase: 25, smilingMask: 50 },
  relicTierRoll: { commonBelow: 48, uncommonBelow: 82 },
  ascension16Factor: 1.1, // ShopScreen.init applyDiscount(1.1F, false) - items only, never the purge
  colorlessRareChance: 0.3,
} as const;

/** rollRarity in a ShopRoom: getCardRarity(roll, false) with base 9/37
 *  (ShopRoom.java:41-42) - reads cardRarityFactor but does NOT update it. */
export function rollCardRarityShop(ctx: EffectCtx): CardRarityRoll {
  const roll = ctx.rng("cardRng").random(99) + ctx.run.blizzard.cardRarityFactor;
  if (roll < SHOP.cardRarityRoll.rareBelow) return "rare";
  if (roll >= SHOP.cardRarityRoll.commonAtOrAbove) return "common";
  return "uncommon";
}

/** ShopScreen.rollRelicTier (merchantRng): <48 common, <82 uncommon, else rare. */
export function rollShopRelicTier(ctx: EffectCtx): RelicPoolTier {
  const roll = ctx.rng("merchantRng").random(99);
  if (roll < SHOP.relicTierRoll.commonBelow) return "common";
  if (roll < SHOP.relicTierRoll.uncommonBelow) return "uncommon";
  return "rare";
}

type ShopCardType = "attack" | "skill" | "power";

/** One class-card slot: getCardFromPool(rollRarity(), type, useRng)
 *  (AbstractDungeon.java:2126-2176): an empty COMMON power pool falls through
 *  to UNCOMMON before any pick. The pick is cardRng for the Merchant's own
 *  stock (useRng true) and MathUtils.random (mathUtilRng) for a Courier
 *  restock (purchaseCard passes useRng false). */
function rollShopClassCard(ctx: EffectCtx, type: ShopCardType, pickRng: "cardRng" | "mathUtilRng" = "cardRng"): { id: CardId; rarity: CardRarityRoll } {
  let rarity = rollCardRarityShop(ctx);
  if (type === "power" && rarity === "common") rarity = "uncommon";
  const pool = classCardPool(ctx, rarity).filter((id) => ctx.bundle.cards.get(id)!.type === type);
  if (pool.length === 0) throw new Error(`empty shop pool: ${type}/${rarity} for ${ctx.run.character}`);
  return { id: pool[ctx.rng(pickRng).random(pool.length - 1)]!, rarity };
}

function rollColorlessCard(ctx: EffectCtx, rarity: CardRarityRoll): CardId {
  const pool = colorlessCardPool(ctx, rarity);
  if (pool.length === 0) throw new Error(`empty colorless ${rarity} pool`);
  return pool[ctx.rng("cardRng").random(pool.length - 1)]!;
}

/** The owned relics' price hooks in ShopScreen's hard-coded order (The Courier,
 *  then Membership Card), any other content hook after them in relic order.
 *  Every price hook is a flat multiplier (Courier 0.8, Membership Card 0.5),
 *  applied the way the game does it: "(float)price * multiplier" in float. */
function priceModifiers(ctx: EffectCtx): ((price: number) => number)[] {
  const owned = ctx.run.relics.map((r) => r.defId);
  const javaOrder = ["THE_COURIER", "MEMBERSHIP_CARD"].filter((id) => owned.includes(id));
  const ordered = [...javaOrder, ...owned.filter((id) => !javaOrder.includes(id))];
  const hookCtx: HookCtx = { ...ctx, owner: PLAYER, relicCounter: { get: () => 0, set: () => {} } };
  const out: ((price: number) => number)[] = [];
  for (const id of ordered) {
    const hook = ctx.bundle.relics.get(id)?.hooks.modifyPrice;
    if (hook) {
      const factor = hook(hookCtx, 1);
      out.push((price) => f32mul(price, factor));
    }
  }
  return out;
}

/** purgeCost: 75 + 25 per removal bought this run (ShopScreen.purgeCard). */
function basePurgeCost(ctx: EffectCtx): number {
  return SHOP.removal.basePrice + SHOP.removal.increasePerPurchase * ctx.run.history.cardRemovesPurchased;
}

/** Removal cost at setup (ShopScreen.init): each owned discount sets
 *  round(purgeCost * factor) from the BASE cost, A16 never applies, and Smiling
 *  Mask pins it at 50. */
export function computeRemovalCost(ctx: EffectCtx): number {
  if (hasRelic(ctx.run, "SMILING_MASK")) return SHOP.removal.smilingMask;
  const base = basePurgeCost(ctx);
  let cost = base;
  for (const modify of priceModifiers(ctx)) cost = Math.round(modify(base));
  return cost;
}

/** ShopScreen.init's applyDiscount chain for a setup price: A16 x1.1, then each
 *  owned discount, rounding after every step. */
function finalizePrice(ctx: EffectCtx, price: number): number {
  let p = ctx.run.ascension >= 16 ? Math.round(f32mul(price, SHOP.ascension16Factor)) : price;
  for (const modify of priceModifiers(ctx)) p = Math.round(modify(p));
  return p;
}

/** getNewPrice (ShopScreen.java:518-540): a restocked relic/potion price is the
 *  jittered base, then each owned discount rounded in turn - no A16. */
function restockPrice(ctx: EffectCtx, jittered: number): number {
  let p = jittered;
  for (const modify of priceModifiers(ctx)) p = Math.round(modify(p));
  return p;
}

function baseShopCardPrice(ctx: EffectCtx, rarity: CardRarityRoll, colorless: boolean): number {
  const merchantRng = ctx.rng("merchantRng");
  let price = f32mul(SHOP.basePrices.cardByRarity[rarity], merchantRng.randomFloatRange(SHOP.cardJitter.min, SHOP.cardJitter.max));
  if (colorless) price = f32mul(price, SHOP.colorlessFactor);
  return Math.trunc(price);
}

/** setPrice (ShopScreen.java:837-847), the Courier card restock price: the
 *  float chain base * jitter [* 1.2] [* 0.8 Courier] [* 0.5 Membership Card],
 *  truncated once, with no A16 and no sale. */
function restockCardPrice(ctx: EffectCtx, rarity: CardRarityRoll, colorless: boolean): number {
  let price = f32mul(SHOP.basePrices.cardByRarity[rarity], ctx.rng("merchantRng").randomFloatRange(SHOP.cardJitter.min, SHOP.cardJitter.max));
  if (colorless) price = f32mul(price, SHOP.colorlessFactor);
  for (const modify of priceModifiers(ctx)) price = modify(price);
  return Math.trunc(price);
}

/** relic.getPrice(): the price follows the relic's own tier (a pool fallback can
 *  hand over a relic of another tier; event relics are SPECIAL, 400, like
 *  Circlet), else the rolled one. */
function relicPriceTier(ctx: EffectCtx, id: RelicId, rolled: RelicPoolTier): keyof typeof SHOP.basePrices.relicByTier {
  const tier = ctx.bundle.relics.get(id)?.tier;
  if (tier === "event" || tier === "special") return "special";
  return tier ?? rolled;
}

function baseShopRelicPrice(ctx: EffectCtx, tier: keyof typeof SHOP.basePrices.relicByTier): number {
  return Math.round(f32mul(SHOP.basePrices.relicByTier[tier], ctx.rng("merchantRng").randomFloatRange(SHOP.otherJitter.min, SHOP.otherJitter.max)));
}

function baseShopPotionPrice(ctx: EffectCtx, id: PotionId): number {
  return Math.round(
    f32mul(
      SHOP.basePrices.potionByRarity[ctx.bundle.potions.get(id)!.rarity],
      ctx.rng("merchantRng").randomFloatRange(SHOP.otherJitter.min, SHOP.otherJitter.max),
    ),
  );
}

/** Courier card restock (ShopScreen.purchaseCard): class cards keep the bought
 * card's type, roll the shop rarity on cardRng and pick with MathUtils.random;
 * colorless cards roll merchantRng.random() < 0.3 for RARE and pick on cardRng.
 * No duplicate retry and no sale halving; priced by setPrice. */
export function restockShopCardSlot(ctx: EffectCtx, slot: ShopCardSlot): void {
  if (slot.colorless) {
    const rarity = ctx.rng("merchantRng").randomBoolean(SHOP.colorlessRareChance) ? "rare" : "uncommon";
    const id = rollColorlessCard(ctx, rarity);
    slot.id = id;
    slot.rarity = rarity;
    slot.price = restockCardPrice(ctx, rarity, true);
  } else {
    const type = ctx.bundle.cards.get(slot.id)!.type;
    if (type !== "attack" && type !== "skill" && type !== "power") throw new Error(`invalid shop card type: ${type}`);
    const pick = rollShopClassCard(ctx, type, "mathUtilRng");
    slot.id = pick.id;
    slot.rarity = pick.rarity;
    slot.price = restockCardPrice(ctx, pick.rarity, false);
  }
  slot.sold = false;
}

/** Courier relic restock (StoreRelic.purchaseRelic): returnRandomRelicEnd(
 * rollRelicTier()) - the END of the rolled tier's pool, canSpawn asked as in a
 * ShopRoom - re-rolled tier and relic while it lands on Old Coin, Smiling
 * Mask, Maw Bank or The Courier, priced by getNewPrice from the relic's own
 * tier. The shop-tier slot restocks through the same common/uncommon/rare roll. */
export function restockShopRelicSlot(ctx: EffectCtx, slot: ShopRelicSlot): void {
  let tier = rollShopRelicTier(ctx);
  let id = obtainRelicFromPoolEnd(ctx, tier, true);
  while (id === "OLD_COIN" || id === "SMILING_MASK" || id === "MAW_BANK" || id === "THE_COURIER") {
    tier = rollShopRelicTier(ctx);
    id = obtainRelicFromPoolEnd(ctx, tier, true);
  }
  slot.id = id;
  slot.tier = tier;
  slot.price = restockPrice(ctx, baseShopRelicPrice(ctx, relicPriceTier(ctx, id, tier)));
  slot.sold = false;
}

/** Courier potion restock (StorePotion.purchasePotion): returnRandomPotion on
 * potionRng, priced by getNewPrice. With an empty pool the slot stays sold. */
export function restockShopPotionSlot(ctx: EffectCtx, slot: ShopPotionSlot): void {
  const id = returnRandomPotion(ctx);
  if (id === null) return;
  slot.id = id;
  slot.price = restockPrice(ctx, baseShopPotionPrice(ctx, id));
  slot.sold = false;
}

/** Generate the full shop inventory (Merchant constructor, then ShopScreen.init:
 *  initCards, initRelics, initPotions, the discounts). The sale slot is halved
 *  (integer division) BEFORE the A16/relic price factors. */
export function generateShop(ctx: EffectCtx): ShopState {
  const merchantRng = ctx.rng("merchantRng");

  // --- cards: 0-1 attack (distinct), 2-3 skill (distinct), 4 power ---
  const picks: { id: CardId; rarity: CardRarityRoll; colorless: boolean }[] = [];
  const a0 = rollShopClassCard(ctx, "attack");
  picks.push({ ...a0, colorless: false });
  let a1 = rollShopClassCard(ctx, "attack");
  let guard = 0;
  while (a1.id === a0.id && ++guard < 1000) a1 = rollShopClassCard(ctx, "attack");
  picks.push({ ...a1, colorless: false });
  const s0 = rollShopClassCard(ctx, "skill");
  picks.push({ ...s0, colorless: false });
  let s1 = rollShopClassCard(ctx, "skill");
  guard = 0;
  while (s1.id === s0.id && ++guard < 1000) s1 = rollShopClassCard(ctx, "skill");
  picks.push({ ...s1, colorless: false });
  picks.push({ ...rollShopClassCard(ctx, "power"), colorless: false });
  picks.push({ id: rollColorlessCard(ctx, "uncommon"), rarity: "uncommon", colorless: true });
  picks.push({ id: rollColorlessCard(ctx, "rare"), rarity: "rare", colorless: true });

  // prices: int(base * merchantRng.random(0.9, 1.1)) - colorless x1.2, then sale
  const cards: ShopCardSlot[] = picks.map((p) => ({
    id: p.id,
    rarity: p.rarity,
    price: baseShopCardPrice(ctx, p.rarity, p.colorless),
    sold: false,
    colorless: p.colorless,
  }));
  const saleIdx = merchantRng.random(SHOP.saleSlots - 1);
  cards[saleIdx]!.price = Math.trunc(cards[saleIdx]!.price / 2);

  // --- relics (initRelics): per slot a tier roll (merchantRng), a pop from the
  // END of that pool (canSpawn asked as in a ShopRoom: no Maw Bank, Old Coin,
  // Smiling Mask or Courier here), then its price roll (merchantRng); the
  // third slot is always SHOP tier ---
  const relics: ShopRelicSlot[] = [];
  for (let i = 0; i < 3; i++) {
    const tier: RelicPoolTier = i !== 2 ? rollShopRelicTier(ctx) : "shop";
    const id = obtainRelicFromPoolEnd(ctx, tier, true);
    relics.push({ id, tier, price: baseShopRelicPrice(ctx, relicPriceTier(ctx, id, tier)), sold: false });
  }

  // --- potions (initPotions): 3 picks (potionRng), each priced (merchantRng).
  // No Sozu check: StorePotion.purchasePotion refuses the sale instead ---
  const potions: ShopPotionSlot[] = [];
  for (let i = 0; i < 3; i++) {
    const id = returnRandomPotion(ctx);
    if (id !== null) potions.push({ id, price: baseShopPotionPrice(ctx, id), sold: false });
  }

  // --- A16 x1.1 then the Courier / Membership Card discounts, rounding each ---
  for (const c of cards) c.price = finalizePrice(ctx, c.price);
  for (const r of relics) r.price = finalizePrice(ctx, r.price);
  for (const p of potions) p.price = finalizePrice(ctx, p.price);

  return { cards, relics, potions, removalCost: computeRemovalCost(ctx), removalUsed: false };
}

/** Buying a relic mid-shop (StoreRelic.purchaseRelic): only Membership Card
 *  re-prices the shop - applyDiscount(0.5F, true) on every remaining price, and
 *  the removal cost becomes round(purgeCost * 0.5) from the base cost; Smiling
 *  Mask pins the removal cost at 50. The Courier discounts nothing mid-shop
 *  (its 0.8 only applies when a shop is set up). */
export function repriceAfterRelic(ctx: EffectCtx, shop: ShopState, relicId: string): void {
  if (relicId === "SMILING_MASK" && !shop.removalUsed) shop.removalCost = SHOP.removal.smilingMask;
  if (relicId !== "MEMBERSHIP_CARD") return;
  const hook = ctx.bundle.relics.get(relicId)?.hooks.modifyPrice;
  if (!hook) return;
  const factor = hook({ ...ctx, owner: PLAYER, relicCounter: { get: () => 0, set: () => {} } }, 1);
  const apply = (p: number) => Math.round(f32mul(p, factor));
  for (const c of shop.cards) if (!c.sold) c.price = apply(c.price);
  for (const r of shop.relics) if (!r.sold) r.price = apply(r.price);
  for (const p of shop.potions) if (!p.sold) p.price = apply(p.price);
  if (!shop.removalUsed) {
    shop.removalCost = hasRelic(ctx.run, "SMILING_MASK") ? SHOP.removal.smilingMask : apply(basePurgeCost(ctx));
  }
}
