import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

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
        slot: 1,
        conn,
        isOp: false,
        preloadedQueueItemIds: new Set(),
        status: 'connected',
        connectionType: 'local',
        isDataTarget: false,
        joinOrder: 1,
        lastHeartbeat: 0,
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

  function makeRoutedPeer(
    id: string,
    connectionType: 'local' | 'remote' | 'unknown',
    isDataTarget = false,
  ): ConnectedPeer {
    return {
      id,
      slot: 1,
      conn,
      isOp: false,
      preloadedQueueItemIds: new Set(),
      status: 'connected',
      connectionType,
      isDataTarget,
      joinOrder: 1,
      lastHeartbeat: 0,
      label: 'Guest',
    };
  }

  it('promotes only local peers on initial detection and leaves unknown peers unevaluated', async () => {
    const { initOrchestrator } = await import('../orchestrator.ts');
    const joined = vi.fn();
    const evaluated = vi.fn();
    const dataTargetReady = vi.fn();

    setState('network.connectedPeers', [
      makeRoutedPeer('peer-local', 'local'),
      makeRoutedPeer('peer-remote', 'remote'),
      makeRoutedPeer('peer-unknown', 'unknown'),
    ]);

    initOrchestrator();
    bus.on('orchestrator:peer-joined', joined);
    bus.on('orchestrator:peer-evaluated', evaluated);
    bus.on('orchestrator:peer-data-target-ready', dataTargetReady);

    bus.emit('orchestrator:peer-type-detected', 'peer-local');
    bus.emit('orchestrator:peer-type-detected', 'peer-remote');
    bus.emit('orchestrator:peer-type-detected', 'peer-unknown');

    expect(joined).toHaveBeenCalledWith('peer-local');
    expect(joined).toHaveBeenCalledWith('peer-remote');
    expect(joined).not.toHaveBeenCalledWith('peer-unknown');
    expect(evaluated).toHaveBeenCalledTimes(2);
    // Initial joins announce via peer-joined; data-target-ready is reserved
    // for later reclassification promotions.
    expect(dataTargetReady).not.toHaveBeenCalled();

    const peers = getState('network.connectedPeers');
    expect(peers.find((p) => p.id === 'peer-local')?.isDataTarget).toBe(true);
    expect(peers.find((p) => p.id === 'peer-remote')?.isDataTarget).toBe(false);
    expect(peers.find((p) => p.id === 'peer-unknown')?.isDataTarget).toBe(false);
  });

  it('re-evaluates survivors on peer disconnect without re-announcing existing data targets', async () => {
    const { initOrchestrator } = await import('../orchestrator.ts');
    const joined = vi.fn();
    const evaluated = vi.fn();
    const dataTargetReady = vi.fn();

    // host.ts removes the departing peer from connectedPeers before emitting
    // network:peer-disconnected — state below mirrors that moment.
    setState('network.connectedPeers', [
      makeRoutedPeer('peer-local', 'local', true),
      makeRoutedPeer('peer-remote', 'remote'),
    ]);

    initOrchestrator();
    bus.on('orchestrator:peer-joined', joined);
    bus.on('orchestrator:peer-evaluated', evaluated);
    bus.on('orchestrator:peer-data-target-ready', dataTargetReady);

    bus.emit('network:peer-disconnected', 'peer-departed');

    expect(evaluated).toHaveBeenCalledWith('peer-local');
    expect(evaluated).toHaveBeenCalledWith('peer-remote');
    expect(evaluated).not.toHaveBeenCalledWith('peer-departed');
    // No join re-announce and no data-target-ready storm: the local peer was
    // already promoted and the remote peer must not be promoted by churn.
    expect(joined).not.toHaveBeenCalled();
    expect(dataTargetReady).not.toHaveBeenCalled();

    const peers = getState('network.connectedPeers');
    expect(peers.find((p) => p.id === 'peer-local')?.isDataTarget).toBe(true);
    expect(peers.find((p) => p.id === 'peer-remote')?.isDataTarget).toBe(false);
  });
});
