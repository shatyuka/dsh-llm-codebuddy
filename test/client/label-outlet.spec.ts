import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { StoredEntry, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelLabelOwner } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement as h } from 'react'
import {
  LABEL_SLOT, ModelLabelOutlet, labelPropsOf, pickLabel, revisionSeat,
} from '../../src/client/label-outlet.js'
import type { LabelSlotFace } from '../../src/client/label-outlet.js'

const owner: ModelLabelOwner = {
  provider: { id: 'codebuddy', name: 'CodeBuddy' },
  model: { id: 'cb-flash', name: 'CB Flash' },
  placement: 'option',
  selected: true,
}

function entry(over: Partial<StoredEntry> = {}): StoredEntry {
  return { component: () => null, options: {}, ...over }
}

function translate(namespace: string): Translate {
  return (key) => `${namespace}:${key}`
}

/** A face over a fixed ledger: no store ticks, one locale revision. */
function faceOf(ledger: readonly StoredEntry[], revision = 0): LabelSlotFace {
  const bind = translate
  return {
    slots: {
      subscribe: () => () => {},
      version: () => 0,
      winner: () => ledger[0],
      survivors: () => ledger,
    },
    locale: { subscribe: () => () => {}, revision: () => revision, bind },
  }
}

describe('labelPropsOf', () => {
  it('forwards the seat standard shares and wins collisions with the owner', () => {
    const props = labelPropsOf(entry(), owner, { sessionId: 's1', placement: 'trigger' }, translate)

    expect(props).toMatchObject({
      sessionId: 's1',
      provider: owner.provider,
      model: owner.model,
      placement: 'option',
      selected: true,
    })
  })

  it('binds the contributor locale instead of the seat model dictionary', () => {
    const props = labelPropsOf(entry({ locale: 'release-badge' }), owner, {}, translate)

    expect((props.t as Translate)('badge.label')).toBe('release-badge:badge.label')
  })

  it('adds no translate function when the contributor declared no locale', () => {
    expect(labelPropsOf(entry(), owner, {}, translate)).not.toHaveProperty('t')
  })
})

describe('pickLabel', () => {
  const first = entry({ options: { priority: -3 } })
  const second = entry({ options: { priority: 7 } })

  function log(...crashed: StoredEntry[]): Set<StoredEntry> {
    return new Set(crashed)
  }

  it('renders the cell winner while nothing crashed', () => {
    expect(pickLabel(second, [second, first], log())).toBe(second)
  })

  it('falls through to the next survivor after a crash', () => {
    expect(pickLabel(second, [second, first], log(second))).toBe(first)
  })

  it('renders the owner fallback once every survivor crashed', () => {
    expect(pickLabel(second, [second, first], log(second, first))).toBeUndefined()
  })

  it('keeps an empty cell empty', () => {
    expect(pickLabel(undefined, [], log())).toBeUndefined()
  })
})

describe('revisionSeat', () => {
  it('returns one identity per revision and re-reads through the binder', () => {
    const base = translate('model')
    const atZero = revisionSeat(base, 0)

    expect(revisionSeat(base, 0)).toBe(atZero)
    expect(revisionSeat(base, 1)).not.toBe(atZero)
    expect(atZero('trigger.fallback')).toBe('model:trigger.fallback')
  })
})

