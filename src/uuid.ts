/**
 * Version 7 UUIDs: identifiers whose text order matches their creation order.
 *
 * @module dsh-llm-codebuddy/uuid
 */

import { randomBytes } from 'node:crypto'

/** Milliseconds the 48-bit timestamp field can hold, as an end-of-range bound. */
const TIMESTAMP_LIMIT = 2 ** 48

/**
 * A fresh version 7 UUID as 32 lowercase hex digits with no separator.
 *
 * RFC 9562 lays the 128 bits out as a 48-bit millisecond timestamp, a 4-bit
 * version, 12 random bits, a 2-bit variant, then 62 random bits. The timestamp
 * leads, so two values compare as text in the order they were created.
 * @returns the identifier.
 */
export function uuidv7(): string {
  const now = Date.now()
  if (now < 0 || now >= TIMESTAMP_LIMIT) {
    // Outside 1970-9999 the field cannot express the moment, and writing a
    // truncated value would silently reorder the identifier.
    throw new RangeError(`uuidv7 timestamp out of range: ${now}`)
  }
  const bytes = randomBytes(16)
  // The leading six bytes are the millisecond timestamp, big-endian.
  bytes.writeUIntBE(now, 0, 6)
  // Version 7 in the high nibble of byte 6, variant 0b10 in byte 8.
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)
  return bytes.toString('hex')
}
