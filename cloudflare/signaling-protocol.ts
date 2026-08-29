// Pure signaling validation; storage and socket lifecycle stay in signaling-worker.ts.
export const WS_MESSAGE_MAX_BYTES = 64 * 1024;
export const PRO_REALTIME_BODY_MAX_BYTES = 8 * 1024;
export const PRO_CHAT_SLOWMODE_MAX_SECONDS = 60;
export const MAX_PRO_ROOM_MEMBERS = 100;
export const PRO_REALTIME_EVENT_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
export const PRO_PRESENCE_INCARNATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
export type ProChatModerationKind = 'clear' | 'freeze' | 'filter' | 'slowmode' | 'mute';
export const PRO_CHAT_MODERATION_KINDS = new Set<string>([
  'clear',
  'freeze',
  'filter',
  'slowmode',
  'mute',
]);

export type IncomingMessageValidation = 'valid' | 'ignore' | 'oversized';

type NormalizedJson =
  | null
  | boolean
  | number
  | string
  | NormalizedJson[]
  | { [key: string]: NormalizedJson };

interface NormalizationBudget {
  keys: number;
  values: number;
}

const SDP_MAX_BYTES = 48 * 1024;
const ICE_CANDIDATE_MAX_BYTES = 4 * 1024;
const PRO_SERVER_EVENT_MAX_BYTES = 3 * 1024;
const PRO_REALTIME_TEXT_MAX_LENGTH = 500;
const PRO_REALTIME_COMMAND_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
const PRO_SERVER_EVENT_TYPES = new Set<string>([
  'pro-playback-prepare',
  'pro-playback-commit',
  'pro-playback-cancel',
  'pro-presence-snapshot',
  'pro-room-invalidated',
  'system-audio-invalidated',
]);
const REMOTE_SHARE_UPLOAD_ASSERTION_CORRELATION_ID_RE = /^rsaq_[A-Za-z0-9_-]{32}$/;
const REMOTE_SHARE_UPLOAD_ASSERTION_ACTOR_ID_RE = /^rsa_[A-Za-z0-9_-]{43}$/;
const REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST_ID_RE = /^rs3_[A-Za-z0-9_-]{43}$/;
const REMOTE_SHARE_UPLOAD_ASSERTION_BODY_SHA256_RE = /^[A-Za-z0-9_-]{43}$/;
const REMOTE_SHARE_UPLOAD_ASSERTION_QUEUE_ITEM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REMOTE_SHARE_MAX_BYTES = 200 * 1024 * 1024;
const STANDARD_ROOM_PIN_MUTATION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Compatibility predicate for JavaScript Worker consumers. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return isUnknownRecord(value);
}

function hasExactObjectKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isUnknownRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

/** Compatibility predicate for JavaScript Worker consumers. */
export function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return hasExactObjectKeys(value, required, optional);
}

function isPeerId(peerId: unknown): peerId is string {
  return typeof peerId === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(peerId);
}

/** Compatibility predicate for JavaScript Worker consumers. */
export function isValidPeerId(peerId: unknown): peerId is string {
  return isPeerId(peerId);
}

function hasValidNegotiationId(message: Record<string, unknown>): boolean {
  return (
    typeof message.negotiationId === 'string' &&
    /^[A-Za-z0-9_-]{16,64}$/.test(message.negotiationId)
  );
}

function isValidGuestReconnectSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(secret);
}

function utf8ByteLength(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  return new TextEncoder().encode(value).byteLength;
}

export function rawMessageByteLength(raw: unknown): number | null {
  if (typeof raw === 'string') {
    // UTF-8 is never shorter, so avoid another allocation past the limit.
    if (raw.length > WS_MESSAGE_MAX_BYTES) return raw.length;
    return utf8ByteLength(raw);
  }
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return null;
}

function normalizeBoundedJson(
  value: unknown,
  depth: number = 0,
  budget: NormalizationBudget = { keys: 0, values: 0 },
): NormalizedJson | undefined {
  if (depth > 4 || budget.values >= 256) return undefined;
  budget.values += 1;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : undefined;
  }
  if (typeof value === 'string') return value.length <= 2048 ? value : undefined;
  if (Array.isArray(value)) {
    if (value.length > 100) return undefined;
    const result: NormalizedJson[] = [];
    for (const item of value) {
      const normalized = normalizeBoundedJson(item, depth + 1, budget);
      if (normalized === undefined) return undefined;
      result.push(normalized);
    }
    return result;
  }
  if (!isUnknownRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (budget.keys + keys.length > 32) return undefined;
  const result: Record<string, NormalizedJson> = {};
  for (const key of keys) {
    if (
      !key ||
      key.length > 64 ||
      key === '__proto__' ||
      key === 'prototype' ||
      key === 'constructor'
    ) {
      return undefined;
    }
    budget.keys += 1;
    const normalized = normalizeBoundedJson(value[key], depth + 1, budget);
    if (normalized === undefined) return undefined;
    result[key] = normalized;
  }
  return result;
}

