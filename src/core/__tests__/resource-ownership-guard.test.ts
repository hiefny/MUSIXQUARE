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
      // A name list counts once per call, like the native-control list of seven.
      expect(findings).toMatch(
        /UNSANCTIONED cross-file start-timer read \(RO-02\): src\/youtube\/rogue-start-reader\.ts has 4/u,
      );
      expect(findings).toMatch(
        /UNSANCTIONED cross-file start-timer clear \(RO-02\): src\/youtube\/rogue-start-reader\.ts has 2/u,
      );
    });

    it("does not count a file's own timers, set by a literal, a const or a literal-union parameter", () => {
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
      expect(findings).toBe('');
    });

    it('ignores other timers, names it cannot resolve and files outside src/youtube', () => {
      const findings = findingsOf(
        withSources((sources) => {
          sources.set(
            'src/youtube/other-timers.ts',
            "import { clearManagedTimer, getManagedTimer } from '../core/timers.ts';\n" +
              'export function reset(peerId: string, name: string): boolean {\n' +
              "  clearManagedTimer('yt-guest-ended-fallback');\n" +
              '  clearManagedTimer(`yt-auto-${peerId}`);\n' +
              '  clearManagedTimer(name);\n' +
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
        /RATCHET REGRESSION cross-file start-timer read \(RO-02\): src\/youtube\/sync\.ts has \d+, baseline 4/u,
      );
      expect(findings).toMatch(
        /RATCHET REGRESSION cross-file start-timer clear \(RO-02\): src\/youtube\/sync\.ts has \d+, baseline 1/u,
      );
      expect(findings).toContain("START TIMER SET (RO-02): 'yt-clock-action' is not set");
      expect(findings).toContain("START TIMER SET (RO-02): 'yt-seek-play' is not set");
    });

    it('fails a raised count, a count that fell below its baseline and a start timer no file sets', () => {
      const findings = findingsOf(
        withSources((sources) => {
          // resetYouTubeSyncState, which this reset calls next, clears both already.
          replaceIn(
            sources,
            'src/youtube/iframe.ts',
            "  clearManagedTimer('yt-clock-action');\n  clearManagedTimer('yt-seek-play');\n",
            '',
          );
          replaceIn(
            sources,
            'src/youtube/sync.ts',
            "  if (!isManual && getManagedTimer('yt-auto-sync')) return;\n",
            "  if (!isManual && getManagedTimer('yt-auto-sync')) return;\n" +
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
        /STALE BASELINE cross-file start-timer clear \(RO-02\): src\/youtube\/iframe\.ts has 1, baseline 3 - lower the baseline to 1/u,
      );
      expect(findings).toMatch(
        /RATCHET REGRESSION cross-file start-timer read \(RO-02\): src\/youtube\/sync\.ts has 5, baseline 4/u,
      );
      // player.ts no longer sets the local-start timer, so its own clear counts.
      expect(findings).toMatch(
        /RATCHET REGRESSION cross-file start-timer clear \(RO-02\): src\/youtube\/player\.ts has 7, baseline 6/u,
      );
      expect(findings).toContain("START TIMER SET (RO-02): 'yt-host-local-start' is not set");
    });

    it('lists each counted CHECK 11 and CHECK 12 site with its function under --report', () => {
      const result = runGuard('--report');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(
        /iframe audio write: src\/youtube\/iframe\.ts:\d+ unMute\(\) in primeYouTubePlayer\n/u,
      );
      expect(result.stdout).toMatch(
        /iframe audio write: src\/youtube\/player\.ts:\d+ setVolume\(\) in restoreFallbackAudio\n/u,
      );
      expect(result.stdout).toMatch(
        /cross-file start-timer read: src\/youtube\/native-control-authority\.ts:\d+ getManagedTimer\('yt-pro-coordinator-local-nudge', 'yt-auto-sync', [^)]*\) in hasProtectedTransitionOwner\n/u,
      );
      expect(result.stdout).toMatch(
        /cross-file start-timer clear: src\/youtube\/sync\.ts:\d+ clearManagedTimer\('yt-pro-coordinator-local-nudge'\) in resetYouTubeSyncState\n/u,
      );
    });
  });
});
