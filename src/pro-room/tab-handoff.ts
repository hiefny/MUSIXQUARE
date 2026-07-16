import { isProRoomCode } from './room-code.ts';

const CHANNEL_NAME = 'musixquare-pro-room-tab-handoff-v1';
const MESSAGE_TYPE = 'pro-room-tab-takeover';

type TakeoverListener = (roomCode: string) => void;

const listeners = new Set<TakeoverListener>();
let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof BroadcastChannel !== 'function') {
    channel = null;
    return channel;
  }
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (
        typeof value !== 'object' ||
        value === null ||
        (value as { type?: unknown }).type !== MESSAGE_TYPE ||
        !isProRoomCode((value as { roomCode?: unknown }).roomCode)
      ) {
        return;
      }
      const roomCode = (value as { roomCode: string }).roomCode;
      for (const listener of [...listeners]) listener(roomCode);
    });
  } catch {
    // Server-side active-presence fencing remains authoritative when a
    // browser or isolated PWA context does not expose BroadcastChannel.
    channel = null;
  }
  return channel;
}

/** Notify older same-origin tabs only after the server accepted a takeover. */
export function announceProRoomTabTakeover(roomCode: string): void {
  if (!isProRoomCode(roomCode)) return;
  try {
    getChannel()?.postMessage({ type: MESSAGE_TYPE, roomCode });
  } catch {
    // The replaced tab will still be fenced by signaling and its heartbeat.
  }
}

/** Listen for an explicit takeover performed by another tab in this profile. */
export function onProRoomTabTakeover(listener: TakeoverListener): () => void {
  listeners.add(listener);
  getChannel();
  return () => listeners.delete(listener);
}

export function resetProRoomTabHandoffForTests(): void {
  listeners.clear();
  channel?.close();
  channel = undefined;
}
