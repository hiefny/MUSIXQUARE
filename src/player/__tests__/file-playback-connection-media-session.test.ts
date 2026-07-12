import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearAllManagedTimers } from '../../core/timers.ts';
import { FilePlaybackConnectionChannel } from '../../network/file-playback-connection-channel.ts';
import {
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackHostSessionHandshake,
} from '../../network/file-playback-session-handshake.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  createPeerRangeFileMediaSourceOfferV2,
  type FileMediaSourceOfferV2,
} from '../file-media-source-offer.ts';
import {
  FilePlaybackConnectionMediaSession,
  FilePlaybackConnectionMediaSessionFatalError,
  type FilePlaybackConnectionMediaOperation,
} from '../file-playback-connection-media-session.ts';
import { createFilePlaybackMediaScope } from '../file-playback-media-scope.ts';
import {
  createFilePlaybackRunBindingV2,
  type FilePlaybackRunBindingV2,
} from '../file-playback-run-binding.ts';
import type { PlaybackStateIdentity } from '../playback-identity.ts';

const HOST_ID = 'host-participant:connection-media';
const GUEST_ID = 'guest-participant:connection-media';
const QIDS = [
  '71000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000002',
] as const satisfies readonly QueueItemId[];
const PREPARE_IDS = [
  '72000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000002',
  '72000000-0000-4000-8000-000000000003',
] as const;
const RUN_IDS = [
  '73000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000002',
  '73000000-0000-4000-8000-000000000003',
] as const;

let pairSequence = 0;

afterEach(() => clearAllManagedTimers());

function issuer(prefix: string): FilePlaybackHandshakeIdIssuer {
  return new FilePlaybackHandshakeIdIssuer({
    createSessionId: () => `${prefix}:session`,
    createConnectionId: () => `${prefix}:connection`,
    createHelloId: () => `${prefix}:hello`,
  });
}

function establishedHandshakes() {
  pairSequence += 1;
  const prefix = `connection-media:${pairSequence}`;
  const hostIssuer = issuer(prefix);
  const guestIssuer = issuer(`${prefix}:guest`);
  const host = new FilePlaybackHostSessionHandshake({
    idIssuer: hostIssuer,
    sessionId: hostIssuer.issueSessionId(),
    connectionId: hostIssuer.issueConnectionId(),
    hostParticipantId: HOST_ID,
    guestParticipantId: GUEST_ID,
  });
  const guest = new FilePlaybackGuestSessionHandshake({
    idIssuer: guestIssuer,
    guestParticipantId: GUEST_ID,
  });
  const hello = guest.createHello();
  if (!hello.accepted) throw new Error(hello.reason);
  const welcome = host.handleHello(hello.hello);
  if (!welcome.accepted) throw new Error(welcome.reason);
  const acceptedWelcome = guest.handleWelcome(welcome.welcome);
  if (!acceptedWelcome.accepted) throw new Error(acceptedWelcome.reason);
  const snapshot = host.createSnapshot();
  if (!snapshot.accepted) throw new Error(snapshot.reason);
  const acceptedSnapshot = guest.acceptSnapshot(snapshot.snapshot);
  if (!acceptedSnapshot.accepted) throw new Error(acceptedSnapshot.reason);
  const applied = guest.createApplied();
  if (!applied.accepted) throw new Error(applied.reason);
  const acceptedApplied = host.handleApplied(applied.applied);
  if (!acceptedApplied.accepted) throw new Error(acceptedApplied.reason);
  return { guest, host };
}

interface Harness {
  readonly channel: FilePlaybackConnectionChannel;
  readonly token: object;
  readonly fatal: ReturnType<typeof vi.fn>;
  readonly session: FilePlaybackConnectionMediaSession;
  readonly binding: NonNullable<ReturnType<FilePlaybackConnectionChannel['establishedBinding']>>;
  now: number;
}

function harness(): Harness {
  const handshakes = establishedHandshakes();
  const token = Object.freeze({ connection: pairSequence });
  const channel = new FilePlaybackConnectionChannel(handshakes.guest, token, {
    now: () => 100,
    guestAppliedSendConfirmed: true,
  });
  const binding = channel.establishedBinding();
  if (!binding) throw new Error('Missing established test binding');
  const state = { now: 100 } as Harness;
  const fatal = vi.fn();
  const session = new FilePlaybackConnectionMediaSession({
    channel,
    connectionToken: token,
    maxEncodedSize: 10_000_000,
    nowRoomTimeMs: () => state.now,
    onFatalConnection: fatal,
  });
  Object.assign(state, { channel, token, fatal, session, binding });
  return state;
}

