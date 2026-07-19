import { MAX_SENDER_LABEL_LENGTH } from '../core/constants.ts';
import { getState } from '../core/state.ts';
import { t } from '../i18n/index.ts';
import type { DataConnection } from '../types/index.ts';
import { announceSystemMessageLocally, broadcastSystemMessage } from './protocol.ts';

/**
 * Queue-add announcements are standard-host or PRO-server-authored system rows.
 * Keep the actor label on the same public boundary as chat sender labels so an
 * API credential label or a stale nickname cannot inflate system frames.
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

const MAX_QUEUE_ANNOUNCEMENT_TITLE_LENGTH = 120;

function isQueueMetadataControl(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    codePoint <= 0x1f ||
    codePoint === 0x7f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/** Keep automatic rows compact and strip control/bidi characters from media metadata. */
function normalizeQueueTrackTitle(value: unknown): string | null {
  const normalized =
    typeof value === 'string'
      ? [...value]
          .filter((character) => !isQueueMetadataControl(character))
          .join('')
          .trim()
      : '';
  if (!normalized) return null;
  let result = '';
  for (const character of normalized) {
    if (result.length + character.length > MAX_QUEUE_ANNOUNCEMENT_TITLE_LENGTH) break;
    result += character;
  }
  return result || null;
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

type QueueAdditionPublisher = (
  i18nKey: Parameters<typeof broadcastSystemMessage>[0],
  params?: Record<string, string | number>,
) => void;

function publishTracksAdded(
  publish: QueueAdditionPublisher,
  actorName: unknown,
  count: number,
  firstTitle?: unknown,
): boolean {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) return false;
  const name = normalizeQueueActorName(actorName, t('common.unknown'));
  const title = normalizeQueueTrackTitle(firstTitle);
  if (title) {
    publish(count === 1 ? 'chat.track_added_named' : 'chat.tracks_added_named', {
      name,
      count,
      title,
    });
  } else {
    publish('chat.tracks_added', { name, count });
  }
  return true;
}

export function broadcastTracksAdded(
  actorName: unknown,
  count: number,
  firstTitle?: unknown,
): boolean {
  return publishTracksAdded(broadcastSystemMessage, actorName, count, firstTitle);
}

/** A PRO server event already reaches every member; render it without a second fanout. */
export function announceTracksAddedLocally(
  actorName: unknown,
  count: number,
  firstTitle?: unknown,
): boolean {
  return publishTracksAdded(announceSystemMessageLocally, actorName, count, firstTitle);
}
