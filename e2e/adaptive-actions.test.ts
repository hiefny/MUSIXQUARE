import { expect, test, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_DICTIONARIES as LOCALES } from '../src/i18n/catalogs.ts';
import { LANGUAGE_OPTIONS, languageDirection } from '../src/i18n/locales.ts';
import { isDesktopLayoutSize } from '../src/core/layout-breakpoints.ts';

const APP_STYLES = readFileSync(resolve('css/style.css'), 'utf8');
const DESKTOP_STYLES = readFileSync(resolve('css/desktop.css'), 'utf8');
const ROOM_STYLES = readFileSync(resolve('css/playback-actions.css'), 'utf8');
const RTL_STYLES = readFileSync(resolve('css/rtl.css'), 'utf8');
const APP_MARKUP = readFileSync(resolve('index.html'), 'utf8');
const FONT_ORIGIN = 'https://layout-fonts.test';
const FONT_STYLESHEETS = [
  'css/pretendard.css',
  ...readdirSync(resolve('css/fonts'))
    .filter((file) => file.endsWith('.css'))
    .map((file) => `css/fonts/${file}`),
];

const AUDITED_ACTION_KEYS = [
  'common.ok',
  'common.cancel',
  'common.close',
  'common.retry',
  'common.later',
  'common.refresh',
  'common.reset',
  'common.leave',
  'common.stay',
  'common.next',
  'common.start',
  'common.done',
  'common.revoke',
  'connect.signaling_recover_action',
  'connect.signaling_retry',
  'connect.signaling_rejoin',
  'connect.kick_yes',
  'dialog.got_it',
  'dialog.continue',
  'dialog.continue_using',
  'dialog.reconnect',
  'dialog.go_back',
  'dialog.session_lost_btn',
  'dialog.leave_session',
  'pro.use_this_tab',
  'pro.claim_login_button',
  'pro.claim_choose_account_button',
  'account.google_continue',
  'account.change_nickname',
  'account.logout',
  'account.delete_account',
] as const;

const SWEPT_SLOT_KEYS = {
  logout: 'account.logout',
  deleteAccount: 'account.delete_account',
  close: 'common.close',
  copy: 'connect.copy_invite_link',
  recover: 'connect.signaling_recover_action',
  recovering: 'connect.signaling_recovering',
  expired: 'connect.signaling_expired',
  nickname: 'account.change_nickname',
  leave: 'settings.leave_session',
  tour: 'setup.demo_button',
  screensaver: 'screensaver.turn_on',
  local: 'help.load_local',
  youtube: 'help.youtube_compat',
  system: 'system_audio.button',
  selectAll: 'playlist.select_all',
  deselectAll: 'playlist.deselect_all',
  selectedCount: 'playlist.selected_count',
  host: 'setup.host_button',
  guest: 'setup.guest_button',
  start: 'common.start',
  wait: 'common.wait',
  joining: 'setup.joining',
  retry: 'common.retry',
  refresh: 'common.refresh',
  cancel: 'common.cancel',
  add: 'player.play_start',
} as const;

const LOCALIZED_ACTIONS = Object.entries(LOCALES).map(([code, dictionary]) => ({
  code,
  htmlLang: LANGUAGE_OPTIONS.find((locale) => locale.code === code)!.htmlLang,
  dir: languageDirection(code as Parameters<typeof languageDirection>[0]),
  labels: AUDITED_ACTION_KEYS.map((key) => (dictionary as Record<string, string>)[key]),
  account: {
    google: (dictionary as Record<string, string>)['account.google_continue'],
    logout: (dictionary as Record<string, string>)['account.logout'],
    deleteAccount: (dictionary as Record<string, string>)['account.delete_account'],
    close: (dictionary as Record<string, string>)['common.close'],
  },
  invite: {
    copy: (dictionary as Record<string, string>)['connect.copy_invite_link'],
    recover: (dictionary as Record<string, string>)['connect.signaling_recover_action'],
    recovering: (dictionary as Record<string, string>)['connect.signaling_recovering'],
    expired: (dictionary as Record<string, string>)['connect.signaling_expired'],
  },
  player: {
    sync: (dictionary as Record<string, string>)['player.sync_compact'],
    syncing: (dictionary as Record<string, string>)['player.syncing_compact'],
    media: (dictionary as Record<string, string>)['player.play_media_compact'],
    stop: (dictionary as Record<string, string>)['system_audio.stop'],
  },
  demo: {
    info: (dictionary as Record<string, string>)['demo.track_info'],
    exit: (dictionary as Record<string, string>)['demo.exit'],
  },
  // The labels of the label sweep's narrow slots (swept slot probe below).
  swept: Object.fromEntries(
    Object.entries(SWEPT_SLOT_KEYS).map(([name, key]) => [
      name,
      (dictionary as Record<string, string>)[key]!,
    ]),
  ) as Record<keyof typeof SWEPT_SLOT_KEYS, string>,
  nav: [
    (dictionary as Record<string, string>)['nav.home'],
    (dictionary as Record<string, string>)['nav.playlist_compact'],
    (dictionary as Record<string, string>)['nav.connect_compact'],
    (dictionary as Record<string, string>)['nav.settings_compact'],
    (dictionary as Record<string, string>)['nav.help'],
  ],
}));

// The manual sync panel's Reset / Done pair in every locale.
const SYNC_PAIR_LABELS: Record<string, { reset: string; done: string }> = Object.fromEntries(
  Object.entries(LOCALES).map(([code, dictionary]) => [
    code,
    {
      reset: (dictionary as Record<string, string>)['common.reset']!,
      done: (dictionary as Record<string, string>)['common.done']!,
    },
  ]),
);

type ActionMetrics = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
};

