import { expect, vi } from 'vitest';
import {
  ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
  ACCOUNT_ASSERTION_HEADER,
  createAccountAssertion,
} from '../../../../cloudflare/account-assertion.ts';
import { issueProRoomActivationClaim } from '../../../../cloudflare/pro-room-claims.ts';
import {
  MusixquareProRoom,
  MusixquareServiceControl,
} from '../../../../cloudflare/pro-room-worker.ts';
import { updateServiceMaintenance } from '../../../../cloudflare/service-maintenance.ts';
import {
  MemoryDurableObjectStorage,
  SqliteD1,
  createSqlJournal,
  trackedSql,
} from '../../../core/__tests__/helpers/worker-test-bindings.ts';
import {
  SIGNALING_BROADCAST_PATH,
  signalingBroadcastViolations,
} from './signaling-broadcast-contract.ts';

/**
 * Owner-boundary fixture for the PRO room Durable Object (C7-0).
 *
 * The real MusixquareProRoom runs in-process and is driven only through its
 * public surfaces: room HTTP routes, `alarm()`, and the bindings below. Tests
 * observe the platform-visible results: requests the room sends to signaling,
 * R2 range reads, metadata-service calls, the durable `pro-room:v2:core`
 * record and the alarm slot. Nothing inside the PRO room is mocked.
 *
 * Fakes and what they model (calibrated against the cited code):
 * - FencedSignaling models `handleInternalProRealtimeBroadcast` in
 *   cloudflare/signaling-worker.ts: an exact body key set and matching
 *   room-code and generation headers (else 400 and a contract violation that
 *   `dispose()` fails on; see signaling-broadcast-contract.ts), the
 *   coordinator-epoch fence that only a presence
 *   snapshot may advance (any other event for a newer epoch, and any event for
 *   an older one, gets 409 PRO_ROOM_EPOCH_STALE), monotonic presence revisions
 *   per epoch (`advanceProPresenceAuthority`: stale or conflicting snapshots
 *   get 409), and the `{broadcast, eligible, sent}` answer. It does not model
 *   sockets: every target counts as connected, so `sent === eligible ===
 *   targets` unless a fault forces partial fan-out. It does not model the
 *   owner-account deletion fence, decommission tombstones or chat pruning; the
 *   workerd contract suite (pro-room-signaling-contract-workerd.test.ts) runs
 *   the real signaling Worker for the wire-level checks. Faults: `failNext`
 *   and `failAll` (a thrown transport, 503, or partial fan-out) and `hold` (an
 *   answer that waits until released, to tell awaited sends from background
 *   ones).
 * - Time: `installBoundaryClock` fakes Date, setTimeout and clearTimeout, so
 *   no deadline or coalescing timer can fire on the wall clock. The fixture
 *   moves time only through `advanceTo`, `alarmAt` and `runUntil`, which fire
 *   due timers in order. The timer that matters is the heartbeat-durability
 *   flush (`scheduleHeartbeatDurability`): a second heartbeat inside the 1 s
 *   coalescing window is persisted by a timer at the window's end, as in
 *   production. Request deadlines (900 ms broadcast, 2 s registry read, 10 s
 *   duration read) never expire because every fake answers at once, and no
 *   test moves time while an R2 read is parked.
 * - DurationBucket models the R2 calls the room makes: `head`, unranged `get`
 *   (upload completion copy), ranged `get` (duration reads by
 *   `readProRoomFileDuration`), `put`, `delete`, `list`. A presigned client
 *   upload is modelled by `upload()`, which stores the bytes under the key and
 *   metadata the presigned URL names. A ranged read yields one macrotask, as
 *   I/O does, so a read loop (the hot loop the continuation guards prevent)
 *   fails `settle()` instead of starving the test. It does not model R2
 *   latency, multipart uploads or eventual consistency. Faults: `hold()` parks
 *   the next prefix read of a key until released, `fail()` makes ranged reads
 *   of a key throw.
 * - MetadataService models the App Worker's signed `/internal/pro-youtube-duration`
 *   answer (`handleProYouTubeDurationRequest`): it returns the scripted kind.
 *   Fault: `hold()` parks the next answer until released; `settle()` leaves
 *   work behind a parked lookup queued, as for a parked R2 read.
 * - `detachSignaling()` removes the PRO_SIGNALING_ROOMS binding, as in a
 *   Worker deployed without it.
 */

