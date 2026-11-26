/**
 * Server checks of the public status page (musixquare.com/status, train
 * 9.0.845): the rooms row ("Creating and joining rooms") and the pro row
 * ("PRO rooms"), run by the App Worker's status cron (STATUS_SERVER_CRON).
 *
 * The module is pure. The App Worker passes its bindings and private helpers
 * in, as scheduled() does for its other jobs, and the results reach the
 * status check ledger (registry record RO-57) only through the record() and
 * prune() it is given.
 *
 * rooms: the release smoke's HTTPS-bridge sequence
 * (scripts/live-standard-http-signaling-smoke.mts) over the internal bridge
 * envelopes the App Worker builds for its public bridge route. A random code
 * is first claimed on its signaling room object, so that signaling records
 * the room as status_probe_room_opened and the guest as
 * status_probe_guest_joined, never in the public room count; without a claim
 * no host frame is sent. Then a host session authenticates with the build the
 * App Worker serves, echoes its empty PIN, a guest session joins, an offer
 * and an answer are relayed, and both sessions close.
 *
 * pro: a read-only bootstrap of the built-in canary room 000000 through the
 * PRO front door.
 *
 * Every timing value comes from cloudflare/status-contract.ts; the bridge's
 * call and poll timeouts are the App Worker's own and arrive with the bridge
 * port. A run settles by STATUS_ROOMS_CHECK_DEADLINE_MS even when every
 * dependency hangs: each step races that deadline, a check that is still
 * running then records no row, close requests still go out, and every timer
 * this module sets is cleared on every path. Warnings carry only fixed event
 * names, components, reason codes and HTTP statuses: never a room code,
 * secret, peer id, token or body.
 */

import {
  STATUS_CHECK_RETRY_DELAY_MS,
  STATUS_PRO_PROBE_ROOM_CODE,
  STATUS_RESULT_RETENTION_MS,
  STATUS_ROOMS_CHECK_DEADLINE_MS,
  STATUS_ROOMS_CODE_ATTEMPTS,
  STATUS_ROOMS_FRAME_WAIT_MS,
  STATUS_ROOMS_POLL_WAIT_MS,
  statusSlotAt,
  type StatusCheckRow,
  type StatusComponentId,
  type StatusProbeClaimOutcome,
  type StatusStoredResult,
} from './status-contract.ts';

type JsonObject = Record<string, unknown>;

/** An operation of the internal signaling HTTPS bridge. */
export type StatusBridgeOperation = 'open' | 'send' | 'poll' | 'close';

/** One internal bridge call: the bounded answer, or null when none arrived in time. */
export interface StatusBridgeCall {
  readonly upstream: {
    readonly response: { readonly status: number };
    readonly bytes: Uint8Array;
  } | null;
}

/**
 * The App Worker's internal signaling bridge: the PRO_SIGNALING_ROOMS
 * namespace, its session stub, its bounded call (callStandardSignalingBridge)
 * and that call's timeouts for open, send and close (callTimeoutMs) and for
 * poll (pollTimeoutMs).
 */
export interface StatusBridgePort<Namespace, Stub> {
  readonly namespace: Namespace;
  stub(namespace: Namespace, sessionId: string): Stub;
  call(
    stub: Stub,
    operation: StatusBridgeOperation,
    body: JsonObject,
    timeoutMs: number,
  ): Promise<StatusBridgeCall>;
  readonly callTimeoutMs: number;
  readonly pollTimeoutMs: number;
}

/** The PRO front door's bounded bootstrap answer. */
export interface StatusProBootstrapAnswer {
  readonly status: number;
  readonly bytes: Uint8Array;
}

/** What a warning reports. Each is a failure, or a check that could not run. */
export type StatusCheckWarnEvent =
  | 'app_build_unavailable'
  | 'status_probe_unsupported'
  | 'status_bridge_unavailable'
  | 'status_check_retry'
  | 'status_check_failed'
  | 'status_check_interrupted'
  | 'status_check_error'
  | 'status_record_failed'
  | 'status_prune_failed';