function offerFor(
  h: Harness,
  index = 0,
  queueItemId: QueueItemId = QIDS[0],
  overrides: Partial<FileMediaSourceOfferV2> = {},
): Readonly<FileMediaSourceOfferV2> {
  const scope = createFilePlaybackMediaScope(h.binding.sessionId, queueItemId);
  return createPeerRangeFileMediaSourceOfferV2({
    sessionId: h.binding.sessionId,
    connectionId: h.binding.connectionId,
    prepareId: PREPARE_IDS[index]!,
    prepareRevision: index + 1,
    queueItemId,
    sourceIdentity: scope.sourceIdentity,
    transferSessionId: scope.transferSessionId,
    handleId: `peer-range-handle:${index + 1}`,
    encodedSize: 4_096 + index,
    name: `orchestra-${index + 1}.flac`,
    mime: 'audio/flac',
    expiresAtRoomTimeMs: 1_000,
    ...overrides,
  });
}

function bindingFor(
  offer: Readonly<FileMediaSourceOfferV2>,
  revision: number,
  runId = RUN_IDS[Math.min(revision - 1, RUN_IDS.length - 1)]!,
): Readonly<FilePlaybackRunBindingV2> {
  return createFilePlaybackRunBindingV2({
    sessionId: offer.sessionId,
    connectionId: offer.connectionId,
    prepareId: offer.prepareId,
    prepareRevision: offer.prepareRevision,
    queueItemId: offer.queueItemId,
    sourceIdentity: offer.sourceIdentity,
    transferSessionId: offer.transferSessionId,
    runId,
    playbackRevision: revision,
  });
}

function expectedFor(binding: Readonly<FilePlaybackRunBindingV2>): PlaybackStateIdentity {
  return {
    queueItemId: binding.queueItemId,
    runId: binding.runId,
    revision: binding.playbackRevision,
  };
}

function admitOffer(h: Harness, offer: Readonly<FileMediaSourceOfferV2>) {
  expect(h.session.admitQueueItem(offer.queueItemId)).toBe(true);
  const result = h.session.adoptSourceOffer(offer);
  expect(result).toMatchObject({ accepted: true });
  return result;
}

function stageBaseline(h: Harness, revision = 1) {
  const offer = offerFor(h);
  admitOffer(h, offer);
  const binding = bindingFor(offer, revision, RUN_IDS[0]);
  const operation = h.session.stageRunBinding(binding, expectedFor(binding), 'baseline');
  return { offer, binding, operation };
}

