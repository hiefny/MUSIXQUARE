import { describe, expect, it, vi } from 'vitest';
import { applyYouTubeCaptionPolicy, type YouTubeCaptionPolicyPlayer } from '../caption-policy.ts';

function makePlayer(
  options: {
    modules?: string[];
    captionOptions?: string[];
    track?: unknown;
    videoId?: string;
    setOption?: (module: string, option: string, value: unknown) => void;
  } = {},
): YouTubeCaptionPolicyPlayer {
  return {
    getOptions: vi.fn((module?: string) =>
      module ? options.captionOptions || [] : options.modules || [],
    ),
    getOption: vi.fn(() => options.track),
    setOption: vi.fn(options.setOption || (() => {})),
    getVideoData: vi.fn(() => ({ video_id: options.videoId || 'video-1' })),
  };
}

describe('YouTube caption policy', () => {
  it('attempts legacy track clearing and independently applies the supported minimum size', () => {
    const player = makePlayer({
      modules: ['captions'],
      captionOptions: ['reload', 'fontSize', 'track'],
      track: { languageCode: 'en', name: 'English' },
    });

    expect(applyYouTubeCaptionPolicy(player, 1)).toBe('applied');
    expect(player.setOption).toHaveBeenNthCalledWith(1, 'captions', 'track', {});
    expect(player.setOption).toHaveBeenNthCalledWith(2, 'captions', 'fontSize', -1);
    expect(applyYouTubeCaptionPolicy(player, 1)).toBe('already-applied');
    expect(player.setOption).toHaveBeenCalledTimes(2);
  });

  it('still applies minimum size when the undocumented track command throws', () => {
    const setOption = vi.fn((_module: string, option: string) => {
      if (option === 'track') throw new Error('unsupported');
    });
    const player = makePlayer({
      modules: ['captions'],
      captionOptions: ['track', 'fontSize'],
      track: { languageCode: 'ko' },
      setOption,
    });

    expect(() => applyYouTubeCaptionPolicy(player, 2)).not.toThrow();
    expect(setOption).toHaveBeenCalledWith('captions', 'fontSize', -1);
  });

  it('uses only the supported fallback when track is not exposed', () => {
    const player = makePlayer({
      modules: ['captions'],
      captionOptions: ['fontSize', 'reload'],
    });

    expect(applyYouTubeCaptionPolicy(player, 3)).toBe('applied');
    expect(player.setOption).toHaveBeenCalledOnce();
    expect(player.setOption).toHaveBeenCalledWith('captions', 'fontSize', -1);
  });

  it('contains API errors without touching any playback surface', () => {
    const player: YouTubeCaptionPolicyPlayer = {
      getOptions: vi.fn(() => {
        throw new Error('player unavailable');
      }),
      setOption: vi.fn(),
    };

    expect(applyYouTubeCaptionPolicy(player, 4)).toBe('unavailable');
    expect(player.setOption).not.toHaveBeenCalled();
    expect('playVideo' in player).toBe(false);
    expect('pauseVideo' in player).toBe(false);
    expect('seekTo' in player).toBe(false);
  });

  it('reapplies for a new video, a new session, and after module reload', () => {
    let modules = ['captions'];
    let videoId = 'video-a';
    const player: YouTubeCaptionPolicyPlayer = {
      getOptions: vi.fn((module?: string) => (module ? ['fontSize'] : modules)),
      getOption: vi.fn(() => null),
      setOption: vi.fn(),
      getVideoData: vi.fn(() => ({ video_id: videoId })),
    };

    expect(applyYouTubeCaptionPolicy(player, 5)).toBe('applied');
    expect(applyYouTubeCaptionPolicy(player, 5)).toBe('already-applied');

    videoId = 'video-b';
    expect(applyYouTubeCaptionPolicy(player, 5)).toBe('applied');
    expect(applyYouTubeCaptionPolicy(player, 6)).toBe('applied');

    modules = [];
    expect(applyYouTubeCaptionPolicy(player, 6)).toBe('unavailable');
    modules = ['captions'];
    expect(applyYouTubeCaptionPolicy(player, 6)).toBe('applied');
    expect(player.setOption).toHaveBeenCalledTimes(4);
  });
});
