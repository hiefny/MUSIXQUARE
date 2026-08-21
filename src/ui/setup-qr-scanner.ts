/** Guest setup QR scanner. Camera access starts only from the scan button. */

const SCAN_BUTTON_ID = 'btn-setup-qr-scan';
const CAMERA_ID = 'setup-qr-camera';
const VIDEO_ID = 'setup-qr-video';
const CLOSE_BUTTON_ID = 'btn-setup-qr-close';
const INVITE_QR_RE = /^(?:https?:\/\/)?(?:www\.)?musixquare\.com\/(\d{6})(?:[/?#]|$)/i;

export type GuestQrScannerError = 'permission-denied' | 'camera-not-found' | 'camera-unavailable';

interface GuestQrScannerCallbacks {
  isCurrent: () => boolean;
  onCode: (code: string) => void;
  onError: (reason: GuestQrScannerError) => void;
}

let callbacks: GuestQrScannerCallbacks | null = null;
let scannerGeneration = 0;
let scannerStream: MediaStream | null = null;
let scannerFrame = 0;
let scannerSuccessTimer = 0;
let controlsBound = false;

function scannerElements(): {
  button: HTMLButtonElement;
  camera: HTMLElement;
  video: HTMLVideoElement;
  closeButton: HTMLButtonElement;
} | null {
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

function classifyCameraError(error: unknown): GuestQrScannerError {
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

export function stopGuestQrScanner(): void {
  scannerGeneration += 1;
  if (scannerFrame) cancelAnimationFrame(scannerFrame);
  if (scannerSuccessTimer) window.clearTimeout(scannerSuccessTimer);
  scannerFrame = 0;
  scannerSuccessTimer = 0;
  scannerStream?.getTracks().forEach((track) => track.stop());
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

async function startGuestQrScanner(): Promise<void> {
  const elements = scannerElements();
  const currentCallbacks = callbacks;
  if (!elements || elements.button.disabled || !currentCallbacks || !currentCallbacks.isCurrent()) {
    return;
  }

  stopGuestQrScanner();
  const generation = ++scannerGeneration;
  elements.button.hidden = true;
  elements.camera.hidden = false;
  elements.button.setAttribute('aria-busy', 'true');

  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera unavailable');

    const decoderPromise = import('jsqr');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 1280 },
      },
    });

    if (generation !== scannerGeneration || !currentCallbacks.isCurrent()) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    scannerStream = stream;
    elements.video.srcObject = stream;
    await elements.video.play();
    elements.closeButton.focus({ preventScroll: true });
    const { default: decodeQr } = await decoderPromise;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('canvas unavailable');
    let lastScanAt = 0;

    const scan = (now: number): void => {
      if (generation !== scannerGeneration || !currentCallbacks.isCurrent()) {
        stopGuestQrScanner();
        return;
      }

      if (now - lastScanAt >= 100 && elements.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
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

      scannerFrame = requestAnimationFrame(scan);
    };

    scannerFrame = requestAnimationFrame(scan);
  } catch (error) {
    if (generation !== scannerGeneration) return;
    const shouldReport = currentCallbacks.isCurrent();
    stopGuestQrScanner();
    if (shouldReport) currentCallbacks.onError(classifyCameraError(error));
  }
}

export function initGuestQrScanner(nextCallbacks: GuestQrScannerCallbacks): void {
  callbacks = nextCallbacks;
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
