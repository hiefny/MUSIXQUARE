/**
 * @vitest-environment jsdom
 */
/**
 * The AUDIO RECOVERY block of `/debug sync` (Phase 7 7A-1, owner decisions
 * Q3 (a), Q3 (b) and Q4; the text the owner approved on 2026-11-02): where it
 * sits, what each line says, that building the text touches no storage and
 * no network, and that the previous page's totals stay on their own line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => ({
  ready: false,
  context: null as unknown,
}));

vi.mock('../../audio/engine.ts', () => ({
  isAudioReady: () => audio.ready,
  getAudioContext: () => audio.context,
}));
vi.mock('../../player/transport.ts', () => ({
  peekTrackPosition: () => 0,
  getPlayLockSnapshot: () => ({
    locked: false,
    consistent: true,
    generation: null,
    ageMs: null,
    phase: null,
    phaseAgeMs: null,
    pending: false,
    watchdogArmed: false,
  }),
}));
vi.mock('../../player/_state.ts', () => ({
  getCurrentAudioBuffer: () => null,
  getPlayerNode: () => null,
}));
vi.mock('../../network/shared-clock.ts', () => ({
  getHostNow: () => 0,
  getSharedClockDiagnostics: () => ({}),
}));
vi.mock('../../pro-room/network-bridge.ts', () => ({
  getProRoomServerNow: () => 0,
  getProRoomServerClockDiagnostics: () => ({}),
}));

const KEY = 'mxqr-prev-audio-recovery';

/** The ten head lines, unchanged by 7A-1 (the third is the owner's version line). */
const HEAD = [
  'MUSIXQUARE SYNC FLIGHT RECORDER v1',
  /^Generated: /u,
  'Client build: app=9.0.37 | cacheEpoch=v810 (embedded JS build; active service worker not inspected)',
  /^Retention: RAM-only, 1200s max \| samples:\d+ events:\d+ proStarts:0 standardClock:0 standardStarts:0$/u,
  'Privacy: no room code, peer id, nickname, title, filename, or raw queue id',
  'SAMPLES logicalDriftMs: positive = canonical timeline is ahead of local logical position',
  'PRO START timelineDriftMs: positive = local YouTube canonical position is ahead of the predicted timeline',
  'STANDARD START timelineDriftMs: positive = local YouTube position is ahead of the host prediction after manual offset',
  'STANDARD CLOCK sentAtMs/wallElapsedMs use the current rebased clock; rawSentAtMs/rawWallElapsedMs retain the original ping send time',
  'STANDARD START clockMapping: wall time minus monotonic time; deltas are sample minus release, spans cover plan/schedule/release/sample',
];

/** The approved picture's nine lines (q34-inserted-text.txt), Chromium 146+ and after a reload. */
const APPROVED = [
  'AUDIO RECOVERY (this page, on device, not sent)',
  'Resume attempts: 5 | playRequest:1 playGesture:0 dialog:1 auto:2 ensureRunning:0 probe:1 retire:0 uiSound:0',
  'Deadline fires: 1 | gestureFlow1s:1 (12 races watched)',
  'Time awaiting clock verification: totalMs:640 maxMs:410 | waits:3 confirmed:2 cancelled:0 recoveryNeeded:1',
  'Suspend calls: 1 | second suspends:0 | re-suspended after running:0',
  'Recovery dialog requests: 1 | play:0 return:1 | audio-context-recovered rejoins:1 | taps refused:0',
  'Leases at once (max): 1 | UI sound resumes while waiting for tap: 0',
  'Chrome output underruns: 3 (playbackStats.underrunEvents, read when opened)',
  'Previous page: this tab sessionStorage | app=9.0.34 | resume attempts:4 deadline fires:2 clock wait totalMs:2310 maxMs:1500 dialog requests:1',
];
const UNDERRUN_NONE = 'Chrome output underruns: none (not reported by this browser)';

type Counters = typeof import('../../audio/output-recovery-counters.ts');
type SlotName = {
  [K in keyof Counters]: Counters[K] extends number ? K : never;
}[keyof Counters];