/** A warning's only fields: no room code, secret, peer id, token or body. */
export interface StatusCheckWarnFields {
  readonly component?: StatusComponentId;
  /** A reason code that isStatusReason accepts. */
  readonly reason?: string;
  readonly httpStatus?: number;
}

export interface StatusServerCheckDeps<Namespace, Stub> {
  /** Epoch ms (Date.now). */
  nowMs(): number;
  /** The cron event's scheduledTime; its server slot is the rows' slot. */
  readonly scheduledTimeMs: number;
  /** This run's readServiceMaintenance answer. */
  readonly maintenance: { readonly enabled: boolean; readonly controlUnavailable?: boolean };
  /**
   * The ledger writes (cloudflare/status-store.ts). Null when the App Worker
   * has no admin DB: the run then does nothing at all, not even a claim.
   */
  readonly record: ((rows: readonly StatusCheckRow[]) => Promise<unknown>) | null;
  readonly prune: ((beforeMs: number) => Promise<unknown>) | null;
  /** The App build the App Worker serves, or null when it cannot be read. */
  readServedAppBuild(): Promise<number | null>;
  /** The binding-only claim on the code's signaling room object (status-probe-claim.ts). */
  claim(roomId: string): Promise<StatusProbeClaimOutcome>;
  /** Null without a usable PRO_SIGNALING_ROOMS binding: the rooms row is then not checked. */
  readonly bridge: StatusBridgePort<Namespace, Stub> | null;
  /** byteLength random bytes as unpadded base64url (the App Worker's randomNonce). */
  randomNonce(byteLength: number): string;
  /** A random Standard room code, 100000 to 999999. */
  randomRoomId(): string;
  /**
   * GET /v1/rooms/000000/bootstrap on the PRO front door, reporting appBuild
   * in X-MXQR-App-Build. Null when no bounded answer arrived.
   */
  fetchProBootstrap(appBuild: number): Promise<StatusProBootstrapAnswer | null>;
  sleep(ms: number): Promise<unknown>;
  warn(event: StatusCheckWarnEvent, fields: StatusCheckWarnFields): void;
}

/** A finished check that records a row. */
interface RowOutcome {
  readonly kind: 'row';
  readonly result: StatusStoredResult;
  readonly reason: string;
  /** A transport, 5xx or timeout failure: the check runs once more. */
  readonly retryable: boolean;
  readonly httpStatus: number | null;
}

/** A check that could not run and records no row, with the warning that says why. */
interface SkipOutcome {
  readonly kind: 'skip';
  readonly event: 'status_probe_unsupported' | 'status_bridge_unavailable';
}

type CheckOutcome = RowOutcome | SkipOutcome;

const PASSED: RowOutcome = {
  kind: 'row',
  result: 'o',
  reason: 'passing',
  retryable: false,
  httpStatus: null,
};

const MAINTENANCE: RowOutcome = {
  kind: 'row',
  result: 'm',
  reason: 'maintenance',
  retryable: false,
  httpStatus: null,
};

function failed(reason: string, retryable: boolean, httpStatus: number | null = null): RowOutcome {
  return { kind: 'row', result: 'p', reason, retryable, httpStatus };
}

/** The reasons one stage of the rooms check fails with. */
interface RoomsStage {
  /** A bridge call failed or answered out of protocol, or a dependency threw. */
  readonly broken: string;
  /** Signaling refused, closed the session, or sent something other than expected. */
  readonly refused: string;
  /** The expected frame did not arrive within STATUS_ROOMS_FRAME_WAIT_MS. */
  readonly late: string;
  /** The error frame type that moves the check to another code instead. */
  readonly nextCodeOn: string | null;
}

const HOST_STAGE: RoomsStage = {
  broken: 'host_open_failed',
  refused: 'host_refused',
  late: 'host_timeout',
  nextCodeOn: 'id-taken',
};
const PIN_STAGE: RoomsStage = {
  broken: 'pin_fence_failed',
  refused: 'pin_fence_failed',
  late: 'pin_fence_failed',
  nextCodeOn: null,
};
const GUEST_STAGE: RoomsStage = {
  broken: 'guest_open_failed',
  refused: 'guest_refused',
  late: 'guest_timeout',
  nextCodeOn: null,
};
const RELAY_STAGE: RoomsStage = {
  broken: 'relay_failed',
  refused: 'relay_failed',
  late: 'relay_failed',
  nextCodeOn: null,
};

