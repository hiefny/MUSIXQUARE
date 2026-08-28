/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('qrcode', () => ({
  default: { create: mocks.create },
}));

vi.mock('../../core/log.ts', () => ({
  log: { warn: mocks.warn },
}));

import {
  finishHostInviteLoading,
  resetHostInviteVisual,
  revealHostInviteQr,
} from '../setup-host-invite.ts';

function matrix(rows: readonly string[]) {
  return {
    modules: {
      size: rows.length,
      get: (row: number, col: number) => Number(rows[row]?.[col] ?? '0'),
    },
  };
}

function moduleCoordinates(modules: {
  readonly size: number;
  get(row: number, col: number): number;
}): string[] {
  const coordinates: string[] = [];
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      if (modules.get(row, col)) coordinates.push(`${row}:${col}`);
    }
  }
  return coordinates;
}

const ghostMatrix = matrix(['100', '010', '001']);
const roomMatrix = matrix(['110', '010', '100']);

function useDefaultMatrices(): void {
  mocks.create.mockImplementation((payload: string) =>
    payload === 'MUSIXQUARE.COM' ? ghostMatrix : roomMatrix,
  );
}

function renderStage(): void {
  document.body.innerHTML = `
    <div id="setup-host-invite-stage" class="setup-host-invite-stage" aria-busy="false">
      <div id="setup-host-qr-placeholder" aria-hidden="true"></div>
      <div id="setup-host-qr" aria-hidden="true"></div>
      <span class="material-elastic-spinner setup-host-qr-loading-spinner" aria-hidden="true"></span>
    </div>
  `;
}

beforeEach(() => {
  vi.clearAllMocks();
  useDefaultMatrices();
  renderStage();
  resetHostInviteVisual();
});

