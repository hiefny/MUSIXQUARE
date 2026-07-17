import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPlaybackCheckpoint,
  type ProRoomPlaylistWireItem,
  type ProRoomQuotaSnapshot,
  type ProRoomR2Source,
  type ProRoomSnapshot,
  type ProRoomSystemAudioPublication,
  type ProRoomSystemAudioState,
} from './contracts.ts';
import {
  isProRoomPin,
  parseProRoomClaimToken,
  parseProRoomOwnerRecoveryClaimToken,
  parseProRoomSignalingTicket,
  type ProRoomSignalingTicket,
} from './credentials.ts';
import { isProRoomCode } from './room-code.ts';
import {
  isProRoomQueueItemId,
  parseProRoomSnapshot,
  parseProRoomSystemAudioPublication,
  parseProRoomSystemAudioState,
} from './snapshot.ts';
import type { DeveloperCommandResultCode } from '../network/transport/types.ts';

const PRO_ROOM_PRODUCTION_ENDPOINT = 'https://pro.musixquare.com';
export const PRO_ROOM_R2_HOST = '01353882e4eea3a5acaa0c45e8336af4.r2.cloudflarestorage.com';

const MAX_REQUEST_JSON_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_JSON_BYTES = 16 * 1024;
const MAX_BOOTSTRAP_JSON_BYTES = 8 * 1024;
const MAX_NAME_LENGTH = 2048;
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_URL_LENGTH = 8192;
const MAX_UPLOAD_HEADERS = 16;
const MAX_UPLOAD_HEADER_VALUE_LENGTH = 2048;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const DEVELOPER_COMMAND_ID_RE = /^cmd_[A-Za-z0-9_-]{22}$/;
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const SHA256_RE = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
const SYSTEM_AUDIO_LEASE_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_UPLOAD_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'origin',
  'referer',
  'content-length',
]);
const DEVELOPER_COMMAND_RESULT_CODES = new Set<DeveloperCommandResultCode>([
  'applied',
  'already_applied',
  'busy',
  'no_media',
  'stale_queue',
  'unsupported_mode',
  'expired',
  'execution_failed',
]);

type ProRoomBootstrapStatus = 'activation_required' | 'pin_required' | 'suspended';

export interface ProRoomBootstrap {
  roomCode: string;
  status: ProRoomBootstrapStatus;
}

export interface ProRoomMediaReservation {
  assetId: string;
  version: number;
  byteLength: number;
  expiresAtMs: number;
  upload: {
    method: 'PUT';
    url: string;
    headers: Record<string, string>;
  };
  quota: ProRoomQuotaSnapshot;
}

export interface ProRoomMediaDownload {
  asset: ProRoomR2Source;
  url: string;
  expiresAtMs: number;
}

export interface ProRoomSignalingAccess {
  ticket: ProRoomSignalingTicket;
  expiresAtMs: number;
  role: 'coordinator' | 'member';
  coordinatorEpoch: number;
  presenceIncarnationId: string;
  ticketSequence: number;
}

export interface ProRoomPresenceIdentity {
  participantId: string;
  presenceIncarnationId: string;
}

export interface ProRoomSystemAudioLeaseGrant {
  systemAudio: ProRoomSystemAudioState;
  /** Private 32-byte capability. Never publish this through room state or peer messages. */
  leaseId: string;
}

export interface CommitProRoomSystemAudioInput {
  code: string;
  generation: number;
  leaseId: string;
  publication: ProRoomSystemAudioPublication;
}

export interface UpdateProRoomSystemAudioLeaseInput {
  code: string;
  generation: number;
  leaseId: string;
}

export interface EnterProRoomPresenceOptions {
  signal?: AbortSignal;
  takeover?: boolean;
}

export interface ActivateProRoomInput {
  code: string;
  claimToken: string;
  temporaryPin: string;
  newPin: string;
  ownerName?: string;
}

export interface CreateProRoomSessionInput {
  code: string;
  pin: string;
  displayName: string;
}

export interface RecoverProRoomOwnerInput {
  code: string;
  claimToken: string;
  displayName: string;
}

export interface CloseProRoomSessionFencedInput {
  code: string;
  expectedParticipantId: string;
  expectedPresenceIncarnationId: string;
}

export interface UpdateProRoomSnapshotInput {
  code: string;
  baseRevision: number;
  playlist: ProRoomPlaylistWireItem[];
  currentQueueItemId: string | null;
  playback: ProRoomPlaybackCheckpoint;
  idempotencyKey: string;
}

interface AckProRoomDeveloperCommandInput {
  code: string;
  commandId: string;
  resultCode: DeveloperCommandResultCode;
}

/**
 * Small unload-safe mutation used only after a confirmed pagehide. A member
 * sends a null checkpoint; the elected coordinator may atomically persist its
 * final observation while releasing presence.
 */
interface CloseProRoomPresenceInput {
  code: string;
  expectedParticipantId: string;
  expectedPresenceIncarnationId: string;
  baseRevision: number;
  currentQueueItemId: string | null;
  playback: ProRoomPlaybackCheckpoint | null;
  idempotencyKey: string;
}

