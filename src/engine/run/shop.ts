// Shop inventory + pricing, exact per data/corpus/meta.json "shop"
// (sts_lightspeed Shop.cpp). Streams: card identities/rarities = cardRng,
// relic tiers + ALL price jitter + sale slot = merchantRng, potions = potionRng.
//
// ASCENSION 16 - DISPUTED (meta.shop.disputed.ascension16Prices):
//   sts_lightspeed applies applyDiscount(0.80f) at ascension >= 16, which makes
//   shops CHEAPER; the wiki documents A16 as "Shops are more costly." (commonly
//   +10%). We implement the WIKI side: prices (and removal cost) x1.10, rounded,
//   applied before relic price hooks (Courier 0.80, Membership Card 0.50).
//
// COURIER RESTOCK (decompiled game authority over known sts_lightspeed bugs):
//   purchaseCard / StoreRelic.purchaseRelic / StorePotion.purchasePotion replace
//   bought slots when Courier was owned at purchase entry. New-slot prices use
//   the same setup discounts/order; we intentionally do NOT copy lightspeed's
//   getNewCardPrice duplicate Courier check nor getNewPrice rounding discard.

import type { EffectCtx } from "../content/defs";
import type { ShopState, ShopCardSlot, ShopRelicSlot, ShopPotionSlot, CardRarityRoll, RelicPoolTier } from "./runState";
import type { CardId, PotionId } from "../core/ids";
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
  ascension16Factor: 1.1, // DISPUTED - wiki side implemented (lightspeed uses 0.80)
  colorlessRareChance: 0.3,
} as const;

/** Shop::rollCardRarityShop - reads cardRarityFactor but does NOT update it. */
export function rollCardRarityShop(ctx: EffectCtx): CardRarityRoll {
  const roll = ctx.rng("cardRng").random(99) + ctx.run.blizzard.cardRarityFactor;
  if (roll < SHOP.cardRarityRoll.rareBelow) return "rare";
  if (roll >= SHOP.cardRarityRoll.commonAtOrAbove) return "common";
  return "uncommon";
}

/** Shop::rollRelicTier (merchantRng): <48 common, <82 uncommon, else rare. */
export function rollShopRelicTier(ctx: EffectCtx): RelicPoolTier {
  const roll = ctx.rng("merchantRng").random(99);
  if (roll < SHOP.relicTierRoll.commonBelow) return "common";
  if (roll < SHOP.relicTierRoll.uncommonBelow) return "uncommon";
  return "rare";
}

type ShopCardType = "attack" | "skill" | "power";

/** One class-card slot: rarity roll (power slot promotes COMMON -> UNCOMMON),
 *  then a uniform cardRng pick from the class pool of that type+rarity. */
function rollShopClassCard(ctx: EffectCtx, type: ShopCardType): { id: CardId; rarity: CardRarityRoll } {
  let rarity = rollCardRarityShop(ctx);
  if (type === "power" && rarity === "common") rarity = "uncommon";
  const pool = classCardPool(ctx, rarity).filter((id) => ctx.bundle.cards.get(id)!.type === type);
  if (pool.length === 0) throw new Error(`empty shop pool: ${type}/${rarity} for ${ctx.run.character}`);
  return { id: pool[ctx.rng("cardRng").random(pool.length - 1)]!, rarity };
}

function rollColorlessCard(ctx: EffectCtx, rarity: CardRarityRoll): CardId {
  const pool = colorlessCardPool(ctx, rarity);
  if (pool.length === 0) throw new Error(`empty colorless ${rarity} pool`);
  return pool[ctx.rng("cardRng").random(pool.length - 1)]!;
}

/** Removal cost: Smiling Mask fixes it at 50; else 75 + 25 per prior purchase,
 *  then the (disputed) A16 factor. ShopScreen's applyDiscount recomputes the
 *  removal cost from that base on every discount pass instead of compounding,
 *  so Membership Card's half wins over The Courier's 20% off. */
export function computeRemovalCost(ctx: EffectCtx): number {
  if (hasRelic(ctx.run, "SMILING_MASK")) return SHOP.removal.smilingMask;
  let cost = SHOP.removal.basePrice + SHOP.removal.increasePerPurchase * ctx.run.history.cardRemovesPurchased;
  cost = applyA16(ctx, cost);
  if (hasRelic(ctx.run, "MEMBERSHIP_CARD")) return relicDiscount(ctx, "MEMBERSHIP_CARD", cost);
  if (hasRelic(ctx.run, "THE_COURIER")) return relicDiscount(ctx, "THE_COURIER", cost);
  return cost;
}

