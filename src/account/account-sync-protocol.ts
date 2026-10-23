/**
 * Account pulse wire contract (registry RO-28; structural plan C8-I1).
 *
 * Documents on the origin wake each other after an account change with one
 * pulse: a BroadcastChannel message on ACCOUNT_SYNC_CHANNEL, the same JSON
 * under ACCOUNT_SYNC_STORAGE_KEY in localStorage (its storage event reaches
 * tabs without BroadcastChannel) and, from the OAuth completion page, a
 * window message to an opener that survived. The pulse carries no account
 * data; every receiver re-reads the HttpOnly session.
 *
 * - An app tab's account mutation: `{ type: 'refresh', id }`.
 * - The OAuth completion page: `{ type: 'refresh', accountAuth, id,
 *   accountClient }`, where accountAuth is 'success', 'cancelled' or 'error'
 *   and accountClient names the tab that opened the login.
 *
 * Tabs opened before a deploy keep their old code on the same channel and key,
 * so these literals and field names are frozen. The OAuth completion page
 * (browser/classic-runtime/account-complete.ts) and the events page
 * (browser/classic-runtime/events/event.ts) are classic runtimes compiled one
 * file at a time and cannot import this module, so they keep their own copies
 * (owner decision O6, 2026-10-23), pinned against these values by
 * src/account/__tests__/account-pulse-contract.test.ts.
 */

export const ACCOUNT_SYNC_CHANNEL = 'mxqr-account-v1';
export const ACCOUNT_SYNC_STORAGE_KEY = 'mxqr-account-refresh';

/** Receivers accept a pulse id and an accountClient token of 8 to 160 characters. */
const ACCOUNT_PULSE_TOKEN_MIN_LENGTH = 8;
const ACCOUNT_PULSE_TOKEN_MAX_LENGTH = 160;

export function isAccountPulseToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= ACCOUNT_PULSE_TOKEN_MIN_LENGTH &&
    value.length <= ACCOUNT_PULSE_TOKEN_MAX_LENGTH
  );
}

/** A mutation pulse. Its BroadcastChannel and storage copies share the one nonce. */
export function createAccountRefreshMessage(): { type: 'refresh'; id: string } {
  return {
    type: 'refresh',
    id: `refresh:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
  };
}
