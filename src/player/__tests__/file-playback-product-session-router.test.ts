import { describe, expect, it, vi } from 'vitest';

import type {
  FilePlaybackApplicationLifecycleEvent,
  FilePlaybackAuxiliaryAdoptionEvent,
  FilePlaybackPeerRangeAdoptionEvent,
  FilePlaybackWireAdoptionEvent,
} from '../../network/file-playback-application-session.ts';
import { FilePlaybackConnectionChannel } from '../../network/file-playback-connection-channel.ts';
import {
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackHostSessionHandshake,
} from '../../network/file-playback-session-handshake.ts';
import {
  FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_READY_V2_TYPE,
  FILE_PLAYBACK_RUN_BINDING_V2_TYPE,
  FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE,
} from '../../network/file-playback-transport-contract.ts';
import type { DataConnection } from '../../types/index.ts';
import { createStoppedPlaybackTimeline } from '../playback-timeline.ts';
import {
  FilePlaybackProductSessionRouter,
  type FilePlaybackProductSessionRouterConnectionContext,
  type FilePlaybackProductSessionRouterControllerPort,
  type FilePlaybackProductSessionRouterGuestMediaOwnerPort,
  type FilePlaybackProductSessionRouterHostMediaOwnerPort,
} from '../file-playback-product-session-router.ts';

interface ChannelPair {
  readonly hostConnection: DataConnection;
  readonly guestConnection: DataConnection;
  readonly host: FilePlaybackConnectionChannel;
  readonly guest: FilePlaybackConnectionChannel;
}

interface HostOwnerHarness {
  readonly context: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
  readonly port: FilePlaybackProductSessionRouterHostMediaOwnerPort;
  readonly wire: ReturnType<typeof vi.fn>;
  readonly control: ReturnType<typeof vi.fn>;
  readonly revoke: ReturnType<typeof vi.fn>;
}

interface GuestOwnerHarness {
  readonly context: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
  readonly port: FilePlaybackProductSessionRouterGuestMediaOwnerPort;
  readonly auxiliary: ReturnType<typeof vi.fn>;
  readonly wire: ReturnType<typeof vi.fn>;
  readonly bulk: ReturnType<typeof vi.fn>;
  readonly revoke: ReturnType<typeof vi.fn>;
}

interface RouterHarnessOptions {
  readonly controller?: FilePlaybackProductSessionRouterControllerPort;
  readonly createHostMediaOwner?: (
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  ) => FilePlaybackProductSessionRouterHostMediaOwnerPort;
  readonly createGuestMediaOwner?: (
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  ) => FilePlaybackProductSessionRouterGuestMediaOwnerPort;
}

interface RouterHarness {
  readonly router: FilePlaybackProductSessionRouter;
  readonly events: string[];
  readonly controllerLifecycle: ReturnType<typeof vi.fn>;
  readonly controllerAuxiliary: ReturnType<typeof vi.fn>;
  readonly hostOwners: HostOwnerHarness[];
  readonly guestOwners: GuestOwnerHarness[];
}

let sequence = 0;