export interface CreateProRoomMediaReservationInput {
  code: string;
  byteLength: number;
  name: string;
  mime: string;
  sha256?: string;
  idempotencyKey: string;
}

export interface CompleteProRoomMediaInput {
  code: string;
  assetId: string;
  idempotencyKey: string;
}

export type DeleteProRoomMediaInput = CompleteProRoomMediaInput;

export class ProRoomApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(code: string, status = 0, retryAfterSeconds: number | null = null) {
    super(`PRO_ROOM_API_${code}`);
    this.name = 'ProRoomApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class BodyLimitError extends Error {}

type JsonRecord = Record<string, unknown>;
type JsonParser<T> = (value: unknown) => T | null;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  record: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(record, key)) &&
    Object.keys(record).every((key) => allowed.has(key))
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function parseEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const isMusixquare = url.protocol === 'https:' && url.hostname.endsWith('.musixquare.com');
  const isLocal =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (!isMusixquare && !isLocal) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

function readEndpointOverride(): unknown {
  return import.meta.env?.VITE_PRO_ROOM_ENDPOINT;
}

/** Resolve a build-time override without permitting arbitrary credential exfiltration origins. */
function resolveProRoomEndpoint(override: unknown = readEndpointOverride()): string {
  return parseEndpoint(override) ?? PRO_ROOM_PRODUCTION_ENDPOINT;
}

export {
  PRO_ROOM_PRODUCTION_ENDPOINT as proRoomProductionEndpointForTests,
  resolveProRoomEndpoint as resolveProRoomEndpointForTests,
};

function roomPath(code: string): string {
  if (!isProRoomCode(code)) throw new ProRoomApiError('INVALID_ROOM_CODE');
  return `/v1/rooms/${code}`;
}

function validatePin(pin: string): string {
  if (!isProRoomPin(pin)) throw new ProRoomApiError('INVALID_PIN');
  return pin;
}

function validateIdempotencyKey(value: string): string {
  if (!IDEMPOTENCY_KEY_RE.test(value)) {
    throw new ProRoomApiError('INVALID_IDEMPOTENCY_KEY');
  }
  return value;
}

function validateOpaqueId(value: string, errorCode: string): string {
  if (!OPAQUE_ID_RE.test(value)) throw new ProRoomApiError(errorCode);
  return value;
}

function validateDeveloperCommandResultCode(value: DeveloperCommandResultCode): string {
  if (!DEVELOPER_COMMAND_RESULT_CODES.has(value)) {
    throw new ProRoomApiError('INVALID_DEVELOPER_COMMAND_RESULT');
  }
  return value;
}

function validateSystemAudioGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProRoomApiError('INVALID_SYSTEM_AUDIO_GENERATION');
  }
  return value;
}

function validateSystemAudioLeaseId(value: string): string {
  if (!SYSTEM_AUDIO_LEASE_ID_RE.test(value)) {
    throw new ProRoomApiError('INVALID_SYSTEM_AUDIO_LEASE');
  }
  return value;
}

function validateSystemAudioPublication(
  value: ProRoomSystemAudioPublication,
): ProRoomSystemAudioPublication {
  const publication = parseProRoomSystemAudioPublication(value);
  if (!publication) throw new ProRoomApiError('INVALID_SYSTEM_AUDIO_PUBLICATION');
  return publication;
}

function encodeRequestBody(value: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw new ProRoomApiError('INVALID_REQUEST');
  }
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_JSON_BYTES) {
    throw new ProRoomApiError('REQUEST_TOO_LARGE');
  }
  return body;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
      throw new BodyLimitError();
    }
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BodyLimitError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ProRoomApiError('INVALID_RESPONSE');
  }
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type');
  return contentType !== null && /^application\/json(?:\s*;|$)/i.test(contentType);
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!isJsonResponse(response)) throw new ProRoomApiError('INVALID_RESPONSE', response.status);
  let text: string;
  try {
    text = await readBoundedText(response, maxBytes);
  } catch (error) {
    if (error instanceof BodyLimitError) {
      throw new ProRoomApiError('RESPONSE_TOO_LARGE', response.status);
    }
    throw error;
  }
  if (!text) throw new ProRoomApiError('INVALID_RESPONSE', response.status);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProRoomApiError('INVALID_RESPONSE', response.status);
  }
}

function parseRetryAfter(response: Response, payload: unknown): number | null {
  const header = response.headers.get('retry-after');
  const headerSeconds = header === null ? Number.NaN : Number(header);
  if (Number.isSafeInteger(headerSeconds) && headerSeconds >= 0 && headerSeconds <= 86_400) {
    return headerSeconds;
  }
  if (
    isRecord(payload) &&
    Number.isSafeInteger(payload.retryAfterSeconds) &&
    (payload.retryAfterSeconds as number) >= 0 &&
    (payload.retryAfterSeconds as number) <= 86_400
  ) {
    return payload.retryAfterSeconds as number;
  }
  return null;
}