/** The states the PRO bootstrap reports for a provisioned room. */
const PRO_ENTRY_STATES: ReadonlySet<string> = new Set([
  'activation_required',
  'pin_required',
  'open',
  'suspended',
]);

const TIMED_OUT = Symbol('status-step-timed-out');
const NEXT_CODE = Symbol('status-rooms-next-code');

/** The run deadline passed: the check that is still running records no row. */
class StatusRunInterrupted extends Error {
  constructor() {
    super('STATUS_CHECK_DEADLINE');
    this.name = 'StatusRunInterrupted';
  }
}

/** A rooms stage ended the attempt with this outcome, or sent it to another code. */
class RoomsStageStop extends Error {
  readonly outcome: RowOutcome | typeof NEXT_CODE;

  constructor(outcome: RowOutcome | typeof NEXT_CODE) {
    super('STATUS_ROOMS_STAGE_STOPPED');
    this.name = 'RoomsStageStop';
    this.outcome = outcome;
  }
}

type BridgeExchange =
  | { readonly kind: 'answer'; readonly payload: JsonObject }
  | { readonly kind: 'broken'; readonly retryable: boolean; readonly httpStatus: number | null }
  | { readonly kind: 'late' };

const TRANSPORT_FAILURE: BridgeExchange = { kind: 'broken', retryable: true, httpStatus: null };

/** One internal bridge session: the App Worker's envelope plus the release smoke's cursors. */
interface BridgeSession<Stub> {
  readonly stub: Stub;
  readonly envelope: {
    readonly v: 1;
    readonly sessionId: string;
    readonly generation: string;
    readonly roomId: string;
    readonly role: 'host' | 'guest';
    readonly peerId: string;
  };
  clientSequence: number;
  serverAck: number;
  requestEpoch: number;
  closedByServer: boolean;
  /** Frames received and not yet consumed by a wait, in arrival order. */
  readonly queued: JsonObject[];
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseJsonObject(bytes: Uint8Array): JsonObject | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  const value = parseJson(text);
  return isJsonObject(value) ? value : null;
}

/** The pro row from one bootstrap answer of the canary room. */
function proOutcome(answer: StatusProBootstrapAnswer | null): RowOutcome {
  if (!answer) return failed('pro_unreachable', true);
  const { status } = answer;
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    return failed('pro_bad_response', false);
  }
  const payload = parseJsonObject(answer.bytes);
  if (status === 200) {
    return payload?.roomCode === STATUS_PRO_PROBE_ROOM_CODE &&
      typeof payload.status === 'string' &&
      PRO_ENTRY_STATES.has(payload.status)
      ? PASSED
      : failed('pro_bad_response', false, status);
  }
  if (status === 503 && payload?.error === 'SERVICE_MAINTENANCE') return MAINTENANCE;
  if (status === 426) return failed('pro_update_required', false, status);
  return failed(`pro_http_${status}`, status >= 500, status);
}

function failureFields(component: StatusComponentId, outcome: RowOutcome): StatusCheckWarnFields {
  return outcome.httpStatus === null
    ? { component, reason: outcome.reason }
    : { component, reason: outcome.reason, httpStatus: outcome.httpStatus };
}

function warnQuietly<Namespace, Stub>(
  deps: StatusServerCheckDeps<Namespace, Stub>,
  event: StatusCheckWarnEvent,
  fields: StatusCheckWarnFields,
): void {
  try {
    deps.warn(event, fields);
  } catch {
    // A diagnostic never changes a check.
  }
}

class StatusServerCheckRun<Namespace, Stub> {
  private readonly deps: StatusServerCheckDeps<Namespace, Stub>;
  private readonly record: (rows: readonly StatusCheckRow[]) => Promise<unknown>;
  private readonly prune: (beforeMs: number) => Promise<unknown>;
  private readonly deadlineAt: number;
  private readonly slotAt: number;