export function normalizeProServerEvent(value: unknown): Record<string, NormalizedJson> | null {
  if (
    !isUnknownRecord(value) ||
    typeof value.type !== 'string' ||
    !PRO_SERVER_EVENT_TYPES.has(value.type)
  ) {
    return null;
  }
  const normalized = normalizeBoundedJson(value);
  if (!isUnknownRecord(normalized) || normalized.type !== value.type) return null;
  if (
    normalized.type === 'pro-presence-snapshot' &&
    (typeof normalized.presenceRevision !== 'number' ||
      !Number.isSafeInteger(normalized.presenceRevision) ||
      normalized.presenceRevision < 0)
  ) {
    return null;
  }
  const bytes = utf8ByteLength(JSON.stringify(normalized));
  return bytes !== null && bytes <= PRO_SERVER_EVENT_MAX_BYTES ? normalized : null;
}

export function normalizeProBroadcastTargets(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PRO_ROOM_MEMBERS) return null;
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const incarnationId of value) {
    if (
      typeof incarnationId !== 'string' ||
      !PRO_PRESENCE_INCARNATION_ID_RE.test(incarnationId) ||
      seen.has(incarnationId)
    ) {
      return null;
    }
    seen.add(incarnationId);
    targets.push(incarnationId);
  }
  return targets;
}

export type ProBotResult =
  | { kind: 'answer'; text: string }
  | { kind: 'added'; count: number; playbackChanged: boolean }
  | { kind: 'failed' }
  | { kind: 'rate_limited'; retryAfterSeconds: number };

export type ProChatPayload =
  | { kind: 'message'; text: string; clientTs: number; botRequestId?: string }
  | { kind: 'bot-result'; requestId: string; result: ProBotResult }
  | { kind: 'system'; text: string; i18nKey: string }
  | { kind: 'notice'; text: string }
  | { kind: 'clear' }
  | { kind: 'freeze' | 'filter'; on: boolean }
  | { kind: 'slowmode'; seconds: number }
  | { kind: 'mute'; targetParticipantId: string; on: boolean }
  | { kind: 'whisper'; targetParticipantId: string; text: string };

export type ProSystemAudioSignalDirection = 'publisher' | 'subscriber';

interface ProSystemAudioSignalBase {
  targetParticipantId: string;
  direction: ProSystemAudioSignalDirection;
  generation: number;
  publicationId: string;
  negotiationId: string;
}

export type ProSystemAudioSignalPayload =
  | (ProSystemAudioSignalBase & {
      kind: 'offer';
      direction: 'publisher';
      phase: 'probe';
      description: { type: 'offer'; sdp: string };
    })
  | (ProSystemAudioSignalBase & {
      kind: 'offer';
      direction: 'publisher';
      phase: 'media';
      description: { type: 'offer'; sdp: string };
      trackId: string;
    })
  | (ProSystemAudioSignalBase & {
      kind: 'answer';
      direction: 'subscriber';
      phase: 'probe' | 'media';
      description: { type: 'answer'; sdp: string };
    })
  | (ProSystemAudioSignalBase & {
      kind: 'candidate';
      candidate: {
        candidate: string;
        sdpMid?: string | null;
        sdpMLineIndex?: number | null;
        usernameFragment?: string | null;
      };
    })
  | (ProSystemAudioSignalBase & {
      kind: 'close';
      reason: 'stopped' | 'fallback' | 'superseded';
    });