function connection(peer: string): DataConnection {
  return {
    peer,
    open: true,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as DataConnection;
}

function issuer(prefix: string): FilePlaybackHandshakeIdIssuer {
  return new FilePlaybackHandshakeIdIssuer({
    createSessionId: () => `${prefix}-session`,
    createConnectionId: () => `${prefix}-connection`,
    createHelloId: () => `${prefix}-hello`,
  });
}

function channelPair(
  overrides: Partial<Pick<ChannelPair, 'hostConnection' | 'guestConnection'>> = {},
): ChannelPair {
  const prefix = `product-router-${++sequence}`;
  const hostIds = issuer(`${prefix}-host`);
  const guestIds = issuer(`${prefix}-guest`);
  const hostHandshake = new FilePlaybackHostSessionHandshake({
    idIssuer: hostIds,
    sessionId: hostIds.issueSessionId(),
    connectionId: hostIds.issueConnectionId(),
    hostParticipantId: `${prefix}-host-participant`,
    guestParticipantId: `${prefix}-guest-participant`,
  });
  const guestHandshake = new FilePlaybackGuestSessionHandshake({
    idIssuer: guestIds,
    guestParticipantId: `${prefix}-guest-participant`,
  });
  const hello = guestHandshake.createHello();
  if (!hello.accepted) throw new Error(hello.reason);
  const welcome = hostHandshake.handleHello(hello.hello);
  if (!welcome.accepted) throw new Error(welcome.reason);
  const welcomed = guestHandshake.handleWelcome(welcome.welcome);
  if (!welcomed.accepted) throw new Error(welcomed.reason);
  const snapshot = hostHandshake.createSnapshot();
  if (!snapshot.accepted) throw new Error(snapshot.reason);
  const accepted = guestHandshake.acceptSnapshot(snapshot.snapshot);
  if (!accepted.accepted) throw new Error(accepted.reason);
  const applied = guestHandshake.createApplied();
  if (!applied.accepted) throw new Error(applied.reason);
  const hostApplied = hostHandshake.handleApplied(applied.applied);
  if (!hostApplied.accepted) throw new Error(hostApplied.reason);

  const hostConnection = overrides.hostConnection ?? connection(`${prefix}-guest-peer`);
  const guestConnection = overrides.guestConnection ?? connection(`${prefix}-host-peer`);
  return {
    hostConnection,
    guestConnection,
    host: new FilePlaybackConnectionChannel(hostHandshake, hostConnection, { now: () => 1_000 }),
    guest: new FilePlaybackConnectionChannel(guestHandshake, guestConnection, {
      now: () => 1_000,
      guestAppliedSendConfirmed: true,
    }),
  };
}

function lifecycle(
  kind: FilePlaybackApplicationLifecycleEvent['kind'],
  role: 'host' | 'guest',
  connectionValue: DataConnection,
  channel: FilePlaybackConnectionChannel | null,
): Readonly<FilePlaybackApplicationLifecycleEvent> {
  return Object.freeze({ kind, role, connection: connectionValue, channel });
}

function auxiliary(
  pair: ChannelPair,
  role: 'host' | 'guest',
  type: string,
): Readonly<FilePlaybackAuxiliaryAdoptionEvent> {
  const channel = pair[role];
  const connectionValue = role === 'host' ? pair.hostConnection : pair.guestConnection;
  return Object.freeze({
    frame: Object.freeze({ type }),
    connection: connectionValue,
    channel,
    connectionToken: channel.liveConnectionToken()!,
  });
}

function wire(pair: ChannelPair, role: 'host' | 'guest'): Readonly<FilePlaybackWireAdoptionEvent> {
  const channel = pair[role];
  const connectionValue = role === 'host' ? pair.hostConnection : pair.guestConnection;
  return Object.freeze({
    message: Object.freeze({ protocolVersion: 2, kind: 'fixture-wire' }) as never,
    connection: connectionValue,
    channel,
    stateLease: Object.freeze({ state: role }) as never,
    attemptLease: Object.freeze({ attempt: role }) as never,
  });
}

function peerRange(
  pair: ChannelPair,
  role: 'host' | 'guest',
  lane: 'control' | 'bulk',
): Readonly<FilePlaybackPeerRangeAdoptionEvent> {
  const channel = pair[role];
  const connectionValue = role === 'host' ? pair.hostConnection : pair.guestConnection;
  return Object.freeze({
    frame: Object.freeze({ protocol: 'musixquare-peer-range', lane, marker: role }),
    lane,
    role,
    connection: connectionValue,
    channel,
    connectionToken: channel.liveConnectionToken()!,
  });
}

function makeHarness(options: RouterHarnessOptions = {}): RouterHarness {
  const events: string[] = [];
  const hostOwners: HostOwnerHarness[] = [];
  const guestOwners: GuestOwnerHarness[] = [];
  const controllerLifecycle = vi.fn((event: FilePlaybackApplicationLifecycleEvent) => {
    events.push(`controller:${event.role}:${event.kind}`);
  });
  const controllerAuxiliary = vi.fn(
    (_event: Readonly<FilePlaybackAuxiliaryAdoptionEvent>, acknowledge: () => void) => {
      events.push('controller:auxiliary');
      acknowledge();
    },
  );
  const controller =
    options.controller ??
    Object.freeze({
      onLifecycleEvent: controllerLifecycle,
      adoptAuxiliaryMessage: controllerAuxiliary,
    });

  const defaultHostFactory = (
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  ): FilePlaybackProductSessionRouterHostMediaOwnerPort => {
    events.push('factory:host');
    const wireMock = vi.fn(
      (_event: Readonly<FilePlaybackWireAdoptionEvent>, acknowledge: () => void) => {
        events.push('host:wire');
        acknowledge();
      },
    );
    const control = vi.fn(
      (_event: Readonly<FilePlaybackPeerRangeAdoptionEvent>, acknowledge: () => void) => {
        events.push('host:control');
        acknowledge();
      },
    );
    const revoke = vi.fn(() => events.push('owner:host:revoke'));
    const port = Object.freeze({
      adoptWireMessage: wireMock,
      adoptPeerRangeControl: control,
      revoke,
    });
    hostOwners.push({ context, port, wire: wireMock, control, revoke });
    return port;
  };
  const defaultGuestFactory = (
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  ): FilePlaybackProductSessionRouterGuestMediaOwnerPort => {
    events.push('factory:guest');
    const auxiliaryMock = vi.fn(
      (_event: Readonly<FilePlaybackAuxiliaryAdoptionEvent>, acknowledge: () => void) => {
        events.push('guest:auxiliary');
        acknowledge();
      },
    );
    const wireMock = vi.fn(
      (_event: Readonly<FilePlaybackWireAdoptionEvent>, acknowledge: () => void) => {
        events.push('guest:wire');
        acknowledge();
      },
    );
    const bulk = vi.fn(
      (_event: Readonly<FilePlaybackPeerRangeAdoptionEvent>, acknowledge: () => void) => {
        events.push('guest:bulk');
        acknowledge();
      },
    );
    const revoke = vi.fn(() => events.push('owner:guest:revoke'));
    const port = Object.freeze({
      adoptAuxiliaryMessage: auxiliaryMock,
      adoptWireMessage: wireMock,
      adoptPeerRangeBulk: bulk,
      revoke,
    });
    guestOwners.push({
      context,
      port,
      auxiliary: auxiliaryMock,
      wire: wireMock,
      bulk,
      revoke,
    });
    return port;
  };

  const router = new FilePlaybackProductSessionRouter({
    controller,
    createHostMediaOwner: options.createHostMediaOwner ?? defaultHostFactory,
    createGuestMediaOwner: options.createGuestMediaOwner ?? defaultGuestFactory,
  });
  return {
    router,
    events,
    controllerLifecycle,
    controllerAuxiliary,
    hostOwners,
    guestOwners,
  };
}

function establish(harness: RouterHarness, pair: ChannelPair, role: 'host' | 'guest'): void {
  harness.router
    .applicationSessionHooks()
    .onLifecycleEvent(
      lifecycle(
        'established',
        role,
        role === 'host' ? pair.hostConnection : pair.guestConnection,
        pair[role],
      ),
    );
}

describe('FilePlaybackProductSessionRouter', () => {
  it('establishes the controller before one exact role owner and exposes only body-free identity', () => {
    const harness = makeHarness();
    const pair = channelPair();
    const hooks = harness.router.applicationSessionHooks();

    expect(hooks).toBe(harness.router.applicationSessionHooks());
    expect(Object.isFrozen(hooks)).toBe(true);
    expect(Object.getPrototypeOf(hooks)).toBeNull();
    establish(harness, pair, 'host');
    establish(harness, pair, 'guest');

    expect(harness.events.slice(0, 4)).toEqual([
      'controller:host:established',
      'factory:host',
      'controller:guest:established',
      'factory:guest',
    ]);
    const hostContext = harness.hostOwners[0]!.context;
    const guestContext = harness.guestOwners[0]!.context;
    expect(hostContext).toMatchObject({
      schemaVersion: 1,
      role: 'host',
      connection: pair.hostConnection,
      channel: pair.host,
      connectionToken: pair.hostConnection,
    });
    expect(guestContext).toMatchObject({
      role: 'guest',
      connection: pair.guestConnection,
      channel: pair.guest,
      connectionToken: pair.guestConnection,
    });
    expect(hostContext.routerToken).not.toBe(guestContext.routerToken);
    expect(Object.isFrozen(hostContext)).toBe(true);
    expect(Object.getPrototypeOf(hostContext)).toBeNull();

    const snapshot = harness.router.snapshot();
    expect(snapshot).toMatchObject({ schemaVersion: 1, closed: false, activeConnectionCount: 2 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.connections)).toBe(true);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain('routerToken');
    expect(JSON.stringify(snapshot)).not.toContain('connectionToken');
  });

  it('routes BASELINE/TIMELINE_UPDATE/READY to the controller and OFFER/RUN_BINDING to the guest owner', () => {
    const harness = makeHarness();
    const pair = channelPair();
    establish(harness, pair, 'host');
    establish(harness, pair, 'guest');
    const hooks = harness.router.applicationSessionHooks();

    const cases = [
      auxiliary(pair, 'guest', FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE),
      auxiliary(pair, 'guest', FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE),
      auxiliary(pair, 'host', FILE_PLAYBACK_PRODUCT_READY_V2_TYPE),
      auxiliary(pair, 'guest', FILE_MEDIA_SOURCE_OFFER_V2_TYPE),
      auxiliary(pair, 'guest', FILE_PLAYBACK_RUN_BINDING_V2_TYPE),
    ];
    const received: unknown[] = [];
    harness.controllerAuxiliary.mockImplementation((event, acknowledge) => {
      received.push(event);
      acknowledge();
    });
    harness.guestOwners[0]!.auxiliary.mockImplementation((event, acknowledge) => {
      received.push(event);
      acknowledge();
    });
    const acknowledgements = cases.map(() => vi.fn());
    cases.forEach((event, index) => hooks.adoptAuxiliaryMessage(event, acknowledgements[index]!));

    expect(harness.controllerAuxiliary).toHaveBeenCalledTimes(3);
    expect(harness.guestOwners[0]!.auxiliary).toHaveBeenCalledTimes(2);
    acknowledgements.forEach((acknowledge) => expect(acknowledge).toHaveBeenCalledOnce());
    received.forEach((event, index) => {
      expect(event).not.toBe(cases[index]);
      expect(Object.isFrozen(event)).toBe(true);
      expect((event as FilePlaybackAuxiliaryAdoptionEvent).frame).toBe(cases[index]!.frame);
      expect((event as FilePlaybackAuxiliaryAdoptionEvent).connection).toBe(
        cases[index]!.connection,
      );
    });
  });

  it('delivers deferred READY and timeline effects only to the exact optional owner callback', () => {
    const pair = channelPair();
    const hostReady = vi.fn();
    const timelineAdopted = vi.fn();
    const timelineUpdated = vi.fn();
    const harness = makeHarness({
      createHostMediaOwner: () =>
        Object.freeze({
          onHostReady: hostReady,
          adoptWireMessage: (_event, acknowledge) => acknowledge(),
          adoptPeerRangeControl: (_event, acknowledge) => acknowledge(),
          revoke: vi.fn(),
        }),
      createGuestMediaOwner: () =>
        Object.freeze({
          onTimelineAdopted: timelineAdopted,
          onTimelineUpdated: timelineUpdated,
          adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
          adoptWireMessage: (_event, acknowledge) => acknowledge(),
          adoptPeerRangeBulk: (_event, acknowledge) => acknowledge(),
          revoke: vi.fn(),
        }),
    });
    establish(harness, pair, 'host');
    establish(harness, pair, 'guest');
    const hostBinding = pair.host.establishedBinding()!;
    const guestBinding = pair.guest.establishedBinding()!;
    const ready = Object.freeze({
      schemaVersion: 1 as const,
      roomGeneration: 2,
      epoch: 1,
      role: 'host' as const,
      sessionId: hostBinding.sessionId,
      connectionId: hostBinding.connectionId,
      baselineStatus: 'ready' as const,
      baselineId: 'baseline:ready',
      playbackRevision: 0,
      clockReady: true,
      ready: true,
    });
    const timeline = createStoppedPlaybackTimeline(1_000, 0);
    const adopted = Object.freeze({
      schemaVersion: 1 as const,
      roomGeneration: 2,
      sessionId: guestBinding.sessionId,
      connectionId: guestBinding.connectionId,
      status: 'adopted' as const,
      timeline,
    });
    const updated = Object.freeze({
      schemaVersion: 1 as const,
      // This is the remote host generation and is intentionally independent
      // from the local controller generation used for baseline adoption.
      roomGeneration: 41,
      sessionId: guestBinding.sessionId,
      connectionId: guestBinding.connectionId,
      timeline,
    });

    expect(harness.router.notifyHostReady(ready)).toBe(true);
    expect(harness.router.notifyTimelineAdopted(adopted)).toBe(true);
    expect(harness.router.notifyTimelineUpdated(updated)).toBe(true);
    expect(hostReady).toHaveBeenCalledWith(ready);
    expect(timelineAdopted).toHaveBeenCalledWith(adopted);
    expect(timelineUpdated).toHaveBeenCalledWith(updated);
    expect(
      harness.router.notifyTimelineAdopted(
        Object.freeze({ ...adopted, connectionId: 'connection:retired' }),
      ),
    ).toBe(false);
    expect(
      harness.router.notifyTimelineUpdated(
        Object.freeze({ ...updated, connectionId: 'connection:retired' }),
      ),
    ).toBe(false);
    expect(timelineAdopted).toHaveBeenCalledOnce();
    expect(timelineUpdated).toHaveBeenCalledOnce();
  });

  it('retires the exact owner when a deferred notification re-enters the router', () => {
    const pair = channelPair();
    let router!: FilePlaybackProductSessionRouter;
    const revoke = vi.fn();
    router = new FilePlaybackProductSessionRouter({
      controller: Object.freeze({
        onLifecycleEvent: vi.fn(),
        adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
      }),
      createHostMediaOwner: () =>
        Object.freeze({
          onHostReady: () => router.close(),
          adoptWireMessage: (_event, acknowledge) => acknowledge(),
          adoptPeerRangeControl: (_event, acknowledge) => acknowledge(),
          revoke,
        }),
      createGuestMediaOwner: () =>
        Object.freeze({
          adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
          adoptWireMessage: (_event, acknowledge) => acknowledge(),
          adoptPeerRangeBulk: (_event, acknowledge) => acknowledge(),
          revoke: vi.fn(),
        }),
    });
    router
      .applicationSessionHooks()
      .onLifecycleEvent(lifecycle('established', 'host', pair.hostConnection, pair.host));
    const binding = pair.host.establishedBinding()!;

    expect(() =>
      router.notifyHostReady(
        Object.freeze({
          schemaVersion: 1 as const,
          roomGeneration: 2,
          epoch: 1,
          role: 'host' as const,
          sessionId: binding.sessionId,
          connectionId: binding.connectionId,
          baselineStatus: 'ready' as const,
          baselineId: 'baseline:reentry',
          playbackRevision: 0,
          clockReady: true,
          ready: true,
        }),
      ),
    ).toThrow(/close superseded|re-entry|cleanup/u);
    expect(revoke).toHaveBeenCalledOnce();
    expect(router.snapshot()).toMatchObject({ closed: true, activeConnectionCount: 0 });
  });

  it('routes wire and peer-range lanes to only the exact role owner with detached envelopes', () => {
    const harness = makeHarness();
    const pair = channelPair();
    establish(harness, pair, 'host');
    establish(harness, pair, 'guest');
    const hooks = harness.router.applicationSessionHooks();
    const hostWire = wire(pair, 'host');
    const guestWire = wire(pair, 'guest');
    const control = peerRange(pair, 'host', 'control');
    const bulk = peerRange(pair, 'guest', 'bulk');
    const acknowledgements = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];

    hooks.adoptWireMessage(hostWire, acknowledgements[0]!);
    hooks.adoptWireMessage(guestWire, acknowledgements[1]!);
    hooks.adoptPeerRangeMessage(control, acknowledgements[2]!);
    hooks.adoptPeerRangeMessage(bulk, acknowledgements[3]!);

    expect(harness.hostOwners[0]!.wire).toHaveBeenCalledOnce();
    expect(harness.guestOwners[0]!.wire).toHaveBeenCalledOnce();
    expect(harness.hostOwners[0]!.control).toHaveBeenCalledOnce();
    expect(harness.guestOwners[0]!.bulk).toHaveBeenCalledOnce();
    acknowledgements.forEach((acknowledge) => expect(acknowledge).toHaveBeenCalledOnce());
    const routedWire = harness.hostOwners[0]!.wire.mock.calls[0]![0];
    const routedControl = harness.hostOwners[0]!.control.mock.calls[0]![0];
    expect(routedWire).not.toBe(hostWire);
    expect(routedWire.message).toBe(hostWire.message);
    expect(routedWire.stateLease).toBe(hostWire.stateLease);
    expect(routedControl).not.toBe(control);
    expect(routedControl.frame).toBe(control.frame);
    expect(JSON.stringify(harness.router.snapshot())).not.toContain('fixture-wire');
  });

  it('revokes owner before controller while the exact channel remains inspectable and rejects ABA', () => {
    const events: string[] = [];
    const pair = channelPair();
    let context: Readonly<FilePlaybackProductSessionRouterConnectionContext> | null = null;
    const controllerLifecycle = vi.fn((event: FilePlaybackApplicationLifecycleEvent) => {
      if (event.kind === 'revoked') {
        events.push('controller:revoked');
        expect(pair.guest.isClosed()).toBe(false);
        expect(pair.guest.liveConnectionToken()).toBe(pair.guestConnection);
      }
    });
    const revoke = vi.fn((value: Readonly<FilePlaybackProductSessionRouterConnectionContext>) => {
      events.push('owner:revoked');
      expect(value).toBe(context);
      expect(value.channel.isClosed()).toBe(false);
      expect(value.channel.establishedBinding()).not.toBeNull();
    });
    const harness = makeHarness({
      controller: Object.freeze({
        onLifecycleEvent: controllerLifecycle,
        adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
      }),
      createGuestMediaOwner: (value) => {
        context = value;
        return Object.freeze({
          adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
          adoptWireMessage: (_event, acknowledge) => acknowledge(),
          adoptPeerRangeBulk: (_event, acknowledge) => acknowledge(),
          revoke,
        });
      },
    });
    establish(harness, pair, 'guest');
    const hooks = harness.router.applicationSessionHooks();

    hooks.onLifecycleEvent(lifecycle('revoked', 'guest', pair.guestConnection, null));
    expect(events).toEqual(['owner:revoked', 'controller:revoked']);
    expect(revoke).toHaveBeenCalledOnce();
    expect(harness.router.snapshot().activeConnectionCount).toBe(0);
    hooks.onLifecycleEvent(lifecycle('revoked', 'guest', pair.guestConnection, pair.guest));
    expect(revoke).toHaveBeenCalledOnce();

    const staleAck = vi.fn();
    expect(() =>
      hooks.adoptAuxiliaryMessage(
        auxiliary(pair, 'guest', FILE_MEDIA_SOURCE_OFFER_V2_TYPE),
        staleAck,
      ),
    ).toThrow(/no exact connection owner/u);
    expect(staleAck).not.toHaveBeenCalled();

    const replacementPair = channelPair({ guestConnection: pair.guestConnection });
    expect(() => establish(harness, replacementPair, 'guest')).toThrow(/one-shot/u);
    expect(controllerLifecycle).toHaveBeenCalledTimes(2);
  });

  it('fails the exact record closed for wrong token, channel, lane, role, or auxiliary direction', () => {
    const cases: Array<
      (harness: RouterHarness, pair: ChannelPair, acknowledge: () => void) => void
    > = [
      (harness, pair, acknowledge) => {
        const event = auxiliary(pair, 'guest', FILE_MEDIA_SOURCE_OFFER_V2_TYPE);
        harness.router
          .applicationSessionHooks()
          .adoptAuxiliaryMessage(
            Object.freeze({ ...event, connectionToken: Object.freeze({ wrong: true }) }),
            acknowledge,
          );
      },
      (harness, pair, acknowledge) => {
        const other = channelPair();
        const event = wire(pair, 'guest');
        harness.router
          .applicationSessionHooks()
          .adoptWireMessage(Object.freeze({ ...event, channel: other.guest }), acknowledge);
      },
      (harness, pair, acknowledge) => {
        harness.router
          .applicationSessionHooks()
          .adoptPeerRangeMessage(peerRange(pair, 'guest', 'control'), acknowledge);
      },
      (harness, pair, acknowledge) => {
        const event = peerRange(pair, 'guest', 'bulk');
        harness.router
          .applicationSessionHooks()
          .adoptPeerRangeMessage(Object.freeze({ ...event, role: 'host' }), acknowledge);
      },
      (harness, pair, acknowledge) => {
        harness.router
          .applicationSessionHooks()
          .adoptAuxiliaryMessage(
            auxiliary(pair, 'guest', FILE_PLAYBACK_PRODUCT_READY_V2_TYPE),
            acknowledge,
          );
      },
    ];

    for (const invoke of cases) {
      const events: string[] = [];
      const pair = channelPair();
      const controllerLifecycle = vi.fn((event: FilePlaybackApplicationLifecycleEvent) => {
        events.push(`controller:${event.kind}`);
      });
      const revoke = vi.fn(() => events.push('owner:revoke'));
      const harness = makeHarness({
        controller: Object.freeze({
          onLifecycleEvent: controllerLifecycle,
          adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
        }),
        createGuestMediaOwner: () =>
          Object.freeze({
            adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
            adoptWireMessage: (_event, acknowledge) => acknowledge(),
            adoptPeerRangeBulk: (_event, acknowledge) => acknowledge(),
            revoke,
          }),
      });
      establish(harness, pair, 'guest');
      const acknowledge = vi.fn();

      expect(() => invoke(harness, pair, acknowledge)).toThrow();
      expect(acknowledge).not.toHaveBeenCalled();
      expect(revoke).toHaveBeenCalledOnce();
      expect(events.slice(-2)).toEqual(['owner:revoke', 'controller:revoked']);
      expect(harness.router.snapshot().activeConnectionCount).toBe(0);
    }
  });

  it('fails the exact host record closed when a host receives a timeline update', () => {
    const pair = channelPair();
    const events: string[] = [];
    const revoke = vi.fn(() => events.push('owner:revoke'));
    const harness = makeHarness({
      controller: Object.freeze({
        onLifecycleEvent: (event: FilePlaybackApplicationLifecycleEvent) =>
          events.push(`controller:${event.kind}`),
        adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
      }),
      createHostMediaOwner: () =>
        Object.freeze({
          adoptWireMessage: (_event, acknowledge) => acknowledge(),
          adoptPeerRangeControl: (_event, acknowledge) => acknowledge(),
          revoke,
        }),
    });
    establish(harness, pair, 'host');
    const acknowledge = vi.fn();

    expect(() =>
      harness.router
        .applicationSessionHooks()
        .adoptAuxiliaryMessage(
          auxiliary(pair, 'host', FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE),
          acknowledge,
        ),
    ).toThrow(/direction|cleanup/u);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledOnce();
    expect(events.slice(-2)).toEqual(['owner:revoke', 'controller:revoked']);
    expect(harness.router.snapshot().activeConnectionCount).toBe(0);
  });

  it.each(['missing', 'double', 'throw', 'reenter'] as const)(
    'fails the timeline-update controller route closed on %s ACK behavior',
    (mode) => {
      const pair = channelPair();
      const revoke = vi.fn();
      let router!: FilePlaybackProductSessionRouter;
      router = new FilePlaybackProductSessionRouter({
        controller: Object.freeze({
          onLifecycleEvent: vi.fn(),
          adoptAuxiliaryMessage: (_event, acknowledge) => {
            if (mode === 'double') {
              acknowledge();
              acknowledge();
              return;
            }
            if (mode === 'throw') throw new Error('timeline adoption failed');
            if (mode === 'reenter') router.close();
          },
        }),
        createHostMediaOwner: () =>
          Object.freeze({
            adoptWireMessage: (_event, acknowledge) => acknowledge(),
            adoptPeerRangeControl: (_event, acknowledge) => acknowledge(),
            revoke: vi.fn(),
          }),
        createGuestMediaOwner: () =>
          Object.freeze({
            adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
            adoptWireMessage: (_event, acknowledge) => acknowledge(),
            adoptPeerRangeBulk: (_event, acknowledge) => acknowledge(),
            revoke,
          }),
      });
      router
        .applicationSessionHooks()
        .onLifecycleEvent(lifecycle('established', 'guest', pair.guestConnection, pair.guest));
      const acknowledge = vi.fn();

      expect(() =>
        router
          .applicationSessionHooks()
          .adoptAuxiliaryMessage(
            auxiliary(pair, 'guest', FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE),
            acknowledge,
          ),
      ).toThrow(/acknowledge|timeline adoption failed|close superseded|cleanup/u);
      expect(acknowledge).toHaveBeenCalledTimes(mode === 'double' ? 1 : 0);
      expect(revoke).toHaveBeenCalledOnce();
      expect(router.snapshot().activeConnectionCount).toBe(0);
    },
  );

  it('requires exactly one synchronous ACK and makes a late ACK inert', () => {
    for (const mode of ['missing', 'double', 'late'] as const) {
      const pair = channelPair();
      let lateAcknowledge: (() => void) | null = null;
      const revoke = vi.fn();
      const harness = makeHarness({
        createGuestMediaOwner: () =>
          Object.freeze({
            adoptAuxiliaryMessage: (_event, acknowledge) => {
              if (mode === 'double') {
                acknowledge();
                acknowledge();
              } else if (mode === 'late') {
                lateAcknowledge = acknowledge;
              }
            },
            adoptWireMessage: (_event, acknowledge) => acknowledge(),
            adoptPeerRangeBulk: (_event, acknowledge) => acknowledge(),
            revoke,
          }),
      });
      establish(harness, pair, 'guest');
      const outerAcknowledge = vi.fn();

      expect(() =>
        harness.router
          .applicationSessionHooks()
          .adoptAuxiliaryMessage(
            auxiliary(pair, 'guest', FILE_MEDIA_SOURCE_OFFER_V2_TYPE),
            outerAcknowledge,
          ),
      ).toThrow(/acknowledge|cleanup/u);
      expect(outerAcknowledge).toHaveBeenCalledTimes(mode === 'double' ? 1 : 0);
      expect(revoke).toHaveBeenCalledOnce();
      expect(harness.router.snapshot().activeConnectionCount).toBe(0);
      if (lateAcknowledge) lateAcknowledge();
      expect(outerAcknowledge).toHaveBeenCalledTimes(mode === 'double' ? 1 : 0);
    }
  });

  it('closes every record owner-first even when one cleanup fails and stays idempotent', () => {
    const pair = channelPair();
    const events: string[] = [];
    const hostFailure = new Error('host owner cleanup failed');
    const controllerLifecycle = vi.fn((event: FilePlaybackApplicationLifecycleEvent) => {
      events.push(`controller:${event.role}:${event.kind}`);
      if (event.kind === 'revoked') expect(event.channel?.isClosed()).toBe(false);
    });
    const harness = makeHarness({
      controller: Object.freeze({
        onLifecycleEvent: controllerLifecycle,
        adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
      }),
      createHostMediaOwner: (context) =>
        Object.freeze({
          adoptWireMessage: (_event, acknowledge) => acknowledge(),
          adoptPeerRangeControl: (_event, acknowledge) => acknowledge(),
          revoke: () => {
            events.push('owner:host:revoke');
            expect(context.channel.isClosed()).toBe(false);
            throw hostFailure;
          },
        }),
      createGuestMediaOwner: (context) =>
        Object.freeze({
          adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
          adoptWireMessage: (_event, acknowledge) => acknowledge(),
          adoptPeerRangeBulk: (_event, acknowledge) => acknowledge(),
          revoke: () => {
            events.push('owner:guest:revoke');
            expect(context.channel.isClosed()).toBe(false);
          },
        }),
    });
    establish(harness, pair, 'host');
    establish(harness, pair, 'guest');

    expect(() => harness.router.close()).toThrow(hostFailure);
    expect(harness.router.snapshot()).toMatchObject({ closed: true, activeConnectionCount: 0 });
    expect(events.indexOf('owner:host:revoke')).toBeLessThan(
      events.indexOf('controller:host:revoked'),
    );
    expect(events.indexOf('owner:guest:revoke')).toBeLessThan(
      events.indexOf('controller:guest:revoked'),
    );
    expect(() => harness.router.close()).not.toThrow();
    expect(() => establish(harness, channelPair(), 'host')).toThrow(/closed/u);
  });

  it('turns close re-entry during adoption into immediate all-record retirement', () => {
    const pair = channelPair();
    let router!: FilePlaybackProductSessionRouter;
    const events: string[] = [];
    const revoke = vi.fn(() => events.push('owner:revoke'));
    const controllerLifecycle = vi.fn((event: FilePlaybackApplicationLifecycleEvent) =>
      events.push(`controller:${event.kind}`),
    );
    router = new FilePlaybackProductSessionRouter({
      controller: Object.freeze({
        onLifecycleEvent: controllerLifecycle,
        adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
      }),
      createHostMediaOwner: () =>
        Object.freeze({
          adoptWireMessage: (_event, acknowledge) => acknowledge(),
          adoptPeerRangeControl: (_event, acknowledge) => acknowledge(),
          revoke: vi.fn(),
        }),
      createGuestMediaOwner: () =>
        Object.freeze({
          adoptAuxiliaryMessage: () => router.close(),
          adoptWireMessage: (_event, acknowledge) => acknowledge(),
          adoptPeerRangeBulk: (_event, acknowledge) => acknowledge(),
          revoke,
        }),
    });
    const hooks = router.applicationSessionHooks();
    hooks.onLifecycleEvent(lifecycle('established', 'guest', pair.guestConnection, pair.guest));
    const acknowledge = vi.fn();

    expect(() =>
      hooks.adoptAuxiliaryMessage(
        auxiliary(pair, 'guest', FILE_MEDIA_SOURCE_OFFER_V2_TYPE),
        acknowledge,
      ),
    ).toThrow(/close superseded|re-entry|fail-closed cleanup/u);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledOnce();
    expect(events.slice(-2)).toEqual(['owner:revoke', 'controller:revoked']);
    expect(router.snapshot()).toMatchObject({ closed: true, activeConnectionCount: 0 });
    expect(() => router.close()).not.toThrow();
  });

  it('rolls controller establishment back when owner construction is invalid or re-enters', () => {
    for (const mode of ['invalid', 'reenter'] as const) {
      const pair = channelPair();
      const events: string[] = [];
      let router!: FilePlaybackProductSessionRouter;
      const controllerLifecycle = vi.fn((event: FilePlaybackApplicationLifecycleEvent) =>
        events.push(`controller:${event.kind}`),
      );
      router = new FilePlaybackProductSessionRouter({
        controller: Object.freeze({
          onLifecycleEvent: controllerLifecycle,
          adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
        }),
        createHostMediaOwner: () =>
          Object.freeze({
            adoptWireMessage: (_event, acknowledge) => acknowledge(),
            adoptPeerRangeControl: (_event, acknowledge) => acknowledge(),
            revoke: vi.fn(),
          }),
        createGuestMediaOwner: () => {
          if (mode === 'reenter') {
            try {
              router
                .applicationSessionHooks()
                .onLifecycleEvent(
                  lifecycle('clock-ready', 'guest', pair.guestConnection, pair.guest),
                );
            } catch {
              // The outer establishment must observe and fail the re-entry.
            }
          }
          return mode === 'invalid'
            ? (Object.freeze({ revoke: vi.fn() }) as never)
            : Object.freeze({
                adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
                adoptWireMessage: (_event, acknowledge) => acknowledge(),
                adoptPeerRangeBulk: (_event, acknowledge) => acknowledge(),
                revoke: vi.fn(),
              });
        },
      });

      expect(() =>
        router
          .applicationSessionHooks()
          .onLifecycleEvent(lifecycle('established', 'guest', pair.guestConnection, pair.guest)),
      ).toThrow(/invalid|re-entry|fail-closed cleanup/u);
      expect(events).toEqual(['controller:established', 'controller:revoked']);
      expect(router.snapshot().activeConnectionCount).toBe(0);
    }
  });

  it('retires authority that materializes after a swallowed close re-entry', () => {
    for (const reentryAt of ['controller', 'factory'] as const) {
      const pair = channelPair();
      let router!: FilePlaybackProductSessionRouter;
      const ownerRevoke = vi.fn();
      const guestFactory = vi.fn((): FilePlaybackProductSessionRouterGuestMediaOwnerPort => {
        if (reentryAt === 'factory') {
          try {
            router.close();
          } catch {
            // Simulate a hostile adapter swallowing the close fence.
          }
        }
        return Object.freeze({
          adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
          adoptWireMessage: (_event, acknowledge) => acknowledge(),
          adoptPeerRangeBulk: (_event, acknowledge) => acknowledge(),
          revoke: ownerRevoke,
        });
      });
      const controllerLifecycle = vi.fn((event: FilePlaybackApplicationLifecycleEvent) => {
        if (reentryAt === 'controller' && event.kind === 'established') {
          try {
            router.close();
          } catch {
            // Simulate a controller adapter swallowing the close fence.
          }
        }
      });
      router = new FilePlaybackProductSessionRouter({
        controller: Object.freeze({
          onLifecycleEvent: controllerLifecycle,
          adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
        }),
        createHostMediaOwner: () =>
          Object.freeze({
            adoptWireMessage: (_event, acknowledge) => acknowledge(),
            adoptPeerRangeControl: (_event, acknowledge) => acknowledge(),
            revoke: vi.fn(),
          }),
        createGuestMediaOwner: guestFactory,
      });

      expect(() =>
        router
          .applicationSessionHooks()
          .onLifecycleEvent(lifecycle('established', 'guest', pair.guestConnection, pair.guest)),
      ).toThrow(/re-entry|fail-closed cleanup/u);
      expect(router.snapshot()).toMatchObject({ closed: true, activeConnectionCount: 0 });
      expect(
        controllerLifecycle.mock.calls.filter(([event]) => event.kind === 'revoked'),
      ).toHaveLength(1);
      expect(guestFactory).toHaveBeenCalledTimes(reentryAt === 'factory' ? 1 : 0);
      expect(ownerRevoke).toHaveBeenCalledTimes(reentryAt === 'factory' ? 1 : 0);
    }
  });

  it('caps retained connection authority and rejects accessors without invoking them', () => {
    let reads = 0;
    const badOptions = {
      get controller() {
        reads += 1;
        return {};
      },
      createHostMediaOwner: vi.fn(),
      createGuestMediaOwner: vi.fn(),
    };
    expect(() => new FilePlaybackProductSessionRouter(badOptions as never)).toThrow(/options/u);
    expect(reads).toBe(0);

    const harness = makeHarness();
    for (let index = 0; index < 64; index += 1) establish(harness, channelPair(), 'host');
    expect(harness.router.snapshot().activeConnectionCount).toBe(64);
    expect(() => establish(harness, channelPair(), 'host')).toThrow(/capacity/u);
    expect(harness.router.snapshot().activeConnectionCount).toBe(64);

    const pair = channelPair();
    let eventReads = 0;
    const hostile = {
      get frame() {
        eventReads += 1;
        return Object.freeze({ type: FILE_MEDIA_SOURCE_OFFER_V2_TYPE });
      },
      connection: pair.guestConnection,
      channel: pair.guest,
      connectionToken: pair.guestConnection,
    };
    expect(() =>
      harness.router.applicationSessionHooks().adoptAuxiliaryMessage(hostile as never, vi.fn()),
    ).toThrow(/invalid/u);
    expect(eventReads).toBe(0);
    harness.router.close();
  });
});
