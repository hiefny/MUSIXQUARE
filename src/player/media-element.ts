/**
 * Streaming file playback for tracks that are unsafe to decode into an
 * AudioBuffer in one allocation.
 *
 * Preparation is deliberately two-phase: callers may inspect the duration
 * and re-check their load/session ownership before publishing the source with
 * commitPreparedMediaElementSource(). A superseded load can therefore dispose
 * its private element without ever replacing the active track.
 */

import { getAudioContext } from '../audio/context.ts';
import { getWidener } from '../audio/engine.ts';
import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { getCurrentAudioBuffer } from './_state.ts';

const METADATA_TIMEOUT_MS = 10_000;

export interface PreparedMediaElementSource {
  readonly duration: number;
  readonly fileName: string;
}

interface MediaElementUrlSource {
  readonly url: string;
  readonly fileName?: string;
  /** Releases the page/SW-side lease behind a virtual media URL. */
  readonly release?: () => void | Promise<void>;
}

interface InternalMediaElementSource extends PreparedMediaElementSource {
  readonly element: HTMLAudioElement;
  readonly node: MediaElementAudioSourceNode;
  readonly objectUrl: string | null;
  readonly releaseSource: (() => void | Promise<void>) | null;
  onEnded: () => void;
  onError: () => void;
  disposed: boolean;
  sourceReleased: boolean;
  committed: boolean;
  playGeneration: number;
  scheduledPlayTimer: ReturnType<typeof setTimeout> | null;
  scheduledPlayResolve: ((started: boolean) => void) | null;
}

let _activeSource: InternalMediaElementSource | null = null;

function asInternal(source: PreparedMediaElementSource): InternalMediaElementSource {
  return source as InternalMediaElementSource;
}

