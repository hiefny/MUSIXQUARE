/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { handleData } from '../../network/protocol.ts';
import {
  setPreamp,
  setStereoWidth,
  resetStereoWidth,
  setVirtualBass,
  resetVirtualBass,
  applyRoomEffectsState,
  captureRoomEffectsState,
  initEffectsHandlers,
} from '../effects.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

beforeEach(() => {
  resetState();
  bus.clear();
});

function makeConnection(peer: string): DataConnection {
  return { peer } as DataConnection;
}

function makeConnectedPeer(id: string, isOp: boolean): ConnectedPeer {
  return {
    id,
    slot: 0,
    label: id,
    conn: null,
    isOp,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 0,
    connectionType: 'unknown',
    lastHeartbeat: 0,
  };
}

describe('setPreamp', () => {
  it('0 dB → gain 1.0', () => {
    setPreamp(0);
    expect(getState('audio.userPreampGain')).toBeCloseTo(1.0);
  });

  it('6 dB → gain ≈ 1.995', () => {
    setPreamp(6);
    expect(getState('audio.userPreampGain')).toBeCloseTo(1.9953, 3);
  });

  it('-6 dB → gain ≈ 0.501', () => {
    setPreamp(-6);
    expect(getState('audio.userPreampGain')).toBeCloseTo(0.5012, 3);
  });

  it('20 dB → clamped to 12 dB → gain ≈ 3.98', () => {
    setPreamp(20);
    // Values above the public range are clamped before conversion to linear gain.
    expect(getState('audio.userPreampGain')).toBeCloseTo(3.981, 2);
  });
});

describe('setStereoWidth', () => {
  it('100 → stereoWidth 1.0', () => {
    setStereoWidth(100);
    expect(getState('audio.stereoWidth')).toBeCloseTo(1.0);
  });

  it('0 → stereoWidth 0.0', () => {
    setStereoWidth(0);
    expect(getState('audio.stereoWidth')).toBeCloseTo(0.0);
  });

  it('200 → stereoWidth 2.0', () => {
    setStereoWidth(200);
    expect(getState('audio.stereoWidth')).toBeCloseTo(2.0);
  });
});

describe('resetStereoWidth', () => {
  it('resets to 1.0', () => {
    setStereoWidth(50);
    resetStereoWidth();
    expect(getState('audio.stereoWidth')).toBeCloseTo(1.0);
  });
});

describe('setVirtualBass', () => {
  it('50 → virtualBass 0.5', () => {
    setVirtualBass(50);
    expect(getState('audio.virtualBass')).toBeCloseTo(0.5);
  });

  it('0 → virtualBass 0.0', () => {
    setVirtualBass(0);
    expect(getState('audio.virtualBass')).toBeCloseTo(0.0);
  });

  it('100 → virtualBass 1.0', () => {
    setVirtualBass(100);
    expect(getState('audio.virtualBass')).toBeCloseTo(1.0);
  });
});

describe('resetVirtualBass', () => {
  it('resets to 0.0', () => {
    setVirtualBass(75);
    resetVirtualBass();
    expect(getState('audio.virtualBass')).toBeCloseTo(0.0);
  });
});

describe('room-wide effect snapshots', () => {
  it('applies and captures only the persistent room-wide DSP fields', () => {
    setState('audio.userPreampGain', 1.7);
    setState('audio.exciter', false);
    setState('audio.subFreq', 87);
    const effects = {
      reverb: {
        mixPercent: 40,
        decaySeconds: 1,
        preDelaySeconds: 0.02,
        lowCutPercent: 10,
        highCutPercent: 30,
      },
      equalizer: { bandsDb: [0, -2, 0, 4, 6] as [number, number, number, number, number] },
      virtualBass: { strengthPercent: 60 },
      virtualSurround: { widthPercent: 120 },
      virtualTreble: { enabled: true },
    };

    expect(applyRoomEffectsState(effects)).toBe(true);
    expect(captureRoomEffectsState()).toEqual(effects);
    expect(getState('audio.userPreampGain')).toBe(1.7);
    expect(getState('audio.exciter')).toBe(true);
    expect(getState('audio.subFreq')).toBe(87);
  });

  it('rejects a malformed full snapshot without partially mutating state', () => {
    const before = captureRoomEffectsState();
    expect(
      applyRoomEffectsState({
        ...before,
        virtualSurround: { widthPercent: 201 },
      }),
    ).toBe(false);
    expect(captureRoomEffectsState()).toEqual(before);
  });
});

describe('request-eq-reset authorization', () => {
  beforeEach(() => {
    initEffectsHandlers();
  });

  it('rejects demo non-operators', async () => {
    const conn = makeConnection('guest-demo');
    setState('demo.active', true);
    setState('audio.eqValues', [1, 2, 3, 4, 5]);

    await handleData({ type: MSG.REQUEST_EQ_RESET }, conn);

    expect(getState('audio.eqValues')).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps room effects host-only for standard administrators', async () => {
    const conn = makeConnection('guest-op');
    setState('network.appRole', 'host');
    setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
    setState('network.connectedPeers', [{ ...makeConnectedPeer(conn.peer, true), conn }]);
    setState('audio.eqValues', [1, 2, 3, 4, 5]);
    setState('audio.userPreampGain', 2);

    await handleData({ type: MSG.REQUEST_EQ_RESET }, conn);

    expect(getState('audio.eqValues')).toEqual([1, 2, 3, 4, 5]);
    expect(getState('audio.userPreampGain')).toBe(2);
  });
});
