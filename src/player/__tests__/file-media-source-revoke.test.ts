import { describe, expect, it } from 'vitest';

import {
  FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_MAX_RAW_FRAME_BYTES,
  FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE,
} from '../../network/file-playback-transport-contract.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  createPeerRangeFileMediaSourceOfferV2,
  type PeerRangeFileMediaSourceOfferV2Input,
} from '../file-media-source-offer.ts';
import {
  createFileMediaSourceRevokeV2,
  fileMediaSourceRevokeMatchesOfferV2,
  FILE_MEDIA_SOURCE_REVOKE_V2_MAX_FRAME_BYTES,
  FILE_MEDIA_SOURCE_REVOKE_V2_PROTOCOL_VERSION,
  parseFileMediaSourceRevokeV2,
  serializeFileMediaSourceRevokeV2,
  type FileMediaSourceRevokeV2,
  type FileMediaSourceRevokeV2Input,
} from '../file-media-source-revoke.ts';

const SESSION_ID = 'session:alpha';
const CONNECTION_ID = 'connection:alpha';
const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const OTHER_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000002' as QueueItemId;
const PREPARE_ID = '00000000-0000-4000-8000-000000000011';
const OTHER_PREPARE_ID = '00000000-0000-4000-8000-000000000012';
const SOURCE_IDENTITY = 'source:alpha';
const TRANSFER_SESSION_ID = 'transfer:alpha';

function rawRevoke(overrides: Partial<FileMediaSourceRevokeV2> = {}): FileMediaSourceRevokeV2 {
  return {
    protocolVersion: FILE_MEDIA_SOURCE_REVOKE_V2_PROTOCOL_VERSION,
    type: FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE,
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    prepareId: PREPARE_ID,
    prepareRevision: 2,
    queueItemId: QUEUE_ITEM_ID,
    sourceIdentity: SOURCE_IDENTITY,
    transferSessionId: TRANSFER_SESSION_ID,
    ...overrides,
  };
}

function creatorInput(
  overrides: Partial<FileMediaSourceRevokeV2Input> = {},
): FileMediaSourceRevokeV2Input {
  return {
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    prepareId: PREPARE_ID,
    prepareRevision: 2,
    queueItemId: QUEUE_ITEM_ID,
    sourceIdentity: SOURCE_IDENTITY,
    transferSessionId: TRANSFER_SESSION_ID,
    ...overrides,
  };
}

function peerOffer(overrides: Partial<PeerRangeFileMediaSourceOfferV2Input> = {}) {
  return createPeerRangeFileMediaSourceOfferV2({
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    prepareId: PREPARE_ID,
    prepareRevision: 2,
    queueItemId: QUEUE_ITEM_ID,
    sourceIdentity: SOURCE_IDENTITY,
    transferSessionId: TRANSFER_SESSION_ID,
    handleId: 'handle:alpha',
    encodedSize: 1_024,
    name: 'alpha.wav',
    mime: 'audio/wav',
    expiresAtRoomTimeMs: 60_000,
    ...overrides,
  });
}

