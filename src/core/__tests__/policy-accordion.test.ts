import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';

const DEVELOPER_DOC_PATH = '.workshop/developers/developers.html';
const FAQ_PATH = '.workshop/faq/faq.html';
const PRIVACY_PATH = '.workshop/privacy/privacy.html';
const TERMS_PATH = '.workshop/terms/terms.html';
const SITEMAP_PATH = 'public/sitemap.xml';
const STYLE_PATH = 'public/legal-pages.css';

const MONTH_NUMBER: Readonly<Record<string, string>> = Object.freeze({
  January: '01',
  February: '02',
  March: '03',
  April: '04',
  May: '05',
  June: '06',
  July: '07',
  August: '08',
  September: '09',
  October: '10',
  November: '11',
  December: '12',
});

async function readDocument(path: string, url: string): Promise<JSDOM> {
  return new JSDOM(await readFile(path, 'utf8'), {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url,
  });
}

async function policyAccordionRuntime(): Promise<string> {
  const asset = CLASSIC_RUNTIME_ASSETS.find(
    (candidate) => candidate.outputPath === 'policy-accordion.js',
  );
  if (!asset) throw new Error('Classic policy accordion runtime is missing from the manifest.');
  return (await compileClassicRuntimeAsset(resolve('.'), asset)).code;
}

function normalizedPolicyDate(document: Document): string {
  const dateText = document.querySelector('.policy-date')?.textContent?.trim() ?? '';
  const match =
    /^(?:(?:Effective date|Last updated): |API version: v\d+ · Updated )([A-Z][a-z]+) (\d{1,2}), (\d{4})$/u.exec(
      dateText,
    );
  if (!match) throw new Error(`Unrecognized policy date: ${dateText || '<missing>'}`);
  const [, monthName, day, year] = match;
  const month = MONTH_NUMBER[monthName];
  if (!month) throw new Error(`Unrecognized policy month: ${monthName}`);
  return `${year}-${month}-${day.padStart(2, '0')}`;
}