function getFiniteDuration(element: HTMLAudioElement): number {
  const duration = Number(element.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function cancelScheduledPlay(source: InternalMediaElementSource): void {
  source.playGeneration += 1;
  if (source.scheduledPlayTimer !== null) {
    clearTimeout(source.scheduledPlayTimer);
    source.scheduledPlayTimer = null;
  }
  const resolve = source.scheduledPlayResolve;
  source.scheduledPlayResolve = null;
  resolve?.(false);
}

function connectSourceToCurrentGraph(source: InternalMediaElementSource): void {
  try {
    source.node.disconnect();
  } catch {
    // A newly-created or already-disconnected node is expected here.
  }

  if (getState('audio.isSurroundMode')) {
    bus.emit('audio:connect-surround', source.node, getState('audio.surroundChannelIndex'));
    return;
  }

  const widener = getWidener();
  if (!widener) throw new Error('MEDIA_ELEMENT_AUDIO_GRAPH_UNAVAILABLE');
  source.node.connect(widener.input);
}

function disposeInternal(source: InternalMediaElementSource): void {
  if (source.disposed) return;
  source.disposed = true;
  cancelScheduledPlay(source);

  source.element.removeEventListener('ended', source.onEnded);
  source.element.removeEventListener('error', source.onError);
  try {
    source.element.pause();
  } catch {
    // Best effort during page teardown and test-environment cleanup.
  }
  try {
    source.node.disconnect();
  } catch {
    // It may already have been disconnected by an audio-mode transition.
  }
  try {
    source.element.removeAttribute('src');
    source.element.load();
  } catch {
    // Clearing src is sufficient when load() is unavailable.
  }
  if (source.objectUrl) URL.revokeObjectURL(source.objectUrl);

  if (!source.sourceReleased && source.releaseSource) {
    source.sourceReleased = true;
    try {
      void Promise.resolve(source.releaseSource()).catch((error) => {
        log.debug('[MediaElement] Virtual source cleanup failed:', error);
      });
    } catch (error) {
      log.debug('[MediaElement] Virtual source cleanup failed:', error);
    }
  }
}

function releaseFailedPreparation(
  objectUrl: string | null,
  releaseSource: (() => void | Promise<void>) | null,
): void {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  if (!releaseSource) return;
  try {
    void Promise.resolve(releaseSource()).catch((error) => {
      log.debug('[MediaElement] Virtual source cleanup failed:', error);
    });
  } catch (error) {
    log.debug('[MediaElement] Virtual source cleanup failed:', error);
  }
}

async function prepareMediaElementUrl(
  url: string,
  fileName: string,
  objectUrl: string | null,
  releaseSource: (() => void | Promise<void>) | null,
): Promise<PreparedMediaElementSource> {
  const element = document.createElement('audio');
  element.preload = 'auto';
  element.controls = false;
  element.loop = false;
  element.src = url;

  try {
    element.load();
    const duration = await waitForMetadata(element);
    const node = getAudioContext().createMediaElementSource(element);
    const source = {} as InternalMediaElementSource;
    Object.assign(source, {
      element,
      node,
      objectUrl,
      releaseSource,
      duration,
      fileName,
      disposed: false,
      sourceReleased: false,
      committed: false,
      playGeneration: 0,
      scheduledPlayTimer: null,
      scheduledPlayResolve: null,
    });
    source.onEnded = () => {
      if (_activeSource === source && !source.disposed) {
        bus.emit('player:media-element-ended');
      }
    };
    source.onError = () => {
      if (_activeSource === source && !source.disposed) {
        log.warn(`[MediaElement] Playback error for ${source.fileName || 'audio file'}`);
      }
    };
    element.addEventListener('ended', source.onEnded);
    element.addEventListener('error', source.onError);
    return source;
  } catch (error) {
    try {
      element.pause();
      element.removeAttribute('src');
      element.load();
    } catch {
      // Best effort; the backing URL/lease is still released below.
    }
    releaseFailedPreparation(objectUrl, releaseSource);
    throw error;
  }
}

function waitForMetadata(element: HTMLAudioElement): Promise<number> {
  const immediateDuration = getFiniteDuration(element);
  if (element.readyState >= HTMLMediaElement.HAVE_METADATA && immediateDuration > 0) {
    return Promise.resolve(immediateDuration);
  }

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeoutId);
      element.removeEventListener('loadedmetadata', onMetadata);
      element.removeEventListener('durationchange', onMetadata);
      element.removeEventListener('canplay', onMetadata);
      element.removeEventListener('error', onError);
    };
    const finish = (duration: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(duration);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onMetadata = (): void => {
      const duration = getFiniteDuration(element);
      if (duration > 0) finish(duration);
    };
    const onError = (): void => fail(new Error('MEDIA_ELEMENT_METADATA_ERROR'));
    const timeoutId = globalThis.setTimeout(
      () => fail(new Error('MEDIA_ELEMENT_METADATA_TIMEOUT')),
      METADATA_TIMEOUT_MS,
    );

    element.addEventListener('loadedmetadata', onMetadata);
    element.addEventListener('durationchange', onMetadata);
    element.addEventListener('canplay', onMetadata);
    element.addEventListener('error', onError);
    onMetadata();
  });
}

/** Prepare a private streaming source. It is inaudible until committed. */
export async function prepareMediaElementSource(
  blob: Blob,
  fileName = blob instanceof File ? blob.name : '',
): Promise<PreparedMediaElementSource> {
  const objectUrl = URL.createObjectURL(blob);
  return prepareMediaElementUrl(objectUrl, fileName, objectUrl, null);
}

/** Prepare a same-origin virtual URL without ever creating a Blob URL. */
export async function prepareMediaElementUrlSource(
  source: MediaElementUrlSource,
): Promise<PreparedMediaElementSource> {
  let parsed: URL;
  try {
    parsed = new URL(source.url, location.href);
  } catch (error) {
    releaseFailedPreparation(null, source.release ?? null);
    throw new Error('MEDIA_ELEMENT_SOURCE_URL_INVALID', { cause: error });
  }
  if (parsed.origin !== location.origin || !parsed.pathname.startsWith('/__mxqr_media/')) {
    releaseFailedPreparation(null, source.release ?? null);
    throw new Error('MEDIA_ELEMENT_SOURCE_URL_INVALID');
  }
  return prepareMediaElementUrl(
    parsed.toString(),
    source.fileName ?? '',
    null,
    source.release ?? null,
  );
}

