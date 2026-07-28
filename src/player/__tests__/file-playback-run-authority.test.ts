import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  createPeerRangeFileMediaSourceOfferV2,
  FileMediaOfferRegistry,
  type FileMediaCurrentOfferLease,
  type FileMediaSourceOfferV2,
} from '../file-media-source-offer.ts';
import { createFilePlaybackMediaScope } from '../file-playback-media-scope.ts';
import {
  FilePlaybackRunAuthority,
  FilePlaybackRunAuthorityFatalError,
  type FilePlaybackRunAuthorityOptions,
  type FilePlaybackRunLease,
} from '../file-playback-run-authority.ts';
import {
  createFilePlaybackRunBindingV2,
  type FilePlaybackRunBindingV2,
} from '../file-playback-run-binding.ts';
import type { PlaybackStateIdentity } from '../playback-identity.ts';

const TOKEN = Object.freeze({ channel: 'exact-data-connection' });
const FOREIGN_TOKEN = Object.freeze({ channel: 'foreign' });
const SESSION_ID = 'session:run-authority';
const CONNECTION_ID = 'connection:run-authority';
const QID = '10000000-0000-4000-8000-000000000001' as QueueItemId;
const PREPARE_IDS = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
] as const;
const RUN_IDS = [
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
] as const;

interface Harness {
  readonly registry: FileMediaOfferRegistry;
  readonly fatal: ReturnType<typeof vi.fn>;
  now: number;
  authority: FilePlaybackRunAuthority;
}

function createHarness(
  overrides: Partial<FilePlaybackRunAuthorityOptions> = {},
  onClockRead?: () => void,
): Harness {
  const harness = { now: 100 } as Harness;
  const fatal = vi.fn();
  const registry = new FileMediaOfferRegistry({
    liveConnectionToken: TOKEN,
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    maxEncodedSize: 10_000_000,
    nowRoomTimeMs: () => {
      onClockRead?.();
      return harness.now;
    },
    onFatalConnection: fatal,
  });
  expect(registry.admitQueueItem(TOKEN, QID)).toBe(true);
  const authority = new FilePlaybackRunAuthority({
    liveConnectionToken: TOKEN,
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    offerRegistry: registry,
    onFatalConnection: fatal,
    ...overrides,
  });
  Object.assign(harness, { registry, fatal, authority });
  return harness;
}

function acceptOffer(
  harness: Harness,
  index: number,
  overrides: Partial<FileMediaSourceOfferV2> = {},
): Readonly<FileMediaSourceOfferV2> {
  const media = createFilePlaybackMediaScope(SESSION_ID, QID);
  const offer = createPeerRangeFileMediaSourceOfferV2({
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    prepareId: PREPARE_IDS[index]!,
    prepareRevision: index + 1,
    queueItemId: QID,
    sourceIdentity: media.sourceIdentity,
    transferSessionId: media.transferSessionId,
    handleId: `peer-range-handle:${index + 1}`,
    encodedSize: 4_096 + index,
    name: `take-${index + 1}.flac`,
    mime: 'audio/flac',
    expiresAtRoomTimeMs: 1_000,
    ...overrides,
  });
  const result = harness.registry.accept(TOKEN, offer);
  if (!result.accepted) throw new Error(`offer rejected: ${result.reason}`);
  return result.offer;
}

function issueLease(harness: Harness): FileMediaCurrentOfferLease {
  const lease = harness.registry.issueCurrentOfferLease(TOKEN, QID);
  if (!lease) throw new Error('test offer lease was not issued');
  return lease;
}

