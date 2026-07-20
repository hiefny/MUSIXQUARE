/**
 * Same-tab OAuth return continuity for installed/mobile app shells.
 *
 * A standalone PWA cannot rely on a provider popup returning control to the
 * live room document. Keep one short-lived, same-tab intent in sessionStorage
 * so the callback can restore the exact PRO route and reclaim the presence
 * incarnation that belonged to this tab before OAuth navigation.
 */

const STORAGE_KEY = 'mxqr-account-login-return-v1';
const MAX_AGE_MS = 15 * 60 * 1000;

interface AccountLoginReturnIntent {
  returnTo: string;
  roomCode: string | null;
  createdAt: number;
}

function isSafeReturnPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    value.length <= 2048
  );
}

function parseIntent(raw: string | null, now = Date.now()): AccountLoginReturnIntent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AccountLoginReturnIntent>;
    if (
      !isSafeReturnPath(parsed.returnTo) ||
      (parsed.roomCode !== null &&
        (typeof parsed.roomCode !== 'string' || !/^\d{6}$/.test(parsed.roomCode))) ||
      typeof parsed.createdAt !== 'number' ||
      !Number.isFinite(parsed.createdAt) ||
      parsed.createdAt > now + 60_000 ||
      now - parsed.createdAt > MAX_AGE_MS
    ) {
      return null;
    }
    return {
      returnTo: parsed.returnTo,
      roomCode: parsed.roomCode ?? null,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

function readIntent(): AccountLoginReturnIntent | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const intent = parseIntent(raw);
    if (!intent && raw !== null) sessionStorage.removeItem(STORAGE_KEY);
    return intent;
  } catch {
    return null;
  }
}

export function rememberAccountLoginReturn(returnTo: string, roomCode: string | null): void {
  if (!isSafeReturnPath(returnTo) || (roomCode !== null && !/^\d{6}$/.test(roomCode))) return;
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        returnTo,
        roomCode,
        createdAt: Date.now(),
      } satisfies AccountLoginReturnIntent),
    );
  } catch {
    // Storage can be unavailable in hardened/private browser modes. OAuth still
    // works through its ordinary server-owned returnTo path in that case.
  }
}

/** Restore a PRO route before setup.ts reads the initial URL. */
export function restoreAccountLoginReturnPath(): boolean {
  const intent = readIntent();
  if (!intent?.roomCode || !/^\/?$/.test(window.location.pathname)) return false;

  const target = new URL(intent.returnTo, window.location.origin);
  if (target.origin !== window.location.origin || target.pathname !== `/${intent.roomCode}`) {
    clearAccountLoginReturn();
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

/** Whether a room resume may silently replace this tab's pre-OAuth incarnation. */
export function hasAccountLoginReturnForRoom(roomCode: string): boolean {
  return readIntent()?.roomCode === roomCode;
}

export function clearAccountLoginReturn(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort cleanup only.
  }
}

export const __accountLoginReturnForTests = {
  STORAGE_KEY,
  parseIntent,
};
