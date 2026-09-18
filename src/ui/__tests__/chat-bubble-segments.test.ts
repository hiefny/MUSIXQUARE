/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { fetchOEmbedTitle } from '../../youtube/oembed.ts';
import { addChatMessage, addWhisperMessage } from '../chat-render.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n/index.ts', () => ({
  t: (key: string, params?: { name?: string }) => {
    if (key === 'chat.cmd_whisper_to') return `To ${params?.name}`;
    if (key === 'chat.cmd_whisper_from') return `From ${params?.name}`;
    return key;
  },
}));

vi.mock('../../i18n/locale-fonts.ts', () => ({
  default: { preloadLocaleFontGlyphs: vi.fn(async () => true) },
}));

vi.mock('../../youtube/oembed.ts', () => ({
  fetchOEmbedTitle: vi.fn(async () => 'Resolved YouTube title'),
}));

const VIDEO_URL = 'https://youtu.be/dQw4w9WgXc';
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PL_example';

function bubbles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#chat-messages .chat-bubble'));
}

function sources(): Array<string | undefined> {
  return bubbles().map((bubble) => bubble.dataset.chatCopyText);
}

function expectOrderedRows(expected: string[], isMine: boolean, whisper = false): void {
  const rows = document.querySelectorAll<HTMLElement>('#chat-messages .chat-row');
  expect(rows).toHaveLength(expected.length);
  expect(sources()).toEqual(expected);
  for (const [index, row] of Array.from(rows).entries()) {
    const bubble = row.querySelector<HTMLElement>('.chat-bubble');
    expect(bubble).not.toBeNull();
    expect(row.querySelectorAll('.chat-bubble')).toHaveLength(1);
    expect(bubble?.classList.contains(isMine ? 'mine' : 'others')).toBe(true);
    expect(bubble?.classList.contains('whisper')).toBe(whisper);
    expect(bubble?.getAttribute('aria-describedby')).toBe('chat-copy-hint');
    expect(bubble?.querySelector('.chat-text')?.getAttribute('dir')).toBe('auto');
    const isVideo = expected[index].startsWith('https://');
    expect(bubble?.classList.contains('has-youtube')).toBe(isVideo);
    expect(bubble?.querySelectorAll('.chat-youtube-btn')).toHaveLength(isVideo ? 1 : 0);
    expect(row.querySelectorAll('.chat-time')).toHaveLength(index === rows.length - 1 ? 1 : 0);
  }
  const last = rows[rows.length - 1];
  expect(last.firstElementChild?.classList.contains('chat-time')).toBe(isMine);
  expect(last.lastElementChild?.classList.contains('chat-time')).toBe(!isMine);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-19T09:00:00'));
  vi.clearAllMocks();
  bus.clear();
  document.documentElement.dir = 'ltr';
  document.body.innerHTML = '<div id="chat-drawer"><div id="chat-messages"></div></div>';
  vi.mocked(fetchOEmbedTitle).mockResolvedValue('Resolved YouTube title');
});

