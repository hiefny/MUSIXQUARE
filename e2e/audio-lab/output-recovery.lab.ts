/**
 * Local audio output-recovery lab (structural plan C1), Chromium only.
 * Run with playwright.audio-lab.config.ts; never a CI job.
 *
 * A host alone in a real room plays a local file. A hidden/visible round
 * trip freezes the AudioContext clock (output-probe.ts) so the app opens its
 * recovery dialog, either the play-request dialog (paused, then PLAY) or the
 * prepared dialog (playing). The rows pin, in Chromium:
 *
 * - (i)/(ii) the two dialogs' outcomes: one retried source start, or one
 *   recovered rejoin;
 * - (a)-(d) app.ts's part of the play-request dialog, which unit tests cannot
 *   load: an outside resume while it waits, its re-suspend, and how its wait
 *   for the clock requirement ends (a newer request, a track change, a hidden
 *   page, the 5 s limit);
 * - T1-T9 trusted input with UI sounds on: slow and fast finger, Space and
 *   Enter, on both dialogs.
 *
 * One room PLAY and one retry() per tap is not pinned directly: a host alone
 * has no peer to receive the room PLAY, and a second retry() is refused
 * inside transport with nothing the lab can read. (i) and T4 pin one source
 * start and one paused-to-playing move per tap; a second activation cannot
 * reach the dialog, which closes inside its first one.
 *
 * Only the window from the return to the tap is frozen, and rows assert
 * counts and origin-tagged calls, not whole op arrays; times are bounded
 * windows. "Known gap (C1-...)" marks today's behaviour where it is not the
 * desired one. A planned C1 increment that would change such a row waits for
 * the owner's decision (owner decision pending); if approved, its test-first
 * commit flips the row. Some counts are Chromium facts (its suspend()
 * promise settles before its statechange) and say so.
 */
import { expect, test, type Page } from '@playwright/test';
import { clickPlayButton, readState, waitForPlaybackProjection } from '../helpers/wait.ts';
import {
  countOps,
  dialogMoves,
  emitNewerPlayRequest,
  holdResume,
  holdSuspend,
  openPlayRequestDialog,
  openPreparedDialog,
  opsFrom,
  pageNow,
  readLab,
  releaseGates,
  resumeFromPageScript,
  setPageVisibility,
  timesOf,
  unfreeze,
  waitForSuspendHeld,
  type LabSnapshot,
} from './output-probe.ts';

const BACKGROUND = 'background-resume:clock-stalled';
const DIALOG = '#dialog-overlay.show';
const OK = '#btn-dialog-ok';

function report(scene: string, lab: LabSnapshot, startsBefore: number): void {
  const { ops, ...rest } = lab;
  console.log(
    `[audio-lab] ${scene} ${JSON.stringify({ ...rest, startsDelta: lab.starts - startsBefore })}`,
  );
  console.log(`[audio-lab] ${scene} ops ${JSON.stringify(opsFrom(ops, 'freeze'))}`);
}

/** The ops from the moment the clock unfroze, just before the tap. */
function fromTap(lab: LabSnapshot): string[] {
  return opsFrom(lab.ops, 'unfreeze');
}

async function okButtonCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator(OK).boundingBox();
  if (!box) throw new Error('recovery dialog button has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function contextState(page: Page): Promise<string | null> {
  return (await readLab(page)).state;
}

