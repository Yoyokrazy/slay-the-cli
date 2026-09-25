// Common relics - values audited vs data/corpus/relics.json.
//
// Flags used throughout:
//   // RUN-LAYER - hook side implemented; the engine does not fire this hook yet
//                   (run layer absent) or the behavior needs run-level systems.
//   // ENGINE-GAP - not expressible with current hooks; def is a marker.
//   // DEPENDS - needs content from another workstream (guarded).

import type { EffectCtx, RelicDef } from "../../engine/content/defs";
import { PLAYER, monster } from "../../engine/core/ids";
import { f32mul } from "../../engine/core/math";
import { JavaRandom, javaShuffle } from "../../engine/core/rng";
import { canSmith } from "../../engine/run/rest";
import { cnt, gainGold, healPlayer, increaseMaxHp, relicDamageAll, spawnsOutsideShops, spawnsUpToFloor } from "./lib";

export const commonRelics: RelicDef[] = [
  {
    // "Your first Attack each combat deals 8 additional damage." (Vigor 8)
    id: "AKABEKO",
    name: "Akabeko",
    tier: "common",
    pool: "shared",
    hooks: {
      atBattleStart: (ctx) =>
        ctx.queue.addToBottom({ kind: "applyPower", source: PLAYER, target: PLAYER, powerId: "VIGOR", amount: 8 }),
    },
  },
  {
    // "If you do not play any Attacks during your turn, gain an additional Energy next turn."
    // counter: 1 once an attack is played this turn; checked+reset at turn start.
    id: "ART_OF_WAR",
    name: "Art of War",
    tier: "common",
    pool: "shared",
    hooks: {
      atStartOfTurn: (ctx) => {
        if (ctx.combat!.turn > 1 && cnt(ctx).get() === 0) ctx.queue.addToBottom({ kind: "gainEnergy", n: 1 });
        cnt(ctx).set(0);
      },
      onUseCard: (ctx, card) => {
        if (ctx.bundle.cards.get(card.defId)?.type === "attack") cnt(ctx).set(1);
      },
    },
  },
  {
    // "Start each combat with 10 Block."
    id: "ANCHOR",
    name: "Anchor",
    tier: "common",
    pool: "shared",
    hooks: {
      atBattleStart: (ctx) => ctx.queue.addToBottom({ kind: "gainBlock", target: PLAYER, amount: 10, fromCard: false }),
    },
  },
  {
    // "Whenever you enter a Rest Site, start the next combat with 2 extra Energy."
    // onEnterRestRoom banks it; the next combat's first turn spends it.
    id: "ANCIENT_TEA_SET",
    name: "Ancient Tea Set",
    tier: "common",
    pool: "shared",
    canSpawn: spawnsUpToFloor(48),
    hooks: {
      onEnterRestSite: (ctx) => cnt(ctx).set(1),
      atStartOfTurn: (ctx) => {
        if (ctx.combat!.turn === 1 && cnt(ctx).get() === 1) {
          cnt(ctx).set(0);
          ctx.queue.addToBottom({ kind: "gainEnergy", n: 2 });
        }
      },
    },
  },
  {
    // "At the start of each combat, apply 1 Vulnerable to ALL enemies."
    id: "BAG_OF_MARBLES",
    name: "Bag of Marbles",
    tier: "common",
    pool: "shared",
    hooks: {
      atBattleStart: (ctx) => {
        for (const m of ctx.combat!.monsters) {
          if (!m.isDead && !m.isEscaped) {
            ctx.queue.addToBottom({
              kind: "applyPower",
              source: PLAYER,
              target: monster(m.idx),
              powerId: "VULNERABLE",
              amount: 1,
            });
          }
        }
      },
    },
  },
  {
    // "At the start of each combat, draw 2 additional cards." Its own
    // DrawCardAction, queued behind the opening draw (BagOfPreparation.atBattleStart).
    id: "BAG_OF_PREPARATION",
    name: "Bag of Preparation",
    tier: "common",
    pool: "shared",
    hooks: { atBattleStart: (ctx) => ctx.queue.addToBottom({ kind: "draw", n: 2 }) },
  },
  {
    // "At the start of each combat, heal 2 HP."
    id: "BLOOD_VIAL",
    name: "Blood Vial",
    tier: "common",
    pool: "shared",
    hooks: { atBattleStart: (ctx) => ctx.queue.addToBottom({ kind: "heal", target: PLAYER, amount: 2 }) },
  },
  {
    // "Start each combat with 3 Thorns."
    id: "BRONZE_SCALES",
    name: "Bronze Scales",
    tier: "common",
    pool: "shared",
    hooks: {
      atBattleStart: (ctx) =>
        ctx.queue.addToBottom({ kind: "applyPower", source: PLAYER, target: PLAYER, powerId: "THORNS", amount: 3 }),
    },
  },
  {
    // "The first time you lose HP each combat, draw 3 cards." addToTop: the
    // draw resolves before whatever the hit's source queued next.
    id: "CENTENNIAL_PUZZLE",
    name: "Centennial Puzzle",
    tier: "common",
    pool: "shared",
    hooks: {
      atBattleStart: (ctx) => cnt(ctx).set(0),
      wasHPLost: (ctx, _info, amount) => {
        if (amount > 0 && cnt(ctx).get() === 0) {
          cnt(ctx).set(1);
          ctx.queue.addToTop({ kind: "draw", n: 3 });
        }
      },
    },
  },
  {
    // "Whenever you add a card to your deck, gain 9 Gold." RUN-LAYER site.
    id: "CERAMIC_FISH",
    name: "Ceramic Fish",
    tier: "common",
    pool: "shared",
    canSpawn: spawnsUpToFloor(48),
    hooks: { onObtainCard: (ctx) => void gainGold(ctx, 9) },
  },
  {
    // "At the start of your turn, gain 1 Mantra."
    id: "DAMARU",
    name: "Damaru",
    tier: "common",
    pool: "purple",
    hooks: { atStartOfTurn: (ctx) => ctx.queue.addToBottom({ kind: "gainMantra", n: 1 }) },
  },
  {
    // "Start each combat with 1 Focus."
    id: "DATA_DISK",
    name: "Data Disk",
    tier: "common",
    pool: "blue",
    hooks: {
      atBattleStart: (ctx) =>
        ctx.queue.addToBottom({ kind: "applyPower", source: PLAYER, target: PLAYER, powerId: "FOCUS", amount: 1 }),
    },
  },
  {
    // "Whenever you Rest, you may add a card to your deck."
    // CampfireSleepEffect opens getRewardCards() after the heal (runFlow's rest).
    id: "DREAM_CATCHER",
    name: "Dream Catcher",
    tier: "common",
    pool: "shared",
    canSpawn: spawnsUpToFloor(48),
    hooks: {},
  },
  {
    // "Every 3 turns, gain 1 Energy." (persistent counter, continues across combats)
    id: "HAPPY_FLOWER",
    name: "Happy Flower",
    tier: "common",
    pool: "shared",
    hooks: {
      atStartOfTurn: (ctx) => {
        const c = cnt(ctx).get() + 1;
        if (c === 3) {
          cnt(ctx).set(0);
          ctx.queue.addToBottom({ kind: "gainEnergy", n: 1 });
        } else {
          cnt(ctx).set(c);
        }
      },
    },
  },
  {
    // "Regular enemy combats are no longer encountered in ? rooms." RUN-LAYER (map/event gen).
    id: "JUZU_BRACELET",
    name: "Juzu Bracelet",
    tier: "common",
    pool: "shared",
    canSpawn: spawnsUpToFloor(48),
    hooks: {},
  },
  {
    // "Gain 1 Energy on the first turn of each combat."
    id: "LANTERN",
    name: "Lantern",
    tier: "common",
    pool: "shared",
    hooks: {
      atStartOfTurn: (ctx) => {
        if (ctx.combat!.turn === 1) ctx.queue.addToBottom({ kind: "gainEnergy", n: 1 });
      },
    },
  },
  {
    // "Whenever you climb a floor, gain 12 Gold. No longer works when you spend
    // any Gold at a shop." onEnterRoom fires on every room transition, the
    // boss chest room included. runFlow's noteShopSpend sets counter=1 on any
    // shop purchase or removal to use it up.
    id: "MAW_BANK",
    name: "Maw Bank",
    tier: "common",
    pool: "shared",
    canSpawn: spawnsOutsideShops,
    hooks: {
      onEnterRoom: (ctx) => {
        if (cnt(ctx).get() === 0) gainGold(ctx, 12);
      },
    },
  },
  {
    // "Whenever you enter a shop, heal 15 HP." MealTicket.justEnteredRoom: the
    // resolved room, so a ? node that rolls a shop counts.
    id: "MEAL_TICKET",
    name: "Meal Ticket",
    tier: "common",
    pool: "shared",
    canSpawn: spawnsUpToFloor(48),
    hooks: {
      justEnteredRoom: (ctx, roomKind) => {
        if (roomKind === "shop") healPlayer(ctx, 15);
      },
    },
  },
  {
    // "Every time you play 10 Attacks, gain 1 Energy." (persistent counter)
    id: "NUNCHAKU",
    name: "Nunchaku",
    tier: "common",
    pool: "shared",
    hooks: {
      onUseCard: (ctx, card) => {
        if (ctx.bundle.cards.get(card.defId)?.type !== "attack") return;
        const c = cnt(ctx).get() + 1;
        if (c >= 10) {
          cnt(ctx).set(0);
          ctx.queue.addToBottom({ kind: "gainEnergy", n: 1 });
        } else {
          cnt(ctx).set(c);
        }
      },
    },
  },
  {
    // "At the start of each combat, gain 1 Dexterity." (corpus-confirmed: Dexterity)
    id: "ODDLY_SMOOTH_STONE",
    name: "Oddly Smooth Stone",
    tier: "common",
    pool: "shared",
    hooks: {
      atBattleStart: (ctx) =>
        ctx.queue.addToBottom({ kind: "applyPower", source: PLAYER, target: PLAYER, powerId: "DEXTERITY", amount: 1 }),
    },
  },
  {
    // "Negate the next 2 Curses you obtain."
    id: "OMAMORI",
    name: "Omamori",
    countsDown: true,
    tier: "common",
    pool: "shared",
    canSpawn: spawnsUpToFloor(48),
    onEquip: (ctx) => {
      const r = ctx.run.relics.find((x) => x.defId === "OMAMORI");
      if (r) r.counter = 2;
    },
    hooks: {
      // ShowCardAndObtainEffect negates before any onObtainCard relic runs
      canObtainCard: (ctx, defId) => {
        if (ctx.bundle.cards.get(defId)?.type === "curse" && cnt(ctx).get() > 0) {
          cnt(ctx).set(cnt(ctx).get() - 1);
          return false; // veto the obtain
        }
      },
    },
  },
  {
    // "If you end your turn without Block, gain 6 Block."
    // Checked before Metallicize/Plated Armor block applies (their gains are
    // still queued), matching the game's stacking behavior.
    id: "ORICHALCUM",
    name: "Orichalcum",
    tier: "common",
    pool: "shared",
    hooks: {
      atEndOfTurnPreEndOfTurnCards: (ctx) => {
        if (ctx.combat!.player.block === 0) {
          ctx.queue.addToBottom({ kind: "gainBlock", target: PLAYER, amount: 6, fromCard: false });
        }
      },
    },
  },
  {
    // "Every 10th Attack you play deals double damage." Persistent counter 0-9;
    // counter==9 arms Pen Nib Power for the next attack, then resets on use.
    id: "PEN_NIB",
    name: "Pen Nib",
    tier: "common",
    pool: "shared",
    hooks: {
      atBattleStart: (ctx) => {
        if (cnt(ctx).get() === 9) {
          ctx.queue.addToBottom({ kind: "applyPower", source: PLAYER, target: PLAYER, powerId: "PEN_NIB", amount: 1 });
        }
      },
      onUseCard: (ctx, card) => {
        if (ctx.bundle.cards.get(card.defId)?.type !== "attack") return;
        const c = cnt(ctx).get() + 1;
        if (c >= 10) {
          cnt(ctx).set(0);
        } else {
          cnt(ctx).set(c);
          if (c === 9) {
            ctx.queue.addToBottom({
              kind: "applyPower",
              source: PLAYER,
              target: PLAYER,
              powerId: "PEN_NIB",
              amount: 1,
            });
          }
        }
      },
    },
  },
  {
    // "Enemies in Elite combats have 25% less HP." PreservedInsect.atBattleStart:
    // runs after the pre-battle setup and the burning-elite max HP buff, and
    // caps current HP at (int)(maxHealth * 0.75f).
    id: "PRESERVED_INSECT",
    name: "Preserved Insect",
    tier: "common",
    pool: "shared",
    canSpawn: spawnsUpToFloor(52),
    hooks: {
      atBattleStart: (ctx) => {
        const isElite = ctx.combat!.monsters.some((m) => ctx.bundle.monsters.get(m.id)?.category === "elite");
        if (!isElite) return;
        for (const m of ctx.combat!.monsters) {
          const cap = Math.trunc(f32mul(m.maxHp, 0.75));
          if (m.hp > cap) m.hp = cap;
        }
      },
    },
  },
  {
    // "Upon pickup, gain 2 Potion slots."
    id: "POTION_BELT",
    name: "Potion Belt",
    tier: "common",
    pool: "shared",
    canSpawn: spawnsUpToFloor(48),
    onEquip: (ctx) => {
      ctx.run.potionSlots += 2;
      ctx.run.potions.push(null, null);
    },
    hooks: {},
  },
  {
    // "Whenever you Rest, heal an additional 15 HP." onRest fires once from applyRest.
    id: "REGAL_PILLOW",
    name: "Regal Pillow",
    tier: "common",
    pool: "shared",
    canSpawn: spawnsUpToFloor(48),
    hooks: { onRest: (ctx) => healPlayer(ctx, 15) },
  },
  {
    // "While your HP is at or below 50%, you have 3 additional Strength."
    // counter is the "currently active" flag (onBloodied refires on every hit while bloodied).
    id: "RED_SKULL",
    name: "Red Skull",
    tier: "common",
    pool: "red",
    hooks: {
      atBattleStart: (ctx) => {
        if (ctx.run.hp <= ctx.run.maxHp / 2) {
          cnt(ctx).set(1);
          ctx.queue.addToBottom({ kind: "applyPower", source: PLAYER, target: PLAYER, powerId: "STRENGTH", amount: 3 });
        } else {
          cnt(ctx).set(0);
        }
      },
      onBloodied: (ctx) => {
        if (cnt(ctx).get() === 0) {
          cnt(ctx).set(1);
          ctx.queue.addToTop({ kind: "applyPower", source: PLAYER, target: PLAYER, powerId: "STRENGTH", amount: 3 });
        }
      },
      onNotBloodied: (ctx) => {
        if (cnt(ctx).get() === 1) {
          cnt(ctx).set(0);
          ctx.queue.addToTop({
            kind: "applyPower",
            source: PLAYER,
            target: PLAYER,
            powerId: "STRENGTH",
            amount: -3,
          });
        }
      },
    },
  },
  {
    // "The merchant's card removal service now always costs 50 Gold."
    // RUN-LAYER: removal pricing is a shop-layer concern (modifyPrice is per-product).
    id: "SMILING_MASK",
    name: "Smiling Mask",
    tier: "common",
    pool: "shared",
    canSpawn: spawnsOutsideShops,
    hooks: {},
  },
  {
    // "Whenever you apply Poison, apply an additional 1 Poison."
    // ENGINE-GAP: the engine does not fire onApplyPower yet, and the hook carries
    // no amount to modify - implemented with a reentrancy flag so it is exact
    // once the call site lands. DEPENDS: POISON power (Silent workstream).
    id: "SNECKO_SKULL",
    name: "Snecko Skull",
    tier: "common",
    pool: "green",
    hooks: {
      onApplyPower: (ctx, powerId, target, source) => {
        if (powerId !== "POISON" || target.kind !== "monster" || source?.kind !== "player") return;
        if (!ctx.bundle.powers.has("POISON")) return;
        if (cnt(ctx).get() === 1) {
          cnt(ctx).set(0); // our own extra application - don't recurse
          return;
        }
        cnt(ctx).set(1);
        ctx.queue.addToTop({ kind: "applyPower", source, target, powerId: "POISON", amount: 1 });
      },
    },
  },
  {
    // "Upon pickup, raise your Max HP by 7." increaseMaxHp(7, true) heals the 7.
    id: "STRAWBERRY",
    name: "Strawberry",
    tier: "common",
    pool: "shared",
    onEquip: (ctx) => increaseMaxHp(ctx, 7),
    hooks: {},
  },
  {
    // "Whenever you would deal 4 or less unblocked Attack damage, increase it to 5."
    // ENGINE-GAP / VERIFY-JAR: Boot.onAttackToChangeDamage is post-block and is
    // called from AbstractMonster.damage, which is missing from the decompile;
    // the monster-side call site and its order are unverified, so no hook here.
    id: "THE_BOOT",
    name: "The Boot",
    tier: "common",
    pool: "shared",
    hooks: {},
  },
  {
    // "Every 4th ? room is a Treasure room." RUN-LAYER (resolveUnknownRoom counts on this relic's counter).
    id: "TINY_CHEST",
    name: "Tiny Chest",
    tier: "common",
    pool: "shared",
    canSpawn: spawnsUpToFloor(35),
    hooks: {},
  },
  {
    // "Whenever you use a potion, heal 5 HP."
    id: "TOY_ORNITHOPTER",
    name: "Toy Ornithopter",
    tier: "common",
    pool: "shared",
    hooks: {
      onUsePotion: (ctx) => {
        if (ctx.combat) ctx.queue.addToBottom({ kind: "heal", target: PLAYER, amount: 5 });
        else healPlayer(ctx, 5);
      },
    },
  },
  {
    // "At the start of each combat, gain 1 Strength."
    id: "VAJRA",
    name: "Vajra",
    tier: "common",
    pool: "shared",
    hooks: {
      atBattleStart: (ctx) =>
        ctx.queue.addToBottom({ kind: "applyPower", source: PLAYER, target: PLAYER, powerId: "STRENGTH", amount: 1 }),
    },
  },
  {
    // "Upon pick up, Upgrade 2 random Skills." WarPaint.onEquip: the
    // upgradeable Skills in deck order, Collections.shuffle'd with a
    // java.util.Random seeded off ONE miscRng.randomLong() (drawn even when
    // there is nothing to upgrade), first two upgraded.
    id: "WAR_PAINT",
    name: "War Paint",
    tier: "common",
    pool: "shared",
    onEquip: (ctx) => upgradeRandomDeckCards(ctx, "skill", 2),
    hooks: {},
  },
  {
    // "Upon pickup, Upgrade 2 random Attacks." Whetstone.onEquip, same draw.
    id: "WHETSTONE",
    name: "Whetstone",
    tier: "common",
    pool: "shared",
    onEquip: (ctx) => upgradeRandomDeckCards(ctx, "attack", 2),
    hooks: {},
  },
];

function upgradeRandomDeckCards(ctx: EffectCtx, type: "attack" | "skill", n: number): void {
  // canUpgrade(): Searing Blow stays upgradeable
  const upgradable = ctx.run.deck
    .map((_, i) => i)
    .filter((i) => canSmith(ctx, i) && ctx.bundle.cards.get(ctx.run.deck[i]!.defId)?.type === type);
  javaShuffle(upgradable, new JavaRandom(ctx.rng("miscRng").randomLong()));
  for (const i of upgradable.slice(0, n)) ctx.run.deck[i]!.upgrades++;
}
