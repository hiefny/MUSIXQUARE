import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
  ACCOUNT_ASSERTION_HEADER,
  createAccountAssertion,
} from '../cloudflare/account-assertion.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_COMMIT = '8cedc0815456984a61929891a820ef85978bb5ae';
const BASELINE_WORKER_PATH = 'cloudflare/pro-room-worker.js';
const CURRENT_WORKER_PATH = 'cloudflare/pro-room-worker.ts';
const ROOM_CODE = '000000';
const BASE_URL = `https://pro.musixquare.com/v1/rooms/${ROOM_CODE}`;
const ACTIVATION_SECRET = 'activation-secret-'.padEnd(48, 'a');
const PIN_PEPPER = 'pin-pepper-'.padEnd(48, 'p');
const SESSION_SECRET = 'session-secret-'.padEnd(48, 's');
const SIGNALING_SECRET = 'signaling-secret-'.padEnd(48, 'g');
const ACCOUNT_ASSERTION_SECRET = 'account-assertion-secret-'.padEnd(48, 'i');
const OWNER_ACCOUNT_ID = `acct_${'A'.repeat(22)}`;
const PARTICIPANT_COUNT = 100;
const PLAYLIST_COUNT = 1_000;
const HEARTBEAT_ROUNDS = 4;
const HEARTBEAT_COUNT = PARTICIPANT_COUNT * HEARTBEAT_ROUNDS;
const COALESCE_WINDOW_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const encoder = new TextEncoder();

interface StorageMetrics {
  putCalls: number;
  putEntries: number;
  putBytes: number;
  bytesByKey: Record<string, number>;
  callsByKey: Record<string, number>;
  transactions: number;
  transactionSnapshotMs: number[];
  setAlarmCalls: number;
  deleteAlarmCalls: number;
}

interface ParticipantIdentity {
  participantId: string;
  presenceIncarnationId: string;
}

interface BenchmarkParticipant extends ParticipantIdentity {
  cookie: string;
}

interface PlaylistItem {
  queueItemId: string;
  name: string;
  source: { kind: 'youtube'; videoId: string };
}

interface KnownRevisions {
  revision: number;
  playlistRevision: number;
  presenceRevision: number;
  playbackRevision: number;
  coordinatorEpoch: unknown;
}

interface BenchmarkSeed {
  data: Map<string, unknown>;
  alarm: number | null;
  participants: BenchmarkParticipant[];
  known: KnownRevisions;
}

interface BenchmarkRoom {
  sessions: Record<string, unknown>;
  authEpoch: unknown;
  activationClaimGeneration: number;
  playlist: PlaylistItem[];
  playlistRevision: number;
  revision: number;
  presence: {
    participants: Record<string, unknown>;
    revision: number;
    coordinatorEpoch: unknown;
  };
  playback: { revision: number };
}

type AsyncWorkerMethod = (...args: unknown[]) => Promise<unknown>;
type TimedMethodName = 'persist' | 'scheduleAlarm' | 'authenticate' | 'prune';

interface BenchmarkWorker {
  room: BenchmarkRoom;
  ready?: Promise<unknown>;
  scheduledAlarmMs: number | null;
  lastHeartbeatDurabilityPersistedAtMs: number | null;
  pendingHeartbeatFlushGeneration: unknown | null;
  mutationTail: Promise<unknown>;
  fetch(request: Request): Promise<Response>;
  persist: AsyncWorkerMethod;
  scheduleAlarm: AsyncWorkerMethod;
  authenticate: AsyncWorkerMethod;
  prune: AsyncWorkerMethod;
}

interface BenchmarkInternals {
  assertBoundedRoomState(value: unknown): unknown;
  playlistItemSignature(value: unknown): unknown;
  serializedCoreStateByteLength(value: unknown): unknown;
  serializedPlaylistStateByteLength(value: unknown): unknown;
  splitPersistentRoomState(value: unknown): unknown;
}

interface BenchmarkModule {
  MusixquareProRoom: new (state: FakeState, env: BenchmarkEnvironment) => BenchmarkWorker;
  issueProRoomActivationClaim(
    roomCode: string,
    activationSecret: string,
    options: {
      nowMs: number;
      expiresAtMs: number;
      nonce: string;
      generation: number;
      roomGeneration: number;
    },
  ): Promise<string>;
  __heartbeatBenchmarkInternals: BenchmarkInternals;
}

interface BenchmarkEnvironment {
  PRO_ROOM_ACTIVATION_SECRET: string;
  PRO_ROOM_PIN_PEPPER: string;
  PRO_ROOM_SESSION_SECRET: string;
  PRO_SIGNALING_SECRET: string;
  MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  PRO_MEDIA_BUCKET: FakeR2Bucket;
  MUSIXQUARE_ADMIN_DB: FakeEntitlementDb;
  MUSIXQUARE_AUTH_DB: FakeAuthDb;
}