  constructor(
    deps: StatusServerCheckDeps<Namespace, Stub>,
    record: (rows: readonly StatusCheckRow[]) => Promise<unknown>,
    prune: (beforeMs: number) => Promise<unknown>,
  ) {
    this.deps = deps;
    this.record = record;
    this.prune = prune;
    const startedAt = deps.nowMs();
    this.deadlineAt = startedAt + STATUS_ROOMS_CHECK_DEADLINE_MS;
    // A cron event always carries scheduledTime; without one, the run's start
    // is in the same slot.
    const scheduledSlot = statusSlotAt(deps.scheduledTimeMs, 'server');
    this.slotAt = Number.isFinite(scheduledSlot)
      ? scheduledSlot
      : statusSlotAt(startedAt, 'server');
  }

  async run(): Promise<void> {
    const { maintenance } = this.deps;
    // During maintenance the rows say so and nothing is opened, claimed or
    // read. A control-plane outage (enabled with controlUnavailable) is not
    // maintenance: users get errors then, so the checks run.
    if (maintenance.enabled && maintenance.controlUnavailable !== true) {
      const checkedAt = this.wholeNowMs();
      await this.recordRows(
        [this.row('rooms', MAINTENANCE, checkedAt), this.row('pro', MAINTENANCE, checkedAt)],
        null,
      );
    } else {
      await this.runChecks();
    }
    await this.pruneLedger();
  }

  private now(): number {
    return this.deps.nowMs();
  }

  /** The clock in whole epoch ms, as the ledger stores and prunes it. */
  private wholeNowMs(): number {
    return Math.floor(this.now());
  }

  private warn(event: StatusCheckWarnEvent, fields: StatusCheckWarnFields): void {
    warnQuietly(this.deps, event, fields);
  }

  private row(
    component: StatusComponentId,
    outcome: RowOutcome,
    checkedAt: number,
  ): StatusCheckRow {
    return {
      component,
      slotAt: this.slotAt,
      result: outcome.result,
      reason: outcome.reason,
      checkedAt,
      source: 'cron',
      runId: null,
    };
  }

