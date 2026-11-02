/**
 * The YouTube iframe's audio: the App's own writes of its volume and mute
 * state, the holds that keep a write from opening it, and the verified
 * restore of the start machines.
 *
 * Resource owner: RO-12
 *
 * The App's desired audio is never stored. One mute rule holds everywhere:
 * muted when the master volume rounds to 0 %. The youtube:set-volume write
 * applies it to the rounded percent engine.ts sends; the pause gate's
 * settlement, the PRO direct commit, player.ts's two recovery intents, the
 * Standard zero-start run's desired audio and the PRO prepare read the master
 * volume here (readYouTubeAppAudio; the two machines' read is the audio they
 * capture as they start, until a push during the run replaces it); the App's
 * writes also read the PRO pause gate's token, which this module holds. Three App writes go through applyYouTubeAudio,
 * each in the order it has always had: a youtube:set-volume write, the pause
 * gate's settlement and the PRO direct commit. The start machines' hard mute
 * is the shared wait in arm-steps.ts; their releases stay with them.
 *
 * Holds keep a write closed, each in its own way:
 * - the PRO pause gate (a participant-local pause until its settlement):
 *   a bare mute() at once on whatever iframe is current
 *   (enforceYouTubePauseGate), and every App write mutes instead of
 *   unmuting while it holds;
 * - parking (the retained player controller's, RO-14): the controller's
 *   verified hard mute in place of the write's mute or unMute, never unMute
 *   (a youtube:set-volume write has already set the volume; the gate's
 *   settlement asks parking before it writes; the PRO direct commit does not
 *   ask);
 * - a start owner's hard mute (the zero-start run, a recovery (the guest
 *   local recovery, or a host's legacy recovery) or the PRO arm), which this
 *   module asks the start ledger's isYouTubeStartHardMuteOwned for at the
 *   write: only the unMute is held, since the owner restores the latest
 *   desired audio itself.
 * This module cannot import parking's owner (iframe.ts imports this module),
 * so player.ts registers parking once, as two closures
 * (registerYouTubeAudioHolds), asked at each write; before that, parking
 * holds nothing. The start ledger is a leaf: until player.ts registers the
 * start claims it answers false.
 *
 * The verified restore is the one bounded restore loop of the start
 * machines: zero-start's active and detached restores (zero-start.ts), the
 * PRO arm's active and detached restores (authority-arm.ts) and the verified
 * cleanups of the host legacy recovery and the guest local recovery (both in
 * zero-start-recovery.ts). Each attempt writes the audio and checks
 * that the iframe reports it, every YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS, at most
 * YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS times: WebKit can ignore the first
 * unMute right after an iframe transition or a hard mute.
 *
 * Each caller keeps its own rhythm (the two cadences stay apart), its fences,
 * its confirmation predicate (zero-start alone counts a NaN volume read as
 * restored), what follows a restore or the last attempt, and its timer: every
 * wait goes through the caller's own schedule, so its timer key or slot and
 * the cancel that clears them stay with the caller. This module sets no timer
 * and logs nothing; its state is the gate's token and the registered parking
 * hold.
 *
 * The restores of the host legacy recovery and the guest local recovery
 * (zero-start-recovery.ts) before their release write and check
 * through the same two helpers but keep their own polls, the third cadence
 * (YOUTUBE_RECOVERY_POLL_MS). The guest recovery's release write, both
 * recoveries' unverified cleanups of a replaced or cancelled iframe
 * (cleanupExactPlayer) and both arms' warm pairs (the #warm of zero-start.ts
 * and authority-arm.ts) write through writeYouTubeAudio too, without a check.
 */
import { getState } from '../core/state.ts';
import type { YouTubePlayerInstance } from './_state.ts';
import {
  YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS,
  YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS,
} from './constants.ts';
import { isYouTubeStartHardMuteOwned } from './start-ownership.ts';

