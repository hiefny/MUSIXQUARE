// @vitest-environment jsdom
/**
 * The logo reset's prepare step (core/sw-hard-reset.ts, Phase 3 C6-10) against
 * the update machine's port: the HARD_RESET_CLAIM_EVENT the machine answers on
 * the page's service-worker container (sw-register.ts). Here a scripted
 * listener stands in for the machine; the machine's own answers are pinned in
 * sw-register.test.ts and, on the real navigation owner, in
 * sw-update-transitions.integration.test.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import activatePendingServiceWorkerForHardReset from '../sw-hard-reset.ts';
import type { HardResetClaim, HardResetClaimRequest } from '../../sw-register.ts';
import { HARD_RESET_CLAIM_EVENT, STARTUP_PROMPT_QUIET_MS } from './__helpers__/hard-reset-port.ts';

interface Harness {
  readonly waitingWorker: { state: string; postMessage: ReturnType<typeof vi.fn> } | null;
  /** Every event type dispatched on the container. */
  readonly dispatched: string[];
  /** The page's quiet reading each claim carried. */
  readonly quiets: Array<boolean | undefined>;
  readonly getRegistration: ReturnType<typeof vi.fn>;
  activate(): void;
}

function installHarness(
  options: { controlled?: boolean; waiting?: boolean; claim?: HardResetClaim | null } = {},
): Harness {
  const events = new EventTarget();
  const dispatched: string[] = [];
  const quiets: Array<boolean | undefined> = [];
  const previousController = options.controlled === false ? null : { id: 'old' };
  let controller: object | null = previousController;
  const waitingWorker =
    options.waiting === false ? null : { state: 'installed', postMessage: vi.fn() };
  const getRegistration = vi.fn().mockResolvedValue({ waiting: waitingWorker });
  const serviceWorkers = Object.assign(events, { getRegistration });
  const dispatch = events.dispatchEvent.bind(events);
  Object.defineProperty(serviceWorkers, 'dispatchEvent', {
    configurable: true,
    value: (event: Event) => {
      dispatched.push(event.type);
      return dispatch(event);
    },
  });
  Object.defineProperty(serviceWorkers, 'controller', {
    configurable: true,
    get: () => controller,
  });
  // The machine's answer; null leaves the event unanswered (no machine listener).
  const claim = options.claim === undefined ? 'unavailable' : options.claim;
  if (claim !== null) {
    events.addEventListener(HARD_RESET_CLAIM_EVENT, (event) => {
      const request = (event as CustomEvent<HardResetClaimRequest>).detail;
      quiets.push(request.quiet);
      request.claim = claim;
    });
  }
  vi.stubGlobal('navigator', { serviceWorker: serviceWorkers });
  return {
    waitingWorker,
    dispatched,
    quiets,
    getRegistration,
    activate() {
      controller = { id: 'new' };
      events.dispatchEvent(new Event('controllerchange'));
    },
  };
}

const SKIP_WAITING = { type: 'SKIP_WAITING' };

