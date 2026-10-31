#!/usr/bin/env node
/**
 * check-resource-ownership.mts
 *
 * Static ratchet for docs/design/resource-ownership-registry.md: one owner per
 * shared runtime resource (Phase 0b of the 2026-10-22 structural plan).
 *
 *   CHECK 1 Registry parity. There is one `resource-ownership` ID block, its
 *     lines are well formed `RO-NN status`, unique and in ascending ID order.
 *     It lists the same IDs in the same order as the `### RO-NN` record
 *     headings; the first word of each record's `- **Status:**` field, read
 *     only inside that record's section and with backticks and surrounding
 *     punctuation stripped, equals its block status; the index table has a
 *     row with the same status for every block ID and no row for any other
 *     ID; every ID this guard names has a block line. Every `Resource owner:
 *     RO-NN` header names a real, non-exception record, and no ID is claimed
 *     by two files.
 *   CHECK 2 Guarded page state (RO-22, RO-23, RO-24, RO-26, RO-30). Direct
 *     writes stay in their allowlisted files: `inert` writes, page-lock claims
 *     through setElementInertForOwner, walks over the body's children,
 *     aria-hidden writes in page-lock files, Fullscreen request methods,
 *     Fullscreen exit methods (only the one bounded exit in
 *     src/core/fullscreen.ts), history entry writes, location navigation and
 *     SKIP_WAITING sends.
 *   CHECK 3 Worker caller allowlists (RO-07, RO-08). The PRO signaling
 *     broadcast endpoint '/internal/realtime/v1/broadcast' (anywhere in
 *     production code) and readProRoomFileDuration() (in cloudflare/; the
 *     app's local-file parse is outside RO-08) appear only in the listed
 *     functions.
 *   CHECK 4 One deadline owner per PRO SFU attempt (RO-04, the G1 lesson).
 *     The PRO subscriber retry maximum stays below the guest receive
 *     watchdog (the receive slot's deadline), or the PRO SFU reception start
 *     in the subscribing function passes `{ deadline: 'route' }` (before
 *     Phase 5 C4-6, `{ receiveWatchdog: false }`). A start is a no-op while
 *     the receive placeholder is active, so an armed start elsewhere (the
 *     retry path, a new module) would also re-arm the watchdog: armed
 *     beginTrustedSystemAudioReception() callers are an exact list per
 *     `file :: function`.
 *   CHECK 5 Copied timing constants (principle 4). Inside each contract the
 *     registry names, top-level *_MS, *_S, *_DELAY(S) and *_TIMEOUT constants
 *     that share a name across files, identical numeric tuples, and timing
 *     objects that share five or more values are an exact, triaged list.
 *     Constants that only share a value are report-only (--report lists them).
 *   CHECK 6 AudioContext native resume()/suspend() call sites (RO-01, RO-44),
 *     counted syntactically per file.
 *   CHECK 7 Developer API authority fence writers (RO-25). Writes to
 *     mxqr_developer_api_room_authority_fences stay in the listed functions:
 *     the activator, the clearer and the PRO room decommission. A string or
 *     template literal counts when it inserts into, replaces into, updates or
 *     deletes from the table, or names it in any other way, because a bare
 *     name can be substituted into template-built SQL (`DELETE FROM
 *     ${table}`); reads (FROM or JOIN) and qualified columns do not count.
 *   CHECK 8 Header loader default holder (RO-47). showLoader() and
 *     updateLoader() calls whose holder ID can be undefined write the
 *     `_default` holder of src/ui/toast.ts, which belongs to the foreground
 *     media load. They are counted per file in src/, following an ID held in
 *     a name through that name's declarations in the same file; a flow that
 *     can overlap that load uses a named holder instead.
 *   CHECK 9 System-audio receive slot writers (RO-04), per file in src/:
 *     setSystemAudioReceiving value uses (calls or the setter passed on);
 *     claimPlaybackOwner value uses unless the call's first argument is a
 *     string literal other than 'system-audio'; reads of `.input` on a
 *     receiver named `widener` (the slot's source connects there); and raw
 *     'systemAudio.isReceiving' writes (a setState() call or an object-literal
 *     key such as a batchSetState reset) outside src/player/ownership.ts, the
 *     setter's home. Final since Phase 5 C4-8: the receive slot
 *     (src/network/system-audio-receive-slot.ts) is the only receive writer,
 *     beside the sharer's own claim, the file playback route's widener input
 *     and the leaveSession reset; no route adapter has an entry, so a direct
 *     write there is unsanctioned.
 *   CHECK 10 System-audio media tuning home (RO-04, Phase 5 C4-1), per file
 *     in the system-audio route files (src/network/system-audio-*.ts and
 *     src/network/pro-system-audio-*.ts): writes of `playoutDelayHint` or
 *     `maxBitrate` (an assignment or an object-literal key) and string
 *     literals naming stun.cloudflare.com stay in
 *     src/network/system-audio-media.ts. The eager STUN entries outside those
 *     files (peer.ts, standard-room-prerequisites.ts) are out of scope: they
 *     cannot import the deferred home.
 *   CHECK 11 YouTube iframe audio writes (RO-12, Phase 6 T1), per file in
 *     src/: mute(), unMute() and setVolume() calls on a receiver, the iframe
 *     API's methods (a bare mute() is a local function), including a computed
 *     key that is a string literal, a conditional of them or a const holding
 *     one (once per call). The count is by name, so a write through a helper
 *     counts once, inside the helper; each reason names the helpers whose
 *     callers write without a count of their own. Not seen: other computed
 *     keys, destructured methods, and methods called through .call() or
 *     .bind().
 *   CHECK 12 Cross-file YouTube start-timer reads and clears (RO-02, Phase 6
 *     T1), per file in src/youtube/: getManagedTimer() and
 *     clearManagedTimer() calls on a start timer (START_TIMER_SETTERS) that
 *     the same file does not set with setManagedTimer(). A name list handed
 *     to an array method (`names.some((name) => getManagedTimer(name))`,
 *     `names.forEach(clearManagedTimer)`) counts once per call. Names resolve
 *     from the syntax tree alone: a string literal; both sides of a
 *     conditional, `??` or `||`; a const initialised with one (every binding
 *     of the name in the file, matched by name, not by scope), imported by
 *     name, re-exported or read through a namespace import; a for-of const,
 *     which takes its list's names; a callback's first parameter when the
 *     callback goes to a method of a name list, and otherwise a parameter
 *     annotated with a string literal or a union of them. Lists are array
 *     literals (with spreads), Object.freeze(), Array.from(), new Set() and
 *     the subset methods (filter, slice, concat, ...) of such lists, or
 *     consts holding one. A template or `+` concatenation whose static text
 *     cannot spell a start timer names none. Fail closed, with no allowance:
 *     a getManagedTimer(), clearManagedTimer() or setManagedTimer() call in
 *     src/youtube/ whose name does not resolve (UNRESOLVED TIMER NAME), any
 *     other name for those functions (a renamed import or export, a
 *     destructuring rename, or a value use other than a query or clear handed
 *     to a name list's method: TIMER FUNCTION ALIAS), and a start timer set
 *     by a src/youtube/ file other than its listed setters, or no longer set
 *     by one of them (START TIMER SET).
 *
 * Baselines. Every count and list below is exact. A file above its baseline
 * (or a new file, function or pair) fails as a regression; a file below it
 * fails until the baseline is lowered to the measured count. A baseline
 * changes only in the pull request that changes the counted code, with the
 * reason written next to the entry and in the pull request; never in a
 * separate baseline-only change. Lowering one is routine; raising one, or
 * adding an entry, also needs a registry record update (registry, "How to
 * change this registry").
 *
 * Scope: production TypeScript under src/ and cloudflare/ (tests, *.d.ts and
 * generated Worker types excluded). The checks walk the TypeScript AST, so
 * comments and unrelated strings never count. Lifecycle-operation callers
 * are counted only for the names above (page-lock claims, SKIP_WAITING sends,
 * AudioContext resume/suspend, armed reception starts, the Worker broadcast
 * endpoint, the duration reader in cloudflare/, the authority fence writers,
 * the system-audio receive slot writers and the YouTube iframe audio
 * writers). Deliberately not checked yet (registry RO-44, RO-45 and
 * "Resource-ownership guard"): callers of the other records' lifecycle
 * operations (YouTube player commands other than the iframe audio writes,
 * claimPlaybackOwner with a literal owner other than 'system-audio',
 * scheduleSessionReset), receivers resolved by type, module-level lifecycle
 * slots, timer names outside CHECK 12's start-timer set or outside
 * src/youtube/ (and the nameless clearAllManagedTimers), a helper outside
 * src/youtube/ that takes a timer name for a src/youtube/ caller, shared
 * phase unions, duplicated helper names, "mirrors" copy markers, and
 * registered timings retyped as literals in requester files.
 *
 * Exit code: 0 if clean, 1 if findings remain.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REGISTRY_PATH = 'docs/design/resource-ownership-registry.md';
const SOURCE_DIRECTORIES = ['src', 'cloudflare'] as const;

export interface ResourceOwnershipInput {
  /** Registry markdown. */
  readonly registry: string;
  /** Repository-relative production path (forward slashes) to source text. */
  readonly sources: ReadonlyMap<string, string>;
}

interface Allowance {
  readonly count: number;
  readonly reason: string;
}

type Baseline = ReadonlyMap<string, Allowance>;

interface PairAllowance {
  /**
   * `copy`: one contract written twice; a consolidation deletes it.
   * `suspect`: same name or value whose contract is not triaged yet.
   */
  readonly kind: 'copy' | 'suspect';
  readonly reason: string;
}

// ── CHECK 2 baselines: guarded page state, exact per-file counts ─────────
// Measured on main c08b6c39 (App 9.0.1) plus the registry, 2026-10-22.

/** RO-24: `.inert =` and setAttribute/toggleAttribute/removeAttribute('inert'). */
const INERT_WRITE_BASELINE: Baseline = new Map<string, Allowance>([
  ['src/core/inert-ownership.ts', { count: 7, reason: 'the owner ledger itself' }],
  ['src/player/video.ts', { count: 1, reason: 'element-local: the parked YouTube wrapper' }],
  [
    'src/ui/demo-inline-controls.ts',
    { count: 1, reason: 'element-local: hidden demo inline controls' },
  ],
  [
    'src/ui/player-controls.ts',
    { count: 1, reason: 'element-local: the YouTube container under its overlay' },
  ],
  ['src/ui/playlist-removal.ts', { count: 2, reason: 'element-local: the removal exit layer' }],
  ['src/ui/setup-shared.ts', { count: 2, reason: 'element-local: off-screen carousel slides' }],
  [
    'src/ui/sharing-action-motion-port.ts',
    { count: 2, reason: 'element-local: the Sync button during its motion' },
  ],
]);

/** RO-24: setElementInertForOwner() callers, the owner ledger's requesters. */
const PAGE_LOCK_CLAIM_BASELINE: Baseline = new Map<string, Allowance>([
  ['src/core/session-reset.ts', { count: 2, reason: 'reset overlay claim and release' }],
  ['src/ui/chat.ts', { count: 1, reason: 'mobile chat drawer background' }],
  ['src/ui/dom.ts', { count: 3, reason: 'modal stack claim, release and test reset' }],
]);

/** RO-24: `document.body.children` / `.childNodes` walks (the page lock). */
const BODY_CHILDREN_WALK_BASELINE: Baseline = new Map<string, Allowance>([
  ['src/core/session-reset.ts', { count: 1, reason: 'the reset locks every other body child' }],
]);

/**
 * RO-24: aria-hidden writes inside page-lock files (the owner, its claimers and
 * body-children walkers). Elsewhere aria-hidden is element-local and too noisy
 * to ratchet (61 writes in src/ on 2026-10-22); its total is report-only.
 */
const PAGE_LOCK_ARIA_HIDDEN_BASELINE: Baseline = new Map<string, Allowance>([
  ['src/core/inert-ownership.ts', { count: 4, reason: 'the owner ledger itself' }],
  ['src/core/session-reset.ts', { count: 3, reason: "the reset overlay's own visibility" }],
  ['src/ui/chat.ts', { count: 1, reason: 'the scroll-down button, not a page surface' }],
  ['src/ui/dom.ts', { count: 2, reason: 'overlay visibility and the clipboard textarea' }],
]);

/** RO-26: references to Fullscreen request methods (calls or resolvers). */
const FULLSCREEN_REQUEST_SINK_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'src/ui/player-controls.ts',
    { count: 4, reason: 'YouTube fullscreen toggle request (callers keep their request policy)' },
  ],
  ['src/ui/screensaver-entry.ts', { count: 3, reason: 'screensaver entry request resolver' }],
]);

/**
 * RO-26: references to Fullscreen exit methods. Only the one in-flight exit
 * slot may leave fullscreen (C8-I9), so two owners never exit twice.
 */
const FULLSCREEN_EXIT_SINK_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'src/core/fullscreen.ts',
    { count: 3, reason: 'exitFullscreenFor, the one bounded exit slot (C8-I8, C8-I9)' },
  ],
]);

/** RO-30, RO-23: history.pushState/replaceState/back/go/forward. */
const HISTORY_WRITE_BASELINE: Baseline = new Map<string, Allowance>([
  ['src/account/login-return.ts', { count: 1, reason: 'URL scrub of the login return marker' }],
  ['src/app.ts', { count: 1, reason: 'Back guard navigateBack port' }],
  ['src/core/back-button-history.ts', { count: 3, reason: 'the Back guard entry owner' }],
  ['src/i18n/localized-app-document.ts', { count: 1, reason: 'localized path rewrite in place' }],
  ['src/pro-room/claim-fragment.ts', { count: 3, reason: 'claim credential scrub and restore' }],
  ['src/pro-room/runtime.ts', { count: 1, reason: 'leave the room URL before a removal dialog' }],
  ['src/ui/account.ts', { count: 1, reason: 'URL scrub of the accountAuth marker' }],
  ['src/ui/setup.ts', { count: 1, reason: 'clean the joined room code from the URL' }],
]);

/** RO-23: location.reload/replace/assign and writes to location or its properties. */
const LOCATION_NAVIGATION_BASELINE: Baseline = new Map<string, Allowance>([
  // C6-14 moved app.ts's Back guard navigateHome port to navigateToAppHome (1 to 0).
  [
    'src/core/navigation.ts',
    {
      count: 3,
      reason:
        'the intents: home by replace and by push, and the /CODE return (C6-3 moved the setup, setup-guest and sw-register sinks here, 7 to 3)',
    },
  ],
  ['src/core/session-reset.ts', { count: 1, reason: 'the navigation owner reload' }],
  ['src/i18n/localized-app-document.ts', { count: 1, reason: 'language switch fallback' }],
  // C6-8 moved runtime.ts's PRESENCE_SUPERSEDED replace to navigateToAppHome (1 to 0).
  ['src/ui/account.ts', { count: 1, reason: 'login popup window, not this document' }],
]);

/** RO-22: 'SKIP_WAITING' messages to a waiting service worker. */
const SKIP_WAITING_BASELINE: Baseline = new Map<string, Allowance>([
  // Phase 3 C6-10: the hard reset asks the update machine first; its own send
  // stays for no machine and, temporarily, after the machine's promotion timed out.
  [
    'src/core/sw-hard-reset.ts',
    { count: 1, reason: 'the hard reset own promotion: no machine, or a machine timeout' },
  ],
  // Phase 3 C6-9 put the update machine's four sends (Apply, Apply to a
  // replacement, the cooldown and same-generation promotions) behind one
  // activateWaitingWorker sink (4 to 1).
  ['src/sw-register.ts', { count: 1, reason: 'the update machine, its one activation sink' }],
]);

