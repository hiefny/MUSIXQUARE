/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../i18n/index.ts', () => ({ t: vi.fn((key: string) => key) }));
vi.mock('../../i18n/locale-fonts.ts', () => ({
  default: { preloadLocaleFontGlyphs: vi.fn(async () => true) },
}));
vi.mock('../toast.ts', () => ({ showToast: vi.fn() }));
vi.mock('../../youtube/oembed.ts', () => ({ fetchOEmbedTitle: vi.fn(async () => null) }));

let renderer: typeof import('../chat-render.ts');
let dialog: typeof import('../dialog.ts');
let clearAllManagedTimers: typeof import('../../core/timers.ts').clearAllManagedTimers;
const service = (id: string) => ({ source: 'service' as const, id });
const banner = () => document.getElementById('chat-pinned-notice')!;
const overlay = () => document.getElementById('dialog-overlay')!;
const dialogMessage = () => document.getElementById('dialog-message')!;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  document.body.innerHTML = `
    <div id="chat-drawer"></div>
    <div id="chat-messages"></div>
    <div id="chat-pinned-notice" hidden>
      <button id="btn-chat-notice-open" type="button">
        <span id="chat-pinned-notice-label"></span>
        <span id="chat-pinned-notice-time"></span>
        <span id="chat-pinned-notice-text"></span>
      </button>
      <button id="btn-chat-notice-close" type="button">Close</button>
    </div>
    <div id="dialog-overlay" aria-hidden="true">
      <div class="dialog-box" role="dialog">
        <h2 id="dialog-title"></h2>
        <p id="dialog-message"></p>
        <div class="dialog-actions adaptive-action-group">
          <button id="btn-dialog-secondary"></button>
          <button id="btn-dialog-ok"></button>
        </div>
      </div>
    </div>`;
  renderer = await import('../chat-render.ts');
  dialog = await import('../dialog.ts');
  ({ clearAllManagedTimers } = await import('../../core/timers.ts'));
});

