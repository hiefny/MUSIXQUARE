import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  analyzeResourceOwnership,
  assertResourceOwnership,
  loadResourceOwnershipInput,
  REGISTRY_PATH,
  type ResourceOwnershipInput,
} from '../../../scripts/check-resource-ownership.mts';

// The guard runs on the real tree; every seeded violation below edits an
// in-memory copy of it (or a temporary directory), never a checked-in file.
let baseline: ResourceOwnershipInput | null = null;

function realInput(): ResourceOwnershipInput {
  baseline ??= loadResourceOwnershipInput(process.cwd());
  return baseline;
}

function withSources(edit: (sources: Map<string, string>) => void): ResourceOwnershipInput {
  const input = realInput();
  const sources = new Map(input.sources);
  edit(sources);
  return { registry: input.registry, sources };
}

function withRegistry(edit: (registry: string) => string): ResourceOwnershipInput {
  const input = realInput();
  const registry = edit(input.registry);
  expect(registry).not.toBe(input.registry);
  return { registry, sources: input.sources };
}

function replaceIn(sources: Map<string, string>, file: string, from: string, to: string): void {
  const source = sources.get(file) ?? '';
  expect(source).toContain(from);
  sources.set(file, source.replace(from, to));
}

function findingsOf(input: ResourceOwnershipInput): string {
  return analyzeResourceOwnership(input).findings.join('\n');
}

