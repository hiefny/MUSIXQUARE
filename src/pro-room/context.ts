import type { RoomCapability, RoomContext } from '../types/index.ts';
import type { ProRoomSnapshot } from './contracts.ts';

function projectClientCapabilities(snapshot: ProRoomSnapshot): RoomCapability[] {
  const viewer = snapshot.viewer;
  if (!viewer) return [];

  const capabilities = new Set<RoomCapability>(
    viewer.capabilities.filter(
      (capability): capability is Exclude<typeof capability, 'coordinator.eligible'> =>
        capability !== 'coordinator.eligible',
    ),
  );

  const administrator = snapshot.administrators.find(
    (candidate) => candidate.memberId === viewer.memberId,
  );
  if (administrator?.permissions['media.add']) capabilities.add('media.add');
  if (administrator?.permissions['chat.notice']) capabilities.add('chat.notice');
  if (administrator?.role === 'owner') capabilities.add('system-audio.publish');

  return [...capabilities];
}

/** Project an authenticated PRO participant into the shared application shell. */
export function projectProRoomContext(snapshot: ProRoomSnapshot): RoomContext | null {
  const viewer = snapshot.viewer;
  if (snapshot.status !== 'active' || !viewer) return null;

  return {
    kind: 'pro',
    roomId: snapshot.roomCode,
    // PRO playback state belongs exclusively to the room Durable Object.
    // Every browser remains a coordinator-free endpoint; the projected
    // capabilities independently decide which user controls it may invoke.
    role: 'member',
    coordinatorId: null,
    epoch: snapshot.presence.coordinatorEpoch,
    snapshotRevision: snapshot.revision,
    capabilities: projectClientCapabilities(snapshot),
  };
}
