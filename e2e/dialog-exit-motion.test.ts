/**
 * Dialog exit motion: a dialog leaves the way it came in.
 *
 * Owner report: every dialog slid up from below when it appeared but vanished
 * with no animation. A closing dialog now plays its entrance in reverse
 * (css/style.css dialogBackdropOut and modalSlideDown, 0.22 s ease-in) under
 * the is-closing class, which src/ui/dom.ts holds until the overlay's own
 * animation ends. The dialog is closed for input, focus and Back at once.
 *
 * A probe in the page records each class change of the overlay with the CSS
 * animations it started. As the close starts it reads the exit on its
 * animations' own clock: both set to every 20 ms of the exit and read, then
 * put back. How many frames land inside a 0.22 s exit measures the machine,
 * not the page (the boot splash rows learned this in Linux WebKit, #616), so
 * the values come from the clock. The probe also reads every frame, as a
 * cross-check with no minimum count: the overlay's classes and display, its
 * opacity and the panel's vertical offset. As the close starts it also asks
 * what a pointer would hit at the panel, and at the list's scrollbar where
 * one shows: the closing dialog lets every pointer through to the page.
 *
 * Chromium opens a real local room in the desktop dashboard. The Windows
 * Playwright WebKit build has no PeerJS WebRTC transport, so the WebKit lane
 * (iPhone layout) seeds the host role in the initialized app instead, as
 * back-navigation and theme-switch-motion do. No room code is typed anywhere.
 */
import { expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { useAnonymousAccountSession } from './helpers/context-factory.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { navigateToSubtab, navigateToTab } from './helpers/wait.ts';

// The exit's values come from its animations' clock; the frames the probe
// samples are a cross-check. In the headless WebKit lane a frame with a
// dialog's full-screen backdrop over the 3x iPhone surface took about a
// quarter of a second to render, so the cross-check would see one frame of
// the exit at most. At 1x it renders every 16 to 30 ms. The exit's timing and
// values do not depend on the pixel ratio, and the iPhone viewport, touch and
// user agent stay as they are.
test.use({ serviceWorkers: 'block', deviceScaleFactor: 1 });

/** The exit's length: css/style.css dialogBackdropOut and modalSlideDown, 0.22 s. */
const EXIT_MS = 220;
/** Every 20 ms into the exit, short of its end, so no seek sends an animation event. */
const EXIT_SEEK_MS = Array.from({ length: 11 }, (_, index) => index * 20);

/** One animation frame as the probe read it. Times are ms after the probe started. */
interface ExitFrame {
  t: number;
  shown: boolean;
  closing: boolean;
  display: string;
  opacity: number;
  panelY: number;
}

/** The overlay's classes after one class change, with the CSS animations then on it. */
interface ClassChange {
  t: number;
  shown: boolean;
  closing: boolean;
  animations: {
    target: 'overlay' | 'panel';
    name: string;
    currentTime: number | null;
    duration: number;
  }[];
}

/** The exit set to one point on its animations' own clock, then read. */
interface ExitSeek {
  /** ms into the exit. */
  at: number;
  display: string;
  opacity: number;
  panelY: number;
}

/** What a pointer would hit, read as the close starts, before any frame. */
interface CloseHits {
  /** Whether a pointer at the panel's centre lands inside the closing overlay. */
  panel: boolean;
  /** The overlay's custom scrollbar track, where it has one. */
  track: {
    /** The pointer-events the scrollbar wrote on the track (auto while it shows). */
    inline: string;
    computed: string;
    /** Whether a pointer at the track's centre lands inside the closing overlay. */
    inside: boolean;
  } | null;
}

interface ExitProbe {
  /** performance.now() when the probe started. */
  start: number;
  frames: ExitFrame[];
  changes: ClassChange[];
  /** The first close's exit read on its clock; empty if it had no exit. */
  seeks: ExitSeek[];
  /** The first close's hit tests. */
  hits: CloseHits | null;
  /** What reading the first close threw, if anything. */
  error: string | null;
  done: boolean;
}

interface ProbeWindow extends Window {
  __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void;
  __MUSIXQUARE_BUS__: { emit(type: string, ...args: unknown[]): void };
  __dialogExitProbe?: ExitProbe;
  __guardPushes?: number[];
}

/** Opens a host room with motion on, once the boot guard and the room entrance are done. */
async function openRoom(page: Page, browserName: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await injectPeerServer(page);
  await useAnonymousAccountSession(page);
  if (browserName === 'webkit') {
    await page.goto('/');
    await waitForBootstrapReady(page);
    await page.evaluate(() => {
      const runtime = window as unknown as ProbeWindow;
      runtime.__MUSIXQUARE_SET_STATE__('network.appRole', 'host');
      runtime.__MUSIXQUARE_SET_STATE__('setup.sessionStarted', true);
      document.getElementById('setup-overlay')?.classList.remove('active');
      document.body.classList.remove('overlay-open');
      runtime.__MUSIXQUARE_BUS__.emit('setup:app-entrance');
    });
  } else {
    await setupHostAndStart(page);
  }
  await page.waitForFunction(
    () =>
      !document.documentElement.classList.contains('is-booting') &&
      document.querySelector('.app-entrance') === null,
    undefined,
    { timeout: 10_000 },
  );
}

/** Waits until a shown overlay's entrance animations have ended. */
async function waitForEntrance(page: Page, overlayId: string): Promise<void> {
  await expect(page.locator(`#${overlayId}`)).toHaveClass(/\bshow\b/);
  await page.waitForFunction(
    (id) => {
      const overlay = document.getElementById(id);
      const panel = overlay?.querySelector('.dialog');
      if (!overlay?.classList.contains('show') || !panel) return false;
      return [...overlay.getAnimations(), ...panel.getAnimations()]
        .filter((animation) => animation instanceof CSSAnimation)
        .every((animation) => animation.playState === 'finished');
    },
    overlayId,
    { timeout: 10_000 },
  );
}

/** The logo's leave confirmation, [Stay | Leave]: a generic dialog from a real control. */
async function openLeaveDialog(page: Page): Promise<void> {
  await expect(page.locator('#dialog-overlay')).not.toHaveClass(/\bis-closing\b/);
  await page.evaluate(() => document.getElementById('app-logo')!.click());
  await expect(page.locator('#btn-dialog-secondary')).toBeVisible();
  await waitForEntrance(page, 'dialog-overlay');
}

/**
 * Starts the probe on an overlay. It stops once a close has run its course and
 * the overlay is hidden, or, with `untilShownAgain`, 600 ms after the overlay
 * shows again after a close, or after 4 s.
 */
async function startProbe(page: Page, overlayId: string, untilShownAgain = false): Promise<void> {
  await page.evaluate(
    ({ id, untilShownAgain: waitForReopen, seekTimes }) => {
      const overlay = document.getElementById(id)!;
      const panel = overlay.querySelector<HTMLElement>('.dialog')!;
      const start = performance.now();
      const probe: ExitProbe = {
        start,
        frames: [],
        changes: [],
        seeks: [],
        hits: null,
        error: null,
        done: false,
      };
      (window as unknown as ProbeWindow).__dialogExitProbe = probe;
      const offsetY = (element: Element): number => {
        const transform = getComputedStyle(element).transform;
        return !transform || transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
      };
      const cssAnimations = (element: Element, target: 'overlay' | 'panel') =>
        element
          .getAnimations()
          .filter((animation): animation is CSSAnimation => animation instanceof CSSAnimation)
          .map((animation) => ({
            target,
            name: animation.animationName,
            currentTime: animation.currentTime === null ? null : Number(animation.currentTime),
            duration: Number(animation.effect?.getTiming().duration ?? 0),
          }));
      /** The element's own CSS animation by that name (not a pseudo-element's). */
      const own = (element: Element, name: string): CSSAnimation | null =>
        element
          .getAnimations()
          .find(
            (animation): animation is CSSAnimation =>
              animation instanceof CSSAnimation &&
              animation.animationName === name &&
              !(animation.effect as KeyframeEffect | null)?.pseudoElement,
          ) ?? null;
      /** Whether a pointer at the element's centre lands inside the overlay. */
      const hitsOverlay = (element: Element): boolean => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit !== null && overlay.contains(hit);
      };
      // Runs as the close starts, in the microtask after its class change and
      // before any frame. A hit test reads layout, no frame.
      const readClose = (): void => {
        const track = overlay.querySelector<HTMLElement>('.cscroll-track');
        probe.hits = {
          panel: hitsOverlay(panel),
          track: track
            ? {
                inline: track.style.pointerEvents,
                computed: getComputedStyle(track).pointerEvents,
                inside: hitsOverlay(track),
              }
            : null,
        };
        const backdrop = own(overlay, 'dialogBackdropOut');
        const slide = own(panel, 'modalSlideDown');
        if (!backdrop || !slide) return;
        // Both at the same point of the exit, then each back where it stood:
        // one still waiting for its start keeps its hold time, one already
        // started its start time. No point reaches the end, so no event comes
        // of it and dom.ts still settles the exit on its own end.
        const putBack = [backdrop, slide].map((animation) => {
          const { startTime, currentTime } = animation;
          return () => {
            if (startTime !== null) animation.startTime = startTime;
            else if (currentTime !== null) animation.currentTime = currentTime;
          };
        });
        try {
          for (const at of seekTimes) {
            backdrop.currentTime = at;
            slide.currentTime = at;
            const style = getComputedStyle(overlay);
            probe.seeks.push({
              at,
              display: style.display,
              opacity: Number(style.opacity),
              panelY: offsetY(panel),
            });
          }
        } finally {
          for (const restore of putBack) restore();
        }
      };
      // A close and a reopen count from their class changes too, so the probe
      // ends on time even when no frame lands inside the exit.
      let closed = false;
      let shownAgainAt: number | null = null;
      const observer = new MutationObserver(() => {
        const change: ClassChange = {
          t: performance.now() - start,
          shown: overlay.classList.contains('show'),
          closing: overlay.classList.contains('is-closing'),
          animations: [...cssAnimations(overlay, 'overlay'), ...cssAnimations(panel, 'panel')],
        };
        probe.changes.push(change);
        if (change.closing) closed = true;
        if (closed && change.shown && shownAgainAt === null) shownAgainAt = change.t;
        if (change.closing && !change.shown && probe.hits === null && probe.error === null) {
          try {
            readClose();
          } catch (error) {
            probe.error = String(error);
          }
        }
      });
      observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
      const sample = (): void => {
        const style = getComputedStyle(overlay);
        const frame: ExitFrame = {
          t: performance.now() - start,
          shown: overlay.classList.contains('show'),
          closing: overlay.classList.contains('is-closing'),
          display: style.display,
          opacity: Number(style.opacity),
          panelY: offsetY(panel),
        };
        probe.frames.push(frame);
        if (frame.closing) closed = true;
        if (closed && frame.shown && shownAgainAt === null) shownAgainAt = frame.t;
        const finished = waitForReopen
          ? shownAgainAt !== null && frame.t - shownAgainAt > 600
          : closed && !frame.closing && frame.display === 'none';
        if (finished || frame.t > 4_000) {
          observer.disconnect();
          probe.done = true;
          return;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    },
    { id: overlayId, untilShownAgain, seekTimes: EXIT_SEEK_MS },
  );
}

async function readProbe(page: Page): Promise<ExitProbe> {
  await page.waitForFunction(
    () => (window as unknown as ProbeWindow).__dialogExitProbe?.done === true,
    undefined,
    { timeout: 10_000 },
  );
  return page.evaluate(() => (window as unknown as ProbeWindow).__dialogExitProbe!);
}

/**
 * Checks that the backdrop only fades and the panel only moves down from one
 * reading to the next, within the 20 px of the exit.
 */
function expectFadingDown(
  readings: readonly { opacity: number; panelY: number }[],
  label: string,
  at: (index: number) => string,
): void {
  for (const [index, reading] of readings.entries()) {
    expect(reading.panelY, `${label}: offset at ${at(index)}`).toBeGreaterThanOrEqual(-0.5);
    expect(reading.panelY, `${label}: offset at ${at(index)}`).toBeLessThanOrEqual(20.5);
    if (index === 0) continue;
    const previous = readings[index - 1]!;
    expect(reading.opacity, `${label}: opacity at ${at(index)}`).toBeLessThanOrEqual(
      previous.opacity + 0.02,
    );
    expect(reading.panelY, `${label}: offset at ${at(index)}`).toBeGreaterThanOrEqual(
      previous.panelY - 0.5,
    );
  }
}

/**
 * Checks one close in the probe: the entrance played backwards for about the
 * exit time, then the overlay hid (unless `hiddenAtEnd` is false, for a probe
 * that goes on to the next dialog), and a pointer went through the closing
 * dialog to the page. Returns the close and its end, in probe time.
 */
function expectReversedEntrance(
  probe: ExitProbe,
  label: string,
  hiddenAtEnd = true,
): { closedAt: number; endedAt: number } {
  const closed = probe.changes.find((change) => change.closing && !change.shown);
  expect(closed, `${label}: the close swapped show for is-closing`).toBeDefined();
  const started = closed!.animations.map(({ target, name }) => `${target} ${name}`);
  expect(started, `${label}: the animations the close started`).toEqual(
    expect.arrayContaining(['overlay dialogBackdropOut', 'panel modalSlideDown']),
  );
  for (const animation of closed!.animations) {
    expect(animation.duration, `${label}: ${animation.name} duration`).toBeCloseTo(EXIT_MS, 0);
  }
  const ended = probe.changes.find(
    (change) => change.t > closed!.t && !change.closing && !change.shown,
  );
  expect(ended, `${label}: the closing class went`).toBeDefined();
  const exitMs = ended!.t - closed!.t;
  expect(exitMs, `${label}: exit time`).toBeGreaterThanOrEqual(150);
  expect(exitMs, `${label}: exit time`).toBeLessThan(1_500);

  // The exit on its own clock: from the fully shown dialog, fading and moving
  // down all the way (ease-in gives 0.73 and 5.4 px at 100 ms, 0.15 and
  // 17.1 px at 200 ms), displayed throughout.
  expect(probe.error, `${label}: reading the exit on its clock`).toBeNull();
  const seeks = probe.seeks;
  expect(
    seeks.map(({ at }) => at),
    `${label}: the exit read on its clock`,
  ).toEqual(EXIT_SEEK_MS);
  for (const seek of seeks) {
    expect(seek.display, `${label}: displayed ${seek.at} ms into the exit`).toBe('flex');
  }
  expect(seeks[0]!.opacity, `${label}: opacity as the exit starts`).toBeCloseTo(1, 2);
  expect(seeks[0]!.panelY, `${label}: offset as the exit starts`).toBeCloseTo(0, 1);
  expectFadingDown(seeks, label, (index) => `${seeks[index]!.at} ms into the exit`);
  const seekAt = (ms: number): ExitSeek => seeks.find(({ at }) => at === ms)!;
  expect(seekAt(100).opacity, `${label}: part way through the fade`).toBeGreaterThan(0.05);
  expect(seekAt(100).opacity, `${label}: part way through the fade`).toBeLessThan(0.95);
  expect(seekAt(100).panelY, `${label}: part way down`).toBeGreaterThan(1);
  expect(seekAt(100).panelY, `${label}: part way down`).toBeLessThan(19.5);
  expect(seekAt(200).opacity, `${label}: nearly faded`).toBeLessThan(0.2);
  expect(seekAt(200).panelY, `${label}: nearly down`).toBeGreaterThan(15);

  // What a pointer at the panel hits as the close starts: the page under it.
  expect(probe.hits, `${label}: hit tests as the close started`).not.toBeNull();
  expect(probe.hits!.panel, `${label}: a pointer at the closing panel`).toBe(false);

  // The frames the page painted, however many: the same motion, never shown
  // and closing at once.
  expect(probe.frames.some((frame) => frame.shown && frame.closing)).toBe(false);
  const exit = probe.frames.filter(
    (frame) => frame.closing && frame.t >= closed!.t && frame.t <= ended!.t,
  );
  for (const frame of exit) {
    expect(frame.display, `${label}: displayed while closing`).toBe('flex');
  }
  expectFadingDown(exit, `${label} (frames)`, (index) => `${Math.round(exit[index]!.t)} ms`);
  if (hiddenAtEnd) {
    const last = probe.frames.at(-1)!;
    expect(last.display, `${label}: hidden after the exit`).toBe('none');
    expect(last.closing).toBe(false);
  }
  return { closedAt: closed!.t, endedAt: ended!.t };
}

/**
 * Opens the leave confirmation from the logo and presses Stay while its
 * entrance plays, reading the overlay in the task of the close: in the task
 * that opened it, before any frame painted it, or two frames later with the
 * backdrop's entrance set 100 ms in, which keeps it running however long
 * those frames took.
 */
async function closeDuringEntrance(
  page: Page,
  afterFrames: boolean,
): Promise<{ entering: boolean; shown: boolean; closing: boolean; display: string }> {
  await expect(page.locator('#dialog-overlay')).not.toHaveClass(/\b(show|is-closing)\b/);
  return page.evaluate(async (waitForFrames) => {
    const overlay = document.getElementById('dialog-overlay')!;
    document.getElementById('app-logo')!.click();
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (waitForFrames) {
      await frame();
      await frame();
    }
    const entrance = overlay
      .getAnimations()
      .find(
        (animation): animation is CSSAnimation =>
          animation instanceof CSSAnimation && animation.animationName === 'dialogBackdropIn',
      );
    if (entrance && waitForFrames) entrance.currentTime = 100;
    const entering =
      overlay.classList.contains('show') &&
      !!entrance &&
      (entrance.playState === 'running' || entrance.pending);
    document.getElementById('btn-dialog-secondary')!.click();
    return {
      entering,
      shown: overlay.classList.contains('show'),
      closing: overlay.classList.contains('is-closing'),
      display: getComputedStyle(overlay).display,
    };
  }, afterFrames);
}

/** Closes an open dialog in the page and reads the overlay in the same task. */
async function closeAndRead(
  page: Page,
  overlayId: string,
  buttonId: string,
): Promise<{ shown: boolean; closing: boolean; display: string }> {
  return page.evaluate(
    ({ id, button }) => {
      const overlay = document.getElementById(id)!;
      document.getElementById(button)!.click();
      return {
        shown: overlay.classList.contains('show'),
        closing: overlay.classList.contains('is-closing'),
        display: getComputedStyle(overlay).display,
      };
    },
    { id: overlayId, button: buttonId },
  );
}

test('a dialog closed by its button leaves the way it came in, before the next one enters', async ({
  page,
  browserName,
}) => {
  await openRoom(page, browserName);

  // Stay, pressed with the pointer, plays the entrance backwards.
  await openLeaveDialog(page);
  await startProbe(page, 'dialog-overlay');
  await page.locator('#btn-dialog-secondary').click();
  expectReversedEntrance(await readProbe(page), 'Stay');
  await expect(page.locator('#dialog-overlay')).toBeHidden();
  await expect(page.locator('#setup-overlay')).not.toHaveClass(/\bactive\b/);

  // A dialog shown while one leaves waits for the exit, then enters in full.
  await openLeaveDialog(page);
  await startProbe(page, 'dialog-overlay', true);
  await page.evaluate(() => {
    document.getElementById('btn-dialog-secondary')!.click();
    window.setTimeout(() => document.getElementById('app-logo')!.click(), 0);
  });
  const probe = await readProbe(page);
  const { closedAt, endedAt } = expectReversedEntrance(probe, 'queued', false);
  const reopened = probe.changes.find((change) => change.t > closedAt && change.shown);
  expect(reopened, 'the next dialog opened').toBeDefined();
  expect(reopened!.t).toBeGreaterThanOrEqual(endedAt);
  for (const name of ['dialogBackdropIn', 'modalSlideUp']) {
    const entrance = reopened!.animations.find((animation) => animation.name === name);
    expect(entrance, `${name} restarted for the next dialog`).toBeDefined();
    expect(entrance!.currentTime ?? 0, `${name} starts from its first frame`).toBeLessThan(50);
  }
  // Its start is read on the entrance's clock above. It ends fully shown,
  // read once the entrance has ended: a frame a slow machine paints late
  // still shows it part way in.
  await waitForEntrance(page, 'dialog-overlay');
  const rest = await page.evaluate(() => {
    const overlay = document.getElementById('dialog-overlay')!;
    const transform = getComputedStyle(overlay.querySelector('.dialog')!).transform;
    return {
      opacity: Number(getComputedStyle(overlay).opacity),
      panelY: !transform || transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42,
    };
  });
  expect(rest.opacity, 'the next dialog fully shown').toBeGreaterThan(0.99);
  expect(rest.panelY, 'the next dialog in place').toBeCloseTo(0, 0);
  await page.locator('#btn-dialog-secondary').click();
  await expect(page.locator('#dialog-overlay')).toBeHidden();

  // A dialog closed while its entrance plays hides at once, as before the
  // exit existed: the exit starts from the fully shown dialog, so it would
  // jump in before it faded. Unpainted, then part way into its entrance.
  for (const afterFrames of [false, true]) {
    expect(await closeDuringEntrance(page, afterFrames), `after frames: ${afterFrames}`).toEqual({
      entering: true,
      shown: false,
      closing: false,
      display: 'none',
    });
  }
  await expect(page.locator('#setup-overlay')).not.toHaveClass(/\bactive\b/);

  // Reduced motion closes at once, as before the exit existed.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openLeaveDialog(page);
  expect(await closeAndRead(page, 'dialog-overlay', 'btn-dialog-secondary')).toEqual({
    shown: false,
    closing: false,
    display: 'none',
  });
});

test('Back closes a dialog with the same exit, and the Back guard returns after it', async ({
  page,
  browserName,
}) => {
  await openRoom(page, browserName);
  await page.waitForFunction(
    () => (history.state as { mxqrGuard?: { kind?: string } } | null)?.mxqrGuard?.kind === 'guard',
    undefined,
    { timeout: 10_000 },
  );
  await openLeaveDialog(page);
  await page.evaluate(() => {
    const runtime = window as unknown as ProbeWindow;
    const pushes: number[] = [];
    runtime.__guardPushes = pushes;
    const push = history.pushState.bind(history);
    history.pushState = (...args: Parameters<History['pushState']>) => {
      pushes.push(performance.now());
      push(...args);
    };
  });
  await startProbe(page, 'dialog-overlay');

  await page.goBack();

  const probe = await readProbe(page);
  const { endedAt } = expectReversedEntrance(probe, 'Back');
  // Back on the leave confirmation means Stay.
  await expect(page.locator('#setup-overlay')).not.toHaveClass(/\bactive\b/);
  const pushes = () => page.evaluate(() => (window as unknown as ProbeWindow).__guardPushes ?? []);
  await expect.poll(async () => (await pushes()).length).toBeGreaterThan(0);
  // The guard waits for the closing dialog, so it is pushed after the exit.
  expect((await pushes())[0]! - probe.start).toBeGreaterThanOrEqual(endedAt);
});

test('the language list leaves the same way, lets a pointer through its scrollbar, and closes at once under reduced motion', async ({
  page,
  browserName,
}) => {
  // Settings in a room, where nothing else stays open: on the start screen
  // the base screen makes a closing list inert, which would hide what the
  // closing dialog's own rules let a pointer hit.
  await openRoom(page, browserName);
  await navigateToTab(page, 'settings');
  const general = page.locator('.subtab-pill[data-subtab="general"]');
  if (await general.isVisible()) await navigateToSubtab(page, 'general');
  const trigger = page.locator('#btn-language-select');

  await trigger.click();
  await waitForEntrance(page, 'language-dialog-overlay');
  await startProbe(page, 'language-dialog-overlay');
  // Done is pressed while the list's scrollbar shows, as it does for a while
  // after the list opens, scrolls or is hovered: shown here in the same task.
  await page.evaluate(() => {
    const overlay = document.getElementById('language-dialog-overlay');
    (window as unknown as ProbeWindow).__MUSIXQUARE_BUS__.emit('ui:scrollbar-reveal', overlay);
    document.getElementById('btn-language-dialog-done')!.click();
  });
  const probe = await readProbe(page);
  expectReversedEntrance(probe, 'Done');
  // The bar showed and wrote its own pointer-events, yet a pointer there goes
  // through the closing list to the page.
  expect(probe.hits!.track, 'the list scrollbar as the list closed').toEqual({
    inline: 'auto',
    computed: 'none',
    inside: false,
  });
  await expect(page.locator('#language-dialog-overlay')).toBeHidden();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger.click();
  await expect(page.locator('#language-dialog-overlay')).toHaveClass(/\bshow\b/);
  expect(await closeAndRead(page, 'language-dialog-overlay', 'btn-language-dialog-done')).toEqual({
    shown: false,
    closing: false,
    display: 'none',
  });
});
