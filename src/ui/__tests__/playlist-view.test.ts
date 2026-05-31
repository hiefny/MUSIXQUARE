/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';
import { setLanguageMode, t } from '../../i18n/index.ts';
import { initPlaylistView, updatePlaylistUI } from '../playlist-view.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  resetState();
  bus.clear();
  localStorage.clear();
  document.body.innerHTML = '<ul id="playlist-ui"></ul>';
  setLanguageMode('ko');
});

describe('playlist empty state i18n', () => {
  it('keeps the empty-state row translatable after playlist rerenders', () => {
    updatePlaylistUI();

    const empty = document.querySelector<HTMLElement>('.list-empty-state');
    expect(empty?.getAttribute('data-i18n')).toBe('playlist.empty_hint');

    setLanguageMode('en');

    expect(empty?.textContent).toBe(t('playlist.empty_hint'));
  });

  it('refreshes playlist-rendered copy when the language changes', async () => {
    initPlaylistView();
    updatePlaylistUI();

    setLanguageMode('en');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const empty = document.querySelector<HTMLElement>('.list-empty-state');
    expect(empty?.textContent).toBe('Please add media.');
  });
});
