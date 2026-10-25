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

const CONNECTION = 'src/network/transport/cloudflare-signaling.ts';
const OWNER = 'src/network/transport/link-liveness.ts';

describe('transport-health guard: the link-liveness owner (C5-10)', { timeout: 60_000 }, () => {
  it('passes on the real tree with the retired names only in the owner and one close port call', () => {
    const report = assertTransportHealth(realInput());
    expect(report.findings).toEqual([]);
    // randomResumeProbePingId and the two probe windows, each declared and used
    // once (6), and since C5-9 the side outage's originalDown flag (7).
    expect(report.retiredNamesInOwner).toBe(13);
    expect(report.closePortCalls).toBe(1);
    expect(runGuard().stdout).toContain(
      '24 retired liveness names only in src/network/transport/link-liveness.ts; ' +
        'terminate() only from the close port of LinkLiveness.',
    );
  });

  it('rejects a retired name outside the owner, but not in a comment or a string', () => {
    const findings = findingsOf(
      withSources((sources) => {
        sources.set(
          'src/storage/rogue-resume.ts',
          [
            '// scheduleDisconnectedGrace in a comment does not count',
            "export const label = 'backgroundResumeProbePingId';",
            'export class Rogue {',
            '  private backgroundResumeRecoveryArmed = false;',
            '  #iceRestartAttempted = false;',
            "  'connectionInterrupted' = false;",
            '  scheduleDisconnectedGrace(): unknown {',
            "    return [this.backgroundResumeRecoveryArmed, this['cancelDisconnectedGrace']];",
            '  }',
            '}',
          ].join('\n'),
        );
        replaceIn(
          sources,
          CONNECTION,
          '  private resourcesDisposed = false;',
          '  private resourcesDisposed = false;\n' +
            "  private readonly disconnectedGraceTimerKey = 'cloudflare-data-disconnected-grace-0';\n" +
            '  private closeCause: string | null = null;',
        );
      }),
    );
    expect(findings).toContain(
      'RETIRED LIVENESS NAME: src/storage/rogue-resume.ts uses backgroundResumeRecoveryArmed 2 time(s)',
    );
    expect(findings).toContain(
      'RETIRED LIVENESS NAME: src/storage/rogue-resume.ts uses iceRestartAttempted 1 time(s)',
    );
    expect(findings).toContain(
      'RETIRED LIVENESS NAME: src/storage/rogue-resume.ts uses connectionInterrupted 1 time(s)',
    );
    expect(findings).toContain(
      'RETIRED LIVENESS NAME: src/storage/rogue-resume.ts uses scheduleDisconnectedGrace 1 time(s)',
    );
    expect(findings).toContain(
      'RETIRED LIVENESS NAME: src/storage/rogue-resume.ts uses cancelDisconnectedGrace 1 time(s)',
    );
    expect(findings).not.toContain('backgroundResumeProbePingId');
    expect(findings).toContain(
      `RETIRED LIVENESS NAME: ${CONNECTION} uses disconnectedGraceTimerKey 1 time(s) - ` +
        'the C5-10 grace key field belongs to LinkLiveness',
    );
    expect(findings).toContain(
      `RETIRED LIVENESS NAME: ${CONNECTION} uses closeCause 1 time(s) - ` +
        'the C5-10 first close cause belongs to LinkLiveness',
    );
  });

  it('allows the retired names the owner keeps inside its own module', () => {
    const report = analyzeTransportHealth(
      withSources((sources) =>
        replaceIn(
          sources,
          OWNER,
          'function randomResumeProbePingId(): number {',
          'const isBackgroundResumeProbePong = false;\nfunction randomResumeProbePingId(): number {',
        ),
      ),
    );
    expect(report.findings).toEqual([]);
    expect(report.retiredNamesInOwner).toBe(14);
  });

  it('rejects a close of the connection that bypasses the owner', () => {
    const findings = findingsOf(
      withSources((sources) => {
        replaceIn(
          sources,
          CONNECTION,
          "this.liveness.close('channel-closed');",
          "this.terminate('channel-closed', true);",
        );
        replaceIn(
          sources,
          CONNECTION,
          '  private resourcesDisposed = false;',
          '  private resourcesDisposed = false;\n' +
            "  private readonly end = (): void => this['terminate']('intentional', true);",
        );
      }),
    );
    expect(findings).toContain(
      `CLOSE PORT BYPASS: ${CONNECTION} reaches terminate() 2 time(s) outside the close port ` +
        'it hands LinkLiveness',
    );
  });

  it('rejects a terminate() that is not private', () => {
    const findings = findingsOf(
      withSources((sources) =>
        replaceIn(
          sources,
          CONNECTION,
          'private terminate(cause: LinkCloseCause, first: boolean): void {',
          'terminate(cause: LinkCloseCause, first: boolean): void {',
        ),
      ),
    );
    expect(findings).toContain('PUBLIC CLOSE: CloudflareDataConnection.terminate() is not private');
  });

  it('rejects a close port that no longer reaches terminate()', () => {
    const findings = findingsOf(
      withSources((sources) =>
        replaceIn(
          sources,
          CONNECTION,
          'close: (cause, first) => this.terminate(cause, first),',
          'close: (cause, first) => this.markClosed(),',
        ),
      ),
    );
    expect(findings).toContain(
      `MISSING CLOSE PORT: the close port of LinkLiveness in ${CONNECTION} must call ` +
        'terminate() exactly once (found 0)',
    );
  });

  it('rejects a second owner of a link', () => {
    const findings = findingsOf(
      withSources((sources) =>
        sources.set(
          'src/network/transport/second-owner.ts',
          "import { LinkLiveness } from './link-liveness.ts';\n" +
            'export const make = (ports: never) => new LinkLiveness("k", ports);\n',
        ),
      ),
    );
    expect(findings).toContain(
      'SECOND LIVENESS OWNER: src/network/transport/second-owner.ts constructs LinkLiveness',
    );
  });

  it('rejects an owner close that skips its close input, aliased or not', () => {
    const findings = findingsOf(
      withSources((sources) => {
        replaceIn(
          sources,
          OWNER,
          "this.close('original-terminal');",
          "this.ports.close('original-terminal', true);",
        );
        replaceIn(
          sources,
          OWNER,
          "this.close('resume-probe-unanswered');\n      return 'stale-connection-closed';",
          "const { close } = this.ports;\n      close('resume-probe-unanswered', true);\n" +
            "      const port = ports;\n      port.close('resume-probe-unanswered', true);\n" +
            "      return 'stale-connection-closed';",
        );
      }),
    );
    expect(findings).toContain(
      `CLOSE PORT BYPASS: ${OWNER} reads close 3 time(s) outside LinkLiveness.close(cause) ` +
        'other than this.close(cause)',
    );
  });

  it("counts the owner's own this.close(cause) as no bypass", () => {
    const report = analyzeTransportHealth(
      withSources((sources) =>
        replaceIn(
          sources,
          OWNER,
          "this.close('original-terminal');",
          "this.close('original-terminal');\n      this.close('original-terminal');",
        ),
      ),
    );
    expect(report.findings).toEqual([]);
    expect(report.closePortCalls).toBe(1);
  });

  it('rejects an owner without its close input or whose input skips the port', () => {
    const skipped = findingsOf(
      withSources((sources) =>
        replaceIn(sources, OWNER, 'this.ports.close(cause, first);', 'void first;'),
      ),
    );
    expect(skipped).toContain(
      'MISSING CLOSE PORT: LinkLiveness.close(cause) must call its close port exactly once (found 0)',
    );
    const missing = findingsOf(
      withSources((sources) =>
        replaceIn(
          sources,
          OWNER,
          '  close(cause: LinkCloseCause): void {',
          '  end(cause: LinkCloseCause): void {',
        ),
      ),
    );
    expect(missing).toContain(
      `MISSING CLOSE INPUT: LinkLiveness.close(cause) not found in ${OWNER}`,
    );
  });
});

