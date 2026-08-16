import { MAX_SYSTEM_AUDIO_DEVICES } from '../core/constants.ts';
import { getState } from '../core/state.ts';

type SystemAudioCaptureActivityProbe = () => boolean;

const inactiveCaptureProbe: SystemAudioCaptureActivityProbe = () => false;
let captureActivityProbe = inactiveCaptureProbe;

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

/**
 * Bind the capture-owned activity predicate without making playback transport
 * import the capture implementation. The returned disposer supports isolated
 * consumers and tests without reintroducing a transport/capture cycle.
 */
export function configureSystemAudioCaptureActivityProbe(
  probe: SystemAudioCaptureActivityProbe,
): () => void {
  const previousProbe = captureActivityProbe;
  captureActivityProbe = probe;
  return () => {
    if (captureActivityProbe === probe) captureActivityProbe = previousProbe;
  };
}

export function isSystemAudioCaptureActive(): boolean {
  return captureActivityProbe();
}
