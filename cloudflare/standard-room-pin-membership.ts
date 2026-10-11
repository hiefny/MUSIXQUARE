// Pure Standard-room PIN membership and wrong-PIN throttling contract.
//
// The signaling Worker owns storage, sockets and ordering. This module owns
// only the additive room-password-set wire shape, the two durable record
// shapes stored under their own keys, and the limiter arithmetic. It must not
// import the Worker or signaling-protocol.ts (which delegates here), so it
// stays a dependency leaf shared by the signaling and App Workers.
//
// Compatibility: an older Worker never reads either storage key and drops a
// room-password-set frame that carries the membership fields (exact-key
// validation), so the App sends them only on a socket whose host peer-open
// advertised STANDARD_ROOM_PIN_MEMBERSHIP_VERSION. Room meta v2 and the guest
// reconnect bindings keep their exact schemas; no contract marker changes.

export const STANDARD_ROOM_PIN_MEMBERSHIP_VERSION = 1 as const;
export const STANDARD_ROOM_PIN_MEMBERSHIP_KEY = 'standard-room-pin-membership-v1';
export const STANDARD_ROOM_PIN_FAILURES_KEY = 'standard-room-pin-failures-v1';
// Per room and per client address block: 20 wrong PINs per fixed 10-minute
// window that starts at the first failure. Only failures are counted.
export const STANDARD_ROOM_PIN_FAILURE_LIMIT = 20;
export const STANDARD_ROOM_PIN_FAILURE_WINDOW_MS = 600_000;
// Address-block buckets per room. A live bucket is never evicted. While 256
// blocks hold one, any other block is neither limited nor recorded (fail
// open, owner decision B of 2026-10-11): no attempt can lock a block but its
// own, at the cost that guessing spread past 256 blocks is not limited.
export const STANDARD_ROOM_PIN_FAILURE_MAX_ENTRIES = 256;
// One host plus 99 guests: the host can keep at most every other device.
export const MAX_KEPT_PEERS = 99;
// Internal hops (the HTTP bridge) carry no client address. They share one
// per-room bucket instead of trusting a spoofable forwarding header.
export const STANDARD_ROOM_PIN_UNATTRIBUTED_ADDRESS = 'unattributed';

const MEMBERSHIP_ROOM_SECRET_PURPOSE = 'MUSIXQUARE:standard-room-pin-membership:v1';
const ATTEMPT_KEY_PURPOSE = 'MUSIXQUARE:standard-room-pin-attempt:v1';
const DIGEST_RE = /^[A-Za-z0-9_-]{43}$/;
const PEER_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const PIN_RE = /^\d{8}$/;

export type StandardRoomPinExistingParticipants = 'keep_present' | 'revoke_all';

export interface StandardRoomPinMembershipDirective {
  readonly mode: StandardRoomPinExistingParticipants;
  readonly keptPeerIds: readonly string[];
}

export interface StandardRoomPinKeptPeer {
  peerId: string;
  /** SHA-256 of the guest reconnect secret, copied from its binding. */
  secretHash: string;
}

/**
 * Peers the host chose to keep across one PIN change. It is valid only while
 * the room epoch (roomSecretHash) and the current verifier digest both match;
 * any other state means "no exemption". It never holds PIN material.
 */
export interface StandardRoomPinMembership {
  v: 1;
  roomSecretHash: string;
  verifierDigest: string;
  kept: StandardRoomPinKeptPeer[];
}

export interface StandardRoomPinFailureEntry {
  /** Domain-separated HMAC of room and client address block, never a raw IP. */
  key: string;
  count: number;
  resetAt: number;
}

