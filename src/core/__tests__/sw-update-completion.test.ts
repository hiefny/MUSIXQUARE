// @vitest-environment jsdom

import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANGUAGE_OPTIONS } from '../../i18n/locales.ts';
import activatePendingServiceWorkerForHardReset from '../sw-hard-reset.ts';
import { recordServiceWorkerUpdateCompletion } from '../sw-update-completion.ts';
import { compileClassicRuntimeForBrowserTest } from './classic-runtime-test-asset.ts';

const bootstrapSource = compileClassicRuntimeForBrowserTest('bootstrap.js');

describe('service-worker update completion marker', () => {
  beforeEach(() => {
    sessionStorage.clear();
    document.documentElement.lang = 'en';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(LANGUAGE_OPTIONS)(
    'retains the $code message after bootstrap produces $htmlLang and a waiting worker activates',
    async ({ code, htmlLang }) => {
      // Keep the established message as the expected value; the production
      // bootstrap, rather than this fixture, supplies the actual HTML tag.
      document.documentElement.lang = code;
      recordServiceWorkerUpdateCompletion();
      const expected = sessionStorage.getItem('mxqr-swu');
      const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        runScripts: 'outside-only',
        url: 'https://musixquare.com/',
      });
      try {
        dom.window.localStorage.setItem('musixquare-lang', code);
        dom.window.eval(bootstrapSource);
        expect(dom.window.document.documentElement.lang).toBe(htmlLang);
        vi.stubGlobal('document', dom.window.document);
        vi.stubGlobal('sessionStorage', dom.window.sessionStorage);

        const events = new EventTarget();
        const previousController = {};
        const nextController = {};
        const waitingWorker = {
          state: 'installed',
          postMessage: vi.fn(() => {
            serviceWorkers.controller = nextController;
            events.dispatchEvent(new Event('controllerchange'));
          }),
        };
        const serviceWorkers = Object.assign(events, {
          controller: previousController,
          getRegistration: vi.fn().mockResolvedValue({ waiting: waitingWorker }),
        });
        vi.stubGlobal('navigator', { serviceWorker: serviceWorkers });

        await activatePendingServiceWorkerForHardReset();
        expect(waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(serviceWorkers.controller).toBe(nextController);
        expect(dom.window.sessionStorage.getItem('mxqr-swu')).toBe(expected);
      } finally {
        vi.unstubAllGlobals();
        dom.window.close();
      }
    },
  );

  it('records a native completion message for every supported app language', () => {
    for (const { code } of LANGUAGE_OPTIONS) {
      document.documentElement.lang = code;
      recordServiceWorkerUpdateCompletion();
      const message = sessionStorage.getItem('mxqr-swu');
      expect(message, code).toBeTruthy();
      if (code !== 'en') expect(message, code).not.toBe('Update applied');
    }

    document.documentElement.lang = 'ko';
    recordServiceWorkerUpdateCompletion();
    expect(sessionStorage.getItem('mxqr-swu')).toBe('업데이트가 적용되었어요');
  });

  it('keeps the English fallback for an unsupported document language', () => {
    document.documentElement.lang = 'xx';
    recordServiceWorkerUpdateCompletion();
    expect(sessionStorage.getItem('mxqr-swu')).toBe('Update applied');
  });

  it('does not block the update when session storage is denied', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError');
    });
    expect(() => recordServiceWorkerUpdateCompletion()).not.toThrow();
  });
});
