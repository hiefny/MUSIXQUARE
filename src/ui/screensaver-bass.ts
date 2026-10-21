/**
 * Smooth bass-reactive brightness for the open screensaver.
 *
 * The host owns the audio graph, so it reads the visualizer's analyser here and
 * brightens the screensaver frame with a CSS filter. Nothing crosses the frame
 * boundary: the clock document keeps rendering as before, and the filter is
 * removed whenever there is nothing to react to. YouTube plays in a
 * cross-origin frame the analyser cannot hear, so it never reacts.
 */
import { averageBassLevel, bassBinCount } from '../audio/bass-level.ts';
import { createSpectrumReader } from '../audio/visualizer-analysis.ts';
import { getAnalyser } from '../audio/engine.ts';
import { createBusScope } from '../core/events.ts';
import { isPlaybackModeYouTube, isPlaybackPlaying } from '../player/ownership.ts';

/** Analyser reads per second; the lift itself is eased every frame. */
const SAMPLE_INTERVAL_MS = 1000 / 30;
const SAMPLE_CLOCK_TOLERANCE_MS = 1;
/** A restrained ceiling; the attack/release envelope prevents a step change. */
const MAX_LIFT = 0.16;
/** Ignore near-silent bands before expanding the useful, ordinary-music range. */
const NOISE_FLOOR_LEVEL = 0.08;
const ATTACK_MS = 60;
const RELEASE_MS = 400;
/** Below 0.1% brightness the frame is left unfiltered, as without music. */
const REST_LIFT = 0.001 / MAX_LIFT;

export function startScreensaverBassGlow(
  target: HTMLElement,
  motion: MediaQueryList | null | undefined,
): () => void {
  const scope = createBusScope();
  let disposed = false;
  let animationFrame = 0;
  const spectrum = createSpectrumReader(0.3);
  let goal = 0;
  let lift = 0;
  let nextSample = -Infinity;
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

  const sample = (now: number): void => {
    const analyser = getAnalyser();
    if (!analyser) {
      goal = 0;
      return;
    }
    const data = spectrum.read(analyser, now);
    const level =
      averageBassLevel(data, bassBinCount(analyser.context.sampleRate, analyser.fftSize)) / 255;
    // Reusing the circle's power-2.5 punch at a 6% ceiling left ordinary bass
    // practically invisible. Expand it gently, with a noise floor and hard cap.
    goal = Math.sqrt(
      Math.max(0, Math.min(1, (level - NOISE_FLOOR_LEVEL) / (1 - NOISE_FLOOR_LEVEL))),
    );
  };

  const rest = (): void => {
    goal = 0;
    lift = 0;
    nextSample = -Infinity;
    lastFrame = null;
    spectrum.reset();
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
    else if (now + SAMPLE_CLOCK_TOLERANCE_MS >= nextSample) {
      // Keep the original phase: scheduling from a slightly late rAF would
      // repeatedly skip a frame and turn the intended 30Hz sampling into 20Hz.
      nextSample = Number.isFinite(nextSample)
        ? nextSample +
          Math.max(1, Math.floor((now - nextSample) / SAMPLE_INTERVAL_MS) + 1) * SAMPLE_INTERVAL_MS
        : now + SAMPLE_INTERVAL_MS;
      sample(now);
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
    if (disposed) return;
    if (motion?.matches || document.hidden) {
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      rest();
      return;
    }
    if (animationFrame !== 0) return;
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
