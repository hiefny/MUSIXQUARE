// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whenAppStylesheetsSettled } from '../app-stylesheet.ts';

// The parser places the app stylesheet in <body>, ahead of the entry module
// (index.html, and the build's render-assets slot). Sheets a script adds later,
// such as the language fonts, go to <head>.
function appStylesheet(applied = false, parent: HTMLElement = document.body): HTMLLinkElement {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/assets/main-deadbeef.css';
  if (applied) Object.defineProperty(link, 'sheet', { value: {} as CSSStyleSheet });
  parent.append(link);
  return link;
}

/** Whether the wait has ended once every queued reaction has run. */
async function hasSettled(wait: Promise<void>): Promise<boolean> {
  let settled = false;
  void wait.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

describe('the bootstrap wait for the app stylesheet', () => {
  beforeEach(() => {
    // The entry module runs while the document is still interactive.
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('interactive');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it('starts at once when the app stylesheet has already applied', async () => {
    appStylesheet(true);

    expect(await hasSettled(whenAppStylesheetsSettled())).toBe(true);
  });

  it.each(['load', 'error'] as const)(
    'holds the bootstrap until the app stylesheet fires %s',
    async (outcome) => {
      const link = appStylesheet();
      const wait = whenAppStylesheetsSettled();

      expect(await hasSettled(wait)).toBe(false);
      link.dispatchEvent(new Event(outcome));
      expect(await hasSettled(wait)).toBe(true);
    },
  );

  it('holds the bootstrap until every app stylesheet has settled', async () => {
    const first = appStylesheet();
    const second = appStylesheet();
    const wait = whenAppStylesheetsSettled();

    first.dispatchEvent(new Event('load'));
    expect(await hasSettled(wait)).toBe(false);
    second.dispatchEvent(new Event('error'));
    expect(await hasSettled(wait)).toBe(true);
  });

  it('starts with the page load when the sheet failed before the wait began', async () => {
    // A sheet that already failed fires nothing more; the page's load event
    // still follows every stylesheet the parser placed.
    appStylesheet();
    const wait = whenAppStylesheetsSettled();

    expect(await hasSettled(wait)).toBe(false);
    window.dispatchEvent(new Event('load'));
    expect(await hasSettled(wait)).toBe(true);
  });

  it('starts at once once the page has loaded', async () => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
    appStylesheet();

    expect(await hasSettled(whenAppStylesheetsSettled())).toBe(true);
  });

  it('never waits for a sheet a script added to the head', async () => {
    appStylesheet(false, document.head);

    expect(await hasSettled(whenAppStylesheetsSettled())).toBe(true);
  });

  it('stops listening once the bootstrap may start', async () => {
    const link = appStylesheet();
    const linkAdd = vi.spyOn(link, 'addEventListener');
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const wait = whenAppStylesheetsSettled();

    link.dispatchEvent(new Event('load'));
    await wait;

    const signals = [...linkAdd.mock.calls, ...windowAdd.mock.calls].map(
      ([, , options]) => (options as AddEventListenerOptions | undefined)?.signal,
    );
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
  });
});
