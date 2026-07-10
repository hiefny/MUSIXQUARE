import { log } from '../core/log.ts';

export interface WebRtcAudioDecoderPrimer {
  element: HTMLAudioElement;
  streamKey: string;
}

export function getAudioTrackStreamKey(scope: string, tracks: readonly MediaStreamTrack[]): string {
  return `${scope}:${tracks.map((track) => track.id).join(',')}`;
}

export function cleanupWebRtcAudioDecoderPrimer(primer: WebRtcAudioDecoderPrimer | null): void {
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

export function primeWebRtcAudioDecoder(
  current: WebRtcAudioDecoderPrimer | null,
  tracks: readonly MediaStreamTrack[],
  streamKey: string,
  label: string,
  logPrefix: string,
): WebRtcAudioDecoderPrimer | null {
  if (current?.streamKey === streamKey) return current;
  cleanupWebRtcAudioDecoderPrimer(current);

  // Some browsers do not begin decoding a remote WebRTC audio track for Web
  // Audio until the stream is attached to a playing media element.
  if (tracks.length === 0) return null;

  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.controls = false;
  // Muting keeps this element from bypassing the application graph; audible
  // output still comes from the parallel MediaStreamAudioSourceNode. Muted
  // autoplay has the best chance of succeeding without a user gesture, but
  // play() failure remains non-fatal and is logged below.
  audioEl.muted = true;
  audioEl.volume = 0;
  audioEl.setAttribute('playsinline', 'true');
  audioEl.preload = 'auto';
  audioEl.srcObject = new MediaStream([...tracks]);
  audioEl.dataset.mxqrSystemAudio = 'webrtc-decoder-primer';
  audioEl.style.display = 'none';
  document.body.appendChild(audioEl);

  const primer: WebRtcAudioDecoderPrimer = { element: audioEl, streamKey };
  void audioEl
    .play()
    .then(() => log.info(`${logPrefix} WebRTC audio decoder primed (${label})`))
    .catch((error) => log.warn(`${logPrefix} WebRTC audio decoder primer blocked:`, error));

  return primer;
}
