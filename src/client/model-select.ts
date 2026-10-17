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

import type { Key, ReactElement } from 'react'
import { createElement as h, Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseFillRegular,
  IconDataOutlineRegular,
  IconWarningOutlineRegular,
  Input,
  MenuGroup,
  MenuSurface,
  observeStickyMenuGroups,
  rankByName,
  StateDot,
  Toast,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelSelectInjected } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { Translate, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CODEBUDDY_PROVIDER } from '../constants.js'
import { badgesOf, creditsOf, rowRate } from './model-badges.js'
import { orderModelsById } from './model-order.js'
import { useCodeBuddyPrefs } from './prefs.js'
import type { CodeBuddyPrefs } from './prefs.js'
import type { CodeBuddyModelEntry } from '../protocol.js'

/**
 * Translate function over the official `model` locale namespace, registered
 * by `@deepseek-ai/dsh-client-ui-model-selection` (a declared dependency of
 * this plugin, so its dictionaries exist by the time this seat renders).
 * Copy lives with the shell: the seat stays in sync with the shell's own
 * wording automatically.
 */
export type ModelSelectT = TranslateNS<'model'>

/** One enriched model row: the shared Host/browser catalog projection. */
export type EnrichedModel = CodeBuddyModelEntry

/** Official shared model-directory face injected into the composer seat. */
export type ModelDirectoryFace = ModelSelectInjected

const ACCOUNT_PROVIDER = 'deepseek-account'

const OFFICIAL_PROVIDER = 'deepseek-official'

function providerRank(id: string): number {
  return id === ACCOUNT_PROVIDER ? 0 : id === OFFICIAL_PROVIDER ? 1 : 2
}

/** Account and official providers first (`toSorted` needs ES2023). */
function orderModelProviders<T extends { readonly id: string }>(groups: readonly T[]): T[] {
  return [...groups].sort((left, right) => providerRank(left.id) - providerRank(right.id))
}

/**
 * Localize one `deepseek-official` row's description through the shared `model`
 * dictionaries, whose naming rule is deterministic:
 * `deepseek-v4-flash` ↔ `option.deepseekV4Flash.description`. The key is
 * derived, never tabulated, so new official models localize with no change
 * here; a translate miss returns the key itself, which keeps the catalog text.
 */
const BUILTIN_DESCRIPTION_PROVIDER = 'deepseek-official'

/** kebab-case model id (`deepseek-v4-flash`) → camelCase segment (`deepseekV4Flash`). */
const camelCase = (id: string): string =>
  id.split('-').map((part, index) => index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)).join('')

function builtinDescriptionOf(
  providerId: string,
  model: { id: string, description?: string },
  t: ModelSelectT,
): string | undefined {
  if (providerId !== BUILTIN_DESCRIPTION_PROVIDER || model.description === undefined) return model.description
  // Derived keys sit outside the typed union by construction; the widened view
  // is the same runtime function.
  const wide = t as Translate<string>
  const key = `option.${camelCase(model.id)}.description`
  const localized = wide(key)
  return localized !== key ? localized : model.description
}

/**
 * Fetch the enriched CodeBuddy catalog, refreshed on every menu open and
 * whenever the harness catalog behind the open menu changes.
 *
 * Each open asks the host, which bypasses its own config-cache TTL (subject to
 * a short floor) so a server-side add or delete is reflected rather than
 * pinning stale tags/credits for up to five minutes. `catalogKey` is the set of
 * group/model ids currently rendered: a Host-side add or delete republishes the
 * harness catalog, which changes this key and refetches the enrichment in the
 * same breath — without it, an already-open menu would gain a new row with no
 * enrichment (bare name plus the credit-multiplier description) until the user
 * closed and reopened it.
 *
 * Entries are keyed `provider/model`, the same composite the official seat
 * identifies rows by: another provider may list the same model id, and the
 * prefixed key keeps its rows from matching CodeBuddy's enrichment.
 */
