/**
 * Render the shadowed composer seat's inline model-label slot.
 *
 * `conversation.input.model.label` is declared exclusively by the official
 * seat's `children` table. A seat that shadows `conversation.input.model`
 * cannot declare the same child — the slot core rejects the second
 * declaration — but the official declaration and its contributors survive the
 * shadowing. This module reads the winning contributor through the public
 * registry surface and renders it inside the shadow seat, so the bundled
 * release badge and every other label plugin keep working.
 *
 * This is the closest the public surface allows to the official outlet, and it
 * mirrors that outlet's observable behavior field by field:
 *
 * - **anchor** — a `<span data-slot="conversation.input.model.label">` with
 *   `display: contents`, the addressable seam dynamic styles and DOM tooling
 *   target, around the identity wrapper the official seat itself renders;
 * - **two store reads** — the slot's registration version *and* the locale
 *   revision, so contributors arrive/retire and a language switch both
 *   re-render without the owner passing a fresh `t`;
 * - **entry identity** — keys come from the entry object, so swapping a
 *   contributor resets the boundary instead of reusing it;
 * - **crash containment** — a crashing contributor retires and the next
 *   survivor renders, as a shadowing outlet does.
 *
 * The residual gap is ownership: the official outlet retires a crashed entry
 * through `SlotRendererHost.reportEntryError`, which is not on the public
 * registry surface, so retirement here is a module-level weak log keyed by the
 * entry object rather than the core's own abdication set. Consequence: the
 * core's `snapshot()` inspection view still lists a contributor this module
 * retired, and a contributor that crashes only under our seat stays live
 * elsewhere. Neither is observable in the composer, where this outlet is the
 * only renderer of the cell.
 *
 * When DSH grows a supported way for a shadowing entry to adopt the shadowed
 * entry's child declarations (or a public `reportEntryError`), this module is
 * replaced by one `renderSlot` call.
 *
 * @module dsh-llm-codebuddy/label-outlet
 */

import type { ComponentType, ReactElement, ReactNode } from 'react'
import { Component, createElement as h, useReducer, useSyncExternalStore } from 'react'
import type { StoredEntry, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelLabelOwner } from '@deepseek-ai/dsh-client-ui-model-selection/client'

/** The single cell this module renders; also the anchor's `data-slot` value. */
export const LABEL_SLOT = 'conversation.input.model.label'

/** Public reads the shadow seat needs to render its undeclarable child slot. */
export interface LabelSlotFace {
  /** The label cell's registration ledger (`ctx.slots` surface). */
  slots: {
    /** Re-run the outlet when the cell's registration set changes. */
    subscribe(listener: () => void): () => void
    /** Monotonic registration version, the external-store snapshot. */
    version(): number
    /** The cell's winning entry (already skips entries the core abdicated). */
    winner(): StoredEntry | undefined
    /** The raw ledger in priority order, the survivor walk's source. */
    survivors(): readonly StoredEntry[]
  }
  /** The shell locale runtime, read as a revision observable. */
  locale: {
    /** Re-run the outlet when a dictionary or the active locale changes. */
    subscribe(listener: () => void): () => void
    /** Monotonic locale revision, the external-store snapshot. */
    revision(): number
    /** Bind one contributor's declared namespace. */
    bind(namespace: string): Translate
  }
}

/** `display: contents` keeps the anchor out of layout: a pure address seam. */
const DISPLAY_CONTENTS = { display: 'contents' } as const

/** What {@link pickLabel} needs from a crash log: membership only. */
export interface CrashLog {
  /** Whether this seat already witnessed the entry crashing. */
  has(entry: StoredEntry): boolean
}

/**
 * Contributors already witnessed crashing, retired for the rest of their
 * registration lifetime. Weak keys: a disposed entry stays collectable, and a
 * re-registration is a new object, so a fixed contributor gets a fresh try.
 *
 * Module scope is deliberate — the core retires a crashed entry from its cell
 * globally, so a per-mount set would let the same broken component crash once
 * per placement.
 */
const retired = new WeakSet<StoredEntry>()

/**
 * Choose the contributor to render.
 *
 * With nothing retired this is exactly the cell's winner, so the outlet's
 * behavior is the core's dispatch. After a crash the winner is skipped and the
 * walk continues down the ledger in priority order, which is what a shadowing
 * outlet does when it retires a crashed entry.
 *
 * @param winner - the cell's winning entry, undefined while the cell is empty.
 * @param survivors - the raw ledger in priority order.
 * @param crashed - entries already witnessed crashing.
 * @returns the entry to render, or undefined to render the owner fallback.
 */
export function pickLabel(
  winner: StoredEntry | undefined,
  survivors: readonly StoredEntry[],
  crashed: CrashLog = retired,
): StoredEntry | undefined {
  if (winner !== undefined && !crashed.has(winner)) return winner
  // Only reachable once something retired: the ledger is the one source that
  // can still name a lower-priority survivor.
  for (const entry of survivors) {
    if (!crashed.has(entry)) return entry
  }
  return undefined
}

