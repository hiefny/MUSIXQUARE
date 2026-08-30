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

    expect(types).toHaveLength(115);
    expect(new Set(types).size).toBe(types.length);
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
      { id: null, label: 'HOST', status: 'connected', isHost: true, joinOrder: 0 },
      ...Array.from({ length: MAX_GUEST_SLOTS }, (_, index) => ({
        id: `guest-${index + 1}`,
        label: `Guest ${index + 1}`,
        status: 'connected',
        isHost: false,
        joinOrder: index + 1,
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
    const host = { id: 'host-1', label: 'HOST', status: 'connected', isHost: true };
    const guest = { id: 'guest-1', label: 'Guest', status: 'connected', isHost: false };
    const oversized = [host];
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
});

describe('bounded control-frame validation', () => {
  it('accepts legacy and current sync pings but rejects unsafe clocks and ids', async () => {
    const handler = vi.fn();
    registerHandler(MSG.SYNC_PING, handler);
    const conn = connection('sync-ping-validation');

    await handleData({ type: MSG.SYNC_PING, pingId: 0 }, conn);
    await handleData({ type: MSG.SYNC_PING, pingId: 1, guestTime: 123.5 }, conn);
    for (const frame of [
      { type: MSG.SYNC_PING, pingId: -1 },
      { type: MSG.SYNC_PING, pingId: 1.5 },
      { type: MSG.SYNC_PING, pingId: Number.MAX_SAFE_INTEGER + 1 },
      { type: MSG.SYNC_PING, pingId: 2, guestTime: -1 },
      { type: MSG.SYNC_PING, pingId: 2, guestTime: Number.POSITIVE_INFINITY },
    ]) {
      await handleData(frame, conn);
    }

    expect(handler).toHaveBeenCalledTimes(2);
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

  it('bounds direct playback and effect frames, including bootstrap markers', async () => {
    const cases: Array<{
      type: (typeof MSG)[keyof typeof MSG];
      valid: unknown;
      invalid: unknown;
    }> = [
      { type: MSG.REPEAT_MODE, valid: 2, invalid: 3 },
      { type: MSG.SHUFFLE_MODE, valid: true, invalid: 'true' },
      { type: MSG.PREAMP, valid: -48, invalid: -49 },
      { type: MSG.VBASS, valid: 100, invalid: 101 },
      { type: MSG.REVERB, valid: 0, invalid: -1 },
      { type: MSG.EXCITER, valid: 1, invalid: 2 },
      { type: MSG.STEREO_WIDTH, valid: 200, invalid: 201 },
      { type: MSG.REVERB_TYPE, valid: 'studio', invalid: 'hall' },
      { type: MSG.REVERB_DECAY, valid: 30, invalid: 30.1 },
      { type: MSG.REVERB_PREDELAY, valid: 1, invalid: 1.01 },
      { type: MSG.REVERB_LOWCUT, valid: 100, invalid: Number.NaN },
      { type: MSG.REVERB_HIGHCUT, valid: 0, invalid: -1 },
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

    const volume = vi.fn();
    const equalizer = vi.fn();
    registerHandler(MSG.VOLUME, volume);
    registerHandler(MSG.EQ_UPDATE, equalizer);
    const conn = connection('volume-eq-validation');

    await handleData({ type: MSG.VOLUME, value: 0.5 }, conn);
    await handleData({ type: MSG.VOLUME, value: 1, _bootstrap: true }, conn);
    await handleData({ type: MSG.VOLUME, value: 0.5, _bootstrap: false }, conn);
    await handleData({ type: MSG.VOLUME, value: 1.01 }, conn);
    await handleData({ type: MSG.EQ_UPDATE, band: 0, value: 0 }, conn);
    await handleData({ type: MSG.EQ_UPDATE, band: 4, value: -12, _bootstrap: true }, conn);
    await handleData({ type: MSG.EQ_UPDATE, band: 0, value: 12, _bootstrap: false }, conn);
    await handleData({ type: MSG.EQ_UPDATE, band: 5, value: 0 }, conn);
    await handleData({ type: MSG.EQ_UPDATE, band: 0, value: 12.1 }, conn);

    expect(volume).toHaveBeenCalledTimes(3);
    expect(equalizer).toHaveBeenCalledTimes(3);
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
    await handleData({ type: MSG.OPERATOR_REVOKE, silent: false }, conn);

    await handleData({ type: MSG.SESSION_FULL, message: '' }, conn);
    await handleData({ type: MSG.KICK_DEVICE, reason: 'x'.repeat(257) }, conn);
    await handleData({ type: MSG.OPERATOR_GRANT, capabilities: ['root.admin'] }, conn);
    await handleData({ type: MSG.OPERATOR_GRANT, capabilities: ['media.add', 'media.add'] }, conn);
    await handleData({ type: MSG.OPERATOR_REVOKE, silent: 'yes' }, conn);

    expect(sessionFull).toHaveBeenCalledOnce();
    expect(kick).toHaveBeenCalledOnce();
    expect(grant).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
  });
});