function bindingFor(
  offer: Readonly<FileMediaSourceOfferV2>,
  revision: number,
  runId: string = RUN_IDS[Math.min(revision - 1, RUN_IDS.length - 1)]!,
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

function commitRun(
  harness: Harness,
  lease: FilePlaybackRunLease,
  binding: Readonly<FilePlaybackRunBindingV2>,
) {
  return harness.authority.commitCandidate(TOKEN, lease, expectedFor(binding), () => true);
}

function stageFirst(harness: Harness): {
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly offerLease: FileMediaCurrentOfferLease;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
  readonly lease: FilePlaybackRunLease;
} {
  const offer = acceptOffer(harness, 0);
  const offerLease = issueLease(harness);
  const binding = bindingFor(offer, 1);
  harness.authority.bootstrapStopped(TOKEN, 0);
  const lease = harness.authority.stageSuccessor(TOKEN, binding, offerLease, expectedFor(binding));
  return { offer, offerLease, binding, lease };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FilePlaybackRunAuthority', () => {
  it('bootstraps a stopped watermark and stages one exact offer-bound successor', () => {
    const harness = createHarness();
    const offer = acceptOffer(harness, 0, {
      encodedSize: 9_999_999,
      name: 'peer display names and file names are metadata.flac',
    });
    const offerLease = issueLease(harness);
    const binding = bindingFor(offer, 8);

    harness.authority.bootstrapStopped(TOKEN, 7);
    const lease = harness.authority.stageSuccessor(
      TOKEN,
      binding,
      offerLease,
      expectedFor(binding),
    );
    const snapshot = harness.authority.snapshotForLease(TOKEN, lease);

    expect(snapshot).toEqual({ status: 'candidate', binding, offer });
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(JSON.parse(JSON.stringify(snapshot))).toMatchObject({
      status: 'candidate',
      binding: { queueItemId: QID, playbackRevision: 8 },
      offer: { encodedSize: 9_999_999 },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/blob|arrayBuffer|readableStream|mediaBody/iu);
    expect(harness.authority.revisionWatermark(TOKEN)).toBe(7);
    commitRun(harness, lease, binding);
    expect(harness.authority.revisionWatermark(TOKEN)).toBe(8);
  });

  it('supports an arbitrary active baseline and skips non-binding timeline revisions', () => {
    const harness = createHarness();
    const firstOffer = acceptOffer(harness, 0);
    const firstBinding = bindingFor(firstOffer, 700, RUN_IDS[0]);
    const baselineLease = harness.authority.stageBaselineCurrent(
      TOKEN,
      firstBinding,
      issueLease(harness),
      expectedFor(firstBinding),
    );

    expect(harness.authority.currentSnapshot(TOKEN)).toBeNull();
    expect(harness.authority.candidateSnapshot(TOKEN)).toMatchObject({
      status: 'candidate',
      binding: { playbackRevision: 700 },
    });
    expect(harness.authority.revisionWatermark(TOKEN)).toBe(0);
    expect(
      harness.authority.stageBaselineCurrent(TOKEN, { ...firstBinding }, issueLease(harness), {
        ...expectedFor(firstBinding),
      }),
    ).toBe(baselineLease);
    commitRun(harness, baselineLease, firstBinding);
    expect(harness.authority.revisionWatermark(TOKEN)).toBe(700);
    expect(harness.authority.currentSnapshot(TOKEN)).toMatchObject({
      status: 'current',
      binding: { playbackRevision: 700 },
    });
    expect(harness.authority.snapshotForLease(TOKEN, baselineLease)).not.toBeNull();
    expect(() => harness.authority.bootstrapStopped(TOKEN, 700)).toThrow(/one-shot/u);

    const nextOffer = acceptOffer(harness, 1);
    // Revisions 701 and 702 can belong to pause/seek and need no source binding.
    const successor = bindingFor(nextOffer, 703, RUN_IDS[1]);
    const successorLease = harness.authority.stageSuccessor(
      TOKEN,
      successor,
      issueLease(harness),
      expectedFor(successor),
    );
    expect(harness.authority.revisionWatermark(TOKEN)).toBe(700);
    harness.authority.retireCandidate(TOKEN, successorLease);
    expect(harness.authority.revisionWatermark(TOKEN)).toBe(700);

    const replacementOffer = acceptOffer(harness, 2);
    const replacement = bindingFor(replacementOffer, 703, RUN_IDS[2]);
    const replacementLease = harness.authority.stageSuccessor(
      TOKEN,
      replacement,
      issueLease(harness),
      expectedFor(replacement),
    );
    commitRun(harness, replacementLease, replacement);
    expect(harness.authority.revisionWatermark(TOKEN)).toBe(703);
  });

  it('cannot skip an uncommitted active baseline after its candidate is retired', () => {
    const harness = createHarness();
    const baselineOffer = acceptOffer(harness, 0);
    const baselineBinding = bindingFor(baselineOffer, 40, RUN_IDS[0]);
    const baselineLease = harness.authority.stageBaselineCurrent(
      TOKEN,
      baselineBinding,
      issueLease(harness),
      expectedFor(baselineBinding),
    );
    harness.authority.retireCandidate(TOKEN, baselineLease);

    const successorOffer = acceptOffer(harness, 1);
    const successorBinding = bindingFor(successorOffer, 41, RUN_IDS[1]);
    expect(() =>
      harness.authority.stageSuccessor(
        TOKEN,
        successorBinding,
        issueLease(harness),
        expectedFor(successorBinding),
      ),
    ).toThrow(/active baseline must be committed/u);
    expect(harness.authority.currentSnapshot(TOKEN)).toBeNull();
    expect(harness.authority.candidateSnapshot(TOKEN)).toBeNull();
    expect(harness.authority.revisionWatermark(TOKEN)).toBe(0);
  });

  it('allows a successor after exact STOP consumes an unprepared active baseline', () => {
    const harness = createHarness();
    const baselineOffer = acceptOffer(harness, 0);
    const baselineBinding = bindingFor(baselineOffer, 40, RUN_IDS[0]);
    const baselineLease = harness.authority.stageBaselineCurrent(
      TOKEN,
      baselineBinding,
      issueLease(harness),
      expectedFor(baselineBinding),
    );
    const stopped = { ...expectedFor(baselineBinding), revision: 41 };

    harness.authority.commitUnpreparedBaselineStop(
      TOKEN,
      baselineLease,
      expectedFor(baselineBinding),
      stopped,
    );
    expect(harness.authority.revisionWatermark(TOKEN)).toBe(41);
    expect(harness.authority.currentSnapshot(TOKEN)).toBeNull();
    expect(harness.authority.candidateSnapshot(TOKEN)).toBeNull();

    const successorOffer = acceptOffer(harness, 1);
    const successorBinding = bindingFor(successorOffer, 42, RUN_IDS[1]);
    expect(
      harness.authority.stageSuccessor(
        TOKEN,
        successorBinding,
        issueLease(harness),
        expectedFor(successorBinding),
      ),
    ).toBeDefined();
  });

  it('cannot skip an active baseline whose offer expired before its first commit', () => {
    const harness = createHarness();
    const baselineOffer = acceptOffer(harness, 0);
    const baselineBinding = bindingFor(baselineOffer, 90, RUN_IDS[0]);
    harness.authority.stageBaselineCurrent(
      TOKEN,
      baselineBinding,
      issueLease(harness),
      expectedFor(baselineBinding),
    );
    harness.now = 1_001;

    expect(harness.authority.candidateSnapshot(TOKEN)).toBeNull();
    expect(() =>
      harness.authority.stageSuccessor(
        TOKEN,
        baselineBinding,
        Object.freeze({}),
        expectedFor(baselineBinding),
      ),
    ).toThrow(/active baseline must be committed/u);
    expect(harness.authority.currentSnapshot(TOKEN)).toBeNull();
    expect(harness.authority.retiredRunCount(TOKEN)).toBe(1);
  });

  it('allows successors after a genuinely committed active baseline is later retired', () => {
    const harness = createHarness();
    const baselineOffer = acceptOffer(harness, 0);
    const baselineBinding = bindingFor(baselineOffer, 120, RUN_IDS[0]);
    const baselineLease = harness.authority.stageBaselineCurrent(
      TOKEN,
      baselineBinding,
      issueLease(harness),
      expectedFor(baselineBinding),
    );
    commitRun(harness, baselineLease, baselineBinding);
    harness.authority.retireCurrent(TOKEN, baselineLease);

    const successorOffer = acceptOffer(harness, 1);
    const successorBinding = bindingFor(successorOffer, 121, RUN_IDS[1]);
    const successorLease = harness.authority.stageSuccessor(
      TOKEN,
      successorBinding,
      issueLease(harness),
      expectedFor(successorBinding),
    );

    expect(harness.authority.candidateSnapshot(TOKEN)).toMatchObject({
      status: 'candidate',
      binding: { playbackRevision: 121, runId: RUN_IDS[1] },
    });
    expect(successorLease).toBeTypeOf('object');
  });

  it('revalidates a candidate at commit, swaps atomically, and detaches current from offer expiry', () => {
    const harness = createHarness();
    const { binding, lease, offerLease } = stageFirst(harness);
    const isStillCurrent = vi.fn(() => true);
    const committed = harness.authority.commitCandidate(
      TOKEN,
      lease,
      expectedFor(binding),
      isStillCurrent,
    );

    expect(isStillCurrent).toHaveBeenCalledTimes(2);
    harness.now = 1_001;
    expect(harness.registry.resolveCurrentOfferLease(TOKEN, offerLease)).toBeNull();
    expect(harness.authority.currentSnapshot(TOKEN)).toEqual(committed);
    expect(committed.status).toBe('current');
    expect(harness.authority.candidateSnapshot(TOKEN)).toBeNull();
  });

  it('retires a rev703 candidate when the controller advances to rev704 during offer revalidation', () => {
    let advanceDuringOfferRead = false;
    let controllerRevision = 703;
    const harness = createHarness({}, () => {
      if (!advanceDuringOfferRead) return;
      advanceDuringOfferRead = false;
      controllerRevision = 704;
    });
    const offer = acceptOffer(harness, 0);
    const binding = bindingFor(offer, 703, RUN_IDS[0]);
    harness.authority.bootstrapStopped(TOKEN, 700);
    const lease = harness.authority.stageSuccessor(
      TOKEN,
      binding,
      issueLease(harness),
      expectedFor(binding),
    );
    const isStillCurrent = vi.fn(() => controllerRevision === binding.playbackRevision);
    advanceDuringOfferRead = true;

    expect(() =>
      harness.authority.commitCandidate(TOKEN, lease, expectedFor(binding), isStillCurrent),
    ).toThrow(/no longer the controller current state/u);
    expect(isStillCurrent).toHaveBeenCalledTimes(2);
    expect(controllerRevision).toBe(704);
    expect(harness.authority.revisionWatermark(TOKEN)).toBe(700);
    expect(harness.authority.snapshotForLease(TOKEN, lease)).toBeNull();
    expect(harness.authority.retiredRunCount(TOKEN)).toBe(1);
  });

  it('parses commit expected state without accessors and fail-closes live-authority reentry', () => {
    const descriptorHarness = createHarness();
    const descriptorCandidate = stageFirst(descriptorHarness);
    const hostileExpected = { ...expectedFor(descriptorCandidate.binding) };
    let getterCalls = 0;
    Object.defineProperty(hostileExpected, 'revision', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return descriptorCandidate.binding.playbackRevision;
      },
    });
    const unusedAuthority = vi.fn(() => true);

    expect(() =>
      descriptorHarness.authority.commitCandidate(
        TOKEN,
        descriptorCandidate.lease,
        hostileExpected,
        unusedAuthority,
      ),
    ).toThrow(/not the controller current state/u);
    expect(getterCalls).toBe(0);
    expect(unusedAuthority).not.toHaveBeenCalled();
    expect(descriptorHarness.authority.isClosed()).toBe(false);
    expect(
      descriptorHarness.authority.snapshotForLease(TOKEN, descriptorCandidate.lease),
    ).toBeNull();

    const reentrantHarness = createHarness();
    const reentrantCandidate = stageFirst(reentrantHarness);
    let nestedError: unknown;
    let entered = false;
    const reentrantAuthority = () => {
      if (!entered) {
        entered = true;
        try {
          reentrantHarness.authority.commitCandidate(
            TOKEN,
            reentrantCandidate.lease,
            expectedFor(reentrantCandidate.binding),
            () => true,
          );
        } catch (error) {
          nestedError = error;
        }
      }
      return true;
    };

    expect(() =>
      reentrantHarness.authority.commitCandidate(
        TOKEN,
        reentrantCandidate.lease,
        expectedFor(reentrantCandidate.binding),
        reentrantAuthority,
      ),
    ).toThrow(FilePlaybackRunAuthorityFatalError);
    expect(nestedError).toBeInstanceOf(FilePlaybackRunAuthorityFatalError);
    expect(reentrantHarness.authority.isClosed()).toBe(true);
    expect(reentrantHarness.authority.currentSnapshot(TOKEN)).toBeNull();
  });

  it('fails and retires a candidate whose offer expires before commit', () => {
    const harness = createHarness();
    const { binding, lease } = stageFirst(harness);
    harness.now = 1_001;

    expect(() => commitRun(harness, lease, binding)).toThrow(/no longer current/u);
    expect(harness.authority.currentSnapshot(TOKEN)).toBeNull();
    expect(harness.authority.snapshotForLease(TOKEN, lease)).toBeNull();
    expect(harness.authority.retiredRunCount(TOKEN)).toBe(1);
  });

  it('invalidates a candidate on offer supersession while preserving an already committed current', () => {
    const harness = createHarness();
    const { binding: firstBinding, lease: firstLease } = stageFirst(harness);
    commitRun(harness, firstLease, firstBinding);

    const secondOffer = acceptOffer(harness, 1);
    const secondBinding = bindingFor(secondOffer, 2, RUN_IDS[1]);
    const secondLease = harness.authority.stageSuccessor(
      TOKEN,
      secondBinding,
      issueLease(harness),
      expectedFor(secondBinding),
    );
    acceptOffer(harness, 2);

    expect(harness.authority.candidateSnapshot(TOKEN)).toBeNull();
    expect(harness.authority.snapshotForLease(TOKEN, secondLease)).toBeNull();
    expect(harness.authority.currentSnapshot(TOKEN)?.binding.runId).toBe(RUN_IDS[0]);
  });

  it('makes an exact candidate replay idempotent and rejects a conflicting candidate', () => {
    const harness = createHarness();
    const offer = acceptOffer(harness, 0);
    const lease = issueLease(harness);
    const binding = bindingFor(offer, 1);
    harness.authority.bootstrapStopped(TOKEN, 0);

    const first = harness.authority.stageSuccessor(TOKEN, binding, lease, expectedFor(binding));
    const replay = harness.authority.stageSuccessor(TOKEN, { ...binding }, issueLease(harness), {
      ...expectedFor(binding),
    });
    expect(replay).toBe(first);

    const conflicting = { ...binding, runId: RUN_IDS[1] };
    expect(() =>
      harness.authority.stageSuccessor(
        TOKEN,
        conflicting,
        issueLease(harness),
        expectedFor(conflicting),
      ),
    ).toThrow(/conflicts/u);
  });

  it('requires exact binding, expected state, scope, and complete offer correlation', () => {
    const harness = createHarness();
    const offer = acceptOffer(harness, 0);
    const offerLease = issueLease(harness);
    const binding = bindingFor(offer, 1);
    harness.authority.bootstrapStopped(TOKEN, 0);

    expect(() =>
      harness.authority.stageSuccessor(
        TOKEN,
        { ...binding, connectionId: 'connection:foreign' },
        offerLease,
        expectedFor(binding),
      ),
    ).toThrow(/different connection scope/u);
    expect(() =>
      harness.authority.stageSuccessor(
        TOKEN,
        { ...binding, prepareRevision: 2 },
        offerLease,
        expectedFor(binding),
      ),
    ).toThrow(/does not match its current source offer/u);
    expect(() =>
      harness.authority.stageSuccessor(TOKEN, binding, offerLease, {
        ...expectedFor(binding),
        revision: 2,
      }),
    ).toThrow(/expected playback state/u);
    let expectedGetterCalls = 0;
    const hostileExpected = { ...expectedFor(binding) };
    Object.defineProperty(hostileExpected, 'revision', {
      enumerable: true,
      get() {
        expectedGetterCalls += 1;
        return 1;
      },
    });
    expect(() =>
      harness.authority.stageSuccessor(TOKEN, binding, offerLease, hostileExpected),
    ).toThrow(/expected.*identity is invalid/iu);
    expect(expectedGetterCalls).toBe(0);
    expect(() =>
      harness.authority.stageSuccessor(
        TOKEN,
        { ...binding, unexpected: true },
        offerLease,
        expectedFor(binding),
      ),
    ).toThrow(/malformed/u);
  });

  it('does not invoke hostile accessors and fail-closes parser reentry', () => {
    const harness = createHarness();
    const offer = acceptOffer(harness, 0);
    const offerLease = issueLease(harness);
    const canonical = bindingFor(offer, 1);
    harness.authority.bootstrapStopped(TOKEN, 0);

    let getterCalls = 0;
    const accessor = { ...canonical };
    Object.defineProperty(accessor, 'runId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return canonical.runId;
      },
    });
    expect(() =>
      harness.authority.stageSuccessor(TOKEN, accessor, offerLease, expectedFor(canonical)),
    ).toThrow(/malformed/u);
    expect(getterCalls).toBe(0);
    expect(harness.authority.isClosed()).toBe(false);

    let nestedError: unknown;
    let entered = false;
    const proxy = new Proxy(
      { ...canonical },
      {
        ownKeys(target) {
          if (!entered) {
            entered = true;
            try {
              harness.authority.stageSuccessor(
                TOKEN,
                canonical,
                offerLease,
                expectedFor(canonical),
              );
            } catch (error) {
              nestedError = error;
            }
          }
          return Reflect.ownKeys(target);
        },
      },
    );
    expect(() =>
      harness.authority.stageSuccessor(TOKEN, proxy, offerLease, expectedFor(canonical)),
    ).toThrow(FilePlaybackRunAuthorityFatalError);
    expect(nestedError).toBeInstanceOf(FilePlaybackRunAuthorityFatalError);
    expect(harness.authority.isClosed()).toBe(true);
    expect(harness.fatal).toHaveBeenCalledTimes(1);
  });

  it('fail-closes reentry from the offer registry room-clock boundary without reviving outer work', () => {
    let authority: FilePlaybackRunAuthority | null = null;
    let armed = false;
    let nestedError: unknown;
    const harness = createHarness({}, () => {
      if (!armed || !authority) return;
      armed = false;
      try {
        authority.bootstrapStopped(TOKEN, 0);
      } catch (error) {
        nestedError = error;
      }
    });
    authority = harness.authority;
    const offer = acceptOffer(harness, 0);
    const offerLease = issueLease(harness);
    const binding = bindingFor(offer, 1);
    harness.authority.bootstrapStopped(TOKEN, 0);
    armed = true;

    expect(() =>
      harness.authority.stageSuccessor(TOKEN, binding, offerLease, expectedFor(binding)),
    ).toThrow(FilePlaybackRunAuthorityFatalError);
    expect(nestedError).toBeInstanceOf(FilePlaybackRunAuthorityFatalError);
    expect(harness.authority.currentSnapshot(TOKEN)).toBeNull();
    expect(harness.authority.isClosed()).toBe(true);
  });

  it('rejects foreign tokens, forged offer leases, and leases from another authority', () => {
    const harness = createHarness();
    const offer = acceptOffer(harness, 0);
    const offerLease = issueLease(harness);
    const binding = bindingFor(offer, 1);
    harness.authority.bootstrapStopped(TOKEN, 0);

    expect(() =>
      harness.authority.stageSuccessor(FOREIGN_TOKEN, binding, offerLease, expectedFor(binding)),
    ).toThrow(/connection token/u);
    expect(() =>
      harness.authority.stageSuccessor(TOKEN, binding, Object.freeze({}), expectedFor(binding)),
    ).toThrow(/offer lease is not current/u);

    const foreignRegistry = new FileMediaOfferRegistry({
      liveConnectionToken: TOKEN,
      sessionId: SESSION_ID,
      connectionId: CONNECTION_ID,
      maxEncodedSize: 10_000_000,
      nowRoomTimeMs: () => harness.now,
      onFatalConnection: vi.fn(),
    });
    expect(foreignRegistry.admitQueueItem(TOKEN, QID)).toBe(true);
    expect(foreignRegistry.accept(TOKEN, offer).accepted).toBe(true);
    const foreignOfferLease = foreignRegistry.issueCurrentOfferLease(TOKEN, QID);
    expect(foreignOfferLease).not.toBeNull();
    expect(() =>
      harness.authority.stageSuccessor(TOKEN, binding, foreignOfferLease, expectedFor(binding)),
    ).toThrow(/offer lease is not current/u);

    const firstLease = harness.authority.stageSuccessor(
      TOKEN,
      binding,
      offerLease,
      expectedFor(binding),
    );

    const other = new FilePlaybackRunAuthority({
      liveConnectionToken: TOKEN,
      sessionId: SESSION_ID,
      connectionId: CONNECTION_ID,
      offerRegistry: harness.registry,
      onFatalConnection: vi.fn(),
    });
    other.bootstrapStopped(TOKEN, 0);
    expect(() =>
      other.commitCandidate(TOKEN, firstLease, expectedFor(binding), () => true),
    ).toThrow(/forged or retired/u);
    expect(harness.authority.snapshotForLease(FOREIGN_TOKEN, firstLease)).toBeNull();
    expect(harness.authority.close(FOREIGN_TOKEN)).toBe(false);
  });

  it('accepts skipped timeline revisions, rejects rollback, and does not burn cancelled revisions', () => {
    const harness = createHarness();
    const firstOffer = acceptOffer(harness, 0);
    const firstBinding = bindingFor(firstOffer, 8, RUN_IDS[0]);
    harness.authority.bootstrapStopped(TOKEN, 5);
    const firstLease = harness.authority.stageSuccessor(
      TOKEN,
      firstBinding,
      issueLease(harness),
      expectedFor(firstBinding),
    );
    expect(harness.authority.revisionWatermark(TOKEN)).toBe(5);
    harness.authority.retireCandidate(TOKEN, firstLease);
    expect(harness.authority.revisionWatermark(TOKEN)).toBe(5);

    const nextOffer = acceptOffer(harness, 1);
    const equalForeign = bindingFor(nextOffer, 5, RUN_IDS[1]);
    expect(() =>
      harness.authority.stageSuccessor(
        TOKEN,
        equalForeign,
        issueLease(harness),
        expectedFor(equalForeign),
      ),
    ).toThrow(/not newer than committed/u);
    const rollback = bindingFor(nextOffer, 4, RUN_IDS[1]);
    expect(() =>
      harness.authority.stageSuccessor(TOKEN, rollback, issueLease(harness), expectedFor(rollback)),
    ).toThrow(/not newer than committed/u);

    // The cancelled revision 8 was never committed, so a fresh preparation/run may reuse it.
    const replacement = bindingFor(nextOffer, 8, RUN_IDS[1]);
    const replacementLease = harness.authority.stageSuccessor(
      TOKEN,
      replacement,
      issueLease(harness),
      expectedFor(replacement),
    );
    expect(harness.authority.revisionWatermark(TOKEN)).toBe(5);
    commitRun(harness, replacementLease, replacement);
    expect(harness.authority.revisionWatermark(TOKEN)).toBe(8);
  });

  it('makes a retired binding, prepare, and run occurrence irreversible ABA', () => {
    const harness = createHarness();
    const { binding, lease } = stageFirst(harness);
    harness.authority.retireCandidate(TOKEN, lease);

    expect(() =>
      harness.authority.stageSuccessor(TOKEN, binding, issueLease(harness), expectedFor(binding)),
    ).toThrow(/retired/u);
    expect(harness.authority.retiredRunCount(TOKEN)).toBe(1);

    const secondOffer = acceptOffer(harness, 1);
    const reusedRun = bindingFor(secondOffer, 1, binding.runId);
    expect(() =>
      harness.authority.stageSuccessor(
        TOKEN,
        reusedRun,
        issueLease(harness),
        expectedFor(reusedRun),
      ),
    ).toThrow(/retired/u);

    const freshRun = bindingFor(secondOffer, 1, RUN_IDS[1]);
    expect(
      harness.authority.stageSuccessor(TOKEN, freshRun, issueLease(harness), expectedFor(freshRun)),
    ).toBeTypeOf('object');
  });

  it('closes exactly when the bounded ABA tombstone capacity is exhausted', () => {
    const harness = createHarness({ maxRetiredRuns: 1 });
    const { lease } = stageFirst(harness);
    harness.authority.retireCandidate(TOKEN, lease);

    const secondOffer = acceptOffer(harness, 1);
    const secondBinding = bindingFor(secondOffer, 2, RUN_IDS[1]);
    const secondLease = harness.authority.stageSuccessor(
      TOKEN,
      secondBinding,
      issueLease(harness),
      expectedFor(secondBinding),
    );
    expect(() => harness.authority.retireCandidate(TOKEN, secondLease)).toThrow(
      FilePlaybackRunAuthorityFatalError,
    );
    expect(harness.authority.isClosed()).toBe(true);
    expect(harness.authority.currentSnapshot(TOKEN)).toBeNull();
    expect(harness.fatal).toHaveBeenCalledTimes(1);
    expect(() => harness.authority.bootstrapStopped(TOKEN, 0)).toThrow(
      FilePlaybackRunAuthorityFatalError,
    );
  });

  it('does not partially promote a candidate when commit cannot retire the old current', () => {
    const harness = createHarness({ maxRetiredRuns: 1 });
    const first = stageFirst(harness);
    commitRun(harness, first.lease, first.binding);

    const secondOffer = acceptOffer(harness, 1);
    const secondBinding = bindingFor(secondOffer, 2, RUN_IDS[1]);
    const secondLease = harness.authority.stageSuccessor(
      TOKEN,
      secondBinding,
      issueLease(harness),
      expectedFor(secondBinding),
    );
    commitRun(harness, secondLease, secondBinding);

    const thirdOffer = acceptOffer(harness, 2);
    const thirdBinding = bindingFor(thirdOffer, 3, RUN_IDS[2]);
    const thirdLease = harness.authority.stageSuccessor(
      TOKEN,
      thirdBinding,
      issueLease(harness),
      expectedFor(thirdBinding),
    );
    expect(() => commitRun(harness, thirdLease, thirdBinding)).toThrow(
      FilePlaybackRunAuthorityFatalError,
    );
    expect(harness.authority.isClosed()).toBe(true);
    expect(harness.authority.currentSnapshot(TOKEN)).toBeNull();
    expect(harness.authority.snapshotForLease(TOKEN, secondLease)).toBeNull();
    expect(harness.authority.snapshotForLease(TOKEN, thirdLease)).toBeNull();
  });

  it('deletes retired and revoked lease keys so retained leases cannot retain metadata', () => {
    const deleteLease = vi.spyOn(WeakMap.prototype, 'delete');
    const retiredHarness = createHarness();
    const retired = stageFirst(retiredHarness);

    retiredHarness.authority.retireCandidate(TOKEN, retired.lease);
    expect(deleteLease).toHaveBeenCalledWith(retired.lease);
    expect(retiredHarness.authority.snapshotForLease(TOKEN, retired.lease)).toBeNull();

    const closedHarness = createHarness();
    const current = stageFirst(closedHarness);
    commitRun(closedHarness, current.lease, current.binding);
    const candidateOffer = acceptOffer(closedHarness, 1);
    const candidateBinding = bindingFor(candidateOffer, 4, RUN_IDS[1]);
    const candidateLease = closedHarness.authority.stageSuccessor(
      TOKEN,
      candidateBinding,
      issueLease(closedHarness),
      expectedFor(candidateBinding),
    );
    commitRun(closedHarness, candidateLease, candidateBinding);
    expect(deleteLease).toHaveBeenCalledWith(current.lease);

    const closingCandidateOffer = acceptOffer(closedHarness, 2);
    const closingCandidateBinding = bindingFor(closingCandidateOffer, 6, RUN_IDS[2]);
    const closingCandidateLease = closedHarness.authority.stageSuccessor(
      TOKEN,
      closingCandidateBinding,
      issueLease(closedHarness),
      expectedFor(closingCandidateBinding),
    );

    closedHarness.authority.close(TOKEN);
    expect(deleteLease).toHaveBeenCalledWith(candidateLease);
    expect(deleteLease).toHaveBeenCalledWith(closingCandidateLease);
    expect(closedHarness.authority.snapshotForLease(TOKEN, candidateLease)).toBeNull();
    expect(closedHarness.authority.snapshotForLease(TOKEN, closingCandidateLease)).toBeNull();
  });

  it('retains only prepareId and runId tombstones, without a composite binding key', () => {
    const harness = createHarness();
    const candidate = stageFirst(harness);
    const addTombstone = vi.spyOn(Set.prototype, 'add');
    addTombstone.mockClear();

    harness.authority.retireCandidate(TOKEN, candidate.lease);

    expect(addTombstone.mock.calls.map(([value]) => value)).toEqual([
      candidate.binding.prepareId,
      candidate.binding.runId,
    ]);
    expect(harness.authority.retiredRunCount(TOKEN)).toBe(1);
  });

  it('retires only exact current/candidate leases and close revokes both without late revival', () => {
    const harness = createHarness();
    const { binding, lease } = stageFirst(harness);
    expect(() => harness.authority.retireCurrent(TOKEN, lease)).toThrow(/exact current/u);
    const forged = Object.freeze({}) as FilePlaybackRunLease;
    expect(() => harness.authority.retireCandidate(TOKEN, forged)).toThrow(/forged/u);
    commitRun(harness, lease, binding);
    expect(() => harness.authority.retireCandidate(TOKEN, lease)).toThrow(/exact.*candidate/u);

    expect(harness.authority.close(TOKEN)).toBe(true);
    expect(harness.authority.close(TOKEN)).toBe(true);
    expect(harness.authority.currentSnapshot(TOKEN)).toBeNull();
    expect(harness.authority.revisionWatermark(TOKEN)).toBeNull();
    expect(() => commitRun(harness, lease, binding)).toThrow(/closed/u);
  });

  it('requires exact descriptor-safe options and an authentic registry instance', () => {
    const harness = createHarness();
    const valid: FilePlaybackRunAuthorityOptions = {
      liveConnectionToken: TOKEN,
      sessionId: SESSION_ID,
      connectionId: CONNECTION_ID,
      offerRegistry: harness.registry,
      onFatalConnection: vi.fn(),
    };
    let getterCalls = 0;
    const accessor = { ...valid };
    Object.defineProperty(accessor, 'offerRegistry', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return harness.registry;
      },
    });
    expect(() => new FilePlaybackRunAuthority(accessor)).toThrow(/options are invalid/u);
    expect(getterCalls).toBe(0);
    expect(
      () =>
        new FilePlaybackRunAuthority({
          ...valid,
          unexpected: true,
        } as FilePlaybackRunAuthorityOptions),
    ).toThrow(/options are invalid/u);
    expect(
      () =>
        new FilePlaybackRunAuthority({
          ...valid,
          offerRegistry: Object.create(harness.registry) as FileMediaOfferRegistry,
        }),
    ).toThrow(/exact offer registry/u);
    expect(() => new FilePlaybackRunAuthority({ ...valid, maxRetiredRuns: 0 })).toThrow(RangeError);
  });
});