test.describe('play-request dialog (paused round trip, then PLAY)', () => {
  test('(i) the tap retries once: one source start, paused to playing', async ({ page }) => {
    const before = await openPlayRequestDialog(page);
    await unfreeze(page);
    await page.locator(OK).click();
    await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 10_000);
    await page.waitForTimeout(1_500);
    const lab = await readLab(page);
    report('(i)', lab, before);

    expect(lab.needed).toEqual(['play:clock-stalled']);
    expect(lab.dialogShows).toBe(1);
    expect(countOps(opsFrom(lab.ops, 'freeze'), ' suspend:')).toBe(1);
    expect(countOps(fromTap(lab), 'resume@')).toBe(1);
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(1);
    expect(lab.starts - before).toBe(1);
    expect(lab.activity).toEqual(['paused', 'playing']);
    expect(lab.rejoins).toEqual([]);
  });

  test('(a) Known gap (C1-I13a): a page script resumes while the dialog waits, the tap plays nothing', async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page);
    await unfreeze(page);
    await resumeFromPageScript(page);
    await page.locator(OK).click();
    await page.waitForTimeout(6_500);
    const lab = await readLab(page);
    report('(a)', lab, before);

    // The attempt still claims the context but nothing listens: the tap's
    // owner resume is refused without a native call, the wait for its clock
    // requirement runs out, and no dialog comes back.
    expect(countOps(fromTap(lab), 'resume@task:')).toBe(1);
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(0);
    expect(lab.starts - before).toBe(0);
    expect(lab.activity).toEqual(['paused']);
    expect(lab.dialogShows).toBe(1);
    await expect(page.locator(DIALOG)).toHaveCount(0);

    // A second PLAY starts the track.
    await clickPlayButton(page);
    await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 10_000);
    const after = await readLab(page);
    expect(after.starts - before).toBe(1);
    expect(after.dialogShows).toBe(1);
  });

  test('(b) Known gap (C1-I13a, no re-suspend): after the outside resume nothing suspends again', async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page);
    await unfreeze(page);
    await holdSuspend(page);
    await resumeFromPageScript(page);
    await page.waitForTimeout(500);
    await page.locator(OK).click();
    await page.waitForTimeout(6_500);
    const lab = await readLab(page);
    report('(b)', lab, before);
    await releaseGates(page);

    expect(lab.suspendHeld).toBe(0);
    expect(countOps(fromTap(lab), ' suspend:')).toBe(0);
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(0);
    expect(lab.starts - before).toBe(0);
    expect(lab.dialogShows).toBe(1);
    await expect(page.locator(DIALOG)).toHaveCount(0);
  });

  test('(d-1) a newer recovery request aborts the wait: cleanup resume in a later task, the new dialog opens', async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page);
    await unfreeze(page);
    // Hold the tap's owner resume so the dialog stays in its requirement wait.
    await holdResume(page, ['click']);
    await page.locator(OK).click();
    await page.waitForTimeout(1_500);
    const abortAt = await emitNewerPlayRequest(page);
    await page.waitForTimeout(1_000);
    const lab = await readLab(page);
    report('(d-1)', lab, before);
    await releaseGates(page);

    expect(lab.resumeHeld).toBe(1);
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(1);
    // Known gap (C1-I12, the wait polls; owner decision pending): the retired
    // attempt's cleanup resume waits for the wait's next 50 ms check, a timer
    // task, so it comes after every microtask the abort queued (the marker).
    // A wait that settles on the owner's promise would put it before.
    const ops = fromTap(lab);
    const marker = ops.findIndex((op) => op.endsWith(' abort+microtasks'));
    const cleanupAt = ops.findIndex((op) => op.includes('resume@task:'));
    expect(marker).toBeGreaterThan(-1);
    expect(cleanupAt).toBeGreaterThan(marker);
    const cleanup = timesOf(ops, 'resume@task:');
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]! - abortAt).toBeGreaterThanOrEqual(0);
    expect(cleanup[0]! - abortAt).toBeLessThan(150);
    expect(lab.needed).toEqual(['play:clock-stalled', 'play:context-not-running']);
    expect(lab.dialogShows).toBe(2);
    expect(lab.starts - before).toBe(0);
  });

  test('(d-1) a track change while the dialog waits: the old retry never starts', async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page, { tracks: 2 });
    const queueItem = await readState(page, 'playlist.currentQueueItemId');
    await unfreeze(page);
    await holdResume(page, ['click']);
    await page.locator(OK).click();
    await page.waitForTimeout(1_500);
    await page.locator('#btn-next').click();
    await page.waitForTimeout(7_000);
    const lab = await readLab(page);
    report('(d-1 track)', lab, before);
    await releaseGates(page);

    // The one new start is the next track's: the old retry never runs and no
    // dialog comes back. (The retired attempt's cleanup resume runs after the
    // change; its time is not pinned here.)
    expect(await readState(page, 'playlist.currentQueueItemId')).not.toBe(queueItem);
    expect(await readState(page, 'playback.activity')).toBe('playing');
    expect(lab.starts - before).toBe(1);
    expect(lab.dialogShows).toBe(1);
    expect(lab.needed).toEqual(['play:clock-stalled']);
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(1);
  });

  test('(d-2) the page hides while the dialog waits: no cleanup resume, then PLAY starts the track', async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page);
    await unfreeze(page);
    await holdResume(page, ['click']);
    await page.locator(OK).click();
    await page.waitForTimeout(1_500);
    await setPageVisibility(page, 'hidden');
    await page.waitForTimeout(2_000);
    const hidden = await readLab(page);
    await setPageVisibility(page, 'visible');
    // Read past the 5 s limit and the 750 ms flight: without the hide, the
    // cleanup resume would be logged by now ((d-3), 5.5 to 6.5 s after the tap).
    await page.waitForTimeout(3_500);
    const lab = await readLab(page);
    const readAt = await pageNow(page);
    report('(d-2)', lab, before);

    const tapAt = timesOf(fromTap(lab), 'resume@click:');
    expect(tapAt).toHaveLength(1);
    expect(readAt - tapAt[0]!).toBeGreaterThan(6_500);
    expect(countOps(fromTap(hidden), 'resume@task:')).toBe(0);
    expect(countOps(fromTap(lab), 'resume@task:')).toBe(0);
    expect(lab.state).toBe('suspended');
    expect(lab.starts - before).toBe(0);
    expect(lab.dialogShows).toBe(1);

    await releaseGates(page);
    await page.waitForTimeout(500);
    await clickPlayButton(page);
    await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 10_000);
    expect((await readLab(page)).starts - before).toBe(1);
  });

  test('(d-3) nothing happens: the wait gives up at its 5 s limit and the cleanup resume follows', async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page);
    await unfreeze(page);
    await holdResume(page, ['click']);
    await page.locator(OK).click();
    await page.waitForTimeout(7_000);
    const lab = await readLab(page);
    report('(d-3)', lab, before);
    await releaseGates(page);

    const tapAt = timesOf(fromTap(lab), 'resume@click:');
    const cleanup = timesOf(fromTap(lab), 'resume@task:');
    expect(tapAt).toHaveLength(1);
    expect(cleanup).toHaveLength(1);
    // The 750 ms gesture flight, then the 5 s requirement wait.
    expect(cleanup[0]! - tapAt[0]!).toBeGreaterThanOrEqual(5_500);
    expect(cleanup[0]! - tapAt[0]!).toBeLessThanOrEqual(6_500);
    expect(lab.starts - before).toBe(0);
    expect(lab.dialogShows).toBe(1);
  });
});

