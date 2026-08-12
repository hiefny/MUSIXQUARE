/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { sendToHost } from '../../network/peer.ts';
import type { DataConnection } from '../../types/index.ts';
import { showToast } from '../toast.ts';

interface ProRealtimeTestPayload {
  kind?: string;
  text?: string;
  botRequestId?: string;
}

const requestActiveProRoomBotCommand = vi.hoisted(() => vi.fn());
const proRealtimeMocks = vi.hoisted(() => ({
  send: vi.fn<(channel: string, payload: ProRealtimeTestPayload) => boolean>(() => true),
}));
const botProtocolMocks = vi.hoisted(() => ({
  beginLocalBotChatRequest: vi.fn(() => true),
  publishBotChatResult: vi.fn(() => true),
  rememberPinnedNotice: vi.fn(),
}));
const userTextFontMocks = vi.hoisted(() => ({
  preloadLocaleFontGlyphs: vi.fn(async () => true),
}));

window.matchMedia =
  window.matchMedia ||
  vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../i18n/locale-fonts.ts', () => ({
  preloadLocaleFontGlyphs: userTextFontMocks.preloadLocaleFontGlyphs,
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  sendToHost: vi.fn(),
}));

vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn(),
}));

vi.mock('../../chat/protocol.ts', () => ({
  beginLocalBotChatRequest: botProtocolMocks.beginLocalBotChatRequest,
  publishBotChatResult: botProtocolMocks.publishBotChatResult,
  rememberPinnedNotice: botProtocolMocks.rememberPinnedNotice,
  clearLatestPinnedNotice: vi.fn(),
  registerChatProtocolHandlers: vi.fn(),
}));

vi.mock('../../pro-room/runtime.ts', () => ({
  requestActiveProRoomBotCommand,
}));

vi.mock('../../pro-room/network-bridge.ts', () => ({
  sendProRoomRealtime: proRealtimeMocks.send,
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
}));

vi.mock('../player-controls.ts', () => ({
  getRoleLabelByChannelMode: vi.fn(() => 'Left'),
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
}));

// Chat title timers call the oEmbed leaf directly; isolate them from network
// access and from timers that could outlive a test.
vi.mock('../../youtube/oembed.ts', () => ({
  fetchOEmbedTitle: vi.fn(async () => 'Mock Title'),
}));

function expectFontClasses(element: Element | null | undefined, ...classes: string[]): void {
  expect(element).not.toBeNull();
  for (const className of classes) {
    expect(element?.classList.contains(className)).toBe(true);
  }
}

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  requestActiveProRoomBotCommand.mockReset();
  proRealtimeMocks.send.mockReset();
  proRealtimeMocks.send.mockReturnValue(true);
  botProtocolMocks.beginLocalBotChatRequest.mockReturnValue(true);
  document.body.innerHTML = '';
});

afterEach(() => {
  clearAllManagedTimers();
  vi.restoreAllMocks();
});

