import { expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';

interface SizeCall {
  width: number;
  height: number;
}

interface ReconcileSnapshot {
  calls: SizeCall[];
  mutations: string[];
  playbackCalls: string[];
  wrapper: { left: number; right: number; width: number; height: number; overflowX: string };
  container: { left: number; right: number; width: number; height: number };
  iframe: {
    left: number;
    right: number;
    width: number;
    height: number;
    widthAttribute: string | null;
    heightAttribute: string | null;
    inlineWidth: string;
    inlineHeight: string;
    innerWidth: number | null;
    innerHeight: number | null;
  };
}

async function installSizeAwareYouTubeApi(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sizeCalls: SizeCall[] = [];
    const playbackCalls: string[] = [];

    class SizeAwarePlayer {
      private readonly iframe: HTMLIFrameElement;
      private readonly events: Record<string, ((event: unknown) => void) | undefined>;

      constructor(target: string | HTMLElement, options: Record<string, unknown> = {}) {
        const host =
          typeof target === 'string' ? document.getElementById(target) : (target as HTMLElement);
        if (!host) throw new Error('Missing fake YouTube host');

        const iframe = document.createElement('iframe');
        iframe.title = 'iOS size reconciliation fixture';
        iframe.setAttribute('width', String(options.width ?? '100%'));
        iframe.setAttribute('height', String(options.height ?? '100%'));
        iframe.setAttribute('frameborder', '0');
        iframe.srcdoc =
          '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style>' +
          '<div id="inner-viewport" style="width:100%;height:100%"></div>';
        host.replaceWith(iframe);
        this.iframe = iframe;
        this.events = (options.events as typeof this.events | undefined) ?? {};

        window.__ytSizeFixture = {
          player: this,
          sizeCalls,
          playbackCalls,
          emitState: (state: number) => this.events.onStateChange?.({ data: state, target: this }),
        };

        setTimeout(() => this.events.onReady?.({ target: this }), 0);
      }

      setSize(width: number, height: number): void {
        sizeCalls.push({ width, height });
        this.iframe.setAttribute('width', String(width));
        this.iframe.setAttribute('height', String(height));
      }

      getIframe(): HTMLIFrameElement {
        return this.iframe;
      }

      getPlayerState(): number {
        return 5;
      }

      getCurrentTime(): number {
        return 0;
      }

      getDuration(): number {
        return 300;
      }

      getVideoData(): { video_id: string; title: string } {
        return { video_id: 'M7lc1UVf-VE', title: 'Size reconciliation fixture' };
      }

      getPlaylistIndex(): number {
        return 0;
      }

      getPlaylist(): string[] {
        return [];
      }

      getVideoLoadedFraction(): number {
        return 1;
      }

      getVolume(): number {
        return 100;
      }

      isMuted(): boolean {
        return true;
      }

      playVideo(): void {
        playbackCalls.push('playVideo');
      }

      pauseVideo(): void {
        playbackCalls.push('pauseVideo');
      }

      stopVideo(): void {
        playbackCalls.push('stopVideo');
      }

      seekTo(): void {
        playbackCalls.push('seekTo');
      }

      setVolume(): void {
        playbackCalls.push('setVolume');
      }

      mute(): void {}
      unMute(): void {}
      cueVideoById(): void {}
      loadVideoById(): void {}
      cuePlaylist(): void {}
      loadPlaylist(): void {}
      setOption(): void {}
      getOptions(): string[] {
        return [];
      }
      destroy(): void {}
    }

    Object.defineProperty(window, 'YT', {
      configurable: true,
      value: {
        Player: SizeAwarePlayer,
        PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
      },
    });
    (window as Window & { isYouTubeAPIReady?: boolean }).isYouTubeAPIReady = true;
  });

  await page.route(/youtube\.com\/iframe_api/, (route) => route.abort());
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
}

