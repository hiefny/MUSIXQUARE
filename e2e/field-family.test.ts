import { expect, test, type Locator, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { useAnonymousAccountSession } from './helpers/context-factory.ts';
import { installFakeYt } from './helpers/fake-yt.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHost, setupHostAndStart } from './helpers/setup-flow.ts';
import { navigateToTab, openChatDrawer, readState, waitForAppFonts } from './helpers/wait.ts';

// Owner decision (2026-11-03, the input system): one quiet underline field
// family in three size steps, one line under every field. These rows measure
// the built app in Korean, dark theme, on a phone: the start-screen code
// (display L), the PIN halves and the manual sync value (display M), the
// nickname, YouTube and message fields (entry), their labels and the line
// under them. Room codes are synthetic.

const DANGER_DARK = 'rgb(255, 59, 48)'; // --danger-foreground, #ff3b30
const TEXT_SUB_DARK = 'rgb(161, 161, 170)'; // --text-sub, #a1a1aa
const PRIMARY_DARK = 'rgb(59, 130, 246)'; // --primary, #3b82f6

type PageBus = { __MUSIXQUARE_BUS__: { emit(event: string, payload?: unknown): void } };

test.use({ serviceWorkers: 'block', colorScheme: 'dark', viewport: { width: 390, height: 844 } });

interface Measured {
  top: number;
  bottom: number;
  left: number;
  height: number;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  color: string;
  opacity: string;
  textTransform: string;
  textAlign: string;
  paddingLeft: string;
  paddingRight: string;
  minHeight: string;
  outlineStyle: string;
  borderBottomColor: string;
}

async function measure(locator: Locator): Promise<Measured> {
  return locator.evaluate((element): Measured => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      height: rect.height,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      color: style.color,
      opacity: style.opacity,
      textTransform: style.textTransform,
      textAlign: style.textAlign,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      minHeight: style.minHeight,
      outlineStyle: style.outlineStyle,
      borderBottomColor: style.borderBottomColor,
    };
  });
}

async function useKoreanDark(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('musixquare-lang', 'ko');
    localStorage.setItem('musixquare-theme', 'dark');
    localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
    localStorage.setItem('musixquare-app-used-v1', '1');
  });
}

/** A signed-in local account; an incomplete one opens the nickname dialog. */
async function localAccount(page: Page, incomplete: boolean, protectedRoom = false) {
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session')
      return route.fulfill({
        json: {
          configured: true,
          authenticated: true,
          account: { nickname: incomplete ? '' : 'Local', profileComplete: !incomplete },
          statsScope: 'a'.repeat(43),
        },
      });
    if (url.pathname.endsWith('/v1/rooms/000001/bootstrap'))
      return route.fulfill({
        json: { roomCode: '000001', status: 'pin_required', passwordRequired: true },
      });
    if (protectedRoom && url.pathname.endsWith('/v1/rooms/000001/presence/enter'))
      return route.fulfill({ status: 401, json: { error: 'SESSION_REQUIRED' } });
    if (protectedRoom && url.pathname.endsWith('/v1/rooms/000001/sessions'))
      return route.fulfill({ status: 401, json: { error: 'PIN_REQUIRED' } });
    if (url.pathname.startsWith('/api/'))
      return route.fulfill({ status: 503, json: { error: 'LOCAL_FIXTURE_UNAVAILABLE' } });
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
    return route.continue();
  });
  await useKoreanDark(page);
}

async function waitForDialogSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document
        .getElementById('dialog-overlay')!
        .getAnimations({ subtree: true })
        .every((animation) => ['finished', 'idle'].includes(animation.playState)),
    undefined,
    { timeout: 10_000 },
  );
}

/** Height of a line box, with half a pixel for subpixel layout. */
function expectPx(actual: number, expected: number, what: string): void {
  expect(Math.abs(actual - expected), `${what}: ${actual}px, expected ${expected}px`).toBeLessThan(
    0.6,
  );
}

