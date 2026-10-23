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
 *     watchdog, or the PRO SFU reception start in the subscribing function
 *     passes `{ receiveWatchdog: false }`. A start is a no-op while the receive
 *     placeholder is active, so an armed start elsewhere (the retry path, a
 *     new module) would also re-arm the watchdog: armed
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
 * endpoint, the duration reader in cloudflare/ and the authority fence
 * writers). Deliberately not checked yet (registry RO-44, RO-45 and
 * "Resource-ownership guard"): callers of the other
 * records' lifecycle operations (YouTube player commands, claimPlaybackOwner,
 * setSystemAudioReceiving, scheduleSessionReset), receivers resolved by type,
 * module-level lifecycle slots, timer-name manifests, shared phase unions,
 * duplicated helper names, "mirrors" copy markers, and registered timings
 * retyped as literals in requester files (the 15 s data-connection grace in
 * heartbeat-monitor.ts).
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
  ['src/app.ts', { count: 1, reason: 'Back guard navigateHome port' }],
  ['src/core/navigation.ts', { count: 1, reason: 'navigateToAppHome helper' }],
  ['src/core/session-reset.ts', { count: 1, reason: 'the navigation owner reload' }],
  ['src/i18n/localized-app-document.ts', { count: 1, reason: 'language switch fallback' }],
  ['src/pro-room/runtime.ts', { count: 1, reason: 'inside a scheduleSessionReset action' }],
  ['src/sw-register.ts', { count: 1, reason: 'inside a scheduleSessionReset action' }],
  ['src/ui/account.ts', { count: 1, reason: 'login popup window, not this document' }],
  ['src/ui/setup-guest.ts', { count: 3, reason: 'inside scheduleSessionReset actions' }],
  ['src/ui/setup.ts', { count: 2, reason: 'inside scheduleSessionReset actions' }],
]);

/** RO-22: 'SKIP_WAITING' messages to a waiting service worker. */
const SKIP_WAITING_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'src/core/sw-hard-reset.ts',
    { count: 1, reason: 'hard-reset promotion (Phase 3 makes it ask)' },
  ],
  ['src/sw-register.ts', { count: 4, reason: 'the update machine' }],
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
const G1_GUEST_FILE = 'src/network/system-audio-guest.ts';
const G1_RETRY_MAX_CONSTANT = 'SUBSCRIBER_RETRY_MAX_DELAY_MS';
const G1_WATCHDOG_CONSTANT = 'SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS';
const G1_SUBSCRIBE_CALL = 'subscribeProSystemAudioSfu';
const G1_RECEPTION_START_CALL = 'beginTrustedSystemAudioReception';