async function openProductionReconcilerFixture(page: Page): Promise<void> {
  await installSizeAwareYouTubeApi(page);
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await waitForBootstrapReady(page);

  await page.evaluate(() => {
    document.getElementById('setup-overlay')?.classList.remove('active');
    document.body.classList.remove('overlay-open');
    document.querySelectorAll('.tab-content').forEach((tab) => {
      tab.classList.toggle('active', tab.id === 'tab-play');
    });

    const bus = (
      window as Window & { __MUSIXQUARE_BUS__?: { emit?: (...args: unknown[]) => void } }
    ).__MUSIXQUARE_BUS__;
    bus?.emit?.('youtube:load-from-chat', 'https://www.youtube.com/watch?v=M7lc1UVf-VE');
  });

  await page.waitForFunction(() => Boolean(window.__ytSizeFixture?.player));
  await expect(page.locator('#youtube-player-container iframe')).toBeAttached();
  await page.waitForFunction(() => {
    const fixture = window.__ytSizeFixture;
    const iframe = document.querySelector<HTMLIFrameElement>('#youtube-player-container iframe');
    return Boolean(
      fixture?.sizeCalls.length &&
      iframe?.getAttribute('width') === '100%' &&
      iframe.getAttribute('height') === '100%',
    );
  });
  // Player creation schedules the production display refresh at 500 ms.
  // Let that real timer (and any ResizeObserver pulse it causes) complete
  // before an individual trigger clears the trace and starts its assertions.
  await page.waitForTimeout(550);
  await waitForReconcileQuiescence(page);
}

async function settleFrames(page: Page, count = 6): Promise<void> {
  await page.evaluate(
    (frameCount) =>
      new Promise<void>((resolve) => {
        const tick = (remaining: number): void => {
          if (remaining === 0) {
            resolve();
            return;
          }
          requestAnimationFrame(() => tick(remaining - 1));
        };
        tick(frameCount);
      }),
    count,
  );
}

async function waitForReconcileQuiescence(
  page: Page,
  { quietMs = 250, timeoutMs = 5_000 }: { quietMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  await page.evaluate(
    async ({ quietMs, timeoutMs }) => {
      const deadline = performance.now() + timeoutMs;
      let previousCallCount = -1;
      let stableFrames = 0;
      let quietSince = performance.now();

      while (performance.now() < deadline) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const iframe = document.querySelector<HTMLIFrameElement>(
          '#youtube-player-container iframe',
        );
        const callCount = window.__ytSizeFixture?.sizeCalls.length ?? -1;
        const restored =
          iframe?.getAttribute('width') === '100%' && iframe.getAttribute('height') === '100%';
        const callCountStable = callCount === previousCallCount;

        if (restored && callCountStable) {
          stableFrames += 1;
        } else {
          stableFrames = restored ? 1 : 0;
          quietSince = performance.now();
        }
        previousCallCount = callCount;

        if (stableFrames >= 3 && performance.now() - quietSince >= quietMs) return;
      }

      throw new Error('YouTube size reconciler did not reach a restored quiet window');
    },
    { quietMs, timeoutMs },
  );
}

async function setViewportAndSafeInsets(
  page: Page,
  viewport: { width: number; height: number },
  safe: { left: number; right: number },
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.evaluate(
    ({ height, left, right }) => {
      document.documentElement.style.setProperty('--app-height', `${height}px`);
      document.documentElement.style.setProperty('--safe-left', `${left}px`);
      document.documentElement.style.setProperty('--safe-right', `${right}px`);
    },
    { height: viewport.height, left: safe.left, right: safe.right },
  );
  await settleFrames(page);
}

async function startMutationTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>('#youtube-player-container iframe');
    if (!iframe) throw new Error('YouTube iframe unavailable');
    const fixture = window.__ytSizeFixture!;
    fixture.mutations = [];
    fixture.observer?.disconnect();
    fixture.observer = new MutationObserver((records) => {
      for (const record of records) {
        fixture.mutations!.push(
          `${record.attributeName}:${iframe.getAttribute(record.attributeName!) ?? '<null>'}`,
        );
      }
    });
    fixture.observer.observe(iframe, {
      attributes: true,
      attributeFilter: ['width', 'height', 'style'],
    });
    window.__ytSizeFixture!.sizeCalls.length = 0;
    window.__ytSizeFixture!.playbackCalls.length = 0;
  });
}

