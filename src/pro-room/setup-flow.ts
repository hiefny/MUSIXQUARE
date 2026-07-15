import { getState } from '../core/state.ts';
import { t } from '../i18n/index.ts';
import { showDialog } from '../ui/dialog.ts';
import { ProRoomApiError } from './api.ts';
import { takeProRoomClaimFromFragment } from './claim-fragment.ts';
import { deriveTemporaryProRoomPin, isProRoomCode, normalizeProRoomPin } from './room-code.ts';

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

/**
 * Authenticate and connect a reserved PRO room. UI orchestration remains here
 * while the runtime owns cookies, authority, heartbeats, and WebRTC topology.
 */
export async function enterProRoomFromSetup(code: string): Promise<boolean> {
  if (!isProRoomCode(code)) throw new Error('INVALID_PRO_ROOM_CODE');
  const claimToken = takeProRoomClaimFromFragment();
  // Lazy-load the runtime after the setup/guest module graph has initialized;
  // the runtime bridges back into peer.ts and would otherwise form an eager
  // guest -> runtime -> peer -> guest evaluation cycle at app startup.
  const runtime = await import('./runtime.ts');
  const bootstrap = await runtime.getProRoomBootstrap(code);

  if (bootstrap.status === 'suspended') {
    await showUnavailable(t('pro.suspended_title'), t('pro.suspended_message'));
    return false;
  }

  if (bootstrap.status === 'activation_required') {
    if (!claimToken) {
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
    await runtime.activateProRoom({
      code,
      claimToken,
      temporaryPin,
      newPin,
      ownerName: 'Owner',
    });
    return true;
  }

  // A host-only HttpOnly cookie survives a reload. Try it before asking for
  // the 8-digit PIN again; only an authentication miss falls through.
  try {
    await runtime.resumeProRoom(code);
    return true;
  } catch (error) {
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
      await runtime.joinProRoom({
        code,
        pin,
        displayName: getState('network.myDeviceLabel') || 'Peer',
      });
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
