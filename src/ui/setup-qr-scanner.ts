/** Guest setup QR scanner. Camera access starts only from the scan button. */

import { log } from '../core/log.ts';

const SCAN_BUTTON_ID = 'btn-setup-qr-scan';
const CAMERA_ID = 'setup-qr-camera';
const VIDEO_ID = 'setup-qr-video';
const CLOSE_BUTTON_ID = 'btn-setup-qr-close';
const INVITE_QR_RE = /^(?:https?:\/\/)?(?:www\.)?musixquare\.com\/(\d{6})\/?$/i;
const CAMERA_ACQUIRE_TIMEOUT_MS = 12_000;
const CAMERA_FIRST_FRAME_TIMEOUT_MS = 3_000;
const CAMERA_FRAME_POLL_MS = 50;
const CAMERA_LAYOUT_FALLBACK_MS = 100;
const CAMERA_MUTE_GRACE_MS = 1_500;
const CAMERA_ATTEMPTS = 2;

type GuestQrScannerError =
  | 'permission-denied'
  | 'camera-not-found'
  | 'camera-unavailable'
  | 'camera-start-stalled';

interface GuestQrScannerCallbacks {
  isCurrent: () => boolean;
  onCode: (code: string) => void;
  onError: (reason: GuestQrScannerError) => void;
}

interface ScannerElements {
  button: HTMLButtonElement;
  camera: HTMLElement;
  video: HTMLVideoElement;
  closeButton: HTMLButtonElement;
}

type CameraAcquisition =
  | { kind: 'stream'; stream: MediaStream }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

type CameraFrameResult =
  | { kind: 'ready' }
  | { kind: 'failed'; phase: 'no-video-track' | 'play-rejected' | 'track-ended' | 'timeout' }
  | { kind: 'cancelled' };

interface ReadyCamera {
  stream: MediaStream;
  attemptToken: number;
  attempt: number;
  cleanupActive?: () => void;
}

let callbacks: GuestQrScannerCallbacks | null = null;
let scannerGeneration = 0;
let scannerAttemptToken = 0;
let scannerAttemptCancel: (() => void) | null = null;
let scannerStream: MediaStream | null = null;
let scannerActiveCleanup: (() => void) | null = null;
let scannerFrame = 0;
let scannerSuccessTimer = 0;
let controlsBound = false;
let lifecycleBound = false;
const stoppedStreams = new WeakSet<MediaStream>();

function scannerElements(): ScannerElements | null {
  const button = document.getElementById(SCAN_BUTTON_ID) as HTMLButtonElement | null;
  const camera = document.getElementById(CAMERA_ID);
  const video = document.getElementById(VIDEO_ID) as HTMLVideoElement | null;
  const closeButton = document.getElementById(CLOSE_BUTTON_ID) as HTMLButtonElement | null;
  if (!button || !camera || !video || !closeButton) return null;
  return { button, camera, video, closeButton };
}

function extractInviteCode(value: string): string | null {
  return INVITE_QR_RE.exec(value.trim())?.[1] ?? null;
}

function classifyAcquisitionError(error: unknown): GuestQrScannerError {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : '';

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'permission-denied';
  }
  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    name === 'OverconstrainedError'
  ) {
    return 'camera-not-found';
  }
  return 'camera-unavailable';
}

function stopStream(stream: MediaStream | null): void {
  if (!stream || stoppedStreams.has(stream)) return;
  stoppedStreams.add(stream);
  stream.getTracks().forEach((track) => track.stop());
}

function releaseAttemptStream(stream: MediaStream, elements: ScannerElements): void {
  if (scannerStream === stream) scannerStream = null;
  if (elements.video.srcObject === stream) {
    elements.video.pause();
    elements.video.srcObject = null;
  }
  stopStream(stream);
}

function isAttemptCurrent(
  generation: number,
  attemptToken: number,
  currentCallbacks: GuestQrScannerCallbacks,
): boolean {
  return (
    generation === scannerGeneration &&
    attemptToken === scannerAttemptToken &&
    document.visibilityState !== 'hidden' &&
    currentCallbacks.isCurrent()
  );
}

function reportScannerError(
  generation: number,
  currentCallbacks: GuestQrScannerCallbacks,
  reason: GuestQrScannerError,
): void {
  if (generation !== scannerGeneration) return;
  const shouldReport = document.visibilityState !== 'hidden' && currentCallbacks.isCurrent();
  stopGuestQrScanner();
  if (shouldReport) currentCallbacks.onError(reason);
}

