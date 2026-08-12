import { expect, test, type Locator, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';

type ScrollDriver = 'timeline' | 'script';

interface ScrollFixture {
  owner: Locator;
  track: Locator;
  thumb: Locator;
  visual: Locator;
}

async function skipIfScrollTimelineUnavailable(page: Page): Promise<void> {
  const unavailable = await page.evaluate(
    () =>
      typeof (globalThis as typeof globalThis & { ScrollTimeline?: unknown }).ScrollTimeline !==
      'function',
  );
  test.skip(unavailable, 'This browser does not expose the ScrollTimeline constructor');
}

async function openReadyApp(page: Page): Promise<void> {
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await waitForBootstrapReady(page);
  await page.locator('#btn-setup-host').waitFor({ state: 'visible', timeout: 15_000 });
  await page.evaluate(() => {
    document.getElementById('setup-overlay')?.classList.remove('active');
    document.body.classList.remove('overlay-open');
  });
}

async function installFixture(page: Page): Promise<ScrollFixture> {
  await page.evaluate(() => {
    const shell = document.getElementById('tab-play');
    const owner = shell?.querySelector<HTMLElement>(':scope > .tab-body');
    const track = shell?.querySelector<HTMLElement>(':scope > .cscroll-track');
    if (!shell || !owner || !track) throw new Error('Play-tab scrollbar fixture is unavailable');

    const setImportant = (element: HTMLElement, property: string, value: string): void => {
      element.style.setProperty(property, value, 'important');
    };
    setImportant(shell, 'display', 'block');
    setImportant(shell, 'position', 'fixed');
    setImportant(shell, 'inset', '20px auto auto 20px');
    setImportant(shell, 'width', '280px');
    setImportant(shell, 'height', '260px');
    setImportant(shell, 'overflow', 'hidden');
    setImportant(shell, 'z-index', '10000');

    owner.replaceChildren();
    owner.setAttribute('data-custom-scroll-contained', '');
    setImportant(owner, 'display', 'block');
    setImportant(owner, 'position', 'absolute');
    setImportant(owner, 'inset', '10px auto auto 10px');
    setImportant(owner, 'box-sizing', 'border-box');
    setImportant(owner, 'width', '220px');
    setImportant(owner, 'height', '200px');
    setImportant(owner, 'margin', '0');
    setImportant(owner, 'padding', '0');
    setImportant(owner, 'border', '0');
    setImportant(owner, 'overflow-y', 'auto');

    const content = document.createElement('div');
    content.dataset.scrollFixtureContent = '1';
    content.style.width = '1px';
    content.style.height = '1000px';
    owner.appendChild(content);

    track.classList.add('cscroll-track-contained');
    track.style.setProperty('right', '10px', 'important');
    track.style.setProperty('z-index', '10001', 'important');

    const runtime = window as Window & {
      __MUSIXQUARE_BUS__?: { emit(type: string, ...args: unknown[]): void };
    };
    runtime.__MUSIXQUARE_BUS__?.emit('ui:scrollbar-relayout');
  });

  const owner = page.locator('#tab-play > .tab-body');
  const track = page.locator('#tab-play > .cscroll-track');
  const thumb = track.locator(':scope > .cscroll-thumb');
  const visual = thumb.locator(':scope > .cscroll-thumb-visual');
  await expect
    .poll(() => owner.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await expect
    .poll(() => track.evaluate((element) => element.getBoundingClientRect().height))
    .toBe(200);
  await expect(thumb).toBeVisible();
  await expect(visual).toBeVisible();
  return { owner, track, thumb, visual };
}

async function installNestedFixture(
  page: Page,
): Promise<{ outer: ScrollFixture; inner: ScrollFixture }> {
  const inner = await installFixture(page);
  await page.evaluate(() => {
    const owner = document.getElementById('tab-play');
    const track = document.body.querySelector<HTMLElement>(':scope > .cscroll-track');
    if (!owner || !track) throw new Error('Outer play-tab scrollbar fixture is unavailable');

    owner.setAttribute('data-custom-scroll-contained', '');
    owner.style.setProperty('height', '240px', 'important');
    owner.style.setProperty('overflow-y', 'auto', 'important');
    const content = document.createElement('div');
    content.dataset.outerScrollFixtureContent = '1';
    content.style.width = '1px';
    content.style.height = '900px';
    owner.appendChild(content);

    track.classList.add('cscroll-track-contained');
    track.style.setProperty('right', '0', 'important');
    track.style.setProperty('z-index', '10002', 'important');
    const runtime = window as Window & {
      __MUSIXQUARE_BUS__?: { emit(type: string, ...args: unknown[]): void };
    };
    runtime.__MUSIXQUARE_BUS__?.emit('ui:scrollbar-relayout');
  });

  const outerTrack = page.locator('body > .cscroll-track').first();
  const outer = {
    owner: page.locator('#tab-play'),
    track: outerTrack,
    thumb: outerTrack.locator(':scope > .cscroll-thumb'),
    visual: outerTrack.locator(':scope > .cscroll-thumb > .cscroll-thumb-visual'),
  };
  await expect
    .poll(() => outer.owner.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await expect
    .poll(() => outer.track.evaluate((element) => element.getBoundingClientRect().height))
    .toBe(240);
  return { outer, inner };
}

async function waitForDriver(fixture: ScrollFixture, driver: ScrollDriver): Promise<void> {
  await expect(fixture.track).toHaveAttribute('data-scroll-driver', driver);
}

async function scrollToRatio(fixture: ScrollFixture, ratio: number): Promise<void> {
  await fixture.owner.evaluate((element, nextRatio) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * nextRatio;
    element.dispatchEvent(new Event('scroll'));
  }, ratio);
}

async function thumbMetrics(fixture: ScrollFixture): Promise<{ maxTop: number; top: number }> {
  return fixture.thumb.evaluate((thumb) => {
    const track = thumb.parentElement!;
    const transform = getComputedStyle(thumb).transform;
    const top = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
    return {
      maxTop: track.getBoundingClientRect().height - thumb.getBoundingClientRect().height,
      top,
    };
  });
}

async function expectThumbAtRatio(fixture: ScrollFixture, ratio: number): Promise<void> {
  await expect
    .poll(async () => {
      const { maxTop, top } = await thumbMetrics(fixture);
      return Math.abs(top - maxTop * ratio);
    })
    .toBeLessThan(1);
}

async function exposeSyntheticScrollTop(fixture: ScrollFixture, scrollTop: number): Promise<void> {
  await fixture.owner.evaluate((element, syntheticScrollTop) => {
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => syntheticScrollTop,
    });
    element.dispatchEvent(new Event('scroll'));
  }, scrollTop);
}

