/**
 * Quota arithmetic shared by the Host meter and the Web client, so both halves
 * read a used/limit pair the same way.
 *
 * @module dsh-llm-codebuddy/quota
 */

/**
 * Used as a percentage of the limit, clamped to [0, 100].
 *
 * A zero limit is a real budget, not a missing one, so it must not fall through
 * to "unknown": it has no headroom and therefore always reads 100%.
 * @param used - the amount consumed.
 * @param limit - the budget it was consumed from.
 * @returns the percentage, always a number.
 */
export function usedPercent(used: number, limit: number): number {
  if (limit > 0) return Math.min(Math.max((used / limit) * 100, 0), 100)
  return 100
}
