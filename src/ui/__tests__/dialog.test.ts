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

  const msg = document.createElement('p');
  msg.id = 'dialog-message';

  const okBtn = document.createElement('button');
  okBtn.id = 'btn-dialog-ok';
  // jsdom has no layout; expose the button as focusable to the focus trap.
  Object.defineProperty(okBtn, 'offsetParent', { value: overlay, configurable: true });

  const secondaryBtn = document.createElement('button');
  secondaryBtn.id = 'btn-dialog-secondary';
  Object.defineProperty(secondaryBtn, 'offsetParent', { value: overlay, configurable: true });

  overlay.appendChild(title);
  overlay.appendChild(msg);
  overlay.appendChild(okBtn);
  overlay.appendChild(secondaryBtn);
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
      /\.adaptive-action-group\s*>\s*:is\(button, a\):not\(\[hidden\]\)\s*\{[^}]*max-width:\s*100%;[^}]*flex:\s*1 1 max-content;[^}]*white-space:\s*normal;[^}]*hyphens:\s*auto;[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*keep-all;/s,
    );
    expect(STYLE_SOURCE).not.toMatch(
      /@media \(max-width:\s*420px\)[\s\S]*?\.dialog-actions\s*\{[^}]*flex-direction:/,
    );
    expect(STYLE_SOURCE).not.toMatch(/\.adaptive-action-group\s*\{[^}]*column-reverse;/s);
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
      showDialog({ title: 'Test' });
      vi.advanceTimersByTime(10);

      const overlay = document.getElementById('dialog-overlay');
      expect(overlay?.classList.contains('show')).toBe(true);

      closeDialog();
      vi.advanceTimersByTime(10);
    });

    it('sets title and message text', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      showDialog({ title: 'My Title', message: 'My Message' });
      vi.advanceTimersByTime(10);

      expect(document.getElementById('dialog-title')?.textContent).toBe('My Title');
      expect(document.getElementById('dialog-message')?.textContent).toBe('My Message');

      closeDialog();
      vi.advanceTimersByTime(10);
    });

    it('handles string input (wraps to message)', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      showDialog('Hello World');
      vi.advanceTimersByTime(10);

      expect(document.getElementById('dialog-message')?.textContent).toBe('Hello World');
      expect(document.getElementById('dialog-title')?.textContent).toBe('common.info');

      closeDialog();
      vi.advanceTimersByTime(10);
    });

    it('shows secondary button when secondaryText provided', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      showDialog({ title: 'Test', secondaryText: 'Cancel' });
      vi.advanceTimersByTime(10);

      const btn = document.getElementById('btn-dialog-secondary') as HTMLButtonElement | null;
      expect(btn?.textContent).toBe('Cancel');
      // Use the `hidden` IDL property — index.html uses the HTML5 `hidden`
      // attribute on the static markup (CSP-friendly), so toggling visibility
      // via `style.display` would no-op (user-agent CSS keeps `display: none`).
      expect(btn?.hidden).toBe(false);

      closeDialog();
      vi.advanceTimersByTime(10);
    });

    it('hides secondary button when no secondaryText', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      showDialog({ title: 'Test' });
      vi.advanceTimersByTime(10);

      const btn = document.getElementById('btn-dialog-secondary') as HTMLButtonElement | null;
      expect(btn?.hidden).toBe(true);

      closeDialog();
      vi.advanceTimersByTime(10);
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
      showDialog({ title: 'Test' });
      vi.advanceTimersByTime(10);

      closeDialog();
      const overlay = document.getElementById('dialog-overlay');
      expect(overlay?.classList.contains('show')).toBe(false);
      vi.advanceTimersByTime(10);
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
      promise.then(() => {
        resolved = true;
      });
      vi.advanceTimersByTime(10);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(10);

      expect(resolved).toBe(false);

      closeDialog('ok');
      vi.advanceTimersByTime(10);
      await promise;
    });

    it('Escape does NOT close non-dismissible dialog', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      let resolved = false;
      const promise = showDialog({ title: 'No Esc', dismissible: false });
      promise.then(() => {
        resolved = true;
      });
      vi.advanceTimersByTime(10);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(10);

      expect(resolved).toBe(false);

      closeDialog('ok');
      vi.advanceTimersByTime(10);
      await promise;
    });
  });
});
