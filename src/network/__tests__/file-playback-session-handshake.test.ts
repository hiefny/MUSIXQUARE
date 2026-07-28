import { describe, expect, it } from 'vitest';

import {
  FILE_PLAYBACK_SESSION_APPLIED_TYPE,
  FILE_PLAYBACK_SESSION_HELLO_TYPE,
  FILE_PLAYBACK_SESSION_MAX_ID_LENGTH,
  FILE_PLAYBACK_SESSION_MAX_MESSAGE_BYTES,
  FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
  FILE_PLAYBACK_SESSION_SNAPSHOT_SEQUENCE,
  FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE,
  FILE_PLAYBACK_SESSION_WELCOME_TYPE,
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHostSessionHandshake,
  createSecureFilePlaybackHandshakeId,
  isFilePlaybackSessionSemanticCohortMismatchV2,
  parseFilePlaybackSessionMessageV2,
  serializeFilePlaybackSessionMessageV2,
  snapshotFilePlaybackSessionHelloCandidateV2,
  type FilePlaybackSessionAppliedV2,
  type FilePlaybackSessionHelloV2,
  type FilePlaybackSessionSnapshotV2,
  type FilePlaybackSessionWelcomeV2,
} from '../file-playback-session-handshake.ts';
import {
  FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
  FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
} from '../../player/file-playback-semantic-cohort.ts';

const SCOPE = Object.freeze({
  sessionId: 'session-0000000000000001',
  connectionId: 'connection-00000000000001',
  hostParticipantId: 'host-peer-1',
  guestParticipantId: 'guest-peer-1',
});

function deterministicIssuer(
  overrides: {
    createSessionId?: () => string;
    createConnectionId?: () => string;
    createHelloId?: () => string;
  } = {},
) {
  let sessionIndex = 0;
  let connectionIndex = 0;
  let helloIndex = 0;
  return new FilePlaybackHandshakeIdIssuer({
    createSessionId:
      overrides.createSessionId ??
      (() => (sessionIndex++ === 0 ? SCOPE.sessionId : `session-${sessionIndex}`)),
    createConnectionId:
      overrides.createConnectionId ??
      (() => (connectionIndex++ === 0 ? SCOPE.connectionId : `connection-${connectionIndex}`)),
    createHelloId:
      overrides.createHelloId ??
      (() => (helloIndex++ === 0 ? 'hello-000000000000000001' : `hello-${helloIndex}`)),
  });
}

function pair(
  hostSemanticPlaybackCohortId: string = FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
  guestSemanticPlaybackCohortId: string = FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
) {
  const hostIssuer = deterministicIssuer();
  const guestIssuer = deterministicIssuer();
  const sessionId = hostIssuer.issueSessionId();
  const connectionId = hostIssuer.issueConnectionId();
  return {
    host: new FilePlaybackHostSessionHandshake({
      idIssuer: hostIssuer,
      sessionId,
      connectionId,
      hostParticipantId: SCOPE.hostParticipantId,
      guestParticipantId: SCOPE.guestParticipantId,
      semanticPlaybackCohortId: hostSemanticPlaybackCohortId,
    }),
    guest: new FilePlaybackGuestSessionHandshake({
      idIssuer: guestIssuer,
      guestParticipantId: SCOPE.guestParticipantId,
      semanticPlaybackCohortId: guestSemanticPlaybackCohortId,
    }),
    hostIssuer,
    guestIssuer,
    sessionId,
    connectionId,
  };
}

function unwrap<Message>(
  result: { accepted: true } & Message,
  key: keyof Message,
): Message[keyof Message] {
  expect(result.accepted).toBe(true);
  return result[key];
}

function throughWelcome() {
  const { host, guest } = pair();
  const helloResult = guest.createHello();
  if (!helloResult.accepted) throw new Error(helloResult.reason);
  const welcomeResult = host.handleHello(helloResult.hello);
  if (!welcomeResult.accepted) throw new Error(welcomeResult.reason);
  const bindingResult = guest.handleWelcome(welcomeResult.welcome);
  if (!bindingResult.accepted) throw new Error(bindingResult.reason);
  return { host, guest, hello: helloResult.hello, welcome: welcomeResult.welcome };
}