export type NormalizedProRealtimeFrame =
  | {
      type: 'pro-realtime';
      version: 1;
      eventId: string;
      channel: 'chat';
      payload: ProChatPayload;
    }
  | {
      type: 'pro-realtime';
      version: 1;
      eventId: string;
      channel: 'presence';
      payload: { state: 'active' | 'away' };
    }
  | {
      type: 'pro-realtime';
      version: 1;
      eventId: string;
      channel: 'control-ready';
      payload: { commandId: string; sequence: number; ready: boolean };
    }
  | {
      type: 'pro-realtime';
      version: 1;
      eventId: string;
      channel: 'clock';
      payload: { requestId: number; clientSentAtMs: number };
    }
  | {
      type: 'pro-realtime';
      version: 1;
      eventId: string;
      channel: 'system-audio-signal';
      payload: ProSystemAudioSignalPayload;
    };

function normalizeProBotResult(value: unknown): ProBotResult | null {
  if (!isUnknownRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'answer') {
    return hasExactObjectKeys(value, ['kind', 'text']) &&
      typeof value.text === 'string' &&
      value.text.trim().length > 0 &&
      value.text.length <= PRO_REALTIME_TEXT_MAX_LENGTH
      ? { kind: 'answer', text: value.text.trim() }
      : null;
  }
  if (value.kind === 'added') {
    return hasExactObjectKeys(value, ['kind', 'count', 'playbackChanged']) &&
      typeof value.count === 'number' &&
      Number.isSafeInteger(value.count) &&
      value.count >= 1 &&
      value.count <= 3 &&
      typeof value.playbackChanged === 'boolean'
      ? { kind: 'added', count: value.count, playbackChanged: value.playbackChanged }
      : null;
  }
  if (value.kind === 'failed') {
    return hasExactObjectKeys(value, ['kind']) ? { kind: 'failed' } : null;
  }
  if (value.kind === 'rate_limited') {
    return hasExactObjectKeys(value, ['kind', 'retryAfterSeconds']) &&
      typeof value.retryAfterSeconds === 'number' &&
      Number.isSafeInteger(value.retryAfterSeconds) &&
      value.retryAfterSeconds >= 1 &&
      value.retryAfterSeconds <= 24 * 60 * 60
      ? { kind: 'rate_limited', retryAfterSeconds: value.retryAfterSeconds }
      : null;
  }
  return null;
}

const PRO_SYSTEM_MESSAGE_KEYS_WITHOUT_PARAMS = new Set<string>([
  'chat.decode_skip_system_message',
  'chat.system_audio_started_system_message',
  'chat.system_audio_stopped_system_message',
]);

function normalizeProSystemMessage(
  value: unknown,
): Extract<ProChatPayload, { kind: 'system' }> | null {
  if (
    !hasExactObjectKeys(value, ['kind', 'text', 'i18nKey'], ['i18nParams']) ||
    typeof value.text !== 'string' ||
    value.text.length < 1 ||
    value.text.length > PRO_REALTIME_TEXT_MAX_LENGTH ||
    !value.text.trim() ||
    typeof value.i18nKey !== 'string'
  ) {
    return null;
  }

  const i18nKey = value.i18nKey;
  if (PRO_SYSTEM_MESSAGE_KEYS_WITHOUT_PARAMS.has(i18nKey)) {
    if (value.i18nParams !== undefined) return null;
    return { kind: 'system', text: i18nKey, i18nKey };
  }
  return null;
}

function isProBotCommandText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const explicit = /^\/bot(?:\s+)([\s\S]+)$/i.exec(value);
  const compact = explicit ? null : /^\/\/(?!\/)([\s\S]+)$/.exec(value);
  return !!(explicit?.[1] ?? compact?.[1] ?? '').trim();
}

