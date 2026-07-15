import type { ProSignalingOptions } from '../network/transport/index.ts';
import {
  connectProRoomTransport,
  disconnectProRoomTransport,
  refreshProRoomSignalingAccess,
} from '../network/peer.ts';
import type { ProRoomSignalingAccess } from './api.ts';
import type { ProRoomSnapshot } from './contracts.ts';
import type { ProRoomTransportBridge } from './session-controller.ts';

function transportAccess(
  snapshot: ProRoomSnapshot,
  access: ProRoomSignalingAccess,
): ProSignalingOptions {
  return {
    roomCode: snapshot.roomCode,
    ticket: access.ticket,
    role: access.role,
    coordinatorEpoch: access.coordinatorEpoch,
    presenceIncarnationId: access.presenceIncarnationId,
    ticketSequence: access.ticketSequence,
  };
}

/** Adapter from server authority snapshots to the stable legacy media topology. */
export class LegacyProRoomNetworkBridge implements ProRoomTransportBridge {
  async connect(snapshot: ProRoomSnapshot, access: ProRoomSignalingAccess): Promise<void> {
    await connectProRoomTransport(transportAccess(snapshot, access));
  }

  async reconfigure(snapshot: ProRoomSnapshot, access: ProRoomSignalingAccess): Promise<void> {
    await connectProRoomTransport(transportAccess(snapshot, access));
  }

  refreshCredentials(snapshot: ProRoomSnapshot, access: ProRoomSignalingAccess): boolean {
    return refreshProRoomSignalingAccess(transportAccess(snapshot, access));
  }

  disconnect(): void {
    disconnectProRoomTransport();
  }
}
