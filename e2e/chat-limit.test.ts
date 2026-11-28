/**
 * E2E: the chat message limit is soft (src/ui/chat.ts).
 *
 * The composer never edits what someone types to keep a message within
 * MAX_MSG_LENGTH UTF-16 units. Past the limit the text stays, the line turns
 * red, the count goes below zero and the send waits; nothing is sent until the
 * writer shortens the message. Chromium drives a stateless IME through CDP
 * (Input.imeSetComposition, then Input.insertText as the commit); WebKit runs
 * every test that needs no IME. Neither stands in for an iOS, iPadOS or
 * Android keyboard.
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { CHAT_LIMIT_WARN_START, CHAT_PASTE_MAX_LENGTH } from '../src/chat/message-length.ts';
import { MAX_MSG_LENGTH } from '../src/core/constants.ts';
import en from '../src/i18n/en.ts';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { getPageErrors, trackPageErrors } from './helpers/context-factory.ts';
import { openChatDrawer } from './helpers/wait.ts';

const MINUS = '\u{2212}';
const GRIN = '\u{1F600}';
const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}';
const KOREA = '\u{1F1F0}\u{1F1F7}';

const overLimit = (count: number): string =>
  en['chat.over_limit'].replace('{{count}}', String(count));

interface Counters {
  announcements: string[];
  compositionstart: number;
  compositionend: number;
  dummyFocus: number;
  shakes: number;
}

interface ComposerState {
  text: string;
  warning: boolean;
  over: boolean;
  /** The visible count, or null while it is hidden. */
  count: string | null;
  invalid: string | null;
  sendDisabled: string | null;
  status: string;
  loneSurrogates: number;
  /** The text the CSS highlight paints as over the limit; undefined without the API. */
  highlight: string | null | undefined;
  counters: Counters;
}

async function openComposer(page: Page): Promise<void> {
  trackPageErrors(page);
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await waitForBootstrapReady(page);
  // No room is needed: a send with no host goes to the local bubble list.
  await page.evaluate(() => {
    document.getElementById('setup-overlay')?.classList.remove('active');
    document.body.classList.remove('overlay-open');
  });
  await openChatDrawer(page, 10_000);
  // WebKit can keep the editor hidden for a moment after the sheet opens
  // (seen with reduced motion); it takes focus once it shows.
  const editor = page.locator('#chat-input');
  await expect(editor).toBeVisible();
  await editor.focus();
  await expect(editor).toBeFocused();
  await page.evaluate(() => {
    const input = document.getElementById('chat-input')!;
    const wrapper = input.closest<HTMLElement>('.chat-input-wrapper')!;
    const status = wrapper.querySelector<HTMLElement>('.chat-limit-status')!;
    const counters: Counters = {
      announcements: [],
      compositionstart: 0,
      compositionend: 0,
      dummyFocus: 0,
      shakes: 0,
    };
    (window as Window & { __chatLimit?: Counters }).__chatLimit = counters;
    input.addEventListener('compositionstart', () => (counters.compositionstart += 1));
    input.addEventListener('compositionend', () => (counters.compositionend += 1));
    document
      .getElementById('chat-ime-dummy')
      ?.addEventListener('focus', () => (counters.dummyFocus += 1));
    wrapper.addEventListener('animationstart', (event) => {
      if (event.target === wrapper && event.animationName === 'shake') counters.shakes += 1;
    });
    new MutationObserver(() => {
      const text = status.textContent ?? '';
      if (text) counters.announcements.push(text);
    }).observe(status, { childList: true, characterData: true, subtree: true });
  });
}