function getDisplayMode(): string {
  for (const mode of ['fullscreen', 'standalone', 'minimal-ui', 'browser']) {
    try {
      if (window.matchMedia?.(`(display-mode: ${mode})`).matches) return mode;
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
}

function cameraStartSnapshot(
  attempt: number,
  phase: string,
  stream: MediaStream | null,
  video: HTMLVideoElement,
): Record<string, unknown> {
  const track = stream ? firstVideoTrack(stream) : null;
  let settings: MediaTrackSettings = {};
  try {
    settings = track?.getSettings() ?? {};
  } catch {
    // Some failed WebKit tracks throw while exposing settings.
  }
  const installNavigator = navigator as Navigator & { standalone?: boolean };
  const displayMode = getDisplayMode();
  return {
    attemptCount: attempt,
    phase,
    standalone: installNavigator.standalone === true || displayMode === 'standalone',
    displayMode,
    visibility: document.visibilityState,
    streamActive: stream?.active ?? null,
    track: track
      ? {
          readyState: track.readyState,
          muted: track.muted,
          enabled: track.enabled,
          settings: {
            width: settings.width ?? null,
            height: settings.height ?? null,
            frameRate: settings.frameRate ?? null,
            facingMode: settings.facingMode ?? null,
          },
        }
      : null,
    video: {
      readyState: video.readyState,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      paused: video.paused,
    },
  };
}

function logFinalStartStall(
  attempt: number,
  phase: string,
  stream: MediaStream | null,
  video: HTMLVideoElement,
): void {
  log.warn('[Setup QR] Camera start stalled', cameraStartSnapshot(attempt, phase, stream, video));
}

export function stopGuestQrScanner(): void {
  scannerGeneration += 1;
  scannerAttemptToken += 1;
  const cancelAttempt = scannerAttemptCancel;
  scannerAttemptCancel = null;
  cancelAttempt?.();
  const cleanupActiveCamera = scannerActiveCleanup;
  scannerActiveCleanup = null;
  cleanupActiveCamera?.();
  if (scannerFrame) cancelAnimationFrame(scannerFrame);
  if (scannerSuccessTimer) window.clearTimeout(scannerSuccessTimer);
  scannerFrame = 0;
  scannerSuccessTimer = 0;
  stopStream(scannerStream);
  scannerStream = null;

  const elements = scannerElements();
  if (!elements) return;
  elements.video.pause();
  elements.video.srcObject = null;
  elements.camera.hidden = true;
  elements.camera.classList.remove('is-qr-recognized');
  elements.button.hidden = false;
  elements.button.removeAttribute('aria-busy');
}

function stopScannerWhenDocumentIsHidden(): void {
  if (document.visibilityState === 'hidden') stopGuestQrScanner();
}

function bindScannerLifecycle(): void {
  if (lifecycleBound) return;
  lifecycleBound = true;
  document.addEventListener('visibilitychange', stopScannerWhenDocumentIsHidden);
  window.addEventListener('pagehide', stopGuestQrScanner);
}

function acquireCameraStream(constraints: MediaStreamConstraints): Promise<CameraAcquisition> {
  let request: Promise<MediaStream>;
  try {
    // Keep this call in the original click activation task. iOS standalone WebKit
    // can otherwise treat the camera request as lacking user activation.
    request = navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    return Promise.resolve({ kind: 'error', error });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CameraAcquisition): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (scannerAttemptCancel === cancel) scannerAttemptCancel = null;
      resolve(result);
    };
    const cancel = (): void => finish({ kind: 'cancelled' });
    const timeout = window.setTimeout(() => finish({ kind: 'timeout' }), CAMERA_ACQUIRE_TIMEOUT_MS);
    scannerAttemptCancel = cancel;

    void request.then(
      (stream) => {
        if (settled) {
          stopStream(stream);
          return;
        }
        finish({ kind: 'stream', stream });
      },
      (error: unknown) => finish({ kind: 'error', error }),
    );
  });
}

function waitForLayoutOpportunity(
  generation: number,
  attemptToken: number,
  currentCallbacks: GuestQrScannerCallbacks,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let frame = 0;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(fallback);
      if (scannerAttemptCancel === cancel) scannerAttemptCancel = null;
      resolve(ready);
    };
    const complete = (): void =>
      finish(isAttemptCurrent(generation, attemptToken, currentCallbacks));
    const cancel = (): void => finish(false);
    frame = requestAnimationFrame(complete);
    const fallback = window.setTimeout(complete, CAMERA_LAYOUT_FALLBACK_MS);
    scannerAttemptCancel = cancel;
  });
}

