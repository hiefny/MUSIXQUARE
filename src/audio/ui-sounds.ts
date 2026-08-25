/**
 * Code-generated UI sounds.
 *
 * These sounds intentionally bypass the media-effects graph: playback volume,
 * channel splitting, EQ and reverb must not alter interface feedback. They use
 * the app's shared AudioContext so iOS only has one context to unlock/resume.
 */

import { getAudioContext } from './context.ts';
import { bus, createBusScope } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';

const STORAGE_KEY = 'musixquare-ui-sounds-enabled';
const SESSION_SOUND_COOLDOWN_MS = 300;
const UI_TOUCH_COOLDOWN_MS = 35;
const SELF_JOIN_DEDUP_MS = 5_000;
const ANNOUNCEMENT_LOW_FREQUENCY_HZ = 523.25;
const ANNOUNCEMENT_HIGH_FREQUENCY_HZ = 659.25;
const ATTENTION_OUTPUT_GAIN = 2.5;

type OutputGraph = {
  context: AudioContext;
  touchInput: GainNode;
  attentionInput: GainNode;
};

type ToneOptions = {
  from: number;
  to?: number;
  delay?: number;
  duration: number;
  gain: number;
  attack: number;
  release: number;
  pan?: number;
};

let outputGraph: OutputGraph | null = null;
let enabledCache: boolean | null = null;
let lastUiTouchAt = Number.NEGATIVE_INFINITY;
let lastSessionSoundAt = Number.NEGATIVE_INFINITY;
let lastSelfJoinAt = Number.NEGATIVE_INFINITY;
let previousSessionStarted = getState('setup.sessionStarted');
let initialized = false;
let removeDomListeners: (() => void) | null = null;
const busScope = createBusScope();

function observeUiSoundTask(operation: Promise<unknown>, source: string): void {
  operation.catch((error) => {
    log.debug(`[Audio] ${source} UI sound failed`, error);
  });
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function canPlayWhileVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function readEnabled(): boolean {
  try {
    enabledCache = localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    enabledCache ??= false;
  }
  return enabledCache ?? false;
}

export function isUiSoundsEnabled(): boolean {
  return readEnabled();
}

export function setUiSoundsEnabled(enabled: boolean): void {
  enabledCache = enabled;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* Local preference remains active for this page even if storage is blocked. */
  }
  bus.emit('ui:ui-sounds-changed', enabled);
}

function ensureOutputGraph(context: AudioContext): OutputGraph {
  if (outputGraph?.context === context) return outputGraph;

  const createCompressor = () => {
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 24;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.18;
    return compressor;
  };

  // Keep frequent touch feedback at its existing level. Session events and
  // announcements share one post-compressor makeup stage so their synthesis,
  // envelope and relative echo balance stay unchanged while cutting through
  // active media playback more clearly.
  const touchInput = context.createGain();
  const touchCompressor = createCompressor();
  touchInput.gain.value = 1;
  touchInput.connect(touchCompressor);
  touchCompressor.connect(context.destination);

  const attentionInput = context.createGain();
  const attentionCompressor = createCompressor();
  const attentionOutput = context.createGain();
  attentionInput.gain.value = 1;
  attentionOutput.gain.value = ATTENTION_OUTPUT_GAIN;
  attentionInput.connect(attentionCompressor);
  attentionCompressor.connect(attentionOutput);
  attentionOutput.connect(context.destination);

  outputGraph = { context, touchInput, attentionInput };
  return outputGraph;
}

function resumeFromGesture(): void {
  if (!readEnabled() || !canPlayWhileVisible()) return;
  try {
    const context = getAudioContext();
    if (context.state !== 'running') void context.resume().catch(() => undefined);
  } catch {
    /* Web Audio is optional UI enhancement. */
  }
}

async function readyOutput(force = false): Promise<OutputGraph | null> {
  if ((!force && !readEnabled()) || !canPlayWhileVisible()) return null;
  try {
    const context = getAudioContext();
    if (context.state !== 'running') {
      await context.resume().catch(() => undefined);
    }
    if (context.state !== 'running') return null;
    return ensureOutputGraph(context);
  } catch {
    return null;
  }
}

