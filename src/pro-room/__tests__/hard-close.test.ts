import { describe, expect, it, vi } from 'vitest';
import { waitForProRoomPresenceClose } from '../hard-close.ts';

describe('PRO room presence close', () => {
  it('bounds explicit leave without aborting the underlying keepalive request', async () => {
    vi.useFakeTimers();
    try {
      let finishRequest!: () => void;
      let underlyingFinished = false;
      const request = new Promise<void>((resolve) => {
        finishRequest = () => {
          underlyingFinished = true;
          resolve();
        };
      });
      const bounded = waitForProRoomPresenceClose(request, 1_200);
      const timedOut = expect(bounded).rejects.toThrow('PRO_ROOM_PRESENCE_CLOSE_TIMEOUT');

      await vi.advanceTimersByTimeAsync(1_200);
      await timedOut;
      expect(underlyingFinished).toBe(false);

      finishRequest();
      await request;
      expect(underlyingFinished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