const SIDE_ROUTE = 'src/network/transport/control-isolation.ts';
const C9_FIXTURE = 'src/network/transport/__tests__/fixtures/control-isolation-c9.ts';

describe('transport-health guard: the side outage deadline (C5-9)', { timeout: 60_000 }, () => {
  it('rejects the side route taking its outage deadline back, in a member, a call or a key', () => {
    const findings = findingsOf(
      withSources((sources) => {
        replaceIn(
          sources,
          SIDE_ROUTE,
          '  readonly outages: SideOutageOwner;',
          '  readonly outages: SideOutageOwner;\n  originalReady?(): boolean;',
        );
        replaceIn(
          sources,
          SIDE_ROUTE,
          '  private negotiationTimer: ReturnType<typeof setTimeout> | null = null;',
          '  private negotiationTimer: ReturnType<typeof setTimeout> | null = null;\n' +
            '  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;',
        );
        replaceIn(
          sources,
          SIDE_ROUTE,
          '  /** The original route changed and may carry restart signaling: restart if one is due. */',
          [
            '  // armDeadline in a comment does not count',
            '  originalChanged(): void {',
            '    const interruption = this.beginInterruption();',
            '    if (!this.options.originalReady?.()) interruption.originalDown = true;',
            "    else this['armDeadline'](interruption);",
            '  }',
            '  private restartExpired(): void {',
            "    log.warn('restartExpired in a string does not count');",
            '    this.endInterruption();',
            '  }',
            '  /** The original route changed and may carry restart signaling: restart if one is due. */',
          ].join('\n'),
        );
        replaceIn(
          sources,
          CONNECTION,
          'sideMayRestart: () => this.controlIsolation?.mayRestart(),',
          'sideMayRestart: () => this.controlIsolation?.originalChanged(),',
        );
      }),
    );
    const deadline = 'the C5-9 side outage deadline belongs to LinkLiveness';
    const wait = "the C5-9 side outage's wait for the original route belongs to LinkLiveness";
    for (const line of [
      `${SIDE_ROUTE} uses armDeadline 1 time(s) - ${deadline}`,
      `${SIDE_ROUTE} uses beginInterruption 1 time(s) - ${deadline}`,
      `${SIDE_ROUTE} uses disconnectedTimer 1 time(s) - ` +
        'the C5-9 side grace without restart belongs to LinkLiveness',
      `${SIDE_ROUTE} uses endInterruption 1 time(s) - ${deadline}`,
      `${SIDE_ROUTE} uses originalChanged 1 time(s) - ${wait}`,
      `${SIDE_ROUTE} uses originalDown 1 time(s) - ${wait}`,
      `${SIDE_ROUTE} uses originalReady 2 time(s) - ${wait}`,
      `${SIDE_ROUTE} uses restartExpired 1 time(s) - ${deadline}`,
      `${CONNECTION} uses originalChanged 1 time(s) - ${wait}`,
    ]) {
      expect(findings).toContain(`RETIRED LIVENESS NAME: ${line}`);
    }
    expect(findings.split('\n')).toHaveLength(9);
  });

  it("allows those names in the owner's module", () => {
    const report = analyzeTransportHealth(
      withSources((sources) => {
        const owner = sources.get(OWNER) ?? '';
        // armSide: declared once and called three times.
        expect(owner.match(/\barmSide\b/gu)).toHaveLength(4);
        sources.set(OWNER, owner.replaceAll('armSide', 'armDeadline'));
      }),
    );
    expect(report.findings).toEqual([]);
    expect(report.retiredNamesInOwner).toBe(17);
  });

  it('leaves the frozen C9 peer, a test fixture that keeps its old grace timer, out of scope', () => {
    expect(readFileSync(C9_FIXTURE, 'utf8')).toContain('private disconnectedTimer');
    const paths = [...realInput().sources.keys()];
    expect(paths).toContain(SIDE_ROUTE);
    expect(paths).not.toContain(C9_FIXTURE);
    expect(paths.filter((relPath) => relPath.includes('__tests__'))).toEqual([]);
  });
});
