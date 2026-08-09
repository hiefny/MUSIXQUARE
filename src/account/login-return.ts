/**
 * OAuth return continuity for installed/mobile app shells.
 *
 * The exact route stays in sessionStorage for an ordinary same-context OAuth
 * round trip. A second, deliberately narrower record survives a fully closed
 * installed PWA: it contains only the PRO room path and is therefore a route
 * hint, never evidence of authentication, room authority, or same-tab
 * ownership.
 */

const SESSION_STORAGE_KEY = 'mxqr-account-login-return-v1';
const DURABLE_STORAGE_KEY = 'mxqr-account-login-return-durable-v1';
const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60_000;
const ATTEMPT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const PRO_ROOM_CODE_RE = /^0\d{5}$/;
const SENSITIVE_RETURN_PARAMETER_RE =
  /^(?:pin|pro[-_]?pin|password|passcode|token|access[-_]?token|refresh[-_]?token|id[-_]?token|claim(?:[-_]?token)?|pro[-_]?claim|pro[-_]?recovery|pro[-_]?transfer|session(?:[-_]?(?:id|secret|token))?|secret|credential|authorization|auth[-_]?code|oauth[-_]?code|code|state|nonce|api[-_]?key|jwt)$/i;

interface AccountLoginReturnIntent {
  attemptId: string;
  allowSilentTakeover: boolean;
  returnTo: string;
  roomCode: string;
  createdAt: number;
}

interface AccountLoginReturnRecovery {
  /** Only a live same-context marker may reclaim its pre-OAuth incarnation. */
  allowSilentTakeover: boolean;
  source: 'same-context' | 'pwa-relaunch';
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isSafeReturnPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !hasUnsafeControlCharacter(value) &&
    value.length <= 2048
  );
}

/** Remove credential-shaped URL material before either OAuth or app storage. */
export function sanitizeAccountLoginReturnPath(returnTo: string): string | null {
  if (!isSafeReturnPath(returnTo)) return null;
  try {
    const target = new URL(returnTo, window.location.origin);
    if (target.origin !== window.location.origin) return null;
    for (const key of [...target.searchParams.keys()]) {
      if (SENSITIVE_RETURN_PARAMETER_RE.test(key)) target.searchParams.delete(key);
    }
    const fragment = new URLSearchParams(target.hash.startsWith('#') ? target.hash.slice(1) : '');
    if ([...fragment.keys()].some((key) => SENSITIVE_RETURN_PARAMETER_RE.test(key))) {
      // PRO claim consumption deliberately scrubs the complete fragment, not
      // selected pairs, so unrelated fragment state cannot retain a secret in
      // a malformed/duplicated encoding.
      target.hash = '';
    }
    return `${target.pathname}${target.search}${target.hash}` || '/';
  } catch {
    return null;
  }
}