describe('FilePlaybackConnectionMediaSession', () => {
  it('binds an active baseline to one exact APPLIED guest channel and commits only after start', () => {
    const h = harness();
    const { binding, operation } = stageBaseline(h, 700);

    expect(operation.fence.signal.aborted).toBe(false);
    expect(operation.fence.isCurrent()).toBe(true);

    expect(h.session.snapshot()).toMatchObject({
      role: 'guest',
      status: 'candidate',
      committedRevisionWatermark: 699,
      admittedRevisionWatermark: 700,
      candidate: { kind: 'baseline', binding: { playbackRevision: 700 } },
    });
    expect(h.session.commitStarted(operation, expectedFor(binding), () => true)).toMatchObject({
      status: 'active',
      committedRevisionWatermark: 700,
      admittedRevisionWatermark: 700,
      current: { binding: { playbackRevision: 700 } },
    });
    expect(operation.fence.signal.aborted).toBe(false);
    expect(operation.fence.isCurrent()).toBe(true);
    expect(h.fatal).not.toHaveBeenCalled();
  });

  it('bootstraps stopped and commits an exact successor on both authorities', () => {
    const h = harness();
    expect(h.session.bootstrapStopped(8)).toMatchObject({
      status: 'stopped',
      committedRevisionWatermark: 8,
      admittedRevisionWatermark: 8,
    });
    expect(h.session.bootstrapStopped(8)).toMatchObject({ status: 'stopped' });
    const offer = offerFor(h);
    admitOffer(h, offer);
    const binding = bindingFor(offer, 9, RUN_IDS[0]);
    const operation = h.session.stageRunBinding(binding, expectedFor(binding), 'successor');

    h.session.commitStarted(operation, expectedFor(binding), () => true);
    expect(h.session.snapshot()).toMatchObject({
      status: 'active',
      committedRevisionWatermark: 9,
      admittedRevisionWatermark: 9,
    });
  });

  it('replaces a committed run with an exact-next successor', () => {
    const h = harness();
    const first = stageBaseline(h);
    h.session.commitStarted(first.operation, expectedFor(first.binding), () => true);
    const nextOffer = offerFor(h, 1);
    expect(h.session.adoptSourceOffer(nextOffer)).toMatchObject({
      accepted: true,
      status: 'superseded',
    });
    const nextBinding = bindingFor(nextOffer, 2, RUN_IDS[1]);
    const next = h.session.stageRunBinding(nextBinding, expectedFor(nextBinding), 'successor');

    h.session.commitStarted(next, expectedFor(nextBinding), () => true);
    expect(h.session.snapshot()).toMatchObject({
      status: 'active',
      current: { binding: { runId: RUN_IDS[1], playbackRevision: 2 } },
    });
    expect(first.operation.fence.signal.aborted).toBe(true);
    expect(first.operation.fence.isCurrent()).toBe(false);
    expect(next.fence.signal.aborted).toBe(false);
    expect(next.fence.isCurrent()).toBe(true);
    expect(() => h.session.retire(first.operation)).toThrow(/forged|retired/u);
  });

  it('requires OFFER before RUN_BINDING and rejects wrong correlation and scope', () => {
    const h = harness();
    h.session.bootstrapStopped(0);
    const offer = offerFor(h);
    expect(h.session.admitQueueItem(QIDS[0])).toBe(true);
    const binding = bindingFor(offer, 1);
    expect(() => h.session.stageRunBinding(binding, expectedFor(binding), 'successor')).toThrow(
      /preceding current OFFER/u,
    );

    expect(h.session.adoptSourceOffer(offer)).toMatchObject({ accepted: true });
    expect(() =>
      h.session.stageRunBinding(
        { ...binding, connectionId: 'foreign:connection' },
        expectedFor(binding),
        'successor',
      ),
    ).toThrow(/different connection scope/u);
    expect(() =>
      h.session.stageRunBinding(
        { ...binding, sourceIdentity: 'mxq:q:foreign-source' },
        expectedFor(binding),
        'successor',
      ),
    ).toThrow(/does not match its current source offer/u);
    expect(() =>
      h.session.stageRunBinding(
        { ...binding, transferSessionId: 'mxq:s:foreign-transfer' },
        expectedFor(binding),
        'successor',
      ),
    ).toThrow(/does not match its current source offer/u);
    expect(() =>
      h.session.stageRunBinding(
        { ...binding, queueItemId: QIDS[1] },
        { ...expectedFor(binding), queueItemId: QIDS[1] },
        'successor',
      ),
    ).toThrow(/preceding current OFFER/u);
    expect(h.session.snapshot().status).toBe('stopped');
  });

  it('rejects stale and skipped channel revisions without committing either authority', () => {
    const stale = harness();
    stale.session.bootstrapStopped(5);
    const staleOffer = offerFor(stale);
    admitOffer(stale, staleOffer);
    const staleBinding = bindingFor(staleOffer, 5, RUN_IDS[0]);
    expect(() =>
      stale.session.stageRunBinding(staleBinding, expectedFor(staleBinding), 'successor'),
    ).toThrow(/not newer/u);
    expect(stale.session.snapshot()).toMatchObject({
      status: 'stopped',
      committedRevisionWatermark: 5,
      admittedRevisionWatermark: 5,
    });

    const skipped = harness();
    skipped.session.bootstrapStopped(5);
    const skippedOffer = offerFor(skipped);
    admitOffer(skipped, skippedOffer);
    const skippedBinding = bindingFor(skippedOffer, 7, RUN_IDS[0]);
    expect(() =>
      skipped.session.stageRunBinding(skippedBinding, expectedFor(skippedBinding), 'successor'),
    ).toThrow(/exact next/u);
    expect(skipped.session.snapshot()).toMatchObject({
      status: 'stopped',
      committedRevisionWatermark: 5,
      admittedRevisionWatermark: 5,
    });
    expect(skipped.fatal).not.toHaveBeenCalled();
  });

  it('makes exact OFFER and staged binding replay idempotent', () => {
    const h = harness();
    h.session.bootstrapStopped(0);
    const offer = offerFor(h);
    admitOffer(h, offer);
    expect(h.session.adoptSourceOffer({ ...offer })).toMatchObject({
      accepted: true,
      status: 'replayed',
    });
    const binding = bindingFor(offer, 1);
    const first = h.session.stageRunBinding(binding, expectedFor(binding), 'successor');
    const replay = h.session.stageRunBinding(
      { ...binding },
      { ...expectedFor(binding) },
      'successor',
    );
    expect(replay).toBe(first);

    const baseline = harness();
    const stagedBaseline = stageBaseline(baseline, 50);
    const baselineReplay = baseline.session.stageRunBinding(
      { ...stagedBaseline.binding },
      { ...expectedFor(stagedBaseline.binding) },
      'baseline',
    );
    expect(baselineReplay).toBe(stagedBaseline.operation);
    expect(baselineReplay.fence).toBe(stagedBaseline.operation.fence);
  });

  it('removes exact queue authority and retires its staged operation', () => {
    const h = harness();
    h.session.bootstrapStopped(0);
    const offer = offerFor(h);
    admitOffer(h, offer);
    const binding = bindingFor(offer, 1);
    const operation = h.session.stageRunBinding(binding, expectedFor(binding), 'successor');

    expect(h.session.removeQueueItem(QIDS[0])).toBe(true);
    expect(h.session.snapshot()).toMatchObject({
      status: 'stopped',
      liveQueueItemCount: 0,
      activeOfferCount: 0,
    });
    expect(operation.fence.signal.aborted).toBe(true);
    expect(operation.fence.isCurrent()).toBe(false);
    expect(() => h.session.commitStarted(operation, expectedFor(binding), () => true)).toThrow(
      /forged|retired/u,
    );
    expect(h.session.removeQueueItem(QIDS[0])).toBe(true);
  });

  it('aborts its fence and revokes metadata authority without closing the shared channel', () => {
    const h = harness();
    const { operation } = stageBaseline(h);
    const fence = h.session.captureFence();
    expect(fence.signal.aborted).toBe(false);
    expect(fence.isCurrent()).toBe(true);
    expect(Object.getPrototypeOf(fence)).toBeNull();
    expect(Object.isFrozen(fence)).toBe(true);
    expect(h.session.captureFence()).toBe(fence);

    h.session.revoke();
    h.session.revoke();
    expect(fence.signal.aborted).toBe(true);
    expect(fence.isCurrent()).toBe(false);
    expect(operation.fence.signal.aborted).toBe(true);
    expect(operation.fence.isCurrent()).toBe(false);
    expect(h.session.snapshot()).toMatchObject({
      status: 'revoked',
      liveQueueItemCount: 0,
      activeOfferCount: 0,
      candidate: null,
      current: null,
    });
    expect(h.channel.isClosed()).toBe(false);
    expect(h.fatal).not.toHaveBeenCalled();

    const externallyClosed = harness();
    const externalFence = externallyClosed.session.captureFence();
    externallyClosed.channel.close();
    expect(externalFence.signal.aborted).toBe(false);
    expect(externalFence.isCurrent()).toBe(false);
  });

  it('rejects forged, retired, and already-started operation objects', () => {
    const h = harness();
    const { operation, binding } = stageBaseline(h);
    const forged = Object.freeze({ ...operation }) as FilePlaybackConnectionMediaOperation;
    expect(() => h.session.commitStarted(forged, expectedFor(binding), () => true)).toThrow(
      /forged/u,
    );

    h.session.commitStarted(operation, expectedFor(binding), () => true);
    expect(() => h.session.commitStarted(operation, expectedFor(binding), () => true)).toThrow(
      /exact staged/u,
    );
    h.session.retire(operation);
    expect(() => h.session.retire(operation)).toThrow(/forged|retired/u);
  });

  it('fail-closes callback re-entry before either staged authority becomes current', () => {
    const h = harness();
    const { operation, binding } = stageBaseline(h);
    let fatalCallsInsideAuthorityCallback = -1;
    let channelStateRetiredBeforeOwnerCallback = false;
    h.fatal.mockImplementation(() => {
      const nextStateLease = h.channel.stageMedia({
        run: {
          queueItemId: binding.queueItemId,
          runId: RUN_IDS[1],
          revision: 2,
        },
        sourceIdentity: binding.sourceIdentity,
        transferSessionId: binding.transferSessionId,
      });
      channelStateRetiredBeforeOwnerCallback = true;
      h.channel.retireMedia(nextStateLease);
    });

    expect(() =>
      h.session.commitStarted(operation, expectedFor(binding), () => {
        try {
          h.session.snapshot();
        } catch {
          // Re-entry must poison the exact session without running owner effects inline.
        }
        fatalCallsInsideAuthorityCallback = h.fatal.mock.calls.length;
        return true;
      }),
    ).toThrow(FilePlaybackConnectionMediaSessionFatalError);
    expect(h.session.snapshot()).toMatchObject({
      status: 'revoked',
      candidate: null,
      current: null,
    });
    expect(h.session.captureFence().signal.aborted).toBe(true);
    expect(h.session.captureFence().isCurrent()).toBe(false);
    expect(fatalCallsInsideAuthorityCallback).toBe(0);
    expect(h.fatal).toHaveBeenCalledOnce();
    expect(channelStateRetiredBeforeOwnerCallback).toBe(true);
    expect(h.channel.isClosed()).toBe(false);
  });

  it('retires a controller-rejected successor and admits the outer timeline at N+1', () => {
    const h = harness();
    h.session.bootstrapStopped(0);
    const offer = offerFor(h);
    admitOffer(h, offer);
    const binding = bindingFor(offer, 1);
    const operation = h.session.stageRunBinding(binding, expectedFor(binding), 'successor');

    expect(() => h.session.commitStarted(operation, expectedFor(binding), () => false)).toThrow(
      /no longer the controller current state/u,
    );
    expect(h.session.snapshot()).toMatchObject({
      status: 'stopped',
      committedRevisionWatermark: 0,
      admittedRevisionWatermark: 1,
      candidate: null,
    });
    expect(h.fatal).not.toHaveBeenCalled();

    const nextOffer = offerFor(h, 1);
    expect(h.session.adoptSourceOffer(nextOffer)).toMatchObject({
      accepted: true,
      status: 'superseded',
    });
    const nextBinding = bindingFor(nextOffer, 2, RUN_IDS[1]);
    const next = h.session.stageRunBinding(nextBinding, expectedFor(nextBinding), 'successor');
    expect(next.fence.isCurrent()).toBe(true);
    expect(h.session.snapshot()).toMatchObject({
      status: 'candidate',
      committedRevisionWatermark: 0,
      admittedRevisionWatermark: 2,
    });
    expect(h.fatal).not.toHaveBeenCalled();
  });

  it('fail-closes an explicitly retired uncommitted active baseline after internal teardown', () => {
    const h = harness();
    const { operation } = stageBaseline(h, 20);
    let authoritiesClosedAtOwnerCallback = false;
    h.fatal.mockImplementation(() => {
      authoritiesClosedAtOwnerCallback = h.session.authoritiesClosedForTests();
    });

    expect(() => h.session.retire(operation)).toThrow(FilePlaybackConnectionMediaSessionFatalError);
    expect(authoritiesClosedAtOwnerCallback).toBe(true);
    expect(h.fatal).toHaveBeenCalledOnce();
    expect(h.session.snapshot()).toMatchObject({ status: 'revoked', candidate: null });
    expect(h.session.captureFence().isCurrent()).toBe(false);
    expect(h.channel.isClosed()).toBe(false);
  });

  it('fail-closes when a new OFFER supersedes an uncommitted active baseline', () => {
    const h = harness();
    stageBaseline(h, 20);
    let authoritiesClosedAtOwnerCallback = false;
    h.fatal.mockImplementation(() => {
      authoritiesClosedAtOwnerCallback = h.session.authoritiesClosedForTests();
    });

    expect(() => h.session.adoptSourceOffer(offerFor(h, 1))).toThrow(
      FilePlaybackConnectionMediaSessionFatalError,
    );
    expect(authoritiesClosedAtOwnerCallback).toBe(true);
    expect(h.fatal).toHaveBeenCalledOnce();
    expect(h.session.snapshot()).toMatchObject({ status: 'revoked' });
    expect(h.channel.isClosed()).toBe(false);
  });

  it('fail-closes when an uncommitted active baseline OFFER expires', () => {
    const h = harness();
    const { operation, binding } = stageBaseline(h, 20);
    let authoritiesClosedAtOwnerCallback = false;
    h.fatal.mockImplementation(() => {
      authoritiesClosedAtOwnerCallback = h.session.authoritiesClosedForTests();
    });
    h.now = 1_001;

    expect(() => h.session.commitStarted(operation, expectedFor(binding), () => true)).toThrow(
      FilePlaybackConnectionMediaSessionFatalError,
    );
    expect(authoritiesClosedAtOwnerCallback).toBe(true);
    expect(h.fatal).toHaveBeenCalledOnce();
    expect(h.session.snapshot()).toMatchObject({ status: 'revoked' });
    expect(operation.fence.signal.aborted).toBe(true);
    expect(operation.fence.isCurrent()).toBe(false);
  });

  it('keeps split authority leases private and retires shared channel state on revoke', () => {
    const h = harness();
    const { operation, binding } = stageBaseline(h, 20);
    expect(Reflect.has(operation, 'runLease')).toBe(false);
    expect(Reflect.has(operation, 'channelStateLease')).toBe(false);
    expect(() =>
      h.channel.commitMedia(Reflect.get(operation, 'channelStateLease') as never),
    ).toThrow(/forged/u);

    h.session.revoke();
    const nextStateLease = h.channel.stageMedia({
      run: {
        queueItemId: binding.queueItemId,
        runId: RUN_IDS[1],
        revision: 21,
      },
      sourceIdentity: binding.sourceIdentity,
      transferSessionId: binding.transferSessionId,
    });
    expect(nextStateLease).toBeTruthy();
    h.channel.retireMedia(nextStateLease);
    expect(h.fatal).not.toHaveBeenCalled();
  });

  it('fail-closes when an OFFER supersedes an admitted successor source', () => {
    const h = harness();
    h.session.bootstrapStopped(0);
    const firstOffer = offerFor(h);
    admitOffer(h, firstOffer);
    const firstBinding = bindingFor(firstOffer, 1, RUN_IDS[0]);
    const first = h.session.stageRunBinding(firstBinding, expectedFor(firstBinding), 'successor');

    const nextOffer = offerFor(h, 1);
    expect(() => h.session.adoptSourceOffer(nextOffer)).toThrow(
      FilePlaybackConnectionMediaSessionFatalError,
    );
    expect(first.fence.signal.aborted).toBe(true);
    expect(first.fence.isCurrent()).toBe(false);
    expect(h.session.captureFence().signal.aborted).toBe(true);
    expect(h.session.captureFence().isCurrent()).toBe(false);
    expect(h.session.snapshot()).toMatchObject({
      status: 'revoked',
      committedRevisionWatermark: 0,
      admittedRevisionWatermark: 1,
    });
    expect(h.fatal).toHaveBeenCalledOnce();
  });

  it('expires and aborts an uncommitted successor operation without another media call', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.session.bootstrapStopped(0);
      const offer = offerFor(h);
      admitOffer(h, offer);
      const binding = bindingFor(offer, 1, RUN_IDS[0]);
      const operation = h.session.stageRunBinding(binding, expectedFor(binding), 'successor');
      expect(operation.fence.isCurrent()).toBe(true);
      expect(vi.getTimerCount()).toBe(1);

      h.now = 1_001;
      expect(operation.fence.signal.aborted).toBe(false);
      expect(operation.fence.isCurrent()).toBe(false);
      await vi.advanceTimersByTimeAsync(900);

      expect(operation.fence.signal.aborted).toBe(true);
      expect(operation.fence.isCurrent()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(h.session.snapshot()).toMatchObject({
        status: 'revoked',
        committedRevisionWatermark: 0,
        admittedRevisionWatermark: 1,
        candidate: null,
      });
      expect(h.fatal).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears candidate expiry scheduling when a committed run detaches from its OFFER', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.session.bootstrapStopped(0);
      const offer = offerFor(h);
      admitOffer(h, offer);
      const binding = bindingFor(offer, 1, RUN_IDS[0]);
      const operation = h.session.stageRunBinding(binding, expectedFor(binding), 'successor');
      expect(vi.getTimerCount()).toBe(1);

      h.session.commitStarted(operation, expectedFor(binding), () => true);
      expect(vi.getTimerCount()).toBe(0);
      h.now = 1_001;
      expect(operation.fence.signal.aborted).toBe(false);
      expect(operation.fence.isCurrent()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows committed baseline and successor currents to retire normally', () => {
    const baseline = harness();
    const first = stageBaseline(baseline, 20);
    baseline.session.commitStarted(first.operation, expectedFor(first.binding), () => true);
    baseline.session.retire(first.operation);
    expect(baseline.session.snapshot()).toMatchObject({
      status: 'stopped',
      committedRevisionWatermark: 20,
      admittedRevisionWatermark: 20,
    });
    expect(first.operation.fence.signal.aborted).toBe(true);
    expect(first.operation.fence.isCurrent()).toBe(false);
    expect(baseline.fatal).not.toHaveBeenCalled();

    const successor = harness();
    successor.session.bootstrapStopped(5);
    const offer = offerFor(successor);
    admitOffer(successor, offer);
    const binding = bindingFor(offer, 6, RUN_IDS[0]);
    const operation = successor.session.stageRunBinding(binding, expectedFor(binding), 'successor');
    successor.session.commitStarted(operation, expectedFor(binding), () => true);
    successor.session.retire(operation);
    expect(successor.session.snapshot()).toMatchObject({
      status: 'stopped',
      committedRevisionWatermark: 6,
      admittedRevisionWatermark: 6,
    });
    expect(operation.fence.signal.aborted).toBe(true);
    expect(operation.fence.isCurrent()).toBe(false);
    expect(successor.fatal).not.toHaveBeenCalled();
  });

  it('returns frozen body-free operation and public session snapshots', () => {
    const h = harness();
    const { operation } = stageBaseline(h);
    const snapshot = h.session.snapshot();
    const serialized = JSON.stringify({ operation, snapshot });

    expect(Object.getPrototypeOf(operation)).toBeNull();
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(serialized).toContain('orchestra-1.flac');
    expect(serialized).not.toMatch(/Blob|ArrayBuffer|ReadableStream|mediaBody|connectionToken/iu);
    expect(JSON.parse(serialized)).toMatchObject({
      operation: {
        binding: { queueItemId: QIDS[0] },
        fence: { epoch: {}, signal: {} },
      },
      snapshot: { role: 'guest', candidate: { offer: { encodedSize: 4_096 } } },
    });
    expect(Reflect.has(operation, 'runLease')).toBe(false);
    expect(Reflect.has(operation, 'channelStateLease')).toBe(false);
    expect(Object.getPrototypeOf(operation.fence)).toBeNull();
    expect(Object.isFrozen(operation.fence)).toBe(true);
  });

  it('claims one exact APPLIED guest channel for its process-local lifetime', () => {
    const h = harness();
    const constructAgain = () =>
      new FilePlaybackConnectionMediaSession({
        channel: h.channel,
        connectionToken: h.token,
        maxEncodedSize: 10_000_000,
        nowRoomTimeMs: () => h.now,
        onFatalConnection: vi.fn(),
      });

    expect(constructAgain).toThrow(/already claimed/u);
    h.session.revoke();
    expect(constructAgain).toThrow(/already claimed/u);
    expect(h.channel.isClosed()).toBe(false);
  });

  it('rejects host channels, wrong live tokens, and descriptor-hostile options', () => {
    const hostPair = establishedHandshakes();
    const hostToken = Object.freeze({ host: true });
    const hostChannel = new FilePlaybackConnectionChannel(hostPair.host, hostToken, {
      now: () => 100,
    });
    expect(
      () =>
        new FilePlaybackConnectionMediaSession({
          channel: hostChannel,
          connectionToken: hostToken,
          maxEncodedSize: 1,
          nowRoomTimeMs: () => 100,
          onFatalConnection: vi.fn(),
        }),
    ).toThrow(/guest/u);

    const guestPair = establishedHandshakes();
    const token = Object.freeze({ guest: true });
    const guestChannel = new FilePlaybackConnectionChannel(guestPair.guest, token, {
      now: () => 100,
      guestAppliedSendConfirmed: true,
    });
    expect(
      () =>
        new FilePlaybackConnectionMediaSession({
          channel: guestChannel,
          connectionToken: {},
          maxEncodedSize: 1,
          nowRoomTimeMs: () => 100,
          onFatalConnection: vi.fn(),
        }),
    ).toThrow(/not live/u);

    let reads = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    for (const key of [
      'channel',
      'connectionToken',
      'maxEncodedSize',
      'nowRoomTimeMs',
      'onFatalConnection',
    ]) {
      Object.defineProperty(hostile, key, {
        enumerable: true,
        get() {
          reads += 1;
          return undefined;
        },
      });
    }
    expect(() => new FilePlaybackConnectionMediaSession(hostile as never)).toThrow(/options/u);
    expect(reads).toBe(0);
  });
});
