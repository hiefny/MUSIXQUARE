/**
 * Claims a Standard room code as a status probe before a status check's test
 * host connects. The claim goes to that code's signaling room object over the
 * App's Durable Object binding; the room object owns the claim and its
 * lifetime. While the claim holds, the next new room on that code records
 * status_probe_room_opened and status_probe_guest_joined instead of the
 * counted room_opened and guest_joined, so monitor rooms never reach the
 * public room count.
 *
 * The App passes in its bounded service-binding fetch, so this module adds no
 * timer of its own. Only the documented answers count; anything else, or no
 * answer, is `failed`, and a caller opens no room unless the outcome is
 * `claimed`. Every 409 refuses that code only (`room_active`), whatever its
 * body: the room object answers ROOM_ACTIVE for a room in use and
 * ROOM_STATE_INVALID for a quarantined room or an object that belongs to
 * another code, and the caller tries another code either way. A signaling
 * Worker without the route answers 404 (`unsupported`).
 */

import {
  STATUS_PROBE_CLAIM_INTERNAL_PATH,
  type StatusProbeClaimOutcome,
} from './status-contract.ts';

/** Largest claim answer the App's bounded fetch should read; every documented answer is far smaller. */
export const STATUS_PROBE_CLAIM_REPLY_MAX_BYTES = 4_096;

const STATUS_PROBE_ROOM_ID_RE = /^[1-9][0-9]{5}$/u;
const STATUS_PROBE_CLAIM_URL = `https://signaling.internal${STATUS_PROBE_CLAIM_INTERNAL_PATH}`;

/** The part of the signaling room namespace a claim uses. */
export interface StatusProbeClaimNamespace<Id, Stub> {
  idFromName(name: string): Id;
  get(id: Id): Stub;
}

/** A bounded answer: the status and the body bytes that were read. */
export interface StatusProbeClaimReply {
  readonly response: { readonly status: number };
  readonly bytes: Uint8Array;
}

export interface StatusProbeClaimOptions<Id, Stub> {
  /** The signaling room namespace (PRO_SIGNALING_ROOMS), or null when it is not bound. */
  readonly namespace: StatusProbeClaimNamespace<Id, Stub> | null;
  readonly roomId: string;
  /** Sends the request to the room object with the App's response and body bounds. */
  readonly fetchBounded: (stub: Stub, request: Request) => Promise<StatusProbeClaimReply | null>;
}

function replyJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Maps a claim answer (or none) to its outcome. */
export function classifyStatusProbeClaimReply(
  reply: StatusProbeClaimReply | null,
): StatusProbeClaimOutcome {
  if (!reply) return 'failed';
  const status = reply.response.status;
  if (status === 404) return 'unsupported';
  // A refusal of this code only, never of the probe: another code may claim.
  if (status === 409) return 'room_active';
  const body = replyJson(reply.bytes);
  if (status === 200 && body?.ok === true) return 'claimed';
  if (status === 503 && body?.error === 'SERVICE_MAINTENANCE') return 'maintenance';
  if (status === 503 && body?.error === 'SERVICE_MAINTENANCE_STATUS_UNAVAILABLE') {
    return 'control_unavailable';
  }
  return 'failed';
}

/**
 * Asks the room object of roomId to mark its next new room as a status probe.
 * A code that is not a Standard room code (a digit 1-9 and five digits) fails
 * without any call.
 */
export async function claimStatusProbeRoom<Id, Stub>({
  namespace,
  roomId,
  fetchBounded,
}: StatusProbeClaimOptions<Id, Stub>): Promise<StatusProbeClaimOutcome> {
  if (typeof roomId !== 'string' || !STATUS_PROBE_ROOM_ID_RE.test(roomId) || !namespace) {
    return 'failed';
  }
  try {
    const stub = namespace.get(namespace.idFromName(roomId));
    const reply = await fetchBounded(
      stub,
      new Request(STATUS_PROBE_CLAIM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 1, roomId }),
      }),
    );
    return classifyStatusProbeClaimReply(reply);
  } catch {
    return 'failed';
  }
}
