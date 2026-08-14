const PRO_SIGNALING_WEBSOCKET_PROTOCOL = 'mxqr.pro-signaling.v1';
const PRO_SIGNALING_TICKET_PROTOCOL_PREFIX = 'mxqr.ticket.';
export const PRO_SIGNALING_CLIENT_UPDATE_REQUIRED = 'PRO_SIGNALING_CLIENT_UPDATE_REQUIRED';

const PRO_SIGNALING_TICKET_RE = /^[A-Za-z0-9_-]{1,3072}\.[A-Za-z0-9_-]{43}$/;

/**
 * Browser WebSocket APIs cannot set an Authorization header. Offer the short-
 * lived bearer as a non-selected protocol token so it stays out of request
 * URLs; the server selects only the stable protocol marker in its 101 reply.
 */
export function proSignalingWebSocketProtocols(ticket: string): [string, string] {
  if (ticket.length > 4096 || !PRO_SIGNALING_TICKET_RE.test(ticket)) {
    throw new Error('INVALID_PRO_SIGNALING_TICKET');
  }
  return [PRO_SIGNALING_WEBSOCKET_PROTOCOL, `${PRO_SIGNALING_TICKET_PROTOCOL_PREFIX}${ticket}`];
}

export function isProSignalingClientUpdateRequired(error: unknown): boolean {
  return error instanceof Error && error.message === PRO_SIGNALING_CLIENT_UPDATE_REQUIRED;
}
