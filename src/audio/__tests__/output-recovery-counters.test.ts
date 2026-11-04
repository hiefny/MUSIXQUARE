/**
 * @vitest-environment jsdom
 */
/**
 * The audio output recovery counts (Phase 7 7A-1, owner decisions Q3 and Q4):
 * the leaf's own rules, and the previous page's counts across a same-tab
 * reload in the form of src/network/__tests__/last-link-close.test.ts.
 * Owner scenes that drive each count through the real owners are in
 * audio-output-recovery-counts.test.ts; the window text, which parses the
 * kept value, is in src/diagnostics/__tests__/sync-flight-recorder-audio-recovery.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'mxqr-prev-audio-recovery';

type Counters = typeof import('../output-recovery-counters.ts');

/** A fresh page: the leaf keeps this page's counts in memory only. */
async function loadPage(): Promise<Counters> {
  vi.resetModules();
  return import('../output-recovery-counters.ts');
}

function slots(page: Counters): readonly number[] {
  return page.readAudioRecoveryCounts()[0];
}

function previous(page: Counters): string | null {
  return page.readAudioRecoveryCounts()[1];
}

/** This document's navigation type, as PerformanceNavigationTiming reports it. */
function navigation(type: string | null): void {
  Object.defineProperty(performance, 'getEntriesByType', {
    configurable: true,
    value: (entryType: string) => (entryType === 'navigation' && type ? [{ type }] : []),
  });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('__MXQR_APP_VERSION__', '9.0.37');
  navigation('reload');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(performance, 'getEntriesByType');
  sessionStorage.clear();
});

describe('deadline races', () => {
  it('counts a deadline only when its timer settles before the flight', async () => {
    const page = await loadPage();
    const timerWins = { flight: deferred(), timer: deferred() };
    const flightWins = { flight: deferred(), timer: deferred() };
    const first = page.raceAudioRecoveryDeadline(
      page.DEADLINE_ENSURE_RUNNING,
      timerWins.flight.promise,
      timerWins.timer.promise.then(() => 'deadline'),
    );
    const second = page.raceAudioRecoveryDeadline(
      page.DEADLINE_PROBE,
      flightWins.flight.promise.then(() => 'flight'),
      flightWins.timer.promise,
    );

    timerWins.timer.resolve();
    flightWins.flight.resolve();
    await settle();
    timerWins.flight.resolve();
    flightWins.timer.resolve();
    await settle();

    await expect(first).resolves.toBe('deadline');
    await expect(second).resolves.toBe('flight');
    const counts = slots(page);
    expect([
      counts[page.DEADLINE_ENSURE_RUNNING],
      counts[page.DEADLINE_PROBE],
      counts[page.DEADLINES_WATCHED],
    ]).toEqual([1, 0, 2]);
  });

  it('settles as Promise.race of the same two promises, a rejecting flight included', async () => {
    const page = await loadPage();
    const flight = deferred();
    const timer = deferred();
    const race = page.raceAudioRecoveryDeadline(
      page.DEADLINE_AUTO_RESUME,
      flight.promise,
      timer.promise,
    );
    const error = new Error('resume() rejected');
    flight.reject(error);
    await expect(race).rejects.toBe(error);
    timer.resolve();
    await settle();
    // A flight that settles first, even by rejecting, leaves the deadline alone.
    expect(slots(page)[page.DEADLINE_AUTO_RESUME]).toBe(0);
  });

  it('takes a test double that returns no promise, as Promise.race does', async () => {
    const page = await loadPage();
    const flight = deferred();
    const race = page.raceAudioRecoveryDeadline(
      page.DEADLINE_SCOPE_PREPARE,
      flight.promise,
      undefined as unknown as Promise<void>,
    );
    await expect(race).resolves.toBeUndefined();
    await settle();
    expect(slots(page)[page.DEADLINE_SCOPE_PREPARE]).toBe(1);
  });
});