async function throwResponseError(response: Response): Promise<never> {
  let payload: unknown = null;
  try {
    if (isJsonResponse(response)) payload = await readJson(response, MAX_ERROR_JSON_BYTES);
  } catch {
    payload = null;
  }
  const serverCode = isRecord(payload) && typeof payload.error === 'string' ? payload.error : null;
  const code =
    serverCode && ERROR_CODE_RE.test(serverCode) ? serverCode : `HTTP_${response.status}`;
  throw new ProRoomApiError(code, response.status, parseRetryAfter(response, payload));
}

function parseSnapshotEnvelope(value: unknown, expectedCode: string): ProRoomSnapshot | null {
  if (!isRecord(value) || !hasExactKeys(value, ['snapshot'])) return null;
  const snapshot = parseProRoomSnapshot(value.snapshot);
  return snapshot?.roomCode === expectedCode ? snapshot : null;
}

function parseSystemAudioEnvelope(value: unknown): ProRoomSystemAudioState | null {
  if (!isRecord(value) || !hasExactKeys(value, ['systemAudio'])) return null;
  return parseProRoomSystemAudioState(value.systemAudio);
}

function parseSystemAudioLeaseGrant(value: unknown): ProRoomSystemAudioLeaseGrant | null {
  if (!isRecord(value) || !hasExactKeys(value, ['systemAudio', 'leaseId'])) return null;
  const systemAudio = parseProRoomSystemAudioState(value.systemAudio);
  if (
    !systemAudio ||
    systemAudio.status === 'idle' ||
    typeof value.leaseId !== 'string' ||
    !SYSTEM_AUDIO_LEASE_ID_RE.test(value.leaseId)
  ) {
    return null;
  }
  return { systemAudio, leaseId: value.leaseId };
}

function parseOk(value: unknown): true | null {
  return isRecord(value) && hasExactKeys(value, ['ok']) && value.ok === true ? true : null;
}

function parseQuota(value: unknown): ProRoomQuotaSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['limitBytes', 'perAssetLimitBytes', 'usedBytes', 'reservedBytes'])
  ) {
    return null;
  }
  if (
    value.limitBytes !== PRO_ROOM_QUOTA_BYTES ||
    value.perAssetLimitBytes !== PRO_ROOM_MAX_ASSET_BYTES ||
    !isSafeNonNegativeInteger(value.usedBytes) ||
    !isSafeNonNegativeInteger(value.reservedBytes) ||
    value.usedBytes + value.reservedBytes > PRO_ROOM_QUOTA_BYTES
  ) {
    return null;
  }
  return {
    limitBytes: value.limitBytes,
    perAssetLimitBytes: value.perAssetLimitBytes,
    usedBytes: value.usedBytes,
    reservedBytes: value.reservedBytes,
  };
}

function parseR2Asset(value: unknown): ProRoomR2Source | null {
  if (!isRecord(value)) return null;
  if (
    !hasExactKeys(value, ['kind', 'assetId', 'version', 'byteLength', 'mime'], ['sha256']) ||
    value.kind !== 'pro-r2' ||
    typeof value.assetId !== 'string' ||
    !OPAQUE_ID_RE.test(value.assetId) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) <= 0 ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) <= 0 ||
    (value.byteLength as number) > PRO_ROOM_MAX_ASSET_BYTES ||
    typeof value.mime !== 'string' ||
    !MIME_RE.test(value.mime) ||
    (value.sha256 !== undefined &&
      (typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)))
  ) {
    return null;
  }
  return {
    kind: 'pro-r2',
    assetId: value.assetId,
    version: value.version as number,
    byteLength: value.byteLength as number,
    mime: value.mime,
    ...(value.sha256 === undefined ? {} : { sha256: value.sha256 as string }),
  };
}

function isValidPresignedR2Url(url: URL): boolean {
  if (url.protocol !== 'https:' || url.hostname !== PRO_ROOM_R2_HOST || url.port !== '')
    return false;
  const required = [
    'X-Amz-Algorithm',
    'X-Amz-Credential',
    'X-Amz-Date',
    'X-Amz-Expires',
    'X-Amz-SignedHeaders',
    'X-Amz-Signature',
  ];
  return (
    url.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256' &&
    required.every((name) => url.searchParams.getAll(name).length === 1)
  );
}

function parseReturnedUrl(value: unknown, endpoint: string): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  const endpointUrl = new URL(endpoint);
  if (
    url.origin === endpointUrl.origin &&
    (url.protocol === 'https:' ||
      endpointUrl.hostname === 'localhost' ||
      endpointUrl.hostname === '127.0.0.1')
  ) {
    return url.toString();
  }
  return isValidPresignedR2Url(url) ? url.toString() : null;
}

