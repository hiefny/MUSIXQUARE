/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { sendToHost } from '../../network/peer.ts';
import type { DataConnection } from '../../types/index.ts';

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

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  sendToHost: vi.fn(),
}));

vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn(),
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

beforeEach(() => {
  resetState();
  bus.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  clearAllManagedTimers();
  vi.restoreAllMocks();
});

describe('Chat Module', () => {
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
  });

  describe('Unread badge', () => {
    function renderChatShell(): void {
      document.body.innerHTML = `
        <button id="chat-preview-btn">
          <span id="chat-preview-badge"></span>
          <span class="chat-preview-text"></span>
        </button>
        <div id="chat-backdrop"></div>
        <div id="chat-drawer"></div>
        <div id="chat-messages"></div>
        <button id="btn-chat-scroll-down"></button>
        <button id="btn-chat-send"></button>
        <button id="btn-chat-close"></button>
        <div id="chat-input"></div>
        <div id="chat-pinned-notice"></div>
      `;
    }

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
  });
});
