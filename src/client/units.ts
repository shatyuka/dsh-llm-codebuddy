/**
 * Credit ⇄ currency conversion for the custom-quota-cap control.
 *
 * The meter, the durable settings document, and the Host RPC boundary speak one
 * unit only — **credits**. A currency is purely a browser-side way to type and
 * read that same figure, so every conversion lives here and nothing on the
 * Host side ever sees a dollar or yuan amount.
 *
 * The fixed rates are 100 credits = 1 USD = 7 CNY, i.e. 1 credit = $0.01 = ¥0.07.
 *
 * @module dsh-llm-codebuddy/units
 */

import type { CreditUnit } from '../settings.js'

/** Credits that make up one US dollar. */
export const CREDITS_PER_USD = 100

/** Chinese yuan that make up one US dollar. */
export const CNY_PER_USD = 7

/** Credits that make up one Chinese yuan (`100 / 7`). */
export const CREDITS_PER_CNY = CREDITS_PER_USD / CNY_PER_USD

/**
 * Decimal places a credit figure keeps when a currency is converted back into
 * it. ¥1 is 14.2857… credits; four places round-trip through the two-decimal
 * currency display and stay exact for whole-dollar amounts.
 */
const CREDIT_PRECISION = 4

/** Round away float noise without disturbing the value a user typed. */
function round(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/**
 * Convert a credit amount into the unit a user reads it in.
 * @param credits - the amount in credits.
 * @param unit - the unit to express it in.
 * @returns the amount in `unit` (`credits` itself when the unit is `credit`).
 */
export function creditsToUnit(credits: number, unit: CreditUnit): number {
  switch (unit) {
    case 'usd': return credits / CREDITS_PER_USD
    case 'cny': return credits / CREDITS_PER_CNY
    case 'credit': return credits
  }
}

/**
 * Convert a user-typed amount in `unit` back into credits, the only unit the
 * settings document and the Host ever hold.
 * @param value - the amount as typed.
 * @param unit - the unit it was typed in.
 * @returns the equivalent credit amount.
 */
export function unitToCredits(value: number, unit: CreditUnit): number {
  switch (unit) {
    case 'usd': return round(value * CREDITS_PER_USD, CREDIT_PRECISION)
    case 'cny': return round(value * CREDITS_PER_CNY, CREDIT_PRECISION)
    case 'credit': return value
  }
}

/**
 * The smallest amount an input in `unit` accepts, so the control's bound
 * matches the credit floor the schema enforces.
 * @param unit - the unit the input is expressed in.
 * @param minCredits - the floor, in credits.
 * @returns the floor in `unit`.
 */
export function unitMinimum(unit: CreditUnit, minCredits: number): number {
  return unit === 'credit' ? minCredits : round(creditsToUnit(minCredits, unit), 2)
}

/**
 * Format an amount for a display surface (the tooltip and the input's hint).
 * Credits keep the meter's own grammar; currencies get two decimals, which is
 * the precision their rates actually resolve to.
 * @param credits - the amount in credits.
 * @param unit - the unit to render it in.
 * @returns the formatted number, without any unit label.
 */
export function formatInUnit(credits: number, unit: CreditUnit): string {
  if (unit === 'credit') {
    const rounded = Math.round(credits * 10) / 10
    return rounded.toLocaleString(undefined, { maximumFractionDigits: 1 })
  }
  const amount = creditsToUnit(credits, unit)
  return amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Format a stored amount for the input field: a currency keeps at most two
 * decimals (and drops a trailing `.00`); credits print exactly as stored.
 *
 * Credits are deliberately NOT rounded — they are authoritative, and a cap
 * entered as a currency is fractional. The field is only written back when its
 * text changed, so echoing the exact figure is what keeps a blur from drifting.
 * @param value - the amount as typed.
 * @param unit - the unit it was typed in.
 * @returns the text to place in the input.
 */
export function formatDraft(value: number, unit: CreditUnit): string {
  if (unit === 'credit') return String(value)
  const rounded = Math.round(value * 100) / 100
  return String(rounded)
}
