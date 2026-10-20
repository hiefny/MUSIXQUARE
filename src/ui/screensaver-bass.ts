/**
 * Subtle bass-reactive brightness for the open screensaver.
 *
 * The host owns the audio graph, so it reads the visualizer's analyser here and
 * brightens the screensaver frame with a CSS filter. Nothing crosses the frame
 * boundary: the clock document keeps rendering as before, and the filter is
 * removed whenever there is nothing to react to. YouTube plays in a
 * cross-origin frame the analyser cannot hear, so it never reacts.
 */
import { BASS_BIN_COUNT, averageBassLevel, bassPunch } from '../audio/bass-level.ts';
import { getAnalyser } from '../audio/engine.ts';
import { createBusScope } from '../core/events.ts';
import { isPlaybackModeYouTube, isPlaybackPlaying } from '../player/ownership.ts';

/** Analyser reads per second; the lift itself is eased every frame. */
const SAMPLE_INTERVAL_MS = 1000 / 30;
/** Brightness added at a full-scale kick: a few percent, never a flash. */
const MAX_LIFT = 0.06;
const ATTACK_MS = 60;
const RELEASE_MS = 450;
/** Below this (under 0.1% brightness) the frame is left unfiltered, as without music. */
const REST_LIFT = 0.01;

export function startScreensaverBassGlow(
  target: HTMLElement,
  motion: MediaQueryList | null | undefined,
): () => void {
  const scope = createBusScope();
  let disposed = false;
  let animationFrame = 0;
  let data: Float32Array<ArrayBuffer> | null = null;
  let goal = 0;
  let lift = 0;
  let lastSample = -Infinity;
  let lastFrame: number | null = null;
  let applied = '';

  const canReact = (): boolean =>
    !motion?.matches &&
    !document.hidden &&
    isPlaybackPlaying() &&
    !isPlaybackModeYouTube() &&
    getAnalyser() !== null;

  const write = (value: string): void => {
    if (value === applied) return;
    applied = value;
    target.style.filter = value;
  };

  const sample = (): void => {
    const analyser = getAnalyser();
    if (!analyser) {
      goal = 0;
      return;
    }
    if (data?.length !== analyser.frequencyBinCount)
      data = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(data);
    goal = bassPunch(averageBassLevel(data, Math.min(BASS_BIN_COUNT, data.length)));
  };

  const rest = (): void => {
    lift = 0;
    lastFrame = null;
    write('');
  };

  const frame = (now: number): void => {
    animationFrame = 0;
    if (disposed) return;
    // Reduced motion turns the reaction off at once rather than easing out.
    if (motion?.matches) {
      rest();
      return;
    }
    const reacting = canReact();
    if (!reacting) goal = 0;
    else if (now - lastSample >= SAMPLE_INTERVAL_MS) {
      lastSample = now;
      sample();
    }
    const elapsed = lastFrame === null ? 16 : Math.min(100, now - lastFrame);
    lastFrame = now;
    // Fast attack follows a kick; the slower release keeps the lift from flickering.
    const tau = goal > lift ? ATTACK_MS : RELEASE_MS;
    lift += (goal - lift) * (1 - Math.exp(-elapsed / tau));
    if (!reacting && lift < REST_LIFT) {
      rest();
      return;
    }
    write(lift < REST_LIFT ? '' : `brightness(${(1 + MAX_LIFT * lift).toFixed(3)})`);
    animationFrame = requestAnimationFrame(frame);
  };

  const wake = (): void => {
    if (disposed || animationFrame !== 0) return;
    if (motion?.matches) {
      rest();
      return;
    }
    if (!canReact() && lift === 0) return;
    animationFrame = requestAnimationFrame(frame);
  };

  scope.on('state:playback.activity', wake);
  scope.on('state:playback.mode', wake);
  scope.on('audio:ready', wake);
  motion?.addEventListener('change', wake);
  document.addEventListener('visibilitychange', wake);
  wake();

  return () => {
    if (disposed) return;
    disposed = true;
    if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    scope.dispose();
    motion?.removeEventListener('change', wake);
    document.removeEventListener('visibilitychange', wake);
    write('');
  };
}
