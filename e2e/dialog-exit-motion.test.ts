/**
 * Dialog exit motion: a dialog leaves the way it came in.
 *
 * Owner report: every dialog slid up from below when it appeared but vanished
 * with no animation. A closing dialog now plays its entrance in reverse
 * (css/style.css dialogBackdropOut and modalSlideDown, 0.22 s ease-in) under
 * the is-closing class, which src/ui/dom.ts holds until the overlay's own
 * animation ends. The dialog is closed for input, focus and Back at once.
 *
 * A probe in the page reads, every frame, the overlay's classes and display,
 * its opacity and the panel's vertical offset, and records each class change
 * with the CSS animations it started. The checks are bounds, not exact
 * frames: the exit lasts about 0.22 s while the backdrop fades and the panel
 * moves down toward 20 px, then the overlay is hidden.
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

test.use({ serviceWorkers: 'block' });

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

interface ExitProbe {
  /** performance.now() when the probe started. */
  start: number;
  frames: ExitFrame[];
  changes: ClassChange[];
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
    ({ id, untilShownAgain: waitForReopen }) => {
      const overlay = document.getElementById(id)!;
      const panel = overlay.querySelector<HTMLElement>('.dialog')!;
      const start = performance.now();
      const probe: ExitProbe = { start, frames: [], changes: [], done: false };
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
      const observer = new MutationObserver(() => {
        probe.changes.push({
          t: performance.now() - start,
          shown: overlay.classList.contains('show'),
          closing: overlay.classList.contains('is-closing'),
          animations: [...cssAnimations(overlay, 'overlay'), ...cssAnimations(panel, 'panel')],
        });
      });
      observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
      let closed = false;
      let shownAgainAt: number | null = null;
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
    { id: overlayId, untilShownAgain },
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
 * Checks one close in the probe: the entrance played backwards for about the
 * exit time, then the overlay hid (unless `hiddenAtEnd` is false, for a probe
 * that goes on to the next dialog). Returns the close and its end, in probe
 * time.
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
    expect(animation.duration, `${label}: ${animation.name} duration`).toBeCloseTo(220, 0);
  }
  const ended = probe.changes.find(
    (change) => change.t > closed!.t && !change.closing && !change.shown,
  );
  expect(ended, `${label}: the closing class went`).toBeDefined();
  const exitMs = ended!.t - closed!.t;
  expect(exitMs, `${label}: exit time`).toBeGreaterThanOrEqual(150);
  expect(exitMs, `${label}: exit time`).toBeLessThan(1_500);

  expect(probe.frames.some((frame) => frame.shown && frame.closing)).toBe(false);
  const exit = probe.frames.filter(
    (frame) => frame.closing && frame.t >= closed!.t && frame.t <= ended!.t,
  );
  expect(exit.length, `${label}: frames painted during the exit`).toBeGreaterThanOrEqual(2);
  for (const [index, frame] of exit.entries()) {
    expect(frame.display, `${label}: displayed while closing`).toBe('flex');
    expect(frame.panelY).toBeGreaterThanOrEqual(-0.5);
    expect(frame.panelY).toBeLessThanOrEqual(20.5);
    if (index === 0) continue;
    const previous = exit[index - 1]!;
    // The backdrop only fades and the panel only moves down.
    expect(frame.opacity, `${label}: opacity at ${Math.round(frame.t)} ms`).toBeLessThanOrEqual(
      previous.opacity + 0.02,
    );
    expect(frame.panelY, `${label}: offset at ${Math.round(frame.t)} ms`).toBeGreaterThanOrEqual(
      previous.panelY - 0.5,
    );
  }
  expect(
    exit.some((frame) => frame.opacity > 0.05 && frame.opacity < 0.95),
    `${label}: a frame part way through the fade`,
  ).toBe(true);
  expect(
    exit.some((frame) => frame.panelY > 1 && frame.panelY < 19.5),
    `${label}: a frame part way down`,
  ).toBe(true);
  if (hiddenAtEnd) {
    const last = probe.frames.at(-1)!;
    expect(last.display, `${label}: hidden after the exit`).toBe('none');
    expect(last.closing).toBe(false);
  }
  return { closedAt: closed!.t, endedAt: ended!.t };
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
  const entering = probe.frames.filter((frame) => frame.t >= reopened!.t && frame.shown);
  expect(entering.length).toBeGreaterThanOrEqual(2);
  expect(entering[0]!.opacity, 'the next dialog fades in').toBeLessThan(0.9);
  expect(entering.at(-1)!.opacity).toBeGreaterThan(0.99);
  expect(entering.at(-1)!.panelY).toBeCloseTo(0, 0);
  await page.locator('#btn-dialog-secondary').click();
  await expect(page.locator('#dialog-overlay')).toBeHidden();

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

test('the language list leaves the same way, and at once under reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await injectPeerServer(page);
  await useAnonymousAccountSession(page);
  await page.goto('/');
  await waitForBootstrapReady(page);
  // The start screen's language button opens the list outside a room.
  const trigger = page.locator('[data-setup-language-trigger]').first();

  await trigger.click();
  await waitForEntrance(page, 'language-dialog-overlay');
  await startProbe(page, 'language-dialog-overlay');
  await page.locator('#btn-language-dialog-done').click();
  expectReversedEntrance(await readProbe(page), 'Done');
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