afterEach(() => {
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ordered chat text and YouTube bubbles', () => {
  const cases = [
    { text: `Before ${VIDEO_URL}`, expected: ['Before', VIDEO_URL] },
    { text: `${VIDEO_URL} After`, expected: [VIDEO_URL, 'After'] },
    { text: `Before${VIDEO_URL}이후`, expected: ['Before', VIDEO_URL, '이후'] },
  ];

  it.each(cases.flatMap((testCase) => [true, false].map((isMine) => ({ ...testCase, isMine }))))(
    'keeps message order for $text (mine=$isMine)',
    ({ text, expected, isMine }) => {
      const rendered = vi.fn();
      bus.on('chat:message-rendered', rendered);

      addChatMessage('A sender', text, isMine, 'host', 2, 'member-a');

      expectOrderedRows(expected, isMine);
      expect(document.querySelectorAll('.chat-group')).toHaveLength(1);
      expect(document.querySelectorAll('.chat-sender')).toHaveLength(1);
      expect(document.querySelector('.chat-group')?.getAttribute('data-sender-id')).toBe(
        'member-a',
      );
      expect(document.querySelectorAll('.chat-badge-host')).toHaveLength(1);
      expect(rendered).toHaveBeenCalledExactlyOnceWith('A sender', text, isMine);
    },
  );

  it.each([true, false])('preserves whisper direction and label (sent=%s)', (isSent) => {
    const text = `Before ${VIDEO_URL} After`;
    const rendered = vi.fn();
    bus.on('chat:message-rendered', rendered);
    document.documentElement.dir = 'rtl';

    addWhisperMessage('Peer <name>', text, isSent);

    expectOrderedRows(['Before', VIDEO_URL, 'After'], isSent, true);
    const label = document.querySelector<HTMLElement>('.whisper-label');
    expect(label?.textContent).toBe(`${isSent ? 'To' : 'From'} Peer <name>`);
    expect(label?.dir).toBe('rtl');
    expect(label?.querySelector('bdi')?.textContent).toBe('Peer <name>');
    expect(label?.querySelector('bdi')?.dir).toBe('auto');
    expect(document.querySelectorAll('.chat-group.whisper')).toHaveLength(1);
    expect(rendered).toHaveBeenCalledExactlyOnceWith('Peer <name>', text, isSent);
  });

  it('renders adjacent cards without empty whitespace bubbles', () => {
    addChatMessage('Peer', ` \n${VIDEO_URL}\n \t ${PLAYLIST_URL} \n`, false);

    expectOrderedRows([VIDEO_URL, PLAYLIST_URL], false);
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('.chat-youtube-btn')).map(
        (button) => button.dataset.youtubeUrl,
      ),
    ).toEqual([VIDEO_URL, PLAYLIST_URL]);
  });

  it('preserves unsplit text whitespace and keeps timestamp actions in a text bubble', () => {
    const text = '  Two lines\n  Jump to 0:15  ';
    addChatMessage('Peer', text, false);

    expectOrderedRows([text], false);
    expect(document.querySelector('.chat-text')?.textContent).toBe(text);
    expect(document.querySelector('.chat-timestamp')?.getAttribute('data-seek')).toBe('15');
  });

  it('groups a subsequent split message without repeating labels or intermediate timestamps', () => {
    addChatMessage('Same person', 'Earlier', false, undefined, undefined, 'member-one');
    addChatMessage(
      'Renamed person',
      `Before ${VIDEO_URL} After`,
      false,
      undefined,
      undefined,
      'member-one',
    );

    expectOrderedRows(['Earlier', 'Before', VIDEO_URL, 'After'], false);
    expect(document.querySelectorAll('.chat-group')).toHaveLength(1);
    expect(document.querySelectorAll('.chat-sender')).toHaveLength(1);
    const rows = document.querySelectorAll<HTMLElement>('.chat-row');
    expect(rows[0].classList.contains('chat-enter')).toBe(false);
    for (const row of Array.from(rows).slice(1))
      expect(row.classList.contains('chat-enter')).toBe(true);
  });

  it('keeps source text copyable after titles resolve and applies each text script fallback', async () => {
    vi.mocked(fetchOEmbedTitle).mockResolvedValue('かな title');
    addChatMessage('Peer', `Привет ${VIDEO_URL} สวัสดี 0:15`, false);

    expect(document.querySelectorAll('.chat-text')[0].classList).toContain('user-text-font-ru');
    expect(document.querySelectorAll('.chat-text')[2].classList).toContain('user-text-font-th');
    expect(
      document.querySelector('.chat-timestamp')?.closest('.chat-bubble')?.classList,
    ).not.toContain('has-youtube');
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchOEmbedTitle).toHaveBeenCalledExactlyOnceWith(VIDEO_URL);
    expect(sources()).toEqual(['Привет', VIDEO_URL, 'สวัสดี 0:15']);
    expect(document.querySelector('.chat-yt-title')?.textContent).toBe('かな title');
    expect(document.querySelector('.chat-yt-title')?.classList).toContain('user-text-font-ja');
  });

  it.each([
    [`Before (${VIDEO_URL}) after`, VIDEO_URL, 'Before () after'],
    [
      `Before [${VIDEO_URL}?si=share-code&t=15#part] after`,
      `${VIDEO_URL}?si=share-code&t=15#part`,
      'Before [] after',
    ],
    [
      '앞https://youtube.com/watch?v=short_id&list=PL_test&index=2뒤',
      'https://youtube.com/watch?v=short_id&list=PL_test&index=2',
      '앞뒤',
    ],
    [
      `앞${VIDEO_URL}?si=A%2BB%3D&x=%EC%95%88%EB%85%95#t=0:15뒤`,
      `${VIDEO_URL}?si=A%2BB%3D&x=%EC%95%88%EB%85%95#t=0:15`,
      '앞뒤',
    ],
    ['앞https://youtube.com/shorts/short_id뒤', 'https://youtube.com/shorts/short_id', '앞뒤'],
  ])('does not consume prose or URL wrappers in %s', (text, expectedUrl, expectedProse) => {
    addChatMessage('Peer', text, false);

    expect(document.querySelectorAll('.chat-youtube-btn')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.chat-youtube-btn')?.dataset.youtubeUrl).toBe(
      expectedUrl,
    );
    expect(
      bubbles()
        .filter((bubble) => !bubble.classList.contains('has-youtube'))
        .map((bubble) => bubble.textContent)
        .join(''),
    ).toBe(expectedProse);
    expect(
      bubbles().find((bubble) => bubble.classList.contains('has-youtube'))?.dataset.chatCopyText,
    ).toBe(expectedUrl);
  });

  it('caps rendered rows rather than wire messages and removes emptied sender groups', () => {
    addChatMessage('Old sender', 'Old message', false);
    for (let index = 0; index < 100; index += 1) {
      addChatMessage(`Sender ${index}`, `${index} ${VIDEO_URL}`, false);
    }

    expect(document.querySelectorAll('.chat-row')).toHaveLength(200);
    expect(document.querySelectorAll('.chat-group')).toHaveLength(100);
    expect(sources()[0]).toBe('0');
    expect(sources().at(-1)).toBe(VIDEO_URL);
    for (const group of document.querySelectorAll('.chat-group')) {
      expect(group.querySelectorAll('.chat-row')).toHaveLength(2);
      expect(group.querySelectorAll('.chat-time')).toHaveLength(1);
    }
  });
});