interface DurationSummary {
  count: number;
  totalMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

interface PhaseTimings {
  persist: number[];
  alarmScan: number[];
  authenticate: number[];
  prune: number[];
}

interface RunExtra {
  requestedPersists: number;
  durabilityFlushes: number;
  timerDrainMs: number;
}

interface RunSummary extends RunExtra {
  name: string;
  elapsedMs: number;
  requestsPerSecond: number;
  storage: {
    putCalls: number;
    putEntries: number;
    putBytes: number;
    averageBytesPerFlush: number;
    transactions: number;
    setAlarmCalls: number;
    deleteAlarmCalls: number;
    core: { calls: number; bytes: number };
    playlistRows: { calls: number; bytes: number };
  };
  phases: {
    persist: DurationSummary;
    alarmScan: DurationSummary;
    authenticate: DurationSummary;
    prune: DurationSummary;
    fakeStorageTransactionSnapshot: DurationSummary;
  };
}

interface PrintableBenchmarkResult {
  measurements: { baseline: RunSummary; currentHybrid: RunSummary };
  isolatedPhases: Record<string, string | DurationSummary>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}

function assertBenchmarkModule(value: unknown, label: string): asserts value is BenchmarkModule {
  const internals =
    isRecord(value) && isRecord(value.__heartbeatBenchmarkInternals)
      ? value.__heartbeatBenchmarkInternals
      : null;
  if (
    !isRecord(value) ||
    !isFunction(value.MusixquareProRoom) ||
    !isFunction(value.issueProRoomActivationClaim) ||
    !internals ||
    ![
      'assertBoundedRoomState',
      'playlistItemSignature',
      'serializedCoreStateByteLength',
      'serializedPlaylistStateByteLength',
      'splitPersistentRoomState',
    ].every((name) => isFunction(internals[name]))
  ) {
    throw new Error(`Benchmark ${label} module omitted required exports`);
  }
}

function isDurationSummary(value: unknown): value is DurationSummary {
  return (
    isRecord(value) &&
    typeof value.totalMs === 'number' &&
    typeof value.meanMs === 'number' &&
    typeof value.p95Ms === 'number'
  );
}

function parseArgs(argv: readonly string[]): { json: string | null } {
  const result: { json: string | null } = { json: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') {
      result.json = argv[index + 1] || null;
      index += 1;
    }
  }
  return result;
}

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function durationSummary(values: readonly number[]): DurationSummary {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    totalMs: round(total),
    meanMs: round(values.length ? total / values.length : 0),
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    maxMs: round(Math.max(0, ...values)),
  };
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString(
    'base64url',
  );
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function deterministicCredential(
  index: number,
): Promise<{ token: string; tokenHash: string }> {
  const random = base64Url(
    Uint8Array.from({ length: 32 }, (_, byteIndex) => (index * 31 + byteIndex * 17) & 0xff),
  );
  const prefix = `v1.${random}`;
  const token = `${prefix}.${await hmacBase64Url(SESSION_SECRET, prefix)}`;
  return { token, tokenHash: await sha256Base64Url(token) };
}

function deterministicOpaqueId(prefix: string, index: number): string {
  const bytes = Uint8Array.from(
    { length: 18 },
    (_, byteIndex) => (index * 29 + byteIndex * 13 + prefix.length) & 0xff,
  );
  return `${prefix}_${base64Url(bytes)}`;
}

function queueItemId(index: number): string {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function playlistItem(index: number): PlaylistItem {
  return {
    queueItemId: queueItemId(index),
    name: `Benchmark track ${index + 1}`,
    source: {
      kind: 'youtube',
      videoId: `b${index.toString(36).padStart(10, '0')}`,
    },
  };
}

function emptyStorageMetrics(): StorageMetrics {
  return {
    putCalls: 0,
    putEntries: 0,
    putBytes: 0,
    bytesByKey: {},
    callsByKey: {},
    transactions: 0,
    transactionSnapshotMs: [],
    setAlarmCalls: 0,
    deleteAlarmCalls: 0,
  };
}

class FakeStorage {
  data: Map<string, unknown>;
  alarm: number | null;
  metrics: StorageMetrics;

  constructor(data: ReadonlyMap<string, unknown> = new Map(), alarm: number | null = null) {
    this.data = new Map(structuredClone([...data.entries()]));
    this.alarm = alarm;
    this.metrics = emptyStorageMetrics();
  }

  resetMetrics(): void {
    this.metrics = emptyStorageMetrics();
  }

  async get(key: string | readonly string[]): Promise<unknown | Map<string, unknown>> {
    if (typeof key !== 'string') {
      return new Map(key.map((entryKey) => [entryKey, structuredClone(this.data.get(entryKey))]));
    }
    return structuredClone(this.data.get(key));
  }

  recordPut(key: string, value: unknown): void {
    const bytes = byteLength(value);
    this.metrics.putEntries += 1;
    this.metrics.putBytes += bytes;
    this.metrics.bytesByKey[key] = (this.metrics.bytesByKey[key] || 0) + bytes;
    this.metrics.callsByKey[key] = (this.metrics.callsByKey[key] || 0) + 1;
  }

  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    this.metrics.putCalls += 1;
    if (typeof key === 'string') {
      this.recordPut(key, value);
      this.data.set(key, structuredClone(value));
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(key)) {
      this.recordPut(entryKey, entryValue);
      this.data.set(entryKey, structuredClone(entryValue));
    }
  }

  async delete(key: string | readonly string[]): Promise<boolean | number> {
    if (typeof key !== 'string') {
      let deleted = 0;
      for (const entryKey of key) deleted += this.data.delete(entryKey) ? 1 : 0;
      return deleted;
    }
    return this.data.delete(key);
  }

  async transaction<Result>(
    callback: (storage: FakeStorage) => Result | Promise<Result>,
  ): Promise<Result> {
    this.metrics.transactions += 1;
    const startedAt = performance.now();
    const before = structuredClone([...this.data.entries()]);
    this.metrics.transactionSnapshotMs.push(performance.now() - startedAt);
    try {
      return await callback(this);
    } catch (error) {
      this.data.clear();
      for (const [key, value] of before) this.data.set(key, value);
      throw error;
    }
  }

  async setAlarm(value: number): Promise<void> {
    this.metrics.setAlarmCalls += 1;
    this.alarm = value;
  }

  async deleteAlarm(): Promise<void> {
    this.metrics.deleteAlarmCalls += 1;
    this.alarm = null;
  }
}

