// Named effect continuations for the Ironclad card pool (plus the status/curse
// helpers that ride along in the same bundle slice). Two flavors:
//   - deferred effects: enqueued as {kind:"effect"} so their work happens at the
//     right point in the action queue (random targets roll at resolve time);
//   - choose/resume pairs: the *Choose effect builds a card choice from LIVE
//     pile contents and pauses; the resume receives {...resumeArgs, chosen}
//     where chosen holds indices into the request's iids.
// Single-candidate choices auto-resolve, matching the game's grid screens.

import type { EffectCtx, EffectFn } from "../../../engine/content/defs";
import type { GameAction } from "../../../engine/core/actions";
import type { CardInstance, CardQueueItem } from "../../../engine/combat/combatState";
import type { CardInstanceId } from "../../../engine/core/ids";
import { PLAYER, monster } from "../../../engine/core/ids";
import { calcCardDamage } from "../../../engine/combat/damageCalc";
import { executeAction, exhaustCard, makeTempCard } from "../../../engine/combat/interpreter";
import { HAND_LIMIT, moveCard, reshuffleDiscardIntoDraw } from "../../../engine/combat/piles";
import { applyPower, getPower } from "../../../engine/combat/powerRuntime";
import { foldHook } from "../../../engine/core/hooks";
import { hasRelic } from "../../util";
import { upgradeCostInCombat } from "../../relics/lib";

// ------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------

function aliveMonsters(ctx: EffectCtx) {
  return ctx.combat!.monsters.filter((m) => !m.isDead && !m.isEscaped && !m.halfDead);
}

function randomAliveIdx(ctx: EffectCtx): number | null {
  const alive = aliveMonsters(ctx);
  if (alive.length === 0) return null;
  return alive[ctx.rng("cardRandomRng").random(alive.length - 1)]!.idx;
}

/** Can this card be upgraded mid-combat (Armaments)? Statuses/curses never. */
function canUpgradeInCombat(ctx: EffectCtx, c: CardInstance): boolean {
  const def = ctx.bundle.cards.get(c.defId);
  if (!def) return false;
  if (def.type === "status" || def.type === "curse") return false;
  return c.upgrades === 0 || def.keywords.includes("multiUpgrade");
}

/** In-combat upgrade: bump upgrades; the first one also applies the upgrade cost (upgradeBaseCost). */
function upgradeInCombat(ctx: EffectCtx, c: CardInstance): void {
  const def = ctx.bundle.cards.get(c.defId);
  if (!def) return;
  c.upgrades++;
  if (c.upgrades === 1) upgradeCostInCombat(c, def);
  ctx.emit("cardUpgraded", { iid: c.iid });
}

/** Build a pick-1 choice over candidates; auto-resolves 0/1-candidate cases. */
function chooseOne(
  ctx: EffectCtx,
  iids: CardInstanceId[],
  pile: "hand" | "discard" | "exhaust",
  reason: string,
  resume: string,
  extraArgs: Record<string, unknown>,
  auto: (iid: CardInstanceId) => void,
): void {
  if (iids.length === 0) return;
  if (iids.length === 1) {
    auto(iids[0]!);
    return;
  }
  // ENGINE-NOTE: advance() rebuilds the runtime slot AND the action queue, so
  // pausing mid-resolution would lose rt.currentItem (exhaustOnUse - keyword or
  // Corruption) and drop every queued action behind this effect (the card's
  // trailing actions, onUseCard hook actions, and the terminal __afterCardUsed).
  // Both are plain data: snapshot them into resumeArgs; the resume restores the
  // item, does the choice work, then replays the tail in order.
  const item = ctx.rt.currentItem ? { ...ctx.rt.currentItem } : null;
  const tail: GameAction[] = [];
  for (let a = ctx.queue.pop(); a !== undefined; a = ctx.queue.pop()) tail.push(a);
  ctx.requestChoice({
    request: { kind: "cards", pile, iids, min: 1, max: 1, canCancel: false, reason },
    resume,
    resumeArgs: { ...extraArgs, iids, __item: item, __tail: tail },
  });
}

interface ResumeArgs {
  iids: CardInstanceId[];
  chosen: number[];
  __item?: CardQueueItem | null;
  __tail?: GameAction[];
}

function chosenIid(ctx: EffectCtx, args: unknown): CardInstanceId {
  const { iids, chosen, __item } = args as ResumeArgs;
  if (__item) ctx.rt.currentItem = __item; // see chooseOne
  const iid = iids[chosen[0]!];
  if (iid === undefined) throw new Error("invalid choice index");
  return iid;
}