const PRO_ROOM_CODE = '000318';
const OWNER_ACCOUNT_ID = 'acct_BoundaryOwner000000001';
const SECRET = (purpose: string) => `boundary-${purpose}-secret-`.padEnd(48, 'x');
const ACTIVATION_SECRET = SECRET('activation');
const ASSERTION_SECRET = SECRET('assertion');
const OWNER_PIN = '12345678';

type SignalingFault = 'throw' | 503 | 'partial';

export interface SignalingDelivery {
  readonly type: string;
  readonly coordinatorEpoch: number;
  readonly status: number | 'thrown';
  readonly error?: string;
  readonly presenceRevision?: number;
  readonly transitionId?: string;
  /** The event carries a one-shot added-tracks notice (`pro-queue-addition`). */
  readonly addition?: true;
  readonly at: number;
}

class FencedSignaling {
  readonly deliveries: SignalingDelivery[] = [];
  /** Why signaling refused a body (400); `dispose()` fails the test on any. */
  readonly contractViolations: string[] = [];
  private epoch: number | null = null;
  private presence: { epoch: number; revision: number; targets: string } | null = null;
  private readonly faults: Array<{ type: string | null; fault: SignalingFault }> = [];

  /** Fail the next `count` broadcasts of `type` (null = any type). */
  failNext(type: string | null, fault: SignalingFault, count = 1): void {
    for (let index = 0; index < count; index += 1) this.faults.push({ type, fault });
  }

  /** Fail every broadcast of `type` until `restore()`. */
  failAll(type: string | null, fault: SignalingFault): void {
    this.failNext(type, fault, 10_000);
  }

  restore(): void {
    this.faults.length = 0;
  }

  private readonly gates: Array<{
    type: string;
    where: (event: Record<string, unknown>) => boolean;
    arrive: () => void;
    gate: Promise<void>;
  }> = [];

  /**
   * Hold the answer to the next broadcast of `type` whose event matches
   * `where` (a slow signaling call). `reached` resolves once it waits;
   * `release` lets it answer.
   */
  hold(
    type: string,
    where: (event: Record<string, unknown>) => boolean = () => true,
  ): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let arrive!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    this.gates.push({ type, where, arrive, gate });
    return { reached, release };
  }

  types(): string[] {
    return this.deliveries.map((delivery) => delivery.type);
  }

  readonly namespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (request: Request) => this.fetch(request) }),
  };

  private async fetch(request: Request): Promise<Response> {
    expect(new URL(request.url).pathname).toBe(SIGNALING_BROADCAST_PATH);
    const body = (await request.json()) as Record<string, unknown>;
    const event = (body.event ?? {}) as Record<string, unknown>;
    const type = String(event.type);
    const coordinatorEpoch = Number(body.coordinatorEpoch);
    const record = (status: number | 'thrown', error?: string) =>
      this.deliveries.push({
        type,
        coordinatorEpoch,
        status,
        ...(error ? { error } : {}),
        ...(typeof event.presenceRevision === 'number'
          ? { presenceRevision: event.presenceRevision }
          : {}),
        ...(typeof event.transitionId === 'string' ? { transitionId: event.transitionId } : {}),
        ...(event.addition ? { addition: true as const } : {}),
        at: Date.now(),
      });
    const faultIndex = this.faults.findIndex(
      (candidate) => candidate.type === null || candidate.type === type,
    );
    const fault = faultIndex >= 0 ? this.faults.splice(faultIndex, 1)[0]!.fault : null;
    const gateIndex = this.gates.findIndex(
      (candidate) => candidate.type === type && candidate.where(event),
    );
    if (gateIndex >= 0) {
      const [held] = this.gates.splice(gateIndex, 1);
      held!.arrive();
      await held!.gate;
    }
    if (fault === 'throw') {
      record('thrown');
      throw new Error('injected signaling transport failure');
    }
    if (fault === 503) {
      record(503, 'PRO_SIGNALING_ROOM_STATE_UNAVAILABLE');
      return Response.json({ error: 'PRO_SIGNALING_ROOM_STATE_UNAVAILABLE' }, { status: 503 });
    }
    // Signaling rejects any extra or missing body key (hasExactKeys) and a
    // room-code or generation header that disagrees with the body.
    const violations = signalingBroadcastViolations(request, body);
    if (violations.length > 0) {
      this.contractViolations.push(...violations);
      record(400, 'INVALID_REQUEST');
      return Response.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    const stale = () => {
      record(409, 'PRO_ROOM_EPOCH_STALE');
      return Response.json({ error: 'PRO_ROOM_EPOCH_STALE' }, { status: 409 });
    };
    if (this.epoch === null || coordinatorEpoch > this.epoch) {
      if (type !== 'pro-presence-snapshot') return stale();
      this.epoch = coordinatorEpoch;
    }
    if (coordinatorEpoch < this.epoch) return stale();
    const targets = Array.isArray(body.targets) ? (body.targets as string[]) : [];
    if (type === 'pro-presence-snapshot') {
      const revision = Number(event.presenceRevision);
      const current = this.presence;
      if (current && current.epoch === coordinatorEpoch) {
        if (revision < current.revision) {
          record(409, 'PRO_PRESENCE_REVISION_STALE');
          return Response.json({ error: 'PRO_PRESENCE_REVISION_STALE' }, { status: 409 });
        }
        if (revision === current.revision && current.targets !== JSON.stringify(targets)) {
          record(409, 'PRO_PRESENCE_REVISION_CONFLICT');
          return Response.json({ error: 'PRO_PRESENCE_REVISION_CONFLICT' }, { status: 409 });
        }
      }
      this.presence = { epoch: coordinatorEpoch, revision, targets: JSON.stringify(targets) };
    }
    record(200);
    const eligible = targets.length;
    const sent = fault === 'partial' ? Math.max(0, eligible - 1) : eligible;
    return Response.json({ broadcast: true, eligible, sent });
  }
}

