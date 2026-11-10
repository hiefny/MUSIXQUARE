/**
 * Local audio output-recovery lab (structural plan C1), Chromium only. Run
 * with playwright.audio-lab.config.ts; never a CI job.
 *
 * The `/debug sync` AUDIO RECOVERY counts around each recovery dialog tap:
 * the whole count vector, read just before the tap and again once the tap's
 * recovery has finished, for each branch of the dialog's tap. Phase 7 7C-2
 * moves app.ts's counting sites (RESUME_DIALOG and the dialog's 1 s and 5 s
 * deadline races) into the recovery owner, and these counts must stay the
 * same. The scenes are those of output-recovery.lab.ts and
 * e2e/background-resume.test.ts:
 *
 * - the play-request dialog, (i)'s scene: the tap resumes the play-request
 *   restart, waits for its clock requirement and retries the failed PLAY;
 * - the prepared dialog, (ii)'s scene: the tap resumes the playback scope's
 *   attempt, whose confirmation publishes the rejoin (a demo page has the
 *   same branch, e2e/demo-output-recovery.test.ts, but its demo window keeps
 *   the chat out of reach, so it is pinned here);
 * - the dialog's own gesture recovery (no owner attempt) for a return notice
 *   on a playing host whose clock runs, the background-resume scene: its
 *   flight wins the dialog's 1 s wait, or, with the resume held past it, the
 *   deadline fires once;
 * - a request the dialog queues again: its tap finds the clock frozen, the
 *   context is parked for a foreground restart, the same request shows once
 *   more with that restart, and its tap rejoins once.
 *
 * Each row opens `/debug sync` before its dialog and keeps the window open,
 * hidden (helpers/audio-recovery-counts.ts). The two millisecond slots (clock
 * wait total and maximum) are pinned by whether the total moved.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  countChanges,
  openAudioRecoveryCounts,
  readAudioRecoveryCounts,
  type AudioRecoveryCounts,
} from '../helpers/audio-recovery-counts.ts';
import { clickPlayButton, readState, waitForPlaybackProjection } from '../helpers/wait.ts';
import {
  bounce,
  countOps,
  holdResume,
  markOps,
  openPlaying,
  opsFrom,
  readLab,
  releaseGates,
  setPageVisibility,
  unfreeze,
} from './output-probe.ts';

const DIALOG = '#dialog-overlay.show';
const OK = '#btn-dialog-ok';

function report(scene: string, before: AudioRecoveryCounts, after: AudioRecoveryCounts): void {
  console.log(
    `[audio-lab] ${scene} counts ${JSON.stringify(countChanges(before, after))} clockWaitMs +${
      after['clockWait:totalMs']! - before['clockWait:totalMs']!
    }`,
  );
}

async function expectRecoveryDialog(page: Page): Promise<void> {
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(page.locator('#dialog-title')).toHaveText('Audio paused unexpectedly');
}

/** A return notice from the bus, as e2e/background-resume.test.ts emits it. */
async function emitReturnNotice(page: Page): Promise<void> {
  await markOps(page, 'notice');
  await page.evaluate(() => {
    const hooks = window as unknown as Record<string, unknown>;
    const bus = hooks.__MUSIXQUARE_BUS__ as { emit: (type: string, payload: unknown) => void };
    const getState = hooks.__MUSIXQUARE_GET_STATE__ as (path: string) => unknown;
    bus.emit('audio:output-recovery-needed', {
      reason: 'clock-stalled',
      source: 'background-resume',
      queueItemId: getState('playlist.currentQueueItemId'),
    });
  });
}

/**
 * e2e/background-resume.test.ts's scene up to its dialog: a host playing, a
 * healthy hidden/visible round trip (no rejoin, no dialog), then a return
 * notice from the bus. Returns the source starts so far.
 */
async function openReturnNoticeDialog(page: Page): Promise<number> {
  await openPlaying(page);
  const { starts } = await readLab(page);
  await setPageVisibility(page, 'hidden');
  await page.waitForTimeout(2_000);
  await setPageVisibility(page, 'visible');
  await page.waitForTimeout(1_000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect((await readLab(page)).rejoins).toEqual([]);
  await openAudioRecoveryCounts(page);
  await emitReturnNotice(page);
  await expectRecoveryDialog(page);
  return starts;
}

/** Freeze the clock while the page stays visible (output-probe.ts's freeze, logged as `freeze`). */
async function freezeClock(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __audioLab: { freeze: () => void } }).__audioLab.freeze(),
  );
}

