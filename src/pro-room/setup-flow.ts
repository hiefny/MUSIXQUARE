import { getState } from '../core/state.ts';
import { t } from '../i18n/index.ts';
import { showDialog } from '../ui/dialog.ts';
import { ProRoomApiError } from './api.ts';
import { takeProRoomClaimsFromFragment } from './claim-fragment.ts';
import { createProRoomIdempotencyKey } from './idempotency.ts';
import { deriveTemporaryProRoomPin, isProRoomCode, normalizeProRoomPin } from './room-code.ts';
import { announceProRoomTabTakeover } from './tab-handoff.ts';
import { consumeAccountLoginReturnForRoom } from '../account/login-return.ts';
import {
  requestAccountLoginPopup,
  type AccountLoginPopupOutcome,
  type AccountLoginPopupOptions,
} from '../account/session.ts';

const PRO_ROOM_ENTRY_OPERATION_TIMEOUT_MS = 20_000;
const PENDING_SESSION_REQUEST_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
const pendingSessionRequestIds = new Map<string, string>();
// A reload starts its keepalive presence-close request before the replacement
// document enters, but the two requests can still reach the server out of
// order. Give that close a short grace window and retry without takeover once
// before describing the surviving presence as another tab.
const ACTIVE_TAB_RELEASE_RETRY_DELAY_MS = 750;
const TERMINAL_CLAIM_ERROR_CODES = new Set([
  'ACTIVATION_INVALID',
  'ACTIVATION_UNAVAILABLE',
  'INVALID_CLAIM_TOKEN',
  'RECOVERY_INVALID',
  'RECOVERY_CAPACITY_EXCEEDED',
  'RECOVERY_CLAIM_USED',
  'RECOVERY_UNAVAILABLE',
  'INVALID_RECOVERY_CLAIM_TOKEN',
  'OWNER_TRANSFER_CLAIM_EXPIRED',
  'OWNER_TRANSFER_CLAIM_INVALID',
  'OWNER_TRANSFER_CLAIM_STALE',
  'OWNER_TRANSFER_CLAIM_USED',
  'INVALID_TRANSFER_CLAIM_TOKEN',
]);
const CLAIM_ACCOUNT_CONFLICT_ERROR_CODES = new Set([
  'OWNER_ACCOUNT_LINK_CONFLICT',
  'SESSION_ACCOUNT_CONFLICT',
  'OWNER_TRANSFER_TARGET_ACCOUNT_MISMATCH',
]);
const CLAIM_ACCOUNT_CAPACITY_ERROR_CODES = new Set([
  'ACCOUNT_MEMBER_CAPACITY_EXCEEDED',
  'ACCOUNT_PRO_ROOM_LIMIT_REACHED',
]);

function pendingSessionRequestStorageKey(code: string): string {
  return `mxqr-pro-session-request:${code}`;
}

function getOrCreatePendingSessionRequestId(code: string): string {
  const memoryValue = pendingSessionRequestIds.get(code);
  if (memoryValue) return memoryValue;
  const storageKey = pendingSessionRequestStorageKey(code);
  try {
    const stored = sessionStorage.getItem(storageKey) || '';
    if (PENDING_SESSION_REQUEST_ID_RE.test(stored)) {
      pendingSessionRequestIds.set(code, stored);
      return stored;
    }
    if (stored) sessionStorage.removeItem(storageKey);
  } catch {
    // Restricted WebViews may deny sessionStorage; memory remains authoritative.
  }
  const created = createProRoomIdempotencyKey();
  pendingSessionRequestIds.set(code, created);
  try {
    sessionStorage.setItem(storageKey, created);
  } catch {
    // The module-scoped value still protects explicit retries in this tab.
  }
  return created;
}

function clearPendingSessionRequestId(code: string): void {
  pendingSessionRequestIds.delete(code);
  try {
    sessionStorage.removeItem(pendingSessionRequestStorageKey(code));
  } catch {
    // Storage is best-effort; memory was already cleared.
  }
}

function isDefinitiveSessionAdmissionError(error: unknown): boolean {
  return (
    error instanceof ProRoomApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    // This deadline is raised locally while the App/DO operation can still
    // commit after the browser stops waiting, so it remains outcome-unknown.
    error.code !== 'PRO_ROOM_ENTRY_TIMEOUT'
  );
}