function useEnrichedCatalog(rpc: EnrichedCatalogRpc, open: boolean, catalogKey: string): Map<string, EnrichedModel> {
  const [entries, setEntries] = useState<Map<string, EnrichedModel>>(() => new Map())
  useEffect(() => {
    if (!open) return
    let stopped = false
    void rpc.models().then((models) => {
      if (stopped || models === undefined) return
      const map = new Map<string, EnrichedModel>()
      for (const model of models) map.set(`${CODEBUDDY_PROVIDER}/${model.id}`, model)
      setEntries(map)
    }).catch(() => { /* enrichment is advisory; rows render bare on failure */ })
    return () => { stopped = true }
  }, [rpc, open, catalogKey])
  return entries
}

/** The minimal RPC face the seat needs for enrichment. */
export interface EnrichedCatalogRpc {
  models: () => Promise<EnrichedModel[] | undefined>
}

/**
 * Keep Tooltip's native anchor contract while adapting its text-only label type
 * to the richer React content that the runtime already renders as children.
 */
type NativeTooltipProps = Parameters<typeof Tooltip>[0]
type RichTooltipProps = Omit<NativeTooltipProps, 'label' | 'children'> & { key?: Key, label: ReactElement }
const richTooltip = ({ label, ...props }: RichTooltipProps, children: NativeTooltipProps['children']): ReactElement =>
  h(Tooltip, { ...props, label: label as unknown as NativeTooltipProps['label'], children })

/** Rich hover content for one model row. */
function modelTooltipContent(
  providerId: string,
  model: { id: string, name: string, description?: string },
  enriched: EnrichedModel | undefined,
  t: ModelSelectT,
): ReactElement {
  const badges = badgesOf(enriched?.tags)
  const promotion = enriched?.promotion
  // CodeBuddy's description arrives pre-localized; other providers fall back
  // to the catalog text, with DeepSeek's built-in wording localized.
  const description = enriched?.description ?? builtinDescriptionOf(providerId, model, t)
  const promotionText = promotion?.text
  return h('div', { className: 'cbms-tip' },
    h('div', { className: 'cbms-tipNameRow' },
      h('span', { className: 'cbms-tipName' }, model.name),
      h('span', { className: 'cbms-tipId' }, model.id),
    ),
    badges.length > 0 || promotion !== undefined ? h('div', { className: 'cbms-tipTags' },
      badges.map((badge) => h('span', {
        key: badge.key,
        className: 'cbms-tag',
        style: { color: badge.color, borderColor: badge.color },
      }, badge.label)),
      promotion !== undefined ? h('span', {
        key: 'promotion',
        className: 'cbms-tag',
        style: { color: promotion.color, borderColor: promotion.color },
      }, promotion.label) : null,
    ) : null,
    description !== undefined && description.length > 0
      ? h('div', { className: 'cbms-tipDesc' }, description)
      : null,
    promotionText !== undefined && promotionText.length > 0
      ? h('div', { className: 'cbms-tipPromo' }, promotionText)
      : null,
  )
}

/**
 * The composer model seat with CodeBuddy display enrichment.
 *
 * Props mirror the official seat's contract (`conversation.input.model`):
 * owner share `locked` plus the injected face over the shared directory.
 * Beyond the contract, this plugin passes its preference store (`prefs`) so
 * the CodeBuddy group's rows follow the arrangement made on the settings page.
 */