describe('FileMediaSourceRevokeV2 wire contract', () => {
  it('round-trips one canonical, frozen exact-offer retirement record', () => {
    const revoke = createFileMediaSourceRevokeV2(creatorInput());
    const serialized = serializeFileMediaSourceRevokeV2(revoke);

    expect(revoke).toEqual(rawRevoke());
    expect(Object.getPrototypeOf(revoke)).toBeNull();
    expect(Object.isFrozen(revoke)).toBe(true);
    expect(Object.keys(revoke)).toEqual([
      'protocolVersion',
      'type',
      'sessionId',
      'connectionId',
      'prepareId',
      'prepareRevision',
      'queueItemId',
      'sourceIdentity',
      'transferSessionId',
    ]);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
      FILE_MEDIA_SOURCE_REVOKE_V2_MAX_FRAME_BYTES,
    );
    expect(parseFileMediaSourceRevokeV2(JSON.parse(serialized))).toEqual(revoke);
    expect(FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_MAX_RAW_FRAME_BYTES).toBe(4 * 1024);
    expect(FILE_MEDIA_SOURCE_REVOKE_V2_MAX_FRAME_BYTES).toBe(4 * 1024);
  });

  it('requires exact data-only creator and wire records', () => {
    expect(() =>
      createFileMediaSourceRevokeV2({ ...creatorInput(), extra: true } as never),
    ).toThrow(/input is invalid/u);
    expect(parseFileMediaSourceRevokeV2({ ...rawRevoke(), extra: true })).toBeNull();
    expect(parseFileMediaSourceRevokeV2(null)).toBeNull();
    expect(parseFileMediaSourceRevokeV2('revoke')).toBeNull();
    expect(parseFileMediaSourceRevokeV2([])).toBeNull();
    expect(parseFileMediaSourceRevokeV2({})).toBeNull();
    expect(
      parseFileMediaSourceRevokeV2({
        ...rawRevoke(),
        protocolVersion: 1,
      }),
    ).toBeNull();
    expect(
      parseFileMediaSourceRevokeV2({
        ...rawRevoke(),
        type: 'FILE_MEDIA_SOURCE_OFFER_V2',
      }),
    ).toBeNull();
    expect(() => serializeFileMediaSourceRevokeV2({ ...rawRevoke(), extra: true })).toThrow(
      /revoke is invalid/u,
    );
  });

  it('never invokes accessors and rejects hidden, symbol, and inherited state', () => {
    let getterCalls = 0;
    const accessor = { ...rawRevoke() };
    Object.defineProperty(accessor, 'prepareId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return PREPARE_ID;
      },
    });
    expect(parseFileMediaSourceRevokeV2(accessor)).toBeNull();
    expect(getterCalls).toBe(0);

    const creatorAccessor = creatorInput();
    Object.defineProperty(creatorAccessor, 'prepareId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return PREPARE_ID;
      },
    });
    expect(() => createFileMediaSourceRevokeV2(creatorAccessor)).toThrow(/input is invalid/u);
    expect(getterCalls).toBe(0);

    const hidden = { ...rawRevoke() };
    Object.defineProperty(hidden, 'hidden', { value: true });
    expect(parseFileMediaSourceRevokeV2(hidden)).toBeNull();

    const symbol = { ...rawRevoke(), [Symbol('extra')]: true };
    expect(parseFileMediaSourceRevokeV2(symbol)).toBeNull();

    const inherited = Object.assign(Object.create({ inherited: true }), rawRevoke());
    expect(parseFileMediaSourceRevokeV2(inherited)).toBeNull();

    const nullPrototype = Object.assign(Object.create(null), rawRevoke());
    expect(parseFileMediaSourceRevokeV2(nullPrototype)).toEqual(rawRevoke());
  });

  it('rejects malformed scope, revisions, identifiers, UUIDs, and authority aliases', () => {
    const invalidValues: unknown[] = [
      rawRevoke({ sessionId: CONNECTION_ID }),
      rawRevoke({ sessionId: ' session:alpha' }),
      rawRevoke({ connectionId: `connection:${'x'.repeat(192)}` }),
      rawRevoke({ prepareId: 'not-a-uuid' }),
      rawRevoke({ prepareRevision: 0 }),
      rawRevoke({ prepareRevision: 1.5 }),
      rawRevoke({ prepareRevision: Number.MAX_SAFE_INTEGER + 1 }),
      rawRevoke({ queueItemId: 'not-a-uuid' as QueueItemId }),
      rawRevoke({ sourceIdentity: 'source:\nalpha' }),
      rawRevoke({ transferSessionId: '' }),
      rawRevoke({ sourceIdentity: PREPARE_ID }),
      rawRevoke({ transferSessionId: SOURCE_IDENTITY }),
    ];

    for (const value of invalidValues) {
      expect(parseFileMediaSourceRevokeV2(value)).toBeNull();
    }
  });

  it('preserves the maximum valid UTF-8 identifier combination within 4 KiB', () => {
    const revoke = createFileMediaSourceRevokeV2(
      creatorInput({
        sessionId: '가'.repeat(256),
        connectionId: '나'.repeat(192),
        sourceIdentity: '다'.repeat(256),
        transferSessionId: '라'.repeat(256),
      }),
    );
    const serialized = serializeFileMediaSourceRevokeV2(revoke);

    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(4 * 1024);
    expect(parseFileMediaSourceRevokeV2(JSON.parse(serialized))).toEqual(revoke);
  });

  it('rejects an oversized raw representation before it can become canonical', () => {
    const oversized = rawRevoke({ sessionId: '가'.repeat(2_048) });
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(
      FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_MAX_RAW_FRAME_BYTES,
    );
    expect(parseFileMediaSourceRevokeV2(oversized)).toBeNull();
    expect(() => serializeFileMediaSourceRevokeV2(oversized)).toThrow(/revoke is invalid/u);
  });

  it('matches every exact offer identity field independent of transport details', () => {
    const revoke = createFileMediaSourceRevokeV2(creatorInput());
    const offer = peerOffer();

    expect(fileMediaSourceRevokeMatchesOfferV2(revoke, offer)).toBe(true);
    expect(
      fileMediaSourceRevokeMatchesOfferV2(
        revoke,
        peerOffer({
          handleId: 'handle:replacement',
          encodedSize: 2_048,
          name: 'replacement.wav',
        }),
      ),
    ).toBe(true);

    const mismatches = [
      rawRevoke({ sessionId: 'session:beta' }),
      rawRevoke({ connectionId: 'connection:beta' }),
      rawRevoke({ prepareId: OTHER_PREPARE_ID }),
      rawRevoke({ prepareRevision: 3 }),
      rawRevoke({ queueItemId: OTHER_QUEUE_ITEM_ID }),
      rawRevoke({ sourceIdentity: 'source:beta' }),
      rawRevoke({ transferSessionId: 'transfer:beta' }),
    ];
    for (const mismatch of mismatches) {
      expect(fileMediaSourceRevokeMatchesOfferV2(mismatch, offer)).toBe(false);
    }
    expect(fileMediaSourceRevokeMatchesOfferV2(null, offer)).toBe(false);
    expect(fileMediaSourceRevokeMatchesOfferV2(revoke, null)).toBe(false);
    expect(fileMediaSourceRevokeMatchesOfferV2(revoke, { ...offer, extra: true })).toBe(false);
  });
});