export function clearPendingSessionRequestIdsForTests(): void {
  pendingSessionRequestIds.clear();
}

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
  return (
    error instanceof ProRoomApiError &&
    (TERMINAL_CLAIM_ERROR_CODES.has(error.code) || error.status === 404 || error.status === 410)
  );
}

function isClaimAccountRequired(error: unknown): boolean {
  return error instanceof ProRoomApiError && error.code === 'ACCOUNT_SESSION_REQUIRED';
}

function isClaimAccountConflict(error: unknown): boolean {
  return error instanceof ProRoomApiError && CLAIM_ACCOUNT_CONFLICT_ERROR_CODES.has(error.code);
}

function isClaimAccountCapacityFailure(error: unknown): boolean {
  return error instanceof ProRoomApiError && CLAIM_ACCOUNT_CAPACITY_ERROR_CODES.has(error.code);
}

function isTransientClaimFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return (
    error instanceof ProRoomApiError &&
    (error.code === 'NETWORK_ERROR' ||
      error.status === 408 ||
      (error.status >= 500 && error.status <= 599))
  );
}

async function showNewClaimLinkGuidance(): Promise<void> {
  await showDialog({
    title: t('pro.claim_unavailable_title'),
    message: t('pro.new_link_message'),
    buttonText: t('common.ok'),
  });
}

async function showClaimAccountConflict(): Promise<void> {
  await showDialog({
    title: t('pro.claim_account_conflict_title'),
    message: t('pro.claim_account_conflict_message'),
    buttonText: t('common.ok'),
  });
}

async function showClaimAccountCapacityFailure(): Promise<void> {
  await showDialog({
    title: t('pro.claim_account_capacity_title'),
    message: t('pro.claim_account_capacity_message'),
    buttonText: t('common.ok'),
  });
}

async function showClaimRequestRejected(): Promise<void> {
  await showDialog({
    title: t('pro.claim_failed_title'),
    message: t('pro.claim_failed_message'),
    buttonText: t('common.ok'),
  });
}

async function requestClaimAccountLogin(options: {
  requiresExistingAccount: boolean;
}): Promise<boolean> {
  let popupWasBlocked = false;
  let chooseAnotherAccount = false;
  while (true) {
    const loginAttempt: {
      current: Promise<AccountLoginPopupOutcome> | null;
    } = { current: null };
    const popupOptions: AccountLoginPopupOptions = options.requiresExistingAccount
      ? {
          acceptIncompleteProfile: true,
          forceGoogleAccountChooser: chooseAnotherAccount,
        }
      : {};
    const showingExistingAccountGuidance = options.requiresExistingAccount && !popupWasBlocked;
    const result = await showDialog({
      title: t(
        showingExistingAccountGuidance
          ? 'pro.claim_existing_account_title'
          : 'pro.claim_login_title',
      ),
      message: t(
        popupWasBlocked
          ? 'pro.claim_popup_blocked_message'
          : showingExistingAccountGuidance
            ? 'pro.claim_existing_account_message'
            : 'pro.claim_login_message',
      ),
      buttonText: t(
        popupWasBlocked
          ? 'common.retry'
          : showingExistingAccountGuidance
            ? chooseAnotherAccount
              ? 'pro.claim_choose_account_button'
              : 'pro.claim_login_button'
            : 'pro.claim_login_button',
      ),
      secondaryText: t('common.cancel'),
      dismissible: false,
      defaultFocus: 'primary',
      onPrimaryActivation: () => {
        loginAttempt.current = requestAccountLoginPopup(popupOptions);
      },
    });
    if (result.action !== 'ok') {
      if (showingExistingAccountGuidance) return false;
      await showUnavailable(t('pro.claim_login_title'), t('account.login_cancelled'));
      return false;
    }

    const outcome: AccountLoginPopupOutcome = await (loginAttempt.current ??
      Promise.resolve('error' as const));
    if (outcome === 'authenticated') return true;
    if (outcome === 'profile-incomplete' && options.requiresExistingAccount) {
      // Owner transfer and recovery are issued only for an already completed,
      // active account. A new/incomplete profile therefore proves that Google
      // returned a different identity. Keep the claim in this closure and let
      // the user reopen the account chooser without creating a nickname.
      chooseAnotherAccount = true;
      popupWasBlocked = false;
      continue;
    }
    if (outcome === 'blocked') {
      popupWasBlocked = true;
      continue;
    }
    await showUnavailable(
      t('pro.claim_login_title'),
      t(outcome === 'cancelled' ? 'account.login_cancelled' : 'account.login_failed'),
    );
    return false;
  }
}