// ── CHECK 3 baselines: Worker callers, exact per `file :: function` ───────

const BROADCAST_ENDPOINT = '/internal/realtime/v1/broadcast';

/** RO-07: string literals naming the signaling broadcast endpoint. */
const BROADCAST_ENDPOINT_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'cloudflare/pro-room-worker.ts :: postSignalingBroadcast',
    {
      count: 1,
      reason:
        'the one request builder for every lane (C7-3 merged broadcastServerEvent and dispatchPlaybackBroadcast, 2 to 1)',
    },
  ],
  ['cloudflare/signaling-worker.ts :: handleFetch', { count: 1, reason: 'the endpoint route' }],
]);

const DURATION_READER = 'readProRoomFileDuration';

/**
 * RO-08: value uses of readProRoomFileDuration (calls or the reader passed on)
 * in cloudflare/. The app's src/pro-room/upload-duration.ts runs the same
 * parser on the uploader's local file, which is not an R2 read and is outside
 * the resource, so src/ is not counted.
 */
const DURATION_READ_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'cloudflare/pro-room-worker.ts :: startAssetDurationProbe',
    { count: 1, reason: 'registration probe' },
  ],
  [
    'cloudflare/pro-room-worker.ts :: startPlaybackDurationProbe',
    { count: 1, reason: 'playback probe' },
  ],
]);

// ── CHECK 4 anchors: one deadline owner per PRO SFU attempt (G1) ─────────

const G1_SERVICE_FILE = 'src/pro-room/system-audio-service.ts';
// The receive deadline's home since Phase 5 C4-2 (the guest's before); the
// watchdog it arms is the receive slot's (src/network/system-audio-receive-slot.ts).
const G1_WATCHDOG_FILE = 'src/network/system-audio-media.ts';
const G1_RETRY_MAX_CONSTANT = 'SUBSCRIBER_RETRY_MAX_DELAY_MS';
const G1_WATCHDOG_CONSTANT = 'SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS';
const G1_SUBSCRIBE_CALL = 'subscribeProSystemAudioSfu';
const G1_RECEPTION_START_CALL = 'beginTrustedSystemAudioReception';

/**
 * RO-04: armed reception starts, exact per `file :: function`. Any value use
 * of beginTrustedSystemAudioReception counts unless it is a direct call whose
 * options are the literal `{ deadline: 'route' }` (Phase 5 C4-6 replaced
 * `{ receiveWatchdog: false }` with this deadline kind), so passing the start
 * around cannot hide an armed caller. The start returns early while the
 * placeholder is active, so an armed start that runs before the PRO SFU
 * start (for example in the retry path) re-arms the 30 s watchdog across the
 * backoff, which is G1 again.
 */
const ARMED_RECEPTION_START_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'src/network/system-audio-guest.ts :: registerSystemAudioGuestListeners',
    {
      count: 1,
      reason:
        "host SYSTEM_AUDIO_START frame (Standard P2P): { deadline: 'slot' }, the watchdog is its deadline",
    },
  ],
  [
    'src/network/system-audio-sfu.ts :: handleSfuReady',
    {
      count: 1,
      reason: "Standard SFU after a direct-route failure handoff: { deadline: 'slot' }",
    },
  ],
]);

// ── CHECK 5: timing contracts the registry names, and their triaged pairs ─

interface TimingContract {
  /** Registry records whose timing-constant homes list these files. */
  readonly records: readonly string[];
  readonly files: readonly string[];
}

const TIMING_CONTRACTS: readonly TimingContract[] = [
  { records: ['RO-01'], files: ['src/audio/context.ts', 'src/audio/context-recovery.ts'] },
  {
    records: ['RO-02', 'RO-03', 'RO-12'],
    files: [
      'src/youtube/zero-start.ts',
      'src/youtube/authority-arm.ts',
      'src/youtube/player.ts',
      'src/youtube/iframe.ts',
    ],
  },
  {
    records: ['RO-04'],
    files: [
      // The media home since Phase 5 C4-1 (MEDIA_TUNING_HOME, CHECK 10).
      'src/network/system-audio-media.ts',
      // The receive slot since Phase 5 C4-2.
      'src/network/system-audio-receive-slot.ts',
      'src/network/system-audio-guest.ts',
      'src/network/system-audio-sfu.ts',
      'src/network/pro-system-audio-sfu.ts',
      'src/network/pro-system-audio-direct.ts',
      'src/pro-room/system-audio-service.ts',
    ],
  },
  {
    records: ['RO-05'],
    files: [
      'src/youtube/constants.ts',
      'src/player/local-output-rejoin.ts',
      'src/player/background-return-sync.ts',
    ],
  },
  { records: ['RO-06'], files: ['src/player/file-play-timing.ts', 'src/demo/playback-timing.ts'] },
  {
    records: ['RO-15', 'RO-17'],
    files: [
      'src/core/constants.ts',
      'src/network/transport/cloudflare-signaling.ts',
      'src/network/transport/link-liveness.ts',
      'src/network/transport/control-isolation.ts',
      'src/network/heartbeat-monitor.ts',
      'src/network/transport-health.ts',
    ],
  },
  {
    records: ['RO-18'],
    files: [
      'src/storage/transfer-backpressure.ts',
      'src/storage/transfer-send.ts',
      'src/storage/preload.ts',
    ],
  },
  {
    records: ['RO-21'],
    files: ['src/pro-room/runtime.ts', 'src/pro-room/system-audio-service.ts'],
  },
  {
    records: ['RO-22', 'RO-23', 'RO-30'],
    files: [
      'src/core/navigation-contract.ts',
      'src/sw-register.ts',
      'src/sw-update-coordination.ts',
      'src/core/sw-hard-reset.ts',
      'src/core/session-reset.ts',
      'src/core/document-reload.ts',
      'src/core/back-button-history.ts',
    ],
  },
  {
    records: ['RO-26'],
    files: [
      'src/ui/screensaver-entry.ts',
      'src/player/video.ts',
      'src/core/fullscreen.ts',
      'src/ui/player-controls.ts',
    ],
  },
  {
    records: ['RO-27'],
    files: [
      'src/ui/playlist-motion.ts',
      'src/ui/playlist-reorder.ts',
      'src/ui/playlist-selection-gestures.ts',
      'src/ui/playlist-removal.ts',
      'src/ui/playlist-selection-morph.ts',
      'src/ui/playlist-view.ts',
    ],
  },
  {
    records: ['RO-28'],
    files: ['src/account/account-sync-protocol.ts', 'src/account/session.ts', 'src/ui/account.ts'],
  },
  {
    records: ['RO-29'],
    files: ['src/pro-room/runtime.ts', 'src/network/signaling-health.ts', 'src/network/peer.ts'],
  },
  {
    // The PRO playback transition barrier and COMMIT lead (Phase 5.5): their
    // shared home and the App controller that applies PREPARE and COMMIT. The
    // PRO Worker imports both names, so a same-named copy there cannot compile.
    records: ['RO-03'],
    files: ['cloudflare/pro-room-playback-timing.ts', 'src/pro-room/playback-controller.ts'],
  },
];

/**
 * Exact list of copied timing constants inside a contract, keyed by the
 * fingerprint the guard prints: same-named scalars, identical numeric tuples
 * of three or more, and timing objects sharing five or more values (0 and 1
 * ignored). Scalars that only share a value are report-only: round values
 * such as 1 s, 15 s and 30 s recur across unrelated contracts (28 such pairs
 * on 2026-10-22, mostly coincidences); run with --report to list them.
 */
const TIMING_PAIR_BASELINE = new Map<string, PairAllowance>([
  [
    'RO-02/RO-03/RO-12 TIMING@src/youtube/authority-arm.ts = ' +
      'YOUTUBE_ZERO_START_TIMING@src/youtube/zero-start.ts (10 shared values)',
    { kind: 'copy', reason: 'arm timing copied for PRO; Phase 0d C2-1 shares it' },
  ],
  [
    // Phase 3 R2: the lazy hard reset measures the logo claim's quiet reading
    // so the eager bundle does not carry it; the update machine stays the home.
    'RO-22/RO-23/RO-30 STARTUP_PROMPT_QUIET_MS@src/core/sw-hard-reset.ts = ' +
      'STARTUP_PROMPT_QUIET_MS@src/sw-register.ts (1000)',
    { kind: 'copy', reason: 'logo claim quiet window, lazy chunk; sw-hard-reset.test.ts parity' },
  ],
  [
    'RO-29 CONTROL_CHANNEL_RECOVERY_RETRY_MS@src/pro-room/runtime.ts = ' +
      'SIGNALING_RECOVERY_BACKOFF_MS@src/network/signaling-health.ts ([1000,2000,4000,8000,15000])',
    {
      kind: 'suspect',
      reason: 'PRO control channel vs Standard signaling reconnect; PRO copy kept separate (C5-2)',
    },
  ],
]);

// ── CHECK 6 baseline: AudioContext native resume()/suspend() (RO-44) ─────

/** Receivers whose zero-argument resume()/suspend() are not an AudioContext. */
const NON_AUDIO_CONTEXT_RECEIVERS = new Map<string, string>([
  ['controller', 'src/app.ts Back guard controller (pagehide/pageshow suspend and resume)'],
]);

const AUDIO_CONTEXT_NATIVE_CALL_BASELINE: Baseline = new Map<string, Allowance>([
  ['src/audio/context.ts', { count: 6, reason: 'singleton and foreground restart (Phase 7)' }],
  ['src/audio/context-recovery.ts', { count: 3, reason: 'interruption recovery, target owner' }],
  [
    'src/audio/ui-sounds.ts',
    {
      count: 2,
      reason:
        'resumes a non-running context on trusted pointerdown or Enter/Space and before a ' +
        'UI sound, without asking an owner (Phase 7 yields)',
    },
  ],
]);

// ── CHECK 7 baseline: Developer API authority fence writers (RO-25) ──────

const AUTHORITY_FENCE_TABLE = 'mxqr_developer_api_room_authority_fences';
/**
 * The name's tail, so the name cannot be assembled from a harmless-looking
 * prefix (it is not a prefix of the DEVELOPER_API_AUTHORITY_FENCED error code).
 */
const AUTHORITY_FENCE_NAME_PART = 'authority_fences';
const SQL_WRITE_TARGET_RE =
  /\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+["`[]?$/u;
const SQL_READ_SOURCE_RE = /\b(?:from|join)\s+["`[]?$/u;

/**
 * RO-25: literals that may write the authority fence table, exact per
 * `file :: function` anywhere in production code. The registry names these
 * as the only writers; the PRO decommission's entry is the table name in its
 * `DELETE FROM ${table}` loop list.
 */
const AUTHORITY_FENCE_WRITE_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'cloudflare/app-worker.ts :: clearDeveloperApiAuthorityFence',
    { count: 1, reason: 'the one clearer: the transfer clears only its own digest' },
  ],
  [
    'cloudflare/app-worker.ts :: revokeDeveloperApiKeysForAuthorityChange',
    {
      count: 1,
      reason: 'the one activator: an upsert from the typed AuthorityFenceWrite (C7-11)',
    },
  ],
  [
    'cloudflare/pro-room-worker.ts :: deleteDeveloperRoomData',
    {
      count: 1,
      reason: 'decommission: DELETE FROM ${table} over the incarnation Developer API tables',
    },
  ],
]);

// ── CHECK 8 baseline: header loader default holder (RO-47) ──────────────

/**
 * RO-47: showLoader(show, text, id) and updateLoader(percent, id) calls whose
 * holder ID is missing or can be undefined, exact per file in src/
 * (src/ui/toast.ts, the owner, excluded).
 * Shows, hides and progress ticks all count: each one writes the holder the
 * current foreground media load owns.
 */
const DEFAULT_LOADER_WRITE_BASELINE: Baseline = new Map<string, Allowance>([
  ['src/demo/mode.ts', { count: 5, reason: 'guided demo track download and its end' }],
  [
    'src/player/decode.ts',
    { count: 14, reason: 'file prepare and decode; hides gated by the load session' },
  ],
  [
    'src/player/playback.ts',
    { count: 8, reason: "guest wait, request and receive of the current track's file" },
  ],
  [
    'src/share/remote-share.ts',
    { count: 11, reason: 'foreground remote-share wait and download (uploads are named)' },
  ],
  [
    'src/storage/preload.ts',
    {
      count: 4,
      reason:
        'PLAY of a preloaded track: the awaited receive (its ID is undefined when awaited) and ' +
        'the request fallback; a background receive is named',
    },
  ],
  ['src/storage/recovery.ts', { count: 2, reason: 'clears it when a recovery request ends' }],
  ['src/storage/storage.ts', { count: 2, reason: 'clears it when a stuck transfer resets' }],
  [
    'src/storage/transfer-receive.ts',
    { count: 13, reason: "guest prepare and receive of the current track's file" },
  ],
  ['src/ui/setup.ts', { count: 6, reason: 'clears a stale one when a guest join fails' }],
  [
    'src/youtube/iframe.ts',
    { count: 12, reason: 'playlist indexing; clears a file load when YouTube takes over' },
  ],
  ['src/youtube/player.ts', { count: 1, reason: 'clears it when YouTube mode stops' }],
]);

// ── CHECK 9 baselines: system-audio receive slot writers (RO-04) ─────────
// Measured on agent/phase5-5a aa62fe34 (main 2038b51f, App 9.0.10) on
// 2026-10-25, Phase 5 prep T5. The route adapters wrote the slot directly
// then; each Phase 5 increment that moved a write into the receive slot
// lowered its count here. C4-2 moved the trusted reception's writes (the end
// of reception, the delivery-handoff interrupt and the placeholder claim)
// from the guest into src/network/system-audio-receive-slot.ts, C4-3 the
// Standard direct call's attach (its receiving flag, owner claim and
// widener.input source), which leaves the guest none, C4-4 the Standard
// SFU guest's attach through the same slot attach, which leaves the SFU none
// and lowers each total by one, and C4-5 the PRO coordinator's attach, resume
// and interrupts, which leaves the service none: its attach shares the slot
// attach, its resume the attach's reception start and its three interrupts
// the slot's interrupt, so the slot's counts stay as they were. C4-6 and C4-7
// changed no count. Final since C4-8 (the last receive-slot increment): the
// slot is the only receive writer. The other entries are not receive routes
// (the sharer's own capture, the file playback route, the leaveSession
// reset), and no route adapter has one, so a route that writes the slot
// itself is UNSANCTIONED; a new entry needs the RO-04 record update.

const RECEIVING_FLAG_SETTER = 'setSystemAudioReceiving';
const PLAYBACK_OWNER_CLAIM = 'claimPlaybackOwner';
const SYSTEM_AUDIO_OWNER = 'system-audio';
const RECEIVING_FLAG_KEY = 'systemAudio.isReceiving';
/** The setter's home: its one setState of the key is the sanctioned write. */
const RECEIVING_FLAG_OWNER_FILE = 'src/player/ownership.ts';

/** RO-04: setSystemAudioReceiving value uses (calls or the setter passed on). */
const RECEIVING_FLAG_WRITE_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'src/network/system-audio-receive-slot.ts',
    {
      count: 3,
      reason:
        'the slot: the end of reception, the interrupt (the Standard delivery handoff, C4-2; ' +
        'the PRO disconnect grace, retry and receiver fallback, C4-5) and the reception start ' +
        "a route's attach or resume runs (Standard direct C4-3, SFU C4-4, PRO coordinator C4-5)",
    },
  ],
]);