class FakeState {
  storage: FakeStorage;

  constructor(storage = new FakeStorage()) {
    this.storage = storage;
  }
}

class FakeR2Bucket {
  objects: Map<string, unknown>;

  constructor() {
    this.objects = new Map<string, unknown>();
  }

  async list(): Promise<{ objects: never[]; truncated: false }> {
    return { objects: [], truncated: false };
  }

  async delete(): Promise<void> {}
}

class FakeEntitlementStatement {
  readonly sql: string;
  readonly database: FakeEntitlementDb;
  bindings: unknown[] = [];

  constructor(database: FakeEntitlementDb, sql: string) {
    this.database = database;
    this.sql = sql;
  }

  bind(...values: unknown[]): FakeEntitlementStatement {
    this.bindings = values;
    return this;
  }

  async first(): Promise<Record<string, unknown> | null> {
    return this.database.first(this.sql);
  }

  async all(): Promise<{ results: Record<string, unknown>[] }> {
    const row = await this.first();
    return { results: row ? [row] : [] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    this.database.apply(this.sql);
    return { meta: { changes: 1 } };
  }
}

class FakeEntitlementDb {
  entitlementStatus: 'reserved' | 'active' | null = null;

  prepare(sql: string): FakeEntitlementStatement {
    return new FakeEntitlementStatement(this, sql);
  }

  async batch(
    statements: readonly FakeEntitlementStatement[],
  ): Promise<Array<{ meta: { changes: number } }>> {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  first(sql: string): Record<string, unknown> | null {
    if (!/FROM\s+mxqr_pro_account_entitlements/iu.test(sql) || !this.entitlementStatus) {
      return null;
    }
    return {
      source_kind: 'legacy_activation',
      status: this.entitlementStatus,
    };
  }

  apply(sql: string): void {
    if (/INSERT\s+INTO\s+mxqr_pro_account_entitlements/iu.test(sql)) {
      this.entitlementStatus = 'reserved';
    } else if (
      /UPDATE\s+mxqr_pro_account_entitlements/iu.test(sql) &&
      /SET\s+status\s*=\s*'active'/iu.test(sql)
    ) {
      this.entitlementStatus = 'active';
    }
  }
}

class FakeAuthStatement {
  bind(..._values: unknown[]): FakeAuthStatement {
    return this;
  }

  async first(): Promise<{ account_status: 'active'; deletion_pending: 0 }> {
    return { account_status: 'active', deletion_pending: 0 };
  }

