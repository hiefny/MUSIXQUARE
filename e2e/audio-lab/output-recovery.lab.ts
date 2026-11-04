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
 * - (iii) app.ts's part of two recoveries asking to park the audio at once
 *   (a seek while the return check parks it): which dialog stays, and what
 *   its button does (Phase 7 7B-4);
 * - (a)-(d) app.ts's part of the play-request dialog, which unit tests cannot
 *   load: an outside resume while it waits and the owner parking it again, a
 *   tap inside that re-park (the same request shown once more), and how its
 *   wait for the clock requirement ends (a newer request, a track change, a
 *   hidden page, the 5 s limit);
 * - T1-T9 trusted input with UI sounds on: slow and fast finger, Space and
 *   Enter, on both dialogs. While an owner holds the context for the
 *   dialog's tap the UI sounds ask first and stay silent (Phase 7 7B-3):
 *   no resume on pointerdown or keydown, no press sound (`ms tone`).
 *
 * One room PLAY and one retry() per failed PLAY is not pinned directly: a
 * host alone has no peer to receive the room PLAY, and a second retry() is
 * refused inside transport with nothing the lab can read. (i), (a), (b) and
 * T4 pin one source start and one paused-to-playing move per failed PLAY; a
 * second activation cannot reach the dialog, which closes inside its first
 * one.
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
  bounce,
  countOps,
  dialogMoves,
  emitNewerPlayRequest,
  holdResume,
  holdSuspend,
  markOps,
  openPlayRequestDialog,
  openPlaying,
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

  test('(a) a page script resumes while the dialog waits: the owner parks it again, one tap plays', async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page);
    await unfreeze(page);
    await resumeFromPageScript(page);
    // Phase 7 7B-2 (C1-I13a, owner answer Q8; it was a Known gap): the
    // play-request owner parks the woken context again at once, and the
    // dialog stays as it was. Tap once it is parked.
    await expect
      .poll(async () => countOps(fromTap(await readLab(page)), 'statechange:suspended'))
      .toBe(1);
    await page.locator(OK).click();
    await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 10_000);
    await page.waitForTimeout(1_500);
    const lab = await readLab(page);
    report('(a)', lab, before);

    // One wake (the page script's; no cleanup resume follows), one re-park,
    // then the tap's owner resume, and one retried start.
    const ops = fromTap(lab);
    expect(countOps(ops, 'resume@task:')).toBe(1);
    expect(countOps(ops, ' suspend:')).toBe(1);
    expect(countOps(ops, 'resume@click:')).toBe(1);
    const woke = ops.findIndex((op) => op.includes('resume@task:'));
    const parked = ops.findIndex((op) => op.includes(' suspend:'));
    const tapped = ops.findIndex((op) => op.includes('resume@click:'));
    expect(parked).toBeGreaterThan(woke);
    expect(tapped).toBeGreaterThan(parked);
    expect(lab.needed).toEqual(['play:clock-stalled']);
    expect(lab.dialogShows).toBe(1);
    expect(lab.starts - before).toBe(1);
    expect(lab.activity).toEqual(['paused', 'playing']);
    await expect(page.locator(DIALOG)).toHaveCount(0);
  });

  test('(b) a tap while the owner parks it again only closes the dialog; the same dialog shows once more and its tap plays', async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page);
    await unfreeze(page);
    await holdSuspend(page);
    await resumeFromPageScript(page);
    // The page signals the held re-park, so the tap lands inside it. The
    // release follows within the owner's 750 ms suspend watchdog.
    await waitForSuspendHeld(page);
    await page.locator(OK).click();
    await page.waitForTimeout(150);
    const refused = await readLab(page);
    await releaseGates(page);
    await expect(page.locator(DIALOG)).toBeVisible();
    await page.locator(OK).click();
    await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 10_000);
    await page.waitForTimeout(1_500);
    const lab = await readLab(page);
    report('(b)', lab, before);

    // Phase 7 7B-2 (C1-I13a, owner answer Q8; it was a Known gap, no
    // re-suspend): the tap inside the held re-park issued no resume and only
    // closed the dialog. app.ts kept the attempt (no cleanup resume) and,
    // once the owner had parked it, showed the same request again with no
    // new notice; that dialog's tap retried the failed PLAY once.
    expect(refused.suspendHeld).toBe(1);
    expect(dialogMoves(fromTap(refused)).at(-1)).toBe('dialog:hidden');
    expect(countOps(fromTap(refused), 'resume@')).toBe(1);
    expect(countOps(fromTap(lab), 'resume@task:')).toBe(1);
    expect(countOps(fromTap(lab), ' suspend:')).toBe(1);
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(1);
    expect(dialogMoves(fromTap(lab))).toEqual(['dialog:hidden', 'dialog:shown', 'dialog:hidden']);
    expect(lab.needed).toEqual(['play:clock-stalled']);
    expect(lab.dialogShows).toBe(2);
    expect(lab.starts - before).toBe(1);
    expect(lab.activity).toEqual(['paused', 'playing']);
  });

  test("(d-1) a newer recovery request aborts the wait: cleanup resume within the abort's own task, the new dialog opens", async ({
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
    // C1-I12 (Phase 7 7B-5, owner answer Q7; it was a Known gap, the wait
    // polled): the wait ends on the dialog's AbortSignal, so the retired
    // attempt's cleanup resume follows through promises alone, before the
    // marker logged after every microtask the abort queued. Before, it waited
    // for the wait's next 50 ms check, a timer task after the marker.
    const ops = fromTap(lab);
    const marker = ops.findIndex((op) => op.endsWith(' abort+microtasks'));
    const cleanupAt = ops.findIndex((op) => op.includes('resume@task:'));
    expect(marker).toBeGreaterThan(-1);
    expect(cleanupAt).toBeGreaterThan(-1);
    expect(cleanupAt).toBeLessThan(marker);
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
    await markOps(page, 'next-track');
    await page.locator('#btn-next').click();
    await page.waitForTimeout(7_000);
    const lab = await readLab(page);
    report('(d-1 track)', lab, before);
    await releaseGates(page);

    // The one new start is the next track's: the old retry never runs and no
    // dialog comes back. Before the change, one resume: the dialog tap's.
    // (The retired attempt's cleanup resume runs after the change; its time
    // is not pinned here. Since Phase 7 7B-5 the wait ends on the abort at
    // once, so it can run inside the next-track click itself, logged as
    // `resume@click`; it came at the wait's next 50 ms poll, `resume@task`.)
    expect(await readState(page, 'playlist.currentQueueItemId')).not.toBe(queueItem);
    expect(await readState(page, 'playback.activity')).toBe('playing');
    expect(lab.starts - before).toBe(1);
    expect(lab.dialogShows).toBe(1);
    expect(lab.needed).toEqual(['play:clock-stalled']);
    const ops = fromTap(lab);
    const next = ops.findIndex((op) => op.endsWith(' next-track'));
    expect(next).toBeGreaterThan(-1);
    expect(countOps(ops.slice(0, next), 'resume@')).toBe(1);
    expect(countOps(ops.slice(0, next), 'resume@click:')).toBe(1);
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

  test("(iii) a seek while the return check parks the audio: one suspend, one dialog request, the seek's, and its tap plays from the moved position", async ({
    page,
  }) => {
    await openPlaying(page);
    const { starts: before } = await readLab(page);
    // The return check's suspend lands late: the gate holds that first
    // suspend only.
    await holdSuspend(page, 1);
    await bounce(page);
    await waitForSuspendHeld(page);
    const slider = page.locator('#seek-slider');
    const duration = Number(await slider.getAttribute('max'));
    const rail = await slider.boundingBox();
    if (!rail) throw new Error('The seek rail must be visible');
    await slider.click({ position: { x: rail.width * 0.6, y: rail.height / 2 } });
    // The seek's PLAY checks the frozen clock (two 180 ms samples) and asks
    // for its suspend; the held one goes on after that, inside its lease's
    // 750 ms watchdog.
    await page.waitForTimeout(500);
    await releaseGates(page);
    await expect(page.locator(DIALOG)).toBeVisible();
    await page.waitForTimeout(1_000);
    const shown = await readLab(page);
    await unfreeze(page);
    await page.locator(OK).click();
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await page.waitForTimeout(1_500);
    const lab = await readLab(page);
    const position = Number(await slider.inputValue());
    report('(iii)', lab, before);
    console.log(`[audio-lab] (iii) position ${position} of ${duration}`);

    // Phase 7 7B-4 (owner answer Q6; it was Known gap C1-I11, two leases):
    // the seek's request takes the return check's lease over, so one native
    // suspend and one dialog request, the later-started seek's; the return
    // check's attempt retires with no notice. Its dialog stays, and its
    // button retries the seek's PLAY: the track plays from the moved
    // position. Before (measured on App 9.0.34 in Chromium): two suspends,
    // three requests (the seek's and two of the return's), the dialog
    // flashing two or three times, and the return dialog staying, whose
    // button only realigned the old flow and lost the seek.
    const returned = opsFrom(lab.ops, 'freeze');
    expect(countOps(returned, ' suspend:')).toBe(1);
    expect(shown.needed).toEqual(['play:clock-stalled']);
    expect(lab.needed).toEqual(['play:clock-stalled']);
    expect(dialogMoves(returned)).toEqual(['dialog:shown', 'dialog:hidden']);
    expect(lab.dialogShows).toBe(1);
    expect(countOps(fromTap(lab), 'resume@')).toBe(1);
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(1);
    expect(lab.starts - before).toBe(1);
    expect(lab.rejoins).toEqual([]);
    expect(position).toBeGreaterThan(duration * 0.5);
  });
});

test.describe('trusted input with UI sounds on, play-request dialog', () => {
  test('T1 a slow finger: no sound and no wake on pointerdown while the owner holds the context, and the release plays (it was Known gap C1-I13b)', async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page, { uiSounds: true });
    await unfreeze(page);
    const { x, y } = await okButtonCenter(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    // Phase 7 7B-3 (C1-I13b, owner answer Q9): the touch sound asks the owner
    // first, which holds the parked context for this dialog's tap, so it
    // wakes nothing (before: it woke the context, and since 7B-2 the owner
    // parked it again under the finger).
    await page.waitForTimeout(500);
    const pressed = await readLab(page);
    await page.mouse.up();
    await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 10_000);
    await page.waitForTimeout(1_500);
    const lab = await readLab(page);
    report('T1', lab, before);

    expect(countOps(fromTap(pressed), 'resume@')).toBe(0);
    expect(pressed.state).toBe('suspended');
    expect(countOps(fromTap(lab), 'resume@pointerdown:')).toBe(0);
    expect(countOps(fromTap(lab), ' suspend:')).toBe(0);
    // The owner's resume alone, and no press sound.
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(1);
    expect(countOps(fromTap(lab), ' tone')).toBe(0);
    expect(lab.starts - before).toBe(1);
    expect(lab.activity).toEqual(['paused', 'playing']);
    expect(lab.dialogShows).toBe(1);
    await expect(page.locator(DIALOG)).toHaveCount(0);
  });

  test("T2 a fast finger: one resume, the owner's, no press sound, the tap retries", async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page, { uiSounds: true });
    await unfreeze(page);
    await page.locator(OK).click();
    await page.waitForTimeout(3_000);
    const lab = await readLab(page);
    report('T2', lab, before);

    // Phase 7 7B-3 (Q9): before, the touch sound also resumed on pointerdown
    // and on the click.
    expect(countOps(fromTap(lab), 'resume@pointerdown:')).toBe(0);
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(1);
    expect(countOps(fromTap(lab), ' tone')).toBe(0);
    expect(lab.starts - before).toBe(1);
    expect(lab.activity).toEqual(['paused', 'playing']);
    expect(lab.dialogShows).toBe(1);
  });

  test('T3 Space held: no sound and no wake on keydown while the owner holds the context, and the release plays (it was Known gap C1-I13b)', async ({
    page,
  }) => {
    const before = await openPlayRequestDialog(page, { uiSounds: true });
    await unfreeze(page);
    await page.keyboard.down(' ');
    // As T1, under the held key (Phase 7 7B-3, Q9).
    await page.waitForTimeout(500);
    const pressed = await readLab(page);
    await page.keyboard.up(' ');
    await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 10_000);
    await page.waitForTimeout(1_500);
    const lab = await readLab(page);
    report('T3', lab, before);

    expect(countOps(fromTap(pressed), 'resume@')).toBe(0);
    expect(pressed.state).toBe('suspended');
    expect(countOps(fromTap(lab), 'resume@keydown:')).toBe(0);
    expect(countOps(fromTap(lab), ' suspend:')).toBe(0);
    // The release's click: the owner's resume alone, and no press sound.
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(1);
    expect(countOps(fromTap(lab), ' tone')).toBe(0);
    expect(lab.starts - before).toBe(1);
    expect(lab.activity).toEqual(['paused', 'playing']);
    expect(lab.dialogShows).toBe(1);
    await expect(page.locator(DIALOG)).toHaveCount(0);
  });

  test("T4 Enter: one resume in the keydown, the owner's, the tap retries", async ({ page }) => {
    const before = await openPlayRequestDialog(page, { uiSounds: true });
    await unfreeze(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3_000);
    const lab = await readLab(page);
    report('T4', lab, before);

    // Phase 7 7B-3 (Q9): before, the UI sound's keydown resume came first.
    const keydown = fromTap(lab).filter((op) => op.includes('resume@'));
    expect(keydown).toHaveLength(1);
    expect(keydown.every((op) => op.endsWith('resume@keydown:suspended'))).toBe(true);
    expect(countOps(fromTap(lab), ' tone')).toBe(0);
    expect(lab.starts - before).toBe(1);
    expect(lab.activity).toEqual(['paused', 'playing']);
    expect(lab.dialogShows).toBe(1);
  });
});

