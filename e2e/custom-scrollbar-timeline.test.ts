import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
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

interface SynchronousScrollSample {
  beforeTransform: string;
  afterTransform: string;
  beforeHeight: string;
  afterHeight: string;
}

async function exposeSyntheticScrollTop(
  fixture: ScrollFixture,
  scrollTop: number,
): Promise<SynchronousScrollSample> {
  return fixture.owner.evaluate((element, syntheticScrollTop) => {
    const visual = element.parentElement?.querySelector<HTMLElement>(
      ':scope > .cscroll-track > .cscroll-thumb > .cscroll-thumb-visual',
    );
    if (!visual) throw new Error('Scrollbar visual is unavailable');

    const beforeTransform = visual.style.transform;
    const beforeHeight = visual.style.height;
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => syntheticScrollTop,
    });
    element.dispatchEvent(new Event('scroll'));
    // Read in the same task, before requestAnimationFrame can run. This
    // distinguishes the event-path latency fix from the background pump.
    return {
      beforeTransform,
      afterTransform: visual.style.transform,
      beforeHeight,
      afterHeight: visual.style.height,
    };
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
    // The endpoint assertion can legitimately outlive the 1.2 s idle fade on
    // a busy CI worker, and a faded bar lets the pointer through. Re-expose
    // and hit-test the real pointer target in the same task, on every poll,
    // then dispatch the gesture to that proven target so cumulative suite
    // load cannot make this driver-handoff test race the unrelated fade timer.
    const box = await fixture.thumb.boundingBox();
    expect(box).not.toBeNull();
    const dragPoint = {
      x: box!.x + box!.width / 2,
      y: box!.y + box!.height / 2,
    };
    await expect
      .poll(() =>
        fixture.owner.evaluate((element, { x, y }) => {
          element.dispatchEvent(new Event('scroll'));
          const track =
            element.parentElement?.querySelector<HTMLElement>(':scope > .cscroll-track');
          return {
            pointerEvents: track ? getComputedStyle(track).pointerEvents : null,
            thumbHit: Boolean(document.elementFromPoint(x, y)?.classList.contains('cscroll-thumb')),
          };
        }, dragPoint),
      )
      .toEqual({ pointerEvents: 'auto', thumbHit: true });
    await fixture.thumb.dispatchEvent('mousedown', {
      button: 0,
      buttons: 1,
      clientX: dragPoint.x,
      clientY: dragPoint.y,
    });
    await waitForDriver(fixture, 'script');
    await expectVisualFillsOuter(fixture);
    // A press dispatched by script sets .dragging but not :active, so only the
    // .dragging rule can give the visual the pressed colour here.
    await expect(fixture.thumb).toHaveClass(/\bdragging\b/);
    const pressedRgb = await page.evaluate(() =>
      document.documentElement.dataset.theme === 'light' ? '0, 0, 0' : '255, 255, 255',
    );
    await expect(fixture.visual).toHaveCSS('background-color', `rgba(${pressedRgb}, 0.6)`);
    await page.evaluate(
      ({ x, y }) =>
        window.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            buttons: 1,
            clientX: x,
            clientY: y + 40,
          }),
        ),
      dragPoint,
    );
    await expect
      .poll(() => fixture.owner.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await page.evaluate(() =>
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })),
    );
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

    const topEventSample = await exposeSyntheticScrollTop(fixture, -100);
    expect(topEventSample.afterTransform).not.toBe(topEventSample.beforeTransform);
    expect(topEventSample.afterTransform).toMatch(/scaleY\((?!1\))[^)]+\)$/u);
    expect(topEventSample.beforeHeight).toBe('');
    expect(topEventSample.afterHeight).toBe('');
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
    const bottomEventSample = await exposeSyntheticScrollTop(fixture, maxScroll + 100);
    expect(bottomEventSample.afterTransform).not.toBe(bottomEventSample.beforeTransform);
    expect(bottomEventSample.afterTransform).toMatch(/translateY\((?!0px\))[^)]+\) scaleY\(/u);
    expect(bottomEventSample.beforeHeight).toBe('');
    expect(bottomEventSample.afterHeight).toBe('');
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

  test('observes delayed endpoint overscroll after more than three quiet frames', async ({
    page,
  }) => {
    await skipIfScrollTimelineUnavailable(page);
    await openReadyApp(page);
    const fixture = await installFixture(page);
    await waitForDriver(fixture, 'timeline');

    const result = await fixture.owner.evaluate(async (element) => {
      const visual = element.parentElement?.querySelector<HTMLElement>(
        ':scope > .cscroll-track > .cscroll-thumb > .cscroll-thumb-visual',
      );
      const thumb = visual?.parentElement;
      if (!visual || !thumb) throw new Error('Scrollbar visual is unavailable');

      let rawScrollTop = 0;
      Object.defineProperty(element, 'scrollTop', {
        configurable: true,
        get: () => rawScrollTop,
      });

      const animation = thumb.getAnimations()[0];
      let outerStyleWrites = 0;
      const observer = new MutationObserver((records) => {
        outerStyleWrites += records.length;
      });
      observer.observe(thumb, { attributes: true, attributeFilter: ['style'] });

      const inlineHeightBefore = visual.style.height;
      element.dispatchEvent(new Event('scroll'));
      const startedAt = performance.now();
      const nextFrame = () =>
        new Promise<number>((resolve) => window.requestAnimationFrame(resolve));

      // The historical pump stopped after three unchanged samples. Keep the
      // raw endpoint unchanged for four complete animation frames, then
      // expose iOS's late rubber-band value without dispatching another event.
      for (let frame = 0; frame < 4; frame += 1) await nextFrame();
      const elapsedBeforeLateValue = performance.now() - startedAt;
      rawScrollTop = -100;
      await nextFrame();
      await nextFrame();

      const lateTransform = visual.style.transform;
      const inlineHeightAfter = visual.style.height;
      if (!Reflect.deleteProperty(element, 'scrollTop')) {
        throw new Error('Synthetic scrollTop could not be removed');
      }
      element.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
      observer.disconnect();

      return {
        elapsedBeforeLateValue,
        lateTransform,
        inlineHeightBefore,
        inlineHeightAfter,
        sameAnimation: thumb.getAnimations().length === 1 && thumb.getAnimations()[0] === animation,
        outerStyleWrites,
      };
    });

    expect(result.elapsedBeforeLateValue).toBeLessThan(150);
    expect(result.lateTransform).toMatch(/scaleY\((?!1\))[^)]+\)$/u);
    expect(result.inlineHeightBefore).toBe('');
    expect(result.inlineHeightAfter).toBe('');
    expect(result.sameAnimation).toBe(true);
    expect(result.outerStyleWrites).toBe(0);
    await expectVisualFillsOuter(fixture);
  });

  test('keeps sampling while normal raw offsets continue moving', async ({ page }) => {
    await skipIfScrollTimelineUnavailable(page);
    await openReadyApp(page);
    const fixture = await installFixture(page);
    await waitForDriver(fixture, 'timeline');

    const lateTransform = await fixture.owner.evaluate(async (element) => {
      const visual = element.parentElement?.querySelector<HTMLElement>(
        ':scope > .cscroll-track > .cscroll-thumb > .cscroll-thumb-visual',
      );
      if (!visual) throw new Error('Scrollbar visual is unavailable');

      const maxScroll = element.scrollHeight - element.clientHeight;
      let rawScrollTop = maxScroll * 0.2;
      Object.defineProperty(element, 'scrollTop', {
        configurable: true,
        get: () => rawScrollTop,
      });
      element.dispatchEvent(new Event('scroll'));

      const nextFrame = () =>
        new Promise<number>((resolve) => window.requestAnimationFrame(resolve));
      // Normal-range ScrollTimeline motion does not change the nested visual.
      // Move its raw source for more than three frames to prove those samples
      // still count as activity and keep the pump alive.
      for (let frame = 0; frame < 5; frame += 1) {
        await nextFrame();
        rawScrollTop = maxScroll * (0.25 + frame * 0.05);
      }
      rawScrollTop = -100;
      await nextFrame();
      await nextFrame();
      const transform = visual.style.transform;

      if (!Reflect.deleteProperty(element, 'scrollTop')) {
        throw new Error('Synthetic scrollTop could not be removed');
      }
      element.dispatchEvent(new Event('scroll'));
      return transform;
    });

    expect(lateTransform).toMatch(/scaleY\((?!1\))[^)]+\)$/u);
    await expectVisualFillsOuter(fixture);
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