test.describe('prepared dialog (playing round trip)', () => {
  test('(ii) the tap rejoins once; Known gap (C1-I11, one prepared notice): the dialog opens twice in Chromium', async ({
    page,
  }) => {
    const before = await openPreparedDialog(page);
    await unfreeze(page);
    await page.locator(OK).click();
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await page.waitForTimeout(2_000);
    const lab = await readLab(page);
    report('(ii)', lab, before);

    expect(lab.rejoins).toEqual(['audio-context-recovered']);
    expect(lab.starts - before).toBe(1);
    expect(countOps(fromTap(lab), 'resume@')).toBe(1);
    expect(await readState(page, 'playback.activity')).toBe('playing');
    // One stall, two notices: the dialog shows, closes and shows again
    // within a few ms before the tap.
    expect(lab.needed).toEqual([BACKGROUND, BACKGROUND]);
    expect(lab.dialogShows).toBe(2);
    const returned = opsFrom(lab.ops, 'freeze');
    expect(dialogMoves(returned)).toEqual([
      'dialog:shown',
      'dialog:hidden',
      'dialog:shown',
      'dialog:hidden',
    ]);
    const shown = timesOf(returned, 'dialog:shown');
    expect(shown[1]! - shown[0]!).toBeLessThan(100);
  });
});

