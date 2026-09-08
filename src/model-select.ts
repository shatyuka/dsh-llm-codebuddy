/**
 * Replacement composer model seat: shadows `conversation.input.model` with a
 * CodeBuddy-flavoured list that shows tags, credit multipliers, and tooltips.
 *
 * This component reads the *same* shared `ModelDirectory` store the official
 * seat and the /model popup use (so selection state stays identical), and
 * enriches each row through this plugin's own `/codebuddy` RPC channel, which
 * serves the raw catalog facts CodeBuddy discloses.
 *
 * @module dsh-llm-codebuddy/model-select
 */

import type { ReactElement } from 'react'
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { IconChevronDownOutline14, IconChevronRightOutline14, IconCheckOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from './client-types.js'

/**
 * Translate function over the official `model` locale namespace, registered
 * by `@deepseek-ai/dsh-client-ui-model-selection` (a declared dependency of
 * this plugin, so its dictionaries exist by the time this seat renders).
 * Copy lives with the shell: the seat stays in sync with the shell's own
 * wording automatically.
 */
export interface ModelSelectT {
  (key: 'menu.model' | 'menu.effort' | 'effort.providerDefault' | 'trigger.loading' | 'trigger.fallback' | 'trigger.selectAria' | 'trigger.aria' | 'trigger.ariaEffort' | 'menu.aria' | 'empty.models' | 'empty.efforts' | 'status.loading' | 'error.action' | 'action.reload' | 'warning.groupLoad', params?: Record<string, string>): string
}

/** One enriched model row: the harness catalog entry plus CodeBuddy display facts. */
export interface EnrichedModel {
  id: string
  name: string
  /** Credit multiplier label ("x0.79") from the CodeBuddy catalog. */
  credits?: string
  /** Opaque tags and `badge:<label>:#<RRGGBB>` colored badges, from the CodeBuddy catalog. */
  tags?: string[]
  /** Chinese description, when CodeBuddy disclosed one. */
  descriptionZh?: string
  /** English description, when CodeBuddy disclosed one. */
  descriptionEn?: string
}

/** The enriched catalog the seat resolves before first render of a group. */
export interface ModelDirectoryFace {
  /** The session's shared directory store (same instance the /model popup reads). */
  directory: SnapshotStore<DirectoryState>
  /** Ensure the shared advisory catalog is loaded (errors land on the store). */
  load: () => void
  /** Select a complete provider/model/reasoning selection. */
  select: (selection: { provider: string, model: string, reasoningEffort?: string }) => Promise<boolean>
  /** Whether this session supports model inspection and selection. */
  available: boolean
}

/** The subset of the ModelDirectory store snapshot the seat renders from. */
export interface DirectoryState {
  current: { provider: string, model: string, reasoningEffort?: string } | null
  routable: boolean | null
  groups: readonly {
    id: string
    name: string
    models: readonly {
      id: string
      name: string
      description?: string
      reasoning?: { efforts: readonly { id: string, name: string }[], defaultEffort?: string }
    }[]
  }[]
  failures: readonly { id: string, name: string, message: string }[]
  status: 'idle' | 'loading' | 'selecting' | 'ready' | 'error'
  error: string | null
}

/** One parsed display tag: label plus its color. */
export interface DisplayTag {
  label: string
  color: string
}

/**
 * Parse one raw catalog tag into a display pill, or drop it.
 *
 * Enterprise accounts receive pre-styled badges as `badge:<label>:#RRGGBB`
 * (e.g. `badge:new:#FF8C00`, `badge:内部模型:#3B82F6`) carrying the exact
 * color the CodeBuddy IDE renders; badge-form tags render as pills and
 * every other tag is dropped.
 */
function parseTag(tag: string): DisplayTag | undefined {
  const badge = /^badge:(.+):#([0-9a-f]{6})$/iu.exec(tag)
  if (badge === null) return undefined
  return { label: badge[1], color: `#${badge[2]}` }
}

/**
 * The credits label a row shows, or undefined.
 *
 * The enriched catalog's `credits` is the authoritative source.
 */
function creditsOf(enriched: EnrichedModel | undefined): string | undefined {
  return enriched?.credits
}

/**
 * Whether a credit label reads as a zero rate ("x0.00").
 */
function isFreeCredits(credits: string | undefined): boolean {
  return credits !== undefined && /^x0(?:\.0+)?$/iu.test(credits.trim())
}

/**
 * The locale-appropriate model description: Chinese while the UI locale is zh,
 * English otherwise, each falling back to the other when its own is absent.
 */
function descriptionOf(enriched: EnrichedModel | undefined, zh: boolean): string | undefined {
  if (enriched === undefined) return undefined
  return zh ? enriched.descriptionZh ?? enriched.descriptionEn : enriched.descriptionEn ?? enriched.descriptionZh
}

/**
 * Fetch the enriched CodeBuddy catalog, refreshed on every menu open.
 *
 * The host caches the underlying config read (5-minute TTL), so an open that
 * lands inside the cache window is cheap; refreshing on every open keeps a
 * long-lived page from pinning stale tags/credits.
 */
function useEnrichedCatalog(rpc: EnrichedCatalogRpc, open: boolean): Map<string, EnrichedModel> {
  const [entries, setEntries] = useState<Map<string, EnrichedModel>>(() => new Map())
  useEffect(() => {
    if (!open) return
    let stopped = false
    void rpc.models().then((models) => {
      if (stopped || models === undefined) return
      const map = new Map<string, EnrichedModel>()
      for (const model of models) map.set(model.id, model)
      setEntries(map)
    }).catch(() => { /* enrichment is advisory; rows render bare on failure */ })
    return () => { stopped = true }
  }, [rpc, open])
  return entries
}

/** The minimal RPC face the seat needs for enrichment. */
export interface EnrichedCatalogRpc {
  models: () => Promise<EnrichedModel[] | undefined>
}

/** Tooltip accepts its anchor as a JSX child; this element-factory face keeps `h()` overload-free. */
const tooltip = (props: { side: 'top' | 'right' | 'bottom', delayMs: number, label: ReactElement }, anchor: ReactElement): ReactElement =>
  h(Tooltip as unknown as (p: { side: 'top' | 'right' | 'bottom', delayMs: number, label: ReactElement }, children: ReactElement) => ReactElement, props, anchor)

/**
 * The hover bubble content for one model row: name + id on the first line
 * (id dimmer, after the name), the badge tags on the second, and the locale
 * description below.
 */
function modelTooltipContent(model: { id: string, name: string, description?: string }, enriched: EnrichedModel | undefined, zh: boolean): ReactElement {
  const badges = (enriched?.tags ?? []).map(parseTag).filter((tag): tag is DisplayTag => tag !== undefined)
  // CodeBuddy's own locale descriptions first, then the harness catalog
  // description — every row, any provider, gets a tooltip description.
  const description = descriptionOf(enriched, zh) ?? model.description
  return h('div', { className: 'cbms-tip' },
    h('div', { className: 'cbms-tipNameRow' },
      h('span', { className: 'cbms-tipName' }, model.name),
      h('span', { className: 'cbms-tipId' }, model.id),
    ),
    badges.length > 0 ? h('div', { className: 'cbms-tipTags' },
      badges.map((badge, i) => h('span', {
        key: i, className: 'cbms-tag', style: { color: badge.color, borderColor: badge.color },
      }, badge.label)),
    ) : null,
    description !== undefined && description.length > 0
      ? h('div', { className: 'cbms-tipDesc' }, description)
      : null,
  )
}

/**
 * The composer model seat with CodeBuddy display enrichment.
 *
 * Props mirror the official seat's contract (`conversation.input.model`):
 * owner share `locked` plus the injected face over the shared directory.
 */
export function CodeBuddyModelSelect({ locked, available, directory, load, select, rpc, t, zh }: {
  locked: boolean
  rpc: EnrichedCatalogRpc
  t: ModelSelectT
  zh: boolean
} & ModelDirectoryFace): ReactElement | null {
  const state = useSyncExternalStore(
    (fn) => directory.subscribe(fn),
    () => directory.getSnapshot(),
    // Third argument = server snapshot, matching the official ModelSelect's
    // own useSyncExternalStore call.
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root')
  const lastActionRef = useRef<'load' | 'select'>('load')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useMemo(() => `cb-model-${Math.random().toString(36).slice(2, 8)}`, [])
  const enriched = useEnrichedCatalog(rpc, open)

  const choices = useMemo(() => state.groups.flatMap((group) => group.models.map((model) => ({
    group,
    model,
    selection: {
      provider: group.id,
      model: model.id,
      ...model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: model.reasoning.defaultEffort },
    },
  }))), [state.groups])
  const currentChoice = choices[state.current === null ? -1 : choices.findIndex((c) =>
    c.selection.provider === state.current?.provider && c.selection.model === state.current.model)]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined ? undefined
    : effectiveEffort === undefined ? t('effort.providerDefault')
      : reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo(() => reasoning === undefined ? [] : [
    ...reasoning.defaultEffort === undefined ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }] : [],
    ...reasoning.efforts.map((effort) => ({ key: `effort:${effort.id}`, effort: effort.id, label: effort.name })),
  ], [reasoning, t])

  const busy = state.status === 'selecting'

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  if (!available) return null

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }
  const show = (): void => {
    setPane('root')
    setOpen(true)
    reload()
  }
  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }
  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
    if (items.length === 0) return
    const active = items.findIndex((item) => item === document.activeElement)
    items[(Math.max(active, 0) + offset + items.length) % items.length]?.focus()
  }
  const onRootKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      if (pane !== 'root') setPane('root')
      else close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }
  const onBlur = (event: React.FocusEvent): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }
  const choose = (selection: { provider: string, model: string, reasoningEffort?: string }): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select(selection).then((accepted) => {
      if (accepted) {
        if (rootRef.current !== null) close(true)
      }
    })
  }
  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select({
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }).then((accepted) => {
      if (accepted) close(true)
    })
  }

  const waiting = state.current === null && state.status === 'loading'
  const modelLabel = waiting ? t('trigger.loading')
    : currentChoice?.model.name ?? (state.current === null ? t('trigger.fallback') : `${state.current.provider}/${state.current.model}`)
  const triggerAria = waiting ? t('trigger.loading')
    : state.current === null ? t('trigger.selectAria')
      : effortLabel === undefined ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })

  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => {
      itemRefs.current[at] = node
    }
  }

  return h('div', {
    ref: rootRef,
    className: 'cbms-root',
    onKeyDown: onRootKeyDown,
    onBlur,
  },
    h('button', {
      ref: triggerRef,
      type: 'button',
      className: 'cbms-trigger',
      'aria-label': triggerAria,
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      title: `${modelLabel}${effortLabel === undefined ? '' : ` · ${effortLabel}`}`,
      disabled: locked,
      onClick: () => { if (open) close(); else show() },
    },
      h('span', { className: 'cbms-triggerLabel' }, modelLabel),
      effortLabel !== undefined ? h('span', { className: 'cbms-triggerEffort' }, effortLabel) : null,
      h(IconChevronDownOutline14, { className: `cbms-chevron${open ? ' cbms-chevronOpen' : ''}` }),
    ),
    open ? h('div', {
      id: `${id}-menu`,
      className: 'cbms-menu',
      role: 'menu',
      'aria-label': t('menu.aria'),
      'aria-busy': state.status === 'loading' || busy,
    },
      pane === 'root' ? h(Fragment, null,
        h('button', {
          ref: itemRef(), type: 'button', role: 'menuitem', className: 'cbms-cell',
          onClick: () => { setPane('model') },
        },
          h('span', { className: 'cbms-cellLabel' }, t('menu.model')),
          h('span', { className: 'cbms-cellValue' }, modelLabel),
          h(IconChevronRightOutline14, { className: 'cbms-cellChevron' }),
        ),
        reasoning !== undefined ? h('button', {
          ref: itemRef(), type: 'button', role: 'menuitem', className: 'cbms-cell',
          onClick: () => { setPane('effort') },
        },
          h('span', { className: 'cbms-cellLabel' }, t('menu.effort')),
          h('span', { className: 'cbms-cellValue' }, effortLabel),
          h(IconChevronRightOutline14, { className: 'cbms-cellChevron' }),
        ) : null,
      ) : null,
      pane === 'model' ? h(Fragment, null,
        state.status === 'loading' ? h('div', { className: 'cbms-status' }, t('status.loading')) : null,
        state.error !== null && lastActionRef.current === 'load' ? h('div', { className: 'cbms-error' },
          h('span', null, t('error.action', { message: state.error })),
          h('button', { type: 'button', className: 'cbms-retry', onClick: reload }, t('action.reload')),
        ) : null,
        state.failures.map((failure) => h('div', { className: 'cbms-warning', key: failure.id },
          h('span', null, t('warning.groupLoad', { name: failure.name, message: failure.message })),
          h('button', { type: 'button', className: 'cbms-retry', onClick: reload }, t('action.reload')),
        )),
        h('div', { className: 'cbms-groups scrollable' },
          state.groups.map((group) => h('section', {
            role: 'group',
            'aria-labelledby': `${id}-${group.id}`,
            className: 'cbms-group',
            key: group.id,
          },
            h('div', { className: 'cbms-groupTitle', id: `${id}-${group.id}` }, group.name),
            group.models.map((model) => {
              const selected = state.current?.provider === group.id && state.current.model === model.id
              const extra = enriched.get(model.id)
              const credits = creditsOf(extra)
              const badges = (extra?.tags ?? []).map(parseTag).filter((tag): tag is DisplayTag => tag !== undefined)
              return tooltip({ label: modelTooltipContent(model, extra, zh), side: 'top', delayMs: 300 },
                h('button', {
                  key: model.id,
                  ref: itemRef(),
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': selected,
                  className: `cbms-option${selected ? ' cbms-selected' : ''}`,
                  disabled: busy,
                  onClick: () => { choose({ provider: group.id, model: model.id }) },
                },
                  h('span', { className: 'cbms-optionCopy' },
                    h('span', { className: 'cbms-modelName' }, model.name),
                    badges.map((badge) => h('span', {
                      key: badge.label, className: 'cbms-tag',
                      style: { color: badge.color, borderColor: badge.color },
                    }, badge.label)),
                  ),
                  // The selection check comes before the credits, so an
                  // unselected row's multiplier sits flush right.
                  h('span', { className: 'cbms-check' }, selected ? h(IconCheckOutline16, null) : null),
                  credits !== undefined ? h('span', {
                    className: `cbms-credits${isFreeCredits(credits) ? ' cbms-creditsFree' : ''}`,
                  }, credits) : null,
                ),
              )
            }),
          )),
        ),
        state.status === 'ready' && choices.length === 0 ? h('div', { className: 'cbms-empty' }, t('empty.models')) : null,
      ) : null,
      pane === 'effort' ? h(Fragment, null,
        state.error !== null && lastActionRef.current === 'load' ? h('div', { className: 'cbms-error' },
          h('span', null, t('error.action', { message: state.error })),
          h('button', { type: 'button', className: 'cbms-retry', onClick: reload }, t('action.reload')),
        ) : null,
        effortChoices.length === 0 ? h('div', { className: 'cbms-empty' }, t('empty.efforts')) : effortChoices.map((level) => {
          const selected = effectiveEffort === level.effort
          return h('button', {
            ref: itemRef(),
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': selected,
            className: `cbms-option${selected ? ' cbms-selected' : ''}`,
            key: level.key,
            disabled: busy,
            onClick: () => { chooseEffort(level.effort) },
          },
            h('span', { className: 'cbms-optionCopy' },
              h('span', { className: 'cbms-modelName' }, level.label),
            ),
            h('span', { className: 'cbms-check' }, selected ? h(IconCheckOutline16, null) : null),
          )
        }),
      ) : null,
    ) : null,
  )
}

