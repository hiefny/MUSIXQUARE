/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostPresence } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  showDialog: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
  showToast: vi.fn(),
  scheduleDocumentReload: vi.fn(),
  presence: { current: 'ok' as HostPresence },
}));

vi.mock('../dialog.ts', () => ({ showDialog: mocks.showDialog }));
vi.mock('../toast.ts', () => ({
  showLoader: mocks.showLoader,
  updateLoader: mocks.updateLoader,
  showToast: mocks.showToast,
}));
vi.mock('../../core/session-reset.ts', () => ({
  scheduleDocumentReload: mocks.scheduleDocumentReload,
}));
vi.mock('../../network/host-presence.ts', () => ({
  getHostPresence: () => mocks.presence.current,
}));

const APP_USED_KEY = 'musixquare-app-used-v1';

type Modules = {
  bus: typeof import('../../core/events.ts').bus;
  setState: typeof import('../../core/state.ts').setState;
  t: typeof import('../../i18n/index.ts').t;
};

async function boot(firstVisit: boolean): Promise<Modules> {
  vi.resetModules();
  if (firstVisit) localStorage.removeItem(APP_USED_KEY);
  else localStorage.setItem(APP_USED_KEY, '1');
  const [{ bus }, { setState, resetState }, { t }, { initKeepOpenNotice }] = await Promise.all([
    import('../../core/events.ts'),
    import('../../core/state.ts'),
    import('../../i18n/index.ts'),
    import('../keep-open-notice.ts'),
  ]);
  resetState();
  initKeepOpenNotice();
  // The Start gesture records app use after boot; the notice keeps its boot view.
  localStorage.setItem(APP_USED_KEY, '1');
  setState('setup.sessionStarted', true);
  return { bus, setState, t };
}

function addMedia(setState: Modules['setState']): void {
  setState('playlist.items', [
    { queueItemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'file', name: 'song.mp3' },
  ] as never);
}

function presence(bus: Modules['bus'], next: HostPresence, cause: 'host' | 'reset' = 'host'): void {
  const previous = mocks.presence.current;
  mocks.presence.current = next;
  bus.emit('host-presence:changed', next, previous, cause);
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.showDialog.mockReset().mockResolvedValue({ action: 'ok' });
  mocks.showLoader.mockReset();
  mocks.updateLoader.mockReset();
  mocks.showToast.mockReset();
  mocks.scheduleDocumentReload.mockReset();
  mocks.presence.current = 'ok';
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('first-media keep-open notice', () => {
  it('tells a first-time visitor once, when the first media appears', async () => {
    const { setState, t } = await boot(true);

    expect(mocks.showDialog).not.toHaveBeenCalled();
    addMedia(setState);
    addMedia(setState);

    expect(mocks.showDialog).toHaveBeenCalledTimes(1);
    expect(mocks.showDialog).toHaveBeenCalledWith({
      title: t('dialog.keep_open_title'),
      message: t('dialog.keep_open_message'),
      buttonText: t('dialog.got_it'),
    });
  });

  it('tells a first-time guest who joins a room that already has media', async () => {
    const { setState } = await boot(true);
    // The join bootstrap applies the playlist before the session counts as started.
    setState('setup.sessionStarted', false);
    addMedia(setState);
    expect(mocks.showDialog).not.toHaveBeenCalled();

    setState('setup.sessionStarted', true);

    expect(mocks.showDialog).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for someone who has used MUSIXQUARE before', async () => {
    const { setState } = await boot(false);

    addMedia(setState);

    expect(mocks.showDialog).not.toHaveBeenCalled();
  });

  it('waits for the demo to end before telling a first-time visitor', async () => {
    const { setState } = await boot(true);
    setState('demo.active', true);

    addMedia(setState);
    expect(mocks.showDialog).not.toHaveBeenCalled();

    setState('demo.active', false);
    expect(mocks.showDialog).toHaveBeenCalledTimes(1);
  });

  it('leaves PRO rooms alone', async () => {
    const { setState } = await boot(true);
    setState('room.context', {
      kind: 'pro',
      roomId: 'room-1',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 0,
      capabilities: [],
    });

    addMedia(setState);

    expect(mocks.showDialog).not.toHaveBeenCalled();
  });
});

describe('host-waiting loader', () => {
  it('shows an empty priority loader at once when the host stops answering', async () => {
    const { bus, t } = await boot(false);

    presence(bus, 'unresponsive');

    expect(mocks.showLoader).toHaveBeenCalledWith(
      true,
      t('network.host_waiting'),
      'host-presence',
      { priority: true },
    );
    // Waiting has no progress: the bar stays at 0, like a preparing loader.
    expect(mocks.updateLoader).not.toHaveBeenCalled();
  });

  it('waits two seconds before covering a host that is only in the background', async () => {
    const { bus } = await boot(false);

    presence(bus, 'background');
    vi.advanceTimersByTime(1_999);
    expect(mocks.showLoader).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(mocks.showLoader).toHaveBeenCalledTimes(1);
  });

  it('skips the loader and the toast for a host that returns within two seconds', async () => {
    const { bus } = await boot(false);

    presence(bus, 'background');
    vi.advanceTimersByTime(1_000);
    presence(bus, 'ok');
    vi.advanceTimersByTime(5_000);

    expect(mocks.showLoader).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('releases the loader with a toast when the host comes back', async () => {
    const { bus, t } = await boot(false);
    presence(bus, 'unresponsive');

    presence(bus, 'ok');

    expect(mocks.showLoader).toHaveBeenLastCalledWith(false, undefined, 'host-presence');
    expect(mocks.showToast).toHaveBeenCalledWith(t('toast.host_back'));
  });

  it('releases the loader without a toast when the connection resets', async () => {
    const { bus } = await boot(false);
    presence(bus, 'unresponsive');

    presence(bus, 'ok', 'reset');

    expect(mocks.showLoader).toHaveBeenLastCalledWith(false, undefined, 'host-presence');
    expect(mocks.showToast).not.toHaveBeenCalled();
  });
});

describe('long host silence', () => {
  it('offers to leave and reloads into the home screen on request', async () => {
    const { bus, t } = await boot(false);
    mocks.showDialog.mockResolvedValue({ action: 'secondary' });
    presence(bus, 'unresponsive');

    bus.emit('host-presence:long-unresponsive');
    await vi.waitFor(() => expect(mocks.scheduleDocumentReload).toHaveBeenCalled());

    expect(mocks.showDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: t('dialog.host_unresponsive_title'),
        buttonText: t('dialog.keep_waiting'),
        secondaryText: t('dialog.leave_session'),
      }),
    );
    expect(mocks.scheduleDocumentReload).toHaveBeenCalledWith(t('dialog.leaving_session'));
  });

  it('withdraws the offer when the host answers again', async () => {
    const { bus } = await boot(false);
    mocks.showDialog.mockReturnValue(new Promise(() => {}));
    presence(bus, 'unresponsive');
    bus.emit('host-presence:long-unresponsive');
    const { signal } = mocks.showDialog.mock.calls[0]?.[0] as { signal: AbortSignal };

    presence(bus, 'ok');

    expect(signal.aborted).toBe(true);
  });
});