describe('Chat Module', () => {
  it('installs bubble copy gestures when the desktop chat starts already visible', async () => {
    const desktopMedia = window.matchMedia('(min-width: 1280px)');
    Object.defineProperty(desktopMedia, 'matches', { configurable: true, value: true });
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    document.body.innerHTML = `
      <div id="chat-drawer">
        <div id="chat-messages"><span id="chat-copy-hint"></span><div class="chat-empty"></div></div>
      </div>
    `;

    try {
      const [{ initChat }, { addChatMessage }] = await Promise.all([
        import('../chat.ts'),
        import('../chat-render.ts'),
      ]);
      initChat();

      addChatMessage('Peer', 'desktop copy', false);
      document
        .querySelector<HTMLElement>('.chat-bubble[data-chat-copy-text]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));

      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith('desktop copy');
        expect(showToast).toHaveBeenCalledWith('chat.copied');
      });
    } finally {
      bus.emit('chat:clear-all');
      Object.defineProperty(desktopMedia, 'matches', { configurable: true, value: false });
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    }
  });

  describe('message entry motion hooks', () => {
    function renderMessageShell(): void {
      document.body.innerHTML = `
        <div id="chat-drawer"></div>
        <div id="chat-messages"><div class="chat-empty"></div></div>
      `;
    }

    it('animates a new group and every continuation row from the same sender', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1, 9, 5));

      try {
        renderMessageShell();
        const { addChatMessage } = await import('../chat-render.ts');

        addChatMessage('Peer 1', 'first', false);
        addChatMessage('Peer 1', 'second', false);
        addChatMessage('Peer 1', 'third', false);

        const groups = document.querySelectorAll<HTMLElement>('.chat-group');
        expect(groups).toHaveLength(1);
        expect(groups[0].classList.contains('chat-enter')).toBe(true);

        const rows = groups[0].querySelectorAll<HTMLElement>('.chat-row');
        expect(rows).toHaveLength(3);
        expect(rows[0].classList.contains('chat-enter')).toBe(false);
        expect(rows[1].classList.contains('chat-enter')).toBe(true);
        expect(rows[2].classList.contains('chat-enter')).toBe(true);
        expect(rows[1].matches('.chat-row + .chat-row:not(:last-child)')).toBe(true);
        expect(rows[2].matches('.chat-row + .chat-row:last-child')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('caps actual message rows even when one sender stays in a single group', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1, 9, 5));

      try {
        renderMessageShell();
        const { addChatMessage } = await import('../chat-render.ts');
        for (let index = 0; index < 205; index += 1) {
          addChatMessage('Peer 1', `message-${index}`, false, undefined, 1, 'member-1');
        }

        const rows = document.querySelectorAll<HTMLElement>('.chat-row');
        expect(rows).toHaveLength(200);
        expect(document.querySelectorAll('.chat-group')).toHaveLength(1);
        expect(rows[0]?.querySelector('.chat-text')?.textContent).toBe('message-5');
        expect(rows[199]?.querySelector('.chat-text')?.textContent).toBe('message-204');
      } finally {
        vi.useRealTimers();
      }
    });

    it('groups by an explicit room-member key instead of a mutable or duplicated nickname', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1, 9, 5));

      try {
        renderMessageShell();
        const { addChatMessage } = await import('../chat-render.ts');

        addChatMessage('Minsu', 'phone', false, undefined, 1, 'member-minsu');
        addChatMessage('Minsu renamed', 'laptop', false, undefined, 1, 'member-minsu');
        addChatMessage('Minsu', 'different account', false, undefined, 2, 'member-other');

        const groups = document.querySelectorAll<HTMLElement>('.chat-group');
        expect(groups).toHaveLength(2);
        expect(groups[0].dataset.senderId).toBe('member-minsu');
        expect(groups[0].querySelectorAll('.chat-row')).toHaveLength(2);
        expect(groups[1].dataset.senderId).toBe('member-other');
        expect(groups[1].querySelectorAll('.chat-row')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses the complete administrator-list crown silhouette for chat roles', async () => {
      renderMessageShell();
      const { addChatMessage } = await import('../chat-render.ts');

      addChatMessage('Owner', 'owner message', false, 'host', 0, 'member-owner');
      addChatMessage('Administrator', 'admin message', false, 'op', 1, 'member-admin');

      const expectedCrownPath = 'M5 16 3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm1 2h12v2H6z';
      expect(document.querySelector('.chat-badge-host .chat-crown path')?.getAttribute('d')).toBe(
        expectedCrownPath,
      );
      expect(document.querySelector('.chat-badge-op .chat-crown path')?.getAttribute('d')).toBe(
        expectedCrownPath,
      );
    });

    it('gives every standalone regular, system, and whisper group an entry motion hook', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1, 9, 5));

      try {
        renderMessageShell();
        const { addChatMessage, addSystemChatMessage, addWhisperMessage } =
          await import('../chat-render.ts');

        addChatMessage('Peer 1', 'hello', false);
        addChatMessage('Peer 2', 'hi', false);
        addSystemChatMessage('system update');
        addWhisperMessage('Peer 3', 'private hello', false);

        const groups = document.querySelectorAll<HTMLElement>('.chat-group');
        expect(groups).toHaveLength(4);
        expect(Array.from(groups).every((group) => group.classList.contains('chat-enter'))).toBe(
          true,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('marks every chat text boundary from the text itself, including continuation rows', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1, 9, 5));

      try {
        renderMessageShell();
        const { addChatMessage, addSystemChatMessage, addWhisperMessage } =
          await import('../chat-render.ts');

        addChatMessage('Пользователь', 'かな', false);
        addChatMessage('Пользователь', 'ข้อความ', false);
        addSystemChatMessage('системное сообщение');
        addWhisperMessage('Peer 3', '這麼好', false);

        const regularGroup = document.querySelector<HTMLElement>('.chat-group:not(.system)');
        expectFontClasses(
          regularGroup?.querySelector('.chat-sender'),
          'user-text-font',
          'user-text-font-ru',
        );

        const regularTexts = regularGroup?.querySelectorAll<HTMLElement>('.chat-text');
        expectFontClasses(regularTexts?.[0], 'user-text-font', 'user-text-font-ja');
        expectFontClasses(regularTexts?.[1], 'user-text-font', 'user-text-font-th');
        expectFontClasses(
          document.querySelector('.chat-group.system .chat-text'),
          'user-text-font',
          'user-text-font-ru',
        );
        expectFontClasses(
          document.querySelector('.chat-group.whisper .chat-text'),
          'user-text-font',
          'user-text-font-zh-hant',
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('Unread badge', () => {
    function renderChatShell(): void {
      document.body.innerHTML = `
        <button id="chat-preview-btn">
          <span id="chat-preview-badge"></span>
          <span class="chat-preview-text"></span>
        </button>
        <div id="chat-backdrop"></div>
        <div id="chat-drawer" data-chat-snap="half" tabindex="-1">
          <div class="chat-drawer-header"></div>
        </div>
        <div id="chat-messages" tabindex="-1"></div>
        <button id="btn-chat-scroll-down"></button>
        <button id="btn-chat-send"></button>
        <button id="btn-chat-close"></button>
        <div class="chat-input-wrapper"><div id="chat-input" contenteditable="true"></div></div>
        <div id="chat-pinned-notice"></div>
      `;
    }

    it('keeps the hidden scroll control out of tab order and exposes it when needed', async () => {
      renderChatShell();
      const messages = document.getElementById('chat-messages') as HTMLElement;
      Object.defineProperties(messages, {
        scrollHeight: { configurable: true, value: 1_000 },
        clientHeight: { configurable: true, value: 400 },
        scrollTop: { configurable: true, writable: true, value: 600 },
      });
      const scrollTo = vi.fn();
      Object.defineProperty(messages, 'scrollTo', { configurable: true, value: scrollTo });

      const { initChat } = await import('../chat.ts');
      initChat();

      const button = document.getElementById('btn-chat-scroll-down') as HTMLButtonElement;
      expect(button.classList).not.toContain('show');
      expect(button.getAttribute('aria-hidden')).toBe('true');
      expect(button.tabIndex).toBe(-1);

      messages.scrollTop = 100;
      messages.dispatchEvent(new Event('scroll'));
      expect(button.classList).toContain('show');
      expect(button.getAttribute('aria-hidden')).toBe('false');
      expect(button.tabIndex).toBe(0);

      button.focus();
      messages.scrollTop = 600;
      messages.dispatchEvent(new Event('scroll'));
      expect(document.activeElement).toBe(messages);

      messages.scrollTop = 100;
      messages.dispatchEvent(new Event('scroll'));
      button.click();
      expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'smooth' });
    });

    it('uses the shared reduced-motion scroll path for the chat jump control', async () => {
      renderChatShell();
      const messages = document.getElementById('chat-messages') as HTMLElement;
      Object.defineProperties(messages, {
        scrollHeight: { configurable: true, value: 1_000 },
        clientHeight: { configurable: true, value: 400 },
        scrollTop: { configurable: true, writable: true, value: 100 },
      });
      const scrollTo = vi.fn();
      Object.defineProperty(messages, 'scrollTo', { configurable: true, value: scrollTo });
      vi.spyOn(window, 'matchMedia').mockReturnValue({
        matches: true,
      } as MediaQueryList);

      const { initChat } = await import('../chat.ts');
      initChat();
      document.getElementById('btn-chat-scroll-down')?.click();

      expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'auto' });
    });

    it('exposes command suggestions as an active-descendant combobox', async () => {
      renderChatShell();
      const { initChat } = await import('../chat.ts');
      initChat();
      const input = document.getElementById('chat-input')!;

      input.textContent = '/';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      const list = document.getElementById('chat-command-suggestions')!;
      const options = list.querySelectorAll<HTMLElement>('[role="option"]');
      expect(input.getAttribute('role')).toBe('combobox');
      expect(input.getAttribute('aria-autocomplete')).toBe('list');
      expect(input.getAttribute('aria-controls')).toBe(list.id);
      expect(input.getAttribute('aria-expanded')).toBe('true');
      expect(list.getAttribute('role')).toBe('listbox');
      expect(options.length).toBeGreaterThan(1);
      expect(options[0]?.getAttribute('aria-selected')).toBe('true');
      expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);

      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
      expect(options[0]?.getAttribute('aria-selected')).toBe('false');
      expect(options[1]?.getAttribute('aria-selected')).toBe('true');
      expect(input.getAttribute('aria-activedescendant')).toBe(options[1]?.id);

      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
      expect(input.getAttribute('aria-expanded')).toBe('false');
      expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    });

    it('clears unread badge when chat is cleared remotely', async () => {
      renderChatShell();
      const { initChat } = await import('../chat.ts');
      initChat();

      bus.emit('chat:message-rendered', 'Peer', 'hello', false);
      const badge = document.getElementById('chat-preview-badge') as HTMLElement;
      expect(badge.textContent).toBe('1');
      expect(badge.classList.contains('show')).toBe(true);

      bus.emit('chat:clear-all');
      expect(badge.textContent).toBe('0');
      expect(badge.classList.contains('show')).toBe(false);
    });

    it('reveals the drawer scrollbar when the chat surface opens', async () => {
      renderChatShell();
      const { toggleChatDrawer } = await import('../chat.ts');
      const reveal = vi.fn();
      bus.on('ui:scrollbar-reveal', reveal);

      toggleChatDrawer();

      const drawer = document.getElementById('chat-drawer')!;
      const settled = new Event('transitionend');
      Object.defineProperty(settled, 'propertyName', { value: 'transform' });
      drawer.dispatchEvent(settled);
      expect(reveal).toHaveBeenCalledWith(drawer);
      toggleChatDrawer();
    });

    it('settles only the latest scrollbar transition across rapid drawer toggles', async () => {
      renderChatShell();
      const { toggleChatDrawer } = await import('../chat.ts');
      const reveal = vi.fn();
      const relayout = vi.fn();
      bus.on('ui:scrollbar-reveal', reveal);
      bus.on('ui:scrollbar-relayout', relayout);

      toggleChatDrawer();
      toggleChatDrawer();
      toggleChatDrawer();

      reveal.mockClear();
      relayout.mockClear();
      const drawer = document.getElementById('chat-drawer')!;
      const settled = new Event('transitionend');
      Object.defineProperty(settled, 'propertyName', { value: 'transform' });
      drawer.dispatchEvent(settled);
      drawer.dispatchEvent(settled);

      expect(reveal).toHaveBeenCalledTimes(1);
      expect(reveal).toHaveBeenCalledWith(drawer);
      expect(relayout).not.toHaveBeenCalled();

      toggleChatDrawer();
    });

    it('uses adjacent detents normally and supports a deliberate full-height dismiss', async () => {
      renderChatShell();
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
      document.documentElement.style.setProperty('--app-height', '844px');

      const drawer = document.getElementById('chat-drawer') as HTMLElement;
      drawer.getBoundingClientRect = vi.fn(() => {
        const liveHeight = Number.parseFloat(drawer.style.getPropertyValue('--chat-live-height'));
        const height =
          Number.isFinite(liveHeight) && liveHeight > 0
            ? liveHeight
            : drawer.dataset.chatSnap === 'full'
              ? 844
              : 422;
        return {
          x: 0,
          y: 844 - height,
          width: 390,
          height,
          top: 844 - height,
          right: 390,
          bottom: 844,
          left: 0,
          toJSON: () => ({}),
        };
      });

      const { initChat, toggleChatDrawer } = await import('../chat.ts');
      initChat();
      toggleChatDrawer();

      const header = drawer.querySelector('.chat-drawer-header') as HTMLElement;
      const drag = (startY: number, endY: number): void => {
        header.dispatchEvent(
          new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientY: startY,
          }),
        );
        window.dispatchEvent(
          new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: endY }),
        );
        window.dispatchEvent(
          new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientY: endY }),
        );
      };

      expect(drawer.dataset.chatSnap).toBe('half');
      drag(600, 510);
      expect(drawer.dataset.chatSnap).toBe('full');
      expect(drawer.classList.contains('open')).toBe(true);

      drag(100, 190);
      expect(drawer.dataset.chatSnap).toBe('half');
      expect(drawer.classList.contains('open')).toBe(true);

      drag(500, 620);
      expect(drawer.classList.contains('open')).toBe(false);
      expect(drawer.style.getPropertyValue('--chat-offset-y')).toBe('120px');
      const childSettled = new Event('transitionend', { bubbles: true });
      Object.defineProperty(childSettled, 'propertyName', { value: 'transform' });
      header.dispatchEvent(childSettled);
      expect(drawer.style.getPropertyValue('--chat-offset-y')).toBe('120px');
      const closeSettled = new Event('transitionend');
      Object.defineProperty(closeSettled, 'propertyName', { value: 'transform' });
      drawer.dispatchEvent(closeSettled);
      expect(drawer.style.getPropertyValue('--chat-offset-y')).toBe('');

      toggleChatDrawer();
      header.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientY: 500,
        }),
      );
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 630 }),
      );
      window.dispatchEvent(new Event('blur'));
      expect(drawer.dataset.chatSnap).toBe('half');
      expect(drawer.classList.contains('open')).toBe(true);

      toggleChatDrawer();
      toggleChatDrawer();
      drag(600, 510);
      expect(drawer.dataset.chatSnap).toBe('full');
      drag(100, 450);
      expect(drawer.dataset.chatSnap).toBe('half');
      expect(drawer.classList.contains('open')).toBe(true);
      drag(500, 620);
      expect(drawer.classList.contains('open')).toBe(false);

      toggleChatDrawer();
      drag(600, 510);
      expect(drawer.dataset.chatSnap).toBe('full');
      drag(100, 700);
      expect(drawer.classList.contains('open')).toBe(false);

      document.documentElement.style.removeProperty('--app-height');
    });

    it('interpolates the safe-top inset with live height before a full-height release', async () => {
      renderChatShell();
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
      document.documentElement.style.setProperty('--app-height', '844px');
      document.documentElement.style.setProperty('--safe-top', '47px');

      const drawer = document.getElementById('chat-drawer') as HTMLElement;
      drawer.getBoundingClientRect = vi.fn(() => {
        const liveHeight = Number.parseFloat(drawer.style.getPropertyValue('--chat-live-height'));
        const height = Number.isFinite(liveHeight) && liveHeight > 0 ? liveHeight : 422;
        return {
          x: 0,
          y: 844 - height,
          width: 390,
          height,
          top: 844 - height,
          right: 390,
          bottom: 844,
          left: 0,
          toJSON: () => ({}),
        };
      });

      const { initChat, toggleChatDrawer } = await import('../chat.ts');
      initChat();
      toggleChatDrawer();
      const header = drawer.querySelector('.chat-drawer-header') as HTMLElement;
      header.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientY: 600,
        }),
      );

      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 389 }),
      );
      expect(Number.parseFloat(drawer.style.getPropertyValue('--chat-live-height'))).toBe(633);
      expect(Number.parseFloat(drawer.style.getPropertyValue('--chat-live-safe-top'))).toBeCloseTo(
        23.5,
      );

      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 178 }),
      );
      expect(Number.parseFloat(drawer.style.getPropertyValue('--chat-live-height'))).toBe(844);
      expect(Number.parseFloat(drawer.style.getPropertyValue('--chat-live-safe-top'))).toBe(47);

      window.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientY: 178 }),
      );
      expect(drawer.dataset.chatSnap).toBe('full');
      expect(Number.parseFloat(drawer.style.getPropertyValue('--chat-live-safe-top'))).toBe(47);

      const settled = new Event('transitionend');
      Object.defineProperty(settled, 'propertyName', { value: 'height' });
      drawer.dispatchEvent(settled);
      expect(drawer.style.getPropertyValue('--chat-live-safe-top')).toBe('');

      toggleChatDrawer();
      document.documentElement.style.removeProperty('--app-height');
      document.documentElement.style.removeProperty('--safe-top');
    });

    it('resolves an env safe-top token through a real padding property', async () => {
      renderChatShell();
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
      document.documentElement.style.setProperty('--app-height', '844px');

      const nativeGetComputedStyle = window.getComputedStyle.bind(window);
      const styleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
        const style = nativeGetComputedStyle(element);
        if (element === document.documentElement) {
          return new Proxy(style, {
            get(target, property) {
              if (property === 'getPropertyValue') {
                return (name: string) =>
                  name === '--safe-top'
                    ? 'env(safe-area-inset-top, 0px)'
                    : target.getPropertyValue(name);
              }
              return Reflect.get(target, property, target);
            },
          });
        }
        if (element instanceof HTMLElement && element.style.paddingTop === 'var(--safe-top)') {
          return new Proxy(style, {
            get(target, property) {
              if (property === 'paddingTop') return '47px';
              return Reflect.get(target, property, target);
            },
          });
        }
        return style;
      });

      const drawer = document.getElementById('chat-drawer') as HTMLElement;
      drawer.getBoundingClientRect = vi.fn(() => ({
        x: 0,
        y: 422,
        width: 390,
        height: 422,
        top: 422,
        right: 390,
        bottom: 844,
        left: 0,
        toJSON: () => ({}),
      }));

      const { initChat, toggleChatDrawer } = await import('../chat.ts');
      initChat();
      toggleChatDrawer();
      const header = drawer.querySelector('.chat-drawer-header') as HTMLElement;
      header.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientY: 600,
        }),
      );
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 389 }),
      );

      expect(Number.parseFloat(drawer.style.getPropertyValue('--chat-live-safe-top'))).toBeCloseTo(
        23.5,
      );
      expect(
        styleSpy.mock.calls.filter(
          ([element]) =>
            element instanceof HTMLElement && element.style.paddingTop === 'var(--safe-top)',
        ),
      ).toHaveLength(2);

      window.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientY: 389 }),
      );
      toggleChatDrawer();
      document.documentElement.style.removeProperty('--app-height');
    });

    it('consumes an in-flight opening offset before growing the drawer upward', async () => {
      renderChatShell();
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
      document.documentElement.style.setProperty('--app-height', '844px');

      const drawer = document.getElementById('chat-drawer') as HTMLElement;
      drawer.getBoundingClientRect = vi.fn(() => {
        const liveHeight = Number.parseFloat(drawer.style.getPropertyValue('--chat-live-height'));
        const height = Number.isFinite(liveHeight) && liveHeight > 0 ? liveHeight : 422;
        const offset = Number.parseFloat(drawer.style.getPropertyValue('--chat-offset-y')) || 0;
        return {
          x: 0,
          y: 844 - height + offset,
          width: 390,
          height,
          top: 844 - height + offset,
          right: 390,
          bottom: 844 + offset,
          left: 0,
          toJSON: () => ({}),
        };
      });

      const { initChat, toggleChatDrawer } = await import('../chat.ts');
      initChat();
      toggleChatDrawer();
      drawer.style.setProperty('--chat-offset-y', '120px');

      const header = drawer.querySelector('.chat-drawer-header') as HTMLElement;
      header.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientY: 600,
        }),
      );
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 520 }),
      );
      expect(drawer.style.getPropertyValue('--chat-live-height')).toBe('422px');
      expect(drawer.style.getPropertyValue('--chat-offset-y')).toBe('40px');
      expect(drawer.getBoundingClientRect().top).toBe(462);

      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 450 }),
      );
      expect(drawer.style.getPropertyValue('--chat-live-height')).toBe('452px');
      expect(drawer.style.getPropertyValue('--chat-offset-y')).toBe('0px');
      expect(drawer.getBoundingClientRect().top).toBe(392);

      window.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientY: 450 }),
      );
      toggleChatDrawer();
      document.documentElement.style.removeProperty('--app-height');
    });

    it('preserves an older-read bottom gap through drag and snap until user takeover', async () => {
      renderChatShell();
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
      const anchorFrames: FrameRequestCallback[] = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        anchorFrames.push(callback);
        return anchorFrames.length;
      });
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
      document.documentElement.style.setProperty('--app-height', '844px');

      const drawer = document.getElementById('chat-drawer') as HTMLElement;
      drawer.getBoundingClientRect = vi.fn(() => {
        const liveHeight = Number.parseFloat(drawer.style.getPropertyValue('--chat-live-height'));
        const height = Number.isFinite(liveHeight) && liveHeight > 0 ? liveHeight : 422;
        return {
          x: 0,
          y: 844 - height,
          width: 390,
          height,
          top: 844 - height,
          right: 390,
          bottom: 844,
          left: 0,
          toJSON: () => ({}),
        };
      });

      let clientHeightAdjustment = 0;
      const messages = document.getElementById('chat-messages') as HTMLElement;
      Object.defineProperties(messages, {
        scrollHeight: { configurable: true, value: 1_000 },
        clientHeight: {
          configurable: true,
          get: () => {
            const liveHeight = Number.parseFloat(
              drawer.style.getPropertyValue('--chat-live-height'),
            );
            const height = Number.isFinite(liveHeight) && liveHeight > 0 ? liveHeight : 422;
            return 400 + (height - 422) + clientHeightAdjustment;
          },
        },
        scrollTop: { configurable: true, writable: true, value: 520 },
      });

      const { initChat, toggleChatDrawer } = await import('../chat.ts');
      initChat();
      toggleChatDrawer();
      messages.scrollTop = 520;
      const header = drawer.querySelector('.chat-drawer-header') as HTMLElement;
      header.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientY: 600,
        }),
      );
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 510 }),
      );
      expect(1_000 - messages.scrollTop - messages.clientHeight).toBe(80);
      window.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientY: 510 }),
      );
      expect(drawer.dataset.chatSnap).toBe('full');
      expect(1_000 - messages.scrollTop - messages.clientHeight).toBe(80);

      clientHeightAdjustment = 10;
      const activeSnapFrames = [...anchorFrames];
      for (const callback of activeSnapFrames) callback(window.performance.now() + 16);
      expect(1_000 - messages.scrollTop - messages.clientHeight).toBe(80);

      const staleSnapFrames = [...anchorFrames];
      drawer.dispatchEvent(new Event('pointerdown'));
      clientHeightAdjustment = 20;
      for (const callback of staleSnapFrames) callback(window.performance.now() + 500);
      expect(messages.scrollTop).toBe(88);

      toggleChatDrawer();
      document.documentElement.style.removeProperty('--app-height');
    });

    it('keeps the latest message visible across detent changes without moving older reads', async () => {
      renderChatShell();
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
      const anchorFrames: FrameRequestCallback[] = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        anchorFrames.push(callback);
        return anchorFrames.length;
      });
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
      document.documentElement.style.setProperty('--app-height', '844px');

      const drawer = document.getElementById('chat-drawer') as HTMLElement;
      drawer.getBoundingClientRect = vi.fn(() => {
        const liveHeight = Number.parseFloat(drawer.style.getPropertyValue('--chat-live-height'));
        const height =
          Number.isFinite(liveHeight) && liveHeight > 0
            ? liveHeight
            : drawer.dataset.chatSnap === 'full'
              ? 844
              : 422;
        return {
          x: 0,
          y: 844 - height,
          width: 390,
          height,
          top: 844 - height,
          right: 390,
          bottom: 844,
          left: 0,
          toJSON: () => ({}),
        };
      });

      const messages = document.getElementById('chat-messages') as HTMLElement;
      Object.defineProperty(messages, 'scrollHeight', { configurable: true, value: 1_000 });
      Object.defineProperty(messages, 'clientHeight', { configurable: true, value: 400 });

      const { initChat, toggleChatDrawer } = await import('../chat.ts');
      initChat();
      toggleChatDrawer();

      const header = drawer.querySelector('.chat-drawer-header') as HTMLElement;
      const drag = (startY: number, endY: number): void => {
        header.dispatchEvent(
          new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientY: startY,
          }),
        );
        window.dispatchEvent(
          new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: endY }),
        );
        window.dispatchEvent(
          new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientY: endY }),
        );
      };

      messages.scrollTop = 600;
      drag(600, 510);
      expect(drawer.dataset.chatSnap).toBe('full');

      messages.scrollTop = 600;
      drag(100, 190);
      expect(drawer.dataset.chatSnap).toBe('half');
      expect(messages.scrollTop).toBe(messages.scrollHeight);

      const staleSnapFrames = [...anchorFrames];
      expect(staleSnapFrames.length).toBeGreaterThan(0);
      drawer.dispatchEvent(new Event('pointerdown'));
      messages.scrollTop = 100;
      clearAllManagedTimers();
      for (const callback of staleSnapFrames) callback(window.performance.now() + 500);
      expect(messages.scrollTop).toBe(100);
      expect(drawer.classList.contains('is-snapping')).toBe(false);
      expect(drawer.style.getPropertyValue('--chat-live-height')).toBe('');

      messages.scrollTop = 100;
      drag(600, 510);
      expect(drawer.dataset.chatSnap).toBe('full');
      expect(messages.scrollTop).toBe(100);

      toggleChatDrawer();
      document.documentElement.style.removeProperty('--app-height');
    });

    it('keeps the drawer closed when an external close interrupts an active drag', async () => {
      renderChatShell();
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
      document.documentElement.style.setProperty('--app-height', '844px');

      const drawer = document.getElementById('chat-drawer') as HTMLElement;
      drawer.getBoundingClientRect = vi.fn(() => ({
        x: 0,
        y: 422,
        width: 390,
        height: 422,
        top: 422,
        right: 390,
        bottom: 844,
        left: 0,
        toJSON: () => ({}),
      }));

      const { initChat, toggleChatDrawer } = await import('../chat.ts');
      initChat();
      toggleChatDrawer();
      const header = drawer.querySelector('.chat-drawer-header') as HTMLElement;
      header.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientY: 500,
        }),
      );
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 620 }),
      );

      bus.emit('ui:close-chat-drawer');
      window.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientY: 620 }),
      );
      expect(drawer.classList.contains('open')).toBe(false);

      toggleChatDrawer();
      expect(drawer.classList.contains('open')).toBe(true);
      toggleChatDrawer();
      document.documentElement.style.removeProperty('--app-height');
    });

    it('supports both half settling and deliberate direct dismiss on short portrait', async () => {
      renderChatShell();
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(370);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(558);
      document.documentElement.style.setProperty('--app-height', '558px');

      const drawer = document.getElementById('chat-drawer') as HTMLElement;
      drawer.getBoundingClientRect = vi.fn(() => {
        const liveHeight = Number.parseFloat(drawer.style.getPropertyValue('--chat-live-height'));
        const height =
          Number.isFinite(liveHeight) && liveHeight > 0
            ? liveHeight
            : drawer.dataset.chatSnap === 'full'
              ? 558
              : 279;
        return {
          x: 0,
          y: 558 - height,
          width: 370,
          height,
          top: 558 - height,
          right: 370,
          bottom: 558,
          left: 0,
          toJSON: () => ({}),
        };
      });

      const { initChat, toggleChatDrawer } = await import('../chat.ts');
      initChat();
      toggleChatDrawer();

      const header = drawer.querySelector('.chat-drawer-header') as HTMLElement;
      const drag = (startY: number, endY: number): void => {
        header.dispatchEvent(
          new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientY: startY,
          }),
        );
        window.dispatchEvent(
          new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: endY }),
        );
        window.dispatchEvent(
          new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientY: endY }),
        );
      };

      expect(drawer.dataset.chatSnap).toBe('half');
      drag(400, 320);
      expect(drawer.dataset.chatSnap).toBe('full');
      expect(drawer.classList.contains('open')).toBe(true);

      drag(80, 170);
      expect(drawer.dataset.chatSnap).toBe('half');
      expect(drawer.classList.contains('open')).toBe(true);

      drag(350, 470);
      expect(drawer.classList.contains('open')).toBe(false);

      toggleChatDrawer();
      drag(400, 320);
      expect(drawer.dataset.chatSnap).toBe('full');
      drag(40, 450);
      expect(drawer.classList.contains('open')).toBe(false);

      document.documentElement.style.removeProperty('--app-height');
    });

    it('does not mistake an Android system-bar height gap for a dragged offset', async () => {
      renderChatShell();
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(820);
      document.documentElement.style.setProperty('--app-height', '800px');

      const drawer = document.getElementById('chat-drawer') as HTMLElement;
      drawer.getBoundingClientRect = vi.fn(() => ({
        x: 0,
        y: 420,
        width: 390,
        height: 400,
        top: 420,
        right: 390,
        bottom: 820,
        left: 0,
        toJSON: () => ({}),
      }));

      const { initChat, toggleChatDrawer } = await import('../chat.ts');
      initChat();
      toggleChatDrawer();

      const header = drawer.querySelector('.chat-drawer-header') as HTMLElement;
      header.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientY: 500,
        }),
      );

      expect(drawer.style.getPropertyValue('--chat-offset-y')).toBe('0px');
      window.dispatchEvent(new Event('blur'));
      toggleChatDrawer();
      document.documentElement.style.removeProperty('--app-height');
    });

    it('does not stack drawer button or backdrop handlers when chat is reinitialized', async () => {
      renderChatShell();
      const { initChat } = await import('../chat.ts');
      initChat();
      initChat();

      document.getElementById('chat-preview-btn')?.click();
      const drawer = document.getElementById('chat-drawer')!;
      expect(drawer.classList.contains('open')).toBe(true);

      document.getElementById('chat-backdrop')?.click();
      expect(drawer.classList.contains('open')).toBe(false);
    });

    it('focuses the drawer surface instead of visually selecting its handle for pointer opens', async () => {
      renderChatShell();
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
      document.documentElement.style.setProperty('--app-height', '844px');

      const { initChat, toggleChatDrawer } = await import('../chat.ts');
      initChat();
      document
        .getElementById('chat-preview-btn')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));

      const drawer = document.getElementById('chat-drawer') as HTMLElement;
      expect(drawer.classList.contains('open')).toBe(true);
      expect(document.activeElement).toBe(drawer);
      toggleChatDrawer();
      document.documentElement.style.removeProperty('--app-height');
    });

    it('makes the mobile drawer modal, keyboard-resizable, focus-contained, and escapable', async () => {
      document.body.innerHTML = `
        <button id="chat-preview-btn">
          <span id="chat-preview-badge"></span>
          <span class="chat-preview-text"></span>
        </button>
        <header id="main-header"></header>
        <section class="tab-content active" id="tab-play"></section>
        <div id="chat-backdrop"></div>
        <div id="chat-drawer" data-chat-snap="half" tabindex="-1">
          <div class="chat-drawer-header">
            <button class="chat-drawer-close" id="btn-chat-close"></button>
          </div>
          <div id="chat-messages" tabindex="-1"></div>
          <div id="chat-input" contenteditable="true" tabindex="0"></div>
          <button id="btn-chat-send"></button>
          <button id="btn-chat-scroll-down" tabindex="-1" aria-hidden="true"></button>
          <div id="chat-pinned-notice"></div>
        </div>
        <nav class="bottom-nav"></nav>
      `;
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
      document.documentElement.style.setProperty('--app-height', '844px');

      const { initChat, toggleChatDrawer } = await import('../chat.ts');
      initChat();
      const trigger = document.getElementById('chat-preview-btn') as HTMLButtonElement;
      trigger.focus();
      toggleChatDrawer();

      const drawer = document.getElementById('chat-drawer') as HTMLElement;
      const header = drawer.querySelector('.chat-drawer-header') as HTMLElement;
      const input = document.getElementById('chat-input') as HTMLElement;
      expect(drawer.getAttribute('role')).toBe('dialog');
      expect(drawer.getAttribute('aria-modal')).toBe('true');
      expect(document.getElementById('main-header')?.inert).toBe(true);
      expect(header.getAttribute('role')).toBe('separator');
      expect(header.getAttribute('aria-valuenow')).toBe('50');
      expect(document.activeElement).toBe(header);

      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(drawer.dataset.chatSnap).toBe('full');
      expect(header.getAttribute('aria-valuenow')).toBe('100');
      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(drawer.dataset.chatSnap).toBe('half');

      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      expect(document.activeElement).toBe(input);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      expect(document.activeElement).toBe(document.getElementById('btn-chat-send'));
      document
        .getElementById('btn-chat-send')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      expect(document.activeElement).toBe(header);

      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
      expect(drawer.classList.contains('open')).toBe(false);
      expect(drawer.hasAttribute('aria-modal')).toBe(false);
      expect(document.getElementById('main-header')?.inert).toBe(false);
      expect(document.activeElement).toBe(trigger);
      document.documentElement.style.removeProperty('--app-height');
    });

    it('does not expose a fake resize range when short landscape has only the full detent', async () => {
      renderChatShell();
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(844);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(390);
      document.documentElement.style.setProperty('--app-height', '390px');

      const { initChat, toggleChatDrawer } = await import('../chat.ts');
      initChat();
      toggleChatDrawer();

      const drawer = document.getElementById('chat-drawer')!;
      const header = drawer.querySelector<HTMLElement>('.chat-drawer-header')!;
      expect(drawer.dataset.chatSnap).toBe('full');
      expect(header.getAttribute('role')).toBe('button');
      expect(header.hasAttribute('aria-valuemin')).toBe(false);
      expect(header.hasAttribute('aria-valuemax')).toBe(false);
      expect(header.hasAttribute('aria-valuenow')).toBe(false);

      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(drawer.classList.contains('open')).toBe(true);
      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(drawer.classList.contains('open')).toBe(false);
      document.documentElement.style.removeProperty('--app-height');
    });

    it('marks the compact preview from the sender and message scripts', async () => {
      renderChatShell();
      const { initChat } = await import('../chat.ts');
      initChat();

      bus.emit('chat:message-rendered', 'Пользователь', 'かな', false);

      const preview = document.querySelector<HTMLElement>('.chat-preview-text');
      expectFontClasses(preview, 'user-text-font', 'user-text-font-ru', 'user-text-font-ja');
      expect(preview?.dataset.userTextFonts).toBe('ru ja');

      bus.emit('chat:message-rendered', 'Peer', 'plain text', false);
      expect(preview?.classList.contains('user-text-font')).toBe(false);
      expect(preview?.dataset.userTextFonts).toBeUndefined();
    });

    it('updates the script-aware font while composing in the chat input', async () => {
      renderChatShell();
      const input = document.getElementById('chat-input') as HTMLDivElement;
      input.contentEditable = 'true';
      const { initChat } = await import('../chat.ts');
      initChat();

      input.textContent = '练习 練習';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));

      expectFontClasses(
        input,
        'user-text-font',
        'user-text-font-zh-hans',
        'user-text-font-zh-hant',
      );

      input.textContent = 'MUSIXQUARE';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      expect(input.classList.contains('user-text-font')).toBe(false);
      expect(input.dataset.userTextFonts).toBeUndefined();
    });
  });

  describe('chat bubble copy gestures', () => {
    let originalClipboardDescriptor: PropertyDescriptor | undefined;
    let originalExecCommandDescriptor: PropertyDescriptor | undefined;

    function renderCopyShell(): void {
      document.body.innerHTML = `
        <button id="chat-preview-btn"><span class="chat-preview-text"></span></button>
        <div id="chat-backdrop"></div>
        <div id="chat-drawer" data-chat-snap="half" tabindex="-1">
          <div class="chat-drawer-header"></div>
          <div id="chat-messages"><span id="chat-copy-hint"></span><div class="chat-empty"></div></div>
          <button id="btn-chat-scroll-down"></button>
          <button id="btn-chat-send"></button>
          <button id="btn-chat-close"></button>
          <div class="chat-input-wrapper">
            <div id="chat-input" contenteditable="true"></div>
          </div>
          <div id="chat-pinned-notice"></div>
        </div>
      `;
    }

    function installClipboard(): ReturnType<typeof vi.fn> {
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });
      return writeText;
    }

    async function initCopyChat(): Promise<void> {
      const [{ initChat }, { initChatCopyGestures }] = await Promise.all([
        import('../chat.ts'),
        import('../chat-copy.ts'),
      ]);
      initChat();
      initChatCopyGestures();
    }

    function dispatchTouchPointer(
      target: Element,
      type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
      options: { pointerId?: number; clientX?: number; clientY?: number } = {},
    ): MouseEvent {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: options.clientX ?? 20,
        clientY: options.clientY ?? 20,
      });
      Object.defineProperties(event, {
        pointerType: { value: 'touch' },
        pointerId: { value: options.pointerId ?? 7 },
        isPrimary: { value: true },
      });
      target.dispatchEvent(event);
      return event;
    }

    beforeEach(() => {
      originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
    });

    afterEach(() => {
      if (originalClipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
      if (originalExecCommandDescriptor) {
        Object.defineProperty(document, 'execCommand', originalExecCommandDescriptor);
      } else {
        Reflect.deleteProperty(document, 'execCommand');
      }
      vi.useRealTimers();
    });

    it('copies either user bubble on a mouse click with exact line breaks and no metadata', async () => {
      renderCopyShell();
      const writeText = installClipboard();
      const { addChatMessage } = await import('../chat-render.ts');
      await initCopyChat();

      addChatMessage('Me', 'first line\nsecond line', true);
      addChatMessage('Peer', 'their message', false);
      const bubbles = document.querySelectorAll<HTMLElement>('.chat-bubble[data-chat-copy-text]');

      expect(bubbles).toHaveLength(2);
      expect(bubbles[0]?.tabIndex).toBe(0);
      expect(bubbles[0]?.getAttribute('role')).toBe('group');
      expect(bubbles[0]?.getAttribute('aria-describedby')).toBe('chat-copy-hint');

      bubbles[0]
        ?.querySelector('.chat-text')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).toHaveBeenNthCalledWith(1, 'first line\nsecond line');
      expect(showToast).toHaveBeenNthCalledWith(1, 'chat.copied');

      bubbles[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).toHaveBeenNthCalledWith(2, 'their message');
      expect(showToast).toHaveBeenNthCalledWith(2, 'chat.copied');
    });

    it('copies a long touch hold synchronously from pointerup when Async Clipboard would reject', async () => {
      vi.useFakeTimers();
      renderCopyShell();
      const writeText = installClipboard();
      writeText.mockRejectedValue(new DOMException('expired activation', 'NotAllowedError'));
      let dispatchingPointerUp = false;
      const execCommand = vi.fn(() => {
        expect(dispatchingPointerUp).toBe(true);
        return true;
      });
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: execCommand,
      });
      const { addChatMessage } = await import('../chat-render.ts');
      await initCopyChat();
      addChatMessage('Peer', 'hold to copy', false);
      const bubble = document.querySelector<HTMLElement>('.chat-bubble[data-chat-copy-text]')!;

      dispatchTouchPointer(bubble, 'pointerdown');
      vi.advanceTimersByTime(1_000);
      expect(writeText).not.toHaveBeenCalled();

      dispatchingPointerUp = true;
      const pointerUp = dispatchTouchPointer(bubble, 'pointerup');
      dispatchingPointerUp = false;
      expect(pointerUp.defaultPrevented).toBe(true);
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(writeText).not.toHaveBeenCalled();
      await Promise.resolve();
      await Promise.resolve();
      expect(showToast).toHaveBeenCalledWith('chat.copied');

      // The compatibility click emitted by touch browsers must not duplicate it.
      bubble.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      expect(execCommand).toHaveBeenCalledTimes(1);
    });

    it('shows the established failure toast when neither clipboard path succeeds', async () => {
      renderCopyShell();
      const writeText = installClipboard();
      writeText.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
      const { addChatMessage } = await import('../chat-render.ts');
      await initCopyChat();
      addChatMessage('Peer', 'cannot copy', false);

      document
        .querySelector<HTMLElement>('.chat-bubble[data-chat-copy-text]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(showToast).toHaveBeenCalledWith('toast.copy_failed');
    });

    it('does not copy a quick tap, a moved/scrolling hold, or an inline action click', async () => {
      vi.useFakeTimers();
      renderCopyShell();
      const writeText = installClipboard();
      const loadedUrls: string[] = [];
      bus.on('youtube:load-from-chat', (url) => loadedUrls.push(url));
      const { addChatMessage } = await import('../chat-render.ts');
      await initCopyChat();
      addChatMessage('Peer', 'https://youtu.be/abcdefghijk', false);
      const bubble = document.querySelector<HTMLElement>('.chat-bubble[data-chat-copy-text]')!;

      dispatchTouchPointer(bubble, 'pointerdown');
      vi.advanceTimersByTime(200);
      dispatchTouchPointer(bubble, 'pointerup');
      bubble.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));

      dispatchTouchPointer(bubble, 'pointerdown', { pointerId: 8 });
      dispatchTouchPointer(bubble, 'pointermove', {
        pointerId: 8,
        clientX: 40,
        clientY: 20,
      });
      vi.advanceTimersByTime(500);
      dispatchTouchPointer(bubble, 'pointerup', { pointerId: 8, clientX: 40, clientY: 20 });

      dispatchTouchPointer(bubble, 'pointerdown', { pointerId: 9 });
      document.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(500);
      dispatchTouchPointer(bubble, 'pointerup', { pointerId: 9 });

      document.querySelector<HTMLElement>('.chat-youtube-btn')?.click();
      await Promise.resolve();
      expect(writeText).not.toHaveBeenCalled();
      expect(loadedUrls).toEqual(['https://youtu.be/abcdefghijk']);

      // A YouTube-only card fills the bubble. Its quick tap remains an action,
      // while a deliberate hold copies the original URL and consumes the
      // compatibility click before the delegated load handler sees it.
      const youtubeButton = document.querySelector<HTMLElement>('.chat-youtube-btn')!;
      dispatchTouchPointer(youtubeButton, 'pointerdown', { pointerId: 10 });
      vi.advanceTimersByTime(500);
      dispatchTouchPointer(youtubeButton, 'pointerup', { pointerId: 10 });
      expect(writeText).toHaveBeenCalledWith('https://youtu.be/abcdefghijk');
      youtubeButton.click();
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(loadedUrls).toEqual(['https://youtu.be/abcdefghijk']);
    });

    it('preserves a native text selection and offers Enter as the keyboard action', async () => {
      renderCopyShell();
      const writeText = installClipboard();
      const { addChatMessage } = await import('../chat-render.ts');
      await initCopyChat();
      addChatMessage('Peer', 'selectable text', false);
      const bubble = document.querySelector<HTMLElement>('.chat-bubble[data-chat-copy-text]')!;
      const chatText = bubble.querySelector<HTMLElement>('.chat-text')!;
      const range = document.createRange();
      range.selectNodeContents(chatText);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);

      chatText.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      expect(writeText).not.toHaveBeenCalled();
      expect(selection.toString()).toBe('selectable text');

      selection.removeAllRanges();
      bubble.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      expect(writeText).toHaveBeenCalledWith('selectable text');
      await Promise.resolve();
      await Promise.resolve();
      expect(showToast).toHaveBeenCalledWith('chat.copied');
    });
  });

  describe('Notice banner', () => {
    function renderNoticeShell(): void {
      document.body.innerHTML = `
        <div id="chat-drawer"></div>
        <div id="chat-messages"><div class="chat-empty"></div></div>
        <div id="chat-pinned-notice" hidden>
          <div id="chat-pinned-notice-label"></div>
          <span id="chat-pinned-notice-time"></span>
          <div id="chat-pinned-notice-text"></div>
        </div>
      `;
    }

    it('pins notices without adding a duplicate chat bubble', async () => {
      renderNoticeShell();
      const rendered: Array<[string, string, boolean]> = [];
      bus.on('chat:message-rendered', (sender, text, isMine) => {
        rendered.push([sender, text, isMine]);
      });

      const { addNoticeChatMessage } = await import('../chat-render.ts');
      addNoticeChatMessage('HOST', 'playlist requests here', new Date(2026, 0, 1, 9, 5).getTime());

      expect(document.querySelector('.chat-group.notice')).toBeNull();
      expect(document.getElementById('chat-pinned-notice')?.hidden).toBe(false);
      expect(document.getElementById('chat-pinned-notice-label')?.textContent).toBe(
        'chat.cmd_notice_prefix · HOST',
      );
      expect(document.getElementById('chat-pinned-notice-time')?.textContent).toBe('09:05');
      expect(document.getElementById('chat-pinned-notice-text')?.textContent).toBe(
        'playlist requests here',
      );
      expect(
        document.getElementById('chat-pinned-notice')?.classList.contains('notice-attention-hint'),
      ).toBe(true);
      expect(rendered).toEqual([['HOST', 'playlist requests here', false]]);
    });

    it('clears the notice attention hint after the animation ends', async () => {
      renderNoticeShell();

      const { addNoticeChatMessage } = await import('../chat-render.ts');
      addNoticeChatMessage('HOST', 'fresh notice');

      const banner = document.getElementById('chat-pinned-notice');
      expect(banner?.classList.contains('notice-attention-hint')).toBe(true);

      banner?.dispatchEvent(new Event('animationend'));
      expect(banner?.classList.contains('notice-attention-hint')).toBe(false);
    });

    it('marks both the pinned sender label and body independently', async () => {
      renderNoticeShell();

      const { addNoticeChatMessage } = await import('../chat-render.ts');
      addNoticeChatMessage('ผู้ดูแล', 'かな');

      expectFontClasses(
        document.getElementById('chat-pinned-notice-label'),
        'user-text-font',
        'user-text-font-th',
      );
      expectFontClasses(
        document.getElementById('chat-pinned-notice-text'),
        'user-text-font',
        'user-text-font-ja',
      );
    });
  });

  describe('production content parsing', () => {
    it.each([
      ['3:45', '225'],
      ['1:30:00', '5400'],
      ['0:00', '0'],
      ['1:05', '65'],
    ])('renders %s with the production seek value %s', async (timestamp, seconds) => {
      const { parseMessageContent } = await import('../chat-render.ts');
      const root = document.createElement('div');
      root.innerHTML = parseMessageContent(`Jump to ${timestamp}`);

      expect(root.querySelector('.chat-timestamp')?.getAttribute('data-seek')).toBe(seconds);
    });

    it.each([
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://youtube.com/shorts/dQw4w9WgXcQ',
    ])('renders a production YouTube action for %s', async (url) => {
      const { parseMessageContent } = await import('../chat-render.ts');
      const root = document.createElement('div');
      root.innerHTML = parseMessageContent(`Check ${url}`);

      expect(root.querySelector<HTMLButtonElement>('.chat-youtube-btn')?.dataset.youtubeUrl).toBe(
        url,
      );
    });

    it('leaves non-YouTube URLs and bare numbers as text', async () => {
      const { parseMessageContent } = await import('../chat-render.ts');
      const root = document.createElement('div');
      root.innerHTML = parseMessageContent('https://example.com/video in 2025');

      expect(root.querySelector('.chat-youtube-btn,.chat-timestamp')).toBeNull();
      expect(root.textContent).toBe('https://example.com/video in 2025');
    });

    it('re-evaluates the asynchronously resolved YouTube title text', async () => {
      vi.useFakeTimers();
      try {
        document.body.innerHTML = `
          <div id="chat-drawer"></div>
          <div id="chat-messages"><div class="chat-empty"></div></div>
        `;
        const { fetchOEmbedTitle } = await import('../../youtube/oembed.ts');
        vi.mocked(fetchOEmbedTitle).mockResolvedValueOnce('かなの曲');
        const { addChatMessage } = await import('../chat-render.ts');

        addChatMessage('Peer 1', 'https://youtu.be/dQw4w9WgXcQ', false);
        await vi.advanceTimersByTimeAsync(100);

        expectFontClasses(
          document.querySelector('.chat-yt-title'),
          'user-text-font',
          'user-text-font-ja',
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('parseMessageContent XSS safety', () => {
    async function renderParsedContent(text: string): Promise<HTMLElement> {
      const { parseMessageContent } = await import('../chat-render.ts');
      const root = document.createElement('div');
      root.innerHTML = parseMessageContent(text);
      return root;
    }

    function expectNoEventHandlerAttributes(root: HTMLElement): void {
      root.querySelectorAll('*').forEach((el) => {
        Array.from(el.attributes).forEach((attr) => {
          expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
        });
      });
    }

    it.each([
      '<img src=x onerror=alert(1)>',
      '<svg onload=alert(1)><foreignObject><iframe srcdoc="<script>alert(1)</script>"></iframe></foreignObject></svg>',
      '</div><script>alert(1)</script>',
      '<a href="javascript:alert(1)">click</a>',
      '"><img src=x onerror=alert(1)>',
    ])('renders malicious markup as inert text: %s', async (payload) => {
      const root = await renderParsedContent(payload);

      expect(
        root.querySelector('script,img,svg,iframe,object,embed,link,style,foreignObject,math,meta'),
      ).toBeNull();
      expectNoEventHandlerAttributes(root);
      expect(root.textContent).toContain(payload);
    });

    it('does not let YouTube URL attributes break into executable markup', async () => {
      const root = await renderParsedContent(
        'watch https://youtu.be/dQw4w9WgXcQ"onpointerenter="alert(1) then 0:42 <img src=x onerror=alert(1)>',
      );

      const button = root.querySelector('button.chat-youtube-btn');
      expect(button).not.toBeNull();
      expect(button?.getAttribute('onpointerenter')).toBeNull();
      expect(root.querySelector('.chat-timestamp')?.getAttribute('data-seek')).toBe('42');
      expect(
        root.querySelector('script,img,iframe,object,embed,link,style,foreignObject,math,meta'),
      ).toBeNull();
      expectNoEventHandlerAttributes(root);
    });
  });

  describe('outbound identity', () => {
    function renderSendShell(text: string): void {
      document.body.innerHTML = `
        <div id="chat-drawer"></div>
        <div id="chat-messages"></div>
        <div id="chat-input" contenteditable="true">${text}</div>
      `;
    }

    it('uses the trimmed custom host label in the actual broadcast payload', async () => {
      renderSendShell('host payload');
      setState('network.myDeviceLabel', '  Studio Host  ');
      const broadcast = vi.fn();
      bus.on('network:broadcast', broadcast);

      const { sendChatMessage } = await import('../chat.ts');
      sendChatMessage();

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ senderLabel: 'Studio Host', text: 'host payload', isHost: true }),
      );
    });

    it('normalizes a guest role label in the actual host-bound payload', async () => {
      renderSendShell('guest payload');
      setState('network.hostConn', { open: true, peer: 'host-1' } as DataConnection);
      setState('network.myDeviceLabel', 'Left');

      const { sendChatMessage } = await import('../chat.ts');
      sendChatMessage();

      expect(sendToHost).toHaveBeenCalledWith(
        expect.objectContaining({ senderLabel: 'Peer', text: 'guest payload', isHost: false }),
      );
    });

    it('uses the canonical owner identity and crown on a standard-room sibling device', async () => {
      renderSendShell('owner sibling payload');
      setState('network.appRole', 'guest');
      setState('network.hostConn', { open: true, peer: 'physical-host' } as DataConnection);
      setState('network.isOperator', true);
      setState('network.standardRoomCapabilities', [
        'media.add',
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'members.manage',
        'chat.notice',
        'room.configure',
      ]);
      setState('network.myId', 'owner-phone');
      setState('network.myDeviceLabel', 'Minsu');
      setState('network.myMemberId', 'member_abcdefghijklmnopqrstuv');
      setState('network.myMemberDisplayNumber', 0);
      setState('network.myJoinOrder', 7);

      const { sendChatMessage } = await import('../chat.ts');
      sendChatMessage();

      const group = document.querySelector<HTMLElement>('#chat-messages .chat-group');
      expect(group?.dataset.senderId).toBe('member_abcdefghijklmnopqrstuv');
      expect(group?.querySelector('.chat-crown')).not.toBeNull();
      expect(group?.querySelector('.chat-join-order')?.textContent).toBe(' #0');
      expect(sendToHost).toHaveBeenCalledWith(
        expect.objectContaining({
          senderId: 'owner-phone',
          senderMemberId: 'member_abcdefghijklmnopqrstuv',
          senderLabel: 'Minsu',
          joinOrder: 0,
          isHost: true,
          isOp: true,
        }),
      );
    });

    it('uses the PRO member identity for a local bubble without granting every member a crown', async () => {
      renderSendShell('from my phone');
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      setState('network.myId', 'device-phone');
      setState('network.myDeviceLabel', 'Minsu');
      setState('network.myMemberId', 'member-minsu');
      setState('network.lastKnownDeviceList', [
        {
          id: 'device-phone',
          label: 'Minsu',
          isOp: false,
          isHost: false,
          status: 'connected',
          memberId: 'member-minsu',
          memberDisplayNumber: 4,
          isAuthenticated: true,
          role: 'member',
        },
      ]);

      const { sendChatMessage } = await import('../chat.ts');
      sendChatMessage();

      const group = document.querySelector<HTMLElement>('#chat-messages .chat-group');
      expect(group?.dataset.senderId).toBe('member-minsu');
      expect(group?.classList.contains('mine')).toBe(true);
      expect(group?.querySelector('.chat-crown')).toBeNull();
      expect(group?.querySelector('.chat-join-order')?.textContent).toBe(' #4');
    });

    it('shows and sends /bot as ordinary chat while executing it only once locally', async () => {
      renderSendShell('/bot 인기곡 3개 추가해줘');
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'participant_00001',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['queue.mutate', 'playback.control'],
      });
      setState('network.hostConn', null);
      setState('network.myId', 'guest-1');
      setState('network.lastKnownDeviceList', [
        {
          id: 'guest-1',
          label: 'Administrator',
          isOp: true,
          isHost: false,
          status: 'connected',
          role: 'controller',
        },
      ]);
      requestActiveProRoomBotCommand.mockResolvedValueOnce({
        ok: true,
        summary: '트랙 3개를 추가했어요.',
        addedCount: 3,
        playbackChanged: false,
      });
      const broadcast = vi.fn();
      bus.on('network:broadcast', broadcast);

      const { sendChatMessage } = await import('../chat.ts');
      sendChatMessage();

      await vi.waitFor(() => {
        expect(requestActiveProRoomBotCommand).toHaveBeenCalledOnce();
      });
      const realtimeCall = proRealtimeMocks.send.mock.calls[0];
      expect(realtimeCall).toBeDefined();
      if (!realtimeCall) throw new Error('expected a PRO realtime chat send');
      const [channel, outbound] = realtimeCall;
      expect(channel).toBe('chat');
      expect(outbound).toMatchObject({
        kind: 'message',
        text: '/bot 인기곡 3개 추가해줘',
      });
      const botOutbound = outbound as {
        text?: string;
        botRequestId?: string;
      };
      expect(botOutbound.botRequestId).toMatch(/^mxqr-pro-[a-f0-9]{48}$/);
      expect(requestActiveProRoomBotCommand).toHaveBeenCalledWith(
        '000001',
        '인기곡 3개 추가해줘',
        botOutbound.botRequestId,
      );
      expect(botProtocolMocks.beginLocalBotChatRequest).toHaveBeenCalledWith(
        botOutbound.botRequestId,
        '000001',
      );
      expect(botProtocolMocks.publishBotChatResult).toHaveBeenCalledWith(botOutbound.botRequestId, {
        kind: 'added',
        count: 3,
        playbackChanged: false,
      });
      expect(
        Array.from(document.querySelectorAll<HTMLElement>('#chat-messages .chat-text')).map(
          (element) => element.textContent,
        ),
      ).toContain('/bot 인기곡 3개 추가해줘');
      expect(broadcast).not.toHaveBeenCalled();
      expect(document.getElementById('chat-input')?.textContent).toBe('');
    });

    it('shows //request verbatim while sending only its prompt to the BOT API', async () => {
      renderSendShell('//강남스타일 틀어줘');
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'participant_00001',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['queue.mutate', 'playback.control'],
      });
      setState('network.hostConn', null);
      setState('network.myId', 'guest-1');
      setState('network.lastKnownDeviceList', [
        {
          id: 'guest-1',
          label: 'Administrator',
          isOp: true,
          isHost: false,
          status: 'connected',
          role: 'controller',
        },
      ]);
      requestActiveProRoomBotCommand.mockResolvedValueOnce({
        ok: true,
        summary: '재생할게요',
        addedCount: 0,
        playbackChanged: true,
      });

      const { sendChatMessage } = await import('../chat.ts');
      sendChatMessage();

      await vi.waitFor(() => expect(requestActiveProRoomBotCommand).toHaveBeenCalledOnce());
      const realtimeCall = proRealtimeMocks.send.mock.calls[0];
      expect(realtimeCall).toBeDefined();
      if (!realtimeCall) throw new Error('expected a PRO realtime chat send');
      const [channel, outbound] = realtimeCall;
      expect(channel).toBe('chat');
      expect(outbound.text).toBe('//강남스타일 틀어줘');
      expect(outbound.botRequestId).toMatch(/^mxqr-pro-[a-f0-9]{48}$/);
      expect(requestActiveProRoomBotCommand).toHaveBeenCalledWith(
        '000001',
        '강남스타일 틀어줘',
        outbound.botRequestId,
      );
      expect(
        Array.from(document.querySelectorAll<HTMLElement>('#chat-messages .chat-text')).map(
          (element) => element.textContent,
        ),
      ).toContain('//강남스타일 틀어줘');
    });

    it('blocks an ordinary PRO member BOT request before publishing chat or calling the API', async () => {
      renderSendShell('/bot 다음 곡');
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      setState('network.hostConn', null);
      setState('network.myId', 'member-1');
      setState('network.lastKnownDeviceList', [
        {
          id: 'member-1',
          label: 'Listener',
          isOp: false,
          isHost: false,
          status: 'connected',
          role: 'member',
        },
      ]);

      const { sendChatMessage } = await import('../chat.ts');
      sendChatMessage();

      expect(proRealtimeMocks.send).not.toHaveBeenCalled();
      expect(requestActiveProRoomBotCommand).not.toHaveBeenCalled();
      expect(botProtocolMocks.beginLocalBotChatRequest).not.toHaveBeenCalled();
      expect(
        document.querySelector<HTMLElement>('#chat-messages .chat-group.system .chat-text')
          ?.textContent,
      ).toBe('chat.cmd_no_permission');
    });
  });

  describe('outbound submission deduplication', () => {
    function renderSendShell(text: string): HTMLDivElement {
      document.body.innerHTML = `
        <div id="chat-drawer"></div>
        <div id="chat-messages"></div>
        <div id="chat-input" contenteditable="true">${text}</div>
      `;
      return document.getElementById('chat-input') as HTMLDivElement;
    }

    it('allows an identical retry immediately after chat freeze is lifted', async () => {
      renderSendShell('freeze retry 7241');
      setState('network.hostConn', { open: true, peer: 'host-1' } as DataConnection);
      setState('network.appRole', 'guest');
      setState('network.chatFrozen', true);

      const { sendChatMessage } = await import('../chat.ts');
      sendChatMessage();

      expect(sendToHost).not.toHaveBeenCalled();
      expect(document.getElementById('chat-input')?.textContent).toBe('freeze retry 7241');

      setState('network.chatFrozen', false);
      sendChatMessage();

      expect(sendToHost).toHaveBeenCalledTimes(1);
      expect(sendToHost).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'freeze retry 7241' }),
      );
    });

    it('allows an identical retry immediately after slowmode stops blocking it', async () => {
      const input = renderSendShell('slowmode seed 7242');
      setState('network.hostConn', { open: true, peer: 'host-1' } as DataConnection);
      setState('network.appRole', 'guest');

      const { sendChatMessage } = await import('../chat.ts');
      sendChatMessage();
      expect(sendToHost).toHaveBeenCalledTimes(1);

      input.textContent = 'slowmode retry 7242';
      setState('network.slowmodeSeconds', 10);
      sendChatMessage();
      expect(sendToHost).toHaveBeenCalledTimes(1);
      expect(input.textContent).toBe('slowmode retry 7242');

      setState('network.slowmodeSeconds', 0);
      sendChatMessage();

      expect(sendToHost).toHaveBeenCalledTimes(2);
      expect(sendToHost).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: 'slowmode retry 7242' }),
      );
    });

    it('still suppresses a genuine accepted double-fire within 500ms', async () => {
      const input = renderSendShell('accepted double fire 7243');
      setState('network.hostConn', { open: true, peer: 'host-1' } as DataConnection);
      setState('network.appRole', 'guest');

      const { sendChatMessage } = await import('../chat.ts');
      sendChatMessage();
      input.textContent = 'accepted double fire 7243';
      sendChatMessage();

      expect(sendToHost).toHaveBeenCalledTimes(1);
      expect(document.querySelectorAll('#chat-messages .chat-row')).toHaveLength(1);
    });
  });
});