/** Publish a prepared source after the caller's final staleness checks. */
export function commitPreparedMediaElementSource(source: PreparedMediaElementSource): void {
  const next = asInternal(source);
  if (next.disposed) throw new Error('MEDIA_ELEMENT_SOURCE_DISPOSED');
  if (next.committed) {
    if (_activeSource !== next) throw new Error('MEDIA_ELEMENT_SOURCE_ALREADY_COMMITTED');
    return;
  }

  connectSourceToCurrentGraph(next);
  const previous = _activeSource;
  next.committed = true;
  _activeSource = next;
  if (previous && previous !== next) disposeInternal(previous);
}

/** Dispose a source that lost a load/session race before commit. */
export function disposePreparedMediaElementSource(source: PreparedMediaElementSource): void {
  const internal = asInternal(source);
  if (_activeSource === internal) {
    _activeSource = null;
    disposeInternal(internal);
    return;
  }
  disposeInternal(internal);
}

export function disposeActiveMediaElementSource(): void {
  const source = _activeSource;
  if (!source) return;
  _activeSource = null;
  disposeInternal(source);
}

export function hasActiveMediaElementSource(): boolean {
  return !!_activeSource && !_activeSource.disposed;
}

export function hasFilePlaybackSource(): boolean {
  return !!getCurrentAudioBuffer() || hasActiveMediaElementSource();
}

export function getFilePlaybackDuration(): number {
  const audioBuffer = getCurrentAudioBuffer();
  if (audioBuffer && Number.isFinite(audioBuffer.duration) && audioBuffer.duration > 0) {
    return audioBuffer.duration;
  }
  return _activeSource && !_activeSource.disposed ? _activeSource.duration : 0;
}

export function getActiveMediaElementPosition(): number {
  const source = _activeSource;
  if (!source || source.disposed) return 0;
  const position = Number(source.element.currentTime);
  return Number.isFinite(position) && position >= 0 ? position : 0;
}

export function isActiveMediaElementEnded(): boolean {
  return !!_activeSource && !_activeSource.disposed && _activeSource.element.ended;
}

export function seekActiveMediaElement(position: number): void {
  const source = _activeSource;
  if (!source || source.disposed) return;
  const safePosition = Math.max(0, Math.min(source.duration, Number(position) || 0));
  try {
    source.element.currentTime = safePosition;
  } catch (error) {
    log.debug('[MediaElement] Seek failed:', error);
  }
}

export function pauseActiveMediaElement(): void {
  const source = _activeSource;
  if (!source || source.disposed) return;
  cancelScheduledPlay(source);
  try {
    source.element.pause();
  } catch (error) {
    log.debug('[MediaElement] Pause failed:', error);
  }
}

/**
 * Start the active element after an optional shared-clock delay. Returns false
 * when a stop/replacement/load-epoch action cancels the scheduled start.
 */
export async function playActiveMediaElement(
  position: number,
  scheduleDelay = 0,
): Promise<boolean> {
  const source = _activeSource;
  if (!source || source.disposed) return false;

  cancelScheduledPlay(source);
  const generation = source.playGeneration;
  seekActiveMediaElement(position);

  if (scheduleDelay > 0) {
    const allowed = await new Promise<boolean>((resolve) => {
      source.scheduledPlayResolve = resolve;
      source.scheduledPlayTimer = globalThis.setTimeout(() => {
        source.scheduledPlayTimer = null;
        source.scheduledPlayResolve = null;
        resolve(true);
      }, scheduleDelay * 1000);
    });
    if (!allowed) return false;
  }

  if (_activeSource !== source || source.disposed || source.playGeneration !== generation) {
    return false;
  }

  connectSourceToCurrentGraph(source);
  try {
    await source.element.play();
  } catch (error) {
    if (_activeSource === source && !source.disposed) {
      log.warn('[MediaElement] play() was rejected:', error);
    }
    return false;
  }
  if (_activeSource !== source || source.disposed || source.playGeneration !== generation) {
    try {
      source.element.pause();
    } catch {
      // The replacement/disposal path already owns cleanup.
    }
    return false;
  }
  return true;
}

export function reconnectActiveMediaElementSource(): void {
  const source = _activeSource;
  if (!source || source.disposed) return;
  try {
    connectSourceToCurrentGraph(source);
  } catch (error) {
    log.warn('[MediaElement] Could not reconnect audio graph:', error);
  }
}