function firstVideoTrack(stream: MediaStream): MediaStreamTrack | null {
  try {
    return stream.getVideoTracks()[0] ?? null;
  } catch {
    return null;
  }
}

function hasUsableCameraFrame(video: HTMLVideoElement, track: MediaStreamTrack): boolean {
  return (
    track.readyState === 'live' &&
    track.enabled &&
    !track.muted &&
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  );
}

function waitForFirstCameraFrame(
  stream: MediaStream,
  elements: ScannerElements,
  generation: number,
  attemptToken: number,
  currentCallbacks: GuestQrScannerCallbacks,
): Promise<CameraFrameResult> {
  const track = firstVideoTrack(stream);
  if (!track) return Promise.resolve({ kind: 'failed', phase: 'no-video-track' });

  return new Promise((resolve) => {
    let settled = false;
    let sawPostAttachMediaEvent = false;
    let sawPresentedVideoFrame = false;
    let videoFrameCallback = 0;
    let supportsVideoFrameCallback = typeof elements.video.requestVideoFrameCallback === 'function';
    const videoEvents = ['loadeddata', 'playing', 'timeupdate'] as const;
    const finish = (result: CameraFrameResult): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.clearInterval(poll);
      videoEvents.forEach((eventName) =>
        elements.video.removeEventListener(eventName, onMediaEvent),
      );
      track.removeEventListener('mute', check);
      track.removeEventListener('unmute', check);
      track.removeEventListener('ended', onEnded);
      if (videoFrameCallback && typeof elements.video.cancelVideoFrameCallback === 'function') {
        try {
          elements.video.cancelVideoFrameCallback(videoFrameCallback);
        } catch {
          // A partial WebKit implementation may expose but reject this API.
        }
      }
      if (scannerAttemptCancel === cancel) scannerAttemptCancel = null;
      resolve(result);
    };
    const check = (): void => {
      if (!isAttemptCurrent(generation, attemptToken, currentCallbacks)) {
        finish({ kind: 'cancelled' });
      } else if (track.readyState === 'ended' || !track.enabled) {
        finish({ kind: 'failed', phase: 'track-ended' });
      } else if (
        hasUsableCameraFrame(elements.video, track) &&
        (sawPresentedVideoFrame || (!supportsVideoFrameCallback && sawPostAttachMediaEvent))
      ) {
        finish({ kind: 'ready' });
      }
    };
    const onMediaEvent = (): void => {
      sawPostAttachMediaEvent = true;
      check();
    };
    const onEnded = (): void => finish({ kind: 'failed', phase: 'track-ended' });
    const cancel = (): void => finish({ kind: 'cancelled' });
    const timeout = window.setTimeout(
      () => finish({ kind: 'failed', phase: 'timeout' }),
      CAMERA_FIRST_FRAME_TIMEOUT_MS,
    );
    const poll = window.setInterval(check, CAMERA_FRAME_POLL_MS);
    videoEvents.forEach((eventName) => elements.video.addEventListener(eventName, onMediaEvent));
    track.addEventListener('mute', check);
    track.addEventListener('unmute', check);
    track.addEventListener('ended', onEnded);
    scannerAttemptCancel = cancel;

    if (supportsVideoFrameCallback) {
      try {
        videoFrameCallback = elements.video.requestVideoFrameCallback(() => {
          sawPresentedVideoFrame = true;
          check();
        });
      } catch {
        supportsVideoFrameCallback = false;
      }
    }

    let playRequest: Promise<void>;
    try {
      playRequest = Promise.resolve(elements.video.play());
    } catch {
      finish({ kind: 'failed', phase: 'play-rejected' });
      return;
    }
    void playRequest.then(check, () => {
      if (settled) return;
      check();
      if (!settled) finish({ kind: 'failed', phase: 'play-rejected' });
    });
    check();
  });
}

function cameraConstraints(attempt: number): MediaStreamConstraints {
  if (attempt === 1) {
    return {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 1280 },
      },
    };
  }
  return { audio: false, video: { facingMode: { ideal: 'environment' } } };
}