afterEach(async () => {
  renderer.clearPinnedNotice();
  dialog.closeDialog('close');
  await vi.runOnlyPendingTimersAsync();
  clearAllManagedTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('pinned notice ownership and full-text dialog', () => {
  it('withdraws only the matching service banner', () => {
    renderer.addNoticeChatMessage('MUSIXQUARE', 'Service A', 123, service('A'));
    renderer.clearPinnedNotice('different');
    expect(banner().hidden).toBe(false);
    renderer.clearPinnedNotice('A');
    expect(banner().hidden).toBe(true);
    expect(banner().classList.contains('notice-attention-hint')).toBe(false);
    renderer.showPinnedNotice();
    expect(overlay().classList.contains('show')).toBe(false);
  });

  it('does not clear a newer room notice, even when its author uses the service name', () => {
    renderer.addNoticeChatMessage('MUSIXQUARE', 'Service A', 123, service('A'));
    renderer.addNoticeChatMessage('MUSIXQUARE', 'Human room notice', 456);
    renderer.clearPinnedNotice('A');
    expect(banner().hidden).toBe(false);
    expect(document.getElementById('chat-pinned-notice-text')?.textContent).toBe(
      'Human room notice',
    );
    renderer.showPinnedNotice();
    expect(dialogMessage().textContent).toBe('Human room notice');
  });

  it('ignores old-ID withdrawal after a new service notice replaces it', () => {
    renderer.addNoticeChatMessage('MUSIXQUARE', 'Service A', 123, service('A'));
    renderer.addNoticeChatMessage('MUSIXQUARE', 'Service B', 456, service('B'));
    renderer.clearPinnedNotice('A');
    expect(banner().hidden).toBe(false);
    expect(document.getElementById('chat-pinned-notice-text')?.textContent).toBe('Service B');
    renderer.clearPinnedNotice('B');
    expect(banner().hidden).toBe(true);
  });

  it('shows complete multiline user text safely and preserves the banner after reading', async () => {
    const sender = '<img src=x onerror=alert(1)>';
    const message = [
      'First line',
      'long text '.repeat(110),
      '<svg onload=alert(2)>',
      'Last line',
    ].join('\n');
    renderer.addNoticeChatMessage(sender, message, 123, service('A'));
    renderer.showPinnedNotice();
    expect(overlay().classList.contains('show')).toBe(true);
    expect(dialogMessage().textContent).toBe(message);
    expect(document.getElementById('dialog-title')?.textContent).toBe(
      `chat.cmd_notice_prefix · \u2068${sender}\u2069`,
    );
    expect(document.querySelector('#chat-pinned-notice img, #chat-pinned-notice svg')).toBeNull();
    expect(document.querySelector('#dialog-overlay img, #dialog-overlay svg')).toBeNull();
    document.getElementById('btn-dialog-ok')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(overlay().classList.contains('show')).toBe(false);
    expect(banner().hidden).toBe(false);
    renderer.showPinnedNotice();
    expect(overlay().classList.contains('show')).toBe(true);
    expect(dialogMessage().textContent).toBe(message);
  });

  it('coalesces repeated open requests instead of queueing duplicate notice dialogs', async () => {
    renderer.addNoticeChatMessage('HOST', 'Only once');
    renderer.showPinnedNotice();
    renderer.showPinnedNotice();
    renderer.showPinnedNotice();
    document.getElementById('btn-dialog-ok')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(overlay().classList.contains('show')).toBe(false);
  });

  it.each(['replacement', 'withdrawal', 'local dismissal'])(
    '%s closes the active notice dialog without closing the unrelated dialog queued behind it',
    async (action) => {
      renderer.addNoticeChatMessage('MUSIXQUARE', 'Service A', 123, service('A'));
      renderer.showPinnedNotice();
      const unrelated = dialog.showDialog({ title: 'Unrelated', message: 'Keep this dialog' });
      if (action === 'replacement') {
        renderer.addNoticeChatMessage('HOST', 'Replacement room notice');
      } else if (action === 'withdrawal') {
        renderer.clearPinnedNotice('A');
      } else {
        renderer.clearPinnedNotice();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(overlay().classList.contains('show')).toBe(true);
      expect(document.getElementById('dialog-title')?.textContent).toBe('Unrelated');
      expect(dialogMessage().textContent).toBe('Keep this dialog');
      dialog.closeDialog('ok');
      await expect(unrelated).resolves.toMatchObject({ action: 'ok' });
    },
  );

  it('cancels a queued notice without closing the active unrelated dialog', async () => {
    const unrelated = dialog.showDialog({ title: 'Unrelated', message: 'Keep this dialog' });
    renderer.addNoticeChatMessage('MUSIXQUARE', 'Queued A', 123, service('A'));
    renderer.showPinnedNotice();
    renderer.clearPinnedNotice('A');
    expect(overlay().classList.contains('show')).toBe(true);
    expect(dialogMessage().textContent).toBe('Keep this dialog');
    dialog.closeDialog('ok');
    await expect(unrelated).resolves.toMatchObject({ action: 'ok' });
    await vi.advanceTimersByTimeAsync(0);
    expect(overlay().classList.contains('show')).toBe(false);
  });

  it('keeps the newer notice dialog owned after the replaced dialog settles', async () => {
    renderer.addNoticeChatMessage('MUSIXQUARE', 'Service A', 123, service('A'));
    renderer.showPinnedNotice();
    renderer.addNoticeChatMessage('MUSIXQUARE', 'Service B', 456, service('B'));
    renderer.showPinnedNotice();
    await vi.advanceTimersByTimeAsync(0);
    renderer.clearPinnedNotice('A');
    expect(dialogMessage().textContent).toBe('Service B');
    expect(overlay().classList.contains('show')).toBe(true);
    renderer.clearPinnedNotice('B');
    expect(overlay().classList.contains('show')).toBe(false);
  });
});
