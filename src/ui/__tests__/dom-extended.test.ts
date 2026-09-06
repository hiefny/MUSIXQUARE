/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bus } from '../../core/events.ts';
import {
  escapeHtml,
  escapeAttr,
  copyTextToClipboard,
  copyTextToClipboardWithoutFocus,
  animateTransition,
  runWithoutViewTransitions,
  updateOverlayOpenClass,
  syncOverlayState,
  initOverlayObservers,
  __resetModalStackForTests,
  setElementInertForOwner,
  updateTitleWithMarquee,
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

describe('a synchronous first-paint transition scope', () => {
  let descriptor: PropertyDescriptor | undefined;
  let updates: Array<() => void>;
  let nativeTransition: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    descriptor = Object.getOwnPropertyDescriptor(document, 'startViewTransition');
    updates = [];
    nativeTransition = vi.fn((update: () => void) => {
      updates.push(update);
      return {};
    });
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: nativeTransition,
    });
  });

  afterEach(() => {
    if (descriptor) Object.defineProperty(document, 'startViewTransition', descriptor);
    else Reflect.deleteProperty(document, 'startViewTransition');
  });

  it('runs nested setup updates synchronously and leaves later transitions animated', async () => {
    const applied: string[] = [];
    runWithoutViewTransitions(() => {
      animateTransition(() => applied.push('outer-before'));
      runWithoutViewTransitions(() => animateTransition(() => applied.push('inner')));
      animateTransition(() => applied.push('outer-after'));
    });
    expect(applied).toEqual(['outer-before', 'inner', 'outer-after']);
    expect(nativeTransition).not.toHaveBeenCalled();

    animateTransition(() => applied.push('later'));
    await Promise.resolve();
    expect(nativeTransition).toHaveBeenCalledOnce();
    expect(applied).toEqual(['outer-before', 'inner', 'outer-after']);
    updates[0]?.();
    expect(applied).toEqual(['outer-before', 'inner', 'outer-after', 'later']);
  });

  it('restores the outer scope and normal transitions when an inner update throws', async () => {
    const failed = new Error('setup preparation failed');
    const withinOuter = vi.fn();
    expect(() =>
      runWithoutViewTransitions(() => {
        expect(() =>
          runWithoutViewTransitions(() => {
            animateTransition(() => {
              throw failed;
            });
          }),
        ).toThrow(failed);
        animateTransition(withinOuter);
        throw failed;
      }),
    ).toThrow(failed);
    expect(withinOuter).toHaveBeenCalledOnce();
    expect(nativeTransition).not.toHaveBeenCalled();

    const later = vi.fn();
    animateTransition(later);
    await Promise.resolve();
    expect(nativeTransition).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
    updates[0]?.();
    expect(later).toHaveBeenCalledOnce();
  });
});

