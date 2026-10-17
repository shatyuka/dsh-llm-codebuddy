/**
 * Model-row display facts shared by the composer model menu and the settings
 * page's list, so one catalog entry reads the same on both surfaces.
 *
 * @module dsh-llm-codebuddy/model-badges
 */

import type { CodeBuddyModelEntry, CodeBuddyPromotionView } from '../protocol.js'

/** One parsed display tag: label plus its color. */
export interface DisplayTag {
  label: string
  color: string
}

/** One renderable pill: a parsed tag with a list key. */
export interface BadgePill extends DisplayTag {
  /**
   * React list key, derived from the tag's POSITION: labels repeat, and one
   * reading `promotion` would collide with the promotion pill beside these.
   */
  key: string
}

/**
 * Parse one raw catalog tag into a display pill, or drop it. Only the
 * enterprise `badge:<label>:#RRGGBB` form renders; other tags are dropped.
 */
export function parseTag(tag: string): DisplayTag | undefined {
  const badge = /^badge:(.+):#([0-9a-f]{6})$/iu.exec(tag)
  const label = badge?.[1]
  const color = badge?.[2]
  if (label === undefined || color === undefined) return undefined
  return { label, color: `#${color}` }
}

/** Every displayable pill of one entry, in catalog order. */
export function badgesOf(tags: readonly string[] | undefined): BadgePill[] {
  const pills: BadgePill[] = []
  ;(tags ?? []).forEach((tag, index) => {
    const parsed = parseTag(tag)
    if (parsed !== undefined) pills.push({ ...parsed, key: `tag:${index}` })
  })
  return pills
}

/** The credits label a row shows, or undefined. The enriched catalog is authoritative. */
export function creditsOf(enriched: CodeBuddyModelEntry | undefined): string | undefined {
  return enriched?.credits
}

/** One row's trailing rate label and how to tint it. */
export interface RowRate {
  label: string
  /** The label comes from a promotion override rather than the catalog. */
  promo: boolean
  /** The label reads as a zero rate. */
  free: boolean
  /** Promotion color, when the label came from one. */
  tint?: string
}

/**
 * The rate label a row shows at its trailing edge. An active promotion's
 * override replaces the catalog rate, tinted with the promotion color.
 */
export function rowRate(
  credits: string | undefined,
  promotion: CodeBuddyPromotionView | undefined,
): RowRate | undefined {
  const promoLabel = promotion?.discountedRate
  const label = promoLabel ?? credits
  if (label === undefined) return undefined
  const tint = promotion?.color
  return {
    label,
    promo: promoLabel !== undefined,
    free: isFreeCredits(label),
    ...promoLabel !== undefined && tint !== undefined ? { tint } : {},
  }
}

/** Whether a credit label reads as a zero rate ("x0.00"). */
export function isFreeCredits(credits: string | undefined): boolean {
  return credits !== undefined && /^x0(?:\.0+)?$/iu.test(credits.trim())
}
