/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STYLE_SOURCE = readFileSync(resolve('css/style.css'), 'utf8');
const INDEX_SOURCE = readFileSync(resolve('index.html'), 'utf8');

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

function createDialogDOM(): void {
  const overlay = document.createElement('div');
  overlay.id = 'dialog-overlay';
  overlay.setAttribute('aria-hidden', 'true');

  const title = document.createElement('h2');
  title.id = 'dialog-title';
  title.dataset.i18n = 'common.info';

  const msg = document.createElement('p');
  msg.id = 'dialog-message';

  const okBtn = document.createElement('button');
  okBtn.id = 'btn-dialog-ok';
  okBtn.dataset.i18n = 'common.ok';
  // jsdom has no layout; expose the button as focusable to the focus trap.
  Object.defineProperty(okBtn, 'offsetParent', { value: overlay, configurable: true });

  const secondaryBtn = document.createElement('button');
  secondaryBtn.id = 'btn-dialog-secondary';
  secondaryBtn.dataset.i18n = 'common.cancel';
  Object.defineProperty(secondaryBtn, 'offsetParent', { value: overlay, configurable: true });

  overlay.appendChild(title);
  overlay.appendChild(msg);
  const actions = document.createElement('div');
  actions.className = 'dialog-actions adaptive-action-group';
  actions.appendChild(secondaryBtn);
  actions.appendChild(okBtn);
  overlay.appendChild(actions);
  document.body.appendChild(overlay);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  createDialogDOM();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Dialog System', () => {
  it('exposes the active dialog to assistive technology when opened above setup', async () => {
    const { initOverlayObservers, syncOverlayState, __resetModalStackForTests } =
      await import('../dom.ts');
    const { showDialog, closeDialog } = await import('../dialog.ts');
    const setup = document.createElement('div');
    setup.id = 'setup-overlay';
    setup.classList.add('active');
    document.body.appendChild(setup);
    __resetModalStackForTests();
    initOverlayObservers();
    const overlay = document.getElementById('dialog-overlay')!;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    const result = showDialog({ title: 'PIN', message: 'Enter PIN' });
    try {
      expect(overlay.classList.contains('show')).toBe(true);
      expect(overlay.hasAttribute('inert')).toBe(false);
      expect(overlay.getAttribute('aria-hidden')).toBe('false');
    } finally {
      closeDialog('close');
      await result;
      setup.classList.remove('active');
      syncOverlayState();
      __resetModalStackForTests();
    }
  });

  it('keeps a dismissed dialog hidden when its covering modal closes later', async () => {
    const { initOverlayObservers, syncOverlayState, __resetModalStackForTests } =
      await import('../dom.ts');
    const { showDialog, closeDialog } = await import('../dialog.ts');
    const language = document.createElement('div');
    language.id = 'language-dialog-overlay';
    language.setAttribute('aria-hidden', 'true');
    document.body.appendChild(language);
    __resetModalStackForTests();
    initOverlayObservers();
    const overlay = document.getElementById('dialog-overlay')!;
    const result = showDialog({ title: 'Audio recovery', message: 'Restore playback' });
    language.classList.add('show');
    language.setAttribute('aria-hidden', 'false');
    syncOverlayState('language-dialog-overlay');
    closeDialog('superseded');
    await result;
    language.classList.remove('show');
    language.setAttribute('aria-hidden', 'true');
    syncOverlayState();
    try {
      expect(overlay.classList.contains('show')).toBe(false);
      expect(overlay.hasAttribute('inert')).toBe(false);
      expect(overlay.getAttribute('aria-hidden')).toBe('true');
    } finally {
      __resetModalStackForTests();
    }
  });

  it('keeps common actions accessible and lets intrinsic text width choose row wrapping', () => {
    const dialogMarkup = INDEX_SOURCE.slice(
      INDEX_SOURCE.indexOf('id="dialog-overlay"'),
      INDEX_SOURCE.indexOf('id="signaling-recovery-overlay"'),
    );
    expect(dialogMarkup).toContain('role="dialog"');
    expect(dialogMarkup).toContain('aria-modal="true"');
    expect(dialogMarkup).toContain('aria-labelledby="dialog-title"');
    expect(dialogMarkup).toContain('aria-describedby="dialog-message"');
    expect(dialogMarkup.indexOf('id="btn-dialog-secondary"')).toBeLessThan(
      dialogMarkup.indexOf('id="btn-dialog-ok"'),
    );
    expect(dialogMarkup).toContain('class="dialog-actions adaptive-action-group"');
    const parsedMarkup = new DOMParser().parseFromString(INDEX_SOURCE, 'text/html');
    expect(
      parsedMarkup
        .getElementById('signaling-recovery-actions')
        ?.classList.contains('adaptive-action-group'),
    ).toBe(true);
    expect(
      parsedMarkup
        .getElementById('btn-administrator-permissions-save')
        ?.parentElement?.classList.contains('adaptive-action-group'),
    ).toBe(true);
    expect(STYLE_SOURCE).toMatch(/\.dialog-message\s*\{[^}]*word-break:\s*keep-all;/s);
    expect(STYLE_SOURCE).toMatch(
      /\.adaptive-action-group\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*align-items:\s*stretch;/s,
    );
    expect(STYLE_SOURCE).toMatch(
      /\.adaptive-action-group\s*>\s*:is\(button, a\):not\(\[hidden\]\)\s*\{[^}]*max-width:\s*100%;[^}]*flex:\s*1 1 max-content;[^}]*white-space:\s*normal;[^}]*hyphens:\s*auto;[^}]*overflow-wrap:\s*normal;[^}]*word-break:\s*keep-all;/s,
    );
    expect(STYLE_SOURCE).toMatch(
      /\.adaptive-action-group\s*>\s*:is\(button, a\):not\(\[hidden\]\):lang\(ja\)[^{]*\{[^}]*overflow-wrap:\s*normal;[^}]*word-break:\s*normal;[^}]*line-break:\s*strict;/s,
    );
    expect(STYLE_SOURCE).not.toMatch(
      /@media \(max-width:\s*420px\)[\s\S]*?\.dialog-actions\s*\{[^}]*flex-direction:/,
    );
    expect(STYLE_SOURCE).not.toMatch(/\.adaptive-action-group\s*\{[^}]*column-reverse;/s);
  });

  it('lets Japanese and Chinese dialog copy break between characters', () => {
    // keep-all forbids breaks between Han characters, so an unpunctuated
    // Chinese clause would stay on one line wider than the dialog.
    const anchor = STYLE_SOURCE.indexOf('html:lang(ja) .dialog-message');
    expect(anchor).toBeGreaterThan(-1);
    const rule = STYLE_SOURCE.slice(
      STYLE_SOURCE.lastIndexOf('}', anchor) + 1,
      STYLE_SOURCE.indexOf('}', anchor),
    );
    for (const lang of ['ja', 'zh-Hans', 'zh-Hant']) {
      expect(rule).toContain(`html:lang(${lang}) .dialog-message`);
    }
    expect(rule).toMatch(/word-break:\s*normal;/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere;/);
    expect(rule).toMatch(/line-break:\s*strict;/);
  });

  it('gives the dialog copy a clear beat on both sides', () => {
    expect(STYLE_SOURCE).toMatch(/\.dialog-header\s*\{[^}]*padding:\s*30px\s+32px\s+8px;/s);
    expect(STYLE_SOURCE).toMatch(/\.dialog-message\s*\{[^}]*padding:\s*8px\s+32px\s+24px;/s);
  });

  describe('showDialog()', () => {
    it('runs the primary activation hook synchronously before resolving', async () => {
      const { showDialog } = await import('../dialog.ts');
      const order: string[] = [];
      const promise = showDialog({
        title: 'Activation',
        onPrimaryActivation: () => order.push('activation'),
      }).then((result) => {
        order.push(`resolved:${result.action}`);
      });

      document.getElementById('btn-dialog-ok')!.click();
      expect(order).toEqual(['activation']);
      await promise;
      expect(order).toEqual(['activation', 'resolved:ok']);
    });

    it.each(['click', 'Enter'])(
      'runs only the selected secondary activation hook synchronously on %s',
      async (gesture) => {
        const { showDialog } = await import('../dialog.ts');
        const order: string[] = [];
        const primary = vi.fn();
        const promise = showDialog({
          title: 'Choose account',
          secondaryText: 'Sign in with another account',
          actionLayout: 'stacked',
          onPrimaryActivation: primary,
          onSecondaryActivation: () => order.push('activation'),
        }).then((result) => {
          order.push(`resolved:${result.action}`);
        });
        const secondary = document.getElementById('btn-dialog-secondary')!;
        if (gesture === 'click') secondary.click();
        else {
          secondary.focus();
          secondary.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
          );
        }
        expect(primary).not.toHaveBeenCalled();
        expect(order).toEqual(['activation']);
        await promise;
        expect(order).toEqual(['activation', 'resolved:secondary']);
      },
    );

    it('keeps primary first in stacked keyboard order and restores the next ordinary dialog', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const controller = new AbortController();
      const onSecondaryActivation = vi.fn();
      const stacked = showDialog({
        title: 'Choose account',
        secondaryText: 'Switch account',
        actionLayout: 'stacked',
        onSecondaryActivation,
        signal: controller.signal,
      });
      const ordinary = showDialog({ title: 'Next', secondaryText: 'Cancel' });
      const actions = document.querySelector('.dialog-actions')!;
      const primary = document.getElementById('btn-dialog-ok')!;
      const secondary = document.getElementById('btn-dialog-secondary')!;
      expect([...actions.children]).toEqual([primary, secondary]);
      expect(actions.classList.contains('dialog-actions-stacked')).toBe(true);

      secondary.focus();
      secondary.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
      expect(document.activeElement).toBe(primary);
      primary.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(document.activeElement).toBe(secondary);

      controller.abort();
      vi.advanceTimersByTime(10);
      await expect(stacked).resolves.toEqual({ action: 'superseded' });
      expect([...actions.children]).toEqual([secondary, primary]);
      expect(actions.classList.contains('dialog-actions-stacked')).toBe(false);
      secondary.click();
      await expect(ordinary).resolves.toEqual({ action: 'secondary' });
      expect(onSecondaryActivation).not.toHaveBeenCalled();
      closeDialog();
    });

    it('still resolves a secondary action when its browser activation hook fails', async () => {
      const { showDialog } = await import('../dialog.ts');
      const promise = showDialog({
        secondaryText: 'Sign in',
        onSecondaryActivation: () => {
          throw new Error('Popup blocked');
        },
      });
      document.getElementById('btn-dialog-secondary')!.click();
      await expect(promise).resolves.toEqual({ action: 'secondary' });
    });

    it('keeps runtime labels through added-node translation and the next ordinary dialog', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      // The real i18n observer translates added elements by their static keys.
      // Match that boundary while this suite keeps its lightweight t() mock.
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            for (const element of [node, ...node.querySelectorAll<HTMLElement>('[data-i18n]')]) {
              const key = element.dataset.i18n;
              if (key) element.textContent = key;
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      try {
        const stacked = showDialog({
          title: 'Register room',
          buttonText: 'Register with this account',
          secondaryText: 'Sign in with another account',
          actionLayout: 'stacked',
        });
        const ordinary = showDialog({
          title: 'Next ordinary dialog',
          secondaryText: 'Keep editing',
        });
        await Promise.resolve();
        expect(document.getElementById('btn-dialog-ok')?.textContent).toBe(
          'Register with this account',
        );
        expect(document.getElementById('btn-dialog-secondary')?.textContent).toBe(
          'Sign in with another account',
        );

        closeDialog('ok');
        await stacked;
        vi.advanceTimersByTime(10);
        await Promise.resolve();
        expect(document.getElementById('dialog-title')?.textContent).toBe('Next ordinary dialog');
        expect(document.getElementById('btn-dialog-ok')?.textContent).toBe('common.ok');
        expect(document.getElementById('btn-dialog-secondary')?.textContent).toBe('Keep editing');
        closeDialog('secondary');
        await expect(ordinary).resolves.toEqual({ action: 'secondary' });
      } finally {
        observer.disconnect();
        closeDialog();
      }
    });

    it('returns a Promise<DialogResult>', async () => {
      const { showDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Test', message: 'Hello' });
      expect(promise).toBeInstanceOf(Promise);

      const { closeDialog } = await import('../dialog.ts');
      closeDialog('ok');
      vi.advanceTimersByTime(10);

      const result = await promise;
      expect(result).toEqual({ action: 'ok' });
    });

    it('shows the overlay', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Test' });
      vi.advanceTimersByTime(10);

      const overlay = document.getElementById('dialog-overlay');
      expect(overlay?.classList.contains('show')).toBe(true);

      closeDialog();
      vi.advanceTimersByTime(10);
      await promise;
    });

    it('sets title and message text', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'My Title', message: 'My Message' });
      vi.advanceTimersByTime(10);

      expect(document.getElementById('dialog-title')?.textContent).toBe('My Title');
      expect(document.getElementById('dialog-message')?.textContent).toBe('My Message');

      closeDialog();
      vi.advanceTimersByTime(10);
      await promise;
    });

    it('handles string input (wraps to message)', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog('Hello World');
      vi.advanceTimersByTime(10);

      expect(document.getElementById('dialog-message')?.textContent).toBe('Hello World');
      expect(document.getElementById('dialog-title')?.textContent).toBe('common.info');

      closeDialog();
      vi.advanceTimersByTime(10);
      await promise;
    });

    it('shows secondary button when secondaryText provided', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Test', secondaryText: 'Cancel' });
      vi.advanceTimersByTime(10);

      const btn = document.getElementById('btn-dialog-secondary') as HTMLButtonElement | null;
      expect(btn?.textContent).toBe('Cancel');
      // Use the `hidden` IDL property — index.html uses the HTML5 `hidden`
      // attribute on the static markup (CSP-friendly), so toggling visibility
      // via `style.display` would no-op (user-agent CSS keeps `display: none`).
      expect(btn?.hidden).toBe(false);

      closeDialog();
      vi.advanceTimersByTime(10);
      await promise;
    });

    it('hides secondary button when no secondaryText', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Test' });
      vi.advanceTimersByTime(10);

      const btn = document.getElementById('btn-dialog-secondary') as HTMLButtonElement | null;
      expect(btn?.hidden).toBe(true);

      closeDialog();
      vi.advanceTimersByTime(10);
      await promise;
    });

    it('returns the edited split PIN and keeps its hint adjacent to the input group', async () => {
      const { showDialog } = await import('../dialog.ts');
      const promise = showDialog({
        title: 'Activate room',
        inputField: {
          placeholder: '8-digit PIN',
          maxLength: 8,
          inputMode: 'numeric',
          splitEvery: 4,
          separator: '-',
          validator: (value) => (value === '00000001' ? 'Choose another PIN' : null),
        },
      });
      vi.advanceTimersByTime(10);

      const group = document.querySelector<HTMLElement>('.dialog-input-split');
      const segments = document.querySelectorAll<HTMLInputElement>('.dialog-input-segment');
      const hint = document.querySelector<HTMLElement>('.dialog-hint');
      expect(group).not.toBeNull();
      expect(segments).toHaveLength(2);
      expect([...segments].every((segment) => segment.dataset.clearable === 'false')).toBe(true);
      expect(group?.nextElementSibling).toBe(hint);

      segments[0]!.value = '8765';
      segments[0]!.dispatchEvent(new Event('input', { bubbles: true }));
      segments[1]!.value = '4321';
      segments[1]!.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-dialog-ok')?.click();
      vi.advanceTimersByTime(10);

      await expect(promise).resolves.toEqual({ action: 'ok', inputValue: '87654321' });
    });

    it('preserves significant whitespace when an input policy asks for it', async () => {
      const { showDialog } = await import('../dialog.ts');
      const validator = vi.fn(() => null);
      const promise = showDialog({
        title: 'Nickname',
        inputField: { validator, preserveWhitespace: true },
      });
      vi.advanceTimersByTime(10);

      const input = document.querySelector<HTMLElement>('.dialog-input');
      expect(input).not.toBeNull();
      input!.textContent = ' Minsu ';
      document.getElementById('btn-dialog-ok')?.click();
      vi.advanceTimersByTime(10);

      expect(validator).toHaveBeenCalledWith(' Minsu ');
      await expect(promise).resolves.toEqual({ action: 'ok', inputValue: ' Minsu ' });
    });

    it('labels editable input and announces validation state through its hint', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({
        title: 'Nickname',
        inputField: {
          placeholder: 'Display name',
          hint: 'Use a recognizable name',
          validator: () => 'Name is unavailable',
        },
      });
      vi.advanceTimersByTime(10);

      const input = document.querySelector<HTMLElement>('.dialog-input')!;
      const hint = document.getElementById('dialog-input-hint')!;
      expect(input.getAttribute('aria-label')).toBe('Display name');
      expect(input.getAttribute('aria-describedby')).toBe(hint.id);
      expect(input.getAttribute('aria-invalid')).toBe('false');
      expect(hint.getAttribute('aria-live')).toBe('polite');
      expect(hint.getAttribute('aria-atomic')).toBe('true');

      input.textContent = 'Taken';
      document.getElementById('btn-dialog-ok')?.click();
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(hint.textContent).toBe('Name is unavailable');

      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(input.getAttribute('aria-invalid')).toBe('false');
      expect(hint.textContent).toBe('Use a recognizable name');

      closeDialog();
      vi.advanceTimersByTime(10);
      await promise;
    });
  });

  describe('closeDialog()', () => {
    it('resolves with specified action', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Test' });
      vi.advanceTimersByTime(10);

      closeDialog('ok');
      vi.advanceTimersByTime(10);

      const result = await promise;
      expect(result.action).toBe('ok');
    });

    it('removes show class from overlay', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Test' });
      vi.advanceTimersByTime(10);

      closeDialog();
      const overlay = document.getElementById('dialog-overlay');
      expect(overlay?.classList.contains('show')).toBe(false);
      vi.advanceTimersByTime(10);
      await promise;
    });
  });

  describe('Dialog Queue', () => {
    it('queues multiple dialogs and drains sequentially', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const results: string[] = [];

      const p1 = showDialog({ title: 'First' }).then((r) => results.push(r.action));
      const p2 = showDialog({ title: 'Second' }).then((r) => results.push(r.action));
      vi.advanceTimersByTime(10);

      expect(document.getElementById('dialog-title')?.textContent).toBe('First');

      closeDialog('ok');
      vi.advanceTimersByTime(10);

      expect(document.getElementById('dialog-title')?.textContent).toBe('Second');

      closeDialog('secondary');
      vi.advanceTimersByTime(10);

      await Promise.all([p1, p2]);
      expect(results).toEqual(['ok', 'secondary']);
    });

    it('cancels only the active dialog bound to an aborted signal', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const controller = new AbortController();
      const first = showDialog({ title: 'Recovery A', signal: controller.signal });
      const second = showDialog({ title: 'Recovery B' });

      controller.abort();
      vi.advanceTimersByTime(10);

      await expect(first).resolves.toEqual({ action: 'superseded' });
      expect(document.getElementById('dialog-title')?.textContent).toBe('Recovery B');
      closeDialog('ok');
      vi.advanceTimersByTime(10);
      await expect(second).resolves.toEqual({ action: 'ok' });
    });

    it('skips an aborted queued dialog without opening it', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const controller = new AbortController();
      const first = showDialog({ title: 'Blocking dialog' });
      const stale = showDialog({ title: 'Stale recovery', signal: controller.signal });
      controller.abort();

      closeDialog('ok');
      vi.advanceTimersByTime(10);

      await expect(first).resolves.toEqual({ action: 'ok' });
      await expect(stale).resolves.toEqual({ action: 'superseded' });
      expect(document.getElementById('dialog-title')?.textContent).not.toBe('Stale recovery');
    });
  });

  describe('DOM Fallback', () => {
    it('falls back to toast when DOM elements missing', async () => {
      document.body.innerHTML = '';

      const { showDialog } = await import('../dialog.ts');
      const { showToast } = await import('../toast.ts');

      const result = await showDialog({ message: 'Fallback test' });
      vi.advanceTimersByTime(10);

      expect(showToast).toHaveBeenCalledWith('Fallback test');
      expect(result.action).toBe('fallback');
    });
  });

  describe('Keyboard Handling', () => {
    it.each([
      { key: 'Enter', isComposing: true, keyCode: 0 },
      { key: 'Enter', isComposing: false, keyCode: 229 },
      { key: 'Escape', isComposing: true, keyCode: 0 },
      { key: 'Escape', isComposing: false, keyCode: 229 },
    ])('keeps IME $key local to composition ($isComposing/$keyCode)', async (options) => {
      const { showDialog } = await import('../dialog.ts');
      const onPrimaryActivation = vi.fn();
      const resolved = vi.fn();
      const promise = showDialog({
        title: 'Rename',
        dismissible: true,
        inputField: { defaultValue: '한' },
        onPrimaryActivation,
      });
      const observed = promise.then(resolved);
      vi.advanceTimersByTime(10);
      const input = document.querySelector('.dialog-input')!;
      const compositionKey = new KeyboardEvent('keydown', {
        ...options,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(compositionKey);
      await Promise.resolve();
      expect(compositionKey.defaultPrevented).toBe(false);
      expect(resolved).not.toHaveBeenCalled();
      expect(onPrimaryActivation).not.toHaveBeenCalled();
      expect(document.getElementById('dialog-overlay')?.classList.contains('show')).toBe(true);

      input.textContent = '한글';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: options.key, bubbles: true }));
      expect(await promise).toEqual({
        action: options.key === 'Enter' ? 'ok' : 'escape',
        inputValue: '한글',
      });
      await observed;
      expect(onPrimaryActivation).toHaveBeenCalledTimes(options.key === 'Enter' ? 1 : 0);
      vi.advanceTimersByTime(10);
    });

    it('Escape closes dismissible dialog', async () => {
      const { showDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Esc Test', dismissible: true });
      vi.advanceTimersByTime(10);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(10);

      const result = await promise;
      expect(result.action).toBe('escape');
    });

    it('Escape does NOT close regular dialogs by default', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      let resolved = false;
      const promise = showDialog({ title: 'Default Esc Test' });
      const observedResolution = promise.then(() => {
        resolved = true;
      });
      vi.advanceTimersByTime(10);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(10);

      expect(resolved).toBe(false);

      closeDialog('ok');
      vi.advanceTimersByTime(10);
      await observedResolution;
    });

    it('Escape does NOT close non-dismissible dialog', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      let resolved = false;
      const promise = showDialog({ title: 'No Esc', dismissible: false });
      const observedResolution = promise.then(() => {
        resolved = true;
      });
      vi.advanceTimersByTime(10);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(10);

      expect(resolved).toBe(false);

      closeDialog('ok');
      vi.advanceTimersByTime(10);
      await observedResolution;
    });
  });

  describe('Deferred focus ownership', () => {
    it.each(['abort', 'close'])('preserves restored focus after immediate %s', async (action) => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const launcher = document.createElement('button');
      document.body.appendChild(launcher);
      launcher.focus();
      const controller = new AbortController();
      const promise = showDialog({ title: 'Pending', signal: controller.signal });
      if (action === 'abort') controller.abort();
      else closeDialog();
      await promise;
      expect(document.activeElement).toBe(launcher);
      vi.advanceTimersByTime(10);
      expect(document.activeElement).toBe(launcher);
    });

    it('ignores an obsolete callback while the successor keeps its default focus', async () => {
      const timers = await import('../../core/timers.ts');
      const timerSpy = vi.spyOn(timers, 'setManagedTimer');
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const first = showDialog({
        title: 'First',
        secondaryText: 'Cancel',
        defaultFocus: 'secondary',
      });
      const oldFocus = timerSpy.mock.calls.find(([name]) => name === 'dialog-focus')![1];
      closeDialog();
      await first;
      const second = showDialog({
        title: 'Second',
        secondaryText: 'Cancel',
        defaultFocus: 'primary',
      });
      vi.advanceTimersByTime(10);
      const ok = document.getElementById('btn-dialog-ok');
      expect(document.activeElement).toBe(ok);
      oldFocus();
      expect(document.activeElement).toBe(ok);
      closeDialog();
      await second;
      vi.advanceTimersByTime(10);
    });
  });
  describe('choiceField', () => {
    const choiceField = {
      legend: 'People in the room now',
      name: 'test-membership',
      defaultValue: 'keep',
      options: [
        { value: 'keep', label: 'Let them stay', detail: 'People connected now can stay.' },
        { value: 'reenter', label: 'Make everyone rejoin', detail: 'Everyone else rejoins.' },
      ],
    };
    const exposeToFocusTrap = (element: Element) =>
      Object.defineProperty(element, 'offsetParent', {
        value: document.getElementById('dialog-overlay'),
        configurable: true,
      });

    it('renders a labelled native radio group and resolves the checked value', async () => {
      const { showDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'PIN', message: 'Set a PIN', choiceField });
      vi.advanceTimersByTime(10);
      const fieldset = document.querySelector('#dialog-message fieldset.dialog-choice')!;
      expect(fieldset.querySelector('legend')?.textContent).toBe('People in the room now');
      const radios = [...fieldset.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
      expect(radios.map((radio) => [radio.name, radio.value, radio.checked])).toEqual([
        ['test-membership', 'keep', true],
        ['test-membership', 'reenter', false],
      ]);
      for (const radio of radios) {
        const label = radio.closest('label')!;
        expect(label.classList.contains('dialog-choice-option')).toBe(true);
        const detail = document.getElementById(radio.getAttribute('aria-describedby')!)!;
        expect(label.contains(detail)).toBe(true);
      }
      expect(radios[1]!.closest('label')!.textContent).toBe(
        'Make everyone rejoinEveryone else rejoins.',
      );
      radios[1]!.click();
      document.getElementById('btn-dialog-ok')!.click();
      expect(await promise).toEqual({
        action: 'ok',
        inputValue: undefined,
        choiceValue: 'reenter',
      });
      vi.advanceTimersByTime(10);
    });

    it('checks the first option when the default is not offered and omits details cleanly', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({
        title: 'Choice',
        choiceField: {
          legend: () => 'Legend',
          name: 'test-fallback',
          defaultValue: 'missing',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        },
      });
      const radios = [...document.querySelectorAll<HTMLInputElement>('.dialog-choice-radio')];
      expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
      expect(radios.every((radio) => !radio.hasAttribute('aria-describedby'))).toBe(true);
      expect(document.querySelectorAll('.dialog-choice-detail')).toHaveLength(0);
      closeDialog('secondary');
      expect(await promise).toEqual({
        action: 'secondary',
        inputValue: undefined,
        choiceValue: 'a',
      });
      vi.advanceTimersByTime(10);
    });

    it('confirms with Enter on a radio only after the input validator passes', async () => {
      const { showDialog } = await import('../dialog.ts');
      const onPrimaryActivation = vi.fn();
      const promise = showDialog({
        title: 'PIN',
        inputField: {
          maxLength: 8,
          splitEvery: 4,
          inputMode: 'numeric',
          validator: (value) => (value.length === 8 ? null : 'invalid PIN'),
        },
        choiceField,
        onPrimaryActivation,
      });
      vi.advanceTimersByTime(10);
      const resolved = vi.fn();
      const observed = promise.then(resolved);
      const radios = [...document.querySelectorAll<HTMLInputElement>('.dialog-choice-radio')];
      radios[1]!.focus();
      radios[1]!.click();
      const early = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      radios[1]!.dispatchEvent(early);
      await Promise.resolve();
      expect(early.defaultPrevented).toBe(true);
      expect(resolved).not.toHaveBeenCalled();
      expect(onPrimaryActivation).not.toHaveBeenCalled();
      expect(document.getElementById('dialog-input-hint')?.textContent).toBe('invalid PIN');

      const segments = [...document.querySelectorAll<HTMLInputElement>('.dialog-input-segment')];
      segments[0]!.value = '1234';
      segments[1]!.value = '5678';
      radios[1]!.focus();
      radios[1]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      expect(await promise).toEqual({
        action: 'ok',
        inputValue: '12345678',
        choiceValue: 'reenter',
      });
      await observed;
      expect(onPrimaryActivation).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(10);
    });

    it('places the checked radio between the input and the actions in the focus trap', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({
        title: 'PIN',
        secondaryText: 'Cancel',
        inputField: { maxLength: 8, splitEvery: 4 },
        choiceField,
      });
      vi.advanceTimersByTime(10);
      const segments = [...document.querySelectorAll<HTMLInputElement>('.dialog-input-segment')];
      const radios = [...document.querySelectorAll<HTMLInputElement>('.dialog-choice-radio')];
      for (const element of [...segments, ...radios]) exposeToFocusTrap(element);
      const ok = document.getElementById('btn-dialog-ok')!;
      const tab = (shiftKey = false) => {
        const event = new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey,
          bubbles: true,
          cancelable: true,
        });
        window.dispatchEvent(event);
        return event;
      };
      expect(document.activeElement).toBe(segments[0]);
      expect(tab(true).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(ok);
      expect(tab().defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(segments[0]);
      // Inside the cycle the browser moves focus natively; the trap stays out.
      radios[0]!.focus();
      expect(tab().defaultPrevented).toBe(false);

      // Without an input, the checked radio opens the cycle.
      closeDialog();
      await promise;
      vi.advanceTimersByTime(10);
      const second = showDialog({ title: 'Choice', secondaryText: 'Cancel', choiceField });
      vi.advanceTimersByTime(10);
      const secondRadios = [...document.querySelectorAll<HTMLInputElement>('.dialog-choice-radio')];
      for (const radio of secondRadios) exposeToFocusTrap(radio);
      secondRadios[1]!.click();
      ok.focus();
      expect(tab().defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(secondRadios[1]);
      expect(tab(true).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(ok);
      closeDialog();
      expect(await second).toMatchObject({ choiceValue: 'reenter' });
      vi.advanceTimersByTime(10);
    });

    it('tears the group down on close and abort so the next dialog has no choice', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const controller = new AbortController();
      const aborted = showDialog({ title: 'Choice', choiceField, signal: controller.signal });
      vi.advanceTimersByTime(10);
      expect(document.querySelector('.dialog-choice')).not.toBeNull();
      controller.abort();
      expect(await aborted).toMatchObject({ action: 'superseded', choiceValue: 'keep' });
      vi.advanceTimersByTime(10);

      const plain = showDialog({ title: 'Plain' });
      vi.advanceTimersByTime(10);
      expect(document.querySelector('.dialog-choice')).toBeNull();
      closeDialog('ok');
      const result = await plain;
      expect(result).toEqual({ action: 'ok', inputValue: undefined });
      expect('choiceValue' in result).toBe(false);
      vi.advanceTimersByTime(10);
    });

    it('styles the group for touch, keyboard focus, and either reading direction', () => {
      const block = (selector: string) => {
        const start = STYLE_SOURCE.indexOf(`${selector} {`);
        expect(start).toBeGreaterThan(-1);
        return STYLE_SOURCE.slice(start, STYLE_SOURCE.indexOf('}', start));
      };
      expect(block('.dialog-choice-option')).toContain('min-block-size: 44px');
      expect(block('.dialog-choice-option')).toContain('padding-inline: 12px');
      expect(block('.dialog-choice-radio')).toContain('accent-color: var(--primary)');
      expect(block('.dialog-choice-radio:focus-visible')).toContain('outline: 2px solid');
      expect(block('.dialog-choice-text')).toContain('text-align: start');
      const choiceRules = STYLE_SOURCE.slice(
        STYLE_SOURCE.indexOf('.dialog-choice {'),
        STYLE_SOURCE.indexOf('.dialog-choice-detail {'),
      );
      expect(choiceRules).not.toMatch(
        /(?:margin|padding)-(?:left|right)|text-align: (?:left|right)/,
      );
    });
  });
});
