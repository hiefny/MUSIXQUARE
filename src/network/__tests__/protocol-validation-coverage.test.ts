/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_GUEST_SLOTS, MSG } from '../../core/constants.ts';
import { resetState } from '../../core/state.ts';
import type { DataConnection } from '../../types/index.ts';
import { handleData, registerHandler } from '../protocol.ts';

function connection(peer: string): DataConnection {
  return { peer } as DataConnection;
}

beforeEach(() => {
  resetState();
});

describe('protocol validation coverage', () => {
  it('classifies every declared message type', () => {
    const types = Object.values(MSG);

    expect(types).toHaveLength(101);
    expect(new Set(types).size).toBe(types.length);
  });

  it('no longer declares the local R2 capability marker', () => {
    // Old-version removal train 2 (OV-F06): hosts route local guests by room
    // size alone since train 1, so guests stop advertising R2 support.
    expect(Object.values(MSG)).not.toContain('file-r2-capability');
  });

  it('no longer declares the guest SFU capability marker', () => {
    // Phase 5.5 train 3 (OV-F06): hosts from 9.0.16 treat every LAN guest as
    // SFU-capable without reading the marker (5B-OV2), and the 789 client
    // floor admits no older host, so guests stop sending it.
    expect(Object.values(MSG)).not.toContain('system-audio-sfu-capability');
  });

  it('no longer declares the coordinator-era PRO file preload hint', () => {
    // Since d4b208cc every PRO member warms the next canonical R2 object
    // itself, and PRO rooms have no browser data connection to carry a hint.
    expect(Object.values(MSG)).not.toContain('pro-file-preload');
  });

  it('no longer declares the per-effect sync from before atomic settings sync', () => {
    const removed = [
      'volume',
      'eq-update',
      'eq-reset',
      'preamp',
      'reverb',
      'reverb-type',
      'reverb-decay',
      'reverb-predelay',
      'reverb-lowcut',
      'reverb-highcut',
      'stereo-width',
      'vbass',
      'exciter',
      'request-eq-reset',
    ];

    expect(Object.values(MSG).filter((type) => removed.includes(type))).toEqual([]);
  });
});

