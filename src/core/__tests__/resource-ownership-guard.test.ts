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
      // RO-10's Status field; `rest` is the start of its text after the status word.
      const rest = ' The fence is written down as invariant C13';
      const field = `- **Status:** \`owner-in-place\`.${rest}`;
      expect(
        findingsOf(
          withRegistry((registry) =>
            registry.replace(field, `- **Status:** owner-in-place.${rest}`),
          ),
        ),
      ).toBe('');
      expect(
        findingsOf(
          withRegistry((registry) => registry.replace(field, `- **Status:** duplicated,${rest}`)),
        ),
      ).toMatch(/RO-10 Status field says "duplicated" but the block says "owner-in-place"/u);
      expect(
        findingsOf(
          withRegistry((registry) =>
            registry.replace(field, `- **Status:** \`consolidated\`.${rest}`),
          ),
        ),
      ).toMatch(/RO-10 Status field starts with unknown status "consolidated"/u);
    });

    it('reads a Status field only inside its own record', () => {
      const findings = findingsOf(
        withRegistry((registry) =>
          registry.replace(
            '- **Status:** `accepted-exception`.\n\n## Records added after the survey\n',
            '\n## Records added after the survey\n\n- **Status:** `accepted-exception`.\n',
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
            /^(\| RO-47 .*\r?\n)/mu,
            '$1| RO-99 | Stray row | All | duplicated | None |\n',
          ),
        ),
      );
      expect(extra).toMatch(/index row RO-99 has no block line/u);
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
        /UNSANCTIONED fullscreen request \(RO-26\): src\/ui\/rogue-sinks\.ts has 1/u,
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

    it('keeps every fullscreen exit inside the one bounded exit slot (C8-I9)', () => {
      const findings = findingsOf(
        withSources((sources) => {
          replaceIn(
            sources,
            'src/ui/player-controls.ts',
            "  $on('btn-help', 'click', () => switchTab('guide'));",
            "  $on('btn-help', 'click', () => switchTab('guide'));\n" +
              '  const doc = document as FullscreenDocument;\n' +
              '  void (doc.webkitExitFullscreen || doc.exitFullscreen);',
          );
        }),
      );
      expect(findings).toMatch(
        /UNSANCTIONED fullscreen exit \(RO-26\): src\/ui\/player-controls\.ts has 2/u,
      );
      expect(findings).not.toMatch(/fullscreen request \(RO-26\)/u);
    });

    it('fails a raised count in an allowlisted file and a count that fell below its baseline', () => {
      const findings = findingsOf(
        withSources((sources) => {
          replaceIn(
            sources,
            'src/core/navigation.ts',
            '    window.location.href = `/${code}`;',
            '    window.location.href = `/${code}`;\n    window.location.reload();',
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
        /RATCHET REGRESSION page navigation \(RO-23\): src\/core\/navigation\.ts has 4, baseline 3/u,
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
    const watchdogOffStart = "beginTrustedSystemAudioReception(undefined, { deadline: 'route' });";
    const retryMax = 'const SUBSCRIBER_RETRY_MAX_DELAY_MS = 30_000;';

    // The LAN-direct branch (G5) passes the same options before the SFU start,
    // so the SFU start is the last one in the file.
    function armSfuStart(sources: Map<string, string>): void {
      const source = sources.get(service) ?? '';
      const at = source.lastIndexOf(watchdogOffStart);
      expect(at).toBeGreaterThan(source.indexOf(watchdogOffStart));
      sources.set(
        service,
        source.slice(0, at) +
          "beginTrustedSystemAudioReception(undefined, { deadline: 'slot' });" +
          source.slice(at + watchdogOffStart.length),
      );
    }

    it('rejects an SFU reception start that re-arms the guest watchdog', () => {
      const input = withSources(armSfuStart);
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
            '  cleanupCoordinatorSubscriptionForRetry();\n' +
              "  interruptTrustedSystemAudioReception({ deadline: 'route' });\n",
            '  cleanupCoordinatorSubscriptionForRetry();\n' +
              "  interruptTrustedSystemAudioReception({ deadline: 'route' });\n" +
              "  beginTrustedSystemAudioReception(undefined, { deadline: 'slot' });\n",
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
            "import { beginTrustedSystemAudioReception } from '../network/system-audio-receive-slot.ts';\n" +
              'export const starts = [beginTrustedSystemAudioReception];\n' +
              'export function restart(): void {\n' +
              "  beginTrustedSystemAudioReception('display', { deadline: 'slot' });\n" +
              "  beginTrustedSystemAudioReception(undefined, { deadline: 'route' });\n" +
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
        armSfuStart(sources);
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
          /^UNSANCTIONED armed reception start \(RO-04\): src\/pro-room\/system-audio-service\.ts :: ensureCoordinatorSubscription has 1/u,
        ),
      ]);
    });

    it('rejects a LAN-direct reception start that re-arms the guest watchdog (G5)', () => {
      const input = withSources((sources) =>
        replaceIn(
          sources,
          service,
          watchdogOffStart,
          "beginTrustedSystemAudioReception(undefined, { deadline: 'slot' });",
        ),
      );
      const report = analyzeResourceOwnership(input);
      expect(report.deadline.mode).toBe('watchdog-off');
      expect(report.findings).toEqual([
        expect.stringMatching(
          /^UNSANCTIONED armed reception start \(RO-04\): src\/pro-room\/system-audio-service\.ts :: ensureCoordinatorSubscription has 1/u,
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

    it('reads the receive deadline from its home, the system-audio media module (C4-2)', () => {
      const media = 'src/network/system-audio-media.ts';
      const deadline = 'export const SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS = 30_000;';
      expect(analyzeResourceOwnership(realInput()).deadline.watchdogMs).toBe(30_000);

      const moved = findingsOf(
        withSources((sources) =>
          replaceIn(sources, media, deadline, 'export const SYSTEM_AUDIO_RECEIVE_MS = 30_000;'),
        ),
      );
      expect(moved).toContain(
        'DEADLINE OWNER (RO-04, G1): src/network/system-audio-media.ts has no numeric ' +
          "SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS - move this check's anchors in the same change",
      );

      // A deadline above the retry maximum is read from the same home.
      const longer = analyzeResourceOwnership(
        withSources((sources) =>
          replaceIn(
            sources,
            media,
            deadline,
            'export const SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS = 45_000;',
          ),
        ),
      );
      expect(longer.deadline).toMatchObject({ mode: 'retry-below-watchdog', watchdogMs: 45_000 });
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

    it('rejects a re-typed copy of the shared re-align schedule', () => {
      const findings = findingsOf(
        withSources((sources) =>
          replaceIn(
            sources,
            'src/player/background-return-sync.ts',
            "const RENDEZVOUS_RETRY_TIMER = 'background-return-sync-rendezvous-retry';",
            'const RENDEZVOUS_RETRY_MS = [250, 750, 1_500, 3_000, 5_000] as const;\n' +
              "const RENDEZVOUS_RETRY_TIMER = 'background-return-sync-rendezvous-retry';",
          ),
        ),
      );
      expect(findings).toContain(
        'COPIED TIMING CONSTANT (principle 4): RO-05 ' +
          'LOCAL_OUTPUT_REALIGN_RETRY_MS@src/youtube/constants.ts = ' +
          'RENDEZVOUS_RETRY_MS@src/player/background-return-sync.ts ([250,750,1500,3000,5000])',
      );
    });

    it('asks to lower the baseline when a copy is imported from its home', () => {
      const findings = findingsOf(
        withSources((sources) =>
          replaceIn(
            sources,
            'src/core/sw-hard-reset.ts',
            'const STARTUP_PROMPT_QUIET_MS = 1_000;',
            'const STARTUP_PROMPT_QUIET_MS = PROMPT_QUIET_MS;',
          ),
        ),
      );
      expect(findings).toContain(
        'STALE BASELINE copied timing constant: RO-22/RO-23/RO-30 STARTUP_PROMPT_QUIET_MS',
      );
    });

    it('rejects a route adapter that re-types a system-audio media value beside its home (C4-1)', () => {
      const findings = findingsOf(
        withSources((sources) => {
          const file = 'src/network/system-audio-guest.ts';
          sources.set(
            file,
            `${sources.get(file) ?? ''}\nconst SYSTEM_AUDIO_PLAYOUT_DELAY_S = 0.5;\n` +
              'void SYSTEM_AUDIO_PLAYOUT_DELAY_S;\n',
          );
        }),
      );
      expect(findings).toContain(
        'COPIED TIMING CONSTANT (principle 4): RO-04 ' +
          'SYSTEM_AUDIO_PLAYOUT_DELAY_S@src/network/system-audio-guest.ts = ' +
          'SYSTEM_AUDIO_PLAYOUT_DELAY_S@src/network/system-audio-media.ts (0.5)',
      );
    });

    it('rejects a same-named copy of the shared PRO playback transition timing (RO-03)', () => {
      const findings = findingsOf(
        withSources((sources) => {
          const file = 'src/pro-room/playback-controller.ts';
          sources.set(
            file,
            `${sources.get(file) ?? ''}\nconst PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS = 700;\n` +
              'void PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS;\n',
          );
        }),
      );
      expect(findings).toContain(
        'COPIED TIMING CONSTANT (principle 4): RO-03 ' +
          'PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS@cloudflare/pro-room-playback-timing.ts = ' +
          'PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS@src/pro-room/playback-controller.ts (700)',
      );
    });

    it('rejects a same-named copy of a YouTube start timing beside its home src/youtube/constants.ts (RO-02/RO-03/RO-12)', () => {
      const findings = findingsOf(
        withSources((sources) => {
          const file = 'src/youtube/player.ts';
          sources.set(
            file,
            `${sources.get(file) ?? ''}\nconst PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS = 2_300;\n` +
              'void PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS;\n',
          );
        }),
      );
      expect(findings).toContain(
        'COPIED TIMING CONSTANT (principle 4): RO-02/RO-03/RO-12 ' +
          'PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS@src/youtube/constants.ts = ' +
          'PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS@src/youtube/player.ts (2300)',
      );
    });

    it('rejects a same-named copy of an arm timing beside its home src/youtube/constants.ts (RO-02/RO-03/RO-12)', () => {
      const findings = findingsOf(
        withSources((sources) => {
          const file = 'src/youtube/iframe.ts';
          sources.set(
            file,
            `${sources.get(file) ?? ''}\nconst YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS = 1_800;\n` +
              'void YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS;\n',
          );
        }),
      );
      expect(findings).toContain(
        'COPIED TIMING CONSTANT (principle 4): RO-02/RO-03/RO-12 ' +
          'YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS@src/youtube/constants.ts = ' +
          'YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS@src/youtube/iframe.ts (1800)',
      );
    });

    it('rejects a same-named copy of a start count or seconds value beside its home, whatever its suffix (RO-02/RO-03/RO-12)', () => {
      const copies = [
        ['YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS', '12'],
        ['YOUTUBE_ARM_SETTLE_EPSILON_SEC', '0.12'],
        ['YOUTUBE_ARM_SETTLE_STABLE_SAMPLES', '2'],
        ['YOUTUBE_ARM_SETTLE_RESEEK_EVERY', '6'],
        ['YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS', '8'],
        ['YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_SEC', '0.04'],
        ['YOUTUBE_FRESH_START_MAX_SEC', '0.12'],
      ] as const;
      const findings = findingsOf(
        withSources((sources) => {
          const file = 'src/youtube/player.ts';
          sources.set(
            file,
            `${sources.get(file) ?? ''}\n` +
              copies.map(([name, value]) => `const ${name} = ${value};\nvoid ${name};\n`).join(''),
          );
        }),
      );
      for (const [name, value] of copies) {
        expect(findings).toContain(
          'COPIED TIMING CONSTANT (principle 4): RO-02/RO-03/RO-12 ' +
            `${name}@src/youtube/constants.ts = ${name}@src/youtube/player.ts (${value})`,
        );
      }
    });

    it('rejects a re-typed copy of the arm timing beside its home src/youtube/constants.ts (RO-02/RO-03/RO-12)', () => {
      const findings = findingsOf(
        withSources((sources) => {
          const file = 'src/youtube/player.ts';
          sources.set(
            file,
            `${sources.get(file) ?? ''}\nconst RETYPED_ARM_TIMING = Object.freeze({\n` +
              '  hardMutePollMs: 30,\n  hardMuteMaxAttempts: 12,\n  warmPlayMs: 260,\n' +
              '  pauseSeekGapMs: 80,\n  settlePollMs: 80,\n});\nvoid RETYPED_ARM_TIMING;\n',
          );
        }),
      );
      expect(findings).toContain(
        'COPIED TIMING CONSTANT (principle 4): RO-02/RO-03/RO-12 ' +
          '<scalars>@src/youtube/constants.ts = ' +
          'RETYPED_ARM_TIMING@src/youtube/player.ts (5 shared values)',
      );
    });

    it('rejects a re-typed arm timing object that two start files share, as the arm copies did before 6A-3 (RO-02/RO-03/RO-12)', () => {
      const retyped =
        '\nconst RETYPED_ARM_TIMING = Object.freeze({\n' +
        '  hardMutePollMs: 30,\n  hardMuteMaxAttempts: 12,\n  warmPlayMs: 260,\n' +
        '  pauseSeekGapMs: 80,\n  settlePollMs: 80,\n});\nvoid RETYPED_ARM_TIMING;\n';
      const findings = findingsOf(
        withSources((sources) => {
          for (const file of ['src/youtube/zero-start.ts', 'src/youtube/authority-arm.ts']) {
            sources.set(file, `${sources.get(file) ?? ''}${retyped}`);
          }
        }),
      );
      expect(findings).toContain(
        'COPIED TIMING CONSTANT (principle 4): RO-02/RO-03/RO-12 ' +
          'RETYPED_ARM_TIMING@src/youtube/authority-arm.ts = ' +
          'RETYPED_ARM_TIMING@src/youtube/zero-start.ts (5 shared values)',
      );
    });

    it('keeps a differently named timing that shares a value with a start count out of the same-value pairs (RO-02/RO-03/RO-12)', () => {
      const input = withSources((sources) => {
        const file = 'src/youtube/player.ts';
        sources.set(
          file,
          `${sources.get(file) ?? ''}\nconst RESEEK_GAP_MS = 6;\nvoid RESEEK_GAP_MS;\n`,
        );
      });
      const report = analyzeResourceOwnership(input);
      expect(report.findings).toEqual([]);
      expect(report.timingPairs.reportOnly).toEqual(
        analyzeResourceOwnership(realInput()).timingPairs.reportOnly,
      );
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

  describe('CHECK 7 Developer API authority fence writers (RO-25)', () => {
    const FENCES = 'mxqr_developer_api_room_authority_fences';

    it('allows only the activator, the clearer and the decommission loop on the real tree', () => {
      const report = analyzeResourceOwnership(realInput());
      expect(report.findings).toEqual([]);
      expect(report.authorityFenceWrites).toBe(3);
    });

    it('rejects a stray fence write however its SQL is built', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'cloudflare/rogue-fence.ts',
            'export async function reopen(db: D1Database, room: string) {\n' +
              `  await db.prepare(\`UPDATE ${FENCES}\n` +
              "      SET status = 'cleared' WHERE room_code = ?1`).bind(room).run();\n" +
              '}\n' +
              `const TABLES = ['mxqr_developer_api_keys', '${FENCES}'];\n` +
              'export async function wipe(db: D1Database) {\n' +
              `  for (const table of TABLES) await db.prepare(\`DELETE FROM \${table}\`).run();\n` +
              '}\n' +
              'export async function assembled(db: D1Database) {\n' +
              "  await db.prepare('DELETE FROM mxqr_developer_api_room_' + 'authority_fences').run();\n" +
              '}\n' +
              'export async function shouted(db: D1Database) {\n' +
              `  await db.prepare('INSERT OR REPLACE INTO "${FENCES.toUpperCase()}" VALUES (1)').run();\n` +
              '}\n',
          );
        }),
      );
      for (const site of ['reopen', '<module>', 'assembled', 'shouted']) {
        expect(findings).toContain(
          `UNSANCTIONED authority fence write (RO-25): cloudflare/rogue-fence.ts :: ${site} has 1`,
        );
      }
      // The template-built DELETE counts once, at the table name in its list.
      expect(findings).not.toContain('rogue-fence.ts :: wipe');
    });

    it('fails a second write in an allowlisted function and a writer that disappears', () => {
      const findings = findingsOf(
        withSources((sources) => {
          replaceIn(
            sources,
            'cloudflare/app-worker.ts',
            'async function clearDeveloperApiAuthorityFence(',
            'async function clearDeveloperApiAuthorityFence(\n' +
              `  _reset = \`DELETE FROM ${FENCES} WHERE status = 'cleared'\`,\n`,
          );
          replaceIn(sources, 'cloudflare/pro-room-worker.ts', `        '${FENCES}',\n`, '');
        }),
      );
      expect(findings).toContain(
        'RATCHET REGRESSION authority fence write (RO-25): ' +
          'cloudflare/app-worker.ts :: clearDeveloperApiAuthorityFence has 2, baseline 1',
      );
      expect(findings).toContain(
        'STALE BASELINE authority fence write (RO-25): ' +
          'cloudflare/pro-room-worker.ts :: deleteDeveloperRoomData has 0 - remove its entry',
      );
    });

    it('ignores reads, qualified columns, comments and the fenced error code', () => {
      const report = analyzeResourceOwnership(
        withSources((sources) => {
          sources.set(
            'cloudflare/fence-reader.ts',
            `// UPDATE ${FENCES} SET status = 'cleared' (a comment, not code)\n` +
              'export async function fenced(db: D1Database, room: string) {\n' +
              '  const row = await db\n' +
              `    .prepare(\`SELECT ${FENCES}.status FROM ${FENCES} WHERE room_code = ?1\`)\n` +
              '    .bind(room)\n' +
              '    .first();\n' +
              `  const keys = \`UPDATE mxqr_developer_api_keys SET status = 'revoked'\n` +
              `    WHERE EXISTS (SELECT 1 FROM "${FENCES}" AS fence JOIN ${FENCES} ON 1)\`;\n` +
              "  return row ? 'DEVELOPER_API_AUTHORITY_FENCED' : keys;\n" +
              '}\n',
          );
        }),
      );
      expect(report.findings).toEqual([]);
      expect(report.authorityFenceWrites).toBe(3);
    });
  });

  describe('CHECK 8 header loader default holder (RO-47)', () => {
    it('rejects a new writer of the default holder but not a named holder', () => {
      const report = analyzeResourceOwnership(
        withSources((sources) => {
          sources.set(
            'src/ui/background-sync.ts',
            "import { showLoader, updateLoader } from './toast.ts';\n" +
              'export function syncInBackground(id: string): void {\n' +
              "  showLoader(true, 'Syncing...', id);\n" +
              '  updateLoader(50, id);\n' +
              "  showLoader(true, 'Syncing...');\n" +
              '  updateLoader(60, undefined);\n' +
              '  showLoader(false, undefined, void 0);\n' +
              '  // showLoader(false) in a comment does not count.\n' +
              '}\n',
          );
        }),
      );
      expect(report.findings.join('\n')).toMatch(
        /UNSANCTIONED header loader default holder write \(RO-47\): src\/ui\/background-sync\.ts has 3/u,
      );
      expect(report.defaultLoaderWrites).toBe(78 + 3);
    });

    it('counts a holder ID that a branch or a name can leave undefined', () => {
      const report = analyzeResourceOwnership(
        withSources((sources) => {
          sources.set(
            'src/ui/background-sync.ts',
            "import { updateLoader } from './toast.ts';\n" +
              'export function syncInBackground(\n' +
              '  id: string,\n' +
              '  ids: readonly string[],\n' +
              '  label?: string,\n' +
              '  tag: string | undefined = undefined,\n' +
              '): void {\n' +
              "  const held = id === '' ? undefined : id;\n" +
              '  const relayed = held;\n' +
              '  updateLoader(10, relayed);\n' +
              "  updateLoader(20, id === '' ? undefined : id);\n" +
              '  updateLoader(30, label);\n' +
              '  updateLoader(40, tag);\n' +
              // Named on every path: not counted.
              "  updateLoader(50, label ?? 'sync');\n" +
              "  updateLoader(60, id === '' ? 'empty' : id);\n" +
              '  for (const each of ids) updateLoader(70, each);\n' +
              '}\n',
          );
        }),
      );
      expect(report.findings.join('\n')).toMatch(
        /UNSANCTIONED header loader default holder write \(RO-47\): src\/ui\/background-sync\.ts has 4/u,
      );
      expect(report.defaultLoaderWrites).toBe(78 + 4);
    });

    it('fails a raised count in an allowlisted file and a writer that disappears', () => {
      const findings = findingsOf(
        withSources((sources) => {
          replaceIn(sources, 'src/youtube/player.ts', '    showLoader(false);', '    void 0;');
          replaceIn(
            sources,
            'src/storage/recovery.ts',
            '    showLoader(false);',
            '    showLoader(false);\n    showLoader(false);',
          );
        }),
      );
      expect(findings).toMatch(
        /STALE BASELINE header loader default holder write \(RO-47\): src\/youtube\/player\.ts has 0 - remove its entry/u,
      );
      expect(findings).toMatch(
        /RATCHET REGRESSION header loader default holder write \(RO-47\): src\/storage\/recovery\.ts has 3, baseline 2/u,
      );
    });
  });

  describe('CHECK 9 system-audio receive slot writers (RO-04)', () => {
    // Phase 5 prep T5 pinned the writers then, which each 5A increment lowered
    // as the receive slot took the writes. C4-4 lowered the first three by
    // one: the Standard SFU attaches through the slot's attach the direct call
    // uses. C4-5 removed the PRO coordinator's (5, 2 and 1): it attaches,
    // resumes and interrupts through the slot's existing writes. Final since
    // C4-8: the slot's writes, the sharer's own claim, the file playback
    // route's widener input and the leaveSession reset.
    const FINAL = {
      'receiving flag write': 3,
      'system-audio owner claim': 3,
      'widener.input use': 3,
      'raw receiving flag write': 1,
    };

    it('pins the final direct writers on the real tree', () => {
      expect(analyzeResourceOwnership(realInput()).receiveSlotWrites).toEqual(FINAL);
    });

    it('allows no route adapter a direct write: one there is unsanctioned, not a raised count', () => {
      // The routes that receive into the slot: the Standard direct call and
      // SFU, the PRO coordinator and its two transports.
      const routes = [
        'src/network/system-audio-guest.ts',
        'src/network/system-audio-sfu.ts',
        'src/pro-room/system-audio-service.ts',
        'src/network/pro-system-audio-sfu.ts',
        'src/network/pro-system-audio-direct.ts',
      ];
      const report = analyzeResourceOwnership(
        withSources((sources) => {
          for (const route of routes) {
            expect(sources.has(route)).toBe(true);
            sources.set(
              route,
              `${sources.get(route) ?? ''}\n` +
                'export function rogueAttach(source: AudioNode, widener: { input: AudioNode }): void {\n' +
                '  source.connect(widener.input);\n' +
                '  setSystemAudioReceiving(true);\n' +
                "  claimPlaybackOwner('system-audio');\n" +
                "  batchSetState({ 'systemAudio.isReceiving': true });\n" +
                '}\n',
            );
          }
        }),
      );
      const findings = report.findings.join('\n');
      for (const route of routes) {
        for (const label of Object.keys(FINAL)) {
          expect(findings).toContain(`UNSANCTIONED ${label} (RO-04): ${route} has 1 - `);
        }
      }
      expect(findings).not.toMatch(/RATCHET REGRESSION|STALE BASELINE/u);
    });

    it('rejects a new route that writes the slot directly, called or passed on', () => {
      const report = analyzeResourceOwnership(
        withSources((sources) => {
          sources.set(
            'src/pro-room/rogue-receiver.ts',
            "import { batchSetState, getState, setState } from '../core/state.ts';\n" +
              "import * as ownership from '../player/ownership.ts';\n" +
              "import { claimPlaybackOwner, setSystemAudioReceiving } from '../player/ownership.ts';\n" +
              'export const writers = [setSystemAudioReceiving];\n' +
              'export function attach(\n' +
              '  source: AudioNode,\n' +
              '  widener: { input: AudioNode },\n' +
              "  owner: 'system-audio' | 'youtube',\n" +
              '): void {\n' +
              '  source.connect(widener.input);\n' +
              '  ownership.setSystemAudioReceiving(true);\n' +
              "  claimPlaybackOwner('system-audio');\n" +
              '  claimPlaybackOwner(owner);\n' +
              "  claimPlaybackOwner('youtube');\n" +
              "  setState('systemAudio.isReceiving', true);\n" +
              "  batchSetState({ ['systemAudio.isReceiving']: false });\n" +
              "  void getState('systemAudio.isReceiving');\n" +
              '  // setSystemAudioReceiving(true) and widener.input in a comment do not count.\n' +
              '}\n',
          );
        }),
      );
      const findings = report.findings.join('\n');
      expect(findings).toMatch(
        /UNSANCTIONED receiving flag write \(RO-04\): src\/pro-room\/rogue-receiver\.ts has 2/u,
      );
      expect(findings).toMatch(
        /UNSANCTIONED system-audio owner claim \(RO-04\): src\/pro-room\/rogue-receiver\.ts has 2/u,
      );
      expect(findings).toMatch(
        /UNSANCTIONED widener\.input use \(RO-04\): src\/pro-room\/rogue-receiver\.ts has 1/u,
      );
      expect(findings).toMatch(
        /UNSANCTIONED raw receiving flag write \(RO-04\): src\/pro-room\/rogue-receiver\.ts has 2/u,
      );
      expect(report.receiveSlotWrites).toEqual({
        'receiving flag write': FINAL['receiving flag write'] + 2,
        'system-audio owner claim': FINAL['system-audio owner claim'] + 2,
        'widener.input use': FINAL['widener.input use'] + 1,
        'raw receiving flag write': FINAL['raw receiving flag write'] + 2,
      });
    });

    it("leaves the setter's own write in src/player/ownership.ts out of the raw count", () => {
      const findings = findingsOf(
        withSources((sources) =>
          replaceIn(
            sources,
            'src/player/ownership.ts',
            "  setState('systemAudio.isReceiving', isReceiving);\n",
            "  setState('systemAudio.isReceiving', isReceiving);\n" +
              "  setState('systemAudio.isReceiving', isReceiving);\n",
          ),
        ),
      );
      expect(findings).toBe('');
    });

    it('fails a raised count, a count that fell below its baseline and a writer that disappears', () => {
      const findings = findingsOf(
        withSources((sources) => {
          replaceIn(
            sources,
            'src/network/system-audio-receive-slot.ts',
            '  media.source.connect(widener.input);\n',
            '  media.source.connect(widener.input);\n  media.source.connect(widener.input);\n',
          );
          replaceIn(
            sources,
            'src/network/system-audio-receive-slot.ts',
            "  setSystemAudioReceiving(false);\n  if (options.deadline === 'slot') armReceiveWatchdog();\n",
            "  if (options.deadline === 'slot') armReceiveWatchdog();\n",
          );
          replaceIn(sources, 'src/network/peer.ts', "    'systemAudio.isReceiving': false,\n", '');
        }),
      );
      expect(findings).toMatch(
        /RATCHET REGRESSION widener\.input use \(RO-04\): src\/network\/system-audio-receive-slot\.ts has 2, baseline 1/u,
      );
      expect(findings).toMatch(
        /STALE BASELINE receiving flag write \(RO-04\): src\/network\/system-audio-receive-slot\.ts has 2, baseline 3 - lower the baseline to 2/u,
      );
      expect(findings).toMatch(
        /STALE BASELINE raw receiving flag write \(RO-04\): src\/network\/peer\.ts has 0 - remove its entry/u,
      );
    });
  });

  describe('CHECK 10 system-audio media tuning home (RO-04, C4-1)', () => {
    const HOME = 'src/network/system-audio-media.ts';

    it('keeps the hint, the bitrate and the STUN entry in the media home on the real tree', () => {
      const report = analyzeResourceOwnership(realInput());
      expect(report.findings).toEqual([]);
      expect(report.mediaTuningSites).toBe(3);
    });

    it('rejects a route adapter that sets them itself, however it writes them', () => {
      const findings = findingsOf(
        withSources((sources) => {
          const sfu = 'src/network/system-audio-sfu.ts';
          sources.set(
            sfu,
            `${sources.get(sfu) ?? ''}\n` +
              'export function retune(\n' +
              '  receiver: RTCRtpReceiver & { playoutDelayHint?: number },\n' +
              '  encoding: RTCRtpEncodingParameters,\n' +
              '): void {\n' +
              '  receiver.playoutDelayHint = 0.5;\n' +
              "  encoding['maxBitrate'] = 256_000;\n" +
              '  Object.assign(receiver, { playoutDelayHint: 0.5 });\n' +
              '}\n' +
              'export const ICE = [{ urls: `stun:STUN.cloudflare.com:3478` }];\n',
          );
          const direct = 'src/network/pro-system-audio-direct.ts';
          sources.set(
            direct,
            `${sources.get(direct) ?? ''}\n` +
              'const maxBitrate = 128_000;\n' +
              'export const SEND_ENCODINGS = [{ maxBitrate }];\n',
          );
        }),
      );
      expect(findings).toContain(
        'UNSANCTIONED system-audio media tuning (RO-04): src/network/system-audio-sfu.ts has 4',
      );
      expect(findings).toContain(
        'UNSANCTIONED system-audio media tuning (RO-04): ' +
          'src/network/pro-system-audio-direct.ts has 1',
      );
    });

    it('ignores reads, type members, comments and files outside the system-audio routes', () => {
      const findings = findingsOf(
        withSources((sources) => {
          const guest = 'src/network/system-audio-guest.ts';
          sources.set(
            guest,
            `${sources.get(guest) ?? ''}\n` +
              'export function readHint(\n' +
              '  receiver: RTCRtpReceiver & { playoutDelayHint?: number },\n' +
              '): number | undefined {\n' +
              '  // receiver.playoutDelayHint = 0.5 and stun.cloudflare.com in a comment.\n' +
              '  return receiver.playoutDelayHint;\n' +
              '}\n',
          );
          // The eager STUN entries live outside the deferred route files.
          const prerequisites = 'src/network/standard-room-prerequisites.ts';
          sources.set(
            prerequisites,
            `${sources.get(prerequisites) ?? ''}\n` +
              "export const EXTRA = [{ urls: 'stun:stun.cloudflare.com:3478' }];\n",
          );
        }),
      );
      expect(findings).toBe('');
    });

    it('fails a raised count in the home and a home that stops holding one of them', () => {
      const raised = findingsOf(
        withSources((sources) => {
          sources.set(
            HOME,
            `${sources.get(HOME) ?? ''}\nexport const SEND_ENCODINGS = [{ maxBitrate: 1 }];\n`,
          );
        }),
      );
      expect(raised).toContain(
        `RATCHET REGRESSION system-audio media tuning (RO-04): ${HOME} has 4, baseline 3`,
      );

      const lowered = findingsOf(
        withSources((sources) =>
          replaceIn(sources, HOME, "'stun:stun.cloudflare.com:3478'", 'TURN_ONLY'),
        ),
      );
      expect(lowered).toContain(
        `STALE BASELINE system-audio media tuning (RO-04): ${HOME} has 2, baseline 3`,
      );
    });
  });

  describe('CHECK 11 YouTube iframe audio writes (RO-12)', () => {
    it('rejects a new writer of the iframe audio, however it calls the player', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/ui/rogue-volume.ts',
            "import { getYouTubePlayer } from '../youtube/_state.ts';\n" +
              'export function duck(volume: number): void {\n' +
              '  const player = getYouTubePlayer();\n' +
              '  player?.setVolume(volume);\n' +
              '  getYouTubePlayer()?.mute?.();\n' +
              "  if (player) player['unMute']();\n" +
              '  setTimeout(() => player?.unMute(), 0);\n' +
              '}\n',
          );
        }),
      );
      expect(findings).toMatch(
        /UNSANCTIONED iframe audio write \(RO-12\): src\/ui\/rogue-volume\.ts has 4/u,
      );
    });

    it('counts a computed key that names an iframe audio method once per call', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/ui/computed-volume.ts',
            "import { getYouTubePlayer } from '../youtube/_state.ts';\n" +
              "const LOUD = 'setVolume';\n" +
              'export function apply(muted: boolean): void {\n' +
              '  const player = getYouTubePlayer();\n' +
              "  player?.[muted ? 'mute' : 'unMute']?.();\n" +
              '  player?.[LOUD](50);\n' +
              '}\n',
          );
        }),
      );
      expect(findings).toBe(
        'UNSANCTIONED iframe audio write (RO-12): src/ui/computed-volume.ts has 2 - request ' +
          "audio through youtube:set-volume or the start machines' desired-audio updates; a new " +
          'writer needs a reasoned entry and the RO-12 record update',
      );
    });

    it('ignores a local mute() function, method checks, type members and comments', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/ui/volume-mentions.ts',
            'interface Muteable {\n' +
              '  mute(): void;\n' +
              '  setVolume(volume: number): void;\n' +
              '}\n' +
              'function mute(): void {}\n' +
              'export function canMute(player: Muteable): boolean {\n' +
              '  mute();\n' +
              '  // player.mute() and player.unMute() in a comment do not count.\n' +
              "  return typeof player.mute === 'function' && !!player.setVolume;\n" +
              '}\n',
          );
        }),
      );
      expect(findings).toBe('');
    });

    it('fails a raised count in an allowlisted file and a count that fell below its baseline', () => {
      const findings = findingsOf(
        withSources((sources) => {
          replaceIn(
            sources,
            'src/youtube/iframe.ts',
            '    player.unMute?.();\n    player.playVideo();\n',
            '    player.unMute?.();\n    player.setVolume?.(100);\n    player.playVideo();\n',
          );
          replaceIn(
            sources,
            'src/youtube/retained-player-controller.ts',
            '      () => player.mute?.(),\n',
            '',
          );
        }),
      );
      expect(findings).toMatch(
        /RATCHET REGRESSION iframe audio write \(RO-12\): src\/youtube\/iframe\.ts has 4, baseline 3/u,
      );
      expect(findings).toMatch(
        /STALE BASELINE iframe audio write \(RO-12\): src\/youtube\/retained-player-controller\.ts has 1, baseline 2 - lower the baseline to 1/u,
      );
    });
  });

  describe('CHECK 12 cross-file reads and clears of the YouTube start timers (RO-02)', () => {
    it("rejects a new reader or clearer of another file's start timer", () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/youtube/rogue-start-reader.ts',
            "import { clearManagedTimer, getManagedTimer } from '../core/timers.ts';\n" +
              "import { PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER as NUDGE } from './local-offset.ts';\n" +
              "const AUTO_SYNC = 'yt-auto-sync';\n" +
              "const BUSY = ['yt-seek-play', 'yt-host-local-start'] as const;\n" +
              'export function busy(): boolean {\n' +
              '  return (\n' +
              '    getManagedTimer(AUTO_SYNC) !== null ||\n' +
              '    !!getManagedTimer(NUDGE) ||\n' +
              "    ['yt-clock-action', 'yt-rendezvous-play'].some((name) => !!getManagedTimer(name)) ||\n" +
              '    BUSY.some(getManagedTimer)\n' +
              '  );\n' +
              '}\n' +
              'export function reset(): void {\n' +
              "  clearManagedTimer('yt-zero-start-host-fallback');\n" +
              "  ['yt-rendezvous-buffer', 'yt-rendezvous-follow-up'].forEach(clearManagedTimer);\n" +
              '}\n',
          );
        }),
      );
      // A call counts once per start-timer name it covers: a name list counts each of its names.
      expect(findings).toMatch(
        /UNSANCTIONED cross-file start-timer read \(RO-02\): src\/youtube\/rogue-start-reader\.ts has 6 /u,
      );
      expect(findings).toMatch(
        /UNSANCTIONED cross-file start-timer clear \(RO-02\): src\/youtube\/rogue-start-reader\.ts has 3 /u,
      );
    });

    it('resolves names through conditionals, namespaces, re-exports, loops and derived lists', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/youtube/start-names.ts',
            "export { PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER as NUDGE } from './local-offset.ts';\n" +
              "export * from './rendezvous-names.ts';\n",
          );
          sources.set(
            'src/youtube/rendezvous-names.ts',
            "export const RENDEZVOUS = ['yt-rendezvous-play', 'yt-rendezvous-buffer'] as const;\n",
          );
          sources.set(
            'src/youtube/start-name-forms.ts',
            "import * as timers from '../core/timers.ts';\n" +
              "import { clearManagedTimer, getManagedTimer } from '../core/timers.ts';\n" +
              "import * as offsets from './local-offset.ts';\n" +
              "import { NUDGE, RENDEZVOUS } from './start-names.ts';\n" +
              "const STATE = Object.freeze(['yt-clock-action', 'yt-seek-play'] as const);\n" +
              "export function busy(host: boolean, guest?: 'yt-zero-start-host-fallback'): boolean {\n" +
              '  return (\n' +
              "    getManagedTimer(host ? 'yt-auto-sync' : 'yt-host-local-start') !== null ||\n" +
              '    getManagedTimer(offsets.PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER) !== null ||\n' +
              '    getManagedTimer(NUDGE) !== null ||\n' +
              "    getManagedTimer(guest ?? 'yt-zero-start-external-fallback') !== null ||\n" +
              "    STATE.filter((name) => name !== 'yt-seek-play').some(\n" +
              '      (name: string) => getManagedTimer(name) !== null,\n' +
              '    ) ||\n' +
              "    ['yt-rendezvous-calibrate'].some(timers.getManagedTimer) ||\n" +
              '    anyRendezvous()\n' +
              '  );\n' +
              '}\n' +
              'function anyRendezvous(): boolean {\n' +
              '  for (const name of RENDEZVOUS) if (getManagedTimer(name) !== null) return true;\n' +
              '  return false;\n' +
              '}\n' +
              'export function reset(): void {\n' +
              "  new Set(['yt-zero-start-replacement-fallback']).forEach(clearManagedTimer);\n" +
              "  [...STATE, 'yt-rendezvous-follow-up'].forEach((name) => clearManagedTimer(name));\n" +
              '}\n',
          );
        }),
      );
      // Seven reads naming eleven start timers (both sides of each conditional
      // and of '??', every name of each list) and two clears naming four, and
      // nothing the guard cannot resolve.
      expect(findings.split('\n')).toEqual([
        expect.stringMatching(
          /^UNSANCTIONED cross-file start-timer read \(RO-02\): src\/youtube\/start-name-forms\.ts has 11 - /u,
        ),
        expect.stringMatching(
          /^UNSANCTIONED cross-file start-timer clear \(RO-02\): src\/youtube\/start-name-forms\.ts has 4 - /u,
        ),
      ]);
    });

    // Since Phase 6 6A-1 hasProtectedTransitionOwner asks the owners of
    // 'yt-auto-sync' and of sync.ts's timers through owner queries and reads
    // only the PRO coordinator nudge by name.
    describe('the native-control nudge read', () => {
      const native = 'src/youtube/native-control-authority.ts';
      const read = '    getManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER) !== null ||\n';
      const names =
        '      PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER,\n' +
        "      'yt-auto-sync',\n" +
        "      'yt-clock-action',\n" +
        "      'yt-seek-play',\n" +
        "      'yt-rendezvous-buffer',\n" +
        "      'yt-rendezvous-play',\n" +
        "      'yt-rendezvous-calibrate',\n";

      // Folding the six names 6A-1 moved to owner queries back into the read
      // raises the count by six in every form: a call counts once per
      // start-timer name it covers.
      it('counts each name when it becomes a name list with an annotated callback, a loop or a frozen const', () => {
        const annotated = withSources((sources) =>
          replaceIn(
            sources,
            native,
            read,
            `    [\n${names}    ].some((name: string) => getManagedTimer(name) !== null) ||\n`,
          ),
        );
        const looped = withSources((sources) => {
          replaceIn(sources, native, read, '    anyProtectedTimer() ||\n');
          sources.set(
            native,
            `${sources.get(native) ?? ''}\nconst PROTECTED_TIMERS = [\n${names}] as const;\n` +
              'function anyProtectedTimer(): boolean {\n' +
              '  for (const name of PROTECTED_TIMERS) if (getManagedTimer(name) !== null) return true;\n' +
              '  return false;\n' +
              '}\n',
          );
        });
        const frozen = withSources((sources) => {
          replaceIn(
            sources,
            native,
            read,
            '    PROTECTED_TIMERS.some((name) => getManagedTimer(name) !== null) ||\n',
          );
          sources.set(
            native,
            `${sources.get(native) ?? ''}\nconst PROTECTED_TIMERS = Object.freeze([\n${names}]);\n`,
          );
        });
        for (const input of [annotated, looped, frozen]) {
          expect(findingsOf(input)).toBe(
            'RATCHET REGRESSION cross-file start-timer read (RO-02): ' +
              "src/youtube/native-control-authority.ts has 7, baseline 1 - ask the timer's owner " +
              '(the file that sets it) through an owner query instead',
          );
          expect(analyzeResourceOwnership(input).startTimerUses).toEqual({ reads: 17, clears: 9 });
        }
      });

      it('rejects a timer query that takes any name, which would hide the read', () => {
        const findings = findingsOf(
          withSources((sources) => {
            replaceIn(
              sources,
              native,
              read,
              '    isYouTubeTimerPending(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER) ||\n',
            );
            sources.set(
              'src/youtube/sync.ts',
              `${sources.get('src/youtube/sync.ts') ?? ''}\n` +
                'export function isYouTubeTimerPending(name: string): boolean {\n' +
                '  return getManagedTimer(name) !== null;\n' +
                '}\n',
            );
          }),
        );
        expect(findings).toMatch(
          /UNRESOLVED TIMER NAME \(RO-02\): src\/youtube\/sync\.ts:\d+ getManagedTimer\(\) in isYouTubeTimerPending - /u,
        );
        expect(findings).toContain(
          'STALE BASELINE cross-file start-timer read (RO-02): src/youtube/native-control-authority.ts has 0',
        );
      });
    });

    it("counts a start timer folded into iframe.ts's nudge read as a second read", () => {
      const findings = findingsOf(
        withSources((sources) =>
          replaceIn(
            sources,
            'src/youtube/iframe.ts',
            '!!getManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER);',
            "[PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER, 'yt-auto-sync'].some(\n" +
              '    (name) => getManagedTimer(name) !== null,\n' +
              '  );',
          ),
        ),
      );
      expect(findings).toMatch(
        /^RATCHET REGRESSION cross-file start-timer read \(RO-02\): src\/youtube\/iframe\.ts has 2, baseline 1 - /u,
      );
    });

    it("does not count a file's own timers as cross-file, and rejects that file as their second setter", () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/youtube/own-start-timers.ts',
            "import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../core/timers.ts';\n" +
              "import { PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER } from './local-offset.ts';\n" +
              "const FOLLOW_UP = 'yt-rendezvous-follow-up';\n" +
              "function arm(name: 'yt-clock-action' | 'yt-seek-play', run: () => void): void {\n" +
              '  setManagedTimer(name, run, 10);\n' +
              '}\n' +
              'export function start(run: () => void): void {\n' +
              "  setManagedTimer('yt-auto-sync', run, 10);\n" +
              '  setManagedTimer(FOLLOW_UP, run, 10);\n' +
              '  setManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER, run, 10);\n' +
              "  arm('yt-clock-action', run);\n" +
              '}\n' +
              'export function busy(): boolean {\n' +
              "  return ['yt-auto-sync', FOLLOW_UP, 'yt-seek-play', PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER].some(\n" +
              '    (name) => getManagedTimer(name) !== null,\n' +
              '  );\n' +
              '}\n' +
              'export function stop(): void {\n' +
              "  clearManagedTimer('yt-clock-action');\n" +
              '  clearManagedTimer(FOLLOW_UP);\n' +
              '  clearManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER);\n' +
              '}\n',
          );
        }),
      );
      // Each name resolves (literal, const, imported const, literal-union
      // parameter), so no read or clear counts; setting them is a second machine.
      const setters: readonly (readonly [string, string])[] = [
        ['yt-auto-sync', 'src/youtube/player.ts'],
        ['yt-clock-action', 'src/youtube/sync.ts'],
        [
          'yt-pro-coordinator-local-nudge',
          'src/youtube/standard-host-manual-offset-gate.ts and ' +
            'src/youtube/standard-host-manual-offset-runtime.ts',
        ],
        ['yt-rendezvous-follow-up', 'src/youtube/sync.ts'],
        ['yt-seek-play', 'src/youtube/sync.ts'],
      ];
      expect(findings.split('\n').sort()).toEqual(
        setters.map(
          ([name, owner]) =>
            `START TIMER SET (RO-02): src/youtube/own-start-timers.ts sets '${name}', which ` +
            `only ${owner} may set - setManagedTimer() clears a running timer of that name, so a ` +
            'second setter is a second machine on the start: start it through its owner, or ' +
            'move the setter and update START_TIMER_SETTERS and the RO-02 record in the same change',
        ),
      );
    });

    it('rejects a second setter of a start timer in a file that reads it', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/youtube/iframe.ts',
            `${sources.get('src/youtube/iframe.ts') ?? ''}\n` +
              'export function rearmAutoSync(run: () => void): void {\n' +
              "  setManagedTimer('yt-auto-sync', run, 0);\n" +
              '}\n',
          );
        }),
      );
      expect(findings).toContain(
        "START TIMER SET (RO-02): src/youtube/iframe.ts sets 'yt-auto-sync', which only " +
          'src/youtube/player.ts may set - ',
      );
      // The clear of 'yt-auto-sync' now looks like iframe.ts's own. iframe.ts
      // reads only the PRO coordinator nudge by name, so its read count stays.
      expect(findings).toContain(
        'STALE BASELINE cross-file start-timer clear (RO-02): src/youtube/iframe.ts has 1, baseline 2',
      );
      expect(findings).not.toContain('cross-file start-timer read (RO-02): src/youtube/iframe.ts');
    });

    it('ignores other timers, names that cannot spell a start timer and files outside src/youtube', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/youtube/other-timers.ts',
            "import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../core/timers.ts';\n" +
              'export function reset(peerId: string, run: () => void): boolean {\n' +
              "  clearManagedTimer('yt-guest-ended-fallback');\n" +
              '  setManagedTimer(`yt-snapshot-retry-${peerId}`, run, 10);\n' +
              "  clearManagedTimer('yt-late-join-rendezvous-' + peerId);\n" +
              "  // getManagedTimer('yt-auto-sync') in a comment does not count.\n" +
              "  return getManagedTimer('youtubeSyncLoop') !== null;\n" +
              '}\n',
          );
          sources.set(
            'src/player/start-timer-reader.ts',
            "import { getManagedTimer } from '../core/timers.ts';\n" +
              "export const busy = (): boolean => getManagedTimer('yt-auto-sync') !== null;\n",
          );
        }),
      );
      expect(findings).toBe('');
    });

    it('rejects every timer call in src/youtube whose name it cannot resolve', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/youtube/unresolved-timers.ts',
            "import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../core/timers.ts';\n" +
              'const pending = (name: string): boolean => getManagedTimer(name) !== null;\n' +
              'export function reset(name: string, peerId: string, run: () => void): void {\n' +
              '  clearManagedTimer(name);\n' +
              '  clearManagedTimer(`yt-auto-${peerId}`);\n' +
              "  ['yt-guest-ended-fallback', name].forEach(clearManagedTimer);\n" +
              '  setManagedTimer(name, run, 10);\n' +
              '}\n' +
              'export function busy(names: readonly string[], flag: boolean, name: string): boolean {\n' +
              "  let fallback = 'yt-guest-ended-fallback';\n" +
              "  if (flag) fallback = 'yt-auto-sync';\n" +
              '  return (\n' +
              '    names.some(getManagedTimer) ||\n' +
              '    getManagedTimer(fallback) !== null ||\n' +
              "    getManagedTimer(flag ? 'yt-guest-ended-fallback' : name) !== null ||\n" +
              "    pending('yt-auto-sync')\n" +
              '  );\n' +
              '}\n',
          );
        }),
      );
      const site = (line: number, call: string, inFunction: string): string =>
        `UNRESOLVED TIMER NAME (RO-02): src/youtube/unresolved-timers.ts:${line} ${call}() in ` +
        `${inFunction} - CHECK 12 cannot tell whether this is a start timer: name it with a ` +
        'string literal, a literal const or a parameter annotated with a literal union';
      // A parameter typed string, a template that can spell 'yt-auto-sync', a list
      // with such a name, a let and a conditional with such a branch; a setter too.
      expect(findings.split('\n')).toEqual([
        site(2, 'getManagedTimer', 'pending'),
        site(4, 'clearManagedTimer', 'reset'),
        site(5, 'clearManagedTimer', 'reset'),
        site(6, 'clearManagedTimer', 'reset'),
        site(7, 'setManagedTimer', 'reset'),
        site(13, 'getManagedTimer', 'busy'),
        site(14, 'getManagedTimer', 'busy'),
        site(15, 'getManagedTimer', 'busy'),
      ]);
    });

    it('rejects another name for the timer functions, under which calls would not show', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/youtube/timer-aliases.ts',
            "import * as timers from '../core/timers.ts';\n" +
              "import { getManagedTimer as peek, clearManagedTimer, setManagedTimer } from '../core/timers.ts';\n" +
              "export { clearManagedTimer as stopTimer } from '../core/timers.ts';\n" +
              'declare function register(fn: unknown): void;\n' +
              'const { getManagedTimer: look } = timers;\n' +
              'export const ports = { clearManagedTimer };\n' +
              'type Query = typeof timers.getManagedTimer;\n' +
              'interface Port {\n' +
              '  getManagedTimer(name: string): unknown;\n' +
              '  query: Query;\n' +
              '}\n' +
              'export function wire(port: Port): boolean {\n' +
              '  register(setManagedTimer);\n' +
              "  port.getManagedTimer('yt-guest-ended-fallback');\n" +
              '  return (\n' +
              "    peek('yt-auto-sync') !== null ||\n" +
              "    look('yt-seek-play') !== null ||\n" +
              "    ['yt-guest-ended-fallback'].some(timers.getManagedTimer)\n" +
              '  );\n' +
              '}\n',
          );
        }),
      );
      const alias = (line: number, what: string, inFunction: string): string =>
        `TIMER FUNCTION ALIAS (RO-02): src/youtube/timer-aliases.ts:${line} ${what} in ` +
        `${inFunction} - call getManagedTimer(), clearManagedTimer() and setManagedTimer() by ` +
        "their own names (a query or a clear may go straight to a name list's method), so " +
        'CHECK 12 sees every call';
      // The type query, the interface member, a port's method and the query
      // handed to a name list's method are not aliases.
      expect(findings.split('\n')).toEqual([
        alias(2, 'getManagedTimer imported as peek', '<module>'),
        alias(3, 'clearManagedTimer exported as stopTimer', '<module>'),
        alias(5, 'getManagedTimer destructured as look', '<module>'),
        alias(6, 'clearManagedTimer used as a value', '<module>'),
        alias(13, 'setManagedTimer used as a value', 'wire'),
      ]);
    });

    it("resolves the literal-union parameter that sets sync.ts's state-action timers", () => {
      // Without it, sync.ts's own reads and clears of 'yt-clock-action' and
      // 'yt-seek-play' would count as another file's.
      const findings = findingsOf(
        withSources((sources) =>
          replaceIn(
            sources,
            'src/youtube/sync.ts',
            "  name: 'yt-clock-action' | 'yt-seek-play',\n",
            '  name: string,\n',
          ),
        ),
      );
      expect(findings).toMatch(
        /RATCHET REGRESSION cross-file start-timer read \(RO-02\): src\/youtube\/sync\.ts has \d+, baseline 3/u,
      );
      expect(findings).toMatch(
        /RATCHET REGRESSION cross-file start-timer clear \(RO-02\): src\/youtube\/sync\.ts has \d+, baseline 1/u,
      );
      expect(findings).toMatch(
        /UNRESOLVED TIMER NAME \(RO-02\): src\/youtube\/sync\.ts:\d+ setManagedTimer\(\) in setStateActionTimer - /u,
      );
      expect(findings).toContain(
        "START TIMER SET (RO-02): 'yt-clock-action' is not set by src/youtube/sync.ts any more",
      );
      expect(findings).toContain(
        "START TIMER SET (RO-02): 'yt-seek-play' is not set by src/youtube/sync.ts any more",
      );
    });

    it('fails a raised count, a count that fell below its baseline and a start timer no file sets', () => {
      const findings = findingsOf(
        withSources((sources) => {
          // resetYouTubeSyncState, which this reset calls next, clears it already.
          replaceIn(
            sources,
            'src/youtube/iframe.ts',
            "  clearManagedTimer('yt-seek-play');\n  clearManagedTimer('yt-auto-sync');\n",
            "  clearManagedTimer('yt-auto-sync');\n",
          );
          replaceIn(
            sources,
            'src/youtube/sync.ts',
            '  if (!isManual && getManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER)) return;\n',
            '  if (!isManual && getManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER)) return;\n' +
              "  if (getManagedTimer('yt-host-local-start')) return;\n",
          );
          replaceIn(
            sources,
            'src/youtube/player.ts',
            "        'yt-host-local-start',\n",
            "        'yt-host-local-begin',\n",
          );
        }),
      );
      expect(findings).toMatch(
        /STALE BASELINE cross-file start-timer clear \(RO-02\): src\/youtube\/iframe\.ts has 1, baseline 2 - lower the baseline to 1/u,
      );
      expect(findings).toMatch(
        /RATCHET REGRESSION cross-file start-timer read \(RO-02\): src\/youtube\/sync\.ts has 4, baseline 3/u,
      );
      // player.ts no longer sets the local-start timer, so its own clear counts.
      expect(findings).toMatch(
        /RATCHET REGRESSION cross-file start-timer clear \(RO-02\): src\/youtube\/player\.ts has 7, baseline 6/u,
      );
      expect(findings).toContain(
        "START TIMER SET (RO-02): 'yt-host-local-start' is not set by src/youtube/player.ts any more",
      );
    });

    it('lists each counted CHECK 11 and CHECK 12 site with its function under --report', () => {
      const result = runGuard('--report');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(
        /iframe audio write: src\/youtube\/iframe\.ts:\d+ unMute\(\) in primeYouTubePlayer\n/u,
      );
      expect(result.stdout).toMatch(
        /iframe audio write: src\/youtube\/iframe-audio\.ts:\d+ setVolume\(\) in writeYouTubeAudio\n/u,
      );
      expect(result.stdout).toMatch(
        /cross-file start-timer read: src\/youtube\/native-control-authority\.ts:\d+ getManagedTimer\('yt-pro-coordinator-local-nudge'\) in hasProtectedTransitionOwner\n/u,
      );
      expect(result.stdout).toMatch(
        /cross-file start-timer clear: src\/youtube\/sync\.ts:\d+ clearManagedTimer\('yt-pro-coordinator-local-nudge'\) in resetYouTubeSyncState\n/u,
      );
    });
  });
});