describe('the logo hard reset asks the update machine (C6-10)', () => {
  let prepare: AbortController;

  beforeEach(() => {
    sessionStorage.clear();
    prepare = new AbortController();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks on the event the update machine listens for', async () => {
    const harness = installHarness({ claim: 'none' });
    await activatePendingServiceWorkerForHardReset(prepare.signal);
    // The lazy chunk keeps its own copy of the event name; this pins it.
    expect(harness.dispatched).toEqual([HARD_RESET_CLAIM_EVENT]);
    // With the page's quiet reading: nothing has loaded in this test.
    expect(harness.quiets).toEqual([true]);
  });

  // The claim carries whether the page's loads are quiet, which the update
  // machine needs before it sends SKIP_WAITING (P3-9 A). The hard reset
  // measures it so the eager bundle does not carry the check (Phase 3 R2).
  describe("the page's quiet reading sent with the claim (P3-9 A)", () => {
    const NOW = 10_000;
    const PAGE_RESOURCE = 'https://musixquare.com/assets/page.js';
    // The chunk's import.meta.url under Vitest; the transition table uses the same.
    const OWN_CHUNK = pathToFileURL(resolve('src/core/sw-hard-reset.ts')).href;

    function stubResourceTiming(
      entries: ReadonlyArray<{ name: string; responseEnd: number }> | 'unsupported',
    ): void {
      vi.stubGlobal('performance', {
        now: () => NOW,
        getEntriesByType: (type: string) => {
          if (entries === 'unsupported') throw new TypeError('no resource timing');
          return type === 'resource' ? entries : [];
        },
      });
    }

    async function quietReading(): Promise<boolean | undefined> {
      const harness = installHarness({ claim: 'none' });
      await activatePendingServiceWorkerForHardReset(prepare.signal);
      expect(harness.quiets).toHaveLength(1);
      return harness.quiets[0];
    }

    it.each([
      ['nothing has loaded', [], true],
      [
        'a page resource finished just inside the quiet window',
        [{ name: PAGE_RESOURCE, responseEnd: NOW - STARTUP_PROMPT_QUIET_MS + 1 }],
        false,
      ],
      [
        'the last page resource finished a whole quiet window ago',
        [{ name: PAGE_RESOURCE, responseEnd: NOW - STARTUP_PROMPT_QUIET_MS }],
        true,
      ],
      [
        // Found by the 2026-10-24 real-browser check: the browser records the
        // chunk's load for this tap, which is not the page still loading.
        'only its own chunk finished just now',
        [{ name: OWN_CHUNK, responseEnd: NOW }],
        true,
      ],
      [
        'its own chunk and a page resource finished just now',
        [
          { name: OWN_CHUNK, responseEnd: NOW },
          { name: PAGE_RESOURCE, responseEnd: NOW },
        ],
        false,
      ],
    ] as const)('when %s, reads the page as quiet: %s', async (_description, entries, quiet) => {
      stubResourceTiming(entries);
      expect(await quietReading()).toBe(quiet);
    });

    it('reads the page as quiet without resource timing', async () => {
      stubResourceTiming('unsupported');
      expect(await quietReading()).toBe(true);
    });

    it("keeps the update machine's quiet window", () => {
      // STARTUP_PROMPT_QUIET_MS in sw-register.ts is the home; the lazy
      // chunk keeps a copy of the same name, pinned to it here.
      const constant = (path: string, name: string) => {
        const match = new RegExp(`const ${name} = ([0-9_]+);`, 'u').exec(
          readFileSync(resolve(path), 'utf8'),
        );
        expect(match, `${name} in ${path}`).not.toBeNull();
        return Number(match![1]!.replaceAll('_', ''));
      };
      for (const path of ['src/sw-register.ts', 'src/core/sw-hard-reset.ts']) {
        expect(constant(path, 'STARTUP_PROMPT_QUIET_MS')).toBe(STARTUP_PROMPT_QUIET_MS);
      }
    });
  });

  it.each([
    ['without a controller', { controlled: false }],
    ['without a waiting worker', { waiting: false }],
  ] as const)('reports no pending update %s', async (_description, options) => {
    const harness = installHarness(options);

    await expect(activatePendingServiceWorkerForHardReset(prepare.signal)).resolves.toBeUndefined();
    if (harness.waitingWorker) expect(harness.waitingWorker.postMessage).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('mxqr-swu')).toBeNull();
  });

  it.each([
    ['the machine promotes nothing (no waiting worker, or the page still loads)', 'none'],
    ['nothing answers (no service-worker registration in this page)', null],
  ] as const)('promotes nothing when %s', async (_description, claim) => {
    const harness = installHarness({ claim });
    await activatePendingServiceWorkerForHardReset(prepare.signal);
    expect(harness.getRegistration).not.toHaveBeenCalled();
    expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('mxqr-swu')).toBeNull();
  });

  it('asks nothing once the prepare step is aborted', async () => {
    const harness = installHarness();
    prepare.abort();
    await activatePendingServiceWorkerForHardReset(prepare.signal);
    expect(harness.dispatched).toEqual([]);
    expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalled();
  });

  describe('the machine promoted the worker', () => {
    it('records "Update applied" when the worker takes control within the wait, sending nothing itself', async () => {
      vi.useFakeTimers();
      const harness = installHarness({ claim: 'promoted' });
      const step = activatePendingServiceWorkerForHardReset(prepare.signal);
      await vi.advanceTimersByTimeAsync(1_000);
      harness.activate();
      await step;
      expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalled();
      expect(sessionStorage.getItem('mxqr-swu')).toBe('Update applied');
    });

    it('promotes on its own after the 1.5 s wait, TEMPORARILY (P3-12 A), and records the activation', async () => {
      vi.useFakeTimers();
      const harness = installHarness({ claim: 'promoted' });
      const step = activatePendingServiceWorkerForHardReset(prepare.signal);
      await vi.advanceTimersByTimeAsync(1_499);
      expect(harness.getRegistration).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith(SKIP_WAITING);
      harness.activate();
      await step;
      expect(sessionStorage.getItem('mxqr-swu')).toBe('Update applied');
    });

    it('stops at the prepare abort without a marker or a late SKIP_WAITING', async () => {
      vi.useFakeTimers();
      const harness = installHarness({ claim: 'promoted' });
      const step = activatePendingServiceWorkerForHardReset(prepare.signal);
      await vi.advanceTimersByTimeAsync(1_000);
      prepare.abort();
      await step;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.getRegistration).not.toHaveBeenCalled();
      expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalled();
      harness.activate();
      expect(sessionStorage.getItem('mxqr-swu')).toBeNull();
    });
  });

  describe('an Apply is already in flight (P3-8 A)', () => {
    it('waits for that activation without sending SKIP_WAITING, and records it', async () => {
      vi.useFakeTimers();
      const harness = installHarness({ claim: 'apply-in-flight' });
      const step = activatePendingServiceWorkerForHardReset(prepare.signal);
      // Longer than the hard reset's own 1.5 s wait: only the prepare window ends it.
      await vi.advanceTimersByTimeAsync(2_400);
      harness.activate();
      await step;
      expect(harness.getRegistration).not.toHaveBeenCalled();
      expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalled();
      expect(sessionStorage.getItem('mxqr-swu')).toBe('Update applied');
    });

    it('ends at the prepare abort with no second SKIP_WAITING and no marker', async () => {
      vi.useFakeTimers();
      const harness = installHarness({ claim: 'apply-in-flight' });
      let settled = false;
      const step = activatePendingServiceWorkerForHardReset(prepare.signal).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);
      prepare.abort();
      await step;
      expect(harness.getRegistration).not.toHaveBeenCalled();
      expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalled();
      expect(sessionStorage.getItem('mxqr-swu')).toBeNull();
    });
  });

  describe('no machine yet (P3-12 A: the hard reset promotes on its own)', () => {
    it('activates an installed waiting worker and waits until it controls the page', async () => {
      const harness = installHarness({ claim: 'unavailable' });
      let settled = false;
      const activation = activatePendingServiceWorkerForHardReset(prepare.signal).then(() => {
        settled = true;
      });
      await vi.waitFor(() =>
        expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith(SKIP_WAITING),
      );

      expect(settled).toBe(false);
      harness.activate();

      await expect(activation).resolves.toBeUndefined();
      expect(sessionStorage.getItem('mxqr-swu')).toBe('Update applied');
    });

    it('fails open after a bounded wait when activation stalls', async () => {
      vi.useFakeTimers();
      const harness = installHarness({ claim: 'unavailable' });
      const activation = activatePendingServiceWorkerForHardReset(prepare.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.waitingWorker?.postMessage).toHaveBeenCalledWith(SKIP_WAITING);

      await vi.advanceTimersByTimeAsync(1_500);
      await expect(activation).resolves.toBeUndefined();
      expect(sessionStorage.getItem('mxqr-swu')).toBeNull();
    });

    it('stops at the prepare abort before the registration answers, sending nothing', async () => {
      const harness = installHarness({ claim: 'unavailable' });
      let resolveRegistration!: (value: unknown) => void;
      harness.getRegistration.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRegistration = resolve;
        }),
      );
      const activation = activatePendingServiceWorkerForHardReset(prepare.signal);
      prepare.abort();
      resolveRegistration({ waiting: harness.waitingWorker });
      await activation;
      expect(harness.waitingWorker?.postMessage).not.toHaveBeenCalled();
    });
  });
});
