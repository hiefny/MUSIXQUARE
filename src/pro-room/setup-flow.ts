import { getState } from '../core/state.ts';
import { t } from '../i18n/index.ts';
import { showDialog } from '../ui/dialog.ts';
import { ProRoomApiError } from './api.ts';
import { takeProRoomClaimsFromFragment } from './claim-fragment.ts';
import { deriveTemporaryProRoomPin, isProRoomCode, normalizeProRoomPin } from './room-code.ts';
import { announceProRoomTabTakeover } from './tab-handoff.ts';
import { consumeAccountLoginReturnForRoom } from '../account/login-return.ts';

const PRO_ROOM_ENTRY_OPERATION_TIMEOUT_MS = 20_000;
const TERMINAL_CLAIM_ERROR_CODES = new Set([
  'ACTIVATION_INVALID',
  'ACTIVATION_UNAVAILABLE',
  'INVALID_CLAIM_TOKEN',
  'RECOVERY_INVALID',
  'RECOVERY_CAPACITY_EXCEEDED',
  'RECOVERY_CLAIM_USED',
  'RECOVERY_UNAVAILABLE',
  'INVALID_RECOVERY_CLAIM_TOKEN',
]);

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

function isTerminalClaimFailure(error: unknown): boolean {
  return error instanceof ProRoomApiError && TERMINAL_CLAIM_ERROR_CODES.has(error.code);
}

async function showNewClaimLinkGuidance(): Promise<void> {
  await showDialog({
    title: t('pro.claim_unavailable_title'),
    message: t('pro.new_link_message'),
    buttonText: t('common.ok'),
  });
}

async function runClaimProtectedOperation<T>(
  operation: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  while (true) {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      // Expired, used, invalid, and already-consumed claims must never be
      // replayed. Keep their server details collapsed to one safe message.
      if (isTerminalClaimFailure(error)) {
        await showNewClaimLinkGuidance();
        return { ok: false };
      }

      // A timeout or transport failure does not prove that the one-time
      // credential was consumed. Keep it only in this function closure while
      // the scrubbed setup screen offers an explicit retry.
      const result = await showDialog({
        title: t('pro.claim_retry_title'),
        message: t('pro.claim_retry_message'),
        buttonText: t('common.retry'),
        secondaryText: t('pro.request_new_link'),
        dismissible: false,
        defaultFocus: 'primary',
      });
      if (result.action === 'ok') continue;
      await showNewClaimLinkGuidance();
      return { ok: false };
    }
  }
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
  const hasClaimCredential =
    !!fragmentClaims.activationClaimToken || fragmentClaims.ownerRecoveryClaimPresent;
  // Lazy-load the runtime after the setup/guest module graph has initialized;
  // the runtime bridges back into peer.ts and would otherwise form an eager
  // guest -> runtime -> peer -> guest evaluation cycle at app startup.
  const runtimeResult = hasClaimCredential
    ? await runClaimProtectedOperation(() => import('./runtime.ts'))
    : { ok: true as const, value: await import('./runtime.ts') };
  if (!runtimeResult.ok) return false;
  const runtime = runtimeResult.value;
  // Consume this one-time route hint before any network turn. Only a marker
  // retained by this exact browsing context may silently reclaim its
  // pre-OAuth presence; a durable PWA-relaunch hint keeps the normal active-tab
  // confirmation boundary.
  const accountLoginReturn = consumeAccountLoginReturnForRoom(code);
  const returningFromSameTabLogin = accountLoginReturn?.allowSilentTakeover === true;
  const bootstrapResult = hasClaimCredential
    ? await runClaimProtectedOperation(() =>
        runEntryOperation((signal) => runtime.getProRoomBootstrap(code, signal)),
      )
    : {
        ok: true as const,
        value: await runEntryOperation((signal) => runtime.getProRoomBootstrap(code, signal)),
      };
  if (!bootstrapResult.ok) return false;
  const bootstrap = bootstrapResult.value;

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
    let activationAttempts = 0;
    const activation = await runClaimProtectedOperation(async () => {
      if (activationAttempts > 0) {
        const freshBootstrap = await runEntryOperation((signal) =>
          runtime.getProRoomBootstrap(code, signal),
        );
        if (freshBootstrap.status === 'pin_required') {
          try {
            return await runEntryOperation((signal) => runtime.resumeProRoom(code, { signal }));
          } catch (error) {
            if (isMissingCookieSession(error)) {
              throw new ProRoomApiError('ACTIVATION_UNAVAILABLE', 409);
            }
            throw error;
          }
        }
      }
      activationAttempts += 1;
      return runEntryOperation((signal) =>
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
    });
    return activation.ok;
  }

  if (fragmentClaims.ownerRecoveryClaimPresent) {
    const ownerRecoveryClaimToken = fragmentClaims.ownerRecoveryClaimToken;
    if (!ownerRecoveryClaimToken) {
      await showNewClaimLinkGuidance();
      return false;
    }
    let recoveryAttempts = 0;
    const recovery = await runClaimProtectedOperation(async () => {
      if (recoveryAttempts > 0) {
        try {
          return await runEntryOperation((signal) => runtime.resumeProRoom(code, { signal }));
        } catch (error) {
          if (!isMissingCookieSession(error)) throw error;
        }
      }
      recoveryAttempts += 1;
      return runEntryOperation((signal) =>
        runtime.recoverProRoomOwner(
          {
            code,
            claimToken: ownerRecoveryClaimToken,
          },
          signal,
        ),
      );
    });
    return recovery.ok;
  }

  // A host-only HttpOnly cookie survives a reload. Try it before asking for
  // the 8-digit PIN again; only an authentication miss falls through.
  try {
    await runEntryOperation((signal) => runtime.resumeProRoom(code, { signal }));
    return true;
  } catch (error) {
    if (isActiveInAnotherTab(error)) {
      if (returningFromSameTabLogin) {
        await runEntryOperation((signal) =>
          runtime.resumeProRoom(code, { takeover: true, signal }),
        );
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