interface RangeRead {
  readonly key: string;
  readonly offset: number;
  readonly length: number;
  readonly at: number;
}

interface StoredObject {
  bytes: Uint8Array;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
}

/** `readProRoomFileDuration` opens every read with this prefix range. */
const PROBE_PREFIX_BYTES = 10;

interface Hold {
  readonly gate: Promise<void>;
  readonly arrived: Promise<void>;
  arrive(): void;
}

class DurationBucket {
  readonly objects = new Map<string, StoredObject>();
  readonly rangeReads: RangeRead[] = [];
  private readonly holds = new Map<string, Hold>();
  private readonly failures = new Set<string>();
  /** Reads currently waiting at a hold gate. */
  parkedReads = 0;
  private readonly parkWaiters: Array<() => void> = [];

  /** Resolves when the next read parks (at once if one already waits). */
  nextPark(): Promise<void> {
    if (this.parkedReads > 0) return Promise.resolve();
    return new Promise((resolve) => this.parkWaiters.push(resolve));
  }

  /** Model the browser's presigned PUT to the reserved staging object. */
  upload(url: string, headers: Record<string, string>, bytes: Uint8Array): void {
    const [, , ...segments] = new URL(url).pathname.split('/');
    const key = segments.map((segment) => decodeURIComponent(segment)).join('/');
    const customMetadata: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (name.startsWith('x-amz-meta-')) customMetadata[name.slice(11)] = value;
    }
    this.objects.set(key, {
      bytes,
      httpMetadata: { contentType: headers['content-type'] },
      customMetadata,
    });
  }

  /**
   * Park the next duration read of `key` at its prefix range. `parked`
   * resolves once a read is waiting; `release` lets it continue.
   */
  hold(key: string): { parked: Promise<void>; release: () => void } {
    let release!: () => void;
    let arrive!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    this.holds.set(key, { gate, arrived, arrive });
    return { parked: arrived, release };
  }

  fail(key: string): void {
    this.failures.add(key);
  }

  heal(key: string): void {
    this.failures.delete(key);
  }

  /** One entry per duration read: its prefix range read. */
  probeStarts(key?: string): RangeRead[] {
    return this.rangeReads.filter(
      (read) =>
        read.offset === 0 &&
        read.length === PROBE_PREFIX_BYTES &&
        (key === undefined || read.key === key),
    );
  }

  async head(key: string) {
    const object = this.objects.get(key);
    return object
      ? {
          size: object.bytes.byteLength,
          httpMetadata: { ...object.httpMetadata },
          customMetadata: { ...object.customMetadata },
        }
      : null;
  }

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const range = options?.range;
    if (range) {
      this.rangeReads.push({ key, offset: range.offset, length: range.length, at: Date.now() });
      // R2 is I/O: yield a macrotask, so a read loop cannot starve the test.
      await new Promise((resolve) => setImmediate(resolve));
      const hold =
        range.offset === 0 && range.length === PROBE_PREFIX_BYTES ? this.holds.get(key) : undefined;
      if (hold) {
        this.holds.delete(key);
        this.parkedReads += 1;
        hold.arrive();
        for (const waiter of this.parkWaiters.splice(0)) waiter();
        await hold.gate;
        this.parkedReads -= 1;
      }
      if (this.failures.has(key)) throw new Error('injected R2 read failure');
    }
    const object = this.objects.get(key);
    if (!object) return null;
    const bytes = range
      ? object.bytes.slice(range.offset, range.offset + range.length)
      : object.bytes.slice();
    return {
      size: object.bytes.byteLength,
      httpMetadata: { ...object.httpMetadata },
      customMetadata: { ...object.customMetadata },
      body: new Response(bytes).body!,
    };
  }

  async put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ) {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, {
      bytes,
      httpMetadata: { ...options.httpMetadata },
      customMetadata: { ...options.customMetadata },
    });
  }

  async delete(key: string | string[]) {
    for (const entry of Array.isArray(key) ? key : [key]) this.objects.delete(entry);
  }

  async list(options: { prefix?: string; limit?: number } = {}) {
    const objects = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ''))
      .sort()
      .slice(0, options.limit ?? 1000)
      .map((key) => ({ key }));
    return { objects, truncated: false };
  }
}

