/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState } from '../../core/state.ts';
import type { TrackMeta } from '../../types/index.ts';
import { setPlaybackSystemAudioPlaying } from '../../player/ownership.ts';
import { restorePreSystemAudioPlaybackState } from '../system-capture.ts';

type Snapshot = Parameters<typeof restorePreSystemAudioPlaybackState>[0];
const YOUTUBE_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const {
    playback: playbackOverride,
    claimedSystemAudioTrackMeta: claimedSystemAudioTrackMetaOverride,
    ...rest
  } = overrides;
  return {
    room: {
      kind: 'standard',
      roomId: null,
      epoch: 0,
      standardPeerId: null,
    },
    positionSeconds: overrides.positionSeconds ?? 0,
    currentTrackMeta: null,
    channelMode: 0,
    queueItemId: null,
    subIndex: 0,
    ...rest,
    claimedSystemAudioTrackMeta: claimedSystemAudioTrackMetaOverride ?? null,
    playback: {
      mode: playbackOverride?.mode ?? null,
      activity: playbackOverride?.activity ?? 'idle',
    },
  };
}

function fileMeta(name = 'song.mp3'): TrackMeta {
  return {
    type: 'file',
    name,
    title: name,
    videoId: null,
    playlistId: null,
  };
}

function youtubeMeta(): TrackMeta {
  return {
    queueItemId: YOUTUBE_QUEUE_ITEM_ID,
    type: 'youtube',
    name: 'Video',
    title: 'Video',
    videoId: 'video-1',
    playlistId: null,
  };
}

beforeEach(() => {
  resetState();
  bus.clear();
  document.body.innerHTML = `
    <div id="grid-standard">
      <button class="ch-opt active" data-ch="0" aria-pressed="true"></button>
      <button class="ch-opt" data-ch="-1" aria-pressed="false"></button>
      <button class="ch-opt" data-ch="1" aria-pressed="false"></button>
    </div>
  `;
});

describe('restorePreSystemAudioPlaybackState', () => {
  it('restores prior file playback as a paused file shadow', () => {
    const meta = fileMeta();

    restorePreSystemAudioPlaybackState(
      makeSnapshot({
        playback: { mode: 'file', activity: 'playing' },
        positionSeconds: 12,
        currentTrackMeta: meta,
        channelMode: -1,
      }),
    );

    expect(getState('player.pausedAt')).toBe(12);
    expect(getState('player.currentTrackMeta')).toBe(meta);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
    expect(document.querySelector('.ch-opt[data-ch="-1"]')?.classList.contains('active')).toBe(
      true,
    );
    expect(document.querySelector('.ch-opt[data-ch="-1"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(document.querySelector('.ch-opt[data-ch="0"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('restores prior YouTube playback through the room command path', () => {
    const restore = vi.fn();
    const meta = youtubeMeta();
    bus.on('youtube:restore-room-playback', restore);

    restorePreSystemAudioPlaybackState(
      makeSnapshot({
        playback: { mode: 'youtube', activity: 'playing' },
        currentTrackMeta: meta,
        queueItemId: YOUTUBE_QUEUE_ITEM_ID,
        subIndex: 4,
      }),
    );

    expect(getState('player.currentTrackMeta')).toBe(meta);
    expect(restore).toHaveBeenCalledWith({
      videoId: 'video-1',
      playlistId: null,
      name: 'Video',
      queueItemId: YOUTUBE_QUEUE_ITEM_ID,
      autoplay: true,
      positionSeconds: 0,
      subIndex: 4,
    });
  });

  it('restores a paused YouTube snapshot at its exact position without autoplay', () => {
    const restore = vi.fn();
    const meta = youtubeMeta();
    bus.on('youtube:restore-room-playback', restore);

    restorePreSystemAudioPlaybackState(
      makeSnapshot({
        playback: { mode: 'youtube', activity: 'paused' },
        positionSeconds: 47.25,
        currentTrackMeta: meta,
        queueItemId: YOUTUBE_QUEUE_ITEM_ID,
        subIndex: 2,
      }),
    );

    expect(restore).toHaveBeenCalledWith(
      expect.objectContaining({
        queueItemId: YOUTUBE_QUEUE_ITEM_ID,
        autoplay: false,
        positionSeconds: 47.25,
        subIndex: 2,
      }),
    );
  });

  it('falls back to paused when a YouTube snapshot has no restorable id', () => {
    restorePreSystemAudioPlaybackState(
      makeSnapshot({
        playback: { mode: 'youtube', activity: 'playing' },
        currentTrackMeta: { type: 'youtube', name: 'Unknown', videoId: null, playlistId: null },
      }),
    );

    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
  });

  it('does not revive a pending file pipeline after capture stops', () => {
    restorePreSystemAudioPlaybackState(
      makeSnapshot({
        playback: { mode: 'file', activity: 'pending' },
        currentTrackMeta: fileMeta('pending.mp3'),
      }),
    );

    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('maps a previous system-audio owner to the existing paused fallback', () => {
    restorePreSystemAudioPlaybackState(
      makeSnapshot({
        playback: { mode: 'system-audio', activity: 'playing' },
      }),
    );

    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
  });

  it('restores idle snapshots to idle', () => {
    setPlaybackSystemAudioPlaying();

    restorePreSystemAudioPlaybackState(makeSnapshot());

    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });
});