async function composer(page: Page): Promise<ComposerState> {
  return page.evaluate(() => {
    const input = document.getElementById('chat-input')!;
    const wrapper = input.closest<HTMLElement>('.chat-input-wrapper')!;
    const count = wrapper.querySelector<HTMLElement>('.chat-limit-count')!;
    const text = input.textContent ?? '';
    let loneSurrogates = 0;
    for (let index = 0; index < text.length; index += 1) {
      const unit = text.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) index += 1;
        else loneSurrogates += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        loneSurrogates += 1;
      }
    }
    const registry = (globalThis.CSS as unknown as { highlights?: Map<string, Set<AbstractRange>> })
      .highlights;
    let highlight: string | null | undefined;
    if (registry) {
      const painted = registry.get('chat-overflow');
      highlight = painted
        ? [...painted].map((range) => (range instanceof Range ? range.toString() : '')).join('')
        : null;
    }
    return {
      text,
      warning: wrapper.classList.contains('limit-warning'),
      over: wrapper.classList.contains('limit-over'),
      count: count.hidden ? null : (count.textContent ?? ''),
      invalid: input.getAttribute('aria-invalid'),
      sendDisabled: document.getElementById('btn-chat-send')!.getAttribute('aria-disabled'),
      status: wrapper.querySelector('.chat-limit-status')?.textContent ?? '',
      loneSurrogates,
      highlight,
      counters: { ...(window as Window & { __chatLimit?: Counters }).__chatLimit! },
    };
  });
}

function sentMessages(page: Page): Promise<string[]> {
  return page.locator('#chat-messages .chat-group:not(.system) .chat-text').allTextContents();
}

/** Empties the composer through the app's own input path. */
async function clearComposer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const input = document.getElementById('chat-input')!;
    input.focus();
    input.replaceChildren();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * A synthetic paste: the composer cancels the native paste and reads
 * clipboardData itself, so this drives the same code without the OS clipboard.
 */
async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const input = document.getElementById('chat-input')!;
    const data = new DataTransfer();
    data.setData('text/plain', value);
    input.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

async function compose(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
}

test.afterEach(async ({ page }) => {
  expect(getPageErrors(page).map((error) => error.message)).toEqual([]);
});

test('typing past the limit keeps the text, counts below zero and waits to send', async ({
  page,
}) => {
  await openComposer(page);
  await page.keyboard.insertText('a'.repeat(CHAT_LIMIT_WARN_START - 1));
  expect(await composer(page)).toMatchObject({ warning: false, over: false, count: null });
  await page.keyboard.type('a');
  expect(await composer(page)).toMatchObject({
    warning: true,
    count: String(MAX_MSG_LENGTH - CHAT_LIMIT_WARN_START),
  });

  await page.keyboard.insertText('a'.repeat(MAX_MSG_LENGTH - CHAT_LIMIT_WARN_START - 1));
  await page.keyboard.type('bc');
  const typed = 'a'.repeat(MAX_MSG_LENGTH - 1) + 'bc';
  expect(await composer(page)).toMatchObject({
    text: typed,
    over: true,
    warning: false,
    count: `${MINUS}1`,
    invalid: 'true',
    sendDisabled: 'true',
    loneSurrogates: 0,
  });
  // Once their transitions end, the underline is the field family's error
  // red, the count is red, the gauge has given way and the arrow is idle.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const wrapper = document.querySelector<HTMLElement>(
          '.chat-drawer-input .chat-input-wrapper',
        )!;
        const probe = document.createElement('span');
        wrapper.append(probe);
        probe.style.color = 'var(--danger-foreground)';
        const danger = getComputedStyle(probe).color;
        probe.style.color = 'var(--surface-3)';
        const idle = getComputedStyle(probe).color;
        probe.remove();
        return {
          line: getComputedStyle(wrapper).borderBottomColor === danger,
          count: getComputedStyle(wrapper.querySelector('.chat-limit-count')!).color === danger,
          gauge: getComputedStyle(wrapper, '::after').opacity,
          send: getComputedStyle(document.getElementById('btn-chat-send')!).color === idle,
        };
      }),
    )
    .toEqual({ line: true, count: true, gauge: '0', send: true });
  // The first pause in typing announces it once.
  await expect
    .poll(async () => (await composer(page)).counters.announcements)
    .toEqual([overLimit(1)]);
  expect((await composer(page)).status).toBe(overLimit(1));

  // Enter and the arrow refuse: one shake and one announcement each, no send.
  // Each attempt waits for its shake to start; a browser folds restarts
  // within one frame into one animation, faster than any hand presses.
  const attempts = async () => {
    const { counters } = await composer(page);
    return { announcements: counters.announcements.length, shakes: counters.shakes };
  };
  await page.keyboard.press('Enter');
  await expect.poll(attempts).toEqual({ announcements: 2, shakes: 1 });
  // Playwright waits for an aria-disabled control to enable; a person can
  // still press the idle arrow, so force the click.
  await page.locator('#btn-chat-send').click({ force: true });
  await expect.poll(attempts).toEqual({ announcements: 3, shakes: 2 });
  // A held Enter: the first keydown is an attempt, its repeats are not.
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await expect.poll(attempts).toEqual({ announcements: 4, shakes: 3 });
  let state = await composer(page);
  expect(state.counters.announcements).toEqual(Array(4).fill(overLimit(1)));
  expect(state.text).toBe(typed);
  expect(await sentMessages(page)).toEqual([]);

  // Back to exactly the limit: the state clears and the next Enter sends it whole.
  await page.keyboard.press('Backspace');
  state = await composer(page);
  expect(state).toMatchObject({ over: false, warning: true, count: '0', invalid: null });
  expect(state.sendDisabled).toBeNull();
  expect(state.status).toBe('');
  await page.keyboard.press('Enter');
  await expect.poll(() => sentMessages(page)).toEqual(['a'.repeat(MAX_MSG_LENGTH - 1) + 'b']);
  expect(await composer(page)).toMatchObject({ text: '', count: null, over: false });
});