for (const width of [390, 320]) {
  test(`start-screen code fields keep a 56px box and a 12px line at ${width}px wide`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    await injectPeerServer(page);
    await useAnonymousAccountSession(page);
    await useKoreanDark(page);

    // The host's read-only code keeps its 32px digits at every width.
    await setupHost(page);
    await waitForAppFonts(page);
    const host = await measure(page.locator('#setup-code'));
    expect(host.fontSize).toBe('32px');
    expectPx(host.height, 56, 'host code box');
    const hostLabel = await measure(page.locator('#setup-host-code-label'));
    expect(hostLabel.textTransform).toBe('none');
    expect(hostLabel.opacity).toBe('1');

    // The join code: 32px digits, 24px at 359px wide or less, box 56px.
    await page.goto('/');
    await waitForBootstrapReady(page);
    await page.locator('#btn-setup-guest').click();
    await expect(page.locator('#setup-join-area')).toBeVisible();
    await waitForAppFonts(page);
    const label = await measure(page.locator('#setup-join-area .setup-code-label'));
    expect(label.fontSize).toBe('13px');
    expect(label.fontWeight).toBe('600');
    expect(label.textTransform).toBe('none');
    expect(label.opacity).toBe('1');
    expect(label.color).toBe(TEXT_SUB_DARK);
    const input = page.locator('#setup-join-code');
    const box = await measure(input);
    expect(box.fontSize).toBe(width === 320 ? '24px' : '32px');
    expectPx(box.height, 56, 'join code box');
    expectPx(box.top - label.bottom, 8, 'label to field');

    // The six-digit check: a 12px / 600 red line on an 18px line, 8px under
    // the underline, centred.
    await input.fill('000');
    await input.press('Enter');
    const error = page.locator('#setup-guest-error');
    await expect(error).toBeVisible();
    const line = await measure(error);
    expect(line.fontSize).toBe('12px');
    expect(line.fontWeight).toBe('600');
    expect(line.lineHeight).toBe('18px');
    expect(line.color).toBe(DANGER_DARK);
    expect(line.textAlign).toBe('center');
    expectPx(line.top - (await measure(input)).bottom, 8, 'field to line');
  });
}

// Only a wrong value turns the field red (aria-invalid and the red underline);
// a connection or server failure paints only the line, the code stays calm.
test('a wrong code turns the code underline red and a connection failure only the line', async ({
  page,
}) => {
  await injectPeerServer(page);
  await useAnonymousAccountSession(page);
  await useKoreanDark(page);
  await page.goto('/');
  await waitForBootstrapReady(page);
  await page.locator('#btn-setup-guest').click();
  await expect(page.locator('#setup-join-area')).toBeVisible();
  const input = page.locator('#setup-join-code');
  const error = page.locator('#setup-guest-error');

  // The six-digit check: the typed value is wrong, red even while focused.
  await input.fill('000');
  await input.press('Enter');
  await expect(error).toHaveText('6자리 숫자를 입력해 주세요');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveCSS('border-bottom-color', DANGER_DARK);
  await expect(error).toHaveCSS('color', DANGER_DARK);

  // The first keystroke clears it; the focus blue returns.
  await input.press('0');
  await expect(error).toBeHidden();
  await expect(input).not.toHaveAttribute('aria-invalid');
  await expect(input).toHaveCSS('border-bottom-color', PRIMARY_DARK);

  // A connection failure: the red 600 line, the code box calm.
  await page.evaluate(() => {
    (window as unknown as PageBus).__MUSIXQUARE_BUS__.emit('setup:guest-join-failure', {
      error: null,
      userMessage: 'PRO 방에 연결하지 못했어요',
    });
  });
  await expect(error).toHaveText('PRO 방에 연결하지 못했어요');
  await expect(error).toHaveCSS('color', DANGER_DARK);
  await expect(error).toHaveCSS('font-weight', '600');
  await expect(input).toBeFocused();
  await expect(input).not.toHaveAttribute('aria-invalid');
  await expect(input).toHaveCSS('border-bottom-color', PRIMARY_DARK);

  // A code that no room answers is a wrong value again.
  await page.evaluate(() => {
    (window as unknown as PageBus).__MUSIXQUARE_BUS__.emit(
      'network:error',
      Object.assign(new Error('PEER_UNAVAILABLE'), { type: 'peer-unavailable' }),
    );
  });
  await expect(error).toContainText('코드를 다시 확인해 주세요');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveCSS('border-bottom-color', DANGER_DARK);
});

