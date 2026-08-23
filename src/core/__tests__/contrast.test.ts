/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ContrastModule = typeof import('../contrast.ts');
type MediaListener = (event: MediaQueryListEvent) => void;

const mediaMatches = new Map<string, boolean>();
const mediaListeners = new Map<string, Set<MediaListener>>();

function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => {
      let listeners = mediaListeners.get(query);
      if (!listeners) {
        listeners = new Set<MediaListener>();
        mediaListeners.set(query, listeners);
      }
      const queryListeners = listeners;
      return {
        get matches(): boolean {
          return mediaMatches.get(query) ?? false;
        },
        media: query,
        onchange: null,
        addEventListener: vi.fn((_type: string, listener: MediaListener) => {
          queryListeners.add(listener);
        }),
        removeEventListener: vi.fn((_type: string, listener: MediaListener) => {
          queryListeners.delete(listener);
        }),
        addListener: vi.fn((listener: MediaListener) => {
          queryListeners.add(listener);
        }),
        removeListener: vi.fn((listener: MediaListener) => {
          queryListeners.delete(listener);
        }),
        dispatchEvent: vi.fn(() => false),
      } as MediaQueryList;
    }),
  });
}

function changeMedia(query: string, matches: boolean): void {
  mediaMatches.set(query, matches);
  const event = { matches, media: query } as MediaQueryListEvent;
  mediaListeners.get(query)?.forEach((listener) => listener(event));
}

async function contrastModule(): Promise<ContrastModule> {
  return import('../contrast.ts');
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  localStorage.clear();
  document.documentElement.removeAttribute('data-contrast');
  mediaMatches.clear();
  mediaListeners.clear();
  installMatchMedia();
});

describe('per-device contrast preference', () => {
  it.each([
    ['on', 'more'],
    ['off', 'normal'],
  ] as const)('restores the persisted %s override', async (preference, attribute) => {
    localStorage.setItem('musixquare-contrast', preference);
    const { getContrastStatus, initContrastPreference } = await contrastModule();

    initContrastPreference();

    expect(document.documentElement.getAttribute('data-contrast')).toBe(attribute);
    expect(getContrastStatus().preference).toBe(preference);
  });

  it('defaults invalid or absent storage to attribute-free automatic mode', async () => {
    localStorage.setItem('musixquare-contrast', 'brighter');
    const { getContrastStatus, initContrastPreference } = await contrastModule();

    initContrastPreference();

    expect(document.documentElement.hasAttribute('data-contrast')).toBe(false);
    expect(getContrastStatus().preference).toBe('auto');
  });

  it('reports the live OS preference while automatic CSS remains attribute-free', async () => {
    const query = '(prefers-contrast: more)';
    const { getContrastStatus, initContrastPreference } = await contrastModule();
    initContrastPreference();

    expect(getContrastStatus().authoredContrastActive).toBe(false);
    document.documentElement.setAttribute('data-contrast', 'normal');

    changeMedia(query, true);

    expect(document.documentElement.hasAttribute('data-contrast')).toBe(false);
    expect(getContrastStatus()).toMatchObject({
      preference: 'auto',
      authoredContrastActive: true,
      systemPrefersMore: true,
    });
  });

  it('keeps an explicit off override when the OS preference changes', async () => {
    const query = '(prefers-contrast: more)';
    const { getContrastStatus, initContrastPreference, setContrastPreference } =
      await contrastModule();
    initContrastPreference();
    setContrastPreference('off');

    changeMedia(query, true);

    expect(document.documentElement.getAttribute('data-contrast')).toBe('normal');
    expect(getContrastStatus()).toMatchObject({
      preference: 'off',
      authoredContrastActive: false,
      systemPrefersMore: true,
    });
  });

  it('persists explicit overrides and clears storage when returning to auto', async () => {
    const { setContrastPreference } = await contrastModule();

    setContrastPreference('on');
    expect(localStorage.getItem('musixquare-contrast')).toBe('on');
    expect(document.documentElement.getAttribute('data-contrast')).toBe('more');

    setContrastPreference('auto');
    expect(localStorage.getItem('musixquare-contrast')).toBeNull();
    expect(document.documentElement.hasAttribute('data-contrast')).toBe(false);
  });

  it('keeps an in-page override when localStorage is blocked', async () => {
    const { getContrastStatus, setContrastPreference } = await contrastModule();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked');
    });

    setContrastPreference('on');

    expect(document.documentElement.getAttribute('data-contrast')).toBe('more');
    expect(getContrastStatus().preference).toBe('on');
  });

  it('never turns forced-colors into an authored override', async () => {
    mediaMatches.set('(forced-colors: active)', true);
    const { getContrastStatus, initContrastPreference, setContrastPreference } =
      await contrastModule();
    initContrastPreference();
    setContrastPreference('off');

    expect(document.documentElement.getAttribute('data-contrast')).toBe('normal');
    expect(getContrastStatus()).toMatchObject({
      preference: 'off',
      authoredContrastActive: false,
      forcedColorsActive: true,
    });
  });
});
