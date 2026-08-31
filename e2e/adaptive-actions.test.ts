import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_DICTIONARIES as LOCALES } from '../src/i18n/catalogs.ts';

const APP_STYLES = readFileSync(resolve('css/style.css'), 'utf8');

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
    stop: (dictionary as Record<string, string>)['system_audio.stop_compact'],
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

async function installLayoutProbe(page: Page, markup: string): Promise<void> {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.setContent(`
    <style>
      ${APP_STYLES}
      html,
      body {
        width: 320px;
        margin: 0;
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

      .text-200.locale-player-actions .file-select-btn span {
        font-size: 30px;
      }

      .text-200 button,
      .text-200 a {
        font-size: 30px;
        line-height: 1.25;
      }
    </style>
    ${markup}
  `);
  await page.evaluate(() => document.fonts.ready);
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
    await page.evaluate((locales) => {
      const root = document.getElementById('locale-probes')!;

      for (const locale of locales) {
        const section = document.createElement('section');
        section.className = 'locale-probe';
        section.lang = locale.code;

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
    }, LOCALIZED_ACTIONS);
    await page.evaluate(() => document.fonts.ready);

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
          return {
            id: `${label.closest<HTMLElement>('.locale-probe')?.lang ?? 'unknown'}-nav-${index}`,
            buttonLeft: buttonRect.left,
            buttonRight: buttonRect.right,
            labelLeft: labelRect.left,
            labelRight: labelRect.right,
            clientWidth: label.clientWidth,
            clientHeight: label.clientHeight,
            scrollWidth: label.scrollWidth,
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
      expect(label.scrollWidth, `${label.id} must fit without ellipsis`).toBeLessThanOrEqual(
        label.clientWidth,
      );
      expect(label.scrollHeight, `${label.id} must remain one line`).toBeLessThanOrEqual(
        label.clientHeight,
      );
    }
  });

  test('keeps every compact player action contained at the real 320px width', async ({ page }) => {
    await installLayoutProbe(page, '<main id="player-action-probes"></main>');
    await page.evaluate((locales) => {
      const root = document.getElementById('player-action-probes')!;

      for (const locale of locales) {
        const section = document.createElement('section');
        section.className = 'locale-player-probe';
        section.lang = locale.code;

        for (const [scale, className] of [
          ['normal', ''],
          ['200', ' text-200'],
        ] as const) {
          for (const [pairIndex, labels] of [
            [0, [locale.player.sync, locale.player.media]],
            [1, [locale.player.syncing, locale.player.stop]],
          ] as const) {
            const row = document.createElement('div');
            row.className = `play-action-buttons play-actions-row locale-player-actions${className}`;
            row.dataset.scale = scale;

            for (const [buttonIndex, label] of labels.entries()) {
              const button = document.createElement('button');
              button.className = 'file-select-btn file-select-btn-large flex-1';
              button.id = buttonIndex === 0 ? 'btn-sync' : 'btn-media-source';
              button.dataset.probe = `${locale.code}-${scale}-${pairIndex}-${buttonIndex}`;
              const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
              icon.setAttribute('viewBox', '0 0 24 24');
              const text = document.createElement('span');
              text.textContent = label;
              button.append(icon, text);
              row.appendChild(button);
            }
            section.appendChild(row);
          }
        }
        root.appendChild(section);
      }
    }, LOCALIZED_ACTIONS);
    await page.evaluate(() => document.fonts.ready);

    const playerActions = await page
      .locator('.locale-player-actions > button')
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const label = button.querySelector<HTMLElement>('span')!;
          const buttonRect = button.getBoundingClientRect();
          const labelRect = label.getBoundingClientRect();
          const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight);
          return {
            id: button.dataset.probe ?? 'unknown',
            scale: button.parentElement?.dataset.scale,
            buttonWidth: buttonRect.width,
            buttonHeight: buttonRect.height,
            buttonClientWidth: button.clientWidth,
            buttonClientHeight: button.clientHeight,
            buttonScrollWidth: button.scrollWidth,
            buttonScrollHeight: button.scrollHeight,
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
      expect(
        action.buttonScrollWidth,
        `${action.id} button must not overflow horizontally`,
      ).toBeLessThanOrEqual(action.buttonClientWidth);
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
});