describe('ModelLabelOutlet', () => {
  /** One contributor that paints its own text, so markup proves it rendered. */
  const badge = () => h('em', null, 'badge')

  it('anchors the contributor at the official slot seam', () => {
    const html = renderToStaticMarkup(h(ModelLabelOutlet, {
      face: faceOf([entry({ component: badge })]),
      owner,
      standard: {},
      fallback: 'CB Flash',
    }))

    expect(html).toContain(`data-slot="${LABEL_SLOT}"`)
    expect(html).toContain('display:contents')
    expect(html).toContain('data-provider-id="codebuddy"')
    expect(html).toContain('<em>badge</em>')
    expect(html).not.toContain('CB Flash')
  })

  it('keeps the identity wrapper and drops to the fallback name when the cell is empty', () => {
    const html = renderToStaticMarkup(h(ModelLabelOutlet, {
      face: faceOf([]),
      owner,
      standard: {},
      fallback: 'CB Flash',
    }))

    expect(html).toContain('data-model-id="cb-flash"')
    expect(html).toContain('CB Flash')
  })

  it('renders the winning contributor of a live slot core', () => {
    // End to end over the real registry: the official seat declares the cell,
    // the plugin shadows the seat, and its own seat component renders the cell
    // it could not declare.
    const core = new SlotCore()
    const inert = (() => null) as never
    const register = (options: object, component: unknown = inert): void => {
      core.register(options as never, component as never)
    }
    register({ name: 'root', children: { 'conversation.input.model': { kind: 'single', scope: 'session' } } })
    register({
      name: 'conversation.input.model',
      priority: 0,
      children: { [LABEL_SLOT]: { kind: 'single', scope: 'session', inline: true } },
    })
    register({ name: 'conversation.input.model', priority: -1 })
    // Lower priority than the default 0, so it is the cell's winner.
    register({ name: LABEL_SLOT, priority: -1, locale: 'release-badge' }, () => h('em', null, 'badge'))

    const face: LabelSlotFace = {
      slots: {
        subscribe: (listener) => core.subscribe(LABEL_SLOT, listener),
        version: () => core.getVersion(LABEL_SLOT),
        winner: () => core.entriesOfSlot(LABEL_SLOT)[0],
        survivors: () => core.entries(LABEL_SLOT),
      },
      locale: { subscribe: () => () => {}, revision: () => 0, bind: translate },
    }
    const html = renderToStaticMarkup(h(ModelLabelOutlet, {
      face, owner, standard: { sessionId: 's1' }, fallback: 'CB Flash',
    }))

    expect(html).toContain(`data-slot="${LABEL_SLOT}"`)
    expect(html).toContain('<em>badge</em>')
    expect(html).not.toContain('CB Flash')
  })
})

describe('shadowed label declaration', () => {
  // Runtime premise: the registry forbids a second declaration, so the test
  // drives SlotCore through its runtime surface rather than re-deriving the
  // typed registration contracts (those live in the plugin's client compile).
  const component = (() => null) as never
  const register = (core: SlotCore, options: object): void => {
    core.register(options as never, component)
  }

  /** The official seat declares the child; the CodeBuddy seat shadows the seat later. */
  function shadowedSeats(): SlotCore {
    const core = new SlotCore()
    register(core, {
      name: 'root',
      children: { 'conversation.input.model': { kind: 'single', scope: 'session' } },
    })
    register(core, {
      name: 'conversation.input.model',
      priority: 0,
      children: { [LABEL_SLOT]: { kind: 'single', scope: 'session', inline: true } },
    })
    register(core, { name: 'conversation.input.model', priority: -1 })
    return core
  }

  it('declares the cell as a single inline session slot', () => {
    expect(shadowedSeats().spec(LABEL_SLOT as never)).toMatchObject({
      kind: 'single', scope: 'session', inline: true,
    })
  })

  it('keeps the child declaration and its winning contributor readable', () => {
    const core = shadowedSeats()
    register(core, { name: LABEL_SLOT, locale: 'model' })

    expect(core.entriesOfSlot(LABEL_SLOT)[0]).toMatchObject({ locale: 'model' })
  })

  it('reads the winner as the ledger head, so survivor walks start in priority order', () => {
    const core = shadowedSeats()
    register(core, { name: LABEL_SLOT, priority: 7 })
    register(core, { name: LABEL_SLOT, priority: -3 })

    const ledger = core.entries(LABEL_SLOT)
    expect(ledger.map(item => item.options.priority)).toEqual([-3, 7])
    expect(core.entriesOfSlot(LABEL_SLOT)[0]).toBe(ledger[0])
  })

  it('rejects a shadowing seat that declares the same child', () => {
    const core = shadowedSeats()

    expect(() => register(core, {
      name: 'conversation.input.model',
      priority: -2,
      children: { [LABEL_SLOT]: { kind: 'single', scope: 'session', inline: true } },
    })).toThrow(/already declared/u)
  })
})