/** A kept value as a page of `build` writes it: every slot, the given ones set. */
function kept(
  c: Counters,
  build: string,
  set: Partial<Record<SlotName, number>>,
  labelSet: number = c.AUDIO_RECOVERY_LABEL_SET,
): string {
  const slots = new Array<number>(c.AUDIO_RECOVERY_SLOTS).fill(0);
  for (const [name, value] of Object.entries(set)) slots[c[name as SlotName]] = value!;
  return `${labelSet} ${build} ${slots.join(' ')}`;
}

/** The approved picture's previous page: 4 resumes, 2 fires, 2310 / 1500 ms, 1 request. */
const APPROVED_PREVIOUS: Partial<Record<SlotName, number>> = {
  RESUME_AUTO: 3,
  RESUME_DIALOG: 1,
  DEADLINE_GESTURE_FLOW: 1,
  DEADLINE_AUTO_RESUME: 1,
  DEADLINES_WATCHED: 9,
  CLOCK_WAITS: 2,
  CLOCK_CONFIRMED: 1,
  CLOCK_RECOVERY_NEEDED: 1,
  CLOCK_WAIT_TOTAL_MS: 2_310.4,
  CLOCK_WAIT_MAX_MS: 1_500.2,
  DIALOG_REQUESTS_RETURN: 1,
};

async function loadPage() {
  vi.resetModules();
  const [recorder, counters] = await Promise.all([
    import('../sync-flight-recorder.ts'),
    import('../../audio/output-recovery-counters.ts'),
  ]);
  return { recorder, counters };
}

function navigation(type: string): void {
  Object.defineProperty(performance, 'getEntriesByType', {
    configurable: true,
    value: (entryType: string) => (entryType === 'navigation' ? [{ type }] : []),
  });
}

function expectHead(lines: readonly string[]): void {
  HEAD.forEach((expected, index) => {
    if (typeof expected === 'string') expect(lines[index]).toBe(expected);
    else expect(lines[index]).toMatch(expected);
  });
}

beforeEach(() => {
  audio.ready = false;
  audio.context = null;
  sessionStorage.clear();
  vi.stubGlobal('__MXQR_APP_VERSION__', '9.0.37');
  vi.stubGlobal('__MXQR_BUILD_CACHE_VERSION__', 'v810');
  navigation('navigate');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(performance, 'getEntriesByType');
  sessionStorage.clear();
});