test('composition across the limit is never trimmed (CJK and Korean, CDP IME)', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Playwright has no IME composition API for WebKit');
  await openComposer(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    // Chinese: the pinyin runs to 502 while composing; 你好 commits at 499.
    await page.keyboard.insertText('a'.repeat(MAX_MSG_LENGTH - 3));
    for (const reading of ['n', 'ni', 'nih', 'niha', 'nihao']) await compose(cdp, reading);
    let state = await composer(page);
    expect(state.text).toBe('a'.repeat(MAX_MSG_LENGTH - 3) + 'nihao');
    expect(state).toMatchObject({ over: true, count: `${MINUS}2` });
    await cdp.send('Input.insertText', { text: '\u{4F60}\u{597D}' });
    state = await composer(page);
    expect(state.text).toBe('a'.repeat(MAX_MSG_LENGTH - 3) + '\u{4F60}\u{597D}');
    expect(state).toMatchObject({ over: false, count: '1' });

    // Japanese: きょうは is 501 while composing; 今日は commits at exactly 500.
    await clearComposer(page);
    await page.keyboard.insertText('a'.repeat(MAX_MSG_LENGTH - 3));
    for (const reading of ['\u{304D}', '\u{304D}\u{3087}', '\u{304D}\u{3087}\u{3046}']) {
      await compose(cdp, reading);
    }
    await compose(cdp, '\u{304D}\u{3087}\u{3046}\u{306F}');
    expect(await composer(page)).toMatchObject({ over: true, count: `${MINUS}1` });
    await cdp.send('Input.insertText', { text: '\u{4ECA}\u{65E5}\u{306F}' });
    state = await composer(page);
    expect(state.text).toBe('a'.repeat(MAX_MSG_LENGTH - 3) + '\u{4ECA}\u{65E5}\u{306F}');
    expect(state).toMatchObject({ over: false, count: '0' });

    // Korean at the limit: the syllable goes in and stays; the send waits.
    await clearComposer(page);
    await page.keyboard.insertText('a'.repeat(MAX_MSG_LENGTH));
    for (const jamo of ['\u{3131}', '\u{AC00}']) await compose(cdp, jamo);
    await cdp.send('Input.insertText', { text: '\u{AC00}' });
    state = await composer(page);
    expect(state.text).toBe('a'.repeat(MAX_MSG_LENGTH) + '\u{AC00}');
    expect(state).toMatchObject({ over: true, count: `${MINUS}1`, loneSurrogates: 0 });

    // Every composition ended normally and nothing moved focus to the IME dummy.
    expect(state.counters.compositionstart).toBe(3);
    expect(state.counters.compositionend).toBe(3);
    expect(state.counters.dummyFocus).toBe(0);
    expect(await sentMessages(page)).toEqual([]);
  } finally {
    await cdp.detach().catch(() => {});
  }
});