test.describe('trusted input with UI sounds on, play-request dialog', () => {
  test('T1 Known gap (C1-I13b): a slow finger wakes the context on pointerdown, the tap plays nothing', async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page, { uiSounds: true });
    await unfreeze(page);
    const { x, y } = await okButtonCenter(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect.poll(() => contextState(page)).toBe('running');
    await page.mouse.up();
    await page.waitForTimeout(6_500);
    const lab = await readLab(page);
    report('T1', lab, before);

    expect(countOps(fromTap(lab), 'resume@pointerdown:')).toBe(1);
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(0);
    expect(lab.starts - before).toBe(0);
    expect(lab.activity).toEqual(['paused']);
    expect(lab.dialogShows).toBe(1);
    await expect(page.locator(DIALOG)).toHaveCount(0);
  });

  test('T2 a fast finger: the UI-sound resume lands after the click, the tap retries', async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page, { uiSounds: true });
    await unfreeze(page);
    await holdResume(page, ['pointerdown']);
    await page.locator(OK).click();
    await releaseGates(page);
    await page.waitForTimeout(3_000);
    const lab = await readLab(page);
    report('T2', lab, before);

    expect(countOps(fromTap(lab), 'resume@pointerdown:')).toBe(1);
    // The owner's resume and the UI touch sound's.
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(2);
    expect(lab.starts - before).toBe(1);
    expect(lab.activity).toEqual(['paused', 'playing']);
    expect(lab.dialogShows).toBe(1);
  });

  test('T3 Known gap (C1-I13b): Space held wakes the context on keydown, the release plays nothing', async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page, { uiSounds: true });
    await unfreeze(page);
    await page.keyboard.down(' ');
    await expect.poll(() => contextState(page)).toBe('running');
    await page.keyboard.up(' ');
    await page.waitForTimeout(6_500);
    const lab = await readLab(page);
    report('T3', lab, before);

    expect(countOps(fromTap(lab), 'resume@keydown:')).toBe(1);
    expect(countOps(fromTap(lab), 'resume@')).toBe(1);
    expect(lab.starts - before).toBe(0);
    expect(lab.activity).toEqual(['paused']);
    expect(lab.dialogShows).toBe(1);
    await expect(page.locator(DIALOG)).toHaveCount(0);
  });

  test("T4 Enter: two resumes in one keydown (the UI sound's and the owner's), the tap retries", async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page, { uiSounds: true });
    await unfreeze(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3_000);
    const lab = await readLab(page);
    report('T4', lab, before);

    const keydown = fromTap(lab).filter((op) => op.includes('resume@'));
    expect(keydown).toHaveLength(2);
    expect(keydown.every((op) => op.endsWith('resume@keydown:suspended'))).toBe(true);
    expect(lab.starts - before).toBe(1);
    expect(lab.activity).toEqual(['paused', 'playing']);
    expect(lab.dialogShows).toBe(1);
  });
});

