/**
 * The AUDIO RECOVERY block of `/debug sync` (Phase 7 7A-1), read in a browser
 * spec: every slot by the name the block prints, so a row can pin how the
 * whole count vector changes around one step, such as a recovery dialog's tap.
 *
 * A recovery dialog makes the rest of the page inert: its chat field can be
 * neither typed into nor sent from while the dialog is open (Chromium also
 * drops pointer events dispatched to inert elements). So a row opens
 * `/debug sync` once, before the scene's dialog, and keeps its window open
 * for the rest of the scene, hidden (visibility: hidden, so it neither shows
 * nor takes a click), while the window refreshes its report every second.
 * Each read waits for a refresh made after it was asked. The command goes
 * through the chat field's own send handler with synthetic events: the same
 * command and window, and no trusted input, so no user activation and no UI
 * sound. The page's clipboard is replaced first, so the window's copy on
 * open is refused and never reaches the system clipboard.
 */
import type { Page } from '@playwright/test';

const OVERLAY = 'debug-sync-flight-overlay';
const HEADER = 'AUDIO RECOVERY (this page, on device, not sent)';

/** The names the block prints (diagnostics/sync-flight-recorder.ts). */
const RESUME_SOURCES = [
  'playRequest',
  'playGesture',
  'dialog',
  'auto',
  'ensureRunning',
  'probe',
  'retire',
  'uiSound',
] as const;
const DEADLINES = [
  'playRequestPrepare500ms',
  'playRequestResume750ms',
  'playRequestWatchdog750ms',
  'lateSuspendFence250ms',
  'retireCleanup500ms',
  'ensureRunning500ms',
  'probe500ms',
  'scopePrepare500ms',
  'scopeWatchdog750ms',
  'autoResume750ms',
  'playGestureResume750ms',
  'gestureFlow1s',
  'clockRequirement5s',
] as const;

/** The two slots that hold milliseconds, not counts. */
const CLOCK_WAIT_TIMES = ['clockWait:totalMs', 'clockWait:maxMs'];

/**
 * Every slot of the block (37), keyed `resume:<source>`, `fired:<deadline>`,
 * `racesWatched`, `clockWait:<field>`, `suspendCalls`, `secondSuspends`,
 * `resuspendedAfterRunning`, `dialogRequests:play|return`,
 * `contextRecoveredRejoins`, `tapsRefused`, `leasesAtOnceMax` and
 * `uiSoundResumesWhileWaiting`.
 */
export type AudioRecoveryCounts = Readonly<Record<string, number>>;

function lineOf(lines: readonly string[], pattern: RegExp, name: string): RegExpMatchArray {
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return match;
  }
  throw new Error(`/debug sync: the AUDIO RECOVERY block has no ${name} line`);
}