test.describe('trusted input with UI sounds on, prepared dialog', () => {
  test('T5 a slow finger: nothing wakes the context under it, the dialog stays and the release restores', async ({
    page,
  }) => {
    const before = await openPreparedDialog(page, { uiSounds: true });
    await unfreeze(page);
    const { x, y } = await okButtonCenter(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    // Phase 7 7B-3 (Q9): before, the touch sound woke the context on
    // pointerdown, the owner re-suspended it, and the dialog closed and
    // reopened under the finger with a third notice.
    await page.waitForTimeout(500);
    const pressed = await readLab(page);
    await page.mouse.up();
    await page.waitForTimeout(3_000);
    const lab = await readLab(page);
    report('T5', lab, before);

    expect(countOps(fromTap(pressed), 'resume@')).toBe(0);
    expect(pressed.state).toBe('suspended');
    expect(countOps(fromTap(lab), 'resume@pointerdown:')).toBe(0);
    expect(countOps(fromTap(lab), ' suspend:')).toBe(0);
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(1);
    expect(countOps(fromTap(lab), ' tone')).toBe(0);
    // The two notices of one stall before the tap (known gap 3, row (ii)).
    expect(lab.needed).toEqual([BACKGROUND, BACKGROUND]);
    expect(lab.dialogShows).toBe(2);
    expect(lab.rejoins).toEqual(['audio-context-recovered']);
    expect(lab.starts - before).toBe(1);
  });

  test('T6 a slow finger held down: no re-suspend lands under it, and the release restores at once (it was Known gap C1-I13b)', async ({
    page,
  }) => {
    const before = await openPreparedDialog(page, { uiSounds: true });
    await unfreeze(page);
    // Any suspend while the finger is down would be held here. Before Phase
    // 7 7B-3 (Q9) the touch sound's pointerdown resume made the owner
    // re-suspend, a release during that re-suspend was refused and only a
    // second tap restored.
    await holdSuspend(page);
    const { x, y } = await okButtonCenter(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(300);
    const pressed = await readLab(page);
    await page.mouse.up();
    await page.waitForTimeout(3_000);
    const lab = await readLab(page);
    await releaseGates(page);
    report('T6', lab, before);

    expect(pressed.suspendHeld).toBe(0);
    expect(countOps(fromTap(pressed), 'resume@')).toBe(0);
    expect(pressed.state).toBe('suspended');
    expect(lab.suspendHeld).toBe(0);
    expect(countOps(fromTap(lab), 'resume@pointerdown:')).toBe(0);
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(1);
    expect(countOps(fromTap(lab), ' tone')).toBe(0);
    // No reopen: the two shows of one stall before the tap (known gap 3).
    expect(lab.dialogShows).toBe(2);
    expect(lab.rejoins).toEqual(['audio-context-recovered']);
    expect(lab.starts - before).toBe(1);
    await expect(page.locator(DIALOG)).toHaveCount(0);
  });

  test("T7 a fast finger: one resume, the owner's, and the tap succeeds", async ({ page }) => {
    const before = await openPreparedDialog(page, { uiSounds: true });
    await unfreeze(page);
    await page.locator(OK).click();
    await page.waitForTimeout(3_000);
    const lab = await readLab(page);
    report('T7', lab, before);

    // Phase 7 7B-3 (Q9): before, the touch sound also resumed on pointerdown.
    expect(countOps(fromTap(lab), 'resume@pointerdown:')).toBe(0);
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(1);
    expect(countOps(fromTap(lab), ' tone')).toBe(0);
    expect(lab.dialogShows).toBe(2);
    expect(lab.rejoins).toEqual(['audio-context-recovered']);
    expect(lab.starts - before).toBe(1);
  });

  test('T8 Space held: no sound and no wake under the key, and the release restores (it was Known gap C1-I13b)', async ({
    page,
  }) => {
    const before = await openPreparedDialog(page, { uiSounds: true });
    await unfreeze(page);
    await page.keyboard.down(' ');
    // Phase 7 7B-3 (Q9): before, the keydown sound woke the context, the
    // owner re-suspended it and reopened the dialog, the release was lost and
    // a second press was needed.
    await page.waitForTimeout(500);
    const pressed = await readLab(page);
    await page.keyboard.up(' ');
    await page.waitForTimeout(3_000);
    const lab = await readLab(page);
    report('T8', lab, before);

    expect(countOps(fromTap(pressed), 'resume@')).toBe(0);
    expect(pressed.state).toBe('suspended');
    expect(countOps(fromTap(lab), 'resume@keydown:')).toBe(0);
    expect(countOps(fromTap(lab), ' suspend:')).toBe(0);
    expect(countOps(fromTap(lab), 'resume@click:')).toBe(1);
    expect(countOps(fromTap(lab), ' tone')).toBe(0);
    expect(lab.needed).toEqual([BACKGROUND, BACKGROUND]);
    expect(lab.dialogShows).toBe(2);
    expect(lab.rejoins).toEqual(['audio-context-recovered']);
    expect(lab.state).toBe('running');
    expect(lab.starts - before).toBe(1);
    await expect(page.locator(DIALOG)).toHaveCount(0);
  });

  test("T9 Enter: one resume in the keydown, the owner's, and the tap succeeds", async ({
    page,
  }) => {
    const before = await openPreparedDialog(page, { uiSounds: true });
    await unfreeze(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3_000);
    const lab = await readLab(page);
    report('T9', lab, before);

    // Phase 7 7B-3 (Q9): before, the UI sound's keydown resume came first.
    expect(countOps(fromTap(lab), 'resume@keydown:')).toBe(1);
    expect(countOps(fromTap(lab), ' tone')).toBe(0);
    expect(lab.dialogShows).toBe(2);
    expect(lab.rejoins).toEqual(['audio-context-recovered']);
    expect(lab.starts - before).toBe(1);
  });
});
