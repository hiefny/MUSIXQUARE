import { MAX_SENDER_LABEL_LENGTH } from '../core/constants.ts';
import { getState } from '../core/state.ts';
import { t } from '../i18n/index.ts';
import type { DataConnection } from '../types/index.ts';
import { broadcastSystemMessage } from './protocol.ts';

/**
 * Queue-add announcements are host/coordinator-authored system rows. Keep the
 * actor label on the same public wire boundary as chat sender labels so an API
 * credential label or a stale nickname cannot inflate CHAT_SYSTEM frames.
 */
function normalizeQueueActorName(value: unknown, fallback = 'HOST'): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const source = normalized || fallback;
  let result = '';
  for (const character of source) {
    if (result.length + character.length > MAX_SENDER_LABEL_LENGTH) break;
    result += character;
  }
  return result || 'HOST';
}

export function localQueueActorName(): string {
  return normalizeQueueActorName(getState('network.myDeviceLabel'));
}

/** Resolve a standard-room administrator from the authoritative host peer list. */
export function queueActorNameForConnection(conn: DataConnection): string | null {
  const peer = getState('network.connectedPeers').find(
    (candidate) => candidate.id === conn.peer && candidate.conn === conn,
  );
  return peer ? normalizeQueueActorName(peer.label, t('common.unknown')) : null;
}

export function broadcastTracksAdded(actorName: unknown, count: number): boolean {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) return false;
  broadcastSystemMessage('chat.tracks_added', {
    name: normalizeQueueActorName(actorName, t('common.unknown')),
    count,
  });
  return true;
}
