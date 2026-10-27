import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import cascadeLayers from '@csstools/postcss-cascade-layers';
import isPseudoClass from '@csstools/postcss-is-pseudo-class';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { useAnonymousAccountSession } from './helpers/context-factory.ts';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';

// Exercise the deployed cascade order, including the legacy layer lowering.
// These are outcome checks: component ownership may change without changing
// the assertions or requiring a large checked-in CSS snapshot.
const appCss = ['css/style.css', 'css/desktop.css', 'css/rtl.css']
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
const compiledCss = postcss([cascadeLayers(), isPseudoClass({ preserve: false })])
  .process(appCss, { from: undefined })
  .then((result) => result.css);
// The whole app stylesheet as css/app.css imports it, play-tab actions included.
const compiledActionCss = postcss([cascadeLayers(), isPseudoClass({ preserve: false })])
  .process(`${appCss}\n${readFileSync('css/playback-actions.css', 'utf8')}`, { from: undefined })
  .then((result) => result.css);

const viewports = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 390, height: 700 },
  { width: 390, height: 640 },
  { width: 390, height: 720 },
  { width: 390, height: 721 },
  { width: 700, height: 400 },
  { width: 720, height: 900 },
  { width: 844, height: 390 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 844, height: 300 },
  { width: 844, height: 180 },
];

