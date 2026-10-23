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

export type AccountAuthOutcome = 'success' | 'cancelled' | 'error';

/**
 * A pulse as the app reads it (C8-I4: the one parser for every transport).
 * A field a receiver cannot rely on is null, so one result serves both uses:
 * the session reconciles any pulse, by its id when it has one, and the account
 * UI acts only on a completion result that has all three fields.
 */
export interface AccountPulse {
  /** The nonce shared by one change's copies on every transport. */
  readonly id: string | null;
  /** The completion page's outcome; null on a mutation pulse or an unknown value. */
  readonly auth: AccountAuthOutcome | null;
  /** The tab that opened the login. */
  readonly accountClient: string | null;
}

function isAccountPulseToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= ACCOUNT_PULSE_TOKEN_MIN_LENGTH &&
    value.length <= ACCOUNT_PULSE_TOKEN_MAX_LENGTH
  );
}

function parseAccountAuthOutcome(value: unknown): AccountAuthOutcome | null {
  return value === 'success' || value === 'cancelled' || value === 'error' ? value : null;
}

/** Read a BroadcastChannel or window message; null when it is not a pulse at all. */
export function parseAccountPulse(value: unknown): AccountPulse | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as {
    type?: unknown;
    accountAuth?: unknown;
    id?: unknown;
    accountClient?: unknown;
  };
  if (message.type !== 'refresh') return null;
  return {
    id: isAccountPulseToken(message.id) ? message.id : null,
    auth: parseAccountAuthOutcome(message.accountAuth),
    accountClient: isAccountPulseToken(message.accountClient) ? message.accountClient : null,
  };
}

/**
 * Read the new value of a storage event for ACCOUNT_SYNC_STORAGE_KEY. Null
 * when the key was removed or the value is not pulse JSON, including the
 * opaque token older clients stored; the session still refreshes on those as
 * an unidentified pulse, and they never carry a login result.
 */
export function parseAccountPulseStorageValue(newValue: string | null): AccountPulse | null {
  if (!newValue) return null;
  try {
    return parseAccountPulse(JSON.parse(newValue) as unknown);
  } catch {
    return null;
  }
}

/** A mutation pulse. Its BroadcastChannel and storage copies share the one nonce. */
export function createAccountRefreshMessage(): { type: 'refresh'; id: string } {
  return {
    type: 'refresh',
    id: `refresh:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
  };
}