/** RO-04: claimPlaybackOwner value uses that can claim 'system-audio'. */
const SYSTEM_AUDIO_OWNER_CLAIM_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'src/audio/system-capture.ts',
    { count: 1, reason: "the sharer's own capture, not the receive slot" },
  ],
  [
    'src/network/system-audio-receive-slot.ts',
    {
      count: 2,
      reason:
        "the slot: the trusted reception placeholder (C4-2) and the reception start a route's " +
        'attach or resume runs (Standard direct C4-3, SFU C4-4, PRO coordinator C4-5)',
    },
  ],
]);

/** RO-04: `.input` reads on a receiver named `widener` (the stereo widener's input). */
const WIDENER_INPUT_USE_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'src/audio/engine.ts',
    { count: 2, reason: 'the file playback route, at graph build and on reconnect' },
  ],
  [
    'src/network/system-audio-receive-slot.ts',
    {
      count: 1,
      reason:
        "the slot's attach: the Standard direct call's (C4-3), SFU guest's (C4-4) and PRO " +
        "coordinator's (C4-5) source",
    },
  ],
]);

/** RO-04: raw 'systemAudio.isReceiving' writes outside the setter's home. */
const RAW_RECEIVING_FLAG_WRITE_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'src/network/peer.ts',
    { count: 1, reason: 'the leaveSession batchSetState reset, with the rest of the session' },
  ],
]);

// ── CHECK 10 baseline: system-audio media tuning home (RO-04) ────────────
// Phase 5 5A C4-1 moved the receivers' playout-delay hint, the senders'
// stereo bitrate cap and the Cloudflare Realtime STUN entry out of the route
// adapters into one deferred module. Only the system-audio route files are
// scanned: the eager STUN entries in peer.ts and standard-room-prerequisites
// .ts cannot import a deferred module without pulling it into the first load.

const MEDIA_TUNING_HOME = 'src/network/system-audio-media.ts';
const MEDIA_TUNING_SCOPE_RE = /^src\/network\/(?:pro-)?system-audio-[^/]+\.ts$/u;
const MEDIA_TUNING_MEMBERS = new Set(['playoutDelayHint', 'maxBitrate']);
const REALTIME_STUN_HOST = 'stun.cloudflare.com';

/**
 * RO-04: `playoutDelayHint` and `maxBitrate` writes (an assignment, or an
 * object-literal key such as a sendEncodings entry) and string literals
 * naming the Realtime STUN host, per system-audio route file.
 */
const MEDIA_TUNING_BASELINE: Baseline = new Map<string, Allowance>([
  [
    MEDIA_TUNING_HOME,
    {
      count: 3,
      reason: 'the home: the playout-delay hint, the stereo bitrate cap and the STUN entry',
    },
  ],
]);

// ── CHECK 11 baseline: YouTube iframe audio writes (RO-12) ───────────────
// Measured on main 23f29283 (App 9.0.27) on 2026-10-31, Phase 6 T1: the same
// 44 calls in the same five files as a text search for `mute(`, `unMute(` and
// `setVolume(` found on 2026-10-30. Phase 6 moves the writes to one
// iframe-audio owner and lowers these counts as it goes; the iOS prime unMute
// and the retained player's hard-mute proof stay.

const IFRAME_AUDIO_WRITE_METHODS = new Set(['mute', 'unMute', 'setVolume']);

/**
 * RO-12: mute(), unMute() and setVolume() calls on a receiver, per file in
 * src/. The count is by name, so a write through a helper counts once, inside
 * the helper: each reason names the helpers that hold its writes, whose
 * callers write the iframe audio without a count of their own.
 */
const IFRAME_AUDIO_WRITE_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'src/youtube/authority-arm.ts',
    {
      count: 10,
      reason:
        'the PRO arm: the hard mute in prepare and #waitForHardMute (4), the active restore ' +
        '#restoreCapturedAudio (3) and the detached restore #attemptDetachedAudioRestore (3)',
    },
  ],
  [
    'src/youtube/iframe.ts',
    {
      count: 3,
      reason:
        'the iOS prime unMute in primeYouTubePlayer, which must stay inside the gesture call ' +
        'stack; the mute before createYouTubePlayer destroys a pre-ready prime facade; the silent ' +
        "prime cue's mute in onYouTubePlayerReady",
    },
  ],
  [
    'src/youtube/player.ts',
    {
      count: 17,
      reason:
        'the PRO direct commit applyProPlaybackYouTubeCommit (3); the mute before stopYouTubeMode ' +
        'destroys the player (1); the helper restoreFallbackAudio (3), through which the host ' +
        'legacy recovery and the guest local fallback restore audio, and their mutes before a ' +
        'load or a wait (attemptRecovery 1, attemptFallback 2); the youtube:set-volume handler ' +
        '(3) and the PRO pause gate handlers (pending 1, settled 3)',
    },
  ],
  [
    'src/youtube/retained-player-controller.ts',
    {
      count: 2,
      reason:
        'the parking hard-mute proof issueHardMute (reached through ' +
        'ensureRetainedYouTubePlayerHardMuted in iframe.ts) and the mute before destroy',
    },
  ],
  [
    'src/youtube/zero-start.ts',
    {
      count: 12,
      reason:
        'the Standard zero-start controller: the release unMute and its retry in ' +
        'handlePlayerStateChange (2), the hard mute in #beginLocalPrepare and #waitForHardMute ' +
        '(4), the active restore #attemptRunAudioRestore (3) and the detached restore ' +
        'attemptRestore (3)',
    },
  ],
]);

// ── CHECK 12 baselines: cross-file YouTube start-timer reads and clears ──
// Measured on main 23f29283 (App 9.0.27) on 2026-10-31, Phase 6 T1: the same
// 14 reads and 10 clears the 2026-10-30 Phase 6 plan counted by hand. Phase 6
// 6A-1 replaced the reads of the legacy rendezvous and sync.ts timers with
// owner queries, which each owner answers from its own timers (11 reads): the
// player runtime bridge's isYouTubeAutoSyncPending, which player.ts answers,
// and the query sync.ts registers with the native-control authority. The PRO
// coordinator nudge reads stay, because the manual-offset transaction (RO-13)
// is owner-in-place. Phase 6 6A-2 dropped iframe.ts's 'yt-clock-action' clear,
// which resetYouTubeSyncState repeats through its owner (9 clears). On every
// tree since T1 each timer call in src/youtube/ resolves its name (the five
// templates name per-peer timers that cannot spell a start timer), no file
// renames or passes on a timer function, and each start timer is set only by
// its listed files, so the fail-closed findings have no allowance.

const START_TIMER_SCOPE = 'src/youtube/';
const TIMER_SET_CALL = 'setManagedTimer';
const TIMER_USE_CALLS = new Map<string, 'read' | 'clear'>([
  ['getManagedTimer', 'read'],
  ['clearManagedTimer', 'clear'],
]);

const START_TIMER_PLAYER = 'src/youtube/player.ts';
const START_TIMER_SYNC = 'src/youtube/sync.ts';

/**
 * RO-02: the YouTube start timers and the src/youtube/ files that set each
 * one with setManagedTimer(). setManagedTimer() clears a running timer of the
 * same name first, so another setter would be a second machine on the start.
 * A change that sets a new start timer, renames or removes one, or moves its
 * setter updates this map and the RO-02 record together: CHECK 12 fails while
 * another src/youtube/ file sets a start timer or a listed file stops setting
 * it.
 */
const START_TIMER_SETTERS: ReadonlyMap<string, readonly string[]> = new Map([
  // The legacy rendezvous, its local start and the three zero-start fallbacks.
  ['yt-auto-sync', [START_TIMER_PLAYER]],
  ['yt-host-local-start', [START_TIMER_PLAYER]],
  ['yt-zero-start-external-fallback', [START_TIMER_PLAYER]],
  ['yt-zero-start-host-fallback', [START_TIMER_PLAYER]],
  ['yt-zero-start-replacement-fallback', [START_TIMER_PLAYER]],
  // The guest state actions and the rendezvous.
  ['yt-clock-action', [START_TIMER_SYNC]],
  ['yt-seek-play', [START_TIMER_SYNC]],
  ['yt-rendezvous-buffer', [START_TIMER_SYNC]],
  ['yt-rendezvous-play', [START_TIMER_SYNC]],
  ['yt-rendezvous-calibrate', [START_TIMER_SYNC]],
  ['yt-rendezvous-follow-up', [START_TIMER_SYNC]],
  // PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER (named in local-offset.ts), set by the
  // manual-offset gate and runtime (RO-13).
  [
    'yt-pro-coordinator-local-nudge',
    [
      'src/youtube/standard-host-manual-offset-gate.ts',
      'src/youtube/standard-host-manual-offset-runtime.ts',
    ],
  ],
]);

const START_TIMER_NAMES: ReadonlySet<string> = new Set(START_TIMER_SETTERS.keys());

/** RO-02: start-timer reads (getManagedTimer) from a file that does not set the timer. */
const START_TIMER_READ_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'src/youtube/iframe.ts',
    {
      count: 1,
      reason:
        'the PRO coordinator nudge in onYouTubePlayerStateChange (stays); the auxiliary ' +
        "YOUTUBE_STATE hold and the sub-video advance check ask the 'yt-auto-sync' owner " +
        'query since Phase 6 6A-1',
    },
  ],
  [
    'src/youtube/local-offset.ts',
    {
      count: 2,
      reason:
        'the PRO coordinator nudge in readActiveNudgeAnchor and ' +
        'rebaseProCoordinatorYouTubeNudgeAnchor (stays): this file names the timer, the ' +
        'manual-offset gate and runtime set it',
    },
  ],
  [
    'src/youtube/native-control-authority.ts',
    {
      count: 1,
      reason:
        'the PRO coordinator nudge in hasProtectedTransitionOwner (stays, RO-13 is ' +
        "owner-in-place); 'yt-auto-sync' and sync.ts's state actions and rendezvous stages " +
        'answer through owner queries since Phase 6 6A-1',
    },
  ],
  [
    'src/youtube/player.ts',
    {
      count: 4,
      reason:
        'the PRO coordinator nudge (stays): the PRO lead sample (scheduleSample), ' +
        "scheduleLateJoinRendezvousSync, the host's youtube:toggle-play handler and " +
        'bootstrapYouTubePeer',
    },
  ],
  [
    'src/youtube/sync.ts',
    {
      count: 3,
      reason:
        'the PRO coordinator nudge in reconcileCanonicalManualOffsetEndpoint and twice in ' +
        'broadcastYouTubeSync (stays); the non-manual heartbeat hold asks the ' +
        "'yt-auto-sync' owner query since Phase 6 6A-1",
    },
  ],
]);

/** RO-02: start-timer clears (clearManagedTimer) from a file that does not set the timer. */
const START_TIMER_CLEAR_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'src/youtube/iframe.ts',
    {
      count: 2,
      reason:
        "resetResidentYouTubeSync clears 'yt-seek-play', which resetYouTubeSyncState, called " +
        'next, clears again (the YouTube-to-YouTube reuse regression test, which mocks sync.ts, ' +
        "pins this clear), and 'yt-auto-sync' without player.ts's retire (stays); its " +
        "'yt-clock-action' clear went in Phase 6 6A-2, as resetYouTubeSyncState retires that " +
        'timer through its owner, cancelClockAction',
    },
  ],
  [
    'src/youtube/player.ts',
    {
      count: 6,
      reason:
        "'yt-clock-action' and 'yt-seek-play' in tryBeginYouTubeZeroStart, stopYouTubeMode and " +
        "the zero-start onPrepareSelection, without sync.ts's cancelClockAction (its " +
        'generation and loading indicator)',
    },
  ],
  [
    'src/youtube/sync.ts',
    {
      count: 1,
      reason:
        "the PRO coordinator nudge in resetYouTubeSyncState, right after the owner's reset " +
        'port resetStandardHostManualOffsetTransaction',
    },
  ],
]);

/** Every record ID this guard's manifests name, for CHECK 1. */
const GUARD_RECORD_IDS: readonly string[] = [
  'RO-01',
  'RO-02',
  'RO-04',
  'RO-07',
  'RO-08',
  'RO-12',
  'RO-22',
  'RO-23',
  'RO-24',
  'RO-25',
  'RO-26',
  'RO-30',
  'RO-44',
  'RO-47',
  ...TIMING_CONTRACTS.flatMap((contract) => contract.records),
];

// ── Source loading ───────────────────────────────────────────────────────

function isProductionSource(relPath: string): boolean {
  if (!/\.(?:m?ts|tsx)$/u.test(relPath)) return false;
  if (/\.d\.m?ts$/u.test(relPath)) return false;
  if (/\.(?:test|spec)\.m?tsx?$/u.test(relPath)) return false;
  if (relPath.split('/').includes('__tests__')) return false;
  return !relPath.startsWith('cloudflare/types/');
}

function walk(directory: string, root: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules') continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) walk(full, root, out);
    else out.push(path.relative(root, full).replace(/\\/gu, '/'));
  }
}

export function loadResourceOwnershipInput(root: string = repoRoot): ResourceOwnershipInput {
  const files: string[] = [];
  for (const directory of SOURCE_DIRECTORIES) walk(path.join(root, directory), root, files);
  const sources = new Map<string, string>();
  for (const relPath of files.filter(isProductionSource).sort()) {
    sources.set(relPath, readFileSync(path.join(root, relPath), 'utf8'));
  }
  let registry = '';
  try {
    registry = readFileSync(path.join(root, REGISTRY_PATH), 'utf8');
  } catch {
    // Reported by CHECK 1.
  }
  return { registry, sources };
}

// ── AST helpers ──────────────────────────────────────────────────────────

const sourceFileCache = new Map<string, { readonly text: string; readonly file: ts.SourceFile }>();

function parse(relPath: string, text: string): ts.SourceFile {
  const cached = sourceFileCache.get(relPath);
  if (cached?.text === text) return cached.file;
  const file = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  sourceFileCache.set(relPath, { text, file });
  return file;
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Name of a property access (`a.b`) or string-keyed element access (`a['b']`). */
function memberName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

/** Last identifier of a receiver: `window.history` -> `history`, `this` -> `this`. */
function receiverName(expression: ts.Expression): string | null {
  const current = unwrap(expression);
  if (ts.isIdentifier(current)) return current.text;
  if (current.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  return memberName(current);
}

function isAssignmentTarget(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  return memberName(callee);
}

function firstStringArgument(call: ts.CallExpression): string | null {
  const first = call.arguments[0];
  return first && ts.isStringLiteralLike(first) ? first.text : null;
}

function propertyNameText(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText();
}

/** Nearest named function, method or function-valued binding around a node. */
function enclosingFunctionName(node: ts.Node): string {
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)) &&
      current.name
    ) {
      return propertyNameText(current.name);
    }
    if (ts.isConstructorDeclaration(current)) return 'constructor';
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
        return propertyNameText(parent.name);
      }
    }
  }
  return '<module>';
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

// ── Numeric constant evaluation (CHECK 4, CHECK 5) ───────────────────────

type ConstantValue = number | readonly number[] | ReadonlyMap<string, number>;

interface TopLevelConstant {
  readonly name: string;
  readonly value: ConstantValue;
}

