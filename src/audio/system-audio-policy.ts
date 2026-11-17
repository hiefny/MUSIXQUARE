import { MAX_SYSTEM_AUDIO_DEVICES } from '../core/constants.ts';
import { getState } from '../core/state.ts';
import type { SystemAudioSurface } from '../core/system-audio-profile.ts';

type SystemAudioCaptureActivityProbe = () => boolean;
type SystemAudioCaptureStartProbe = () => boolean;
type SystemAudioCapturedStartProbe = () => SystemAudioSurface | null;

const inactiveCaptureProbe: SystemAudioCaptureActivityProbe = () => false;
let captureActivityProbe = inactiveCaptureProbe;
const idleCaptureStartProbe: SystemAudioCaptureStartProbe = () => false;
let captureStartProbe = idleCaptureStartProbe;
const uncapturedStartProbe: SystemAudioCapturedStartProbe = () => null;
let capturedStartProbe = uncapturedStartProbe;

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

/**
 * Bind the surface the running start attempt captured live audio from, the
 * same way. The capture holds it with its start-attempt slot and says when it
 * is set with `system-audio:start-captured`: the media source picker closes
 * then, and the play tab shows the share preparing with the share's profile
 * label until `system-audio:start-settled`, still with nothing of its own.
 */
export function configureSystemAudioCapturedStartProbe(
  probe: SystemAudioCapturedStartProbe,
): () => void {
  const previousProbe = capturedStartProbe;
  capturedStartProbe = probe;
  return () => {
    if (capturedStartProbe === probe) capturedStartProbe = previousProbe;
  };
}

/**
 * The surface of a running start attempt that holds live audio; null while
 * the browser's share window is open, and from the moment the attempt settles
 * or a stop clears it.
 */
export function getSystemAudioCapturedStartSurface(): SystemAudioSurface | null {
  return capturedStartProbe();
}