for (const mode of [
  { theme: 'dark', direction: 'ltr' },
  { theme: 'light', direction: 'ltr' },
  { theme: 'light', direction: 'rtl' },
] as const) {
  test(`component shapes survive responsive layers (${mode.theme} ${mode.direction})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setContent(`<!doctype html>
      <html dir="${mode.direction}" data-theme="${mode.theme}">
        <head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${await compiledCss}</style></head>
        <body class="fouc-loaded">
          <main>
            <button class="file-select-btn" data-shape="pill">Media</button>
            <button class="accent-action-btn" data-shape="pill">Connect</button>
            <button class="leave-session-btn" data-shape="pill">Leave</button>
            <button class="btn-ob-primary" data-shape="pill">Continue</button>
            <button class="sync-nudge-btn" data-shape="pill">+</button>
            <button class="playlist-reorder-handle" data-shape="pill">Reorder</button>
            <button class="btn-playlist-remove" data-shape="pill">Remove</button>
            <button class="btn-playlist-select" data-shape="pill">Select</button>
            <button class="playlist-selection-action" data-shape="pill">Delete</button>
            <button class="dialog-primary" data-shape="pill">Confirm</button>
            <div class="track-item" data-shape="pill">Track</div>
            <div class="sub-track-item" data-shape="pill">Track details</div>
            <div class="device-row" data-shape="pill">Device</div>
            <div class="device-subrow" data-shape="pill">Device details</div>
            <div class="list-empty-state" data-shape="pill">Empty</div>
            <div class="track-artist" data-metadata="filled">Artist</div>
            <div class="track-artist" data-metadata="empty"></div>
            <button class="ch-opt" data-shape="card">Choice</button>
            <button class="yt-search-result" data-shape="square">Search result</button>
            <button class="setup-qr-close" data-shape="square">Close camera</button>
            <button class="setup-qr-scan-button" data-shape="square">Scan QR</button>
            <button id="youtube-ios-sync-overlay" data-shape="square">Tap to play</button>
            <div class="settings-subtab-nav"><button class="subtab-pill" data-shape="square">General</button></div>
            <div class="bottom-nav"><button class="nav-item">Player</button></div>
            <div class="chat-group mine">
              <div class="chat-row"><button class="chat-youtube-btn">First video</button></div>
              <div class="chat-row"><button class="chat-youtube-btn">Middle video</button></div>
              <div class="chat-row"><button class="chat-youtube-btn">Last video</button></div>
            </div>
            <div class="chat-group others">
              <div class="chat-row"><button class="chat-youtube-btn">First video</button></div>
              <div class="chat-row"><button class="chat-youtube-btn">Last video</button></div>
            </div>
          </main>
        </body>
      </html>`);

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const shapes = await page.evaluate(() => {
        const radius = (element: Element) => {
          const css = getComputedStyle(element);
          return [
            css.borderTopLeftRadius,
            css.borderTopRightRadius,
            css.borderBottomRightRadius,
            css.borderBottomLeftRadius,
          ];
        };
        return {
          pills: [...document.querySelectorAll('[data-shape="pill"]')].map((element) => ({
            component: element.className,
            radius: radius(element),
          })),
          squares: [...document.querySelectorAll('[data-shape="square"]')].map(radius),
          card: radius(document.querySelector('[data-shape="card"]')!),
          nav: radius(document.querySelector('.nav-item')!),
          mine: [...document.querySelectorAll('.mine .chat-youtube-btn')].map(radius),
          others: [...document.querySelectorAll('.others .chat-youtube-btn')].map(radius),
          artist: getComputedStyle(document.querySelector('[data-metadata="filled"]')!).display,
          emptyArtist: getComputedStyle(document.querySelector('[data-metadata="empty"]')!).display,
          layoutWidth: window.innerWidth,
        };
      });
      const label = `${viewport.width}x${viewport.height}`;
      expect(shapes.layoutWidth, `${label} uses the requested CSS viewport`).toBe(viewport.width);
      expect(shapes.artist, `${label} retains the metadata visibility boundary`).toBe(
        viewport.width <= 1279 && viewport.height <= 720 && viewport.height >= viewport.width
          ? 'none'
          : 'block',
      );
      expect(shapes.emptyArtist, `${label} keeps empty metadata hidden`).toBe('none');
      expect(shapes.pills, label).toHaveLength(15);
      for (const pill of shapes.pills) {
        expect(pill.radius, `${label} ${pill.component}`).toEqual(Array(4).fill('999px'));
      }
      expect(shapes.squares, label).toEqual(Array.from({ length: 5 }, () => Array(4).fill('0px')));
      expect(shapes.card, label).toEqual(Array(4).fill('20px'));
      expect(shapes.nav, label).toEqual(
        Array(4).fill(
          viewport.height <= 300 && viewport.width > viewport.height
            ? '12px'
            : viewport.width >= 720 && viewport.width < 1280
              ? '10px'
              : '0px',
        ),
      );
      // YouTube cards retain the chat group tail instead of becoming capsules.
      const mine = [
        ['20px', '20px', '4px', '20px'],
        ['20px', '4px', '4px', '20px'],
        ['20px', '4px', '20px', '20px'],
      ];
      const others = [
        ['20px', '20px', '20px', '4px'],
        ['4px', '20px', '20px', '20px'],
      ];
      // The chat lane remains physically right/left aligned in both directions.
      expect(shapes.mine, label).toEqual(mine);
      expect(shapes.others, label).toEqual(others);
    }
  });
}

// Owner decision (2026-10-27): every action button label renders the button
// label tokens after every layer, ID selector and responsive override, so
// labels differ only by color. Destructive labels share one danger color.
// The named narrow-slot exception (U12): the play tab's compact Sync, Media
// and Stop Sharing labels keep the 9.0.18 weight and tracking (600, -0.3px),
// and the demo finish pair keeps the 9.0.18 weight 600 in its 13px label on
// phones up to 420px.
const COMPACT_PLAY_ACTION_LABELS = ['play-sync', 'play-media', 'play-stop'];
const DEMO_FINISH_LABELS = ['demo-info', 'demo-exit'];
const COMPACT_DEMO_MAX_WIDTH = 420;
// The label sweep's narrow slots that this generic markup carries (PR #510 QA
// round 8): the invite button and the deletion-mode toggle keep the 9.0.18
// weight 600 on phones up to 420px. The other swept slots are named by ID.
const SWEPT_NARROW_LABELS = ['invite-link', 'select-all'];
const actionLabelMarkup = `
  <main>
    <div class="dialog-actions adaptive-action-group">
      <button class="dialog-secondary" data-label="dialog-secondary">Log out</button>
      <button class="dialog-primary" data-label="dialog-primary">Log out</button>
    </div>
    <div class="account-dialog-actions adaptive-action-group">
      <button class="dialog-secondary" data-label="account-logout">Log out</button>
      <button class="dialog-secondary dialog-danger" data-label="account-delete" data-danger>Log out</button>
      <button class="dialog-primary account-dialog-account-close adaptive-action-group-full" data-label="account-close">Log out</button>
    </div>
    <div class="ob-actions">
      <button class="btn-ob-secondary" data-label="setup-secondary">Log out</button>
      <button class="btn-ob-primary" data-label="setup-primary">Log out</button>
    </div>
    <div class="ob-actions vertical">
      <button class="btn-ob-primary" data-label="setup-vertical">Log out</button>
    </div>
    <button class="accent-action-btn"><svg viewBox="0 0 24 24"></svg><span data-label="accent">Log out</span></button>
    <div class="help-actions">
      <button class="accent-action-btn"><svg viewBox="0 0 24 24"></svg><span data-label="help-accent">Log out</span></button>
    </div>
    <button class="leave-session-btn"><svg viewBox="0 0 24 24"></svg><span data-label="leave-session" data-danger>Log out</span></button>
    <button class="btn-copy-invite-link"><svg viewBox="0 0 24 24"></svg><span data-label="invite-link">Log out</span></button>
    <div class="sync-bottom-row">
      <button class="sync-reset-btn" data-label="sync-reset">Log out</button>
      <button class="sync-done-btn" data-label="sync-done">Log out</button>
    </div>
    <div class="playlist-title-area">
      <button class="playlist-selection-toggle" data-label="select-all">Log out</button>
    </div>
    <button class="file-select-btn"><div class="btn-icon-bg"></div><span data-label="media-option">Log out</span></button>
    <div class="play-actions-row">
      <div class="play-action-buttons">
        <button class="file-select-btn file-select-btn-large flex-1" id="btn-sync">
          <span class="play-action-sync-content"><svg viewBox="0 0 24 24"></svg><span class="play-action-label" data-label="play-sync">Log out</span></span>
        </button>
        <button class="file-select-btn file-select-btn-large flex-1" id="btn-media-source">
          <span class="play-action-media-content"><svg viewBox="0 0 24 24"></svg><span class="play-action-label" data-label="play-media">Log out</span></span>
          <span class="play-action-stop-content"><svg viewBox="6 6 12 12"></svg><span class="play-action-label" data-label="play-stop" data-danger>Log out</span></span>
        </button>
      </div>
    </div>
    <div class="demo-large-actions">
      <button class="accent-action-btn demo-link-button"><svg viewBox="0 0 24 24"></svg><span data-label="demo-info">Log out</span></button>
      <button class="leave-session-btn demo-exit-button"><svg viewBox="0 0 24 24"></svg><span data-label="demo-exit" data-danger>Log out</span></button>
    </div>
  </main>`;

async function actionLabelStyles(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    // Reduced motion shortens transitions to 0.01ms instead of removing them,
    // so a viewport change that resizes the demo finish pair starts a short
    // font-size transition on its inherited labels. Read the settled values.
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    return [...document.querySelectorAll<HTMLElement>('[data-label]')].map((label) => {
      const css = getComputedStyle(label);
      return {
        label: label.dataset.label,
        fontSize: css.fontSize,
        fontWeight: css.fontWeight,
        lineHeight: css.lineHeight,
        letterSpacing: css.letterSpacing,
        fontFamily: css.fontFamily,
        danger: label.hasAttribute('data-danger') ? css.color : null,
      };
    });
  });
}

for (const mode of [
  { theme: 'dark', direction: 'ltr' },
  { theme: 'light', direction: 'ltr' },
  { theme: 'light', direction: 'rtl' },
] as const) {
  test(`action button labels share one style across responsive layers (${mode.theme} ${mode.direction})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setContent(`<!doctype html>
      <html dir="${mode.direction}" data-theme="${mode.theme}">
        <head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${await compiledActionCss}</style></head>
        <body class="fouc-loaded">${actionLabelMarkup}</body>
      </html>`);

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const label = `${viewport.width}x${viewport.height}`;
      const styles = await actionLabelStyles(page);
      expect(styles, label).toHaveLength(21);
      const family = styles[0]!.fontFamily;
      const compactDemo = viewport.width <= COMPACT_DEMO_MAX_WIDTH;
      for (const style of styles) {
        // The compact play actions keep the 9.0.18 weight and tracking so
        // every locale stays on one line at 320px (button-label-contract);
        // right-to-left labels take no tracking, as in 9.0.18. The demo
        // finish pair keeps 600 in its 13px label up to 420px, where its
        // fixed pills are narrowest.
        const compactPlayAction = COMPACT_PLAY_ACTION_LABELS.includes(style.label ?? '');
        const demoFinish = compactDemo && DEMO_FINISH_LABELS.includes(style.label ?? '');
        const sweptNarrow = compactDemo && SWEPT_NARROW_LABELS.includes(style.label ?? '');
        expect(
          {
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            fontFamily: style.fontFamily,
          },
          `${label} ${style.label}`,
        ).toEqual({
          fontSize: demoFinish ? '13px' : '15px',
          fontWeight: compactPlayAction || demoFinish || sweptNarrow ? '600' : '700',
          lineHeight: demoFinish ? '16.25px' : '18.75px',
          letterSpacing: compactPlayAction && mode.direction === 'ltr' ? '-0.3px' : 'normal',
          fontFamily: family,
        });
      }
      expect(
        styles.filter((style) => style.fontWeight === '600').map((style) => style.label),
        label,
      ).toEqual(
        compactDemo
          ? ['invite-link', 'select-all', ...COMPACT_PLAY_ACTION_LABELS, ...DEMO_FINISH_LABELS]
          : COMPACT_PLAY_ACTION_LABELS,
      );
      // Owner decision (2026-10-27, evening): both default palettes keep the
      // #ff3b30 of 9.0.18.
      expect(
        styles.filter((style) => style.danger !== null).map((style) => style.danger),
        label,
      ).toEqual(Array(4).fill('rgb(255, 59, 48)'));
    }
  });
}