/** Parse the block out of a whole `/debug sync` report. */
export function parseAudioRecoveryBlock(report: string): AudioRecoveryCounts {
  const lines = report.split('\n');
  const start = lines.indexOf(HEADER);
  if (start < 0) throw new Error('/debug sync: no AUDIO RECOVERY block');
  const block = lines.slice(start + 1, start + 7);
  const counts: Record<string, number> = {};
  const named = (entries: string, known: readonly string[], prefix: string): number => {
    let sum = 0;
    for (const entry of entries.split(' ')) {
      const [name, value] = entry.split(':');
      if (!name || !known.includes(name) || value === undefined || !/^\d+$/.test(value)) {
        throw new Error(`/debug sync: unexpected ${prefix} entry '${entry}'`);
      }
      counts[`${prefix}:${name}`] = Number(value);
      sum += Number(value);
    }
    return sum;
  };

  const resume = lineOf(block, /^Resume attempts: (\d+) \| (.+)$/, 'resume');
  const resumed = named(resume[2]!, RESUME_SOURCES, 'resume');
  if (RESUME_SOURCES.some((source) => counts[`resume:${source}`] === undefined)) {
    throw new Error('/debug sync: a resume source is missing');
  }

  const fires = lineOf(
    block,
    /^Deadline fires: (\d+)(?: \| (.+))? \((\d+) races? watched\)$/,
    'deadline',
  );
  for (const deadline of DEADLINES) counts[`fired:${deadline}`] = 0;
  const fired = fires[2] ? named(fires[2], DEADLINES, 'fired') : 0;
  counts.racesWatched = Number(fires[3]);

  const clock = lineOf(
    block,
    /^Time awaiting clock verification: totalMs:(\d+) maxMs:(\d+) \| waits:(\d+) confirmed:(\d+) cancelled:(\d+) recoveryNeeded:(\d+)$/,
    'clock wait',
  );
  ['totalMs', 'maxMs', 'waits', 'confirmed', 'cancelled', 'recoveryNeeded'].forEach(
    (name, index) => {
      counts[`clockWait:${name}`] = Number(clock[index + 1]);
    },
  );

  const suspends = lineOf(
    block,
    /^Suspend calls: (\d+) \| second suspends:(\d+) \| re-suspended after running:(\d+)$/,
    'suspend',
  );
  counts.suspendCalls = Number(suspends[1]);
  counts.secondSuspends = Number(suspends[2]);
  counts.resuspendedAfterRunning = Number(suspends[3]);

  const dialogs = lineOf(
    block,
    /^Recovery dialog requests: (\d+) \| play:(\d+) return:(\d+) \| audio-context-recovered rejoins:(\d+) \| taps refused:(\d+)$/,
    'dialog request',
  );
  counts['dialogRequests:play'] = Number(dialogs[2]);
  counts['dialogRequests:return'] = Number(dialogs[3]);
  counts.contextRecoveredRejoins = Number(dialogs[4]);
  counts.tapsRefused = Number(dialogs[5]);

  const leases = lineOf(
    block,
    /^Leases at once \(max\): (\d+) \| UI sound resumes while waiting for tap: (\d+)$/,
    'lease',
  );
  counts.leasesAtOnceMax = Number(leases[1]);
  counts.uiSoundResumesWhileWaiting = Number(leases[2]);

  if (
    resumed !== Number(resume[1]) ||
    fired !== Number(fires[1]) ||
    counts['dialogRequests:play']! + counts['dialogRequests:return']! !== Number(dialogs[1])
  ) {
    throw new Error('/debug sync: a printed total differs from its parts');
  }
  return counts;
}

/**
 * Send `/debug sync` from the chat field and keep its window open, hidden,
 * for the rest of the scene. Call it while no dialog is open.
 */
export async function openAudioRecoveryCounts(page: Page): Promise<void> {
  await page.evaluate(
    async ([id, header]) => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: () => Promise.reject(new DOMException('Not allowed', 'NotAllowedError')),
        },
      });
      const input = document.getElementById('chat-input');
      const send = document.getElementById('btn-chat-send');
      if (!input || !send) throw new Error('no chat field to send /debug sync from');
      if (input.closest('[inert]')) throw new Error('the chat field is inert: a dialog is open');
      input.textContent = '/debug sync';
      send.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      const giveUpAt = performance.now() + 5_000;
      for (;;) {
        const overlay = document.getElementById(id);
        if (overlay?.querySelector('pre')?.textContent?.includes(header)) {
          overlay.style.visibility = 'hidden';
          if (document.activeElement === input) input.blur();
          return;
        }
        if (performance.now() > giveUpAt) throw new Error('/debug sync did not open');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    [OVERLAY, HEADER] as const,
  );
}

/**
 * The counts of the open `/debug sync` window, from its first refresh made
 * after this call (at most about a second later).
 */
export async function readAudioRecoveryCounts(page: Page): Promise<AudioRecoveryCounts> {
  const report = await page.evaluate(async (id) => {
    const asked = Date.now();
    const giveUpAt = performance.now() + 5_000;
    for (;;) {
      const text = document.getElementById(id)?.querySelector('pre')?.textContent;
      if (!text) throw new Error('the /debug sync window is not open');
      const generated = /^Generated: (\S+)$/m.exec(text)?.[1];
      if (generated && Date.parse(generated) >= asked) return text;
      if (performance.now() > giveUpAt) {
        throw new Error('the /debug sync window stopped refreshing');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }, OVERLAY);
  return parseAudioRecoveryBlock(report);
}

/**
 * How each count slot changed from `before` to `after`, with the slots that
 * did not change left out, so `toEqual` on it pins the whole vector. The two
 * millisecond slots are not in it: rows pin whether the wait total moved.
 */
export function countChanges(
  before: AudioRecoveryCounts,
  after: AudioRecoveryCounts,
): Record<string, number> {
  const changes: Record<string, number> = {};
  for (const [slot, value] of Object.entries(after)) {
    if (CLOCK_WAIT_TIMES.includes(slot)) continue;
    const change = value - (before[slot] ?? Number.NaN);
    if (change !== 0) changes[slot] = change;
  }
  return changes;
}
