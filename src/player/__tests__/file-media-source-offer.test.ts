import { afterEach, describe, expect, it, vi } from 'vitest';

import { REMOTE_SHARE_AES_GCM_TAG_BYTES, REMOTE_SHARE_MAX_BYTES } from '../../core/constants.ts';
import { MAX_FILE_PLAYBACK_ROOM_TIME_MS } from '../../network/file-playback-clock-exchange.ts';
import { FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES } from '../../network/file-playback-transport-contract.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  FILE_MEDIA_SOURCE_OFFER_V2_MAX_FRAME_BYTES,
  FILE_MEDIA_SOURCE_OFFER_V2_MAX_IDENTIFIER_LENGTH,
  FileMediaOfferRegistry,
  createFileMediaPrepareId,
  createPeerRangeFileMediaSourceOfferV2,
  createR2WholeBlobFileMediaSourceOfferV2,
  parseFileMediaSourceOfferV2,
  serializeFileMediaSourceOfferV2,
  type PeerRangeFileMediaSourceOfferV2,
  type PeerRangeFileMediaSourceOfferV2Input,
  type R2WholeBlobFileMediaSourceOfferV2,
  type R2WholeBlobFileMediaSourceOfferV2Input,
} from '../file-media-source-offer.ts';
import { isQueueItemId } from '../queue-model.ts';
import {
  PEER_RANGE_MAX_CONNECTION_ID_LENGTH,
  PEER_RANGE_MAX_HANDLE_ID_LENGTH,
} from '../sources/peer-range-protocol.ts';

const TOKEN = Object.freeze({ connection: 'live' });
const SESSION_ID = 'session:one';
const CONNECTION_ID = 'connection:one';
const QUEUE_ONE = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const QUEUE_TWO = '00000000-0000-4000-8000-000000000002' as QueueItemId;
const PREPARE_ONE = '10000000-0000-4000-8000-000000000001';
const R2_OBJECT_ONE = '20000000-0000-4000-8000-000000000001';
const R2_KEY_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const R2_IV_B64 = 'AAAAAAAAAAAAAAAA';

function uuidSuffix(value: number): string {
  return value.toString(16).padStart(12, '0');
}

function queueId(value: number): QueueItemId {
  return `00000000-0000-4000-8000-${uuidSuffix(value)}` as QueueItemId;
}

function prepareId(value: number): string {
  return `10000000-0000-4000-8000-${uuidSuffix(value)}`;
}

function input(
  overrides: Partial<PeerRangeFileMediaSourceOfferV2Input> = {},
): PeerRangeFileMediaSourceOfferV2Input {
  return {
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    prepareId: PREPARE_ONE,
    prepareRevision: 1,
    queueItemId: QUEUE_ONE,
    sourceIdentity: 'source:one',
    transferSessionId: 'transfer:one',
    handleId: 'handle:one',
    encodedSize: 1024,
    name: 'orchestra.flac',
    mime: 'audio/flac',
    expiresAtRoomTimeMs: 2_000,
    ...overrides,
  };
}

function offer(
  overrides: Partial<PeerRangeFileMediaSourceOfferV2Input> = {},
): Readonly<PeerRangeFileMediaSourceOfferV2> {
  return createPeerRangeFileMediaSourceOfferV2(input(overrides));
}

function r2Input(
  overrides: Partial<R2WholeBlobFileMediaSourceOfferV2Input> = {},
): R2WholeBlobFileMediaSourceOfferV2Input {
  return {
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    prepareId: PREPARE_ONE,
    prepareRevision: 1,
    queueItemId: QUEUE_ONE,
    sourceIdentity: 'source:one',
    transferSessionId: 'transfer:one',
    storageRoomId: 'r2-room_one',
    objectId: R2_OBJECT_ONE,
    encodedSize: 1024,
    encryptedSize: 1024 + REMOTE_SHARE_AES_GCM_TAG_BYTES,
    keyB64: R2_KEY_B64,
    ivB64: R2_IV_B64,
    name: 'orchestra.wav',
    mime: 'audio/wav',
    expiresAtRoomTimeMs: 2_000,
    ...overrides,
  };
}

function r2Offer(
  overrides: Partial<R2WholeBlobFileMediaSourceOfferV2Input> = {},
): Readonly<R2WholeBlobFileMediaSourceOfferV2> {
  return createR2WholeBlobFileMediaSourceOfferV2(r2Input(overrides));
}

