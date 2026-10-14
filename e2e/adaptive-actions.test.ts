import { expect, test, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_DICTIONARIES as LOCALES } from '../src/i18n/catalogs.ts';
import { LANGUAGE_OPTIONS } from '../src/i18n/locales.ts';

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
  'common.grant',
  'common.revoke',
  'connect.signaling_recover_action',
  'connect.signaling_retry',
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

const LOCALIZED_ACTIONS = Object.entries(LOCALES).map(([code, dictionary]) => ({
  code,
  htmlLang: LANGUAGE_OPTIONS.find((locale) => locale.code === code)!.htmlLang,
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
  },
  player: {
    sync: (dictionary as Record<string, string>)['player.sync_compact'],
    syncing: (dictionary as Record<string, string>)['player.syncing_compact'],
    media: (dictionary as Record<string, string>)['player.play_media_compact'],
    stop: (dictionary as Record<string, string>)['system_audio.stop'],
  },
  nav: [
    (dictionary as Record<string, string>)['nav.home'],
    (dictionary as Record<string, string>)['nav.playlist_compact'],
    (dictionary as Record<string, string>)['nav.connect_compact'],
    (dictionary as Record<string, string>)['nav.settings_compact'],
    (dictionary as Record<string, string>)['nav.help'],
  ],
}));

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
  options: { viewportWidth?: number; direction?: 'ltr' | 'rtl' } = {},
): Promise<void> {
  const viewportWidth = options.viewportWidth ?? 320;
  await page.setViewportSize({ width: viewportWidth, height: 800 });
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
         action slots plus a 12px gap on desktop. Keep the authored button
         subtree and its cascade; only supply its surrounding panel's width. */
      .locale-merged-player-actions {
        width: ${viewportWidth < 1280 ? viewportWidth - 48 : 332}px;
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
    const primaryFaces = await document.fonts.load('750 15px "Pretendard"', 'MUSIXQUARE');
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
    expect(fallback[0]!.height).toBeGreaterThan(54);
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
        <button id="account-delete" class="account-delete-button">Delete account</button>
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
          ['account-delete-button', locale.account.deleteAccount],
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
              row.style.setProperty('--play-action-slot-width', '130px');
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
      expect(action.buttonWidth, `${action.id} must use the real 130px slot`).toBe(130);
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

  test('CSS hover and pressed selectors preserve the locked sharing surface', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installLayoutProbe(page, '<main id="hover-action-probe"></main>');
    await page.evaluate((markup) => {
      const authored = new DOMParser().parseFromString(markup, 'text/html');
      const row = authored.querySelector<HTMLElement>('.play-action-buttons')!;
      row.classList.add('locale-merged-player-actions');
      row.dataset.hoverLocked = 'true';
      row.style.setProperty('--play-action-slot-width', '130px');
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
        await expect(media).toHaveCSS('width', `${sharing ? 272 : 130}px`);
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
                row.style.setProperty('--play-action-slot-width', `${(rowWidth - 12) / 2}px`);
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
            rowWidth: viewportWidth < 1280 ? viewportWidth - 48 : 332,
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
        const expectedSlot = ((viewportWidth < 1280 ? viewportWidth - 48 : 332) - 12) / 2;
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
          expect(gap, row.id).toBeCloseTo(12, 1);
        }
      });
    }
  }
});
