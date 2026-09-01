// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { LANGUAGE_OPTIONS } from '../../i18n/locales.ts';
import { recordServiceWorkerUpdateCompletion } from '../sw-update-completion.ts';

describe('service-worker update completion marker', () => {
  beforeEach(() => {
    sessionStorage.clear();
    document.documentElement.lang = 'en';
  });

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
});
