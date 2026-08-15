// Pure wire-protocol validation for standard signaling and PRO realtime frames.
// Durable Object storage and WebSocket lifecycle state stay in signaling-worker.js.
export const WS_MESSAGE_MAX_BYTES = 64 * 1024;
export const PRO_REALTIME_BODY_MAX_BYTES = 8 * 1024;
export const PRO_CHAT_SLOWMODE_MAX_SECONDS = 60;
export const MAX_PRO_ROOM_MEMBERS = 100;
export const PRO_REALTIME_EVENT_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
export const PRO_PRESENCE_INCARNATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
export const PRO_CHAT_MODERATION_KINDS = new Set(['clear', 'freeze', 'filter', 'slowmode', 'mute']);

const SDP_MAX_BYTES = 48 * 1024;
const ICE_CANDIDATE_MAX_BYTES = 4 * 1024;
const PRO_SERVER_EVENT_MAX_BYTES = 3 * 1024;
const PRO_REALTIME_TEXT_MAX_LENGTH = 500;
const PRO_REALTIME_COMMAND_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
const PRO_SERVER_EVENT_TYPES = new Set([
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

export function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function hasExactKeys(value, required, optional = []) {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

export function isValidPeerId(peerId) {
  return typeof peerId === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(peerId);
}

function hasValidNegotiationId(message) {
  return (
    typeof message.negotiationId === 'string' &&
    /^[A-Za-z0-9_-]{16,64}$/.test(message.negotiationId)
  );
}

function isValidGuestReconnectSecret(secret) {
  return typeof secret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(secret);
}

function utf8ByteLength(value) {
  if (typeof value !== 'string') return null;
  return new TextEncoder().encode(value).byteLength;
}

export function rawMessageByteLength(raw) {
  if (typeof raw === 'string') {
    // UTF-8 is never shorter than the JavaScript code-unit length, so avoid
    // allocating a second huge buffer once the limit is already exceeded.
    if (raw.length > WS_MESSAGE_MAX_BYTES) return raw.length;
    return utf8ByteLength(raw);
  }
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return null;
}

function normalizeBoundedJson(value, depth = 0, budget = { keys: 0, values: 0 }) {
  if (depth > 4 || budget.values >= 256) return undefined;
  budget.values += 1;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : undefined;
  }
  if (typeof value === 'string') return value.length <= 2048 ? value : undefined;
  if (Array.isArray(value)) {
    if (value.length > 100) return undefined;
    const result = [];
    for (const item of value) {
      const normalized = normalizeBoundedJson(item, depth + 1, budget);
      if (normalized === undefined) return undefined;
      result.push(normalized);
    }
    return result;
  }
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (budget.keys + keys.length > 32) return undefined;
  const result = {};
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

export function normalizeProServerEvent(value) {
  if (!isRecord(value) || !PRO_SERVER_EVENT_TYPES.has(value.type)) return null;
  const normalized = normalizeBoundedJson(value);
  if (!isRecord(normalized) || normalized.type !== value.type) return null;
  if (
    normalized.type === 'pro-presence-snapshot' &&
    (!Number.isSafeInteger(normalized.presenceRevision) || normalized.presenceRevision < 0)
  ) {
    return null;
  }
  const bytes = utf8ByteLength(JSON.stringify(normalized));
  return bytes !== null && bytes <= PRO_SERVER_EVENT_MAX_BYTES ? normalized : null;
}

export function normalizeProBroadcastTargets(value) {
  if (!Array.isArray(value) || value.length > MAX_PRO_ROOM_MEMBERS) return null;
  const seen = new Set();
  const targets = [];
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

function normalizeProBotResult(value) {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'answer') {
    return hasExactKeys(value, ['kind', 'text']) &&
      typeof value.text === 'string' &&
      value.text.trim().length > 0 &&
      value.text.length <= PRO_REALTIME_TEXT_MAX_LENGTH
      ? { kind: 'answer', text: value.text.trim() }
      : null;
  }
  if (value.kind === 'added') {
    return hasExactKeys(value, ['kind', 'count', 'playbackChanged']) &&
      Number.isSafeInteger(value.count) &&
      value.count >= 1 &&
      value.count <= 3 &&
      typeof value.playbackChanged === 'boolean'
      ? { kind: 'added', count: value.count, playbackChanged: value.playbackChanged }
      : null;
  }
  if (value.kind === 'failed') return hasExactKeys(value, ['kind']) ? { kind: 'failed' } : null;
  if (value.kind === 'rate_limited') {
    return hasExactKeys(value, ['kind', 'retryAfterSeconds']) &&
      Number.isSafeInteger(value.retryAfterSeconds) &&
      value.retryAfterSeconds >= 1 &&
      value.retryAfterSeconds <= 24 * 60 * 60
      ? { kind: 'rate_limited', retryAfterSeconds: value.retryAfterSeconds }
      : null;
  }
  return null;
}

const PRO_SYSTEM_MESSAGE_KEYS_WITHOUT_PARAMS = new Set([
  'chat.decode_skip_system_message',
  'chat.system_audio_started_system_message',
  'chat.system_audio_stopped_system_message',
]);

function normalizeProSystemMessage(value) {
  if (
    !hasExactKeys(value, ['kind', 'text', 'i18nKey'], ['i18nParams']) ||
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

function isProBotCommandText(value) {
  if (typeof value !== 'string') return false;
  const explicit = /^\/bot(?:\s+)([\s\S]+)$/i.exec(value);
  const compact = explicit ? null : /^\/\/(?!\/)([\s\S]+)$/.exec(value);
  return !!(explicit?.[1] ?? compact?.[1] ?? '').trim();
}

function normalizeProChatPayload(value) {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'message') {
    if (
      !hasExactKeys(value, ['kind', 'text', 'clientTs'], ['botRequestId']) ||
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
    return hasExactKeys(value, ['kind', 'requestId', 'result']) &&
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
    return hasExactKeys(value, ['kind', 'text']) &&
      typeof value.text === 'string' &&
      value.text.trim() &&
      value.text.length <= PRO_REALTIME_TEXT_MAX_LENGTH
      ? { kind: 'notice', text: value.text }
      : null;
  }
  if (value.kind === 'clear') return hasExactKeys(value, ['kind']) ? { kind: 'clear' } : null;
  if (value.kind === 'freeze' || value.kind === 'filter') {
    return hasExactKeys(value, ['kind', 'on']) && typeof value.on === 'boolean'
      ? { kind: value.kind, on: value.on }
      : null;
  }
  if (value.kind === 'slowmode') {
    return hasExactKeys(value, ['kind', 'seconds']) &&
      Number.isSafeInteger(value.seconds) &&
      value.seconds >= 0 &&
      value.seconds <= PRO_CHAT_SLOWMODE_MAX_SECONDS
      ? { kind: 'slowmode', seconds: value.seconds }
      : null;
  }
  if (value.kind === 'mute') {
    return hasExactKeys(value, ['kind', 'targetParticipantId', 'on']) &&
      isValidPeerId(value.targetParticipantId) &&
      typeof value.on === 'boolean'
      ? { kind: 'mute', targetParticipantId: value.targetParticipantId, on: value.on }
      : null;
  }
  if (value.kind === 'whisper') {
    return hasExactKeys(value, ['kind', 'targetParticipantId', 'text']) &&
      isValidPeerId(value.targetParticipantId) &&
      typeof value.text === 'string' &&
      value.text.trim() &&
      value.text.length <= PRO_REALTIME_TEXT_MAX_LENGTH
      ? { kind: 'whisper', targetParticipantId: value.targetParticipantId, text: value.text }
      : null;
  }
  return null;
}

export function normalizeProRealtimeFrame(value) {
  if (
    !hasExactKeys(value, ['type', 'version', 'eventId', 'channel', 'payload']) ||
    value.type !== 'pro-realtime' ||
    value.version !== 1 ||
    typeof value.eventId !== 'string' ||
    !PRO_REALTIME_EVENT_ID_RE.test(value.eventId) ||
    !isRecord(value.payload)
  ) {
    return null;
  }

  let payload = null;
  if (value.channel === 'chat') {
    payload = normalizeProChatPayload(value.payload);
    if (!payload) return null;
  } else if (value.channel === 'presence') {
    if (
      !hasExactKeys(value.payload, ['state']) ||
      (value.payload.state !== 'active' && value.payload.state !== 'away')
    ) {
      return null;
    }
    payload = { state: value.payload.state };
  } else if (value.channel === 'control-ready') {
    if (
      !hasExactKeys(value.payload, ['commandId', 'sequence', 'ready']) ||
      typeof value.payload.commandId !== 'string' ||
      !PRO_REALTIME_COMMAND_ID_RE.test(value.payload.commandId) ||
      !Number.isSafeInteger(value.payload.sequence) ||
      value.payload.sequence < 0 ||
      typeof value.payload.ready !== 'boolean'
    ) {
      return null;
    }
    payload = {
      commandId: value.payload.commandId,
      sequence: value.payload.sequence,
      ready: value.payload.ready,
    };
  } else if (value.channel === 'clock') {
    if (
      !hasExactKeys(value.payload, ['requestId', 'clientSentAtMs']) ||
      !Number.isSafeInteger(value.payload.requestId) ||
      value.payload.requestId < 0 ||
      typeof value.payload.clientSentAtMs !== 'number' ||
      !Number.isFinite(value.payload.clientSentAtMs) ||
      value.payload.clientSentAtMs < 0 ||
      value.payload.clientSentAtMs > Number.MAX_SAFE_INTEGER
    ) {
      return null;
    }
    payload = {
      requestId: value.payload.requestId,
      clientSentAtMs: value.payload.clientSentAtMs,
    };
  } else {
    return null;
  }

  return {
    type: 'pro-realtime',
    version: 1,
    eventId: value.eventId,
    channel: value.channel,
    payload,
  };
}

function isValidSdp(value, expectedType) {
  if (!isRecord(value) || value.type !== expectedType || typeof value.sdp !== 'string') {
    return false;
  }
  const bytes = utf8ByteLength(value.sdp);
  return bytes !== null && bytes <= SDP_MAX_BYTES;
}

function isOversizedSdp(value) {
  if (!isRecord(value) || typeof value.sdp !== 'string') return false;
  const bytes = utf8ByteLength(value.sdp);
  return bytes !== null && bytes > SDP_MAX_BYTES;
}

function isValidIceCandidate(value) {
  if (!isRecord(value) || typeof value.candidate !== 'string') return false;
  const candidateBytes = utf8ByteLength(JSON.stringify(value));
  if (candidateBytes === null || candidateBytes > ICE_CANDIDATE_MAX_BYTES) return false;
  if (value.sdpMid !== undefined && value.sdpMid !== null && typeof value.sdpMid !== 'string') {
    return false;
  }
  if (
    value.sdpMLineIndex !== undefined &&
    value.sdpMLineIndex !== null &&
    (!Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0)
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

function isOversizedIceCandidate(value) {
  if (!isRecord(value)) return false;
  const bytes = utf8ByteLength(JSON.stringify(value));
  return bytes !== null && bytes > ICE_CANDIDATE_MAX_BYTES;
}

export function validateIncomingMessage(message, role) {
  if (!isRecord(message) || typeof message.type !== 'string' || message.type.length > 64) {
    return 'ignore';
  }

  if (role === 'host-pending') {
    return hasExactKeys(message, ['type', 'secret'], ['accountAssertion']) &&
      message.type === 'host-auth' &&
      isValidPeerId(message.secret) &&
      (message.accountAssertion === undefined ||
        (typeof message.accountAssertion === 'string' && message.accountAssertion.length <= 2048))
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
    // The current client sends this on every guest socket, including rooms
    // without a password. Once the guest is admitted it is intentionally a
    // harmless no-op after admission.
    if (message.type === 'guest-auth') return 'ignore';
    if (message.type === 'account-identity-refresh') {
      return hasExactKeys(message, ['type', 'accountAssertion']) &&
        typeof message.accountAssertion === 'string' &&
        message.accountAssertion.length <= 2048
        ? 'valid'
        : 'ignore';
    }
    if (message.type === 'account-identity-clear') {
      return hasExactKeys(message, ['type']) ? 'valid' : 'ignore';
    }
    if (message.type === 'account-identity-delete') {
      return hasExactKeys(message, ['type', 'deletionAssertion']) &&
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
      return isValidPeerId(message.callId) &&
        isValidSdp(message.sdp, 'answer') &&
        hasValidNegotiationId(message)
        ? 'valid'
        : 'ignore';
    }
    if (message.type === 'media-close') {
      return isValidPeerId(message.callId) ? 'valid' : 'ignore';
    }
    return 'ignore';
  }

  if (role !== 'host') return 'ignore';
  if (message.type === 'account-identity-refresh') {
    return hasExactKeys(message, ['type', 'accountAssertion']) &&
      typeof message.accountAssertion === 'string' &&
      message.accountAssertion.length <= 2048
      ? 'valid'
      : 'ignore';
  }
  if (message.type === 'account-identity-clear') {
    return hasExactKeys(message, ['type']) ? 'valid' : 'ignore';
  }
  if (message.type === 'account-identity-delete') {
    return hasExactKeys(message, ['type', 'deletionAssertion']) &&
      typeof message.deletionAssertion === 'string' &&
      message.deletionAssertion.length <= 2048
      ? 'valid'
      : 'ignore';
  }
  if (message.type === 'room-password-set') {
    return typeof message.password === 'string' ? 'valid' : 'ignore';
  }
  if (message.type === 'remote-share-upload-assertion-request') {
    return hasExactKeys(message, [
      'type',
      'correlationId',
      'actorId',
      'requestId',
      'sessionId',
      'queueItemId',
      'size',
      'bodySha256',
    ]) &&
      REMOTE_SHARE_UPLOAD_ASSERTION_CORRELATION_ID_RE.test(message.correlationId || '') &&
      REMOTE_SHARE_UPLOAD_ASSERTION_ACTOR_ID_RE.test(message.actorId || '') &&
      REMOTE_SHARE_UPLOAD_ASSERTION_REQUEST_ID_RE.test(message.requestId || '') &&
      Number.isSafeInteger(message.sessionId) &&
      message.sessionId > 0 &&
      REMOTE_SHARE_UPLOAD_ASSERTION_QUEUE_ITEM_ID_RE.test(message.queueItemId || '') &&
      Number.isSafeInteger(message.size) &&
      message.size > 0 &&
      message.size <= REMOTE_SHARE_MAX_BYTES &&
      REMOTE_SHARE_UPLOAD_ASSERTION_BODY_SHA256_RE.test(message.bodySha256 || '')
      ? 'valid'
      : 'ignore';
  }
  if (!isValidPeerId(message.to)) return 'ignore';
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
    return isValidPeerId(message.callId) &&
      isValidSdp(message.sdp, 'offer') &&
      hasValidNegotiationId(message)
      ? 'valid'
      : 'ignore';
  }
  if (message.type === 'media-close') {
    return isValidPeerId(message.callId) ? 'valid' : 'ignore';
  }
  return 'ignore';
}

export function isStandardRoomIdentityMutation(message) {
  return (
    isRecord(message) &&
    (message.type === 'account-identity-refresh' ||
      message.type === 'account-identity-clear' ||
      message.type === 'account-identity-delete')
  );
}