test('destructive labels and surfaces share one red per palette, darker only in light high contrast', async ({
  page,
}) => {
  // Owner decision (2026-10-27, evening): the default palettes keep the reds
  // and tints of 9.0.18; only the high-contrast palettes are tuned. Late
  // evening: account deletion rests, hovers and presses on its 9.0.18 tints
  // in the default palettes, and high contrast keeps its resting tint.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const palette of [
    {
      theme: 'dark',
      contrast: 'normal',
      color: 'rgb(255, 59, 48)',
      surfaces: { remove: [239, 68, 68, 0.1], leave: [255, 59, 48, 0.08] },
      remove: { hover: [239, 68, 68, 0.16], press: [239, 68, 68, 0.2] },
    },
    {
      theme: 'light',
      contrast: 'normal',
      color: 'rgb(255, 59, 48)',
      surfaces: { remove: [239, 68, 68, 0.1], leave: [255, 59, 48, 0.08] },
      remove: { hover: [239, 68, 68, 0.16], press: [239, 68, 68, 0.2] },
    },
    {
      theme: 'dark',
      contrast: 'more',
      color: 'rgb(255, 59, 48)',
      surfaces: { remove: [176, 0, 32, 0.24], leave: [176, 0, 32, 0.24] },
      remove: { hover: [176, 0, 32, 0.24], press: [176, 0, 32, 0.24] },
    },
    {
      theme: 'light',
      contrast: 'more',
      color: 'rgb(164, 0, 29)',
      surfaces: { remove: [176, 0, 32, 0.16], leave: [176, 0, 32, 0.16] },
      remove: { hover: [176, 0, 32, 0.16], press: [176, 0, 32, 0.16] },
    },
  ] as const) {
    const name = `${palette.theme} ${palette.contrast}`;
    await page.setContent(`<!doctype html>
      <html data-theme="${palette.theme}" data-contrast="${palette.contrast}">
        <head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${await compiledActionCss}</style></head>
        <body class="fouc-loaded">${actionLabelMarkup}</body>
      </html>`);
    const styles = await actionLabelStyles(page);
    // Account deletion, leave session, stop sharing and the demo exit.
    expect(
      styles.filter((style) => style.danger !== null).map((style) => style.danger),
      name,
    ).toEqual(Array(4).fill(palette.color));
    const surfaces = await page.evaluate(() => {
      const channels = (color: string) =>
        (/rgba?\(([^)]*)\)/u.exec(color)?.[1] ?? '')
          .split(/[\s,/]+/u)
          .filter(Boolean)
          .map(Number);
      const row = document.querySelector('.play-actions-row')!;
      const probe = document.createElement('span');
      row.appendChild(probe);
      probe.style.backgroundColor = 'var(--play-action-stop-surface)';
      const stop = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        remove: channels(
          getComputedStyle(document.querySelector('.dialog-danger')!).backgroundColor,
        ),
        leave: channels(
          getComputedStyle(document.querySelector('.leave-session-btn')!).backgroundColor,
        ),
        stop: channels(stop),
      };
    });
    for (const [surface, expected] of [
      ['remove', palette.surfaces.remove],
      ['leave', palette.surfaces.leave],
      ['stop', palette.surfaces.leave],
    ] as const) {
      const actual = surfaces[surface];
      expect(actual.slice(0, 3), `${name} ${surface}`).toEqual(expected.slice(0, 3));
      expect(Math.abs(actual[3]! - expected[3]), `${name} ${surface} alpha`).toBeLessThan(0.003);
    }

    // Account deletion through the hover gate: a mouse hover shows the hover
    // tint and a press over it the press tint, while the label keeps the role.
    await page.evaluate(() => document.documentElement.setAttribute('data-hover-pointer', ''));
    const remove = page.locator('.dialog-danger');
    const removeState = () =>
      remove.evaluate((element) => {
        const css = getComputedStyle(element);
        return { background: css.backgroundColor, color: css.color };
      });
    await remove.hover();
    for (const [state, expected] of [
      ['hover', palette.remove.hover],
      ['press', palette.remove.press],
    ] as const) {
      if (state === 'press') await page.mouse.down();
      await expect
        .poll(
          async () => {
            const actual = rgbaChannels((await removeState()).background);
            return (
              actual.slice(0, 3).join(',') === expected.slice(0, 3).join(',') &&
              Math.abs((actual[3] ?? 1) - expected[3]) < 0.003
            );
          },
          { message: `${name} account deletion ${state} surface` },
        )
        .toBe(true);
      expect((await removeState()).color, `${name} account deletion ${state} label`).toBe(
        palette.color,
      );
    }
    await page.mouse.up();
    await page.mouse.move(0, 0);
  }
});

