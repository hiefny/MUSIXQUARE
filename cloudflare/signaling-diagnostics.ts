/** Error-only diagnostics. Never serialize thrown values or request/socket data. */
export type SignalingObjectKind = 'worker' | 'room' | 'http_bridge' | 'rate_limit';
export type SignalingOperation =
  | 'fetch'
  | 'alarm'
  | 'webSocketMessage'
  | 'webSocketClose'
  | 'webSocketError'
  | 'initialize'
  | 'metrics_write'
  | 'metrics_background'
  | 'maintenance_alarm'
  | 'closed_socket_cleanup'
  | 'bridge_message'
  | 'bridge_close'
  | 'bridge_error'
  | 'bridge_oversized_cleanup';

interface DiagnosticContext {
  readonly objectKind: SignalingObjectKind;
  readonly operation: SignalingOperation;
  readonly disposition: 'propagated' | 'handled' | 'background_registration';
}

const ERROR_TYPES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'AggregateError',
  'DOMException',
  'AbortError',
  'TimeoutError',
]);
const ERROR_CODES = new Set([
  'INVALID_PRO_ROOM_GENERATION',
  'INVALID_PRO_ROOM_GENERATION_RECORD',
  'STANDARD_ROOM_PIN_QUARANTINE_LOCK_UNAVAILABLE',
  'WEBSOCKET_PAIR_UNAVAILABLE',
  'INVALID_PRO_OWNER_ACCOUNT_DELETION_FENCE',
  'INVALID_PRO_ROOM_META',
  'INVALID_PRO_CHAT_CONTROL_STATE',
  'INVALID_PRO_BOT_REQUEST_PROOFS',
  'PRO_SIGNALING_TICKET_LEDGER_GENERATION_MISMATCH',
  'INVALID_PRO_SIGNALING_TICKET_LEDGER',
  'PRO_SIGNALING_TICKET_LEDGER_FULL',
  'PRO_SIGNALING_PARTICIPANT_HIGH_WATER_GENERATION_MISMATCH',
  'INVALID_PRO_SIGNALING_PARTICIPANT_HIGH_WATER',
  'PRO_SIGNALING_ATTACHMENT_GENERATION_MISMATCH',
  'PRO_SIGNALING_PARTICIPANT_HIGH_WATER_FULL',
  'PRO_SIGNALING_PRESENCE_AUTHORITY_GENERATION_MISMATCH',
  'INVALID_PRO_SIGNALING_PRESENCE_AUTHORITY',
  'PRO_SIGNALING_ROOM_META_GENERATION_MISMATCH',
  'STANDARD_ROOM_META_FUTURE_VERSION',
  'STANDARD_ROOM_GUEST_BINDINGS_FUTURE_VERSION',
  'STANDARD_ROOM_GUEST_BINDINGS_INVALID',
  'STANDARD_WS_RATE_STATE_INVALID',
  'STANDARD_ROOM_PIN_PEPPER_UNAVAILABLE',
]);

function property(value: unknown, key: string): unknown {
  try {
    return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  } catch {
    return undefined;
  }
}

function summarizeError(error: unknown) {
  const name = property(error, 'name');
  const message = property(error, 'message');
  const stack = property(error, 'stack');
  // Keep only coordinates in known bundled/source modules, never the first
  // stack line, function names, arbitrary filenames, URLs, or exception text.
  const locations: string[] = [];
  if (typeof stack === 'string') {
    for (const line of stack.slice(0, 8192).split('\n').slice(1, 17)) {
      const match =
        /^\s+at (?:[^\r\n]* \()?((?:signaling-worker|signaling-diagnostics|service-maintenance|pro-room-generation|standard-room-account-assertion|remote-share-upload-assertion)\.(?:js|ts):[1-9]\d{0,6}:[1-9]\d{0,5})\)?$/.exec(
          line,
        );
      if (match?.[1] && !locations.includes(match[1])) locations.push(match[1]);
      if (locations.length === 5) break;
    }
  }
  return {
    errorType: typeof name === 'string' && ERROR_TYPES.has(name) ? name : 'unknown',
    errorCode: typeof message === 'string' && ERROR_CODES.has(message) ? message : 'unknown',
    retryable: property(error, 'retryable') === true,
    overloaded: property(error, 'overloaded') === true,
    remote: property(error, 'remote') === true,
    locations,
  };
}

export function reportSignalingFailure(
  env: { readonly CF_VERSION_METADATA?: unknown },
  context: DiagnosticContext,
  error: unknown,
): void {
  try {
    const version = property(env.CF_VERSION_METADATA, 'id');
    const versionId =
      typeof version === 'string' &&
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(version)
        ? version
        : 'unknown';
    // Aggregate members are bounded and summarized independently; do not log
    // their messages/causes. Multiple records can describe one propagated fault.
    const errors = property(error, 'errors');
    const related: ReturnType<typeof summarizeError>[] = [];
    if (Array.isArray(errors)) {
      const length = property(errors, 'length');
      const count = typeof length === 'number' ? Math.min(2, length) : 0;
      for (let index = 0; index < count; index += 1) {
        related.push(summarizeError(property(errors, String(index))));
      }
    }
    console.error('[SignalingDiagnostic]', {
      schema: 1,
      ...context,
      versionId,
      ...summarizeError(error),
      related,
    });
  } catch {
    // Diagnostics must never replace the original rejection or break cleanup.
  }
}

export async function observeSignalingFailure<T>(
  env: { readonly CF_VERSION_METADATA?: unknown },
  objectKind: SignalingObjectKind,
  operation: SignalingOperation,
  task: () => Promise<T>,
): Promise<T> {
  try {
    // Invoke synchronously: WebSocket auth/PIN ingress claims precede any await.
    return await task();
  } catch (error) {
    reportSignalingFailure(env, { objectKind, operation, disposition: 'propagated' }, error);
    throw error;
  }
}
