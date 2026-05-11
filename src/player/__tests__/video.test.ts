/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { APP_STATE } from '../../core/constants.ts';
import { getState, resetState } from '../../core/state.ts';
import { setPlaybackAppState } from '../ownership.ts';
import { setEngineMode } from '../video.ts';

beforeEach(() => {
  resetState();
  document.body.innerHTML = '<div id="youtube-player-container"></div>';
  document.body.className = '';
});

describe('setEngineMode', () => {
  it('keeps decoded file engines paused when playback is not currently playing', () => {
    setEngineMode('buffer');

    expect(getState('appState')).toBe(APP_STATE.PAUSED);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
  });

  it('keeps decoded file engines playing when playback is already active', () => {
    setPlaybackAppState(APP_STATE.PLAYING_AUDIO);

    setEngineMode('buffer');

    expect(getState('appState')).toBe(APP_STATE.PLAYING_AUDIO);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('playing');
  });

  it('always claims YouTube mode directly', () => {
    setEngineMode('youtube');

    expect(getState('appState')).toBe(APP_STATE.PLAYING_YOUTUBE);
    expect(getState('playback.mode')).toBe('youtube');
    expect(getState('playback.activity')).toBe('playing');
    expect(document.body.classList.contains('mode-youtube')).toBe(true);
  });
});