function registry(
  overrides: Partial<ConstructorParameters<typeof FileMediaOfferRegistry>[0]> = {},
) {
  let now = 1_000;
  const fatal = vi.fn();
  const instance = new FileMediaOfferRegistry({
    liveConnectionToken: TOKEN,
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    maxEncodedSize: 10_000,
    nowRoomTimeMs: () => now,
    onFatalConnection: fatal,
    ...overrides,
  });
  return {
    fatal,
    instance,
    setNow(value: number) {
      now = value;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('file media source offer V2', () => {
  it('creates one canonical peer-range preparation contract without playback identity', () => {
    const value = offer();
    const serialized = serializeFileMediaSourceOfferV2(value);

    expect(value).toEqual({
      protocolVersion: 2,
      type: 'FILE_MEDIA_SOURCE_OFFER_V2',
      transport: 'peer-range',
      ...input(),
    });
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.isFrozen(value)).toBe(true);
    expect(serialized).not.toMatch(/runId|rendezvous|sampleRate|channelCount|duration/u);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
      FILE_MEDIA_SOURCE_OFFER_V2_MAX_FRAME_BYTES,
    );
    expect(parseFileMediaSourceOfferV2(JSON.parse(serialized))).toEqual(value);
  });

  it('creates one canonical R2 whole-Blob contract without endpoint or cleanup authority', () => {
    const value = r2Offer();
    const serialized = serializeFileMediaSourceOfferV2(value);

    expect(value).toEqual({
      protocolVersion: 2,
      type: 'FILE_MEDIA_SOURCE_OFFER_V2',
      transport: 'r2-whole-blob',
      encryption: 'aes-256-gcm-whole-v1',
      ...r2Input(),
    });
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.isFrozen(value)).toBe(true);
    expect(serialized).not.toMatch(/downloadUrl|cleanupToken|https?:/u);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
      FILE_MEDIA_SOURCE_OFFER_V2_MAX_FRAME_BYTES,
    );
    expect(parseFileMediaSourceOfferV2(JSON.parse(serialized))).toEqual(value);
  });

  it('uses exact disjoint key sets for peer-range and R2 whole-Blob variants', () => {
    expect(
      parseFileMediaSourceOfferV2({
        ...offer(),
        storageRoomId: 'r2-room_one',
      }),
    ).toBeNull();
    expect(parseFileMediaSourceOfferV2({ ...r2Offer(), handleId: 'handle:confused' })).toBeNull();

    const missingEncryption = { ...r2Offer() } as Record<string, unknown>;
    delete missingEncryption.encryption;
    expect(parseFileMediaSourceOfferV2(missingEncryption)).toBeNull();

    const missingObject = { ...r2Offer() } as Record<string, unknown>;
    delete missingObject.objectId;
    expect(parseFileMediaSourceOfferV2(missingObject)).toBeNull();
  });

  it('requires a canonical 32-byte key and canonical 12-byte IV', () => {
    const nonCanonicalKey = `${R2_KEY_B64.slice(0, -2)}B=`;
    expect(atob(nonCanonicalKey)).toBe(atob(R2_KEY_B64));
    expect(btoa(atob(nonCanonicalKey))).toBe(R2_KEY_B64);

    expect(() => r2Offer({ keyB64: nonCanonicalKey })).toThrow();
    expect(() => r2Offer({ keyB64: btoa('\0'.repeat(31)) })).toThrow();
    expect(() => r2Offer({ keyB64: `${R2_KEY_B64.slice(0, -1)}!` })).toThrow();
    expect(() => r2Offer({ ivB64: btoa('\0'.repeat(11)) })).toThrow();
    expect(() => r2Offer({ ivB64: `${R2_IV_B64.slice(0, -1)}!` })).toThrow();
  });

  it('bounds R2 room/object identities and the exact whole-file size relation', () => {
    expect(() => r2Offer({ storageRoomId: 'room-A_123' })).not.toThrow();
    expect(() => r2Offer({ storageRoomId: '' })).toThrow();
    expect(() => r2Offer({ storageRoomId: 'r'.repeat(65) })).toThrow();
    expect(() => r2Offer({ storageRoomId: 'room/escape' })).toThrow();
    expect(() => r2Offer({ objectId: 'not-an-object-uuid' })).toThrow();
    expect(() => r2Offer({ objectId: '20000000-0000-9000-8000-000000000001' })).toThrow();
    expect(() => r2Offer({ encryptedSize: 1024 + REMOTE_SHARE_AES_GCM_TAG_BYTES - 1 })).toThrow();

    expect(() =>
      r2Offer({
        encodedSize: REMOTE_SHARE_MAX_BYTES,
        encryptedSize: REMOTE_SHARE_MAX_BYTES + REMOTE_SHARE_AES_GCM_TAG_BYTES,
      }),
    ).not.toThrow();
    expect(() =>
      r2Offer({
        encodedSize: REMOTE_SHARE_MAX_BYTES + 1,
        encryptedSize: REMOTE_SHARE_MAX_BYTES + 1 + REMOTE_SHARE_AES_GCM_TAG_BYTES,
      }),
    ).toThrow();
  });

  it('separates the canonical cap from the adapter raw pre-materialization cap', () => {
    const value = offer();
    const serialized = serializeFileMediaSourceOfferV2(value);
    const oversizedRaw = `${' '.repeat(FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES)}${serialized}`;

    expect(FILE_MEDIA_SOURCE_OFFER_V2_MAX_FRAME_BYTES).toBe(4 * 1024);
    expect(FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES).toBe(4 * 1024);
    expect(new TextEncoder().encode(oversizedRaw).byteLength).toBeGreaterThan(
      FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES,
    );
    // Once JSON.parse has materialized a value, canonical validation cannot
    // recover its raw byte size. The transport adapter must scan first.
    expect(parseFileMediaSourceOfferV2(JSON.parse(oversizedRaw))).toEqual(value);
  });

  it('creates strict UUIDv4 prepare IDs from platform CSPRNG APIs only', () => {
    const generated = createFileMediaPrepareId();
    expect(isQueueItemId(generated)).toBe(true);

    vi.stubGlobal('crypto', {
      getRandomValues<T extends ArrayBufferView>(value: T): T {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        bytes.forEach((_byte, index) => {
          bytes[index] = index;
        });
        return value;
      },
    });
    expect(createFileMediaPrepareId()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');

    vi.stubGlobal('crypto', { randomUUID: () => 'prepare:not-a-uuid' });
    expect(() => createFileMediaPrepareId()).toThrow(/invalid UUID/u);

    vi.stubGlobal('crypto', undefined);
    expect(() => createFileMediaPrepareId()).toThrow(/unavailable/u);
  });

  it('requires exact own enumerable plain data fields without invoking accessors', () => {
    const base = { ...offer() } as Record<PropertyKey, unknown>;
    let getterCalls = 0;
    Object.defineProperty(base, 'prepareId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return prepareId(99);
      },
    });
    expect(parseFileMediaSourceOfferV2(base)).toBeNull();
    expect(getterCalls).toBe(0);

    expect(parseFileMediaSourceOfferV2({ ...offer(), unexpected: true })).toBeNull();
    expect(parseFileMediaSourceOfferV2({ ...offer(), [Symbol('extra')]: true })).toBeNull();
    expect(parseFileMediaSourceOfferV2(Object.assign([], offer()))).toBeNull();
    expect(parseFileMediaSourceOfferV2(Object.assign(new Date(), offer()))).toBeNull();

    const hidden = { ...offer() };
    Object.defineProperty(hidden, 'mime', { value: 'audio/flac', enumerable: false });
    expect(parseFileMediaSourceOfferV2(hidden)).toBeNull();
  });

  it('bounds materialized bytes, numbers, MIME, UUIDs, and confused identities', () => {
    expect(() => offer({ prepareId: 'prepare:not-a-uuid' })).toThrow();
    expect(() => offer({ prepareId: '00000000-0000-1000-8000-000000000001' })).toThrow();
    expect(() => offer({ queueItemId: 'queue:not-a-uuid' })).toThrow();
    expect(() => offer({ encodedSize: 0 })).toThrow();
    expect(() => offer({ encodedSize: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => offer({ expiresAtRoomTimeMs: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => offer({ mime: 'not a mime' })).toThrow();
    expect(() => offer({ handleId: PREPARE_ONE })).toThrow();
    expect(() =>
      offer({
        connectionId: 'c'.repeat(PEER_RANGE_MAX_CONNECTION_ID_LENGTH),
        handleId: 'h'.repeat(PEER_RANGE_MAX_HANDLE_ID_LENGTH),
      }),
    ).not.toThrow();
    expect(() =>
      offer({ connectionId: 'c'.repeat(PEER_RANGE_MAX_CONNECTION_ID_LENGTH + 1) }),
    ).toThrow();
    expect(() => offer({ handleId: 'h'.repeat(PEER_RANGE_MAX_HANDLE_ID_LENGTH + 1) })).toThrow();
    expect(() =>
      offer({
        sessionId: '\uac00'.repeat(FILE_MEDIA_SOURCE_OFFER_V2_MAX_IDENTIFIER_LENGTH),
        connectionId: '\ub098'.repeat(FILE_MEDIA_SOURCE_OFFER_V2_MAX_IDENTIFIER_LENGTH),
        sourceIdentity: '\ub9c8'.repeat(FILE_MEDIA_SOURCE_OFFER_V2_MAX_IDENTIFIER_LENGTH),
        transferSessionId: '\ubc14'.repeat(FILE_MEDIA_SOURCE_OFFER_V2_MAX_IDENTIFIER_LENGTH),
        handleId: '\uc0ac'.repeat(FILE_MEDIA_SOURCE_OFFER_V2_MAX_IDENTIFIER_LENGTH),
        name: '\ud55c'.repeat(512),
      }),
    ).toThrow();
  });

  it('keeps the encoded-size policy outside the wire parser and consumes one revision', () => {
    const setup = registry({ maxEncodedSize: 1_000 });
    expect(setup.instance.admitQueueItem(TOKEN, QUEUE_ONE)).toBe(true);
    const validWire = offer({ encodedSize: 1_001 });
    expect(parseFileMediaSourceOfferV2(validWire)).toEqual(validWire);
    expect(setup.instance.accept(TOKEN, validWire)).toEqual({
      accepted: false,
      reason: 'size-policy',
    });
    expect(setup.instance.prepareRevisionWatermark()).toBe(1);
    expect(setup.instance.isClosed()).toBe(false);
  });

  it('uses the finite non-negative fractional room-clock contract for wire and registry time', () => {
    const setup = registry();
    setup.setNow(0);
    expect(setup.instance.admitQueueItem(TOKEN, QUEUE_ONE)).toBe(true);
    const fractional = offer({ expiresAtRoomTimeMs: 0.75 });

    expect(parseFileMediaSourceOfferV2(fractional)).toEqual(fractional);
    expect(setup.instance.accept(TOKEN, fractional)).toMatchObject({
      accepted: true,
      status: 'accepted',
    });
    setup.setNow(0.5);
    expect(setup.instance.activeOffer(TOKEN, QUEUE_ONE)).toEqual(fractional);
    expect(setup.instance.expire(TOKEN, 0.75)).toBe(1);
    expect(setup.instance.isClosed()).toBe(false);

    expect(() => offer({ expiresAtRoomTimeMs: 0 })).not.toThrow();
    expect(() => offer({ expiresAtRoomTimeMs: MAX_FILE_PLAYBACK_ROOM_TIME_MS + 1 })).toThrow();
  });
});

describe('FileMediaOfferRegistry', () => {
  it('accepts and replays the R2 variant under the unchanged common authority', () => {
    const setup = registry();
    setup.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    const first = r2Offer();

    expect(setup.instance.accept(TOKEN, first)).toMatchObject({
      accepted: true,
      status: 'accepted',
      offer: first,
    });
    expect(setup.instance.accept(TOKEN, { ...first })).toMatchObject({
      accepted: true,
      status: 'replayed',
      offer: first,
    });
    expect(
      setup.instance.accept(TOKEN, {
        ...first,
        objectId: '20000000-0000-4000-8000-000000000002',
      }),
    ).toEqual({ accepted: false, reason: 'conflict' });
    expect(setup.instance.isClosed()).toBe(true);
  });

  it('binds inspection to the exact live token and exact session scope', () => {
    const setup = registry();
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps += 1;
          throw new Error('must not inspect stale connection data');
        },
      },
    );
    expect(setup.instance.accept({}, hostile)).toEqual({
      accepted: false,
      reason: 'wrong-connection-token',
    });
    expect(traps).toBe(0);

    setup.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    expect(setup.instance.accept(TOKEN, offer({ sessionId: 'session:other' }))).toEqual({
      accepted: false,
      reason: 'wrong-scope',
    });
    expect(setup.instance.isClosed()).toBe(true);
    expect(setup.fatal).toHaveBeenCalledOnce();
    expect(setup.fatal.mock.calls[0]?.[0]).toBe(TOKEN);
  });

  it('accepts an exact active replay and fails closed on a conflicting prepareId', () => {
    const setup = registry();
    setup.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    const first = offer();
    expect(setup.instance.accept(TOKEN, first)).toMatchObject({
      accepted: true,
      status: 'accepted',
      offer: first,
    });
    expect(setup.instance.accept(TOKEN, { ...first })).toMatchObject({
      accepted: true,
      status: 'replayed',
      offer: first,
    });
    expect(setup.instance.activeOfferCount()).toBe(1);

    expect(setup.instance.accept(TOKEN, { ...first, encodedSize: first.encodedSize + 1 })).toEqual({
      accepted: false,
      reason: 'conflict',
    });
    expect(setup.instance.isClosed()).toBe(true);
    expect(setup.instance.activeOfferCount()).toBe(0);
    expect(setup.fatal).toHaveBeenCalledOnce();
  });

  it('requires exact revision progression and consumes exact-next semantic rejections', () => {
    const setup = registry({ maxEncodedSize: 1_000 });

    expect(setup.instance.accept(TOKEN, offer())).toEqual({
      accepted: false,
      reason: 'queue-item-not-live',
    });
    expect(setup.instance.prepareRevisionWatermark()).toBe(1);

    expect(setup.instance.admitQueueItem(TOKEN, QUEUE_ONE)).toBe(true);
    expect(setup.instance.accept(TOKEN, offer())).toEqual({
      accepted: false,
      reason: 'stale-offer',
    });
    expect(
      setup.instance.accept(
        TOKEN,
        offer({
          prepareId: prepareId(2),
          prepareRevision: 2,
          transferSessionId: 'transfer:expired',
          handleId: 'handle:expired',
          expiresAtRoomTimeMs: 999,
        }),
      ),
    ).toEqual({ accepted: false, reason: 'expired' });
    expect(
      setup.instance.accept(
        TOKEN,
        offer({
          prepareId: prepareId(3),
          prepareRevision: 3,
          transferSessionId: 'transfer:large',
          handleId: 'handle:large',
          encodedSize: 1_001,
        }),
      ),
    ).toEqual({ accepted: false, reason: 'size-policy' });
    const fourth = offer({
      prepareId: prepareId(4),
      prepareRevision: 4,
      transferSessionId: 'transfer:four',
      handleId: 'handle:four',
      encodedSize: 1_000,
    });
    expect(setup.instance.accept(TOKEN, fourth)).toMatchObject({
      accepted: true,
      status: 'accepted',
    });
    expect(setup.instance.prepareRevisionWatermark()).toBe(4);
    expect(setup.instance.isClosed()).toBe(false);
  });

  it('fails closed on a revision gap without adopting the untrusted watermark', () => {
    const setup = registry();
    setup.instance.admitQueueItem(TOKEN, QUEUE_ONE);

    expect(
      setup.instance.accept(
        TOKEN,
        offer({
          prepareId: prepareId(2),
          prepareRevision: 2,
          transferSessionId: 'transfer:gap',
          handleId: 'handle:gap',
        }),
      ),
    ).toEqual({ accepted: false, reason: 'conflict' });
    expect(setup.instance.prepareRevisionWatermark()).toBe(0);
    expect(setup.instance.isClosed()).toBe(true);
    expect(setup.fatal).toHaveBeenCalledOnce();
  });

  it('fails closed on a queue-not-live MAX revision as exhaustion, without poisoning state', () => {
    const setup = registry();

    expect(
      setup.instance.accept(
        TOKEN,
        offer({
          prepareId: prepareId(99),
          prepareRevision: Number.MAX_SAFE_INTEGER,
          transferSessionId: 'transfer:max',
          handleId: 'handle:max',
        }),
      ),
    ).toEqual({ accepted: false, reason: 'conflict' });
    expect(setup.instance.prepareRevisionWatermark()).toBe(0);
    expect(setup.instance.isClosed()).toBe(true);
    expect(setup.fatal).toHaveBeenCalledOnce();
  });

  it('supersedes monotonically and rejects delayed ABA with compact prepare-ID tombstones', () => {
    const setup = registry();
    setup.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    const first = offer();
    const second = offer({
      prepareId: prepareId(2),
      prepareRevision: 2,
      transferSessionId: 'transfer:two',
      handleId: 'handle:two',
    });
    expect(setup.instance.accept(TOKEN, first)).toMatchObject({ status: 'accepted' });
    expect(setup.instance.accept(TOKEN, second)).toMatchObject({ status: 'superseded' });
    expect(setup.instance.activeOffer(TOKEN, QUEUE_ONE)).toEqual(second);
    expect(setup.instance.accept(TOKEN, first)).toEqual({
      accepted: false,
      reason: 'stale-offer',
    });
    expect(setup.instance.prepareRevisionWatermark()).toBe(2);
    expect(setup.instance.isClosed()).toBe(false);
  });

  it('fails closed when an exact-next offer reuses a prepareId retired by lifecycle changes', () => {
    const superseded = registry();
    superseded.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    expect(superseded.instance.accept(TOKEN, offer())).toMatchObject({ accepted: true });
    expect(
      superseded.instance.accept(
        TOKEN,
        offer({
          prepareId: prepareId(2),
          prepareRevision: 2,
          transferSessionId: 'transfer:superseding',
          handleId: 'handle:superseding',
        }),
      ),
    ).toMatchObject({ status: 'superseded' });
    expect(
      superseded.instance.accept(
        TOKEN,
        offer({
          prepareId: PREPARE_ONE,
          prepareRevision: 3,
          transferSessionId: 'transfer:reused-after-supersede',
          handleId: 'handle:reused-after-supersede',
        }),
      ),
    ).toEqual({ accepted: false, reason: 'conflict' });
    expect(superseded.instance.isClosed()).toBe(true);

    const expired = registry();
    expired.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    expect(expired.instance.accept(TOKEN, offer({ expiresAtRoomTimeMs: 1_100 }))).toMatchObject({
      accepted: true,
    });
    expired.setNow(1_101);
    expect(expired.instance.expire(TOKEN)).toBe(1);
    expect(
      expired.instance.accept(
        TOKEN,
        offer({
          prepareId: PREPARE_ONE,
          prepareRevision: 2,
          transferSessionId: 'transfer:reused-after-expiry',
          handleId: 'handle:reused-after-expiry',
        }),
      ),
    ).toEqual({ accepted: false, reason: 'conflict' });
    expect(expired.instance.isClosed()).toBe(true);

    const removed = registry();
    removed.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    removed.instance.admitQueueItem(TOKEN, QUEUE_TWO);
    expect(removed.instance.accept(TOKEN, offer())).toMatchObject({ accepted: true });
    expect(removed.instance.removeQueueItem(TOKEN, QUEUE_ONE)).toBe(true);
    expect(
      removed.instance.accept(
        TOKEN,
        offer({
          queueItemId: QUEUE_TWO,
          prepareId: PREPARE_ONE,
          prepareRevision: 2,
          sourceIdentity: 'source:two',
          transferSessionId: 'transfer:reused-after-removal',
          handleId: 'handle:reused-after-removal',
        }),
      ),
    ).toEqual({ accepted: false, reason: 'conflict' });
    expect(removed.instance.isClosed()).toBe(true);
  });

  it('retires prepareIds consumed by nonfatal policy rejection', () => {
    const setup = registry({ maxEncodedSize: 1_000 });
    setup.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    expect(setup.instance.accept(TOKEN, offer({ encodedSize: 1_001 }))).toEqual({
      accepted: false,
      reason: 'size-policy',
    });
    expect(setup.instance.retiredTombstoneCount()).toBe(1);
    expect(
      setup.instance.accept(
        TOKEN,
        offer({
          prepareRevision: 2,
          encodedSize: 1_000,
          transferSessionId: 'transfer:reused-policy-id',
          handleId: 'handle:reused-policy-id',
        }),
      ),
    ).toEqual({ accepted: false, reason: 'conflict' });
    expect(setup.instance.isClosed()).toBe(true);
  });

  it('makes removal irreversible while allowing a live occurrence to prepare after expiry', () => {
    const setup = registry();
    setup.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    const first = offer({ expiresAtRoomTimeMs: 1_100 });
    expect(setup.instance.accept(TOKEN, first)).toMatchObject({ accepted: true });
    expect(setup.instance.removeQueueItem(TOKEN, QUEUE_ONE)).toBe(true);
    expect(setup.instance.activeOfferCount()).toBe(0);

    expect(
      setup.instance.accept(
        TOKEN,
        offer({
          prepareId: prepareId(2),
          prepareRevision: 2,
          transferSessionId: 'transfer:removed',
          handleId: 'handle:removed',
        }),
      ),
    ).toEqual({ accepted: false, reason: 'queue-item-not-live' });
    expect(setup.instance.prepareRevisionWatermark()).toBe(2);
    expect(setup.instance.admitQueueItem(TOKEN, QUEUE_ONE)).toBe(false);
    expect(setup.instance.isClosed()).toBe(true);

    const expiry = registry();
    expiry.instance.admitQueueItem(TOKEN, QUEUE_TWO);
    const expiring = offer({
      queueItemId: QUEUE_TWO,
      expiresAtRoomTimeMs: 1_100,
    });
    expect(expiry.instance.accept(TOKEN, expiring)).toMatchObject({ accepted: true });
    expiry.setNow(1_101);
    expect(expiry.instance.expire(TOKEN)).toBe(1);
    const replacement = offer({
      queueItemId: QUEUE_TWO,
      prepareId: prepareId(2),
      prepareRevision: 2,
      transferSessionId: 'transfer:replacement',
      handleId: 'handle:replacement',
      expiresAtRoomTimeMs: 2_000,
    });
    expect(expiry.instance.accept(TOKEN, replacement)).toMatchObject({ accepted: true });
  });

  it('supports 2,000 unique UUID removals below the high cumulative tombstone cap', () => {
    const setup = registry({ maxLiveQueueItems: 1, maxActiveOffers: 1 });
    for (let revision = 1; revision <= 2_000; revision += 1) {
      const occurrenceId = queueId(revision);
      expect(setup.instance.admitQueueItem(TOKEN, occurrenceId)).toBe(true);
      expect(
        setup.instance.accept(
          TOKEN,
          offer({
            queueItemId: occurrenceId,
            prepareId: prepareId(revision),
            prepareRevision: revision,
            sourceIdentity: `source:${revision}`,
            transferSessionId: `transfer:${revision}`,
            handleId: `handle:${revision}`,
            expiresAtRoomTimeMs: 10_000,
          }),
        ),
      ).toMatchObject({ accepted: true });
      expect(setup.instance.removeQueueItem(TOKEN, occurrenceId)).toBe(true);
    }
    expect(setup.instance.liveQueueItemCount()).toBe(0);
    expect(setup.instance.activeOfferCount()).toBe(0);
    expect(setup.instance.prepareRevisionWatermark()).toBe(2_000);
    expect(setup.instance.retiredTombstoneCount()).toBe(4_000);
    expect(setup.instance.isClosed()).toBe(false);
    expect(setup.fatal).not.toHaveBeenCalled();

    expect(setup.instance.admitQueueItem(TOKEN, queueId(1))).toBe(false);
    expect(setup.instance.isClosed()).toBe(true);
    expect(setup.fatal).toHaveBeenCalledOnce();
  });

  it('fails closed without eviction at the configurable cumulative tombstone cap', () => {
    expect(() => registry({ maxRetiredTombstones: 0 })).toThrow(RangeError);
    expect(() => registry({ maxRetiredTombstones: Number.MAX_SAFE_INTEGER })).toThrow(RangeError);

    const setup = registry({ maxRetiredTombstones: 3 });
    setup.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    expect(setup.instance.accept(TOKEN, offer())).toMatchObject({ accepted: true });
    expect(setup.instance.removeQueueItem(TOKEN, QUEUE_ONE)).toBe(true);
    expect(setup.instance.retiredTombstoneCount()).toBe(2);

    setup.instance.admitQueueItem(TOKEN, QUEUE_TWO);
    expect(
      setup.instance.accept(
        TOKEN,
        offer({
          queueItemId: QUEUE_TWO,
          prepareId: prepareId(2),
          prepareRevision: 2,
          sourceIdentity: 'source:two',
          transferSessionId: 'transfer:two',
          handleId: 'handle:two',
        }),
      ),
    ).toMatchObject({ accepted: true });
    expect(setup.instance.removeQueueItem(TOKEN, QUEUE_TWO)).toBe(false);
    expect(setup.instance.isClosed()).toBe(true);
    expect(setup.fatal).toHaveBeenCalledOnce();
  });

  it('treats unknown queue removal as conflict without allocating a tombstone', () => {
    const unknown = registry();
    expect(unknown.instance.removeQueueItem(TOKEN, QUEUE_ONE)).toBe(false);
    expect(unknown.instance.retiredTombstoneCount()).toBe(0);
    expect(unknown.instance.isClosed()).toBe(true);
    expect(unknown.fatal).toHaveBeenCalledOnce();

    const repeated = registry();
    repeated.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    expect(repeated.instance.removeQueueItem(TOKEN, QUEUE_ONE)).toBe(true);
    expect(repeated.instance.retiredTombstoneCount()).toBe(1);
    expect(repeated.instance.removeQueueItem(TOKEN, QUEUE_ONE)).toBe(true);
    expect(repeated.instance.retiredTombstoneCount()).toBe(1);
    expect(repeated.instance.isClosed()).toBe(false);
  });

  it('fails closed only on concurrent live/active capacity exhaustion', () => {
    const live = registry({ maxLiveQueueItems: 1 });
    expect(live.instance.admitQueueItem(TOKEN, QUEUE_ONE)).toBe(true);
    expect(live.instance.admitQueueItem(TOKEN, QUEUE_TWO)).toBe(false);
    expect(live.instance.isClosed()).toBe(true);

    const active = registry({ maxActiveOffers: 1 });
    active.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    active.instance.admitQueueItem(TOKEN, QUEUE_TWO);
    expect(active.instance.accept(TOKEN, offer())).toMatchObject({ accepted: true });
    expect(
      active.instance.accept(
        TOKEN,
        offer({
          queueItemId: QUEUE_TWO,
          prepareId: prepareId(2),
          prepareRevision: 2,
          sourceIdentity: 'source:two',
          transferSessionId: 'transfer:two',
          handleId: 'handle:two',
        }),
      ),
    ).toEqual({ accepted: false, reason: 'capacity' });
    expect(active.instance.isClosed()).toBe(true);
  });

  it('issues frozen unforgeable current-offer leases and revokes them on supersession/removal', () => {
    const setup = registry();
    setup.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    const first = offer();
    const firstAcceptance = setup.instance.accept(TOKEN, first);
    expect(firstAcceptance).toMatchObject({ accepted: true });
    if (!firstAcceptance.accepted) throw new Error('Expected first offer acceptance');
    const storedFirst = firstAcceptance.offer;
    const firstLease = setup.instance.issueCurrentOfferLease(TOKEN, QUEUE_ONE);
    expect(firstLease).not.toBeNull();
    expect(Object.isFrozen(firstLease)).toBe(true);
    expect(Object.getPrototypeOf(firstLease)).toBeNull();
    expect(Reflect.ownKeys(firstLease as object)).toEqual([]);
    expect(setup.instance.isCurrentOfferLease(TOKEN, firstLease)).toBe(true);
    expect(setup.instance.resolveCurrentOfferLease(TOKEN, firstLease)).toBe(storedFirst);
    expect(setup.instance.isCurrentOfferLease({}, firstLease)).toBe(false);
    const forged = Object.freeze(Object.create(null));
    expect(setup.instance.isCurrentOfferLease(TOKEN, forged)).toBe(false);
    expect(setup.instance.resolveCurrentOfferLease(TOKEN, forged)).toBeNull();

    let traps = 0;
    const hostileClone = new Proxy(firstLease as object, {
      get() {
        traps += 1;
        throw new Error('lease validation must not read properties');
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error('lease validation must not inspect prototypes');
      },
      ownKeys() {
        traps += 1;
        throw new Error('lease validation must not enumerate');
      },
    });
    expect(setup.instance.resolveCurrentOfferLease(TOKEN, hostileClone)).toBeNull();
    expect(setup.instance.isCurrentOfferLease(TOKEN, hostileClone)).toBe(false);
    expect(traps).toBe(0);

    expect(setup.instance.accept(TOKEN, { ...first })).toMatchObject({ status: 'replayed' });
    expect(setup.instance.isCurrentOfferLease(TOKEN, firstLease)).toBe(true);
    expect(setup.instance.resolveCurrentOfferLease(TOKEN, firstLease)).toBe(storedFirst);
    const second = offer({
      prepareId: prepareId(2),
      prepareRevision: 2,
      transferSessionId: 'transfer:lease-two',
      handleId: 'handle:lease-two',
    });
    const secondAcceptance = setup.instance.accept(TOKEN, second);
    expect(secondAcceptance).toMatchObject({ status: 'superseded' });
    if (!secondAcceptance.accepted) throw new Error('Expected second offer acceptance');
    const storedSecond = secondAcceptance.offer;
    expect(parseFileMediaSourceOfferV2(first)).toEqual(first);
    expect(setup.instance.isCurrentOfferLease(TOKEN, firstLease)).toBe(false);
    expect(setup.instance.resolveCurrentOfferLease(TOKEN, firstLease)).toBeNull();

    const secondLease = setup.instance.issueCurrentOfferLease(TOKEN, QUEUE_ONE);
    expect(setup.instance.isCurrentOfferLease(TOKEN, secondLease)).toBe(true);
    expect(setup.instance.resolveCurrentOfferLease(TOKEN, secondLease)).toBe(storedSecond);
    expect(setup.instance.removeQueueItem(TOKEN, QUEUE_ONE)).toBe(true);
    expect(setup.instance.isCurrentOfferLease(TOKEN, secondLease)).toBe(false);
    expect(setup.instance.resolveCurrentOfferLease(TOKEN, secondLease)).toBeNull();
  });

  it('rechecks clock/expiry for leases and invalidates every lease on close', () => {
    const expiring = registry();
    expiring.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    expect(expiring.instance.accept(TOKEN, offer({ expiresAtRoomTimeMs: 1_100.5 }))).toMatchObject({
      accepted: true,
    });
    const lease = expiring.instance.issueCurrentOfferLease(TOKEN, QUEUE_ONE);
    expect(expiring.instance.isCurrentOfferLease(TOKEN, lease)).toBe(true);
    expiring.setNow(1_100.5);
    expect(expiring.instance.resolveCurrentOfferLease(TOKEN, lease)).toBeNull();
    expect(expiring.instance.isCurrentOfferLease(TOKEN, lease)).toBe(false);
    expect(expiring.instance.activeOfferCount()).toBe(0);

    const closed = registry();
    closed.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    expect(closed.instance.accept(TOKEN, offer())).toMatchObject({ accepted: true });
    const closedLease = closed.instance.issueCurrentOfferLease(TOKEN, QUEUE_ONE);
    closed.instance.close();
    expect(closed.instance.isCurrentOfferLease(TOKEN, closedLease)).toBe(false);
    expect(closed.instance.resolveCurrentOfferLease(TOKEN, closedLease)).toBeNull();
  });

  it('cannot issue a lease through parser Proxy re-entry', () => {
    const setup = registry();
    setup.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    expect(setup.instance.accept(TOKEN, offer())).toMatchObject({ accepted: true });
    const currentLease = setup.instance.issueCurrentOfferLease(TOKEN, QUEUE_ONE);
    let injectedLease: unknown = 'not-called';
    let injectedOffer: unknown = 'not-called';
    let reentered = false;
    const candidate = {
      ...offer({
        prepareId: prepareId(2),
        prepareRevision: 2,
        transferSessionId: 'transfer:proxy-lease',
        handleId: 'handle:proxy-lease',
      }),
    };
    const hostile = new Proxy(candidate, {
      ownKeys(target) {
        if (!reentered) {
          reentered = true;
          injectedOffer = setup.instance.resolveCurrentOfferLease(TOKEN, currentLease);
          injectedLease = setup.instance.issueCurrentOfferLease(TOKEN, QUEUE_ONE);
        }
        return Reflect.ownKeys(target);
      },
    });

    expect(setup.instance.accept(TOKEN, hostile)).toEqual({
      accepted: false,
      reason: 'closed',
    });
    expect(injectedOffer).toBeNull();
    expect(injectedLease).toBeNull();
    expect(setup.instance.isCurrentOfferLease(TOKEN, currentLease)).toBe(false);
    expect(setup.instance.isClosed()).toBe(true);
    expect(setup.fatal).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'throw',
      () => {
        throw new Error('clock failed');
      },
    ],
    ['NaN', () => Number.NaN],
    ['out-of-range', () => MAX_FILE_PLAYBACK_ROOM_TIME_MS + 1],
  ])('fails closed when the room clock returns %s', (_label, nowRoomTimeMs) => {
    const setup = registry({ nowRoomTimeMs });
    setup.instance.admitQueueItem(TOKEN, QUEUE_ONE);

    expect(setup.instance.accept(TOKEN, offer())).toEqual({
      accepted: false,
      reason: 'closed',
    });
    expect(setup.instance.isClosed()).toBe(true);
    expect(setup.fatal).toHaveBeenCalledOnce();
  });

  it.each(['accept', 'remove', 'close'] as const)(
    'fails closed when the room clock re-enters %s',
    (action) => {
      let instance!: FileMediaOfferRegistry;
      let invoked = false;
      let reentryResult: unknown = null;
      const fatal = vi.fn();
      instance = new FileMediaOfferRegistry({
        liveConnectionToken: TOKEN,
        sessionId: SESSION_ID,
        connectionId: CONNECTION_ID,
        maxEncodedSize: 10_000,
        nowRoomTimeMs: () => {
          if (!invoked) {
            invoked = true;
            if (action === 'accept') reentryResult = instance.accept(TOKEN, offer());
            else if (action === 'remove') {
              reentryResult = instance.removeQueueItem(TOKEN, QUEUE_ONE);
            } else {
              instance.close();
              reentryResult = 'closed';
            }
          }
          return 1_000;
        },
        onFatalConnection: fatal,
      });
      instance.admitQueueItem(TOKEN, QUEUE_ONE);

      expect(instance.accept(TOKEN, offer())).toEqual({
        accepted: false,
        reason: 'closed',
      });
      expect(reentryResult).not.toBeNull();
      expect(instance.isClosed()).toBe(true);
      expect(fatal).toHaveBeenCalledOnce();
    },
  );

  it('contains throwing and re-entrant onFatal callbacks after one quarantine', () => {
    let instance!: FileMediaOfferRegistry;
    const onFatalConnection = vi.fn(() => {
      expect(instance.accept(TOKEN, offer())).toEqual({
        accepted: false,
        reason: 'closed',
      });
      expect(instance.removeQueueItem(TOKEN, QUEUE_ONE)).toBe(false);
      instance.close();
      throw new Error('observer failed');
    });
    instance = new FileMediaOfferRegistry({
      liveConnectionToken: TOKEN,
      sessionId: SESSION_ID,
      connectionId: CONNECTION_ID,
      maxEncodedSize: 10_000,
      nowRoomTimeMs: () => Number.NaN,
      onFatalConnection,
    });
    instance.admitQueueItem(TOKEN, QUEUE_ONE);

    expect(instance.accept(TOKEN, offer())).toEqual({
      accepted: false,
      reason: 'closed',
    });
    expect(instance.isClosed()).toBe(true);
    expect(onFatalConnection).toHaveBeenCalledOnce();
  });

  it('quarantines parser and clock re-entry before it can revive media authority', () => {
    const setup = registry();
    setup.instance.admitQueueItem(TOKEN, QUEUE_ONE);
    const value = { ...offer() };
    let reentered = false;
    const hostile = new Proxy(value, {
      ownKeys(target) {
        if (!reentered) {
          reentered = true;
          setup.instance.admitQueueItem(TOKEN, queueId(99));
        }
        return Reflect.ownKeys(target);
      },
    });

    expect(setup.instance.accept(TOKEN, hostile)).toEqual({
      accepted: false,
      reason: 'closed',
    });
    expect(setup.instance.activeOfferCount()).toBe(0);
    expect(setup.instance.isClosed()).toBe(true);
    expect(setup.fatal).toHaveBeenCalledOnce();
  });
});
