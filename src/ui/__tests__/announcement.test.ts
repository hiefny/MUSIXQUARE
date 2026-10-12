/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let bus: typeof import('../../core/events.ts').bus;
let resetState: typeof import('../../core/state.ts').resetState;
let setState: typeof import('../../core/state.ts').setState;
let clearAllManagedTimers: typeof import('../../core/timers.ts').clearAllManagedTimers;
let visibilityListeners: EventListener[];

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

vi.mock('../../audio/ui-sounds.ts', () => ({ playAnnouncementSound: vi.fn() }));

async function flushAnnouncementCheck(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('announcement polling', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.setSystemTime(new Date('2026-06-22T08:00:00.000Z'));
    ({ bus } = await import('../../core/events.ts'));
    ({ resetState, setState } = await import('../../core/state.ts'));
    ({ clearAllManagedTimers } = await import('../../core/timers.ts'));
    visibilityListeners = [];
    const addEventListener = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'visibilitychange') visibilityListeners.push(listener as EventListener);
      addEventListener(type, listener, options);
    });
    resetState();
    bus.clear();
    localStorage.clear();
  });

  afterEach(() => {
    setState('network.appRole', 'idle');
    clearAllManagedTimers();
    for (const listener of visibilityListeners) {
      document.removeEventListener('visibilitychange', listener);
    }
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
      signal: expect.any(AbortSignal),
    });
    expect(showToast).not.toHaveBeenCalled();
    expect(notices).toEqual([
      {
        sender: 'MUSIXQUARE',
        text: 'Server maintenance starts soon.',
        timestamp: new Date('2026-06-22T08:00:00.000Z').getTime(),
      },
    ]);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
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
        timestamp: new Date('2026-06-22T08:05:00.000Z').getTime(),
      },
    ]);
    expect(localStorage.getItem('musixquare-seen-announcement-id')).toBeNull();
  });

  it('drops a late response after the room session stops', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const notices: string[] = [];
    bus.on('chat:notice-message', (_sender, text) => notices.push(text));

    const { initAnnouncementPolling } = await import('../announcement.ts');
    initAnnouncementPolling();
    setState('network.appRole', 'guest');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    setState('network.appRole', 'idle');
    resolveFetch(
      Response.json({ enabled: true, id: 'late-announcement', message: 'Must not leak' }),
    );
    await flushAnnouncementCheck();

    expect(notices).toEqual([]);
  });

  it('polls only while visible and checks immediately when the room returns to foreground', async () => {
    let visibility: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ enabled: true, id: 'announcement-1', message: 'Initial notice' }),
      )
      .mockResolvedValueOnce(
        Response.json({ enabled: true, id: 'announcement-2', message: 'Foreground notice' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const notices: string[] = [];
    bus.on('chat:notice-message', (_sender, text) => notices.push(text));

    const { initAnnouncementPolling } = await import('../announcement.ts');
    initAnnouncementPolling();
    setState('network.appRole', 'guest');
    await flushAnnouncementCheck();

    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(notices).toEqual(['Initial notice']));
    expect(fetchMock).toHaveBeenCalledOnce();
    const { showToast } = await import('../toast.ts');
    expect(showToast).not.toHaveBeenCalled();

    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledOnce();

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(notices).toEqual(['Initial notice', 'Foreground notice']));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenCalledOnce();
  });

  it('observes a polling rejection that escapes the request boundary', async () => {
    const requestError = new Error('announcement endpoint unavailable');
    const escapedError = new Error('diagnostic sink unavailable');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(requestError));

    const { log } = await import('../../core/log.ts');
    vi.mocked(log.debug).mockImplementationOnce(() => {
      throw escapedError;
    });

    const { initAnnouncementPolling } = await import('../announcement.ts');
    initAnnouncementPolling();
    setState('network.appRole', 'guest');

    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith(
        '[Announcement] Poll escaped its request boundary',
        escapedError,
      );
    });
    expect(log.debug).toHaveBeenCalledWith('[Announcement] check failed:', requestError);
  });

  it.each(['standard-host', 'standard-guest', 'pro'] as const)(
    'withdraws the displayed service ID once on authoritative disable in %s',
    async (mode) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ enabled: true, id: 'service-A', message: 'Service notice' }),
        )
        .mockImplementation(() => Promise.resolve(Response.json({ enabled: false })));
      vi.stubGlobal('fetch', fetchMock);
      const notice = vi.fn();
      const withdrawn = vi.fn();
      bus.on('chat:notice-message', notice);
      bus.on('chat:service-notice-withdrawn', withdrawn);
      if (mode === 'pro') {
        setState('room.context', {
          kind: 'pro',
          roomId: '000001',
          role: 'member',
          coordinatorId: null,
          epoch: 1,
          snapshotRevision: 1,
          capabilities: [],
        });
      }
      const { initAnnouncementPolling } = await import('../announcement.ts');
      initAnnouncementPolling();
      setState('network.appRole', mode === 'standard-guest' ? 'guest' : 'host');
      await flushAnnouncementCheck();

      expect(notice).toHaveBeenCalledWith('MUSIXQUARE', 'Service notice', Date.now(), {
        source: 'service',
        id: 'service-A',
      });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(withdrawn).toHaveBeenCalledExactlyOnceWith('service-A');
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(withdrawn).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['HTTP failure', () => new Response('Unavailable', { status: 503 })],
    ['invalid JSON', () => new Response('{not-json')],
    ['missing enabled', () => Response.json({ id: 'A', message: 'Invalid' })],
    ['non-boolean enabled', () => Response.json({ enabled: 'false', id: 'A', message: 'Invalid' })],
    ['non-string ID', () => Response.json({ enabled: true, id: 123, message: 'Invalid' })],
    [
      'non-string message',
      () => Response.json({ enabled: true, id: 'A', message: { text: 'Invalid' } }),
    ],
    ['blank message', () => Response.json({ enabled: true, id: 'A', message: '  ' })],
    ['array body', () => Response.json([])],
  ])('preserves the current notice after %s', async (_label, response) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ enabled: true, id: 'A', message: 'Keep me' }))
        .mockImplementation(() => Promise.resolve(response())),
    );
    const notice = vi.fn();
    const withdrawn = vi.fn();
    bus.on('chat:notice-message', notice);
    bus.on('chat:service-notice-withdrawn', withdrawn);
    const { initAnnouncementPolling } = await import('../announcement.ts');
    initAnnouncementPolling();
    setState('network.appRole', 'guest');
    await flushAnnouncementCheck();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(notice).toHaveBeenCalledOnce();
    expect(withdrawn).not.toHaveBeenCalled();
  });

  it.each(['HTTP failure', 'invalid payload', 'timeout'])(
    'keeps the first successful interval result silent after an initial %s',
    async (failure) => {
      const fetchMock = vi.fn();
      if (failure === 'HTTP failure') {
        fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
      } else if (failure === 'invalid payload') {
        fetchMock.mockResolvedValueOnce(Response.json({ enabled: 'true' }));
      } else {
        fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
      }
      fetchMock
        .mockResolvedValueOnce(Response.json({ enabled: true, id: 'A', message: 'Initial notice' }))
        .mockResolvedValueOnce(Response.json({ enabled: true, id: 'B', message: 'Later notice' }));
      vi.stubGlobal('fetch', fetchMock);
      const notice = vi.fn();
      bus.on('chat:notice-message', notice);
      const { initAnnouncementPolling } = await import('../announcement.ts');
      const { showToast } = await import('../toast.ts');
      const { playAnnouncementSound } = await import('../../audio/ui-sounds.ts');
      initAnnouncementPolling();
      setState('network.appRole', 'host');
      await flushAnnouncementCheck();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(notice).toHaveBeenCalledOnce();
      expect(showToast).not.toHaveBeenCalled();
      expect(playAnnouncementSound).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(notice).toHaveBeenCalledTimes(2);
      expect(showToast).toHaveBeenCalledOnce();
      expect(playAnnouncementSound).toHaveBeenCalledOnce();
    },
  );

  it('notifies for a new publication after a successful disabled baseline', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ enabled: false }))
        .mockResolvedValueOnce(Response.json({ enabled: true, id: 'A', message: 'New notice' })),
    );
    const { initAnnouncementPolling } = await import('../announcement.ts');
    const { showToast } = await import('../toast.ts');
    initAnnouncementPolling();
    setState('network.appRole', 'host');
    await flushAnnouncementCheck();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(showToast).toHaveBeenCalledOnce();
  });

  it('withdraws only the latest service ID after a replacement', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ enabled: true, id: 'A', message: 'Old notice' }))
        .mockResolvedValueOnce(Response.json({ enabled: true, id: 'B', message: 'New notice' }))
        .mockResolvedValueOnce(Response.json({ enabled: false })),
    );
    const withdrawn = vi.fn();
    bus.on('chat:service-notice-withdrawn', withdrawn);
    const { initAnnouncementPolling } = await import('../announcement.ts');
    initAnnouncementPolling();
    setState('network.appRole', 'host');
    await flushAnnouncementCheck();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(withdrawn).toHaveBeenCalledExactlyOnceWith('B');
  });

  it('uses server expiry on foreground and does not trust an ahead-of-server device clock', async () => {
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          enabled: true,
          id: 'A',
          message: 'Still live according to the server',
          expiresAt: '2026-06-21T00:00:00.000Z',
        }),
      )
      .mockResolvedValueOnce(Response.json({ enabled: false }));
    vi.stubGlobal('fetch', fetchMock);
    const notice = vi.fn();
    const withdrawn = vi.fn();
    bus.on('chat:notice-message', notice);
    bus.on('chat:service-notice-withdrawn', withdrawn);
    const { initAnnouncementPolling } = await import('../announcement.ts');
    initAnnouncementPolling();
    setState('network.appRole', 'host');
    await flushAnnouncementCheck();
    expect(notice).toHaveBeenCalledOnce();
    expect(withdrawn).not.toHaveBeenCalled();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(withdrawn).not.toHaveBeenCalled();
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await flushAnnouncementCheck();
    expect(withdrawn).toHaveBeenCalledExactlyOnceWith('A');
  });

  it.each(['foreground', 'new session', 'PRO reentry'])(
    'does not let a late disabled response withdraw a newer notice after %s',
    async (boundary) => {
      let visibility: DocumentVisibilityState = 'visible';
      vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
      let resolveDisabled!: (response: Response) => void;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ enabled: true, id: 'A', message: 'Old notice' }))
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              resolveDisabled = resolve;
            }),
        )
        .mockResolvedValueOnce(Response.json({ enabled: true, id: 'B', message: 'New notice' }));
      vi.stubGlobal('fetch', fetchMock);
      const notice = vi.fn();
      const withdrawn = vi.fn();
      bus.on('chat:notice-message', notice);
      bus.on('chat:service-notice-withdrawn', withdrawn);
      if (boundary === 'PRO reentry') {
        setState('room.context', {
          kind: 'pro',
          roomId: '000001',
          role: 'member',
          coordinatorId: null,
          epoch: 1,
          snapshotRevision: 1,
          capabilities: [],
        });
      }
      const { initAnnouncementPolling } = await import('../announcement.ts');
      initAnnouncementPolling();
      setState('network.appRole', 'host');
      await flushAnnouncementCheck();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      if (boundary === 'foreground') {
        visibility = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
        visibility = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
      } else {
        setState('network.appRole', 'idle');
        setState('network.appRole', boundary === 'PRO reentry' ? 'host' : 'guest');
      }
      await flushAnnouncementCheck();
      resolveDisabled(Response.json({ enabled: false }));
      await flushAnnouncementCheck();
      expect(notice.mock.calls.map((call) => call[1])).toEqual(['Old notice', 'New notice']);
      expect(withdrawn).not.toHaveBeenCalled();
    },
  );

  it('does not republish a seen notice on polling, foreground, or reactivation', async () => {
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ enabled: true, id: 'A', message: 'Notice' }))),
    );
    const notice = vi.fn();
    bus.on('chat:notice-message', notice);
    const { initAnnouncementPolling } = await import('../announcement.ts');
    initAnnouncementPolling();
    setState('network.appRole', 'host');
    await flushAnnouncementCheck();
    // A local dismissal or a newer room notice is owned by the renderer. The
    // poller must not re-emit this ID and bring the service banner back.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await flushAnnouncementCheck();
    setState('network.appRole', 'idle');
    setState('network.appRole', 'guest');
    await flushAnnouncementCheck();
    expect(notice).toHaveBeenCalledOnce();
  });

  it('ignores older active and disabled snapshots while accepting a newer withdrawal', async () => {
    const fetchMock = vi.fn();
    for (const payload of [
      { enabled: true, id: 'B', message: 'Current', revision: 4 },
      { enabled: false, revision: 3 },
      { enabled: true, id: 'A', message: 'Old cache', revision: 3 },
      { enabled: false, revision: 5 },
    ])
      fetchMock.mockResolvedValueOnce(Response.json(payload));
    vi.stubGlobal('fetch', fetchMock);
    const notice = vi.fn();
    const withdrawn = vi.fn();
    bus.on('chat:notice-message', notice);
    bus.on('chat:service-notice-withdrawn', withdrawn);
    const { initAnnouncementPolling } = await import('../announcement.ts');
    initAnnouncementPolling();
    setState('network.appRole', 'host');
    await flushAnnouncementCheck();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(notice).toHaveBeenCalledOnce();
    expect(withdrawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(withdrawn).toHaveBeenCalledExactlyOnceWith('B');
  });

  it('accepts legacy payloads only before a versioned response and keeps its fence across reentry', async () => {
    const fetchMock = vi.fn();
    for (const payload of [
      { enabled: true, id: 'legacy', message: 'Legacy baseline' },
      { enabled: true, id: 'A', message: 'Versioned', revision: 2 },
      { enabled: false },
      { enabled: false, revision: 1 },
      { enabled: true, id: 'legacy-new', message: 'Unversioned replacement' },
    ])
      fetchMock.mockResolvedValueOnce(Response.json(payload));
    vi.stubGlobal('fetch', fetchMock);
    const notice = vi.fn();
    const withdrawn = vi.fn();
    bus.on('chat:notice-message', notice);
    bus.on('chat:service-notice-withdrawn', withdrawn);
    const { initAnnouncementPolling } = await import('../announcement.ts');
    initAnnouncementPolling();
    setState('network.appRole', 'host');
    await flushAnnouncementCheck();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    stateReentry();
    await flushAnnouncementCheck();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(notice.mock.calls.map((call) => call[1])).toEqual(['Legacy baseline', 'Versioned']);
    expect(withdrawn).not.toHaveBeenCalled();

    function stateReentry(): void {
      setState('network.appRole', 'idle');
      setState('network.appRole', 'guest');
    }
  });

  it('allows same-revision expiry but never revives that revision, even after reentry', async () => {
    const fetchMock = vi.fn();
    for (const payload of [
      { enabled: true, id: 'A', message: 'Before expiry', revision: 2 },
      { enabled: false, revision: 2 },
      { enabled: true, id: 'A', message: 'Lagging clock', revision: 2 },
      { enabled: false, revision: 2 },
      { enabled: true, id: 'B', message: 'New publication', revision: 3 },
    ])
      fetchMock.mockResolvedValueOnce(Response.json(payload));
    vi.stubGlobal('fetch', fetchMock);
    const notice = vi.fn();
    const withdrawn = vi.fn();
    bus.on('chat:notice-message', notice);
    bus.on('chat:service-notice-withdrawn', withdrawn);
    const { initAnnouncementPolling } = await import('../announcement.ts');
    initAnnouncementPolling();
    setState('network.appRole', 'host');
    await flushAnnouncementCheck();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    setState('network.appRole', 'idle');
    setState('network.appRole', 'guest');
    await flushAnnouncementCheck();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(notice.mock.calls.map((call) => call[1])).toEqual(['Before expiry', 'New publication']);
    expect(withdrawn).toHaveBeenCalledExactlyOnceWith('A');
  });

  it('does not display an already-expired revision from a lagging isolate', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ enabled: false, revision: 2 }))
        .mockResolvedValueOnce(
          Response.json({ enabled: true, id: 'A', message: 'Expired', revision: 2 }),
        ),
    );
    const notice = vi.fn();
    bus.on('chat:notice-message', notice);
    const { initAnnouncementPolling } = await import('../announcement.ts');
    initAnnouncementPolling();
    setState('network.appRole', 'host');
    await flushAnnouncementCheck();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(notice).not.toHaveBeenCalled();
  });

  it.each([null, '3', -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'ignores malformed revision %s without poisoning the later valid baseline',
    async (revision) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(Response.json({ enabled: false, revision }))
          .mockResolvedValueOnce(
            Response.json({ enabled: true, id: 'A', message: 'Valid', revision: 1 }),
          ),
      );
      const notice = vi.fn();
      bus.on('chat:notice-message', notice);
      const { initAnnouncementPolling } = await import('../announcement.ts');
      const { showToast } = await import('../toast.ts');
      initAnnouncementPolling();
      setState('network.appRole', 'host');
      await flushAnnouncementCheck();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(notice).toHaveBeenCalledOnce();
      expect(showToast).not.toHaveBeenCalled();
    },
  );
});