function parseUploadHeaders(value: unknown): Record<string, string> | null {
  if (!isRecord(value) || Object.keys(value).length > MAX_UPLOAD_HEADERS) return null;
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (
      !HEADER_NAME_RE.test(rawName) ||
      typeof rawValue !== 'string' ||
      rawValue.length > MAX_UPLOAD_HEADER_VALUE_LENGTH ||
      FORBIDDEN_UPLOAD_HEADERS.has(name) ||
      name.startsWith('proxy-') ||
      name.startsWith('sec-')
    ) {
      return null;
    }
    headers[name] = rawValue;
  }
  return headers;
}

function parseBootstrap(value: unknown, expectedCode: string): ProRoomBootstrap | null {
  if (!isRecord(value) || !hasExactKeys(value, ['roomCode', 'status'])) return null;
  if (value.roomCode !== expectedCode) return null;
  if (
    value.status !== 'activation_required' &&
    value.status !== 'pin_required' &&
    value.status !== 'suspended'
  ) {
    return null;
  }
  return { roomCode: expectedCode, status: value.status };
}

function parseSessionEnvelope(value: unknown, expectedCode: string): ProRoomSnapshot | null {
  if (!isRecord(value) || !hasExactKeys(value, ['snapshot', 'session'])) return null;
  if (
    !isRecord(value.session) ||
    !hasExactKeys(value.session, ['expiresAtMs']) ||
    !isSafeNonNegativeInteger(value.session.expiresAtMs)
  ) {
    return null;
  }
  const snapshot = parseProRoomSnapshot(value.snapshot);
  return snapshot?.roomCode === expectedCode ? snapshot : null;
}

interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  parser: JsonParser<T>;
  maxResponseBytes?: number;
  keepalive?: boolean;
  simpleTextBody?: boolean;
  /** Attach the tab-local incarnation lease to a live-session request. */
  activeRoomCode?: string;
}

export class ProRoomApiClient {
  readonly endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #presenceIdentities = new Map<string, ProRoomPresenceIdentity>();

