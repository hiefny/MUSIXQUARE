/**
 * In-memory sync flight recorder.
 *
 * This is intentionally local-only and bounded: it retains at most twenty
 * minutes of one-second samples and a small event ring, never writes storage,
 * and never sends diagnostics over the network. Queue identifiers are replaced
 * with per-page aliases before they enter the ring or exported report.
 *
 * The report's AUDIO RECOVERY block (Phase 7 7A-1, owner decisions Q3 and Q4)
 * names the numbered counts that audio/output-recovery-counters.ts keeps on
 * the device; the names live here, in this lazy chunk, and nothing is sent.
 */

import { isAudioReady, getAudioContext } from '../audio/engine.ts';
import {
  AUDIO_RECOVERY_LABEL_SET,
  AUDIO_RECOVERY_SLOTS,
  CLOCK_CANCELLED,
  CLOCK_CONFIRMED,
  CLOCK_RECOVERY_NEEDED,
  CLOCK_WAIT_MAX_MS,
  CLOCK_WAIT_TOTAL_MS,
  CLOCK_WAITS,
  CONTEXT_RECOVERED_REJOINS,
  DEADLINE_AUTO_RESUME,
  DEADLINE_CLOCK_REQUIREMENT,
  DEADLINE_ENSURE_RUNNING,
  DEADLINE_GESTURE_FLOW,
  DEADLINE_GESTURE_RESUME,
  DEADLINE_LATE_SUSPEND_FENCE,
  DEADLINE_PLAY_REQUEST_PREPARE,
  DEADLINE_PLAY_REQUEST_RESUME,
  DEADLINE_PLAY_REQUEST_WATCHDOG,
  DEADLINE_PROBE,
  DEADLINE_RETIRE_CLEANUP,
  DEADLINE_SCOPE_PREPARE,
  DEADLINE_SCOPE_WATCHDOG,
  DEADLINES_WATCHED,
  DIALOG_REQUESTS_PLAY,
  DIALOG_REQUESTS_RETURN,
  LEASES_AT_ONCE_MAX,
  RESUME_AUTO,
  RESUME_DIALOG,
  RESUME_ENSURE_RUNNING,
  RESUME_PLAY_GESTURE,
  RESUME_PLAY_REQUEST,
  RESUME_PROBE,
  RESUME_RETIRE,
  RESUME_UI_SOUND,
  RESUSPENDED_AFTER_RUNNING,
  SECOND_SUSPENDS,
  SUSPEND_CALLS,
  TAPS_REFUSED,
  UI_SOUND_RESUMES_WHILE_WAITING,
  readAudioRecoveryCounts,
} from '../audio/output-recovery-counters.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { getPlayLockSnapshot, peekTrackPosition } from '../player/transport.ts';
import { getCurrentAudioBuffer, getPlayerNode } from '../player/_state.ts';
import { getLargeAudioDiagnostics } from '../player/large-audio/diagnostics.ts';
import {
  getProRoomServerClockDiagnostics,
  getProRoomServerNow,
} from '../pro-room/network-bridge.ts';
import { getHostNow, getSharedClockDiagnostics } from '../network/shared-clock.ts';
import { isStandardRoomRole } from '../rooms/authority.ts';
import { getProStartObservations, resetProStartObservations } from './pro-start-observations.ts';
import {
  getStandardStartObservations,
  resetStandardStartObservations,
} from './standard-start-observations.ts';

const SAMPLE_INTERVAL_MS = 1_000;
const MAX_SAMPLES = 20 * 60;
const MAX_EVENTS = 240;
const TIMER_NAME = 'sync-flight-recorder';

type ClockDomain = 'standard' | 'pro';
type CanonicalState = 'idle' | 'playing' | 'paused';

interface CanonicalAnchor {
  domain: ClockDomain;
  track: string;
  state: CanonicalState;
  positionSeconds: number;
  canonicalTimeMs: number;
  revision: number | null;
}

interface RecorderEvent {
  at: string;
  kind: string;
  detail: Record<string, string | number | boolean | null>;
}

interface AudioClockSample {
  state: string;
  currentTimeSeconds: number;
  sampleRateHz: number;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  outputTimestampAgeMs: number | null;
  outputQueueLeadMs: number | null;
}