async function readSnapshot(page: Page): Promise<ReconcileSnapshot> {
  return page.evaluate(() => {
    const rect = (element: Element) => {
      const value = element.getBoundingClientRect();
      return { left: value.left, right: value.right, width: value.width, height: value.height };
    };
    const wrapper = document.querySelector<HTMLElement>('.video-wrapper');
    const container = document.getElementById('youtube-player-container');
    const iframe = container?.querySelector<HTMLIFrameElement>('iframe');
    if (!wrapper || !container || !iframe) throw new Error('YouTube stage unavailable');

    return {
      calls: [...window.__ytSizeFixture!.sizeCalls],
      mutations: [...(window.__ytSizeFixture!.mutations ?? [])],
      playbackCalls: [...window.__ytSizeFixture!.playbackCalls],
      wrapper: { ...rect(wrapper), overflowX: getComputedStyle(wrapper).overflowX },
      container: rect(container),
      iframe: {
        ...rect(iframe),
        widthAttribute: iframe.getAttribute('width'),
        heightAttribute: iframe.getAttribute('height'),
        inlineWidth: iframe.style.width,
        inlineHeight: iframe.style.height,
        innerWidth: iframe.contentDocument?.documentElement.clientWidth ?? null,
        innerHeight: iframe.contentDocument?.documentElement.clientHeight ?? null,
      },
    };
  });
}

function expectResponsiveRestore(snapshot: ReconcileSnapshot): void {
  expect(snapshot.iframe.widthAttribute).toBe('100%');
  expect(snapshot.iframe.heightAttribute).toBe('100%');
  expect(snapshot.iframe.inlineWidth).toBe('');
  expect(snapshot.iframe.inlineHeight).toBe('');
  expect(snapshot.iframe.left).toBeCloseTo(snapshot.container.left, 1);
  expect(snapshot.iframe.right).toBeCloseTo(snapshot.container.right, 1);
  expect(snapshot.iframe.width).toBeCloseTo(snapshot.container.width, 1);
  expect(snapshot.iframe.innerWidth).toBe(Math.round(snapshot.container.width));
  expect(snapshot.iframe.innerHeight).toBe(Math.round(snapshot.container.height));
  expect(snapshot.wrapper.overflowX).not.toBe('visible');
}

declare global {
  interface Window {
    __ytSizeFixture?: {
      player: unknown;
      sizeCalls: SizeCall[];
      playbackCalls: string[];
      mutations?: string[];
      observer?: MutationObserver;
      emitState: (state: number) => void;
      pendingSettledTimers?: () => number;
      flushSettledTimers?: () => number;
    };
  }
}