async function restoreNativeScrollTop(fixture: ScrollFixture): Promise<void> {
  await fixture.owner.evaluate((element) => {
    if (!Reflect.deleteProperty(element, 'scrollTop')) {
      throw new Error('Synthetic scrollTop could not be removed');
    }
    element.dispatchEvent(new Event('scroll'));
  });
}

async function visualMetrics(fixture: ScrollFixture): Promise<{
  height: number;
  top: number;
  outerHeight: number;
}> {
  return fixture.visual.evaluate((visual) => {
    const outer = visual.parentElement!;
    const transform = getComputedStyle(visual).transform;
    return {
      height: visual.getBoundingClientRect().height,
      top: transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42,
      outerHeight: outer.getBoundingClientRect().height,
    };
  });
}

async function expectVisualFillsOuter(fixture: ScrollFixture): Promise<void> {
  await expect
    .poll(async () => {
      const metrics = await visualMetrics(fixture);
      return {
        sameHeight: Math.abs(metrics.height - metrics.outerHeight) < 0.1,
        top: metrics.top,
      };
    })
    .toEqual({ sameHeight: true, top: 0 });
}

test.describe('custom scrollbar scroll-timeline driver', () => {
  test('maps exact endpoints without JavaScript transform writes, then restores after drag', async ({
    page,
  }) => {
    await skipIfScrollTimelineUnavailable(page);
    await openReadyApp(page);
    const fixture = await installFixture(page);
    await waitForDriver(fixture, 'timeline');

    await scrollToRatio(fixture, 0);
    await expectThumbAtRatio(fixture, 0);
    await fixture.thumb.evaluate((thumb) => {
      const instrumented = thumb as HTMLElement & {
        __styleObserver?: MutationObserver;
        __styleMutationCount?: number;
      };
      instrumented.__styleMutationCount = 0;
      instrumented.__styleObserver = new MutationObserver((records) => {
        instrumented.__styleMutationCount! += records.length;
      });
      instrumented.__styleObserver.observe(thumb, {
        attributes: true,
        attributeFilter: ['style'],
      });
    });

    await scrollToRatio(fixture, 0.5);
    await expectThumbAtRatio(fixture, 0.5);
    await scrollToRatio(fixture, 1);
    await expectThumbAtRatio(fixture, 1);
    const styleWrites = await fixture.thumb.evaluate(async (thumb) => {
      await Promise.resolve();
      const instrumented = thumb as HTMLElement & {
        __styleObserver?: MutationObserver;
        __styleMutationCount?: number;
      };
      instrumented.__styleObserver?.disconnect();
      return instrumented.__styleMutationCount ?? -1;
    });
    expect(styleWrites).toBe(0);

    // This verifies the interaction handoff, not physical compositor timing:
    // thumb drag temporarily owns scrollTop in script and then gives normal
    // scrolling back to the browser-driven timeline.
    await scrollToRatio(fixture, 0);
    await expectThumbAtRatio(fixture, 0);
    const box = await fixture.thumb.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await waitForDriver(fixture, 'script');
    await expectVisualFillsOuter(fixture);
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 40);
    await expect
      .poll(() => fixture.owner.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await page.mouse.up();
    await waitForDriver(fixture, 'timeline');
    await expectVisualFillsOuter(fixture);
  });

  test('isolates deterministic top and bottom elasticity from the timeline-owned thumb', async ({
    page,
  }) => {
    await skipIfScrollTimelineUnavailable(page);
    await openReadyApp(page);
    const fixture = await installFixture(page);
    await waitForDriver(fixture, 'timeline');

    // Headless desktop engines cannot synthesize physical iOS rubber-band
    // scrolling. Keep the native scroll offset (and therefore ScrollTimeline)
    // at an endpoint while exposing a deterministic out-of-range value to the
    // JS elasticity sampler through a temporary own-property getter.
    await scrollToRatio(fixture, 0);
    await expectThumbAtRatio(fixture, 0);
    await expectVisualFillsOuter(fixture);
    const normalHeight = (await visualMetrics(fixture)).outerHeight;
    // Initialization legitimately seeds outer geometry. Observe only after
    // that work settles so the count isolates overscroll and endpoint motion.
    await fixture.thumb.evaluate((thumb) => {
      const instrumented = thumb as HTMLElement & {
        __elasticAnimation?: Animation;
        __elasticObserver?: MutationObserver;
        __elasticOuterStyleWrites?: number;
      };
      instrumented.__elasticAnimation = thumb.getAnimations()[0];
      instrumented.__elasticOuterStyleWrites = 0;
      instrumented.__elasticObserver = new MutationObserver((records) => {
        instrumented.__elasticOuterStyleWrites! += records.length;
      });
      instrumented.__elasticObserver.observe(thumb, {
        attributes: true,
        attributeFilter: ['style'],
      });
    });

    await exposeSyntheticScrollTop(fixture, -100);
    await expect.poll(async () => visualMetrics(fixture)).toMatchObject({ top: 0 });
    await expect.poll(async () => (await visualMetrics(fixture)).height).toBeLessThan(normalHeight);
    await waitForDriver(fixture, 'timeline');
    await expectThumbAtRatio(fixture, 0);

    await restoreNativeScrollTop(fixture);
    await expectVisualFillsOuter(fixture);

    await scrollToRatio(fixture, 1);
    await expectThumbAtRatio(fixture, 1);
    const maxScroll = await fixture.owner.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    );
    await exposeSyntheticScrollTop(fixture, maxScroll + 100);
    await expect
      .poll(async () => {
        const metrics = await visualMetrics(fixture);
        return {
          compressed: metrics.height < normalHeight,
          bottomAnchored: Math.abs(metrics.top + metrics.height - metrics.outerHeight) < 0.1,
        };
      })
      .toEqual({ compressed: true, bottomAnchored: true });
    await waitForDriver(fixture, 'timeline');
    await expectThumbAtRatio(fixture, 1);

    await restoreNativeScrollTop(fixture);
    await expectVisualFillsOuter(fixture);
    const isolation = await fixture.thumb.evaluate(async (thumb) => {
      await Promise.resolve();
      const instrumented = thumb as HTMLElement & {
        __elasticAnimation?: Animation;
        __elasticObserver?: MutationObserver;
        __elasticOuterStyleWrites?: number;
      };
      instrumented.__elasticObserver?.disconnect();
      return {
        sameAnimation:
          thumb.getAnimations().length === 1 &&
          thumb.getAnimations()[0] === instrumented.__elasticAnimation,
        outerStyleWrites: instrumented.__elasticOuterStyleWrites ?? -1,
      };
    });
    expect(isolation).toEqual({ sameAnimation: true, outerStyleWrites: 0 });
  });

  test('rebuilds its timeline after resize and a hidden-to-visible transition', async ({
    page,
  }) => {
    await skipIfScrollTimelineUnavailable(page);
    await openReadyApp(page);
    const fixture = await installFixture(page);
    await waitForDriver(fixture, 'timeline');
    await scrollToRatio(fixture, 1);
    await expectThumbAtRatio(fixture, 1);
    await expectVisualFillsOuter(fixture);
    const oldMaxTop = (await thumbMetrics(fixture)).maxTop;

    await fixture.owner.evaluate((element) => {
      element.style.setProperty('height', '160px', 'important');
    });
    await expect
      .poll(() => fixture.track.evaluate((element) => element.getBoundingClientRect().height))
      .toBe(160);
    await waitForDriver(fixture, 'timeline');
    await scrollToRatio(fixture, 1);
    await expectThumbAtRatio(fixture, 1);
    await expect
      .poll(() => fixture.thumb.evaluate((thumb) => thumb.getAnimations().length))
      .toBe(1);
    expect((await thumbMetrics(fixture)).maxTop).not.toBeCloseTo(oldMaxTop, 1);

    await fixture.owner.evaluate((element) => {
      element.style.setProperty('display', 'none', 'important');
    });
    await expect(fixture.thumb).toBeHidden();
    await expect
      .poll(() => fixture.track.evaluate((element) => element.getBoundingClientRect().height))
      .toBe(0);

    await fixture.owner.evaluate((element) => {
      element.style.setProperty('display', 'block', 'important');
      const runtime = window as Window & {
        __MUSIXQUARE_BUS__?: { emit(type: string, ...args: unknown[]): void };
      };
      runtime.__MUSIXQUARE_BUS__?.emit('ui:scrollbar-reveal', element);
    });
    await expect(fixture.thumb).toBeVisible();
    await waitForDriver(fixture, 'timeline');
    await scrollToRatio(fixture, 1);
    await expectThumbAtRatio(fixture, 1);
    await expectVisualFillsOuter(fixture);
  });

  test('keeps nested scroll owners on independent browser timelines', async ({ page }) => {
    await skipIfScrollTimelineUnavailable(page);
    await openReadyApp(page);
    const { outer, inner } = await installNestedFixture(page);
    await waitForDriver(outer, 'timeline');
    await waitForDriver(inner, 'timeline');

    const sourcesAreIndependent = await page.evaluate(() => {
      const outerOwner = document.getElementById('tab-play');
      const innerOwner = outerOwner?.querySelector<HTMLElement>(':scope > .tab-body');
      const outerThumb = document.body.querySelector<HTMLElement>(
        ':scope > .cscroll-track > .cscroll-thumb',
      );
      const innerThumb = outerOwner?.querySelector<HTMLElement>(
        ':scope > .cscroll-track > .cscroll-thumb',
      );
      const ownsTimeline = (thumb: HTMLElement | null | undefined, owner: HTMLElement | null) =>
        Boolean(
          thumb?.getAnimations().some((animation) => {
            const timeline = animation.timeline as AnimationTimeline & { source?: Element };
            return timeline.source === owner;
          }),
        );
      return {
        outer: ownsTimeline(outerThumb, outerOwner),
        inner: ownsTimeline(innerThumb, innerOwner ?? null),
      };
    });
    expect(sourcesAreIndependent).toEqual({ outer: true, inner: true });

    await scrollToRatio(outer, 0);
    await scrollToRatio(inner, 1);
    await expectThumbAtRatio(outer, 0);
    await expectThumbAtRatio(inner, 1);

    await scrollToRatio(outer, 0.5);
    await expectThumbAtRatio(outer, 0.5);
    await expectThumbAtRatio(inner, 1);
  });
});

