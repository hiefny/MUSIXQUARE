import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import type { DataConnection } from '../../types/index.ts';

vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('peer routing orchestrator', () => {
  const conn = { open: true, peer: 'peer-1' } as DataConnection;

  beforeEach(() => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
  });

  it('emits data-target-ready without peer-joined when a remote peer is reclassified local', async () => {
    const { initOrchestrator } = await import('../orchestrator.ts');
    const joined = vi.fn();
    const evaluated = vi.fn();
    const dataTargetReady = vi.fn();

    setState('network.connectedPeers', [
      {
        id: 'peer-1',
        conn,
        status: 'connected',
        connectionType: 'local',
        isDataTarget: false,
        label: 'Guest',
      },
    ]);

    initOrchestrator();
    bus.on('orchestrator:peer-joined', joined);
    bus.on('orchestrator:peer-evaluated', evaluated);
    bus.on('orchestrator:peer-data-target-ready', dataTargetReady);

    bus.emit('orchestrator:peer-type-detected', 'peer-1', false);

    expect(evaluated).toHaveBeenCalledWith('peer-1');
    expect(joined).not.toHaveBeenCalled();
    expect(dataTargetReady).toHaveBeenCalledWith('peer-1');
    expect(getState('network.connectedPeers')[0]?.isDataTarget).toBe(true);
  });
});
