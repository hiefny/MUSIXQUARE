/**
 * MUSIXQUARE — Standard-room PIN changes (host side)
 *
 * The host tab chooses the Standard-room PIN; the signaling Worker stores and
 * checks it. A change carries the owner's choice for the devices already in
 * the room:
 *   - keep_present: the present devices stay and may reconnect without the
 *     new PIN (the Worker binds that to their reconnect secret);
 *   - revoke_all: everyone rejoins. The Worker closes every guest signaling
 *     socket, and only after its acknowledgement does the host remove each
 *     data channel with a KICK_DEVICE reason, so nobody is removed for a PIN
 *     that never took effect.
 *
 * The transport keeps the desired PIN and replays it across signaling
 * reconnects, so the UI waits only a bounded time ('pending'); the removal
 * stays armed until that exact mutation is applied or superseded.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { delay } from '../core/timers.ts';
import { getRoomContext, isCoordinator } from '../rooms/authority.ts';
import { getPeer } from './peer-state.ts';
import type { StandardRoomPinKickReason } from '../types/index.ts';
import type { StandardRoomPinCommit, StandardRoomPinMembershipRequest } from './transport/types.ts';

/** How long the UI waits for the Worker before reporting a pending change. */
const STANDARD_ROOM_PIN_WAIT_MS = 10_000;

type StandardRoomPinChangeOutcome = 'applied' | 'pending' | 'unsupported';

let _pinChangeGeneration = 0;

function hostSessionBoundary(): string | null {
  if (getRoomContext().kind === 'pro' || !isCoordinator()) return null;
  const sessionCode = getState('network.sessionCode');
  const myId = getState('network.myId');
  return sessionCode && myId ? `${sessionCode}:${myId}` : null;
}

/**
 * Change (or turn off, with `null`) the Standard-room PIN.
 *
 * Resolves 'applied' once the Worker committed this mutation, 'pending' when
 * it has not answered within `waitMs` (the change still applies when the
 * signaling connection recovers), or 'unsupported' when this tab is not the
 * live Standard-room host. `enabling` names the removal reason for
 * "Everyone rejoins": the first PIN, or a new one.
 */
export async function changeStandardRoomPin(
  pin: string | null,
  options: {
    readonly membership?: StandardRoomPinMembershipRequest['mode'];
    readonly enabling: boolean;
    readonly waitMs?: number;
  },
): Promise<StandardRoomPinChangeOutcome> {
  // Any newer change, including turning protection off, disarms an older removal.
  const generation = ++_pinChangeGeneration;
  const boundary = hostSessionBoundary();
  const peer = getPeer();
  if (!boundary || !peer) return 'unsupported';

  const normalizedPin = pin && /^\d{8}$/.test(pin) ? pin : null;
  const mode = normalizedPin ? options.membership : undefined;
  // Every device present at the decision is kept; the transport bounds the list.
  const membership: StandardRoomPinMembershipRequest | undefined = mode
    ? {
        mode,
        keptPeerIds:
          mode === 'keep_present'
            ? getState('network.connectedPeers').map((present) => present.id)
            : [],
      }
    : undefined;

  let commit: Promise<StandardRoomPinCommit>;
  if (typeof peer.setRoomPassword !== 'function') {
    // PeerJS (non-public hosts) has no signaling PIN; the host-side removal
    // still applies, as it did before the Worker could close sockets.
    commit = Promise.resolve({ status: 'applied', membership: 'legacy' });
  } else {
    try {
      commit = peer.setRoomPassword(normalizedPin, membership);
    } catch (error) {
      log.warn('[StandardRoomPin] Could not hand the PIN to the transport', error);
      return 'unsupported';
    }
  }

  const reason: StandardRoomPinKickReason = options.enabling
    ? 'room-pin-enabled'
    : 'room-pin-changed';
  const applied = commit.then(
    (result) => {
      if (result.status !== 'applied') return false;
      // Remove people only for this exact, still-current change in the same
      // host session. An older Worker commits the PIN alone ('legacy'); the
      // host-side removal is then the only remedy, so it still runs.
      if (
        mode === 'revoke_all' &&
        generation === _pinChangeGeneration &&
        hostSessionBoundary() === boundary
      ) {
        bus.emit('network:room-pin-revoke-present', reason);
      }
      return true;
    },
    (error: unknown) => {
      log.warn('[StandardRoomPin] PIN change failed', error);
      return false;
    },
  );

  // The UI deadline only ends the wait; the removal above stays armed.
  const outcome = await Promise.race([
    applied,
    delay(options.waitMs ?? STANDARD_ROOM_PIN_WAIT_MS).then(() => 'pending' as const),
  ]);
  if (outcome === 'pending') return 'pending';
  return outcome ? 'applied' : 'unsupported';
}
