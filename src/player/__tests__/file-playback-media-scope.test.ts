import { describe, expect, it } from 'vitest';

import { createFilePlaybackMediaScope } from '../file-playback-media-scope.ts';

const QID = '00000000-0000-4000-8000-000000000001';

describe('file playback media scope', () => {
  it('derives the same immutable binding on host and guest', () => {
    const host = createFilePlaybackMediaScope('session:alpha-1', QID);
    const guest = createFilePlaybackMediaScope('session:alpha-1', QID);

    expect(host).toEqual(guest);
    expect(host).toEqual({
      sourceIdentity: `mxq:q:${QID}`,
      transferSessionId: `mxq:s:session:alpha-1:q:${QID}`,
    });
    expect(Object.isFrozen(host)).toBe(true);
  });

  it('keeps playback runs and queue positions out of byte identity', () => {
    const beforeReorder = createFilePlaybackMediaScope('session:alpha-1', QID);
    const afterReorder = createFilePlaybackMediaScope('session:alpha-1', QID);
    expect(afterReorder).toEqual(beforeReorder);

    const nextRoom = createFilePlaybackMediaScope('session:beta-2', QID);
    expect(nextRoom.sourceIdentity).toBe(beforeReorder.sourceIdentity);
    expect(nextRoom.transferSessionId).not.toBe(beforeReorder.transferSessionId);
  });

  it('rejects malformed session and queue identities', () => {
    expect(() => createFilePlaybackMediaScope('', QID)).toThrow(TypeError);
    expect(() => createFilePlaybackMediaScope(' session ', QID)).toThrow(TypeError);
    expect(() => createFilePlaybackMediaScope('session', 'file.mp3')).toThrow(TypeError);
  });
});
