import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_PATH = path.join(ROOT, 'cloudflare', 'pro-room-worker.js');
const BASELINE_COMMIT = '8cedc0815456984a61929891a820ef85978bb5ae';
const ROOM_CODE = '000001';
const BASE_URL = `https://pro.musixquare.com/v1/rooms/${ROOM_CODE}`;
const ACTIVATION_SECRET = 'activation-secret-'.padEnd(48, 'a');
const PIN_PEPPER = 'pin-pepper-'.padEnd(48, 'p');
const SESSION_SECRET = 'session-secret-'.padEnd(48, 's');
const SIGNALING_SECRET = 'signaling-secret-'.padEnd(48, 'g');
const PARTICIPANT_COUNT = 100;
const PLAYLIST_COUNT = 1_000;
const HEARTBEAT_ROUNDS = 4;
const HEARTBEAT_COUNT = PARTICIPANT_COUNT * HEARTBEAT_ROUNDS;
const COALESCE_WINDOW_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const encoder = new TextEncoder();

function parseArgs(argv) {
  const result = { json: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') {
      result.json = argv[index + 1] || null;
      index += 1;
    }
  }
  return result;
}

function byteLength(value) {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function durationSummary(values) {
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

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function hmacBase64Url(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function sha256Base64Url(value) {
  return base64Url(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function deterministicCredential(index) {
  const random = base64Url(
    Uint8Array.from({ length: 32 }, (_, byteIndex) => (index * 31 + byteIndex * 17) & 0xff),
  );
  const prefix = `v1.${random}`;
  const token = `${prefix}.${await hmacBase64Url(SESSION_SECRET, prefix)}`;
  return { token, tokenHash: await sha256Base64Url(token) };
}

function deterministicOpaqueId(prefix, index) {
  const bytes = Uint8Array.from(
    { length: 18 },
    (_, byteIndex) => (index * 29 + byteIndex * 13 + prefix.length) & 0xff,
  );
  return `${prefix}_${base64Url(bytes)}`;
}

function queueItemId(index) {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function playlistItem(index) {
  return {
    queueItemId: queueItemId(index),
    name: `Benchmark track ${index + 1}`,
    source: {
      kind: 'youtube',
      videoId: `b${index.toString(36).padStart(10, '0')}`,
    },
  };
}

function emptyStorageMetrics() {
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
  constructor(data = new Map(), alarm = null) {
    this.data = new Map(structuredClone([...data.entries()]));
    this.alarm = alarm;
    this.metrics = emptyStorageMetrics();
  }

  resetMetrics() {
    this.metrics = emptyStorageMetrics();
  }

  async get(key) {
    if (Array.isArray(key)) {
      return new Map(key.map((entryKey) => [entryKey, structuredClone(this.data.get(entryKey))]));
    }
    return structuredClone(this.data.get(key));
  }

  recordPut(key, value) {
    const bytes = byteLength(value);
    this.metrics.putEntries += 1;
    this.metrics.putBytes += bytes;
    this.metrics.bytesByKey[key] = (this.metrics.bytesByKey[key] || 0) + bytes;
    this.metrics.callsByKey[key] = (this.metrics.callsByKey[key] || 0) + 1;
  }

  async put(key, value) {
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

  async delete(key) {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const entryKey of key) deleted += this.data.delete(entryKey) ? 1 : 0;
      return deleted;
    }
    return this.data.delete(key);
  }

  async transaction(callback) {
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

  async setAlarm(value) {
    this.metrics.setAlarmCalls += 1;
    this.alarm = value;
  }

  async deleteAlarm() {
    this.metrics.deleteAlarmCalls += 1;
    this.alarm = null;
  }
}

class FakeState {
  constructor(storage = new FakeStorage()) {
    this.storage = storage;
  }
}

class FakeR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async list() {
    return { objects: [], truncated: false };
  }

  async delete() {}
}

function environment() {
  return {
    PRO_ROOM_ACTIVATION_SECRET: ACTIVATION_SECRET,
    PRO_ROOM_PIN_PEPPER: PIN_PEPPER,
    PRO_ROOM_SESSION_SECRET: SESSION_SECRET,
    PRO_SIGNALING_SECRET: SIGNALING_SECRET,
    R2_ACCOUNT_ID: '01353882e4eea3a5acaa0c45e8336af4',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key'.padEnd(40, 'k'),
    R2_BUCKET_NAME: 'musixquare-pro-media',
    PRO_MEDIA_BUCKET: new FakeR2Bucket(),
  };
}

function request(pathname, init = {}, cookie = null, identity = null) {
  const headers = new Headers(init.headers);
  headers.set('x-mxqr-pro-room-code', ROOM_CODE);
  headers.set('x-mxqr-pro-ip-hash', 'benchmark-client-address');
  if (cookie) headers.set('cookie', cookie);
  if (identity) {
    headers.set('x-mxqr-pro-participant-id', identity.participantId);
    headers.set('x-mxqr-pro-presence-incarnation', identity.presenceIncarnationId);
  }
  return new Request(`${BASE_URL}${pathname}`, { ...init, headers });
}

function jsonRequest(pathname, body, cookie = null, identity = null) {
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

function cookieFrom(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('Benchmark activation did not issue a session cookie');
  return setCookie.split(';')[0];
}

async function loadBenchmarkWorkerModule(source, label) {
  // Append benchmark-only exports to an in-memory module. The source file on
  // disk, and therefore the production Worker module surface, stays untouched.
  const instrumented = `${source}\nexport const __heartbeatBenchmarkInternals = {\n  assertBoundedRoomState,\n  playlistItemSignature,\n  serializedCoreStateByteLength,\n  serializedPlaylistStateByteLength,\n  splitPersistentRoomState,\n};\n//# sourceURL=mxqr-heartbeat-benchmark-${label}.mjs\n`;
  return import(`data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`);
}

async function loadBenchmarkModules() {
  const baselineSource = execFileSync(
    'git',
    ['show', `${BASELINE_COMMIT}:cloudflare/pro-room-worker.js`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const currentSource = await readFile(WORKER_PATH, 'utf8');
  return {
    baseline: await loadBenchmarkWorkerModule(baselineSource, 'baseline'),
    current: await loadBenchmarkWorkerModule(currentSource, 'working-tree'),
  };
}

async function createSeed(module) {
  const storage = new FakeStorage();
  const worker = new module.MusixquareProRoom(new FakeState(storage), environment());
  const nowMs = Date.now();
  const claimToken = await module.issueProRoomActivationClaim(ROOM_CODE, ACTIVATION_SECRET, {
    nowMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60_000,
    nonce: 'benchmark-activation-nonce',
  });
  const activation = await worker.fetch(
    jsonRequest('/activation', {
      claimToken,
      temporaryPin: '00000001',
      newPin: '12345678',
      ownerName: 'Benchmark owner',
    }),
  );
  if (!activation.ok) {
    throw new Error(`Benchmark room activation failed with ${activation.status}`);
  }
  const ownerCookie = cookieFrom(activation);
  const activationBody = await activation.json();
  const ownerIdentity = {
    participantId: activationBody.snapshot.viewer.participantId,
    presenceIncarnationId: activationBody.snapshot.viewer.presenceIncarnationId,
  };
  const participants = [{ cookie: ownerCookie, ...ownerIdentity }];
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

async function workerFromSeed(module, seed) {
  const storage = new FakeStorage(seed.data, seed.alarm);
  const worker = new module.MusixquareProRoom(new FakeState(storage), environment());
  if (worker.ready) await worker.ready;
  worker.lastLegacyShadowPersistedAtMs = Date.now();
  worker.scheduledAlarmMs = storage.alarm;
  storage.resetMetrics();
  return { worker, storage };
}

function timedMethod(target, methodName, values) {
  const original = target[methodName].bind(target);
  target[methodName] = async (...args) => {
    const startedAt = performance.now();
    try {
      return await original(...args);
    } finally {
      values.push(performance.now() - startedAt);
    }
  };
  return original;
}

function heartbeatRequest(seed, participantIndex) {
  const participant = seed.participants[participantIndex];
  return jsonRequest('/presence/heartbeat', seed.known, participant.cookie, participant);
}

async function runImmediateBaseline(module, seed) {
  const { worker, storage } = await workerFromSeed(module, seed);
  const timings = { persist: [], alarmScan: [], authenticate: [], prune: [] };
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
    if (responses.some((response) => response.status !== 200)) {
      throw new Error('Baseline heartbeat workload returned a non-200 response');
    }
  }
  return summarizeRun('baseline-immediate-persist', responseElapsedMs, storage, timings, {
    requestedPersists: HEARTBEAT_COUNT,
    durabilityFlushes: timings.persist.length,
    timerDrainMs: 0,
  });
}

async function runHybridCurrent(module, seed) {
  const { worker, storage } = await workerFromSeed(module, seed);
  const timings = { persist: [], alarmScan: [], authenticate: [], prune: [] };
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
    if (responses.some((response) => response.status !== 200)) {
      throw new Error('Hybrid heartbeat workload returned a non-200 response');
    }
    if (worker.pendingHeartbeatFlushGeneration === null) {
      throw new Error('Hybrid heartbeat burst did not schedule its trailing flush');
    }
    const drainStartedAt = performance.now();
    await new Promise((resolve) => setTimeout(resolve, COALESCE_WINDOW_MS + 20));
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

function summarizeRun(name, elapsedMs, storage, timings, extra) {
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
      legacyShadow: {
        calls: storage.metrics.callsByKey['pro-room:v1'] || 0,
        bytes: storage.metrics.bytesByKey['pro-room:v1'] || 0,
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

function measureSync(iterations, operation) {
  for (let index = 0; index < 10; index += 1) operation();
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    operation();
    values.push(performance.now() - startedAt);
  }
  return durationSummary(values);
}

async function measureIsolatedPhases(module, seed) {
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

function theoreticalHybridFlushes(offsetForParticipant) {
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

function sourceCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function workerSourceDirty() {
  try {
    execFileSync('git', ['diff', '--quiet', '--', 'cloudflare/pro-room-worker.js'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return false;
  } catch {
    return true;
  }
}

function ratio(current, candidate) {
  return round(current / Math.max(candidate, Number.EPSILON));
}

function printTable(result) {
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
      value && typeof value === 'object' && 'totalMs' in value
        ? [{ phase, totalMs: value.totalMs, meanMs: value.meanMs, p95Ms: value.p95Ms }]
        : [],
    ),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modules = await loadBenchmarkModules();
  const seed = await createSeed(modules.baseline);
  const baseline = await runImmediateBaseline(modules.baseline, seed);
  const currentHybrid = await runHybridCurrent(modules.current, seed);
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
  const isolatedPhases = await measureIsolatedPhases(modules.current, seed);
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
      worker: 'cloudflare/pro-room-worker.js',
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
}

await main();
