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
    key === 'toast.announcement_available' ? '새로운 공지가 있어요.\n채팅창을 확인해주세요.' : key,
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

  it('shows a short toast and pins MUSIXQUARE announcements in chat', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        enabled: true,
        id: 'announcement-1',
        message: 'Server maintenance starts soon.',
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
    expect(showToast).toHaveBeenCalledWith('새로운 공지가 있어요.\n채팅창을 확인해주세요.', {
      durationMs: 5000,
    });
    expect(notices).toEqual([
      {
        sender: 'MUSIXQUARE',
        text: 'Server maintenance starts soon.',
        timestamp: new Date('2026-06-22T08:00:00.000Z').getTime(),
      },
    ]);
  });
});
