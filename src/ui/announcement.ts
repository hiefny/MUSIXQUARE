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
const ANNOUNCEMENT_POLL_MS = 60_000;
const ANNOUNCEMENT_TOAST_MS = 5_000;
const ANNOUNCEMENT_SENDER = 'MUSIXQUARE';
const ANNOUNCEMENT_REQUEST_TIMEOUT_MS = 10_000;
const ANNOUNCEMENT_RESPONSE_MAX_BYTES = 64 * 1024;

type AnnouncementPayload = {
  enabled?: boolean;
  id?: string;
  message?: string;
};

let active = false;
let pollingGeneration = 0;
let inFlightController: AbortController | null = null;
let memorySeenId = '';

function isSessionActive(): boolean {
  return getState('network.appRole') !== 'idle';
}

function readSeenId(): string {
  return memorySeenId;
}

function rememberSeenId(id: string): void {
  memorySeenId = id;
}

function shouldShowAnnouncement(
  payload: AnnouncementPayload,
): payload is Required<AnnouncementPayload> {
  return Boolean(payload.enabled && payload.id && payload.message);
}

async function checkAnnouncement({ notify = true }: { notify?: boolean } = {}): Promise<void> {
  if (!active || !isSessionActive() || inFlightController) return;
  const generation = pollingGeneration;
  const controller = new AbortController();
  inFlightController = controller;
  try {
    const payload = await withRequestDeadline(
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
        return (await readBoundedJsonResponse(
          response,
          ANNOUNCEMENT_RESPONSE_MAX_BYTES,
          signal,
        )) as AnnouncementPayload;
      },
      {
        signal: controller.signal,
        timeoutMs: ANNOUNCEMENT_REQUEST_TIMEOUT_MS,
        timeoutReason: 'ANNOUNCEMENT_REQUEST_TIMEOUT',
      },
    );
    if (!payload) return;
    // A response from the previous room/session must not mark an announcement
    // seen or inject it into the newly-entered room after stop/start raced it.
    if (generation !== pollingGeneration || !active || !isSessionActive()) return;
    if (!shouldShowAnnouncement(payload)) return;
    if (readSeenId() === payload.id) return;

    rememberSeenId(payload.id);
    if (notify) {
      showToast(t('toast.announcement_available'), { durationMs: ANNOUNCEMENT_TOAST_MS });
      playAnnouncementSound();
    }
    bus.emit('chat:notice-message', ANNOUNCEMENT_SENDER, payload.message, Date.now());
  } catch (error) {
    if (!controller.signal.aborted) log.debug('[Announcement] check failed:', error);
  } finally {
    if (inFlightController === controller) inFlightController = null;
  }
}

function startAnnouncementPolling(): void {
  if (active) return;
  active = true;
  pollingGeneration += 1;
  void checkAnnouncement({ notify: false });
  setManagedTimer(
    ANNOUNCEMENT_POLL_TIMER,
    () => {
      void checkAnnouncement();
    },
    ANNOUNCEMENT_POLL_MS,
    { interval: true },
  );
}

function stopAnnouncementPolling(): void {
  active = false;
  pollingGeneration += 1;
  clearManagedTimer(ANNOUNCEMENT_POLL_TIMER);
  inFlightController?.abort();
  inFlightController = null;
}

export function initAnnouncementPolling(): void {
  bus.on('state:network.appRole', () => {
    if (isSessionActive()) startAnnouncementPolling();
    else stopAnnouncementPolling();
  });

  if (isSessionActive()) startAnnouncementPolling();
}