/** FLAC bytes whose STREAMINFO declares `seconds` at 44.1 kHz. */
export function flacBytes(seconds: number, byteLength = 4096): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22], 0);
  const rate = 44_100n;
  const packed = (rate << 44n) | (1n << 41n) | (15n << 36n) | BigInt(Math.round(seconds * 44_100));
  new DataView(bytes.buffer).setBigUint64(18, packed);
  return bytes;
}

/** Bytes no duration parser recognizes: a definite "unknown" answer. */
export function unknownBytes(byteLength = 4096): Uint8Array {
  return new Uint8Array(byteLength);
}

export class MetadataService {
  readonly calls: Array<{ videoId: string; at: number }> = [];
  answer: Record<string, unknown> = { kind: 'retry' };
  private held: { gate: Promise<void>; arrive: () => void } | null = null;
  /** Lookups currently waiting at a hold gate. */
  parkedLookups = 0;
  private readonly parkWaiters: Array<() => void> = [];

  /** Resolves when the next lookup parks (at once if one already waits). */
  nextPark(): Promise<void> {
    if (this.parkedLookups > 0) return Promise.resolve();
    return new Promise((resolve) => this.parkWaiters.push(resolve));
  }

  /**
   * Hold the answer to the next lookup (a slow provider). `reached` resolves
   * once it waits; `release` lets it answer.
   */
  hold(): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let arrive!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    this.held = { gate, arrive };
    return { reached, release };
  }

  readonly binding = {
    fetch: async (request: Request) => {
      const videoId = new URL(request.url).searchParams.get('videoId') ?? '';
      this.calls.push({ videoId, at: Date.now() });
      const held = this.held;
      this.held = null;
      if (held) {
        this.parkedLookups += 1;
        held.arrive();
        for (const waiter of this.parkWaiters.splice(0)) waiter();
        await held.gate;
        this.parkedLookups -= 1;
      }
      return Response.json({ videoId, ...this.answer });
    },
  };
}

interface PresenceIdentity {
  participantId: string;
  presenceIncarnationId: string;
}

let idempotencySequence = 0;
let sessionRequestSequence = 0;

/** Fake Date and timers for one test; undo with `vi.useRealTimers()`. */
export function installBoundaryClock(nowMs: number): void {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(nowMs);
}