function evaluate(
  expression: ts.Expression,
  scope: ReadonlyMap<string, ConstantValue>,
): ConstantValue | undefined {
  const node = unwrap(expression);
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/gu, ''));
  if (ts.isIdentifier(node)) return scope.get(node.text);
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = evaluate(node.operand, scope);
    if (typeof operand !== 'number') return undefined;
    if (node.operator === ts.SyntaxKind.MinusToken) return -operand;
    return node.operator === ts.SyntaxKind.PlusToken ? operand : undefined;
  }
  if (ts.isBinaryExpression(node)) {
    const left = evaluate(node.left, scope);
    const right = evaluate(node.right, scope);
    if (typeof left !== 'number' || typeof right !== 'number') return undefined;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return left + right;
      case ts.SyntaxKind.MinusToken:
        return left - right;
      case ts.SyntaxKind.AsteriskToken:
        return left * right;
      case ts.SyntaxKind.SlashToken:
        return left / right;
      case ts.SyntaxKind.AsteriskAsteriskToken:
        return left ** right;
      default:
        return undefined;
    }
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values: number[] = [];
    for (const element of node.elements) {
      const value = evaluate(element, scope);
      if (typeof value !== 'number') return undefined;
      values.push(value);
    }
    return values;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const values = new Map<string, number>();
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const value = evaluate(property.initializer, scope);
      if (typeof value === 'number') values.set(propertyNameText(property.name), value);
    }
    return values;
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    unwrap(node.expression).getText() === 'Object.freeze'
  ) {
    const argument = node.arguments[0];
    return argument ? evaluate(argument, scope) : undefined;
  }
  return undefined;
}

function topLevelConstants(file: ts.SourceFile): readonly TopLevelConstant[] {
  const scope = new Map<string, ConstantValue>();
  const constants: TopLevelConstant[] = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const value = evaluate(declaration.initializer, scope);
      if (value === undefined) continue;
      scope.set(declaration.name.text, value);
      constants.push({ name: declaration.name.text, value });
    }
  }
  return constants;
}