function runGuard(...args: string[]) {
  return spawnSync(process.execPath, ['scripts/check-resource-ownership.mts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('resource-ownership guard', { timeout: 60_000 }, () => {
  it('passes on the real tree with PRO SFU reception owning its own deadline', () => {
    const report = assertResourceOwnership(realInput());
    const blockLines = /^```resource-ownership\r?\n([\s\S]*?)^```/mu
      .exec(realInput().registry)?.[1]
      ?.split(/\r?\n/u)
      .filter((line) => line.trim()).length;

    expect(report.findings).toEqual([]);
    expect(report.registryIds).toBe(blockLines);
    expect(report.deadline.mode).toBe('watchdog-off');
    expect(report.timingPairs.reportOnly.length).toBeGreaterThan(0);
  });

  it('runs from CI as a plain node script and fails a broken tree with exit 1', () => {
    const passing = runGuard();
    expect(passing.status, passing.stderr).toBe(0);
    expect(passing.stdout).toContain('[resource-ownership] OK');

    const root = mkdtempSync(join(tmpdir(), 'resource-ownership-'));
    try {
      mkdirSync(join(root, 'docs', 'design'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, REGISTRY_PATH),
        '```resource-ownership\nRO-01 duplicated\nRO-01 duplicated\n```\n',
      );
      writeFileSync(join(root, 'src', 'stray-navigation.ts'), "location.href = '/';\n");
      const failing = runGuard(`--root=${root}`);
      expect(failing.status).toBe(1);
      expect(failing.stderr).toContain('RO-01 appears twice in the block');
      expect(failing.stderr).toContain(
        'UNSANCTIONED page navigation (RO-23): src/stray-navigation.ts',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain('run: node scripts/check-resource-ownership.mts');
  });

  describe('CHECK 1 registry parity', () => {
    it('rejects a duplicate or malformed block ID', () => {
      expect(
        findingsOf(
          withRegistry((registry) => registry.replace('RO-02 duplicated\n', 'RO-01 duplicated\n')),
        ),
      ).toMatch(/RO-01 appears twice in the block/u);
      expect(
        findingsOf(
          withRegistry((registry) =>
            registry.replace(
              'RO-46 accepted-exception\n',
              'RO-46 accepted-exception\nRO-7 duplicated\n',
            ),
          ),
        ),
      ).toMatch(/malformed block line "RO-7 duplicated"/u);
    });

    it('rejects block lines out of ascending ID order and headings in another order', () => {
      const findings = findingsOf(
        withRegistry((registry) =>
          registry.replace(
            'RO-01 duplicated\nRO-02 duplicated\n',
            'RO-02 duplicated\nRO-01 duplicated\n',
          ),
        ),
      );
      expect(findings).toMatch(/RO-01 is out of ascending ID order in the block/u);
      expect(findings).toMatch(/block IDs differ from the "### RO-NN" record headings/u);
    });

    it('reads the first Status word with backticks and surrounding punctuation stripped', () => {
      const field = '- **Status:** `owner-in-place`. Phase 4 (optional naming).';
      expect(
        findingsOf(
          withRegistry((registry) =>
            registry.replace(field, '- **Status:** owner-in-place. Phase 4 (optional naming).'),
          ),
        ),
      ).toBe('');
      expect(
        findingsOf(
          withRegistry((registry) =>
            registry.replace(field, '- **Status:** duplicated, Phase 4 (optional naming).'),
          ),
        ),
      ).toMatch(/RO-10 Status field says "duplicated" but the block says "owner-in-place"/u);
      expect(
        findingsOf(
          withRegistry((registry) =>
            registry.replace(field, '- **Status:** `consolidated`. Phase 4 (optional naming).'),
          ),
        ),
      ).toMatch(/RO-10 Status field starts with unknown status "consolidated"/u);
    });

    it('reads a Status field only inside its own record', () => {
      const findings = findingsOf(
        withRegistry((registry) =>
          registry.replace(
            '- **Status:** `accepted-exception`.\n\n## Checked side flows without a record\n',
            '\n## Checked side flows without a record\n\n- **Status:** `accepted-exception`.\n',
          ),
        ),
      );
      expect(findings).toMatch(/RO-46 has no "- \*\*Status:\*\*" field in its record/u);
    });

    it('rejects a block ID missing from the index and an index row without a block line', () => {
      const missing = findingsOf(
        withRegistry((registry) => registry.replace(/^\| RO-46 .*\r?\n/mu, '')),
      );
      expect(missing).toMatch(/RO-46 is missing from the index table/u);
      const extra = findingsOf(
        withRegistry((registry) =>
          registry.replace(
            /^(\| RO-46 .*\r?\n)/mu,
            '$1| RO-47 | Stray row | All | duplicated | None |\n',
          ),
        ),
      );
      expect(extra).toMatch(/index row RO-47 has no block line/u);
    });

    it('rejects a block status that disagrees with the record and the index', () => {
      const findings = findingsOf(
        withRegistry((registry) =>
          registry.replace('RO-10 owner-in-place\n', 'RO-10 duplicated\n'),
        ),
      );
      expect(findings).toMatch(
        /RO-10 Status field says "owner-in-place" but the block says "duplicated"/u,
      );
      expect(findings).toMatch(/RO-10 index status "owner-in-place" differs/u);
    });

    it('rejects a block ID without a record heading, and a guard ID without a block line', () => {
      expect(
        findingsOf(
          withRegistry((registry) =>
            registry.replace(
              '### RO-46 Invalidation events are sent once',
              '### Invalidation events are sent once',
            ),
          ),
        ),
      ).toMatch(/block only: RO-46/u);
      expect(
        findingsOf(withRegistry((registry) => registry.replace('RO-44 accepted-exception\n', ''))),
      ).toMatch(/this guard names RO-44, which has no block line/u);
    });

    it('rejects owner headers for unknown, exception or doubly claimed records', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set('src/core/owner-a.ts', '/** Resource owner: RO-99 */\nexport {};\n');
          sources.set('src/core/owner-b.ts', '// Resource owner: RO-24\nexport {};\n');
          sources.set('src/core/owner-c.ts', '// Resource owner: RO-24\nexport {};\n');
          sources.set('src/core/owner-d.ts', '// Resource owner: RO-31\nexport {};\n');
        }),
      );
      expect(findings).toMatch(/owner-a\.ts has "Resource owner: RO-99", which is not a record/u);
      expect(findings).toMatch(/RO-24 is claimed by more than one owner file/u);
      expect(findings).toMatch(/owner-d\.ts claims exception record RO-31/u);
    });
  });

  describe('CHECK 2 guarded page state', () => {
    it('rejects a new page lock that walks body children and writes inert directly (G4)', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/ui/rogue-page-lock.ts',
            'export function lock(): void {\n' +
              '  for (const child of document.body.children) {\n' +
              '    (child as HTMLElement).inert = true;\n' +
              "    child.setAttribute('aria-hidden', 'true');\n" +
              '  }\n' +
              '}\n',
          );
        }),
      );
      expect(findings).toMatch(
        /UNSANCTIONED inert write \(RO-24\): src\/ui\/rogue-page-lock\.ts has 1/u,
      );
      expect(findings).toMatch(
        /UNSANCTIONED body-children walk \(RO-24\): src\/ui\/rogue-page-lock\.ts/u,
      );
      expect(findings).toMatch(
        /UNSANCTIONED page-lock aria-hidden write \(RO-24\): src\/ui\/rogue-page-lock\.ts/u,
      );
    });

    it('rejects the session reset writing inert again beside its ledger claim', () => {
      const findings = findingsOf(
        withSources((sources) =>
          replaceIn(
            sources,
            'src/core/session-reset.ts',
            '    setElementInertForOwner(child, INERT_OWNER, true, { ariaHidden: false });',
            '    setElementInertForOwner(child, INERT_OWNER, true, { ariaHidden: false });\n' +
              "    child.setAttribute('inert', '');",
          ),
        ),
      );
      expect(findings).toMatch(/UNSANCTIONED inert write \(RO-24\): src\/core\/session-reset\.ts/u);
    });

    it('rejects new fullscreen, history, navigation and SKIP_WAITING sinks', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/ui/rogue-sinks.ts',
            'export async function rogue(worker: ServiceWorker): Promise<void> {\n' +
              '  await document.documentElement.requestFullscreen();\n' +
              "  window.history.pushState(null, '', '/x');\n" +
              '  history.back();\n' +
              "  window.location.href = '/';\n" +
              '  location.reload();\n' +
              "  worker.postMessage({ type: 'SKIP_WAITING' });\n" +
              '}\n',
          );
        }),
      );
      expect(findings).toMatch(
        /UNSANCTIONED fullscreen request\/exit \(RO-26\): src\/ui\/rogue-sinks\.ts has 1/u,
      );
      expect(findings).toMatch(
        /UNSANCTIONED history entry write \(RO-30\): src\/ui\/rogue-sinks\.ts has 2/u,
      );
      expect(findings).toMatch(
        /UNSANCTIONED page navigation \(RO-23\): src\/ui\/rogue-sinks\.ts has 2/u,
      );
      expect(findings).toMatch(
        /UNSANCTIONED SKIP_WAITING send \(RO-22\): src\/ui\/rogue-sinks\.ts has 1/u,
      );
    });

    it('fails a raised count in an allowlisted file and a count that fell below its baseline', () => {
      const findings = findingsOf(
        withSources((sources) => {
          replaceIn(
            sources,
            'src/sw-register.ts',
            '      window.location.href = returnPath;',
            '      window.location.href = returnPath;\n      window.location.reload();',
          );
          replaceIn(
            sources,
            'src/player/video.ts',
            "wrapper.toggleAttribute('inert', parked);",
            'void parked;',
          );
        }),
      );
      expect(findings).toMatch(
        /RATCHET REGRESSION page navigation \(RO-23\): src\/sw-register\.ts has 2, baseline 1/u,
      );
      expect(findings).toMatch(
        /STALE BASELINE inert write \(RO-24\): src\/player\/video\.ts has 0 - remove its entry/u,
      );
    });

    it('ignores comments and strings that only mention a sink', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/ui/sink-mentions.ts',
            '// history.pushState and location.reload() are owned elsewhere.\n' +
              "export const note = 'element.inert = true';\n",
          );
        }),
      );
      expect(findings).toBe('');
    });
  });

  describe('CHECK 3 Worker caller allowlists', () => {
    it('rejects a second builder of the signaling broadcast request', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'cloudflare/rogue-broadcast.ts',
            'export function sendDirect(fetcher: Fetcher): Promise<Response> {\n' +
              "  return fetcher.fetch('https://signaling.internal/internal/realtime/v1/broadcast', {\n" +
              "    method: 'POST',\n" +
              '  });\n' +
              '}\n',
          );
        }),
      );
      expect(findings).toMatch(
        /UNSANCTIONED signaling broadcast endpoint \(RO-07\): cloudflare\/rogue-broadcast\.ts :: sendDirect has 1/u,
      );
    });

    it('rejects a third duration reader, called or passed on', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'cloudflare/rogue-duration.ts',
            "import { readProRoomFileDuration } from './pro-room-media-duration.ts';\n" +
              'export const probes = { read: readProRoomFileDuration };\n' +
              'export async function readAgain(bucket: never): Promise<number | null> {\n' +
              "  return readProRoomFileDuration(bucket, 'key', 1);\n" +
              '}\n',
          );
        }),
      );
      // Passing the reader on counts at its use site (here module scope).
      expect(findings).toMatch(
        /UNSANCTIONED PRO duration read \(RO-08\): cloudflare\/rogue-duration\.ts :: <module> has 1/u,
      );
      expect(findings).toMatch(
        /UNSANCTIONED PRO duration read \(RO-08\): cloudflare\/rogue-duration\.ts :: readAgain has 1/u,
      );
    });

    it('counts duration reads only in cloudflare/, where the R2 resource lives', () => {
      // src/pro-room/upload-duration.ts parses the uploader's local file with
      // the same reader; app code is outside RO-08 and is not counted.
      expect(realInput().sources.get('src/pro-room/upload-duration.ts')).toContain(
        'readProRoomFileDuration(',
      );
      // Joined so this fixture text is not a relative Worker import literal: the
      // suite never loads Worker code, so it stays out of the Worker coverage
      // ratchet (ci-quality-gates.test.ts).
      const durationModule = ['..', '..', 'cloudflare', 'pro-room-media-duration.ts'].join('/');
      const input = withSources((sources) => {
        sources.set(
          'src/pro-room/local-duration.ts',
          `import { readProRoomFileDuration } from '${durationModule}';\n` +
            'export async function readLocal(file: never): Promise<number | null> {\n' +
            "  return readProRoomFileDuration(file, 'local', 1);\n" +
            '}\n',
        );
      });
      const report = analyzeResourceOwnership(input);
      expect(report.findings).toEqual([]);
      expect(report.workerSites['PRO duration read']).toBe(2);
    });
  });

  describe('CHECK 4 one deadline owner per PRO SFU attempt (G1)', () => {
    const service = 'src/pro-room/system-audio-service.ts';
    const sfuStart = 'beginTrustedSystemAudioReception(undefined, { receiveWatchdog: false });';
    const retryMax = 'const SUBSCRIBER_RETRY_MAX_DELAY_MS = 30_000;';

    it('rejects an SFU reception start that re-arms the guest watchdog', () => {
      const input = withSources((sources) =>
        replaceIn(sources, service, sfuStart, 'beginTrustedSystemAudioReception();'),
      );
      const report = analyzeResourceOwnership(input);
      expect(report.deadline.mode).toBe('violated');
      expect(report.findings.join('\n')).toMatch(
        /DEADLINE OWNER \(RO-04, G1\): src\/pro-room\/system-audio-service\.ts:\d+ starts PRO SFU reception with the guest receive watchdog armed/u,
      );
    });

    it('rejects an armed start in the retry path, which re-arms before the SFU start', () => {
      // The later disarmed SFU start returns early while the placeholder is
      // active, so this one line would bring G1 back.
      const findings = findingsOf(
        withSources((sources) =>
          replaceIn(
            sources,
            service,
            '  cleanupCoordinatorSubscriptionForRetry();\n  setSystemAudioReceiving(false);\n',
            '  cleanupCoordinatorSubscriptionForRetry();\n  setSystemAudioReceiving(false);\n' +
              '  beginTrustedSystemAudioReception();\n',
          ),
        ),
      );
      expect(findings).toMatch(
        /UNSANCTIONED armed reception start \(RO-04\): src\/pro-room\/system-audio-service\.ts :: retryCoordinatorSubscription has 1/u,
      );
    });

    it('rejects an armed start in a new module, called or passed on', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/pro-room/rogue-reception.ts',
            "import { beginTrustedSystemAudioReception } from '../network/system-audio-guest.ts';\n" +
              'export const starts = [beginTrustedSystemAudioReception];\n' +
              'export function restart(): void {\n' +
              "  beginTrustedSystemAudioReception('display', { receiveWatchdog: true });\n" +
              '  beginTrustedSystemAudioReception(undefined, { receiveWatchdog: false });\n' +
              '}\n',
          );
        }),
      );
      expect(findings).toMatch(
        /UNSANCTIONED armed reception start \(RO-04\): src\/pro-room\/rogue-reception\.ts :: <module> has 1/u,
      );
      expect(findings).toMatch(
        /UNSANCTIONED armed reception start \(RO-04\): src\/pro-room\/rogue-reception\.ts :: restart has 1/u,
      );
    });

    it('needs a reasoned entry, not a deadline finding, once the retry maximum stays below it', () => {
      const input = withSources((sources) => {
        replaceIn(sources, service, sfuStart, 'beginTrustedSystemAudioReception();');
        replaceIn(sources, service, retryMax, 'const SUBSCRIBER_RETRY_MAX_DELAY_MS = 20_000;');
      });
      const report = analyzeResourceOwnership(input);
      expect(report.deadline).toMatchObject({
        mode: 'retry-below-watchdog',
        retryMaxMs: 20_000,
        watchdogMs: 30_000,
      });
      expect(report.findings).toEqual([
        expect.stringMatching(
          /^RATCHET REGRESSION armed reception start \(RO-04\): src\/pro-room\/system-audio-service\.ts :: ensureCoordinatorSubscription has 2, baseline 1/u,
        ),
      ]);
    });

    it('fails closed when its anchors move', () => {
      const findings = findingsOf(
        withSources((sources) =>
          replaceIn(sources, service, retryMax, 'const SUBSCRIBER_RETRY_MAX_MS = 30_000;'),
        ),
      );
      expect(findings).toMatch(/has no numeric SUBSCRIBER_RETRY_MAX_DELAY_MS/u);
    });
  });

  describe('CHECK 5 copied timing constants', () => {
    it('rejects a same-named copy inside a registered contract', () => {
      const findings = findingsOf(
        withSources((sources) => {
          const file = 'src/player/background-return-sync.ts';
          sources.set(
            file,
            `${sources.get(file) ?? ''}\nconst SUCCESS_COOLDOWN_MS = 400;\nvoid SUCCESS_COOLDOWN_MS;\n`,
          );
        }),
      );
      expect(findings).toMatch(
        /COPIED TIMING CONSTANT \(principle 4\): RO-05 SUCCESS_COOLDOWN_MS@src\/player\/background-return-sync\.ts = SUCCESS_COOLDOWN_MS@src\/player\/local-output-rejoin\.ts \(400\)/u,
      );
    });

    it('asks to lower the baseline when a copy is imported from its home', () => {
      const findings = findingsOf(
        withSources((sources) =>
          replaceIn(
            sources,
            'src/player/background-return-sync.ts',
            'const RENDEZVOUS_RETRY_MS = [250, 750, 1_500, 3_000, 5_000] as const;',
            'const RENDEZVOUS_RETRY_MS = REJOIN_RETRY_MS;',
          ),
        ),
      );
      expect(findings).toMatch(/STALE BASELINE copied timing constant: RO-05 REJOIN_RETRY_MS/u);
    });

    it('keeps differently named constants that only share a value report-only', () => {
      const input = withSources((sources) => {
        const file = 'src/player/background-return-sync.ts';
        sources.set(
          file,
          `${sources.get(file) ?? ''}\nconst SETTLE_WAIT_MS = 400;\nvoid SETTLE_WAIT_MS;\n`,
        );
      });
      const report = analyzeResourceOwnership(input);
      expect(report.findings).toEqual([]);
      expect(report.timingPairs.reportOnly).toContain(
        'RO-05 SETTLE_WAIT_MS@src/player/background-return-sync.ts = ' +
          'SUCCESS_COOLDOWN_MS@src/player/local-output-rejoin.ts (400)',
      );
    });
  });

  describe('CHECK 6 AudioContext native resume and suspend', () => {
    it('counts an unowned resume but not the Back guard controller', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/audio/rogue-resume.ts',
            'export function wake(context: AudioContext, controller: { resume(): void }): void {\n' +
              '  void context.resume();\n' +
              '  controller.resume();\n' +
              '}\n',
          );
        }),
      );
      expect(findings).toMatch(
        /UNSANCTIONED AudioContext native resume\/suspend \(RO-44\): src\/audio\/rogue-resume\.ts has 1/u,
      );
    });
  });
});
