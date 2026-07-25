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
    "  setLocalYouTubePaused,\n  type YouTubePlayerInstance,\n",
    "  setLocalYouTubePaused,\n  setYtAutoplayIntent,\n  type YouTubePlayerInstance,\n",
    "authority state import",
)

player_match = """function playerMatchesCurrentOccurrence(
  player: YouTubePlayerInstance,
  queueItemId: QueueItemId,
): boolean {
  let liveVideoId: string;
  try {
    liveVideoId = player.getVideoData?.()?.video_id || '';
  } catch {
    return false;
  }
  const intendedVideoId = resolveIntendedVideoId(queueItemId);
  return !(liveVideoId && intendedVideoId && liveVideoId !== intendedVideoId);
}
"""

helper = """
/**
 * Preserve a trusted OS/headset PLAY long enough for PRO room authority
 * to observe and promote it. PRO pause commits deliberately leave
 * `ytAutoplayIntent=false`; without this pre-guard seam the iframe's
 * PLAYING callback immediately pauses back before playback activity can
 * reach the native-control authority listener.
 *
 * Only an unmatched native transition from the exact current iframe and
 * queue occurrence may cross the guard. Application-owned play/load/cue
 * transitions retain the existing pause-back behaviour.
 */
export function preserveNativeProControllerPlayBeforeAutoplayGuard(
  player: YouTubePlayerInstance,
): boolean {
  if (
    getYtAutoplayIntent() ||
    getState('playback.mode') !== 'youtube' ||
    getRoomContext().kind !== 'pro' ||
    !hasRoomCapability('playback.control') ||
    getYouTubePlayer() !== player ||
    hasProtectedTransitionOwner()
  ) {
    return false;
  }

  const queueItemId = getCurrentQueueItemId();
  if (!queueItemId || !playerMatchesCurrentOccurrence(player, queueItemId)) return false;
  if (classifyYouTubeStableStateOrigin(player, 'playing') !== 'native') return false;

  setYtAutoplayIntent(true);
  log.info('[YouTube Native Control] Preserved native PRO PLAY through autoplay guard');
  return true;
}
"""
replace_once(authority, player_match, player_match + helper, "authority pre-guard helper")

iframe = Path("src/youtube/iframe.ts")
replace_once(
    iframe,
    "} from './player.ts';\nimport {\n  handleYouTubeZeroStartPlayerState,\n",
    "} from './player.ts';\n"
    "import { preserveNativeProControllerPlayBeforeAutoplayGuard } from './native-control-authority.ts';\n"
    "import {\n  handleYouTubeZeroStartPlayerState,\n",
    "iframe native authority import",
)
replace_once(
    iframe,
    "    // Pause-back if autoplay was not intended (e.g. loadPlaylist async path).\n"
    "    if (!getYtAutoplayIntent()) {\n",
    "    // A PRO administrator's OS/headset PLAY reaches the iframe before\n"
    "    // MUSIXQUARE playback state. Preserve only a proven native PLAY so\n"
    "    // the authority listener can promote it instead of pause-backing it.\n"
    "    preserveNativeProControllerPlayBeforeAutoplayGuard(player);\n\n"
    "    // Pause-back if autoplay was not intended (e.g. loadPlaylist async path).\n"
    "    if (!getYtAutoplayIntent()) {\n",
    "iframe autoplay guard seam",
)

test_path = Path("src/youtube/__tests__/native-control-pro-autoplay-guard.test.ts")
if test_path.exists():
    raise SystemExit(f"{test_path} already exists")
test_path.write_text(
    r'''/**
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

import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setPlaybackYouTubePaused, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { PlaylistItem, QueueItemId } from '../../types/index.ts';
import {
  getYtAutoplayIntent,
  markYtPlayerReady,
  resetYouTubeModuleState,
  setLocalYouTubePaused,
  setYouTubePlayer,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from '../_state.ts';
import {
  initYouTubeNativeControlAuthority,
  preserveNativeProControllerPlayBeforeAutoplayGuard,
} from '../native-control-authority.ts';

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

function installPausedYouTube(player: FakePlayer, capabilities: string[]): void {
  const item = {
    queueItemId: QUEUE_ITEM_ID,
    type: 'youtube',
    name: 'Video',
    title: 'Video',
    videoId: VIDEO_ID,
    playlistId: null,
  } as PlaylistItem;
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role: 'member',
    coordinatorId: null,
    epoch: 7,
    snapshotRevision: 11,
    capabilities,
  });
  setState('playlist.items', [item]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setYouTubePlayer(player);
  markYtPlayerReady(player);
  setYtAutoplayIntent(false);
  setPlaybackYouTubePaused();
  initYouTubeNativeControlAuthority();
  bus.emit('youtube:player-ready');
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

describe('PRO iframe-native PLAY before the autoplay guard', () => {
  it('preserves a native administrator PLAY and then routes it to PRO authority', () => {
    const player = createPlayer();
    installPausedYouTube(player, ['playback.control']);

    // OS/headset changes the iframe internally, bypassing wrapped JS methods.
    player.state = 1;

    expect(preserveNativeProControllerPlayBeforeAutoplayGuard(player)).toBe(true);
    expect(getYtAutoplayIntent()).toBe(true);

    // This is the normal projection performed later in the iframe callback.
    setPlaybackYouTubePlaying();

    expect(mocks.routeProPlaybackCommand).toHaveBeenCalledWith({
      kind: 'play',
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 42.25,
    });
  });

  it('keeps application-owned PLAY behind the existing pause-back guard', () => {
    const player = createPlayer();
    installPausedYouTube(player, ['playback.control']);

    // The instrumented method arms a programmatic PLAY expectation.
    player.playVideo();

    expect(preserveNativeProControllerPlayBeforeAutoplayGuard(player)).toBe(false);
    expect(getYtAutoplayIntent()).toBe(false);
    expect(mocks.routeProPlaybackCommand).not.toHaveBeenCalled();
  });

  it('does not grant a PRO listener room-wide playback authority', () => {
    const player = createPlayer();
    installPausedYouTube(player, []);
    player.state = 1;

    expect(preserveNativeProControllerPlayBeforeAutoplayGuard(player)).toBe(false);
    expect(getYtAutoplayIntent()).toBe(false);
    expect(mocks.routeProPlaybackCommand).not.toHaveBeenCalled();
  });
});
''',
    encoding="utf-8",
)

replace_once(
    Path("public/service-worker.js"),
    "const CACHE_VERSION = 'v278';",
    "const CACHE_VERSION = 'v279';",
    "service worker cache version",
)
replace_once(
    Path("src/core/__tests__/service-worker-cache.test.ts"),
    "const ACTIVE_CACHE_VERSION = 'v278';",
    "const ACTIVE_CACHE_VERSION = 'v279';",
    "service worker test cache version",
)
