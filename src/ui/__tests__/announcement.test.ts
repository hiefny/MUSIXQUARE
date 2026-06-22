/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) =>
    key === 'toast.announcement_available' ? 'New announcement.\nCheck the chat panel.' : key,
  ),
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
}));

async function flushAnnouncementCheck(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('announcement polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T08:00:00.000Z'));
    resetState();
    bus.clear();
    localStorage.clear();
  });

  afterEach(() => {
    clearAllManagedTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    bus.clear();
  });

  it('pins initial announcements silently and toasts only for later updates', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          enabled: true,
          id: 'announcement-1',
          message: 'Server maintenance starts soon.',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          enabled: true,
          id: 'announcement-2',
          message: 'Maintenance is live now.',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const notices: Array<{ sender: string; text: string; timestamp?: number }> = [];
    bus.on('chat:notice-message', (sender, text, timestamp) => {
      notices.push({ sender, text, timestamp });
    });

    const { initAnnouncementPolling } = await import('../announcement.ts');
    initAnnouncementPolling();

    setState('network.appRole', 'guest');
    await flushAnnouncementCheck();

    const { showToast } = await import('../toast.ts');
    expect(fetchMock).toHaveBeenCalledWith('/api/announcement/current', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    expect(showToast).not.toHaveBeenCalled();
    expect(notices).toEqual([
      {
        sender: 'MUSIXQUARE',
        text: 'Server maintenance starts soon.',
        timestamp: new Date('2026-06-22T08:00:00.000Z').getTime(),
      },
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushAnnouncementCheck();

    expect(showToast).toHaveBeenCalledWith('New announcement.\nCheck the chat panel.', {
      durationMs: 5000,
    });
    expect(notices).toEqual([
      {
        sender: 'MUSIXQUARE',
        text: 'Server maintenance starts soon.',
        timestamp: new Date('2026-06-22T08:00:00.000Z').getTime(),
      },
      {
        sender: 'MUSIXQUARE',
        text: 'Maintenance is live now.',
        timestamp: new Date('2026-06-22T08:01:00.000Z').getTime(),
      },
    ]);
    expect(localStorage.getItem('musixquare-seen-announcement-id')).toBeNull();
  });
});
