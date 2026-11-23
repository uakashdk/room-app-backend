import { randomInt } from 'crypto';

/**
 * Lucky gifts: every gift paid for a lucky gift is a draw. The sender can win coins back, nothing, or a little.
 * The draw happens on the server only (never in the app), with a secure random number.
 *
 * A tier is "multiplier x gift price" with a weight. The chance of a tier = its weight / the sum of all weights.
 * Example with the default table: a 10 coin gift gives back 0 coins (50%), 5 coins (25%), 10 coins (12%), 25 coins (7%),
 * 50 coins (3.5%), 100 coins (2%) or 250 coins (0.5%).
 * The admin can change the table without a new release in the document app_settings/lucky_gift (see scripts/seed-lucky.ts).
 * "Return to player" = how much of the spent coins comes back on average. The default table is 92%.
 */
export type LuckyTier = { multiplier: number; weight: number };

export const DEFAULT_LUCKY_TIERS: LuckyTier[] = [
  { multiplier: 0, weight: 5000 },
  { multiplier: 0.5, weight: 2500 },
  { multiplier: 1, weight: 1200 },
  { multiplier: 2.5, weight: 700 },
  { multiplier: 5, weight: 350 },
  { multiplier: 10, weight: 200 },
  { multiplier: 25, weight: 50 },
];

/** Takes the table from the database; a broken or empty table falls back to the default one, so a bad edit can never break gifting. */
export function normalizeTiers(raw: unknown): LuckyTier[] {
  if (!Array.isArray(raw)) return DEFAULT_LUCKY_TIERS;
  const tiers = raw
    .map((t: any) => ({ multiplier: Number(t?.multiplier), weight: Math.round(Number(t?.weight)) }))
    .filter((t) => Number.isFinite(t.multiplier) && t.multiplier >= 0 && t.multiplier <= 1000 && Number.isInteger(t.weight) && t.weight > 0);
  return tiers.length > 0 ? tiers : DEFAULT_LUCKY_TIERS;
}

/** The average share of the spent coins that comes back (1 = 100%). */
export const returnToPlayer = (tiers: LuckyTier[]): number => {
  const total = tiers.reduce((s, t) => s + t.weight, 0);
  return tiers.reduce((s, t) => s + t.multiplier * t.weight, 0) / total;
};

/** One draw per gift sent: a combo of 10 gifts is 10 separate draws. */
export function drawLucky(unitPrice: number, count: number, tiers: LuckyTier[]): { reward: number; best: number } {
  const total = tiers.reduce((s, t) => s + t.weight, 0);
  let reward = 0;
  let best = 0;
  for (let i = 0; i < count; i++) {
    let r = randomInt(0, total);
    const tier = tiers.find((t) => (r -= t.weight) < 0) ?? tiers[0];
    reward += Math.floor(unitPrice * tier.multiplier);
    best = Math.max(best, tier.multiplier);
  }
  return { reward, best };
}