function formatValue(value: ConstantValue): string {
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.join(',')}]`;
  return `{${[...(value as ReadonlyMap<string, number>).values()].join(',')}}`;
}

// ── Per-file facts ───────────────────────────────────────────────────────

const FULLSCREEN_REQUEST_SINK_NAMES = new Set([
  'requestFullscreen',
  'webkitRequestFullscreen',
  'webkitRequestFullScreen',
  'webkitEnterFullscreen',
  'mozRequestFullScreen',
  'msRequestFullscreen',
]);
const FULLSCREEN_EXIT_SINK_NAMES = new Set([
  'exitFullscreen',
  'webkitExitFullscreen',
  'webkitCancelFullScreen',
  'webkitExitFullScreen',
  'mozCancelFullScreen',
  'msExitFullscreen',
]);
const HISTORY_ENTRY_METHODS = new Set(['pushState', 'replaceState']);
const HISTORY_TRAVERSAL_METHODS = new Set(['back', 'go', 'forward']);
const LOCATION_NAVIGATION_METHODS = new Set(['reload', 'replace', 'assign']);
const ATTRIBUTE_WRITE_METHODS = new Set(['setAttribute', 'toggleAttribute', 'removeAttribute']);

interface FileFacts {
  inertWrites: number;
  pageLockClaims: number;
  bodyChildrenWalks: number;
  ariaHiddenWrites: number;
  fullscreenRequestSinks: number;
  fullscreenExitSinks: number;
  historyWrites: number;
  locationNavigations: number;
  skipWaitingSends: number;
  audioContextNativeCalls: number;
  receivingFlagWrites: number;
  systemAudioOwnerClaims: number;
  widenerInputUses: number;
  rawReceivingFlagWrites: number;
  mediaTuningSites: number;
  readonly broadcastEndpointSites: string[];
  readonly durationReadSites: string[];
  readonly armedReceptionStartSites: string[];
  readonly authorityFenceWriteSites: string[];
  /** CHECK 11: `file:line method() in function`, one per write. */
  readonly iframeAudioWriteSites: string[];
  readonly ownerHeaders: string[];
}

const factsCache = new Map<string, { readonly text: string; readonly facts: FileFacts }>();

function isHistoryReceiver(expression: ts.Expression): boolean {
  const name = receiverName(expression);
  return name !== null && /(?:^h|H)istory$/u.test(name);
}

function isLocationReceiver(expression: ts.Expression): boolean {
  return receiverName(expression) === 'location';
}

/** An identifier used as a value, not the name an import, export or binding declares. */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent)
  ) {
    return false;
  }
  if (ts.isBindingElement(parent)) return parent.initializer === node;
  if (
    ts.isFunctionDeclaration(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isMethodDeclaration(parent)
  ) {
    return parent.name !== node;
  }
  return true;
}

/**
 * Text of a string literal or a whole template literal, with each template
 * substitution as U+0000; null for any other node (template parts are read
 * through their template, so they never count twice).
 */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return null;
  return node.head.text + node.templateSpans.map((span) => `\u0000${span.literal.text}`).join('');
}

/**
 * RO-25: whether a literal may write the authority fence table. It does when
 * it inserts into, replaces into, updates or deletes from the table, names
 * the table in any other way (a bare name can become the target of
 * template-built SQL such as `DELETE FROM ${table}`), or holds a piece of the
 * name outside a full one. Reads (FROM or JOIN the table, as in EXISTS
 * subqueries) and qualified columns (`table.column`) do not. SQL names are
 * case-insensitive, so the match is too.
 */
function mayWriteAuthorityFence(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower.includes(AUTHORITY_FENCE_NAME_PART)) return false;
  const names = lower.split(AUTHORITY_FENCE_TABLE).length - 1;
  const parts = lower.split(AUTHORITY_FENCE_NAME_PART).length - 1;
  if (parts > names) return true;
  for (
    let index = lower.indexOf(AUTHORITY_FENCE_TABLE);
    index !== -1;
    index = lower.indexOf(AUTHORITY_FENCE_TABLE, index + 1)
  ) {
    const next = lower.charAt(index + AUTHORITY_FENCE_TABLE.length);
    if (next === '.') continue;
    const before = lower.slice(0, index);
    if (SQL_WRITE_TARGET_RE.test(before)) return true;
    // Part of a longer identifier, such as an index name: not a plain read.
    if (/\w$/u.test(before) || /^\w/u.test(next)) return true;
    if (!SQL_READ_SOURCE_RE.test(before)) return true;
  }
  return false;
}

/** A property name's text when it is static, including `['literal']`; null otherwise. */
function staticPropertyName(name: ts.PropertyName): string | null {
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrap(name.expression);
    return ts.isStringLiteralLike(expression) ? expression.text : null;
  }
  return propertyNameText(name);
}

/**
 * RO-04: whether a claimPlaybackOwner value use can claim the 'system-audio'
 * owner. Only a direct call whose first argument is another string literal
 * cannot; a computed owner, or the claim passed on, counts.
 */
function mayClaimSystemAudio(node: ts.Identifier): boolean {
  const access =
    ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
  const call = access.parent;
  if (!ts.isCallExpression(call) || call.expression !== access) return true;
  const owner = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
  return !owner || !ts.isStringLiteralLike(owner) || owner.text === SYSTEM_AUDIO_OWNER;
}

const constInitializerCache = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<string, readonly ts.Expression[]>
>();

/** `const` initialisers by name, anywhere in a file (names match across the file). */
function constInitializers(file: ts.SourceFile): ReadonlyMap<string, readonly ts.Expression[]> {
  const cached = constInitializerCache.get(file);
  if (cached) return cached;
  const consts = new Map<string, ts.Expression[]>();
  visit(file, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    const list = node.parent;
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return;
    consts.set(node.name.text, [...(consts.get(node.name.text) ?? []), node.initializer]);
  });
  constInitializerCache.set(file, consts);
  return consts;
}

/** The keys an element-access key can name: a string literal, a conditional of them, a const holding one. */
function staticKeys(expression: ts.Expression, file: ts.SourceFile, hops = 0): readonly string[] {
  if (hops > 4) return [];
  const node = unwrap(expression);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    return [
      ...staticKeys(node.whenTrue, file, hops + 1),
      ...staticKeys(node.whenFalse, file, hops + 1),
    ];
  }
  if (!ts.isIdentifier(node)) return [];
  return (constInitializers(file).get(node.text) ?? []).flatMap((initializer) =>
    staticKeys(initializer, file, hops + 1),
  );
}

/**
 * RO-12: the iframe audio methods a computed member call can name, such as
 * `player[muted ? 'mute' : 'unMute']()` or `player[method]()` with a const
 * `method`; none for any other call.
 */
function computedIframeAudioMethods(
  call: ts.CallExpression,
  file: ts.SourceFile,
): readonly string[] {
  const callee = unwrap(call.expression);
  if (!ts.isElementAccessExpression(callee)) return [];
  return [...new Set(staticKeys(callee.argumentExpression, file))]
    .filter((key) => IFRAME_AUDIO_WRITE_METHODS.has(key))
    .sort();
}

function collectFacts(relPath: string, text: string): FileFacts {
  const cached = factsCache.get(relPath);
  if (cached?.text === text) return cached.facts;
  const file = parse(relPath, text);
  const facts: FileFacts = {
    inertWrites: 0,
    pageLockClaims: 0,
    bodyChildrenWalks: 0,
    ariaHiddenWrites: 0,
    fullscreenRequestSinks: 0,
    fullscreenExitSinks: 0,
    historyWrites: 0,
    locationNavigations: 0,
    skipWaitingSends: 0,
    audioContextNativeCalls: 0,
    receivingFlagWrites: 0,
    systemAudioOwnerClaims: 0,
    widenerInputUses: 0,
    rawReceivingFlagWrites: 0,
    mediaTuningSites: 0,
    broadcastEndpointSites: [],
    durationReadSites: [],
    armedReceptionStartSites: [],
    authorityFenceWriteSites: [],
    iframeAudioWriteSites: [],
    ownerHeaders: [],
  };

  for (const match of text.matchAll(
    /^[ \t]*(?:\/\/|\/?\*+)[ \t]*Resource owner:[ \t]*(RO-\d+(?:[ \t]*,[ \t]*RO-\d+)*)/gmu,
  )) {
    for (const id of (match[1] ?? '').split(',')) facts.ownerHeaders.push(id.trim());
  }

  visit(file, (node) => {
    const literal = literalText(node);
    if (literal !== null && mayWriteAuthorityFence(literal)) {
      facts.authorityFenceWriteSites.push(`${relPath} :: ${enclosingFunctionName(node)}`);
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      if (node.text.includes(BROADCAST_ENDPOINT)) {
        facts.broadcastEndpointSites.push(`${relPath} :: ${enclosingFunctionName(node)}`);
      }
      if (node.text === 'SKIP_WAITING') facts.skipWaitingSends += 1;
      if (node.text.toLowerCase().includes(REALTIME_STUN_HOST)) facts.mediaTuningSites += 1;
    } else if (ts.isIdentifier(node) && node.text === DURATION_READER && isValueReference(node)) {
      // Any value use, so passing the reader around cannot hide a caller.
      facts.durationReadSites.push(`${relPath} :: ${enclosingFunctionName(node)}`);
    } else if (
      ts.isIdentifier(node) &&
      node.text === G1_RECEPTION_START_CALL &&
      isValueReference(node)
    ) {
      const access =
        ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
          ? node.parent
          : node;
      const call = access.parent;
      const disarmed =
        ts.isCallExpression(call) && call.expression === access && disablesWatchdog(call);
      if (!disarmed) {
        facts.armedReceptionStartSites.push(`${relPath} :: ${enclosingFunctionName(node)}`);
      }
    } else if (
      ts.isIdentifier(node) &&
      node.text === RECEIVING_FLAG_SETTER &&
      isValueReference(node)
    ) {
      // Any value use, so passing the setter around cannot hide a writer.
      facts.receivingFlagWrites += 1;
    } else if (
      ts.isIdentifier(node) &&
      node.text === PLAYBACK_OWNER_CLAIM &&
      isValueReference(node) &&
      mayClaimSystemAudio(node)
    ) {
      facts.systemAudioOwnerClaims += 1;
    }

    if (
      relPath !== RECEIVING_FLAG_OWNER_FILE &&
      ts.isPropertyAssignment(node) &&
      staticPropertyName(node.name) === RECEIVING_FLAG_KEY
    ) {
      // A batchSetState (or any object-literal) write of the flag.
      facts.rawReceivingFlagWrites += 1;
    }
    if (
      (ts.isPropertyAssignment(node) &&
        MEDIA_TUNING_MEMBERS.has(staticPropertyName(node.name) ?? '')) ||
      (ts.isShorthandPropertyAssignment(node) && MEDIA_TUNING_MEMBERS.has(node.name.text))
    ) {
      // An object literal that carries the hint or the bitrate, such as a
      // sendEncodings entry or an Object.assign source.
      facts.mediaTuningSites += 1;
    }

    const member = memberName(node);
    if (
      member !== null &&
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    ) {
      const receiver = node.expression;
      if (member === 'inert' && isAssignmentTarget(node)) facts.inertWrites += 1;
      if (MEDIA_TUNING_MEMBERS.has(member) && isAssignmentTarget(node)) {
        facts.mediaTuningSites += 1;
      }
      if (member === 'ariaHidden' && isAssignmentTarget(node)) facts.ariaHiddenWrites += 1;
      if ((member === 'children' || member === 'childNodes') && receiverName(receiver) === 'body') {
        facts.bodyChildrenWalks += 1;
      }
      if (member === 'input' && receiverName(receiver) === 'widener' && !isAssignmentTarget(node)) {
        facts.widenerInputUses += 1;
      }
      if (!isAssignmentTarget(node)) {
        if (FULLSCREEN_REQUEST_SINK_NAMES.has(member)) facts.fullscreenRequestSinks += 1;
        if (FULLSCREEN_EXIT_SINK_NAMES.has(member)) facts.fullscreenExitSinks += 1;
      }
      if (HISTORY_ENTRY_METHODS.has(member)) facts.historyWrites += 1;
      else if (HISTORY_TRAVERSAL_METHODS.has(member) && isHistoryReceiver(receiver)) {
        facts.historyWrites += 1;
      }
      if (LOCATION_NAVIGATION_METHODS.has(member) && isLocationReceiver(receiver)) {
        facts.locationNavigations += 1;
      } else if (
        isAssignmentTarget(node) &&
        (member === 'location' || isLocationReceiver(receiver))
      ) {
        facts.locationNavigations += 1;
      }
    } else if (ts.isIdentifier(node) && node.text === 'location' && isAssignmentTarget(node)) {
      facts.locationNavigations += 1;
    }

    if (!ts.isCallExpression(node)) return;
    const callee = calleeName(node);
    if (callee === null) {
      // player[muted ? 'mute' : 'unMute']() or player[method]() with a const
      // method: one write, whichever method the key names.
      const methods = computedIframeAudioMethods(node, file);
      if (methods.length > 0) {
        facts.iframeAudioWriteSites.push(
          `${relPath}:${lineOf(file, node)} ${methods.join('()/')}() in ${enclosingFunctionName(node)}`,
        );
      }
      return;
    }
    if (ATTRIBUTE_WRITE_METHODS.has(callee)) {
      const attribute = firstStringArgument(node);
      if (attribute === 'inert') facts.inertWrites += 1;
      else if (attribute === 'aria-hidden') facts.ariaHiddenWrites += 1;
    } else if (callee === 'setElementInertForOwner') {
      facts.pageLockClaims += 1;
    } else if (callee === 'setState') {
      if (
        relPath !== RECEIVING_FLAG_OWNER_FILE &&
        firstStringArgument(node) === RECEIVING_FLAG_KEY
      ) {
        facts.rawReceivingFlagWrites += 1;
      }
    } else if ((callee === 'resume' || callee === 'suspend') && node.arguments.length === 0) {
      // AudioContext.resume() and suspend() take no arguments and are always
      // called on a receiver; a bare resume() is a local function.
      const target = unwrap(node.expression);
      if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return;
      const receiver = receiverName(target.expression);
      if (receiver === null || !NON_AUDIO_CONTEXT_RECEIVERS.has(receiver)) {
        facts.audioContextNativeCalls += 1;
      }
    } else if (IFRAME_AUDIO_WRITE_METHODS.has(callee)) {
      // The iframe API is always called on its player; a bare mute() is a
      // local function.
      const target = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        facts.iframeAudioWriteSites.push(
          `${relPath}:${lineOf(file, node)} ${callee}() in ${enclosingFunctionName(node)}`,
        );
      }
    }
  });

  factsCache.set(relPath, { text, facts });
  return facts;
}

// ── CHECK 8: header loader default holder writers ────────────────────────

const LOADER_OWNER_FILE = 'src/ui/toast.ts';
/** Argument position of the holder ID in each header loader call. */
const LOADER_ID_ARGUMENT = new Map([
  ['showLoader', 2],
  ['updateLoader', 1],
]);

/** A file's parameters and variables by name, for following a holder ID held in a name. */
type NameDeclarations = ReadonlyMap<
  string,
  readonly (ts.ParameterDeclaration | ts.VariableDeclaration)[]
>;

function nameDeclarations(file: ts.SourceFile): NameDeclarations {
  const declarations = new Map<string, (ts.ParameterDeclaration | ts.VariableDeclaration)[]>();
  visit(file, (node) => {
    if (!(ts.isParameter(node) || ts.isVariableDeclaration(node)) || !ts.isIdentifier(node.name)) {
      return;
    }
    const list = declarations.get(node.name.text) ?? [];
    list.push(node);
    declarations.set(node.name.text, list);
  });
  return declarations;
}

function declarationMayBeUndefined(
  declaration: ts.ParameterDeclaration | ts.VariableDeclaration,
  declarations: NameDeclarations,
  following: ReadonlySet<string>,
): boolean {
  if (declaration.initializer) {
    return mayBeUndefinedId(declaration.initializer, declarations, following);
  }
  if (ts.isParameter(declaration)) {
    const type = declaration.type;
    return (
      !!declaration.questionToken ||
      (!!type &&
        ts.isUnionTypeNode(type) &&
        type.types.some((member) => member.kind === ts.SyntaxKind.UndefinedKeyword))
    );
  }
  // A for-of or for-in variable takes each element; a `let` with no value
  // starts undefined.
  const statement = declaration.parent.parent;
  return !ts.isForOfStatement(statement) && !ts.isForInStatement(statement);
}

/**
 * RO-47: whether a holder-ID argument can be undefined and so write the
 * `_default` holder: a missing argument, `undefined`, `void`, a conditional
 * or `??` / `||` with such a branch, or a name that one of its declarations in
 * the same file can leave undefined (an optional parameter, a `let` with no
 * value, or any of these as its value). Names match across the whole file,
 * not by scope, so a reused name counts when any of its declarations can be
 * undefined. A name imported from another module is not followed.
 */
function mayBeUndefinedId(
  expression: ts.Expression | undefined,
  declarations: NameDeclarations,
  following: ReadonlySet<string> = new Set(),
): boolean {
  if (!expression) return true;
  const value = unwrap(expression);
  if (ts.isVoidExpression(value)) return true;
  if (ts.isConditionalExpression(value)) {
    return (
      mayBeUndefinedId(value.whenTrue, declarations, following) ||
      mayBeUndefinedId(value.whenFalse, declarations, following)
    );
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return mayBeUndefinedId(value.right, declarations, following);
  }
  if (!ts.isIdentifier(value)) return false;
  if (value.text === 'undefined') return true;
  if (following.has(value.text)) return false;
  const next = new Set(following).add(value.text);
  return (declarations.get(value.text) ?? []).some((declaration) =>
    declarationMayBeUndefined(declaration, declarations, next),
  );
}

/** RO-47: header loader calls whose holder ID can be undefined, per src/ file. */
function collectDefaultLoaderWrites(sources: ReadonlyMap<string, string>): Map<string, number> {
  const measured = new Map<string, number>();
  for (const [relPath, text] of sources) {
    if (!relPath.startsWith('src/') || relPath === LOADER_OWNER_FILE) continue;
    if (!text.includes('showLoader') && !text.includes('updateLoader')) continue;
    const file = parse(relPath, text);
    const declarations = nameDeclarations(file);
    let count = 0;
    visit(file, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = calleeName(node);
      const idIndex = callee === null ? undefined : LOADER_ID_ARGUMENT.get(callee);
      if (idIndex !== undefined && mayBeUndefinedId(node.arguments[idIndex], declarations)) {
        count += 1;
      }
    });
    if (count > 0) measured.set(relPath, count);
  }
  return measured;
}

// ── CHECK 12: cross-file YouTube start-timer reads and clears ────────────

/** Bounds a chain of consts, imports, re-exports and name lists that refer to each other. */
const MAX_TIMER_NAME_HOPS = 16;

/** The timer functions CHECK 12 follows by name: the setter, the query and the clear. */
const TIMER_FUNCTIONS: ReadonlySet<string> = new Set([TIMER_SET_CALL, ...TIMER_USE_CALLS.keys()]);

/** Methods whose result holds only names of the list they are called on (and concat's arguments). */
const NAME_LIST_SUBSET_METHODS = new Set([
  'concat',
  'filter',
  'reverse',
  'slice',
  'sort',
  'toReversed',
  'toSorted',
  'values',
]);

/**
 * The timer names an expression can take, or null when CHECK 12 cannot
 * resolve every one of them. A template or `+` concatenation whose static
 * text cannot spell a start timer resolves to no name: it never names one.
 */
type TimerNames = readonly string[] | null;

/** A timer call: `kind` from its callee; `list` when the function goes to a name list's method. */
interface TimerCall {
  readonly kind: 'set' | 'read' | 'clear';
  readonly callee: string;
  readonly node: ts.Node;
  readonly argument: ts.Expression | undefined;
  readonly list: ts.CallExpression | null;
}

/** Another name for a timer function, under which its calls would not show. */
interface TimerFunctionAlias {
  readonly node: ts.Node;
  readonly what: string;
}

/** What CHECK 12 reads from one file's syntax, cached by its text. */
interface TimerFileSyntax {
  readonly file: ts.SourceFile;
  /**
   * Variable and destructured bindings by name, anywhere in the file. Names
   * match across the file, not by scope, and a name resolves only when every
   * binding of it does.
   */
  readonly bindings: ReadonlyMap<string, readonly (ts.VariableDeclaration | ts.BindingElement)[]>;
  /** Top-level `const` initialisers by name: what another file can import. */
  readonly topLevelConsts: ReadonlyMap<string, readonly ts.Expression[]>;
  /** Named value imports: the local name, the module specifier and the name there. */
  readonly imports: ReadonlyMap<string, { readonly specifier: string; readonly name: string }>;
  /** Namespace imports (`import * as names from`): the local name and the module specifier. */
  readonly namespaces: ReadonlyMap<string, string>;
  /** Names in export lists: the module they come from (null for this file) and the name there. */
  readonly reexports: ReadonlyMap<
    string,
    { readonly specifier: string | null; readonly name: string }
  >;
  /** `export * from` module specifiers. */
  readonly starExports: readonly string[];
  readonly timerCalls: readonly TimerCall[];
  readonly aliases: readonly TimerFunctionAlias[];
}

interface TimerNameScope extends TimerFileSyntax {
  /** The production file one of this file's module specifiers names, or null. */
  readonly moduleOf: (specifier: string) => string | null;
  readonly scopeOf: (relPath: string) => TimerNameScope | null;
}

const TIMER_CALL_KINDS = new Map<string, TimerCall['kind']>([
  [TIMER_SET_CALL, 'set'],
  ...TIMER_USE_CALLS,
]);

const timerSyntaxCache = new Map<
  string,
  { readonly text: string; readonly syntax: TimerFileSyntax }
>();

/** Whether a node sits in a type (`typeof getManagedTimer`, an annotation) rather than a value. */
function inTypePosition(node: ts.Node): boolean {
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isTypeNode(current)) return true;
  }
  return false;
}

/** The outermost parentheses, `as`, `satisfies` or `!` around an expression. */
function outermostWrapper(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    ts.isNonNullExpression(current.parent) ||
    ts.isTypeAssertionExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}

/** Whether a call's callee is a member: `list.some(...)`, `list['forEach'](...)`. */
function isMethodCall(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression);
  return ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee);
}

/**
 * The timer function a value reference names (`getManagedTimer`,
 * `timers.getManagedTimer`, `timers['getManagedTimer']`); null for any other
 * node, for a declaration, key or member name, for the original name in a
 * rename (reported under its new name) and in a type.
 */
function timerFunctionReference(node: ts.Node): string | null {
  let name: string | null = null;
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    const declared = 'name' in parent && parent.name === node;
    const renamed =
      (ts.isBindingElement(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent)) &&
      parent.propertyName === node;
    // `{ getManagedTimer }` is both a key and the function it hands out.
    if (!ts.isShorthandPropertyAssignment(parent) && (declared || renamed)) return null;
    name = node.text;
  } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    name = memberName(node);
  }
  return name !== null && TIMER_FUNCTIONS.has(name) && !inTypePosition(node) ? name : null;
}

function timerFileSyntax(relPath: string, text: string): TimerFileSyntax {
  const cached = timerSyntaxCache.get(relPath);
  if (cached?.text === text) return cached.syntax;
  const file = parse(relPath, text);
  const bindings = new Map<string, (ts.VariableDeclaration | ts.BindingElement)[]>();
  const topLevelConsts = new Map<string, ts.Expression[]>();
  const timerCalls: TimerCall[] = [];
  const aliases: TimerFunctionAlias[] = [];
  visit(file, (node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name)
    ) {
      const name = node.name.text;
      bindings.set(name, [...(bindings.get(name) ?? []), node]);
      const list = node.parent;
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isVariableDeclarationList(list) &&
        (list.flags & ts.NodeFlags.Const) !== 0 &&
        ts.isVariableStatement(list.parent) &&
        ts.isSourceFile(list.parent.parent)
      ) {
        topLevelConsts.set(name, [...(topLevelConsts.get(name) ?? []), node.initializer]);
      }
      if (ts.isBindingElement(node) && node.propertyName) {
        const original = staticPropertyName(node.propertyName);
        if (original !== null && TIMER_FUNCTIONS.has(original) && original !== name) {
          aliases.push({ node, what: `${original} destructured as ${name}` });
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node);
      const kind = callee === null ? undefined : TIMER_CALL_KINDS.get(callee);
      if (callee !== null && kind) {
        timerCalls.push({ kind, callee, node, argument: node.arguments[0], list: null });
      }
    }
    const reference = timerFunctionReference(node);
    if (reference === null) return;
    const outer = outermostWrapper(node);
    const use = outer.parent;
    const kind = TIMER_USE_CALLS.get(reference);
    if (ts.isCallExpression(use) && use.expression === outer) return; // A call, collected above.
    if (
      kind &&
      ts.isCallExpression(use) &&
      use.arguments.some((argument) => argument === outer) &&
      isMethodCall(use)
    ) {
      // A query or clear handed straight to a name list: NAMES.some(getManagedTimer).
      timerCalls.push({ kind, callee: reference, node, argument: undefined, list: use });
    } else {
      aliases.push({ node, what: `${reference} used as a value` });
    }
  });
  const imports = new Map<string, { readonly specifier: string; readonly name: string }>();
  const namespaces = new Map<string, string>();
  const reexports = new Map<string, { readonly specifier: string | null; readonly name: string }>();
  const starExports: string[] = [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      const named = clause?.namedBindings;
      if (!clause || clause.isTypeOnly || !named) continue;
      if (ts.isNamespaceImport(named)) {
        namespaces.set(named.name.text, specifier);
        continue;
      }
      for (const element of named.elements) {
        if (element.isTypeOnly) continue;
        const name = (element.propertyName ?? element.name).text;
        imports.set(element.name.text, { specifier, name });
        if (TIMER_FUNCTIONS.has(name) && name !== element.name.text) {
          aliases.push({ node: element, what: `${name} imported as ${element.name.text}` });
        }
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const specifier =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
      const clause = statement.exportClause;
      if (!clause && specifier !== null) starExports.push(specifier);
      if (!clause || !ts.isNamedExports(clause)) continue;
      for (const element of clause.elements) {
        if (element.isTypeOnly) continue;
        const name = (element.propertyName ?? element.name).text;
        reexports.set(element.name.text, { specifier, name });
        if (TIMER_FUNCTIONS.has(name) && name !== element.name.text) {
          aliases.push({ node: element, what: `${name} exported as ${element.name.text}` });
        }
      }
    }
  }
  aliases.sort((left, right) => left.node.getStart(file) - right.node.getStart(file));
  const syntax: TimerFileSyntax = {
    file,
    bindings,
    topLevelConsts,
    imports,
    namespaces,
    reexports,
    starExports,
    timerCalls,
    aliases,
  };
  timerSyntaxCache.set(relPath, { text, syntax });
  return syntax;
}

/** The production file a relative module specifier names, or null. */
function resolveModule(
  relPath: string,
  specifier: string,
  sources: ReadonlyMap<string, string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), specifier));
  for (const candidate of [base, base.replace(/\.js$/u, '.ts'), `${base}.ts`, `${base}/index.ts`]) {
    if (sources.has(candidate)) return candidate;
  }
  return null;
}

/** One TimerNameScope per production file of this input, built on first use. */
function timerNameScopes(
  sources: ReadonlyMap<string, string>,
): (relPath: string) => TimerNameScope | null {
  const scopes = new Map<string, TimerNameScope>();
  const scopeOf = (relPath: string): TimerNameScope | null => {
    const cached = scopes.get(relPath);
    if (cached) return cached;
    const text = sources.get(relPath);
    if (text === undefined) return null;
    const moduleOf = (specifier: string): string | null =>
      resolveModule(relPath, specifier, sources);
    const scope: TimerNameScope = { ...timerFileSyntax(relPath, text), moduleOf, scopeOf };
    scopes.set(relPath, scope);
    return scope;
  };
  return scopeOf;
}

/** Every name of every part, or null when any part does not resolve. */
function unionOfNames(parts: readonly TimerNames[]): TimerNames {
  const names: string[] = [];
  for (const part of parts) {
    if (part === null) return null;
    names.push(...part);
  }
  return names;
}

/** The parameter of the nearest enclosing function that declares this name. */
function enclosingParameter(identifier: ts.Identifier): ts.ParameterDeclaration | null {
  for (let current = identifier.parent; !ts.isSourceFile(current); current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const parameter = current.parameters.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === identifier.text,
    );
    if (parameter) return parameter;
  }
  return null;
}

/** The names a string literal type or a union of them allows; null for any other type. */
function literalTypeNames(type: ts.TypeNode): TimerNames {
  const names: string[] = [];
  for (const member of ts.isUnionTypeNode(type) ? type.types : [type]) {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) return null;
    names.push(member.literal.text);
  }
  return names;
}

/**
 * Whether a template or `+` concatenation can spell a start timer: its static
 * text, with any text in place of each substitution or other operand.
 */
function canSpellStartTimer(node: ts.Expression): boolean {
  const parts: (string | null)[] = [];
  const collect = (expression: ts.Expression): void => {
    const value = unwrap(expression);
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      parts.push(value.text);
    } else if (ts.isTemplateExpression(value)) {
      parts.push(value.head.text);
      for (const span of value.templateSpans) parts.push(null, span.literal.text);
    } else if (
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      collect(value.left);
      collect(value.right);
    } else {
      parts.push(null);
    }
  };
  collect(node);
  const pattern = new RegExp(
    `^${parts
      .map((part) => (part === null ? '[\\s\\S]*' : part.replace(/[$()*+./?[\\\]^{|}]/gu, '\\$&')))
      .join('')}$`,
    'u',
  );
  return [...START_TIMER_NAMES].some((name) => pattern.test(name));
}

/** `names.X` or `names['X']` through a namespace import: the module and the name, or null. */
function namespaceMember(
  node: ts.Expression,
  scope: TimerNameScope,
): { readonly from: string; readonly name: string } | null {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null;
  const member = memberName(node);
  const receiver = unwrap(node.expression);
  const specifier = ts.isIdentifier(receiver) ? scope.namespaces.get(receiver.text) : undefined;
  const from = specifier === undefined ? null : scope.moduleOf(specifier);
  return member !== null && from !== null ? { from, name: member } : null;
}

/** What one binding holds: a const's value, or each element of the list a for-of const takes. */
function bindingDeclarationValues(
  declaration: ts.VariableDeclaration | ts.BindingElement,
  scope: TimerNameScope,
  hops: number,
  list: boolean,
): TimerNames {
  if (!ts.isVariableDeclaration(declaration)) return null;
  const declarations = declaration.parent;
  if (
    !ts.isVariableDeclarationList(declarations) ||
    (declarations.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  if (ts.isForOfStatement(declarations.parent)) {
    return list ? null : nameListNames(declarations.parent.expression, scope, hops + 1);
  }
  if (!declaration.initializer) return null;
  return list
    ? nameListNames(declaration.initializer, scope, hops + 1)
    : timerNames(declaration.initializer, scope, hops + 1);
}

/** What a name holds: every binding of it in the file, or the export it is imported from. */
function bindingValues(
  name: string,
  scope: TimerNameScope,
  hops: number,
  list: boolean,
): TimerNames {
  const declarations = scope.bindings.get(name);
  if (declarations) {
    return unionOfNames(
      declarations.map((declaration) => bindingDeclarationValues(declaration, scope, hops, list)),
    );
  }
  const imported = scope.imports.get(name);
  const from = imported ? scope.moduleOf(imported.specifier) : null;
  return imported && from !== null
    ? exportValues(from, imported.name, scope, hops + 1, list)
    : null;
}

/** What a module exports under a name: a top-level const, an export list entry or `export *`. */
function exportValues(
  relPath: string,
  name: string,
  scope: TimerNameScope,
  hops: number,
  list: boolean,
): TimerNames {
  const target = scope.scopeOf(relPath);
  if (!target || hops > MAX_TIMER_NAME_HOPS) return null;
  const consts = target.topLevelConsts.get(name);
  if (consts) {
    return unionOfNames(
      consts.map((initializer) =>
        list
          ? nameListNames(initializer, target, hops + 1)
          : timerNames(initializer, target, hops + 1),
      ),
    );
  }
  const source = target.reexports.get(name);
  if (source) {
    if (source.specifier === null) return bindingValues(source.name, target, hops + 1, list);
    const from = target.moduleOf(source.specifier);
    return from === null ? null : exportValues(from, source.name, target, hops + 1, list);
  }
  for (const specifier of target.starExports) {
    const from = target.moduleOf(specifier);
    const values = from === null ? null : exportValues(from, name, target, hops + 1, list);
    if (values !== null) return values;
  }
  return null;
}

/**
 * The names a parameter can take: a callback's first parameter, when the
 * callback goes to a method of a name list, takes the list's names; otherwise
 * a parameter annotated with a string literal or a union of them takes those.
 */
function parameterNames(
  parameter: ts.ParameterDeclaration,
  scope: TimerNameScope,
  hops: number,
): TimerNames {
  const callback = parameter.parent;
  const call = callback.parent;
  if (
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    callback.parameters[0] === parameter &&
    ts.isCallExpression(call) &&
    call.arguments.some((argument) => argument === callback)
  ) {
    const listed = receiverNameList(call, scope, hops);
    if (listed !== null) return listed;
  }
  return parameter.type ? literalTypeNames(parameter.type) : null;
}

/**
 * A name list built from another: `Object.freeze(list)`, `Array.from(list)`
 * and `list.filter(...)`, `.slice(...)`, `.concat(...)` and the other subset
 * methods.
 */
function derivedListNames(
  call: ts.CallExpression,
  scope: TimerNameScope,
  hops: number,
): TimerNames {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return null;
  const method = memberName(callee);
  const receiver = unwrap(callee.expression);
  if (
    ts.isIdentifier(receiver) &&
    ((receiver.text === 'Object' && method === 'freeze') ||
      (receiver.text === 'Array' && method === 'from')) &&
    call.arguments.length === 1
  ) {
    return nameListNames(call.arguments[0], scope, hops + 1);
  }
  if (method === null || !NAME_LIST_SUBSET_METHODS.has(method)) return null;
  const own = nameListNames(callee.expression, scope, hops + 1);
  if (method !== 'concat') return own;
  return unionOfNames([
    own,
    ...call.arguments.map(
      (argument) =>
        nameListNames(argument, scope, hops + 1) ?? timerNames(argument, scope, hops + 1),
    ),
  ]);
}

/**
 * The names in a name list: an array literal (with spreads), a conditional
 * of lists, `new Set(list)`, a list derived from another, and a const (in
 * the file, imported, re-exported or read through a namespace import) holding
 * one; null for anything else.
 */
function nameListNames(
  expression: ts.Expression | undefined,
  scope: TimerNameScope,
  hops: number,
): TimerNames {
  if (!expression || hops > MAX_TIMER_NAME_HOPS) return null;
  const node = unwrap(expression);
  if (ts.isArrayLiteralExpression(node)) {
    return unionOfNames(
      node.elements.map((element) =>
        ts.isSpreadElement(element)
          ? nameListNames(element.expression, scope, hops + 1)
          : timerNames(element, scope, hops + 1),
      ),
    );
  }
  if (ts.isConditionalExpression(node)) {
    return unionOfNames([
      nameListNames(node.whenTrue, scope, hops + 1),
      nameListNames(node.whenFalse, scope, hops + 1),
    ]);
  }
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'Set'
  ) {
    const items = node.arguments?.[0];
    return items ? nameListNames(items, scope, hops + 1) : [];
  }
  if (ts.isCallExpression(node)) return derivedListNames(node, scope, hops);
  if (ts.isIdentifier(node)) {
    return enclosingParameter(node) ? null : bindingValues(node.text, scope, hops, true);
  }
  const member = namespaceMember(node, scope);
  return member ? exportValues(member.from, member.name, scope, hops + 1, true) : null;
}

/** The names of the list whose method `call` invokes: `[...].some(cb)`, `NAMES.forEach(cb)`. */
function receiverNameList(
  call: ts.CallExpression,
  scope: TimerNameScope,
  hops: number,
): TimerNames {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return null;
  return nameListNames(callee.expression, scope, hops + 1);
}

/**
 * The timer names an expression can take, resolved from the syntax tree: a
 * string literal; both sides of a conditional, `??` or `||`; a const (every
 * binding of the name in the file, a for-of const taking its list's names)
 * or a const imported by name, re-exported or read through a namespace
 * import; a parameter (see parameterNames). A template or `+` concatenation
 * whose static text cannot spell a start timer resolves to no name. Null for
 * anything else.
 */
function timerNames(
  expression: ts.Expression | undefined,
  scope: TimerNameScope,
  hops = 0,
): TimerNames {
  if (!expression || hops > MAX_TIMER_NAME_HOPS) return null;
  const node = unwrap(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  // The empty side of `??` or `||`: no name.
  if (
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  ) {
    return [];
  }
  if (
    ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
  ) {
    return canSpellStartTimer(node) ? null : [];
  }
  if (ts.isConditionalExpression(node)) {
    return unionOfNames([
      timerNames(node.whenTrue, scope, hops + 1),
      timerNames(node.whenFalse, scope, hops + 1),
    ]);
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return unionOfNames([
      timerNames(node.left, scope, hops + 1),
      timerNames(node.right, scope, hops + 1),
    ]);
  }
  if (ts.isIdentifier(node)) {
    const parameter = enclosingParameter(node);
    return parameter
      ? parameterNames(parameter, scope, hops)
      : bindingValues(node.text, scope, hops, false);
  }
  const member = namespaceMember(node, scope);
  return member ? exportValues(member.from, member.name, scope, hops + 1, false) : null;
}

interface StartTimerUses {
  readonly reads: ReadonlyMap<string, number>;
  readonly clears: ReadonlyMap<string, number>;
  /** `kind: file:line call('name', ...) in function`, one per counted call. */
  readonly sites: readonly string[];
  /**
   * Findings with no allowance: names CHECK 12 cannot resolve, other names
   * for the timer functions, and start timers set outside their setter files.
   */
  readonly findings: readonly string[];
}

/**
 * RO-02: per file in src/youtube/, getManagedTimer() and clearManagedTimer()
 * calls that can take a start timer the same file does not set. A call
 * counts once however many such names it can take (a name list is one call).
 * Every timer call there must resolve its name, the timer functions keep
 * their names, and each start timer is set by exactly its listed files.
 */
function collectStartTimerUses(sources: ReadonlyMap<string, string>): StartTimerUses {
  const scopeOf = timerNameScopes(sources);
  const reads = new Map<string, number>();
  const clears = new Map<string, number>();
  const sites: string[] = [];
  const findings: string[] = [];
  const setters = new Map<string, Set<string>>();
  for (const [relPath, text] of sources) {
    if (!relPath.startsWith(START_TIMER_SCOPE) || !text.includes('ManagedTimer')) continue;
    const scope = scopeOf(relPath);
    if (!scope) continue;
    for (const alias of scope.aliases) {
      findings.push(
        `TIMER FUNCTION ALIAS (RO-02): ${relPath}:${lineOf(scope.file, alias.node)} ` +
          `${alias.what} in ${enclosingFunctionName(alias.node)} - call getManagedTimer(), ` +
          'clearManagedTimer() and setManagedTimer() by their own names (a query or a clear ' +
          "may go straight to a name list's method), so CHECK 12 sees every call",
      );
    }
    const resolved: { readonly call: TimerCall; readonly names: readonly string[] }[] = [];
    for (const call of scope.timerCalls) {
      const names = call.list
        ? receiverNameList(call.list, scope, 0)
        : timerNames(call.argument, scope);
      if (names !== null) {
        resolved.push({ call, names });
        continue;
      }
      findings.push(
        `UNRESOLVED TIMER NAME (RO-02): ${relPath}:${lineOf(scope.file, call.node)} ` +
          `${call.callee}() in ${enclosingFunctionName(call.node)} - CHECK 12 cannot tell ` +
          'whether this is a start timer: name it with a string literal, a literal const or ' +
          'a parameter annotated with a literal union',
      );
    }
    const setHere = new Set<string>();
    for (const { call, names } of resolved) {
      if (call.kind !== 'set') continue;
      for (const name of names) {
        setHere.add(name);
        if (!START_TIMER_NAMES.has(name)) continue;
        setters.set(name, (setters.get(name) ?? new Set<string>()).add(relPath));
      }
    }
    for (const { call, names } of resolved) {
      if (call.kind === 'set') continue;
      const counted = [...new Set(names)].filter(
        (name) => START_TIMER_NAMES.has(name) && !setHere.has(name),
      );
      if (counted.length === 0) continue;
      const measured = call.kind === 'read' ? reads : clears;
      measured.set(relPath, (measured.get(relPath) ?? 0) + 1);
      sites.push(
        `cross-file start-timer ${call.kind}: ${relPath}:${lineOf(scope.file, call.node)} ` +
          `${call.callee}(${counted.map((name) => `'${name}'`).join(', ')}) in ` +
          enclosingFunctionName(call.node),
      );
    }
  }
  for (const [name, listed] of START_TIMER_SETTERS) {
    const actual = setters.get(name) ?? new Set<string>();
    for (const relPath of [...actual].filter((file) => !listed.includes(file)).sort()) {
      findings.push(
        `START TIMER SET (RO-02): ${relPath} sets '${name}', which only ${listed.join(' and ')} ` +
          'may set - setManagedTimer() clears a running timer of that name, so a second setter ' +
          'is a second machine on the start: start it through its owner, or move the setter ' +
          'and update START_TIMER_SETTERS and the RO-02 record in the same change',
      );
    }
    for (const relPath of listed.filter((file) => !actual.has(file))) {
      findings.push(
        `START TIMER SET (RO-02): '${name}' is not set by ${relPath} any more - update ` +
          'START_TIMER_SETTERS and the RO-02 record in the same change',
      );
    }
  }
  return { reads, clears, sites, findings };
}

// ── Exact comparison ─────────────────────────────────────────────────────

interface ExactCheck {
  readonly label: string;
  readonly record: string;
  readonly hint: string;
  readonly measured: ReadonlyMap<string, number>;
  readonly baseline: Baseline;
}

function compareExact(check: ExactCheck, findings: string[]): void {
  for (const [key, count] of [...check.measured].sort(([a], [b]) => a.localeCompare(b))) {
    if (count === 0) continue;
    const allowance = check.baseline.get(key);
    if (!allowance) {
      findings.push(
        `UNSANCTIONED ${check.label} (${check.record}): ${key} has ${count} - ${check.hint}`,
      );
    } else if (count > allowance.count) {
      findings.push(
        `RATCHET REGRESSION ${check.label} (${check.record}): ${key} has ${count}, ` +
          `baseline ${allowance.count} - ${check.hint}`,
      );
    } else if (count < allowance.count) {
      findings.push(
        `STALE BASELINE ${check.label} (${check.record}): ${key} has ${count}, ` +
          `baseline ${allowance.count} - lower the baseline to ${count} in this change`,
      );
    }
  }
  for (const key of check.baseline.keys()) {
    if ((check.measured.get(key) ?? 0) === 0) {
      findings.push(
        `STALE BASELINE ${check.label} (${check.record}): ${key} has 0 - remove its entry in this change`,
      );
    }
  }
}

function total(measured: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const count of measured.values()) sum += count;
  return sum;
}

function tally(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

// ── CHECK 1: registry parity ─────────────────────────────────────────────

const RECORD_STATUSES = new Set(['duplicated', 'owner-in-place', 'accepted-exception']);

interface RegistryParity {
  readonly ids: ReadonlyMap<string, string>;
}

function checkRegistry(
  registry: string,
  ownerHeaders: ReadonlyMap<string, readonly string[]>,
  findings: string[],
): RegistryParity {
  const ids = new Map<string, string>();
  const problem = (message: string): void => {
    findings.push(`REGISTRY PARITY (${REGISTRY_PATH}): ${message}`);
  };
  if (!registry) {
    problem('the registry file is missing');
    return { ids };
  }

  const blocks = [...registry.matchAll(/^```resource-ownership[ \t]*\r?\n([\s\S]*?)^```/gmu)];
  if (blocks.length !== 1) problem(`expected one resource-ownership block, found ${blocks.length}`);
  let previousNumber = 0;
  for (const rawLine of (blocks[0]?.[1] ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(RO-(\d{2,}))[ \t]+([a-z-]+)$/u.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) {
      problem(`malformed block line "${line}" (expected "RO-NN status")`);
      continue;
    }
    const [, id, digits, status] = match;
    if (!RECORD_STATUSES.has(status)) problem(`${id} has unknown status "${status}"`);
    if (ids.has(id)) problem(`${id} appears twice in the block`);
    const number = Number(digits);
    if (number <= previousNumber) problem(`${id} is out of ascending ID order in the block`);
    previousNumber = Math.max(previousNumber, number);
    ids.set(id, status);
  }

  const headings = [...registry.matchAll(/^### (RO-\d+)\b.*$/gmu)].map((match) => ({
    id: match[1] ?? '',
    index: match.index,
  }));
  const headingIds = headings.map((heading) => heading.id);
  if (headingIds.join(' ') !== [...ids.keys()].join(' ')) {
    const missing = [...ids.keys()].filter((id) => !headingIds.includes(id));
    const extra = headingIds.filter((id) => !ids.has(id));
    problem(
      'block IDs differ from the "### RO-NN" record headings ' +
        `(block only: ${missing.join(', ') || 'none'}; headings only: ${extra.join(', ') || 'none'}; ` +
        'or the order differs)',
    );
  }
  for (const [position, heading] of headings.entries()) {
    // Only the record's own section: up to the next record heading or `##` heading.
    const end = headings[position + 1]?.index ?? registry.length;
    const sectionEnd = registry.indexOf('\n## ', heading.index);
    const body = registry.slice(heading.index, sectionEnd === -1 ? end : Math.min(end, sectionEnd));
    const firstWord = /^- \*\*Status:\*\*[ \t]*(\S+)/mu.exec(body)?.[1];
    // First word with backticks and surrounding punctuation stripped: "`duplicated`." -> duplicated.
    const status = firstWord?.replace(/`/gu, '').replace(/^\p{P}+|\p{P}+$/gu, '');
    if (!status) problem(`${heading.id} has no "- **Status:**" field in its record`);
    else if (!RECORD_STATUSES.has(status)) {
      problem(`${heading.id} Status field starts with unknown status "${status}"`);
    } else if (ids.has(heading.id) && ids.get(heading.id) !== status) {
      problem(
        `${heading.id} Status field says "${status}" but the block says "${ids.get(heading.id)}"`,
      );
    }
  }

  const indexRows = new Map<string, string>();
  const tableCells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\||\|$/gu, '')
      .split('|')
      .map((cell) => cell.trim());
  const indexHeader = registry
    .split(/\r?\n/u)
    .map(tableCells)
    .find((cells) => cells[0] === 'ID' && cells.includes('Status'));
  const statusColumn = indexHeader?.indexOf('Status') ?? -1;
  if (statusColumn === -1) problem('the index table has no "ID ... Status" header');
  for (const line of registry.split(/\r?\n/u)) {
    if (!/^\| RO-\d+ /u.test(line)) continue;
    const cells = tableCells(line);
    const [id] = cells;
    const status = cells[statusColumn];
    if (id && status !== undefined) indexRows.set(id, status);
  }
  for (const [id, status] of ids) {
    const indexStatus = indexRows.get(id);
    if (indexStatus === undefined) problem(`${id} is missing from the index table`);
    else if (indexStatus !== status) {
      problem(`${id} index status "${indexStatus}" differs from the block status "${status}"`);
    }
  }
  for (const id of indexRows.keys()) {
    if (!ids.has(id)) problem(`index row ${id} has no block line`);
  }

  for (const id of new Set(GUARD_RECORD_IDS)) {
    if (!ids.has(id)) problem(`this guard names ${id}, which has no block line`);
  }

  const claims = new Map<string, string[]>();
  for (const [relPath, headerIds] of ownerHeaders) {
    for (const id of headerIds) {
      const status = ids.get(id);
      if (status === undefined) {
        problem(`${relPath} has "Resource owner: ${id}", which is not a record`);
      } else if (status === 'accepted-exception') {
        problem(`${relPath} claims exception record ${id}; name its parent record instead`);
      }
      claims.set(id, [...(claims.get(id) ?? []), relPath]);
    }
  }
  for (const [id, files] of claims) {
    if (files.length > 1)
      problem(`${id} is claimed by more than one owner file: ${files.join(', ')}`);
  }
  return { ids };
}

// ── CHECK 4: one deadline owner per PRO SFU attempt ──────────────────────

function findConstant(
  sources: ReadonlyMap<string, string>,
  relPath: string,
  name: string,
): number | null {
  const text = sources.get(relPath);
  if (text === undefined) return null;
  const constant = topLevelConstants(parse(relPath, text)).find((entry) => entry.name === name);
  return typeof constant?.value === 'number' ? constant.value : null;
}

/**
 * True when `call` sits in a branch that leaves the function before `target`:
 * a block between them that does not contain `target` ends in return or throw.
 */
function exitsBefore(call: ts.Node, target: ts.Node, scope: ts.Node): boolean {
  for (let current = call.parent; current !== scope; current = current.parent) {
    if (!ts.isBlock(current)) continue;
    if (current.pos <= target.pos && target.end <= current.end) continue;
    const last = current.statements.at(-1);
    if (last && (ts.isReturnStatement(last) || ts.isThrowStatement(last))) return true;
  }
  return false;
}

/** True when the start's options are the literal `{ deadline: 'route' }`. */
function disablesWatchdog(call: ts.CallExpression): boolean {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(unwrap(options))) return false;
  return (unwrap(options) as ts.ObjectLiteralExpression).properties.some((property) => {
    if (!ts.isPropertyAssignment(property) || propertyNameText(property.name) !== 'deadline') {
      return false;
    }
    const value = unwrap(property.initializer);
    return ts.isStringLiteralLike(value) && value.text === 'route';
  });
}

interface DeadlineOwnership {
  readonly retryMaxMs: number | null;
  readonly watchdogMs: number | null;
  readonly sfuReceptionStarts: number;
  readonly mode: 'retry-below-watchdog' | 'watchdog-off' | 'violated';
}

function checkDeadlineOwnership(
  sources: ReadonlyMap<string, string>,
  findings: string[],
): DeadlineOwnership {
  const anchor = (message: string): void => {
    findings.push(
      `DEADLINE OWNER (RO-04, G1): ${message} - move this check's anchors in the same change`,
    );
  };
  const retryMaxMs = findConstant(sources, G1_SERVICE_FILE, G1_RETRY_MAX_CONSTANT);
  const watchdogMs = findConstant(sources, G1_WATCHDOG_FILE, G1_WATCHDOG_CONSTANT);
  if (retryMaxMs === null) anchor(`${G1_SERVICE_FILE} has no numeric ${G1_RETRY_MAX_CONSTANT}`);
  if (watchdogMs === null) anchor(`${G1_WATCHDOG_FILE} has no numeric ${G1_WATCHDOG_CONSTANT}`);
  if (retryMaxMs === null || watchdogMs === null) {
    return { retryMaxMs, watchdogMs, sfuReceptionStarts: 0, mode: 'violated' };
  }

  const text = sources.get(G1_SERVICE_FILE) ?? '';
  const file = parse(G1_SERVICE_FILE, text);
  const subscribeCalls: ts.CallExpression[] = [];
  visit(file, (node) => {
    if (ts.isCallExpression(node) && calleeName(node) === G1_SUBSCRIBE_CALL)
      subscribeCalls.push(node);
  });
  const starts: ts.CallExpression[] = [];
  const scopes = new Set<ts.Node>();
  for (const subscribe of subscribeCalls) {
    let scope: ts.Node = subscribe.parent;
    while (!ts.isSourceFile(scope) && !ts.isFunctionLike(scope)) scope = scope.parent;
    if (scopes.has(scope)) continue;
    scopes.add(scope);
    visit(scope, (node) => {
      if (
        ts.isCallExpression(node) &&
        calleeName(node) === G1_RECEPTION_START_CALL &&
        node.getStart(file) < subscribe.getStart(file) &&
        !exitsBefore(node, subscribe, scope)
      ) {
        starts.push(node);
      }
    });
  }
  if (retryMaxMs < watchdogMs) {
    return {
      retryMaxMs,
      watchdogMs,
      sfuReceptionStarts: starts.length,
      mode: 'retry-below-watchdog',
    };
  }
  if (subscribeCalls.length === 0) {
    anchor(`${G1_SERVICE_FILE} no longer calls ${G1_SUBSCRIBE_CALL}()`);
    return { retryMaxMs, watchdogMs, sfuReceptionStarts: 0, mode: 'violated' };
  }
  if (starts.length === 0) {
    anchor(
      `no ${G1_RECEPTION_START_CALL}() call reaches ${G1_SUBSCRIBE_CALL}() in ${G1_SERVICE_FILE}`,
    );
    return { retryMaxMs, watchdogMs, sfuReceptionStarts: 0, mode: 'violated' };
  }
  let violated = false;
  for (const start of starts) {
    if (disablesWatchdog(start)) continue;
    violated = true;
    findings.push(
      `DEADLINE OWNER (RO-04, G1): ${G1_SERVICE_FILE}:${lineOf(file, start)} starts PRO SFU ` +
        `reception with the guest receive watchdog armed (${G1_WATCHDOG_CONSTANT} = ${watchdogMs} ms) ` +
        `while the subscriber retry backs off up to ${G1_RETRY_MAX_CONSTANT} = ${retryMaxMs} ms. ` +
        "One attempt needs one deadline owner: pass { deadline: 'route' } or keep the " +
        'retry maximum below the watchdog (registry principle 2)',
    );
  }
  return {
    retryMaxMs,
    watchdogMs,
    sfuReceptionStarts: starts.length,
    mode: violated ? 'violated' : 'watchdog-off',
  };
}