test('an Enter during a composition waits for the commit, then sends or refuses', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Playwright has no IME composition API for WebKit');
  await openComposer(page);
  const cdp = await page.context().newCDPSession(page);
  const reading = '\u{306B}\u{307B}\u{3093}\u{3054}';
  const converted = '\u{65E5}\u{672C}\u{8A9E}';
  try {
    // 497 + 日本語 = 500: the Enter that confirmed the conversion sends it.
    await page.keyboard.insertText('a'.repeat(MAX_MSG_LENGTH - 3));
    await compose(cdp, reading);
    await page.keyboard.press('Enter');
    await cdp.send('Input.insertText', { text: converted });
    await expect
      .poll(() => sentMessages(page))
      .toEqual(['a'.repeat(MAX_MSG_LENGTH - 3) + converted]);
    let state = await composer(page);
    expect(state.text).toBe('');
    // The send itself hands focus through the IME dummy once (iOS reset).
    expect(state.counters.dummyFocus).toBe(1);

    // 498 + 日本語 = 501: the waiting Enter is refused and the text stays.
    await page.keyboard.insertText('b'.repeat(MAX_MSG_LENGTH - 2));
    await compose(cdp, reading);
    await page.keyboard.press('Enter');
    await cdp.send('Input.insertText', { text: converted });
    await expect
      .poll(async () => (await composer(page)).counters.announcements)
      .toEqual([overLimit(1)]);
    state = await composer(page);
    expect(state.text).toBe('b'.repeat(MAX_MSG_LENGTH - 2) + converted);
    expect(state).toMatchObject({ over: true, count: `${MINUS}1` });
    expect(state.counters.compositionend).toBe(state.counters.compositionstart);
    // A refusal moves no focus.
    expect(state.counters.dummyFocus).toBe(1);
    expect(await sentMessages(page)).toHaveLength(1);
  } finally {
    await cdp.detach().catch(() => {});
  }
});

test('undo after a paste takes the paste back and keeps the caret', async ({
  page,
  browserName,
}) => {
  await openComposer(page);
  await page.keyboard.type('hello ');
  await paste(page, 'world');
  expect((await composer(page)).text).toBe('hello world');
  await page.keyboard.press('Control+Z');
  const undone = (await composer(page)).text;
  // Chromium undoes the paste; this WebKit build merges typing and paste.
  expect(undone).not.toContain('world');
  expect('hello '.startsWith(undone)).toBe(true);
  await page.keyboard.type('!');
  expect((await composer(page)).text).toBe(`${undone}!`);

  // A paste that goes past the limit is kept, and one undo takes it back.
  await clearComposer(page);
  await page.keyboard.insertText('a'.repeat(450));
  await paste(page, 'B'.repeat(100));
  expect(await composer(page)).toMatchObject({ over: true, count: `${MINUS}50` });
  await page.keyboard.press('Control+Z');
  const state = await composer(page);
  expect(state.text).not.toContain('B');
  if (browserName === 'chromium') expect(state.text).toBe('a'.repeat(450));
  expect(state.over).toBe(false);
});

