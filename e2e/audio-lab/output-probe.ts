/**
 * Instrumentation for the local audio output-recovery lab
 * (playwright.audio-lab.config.ts, output-recovery.lab.ts).
 *
 * An init script captures the app's one AudioContext (through the
 * createGain/createBufferSource prototype hooks, as
 * e2e/demo-output-recovery.test.ts does) and wraps that instance only:
 *
 * - resume()/suspend() calls are logged as `ms resume@origin:state` and
 *   `ms suspend:state`; the origin is the event being dispatched when the
 *   call is made (`click`, `pointerdown`, `keydown`, ...), or `task`;
 * - a resume gate can hold calls from chosen origins, and a suspend gate can
 *   hold suspends, until the test releases them;
 * - `currentTime` can be frozen and unfrozen on the instance, which stands in
 *   for the WebKit frozen clock (the instance is the app's only context, so
 *   scheduling and sync reads freeze too: tests keep the frozen window short);
 * - buffer source starts longer than 1 s (real tracks, not unlock or UI
 *   sounds) are counted;
 * - showing and hiding of #dialog-overlay is logged and counted;
 * - bus events (recovery notices, local rejoins, playback activity) are
 *   recorded once a room is playing.
 */
import { expect, type Page } from '@playwright/test';
import { uploadFixtures } from '../helpers/file-upload.ts';
import { injectPeerServer } from '../helpers/peer-server.ts';
import { useAnonymousAccountSession } from '../helpers/context-factory.ts';
import { setupHostAndStart } from '../helpers/setup-flow.ts';
import {
  clickPlayButton,
  waitForFilePlaybackReady,
  waitForPlaybackProjection,
} from '../helpers/wait.ts';

interface Gate {
  readonly origins: readonly string[] | null;
  readonly limit: number;
  held: number;
  readonly release: () => void;
  readonly released: Promise<void>;
  /** Settles when the gate holds its first call. */
  readonly firstHeld: Promise<void>;
  readonly markHeld: () => void;
}

interface Lab {
  ctx: AudioContext | null;
  ops: string[];
  starts: number;
  dialogShows: number;
  needed: string[];
  rejoins: string[];
  activity: string[];
  resumeGate: Gate | null;
  suspendGate: Gate | null;
  freeze(): void;
  unfreeze(): void;
  holdResume(origins: string[], limit: number): void;
  holdSuspend(): void;
  releaseGates(): void;
}

type LabWindow = Window & { __audioLab: Lab };

export interface LabSnapshot {
  readonly ops: string[];
  readonly starts: number;
  readonly dialogShows: number;
  readonly needed: string[];
  readonly rejoins: string[];
  readonly activity: string[];
  readonly state: string | null;
  readonly resumeHeld: number;
  readonly suspendHeld: number;
}

