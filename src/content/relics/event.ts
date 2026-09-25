// Event + special relics - values audited vs data/corpus/relics.json.

import type { RelicDef } from "../../engine/content/defs";
import { PLAYER, monster } from "../../engine/core/ids";
import { queueReplayCopy } from "../../engine/combat/interpreter";
import { obtainDeckCard } from "../../engine/run/deck";
import {
  cnt,
  gainGold,
  healPlayer,
  inCombatClassPoolFilter,
  increaseMaxHp,
  makeCardInstance,
  queueContentEffect,
  randomCardDefInCombat,
} from "./lib";

export const eventRelics: RelicDef[] = [
  {
    // "Whenever you gain Gold, heal 5 HP." AbstractPlayer.gainGold returns
    // before any onGainGold with Ectoplasm, or when the amount is not positive.
    id: "BLOODY_IDOL",
    name: "Bloody Idol",
    tier: "event",
    pool: "shared",
    hooks: {
      onGainGold: (ctx, amount) => {
        if (amount > 0 && !ctx.run.relics.some((r) => r.defId === "ECTOPLASM")) healPlayer(ctx, 5);
        return amount;
      },
    },
  },
  {
    // "You feel more talkative." No gameplay effect (flavor relic).
    id: "CULTIST_HEADPIECE",
    name: "Cultist Headpiece",
    tier: "event",
    pool: "shared",
    hooks: {},
  },
  {
    // "At the start of each combat, add a random Power card into your hand.
    // It costs 0 for that turn." Enchiridion.atPreBattle: picked before the
    // opening draw from returnTrulyRandomCardInCombat(POWER) (no HEALING
    // cards); an X-cost pick keeps its cost. DEPENDS: power-card pool.
    id: "ENCHIRIDION",
    name: "Enchiridion",
    tier: "event",
    pool: "shared",
    hooks: {
      atBattleStartPreDraw: (ctx) => {
        const picked = randomCardDefInCombat(ctx, inCombatClassPoolFilter(ctx, "power"));
        if (!picked) return;
        const c = makeCardInstance(ctx, picked.id, 0, "hand");
        if (c && c.cost !== -1) c.costForTurn = 0;
      },
    },
  },
  {
    // "At the end of combat, raise your Max HP by 1." increaseMaxHp(1, true),
    // so its heal goes through the heal path (Magic Flower still applies).
    id: "FACE_OF_CLERIC",
    name: "Face of Cleric",
    tier: "event",
    pool: "shared",
    hooks: { onVictory: (ctx) => increaseMaxHp(ctx, 1) },
  },
  {
    // "Enemies drop 25% more Gold." RewardItem.applyGoldBonus: every non-stolen
    // gold reward outside a treasure room (rewards.ts withGoldenIdolBonus).
    id: "GOLDEN_IDOL",
    name: "Golden Idol",
    tier: "event",
    pool: "shared",
    hooks: {},
  },
  {
    // "Start each combat with 1 Weak." (expires at the end of round 1)
    id: "GREMLIN_VISAGE",
    name: "Gremlin Visage",
    tier: "event",
    pool: "shared",
    hooks: {
      atBattleStart: (ctx) =>
        ctx.queue.addToBottom({ kind: "applyPower", source: PLAYER, target: PLAYER, powerId: "WEAK", amount: 1 }),
    },
  },
  {
    // "You can no longer heal."
    id: "MARK_OF_THE_BLOOM",
    name: "Mark of the Bloom",
    tier: "event",
    pool: "shared",
    hooks: { onHeal: () => 0 },
  },
  {
    // "Start each combat with 3 Strength. At the end of your first turn, lose 3 Strength."
    id: "MUTAGENIC_STRENGTH",
    name: "Mutagenic Strength",
    tier: "event",
    pool: "shared",
    hooks: {
      atBattleStart: (ctx) => {
        ctx.queue.addToBottom({ kind: "applyPower", source: PLAYER, target: PLAYER, powerId: "STRENGTH", amount: 3 });
        ctx.queue.addToBottom({ kind: "applyPower", source: PLAYER, target: PLAYER, powerId: "LOSE_STRENGTH", amount: 3 });
      },
    },
  },
  {
    // "The first Attack played each turn that costs 2 or more is played twice.
    // Upon pickup, obtain a special Curse." Curse obtain guarded (DEPENDS:
    // NECRONOMICURSE card def).
    id: "NECRONOMICON",
    name: "Necronomicon",
    tier: "event",
    pool: "shared",
    onEquip: (ctx) => {
      // ShowCardAndObtainEffect: Omamori can negate it; Darkstone/Ceramic Fish see it
      if (ctx.bundle.cards.has("NECRONOMICURSE")) obtainDeckCard(ctx, "NECRONOMICURSE");
    },
    hooks: {
      atStartOfTurn: (ctx) => cnt(ctx).set(0),
      // Necronomicon.onUseCard: an Attack with costForTurn >= 2 that is not
      // free, or an X Attack paid with 2+ energy. Autoplayed cards (Havoc,
      // Mayhem) count; replay copies never reach it while it is still armed.
      onUseCard: (ctx, card, target) => {
        const item = ctx.rt.currentItem;
        if (!item || item.purgeOnUse) return;
        if (cnt(ctx).get() !== 0) return;
        if (ctx.bundle.cards.get(card.defId)?.type !== "attack") return;
        const costly = (card.costForTurn >= 2 && !card.freeToPlayOnce) || (card.cost === -1 && item.energyOnUse >= 2);
        if (!costly) return;
        cnt(ctx).set(1);
        queueReplayCopy(ctx, card, target, item, "NECRONOMICON");
      },
    },
  },
  {
    // "At the end of each turn, you may shuffle 1 of 3 random cards into your
    // draw pile." NilrysCodex.onPlayerEndTurn queues a CodexAction: 3 distinct
    // class cards (no HEALING cards), skippable, the pick shuffled in.
    id: "NILRYS_CODEX",
    name: "Nilry's Codex",
    tier: "event",
    pool: "shared",
    hooks: { atEndOfTurnPreEndOfTurnCards: (ctx) => queueContentEffect(ctx, "content:codexChoose") },
  },
  {
    // "Enemies in your first 3 combats will have 1 HP." counter set on pickup.
    id: "NEOWS_LAMENT",
    name: "Neow's Lament",
    countsDown: true,
    tier: "event",
    pool: "shared",
    onEquip: (ctx) => {
      const r = ctx.run.relics.find((x) => x.defId === "NEOWS_LAMENT");
      if (r) r.counter = 3;
    },
    hooks: {
      // NeowsLament.atBattleStart: after the pre-battle setup and first moves
      atBattleStart: (ctx) => {
        if (cnt(ctx).get() <= 0) return;
        cnt(ctx).set(cnt(ctx).get() - 1);
        for (const m of ctx.combat!.monsters) m.hp = 1;
      },
    },
  },
  {
    // "Triples the chance of finding Rare cards from combat rewards." RUN-LAYER.
    id: "NLOTHS_GIFT",
    name: "N'loth's Gift",
    tier: "event",
    pool: "shared",
    hooks: {},
  },
  {
    // "The next non-Boss chest you open is empty." NlothsMask: counter 1;
    // onChestOpenAfter removes the chest's first relic reward (Matryoshka's
    // extra when there is one, else the chest's own relic and its linked
    // Sapphire Key) - the chest's gold stays.
    id: "NLOTHS_HUNGRY_FACE",
    name: "N'loth's Hungry Face",
    countsDown: true,
    tier: "event",
    pool: "shared",
    onEquip: (ctx) => {
      const r = ctx.run.relics.find((x) => x.defId === "NLOTHS_HUNGRY_FACE");
      if (r) r.counter = 1;
    },
    hooks: {
      onChestOpenAfter: (ctx, isBossChest, rewards) => {
        if (isBossChest || cnt(ctx).get() <= 0) return;
        cnt(ctx).set(cnt(ctx).get() - 1);
        if (rewards.extras.length > 0) rewards.extras.shift();
        else rewards.chestRelic = null;
      },
    },
  },
  {
    // Marker: the modified Vulnerable-taken multiplier (x1.25) is consumed inside
    // the VULNERABLE power def via hasRelic("ODD_MUSHROOM").
    id: "ODD_MUSHROOM",
    name: "Odd Mushroom",
    tier: "event",
    pool: "shared",
    hooks: {},
  },
  {
    // "At the start of each combat, apply 1 Weak to ALL enemies."
    id: "RED_MASK",
    name: "Red Mask",
    tier: "event",
    pool: "shared",
    hooks: {
      atBattleStart: (ctx) => {
        for (const m of ctx.combat!.monsters) {
          if (!m.isDead && !m.isEscaped) {
            ctx.queue.addToBottom({ kind: "applyPower", source: PLAYER, target: monster(m.idx), powerId: "WEAK", amount: 1 });
          }
        }
      },
    },
  },
  {
    // "Whenever you enter a ? room, gain 50 Gold." SsserpentHead.onEnterRoom
    // sees the node's EventRoom before the ? is rolled, so every ? node pays,
    // whatever it turns into.
    id: "SSSERPENT_HEAD",
    name: "Ssserpent Head",
    tier: "event",
    pool: "shared",
    hooks: {
      onEnterRoom: (ctx, roomKind) => {
        if (roomKind === "event") gainGold(ctx, 50);
      },
    },
  },
  {
    // "It's unpleasant." No gameplay effect.
    id: "SPIRIT_POOP",
    name: "Spirit Poop",
    tier: "event",
    pool: "shared",
    hooks: {},
  },
  {
    // "At the start of your turn, Upgrade a random card in your hand for the
    // rest of combat." WarpedTongs.atTurnStartPostDraw queues an
    // UpgradeRandomCardAction: it acts on the freshly drawn hand, and picks
    // by java-shuffling the upgradeable cards off shuffleRng.
    id: "WARPED_TONGS",
    name: "Warped Tongs",
    tier: "event",
    pool: "shared",
    hooks: { atStartOfTurnPostDraw: (ctx) => queueContentEffect(ctx, "content:upgradeRandomHandCard") },
  },
  // --- special tier ------------------------------------------------------------
  {
    // "Collect as many as you can." No gameplay effect.
    id: "CIRCLET",
    name: "Circlet",
    tier: "special",
    pool: "shared",
    hooks: {},
  },
  {
    // "You ran out of relics. Impressive!" No gameplay effect.
    id: "RED_CIRCLET",
    name: "Red Circlet",
    tier: "special",
    pool: "shared",
    hooks: {},
  },
];
