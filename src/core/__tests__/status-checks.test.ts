import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateIncomingMessage } from '../../../cloudflare/signaling-protocol.ts';
import {
  runStatusServerChecks,
  type StatusBridgeCall,
  type StatusBridgeOperation,
  type StatusBridgePort,
  type StatusCheckWarnEvent,
  type StatusCheckWarnFields,
  type StatusProBootstrapAnswer,
  type StatusServerCheckDeps,
} from '../../../cloudflare/status-checks.ts';
import {
  STATUS_CHECK_RETRY_DELAY_MS,
  STATUS_PRO_PROBE_ROOM_CODE,
  STATUS_RESULT_RETENTION_MS,
  STATUS_ROOMS_CHECK_DEADLINE_MS,
  STATUS_ROOMS_CODE_ATTEMPTS,
  STATUS_ROOMS_FRAME_WAIT_MS,
  STATUS_ROOMS_POLL_WAIT_MS,
  isStatusReason,
  statusSlotAt,
  type StatusCheckRow,
  type StatusProbeClaimOutcome,
} from '../../../cloudflare/status-contract.ts';
import { claimStatusProbeRoom } from '../../../cloudflare/status-probe-claim.ts';

/**
 * The status cron's server checks (cloudflare/status-checks.ts, registry
 * record RO-57) against fake dependencies on fake time. The fake signaling
 * bridge answers each frame the way MusixquareRoom answers it, and every
 * frame the check sends must pass the room's own validation
 * (validateIncomingMessage), so a frame-shape drift fails here first.
 */

type Json = Record<string, unknown>;

interface FakeStub {
  readonly namespace: string;
  readonly sessionId: string;
}

/** A server slot of the status cron, and the run that starts just after it. */
const SLOT = Date.UTC(2026, 10, 26, 12, 15);
const STARTED = SLOT + 750;
const APP_BUILD = 845;
// Stand-ins for the App Worker's bridge timeouts, which arrive with the port.
const CALL_TIMEOUT_MS = 4_321;
const POLL_TIMEOUT_MS = 17_654;
// Synthetic room codes, in the order randomRoomId hands them out.
const CODES = ['123456', '234567', '345678', '456789', '567890', '678901'];
const CANARY = {
  roomCode: STATUS_PRO_PROBE_ROOM_CODE,
  status: 'activation_required',
  passwordRequired: true,
};
const SESSION_ID_RE = /^[A-Za-z0-9_-]{32}$/;
const GENERATION_RE = /^[A-Za-z0-9_-]{22}$/;
const NEVER = () => new Promise<never>(() => undefined);

