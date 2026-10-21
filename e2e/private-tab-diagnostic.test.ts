import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { E2E_APP_ORIGIN } from './config.ts';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { useAnonymousAccountSession } from './helpers/context-factory.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupGuest, setupHostAndStart } from './helpers/setup-flow.ts';

const MOBILE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  serviceWorkers: 'block' as const,
};

test.use(MOBILE);

test.beforeEach(async ({page}) => {
  await page.addInitScript(() => {
    const events: unknown[] = [];
    (window as any).__tabDiagnostic = events;
    const targetName = (target: any) => target instanceof Element ? target.tagName + '#' + target.id + '.' + target.className : String(target);
    const sample = (kind: string, detail: any = {}) => {
      if (events.length > 2000) return;
      events.push({kind, at: performance.now(), active: document.querySelector('.nav-item.active')?.getAttribute('data-tab'), scrollTop: document.querySelector('#tab-playlist .tab-body')?.scrollTop, ...detail});
    };
    for (const type of ['touchstart','touchend','touchcancel','pointerdown','pointerup','pointercancel','click','scroll','scrollend']) {
      document.addEventListener(type, (event: any) => {
        const nav = document.getElementById('nav-play');
        const rect = nav?.getBoundingClientRect();
        sample(type, {target:targetName(event.target), trusted:event.isTrusted, x:event.clientX, y:event.clientY, pointerId:event.pointerId, touches:Array.from(event.touches ?? []).map((t:any)=>({id:t.identifier,x:t.clientX,y:t.clientY})), hit:rect ? targetName(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)) : null});
        queueMicrotask(()=> {if(event.defaultPrevented) sample(type+'-prevented',{target:targetName(event.target)});});
      }, {capture:true,passive:true});
    }
    for (const name of ['preventDefault','stopImmediatePropagation','stopPropagation'] as const) {
      const original = Event.prototype[name];
      Event.prototype[name] = function(...args:any[]) {
        if(['click','touchstart','touchend','pointerdown','pointerup'].includes(this.type)) sample(name,{event:this.type,target:targetName(this.target),stack:new Error().stack});
        return original.apply(this,args);
      };
    }
    const original = document.startViewTransition?.bind(document);
    if(original) document.startViewTransition = ((callback:any) => {
      sample('vt-start');
      const vt=original(()=> { sample('vt-callback-before'); const result=callback(); sample('vt-callback-after'); return result; });
      vt.ready.then(()=>sample('vt-ready'),()=>sample('vt-ready-reject'));
      vt.finished.then(()=>sample('vt-finished'),()=>sample('vt-finished-reject'));
      return vt;
    }) as any;
  });
});
test.afterEach(async ({page},info) => {
  await info.attach('tab-diagnostic', {body:JSON.stringify(await page.evaluate(()=>(window as any).__tabDiagnostic),null,2),contentType:'application/json'});
});


// These exercise the shipped app in Chromium and Playwright WebKit. Neither
// engine emulates an installed iOS 17 PWA or its post-keyboard viewport bug.
async function openHost(page: Page): Promise<string> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await injectPeerServer(page);
  await useAnonymousAccountSession(page);
  return setupHostAndStart(page);
}

async function openWebKitRoleFixture(page: Page, role: 'host' | 'guest'): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await injectPeerServer(page);
  await useAnonymousAccountSession(page);
  await page.goto('/');
  await waitForBootstrapReady(page);
  // The Windows Playwright WebKit build has no PeerJS WebRTC transport. Match
  // webkit-mobile-smoke's initialized-app fixture: seed only the session role
  // and dismiss setup, preserving production authority/renderers/handlers.
  // Chromium above/below covers actual room creation and room-code joining.
  await page.evaluate((role) => {
    const runtime = window as typeof window & {
      __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void;
      __MUSIXQUARE_BUS__: { emit(type: string, ...args: unknown[]): void };
    };
    runtime.__MUSIXQUARE_SET_STATE__('network.appRole', role);
    runtime.__MUSIXQUARE_SET_STATE__('setup.sessionStarted', true);
    document.getElementById('setup-overlay')?.classList.remove('active');
    document.body.classList.remove('overlay-open');
    runtime.__MUSIXQUARE_BUS__.emit('setup:app-entrance');
  }, role);
}

