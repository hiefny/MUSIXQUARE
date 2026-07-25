#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    source = path.read_text(encoding="utf-8")
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    path.write_text(source.replace(old, new, 1), encoding="utf-8")


authority = Path("src/youtube/native-control-authority.ts")
replace_once(
    authority,
    """function pauseUntilAuthority(player: YouTubePlayerInstance): void {
  try {
    player.pauseVideo?.();
  } catch (error) {
    log.debug('[YouTube Native Control] Corrective authority pause failed', error);
  }
}

""",
    "",
    "remove eager authority pause helper",
)
replace_once(
    authority,
    """  setLocalYouTubePaused(false);
  if (action === 'play' && route !== 'standard-host') pauseUntilAuthority(player);

""",
    """  setLocalYouTubePaused(false);

""",
    "preserve trusted native play",
)
replace_once(
    authority,
    """  if (route === 'pro-controller') {
    routeProPlaybackCommand(
      { kind: action, queueItemId, positionSeconds },
      { wasPlaying: previous === 'playing' },
    );
    log.info(`[YouTube Native Control] Routed ${action} through PRO authority`);
    return;
  }
""",
    """  if (route === 'pro-controller') {
    if (action === 'play') {
      // The iframe is already playing under a trusted OS media gesture.
      // Keep it alive while the server establishes the canonical timeline;
      // pausing first makes iOS reject the later asynchronous playVideo().
      routeProPlaybackCommand({ kind: 'play', queueItemId, positionSeconds });
    } else {
      routeProPlaybackCommand(
        { kind: 'pause', queueItemId, positionSeconds },
        { wasPlaying: previous === 'playing' },
      );
    }
    log.info(`[YouTube Native Control] Routed ${action} through PRO authority`);
    return;
  }
""",
    "PRO native play routing",
)
replace_once(
    authority,
    """  if (route === 'standard-controller') {
    if (!hostConn?.open) return;
    safeSend(hostConn, {
      type: action === 'play' ? MSG.REQUEST_YOUTUBE_PLAY : MSG.REQUEST_YOUTUBE_PAUSE,
      queueItemId,
    });
    log.info(`[YouTube Native Control] Requested standard-room ${action}`);
    return;
  }
""",
    """  if (route === 'standard-controller') {
    if (!hostConn?.open) return;
    const sent = safeSend(hostConn, {
      type: action === 'play' ? MSG.REQUEST_YOUTUBE_PLAY : MSG.REQUEST_YOUTUBE_PAUSE,
      queueItemId,
    });
    if (!sent && action === 'play') {
      // Fail closed only when the request could not leave this endpoint. A
      // successfully sent OS PLAY must remain audible so iOS keeps the trusted
      // media gesture alive until the host's synchronized command arrives.
      try {
        player.pauseVideo?.();
      } catch (error) {
        log.debug('[YouTube Native Control] Failed to restore pause after send failure', error);
      }
    }
    log.info(`[YouTube Native Control] Requested standard-room ${action}`);
    return;
  }
""",
    "standard controller native play routing",
)


test_path = Path("src/youtube/__tests__/native-control-play-resume.test.ts")
if test_path.exists():
    raise SystemExit(f"{test_path} already exists")
test_path.write_text(
    """/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  routeProPlaybackCommand: vi.fn(() => true),
  safeSend: vi.fn(() => true),
}));

vi.mock('../../pro-room/playback-authority-hooks.ts', () => ({
  routeProPlaybackCommand: mocks.routeProPlaybackCommand,
}));

vi.mock('../../network/peer.ts', () => ({
  safeSend: mocks.safeSend,
}));

import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setPlaybackYouTubePaused, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { PlaylistItem, QueueItemId } from '../../types/index.ts';
import {
  markYtPlayerReady,
  resetYouTubeModuleState,
  setLocalYouTubePaused,
  setYouTubePlayer,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from '../_state.ts';
import { initYouTubeNativeControlAuthority } from '../native-control-authority.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'abcdefghijk';

interface FakePlayer extends YouTubePlayerInstance {
  state: number;
}

function createPlayer(initialState = 2): FakePlayer {
  let state = initialState;
  return {
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
    stopVideo: () => {
      state = 0;
    },
    destroy: () => undefined,
    seekTo: () => undefined,
    getCurrentTime: () => 42.25,
    getDuration: () => 300,
    getPlayerState: () => state,
    getPlaylistIndex: () => 0,
    getVideoData: () => ({ video_id: VIDEO_ID, title: 'Video' }),
    getPlaylist: () => [VIDEO_ID],
    setVolume: () => undefined,
  };
}

function installPausedYouTube(player: FakePlayer): void {
  const item = {
    queueItemId: QUEUE_ITEM_ID,
    type: 'youtube',
    name: 'Video',
    title: 'Video',
    videoId: VIDEO_ID,
    playlistId: null,
  } as PlaylistItem;
  setState('playlist.items', [item]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setYouTubePlayer(player);
  markYtPlayerReady(player);
  setYtAutoplayIntent(false);
  setPlaybackYouTubePaused();
  initYouTubeNativeControlAuthority();
  bus.emit('youtube:player-ready');
}

function emitNativePlay(player: FakePlayer): void {
  player.state = 1;
  setPlaybackYouTubePlaying();
}

beforeEach(() => {
  clearAllManagedTimers();
  bus.clear();
  resetState();
  resetYouTubeModuleState();
  setLocalYouTubePaused(false);
  vi.clearAllMocks();
});

afterEach(() => {
  clearAllManagedTimers();
});

describe('iframe-native YouTube PLAY authority', () => {
  it('keeps a standard-room controller playing while requesting host rendezvous', () => {
    const hostConn = { open: true, peer: 'host', send: vi.fn() } as never;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['playback.control']);
    const player = createPlayer();
    installPausedYouTube(player);

    emitNativePlay(player);

    expect(player.state).toBe(1);
    expect(mocks.safeSend).toHaveBeenCalledWith(hostConn, {
      type: MSG.REQUEST_YOUTUBE_PLAY,
      queueItemId: QUEUE_ITEM_ID,
    });
  });

  it('keeps a PRO controller playing while the server establishes canonical playback', () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 7,
      snapshotRevision: 11,
      capabilities: ['playback.control'],
    });
    const player = createPlayer();
    installPausedYouTube(player);

    emitNativePlay(player);

    expect(player.state).toBe(1);
    expect(mocks.routeProPlaybackCommand).toHaveBeenCalledWith({
      kind: 'play',
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 42.25,
    });
  });

  it('restores pause when a standard controller cannot send the authority request', () => {
    mocks.safeSend.mockReturnValueOnce(false);
    const hostConn = { open: true, peer: 'host', send: vi.fn() } as never;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['playback.control']);
    const player = createPlayer();
    installPausedYouTube(player);

    emitNativePlay(player);

    expect(player.state).toBe(2);
  });
});
""",
    encoding="utf-8",
)

replace_once(
    Path("public/service-worker.js"),
    "const CACHE_VERSION = 'v277';",
    "const CACHE_VERSION = 'v278';",
    "service worker cache generation",
)
replace_once(
    Path("src/core/__tests__/service-worker-cache.test.ts"),
    "const ACTIVE_CACHE_VERSION = 'v277';",
    "const ACTIVE_CACHE_VERSION = 'v278';",
    "service worker test generation",
)