test.describe('custom scrollbar pointer hover reveal and thumb states', () => {
  test('ramps from transparent to 0.2 on panel hover, 0.4 on thumb hover, and 0.6 while dragging', async ({
    page,
  }) => {
    await openReadyApp(page);
    const fixture = await installFixture(page);

    // Wait for any initial reveal to fade out; both track and thumb must pass pointer events through.
    await expect(fixture.track).toHaveCSS('opacity', '0', { timeout: 5_000 });
    await expect(fixture.track).toHaveCSS('pointer-events', 'none');
    await expect(fixture.thumb).toHaveCSS('pointer-events', 'none');

    const ownerBox = await fixture.owner.boundingBox();
    expect(ownerBox).not.toBeNull();
    const rgb = await page.evaluate(() =>
      document.documentElement.dataset.theme === 'light' ? '0, 0, 0' : '255, 255, 255',
    );

    // Move mouse into the scrollable panel -> reveals track at base 0.2 thumb color.
    await page.mouse.move(ownerBox!.x + 40, ownerBox!.y + 40);
    await expect(fixture.track).toHaveCSS('opacity', '1');
    await expect(fixture.track).toHaveCSS('pointer-events', 'auto');
    await expect(fixture.thumb).toHaveCSS('pointer-events', 'auto');
    await expect(fixture.visual).toHaveCSS('background-color', `rgba(${rgb}, 0.2)`);

    // Hover directly over the thumb -> deepens to 0.4 and stays visible past the 1.2s fade delay.
    const thumbBox = await fixture.thumb.boundingBox();
    expect(thumbBox).not.toBeNull();
    const thumbCenter = {
      x: thumbBox!.x + thumbBox!.width / 2,
      y: thumbBox!.y + thumbBox!.height / 2,
    };
    await page.mouse.move(thumbCenter.x, thumbCenter.y);
    await expect(fixture.visual).toHaveCSS('background-color', `rgba(${rgb}, 0.4)`);
    await page.waitForTimeout(1400);
    await expect(fixture.track).toHaveCSS('opacity', '1');
    await expect(fixture.visual).toHaveCSS('background-color', `rgba(${rgb}, 0.4)`);

    // Press and drag even off the 8px track horizontally -> stays visible at 0.6 (.dragging).
    await page.mouse.down();
    await expect(fixture.thumb).toHaveClass(/\bdragging\b/);
    await expect(fixture.visual).toHaveCSS('background-color', `rgba(${rgb}, 0.6)`);
    await page.mouse.move(thumbCenter.x - 60, thumbCenter.y + 40);
    await expect(fixture.track).toHaveCSS('opacity', '1');
    await expect(fixture.visual).toHaveCSS('background-color', `rgba(${rgb}, 0.6)`);

    // Release outside the track -> drops back to 0.2 and fades to 0 after idle delay.
    await page.mouse.up();
    await expect(fixture.thumb).not.toHaveClass(/\bdragging\b/);
    await expect(fixture.visual).toHaveCSS('background-color', `rgba(${rgb}, 0.2)`);
    await expect(fixture.track).toHaveCSS('opacity', '0', { timeout: 5_000 });
    await expect(fixture.thumb).toHaveCSS('pointer-events', 'none');
  });

  test('scrolls the panel with the wheel over its bar after the pointer rests there past the fade delay', async ({
    page,
    browserName,
    isMobile,
  }) => {
    test.skip(
      browserName === 'webkit' && isMobile,
      'Playwright has no mouse wheel in mobile WebKit',
    );
    await openReadyApp(page);
    const fixture = await installFixture(page);
    // Lay the track over the panel's right edge, as the app's contained bars sit
    // over their scroller's edge (the language list's track is at right: -4px).
    await fixture.track.evaluate((track) => {
      const shell = track.parentElement!;
      const owner = shell.querySelector<HTMLElement>(':scope > .tab-body')!;
      const inset = shell.getBoundingClientRect().right - owner.getBoundingClientRect().right;
      track.style.setProperty('right', `${inset}px`, 'important');
    });
    await expect(fixture.track).toHaveCSS('opacity', '0', { timeout: 5_000 });

    const ownerBox = await fixture.owner.boundingBox();
    const trackBox = await fixture.track.boundingBox();
    const thumbBox = await fixture.thumb.boundingBox();
    expect(ownerBox && trackBox && thumbBox).toBeTruthy();
    expect(trackBox!.x).toBeGreaterThanOrEqual(ownerBox!.x);
    expect(trackBox!.x + trackBox!.width).toBeLessThanOrEqual(ownerBox!.x + ownerBox!.width);
    // A point on the bar, below the thumb, inside the panel's box.
    const point = {
      x: trackBox!.x + trackBox!.width / 2,
      y: trackBox!.y + trackBox!.height * 0.75,
    };
    expect(point.y).toBeGreaterThan(thumbBox!.y + thumbBox!.height);

    // Come in over the panel, then slide onto the bar and rest there past the
    // 1.2 s fade delay.
    await page.mouse.move(point.x - 60, point.y);
    await page.waitForTimeout(300);
    await page.mouse.move(point.x, point.y, { steps: 6 });
    await page.waitForTimeout(1_500);

    // The resting pointer holds the bar, shown and under it, so the wheel turns
    // over the bar and not over the panel beneath it.
    expect(
      await fixture.track.evaluate((track, { x, y }) => {
        const style = getComputedStyle(track);
        const owner = track.parentElement!.querySelector<HTMLElement>(':scope > .tab-body')!;
        return {
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          underPointer: track.contains(document.elementFromPoint(x, y)),
          scrollTop: owner.scrollTop,
        };
      }, point),
    ).toEqual({ opacity: '1', pointerEvents: 'auto', underPointer: true, scrollTop: 0 });
    await page.mouse.wheel(0, 300);
    await expect
      .poll(() => fixture.owner.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
  });
});

interface Point {
  x: number;
  y: number;
}

/**
 * The bar's hold on its scroller, as src/ui/custom-scrollbar.ts names it
 * (CUSTOM_SCROLL_HELD_ATTRIBUTE).
 */
const HELD_ATTRIBUTE = 'data-custom-scroll-held';

type PressInput = 'mouse' | 'finger';

interface PressStamp {
  t: number;
  scrollTop: number;
  target: 'thumb' | 'track' | 'other';
}

interface ScrollFrames {
  press: PressStamp | null;
  frames: Array<{ t: number; scrollTop: number }>;
}

interface GlidingBar {
  scrollTop: number;
  thumb: Point & { top: number };
  track: Point & { top: number };
}

/**
 * Lays the bar over the panel's right edge, as the app's contained bars sit
 * over their scroller's edge.
 */
async function layTrackOverPanelEdge(fixture: ScrollFixture): Promise<void> {
  await fixture.track.evaluate((track) => {
    const shell = track.parentElement!;
    const owner = shell.querySelector<HTMLElement>(':scope > .tab-body')!;
    const inset = shell.getBoundingClientRect().right - owner.getBoundingClientRect().right;
    track.style.setProperty('right', `${inset}px`, 'important');
  });
}

/**
 * The fixture pins the owner's overflow-y inline and important, which outranks
 * every stylesheet rule, the bar's hold among them. Rows about the hold give
 * overflow back to the app stylesheet, where a tab body scrolls.
 */
async function letStylesheetOwnOverflow(fixture: ScrollFixture): Promise<void> {
  await fixture.owner.evaluate((owner) => {
    owner.style.removeProperty('overflow-y');
  });
  await expect(fixture.owner).toHaveCSS('overflow-y', 'auto');
}

/**
 * Shows the bar with a scroll event until `point` hits `part` of it. Every poll
 * shows it again, so a slow machine cannot slip the fade in between.
 */
async function showBarUnder(
  fixture: ScrollFixture,
  part: 'thumb' | 'track',
  point: Point,
): Promise<void> {
  await expect
    .poll(() =>
      fixture.owner.evaluate((owner, { x, y }) => {
        owner.dispatchEvent(new Event('scroll'));
        const track = owner.parentElement!.querySelector<HTMLElement>(':scope > .cscroll-track')!;
        const thumb = track.querySelector(':scope > .cscroll-thumb');
        const hit = document.elementFromPoint(x, y);
        let hitPart = 'other';
        if (hit && thumb?.contains(hit)) hitPart = 'thumb';
        else if (hit === track) hitPart = 'track';
        return { pointerEvents: getComputedStyle(track).pointerEvents, hit: hitPart };
      }, point),
    )
    .toEqual({ pointerEvents: 'auto', hit: part });
}

/** The bar has let its scroller go: user scrolling is back, and no drag is left. */
async function expectLetGo(fixture: ScrollFixture): Promise<void> {
  await expect(fixture.owner).toHaveCSS('overflow-y', 'auto');
  await expect(fixture.owner).not.toHaveAttribute(HELD_ATTRIBUTE);
  await expect(fixture.thumb).not.toHaveClass(/\bdragging\b/);
}

async function emitScrollbarRelayout(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = window as Window & {
      __MUSIXQUARE_BUS__?: { emit(type: string, ...args: unknown[]): void };
    };
    if (!runtime.__MUSIXQUARE_BUS__) throw new Error('The app bus is not exposed');
    runtime.__MUSIXQUARE_BUS__.emit('ui:scrollbar-relayout');
  });
}

