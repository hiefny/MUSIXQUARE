/**
 * E2E: focus rings belong to keyboard navigation.
 *
 * Owner request (2026-11-18), desktop Edge in the dark theme: a click on an
 * empty spot of the Play, Playlist or Settings column followed by Space (the
 * play/pause shortcut) drew a blue box around the whole column, off its
 * divider lines; and a dialog often opened with a blue ring on one of its
 * buttons for a person who was not navigating by keyboard.
 *
 * The rule: a ring shows for a person navigating by keyboard (Tab and
 * Shift+Tab, the arrows, Home, End and page keys on a widget they move
 * through or move, and any of those keys that moves focus), and never only
 * because a click, a tap, a play/pause or typing key, a key that only
 * scrolls, a Tab that a text field keeps for itself, or a window opening
 * moved focus. Keyboard navigation keeps every ring, into dialogs and back.
 * e2e/keyboard-focus-ring-spatial-navigation.test.ts covers arrows that move
 * focus as a TV remote does.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import postcss, { type AtRule } from 'postcss';
import { uploadFixtures } from './helpers/file-upload.ts';
import {
  DESKTOP,
  emptySpot,
  focusRing,
  openRoomWithTrack,
  openStartScreen,
  type FocusRing,
} from './helpers/focus-ring.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import {
  openChatDrawer,
  readPlaybackProjection,
  sendChat,
  waitForFilePlaybackReady,
  waitForPlaylistCount,
  waitForViewTransitionEnd,
} from './helpers/wait.ts';

test.use({ serviceWorkers: 'block', colorScheme: 'dark' });

const PHONE = { width: 390, height: 844 };

type BusWindow = { __MUSIXQUARE_BUS__: { emit: (...args: unknown[]) => void } };

/** Waits for focus to settle on `target`, then reads its ring. */
async function ringOn(page: Page, target: Locator): Promise<FocusRing> {
  await expect(target).toBeFocused();
  return focusRing(page);
}

/** The logo's leave confirmation: [Stay | Leave], Stay focused first. */
const dialog = (page: Page) => page.locator('#dialog-overlay.show');
const stay = (page: Page) => page.locator('#btn-dialog-secondary');
const leave = (page: Page) => page.locator('#btn-dialog-ok');

/** Opens the leave confirmation from script, with no input of its own. */
async function openLeaveDialogByItself(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('app-logo')!.click());
  await expect(dialog(page)).toBeVisible();
}

async function closeDialogByPointer(page: Page): Promise<void> {
  await stay(page).click();
  await expect(dialog(page)).toHaveCount(0);
}

/** Reaches the skip link from the logo, the next control after it. */
async function tabToSkipLink(page: Page): Promise<Locator> {
  await page.locator('#app-logo').focus();
  await page.keyboard.press('Shift+Tab');
  const skipLink = page.locator('.skip-link');
  await expect(skipLink).toBeFocused();
  return skipLink;
}

interface RingInk {
  /** Share of each visible edge's 2px inner band that the ring paints. */
  readonly inside: Record<'top' | 'right' | 'bottom' | 'left', number>;
  /** Share of the 4px band just outside each visible edge that the ring paints. */
  readonly outside: Record<'top' | 'right' | 'bottom' | 'left', number>;
}

/**
 * Where a focused panel's ring paints: the pixels that change when the panel
 * loses focus, read along each edge of the panel's border box that is on
 * screen. Pixels under another surface (the header, the bottom navigation)
 * are left out; the panel's own children count, so a child painted over the
 * ring shows up as a gap.
 */