export function CodeBuddyModelSelect({
  locked,
  available,
  directory,
  load,
  select,
  rpc,
  t,
  prefs,
}: {
  locked: boolean
  rpc: EnrichedCatalogRpc
  t: ModelSelectT
  prefs: CodeBuddyPrefs
} & ModelDirectoryFace): ReactElement | null {
  const state = useSyncExternalStore(
    (fn) => directory.subscribe(fn),
    () => directory.getSnapshot(),
    // Third argument = server snapshot, keeping hydration reads consistent
    // with the client one (the directory snapshot is safe on the server).
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root')
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const [selectionFocus, setSelectionFocus] = useState(false)
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const groupsRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ left: number, top: number } | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  // The account route shows its localized name, not the catalog's.
  const accountProviderName = t('provider.account')
  const groups = useMemo(
    () => orderModelProviders(state.groups).map((group) => ({
      ...group,
      provider: {
        id: group.id,
        name: group.id === ACCOUNT_PROVIDER ? accountProviderName : group.name,
      },
    })),
    [state.groups, accountProviderName],
  )

  // Durable arrangement of this provider's rows, owned by the settings page.
  // The seat re-renders as the arrangement changes, so an edit while the menu
  // is open lands immediately.
  const { modelOrder, hiddenModels } = useCodeBuddyPrefs(prefs)
  const hiddenIds = useMemo(() => new Set<string>(hiddenModels), [hiddenModels])

  // The menu's view of each group: the CodeBuddy group follows the persisted
  // order and drops hidden ids, so they disappear from search as well; other
  // providers render exactly as the catalog holds them. `choices` below stays
  // unfiltered, so a hidden current selection keeps its trigger caption and
  // its effort pane — hiding only removes the row from the menu.
  const displayGroups = useMemo(() => groups.map((group) => group.id === CODEBUDDY_PROVIDER
    ? {
      ...group,
      models: orderModelsById(group.models, modelOrder).filter((model) => !hiddenIds.has(model.id)),
    }
    : group), [groups, modelOrder, hiddenIds])

  // Identity of the rows the shared directory currently advertises, including
  // the name and harness description (the credit multiplier) so a display-fact
  // change is part of the key too. Fed to the enrichment fetch so a catalog
  // republish (a Host-side add, delete, or credit change) also refreshes the
  // per-model display facts for an already-open menu.
  const catalogKey = useMemo(
    () => state.groups.map((group) => `${group.id}:${group.models.map((model) => `${model.id}\u0000${model.name}\u0000${model.description ?? ''}`).join(',')}`).join('|'),
    [state.groups],
  )
  const enriched = useEnrichedCatalog(rpc, open, catalogKey)

  const choices = useMemo(() => groups.flatMap((group) => group.models.map((model) => ({
    group,
    model,
    selection: {
      provider: group.id,
      model: model.id,
      ...model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: model.reasoning.defaultEffort },
    },
  }))), [groups])
  // Hidden models never render, so the search affordance counts the visible
  // rows alone — hiding down to a handful removes the search box with them.
  const visibleCount = useMemo(
    () => displayGroups.reduce((count, group) => count + group.models.length, 0),
    [displayGroups],
  )
  const showSearch = visibleCount > 4
  const filteredGroups = useMemo(() => displayGroups
    .map((group) => ({ ...group, models: rankByName(group.models, showSearch ? query.trim() : '') }))
    .filter((group) => group.models.length > 0), [displayGroups, query, showSearch])
  const visibleModels = useMemo(
    () => filteredGroups.flatMap((group) => group.models.map((model) => ({ provider: group.id, model: model.id }))),
    [filteredGroups],
  )
  const currentVisibleIndex = visibleModels.findIndex(
    (model) => model.provider === state.current?.provider && model.model === state.current.model,
  )
  const activeModelIndex = Math.min(highlightedIndex ?? Math.max(0, currentVisibleIndex), visibleModels.length - 1)
  const currentChoice = choices[state.current === null ? -1 : choices.findIndex((c) =>
    c.selection.provider === state.current?.provider && c.selection.model === state.current.model)]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  // Keeps the caption when the selection left the catalog.
  const effortLabel = currentChoice === undefined ? undefined
    : reasoning === undefined ? state.retainedEffort
      : effectiveEffort === undefined ? t('effort.providerDefault')
        : reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo(() => reasoning === undefined ? [] : [
    ...reasoning.defaultEffort === undefined ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }] : [],
    ...reasoning.efforts.map((effort) => ({ key: `effort:${effort.id}`, effort: effort.id, label: effort.name })),
  ], [reasoning, t])

  // The selection submitted while the Host settles.
  const pending = state.pending
  const busy = pending !== null

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
      if (event.target instanceof Node && menuRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  // Do not inherit a stale filter.
  useLayoutEffect(() => {
    if (!showSearch) {
      setQuery('')
      setHighlightedIndex(null)
    }
  }, [showSearch])

  /** The first focusable row a keyboard entry should land on: the checked one, else the first enabled. */
  const initialRow = (): HTMLElement | null | undefined =>
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      ?? itemRefs.current.find((item) => item !== null && !item.disabled)
      ?? triggerRef.current

  // Focus intent for the next pane render: "drill" focuses the pane's checked
  // (or first enabled) row; "model"/"effort" return focus to that root cell.
  const paneFocus = useRef<'drill' | 'model' | 'effort' | null>(null)
  const previousShowSearch = useRef(showSearch)
  useEffect(() => {
    const changedSearchMode = previousShowSearch.current !== showSearch
    previousShowSearch.current = showSearch
    const intent = paneFocus.current ?? (changedSearchMode && pane === 'model' ? 'drill' : null)
    paneFocus.current = null
    if (!open || intent === null) return
    if (intent === 'drill') {
      if (pane === 'model' && showSearch) {
        searchRef.current?.focus()
        return
      }
      initialRow()?.focus()
      return
    }
    const cell = itemRefs.current[intent === 'effort' ? 1 : 0]
    if (cell !== undefined && cell !== null && !cell.disabled) cell.focus()
    else triggerRef.current?.focus()
  }, [open, pane, showSearch])

  useEffect(() => {
    const viewport = groupsRef.current
    if (viewport === null) return
    return observeStickyMenuGroups(viewport)
  }, [available, open, pane, filteredGroups])

  useLayoutEffect(() => {
    if (open && pane === 'model' && activeModelIndex >= 0) {
      itemRefs.current[activeModelIndex]?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, pane, activeModelIndex, visibleModels])

  // The menu is portaled to the body, so it must be placed against the
  // viewport by hand: anchored at the trigger's top-right, clamped inside the
  // viewport with a margin, and re-placed on scroll or resize. While measuring
  // (first frame), it stays hidden at the origin so offsetWidth/offsetHeight
  // are real for the placement pass below.
  useLayoutEffect(() => {
    if (!available || !open) {
      setMenuPos(null)
      return
    }
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const lw = menuRef.current?.offsetWidth ?? 0
      const lh = menuRef.current?.offsetHeight ?? 0
      let x = rect.right - lw
      let y = rect.top - 8 - lh
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN)
      setMenuPos({ left: x, top: y })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    if (menuRef.current !== null) observer?.observe(menuRef.current)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [available, open, pane, state, query])

  if (!available) return null

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }
  const show = (): void => {
    setSelectionFocus(false)
    triggerRef.current?.focus()
    setQuery('')
    setHighlightedIndex(null)
    if (currentChoice === undefined) paneFocus.current = 'drill'
    setPane(currentChoice === undefined ? 'model' : 'root')
    setOpen(true)
    reload()
  }
  const changeQuery = (next: string): void => {
    setQuery(next)
    setHighlightedIndex(0)
  }
  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }
  const closeAfterSelection = (): void => {
    setSelectionFocus(true)
    close(true)
  }
  /** Enter a drilled pane, focusing its checked (or first enabled) row. */
  const drill = (next: 'model' | 'effort'): void => {
    setQuery('')
    setHighlightedIndex(null)
    paneFocus.current = 'drill'
    setPane(next)
  }
  /** Leave a drilled pane for the root one, handing the keyboard back to its cell. */
  const back = (from: 'model' | 'effort'): void => {
    paneFocus.current = from
    setPane('root')
  }
  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
    if (items.length === 0) return
    const active = items.findIndex((item) => item === document.activeElement)
    items[active === -1 ? offset > 0 ? 0 : items.length - 1 : (active + offset + items.length) % items.length]?.focus()
  }
  const onRootKeyDown = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      if (pane !== 'root' && currentChoice !== undefined) back(pane)
      else close(true)
      return
    }
    if (!open) return
    if (pane === 'model' && showSearch && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      if (!busy && visibleModels.length > 0) {
        setHighlightedIndex((activeModelIndex + (event.key === 'ArrowDown' ? 1 : -1) + visibleModels.length) % visibleModels.length)
        searchRef.current?.focus()
      }
      return
    }
    if (pane === 'model' && showSearch && event.target instanceof HTMLInputElement
      && (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
      if (event.key === 'Tab' && visibleModels.length === 0) return
      event.preventDefault()
      const highlighted = visibleModels[activeModelIndex]
      if (!busy && highlighted !== undefined) choose(highlighted)
      return
    }
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        event.preventDefault()
        if (pane !== 'root' && currentChoice !== undefined) back(pane)
        else close(true)
        return
      }
      const focused = document.activeElement
      const rows = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
      if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
        // Tab on a row settles like Enter.
        event.preventDefault()
        focused.click()
        return
      }
      if (focused !== triggerRef.current) return
      event.preventDefault()
      if (pane === 'model' && showSearch) {
        setHighlightedIndex(null)
        searchRef.current?.focus()
        return
      }
      initialRow()?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }
  const onBlur = (event: React.FocusEvent): void => {
    if (event.relatedTarget instanceof Node
      && (rootRef.current?.contains(event.relatedTarget) === true || menuRef.current?.contains(event.relatedTarget) === true)) return
    close()
  }
  type SelectOutcome = Awaited<ReturnType<ModelSelectInjected['select']>>
  const settleSelection = (result: SelectOutcome): void => {
    if (result === undefined) return
    if (result.ok) {
      if (rootRef.current !== null) closeAfterSelection()
      return
    }
    const { error } = result
    toastSeq.current += 1
    setToast({
      text: error.code === 'session/writer-held'
        ? t('error.sessionInUse')
        : t('error.action', { message: `${error.code}: ${error.message}` }),
    })
  }
  const submit = (selection: { provider: string, model: string, reasoningEffort?: string }): void => {
    lastActionRef.current = 'select'
    setSelectionFocus(true)
    triggerRef.current?.focus()
    void select(selection).then(settleSelection)
  }
  const choose = (selection: { provider: string, model: string, reasoningEffort?: string }): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      closeAfterSelection()
      return
    }
    submit(selection)
  }
  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      closeAfterSelection()
      return
    }
    submit({
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    })
  }

  const waiting = currentChoice === undefined && state.status === 'loading'
  const modelLabel = waiting ? t('trigger.loading') : currentChoice?.model.name ?? t('trigger.fallback')
  const triggerAria = waiting ? t('trigger.loading')
    : currentChoice === undefined ? t('trigger.selectAria')
      : effortLabel === undefined ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })

  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => {
      itemRefs.current[at] = node
    }
  }
  let modelIndex = 0

  return h('div', {
    ref: rootRef,
    className: 'cbms-root',
    onKeyDown: onRootKeyDown,
    onBlur,
    // A row press must not blur the trigger before its click lands: the menu
    // is portaled, so without this the root's blur handler would close it.
    onMouseDown: (event: React.MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
    },
  },
    h('button', {
      ref: triggerRef,
      type: 'button',
      className: 'cbms-trigger',
      'aria-label': triggerAria,
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      'aria-controls': open ? `${id}-menu` : undefined,
      title: `${modelLabel}${effortLabel === undefined ? '' : ` · ${effortLabel}`}`,
      'aria-busy': busy,
      'data-selection-focus': selectionFocus ? '' : undefined,
      onBlur: () => { setSelectionFocus(false) },
      disabled: locked,
      onClick: () => { if (open) close(true); else show() },
    },
      // The icon slot and the label/effort pair respond to the composer's
      // compact-mode CSS variables, so the seat folds to icon-only with the
      // rest of the composer controls.
      h(IconDataOutlineRegular, { className: 'cbms-triggerIcon', size: 16 }),
      h('span', { className: 'cbms-triggerLabel' }, modelLabel),
      effortLabel !== undefined ? h('span', { className: 'cbms-triggerEffort' }, effortLabel) : null,
      h(IconChevronDownOutlineRegular, { className: `cbms-chevron${open ? ' cbms-chevronOpen' : ''}` }),
    ),
    open ? createPortal(h(MenuSurface, {
      ref: menuRef,
      id: `${id}-menu`,
      className: 'cbms-menu',
      // Before the placement pass lands, stay hidden at the origin so the
      // menu can be measured (offsetWidth/offsetHeight) without a flash.
      style: menuPos ?? { visibility: 'hidden', left: 0, top: 0 },
      role: pane === 'model' ? 'group' : 'menu',
      'aria-label': t('menu.aria'),
      'aria-busy': state.status === 'loading' || busy,
    },
      pane === 'root' ? h(Fragment, null,
        h('button', {
          ref: itemRef(), type: 'button', role: 'menuitem', className: 'cbms-cell',
          onClick: () => { drill('model') },
        },
          h('span', { className: 'cbms-cellLabel' }, t('menu.model')),
          h('span', { className: 'cbms-cellValue' },
            currentChoice === undefined ? modelLabel : currentChoice.model.name),
          h(IconChevronRightOutlineRegular, { className: 'cbms-cellChevron' }),
        ),
        reasoning !== undefined ? h('button', {
          ref: itemRef(), type: 'button', role: 'menuitem', className: 'cbms-cell',
          onClick: () => { drill('effort') },
        },
          h('span', { className: 'cbms-cellLabel' }, t('menu.effort')),
          h('span', { className: 'cbms-cellValue' }, effortLabel),
          h(IconChevronRightOutlineRegular, { className: 'cbms-cellChevron' }),
        ) : null,
      ) : null,
      pane === 'model' ? h(Fragment, null,
        showSearch ? h('div', { className: 'cbms-searchRow' },
          h(Input, {
            ref: searchRef,
            className: `cbms-search${query !== '' ? ' cbms-searchWithQuery' : ''}`,
            type: 'text',
            role: 'searchbox',
            'aria-label': t('search.placeholder'),
            'aria-controls': `${id}-models`,
            'aria-activedescendant': activeModelIndex < 0 ? undefined : `${id}-model-${activeModelIndex}`,
            placeholder: t('search.placeholder'),
            value: query,
            readOnly: busy,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => { changeQuery(event.currentTarget.value) },
          }),
          query !== '' ? h('button', {
            type: 'button',
            className: 'cbms-searchClear',
            'aria-label': t('search.clear'),
            disabled: busy,
            onClick: () => {
              changeQuery('')
              searchRef.current?.focus()
            },
          }, h(IconCloseFillRegular, {})) : null,
        ) : null,
        state.status === 'loading' ? h('div', { className: 'cbms-status' }, t('status.loading')) : null,
        state.error !== null && lastActionRef.current === 'load' ? h('div', { className: 'cbms-error' },
          h('span', null, t('error.action', { message: state.error })),
          h('button', { type: 'button', className: 'cbms-retry', onClick: reload }, t('action.reload')),
        ) : null,
        state.failures.map((failure) => h('div', { className: 'cbms-warning', key: failure.id },
          h('span', null, t('warning.groupLoad', {
            name: failure.id === ACCOUNT_PROVIDER ? t('provider.account') : failure.name,
            message: failure.message,
          })),
          h('button', { type: 'button', className: 'cbms-retry', onClick: reload }, t('action.reload')),
        )),
        h('div', {
          ref: groupsRef,
          id: `${id}-models`,
          className: 'cbms-groups scrollable',
          role: 'menu',
          'aria-label': t('menu.model'),
          hidden: filteredGroups.length === 0,
        },
          filteredGroups.map((group) => h(MenuGroup, { key: group.id, label: group.provider.name },
            group.models.map((model) => {
              const index = modelIndex++
              const selected = state.current?.provider === group.id && state.current.model === model.id
              // Keyed `provider/model`, so other providers' rows never match.
              const extra = enriched.get(`${group.id}/${model.id}`)
              const rate = rowRate(creditsOf(extra), extra?.promotion)
              const badges = badgesOf(extra?.tags)
              const promotion = extra?.promotion
              return richTooltip({
                key: model.id,
                label: modelTooltipContent(group.id, model, extra, t),
                side: 'top',
                portal: true,
                delayMs: 300,
              }, h('button', {
                ref: itemRef(),
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': selected,
                id: `${id}-model-${index}`,
                tabIndex: showSearch ? -1 : 0,
                onFocus: () => { setHighlightedIndex(index) },
                'data-highlighted': index === activeModelIndex ? '' : undefined,
                // Hover stays off model rows; the highlighted row owns the background.
                className: `cbms-option cbms-modelOption${selected ? ' cbms-selected' : ''}${index === activeModelIndex ? ' cbms-optionActive' : ''}`,
                onMouseMove: busy || index === activeModelIndex
                  ? undefined
                  : () => { if (showSearch) setHighlightedIndex(index); else itemRefs.current[index]?.focus() },
                disabled: busy,
                onClick: () => { choose({ provider: group.id, model: model.id }) },
              },
                h('span', { className: 'cbms-optionCopy' },
                  h('span', { className: 'cbms-modelName' }, model.name),
                  badges.map((badge) => h('span', {
                    key: badge.key, className: 'cbms-tag',
                    style: { color: badge.color, borderColor: badge.color },
                  }, badge.label)),
                  // The promotion badge rides after the catalog badges.
                  promotion !== undefined ? h('span', {
                    key: 'promotion', className: 'cbms-tag',
                    style: { color: promotion.color, borderColor: promotion.color },
                  }, promotion.label) : null,
                ),
                // The selection check comes before the rate, so an
                // unselected row's multiplier sits flush right.
                h('span', { className: 'cbms-check' },
                  pending !== null && pending.provider === group.id && pending.model === model.id
                    ? h(StateDot, { state: 'ongoing' })
                    : selected ? h(IconCheckOutlineRegular, null) : null),
                rate !== undefined ? h('span', {
                  className: `cbms-credits${rate.promo ? ' cbms-creditsPromo' : rate.free ? ' cbms-creditsFree' : ''}`,
                  ...rate.tint === undefined ? {} : { style: { color: rate.tint } },
                }, rate.label) : null,
              ))
            }),
          )),
        ),
        state.status === 'ready' && filteredGroups.length === 0 ? h('div', {
          className: 'cbms-empty',
          role: 'status',
        }, t(choices.length === 0 ? 'empty.models' : 'search.empty')) : null,
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
            h('span', { className: 'cbms-check' },
              pending !== null
                && pending.provider === state.current?.provider
                && pending.model === state.current.model
                && pending.reasoningEffort === level.effort
                ? h(StateDot, { state: 'ongoing' })
                : selected ? h(IconCheckOutlineRegular, null) : null),
          )
        }),
      ) : null,
    ), document.body) : null,
    toast !== null ? h(Toast, {
      key: toastSeq.current,
      text: toast.text,
      icon: h(IconWarningOutlineRegular, null),
      // Anchored to the composer card, as the official seat's toasts are.
      anchor: rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null,
      onDone: () => { setToast(null) },
    }) : null,
  )
}

