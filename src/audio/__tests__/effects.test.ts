/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { handleData } from '../../network/protocol.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import {
  setPreamp,
  setStereoWidth,
  resetStereoWidth,
  setVirtualBass,
  resetVirtualBass,
  applyRoomEffectsStateForTests as applyRoomEffectsState,
  canAdjustLocalRoomEffectsForTests as canAdjustLocalRoomEffects,
  captureRoomEffectsState,
  captureRoomSettingsSyncState,
  initEffectsHandlers,
  isDeviceLocalEffectTypeForTests as isDeviceLocalEffectType,
  publishLocalSettingsAuthorityForTests as publishLocalSettingsAuthority,
  resetSettingsSyncAuthorityForTests,
  setSettingsSyncEnabled,
} from '../effects.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

beforeEach(() => {
  localStorage.clear();
  resetState();
  bus.clear();
  resetSettingsSyncAuthorityForTests();
});

afterEach(() => {
  clearAllManagedTimers();
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

const synchronizedEffects = {
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

describe('standard-room virtual treble synchronization', () => {
  beforeEach(() => {
    initEffectsHandlers();
  });

  it('applies the host EXCITER frame and synchronizes the guest UI', async () => {
    const host = makeConnection('host');
    const syncExciter = vi.fn();
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    setState('audio.exciter', false);
    bus.on('ui:sync-exciter', syncExciter);

    await handleData({ type: MSG.EXCITER, value: 1 }, host);

    expect(getState('audio.exciter')).toBe(true);
    expect(syncExciter).toHaveBeenCalledWith(true);
  });
});

describe('atomic settings synchronization', () => {
  beforeEach(() => {
    initEffectsHandlers();
    setState('setup.sessionStarted', true);
  });

  it('defaults ON and restores an explicit per-device OFF preference', () => {
    expect(getState('audio.settingsSyncEnabled')).toBe(true);
    setSettingsSyncEnabled(false);
    expect(localStorage.getItem('musixquare-settings-sync')).toBe('off');

    resetState();
    expect(getState('audio.settingsSyncEnabled')).toBe(false);
  });

  it('rejects synchronized room-effect changes from standard and PRO members', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', {
      peer: 'standard-host',
      open: true,
      send: vi.fn(),
    } as unknown as DataConnection);
    expect(canAdjustLocalRoomEffects()).toBe(false);

    setState('room.context', {
      ...getState('room.context'),
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      capabilities: [],
    });
    expect(canAdjustLocalRoomEffects()).toBe(false);
  });

  it('allows synchronized room-effect changes from standard and PRO administrators', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', {
      peer: 'standard-host',
      open: true,
      send: vi.fn(),
    } as unknown as DataConnection);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['effects.control']);
    expect(canAdjustLocalRoomEffects()).toBe(true);

    setState('room.context', {
      ...getState('room.context'),
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      capabilities: ['effects.control'],
    });
    expect(canAdjustLocalRoomEffects()).toBe(true);
  });

  it('allows member-local room effects when settings sync is off', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', {
      peer: 'standard-host',
      open: true,
      send: vi.fn(),
    } as unknown as DataConnection);
    setSettingsSyncEnabled(false);

    expect(canAdjustLocalRoomEffects()).toBe(true);
  });

  it('atomically disables all virtual effects and publishes one canonical snapshot', () => {
    const send = vi.fn();
    const follower = { peer: 'follower', open: true, send } as unknown as DataConnection;
    setState('network.appRole', 'host');
    setState('network.connectedPeers', [
      { ...makeConnectedPeer(follower.peer, false), conn: follower },
    ]);
    setState('network.activeHostConnByPeerId', new Map([[follower.peer, follower]]));
    setState('audio.virtualBass', 0.6);
    setState('audio.exciter', true);
    setState('audio.stereoWidth', 1.2);
    const syncSurround = vi.fn();
    const syncBass = vi.fn();
    const syncTreble = vi.fn();
    bus.on('ui:sync-surround', syncSurround);
    bus.on('ui:sync-vbass', syncBass);
    bus.on('ui:sync-exciter', syncTreble);

    bus.emit('audio:set-virtual-effects', {
      bass: false,
      treble: false,
      surround: false,
    });

    expect(getState('audio.virtualBass')).toBe(0);
    expect(getState('audio.exciter')).toBe(false);
    expect(getState('audio.stereoWidth')).toBe(1);
    expect(syncSurround).toHaveBeenCalledOnce();
    expect(syncSurround).toHaveBeenCalledWith(false);
    expect(syncBass).toHaveBeenCalledOnce();
    expect(syncBass).toHaveBeenCalledWith(false);
    expect(syncTreble).toHaveBeenCalledOnce();
    expect(syncTreble).toHaveBeenCalledWith(false);

    const atomicFrames = send.mock.calls
      .map(([value]) => value)
      .filter((value) => value.type === MSG.SETTINGS_SYNC_SNAPSHOT);
    expect(atomicFrames).toHaveLength(1);
    expect(atomicFrames[0]).toMatchObject({
      settings: {
        effects: {
          virtualBass: { strengthPercent: 0 },
          virtualTreble: { enabled: false },
          virtualSurround: { widthPercent: 100 },
        },
      },
    });
  });

  it('lets sequence zero bootstrap a fresh follower and applies volume plus every effect', async () => {
    const host = { peer: 'host', open: true, send: vi.fn() } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    resetSettingsSyncAuthorityForTests();

    await handleData(
      {
        type: MSG.SETTINGS_SYNC_SNAPSHOT,
        version: 1,
        epoch: 0,
        sequence: 0,
        settings: { masterVolume: 0.42, effects: synchronizedEffects },
      },
      host,
    );

    expect(getState('audio.masterVolume')).toBe(0.42);
    expect(captureRoomEffectsState()).toEqual(synchronizedEffects);
  });

  it('caches while OFF and safely reapplies the same canonical sequence after opt-in', async () => {
    const host = { peer: 'host', open: true, send: vi.fn() } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    setSettingsSyncEnabled(false);
    const frame = {
      type: MSG.SETTINGS_SYNC_SNAPSHOT,
      version: 1,
      epoch: 0,
      sequence: 3,
      settings: { masterVolume: 0.35, effects: synchronizedEffects },
    } as const;

    await handleData(frame, host);
    expect(getState('audio.masterVolume')).toBe(1);
    expect(getState('audio.virtualBass')).toBe(0);

    setSettingsSyncEnabled(true);
    expect(host.send).toHaveBeenCalledWith({
      type: MSG.REQUEST_SETTINGS_SYNC_SNAPSHOT,
      version: 1,
    });
    await handleData(frame, host);
    expect(getState('audio.masterVolume')).toBe(0.35);
    expect(getState('audio.virtualBass')).toBe(0.6);
  });

  it('keeps an OFF administrator local, then publishes one complete snapshot when ON', () => {
    const send = vi.fn();
    const host = { peer: 'host', open: true, send } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['effects.control']);
    setSettingsSyncEnabled(false);
    setState('audio.masterVolume', 0.28);
    applyRoomEffectsState(synchronizedEffects);

    expect(publishLocalSettingsAuthority()).toBe(false);
    expect(send).not.toHaveBeenCalled();

    const publishEvent = vi.fn();
    bus.on('settings-sync:publish-local', publishEvent);
    setSettingsSyncEnabled(true);
    expect(publishEvent).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT,
      version: 1,
      settings: { masterVolume: 0.28, effects: synchronizedEffects },
    });
  });

  it('retains one room-bound full publish across a closed host connection and bootstrap', async () => {
    const send = vi.fn();
    const host = { peer: 'host', open: false, send } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['effects.control']);
    resetSettingsSyncAuthorityForTests();
    setSettingsSyncEnabled(false);
    setState('audio.masterVolume', 0.28);
    applyRoomEffectsState(synchronizedEffects);

    setSettingsSyncEnabled(true);
    expect(send).not.toHaveBeenCalled();

    await handleData(
      {
        type: MSG.SETTINGS_SYNC_SNAPSHOT,
        version: 1,
        epoch: 0,
        sequence: 0,
        settings: {
          masterVolume: 0.75,
          effects: {
            ...synchronizedEffects,
            virtualBass: { strengthPercent: 10 },
          },
        },
      },
      host,
    );
    expect(getState('audio.masterVolume')).toBe(0.28);
    setState('audio.masterVolume', 0.31);
    expect(publishLocalSettingsAuthority()).toBe(false);

    setState('network.standardRoomCapabilities', null);
    setState('network.isOperator', false);
    (host as { open: boolean }).open = true;
    bus.emit('network:peer-connected', host);
    expect(send).not.toHaveBeenCalled();
    setState('network.isOperator', true);
    expect(send).not.toHaveBeenCalled();
    setState('network.standardRoomCapabilities', ['effects.control']);
    bus.emit('network:peer-connected', host);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT,
      version: 1,
      settings: { masterVolume: 0.31, effects: synchronizedEffects },
    });
  });

  it('retains the latest takeover until the application connection boundary', () => {
    const send = vi.fn();
    const host = { peer: 'host', open: false, send } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.isConnecting', true);
    setState('network.hostConn', host);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['effects.control']);
    setSettingsSyncEnabled(false);
    setState('audio.masterVolume', 0.28);
    applyRoomEffectsState(synchronizedEffects);
    setSettingsSyncEnabled(true);

    // RTC open can precede peer-connected and the host's definitive grant or
    // revoke projection. The explicit edit in this window must replace, not
    // trail, the retained 0.28 takeover, without crossing the join handshake.
    (host as { open: boolean }).open = true;
    setState('audio.masterVolume', 0.44);
    expect(publishLocalSettingsAuthority()).toBe(false);
    expect(send).not.toHaveBeenCalled();

    setState('network.isConnecting', false);
    bus.emit('network:peer-connected', host);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT,
      version: 1,
      settings: { masterVolume: 0.44, effects: synchronizedEffects },
    });
  });

  it('holds a follower request across a replacement connection until its exact peer boundary', () => {
    const oldSend = vi.fn();
    const oldHost = {
      peer: 'host-replacement',
      open: false,
      send: oldSend,
    } as unknown as DataConnection;
    const newSend = vi.fn();
    const newHost = {
      peer: 'host-replacement',
      open: true,
      send: newSend,
    } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', oldHost);
    setState('network.isOperator', false);
    setState('network.standardRoomCapabilities', null);
    setSettingsSyncEnabled(false);

    setSettingsSyncEnabled(true);
    expect(oldSend).not.toHaveBeenCalled();

    setState('network.isConnecting', true);
    setState('network.hostConn', newHost);
    bus.emit('network:peer-connected', oldHost);
    expect(oldSend).not.toHaveBeenCalled();
    expect(newSend).not.toHaveBeenCalled();

    setState('network.isConnecting', false);
    bus.emit('network:peer-connected', newHost);
    bus.emit('network:peer-connected', newHost);

    expect(oldSend).not.toHaveBeenCalled();
    expect(newSend).toHaveBeenCalledOnce();
    expect(newSend).toHaveBeenCalledWith({
      type: MSG.REQUEST_SETTINGS_SYNC_SNAPSHOT,
      version: 1,
    });
  });

  it('holds the latest administrator publish across replacement bootstrap until peer-connected', () => {
    const oldSend = vi.fn();
    const oldHost = {
      peer: 'host-replacement',
      open: false,
      send: oldSend,
    } as unknown as DataConnection;
    const newSend = vi.fn();
    const newHost = {
      peer: 'host-replacement',
      open: true,
      send: newSend,
    } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', oldHost);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['effects.control']);
    setSettingsSyncEnabled(false);
    setState('audio.masterVolume', 0.28);
    applyRoomEffectsState(synchronizedEffects);

    setSettingsSyncEnabled(true);
    expect(oldSend).not.toHaveBeenCalled();

    setState('network.isConnecting', true);
    setState('network.hostConn', newHost);
    setState('audio.masterVolume', 0.44);
    expect(publishLocalSettingsAuthority()).toBe(false);
    bus.emit('network:peer-connected', oldHost);
    expect(oldSend).not.toHaveBeenCalled();
    expect(newSend).not.toHaveBeenCalled();

    setState('network.isConnecting', false);
    bus.emit('network:peer-connected', newHost);
    bus.emit('network:peer-connected', newHost);

    expect(oldSend).not.toHaveBeenCalled();
    expect(newSend).toHaveBeenCalledOnce();
    expect(newSend).toHaveBeenCalledWith({
      type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT,
      version: 1,
      settings: { masterVolume: 0.44, effects: synchronizedEffects },
    });
  });

  it('retains the latest administrator publish when an open channel send throws', () => {
    const send = vi.fn<(value: unknown) => void>().mockImplementationOnce(() => {
      throw new Error('data channel closing');
    });
    const host = { peer: 'host', open: true, send } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['effects.control']);
    setState('audio.masterVolume', 0.46);
    applyRoomEffectsState(synchronizedEffects);

    expect(publishLocalSettingsAuthority()).toBe(false);
    expect(send).toHaveBeenCalledOnce();

    bus.emit('network:peer-connected', host);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({
      type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT,
      version: 1,
      settings: { masterVolume: 0.46, effects: synchronizedEffects },
    });
  });

  it('retains a follower canonical request when an open channel send throws', async () => {
    const send = vi.fn<(value: unknown) => void>().mockImplementationOnce(() => {
      throw new Error('data channel closing');
    });
    const host = { peer: 'host', open: true, send } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    setState('network.isOperator', false);
    setState('network.standardRoomCapabilities', null);
    setSettingsSyncEnabled(false);
    setState('audio.masterVolume', 0.19);

    expect(() => setSettingsSyncEnabled(true)).not.toThrow();
    expect(send).toHaveBeenCalledOnce();
    // The retained canonical baseline replaces divergent OFF-local state while
    // the re-request waits for the replacement data channel.
    expect(getState('audio.masterVolume')).toBe(1);

    bus.emit('network:peer-connected', host);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({
      type: MSG.REQUEST_SETTINGS_SYNC_SNAPSHOT,
      version: 1,
    });

    await handleData(
      {
        type: MSG.SETTINGS_SYNC_SNAPSHOT,
        version: 1,
        epoch: 0,
        sequence: 1,
        settings: { masterVolume: 0.63, effects: synchronizedEffects },
      },
      host,
    );
    expect(getState('audio.masterVolume')).toBe(0.63);
  });

  it('discards a disconnected pending publish on explicit revoke or room change', () => {
    const send = vi.fn();
    const host = { peer: 'host', open: false, send } as unknown as DataConnection;
    setState('room.context', { ...getState('room.context'), roomId: '123456' });
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['effects.control']);
    setSettingsSyncEnabled(false);
    setSettingsSyncEnabled(true);

    bus.emit('settings-sync:authority-revoked');
    (host as { open: boolean }).open = true;
    bus.emit('network:peer-connected', host);
    expect(send).not.toHaveBeenCalled();

    (host as { open: boolean }).open = false;
    setSettingsSyncEnabled(false);
    setSettingsSyncEnabled(true);
    setState('room.context', { ...getState('room.context'), roomId: '654321' });
    (host as { open: boolean }).open = true;
    bus.emit('network:peer-connected', host);
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves a bootstrap accepted before sessionStarted and resets it only on leave', async () => {
    const host = { peer: 'host', open: true, send: vi.fn() } as unknown as DataConnection;
    setState('setup.sessionStarted', false);
    resetSettingsSyncAuthorityForTests();
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    const bootstrap = {
      type: MSG.SETTINGS_SYNC_SNAPSHOT,
      version: 1,
      epoch: 0,
      sequence: 0,
      settings: { masterVolume: 0.42, effects: synchronizedEffects },
    } as const;
    await handleData(bootstrap, host);

    setState('setup.sessionStarted', true);
    await handleData(
      { ...bootstrap, settings: { ...bootstrap.settings, masterVolume: 0.9 } },
      host,
    );
    expect(getState('audio.masterVolume')).toBe(0.42);

    setState('setup.sessionStarted', false);
    setState('audio.masterVolume', 0.7);
    setState('setup.sessionStarted', true);
    await handleData(
      { ...bootstrap, settings: { ...bootstrap.settings, masterVolume: 0.9 } },
      host,
    );
    expect(getState('audio.masterVolume')).toBe(0.9);
  });

  it('never uses the standard P2P settings authority transport in a PRO room', async () => {
    const send = vi.fn();
    const peer = { peer: 'pro-peer', open: true, send } as unknown as DataConnection;
    setState('room.context', {
      ...getState('room.context'),
      kind: 'pro',
      roomId: '000001',
      role: 'coordinator',
      capabilities: ['effects.control'],
    });
    setState('network.appRole', 'host');
    setState('network.isOperator', true);
    setState('network.connectedPeers', [
      {
        ...makeConnectedPeer(peer.peer, true),
        conn: peer,
        roomCapabilities: ['effects.control'],
      },
    ]);
    setState('network.activeHostConnByPeerId', new Map([[peer.peer, peer]]));

    expect(publishLocalSettingsAuthority()).toBe(true);
    bus.emit('network:peer-connected', peer);
    await handleData(
      {
        type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT,
        version: 1,
        settings: { masterVolume: 0.2, effects: synchronizedEffects },
      },
      peer,
    );

    expect(send).not.toHaveBeenCalled();
    expect(getState('audio.masterVolume')).toBe(1);
    expect(captureRoomEffectsState()).not.toEqual(synchronizedEffects);
  });

  it('classifies subwoofer cutoff as a device-local effect', () => {
    expect(isDeviceLocalEffectType('cutoff')).toBe(true);
    expect(isDeviceLocalEffectType('reverb')).toBe(false);
  });

  it('lets an OFF host relay successive admins without applying their canonical state locally', async () => {
    const adminA = { peer: 'admin-a', open: true, send: vi.fn() } as unknown as DataConnection;
    const adminB = { peer: 'admin-b', open: true, send: vi.fn() } as unknown as DataConnection;
    const followerSend = vi.fn();
    const follower = {
      peer: 'follower',
      open: true,
      send: followerSend,
    } as unknown as DataConnection;
    const peers = [adminA, adminB, follower].map((conn) => ({
      ...makeConnectedPeer(conn.peer, conn !== follower),
      conn,
      roomCapabilities: conn === follower ? [] : ['effects.control' as const],
    }));
    setState('network.appRole', 'host');
    setState('network.connectedPeers', peers);
    setState('network.activeHostConnByPeerId', new Map(peers.map((peer) => [peer.id, peer.conn!])));
    setSettingsSyncEnabled(false);
    setState('audio.masterVolume', 0.91);

    await handleData(
      {
        type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT,
        version: 1,
        settings: { masterVolume: 0.2, effects: synchronizedEffects },
      },
      adminA,
    );
    const newerEffects = {
      ...synchronizedEffects,
      virtualBass: { strengthPercent: 25 },
    };
    await handleData(
      {
        type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT,
        version: 1,
        settings: { masterVolume: 0.7, effects: newerEffects },
      },
      adminB,
    );

    expect(getState('audio.masterVolume')).toBe(0.91);
    const atomicFrames = followerSend.mock.calls
      .map(([value]) => value)
      .filter((value) => value.type === MSG.SETTINGS_SYNC_SNAPSHOT);
    expect(atomicFrames).toHaveLength(2);
    expect(atomicFrames[0]).toMatchObject({ sequence: 1, settings: { masterVolume: 0.2 } });
    expect(atomicFrames[1]).toMatchObject({
      sequence: 2,
      settings: { masterVolume: 0.7, effects: newerEffects },
    });
  });

  it('never seeds a fresh OFF coordinator cache from its private local settings', () => {
    const send = vi.fn();
    const follower = { peer: 'follower', open: true, send } as unknown as DataConnection;
    setState('network.appRole', 'host');
    setSettingsSyncEnabled(false);
    resetSettingsSyncAuthorityForTests();
    setState('audio.masterVolume', 0.17);
    applyRoomEffectsState(synchronizedEffects);

    bus.emit('network:peer-connected', follower);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.SETTINGS_SYNC_SNAPSHOT,
        settings: {
          masterVolume: 1,
          effects: expect.objectContaining({
            equalizer: { bandsDb: [0, 0, 0, 0, 0] },
            virtualBass: { strengthPercent: 0 },
          }),
        },
      }),
    );
  });

  it('rejects stale, equal-sequence conflicting, malformed, and non-host snapshots', async () => {
    const host = { peer: 'host', open: true, send: vi.fn() } as unknown as DataConnection;
    const attacker = makeConnection('attacker');
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    const accepted = {
      type: MSG.SETTINGS_SYNC_SNAPSHOT,
      version: 1,
      epoch: 2,
      sequence: 5,
      settings: { masterVolume: 0.4, effects: synchronizedEffects },
    } as const;
    await handleData(accepted, host);

    await handleData(
      { ...accepted, sequence: 4, settings: { ...accepted.settings, masterVolume: 0.1 } },
      host,
    );
    await handleData({ ...accepted, settings: { ...accepted.settings, masterVolume: 0.8 } }, host);
    await handleData(
      { ...accepted, sequence: 6, settings: { ...accepted.settings, masterVolume: 2 } },
      host,
    );
    await handleData(
      { ...accepted, sequence: 7, settings: { ...accepted.settings, masterVolume: 0.9 } },
      attacker,
    );

    expect(captureRoomSettingsSyncState()).toEqual(accepted.settings);
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

  it('allows a standard administrator to reset synchronized room effects', async () => {
    const conn = makeConnection('guest-op');
    setState('network.appRole', 'host');
    setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
    setState('network.connectedPeers', [{ ...makeConnectedPeer(conn.peer, true), conn }]);
    setState('audio.eqValues', [1, 2, 3, 4, 5]);
    setState('audio.userPreampGain', 2);

    await handleData({ type: MSG.REQUEST_EQ_RESET }, conn);

    expect(getState('audio.eqValues')).toEqual([0, 0, 0, 0, 0]);
    expect(getState('audio.userPreampGain')).toBe(1);
  });
});