function connectWithPan(
  context: AudioContext,
  source: AudioNode,
  destination: AudioNode,
  pan = 0,
): void {
  try {
    const panner = context.createStereoPanner();
    panner.pan.value = pan;
    source.connect(panner);
    panner.connect(destination);
  } catch {
    source.connect(destination);
  }
}

function scheduleTone(
  context: AudioContext,
  destination: AudioNode,
  baseTime: number,
  options: ToneOptions,
): void {
  const start = baseTime + (options.delay ?? 0);
  const end = start + options.duration;
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(options.from, start);
  oscillator.frequency.exponentialRampToValueAtTime(options.to ?? options.from, end);

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(options.gain, start + options.attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, end + options.release);

  oscillator.connect(gain);
  connectWithPan(context, gain, destination, options.pan);
  oscillator.start(start);
  oscillator.stop(end + options.release + 0.01);
}

function schedulePitchlessTouch(context: AudioContext, destination: AudioNode, time: number): void {
  const duration = 0.025;
  const totalDuration = 0.055;
  const body = 0.42;
  const snap = 0.22;
  const damping = 1.25;
  const amplitude = 0.34;
  const targetLevel = 0.075;
  const length = Math.max(1, Math.ceil(context.sampleRate * totalDuration));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const samples = buffer.getChannelData(0);
  const pulses = [
    [0.0006, 0.00042, 1],
    [0.00135, 0.0006, -0.72],
    [0.0026, 0.0009, 0.42],
    [0.0049, 0.00145, -0.24],
    [0.0084, 0.0022, 0.13],
  ] as const;
  let peak = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const localTime = i / context.sampleRate;
    if (localTime > duration) break;
    const attack = Math.min(1, localTime / 0.00055);
    const decay = Math.exp(-localTime * (86 * damping));
    let pulseValue = 0;
    for (const [center, width, pulseGain] of pulses) {
      const distance = (localTime - center) / width;
      pulseValue += Math.exp(-(distance * distance)) * pulseGain;
    }
    const contact = pulseValue * decay * attack;
    const weight = body + snap * Math.exp(-localTime * 360);
    const fadeIn = Math.min(1, localTime / 0.001);
    const sample = contact * weight * amplitude * fadeIn;
    samples[i] = sample;
    peak = Math.max(peak, Math.abs(sample));
  }

  if (peak > 0) {
    const scale = targetLevel / peak;
    for (let i = 0; i < samples.length; i += 1) samples[i] *= scale;
  }

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(destination);
  source.start(time);
}

function scheduleMicroEcho(
  context: AudioContext,
  destination: AudioNode,
  time: number,
  frequency: number,
): void {
  scheduleTone(context, destination, time, {
    from: frequency,
    duration: 0.18,
    gain: 0.064,
    attack: 0.003,
    release: 0.14,
    pan: -0.025,
  });
  scheduleTone(context, destination, time, {
    from: frequency,
    delay: 0.13,
    duration: 0.22,
    gain: 0.026,
    attack: 0.003,
    release: 0.18,
    pan: 0.04,
  });
}

async function playTouch(force = false): Promise<void> {
  const output = await readyOutput(force);
  if (!output) return;
  schedulePitchlessTouch(output.context, output.touchInput, output.context.currentTime + 0.006);
}

export function playUiTouchSound(options: { force?: boolean } = {}): void {
  const now = nowMs();
  if (!options.force && now - lastUiTouchAt < UI_TOUCH_COOLDOWN_MS) return;
  lastUiTouchAt = now;
  observeUiSoundTask(playTouch(options.force === true), 'touch');
}

function playSessionSound(frequency: number): void {
  const now = nowMs();
  if (now - lastSessionSoundAt < SESSION_SOUND_COOLDOWN_MS) return;
  lastSessionSoundAt = now;
  observeUiSoundTask(
    readyOutput().then((output) => {
      if (!output) return;
      scheduleMicroEcho(
        output.context,
        output.attentionInput,
        output.context.currentTime + 0.008,
        frequency,
      );
    }),
    'session',
  );
}

