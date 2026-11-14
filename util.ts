// util.ts — small shared helpers: hashing, encodings, deterministic time,
// and git's tree-entry ordering. Nothing here knows about HTTP or the store.

import { createHash } from 'node:crypto';

/** SHA-1 of `data`, as lowercase hex. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Standard base64 of bytes. */
export function base64Encode(data: Buffer): string {
  return data.toString('base64');
}

/** Decode standard base64 (whitespace-tolerant) to bytes. */
export function base64Decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** URL-safe base64 without padding, for opaque Relay ids. */
export function base64UrlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode URL-safe base64 back to text; null when it is not valid base64. */
export function base64UrlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** The scenario's day one, 2025-01-01T00:00:00Z, in Unix seconds. */
export const SCENARIO_EPOCH_SEC = 1_735_689_600;

/**
 * A deterministic ISO timestamp: the scenario epoch plus `counter` seconds.
 * Stored data never reads the wall clock, so two runs over the same requests
 * produce the same bytes.
 */
export function fixedIso(counter: number): string {
  return new Date((SCENARIO_EPOCH_SEC + counter) * 1000).toISOString();
}

/** The fixed timestamp every issue, pull request and repo carries at rest. */
export const FIXED_ISO = '2025-01-01T00:00:00Z';

/**
 * Git's tree-entry sort: byte order of the name, a directory compared as if
 * its name ended in '/'. Two entries with equal keys keep their input order
 * (names are unique inside one tree, so this never matters in practice).
 */
export function compareTreeEntry(
  a: { name: string; mode: string },
  b: { name: string; mode: string },
): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Clamp `value` into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