  async all(): Promise<{
    results: Array<{ account_status: 'active'; deletion_pending: 0 }>;
  }> {
    return { results: [await this.first()] };
  }
}

class FakeAuthDb {
  prepare(_sql: string): FakeAuthStatement {
    return new FakeAuthStatement();
  }
}

function environment(): BenchmarkEnvironment {
  return {
    PRO_ROOM_ACTIVATION_SECRET: ACTIVATION_SECRET,
    PRO_ROOM_PIN_PEPPER: PIN_PEPPER,
    PRO_ROOM_SESSION_SECRET: SESSION_SECRET,
    PRO_SIGNALING_SECRET: SIGNALING_SECRET,
    MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: ACCOUNT_ASSERTION_SECRET,
    R2_ACCOUNT_ID: '01353882e4eea3a5acaa0c45e8336af4',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key'.padEnd(40, 'k'),
    R2_BUCKET_NAME: 'musixquare-pro-media',
    PRO_MEDIA_BUCKET: new FakeR2Bucket(),
    MUSIXQUARE_ADMIN_DB: new FakeEntitlementDb(),
    MUSIXQUARE_AUTH_DB: new FakeAuthDb(),
  };
}

function request(
  pathname: string,
  init: RequestInit = {},
  cookie: string | null = null,
  identity: ParticipantIdentity | null = null,
): Request {
  const headers = new Headers(init.headers);
  headers.set('x-mxqr-pro-room-code', ROOM_CODE);
  headers.set('x-mxqr-pro-room-generation', '0');
  headers.set('x-mxqr-pro-ip-hash', 'benchmark-client-address');
  if (cookie) headers.set('cookie', cookie);
  if (identity) {
    headers.set('x-mxqr-pro-participant-id', identity.participantId);
    headers.set('x-mxqr-pro-presence-incarnation', identity.presenceIncarnationId);
  }
  return new Request(`${BASE_URL}${pathname}`, { ...init, headers });
}

function jsonRequest(
  pathname: string,
  body: unknown,
  cookie: string | null = null,
  identity: ParticipantIdentity | null = null,
): Request {
  return request(
    pathname,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    cookie,
    identity,
  );
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('Benchmark activation did not issue a session cookie');
  return setCookie.split(';')[0] ?? '';
}

const STATIC_RELATIVE_IMPORT_RE =
  /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/gu;

function instrumentBenchmarkEntry(source: string, label: string): string {
  return `${source}\nexport const __heartbeatBenchmarkInternals = {\n  assertBoundedRoomState,\n  playlistItemSignature,\n  serializedCoreStateByteLength,\n  serializedPlaylistStateByteLength,\n  splitPersistentRoomState,\n};\n//# sourceURL=mxqr-heartbeat-benchmark-${label}.mjs\n`;
}

async function materializeWorkerModuleGraph(
  label: string,
  entryPath: string,
  readSource: (repoPath: string) => string | Promise<string>,
): Promise<{ module: BenchmarkModule; tempRoot: string }> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `mxqr-heartbeat-${label}-`));
  await writeFile(
    path.join(tempRoot, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' })}\n`,
    'utf8',
  );
  const visited = new Set<string>();
  const visit = async (repoPath: string): Promise<void> => {
    const normalizedPath = path.posix.normalize(repoPath.replaceAll('\\', '/'));
    if (
      normalizedPath.startsWith('../') ||
      path.posix.isAbsolute(normalizedPath) ||
      visited.has(normalizedPath)
    ) {
      return;
    }
    visited.add(normalizedPath);
    let source = await readSource(normalizedPath);
    if (normalizedPath === entryPath) {
      source = instrumentBenchmarkEntry(source, label);
    }
    const destination = path.join(tempRoot, ...normalizedPath.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source, 'utf8');
    const dependencies: string[] = [];
    for (const match of source.matchAll(STATIC_RELATIVE_IMPORT_RE)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const dependency = path.posix.normalize(
        path.posix.join(path.posix.dirname(normalizedPath), specifier),
      );
      if (dependency.startsWith('../') || path.posix.isAbsolute(dependency)) {
        throw new Error(`Benchmark module escaped repository root: ${specifier}`);
      }
      dependencies.push(dependency);
    }
    await Promise.all(dependencies.map((dependency) => visit(dependency)));
  };
  try {
    await visit(entryPath);
    const entryUrl = pathToFileURL(path.join(tempRoot, ...entryPath.split('/'))).href;
    const module: unknown = await import(entryUrl);
    assertBenchmarkModule(module, label);
    return { module, tempRoot };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function loadBenchmarkModules(): Promise<{
  baseline: BenchmarkModule;
  current: BenchmarkModule;
  cleanup: () => Promise<void>;
}> {
  const materialized: string[] = [];
  try {
    const baseline = await materializeWorkerModuleGraph(
      'baseline',
      BASELINE_WORKER_PATH,
      async (repoPath) =>
        execFileSync('git', ['show', `${BASELINE_COMMIT}:${repoPath}`], {
          cwd: ROOT,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        }),
    );
    materialized.push(baseline.tempRoot);
    const current = await materializeWorkerModuleGraph(
      'working-tree',
      CURRENT_WORKER_PATH,
      (repoPath) => readFile(path.join(ROOT, ...repoPath.split('/')), 'utf8'),
    );
    materialized.push(current.tempRoot);
    return {
      baseline: baseline.module,
      current: current.module,
      cleanup: async () => {
        await Promise.all(
          materialized.map((tempRoot) => rm(tempRoot, { recursive: true, force: true })),
        );
      },
    };
  } catch (error) {
    await Promise.all(
      materialized.map((tempRoot) => rm(tempRoot, { recursive: true, force: true })),
    );
    throw error;
  }
}

async function createSeed(module: BenchmarkModule): Promise<BenchmarkSeed> {
  const storage = new FakeStorage();
  const worker = new module.MusixquareProRoom(new FakeState(storage), environment());
  if (worker.ready) await worker.ready;
  const nowMs = Date.now();
  const claimToken = await module.issueProRoomActivationClaim(ROOM_CODE, ACTIVATION_SECRET, {
    nowMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60_000,
    nonce: 'benchmark-activation-nonce',
    generation: 0,
    roomGeneration: 0,
  });
  const accountAssertion = await createAccountAssertion(
    {
      accountId: OWNER_ACCOUNT_ID,
      nickname: 'Benchmark owner',
      roomCode: ROOM_CODE,
      roomGeneration: 0,
      audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
    },
    ACCOUNT_ASSERTION_SECRET,
  );
  if (!accountAssertion) throw new Error('Benchmark account assertion could not be created');
  const activationRequest = jsonRequest('/activation', {
    claimToken,
    temporaryPin: '00000000',
    newPin: '12345678',
    ownerName: 'Benchmark owner',
  });
  activationRequest.headers.set(ACCOUNT_ASSERTION_HEADER, accountAssertion);
  const activation = await worker.fetch(activationRequest);
  if (!activation.ok) {
    const errorBody = await activation.text();
    throw new Error(
      `Benchmark room activation failed with ${activation.status}: ${errorBody.slice(0, 200)}`,
    );
  }
  const ownerCookie = cookieFrom(activation);
  const activationBody: unknown = await activation.json();
  const snapshot =
    isRecord(activationBody) && isRecord(activationBody.snapshot) ? activationBody.snapshot : null;
  const viewer = snapshot && isRecord(snapshot.viewer) ? snapshot.viewer : null;
  if (
    !viewer ||
    typeof viewer.participantId !== 'string' ||
    typeof viewer.presenceIncarnationId !== 'string'
  ) {
    throw new Error('Benchmark activation returned an invalid viewer identity');
  }
  const ownerIdentity = {
    participantId: viewer.participantId,
    presenceIncarnationId: viewer.presenceIncarnationId,
  };
  const participants: BenchmarkParticipant[] = [{ cookie: ownerCookie, ...ownerIdentity }];
  const internal = worker;

  for (let index = 1; index < PARTICIPANT_COUNT; index += 1) {
    const credential = await deterministicCredential(index);
    const participantId = deterministicOpaqueId('participant', index);
    const presenceIncarnationId = deterministicOpaqueId('presence', index);
    const memberId = deterministicOpaqueId('member', index);
    const displayName = `Peer ${index}`;
    internal.room.sessions[credential.tokenHash] = {
      memberId,
      participantId,
      presenceIncarnationId,
      roomGeneration: 0,
      signalingTicketSequence: 0,
      displayName,
      role: 'controller',
      authEpoch: internal.room.authEpoch,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 30 * 24 * 60 * 60 * 1_000,
    };
    internal.room.presence.participants[participantId] = {
      participantId,
      presenceIncarnationId,
      memberId,
      sessionHash: credential.tokenHash,
      displayName,
      role: 'controller',
      joinedAtMs: nowMs,
      lastSeenAtMs: nowMs,
      developerControlVersion: 0,
    };
    participants.push({
      cookie: `__Host-mxqr_pro_session_${ROOM_CODE}=${credential.token}`,
      participantId,
      presenceIncarnationId,
    });
  }

  internal.room.playlist = Array.from({ length: PLAYLIST_COUNT }, (_, index) =>
    playlistItem(index),
  );
  internal.room.playlistRevision += 1;
  internal.room.presence.revision += PARTICIPANT_COUNT - 1;
  internal.room.revision += 1;
  await internal.persist();

  return {
    data: storage.data,
    alarm: storage.alarm,
    participants,
    known: {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
      presenceRevision: internal.room.presence.revision,
      playbackRevision: internal.room.playback.revision,
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
    },
  };
}

async function workerFromSeed(
  module: BenchmarkModule,
  seed: BenchmarkSeed,
): Promise<{ worker: BenchmarkWorker; storage: FakeStorage }> {
  const storage = new FakeStorage(seed.data, seed.alarm);
  const worker = new module.MusixquareProRoom(new FakeState(storage), environment());
  if (worker.ready) await worker.ready;
  // The baseline seed may be opened by a newer module with additive
  // normalization work pending. Settle that one-time migration before metrics
  // are reset so the documented workload remains a warm steady-state
  // heartbeat comparison rather than counting startup repair as a heartbeat
  // durability flush.
  await worker.prune(Date.now());
  worker.scheduledAlarmMs = storage.alarm;
  storage.resetMetrics();
  return { worker, storage };
}

function timedMethod(
  target: BenchmarkWorker,
  methodName: TimedMethodName,
  values: number[],
): AsyncWorkerMethod {
  const original = target[methodName].bind(target);
  target[methodName] = async (...args: unknown[]): Promise<unknown> => {
    const startedAt = performance.now();
    try {
      return await original(...args);
    } finally {
      values.push(performance.now() - startedAt);
    }
  };
  return original;
}

function heartbeatRequest(seed: BenchmarkSeed, participantIndex: number): Request {
  const participant = seed.participants[participantIndex];
  if (!participant) throw new Error(`Benchmark participant ${participantIndex} is missing`);
  return jsonRequest('/presence/heartbeat', seed.known, participant.cookie, participant);
}

async function runImmediateBaseline(
  module: BenchmarkModule,
  seed: BenchmarkSeed,
): Promise<RunSummary> {
  const { worker, storage } = await workerFromSeed(module, seed);
  const timings: PhaseTimings = { persist: [], alarmScan: [], authenticate: [], prune: [] };
  timedMethod(worker, 'persist', timings.persist);
  timedMethod(worker, 'scheduleAlarm', timings.alarmScan);
  timedMethod(worker, 'authenticate', timings.authenticate);
  timedMethod(worker, 'prune', timings.prune);

  let responseElapsedMs = 0;
  for (let remainingRounds = HEARTBEAT_ROUNDS; remainingRounds > 0; remainingRounds -= 1) {
    const startedAt = performance.now();
    const responses = await Promise.all(
      seed.participants.map((_, participantIndex) =>
        worker.fetch(heartbeatRequest(seed, participantIndex)),
      ),
    );
    responseElapsedMs += performance.now() - startedAt;
    const failed = responses.find((response) => response.status !== 200);
    if (failed) {
      throw new Error(
        `Baseline heartbeat workload returned ${failed.status}: ${await failed.text()}`,
      );
    }
  }
  return summarizeRun('baseline-immediate-persist', responseElapsedMs, storage, timings, {
    requestedPersists: HEARTBEAT_COUNT,
    durabilityFlushes: timings.persist.length,
    timerDrainMs: 0,
  });
}

async function runHybridCurrent(module: BenchmarkModule, seed: BenchmarkSeed): Promise<RunSummary> {
  const { worker, storage } = await workerFromSeed(module, seed);
  const timings: PhaseTimings = { persist: [], alarmScan: [], authenticate: [], prune: [] };
  timedMethod(worker, 'persist', timings.persist);
  timedMethod(worker, 'scheduleAlarm', timings.alarmScan);
  timedMethod(worker, 'authenticate', timings.authenticate);
  timedMethod(worker, 'prune', timings.prune);

  let responseElapsedMs = 0;
  let timerDrainMs = 0;
  for (let roundIndex = 0; roundIndex < HEARTBEAT_ROUNDS; roundIndex += 1) {
    // Each round models a normal 15-second heartbeat interval. Resetting this
    // in-memory anchor is equivalent to the quiet gap without making the
    // benchmark sleep for 15 seconds; persisted room state is left intact.
    worker.lastHeartbeatDurabilityPersistedAtMs = null;
    const responseStartedAt = performance.now();
    const responses = await Promise.all(
      seed.participants.map((_, participantIndex) =>
        worker.fetch(heartbeatRequest(seed, participantIndex)),
      ),
    );
    responseElapsedMs += performance.now() - responseStartedAt;
    const failed = responses.find((response) => response.status !== 200);
    if (failed) {
      throw new Error(
        `Hybrid heartbeat workload returned ${failed.status}: ${await failed.text()}`,
      );
    }
    if (worker.pendingHeartbeatFlushGeneration === null) {
      throw new Error('Hybrid heartbeat burst did not schedule its trailing flush');
    }
    const drainStartedAt = performance.now();
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, COALESCE_WINDOW_MS + 20));
    await worker.mutationTail;
    timerDrainMs += performance.now() - drainStartedAt;
    if (worker.pendingHeartbeatFlushGeneration !== null) {
      throw new Error('Hybrid heartbeat trailing flush did not settle');
    }
  }
  return summarizeRun('current-hybrid-1s', responseElapsedMs, storage, timings, {
    requestedPersists: HEARTBEAT_COUNT,
    durabilityFlushes: timings.persist.length,
    timerDrainMs: round(timerDrainMs),
  });
}