async function nextFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frames) => {
    for (let frame = 0; frame < frames; frame += 1) {
      await new Promise<number>((resolve) => window.requestAnimationFrame(resolve));
    }
  }, count);
}

async function hasScrollTimeline(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      typeof (globalThis as typeof globalThis & { ScrollTimeline?: unknown }).ScrollTimeline ===
      'function',
  );
}

/** The list comes to rest within a pixel of `expected`. */
async function expectScrollTopNear(fixture: ScrollFixture, expected: number): Promise<void> {
  await expect
    .poll(async () => {
      const scrollTop = await fixture.owner.evaluate((owner) => owner.scrollTop);
      return Math.abs(scrollTop - expected);
    })
    .toBeLessThanOrEqual(1);
}

/** Records the owner's scrollTop every frame and stamps the first press, in page time. */
async function recordScrollFrames(fixture: ScrollFixture): Promise<void> {
  await fixture.owner.evaluate((owner) => {
    const track = owner.parentElement!.querySelector<HTMLElement>(':scope > .cscroll-track')!;
    const thumb = track.querySelector<HTMLElement>(':scope > .cscroll-thumb')!;
    const record: ScrollFrames = { press: null, frames: [] };
    const sample = (): void => {
      record.frames.push({ t: performance.now(), scrollTop: owner.scrollTop });
      window.requestAnimationFrame(sample);
    };
    window.requestAnimationFrame(sample);
    const stamp = (event: Event): void => {
      if (record.press) return;
      let target: PressStamp['target'] = 'other';
      if (event.target instanceof Node && thumb.contains(event.target)) target = 'thumb';
      else if (event.target === track) target = 'track';
      record.press = { t: performance.now(), scrollTop: owner.scrollTop, target };
    };
    window.addEventListener('mousedown', stamp, { capture: true });
    window.addEventListener('touchstart', stamp, { capture: true });
    (window as Window & { __scrollFrames?: ScrollFrames }).__scrollFrames = record;
  });
}

