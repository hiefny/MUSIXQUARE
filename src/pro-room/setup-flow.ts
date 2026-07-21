import { getState } from '../core/state.ts';
import { t } from '../i18n/index.ts';
import { showDialog } from '../ui/dialog.ts';
import { ProRoomApiError } from './api.ts';
import { takeProRoomClaimsFromFragment } from './claim-fragment.ts';
import { deriveTemporaryProRoomPin, isProRoomCode, normalizeProRoomPin } from './room-code.ts';
import { announceProRoomTabTakeover } from './tab-handoff.ts';
import { clearAccountLoginReturn, hasAccountLoginReturnForRoom } from '../account/login-return.ts';

const PRO_ROOM_ENTRY_OPERATION_TIMEOUT_MS = 20_000;

/**
 * Bound only one network-facing entry operation. Each prompt gets a fresh
 * deadline so time spent entering a PIN or confirming a takeover never counts
 * as a connection failure.
 */
async function runEntryOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const timeoutError = new ProRoomApiError('PRO_ROOM_ENTRY_TIMEOUT', 408);
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = globalThis.setTimeout(() => {
      timedOut = true;
      abort.abort();
      reject(timeoutError);
    }, PRO_ROOM_ENTRY_OPERATION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([Promise.resolve().then(() => operation(abort.signal)), deadline]);
  } catch (error) {
    // Abort-aware fetches can reject synchronously from abort before the
    // deadline promise wins the race. Preserve one stable user-facing cause.
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    if (timeout !== null) globalThis.clearTimeout(timeout);
  }
}

async function showUnavailable(title: string, message: string): Promise<void> {
  await showDialog({ title, message, buttonText: t('common.ok') });
}

async function promptPin(options: {
  title: string;
  message: string;
  autocomplete: string;
  temporaryPin?: string;
}): Promise<string | null> {
  const result = await showDialog({
    title: options.title,
    message: options.message,
    inputField: {
      placeholder: t('dialog.room_password_placeholder'),
      maxLength: 8,
      inputMode: 'numeric',
      pattern: '[0-9]*',
      autocomplete: options.autocomplete,
      splitEvery: 4,
      separator: '-',
      validator: (value) => {
        const pin = normalizeProRoomPin(value);
        if (!pin) return t('connect.room_password_invalid');
        if (options.temporaryPin && pin === options.temporaryPin) {
          return t('pro.activation_pin_same');
        }
        return null;
      },
    },
    buttonText: t('common.ok'),
    secondaryText: t('common.cancel'),
    defaultFocus: 'primary',
  });
  return result.action === 'ok' ? normalizeProRoomPin(result.inputValue) : null;
}

function isMissingCookieSession(error: unknown): boolean {
  return (
    error instanceof ProRoomApiError && (error.status === 401 || error.code === 'SESSION_REQUIRED')
  );
}

function isActiveInAnotherTab(error: unknown): boolean {
  return error instanceof ProRoomApiError && error.code === 'PRESENCE_ACTIVE_ELSEWHERE';
}

/**
 * Authenticate and connect a reserved PRO room. UI orchestration remains here
 * while the runtime owns cookies, authority, heartbeats, and WebRTC topology.
 */