describe('device-list-update validation', () => {
  it('accepts bounded host-authored projections through the 100-device boundary', async () => {
    const handler = vi.fn();
    registerHandler(MSG.DEVICE_LIST_UPDATE, handler);

    await handleData(
      {
        type: MSG.DEVICE_LIST_UPDATE,
        list: [
          {
            id: null,
            label: 'HOST',
            status: 'connected',
            isHost: true,
            isOp: true,
            joinOrder: 0,
            devicePlatform: 'windows',
          },
          {
            id: 'guest-1',
            label: 'Guest 1',
            status: 'connected',
            isHost: false,
            isOp: true,
            joinOrder: 1,
            connectionType: 'remote',
            devicePlatform: 'ios',
            memberId: `member_${'a'.repeat(22)}`,
            memberDisplayNumber: 1,
            isAuthenticated: true,
            capabilities: ['media.add', 'playback.control'],
          },
        ],
      },
      connection('device-list-valid'),
    );

    const fullList = [
      {
        id: null,
        label: 'HOST',
        status: 'connected',
        isHost: true,
        joinOrder: 0,
        devicePlatform: 'other',
      },
      ...Array.from({ length: MAX_GUEST_SLOTS }, (_, index) => ({
        id: `guest-${index + 1}`,
        label: `Guest ${index + 1}`,
        status: 'connected',
        isHost: false,
        joinOrder: index + 1,
        connectionType: 'local',
        devicePlatform: 'other',
        memberDisplayNumber: index + 2,
      })),
    ];
    await handleData(
      { type: MSG.DEVICE_LIST_UPDATE, list: fullList },
      connection('device-list-full'),
    );

    // PeerJS' BinaryPack/MessagePack serializers encode object properties
    // whose value is undefined as nil. Accept that null wire form as an absent
    // optional field so a hardened receiver remains compatible with current
    // and rolling hosts.
    await handleData(
      {
        type: MSG.DEVICE_LIST_UPDATE,
        list: [
          {
            id: 'host-1',
            label: 'HOST',
            status: 'connected',
            isHost: true,
            isOp: true,
            joinOrder: 0,
            connectionType: null,
            devicePlatform: 'macos',
            memberId: null,
            memberDisplayNumber: null,
            capabilities: null,
          },
          {
            id: 'guest-1',
            label: 'Guest 1',
            status: 'connected',
            isHost: false,
            isOp: false,
            joinOrder: 1,
            connectionType: 'local',
            devicePlatform: 'windows',
            memberId: null,
            memberDisplayNumber: null,
            isAuthenticated: false,
            capabilities: [],
          },
        ],
      },
      connection('device-list-peerjs-nil'),
    );

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('rejects empty, oversized, duplicate, hostless, and malformed projections', async () => {
    const handler = vi.fn();
    registerHandler(MSG.DEVICE_LIST_UPDATE, handler);
    const host = {
      id: 'host-1',
      label: 'HOST',
      status: 'connected',
      isHost: true,
      devicePlatform: 'windows',
    };
    const guest = {
      id: 'guest-1',
      label: 'Guest',
      status: 'connected',
      isHost: false,
      connectionType: 'local',
      devicePlatform: 'android',
    };
    const oversized: Array<Record<string, unknown>> = [host];
    for (let index = 0; index <= MAX_GUEST_SLOTS; index += 1) {
      oversized.push({ ...guest, id: `guest-${index}` });
    }

    const invalidLists = [
      [],
      oversized,
      [host, guest, { ...guest }],
      [guest],
      [host, { ...guest, capabilities: ['root.admin'] }],
      [host, { ...guest, label: 'x'.repeat(65) }],
    ];
    for (const [index, list] of invalidLists.entries()) {
      await handleData(
        { type: MSG.DEVICE_LIST_UPDATE, list },
        connection(`device-list-invalid-${index}`),
      );
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('requires the platform on every row and the route on every guest row', async () => {
    const handler = vi.fn();
    registerHandler(MSG.DEVICE_LIST_UPDATE, handler);
    // The host's own row never carries connectionType; every current host
    // sends devicePlatform on both kinds of row and connectionType on guests.
    const host = {
      id: 'host-1',
      label: 'HOST',
      status: 'connected',
      isHost: true,
      isOp: true,
      joinOrder: 0,
      devicePlatform: 'windows',
    };
    const guest = {
      id: 'guest-1',
      label: 'Guest',
      status: 'connected',
      isHost: false,
      isOp: false,
      joinOrder: 1,
      connectionType: 'local',
      devicePlatform: 'android',
    };
    const { devicePlatform: _hostPlatform, ...hostWithoutPlatform } = host;
    const { devicePlatform: _guestPlatform, ...guestWithoutPlatform } = guest;
    const { connectionType: _guestRoute, ...guestWithoutRoute } = guest;

    await handleData(
      { type: MSG.DEVICE_LIST_UPDATE, list: [host, guest] },
      connection('device-list-current'),
    );
    const invalidLists = [
      [hostWithoutPlatform, guest],
      [{ ...host, devicePlatform: null }, guest],
      [host, guestWithoutPlatform],
      [host, { ...guest, devicePlatform: null }],
      [host, guestWithoutRoute],
      [host, { ...guest, connectionType: null }],
    ];
    for (const [index, list] of invalidLists.entries()) {
      await handleData(
        { type: MSG.DEVICE_LIST_UPDATE, list },
        connection(`device-list-missing-${index}`),
      );
    }

    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('bounded control-frame validation', () => {
  it('requires the PAUSE reason every current sender includes', async () => {
    const handler = vi.fn();
    registerHandler(MSG.PAUSE, handler);
    const conn = connection('pause-reason-validation');
    const base = {
      type: MSG.PAUSE,
      time: 10,
      queueItemId: '00000000-0000-4000-8000-000000000001',
    };

    for (const reason of ['pause', 'stop', 'seek', 'transition']) {
      await handleData({ ...base, reason }, conn);
    }
    await handleData(
      { ...base, time: 0, queueItemId: null, endOfPlaylist: true, reason: 'end-of-playlist' },
      conn,
    );
    expect(handler).toHaveBeenCalledTimes(5);

    for (const frame of [
      base,
      { ...base, reason: null },
      { ...base, reason: 'resume' },
      { ...base, time: 0, queueItemId: null, endOfPlaylist: true },
    ]) {
      await handleData(frame, conn);
    }
    expect(handler).toHaveBeenCalledTimes(5);
  });

  it('requires the shared demo start and ignores any hostPlayAt', async () => {
    // Survey OV-B02 stage 1: every demo host since 8.6.54 (#235) sends
    // hostStartAt. A 9.0.14 host still adds hostPlayAt; since old-version
    // removal train 2 (OV-F05) no host sends it and the validator no longer
    // reads it, so any value passes like other unread keys. A frame without
    // hostStartAt is an older host's.
    const handler = vi.fn();
    registerHandler(MSG.DEMO_PLAY, handler);
    const conn = connection('demo-start-validation');
    const shared = { type: MSG.DEMO_PLAY, index: 1, time: 0, hostStartAt: 1200 };
    const previous = { ...shared, hostPlayAt: 1550 };
    await handleData(shared, conn);
    await handleData(previous, conn);
    await handleData({ type: MSG.DEMO_PLAY, index: 1, time: 0, hostPlayAt: 1550 }, conn);
    await handleData({ type: MSG.DEMO_PLAY, index: 1, time: 0 }, conn);
    for (const hostStartAt of [NaN, Infinity, -Infinity, -1, 0, '1200', null]) {
      await handleData({ ...shared, hostStartAt }, conn);
      await handleData({ ...previous, hostStartAt }, conn);
    }
    const unread = [NaN, Infinity, '1550', null].map((hostPlayAt) => ({ ...shared, hostPlayAt }));
    for (const frame of unread) await handleData(frame, conn);
    expect(handler.mock.calls.map(([frame]) => frame)).toEqual([shared, previous, ...unread]);
  });

  it('accepts legacy PLAY frames and independent common-start anchors', async () => {
    const handler = vi.fn();
    registerHandler(MSG.PLAY, handler);
    const conn = connection('play-start-validation');
    const base = {
      type: MSG.PLAY,
      time: 10,
      queueItemId: '00000000-0000-4000-8000-000000000001',
    };

    // No host has sent a PLAY hostPlayAt since train 1 (OV-B01). Since
    // old-version removal train 2 the validator no longer reads it, so any
    // value passes like other unread keys and the handler ignores it.
    const frames = [
      base,
      { ...base, hostPlayAt: 0 },
      { ...base, hostPlayAt: 1_200 },
      { ...base, hostPlayAt: Number.NaN },
      { ...base, hostPlayAt: '1200' },
      { ...base, hostPlayAt: null },
      { ...base, hostStartAt: 1_000.5 },
      { ...base, hostStartAt: 1_000, hostPlayAt: 1_200 },
    ];
    for (const frame of frames) await handleData(frame, conn);

    expect(handler).toHaveBeenCalledTimes(frames.length);
    for (const [index, frame] of frames.entries()) {
      expect(handler.mock.calls[index]?.[0]).toEqual(frame);
    }
  });

  it('rejects invalid PLAY common-start anchors before dispatch', async () => {
    const handler = vi.fn();
    registerHandler(MSG.PLAY, handler);
    const conn = connection('play-start-invalid');
    const base = {
      type: MSG.PLAY,
      time: 10,
      queueItemId: '00000000-0000-4000-8000-000000000001',
      hostPlayAt: 1_200,
    };

    for (const hostStartAt of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      0,
      '1000',
      null,
    ]) {
      await handleData({ ...base, hostStartAt }, conn);
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts legacy and scheduled file sync pongs but rejects invalid start anchors', async () => {
    const handler = vi.fn();
    registerHandler(MSG.SYNC_PONG, handler);
    const conn = connection('sync-pong-start-validation');
    const base = {
      type: MSG.SYNC_PONG,
      pingId: 1,
      hostTime: 1_000,
      position: 10,
      mode: 'file',
      activity: 'playing',
      queueItemId: '00000000-0000-4000-8000-000000000001',
    };
    const scheduled = { ...base, hostStartAt: 1_200.5 };

    await handleData(base, conn);
    await handleData(scheduled, conn);
    for (const hostStartAt of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      0,
      '1200',
      null,
    ]) {
      await handleData({ ...base, hostStartAt }, conn);
    }

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]?.[0]).toEqual(base);
    expect(handler.mock.calls[1]?.[0]).toEqual(scheduled);
  });

  it('validates a sync ping by its id alone and ignores a guestTime the host never reads', async () => {
    const handler = vi.fn();
    registerHandler(MSG.SYNC_PING, handler);
    const conn = connection('sync-ping-validation');

    await handleData({ type: MSG.SYNC_PING, pingId: 0 }, conn);
    // A 9.0.14 guest's resume challenge still carries guestTime (old-version
    // removal train 2, survey OV-A12): ignored like any other unread key.
    await handleData({ type: MSG.SYNC_PING, pingId: 1, guestTime: 123.5 }, conn);
    await handleData({ type: MSG.SYNC_PING, pingId: 2, guestTime: -1 }, conn);
    await handleData({ type: MSG.SYNC_PING, pingId: 3, guestTime: 'stale' }, conn);
    for (const frame of [
      { type: MSG.SYNC_PING, pingId: -1 },
      { type: MSG.SYNC_PING, pingId: 1.5 },
      { type: MSG.SYNC_PING, pingId: Number.MAX_SAFE_INTEGER + 1 },
      { type: MSG.SYNC_PING },
    ]) {
      await handleData(frame, conn);
    }

    expect(handler.mock.calls.map(([frame]) => (frame as { pingId: number }).pingId)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it('bounds chat moderation targets, slowmode, and filter values', async () => {
    const mute = vi.fn();
    const unmute = vi.fn();
    const slowmode = vi.fn();
    const filter = vi.fn();
    registerHandler(MSG.CHAT_MUTE, mute);
    registerHandler(MSG.CHAT_UNMUTE, unmute);
    registerHandler(MSG.CHAT_SLOWMODE, slowmode);
    registerHandler(MSG.CHAT_FILTER, filter);
    const conn = connection('chat-control-validation');

    await handleData({ type: MSG.CHAT_MUTE, targetId: 'guest-1', targetLabel: 'Guest' }, conn);
    await handleData({ type: MSG.CHAT_UNMUTE, targetId: 'guest-1', targetLabel: 'Guest' }, conn);
    await handleData({ type: MSG.CHAT_SLOWMODE, seconds: 0 }, conn);
    await handleData({ type: MSG.CHAT_SLOWMODE, seconds: 60 }, conn);
    await handleData({ type: MSG.CHAT_FILTER, on: true }, conn);
    await handleData({ type: MSG.CHAT_FILTER, on: false }, conn);

    await handleData({ type: MSG.CHAT_MUTE, targetId: '', targetLabel: 'Guest' }, conn);
    await handleData(
      { type: MSG.CHAT_UNMUTE, targetId: 'guest-1', targetLabel: 'x'.repeat(31) },
      conn,
    );
    for (const seconds of [-1, 1.5, 61]) {
      await handleData({ type: MSG.CHAT_SLOWMODE, seconds }, conn);
    }
    await handleData({ type: MSG.CHAT_FILTER, on: 1 }, conn);

    expect(mute).toHaveBeenCalledOnce();
    expect(unmute).toHaveBeenCalledOnce();
    expect(slowmode).toHaveBeenCalledTimes(2);
    expect(filter).toHaveBeenCalledTimes(2);
  });

  it('bounds direct queue-mode frames, including bootstrap markers', async () => {
    const cases: Array<{
      type: (typeof MSG)[keyof typeof MSG];
      valid: unknown;
      invalid: unknown;
    }> = [
      { type: MSG.REPEAT_MODE, valid: 2, invalid: 3 },
      { type: MSG.SHUFFLE_MODE, valid: true, invalid: 'true' },
    ];

    for (const { type, valid, invalid } of cases) {
      const handler = vi.fn();
      registerHandler(type, handler);
      const conn = connection(`effect-${type}`);

      await handleData({ type, value: valid }, conn);
      await handleData({ type, value: valid, _bootstrap: true }, conn);
      await handleData({ type, value: valid, _bootstrap: false }, conn);
      await handleData({ type, value: invalid }, conn);

      expect(handler, type).toHaveBeenCalledTimes(3);
    }
  });

  it('reads session-full and operator notices by their translation key alone', async () => {
    // Guests read only i18nKey. The hosts' fallback `message` and `text`
    // (sent up to 9.0.21) are unread keys with no bound of their own, and an
    // operator notice needs its key.
    const sessionFull = vi.fn();
    const operatorToast = vi.fn();
    registerHandler(MSG.SESSION_FULL, sessionFull);
    registerHandler(MSG.OPERATOR_TOAST, operatorToast);
    const conn = connection('notice-fallback-validation');
    const sessionFrames = [
      { type: MSG.SESSION_FULL, message: 'Room is full', i18nKey: 'network.session_full_detail' },
      { type: MSG.SESSION_FULL, i18nKey: 'network.session_full_detail' },
      { type: MSG.SESSION_FULL },
      { type: MSG.SESSION_FULL, message: '' },
      { type: MSG.SESSION_FULL, message: 'x'.repeat(513) },
      { type: MSG.SESSION_FULL, message: 5 },
    ];
    const toastFrames = [
      { type: MSG.OPERATOR_TOAST, text: 'notice', i18nKey: 'toast.remote_decode_device_wait' },
      { type: MSG.OPERATOR_TOAST, i18nKey: 'toast.remote_decode_device_wait' },
      { type: MSG.OPERATOR_TOAST, text: 5, i18nKey: 'toast.remote_decode_device_wait' },
    ];
    for (const frame of [...sessionFrames, ...toastFrames]) await handleData(frame, conn);

    for (const invalid of [
      { type: MSG.SESSION_FULL, i18nKey: 'x'.repeat(128) },
      { type: MSG.OPERATOR_TOAST },
      { type: MSG.OPERATOR_TOAST, text: 'notice' },
      { type: MSG.OPERATOR_TOAST, i18nParams: { name: 'a' } },
      { type: MSG.OPERATOR_TOAST, text: 'x'.repeat(301) },
      { type: MSG.OPERATOR_TOAST, i18nKey: 'x'.repeat(128) },
      { type: MSG.OPERATOR_TOAST, i18nKey: 'toast.remote_decode_device_wait', i18nParams: null },
    ]) {
      await handleData(invalid, conn);
    }

    expect(sessionFull.mock.calls.map(([frame]) => frame)).toEqual(sessionFrames);
    expect(operatorToast.mock.calls.map(([frame]) => frame)).toEqual(toastFrames);
  });

  it('bounds session, kick, and operator projections', async () => {
    const sessionFull = vi.fn();
    const kick = vi.fn();
    const grant = vi.fn();
    const revoke = vi.fn();
    registerHandler(MSG.SESSION_FULL, sessionFull);
    registerHandler(MSG.KICK_DEVICE, kick);
    registerHandler(MSG.OPERATOR_GRANT, grant);
    registerHandler(MSG.OPERATOR_REVOKE, revoke);
    const conn = connection('authority-frame-validation');

    await handleData(
      { type: MSG.SESSION_FULL, message: 'Room is full', i18nKey: 'network.session_full' },
      conn,
    );
    await handleData({ type: MSG.KICK_DEVICE }, conn);
    await handleData(
      { type: MSG.OPERATOR_GRANT, capabilities: ['media.add', 'room.configure'], silent: true },
      conn,
    );
    await handleData({ type: MSG.OPERATOR_GRANT, capabilities: [] }, conn);
    await handleData({ type: MSG.OPERATOR_REVOKE, silent: false }, conn);

    await handleData({ type: MSG.SESSION_FULL, i18nKey: 'x'.repeat(128) }, conn);
    await handleData({ type: MSG.KICK_DEVICE, reason: 'x'.repeat(257) }, conn);
    await handleData({ type: MSG.OPERATOR_GRANT, capabilities: ['root.admin'] }, conn);
    await handleData({ type: MSG.OPERATOR_GRANT, capabilities: ['media.add', 'media.add'] }, conn);
    // Every current host sends the explicit grant list, empty or not.
    await handleData({ type: MSG.OPERATOR_GRANT }, conn);
    await handleData({ type: MSG.OPERATOR_GRANT, silent: true }, conn);
    await handleData({ type: MSG.OPERATOR_GRANT, capabilities: null }, conn);
    await handleData({ type: MSG.OPERATOR_REVOKE, silent: 'yes' }, conn);

    expect(sessionFull).toHaveBeenCalledOnce();
    expect(kick).toHaveBeenCalledOnce();
    expect(grant).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledOnce();
  });
});