function parseIntent(
  raw: string | null,
  now = Date.now(),
  durable = false,
): AccountLoginReturnIntent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AccountLoginReturnIntent>;
    if (
      !isSafeReturnPath(parsed.returnTo) ||
      typeof parsed.roomCode !== 'string' ||
      !PRO_ROOM_CODE_RE.test(parsed.roomCode) ||
      typeof parsed.attemptId !== 'string' ||
      !ATTEMPT_ID_RE.test(parsed.attemptId) ||
      typeof parsed.allowSilentTakeover !== 'boolean' ||
      typeof parsed.createdAt !== 'number' ||
      !Number.isFinite(parsed.createdAt) ||
      parsed.createdAt > now + MAX_FUTURE_SKEW_MS ||
      now - parsed.createdAt > MAX_AGE_MS
    ) {
      return null;
    }

    // Durable storage is intentionally an exact, credential-free room path.
    // Session records may keep harmless UI query/hash state, but no query,
    // fragment, PIN, claim, or account material is persisted durably.
    if (durable && (parsed.allowSilentTakeover || parsed.returnTo !== `/${parsed.roomCode}`)) {
      return null;
    }

    return {
      attemptId: parsed.attemptId,
      allowSilentTakeover: parsed.allowSilentTakeover,
      returnTo: parsed.returnTo,
      roomCode: parsed.roomCode,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

function readIntent(
  storage: Storage,
  key: string,
  durable = false,
): AccountLoginReturnIntent | null {
  try {
    const raw = storage.getItem(key);
    const intent = parseIntent(raw, Date.now(), durable);
    if (!intent && raw !== null) storage.removeItem(key);
    return intent;
  } catch {
    return null;
  }
}

function readSessionIntent(): AccountLoginReturnIntent | null {
  try {
    return readIntent(window.sessionStorage, SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readDurableIntent(): AccountLoginReturnIntent | null {
  try {
    return readIntent(window.localStorage, DURABLE_STORAGE_KEY, true);
  } catch {
    return null;
  }
}

function removeIntent(storage: Storage, key: string, attemptId?: string): void {
  try {
    if (attemptId !== undefined) {
      const current = readIntent(storage, key, key === DURABLE_STORAGE_KEY);
      if (current?.attemptId !== attemptId) return;
    }
    storage.removeItem(key);
  } catch {
    // Best-effort cleanup only.
  }
}

function clearAttempt(attemptId: string): void {
  try {
    removeIntent(window.sessionStorage, SESSION_STORAGE_KEY, attemptId);
  } catch {
    // Storage can be unavailable in hardened/private browser modes.
  }
  try {
    removeIntent(window.localStorage, DURABLE_STORAGE_KEY, attemptId);
  } catch {
    // Storage can be unavailable in hardened/private browser modes.
  }
}

function createAttemptId(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Fall through to a non-authoritative correlation token.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function returnPathMatchesRoom(returnTo: string, roomCode: string): boolean {
  try {
    const target = new URL(returnTo, window.location.origin);
    return target.origin === window.location.origin && target.pathname === `/${roomCode}`;
  } catch {
    return false;
  }
}

function isStandaloneAppContext(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches === true) return true;
  } catch {
    // Fall through to the iOS installation hint.
  }
  try {
    return (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/**
 * Remember one same-tab OAuth attempt and, for PRO rooms, one minimal durable
 * relaunch path. The returned ID lets a cancelled anchor navigation clear only
 * its own record without deleting a newer attempt from another tab.
 */
export function rememberAccountLoginReturn(
  returnTo: string,
  roomCode: string | null,
  options: { allowSilentTakeover?: boolean } = {},
): string | null {
  // Non-PRO routes already round-trip through the server-owned returnTo and
  // have no presence incarnation to reclaim. Do not create stale app storage
  // for ordinary account login.
  if (roomCode === null) return null;
  const sanitizedReturnTo = sanitizeAccountLoginReturnPath(returnTo);
  if (
    !sanitizedReturnTo ||
    !PRO_ROOM_CODE_RE.test(roomCode) ||
    !returnPathMatchesRoom(sanitizedReturnTo, roomCode)
  ) {
    return null;
  }

  const attemptId = createAttemptId();
  const createdAt = Date.now();
  const sessionIntent: AccountLoginReturnIntent = {
    attemptId,
    allowSilentTakeover: options.allowSilentTakeover === true,
    returnTo: sanitizedReturnTo,
    roomCode,
    createdAt,
  };
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessionIntent));
  } catch {
    // The server-owned returnTo remains the normal callback path.
  }

  const durableIntent: AccountLoginReturnIntent = {
    attemptId,
    allowSilentTakeover: false,
    // Never copy query/fragment data into localStorage. In particular this
    // excludes PRO claims, PIN-like values, and account callback material.
    returnTo: `/${roomCode}`,
    roomCode,
    createdAt,
  };
  try {
    window.localStorage.setItem(DURABLE_STORAGE_KEY, JSON.stringify(durableIntent));
  } catch {
    // Same-context OAuth still works through sessionStorage/server returnTo.
  }
  return attemptId;
}

/** Restore a PRO route before setup.ts reads the initial URL. */
export function restoreAccountLoginReturnPath(): boolean {
  const sessionIntent = readSessionIntent();
  // Validate the durable slot on every startup, including ordinary browser
  // tabs that deliberately must not consume it. Otherwise an abandoned
  // popup-blocked/same-tab attempt could leave an expired route record in
  // localStorage indefinitely simply because the next launch was not an
  // installed PWA.
  const durableIntent = readDurableIntent();
  const intent = sessionIntent ?? (isStandaloneAppContext() ? durableIntent : null);
  if (!intent || !/^\/?$/.test(window.location.pathname)) return false;

  const target = new URL(intent.returnTo, window.location.origin);
  if (target.origin !== window.location.origin || target.pathname !== `/${intent.roomCode}`) {
    clearAttempt(intent.attemptId);
    return false;
  }

  const current = new URL(window.location.href);
  for (const marker of current.searchParams.getAll('accountAuth')) {
    target.searchParams.append('accountAuth', marker);
  }
  try {
    window.history.replaceState(
      window.history.state,
      '',
      `${target.pathname}${target.search}${target.hash}`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Consume the route hint exactly once when PRO setup starts. A durable PWA
 * relaunch can restore/navigate, but it cannot silently displace another tab.
 */
export function consumeAccountLoginReturnForRoom(
  roomCode: string,
): AccountLoginReturnRecovery | null {
  const sessionIntent = readSessionIntent();
  if (sessionIntent?.roomCode === roomCode) {
    clearAttempt(sessionIntent.attemptId);
    return {
      allowSilentTakeover: sessionIntent.allowSilentTakeover,
      source: 'same-context',
    };
  }

  // A valid marker for a different live browsing context must win over the
  // shared durable slot. This avoids treating another tab's attempt as ours.
  if (sessionIntent || !isStandaloneAppContext()) return null;
  const durableIntent = readDurableIntent();
  if (durableIntent?.roomCode !== roomCode) return null;
  if (durableIntent.attemptId) clearAttempt(durableIntent.attemptId);
  else removeIntent(window.localStorage, DURABLE_STORAGE_KEY);
  return { allowSilentTakeover: false, source: 'pwa-relaunch' };
}

/** Clear only the OAuth attempt owned by this browsing context. */
export function clearCurrentAccountLoginReturn(): void {
  const sessionIntent = readSessionIntent();
  if (sessionIntent) {
    clearAttempt(sessionIntent.attemptId);
    return;
  }
  // Never remove the shared durable slot here because it may belong to another
  // active tab.
  removeIntent(window.sessionStorage, SESSION_STORAGE_KEY);
}

export function clearAccountLoginReturn(attemptId?: string): void {
  if (attemptId !== undefined) {
    clearAttempt(attemptId);
    return;
  }
  try {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Best-effort cleanup only.
  }
  try {
    window.localStorage.removeItem(DURABLE_STORAGE_KEY);
  } catch {
    // Best-effort cleanup only.
  }
}

export const __accountLoginReturnForTests = {
  STORAGE_KEY: SESSION_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  DURABLE_STORAGE_KEY,
  MAX_AGE_MS,
  parseIntent,
};