function summarizeRun(
  name: string,
  elapsedMs: number,
  storage: FakeStorage,
  timings: PhaseTimings,
  extra: RunExtra,
): RunSummary {
  return {
    name,
    elapsedMs: round(elapsedMs),
    requestsPerSecond: round(HEARTBEAT_COUNT / (elapsedMs / 1_000)),
    ...extra,
    storage: {
      putCalls: storage.metrics.putCalls,
      putEntries: storage.metrics.putEntries,
      putBytes: storage.metrics.putBytes,
      averageBytesPerFlush: round(storage.metrics.putBytes / Math.max(1, extra.durabilityFlushes)),
      transactions: storage.metrics.transactions,
      setAlarmCalls: storage.metrics.setAlarmCalls,
      deleteAlarmCalls: storage.metrics.deleteAlarmCalls,
      core: {
        calls: storage.metrics.callsByKey['pro-room:v2:core'] || 0,
        bytes: storage.metrics.bytesByKey['pro-room:v2:core'] || 0,
      },
      playlistRows: {
        calls: Object.entries(storage.metrics.callsByKey)
          .filter(([key]) => key.startsWith('pro-room:v2:playlist:'))
          .reduce((sum, [, calls]) => sum + calls, 0),
        bytes: Object.entries(storage.metrics.bytesByKey)
          .filter(([key]) => key.startsWith('pro-room:v2:playlist:'))
          .reduce((sum, [, bytes]) => sum + bytes, 0),
      },
    },
    phases: {
      persist: durationSummary(timings.persist),
      alarmScan: durationSummary(timings.alarmScan),
      authenticate: durationSummary(timings.authenticate),
      prune: durationSummary(timings.prune),
      fakeStorageTransactionSnapshot: durationSummary(storage.metrics.transactionSnapshotMs),
    },
  };
}

