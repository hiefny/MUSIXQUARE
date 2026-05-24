import { log } from '../core/log.ts';

export interface WindowsAudioDecoderPrimer {
  element: HTMLAudioElement;
  streamKey: string;
}

export function getAudioTrackStreamKey(scope: string, tracks: readonly MediaStreamTrack[]): string {
  return `${scope}:${tracks.map((track) => track.id).join(',')}`;
}

export function cleanupWindowsAudioDecoderPrimer(primer: WindowsAudioDecoderPrimer | null): void {
  if (!primer) return;

  try {
    primer.element.pause();
  } catch {
    /* noop */
  }
  try {
    primer.element.srcObject = null;
  } catch {
    /* noop */
  }
  try {
    primer.element.remove();
  } catch {
    /* noop */
  }
}

export function primeWindowsAudioDecoder(
  current: WindowsAudioDecoderPrimer | null,
  tracks: readonly MediaStreamTrack[],
  streamKey: string,
  label: string,
  logPrefix: string,
): WindowsAudioDecoderPrimer | null {
  if (current?.streamKey === streamKey) return current;
  cleanupWindowsAudioDecoderPrimer(current);

  // WebRTC remote streams require an HTMLMediaElement (like <audio>) playing the stream
  // in order for browsers (such as Chrome on Windows/Android, and Safari on iOS/macOS)
  // to start decoding the stream. Otherwise, the track remains in a "muted" state in Web Audio.
  if (tracks.length === 0) return null;

  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.controls = false;
  // Volume 0 keeps WebRTC audio decoding active without bypassing the app graph.
  audioEl.volume = 0;
  audioEl.setAttribute('playsinline', 'true');
  audioEl.preload = 'auto';
  audioEl.srcObject = new MediaStream([...tracks]);
  audioEl.dataset.mxqrSystemAudio = 'windows-decoder-primer';
  audioEl.style.display = 'none';
  document.body.appendChild(audioEl);

  const primer: WindowsAudioDecoderPrimer = { element: audioEl, streamKey };
  void audioEl
    .play()
    .then(() => log.info(`${logPrefix} WebRTC audio decoder primed (${label})`))
    .catch((error) => log.warn(`${logPrefix} WebRTC audio decoder primer blocked:`, error));

  return primer;
}
