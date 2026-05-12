/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG, TRANSFER_STATE } from '../../core/constants.ts';
import type { DataConnection } from '../../types/index.ts';

beforeEach(() => {
  resetState();
  bus.clear();
});

// ─── TRANSFER_STATE Constants ─────────────────────────────────────────

describe('TRANSFER_STATE constants', () => {
  it('has IDLE state', () => {
    expect(TRANSFER_STATE.IDLE).toBe('IDLE');
  });

  it('has RECEIVING state', () => {
    expect(TRANSFER_STATE.RECEIVING).toBe('RECEIVING');
  });

  it('has PROCESSING state', () => {
    expect(TRANSFER_STATE.PROCESSING).toBe('PROCESSING');
  });

  it('has READY state', () => {
    expect(TRANSFER_STATE.READY).toBe('READY');
  });

  it('has exactly 4 states', () => {
    expect(Object.keys(TRANSFER_STATE)).toHaveLength(4);
  });
});

// ─── Initial Transfer State ───────────────────────────────────────────

describe('initial transfer state', () => {
  it('transfer.state defaults to IDLE', () => {
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.IDLE);
  });

  it('transfer.receivedCount defaults to 0', () => {
    expect(getState('transfer.receivedCount')).toBe(0);
  });

  it('transfer.localSessionId defaults to 0', () => {
    expect(getState('transfer.localSessionId')).toBe(0);
  });

  it('transfer.currentSessionId defaults to 0', () => {
    expect(getState('transfer.currentSessionId')).toBe(0);
  });

  it('transfer.activeBroadcastSession defaults to null', () => {
    expect(getState('transfer.activeBroadcastSession')).toBeNull();
  });

  it('transfer.meta defaults to empty object', () => {
    const meta = getState('transfer.meta');
    expect(meta).toBeDefined();
    expect(typeof meta).toBe('object');
  });
});

// ─── State Reset ──────────────────────────────────────────────────────

describe('transfer state reset', () => {
  it('resetState restores transfer.state to IDLE', () => {
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);

    resetState();
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.IDLE);
  });

  it('resetState restores transfer.receivedCount to 0', () => {
    setState('transfer.receivedCount', 42);
    expect(getState('transfer.receivedCount')).toBe(42);

    resetState();
    expect(getState('transfer.receivedCount')).toBe(0);
  });
});

// ─── Transfer Module Exports ──────────────────────────────────────────

describe('transfer module exports', () => {
  it('imports broadcastFile without error', async () => {
    const mod = await import('../transfer.ts');
    expect(typeof mod.broadcastFile).toBe('function');
  });

  it('imports unicastFile without error', async () => {
    const mod = await import('../transfer.ts');
    expect(typeof mod.unicastFile).toBe('function');
  });

  it('imports initTransfer without error', async () => {
    const mod = await import('../transfer.ts');
    expect(typeof mod.initTransfer).toBe('function');
  });
});

describe('host outgoing transfer routing', () => {
  it('stops sending chunks to a peer that disconnects after FILE_START', async () => {
    const { broadcastFile } = await import('../transfer.ts');
    const currentConn = {
      open: true,
      peer: 'peer-current',
      send: vi.fn(),
    } as unknown as DataConnection;
    const staleConn = {
      open: true,
      peer: 'peer-stale',
      send: vi.fn((msg: Record<string, unknown>) => {
        if (msg.type !== MSG.FILE_START) return;
        setState('network.connectedPeers', [
          {
            id: 'peer-current',
            status: 'connected',
            conn: currentConn,
            isDataTarget: true,
            connectionType: 'local',
            joinOrder: 1,
          },
        ]);
        setState('network.activeHostConnByPeerId', new Map([['peer-current', currentConn]]));
      }),
    } as unknown as DataConnection;

    setState('playlist.currentTrackIndex', 0);
    setState('network.connectedPeers', [
      {
        id: 'peer-current',
        status: 'connected',
        conn: currentConn,
        isDataTarget: true,
        connectionType: 'local',
        joinOrder: 1,
      },
      {
        id: 'peer-stale',
        status: 'connected',
        conn: staleConn,
        isDataTarget: true,
        connectionType: 'local',
        joinOrder: 2,
      },
    ]);
    setState(
      'network.activeHostConnByPeerId',
      new Map([
        ['peer-current', currentConn],
        ['peer-stale', staleConn],
      ]),
    );

    await broadcastFile(new File(['abc'], 'song.mp3', { type: 'audio/mpeg' }), 1);

    expect(staleConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_START }));
    expect(staleConn.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.FILE_CHUNK }),
    );
    expect(currentConn.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.FILE_CHUNK }),
    );
    expect(currentConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_END }));
  });

  it('skips disconnected peer connections before bulk file broadcast starts', async () => {
    const { broadcastFile } = await import('../transfer.ts');
    const liveConn = {
      open: true,
      peer: 'peer-live',
      send: vi.fn(),
      peerConnection: { connectionState: 'connected' },
      dataChannel: { readyState: 'open', bufferedAmount: 0 },
    } as unknown as DataConnection;
    const disconnectedConn = {
      open: true,
      peer: 'peer-disconnected',
      send: vi.fn(),
      peerConnection: { connectionState: 'disconnected' },
      dataChannel: { readyState: 'open', bufferedAmount: 1024 * 1024 },
    } as unknown as DataConnection;

    setState('playlist.currentTrackIndex', 0);
    setState('network.connectedPeers', [
      {
        id: 'peer-live',
        status: 'connected',
        conn: liveConn,
        isDataTarget: true,
        connectionType: 'local',
        joinOrder: 1,
      },
      {
        id: 'peer-disconnected',
        status: 'connected',
        conn: disconnectedConn,
        isDataTarget: true,
        connectionType: 'local',
        joinOrder: 2,
      },
    ]);
    setState(
      'network.activeHostConnByPeerId',
      new Map([
        ['peer-live', liveConn],
        ['peer-disconnected', disconnectedConn],
      ]),
    );

    await broadcastFile(new File(['abc'], 'song.mp3', { type: 'audio/mpeg' }), 1);

    expect(disconnectedConn.send).not.toHaveBeenCalled();
    expect(liveConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_START }));
    expect(liveConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_CHUNK }));
    expect(liveConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_END }));
  });
});
