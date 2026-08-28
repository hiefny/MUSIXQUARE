import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import type { DataConnection } from '../../types/index.ts';

const demoRuntime = vi.hoisted(() => ({
  init: vi.fn(),
  reconcile: vi.fn(),
  handleProtocolMessage: vi.fn(),
}));
const protocol = vi.hoisted(() => ({
  handlers: {} as Record<
    string,
    (data: Record<string, unknown>, conn: DataConnection) => void | Promise<void>
  >,
}));
const demoStorage = vi.hoisted(() => ({ hasAppUseRecord: vi.fn(() => false) }));

vi.mock('../mode.ts', () => ({
  initDemoMode: demoRuntime.init,
  reconcileDemoFirstRunPrompt: demoRuntime.reconcile,
  handleDemoProtocolMessage: demoRuntime.handleProtocolMessage,
}));

vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn(
    (
      handlers: Record<
        string,
        (data: Record<string, unknown>, conn: DataConnection) => void | Promise<void>
      >,
    ) => Object.assign(protocol.handlers, handlers),
  ),
}));

vi.mock('../storage.ts', () => ({
  hasAppUseRecord: demoStorage.hasAppUseRecord,
}));

describe('demo runtime loader', () => {
  beforeEach(() => {
    vi.resetModules();
    demoRuntime.init.mockReset();
    demoRuntime.reconcile.mockReset();
    demoRuntime.handleProtocolMessage.mockReset();
    demoStorage.hasAppUseRecord.mockReset();
    demoStorage.hasAppUseRecord.mockReturnValue(false);
    for (const key of Object.keys(protocol.handlers)) delete protocol.handlers[key];
  });

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
    const [{ bus }, { resetState }, { initDemoModeLoader }] = await Promise.all([
      import('../../core/events.ts'),
      import('../../core/state.ts'),
      import('../loader.ts'),
    ]);
    bus.clear();
    resetState();
    initDemoModeLoader();

    const conn = { open: true, peer: 'host-1' } as DataConnection;
    const enter = { type: MSG.DEMO_ENTER, index: 1 };
    const play = { type: MSG.DEMO_PLAY, index: 1, time: 2, hostPlayAt: 3 };
    const enterPending = protocol.handlers[MSG.DEMO_ENTER]?.(enter, conn);
    const playPending = protocol.handlers[MSG.DEMO_PLAY]?.(play, conn);

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
});
