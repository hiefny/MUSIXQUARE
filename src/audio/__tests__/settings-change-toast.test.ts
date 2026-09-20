/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { t } from '../../i18n/index.ts';
import { handleData, registerHandler, resetInboundRateLimit } from '../../network/protocol.ts';
import type { ConnectedPeer, DataConnection, RoomSettingsSyncState } from '../../types/index.ts';
import { showToast } from '../../ui/toast.ts';
import {
  captureRoomSettingsSyncState,
  initEffectsHandlers,
  publishLocalSettingsAuthorityForTests as publishLocalSettingsAuthority,
  resetSettingsSyncAuthorityForTests,
  setEQPreset,
  setSettingsSyncEnabled,
} from '../effects.ts';

vi.mock('../../ui/toast.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ui/toast.ts')>()),
  showToast: vi.fn(),
}));

function connection(peer: string) {
  resetInboundRateLimit(peer);
  const send = vi.fn();
  const conn = { peer, open: true, send } as unknown as DataConnection;
  return { conn, send };
}

function connectedPeer(conn: DataConnection, administrator = false): ConnectedPeer {
  return {
    id: conn.peer,
    label: conn.peer,
    slot: 0,
    conn,
    isOp: administrator,
    roomCapabilities: administrator ? ['effects.control'] : [],
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 0,
    connectionType: 'unknown',
    lastHeartbeat: 0,
  };
}

function configureRoom(host?: DataConnection, administrator = false): void {
  setState('network.appRole', host ? 'guest' : 'host');
  setState('network.myId', host ? 'local-guest' : 'local-host');
  setState('network.hostConn', host ?? null);
  setState('network.isOperator', administrator);
  setState('network.standardRoomCapabilities', administrator ? ['effects.control'] : []);
  setState('room.context', {
    ...getState('room.context'),
    kind: 'standard',
    roomId: '123456',
    role: host ? 'member' : 'coordinator',
    epoch: 3,
  });
  setState('setup.sessionStarted', true);
}

function settings(masterVolume = 1): RoomSettingsSyncState {
  return { ...captureRoomSettingsSyncState(), masterVolume };
}

function snapshot(sequence: number, value = settings(), bootstrap = false) {
  return {
    type: MSG.SETTINGS_SYNC_SNAPSHOT,
    version: 1,
    epoch: 3,
    sequence,
    settings: value,
    ...(bootstrap ? { _bootstrap: true as const } : {}),
  };
}

async function establishFollower(administrator = false) {
  const host = connection('host');
  configureRoom(host.conn, administrator);
  await handleData(snapshot(0, settings(), true), host.conn);
  return host;
}

function expectOneChangeToast(): void {
  expect(showToast).toHaveBeenCalledExactlyOnceWith(t('toast.host_changed_setting'));
}

