import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const DEVELOPER_DOC_PATH = '.workshop/developers/developers.html';
const FAQ_PATH = '.workshop/faq/faq.html';
const PRIVACY_PATH = '.workshop/privacy/privacy.html';
const TERMS_PATH = '.workshop/terms/terms.html';
const SCRIPT_PATH = 'public/policy-accordion.js';
const STYLE_PATH = 'public/legal-pages.css';

async function readDocument(path: string, url: string): Promise<JSDOM> {
  return new JSDOM(await readFile(path, 'utf8'), {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url,
  });
}

describe('policy-page accordions', () => {
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
    dom.window.eval(await readFile(SCRIPT_PATH, 'utf8'));

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