async function readScrollFrames(page: Page): Promise<ScrollFrames> {
  return page.evaluate(() => {
    const record = (window as Window & { __scrollFrames?: ScrollFrames }).__scrollFrames;
    if (!record) throw new Error('No scroll frames were recorded');
    return { press: record.press, frames: [...record.frames] };
  });
}

/**
 * How the list moved while the press was held. The press's own frame and the
 * next may still show the scroll that was already in flight, so moves count
 * from the third frame after the press.
 */
function heldMovement(
  record: ScrollFrames,
  until: number,
): { frames: number; settledAt: number; movedFrames: number; drift: number } {
  const pressedAt = record.press?.t ?? Number.POSITIVE_INFINITY;
  const held = record.frames.filter((frame) => frame.t > pressedAt && frame.t <= until);
  let movedFrames = 0;
  for (let index = 2; index < held.length; index += 1) {
    if (held[index].scrollTop !== held[index - 1].scrollTop) movedFrames += 1;
  }
  return {
    frames: held.length,
    settledAt: held[1]?.scrollTop ?? Number.NaN,
    movedFrames,
    drift: held.length > 2 ? held[held.length - 1].scrollTop - held[1].scrollTop : 0,
  };
}

/**
 * Scrolling the engine keeps delivering to the list, which a page can neither
 * cancel nor stop by writing scrollTop: a wheel stream inside the list, as
 * touchpad momentum arrives in Chromium (900 px at 500 px/s). Resolves with
 * null once the stream ends, or with its error.
 */