// ── CHECK 5: copied timing constants ─────────────────────────────────────

const TIMING_NAME_RE = /_(?:MS|S|DELAY|DELAYS|TIMEOUT)$/u;
const OBJECT_COPY_MIN_SHARED_VALUES = 5;

interface ContractConstant {
  readonly file: string;
  readonly name: string;
  readonly value: ConstantValue;
}

function sharedObjectValues(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): number {
  const remaining = [...right.values()].filter((value) => value !== 0 && value !== 1);
  let shared = 0;
  for (const value of left.values()) {
    if (value === 0 || value === 1) continue;
    const index = remaining.indexOf(value);
    if (index === -1) continue;
    remaining.splice(index, 1);
    shared += 1;
  }
  return shared;
}

interface TimingPairs {
  /** Same-named scalars, identical tuples of three or more, shared timing objects. */
  readonly enforced: readonly string[];
  /** Differently named scalars that share a value (report-only). */
  readonly reportOnly: readonly string[];
}

function isTimingCandidate(constant: TopLevelConstant): boolean {
  if (constant.value instanceof Map) return constant.value.size >= OBJECT_COPY_MIN_SHARED_VALUES;
  return TIMING_NAME_RE.test(constant.name);
}

/** The pair's fingerprint detail, or null when the two constants are not copies. */
function pairDetail(left: ContractConstant, right: ContractConstant): string | null {
  if (left.value instanceof Map || right.value instanceof Map) {
    if (!(left.value instanceof Map && right.value instanceof Map)) return null;
    const shared = sharedObjectValues(left.value, right.value);
    return shared >= OBJECT_COPY_MIN_SHARED_VALUES ? `${shared} shared values` : null;
  }
  const leftValue = formatValue(left.value);
  const rightValue = formatValue(right.value);
  if (left.name === right.name) {
    return leftValue === rightValue ? leftValue : `${leftValue} / ${rightValue}`;
  }
  return leftValue === rightValue ? leftValue : null;
}