function normalizeProChatPayload(value: unknown): ProChatPayload | null {
  if (!isUnknownRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'message') {
    if (
      !hasExactObjectKeys(value, ['kind', 'text', 'clientTs'], ['botRequestId']) ||
      typeof value.text !== 'string' ||
      value.text.length < 1 ||
      value.text.length > PRO_REALTIME_TEXT_MAX_LENGTH ||
      !value.text.trim() ||
      typeof value.clientTs !== 'number' ||
      !Number.isFinite(value.clientTs) ||
      value.clientTs < 0 ||
      value.clientTs > Number.MAX_SAFE_INTEGER ||
      (value.botRequestId !== undefined &&
        (typeof value.botRequestId !== 'string' ||
          !PRO_REALTIME_EVENT_ID_RE.test(value.botRequestId) ||
          !isProBotCommandText(value.text)))
    ) {
      return null;
    }
    return {
      kind: 'message',
      text: value.text,
      clientTs: value.clientTs,
      ...(value.botRequestId === undefined ? {} : { botRequestId: value.botRequestId }),
    };
  }
  if (value.kind === 'bot-result') {
    const result = normalizeProBotResult(value.result);
    return hasExactObjectKeys(value, ['kind', 'requestId', 'result']) &&
      typeof value.requestId === 'string' &&
      PRO_REALTIME_EVENT_ID_RE.test(value.requestId) &&
      result
      ? { kind: 'bot-result', requestId: value.requestId, result }
      : null;
  }
  if (value.kind === 'system') {
    return normalizeProSystemMessage(value);
  }
  if (value.kind === 'notice') {
    return hasExactObjectKeys(value, ['kind', 'text']) &&
      typeof value.text === 'string' &&
      value.text.trim().length > 0 &&
      value.text.length <= PRO_REALTIME_TEXT_MAX_LENGTH
      ? { kind: 'notice', text: value.text }
      : null;
  }
  if (value.kind === 'clear') {
    return hasExactObjectKeys(value, ['kind']) ? { kind: 'clear' } : null;
  }
  if (value.kind === 'freeze' || value.kind === 'filter') {
    return hasExactObjectKeys(value, ['kind', 'on']) && typeof value.on === 'boolean'
      ? { kind: value.kind, on: value.on }
      : null;
  }
  if (value.kind === 'slowmode') {
    return hasExactObjectKeys(value, ['kind', 'seconds']) &&
      typeof value.seconds === 'number' &&
      Number.isSafeInteger(value.seconds) &&
      value.seconds >= 0 &&
      value.seconds <= PRO_CHAT_SLOWMODE_MAX_SECONDS
      ? { kind: 'slowmode', seconds: value.seconds }
      : null;
  }
  if (value.kind === 'mute') {
    return hasExactObjectKeys(value, ['kind', 'targetParticipantId', 'on']) &&
      isPeerId(value.targetParticipantId) &&
      typeof value.on === 'boolean'
      ? { kind: 'mute', targetParticipantId: value.targetParticipantId, on: value.on }
      : null;
  }
  if (value.kind === 'whisper') {
    return hasExactObjectKeys(value, ['kind', 'targetParticipantId', 'text']) &&
      isPeerId(value.targetParticipantId) &&
      typeof value.text === 'string' &&
      value.text.trim().length > 0 &&
      value.text.length <= PRO_REALTIME_TEXT_MAX_LENGTH
      ? { kind: 'whisper', targetParticipantId: value.targetParticipantId, text: value.text }
      : null;
  }
  return null;
}

const PRO_SYSTEM_AUDIO_SIGNAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PRO_SYSTEM_AUDIO_TRACK_ID_MAX_LENGTH = 160;
const PRO_SYSTEM_AUDIO_SIGNAL_COMMON_KEYS = [
  'kind',
  'targetParticipantId',
  'direction',
  'generation',
  'publicationId',
  'negotiationId',
] as const;

function normalizeProSystemAudioSignalBase(
  value: Record<string, unknown>,
): ProSystemAudioSignalBase | null {
  if (
    !isPeerId(value.targetParticipantId) ||
    (value.direction !== 'publisher' && value.direction !== 'subscriber') ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    typeof value.publicationId !== 'string' ||
    !PRO_SYSTEM_AUDIO_SIGNAL_ID_RE.test(value.publicationId) ||
    typeof value.negotiationId !== 'string' ||
    !PRO_SYSTEM_AUDIO_SIGNAL_ID_RE.test(value.negotiationId)
  ) {
    return null;
  }
  return {
    targetParticipantId: value.targetParticipantId,
    direction: value.direction,
    generation: value.generation,
    publicationId: value.publicationId,
    negotiationId: value.negotiationId,
  };
}

function normalizeProSystemAudioTrackId(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= PRO_SYSTEM_AUDIO_TRACK_ID_MAX_LENGTH
    ? value
    : null;
}