/** Scoped CSS for the seat, mirroring the official ModelSelect geometry. */
export const MODEL_SELECT_CSS = `
.cbms-root{min-width:0;position:relative}
.cbms-trigger{min-width:0;max-width:min(360px,45cqw);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:flex}
.cbms-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cbms-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.cbms-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.cbms-triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.cbms-triggerEffort{color:var(--dsw-alias-label-caption);flex:none}
.cbms-chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}
.cbms-chevronOpen{transform:rotate(180deg)}
.cbms-menu{z-index:20;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(300px,100vw - 32px);max-width:min(460px,100vw - 32px);max-height:min(400px,100vh - 96px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:0;border-radius:20px;flex-direction:column;padding:4px;display:flex;position:absolute;bottom:calc(100% + 8px);right:0;overflow:hidden}
.cbms-status,.cbms-empty{color:var(--dsw-alias-label-tertiary);padding:10px;font-size:13px;line-height:20px}
.cbms-error,.cbms-warning{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:8px;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;padding:7px 8px;font-size:12px;line-height:18px;display:flex}
.cbms-warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}
.cbms-retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-weight:600}
.cbms-groups{min-height:0;overflow-y:auto}
.cbms-group+.cbms-group{margin-top:4px}
.cbms-groupTitle{z-index:1;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);padding:5px 8px 3px;font-size:12px;font-weight:500;line-height:18px;position:sticky;top:0}
.cbms-option{box-sizing:border-box;width:auto;min-width:100%;min-height:38px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:10px;outline:none;align-items:center;gap:8px;padding:6px 8px;display:flex}
.cbms-option:hover:not(:disabled),.cbms-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.cbms-selected{background:0 0}
.cbms-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.cbms-optionCopy{align-items:center;gap:6px;min-width:0;flex:1;display:flex}
.cbms-modelName{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}
.cbms-tag{flex:none;border:0.5px solid;border-radius:4px;padding:0 5px;font-size:11px;line-height:16px;font-weight:400}
.cbms-credits{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;flex:none;font-size:12px;line-height:18px;font-weight:400}
.cbms-creditsFree{color:var(--dsw-alias-state-success-primary)}
.cbms-check{color:var(--dsw-alias-label-primary);flex:0 0 18px;place-items:center;display:grid}
.cbms-cell{box-sizing:border-box;width:auto;min-width:100%;height:40px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;border-radius:10px;align-items:center;gap:8px;padding:0 10px;font-size:14px;line-height:22px;display:flex}
.cbms-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cbms-cellLabel{white-space:nowrap;flex:none}
.cbms-cellValue{text-overflow:ellipsis;white-space:nowrap;text-align:right;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;overflow:hidden}
.cbms-cellChevron{color:var(--dsw-alias-label-tertiary);flex:none}
.cbms-tip{color:inherit;max-width:480px;flex-direction:column;gap:4px;display:flex}
.cbms-tipNameRow{align-items:baseline;gap:8px;min-width:0;display:flex;white-space:nowrap;overflow:hidden}
.cbms-tipName{font-weight:500;text-overflow:ellipsis;flex:0 1 auto;overflow:hidden}
.cbms-tipId{opacity:.65;font-size:12px;text-overflow:ellipsis;flex:0 1 auto;overflow:hidden}
.cbms-tipTags{flex-wrap:wrap;gap:4px;display:flex}
.cbms-tipDesc{opacity:.85;font-size:12px;line-height:18px}
`