describe('policy-page accordions', () => {
  it('keeps dated public-document metadata aligned with the sitemap', async () => {
    const pages = await Promise.all([
      readDocument(PRIVACY_PATH, 'https://musixquare.com/privacy'),
      readDocument(TERMS_PATH, 'https://musixquare.com/terms'),
      readDocument(FAQ_PATH, 'https://musixquare.com/faq'),
      readDocument(DEVELOPER_DOC_PATH, 'https://musixquare.com/developers'),
    ]);
    const sitemap = new JSDOM(await readFile(SITEMAP_PATH, 'utf8'), {
      contentType: 'application/xml',
    });

    for (const [route, page] of [
      ['/privacy', pages[0]],
      ['/terms', pages[1]],
      ['/faq', pages[2]],
      ['/developers', pages[3]],
    ] as const) {
      const sitemapEntries = Array.from(sitemap.window.document.querySelectorAll('url')).filter(
        (entry) =>
          entry.querySelector('loc')?.textContent?.trim() === `https://musixquare.com${route}`,
      );
      expect(sitemapEntries, route).toHaveLength(1);
      expect(sitemapEntries[0]?.querySelector('lastmod')?.textContent?.trim(), route).toBe(
        normalizedPolicyDate(page.window.document),
      );
    }
  });

  it.each([
    [DEVELOPER_DOC_PATH, 'https://musixquare.com/developers', 11],
    [FAQ_PATH, 'https://musixquare.com/faq', 9],
  ])('uses accessible section-level disclosures in %s', async (path, url, expectedCount) => {
    const dom = await readDocument(path, url);
    const { document } = dom.window;
    const accordions = Array.from(
      document.querySelectorAll<HTMLDetailsElement>(
        'article.policy-doc > details.policy-accordion',
      ),
    );

    expect(accordions).toHaveLength(expectedCount);
    expect(accordions[0]?.open).toBe(true);
    expect(accordions.slice(1).every((accordion) => !accordion.open)).toBe(true);
    expect(new Set(accordions.map((accordion) => accordion.id)).size).toBe(expectedCount);
    expect(accordions.every((accordion) => accordion.id.length > 0)).toBe(true);
    expect(document.querySelector('script[src="/policy-accordion.js"]')).not.toBeNull();

    for (const accordion of accordions) {
      const summary = accordion.firstElementChild;
      expect(summary?.matches('summary.policy-accordion__summary')).toBe(true);
      expect(summary?.querySelector(':scope > h2')).not.toBeNull();
      expect(summary?.querySelector('button')).toBeNull();
      expect(accordion.children.length).toBeGreaterThan(1);
    }
  });

  it('documents the bounded PRO-room AI BOT beta data boundary', async () => {
    const [faq, privacy] = await Promise.all([
      readDocument(FAQ_PATH, 'https://musixquare.com/faq'),
      readDocument(PRIVACY_PATH, 'https://musixquare.com/privacy'),
    ]);
    const aiBot = faq.window.document.querySelector<HTMLDetailsElement>(
      'details#ai-bot-beta.policy-accordion',
    );

    expect(aiBot).not.toBeNull();
    expect(aiBot?.open).toBe(false);

    const disclosure = [
      aiBot?.textContent ?? '',
      privacy.window.document.body.textContent ?? '',
    ].join(' ');
    for (const phrase of [
      'PRO rooms',
      '/bot',
      'Google Gemini API',
      'minimum playlist metadata',
      'stored media URLs',
      'full chat history',
      'API keys',
      'participant lists',
      'sensitive information',
      'allowlist',
    ]) {
      expect(disclosure).toContain(phrase);
    }
    expect(disclosure).not.toContain('000001');
  });

  it('documents optional accounts without overstating account deletion', async () => {
    const [faq, privacy, terms] = await Promise.all([
      readDocument(FAQ_PATH, 'https://musixquare.com/faq'),
      readDocument(PRIVACY_PATH, 'https://musixquare.com/privacy'),
      readDocument(TERMS_PATH, 'https://musixquare.com/terms'),
    ]);
    const faqAccount = faq.window.document.querySelector<HTMLDetailsElement>(
      'details#accounts-and-permissions.policy-accordion',
    );
    expect(faqAccount).not.toBeNull();
    expect(faqAccount?.open).toBe(false);

    const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim();
    const privacyText = normalizeText(privacy.window.document.body.textContent ?? '');
    const termsText = normalizeText(terms.window.document.body.textContent ?? '');
    const faqText = normalizeText(faqAccount?.textContent ?? '');

    for (const phrase of [
      'Google sign-in is optional',
      'OpenID identifier',
      'does not store the email address',
      'HMAC-pseudonymized',
      'Secure, HttpOnly',
      '30 days',
      '10 minutes',
      'room-scoped member identifier',
      'without creating an account',
      'does not decommission a PRO room',
      'separate room-recovery credential',
      'does not automatically delete media',
      'point-in-time recovery',
    ]) {
      expect(privacyText).toContain(phrase);
    }

    for (const phrase of [
      'Google sign-in is optional',
      'without an account',
      'Where account-linked permissions are enabled',
      'ordinary-room grant lasts only while that room exists',
      'signed-in PRO-room grant may remain',
      'anonymous grant ends',
      'account is deleted',
      'does not decommission a PRO room',
      'separate room-recovery credential',
      'accounts, rooms, connections, requests, or technical identifiers',
    ]) {
      expect(termsText).toContain(phrase);
    }

    for (const phrase of [
      'without signing in',
      'does not store the email address or Google tokens',
      'same account on several devices',
      'ordinary-room permission lasts only while the room exists',
      'account or room is deleted',
      'does not decommission a PRO room',
      'separate room-recovery credential',
      'delete media already shared there',
    ]) {
      expect(faqText).toContain(phrase);
    }

    const allPublicCopy = normalizeText(
      `${privacyText} ${termsText} ${faq.window.document.body.textContent ?? ''}`,
    );
    for (const obsolete of [
      'MUSIXQUARE has no account profile',
      'MUSIXQUARE has no user accounts',
      'without paid subscriptions or user accounts',
      'has no paid plan, subscription, or user account',
    ]) {
      expect(allPublicCopy).not.toContain(obsolete);
    }
  });

  it('keeps public data-flow, storage, and media-capability facts aligned with the runtime', async () => {
    const [faq, privacy, terms, authoritySource, preloadSource, accountAuthSource, proRoomSource] =
      await Promise.all([
        readDocument(FAQ_PATH, 'https://musixquare.com/faq'),
        readDocument(PRIVACY_PATH, 'https://musixquare.com/privacy'),
        readDocument(TERMS_PATH, 'https://musixquare.com/terms'),
        readFile('src/rooms/authority.ts', 'utf8'),
        readFile('src/storage/preload.ts', 'utf8'),
        readFile('cloudflare/account-auth.ts', 'utf8'),
        readFile('cloudflare/pro-room-worker.ts', 'utf8'),
      ]);
    const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim();
    const faqText = normalizeText(faq.window.document.body.textContent ?? '');
    const privacyText = normalizeText(privacy.window.document.body.textContent ?? '');
    const termsText = normalizeText(terms.window.document.body.textContent ?? '');
    const [
      appConfig,
      proRoomConfig,
      signalingConfig,
      remoteShareConfig,
      developerConfig,
      facadeConfig,
    ] = await Promise.all(
      [
        'cloudflare/wrangler.app.toml',
        'cloudflare/wrangler.pro-room.toml',
        'cloudflare/wrangler.signaling.toml',
        'cloudflare/wrangler.remote-share.toml',
        'cloudflare/wrangler.developer-api.toml',
        'cloudflare/wrangler.developer-api-facade.toml',
      ].map((path) => readFile(path, 'utf8')),
    );

    expect(privacyText).toContain('Effective date: August 17, 2026');
    expect(termsText).toContain('Effective date: August 17, 2026');
    expect(faqText).toContain('Last updated: August 17, 2026');

    for (const phrase of [
      'Cloudflare D1 databases',
      'Durable Objects',
      'Workers KV',
      'temporary ordinary-room remote-share objects',
      'Secure, HttpOnly, SameSite=Lax',
      'Secure, HttpOnly, SameSite=Strict',
      'localStorage',
      'sessionStorage',
      'CacheStorage',
      'Sampled, credential-free custom Cloudflare Worker logs',
      'Automatic invocation logs that include request URLs',
      'automatic Worker traces are disabled for all six Worker deployments',
      'selected standalone production pages',
      'no query string or fragment',
      'referrer exposes neither a query nor a six-digit room route',
      'main MUSIXQUARE single-page app does not load Web Analytics',
      'up to 400 days',
      'signaling connection opens',
      'paid-provider API access',
      'keyed digest of each one-time voucher code rather than the plaintext code',
      'grant audit and account-deletion fences are append-only',
    ]) {
      expect(privacyText).toContain(phrase);
    }
    expect(termsText).toContain('Google OpenID Connect');
    expect(termsText).toContain('Google Gemini API');
    expect(termsText).toContain('Cloudflare Privacy Policy');

    for (const phrase of [
      'sessions joined, seconds listened, and tracks played',
      'standard-room operator with media-management permission',
      'participant with media-management permission',
      'one-time voucher from an operator-run campaign',
      'when remote delivery is selected',
      'PRO rooms can prefetch',
      'not integrated with MUSIXQUARE',
    ]) {
      expect(faqText).toContain(phrase);
    }
    expect(faqText).not.toContain('Only the host can add local files');
    expect(faqText).not.toContain('Remote preload is not supported');
    expect(faqText).not.toContain('not supported because of their service policies');

    expect(authoritySource).toMatch(
      /STANDARD_OPERATOR_CAPABILITIES[\s\S]*?'media\.add'[\s\S]*?'asset\.upload'/u,
    );
    expect(preloadSource).toContain('preloadRemoteFileIfNeeded');
    expect(preloadSource).toContain('preloadProRoomPlaylistFile');
    expect(preloadSource).toContain('const PRO_ROOM_FILE_PRELOAD_ENABLED = true;');
    expect(accountAuthSource).toContain('HttpOnly; Secure; SameSite=Lax');
    expect(proRoomSource).toContain('const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;');
    expect(proRoomSource).toContain('const OWNER_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;');
    expect(proRoomSource).toContain('HttpOnly; Secure; SameSite=Strict');
    expect(appConfig).toContain('binding = "SORO_IMAGE_BUCKET"');
    expect(appConfig).toContain('binding = "SORO_RSS_BACKUP"');
    expect(appConfig).toContain('database_name = "musixquare-auth"');
    expect(appConfig).toContain('database_name = "musixquare-admin-metrics"');
    expect(appConfig).toContain('database_name = "musixquare-developer-api"');
    expect(proRoomConfig).toContain('binding = "PRO_MEDIA_BUCKET"');
    expect(remoteShareConfig).toContain('binding = "REMOTE_SHARE_BUCKET"');
    expect(remoteShareConfig).toContain('class_name = "RemoteShareQuota"');
    expect(signalingConfig).toContain('class_name = "MusixquareRoom"');
    for (const config of [
      appConfig,
      proRoomConfig,
      signalingConfig,
      remoteShareConfig,
      developerConfig,
      facadeConfig,
    ]) {
      expect(config).toMatch(/\[observability\]\s+enabled = true/u);
      expect(config).toMatch(
        /\[observability\.logs\]\s+enabled = true\s+head_sampling_rate = 0\.1\s+invocation_logs = false/u,
      );
      expect(config).toMatch(/\[observability\.traces\]\s+enabled = false/u);
    }
  });

  it('keeps the public legal-page language, canonical links, contacts, and external links safe', async () => {
    const pages = await Promise.all([
      readDocument(PRIVACY_PATH, 'https://musixquare.com/privacy'),
      readDocument(TERMS_PATH, 'https://musixquare.com/terms'),
      readDocument(FAQ_PATH, 'https://musixquare.com/faq'),
    ]);
    const expectedUrls = [
      'https://musixquare.com/privacy',
      'https://musixquare.com/terms',
      'https://musixquare.com/faq',
    ];

    pages.forEach((page, index) => {
      const { document } = page.window;
      expect(document.documentElement.lang).toBe('en');
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
        expectedUrls[index],
      );
      expect(document.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(
        expectedUrls[index],
      );

      const contact = document.querySelector<HTMLAnchorElement>(
        'a[href="mailto:contact@musixquare.com"][data-copy-email="contact@musixquare.com"]',
      );
      expect(contact?.textContent?.trim()).toBe('contact@musixquare.com');

      for (const link of document.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')) {
        const rel = new Set((link.getAttribute('rel') ?? '').split(/\s+/u).filter(Boolean));
        expect(rel.has('noopener')).toBe(true);
        expect(rel.has('noreferrer')).toBe(true);
      }
    });

    const privacyLinks = new Set(
      Array.from(pages[0].window.document.querySelectorAll<HTMLAnchorElement>('a[href]')).map(
        (link) => link.href,
      ),
    );
    for (const href of [
      'https://www.cloudflare.com/privacypolicy/',
      'https://www.youtube.com/t/terms',
      'https://policies.google.com/privacy',
      'https://security.google.com/settings/security/permissions',
      'https://ai.google.dev/gemini-api/terms',
    ]) {
      expect(privacyLinks.has(href)).toBe(true);
    }
  });

  it('preserves the public errors deep link without changing privacy or terms', async () => {
    const [developers, privacy, terms] = await Promise.all([
      readDocument(DEVELOPER_DOC_PATH, 'https://musixquare.com/developers'),
      readDocument(PRIVACY_PATH, 'https://musixquare.com/privacy'),
      readDocument(TERMS_PATH, 'https://musixquare.com/terms'),
    ]);

    expect(
      developers.window.document.querySelector('details#errors.policy-accordion'),
    ).not.toBeNull();
    for (const document of [privacy.window.document, terms.window.document]) {
      expect(document.querySelector('.policy-accordion')).toBeNull();
      expect(document.querySelector('script[src="/policy-accordion.js"]')).toBeNull();
    }
  });

  it('opens a hash target, preserves other open sections, and keeps the URL shareable', async () => {
    const dom = await readDocument(DEVELOPER_DOC_PATH, 'https://musixquare.com/developers#errors');
    const scrollIntoView = vi.fn();
    dom.window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    dom.window.eval(await policyAccordionRuntime());

    const overview = dom.window.document.querySelector<HTMLDetailsElement>('#overview');
    const errors = dom.window.document.querySelector<HTMLDetailsElement>('#errors');
    expect(overview?.open).toBe(true);
    expect(errors?.open).toBe(true);

    const authentication = dom.window.document.querySelector<HTMLDetailsElement>('#authentication');
    expect(authentication).not.toBeNull();
    if (!authentication || !errors) throw new Error('Expected policy accordions');

    authentication.open = true;
    authentication.dispatchEvent(new dom.window.Event('toggle'));
    expect(dom.window.location.hash).toBe('#authentication');
    expect(errors.open).toBe(true);

    authentication.open = false;
    authentication.dispatchEvent(new dom.window.Event('toggle'));
    expect(dom.window.location.hash).toBe('');
  });

  it('keeps sticky, focus, reduced-motion, and print behavior scoped to accordions', async () => {
    const css = await readFile(STYLE_PATH, 'utf8');

    expect(css).toContain('.policy-accordion[open] > .policy-accordion__summary');
    expect(css).toContain('position: sticky;');
    expect(css).toContain('top: env(safe-area-inset-top, 0px);');
    expect(css).toContain('.policy-accordion__summary:focus-visible');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media print');
    expect(css).toContain('.policy-accordion:not([open]) > :not(.policy-accordion__summary)');
  });

  it('emphasizes only open headings and removes the introductory divider', async () => {
    const css = await readFile(STYLE_PATH, 'utf8');

    expect(css).toContain('.policy-shell:has(> .policy-doc > .policy-accordion) > .policy-hero');
    expect(css).toContain('.policy-doc > .policy-accordion:first-child');
    expect(css).toMatch(
      /\.policy-accordion__summary h2\s*\{[^}]*color: var\(--text-sub\);[^}]*font-weight: 500;/s,
    );
    expect(css).toMatch(
      /\.policy-accordion\[open\] > \.policy-accordion__summary h2\s*\{[^}]*color: var\(--text-main\);[^}]*font-weight: 700;/s,
    );
  });
});