function normalizeProSystemAudioCandidate(
  value: unknown,
): Extract<ProSystemAudioSignalPayload, { kind: 'candidate' }>['candidate'] | null {
  if (
    !hasExactObjectKeys(value, ['candidate'], ['sdpMid', 'sdpMLineIndex', 'usernameFragment']) ||
    !isValidIceCandidate(value)
  ) {
    return null;
  }
  const candidateFields = value.candidate.trim().split(/\s+/);
  const remoteAddress = candidateFields[4] ?? '';
  const remotePort = Number(candidateFields[5]);
  if (
    candidateFields.length < 8 ||
    candidateFields[1] !== '1' ||
    candidateFields[2]?.toLowerCase() !== 'udp' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.local$/i.test(
      remoteAddress,
    ) ||
    !Number.isSafeInteger(remotePort) ||
    remotePort < 1 ||
    remotePort > 65_535 ||
    candidateFields[6]?.toLowerCase() !== 'typ' ||
    candidateFields[7]?.toLowerCase() !== 'host'
  ) {
    return null;
  }
  return {
    // The bounded base candidate is sufficient and cannot smuggle caller-set
    // related addresses through optional ICE extensions.
    candidate: candidateFields.slice(0, 8).join(' '),
    ...(value.sdpMid === undefined ? {} : { sdpMid: value.sdpMid as string | null }),
    ...(value.sdpMLineIndex === undefined
      ? {}
      : { sdpMLineIndex: value.sdpMLineIndex as number | null }),
    ...(value.usernameFragment === undefined
      ? {}
      : { usernameFragment: value.usernameFragment as string | null }),
  };
}

function isCandidateFreeProSystemAudioSdp(sdp: string): boolean {
  return !sdp.split(/\r\n|\n|\r/).some((line) => {
    const normalized = line.trim().toLowerCase();
    if (
      normalized.startsWith('a=candidate:') ||
      normalized.startsWith('a=remote-candidates:') ||
      normalized === 'a=end-of-candidates'
    ) {
      return true;
    }
    const connection = /^c=in\s+(ip4|ip6)\s+(\S+)(?:\s|$)/i.exec(normalized);
    return Boolean(
      connection &&
      !(
        (connection[1] === 'ip4' && connection[2] === '0.0.0.0') ||
        (connection[1] === 'ip6' && connection[2] === '::')
      ),
    );
  });
}

function normalizeProSystemAudioSignalPayload(value: unknown): ProSystemAudioSignalPayload | null {
  if (!isUnknownRecord(value) || typeof value.kind !== 'string') return null;
  const base = normalizeProSystemAudioSignalBase(value);
  if (!base) return null;

  if (value.kind === 'offer') {
    if (
      base.direction !== 'publisher' ||
      (value.phase !== 'probe' && value.phase !== 'media') ||
      !hasExactObjectKeys(value.description, ['type', 'sdp']) ||
      !isValidSdp(value.description, 'offer') ||
      !isCandidateFreeProSystemAudioSdp(value.description.sdp)
    ) {
      return null;
    }
    if (value.phase === 'probe') {
      if (
        !hasExactObjectKeys(value, [...PRO_SYSTEM_AUDIO_SIGNAL_COMMON_KEYS, 'phase', 'description'])
      ) {
        return null;
      }
      return {
        ...base,
        kind: 'offer',
        direction: 'publisher',
        phase: 'probe',
        description: { type: 'offer', sdp: value.description.sdp },
      };
    }
    if (
      !hasExactObjectKeys(value, [
        ...PRO_SYSTEM_AUDIO_SIGNAL_COMMON_KEYS,
        'phase',
        'description',
        'trackId',
      ])
    ) {
      return null;
    }
    const trackId = normalizeProSystemAudioTrackId(value.trackId);
    if (!trackId) return null;
    return {
      ...base,
      kind: 'offer',
      direction: 'publisher',
      phase: 'media',
      description: { type: 'offer', sdp: value.description.sdp },
      trackId,
    };
  }

  if (value.kind === 'answer') {
    if (
      !hasExactObjectKeys(value, [
        ...PRO_SYSTEM_AUDIO_SIGNAL_COMMON_KEYS,
        'phase',
        'description',
      ]) ||
      base.direction !== 'subscriber' ||
      (value.phase !== 'probe' && value.phase !== 'media') ||
      !hasExactObjectKeys(value.description, ['type', 'sdp']) ||
      !isValidSdp(value.description, 'answer') ||
      !isCandidateFreeProSystemAudioSdp(value.description.sdp)
    ) {
      return null;
    }
    return {
      ...base,
      kind: 'answer',
      direction: 'subscriber',
      phase: value.phase,
      description: { type: 'answer', sdp: value.description.sdp },
    };
  }

  if (value.kind === 'candidate') {
    if (!hasExactObjectKeys(value, [...PRO_SYSTEM_AUDIO_SIGNAL_COMMON_KEYS, 'candidate'])) {
      return null;
    }
    const candidate = normalizeProSystemAudioCandidate(value.candidate);
    return candidate ? { ...base, kind: 'candidate', candidate } : null;
  }

  if (value.kind === 'close') {
    if (
      !hasExactObjectKeys(value, [...PRO_SYSTEM_AUDIO_SIGNAL_COMMON_KEYS, 'reason']) ||
      (value.reason !== 'stopped' && value.reason !== 'fallback' && value.reason !== 'superseded')
    ) {
      return null;
    }
    return { ...base, kind: 'close', reason: value.reason };
  }

  return null;
}