async function instrument(page: Page, uiSounds: boolean): Promise<void> {
  await injectPeerServer(page);
  await useAnonymousAccountSession(page);
  await page.addInitScript((enableUiSounds) => {
    try {
      localStorage.setItem('musixquare-lang', 'en');
      if (enableUiSounds) localStorage.setItem('musixquare-ui-sounds-enabled', '1');
    } catch {
      return;
    }
    const now = (): number => Math.round(performance.now());
    const makeGate = (origins: string[] | null, limit: number): Gate => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markHeld!: () => void;
      const firstHeld = new Promise<void>((resolve) => {
        markHeld = resolve;
      });
      return { origins, limit, held: 0, release, released, firstHeld, markHeld };
    };
    const lab: Lab = {
      ctx: null,
      ops: [],
      starts: 0,
      dialogShows: 0,
      needed: [],
      rejoins: [],
      activity: [],
      resumeGate: null,
      suspendGate: null,
      freeze: () => {
        const ctx = lab.ctx;
        if (!ctx) throw new Error('no AudioContext captured');
        const frozen = ctx.currentTime;
        Object.defineProperty(ctx, 'currentTime', { configurable: true, get: () => frozen });
        lab.ops.push(`${now()} freeze`);
      },
      unfreeze: () => {
        if (lab.ctx) Reflect.deleteProperty(lab.ctx, 'currentTime');
        lab.ops.push(`${now()} unfreeze`);
      },
      holdResume: (origins, limit) => {
        lab.resumeGate = makeGate(origins, limit);
      },
      holdSuspend: () => {
        lab.suspendGate = makeGate(null, Number.POSITIVE_INFINITY);
      },
      releaseGates: () => {
        const gates = [lab.resumeGate, lab.suspendGate];
        lab.resumeGate = null;
        lab.suspendGate = null;
        for (const gate of gates) gate?.release();
      },
    };
    (window as unknown as LabWindow).__audioLab = lab;

    const holds = (gate: Gate | null, origin: string): gate is Gate =>
      Boolean(
        gate && gate.held < gate.limit && (gate.origins === null || gate.origins.includes(origin)),
      );
    const observe = (ctx: AudioContext): void => {
      if (lab.ctx) return;
      lab.ctx = ctx;
      ctx.addEventListener('statechange', () => lab.ops.push(`${now()} statechange:${ctx.state}`));
      const resume = ctx.resume.bind(ctx);
      const suspend = ctx.suspend.bind(ctx);
      ctx.resume = () => {
        const origin = window.event?.type ?? 'task';
        lab.ops.push(`${now()} resume@${origin}:${ctx.state}`);
        const gate = lab.resumeGate;
        if (holds(gate, origin)) {
          gate.held += 1;
          gate.markHeld();
          return gate.released.then(() => resume());
        }
        return resume();
      };
      ctx.suspend = () => {
        lab.ops.push(`${now()} suspend:${ctx.state}`);
        const gate = lab.suspendGate;
        if (holds(gate, 'any')) {
          gate.held += 1;
          gate.markHeld();
          return gate.released.then(() => suspend());
        }
        return suspend();
      };
    };
    const createGain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function () {
      observe(this);
      return createGain.call(this);
    };
    const createBufferSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      observe(this);
      const source = createBufferSource.call(this);
      const start = source.start.bind(source);
      source.start = (...args: Parameters<AudioBufferSourceNode['start']>) => {
        start(...args);
        if ((source.buffer?.duration ?? 0) > 1) lab.starts += 1;
      };
      return source;
    };
    new MutationObserver(() => {
      const overlay = document.getElementById('dialog-overlay');
      if (!overlay) return;
      const shown = overlay.classList.contains('show');
      if (shown === (overlay.dataset.audioLabShown === '1')) return;
      overlay.dataset.audioLabShown = shown ? '1' : '0';
      if (shown) lab.dialogShows += 1;
      lab.ops.push(`${now()} dialog:${shown ? 'shown' : 'hidden'}`);
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }, uiSounds);
}

async function recordBus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const lab = (window as unknown as LabWindow).__audioLab;
    const bus = (window as unknown as Record<string, unknown>).__MUSIXQUARE_BUS__ as {
      on: (type: string, callback: (payload?: unknown) => void) => void;
    };
    bus.on('audio:output-recovery-needed', (event) => {
      const notice = event as { source: string; reason: string };
      lab.needed.push(`${notice.source}:${notice.reason}`);
    });
    bus.on('playback:local-output-rejoin', (event) => {
      lab.rejoins.push((event as { reason: string }).reason);
    });
    bus.on('state:playback.activity', (activity) => {
      lab.activity.push(String(activity));
    });
  });
}

export async function readLab(page: Page): Promise<LabSnapshot> {
  return page.evaluate(() => {
    const lab = (window as unknown as LabWindow).__audioLab;
    return {
      ops: [...lab.ops],
      starts: lab.starts,
      dialogShows: lab.dialogShows,
      needed: [...lab.needed],
      rejoins: [...lab.rejoins],
      activity: [...lab.activity],
      state: lab.ctx?.state ?? null,
      resumeHeld: lab.resumeGate?.held ?? 0,
      suspendHeld: lab.suspendGate?.held ?? 0,
    };
  });
}

/** The page's own clock, in the same ms as the op log. */
export async function pageNow(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(performance.now()));
}

export async function unfreeze(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as LabWindow).__audioLab.unfreeze());
}

/** Hold the first `limit` resume() calls made while one of `origins` dispatches. */
export async function holdResume(page: Page, origins: string[], limit = 1): Promise<void> {
  await page.evaluate(
    ([held, max]) => (window as unknown as LabWindow).__audioLab.holdResume(held, max),
    [origins, limit] as const,
  );
}

export async function holdSuspend(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as LabWindow).__audioLab.holdSuspend());
}

/**
 * Wait, inside the page, until the suspend gate holds its first call (at
 * most `limitMs`), so the only wall-clock wait after it is the test's own.
 */
export async function waitForSuspendHeld(page: Page, limitMs = 5_000): Promise<void> {
  await page.evaluate(async (limit) => {
    const gate = (window as unknown as LabWindow).__audioLab.suspendGate;
    if (!gate) throw new Error('no suspend gate');
    await Promise.race([
      gate.firstHeld,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('the suspend gate held nothing')), limit);
      }),
    ]);
  }, limitMs);
}

/** Remove both gates and let the calls they held proceed. */
export async function releaseGates(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as LabWindow).__audioLab.releaseGates());
}