test.describe('trusted input with UI sounds on, prepared dialog', () => {
  test('T5 a slow finger after the re-suspend landed: the dialog reopens under the finger and the release succeeds', async ({
    page,
  }) => {
    const before = await openPreparedDialog(page, { uiSounds: true });
    await unfreeze(page);
    const { x, y } = await okButtonCenter(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect
      .poll(async () => countOps(fromTap(await readLab(page)), 'statechange:suspended'))
      .toBe(1);
    await page.waitForTimeout(500);
    await page.mouse.up();
    await page.waitForTimeout(3_000);
    const lab = await readLab(page);
    report('T5', lab, before);

    expect(countOps(fromTap(lab), 'resume@pointerdown:')).toBe(1);
    expect(lab.needed).toEqual([BACKGROUND, BACKGROUND, BACKGROUND]);
    expect(lab.dialogShows).toBe(3);
    expect(lab.rejoins).toEqual(['audio-context-recovered']);
    expect(lab.starts - before).toBe(1);
  });

  test('T6 Known gap (C1-I13b): a slow finger released while the re-suspend is held is refused; a second tap succeeds', async ({
    page,
  }) => {
    const before = await openPreparedDialog(page, { uiSounds: true });
    await unfreeze(page);
    await holdSuspend(page);
    const { x, y } = await okButtonCenter(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    // The page signals the held re-suspend, so the only wall-clock wait
    // before the release is the 150 ms below (the owner's suspend watchdog
    // runs out at 750 ms).
    await waitForSuspendHeld(page);
    await page.mouse.up();
    await page.waitForTimeout(150);
    const refused = await readLab(page);
    await releaseGates(page);
    await expect(page.locator(DIALOG)).toBeVisible();
    await page.locator(OK).click();
    await page.waitForTimeout(3_000);
    const lab = await readLab(page);
    report('T6', lab, before);

    // The release closed the dialog and issued no resume of its own: only the
    // UI sound's on pointerdown, while the re-suspend was held.
    expect(refused.suspendHeld).toBe(1);
    expect(dialogMoves(fromTap(refused)).at(-1)).toBe('dialog:hidden');
    expect(countOps(fromTap(refused), 'resume@')).toBe(1);
    expect(countOps(fromTap(refused), 'resume@pointerdown:')).toBe(1);
    expect(refused.dialogShows).toBe(2);
    expect(lab.dialogShows).toBe(3);
    expect(countOps(fromTap(lab), 'resume@pointerdown:')).toBe(2);
    expect(lab.rejoins).toEqual(['audio-context-recovered']);
    expect(lab.starts - before).toBe(1);
  });

  test('T7 a fast finger: the tap succeeds', async ({ page }) => {
    const before = await openPreparedDialog(page, { uiSounds: true });
    await unfreeze(page);
    await holdResume(page, ['pointerdown']);
    await page.locator(OK).click();
    await releaseGates(page);
    await page.waitForTimeout(3_000);
    const lab = await readLab(page);
    report('T7', lab, before);

    expect(countOps(fromTap(lab), 'resume@pointerdown:')).toBe(1);
    expect(lab.dialogShows).toBe(2);
    expect(lab.rejoins).toEqual(['audio-context-recovered']);
    expect(lab.starts - before).toBe(1);
  });

  test('T8 Known gap (C1-I13b): Space held until the re-suspend landed is lost on release; a second press succeeds', async ({
    page,
  }) => {
    const before = await openPreparedDialog(page, { uiSounds: true });
    await unfreeze(page);
    await page.keyboard.down(' ');
    await expect
      .poll(async () => countOps(fromTap(await readLab(page)), 'statechange:suspended'))
      .toBe(1);
    await page.waitForTimeout(500);
    await page.keyboard.up(' ');
    await page.waitForTimeout(3_000);
    const lab = await readLab(page);
    report('T8', lab, before);

    // Unlike the finger (T5), the release does not reach the reopened dialog:
    // it stays open over a suspended context.

    expect(countOps(fromTap(lab), 'resume@keydown:')).toBe(1);
    expect(lab.needed).toEqual([BACKGROUND, BACKGROUND, BACKGROUND]);
    expect(lab.dialogShows).toBe(3);
    expect(lab.rejoins).toEqual([]);
    expect(lab.state).toBe('suspended');
    expect(lab.starts - before).toBe(0);
    await expect(page.locator(DIALOG)).toBeVisible();

    // A second, quick press: the UI sound's keydown resume is held until the
    // press is over, so the owner's resume runs first and succeeds.
    await holdResume(page, ['keydown']);
    await page.keyboard.press(' ');
    await releaseGates(page);
    await page.waitForTimeout(3_000);
    const again = await readLab(page);
    report('T8 again', again, before);
    expect(countOps(fromTap(again), 'resume@keydown:')).toBe(2);
    expect(again.dialogShows).toBe(3);
    expect(again.rejoins).toEqual(['audio-context-recovered']);
    expect(again.starts - before).toBe(1);
  });

  test('T9 Enter: two resumes in one keydown, the tap succeeds', async ({ page }) => {
    const before = await openPreparedDialog(page, { uiSounds: true });
    await unfreeze(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3_000);
    const lab = await readLab(page);
    report('T9', lab, before);

    expect(countOps(fromTap(lab), 'resume@keydown:')).toBe(2);
    expect(lab.dialogShows).toBe(2);
    expect(lab.rejoins).toEqual(['audio-context-recovered']);
    expect(lab.starts - before).toBe(1);
  });
});
