import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { getState } from '../core/state.ts';
import { t } from '../i18n/index.ts';
import { showToast } from './toast.ts';
import { playAnnouncementSound } from '../audio/ui-sounds.ts';

const ANNOUNCEMENT_POLL_TIMER = 'announcement:poll';
const ANNOUNCEMENT_POLL_MS = 60_000;
const ANNOUNCEMENT_TOAST_MS = 5_000;
const ANNOUNCEMENT_SENDER = 'MUSIXQUARE';

type AnnouncementPayload = {
  enabled?: boolean;
  id?: string;
  message?: string;
};

let active = false;
let inFlight = false;
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
  if (!isSessionActive() || inFlight) return;
  inFlight = true;
  try {
    const response = await fetch('/api/announcement/current', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return;
    const payload = (await response.json().catch(() => ({}))) as AnnouncementPayload;
    if (!shouldShowAnnouncement(payload)) return;
    if (readSeenId() === payload.id) return;

    rememberSeenId(payload.id);
    if (notify) {
      showToast(t('toast.announcement_available'), { durationMs: ANNOUNCEMENT_TOAST_MS });
      playAnnouncementSound();
    }
    bus.emit('chat:notice-message', ANNOUNCEMENT_SENDER, payload.message, Date.now());
  } catch (error) {
    log.debug('[Announcement] check failed:', error);
  } finally {
    inFlight = false;
  }
}

function startAnnouncementPolling(): void {
  if (active) return;
  active = true;
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
  clearManagedTimer(ANNOUNCEMENT_POLL_TIMER);
}

export function initAnnouncementPolling(): void {
  bus.on('state:network.appRole', () => {
    if (isSessionActive()) startAnnouncementPolling();
    else stopAnnouncementPolling();
  });

  if (isSessionActive()) startAnnouncementPolling();
}