export async function activatedProRoom(
  options: {
    metadata?: MetadataService;
    presenceTtlSeconds?: number;
    serviceControl?: boolean;
  } = {},
) {
  const signaling = new FencedSignaling();
  const bucket = new DurationBucket();
  const journal = createSqlJournal();
  const admin = new SqliteD1('admin', trackedSql('admin-metrics.schema.sql'), journal);
  const auth = new SqliteD1('auth', trackedSql('auth.schema.sql'), journal);
  const createdAtMs = Date.now() - 60_000;
  admin.database
    .prepare(
      `INSERT INTO mxqr_pro_room_registry
         (room_code, label, status, suspension_reason, activation_state, room_generation,
          created_at, updated_at)
       VALUES (?, 'Boundary fixture', 'registered', NULL, 'unactivated', 0, ?, ?)`,
    )
    .run(PRO_ROOM_CODE, createdAtMs, createdAtMs);
  admin.database
    .prepare(
      `INSERT INTO mxqr_pro_grant_audit (actor_id, action, result, created_at)
       VALUES ('system:entitlement-backfill', 'entitlement.backfill', 'complete', ?)`,
    )
    .run(createdAtMs);
  auth.database
    .prepare(
      `INSERT INTO mxqr_accounts
         (account_id, google_subject_hash, nickname, profile_complete, status, created_at, updated_at)
       VALUES (?, ?, 'Owner', 1, 'active', ?, ?)`,
    )
    .run(OWNER_ACCOUNT_ID, 'h'.repeat(43), createdAtMs, createdAtMs);

  const storage = new MemoryDurableObjectStorage();
  const background: Promise<unknown>[] = [];
  const env: Record<string, unknown> = {
    PRO_ROOM_ACTIVATION_SECRET: ACTIVATION_SECRET,
    PRO_ROOM_PIN_PEPPER: SECRET('pin'),
    PRO_ROOM_SESSION_SECRET: SECRET('session'),
    MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: ASSERTION_SECRET,
    PRO_SIGNALING_SECRET: SECRET('signaling'),
    R2_ACCOUNT_ID: '01353882e4eea3a5acaa0c45e8336af4',
    R2_ACCESS_KEY_ID: 'boundary-access-key',
    R2_SECRET_ACCESS_KEY: 'boundary-secret-key'.padEnd(40, 'k'),
    R2_BUCKET_NAME: 'musixquare-pro-media',
    PRO_MEDIA_BUCKET: bucket,
    PRO_SIGNALING_ROOMS: signaling.namespace,
    MUSIXQUARE_ADMIN_DB: admin,
    MUSIXQUARE_AUTH_DB: auth,
    ...(options.metadata ? { PRO_YOUTUBE_METADATA: options.metadata.binding } : {}),
    ...(options.presenceTtlSeconds
      ? { PRESENCE_TTL_SECONDS: String(options.presenceTtlSeconds) }
      : {}),
  };
  // The real service-control object (maintenance switch), in-process. Its
  // status cache is keyed by this binding, so each fixture starts clean.
  const serviceControl = options.serviceControl
    ? new MusixquareServiceControl({
        id: { name: 'boundary-service-control' },
        storage: new MemoryDurableObjectStorage(),
        blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
      } as never)
    : null;
  if (serviceControl) {
    env.MUSIXQUARE_SERVICE_CONTROL = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => serviceControl.fetch(request) }),
    };
  }
  let maintenanceRevision = 0;
  const workers: MusixquareProRoom[] = [];
  const createWorker = () => {
    const worker = new MusixquareProRoom(
      {
        storage,
        waitUntil: (promise: Promise<unknown>) => {
          background.push(promise);
        },
      } as never,
      env as never,
    );
    workers.push(worker);
    return worker;
  };
  const presence = new Map<string, PresenceIdentity>();

  const context = {
    worker: createWorker(),
    storage,
    signaling,
    bucket,
    metadata: options.metadata,
    admin,
    auth,
    ownerCookie: '',
    cookies: [] as string[],
    /** Cold restart: a new isolate over the same durable storage. */
    restart(): MusixquareProRoom {
      context.worker = createWorker();
      return context.worker;
    },
    /** Remove the PRO_SIGNALING_ROOMS binding (a Worker deployed without it). */
    detachSignaling(): void {
      delete env.PRO_SIGNALING_ROOMS;
    },
    request(path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
      const headers = new Headers(init.headers);
      headers.set('x-mxqr-pro-room-code', PRO_ROOM_CODE);
      headers.set('x-mxqr-pro-room-generation', '0');
      headers.set('x-mxqr-pro-ip-hash', 'boundary-client-address');
      if (cookie) {
        headers.set('cookie', cookie);
        const identity = presence.get(cookie);
        if (identity) {
          headers.set('x-mxqr-pro-participant-id', identity.participantId);
          headers.set('x-mxqr-pro-presence-incarnation', identity.presenceIncarnationId);
        }
      }
      return context.worker.fetch(
        new Request(`https://pro.musixquare.com/v1/rooms/${PRO_ROOM_CODE}${path}`, {
          ...init,
          headers,
        }),
      );
    },
    async json(
      path: string,
      body: unknown,
      cookie?: string,
      method: 'POST' | 'PUT' | 'DELETE' = 'POST',
      idempotent = true,
    ): Promise<Response> {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (idempotent) headers['idempotency-key'] = idempotencyKey();
      return context.request(
        path,
        { method, headers, body: JSON.stringify(body) },
        cookie ?? context.ownerCookie,
      );
    },
    bind(cookie: string, envelope: Record<string, any>): void {
      const viewer = envelope.snapshot?.viewer;
      expect(viewer).toBeTruthy();
      presence.set(cookie, {
        participantId: viewer.participantId,
        presenceIncarnationId: viewer.presenceIncarnationId,
      });
      if (!context.cookies.includes(cookie)) context.cookies.push(cookie);
    },
    /** The device stops heartbeating; its last identity still rides its requests. */
    forget(cookie: string): void {
      context.cookies = context.cookies.filter((candidate: string) => candidate !== cookie);
    },
    async snapshot(cookie?: string): Promise<Record<string, any>> {
      const response = await context.request('/snapshot', {}, cookie ?? context.ownerCookie);
      expect(response.status).toBe(200);
      return ((await response.json()) as Record<string, any>).snapshot;
    },
    /** The durable core record (`pro-room:v2:core`), as storage holds it. */
    storedCore(): Record<string, any> {
      const stored = storage.data.get('pro-room:v2:core') as { core?: Record<string, any> };
      if (!stored?.core) throw new Error('canonical PRO room state is missing');
      return structuredClone(stored.core);
    },
    /**
     * Wait for the room's waitUntil work. Work blocked behind a parked R2 read
     * or metadata lookup cannot finish; it stays queued for the settle after
     * its release.
     */
    async settle(): Promise<void> {
      const pending = new Set<Promise<unknown>>();
      const track = (promise: Promise<unknown>) => {
        pending.add(promise);
        const done = () => pending.delete(promise);
        promise.then(done, done);
      };
      const metadata = options.metadata;
      let parkedTurns = 0;
      for (let round = 0; round < 400; round += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        for (const promise of background.splice(0)) track(promise);
        if (pending.size === 0) return;
        if (bucket.parkedReads > 0 || (metadata?.parkedLookups ?? 0) > 0) {
          parkedTurns += 1;
          if (parkedTurns > 50) {
            background.push(...pending);
            return;
          }
          continue;
        }
        parkedTurns = 0;
        await Promise.race([
          Promise.allSettled([...pending]),
          bucket.nextPark(),
          ...(metadata ? [metadata.nextPark()] : []),
        ]);
      }
      throw new Error('PRO room background work did not settle');
    },
    /**
     * What live clients do between server events: a presence heartbeat per
     * device, and the owner's account lease renewal (120 s lease, renewed by
     * the App with a fresh assertion) so the owner's identity stays stable.
     */
    async heartbeat(): Promise<void> {
      for (const cookie of context.cookies) {
        const response = await context.request('/presence/heartbeat', { method: 'POST' }, cookie);
        expect(response.status).toBe(200);
      }
      if (context.cookies.includes(context.ownerCookie)) {
        const lease = await context.request(
          '/sessions/current/account/lease',
          { method: 'POST', headers: { [ACCOUNT_ASSERTION_HEADER]: await ownerAssertion() } },
          context.ownerCookie,
        );
        expect(lease.status, await lease.clone().text()).toBe(200);
      }
      await context.settle();
    },
    /**
     * Let time pass until `targetMs` the way production does: live devices
     * heartbeat (and the owner renews its lease) every 15 s, and the platform
     * delivers each alarm when due. At an instant with both, the alarm runs
     * first, then the clients.
     */
    async runUntil(targetMs: number): Promise<void> {
      while (Date.now() < targetMs) {
        const heartbeatAt = Date.now() + 15_000;
        const alarm = storage.alarm ?? Number.POSITIVE_INFINITY;
        const next = Math.min(targetMs, heartbeatAt, Math.max(alarm, Date.now()));
        await context.advanceTo(next);
        if (alarm <= next) await context.alarmAt(next);
        if (next === heartbeatAt) await context.heartbeat();
      }
    },
    /**
     * Move the clock to `atMs`, firing the room's due timers (the heartbeat
     * flush) at their own times on the way, then let their work finish.
     */
    async advanceTo(atMs: number): Promise<void> {
      if (atMs > Date.now()) await vi.advanceTimersByTimeAsync(atMs - Date.now());
      await context.settle();
    },
    /** Flip the service-wide maintenance switch through its production API. */
    async setMaintenance(enabled: boolean): Promise<void> {
      const result = await updateServiceMaintenance(
        { MUSIXQUARE_SERVICE_CONTROL: env.MUSIXQUARE_SERVICE_CONTROL } as never,
        {
          enabled,
          expectedRevision: maintenanceRevision,
          requestId: `boundary-maintenance-${maintenanceRevision + 1}`,
        },
      );
      expect(result.status).toBe('ok');
      maintenanceRevision = result.state.revision;
    },
    /** Deliver the platform alarm at `atMs` (Cloudflare clears the slot first). */
    async alarmAt(atMs: number): Promise<void> {
      await context.advanceTo(atMs);
      storage.alarm = null;
      await context.worker.alarm();
      await context.settle();
    },
    async addMember(): Promise<string> {
      const response = await context.request('/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pin: OWNER_PIN,
          requestId: `boundary-session-${String(++sessionRequestSequence).padStart(8, '0')}`,
        }),
      });
      expect(response.status).toBe(200);
      const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]!;
      context.bind(cookie, (await response.json()) as Record<string, any>);
      await context.settle();
      return cookie;
    },
    async leave(cookie: string): Promise<void> {
      const response = await context.request('/presence/current', { method: 'DELETE' }, cookie);
      expect(response.status).toBe(200);
      context.forget(cookie);
      await context.settle();
    },
    /** A departed device returns with its retained session cookie. */
    async enter(cookie: string): Promise<void> {
      const response = await context.request('/presence/enter', { method: 'POST' }, cookie);
      expect(response.status).toBe(200);
      context.bind(cookie, (await response.json()) as Record<string, any>);
      await context.settle();
    },
    async replacePlaylist(items: Array<Record<string, unknown>>): Promise<void> {
      const response = await context.sendPlaylist(items);
      expect(response.status).toBe(200);
      await context.settle();
    },
    /**
     * Send an idle room's whole playlist as a participant compact snapshot,
     * upserting `upserts` (default: every item); the caller awaits the answer.
     */
    async sendPlaylist(
      items: Array<Record<string, unknown>>,
      upserts: Array<Record<string, unknown>> = items,
    ): Promise<Response> {
      const current = await context.snapshot();
      return context.json('/snapshot/compact', {
        baseRevision: current.revision,
        playlistOrder: items.map((item) => item.queueItemId),
        upserts,
        currentQueueItemId: null,
        playback: {
          coordinatorEpoch: current.presence.coordinatorEpoch,
          revision: current.playback.revision,
          state: 'idle',
          queueItemId: null,
          positionSeconds: 0,
          updatedAtMs: Date.now(),
          youtubeVideoId: null,
          youtubeSubIndex: null,
        },
      });
    },
    /** Select a queue item; returns the PREPARE transition. */
    async select(
      queueItemId: string,
      state: 'playing' | 'paused' = 'playing',
    ): Promise<{ transitionId: string; basePlaybackRevision: number }> {
      const current = await context.snapshot();
      const response = await context.json('/playback/commands', {
        type: 'select',
        baseRevision: current.playback.revision,
        queueItemId,
        state,
        positionSeconds: 0,
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as Record<string, any>;
      await context.settle();
      return body.transition as { transitionId: string; basePlaybackRevision: number };
    },
    /** Every present device reports READY for the pending PREPARE. */
    async ready(transition: {
      transitionId: string;
      basePlaybackRevision: number;
    }): Promise<Record<string, any>> {
      let last: Record<string, any> = {};
      for (const cookie of context.cookies) {
        const response = await context.json(
          `/playback/transitions/${transition.transitionId}/ready`,
          { basePlaybackRevision: transition.basePlaybackRevision, status: 'ready' },
          cookie,
          'POST',
          false,
        );
        expect(response.status).toBe(200);
        last = (await response.json()) as Record<string, any>;
      }
      await context.settle();
      return last;
    },
    /**
     * Reserve, upload through the presigned URL, and complete one file. The
     * registration read starts during completion; `beforeComplete` receives
     * the final object key so a test can arm a hold or fault first.
     */
    async uploadFile(
      name: string,
      bytes: Uint8Array,
      options: { beforeComplete?: (objectKey: string) => void } = {},
    ): Promise<{ assetId: string; source: unknown; objectKey: string }> {
      const reserved = await context.json(
        '/media/reservations',
        { byteLength: bytes.byteLength, name: `${name}.flac`, mime: 'audio/flac' },
        context.ownerCookie,
      );
      expect(reserved.status).toBe(200);
      const { reservation } = (await reserved.json()) as Record<string, any>;
      bucket.upload(reservation.upload.url, reservation.upload.headers, bytes);
      const objectKey = context.storedCore().assets[reservation.assetId].objectKey as string;
      options.beforeComplete?.(objectKey);
      const completed = await context.request(
        `/media/${reservation.assetId}/complete`,
        { method: 'POST', headers: { 'idempotency-key': idempotencyKey() } },
        context.ownerCookie,
      );
      expect(completed.status).toBe(200);
      const envelope = (await completed.json()) as Record<string, any>;
      return { assetId: reservation.assetId as string, source: envelope.asset, objectKey };
    },
    dispose(): void {
      for (const worker of workers) {
        worker.clearAlarmMaintenanceRetry();
        worker.invalidatePendingHeartbeatFlush();
      }
      admin.close();
      auth.close();
      // The room catches a refused broadcast as undelivered, so a body outside
      // the signaling contract would otherwise only show up as a retry.
      expect(signaling.contractViolations).toEqual([]);
    },
  };

  const claimToken = await issueProRoomActivationClaim(PRO_ROOM_CODE, ACTIVATION_SECRET, {
    nowMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 60_000,
    nonce: 'boundary-activation-nonce',
  });
  const provision = await context.worker.fetch(
    new Request('https://pro-room.internal/internal/admin/provision', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mxqr-pro-room-code': PRO_ROOM_CODE,
        'x-mxqr-pro-room-generation': '0',
      },
      body: JSON.stringify({ roomGeneration: 0 }),
    }),
  );
  expect(provision.status).toBe(200);
  const activation = await context.request('/activation', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [ACCOUNT_ASSERTION_HEADER]: await ownerAssertion(),
    },
    body: JSON.stringify({
      claimToken,
      temporaryPin: PRO_ROOM_CODE.padStart(8, '0'),
      newPin: OWNER_PIN,
      ownerName: 'Owner',
    }),
  });
  expect(activation.status).toBe(200);
  context.ownerCookie = (activation.headers.get('set-cookie') ?? '').split(';')[0]!;
  context.bind(context.ownerCookie, (await activation.json()) as Record<string, any>);
  await context.settle();
  return context;
}

export type ProRoomBoundary = Awaited<ReturnType<typeof activatedProRoom>>;

async function ownerAssertion(): Promise<string> {
  const assertion = await createAccountAssertion(
    {
      accountId: OWNER_ACCOUNT_ID,
      nickname: 'Owner',
      roomCode: PRO_ROOM_CODE,
      roomGeneration: 0,
      audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
    },
    ASSERTION_SECRET,
  );
  if (!assertion) throw new Error('account assertion unavailable');
  return assertion;
}

function idempotencyKey(): string {
  const sequence = String(++idempotencySequence).padStart(12, '0');
  return `018f977e-5df5-7c8f-bb80-${sequence}`;
}

export function youtubeItem(queueItemId: string, videoId: string): Record<string, unknown> {
  return { queueItemId, name: `Video ${videoId}`, source: { kind: 'youtube', videoId } };
}

export function fileItem(queueItemId: string, source: unknown): Record<string, unknown> {
  return { queueItemId, name: 'Uploaded file', source };
}
