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
  syncOverlayState,
  initOverlayObservers,
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
    const execCommand = vi.fn(() => {
      expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('test');
      return true;
    });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

    const result = await copyTextToClipboard('test');

    expect(result).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back when the async clipboard API rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

    await expect(copyTextToClipboard('fallback')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('fallback');
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('removes the fallback textarea even when execCommand throws', async () => {
    Object.assign(navigator, { clipboard: undefined });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        throw new Error('copy blocked');
      }),
    });

    await expect(copyTextToClipboard('blocked')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
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

describe('initOverlayObservers', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="setup-overlay"></div>
      <div id="media-source-overlay"></div>
      <div id="youtube-url-overlay"></div>
      <div id="dialog-overlay"></div>
      <div id="manual-sync-overlay"></div>
    `;
    __resetModalStackForTests();
  });

  it('runs without error', () => {
    expect(() => initOverlayObservers()).not.toThrow();
  });

  it('can be called multiple times without error (reinit)', () => {
    initOverlayObservers();
    initOverlayObservers();
  });

  it('toggles body.overlay-open on fullscreen overlay activation', async () => {
    initOverlayObservers();
    expect(document.body.classList.contains('overlay-open')).toBe(false);
    document.getElementById('setup-overlay')!.classList.add('active');
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(document.body.classList.contains('overlay-open')).toBe(true);
  });

  it('does NOT toggle body.overlay-open for the centered dialog overlay', async () => {
    initOverlayObservers();
    document.getElementById('dialog-overlay')!.classList.add('show');
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(document.body.classList.contains('overlay-open')).toBe(false);
  });
});

describe('initOverlayObservers — modal stack', () => {
  // Wait for MutationObserver microtask + a tick for the inert mutations
  // it triggers in turn (the observer modifies sibling attributes, which
  // schedules another microtask round in jsdom).
  const flushObservers = () => new Promise<void>((r) => setTimeout(r, 0));

  beforeEach(() => {
    document.body.innerHTML = `
      <header id="hdr"></header>
      <div id="non-modal"></div>
      <div id="setup-overlay"></div>
      <div id="demo-overlay"></div>
      <div id="media-source-overlay"></div>
      <div id="youtube-url-overlay"></div>
      <div id="dialog-overlay"></div>
      <div id="language-dialog-overlay"></div>
      <div id="manual-sync-overlay"></div>
    `;
    __resetModalStackForTests();
    initOverlayObservers();
  });

  const isInert = (id: string) => document.getElementById(id)!.hasAttribute('inert');

  it('inerts nothing when no modal is shown', () => {
    expect(isInert('hdr')).toBe(false);
    expect(isInert('non-modal')).toBe(false);
    expect(isInert('setup-overlay')).toBe(false);
    expect(isInert('dialog-overlay')).toBe(false);
    expect(isInert('language-dialog-overlay')).toBe(false);
    expect(isInert('manual-sync-overlay')).toBe(false);
  });

  it('inerts everything except setup when setup becomes active', async () => {
    document.getElementById('setup-overlay')!.classList.add('active');
    await flushObservers();
    expect(isInert('hdr')).toBe(true);
    expect(isInert('non-modal')).toBe(true);
    expect(isInert('demo-overlay')).toBe(true);
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

  it('can promote dialog over setup synchronously without waiting for the observer', async () => {
    document.getElementById('setup-overlay')!.classList.add('active');
    await flushObservers();
    expect(isInert('dialog-overlay')).toBe(true);

    document.getElementById('dialog-overlay')!.classList.add('show');
    syncOverlayState();

    expect(isInert('setup-overlay')).toBe(true);
    expect(isInert('dialog-overlay')).toBe(false);
    expect(isInert('hdr')).toBe(true);
  });

  it('keeps dialog interactive over the demo overlay', async () => {
    document.getElementById('demo-overlay')!.classList.add('active');
    await flushObservers();
    document.getElementById('dialog-overlay')!.classList.add('show');
    await flushObservers();

    expect(isInert('demo-overlay')).toBe(true);
    expect(isInert('dialog-overlay')).toBe(false);
    expect(isInert('hdr')).toBe(true);
  });

  it('keeps dialog interactive if demo overlay re-syncs after the dialog opens', async () => {
    document.getElementById('dialog-overlay')!.classList.add('show');
    await flushObservers();
    document.getElementById('demo-overlay')!.classList.add('active');
    await flushObservers();

    expect(isInert('demo-overlay')).toBe(true);
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
    expect(isInert('language-dialog-overlay')).toBe(false);
  });

  it('handles dialog opening with no other modal — only dialog stays interactive', async () => {
    document.getElementById('dialog-overlay')!.classList.add('show');
    await flushObservers();
    expect(isInert('hdr')).toBe(true);
    expect(isInert('non-modal')).toBe(true);
    expect(isInert('setup-overlay')).toBe(true);
    expect(isInert('dialog-overlay')).toBe(false);
  });

  it('treats manual sync as a centered modal without hiding page chrome', () => {
    const manualSyncOverlay = document.getElementById('manual-sync-overlay')!;

    manualSyncOverlay.classList.add('show');
    syncOverlayState('manual-sync-overlay');

    expect(document.body.classList.contains('overlay-open')).toBe(false);
    expect(isInert('manual-sync-overlay')).toBe(false);
    expect(isInert('hdr')).toBe(true);
    expect(isInert('non-modal')).toBe(true);
    expect(manualSyncOverlay.style.zIndex).toBe('6000');
  });

  it('promotes a common dialog over an already open language dialog', () => {
    const languageOverlay = document.getElementById('language-dialog-overlay')!;
    const dialogOverlay = document.getElementById('dialog-overlay')!;

    languageOverlay.classList.add('show');
    syncOverlayState('language-dialog-overlay');
    expect(isInert('language-dialog-overlay')).toBe(false);

    dialogOverlay.classList.add('show');
    syncOverlayState('dialog-overlay');

    expect(isInert('dialog-overlay')).toBe(false);
    expect(isInert('language-dialog-overlay')).toBe(true);
    expect(Number(dialogOverlay.style.zIndex)).toBeGreaterThan(
      Number(languageOverlay.style.zIndex),
    );
  });

  it('keeps the common dialog on top when both centered dialogs appear before observer sync', () => {
    const languageOverlay = document.getElementById('language-dialog-overlay')!;
    const dialogOverlay = document.getElementById('dialog-overlay')!;

    languageOverlay.classList.add('show');
    dialogOverlay.classList.add('show');
    syncOverlayState('dialog-overlay');

    expect(isInert('dialog-overlay')).toBe(false);
    expect(isInert('language-dialog-overlay')).toBe(true);
    expect(Number(dialogOverlay.style.zIndex)).toBeGreaterThan(
      Number(languageOverlay.style.zIndex),
    );
  });

  it('returns the language dialog to top when the common dialog closes', () => {
    const languageOverlay = document.getElementById('language-dialog-overlay')!;
    const dialogOverlay = document.getElementById('dialog-overlay')!;

    languageOverlay.classList.add('show');
    syncOverlayState('language-dialog-overlay');
    dialogOverlay.classList.add('show');
    syncOverlayState('dialog-overlay');

    dialogOverlay.classList.remove('show');
    syncOverlayState();

    expect(isInert('language-dialog-overlay')).toBe(false);
    expect(isInert('dialog-overlay')).toBe(true);
    expect(languageOverlay.style.zIndex).toBe('6000');
    expect(dialogOverlay.style.zIndex).toBe('');
  });
});
