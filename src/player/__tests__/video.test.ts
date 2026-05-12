/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getState, resetState } from '../../core/state.ts';
import { setPlaybackFilePlaying } from '../ownership.ts';
import { setEngineMode } from '../video.ts';

beforeEach(() => {
  resetState();
  document.body.innerHTML = '<div id="youtube-player-container"></div>';
  document.body.className = '';
});

describe('setEngineMode', () => {
  it('keeps decoded file engines paused when playback is not currently playing', () => {
    setEngineMode('buffer');

    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
  });

  it('keeps decoded file engines playing when playback is already active', () => {
    setPlaybackFilePlaying();

    setEngineMode('buffer');

    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('playing');
  });

  it('always claims YouTube mode directly', () => {
    setEngineMode('youtube');

    expect(getState('playback.mode')).toBe('youtube');
    expect(getState('playback.activity')).toBe('playing');
    expect(document.body.classList.contains('mode-youtube')).toBe(true);
  });
});
