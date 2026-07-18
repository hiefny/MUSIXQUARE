import { describe, expect, it } from 'vitest';
import {
  parseDeveloperCommandFrame,
  parseDeveloperInvalidationFrame,
  parseProQueueAdditionFrame,
  type DeveloperCommandFrame,
  type DeveloperInvalidationFrame,
  type ProQueueAdditionFrame,
} from '../types.ts';

const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111';

function validFrame(): DeveloperCommandFrame {
  return {
    type: 'developer-command',
    version: 1,
    roomCode: '000001',
    coordinatorEpoch: 3,
    commandId: 'cmd_1234567890123456789012',
    expiresAtMs: 1_900_000_000_000,
    expected: {
      queueItemId: QUEUE_ITEM_ID,
      playlistRevision: 4,
      playbackRevision: 9,
    },
    command: { type: 'seek', positionSeconds: 12.5 },
  };
}

describe('developer signaling command parser', () => {
  it.each([
    { type: 'play' } as const,
    { type: 'pause' } as const,
    { type: 'seek', positionSeconds: 0 } as const,
    { type: 'seek', positionSeconds: 604_800 } as const,
    { type: 'play_item', queueItemId: QUEUE_ITEM_ID } as const,
  ])('accepts the exact $type command shape', (command) => {
    const frame = { ...validFrame(), command };
    expect(parseDeveloperCommandFrame(frame)).toEqual(frame);
  });

  it('accepts a null expected queue item for an idle-room fence', () => {
    const original = validFrame();
    const frame = { ...original, expected: { ...original.expected, queueItemId: null } };
    expect(parseDeveloperCommandFrame(frame)).toEqual(frame);
  });

  it('accepts set_effects only on the v2 command contract', () => {
    const frame = {
      ...validFrame(),
      version: 2 as const,
      command: { type: 'set_effects' as const, effects: { virtualBass: { strengthPercent: 60 } } },
    };
    expect(parseDeveloperCommandFrame(frame)).toEqual(frame);
    expect(parseDeveloperCommandFrame({ ...frame, version: 1 })).toBeNull();
  });

  it('accepts next only on the v3 command contract', () => {
    const frame = {
      ...validFrame(),
      version: 3 as const,
      command: { type: 'next' as const },
    };
    expect(parseDeveloperCommandFrame(frame)).toEqual(frame);
    expect(parseDeveloperCommandFrame({ ...frame, version: 1 })).toBeNull();
    expect(parseDeveloperCommandFrame({ ...frame, version: 2 })).toBeNull();
    expect(parseDeveloperCommandFrame({ ...validFrame(), version: 3 })).toBeNull();
  });

  it.each([
    ['root extra key', () => ({ ...validFrame(), extra: true })],
    ['wrong version', () => ({ ...validFrame(), version: 4 })],
    ['standard room code', () => ({ ...validFrame(), roomCode: '100001' })],
    ['zero epoch', () => ({ ...validFrame(), coordinatorEpoch: 0 })],
    ['short command id', () => ({ ...validFrame(), commandId: 'short' })],
    ['non-integer expiry', () => ({ ...validFrame(), expiresAtMs: 1.5 })],
    [
      'expected extra key',
      () => ({ ...validFrame(), expected: { ...validFrame().expected, extra: true } }),
    ],
    [
      'invalid expected queue id',
      () => ({ ...validFrame(), expected: { ...validFrame().expected, queueItemId: 'track-1' } }),
    ],
    [
      'negative revision',
      () => ({ ...validFrame(), expected: { ...validFrame().expected, playbackRevision: -1 } }),
    ],
    ['play extra key', () => ({ ...validFrame(), command: { type: 'play', force: true } })],
    [
      'non-finite seek',
      () => ({ ...validFrame(), command: { type: 'seek', positionSeconds: NaN } }),
    ],
    ['negative seek', () => ({ ...validFrame(), command: { type: 'seek', positionSeconds: -1 } })],
    [
      'overlong seek',
      () => ({ ...validFrame(), command: { type: 'seek', positionSeconds: 604_801 } }),
    ],
    [
      'invalid play-item queue id',
      () => ({ ...validFrame(), command: { type: 'play_item', queueItemId: 'track-1' } }),
    ],
    [
      'next extra key',
      () => ({ ...validFrame(), version: 3, command: { type: 'next', extra: true } }),
    ],
    ['unknown command', () => ({ ...validFrame(), command: { type: 'stop' } })],
  ])('rejects %s', (_label, mutate) => {
    expect(parseDeveloperCommandFrame(mutate())).toBeNull();
  });
});

describe('developer signaling invalidation parser', () => {
  const valid = (): DeveloperInvalidationFrame => ({
    type: 'developer-invalidation',
    version: 1,
    roomCode: '000001',
    coordinatorEpoch: 3,
    revision: 12,
    playlistRevision: 7,
  });

  it('accepts only the bounded immutable revision hint', () => {
    expect(parseDeveloperInvalidationFrame(valid())).toEqual(valid());
  });

  it.each([
    ['extra key', { ...valid(), extra: true }],
    ['wrong type', { ...valid(), type: 'pro-room-invalidated' }],
    ['wrong version', { ...valid(), version: 2 }],
    ['standard room', { ...valid(), roomCode: '100001' }],
    ['zero epoch', { ...valid(), coordinatorEpoch: 0 }],
    ['negative revision', { ...valid(), revision: -1 }],
    ['fractional playlist revision', { ...valid(), playlistRevision: 1.5 }],
    ['unsafe revision', { ...valid(), revision: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects %s', (_label, frame) => {
    expect(parseDeveloperInvalidationFrame(frame)).toBeNull();
  });
});

describe('PRO queue-addition parser', () => {
  const valid = (): ProQueueAdditionFrame => ({
    type: 'pro-queue-addition',
    version: 1,
    roomCode: '000001',
    coordinatorEpoch: 3,
    playlistRevision: 8,
    eventId: 'qa_000001_8_14',
    actorName: 'Studio bot',
    count: 42,
  });

  it('accepts the exact bounded server event', () => {
    expect(parseProQueueAdditionFrame(valid())).toEqual(valid());
  });

  it.each([
    ['extra key', { ...valid(), extra: true }],
    ['wrong room', { ...valid(), roomCode: '100001' }],
    ['zero epoch', { ...valid(), coordinatorEpoch: 0 }],
    ['invalid event id', { ...valid(), eventId: 'event-1' }],
    ['empty actor', { ...valid(), actorName: '' }],
    ['overlong actor', { ...valid(), actorName: 'x'.repeat(31) }],
    ['zero count', { ...valid(), count: 0 }],
    ['fractional count', { ...valid(), count: 1.5 }],
    ['over-limit count', { ...valid(), count: 1001 }],
  ])('rejects %s', (_label, frame) => {
    expect(parseProQueueAdditionFrame(frame)).toBeNull();
  });
});