function startEngineScroll(cdp: CDPSession, at: Point): Promise<unknown> {
  return cdp
    .send('Input.synthesizeScrollGesture', {
      x: at.x,
      y: at.y,
      xDistance: 0,
      yDistance: -900,
      speed: 500,
      gestureSourceType: 'mouse',
      preventFling: true,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
}

/** Waits frame by frame until the engine has scrolled the list past `beyond`, then reads the bar. */
async function waitForEngineScroll(fixture: ScrollFixture, beyond: number): Promise<GlidingBar> {
  return fixture.owner.evaluate(
    (owner, past) =>
      new Promise<GlidingBar>((resolve) => {
        const started = performance.now();
        const check = (): void => {
          if (owner.scrollTop <= past && performance.now() - started < 5_000) {
            window.requestAnimationFrame(check);
            return;
          }
          const track = owner.parentElement!.querySelector<HTMLElement>(':scope > .cscroll-track')!;
          const thumb = track.querySelector<HTMLElement>(':scope > .cscroll-thumb')!;
          const trackBox = track.getBoundingClientRect();
          const thumbBox = thumb.getBoundingClientRect();
          resolve({
            scrollTop: owner.scrollTop,
            thumb: {
              x: thumbBox.left + thumbBox.width / 2,
              y: thumbBox.top + thumbBox.height / 2,
              top: thumbBox.top,
            },
            track: {
              x: trackBox.left + trackBox.width / 2,
              y: trackBox.top + trackBox.height / 2,
              top: trackBox.top,
            },
          });
        };
        check();
      }),
    beyond,
  );
}

function touchPoints(at: Point): Array<{
  x: number;
  y: number;
  id: number;
  radiusX: number;
  radiusY: number;
  force: number;
}> {
  return [{ x: at.x, y: at.y, id: 1, radiusX: 1, radiusY: 1, force: 1 }];
}

async function pressWith(cdp: CDPSession, input: PressInput, at: Point): Promise<void> {
  if (input === 'finger') {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: touchPoints(at),
    });
    return;
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: at.x,
    y: at.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
}

async function moveWith(cdp: CDPSession, input: PressInput, at: Point): Promise<void> {
  if (input === 'finger') {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touchPoints(at) });
    return;
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: at.x,
    y: at.y,
    button: 'left',
    buttons: 1,
  });
}