function playParticipantJoinSound(): void {
  // Echo the announcement motif's high note for an arriving participant.
  playSessionSound(ANNOUNCEMENT_HIGH_FREQUENCY_HZ);
}

function playParticipantLeaveSound(): void {
  // Echo the announcement motif's low note for a departing participant.
  playSessionSound(ANNOUNCEMENT_LOW_FREQUENCY_HZ);
}

export function playAnnouncementSound(): void {
  observeUiSoundTask(
    readyOutput().then((output) => {
      if (!output) return;
      const time = output.context.currentTime + 0.008;
      // Sound Lab #10: Two Step.
      scheduleTone(output.context, output.attentionInput, time, {
        from: ANNOUNCEMENT_LOW_FREQUENCY_HZ,
        duration: 0.16,
        gain: 0.055,
        attack: 0.004,
        release: 0.12,
        pan: -0.04,
      });
      scheduleTone(output.context, output.attentionInput, time, {
        from: ANNOUNCEMENT_HIGH_FREQUENCY_HZ,
        delay: 0.095,
        duration: 0.23,
        gain: 0.068,
        attack: 0.004,
        release: 0.18,
        pan: 0.04,
      });
    }),
    'announcement',
  );
}

export function playChatSystemEventSound(
  i18nKey: string | undefined,
  params?: Record<string, string | number>,
): void {
  if (i18nKey === 'chat.peer_connected') {
    const name = typeof params?.name === 'string' ? params.name : '';
    const myName = getState('network.myDeviceLabel') || '';
    if (name && myName && name === myName && nowMs() - lastSelfJoinAt < SELF_JOIN_DEDUP_MS) return;
    playParticipantJoinSound();
  } else if (i18nKey === 'chat.peer_disconnected') {
    playParticipantLeaveSound();
  }
}

function isEligibleButton(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof Element)) return false;
  const button = target.closest<HTMLElement>('button, [role="button"]');
  if (!button) return false;
  if (button.matches(':disabled, [aria-disabled="true"], [data-ui-sound="off"]')) return false;
  if (button.closest('[data-ui-sound="off"]')) return false;
  if (button.matches('.playlist-reorder-handle, [role="slider"]')) return false;
  return true;
}

export function initUiSounds(): void {
  if (initialized) return;
  initialized = true;
  previousSessionStarted = getState('setup.sessionStarted');

  const handleClick = (event: MouseEvent) => {
    if (!event.isTrusted || !readEnabled() || !isEligibleButton(event.target)) return;
    playUiTouchSound();
  };
  const handlePointerDown = (event: PointerEvent) => {
    if (event.isTrusted) resumeFromGesture();
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.isTrusted && (event.key === 'Enter' || event.key === ' ')) resumeFromGesture();
  };

  document.addEventListener('click', handleClick);
  document.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: true });
  document.addEventListener('keydown', handleKeyDown, { capture: true });
  removeDomListeners = () => {
    document.removeEventListener('click', handleClick);
    document.removeEventListener('pointerdown', handlePointerDown, { capture: true });
    document.removeEventListener('keydown', handleKeyDown, { capture: true });
  };

  busScope.on('state:setup.sessionStarted', (started) => {
    const sessionStarted = started === true;
    if (!previousSessionStarted && sessionStarted) {
      lastSelfJoinAt = nowMs();
      playParticipantJoinSound();
    }
    previousSessionStarted = sessionStarted;
  });
}

/** Test/HMR cleanup; production bootstrap initializes this module once. */
export function resetUiSoundsForTests(): void {
  removeDomListeners?.();
  removeDomListeners = null;
  busScope.dispose();
  initialized = false;
  enabledCache = null;
  outputGraph = null;
  lastUiTouchAt = Number.NEGATIVE_INFINITY;
  lastSessionSoundAt = Number.NEGATIVE_INFINITY;
  lastSelfJoinAt = Number.NEGATIVE_INFINITY;
  previousSessionStarted = getState('setup.sessionStarted');
}
