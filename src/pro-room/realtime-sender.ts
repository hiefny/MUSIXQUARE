/** Synchronous send port; the deferred PRO transport owns connection and wire checks. */

type RealtimeSender = (
  channel: 'chat' | 'presence' | 'control-ready' | 'system-audio-signal',
  payload: Record<string, unknown>,
) => boolean;

let sender: RealtimeSender | null = null;

export function bindProRoomRealtimeSender(transport: RealtimeSender): void {
  sender = transport;
}

export function sendProRoomRealtime(
  channel: Parameters<RealtimeSender>[0],
  payload: Record<string, unknown>,
): boolean {
  // Before PRO readiness there is no open socket. Never queue or asynchronously
  // replay chat into a future room: callers retain failed submissions themselves.
  return sender?.(channel, payload) ?? false;
}