test.describe('custom scrollbar script fallback', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, 'ScrollTimeline', {
        configurable: true,
        writable: true,
        value: undefined,
      });
    });
  });

  test('keeps exact endpoint mapping when ScrollTimeline is unavailable', async ({ page }) => {
    await openReadyApp(page);
    const fixture = await installFixture(page);
    await waitForDriver(fixture, 'script');
    await scrollToRatio(fixture, 1);
    await expectThumbAtRatio(fixture, 1);
    await expect
      .poll(() => fixture.thumb.evaluate((thumb) => thumb.style.transform))
      .toMatch(/^translateY\(.+px\)$/u);
  });

  test('keeps the proven outer-thumb elasticity and a neutral visual child', async ({ page }) => {
    await openReadyApp(page);
    const fixture = await installFixture(page);
    await waitForDriver(fixture, 'script');

    await scrollToRatio(fixture, 0);
    const normalHeight = await fixture.thumb.evaluate(
      (thumb) => thumb.getBoundingClientRect().height,
    );
    await exposeSyntheticScrollTop(fixture, -100);
    await expect
      .poll(() => fixture.thumb.evaluate((thumb) => thumb.getBoundingClientRect().height))
      .toBeLessThan(normalHeight);
    await expectVisualFillsOuter(fixture);

    await restoreNativeScrollTop(fixture);
    await expect
      .poll(() => fixture.thumb.evaluate((thumb) => thumb.getBoundingClientRect().height))
      .toBeCloseTo(normalHeight, 1);

    await scrollToRatio(fixture, 1);
    const maxScroll = await fixture.owner.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    );
    await exposeSyntheticScrollTop(fixture, maxScroll + 100);
    await expect
      .poll(async () => {
        const thumb = await fixture.thumb.evaluate((element, expectedNormalHeight) => {
          const track = element.parentElement!;
          const transform = getComputedStyle(element).transform;
          const top = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
          return {
            compressed: element.getBoundingClientRect().height < expectedNormalHeight,
            bottomAnchored:
              Math.abs(
                top + element.getBoundingClientRect().height - track.getBoundingClientRect().height,
              ) < 0.1,
          };
        }, normalHeight);
        return thumb;
      })
      .toEqual({ compressed: true, bottomAnchored: true });
    await expectVisualFillsOuter(fixture);

    await restoreNativeScrollTop(fixture);
    await expect
      .poll(() => fixture.thumb.evaluate((thumb) => thumb.getBoundingClientRect().height))
      .toBeCloseTo(normalHeight, 1);
    await waitForDriver(fixture, 'script');
  });
});

test.describe('custom scrollbar ScrollTimeline runtime failure', () => {
  test('falls back when constructing the timeline throws', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, 'ScrollTimeline', {
        configurable: true,
        writable: true,
        value: class BrokenScrollTimeline {
          constructor() {
            throw new Error('synthetic ScrollTimeline failure');
          }
        },
      });
    });
    await openReadyApp(page);
    const fixture = await installFixture(page);
    await waitForDriver(fixture, 'script');
    await scrollToRatio(fixture, 0.5);
    await expectThumbAtRatio(fixture, 0.5);
  });
});