async function ringInk(page: Page, panel: Locator): Promise<RingInk> {
  await expect(panel).toBeFocused();
  const shown = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await panel.evaluate((element) => (element as HTMLElement).blur());
  const hidden = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await panel.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
  return panel.evaluate(
    async (element, { shownPng, hiddenPng }) => {
      const decode = async (base64: string): Promise<ImageData> => {
        const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'none',
        });
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [before, after] = await Promise.all([decode(shownPng), decode(hiddenPng)]);
      const scale = before.width / window.innerWidth;
      const changed = (x: number, y: number): boolean => {
        const px = Math.floor(x * scale);
        const py = Math.floor(y * scale);
        if (px < 0 || py < 0 || px >= before.width || py >= before.height) return false;
        const offset = (py * before.width + px) * 4;
        return (
          Math.max(
            Math.abs(before.data[offset]! - after.data[offset]!),
            Math.abs(before.data[offset + 1]! - after.data[offset + 1]!),
            Math.abs(before.data[offset + 2]! - after.data[offset + 2]!),
          ) >= 40
        );
      };
      const rect = element.getBoundingClientRect();
      const exposed = (x: number, y: number): boolean => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === element || element.contains(hit));
      };
      const left = Math.max(rect.left, 0);
      const right = Math.min(rect.right, window.innerWidth);
      const top = Math.max(rect.top, 0);
      const bottom = Math.min(rect.bottom, window.innerHeight);
      /** Share of exposed positions along an edge where the band changed. */
      const coverage = (
        along: [number, number],
        across: [number, number],
        horizontal: boolean,
      ): number => {
        let seen = 0;
        let painted = 0;
        for (let a = along[0] + 3; a < along[1] - 3; a += 1) {
          const probe = horizontal
            ? [a + 0.5, (across[0] + across[1]) / 2]
            : [(across[0] + across[1]) / 2, a + 0.5];
          if (!exposed(probe[0]!, probe[1]!)) continue;
          seen += 1;
          let hit = false;
          for (let c = across[0]; c < across[1] && !hit; c += 0.5) {
            hit = horizontal ? changed(a + 0.5, c) : changed(c, a + 0.5);
          }
          if (hit) painted += 1;
        }
        return seen === 0 ? 1 : painted / seen;
      };
      const band = 2;
      const gap = 4;
      return {
        inside: {
          top: rect.top >= 0 ? coverage([left, right], [rect.top, rect.top + band], true) : 0,
          bottom:
            rect.bottom <= window.innerHeight
              ? coverage([left, right], [rect.bottom - band, rect.bottom], true)
              : 0,
          left: rect.left >= 0 ? coverage([top, bottom], [rect.left, rect.left + band], false) : 0,
          right:
            rect.right <= window.innerWidth
              ? coverage([top, bottom], [rect.right - band, rect.right], false)
              : 0,
        },
        outside: {
          top: coverage([left, right], [rect.top - gap, rect.top], true),
          bottom: coverage([left, right], [rect.bottom, rect.bottom + gap], true),
          left: coverage([top, bottom], [rect.left - gap, rect.left], false),
          right: coverage([top, bottom], [rect.right, rect.right + gap], false),
        },
      };
    },
    { shownPng: shown.toString('base64'), hiddenPng: hidden.toString('base64') },
  );
}

function expectRingOnOwnEdge(ink: RingInk, label: string): void {
  for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
    expect(ink.inside[edge], `${label}: ring on its own ${edge} edge`).toBeGreaterThan(0.95);
  }
}

