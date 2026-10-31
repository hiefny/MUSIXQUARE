/**
 * Source parity for the LAN-direct pair-proof poll. DIRECT_PAIR_POLL_MS is
 * private to src/network/pro-system-audio-direct.ts, its RO-20 timing home, so
 * the suites that wait for a pair check to see its route close read the test
 * copy in __helpers__/direct-pair-poll.ts instead. This row fails when the
 * runtime value moves, so the copy moves with it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DIRECT_PAIR_POLL_MS_COPY } from './__helpers__/direct-pair-poll.ts';

describe('LAN-direct pair-proof poll copy', () => {
  it('equals DIRECT_PAIR_POLL_MS in pro-system-audio-direct.ts', () => {
    const source = readFileSync(resolve('src/network/pro-system-audio-direct.ts'), 'utf8');
    const values = [...source.matchAll(/\bconst DIRECT_PAIR_POLL_MS = (\d+);/gu)].map((match) =>
      Number(match[1]),
    );
    expect(values).toEqual([DIRECT_PAIR_POLL_MS_COPY]);
  });
});