/** Re-enqueue the actions that were pending behind the pause (see chooseOne). */
function replayTail(ctx: EffectCtx, args: unknown): void {
  for (const a of (args as ResumeArgs).__tail ?? []) ctx.queue.addToBottom(a);
}

// ------------------------------------------------------------------------------
// deferred effects
// ------------------------------------------------------------------------------

/** Juggernaut: X thorns damage to a random enemy, target rolled at resolve time. */
function juggernautHit(ctx: EffectCtx, args: unknown): void {
  const { amount } = args as { amount: number };
  const idx = randomAliveIdx(ctx);
  if (idx === null) return;
  ctx.queue.addToTop({ kind: "damage", target: monster(idx), info: { type: "thorns", source: PLAYER, amount } });
}

/** Sword Boomerang: one hit at a random enemy; per-target calc at resolve time. */
function swordBoomerangHit(ctx: EffectCtx, args: unknown): void {
  const { iid, base } = args as { iid: CardInstanceId; base: number };
  const idx = randomAliveIdx(ctx);
  if (idx === null) return;
  const card = ctx.combat!.cards[iid] ?? null;
  const dmg = calcCardDamage(ctx, card, idx, base);
  ctx.queue.addToTop({ kind: "damage", target: monster(idx), info: { type: "attack", source: PLAYER, amount: dmg } });
}

/**
 * Whirlwind (WhirlwindAction): X hits of the use-time multiDamage, +2 with
 * Chemical X (the game checks the relic inside each X-cost action). The hits
 * are addToBot from the action, so they land after the onUseCard hook actions
 * (Rage block, Sharp Hide) and after the card has gone to the discard pile.
 */
function whirlwind(ctx: EffectCtx, args: unknown): void {
  const { amounts, x } = args as { amounts: number[]; x: number };
  const effect = x + (hasRelic(ctx, "CHEMICAL_X") ? 2 : 0);
  for (let i = 0; i < effect; i++) {
    ctx.queue.addToBottom({ kind: "damageAllMonsters", amounts, info: { type: "attack", source: PLAYER } });
  }
}

/** Fiend Fire: queue all exhausts above all hits, with exhaust hooks able to interleave via addToTop. */
function fiendFire(ctx: EffectCtx, args: unknown): void {
  const { target, dmg, count } = args as { target: number; dmg: number; count: number };
  for (let i = 0; i < count; i++) {
    ctx.queue.addToTop({
      kind: "damage",
      target: monster(target),
      info: { type: "attack", source: PLAYER, amount: dmg },
    });
  }
  for (let i = 0; i < count; i++) {
    ctx.queue.addToTop({ kind: "exhaust", sel: { kind: "random", pile: "hand", n: 1 } });
  }
}

/**
 * ExhaustAction(n, isRandom=true, anyNumber=false) (True Grit): an empty hand
 * does nothing; a hand of n or fewer is exhausted whole, top card first, with
 * no roll; otherwise each pick is hand.getRandomCard(cardRandomRng).
 */
function exhaustRandomFromHand(ctx: EffectCtx, args: unknown): void {
  const { n } = args as { n: number };
  const hand = ctx.combat!.player.piles.hand;
  if (hand.length === 0) return;
  if (hand.length <= n) {
    const count = hand.length;
    for (let i = 0; i < count && hand.length > 0; i++) exhaustCard(ctx, hand[hand.length - 1]!);
    return;
  }
  for (let i = 0; i < n && hand.length > 0; i++) {
    exhaustCard(ctx, hand[ctx.rng("cardRandomRng").random(hand.length - 1)]!);
  }
}

/** ExhaustSpecificCardAction: exhausts the card only if it is still in the hand. */
function exhaustFromHand(ctx: EffectCtx, args: unknown): void {
  const { iid } = args as { iid: CardInstanceId };
  if (ctx.combat!.player.piles.hand.includes(iid)) exhaustCard(ctx, iid);
}

function nonAttacksInHand(ctx: EffectCtx): CardInstanceId[] {
  const combat = ctx.combat!;
  return combat.player.piles.hand.filter((iid) => ctx.bundle.cards.get(combat.cards[iid]!.defId)?.type !== "attack");
}

/**
 * Second Wind (BlockPerNonAttackAction): reads the hand when it resolves, then
 * addToTops one GainBlock per non-Attack and, above them, one exhaust per card
 * in hand order - so every exhaust (last card first) resolves before any block.
 */