  /**
   * Runs task until it settles or untilMs passes (TIMED_OUT). Nothing starts
   * once that time is up, and the timer is cleared on every path.
   */
  private async race<T>(task: () => Promise<T>, untilMs: number): Promise<T | typeof TIMED_OUT> {
    const remainingMs = untilMs - this.now();
    if (!(remainingMs > 0)) return TIMED_OUT;
    let expire!: () => void;
    const expired = new Promise<typeof TIMED_OUT>((resolve) => {
      expire = () => resolve(TIMED_OUT);
    });
    const timer = setTimeout(expire, remainingMs);
    try {
      return await Promise.race([Promise.resolve().then(task), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The task's value; the run deadline throws StatusRunInterrupted instead. */
  private async untilDeadline<T>(task: () => Promise<T>): Promise<T> {
    const settled = await this.race(task, this.deadlineAt);
    if (settled === TIMED_OUT) throw new StatusRunInterrupted();
    return settled;
  }

  /** As untilDeadline, but a step that ends first at stepUntil gives TIMED_OUT. */
  private async untilStep<T>(
    task: () => Promise<T>,
    stepUntil: number,
  ): Promise<T | typeof TIMED_OUT> {
    const settled = await this.race(task, Math.min(stepUntil, this.deadlineAt));
    if (settled === TIMED_OUT && stepUntil >= this.deadlineAt) throw new StatusRunInterrupted();
    return settled;
  }

  private async recordRows(
    rows: readonly StatusCheckRow[],
    component: StatusComponentId | null,
  ): Promise<void> {
    try {
      await this.untilDeadline(() => this.record(rows));
    } catch (error) {
      this.warn(
        error instanceof StatusRunInterrupted ? 'status_check_interrupted' : 'status_record_failed',
        component ? { component } : {},
      );
    }
  }

  private async pruneLedger(): Promise<void> {
    try {
      await this.untilDeadline(() => this.prune(this.wholeNowMs() - STATUS_RESULT_RETENTION_MS));
    } catch (error) {
      // After the deadline the next run prunes instead.
      if (!(error instanceof StatusRunInterrupted)) this.warn('status_prune_failed', {});
    }
  }

  private async runChecks(): Promise<void> {
    const appBuild = await this.servedAppBuild();
    if (appBuild === null) return;
    const { bridge } = this.deps;
    await Promise.allSettled([
      this.runCheck('rooms', () => this.roomsAttempt(bridge, appBuild)),
      this.runCheck('pro', () => this.proAttempt(appBuild)),
    ]);
  }

  /**
   * The build both checks report. Without it a host-auth or a PRO entry could
   * be refused below the App build floor, a false failure, so neither runs.
   */
  private async servedAppBuild(): Promise<number | null> {
    let build: unknown;
    try {
      build = await this.untilDeadline(() => this.deps.readServedAppBuild());
    } catch (error) {
      if (error instanceof StatusRunInterrupted) {
        this.warn('status_check_interrupted', {});
        return null;
      }
      build = null;
    }
    if (typeof build === 'number' && Number.isSafeInteger(build) && build > 0) return build;
    this.warn('app_build_unavailable', {});
    return null;
  }

  /**
   * One row per component: one retry after a transport, 5xx or timeout
   * failure, never after a definite refusal; nothing when the deadline cuts
   * the check.
   */
  private async runCheck(
    component: StatusComponentId,
    attempt: () => Promise<CheckOutcome>,
  ): Promise<void> {
    try {
      let outcome = await attempt();
      if (outcome.kind === 'row' && outcome.result === 'p' && outcome.retryable) {
        this.warn('status_check_retry', failureFields(component, outcome));
        await this.pauseBeforeRetry();
        outcome = await attempt();
      }
      if (outcome.kind === 'skip') {
        this.warn(outcome.event, { component });
        return;
      }
      if (outcome.result === 'p') {
        this.warn('status_check_failed', failureFields(component, outcome));
      }
      await this.recordRows([this.row(component, outcome, this.wholeNowMs())], component);
    } catch (error) {
      this.warn(
        error instanceof StatusRunInterrupted ? 'status_check_interrupted' : 'status_check_error',
        { component },
      );
    }
  }

  private async pauseBeforeRetry(): Promise<void> {
    // A retry that cannot start before the deadline could not finish either.
    if (this.deadlineAt - this.now() <= STATUS_CHECK_RETRY_DELAY_MS) {
      throw new StatusRunInterrupted();
    }
    try {
      await this.untilDeadline(() => this.deps.sleep(STATUS_CHECK_RETRY_DELAY_MS));
    } catch (error) {
      // A failed sleep only shortens the pause.
      if (error instanceof StatusRunInterrupted) throw error;
    }
  }

  private async proAttempt(appBuild: number): Promise<CheckOutcome> {
    let answer: StatusProBootstrapAnswer | null;
    try {
      answer = await this.untilDeadline(() => this.deps.fetchProBootstrap(appBuild));
    } catch (error) {
      if (error instanceof StatusRunInterrupted) throw error;
      answer = null;
    }
    return proOutcome(answer);
  }

  private async claim(roomId: string): Promise<StatusProbeClaimOutcome> {
    try {
      return await this.untilDeadline(() => this.deps.claim(roomId));
    } catch (error) {
      if (error instanceof StatusRunInterrupted) throw error;
      return 'failed';
    }
  }

  private async roomsAttempt(
    bridge: StatusBridgePort<Namespace, Stub> | null,
    appBuild: number,
  ): Promise<CheckOutcome> {
    if (!bridge) return { kind: 'skip', event: 'status_bridge_unavailable' };
    for (let code = 0; code < STATUS_ROOMS_CODE_ATTEMPTS; code += 1) {
      const roomId = this.deps.randomRoomId();
      // The claim always comes first: an unclaimed room would be counted, so
      // without a claim no host frame is ever sent.
      const claim = await this.claim(roomId);
      if (claim === 'room_active') continue;
      // A signaling Worker without the claim route (rolled back): open no room.
      if (claim === 'unsupported') return { kind: 'skip', event: 'status_probe_unsupported' };
      if (claim === 'maintenance') return MAINTENANCE;
      if (claim === 'control_unavailable') return failed('control_unavailable', true);
      if (claim !== 'claimed') return failed('claim_failed', true);
      const outcome = await this.roomSessions(bridge, roomId, appBuild);
      if (outcome !== NEXT_CODE) return outcome;
    }
    // Every code tried was busy. Random codes almost never are, so a run of
    // them points at signaling rather than at chance.
    return failed('room_codes_busy', false);
  }

  /** The release smoke's sequence on one claimed code. Both sessions close on every path. */
  private async roomSessions(
    bridge: StatusBridgePort<Namespace, Stub>,
    roomId: string,
    appBuild: number,
  ): Promise<RowOutcome | typeof NEXT_CODE> {
    const sessions: BridgeSession<Stub>[] = [];
    let stage = HOST_STAGE;
    try {
      const pinMutationId = this.deps.randomNonce(24);
      const host = this.session(bridge, roomId, 'host', `status-host-${this.deps.randomNonce(9)}`);
      sessions.push(host);
      await this.open(bridge, host, stage);
      await this.send(bridge, host, stage, {
        type: 'host-auth',
        secret: this.deps.randomNonce(24),
        desiredRoomPassword: '',
        pinMutationId,
        appBuild,
      });
      const hostOpen = await this.waitFor(
        bridge,
        host,
        stage,
        (frame) => frame.type === 'peer-open',
      );
      if (hostOpen.roomId !== roomId || hostOpen.roomPasswordApplied !== true) {
        throw new RoomsStageStop(failed(stage.refused, false));
      }

      // Guests stay fenced until the host echoes its current PIN ('' here).
      stage = PIN_STAGE;
      await this.send(bridge, host, stage, {
        type: 'room-password-set',
        password: '',
        pinMutationId,
      });
      const pinResult = await this.waitFor(
        bridge,
        host,
        stage,
        (frame) => frame.type === 'room-password-result',
      );
      if (pinResult.mutationId !== pinMutationId || pinResult.applied !== true) {
        throw new RoomsStageStop(failed(stage.refused, false));
      }

      stage = GUEST_STAGE;
      const guestPeerId = `status-guest-${this.deps.randomNonce(9)}`;
      const guest = this.session(bridge, roomId, 'guest', guestPeerId);
      sessions.push(guest);
      await this.open(bridge, guest, stage);
      await this.send(bridge, guest, stage, {
        type: 'guest-auth',
        password: '',
        reconnectSecret: this.deps.randomNonce(32),
        appBuild,
      });
      const guestOpen = await this.waitFor(
        bridge,
        guest,
        stage,
        (frame) => frame.type === 'peer-open',
      );
      if (guestOpen.roomId !== roomId || guestOpen.peerId !== guestPeerId) {
        throw new RoomsStageStop(failed(stage.refused, false));
      }

      stage = RELAY_STAGE;
      const negotiationId = `status-${this.deps.randomNonce(12)}`;
      await this.send(bridge, guest, stage, {
        type: 'signal-offer',
        to: 'host',
        negotiationId,
        sdp: { type: 'offer', sdp: 'v=0\r\ns=MUSIXQUARE-status-offer\r\n' },
        metadata: { statusCheck: true },
      });
      const offer = await this.waitFor(
        bridge,
        host,
        stage,
        (frame) => frame.type === 'signal-offer' && frame.from === guestPeerId,
      );
      if (!isJsonObject(offer.sdp) || offer.sdp.type !== 'offer') {
        throw new RoomsStageStop(failed(stage.refused, false));
      }
      await this.send(bridge, host, stage, {
        type: 'signal-answer',
        to: guestPeerId,
        negotiationId,
        sdp: { type: 'answer', sdp: 'v=0\r\ns=MUSIXQUARE-status-answer\r\n' },
      });
      const answer = await this.waitFor(
        bridge,
        guest,
        stage,
        (frame) => frame.type === 'signal-answer' && frame.from === host.envelope.peerId,
      );
      if (!isJsonObject(answer.sdp) || answer.sdp.type !== 'answer') {
        throw new RoomsStageStop(failed(stage.refused, false));
      }
      return PASSED;
    } catch (error) {
      if (error instanceof StatusRunInterrupted) throw error;
      if (error instanceof RoomsStageStop) return error.outcome;
      // A dependency threw (a stub or a nonce, say): count it as a broken stage.
      return failed(stage.broken, true);
    } finally {
      await this.closeSessions(bridge, sessions);
    }
  }

  private session(
    bridge: StatusBridgePort<Namespace, Stub>,
    roomId: string,
    role: 'host' | 'guest',
    peerId: string,
  ): BridgeSession<Stub> {
    const sessionId = this.deps.randomNonce(24);
    return {
      stub: bridge.stub(bridge.namespace, sessionId),
      envelope: { v: 1, sessionId, generation: this.deps.randomNonce(16), roomId, role, peerId },
      clientSequence: 0,
      serverAck: 0,
      requestEpoch: 0,
      closedByServer: false,
      queued: [],
    };
  }

  /**
   * One bridge call with the App Worker's envelope. Only the run deadline
   * stops it unless the step has an earlier end (a frame wait); a call that
   * fails or answers anything but 2xx JSON is broken, retryable when no
   * answer or a 5xx came back.
   */
  private async exchange(
    bridge: StatusBridgePort<Namespace, Stub>,
    session: BridgeSession<Stub>,
    operation: Exclude<StatusBridgeOperation, 'close'>,
    request: JsonObject | null,
    timeoutMs: number,
    stepUntil = Number.POSITIVE_INFINITY,
  ): Promise<BridgeExchange> {
    const body: JsonObject =
      request === null ? { ...session.envelope } : { ...session.envelope, request };
    let call: StatusBridgeCall | typeof TIMED_OUT;
    try {
      call = await this.untilStep(
        () => bridge.call(session.stub, operation, body, timeoutMs),
        stepUntil,
      );
    } catch (error) {
      if (error instanceof StatusRunInterrupted) throw error;
      return TRANSPORT_FAILURE;
    }
    if (call === TIMED_OUT) return { kind: 'late' };
    const { upstream } = call;
    if (!upstream) return TRANSPORT_FAILURE;
    const { status } = upstream.response;
    const payload = status >= 200 && status < 300 ? parseJsonObject(upstream.bytes) : null;
    return payload
      ? { kind: 'answer', payload }
      : { kind: 'broken', retryable: status >= 500, httpStatus: status };
  }

  private stageFailure(stage: RoomsStage, exchange: BridgeExchange): RoomsStageStop {
    if (exchange.kind === 'broken') {
      return new RoomsStageStop(failed(stage.broken, exchange.retryable, exchange.httpStatus));
    }
    if (exchange.kind === 'late') return new RoomsStageStop(failed(stage.late, true));
    // A 2xx JSON answer outside the bridge protocol: retrying will not help.
    return new RoomsStageStop(failed(stage.broken, false));
  }

  private async open(
    bridge: StatusBridgePort<Namespace, Stub>,
    session: BridgeSession<Stub>,
    stage: RoomsStage,
  ): Promise<void> {
    const exchange = await this.exchange(bridge, session, 'open', null, bridge.callTimeoutMs);
    if (exchange.kind === 'answer' && exchange.payload.ok === true) return;
    throw this.stageFailure(stage, exchange);
  }

  private async send(
    bridge: StatusBridgePort<Namespace, Stub>,
    session: BridgeSession<Stub>,
    stage: RoomsStage,
    frame: JsonObject,
  ): Promise<void> {
    session.clientSequence += 1;
    const cseq = session.clientSequence;
    const exchange = await this.exchange(
      bridge,
      session,
      'send',
      { v: 1, cseq, frame: JSON.stringify(frame) },
      bridge.callTimeoutMs,
    );
    if (exchange.kind === 'answer' && exchange.payload.v === 1 && exchange.payload.ack === cseq) {
      return;
    }
    throw this.stageFailure(stage, exchange);
  }

  /** One poll: queues the frames in order, and notes a server close. */
  private async poll(
    bridge: StatusBridgePort<Namespace, Stub>,
    session: BridgeSession<Stub>,
    stage: RoomsStage,
    waitMs: number,
    waitUntil: number,
  ): Promise<void> {
    session.requestEpoch += 1;
    const exchange = await this.exchange(
      bridge,
      session,
      'poll',
      { v: 1, requestEpoch: session.requestEpoch, ack: session.serverAck, waitMs },
      bridge.pollTimeoutMs,
      waitUntil,
    );
    if (exchange.kind !== 'answer') throw this.stageFailure(stage, exchange);
    const { payload } = exchange;
    if (payload.v !== 1 || !Array.isArray(payload.events)) {
      throw this.stageFailure(stage, exchange);
    }
    for (const event of payload.events as unknown[]) {
      const frame =
        isJsonObject(event) &&
        event.sseq === session.serverAck + 1 &&
        typeof event.data === 'string'
          ? parseJson(event.data)
          : undefined;
      if (!isJsonObject(frame)) throw this.stageFailure(stage, exchange);
      session.serverAck += 1;
      session.queued.push(frame);
    }
    // The room's last frames (a refusal, say) arrive with the terminal; the
    // waits read them first and only then fail on the close.
    if (payload.terminal !== undefined) session.closedByServer = true;
  }

  /**
   * The first frame that matches, waiting at most STATUS_ROOMS_FRAME_WAIT_MS
   * with polls of STATUS_ROOMS_POLL_WAIT_MS. An error frame is a refusal
   * (id-taken on the host sends the check to another code), a server close
   * without the frame is a refusal that may be retried, and an expired wait
   * is the stage's timeout.
   */
  private async waitFor(
    bridge: StatusBridgePort<Namespace, Stub>,
    session: BridgeSession<Stub>,
    stage: RoomsStage,
    matches: (frame: JsonObject) => boolean,
  ): Promise<JsonObject> {
    const waitUntil = this.now() + STATUS_ROOMS_FRAME_WAIT_MS;
    for (;;) {
      const index = session.queued.findIndex(matches);
      const [frame] = index >= 0 ? session.queued.splice(index, 1) : [];
      if (frame) return frame;
      const error = session.queued.find((queued) => queued.type === 'error');
      if (error) {
        throw new RoomsStageStop(
          stage.nextCodeOn !== null && error.errorType === stage.nextCodeOn
            ? NEXT_CODE
            : failed(stage.refused, false),
        );
      }
      if (session.closedByServer) throw new RoomsStageStop(failed(stage.refused, true));
      // The poll's own race ends the wait: once the time is up it is not sent.
      const remainingMs = Math.floor(Math.min(waitUntil, this.deadlineAt) - this.now());
      await this.poll(
        bridge,
        session,
        stage,
        Math.max(0, Math.min(STATUS_ROOMS_POLL_WAIT_MS, remainingMs)),
        waitUntil,
      );
    }
  }

  /**
   * Best effort, guest first as the release smoke closes them. The requests
   * go out even after the deadline and are then not awaited; the bridge
   * lease ends whatever a lost close leaves.
   */
  private async closeSessions(
    bridge: StatusBridgePort<Namespace, Stub>,
    sessions: readonly BridgeSession<Stub>[],
  ): Promise<void> {
    if (sessions.length === 0) return;
    const closing = [...sessions].reverse().map((session) =>
      Promise.resolve()
        .then(() =>
          bridge.call(session.stub, 'close', { ...session.envelope }, bridge.callTimeoutMs),
        )
        .catch(() => null),
    );
    try {
      await this.untilDeadline(() => Promise.all(closing));
    } catch {
      // The deadline came first; the closes are already on their way.
    }
  }
}

/**
 * One status cron run: the rooms and pro rows of the server slot of
 * scheduledTimeMs, recorded with source 'cron', then a prune of results older
 * than STATUS_RESULT_RETENTION_MS. It never rejects, and it settles within
 * STATUS_ROOMS_CHECK_DEADLINE_MS of its start whatever its dependencies do.
 */
export async function runStatusServerChecks<Namespace, Stub>(
  deps: StatusServerCheckDeps<Namespace, Stub>,
): Promise<void> {
  const { record, prune } = deps;
  // Without the admin DB there is nowhere to keep a result: do nothing at all.
  if (!record || !prune) return;
  try {
    await new StatusServerCheckRun(deps, record, prune).run();
  } catch {
    warnQuietly(deps, 'status_check_error', {});
  }
}