test.describe('production iOS YouTube size reconciliation', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    hasTouch: true,
    isMobile: true,
  });

  test('pulses one clipped pixel, restores responsive attrs, and follows later layout changes', async ({
    page,
  }) => {
    await setViewportAndSafeInsets(page, { width: 844, height: 390 }, { left: 47, right: 0 });
    await openProductionReconcilerFixture(page);
    await settleFrames(page);

    const initial = await readSnapshot(page);
    expect(initial.calls.at(-1)).toEqual({
      width: Math.round(initial.container.width) + 1,
      height: Math.round(initial.container.height),
    });
    expectResponsiveRestore(initial);

    await startMutationTrace(page);
    await page.evaluate(() => window.__ytSizeFixture!.emitState(3));
    await page.waitForFunction(() => (window.__ytSizeFixture?.sizeCalls.length ?? 0) > 0);
    await waitForReconcileQuiescence(page);
    const mediaState = await readSnapshot(page);
    const expectedMediaStatePulse = {
      width: Math.round(mediaState.container.width) + 1,
      height: Math.round(mediaState.container.height),
    };
    expect(mediaState.calls.length).toBeGreaterThanOrEqual(1);
    expect(mediaState.calls.every((call) => call.width === expectedMediaStatePulse.width)).toBe(
      true,
    );
    expect(mediaState.calls.every((call) => call.height === expectedMediaStatePulse.height)).toBe(
      true,
    );
    expect(mediaState.mutations).toContain(`width:${Math.round(mediaState.container.width) + 1}`);
    expect(mediaState.mutations).toContain('width:100%');
    expectResponsiveRestore(mediaState);
    expect(mediaState.playbackCalls).toEqual([]);

    await startMutationTrace(page);
    await setViewportAndSafeInsets(page, { width: 932, height: 430 }, { left: 59, right: 0 });
    await page.waitForFunction(() => (window.__ytSizeFixture?.sizeCalls.length ?? 0) > 0);
    await waitForReconcileQuiescence(page);
    const rotated = await readSnapshot(page);
    expect(rotated.calls.at(-1)).toEqual({
      width: Math.round(rotated.container.width) + 1,
      height: Math.round(rotated.container.height),
    });
    expectResponsiveRestore(rotated);
    expect(rotated.playbackCalls).toEqual([]);
  });

  test('reconciles fake fullscreen and a same-size orientation refresh without playback commands', async ({
    page,
  }) => {
    await setViewportAndSafeInsets(page, { width: 844, height: 390 }, { left: 47, right: 0 });
    await openProductionReconcilerFixture(page);
    await settleFrames(page);
    await startMutationTrace(page);

    await page.evaluate(() => {
      document.body.classList.add('has-fake-fullscreen');
      document.querySelector('.video-wrapper')?.classList.add('fake-fullscreen');
    });
    await page.evaluate(() => {
      const bus = (
        window as Window & { __MUSIXQUARE_BUS__?: { emit?: (...args: unknown[]) => void } }
      ).__MUSIXQUARE_BUS__;
      bus?.emit?.('youtube:refresh-display');
    });
    await page.waitForFunction(() => {
      const fixture = window.__ytSizeFixture;
      const iframe = document.querySelector('#youtube-player-container iframe');
      return Boolean(fixture?.sizeCalls.length && iframe?.getAttribute('width') === '100%');
    });
    await waitForReconcileQuiescence(page);
    const fullscreen = await readSnapshot(page);
    expect(fullscreen.calls.length).toBeGreaterThanOrEqual(1);
    expect(fullscreen.calls.every((call) => call.width === 845 && call.height === 390)).toBe(true);
    expect(fullscreen.wrapper.left).toBeCloseTo(0, 1);
    expect(fullscreen.wrapper.right).toBeCloseTo(844, 1);
    expectResponsiveRestore(fullscreen);
    expect(fullscreen.playbackCalls).toEqual([]);

    await startMutationTrace(page);
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await page.waitForFunction(() => {
      const fixture = window.__ytSizeFixture;
      return Boolean(fixture?.sizeCalls.length);
    });
    await expect
      .poll(() => page.locator('#youtube-player-container iframe').getAttribute('width'), {
        timeout: 5_000,
      })
      .toBe('100%');
    await waitForReconcileQuiescence(page);
    const orientation = await readSnapshot(page);
    expect(orientation.calls[0]).toEqual({ width: 845, height: 390 });
    expectResponsiveRestore(orientation);
    expect(orientation.playbackCalls).toEqual([]);

    await page.waitForTimeout(550);
    await waitForReconcileQuiescence(page);
    const settledOrientation = await readSnapshot(page);
    expect(settledOrientation.calls.length).toBeGreaterThanOrEqual(2);
    expect(
      settledOrientation.calls.every((call) => call.width === 845 && call.height === 390),
    ).toBe(true);
    expectResponsiveRestore(settledOrientation);
    expect(settledOrientation.playbackCalls).toEqual([]);
  });

  test('coalesces duplicate native fullscreen timers and completes immediate and settled pulses', async ({
    page,
  }) => {
    await setViewportAndSafeInsets(page, { width: 844, height: 390 }, { left: 47, right: 0 });
    await openProductionReconcilerFixture(page);
    await settleFrames(page);
    const baseline = await readSnapshot(page);
    const expectedPulse = {
      width: Math.round(baseline.container.width) + 1,
      height: Math.round(baseline.container.height),
    };
    await startMutationTrace(page);

    await page.evaluate(() => {
      const fixture = window.__ytSizeFixture!;
      const originalSetTimeout = window.setTimeout;
      const originalClearTimeout = window.clearTimeout;
      const deferredSettledTimers = new Map<number, () => void>();
      let nextDeferredTimerId = -1;

      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 500 && typeof handler === 'function') {
          const timerId = nextDeferredTimerId--;
          deferredSettledTimers.set(timerId, () => Reflect.apply(handler, window, args));
          return timerId;
        }
        return Reflect.apply(originalSetTimeout, window, [handler, timeout, ...args]) as number;
      }) as typeof window.setTimeout;
      window.clearTimeout = ((timerId?: number) => {
        if (!deferredSettledTimers.delete(Number(timerId))) {
          Reflect.apply(originalClearTimeout, window, [timerId]);
        }
      }) as typeof window.clearTimeout;

      fixture.pendingSettledTimers = () => deferredSettledTimers.size;
      fixture.flushSettledTimers = () => {
        window.setTimeout = originalSetTimeout;
        window.clearTimeout = originalClearTimeout;
        const callbacks = [...deferredSettledTimers.values()];
        deferredSettledTimers.clear();
        callbacks.forEach((callback) => callback());
        return callbacks.length;
      };

      document.dispatchEvent(new Event('fullscreenchange'));
      document.dispatchEvent(new Event('webkitfullscreenchange'));
    });
    await page.waitForFunction(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#youtube-player-container iframe');
      return Boolean(
        (window.__ytSizeFixture?.sizeCalls.length ?? 0) >= 1 &&
        iframe?.getAttribute('width') === '100%' &&
        iframe.getAttribute('height') === '100%',
      );
    });
    await waitForReconcileQuiescence(page);

    const immediate = await readSnapshot(page);
    expect(immediate.calls.length).toBeGreaterThanOrEqual(1);
    expect(immediate.calls.every((call) => call.width === expectedPulse.width)).toBe(true);
    expect(immediate.calls.every((call) => call.height === expectedPulse.height)).toBe(true);
    expect(await page.evaluate(() => window.__ytSizeFixture!.pendingSettledTimers?.())).toBe(1);
    expectResponsiveRestore(immediate);
    expect(immediate.playbackCalls).toEqual([]);

    const immediateCallCount = immediate.calls.length;
    expect(await page.evaluate(() => window.__ytSizeFixture!.flushSettledTimers?.())).toBe(1);
    await page.waitForFunction(
      (previousCallCount) => {
        const iframe = document.querySelector<HTMLIFrameElement>(
          '#youtube-player-container iframe',
        );
        return Boolean(
          (window.__ytSizeFixture?.sizeCalls.length ?? 0) > previousCallCount &&
          iframe?.getAttribute('width') === '100%' &&
          iframe.getAttribute('height') === '100%',
        );
      },
      immediateCallCount,
      { timeout: 2_000 },
    );
    await waitForReconcileQuiescence(page);

    const settled = await readSnapshot(page);
    expect(settled.calls.length).toBeGreaterThan(immediateCallCount);
    expect(settled.calls.every((call) => call.width === expectedPulse.width)).toBe(true);
    expect(settled.calls.every((call) => call.height === expectedPulse.height)).toBe(true);
    expectResponsiveRestore(settled);
    expect(settled.playbackCalls).toEqual([]);
  });
});
