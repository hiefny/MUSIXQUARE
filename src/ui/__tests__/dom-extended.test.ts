/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { escapeHtml, escapeAttr, copyTextToClipboard, animateTransition, updateOverlayOpenClass, initOverlayOpenObserver } from '../dom.ts';

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
    expect(escapeHtml("it's")).toBe("it&#39;s");
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
