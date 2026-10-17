import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createCodeBuddyPrefs } from '../../src/client/prefs.js'
import type { CodeBuddySettings } from '../../src/settings.js'
import {
  CUSTOM_LIMIT_FIELD,
  CUSTOM_LIMIT_UNIT_FIELD,
  DANGER_PCT_FIELD,
  HIDDEN_MODELS_FIELD,
  MODEL_ORDER_FIELD,
  SHOW_USAGE_FIELD,
} from '../../src/settings.js'

/** One queued write the fake form received. */
interface Write {
  op: 'set' | 'unset' | 'mutate'
  field?: string
  value?: unknown
  ops?: unknown
}

/**
 * A config-form double.
 *
 * It exposes the same synchronous snapshot/subscription contract the real
 * `ConfigForm` does, records writes instead of crossing the wire, and lets a
 * test publish a new Host snapshot the way the mirror would.
 */
function formOf(options: {
  initial?: Partial<CodeBuddySettings>
  status?: ConfigFormSnapshot<CodeBuddySettings>['status']
  writable?: boolean
  /** Resolve a write with this value instead of true. */
  writeResult?: boolean
  /** Reject writes with this error. */
  writeError?: Error
} = {}) {
  let snapshot: ConfigFormSnapshot<CodeBuddySettings> = {
    status: options.status ?? 'ready',
    value: options.initial as CodeBuddySettings | undefined,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: options.writable ?? true,
  }
  const listeners = new Set<() => void>()
  const writes: Write[] = []

  const settle = async <T,>(value: T): Promise<T> => {
    if (options.writeError !== undefined) throw options.writeError
    return value
  }

  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async (field: string, value: unknown) => {
      writes.push({ op: 'set', field, value })
      return settle(options.writeResult ?? true)
    },
    unset: async (field: string) => {
      writes.push({ op: 'unset', field })
      return settle(options.writeResult ?? true)
    },
    mutate: async (ops: unknown) => {
      writes.push({ op: 'mutate', ops })
      return settle(options.writeResult ?? true)
    },
  }

  return {
    form: form as unknown as ConfigForm<CodeBuddySettings>,
    writes,
    /** Publish a new snapshot, as the settings mirror would. */
    publish: (next: Partial<ConfigFormSnapshot<CodeBuddySettings>>) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

/** Let the write's promise chain settle. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('initial snapshot', () => {
  it('falls back to the defaults before the Host answers', () => {
    const { form } = formOf({ status: 'loading' })
    expect(createCodeBuddyPrefs(form).getSnapshot()).toMatchObject({
      showUsage: true,
      customLimitUnit: 'credit',
      dangerPct: 90,
      modelOrder: [],
      hiddenModels: [],
    })
  })

  it('adopts the stored section when one is already present', () => {
    const { form } = formOf({ initial: {
      showUsage: false,
      customLimit: 500,
      customLimitUnit: 'cny',
      dangerPct: 75,
      modelOrder: ['b', 'a'],
      hiddenModels: ['x'],
    } })
    expect(createCodeBuddyPrefs(form).getSnapshot()).toEqual({
      showUsage: false,
      customLimit: 500,
      customLimitUnit: 'cny',
      dangerPct: 75,
      modelOrder: ['b', 'a'],
      hiddenModels: ['x'],
    })
  })

  it('hands out distinct snapshot objects, never one shared mutable value', () => {
    const first = createCodeBuddyPrefs(formOf({ status: 'loading' }).form).getSnapshot()
    const second = createCodeBuddyPrefs(formOf({ status: 'loading' }).form).getSnapshot()
    expect(first).not.toBe(second)
    expect(first.modelOrder).not.toBe(second.modelOrder)
  })
})

describe('normalizing a hand-edited document', () => {
  it('defaults a non-boolean showUsage', () => {
    const { form } = formOf({ initial: { showUsage: 'yes' as never } })
    expect(createCodeBuddyPrefs(form).getSnapshot().showUsage).toBe(true)
  })

  it('falls back to credits for an unknown unit', () => {
    const { form } = formOf({ initial: { customLimitUnit: 'eur' as never } })
    expect(createCodeBuddyPrefs(form).getSnapshot().customLimitUnit).toBe('credit')
  })

  it('drops an out-of-range or non-finite danger threshold', () => {
    for (const dangerPct of [0, 101, -5, Number.NaN, Number.POSITIVE_INFINITY, '90' as never]) {
      const { form } = formOf({ initial: { dangerPct: dangerPct as never } })
      expect(createCodeBuddyPrefs(form).getSnapshot().dangerPct, String(dangerPct)).toBe(90)
    }
  })

  it('keeps an in-range danger threshold, including both bounds', () => {
    for (const dangerPct of [1, 50, 100]) {
      const { form } = formOf({ initial: { dangerPct } })
      expect(createCodeBuddyPrefs(form).getSnapshot().dangerPct).toBe(dangerPct)
    }
  })

  it('drops a negative or non-finite custom cap, keeping "follow the meter"', () => {
    for (const customLimit of [-1, Number.NaN, Number.POSITIVE_INFINITY, '10' as never]) {
      const { form } = formOf({ initial: { customLimit: customLimit as never } })
      expect(createCodeBuddyPrefs(form).getSnapshot(), String(customLimit)).not.toHaveProperty('customLimit')
    }
  })

  it('keeps a zero custom cap, which is a real budget of zero', () => {
    const { form } = formOf({ initial: { customLimit: 0 } })
    expect(createCodeBuddyPrefs(form).getSnapshot().customLimit).toBe(0)
  })

  it('drops non-string list entries instead of defaulting the whole list', () => {
    // One bad id must not lose the arrangement around it.
    const { form } = formOf({ initial: { modelOrder: ['a', 2, 'b', null] as never, hiddenModels: 'nope' as never } })
    const prefs = createCodeBuddyPrefs(form)
    expect(prefs.getSnapshot().modelOrder).toEqual(['a', 'b'])
    expect(prefs.getSnapshot().hiddenModels).toEqual([])
  })
})

describe('optimistic writes', () => {
  it('publishes a change before the Host answers', async () => {
    const { form, writes } = formOf({ initial: { showUsage: true } })
    const prefs = createCodeBuddyPrefs(form)
    const listener = vi.fn()
    prefs.subscribe(listener)

    prefs.setShowUsage(false)
    expect(prefs.getSnapshot().showUsage).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([{ op: 'set', field: SHOW_USAGE_FIELD, value: false }])
    await flush()
  })

  it('skips the publish when the value did not change', async () => {
    const { form, writes } = formOf({ initial: { showUsage: true } })
    const prefs = createCodeBuddyPrefs(form)
    const listener = vi.fn()
    prefs.subscribe(listener)

    prefs.setShowUsage(true)
    expect(listener).not.toHaveBeenCalled()
    await flush()
    // The redundant round-trip is still skipped for the unit setter, which
    // checks before queueing; the boolean setter relies on `publish`.
    expect(writes).toEqual([{ op: 'set', field: SHOW_USAGE_FIELD, value: true }])
  })

  it('adopts the Host value after the write settles, healing a refusal', async () => {
    const { form } = formOf({ initial: { showUsage: true } })
    const prefs = createCodeBuddyPrefs(form)

    prefs.setShowUsage(false)
    expect(prefs.getSnapshot().showUsage).toBe(false)

    // The Host refused, so its snapshot still says true.
    await flush()
    expect(prefs.getSnapshot().showUsage).toBe(true)
  })

  it('adopts the Host value when the write rejects at the transport', async () => {
    const { form } = formOf({ initial: { showUsage: true }, writeError: new Error('offline') })
    const prefs = createCodeBuddyPrefs(form)
    prefs.setShowUsage(false)
    await flush()
    expect(prefs.getSnapshot().showUsage).toBe(true)
  })

  it('clears the custom cap by unsetting the field, so "follow the meter" is expressible', async () => {
    const { form, writes } = formOf({ initial: { customLimit: 250 } })
    const prefs = createCodeBuddyPrefs(form)
    expect(prefs.getSnapshot().customLimit).toBe(250)

    prefs.setCustomLimit(undefined)
    // Key absence, not an explicit `undefined`: `exactOptionalPropertyTypes`
    // distinguishes them and the serializer spreads on presence.
    expect(prefs.getSnapshot()).not.toHaveProperty('customLimit')
    expect(writes[0]).toEqual({ op: 'unset', field: CUSTOM_LIMIT_FIELD })
    await flush()
  })

  it('sets a custom cap, including zero', async () => {
    const { form, writes } = formOf({ initial: {} })
    const prefs = createCodeBuddyPrefs(form)

    prefs.setCustomLimit(0)
    expect(prefs.getSnapshot().customLimit).toBe(0)
    expect(writes[0]).toEqual({ op: 'set', field: CUSTOM_LIMIT_FIELD, value: 0 })
    await flush()
  })

  it('re-renders the same credit figure when only the unit changes', async () => {
    // The stored cap stays in credits; switching units must not rescale it.
    const { form, writes } = formOf({ initial: { customLimit: 100, customLimitUnit: 'credit' } })
    const prefs = createCodeBuddyPrefs(form)

    prefs.setCustomLimitUnit('usd')
    expect(prefs.getSnapshot().customLimit).toBe(100)
    expect(prefs.getSnapshot().customLimitUnit).toBe('usd')
    expect(writes[0]).toEqual({ op: 'set', field: CUSTOM_LIMIT_UNIT_FIELD, value: 'usd' })
    await flush()
  })

  it('skips the round-trip when the unit is unchanged', async () => {
    const { form, writes } = formOf({ initial: { customLimitUnit: 'usd' } })
    const prefs = createCodeBuddyPrefs(form)
    prefs.setCustomLimitUnit('usd')
    expect(writes).toEqual([])
    await flush()
  })

  it('restores the default danger threshold when cleared', async () => {
    const { form, writes } = formOf({ initial: { dangerPct: 50 } })
    const prefs = createCodeBuddyPrefs(form)

    prefs.setDangerPct(undefined)
    expect(prefs.getSnapshot().dangerPct).toBe(90)
    expect(writes[0]).toEqual({ op: 'unset', field: DANGER_PCT_FIELD })
    await flush()
  })

  it('writes a new model order and hides a new hidden set', async () => {
    const { form, writes } = formOf({ initial: { modelOrder: ['a'] } })
    const prefs = createCodeBuddyPrefs(form)

    prefs.setModelOrder(['b', 'a'])
    prefs.setHiddenModels(['x'])
    expect(prefs.getSnapshot().modelOrder).toEqual(['b', 'a'])
    expect(prefs.getSnapshot().hiddenModels).toEqual(['x'])
    expect(writes[0]).toEqual({ op: 'set', field: MODEL_ORDER_FIELD, value: ['b', 'a'] })
    expect(writes[1]).toEqual({ op: 'set', field: HIDDEN_MODELS_FIELD, value: ['x'] })
    await flush()
  })

  it('clears an override with an empty list rather than pinning an empty one', async () => {
    const { form, writes } = formOf({ initial: { modelOrder: ['a'], hiddenModels: ['x'] } })
    const prefs = createCodeBuddyPrefs(form)

    prefs.setModelOrder([])
    prefs.setHiddenModels([])
    expect(prefs.getSnapshot().modelOrder).toEqual([])
    expect(writes[0]).toEqual({ op: 'unset', field: MODEL_ORDER_FIELD })
    expect(writes[1]).toEqual({ op: 'unset', field: HIDDEN_MODELS_FIELD })
    await flush()
  })

  it('skips an unchanged list write, which is still a Host request', async () => {
    const { form, writes } = formOf({ initial: { modelOrder: ['a', 'b'] } })
    const prefs = createCodeBuddyPrefs(form)
    prefs.setModelOrder(['a', 'b'])
    expect(writes).toEqual([])
    await flush()
  })

  it('copies the list it was handed, so a caller mutation cannot rewrite the snapshot', async () => {
    const { form } = formOf({ initial: { modelOrder: [] } })
    const prefs = createCodeBuddyPrefs(form)
    const caller = ['a', 'b']
    prefs.setModelOrder(caller)
    caller.push('c')
    expect(prefs.getSnapshot().modelOrder).toEqual(['a', 'b'])
    await flush()
  })

  it('resets both model preferences in one atomic write', async () => {
    const { form, writes } = formOf({ initial: { modelOrder: ['b'], hiddenModels: ['x'] } })
    const prefs = createCodeBuddyPrefs(form)

    prefs.resetModelPrefs()
    expect(prefs.getSnapshot().modelOrder).toEqual([])
    expect(prefs.getSnapshot().hiddenModels).toEqual([])
    // One mutation, so two clears cannot settle apart.
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      op: 'mutate',
      ops: [
        { op: 'unset', path: [MODEL_ORDER_FIELD] },
        { op: 'unset', path: [HIDDEN_MODELS_FIELD] },
      ],
    })
    await flush()
  })

  it('skips the reset when nothing is overridden', async () => {
    const { form, writes } = formOf({ initial: { modelOrder: [], hiddenModels: [] } })
    createCodeBuddyPrefs(form).resetModelPrefs()
    expect(writes).toEqual([])
    await flush()
  })
})

describe('adopting Host snapshots', () => {
  it('publishes a changed section from the Host', () => {
    const { form, publish } = formOf({ initial: { showUsage: true } })
    const prefs = createCodeBuddyPrefs(form)
    const listener = vi.fn()
    prefs.subscribe(listener)

    publish({ value: { showUsage: false, customLimitUnit: 'credit', dangerPct: 90, modelOrder: [], hiddenModels: [] } })
    expect(prefs.getSnapshot().showUsage).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stays silent when the Host section is byte-identical', () => {
    const initial: Partial<CodeBuddySettings> = { showUsage: true, dangerPct: 90, modelOrder: ['a'] }
    const { form, publish } = formOf({ initial })
    const prefs = createCodeBuddyPrefs(form)
    const listener = vi.fn()
    prefs.subscribe(listener)

    publish({ value: { ...initial } as CodeBuddySettings })
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps the last accepted value when the Host publishes none', () => {
    const { form, publish } = formOf({ initial: { showUsage: false } })
    const prefs = createCodeBuddyPrefs(form)
    publish({ value: undefined, status: 'loading' })
    expect(prefs.getSnapshot().showUsage).toBe(false)
  })
})

describe('persistence reporting', () => {
  it('counts a loading form as persistent, so no notice appears before the first answer', () => {
    // A form that has not answered yet is not writable, so without the
    // `loading` branch a notice would flash before the first Host answer.
    const { form } = formOf({ status: 'loading', writable: false })
    const prefs = createCodeBuddyPrefs(form)
    expect(prefs.isPersistent()).toBe(true)
  })

  it('reports the settled state once a loading form answers as read-only', () => {
    const { form, publish } = formOf({ status: 'loading', writable: false })
    const prefs = createCodeBuddyPrefs(form)
    expect(prefs.isPersistent()).toBe(true)
    publish({ status: 'ready', writable: false })
    expect(prefs.isPersistent()).toBe(false)
  })

  it('reports a settled writable form as persistent', () => {
    expect(createCodeBuddyPrefs(formOf({ status: 'ready', writable: true }).form).isPersistent()).toBe(true)
  })

  it('reports a settled read-only form as not persistent', () => {
    expect(createCodeBuddyPrefs(formOf({ status: 'ready', writable: false }).form).isPersistent()).toBe(false)
  })

  it('reports an unavailable namespace as not persistent', () => {
    expect(createCodeBuddyPrefs(formOf({ status: 'unavailable', writable: false }).form).isPersistent()).toBe(false)
  })

  it('re-renders subscribers when only the persistence flag flips', () => {
    // `writable` can flip while the section is byte-identical.
    const { form, publish } = formOf({ status: 'ready', writable: true })
    const prefs = createCodeBuddyPrefs(form)
    const listener = vi.fn()
    prefs.subscribe(listener)

    publish({ writable: false })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(prefs.isPersistent()).toBe(false)
    // A second identical flip publishes nothing new.
    publish({ writable: false })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('subscription lifecycle', () => {
  it('stops notifying a removed listener', () => {
    const { form } = formOf({ initial: { showUsage: true } })
    const prefs = createCodeBuddyPrefs(form)
    const listener = vi.fn()
    const dispose = prefs.subscribe(listener)

    prefs.setShowUsage(false)
    expect(listener).toHaveBeenCalledTimes(1)
    dispose()
    prefs.setShowUsage(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('propagates a throwing listener, which stops the listeners after it', () => {
    // Pinned as current behaviour rather than endorsed: `publish` iterates a
    // copy of the listener set with no per-listener containment, so one broken
    // consumer aborts the notification round. The snapshot itself is already
    // committed before the round starts, so no state is lost — only the
    // remaining consumers miss this one notification and recover on the next.
    // (The session's catalog listeners do contain their failures; this store
    // does not.)
    const { form } = formOf({ initial: { showUsage: true } })
    const prefs = createCodeBuddyPrefs(form)
    const after = vi.fn()
    prefs.subscribe(() => { throw new Error('consumer bug') })
    prefs.subscribe(after)

    expect(() => prefs.setShowUsage(false)).toThrow('consumer bug')
    expect(after).not.toHaveBeenCalled()
    expect(prefs.getSnapshot().showUsage).toBe(false)
  })

  it('releases the form subscription on dispose', () => {
    const { form, listenerCount } = formOf({ initial: { showUsage: true } })
    const prefs = createCodeBuddyPrefs(form)
    expect(listenerCount()).toBe(1)
    prefs.dispose()
    expect(listenerCount()).toBe(0)
  })

  it('stops delivering after dispose', () => {
    const { form } = formOf({ initial: { showUsage: true } })
    const prefs = createCodeBuddyPrefs(form)
    const listener = vi.fn()
    prefs.subscribe(listener)
    prefs.dispose()
    prefs.setShowUsage(false)
    expect(listener).not.toHaveBeenCalled()
  })
})
