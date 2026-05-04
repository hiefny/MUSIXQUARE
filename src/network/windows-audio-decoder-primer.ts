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
  if (!isWindowsDesktop() || tracks.length === 0) return null;

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
    .then(() => log.info(`${logPrefix} Windows WebRTC audio decoder primed (${label})`))
    .catch((error) => log.warn(`${logPrefix} Windows WebRTC audio decoder primer blocked:`, error));

  return primer;
}

function isWindowsDesktop(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || navigator.platform || '';
  return /windows/i.test(platform) || /Windows NT/i.test(navigator.userAgent);
}