describe('updateTitleWithMarquee', () => {
  function renderTitle(direction: 'ltr' | 'rtl', text: string): HTMLElement {
    document.body.innerHTML = `
      <div class="track-title-wrapper" dir="auto" style="direction: ${direction}">
        <div id="track-title"></div>
      </div>
    `;
    const wrapper = document.querySelector<HTMLElement>('.track-title-wrapper')!;
    const title = document.getElementById('track-title')!;
    Object.defineProperty(wrapper, 'clientWidth', { configurable: true, value: 160 });
    Object.defineProperty(title, 'scrollWidth', { configurable: true, value: 252 });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    updateTitleWithMarquee(text);
    return title;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('moves an LTR title left by its exact overflow width', () => {
    const title = renderTitle('ltr', 'A uniquely long LTR marquee title');

    expect(title.style.getPropertyValue('--marquee-offset')).toBe('-92px');
    expect(title.style.getPropertyValue('--marquee-duration')).toBe('8.6s');
  });

  it('moves an RTL title right by its exact overflow width', () => {
    const title = renderTitle('rtl', 'عنوان عربي طويل وفريد للاختبار');

    expect(title.style.getPropertyValue('--marquee-offset')).toBe('92px');
    expect(title.style.getPropertyValue('--marquee-duration')).toBe('8.6s');
  });
});

describe('copyTextToClipboard', () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');

  function installClipboard(writeText: ReturnType<typeof vi.fn>): void {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  }

  function installExecCommand(execCommand?: ReturnType<typeof vi.fn>): void {
    if (!execCommand) {
      Reflect.deleteProperty(document, 'execCommand');
      return;
    }
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    window.getSelection()?.removeAllRanges();
  });

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
    if (originalExecCommand) {
      Object.defineProperty(document, 'execCommand', originalExecCommand);
    } else {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });

  it('starts the Async Clipboard fallback in the current event stack', async () => {
    installExecCommand(vi.fn(() => false));
    let inEventStack = true;
    const writeText = vi.fn(() => {
      expect(inEventStack).toBe(true);
      return Promise.resolve();
    });
    installClipboard(writeText);

    const copy = copyTextToClipboard('hello');
    inEventStack = false;
    const result = await copy;

    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('uses the synchronous DOM path before a present Async API that would reject', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    installClipboard(writeText);
    const execCommand = vi.fn(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
      expect(textarea?.value).toBe('fallback');
      expect(document.activeElement).toBe(textarea);
      expect(textarea?.readOnly).toBe(true);
      expect(textarea?.selectionStart).toBe(0);
      expect(textarea?.selectionEnd).toBe('fallback'.length);
      return true;
    });
    installExecCommand(execCommand);

    const result = await copyTextToClipboard('fallback');

    expect(result).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(writeText).not.toHaveBeenCalled();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('returns false without retrying DOM copy after the Async API rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    installClipboard(writeText);
    const order: string[] = [];
    const execCommand = vi.fn(() => {
      order.push('dom');
      return false;
    });
    installExecCommand(execCommand);
    writeText.mockImplementation(() => {
      order.push('async');
      return Promise.reject(new Error('permission denied'));
    });

    await expect(copyTextToClipboard('blocked')).resolves.toBe(false);
    expect(order).toEqual(['dom', 'async']);
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('blocked');
  });

  it('preserves focus', async () => {
    document.body.innerHTML = '<button id="active-control">copy</button>';
    const button = document.getElementById('active-control') as HTMLButtonElement;
    button.focus();

    installClipboard(vi.fn().mockRejectedValue(new Error('must not run')));
    installExecCommand(vi.fn(() => true));

    await expect(copyTextToClipboard('preserve ui')).resolves.toBe(true);

    expect(document.activeElement).toBe(button);
  });

  it('preserves a contenteditable caret selection', async () => {
    document.body.innerHTML = '<div id="editor" contenteditable>abcdef</div>';
    const editor = document.getElementById('editor') as HTMLDivElement;
    const text = editor.firstChild!;
    editor.focus();
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    installClipboard(vi.fn().mockRejectedValue(new Error('must not run')));
    installExecCommand(vi.fn(() => true));

    await expect(copyTextToClipboard('preserve caret')).resolves.toBe(true);

    expect(document.activeElement).toBe(editor);
    expect(selection.toString()).toBe('cd');
    expect(selection.getRangeAt(0).startOffset).toBe(2);
    expect(selection.getRangeAt(0).endOffset).toBe(4);
  });

  it('removes the fallback textarea even when execCommand throws', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    installExecCommand(
      vi.fn(() => {
        throw new Error('copy blocked');
      }),
    );

    await expect(copyTextToClipboard('blocked')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('uses the Clipboard API without changing focus or creating a textarea', async () => {
    document.body.innerHTML = '<div id="editor" contenteditable>draft</div>';
    const editor = document.getElementById('editor') as HTMLDivElement;
    editor.focus();
    const writeText = vi.fn(async () => undefined);
    installClipboard(writeText);
    const execCommand = vi.fn(() => true);
    installExecCommand(execCommand);

    const copy = copyTextToClipboardWithoutFocus('chat text');

    expect(writeText).toHaveBeenCalledWith('chat text');
    expect(document.activeElement).toBe(editor);
    expect(document.querySelector('textarea')).toBeNull();
    await expect(copy).resolves.toBe(true);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('does not fall back to DOM focus when the focus-safe API is missing or rejects', async () => {
    const execCommand = vi.fn(() => true);
    installExecCommand(execCommand);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });

    await expect(copyTextToClipboardWithoutFocus('unavailable')).resolves.toBe(false);

    installClipboard(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')));
    await expect(copyTextToClipboardWithoutFocus('denied')).resolves.toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
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
      <header id="hdr"><button id="background-action"><svg><path id="background-icon"></path></svg>Background</button></header>
      <div id="non-modal"></div>
      <div id="setup-overlay"><button id="setup-hidden" hidden>Hidden</button><button id="setup-action">Setup</button></div>
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

  it('does not release another surface owner when the modal stack drains', () => {
    const header = document.getElementById('hdr')!;
    setElementInertForOwner(header, 'chat-drawer', true);

    document.getElementById('dialog-overlay')!.classList.add('show');
    syncOverlayState('dialog-overlay');
    document.getElementById('dialog-overlay')!.classList.remove('show');
    syncOverlayState();

    expect(header.inert).toBe(true);
    setElementInertForOwner(header, 'chat-drawer', false);
    expect(header.inert).toBe(false);
  });

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
    expect(document.getElementById('hdr')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('contains focus and pointer input when native inert behavior is unavailable', () => {
    const setup = document.getElementById('setup-overlay')!;
    const setupAction = document.getElementById('setup-action') as HTMLButtonElement;
    const backgroundAction = document.getElementById('background-action') as HTMLButtonElement;
    const backgroundClick = vi.fn();
    backgroundAction.addEventListener('click', backgroundClick);

    setup.classList.add('active');
    syncOverlayState('setup-overlay');
    backgroundAction.focus();
    expect(document.activeElement).toBe(setupAction);

    const blockedClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(document.getElementById('background-icon')?.dispatchEvent(blockedClick)).toBe(false);
    expect(backgroundClick).not.toHaveBeenCalled();

    setup.classList.remove('active');
    syncOverlayState();
    expect(document.getElementById('hdr')?.hasAttribute('aria-hidden')).toBe(false);
    backgroundAction.focus();
    expect(document.activeElement).toBe(backgroundAction);
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

  it('reveals overflowing descendants when a hidden overlay is opened explicitly', () => {
    const languageOverlay = document.getElementById('language-dialog-overlay')!;
    const reveal = vi.fn();
    const cleanup = bus.on('ui:scrollbar-reveal', reveal);

    languageOverlay.classList.add('show');
    syncOverlayState('language-dialog-overlay');

    expect(reveal).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledWith(languageOverlay);
    cleanup();
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