async function prepareCameraWithRetry(
  generation: number,
  currentCallbacks: GuestQrScannerCallbacks,
  elements: ScannerElements,
): Promise<ReadyCamera | null> {
  for (let attempt = 1; attempt <= CAMERA_ATTEMPTS; attempt += 1) {
    if (generation !== scannerGeneration || !currentCallbacks.isCurrent()) return null;
    const attemptToken = ++scannerAttemptToken;
    const acquisition = await acquireCameraStream(cameraConstraints(attempt));
    if (acquisition.kind === 'cancelled') return null;
    if (acquisition.kind === 'timeout') {
      logFinalStartStall(attempt, 'acquire-timeout', null, elements.video);
      reportScannerError(generation, currentCallbacks, 'camera-start-stalled');
      return null;
    }
    if (acquisition.kind === 'error') {
      const reason = classifyAcquisitionError(acquisition.error);
      if (reason !== 'camera-unavailable' || attempt === CAMERA_ATTEMPTS) {
        if (reason === 'camera-unavailable') {
          logFinalStartStall(attempt, 'acquire-error', null, elements.video);
          reportScannerError(generation, currentCallbacks, 'camera-start-stalled');
        } else {
          reportScannerError(generation, currentCallbacks, reason);
        }
        return null;
      }
      continue;
    }

    const { stream } = acquisition;
    if (!isAttemptCurrent(generation, attemptToken, currentCallbacks)) {
      stopStream(stream);
      return null;
    }
    if (!(await waitForLayoutOpportunity(generation, attemptToken, currentCallbacks))) {
      stopStream(stream);
      return null;
    }

    elements.video.muted = true;
    elements.video.defaultMuted = true;
    elements.video.playsInline = true;
    scannerStream = stream;
    elements.video.srcObject = stream;
    const frameResult = await waitForFirstCameraFrame(
      stream,
      elements,
      generation,
      attemptToken,
      currentCallbacks,
    );
    if (frameResult.kind === 'ready') return { stream, attemptToken, attempt };
    if (frameResult.kind === 'cancelled') {
      releaseAttemptStream(stream, elements);
      return null;
    }

    const finalSnapshot =
      attempt === CAMERA_ATTEMPTS
        ? cameraStartSnapshot(attempt, frameResult.phase, stream, elements.video)
        : null;
    releaseAttemptStream(stream, elements);
    if (finalSnapshot) {
      log.warn('[Setup QR] Camera start stalled', finalSnapshot);
      reportScannerError(generation, currentCallbacks, 'camera-start-stalled');
      return null;
    }
    // Let WebKit release the first capture session before requesting the same
    // hardware again. The generation/attempt fence makes this pause cancellable.
    if (!(await waitForLayoutOpportunity(generation, attemptToken, currentCallbacks))) return null;
  }
  return null;
}

function installActiveCameraGuard(
  readyCamera: ReadyCamera,
  generation: number,
  currentCallbacks: GuestQrScannerCallbacks,
  elements: ScannerElements,
): void {
  const track = firstVideoTrack(readyCamera.stream);
  if (!track) return;
  let muteTimer = 0;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    window.clearTimeout(muteTimer);
    track.removeEventListener('ended', onEnded);
    track.removeEventListener('mute', onMute);
    track.removeEventListener('unmute', onUnmute);
    if (scannerActiveCleanup === cleanup) scannerActiveCleanup = null;
    if (readyCamera.cleanupActive === cleanup) readyCamera.cleanupActive = undefined;
  };
  const fail = (phase: string): void => {
    cleanup();
    if (!isAttemptCurrent(generation, readyCamera.attemptToken, currentCallbacks)) {
      releaseAttemptStream(readyCamera.stream, elements);
      return;
    }
    const snapshot = cameraStartSnapshot(
      readyCamera.attempt,
      phase,
      readyCamera.stream,
      elements.video,
    );
    releaseAttemptStream(readyCamera.stream, elements);
    log.warn('[Setup QR] Camera start stalled', snapshot);
    reportScannerError(generation, currentCallbacks, 'camera-start-stalled');
  };
  const onEnded = (): void => fail('active-track-ended');
  const onMute = (): void => {
    window.clearTimeout(muteTimer);
    muteTimer = window.setTimeout(() => {
      muteTimer = 0;
      if (track.muted) fail('active-track-muted');
    }, CAMERA_MUTE_GRACE_MS);
  };
  const onUnmute = (): void => {
    window.clearTimeout(muteTimer);
    muteTimer = 0;
  };
  track.addEventListener('ended', onEnded);
  track.addEventListener('mute', onMute);
  track.addEventListener('unmute', onUnmute);
  readyCamera.cleanupActive = cleanup;
  scannerActiveCleanup = cleanup;
}