test('a huge paste is cut on a grapheme boundary and the toast says so', async ({ page }) => {
  await openComposer(page);
  await paste(page, 'x'.repeat(CHAT_PASTE_MAX_LENGTH - 1) + GRIN + 'tail');
  const state = await composer(page);
  expect(state.text).toBe('x'.repeat(CHAT_PASTE_MAX_LENGTH - 1));
  expect(state).toMatchObject({
    loneSurrogates: 0,
    over: true,
    count: `${MINUS}${CHAT_PASTE_MAX_LENGTH - 1 - MAX_MSG_LENGTH}`,
  });
  await expect(page.locator('#toast-msg')).toHaveText(
    en['chat.msg_truncated'].replace('{{max}}', String(CHAT_PASTE_MAX_LENGTH)),
  );
  // The one unit left takes one letter; after that a paste adds nothing.
  await paste(page, 'more');
  expect((await composer(page)).text).toBe('x'.repeat(CHAT_PASTE_MAX_LENGTH - 1) + 'm');
  await paste(page, 'more');
  expect((await composer(page)).text).toHaveLength(CHAT_PASTE_MAX_LENGTH);
});

test('an emoji at the limit stays whole, and the message sends once it fits', async ({ page }) => {
  await openComposer(page);
  await page.keyboard.insertText('a'.repeat(MAX_MSG_LENGTH - 1));
  await page.keyboard.insertText(GRIN);
  let state = await composer(page);
  expect(state.text).toBe('a'.repeat(MAX_MSG_LENGTH - 1) + GRIN);
  expect(state).toMatchObject({ over: true, count: `${MINUS}1`, loneSurrogates: 0 });
  // Where CSS highlights exist, the emoji that does not fit is painted whole.
  if (state.highlight !== undefined) expect(state.highlight).toBe(GRIN);
  await page.keyboard.press('Enter');
  expect(await sentMessages(page)).toEqual([]);
  await page.keyboard.press('Backspace');
  state = await composer(page);
  expect(state).toMatchObject({ over: false, count: '1', loneSurrogates: 0 });
  if (state.highlight !== undefined) expect(state.highlight).toBeNull();
  await page.keyboard.press('Enter');
  await expect.poll(() => sentMessages(page)).toEqual(['a'.repeat(MAX_MSG_LENGTH - 1)]);

  // A family emoji and a flag across the limit stay whole too.
  await page.keyboard.insertText('a'.repeat(MAX_MSG_LENGTH - 5) + FAMILY);
  state = await composer(page);
  expect(state).toMatchObject({ over: true, count: `${MINUS}6`, loneSurrogates: 0 });
  if (state.highlight !== undefined) expect(state.highlight).toBe(FAMILY);
  await clearComposer(page);
  await page.keyboard.insertText('a'.repeat(MAX_MSG_LENGTH - 2) + KOREA);
  state = await composer(page);
  expect(state).toMatchObject({ over: true, count: `${MINUS}2`, loneSurrogates: 0 });
  if (state.highlight !== undefined) expect(state.highlight).toBe(KOREA);
});

test('with reduced motion a refused send does not shake; the red line and count stay', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openComposer(page);
  await page.keyboard.insertText('a'.repeat(MAX_MSG_LENGTH + 3));
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await composer(page)).counters.announcements)
    .toContain(overLimit(3));
  const state = await composer(page);
  expect(state).toMatchObject({ over: true, count: `${MINUS}3`, invalid: 'true' });
  expect(state.counters.shakes).toBe(0);
  expect(
    await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.chat-drawer-input .chat-input-wrapper')!)
          .animationName,
    ),
  ).toBe('none');
  expect(await sentMessages(page)).toEqual([]);
});

