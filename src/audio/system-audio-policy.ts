import { MAX_SYSTEM_AUDIO_DEVICES } from '../core/constants.ts';
import { getState } from '../core/state.ts';

type SystemAudioCaptureActivityProbe = () => boolean;
type SystemAudioCaptureStartProbe = () => boolean;

const inactiveCaptureProbe: SystemAudioCaptureActivityProbe = () => false;
let captureActivityProbe = inactiveCaptureProbe;
const idleCaptureStartProbe: SystemAudioCaptureStartProbe = () => false;
let captureStartProbe = idleCaptureStartProbe;

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

/**
 * Bind the capture-owned start-attempt predicate the same way. The media
 * source picker reads it to show one preparing state in both room kinds, so
 * it holds no pending flag, timer or deadline of its own; the attempt's end
 * reaches it as `system-audio:start-settled`.
 */
export function configureSystemAudioCaptureStartProbe(
  probe: SystemAudioCaptureStartProbe,
): () => void {
  const previousProbe = captureStartProbe;
  captureStartProbe = probe;
  return () => {
    if (captureStartProbe === probe) captureStartProbe = previousProbe;
  };
}

/** A start attempt is running: from the click until it settles or a stop clears it. */
export function isSystemAudioCaptureStartPending(): boolean {
  return captureStartProbe();
}
