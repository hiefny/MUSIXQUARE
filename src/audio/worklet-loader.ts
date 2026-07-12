const pcmRingWorkletUrl = new URL('./worklets/pcm-ring-processor.js', import.meta.url);

const workletLoads = new WeakMap<AudioContext, Promise<void>>();

/**
 * Load the PCM ring processor into an existing AudioContext exactly once.
 *
 * The caller owns the context lifecycle. Failed loads are deliberately evicted
 * so a later user gesture or recovered network state can retry initialization.
 */
export function loadPcmRingWorklet(context: AudioContext): Promise<void> {
  const pendingLoad = workletLoads.get(context);
  if (pendingLoad) return pendingLoad;

  const audioWorklet = context.audioWorklet;
  if (!audioWorklet || typeof audioWorklet.addModule !== 'function') {
    return Promise.reject(new Error('AudioWorklet is not supported by this browser.'));
  }

  const loadPromise = Promise.resolve()
    .then(() => audioWorklet.addModule(pcmRingWorkletUrl))
    .catch((error: unknown) => {
      if (workletLoads.get(context) === loadPromise) {
        workletLoads.delete(context);
      }
      throw error;
    });

  workletLoads.set(context, loadPromise);
  return loadPromise;
}