test('in forced colors the gauge, the count and the thick invalid edge still show', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Playwright emulates forced colors in Chromium only');
  await page.emulateMedia({ forcedColors: 'active' });
  await openComposer(page);
  const read = () =>
    page.evaluate(() => {
      const wrapper = document.querySelector<HTMLElement>(
        '.chat-drawer-input .chat-input-wrapper',
      )!;
      const probe = document.createElement('span');
      document.body.append(probe);
      // Name each system color the state may resolve to.
      const system: Array<[string, string]> = [
        'Highlight',
        'LinkText',
        'ButtonText',
        'ButtonFace',
        'GrayText',
      ].map((name) => {
        probe.style.color = name;
        return [getComputedStyle(probe).color, name];
      });
      probe.remove();
      const named = (color: string): string =>
        system.find(([value]) => value === color)?.[1] ?? color;
      const gauge = getComputedStyle(wrapper, '::after');
      const count = wrapper.querySelector<HTMLElement>('.chat-limit-count')!;
      return {
        gauge: named(gauge.backgroundColor),
        gaugeOpacity: gauge.opacity,
        forcedAdjust: gauge.getPropertyValue('forced-color-adjust'),
        line: named(getComputedStyle(wrapper).borderBottomColor),
        outlineWidth: getComputedStyle(document.getElementById('chat-input')!).outlineWidth,
        countVisible: !count.hidden,
        count: named(getComputedStyle(count).color),
        send: named(getComputedStyle(document.getElementById('btn-chat-send')!).color),
      };
    });
  // At rest the line is the idle ButtonFace edge.
  await page.locator('#chat-input').blur();
  await expect.poll(read).toMatchObject({ line: 'ButtonFace', countVisible: false });
  await page.locator('#chat-input').focus();
  await page.keyboard.insertText('a'.repeat(450));
  // The token remap paints the gauge with the system Highlight and the count
  // with LinkText (--warning-foreground); no opt-out.
  await expect.poll(read).toMatchObject({
    gauge: 'Highlight',
    gaugeOpacity: '1',
    forcedAdjust: 'auto',
    countVisible: true,
    count: 'LinkText',
  });
  // Over the limit the red roles remap to ButtonText: the line and the count
  // keep their state, aria-invalid thickens the resting field edge as for a
  // wrong value (focus draws its own 3px ring), and the aria-disabled arrow
  // takes the system disabled color.
  await page.keyboard.insertText('a'.repeat(51));
  await page.locator('#chat-input').blur();
  await expect.poll(read).toMatchObject({
    gaugeOpacity: '0',
    line: 'ButtonText',
    outlineWidth: '2px',
    countVisible: true,
    count: 'ButtonText',
    send: 'GrayText',
  });
  expect(await composer(page)).toMatchObject({ over: true, count: `${MINUS}1`, invalid: 'true' });
});

test('in RTL the count stands over the send arrow and keeps its minus sign first', async ({
  page,
}) => {
  await openComposer(page);
  // An RTL locale sets both; the built CSS resolves logical insets by :lang().
  await page.evaluate(() => {
    document.documentElement.setAttribute('lang', 'ar');
    document.documentElement.setAttribute('dir', 'rtl');
  });
  await page.keyboard.insertText('a'.repeat(450));
  const approaching = await page.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>('.chat-drawer-input .chat-input-wrapper')!;
    return {
      origin: getComputedStyle(wrapper, '::after').transformOrigin,
      width: wrapper.getBoundingClientRect().width,
    };
  });
  // The gauge grows from the reading start, the right edge.
  expect(approaching.origin.startsWith(`${approaching.width}px`)).toBe(true);
  await page.keyboard.insertText('a'.repeat(62));
  const layout = await page.evaluate(() => {
    const count = document.querySelector<HTMLElement>('.chat-limit-count')!;
    const value = count.querySelector<HTMLElement>('.chat-limit-count-value')!;
    const send = document.getElementById('btn-chat-send')!.getBoundingClientRect();
    const box = count.getBoundingClientRect();
    const text = value.firstChild!;
    const glyph = (index: number) => {
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      return range.getBoundingClientRect().left;
    };
    return {
      text: value.textContent,
      direction: getComputedStyle(value).direction,
      countCenter: box.left + box.width / 2,
      sendCenter: send.left + send.width / 2,
      countBottom: box.bottom,
      sendTop: send.top,
      minusLeft: glyph(0),
      lastDigitLeft: glyph((value.textContent ?? '').length - 1),
    };
  });
  expect(layout.text).toBe(`${MINUS}12`);
  expect(layout.direction).toBe('ltr');
  expect(Math.abs(layout.countCenter - layout.sendCenter)).toBeLessThanOrEqual(1);
  expect(layout.countBottom).toBeLessThanOrEqual(layout.sendTop + 1);
  expect(layout.minusLeft).toBeLessThan(layout.lastDigitLeft);
});