beforeEach(() => {
  vi.useFakeTimers();
  clearAllManagedTimers();
  localStorage.clear();
  bus.clear();
  resetState();
  resetSettingsSyncAuthorityForTests();
  vi.mocked(showToast).mockClear();
  initEffectsHandlers();
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('EQ preset synchronization through the inbound protocol budget', () => {
  const warm = [5, 3, 0, -2, -3];
  const bright = [0, -2, 0, 4, 6];

  it.each([true, false])(
    'delivers complete presets with bootstrap and concurrent controls (atomic receiver=%s)',
    async (atomicReceiver) => {
      const recipient = connection('recipient');
      configureRoom();
      setState('network.connectedPeers', [connectedPeer(recipient.conn)]);
      bus.emit('effects:resync-peer', recipient.conn);
      const bootstrap = recipient.send.mock.calls.map(([frame]) => frame);
      expect(bootstrap.filter((frame) => frame.type === MSG.EQ_UPDATE)).toHaveLength(5);
      recipient.send.mockClear();

      const batches = [warm, bright].map((bands) => {
        expect(setEQPreset(bands)).toBe(true);
        const frames = recipient.send.mock.calls.map(([frame]) => frame);
        recipient.send.mockClear();
        expect(frames.filter((frame) => frame.type === MSG.SETTINGS_SYNC_SNAPSHOT)).toHaveLength(1);
        return frames;
      });

      // Switch to a fresh follower, preserving actual coordinator emission
      // order. Fake time stays fixed: neither bootstrap nor competing control
      // traffic gets a token refill or a rate-limit exemption.
      resetState();
      resetSettingsSyncAuthorityForTests();
      const host = connection('budget-host');
      configureRoom(host.conn);
      const shuffle = vi.fn();
      registerHandler(MSG.SHUFFLE_MODE, shuffle);
      const deliver = async (frames: Record<string, unknown>[]) => {
        for (const frame of frames) {
          if (!atomicReceiver && frame.type === MSG.SETTINGS_SYNC_SNAPSHOT) continue;
          await handleData(frame, host.conn);
        }
      };
      await deliver(bootstrap);
      for (const [index, frames] of batches.entries()) {
        for (let control = 0; control < 5; control++) {
          await handleData({ type: MSG.SHUFFLE_MODE, value: control % 2 === 0 }, host.conn);
        }
        await deliver(frames);
        expect(getState('audio.eqValues')).toEqual(index % 2 === 0 ? warm : bright);
      }
      await handleData({ type: MSG.SHUFFLE_MODE, value: false }, host.conn);
      expect(shuffle).toHaveBeenCalledTimes(11);
    },
  );

  it('publishes one complete administrator preset, with no intermediate band states', () => {
    const host = connection('administrator-host');
    configureRoom(host.conn, true);
    const changes = vi.fn();
    bus.on('state:audio.eqValues', changes);

    expect(setEQPreset(warm)).toBe(true);
    expect(changes).toHaveBeenCalledExactlyOnceWith(warm, 'audio.eqValues');
    expect(host.send).toHaveBeenCalledExactlyOnceWith({
      type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT,
      version: 1,
      settings: settings(),
    });
    expect(getState('audio.eqValues')).toEqual(warm);
  });

  it('sends every legacy field to late joins, replacement channels and explicit resyncs', () => {
    const established = connection('established');
    configureRoom();
    setState('network.connectedPeers', [connectedPeer(established.conn)]);
    bus.emit('effects:resync-peer', established.conn);
    setEQPreset(warm);
    established.send.mockClear();

    const late = connection('late');
    setState('network.connectedPeers', [connectedPeer(established.conn), connectedPeer(late.conn)]);
    setEQPreset(bright);
    const lateFrames = late.send.mock.calls.map(([frame]) => frame);
    expect(lateFrames.filter((frame) => frame.type !== MSG.SETTINGS_SYNC_SNAPSHOT)).toHaveLength(
      14,
    );
    expect(lateFrames).toContainEqual({ type: MSG.EQ_UPDATE, band: 4, value: 6, _bootstrap: true });
    expect(established.send).toHaveBeenCalledTimes(15);

    // Same peer ID, different channel: no old delivery baseline may carry over.
    const replacement = connection('late');
    setState('network.connectedPeers', [connectedPeer(replacement.conn)]);
    setEQPreset(warm);
    expect(replacement.send).toHaveBeenCalledTimes(15);
    replacement.send.mockClear();
    bus.emit('effects:resync-peer', replacement.conn);
    expect(replacement.send).toHaveBeenCalledTimes(15);
    replacement.send.mockClear();
    setState('room.context', { ...getState('room.context'), epoch: 4 });
    setEQPreset(bright);
    expect(replacement.send).toHaveBeenCalledTimes(15);
  });

  it('repairs a failed legacy band on the next unrelated edit', () => {
    const follower = connection('legacy-send-failure');
    configureRoom();
    setState('network.connectedPeers', [connectedPeer(follower.conn)]);
    bus.emit('effects:resync-peer', follower.conn);
    follower.send.mockClear();
    let rejectFinalBand = true;
    follower.send.mockImplementation((frame: Record<string, unknown>) => {
      if (rejectFinalBand && frame.type === MSG.EQ_UPDATE && frame.band === 4) {
        rejectFinalBand = false;
        throw new DOMException('RTCDataChannel send buffer full', 'OperationError');
      }
    });
    setEQPreset(warm);
    follower.send.mockClear();
    setState('audio.masterVolume', 0.4);
    expect(publishLocalSettingsAuthority()).toBe(true);
    const repaired = follower.send.mock.calls.map(([frame]) => frame);
    expect(repaired).toHaveLength(15);
    expect(repaired).toContainEqual({ type: MSG.EQ_UPDATE, band: 4, value: -3, _bootstrap: true });
    expect(repaired).toContainEqual({ type: MSG.VOLUME, value: 0.4, _bootstrap: true });
  });

  it('rejects unauthorized or malformed presets before any partial mutation', () => {
    const host = connection('member-host');
    configureRoom(host.conn);
    const changes = vi.fn();
    bus.on('state:audio.eqValues', changes);

    expect(setEQPreset(warm)).toBe(false);
    setSettingsSyncEnabled(false);
    expect(setEQPreset([1, 2, 3, 4, Number.NaN])).toBe(false);
    expect(setEQPreset([1, 2, 3, 4])).toBe(false);
    expect(changes).not.toHaveBeenCalled();
    expect(getState('audio.eqValues')).toEqual([0, 0, 0, 0, 0]);
    expect(host.send).not.toHaveBeenCalled();

    expect(setEQPreset(warm)).toBe(true);
    expect(getState('audio.eqValues')).toEqual(warm);
    expect(host.send).not.toHaveBeenCalled();
  });

  it('exposes one complete PRO mutation for its checkpoint without standard-room messages', () => {
    const host = connection('pro-transport');
    configureRoom(host.conn);
    setState('room.context', {
      ...getState('room.context'),
      kind: 'pro',
      capabilities: ['effects.control'],
    });
    const changes = vi.fn();
    bus.on('state:audio.eqValues', changes);

    expect(setEQPreset(bright)).toBe(true);
    expect(changes).toHaveBeenCalledExactlyOnceWith(bright, 'audio.eqValues');
    expect(host.send).not.toHaveBeenCalled();
  });
});

describe('Standard room settings change notifications', () => {
  it('notifies a follower after a host volume change actually applies', async () => {
    const host = await establishFollower();
    await handleData(snapshot(1, settings(0.4)), host.conn);

    expect(getState('audio.masterVolume')).toBe(0.4);
    expect(showToast).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(301);
    expectOneChangeToast();
  });

  it('notifies for remote effects changes when volume stays the same', async () => {
    const host = await establishFollower();
    const value = settings();
    value.effects.equalizer.bandsDb = [0, -2, 0, 4, 6];
    value.effects.virtualBass.strengthPercent = 60;
    await handleData(snapshot(1, value), host.conn);
    await vi.advanceTimersByTimeAsync(301);

    expect(captureRoomSettingsSyncState()).toEqual(value);
    expectOneChangeToast();
  });

  it('keeps a host local action quiet and broadcasts a live snapshot to followers', async () => {
    const follower = connection('follower');
    configureRoom();
    setState('network.connectedPeers', [connectedPeer(follower.conn)]);
    setState('audio.masterVolume', 0.4);

    expect(publishLocalSettingsAuthority()).toBe(true);
    const atomic = follower.send.mock.calls
      .map(([frame]) => frame)
      .filter((frame) => frame.type === MSG.SETTINGS_SYNC_SNAPSHOT);
    expect(atomic).toHaveLength(1);
    expect(atomic[0]).toMatchObject({ settings: { masterVolume: 0.4 } });
    expect(atomic[0]._bootstrap).toBeUndefined();
    await vi.advanceTimersByTimeAsync(301);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('notifies the host and separates an administrator echo from other recipients', async () => {
    const actor = connection('administrator');
    const other = connection('other-administrator');
    configureRoom();
    setState('network.connectedPeers', [
      connectedPeer(actor.conn, true),
      connectedPeer(other.conn, true),
    ]);
    setState(
      'network.activeHostConnByPeerId',
      new Map([
        [actor.conn.peer, actor.conn],
        [other.conn.peer, other.conn],
      ]),
    );
    await handleData(
      { type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT, version: 1, settings: settings(0.4) },
      actor.conn,
    );
    await vi.advanceTimersByTimeAsync(301);

    expect(getState('audio.masterVolume')).toBe(0.4);
    expectOneChangeToast();
    const actorFrames = actor.send.mock.calls.map(([frame]) => frame);
    const otherFrames = other.send.mock.calls.map(([frame]) => frame);
    const actorAtomic = actorFrames.filter((frame) => frame.type === MSG.SETTINGS_SYNC_SNAPSHOT);
    const otherAtomic = otherFrames.filter((frame) => frame.type === MSG.SETTINGS_SYNC_SNAPSHOT);
    expect(actorAtomic).toHaveLength(1);
    expect(otherAtomic).toHaveLength(1);
    expect(actorAtomic[0]).toEqual({ ...otherAtomic[0], _bootstrap: true });
    expect(otherAtomic[0]._bootstrap).toBeUndefined();
    expect(
      actorFrames.filter((frame) => frame.type !== MSG.SETTINGS_SYNC_SNAPSHOT).length,
    ).toBeGreaterThan(0);
    expect(actorFrames.filter((frame) => frame.type !== MSG.SETTINGS_SYNC_SNAPSHOT)).toEqual(
      otherFrames.filter((frame) => frame.type !== MSG.SETTINGS_SYNC_SNAPSHOT),
    );
    expect(actorFrames.every((frame) => frame._bootstrap === true)).toBe(true);
  });

  it('keeps an earlier self echo quiet after the administrator has made a newer local edit', async () => {
    const host = await establishFollower(true);
    setState('audio.masterVolume', 0.4);
    expect(publishLocalSettingsAuthority()).toBe(true);
    setState('audio.masterVolume', 0.5);
    expect(publishLocalSettingsAuthority()).toBe(true);
    await handleData(snapshot(1, settings(0.4), true), host.conn);
    await vi.advanceTimersByTimeAsync(301);

    expect(getState('audio.masterVolume')).toBe(0.4);
    expect(showToast).not.toHaveBeenCalled();
    await handleData(snapshot(2, settings(0.5), true), host.conn);
    await vi.advanceTimersByTimeAsync(301);
    expect(getState('audio.masterVolume')).toBe(0.5);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('still notifies an administrator about a different administrator change after its own echo', async () => {
    const host = await establishFollower(true);
    setState('audio.masterVolume', 0.4);
    await handleData(snapshot(1, settings(0.4), true), host.conn);
    await handleData(snapshot(2, settings(0.7)), host.conn);
    await vi.advanceTimersByTimeAsync(301);

    expect(getState('audio.masterVolume')).toBe(0.7);
    expectOneChangeToast();
  });

  it.each([true, false])(
    'keeps the first received baseline quiet (_bootstrap=%s)',
    async (bootstrap) => {
      const host = connection('fresh-host');
      configureRoom(host.conn);
      await handleData(snapshot(4, settings(0.4), bootstrap), host.conn);
      await vi.advanceTimersByTimeAsync(301);

      expect(getState('audio.masterVolume')).toBe(0.4);
      expect(showToast).not.toHaveBeenCalled();
    },
  );

  it('keeps no-op, stale, equal-sequence and conflicting snapshots quiet', async () => {
    const host = await establishFollower();
    const unchanged = settings();
    await handleData(snapshot(1, unchanged), host.conn);
    await handleData(snapshot(1, unchanged), host.conn);
    await handleData(snapshot(0, settings(0.3)), host.conn);
    await handleData(snapshot(1, settings(0.2)), host.conn);
    await vi.advanceTimersByTimeAsync(301);

    expect(getState('audio.masterVolume')).toBe(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not repeat a toast for an equal-sequence replay even if local audio diverged', async () => {
    const host = await establishFollower(true);
    const frame = snapshot(1, settings(0.4));
    await handleData(frame, host.conn);
    await vi.advanceTimersByTimeAsync(301);
    expectOneChangeToast();
    vi.mocked(showToast).mockClear();
    setState('audio.masterVolume', 0.5);
    await handleData(frame, host.conn);
    await vi.advanceTimersByTimeAsync(301);

    expect(getState('audio.masterVolume')).toBe(0.4);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not apply or notify while OFF, and quietly restores the opt-in baseline', async () => {
    const host = await establishFollower();
    setSettingsSyncEnabled(false);
    await handleData(snapshot(1, settings(0.4)), host.conn);
    expect(getState('audio.masterVolume')).toBe(1);
    await vi.advanceTimersByTimeAsync(301);
    expect(showToast).not.toHaveBeenCalled();

    setSettingsSyncEnabled(true);
    await handleData(snapshot(1, settings(0.4), true), host.conn);
    await vi.advanceTimersByTimeAsync(301);
    expect(getState('audio.masterVolume')).toBe(0.4);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('keeps an OFF coordinator quiet while it forwards an administrator change', async () => {
    const actor = connection('administrator');
    configureRoom();
    setState('network.connectedPeers', [connectedPeer(actor.conn, true)]);
    setState('network.activeHostConnByPeerId', new Map([[actor.conn.peer, actor.conn]]));
    setSettingsSyncEnabled(false);
    await handleData(
      { type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT, version: 1, settings: settings(0.4) },
      actor.conn,
    );
    await vi.advanceTimersByTimeAsync(301);

    expect(getState('audio.masterVolume')).toBe(1);
    expect(actor.send).toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('debounces a burst of actual remote changes into one notification', async () => {
    const host = await establishFollower();
    await handleData(snapshot(1, settings(0.4)), host.conn);
    await vi.advanceTimersByTimeAsync(200);
    await handleData(snapshot(2, settings(0.5)), host.conn);
    await vi.advanceTimersByTimeAsync(200);
    expect(showToast).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(101);
    expectOneChangeToast();
  });

  it('cancels a pending notification across OFF then ON', async () => {
    const host = await establishFollower();
    await handleData(snapshot(1, settings(0.4)), host.conn);
    await vi.advanceTimersByTimeAsync(100);
    setSettingsSyncEnabled(false);
    setSettingsSyncEnabled(true);
    await handleData(snapshot(1, settings(0.4), true), host.conn);
    await vi.advanceTimersByTimeAsync(301);

    expect(showToast).not.toHaveBeenCalled();
  });

  it('cancels a pending notification when leaving and rejoining the same room', async () => {
    const host = await establishFollower();
    await handleData(snapshot(1, settings(0.4)), host.conn);
    await vi.advanceTimersByTimeAsync(100);
    setState('setup.sessionStarted', false);
    setState('setup.sessionStarted', true);
    await handleData(snapshot(0, settings(0.6), true), host.conn);
    await vi.advanceTimersByTimeAsync(301);

    expect(getState('audio.masterVolume')).toBe(0.6);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('cancels a pending notification across a host connection replacement', async () => {
    const host = await establishFollower();
    await handleData(snapshot(1, settings(0.4)), host.conn);
    await vi.advanceTimersByTimeAsync(100);
    setState('network.hostConn', null);
    const replacement = connection('host');
    setState('network.hostConn', replacement.conn);
    await handleData(snapshot(2, settings(0.6), true), replacement.conn);
    await vi.advanceTimersByTimeAsync(301);

    expect(getState('audio.masterVolume')).toBe(0.6);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('cancels a pending notification when the room changes without an intermediate teardown', async () => {
    const host = await establishFollower();
    await handleData(snapshot(1, settings(0.4)), host.conn);
    await vi.advanceTimersByTimeAsync(100);
    setState('room.context', { ...getState('room.context'), roomId: '654321' });
    await handleData(snapshot(0, settings(0.6), true), host.conn);
    await vi.advanceTimersByTimeAsync(301);

    expect(getState('audio.masterVolume')).toBe(0.6);
    expect(showToast).not.toHaveBeenCalled();
  });
});
