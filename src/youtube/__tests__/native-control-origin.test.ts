import { describe, expect, it } from 'vitest';

import type { YouTubePlayerInstance } from '../_state.ts';
import {
  classifyYouTubeStableStateOrigin,
  expectYouTubeStableActivity,
  instrumentYouTubeStableControls,
} from '../native-control-origin.ts';

function createPlayer(initialState: number): YouTubePlayerInstance & { state: number } {
  let state = initialState;
  const player = {
    get state() {
      return state;
    },
    set state(value: number) {
      state = value;
    },
    playVideo: () => {
      state = 1;
    },
    pauseVideo: () => {
      state = 2;
    },
    loadVideoById: () => {
      state = 1;
    },
    loadPlaylist: () => {
      state = 1;
    },
    cueVideoById: () => {
      state = 2;
    },
    cuePlaylist: () => {
      state = 2;
    },
    getPlayerState: () => state,
  } as unknown as YouTubePlayerInstance & { state: number };
  return player;
}

describe('YouTube stable-control origin tracking', () => {
  it('classifies application play and pause calls as programmatic', () => {
    const player = createPlayer(2);
    expect(instrumentYouTubeStableControls(player)).toBe(true);

    player.playVideo();
    expect(classifyYouTubeStableStateOrigin(player, 'playing')).toBe('programmatic');

    player.pauseVideo();
    expect(classifyYouTubeStableStateOrigin(player, 'paused')).toBe('programmatic');
  });

  it('classifies application load and cue calls as programmatic', () => {
    const player = createPlayer(2);
    expect(instrumentYouTubeStableControls(player)).toBe(true);

    player.loadVideoById('video');
    expect(classifyYouTubeStableStateOrigin(player, 'playing')).toBe('programmatic');

    player.cueVideoById?.('video');
    expect(classifyYouTubeStableStateOrigin(player, 'paused')).toBe('programmatic');
  });

  it('arms load commands even when the outgoing iframe is already playing', () => {
    const player = createPlayer(1);
    expect(instrumentYouTubeStableControls(player)).toBe(true);

    player.loadVideoById('next-video');
    expect(classifyYouTubeStableStateOrigin(player, 'playing')).toBe('programmatic');
  });

  it('classifies an iframe-only stable transition as native', () => {
    const player = createPlayer(1);
    expect(instrumentYouTubeStableControls(player)).toBe(true);

    player.state = 2; // OS/iframe changed state without invoking pauseVideo().
    expect(classifyYouTubeStableStateOrigin(player, 'paused')).toBe('native');
  });

  it('arms the initial state expected from a newly-ready iframe', () => {
    const player = createPlayer(-1);
    expect(expectYouTubeStableActivity(player, 'playing')).toBe(true);

    player.state = 1;
    expect(classifyYouTubeStableStateOrigin(player, 'playing')).toBe('programmatic');
  });

  it('drops superseded cue expectations when a later play is observed', () => {
    const player = createPlayer(1);
    expect(instrumentYouTubeStableControls(player)).toBe(true);

    player.cueVideoById?.('video');
    player.playVideo();
    expect(classifyYouTubeStableStateOrigin(player, 'playing')).toBe('programmatic');

    player.state = 2;
    expect(classifyYouTubeStableStateOrigin(player, 'paused')).toBe('native');
  });

  it('does not leave an expectation behind when a wrapped command throws', () => {
    const player = createPlayer(2);
    player.playVideo = () => {
      throw new Error('iframe unavailable');
    };
    expect(instrumentYouTubeStableControls(player)).toBe(true);

    expect(() => player.playVideo()).toThrow('iframe unavailable');
    player.state = 1;
    expect(classifyYouTubeStableStateOrigin(player, 'playing')).toBe('native');
  });
});