function measureSync(iterations: number, operation: () => void): DurationSummary {
  for (let index = 0; index < 10; index += 1) operation();
  const values: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    operation();
    values.push(performance.now() - startedAt);
  }
  return durationSummary(values);
}

async function measureIsolatedPhases(
  module: BenchmarkModule,
  seed: BenchmarkSeed,
): Promise<Record<string, string | DurationSummary>> {
  const { worker } = await workerFromSeed(module, seed);
  const room = worker.room;
  const internals = module.__heartbeatBenchmarkInternals;
  return {
    note: 'Diagnostics overlap: boundedInvariant includes core, playlist and per-item signature serialization.',
    coreSerialization: measureSync(HEARTBEAT_COUNT, () =>
      internals.serializedCoreStateByteLength(room),
    ),
    playlistSerialization: measureSync(HEARTBEAT_COUNT, () =>
      internals.serializedPlaylistStateByteLength(room),
    ),
    signatureScan: measureSync(HEARTBEAT_COUNT, () => {
      for (const item of room.playlist) internals.playlistItemSignature(item);
    }),
    boundedInvariant: measureSync(HEARTBEAT_COUNT, () => internals.assertBoundedRoomState(room)),
  };
}

function theoreticalHybridFlushes(
  offsetForParticipant: (participantIndex: number) => number,
): number {
  let flushes = 0;
  for (let remainingRounds = HEARTBEAT_ROUNDS; remainingRounds > 0; remainingRounds -= 1) {
    let lastPersistedAtMs = null;
    let pendingWindowEndMs = null;
    for (let participantIndex = 0; participantIndex < PARTICIPANT_COUNT; participantIndex += 1) {
      const eventAtMs = offsetForParticipant(participantIndex);
      if (pendingWindowEndMs !== null && pendingWindowEndMs <= eventAtMs) {
        flushes += 1;
        lastPersistedAtMs = pendingWindowEndMs;
        pendingWindowEndMs = null;
      }
      if (lastPersistedAtMs === null || eventAtMs >= lastPersistedAtMs + COALESCE_WINDOW_MS) {
        flushes += 1;
        lastPersistedAtMs = eventAtMs;
      } else if (pendingWindowEndMs === null) {
        pendingWindowEndMs = lastPersistedAtMs + COALESCE_WINDOW_MS;
      }
    }
    if (pendingWindowEndMs !== null) flushes += 1;
  }
  return flushes;
}

function sourceCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function workerSourceDirty(): boolean {
  try {
    execFileSync('git', ['diff', '--quiet', '--', CURRENT_WORKER_PATH], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return false;
  } catch {
    return true;
  }
}

function ratio(current: number, candidate: number): number {
  return round(current / Math.max(candidate, Number.EPSILON));
}

function printTable(result: PrintableBenchmarkResult): void {
  console.table(
    [result.measurements.baseline, result.measurements.currentHybrid].map((measurement) => ({
      mode: measurement.name,
      heartbeats: HEARTBEAT_COUNT,
      flushes: measurement.durabilityFlushes,
      'put calls': measurement.storage.putCalls,
      'put MiB': round(measurement.storage.putBytes / 1024 / 1024),
      'response ms': measurement.elapsedMs,
      'timer drain ms': measurement.timerDrainMs,
      'persist ms': measurement.phases.persist.totalMs,
      'alarm scan ms': measurement.phases.alarmScan.totalMs,
    })),
  );
  console.table(
    Object.entries(result.isolatedPhases).flatMap(([phase, value]) =>
      isDurationSummary(value)
        ? [{ phase, totalMs: value.totalMs, meanMs: value.meanMs, p95Ms: value.p95Ms }]
        : [],
    ),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const modules = await loadBenchmarkModules();
  try {
    const baselineSeed = await createSeed(modules.baseline);
    const currentSeed = await createSeed(modules.current);
    const baseline = await runImmediateBaseline(modules.baseline, baselineSeed);
    const currentHybrid = await runHybridCurrent(modules.current, currentSeed);
    if (baseline.durabilityFlushes !== HEARTBEAT_COUNT) {
      throw new Error(
        `Baseline wrote ${baseline.durabilityFlushes} times; expected ${HEARTBEAT_COUNT}`,
      );
    }
    if (currentHybrid.durabilityFlushes !== HEARTBEAT_ROUNDS * 2) {
      throw new Error(
        `Hybrid wrote ${currentHybrid.durabilityFlushes} times; expected ${HEARTBEAT_ROUNDS * 2}`,
      );
    }
    const isolatedPhases = await measureIsolatedPhases(modules.current, currentSeed);
    const clusteredTheoreticalFlushes = theoreticalHybridFlushes(
      (participantIndex) => participantIndex * 5,
    );
    const uniformlyStaggeredTheoreticalFlushes = theoreticalHybridFlushes((participantIndex) =>
      Math.floor((participantIndex * HEARTBEAT_INTERVAL_MS) / PARTICIPANT_COUNT),
    );
    const coreBytesPerFlush = baseline.storage.core.bytes / baseline.storage.core.calls;

    const result = {
      schemaVersion: 2,
      source: {
        baselineCommit: BASELINE_COMMIT,
        workingTreeCommit: sourceCommit(),
        workingTreeDirty: workerSourceDirty(),
        worker: CURRENT_WORKER_PATH,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        cpu: os.cpus()[0]?.model || 'unknown',
        generatedAt: new Date().toISOString(),
      },
      workload: {
        participants: PARTICIPANT_COUNT,
        playlistItems: PLAYLIST_COUNT,
        heartbeatRounds: HEARTBEAT_ROUNDS,
        heartbeats: HEARTBEAT_COUNT,
        roundIntervalMs: HEARTBEAT_INTERVAL_MS,
        delivery: 'four bursts of 100 requests through MusixquareProRoom.fetch',
        quietGapModel:
          'The in-memory heartbeat anchor is reset before each round to model a 15-second quiet interval without sleeping for 15 seconds.',
        warmV2Persistence: true,
      },
      measurements: { baseline, currentHybrid },
      comparison: {
        flushReductionPercent: round(
          (1 - currentHybrid.durabilityFlushes / baseline.durabilityFlushes) * 100,
        ),
        putByteReductionPercent: round(
          (1 - currentHybrid.storage.putBytes / baseline.storage.putBytes) * 100,
        ),
        persistenceElapsedSpeedup: ratio(
          baseline.phases.persist.totalMs,
          currentHybrid.phases.persist.totalMs,
        ),
        responsePathHarnessSpeedup: ratio(baseline.elapsedMs, currentHybrid.elapsedMs),
        hybridOneSecondWindowTheory: {
          clusteredWithin500ms: {
            flushes: clusteredTheoreticalFlushes,
            putBytes: coreBytesPerFlush * clusteredTheoreticalFlushes,
            reductionPercent: round((1 - clusteredTheoreticalFlushes / HEARTBEAT_COUNT) * 100),
          },
          uniformlyStaggeredAcross15s: {
            flushes: uniformlyStaggeredTheoreticalFlushes,
            putBytes: coreBytesPerFlush * uniformlyStaggeredTheoreticalFlushes,
            reductionPercent: round(
              (1 - uniformlyStaggeredTheoreticalFlushes / HEARTBEAT_COUNT) * 100,
            ),
          },
        },
      },
      isolatedPhases,
      commitBoundary: {
        coalescible: ['presence heartbeat lastSeenAtMs durability only'],
        immediate: [
          'join',
          'leave',
          'coordinator election or epoch change',
          'topology or authorization change',
        ],
        crashWindow:
          'An interrupted trailing timer can lose only the accepted pure renewal inside that one-second window, returning durable lastSeenAtMs to the prior successful heartbeat. A 17-second guard forces recovery before the next 15-second client heartbeat can race expiry; topology persists immediately.',
      },
      caveats: [
        'This is an in-process Node benchmark, not Cloudflare production latency.',
        `The baseline executes ${BASELINE_COMMIT}; the candidate executes the current working-tree Worker through its real fetch and timer paths.`,
        'fakeStorageTransactionSnapshot isolates the test harness full-storage clone, which SQLite Durable Object transactions do not perform in JavaScript.',
        'Cloudflare SQLite storage billing counts rows written, not these serialized byte totals; each measured pure heartbeat flush writes one v2 core row.',
        'A pending setTimeout prevents Durable Object hibernation and can add duration charges. The hybrid creates no timer for isolated heartbeats and opens one only after dense second arrivals, so net cost depends on traffic shape.',
        'Response elapsed excludes the intentional trailing timer wait; timerDrainMs reports that wall-clock wait separately.',
        'Isolated phase timings overlap and must not be added together.',
      ],
    };

    printTable(result);
    if (args.json) {
      const outputPath = path.resolve(ROOT, args.json);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      console.log(`JSON: ${outputPath}`);
    }
    console.log(JSON.stringify(result));
  } finally {
    await modules.cleanup();
  }
}

await main();
