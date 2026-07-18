/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { upsertBotChatMessage } from '../chat-render.ts';

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../youtube/oembed.ts', () => ({
  fetchOEmbedTitle: vi.fn(async () => null),
}));

function renderShell(): HTMLElement {
  document.body.innerHTML = `
    <div id="chat-drawer"></div>
    <div id="chat-messages"><div class="chat-empty"></div></div>
  `;
  return document.getElementById('chat-messages') as HTMLElement;
}

describe('BOT chat bubble renderer', () => {
  beforeEach(() => {
    bus.clear();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('creates an accessible three-dot typing bubble', () => {
    renderShell();

    upsertBotChatMessage('request-1', 'typing');

    const group = document.querySelector<HTMLElement>('.chat-group.bot');
    const bubble = group?.querySelector<HTMLElement>('.chat-bubble.bot');
    expect(group?.dataset.botRequestId).toBe('request-1');
    expect(group?.dataset.botState).toBe('typing');
    expect(bubble?.classList.contains('is-typing')).toBe(true);
    expect(bubble?.getAttribute('role')).toBe('status');
    expect(bubble?.getAttribute('aria-live')).toBe('polite');
    expect(bubble?.getAttribute('aria-busy')).toBe('true');
    expect(bubble?.getAttribute('aria-label')).toBe('chat.bot_processing');
    expect(bubble?.querySelectorAll('.chat-bot-typing-dot')).toHaveLength(3);
    expect(document.querySelector('.chat-empty')).toBeNull();
    expect(document.getElementById('chat-drawer')?.classList.contains('has-messages')).toBe(true);
  });

  it('reuses the same group and bubble for terminal text and emits once', () => {
    renderShell();
    const rendered = vi.fn();
    bus.on('chat:message-rendered', rendered);

    upsertBotChatMessage('request-2', 'typing');
    const originalGroup = document.querySelector<HTMLElement>('.chat-group.bot');
    const originalBubble = originalGroup?.querySelector<HTMLElement>('.chat-bubble.bot');

    upsertBotChatMessage('request-2', 'complete', '셔플 재생을 켰어요');
    upsertBotChatMessage('request-2', 'complete', 'duplicate terminal text');
    upsertBotChatMessage('request-2', 'typing');

    const currentGroup = document.querySelector<HTMLElement>('.chat-group.bot');
    const currentBubble = currentGroup?.querySelector<HTMLElement>('.chat-bubble.bot');
    expect(currentGroup).toBe(originalGroup);
    expect(currentBubble).toBe(originalBubble);
    expect(document.querySelectorAll('.chat-group.bot')).toHaveLength(1);
    expect(currentGroup?.dataset.botState).toBe('complete');
    expect(currentBubble?.classList.contains('is-complete')).toBe(true);
    expect(currentBubble?.classList.contains('is-typing')).toBe(false);
    expect(currentBubble?.getAttribute('aria-busy')).toBe('false');
    expect(currentBubble?.hasAttribute('aria-label')).toBe(false);
    expect(currentBubble?.querySelector('.chat-text')?.textContent).toBe('셔플 재생을 켰어요');
    expect(currentBubble?.querySelector('.chat-bot-typing')).toBeNull();
    expect(rendered).toHaveBeenCalledOnce();
    expect(rendered).toHaveBeenCalledWith('BOT', '셔플 재생을 켰어요', false);
  });

  it('keeps model-authored markup inert', () => {
    renderShell();
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';

    upsertBotChatMessage('request-xss', 'complete', payload);

    const text = document.querySelector<HTMLElement>('.chat-bubble.bot .chat-text');
    expect(text?.textContent).toBe(payload);
    expect(text?.querySelector('img,script')).toBeNull();
    expect(text?.innerHTML).not.toContain('<img');
    expect(text?.innerHTML).not.toContain('<script');
  });

  it('keeps separate request ids in separate independent groups', () => {
    renderShell();

    upsertBotChatMessage('request-a', 'typing');
    upsertBotChatMessage('request-b', 'complete', '두 번째 응답');

    const groups = document.querySelectorAll<HTMLElement>('.chat-group.bot');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.dataset.botRequestId).toBe('request-a');
    expect(groups[0]?.dataset.botState).toBe('typing');
    expect(groups[1]?.dataset.botRequestId).toBe('request-b');
    expect(groups[1]?.dataset.botState).toBe('complete');
  });

  it('preserves a user scroll position while updating above the bottom', () => {
    const container = renderShell();
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });

    upsertBotChatMessage('request-scroll', 'typing');
    expect(container.scrollTop).toBe(100);

    upsertBotChatMessage('request-scroll', 'complete', '완료');
    expect(container.scrollTop).toBe(100);
  });

  it('keeps a sticky-bottom reader pinned to the latest BOT state', () => {
    const container = renderShell();
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 500 },
    });

    upsertBotChatMessage('request-bottom', 'typing');
    expect(container.scrollTop).toBe(600);

    upsertBotChatMessage('request-bottom', 'complete', '완료');
    expect(container.scrollTop).toBe(600);
  });
});
