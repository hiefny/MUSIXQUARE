/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import '../video.ts';
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

// External sink contract: each playback mode produces a deterministic body
// class set and YouTube container visibility. Future modes added to
// PlaybackMode must extend this table; a mode falling through to the default
// (no classes, hidden container) without an explicit row is a regression.
describe('body class sink (playback.mode matrix)', () => {
  type Row = {
    mode: 'file' | 'youtube' | 'system-audio' | null;
    youtubeClass: boolean;
    systemAudioClass: boolean;
    ytContainerVisible: boolean;
  };

  const MATRIX: Row[] = [
    { mode: null, youtubeClass: false, systemAudioClass: false, ytContainerVisible: false },
    { mode: 'file', youtubeClass: false, systemAudioClass: false, ytContainerVisible: false },
    { mode: 'youtube', youtubeClass: true, systemAudioClass: false, ytContainerVisible: true },
    { mode: 'system-audio', youtubeClass: false, systemAudioClass: true, ytContainerVisible: false },
  ];

  for (const { mode, youtubeClass, systemAudioClass, ytContainerVisible } of MATRIX) {
    it(`mode=${mode ?? 'null'} -> classes(${youtubeClass ? 'mode-youtube' : '-'}, ${systemAudioClass ? 'mode-system-audio' : '-'}), container ${ytContainerVisible ? 'shown' : 'hidden'}`, () => {
      // Force the bus subscriber to fire even when the target mode equals
      // the initial state by transitioning through a sentinel first. Direct
      // setState short-circuits on same-value writes.
      const sentinel = mode === 'file' ? 'youtube' : 'file';
      setState('playback.mode', sentinel);
      // Prime body with the opposite state so toggle effects are observable.
      document.body.classList.add('mode-youtube', 'mode-system-audio');

      setState('playback.mode', mode);

      expect(document.body.classList.contains('mode-youtube')).toBe(youtubeClass);
      expect(document.body.classList.contains('mode-system-audio')).toBe(systemAudioClass);

      const container = document.getElementById('youtube-player-container') as HTMLElement;
      if (ytContainerVisible) {
        expect(container.style.display).toBe('block');
        expect(container.style.opacity).toBe('1');
      } else {
        expect(container.style.display).toBe('none');
        expect(container.style.opacity).toBe('0');
      }
    });
  }
});
