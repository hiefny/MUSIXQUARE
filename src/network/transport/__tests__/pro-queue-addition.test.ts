import { describe, expect, it } from 'vitest';
import { parseProQueueAdditionFrame, type ProQueueAdditionFrame } from '../types.ts';

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
    expect(parseProQueueAdditionFrame({ ...valid(), firstTitle: 'Gangnam Style' })).toEqual({
      ...valid(),
      firstTitle: 'Gangnam Style',
    });
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
    ['empty title', { ...valid(), firstTitle: '' }],
    ['padded title', { ...valid(), firstTitle: ' title ' }],
    ['control title', { ...valid(), firstTitle: 'bad‮name' }],
    ['overlong title', { ...valid(), firstTitle: 'x'.repeat(121) }],
  ])('rejects %s', (_label, frame) => {
    expect(parseProQueueAdditionFrame(frame)).toBeNull();
  });
});
