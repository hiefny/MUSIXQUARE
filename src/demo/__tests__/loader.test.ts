import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import type { DataConnection } from '../../types/index.ts';

const demoRuntime = vi.hoisted(() => ({
  init: vi.fn(),
  reconcile: vi.fn(),
  handleProtocolMessage: vi.fn(),
}));
const demoStorage = vi.hoisted(() => ({ hasAppUseRecord: vi.fn(() => false) }));

vi.mock('../mode.ts', () => ({
  initDemoMode: demoRuntime.init,
  reconcileDemoFirstRunPrompt: demoRuntime.reconcile,
  handleDemoProtocolMessage: demoRuntime.handleProtocolMessage,
}));

vi.mock('../storage.ts', () => ({
  hasAppUseRecord: demoStorage.hasAppUseRecord,
}));

function enterMessage(index: number) {
  return {
    type: MSG.DEMO_ENTER,
    index,
    reverbOn: false,
    bassBoostOn: false,
    trebleBoostOn: false,
    surroundOn: false,
  };
}

describe('demo runtime loader', () => {
  beforeEach(() => {
    vi.resetModules();
    demoRuntime.init.mockReset();
    demoRuntime.reconcile.mockReset();
    demoRuntime.handleProtocolMessage.mockReset();
    demoStorage.hasAppUseRecord.mockReset();
    demoStorage.hasAppUseRecord.mockReturnValue(false);
    vi.doMock('../mode.ts', () => ({
      initDemoMode: demoRuntime.init,
      reconcileDemoFirstRunPrompt: demoRuntime.reconcile,
      handleDemoProtocolMessage: demoRuntime.handleProtocolMessage,
    }));
  });

  afterEach(() => vi.useRealTimers());

  it('loads once and replays the first explicit demo entry', async () => {
    const [{ bus }, { resetState }, { initDemoModeLoader }] = await Promise.all([
      import('../../core/events.ts'),
      import('../../core/state.ts'),
      import('../loader.ts'),
    ]);
    bus.clear();
    resetState();
    const entries = vi.fn();
    bus.on('demo:enter', entries);
    initDemoModeLoader();

    bus.emit('demo:enter');
    await vi.dynamicImportSettled();

    expect(demoRuntime.init).toHaveBeenCalledTimes(1);
    expect(entries).toHaveBeenCalledTimes(2);
  });

  it('prepares remote handlers and the first-run prompt after session start', async () => {
    const [{ bus }, { resetState, setState }, { initDemoModeLoader }] = await Promise.all([
      import('../../core/events.ts'),
      import('../../core/state.ts'),
      import('../loader.ts'),
    ]);
    bus.clear();
    resetState();
    initDemoModeLoader();

    setState('setup.sessionStarted', true);
    await vi.dynamicImportSettled();

    expect(demoRuntime.init).toHaveBeenCalledTimes(1);
    expect(demoRuntime.reconcile).toHaveBeenCalledTimes(1);
  });

  it('preserves the pre-Start app-use snapshot for the first-run prompt', async () => {
    const [{ bus }, { resetState, setState }, { initDemoModeLoader }] = await Promise.all([
      import('../../core/events.ts'),
      import('../../core/state.ts'),
      import('../loader.ts'),
    ]);
    bus.clear();
    resetState();
    initDemoModeLoader();

    // prepareSetupStartFromGesture records use before sessionStarted. Runtime
    // loading must still observe the earlier first-visit snapshot.
    demoStorage.hasAppUseRecord.mockReturnValue(true);
    setState('setup.sessionStarted', true);
    await vi.dynamicImportSettled();

    expect(demoRuntime.init).toHaveBeenCalledWith({
      protocolHandlersRegistered: true,
      suppressFirstRunPrompt: false,
    });
  });

  it('preserves the initial remote ENTER and PLAY frames while the runtime loads', async () => {
    const { conn, send } = await guestLoader();
    const enter = enterMessage(1);
    const play = { type: MSG.DEMO_PLAY, index: 1, time: 2, hostPlayAt: 3 };
    const enterPending = send(enter);
    const playPending = send(play);

    expect(demoRuntime.init).not.toHaveBeenCalled();
    await Promise.all([enterPending, playPending]);

    expect(demoRuntime.init).toHaveBeenCalledTimes(1);
    expect(demoRuntime.init).toHaveBeenCalledWith({
      protocolHandlersRegistered: true,
      suppressFirstRunPrompt: false,
    });
    expect(demoRuntime.handleProtocolMessage.mock.calls).toEqual([
      [enter, conn],
      [play, conn],
    ]);
  });

  async function guestLoader() {
    const [{ bus }, state, { initDemoModeLoader }, { handleData }, { markQueueAuthorityReady }] =
      await Promise.all([
        import('../../core/events.ts'),
        import('../../core/state.ts'),
        import('../loader.ts'),
        import('../../network/protocol.ts'),
        import('../../network/queue-authority.ts'),
      ]);
    bus.clear();
    state.resetState();
    const conn = { open: true, peer: 'host-1' } as DataConnection;
    state.setState('network.appRole', 'guest');
    state.setState('network.hostConn', conn);
    markQueueAuthorityReady(conn);
    initDemoModeLoader();
    const send = (message: Record<string, unknown>) => handleData(message, conn);
    return { bus, ...state, conn, send, handleData, markQueueAuthorityReady };
  }

  it('retires ENTER and PLAY when EXIT arrives before import completion', async () => {
    const { send } = await guestLoader();
    await Promise.all([
      send(enterMessage(0)),
      send({ type: MSG.DEMO_PLAY, index: 0, time: 0, hostPlayAt: 0 }),
      send({ type: MSG.DEMO_EXIT }),
    ]);
    expect(demoRuntime.handleProtocolMessage).not.toHaveBeenCalled();
  });

  it('coalesces entry and playback to only the newest deferred track and pause', async () => {
    const { conn, send } = await guestLoader();
    const latestEnter = { ...enterMessage(1), reverbOn: true };
    const pause = { type: MSG.DEMO_PAUSE, time: 70 };
    await Promise.all([
      send(enterMessage(0)),
      send({ type: MSG.DEMO_PLAY, index: 0, time: 0, hostPlayAt: 0 }),
      send(latestEnter),
      send(pause),
    ]);
    expect(demoRuntime.handleProtocolMessage.mock.calls).toEqual([
      [latestEnter, conn],
      [pause, conn],
    ]);
  });

  it('accepts a new entry after EXIT while the same runtime import is still pending', async () => {
    const { conn, send } = await guestLoader();
    const latestEnter = enterMessage(2);
    const latestPlay = { type: MSG.DEMO_PLAY, index: 2, time: 8, hostPlayAt: 10_000 };
    await Promise.all([
      send(enterMessage(0)),
      send({ type: MSG.DEMO_EXIT }),
      send(latestEnter),
      send(latestPlay),
    ]);
    expect(demoRuntime.init).toHaveBeenCalledTimes(1);
    expect(demoRuntime.handleProtocolMessage.mock.calls).toEqual([
      [latestEnter, conn],
      [latestPlay, conn],
    ]);
  });

  it('does not replay bootstrap from a replaced connection with the same peer ID', async () => {
    const { conn, setState, send } = await guestLoader();
    const entry = send(enterMessage(0));
    setState('network.hostConn', { open: true, peer: conn.peer } as DataConnection);
    await entry;
    expect(demoRuntime.handleProtocolMessage).not.toHaveBeenCalled();
  });

  it('keeps a replacement connection bootstrap during the old pending import', async () => {
    const { conn, setState, send, handleData, markQueueAuthorityReady } = await guestLoader();
    const oldEntry = send(enterMessage(0));
    const replacement = { open: true, peer: conn.peer } as DataConnection;
    setState('network.hostConn', replacement);
    markQueueAuthorityReady(replacement);
    const latestEnter = enterMessage(1);
    await Promise.all([oldEntry, handleData(latestEnter, replacement)]);
    expect(demoRuntime.handleProtocolMessage.mock.calls).toEqual([[latestEnter, replacement]]);
  });

  it('does not bypass exact connection or queue bootstrap authority while cold', async () => {
    const { conn, setState, send, handleData } = await guestLoader();
    await handleData(enterMessage(0), { open: true, peer: conn.peer } as DataConnection);
    const unbootstrapped = { open: true, peer: 'host-2' } as DataConnection;
    setState('network.hostConn', unbootstrapped);
    await handleData(enterMessage(0), unbootstrapped);
    await send(enterMessage(0));
    expect(demoRuntime.init).not.toHaveBeenCalled();
  });

  it('does not apply a deferred control after entry triggers an authority reset', async () => {
    const { bus, conn, send } = await guestLoader();
    demoRuntime.handleProtocolMessage.mockImplementationOnce(() =>
      bus.emit('demo:authority-reset'),
    );
    const enter = enterMessage(0);
    await Promise.all([
      send(enter),
      send({ type: MSG.DEMO_PLAY, index: 0, time: 0, hostPlayAt: 0 }),
    ]);
    expect(demoRuntime.handleProtocolMessage.mock.calls).toEqual([[enter, conn]]);
  });

  it('retries a failed import and preserves the initial bootstrap', async () => {
    vi.useFakeTimers();
    vi.doMock('../mode.ts', () => {
      throw new Error('temporary chunk failure');
    });
    const { conn, send } = await guestLoader();
    const enter = enterMessage(1);
    const play = { type: MSG.DEMO_PLAY, index: 1, time: 2, hostPlayAt: 3 };
    await Promise.all([send(enter), send(play)]);
    vi.doMock('../mode.ts', () => ({
      initDemoMode: demoRuntime.init,
      reconcileDemoFirstRunPrompt: demoRuntime.reconcile,
      handleDemoProtocolMessage: demoRuntime.handleProtocolMessage,
    }));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.dynamicImportSettled();
    expect(demoRuntime.handleProtocolMessage.mock.calls).toEqual([
      [enter, conn],
      [play, conn],
    ]);
  });

  it('retains only the latest snapshot without accelerating the retry timer', async () => {
    vi.useFakeTimers();
    demoRuntime.init.mockImplementationOnce(() => {
      throw new Error('temporary runtime failure');
    });
    const { conn, send } = await guestLoader();
    await send(enterMessage(0));
    const enter = enterMessage(1);
    const pause = { type: MSG.DEMO_PAUSE, time: 70 };
    await Promise.all([send(enter), send(pause)]);
    expect(demoRuntime.init).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(demoRuntime.init).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.dynamicImportSettled();
    expect(demoRuntime.init).toHaveBeenCalledTimes(2);
    expect(demoRuntime.handleProtocolMessage.mock.calls).toEqual([
      [enter, conn],
      [pause, conn],
    ]);
  });

  it.each([
    'exit',
    'connection',
    'disconnect',
    'authority',
    'session',
    'session-end',
    'room',
  ] as const)('cancels pending retry on %s', async (boundary) => {
    vi.useFakeTimers();
    demoRuntime.init.mockImplementation(() => {
      throw new Error('temporary runtime failure');
    });
    const { bus, getState, setState, send } = await guestLoader();
    if (boundary === 'session-end') setState('setup.sessionStarted', true);
    await send(enterMessage(0));
    expect(demoRuntime.init).toHaveBeenCalledTimes(1);
    if (boundary === 'exit') await send({ type: MSG.DEMO_EXIT });
    if (boundary === 'connection')
      setState('network.hostConn', { open: true, peer: 'host-1' } as DataConnection);
    if (boundary === 'disconnect') setState('network.hostConn', null);
    if (boundary === 'authority') bus.emit('demo:authority-reset');
    if (boundary === 'session') setState('network.sessionCode', '654321');
    if (boundary === 'session-end') setState('setup.sessionStarted', false);
    if (boundary === 'room') setState('room.context', { ...getState('room.context'), epoch: 1 });
    demoRuntime.init.mockReset();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(demoRuntime.init).not.toHaveBeenCalled();
    expect(demoRuntime.handleProtocolMessage).not.toHaveBeenCalled();
  });

  it('bounds persistent failures and reports a current entry once', async () => {
    vi.useFakeTimers();
    demoRuntime.init.mockImplementation(() => {
      throw new Error('persistent runtime failure');
    });
    const { bus, send } = await guestLoader();
    const showFailure = vi.fn();
    bus.on('ui:show-toast', showFailure);
    await send(enterMessage(0));
    for (let attempt = 0; attempt < 5; attempt++) {
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.dynamicImportSettled();
    }
    expect(demoRuntime.init).toHaveBeenCalledTimes(4);
    expect(showFailure).toHaveBeenCalledTimes(1);
  });
});