function secondWind(ctx: EffectCtx, args: unknown): void {
  const { block } = args as { block: number };
  const cards = nonAttacksInHand(ctx);
  for (let i = 0; i < cards.length; i++) {
    ctx.queue.addToTop({ kind: "gainBlock", target: PLAYER, amount: block, fromCard: true });
  }
  for (const iid of cards) ctx.queue.addToTop({ kind: "effect", ref: "ironclad/exhaustFromHand", args: { iid } });
}

/** Sever Soul (ExhaustAllNonAttackAction): addToTop per card, so the last card exhausts first. */
function exhaustAllNonAttack(ctx: EffectCtx): void {
  for (const iid of nonAttacksInHand(ctx)) {
    ctx.queue.addToTop({ kind: "effect", ref: "ironclad/exhaustFromHand", args: { iid } });
  }
}

/**
 * Spot Weakness (SpotWeaknessAction): the intent is read when the action
 * resolves and the Strength is addToBot, behind the card's own resolution.
 */
function spotWeakness(ctx: EffectCtx, args: unknown): void {
  const { idx, amount } = args as { idx: number; amount: number };
  const m = ctx.combat!.monsters[idx];
  if (!m || m.isDead || m.isEscaped || !m.move) return;
  const intent = ctx.bundle.monsters.get(m.id)?.moves[m.move]?.intent;
  if (intent && intent.startsWith("attack")) {
    ctx.queue.addToBottom({ kind: "applyPower", source: PLAYER, target: PLAYER, powerId: "STRENGTH", amount });
  }
}

/**
 * Reaper (VampireDamageAllEnemiesAction): AoE damage, then heal the HP the
 * enemies actually lost. The heal is a queued HealAction (addToBot), so it
 * takes the normal heal path (Magic Flower, Red Skull's onNotBloodied) and
 * still lands after a combat-ending sweep (clearPostCombatActions keeps it).
 */
function reaperAttack(ctx: EffectCtx, args: unknown): void {
  const { amounts } = args as { amounts: number[] };
  const before = ctx.combat!.monsters.map((m) => m.hp);
  executeAction(ctx, { kind: "damageAllMonsters", amounts, info: { type: "attack", source: PLAYER } });
  let heal = 0;
  ctx.combat!.monsters.forEach((m, i) => {
    heal += Math.max(0, (before[i] ?? m.hp) - m.hp);
  });
  if (heal > 0) ctx.queue.addToBottom({ kind: "heal", target: PLAYER, amount: heal });
}

/**
 * Feed (FeedAction): damage, then on a fatal hit on a non-Minion raise max HP
 * and heal inside the same action (increaseMaxHp -> heal: heal folds and Red
 * Skull's onNotBloodied apply). The game checks hasPower("Minion"), so Gremlin
 * Leader's gremlins give nothing even though their monster def is "normal".
 */
function feedAttack(ctx: EffectCtx, args: unknown): void {
  const { idx, dmg, bonus } = args as { idx: number; dmg: number; bonus: number };
  executeAction(ctx, { kind: "damage", target: monster(idx), info: { type: "attack", source: PLAYER, amount: dmg } });
  const m = ctx.combat!.monsters[idx];
  if (!m || !m.isDead || m.halfDead) return;
  if (m.powers.some((p) => p.id === "MINION")) return;
  ctx.run.maxHp += bonus;
  executeAction(ctx, { kind: "heal", target: PLAYER, amount: bonus });
}

/** Combust: each play adds 1 to the end-of-turn HP loss (power data counter). */
function combustStack(ctx: EffectCtx): void {
  const p = getPower(ctx, PLAYER, "COMBUST");
  if (!p) return;
  const prev = (p.data?.hpLoss as number | undefined) ?? 0;
  p.data = { hpLoss: prev + 1 };
}

/**
 * Rampage (ModifyDamageAction): grow every in-battle instance with this uuid
 * (GetAllInBattleInstances: the piles plus the card in use, which sits in
 * limbo here).
 */
function rampageGrow(ctx: EffectCtx, args: unknown): void {
  const { uuid, amount } = args as { uuid: number; amount: number };
  const combat = ctx.combat!;
  for (const pile of Object.values(combat.player.piles)) {
    for (const iid of pile) {
      const c = combat.cards[iid];
      if (c && (c.uuid ?? c.iid) === uuid) c.misc += amount;
    }
  }
}

