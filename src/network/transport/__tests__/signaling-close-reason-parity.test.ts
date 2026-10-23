import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The client and the signaling Worker share close reasons only as string
// literals. The PRO epoch reason was renamed in the Worker on 2026-07-20 while
// the client kept the old name, so pin the client's diagnostic allow-list and
// the Standard expiry reason to what the Worker source actually sends.
const CLIENT_SOURCE = readFileSync('src/network/transport/cloudflare-signaling.ts', 'utf8');
const WORKER_SOURCE = readFileSync('cloudflare/signaling-worker.ts', 'utf8');

function clientDiagnosticAllowList(): string[] {
  const match = /const RECOGNIZED_SIGNALING_CLOSE_REASONS = \[([^\]]*)\] as const;/u.exec(
    CLIENT_SOURCE,
  );
  if (!match?.[1]) throw new Error('RECOGNIZED_SIGNALING_CLOSE_REASONS was not found');
  return [...match[1].matchAll(/'([A-Z_]+)'/gu)].map((reason) => reason[1]!);
}

/** Literal reasons the signaling Worker closes a socket with when the code can be 1012. */
function worker1012Reasons(): Set<string> {
  const reasons = new Set<string>();
  for (const call of WORKER_SOURCE.matchAll(
    /closeSocket\(\s*[\w.]+,\s*([^,]*?),\s*'([A-Z_]+)',?\s*\)/gu,
  )) {
    if (/\b1012\b/u.test(call[1]!)) reasons.add(call[2]!);
  }
  for (const call of WORKER_SOURCE.matchAll(
    /closeWithError\(\s*[\w.]+,\s*'[^']+',\s*'([A-Z_]+)',\s*1012\b/gu,
  )) {
    reasons.add(call[1]!);
  }
  return reasons;
}

describe('signaling close reason parity', () => {
  it('records only close reasons the signaling Worker sends with 1012', () => {
    const allowList = clientDiagnosticAllowList();
    const workerReasons = worker1012Reasons();

    expect(allowList).toEqual([
      'ROOM_EXPIRED',
      'PRO_ROOM_EPOCH_ADVANCED',
      'HOST_REPLACED',
      'GUEST_REPLACED',
    ]);
    expect(new Set(allowList).size).toBe(allowList.length);
    for (const reason of allowList) {
      expect(workerReasons, `${reason} is not a Worker 1012 close reason`).toContain(reason);
    }
    // The renamed PRO reason must not come back into the diagnostic list.
    expect(workerReasons).not.toContain('PRO_COORDINATOR_EPOCH_ADVANCED');
    // Known Standard 1012 reasons left out only for eager-bundle size; they
    // remain valid candidates for the list.
    for (const reason of [
      'STANDARD_ROOM_AUTHORITY_STALE',
      'GUEST_AUTH_RETRY_REQUIRED',
      'SERVICE_MAINTENANCE',
    ]) {
      expect(workerReasons).toContain(reason);
    }
  });

  it('keeps the Standard expiry boundary on the reason the Worker sends', () => {
    expect(WORKER_SOURCE).toMatch(/closeSocket\(\s*socket,\s*1012,\s*'ROOM_EXPIRED'\s*\)/u);
    expect(CLIENT_SOURCE).toMatch(
      /\(event as CloseEvent\)\.code === 1012 &&\s*\(event as CloseEvent\)\.reason === 'ROOM_EXPIRED'/u,
    );
  });
});