describe('clock verification waits through a phase funnel', () => {
  it('times each wait from entry to the next phase and sorts it by how it ended', async () => {
    const page = await loadPage();
    const now = vi.spyOn(performance, 'now');
    const wait = (enterAt: number, leaveAt: number, to: string): void => {
      const attempt = {};
      now.mockReturnValueOnce(enterAt);
      page.countAudioRecoveryPhase(attempt, 'gesture-resuming', 'awaiting-clock-verification');
      now.mockReturnValueOnce(leaveAt);
      page.countAudioRecoveryPhase(attempt, 'awaiting-clock-verification', to);
    };
    wait(1_000, 1_410, 'completed');
    wait(2_000, 2_130, 'cancelled');
    wait(3_000, 3_100, 'preparing-suspend');
    wait(4_000, 4_050, 'awaiting-resume');

    const counts = slots(page);
    expect([
      counts[page.CLOCK_WAITS],
      counts[page.CLOCK_CONFIRMED],
      counts[page.CLOCK_CANCELLED],
      counts[page.CLOCK_RECOVERY_NEEDED],
      counts[page.CLOCK_WAIT_TOTAL_MS],
      counts[page.CLOCK_WAIT_MAX_MS],
    ]).toEqual([4, 1, 1, 2, 690, 410]);
  });

  it('keeps two attempts waiting at once apart', async () => {
    const page = await loadPage();
    const now = vi.spyOn(performance, 'now');
    const request = {};
    const scope = {};
    now.mockReturnValueOnce(100);
    page.countAudioRecoveryPhase(request, 'gesture-resuming', 'awaiting-clock-verification');
    now.mockReturnValueOnce(150);
    page.countAudioRecoveryPhase(scope, 'automatic-resuming', 'awaiting-clock-verification');
    now.mockReturnValueOnce(400);
    page.countAudioRecoveryPhase(scope, 'awaiting-clock-verification', 'completed');
    now.mockReturnValueOnce(1_100);
    page.countAudioRecoveryPhase(request, 'awaiting-clock-verification', 'cancelled');
    const counts = slots(page);
    expect([counts[page.CLOCK_WAIT_TOTAL_MS], counts[page.CLOCK_WAIT_MAX_MS]]).toEqual([
      1_250, 1_000,
    ]);
  });

  it.each([
    ['awaiting-gesture', 'preparing-suspend', 1],
    ['gesture-resuming', 'preparing-suspend', 0],
    ['awaiting-clock-verification', 'preparing-suspend', 0],
    ['preparing-suspend', 'awaiting-gesture', 0],
  ])('%s -> %s counts %i re-suspend after running', async (from, to, expected) => {
    const page = await loadPage();
    page.countAudioRecoveryPhase({}, from, to);
    expect(slots(page)[page.RESUSPENDED_AFTER_RUNNING]).toBe(expected);
  });
});

describe('owner queries', () => {
  it('counts suspends, second suspends and the most leases live on one context at once', async () => {
    const page = await loadPage();
    const context = {} as AudioContext;
    let live = [1, 0];
    page.registerAudioRecoveryOwner(
      () => false,
      (asked) => (asked === context ? live[0]! : 0),
    );
    page.registerAudioRecoveryOwner(
      () => false,
      (asked) => (asked === context ? live[1]! : 0),
    );
    page.countAudioSuspend(context, 1);
    live = [1, 1];
    page.countAudioSuspend(context, 2);
    live = [0, 1];
    page.countAudioSuspend(context, 1);
    const counts = slots(page);
    expect([
      counts[page.SUSPEND_CALLS],
      counts[page.SECOND_SUSPENDS],
      counts[page.LEASES_AT_ONCE_MAX],
    ]).toEqual([3, 1, 2]);
  });

  it('asks the owners at the moment a UI sound resumes', async () => {
    const page = await loadPage();
    let waiting = false;
    page.registerAudioRecoveryOwner(
      () => false,
      () => 0,
    );
    page.registerAudioRecoveryOwner(
      () => waiting,
      () => 0,
    );
    page.countUiSoundResume();
    waiting = true;
    page.countUiSoundResume();
    const counts = slots(page);
    expect([counts[page.RESUME_UI_SOUND], counts[page.UI_SOUND_RESUMES_WHILE_WAITING]]).toEqual([
      2, 1,
    ]);
  });
});