test('a taken nickname comes back as the red line under the field', async ({ page }) => {
  await localAccount(page, true);
  await page.route('**/api/auth/profile', (route) =>
    route.fulfill({ status: 409, json: { error: 'NICKNAME_TAKEN' } }),
  );
  await page.goto('/');
  const input = page.locator('#dialog-overlay .dialog-input');
  const hint = page.locator('#dialog-input-hint');
  await expect(input).toBeVisible();
  await waitForDialogSettled(page);
  await input.click();
  await page.keyboard.type('Studio3');
  await page.locator('#btn-dialog-ok').click();

  // The dialog opens again with the name, the refusal under it in red 600,
  // the underline red and the field invalid; nothing shakes.
  await expect(hint).toHaveText('이미 사용 중인 닉네임이에요');
  await expect(hint).toHaveClass(/\berror\b/);
  await expect(input).toHaveText('Studio3');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).not.toHaveClass(/\bshake\b/);
  await waitForDialogSettled(page);
  await expect(hint).toHaveCSS('color', DANGER_DARK);
  await expect(hint).toHaveCSS('font-weight', '600');
  await expect(input).toHaveCSS('border-bottom-color', DANGER_DARK);

  // The first keystroke brings the rule back as the grey hint. Lines under a
  // field end without a full stop.
  await input.press('End');
  await page.keyboard.type('4');
  await expect(hint).not.toHaveClass(/\berror\b/);
  await expect(hint).toHaveText('12자 이내로 입력해 주세요');
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await expect(hint).toHaveCSS('color', TEXT_SUB_DARK);
});

test('the nickname dialog uses the entry step with a 4px-inset 12px hint', async ({ page }) => {
  await localAccount(page, true);
  await page.goto('/');
  const input = page.locator('#dialog-overlay .dialog-input');
  await expect(input).toBeVisible();
  await waitForAppFonts(page);
  await waitForDialogSettled(page);
  const field = await measure(input);
  expect(field.fontSize).toBe('16px');
  expect(field.fontWeight).toBe('400');
  expect(field.lineHeight).toBe('20px');
  expectPx(field.height, 46, 'nickname box');
  const hint = await measure(page.locator('#dialog-input-hint'));
  expect(hint.fontSize).toBe('12px');
  expect(hint.fontWeight).toBe('400');
  expect(hint.lineHeight).toBe('18px');
  expect(hint.color).toBe(TEXT_SUB_DARK);
  expect(hint.paddingLeft).toBe('4px');
  expect(hint.textAlign).toBe('start');
  expect(hint.minHeight).toBe('18px');
  expectPx(hint.left, field.left, 'hint and field start');
  expectPx(hint.top - field.bottom, 8, 'field to hint');
});

