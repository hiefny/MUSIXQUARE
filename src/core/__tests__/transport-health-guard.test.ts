import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  analyzeTransportHealth,
  assertTransportHealth,
  loadTransportHealthInput,
  type TransportHealthInput,
} from '../../../scripts/check-transport-health.mts';

// The guard runs on the real tree; every seeded violation below edits an
// in-memory copy of it (or a temporary directory), never a checked-in file.
let baseline: TransportHealthInput | null = null;

function realInput(): TransportHealthInput {
  baseline ??= loadTransportHealthInput(process.cwd());
  return baseline;
}

function withSources(edit: (sources: Map<string, string>) => void): TransportHealthInput {
  const sources = new Map(realInput().sources);
  edit(sources);
  return { sources };
}

function replaceIn(sources: Map<string, string>, file: string, from: string, to: string): void {
  const source = sources.get(file) ?? '';
  expect(source).toContain(from);
  sources.set(file, source.replace(from, to));
}

function findingsOf(input: TransportHealthInput): string {
  return analyzeTransportHealth(input).findings.join('\n');
}

function runGuard(...args: string[]) {
  return spawnSync(process.execPath, ['scripts/check-transport-health.mts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('transport-health guard (C5-4)', { timeout: 60_000 }, () => {
  it('passes on the real tree with only the heartbeat warning reading raw state', () => {
    const report = assertTransportHealth(realInput());
    expect(report.findings).toEqual([]);
    expect(report.rawStateReads).toBe(1);
    expect(report.pairedConsumers).toBe(3);
  });

  it('runs from CI as an npm guard and fails a broken tree with exit 1', () => {
    const passing = runGuard();
    expect(passing.status, passing.stderr).toBe(0);
    expect(passing.stdout).toContain('[transport-health] OK');

    const root = mkdtempSync(join(tmpdir(), 'transport-health-'));
    try {
      mkdirSync(join(root, 'src', 'storage'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'storage', 'stray.ts'),
        'export const down = (pc: RTCPeerConnection): boolean =>\n' +
          "  pc.connectionState === 'failed';\n",
      );
      const failing = runGuard(`--root=${root}`);
      expect(failing.status).toBe(1);
      expect(failing.stderr).toContain('UNSANCTIONED raw state read: src/storage/stray.ts has 1');
      expect(failing.stderr).toContain(
        'STALE BASELINE raw state read: src/network/heartbeat-monitor.ts has 0, baseline 1',
      );
      expect(failing.stderr).toContain('MISSING FILE: src/network/transport-health.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['guard:transport-health']).toBe(
      'node scripts/check-transport-health.mts',
    );
    expect(readFileSync('.github/workflows/ci.yml', 'utf8')).toContain(
      'npm run guard:transport-health',
    );
  });

  it('counts property, optional, element and destructured reads but not comments or strings', () => {
    const findings = findingsOf(
      withSources((sources) => {
        sources.set(
          'src/storage/rogue.ts',
          [
            '// pc.connectionState in a comment does not count',
            "const label = 'pc.iceConnectionState';",
            'export function a(pc: RTCPeerConnection): unknown {',
            '  const { iceConnectionState } = pc;',
            "  return [label, pc?.connectionState, pc['iceConnectionState'], iceConnectionState];",
            '}',
          ].join('\n'),
        );
      }),
    );
    expect(findings).toContain('UNSANCTIONED raw state read: src/storage/rogue.ts has 3');
  });

  it('rejects a second raw read in the heartbeat monitor', () => {
    const findings = findingsOf(
      withSources((sources) =>
        replaceIn(
          sources,
          'src/network/heartbeat-monitor.ts',
          'const health = readTransportHealth(conn);',
          'const health = readTransportHealth(conn);\n' +
            "        if (conn?.peerConnection?.iceConnectionState === 'failed') continue;",
        ),
      ),
    );
    expect(findings).toMatch(
      /RATCHET REGRESSION raw state read: src\/network\/heartbeat-monitor\.ts has 2, baseline 1/u,
    );
  });

  it('rejects a consumer that drops its transport-health predicate', () => {
    const findings = findingsOf(
      withSources((sources) =>
        replaceIn(
          sources,
          'src/storage/preload.ts',
          "import { isRecoverablyInterrupted, readTransportHealth } from '../network/transport-health.ts';",
          "import { readTransportHealth } from '../network/transport-health.ts';",
        ),
      ),
    );
    expect(findings).toContain(
      'UNPAIRED CONSUMER: src/storage/preload.ts no longer imports isRecoverablyInterrupted',
    );
  });

  it('leaves readers outside its scope alone', () => {
    const report = analyzeTransportHealth(
      withSources((sources) => {
        sources.set(
          'src/network/system-audio-extra.ts',
          'export const s = (pc: RTCPeerConnection) => pc.connectionState;\n',
        );
      }),
    );
    expect(report.findings).toEqual([]);
  });
});
