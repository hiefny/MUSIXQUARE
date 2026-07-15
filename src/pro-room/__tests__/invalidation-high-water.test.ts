import { describe, expect, it } from 'vitest';
import { ProRoomInvalidationHighWater } from '../invalidation-high-water.ts';

describe('PRO room invalidation high-water', () => {
  it('coalesces an identical forged high hint and lets heartbeat authority release it', () => {
    const marks = new ProRoomInvalidationHighWater();
    const current = { revision: 4, playlistRevision: 2 };
    const forged = { revision: Number.MAX_SAFE_INTEGER, playlistRevision: 2 };

    expect(marks.offer(forged, current)).toBe(true);
    expect(marks.offer(forged, current)).toBe(false);
    const heartbeat = marks.beginHeartbeat();
    marks.finishHeartbeat(current, heartbeat);

    expect(marks.pending).toBe(false);
    expect(marks.offer({ revision: 5, playlistRevision: 3 }, current)).toBe(true);
  });

  it('preserves a newer hint that arrives while an authoritative heartbeat is in flight', () => {
    const marks = new ProRoomInvalidationHighWater();
    const current = { revision: 4, playlistRevision: 2 };
    marks.offer({ revision: 5, playlistRevision: 3 }, current);
    const heartbeat = marks.beginHeartbeat();
    marks.offer({ revision: 6, playlistRevision: 4 }, current);

    marks.finishHeartbeat({ revision: 5, playlistRevision: 3 }, heartbeat);

    expect(marks.pending).toBe(true);
    expect(marks.revision).toBe(6);
    expect(marks.playlistRevision).toBe(4);
  });
});