test.describe('/debug sync counts around the recovery dialog tap', () => {
  test("play-request dialog, (i)'s scene: one play-request resume, three watched races, one confirmed clock wait", async ({
    page,
  }) => {
    // openPlayRequestDialog's steps, with the counts window opened first.
    await openPlaying(page);
    await openAudioRecoveryCounts(page);
    await clickPlayButton(page);
    await waitForPlaybackProjection(page, 'PAUSED', 10_000);
    await bounce(page);
    const { starts: before } = await readLab(page);
    await clickPlayButton(page);
    await expectRecoveryDialog(page);
    await unfreeze(page);
    const counted = await readAudioRecoveryCounts(page);
    await page.locator(OK).click();
    await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 10_000);
    await page.waitForTimeout(1_500);
    const lab = await readLab(page);
    const after = await readAudioRecoveryCounts(page);
    report('play-request tap', counted, after);

    expect(lab.needed).toEqual(['play:clock-stalled']);
    expect(lab.dialogShows).toBe(1);
    expect(countOps(opsFrom(lab.ops, 'unfreeze'), 'resume@click:')).toBe(1);
    expect(lab.retries).toEqual(['started']);
    expect(lab.rejoins).toEqual([]);
    expect(lab.starts - before).toBe(1);
    // The owner's resume and its 750 ms race, the dialog's 1 s race over that
    // flight and its 5 s race for the clock requirement; the probe resumes
    // nothing, and the confirmation ends the one clock wait.
    expect(countChanges(counted, after)).toEqual({
      'resume:playRequest': 1,
      racesWatched: 3,
      'clockWait:waits': 1,
      'clockWait:confirmed': 1,
    });
    expect(after['clockWait:totalMs']).toBeGreaterThan(counted['clockWait:totalMs']!);
  });

  test("prepared dialog, (ii)'s scene: one playback-scope resume, two watched races, one confirmed clock wait and its rejoin", async ({
    page,
  }) => {
    // openPreparedDialog's steps, with the counts window opened first.
    await openPlaying(page);
    await openAudioRecoveryCounts(page);
    const { starts: before } = await readLab(page);
    await bounce(page);
    await expectRecoveryDialog(page);
    // Read once the stall's notices have all arrived (row (ii)).
    await page.waitForTimeout(500);
    await expect(page.locator(DIALOG)).toBeVisible();
    const needed = (await readLab(page)).needed;
    await unfreeze(page);
    const counted = await readAudioRecoveryCounts(page);
    await page.locator(OK).click();
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await page.waitForTimeout(2_000);
    const lab = await readLab(page);
    const after = await readAudioRecoveryCounts(page);
    report('prepared tap', counted, after);

    expect(lab.needed).toEqual(needed);
    expect(countOps(opsFrom(lab.ops, 'unfreeze'), 'resume@click:')).toBe(1);
    expect(lab.rejoins).toEqual(['audio-context-recovered']);
    expect(lab.starts - before).toBe(1);
    // The playback scope's resume and its 750 ms race, the dialog's 1 s race
    // over that flight; the owner's probe resumes nothing, and its
    // confirmation ends the clock wait and counts its rejoin.
    expect(countChanges(counted, after)).toEqual({
      'resume:playGesture': 1,
      racesWatched: 2,
      'clockWait:waits': 1,
      'clockWait:confirmed': 1,
      contextRecoveredRejoins: 1,
    });
    expect(after['clockWait:totalMs']).toBeGreaterThan(counted['clockWait:totalMs']!);
  });

  test("a return notice's dialog, the background-resume scene: one dialog resume and one watched race, which its flight wins", async ({
    page,
  }) => {
    const before = await openReturnNoticeDialog(page);
    const counted = await readAudioRecoveryCounts(page);
    await page.locator(OK).click();
    await expect.poll(async () => (await readLab(page)).rejoins.length).toBeGreaterThan(0);
    await page.waitForTimeout(1_500);
    const lab = await readLab(page);
    const after = await readAudioRecoveryCounts(page);
    report('general tap', counted, after);

    // No owner attempt: the dialog's own gesture recovery publishes the one
    // rejoin, as in e2e/background-resume.test.ts.
    expect(lab.rejoins).toEqual(['audio-recovery-gesture']);
    expect(lab.needed).toEqual(['background-resume:clock-stalled']);
    expect(lab.dialogShows).toBe(1);
    expect(countOps(opsFrom(lab.ops, 'notice'), 'resume@click:')).toBe(1);
    expect(lab.starts - before).toBe(1);
    expect(countChanges(counted, after)).toEqual({ 'resume:dialog': 1, racesWatched: 1 });
    expect(after['clockWait:totalMs']).toBe(counted['clockWait:totalMs']);
  });

  test("the same dialog with its resume held past 1 s: one dialog resume, and the dialog's 1 s deadline fires once", async ({
    page,
  }) => {
    const before = await openReturnNoticeDialog(page);
    // The tap's resume is held, so its flight cannot settle within the 1 s
    // wait: the deadline answers with the context's state (running), and the
    // clock check finds it healthy.
    await holdResume(page, ['click']);
    const counted = await readAudioRecoveryCounts(page);
    await page.locator(OK).click();
    await expect.poll(async () => (await readLab(page)).rejoins.length).toBeGreaterThan(0);
    await page.waitForTimeout(1_500);
    const lab = await readLab(page);
    const after = await readAudioRecoveryCounts(page);
    await releaseGates(page);
    report('general tap, resume held', counted, after);

    expect(lab.resumeHeld).toBe(1);
    expect(lab.rejoins).toEqual(['audio-recovery-gesture']);
    expect(lab.needed).toEqual(['background-resume:clock-stalled']);
    expect(lab.dialogShows).toBe(1);
    expect(countOps(opsFrom(lab.ops, 'notice'), 'resume@click:')).toBe(1);
    expect(lab.starts - before).toBe(1);
    expect(countChanges(counted, after)).toEqual({
      'resume:dialog': 1,
      'fired:gestureFlow1s': 1,
      racesWatched: 1,
    });
    expect(after['clockWait:totalMs']).toBe(counted['clockWait:totalMs']);
  });

  test('a re-queued request: the clock-stalled tap parks the context, the same request shows again with that restart, and its tap rejoins once', async ({
    page,
  }) => {
    await openPlaying(page);
    await openAudioRecoveryCounts(page);
    const { starts: before } = await readLab(page);
    await freezeClock(page);
    await emitReturnNotice(page);
    await expectRecoveryDialog(page);
    const first = await readAudioRecoveryCounts(page);
    await page.locator(OK).click();
    // The dialog's own gesture recovery: its clock check finds the clock
    // frozen, so the context is parked for a foreground restart and the same
    // request is queued again with it (enqueuePreparedForegroundRestart).
    await expect.poll(async () => (await readLab(page)).dialogShows).toBe(2);
    await expectRecoveryDialog(page);
    await unfreeze(page);
    const second = await readAudioRecoveryCounts(page);
    await page.locator(OK).click();
    await expect.poll(async () => (await readLab(page)).rejoins.length).toBeGreaterThan(0);
    await page.waitForTimeout(1_500);
    const lab = await readLab(page);
    const after = await readAudioRecoveryCounts(page);
    report('re-queued, first tap', first, second);
    report('re-queued, second tap', second, after);
    console.log(`[audio-lab] re-queued ops ${JSON.stringify(opsFrom(lab.ops, 'freeze'))}`);

    // The second tap resumes the restart (play-request branch) and, for the
    // same intent, the dialog publishes its one rejoin.
    expect(lab.rejoins).toEqual(['audio-recovery-gesture']);
    expect(lab.needed).toEqual(['background-resume:clock-stalled']);
    expect(lab.dialogShows).toBe(2);
    expect(lab.retries).toEqual([]);
    const frozen = opsFrom(lab.ops, 'freeze');
    expect(countOps(frozen, ' suspend:')).toBe(1);
    expect(countOps(frozen, 'resume@click:')).toBe(2);
    expect(lab.starts - before).toBe(1);
    expect(await readState(page, 'playback.activity')).toBe('playing');
    // First tap: the dialog's resume and its 1 s race; the clock check, then
    // the restart's one suspend (its lease watchdog and 500 ms preparation
    // races watched), the page's first lease.
    expect(countChanges(first, second)).toEqual({
      'resume:dialog': 1,
      racesWatched: 3,
      suspendCalls: 1,
      leasesAtOnceMax: 1,
    });
    // Second tap: as the play-request dialog's tap.
    expect(countChanges(second, after)).toEqual({
      'resume:playRequest': 1,
      racesWatched: 3,
      'clockWait:waits': 1,
      'clockWait:confirmed': 1,
    });
    expect(after['clockWait:totalMs']).toBeGreaterThan(second['clockWait:totalMs']!);
  });
});