test.describe('focus rings follow keyboard navigation', () => {
  test('a click on an empty spot of a column and Space draw no ring around the column', async ({
    page,
  }) => {
    await openRoomWithTrack(page, DESKTOP);
    for (const panel of ['#tab-play', '#tab-playlist', '#tab-settings']) {
      const spot = await emptySpot(page, panel);
      await page.mouse.click(spot.x, spot.y);
      await expect(page.locator(panel)).toBeFocused();
      const before = await readPlaybackProjection(page);
      await page.keyboard.press('Space');
      // Space played or paused the track: it was the shortcut, not navigation.
      await expect.poll(() => readPlaybackProjection(page), { timeout: 10_000 }).not.toBe(before);
      expect(await ringOn(page, page.locator(panel)), panel).toMatchObject({ ring: false });
    }
  });

  test('a dialog opened by a click, and Escape back to the opener, draw no ring', async ({
    page,
  }) => {
    await openRoomWithTrack(page, DESKTOP);
    await page.locator('#app-logo').click();
    await expect(dialog(page)).toBeVisible();
    expect(await ringOn(page, stay(page))).toMatchObject({ ring: false });
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    // Escape closed the window; the person did not navigate to the logo.
    expect(await ringOn(page, page.locator('#app-logo'))).toMatchObject({ ring: false });
  });

  test('a dialog that opens by itself draws no ring until the person uses Tab', async ({
    page,
  }) => {
    await openStartScreen(page);
    await page.evaluate(() =>
      (window as unknown as BusWindow).__MUSIXQUARE_BUS__.emit(
        'network:session-full',
        'The room is full',
      ),
    );
    await expect(dialog(page)).toBeVisible();
    expect(await ringOn(page, leave(page))).toMatchObject({ ring: false });
    // Tab keeps focus inside the one-button dialog, now with its ring.
    await page.keyboard.press('Tab');
    expect(await ringOn(page, leave(page))).toMatchObject({ ring: true });
  });

  test('a dialog that opens after Space or after typing in chat draws no ring', async ({
    page,
  }) => {
    await openRoomWithTrack(page, DESKTOP);

    const spot = await emptySpot(page, '#tab-play');
    await page.mouse.click(spot.x, spot.y);
    await page.keyboard.press('Space');
    await openLeaveDialogByItself(page);
    expect(await ringOn(page, stay(page)), 'after Space').toMatchObject({ ring: false });
    await closeDialogByPointer(page);

    await page.locator('#chat-input').click();
    await page.keyboard.type('See you all at eight');
    await openLeaveDialogByItself(page);
    expect(await ringOn(page, stay(page)), 'after typing').toMatchObject({ ring: false });
    await closeDialogByPointer(page);

    // A chat command that opens the account window, typed and sent with Enter.
    await page.locator('#chat-input').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('/nick Tester');
    await page.keyboard.press('Enter');
    const account = page.locator('#account-dialog-overlay.show');
    await expect(account).toBeVisible();
    await expect.poll(() => focusRing(page).then((ring) => ring.focused)).toMatch(/^#btn-account/);
    expect(await focusRing(page), 'after a chat command').toMatchObject({ ring: false });
  });

  test('a Tab that completes a chat command draws no ring on the next window, and a Tab out of the field does', async ({
    page,
  }) => {
    await openRoomWithTrack(page, DESKTOP);
    const input = page.locator('#chat-input');

    // Tab out of the chat field is navigation: the next control rings.
    await input.click();
    await page.keyboard.type('See you all at eight');
    await page.keyboard.press('Tab');
    await expect(input).not.toBeFocused();
    expect(await focusRing(page), 'Tab out of the chat field').toMatchObject({ ring: true });

    // Tab that completes a command keeps focus in the field: a mouse user
    // finishing '/users' is not navigating.
    await input.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('/us');
    await page.keyboard.press('Tab');
    await expect(input).toBeFocused();
    await expect(input).toContainText('/users');
    await openLeaveDialogByItself(page);
    expect(await ringOn(page, stay(page)), 'after a completion Tab').toMatchObject({
      ring: false,
    });
    await closeDialogByPointer(page);

    // The same for a command completed with Tab and sent with Enter.
    await input.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('/ni');
    await page.keyboard.press('Tab');
    await expect(input).toContainText('/nick');
    await page.keyboard.type('Tester');
    await page.keyboard.press('Enter');
    await expect(page.locator('#account-dialog-overlay.show')).toBeVisible();
    await expect.poll(() => focusRing(page).then((ring) => ring.focused)).toMatch(/^#btn-account/);
    expect(await focusRing(page), 'after a completed chat command').toMatchObject({
      ring: false,
    });
  });

  test('an arrow or page key that only scrolls draws no ring on a clicked track, nor on the next window', async ({
    page,
  }) => {
    await openRoomWithTrack(page, DESKTOP);
    const track = page.locator('#playlist-ui button.track-name').first();
    await track.click();
    await expect(track).toBeFocused();
    for (const key of ['ArrowDown', 'PageDown', 'End', 'ArrowUp', 'PageUp', 'Home']) {
      await page.keyboard.press(key);
      expect(await ringOn(page, track), key).toMatchObject({ ring: false });
    }
    await openLeaveDialogByItself(page);
    expect(await ringOn(page, stay(page)), 'the next window').toMatchObject({ ring: false });
  });

  test('a keyboard reorder started after a click rings the row handle once an arrow moves it', async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await injectPeerServer(page);
    await setupHostAndStart(page);
    await uploadFixtures(page, ['test01', 'test02']);
    await waitForPlaylistCount(page, 2);
    await waitForFilePlaybackReady(page, 30_000);
    await waitForViewTransitionEnd(page);
    const list = page.locator('#playlist-ui');
    const handle = list.locator('.playlist-reorder-handle').first();
    await handle.click();
    await expect(handle).toBeFocused();
    expect(await focusRing(page), 'after the click').toMatchObject({ ring: false });
    // The press started a pointer drag; Space grabs the row once its release
    // has settled (Space before that does nothing).
    const grabbed = () =>
      list.evaluate((element) => element.classList.contains('is-keyboard-reordering'));
    await expect
      .poll(
        async () => {
          if (!(await grabbed())) await page.keyboard.press('Space');
          return grabbed();
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    expect(await focusRing(page), 'after Space').toMatchObject({ ring: false });
    await page.keyboard.press('ArrowDown');
    // The row moved down to second place with its focused handle.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const entries = [...document.querySelectorAll('#playlist-ui .playlist-entry')];
          const entry = document.activeElement?.closest('.playlist-entry');
          return entry ? entries.indexOf(entry) : -1;
        }),
      )
      .toBe(1);
    expect(await focusRing(page), 'after the arrow').toMatchObject({ ring: true });
    await page.keyboard.press('Escape');
  });

  test('keyboard navigation keeps every ring, into a dialog, through it and back', async ({
    page,
  }) => {
    await openRoomWithTrack(page, DESKTOP);
    const logo = page.locator('#app-logo');
    await tabToSkipLink(page);
    await page.keyboard.press('Tab');
    expect(await ringOn(page, logo)).toMatchObject({ ring: true });
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    expect(await ringOn(page, stay(page)), 'first focused control').toMatchObject({ ring: true });
    await page.keyboard.press('Tab');
    expect(await ringOn(page, leave(page))).toMatchObject({ ring: true });
    await page.keyboard.press('Shift+Tab');
    expect(await ringOn(page, stay(page))).toMatchObject({ ring: true });
    // Escape navigates nowhere itself, but it keeps a keyboard user's ring.
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    expect(await ringOn(page, logo), 'back on the opener').toMatchObject({ ring: true });

    // A slider pressed by the pointer shows no ring until its arrows move it.
    const volume = page.locator('#volume-slider');
    await volume.click();
    expect(await ringOn(page, volume), 'slider after a click').toMatchObject({ ring: false });
    await page.keyboard.press('ArrowLeft');
    expect(await ringOn(page, volume), 'slider after an arrow').toMatchObject({ ring: true });
  });

  test('the skip link rings the active column on its own edge, the same on every column', async ({
    page,
  }) => {
    await openRoomWithTrack(page, DESKTOP);
    await tabToSkipLink(page);
    await page.keyboard.press('Enter');
    const play = page.locator('#tab-play');
    expect(await ringOn(page, play)).toMatchObject({ ring: true, outline: 'solid 2px -2px' });
    expectRingOnOwnEdge(await ringInk(page, play), '#tab-play');

    // The other columns take focus only from script (an emptied playlist, a
    // hidden jump button); for a keyboard user their ring has the same shape.
    for (const panel of ['#tab-playlist', '#tab-settings']) {
      const column = page.locator(panel);
      await column.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
      expect(await ringOn(page, column), panel).toMatchObject({
        ring: true,
        outline: 'solid 2px -2px',
      });
      expectRingOnOwnEdge(await ringInk(page, column), panel);
    }
  });

  test('the chat log and the playlist ring on their own edges where focus waits on them', async ({
    page,
  }) => {
    await openRoomWithTrack(page, DESKTOP);
    await tabToSkipLink(page);
    // Focus waits on the chat log when its scroll-down button hides under
    // focus, and on the list when the last rows picked for removal go.
    for (const selector of ['#chat-messages', '#playlist-ui']) {
      const container = page.locator(selector);
      await container.evaluate((element) => {
        (element as HTMLElement).tabIndex = -1;
        (element as HTMLElement).focus({ preventScroll: true });
      });
      expect(await ringOn(page, container), selector).toMatchObject({
        ring: true,
        outline: 'solid 2px -2px',
      });
      expectRingOnOwnEdge(await ringInk(page, container), selector);
    }
  });
});

