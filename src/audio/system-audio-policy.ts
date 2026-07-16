import { MAX_SYSTEM_AUDIO_DEVICES } from '../core/constants.ts';
import { getState } from '../core/state.ts';

/** The coordinator is device one; only fully connected, unique guests count. */
function getConnectedSystemAudioDeviceCount(): number {
  const connectedGuestIds = new Set(
    getState('network.connectedPeers')
      .filter((peer) => peer.status === 'connected')
      .map((peer) => peer.id),
  );
  return 1 + connectedGuestIds.size;
}

export function hasSystemAudioDeviceCapacity(): boolean {
  return getConnectedSystemAudioDeviceCount() <= MAX_SYSTEM_AUDIO_DEVICES;
}