test('the PIN halves use display M, draw no focus ring and keep the dialog still on an error', async ({
  page,
}) => {
  await localAccount(page, false, true);
  await page.goto('/000001');
  await page.locator('#btn-setup-confirm:not([disabled])').click();
  const segments = page.locator('#dialog-overlay .dialog-input-segment');
  await expect(segments).toHaveCount(2);
  await waitForAppFonts(page);
  await waitForDialogSettled(page);
  const segment = await measure(segments.first());
  expect(segment.fontSize).toBe('24px');
  expect(segment.lineHeight).toBe('32px');
  expectPx(segment.height, 50, 'PIN box');

  // Keyboard focus: the blue underline is the only mark.
  await segments.first().focus();
  await page.keyboard.press('Tab');
  await expect(segments.last()).toBeFocused();
  expect(await segments.last().evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  const focused = await measure(segments.last());
  expect(focused.outlineStyle).toBe('none');

  // The 8-digit error takes the line the dialog already keeps.
  const dialog = page.locator('#dialog-overlay .dialog');
  const before = (await measure(dialog)).height;
  await segments.last().press('Enter');
  await expect(page.locator('#dialog-input-hint')).toHaveClass(/\berror\b/);
  await waitForDialogSettled(page);
  expectPx((await measure(dialog)).height, before, 'PIN dialog height with the error');
  const line = await measure(page.locator('#dialog-input-hint'));
  expect(line.fontSize).toBe('12px');
  expect(line.fontWeight).toBe('600');
  expect(line.lineHeight).toBe('18px');
  expect(line.color).toBe(DANGER_DARK);
  expect(line.textAlign).toBe('center');
  expect(line.paddingLeft).toBe('0px');
  expectPx(line.top - segment.bottom, 8, 'PIN to line');
});

test('the YouTube and message rows use the entry step and the shared line', async ({ page }) => {
  await injectPeerServer(page);
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    return route.abort();
  });
  await useAnonymousAccountSession(page);
  await installFakeYt(page);
  await useKoreanDark(page);
  await setupHostAndStart(page);
  await waitForAppFonts(page);

  await page.locator('#btn-media-source').click();
  await page.locator('#btn-youtube-source').click();
  await expect(page.locator('#youtube-url-overlay')).toBeVisible();
  const field = await measure(page.locator('#youtube-url-input'));
  expect(field.fontSize).toBe('16px');
  expect(field.lineHeight).toBe('20px');
  const row = await measure(page.locator('#youtube-url-overlay .yt-search-input-wrapper'));
  expectPx(row.height, 46, 'YouTube row');
  const status = await measure(page.locator('#youtube-preview-status'));
  expect(status.fontSize).toBe('12px');
  expect(status.fontWeight).toBe('400');
  expect(status.lineHeight).toBe('18px');
  expect(status.color).toBe(TEXT_SUB_DARK);
  expect(status.paddingLeft).toBe('4px');
  expectPx(status.top - row.bottom, 8, 'YouTube row to line');
  await page.locator('#btn-yt-cancel').click();
  await expect(page.locator('#youtube-url-overlay')).toBeHidden();

  await navigateToTab(page, 'play').catch(() => {});
  await openChatDrawer(page);
  const composer = page.locator('.chat-drawer-input .chat-input-wrapper');
  await expect(composer).toBeVisible();
  const chat = await measure(page.locator('#chat-input'));
  expect(chat.fontSize).toBe('16px');
  expect(chat.lineHeight).toBe('20px');
  expectPx((await measure(composer)).height, 48, 'message row');
});

test('manual sync labels its value at 13px and turns the underline red for a wrong value', async ({
  page,
}) => {
  await injectPeerServer(page);
  await useAnonymousAccountSession(page);
  await useKoreanDark(page);
  await page.route('https://demo.musixquare.com/linelight/*.m4a', (route) =>
    route.fulfill({
      path: fileURLToPath(new URL('./fixtures/demo-track.mp3', import.meta.url)),
      contentType: 'audio/mpeg',
    }),
  );
  await setupHostAndStart(page);
  await page.evaluate(() => {
    (
      window as unknown as { __MUSIXQUARE_BUS__: { emit(event: string): void } }
    ).__MUSIXQUARE_BUS__.emit('demo:enter');
  });
  await expect.poll(() => readState(page, 'demo.loading')).toBe(false);
  await expect(page.locator('#btn-demo-settings')).toBeVisible();
  await page.locator('#btn-demo-settings').click();
  await expect(page.locator('#btn-demo-sync')).toBeVisible();
  await page.locator('#btn-demo-sync').click();
  const overlay = page.locator('#manual-sync-overlay');
  await expect(overlay).toHaveClass(/\bshow\b/);
  await expect(overlay.locator('.sync-glass-panel')).toHaveCSS('opacity', '1');
  await waitForAppFonts(page);

  const label = await measure(overlay.locator('.sync-col-label'));
  expect(label.fontSize).toBe('13px');
  expect(label.fontWeight).toBe('600');
  expect(label.color).toBe(TEXT_SUB_DARK);
  const wrapper = overlay.locator('.sync-manual-input-wrapper');
  const row = await measure(wrapper);
  expectPx(row.height, 50, 'manual sync row');
  expectPx(row.top - label.bottom, 8, 'label to field');
  const value = await measure(page.locator('#manual-sync-value'));
  expect(value.fontSize).toBe('24px');
  expect(value.lineHeight).toBe('32px');

  const editor = page.locator('#manual-sync-value');
  await editor.fill('-');
  await editor.press('Enter');
  await expect(editor).toHaveAttribute('aria-invalid', 'true');
  await expect(wrapper).toHaveCSS('border-bottom-color', DANGER_DARK);
  await editor.press('Backspace');
  await expect(editor).toHaveAttribute('aria-invalid', 'false');
  await expect(wrapper).not.toHaveCSS('border-bottom-color', DANGER_DARK);
});