/** The iframe player methods a restore writes and reads. */
interface YouTubeAudioPlayer {
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getVolume(): number;
}

/** The audio a restore writes and then expects the iframe to report. */
interface YouTubeAudioTarget {
  readonly muted: boolean;
  readonly volume: number;
}

/** The token of the participant-local PRO pause that holds the gate, or null. */
let pauseGateToken: number | null = null;
/** Until player.ts registers parking, it holds nothing and is never enforced. */
const notHeld = (): boolean => false;
let isParked: (player: YouTubePlayerInstance) => boolean = notHeld;
let enforceParking: (player: YouTubePlayerInstance) => void = notHeld;

/**
 * The App's desired iframe audio, read from audio.masterVolume now: the
 * master volume as a whole percent (0 to 100), muted when that percent is 0,
 * as the volume engine.ts sends with youtube:set-volume (whose write applies
 * the same rule to engine.ts's rounded percent itself). The pause gate's
 * settlement, the PRO direct commit, player.ts's two recovery intents, the
 * Standard zero-start run's desired audio (which both recoveries' intents
 * take when the run captured it) and the PRO prepare read it here. The two
 * machines' read is only the audio each captures as it starts: player.ts
 * pushes a newer answer into a running machine on every youtube:set-volume
 * event, into the PRO arm on the pause gate's settlement, and into a
 * zero-start run that takes over a guest's local fallback (the transferred
 * intent) as the run turns busy, and a pushed answer replaces the captured
 * one. So 0 < masterVolume < 0.005 mutes at volume 0 everywhere: the owner
 * chose this one rule for every site (2026-10-30, Phase 6 6C-3); before it
 * the two machines' capture muted only at 0 or below.
 */
export function readYouTubeAppAudio(): YouTubeAudioTarget {
  const masterVolume = getState('audio.masterVolume') ?? 1;
  const volume = Math.max(0, Math.min(100, Math.round(masterVolume * 100)));
  return { muted: volume === 0, volume };
}

/** A participant-local PRO pause holds the gate with its token until it settles. */
export function holdYouTubePauseGate(token: number): void {
  pauseGateToken = token;
}

/** Releases the gate when `token` holds it; false, and the gate stays, for any other. */
export function releaseYouTubePauseGate(token: number): boolean {
  if (pauseGateToken !== token) return false;
  pauseGateToken = null;
  return true;
}

/**
 * Drops the gate whatever token holds it (stopYouTubeMode), so a late
 * settlement cannot reopen the parked or replacement iframe.
 */
export function clearYouTubePauseGate(): void {
  pauseGateToken = null;
}

/** Whether a participant-local PRO pause holds the gate. */
export function isYouTubePauseGateHeld(): boolean {
  return pauseGateToken !== null;
}

/**
 * The gate's own hold: a bare mute() at once, parked or held alike, as the
 * WebAudio output gate silences at once (engine.ts keeps its own token).
 */
export function enforceYouTubePauseGate(player: YouTubePlayerInstance | null): void {
  player?.mute?.();
}

/**
 * player.ts registers parking, which this module cannot import, once, as it
 * loads: whether the retained player controller has parked this exact iframe,
 * and its verified hard mute. Each is asked at the write that needs it;
 * registering asks nothing.
 */
export function registerYouTubeAudioHolds(
  parked: (player: YouTubePlayerInstance) => boolean,
  enforceParked: (player: YouTubePlayerInstance) => void,
): void {
  isParked = parked;
  enforceParking = enforceParked;
}

/** Whether the iframe is parked; if so, its verified hard mute ends the write. */
function holdParked(player: YouTubePlayerInstance): boolean {
  if (!isParked(player)) return false;
  enforceParking(player);
  return true;
}

