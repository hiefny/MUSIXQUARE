/**
 * @vitest-environment jsdom
 *
 * Tab and Shift+Tab in the phone and tablet chat sheet move through the
 * controls it shows: the handle, message bubbles, the input and Send, and the
 * pinned notice's two buttons only while the notice shows. The hidden notice
 * stays in the sheet's markup, and neither a browser nor jsdom can focus its
 * buttons, so a cycle that still counted them left Tab on the handle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resetState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../network/peer.ts', () => ({ broadcast: vi.fn(), sendToHost: vi.fn() }));
vi.mock('../player-controls.ts', () => ({
  getRoleLabelByChannelMode: vi.fn(() => 'Left'),
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
}));
vi.mock('../../player/transport.ts', () => ({ seekTo: vi.fn() }));
vi.mock('../../youtube/oembed.ts', () => ({ fetchOEmbedTitle: vi.fn(async () => 'Mock Title') }));
vi.mock('../../i18n/locale-fonts.ts', () => ({
  default: { preloadLocaleFontGlyphs: vi.fn(async () => true) },
}));

function focusedControl(): string {
  const active = document.activeElement;
  if (active?.classList.contains('chat-drawer-header')) return 'handle';
  if (active?.classList.contains('chat-bubble')) return 'message';
  return active?.id ?? '';
}

function pressTab(count: number, shiftKey = false): string[] {
  return Array.from({ length: count }, () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }),
    );
    return focusedControl();
  });
}

beforeEach(async () => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  document.body.innerHTML = new DOMParser().parseFromString(
    readFileSync('index.html', 'utf8'),
    'text/html',
  ).body.innerHTML;
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
  document.documentElement.style.setProperty('--app-height', '844px');
  const { initChat, toggleChatDrawer } = await import('../chat.ts');
  initChat();
  // Opened from the keyboard, the sheet starts at its handle.
  toggleChatDrawer();
});

afterEach(async () => {
  const { toggleChatDrawer } = await import('../chat.ts');
  if (document.getElementById('chat-drawer')?.classList.contains('open')) toggleChatDrawer();
  clearAllManagedTimers();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty('--app-height');
});

describe('chat sheet Tab cycle', () => {
  it('skips the hidden pinned notice: handle, message, input and Send', async () => {
    const { addChatMessage } = await import('../chat-render.ts');
    addChatMessage('Peer', 'A message the cycle reaches', false);
    expect(document.getElementById('chat-drawer')?.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById('chat-pinned-notice')?.hidden).toBe(true);
    expect(focusedControl()).toBe('handle');

    expect(pressTab(4)).toEqual(['message', 'chat-input', 'btn-chat-send', 'handle']);
    expect(pressTab(4, true)).toEqual(['btn-chat-send', 'chat-input', 'message', 'handle']);
  });

  it('adds the notice buttons after the handle only while the notice shows', () => {
    const notice = document.getElementById('chat-pinned-notice')!;
    bus.emit('chat:notice-message', 'HOST', 'A pinned room notice', 123);
    expect(notice.hidden).toBe(false);

    expect(pressTab(5)).toEqual([
      'btn-chat-notice-open',
      'btn-chat-notice-close',
      'chat-input',
      'btn-chat-send',
      'handle',
    ]);
    expect(pressTab(5, true)).toEqual([
      'btn-chat-send',
      'chat-input',
      'btn-chat-notice-close',
      'btn-chat-notice-open',
      'handle',
    ]);

    // Dismissed, the notice leaves the cycle again.
    document.getElementById('btn-chat-notice-close')!.click();
    expect(notice.hidden).toBe(true);
    expect(pressTab(3)).toEqual(['chat-input', 'btn-chat-send', 'handle']);
  });
});