describe('file playback application-session handshake', () => {
  it('establishes HELLO -> WELCOME -> ordered SNAPSHOT -> APPLIED exactly once', () => {
    const { host, guest } = pair();

    const helloResult = guest.createHello();
    expect(helloResult).toMatchObject({ accepted: true });
    if (!helloResult.accepted) throw new Error(helloResult.reason);
    expect(guest.state()).toBe('hello-issued');

    const welcomeResult = host.handleHello(helloResult.hello);
    expect(welcomeResult).toMatchObject({ accepted: true });
    if (!welcomeResult.accepted) throw new Error(welcomeResult.reason);
    expect(host.state()).toBe('welcome-issued');

    expect(guest.handleWelcome(welcomeResult.welcome)).toEqual({ accepted: true });
    expect(guest.state()).toBe('welcome-accepted');
    expect(guest.provisionalBinding()).toEqual(host.provisionalBinding());
    expect(guest.establishedBinding()).toBeNull();
    expect(host.establishedBinding()).toBeNull();

    // The product adapter sends its existing queue bootstrap here, before
    // creating this marker on the same reliable ordered lane.
    const snapshotResult = host.createSnapshot();
    expect(snapshotResult).toMatchObject({ accepted: true });
    if (!snapshotResult.accepted) throw new Error(snapshotResult.reason);
    expect(host.state()).toBe('snapshot-issued');

    expect(guest.acceptSnapshot(snapshotResult.snapshot)).toEqual({ accepted: true });
    expect(guest.state()).toBe('snapshot-accepted');
    expect(guest.establishedBinding()).toBeNull();
    expect(host.establishedBinding()).toBeNull();

    const appliedResult = guest.createApplied();
    if (!appliedResult.accepted) throw new Error(appliedResult.reason);
    expect(guest.state()).toBe('applied-issued');
    expect(guest.establishedBinding()).toEqual(guest.provisionalBinding());
    expect(host.establishedBinding()).toBeNull();
    expect(appliedResult.applied).toEqual({
      ...snapshotResult.snapshot,
      type: FILE_PLAYBACK_SESSION_APPLIED_TYPE,
    });

    expect(host.handleApplied(appliedResult.applied)).toMatchObject({
      accepted: true,
      binding: SCOPE,
    });
    expect(host.state()).toBe('applied');
    expect(host.establishedBinding()).toEqual(host.provisionalBinding());

    expect(guest.createHello()).toEqual({ accepted: false, reason: 'wrong-state' });
    expect(host.handleHello(helloResult.hello)).toEqual({
      accepted: false,
      reason: 'wrong-state',
    });
    expect(host.createSnapshot()).toEqual({ accepted: false, reason: 'wrong-state' });
    expect(guest.acceptSnapshot(snapshotResult.snapshot)).toEqual({
      accepted: false,
      reason: 'wrong-state',
    });
    expect(guest.createApplied()).toEqual({ accepted: false, reason: 'wrong-state' });
    expect(host.handleApplied(appliedResult.applied)).toEqual({
      accepted: false,
      reason: 'wrong-state',
    });
  });

  it('creates frozen null-prototype canonical messages and results', () => {
    const { host, guest } = pair();
    const helloResult = guest.createHello();
    if (!helloResult.accepted) throw new Error(helloResult.reason);
    const welcomeResult = host.handleHello(helloResult.hello);
    if (!welcomeResult.accepted) throw new Error(welcomeResult.reason);

    for (const value of [
      helloResult,
      helloResult.hello,
      welcomeResult,
      welcomeResult.welcome,
      host.provisionalBinding(),
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.getPrototypeOf(value)).toBeNull();
    }

    const parsed = parseFilePlaybackSessionMessageV2({ ...welcomeResult.welcome });
    expect(parsed).toEqual(welcomeResult.welcome);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
  });

  it('uses exact own-enumerable schemas for all four frame types', () => {
    const hello: FilePlaybackSessionHelloV2 = {
      type: FILE_PLAYBACK_SESSION_HELLO_TYPE,
      version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
      semanticPlaybackCohortId: FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
      helloId: 'hello-1',
      guestParticipantId: 'guest-1',
    };
    const welcome: FilePlaybackSessionWelcomeV2 = {
      type: FILE_PLAYBACK_SESSION_WELCOME_TYPE,
      version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
      semanticPlaybackCohortId: FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
      ...SCOPE,
      helloId: hello.helloId,
    };
    const snapshot: FilePlaybackSessionSnapshotV2 = {
      ...welcome,
      type: FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE,
      snapshotSequence: FILE_PLAYBACK_SESSION_SNAPSHOT_SEQUENCE,
    };
    const applied: FilePlaybackSessionAppliedV2 = {
      ...snapshot,
      type: FILE_PLAYBACK_SESSION_APPLIED_TYPE,
    };

    for (const message of [hello, welcome, snapshot, applied]) {
      expect(parseFilePlaybackSessionMessageV2(message)).toEqual(message);
      expect(parseFilePlaybackSessionMessageV2({ ...message, extra: true })).toBeNull();

      const withSymbol = { ...message } as Record<PropertyKey, unknown>;
      withSymbol[Symbol('extra')] = true;
      expect(parseFilePlaybackSessionMessageV2(withSymbol)).toBeNull();

      const hidden = { ...message };
      Object.defineProperty(hidden, 'type', { enumerable: false });
      expect(parseFilePlaybackSessionMessageV2(hidden)).toBeNull();
    }
  });

  it('never invokes accessors or [[Get]] and reads admitted descriptors once', () => {
    let accessorReads = 0;
    const accessor = {
      type: FILE_PLAYBACK_SESSION_HELLO_TYPE,
      version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
      semanticPlaybackCohortId: FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
      get helloId() {
        accessorReads += 1;
        return 'hello-accessor';
      },
      guestParticipantId: 'guest-accessor',
    };
    expect(parseFilePlaybackSessionMessageV2(accessor)).toBeNull();
    expect(accessorReads).toBe(0);

    const descriptorReads = new Map<PropertyKey, number>();
    const target: FilePlaybackSessionHelloV2 = {
      type: FILE_PLAYBACK_SESSION_HELLO_TYPE,
      version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
      semanticPlaybackCohortId: FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
      helloId: 'hello-proxy',
      guestParticipantId: 'guest-proxy',
    };
    const hostile = new Proxy(target, {
      get() {
        throw new Error('wire values must not be read through [[Get]]');
      },
      getOwnPropertyDescriptor(object, property) {
        descriptorReads.set(property, (descriptorReads.get(property) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(object, property);
      },
    });
    expect(parseFilePlaybackSessionMessageV2(hostile)).toEqual(target);
    expect(descriptorReads).toEqual(
      new Map<PropertyKey, number>([
        ['type', 1],
        ['guestParticipantId', 1],
        ['helloId', 1],
        ['semanticPlaybackCohortId', 1],
        ['version', 1],
      ]),
    );
  });

  it('is immune to Object.prototype value and toJSON pollution', () => {
    const originalValue = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
    const originalToJson = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    let pollutionReads = 0;
    const valuePollution = Object.assign(Object.create(null), {
      configurable: true,
      get() {
        pollutionReads += 1;
        return 'polluted';
      },
    }) as PropertyDescriptor;
    const toJsonPollution = Object.assign(Object.create(null), {
      configurable: true,
      get() {
        pollutionReads += 1;
        return () => ({});
      },
    }) as PropertyDescriptor;
    let result: ReturnType<typeof parseFilePlaybackSessionMessageV2>;
    let serialized: string;
    try {
      Object.defineProperty(Object.prototype, 'toJSON', toJsonPollution);
      Object.defineProperty(Object.prototype, 'value', valuePollution);
      const message = Object.assign(Object.create(null), {
        type: FILE_PLAYBACK_SESSION_HELLO_TYPE,
        version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
        semanticPlaybackCohortId: FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
        helloId: 'hello-pollution',
        guestParticipantId: 'guest-pollution',
      });
      result = parseFilePlaybackSessionMessageV2(message);
      serialized = serializeFilePlaybackSessionMessageV2(message);
    } finally {
      if (originalValue) Object.defineProperty(Object.prototype, 'value', originalValue);
      else Reflect.deleteProperty(Object.prototype, 'value');
      if (originalToJson) Object.defineProperty(Object.prototype, 'toJSON', originalToJson);
      else Reflect.deleteProperty(Object.prototype, 'toJSON');
    }
    expect(result).not.toBeNull();
    expect(serialized).toContain('hello-pollution');
    expect(pollutionReads).toBe(0);
  });

  it('bounds opaque identifiers and aggregate UTF-8 wire bytes', () => {
    const base: FilePlaybackSessionWelcomeV2 = {
      type: FILE_PLAYBACK_SESSION_WELCOME_TYPE,
      version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
      semanticPlaybackCohortId: FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
      ...SCOPE,
      helloId: 'hello-bounds',
    };
    expect(parseFilePlaybackSessionMessageV2({ ...base, helloId: '' })).toBeNull();
    expect(
      parseFilePlaybackSessionMessageV2({
        ...base,
        helloId: `h${'x'.repeat(FILE_PLAYBACK_SESSION_MAX_ID_LENGTH)}`,
      }),
    ).toBeNull();
    expect(parseFilePlaybackSessionMessageV2({ ...base, helloId: 'bad id' })).toBeNull();
    expect(parseFilePlaybackSessionMessageV2({ ...base, helloId: 'bad\n-id' })).toBeNull();

    const wide = `x${'a'.repeat(126)}`;
    const overBudget = {
      ...base,
      sessionId: `s${wide}`,
      connectionId: `c${wide}`,
      helloId: `h${wide}`,
      hostParticipantId: `p${wide}`,
      guestParticipantId: `g${wide}`,
    };
    expect(new TextEncoder().encode(JSON.stringify(overBudget)).byteLength).toBeGreaterThan(
      FILE_PLAYBACK_SESSION_MAX_MESSAGE_BYTES,
    );
    expect(parseFilePlaybackSessionMessageV2(overBudget)).toBeNull();
    expect(() => serializeFilePlaybackSessionMessageV2(overBudget)).toThrow(/invalid/);

    const hostIssuer = deterministicIssuer({
      createSessionId: () => overBudget.sessionId,
      createConnectionId: () => overBudget.connectionId,
    });
    const guestIssuer = deterministicIssuer({ createHelloId: () => overBudget.helloId });
    const host = new FilePlaybackHostSessionHandshake({
      idIssuer: hostIssuer,
      sessionId: hostIssuer.issueSessionId(),
      connectionId: hostIssuer.issueConnectionId(),
      hostParticipantId: overBudget.hostParticipantId,
      guestParticipantId: overBudget.guestParticipantId,
    });
    const guest = new FilePlaybackGuestSessionHandshake({
      idIssuer: guestIssuer,
      guestParticipantId: overBudget.guestParticipantId,
    });
    const hello = guest.createHello();
    if (!hello.accepted) throw new Error(hello.reason);
    expect(host.handleHello(hello.hello)).toEqual({
      accepted: false,
      reason: 'message-too-large',
    });
    expect(host.state()).toBe('awaiting-hello');
  });

  it('does not mutate state for malformed or mismatched frames', () => {
    const { host, guest } = pair();
    const helloResult = guest.createHello();
    if (!helloResult.accepted) throw new Error(helloResult.reason);

    expect(host.handleHello({ ...helloResult.hello, guestParticipantId: 'other-guest' })).toEqual({
      accepted: false,
      reason: 'wrong-guest-participant',
    });
    expect(host.state()).toBe('awaiting-hello');
    expect(host.handleHello({ ...helloResult.hello, extra: true })).toEqual({
      accepted: false,
      reason: 'malformed-message',
    });
    expect(host.state()).toBe('awaiting-hello');

    const welcomeResult = host.handleHello(helloResult.hello);
    if (!welcomeResult.accepted) throw new Error(welcomeResult.reason);
    expect(guest.handleWelcome({ ...welcomeResult.welcome, helloId: 'wrong-hello' })).toEqual({
      accepted: false,
      reason: 'wrong-hello',
    });
    expect(guest.state()).toBe('hello-issued');
    expect(guest.handleWelcome(welcomeResult.welcome)).toMatchObject({ accepted: true });
  });

  it.each([
    [
      'current guest -> universal host',
      FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
      FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
    ],
    [
      'universal guest -> current host',
      FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
      FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
    ],
  ] as const)(
    'fails closed before publishing a binding for %s',
    (_label, hostCohort, guestCohort) => {
      const { host, guest } = pair(hostCohort, guestCohort);
      const hello = guest.createHello();
      if (!hello.accepted) throw new Error(hello.reason);

      expect(host.handleHello(hello.hello)).toEqual({
        accepted: false,
        reason: 'semantic-playback-cohort-mismatch',
      });
      expect(host.state()).toBe('awaiting-hello');
      expect(host.provisionalBinding()).toBeNull();
    },
  );

  it('rejects a mismatched host echo before the guest publishes a binding', () => {
    const { host, guest } = pair(
      FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
      FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
    );
    const hello = guest.createHello();
    if (!hello.accepted) throw new Error(hello.reason);
    const welcome = host.handleHello(hello.hello);
    if (!welcome.accepted) throw new Error(welcome.reason);

    expect(
      guest.handleWelcome({
        ...welcome.welcome,
        semanticPlaybackCohortId: FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
      }),
    ).toEqual({ accepted: false, reason: 'semantic-playback-cohort-mismatch' });
    expect(guest.state()).toBe('hello-issued');
    expect(guest.provisionalBinding()).toBeNull();
  });

  it('classifies exact pre-cohort V2 HELLO and WELCOME as update-boundary mismatches', () => {
    const { host, guest } = pair();
    const hello = guest.createHello();
    if (!hello.accepted) throw new Error(hello.reason);
    const { semanticPlaybackCohortId: _guestCohort, ...preCohortHello } = hello.hello;

    expect(host.handleHello(preCohortHello)).toEqual({
      accepted: false,
      reason: 'semantic-playback-cohort-mismatch',
    });
    expect(host.state()).toBe('awaiting-hello');

    const welcome = host.handleHello(hello.hello);
    if (!welcome.accepted) throw new Error(welcome.reason);
    const { semanticPlaybackCohortId: _hostCohort, ...preCohortWelcome } = welcome.welcome;
    expect(guest.handleWelcome(preCohortWelcome)).toEqual({
      accepted: false,
      reason: 'semantic-playback-cohort-mismatch',
    });
    expect(guest.state()).toBe('hello-issued');
    expect(guest.provisionalBinding()).toBeNull();
  });

  it('detaches only exact HELLO candidates and classifies cohort mismatches without widening malformed input', () => {
    const { guest } = pair();
    const hello = guest.createHello();
    if (!hello.accepted) throw new Error(hello.reason);
    const { semanticPlaybackCohortId: _cohort, ...preCohortHello } = hello.hello;

    expect(snapshotFilePlaybackSessionHelloCandidateV2(hello.hello)).toEqual(hello.hello);
    expect(
      isFilePlaybackSessionSemanticCohortMismatchV2(
        hello.hello,
        FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
      ),
    ).toBe(false);
    expect(
      isFilePlaybackSessionSemanticCohortMismatchV2(
        hello.hello,
        FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
      ),
    ).toBe(true);
    expect(snapshotFilePlaybackSessionHelloCandidateV2(preCohortHello)).toEqual(preCohortHello);
    expect(
      isFilePlaybackSessionSemanticCohortMismatchV2(
        preCohortHello,
        FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
      ),
    ).toBe(true);

    const extraKey = { ...preCohortHello, extra: true };
    expect(snapshotFilePlaybackSessionHelloCandidateV2(extraKey)).toBeNull();
    expect(
      isFilePlaybackSessionSemanticCohortMismatchV2(
        extraKey,
        FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
      ),
    ).toBe(false);

    let accessorReads = 0;
    const accessor = { ...preCohortHello } as Record<string, unknown>;
    Object.defineProperty(accessor, 'helloId', {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return preCohortHello.helloId;
      },
    });
    expect(snapshotFilePlaybackSessionHelloCandidateV2(accessor)).toBeNull();
    expect(
      isFilePlaybackSessionSemanticCohortMismatchV2(
        accessor,
        FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
      ),
    ).toBe(false);
    expect(accessorReads).toBe(0);
  });

  it.each([
    ['helloId', 'wrong-hello', 'wrong-hello'],
    ['sessionId', 'wrong-session', 'wrong-session'],
    ['connectionId', 'wrong-connection', 'wrong-connection'],
    ['hostParticipantId', 'wrong-host', 'wrong-host-participant'],
    ['guestParticipantId', 'wrong-guest', 'wrong-guest-participant'],
  ] as const)('rejects snapshot correlation mismatch in %s', (field, value, reason) => {
    const { host, guest } = throughWelcome();
    const result = host.createSnapshot();
    if (!result.accepted) throw new Error(result.reason);
    expect(guest.acceptSnapshot({ ...result.snapshot, [field]: value })).toEqual({
      accepted: false,
      reason,
    });
    expect(guest.state()).toBe('welcome-accepted');
    expect(guest.acceptSnapshot(result.snapshot)).toEqual({ accepted: true });
  });

  it('rejects APPLIED from another exact session without consuming the marker', () => {
    const { host, guest } = throughWelcome();
    const snapshot = host.createSnapshot();
    if (!snapshot.accepted) throw new Error(snapshot.reason);
    expect(guest.acceptSnapshot(snapshot.snapshot)).toEqual({ accepted: true });
    const applied = guest.createApplied();
    if (!applied.accepted) throw new Error(applied.reason);

    expect(host.handleApplied({ ...applied.applied, connectionId: 'connection-other' })).toEqual({
      accepted: false,
      reason: 'wrong-connection',
    });
    expect(host.state()).toBe('snapshot-issued');
    expect(host.handleApplied(applied.applied)).toMatchObject({ accepted: true });
  });

  it('blocks hostile Proxy re-entry instead of advancing two transitions', () => {
    const { host, guest } = pair();
    const helloResult = guest.createHello();
    if (!helloResult.accepted) throw new Error(helloResult.reason);
    let nested: ReturnType<typeof host.handleHello> | null = null;
    let reentered = false;
    const hostileHello = new Proxy(helloResult.hello, {
      ownKeys(target) {
        if (!reentered) {
          reentered = true;
          nested = host.handleHello(target);
        }
        return Reflect.ownKeys(target);
      },
    });
    const outer = host.handleHello(hostileHello);
    expect(outer).toMatchObject({ accepted: true });
    expect(nested).toEqual({ accepted: false, reason: 'reentrant-call' });
    expect(host.state()).toBe('welcome-issued');

    if (!outer.accepted) throw new Error(outer.reason);
    let welcomeNested: ReturnType<typeof guest.handleWelcome> | null = null;
    reentered = false;
    const hostileWelcome = new Proxy(outer.welcome, {
      getOwnPropertyDescriptor(target, property) {
        if (!reentered) {
          reentered = true;
          welcomeNested = guest.handleWelcome(target);
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(guest.handleWelcome(hostileWelcome)).toMatchObject({ accepted: true });
    expect(welcomeNested).toEqual({ accepted: false, reason: 'reentrant-call' });
    expect(guest.state()).toBe('welcome-accepted');

    const snapshot = host.createSnapshot();
    if (!snapshot.accepted) throw new Error(snapshot.reason);
    let snapshotNested: ReturnType<typeof guest.acceptSnapshot> | null = null;
    reentered = false;
    const hostileSnapshot = new Proxy(snapshot.snapshot, {
      ownKeys(target) {
        if (!reentered) {
          reentered = true;
          snapshotNested = guest.acceptSnapshot(target);
        }
        return Reflect.ownKeys(target);
      },
    });
    expect(guest.acceptSnapshot(hostileSnapshot)).toEqual({ accepted: true });
    expect(snapshotNested).toEqual({ accepted: false, reason: 'reentrant-call' });

    const applied = guest.createApplied();
    if (!applied.accepted) throw new Error(applied.reason);
    let appliedNested: ReturnType<typeof host.handleApplied> | null = null;
    reentered = false;
    const hostileApplied = new Proxy(applied.applied, {
      getOwnPropertyDescriptor(target, property) {
        if (!reentered) {
          reentered = true;
          appliedNested = host.handleApplied(target);
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(host.handleApplied(hostileApplied)).toMatchObject({ accepted: true });
    expect(appliedNested).toEqual({ accepted: false, reason: 'reentrant-call' });
    expect(host.state()).toBe('applied');
  });

  it('fails atomically for invalid constructor scopes without invoking accessors', () => {
    const issuer = deterministicIssuer();
    const sessionId = issuer.issueSessionId();
    const connectionId = issuer.issueConnectionId();
    let reads = 0;
    expect(
      () =>
        new FilePlaybackHostSessionHandshake({
          idIssuer: issuer,
          get sessionId() {
            reads += 1;
            return sessionId;
          },
          connectionId,
          hostParticipantId: SCOPE.hostParticipantId,
          guestParticipantId: SCOPE.guestParticipantId,
        }),
    ).toThrow(/scope is invalid/);
    expect(reads).toBe(0);

    // The rejected accessor options did not consume the connection token.
    expect(
      new FilePlaybackHostSessionHandshake({
        idIssuer: issuer,
        sessionId,
        connectionId,
        hostParticipantId: SCOPE.hostParticipantId,
        guestParticipantId: SCOPE.guestParticipantId,
      }).state(),
    ).toBe('awaiting-hello');

    const otherIssuer = deterministicIssuer();
    expect(
      () =>
        new FilePlaybackHostSessionHandshake({
          idIssuer: otherIssuer,
          sessionId,
          connectionId: otherIssuer.issueConnectionId(),
          hostParticipantId: SCOPE.hostParticipantId,
          guestParticipantId: SCOPE.guestParticipantId,
        }),
    ).toThrow(/ID authority is invalid/);

    const forgedIssuer = deterministicIssuer();
    const forgedConnection = forgedIssuer.issueConnectionId();
    expect(
      () =>
        new FilePlaybackHostSessionHandshake({
          idIssuer: forgedIssuer,
          sessionId: { ...forgedIssuer.issueSessionId() } as ReturnType<
            typeof forgedIssuer.issueSessionId
          >,
          connectionId: forgedConnection,
          hostParticipantId: SCOPE.hostParticipantId,
          guestParticipantId: SCOPE.guestParticipantId,
        }),
    ).toThrow(/ID authority is invalid/);

    const participantIssuer = deterministicIssuer();
    const participantSession = participantIssuer.issueSessionId();
    const participantConnection = participantIssuer.issueConnectionId();
    expect(
      () =>
        new FilePlaybackHostSessionHandshake({
          idIssuer: participantIssuer,
          sessionId: participantSession,
          connectionId: participantConnection,
          hostParticipantId: SCOPE.hostParticipantId,
          guestParticipantId: SCOPE.hostParticipantId,
        }),
    ).toThrow(/scope is invalid/);
    expect(
      new FilePlaybackHostSessionHandshake({
        idIssuer: participantIssuer,
        sessionId: participantSession,
        connectionId: participantConnection,
        hostParticipantId: SCOPE.hostParticipantId,
        guestParticipantId: SCOPE.guestParticipantId,
      }).state(),
    ).toBe('awaiting-hello');
  });

  it('generates one fresh internal hello ID and tombstones every issuer ID', () => {
    let helloCalls = 0;
    const issuer = deterministicIssuer({
      createHelloId: () => {
        helloCalls += 1;
        return 'hello-internal-once';
      },
    });
    const guest = new FilePlaybackGuestSessionHandshake({
      idIssuer: issuer,
      guestParticipantId: SCOPE.guestParticipantId,
    });
    expect(helloCalls).toBe(1);
    const hello = guest.createHello();
    expect(helloCalls).toBe(1);
    expect(hello).toMatchObject({
      accepted: true,
      hello: { helloId: 'hello-internal-once' },
    });

    expect(
      () =>
        new FilePlaybackGuestSessionHandshake({
          idIssuer: issuer,
          guestParticipantId: SCOPE.guestParticipantId,
        }),
    ).toThrow(/hello ID authority is invalid/);
    expect(helloCalls).toBe(2);
  });

  it('allows one session token across connections but claims each connection token once', () => {
    const issuer = deterministicIssuer();
    const sessionId = issuer.issueSessionId();
    const firstConnection = issuer.issueConnectionId();
    const options = {
      idIssuer: issuer,
      sessionId,
      connectionId: firstConnection,
      hostParticipantId: SCOPE.hostParticipantId,
      guestParticipantId: SCOPE.guestParticipantId,
    };
    expect(new FilePlaybackHostSessionHandshake(options).state()).toBe('awaiting-hello');
    expect(() => new FilePlaybackHostSessionHandshake(options)).toThrow(/ID authority is invalid/);

    const secondConnection = issuer.issueConnectionId();
    expect(
      new FilePlaybackHostSessionHandshake({ ...options, connectionId: secondConnection }).state(),
    ).toBe('awaiting-hello');
  });

  it('uses CSPRNG-only IDs and fails closed when secure randomness is unavailable', () => {
    expect(() => createSecureFilePlaybackHandshakeId(null)).toThrow(/Secure randomness/);

    const fallback = createSecureFilePlaybackHandshakeId({
      getRandomValues(array) {
        array.fill(0x11);
        return array;
      },
    });
    expect(fallback).toBe('fp-11111111-1111-4111-9111-111111111111');

    const issuer = new FilePlaybackHandshakeIdIssuer();
    const values = [
      issuer.issueSessionId().value,
      issuer.issueConnectionId().value,
      issuer.issueHelloId().value,
    ];
    expect(new Set(values).size).toBe(3);
    expect(values.every((value) => value.startsWith('fp-'))).toBe(true);
  });

  it('waits for the asynchronous queue apply chain before explicitly creating APPLIED', async () => {
    const { host, guest } = throughWelcome();
    const snapshot = host.createSnapshot();
    if (!snapshot.accepted) throw new Error(snapshot.reason);

    let finishApply!: () => void;
    const queueApply = new Promise<void>((resolve) => {
      finishApply = resolve;
    });
    let applied: ReturnType<typeof guest.createApplied> | null = null;
    const adapter = (async () => {
      expect(guest.acceptSnapshot(snapshot.snapshot)).toEqual({ accepted: true });
      await queueApply;
      applied = guest.createApplied();
    })();

    await Promise.resolve();
    expect(guest.state()).toBe('snapshot-accepted');
    expect(guest.establishedBinding()).toBeNull();
    expect(applied).toBeNull();

    finishApply();
    await adapter;
    expect(applied).toMatchObject({ accepted: true });
    expect(guest.establishedBinding()).toEqual(guest.provisionalBinding());
  });

  it('keeps the serialized adapter form canonical and within the byte budget', () => {
    const { welcome } = throughWelcome();
    const serialized = serializeFilePlaybackSessionMessageV2(welcome);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
      FILE_PLAYBACK_SESSION_MAX_MESSAGE_BYTES,
    );
    expect(JSON.parse(serialized)).toEqual(welcome);

    // Keep this helper used as an API-shape assertion for adapter authors.
    const value = unwrap({ accepted: true as const, welcome }, 'welcome');
    expect(value).toBe(welcome);
  });
});