test('the count stays readable on the composer in all four palettes', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'one engine is enough for computed palette colors');
  const measure = async (theme: 'dark' | 'light', more: boolean, length: number) => {
    await page.evaluate(
      ([mode, contrastMore]) => {
        const root = document.documentElement;
        root.setAttribute('data-theme', mode as string);
        if (contrastMore) root.setAttribute('data-contrast', 'more');
        else root.removeAttribute('data-contrast');
      },
      [theme, more] as const,
    );
    await clearComposer(page);
    await page.keyboard.insertText('a'.repeat(length));
    return page.evaluate(() => {
      const channels = (value: string): number[] => (value.match(/[\d.]+/gu) ?? []).map(Number);
      const luminance = (value: string): number => {
        const [r, g, b] = channels(value)
          .slice(0, 3)
          .map((channel) => {
            const c = channel / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      // The composer paints --surface-1 on a phone and is transparent over
      // the chat column on a desktop: read the first painted background.
      let surface = 'rgb(0, 0, 0)';
      for (
        let element: Element | null = document.querySelector('.chat-drawer-input');
        element;
        element = element.parentElement
      ) {
        const background = getComputedStyle(element).backgroundColor;
        const alpha = channels(background)[3];
        if (alpha === undefined || alpha > 0) {
          surface = background;
          break;
        }
      }
      const count = getComputedStyle(document.querySelector('.chat-limit-count')!).color;
      const [light, dark] = [luminance(count), luminance(surface)].sort((a, b) => b - a);
      return Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100;
    });
  };
  const palettes = [
    ['dark', 'dark', false],
    ['light', 'light', false],
    ['more contrast dark', 'dark', true],
    ['more contrast light', 'light', true],
  ] as const;
  const measureAll = async (): Promise<Record<string, { left: number; over: number }>> => {
    const measured: Record<string, { left: number; over: number }> = {};
    for (const [name, theme, more] of palettes) {
      measured[name] = {
        left: await measure(theme, more, 450),
        over: await measure(theme, more, MAX_MSG_LENGTH + 12),
      };
    }
    return measured;
  };
  // Palette switches are instant here so no colour is read mid-transition.
  const still = '*, *::before, *::after { transition: none !important; }';

  // Phone: the composer's own --surface-1, the values the unit contract computes.
  await page.setViewportSize({ width: 390, height: 844 });
  await openComposer(page);
  await page.addStyleTag({ content: still });
  expect(await measureAll()).toEqual({
    dark: { left: 8.1, over: 4.91 },
    // The ordinary light palette keeps the brand red for every red text.
    light: { left: 8.82, over: 3.55 },
    'more contrast dark': { left: 9.22, over: 5.58 },
    'more contrast light': { left: 8.82, over: 8.09 },
  });

  // Desktop: the chat column's own background behind the transparent composer.
  await page.setViewportSize({ width: 1280, height: 900 });
  await openComposer(page);
  await page.addStyleTag({ content: still });
  const desktop = await measureAll();
  for (const [name, { left, over }] of Object.entries(desktop)) {
    expect(left, `${name} count`).toBeGreaterThanOrEqual(4.5);
    expect(over, `${name} count below zero`).toBeGreaterThanOrEqual(
      name.startsWith('more contrast') ? 4.5 : 3,
    );
  }
  test.info().annotations.push({ type: 'desktop contrast', description: JSON.stringify(desktop) });
});