export function normalizeProRealtimeFrame(value: unknown): NormalizedProRealtimeFrame | null {
  if (
    !hasExactObjectKeys(value, ['type', 'version', 'eventId', 'channel', 'payload']) ||
    value.type !== 'pro-realtime' ||
    value.version !== 1 ||
    typeof value.eventId !== 'string' ||
    !PRO_REALTIME_EVENT_ID_RE.test(value.eventId) ||
    !isUnknownRecord(value.payload)
  ) {
    return null;
  }

  if (value.channel === 'chat') {
    const payload = normalizeProChatPayload(value.payload);
    if (!payload) return null;
    return {
      type: 'pro-realtime',
      version: 1,
      eventId: value.eventId,
      channel: 'chat',
      payload,
    };
  }
  if (value.channel === 'presence') {
    if (
      !hasExactObjectKeys(value.payload, ['state']) ||
      (value.payload.state !== 'active' && value.payload.state !== 'away')
    ) {
      return null;
    }
    return {
      type: 'pro-realtime',
      version: 1,
      eventId: value.eventId,
      channel: 'presence',
      payload: { state: value.payload.state },
    };
  }
  if (value.channel === 'control-ready') {
    if (
      !hasExactObjectKeys(value.payload, ['commandId', 'sequence', 'ready']) ||
      typeof value.payload.commandId !== 'string' ||
      !PRO_REALTIME_COMMAND_ID_RE.test(value.payload.commandId) ||
      typeof value.payload.sequence !== 'number' ||
      !Number.isSafeInteger(value.payload.sequence) ||
      value.payload.sequence < 0 ||
      typeof value.payload.ready !== 'boolean'
    ) {
      return null;
    }
    return {
      type: 'pro-realtime',
      version: 1,
      eventId: value.eventId,
      channel: 'control-ready',
      payload: {
        commandId: value.payload.commandId,
        sequence: value.payload.sequence,
        ready: value.payload.ready,
      },
    };
  }
  if (value.channel === 'clock') {
    if (
      !hasExactObjectKeys(value.payload, ['requestId', 'clientSentAtMs']) ||
      typeof value.payload.requestId !== 'number' ||
      !Number.isSafeInteger(value.payload.requestId) ||
      value.payload.requestId < 0 ||
      typeof value.payload.clientSentAtMs !== 'number' ||
      !Number.isFinite(value.payload.clientSentAtMs) ||
      value.payload.clientSentAtMs < 0 ||
      value.payload.clientSentAtMs > Number.MAX_SAFE_INTEGER
    ) {
      return null;
    }
    return {
      type: 'pro-realtime',
      version: 1,
      eventId: value.eventId,
      channel: 'clock',
      payload: {
        requestId: value.payload.requestId,
        clientSentAtMs: value.payload.clientSentAtMs,
      },
    };
  }
  if (value.channel === 'system-audio-signal') {
    const payload = normalizeProSystemAudioSignalPayload(value.payload);
    if (!payload) return null;
    return {
      type: 'pro-realtime',
      version: 1,
      eventId: value.eventId,
      channel: 'system-audio-signal',
      payload,
    };
  }
  return null;
}

function isValidSdp<Type extends 'offer' | 'answer'>(
  value: unknown,
  expectedType: Type,
): value is { type: Type; sdp: string } {
  if (!isUnknownRecord(value) || value.type !== expectedType || typeof value.sdp !== 'string') {
    return false;
  }
  const bytes = utf8ByteLength(value.sdp);
  return bytes !== null && bytes <= SDP_MAX_BYTES;
}

function isOversizedSdp(value: unknown): boolean {
  if (!isUnknownRecord(value) || typeof value.sdp !== 'string') return false;
  const bytes = utf8ByteLength(value.sdp);
  return bytes !== null && bytes > SDP_MAX_BYTES;
}