function rgbaChannels(color: string): number[] {
  return (/rgba?\(([^)]*)\)/u.exec(color)?.[1] ?? '')
    .split(/[\s,/]+/u)
    .filter(Boolean)
    .map(Number);
}

test('reduced motion and boot blocking remain authoritative over entrance styles', async ({
  page,
  browserName,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setContent(`<!doctype html><html class="is-booting setup-boot-block">
    <head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${await compiledCss}</style></head><body class="fouc-loaded">
      <header id="main-header" class="app-entrance app-entrance-up app-entered">Header</header>
      <nav class="bottom-nav app-entrance app-entrance-up app-entered" style="--entrance-delay:800ms">
        <button class="nav-item active" aria-selected="true"><svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z" /></svg>Player</button>
      </nav>
      <div class="chat-drawer app-chat-entrance">Chat</div>
    </body></html>`);
  const navigation = page.locator('.bottom-nav');
  await expect(navigation).toHaveCSS('visibility', 'hidden');
  await expect(navigation).toHaveCSS('opacity', '0');
  await expect(navigation).toHaveCSS('pointer-events', 'none');
  await expect(navigation).toHaveCSS('transition-duration', '0s');
  await expect(navigation).toHaveCSS('transition-delay', '0s');
  await expect(page.locator('.chat-drawer')).toHaveCSS('animation-name', 'none');
  await page.evaluate(() => document.documentElement.classList.remove('setup-boot-block'));
  await expect(navigation).toHaveCSS('visibility', 'visible');
  await expect(navigation).toHaveCSS('opacity', '1');
  await expect(navigation).toHaveCSS('transition-duration', '0s');
  if (browserName === 'chromium') {
    // WebKit does not emulate Windows forced colors. In Chromium, compare
    // against the OS palette rather than hard-coding a high-contrast theme.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.emulateMedia({ forcedColors: 'active' });
    const palette = await page.evaluate(() => {
      const probe = document.createElement('div');
      Object.assign(probe.style, {
        backgroundColor: 'Highlight',
        color: 'HighlightText',
        borderColor: 'CanvasText',
        forcedColorAdjust: 'none',
      });
      document.body.append(probe);
      const css = getComputedStyle(probe);
      const colors = {
        highlight: css.backgroundColor,
        highlightText: css.color,
        canvasText: css.borderColor,
      };
      probe.remove();
      return colors;
    });
    const selected = navigation.locator('.nav-item');
    await expect(selected).toHaveCSS('background-color', palette.highlight);
    await expect(selected).toHaveCSS('color', palette.canvasText);
    await expect(selected.locator('svg')).toHaveCSS('fill', palette.highlightText);
  }
});

test('component typography and explicit compact chat sizes survive layout overrides', async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 300 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setContent(`<!doctype html><html>
    <head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${await compiledCss}</style></head><body class="fouc-loaded">
      <div class="setup-header-text"><h2 class="setup-greeting-heading">Welcome</h2></div>
      <div class="help-desc legal-desc"><strong>Privacy</strong><br>Legal information</div>
      <div id="chat-drawer" class="chat-drawer open" data-chat-snap="half">
        <div class="chat-drawer-header">Chat</div>
        <div class="chat-scroll-wrapper"><div class="chat-drawer-messages">Message</div></div>
        <div class="chat-drawer-input"><input aria-label="Message"></div>
      </div>
      <section id="tab-play" class="tab-content active"><div class="tab-body">Player</div></section>
      <section id="tab-playlist" class="tab-content"><div class="tab-body tab-body-anchor">Playlist</div></section>
    </body></html>`);
  await expect(page.locator('.setup-greeting-heading')).toHaveCSS('margin-bottom', '0px');
  await expect(page.locator('.legal-desc')).toHaveCSS('font-size', '12px');
  await expect(page.locator('.legal-desc strong')).toHaveCSS('font-size', '12px');
  expect(
    await page
      .locator('.legal-desc')
      .evaluate((element) => parseFloat(getComputedStyle(element).lineHeight)),
  ).toBeCloseTo(19.2, 2);
  // The compact layout must preserve the user's explicit half/full snap.
  await expect(page.locator('#chat-drawer')).toHaveCSS('height', '150px');
  await page
    .locator('#chat-drawer')
    .evaluate((element) => element.setAttribute('data-chat-snap', 'full'));
  await expect(page.locator('#chat-drawer')).toHaveCSS('height', '300px');
  await page.evaluate(() => document.body.classList.add('has-fake-fullscreen'));
  await expect(page.locator('#tab-play .tab-body')).toHaveCSS('padding-bottom', '44px');
  await expect(page.locator('#tab-playlist .tab-body')).toHaveCSS('height', 'auto');
  await expect(page.locator('#tab-playlist .tab-body')).toHaveCSS('overflow-y', 'auto');
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`actual source modal retains pill controls and protects background focus (${viewport.width})`, async ({
    page,
    browserName,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      // Observe native completion without skipping or changing any transition.
      // The modal's focus is ready before its old snapshot finishes fading.
      const pending = new Set<Promise<void>>();
      Reflect.set(window, '__COMPONENT_CASCADE_TRANSITIONS__', pending);
      if (!document.startViewTransition) return;
      const original = document.startViewTransition.bind(document);
      document.startViewTransition = (...args) => {
        const transition = original(...args);
        pending.add(transition.finished);
        void transition.finished.then(
          () => pending.delete(transition.finished),
          () => pending.delete(transition.finished),
        );
        return transition;
      };
    });
    await injectPeerServer(page);
    await useAnonymousAccountSession(page);
    if (browserName === 'webkit') {
      // Match the WebKit compatibility lane: initialize the real application
      // and its host UI without requiring unsupported PeerJS session setup.
      await page.route('https://static.cloudflareinsights.com/**', (route) =>
        route.fulfill({ contentType: 'application/javascript', body: '' }),
      );
      await page.goto('/');
      await waitForBootstrapReady(page);
      await expect(page.locator('#btn-setup-host')).toBeVisible();
      await page.evaluate(() => {
        document.getElementById('setup-overlay')?.classList.remove('active');
        document.body.classList.remove('overlay-open');
        const setState = Reflect.get(window, '__MUSIXQUARE_SET_STATE__') as
          ((path: string, value: unknown) => void) | undefined;
        setState?.('network.appRole', 'host');
      });
      await expect(page.locator('#btn-media-source')).toHaveAttribute('aria-disabled', 'false');
    } else {
      await setupHostAndStart(page);
    }
    await page.locator('#btn-media-source').focus();
    await page.keyboard.press('Enter');
    const overlay = page.locator('#media-source-overlay');
    await expect(overlay).toHaveClass(/\bactive\b/u);
    await expect(page.locator('#btn-local-file')).toBeFocused();
    for (const id of ['#btn-local-file', '#btn-youtube-source']) {
      await expect(page.locator(id)).toHaveCSS('border-radius', '999px');
    }
    await page.keyboard.press('Tab');
    await expect(page.locator('#btn-youtube-source')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#youtube-url-input')).toBeFocused();
    await expect(page.locator('#btn-yt-cancel')).toHaveCSS('border-radius', '999px');
    expect(
      await page.locator('#btn-media-source').evaluate((button) => {
        button.focus();
        return document.activeElement === button;
      }),
    ).toBe(false);
    await expect(page.locator('#youtube-url-input')).toBeFocused();
    await page.evaluate(async () => {
      const transitions = Reflect.get(window, '__COMPONENT_CASCADE_TRANSITIONS__') as
        Set<Promise<void>> | undefined;
      await Promise.all([...(transitions ?? [])].map((finished) => finished.catch(() => {})));
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await page.screenshot({ path: testInfo.outputPath(`source-modal-${viewport.width}.png`) });
    await page.keyboard.press('Escape');
    await expect(page.locator('#btn-media-source')).toBeFocused();
  });
}