export interface StandardRoomPinFailures {
  v: 1;
  entries: StandardRoomPinFailureEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isUniquePeerIdList(value: unknown, isPeerId: (peerId: unknown) => boolean): boolean {
  if (!Array.isArray(value) || value.length > MAX_KEPT_PEERS) return false;
  const seen = new Set<string>();
  for (const peerId of value) {
    if (typeof peerId !== 'string' || !isPeerId(peerId) || seen.has(peerId)) return false;
    seen.add(peerId);
  }
  return true;
}

/**
 * Validate a host room-password-set frame. The legacy shape stays exactly
 * {type,password} plus an optional pinMutationId. The membership fields are
 * accepted only with an 8-digit PIN and a mutation ID: keep_present needs the
 * kept peer list (possibly empty), revoke_all must not carry one.
 */
export function validateStandardRoomPasswordSetFrame(
  message: Record<string, unknown>,
  isPeerId: (peerId: unknown) => boolean,
  mutationIdRe: RegExp,
): boolean {
  if (
    !hasExactKeys(
      message,
      ['type', 'password'],
      ['pinMutationId', 'existingParticipants', 'keptPeerIds'],
    ) ||
    message.type !== 'room-password-set'
  ) {
    return false;
  }
  const { password, pinMutationId } = message;
  if (password !== '' && !(typeof password === 'string' && PIN_RE.test(password))) return false;
  if (
    pinMutationId !== undefined &&
    !(typeof pinMutationId === 'string' && mutationIdRe.test(pinMutationId))
  ) {
    return false;
  }
  const hasKeptPeerIds = hasOwn(message, 'keptPeerIds');
  if (!hasOwn(message, 'existingParticipants')) return !hasKeptPeerIds;
  if (typeof password !== 'string' || !PIN_RE.test(password)) return false;
  if (typeof pinMutationId !== 'string') return false;
  if (message.existingParticipants === 'revoke_all') return !hasKeptPeerIds;
  return (
    message.existingParticipants === 'keep_present' &&
    hasKeptPeerIds &&
    isUniquePeerIdList(message.keptPeerIds, isPeerId)
  );
}

/** The membership directive of an already validated room-password-set frame. */
export function standardRoomPinMembershipDirective(
  message: Record<string, unknown>,
): StandardRoomPinMembershipDirective | null {
  if (message.existingParticipants === 'revoke_all') {
    return { mode: 'revoke_all', keptPeerIds: [] };
  }
  if (message.existingParticipants !== 'keep_present' || !Array.isArray(message.keptPeerIds)) {
    return null;
  }
  return {
    mode: 'keep_present',
    keptPeerIds: message.keptPeerIds.filter(
      (peerId): peerId is string => typeof peerId === 'string' && PEER_ID_RE.test(peerId),
    ),
  };
}

/** Invalid or foreign records normalize to null: no exemption (fail closed). */
export function normalizeStandardRoomPinMembership(
  value: unknown,
): StandardRoomPinMembership | null {
  if (
    !hasExactKeys(value, ['v', 'roomSecretHash', 'verifierDigest', 'kept']) ||
    value.v !== STANDARD_ROOM_PIN_MEMBERSHIP_VERSION ||
    typeof value.roomSecretHash !== 'string' ||
    !DIGEST_RE.test(value.roomSecretHash) ||
    typeof value.verifierDigest !== 'string' ||
    !DIGEST_RE.test(value.verifierDigest) ||
    !Array.isArray(value.kept) ||
    value.kept.length > MAX_KEPT_PEERS
  ) {
    return null;
  }
  const kept: StandardRoomPinKeptPeer[] = [];
  const seen = new Set<string>();
  for (const entry of value.kept) {
    if (
      !hasExactKeys(entry, ['peerId', 'secretHash']) ||
      typeof entry.peerId !== 'string' ||
      !PEER_ID_RE.test(entry.peerId) ||
      seen.has(entry.peerId) ||
      typeof entry.secretHash !== 'string' ||
      !DIGEST_RE.test(entry.secretHash)
    ) {
      return null;
    }
    seen.add(entry.peerId);
    kept.push({ peerId: entry.peerId, secretHash: entry.secretHash });
  }
  return {
    v: STANDARD_ROOM_PIN_MEMBERSHIP_VERSION,
    roomSecretHash: value.roomSecretHash,
    verifierDigest: value.verifierDigest,
    kept,
  };
}

function emptyFailures(): StandardRoomPinFailures {
  return { v: 1, entries: [] };
}

/**
 * Invalid records normalize to an empty table: corruption never locks a room.
 * A table holds at most 256 address-block buckets.
 */
export function normalizeStandardRoomPinFailures(value: unknown): StandardRoomPinFailures {
  if (
    !hasExactKeys(value, ['v', 'entries']) ||
    value.v !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > STANDARD_ROOM_PIN_FAILURE_MAX_ENTRIES
  ) {
    return emptyFailures();
  }
  const entries: StandardRoomPinFailureEntry[] = [];
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (
      !hasExactKeys(entry, ['key', 'count', 'resetAt']) ||
      typeof entry.key !== 'string' ||
      !DIGEST_RE.test(entry.key) ||
      seen.has(entry.key) ||
      typeof entry.count !== 'number' ||
      !Number.isSafeInteger(entry.count) ||
      entry.count < 1 ||
      entry.count > STANDARD_ROOM_PIN_FAILURE_LIMIT ||
      typeof entry.resetAt !== 'number' ||
      !Number.isSafeInteger(entry.resetAt) ||
      entry.resetAt <= 0
    ) {
      return emptyFailures();
    }
    seen.add(entry.key);
    entries.push({ key: entry.key, count: entry.count, resetAt: entry.resetAt });
  }
  return { v: 1, entries };
}

function liveFailureEntries(
  record: StandardRoomPinFailures,
  now: number,
): StandardRoomPinFailureEntry[] {
  // A reset time beyond one window cannot come from this limiter; treat it as
  // expired rather than letting a corrupt clock value lock a client forever.
  return record.entries.filter(
    (entry) => entry.resetAt > now && entry.resetAt - now <= STANDARD_ROOM_PIN_FAILURE_WINDOW_MS,
  );
}

