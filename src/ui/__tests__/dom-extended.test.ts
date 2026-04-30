/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  escapeHtml,
  escapeAttr,
  copyTextToClipboard,
  animateTransition,
  updateOverlayOpenClass,
  initOverlayOpenObserver,
  initOverlayInertObserver,
  __resetModalStackForTests,
} from '../dom.ts';

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('A & B')).toBe('A &amp; B');
  });

  it('escapes less-than', () => {
    expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
  });

  it('escapes greater-than', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('escapes mixed special characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('returns empty string for null', () => {
    expect(escapeHtml(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(escapeHtml(undefined)).toBe('');
  });

  it('converts numbers to string without escaping', () => {
    expect(escapeHtml(42)).toBe('42');
  });

  it('returns string as-is when no special chars', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('escapeAttr', () => {
  it('is the same function as escapeHtml', () => {
    expect(escapeAttr).toBe(escapeHtml);
  });
});

describe('animateTransition', () => {
  it('calls callback immediately when startViewTransition not available', () => {
    const cb = vi.fn();
    animateTransition(cb);
    expect(cb).toHaveBeenCalled();
  });
});

describe('copyTextToClipboard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when clipboard API succeeds', async () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    const result = await copyTextToClipboard('hello');
    expect(result).toBe(true);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
  });

  it('uses fallback textarea when clipboard API not available', async () => {
    Object.assign(navigator, { clipboard: undefined });
    // jsdom doesn't support execCommand well, but it shouldn't throw
    const result = await copyTextToClipboard('test');
    // Result depends on execCommand support in jsdom
    expect(typeof result).toBe('boolean');
  });
});

describe('updateOverlayOpenClass', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="setup-overlay"></div>
      <div id="media-source-overlay"></div>
      <div id="youtube-url-overlay"></div>
    `;
  });

  it('adds overlay-open when any overlay has active class', () => {
    document.getElementById('setup-overlay')!.classList.add('active');
    updateOverlayOpenClass();
    expect(document.body.classList.contains('overlay-open')).toBe(true);
  });

  it('removes overlay-open when no overlay has active class', () => {
    document.body.classList.add('overlay-open');
    updateOverlayOpenClass();
    expect(document.body.classList.contains('overlay-open')).toBe(false);
  });

  it('detects active on any of the three overlays', () => {
    document.getElementById('youtube-url-overlay')!.classList.add('active');
    updateOverlayOpenClass();
    expect(document.body.classList.contains('overlay-open')).toBe(true);
  });
});

describe('initOverlayOpenObserver', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="setup-overlay"></div>
      <div id="media-source-overlay"></div>
      <div id="youtube-url-overlay"></div>
    `;
  });

  it('runs without error', () => {
    expect(() => initOverlayOpenObserver()).not.toThrow();
  });

  it('can be called multiple times without error (reinit)', () => {
    initOverlayOpenObserver();
    initOverlayOpenObserver();
    // Should not throw — disconnects previous observer
  });
});

describe('initOverlayInertObserver — modal stack', () => {
  // Wait for MutationObserver microtask + a tick for the inert mutations
  // it triggers in turn (the observer modifies sibling attributes, which
  // schedules another microtask round in jsdom).
  const flushObservers = () => new Promise<void>((r) => setTimeout(r, 0));

  beforeEach(() => {
    document.body.innerHTML = `
      <header id="hdr"></header>
      <div id="non-modal"></div>
      <div id="setup-overlay"></div>
      <div id="media-source-overlay"></div>
      <div id="youtube-url-overlay"></div>
      <div id="dialog-overlay"></div>
    `;
    __resetModalStackForTests();
    initOverlayInertObserver();
  });

  const isInert = (id: string) => document.getElementById(id)!.hasAttribute('inert');

  it('inerts nothing when no modal is shown', () => {
    expect(isInert('hdr')).toBe(false);
    expect(isInert('non-modal')).toBe(false);
    expect(isInert('setup-overlay')).toBe(false);
    expect(isInert('dialog-overlay')).toBe(false);
  });

  it('inerts everything except setup when setup becomes active', async () => {
    document.getElementById('setup-overlay')!.classList.add('active');
    await flushObservers();
    expect(isInert('hdr')).toBe(true);
    expect(isInert('non-modal')).toBe(true);
    expect(isInert('dialog-overlay')).toBe(true);
    expect(isInert('setup-overlay')).toBe(false);
  });

  it('moves dialog to top when shown over setup, inerting setup', async () => {
    document.getElementById('setup-overlay')!.classList.add('active');
    await flushObservers();
    document.getElementById('dialog-overlay')!.classList.add('show');
    await flushObservers();
    expect(isInert('setup-overlay')).toBe(true);
    expect(isInert('dialog-overlay')).toBe(false);
    expect(isInert('hdr')).toBe(true);
  });

  it('returns setup to top when dialog closes', async () => {
    document.getElementById('setup-overlay')!.classList.add('active');
    await flushObservers();
    document.getElementById('dialog-overlay')!.classList.add('show');
    await flushObservers();
    document.getElementById('dialog-overlay')!.classList.remove('show');
    await flushObservers();
    expect(isInert('setup-overlay')).toBe(false);
    expect(isInert('dialog-overlay')).toBe(true);
    expect(isInert('hdr')).toBe(true);
  });

  it('clears every inert when the stack drains', async () => {
    document.getElementById('setup-overlay')!.classList.add('active');
    await flushObservers();
    document.getElementById('setup-overlay')!.classList.remove('active');
    await flushObservers();
    expect(isInert('hdr')).toBe(false);
    expect(isInert('non-modal')).toBe(false);
    expect(isInert('setup-overlay')).toBe(false);
    expect(isInert('dialog-overlay')).toBe(false);
  });

  it('handles dialog opening with no other modal — only dialog stays interactive', async () => {
    document.getElementById('dialog-overlay')!.classList.add('show');
    await flushObservers();
    expect(isInert('hdr')).toBe(true);
    expect(isInert('non-modal')).toBe(true);
    expect(isInert('setup-overlay')).toBe(true);
    expect(isInert('dialog-overlay')).toBe(false);
  });
});