describe('the previous page in this tab (owner decision Q4, the P4-D5 B form)', () => {
  it('keeps nothing when this page counted nothing', async () => {
    const page = await loadPage();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    page.keepAudioRecoveryForNextPage();
    expect(setItem).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps every slot with its build; the reload reads and removes it once at start, then never again', async () => {
    const first = await loadPage();
    first.countAudioRecovery(first.RESUME_AUTO);
    first.countAudioRecovery(first.RESUME_AUTO);
    first.countAudioRecovery(first.DIALOG_REQUESTS_RETURN);
    first.keepAudioRecoveryForNextPage();
    const expected = [...slots(first)];
    expect(sessionStorage.getItem(KEY)).toBe(`1 9.0.37 ${expected.join(' ')}`);
    expect(expected).toHaveLength(first.AUDIO_RECOVERY_SLOTS);

    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const next = await loadPage();
    expect(previous(next)).toBeNull();
    next.takeAudioRecoveryFromPreviousPage();
    expect([getItem.mock.calls, removeItem.mock.calls]).toEqual([[[KEY]], [[KEY]]]);
    expect(sessionStorage.length).toBe(0);
    expect(previous(next)).toBe(`1 9.0.37 ${expected.join(' ')}`);
    // This page's own counts start from zero; the previous page's stay apart.
    expect(slots(next).every((count) => count === 0)).toBe(true);

    next.readAudioRecoveryCounts();
    next.readAudioRecoveryCounts();
    expect([getItem.mock.calls.length, removeItem.mock.calls.length]).toEqual([1, 1]);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('keeps the latest counts at every pagehide of the same page', async () => {
    const page = await loadPage();
    page.countAudioRecovery(page.RESUME_ENSURE_RUNNING);
    page.keepAudioRecoveryForNextPage();
    page.countAudioRecovery(page.DIALOG_REQUESTS_PLAY);
    page.keepAudioRecoveryForNextPage();
    expect(sessionStorage.getItem(KEY)).toBe(`1 9.0.37 ${slots(page).join(' ')}`);
    expect(slots(page)[page.DIALOG_REQUESTS_PLAY]).toBe(1);
  });

  function refuse(method: 'getItem' | 'setItem' | 'removeItem') {
    return vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
  }

  it('keeps nothing for the next page when storage refuses the write', async () => {
    const first = await loadPage();
    first.countAudioRecovery(first.RESUME_AUTO);
    const setItem = refuse('setItem');
    expect(() => first.keepAudioRecoveryForNextPage()).not.toThrow();
    setItem.mockRestore();
    const next = await loadPage();
    next.takeAudioRecoveryFromPreviousPage();
    expect(previous(next)).toBeNull();
  });

  it.each([
    ['refuses the read', 'getItem'],
    ['cannot remove the kept value', 'removeItem'],
  ] as const)('keeps no previous page when storage %s', async (_label, method) => {
    sessionStorage.setItem(KEY, '1 9.0.36 0');
    const refused = refuse(method);
    const page = await loadPage();
    expect(() => page.takeAudioRecoveryFromPreviousPage()).not.toThrow();
    refused.mockRestore();
    // Showing a value it could not remove would repeat it on every later page.
    expect(previous(page)).toBeNull();
  });

  it.each([
    ['a tab opened from this one (navigate)', 'navigate'],
    ['a history traversal', 'back_forward'],
    ['a browser without navigation timing', null],
  ])('keeps no previous page in %s, and removes the copied value', async (_label, type) => {
    sessionStorage.setItem(KEY, '1 9.0.37 0');
    navigation(type);
    const page = await loadPage();
    page.takeAudioRecoveryFromPreviousPage();
    expect(previous(page)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});