/**
 * Havoc (PlayTopCardAction): play the top card of the draw pile against the
 * target Havoc rolled at use, free, and exhaust it. An empty draw pile is
 * reshuffled first; a card that fails canUse is exhausted unplayed (see
 * resolveCardPlay).
 */
function havocPlayTop(ctx: EffectCtx, args: unknown): void {
  const { target } = args as { target: number | null };
  const combat = ctx.combat!;
  const piles = combat.player.piles;
  if (piles.draw.length === 0) {
    if (piles.discard.length === 0) return;
    reshuffleDiscardIntoDraw(ctx); // PlayTopCardAction reshuffles an empty draw pile
    if (piles.draw.length === 0) return;
  }
  // ENGINE-NOTE: with no living target (all enemies half-dead) the game still
  // queues the card with a null monster; this engine leaves it in the pile.
  if (target === null) return;
  const iid = piles.draw[0]!;
  moveCard(ctx, iid, "limbo");
  combat.cardQueue.unshift({
    iid,
    target,
    energyOnUse: combat.player.energy,
    ignoreEnergyTotal: true,
    regardlessOfCost: true,
    purgeOnUse: false,
    exhaustOnUse: true, // "and Exhaust it" (powers still vanish per engine rules)
    autoplayed: true,
    via: "HAVOC",
  });
}

// ------------------------------------------------------------------------------
// choose/resume pairs
// ------------------------------------------------------------------------------

/** Armaments: upgraded -> upgrade every upgradable card in hand; base -> pick 1. */
function armamentsChoose(ctx: EffectCtx, args: unknown): void {
  const { all } = args as { all: boolean };
  const combat = ctx.combat!;
  const candidates = combat.player.piles.hand.filter((iid) => canUpgradeInCombat(ctx, combat.cards[iid]!));
  if (all) {
    for (const iid of candidates) upgradeInCombat(ctx, combat.cards[iid]!);
    return;
  }
  chooseOne(ctx, candidates, "hand", "Armaments: upgrade a card", "ironclad/armaments", {}, (iid) =>
    upgradeInCombat(ctx, combat.cards[iid]!),
  );
}

function armamentsResume(ctx: EffectCtx, args: unknown): void {
  const pick = chosenIid(ctx, args);
  upgradeInCombat(ctx, ctx.combat!.cards[pick]!);
  handAfterSelect(ctx, (args as ResumeArgs).iids, pick, true);
  replayTail(ctx, args);
}

/** Headbutt: put a discard-pile card on top of the draw pile. */
function headbuttChoose(ctx: EffectCtx): void {
  const discard = [...ctx.combat!.player.piles.discard];
  chooseOne(ctx, discard, "discard", "Headbutt: put a card on top of your draw pile", "ironclad/headbutt", {}, (iid) =>
    moveCard(ctx, iid, "draw", "top"),
  );
}

function headbuttResume(ctx: EffectCtx, args: unknown): void {
  moveCard(ctx, chosenIid(ctx, args), "draw", "top");
  replayTail(ctx, args);
}

/** Exhume: return an exhausted card (never another Exhume) to your hand. */
function exhumeChoose(ctx: EffectCtx): void {
  const combat = ctx.combat!;
  // ExhumeAction does nothing into a full hand (reachable when Havoc plays it)
  if (combat.player.piles.hand.length >= HAND_LIMIT) return;
  const candidates = combat.player.piles.exhaust.filter((iid) => combat.cards[iid]!.defId !== "EXHUME");
  chooseOne(ctx, candidates, "exhaust", "Exhume: return a card to your hand", "ironclad/exhume", {}, (iid) =>
    moveCard(ctx, iid, "hand"),
  );
}

function exhumeResume(ctx: EffectCtx, args: unknown): void {
  moveCard(ctx, chosenIid(ctx, args), "hand");
  replayTail(ctx, args);
}

/** What makeStatEquivalentCopy carries over (the copy gets a fresh identity). */
interface StatCopy {
  defId: string;
  upgrades: number;
  cost: number;
  costForTurn: number;
  freeToPlayOnce: boolean;
  misc: number;
}

function statsOf(c: CardInstance): StatCopy {
  return {
    defId: c.defId,
    upgrades: c.upgrades,
    cost: c.cost,
    costForTurn: c.costForTurn,
    freeToPlayOnce: c.freeToPlayOnce,
    misc: c.misc,
  };
}