async function runClaimProtectedOperation<T>(
  operation: () => Promise<T>,
  options: { requiresExistingAccount?: boolean } = {},
): Promise<{ ok: true; value: T } | { ok: false }> {
  let accountLoginCompleted = false;
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

      if (isClaimAccountRequired(error)) {
        // A completed profile is required for the account assertion. Do not
        // spin forever if a supposedly completed login is still rejected.
        if (accountLoginCompleted) {
          await showUnavailable(t('pro.claim_login_title'), t('account.login_failed'));
          return { ok: false };
        }
        if (
          !(await requestClaimAccountLogin({
            requiresExistingAccount: options.requiresExistingAccount === true,
          }))
        ) {
          return { ok: false };
        }
        accountLoginCompleted = true;
        continue;
      }

      if (isClaimAccountConflict(error)) {
        await showClaimAccountConflict();
        return { ok: false };
      }

      if (isClaimAccountCapacityFailure(error)) {
        await showClaimAccountCapacityFailure();
        return { ok: false };
      }

      // 429 and unknown 4xx/409/423 responses are not safe to replay. Only a
      // transport exception, explicit timeout, or 5xx service failure offers
      // the one-time claim again.
      if (!isTransientClaimFailure(error)) {
        await showClaimRequestRejected();
        return { ok: false };
      }

      // A timeout or transport failure does not prove that the one-time
      // credential was consumed. Keep it only in this function closure while
      // the scrubbed setup screen offers an explicit retry.
      const result = await showDialog({
        title: t('pro.claim_retry_title'),
        message: t('pro.claim_retry_message'),
        buttonText: t('common.retry'),
        secondaryText: t('common.close'),
        dismissible: false,
        defaultFocus: 'primary',
      });
      if (result.action === 'ok') continue;
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

function waitForActiveTabRelease(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ACTIVE_TAB_RELEASE_RETRY_DELAY_MS);
  });
}

/**
 * Authenticate and connect a reserved PRO room. UI orchestration remains here
 * while the runtime owns cookies, authority, heartbeats, and WebRTC topology.
 */