function collectTimingPairs(sources: ReadonlyMap<string, string>): TimingPairs {
  const enforced = new Set<string>();
  const reportOnly = new Set<string>();
  for (const contract of TIMING_CONTRACTS) {
    const constants: ContractConstant[] = [];
    for (const relPath of contract.files) {
      const text = sources.get(relPath);
      if (text === undefined) continue;
      for (const constant of topLevelConstants(parse(relPath, text))) {
        if (isTimingCandidate(constant)) constants.push({ file: relPath, ...constant });
      }
    }
    const label = contract.records.join('/');
    for (const [index, left] of constants.entries()) {
      for (const right of constants.slice(index + 1)) {
        if (left.file === right.file) continue;
        const detail = pairDetail(left, right);
        if (detail === null) continue;
        const [first, second] = [left, right].sort((a, b) =>
          `${a.name}@${a.file}`.localeCompare(`${b.name}@${b.file}`),
        );
        if (!first || !second) continue;
        const pair = `${label} ${first.name}@${first.file} = ${second.name}@${second.file} (${detail})`;
        const tuple = Array.isArray(left.value) && left.value.length >= 3;
        const enforce = left.value instanceof Map || tuple || left.name === right.name;
        (enforce ? enforced : reportOnly).add(pair);
      }
    }
  }
  return { enforced: [...enforced].sort(), reportOnly: [...reportOnly].sort() };
}

function checkTimingPairs(sources: ReadonlyMap<string, string>, findings: string[]): TimingPairs {
  for (const contract of TIMING_CONTRACTS) {
    for (const relPath of contract.files) {
      if (!sources.has(relPath)) {
        findings.push(
          `TIMING CONTRACT (${contract.records.join('/')}): ${relPath} no longer exists - ` +
            'update the contract file list in the same change',
        );
      }
    }
  }
  const pairs = collectTimingPairs(sources);
  for (const pair of pairs.enforced) {
    if (!TIMING_PAIR_BASELINE.has(pair)) {
      findings.push(
        `COPIED TIMING CONSTANT (principle 4): ${pair} - import it from the timing home the ` +
          'registry names, or add a triaged entry with its reason in the same change',
      );
    }
  }
  for (const pair of TIMING_PAIR_BASELINE.keys()) {
    if (!pairs.enforced.includes(pair)) {
      findings.push(
        `STALE BASELINE copied timing constant: ${pair} is gone - remove its entry in this change`,
      );
    }
  }
  return pairs;
}

// ── Analysis ─────────────────────────────────────────────────────────────

export interface ResourceOwnershipReport {
  readonly findings: readonly string[];
  readonly productionFiles: number;
  readonly registryIds: number;
  readonly sinks: Readonly<Record<string, number>>;
  readonly ariaHiddenWritesTotal: number;
  readonly workerSites: Readonly<Record<string, number>>;
  readonly deadline: DeadlineOwnership;
  readonly armedReceptionStarts: number;
  readonly authorityFenceWrites: number;
  readonly timingPairs: {
    readonly copies: number;
    readonly suspects: number;
    readonly reportOnly: readonly string[];
  };
  readonly audioContextNativeCalls: number;
  readonly defaultLoaderWrites: number;
  readonly receiveSlotWrites: Readonly<Record<string, number>>;
  readonly mediaTuningSites: number;
  /** CHECK 11: every counted write, `file:line method() in function`. */
  readonly iframeAudioWriteSites: readonly string[];
  /** CHECK 12 totals over src/youtube/. */
  readonly startTimerUses: { readonly reads: number; readonly clears: number };
  /** CHECK 12: every counted call, `kind: file:line call('name', ...) in function`. */
  readonly startTimerSites: readonly string[];
}

