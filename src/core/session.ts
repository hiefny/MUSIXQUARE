/**
 * MUSIXQUARE 2.0 — Session ID Management
 * Extracted from original app.js lines 51-54, 272-294, 1369-1372
 */

import { log } from './log.ts';

// ─── Instance ID (unique per app load) ─────────────────────────────

export const INSTANCE_ID: string =
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 11);

// ─── Session ID Generator ──────────────────────────────────────────

let _globalSessionCounter = Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 100000);

export function nextSessionId(): number {
  return ++_globalSessionCounter;
}

// ─── Session ID Validation ─────────────────────────────────────────

const _warnedBadSessionIds = new Set<string>();

/**
 * Validate and normalize a session ID to a safe integer.
 * Returns 0 for invalid IDs (0 is the "no-session" sentinel).
 *
 * @param id   - The raw session ID (may be string, number, undefined)
 * @param strict - If true, throws on invalid ID instead of returning 0
 */
export function validateSessionId(id: unknown, strict = false): number {
  const n = Number(id);
  const sid = Number.isFinite(n) ? Math.trunc(n) : 0;

  const ok = Number.isSafeInteger(sid) && sid > 0;
  if (!ok) {
    const key = String(id);
    // Prevent unbounded growth
    if (_warnedBadSessionIds.size > 200) _warnedBadSessionIds.clear();
    if (!_warnedBadSessionIds.has(key)) {
      _warnedBadSessionIds.add(key);
      log.warn(`[Session] Invalid sessionId (${typeof id}):`, id);
    }
    if (strict) {
      throw new Error(`Invalid sessionId: ${id}`);
    }
    return 0;
  }
  return sid;
}