/**
 * Milliseconds until this attempt key may try again, or 0 when it may try
 * now. Only the key's own live bucket can lock it. A key without one, even
 * while every slot holds another block's live bucket, is never locked: there
 * is no shared bucket, so no attempt from other blocks can keep a newcomer out.
 */
export function standardRoomPinAttemptLockedFor(
  record: StandardRoomPinFailures,
  key: string,
  now: number,
): number {
  const entry = liveFailureEntries(record, now).find((candidate) => candidate.key === key);
  return entry && entry.count >= STANDARD_ROOM_PIN_FAILURE_LIMIT ? entry.resetAt - now : 0;
}

/**
 * Count one wrong PIN against the key's own live bucket, or a new one while
 * fewer than 256 address blocks hold a live bucket; expired buckets are pruned
 * first, so their slots are reused. Live buckets are never evicted. When every
 * slot holds another block's live bucket, the key is not tracked (fail open):
 * nothing is recorded and the input record itself is returned, so the caller
 * can skip the write. Otherwise the result is a new record; the input is
 * never mutated.
 */
export function recordStandardRoomPinFailure(
  record: StandardRoomPinFailures,
  key: string,
  now: number,
): StandardRoomPinFailures {
  const live = liveFailureEntries(record, now);
  const tracked = live.some((entry) => entry.key === key);
  if (!tracked && live.length >= STANDARD_ROOM_PIN_FAILURE_MAX_ENTRIES) {
    return live.length === record.entries.length
      ? record
      : { v: 1, entries: live.map((entry) => ({ ...entry })) };
  }
  const entries = live.map((entry) => ({ ...entry }));
  const existing = entries.find((entry) => entry.key === key);
  if (existing) {
    existing.count = Math.min(STANDARD_ROOM_PIN_FAILURE_LIMIT, existing.count + 1);
  } else {
    entries.push({ key, count: 1, resetAt: now + STANDARD_ROOM_PIN_FAILURE_WINDOW_MS });
  }
  return { v: 1, entries };
}

const IPV4_ADDRESS_RE =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_HEXTET_RE = /^[0-9a-f]{1,4}$/;

function ipv4AsHextets(value: string): string[] | null {
  if (!IPV4_ADDRESS_RE.test(value)) return null;
  const [a = 0, b = 0, c = 0, d = 0] = value.split('.').map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}

/**
 * The address block one client controls: one IPv4 address, or one IPv6 /64.
 * An IPv4-mapped IPv6 address is its IPv4 address; an unparseable value keeps
 * its own exact bucket. Kept in parity with the PRO admission prefix
 * (cloudflare/pro-room-worker.ts proRoomAdmissionAddressPrefix).
 */
export function clientAddressPrefix(rawIp: string): string {
  const raw = `raw:${rawIp}`;
  const value = rawIp.trim().toLowerCase();
  if (IPV4_ADDRESS_RE.test(value)) return `ipv4:${value}`;
  const address = value.replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '');
  if (!address.includes(':')) return raw;
  const halves = address.split('::');
  if (halves.length > 2) return raw;
  const groups = (part: string | undefined) => (part ? part.split(':') : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const last = halves.length === 2 ? tail : head;
  const embedded = last[last.length - 1];
  if (embedded?.includes('.')) {
    const hextets = ipv4AsHextets(embedded);
    if (!hextets) return raw;
    last.splice(last.length - 1, 1, ...hextets);
  }
  const elided = 8 - head.length - tail.length;
  if (halves.length === 2 ? elided < 1 : elided !== 0) return raw;
  const hextets = [...head, ...Array<string>(Math.max(0, elided)).fill('0'), ...tail];
  if (hextets.length !== 8 || !hextets.every((hextet) => IPV6_HEXTET_RE.test(hextet))) {
    return raw;
  }
  const numbers = hextets.map((hextet) => Number.parseInt(hextet, 16));
  if (numbers.slice(0, 5).every((number) => number === 0) && numbers[5] === 0xffff) {
    const high = numbers[6] ?? 0;
    const low = numbers[7] ?? 0;
    return `ipv4:${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `ipv6:${numbers
    .slice(0, 4)
    .map((number) => number.toString(16))
    .join(':')}::/64`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Binds a membership record to one room epoch without storing the secret. */
export async function standardRoomPinMembershipRoomSecretHash(
  roomId: string,
  roomSecret: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${MEMBERSHIP_ROOM_SECRET_PURPOSE}|${roomId}|${roomSecret}`),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

/**
 * Wrong-PIN bucket key: HMAC-SHA-256 under the current PIN pepper over the
 * room and client address block, domain-separated from the verifier. Rotating
 * the pepper therefore also resets every window. Raw addresses never persist.
 */
export async function standardRoomPinAttemptKey(
  pepper: string,
  roomId: string,
  rawClientIp: string | null,
): Promise<string> {
  const address = rawClientIp
    ? clientAddressPrefix(rawClientIp)
    : STANDARD_ROOM_PIN_UNATTRIBUTED_ADDRESS;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${ATTEMPT_KEY_PURPOSE}|${roomId}|${address}`),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}