async function viewportSnapshot(page: Page) {
  return page.evaluate(() => ({
    scale: window.visualViewport?.scale ?? 1,
    offsetTop: window.visualViewport?.offsetTop ?? 0,
    offsetLeft: window.visualViewport?.offsetLeft ?? 0,
    visualHeight: window.visualViewport?.height ?? window.innerHeight,
    visualWidth: window.visualViewport?.width ?? window.innerWidth,
    innerHeight: window.innerHeight,
    rootHeight: document.documentElement.getBoundingClientRect().height,
    bodyTop: document.body.getBoundingClientRect().top,
    bodyBottom: document.body.getBoundingClientRect().bottom,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    headerTop: document.querySelector('header')!.getBoundingClientRect().top,
  }));
}

async function doubleTapUnavailable(page: Page, id: string): Promise<void> {
  const button = page.locator(`#${id}`);
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(await button.evaluate((element) => (element as HTMLButtonElement).disabled)).toBe(false);
  await expect(button).toHaveCSS('touch-action', 'manipulation');
  // A real user can tap aria-disabled controls to receive their explanation.
  // Locator.tap intentionally refuses them, so use the trusted touchscreen at
  // the rendered center rather than a synthetic DOM click or a force option.
  const box = await button.boundingBox();
  if (!box) throw new Error(`${id} has no touch target`);
  const before = await viewportSnapshot(page);
  expect(before.scale).toBe(1);
  await page.evaluate((id) => {
    const target = document.getElementById(id)!;
    target.dataset.touchPolicyClicks = '0';
    target.addEventListener('click', () => {
      target.dataset.touchPolicyClicks = String(Number(target.dataset.touchPolicyClicks) + 1);
    });
  }, id);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(40);
  await page.touchscreen.tap(x, y);
  await expect(button).toHaveAttribute('data-touch-policy-clicks', '2');
  await expect(page.locator('#toast')).toHaveClass(/\bshow\b/);
  // Allow a browser double-tap gesture to settle before sampling geometry.
  await page.waitForTimeout(400);
  expect(await viewportSnapshot(page)).toEqual(before);
}

test('unavailable host and guest controls keep tap feedback without changing the viewport', async ({
  page,
  browser,
  browserName,
}) => {
  const code = browserName === 'webkit' ? null : await openHost(page);
  if (browserName === 'webkit') await openWebKitRoleFixture(page, 'host');
  await doubleTapUnavailable(page, 'play-btn');

  const guestContext = await browser.newContext({
    ...MOBILE,
    baseURL: E2E_APP_ORIGIN,
    userAgent: await page.evaluate(() => navigator.userAgent),
  });
  try {
    const guest = await guestContext.newPage();
    if (code === null) {
      await openWebKitRoleFixture(guest, 'guest');
    } else {
      await guest.emulateMedia({ reducedMotion: 'reduce' });
      await injectPeerServer(guest);
      await useAnonymousAccountSession(guest);
      // Chromium uses real room-code entry and joining. Desktop automation
      // does not provide the physical iOS keyboard, despite editable focus.
      await setupGuest(guest, code);
    }
    for (const id of ['btn-prev', 'play-btn', 'btn-next']) {
      await doubleTapUnavailable(guest, id);
    }

    await guest.locator('.nav-item[data-tab="playlist"]').tap();
    await expect(guest.locator('#tab-playlist')).toHaveClass(/\bactive\b/);
    await guest.locator('.nav-item[data-tab="play"]').tap();
    await expect(guest.locator('#tab-play')).toHaveClass(/\bactive\b/);
  } finally {
    await guestContext.close();
  }
});

async function touchStroke(
  page: Page,
  cdp: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...from, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
  });
  try {
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: from.x + ((to.x - from.x) * step) / 8,
            y: from.y + ((to.y - from.y) * step) / 8,
            id: 1,
            radiusX: 1,
            radiusY: 1,
            force: 1,
          },
        ],
      });
      await page.waitForTimeout(24);
    }
    // End this drag at rest, not as a fling. Chromium otherwise consumes the
    // immediately following tab tap to stop inertia without dispatching click.
    // This is part of the input gesture, not a wait for the app to recover.
    await page.waitForTimeout(250);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ ...to, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
    });
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