  constructor(options: { endpoint?: unknown; fetch?: typeof fetch } = {}) {
    this.endpoint = resolveProRoomEndpoint(options.endpoint);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async #request<T>(path: string, options: RequestOptions<T>): Promise<T> {
    if (options.signal?.aborted) throw new ProRoomApiError('ABORTED');
    const url = new URL(path, this.endpoint);
    if (url.origin !== this.endpoint) throw new ProRoomApiError('INVALID_REQUEST');

    const headers = new Headers({ Accept: 'application/json' });
    let body: string | undefined;
    if (options.body !== undefined) {
      body = encodeRequestBody(options.body);
      headers.set(
        'Content-Type',
        options.simpleTextBody === true ? 'text/plain;charset=UTF-8' : 'application/json',
      );
    }
    if (options.idempotencyKey !== undefined) {
      headers.set('Idempotency-Key', validateIdempotencyKey(options.idempotencyKey));
    }
    if (options.activeRoomCode !== undefined) {
      const roomCode = options.activeRoomCode;
      if (!isProRoomCode(roomCode)) throw new ProRoomApiError('INVALID_ROOM_CODE');
      const identity = this.#presenceIdentities.get(roomCode);
      if (!identity) throw new ProRoomApiError('PRESENCE_IDENTITY_REQUIRED', 409);
      headers.set('X-MXQR-Pro-Participant-Id', identity.participantId);
      headers.set('X-MXQR-Pro-Presence-Incarnation', identity.presenceIncarnationId);
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body,
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: options.signal,
        ...(options.keepalive === true ? { keepalive: true } : {}),
      });
    } catch {
      throw new ProRoomApiError(options.signal?.aborted ? 'ABORTED' : 'NETWORK_ERROR');
    }

    if (!response.ok) await throwResponseError(response);
    const value = await readJson(response, options.maxResponseBytes ?? MAX_RESPONSE_JSON_BYTES);
    const parsed = options.parser(value);
    if (parsed === null) throw new ProRoomApiError('INVALID_RESPONSE', response.status);
    return parsed;
  }

  #bindPresenceIdentity(code: string, snapshot: ProRoomSnapshot): ProRoomSnapshot {
    const viewer = snapshot.viewer;
    if (
      snapshot.roomCode !== code ||
      !viewer ||
      !OPAQUE_ID_RE.test(viewer.participantId) ||
      !OPAQUE_ID_RE.test(viewer.presenceIncarnationId)
    ) {
      throw new ProRoomApiError('INVALID_RESPONSE');
    }
    this.#presenceIdentities.set(code, {
      participantId: viewer.participantId,
      presenceIncarnationId: viewer.presenceIncarnationId,
    });
    return snapshot;
  }

  /**
   * Forget only this tab's in-memory lease. This never revokes a cookie or
   * mutates server state, so terminal supersession cannot affect a newer tab.
   */
  clearPresenceIdentity(code: string, expected?: ProRoomPresenceIdentity): void {
    if (!isProRoomCode(code)) return;
    const current = this.#presenceIdentities.get(code);
    if (!current) return;
    if (
      expected &&
      (current.participantId !== expected.participantId ||
        current.presenceIncarnationId !== expected.presenceIncarnationId)
    ) {
      return;
    }
    this.#presenceIdentities.delete(code);
  }

  presenceIdentity(code: string): Readonly<ProRoomPresenceIdentity> | null {
    const identity = this.#presenceIdentities.get(code);
    return identity ? { ...identity } : null;
  }

  getBootstrap(code: string, signal?: AbortSignal): Promise<ProRoomBootstrap> {
    const path = roomPath(code);
    return this.#request(`${path}/bootstrap`, {
      signal,
      maxResponseBytes: MAX_BOOTSTRAP_JSON_BYTES,
      parser: (value) => parseBootstrap(value, code),
    });
  }

  activate(input: ActivateProRoomInput, signal?: AbortSignal): Promise<ProRoomSnapshot> {
    const path = roomPath(input.code);
    if (!parseProRoomClaimToken(input.claimToken)) {
      throw new ProRoomApiError('INVALID_CLAIM_TOKEN');
    }
    const ownerName =
      input.ownerName === undefined
        ? undefined
        : parseBoundedString(input.ownerName, MAX_DISPLAY_NAME_LENGTH);
    if (input.ownerName !== undefined && ownerName === null) {
      throw new ProRoomApiError('INVALID_DISPLAY_NAME');
    }
    return this.#request(`${path}/activation`, {
      method: 'POST',
      body: {
        claimToken: input.claimToken,
        temporaryPin: validatePin(input.temporaryPin),
        newPin: validatePin(input.newPin),
        ...(ownerName === undefined ? {} : { ownerName }),
      },
      signal,
      parser: (value) => parseSnapshotEnvelope(value, input.code),
    }).then((snapshot) => this.#bindPresenceIdentity(input.code, snapshot));
  }

  recoverOwner(input: RecoverProRoomOwnerInput, signal?: AbortSignal): Promise<ProRoomSnapshot> {
    const path = roomPath(input.code);
    if (!parseProRoomOwnerRecoveryClaimToken(input.claimToken)) {
      throw new ProRoomApiError('INVALID_RECOVERY_CLAIM_TOKEN');
    }
    const displayName = parseBoundedString(input.displayName, MAX_DISPLAY_NAME_LENGTH);
    if (displayName === null) throw new ProRoomApiError('INVALID_DISPLAY_NAME');
    return this.#request(`${path}/owner-recovery`, {
      method: 'POST',
      body: { claimToken: input.claimToken, displayName },
      signal,
      parser: (value) => parseSnapshotEnvelope(value, input.code),
    }).then((snapshot) => this.#bindPresenceIdentity(input.code, snapshot));
  }

  createSession(input: CreateProRoomSessionInput, signal?: AbortSignal): Promise<ProRoomSnapshot> {
    const path = roomPath(input.code);
    const displayName = parseBoundedString(input.displayName, MAX_DISPLAY_NAME_LENGTH);
    if (displayName === null) throw new ProRoomApiError('INVALID_DISPLAY_NAME');
    return this.#request(`${path}/sessions`, {
      method: 'POST',
      body: { pin: validatePin(input.pin), displayName },
      signal,
      parser: (value) => parseSessionEnvelope(value, input.code),
    }).then((snapshot) => this.#bindPresenceIdentity(input.code, snapshot));
  }

  getSnapshot(code: string, signal?: AbortSignal): Promise<ProRoomSnapshot> {
    const path = roomPath(code);
    return this.#request(`${path}/snapshot`, {
      signal,
      activeRoomCode: code,
      parser: (value) => parseSnapshotEnvelope(value, code),
    });
  }

  async enterPresence(
    code: string,
    options: EnterProRoomPresenceOptions = {},
  ): Promise<ProRoomSnapshot> {
    const path = roomPath(code);
    const snapshot = await this.#request(`${path}/presence/enter`, {
      method: 'POST',
      ...(options.takeover === true ? { body: { takeover: true } } : {}),
      signal: options.signal,
      parser: (value) => parseSnapshotEnvelope(value, code),
    });
    return this.#bindPresenceIdentity(code, snapshot);
  }

  async closeSession(code: string, signal?: AbortSignal): Promise<void> {
    const path = roomPath(code);
    await this.#request(`${path}/sessions/current`, {
      method: 'DELETE',
      signal,
      activeRoomCode: code,
      parser: parseOk,
      maxResponseBytes: MAX_BOOTSTRAP_JSON_BYTES,
    });
    this.clearPresenceIdentity(code);
  }

  /**
   * Revoke only the server session that still owns the captured presence
   * incarnation. The endpoint deliberately emits no cookie tombstone: a
   * delayed response must not erase a newer same-name cookie from another tab.
   */
  async closeSessionFenced(
    input: CloseProRoomSessionFencedInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const path = roomPath(input.code);
    await this.#request(`${path}/sessions/current/close`, {
      method: 'POST',
      body: {
        expectedParticipantId: validateOpaqueId(
          input.expectedParticipantId,
          'INVALID_PARTICIPANT_ID',
        ),
        expectedPresenceIncarnationId: validateOpaqueId(
          input.expectedPresenceIncarnationId,
          'INVALID_PRESENCE_INCARNATION_ID',
        ),
      },
      simpleTextBody: true,
      signal,
      parser: parseOk,
      maxResponseBytes: MAX_BOOTSTRAP_JSON_BYTES,
    });
    this.clearPresenceIdentity(input.code, {
      participantId: input.expectedParticipantId,
      presenceIncarnationId: input.expectedPresenceIncarnationId,
    });
  }

  async changePin(code: string, pin: string, signal?: AbortSignal): Promise<void> {
    const path = roomPath(code);
    await this.#request(`${path}/pin`, {
      method: 'POST',
      body: { pin: validatePin(pin) },
      signal,
      activeRoomCode: code,
      parser: parseOk,
      maxResponseBytes: MAX_BOOTSTRAP_JSON_BYTES,
    });
  }

  heartbeat(code: string, signal?: AbortSignal): Promise<ProRoomSnapshot> {
    const path = roomPath(code);
    return this.#request(`${path}/presence/heartbeat`, {
      method: 'POST',
      signal,
      activeRoomCode: code,
      parser: (value) => parseSnapshotEnvelope(value, code),
    });
  }

  getSystemAudioState(code: string, signal?: AbortSignal): Promise<ProRoomSystemAudioState> {
    const path = roomPath(code);
    return this.#request(`${path}/system-audio`, {
      signal,
      activeRoomCode: code,
      maxResponseBytes: MAX_BOOTSTRAP_JSON_BYTES,
      parser: parseSystemAudioEnvelope,
    });
  }

  acquireSystemAudioLease(
    code: string,
    signal?: AbortSignal,
  ): Promise<ProRoomSystemAudioLeaseGrant> {
    const path = roomPath(code);
    return this.#request(`${path}/system-audio/acquire`, {
      method: 'POST',
      body: {},
      signal,
      activeRoomCode: code,
      maxResponseBytes: MAX_BOOTSTRAP_JSON_BYTES,
      parser: parseSystemAudioLeaseGrant,
    });
  }

  commitSystemAudioPublication(
    input: CommitProRoomSystemAudioInput,
    signal?: AbortSignal,
  ): Promise<ProRoomSystemAudioState> {
    const path = roomPath(input.code);
    return this.#request(`${path}/system-audio/commit`, {
      method: 'POST',
      body: {
        generation: validateSystemAudioGeneration(input.generation),
        leaseId: validateSystemAudioLeaseId(input.leaseId),
        publication: validateSystemAudioPublication(input.publication),
      },
      signal,
      activeRoomCode: input.code,
      maxResponseBytes: MAX_BOOTSTRAP_JSON_BYTES,
      parser: parseSystemAudioEnvelope,
    });
  }

  heartbeatSystemAudioLease(
    input: UpdateProRoomSystemAudioLeaseInput,
    signal?: AbortSignal,
  ): Promise<ProRoomSystemAudioState> {
    const path = roomPath(input.code);
    return this.#request(`${path}/system-audio/heartbeat`, {
      method: 'POST',
      body: {
        generation: validateSystemAudioGeneration(input.generation),
        leaseId: validateSystemAudioLeaseId(input.leaseId),
      },
      signal,
      activeRoomCode: input.code,
      maxResponseBytes: MAX_BOOTSTRAP_JSON_BYTES,
      parser: parseSystemAudioEnvelope,
    });
  }

  releaseSystemAudioLease(
    input: UpdateProRoomSystemAudioLeaseInput,
    signal?: AbortSignal,
  ): Promise<ProRoomSystemAudioState> {
    const path = roomPath(input.code);
    return this.#request(`${path}/system-audio/release`, {
      method: 'POST',
      body: {
        generation: validateSystemAudioGeneration(input.generation),
        leaseId: validateSystemAudioLeaseId(input.leaseId),
      },
      signal,
      activeRoomCode: input.code,
      maxResponseBytes: MAX_BOOTSTRAP_JSON_BYTES,
      parser: parseSystemAudioEnvelope,
    });
  }

  async leavePresence(code: string, signal?: AbortSignal): Promise<ProRoomSnapshot> {
    const path = roomPath(code);
    const snapshot = await this.#request(`${path}/presence/current`, {
      method: 'DELETE',
      signal,
      activeRoomCode: code,
      parser: (value) => parseSnapshotEnvelope(value, code),
    });
    this.clearPresenceIdentity(code);
    return snapshot;
  }

  /**
   * Persist a final coordinator checkpoint and release presence in one
   * keepalive request. This intentionally does not close the cookie session:
   * unlike the explicit leave flow, a tab close has no reliable opportunity
   * to consume a Set-Cookie response and the retained session makes a later
   * resume deterministic.
   */
  async closePresenceOnUnload(input: CloseProRoomPresenceInput): Promise<void> {
    const path = roomPath(input.code);
    if (!isSafeNonNegativeInteger(input.baseRevision)) {
      throw new ProRoomApiError('INVALID_REVISION');
    }
    if (input.currentQueueItemId !== null && !isProRoomQueueItemId(input.currentQueueItemId)) {
      throw new ProRoomApiError('INVALID_QUEUE_ITEM_ID');
    }
    await this.#request(`${path}/presence/close`, {
      method: 'POST',
      body: {
        idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
        expectedParticipantId: validateOpaqueId(
          input.expectedParticipantId,
          'INVALID_PARTICIPANT_ID',
        ),
        expectedPresenceIncarnationId: validateOpaqueId(
          input.expectedPresenceIncarnationId,
          'INVALID_PRESENCE_INCARNATION_ID',
        ),
        baseRevision: input.baseRevision,
        currentQueueItemId: input.currentQueueItemId,
        playback: input.playback,
      },
      keepalive: true,
      simpleTextBody: true,
      parser: parseOk,
      maxResponseBytes: MAX_BOOTSTRAP_JSON_BYTES,
    });
  }

  async createSignalingTicket(code: string, signal?: AbortSignal): Promise<ProRoomSignalingAccess> {
    const path = roomPath(code);
    const parser = (value: unknown): ProRoomSignalingAccess | null => {
      if (
        !isRecord(value) ||
        !hasExactKeys(value, [
          'ticket',
          'expiresAtMs',
          'role',
          'coordinatorEpoch',
          'presenceIncarnationId',
          'ticketSequence',
        ])
      ) {
        return null;
      }
      const ticket = parseProRoomSignalingTicket(value.ticket);
      if (
        !ticket ||
        !isSafeNonNegativeInteger(value.expiresAtMs) ||
        (value.role !== 'coordinator' && value.role !== 'member') ||
        !isSafeNonNegativeInteger(value.coordinatorEpoch) ||
        typeof value.presenceIncarnationId !== 'string' ||
        !OPAQUE_ID_RE.test(value.presenceIncarnationId) ||
        !Number.isSafeInteger(value.ticketSequence) ||
        (value.ticketSequence as number) < 1
      ) {
        return null;
      }
      return {
        ticket,
        expiresAtMs: value.expiresAtMs,
        role: value.role,
        coordinatorEpoch: value.coordinatorEpoch,
        presenceIncarnationId: value.presenceIncarnationId,
        ticketSequence: value.ticketSequence as number,
      };
    };
    const requestTicket = (advertiseDeveloperControl: boolean) =>
      this.#request(`${path}/signaling-tickets`, {
        method: 'POST',
        ...(advertiseDeveloperControl ? { body: { developerControlVersion: 1 } } : {}),
        signal,
        activeRoomCode: code,
        maxResponseBytes: MAX_BOOTSTRAP_JSON_BYTES,
        parser,
      });

    try {
      return await requestTicket(true);
    } catch (error) {
      // A cached/new app can briefly meet the previous PRO Worker during an
      // operational rollback. That Worker rejects any non-empty ticket body.
      // Retry only its exact legacy response and deliberately omit the
      // capability: room entry survives, while Developer API commands remain
      // fail-closed until both sides are on the new protocol.
      if (
        signal?.aborted ||
        !(error instanceof ProRoomApiError) ||
        error.status !== 400 ||
        error.code !== 'INVALID_REQUEST'
      ) {
        throw error;
      }
      return requestTicket(false);
    }
  }

  async ackDeveloperCommand(
    input: AckProRoomDeveloperCommandInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const path = roomPath(input.code);
    if (!DEVELOPER_COMMAND_ID_RE.test(input.commandId)) {
      throw new ProRoomApiError('INVALID_DEVELOPER_COMMAND_ID');
    }
    const commandId = input.commandId;
    await this.#request(`${path}/developer-commands/${encodeURIComponent(commandId)}/ack`, {
      method: 'POST',
      body: { resultCode: validateDeveloperCommandResultCode(input.resultCode) },
      signal,
      activeRoomCode: input.code,
      parser: parseOk,
      maxResponseBytes: MAX_BOOTSTRAP_JSON_BYTES,
    });
  }

  updateSnapshot(
    input: UpdateProRoomSnapshotInput,
    signal?: AbortSignal,
  ): Promise<ProRoomSnapshot> {
    const path = roomPath(input.code);
    if (!isSafeNonNegativeInteger(input.baseRevision)) {
      throw new ProRoomApiError('INVALID_REVISION');
    }
    if (input.currentQueueItemId !== null && !isProRoomQueueItemId(input.currentQueueItemId)) {
      throw new ProRoomApiError('INVALID_QUEUE_ITEM_ID');
    }
    return this.#request(`${path}/snapshot`, {
      method: 'PUT',
      idempotencyKey: input.idempotencyKey,
      body: {
        baseRevision: input.baseRevision,
        playlist: input.playlist,
        currentQueueItemId: input.currentQueueItemId,
        playback: input.playback,
      },
      signal,
      activeRoomCode: input.code,
      parser: (value) => parseSnapshotEnvelope(value, input.code),
    });
  }

  createMediaReservation(
    input: CreateProRoomMediaReservationInput,
    signal?: AbortSignal,
  ): Promise<ProRoomMediaReservation> {
    const path = roomPath(input.code);
    const name = parseBoundedString(input.name, MAX_NAME_LENGTH);
    if (name === null) throw new ProRoomApiError('INVALID_MEDIA_NAME');
    if (
      !Number.isSafeInteger(input.byteLength) ||
      input.byteLength <= 0 ||
      input.byteLength > PRO_ROOM_MAX_ASSET_BYTES
    ) {
      throw new ProRoomApiError('INVALID_MEDIA_SIZE');
    }
    if (!MIME_RE.test(input.mime)) throw new ProRoomApiError('INVALID_MEDIA_TYPE');
    if (input.sha256 !== undefined && !SHA256_RE.test(input.sha256)) {
      throw new ProRoomApiError('INVALID_MEDIA_HASH');
    }
    return this.#request(`${path}/media/reservations`, {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: {
        byteLength: input.byteLength,
        name,
        mime: input.mime,
        ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      },
      signal,
      activeRoomCode: input.code,
      parser: (value) => {
        if (!isRecord(value) || !hasExactKeys(value, ['reservation', 'quota'])) return null;
        const quota = parseQuota(value.quota);
        if (!quota || !isRecord(value.reservation)) return null;
        const reservation = value.reservation;
        if (
          !hasExactKeys(reservation, [
            'assetId',
            'version',
            'byteLength',
            'expiresAtMs',
            'upload',
          ]) ||
          typeof reservation.assetId !== 'string' ||
          !OPAQUE_ID_RE.test(reservation.assetId) ||
          !Number.isSafeInteger(reservation.version) ||
          (reservation.version as number) <= 0 ||
          reservation.byteLength !== input.byteLength ||
          !isSafeNonNegativeInteger(reservation.expiresAtMs) ||
          !isRecord(reservation.upload) ||
          !hasExactKeys(reservation.upload, ['method', 'url', 'headers']) ||
          reservation.upload.method !== 'PUT'
        ) {
          return null;
        }
        const url = parseReturnedUrl(reservation.upload.url, this.endpoint);
        const headers = parseUploadHeaders(reservation.upload.headers);
        if (!url || !headers) return null;
        return {
          assetId: reservation.assetId,
          version: reservation.version as number,
          byteLength: input.byteLength,
          expiresAtMs: reservation.expiresAtMs,
          upload: { method: 'PUT', url, headers },
          quota,
        };
      },
    });
  }

  completeMedia(
    input: CompleteProRoomMediaInput,
    signal?: AbortSignal,
  ): Promise<{ asset: ProRoomR2Source; quota: ProRoomQuotaSnapshot }> {
    const path = roomPath(input.code);
    const assetId = validateOpaqueId(input.assetId, 'INVALID_ASSET_ID');
    return this.#request(`${path}/media/${encodeURIComponent(assetId)}/complete`, {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      signal,
      activeRoomCode: input.code,
      parser: (value) => {
        if (!isRecord(value) || !hasExactKeys(value, ['asset', 'quota'])) return null;
        const asset = parseR2Asset(value.asset);
        const quota = parseQuota(value.quota);
        return asset && quota ? { asset, quota } : null;
      },
    });
  }

  getMediaDownload(
    code: string,
    assetId: string,
    signal?: AbortSignal,
  ): Promise<ProRoomMediaDownload> {
    const path = roomPath(code);
    const safeAssetId = validateOpaqueId(assetId, 'INVALID_ASSET_ID');
    return this.#request(`${path}/media/${encodeURIComponent(safeAssetId)}/download`, {
      signal,
      activeRoomCode: code,
      parser: (value) => {
        if (!isRecord(value) || !hasExactKeys(value, ['asset', 'download'])) return null;
        const asset = parseR2Asset(value.asset);
        if (
          !asset ||
          !isRecord(value.download) ||
          !hasExactKeys(value.download, ['url', 'expiresAtMs']) ||
          !isSafeNonNegativeInteger(value.download.expiresAtMs)
        ) {
          return null;
        }
        const url = parseReturnedUrl(value.download.url, this.endpoint);
        return url ? { asset, url, expiresAtMs: value.download.expiresAtMs } : null;
      },
    });
  }

  deleteMedia(
    input: DeleteProRoomMediaInput,
    signal?: AbortSignal,
  ): Promise<{ assetId: string; quota: ProRoomQuotaSnapshot }> {
    const path = roomPath(input.code);
    const assetId = validateOpaqueId(input.assetId, 'INVALID_ASSET_ID');
    return this.#request(`${path}/media/${encodeURIComponent(assetId)}`, {
      method: 'DELETE',
      idempotencyKey: input.idempotencyKey,
      signal,
      activeRoomCode: input.code,
      parser: (value) => {
        if (!isRecord(value) || !hasExactKeys(value, ['ok', 'assetId', 'quota'])) return null;
        const quota = parseQuota(value.quota);
        return value.ok === true && value.assetId === assetId && quota ? { assetId, quota } : null;
      },
    });
  }
}