function bytesOf(payload: unknown): Uint8Array {
  return new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function answer(status: number, payload: unknown): StatusBridgeCall {
  return { upstream: { response: { status }, bytes: bytesOf(payload) } };
}

function proAnswer(status: number, payload: unknown): StatusProBootstrapAnswer {
  return { status, bytes: bytesOf(payload) };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relayed(frame: Json, from: string): Json {
  const copy: Json = { ...frame, from };
  delete copy.to;
  return copy;
}

interface FakeSession {
  readonly sessionId: string;
  readonly roomId: string;
  readonly role: string;
  readonly peerId: string;
  /** Frames the check sent, parsed. */
  readonly sent: Json[];
  /** Frames for the check, kept until a poll acknowledges them. */
  outbox: Array<{ readonly sseq: number; readonly data: string }>;
  nextSseq: number;
  terminal: boolean;
}

interface FakeCall {
  readonly operation: StatusBridgeOperation;
  readonly body: Json;
  readonly timeoutMs: number;
  readonly stubSessionId: string;
  readonly session: FakeSession;
}

/**
 * The signaling bridge and room as the check sees them: one bridge session per
 * session id, frames answered as MusixquareRoom answers them, and polls that
 * wait their waitMs when nothing is queued.
 */
class FakeSignaling {
  /** Every call the port was asked for, thrown or not. */
  readonly attempts: Array<{
    readonly operation: StatusBridgeOperation;
    readonly sessionId: string;
  }> = [];
  /** The calls that reached the fake. */
  readonly calls: FakeCall[] = [];
  readonly sessions = new Map<string, FakeSession>();
  readonly log: string[];
  /** Answers a call instead of the fake; undefined lets the fake answer. */
  intercept: (call: FakeCall) => StatusBridgeCall | Promise<StatusBridgeCall> | undefined = () =>
    undefined;
  /** Handles a frame the check sent instead of the fake room; true when it did. */
  react: (frame: Json, session: FakeSession) => boolean = () => false;
  /** Makes the port's stub, or its call for one operation, throw synchronously. */
  throwOn: StatusBridgeOperation | 'stub' | null = null;

  constructor(log: string[]) {
    this.log = log;
  }

  port(): StatusBridgePort<string, FakeStub> {
    return {
      namespace: 'PRO_SIGNALING_ROOMS',
      stub: (namespace, sessionId) => {
        if (this.throwOn === 'stub') throw new Error('stub unavailable');
        return { namespace, sessionId };
      },
      call: (stub, operation, body, timeoutMs) => {
        this.attempts.push({ operation, sessionId: stub.sessionId });
        if (this.throwOn === operation) throw new Error('binding unavailable');
        return this.call(stub, operation, body, timeoutMs);
      },
      callTimeoutMs: CALL_TIMEOUT_MS,
      pollTimeoutMs: POLL_TIMEOUT_MS,
    };
  }

  deliver(session: FakeSession, frame: Json): void {
    session.outbox.push({ sseq: session.nextSseq, data: JSON.stringify(frame) });
    session.nextSseq += 1;
  }

  /** The newest session of a role in a room, optionally with one peer id. */
  member(roomId: string, role: string, peerId?: string): FakeSession | undefined {
    return [...this.sessions.values()]
      .reverse()
      .find(
        (session) =>
          session.roomId === roomId &&
          session.role === role &&
          (peerId === undefined || session.peerId === peerId),
      );
  }

  private session(stub: FakeStub, body: Json): FakeSession {
    let session = this.sessions.get(stub.sessionId);
    if (!session) {
      session = {
        sessionId: String(body.sessionId),
        roomId: String(body.roomId),
        role: String(body.role),
        peerId: String(body.peerId),
        sent: [],
        outbox: [],
        nextSseq: 1,
        terminal: false,
      };
      this.sessions.set(stub.sessionId, session);
    }
    return session;
  }

  private async call(
    stub: FakeStub,
    operation: StatusBridgeOperation,
    body: Json,
    timeoutMs: number,
  ): Promise<StatusBridgeCall> {
    const session = this.session(stub, body);
    const call: FakeCall = { operation, body, timeoutMs, stubSessionId: stub.sessionId, session };
    this.calls.push(call);
    this.log.push(`${operation}:${session.role}:${session.roomId}`);
    const intercepted = this.intercept(call);
    if (intercepted !== undefined) return intercepted;
    const request = (body.request ?? {}) as Json;
    if (operation === 'send') {
      const frame = JSON.parse(String(request.frame)) as Json;
      session.sent.push(frame);
      if (!this.react(frame, session)) this.answerFrame(frame, session);
      return answer(200, { v: 1, ack: request.cseq });
    }
    if (operation === 'poll') {
      session.outbox = session.outbox.filter((event) => event.sseq > Number(request.ack));
      if (session.outbox.length === 0 && !session.terminal) await wait(Number(request.waitMs));
      return answer(200, {
        v: 1,
        events: session.outbox,
        ...(session.terminal ? { terminal: { code: 1011, reason: '' } } : {}),
      });
    }
    return answer(200, { ok: true });
  }

  /** MusixquareRoom's answers to a passwordless room's host, guest and relay. */
  private answerFrame(frame: Json, session: FakeSession): void {
    if (frame.type === 'host-auth') {
      this.deliver(session, {
        type: 'peer-open',
        peerId: session.roomId,
        roomId: session.roomId,
        roomPasswordMutationId: frame.pinMutationId,
        roomPasswordApplied: true,
      });
    } else if (frame.type === 'room-password-set') {
      this.deliver(session, {
        type: 'room-password-result',
        mutationId: frame.pinMutationId,
        applied: true,
      });
    } else if (frame.type === 'guest-auth') {
      this.deliver(session, { type: 'peer-open', peerId: session.peerId, roomId: session.roomId });
    } else if (frame.type === 'signal-offer') {
      const host = this.member(session.roomId, 'host');
      if (host) this.deliver(host, relayed(frame, session.peerId));
    } else if (frame.type === 'signal-answer') {
      const guest = this.member(session.roomId, 'guest', String(frame.to));
      if (guest) this.deliver(guest, relayed(frame, session.peerId));
    }
  }
}

function harness(overrides: Partial<StatusServerCheckDeps<string, FakeStub>> = {}) {
  const log: string[] = [];
  const nonces: string[] = [];
  const roomIds: string[] = [];
  const rows: StatusCheckRow[] = [];
  const recordedAt: number[] = [];
  const prunes: Array<{ readonly beforeMs: number; readonly at: number }> = [];
  const codes = [...CODES];
  const fake = new FakeSignaling(log);
  const record = vi.fn(async (batch: readonly StatusCheckRow[]) => {
    recordedAt.push(Date.now());
    rows.push(...batch);
  });
  const prune = vi.fn(async (beforeMs: number) => {
    prunes.push({ beforeMs, at: Date.now() });
  });
  const readServedAppBuild = vi.fn(async (): Promise<number | null> => APP_BUILD);
  const claim = vi.fn(async (_roomId: string): Promise<StatusProbeClaimOutcome> => 'claimed');
  const fetchProBootstrap = vi.fn(
    async (_appBuild: number): Promise<StatusProBootstrapAnswer | null> => proAnswer(200, CANARY),
  );
  const sleep = vi.fn((ms: number) => wait(ms));
  const warn = vi.fn((_event: StatusCheckWarnEvent, _fields: StatusCheckWarnFields) => undefined);
  const randomRoomId = vi.fn(() => {
    const roomId = codes.shift() ?? '789012';
    roomIds.push(roomId);
    return roomId;
  });
  const deps: StatusServerCheckDeps<string, FakeStub> = {
    nowMs: () => Date.now(),
    scheduledTimeMs: SLOT,
    maintenance: { enabled: false },
    record,
    prune,
    readServedAppBuild,
    claim: (roomId) => {
      log.push(`claim:${roomId}`);
      return claim(roomId);
    },
    bridge: fake.port(),
    randomNonce: (byteLength) => {
      const nonce = randomBytes(byteLength).toString('base64url');
      nonces.push(nonce);
      return nonce;
    },
    randomRoomId,
    fetchProBootstrap,
    sleep,
    warn,
    ...overrides,
  };
  return {
    deps,
    fake,
    log,
    nonces,
    roomIds,
    rows,
    recordedAt,
    prunes,
    record,
    prune,
    readServedAppBuild,
    claim,
    fetchProBootstrap,
    sleep,
    warn,
    randomRoomId,
  };
}

type Harness = ReturnType<typeof harness>;

/** Starts a run; settled() turns true when it settles. */
function start(deps: StatusServerCheckDeps<string, FakeStub>) {
  let settled = false;
  const done = runStatusServerChecks(deps).then(() => {
    settled = true;
  });
  return { done, settled: () => settled };
}

/** Runs the checks to the end on fake time and returns the fake milliseconds they took. */
async function run(deps: StatusServerCheckDeps<string, FakeStub>): Promise<number> {
  const startedAt = Date.now();
  const running = start(deps);
  while (!running.settled()) {
    if (Date.now() - startedAt > 2 * STATUS_ROOMS_CHECK_DEADLINE_MS) {
      throw new Error('the status checks never settled');
    }
    await vi.advanceTimersByTimeAsync(10);
  }
  await running.done;
  return Date.now() - startedAt;
}

/** The recorded rows by component; a component never gets two. */
function rowsOf(h: Harness): Partial<Record<string, StatusCheckRow>> {
  const byComponent: Partial<Record<string, StatusCheckRow>> = {};
  for (const row of h.rows) {
    expect(byComponent[row.component]).toBeUndefined();
    byComponent[row.component] = row;
  }
  return byComponent;
}

function expectRow(row: StatusCheckRow | undefined, result: string, reason: string): void {
  expect(row).toEqual({
    component: expect.any(String),
    slotAt: SLOT,
    result,
    reason,
    checkedAt: expect.any(Number),
    source: 'cron',
    runId: null,
  });
  expect(isStatusReason(reason)).toBe(true);
}

/** Every bridge session the check opened (or tried to) was closed. */
function expectEverySessionClosed(h: Harness): void {
  const sessionsOf = (operation: StatusBridgeOperation) =>
    new Set(
      h.fake.attempts
        .filter((attempt) => attempt.operation === operation)
        .map((attempt) => attempt.sessionId),
    );
  expect(sessionsOf('close')).toEqual(sessionsOf('open'));
}

/** The fake room answers the frames of one type with these frames instead, then may close. */
function answerWith(
  h: Harness,
  type: string,
  replies: (frame: Json, session: FakeSession) => Json[],
  close = false,
): void {
  h.fake.react = (frame, session) => {
    if (frame.type !== type) return false;
    for (const reply of replies(frame, session)) h.fake.deliver(session, reply);
    if (close) session.terminal = true;
    return true;
  };
}

function interceptPolls(
  h: Harness,
  reply: () => StatusBridgeCall | Promise<StatusBridgeCall>,
): void {
  h.fake.intercept = (call) => (call.operation === 'poll' ? reply() : undefined);
}

/**
 * Claims through the App's own claim (cloudflare/status-probe-claim.ts): the
 * room object of a code in refusals answers 409 with that body, and every
 * other room object stores the claim.
 */
function claimOnRoomObjects(h: Harness, refusals: Readonly<Record<string, unknown>>): void {
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => id,
  };
  h.claim.mockImplementation((roomId) =>
    claimStatusProbeRoom({
      namespace,
      roomId,
      fetchBounded: async (stub) =>
        Object.hasOwn(refusals, stub)
          ? { response: { status: 409 }, bytes: bytesOf(refusals[stub]) }
          : { response: { status: 200 }, bytes: bytesOf({ ok: true }) },
    }),
  );
}

/** The fake room refuses host-auth on one code with id-taken, as for a room just taken. */
function hostIdTakenOn(h: Harness, roomId: string): void {
  h.fake.react = (frame, session) => {
    if (frame.type !== 'host-auth' || session.roomId !== roomId) return false;
    h.fake.deliver(session, {
      type: 'error',
      errorType: 'id-taken',
      message: 'ROOM_ALREADY_ACTIVE',
    });
    session.terminal = true;
    return true;
  };
}

describe('status server checks', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: STARTED });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records rooms and pro as passing in the server slot, claiming before any bridge call and closing both sessions', async () => {
    const h = harness();
    await run(h.deps);

    expect(statusSlotAt(STARTED, 'server')).toBe(SLOT);
    const rows = rowsOf(h);
    expect(Object.keys(rows).sort()).toEqual(['pro', 'rooms']);
    expectRow(rows.rooms, 'o', 'passing');
    expectRow(rows.pro, 'o', 'passing');
    h.rows.forEach((row, index) => {
      expect(row.checkedAt).toBeGreaterThanOrEqual(STARTED);
      expect(row.checkedAt).toBeLessThanOrEqual(h.recordedAt[index]!);
    });

    const code = CODES[0];
    expect(h.log).toEqual([
      `claim:${code}`,
      `open:host:${code}`,
      `send:host:${code}`,
      `poll:host:${code}`,
      `send:host:${code}`,
      `poll:host:${code}`,
      `open:guest:${code}`,
      `send:guest:${code}`,
      `poll:guest:${code}`,
      `send:guest:${code}`,
      `poll:host:${code}`,
      `send:host:${code}`,
      `poll:guest:${code}`,
      `close:guest:${code}`,
      `close:host:${code}`,
    ]);
    expectEverySessionClosed(h);
    expect(h.fetchProBootstrap).toHaveBeenCalledExactlyOnceWith(APP_BUILD);
    expect(h.prunes).toHaveLength(1);
    const [pruned] = h.prunes;
    expect(pruned!.beforeMs).toBe(pruned!.at - STATUS_RESULT_RETENTION_MS);
    expect(pruned!.at).toBeGreaterThanOrEqual(Math.max(...h.recordedAt));
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends only frames the signaling room accepts, in the App Worker bridge envelopes', async () => {
    const h = harness();
    await run(h.deps);

    const host = h.fake.member(CODES[0]!, 'host')!;
    const guest = h.fake.member(CODES[0]!, 'guest')!;
    expect(host.sent.map((frame) => frame.type)).toEqual([
      'host-auth',
      'room-password-set',
      'signal-answer',
    ]);
    expect(guest.sent.map((frame) => frame.type)).toEqual(['guest-auth', 'signal-offer']);
    const [hostAuth, pinEcho, signalAnswer] = host.sent;
    const [guestAuth, signalOffer] = guest.sent;
    expect(hostAuth).toEqual({
      type: 'host-auth',
      secret: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      desiredRoomPassword: '',
      pinMutationId: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      appBuild: APP_BUILD,
    });
    expect(pinEcho).toEqual({
      type: 'room-password-set',
      password: '',
      pinMutationId: hostAuth!.pinMutationId,
    });
    expect(guestAuth).toEqual({
      type: 'guest-auth',
      password: '',
      reconnectSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      appBuild: APP_BUILD,
    });
    expect(signalOffer).toEqual({
      type: 'signal-offer',
      to: 'host',
      negotiationId: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/),
      sdp: { type: 'offer', sdp: expect.any(String) },
      metadata: { statusCheck: true },
    });
    expect(signalAnswer).toEqual({
      type: 'signal-answer',
      to: guest.peerId,
      negotiationId: signalOffer!.negotiationId,
      sdp: { type: 'answer', sdp: expect.any(String) },
    });
    // The room's own first-frame and message validation admits each of them.
    expect(validateIncomingMessage(hostAuth, 'host-pending')).toBe('valid');
    expect(validateIncomingMessage(pinEcho, 'host')).toBe('valid');
    expect(validateIncomingMessage(guestAuth, 'pending')).toBe('valid');
    expect(validateIncomingMessage(signalOffer, 'guest')).toBe('valid');
    expect(validateIncomingMessage(signalAnswer, 'host')).toBe('valid');
    expect(host.peerId).not.toBe(guest.peerId);
    expect(hostAuth!.secret).not.toBe(hostAuth!.pinMutationId);

    for (const session of [host, guest]) {
      const calls = h.fake.calls.filter((call) => call.session === session);
      expect(calls[0]?.operation).toBe('open');
      expect(calls.at(-1)?.operation).toBe('close');
      expect(session.sessionId).toMatch(SESSION_ID_RE);
      let cseq = 0;
      let requestEpoch = 0;
      for (const call of calls) {
        const { request, ...envelope } = call.body;
        expect(envelope).toEqual({
          v: 1,
          sessionId: session.sessionId,
          generation: expect.stringMatching(GENERATION_RE),
          roomId: CODES[0],
          role: session.role,
          peerId: session.peerId,
        });
        expect(call.stubSessionId).toBe(session.sessionId);
        expect(call.timeoutMs).toBe(call.operation === 'poll' ? POLL_TIMEOUT_MS : CALL_TIMEOUT_MS);
        if (call.operation === 'send') {
          cseq += 1;
          expect(request).toEqual({ v: 1, cseq, frame: expect.any(String) });
        } else if (call.operation === 'poll') {
          requestEpoch += 1;
          // Each poll here returns one frame, which the next poll acknowledges.
          expect(request).toEqual({
            v: 1,
            requestEpoch,
            ack: requestEpoch - 1,
            waitMs: STATUS_ROOMS_POLL_WAIT_MS,
          });
        } else {
          expect('request' in call.body).toBe(false);
        }
      }
      expect(new Set(calls.map((call) => call.body.generation)).size).toBe(1);
    }
  });

  it.each([
    ['enabled', { enabled: true }],
    ['enabled with the control plane readable', { enabled: true, controlUnavailable: false }],
  ])(
    'marks both rows maintenance and claims, opens and reads nothing while maintenance is %s',
    async (_label, maintenance) => {
      const h = harness({ maintenance });
      await run(h.deps);

      expect(h.record).toHaveBeenCalledTimes(1);
      expect(h.rows).toEqual([
        {
          component: 'rooms',
          slotAt: SLOT,
          result: 'm',
          reason: 'maintenance',
          checkedAt: STARTED,
          source: 'cron',
          runId: null,
        },
        {
          component: 'pro',
          slotAt: SLOT,
          result: 'm',
          reason: 'maintenance',
          checkedAt: STARTED,
          source: 'cron',
          runId: null,
        },
      ]);
      expect(h.readServedAppBuild).not.toHaveBeenCalled();
      expect(h.claim).not.toHaveBeenCalled();
      expect(h.fake.attempts).toEqual([]);
      expect(h.fetchProBootstrap).not.toHaveBeenCalled();
      expect(h.prunes).toEqual([{ beforeMs: STARTED - STATUS_RESULT_RETENTION_MS, at: STARTED }]);
      expect(h.warn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('runs both checks during a control-plane outage, which is not maintenance', async () => {
    const h = harness({ maintenance: { enabled: true, controlUnavailable: true } });
    await run(h.deps);

    const rows = rowsOf(h);
    expectRow(rows.rooms, 'o', 'passing');
    expectRow(rows.pro, 'o', 'passing');
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.fetchProBootstrap).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['record', { record: null }],
    ['prune', { prune: null }],
    ['record during maintenance', { record: null, maintenance: { enabled: true } }],
  ] as const)('does nothing at all without the admin DB (%s missing)', async (_label, missing) => {
    const h = harness(missing);
    await expect(runStatusServerChecks(h.deps)).resolves.toBeUndefined();

    expect(h.record).not.toHaveBeenCalled();
    expect(h.prune).not.toHaveBeenCalled();
    expect(h.readServedAppBuild).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.fake.attempts).toEqual([]);
    expect(h.fetchProBootstrap).not.toHaveBeenCalled();
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records no rooms row and opens no bridge session when signaling has no claim route', async () => {
    const h = harness();
    h.claim.mockResolvedValue('unsupported');
    await run(h.deps);

    expect(Object.keys(rowsOf(h))).toEqual(['pro']);
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.fake.attempts).toEqual([]);
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.warn.mock.calls).toEqual([['status_probe_unsupported', { component: 'rooms' }]]);
  });

  it.each([
    ['maintenance', 'm', 'maintenance', 1],
    ['control_unavailable', 'p', 'control_unavailable', 2],
    ['failed', 'p', 'claim_failed', 2],
  ] as const)(
    'maps a %s claim to %s %s without opening a bridge session',
    async (outcome, result, reason, claims) => {
      const h = harness();
      h.claim.mockResolvedValue(outcome);
      await run(h.deps);

      expectRow(rowsOf(h).rooms, result, reason);
      expect(h.claim).toHaveBeenCalledTimes(claims);
      expect(h.roomIds).toEqual(CODES.slice(0, claims));
      expect(h.sleep).toHaveBeenCalledTimes(claims - 1);
      expect(h.fake.attempts).toEqual([]);
    },
  );

  it('counts a claim that rejects as claim_failed after one retry', async () => {
    const h = harness();
    h.claim.mockRejectedValue(new Error('service binding failed'));
    await run(h.deps);

    expectRow(rowsOf(h).rooms, 'p', 'claim_failed');
    expect(h.claim).toHaveBeenCalledTimes(2);
  });

  it('moves to another code when the claimed room is active or its host meets id-taken', async () => {
    const h = harness();
    const [busy, taken, free] = CODES;
    h.claim.mockImplementation(async (roomId) => (roomId === busy ? 'room_active' : 'claimed'));
    hostIdTakenOn(h, taken!);
    await run(h.deps);

    expectRow(rowsOf(h).rooms, 'o', 'passing');
    expect(h.log.filter((entry) => /^(?:claim|open):/.test(entry))).toEqual([
      `claim:${busy}`,
      `claim:${taken}`,
      `open:host:${taken}`,
      `claim:${free}`,
      `open:host:${free}`,
      `open:guest:${free}`,
    ]);
    expectEverySessionClosed(h);
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('fails with room_codes_busy, and no retry, when every code it tries is active', async () => {
    const h = harness();
    h.claim.mockResolvedValue('room_active');
    await run(h.deps);

    expectRow(rowsOf(h).rooms, 'p', 'room_codes_busy');
    expect(h.claim).toHaveBeenCalledTimes(STATUS_ROOMS_CODE_ATTEMPTS);
    expect(h.fake.attempts).toEqual([]);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  describe('with the App claim on the room objects', () => {
    it('moves to another code on any 409 of a room object, a quarantined room included', async () => {
      const h = harness();
      const [quarantined, refused, free] = CODES;
      claimOnRoomObjects(h, {
        [quarantined!]: { error: 'ROOM_STATE_INVALID' },
        [refused!]: { error: 'ROOM_REFUSED_BY_A_LATER_SIGNALING' },
      });
      await run(h.deps);

      expectRow(rowsOf(h).rooms, 'o', 'passing');
      expect(h.log.filter((entry) => /^(?:claim|open):/.test(entry))).toEqual([
        `claim:${quarantined}`,
        `claim:${refused}`,
        `claim:${free}`,
        `open:host:${free}`,
        `open:guest:${free}`,
      ]);
      expectEverySessionClosed(h);
      expect(h.sleep).not.toHaveBeenCalled();
      expect(h.warn).not.toHaveBeenCalled();
    });

    it('fails with room_codes_busy, and no retry, when the room objects refuse every code', async () => {
      const h = harness();
      const bodies: unknown[] = [{ error: 'ROOM_STATE_INVALID' }, { error: 'ROOM_ACTIVE' }, ''];
      claimOnRoomObjects(
        h,
        Object.fromEntries(CODES.map((code, index) => [code, bodies[index % bodies.length]])),
      );
      await run(h.deps);

      const rows = rowsOf(h);
      expectRow(rows.rooms, 'p', 'room_codes_busy');
      expectRow(rows.pro, 'o', 'passing');
      expect(h.roomIds).toEqual(CODES.slice(0, STATUS_ROOMS_CODE_ATTEMPTS));
      expect(h.fake.attempts).toEqual([]);
      expect(h.sleep).not.toHaveBeenCalled();
      expect(h.warn.mock.calls).toEqual([
        ['status_check_failed', { component: 'rooms', reason: 'room_codes_busy' }],
      ]);
    });

    it('counts refused claims and an id-taken host alike toward room_codes_busy', async () => {
      const h = harness();
      const [quarantined, taken, ...active] = CODES.slice(0, STATUS_ROOMS_CODE_ATTEMPTS);
      claimOnRoomObjects(h, {
        [quarantined!]: { error: 'ROOM_STATE_INVALID' },
        ...Object.fromEntries(active.map((code) => [code, { error: 'ROOM_ACTIVE' }])),
      });
      hostIdTakenOn(h, taken!);
      await run(h.deps);

      expectRow(rowsOf(h).rooms, 'p', 'room_codes_busy');
      expect(h.log.filter((entry) => /^(?:claim|open|close):/.test(entry))).toEqual([
        `claim:${quarantined}`,
        `claim:${taken}`,
        `open:host:${taken}`,
        `close:host:${taken}`,
        ...active.map((code) => `claim:${code}`),
      ]);
      expectEverySessionClosed(h);
      expect(h.sleep).not.toHaveBeenCalled();
      expect(h.warn.mock.calls).toEqual([
        ['status_check_failed', { component: 'rooms', reason: 'room_codes_busy' }],
      ]);
    });
  });

  it('fails with host_timeout when peer-open never comes, after one retry on a fresh code', async () => {
    const h = harness();
    answerWith(h, 'host-auth', () => []);
    const elapsedMs = await run(h.deps);

    expectRow(rowsOf(h).rooms, 'p', 'host_timeout');
    expectRow(rowsOf(h).pro, 'o', 'passing');
    expect(h.roomIds).toEqual([CODES[0], CODES[1]]);
    expect(h.sleep.mock.calls).toEqual([[STATUS_CHECK_RETRY_DELAY_MS]]);
    // Each wait ends after exactly STATUS_ROOMS_FRAME_WAIT_MS, in polls no longer
    // than STATUS_ROOMS_POLL_WAIT_MS.
    for (const roomId of [CODES[0]!, CODES[1]!]) {
      const waits = h.fake.calls
        .filter((call) => call.operation === 'poll' && call.session.roomId === roomId)
        .map((call) => Number((call.body.request as Json).waitMs));
      expect(waits.every((ms) => Number.isSafeInteger(ms) && ms > 0)).toBe(true);
      expect(Math.max(...waits)).toBe(STATUS_ROOMS_POLL_WAIT_MS);
      expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(STATUS_ROOMS_FRAME_WAIT_MS);
    }
    expect(elapsedMs).toBeGreaterThanOrEqual(
      2 * STATUS_ROOMS_FRAME_WAIT_MS + STATUS_CHECK_RETRY_DELAY_MS,
    );
    expect(elapsedMs).toBeLessThan(STATUS_ROOMS_CHECK_DEADLINE_MS);
    expect(h.warn.mock.calls).toEqual([
      ['status_check_retry', { component: 'rooms', reason: 'host_timeout' }],
      ['status_check_failed', { component: 'rooms', reason: 'host_timeout' }],
    ]);
    expectEverySessionClosed(h);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries once after a 5xx and records the passing retry', async () => {
    const h = harness();
    let opens = 0;
    h.fake.intercept = (call) => {
      if (call.operation !== 'open') return undefined;
      opens += 1;
      return opens === 1
        ? answer(502, { error: 'STANDARD_HTTP_BRIDGE_UPSTREAM_REJECTED' })
        : undefined;
    };
    h.fetchProBootstrap.mockResolvedValueOnce(
      proAnswer(503, { error: 'SERVICE_MAINTENANCE_STATUS_UNAVAILABLE', maintenance: true }),
    );
    await run(h.deps);

    const rows = rowsOf(h);
    expectRow(rows.rooms, 'o', 'passing');
    expectRow(rows.pro, 'o', 'passing');
    expect(h.roomIds).toEqual([CODES[0], CODES[1]]);
    expect(h.fetchProBootstrap).toHaveBeenCalledTimes(2);
    expect(h.sleep.mock.calls).toEqual([
      [STATUS_CHECK_RETRY_DELAY_MS],
      [STATUS_CHECK_RETRY_DELAY_MS],
    ]);
    expect(h.warn).toHaveBeenCalledTimes(2);
    expect(h.warn.mock.calls).toEqual(
      expect.arrayContaining([
        ['status_check_retry', { component: 'rooms', reason: 'host_open_failed', httpStatus: 502 }],
        ['status_check_retry', { component: 'pro', reason: 'pro_http_503', httpStatus: 503 }],
      ]),
    );
    expectEverySessionClosed(h);
  });

  it('does not retry a definite refusal', async () => {
    const h = harness();
    answerWith(
      h,
      'host-auth',
      () => [{ type: 'error', errorType: 'room-full', message: 'HOST_PENDING_LIMIT_REACHED' }],
      true,
    );
    h.fetchProBootstrap.mockResolvedValue(
      proAnswer(426, { error: 'APP_UPDATE_REQUIRED', minAppBuild: 900 }),
    );
    await run(h.deps);

    const rows = rowsOf(h);
    expectRow(rows.rooms, 'p', 'host_refused');
    expectRow(rows.pro, 'p', 'pro_update_required');
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.fetchProBootstrap).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
    expectEverySessionClosed(h);
  });

  it.each([
    [
      'an error frame for host-auth',
      (h: Harness) =>
        answerWith(h, 'host-auth', () => [{ type: 'error', errorType: 'room-full' }], true),
      'host_refused',
      false,
    ],
    [
      'a host peer-open without the applied PIN',
      (h: Harness) =>
        answerWith(h, 'host-auth', (_frame, session) => [
          { type: 'peer-open', peerId: session.roomId, roomId: session.roomId },
        ]),
      'host_refused',
      false,
    ],
    [
      'a server close before peer-open',
      (h: Harness) => answerWith(h, 'host-auth', () => [], true),
      'host_refused',
      true,
    ],
    [
      'a 4xx bridge open',
      (h: Harness) => {
        h.fake.intercept = (call) =>
          call.operation === 'open'
            ? answer(409, { error: 'STANDARD_HTTP_BRIDGE_CLOSED' })
            : undefined;
      },
      'host_open_failed',
      false,
    ],
    [
      'no answer to the bridge open',
      (h: Harness) => {
        h.fake.intercept = (call) => (call.operation === 'open' ? { upstream: null } : undefined);
      },
      'host_open_failed',
      true,
    ],
    [
      'a bridge open that throws',
      (h: Harness) => {
        h.fake.throwOn = 'open';
      },
      'host_open_failed',
      true,
    ],
    [
      'a bridge stub that throws',
      (h: Harness) => {
        h.fake.throwOn = 'stub';
      },
      'host_open_failed',
      true,
    ],
    [
      'an ack for another frame',
      (h: Harness) => {
        h.fake.intercept = (call) =>
          call.operation === 'send' ? answer(200, { v: 1, ack: 99 }) : undefined;
      },
      'host_open_failed',
      false,
    ],
    [
      'a 5xx poll',
      (h: Harness) =>
        interceptPolls(h, () => answer(503, { error: 'STANDARD_HTTP_BRIDGE_UNAVAILABLE' })),
      'host_open_failed',
      true,
    ],
    [
      'a poll of another bridge version',
      (h: Harness) => interceptPolls(h, () => answer(200, { v: 2, events: [] })),
      'host_open_failed',
      false,
    ],
    [
      'an event out of sequence',
      (h: Harness) =>
        interceptPolls(h, () => answer(200, { v: 1, events: [{ sseq: 7, data: '{}' }] })),
      'host_open_failed',
      false,
    ],
    [
      'an event that is not a frame',
      (h: Harness) =>
        interceptPolls(h, () => answer(200, { v: 1, events: [{ sseq: 1, data: '[1]' }] })),
      'host_open_failed',
      false,
    ],
    [
      'a poll that hangs past the frame wait',
      (h: Harness) => interceptPolls(h, NEVER),
      'host_timeout',
      true,
    ],
    [
      'a refused PIN echo',
      (h: Harness) =>
        answerWith(h, 'room-password-set', (frame) => [
          {
            type: 'room-password-result',
            mutationId: frame.pinMutationId,
            applied: false,
            errorType: 'ROOM_PASSWORD_STORAGE_UNAVAILABLE',
          },
        ]),
      'pin_fence_failed',
      false,
    ],
    [
      'no PIN echo result',
      (h: Harness) => answerWith(h, 'room-password-set', () => []),
      'pin_fence_failed',
      true,
    ],
    [
      'a 5xx guest open',
      (h: Harness) => {
        h.fake.intercept = (call) =>
          call.operation === 'open' && call.session.role === 'guest'
            ? answer(502, { error: 'STANDARD_HTTP_BRIDGE_UPSTREAM_REJECTED' })
            : undefined;
      },
      'guest_open_failed',
      true,
    ],
    [
      'an error frame for guest-auth',
      (h: Harness) =>
        answerWith(
          h,
          'guest-auth',
          () => [{ type: 'error', errorType: 'peer-unavailable', message: 'HOST_NOT_AVAILABLE' }],
          true,
        ),
      'guest_refused',
      false,
    ],
    [
      'a guest peer-open for another peer',
      (h: Harness) =>
        answerWith(h, 'guest-auth', (_frame, session) => [
          { type: 'peer-open', peerId: 'another-guest', roomId: session.roomId },
        ]),
      'guest_refused',
      false,
    ],
    [
      'no guest peer-open',
      (h: Harness) => answerWith(h, 'guest-auth', () => []),
      'guest_timeout',
      true,
    ],
    [
      'an offer that never reaches the host',
      (h: Harness) => answerWith(h, 'signal-offer', () => []),
      'relay_failed',
      true,
    ],
    [
      'an offer relayed without its description',
      (h: Harness) => {
        h.fake.react = (frame, session) => {
          if (frame.type !== 'signal-offer') return false;
          const host = h.fake.member(session.roomId, 'host')!;
          h.fake.deliver(host, { ...relayed(frame, session.peerId), sdp: 'v=0' });
          return true;
        };
      },
      'relay_failed',
      false,
    ],
    [
      'an answer of the wrong type',
      (h: Harness) => {
        h.fake.react = (frame, session) => {
          if (frame.type !== 'signal-answer') return false;
          const guest = h.fake.member(session.roomId, 'guest')!;
          h.fake.deliver(guest, {
            ...relayed(frame, session.peerId),
            sdp: { type: 'offer', sdp: 'v=0' },
          });
          return true;
        };
      },
      'relay_failed',
      false,
    ],
  ] as const)(
    'fails the rooms row on %s with its reason, retrying only a transport, 5xx or timeout failure',
    async (_label, setup, reason, retried) => {
      const h = harness();
      setup(h);
      const elapsedMs = await run(h.deps);

      expect(elapsedMs).toBeLessThan(STATUS_ROOMS_CHECK_DEADLINE_MS);
      const rows = rowsOf(h);
      expectRow(rows.rooms, 'p', reason);
      expectRow(rows.pro, 'o', 'passing');
      expect(h.claim).toHaveBeenCalledTimes(retried ? 2 : 1);
      expect(h.sleep.mock.calls).toEqual(retried ? [[STATUS_CHECK_RETRY_DELAY_MS]] : []);
      expect(h.warn).toHaveBeenCalledWith(
        'status_check_failed',
        expect.objectContaining({ component: 'rooms', reason }),
      );
      expectEverySessionClosed(h);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('reads frames that arrive early or between the expected ones from its queue', async () => {
    const h = harness();
    h.fake.react = (frame, session) => {
      if (frame.type === 'room-password-set') return true;
      if (frame.type !== 'host-auth') return false;
      h.fake.deliver(session, { type: 'account-identity', memberIdentity: null });
      h.fake.deliver(session, {
        type: 'peer-open',
        peerId: session.roomId,
        roomId: session.roomId,
        roomPasswordApplied: true,
      });
      h.fake.deliver(session, {
        type: 'room-password-result',
        mutationId: frame.pinMutationId,
        applied: true,
      });
      return true;
    };
    await run(h.deps);

    expectRow(rowsOf(h).rooms, 'o', 'passing');
    // One poll brought peer-open and the PIN result; the next one the offer.
    expect(h.log.filter((entry) => entry.startsWith('poll:host:'))).toHaveLength(2);
  });

  it.each([
    ['activation_required', 200, CANARY, 'o', 'passing', 1],
    [
      'pin_required',
      200,
      { roomCode: '000000', status: 'pin_required', passwordRequired: true },
      'o',
      'passing',
      1,
    ],
    [
      'open',
      200,
      { roomCode: '000000', status: 'open', passwordRequired: false },
      'o',
      'passing',
      1,
    ],
    [
      'suspended',
      200,
      { roomCode: '000000', status: 'suspended', passwordRequired: true },
      'o',
      'passing',
      1,
    ],
    ['another room', 200, { roomCode: '000001', status: 'open' }, 'p', 'pro_bad_response', 1],
    ['an unknown state', 200, { roomCode: '000000', status: 'closed' }, 'p', 'pro_bad_response', 1],
    ['a body that is not JSON', 200, '<!doctype html>', 'p', 'pro_bad_response', 1],
    [
      'maintenance',
      503,
      { error: 'SERVICE_MAINTENANCE', maintenance: true },
      'm',
      'maintenance',
      1,
    ],
    [
      'an unreadable control plane',
      503,
      { error: 'SERVICE_MAINTENANCE_STATUS_UNAVAILABLE', maintenance: true },
      'p',
      'pro_http_503',
      2,
    ],
    [
      'the App build floor',
      426,
      { error: 'APP_UPDATE_REQUIRED', minAppBuild: 900 },
      'p',
      'pro_update_required',
      1,
    ],
    ['an unknown room', 404, { error: 'ROOM_NOT_FOUND' }, 'p', 'pro_http_404', 1],
    ['a refused origin', 403, { error: 'FORBIDDEN_ORIGIN' }, 'p', 'pro_http_403', 1],
    ['a bad gateway', 502, '', 'p', 'pro_http_502', 2],
    ['an impossible status', 1_000, CANARY, 'p', 'pro_bad_response', 1],
  ] as const)(
    'maps a PRO bootstrap of %s (HTTP %i)',
    async (_label, status, payload, result, reason, calls) => {
      const h = harness();
      h.fetchProBootstrap.mockResolvedValue(proAnswer(status, payload));
      await run(h.deps);

      expectRow(rowsOf(h).pro, result, reason);
      expect(h.fetchProBootstrap).toHaveBeenCalledTimes(calls);
      expect(h.fetchProBootstrap.mock.calls.every(([build]) => build === APP_BUILD)).toBe(true);
      expect(h.sleep).toHaveBeenCalledTimes(calls - 1);
    },
  );

  it.each([
    ['no answer', () => Promise.resolve(null)],
    ['a rejected call', () => Promise.reject(new Error('service binding failed'))],
  ])('maps %s from the PRO front door to pro_unreachable after one retry', async (_label, read) => {
    const h = harness();
    h.fetchProBootstrap.mockImplementation(read);
    await run(h.deps);

    expectRow(rowsOf(h).pro, 'p', 'pro_unreachable');
    expect(h.fetchProBootstrap).toHaveBeenCalledTimes(2);
  });

  it('maps a PRO answer that is not UTF-8 to pro_bad_response', async () => {
    const h = harness();
    h.fetchProBootstrap.mockResolvedValue({ status: 200, bytes: new Uint8Array([0xff, 0xfe]) });
    await run(h.deps);

    expectRow(rowsOf(h).pro, 'p', 'pro_bad_response');
  });

  it.each([
    ['null', async () => null],
    ['zero', async () => 0],
    ['a fraction', async () => 844.5],
    ['a rejected read', () => Promise.reject(new Error('assets unavailable'))],
  ])(
    'checks nothing when the served build is %s, since the floor would refuse its frames',
    async (_label, read) => {
      const h = harness();
      h.readServedAppBuild.mockImplementation(read);
      await run(h.deps);

      expect(h.rows).toEqual([]);
      expect(h.claim).not.toHaveBeenCalled();
      expect(h.fake.attempts).toEqual([]);
      expect(h.fetchProBootstrap).not.toHaveBeenCalled();
      expect(h.warn.mock.calls).toEqual([['app_build_unavailable', {}]]);
      expect(h.prune).toHaveBeenCalledTimes(1);
    },
  );

  it('leaves the rooms row unchecked without the signaling binding and still checks pro', async () => {
    const h = harness({ bridge: null });
    await run(h.deps);

    expect(Object.keys(rowsOf(h))).toEqual(['pro']);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.warn.mock.calls).toEqual([['status_bridge_unavailable', { component: 'rooms' }]]);
  });

  it('records a run that starts late in its scheduled slot, and one without a scheduled time in the slot it started in', async () => {
    vi.setSystemTime(SLOT + 16 * 60_000);
    const late = harness();
    await run(late.deps);
    expect(late.rows.map((row) => row.slotAt)).toEqual([SLOT, SLOT]);

    const unscheduled = harness({ scheduledTimeMs: Number.NaN });
    await run(unscheduled.deps);
    expect(unscheduled.rows.map((row) => row.slotAt)).toEqual([
      SLOT + 15 * 60_000,
      SLOT + 15 * 60_000,
    ]);
  });

  it('records and prunes in whole milliseconds even with a fractional clock', async () => {
    const h = harness({ nowMs: () => Date.now() + 0.5 });
    await run(h.deps);

    expect(h.rows).toHaveLength(2);
    expect(h.rows.every((row) => Number.isSafeInteger(row.checkedAt))).toBe(true);
    expect(h.prunes).toHaveLength(1);
    expect(h.prunes[0]!.beforeMs).toBe(h.prunes[0]!.at - STATUS_RESULT_RETENTION_MS);
  });

  describe('deadline', () => {
    it('settles by the deadline when every dependency hangs, and an interrupted check records no row', async () => {
      const h = harness();
      h.claim.mockImplementation(NEVER);
      h.fetchProBootstrap.mockImplementation(NEVER);
      const running = start(h.deps);

      await vi.advanceTimersByTimeAsync(STATUS_ROOMS_CHECK_DEADLINE_MS - 1);
      expect(running.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(running.settled()).toBe(true);
      await running.done;

      expect(h.record).not.toHaveBeenCalled();
      // The next run prunes instead.
      expect(h.prune).not.toHaveBeenCalled();
      expect(h.warn).toHaveBeenCalledTimes(2);
      expect(h.warn.mock.calls).toEqual(
        expect.arrayContaining([
          ['status_check_interrupted', { component: 'rooms' }],
          ['status_check_interrupted', { component: 'pro' }],
        ]),
      );
      expect(vi.getTimerCount()).toBe(0);
    });

    it('still sends the closes when the deadline cuts a bridge session that hangs', async () => {
      const h = harness();
      h.fake.intercept = (call) => (call.operation === 'open' ? NEVER() : undefined);
      const running = start(h.deps);

      await vi.advanceTimersByTimeAsync(STATUS_ROOMS_CHECK_DEADLINE_MS - 1);
      expect(running.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(running.settled()).toBe(true);
      await running.done;

      expect(Object.keys(rowsOf(h))).toEqual(['pro']);
      expect(h.fake.attempts.map((attempt) => attempt.operation)).toEqual(['open', 'close']);
      expectEverySessionClosed(h);
      expect(h.warn.mock.calls).toEqual([['status_check_interrupted', { component: 'rooms' }]]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('settles by the deadline when the served build read hangs', async () => {
      const h = harness();
      h.readServedAppBuild.mockImplementation(NEVER);
      const elapsedMs = await run(h.deps);

      expect(elapsedMs).toBeGreaterThanOrEqual(STATUS_ROOMS_CHECK_DEADLINE_MS);
      expect(elapsedMs).toBeLessThanOrEqual(STATUS_ROOMS_CHECK_DEADLINE_MS + 10);
      expect(h.rows).toEqual([]);
      expect(h.claim).not.toHaveBeenCalled();
      expect(h.fetchProBootstrap).not.toHaveBeenCalled();
      expect(h.warn.mock.calls).toEqual([['status_check_interrupted', {}]]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('settles by the deadline when the ledger write hangs', async () => {
      const h = harness();
      h.record.mockImplementation(NEVER);
      const elapsedMs = await run(h.deps);

      expect(elapsedMs).toBeLessThanOrEqual(STATUS_ROOMS_CHECK_DEADLINE_MS + 10);
      expect(h.record).toHaveBeenCalledTimes(2);
      expect(h.prune).not.toHaveBeenCalled();
      expect(h.warn.mock.calls).toEqual(
        expect.arrayContaining([
          ['status_check_interrupted', { component: 'rooms' }],
          ['status_check_interrupted', { component: 'pro' }],
        ]),
      );
      expect(vi.getTimerCount()).toBe(0);
    });

    it('records no rooms row when a frame wait runs into the deadline', async () => {
      const h = harness();
      h.claim.mockImplementation(async () => {
        await wait(STATUS_ROOMS_CHECK_DEADLINE_MS - STATUS_ROOMS_FRAME_WAIT_MS / 2);
        return 'claimed';
      });
      answerWith(h, 'host-auth', () => []);
      const elapsedMs = await run(h.deps);

      expect(elapsedMs).toBeLessThanOrEqual(STATUS_ROOMS_CHECK_DEADLINE_MS + 10);
      expect(Object.keys(rowsOf(h))).toEqual(['pro']);
      expect(h.sleep).not.toHaveBeenCalled();
      expect(h.warn.mock.calls).toEqual([['status_check_interrupted', { component: 'rooms' }]]);
      expectEverySessionClosed(h);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('records no rooms row when a frame wait whose poll hangs runs into the deadline', async () => {
      const h = harness();
      h.claim.mockImplementation(async () => {
        await wait(STATUS_ROOMS_CHECK_DEADLINE_MS - STATUS_ROOMS_FRAME_WAIT_MS / 2);
        return 'claimed';
      });
      interceptPolls(h, NEVER);
      const elapsedMs = await run(h.deps);

      expect(elapsedMs).toBeLessThanOrEqual(STATUS_ROOMS_CHECK_DEADLINE_MS + 10);
      expect(Object.keys(rowsOf(h))).toEqual(['pro']);
      expect(h.warn.mock.calls).toEqual([['status_check_interrupted', { component: 'rooms' }]]);
      expectEverySessionClosed(h);
    });

    it('skips a retry that could not start before the deadline, and records no row', async () => {
      const h = harness();
      h.claim.mockImplementation(async () => {
        await wait(STATUS_ROOMS_CHECK_DEADLINE_MS - STATUS_CHECK_RETRY_DELAY_MS / 2);
        return 'failed';
      });
      await run(h.deps);

      expect(Object.keys(rowsOf(h))).toEqual(['pro']);
      expect(h.claim).toHaveBeenCalledTimes(1);
      expect(h.sleep).not.toHaveBeenCalled();
      expect(h.warn.mock.calls).toEqual([
        ['status_check_retry', { component: 'rooms', reason: 'claim_failed' }],
        ['status_check_interrupted', { component: 'rooms' }],
      ]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('does not let a close that fails change the result', async () => {
    const h = harness();
    h.fake.throwOn = 'close';
    await run(h.deps);

    expectRow(rowsOf(h).rooms, 'o', 'passing');
    expectEverySessionClosed(h);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('records no rooms row when the pause before its retry hangs into the deadline', async () => {
    const h = harness();
    h.claim.mockResolvedValueOnce('failed');
    h.sleep.mockImplementation(NEVER);
    const elapsedMs = await run(h.deps);

    expect(elapsedMs).toBeLessThanOrEqual(STATUS_ROOMS_CHECK_DEADLINE_MS + 10);
    expect(Object.keys(rowsOf(h))).toEqual(['pro']);
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls).toEqual([
      ['status_check_retry', { component: 'rooms', reason: 'claim_failed' }],
      ['status_check_interrupted', { component: 'rooms' }],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries at once when the pause itself fails', async () => {
    const h = harness();
    h.claim.mockResolvedValueOnce('failed');
    h.sleep.mockRejectedValueOnce(new Error('timer unavailable'));
    await run(h.deps);

    expectRow(rowsOf(h).rooms, 'o', 'passing');
    expect(h.claim).toHaveBeenCalledTimes(2);
  });

  it('reports a ledger write that fails, and still prunes', async () => {
    const h = harness();
    h.record.mockRejectedValue(new Error('D1 unavailable'));
    await run(h.deps);

    expect(h.warn).toHaveBeenCalledTimes(2);
    expect(h.warn.mock.calls).toEqual(
      expect.arrayContaining([
        ['status_record_failed', { component: 'rooms' }],
        ['status_record_failed', { component: 'pro' }],
      ]),
    );
    expect(h.prune).toHaveBeenCalledTimes(1);
  });

  it('reports a maintenance write that fails without naming a component', async () => {
    const h = harness({ maintenance: { enabled: true } });
    h.record.mockRejectedValue(new Error('D1 unavailable'));
    await run(h.deps);

    expect(h.warn.mock.calls).toEqual([['status_record_failed', {}]]);
    expect(h.prune).toHaveBeenCalledTimes(1);
  });

  it('reports a prune that fails', async () => {
    const h = harness();
    h.prune.mockRejectedValue(new Error('D1 unavailable'));
    await run(h.deps);

    expect(h.rows).toHaveLength(2);
    expect(h.warn.mock.calls).toEqual([['status_prune_failed', {}]]);
  });

  it('records nothing for a check whose dependency throws unexpectedly', async () => {
    const h = harness();
    h.randomRoomId.mockImplementation(() => {
      throw new Error('no entropy');
    });
    await run(h.deps);

    expect(Object.keys(rowsOf(h))).toEqual(['pro']);
    expect(h.warn.mock.calls).toEqual([['status_check_error', { component: 'rooms' }]]);
  });

  it('never rejects, even when its clock throws', async () => {
    const h = harness({
      nowMs: () => {
        throw new Error('clock unavailable');
      },
    });
    await expect(runStatusServerChecks(h.deps)).resolves.toBeUndefined();

    expect(h.rows).toEqual([]);
    expect(h.warn.mock.calls).toEqual([['status_check_error', {}]]);
  });

  it('keeps checking when the warning sink throws', async () => {
    const h = harness();
    h.warn.mockImplementation(() => {
      throw new Error('console unavailable');
    });
    h.fetchProBootstrap.mockResolvedValue(proAnswer(404, { error: 'ROOM_NOT_FOUND' }));
    await run(h.deps);

    expectRow(rowsOf(h).pro, 'p', 'pro_http_404');
    expectRow(rowsOf(h).rooms, 'o', 'passing');
  });

  it('warns with fixed codes only: no room code, peer id, secret or body', async () => {
    const h = harness();
    h.fake.react = (frame, session) => {
      if (frame.type !== 'host-auth') return false;
      h.fake.deliver(session, {
        type: 'error',
        errorType: 'room-full',
        message: `HOST_PENDING_LIMIT_REACHED for ${session.peerId} in ${session.roomId}`,
      });
      session.terminal = true;
      return true;
    };
    h.fetchProBootstrap.mockResolvedValue(
      proAnswer(503, { error: 'SERVICE_UNAVAILABLE', roomCode: STATUS_PRO_PROBE_ROOM_CODE }),
    );
    await run(h.deps);

    expect(h.warn.mock.calls.length).toBeGreaterThan(0);
    const logged = JSON.stringify(h.warn.mock.calls);
    for (const secret of [
      ...h.nonces,
      ...h.roomIds,
      STATUS_PRO_PROBE_ROOM_CODE,
      'HOST_PENDING_LIMIT_REACHED',
      'SERVICE_UNAVAILABLE',
      'status-host-',
      'status-guest-',
    ]) {
      expect(logged).not.toContain(secret);
    }
    for (const [event, fields] of h.warn.mock.calls) {
      expect(event).toMatch(/^[a-z_]+$/);
      expect(
        Object.keys(fields).every((key) => ['component', 'reason', 'httpStatus'].includes(key)),
      ).toBe(true);
    }
  });
});