test.describe('focus rings follow keyboard navigation on a phone', () => {
  test.use({ hasTouch: true });

  test('a tap and Space draw no ring around the panel or on a dialog it opens', async ({
    page,
  }) => {
    await openRoomWithTrack(page, PHONE);
    const play = page.locator('#tab-play');
    const spot = await emptySpot(page, '#tab-play');
    await page.touchscreen.tap(spot.x, spot.y);
    await expect(play).toBeFocused();
    await page.keyboard.press('Space');
    expect(await ringOn(page, play), 'tap and Space').toMatchObject({ ring: false });

    await page.locator('#app-logo').tap();
    await expect(dialog(page)).toBeVisible();
    expect(await ringOn(page, stay(page)), 'dialog opened by a tap').toMatchObject({
      ring: false,
    });
  });

  test('the skip link rings each tab panel on its own edge, inside the screen', async ({
    page,
  }) => {
    await openRoomWithTrack(page, PHONE);
    for (const tab of ['play', 'playlist', 'connect', 'settings', 'guide']) {
      await page.locator(`.nav-item[data-tab="${tab}"]`).tap();
      const panel = page.locator(`#tab-${tab}`);
      await expect(panel).toHaveClass(/\bactive\b/);
      await waitForViewTransitionEnd(page);
      await tabToSkipLink(page);
      await page.keyboard.press('Enter');
      expect(await ringOn(page, panel), tab).toMatchObject({
        ring: true,
        outline: 'solid 2px -2px',
      });
      expectRingOnOwnEdge(await ringInk(page, panel), `#tab-${tab} on a phone`);
    }
  });
});

