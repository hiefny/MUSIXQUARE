import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { getState } from '../core/state.ts';
import { t } from '../i18n/index.ts';
import { showToast } from './toast.ts';
import { playAnnouncementSound } from '../audio/ui-sounds.ts';
import {
  cancelResponseBody,
  readBoundedJsonResponse,
  withRequestDeadline,
} from '../core/request-lifetime.ts';

const ANNOUNCEMENT_POLL_TIMER = 'announcement:poll';
const ANNOUNCEMENT_POLL_MS = 5 * 60_000;
const ANNOUNCEMENT_TOAST_MS = 5_000;
const ANNOUNCEMENT_SENDER = 'MUSIXQUARE';
const ANNOUNCEMENT_REQUEST_TIMEOUT_MS = 10_000;
const ANNOUNCEMENT_RESPONSE_MAX_BYTES = 64 * 1024;

type AnnouncementPayload = ({ enabled: false } | { enabled: true; id: string; message: string }) & {
  revision: number | null;
};

let active = false;
let pollingGeneration = 0;
let requestEpoch = 0;
let inFlightController: AbortController | null = null;
let memorySeenId = '';
let currentAnnouncementId = '';
let highestRevision = -1;
let withdrawnRevision = -1;
let visibilityListenerBound = false;
let initialCheckPending = true;

function isSessionActive(): boolean {
  return getState('network.appRole') !== 'idle';
}

function readSeenId(): string {
  return memorySeenId;
}

function rememberSeenId(id: string): void {
  memorySeenId = id;
}

function parseAnnouncementPayload(value: unknown): AnnouncementPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  let revision: number | null = null;
  if ('revision' in payload) {
    if (
      typeof payload.revision !== 'number' ||
      !Number.isSafeInteger(payload.revision) ||
      payload.revision < 0
    ) {
      return null;
    }
    revision = payload.revision;
  }
  if (payload.enabled === false) return { enabled: false, revision };
  if (
    payload.enabled !== true ||
    typeof payload.id !== 'string' ||
    !payload.id.trim() ||
    typeof payload.message !== 'string' ||
    !payload.message.trim()
  ) {
    return null;
  }
  // The server evaluates expiresAt. A skewed device clock must not retract a
  // live notice early; expiry arrives as enabled:false on polling/foreground.
  return { enabled: true, id: payload.id, message: payload.message, revision };
}

function acceptAnnouncementRevision(payload: AnnouncementPayload): boolean {
  // Isolate caches can return an older snapshot even with serial requests.
  // Keep this fence across room reentry and never downgrade to a legacy peer
  // after the current backend has supplied a canonical revision.
  if (payload.revision === null) return highestRevision < 0;
  if (
    payload.revision < highestRevision ||
    (payload.enabled && payload.revision === withdrawnRevision)
  ) {
    return false;
  }
  highestRevision = payload.revision;
  // Expiry can turn the same revision off. That revision must not become live
  // again if the next response comes from an isolate whose clock/cache lags.
  if (!payload.enabled) withdrawnRevision = payload.revision;
  return true;
}

function withdrawCurrentAnnouncement(): void {
  const id = currentAnnouncementId;
  currentAnnouncementId = '';
  if (id) bus.emit('chat:service-notice-withdrawn', id);
}

async function checkAnnouncement(): Promise<void> {
  if (
    !active ||
    !isSessionActive() ||
    document.visibilityState !== 'visible' ||
    inFlightController
  ) {
    return;
  }
  const generation = pollingGeneration;
  const epoch = requestEpoch;
  const controller = new AbortController();
  inFlightController = controller;
  try {
    const value = await withRequestDeadline(
      async (signal) => {
        const response = await fetch('/api/announcement/current', {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          signal,
        });
        if (!response.ok) {
          await cancelResponseBody(response);
          return null;
        }
        return await readBoundedJsonResponse(response, ANNOUNCEMENT_RESPONSE_MAX_BYTES, signal);
      },
      {
        signal: controller.signal,
        timeoutMs: ANNOUNCEMENT_REQUEST_TIMEOUT_MS,
        timeoutReason: 'ANNOUNCEMENT_REQUEST_TIMEOUT',
      },
    );
    // A response from the previous room/session must not mark an announcement
    // seen or inject it into the newly-entered room after stop/start raced it.
    if (
      generation !== pollingGeneration ||
      epoch !== requestEpoch ||
      !active ||
      !isSessionActive() ||
      document.visibilityState !== 'visible'
    ) {
      return;
    }
    const payload = parseAnnouncementPayload(value);
    if (!payload || !acceptAnnouncementRevision(payload)) return;
    const notify = !initialCheckPending;
    initialCheckPending = false;
    if (!payload.enabled) {
      withdrawCurrentAnnouncement();
      return;
    }
    currentAnnouncementId = payload.id;
    if (readSeenId() === payload.id) return;

    rememberSeenId(payload.id);
    if (notify) {
      showToast(t('toast.announcement_available'), { durationMs: ANNOUNCEMENT_TOAST_MS });
      playAnnouncementSound();
    }
    bus.emit('chat:notice-message', ANNOUNCEMENT_SENDER, payload.message, Date.now(), {
      source: 'service',
      id: payload.id,
    });
  } catch (error) {
    if (!controller.signal.aborted) log.debug('[Announcement] check failed:', error);
  } finally {
    if (inFlightController === controller) inFlightController = null;
  }
}

function startVisiblePolling(): void {
  if (!active || !isSessionActive() || document.visibilityState !== 'visible') return;
  checkAnnouncement().catch((error) => {
    log.warn('[Announcement] Poll escaped its request boundary', error);
  });
  setManagedTimer(ANNOUNCEMENT_POLL_TIMER, () => checkAnnouncement(), ANNOUNCEMENT_POLL_MS, {
    interval: true,
  });
}

function handleAnnouncementVisibilityChange(): void {
  if (!active) return;
  if (document.visibilityState !== 'visible') {
    clearManagedTimer(ANNOUNCEMENT_POLL_TIMER);
    requestEpoch += 1;
    inFlightController?.abort();
    inFlightController = null;
    return;
  }
  // A foregrounded room checks immediately instead of waiting for the next
  // five-minute boundary. Existing seen-ID fencing ensures that only an
  // announcement published while the page was hidden produces a notice.
  startVisiblePolling();
}

function startAnnouncementPolling(): void {
  if (active) return;
  active = true;
  pollingGeneration += 1;
  initialCheckPending = true;
  startVisiblePolling();
}

function stopAnnouncementPolling(): void {
  active = false;
  pollingGeneration += 1;
  requestEpoch += 1;
  clearManagedTimer(ANNOUNCEMENT_POLL_TIMER);
  inFlightController?.abort();
  inFlightController = null;
}

export function initAnnouncementPolling(): void {
  if (!visibilityListenerBound) {
    visibilityListenerBound = true;
    document.addEventListener('visibilitychange', handleAnnouncementVisibilityChange);
  }
  bus.on('state:network.appRole', () => {
    if (isSessionActive()) startAnnouncementPolling();
    else stopAnnouncementPolling();
  });

  if (isSessionActive()) startAnnouncementPolling();
}