async function releaseWith(cdp: CDPSession, input: PressInput, at: Point): Promise<void> {
  if (input === 'finger') {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return;
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: at.x,
    y: at.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}

/**
 * Records the owner's computed overflow-y at every touchstart on `part`. A
 * listener added after the app's runs after the app's own on that element,
 * which the app's stopPropagation does not stop.
 */
async function recordOverflowAtTouchStart(part: Locator): Promise<void> {
  await part.evaluate((element) => {
    const owner = element.closest('#tab-play')!.querySelector<HTMLElement>(':scope > .tab-body')!;
    const seen: string[] = [];
    element.addEventListener(
      'touchstart',
      () => {
        seen.push(getComputedStyle(owner).overflowY);
      },
      { passive: true },
    );
    (element as Element & { __overflowAtTouchStart?: string[] }).__overflowAtTouchStart = seen;
  });
}

async function overflowAtTouchStart(part: Locator): Promise<string[]> {
  return part.evaluate((element) => [
    ...((element as Element & { __overflowAtTouchStart?: string[] }).__overflowAtTouchStart ?? []),
  ]);
}

/**
 * Grabs the thumb while the engine keeps scrolling the list. The list holds
 * still at once, follows the thumb through a relayout and a still pause, and
 * scrolls by hand again once the thumb is let go.
 */
async function grabThumbWhileEngineScrolls(page: Page, input: PressInput): Promise<void> {
  await openReadyApp(page);
  const fixture = await installFixture(page);
  await layTrackOverPanelEdge(fixture);
  await letStylesheetOwnOverflow(fixture);
  const ownerBox = await fixture.owner.boundingBox();
  expect(ownerBox).not.toBeNull();
  const inside = { x: ownerBox!.x + 70, y: ownerBox!.y + 100 };

  await recordScrollFrames(fixture);
  const cdp = await page.context().newCDPSession(page);
  const stream = startEngineScroll(cdp, inside);
  const gliding = await waitForEngineScroll(fixture, 60);
  expect(gliding.scrollTop).toBeGreaterThan(60);

  // Press the thumb where it was a moment ago, and hold still.
  const press = { x: gliding.thumb.x, y: gliding.thumb.y };
  await pressWith(cdp, input, press);
  await page.waitForTimeout(250);
  const heldUntil = await page.evaluate(() => performance.now());
  const record = await readScrollFrames(page);
  expect(record.press?.target).toBe('thumb');
  const held = heldMovement(record, heldUntil);
  expect(held.frames).toBeGreaterThanOrEqual(8);
  expect({ movedFrames: held.movedFrames, drift: held.drift }).toEqual({
    movedFrames: 0,
    drift: 0,
  });

  // A relayout, then a still pause past the 1.2 s fade delay, so the first
  // move also opens a new scroll session that lays the bar out again. The bar
  // stays, and the list follows the thumb from where the press found it.
  await emitScrollbarRelayout(page);
  await page.waitForTimeout(1_300);
  await expect(fixture.track).toHaveCSS('opacity', '1');
  await expect(fixture.thumb).toBeVisible();
  const pressedAt = record.press!.scrollTop;
  await moveWith(cdp, input, { x: press.x, y: press.y - 12 });
  await expectScrollTopNear(fixture, pressedAt - 60);
  await nextFrames(page, 2);
  await expect(fixture.track).toHaveCSS('opacity', '1');
  await expect(fixture.thumb).toBeVisible();
  await moveWith(cdp, input, { x: press.x, y: press.y - 4 });
  await expectScrollTopNear(fixture, pressedAt - 20);

  await releaseWith(cdp, input, { x: press.x, y: press.y - 4 });
  await expectLetGo(fixture);
  if (await hasScrollTimeline(page)) await waitForDriver(fixture, 'timeline');
  expect(await stream).toBeNull();

  // The list scrolls by hand again.
  await scrollToRatio(fixture, 0.5);
  if (input === 'finger') {
    await fingerStroke(page, cdp, { x: inside.x, y: inside.y + 60 }, inside);
  } else {
    await page.mouse.move(inside.x, inside.y);
    await page.mouse.wheel(0, 100);
  }
  await expect.poll(() => fixture.owner.evaluate((owner) => owner.scrollTop)).toBeGreaterThan(400);
}

/** Records when a wheel event reaches the bar, in page time. */
async function recordBarWheels(fixture: ScrollFixture): Promise<void> {
  await fixture.track.evaluate((track) => {
    const times: number[] = [];
    window.addEventListener(
      'wheel',
      (event) => {
        if (event.target instanceof Node && track.contains(event.target)) {
          times.push(performance.now());
        }
      },
      { capture: true, passive: true },
    );
    (window as Window & { __barWheels?: number[] }).__barWheels = times;
  });
}

async function readBarWheels(page: Page): Promise<number[]> {
  return page.evaluate(() => [
    ...((window as Window & { __barWheels?: number[] }).__barWheels ?? []),
  ]);
}

/**
 * A flick that began over the bar keeps sending its touchpad momentum to the
 * bar, which hands a wheel to its scroller. Presses `part` of the bar while
 * such a stream keeps arriving there: the bar hands none of it to the scroller
 * its press holds, so the list stays still and follows only the thumb.
 */
async function pressBarWhileWheelStreamArrivesThere(
  page: Page,
  part: 'thumb' | 'track',
): Promise<void> {
  await openReadyApp(page);
  const fixture = await installFixture(page);
  await layTrackOverPanelEdge(fixture);
  await letStylesheetOwnOverflow(fixture);
  const trackBox = await fixture.track.boundingBox();
  expect(trackBox).not.toBeNull();
  // On the bar, below the thumb at the top of the list.
  const onBar = { x: trackBox!.x + trackBox!.width / 2, y: trackBox!.y + 150 };
  await showBarUnder(fixture, 'track', onBar);

  await recordScrollFrames(fixture);
  await recordBarWheels(fixture);
  const cdp = await page.context().newCDPSession(page);
  const stream = startEngineScroll(cdp, onBar);
  // The thumb is pressed where it was a moment ago. The empty part is pressed
  // once the list is far enough down that the bar above the thumb is empty.
  const gliding = await waitForEngineScroll(fixture, part === 'thumb' ? 60 : 200);
  const press =
    part === 'thumb'
      ? { x: gliding.thumb.x, y: gliding.thumb.y }
      : { x: gliding.track.x, y: gliding.track.top + 10 };
  if (part === 'track') expect(press.y).toBeLessThan(gliding.thumb.top - 20);
  await pressWith(cdp, 'mouse', press);
  await page.waitForTimeout(250);
  const heldUntil = await page.evaluate(() => performance.now());
  const record = await readScrollFrames(page);
  expect(record.press?.target).toBe(part);
  const pressedAt = record.press!;
  // The stream still reaches the bar while it is pressed.
  const wheelsWhileHeld = (await readBarWheels(page)).filter(
    (time) => time > pressedAt.t && time <= heldUntil,
  );
  expect(wheelsWhileHeld.length).toBeGreaterThan(0);
  const held = heldMovement(record, heldUntil);
  expect(held.frames).toBeGreaterThanOrEqual(8);
  // A press on the empty part still jumps the list up to the point pressed.
  if (part === 'track') expect(held.settledAt).toBeLessThan(pressedAt.scrollTop - 100);
  expect({ movedFrames: held.movedFrames, drift: held.drift }).toEqual({
    movedFrames: 0,
    drift: 0,
  });
  await expect(fixture.owner).toHaveCSS('overflow-y', 'hidden');

  // The list follows the thumb from where the press found it.
  if (part === 'thumb') {
    await moveWith(cdp, 'mouse', { x: press.x, y: press.y - 12 });
    await expectScrollTopNear(fixture, pressedAt.scrollTop - 60);
  }
  await releaseWith(cdp, 'mouse', press);
  await expectLetGo(fixture);
  expect(await stream).toBeNull();
}

// A press on the bar lands outside its scroller, so it cannot stop a glide the
// browser is still running on the list, and the list followed the thumb only
// once the glide had run down. From the press until that press ends, the bar
// holds its scroller still (not user-scrollable), and hands it no wheel.
// Headless browsers make no real momentum: the Chromium rows use a wheel
// stream the engine keeps delivering instead, the way touchpad momentum
// arrives, to the list or, for a flick that began over the bar, to the bar.
test.describe('custom scrollbar hold while the bar is pressed', () => {
  test('stops a scroll the engine keeps delivering when the thumb is grabbed, then the list follows the thumb', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'Playwright synthesizes engine scrolling only through the Chromium DevTools protocol',
    );
    await grabThumbWhileEngineScrolls(page, 'mouse');
  });

  test('holds its scroller while the thumb is held, keeps the bar and the drag through a relayout and a still pause, and lets go on release', async ({
    page,
    browserName,
    isMobile,
  }) => {
    await openReadyApp(page);
    const fixture = await installFixture(page);
    await letStylesheetOwnOverflow(fixture);
    await scrollToRatio(fixture, 0.5);
    await expectThumbAtRatio(fixture, 0.5);
    const box = await fixture.thumb.boundingBox();
    expect(box).not.toBeNull();
    const press = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    await showBarUnder(fixture, 'thumb', press);
    await page.mouse.move(press.x, press.y);
    await page.mouse.down();
    await expect(fixture.thumb).toHaveClass(/\bdragging\b/);
    await expect(fixture.owner).toHaveCSS('overflow-y', 'hidden');

    // A relayout, then a still pause past the fade delay: the first move opens
    // a new scroll session, and the bar stays through both layouts.
    await emitScrollbarRelayout(page);
    await page.waitForTimeout(1_300);
    await expect(fixture.track).toHaveCSS('opacity', '1');
    await expect(fixture.thumb).toBeVisible();
    await page.mouse.move(press.x, press.y + 16);
    await expectScrollTopNear(fixture, 480);
    await nextFrames(page, 2);
    await expect(fixture.track).toHaveCSS('opacity', '1');
    await expect(fixture.thumb).toBeVisible();
    await page.mouse.move(press.x, press.y + 24);
    await expectScrollTopNear(fixture, 520);

    await page.mouse.up();
    await expectLetGo(fixture);
    if (await hasScrollTimeline(page)) await waitForDriver(fixture, 'timeline');
    await scrollToRatio(fixture, 1);
    await expectThumbAtRatio(fixture, 1);
    // Playwright has no mouse wheel in mobile WebKit.
    if (browserName === 'webkit' && isMobile) return;
    const ownerBox = await fixture.owner.boundingBox();
    expect(ownerBox).not.toBeNull();
    await page.mouse.move(ownerBox!.x + 70, ownerBox!.y + 100);
    await page.mouse.wheel(0, -100);
    await expect.poll(() => fixture.owner.evaluate((owner) => owner.scrollTop)).toBeLessThan(800);
  });

  test('stops a scroll the engine keeps delivering while the empty part of the bar is pressed, and lets go on release', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'Playwright synthesizes engine scrolling only through the Chromium DevTools protocol',
    );
    await openReadyApp(page);
    const fixture = await installFixture(page);
    await layTrackOverPanelEdge(fixture);
    await letStylesheetOwnOverflow(fixture);
    const ownerBox = await fixture.owner.boundingBox();
    expect(ownerBox).not.toBeNull();
    const inside = { x: ownerBox!.x + 70, y: ownerBox!.y + 100 };

    await recordScrollFrames(fixture);
    const cdp = await page.context().newCDPSession(page);
    const stream = startEngineScroll(cdp, inside);
    // Far enough down that the bar above the thumb is empty; the scroll then
    // carries the thumb further from the press.
    const gliding = await waitForEngineScroll(fixture, 200);
    expect(gliding.scrollTop).toBeGreaterThan(200);
    const press = { x: gliding.track.x, y: gliding.track.top + 10 };
    expect(press.y).toBeLessThan(gliding.thumb.top - 20);

    // The press still jumps the list up to the point pressed, then holds it.
    await pressWith(cdp, 'mouse', press);
    await page.waitForTimeout(250);
    const heldUntil = await page.evaluate(() => performance.now());
    const record = await readScrollFrames(page);
    expect(record.press?.target).toBe('track');
    const held = heldMovement(record, heldUntil);
    expect(held.frames).toBeGreaterThanOrEqual(8);
    expect(held.settledAt).toBeLessThan(record.press!.scrollTop - 100);
    expect({ movedFrames: held.movedFrames, drift: held.drift }).toEqual({
      movedFrames: 0,
      drift: 0,
    });
    await expect(fixture.owner).toHaveCSS('overflow-y', 'hidden');

    await releaseWith(cdp, 'mouse', press);
    await expectLetGo(fixture);
    expect(await stream).toBeNull();
  });

  test('stops a wheel stream that began over the bar when the thumb is grabbed, then the list follows the thumb', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'Playwright synthesizes engine scrolling only through the Chromium DevTools protocol',
    );
    await pressBarWhileWheelStreamArrivesThere(page, 'thumb');
  });

  test('stops a wheel stream that began over the bar while the empty part of the bar is pressed', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'Playwright synthesizes engine scrolling only through the Chromium DevTools protocol',
    );
    await pressBarWhileWheelStreamArrivesThere(page, 'track');
  });

  test('keeps the bar shown while a press on its empty part lays it out, after the list has rested under the pointer', async ({
    page,
  }) => {
    await openReadyApp(page);
    const fixture = await installFixture(page);
    await layTrackOverPanelEdge(fixture);
    await letStylesheetOwnOverflow(fixture);
    // The thumb at the bottom leaves the top of the bar empty.
    await scrollToRatio(fixture, 1);
    await expectThumbAtRatio(fixture, 1);
    const ownerBox = await fixture.owner.boundingBox();
    const trackBox = await fixture.track.boundingBox();
    expect(ownerBox && trackBox).toBeTruthy();
    const point = { x: trackBox!.x + trackBox!.width / 2, y: trackBox!.y + 20 };

    // A mouse over the list shows the bar, then rests on it, which keeps it
    // shown while the list rests past the 1.2 s fade delay.
    await page.mouse.move(ownerBox!.x + 60, ownerBox!.y + 60);
    await page.mouse.move(point.x, point.y, { steps: 4 });
    await expect(fixture.track).toHaveCSS('pointer-events', 'auto');
    await page.waitForTimeout(1_500);
    await expect(fixture.track).toHaveCSS('pointer-events', 'auto');

    // The press jumps the list to the point pressed, and the jump's scroll
    // starts a new scroll session, which lays the bar out while the press
    // holds the list.
    await page.mouse.down();
    await expectScrollTopNear(fixture, 80);
    await expect(fixture.owner).toHaveCSS('overflow-y', 'hidden');
    await nextFrames(page, 6);
    expect(
      await fixture.track.evaluate((track) => ({
        opacity: track.style.opacity,
        pointerEvents: track.style.pointerEvents,
      })),
    ).toEqual({ opacity: '1', pointerEvents: 'auto' });
    await expect(fixture.thumb).toBeVisible();

    await page.mouse.up();
    await expectLetGo(fixture);
  });
});