function applyA16(ctx: EffectCtx, price: number): number {
  // DISPUTED A16 multiplier - wiki side (+10%); see file header.
  return ctx.run.ascension >= 16 ? Math.round(price * SHOP.ascension16Factor) : price;
}

/** One relic's modifyPrice pass, rounded like ShopScreen.applyDiscount. */
function relicDiscount(ctx: EffectCtx, relicId: string, price: number): number {
  const hook = ctx.bundle.relics.get(relicId)?.hooks.modifyPrice;
  if (!hook) return price;
  return Math.round(hook({ ...ctx, owner: PLAYER, relicCounter: { get: () => 0, set: () => {} } }, price));
}

/** ShopScreen.init: the A16 pass, then The Courier's, then Membership Card's
 *  (that fixed order, whatever order they were obtained in), each its own
 *  MathUtils.round; any other price relic folds after them. */
function finalizePrice(ctx: EffectCtx, price: number): number {
  let p = applyA16(ctx, price);
  const owned = ctx.run.relics.map((r) => r.defId);
  const rank = (id: string) => (id === "THE_COURIER" ? 0 : id === "MEMBERSHIP_CARD" ? 1 : 2);
  for (const id of [...owned].sort((a, b) => rank(a) - rank(b))) p = relicDiscount(ctx, id, p);
  return p;
}

function baseShopCardPrice(ctx: EffectCtx, rarity: CardRarityRoll, colorless: boolean): number {
  const merchantRng = ctx.rng("merchantRng");
  let price = f32mul(SHOP.basePrices.cardByRarity[rarity], merchantRng.randomFloatRange(SHOP.cardJitter.min, SHOP.cardJitter.max));
  if (colorless) price = f32mul(price, SHOP.colorlessFactor);
  return Math.trunc(price);
}

/** StoreRelic's base price is AbstractRelic.getPrice(): the relic's OWN tier
 *  (a pool fallback into another tier is priced as that tier; Circlet 400). */
function relicPriceKey(ctx: EffectCtx, id: string, rolled: RelicPoolTier): keyof typeof SHOP.basePrices.relicByTier {
  const tier = ctx.bundle.relics.get(id)?.tier;
  if (tier === "event" || tier === "special") return "special";
  return tier ?? rolled;
}

function baseShopRelicPrice(ctx: EffectCtx, id: string, tier: RelicPoolTier): number {
  const base = SHOP.basePrices.relicByTier[relicPriceKey(ctx, id, tier)];
  return Math.round(f32mul(base, ctx.rng("merchantRng").randomFloatRange(SHOP.otherJitter.min, SHOP.otherJitter.max)));
}

function baseShopPotionPrice(ctx: EffectCtx, id: PotionId): number {
  return Math.round(
    f32mul(
      SHOP.basePrices.potionByRarity[ctx.bundle.potions.get(id)!.rarity],
      ctx.rng("merchantRng").randomFloatRange(SHOP.otherJitter.min, SHOP.otherJitter.max),
    ),
  );
}

function priceShopCard(ctx: EffectCtx, rarity: CardRarityRoll, colorless: boolean): number {
  return finalizePrice(ctx, baseShopCardPrice(ctx, rarity, colorless));
}

function priceShopRelic(ctx: EffectCtx, id: string, tier: RelicPoolTier): number {
  return finalizePrice(ctx, baseShopRelicPrice(ctx, id, tier));
}

function priceShopPotion(ctx: EffectCtx, id: PotionId): number {
  return finalizePrice(ctx, baseShopPotionPrice(ctx, id));
}

/** Courier card restock: class cards keep the bought card's type and roll shop
 * rarity on cardRng; colorless cards use merchantRng's 30% rare roll. No setup
 * duplicate retry and no sale-slot halving is applied to restocks. */
export function restockShopCardSlot(ctx: EffectCtx, slot: ShopCardSlot): void {
  if (slot.colorless) {
    const rarity = ctx.rng("merchantRng").randomBoolean(SHOP.colorlessRareChance) ? "rare" : "uncommon";
    const id = rollColorlessCard(ctx, rarity);
    slot.id = id;
    slot.rarity = rarity;
    slot.price = priceShopCard(ctx, rarity, true);
  } else {
    const type = ctx.bundle.cards.get(slot.id)!.type;
    if (type !== "attack" && type !== "skill" && type !== "power") throw new Error(`invalid shop card type: ${type}`);
    const pick = rollShopClassCard(ctx, type);
    slot.id = pick.id;
    slot.rarity = pick.rarity;
    slot.price = priceShopCard(ctx, pick.rarity, false);
  }
  slot.sold = false;
}

