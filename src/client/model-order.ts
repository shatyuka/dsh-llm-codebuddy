/**
 * Model-list arrangement shared by the settings page and the composer model
 * seat: both turn the durable id lists into rows the same way.
 *
 * @module dsh-llm-codebuddy/model-order
 */

/**
 * Arrange catalog models by a persisted id order.
 *
 * Listed ids come first in their listed order; unlisted ones keep the catalog's
 * relative order after them, so a server-side addition appears at the foot
 * until it is moved. A repeated id keeps its first position.
 *
 * @param models - catalog entries in the catalog's own order.
 * @param order - the persisted id order.
 * @returns a new array in the effective display order; the input is untouched.
 */
export function orderModelsById<T extends { readonly id: string }>(
  models: readonly T[],
  order: readonly string[],
): T[] {
  if (order.length === 0) return [...models]
  const rank = new Map<string, number>()
  for (const [index, id] of order.entries()) {
    if (!rank.has(id)) rank.set(id, index)
  }
  // Unlisted models share the trailing rank, so the stable sort keeps their
  // catalog order; listed ones never tie.
  const trailing = order.length
  return [...models].sort((left, right) =>
    (rank.get(left.id) ?? trailing) - (rank.get(right.id) ?? trailing))
}

/**
 * Move one id within an order list by swapping it with its neighbor.
 *
 * @param order - the id list as displayed.
 * @param id - the id being moved.
 * @param delta - how many positions to move; only `-1` and `1` are used.
 * @returns the moved list, unchanged when the id is absent or already at the
 * edge in the move's direction.
 */
export function moveModelId(order: readonly string[], id: string, delta: number): string[] {
  const at = order.indexOf(id)
  const to = at + delta
  if (at < 0 || to < 0 || to >= order.length) return [...order]
  const next = [...order]
  // Both slots exist by the bounds above; the guards only satisfy the
  // checked-index view.
  const moving = next[at]
  const neighbor = next[to]
  if (moving === undefined || neighbor === undefined) return next
  next[to] = moving
  next[at] = neighbor
  return next
}

/**
 * Place one model at an absolute position in an arrangement.
 *
 * The row is removed before re-inserting, so {@link toIndex} counts the other
 * rows only — the same count a drag derives from their midpoints.
 *
 * @param items - the rows in their current order.
 * @param id - the id being placed.
 * @param toIndex - the insertion position among the other rows; clamped.
 * @returns a new array with the row placed; the input is untouched.
 */
export function placeModelAt<T extends { readonly id: string }>(
  items: readonly T[],
  id: string,
  toIndex: number,
): T[] {
  const moving = items.find((item) => item.id === id)
  if (moving === undefined) return [...items]
  const without = items.filter((item) => item.id !== id)
  const at = Math.min(Math.max(toIndex, 0), without.length)
  return [...without.slice(0, at), moving, ...without.slice(at)]
}
