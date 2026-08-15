type SystemAudioCaptureActivityProbe = () => boolean;

const inactiveCaptureProbe: SystemAudioCaptureActivityProbe = () => false;
let captureActivityProbe = inactiveCaptureProbe;

/**
 * Bind the capture-owned activity predicate without making playback transport
 * import the capture implementation. The returned disposer restores the prior
 * binding so isolated consumers and tests can override the leaf port safely.
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

/** Read capture activity through the synchronously configured capture port. */
export function isSystemAudioCaptureActive(): boolean {
  return captureActivityProbe();
}
