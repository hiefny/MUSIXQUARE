/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  currentAppPathMatchesLanguage,
  updateLocalizedAppPath,
} from '../localized-app-document.ts';
import { LANGUAGE_OPTIONS, localizedAppEntryPath } from '../locales.ts';

beforeEach(() => {
  window.history.replaceState({ guard: 'locale-matrix' }, '', '/');
  document.head.innerHTML = `
    <link rel="canonical" href="https://musixquare.com/">
    <meta property="og:url" content="https://musixquare.com/">
  `;
});

describe('localized app document URL ownership', () => {
  it('keeps both root aliases and the root canonical for every supported UI locale', () => {
    for (const rootPath of ['/', '/index.html']) {
      for (const option of LANGUAGE_OPTIONS) {
        const historyState = { rootPath, code: option.code };
        window.history.replaceState(historyState, '', `${rootPath}?campaign=matrix#player`);
        const historyLength = window.history.length;

        // A previous room or locale document can leave stale URL metadata behind.
        document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href =
          'https://musixquare.com/123456';
        document.querySelector<HTMLMetaElement>('meta[property="og:url"]')!.content =
          'https://musixquare.com/123456';

        const outcome = updateLocalizedAppPath(option.code);

        expect(window.location.pathname, `${rootPath} → ${option.code}`).toBe(rootPath);
        expect(window.location.search).toBe('?campaign=matrix');
        expect(window.location.hash).toBe('#player');
        expect(window.history.state).toEqual(historyState);
        expect(window.history.length).toBe(historyLength);
        expect(outcome).toBe('unchanged');
        expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href).toBe(
          'https://musixquare.com/',
        );
        expect(document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content).toBe(
          'https://musixquare.com/',
        );
      }
    }
  });

  it('recognizes every explicit locale path while retaining English root ownership', () => {
    for (const option of LANGUAGE_OPTIONS) {
      window.history.replaceState(null, '', localizedAppEntryPath(option.code));
      expect(currentAppPathMatchesLanguage(option.code), option.code).toBe(true);
    }

    for (const rootPath of ['/', '/index.html']) {
      window.history.replaceState(null, '', rootPath);
      expect(currentAppPathMatchesLanguage('en'), rootPath).toBe(true);
      expect(currentAppPathMatchesLanguage('ko'), rootPath).toBe(false);
    }
  });

  it.each([
    '/123456?source=invite#queue',
    '/about?source=nav#history',
    '/constructor/',
    '/__proto__/',
  ])('keeps non-app path %s outside locale ownership for every language', (path) => {
    for (const option of LANGUAGE_OPTIONS) {
      window.history.replaceState(null, '', path);
      expect(updateLocalizedAppPath(option.code), option.code).toBe('unowned');
      expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
        path,
      );
    }
  });
});
