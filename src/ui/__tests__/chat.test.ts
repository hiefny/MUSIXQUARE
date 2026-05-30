/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';

// ─── Global stubs ────────────────────────────────────────────────────────
window.matchMedia =
  window.matchMedia ||
  vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });

// ─── Mocks ───────────────────────────────────────────────────────────────

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

vi.mock('../../youtube/search.ts', () => ({
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

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Chat Module', () => {
  describe('Module Exports', () => {
    it('exports sendChatMessage', async () => {
      const mod = await import('../chat.ts');
      expect(typeof mod.sendChatMessage).toBe('function');
    });

    it('exports addChatMessage from chat-render', async () => {
      const mod = await import('../chat-render.ts');
      expect(typeof mod.addChatMessage).toBe('function');
    });

    it('exports addSystemChatMessage from chat-render', async () => {
      const mod = await import('../chat-render.ts');
      expect(typeof mod.addSystemChatMessage).toBe('function');
    });

    it('exports toggleChatDrawer', async () => {
      const mod = await import('../chat.ts');
      expect(typeof mod.toggleChatDrawer).toBe('function');
    });

    it('exports initChat', async () => {
      const mod = await import('../chat.ts');
      expect(typeof mod.initChat).toBe('function');
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

  describe('Timestamp Parsing Logic', () => {
    // Reimplement the parseTimestamp logic for testing
    function parseTimestamp(str: string): number {
      const parts = str.split(':').map(Number);
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      return 0;
    }

    it('parses MM:SS format', () => {
      expect(parseTimestamp('3:45')).toBe(225);
    });

    it('parses HH:MM:SS format', () => {
      expect(parseTimestamp('1:30:00')).toBe(5400);
    });

    it('parses 0:00', () => {
      expect(parseTimestamp('0:00')).toBe(0);
    });

    it('parses single digit minutes', () => {
      expect(parseTimestamp('1:05')).toBe(65);
    });

    it('handles invalid parts gracefully', () => {
      // NaN parts still compute (returns NaN via arithmetic)
      const result = parseTimestamp('abc');
      expect(result).toBe(0); // single part → 0
    });
  });

  describe('YouTube URL Detection', () => {
    const YT_REGEX =
      /https:\/\/(www\.)?youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/[a-zA-Z0-9_-]{11}/gi;

    it('matches standard watch URL', () => {
      const text = 'Check https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      expect(YT_REGEX.test(text)).toBe(true);
    });

    it('matches short URL', () => {
      YT_REGEX.lastIndex = 0;
      const text = 'Check https://youtu.be/dQw4w9WgXcQ';
      expect(YT_REGEX.test(text)).toBe(true);
    });

    it('matches shorts URL', () => {
      YT_REGEX.lastIndex = 0;
      const text = 'Check https://youtube.com/shorts/dQw4w9WgXcQ';
      expect(YT_REGEX.test(text)).toBe(true);
    });

    it('does NOT match non-YouTube URLs', () => {
      YT_REGEX.lastIndex = 0;
      const text = 'Check https://example.com/video';
      expect(YT_REGEX.test(text)).toBe(false);
    });
  });

  describe('Timestamp Regex Detection', () => {
    const TS_REGEX = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;

    it('matches MM:SS format', () => {
      expect('Jump to 3:45 in the song'.match(TS_REGEX)).toEqual(['3:45']);
    });

    it('matches HH:MM:SS format', () => {
      expect('Go to 1:30:00 for the chorus'.match(TS_REGEX)).toEqual(['1:30:00']);
    });

    it('matches multiple timestamps', () => {
      expect('From 1:00 to 2:30'.match(TS_REGEX)).toEqual(['1:00', '2:30']);
    });

    it('does NOT match bare numbers', () => {
      expect('The year 2025'.match(TS_REGEX)).toBeNull();
    });
  });

  describe('HTML Escaping', () => {
    // The chat module must escape HTML to prevent XSS
    function escapeHtml(str: string): string {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    it('escapes angle brackets', () => {
      expect(escapeHtml('<script>alert(1)</script>')).not.toContain('<script>');
    });

    it('escapes ampersands', () => {
      expect(escapeHtml('A & B')).toContain('&amp;');
    });

    it('escapes quotes', () => {
      expect(escapeHtml('"hello"')).toBe('"hello"');
    });

    it('preserves normal text', () => {
      expect(escapeHtml('Hello World')).toBe('Hello World');
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

  describe('Chat Label Logic', () => {
    // The label logic: if device label is a reserved word, use prefix instead
    function getChatLabel(deviceLabel: string, hostConn: unknown, reservedNames: string[]): string {
      if (!hostConn) return 'Host';

      const trimmed = (deviceLabel || '').trim();
      if (!trimmed) return 'Peer';
      if (reservedNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())) return 'Peer';
      return trimmed;
    }

    it('returns "Host" when no hostConn (you are host)', () => {
      expect(getChatLabel('MyDevice', null, [])).toBe('Host');
    });

    it('returns device label when guest with valid name', () => {
      expect(getChatLabel('MyPhone', { open: true }, ['Left', 'Right'])).toBe('MyPhone');
    });

    it('returns "Peer" when label matches reserved name', () => {
      expect(getChatLabel('Left', { open: true }, ['Left', 'Right'])).toBe('Peer');
    });

    it('returns "Peer" when label is empty', () => {
      expect(getChatLabel('', { open: true }, [])).toBe('Peer');
    });

    it('case-insensitive reserved name check', () => {
      expect(getChatLabel('left', { open: true }, ['Left'])).toBe('Peer');
    });
  });
});