/** Courier relic restock (StoreRelic.purchaseRelic): returnRandomRelicEnd off
 *  Shop::rollRelicTier (common/uncommon/rare, including for the original
 *  shop-tier slot), re-rolled tier and relic while it lands on Old Coin,
 *  Smiling Mask, Maw Bank or The Courier. */
export function restockShopRelicSlot(ctx: EffectCtx, slot: ShopRelicSlot): void {
  let tier = rollShopRelicTier(ctx);
  let id = obtainRelicFromPoolEnd(ctx, tier, true);
  while (id === "OLD_COIN" || id === "SMILING_MASK" || id === "MAW_BANK" || id === "THE_COURIER") {
    tier = rollShopRelicTier(ctx);
    id = obtainRelicFromPoolEnd(ctx, tier, true);
  }
  slot.id = id;
  slot.tier = tier;
  slot.price = priceShopRelic(ctx, id, tier);
  slot.sold = false;
}

/** Courier potion restock: returnRandomPotion on potionRng, priced like setup.
 * If potion generation is blocked/empty, the purchased slot remains sold. */
export function restockShopPotionSlot(ctx: EffectCtx, slot: ShopPotionSlot): void {
  const id = returnRandomPotion(ctx);
  if (id === null) return;
  slot.id = id;
  slot.price = priceShopPotion(ctx, id);
  slot.sold = false;
}

/** Generate the full shop inventory (Shop::setup / setupCards / setupRelics /
 *  setupPotions). Per-stream call order is preserved exactly; the sale slot is
 *  halved (integer division) BEFORE the A16/relic price factors. */
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

  // --- relics: ShopScreen.initRelics, slot by slot: tier roll (the third slot
  // is SHOP tier), a returnRandomRelicEnd draw (the END of the pool, canSpawn
  // asked as in a ShopRoom: no Maw Bank, Old Coin, Smiling Mask or Courier
  // here), then that slot's merchantRng price roll ---
  const relics: ShopRelicSlot[] = [];
  for (let i = 0; i < 3; i++) {
    const tier: RelicPoolTier = i === 2 ? "shop" : rollShopRelicTier(ctx);
    const id = obtainRelicFromPoolEnd(ctx, tier, true);
    relics.push({ id, tier, price: baseShopRelicPrice(ctx, id, tier), sold: false });
  }

  // --- potions: 3 picks (potionRng), then price rolls (merchantRng) ---
  const potionIds = [returnRandomPotion(ctx), returnRandomPotion(ctx), returnRandomPotion(ctx)];
  const potions = potionIds
    .filter((id): id is string => id !== null)
    .map((id) => ({
      id,
      price: baseShopPotionPrice(ctx, id),
      sold: false,
    }));

  // --- A16 (disputed, wiki side) then relic price hooks (Courier/Membership) ---
  for (const c of cards) c.price = finalizePrice(ctx, c.price);
  for (const r of relics) r.price = finalizePrice(ctx, r.price);
  for (const p of potions) p.price = finalizePrice(ctx, p.price);

  return { cards, relics, potions, removalCost: computeRemovalCost(ctx), removalUsed: false };
}

/** Mid-shop reprice: buying a price-modifying relic (Membership Card) applies
 *  its factor to remaining unsold prices and the removal cost immediately. */
export function repriceAfterRelic(ctx: EffectCtx, shop: ShopState, relicId: string): void {
  const def = ctx.bundle.relics.get(relicId);
  if (!def?.hooks.modifyPrice) return;
  const apply = (p: number) => relicDiscount(ctx, relicId, p);
  for (const c of shop.cards) if (!c.sold) c.price = apply(c.price);
  for (const r of shop.relics) if (!r.sold) r.price = apply(r.price);
  for (const p of shop.potions) if (!p.sold) p.price = apply(p.price);
  // applyDiscount(0.5f, true): the removal cost is recomputed from its base
  // (Smiling Mask keeps 50), not halved again from its discounted value
  if (!shop.removalUsed) shop.removalCost = computeRemovalCost(ctx);
}