export async function enterProRoomFromSetup(code: string): Promise<boolean> {
  if (!isProRoomCode(code)) throw new Error('INVALID_PRO_ROOM_CODE');
  // Consume and scrub every one-time credential before the first dynamic
  // import, network request, or dialog turn can yield back to the browser.
  const fragmentClaims = takeProRoomClaimsFromFragment();
  const activationClaimPresent =
    fragmentClaims.activationClaimPresent || !!fragmentClaims.activationClaimToken;
  const ownerRecoveryClaimPresent =
    fragmentClaims.ownerRecoveryClaimPresent || !!fragmentClaims.ownerRecoveryClaimToken;
  const ownerTransferClaimPresent =
    fragmentClaims.ownerTransferClaimPresent || !!fragmentClaims.ownerTransferClaimToken;
  const claimPurposeCount =
    Number(activationClaimPresent) +
    Number(ownerRecoveryClaimPresent) +
    Number(ownerTransferClaimPresent);

  // Reject damaged, duplicated, or mixed one-time credentials locally. They
  // must never encounter an outage retry dialog before their terminal result.
  if (
    claimPurposeCount > 1 ||
    (activationClaimPresent && !fragmentClaims.activationClaimToken) ||
    (ownerRecoveryClaimPresent && !fragmentClaims.ownerRecoveryClaimToken) ||
    (ownerTransferClaimPresent && !fragmentClaims.ownerTransferClaimToken)
  ) {
    await showNewClaimLinkGuidance();
    return false;
  }

  const ownerTransferRequestId = ownerTransferClaimPresent ? createProRoomIdempotencyKey() : null;
  const existingOwnerLoginPolicy = {
    // Recovery is also bound to the room's already linked owner account. Only
    // first activation may legitimately continue through profile creation.
    requiresExistingAccount: ownerTransferClaimPresent || ownerRecoveryClaimPresent,
  } as const;
  const hasClaimCredential = claimPurposeCount === 1;
  // Lazy-load the runtime after the setup/guest module graph has initialized;
  // the runtime bridges back into peer.ts and would otherwise form an eager
  // guest -> runtime -> peer -> guest evaluation cycle at app startup.
  const runtimeResult = hasClaimCredential
    ? await runClaimProtectedOperation(() => import('./runtime.ts'), existingOwnerLoginPolicy)
    : { ok: true as const, value: await import('./runtime.ts') };
  if (!runtimeResult.ok) return false;
  const runtime = runtimeResult.value;
  const resumeExistingSession = async (options: { takeover?: boolean } = {}) => {
    const result = await runEntryOperation((signal) =>
      runtime.resumeProRoom(code, { ...options, signal }),
    );
    // A successful cookie-backed resume proves that no earlier PIN admission
    // remains outcome-unknown. Retaining its request id would let a later,
    // unrelated PIN entry replay stale admission state after the cookie expires.
    clearPendingSessionRequestId(code);
    return result;
  };
  // Consume this one-time route hint before any network turn. Only a marker
  // retained by this exact browsing context may silently reclaim its
  // pre-OAuth presence; a durable PWA-relaunch hint keeps the normal active-tab
  // confirmation boundary.
  const accountLoginReturn = consumeAccountLoginReturnForRoom(code);
  const returningFromSameTabLogin = accountLoginReturn?.allowSilentTakeover === true;
  const bootstrapResult = hasClaimCredential
    ? await runClaimProtectedOperation(
        () => runEntryOperation((signal) => runtime.getProRoomBootstrap(code, signal)),
        existingOwnerLoginPolicy,
      )
    : {
        ok: true as const,
        value: await runEntryOperation((signal) => runtime.getProRoomBootstrap(code, signal)),
      };
  if (!bootstrapResult.ok) return false;
  const bootstrap = bootstrapResult.value;

  if (ownerTransferClaimPresent) {
    const ownerTransferClaimToken = fragmentClaims.ownerTransferClaimToken;
    if (!ownerTransferClaimToken || !ownerTransferRequestId) {
      await showNewClaimLinkGuidance();
      return false;
    }
    const newPin = await promptPin({
      title: t('pro.transfer_title'),
      message: t('pro.transfer_message'),
      autocomplete: 'new-password',
    });
    if (!newPin) return false;
    // The App facade and room object replay this exact request id after an
    // uncertain prepare/commit response. Retrying a different operation first
    // could strand a completed transfer before its final cookies are released.
    const transfer = await runClaimProtectedOperation(
      () =>
        runEntryOperation((signal) =>
          runtime.transferProRoomOwner(
            {
              code,
              claimToken: ownerTransferClaimToken,
              newPin,
              requestId: ownerTransferRequestId,
            },
            signal,
          ),
        ),
      existingOwnerLoginPolicy,
    );
    if (transfer.ok) clearPendingSessionRequestId(code);
    return transfer.ok;
  }

  if (ownerRecoveryClaimPresent) {
    // Recovery is meaningful only for the active incarnation that issued it.
    // Resolve recycled, suspended, or otherwise stale links locally instead
    // of turning a registry/account-assertion refusal into a retryable outage.
    if (bootstrap.status !== 'pin_required') {
      await showNewClaimLinkGuidance();
      return false;
    }
    const ownerRecoveryClaimToken = fragmentClaims.ownerRecoveryClaimToken!;
    let recoveryMayHaveCommitted = false;
    const recovery = await runClaimProtectedOperation(async () => {
      if (recoveryMayHaveCommitted) {
        try {
          return await resumeExistingSession();
        } catch (error) {
          if (!isMissingCookieSession(error)) throw error;
          recoveryMayHaveCommitted = false;
        }
      }
      try {
        return await runEntryOperation((signal) =>
          runtime.recoverProRoomOwner(
            {
              code,
              claimToken: ownerRecoveryClaimToken,
            },
            signal,
          ),
        );
      } catch (error) {
        // Only an uncertain transport/service result may have committed while
        // losing its response. ACCOUNT_SESSION_REQUIRED must retry the actual
        // claim after login so an unrelated stale owner cookie cannot bypass
        // the account-link conflict check.
        recoveryMayHaveCommitted = isTransientClaimFailure(error);
        throw error;
      }
    }, existingOwnerLoginPolicy);
    if (recovery.ok) clearPendingSessionRequestId(code);
    return recovery.ok;
  }

  // Activation claims are meaningful only while the room still awaits its
  // first activation. A recycled or already-used link must not fall through
  // to cookie resume/PIN entry or generic suspended-room guidance.
  if (activationClaimPresent && bootstrap.status !== 'activation_required') {
    await showNewClaimLinkGuidance();
    return false;
  }

  if (bootstrap.status === 'suspended') {
    await showUnavailable(t('pro.suspended_title'), t('pro.suspended_message'));
    return false;
  }

  if (bootstrap.status === 'activation_required') {
    const activationClaimToken = fragmentClaims.activationClaimToken;
    if (!activationClaimToken) {
      if (fragmentClaims.activationClaimPresent) await showNewClaimLinkGuidance();
      else await showUnavailable(t('pro.not_ready_title'), t('pro.not_ready_message'));
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
            return await resumeExistingSession();
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
    if (activation.ok) clearPendingSessionRequestId(code);
    return activation.ok;
  }

  // A host-only HttpOnly cookie survives a reload. Try it before asking for
  // the 8-digit PIN again; only an authentication miss falls through.
  let resumeError: unknown;
  try {
    await resumeExistingSession();
    return true;
  } catch (error) {
    resumeError = error;
  }

  if (isActiveInAnotherTab(resumeError)) {
    if (returningFromSameTabLogin) {
      await resumeExistingSession({ takeover: true });
      announceProRoomTabTakeover(code);
      return true;
    }

    // A refresh/update can race the previous document's unload keepalive.
    // Retry once without takeover so a real sibling tab remains protected.
    await waitForActiveTabRelease();
    try {
      await resumeExistingSession();
      return true;
    } catch (error) {
      resumeError = error;
    }
  }

  if (isActiveInAnotherTab(resumeError)) {
    const result = await showDialog({
      title: t('pro.active_tab_title'),
      message: t('pro.active_tab_message'),
      buttonText: t('pro.use_this_tab'),
      secondaryText: t('common.cancel'),
      dismissible: false,
      defaultFocus: 'secondary',
    });
    if (result.action !== 'ok') return false;
    await resumeExistingSession({ takeover: true });
    // The server is the source of truth. Broadcast only after it commits the
    // new incarnation so the previous tab can stop immediately instead of
    // waiting for its next signaling/heartbeat failure.
    announceProRoomTabTakeover(code);
    return true;
  }
  if (!isMissingCookieSession(resumeError)) throw resumeError;

  let retry = false;
  // Keep one logical admission ID across an uncertain App/DO response. The
  // value is not a credential and sessionStorage is deliberately tab-scoped;
  // it survives a reload without letting another tab silently inherit the
  // pending admission. A definitive PIN result or successful cookie response
  // clears it below.
  while (true) {
    const pin = await promptPin({
      title: t('pro.pin_title'),
      message: t(retry ? 'pro.pin_retry_message' : 'pro.pin_message'),
      autocomplete: 'current-password',
    });
    if (!pin) {
      clearPendingSessionRequestId(code);
      return false;
    }
    const requestId = getOrCreatePendingSessionRequestId(code);
    try {
      await runEntryOperation((signal) =>
        runtime.joinProRoom(
          {
            code,
            pin,
            requestId,
          },
          signal,
        ),
      );
      clearPendingSessionRequestId(code);
      return true;
    } catch (error) {
      if (error instanceof ProRoomApiError && error.code === 'PIN_INVALID') {
        clearPendingSessionRequestId(code);
        retry = true;
        continue;
      }
      // A canonical 4xx proves that this logical admission did not produce a
      // usable cookie. Do not poison later attempts with a requestId that will
      // deterministically replay the same conflict/fence. Transport failures,
      // local deadlines, invalid success responses, and 5xx responses retain
      // the ID because their mutation outcome is unknown.
      if (isDefinitiveSessionAdmissionError(error)) {
        clearPendingSessionRequestId(code);
      }
      throw error;
    }
  }
}
