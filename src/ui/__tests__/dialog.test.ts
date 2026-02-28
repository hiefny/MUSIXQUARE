/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────

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
  // offsetParent needed for focus trap
  Object.defineProperty(okBtn, 'offsetParent', { value: overlay, configurable: true });

  const secondaryBtn = document.createElement('button');
  secondaryBtn.id = 'btn-dialog-secondary';
  Object.defineProperty(secondaryBtn, 'offsetParent', { value: overlay, configurable: true });

  const closeBtn = document.createElement('button');
  closeBtn.id = 'btn-dialog-close';
  Object.defineProperty(closeBtn, 'offsetParent', { value: overlay, configurable: true });

  overlay.appendChild(title);
  overlay.appendChild(msg);
  overlay.appendChild(okBtn);
  overlay.appendChild(secondaryBtn);
  overlay.appendChild(closeBtn);
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

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Dialog System', () => {
  describe('showDialog()', () => {
    it('returns a Promise<DialogResult>', async () => {
      const { showDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Test', message: 'Hello' });
      expect(promise).toBeInstanceOf(Promise);

      // Close it to resolve
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

      const btn = document.getElementById('btn-dialog-secondary');
      expect(btn?.textContent).toBe('Cancel');
      expect(btn?.style.display).not.toBe('none');

      closeDialog();
      vi.advanceTimersByTime(10);
    });

    it('hides secondary button when no secondaryText', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      showDialog({ title: 'Test' });
      vi.advanceTimersByTime(10);

      const btn = document.getElementById('btn-dialog-secondary');
      expect(btn?.style.display).toBe('none');

      closeDialog();
      vi.advanceTimersByTime(10);
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

      const p1 = showDialog({ title: 'First' }).then(r => results.push(r.action));
      const p2 = showDialog({ title: 'Second' }).then(r => results.push(r.action));
      vi.advanceTimersByTime(10);

      // First dialog is active
      expect(document.getElementById('dialog-title')?.textContent).toBe('First');

      // Close first → should show second
      closeDialog('ok');
      vi.advanceTimersByTime(10);

      expect(document.getElementById('dialog-title')?.textContent).toBe('Second');

      // Close second
      closeDialog('secondary');
      vi.advanceTimersByTime(10);

      await Promise.all([p1, p2]);
      expect(results).toEqual(['ok', 'secondary']);
    });
  });

  describe('DOM Fallback', () => {
    it('falls back to toast when DOM elements missing', async () => {
      document.body.innerHTML = ''; // Remove all dialog elements

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

    it('Escape does NOT close non-dismissible dialog', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      let resolved = false;
      const promise = showDialog({ title: 'No Esc', dismissible: false });
      promise.then(() => { resolved = true; });
      vi.advanceTimersByTime(10);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(10);

      expect(resolved).toBe(false);

      // Clean up
      closeDialog('ok');
      vi.advanceTimersByTime(10);
      await promise;
    });
  });

  describe('Module Exports', () => {
    it('exports showDialog, closeDialog, initDialog', async () => {
      const mod = await import('../dialog.ts');
      expect(typeof mod.showDialog).toBe('function');
      expect(typeof mod.closeDialog).toBe('function');
      expect(typeof mod.initDialog).toBe('function');
    });
  });
});