/** One finger moves from `from` to `to` in steps, then rests before lifting. */
async function fingerStroke(page: Page, cdp: CDPSession, from: Point, to: Point): Promise<void> {
  const contact = (point: Point) => [{ ...point, id: 1, radiusX: 1, radiusY: 1, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: contact(from) });
  try {
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: contact({
          x: from.x + ((to.x - from.x) * step) / 8,
          y: from.y + ((to.y - from.y) * step) / 8,
        }),
      });
      await page.waitForTimeout(24);
    }
    // Lift at rest, not as a fling, so the scroll ends where the finger did.
    await page.waitForTimeout(250);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: contact(to) });
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

test.describe('custom scrollbar under a finger', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  });

  // A faded bar lets every pointer through, a finger too (owner decision
  // 2026-11-20). A finger pushing a long list along its right edge scrolls the
  // list and never grabs the hidden thumb, whose drag would jump the list at
  // the track's scale.
  test('scrolls the panel when a swipe starts on the faded thumb, without dragging it', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'Playwright moves a finger only through the Chromium DevTools protocol',
    );
    await openReadyApp(page);
    const fixture = await installFixture(page);
    // Lay the track over the panel's right edge, as the app's contained bars sit
    // over their scroller's edge, so the faded thumb's rectangle is on the panel.
    await fixture.track.evaluate((track) => {
      const shell = track.parentElement!;
      const owner = shell.querySelector<HTMLElement>(':scope > .tab-body')!;
      const inset = shell.getBoundingClientRect().right - owner.getBoundingClientRect().right;
      track.style.setProperty('right', `${inset}px`, 'important');
    });
    // Halfway down the list, so the finger has room to push the content up.
    await scrollToRatio(fixture, 0.5);
    await expectThumbAtRatio(fixture, 0.5);
    await expect(fixture.track).toHaveCSS('opacity', '0', { timeout: 5_000 });
    await expect(fixture.track).toHaveCSS('pointer-events', 'none');

    const ownerBox = await fixture.owner.boundingBox();
    const thumbBox = await fixture.thumb.boundingBox();
    expect(ownerBox && thumbBox).toBeTruthy();
    const from = { x: thumbBox!.x + thumbBox!.width / 2, y: thumbBox!.y + thumbBox!.height / 2 };
    const to = { x: from.x, y: ownerBox!.y + 10 };
    expect(from.x).toBeGreaterThan(ownerBox!.x);
    expect(from.x).toBeLessThan(ownerBox!.x + ownerBox!.width);
    expect(from.y - to.y).toBeGreaterThan(60);
    const startScrollTop = await fixture.owner.evaluate((element) => element.scrollTop);

    // Watch the thumb's classes, so a drag that starts and ends within the
    // swipe still counts: removing .dragging leaves it in the old value.
    await fixture.thumb.evaluate((thumb) => {
      const watched = thumb as HTMLElement & { __dragged?: () => boolean };
      let seen = false;
      const note = (records: MutationRecord[]): void => {
        if (records.some((record) => /\bdragging\b/u.test(record.oldValue ?? ''))) seen = true;
      };
      const observer = new MutationObserver(note);
      observer.observe(thumb, {
        attributes: true,
        attributeFilter: ['class'],
        attributeOldValue: true,
      });
      watched.__dragged = () => {
        note(observer.takeRecords());
        return seen || thumb.classList.contains('dragging');
      };
    });

    const cdp = await page.context().newCDPSession(page);
    await fingerStroke(page, cdp, from, to);

    // Pushing the content up scrolls further down the list. A thumb dragged up
    // would scroll it back toward the top.
    await expect
      .poll(() =>
        fixture.thumb.evaluate((thumb, start) => {
          const watched = thumb as HTMLElement & { __dragged?: () => boolean };
          const owner = thumb.parentElement!.parentElement!.querySelector(':scope > .tab-body')!;
          return {
            dragged: watched.__dragged?.() ?? true,
            scrolledDown: owner.scrollTop > start,
          };
        }, startScrollTop),
      )
      .toEqual({ dragged: false, scrolledDown: true });
  });

  test('stops a scroll the engine keeps delivering when a finger grabs the thumb, then the list follows the finger', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'Playwright moves a finger only through the Chromium DevTools protocol',
    );
    await grabThumbWhileEngineScrolls(page, 'finger');
  });

  // Playwright's WebKit cannot move a finger, but a tap is enough here: the
  // hold has to be in place while the touchstart runs, as the finger lands.
  test('holds its scroller for a finger on the thumb and lets go when it lifts', async ({
    page,
  }) => {
    await openReadyApp(page);
    const fixture = await installFixture(page);
    await letStylesheetOwnOverflow(fixture);
    await scrollToRatio(fixture, 0.5);
    await expectThumbAtRatio(fixture, 0.5);
    await recordOverflowAtTouchStart(fixture.thumb);
    const box = await fixture.thumb.boundingBox();
    expect(box).not.toBeNull();
    const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    await showBarUnder(fixture, 'thumb', point);
    await page.touchscreen.tap(point.x, point.y);
    expect(await overflowAtTouchStart(fixture.thumb)).toEqual(['hidden']);
    await expectLetGo(fixture);
  });

  test('holds its scroller for a finger on the empty part of the bar and lets go when it lifts', async ({
    page,
  }) => {
    await openReadyApp(page);
    const fixture = await installFixture(page);
    await letStylesheetOwnOverflow(fixture);
    // The thumb at the bottom leaves the top of the bar empty.
    await scrollToRatio(fixture, 1);
    await expectThumbAtRatio(fixture, 1);
    await recordOverflowAtTouchStart(fixture.track);
    const box = await fixture.track.boundingBox();
    expect(box).not.toBeNull();
    const point = { x: box!.x + box!.width / 2, y: box!.y + 20 };
    await showBarUnder(fixture, 'track', point);
    await page.touchscreen.tap(point.x, point.y);
    expect(await overflowAtTouchStart(fixture.track)).toEqual(['hidden']);
    await expectLetGo(fixture);
  });
});
