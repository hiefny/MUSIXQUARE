/**
 * Source parity for the LAN-direct publisher's pair-proof window.
 * DIRECT_PAIR_PROOF_TIMEOUT_MS is private to
 * src/network/pro-system-audio-direct.ts, its RO-20 timing home, so the
 * LAN-direct suite reads the test copy in __helpers__/direct-pair-proof-window.ts
 * instead. This row fails when the runtime value moves, so the copy moves with
 * it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DIRECT_PAIR_PROOF_TIMEOUT_MS_COPY } from './__helpers__/direct-pair-proof-window.ts';

describe('LAN-direct pair-proof window copy', () => {
  it('equals DIRECT_PAIR_PROOF_TIMEOUT_MS in pro-system-audio-direct.ts', () => {
    const source = readFileSync(resolve('src/network/pro-system-audio-direct.ts'), 'utf8');
    const values = [...source.matchAll(/\bconst DIRECT_PAIR_PROOF_TIMEOUT_MS = ([\d_]+);/gu)].map(
      (match) => Number(match[1]!.replaceAll('_', '')),
    );
    expect(values).toEqual([DIRECT_PAIR_PROOF_TIMEOUT_MS_COPY]);
  });
});