interface SyncFlightRecorderSample {
  at: string;
  wallElapsedMs: number | null;
  monotonicElapsedMs: number | null;
  visibility: string;
  focused: boolean | null;
  room: ClockDomain | 'none';
  role: string;
  mode: string | null;
  activity: string;
  lifecycle: string;
  track: string | null;
  playerStartedAtSeconds: number;
  playerPausedAtSeconds: number;
  localOffsetSeconds: number;
  youtubeOffsetSeconds: number;
  hasSourceNode: boolean;
  playLock: ReturnType<typeof getPlayLockSnapshot>;
  bufferDurationSeconds: number | null;
  localPositionSeconds: number | null;
  canonicalPositionSeconds: number | null;
  logicalDriftMs: number | null;
  wallMinusMonotonicMs: number;
  wallClockStepMs: number | null;
  workerTickAgeMs: number | null;
  syncPongAgeMs: number | null;
  decision: string;
  standardClock: ReturnType<typeof getSharedClockDiagnostics>;
  proClock: ReturnType<typeof getProRoomServerClockDiagnostics>;
  audio: AudioClockSample | null;
  largeAudio: ReturnType<typeof getLargeAudioDiagnostics>;
}

interface StandardPongObservation {
  trackKey: string | null;
  trackMatches: boolean;
  playing: boolean;
  hostTimeMs: number;
  positionSeconds: number;
  rttMs: number;
  offsetMs: number;
}

interface ProPlaybackCheckpointObservation {
  trackKey: string | null;
  state: CanonicalState;
  positionSeconds: number;
  updatedAtMs: number;
  revision: number;
}