test.describe('focus rings in the language list', () => {
  test('a click opens it without a ring and keyboard navigation opens it with one', async ({
    page,
  }) => {
    await openStartScreen(page);
    const trigger = page.locator('[data-setup-language-trigger]:visible');
    const overlay = page.locator('#language-dialog-overlay');
    const activeLanguage = overlay.locator('.language-option.active');
    await trigger.click();
    await expect(overlay).toHaveClass(/show/);
    expect(await ringOn(page, activeLanguage), 'opened by a click').toMatchObject({
      ring: false,
    });
    await page.locator('#btn-language-dialog-done').click();
    await expect(overlay).not.toHaveClass(/show/);

    await trigger.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    expect(await ringOn(page, trigger)).toMatchObject({ ring: true });
    await page.keyboard.press('Enter');
    await expect(overlay).toHaveClass(/show/);
    expect(await ringOn(page, activeLanguage), 'opened from the keyboard').toMatchObject({
      ring: true,
    });
  });
});

/**
 * Serves the app stylesheet as an engine that knows :focus-visible but not
 * :where() reads it: Chromium 86 and 87, for example 2022 LG webOS TVs
 * (docs/known-accepted.md #20). Such an engine drops every rule whose selector
 * names :where() or :has(), and an `@supports selector()` test of either is
 * false there. Every rule under the keyboard gate is gone, so only ungated
 * rules can draw a ring.
 */
