import { describe, expect, it } from 'vitest'
import { moveModelId, orderModelsById, placeModelAt } from '../../src/client/model-order.js'

/** A catalog-like row list. */
function models(...ids: string[]): { id: string }[] {
  return ids.map(id => ({ id }))
}

function ids(rows: readonly { id: string }[]): string[] {
  return rows.map(row => row.id)
}

describe('orderModelsById', () => {
  it('places listed ids first in their listed order', () => {
    expect(ids(orderModelsById(models('a', 'b', 'c'), ['c', 'a']))).toEqual(['c', 'a', 'b'])
  })

  it('keeps unlisted ids in catalog order after the listed ones', () => {
    // A server-side addition appears at the foot until it is moved.
    expect(ids(orderModelsById(models('a', 'b', 'c', 'd'), ['c']))).toEqual(['c', 'a', 'b', 'd'])
  })

  it('returns the catalog order for an empty override', () => {
    expect(ids(orderModelsById(models('a', 'b', 'c'), []))).toEqual(['a', 'b', 'c'])
  })

  it('keeps the first position of a repeated id', () => {
    expect(ids(orderModelsById(models('a', 'b', 'c'), ['c', 'c', 'a']))).toEqual(['c', 'a', 'b'])
  })

  it('ranks a duplicated id by its first occurrence, not its last', () => {
    // A later duplicate must not outrank an id that was legitimately listed
    // between the two occurrences.
    expect(ids(orderModelsById(models('a', 'b'), ['a', 'b', 'a'])))
      .toEqual(['a', 'b'])
    expect(ids(orderModelsById(models('a', 'b', 'c'), ['b', 'c', 'b'])))
      .toEqual(['b', 'c', 'a'])
  })

  it('orders the models even when the override names none of them', () => {
    // An override that lists only unknown ids leaves every model unlisted, so
    // the catalog order must survive intact.
    expect(ids(orderModelsById(models('a', 'b'), ['gone', 'also-gone']))).toEqual(['a', 'b'])
  })

  it('ignores an id the catalog no longer lists', () => {
    expect(ids(orderModelsById(models('a', 'b'), ['gone', 'b']))).toEqual(['b', 'a'])
  })

  it('does not mutate the input array or its rows', () => {
    const input = models('a', 'b', 'c')
    const output = orderModelsById(input, ['c'])
    expect(ids(input)).toEqual(['a', 'b', 'c'])
    expect(output).not.toBe(input)
    // Sorting the copy must reuse the same row objects, not clone them.
    expect(output[0]).toBe(input[2])
  })
})

describe('moveModelId', () => {
  it('swaps an id with its neighbor', () => {
    expect(moveModelId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveModelId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
  })

  it('returns the list unchanged at an edge in the move direction', () => {
    expect(moveModelId(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
    expect(moveModelId(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
  })

  it('returns the list unchanged for an absent id', () => {
    expect(moveModelId(['a', 'b'], 'zz', 1)).toEqual(['a', 'b'])
  })

  it('returns a new array even when nothing moved', () => {
    // The caller treats the result as a fresh snapshot either way.
    const input = ['a', 'b']
    const output = moveModelId(input, 'a', -1)
    expect(output).not.toBe(input)
    expect(output).toEqual(input)
  })

  it('never mutates the input list', () => {
    const input = ['a', 'b', 'c']
    moveModelId(input, 'a', 1)
    expect(input).toEqual(['a', 'b', 'c'])
  })
})

describe('placeModelAt', () => {
  it('places a row at an absolute position among the other rows', () => {
    expect(ids(placeModelAt(models('a', 'b', 'c'), 'a', 2))).toEqual(['b', 'c', 'a'])
    expect(ids(placeModelAt(models('a', 'b', 'c'), 'c', 0))).toEqual(['c', 'a', 'b'])
  })

  it('counts the target position over the other rows only', () => {
    // Index 1 with `a` removed is "after b", not "the second slot overall".
    expect(ids(placeModelAt(models('a', 'b', 'c'), 'a', 1))).toEqual(['b', 'a', 'c'])
    expect(ids(placeModelAt(models('a', 'b', 'c'), 'b', 1))).toEqual(['a', 'b', 'c'])
  })

  it('clamps an out-of-range target', () => {
    expect(ids(placeModelAt(models('a', 'b'), 'a', 99))).toEqual(['b', 'a'])
    expect(ids(placeModelAt(models('a', 'b'), 'b', -99))).toEqual(['b', 'a'])
  })

  it('returns the input order for an absent id', () => {
    expect(ids(placeModelAt(models('a', 'b'), 'zz', 0))).toEqual(['a', 'b'])
  })

  it('does not mutate the input array', () => {
    const input = models('a', 'b', 'c')
    placeModelAt(input, 'a', 2)
    expect(ids(input)).toEqual(['a', 'b', 'c'])
  })

  it('keeps the moved row object by identity', () => {
    const input = models('a', 'b')
    const output = placeModelAt(input, 'a', 1)
    expect(output[1]).toBe(input[0])
  })
})