/**
 * RO-04: armed reception starts, exact per `file :: function`. Any value use
 * of beginTrustedSystemAudioReception counts unless it is a direct call whose
 * options are the literal `{ receiveWatchdog: false }`, so passing the start
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
      reason: 'host SYSTEM_AUDIO_START frame (Standard P2P): the watchdog is its deadline',
    },
  ],
  [
    'src/network/system-audio-sfu.ts :: handleSfuReady',
    { count: 1, reason: 'Standard SFU after a direct-route failure handoff' },
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
      'src/network/system-audio-guest.ts',
      'src/network/system-audio-sfu.ts',
      'src/network/pro-system-audio-sfu.ts',
      'src/network/pro-system-audio-direct.ts',
      'src/pro-room/system-audio-service.ts',
    ],
  },
  {
    records: ['RO-05'],
    files: ['src/player/local-output-rejoin.ts', 'src/player/background-return-sync.ts'],
  },
  { records: ['RO-06'], files: ['src/player/file-play-timing.ts', 'src/demo/playback-timing.ts'] },
  {
    records: ['RO-15', 'RO-17'],
    files: [
      'src/network/transport/cloudflare-signaling.ts',
      'src/network/transport/control-isolation.ts',
      'src/network/heartbeat-monitor.ts',
    ],
  },
  { records: ['RO-18'], files: ['src/storage/transfer-send.ts', 'src/storage/preload.ts'] },
  {
    records: ['RO-21'],
    files: ['src/pro-room/runtime.ts', 'src/pro-room/system-audio-service.ts'],
  },
  {
    records: ['RO-22', 'RO-23', 'RO-30'],
    files: [
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
  { records: ['RO-28'], files: ['src/account/session.ts', 'src/ui/account.ts'] },
  { records: ['RO-29'], files: ['src/pro-room/runtime.ts', 'src/network/peer.ts'] },
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
    'RO-04 SFU_CONTROL_REQUEST_TIMEOUT_MS@src/network/pro-system-audio-sfu.ts = ' +
      'SFU_CONTROL_REQUEST_TIMEOUT_MS@src/network/system-audio-sfu.ts (15000)',
    { kind: 'copy', reason: 'Realtime control timeout; Phase 0d C4-1' },
  ],
  [
    'RO-04 SYSTEM_AUDIO_PLAYOUT_DELAY_S@src/network/pro-system-audio-sfu.ts = ' +
      'SYSTEM_AUDIO_PLAYOUT_DELAY_S@src/network/system-audio-guest.ts (0.5)',
    { kind: 'copy', reason: 'receive playout delay; Phase 0d C4-1' },
  ],
  [
    'RO-04 SYSTEM_AUDIO_PLAYOUT_DELAY_S@src/network/pro-system-audio-sfu.ts = ' +
      'SYSTEM_AUDIO_PLAYOUT_DELAY_S@src/network/system-audio-sfu.ts (0.5)',
    { kind: 'copy', reason: 'receive playout delay; Phase 0d C4-1' },
  ],
  [
    'RO-04 SYSTEM_AUDIO_PLAYOUT_DELAY_S@src/network/system-audio-guest.ts = ' +
      'SYSTEM_AUDIO_PLAYOUT_DELAY_S@src/network/system-audio-sfu.ts (0.5)',
    { kind: 'copy', reason: 'receive playout delay; Phase 0d C4-1' },
  ],
  [
    'RO-05 REJOIN_RETRY_MS@src/player/local-output-rejoin.ts = ' +
      'RENDEZVOUS_RETRY_MS@src/player/background-return-sync.ts ([250,750,1500,3000,5000])',
    { kind: 'copy', reason: 're-align retry schedule; Phase 0d C3-I1' },
  ],
  [
    'RO-29 CONTROL_CHANNEL_RECOVERY_RETRY_MS@src/pro-room/runtime.ts = ' +
      'RECONNECT_BACKOFF_MS@src/network/peer.ts ([1000,2000,4000,8000,15000])',
    { kind: 'suspect', reason: 'PRO control channel vs signaling reconnect; Phase 0d triages it' },
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

/** Every record ID this guard's manifests name, for CHECK 1. */
const GUARD_RECORD_IDS: readonly string[] = [
  'RO-01',
  'RO-04',
  'RO-07',
  'RO-08',
  'RO-22',
  'RO-23',
  'RO-24',
  'RO-25',
  'RO-26',
  'RO-30',
  'RO-44',
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
  readonly broadcastEndpointSites: string[];
  readonly durationReadSites: string[];
  readonly armedReceptionStartSites: string[];
  readonly authorityFenceWriteSites: string[];
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
    broadcastEndpointSites: [],
    durationReadSites: [],
    armedReceptionStartSites: [],
    authorityFenceWriteSites: [],
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
    }

    const member = memberName(node);
    if (
      member !== null &&
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    ) {
      const receiver = node.expression;
      if (member === 'inert' && isAssignmentTarget(node)) facts.inertWrites += 1;
      if (member === 'ariaHidden' && isAssignmentTarget(node)) facts.ariaHiddenWrites += 1;
      if ((member === 'children' || member === 'childNodes') && receiverName(receiver) === 'body') {
        facts.bodyChildrenWalks += 1;
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
    if (callee === null) return;
    if (ATTRIBUTE_WRITE_METHODS.has(callee)) {
      const attribute = firstStringArgument(node);
      if (attribute === 'inert') facts.inertWrites += 1;
      else if (attribute === 'aria-hidden') facts.ariaHiddenWrites += 1;
    } else if (callee === 'setElementInertForOwner') {
      facts.pageLockClaims += 1;
    } else if ((callee === 'resume' || callee === 'suspend') && node.arguments.length === 0) {
      // AudioContext.resume() and suspend() take no arguments and are always
      // called on a receiver; a bare resume() is a local function.
      const target = unwrap(node.expression);
      if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return;
      const receiver = receiverName(target.expression);
      if (receiver === null || !NON_AUDIO_CONTEXT_RECEIVERS.has(receiver)) {
        facts.audioContextNativeCalls += 1;
      }
    }
  });

  factsCache.set(relPath, { text, facts });
  return facts;
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

function disablesWatchdog(call: ts.CallExpression): boolean {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(unwrap(options))) return false;
  return (unwrap(options) as ts.ObjectLiteralExpression).properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === 'receiveWatchdog' &&
      unwrap(property.initializer).kind === ts.SyntaxKind.FalseKeyword,
  );
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
  const watchdogMs = findConstant(sources, G1_GUEST_FILE, G1_WATCHDOG_CONSTANT);
  if (retryMaxMs === null) anchor(`${G1_SERVICE_FILE} has no numeric ${G1_RETRY_MAX_CONSTANT}`);
  if (watchdogMs === null) anchor(`${G1_GUEST_FILE} has no numeric ${G1_WATCHDOG_CONSTANT}`);
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
        'One attempt needs one deadline owner: pass { receiveWatchdog: false } or keep the ' +
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
        'watchdog armed through the retry backoff (G1); pass { receiveWatchdog: false } or ' +
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

  const sinks: Record<string, number> = {};
  for (const check of pageStateChecks) sinks[check.label] = total(check.measured);
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
      `  Developer API authority fence writes: ${report.authorityFenceWrites}.`,
  );
  if (argv.includes('--report')) {
    for (const pair of timingPairs.reportOnly) console.log(`    report-only: ${pair}`);
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
