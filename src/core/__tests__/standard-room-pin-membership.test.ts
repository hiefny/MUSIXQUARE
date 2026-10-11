import { describe, expect, it } from 'vitest';
import {
  clientAddressPrefix,
  MAX_KEPT_PEERS,
  normalizeStandardRoomPinFailures,
  normalizeStandardRoomPinMembership,
  recordStandardRoomPinFailure,
  STANDARD_ROOM_PIN_FAILURE_LIMIT,
  STANDARD_ROOM_PIN_FAILURE_MAX_ENTRIES,
  STANDARD_ROOM_PIN_FAILURE_WINDOW_MS,
  standardRoomPinAttemptKey,
  standardRoomPinAttemptLockedFor,
  standardRoomPinMembershipDirective,
  standardRoomPinMembershipRoomSecretHash,
  validateStandardRoomPasswordSetFrame,
  type StandardRoomPinFailures,
} from '../../../cloudflare/standard-room-pin-membership.ts';
import { validateIncomingMessage } from '../../../cloudflare/signaling-protocol.ts';

const MUTATION_ID = 'test-pin-mutation-0000000000000001';
const MUTATION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const isPeerId = (value: unknown): boolean =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value);
const DIGEST = 'D'.repeat(43);
const OTHER_DIGEST = 'E'.repeat(43);

function validFrame(frame: Record<string, unknown>): boolean {
  return validateStandardRoomPasswordSetFrame(frame, isPeerId, MUTATION_ID_RE);
}

function key(index: number): string {
  return `k${String(index).padStart(42, '0')}`;
}

// The reserved shared bucket for blocks that arrive while the table is full.
const OVERFLOW_KEY = 'standard-room-pin-overflow-bucket-v1-shared';

describe('Standard-room PIN membership wire validation', () => {
  const pinFrame = { type: 'room-password-set', password: '12345678', pinMutationId: MUTATION_ID };

  it('keeps every legacy frame valid', () => {
    expect(validFrame({ type: 'room-password-set', password: '' })).toBe(true);
    expect(validFrame({ type: 'room-password-set', password: '12345678' })).toBe(true);
    expect(validFrame(pinFrame)).toBe(true);
    expect(validFrame({ ...pinFrame, password: '' })).toBe(true);
    expect(validFrame({ ...pinFrame, password: '1234567' })).toBe(false);
    expect(validFrame({ ...pinFrame, pinMutationId: 'short' })).toBe(false);
    expect(validFrame({ ...pinFrame, extra: true })).toBe(false);
    expect(validFrame({ type: 'other', password: '' })).toBe(false);
  });

  it('accepts keep_present with an empty, full or unique kept list only', () => {
    const ids = Array.from({ length: MAX_KEPT_PEERS }, (_, index) => `guest-${index}`);
    expect(validFrame({ ...pinFrame, existingParticipants: 'keep_present', keptPeerIds: [] })).toBe(
      true,
    );
    expect(
      validFrame({ ...pinFrame, existingParticipants: 'keep_present', keptPeerIds: ids }),
    ).toBe(true);
    expect(
      validFrame({
        ...pinFrame,
        existingParticipants: 'keep_present',
        keptPeerIds: [...ids, 'guest-overflow'],
      }),
    ).toBe(false);
    expect(
      validFrame({
        ...pinFrame,
        existingParticipants: 'keep_present',
        keptPeerIds: ['guest-1', 'guest-1'],
      }),
    ).toBe(false);
    expect(
      validFrame({ ...pinFrame, existingParticipants: 'keep_present', keptPeerIds: ['bad id'] }),
    ).toBe(false);
    expect(validFrame({ ...pinFrame, existingParticipants: 'keep_present' })).toBe(false);
    expect(validFrame({ ...pinFrame, keptPeerIds: [] })).toBe(false);
  });

  it('accepts revoke_all without a kept list and only with a PIN and mutation ID', () => {
    expect(validFrame({ ...pinFrame, existingParticipants: 'revoke_all' })).toBe(true);
    expect(validFrame({ ...pinFrame, existingParticipants: 'revoke_all', keptPeerIds: [] })).toBe(
      false,
    );
    expect(validFrame({ ...pinFrame, password: '', existingParticipants: 'revoke_all' })).toBe(
      false,
    );
    expect(
      validFrame({
        type: 'room-password-set',
        password: '12345678',
        existingParticipants: 'revoke_all',
      }),
    ).toBe(false);
    expect(validFrame({ ...pinFrame, existingParticipants: 'kick_some' })).toBe(false);
  });

  it('is the signaling host validator for room-password-set', () => {
    expect(
      validateIncomingMessage(
        { ...pinFrame, existingParticipants: 'keep_present', keptPeerIds: ['guest-1'] },
        'host',
      ),
    ).toBe('valid');
    expect(
      validateIncomingMessage({ ...pinFrame, existingParticipants: 'revoke_all' }, 'host'),
    ).toBe('valid');
    expect(
      validateIncomingMessage({ ...pinFrame, existingParticipants: 'keep_present' }, 'host'),
    ).toBe('ignore');
    // host-auth stays exact: a membership key there is an invalid first frame.
    expect(
      validateIncomingMessage(
        {
          type: 'host-auth',
          secret: 'secret-a',
          desiredRoomPassword: '12345678',
          pinMutationId: MUTATION_ID,
          existingParticipants: 'keep_present',
        },
        'host-pending',
      ),
    ).toBe('ignore');
  });

  it('extracts the directive of a validated frame', () => {
    expect(standardRoomPinMembershipDirective(pinFrame)).toBeNull();
    expect(
      standardRoomPinMembershipDirective({ ...pinFrame, existingParticipants: 'revoke_all' }),
    ).toEqual({ mode: 'revoke_all', keptPeerIds: [] });
    expect(
      standardRoomPinMembershipDirective({
        ...pinFrame,
        existingParticipants: 'keep_present',
        keptPeerIds: ['guest-1', 'bad id', 7],
      }),
    ).toEqual({ mode: 'keep_present', keptPeerIds: ['guest-1'] });
    expect(
      standardRoomPinMembershipDirective({ ...pinFrame, existingParticipants: 'keep_present' }),
    ).toBeNull();
  });
});

