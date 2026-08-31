/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  currentAppPathMatchesLanguage,
  updateLocalizedAppPath,
} from '../localized-app-document.ts';
import { LANGUAGE_OPTIONS, localizedAppEntryPath, localizedAppPath } from '../locales.ts';

beforeEach(() => {
  window.history.replaceState({ guard: 'locale-matrix' }, '', '/');
  document.head.innerHTML = `
    <link rel="canonical" href="https://musixquare.com/">
    <meta property="og:url" content="https://musixquare.com/">
  `;
});

describe('localized app document URL ownership', () => {
  it('projects both root aliases across every supported locale without adding history', () => {
    for (const rootPath of ['/', '/index.html']) {
      for (const option of LANGUAGE_OPTIONS) {
        const historyState = { rootPath, code: option.code };
        window.history.replaceState(historyState, '', `${rootPath}?campaign=matrix#player`);
        const historyLength = window.history.length;
        const expectedPath =
          option.code === 'en' ? localizedAppPath('en') : localizedAppEntryPath(option.code);

        const outcome = updateLocalizedAppPath(option.code);

        expect(window.location.pathname, `${rootPath} → ${option.code}`).toBe(expectedPath);
        expect(window.location.search).toBe('?campaign=matrix');
        expect(window.location.hash).toBe('#player');
        expect(window.history.state).toEqual(historyState);
        expect(window.history.length).toBe(historyLength);
        expect(outcome).toBe(rootPath === '/' && option.code === 'en' ? 'unchanged' : 'replaced');
        expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href).toBe(
          `https://musixquare.com${localizedAppPath(option.code)}`,
        );
        expect(document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content).toBe(
          `https://musixquare.com${localizedAppPath(option.code)}`,
        );
      }
    }
  });

  it('recognizes every explicit locale path while retaining English root ownership', () => {
    for (const option of LANGUAGE_OPTIONS) {
      window.history.replaceState(null, '', localizedAppEntryPath(option.code));
      expect(currentAppPathMatchesLanguage(option.code), option.code).toBe(true);
    }

    window.history.replaceState(null, '', '/');
    expect(currentAppPathMatchesLanguage('en')).toBe(true);
  });

  it.each(['/123456?source=invite#queue', '/about?source=nav#history'])(
    'keeps non-app path %s outside locale ownership for every language',
    (path) => {
      for (const option of LANGUAGE_OPTIONS) {
        window.history.replaceState(null, '', path);
        expect(updateLocalizedAppPath(option.code), option.code).toBe('unowned');
        expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
          path,
        );
      }
    },
  );
});