export async function enterProRoomFromSetup(code: string): Promise<boolean> {
  if (!isProRoomCode(code)) throw new Error('INVALID_PRO_ROOM_CODE');
  // Consume and scrub both one-time credentials before the first dynamic
  // import, network request, or dialog turn can yield back to the browser.
  const fragmentClaims = takeProRoomClaimsFromFragment();
  // Lazy-load the runtime after the setup/guest module graph has initialized;
  // the runtime bridges back into peer.ts and would otherwise form an eager
  // guest -> runtime -> peer -> guest evaluation cycle at app startup.
  const runtime = await import('./runtime.ts');
  const returningFromSameTabLogin = hasAccountLoginReturnForRoom(code);
  const bootstrap = await runEntryOperation((signal) => runtime.getProRoomBootstrap(code, signal));

  if (bootstrap.status === 'suspended') {
    await showUnavailable(t('pro.suspended_title'), t('pro.suspended_message'));
    return false;
  }

  if (bootstrap.status === 'activation_required') {
    const activationClaimToken = fragmentClaims.activationClaimToken;
    if (!activationClaimToken) {
      await showUnavailable(t('pro.not_ready_title'), t('pro.not_ready_message'));
      return false;
    }
    const temporaryPin = deriveTemporaryProRoomPin(code);
    const newPin = await promptPin({
      title: t('pro.activation_title'),
      message: t('pro.activation_message'),
      autocomplete: 'new-password',
      temporaryPin,
    });
    if (!newPin) return false;
    await runEntryOperation((signal) =>
      runtime.activateProRoom(
        {
          code,
          claimToken: activationClaimToken,
          temporaryPin,
          newPin,
          ownerName: getState('network.myDeviceLabel') || 'Owner',
        },
        signal,
      ),
    );
    return true;
  }

  if (fragmentClaims.ownerRecoveryClaimPresent) {
    const ownerRecoveryClaimToken = fragmentClaims.ownerRecoveryClaimToken;
    if (!ownerRecoveryClaimToken) {
      await showUnavailable(t('pro.suspended_title'), t('pro.connect_failed'));
      return false;
    }
    try {
      await runEntryOperation((signal) =>
        runtime.recoverProRoomOwner(
          {
            code,
            claimToken: ownerRecoveryClaimToken,
          },
          signal,
        ),
      );
      return true;
    } catch {
      // Recovery failures deliberately collapse to one generic UI result. A
      // used, expired, wrong-room, or invalid claim must not expose server
      // details or silently fall through to the normal PIN flow.
      await showUnavailable(t('pro.suspended_title'), t('pro.connect_failed'));
      return false;
    }
  }

  // A host-only HttpOnly cookie survives a reload. Try it before asking for
  // the 8-digit PIN again; only an authentication miss falls through.
  try {
    await runEntryOperation((signal) => runtime.resumeProRoom(code, { signal }));
    if (returningFromSameTabLogin) clearAccountLoginReturn();
    return true;
  } catch (error) {
    if (isActiveInAnotherTab(error)) {
      if (returningFromSameTabLogin) {
        await runEntryOperation((signal) =>
          runtime.resumeProRoom(code, { takeover: true, signal }),
        );
        clearAccountLoginReturn();
        announceProRoomTabTakeover(code);
        return true;
      }
      const result = await showDialog({
        title: t('pro.active_tab_title'),
        message: t('pro.active_tab_message'),
        buttonText: t('pro.use_this_tab'),
        secondaryText: t('common.cancel'),
        dismissible: false,
        defaultFocus: 'secondary',
      });
      if (result.action !== 'ok') return false;
      await runEntryOperation((signal) => runtime.resumeProRoom(code, { takeover: true, signal }));
      // The server is the source of truth. Broadcast only after it commits the
      // new incarnation so the previous tab can stop immediately instead of
      // waiting for its next signaling/heartbeat failure.
      announceProRoomTabTakeover(code);
      return true;
    }
    if (!isMissingCookieSession(error)) throw error;
    if (returningFromSameTabLogin) clearAccountLoginReturn();
  }

  let retry = false;
  while (true) {
    const pin = await promptPin({
      title: t('pro.pin_title'),
      message: t(retry ? 'pro.pin_retry_message' : 'pro.pin_message'),
      autocomplete: 'current-password',
    });
    if (!pin) return false;
    try {
      await runEntryOperation((signal) =>
        runtime.joinProRoom(
          {
            code,
            pin,
          },
          signal,
        ),
      );
      if (returningFromSameTabLogin) clearAccountLoginReturn();
      return true;
    } catch (error) {
      if (error instanceof ProRoomApiError && error.code === 'PIN_INVALID') {
        retry = true;
        continue;
      }
      throw error;
    }
  }
}
