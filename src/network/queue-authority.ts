/**
 * Guest-side queue authority gate.
 *
 * Authority belongs to a concrete DataConnection. Peer IDs and revisions can
 * repeat across host runtimes, so neither is sufficient to release media
 * frames after reconnect.
 */

import type { DataConnection } from '../types/index.ts';

const readyConnections = new WeakSet<DataConnection>();

export function hasQueueAuthority(conn: DataConnection): boolean {
  return readyConnections.has(conn);
}

export function markQueueAuthorityReady(conn: DataConnection): void {
  readyConnections.add(conn);
}
