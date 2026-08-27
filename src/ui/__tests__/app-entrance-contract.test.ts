import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

interface EntranceTarget {
  selector: string;
  direction: string;
  delayMs: number;
  desktopOnly: boolean;
}

let setupSource: string;
let setupSharedSource: string;
let appSource: string;
let appStylesheet: string;
let desktopStylesheet: string;
let appMarkup: string;
let entranceTargets: EntranceTarget[];

beforeAll(() => {
  setupSource = readFileSync(resolve('src/ui/setup.ts'), 'utf8');
  setupSharedSource = readFileSync(resolve('src/ui/setup-shared.ts'), 'utf8');
  appSource = readFileSync(resolve('src/app.ts'), 'utf8');
  appStylesheet = readFileSync(resolve('css/style.css'), 'utf8');
  desktopStylesheet = readFileSync(resolve('css/desktop.css'), 'utf8');
  appMarkup = readFileSync(resolve('index.html'), 'utf8');

  const targetBlock = setupSource.match(/const ENTRANCE_TARGETS:[\s\S]*?= \[([\s\S]*?)\n\];/u)?.[1];
  expect(targetBlock).toBeTruthy();
  entranceTargets = [
    ...(targetBlock ?? '').matchAll(/\['([^']+)', '([^']+)', (\d+)(?:, (true))?\]/gu),
  ].map((match) => ({
    selector: match[1] ?? '',
    direction: match[2] ?? '',
    delayMs: Number(match[3]),
    desktopOnly: match[4] === 'true',
  }));
});

function target(selector: string): EntranceTarget | undefined {
  return entranceTargets.find((candidate) => candidate.selector === selector);
}