describe('the /debug sync AUDIO RECOVERY block', () => {
  it('sits right after the ten head lines and before EVENTS JSONL; a fresh page shows zeros', async () => {
    const { recorder } = await loadPage();
    const lines = recorder.collectSyncFlightRecorderText().split('\n');
    expectHead(lines);
    expect(lines.slice(10, 20)).toEqual([
      'AUDIO RECOVERY (this page, on device, not sent)',
      'Resume attempts: 0 | playRequest:0 playGesture:0 dialog:0 auto:0 ensureRunning:0 probe:0 retire:0 uiSound:0',
      'Deadline fires: 0 (0 races watched)',
      'Time awaiting clock verification: totalMs:0 maxMs:0 | waits:0 confirmed:0 cancelled:0 recoveryNeeded:0',
      'Suspend calls: 0 | second suspends:0 | re-suspended after running:0',
      'Recovery dialog requests: 0 | play:0 return:0 | audio-context-recovered rejoins:0 | taps refused:0',
      'Leases at once (max): 0 | UI sound resumes while waiting for tap: 0',
      UNDERRUN_NONE,
      '',
      'EVENTS JSONL',
    ]);
  });

  it('reads exactly as the approved picture for the same counts', async () => {
    navigation('reload');
    const { recorder, counters: c } = await loadPage();
    sessionStorage.setItem(KEY, kept(c, '9.0.34', APPROVED_PREVIOUS));
    c.takeAudioRecoveryFromPreviousPage();
    c.countAudioRecovery(c.RESUME_PLAY_REQUEST);
    c.countAudioRecovery(c.RESUME_DIALOG);
    c.countAudioRecovery(c.RESUME_AUTO);
    c.countAudioRecovery(c.RESUME_AUTO);
    c.countAudioRecovery(c.RESUME_PROBE);
    c.countAudioRecovery(c.DEADLINE_GESTURE_FLOW);
    for (let race = 0; race < 12; race += 1) c.countAudioRecovery(c.DEADLINES_WATCHED);
    const now = vi.spyOn(performance, 'now');
    for (const [enterAt, leaveAt, to] of [
      [1_000, 1_410, 'completed'],
      [2_000, 2_130, 'completed'],
      [3_000, 3_100, 'preparing-suspend'],
    ] as const) {
      const attempt = {};
      now.mockReturnValueOnce(enterAt);
      c.countAudioRecoveryPhase(attempt, 'gesture-resuming', 'awaiting-clock-verification');
      now.mockReturnValueOnce(leaveAt);
      c.countAudioRecoveryPhase(attempt, 'awaiting-clock-verification', to);
    }
    now.mockRestore();
    c.registerAudioRecoveryOwner(
      () => false,
      () => 1,
    );
    c.countAudioSuspend({} as AudioContext, 1);
    c.countAudioRecovery(c.DIALOG_REQUESTS_RETURN);
    c.countAudioRecovery(c.CONTEXT_RECOVERED_REJOINS);

    const lines = recorder.collectSyncFlightRecorderText(3).split('\n');
    expectHead(lines);
    expect(lines.slice(10, 19)).toEqual(APPROVED);
    expect(lines.slice(19, 21)).toEqual(['', 'EVENTS JSONL']);
  });

  it('says none where the browser reports no underruns, and shows no previous page without a reload', async () => {
    const { recorder, counters } = await loadPage();
    sessionStorage.setItem(KEY, kept(counters, '9.0.34', APPROVED_PREVIOUS));
    counters.takeAudioRecoveryFromPreviousPage();
    const lines = recorder.collectSyncFlightRecorderText(null).split('\n');
    expect(lines[17]).toBe(UNDERRUN_NONE);
    expect(lines.slice(18, 20)).toEqual(['', 'EVENTS JSONL']);
    expect(lines.some((line) => line.startsWith('Previous page:'))).toBe(false);
  });

  it('lists every deadline that fired, by name, in a fixed order', async () => {
    const { recorder, counters: c } = await loadPage();
    c.countAudioRecovery(c.DEADLINE_CLOCK_REQUIREMENT);
    c.countAudioRecovery(c.DEADLINE_PLAY_REQUEST_PREPARE);
    c.countAudioRecovery(c.DEADLINE_LATE_SUSPEND_FENCE);
    c.countAudioRecovery(c.DEADLINE_LATE_SUSPEND_FENCE);
    c.countAudioRecovery(c.DEADLINE_AUTO_RESUME);
    expect(recorder.collectSyncFlightRecorderText().split('\n')[12]).toBe(
      'Deadline fires: 5 | playRequestPrepare500ms:1 lateSuspendFence250ms:2 autoResume750ms:1 clockRequirement5s:1 (0 races watched)',
    );
  });

  it("keeps another build's previous page on its own line with that build", async () => {
    navigation('reload');
    const { recorder, counters: c } = await loadPage();
    sessionStorage.setItem(
      KEY,
      kept(c, '9.0.36', { RESUME_PROBE: 7, DIALOG_REQUESTS_PLAY: 1, DIALOG_REQUESTS_RETURN: 1 }),
    );
    c.takeAudioRecoveryFromPreviousPage();
    c.countAudioRecovery(c.RESUME_AUTO);
    const lines = recorder.collectSyncFlightRecorderText(null).split('\n');
    expect(lines[11]).toBe(
      'Resume attempts: 1 | playRequest:0 playGesture:0 dialog:0 auto:1 ensureRunning:0 probe:0 retire:0 uiSound:0',
    );
    expect(lines[18]).toBe(
      'Previous page: this tab sessionStorage | app=9.0.36 | resume attempts:7 deadline fires:0 clock wait totalMs:0 maxMs:0 dialog requests:2',
    );
    expect(lines[2]).toContain('app=9.0.37');
  });

  it('builds the text with no storage call, no network request and no service-worker read', async () => {
    navigation('reload');
    const { recorder, counters } = await loadPage();
    sessionStorage.setItem(KEY, kept(counters, '9.0.34', APPROVED_PREVIOUS));
    counters.takeAudioRecoveryFromPreviousPage();
    const storage = (['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const).map((name) =>
      vi.spyOn(Storage.prototype, name),
    );
    const fetch = vi.spyOn(globalThis, 'fetch');
    const beacon = vi.fn();
    vi.stubGlobal('navigator', {
      sendBeacon: beacon,
      get serviceWorker() {
        throw new Error('Diagnostics must not inspect a service worker');
      },
    });

    const text = recorder.collectSyncFlightRecorderText(2);
    recorder.collectSyncFlightRecorderText(2);

    expect(text).toContain('Previous page: this tab sessionStorage | app=9.0.34');
    for (const spy of storage) expect(spy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });
});

describe('a previous page value it cannot read is not shown', () => {
  it.each<[string, (c: Counters) => string]>([
    ['another label set', (c) => kept(c, '9.0.37', { RESUME_AUTO: 1 }, 2)],
    ['a missing slot', (c) => kept(c, '9.0.37', { RESUME_AUTO: 1 }).replace(/ 0$/u, '')],
    ['an extra slot', (c) => `${kept(c, '9.0.37', { RESUME_AUTO: 1 })} 0`],
    ['a negative count', (c) => kept(c, '9.0.37', { RESUME_AUTO: -1 })],
    ['an empty field', (c) => kept(c, '9.0.37', { RESUME_AUTO: 1 }).replace(' 0 ', '  ')],
    ['a word for a count', (c) => kept(c, '9.0.37', { RESUME_AUTO: 1 }).replace(' 0 ', ' x ')],
    ['an endless count', (c) => kept(c, '9.0.37', { RESUME_AUTO: Number.POSITIVE_INFINITY })],
    ['no build', (c) => kept(c, '', { RESUME_AUTO: 1 })],
    ['a build longer than 40 characters', (c) => kept(c, 'v'.repeat(41), { RESUME_AUTO: 1 })],
    ['an empty value', () => ''],
  ])('%s', async (_label, value) => {
    navigation('reload');
    const { recorder, counters } = await loadPage();
    sessionStorage.setItem(KEY, value(counters));
    counters.takeAudioRecoveryFromPreviousPage();
    const text = recorder.collectSyncFlightRecorderText(null);
    expect(text).not.toContain('Previous page:');
    expect(text.split('\n').slice(17, 19)).toEqual([UNDERRUN_NONE, '']);
  });
});

describe('Chrome output underruns (owner decision Q3 b)', () => {
  it.each([
    ['Chromium 146 and later', { playbackStats: { underrunEvents: 4 } }, 4],
    ['no underruns yet', { playbackStats: { underrunEvents: 0 } }, 0],
    ['a browser without playbackStats', {}, null],
    ['a value that is not a count', { playbackStats: { underrunEvents: Number.NaN } }, null],
    [
      'a getter that throws',
      Object.defineProperty({}, 'playbackStats', {
        get() {
          throw new DOMException('closed', 'InvalidStateError');
        },
      }),
      null,
    ],
  ])('%s', async (_label, context, expected) => {
    audio.ready = true;
    audio.context = context;
    const { recorder } = await loadPage();
    expect(recorder.readChromeOutputUnderruns()).toBe(expected);
  });

  it('reads nothing before the audio engine exists', async () => {
    audio.context = { playbackStats: { underrunEvents: 4 } };
    const { recorder } = await loadPage();
    expect(recorder.readChromeOutputUnderruns()).toBeNull();
  });
});
