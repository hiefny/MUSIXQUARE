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

  // WebRTC remote streams require an HTMLMediaElement (like <audio>) playing the stream
  // in order for browsers (such as Chrome on Windows/Android, and Safari on iOS/macOS)
  // to start decoding the stream. Otherwise, the track remains in a "muted" state in Web Audio.
  if (tracks.length === 0) return null;

  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.controls = false;
  // muted + volume 0 = silent without bypassing the app graph. The primer's
  // only job is to wake the WebRTC audio decoder; the real audio path is the
  // parallel Web Audio MediaStreamAudioSourceNode. Chrome / Safari autoplay
  // policy allows muted autoplay without a user gesture, so the primer works
  // on fresh tab / hidden-tab / late-join paths where no gesture is in scope.
  // Without `muted = true` the primer can hit NotAllowedError on those paths
  // and the WebRTC track stays at readyState=live but muted=true — the exact
  // Android symptom this primer is here to prevent.
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