function isValidIceCandidate(
  value: unknown,
): value is Record<string, unknown> & { candidate: string } {
  if (!isUnknownRecord(value) || typeof value.candidate !== 'string') return false;
  const candidateBytes = utf8ByteLength(JSON.stringify(value));
  if (candidateBytes === null || candidateBytes > ICE_CANDIDATE_MAX_BYTES) return false;
  if (value.sdpMid !== undefined && value.sdpMid !== null && typeof value.sdpMid !== 'string') {
    return false;
  }
  if (
    value.sdpMLineIndex !== undefined &&
    value.sdpMLineIndex !== null &&
    (typeof value.sdpMLineIndex !== 'number' ||
      !Number.isInteger(value.sdpMLineIndex) ||
      value.sdpMLineIndex < 0)
  ) {
    return false;
  }
  if (
    value.usernameFragment !== undefined &&
    value.usernameFragment !== null &&
    typeof value.usernameFragment !== 'string'
  ) {
    return false;
  }
  return true;
}

function isOversizedIceCandidate(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false;
  const bytes = utf8ByteLength(JSON.stringify(value));
  return bytes !== null && bytes > ICE_CANDIDATE_MAX_BYTES;
}
export function validateIncomingMessage(message: unknown, role: string): IncomingMessageValidation {
  if (!isUnknownRecord(message) || typeof message.type !== 'string' || message.type.length > 64) {
    return 'ignore';
  }
  if (role === 'host-pending') {
    const hasDesiredPassword = Object.prototype.hasOwnProperty.call(message, 'desiredRoomPassword');
    const hasPinMutationId = Object.prototype.hasOwnProperty.call(message, 'pinMutationId');
    return hasExactObjectKeys(
      message,
      ['type', 'secret'],
      ['accountAssertion', 'desiredRoomPassword', 'pinMutationId'],
    ) &&
      message.type === 'host-auth' &&
      isPeerId(message.secret) &&
      (message.accountAssertion === undefined ||
        (typeof message.accountAssertion === 'string' &&
          message.accountAssertion.length <= 2048)) &&
      hasDesiredPassword === hasPinMutationId &&
      (!hasDesiredPassword ||
        ((message.desiredRoomPassword === '' ||
          (typeof message.desiredRoomPassword === 'string' &&
            /^\d{8}$/.test(message.desiredRoomPassword))) &&
          typeof message.pinMutationId === 'string' &&
          STANDARD_ROOM_PIN_MUTATION_ID_RE.test(message.pinMutationId)))
      ? 'valid'
      : 'ignore';
  }
  if (role === 'pending') {
    if (message.type !== 'guest-auth') return 'ignore';
    if (typeof message.password !== 'string') return 'ignore';
    if (
      message.accountAssertion !== undefined &&
      (typeof message.accountAssertion !== 'string' || message.accountAssertion.length > 2048)
    ) {
      return 'ignore';
    }
    if (!isValidGuestReconnectSecret(message.reconnectSecret)) {
      return 'ignore';
    }
    return 'valid';
  }
  if (role === 'guest') {
    // Repeated guest-auth after admission is intentionally harmless.
    if (message.type === 'guest-auth') return 'ignore';
    if (message.type === 'account-identity-refresh') {
      return hasExactObjectKeys(message, ['type', 'accountAssertion']) &&
        typeof message.accountAssertion === 'string' &&
        message.accountAssertion.length <= 2048
        ? 'valid'
        : 'ignore';
    }
    if (message.type === 'account-identity-clear') {
      return hasExactObjectKeys(message, ['type']) ? 'valid' : 'ignore';
    }
    if (message.type === 'account-identity-delete') {
      return hasExactObjectKeys(message, ['type', 'deletionAssertion']) &&
        typeof message.deletionAssertion === 'string' &&
        message.deletionAssertion.length <= 2048
        ? 'valid'
        : 'ignore';
    }
    if (message.to !== 'host') return 'ignore';
    if (message.type === 'signal-offer') {
      if (isOversizedSdp(message.sdp)) return 'oversized';
      return isValidSdp(message.sdp, 'offer') && hasValidNegotiationId(message)
        ? 'valid'
        : 'ignore';
    }
    if (message.type === 'signal-candidate') {
      if (isOversizedIceCandidate(message.candidate)) return 'oversized';
      return isValidIceCandidate(message.candidate) && hasValidNegotiationId(message)
        ? 'valid'
        : 'ignore';
    }
    if (message.type === 'media-answer') {
      if (isOversizedSdp(message.sdp)) return 'oversized';
      return isPeerId(message.callId) &&
        isValidSdp(message.sdp, 'answer') &&
        hasValidNegotiationId(message)
        ? 'valid'
        : 'ignore';
    }
    if (message.type === 'media-close') {
      return isPeerId(message.callId) ? 'valid' : 'ignore';
    }
    return 'ignore';
  }

  if (role !== 'host') return 'ignore';
  if (message.type === 'account-identity-refresh') {
    return hasExactObjectKeys(message, ['type', 'accountAssertion']) &&
      typeof message.accountAssertion === 'string' &&
      message.accountAssertion.length <= 2048
      ? 'valid'
      : 'ignore';
  }
  if (message.type === 'account-identity-clear') {
    return hasExactObjectKeys(message, ['type']) ? 'valid' : 'ignore';
  }
  if (message.type === 'account-identity-delete') {
    return hasExactObjectKeys(message, ['type', 'deletionAssertion']) &&
      typeof message.deletionAssertion === 'string' &&
      message.deletionAssertion.length <= 2048
      ? 'valid'
      : 'ignore';
  }
  if (message.type === 'room-password-set') {
    return hasExactObjectKeys(message, ['type', 'password'], ['pinMutationId']) &&
      (message.password === '' ||
        (typeof message.password === 'string' && /^\d{8}$/.test(message.password))) &&
      (message.pinMutationId === undefined ||
        (typeof message.pinMutationId === 'string' &&
          STANDARD_ROOM_PIN_MUTATION_ID_RE.test(message.pinMutationId)))
      ? 'valid'
      : 'ignore';
  }
  if (message.type === 'remote-share-upload-assertion-request') {
    return hasExactObjectKeys(message, [
      'type',
      'correlationId',
      'actorId',
      'requestId',
      'sessionId',
      'queueItemId',
      'size',
      'bodySha256',
    ]) &&
      typeof message.correlationId === 'string' &&
      REMOTE_SHARE_UPLOAD_ASSERTION_CORRELATION_ID_RE.test(message.correlationId) &&
      typeof message.actorId === 'string' &&
      REMOTE_SHARE_UPLOAD_ASSERTION_ACTOR_ID_RE.test(message.actorId) &&
      typeof message.requestId === 'string' &&
      REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST_ID_RE.test(message.requestId) &&
      typeof message.sessionId === 'number' &&
      Number.isSafeInteger(message.sessionId) &&
      message.sessionId > 0 &&
      typeof message.queueItemId === 'string' &&
      REMOTE_SHARE_UPLOAD_ASSERTION_QUEUE_ITEM_ID_RE.test(message.queueItemId) &&
      typeof message.size === 'number' &&
      Number.isSafeInteger(message.size) &&
      message.size > 0 &&
      message.size <= REMOTE_SHARE_MAX_BYTES &&
      typeof message.bodySha256 === 'string' &&
      REMOTE_SHARE_UPLOAD_ASSERTION_BODY_SHA256_RE.test(message.bodySha256)
      ? 'valid'
      : 'ignore';
  }
  if (!isPeerId(message.to)) return 'ignore';
  if (message.type === 'signal-answer') {
    if (isOversizedSdp(message.sdp)) return 'oversized';
    return isValidSdp(message.sdp, 'answer') && hasValidNegotiationId(message) ? 'valid' : 'ignore';
  }
  if (message.type === 'signal-candidate') {
    if (isOversizedIceCandidate(message.candidate)) return 'oversized';
    return isValidIceCandidate(message.candidate) && hasValidNegotiationId(message)
      ? 'valid'
      : 'ignore';
  }
  if (message.type === 'media-offer') {
    if (isOversizedSdp(message.sdp)) return 'oversized';
    return isPeerId(message.callId) &&
      isValidSdp(message.sdp, 'offer') &&
      hasValidNegotiationId(message)
      ? 'valid'
      : 'ignore';
  }
  if (message.type === 'media-close') {
    return isPeerId(message.callId) ? 'valid' : 'ignore';
  }
  return 'ignore';
}

export function isStandardRoomIdentityMutation(message: unknown): boolean {
  return (
    isUnknownRecord(message) &&
    (message.type === 'account-identity-refresh' ||
      message.type === 'account-identity-clear' ||
      message.type === 'account-identity-delete')
  );
}
