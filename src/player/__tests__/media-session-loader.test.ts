import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initMediaSession: vi.fn(),
}));

vi.mock('../media-session.ts', () => ({ initMediaSession: mocks.initMediaSession }));

import { prepareMediaSession } from '../media-session-loader.ts';

describe('Media Session deferred loader', () => {
  it('shares one initialization between demo and room entry callers', async () => {
    const demo = prepareMediaSession();
    const room = prepareMediaSession();

    expect(room).toBe(demo);
    await expect(Promise.all([demo, room])).resolves.toEqual([undefined, undefined]);
    expect(mocks.initMediaSession).toHaveBeenCalledOnce();
  });
});