async function swipeScroller(page: Page, cdp: CDPSession, scroller: Locator): Promise<void> {
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(150);
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  const readHitTarget = () =>
    scroller.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      const point = { x: box.x + box.width / 2, y: box.y + box.height * 0.75 };
      const hit = document.elementFromPoint(point.x, point.y);
      return {
        scroller: element.id || element.className,
        box,
        point,
        hit: hit ? `${hit.tagName}#${hit.id}.${hit.className}` : null,
        receivesTouch: hit !== null && element.contains(hit),
      };
    });
  const initialHit = await readHitTarget();
  let readyHit = initialHit;
  // The tab's active class commits before its native View Transition ends.
  // Raw CDP bypasses Locator actionability: a contact begun against the
  // transition snapshot cannot switch to the scroller midway through a swipe.
  // The drawer also opens from outside the viewport. Recompute the target
  // while it moves; retaining its first coordinates can wait offscreen forever.
  try {
    await expect
      .poll(
        async () => {
          const previous = readyHit.box;
          readyHit = await readHitTarget();
          return (
            readyHit.receivesTouch &&
            Object.entries(previous).every(
              ([key, value]) => readyHit.box[key as keyof typeof previous] === value,
            )
          );
        },
        {
          message:
            'The native swipe must start on the settled scroller after snapshots release input',
        },
      )
      .toBe(true);
  } finally {
    await test.info().attach(`native-swipe-${initialHit.scroller}`, {
      body: JSON.stringify({ initialHit, readyHit }, null, 2),
      contentType: 'application/json',
    });
  }
  const { box, point: start } = readyHit;
  await touchStroke(page, cdp, start, { x: start.x, y: start.y - Math.min(150, box.height / 2) });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(30);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
}

test('nested playlist and chat keep scrolling while range and drag surfaces keep their own policy', async ({
  page,
  browserName,
}) => {
  if (browserName === 'webkit') await openWebKitRoleFixture(page, 'host');
  else await openHost(page);
  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void;
      __MUSIXQUARE_BUS__: { emit(type: string, ...args: unknown[]): void };
    };
    // Seed content through the existing E2E state/event boundary; leave the
    // real renderers, scroll containers, controls and gesture handlers intact.
    runtime.__MUSIXQUARE_SET_STATE__(
      'playlist.items',
      Array.from({ length: 24 }, (_, index) => ({
        queueItemId: crypto.randomUUID(),
        type: 'youtube',
        videoId: 'dQw4w9WgXcQ',
        name: `Touch policy track ${index + 1}`,
      })),
    );
    for (let index = 0; index < 40; index += 1) {
      runtime.__MUSIXQUARE_BUS__.emit('chat:system-message', `Touch policy message ${index + 1}`);
    }
  });

  const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
  try {
    const volume = page.locator('#volume-slider');
    await expect(volume).toHaveCSS('touch-action', 'none');
    if (cdp) {
      const before = Number(await volume.inputValue());
      const box = await volume.boundingBox();
      if (!box) throw new Error('Volume slider has no touch target');
      await touchStroke(
        page,
        cdp,
        { x: box.x + box.width * 0.85, y: box.y + box.height / 2 },
        { x: box.x + box.width * 0.25, y: box.y + box.height / 2 },
      );
      await expect.poll(async () => Number(await volume.inputValue())).toBeLessThan(before - 20);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    }

    await page.locator('.nav-item[data-tab="playlist"]').tap();
    await expect(page.locator('#tab-playlist')).toHaveClass(/\bactive\b/);
    const playlist = page.locator('#tab-playlist .tab-body');
    await expect(playlist).toHaveCSS('touch-action', 'manipulation');
    await expect(page.locator('.track-item').first()).toHaveCSS('touch-action', 'pan-y');
    await expect(page.locator('.track-name').first()).toHaveCSS('touch-action', 'manipulation');
    await expect(page.locator('.playlist-reorder-handle').first()).toHaveCSS(
      'touch-action',
      'none',
    );
    if (cdp) await swipeScroller(page, cdp, playlist);

    await page.locator('.nav-item[data-tab="play"]').tap();
    await expect(page.locator('#tab-play')).toHaveClass(/\bactive\b/);
    await page.locator('#chat-preview-btn').tap();
    await expect(page.locator('#chat-drawer')).toHaveClass(/\bopen\b/);
    const messages = page.locator('#chat-messages');
    await expect(messages).toHaveCSS('touch-action', 'manipulation');
    await expect(page.locator('.chat-drawer-header')).toHaveCSS('touch-action', 'none');
    if (cdp) await swipeScroller(page, cdp, messages);
  } finally {
    await cdp?.detach();
  }
});