async function readStylesheetWithoutWhere(page: Page): Promise<void> {
  const unknown = /:(?:where|has)\(/u;
  // Nothing leaves the machine; a chat YouTube link reads a fixed title.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.fallback();
    if (url.hostname === 'www.youtube.com' && url.pathname === '/oembed') {
      return route.fulfill({ json: { title: 'Sample track' } });
    }
    return route.abort();
  });
  await page.route(/\/assets\/main-[^/?#]*\.css(?:[?#].*)?$/u, async (route) => {
    const response = await route.fetch();
    const root = postcss.parse(await response.text());
    const tests: AtRule[] = [];
    root.walkAtRules('supports', (rule) => {
      tests.push(rule);
    });
    for (const rule of tests) {
      const selectorTest = /^(not\s+)?selector\((.+)\)$/u.exec(rule.params.trim());
      if (!selectorTest || !unknown.test(selectorTest[2]!)) continue;
      if (selectorTest[1]) rule.replaceWith([...(rule.nodes ?? [])]);
      else rule.remove();
    }
    root.walkRules((rule) => {
      const parent = rule.parent as AtRule | undefined;
      if (parent?.type === 'atrule' && /keyframes$/u.test(parent.name)) return;
      if (unknown.test(rule.selector)) rule.remove();
    });
    await route.fulfill({ response, body: root.toString() });
  });
}

/** Reaches `target` the way a keyboard user does: Tab from the control before it. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
}

/** The ring of the surface a focused choice radio paints (src/ui/dialog.ts). */
async function choiceSurfaceRing(page: Page): Promise<FocusRing> {
  return page.evaluate(() => {
    const radio = document.activeElement as HTMLInputElement;
    const surface = radio.nextElementSibling as HTMLElement;
    const style = getComputedStyle(surface);
    return {
      focused: `${radio.className}[value=${radio.value}]`,
      ring: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0,
      outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset}`,
    };
  });
}

test.describe('focus rings on an engine without :where()', () => {
  test('the carousel arrows and the PIN dialog choice rows ring on the start screen', async ({
    page,
  }) => {
    await readStylesheetWithoutWhere(page);
    await openStartScreen(page);
    for (const arrow of ['#ob-prev', '#ob-next']) {
      const control = page.locator(arrow);
      await tabTo(page, control);
      expect.soft(await focusRing(page), arrow).toMatchObject({ ring: true });
    }

    // The PIN dialog's choice rows, built as src/ui/dialog.ts builds them: a
    // transparent native radio before the surface that shows the row.
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.setAttribute(
        'style',
        'position:fixed;left:40px;top:120px;width:360px;z-index:2147483647;padding:16px',
      );
      const before = document.createElement('button');
      before.type = 'button';
      before.id = 'choice-before';
      before.textContent = 'Before';
      const list = document.createElement('div');
      list.className = 'dialog-choice-list';
      list.setAttribute('role', 'radiogroup');
      for (const value of ['keep', 'rejoin']) {
        const row = document.createElement('label');
        row.className = 'dialog-choice-option';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.className = 'dialog-choice-radio';
        radio.name = 'choice-probe';
        radio.value = value;
        radio.checked = value === 'keep';
        const surface = document.createElement('span');
        surface.className = 'dialog-choice-surface';
        surface.setAttribute('aria-hidden', 'true');
        surface.textContent = value;
        row.append(radio, surface);
        list.appendChild(row);
      }
      host.append(before, list);
      document.body.appendChild(host);
    });
    await page.locator('#choice-before').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('.dialog-choice-radio[value="keep"]')).toBeFocused();
    expect.soft(await choiceSurfaceRing(page), 'checked row, by Tab').toMatchObject({ ring: true });
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.dialog-choice-radio[value="rejoin"]')).toBeFocused();
    expect
      .soft(await choiceSurfaceRing(page), 'next row, by an arrow')
      .toMatchObject({ ring: true });
  });

  test("the play panel's Sync and Play media buttons and the chat's YouTube button ring in a room", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await readStylesheetWithoutWhere(page);
    await openRoomWithTrack(page, DESKTOP);
    for (const id of ['#btn-sync', '#btn-media-source']) {
      const button = page.locator(id);
      await tabTo(page, button);
      expect.soft(await focusRing(page), id).toMatchObject({ ring: true });
    }

    await openChatDrawer(page);
    await sendChat(page, 'https://youtu.be/aqz-KE-bpKQ');
    const youtube = page.locator('.chat-youtube-btn').first();
    await expect(youtube).toBeVisible();
    await tabTo(page, youtube);
    expect.soft(await focusRing(page), '.chat-youtube-btn').toMatchObject({ ring: true });
  });
});