describe('app entrance choreography contract', () => {
  it('keeps the app chrome unpainted until onboarding owns the first visible frame', () => {
    const openingHtmlTag = appMarkup.match(/<html\b[^>]*>/u)?.[0] ?? '';
    expect(openingHtmlTag).toContain('class="setup-boot-block"');

    const bootBlockRule = appStylesheet.match(
      /html\.setup-boot-block \.skip-link,\s*html\.setup-boot-block header,\s*html\.setup-boot-block \.tab-content,\s*html\.setup-boot-block \.chat-drawer,\s*html\.setup-boot-block \.bottom-nav\s*\{([^}]*)\}/u,
    )?.[1];
    expect(bootBlockRule).toContain('visibility: hidden !important');
    expect(bootBlockRule).toContain('opacity: 0 !important');
    expect(bootBlockRule).toContain('pointer-events: none !important');
    expect(bootBlockRule).toContain('transition: none !important');
    expect(bootBlockRule).toContain('animation: none !important');

    const showSetupBlock = setupSharedSource.match(
      /export function showSetupOverlay\(\): void \{([\s\S]*?)\n\}/u,
    )?.[1];
    expect(showSetupBlock).toBeTruthy();
    expect(showSetupBlock?.indexOf("ov.classList.add('active')")).toBeGreaterThanOrEqual(0);
    expect(showSetupBlock?.indexOf("classList.remove('setup-boot-block')")).toBeGreaterThan(
      showSetupBlock?.indexOf("ov.classList.add('active')") ?? Number.MAX_SAFE_INTEGER,
    );

    expect(appSource).toMatch(
      /safeInit\('Setup', \(\) => \{[\s\S]*?initSetup\(\);[\s\S]*?catch \(error\) \{[\s\S]*?failOpenSetupBootGuard\(\);[\s\S]*?throw error;/u,
    );
    const failedBootRule = appStylesheet.match(
      /html\.setup-boot-failed \.skip-link,\s*html\.setup-boot-failed header,\s*html\.setup-boot-failed \.tab-content,\s*html\.setup-boot-failed \.chat-drawer,\s*html\.setup-boot-failed \.bottom-nav,\s*html\.setup-boot-failed #setup-overlay\s*\{([^}]*)\}/u,
    )?.[1];
    expect(failedBootRule).toContain('visibility: hidden !important');
    expect(failedBootRule).toContain('opacity: 0 !important');
    expect(failedBootRule).toContain('pointer-events: none !important');
    expect(failedBootRule).toContain('transition: none !important');
    expect(appStylesheet).toMatch(
      /body:has\(> noscript \.noscript-fallback\)\s*\{\s*opacity:\s*1;/u,
    );
    expect(appMarkup).toContain(
      '<noscript><link rel="stylesheet" href="/noscript.css" /></noscript>',
    );
    expect(readFileSync(resolve('public/noscript.css'), 'utf8')).toMatch(
      /body\s*\{[\s\S]*?opacity:\s*1\s*!important;/u,
    );
    expect(appMarkup).toMatch(
      /id="bootstrap-failure"[\s\S]*?role="alert"[\s\S]*?<form method="get">[\s\S]*?<button id="bootstrap-retry" type="submit">/u,
    );
    expect(appStylesheet).toMatch(
      /html\.setup-boot-failed \.bootstrap-failure\s*\{\s*display:\s*flex;/u,
    );
    expect(appStylesheet).toMatch(
      /html\.setup-boot-block body\s*\{[\s\S]*?setup-boot-body-fail-open[\s\S]*?var\(--setup-boot-failure-delay, 15s\)/u,
    );
    expect(appStylesheet).toMatch(
      /html\.setup-boot-block body > \.bootstrap-failure[\s\S]*?setup-boot-failure-reveal[\s\S]*?var\(--setup-boot-failure-delay, 15s\)/u,
    );
    expect(showSetupBlock).toMatch(
      /hasTerminalSetupBootFailure\(\)[\s\S]*?animateTransition\([\s\S]*?hasTerminalSetupBootFailure\(\)[\s\S]*?classList\.add\('active'\)/u,
    );
  });

  it('finishes the visible stagger at exactly 1200ms before buffered cleanup', () => {
    expect(appStylesheet).toMatch(
      /\.app-entrance\s*\{[\s\S]*?opacity 0\.6s[\s\S]*?transform 0\.8s/u,
    );
    expect(Math.max(...entranceTargets.map(({ delayMs }) => delayMs))).toBe(400);
    expect(400 + 800).toBe(1200);
    expect(setupSource).toContain(
      "window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 50 : 1250",
    );
  });

  it('reveals track title and artist separately without moving the marquee itself', () => {
    expect(target('.track-title-wrapper')).toMatchObject({
      direction: 'up',
      delayMs: 100,
      desktopOnly: false,
    });
    expect(target('#track-artist')).toMatchObject({
      direction: 'up',
      delayMs: 150,
      desktopOnly: false,
    });
    expect(target('.track-box')).toBeUndefined();
    expect(target('#track-title')).toBeUndefined();
  });

  it('cascades desktop general settings from top to bottom without moving the shell', () => {
    const expected = [
      ['#tab-settings > .tab-header', 100],
      ['#tab-settings > .settings-subtab-nav', 125],
      ['#settings-language-section', 150],
      ['#theme-section', 230],
      ['#ui-sounds-section', 310],
      ['#settings-sync-section', 400],
    ] as const;

    expect(target('#tab-settings')).toBeUndefined();
    expect(
      entranceTargets
        .filter(
          ({ selector }) => selector.startsWith('#tab-settings') || selector.endsWith('section'),
        )
        .map(({ selector, direction, delayMs, desktopOnly }) => ({
          selector,
          direction,
          delayMs,
          desktopOnly,
        })),
    ).toEqual(
      expected.map(([selector, delayMs]) => ({
        selector,
        direction: 'left',
        delayMs,
        desktopOnly: true,
      })),
    );
    expect(appMarkup).toMatch(/id="settings-language-section"/u);
    expect(desktopStylesheet).toMatch(/#tab-settings > \.tab-body\s*\{\s*overflow-x:\s*hidden;/u);
  });

  it('keeps compact navigation on the same stagger and reduced motion immediate', () => {
    expect(appStylesheet).toMatch(
      /\.bottom-nav\.app-entrance\.app-entrance-up\s*\{[\s\S]*?opacity 0\.6s[\s\S]*?transform 0\.8s[\s\S]*?transition-delay: var\(--entrance-delay, 0ms\) !important;/u,
    );
    expect(appStylesheet).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.app-entrance,[\s\S]*?\.bottom-nav\.app-entrance\.app-entrance-up\s*\{[\s\S]*?transition:\s*none !important;[\s\S]*?transition-delay:\s*0ms !important;/u,
    );
    expect(appStylesheet).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.chat-drawer\.app-chat-entrance\s*\{\s*animation:\s*none !important;/u,
    );
    const bootEntranceRule = appStylesheet.match(
      /html\.is-booting \.app-entrance\s*\{([^}]*)\}/u,
    )?.[1];
    expect(bootEntranceRule).toContain('transform 0.8s');
    expect(bootEntranceRule).not.toMatch(/^\s*opacity:/mu);
  });

  it('reconciles desktop-only targets while onboarding crosses the breakpoint', () => {
    expect(setupSource).toMatch(
      /mqlDesktop\.addEventListener\('change',[\s\S]*?syncDesktopLeftPanel\(\);[\s\S]*?setupEl\('setup-overlay'\)\?\.classList\.contains\('active'\)[\s\S]*?_applyEntranceClasses\(\);/u,
    );
    expect(setupSource).toMatch(
      /if \(desktopOnly && !isDesktop\) \{\s*clearEntranceClasses\(el\);\s*continue;/u,
    );
  });

  it('prepares the reveal for direct invite URLs as well as ordinary onboarding', () => {
    expect(setupSource).toMatch(
      /setPendingAutoJoinCode\(joinCode\);[\s\S]*?_applyEntranceClasses\(\);[\s\S]*?setManagedTimer\([\s\S]*?'auto-join-start',[\s\S]*?showSetupOverlay\(\);[\s\S]*?startGuestFlow\(\);/u,
    );
  });
});