function perFile(
  facts: ReadonlyMap<string, FileFacts>,
  pick: (facts: FileFacts) => number,
  include: (relPath: string) => boolean = () => true,
): Map<string, number> {
  const measured = new Map<string, number>();
  for (const [relPath, fileFacts] of facts) {
    const count = pick(fileFacts);
    if (count > 0 && include(relPath)) measured.set(relPath, count);
  }
  return measured;
}

export function analyzeResourceOwnership(input: ResourceOwnershipInput): ResourceOwnershipReport {
  const findings: string[] = [];
  const facts = new Map<string, FileFacts>();
  for (const [relPath, text] of input.sources) facts.set(relPath, collectFacts(relPath, text));

  const ownerHeaders = new Map<string, readonly string[]>();
  for (const [relPath, fileFacts] of facts) {
    if (fileFacts.ownerHeaders.length > 0) ownerHeaders.set(relPath, fileFacts.ownerHeaders);
  }
  const registry = checkRegistry(input.registry, ownerHeaders, findings);

  const appOnly = (relPath: string): boolean => relPath.startsWith('src/');
  const workerOnly = (relPath: string): boolean => relPath.startsWith('cloudflare/');
  const pageLockFiles = new Set<string>(['src/core/inert-ownership.ts']);
  for (const [relPath, fileFacts] of facts) {
    if (fileFacts.pageLockClaims > 0 || fileFacts.bodyChildrenWalks > 0) pageLockFiles.add(relPath);
  }
  const pageStateChecks: readonly ExactCheck[] = [
    {
      label: 'inert write',
      record: 'RO-24',
      hint: 'lock page surfaces through setElementInertForOwner (src/core/inert-ownership.ts)',
      measured: perFile(facts, (f) => f.inertWrites, appOnly),
      baseline: INERT_WRITE_BASELINE,
    },
    {
      label: 'page-lock claim',
      record: 'RO-24',
      hint: 'a new surface that covers the page needs its own owner key and a reasoned entry',
      measured: perFile(facts, (f) => f.pageLockClaims, appOnly),
      baseline: PAGE_LOCK_CLAIM_BASELINE,
    },
    {
      label: 'body-children walk',
      record: 'RO-24',
      hint: 'the page lock over body children belongs to the session reset and the modal stack',
      measured: perFile(facts, (f) => f.bodyChildrenWalks, appOnly),
      baseline: BODY_CHILDREN_WALK_BASELINE,
    },
    {
      label: 'page-lock aria-hidden write',
      record: 'RO-24',
      hint: 'aria-hidden on locked surfaces is held by setElementInertForOwner',
      measured: perFile(
        facts,
        (f) => f.ariaHiddenWrites,
        (relPath) => pageLockFiles.has(relPath),
      ),
      baseline: PAGE_LOCK_ARIA_HIDDEN_BASELINE,
    },
    {
      label: 'fullscreen request',
      record: 'RO-26',
      hint: 'a new fullscreen surface needs a reasoned entry; read state through src/core/fullscreen.ts',
      measured: perFile(facts, (f) => f.fullscreenRequestSinks, appOnly),
      baseline: FULLSCREEN_REQUEST_SINK_BASELINE,
    },
    {
      label: 'fullscreen exit',
      record: 'RO-26',
      hint: 'leave fullscreen through exitFullscreenFor in src/core/fullscreen.ts',
      measured: perFile(facts, (f) => f.fullscreenExitSinks, appOnly),
      baseline: FULLSCREEN_EXIT_SINK_BASELINE,
    },
    {
      label: 'history entry write',
      record: 'RO-30',
      hint: 'Back guard entries belong to src/core/back-button-guard.ts and back-button-history.ts',
      measured: perFile(facts, (f) => f.historyWrites, appOnly),
      baseline: HISTORY_WRITE_BASELINE,
    },
    {
      label: 'page navigation',
      record: 'RO-23',
      hint: 'request navigation through scheduleSessionReset (src/core/session-reset.ts)',
      measured: perFile(facts, (f) => f.locationNavigations, appOnly),
      baseline: LOCATION_NAVIGATION_BASELINE,
    },
    {
      label: 'SKIP_WAITING send',
      record: 'RO-22',
      hint: 'waiting-worker activation belongs to the update machine in src/sw-register.ts',
      measured: perFile(facts, (f) => f.skipWaitingSends, appOnly),
      baseline: SKIP_WAITING_BASELINE,
    },
  ];
  for (const check of pageStateChecks) compareExact(check, findings);

  const broadcastSites = tally([...facts.values()].flatMap((f) => f.broadcastEndpointSites));
  const durationSites = tally(
    [...facts.entries()]
      .filter(([relPath]) => workerOnly(relPath))
      .flatMap(([, f]) => f.durationReadSites),
  );
  compareExact(
    {
      label: 'signaling broadcast endpoint',
      record: 'RO-07',
      hint: `only the PRO room outbox builds ${BROADCAST_ENDPOINT} requests`,
      measured: broadcastSites,
      baseline: BROADCAST_ENDPOINT_BASELINE,
    },
    findings,
  );
  compareExact(
    {
      label: 'PRO duration read',
      record: 'RO-08',
      hint: 'R2 duration reads belong to the registration and playback probes',
      measured: durationSites,
      baseline: DURATION_READ_BASELINE,
    },
    findings,
  );

  const deadline = checkDeadlineOwnership(input.sources, findings);
  const armedStarts = tally(
    [...facts.entries()]
      .filter(([relPath]) => appOnly(relPath))
      .flatMap(([, f]) => f.armedReceptionStartSites),
  );
  compareExact(
    {
      label: 'armed reception start',
      record: 'RO-04',
      hint:
        `a ${G1_RECEPTION_START_CALL}() that runs before the PRO SFU start keeps the guest ` +
        "watchdog armed through the retry backoff (G1); pass { deadline: 'route' } or " +
        'add a reasoned entry naming the deadline owner',
      measured: armedStarts,
      baseline: ARMED_RECEPTION_START_BASELINE,
    },
    findings,
  );
  const pairs = checkTimingPairs(input.sources, findings);

  const authorityFenceWrites = tally(
    [...facts.values()].flatMap((f) => f.authorityFenceWriteSites),
  );
  compareExact(
    {
      label: 'authority fence write',
      record: 'RO-25',
      hint:
        'write the Developer API authority fence through revokeDeveloperApiKeysForAuthorityChange ' +
        '(a typed AuthorityFenceWrite) or clearDeveloperApiAuthorityFence in cloudflare/app-worker.ts',
      measured: authorityFenceWrites,
      baseline: AUTHORITY_FENCE_WRITE_BASELINE,
    },
    findings,
  );

  const audioContextCalls = perFile(facts, (f) => f.audioContextNativeCalls, appOnly);
  compareExact(
    {
      label: 'AudioContext native resume/suspend',
      record: 'RO-44',
      hint: 'ask the AudioContext owner (target src/audio/context-recovery.ts) instead',
      measured: audioContextCalls,
      baseline: AUDIO_CONTEXT_NATIVE_CALL_BASELINE,
    },
    findings,
  );

  const defaultLoaderWrites = collectDefaultLoaderWrites(input.sources);
  compareExact(
    {
      label: 'header loader default holder write',
      record: 'RO-47',
      hint:
        'the `_default` holder belongs to the foreground media load; a flow that can overlap ' +
        'it shows its own holder with showLoader(show, text, id)',
      measured: defaultLoaderWrites,
      baseline: DEFAULT_LOADER_WRITE_BASELINE,
    },
    findings,
  );

  const receiveSlotChecks: readonly ExactCheck[] = [
    {
      label: 'receiving flag write',
      record: 'RO-04',
      hint:
        'the receiving flag belongs to the system-audio receive slot; a new route attaches ' +
        'through it, or adds a reasoned entry with the record update',
      measured: perFile(facts, (f) => f.receivingFlagWrites, appOnly),
      baseline: RECEIVING_FLAG_WRITE_BASELINE,
    },
    {
      label: 'system-audio owner claim',
      record: 'RO-04',
      hint:
        "claimPlaybackOwner('system-audio') belongs to the receive slot and the sharer's " +
        'capture; a computed owner or a passed-on claim counts as one',
      measured: perFile(facts, (f) => f.systemAudioOwnerClaims, appOnly),
      baseline: SYSTEM_AUDIO_OWNER_CLAIM_BASELINE,
    },
    {
      label: 'widener.input use',
      record: 'RO-04',
      hint:
        'a received source connects to the stereo widener through the receive slot; the file ' +
        'playback route belongs to src/audio/engine.ts',
      measured: perFile(facts, (f) => f.widenerInputUses, appOnly),
      baseline: WIDENER_INPUT_USE_BASELINE,
    },
    {
      label: 'raw receiving flag write',
      record: 'RO-04',
      hint: `write ${RECEIVING_FLAG_KEY} through ${RECEIVING_FLAG_SETTER} (${RECEIVING_FLAG_OWNER_FILE})`,
      measured: perFile(facts, (f) => f.rawReceivingFlagWrites, appOnly),
      baseline: RAW_RECEIVING_FLAG_WRITE_BASELINE,
    },
  ];
  for (const check of receiveSlotChecks) compareExact(check, findings);

  const mediaTuningSites = perFile(
    facts,
    (f) => f.mediaTuningSites,
    (relPath) => MEDIA_TUNING_SCOPE_RE.test(relPath),
  );
  compareExact(
    {
      label: 'system-audio media tuning',
      record: 'RO-04',
      hint:
        'set the playout-delay hint and the sender bitrate, and name the Realtime STUN ' +
        `server, through ${MEDIA_TUNING_HOME}`,
      measured: mediaTuningSites,
      baseline: MEDIA_TUNING_BASELINE,
    },
    findings,
  );

  const iframeAudioWrites = perFile(facts, (f) => f.iframeAudioWriteSites.length, appOnly);
  compareExact(
    {
      label: 'iframe audio write',
      record: 'RO-12',
      hint:
        "request audio through youtube:set-volume or the start machines' desired-audio " +
        'updates; a new writer needs a reasoned entry and the RO-12 record update',
      measured: iframeAudioWrites,
      baseline: IFRAME_AUDIO_WRITE_BASELINE,
    },
    findings,
  );

  const startTimers = collectStartTimerUses(input.sources);
  compareExact(
    {
      label: 'cross-file start-timer read',
      record: 'RO-02',
      hint: "ask the timer's owner (the file that sets it) through an owner query instead",
      measured: startTimers.reads,
      baseline: START_TIMER_READ_BASELINE,
    },
    findings,
  );
  compareExact(
    {
      label: 'cross-file start-timer clear',
      record: 'RO-02',
      hint: "retire the start through the timer's owner (the file that sets it) instead",
      measured: startTimers.clears,
      baseline: START_TIMER_CLEAR_BASELINE,
    },
    findings,
  );
  findings.push(...startTimers.findings);

  const sinks: Record<string, number> = {};
  for (const check of pageStateChecks) sinks[check.label] = total(check.measured);
  const receiveSlotWrites: Record<string, number> = {};
  for (const check of receiveSlotChecks) receiveSlotWrites[check.label] = total(check.measured);
  let ariaHiddenWritesTotal = 0;
  for (const [relPath, fileFacts] of facts) {
    if (appOnly(relPath)) ariaHiddenWritesTotal += fileFacts.ariaHiddenWrites;
  }
  const triaged = (kind: PairAllowance['kind']): number =>
    pairs.enforced.filter((pair) => TIMING_PAIR_BASELINE.get(pair)?.kind === kind).length;
  return {
    findings,
    productionFiles: input.sources.size,
    registryIds: registry.ids.size,
    sinks,
    ariaHiddenWritesTotal,
    workerSites: {
      'signaling broadcast endpoint': total(broadcastSites),
      'PRO duration read': total(durationSites),
    },
    deadline,
    armedReceptionStarts: total(armedStarts),
    authorityFenceWrites: total(authorityFenceWrites),
    timingPairs: {
      copies: triaged('copy'),
      suspects: triaged('suspect'),
      reportOnly: pairs.reportOnly,
    },
    audioContextNativeCalls: total(audioContextCalls),
    defaultLoaderWrites: total(defaultLoaderWrites),
    receiveSlotWrites,
    mediaTuningSites: total(mediaTuningSites),
    iframeAudioWriteSites: [...facts.entries()]
      .filter(([relPath]) => appOnly(relPath))
      .flatMap(([, f]) => f.iframeAudioWriteSites),
    startTimerUses: { reads: total(startTimers.reads), clears: total(startTimers.clears) },
    startTimerSites: startTimers.sites,
  };
}

export function assertResourceOwnership(input: ResourceOwnershipInput): ResourceOwnershipReport {
  const report = analyzeResourceOwnership(input);
  if (report.findings.length > 0) {
    throw new Error(
      `Resource-ownership check failed:\n${report.findings
        .map((finding) => `  - ${finding}`)
        .join('\n')}\n` +
        `See ${REGISTRY_PATH}. Lower a baseline in the change that removes the debt; ` +
        'raise one only in the same pull request as the code that needs it, with the reason.',
    );
  }
  return report;
}

function main(argv: readonly string[]): void {
  const rootArgument = argv.find((argument) => argument.startsWith('--root='));
  const root = rootArgument ? path.resolve(rootArgument.slice('--root='.length)) : repoRoot;
  const report = assertResourceOwnership(loadResourceOwnershipInput(root));
  const summary = (counts: Readonly<Record<string, number>>): string =>
    Object.entries(counts)
      .map(([label, count]) => `${label} ${count}`)
      .join(', ');
  const { deadline, timingPairs } = report;
  console.log(
    `[resource-ownership] OK: ${report.registryIds} registry records, ` +
      `${report.productionFiles} production files.\n` +
      `  page state: ${summary(report.sinks)}; aria-hidden writes in all of src/ ` +
      `${report.ariaHiddenWritesTotal} (report-only).\n` +
      `  Worker callers: ${summary(report.workerSites)}.\n` +
      `  G1 deadline owner: ${deadline.mode} (retry max ${deadline.retryMaxMs} ms, watchdog ` +
      `${deadline.watchdogMs} ms, ${deadline.sfuReceptionStarts} SFU reception start); ` +
      `armed reception starts ${report.armedReceptionStarts}.\n` +
      `  copied timing constants: ${timingPairs.copies} copies, ${timingPairs.suspects} suspects; ` +
      `${timingPairs.reportOnly.length} same-value pairs (report-only` +
      `${argv.includes('--report') ? '' : ', list with --report'}).\n` +
      `  AudioContext native resume/suspend: ${report.audioContextNativeCalls}.\n` +
      `  Developer API authority fence writes: ${report.authorityFenceWrites}.\n` +
      `  Header loader default holder writes: ${report.defaultLoaderWrites}.\n` +
      `  system-audio receive slot writes: ${summary(report.receiveSlotWrites)}.\n` +
      `  system-audio media tuning sites: ${report.mediaTuningSites}, all in ${MEDIA_TUNING_HOME}.\n` +
      `  YouTube iframe audio writes: ${report.iframeAudioWriteSites.length}; cross-file ` +
      `start-timer reads ${report.startTimerUses.reads}, clears ${report.startTimerUses.clears} ` +
      `(sites${argv.includes('--report') ? ' below' : ' with --report'}).`,
  );
  if (argv.includes('--report')) {
    for (const pair of timingPairs.reportOnly) console.log(`    report-only: ${pair}`);
    for (const site of report.iframeAudioWriteSites) console.log(`    iframe audio write: ${site}`);
    for (const site of report.startTimerSites) console.log(`    ${site}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
