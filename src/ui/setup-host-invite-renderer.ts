/** Lazy renderer for the host invitation QR's fixed-grid color morph. */

import QRCode from 'qrcode';

const HOST_INVITE_QR_MARGIN = 2;
const HOST_INVITE_QR_MODULE_DELAY_MS = 9;
const SVG_NS = 'http://www.w3.org/2000/svg';

interface QrModuleMatrix {
  readonly size: number;
  get(row: number, col: number): number;
}

interface HostInviteQrMatrices {
  readonly ghost: QrModuleMatrix;
  readonly room: QrModuleMatrix;
}

type HostInviteQrModuleState =
  | 'activate'
  | 'brighten'
  | 'clear'
  | 'idle'
  | 'steady-on'
  | 'steady-off';

export function createHostInviteQrMatrices(
  ghostPayload: string,
  roomPayload: string,
): HostInviteQrMatrices {
  const options = { errorCorrectionLevel: 'L' } as const;
  return {
    ghost: QRCode.create(ghostPayload, options).modules,
    room: QRCode.create(roomPayload, options).modules,
  };
}

function validQrMatrix(matrix: QrModuleMatrix): boolean {
  return Number.isInteger(matrix.size) && matrix.size > 0 && matrix.size <= 177;
}

function moduleState(ghost: boolean, room: boolean, canMorph: boolean): HostInviteQrModuleState {
  if (!canMorph) return room ? 'steady-on' : 'steady-off';
  if (ghost && room) return 'brighten';
  if (ghost) return 'clear';
  return room ? 'activate' : 'idle';
}

export function mountHostInviteQr(
  container: HTMLElement,
  matrices: HostInviteQrMatrices,
): boolean | 'steady' {
  if (!validQrMatrix(matrices.ghost) || !validQrMatrix(matrices.room)) {
    container.replaceChildren();
    return false;
  }

  const canMorph = matrices.ghost.size === matrices.room.size;
  const document = container.ownerDocument;
  const svg = document.createElementNS(SVG_NS, 'svg');
  const background = document.createElementNS(SVG_NS, 'rect');
  const moduleLayer = document.createElementNS(SVG_NS, 'g');
  const symbolSize = matrices.room.size;
  const renderedSize = symbolSize + HOST_INVITE_QR_MARGIN * 2;

  svg.classList.add('qr-svg', 'setup-host-qr-morph-svg');
  svg.setAttribute('viewBox', `0 0 ${renderedSize} ${renderedSize}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  background.classList.add('setup-host-qr-grid-background');
  background.setAttribute('x', '0');
  background.setAttribute('y', '0');
  background.setAttribute('width', String(renderedSize));
  background.setAttribute('height', String(renderedSize));
  moduleLayer.classList.add('setup-host-qr-module-layer');

  for (let row = 0; row < symbolSize; row += 1) {
    for (let col = 0; col < symbolSize; col += 1) {
      const ghost = canMorph && matrices.ghost.get(row, col) !== 0;
      const room = matrices.room.get(row, col) !== 0;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.classList.add(
        'setup-host-qr-module',
        `setup-host-qr-module--${moduleState(ghost, room, canMorph)}`,
      );
      rect.setAttribute('x', String(col + HOST_INVITE_QR_MARGIN));
      rect.setAttribute('y', String(row + HOST_INVITE_QR_MARGIN));
      rect.setAttribute('width', '1');
      rect.setAttribute('height', '1');
      if (canMorph) {
        rect.style.animationDelay = `${(row + col) * HOST_INVITE_QR_MODULE_DELAY_MS}ms`;
      }
      moduleLayer.appendChild(rect);
    }
  }

  svg.append(background, moduleLayer);
  container.replaceChildren(svg);
  return canMorph ? true : 'steady';
}