/**
 * Writes the App's audio through the holds. Every iframe call is optional.
 * @param write Which App write, each in the order it has always had:
 *   0, a youtube:set-volume write: only an iframe with setVolume; setVolume,
 *   then a parked iframe gets its verified hard mute and nothing else, then
 *   mute (muted, or the gate holds) or unMute unless a start owner holds the
 *   hard mute (the start ledger's isYouTubeStartHardMuteOwned).
 *   1, the pause gate's settlement: a parked iframe gets its verified hard
 *   mute and no setVolume; otherwise setVolume, then mute or unMute as for 0.
 *   2, the PRO direct commit: setVolume, then mute (muted, or the gate holds)
 *   or unMute; it asks neither parking nor a start owner.
 */
export function applyYouTubeAudio(
  player: YouTubePlayerInstance | null,
  audio: YouTubeAudioTarget,
  write: 0 | 1 | 2,
): void {
  if (!player || (write === 0 && !player.setVolume)) return;
  if (write === 1 && holdParked(player)) return;
  player.setVolume?.(audio.volume);
  if (write === 0 && holdParked(player)) return;
  if (audio.muted || pauseGateToken !== null) player.mute?.();
  else if (write === 2 || !isYouTubeStartHardMuteOwned()) player.unMute?.();
}

/** setVolume, then mute or unMute: the write of every restore attempt. */
export function writeYouTubeAudio(player: YouTubeAudioPlayer, target: YouTubeAudioTarget): void {
  player.setVolume(target.volume);
  if (target.muted) player.mute();
  else player.unMute();
}

/**
 * Whether the iframe reports the target: the same mute state, then a volume
 * within 1 of it. A NaN volume read never matches.
 */
export function isYouTubeAudioRestored(
  player: YouTubeAudioPlayer,
  target: YouTubeAudioTarget,
): boolean {
  return player.isMuted() === target.muted && Math.abs(player.getVolume() - target.volume) <= 1;
}

/**
 * Runs one bounded restore; the first attempt writes synchronously. The
 * steps are positional parameters: a call site stays a short list of the
 * caller's own closures in the eagerly loaded entry chunk.
 *
 * @param cadence 'settle-then-verify': write, wait one poll, then verify
 *   (zero-start's active and detached restores, the PRO arm's active
 *   restore). 'verify-then-settle': write and verify at once, then wait one
 *   poll before the next attempt (the PRO arm's detached restore and
 *   player.ts's two cleanups).
 * @param canWrite The caller's fence before every write; false ends the loop
 *   with no callback.
 * @param write One attempt's commands. A throw skips that attempt's verify:
 *   not restored.
 * @param verify The caller's confirmation predicate; a throw counts as not
 *   restored.
 * @param onDone Called once: restored after this many attempts, or not
 *   restored after the last one.
 * @param schedule The caller's own timer, asked only for the wait between
 *   attempts.
 * @param canVerify 'settle-then-verify' only: the fence after the wait,
 *   before the verify.
 */
export function restoreYouTubeAudioVerified(
  cadence: 'settle-then-verify' | 'verify-then-settle',
  canWrite: () => boolean,
  write: () => void,
  verify: () => boolean,
  onDone: (restored: boolean, attempts: number) => void,
  schedule: (callback: () => void, delayMs: number) => void,
  canVerify = canWrite,
): void {
  const verifyFirst = cadence === 'verify-then-settle';
  const attempt = (attempts: number): void => {
    if (!canWrite()) return;
    let wrote = true;
    try {
      write();
    } catch {
      wrote = false;
    }
    const check = (): void => {
      let restored = false;
      try {
        restored = wrote && verify();
      } catch {
        // A failed read is not a verified restore.
      }
      if (restored || attempts + 1 >= YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS) {
        onDone(restored, attempts + 1);
      } else if (verifyFirst) {
        schedule(() => attempt(attempts + 1), YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS);
      } else attempt(attempts + 1);
    };
    if (verifyFirst) check();
    else {
      schedule(() => {
        if (canVerify()) check();
      }, YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS);
    }
  };
  attempt(0);
}
