/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toString: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('qrcode', () => ({
  default: { toString: mocks.toString },
}));

vi.mock('../../core/log.ts', () => ({
  log: { warn: mocks.warn },
}));

import { resetHostInviteVisual, revealHostInviteQr } from '../setup-host-invite.ts';

function renderStage(): void {
  document.body.innerHTML = `
    <div id="setup-host-invite-stage" class="setup-host-invite-stage">
      <div id="setup-host-qr-placeholder" aria-hidden="true"></div>
      <div id="setup-host-qr" aria-hidden="true"></div>
    </div>
  `;
}

beforeEach(() => {
  vi.clearAllMocks();
  renderStage();
  resetHostInviteVisual();
});

describe('host setup invitation QR', () => {
  it('renders the canonical invite payload and reveals it only after the SVG is ready', async () => {
    mocks.toString.mockResolvedValueOnce(
      '<svg width="120" height="120"><path d="M0 0h1v1z"/></svg>',
    );

    await expect(revealHostInviteQr('654321', () => true)).resolves.toBe(true);

    expect(mocks.toString).toHaveBeenCalledWith(
      'MUSIXQUARE.COM/654321',
      expect.objectContaining({
        type: 'svg',
        margin: 2,
        errorCorrectionLevel: 'L',
        color: {
          dark: '#000000',
          light: '#00000000',
        },
      }),
    );
    const stage = document.getElementById('setup-host-invite-stage');
    const placeholder = document.getElementById('setup-host-qr-placeholder');
    const qr = document.getElementById('setup-host-qr');
    const svg = qr?.querySelector('svg');

    expect(stage?.classList.contains('is-room-qr-visible')).toBe(true);
    expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
    expect(qr?.getAttribute('aria-hidden')).toBe('false');
    expect(svg?.classList.contains('qr-svg')).toBe(true);
    expect(svg?.hasAttribute('width')).toBe(false);
    expect(svg?.hasAttribute('height')).toBe(false);
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('discards an encoded QR when navigation supersedes the host-code flow', async () => {
    let resolveSvg!: (value: string) => void;
    mocks.toString.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveSvg = resolve;
        }),
    );

    const render = revealHostInviteQr('123456', () => false);
    await vi.waitFor(() => expect(resolveSvg).toBeTypeOf('function'));
    resolveSvg('<svg><path d="M0 0h1v1z"/></svg>');

    await expect(render).resolves.toBe(false);
    expect(document.getElementById('setup-host-invite-stage')?.className).not.toContain(
      'is-room-qr-visible',
    );
    expect(document.getElementById('setup-host-qr')?.children).toHaveLength(0);
  });

  it('returns to the placeholder and invalidates an in-flight render for a retry', async () => {
    let resolveSvg!: (value: string) => void;
    mocks.toString.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveSvg = resolve;
        }),
    );

    const render = revealHostInviteQr('123456', () => true);
    await vi.waitFor(() => expect(resolveSvg).toBeTypeOf('function'));
    resetHostInviteVisual();
    resolveSvg('<svg><path d="M0 0h1v1z"/></svg>');

    await expect(render).resolves.toBe(false);
    expect(
      document.getElementById('setup-host-invite-stage')?.classList.contains('is-room-qr-visible'),
    ).toBe(false);
    expect(document.getElementById('setup-host-qr-placeholder')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(document.getElementById('setup-host-qr')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.getElementById('setup-host-qr')?.children).toHaveLength(0);
  });

  it('keeps the placeholder visible when encoding fails', async () => {
    mocks.toString.mockRejectedValueOnce(new Error('encoder unavailable'));

    await expect(revealHostInviteQr('123456', () => true)).resolves.toBe(false);

    expect(document.getElementById('setup-host-invite-stage')?.className).not.toContain(
      'is-room-qr-visible',
    );
    expect(document.getElementById('setup-host-qr-placeholder')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(document.getElementById('setup-host-qr')?.getAttribute('aria-hidden')).toBe('true');
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it('rejects a non-canonical code without loading the encoder', async () => {
    await expect(revealHostInviteQr('12345', () => true)).resolves.toBe(false);
    expect(mocks.toString).not.toHaveBeenCalled();
  });
});