function beginQrFrameScan(
  readyCamera: ReadyCamera,
  generation: number,
  currentCallbacks: GuestQrScannerCallbacks,
  elements: ScannerElements,
  decodeQr: typeof import('jsqr').default,
): void {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('canvas unavailable');
  let lastScanAt = 0;

  const scan = (now: number): void => {
    if (!isAttemptCurrent(generation, readyCamera.attemptToken, currentCallbacks)) {
      readyCamera.cleanupActive?.();
      releaseAttemptStream(readyCamera.stream, elements);
      return;
    }

    try {
      if (
        now - lastScanAt >= 100 &&
        elements.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        lastScanAt = now;
        const sourceWidth = elements.video.videoWidth;
        const sourceHeight = elements.video.videoHeight;
        if (sourceWidth > 0 && sourceHeight > 0) {
          const scale = Math.min(1, 720 / sourceWidth);
          canvas.width = Math.max(1, Math.round(sourceWidth * scale));
          canvas.height = Math.max(1, Math.round(sourceHeight * scale));
          context.drawImage(elements.video, 0, 0, canvas.width, canvas.height);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          const result = decodeQr(image.data, image.width, image.height, {
            inversionAttempts: 'attemptBoth',
          });
          const code = result ? extractInviteCode(result.data) : null;
          if (code) {
            elements.camera.classList.add('is-qr-recognized');
            scannerSuccessTimer = window.setTimeout(() => {
              scannerSuccessTimer = 0;
              if (generation === scannerGeneration) stopGuestQrScanner();
            }, 420);
            currentCallbacks.onCode(code);
            return;
          }
        }
      }
    } catch {
      readyCamera.cleanupActive?.();
      releaseAttemptStream(readyCamera.stream, elements);
      if (generation !== scannerGeneration) return;
      reportScannerError(generation, currentCallbacks, 'camera-unavailable');
      return;
    }

    scannerFrame = requestAnimationFrame(scan);
  };

  scannerFrame = requestAnimationFrame(scan);
}

async function startGuestQrScanner(): Promise<void> {
  const elements = scannerElements();
  const currentCallbacks = callbacks;
  if (!elements || elements.button.disabled || !currentCallbacks || !currentCallbacks.isCurrent()) {
    return;
  }

  stopGuestQrScanner();
  const generation = ++scannerGeneration;
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  elements.button.hidden = true;
  elements.camera.hidden = false;
  elements.button.setAttribute('aria-busy', 'true');

  if (!navigator.mediaDevices?.getUserMedia) {
    reportScannerError(generation, currentCallbacks, 'camera-unavailable');
    return;
  }

  const decoderPromise = import('jsqr');
  void decoderPromise.catch(() => undefined);
  let readyCamera: ReadyCamera | null;
  try {
    readyCamera = await prepareCameraWithRetry(generation, currentCallbacks, elements);
  } catch {
    reportScannerError(generation, currentCallbacks, 'camera-unavailable');
    return;
  }
  if (!readyCamera) return;

  installActiveCameraGuard(readyCamera, generation, currentCallbacks, elements);
  try {
    elements.closeButton.focus({ preventScroll: true });
    const { default: decodeQr } = await decoderPromise;
    if (!isAttemptCurrent(generation, readyCamera.attemptToken, currentCallbacks)) {
      readyCamera.cleanupActive?.();
      releaseAttemptStream(readyCamera.stream, elements);
      return;
    }
    beginQrFrameScan(readyCamera, generation, currentCallbacks, elements, decodeQr);
  } catch {
    readyCamera.cleanupActive?.();
    releaseAttemptStream(readyCamera.stream, elements);
    reportScannerError(generation, currentCallbacks, 'camera-unavailable');
  }
}

export function initGuestQrScanner(nextCallbacks: GuestQrScannerCallbacks): void {
  callbacks = nextCallbacks;
  bindScannerLifecycle();
  if (controlsBound) return;

  const elements = scannerElements();
  if (!elements) return;
  controlsBound = true;
  elements.button.addEventListener('click', () => void startGuestQrScanner());
  elements.closeButton.addEventListener('click', () => {
    stopGuestQrScanner();
    elements.button.focus({ preventScroll: true });
  });
}