/** Scoped CSS for the seat, mirroring the official ModelSelect geometry. */
export const MODEL_SELECT_CSS = `
.cbms-root{min-width:0;position:relative}
.cbms-trigger{min-width:0;max-width:min(360px,45cqw);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:flex}
.cbms-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cbms-trigger:focus-visible:not([data-selection-focus]){box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.cbms-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.cbms-triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.cbms-triggerEffort{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-caption);flex-shrink:1000;overflow:hidden}
.cbms-triggerIcon{display:var(--dsh-composer-model-icon-display,none);flex:none}
.cbms-triggerLabel,.cbms-triggerEffort{display:var(--dsh-composer-model-text-display,block)}
.cbms-chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}
.cbms-chevronOpen{transform:rotate(180deg)}
.cbms-menu{z-index:1100;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(300px,100vw - 32px);max-width:min(460px,100vw - 32px);max-height:min(360px,100vh - 96px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:0;border-radius:16px;flex-direction:column;padding:3px;display:flex;position:fixed;overflow:hidden}
.cbms-status,.cbms-empty{color:var(--dsw-alias-label-tertiary);padding:8px;font-size:12px;line-height:18px}
.cbms-error,.cbms-warning{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:7px;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:3px;padding:6px 7px;font-size:11px;line-height:16px;display:flex}
.cbms-warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}
.cbms-retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-weight:600}
.cbms-searchRow{flex-shrink:0;margin:2px 0 3px;position:relative}
.cbms-searchRow .cbms-search{border-radius:8px;background:0 0;border:0 solid #0000;height:auto;padding:5px 7px;display:flex}
.cbms-searchRow .cbms-searchWithQuery{padding-right:34px}
.cbms-searchClear{width:24px;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:50%;justify-content:center;align-items:center;padding:0;display:inline-flex;position:absolute;top:50%;right:4px;transform:translateY(-50%)}
.cbms-searchClear:hover,.cbms-searchClear:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.cbms-searchRow .cbms-search:focus-within{border-color:#0000}
.cbms-searchRow .cbms-search input{padding:0;font-size:12px;line-height:normal}
.cbms-searchRow .cbms-search input::placeholder{color:var(--dsw-alias-label-caption)}
.cbms-groups{min-height:0;overflow-y:auto}
.cbms-option{box-sizing:border-box;width:auto;min-width:100%;min-height:34px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:8px;outline:none;align-items:center;gap:6px;padding:5px 7px;display:flex}
.cbms-option:not(.cbms-modelOption):hover:not(:disabled),.cbms-option:focus-visible,.cbms-optionActive:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cbms-selected{background:0 0}
.cbms-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.cbms-optionCopy{align-items:center;gap:6px;min-width:0;flex:1;display:flex}
.cbms-modelName{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;line-height:18px;overflow:hidden}
.cbms-tag{flex:none;border:0.5px solid;border-radius:4px;padding:0 5px;font-size:11px;line-height:16px;font-weight:400}
.cbms-credits{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;flex:none;font-size:12px;line-height:18px;font-weight:400}
.cbms-creditsFree{color:var(--dsw-alias-state-success-primary)}
.cbms-creditsPromo{color:var(--dsw-alias-state-business-primary)}
.cbms-check{color:var(--dsw-alias-label-primary);flex:0 0 14px;place-items:center;display:grid}
.cbms-check svg{width:14px;height:14px}
.cbms-cell{box-sizing:border-box;width:auto;min-width:100%;height:34px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;border-radius:8px;align-items:center;gap:6px;padding:0 8px;font-size:13px;line-height:20px;display:flex}
.cbms-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cbms-cellLabel{white-space:nowrap;flex:none}
.cbms-cellValue{text-overflow:ellipsis;white-space:nowrap;text-align:right;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;overflow:hidden}
.cbms-cellChevron{width:12px;height:12px;color:var(--dsw-alias-label-tertiary);flex:none}
.cbms-tip{color:inherit;max-width:480px;flex-direction:column;gap:4px;display:flex}
.cbms-tipNameRow{align-items:baseline;gap:8px;min-width:0;display:flex;white-space:nowrap;overflow:hidden}
.cbms-tipName{font-weight:500;text-overflow:ellipsis;flex:0 1 auto;overflow:hidden}
.cbms-tipId{opacity:.65;font-size:12px;text-overflow:ellipsis;flex:0 1 auto;overflow:hidden}
.cbms-tipTags{flex-wrap:wrap;gap:4px;display:flex;max-width:280px}
.cbms-tipDesc{opacity:.85;font-size:12px;line-height:18px;max-width:280px}
.cbms-tipPromo{opacity:.85;font-size:12px;line-height:18px;border-top:1px solid color-mix(in srgb, currentColor 25%, transparent);padding-top:6px;max-width:280px}
`