describe('host setup invitation QR', () => {
  it('replaces the ghost modules diagonally with the canonical room QR modules', async () => {
    await expect(revealHostInviteQr('654321', () => true)).resolves.toBe(true);

    expect(mocks.create).toHaveBeenNthCalledWith(1, 'MUSIXQUARE.COM', {
      errorCorrectionLevel: 'L',
    });
    expect(mocks.create).toHaveBeenNthCalledWith(2, 'MUSIXQUARE.COM/654321', {
      errorCorrectionLevel: 'L',
    });

    const stage = document.getElementById('setup-host-invite-stage');
    const placeholder = document.getElementById('setup-host-qr-placeholder');
    const qr = document.getElementById('setup-host-qr');
    const svg = qr?.querySelector('svg');
    const rects = Array.from(svg?.querySelectorAll<SVGRectElement>('.setup-host-qr-module') ?? []);
    const background = svg?.querySelector('.setup-host-qr-grid-background');
    const moduleLayer = svg?.querySelector('.setup-host-qr-module-layer');

    expect(stage?.classList.contains('is-room-qr-visible')).toBe(true);
    expect(stage?.classList.contains('is-room-qr-morphing')).toBe(true);
    expect(stage?.classList.contains('is-room-qr-loading')).toBe(false);
    expect(stage?.getAttribute('aria-busy')).toBe('false');
    expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
    expect(qr?.getAttribute('aria-hidden')).toBe('false');
    expect(svg?.classList.contains('qr-svg')).toBe(true);
    expect(svg?.classList.contains('setup-host-qr-morph-svg')).toBe(true);
    expect(svg?.getAttribute('viewBox')).toBe('0 0 7 7');
    expect(svg?.getAttribute('shape-rendering')).toBe('crispEdges');
    expect(svg?.hasAttribute('width')).toBe(false);
    expect(svg?.hasAttribute('height')).toBe(false);
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('focusable')).toBe('false');
    expect(svg?.querySelector('path')).toBeNull();
    expect(moduleLayer?.children).toHaveLength(9);
    expect(background?.getAttribute('x')).toBe('0');
    expect(background?.getAttribute('y')).toBe('0');
    expect(background?.getAttribute('width')).toBe('7');
    expect(background?.getAttribute('height')).toBe('7');
    expect(rects).toHaveLength(9);

    expect(rects.map((rect) => [rect.getAttribute('x'), rect.getAttribute('y')])).toEqual([
      ['2', '2'],
      ['3', '2'],
      ['4', '2'],
      ['2', '3'],
      ['3', '3'],
      ['4', '3'],
      ['2', '4'],
      ['3', '4'],
      ['4', '4'],
    ]);
    expect(rects.map((rect) => rect.classList.item(1))).toEqual([
      'setup-host-qr-module--brighten',
      'setup-host-qr-module--activate',
      'setup-host-qr-module--idle',
      'setup-host-qr-module--idle',
      'setup-host-qr-module--brighten',
      'setup-host-qr-module--idle',
      'setup-host-qr-module--activate',
      'setup-host-qr-module--idle',
      'setup-host-qr-module--clear',
    ]);
    expect(rects.map((rect) => rect.style.animationDelay)).toEqual([
      '0ms',
      '9ms',
      '18ms',
      '9ms',
      '18ms',
      '27ms',
      '18ms',
      '27ms',
      '36ms',
    ]);
    expect(rects.every((rect) => rect.getAttribute('width') === '1')).toBe(true);
    expect(rects.every((rect) => rect.getAttribute('height') === '1')).toBe(true);
  });

  it('matches the authored ghost and final room coordinates from the real QR encoder', async () => {
    const actualQr = await vi.importActual<typeof import('qrcode')>('qrcode');
    mocks.create.mockImplementation(actualQr.create);

    await expect(revealHostInviteQr('123456', () => true)).resolves.toBe(true);

    const rects = Array.from(
      document.querySelectorAll<SVGRectElement>('#setup-host-qr .setup-host-qr-module'),
    );
    const rectCoordinate = (rect: SVGRectElement): string => {
      const row = Number(rect.getAttribute('y')) - 2;
      const col = Number(rect.getAttribute('x')) - 2;
      return `${row}:${col}`;
    };
    const initialCoordinates = rects
      .filter(
        (rect) =>
          rect.classList.contains('setup-host-qr-module--brighten') ||
          rect.classList.contains('setup-host-qr-module--clear'),
      )
      .map(rectCoordinate);
    const finalCoordinates = rects
      .filter(
        (rect) =>
          rect.classList.contains('setup-host-qr-module--brighten') ||
          rect.classList.contains('setup-host-qr-module--activate'),
      )
      .map(rectCoordinate);
    const ghost = actualQr.create('MUSIXQUARE.COM', { errorCorrectionLevel: 'L' }).modules;
    const room = actualQr.create('MUSIXQUARE.COM/123456', { errorCorrectionLevel: 'L' }).modules;

    expect(ghost.size).toBe(21);
    expect(room.size).toBe(21);
    expect(document.querySelector('#setup-host-qr svg')?.getAttribute('viewBox')).toBe('0 0 25 25');
    expect(rects).toHaveLength(441);
    expect(document.querySelectorAll('#setup-host-qr path')).toHaveLength(0);
    expect(document.querySelectorAll('.setup-host-qr-grid-background')).toHaveLength(1);
    expect(initialCoordinates).toEqual(moduleCoordinates(ghost));
    expect(finalCoordinates).toEqual(moduleCoordinates(room));
  });

  it('discards encoded matrices when navigation supersedes the host-code flow', async () => {
    await expect(revealHostInviteQr('123456', () => false)).resolves.toBe(false);

    expect(document.getElementById('setup-host-invite-stage')?.className).not.toContain(
      'is-room-qr-visible',
    );
    expect(document.getElementById('setup-host-qr')?.children).toHaveLength(0);
    expect(document.getElementById('setup-host-invite-stage')?.getAttribute('aria-busy')).toBe(
      'true',
    );
  });

  it('returns to the placeholder and invalidates an in-flight render for a retry', async () => {
    let resetDuringRender = false;
    mocks.create.mockImplementation((payload: string) => {
      if (!resetDuringRender && payload === 'MUSIXQUARE.COM') {
        resetDuringRender = true;
        resetHostInviteVisual();
      }
      return payload === 'MUSIXQUARE.COM' ? ghostMatrix : roomMatrix;
    });

    await expect(revealHostInviteQr('123456', () => true)).resolves.toBe(false);

    expect(
      document.getElementById('setup-host-invite-stage')?.classList.contains('is-room-qr-visible'),
    ).toBe(false);
    expect(document.getElementById('setup-host-qr-placeholder')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(document.getElementById('setup-host-qr')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.getElementById('setup-host-qr')?.children).toHaveLength(0);
    expect(
      document.getElementById('setup-host-invite-stage')?.classList.contains('is-room-qr-loading'),
    ).toBe(true);
  });

  it('keeps the placeholder visible when encoding fails', async () => {
    mocks.create.mockImplementationOnce(() => {
      throw new Error('encoder unavailable');
    });

    await expect(revealHostInviteQr('123456', () => true)).resolves.toBe(false);

    expect(document.getElementById('setup-host-invite-stage')?.className).not.toContain(
      'is-room-qr-visible',
    );
    expect(document.getElementById('setup-host-qr-placeholder')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(document.getElementById('setup-host-qr')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.getElementById('setup-host-invite-stage')?.getAttribute('aria-busy')).toBe(
      'false',
    );
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it('shows a steady final QR when the ghost and room symbols do not share a grid', async () => {
    mocks.create.mockImplementation((payload: string) =>
      payload === 'MUSIXQUARE.COM' ? ghostMatrix : matrix(['10', '01']),
    );

    await expect(revealHostInviteQr('123456', () => true)).resolves.toBe(true);

    const stage = document.getElementById('setup-host-invite-stage');
    expect(stage?.classList.contains('is-room-qr-visible')).toBe(true);
    expect(stage?.classList.contains('is-room-qr-morphing')).toBe(false);
    expect(stage?.classList.contains('is-room-qr-loading')).toBe(false);
    expect(stage?.getAttribute('aria-busy')).toBe('false');
    expect(document.querySelectorAll('.setup-host-qr-module')).toHaveLength(4);
    expect(document.querySelectorAll('.setup-host-qr-module--steady-on')).toHaveLength(2);
    expect(document.querySelectorAll('.setup-host-qr-module--steady-off')).toHaveLength(2);
    expect(document.querySelectorAll('#setup-host-qr path')).toHaveLength(0);
  });

  it('stops loading when the encoder returns an invalid matrix', async () => {
    mocks.create.mockReturnValueOnce(matrix([]));
    mocks.create.mockReturnValueOnce(roomMatrix);

    await expect(revealHostInviteQr('123456', () => true)).resolves.toBe(false);

    const stage = document.getElementById('setup-host-invite-stage');
    expect(stage?.classList.contains('is-room-qr-loading')).toBe(false);
    expect(stage?.getAttribute('aria-busy')).toBe('false');
  });

  it('stops the placeholder loader when host session creation fails before QR encoding', () => {
    const stage = document.getElementById('setup-host-invite-stage');
    expect(stage?.classList.contains('is-room-qr-loading')).toBe(true);

    finishHostInviteLoading();

    expect(stage?.classList.contains('is-room-qr-loading')).toBe(false);
    expect(stage?.getAttribute('aria-busy')).toBe('false');
  });

  it('rejects a non-canonical code without loading the encoder', async () => {
    await expect(revealHostInviteQr('12345', () => true)).resolves.toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