describe('Standard-room PIN durable records', () => {
  const record = {
    v: 1,
    roomSecretHash: DIGEST,
    verifierDigest: OTHER_DIGEST,
    kept: [{ peerId: 'guest-1', secretHash: DIGEST }],
  };

  it('normalizes only exact kept-set records and fails closed otherwise', () => {
    expect(normalizeStandardRoomPinMembership(record)).toEqual(record);
    expect(normalizeStandardRoomPinMembership({ ...record, kept: [] })).toEqual({
      ...record,
      kept: [],
    });
    for (const invalid of [
      undefined,
      null,
      [],
      { ...record, v: 2 },
      { ...record, extra: 1 },
      { ...record, roomSecretHash: 'short' },
      { ...record, verifierDigest: 7 },
      { ...record, kept: 'guest-1' },
      { ...record, kept: [{ peerId: 'guest-1' }] },
      { ...record, kept: [{ peerId: 'bad id', secretHash: DIGEST }] },
      { ...record, kept: [{ peerId: 'guest-1', secretHash: DIGEST, password: '12345678' }] },
      { ...record, kept: [...record.kept, ...record.kept] },
      {
        ...record,
        kept: Array.from({ length: MAX_KEPT_PEERS + 1 }, (_, index) => ({
          peerId: `guest-${index}`,
          secretHash: DIGEST,
        })),
      },
    ]) {
      expect(normalizeStandardRoomPinMembership(invalid)).toBeNull();
    }
  });

  it('normalizes corrupt wrong-PIN tables to an empty table', () => {
    const failures = { v: 1, entries: [{ key: key(1), count: 3, resetAt: 1_000 }] };
    expect(normalizeStandardRoomPinFailures(failures)).toEqual(failures);
    for (const invalid of [
      undefined,
      'x',
      { v: 2, entries: [] },
      { v: 1, entries: {} },
      { v: 1, entries: [{ key: 'short', count: 1, resetAt: 1 }] },
      { v: 1, entries: [{ key: key(1), count: 0, resetAt: 1 }] },
      { v: 1, entries: [{ key: key(1), count: 21, resetAt: 1 }] },
      { v: 1, entries: [{ key: key(1), count: 1, resetAt: 0 }] },
      { v: 1, entries: [{ key: key(1), count: 1.5, resetAt: 1 }] },
      { v: 1, entries: [{ key: key(1), count: 1, resetAt: 1, ip: '192.0.2.1' }] },
      { v: 1, entries: [failures.entries[0], failures.entries[0]] },
      {
        v: 1,
        entries: Array.from({ length: STANDARD_ROOM_PIN_FAILURE_MAX_ENTRIES + 1 }, (_, index) => ({
          key: key(index),
          count: 1,
          resetAt: 1,
        })),
      },
      {
        v: 1,
        entries: [
          ...Array.from({ length: STANDARD_ROOM_PIN_FAILURE_MAX_ENTRIES + 1 }, (_, index) => ({
            key: key(index),
            count: 1,
            resetAt: 1,
          })),
          { key: OVERFLOW_KEY, count: 1, resetAt: 1 },
        ],
      },
      {
        v: 1,
        entries: [
          { key: OVERFLOW_KEY, count: 1, resetAt: 1 },
          { key: OVERFLOW_KEY, count: 2, resetAt: 1 },
        ],
      },
    ]) {
      expect(normalizeStandardRoomPinFailures(invalid)).toEqual({ v: 1, entries: [] });
    }
    const fullWithOverflow = {
      v: 1,
      entries: [
        { key: OVERFLOW_KEY, count: 20, resetAt: 1 },
        ...Array.from({ length: STANDARD_ROOM_PIN_FAILURE_MAX_ENTRIES }, (_, index) => ({
          key: key(index),
          count: 1,
          resetAt: 1,
        })),
      ],
    };
    expect(normalizeStandardRoomPinFailures(fullWithOverflow)).toEqual(fullWithOverflow);
    expect(OVERFLOW_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('Standard-room wrong-PIN limiter', () => {
  const now = 1_000_000;
  const empty: StandardRoomPinFailures = { v: 1, entries: [] };

  function fail(record: StandardRoomPinFailures, attemptKey: string, times: number, at = now) {
    let next = record;
    for (let index = 0; index < times; index += 1) {
      next = recordStandardRoomPinFailure(next, attemptKey, at);
    }
    return next;
  }

  it('locks a key after 20 failures in a fixed window and releases it on expiry', () => {
    const almost = fail(empty, key(1), STANDARD_ROOM_PIN_FAILURE_LIMIT - 1);
    expect(standardRoomPinAttemptLockedFor(almost, key(1), now)).toBe(0);
    const locked = recordStandardRoomPinFailure(almost, key(1), now + 5_000);
    expect(locked.entries).toEqual([
      { key: key(1), count: 20, resetAt: now + STANDARD_ROOM_PIN_FAILURE_WINDOW_MS },
    ]);
    expect(standardRoomPinAttemptLockedFor(locked, key(1), now + 5_000)).toBe(
      STANDARD_ROOM_PIN_FAILURE_WINDOW_MS - 5_000,
    );
    expect(standardRoomPinAttemptLockedFor(locked, key(2), now)).toBe(0);
    expect(
      standardRoomPinAttemptLockedFor(locked, key(1), now + STANDARD_ROOM_PIN_FAILURE_WINDOW_MS),
    ).toBe(0);
    const capped = recordStandardRoomPinFailure(locked, key(1), now + 6_000);
    expect(capped.entries[0]?.count).toBe(STANDARD_ROOM_PIN_FAILURE_LIMIT);
    expect(locked.entries[0]?.count).toBe(20);
    const renewed = recordStandardRoomPinFailure(
      locked,
      key(1),
      now + STANDARD_ROOM_PIN_FAILURE_WINDOW_MS,
    );
    expect(renewed.entries).toEqual([
      { key: key(1), count: 1, resetAt: now + 2 * STANDARD_ROOM_PIN_FAILURE_WINDOW_MS },
    ]);
  });

  it('treats a reset time beyond one window as corrupt and expired', () => {
    const corrupt = { v: 1 as const, entries: [{ key: key(1), count: 20, resetAt: now * 10 }] };
    expect(standardRoomPinAttemptLockedFor(corrupt, key(1), now)).toBe(0);
    expect(recordStandardRoomPinFailure(corrupt, key(1), now).entries).toEqual([
      { key: key(1), count: 1, resetAt: now + STANDARD_ROOM_PIN_FAILURE_WINDOW_MS },
    ]);
  });

  function fillAddressBuckets(times: number, at = now): StandardRoomPinFailures {
    let full: StandardRoomPinFailures = empty;
    for (let index = 0; index < STANDARD_ROOM_PIN_FAILURE_MAX_ENTRIES; index += 1) {
      full = fail(full, key(index), times, at + index);
    }
    return full;
  }

  it('never evicts a live bucket and charges untracked keys to one shared overflow bucket', () => {
    let full = fillAddressBuckets(1);
    full = fail(full, key(0), STANDARD_ROOM_PIN_FAILURE_LIMIT - 2, now + 1_000);
    const at = now + 2_000;
    expect(standardRoomPinAttemptLockedFor(full, key(999), at)).toBe(0);

    const overflowed = recordStandardRoomPinFailure(full, key(999), at);
    expect(overflowed.entries).toHaveLength(STANDARD_ROOM_PIN_FAILURE_MAX_ENTRIES + 1);
    expect(overflowed.entries.slice(0, -1)).toEqual(full.entries);
    expect(overflowed.entries.at(-1)).toEqual({
      key: OVERFLOW_KEY,
      count: 1,
      resetAt: at + STANDARD_ROOM_PIN_FAILURE_WINDOW_MS,
    });
    expect(normalizeStandardRoomPinFailures(overflowed)).toEqual(overflowed);

    // Every untracked block shares the overflow window; tracked blocks keep theirs.
    let locked = overflowed;
    for (let index = 1; index < STANDARD_ROOM_PIN_FAILURE_LIMIT; index += 1) {
      locked = recordStandardRoomPinFailure(locked, key(1_000 + index), at);
    }
    expect(locked.entries).toHaveLength(STANDARD_ROOM_PIN_FAILURE_MAX_ENTRIES + 1);
    expect(locked.entries.at(-1)?.count).toBe(STANDARD_ROOM_PIN_FAILURE_LIMIT);
    for (const untracked of [key(999), key(5_000)]) {
      expect(standardRoomPinAttemptLockedFor(locked, untracked, at + 1_000)).toBe(
        STANDARD_ROOM_PIN_FAILURE_WINDOW_MS - 1_000,
      );
    }
    expect(standardRoomPinAttemptLockedFor(locked, key(0), at + 1_000)).toBe(0);
    const atLimit = recordStandardRoomPinFailure(locked, key(0), at + 1_000);
    expect(atLimit.entries[0]).toMatchObject({
      key: key(0),
      count: STANDARD_ROOM_PIN_FAILURE_LIMIT,
    });
    expect(standardRoomPinAttemptLockedFor(atLimit, key(0), at + 1_000)).toBeGreaterThan(0);
    expect(recordStandardRoomPinFailure(locked, key(5_000), at + 1_000)).toEqual(locked);

    // An expired address bucket frees a slot: the next new block gets its own.
    const freed = now + STANDARD_ROOM_PIN_FAILURE_WINDOW_MS;
    expect(standardRoomPinAttemptLockedFor(locked, key(5_000), freed)).toBe(0);
    const own = recordStandardRoomPinFailure(locked, key(5_000), freed);
    expect(own.entries.some((entry) => entry.key === key(0))).toBe(false);
    expect(own.entries.some((entry) => entry.key === key(1))).toBe(true);
    expect(own.entries.at(-1)).toEqual({
      key: key(5_000),
      count: 1,
      resetAt: freed + STANDARD_ROOM_PIN_FAILURE_WINDOW_MS,
    });
    expect(standardRoomPinAttemptLockedFor(own, key(999), freed)).toBe(
      at + STANDARD_ROOM_PIN_FAILURE_WINDOW_MS - freed,
    );
  });

  it('caps a round-robin across more address blocks than the table holds', () => {
    for (const blocks of [
      STANDARD_ROOM_PIN_FAILURE_MAX_ENTRIES,
      STANDARD_ROOM_PIN_FAILURE_MAX_ENTRIES + 1,
      1_000,
    ]) {
      let record = empty;
      let accepted = 0;
      let refused = 0;
      // One wrong attempt per block in turn, 1 ms apart, for one full window.
      for (let tick = 0; tick < STANDARD_ROOM_PIN_FAILURE_WINDOW_MS / 20; tick += 1) {
        const at = now + tick;
        const attemptKey = key(tick % blocks);
        if (standardRoomPinAttemptLockedFor(record, attemptKey, at) > 0) {
          refused += 1;
          continue;
        }
        accepted += 1;
        record = recordStandardRoomPinFailure(record, attemptKey, at);
      }
      expect(refused).toBeGreaterThan(0);
      expect(accepted).toBeLessThanOrEqual(
        (STANDARD_ROOM_PIN_FAILURE_MAX_ENTRIES + 1) * STANDARD_ROOM_PIN_FAILURE_LIMIT,
      );
      expect(record.entries.length).toBeLessThanOrEqual(STANDARD_ROOM_PIN_FAILURE_MAX_ENTRIES + 1);
    }
  });

  it('keeps refusing new blocks while every bucket and the overflow bucket are locked', () => {
    const full = fillAddressBuckets(STANDARD_ROOM_PIN_FAILURE_LIMIT);
    expect(standardRoomPinAttemptLockedFor(full, key(999), now + 1_000)).toBe(0);
    const overflowLocked = fail(full, key(999), STANDARD_ROOM_PIN_FAILURE_LIMIT, now + 1_000);
    expect(standardRoomPinAttemptLockedFor(overflowLocked, key(4_242), now + 2_000)).toBe(
      STANDARD_ROOM_PIN_FAILURE_WINDOW_MS - 1_000,
    );
    expect(recordStandardRoomPinFailure(overflowLocked, key(4_242), now + 2_000)).toEqual(
      overflowLocked,
    );
    expect(
      standardRoomPinAttemptLockedFor(
        overflowLocked,
        key(4_242),
        now + STANDARD_ROOM_PIN_FAILURE_WINDOW_MS,
      ),
    ).toBe(0);
  });
});

describe('Standard-room wrong-PIN address blocks', () => {
  // Shared with the PRO admission prefix vectors in pro-room-worker.test.ts.
  it.each([
    ['192.0.2.7', 'ipv4:192.0.2.7'],
    [' 192.0.2.7 ', 'ipv4:192.0.2.7'],
    ['::ffff:192.0.2.7', 'ipv4:192.0.2.7'],
    ['::ffff:c000:207', 'ipv4:192.0.2.7'],
    ['2001:db8:1:2::1', 'ipv6:2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002:ffff:ffff:ffff:fffe', 'ipv6:2001:db8:1:2::/64'],
    ['[2001:db8:1:2:0:0:0:abcd]', 'ipv6:2001:db8:1:2::/64'],
    ['2001:db8:1:2::7%eth0', 'ipv6:2001:db8:1:2::/64'],
    ['2001:db8:1:3::1', 'ipv6:2001:db8:1:3::/64'],
    ['2001:db8::1::2', 'raw:2001:db8::1::2'],
    ['1:2:3:4:5:6:7:8:9', 'raw:1:2:3:4:5:6:7:8:9'],
    ['2001:db8::1.2.3.999', 'raw:2001:db8::1.2.3.999'],
    ['gggg::1', 'raw:gggg::1'],
    ['unknown', 'raw:unknown'],
  ])('maps %s to %s', (raw, expected) => {
    expect(clientAddressPrefix(raw)).toBe(expected);
  });

  it('keeps the parity copy byte-for-byte with the PRO admission prefix', async () => {
    const { readFile } = await import('node:fs/promises');
    const pro = await readFile('cloudflare/pro-room-worker.ts', 'utf8');
    const membership = await readFile('cloudflare/standard-room-pin-membership.ts', 'utf8');
    const body = (source: string, signature: string): string => {
      const start = source.indexOf(signature);
      const open = source.indexOf('{', start);
      const end = source.indexOf('\n}\n', open);
      return start < 0 || end < 0 ? '' : source.slice(open, end);
    };
    const proBody = body(pro, 'function proRoomAdmissionAddressPrefix(rawIp: string): string');
    expect(proBody).not.toBe('');
    expect(body(membership, 'export function clientAddressPrefix(rawIp: string): string')).toBe(
      proBody,
    );
    expect(body(membership, 'function ipv4AsHextets(value: string)')).toBe(
      body(pro, 'function ipv4AsHextets(value: string)'),
    );
  });

  it('derives domain-separated attempt keys without raw addresses', async () => {
    const pepper = 'standard-room-pin-pepper-test-secret-at-least-32-bytes';
    const first = await standardRoomPinAttemptKey(pepper, '123456', '2001:db8:1:2::1');
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await standardRoomPinAttemptKey(pepper, '123456', '2001:db8:1:2:ffff::9')).toBe(first);
    expect(await standardRoomPinAttemptKey(pepper, '123456', '2001:db8:1:3::1')).not.toBe(first);
    expect(await standardRoomPinAttemptKey(pepper, '654321', '2001:db8:1:2::1')).not.toBe(first);
    expect(await standardRoomPinAttemptKey(`${pepper}-next`, '123456', '2001:db8:1:2::1')).not.toBe(
      first,
    );
    expect(await standardRoomPinAttemptKey(pepper, '123456', null)).toBe(
      await standardRoomPinAttemptKey(pepper, '123456', ''),
    );
    expect(first).not.toContain('2001');
    const secretHash = await standardRoomPinMembershipRoomSecretHash('123456', 'secret-a');
    expect(secretHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await standardRoomPinMembershipRoomSecretHash('123456', 'secret-b')).not.toBe(
      secretHash,
    );
  });
});