/**
 * MakeTempCardInHandAction(card.makeStatEquivalentCopy()): same upgrades,
 * cost, cost this turn, misc (Rampage growth) and freeToPlayOnce; Master
 * Reality may upgrade it (upgradeBaseCost rules); a full hand sends it to the
 * discard pile.
 */
function makeStatCopyInHand(ctx: EffectCtx, args: unknown): void {
  const src = args as StatCopy;
  const combat = ctx.combat!;
  const def = ctx.bundle.cards.get(src.defId);
  if (!def) return;
  const iid = combat.nextCardInstanceId++;
  const c: CardInstance = { ...src, iid, masterIdx: null, retainOnce: false };
  combat.cards[iid] = c;
  const upgrades = Math.floor(foldHook(ctx, PLAYER, "modifyCreatedCardUpgrades", c.upgrades, c.defId));
  if (upgrades > c.upgrades) {
    c.upgrades = upgrades;
    if (src.upgrades === 0) upgradeCostInCombat(c, def);
  }
  const dest = combat.player.piles.hand.length >= HAND_LIMIT ? "discard" : "hand";
  combat.player.piles[dest].push(iid);
  ctx.emit("cardCreated", { iid, defId: c.defId, dest });
}

/**
 * Hand order after the game's hand-select pattern (Armaments, Dual Wield): the
 * ineligible cards are pulled out (removeAll) and the pick leaves for the
 * select screen; afterwards the pick (when it comes back) and then the held
 * cards are appended, so the hand ends [other candidates, pick, ineligible].
 */
function handAfterSelect(ctx: EffectCtx, eligible: CardInstanceId[], pick: CardInstanceId, pickReturns: boolean): void {
  const hand = ctx.combat!.player.piles.hand;
  const ok = new Set(eligible);
  const order = [
    ...hand.filter((iid) => ok.has(iid) && iid !== pick),
    ...(pickReturns && hand.includes(pick) ? [pick] : []),
    ...hand.filter((iid) => !ok.has(iid)),
  ];
  hand.splice(0, hand.length, ...order);
}

/** Dual Wield: copy a chosen Attack or Power card into your hand (1 or 2 copies). */
function dualWieldChoose(ctx: EffectCtx, args: unknown): void {
  const { copies } = args as { copies: number };
  const combat = ctx.combat!;
  const candidates = combat.player.piles.hand.filter((iid) => {
    const t = ctx.bundle.cards.get(combat.cards[iid]!.defId)?.type;
    return t === "attack" || t === "power";
  });
  // a lone candidate stays in hand and just gets its copies
  chooseOne(ctx, candidates, "hand", "Dual Wield: choose an Attack or Power", "ironclad/dualWield", { copies }, (iid) =>
    queueStatCopies(ctx, statsOf(combat.cards[iid]!), copies),
  );
}

function queueStatCopies(ctx: EffectCtx, stats: StatCopy, n: number): void {
  for (let i = 0; i < n; i++) ctx.queue.addToTop({ kind: "effect", ref: "ironclad/makeStatCopy", args: stats });
}

/**
 * DualWieldAction after a pick: the picked card is not handed back. A stat
 * copy of it plus the copies are queued (addToTop), behind the held non-Attack
 * and non-Power cards that return to the hand first.
 */
function dualWieldResume(ctx: EffectCtx, args: unknown): void {
  const { copies, iids } = args as { copies: number; iids: CardInstanceId[] };
  const pick = chosenIid(ctx, args);
  const combat = ctx.combat!;
  const stats = statsOf(combat.cards[pick]!);
  handAfterSelect(ctx, iids, pick, false);
  delete combat.cards[pick];
  queueStatCopies(ctx, stats, copies + 1);
  replayTail(ctx, args);
}

/** Warcry (PutOnDeckAction, amount 1): after drawing, put a hand card on top of the draw pile. */
function warcryChoose(ctx: EffectCtx): void {
  const hand = [...ctx.combat!.player.piles.hand];
  if (hand.length === 1) {
    // hand.size() <= amount: the action moves hand.getRandomCard(cardRandomRng)
    // instead of opening the grid, so the lone card still costs a roll
    moveCard(ctx, hand[ctx.rng("cardRandomRng").random(hand.length - 1)]!, "draw", "top");
    return;
  }
  chooseOne(ctx, hand, "hand", "Warcry: put a card on top of your draw pile", "ironclad/warcry", {}, (iid) =>
    moveCard(ctx, iid, "draw", "top"),
  );
}

