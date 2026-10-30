/**
 * @vitest-environment jsdom
 *
 * Tab and Shift+Tab in the phone and tablet chat sheet move through the
 * controls it shows: the handle, message bubbles, the input and Send, and the
 * pinned notice's two buttons only while the notice shows. The hidden notice
 * stays in the sheet's markup, and neither a browser nor jsdom can focus its
 * buttons, so a cycle that still counted them left Tab on the handle.
 *
 * When the notice hides while one of its buttons has focus (Enter on its X, a
 * withdrawal, a cleared room history, or a withdrawal while its reading dialog
 * is open), focus moves to the sheet itself. A browser otherwise dropped focus
 * to the page, so a screen reader left the Chat dialog; jsdom keeps focus on
 * the hidden button instead, which these tests reject the same way.
 *
 * A message removed while it, or a time link in it, has focus also moves focus
 * to the sheet: a cleared room history, or the oldest rows that the 200-row cap
 * prunes. Removal otherwise dropped focus to the page, in a browser and in jsdom
 * alike.
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
  if (active?.classList.contains('chat-timestamp')) return 'time link';
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

describe('chat sheet focus when the pinned notice hides', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const notice = () => document.getElementById('chat-pinned-notice')!;
  const showRoomNotice = () => bus.emit('chat:notice-message', 'HOST', 'A pinned room notice', 123);
  const showServiceNotice = (id: string) =>
    bus.emit('chat:notice-message', 'MUSIXQUARE', 'A service notice', 123, {
      source: 'service',
      id,
    });

  it('moves focus from the dismissed notice X to the sheet, where Tab starts again', async () => {
    const { addChatMessage } = await import('../chat-render.ts');
    addChatMessage('Peer', 'A message the cycle reaches', false);
    showRoomNotice();
    expect(pressTab(2)).toEqual(['btn-chat-notice-open', 'btn-chat-notice-close']);

    // Enter on the focused X clicks it.
    document.getElementById('btn-chat-notice-close')!.click();
    expect(notice().hidden).toBe(true);
    expect(focusedControl()).toBe('chat-drawer');
    expect(pressTab(3)).toEqual(['handle', 'message', 'chat-input']);
  });

  it.each([
    {
      path: 'withdrawn',
      show: () => showServiceNotice('A'),
      clear: () => bus.emit('chat:service-notice-withdrawn', 'A'),
    },
    {
      path: 'cleared with the room history',
      show: showRoomNotice,
      clear: () => bus.emit('chat:clear-all'),
    },
  ])('moves focus from the open button of a notice $path to the sheet', ({ show, clear }) => {
    show();
    expect(pressTab(1)).toEqual(['btn-chat-notice-open']);

    clear();
    expect(notice().hidden).toBe(true);
    expect(focusedControl()).toBe('chat-drawer');
  });

  it('moves focus to the sheet when a notice is withdrawn while its reading dialog is open', () => {
    // The reading dialog's custom scrollbar needs a ResizeObserver, which jsdom lacks.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    showServiceNotice('A');
    expect(pressTab(1)).toEqual(['btn-chat-notice-open']);
    document.getElementById('btn-chat-notice-open')!.click();
    const overlay = document.getElementById('dialog-overlay')!;
    expect(overlay.classList.contains('show')).toBe(true);

    // Closing, the dialog returns focus to the open button, which the
    // withdrawn notice then hides.
    bus.emit('chat:service-notice-withdrawn', 'A');
    expect(overlay.classList.contains('show')).toBe(false);
    expect(notice().hidden).toBe(true);
    expect(focusedControl()).toBe('chat-drawer');
  });

  it('leaves focus that is outside the notice where it is', () => {
    showServiceNotice('A');
    const input = document.getElementById('chat-input')!;
    input.focus();

    bus.emit('chat:service-notice-withdrawn', 'A');
    expect(notice().hidden).toBe(true);
    expect(document.activeElement).toBe(input);
  });
});

describe('chat sheet focus when the message that holds it is removed', () => {
  const copyableMessages = () => document.querySelectorAll('#chat-messages [data-chat-copy-text]');

  it.each([
    { holder: 'a message', reach: ['message'] },
    { holder: 'a time link in a message', reach: ['message', 'time link'] },
  ])('moves focus from $holder cleared with the room history to the sheet', async ({ reach }) => {
    const { addChatMessage } = await import('../chat-render.ts');
    addChatMessage('Peer', 'Play it again from 1:23', false);
    expect(pressTab(reach.length)).toEqual(reach);

    bus.emit('chat:clear-all');
    expect(copyableMessages()).toHaveLength(0);
    expect(focusedControl()).toBe('chat-drawer');
    // The cleared log keeps only its notice, which takes no focus.
    expect(pressTab(3)).toEqual(['handle', 'chat-input', 'btn-chat-send']);
  });

  it('moves focus from a message pruned at the 200-row cap to the sheet', async () => {
    const { addChatMessage, addSystemChatMessage } = await import('../chat-render.ts');
    addChatMessage('Peer', 'The oldest message', false);
    expect(pressTab(1)).toEqual(['message']);

    // System notices take no focus, and the 200th prunes the oldest row.
    for (let index = 1; index <= 200; index += 1) addSystemChatMessage(`Room notice ${index}`);
    expect(document.querySelectorAll('#chat-messages .chat-row')).toHaveLength(200);
    expect(copyableMessages()).toHaveLength(0);
    expect(focusedControl()).toBe('chat-drawer');
    expect(pressTab(3)).toEqual(['handle', 'chat-input', 'btn-chat-send']);
  });

  it('leaves focus on a message that the cap keeps', async () => {
    const { addChatMessage, addSystemChatMessage } = await import('../chat-render.ts');
    addChatMessage('Peer', 'The oldest message', false);
    for (let index = 1; index <= 198; index += 1) addSystemChatMessage(`Room notice ${index}`);
    addChatMessage('Peer', 'The newest message', false);
    expect(pressTab(2)).toEqual(['message', 'message']);
    const newest = document.activeElement as HTMLElement;
    expect(newest.dataset.chatCopyText).toBe('The newest message');

    addSystemChatMessage('Room notice 199');
    expect(copyableMessages()).toHaveLength(1);
    expect(document.activeElement).toBe(newest);
  });

  it('leaves focus that is outside the cleared messages where it is', async () => {
    const { addChatMessage } = await import('../chat-render.ts');
    addChatMessage('Peer', 'A message the room clears', false);
    const input = document.getElementById('chat-input')!;
    input.focus();

    bus.emit('chat:clear-all');
    expect(copyableMessages()).toHaveLength(0);
    expect(document.activeElement).toBe(input);
  });
});