/**
 * Per-binder translate seats, keyed by the stable binder and refreshed per
 * locale revision — the same shape the renderer's own `localeSeat` produces.
 */
const translateSeats = new WeakMap<Translate, { revision: number, t: Translate }>()

/**
 * Derive a translate function for one locale revision.
 *
 * A binder reads the active locale at call time, so its text is always
 * current; what a memiozed contributor needs is a *fresh identity* per
 * revision so it re-renders. This wrapper supplies exactly that.
 *
 * @param base - the namespace-bound binder.
 * @param revision - current locale revision.
 * @returns a translate function with revision-scoped identity.
 */
export function revisionSeat(base: Translate, revision: number): Translate {
  const cached = translateSeats.get(base)
  if (cached !== undefined && cached.revision === revision) return cached.t
  const t: Translate = (key, params) => base(key, params)
  translateSeats.set(base, { revision, t })
  return t
}

/**
 * Compose the props one label contributor receives.
 *
 * Standard session shares come first so a contributor reads the same
 * `sessionId` and hooks it would receive from the official seat; owner props
 * win because they are the slot's contract. A contributor that declared a
 * locale namespace gets its own `t`, never the seat's model dictionary.
 *
 * @param winner - the winning label contribution.
 * @param owner - provider/model identity and placement for this occurrence.
 * @param standard - the seat's session standard props.
 * @param translate - resolver binding a contributor's locale namespace.
 * @returns the props to spread onto the contributor component.
 */
export function labelPropsOf(
  winner: StoredEntry,
  owner: ModelLabelOwner,
  standard: Readonly<Record<string, unknown>>,
  translate: (namespace: string) => Translate,
): Record<string, unknown> {
  return {
    ...standard,
    ...owner,
    ...winner.locale === undefined ? {} : { t: translate(winner.locale) },
  }
}

/** Stable React identity per entry object, so a swap resets the boundary. */
const entryIds = new WeakMap<StoredEntry, number>()
let nextEntryId = 0

function entryKeyOf(entry: StoredEntry): string {
  let id = entryIds.get(entry)
  if (id === undefined) {
    id = nextEntryId += 1
    entryIds.set(entry, id)
  }
  return `label-entry:${id}`
}

interface LabelBoundaryProps {
  /** Report the crash so the outlet retires this contributor. */
  onCrash: () => void
  children?: ReactNode
}

interface LabelBoundaryState {
  failed: boolean
}

/**
 * Contain a crashing contributor the way the official outlet does.
 *
 * Nothing renders on failure: the crash report re-renders the outlet with the
 * next survivor, so painting the fallback name here would flash a name that
 * the following render replaces.
 */
class LabelBoundary extends Component<LabelBoundaryProps, LabelBoundaryState> {
  override state: LabelBoundaryState = { failed: false }

  static getDerivedStateFromError(): LabelBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    // The outlet retires the entry and re-renders with the next survivor; keep
    // the cause visible the way the official boundary does.
    console.error(`slot entry crashed in '${LABEL_SLOT}':`, error)
    this.props.onCrash()
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/**
 * Render one model name through the shadowed slot's winning contributor.
 *
 * @param props.face - registry and locale reads for the label cell.
 * @param props.owner - provider/model identity and placement.
 * @param props.standard - the seat's session standard props.
 * @param props.fallback - catalog name used when no contributor renders.
 * @returns the anchored identity wrapper around the contributor or fallback.
 */
export function ModelLabelOutlet({ face, owner, standard, fallback }: {
  face: LabelSlotFace
  owner: ModelLabelOwner
  standard: Readonly<Record<string, unknown>>
  fallback: string
}): ReactElement {
  // Contributors register and retire independently of the seat; the locale
  // revision moves on a language switch. Two external stores, two ticks.
  useSyncExternalStore(face.slots.subscribe, face.slots.version, face.slots.version)
  const revision = useSyncExternalStore(face.locale.subscribe, face.locale.revision, face.locale.revision)
  const [, rerender] = useReducer((tick: number) => tick + 1, 0)
  const winner = pickLabel(face.slots.winner(), face.slots.survivors())
  const content = winner === undefined
    ? fallback
    : h(
      LabelBoundary,
      {
        key: entryKeyOf(winner),
        onCrash: () => {
          retired.add(winner)
          rerender()
        },
      },
      h(
        winner.component as ComponentType<Record<string, unknown>>,
        labelPropsOf(
          winner,
          owner,
          standard,
          namespace => revisionSeat(face.locale.bind(namespace), revision),
        ),
      ),
    )
  // Outer span: the official seat's own identity wrapper for this occurrence.
  // Inner span: the outlet anchor, so `[data-slot="…"]` selects our label the
  // same way it selects the official seat's.
  return h('span', {
    'data-provider-id': owner.provider.id,
    'data-model-id': owner.model.id,
  }, h('span', { 'data-slot': LABEL_SLOT, style: DISPLAY_CONTENTS }, content))
}