const samples: SyncFlightRecorderSample[] = [];
const events: RecorderEvent[] = [];
const trackAliases = new Map<string, string>();
let nextTrackAlias = 0;
let canonicalAnchor: CanonicalAnchor | null = null;
let lastWorkerTickAt = 0;
let lastSyncPongAt = 0;
let lastDecision = 'none';
let previousSampleAt = 0;
let previousMonotonicAt = 0;
let previousWallMinusMonotonic: number | null = null;
let previousAudioState: string | null = null;
let previousOutputQueueLeadMs: number | null = null;
let initialized = false;
let unsubscribeSession: (() => void) | null = null;
let unsubscribeVisibility: (() => void) | null = null;
const unsubscribeDiagnostics: Array<() => void> = [];

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function rounded(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function boundedAge(nowMs: number, thenMs: number): number | null {
  return thenMs > 0 ? Math.max(0, nowMs - thenMs) : null;
}

function aliasTrack(trackKey: string | null): string | null {
  if (!trackKey) return null;
  const existing = trackAliases.get(trackKey);
  if (existing) return existing;
  const alias = `q${++nextTrackAlias}`;
  trackAliases.set(trackKey, alias);
  // Twenty minutes of track changes should be far below this, but keep the
  // private raw-key map bounded even under synthetic API churn.
  if (trackAliases.size > 512) {
    const oldest = trackAliases.keys().next().value as string | undefined;
    if (oldest) trackAliases.delete(oldest);
  }
  return alias;
}

function currentTrackKey(): string | null {
  if (getState('demo.active')) {
    const index = getState('demo.currentTrackIndex');
    return index >= 0 ? `demo:${index}` : null;
  }
  return getState('playlist.currentQueueItemId');
}

function appendEvent(
  kind: string,
  detail: Record<string, string | number | boolean | null> = {},
): void {
  const nowMs = Date.now();
  events.push({ at: new Date(nowMs).toISOString(), kind, detail });
  const cutoff = nowMs - MAX_SAMPLES * SAMPLE_INTERVAL_MS;
  while (events.length > 0 && Date.parse(events[0].at) < cutoff) events.shift();
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

function collectAudioClockSample(): AudioClockSample | null {
  if (!isAudioReady()) return null;
  try {
    const ctx = getAudioContext() as AudioContext & {
      outputLatency?: number;
      getOutputTimestamp?: () => { contextTime: number; performanceTime: number };
    };
    const baseLatencyMs = finite(ctx.baseLatency) ? rounded(ctx.baseLatency * 1_000, 2) : null;
    const outputLatencyMs = finite(ctx.outputLatency)
      ? rounded(ctx.outputLatency * 1_000, 2)
      : null;
    let outputTimestampAgeMs: number | null = null;
    let outputQueueLeadMs: number | null = null;
    try {
      const stamp = ctx.getOutputTimestamp?.();
      if (stamp && finite(stamp.contextTime) && finite(stamp.performanceTime)) {
        const perfNow = performance.now();
        outputTimestampAgeMs = rounded(Math.max(0, perfNow - stamp.performanceTime), 2);
        const projectedOutputContextTime =
          stamp.contextTime + Math.max(0, perfNow - stamp.performanceTime) / 1_000;
        outputQueueLeadMs = rounded((ctx.currentTime - projectedOutputContextTime) * 1_000, 2);
      }
    } catch {
      // Optional Web Audio diagnostic API. Absence/failure is represented by null.
    }
    return {
      state: String(ctx.state),
      currentTimeSeconds: rounded(ctx.currentTime),
      sampleRateHz: ctx.sampleRate,
      baseLatencyMs,
      outputLatencyMs,
      outputTimestampAgeMs,
      outputQueueLeadMs,
    };
  } catch {
    return null;
  }
}

function canonicalNow(anchor: CanonicalAnchor): number | null {
  try {
    return anchor.domain === 'pro' ? getProRoomServerNow() : getHostNow();
  } catch {
    return null;
  }
}

function expectedCanonicalPosition(track: string | null): number | null {
  const anchor = canonicalAnchor;
  if (!anchor || !track || anchor.track !== track || anchor.state === 'idle') return null;
  if (anchor.state === 'paused') return anchor.positionSeconds;
  const now = canonicalNow(anchor);
  if (!finite(now)) return null;
  return Math.max(0, anchor.positionSeconds + Math.max(0, now - anchor.canonicalTimeMs) / 1_000);
}

/** Capture one sample immediately. Exported for narrow regression tests. */
export function captureSyncFlightRecorderSampleForTests(): void {
  if (!getState('setup.sessionStarted')) return;
  const nowMs = Date.now();
  const monoNow = performance.now();
  const wallMinusMonotonicMs = nowMs - monoNow;
  const wallClockStepMs =
    previousWallMinusMonotonic === null
      ? null
      : rounded(wallMinusMonotonicMs - previousWallMinusMonotonic, 2);
  previousWallMinusMonotonic = wallMinusMonotonicMs;

  const rawTrack = currentTrackKey();
  const track = aliasTrack(rawTrack);
  let localPositionSeconds: number | null = null;
  try {
    const position = peekTrackPosition();
    if (finite(position)) localPositionSeconds = rounded(position);
  } catch {
    // A changing media owner may make the synchronous getter temporarily unavailable.
  }
  const canonicalPosition = expectedCanonicalPosition(track);
  const canonicalPositionSeconds = finite(canonicalPosition) ? rounded(canonicalPosition) : null;
  const logicalDriftMs =
    localPositionSeconds !== null && canonicalPositionSeconds !== null
      ? rounded((canonicalPositionSeconds - localPositionSeconds) * 1_000, 1)
      : null;
  const audio = collectAudioClockSample();
  const audioBuffer = getCurrentAudioBuffer();
  const bufferDurationSeconds =
    audioBuffer && finite(audioBuffer.duration) ? rounded(audioBuffer.duration) : null;

  if (wallClockStepMs !== null && Math.abs(wallClockStepMs) >= 25) {
    appendEvent('wall-clock-step', { deltaMs: wallClockStepMs });
  }
  if (audio?.state && previousAudioState !== null && audio.state !== previousAudioState) {
    appendEvent('audio-context-state', { from: previousAudioState, to: audio.state });
  }
  if (audio?.state) previousAudioState = audio.state;
  if (
    audio?.outputQueueLeadMs !== null &&
    audio?.outputQueueLeadMs !== undefined &&
    previousOutputQueueLeadMs !== null &&
    Math.abs(audio.outputQueueLeadMs - previousOutputQueueLeadMs) >= 50
  ) {
    appendEvent('audio-output-queue-jump', {
      fromMs: previousOutputQueueLeadMs,
      toMs: audio.outputQueueLeadMs,
    });
  }
  if (audio?.outputQueueLeadMs !== null && audio?.outputQueueLeadMs !== undefined) {
    previousOutputQueueLeadMs = audio.outputQueueLeadMs;
  }

  const context = getState('room.context');
  // Standard rooms retain the transport/session projection rather than filling
  // the persistent-room context. Sampling already requires a started session.
  const standardSession = isStandardRoomRole('host') || isStandardRoomRole('guest');
  samples.push({
    at: new Date(nowMs).toISOString(),
    wallElapsedMs: previousSampleAt > 0 ? nowMs - previousSampleAt : null,
    monotonicElapsedMs: previousMonotonicAt > 0 ? rounded(monoNow - previousMonotonicAt, 2) : null,
    visibility: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
    focused: typeof document !== 'undefined' ? document.hasFocus() : null,
    room: context.kind === 'pro' ? 'pro' : standardSession ? 'standard' : 'none',
    role: `${getState('network.appRole')}/${context.role}`,
    mode: getState('playback.mode'),
    activity: getState('playback.activity'),
    lifecycle: getState('playback.lifecycle'),
    track,
    playerStartedAtSeconds: rounded(getState('player.startedAt')),
    playerPausedAtSeconds: rounded(getState('player.pausedAt')),
    localOffsetSeconds: rounded(getState('sync.localOffset')),
    youtubeOffsetSeconds: rounded(getState('sync.youtubeLocalOffset')),
    hasSourceNode: !!getPlayerNode(),
    playLock: getPlayLockSnapshot(nowMs),
    bufferDurationSeconds,
    localPositionSeconds,
    canonicalPositionSeconds,
    logicalDriftMs,
    wallMinusMonotonicMs: rounded(wallMinusMonotonicMs, 2),
    wallClockStepMs,
    workerTickAgeMs: boundedAge(nowMs, lastWorkerTickAt),
    syncPongAgeMs: boundedAge(nowMs, lastSyncPongAt),
    decision: lastDecision,
    standardClock: getSharedClockDiagnostics(nowMs),
    proClock: getProRoomServerClockDiagnostics(),
    audio,
    largeAudio: getLargeAudioDiagnostics(),
  });
  previousSampleAt = nowMs;
  previousMonotonicAt = monoNow;
  const cutoff = nowMs - MAX_SAMPLES * SAMPLE_INTERVAL_MS;
  while (samples.length > 0 && Date.parse(samples[0].at) < cutoff) samples.shift();
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

function startSampling(): void {
  clearManagedTimer(TIMER_NAME);
  if (!getState('setup.sessionStarted')) return;
  captureSyncFlightRecorderSampleForTests();
  setManagedTimer(TIMER_NAME, captureSyncFlightRecorderSampleForTests, SAMPLE_INTERVAL_MS, {
    interval: true,
  });
}

export function initSyncFlightRecorder(): void {
  if (initialized) return;
  initialized = true;
  unsubscribeSession = bus.on('state:setup.sessionStarted', (started) => {
    resetSessionObservationState();
    if (started) {
      appendEvent('session-start');
      startSampling();
    } else {
      appendEvent('session-stop');
      clearManagedTimer(TIMER_NAME);
    }
  });
  unsubscribeDiagnostics.push(
    bus.on('sync:diagnostic-worker-tick', noteSyncWorkerTick),
    bus.on('sync:diagnostic-standard-pong', noteStandardSyncPong),
    bus.on('sync:diagnostic-standard-decision', noteStandardSyncDecision),
    bus.on('sync:diagnostic-pro-checkpoint', noteProPlaybackCheckpoint),
    bus.on('audio:output-recovery-needed', (event) => {
      const lock = getPlayLockSnapshot();
      appendEvent('audio-output-recovery-needed', {
        reason: event.reason,
        source: event.source,
        lockAgeMs: lock.ageMs,
        lockPhase: lock.phase,
        watchdogArmed: lock.watchdogArmed,
      });
    }),
  );
  if (typeof document !== 'undefined') {
    const onVisibility = () => appendEvent('visibility', { state: document.visibilityState });
    document.addEventListener('visibilitychange', onVisibility);
    unsubscribeVisibility = () => document.removeEventListener('visibilitychange', onVisibility);
  }
  startSampling();
}

function resetSessionObservationState(): void {
  resetProStartObservations();
  resetStandardStartObservations();
  canonicalAnchor = null;
  lastWorkerTickAt = 0;
  lastSyncPongAt = 0;
  lastDecision = 'none';
  previousSampleAt = 0;
  previousMonotonicAt = 0;
  previousWallMinusMonotonic = null;
  previousAudioState = null;
  previousOutputQueueLeadMs = null;
}

function noteSyncWorkerTick(id: string): void {
  if (id === 'sync') lastWorkerTickAt = Date.now();
}

function noteStandardSyncPong(observation: StandardPongObservation): void {
  lastSyncPongAt = Date.now();
  if (observation.trackMatches && !observation.playing && canonicalAnchor?.domain === 'standard') {
    canonicalAnchor = null;
  }
  if (
    observation.trackMatches &&
    observation.playing &&
    observation.trackKey &&
    finite(observation.hostTimeMs) &&
    finite(observation.positionSeconds)
  ) {
    canonicalAnchor = {
      domain: 'standard',
      track: aliasTrack(observation.trackKey) as string,
      state: 'playing',
      positionSeconds: observation.positionSeconds,
      canonicalTimeMs: observation.hostTimeMs,
      revision: null,
    };
  }
  lastDecision = `pong rtt=${rounded(observation.rttMs, 1)}ms offset=${rounded(observation.offsetMs, 1)}ms`;
}

function noteStandardSyncDecision(options: {
  decision: 'observe' | 'bootstrap' | 'initial' | 'hard' | 'soft' | 'skipped';
  expectedPositionSeconds?: number;
  localPositionSeconds?: number;
  reason?: string;
}): void {
  const driftMs =
    finite(options.expectedPositionSeconds) && finite(options.localPositionSeconds)
      ? rounded((options.expectedPositionSeconds - options.localPositionSeconds) * 1_000, 1)
      : null;
  lastDecision = `${options.decision}${driftMs === null ? '' : ` drift=${driftMs}ms`}${options.reason ? ` ${options.reason}` : ''}`;
  if (options.decision !== 'observe' && options.decision !== 'skipped') {
    appendEvent(`standard-${options.decision}`, { driftMs, reason: options.reason ?? null });
  }
}

function noteProPlaybackCheckpoint(observation: ProPlaybackCheckpointObservation): void {
  const track = aliasTrack(observation.trackKey);
  canonicalAnchor =
    track && observation.state !== 'idle'
      ? {
          domain: 'pro',
          track,
          state: observation.state,
          positionSeconds: observation.positionSeconds,
          canonicalTimeMs: observation.updatedAtMs,
          revision: observation.revision,
        }
      : null;
  lastDecision = `pro checkpoint r${observation.revision} ${observation.state}`;
  appendEvent('pro-checkpoint', {
    track,
    state: observation.state,
    revision: observation.revision,
  });
}

// -- AUDIO RECOVERY (Phase 7 7A-1) ------------------------------------
// The label names are frozen once a before set is collected: later trains
// compare the same names (a renamed label is a new count). A deadline name's
// value is the wait it had in 7A, not a timing value (those live in
// audio/context-protocol.ts): a later train that changes a wait keeps the name.
const RESUME_SOURCES: Labels = [
  [RESUME_PLAY_REQUEST, 'playRequest'],
  [RESUME_PLAY_GESTURE, 'playGesture'],
  [RESUME_DIALOG, 'dialog'],
  [RESUME_AUTO, 'auto'],
  [RESUME_ENSURE_RUNNING, 'ensureRunning'],
  [RESUME_PROBE, 'probe'],
  [RESUME_RETIRE, 'retire'],
  [RESUME_UI_SOUND, 'uiSound'],
];
const DEADLINES: Labels = [
  [DEADLINE_PLAY_REQUEST_PREPARE, 'playRequestPrepare500ms'],
  [DEADLINE_PLAY_REQUEST_RESUME, 'playRequestResume750ms'],
  [DEADLINE_PLAY_REQUEST_WATCHDOG, 'playRequestWatchdog750ms'],
  [DEADLINE_LATE_SUSPEND_FENCE, 'lateSuspendFence250ms'],
  [DEADLINE_RETIRE_CLEANUP, 'retireCleanup500ms'],
  [DEADLINE_ENSURE_RUNNING, 'ensureRunning500ms'],
  [DEADLINE_PROBE, 'probe500ms'],
  [DEADLINE_SCOPE_PREPARE, 'scopePrepare500ms'],
  [DEADLINE_SCOPE_WATCHDOG, 'scopeWatchdog750ms'],
  [DEADLINE_AUTO_RESUME, 'autoResume750ms'],
  [DEADLINE_GESTURE_RESUME, 'playGestureResume750ms'],
  [DEADLINE_GESTURE_FLOW, 'gestureFlow1s'],
  [DEADLINE_CLOCK_REQUIREMENT, 'clockRequirement5s'],
];

/**
 * Chrome 146 and later count output underruns on the context
 * (AudioContext.playbackStats). `/debug sync` reads it once, when the window
 * opens (owner decision Q3 b); null where the browser does not report it,
 * and also before the audio engine exists (nothing to read yet), which the
 * window shows with the same approved 'none (not reported by this browser)'.
 */
export function readChromeOutputUnderruns(): number | null {
  if (!isAudioReady()) return null;
  try {
    const stats = (
      getAudioContext() as AudioContext & { playbackStats?: { underrunEvents?: unknown } }
    ).playbackStats;
    const underruns = stats?.underrunEvents;
    return typeof underruns === 'number' && Number.isFinite(underruns) ? underruns : null;
  } catch {
    return null;
  }
}

type Labels = ReadonlyArray<readonly [number, string]>;

function total(slots: readonly number[], labels: Labels): number {
  return labels.reduce((sum, [slot]) => sum + slots[slot]!, 0);
}

/**
 * The previous page's kept value, "<label set> <build> <every slot>": its
 * build and slots, or null for another label set or a malformed value.
 */
function parsePreviousPage(kept: string): readonly [build: string, slots: number[]] | null {
  const [labelSet, build, ...fields] = kept.split(' ');
  if (
    labelSet !== String(AUDIO_RECOVERY_LABEL_SET) ||
    !build ||
    build.length > 40 ||
    fields.length !== AUDIO_RECOVERY_SLOTS
  ) {
    return null;
  }
  const slots = fields.map(Number);
  return fields.every((field, index) => field !== '' && slots[index]! >= 0) &&
    slots.every(Number.isFinite)
    ? [build, slots]
    : null;
}

function audioRecoveryLines(outputUnderruns: number | null): string[] {
  const [count, kept] = readAudioRecoveryCounts();
  const named = (labels: Labels): string =>
    labels.map(([slot, name]) => `${name}:${count[slot]}`).join(' ');
  const fired = named(DEADLINES.filter(([slot]) => count[slot]! > 0));
  const play = count[DIALOG_REQUESTS_PLAY]!;
  const back = count[DIALOG_REQUESTS_RETURN]!;
  const watched = count[DEADLINES_WATCHED]!;
  const lines = [
    'AUDIO RECOVERY (this page, on device, not sent)',
    `Resume attempts: ${total(count, RESUME_SOURCES)} | ${named(RESUME_SOURCES)}`,
    `Deadline fires: ${total(count, DEADLINES)}${fired ? ` | ${fired}` : ''} (${watched} ${watched === 1 ? 'race' : 'races'} watched)`,
    `Time awaiting clock verification: totalMs:${Math.round(count[CLOCK_WAIT_TOTAL_MS]!)} maxMs:${Math.round(count[CLOCK_WAIT_MAX_MS]!)} | waits:${count[CLOCK_WAITS]} confirmed:${count[CLOCK_CONFIRMED]} cancelled:${count[CLOCK_CANCELLED]} recoveryNeeded:${count[CLOCK_RECOVERY_NEEDED]}`,
    `Suspend calls: ${count[SUSPEND_CALLS]} | second suspends:${count[SECOND_SUSPENDS]} | re-suspended after running:${count[RESUSPENDED_AFTER_RUNNING]}`,
    `Recovery dialog requests: ${play + back} | play:${play} return:${back} | audio-context-recovered rejoins:${count[CONTEXT_RECOVERED_REJOINS]} | taps refused:${count[TAPS_REFUSED]}`,
    `Leases at once (max): ${count[LEASES_AT_ONCE_MAX]} | UI sound resumes while waiting for tap: ${count[UI_SOUND_RESUMES_WHILE_WAITING]}`,
    outputUnderruns === null
      ? 'Chrome output underruns: none (not reported by this browser)'
      : `Chrome output underruns: ${outputUnderruns} (playbackStats.underrunEvents, read when opened)`,
  ];
  const previous = kept === null ? null : parsePreviousPage(kept);
  if (previous) {
    // Another build's counts keep its build number on their own line; they
    // are never added to this page's counts.
    const [build, slots] = previous;
    lines.push(
      `Previous page: this tab sessionStorage | app=${build} | resume attempts:${total(slots, RESUME_SOURCES)} deadline fires:${total(slots, DEADLINES)} clock wait totalMs:${Math.round(slots[CLOCK_WAIT_TOTAL_MS]!)} maxMs:${Math.round(slots[CLOCK_WAIT_MAX_MS]!)} dialog requests:${slots[DIALOG_REQUESTS_PLAY]! + slots[DIALOG_REQUESTS_RETURN]!}`,
    );
  }
  return lines;
}

export function markSyncFlightRecorderIncident(): void {
  appendEvent('user-incident-marker');
  captureSyncFlightRecorderSampleForTests();
}

/**
 * The `/debug sync` report. `outputUnderruns` is what readChromeOutputUnderruns
 * read when the window opened (null: not reported by this browser, or no
 * audio engine yet).
 */
export function collectSyncFlightRecorderText(outputUnderruns: number | null = null): string {
  const proStartObservations = getProStartObservations();
  const standardStartObservations = getStandardStartObservations();
  // These literals belong to the executing bundle. A newer active/waiting SW
  // must not relabel an older page while diagnosing mixed-client sessions.
  const appVersion = typeof __MXQR_APP_VERSION__ === 'undefined' ? 'unknown' : __MXQR_APP_VERSION__;
  const cacheEpoch =
    typeof __MXQR_BUILD_CACHE_VERSION__ === 'undefined' ? 'unknown' : __MXQR_BUILD_CACHE_VERSION__;
  const lines = [
    'MUSIXQUARE SYNC FLIGHT RECORDER v1',
    `Generated: ${new Date().toISOString()}`,
    `Client build: app=${appVersion} | cacheEpoch=${cacheEpoch} (embedded JS build; active service worker not inspected)`,
    `Retention: RAM-only, ${MAX_SAMPLES}s max | samples:${samples.length} events:${events.length} proStarts:${proStartObservations.length} standardClock:${standardStartObservations.clock.length} standardStarts:${standardStartObservations.playback.length}`,
    'Privacy: no room code, peer id, nickname, title, filename, or raw queue id',
    'SAMPLES logicalDriftMs: positive = canonical timeline is ahead of local logical position',
    'PRO START timelineDriftMs: positive = local YouTube canonical position is ahead of the predicted timeline',
    'STANDARD START timelineDriftMs: positive = local YouTube position is ahead of the host prediction after manual offset',
    'STANDARD CLOCK sentAtMs/wallElapsedMs use the current rebased clock; rawSentAtMs/rawWallElapsedMs retain the original ping send time',
    'STANDARD START clockMapping: wall time minus monotonic time; deltas are sample minus release, spans cover plan/schedule/release/sample',
    ...audioRecoveryLines(outputUnderruns),
    '',
    'EVENTS JSONL',
    ...events.map((event) => JSON.stringify(event)),
    '',
    'PRO START OBSERVATIONS JSONL (local generations, no raw identifiers)',
    ...proStartObservations.map((observation) => JSON.stringify(observation)),
    '',
    'STANDARD CLOCK OBSERVATIONS JSONL (local sample numbers, no raw identifiers)',
    ...standardStartObservations.clock.map((observation) => JSON.stringify(observation)),
    '',
    'STANDARD START OBSERVATIONS JSONL (local operation numbers, no raw identifiers)',
    ...standardStartObservations.playback.map((observation) => JSON.stringify(observation)),
    '',
    'SAMPLES JSONL (oldest to newest)',
    ...samples.map((sample) => JSON.stringify(sample)),
  ];
  return lines.join('\n');
}

/** Test-only reset; production callers never need to clear the incident ring. */
export function resetSyncFlightRecorderForTests(): void {
  clearManagedTimer(TIMER_NAME);
  unsubscribeSession?.();
  unsubscribeVisibility?.();
  for (const unsubscribe of unsubscribeDiagnostics.splice(0)) unsubscribe();
  unsubscribeSession = null;
  unsubscribeVisibility = null;
  initialized = false;
  samples.length = 0;
  events.length = 0;
  trackAliases.clear();
  nextTrackAlias = 0;
  resetSessionObservationState();
}
