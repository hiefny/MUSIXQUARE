import { readFile } from 'node:fs/promises';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const SEARCH_TITLE = 'MUSIXQUARE | 뮤직스퀘어, 실시간 음악·영상 동기화';
const SOCIAL_TITLE = 'MUSIXQUARE | Listen Together, In Sync';
const SOCIAL_DESCRIPTION =
  'Turn phones, tablets, and computers into one synchronized music and video experience. No install required.';

interface WebSiteStructuredData {
  readonly '@context': string;
  readonly '@type': string;
  readonly '@id': string;
  readonly url: string;
  readonly name: string;
  readonly alternateName: readonly string[];
}

async function loadHomeDocument(): Promise<Document> {
  const source = await readFile('index.html', 'utf8');
  return new JSDOM(source).window.document;
}

describe('homepage search and social metadata', () => {
  it('keeps the Korean search alias in the title and authored body copy', async () => {
    const document = await loadHomeDocument();

    expect(document.title).toBe(SEARCH_TITLE);
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'MUSIXQUARE connects phones, tablets, and computers for synchronized music and video. 뮤직스퀘어로 여러 기기의 음악과 영상을 실시간 동기화하세요.',
    );
    const visibleAliasOwner = document.querySelector('.setup-role-prompt');
    expect(visibleAliasOwner?.closest('#setup-welcome-header')).not.toBeNull();
    expect(visibleAliasOwner?.textContent).toContain('뮤직스퀘어');
  });

  it('uses English-first Open Graph and Twitter cards without losing the Korean alias', async () => {
    const document = await loadHomeDocument();

    expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(
      SOCIAL_TITLE,
    );
    expect(document.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(
      SOCIAL_DESCRIPTION,
    );
    expect(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')).toBe(
      'MUSIXQUARE',
    );
    expect(document.querySelector('meta[property="og:locale"]')?.getAttribute('content')).toBe(
      'en_US',
    );
    expect(
      document.querySelector('meta[property="og:locale:alternate"]')?.getAttribute('content'),
    ).toBe('ko_KR');
    expect(document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')).toBe(
      SOCIAL_TITLE,
    );
    expect(
      document.querySelector('meta[name="twitter:description"]')?.getAttribute('content'),
    ).toBe(SOCIAL_DESCRIPTION);
  });

  it('declares one canonical WebSite entity with the Korean brand alias', async () => {
    const document = await loadHomeDocument();
    const blocks = document.querySelectorAll<HTMLScriptElement>(
      'script[type="application/ld+json"]',
    );

    expect(blocks).toHaveLength(1);
    const structuredData = JSON.parse(blocks[0]?.textContent ?? '') as WebSiteStructuredData;
    expect(structuredData).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': 'https://musixquare.com/#website',
      url: 'https://musixquare.com/',
      name: 'MUSIXQUARE',
      alternateName: ['뮤직스퀘어', 'musixquare.com'],
    });
  });
});