/** A page script resumes the context (no user gesture: origin `task`). */
export async function resumeFromPageScript(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (window as unknown as LabWindow).__audioLab.ctx?.resume();
  });
}

/**
 * A newer failed PLAY for the same file, as transport would announce it: a
 * different recovery identity, so app.ts queues it and aborts the open
 * dialog. Its retry does nothing. Returns the page time of the emit.
 *
 * In the same task, after the emit, it lets 100 microtask hops run and then
 * logs `abort+microtasks`: whatever the abort settles through promises alone
 * is logged before that marker, and anything that waits for a timer task
 * (such as a 50 ms poll) after it.
 */
export async function emitNewerPlayRequest(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const hooks = window as unknown as Record<string, unknown>;
    const bus = hooks.__MUSIXQUARE_BUS__ as { emit: (type: string, payload: unknown) => void };
    const getState = hooks.__MUSIXQUARE_GET_STATE__ as (path: string) => unknown;
    const at = Math.round(performance.now());
    bus.emit('audio:output-recovery-needed', {
      reason: 'context-not-running',
      source: 'play',
      queueItemId: getState('playlist.currentQueueItemId'),
      isCurrent: () => true,
      retry: async () => false,
    });
    for (let hop = 0; hop < 100; hop += 1) await Promise.resolve();
    (window as unknown as LabWindow).__audioLab.ops.push(
      `${Math.round(performance.now())} abort+microtasks`,
    );
    return at;
  });
}

export async function setPageVisibility(
  page: Page,
  visibility: DocumentVisibilityState,
): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => value === 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visibility);
}

/**
 * A hidden/visible round trip: hidden for 2 s, then the clock freezes just
 * before the page becomes visible again (the WebKit frozen clock on return).
 */
export async function bounce(page: Page): Promise<void> {
  await setPageVisibility(page, 'hidden');
  await page.waitForTimeout(2_000);
  await page.evaluate(() => (window as unknown as LabWindow).__audioLab.freeze());
  await setPageVisibility(page, 'visible');
}

export interface OpenOptions {
  readonly uiSounds?: boolean;
  readonly tracks?: 1 | 2;
}

/** A host alone in a real room, playing a local file. */
export async function openPlaying(page: Page, options: OpenOptions = {}): Promise<void> {
  await instrument(page, options.uiSounds === true);
  await setupHostAndStart(page);
  await uploadFixtures(page, options.tracks === 2 ? ['test01', 'test02'] : ['test01']);
  await waitForFilePlaybackReady(page, 20_000);
  await clickPlayButton(page);
  await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 15_000);
  await recordBus(page);
}

async function expectRecoveryDialog(page: Page): Promise<void> {
  await expect(page.locator('#dialog-overlay.show')).toBeVisible();
  await expect(page.locator('#dialog-title')).toHaveText('Audio paused unexpectedly');
}

/**
 * Pause, round trip, PLAY: transport's foreground probe finds the frozen
 * clock and opens the play-request dialog. Returns the source starts so far.
 */
export async function openPlayRequestDialog(
  page: Page,
  options: OpenOptions = {},
): Promise<number> {
  await openPlaying(page, options);
  await clickPlayButton(page);
  await waitForPlaybackProjection(page, 'PAUSED', 10_000);
  await bounce(page);
  const { starts } = await readLab(page);
  await clickPlayButton(page);
  await expectRecoveryDialog(page);
  return starts;
}

/**
 * Round trip while playing: the background inspector finds the frozen clock
 * and opens the prepared (playback-scope) dialog. Returns the starts so far.
 */
export async function openPreparedDialog(page: Page, options: OpenOptions = {}): Promise<number> {
  await openPlaying(page, options);
  const { starts } = await readLab(page);
  await bounce(page);
  await expectRecoveryDialog(page);
  return starts;
}

/** The ops logged from the last `marker` entry (for example 'unfreeze') on. */
export function opsFrom(ops: readonly string[], marker: string): string[] {
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    if (ops[index]!.endsWith(` ${marker}`)) return ops.slice(index);
  }
  return [...ops];
}

/** How many logged ops contain `needle` (for example 'resume@click:'). */
export function countOps(ops: readonly string[], needle: string): number {
  return ops.filter((op) => op.includes(needle)).length;
}

/** The page times of the logged ops that contain `needle`. */
export function timesOf(ops: readonly string[], needle: string): number[] {
  return ops.filter((op) => op.includes(needle)).map((op) => Number(op.split(' ')[0]));
}

/** The dialog show/hide entries alone, without times. */
export function dialogMoves(ops: readonly string[]): string[] {
  return ops.filter((op) => op.includes(' dialog:')).map((op) => op.split(' ')[1]!);
}
