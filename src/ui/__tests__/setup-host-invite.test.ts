/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
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

import { animateTransition } from '../dom.ts';
import {
  finishHostInviteLoading,
  resetHostInviteVisual,
  revealHostInviteQr,
} from '../setup-host-invite.ts';

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
    expect(stage?.classList.contains('is-room-qr-loading')).toBe(false);
    expect(stage?.getAttribute('aria-busy')).toBe('false');
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
    expect(document.getElementById('setup-host-invite-stage')?.getAttribute('aria-busy')).toBe(
      'true',
    );
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
    expect(
      document.getElementById('setup-host-invite-stage')?.classList.contains('is-room-qr-loading'),
    ).toBe(true);
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
    expect(document.getElementById('setup-host-invite-stage')?.getAttribute('aria-busy')).toBe(
      'false',
    );
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it('stops loading when the encoder returns no SVG root', async () => {
    mocks.toString.mockResolvedValueOnce('<span>invalid QR output</span>');

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

  describe('hidden loading spinner', () => {
    function spinner(): HTMLElement {
      return document.querySelector<HTMLElement>('.setup-host-qr-loading-spinner')!;
    }

    function endTransition(propertyName: string): void {
      const event = new Event('transitionend');
      Object.defineProperty(event, 'propertyName', { value: propertyName });
      spinner().dispatchEvent(event);
    }

    it('holds every moving part of a paused spinner', () => {
      // The turn, the arc's frame and both half rings (src/ui/material-elastic-spinner.ts).
      expect(readFileSync('css/style.css', 'utf8')).toMatch(
        /\.setup-host-qr-loading-spinner\.is-paused \.material-elastic-turn,\s*\.setup-host-qr-loading-spinner\.is-paused \.material-elastic-arc,\s*\.setup-host-qr-loading-spinner\.is-paused \.material-elastic-tail > \.material-elastic-ring,\s*\.setup-host-qr-loading-spinner\.is-paused \.material-elastic-head > \.material-elastic-ring \{\s*animation-play-state: paused;/u,
      );
    });

    it('pauses its animations only once the fade-out has hidden it', async () => {
      mocks.toString.mockResolvedValueOnce('<svg><path d="M0 0h1v1z"/></svg>');
      await expect(revealHostInviteQr('654321', () => true)).resolves.toBe(true);
      expect(spinner().classList.contains('is-paused')).toBe(false);

      endTransition('opacity');
      expect(spinner().classList.contains('is-paused')).toBe(false);
      endTransition('visibility');
      expect(spinner().classList.contains('is-paused')).toBe(true);
    });

    it('pauses after the fade-out time when no transition reports its end', () => {
      vi.useFakeTimers();
      try {
        // Reduced motion turns the transition off, so transitionend never comes.
        finishHostInviteLoading();
        vi.advanceTimersByTime(249);
        expect(spinner().classList.contains('is-paused')).toBe(false);
        vi.advanceTimersByTime(1);
        expect(spinner().classList.contains('is-paused')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('runs again before the loading class brings it back', () => {
      finishHostInviteLoading();
      endTransition('visibility');
      const stage = document.getElementById('setup-host-invite-stage')!;
      const observer = new MutationObserver(() => {});
      observer.observe(stage, { attributes: true, attributeFilter: ['class'], subtree: true });

      resetHostInviteVisual();

      const order = observer
        .takeRecords()
        .map((record) => (record.target === stage ? 'stage' : 'spinner'));
      observer.disconnect();
      expect(order.slice(-2)).toEqual(['spinner', 'stage']);
      expect(spinner().classList.contains('is-paused')).toBe(false);
      expect(stage.classList.contains('is-room-qr-loading')).toBe(true);
    });

    it('never pauses a spinner that is loading again', () => {
      vi.useFakeTimers();
      try {
        finishHostInviteLoading();
        resetHostInviteVisual();
        endTransition('visibility');
        vi.advanceTimersByTime(1_000);
        expect(spinner().classList.contains('is-paused')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // The spinner never enters the images of a view transition of the page
  // (src/ui/dom.ts): it shows once the transition is over, never if the room
  // code arrives first, and one already on screen stays.
  describe('while the page runs a view transition', () => {
    let originalTransition: PropertyDescriptor | undefined;
    let update: () => void;
    let finish: () => void;

    function stage(): HTMLElement {
      return document.getElementById('setup-host-invite-stage')!;
    }

    function spinner(): HTMLElement {
      return document.querySelector<HTMLElement>('.setup-host-qr-loading-spinner')!;
    }

    async function flushTransitionTasks(): Promise<void> {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    beforeEach(() => {
      vi.useFakeTimers();
      // Start from a spinner the last code hid, as Retry does.
      finishHostInviteLoading();
      vi.advanceTimersByTime(250);
      update = () => {};
      finish = () => {};
      originalTransition = Object.getOwnPropertyDescriptor(document, 'startViewTransition');
      Object.defineProperty(document, 'startViewTransition', {
        configurable: true,
        value: vi.fn((callback: () => void) => {
          update = callback;
          return {
            ready: Promise.resolve(),
            updateCallbackDone: Promise.resolve(),
            finished: new Promise<void>((resolve) => {
              finish = resolve;
            }),
          };
        }),
      });
    });

    afterEach(async () => {
      // Start a batch still waiting, then settle and release its transition,
      // so no state of the page's one transition owner leaks into the next row.
      await flushTransitionTasks();
      finish();
      await flushTransitionTasks();
      vi.advanceTimersToNextFrame();
      if (originalTransition) {
        Object.defineProperty(document, 'startViewTransition', originalTransition);
      } else {
        Reflect.deleteProperty(document, 'startViewTransition');
      }
      vi.useRealTimers();
    });

    it('shows the spinner once the transition batched with the loading state has ended', async () => {
      expect(spinner().classList.contains('is-paused')).toBe(true);
      // The Host tap's step change and the code flow's loading state, in one task.
      animateTransition(() => {});
      resetHostInviteVisual();
      expect(stage().getAttribute('aria-busy')).toBe('true');
      expect(stage().classList.contains('is-room-qr-loading')).toBe(false);

      await flushTransitionTasks();
      update();
      finish();
      await flushTransitionTasks();
      expect(stage().classList.contains('is-room-qr-loading')).toBe(false);

      // The transition's marks go one frame after it ends; the spinner then
      // resumes and fades in.
      vi.advanceTimersToNextFrame();
      expect(stage().classList.contains('is-room-qr-loading')).toBe(true);
      expect(spinner().classList.contains('is-paused')).toBe(false);
    });

    it('never shows the spinner when the room code arrives during the transition', async () => {
      animateTransition(() => {});
      resetHostInviteVisual();
      await flushTransitionTasks();
      update();

      mocks.toString.mockResolvedValueOnce('<svg><path d="M0 0h1v1z"/></svg>');
      await expect(revealHostInviteQr('654321', () => true)).resolves.toBe(true);
      expect(stage().classList.contains('is-room-qr-visible')).toBe(true);
      expect(stage().getAttribute('aria-busy')).toBe('false');

      finish();
      await flushTransitionTasks();
      vi.advanceTimersToNextFrame();
      expect(stage().classList.contains('is-room-qr-loading')).toBe(false);
    });

    it('keeps a spinner that is already on screen', async () => {
      resetHostInviteVisual();
      expect(stage().classList.contains('is-room-qr-loading')).toBe(true);
      Object.defineProperty(spinner(), 'getClientRects', {
        configurable: true,
        value: () => [{ width: 42, height: 42 }],
      });

      // The room code arrives while a transition of the page is batched.
      animateTransition(() => {});
      let resolveSvg!: (value: string) => void;
      mocks.toString.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveSvg = resolve;
          }),
      );
      const reveal = revealHostInviteQr('654321', () => true);

      expect(stage().classList.contains('is-room-qr-loading')).toBe(true);
      expect(stage().getAttribute('aria-busy')).toBe('true');
      await vi.waitFor(() => expect(resolveSvg).toBeTypeOf('function'));
      resolveSvg('<svg><path d="M0 0h1v1z"/></svg>');
      await expect(reveal).resolves.toBe(true);
    });
  });

  it('rejects a non-canonical code without loading the encoder', async () => {
    await expect(revealHostInviteQr('12345', () => true)).resolves.toBe(false);
    expect(mocks.toString).not.toHaveBeenCalled();
  });

  it('retries the encoder chunk when the preload failed', async () => {
    vi.resetModules();
    let attempts = 0;
    vi.doMock('qrcode', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('chunk unavailable');
      return { default: { toString: mocks.toString } };
    });
    try {
      const invite = await import('../setup-host-invite.ts');
      invite.resetHostInviteVisual();

      invite.preloadHostInviteQrEncoder();
      await vi.waitFor(() => expect(attempts).toBe(1));
      mocks.toString.mockResolvedValueOnce('<svg><path d="M0 0h1v1z"/></svg>');

      await expect(invite.revealHostInviteQr('123456', () => true)).resolves.toBe(true);
      expect(attempts).toBe(2);
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('qrcode');
    }
  });

  it('retries the encoder when a pending preload fails under the reveal', async () => {
    vi.resetModules();
    let attempts = 0;
    let failFirstLoad!: () => void;
    const firstLoadSettles = new Promise<void>((resolve) => {
      failFirstLoad = resolve;
    });
    vi.doMock('qrcode', async () => {
      attempts += 1;
      if (attempts === 1) {
        await firstLoadSettles;
        throw new Error('chunk unavailable');
      }
      return { default: { toString: mocks.toString } };
    });
    try {
      const invite = await import('../setup-host-invite.ts');
      invite.resetHostInviteVisual();
      mocks.toString.mockResolvedValueOnce('<svg><path d="M0 0h1v1z"/></svg>');

      invite.preloadHostInviteQrEncoder();
      await vi.waitFor(() => expect(attempts).toBe(1));
      // The code arrives while the preload is still in flight.
      const reveal = invite.revealHostInviteQr('123456', () => true);
      failFirstLoad();

      await expect(reveal).resolves.toBe(true);
      expect(attempts).toBe(2);
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('qrcode');
    }
  });
});