function warcryResume(ctx: EffectCtx, args: unknown): void {
  moveCard(ctx, chosenIid(ctx, args), "draw", "top");
  replayTail(ctx, args);
}

/** True Grit (upgraded): exhaust a chosen card in hand. */
function trueGritChoose(ctx: EffectCtx): void {
  const hand = [...ctx.combat!.player.piles.hand];
  chooseOne(ctx, hand, "hand", "True Grit: exhaust a card", "ironclad/trueGrit", {}, (iid) => exhaustCard(ctx, iid));
}

function trueGritResume(ctx: EffectCtx, args: unknown): void {
  exhaustCard(ctx, chosenIid(ctx, args));
  replayTail(ctx, args);
}

/** Burning Pact: exhaust a chosen card (the queued draw resolves afterwards). */
function burningPactChoose(ctx: EffectCtx): void {
  const hand = [...ctx.combat!.player.piles.hand];
  chooseOne(ctx, hand, "hand", "Burning Pact: exhaust a card", "ironclad/burningPact", {}, (iid) =>
    exhaustCard(ctx, iid),
  );
}

function burningPactResume(ctx: EffectCtx, args: unknown): void {
  exhaustCard(ctx, chosenIid(ctx, args));
  replayTail(ctx, args);
}

// ------------------------------------------------------------------------------
// status/curse helpers
// ------------------------------------------------------------------------------

/** Pride: put a copy of itself on TOP of the draw pile (not shuffled in). */
function prideCopy(ctx: EffectCtx, args: unknown): void {
  const { upgrades } = args as { upgrades: number };
  const combat = ctx.combat!;
  const iid = combat.nextCardInstanceId;
  makeTempCard(ctx, "PRIDE", upgrades, "limbo");
  moveCard(ctx, iid, "draw", "top");
}

/**
 * Doubt/Shame: end-of-turn self-debuff. The game passes isSourceMonster=true so
 * the first end-of-round tick is skipped; our applyPower derives justApplied
 * from an actual monster source, so set it explicitly on fresh applications.
 */
function endTurnDebuff(ctx: EffectCtx, args: unknown): void {
  const { powerId, amount } = args as { powerId: string; amount: number };
  const had = getPower(ctx, PLAYER, powerId) !== undefined;
  applyPower(ctx, PLAYER, PLAYER, powerId, amount);
  if (!had) {
    const p = getPower(ctx, PLAYER, powerId);
    if (p) p.justApplied = true;
  }
}

// ------------------------------------------------------------------------------

export const ironcladEffects: Map<string, EffectFn> = new Map<string, EffectFn>([
  ["ironclad/juggernautHit", juggernautHit],
  ["ironclad/swordBoomerangHit", swordBoomerangHit],
  ["ironclad/whirlwind", whirlwind],
  ["ironclad/exhaustRandom", exhaustRandomFromHand],
  ["ironclad/exhaustFromHand", exhaustFromHand],
  ["ironclad/secondWind", secondWind],
  ["ironclad/exhaustAllNonAttack", exhaustAllNonAttack],
  ["ironclad/spotWeakness", spotWeakness],
  ["ironclad/fiendFire", fiendFire],
  ["ironclad/reaper", reaperAttack],
  ["ironclad/feed", feedAttack],
  ["ironclad/combustStack", combustStack],
  ["ironclad/rampageGrow", rampageGrow],
  ["ironclad/havoc", havocPlayTop],
  ["ironclad/armamentsChoose", armamentsChoose],
  ["ironclad/armaments", armamentsResume],
  ["ironclad/headbuttChoose", headbuttChoose],
  ["ironclad/headbutt", headbuttResume],
  ["ironclad/exhumeChoose", exhumeChoose],
  ["ironclad/exhume", exhumeResume],
  ["ironclad/dualWieldChoose", dualWieldChoose],
  ["ironclad/dualWield", dualWieldResume],
  ["ironclad/makeStatCopy", makeStatCopyInHand],
  ["ironclad/warcryChoose", warcryChoose],
  ["ironclad/warcry", warcryResume],
  ["ironclad/trueGritChoose", trueGritChoose],
  ["ironclad/trueGrit", trueGritResume],
  ["ironclad/burningPactChoose", burningPactChoose],
  ["ironclad/burningPact", burningPactResume],
  ["ironclad/prideCopy", prideCopy],
  ["ironclad/endTurnDebuff", endTurnDebuff],
]);