async function installLayoutProbe(
  page: Page,
  markup: string,
  options: { viewportWidth?: number; viewportHeight?: number; direction?: 'ltr' | 'rtl' } = {},
): Promise<void> {
  const viewportWidth = options.viewportWidth ?? 320;
  await page.setViewportSize({ width: viewportWidth, height: options.viewportHeight ?? 800 });
  // Serve the same font CSS and bytes as the app without a preview server.
  // Unicode ranges keep the browser from downloading unused Noto shards.
  await page.route(`${FONT_ORIGIN}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const file =
      pathname === '/designsystem/fonts/PretendardVariable.woff2'
        ? 'public/designsystem/fonts/PretendardVariable.woff2'
        : pathname.slice(1);
    await route.fulfill({
      path: resolve(file),
      contentType: file.endsWith('.css') ? 'text/css' : 'font/woff2',
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  await page.setContent(`
    <!doctype html>
    ${FONT_STYLESHEETS.map((file) => `<link rel="stylesheet" href="${FONT_ORIGIN}/${file}">`).join('\n')}
    <style>
      ${APP_STYLES}
      ${DESKTOP_STYLES}
      ${RTL_STYLES}
      ${ROOM_STYLES}
      html,
      body {
        width: ${viewportWidth}px;
        margin: 0;
      }

      /* The app normally reveals the body after bootstrap; this isolated
         fixture has no runtime and must remain visible in failure screenshots. */
      body {
        opacity: 1;
      }

      .layout-probe {
        width: 100%;
      }

      /* Mobile connection sections reserve 44px on each side. Exercise the
         invite button at its real 320px-viewport width instead of giving the
         probe the full page width. */
      .locale-invite-action {
        width: calc(100% - 88px);
      }

      .locale-bottom-nav {
        position: relative;
        inset: auto;
        width: 320px;
        transform: none;
      }

      .locale-player-actions {
        width: calc(100% - 48px);
        margin: 0 24px;
      }

      .text-200.locale-player-actions .play-action-label,
      .text-200.locale-merged-player-actions .play-action-label {
        font-size: 30px;
      }

      /* The application reserves 24px on each mobile side and two 160px
         action slots plus a 10px gap on desktop. Keep the authored button
         subtree and its cascade; only supply its surrounding panel's width. */
      .locale-merged-player-actions {
        width: ${viewportWidth < 1280 ? viewportWidth - 48 : 330}px;
        max-width: none;
        margin: 0;
      }

      .text-200 button,
      .text-200 a {
        font-size: 30px;
        line-height: 1.25;
      }
    </style>
    ${markup}
  `);
  await page.evaluate((direction) => {
    document.documentElement.dir = direction;
  }, options.direction ?? 'ltr');
  await waitForLayoutFonts(page);
}

async function waitForLayoutFonts(page: Page): Promise<void> {
  const fontState = await page.evaluate(async () => {
    const primaryFaces = await document.fonts.load('700 15px "Pretendard"', 'MUSIXQUARE');
    // Flush styles after inserting locale probes before awaiting new glyph requests.
    document.body.getBoundingClientRect();
    await document.fonts.ready;
    return {
      primaryLoaded:
        primaryFaces.length > 0 && primaryFaces.every((font) => font.status === 'loaded'),
      errors: [...document.fonts]
        .filter((font) => font.status === 'error')
        .map((font) => font.family),
    };
  });
  expect(fontState).toEqual({ primaryLoaded: true, errors: [] });
}

async function localizedActionsWithFonts(page: Page) {
  return page.evaluate((locales) => {
    const originalLang = document.documentElement.lang;
    // Resolve the real html:lang font tokens instead of maintaining a second
    // locale/font map for the many sections sharing this fixture document.
    const resolved = locales.map((locale) => {
      document.documentElement.lang = locale.htmlLang;
      return { ...locale, fontFamily: getComputedStyle(document.body).fontFamily };
    });
    document.documentElement.lang = originalLang;
    return resolved;
  }, LOCALIZED_ACTIONS);
}

async function actionMetrics(page: Page, selector: string): Promise<ActionMetrics[]> {
  return page.locator(`${selector} > :is(button, a):not([hidden])`).evaluateAll((actions) =>
    actions.map((action) => {
      const rect = action.getBoundingClientRect();
      return {
        id: action.id,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        clientWidth: action.clientWidth,
        clientHeight: action.clientHeight,
        scrollWidth: action.scrollWidth,
        scrollHeight: action.scrollHeight,
      };
    }),
  );
}

async function availableContentWidth(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((group) => {
    const style = getComputedStyle(group);
    return (
      group.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight)
    );
  });
}

function expectNoActionOverflow(actions: ActionMetrics[]): void {
  for (const action of actions) {
    expect(action.scrollWidth, `${action.id} must not overflow horizontally`).toBeLessThanOrEqual(
      action.clientWidth,
    );
    expect(action.scrollHeight, `${action.id} must not clip wrapped text`).toBeLessThanOrEqual(
      action.clientHeight,
    );
  }
}

test.describe('content-based adaptive action groups', () => {
  test('keeps short actions horizontal at 320px and preserves DOM focus order', async ({
    page,
  }) => {
    await installLayoutProbe(
      page,
      `<div
        id="short-actions"
        class="dialog-actions adaptive-action-group layout-probe text-200"
      >
        <button id="short-secondary" class="dialog-secondary">No</button>
        <button id="short-primary" class="dialog-primary">OK</button>
      </div>`,
    );

    const [secondary, primary] = await actionMetrics(page, '#short-actions');
    expect(secondary?.y).toBe(primary?.y);
    expectNoActionOverflow([secondary!, primary!]);

    await page.locator('#short-secondary').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#short-primary')).toBeFocused();
  });

  test('stacks long actions at full width and wraps only at natural word boundaries', async ({
    page,
  }) => {
    await installLayoutProbe(
      page,
      `<div
        id="long-actions"
        class="dialog-actions adaptive-action-group layout-probe text-200"
      >
        <button id="long-secondary" class="dialog-secondary">
          Continue with this administrator account
        </button>
        <button id="long-primary" class="dialog-primary">
          Remove administrator permissions
        </button>
      </div>
      <div
        id="fallback-actions"
        class="dialog-actions adaptive-action-group layout-probe text-200"
        lang="de"
      >
        <button id="fallback-primary" class="dialog-primary">
          Berechtigung jetzt verwalten
        </button>
      </div>`,
    );

    const [secondary, primary] = await actionMetrics(page, '#long-actions');
    expect(primary!.y).toBeGreaterThanOrEqual(secondary!.y + secondary!.height);
    expect(primary!.x).toBe(secondary!.x);
    expect(primary!.width).toBe(secondary!.width);
    expect(primary!.width).toBe(await availableContentWidth(page, '#long-actions'));

    const fallback = await actionMetrics(page, '#fallback-actions');
    // Wrapped text grows the pill past its 56px single-line height.
    expect(fallback[0]!.height).toBeGreaterThan(56);
    expectNoActionOverflow([secondary!, primary!, ...fallback]);
    const wrapRules = await page.locator('#fallback-primary').evaluate((action) => {
      const style = getComputedStyle(action);
      return { overflowWrap: style.overflowWrap, wordBreak: style.wordBreak };
    });
    expect(wrapRules).toEqual({ overflowWrap: 'normal', wordBreak: 'keep-all' });
  });

  test('keeps the account close action on its own full-width row', async ({ page }) => {
    await installLayoutProbe(
      page,
      `<div
        id="account-actions"
        class="account-dialog-actions adaptive-action-group text-200"
      >
        <button id="account-logout" class="dialog-secondary">Log out</button>
        <button id="account-delete" class="dialog-secondary dialog-danger">Delete account</button>
        <button
          id="account-close"
          class="dialog-primary account-dialog-account-close adaptive-action-group-full"
        >Close</button>
      </div>`,
    );

    const [logout, deleteAccount, close] = await actionMetrics(page, '#account-actions');
    const accountActionsBottom = Math.max(
      logout!.y + logout!.height,
      deleteAccount!.y + deleteAccount!.height,
    );
    const sameAccountRow = Math.abs(logout!.y - deleteAccount!.y) < 0.5;
    if (sameAccountRow) {
      expect(logout!.x + logout!.width).toBeLessThanOrEqual(deleteAccount!.x);
    } else {
      expect(logout!.y + logout!.height).toBeLessThanOrEqual(deleteAccount!.y);
    }
    expect(close!.y).toBeGreaterThanOrEqual(accountActionsBottom);

    const availableWidth = await availableContentWidth(page, '#account-actions');
    expect(close!.width).toBe(availableWidth);
    expectNoActionOverflow([logout!, deleteAccount!, close!]);
  });

  test('spaces and sizes dialog pills like the play-tab actions', async ({ page }) => {
    // Owner decisions (2026-10-27, revised 2026-10-28): 10px between painted
    // pill surfaces side by side, 12px when stacked, and 56px pills, the same
    // as the play tab's sync and media actions.
    await installLayoutProbe(
      page,
      `<div id="account-actions" class="account-dialog-actions adaptive-action-group">
        <button id="account-logout" class="dialog-secondary">Log out</button>
        <button id="account-delete" class="dialog-secondary dialog-danger">Delete account</button>
        <button
          id="account-close"
          class="dialog-primary account-dialog-account-close adaptive-action-group-full"
        >Close</button>
      </div>
      <div id="login-actions" class="account-dialog-login-actions">
        <a id="login-google" class="account-google-button" href="#">
          <span class="account-google-mark"></span>
          <span class="account-google-label">Continue with Google</span>
          <span class="account-google-balance"></span>
        </a>
        <button id="login-close" class="dialog-secondary account-dialog-login-close">Close</button>
      </div>`,
      { viewportWidth: 390 },
    );

    const [logout, deleteAccount, close] = await actionMetrics(page, '#account-actions');
    expect(Math.abs(logout!.y - deleteAccount!.y)).toBeLessThan(0.5);
    expect(deleteAccount!.x - (logout!.x + logout!.width)).toBeCloseTo(10, 1);
    expect(close!.y - (logout!.y + logout!.height)).toBeCloseTo(12, 1);
    for (const action of [logout!, deleteAccount!, close!]) {
      expect(action.height, action.id).toBeCloseTo(56, 1);
    }

    const [google, loginClose] = await actionMetrics(page, '#login-actions');
    expect(loginClose!.y - (google!.y + google!.height)).toBeCloseTo(12, 1);
    expect(google!.height).toBeCloseTo(56, 1);
    expect(loginClose!.height).toBeCloseTo(56, 1);
  });

  test('compresses both account views alike on very short screens', async ({ page }) => {
    await installLayoutProbe(
      page,
      `<div id="account-actions" class="account-dialog-actions adaptive-action-group">
        <button id="account-logout" class="dialog-secondary">Log out</button>
        <button id="account-delete" class="dialog-secondary dialog-danger">Delete account</button>
        <button
          id="account-close"
          class="dialog-primary account-dialog-account-close adaptive-action-group-full"
        >Close</button>
      </div>
      <div id="login-actions" class="account-dialog-login-actions">
        <a id="login-google" class="account-google-button" href="#">
          <span class="account-google-mark"></span>
          <span class="account-google-label">Continue with Google</span>
          <span class="account-google-balance"></span>
        </a>
        <button id="login-close" class="dialog-secondary account-dialog-login-close">Close</button>
      </div>`,
      { viewportWidth: 568 },
    );
    await page.setViewportSize({ width: 568, height: 320 });
    await page.waitForFunction(() => innerHeight === 320);

    const [logout, deleteAccount, close] = await actionMetrics(page, '#account-actions');
    const signedInGap =
      close!.y - Math.max(logout!.y + logout!.height, deleteAccount!.y + deleteAccount!.height);
    const [google, loginClose] = await actionMetrics(page, '#login-actions');
    const signedOutGap = loginClose!.y - (google!.y + google!.height);
    expect(signedInGap).toBeLessThan(12);
    expect(signedOutGap).toBeCloseTo(signedInGap, 1);
    const heights = [logout!, deleteAccount!, close!, google!, loginClose!].map(
      (action) => action.height,
    );
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBeLessThan(56);
  });

  for (const direction of ['ltr', 'rtl'] as const) {
    test(`pairs Close and Retry while sign-in is unavailable (${direction})`, async ({ page }) => {
      // Owner report (2026-10-28): the unavailable view needs a visible exit.
      // account.ts gives the signed-out row the adaptive action group there:
      // Close comes first (left, mirrored in RTL), Retry beside it, the same
      // 10px across and 56px pills as every dialog pair.
      await installLayoutProbe(
        page,
        `<div id="login-actions" class="account-dialog-login-actions adaptive-action-group">
          <a class="account-google-button" href="#" hidden></a>
          <button id="login-close" class="dialog-secondary account-dialog-login-close">Close</button>
          <button id="login-retry" class="dialog-primary account-dialog-login-retry">Retry</button>
        </div>`,
        { viewportWidth: 390, direction },
      );

      const [close, retry] = await actionMetrics(page, '#login-actions');
      expect(close!.id).toBe('login-close');
      expect(Math.abs(close!.y - retry!.y)).toBeLessThan(0.5);
      const gap =
        direction === 'ltr'
          ? retry!.x - (close!.x + close!.width)
          : close!.x - (retry!.x + retry!.width);
      expect(gap).toBeCloseTo(10, 1);
      expect(close!.height).toBeCloseTo(56, 1);
      expect(retry!.height).toBeCloseTo(56, 1);

      // Very short screens compress the pair like the signed-in actions.
      await page.setViewportSize({ width: 568, height: 320 });
      await page.waitForFunction(() => innerHeight === 320);
      const [shortClose, shortRetry] = await actionMetrics(page, '#login-actions');
      expect(Math.abs(shortClose!.y - shortRetry!.y)).toBeLessThan(0.5);
      const shortGap =
        direction === 'ltr'
          ? shortRetry!.x - (shortClose!.x + shortClose!.width)
          : shortClose!.x - (shortRetry!.x + shortRetry!.width);
      expect(shortGap).toBeCloseTo(6, 1);
      expect(shortClose!.height).toBeCloseTo(44, 1);
      expect(shortRetry!.height).toBeCloseTo(44, 1);
    });
  }

  test('keeps the YouTube link dialog actions on the shared pill gap', async ({ page }) => {
    // The row also carries a one-off utility class from the inline-style
    // extraction; it must not reopen a different gap than the shared 10px
    // across.
    await installLayoutProbe(
      page,
      `<div id="youtube-url-overlay">
        <div id="youtube-actions" class="ob-actions setup-card-mt-8-row">
          <button id="youtube-cancel" class="btn-ob-secondary flex-1">Cancel</button>
          <button id="youtube-play" class="btn-ob-primary yt-play-btn-flex15">Add to Playlist</button>
        </div>
      </div>`,
      { viewportWidth: 390 },
    );

    const [cancel, play] = await actionMetrics(page, '#youtube-actions');
    expect(Math.abs(cancel!.y - play!.y)).toBeLessThan(0.5);
    expect(play!.x - (cancel!.x + cancel!.width)).toBeCloseTo(10, 1);
    expect(cancel!.height).toBeCloseTo(56, 1);
    expect(play!.height).toBeCloseTo(56, 1);
  });

  test('contains every audited action label across all supported locales at 200% text', async ({
    page,
  }) => {
    await installLayoutProbe(page, '<main id="locale-probes"></main>');
    const localesWithFonts = await localizedActionsWithFonts(page);
    await page.evaluate((locales) => {
      const root = document.getElementById('locale-probes')!;

      for (const locale of locales) {
        const section = document.createElement('section');
        section.className = 'locale-probe';
        section.lang = locale.htmlLang;
        section.style.setProperty('--font-sans', locale.fontFamily);
        section.style.fontFamily = locale.fontFamily;

        for (let index = 0; index < locale.labels.length; index += 2) {
          const group = document.createElement('div');
          group.className =
            'dialog-actions adaptive-action-group layout-probe text-200 locale-action-pair';

          for (const [offset, label] of locale.labels.slice(index, index + 2).entries()) {
            const button = document.createElement('button');
            button.className = offset === 0 ? 'dialog-secondary' : 'dialog-primary';
            button.textContent = label;
            group.appendChild(button);
          }
          section.appendChild(group);
        }

        const accountGroup = document.createElement('div');
        accountGroup.className =
          'account-dialog-actions adaptive-action-group text-200 locale-account-actions';
        for (const [className, label] of [
          ['dialog-secondary', locale.account.logout],
          ['dialog-secondary dialog-danger', locale.account.deleteAccount],
          [
            'dialog-primary account-dialog-account-close adaptive-action-group-full',
            locale.account.close,
          ],
        ]) {
          const button = document.createElement('button');
          button.className = className;
          button.textContent = label;
          accountGroup.appendChild(button);
        }
        section.appendChild(accountGroup);

        const loginGroup = document.createElement('div');
        loginGroup.className = 'account-dialog-login-actions text-200 locale-login-actions';

        const google = document.createElement('a');
        google.className = 'account-google-button';
        google.href = '#';
        const googleMark = document.createElement('span');
        googleMark.className = 'account-google-mark';
        const googleLabel = document.createElement('span');
        googleLabel.className = 'account-google-label';
        googleLabel.textContent = locale.account.google;
        const googleBalance = document.createElement('span');
        googleBalance.className = 'account-google-balance';
        google.append(googleMark, googleLabel, googleBalance);

        const loginClose = document.createElement('button');
        loginClose.className = 'dialog-secondary account-dialog-login-close';
        loginClose.textContent = locale.account.close;
        loginGroup.append(google, loginClose);
        section.appendChild(loginGroup);

        for (const [mode, label] of Object.entries(locale.invite)) {
          const inviteGroup = document.createElement('div');
          inviteGroup.className = 'qr-container layout-probe text-200 locale-invite-action';

          const button = document.createElement('button');
          button.className = 'btn-copy-invite-link';
          button.dataset.mode = mode;

          const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          icon.setAttribute('viewBox', '0 0 24 24');
          const spinner = document.createElement('span');
          spinner.className = 'material-elastic-spinner signaling-recovery-spinner';
          const spinnerIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          spinner.appendChild(spinnerIcon);
          const text = document.createElement('span');
          text.setAttribute('data-i18n', `connect.${mode}`);
          text.textContent = label;
          button.append(icon, spinner, text);
          inviteGroup.appendChild(button);
          section.appendChild(inviteGroup);
        }

        const bottomNav = document.createElement('nav');
        bottomNav.className = 'bottom-nav locale-bottom-nav';
        for (const label of locale.nav) {
          const button = document.createElement('button');
          button.className = 'nav-item';
          const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          icon.setAttribute('viewBox', '0 0 24 24');
          const text = document.createElement('span');
          text.textContent = label;
          button.append(icon, text);
          bottomNav.appendChild(button);
        }
        section.appendChild(bottomNav);

        root.appendChild(section);
      }
    }, localesWithFonts);
    await waitForLayoutFonts(page);

    const allActions = await page.locator('#locale-probes :is(button, a)').evaluateAll((actions) =>
      actions.map((action, index) => {
        const rect = action.getBoundingClientRect();
        return {
          id: `${action.closest<HTMLElement>('.locale-probe')?.lang ?? 'unknown'}-${index}`,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          clientWidth: action.clientWidth,
          clientHeight: action.clientHeight,
          scrollWidth: action.scrollWidth,
          scrollHeight: action.scrollHeight,
        };
      }),
    );
    expectNoActionOverflow(allActions);

    const arbitraryBreakFallbacks = await page
      .locator('#locale-probes :is(button, a)')
      .evaluateAll(
        (actions) =>
          actions.filter((action) => getComputedStyle(action).overflowWrap === 'anywhere').length,
      );
    expect(arbitraryBreakFallbacks).toBe(0);

    const pairLayouts = await page.locator('.locale-action-pair').evaluateAll((groups) =>
      groups.map((group) =>
        Array.from(group.querySelectorAll(':scope > button')).map((button) => {
          const rect = button.getBoundingClientRect();
          return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
        }),
      ),
    );
    for (const pair of pairLayouts) {
      if (pair.length < 2) continue;
      const [first, second] = pair;
      if (Math.abs(first!.y - second!.y) < 0.5) {
        expect(first!.right).toBeLessThanOrEqual(second!.x);
      } else {
        expect(first!.bottom).toBeLessThanOrEqual(second!.y);
      }
    }

    const accountLayouts = await page.locator('.locale-account-actions').evaluateAll((groups) =>
      groups.map((group) => {
        const [logout, deleteAccount, close] = Array.from(
          group.querySelectorAll(':scope > button'),
        ).map((button) => button.getBoundingClientRect());
        const style = getComputedStyle(group);
        return {
          priorBottom: Math.max(logout!.bottom, deleteAccount!.bottom),
          closeTop: close!.top,
          closeWidth: close!.width,
          availableWidth:
            group.clientWidth -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.paddingRight),
        };
      }),
    );
    for (const layout of accountLayouts) {
      expect(layout.closeTop).toBeGreaterThanOrEqual(layout.priorBottom);
      expect(layout.closeWidth).toBe(layout.availableWidth);
    }

    const loginLayouts = await page.locator('.locale-login-actions').evaluateAll((groups) =>
      groups.map((group) => {
        const google = group.querySelector<HTMLElement>(':scope > .account-google-button')!;
        const close = group.querySelector<HTMLElement>(':scope > .account-dialog-login-close')!;
        const label = google.querySelector<HTMLElement>('.account-google-label')!;
        const googleRect = google.getBoundingClientRect();
        const closeRect = close.getBoundingClientRect();
        const style = getComputedStyle(group);
        return {
          googleBottom: googleRect.bottom,
          closeTop: closeRect.top,
          googleWidth: googleRect.width,
          closeWidth: closeRect.width,
          availableWidth:
            group.clientWidth -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.paddingRight),
          labelClientWidth: label.clientWidth,
          labelClientHeight: label.clientHeight,
          labelScrollWidth: label.scrollWidth,
          labelScrollHeight: label.scrollHeight,
        };
      }),
    );
    for (const layout of loginLayouts) {
      expect(layout.closeTop).toBeGreaterThanOrEqual(layout.googleBottom);
      expect(layout.googleWidth).toBe(layout.availableWidth);
      expect(layout.closeWidth).toBe(layout.availableWidth);
      expect(layout.labelScrollWidth).toBeLessThanOrEqual(layout.labelClientWidth);
      expect(layout.labelScrollHeight).toBeLessThanOrEqual(layout.labelClientHeight);
    }

    const inviteActions = await page
      .locator('.locale-invite-action > .btn-copy-invite-link')
      .evaluateAll((actions) =>
        actions.map((action, index) => ({
          id: `${action.closest<HTMLElement>('.locale-probe')?.lang ?? 'unknown'}-invite-${index}`,
          x: action.getBoundingClientRect().x,
          y: action.getBoundingClientRect().y,
          width: action.getBoundingClientRect().width,
          height: action.getBoundingClientRect().height,
          clientWidth: action.clientWidth,
          clientHeight: action.clientHeight,
          scrollWidth: action.scrollWidth,
          scrollHeight: action.scrollHeight,
        })),
      );
    expectNoActionOverflow(inviteActions);

    const navLabels = await page
      .locator('.locale-bottom-nav .nav-item > span')
      .evaluateAll((labels) =>
        labels.map((label, index) => {
          const button = label.closest<HTMLElement>('.nav-item')!;
          const buttonRect = button.getBoundingClientRect();
          const labelRect = label.getBoundingClientRect();
          const textRange = document.createRange();
          textRange.selectNodeContents(label);
          return {
            id: `${label.closest<HTMLElement>('.locale-probe')?.lang ?? 'unknown'}-nav-${index}`,
            buttonLeft: buttonRect.left,
            buttonRight: buttonRect.right,
            labelLeft: labelRect.left,
            labelRight: labelRect.right,
            labelWidth: labelRect.width,
            textWidth: textRange.getBoundingClientRect().width,
            clientHeight: label.clientHeight,
            scrollHeight: label.scrollHeight,
          };
        }),
      );
    for (const label of navLabels) {
      expect(label.labelLeft, `${label.id} must stay inside its tab`).toBeGreaterThanOrEqual(
        label.buttonLeft - 0.5,
      );
      expect(label.labelRight, `${label.id} must stay inside its tab`).toBeLessThanOrEqual(
        label.buttonRight + 0.5,
      );
      // Compare fractional layout widths: integer scroll/client widths cannot
      // justify allowing several pixels of real text clipping across platforms.
      expect(label.textWidth, `${label.id} must fit without ellipsis`).toBeLessThanOrEqual(
        label.labelWidth + 0.5,
      );
      expect(label.scrollHeight, `${label.id} must remain one line`).toBeLessThanOrEqual(
        label.clientHeight,
      );
    }
  });

  for (const viewportWidth of [360, 390, 1440]) {
    test(`contains the manual sync Done / Reset pair in every locale at ${viewportWidth}px`, async ({
      page,
    }) => {
      // The authored panel, opened, in each locale's own font. The recipe
      // keeps the pair on one row while both labels fit and gives each its own
      // full row otherwise, wrapping only at word boundaries.
      await installLayoutProbe(page, '<main id="sync-pair-probes"></main>', { viewportWidth });
      const localesWithFonts = await localizedActionsWithFonts(page);
      await page.evaluate(
        ({ locales, markup, labels }) => {
          const root = document.getElementById('sync-pair-probes')!;
          const authored = new DOMParser().parseFromString(markup, 'text/html');
          const overlay = authored.getElementById('manual-sync-overlay')!;
          for (const locale of locales) {
            const probe = overlay.cloneNode(true) as HTMLElement;
            probe.removeAttribute('id');
            probe.classList.add('show', 'locale-sync-probe');
            probe.lang = locale.htmlLang;
            probe.style.setProperty('--font-sans', locale.fontFamily);
            probe.style.fontFamily = locale.fontFamily;
            probe.style.position = 'relative';
            probe.style.inset = 'auto';
            probe.style.padding = '8px 0';
            const reset = probe.querySelector<HTMLElement>('.sync-reset-btn')!;
            const done = probe.querySelector<HTMLElement>('.sync-done-btn')!;
            reset.textContent = labels[locale.code]!.reset;
            done.textContent = labels[locale.code]!.done;
            for (const button of [reset, done]) {
              button.removeAttribute('id');
              button.dataset.probe = `${locale.code}-${button.className}`;
            }
            root.appendChild(probe);
          }
        },
        { locales: localesWithFonts, markup: APP_MARKUP, labels: SYNC_PAIR_LABELS },
      );
      await waitForLayoutFonts(page);

      const pairs = await page.locator('.locale-sync-probe').evaluateAll((probes) =>
        probes.map((probe) => {
          const panel = probe.querySelector<HTMLElement>('.sync-glass-panel')!;
          const row = probe.querySelector<HTMLElement>('.sync-bottom-row')!;
          const panelRect = panel.getBoundingClientRect();
          const style = getComputedStyle(panel);
          const contentLeft = panelRect.left + Number.parseFloat(style.paddingLeft);
          const contentRight = panelRect.right - Number.parseFloat(style.paddingRight);
          return {
            lang: probe.getAttribute('lang') ?? '',
            rowScrollWidth: row.scrollWidth,
            rowClientWidth: row.clientWidth,
            contentLeft,
            contentRight,
            buttons: [...row.querySelectorAll<HTMLElement>(':scope > button')].map((button) => {
              const rect = button.getBoundingClientRect();
              return {
                id: button.dataset.probe!,
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                height: rect.height,
                clientWidth: button.clientWidth,
                clientHeight: button.clientHeight,
                scrollWidth: button.scrollWidth,
                scrollHeight: button.scrollHeight,
              };
            }),
          };
        }),
      );
      expect(pairs).toHaveLength(42);
      for (const pair of pairs) {
        expect(pair.rowScrollWidth, `${pair.lang} row overflow`).toBeLessThanOrEqual(
          pair.rowClientWidth,
        );
        // Done, the exit, comes first (left, mirrored in RTL); Reset follows.
        const [done, reset] = pair.buttons;
        expect(done!.id, pair.lang).toMatch(/-sync-done-btn$/u);
        expect(reset!.id, pair.lang).toMatch(/-sync-reset-btn$/u);
        for (const button of [done!, reset!]) {
          expect(button.left, `${button.id} inside the panel`).toBeGreaterThanOrEqual(
            pair.contentLeft - 0.5,
          );
          expect(button.right, `${button.id} inside the panel`).toBeLessThanOrEqual(
            pair.contentRight + 0.5,
          );
          expect(button.scrollWidth, `${button.id} clips its label`).toBeLessThanOrEqual(
            button.clientWidth,
          );
          expect(button.scrollHeight, `${button.id} clips wrapped text`).toBeLessThanOrEqual(
            button.clientHeight,
          );
          expect(button.height, `${button.id} pill height`).toBeGreaterThanOrEqual(56 - 0.5);
        }
        // Side by side 10px apart with Done on the left, or Reset on its own
        // row 12px below.
        if (Math.abs(reset!.top - done!.top) < 0.5) {
          expect(reset!.left - done!.right, pair.lang).toBeCloseTo(10, 1);
        } else {
          expect(reset!.top - done!.bottom, pair.lang).toBeCloseTo(12, 1);
        }
      }
    });
  }

  test('gives dialog pills 24px side padding at 360px and below', async ({ page }) => {
    // Owner decision (2026-10-28): the shared 28px drops to 24px at 360px and
    // below; min-width stays, and the account actions keep their 18px. Inside
    // an adaptive action group the group's min-width 0 wins, as before; a pill
    // outside a group keeps the shared 100px.
    await installLayoutProbe(
      page,
      `<div id="dialog-pair" class="dialog-actions adaptive-action-group">
        <button id="pair-secondary" class="dialog-secondary">Cancel</button>
        <button id="pair-primary" class="dialog-primary">OK</button>
      </div>
      <div id="single-action">
        <button id="single-primary" class="dialog-primary">OK</button>
      </div>
      <div id="account-actions" class="account-dialog-actions adaptive-action-group">
        <button id="account-logout" class="dialog-secondary">Log out</button>
        <button id="account-delete" class="dialog-secondary dialog-danger">Delete account</button>
      </div>`,
      { viewportWidth: 320 },
    );
    const padding = () =>
      page.locator('button').evaluateAll((buttons) =>
        Object.fromEntries(
          buttons.map((button) => {
            const style = getComputedStyle(button);
            return [
              button.id,
              [style.paddingLeft, style.paddingRight, style.minWidth].join(' '),
            ] as const;
          }),
        ),
      );
    for (const [width, side] of [
      [320, '24px'],
      [360, '24px'],
      [361, '28px'],
      [390, '28px'],
    ] as const) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForFunction((value) => innerWidth === value, width);
      expect(await padding(), `${width}px`).toEqual({
        'pair-secondary': `${side} ${side} 0px`,
        'pair-primary': `${side} ${side} 0px`,
        'single-primary': `${side} ${side} 100px`,
        'account-logout': '18px 18px 0px',
        'account-delete': '18px 18px 0px',
      });
    }
  });

  test('keeps every compact player action contained at the real 320px width', async ({ page }) => {
    await installLayoutProbe(page, '<main id="player-action-probes"></main>');
    const localesWithFonts = await localizedActionsWithFonts(page);
    await page.evaluate(
      ({ locales, markup }) => {
        const root = document.getElementById('player-action-probes')!;
        const authored = new DOMParser().parseFromString(markup, 'text/html');
        const authoredRow = authored.querySelector<HTMLElement>('.play-action-buttons')!;

        for (const locale of locales) {
          const section = document.createElement('section');
          section.className = 'locale-player-probe';
          section.lang = locale.htmlLang;
          section.style.setProperty('--font-sans', locale.fontFamily);
          section.style.fontFamily = locale.fontFamily;

          for (const [scale, className] of [
            ['normal', ''],
            ['200', ' text-200'],
          ] as const) {
            for (const [pairIndex, labels] of [
              [0, [locale.player.sync, locale.player.media]],
              [1, [locale.player.syncing, locale.player.media]],
            ] as const) {
              const row = authoredRow.cloneNode(true) as HTMLElement;
              row.classList.add('locale-player-actions');
              if (className) row.classList.add('text-200');
              row.dataset.scale = scale;
              row.style.setProperty('--play-action-slot-width', '131px');
              row.querySelector<HTMLElement>(
                '.play-action-stop-content .play-action-label',
              )!.textContent = locale.player.stop;

              for (const [buttonIndex, label] of labels.entries()) {
                const button = row.querySelector<HTMLButtonElement>(
                  buttonIndex === 0 ? '#btn-sync' : '#btn-media-source',
                )!;
                button.dataset.probe = `${locale.code}-${scale}-${pairIndex}-${buttonIndex}`;
                button.querySelector<HTMLElement>(
                  buttonIndex === 0
                    ? '.play-action-sync-content .play-action-label'
                    : '.play-action-media-content .play-action-label',
                )!.textContent = label;
              }
              section.appendChild(row);
            }
          }
          root.appendChild(section);
        }
      },
      { locales: localesWithFonts, markup: APP_MARKUP },
    );
    await waitForLayoutFonts(page);

    const playerActions = await page
      .locator('.locale-player-actions > button')
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const label = button.querySelector<HTMLElement>(
            button.id === 'btn-sync'
              ? '.play-action-sync-content .play-action-label'
              : '.play-action-media-content .play-action-label',
          )!;
          const buttonRect = button.getBoundingClientRect();
          const labelRect = label.getBoundingClientRect();
          const content = label.parentElement!;
          const iconRect = content.querySelector('svg')!.getBoundingClientRect();
          const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight);
          return {
            id: button.dataset.probe ?? 'unknown',
            scale: button.parentElement?.dataset.scale,
            buttonWidth: buttonRect.width,
            buttonHeight: buttonRect.height,
            buttonClientHeight: button.clientHeight,
            buttonScrollHeight: button.scrollHeight,
            buttonOverflowX: getComputedStyle(button).overflowX,
            contentOpacity: getComputedStyle(content).opacity,
            iconLeft: iconRect.left,
            iconRight: iconRect.right,
            iconTop: iconRect.top,
            iconBottom: iconRect.bottom,
            labelLeft: labelRect.left,
            labelRight: labelRect.right,
            labelTop: labelRect.top,
            labelBottom: labelRect.bottom,
            labelHeight: labelRect.height,
            labelClientWidth: label.clientWidth,
            labelClientHeight: label.clientHeight,
            labelScrollWidth: label.scrollWidth,
            labelScrollHeight: label.scrollHeight,
            lineHeight,
            buttonLeft: buttonRect.left,
            buttonRight: buttonRect.right,
            buttonTop: buttonRect.top,
            buttonBottom: buttonRect.bottom,
          };
        }),
      );

    for (const action of playerActions) {
      // 272px between the 24px sides at 320px, less the 10px gap, halved.
      expect(action.buttonWidth, `${action.id} must use the real 131px slot`).toBe(131);
      // The transparent full-row stop frame deliberately extends beyond the
      // split media button. Judge the visible icon and label, while preserving
      // the clipping boundary that keeps that outgoing frame offscreen.
      expect(action.buttonOverflowX, `${action.id} must clip its inactive frame`).toBe('hidden');
      expect(action.contentOpacity, `${action.id} compact content must be visible`).toBe('1');
      expect(action.iconLeft, `${action.id} icon must stay inside`).toBeGreaterThanOrEqual(
        action.buttonLeft - 0.5,
      );
      expect(action.iconRight, `${action.id} icon must stay inside`).toBeLessThanOrEqual(
        action.buttonRight + 0.5,
      );
      expect(action.iconTop, `${action.id} icon must stay inside`).toBeGreaterThanOrEqual(
        action.buttonTop - 0.5,
      );
      expect(action.iconBottom, `${action.id} icon must stay inside`).toBeLessThanOrEqual(
        action.buttonBottom + 0.5,
      );
      expect(
        action.buttonScrollHeight,
        `${action.id} button must grow instead of clipping`,
      ).toBeLessThanOrEqual(action.buttonClientHeight);
      expect(
        action.labelLeft,
        `${action.id} label must stay inside the button`,
      ).toBeGreaterThanOrEqual(action.buttonLeft - 0.5);
      expect(
        action.labelRight,
        `${action.id} label must stay inside the button`,
      ).toBeLessThanOrEqual(action.buttonRight + 0.5);
      expect(
        action.labelTop,
        `${action.id} label must stay inside the button`,
      ).toBeGreaterThanOrEqual(action.buttonTop - 0.5);
      expect(
        action.labelBottom,
        `${action.id} label must stay inside the button`,
      ).toBeLessThanOrEqual(action.buttonBottom + 0.5);
      expect(
        action.labelScrollWidth,
        `${action.id} label must not overflow horizontally`,
      ).toBeLessThanOrEqual(action.labelClientWidth);
      expect(
        action.labelScrollHeight,
        `${action.id} label must not clip vertically`,
      ).toBeLessThanOrEqual(action.labelClientHeight);
      if (action.scale === 'normal') {
        expect(
          action.labelHeight,
          `${action.id} compact label must remain one line`,
        ).toBeLessThanOrEqual(action.lineHeight + 0.5);
      } else {
        expect(
          action.labelHeight,
          `${action.id} enlarged compact label must stay within two lines`,
        ).toBeLessThanOrEqual(action.lineHeight * 2 + 0.5);
      }
    }
  });

  // The demo finish pair (Track info / Exit Tour) sits two per row in fixed
  // 54px pills on phones up to 420px, where it takes the tab role's 13px
  // (button-label-contract): at the chip role's 14px the Tamil Exit Tour
  // reaches past its pill at 320 and 340px where 9.0.18 kept it inside. Each
  // locale's pair is measured beside a copy that carries the 9.0.18
  // label and pill (13px / 600 / normal line height and tracking, 10px side
  // padding, 10px gap, 20px icon) in the same browser and fonts, so the pin
  // holds on any platform: no label or icon may reach further past its pill
  // than in 9.0.18. Tamil Exit Tour is wider than its pill at 320px in 9.0.18
  // too; that pre-existing case is an owner item in the UI bundle report.
  const DEMO_FINISH_9_0_18 = {
    button:
      'font-size: 13px; font-weight: 600; line-height: normal; letter-spacing: normal; ' +
      'height: 54px; min-height: 54px; padding: 0 10px; gap: 10px;',
    icon: 'width: 20px; height: 20px;',
  };
  for (const viewportWidth of [320, 340, 360]) {
    test(`keeps the demo finish pair no worse than 9.0.18 in every locale at ${viewportWidth}px`, async ({
      page,
    }) => {
      await installLayoutProbe(page, '<main id="demo-finish-probes"></main>', { viewportWidth });
      const localesWithFonts = await localizedActionsWithFonts(page);
      await page.evaluate(
        ({ locales, markup, reference }) => {
          // As src/demo/mode.ts applies the demo, on its finish step.
          document.body.classList.add('mode-demo', 'demo-mobile');
          const root = document.getElementById('demo-finish-probes')!;
          const authored = new DOMParser().parseFromString(markup, 'text/html');
          const overlay = authored.getElementById('demo-overlay')!;
          overlay.classList.add('active');
          for (const panel of overlay.querySelectorAll('.demo-step-panel')) {
            panel.classList.toggle('active', panel.getAttribute('data-demo-panel') === '4');
          }
          for (const locale of locales) {
            const probe = overlay.cloneNode(true) as HTMLElement;
            probe.classList.add('locale-demo-finish-probe');
            probe.lang = locale.htmlLang;
            probe.dir = locale.dir;
            probe.style.setProperty('--font-sans', locale.fontFamily);
            probe.style.fontFamily = locale.fontFamily;
            const row = probe.querySelector<HTMLElement>(
              '[data-demo-panel="4"] .demo-large-actions',
            )!;
            row.querySelector('[data-demo-info] span')!.textContent = locale.demo.info;
            row.querySelector('[data-demo-exit] span')!.textContent = locale.demo.exit;
            row.dataset.finishPair = 'shipped';
            const baseline = row.cloneNode(true) as HTMLElement;
            baseline.dataset.finishPair = '9.0.18';
            for (const button of baseline.querySelectorAll<HTMLElement>('button')) {
              button.style.cssText += reference.button;
              button.querySelector<SVGElement>('svg')!.style.cssText += reference.icon;
            }
            row.after(baseline);
            root.appendChild(probe);
          }
        },
        { locales: localesWithFonts, markup: APP_MARKUP, reference: DEMO_FINISH_9_0_18 },
      );
      await waitForLayoutFonts(page);

      const probes = await page.locator('.locale-demo-finish-probe').evaluateAll((overlays) =>
        overlays.map((overlay) => {
          // How far a pill's icon and label reach past its edges, 0 inside.
          const spill = (button: HTMLElement) => {
            const pill = button.getBoundingClientRect();
            const icon = button.querySelector('svg')!.getBoundingClientRect();
            const label = button.querySelector<HTMLElement>('span')!;
            const text = document.createRange();
            text.selectNodeContents(label);
            const glyphs = [...text.getClientRects()];
            const box = label.getBoundingClientRect();
            const left = Math.min(icon.left, ...glyphs.map((rect) => rect.left));
            const right = Math.max(icon.right, ...glyphs.map((rect) => rect.right));
            const top = Math.min(icon.top, box.top);
            const bottom = Math.max(icon.bottom, box.bottom);
            const style = getComputedStyle(label);
            return {
              typography: [style.fontSize, style.fontWeight, style.lineHeight, style.letterSpacing],
              width: pill.width,
              height: pill.height,
              horizontal: Math.max(0, pill.left - left, right - pill.right),
              vertical: Math.max(0, pill.top - top, bottom - pill.bottom),
            };
          };
          const pair = (version: string) => {
            const row = overlay.querySelector<HTMLElement>(`[data-finish-pair="${version}"]`)!;
            return {
              info: spill(row.querySelector<HTMLElement>('[data-demo-info]')!),
              exit: spill(row.querySelector<HTMLElement>('[data-demo-exit]')!),
            };
          };
          return {
            lang: overlay.getAttribute('lang') ?? 'unknown',
            shipped: pair('shipped'),
            reference: pair('9.0.18'),
          };
        }),
      );
      expect(probes).toHaveLength(42);
      const worse: string[] = [];
      for (const probe of probes) {
        for (const label of ['info', 'exit'] as const) {
          const shipped = probe.shipped[label];
          const reference = probe.reference[label];
          const id = `${probe.lang} ${label}`;
          expect(reference.typography, `${id} 9.0.18 label`).toEqual([
            '13px',
            '600',
            'normal',
            'normal',
          ]);
          expect(shipped.height, `${id} pill height`).toBeCloseTo(54, 1);
          expect(reference.height, `${id} 9.0.18 pill height`).toBeCloseTo(54, 1);
          expect(shipped.width, `${id} pill width`).toBeCloseTo(reference.width, 1);
          for (const axis of ['horizontal', 'vertical'] as const) {
            if (shipped[axis] > reference[axis] + 0.5) {
              worse.push(
                `${id} ${axis}: ${shipped[axis].toFixed(2)}px past its pill ` +
                  `(9.0.18 ${reference[axis].toFixed(2)}px)`,
              );
            }
          }
        }
      }
      expect(worse, `labels that spill further than 9.0.18 at ${viewportWidth}px`).toEqual([]);
    });
  }

  // The narrow slots of the label sweeps (PR #510 QA rounds 8 to 10) under
  // the button label roles (owner decision 2026-10-28; button-label-contract
  // names the compact members with their reasons). Each locale's slot is
  // rendered from the authored markup in its own containers and measured
  // twice in the same browser and fonts: as shipped, and with each label's
  // 9.0.18 typography inline. No label may wrap to more lines, break inside
  // more words, reach further past its pill or past the viewport, or lose
  // more of its glyphs to an overflow that cuts it off, and no action pair
  // may take more rows than with the 9.0.18 typography. The compact members
  // (Sign out, Delete account and the media source options) take the chip
  // role's 14px up to 719px; the wider sizes show that the CTA role has room
  // above it.
  type SweptLabel = { selector: string; typography: string };
  const SWEPT_SLOTS_9_0_18: Record<string, SweptLabel[]> = {
    'account pair': [
      {
        selector: '#btn-account-logout',
        typography:
          'font-size: 15px; font-weight: 700; line-height: normal; letter-spacing: normal',
      },
      {
        selector: '#btn-account-delete',
        typography: 'font-size: 14px; font-weight: 700; line-height: 1.2; letter-spacing: normal',
      },
    ],
    'invite link': [
      {
        selector: '.btn-copy-invite-link > span:last-child',
        typography: 'font-size: 15px; font-weight: 600; line-height: 1.3; letter-spacing: normal',
      },
    ],
    'leave session': [
      {
        selector: '#btn-leave-session > span',
        typography:
          'font-size: 15px; font-weight: 600; line-height: normal; letter-spacing: normal',
      },
    ],
    'help actions': [
      {
        selector: '.help-actions > button > span',
        typography: 'font-size: 15px; font-weight: 600; line-height: 1.3; letter-spacing: normal',
      },
    ],
    'media sources': [
      {
        selector:
          '#btn-local-file > span, #btn-youtube-source > span, #btn-system-audio .media-source-label-text',
        // 9.0.18 also broke these labels with the default rules; the shipped
        // labels wrap at word boundaries (Korean) and phrases (Japanese).
        typography:
          'font-size: 15px; font-weight: 600; line-height: 1.25; letter-spacing: -0.3px; ' +
          'word-break: normal; line-break: auto',
      },
    ],
    'selection toggle': [
      {
        selector: '.playlist-selection-toggle',
        typography: 'font-size: 15px; font-weight: 600; line-height: 1.2; letter-spacing: normal',
      },
    ],
    'setup choice': [
      {
        selector: '#btn-setup-host, #btn-setup-guest',
        typography:
          'font-size: 15px; font-weight: 600; line-height: normal; letter-spacing: normal',
      },
    ],
    'setup confirm': [
      {
        selector: '#btn-setup-confirm',
        typography:
          'font-size: 15px; font-weight: 600; line-height: normal; letter-spacing: normal',
      },
    ],
    'YouTube link actions': [
      {
        selector: '#btn-yt-cancel, #youtube-play-btn',
        typography:
          'font-size: 15px; font-weight: 600; line-height: normal; letter-spacing: normal',
      },
    ],
    'play actions': [
      {
        selector: '.play-action-label',
        typography: 'font-size: 15px; font-weight: 600; line-height: 1.25; letter-spacing: -0.3px',
      },
    ],
  };
  // The phone widths, both sides of the 420px and 719/720px boundaries, a
  // width inside the band where media labels wrapped at 700 (482 to 488px),
  // one inside the band where the Malayalam Please wait of the setup action
  // pill wrapped at 700 (425 to 432px), two landscape phones (568x320
  // compresses the account dialog; 844x390 has the two-column setup panel,
  // whose action pill is 196px wide), a tablet, and both sides of the desktop
  // dashboard boundary.
  const SWEPT_SLOT_VIEWPORTS: Array<[number, number]> = [
    [320, 800],
    [340, 800],
    [360, 800],
    [375, 800],
    [390, 800],
    [410, 800],
    [420, 800],
    [421, 800],
    [428, 800],
    [482, 800],
    [719, 800],
    [720, 800],
    [568, 320],
    [844, 390],
    [1024, 768],
    [1279, 800],
    [1280, 719],
    [1280, 800],
    [1440, 900],
  ];
  for (const [viewportWidth, viewportHeight] of SWEPT_SLOT_VIEWPORTS) {
    test(`keeps the narrow slots' role labels no worse than 9.0.18 in every locale at ${viewportWidth}x${viewportHeight}`, async ({
      page,
    }) => {
      const worse: string[] = [];
      let probedLocales = 0;
      // Right-to-left locales on a right-to-left page, so the direction rules
      // (the tracking reset among them) apply as in the app, in both themes
      // (the light theme drops the media options' 2px border).
      for (const theme of ['dark', 'light'] as const) {
        for (const direction of ['ltr', 'rtl'] as const) {
          await installLayoutProbe(page, '<main id="swept-slot-probes"></main>', {
            viewportWidth,
            viewportHeight,
            direction,
          });
          await page.evaluate((value) => {
            document.documentElement.dataset.theme = value;
          }, theme);
          const localesWithFonts = (await localizedActionsWithFonts(page)).filter(
            (locale) => locale.dir === direction,
          );
          probedLocales += localesWithFonts.length;
          await probeSweptSlots(
            page,
            localesWithFonts,
            worse,
            theme,
            isDesktopLayoutSize(viewportWidth, viewportHeight) ? DESKTOP_SWEPT_SLOTS : undefined,
          );
        }
      }
      expect(probedLocales).toBe(84);
      expect(worse, `swept slots worse than 9.0.18 at ${viewportWidth}x${viewportHeight}`).toEqual(
        [],
      );
    });
  }

  // The desktop sizes compare the play actions only: the stacked fixed
  // overlays of this probe are not laid out like one open dialog there.
  const DESKTOP_SWEPT_SLOTS = ['play actions'];

  async function probeSweptSlots(
    page: Page,
    localesWithFonts: Awaited<ReturnType<typeof localizedActionsWithFonts>>,
    worse: string[],
    theme: string,
    only?: readonly string[],
  ): Promise<void> {
    const slotNames = only ?? Object.keys(SWEPT_SLOTS_9_0_18);
    const built = await page.evaluate(
      ({ locales, markup, slots, names }) => {
        const root = document.getElementById('swept-slot-probes')!;
        // Compare finished layouts: no transition may run between the two
        // measurements.
        const still = document.createElement('style');
        still.textContent =
          '#swept-slot-probes *, #swept-slot-probes *::before, #swept-slot-probes *::after ' +
          '{ transition: none !important; animation: none !important; }';
        document.head.appendChild(still);
        const authored = new DOMParser().parseFromString(markup, 'text/html');
        // The authored element with shallow copies of its ancestors, so every
        // container rule applies without the rest of the app.
        const inPlace = (selector: string): { outer: HTMLElement; target: HTMLElement } => {
          const source = authored.querySelector<HTMLElement>(selector)!;
          const target = source.cloneNode(true) as HTMLElement;
          let outer = target;
          for (
            let ancestor = source.parentElement;
            ancestor && ancestor !== authored.body;
            ancestor = ancestor.parentElement
          ) {
            const copy = ancestor.cloneNode(false) as HTMLElement;
            copy.appendChild(outer);
            outer = copy;
          }
          return { outer, target };
        };
        const text = (scope: ParentNode, selector: string, value: string): void => {
          scope.querySelector<HTMLElement>(selector)!.textContent = value;
        };
        type Locale = (typeof locales)[number];
        const builders: Record<string, (locale: Locale) => HTMLElement[]> = {
          'account pair': (locale) => {
            const { outer, target } = inPlace('#account-dialog-actions');
            outer.classList.add('show');
            target.hidden = false;
            text(target, '#btn-account-logout', locale.swept.logout);
            text(target, '#btn-account-delete', locale.swept.deleteAccount);
            text(target, '#btn-account-center-close', locale.swept.close);
            target.dataset.sweptRow = '';
            return [outer];
          },
          'invite link': (locale) =>
            (['copy', 'recover', 'recovering', 'expired'] as const).map((mode) => {
              const { outer, target } = inPlace('#qr-container');
              outer.classList.add('active');
              // As src/ui/connect.ts mounts it.
              target.insertAdjacentHTML(
                'beforeend',
                '<button type="button" class="btn-copy-invite-link">' +
                  '<svg viewBox="0 0 24 24"></svg>' +
                  '<span class="material-elastic-spinner signaling-recovery-spinner"></span>' +
                  '<span></span></button>',
              );
              const button = target.querySelector<HTMLElement>('.btn-copy-invite-link')!;
              button.dataset.mode = mode;
              text(button, 'span:last-child', locale.swept[mode]);
              return outer;
            }),
          'leave session': (locale) => {
            const { outer, target } = inPlace('#btn-leave-session');
            outer.classList.add('active');
            text(target, 'span', locale.swept.leave);
            return [outer];
          },
          'help actions': (locale) => {
            const { outer, target } = inPlace('#tab-guide .help-actions');
            outer.classList.add('active');
            text(target, '#btn-demo-media-mobile > span', locale.swept.tour);
            text(target, '#btn-screensaver-mobile > span', locale.swept.screensaver);
            return [outer];
          },
          'media sources': (locale) =>
            [true, false].map((supported) => {
              const overlay = authored.getElementById('media-source-overlay')!;
              const outer = overlay.cloneNode(true) as HTMLElement;
              outer.classList.add('active');
              text(outer, '#btn-local-file > span', locale.swept.local);
              text(outer, '#btn-youtube-source > span', locale.swept.youtube);
              text(outer, '#btn-system-audio .media-source-label-text', locale.swept.system);
              // Phones cannot capture system audio: the option is marked
              // unsupported and its Beta badge hidden.
              outer.querySelector('#btn-system-audio')!.classList.toggle('unsupported', !supported);
              return outer;
            }),
          'selection toggle': (locale) =>
            ['5', '42', '128', '999', 'all'].map((count) => {
              const { outer, target } = inPlace('#tab-playlist > .tab-header');
              outer.classList.add('active');
              // As src/ui/playlist-removal.ts lays out the deletion mode.
              target.classList.add('is-removal-selecting');
              const title = document.createElement('span');
              title.className = 'tab-title playlist-selection-title';
              title.textContent = locale.swept.selectedCount.replace(
                /\{\{count\}\}/u,
                count === 'all' ? '5' : '1',
              );
              target.querySelector(':scope > .tab-title')!.after(title);
              const toggle = document.createElement('button');
              toggle.type = 'button';
              // As src/ui/playlist-removal.ts mounts it.
              toggle.className = 'playlist-selection-toggle';
              toggle.textContent =
                count === 'all' ? locale.swept.deselectAll : `${locale.swept.selectAll} (${count})`;
              target.querySelector('.playlist-title-area')!.appendChild(toggle);
              return outer;
            }),
          'setup choice': (locale) => {
            const { outer, target } = inPlace('#setup-actions');
            outer.classList.add('active');
            // As src/ui/setup.ts renders the room choice.
            target.classList.add('vertical');
            target.innerHTML =
              '<button type="button" id="btn-setup-host" class="btn-ob-primary"></button>' +
              '<button type="button" id="btn-setup-guest" class="btn-ob-secondary"></button>';
            text(target, '#btn-setup-host', locale.swept.host);
            text(target, '#btn-setup-guest', locale.swept.guest);
            return [outer];
          },
          // Every label of the pill beside Back: Start, Joining..., Retry and
          // Refresh filled, the host's Please wait secondary while its room
          // code loads, and the iOS YouTube gate's Please wait filled.
          'setup confirm': (locale) =>
            (
              [
                ['start', 'primary', false],
                ['joining', 'primary', true],
                ['retry', 'primary', false],
                ['refresh', 'primary', false],
                ['wait', 'secondary', true],
                ['wait', 'primary', true],
              ] as const
            ).map(([label, kind, disabled]) => {
              const { outer, target } = inPlace('#setup-actions');
              outer.classList.add('active');
              // As src/ui/setup-shared.ts renders one action beside Back.
              target.classList.add('horizontal-with-back');
              target.innerHTML =
                '<button type="button" id="btn-setup-back" class="btn-ob-icon">' +
                '<svg viewBox="0 0 24 24"></svg></button>' +
                `<button type="button" id="btn-setup-confirm" class="btn-ob-${kind}"></button>`;
              const confirm = target.querySelector<HTMLButtonElement>('#btn-setup-confirm')!;
              confirm.textContent = locale.swept[label];
              confirm.disabled = disabled;
              return outer;
            }),
          'YouTube link actions': (locale) => {
            const overlay = authored.getElementById('youtube-url-overlay')!;
            const outer = overlay.cloneNode(true) as HTMLElement;
            outer.classList.add('active');
            text(outer, '#btn-yt-cancel', locale.swept.cancel);
            text(outer, '#youtube-play-btn', locale.swept.add);
            outer.querySelector<HTMLElement>('#youtube-play-btn')!.parentElement!.dataset.sweptRow =
              '';
            return [outer];
          },
          // Sync and Media, and Stop Sharing across both slots while sharing.
          'play actions': (locale) =>
            [false, true].map((sharing) => {
              const { outer, target } = inPlace('.play-action-buttons');
              outer.classList.add('active');
              target.dataset.sharing = String(sharing);
              text(target, '.play-action-sync-content .play-action-label', locale.player.sync);
              text(target, '.play-action-media-content .play-action-label', locale.player.media);
              text(target, '.play-action-stop-content .play-action-label', locale.player.stop);
              // Only the labels on screen: Sync and Media at rest, Stop
              // Sharing while sharing.
              for (const content of target.querySelectorAll<HTMLElement>(
                sharing
                  ? '.play-action-sync-content, .play-action-media-content'
                  : '.play-action-stop-content',
              )) {
                content.dataset.unmeasured = '';
              }
              // The sharing motion sets the slot width from the row (below).
              target.dataset.slotFromRow = '';
              return outer;
            }),
        };
        let instances = 0;
        for (const locale of locales) {
          for (const [slot, build] of Object.entries(builders)) {
            if (!names.includes(slot)) continue;
            for (const outer of build(locale)) {
              outer.classList.add('swept-slot-probe');
              outer.dataset.slot = slot;
              outer.dataset.instance = String(instances++);
              outer.lang = locale.htmlLang;
              outer.dir = locale.dir;
              outer.style.setProperty('--font-sans', locale.fontFamily);
              outer.style.fontFamily = locale.fontFamily;
              slots[slot]!.forEach((entry, index) => {
                for (const label of outer.querySelectorAll<HTMLElement>(entry.selector)) {
                  if (label.closest('[data-unmeasured]')) continue;
                  label.dataset.sweptLabel = `${slot}#${index}`;
                }
              });
              root.appendChild(outer);
            }
          }
        }
        // As src/ui/sharing-action-motion.ts sizes the play action slots.
        for (const row of root.querySelectorAll<HTMLElement>('[data-slot-from-row]')) {
          const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
          row.style.setProperty('--play-action-slot-width', `${(row.clientWidth - gap) / 2}px`);
        }
        return instances;
      },
      {
        locales: localesWithFonts,
        markup: APP_MARKUP,
        slots: SWEPT_SLOTS_9_0_18,
        names: slotNames,
      },
    );
    await waitForLayoutFonts(page);

    // Lines, word breaks and reach of each excepted label, and the rows of
    // each action pair, as the page now lays them out.
    const measure = () =>
      page.locator('.swept-slot-probe').evaluateAll((probes) =>
        probes.flatMap((probe) => {
          const lang = probe.getAttribute('lang') ?? 'unknown';
          const segmenter = new Intl.Segmenter(lang, { granularity: 'word' });
          const lineCount = (rects: DOMRect[]): number => {
            let lines = 0;
            let center = Number.NEGATIVE_INFINITY;
            for (const rect of rects
              .filter((entry) => entry.width > 0.5 && entry.height > 0.5)
              .sort((first, second) => first.top - second.top)) {
              const middle = rect.top + rect.height / 2;
              if (middle - center > rect.height / 2) {
                lines += 1;
                center = middle;
              }
            }
            return lines;
          };
          const labels = [...probe.querySelectorAll<HTMLElement>('[data-swept-label]')].map(
            (label) => {
              const pill = (label.closest('button') ?? label).getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(label);
              const glyphs = [...range.getClientRects()].filter(
                (rect) => rect.width > 0.5 && rect.height > 0.5,
              );
              const left = Math.min(...glyphs.map((rect) => rect.left));
              const right = Math.max(...glyphs.map((rect) => rect.right));
              const top = Math.min(...glyphs.map((rect) => rect.top));
              const bottom = Math.max(...glyphs.map((rect) => rect.bottom));
              let broken = 0;
              const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                for (const word of segmenter.segment(node.textContent ?? '')) {
                  if (!word.isWordLike || word.segment.length < 2) continue;
                  const part = document.createRange();
                  part.setStart(node, word.index);
                  part.setEnd(node, word.index + word.segment.length);
                  if (lineCount([...part.getClientRects()]) > 1) broken += 1;
                }
              }
              // Glyphs that the label's own or an ancestor's overflow cuts
              // off (a pill that grows to its longest word can push the row
              // past the setup panel).
              let clipped = 0;
              for (
                let node: HTMLElement | null = label;
                node && node !== probe.parentElement;
                node = node.parentElement
              ) {
                const style = getComputedStyle(node);
                const box = node.getBoundingClientRect();
                if (style.overflowX !== 'visible') {
                  clipped = Math.max(clipped, box.left - left, right - box.right);
                }
                if (style.overflowY !== 'visible') {
                  clipped = Math.max(clipped, box.top - top, bottom - box.bottom);
                }
              }
              return {
                id: `${probe.dataset.slot} ${lang} #${probe.dataset.instance} ${label.textContent?.trim()}`,
                lines: lineCount(glyphs),
                broken,
                horizontal: Math.max(0, pill.left - left, right - pill.right),
                vertical: Math.max(0, pill.top - top, bottom - pill.bottom),
                clipped,
                viewport: Math.max(
                  0,
                  -left,
                  right - innerWidth,
                  -pill.left,
                  pill.right - innerWidth,
                ),
              };
            },
          );
          const rows = [...probe.querySelectorAll<HTMLElement>('[data-swept-row]')].map((row) => ({
            id: `${probe.dataset.slot} ${lang} #${probe.dataset.instance} rows`,
            rows: new Set(
              [...row.querySelectorAll<HTMLElement>(':scope > button:not([hidden])')].map(
                (button) => Math.round(button.getBoundingClientRect().top),
              ),
            ).size,
          }));
          return [...labels, ...rows];
        }),
      );
    const shipped = await measure();
    await page.evaluate((slots) => {
      for (const label of document.querySelectorAll<HTMLElement>('[data-swept-label]')) {
        const probe = label.closest<HTMLElement>('.swept-slot-probe')!;
        const [slot, index] = label.dataset.sweptLabel!.split('#') as [string, string];
        for (const declaration of slots[slot]![Number(index)]!.typography.split(';')) {
          const [property, value] = declaration.split(':').map((part) => part.trim());
          // As in 9.0.18, right-to-left labels take no tracking.
          const resolved = property === 'letter-spacing' && probe.dir === 'rtl' ? 'normal' : value!;
          label.style.setProperty(property!, resolved, 'important');
        }
      }
    }, SWEPT_SLOTS_9_0_18);
    await waitForLayoutFonts(page);
    const reference = await measure();

    // Instances per locale: 4 invite modes, 2 media states, 5 toggle states,
    // 6 setup confirm labels, 2 play action states, one of each other slot.
    const instances: Record<string, number> = {
      'invite link': 4,
      'media sources': 2,
      'selection toggle': 5,
      'setup confirm': 6,
      'play actions': 2,
    };
    expect(built).toBe(
      localesWithFonts.length *
        slotNames.reduce((total, slot) => total + (instances[slot] ?? 1), 0),
    );
    expect(reference.map((entry) => entry.id)).toEqual(shipped.map((entry) => entry.id));
    shipped.forEach((entry, index) => {
      const before = reference[index]! as Record<string, unknown>;
      for (const [metric, value] of Object.entries(entry)) {
        if (metric === 'id') continue;
        const tolerance = ['lines', 'broken', 'rows'].includes(metric) ? 0 : 0.5;
        if ((value as number) > (before[metric] as number) + tolerance) {
          worse.push(`${theme} ${entry.id} ${metric}: ${value} (9.0.18 type ${before[metric]})`);
        }
      }
    });
  }

  test('CSS hover and pressed selectors preserve the locked sharing surface', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installLayoutProbe(page, '<main id="hover-action-probe"></main>');
    await page.evaluate((markup) => {
      // The probe has no app runtime: mark the mouse user the way
      // src/ui/hover-pointer.ts does, so the competing :hover rules apply.
      document.documentElement.setAttribute('data-hover-pointer', '');
      const authored = new DOMParser().parseFromString(markup, 'text/html');
      const row = authored.querySelector<HTMLElement>('.play-action-buttons')!;
      row.classList.add('locale-merged-player-actions');
      row.dataset.hoverLocked = 'true';
      row.style.setProperty('--play-action-slot-width', '131px');
      // This isolated CSS contract deliberately supplies the controller's
      // lock state. A distinct target exposes specificity regressions even
      // when the theme's resting and hover surfaces are visually similar.
      row.style.setProperty('--motion-media-bg', 'rgb(13, 27, 41)');
      document.getElementById('hover-action-probe')!.appendChild(row);
    }, APP_MARKUP);
    const row = page.locator('.play-action-buttons');
    const media = page.locator('#btn-media-source');
    for (const theme of ['dark', 'light']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      for (const sharing of [true, false]) {
        await row.evaluate((element, value) => {
          (element as HTMLElement).dataset.sharing = String(value);
        }, sharing);
        await expect(media).toHaveCSS('width', `${sharing ? 272 : 131}px`);
        // Chromium can retain stale hover after geometry moves underneath a
        // stationary pointer. Move out and back so this test truly exercises
        // the competing :hover rule; the runtime test covers stationary input.
        await page.mouse.move(319, 790);
        await media.hover({ position: { x: 20, y: 20 } });
        // Match the qualified selector used by the component. A bare :hover
        // or :active excludes non-links in this layout fixture's quirks mode.
        await expect
          .poll(() => media.evaluate((element) => element.matches('#btn-media-source:hover')))
          .toBe(true);
        await expect(media).toHaveCSS('background-color', 'rgb(13, 27, 41)');
        await page.mouse.down();
        try {
          await expect
            .poll(() => media.evaluate((element) => element.matches('#btn-media-source:active')))
            .toBe(true);
          await expect(media).toHaveCSS('background-color', 'rgb(13, 27, 41)');
        } finally {
          await page.mouse.up();
        }
      }
    }
    await row.evaluate((element) => {
      delete (element as HTMLElement).dataset.hoverLocked;
    });
    await expect(media).not.toHaveCSS('background-color', 'rgb(13, 27, 41)');
  });

  for (const viewportWidth of [320, 1440]) {
    for (const direction of ['ltr', 'rtl'] as const) {
      test(`contains every full stop-sharing label at ${viewportWidth}px ${direction} and 200% text`, async ({
        page,
      }) => {
        // This is an authored-DOM layout probe, not a PRO transport test.
        // The runtime test exercises real capture and the local-owner gate;
        // here we exercise both ends of the same CSS state without motion.
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await installLayoutProbe(page, '<main id="merged-action-probes"></main>', {
          viewportWidth,
          direction,
        });
        const localesWithFonts = await localizedActionsWithFonts(page);
        await page.evaluate(
          ({ locales, markup, rowWidth }) => {
            const root = document.getElementById('merged-action-probes')!;
            const authored = new DOMParser().parseFromString(markup, 'text/html');
            const authoredRow = authored.querySelector<HTMLElement>('.play-action-buttons')!;
            for (const locale of locales) {
              const section = document.createElement('section');
              section.lang = locale.htmlLang;
              section.style.setProperty('--font-sans', locale.fontFamily);
              section.style.fontFamily = locale.fontFamily;
              for (const scale of ['normal', '200']) {
                const row = authoredRow.cloneNode(true) as HTMLElement;
                row.classList.add('locale-merged-player-actions');
                if (scale === '200') row.classList.add('text-200');
                row.dataset.probe = `${locale.code}-${scale}`;
                row.dataset.sharing = 'true';
                row.style.setProperty('--play-action-slot-width', `${(rowWidth - 10) / 2}px`);
                const sync = row.querySelector<HTMLButtonElement>('#btn-sync')!;
                sync.disabled = true;
                sync.inert = true;
                sync.setAttribute('aria-hidden', 'true');
                sync.querySelector<HTMLElement>('.play-action-label')!.textContent =
                  locale.player.sync;
                row.querySelector<HTMLElement>(
                  '.play-action-media-content .play-action-label',
                )!.textContent = locale.player.media;
                row.querySelector<HTMLElement>(
                  '.play-action-stop-content .play-action-label',
                )!.textContent = locale.player.stop;
                section.appendChild(row);
              }
              root.appendChild(section);
            }
          },
          {
            locales: localesWithFonts,
            markup: APP_MARKUP,
            rowWidth: viewportWidth < 1280 ? viewportWidth - 48 : 330,
          },
        );
        await waitForLayoutFonts(page);

        const layouts = await page.locator('.locale-merged-player-actions').evaluateAll((rows) =>
          rows.map((row) => {
            const button = row.querySelector<HTMLButtonElement>('#btn-media-source')!;
            const content = button.querySelector<HTMLElement>('.play-action-stop-content')!;
            const label = content.querySelector<HTMLElement>('.play-action-label')!;
            const sync = row.querySelector<HTMLButtonElement>('#btn-sync')!;
            const box = button.getBoundingClientRect();
            const rowBox = row.getBoundingClientRect();
            const labelBox = label.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(label);
            const textBox = range.getBoundingClientRect();
            const style = getComputedStyle(label);
            const iconSvg = content.querySelector<SVGSVGElement>('svg')!;
            const iconBox = iconSvg.getBoundingClientRect();
            const glyph = iconSvg.querySelector<SVGGraphicsElement>('path')!.getBBox();
            const viewBox = iconSvg.viewBox.baseVal;
            const timing = Array.from(
              row.querySelectorAll<HTMLElement>('button, button > span'),
            ).map((element) => {
              const elementStyle = getComputedStyle(element);
              const milliseconds = (value: string) =>
                Number.parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000);
              return {
                durationMs: Math.max(
                  ...elementStyle.transitionDuration.split(',').map(milliseconds),
                ),
                delayMs: Math.max(...elementStyle.transitionDelay.split(',').map(milliseconds)),
              };
            });
            return {
              id: (row as HTMLElement).dataset.probe,
              button: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
              row: { left: rowBox.left, right: rowBox.right },
              label: {
                left: labelBox.left,
                right: labelBox.right,
                top: labelBox.top,
                bottom: labelBox.bottom,
              },
              text: {
                left: textBox.left,
                right: textBox.right,
                top: textBox.top,
                bottom: textBox.bottom,
              },
              icon: { left: iconBox.left, right: iconBox.right, width: iconBox.width },
              iconSize: Number.parseFloat(
                getComputedStyle(row).getPropertyValue('--play-action-icon-size'),
              ),
              glyphFillsIcon:
                glyph.x === viewBox.x &&
                glyph.y === viewBox.y &&
                glyph.width === viewBox.width &&
                glyph.height === viewBox.height,
              scrollWidth: label.scrollWidth,
              clientWidth: label.clientWidth,
              scrollHeight: label.scrollHeight,
              clientHeight: label.clientHeight,
              textOverflow: style.textOverflow,
              visible: getComputedStyle(content).opacity,
              syncUnavailable: sync.disabled && sync.inert,
              timing,
            };
          }),
        );
        expect(layouts).toHaveLength(LOCALIZED_ACTIONS.length * 2);
        for (const layout of layouts) {
          expect(Math.abs(layout.button.left - layout.row.left), layout.id).toBeLessThanOrEqual(
            0.75,
          );
          expect(Math.abs(layout.button.right - layout.row.right), layout.id).toBeLessThanOrEqual(
            0.75,
          );
          expect(layout.visible, layout.id).toBe('1');
          expect(layout.syncUnavailable, layout.id).toBe(true);
          for (const timing of layout.timing) {
            // The global motion-safety rule uses a nonzero 0.01ms duration to
            // preserve completion events. No visible duration or label delay
            // may survive reduced motion; allow only numeric conversion noise.
            expect(timing.durationMs, layout.id).toBeLessThanOrEqual(0.010001);
            expect(timing.delayMs, layout.id).toBe(0);
          }
          expect(layout.textOverflow, layout.id).not.toBe('ellipsis');
          expect(layout.scrollWidth, layout.id).toBeLessThanOrEqual(layout.clientWidth);
          expect(layout.scrollHeight, layout.id).toBeLessThanOrEqual(layout.clientHeight);
          for (const rect of [layout.label, layout.text]) {
            expect(rect.left, layout.id).toBeGreaterThanOrEqual(layout.button.left - 0.75);
            expect(rect.right, layout.id).toBeLessThanOrEqual(layout.button.right + 0.75);
            expect(rect.top, layout.id).toBeGreaterThanOrEqual(layout.button.top - 0.75);
            expect(rect.bottom, layout.id).toBeLessThanOrEqual(layout.button.bottom + 0.75);
          }
          // The stop icon's box is exactly its drawn square, so centering the
          // icon and label boxes centers what is visible.
          expect(layout.glyphFillsIcon, layout.id).toBe(true);
          expect(Math.abs(layout.icon.width - layout.iconSize / 2), layout.id).toBeLessThanOrEqual(
            0.05,
          );
          const groupLeft = direction === 'ltr' ? layout.icon.left : layout.label.left;
          const groupRight = direction === 'ltr' ? layout.label.right : layout.icon.right;
          expect(
            Math.abs((groupLeft + groupRight) / 2 - (layout.button.left + layout.button.right) / 2),
            layout.id,
          ).toBeLessThanOrEqual(0.75);
        }

        // Let the global 0.01ms completion event settle without sleeping for a
        // normal animation. The computed duration/delay assertions above keep
        // this poll from accidentally accepting a full-length transition.
        await page.locator('.locale-merged-player-actions').evaluateAll((rows) => {
          for (const row of rows) {
            (row as HTMLElement).dataset.sharing = 'false';
            const sync = row.querySelector<HTMLButtonElement>('#btn-sync')!;
            sync.disabled = false;
            sync.inert = false;
            sync.removeAttribute('aria-hidden');
          }
        });
        const expectedSlot = ((viewportWidth < 1280 ? viewportWidth - 48 : 330) - 10) / 2;
        await expect
          .poll(() =>
            page
              .locator('.locale-merged-player-actions')
              .evaluateAll(
                (rows, slot) =>
                  rows.every((row) =>
                    Array.from(row.querySelectorAll('button')).every(
                      (button) => Math.abs(button.getBoundingClientRect().width - slot) < 0.05,
                    ),
                  ),
                expectedSlot,
              ),
          )
          .toBe(true);
        const split = await page.locator('.locale-merged-player-actions').evaluateAll((rows) =>
          rows.map((row) => {
            const sync = row.querySelector<HTMLElement>('#btn-sync')!.getBoundingClientRect();
            const media = row
              .querySelector<HTMLElement>('#btn-media-source')!
              .getBoundingClientRect();
            return {
              id: (row as HTMLElement).dataset.probe,
              sync: { left: sync.left, right: sync.right, width: sync.width },
              media: { left: media.left, right: media.right, width: media.width },
            };
          }),
        );
        for (const row of split) {
          expect(row.sync.width, row.id).toBeCloseTo(expectedSlot, 1);
          expect(row.media.width, row.id).toBeCloseTo(expectedSlot, 1);
          const gap =
            direction === 'rtl' ? row.sync.left - row.media.right : row.media.left - row.sync.right;
          expect(gap, row.id).toBeCloseTo(10, 1);
        }
      });
    }
  }
});
