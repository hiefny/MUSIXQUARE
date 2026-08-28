/** Host setup invitation QR crossfade. */

import { log } from '../core/log.ts';

const HOST_INVITE_STAGE_ID = 'setup-host-invite-stage';
const HOST_INVITE_PLACEHOLDER_QR_ID = 'setup-host-qr-placeholder';
const HOST_INVITE_QR_ID = 'setup-host-qr';
const INVITE_CODE_RE = /^\d{6}$/;
const HOST_INVITE_ROOT = 'MUSIXQUARE.COM';

let hostInviteRenderGeneration = 0;

function hostInviteElements(): {
  stage: HTMLElement;
  placeholderQr: HTMLElement;
  roomQr: HTMLElement;
} | null {
  const stage = document.getElementById(HOST_INVITE_STAGE_ID);
  const placeholderQr = document.getElementById(HOST_INVITE_PLACEHOLDER_QR_ID);
  const roomQr = document.getElementById(HOST_INVITE_QR_ID);
  if (!stage || !placeholderQr || !roomQr) return null;
  return { stage, placeholderQr, roomQr };
}

async function encodeHostInviteQr(payload: string): Promise<string> {
  const { default: QRCode } = await import('qrcode');
  return QRCode.toString(payload, {
    type: 'svg',
    margin: 2,
    errorCorrectionLevel: 'L',
    color: {
      dark: '#000000',
      light: '#00000000',
    },
  });
}

function mountQrSvg(container: HTMLElement, svgString: string): boolean {
  container.innerHTML = svgString;
  const svg = container.querySelector('svg');
  if (!svg) {
    container.replaceChildren();
    return false;
  }

  svg.classList.add('qr-svg');
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return true;
}

function setHostInviteLoading(elements: { stage: HTMLElement }, loading: boolean): void {
  elements.stage.classList.toggle('is-room-qr-loading', loading);
  elements.stage.setAttribute('aria-busy', String(loading));
}

export function finishHostInviteLoading(): void {
  const elements = hostInviteElements();
  if (elements) setHostInviteLoading(elements, false);
}

export function resetHostInviteVisual(): void {
  hostInviteRenderGeneration += 1;
  const elements = hostInviteElements();
  if (!elements) return;

  elements.stage.classList.remove('is-room-qr-visible');
  setHostInviteLoading(elements, true);
  elements.roomQr.setAttribute('aria-hidden', 'true');
  elements.roomQr.replaceChildren();
}

export async function revealHostInviteQr(code: string, isCurrent: () => boolean): Promise<boolean> {
  if (!INVITE_CODE_RE.test(code)) return false;

  const elements = hostInviteElements();
  if (!elements) return false;

  const generation = ++hostInviteRenderGeneration;
  setHostInviteLoading(elements, true);

  try {
    const svgString = await encodeHostInviteQr(`${HOST_INVITE_ROOT}/${code}`);

    if (generation !== hostInviteRenderGeneration || !isCurrent()) return false;
    if (!mountQrSvg(elements.roomQr, svgString)) {
      setHostInviteLoading(elements, false);
      return false;
    }

    elements.roomQr.setAttribute('aria-hidden', 'false');
    void elements.stage.offsetWidth;
    elements.stage.classList.add('is-room-qr-visible');
    setHostInviteLoading(elements, false);
    return true;
  } catch (error) {
    if (generation === hostInviteRenderGeneration) {
      setHostInviteLoading(elements, false);
      log.warn('[Setup] Host invitation QR generation failed', error);
    }
    return false;
  }
}
