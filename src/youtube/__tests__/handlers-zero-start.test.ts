/**
 * @vitest-environment jsdom
 *
 * Dispatch-boundary tests for the operator handlers that may opt into the
 * zero-start path. The controller itself is covered separately; these tests
 * pin which user actions are allowed to enter it and which must retain the
 * established legacy rendezvous behavior.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';

const QUEUE_ITEM_ID = '22222222-2222-4222-8222-222222222222';
const VIDEO_ID = 'M7lc1UVf-VE';

const playerFacade = vi.hoisted(() => ({
  currentTime: 0,
  duration: 300,
  state: 2,
  videoId: 'M7lc1UVf-VE',
  loadVideoById: vi.fn(),
}));

const zeroStartFacade = vi.hoisted(() => ({ accepted: false }));
const scheduleYtAutoSync = vi.hoisted(() => vi.fn());
const tryBeginYouTubeZeroStart = vi.hoisted(() => vi.fn(() => zeroStartFacade.accepted));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../network/peer.ts', () => ({ safeSend: vi.fn(() => true) }));
vi.mock('../../network/protocol.ts', () => ({ verifyOperator: vi.fn(() => true) }));

vi.mock('../player.ts', () => ({ scheduleYtAutoSync, tryBeginYouTubeZeroStart }));

vi.mock('../_state.ts', () => ({
  getYouTubePlayer: vi.fn(() => ({
    getCurrentTime: () => playerFacade.currentTime,
    getDuration: () => playerFacade.duration,
    getPlayerState: () => playerFacade.state,
    getVideoData: () => ({ video_id: playerFacade.videoId }),
    loadVideoById: playerFacade.loadVideoById,
    pauseVideo: vi.fn(),
  })),
  setLocalYouTubePaused: vi.fn(),
  setYouTubeSubIndex: vi.fn(),
}));

vi.mock('../iframe.ts', () => ({ loadYouTubeVideo: vi.fn() }));
vi.mock('../local-offset.ts', () => ({
  toCanonicalYouTubeTime: vi.fn((seconds: number) => seconds),
}));
vi.mock('../../storage/transfer-receive.ts', () => ({ cancelIncomingFileTransfer: vi.fn() }));
vi.mock('../../share/remote-share.ts', () => ({ cancelRemoteShareWait: vi.fn() }));
vi.mock('../../player/ownership.ts', () => ({ setPlaybackTrackMeta: vi.fn() }));
vi.mock('../../player/queue-model.ts', () => ({
  getCurrentQueueItemId: vi.fn(() => QUEUE_ITEM_ID),
  getQueueItemById: vi.fn(() => ({
    queueItemId: QUEUE_ITEM_ID,
    type: 'youtube',
    name: 'Test video',
    videoId: VIDEO_ID,
    playlistId: null,
  })),
  selectQueueItemById: vi.fn(() => true),
}));

import {
  handleRequestYouTubePause,
  handleRequestYouTubePlay,
  handleRequestYouTubeToggle,
} from '../handlers.ts';

const operatorConnection = { peer: 'operator-peer', open: true } as never;
const request = { queueItemId: QUEUE_ITEM_ID };

describe('YouTube operator handler zero-start dispatch', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
    playerFacade.currentTime = 0;
    playerFacade.duration = 300;
    playerFacade.state = 2;
    playerFacade.videoId = VIDEO_ID;
    zeroStartFacade.accepted = false;
    setState('youtube.currentSubIndex', 0);
    vi.stubGlobal('YT', { PlayerState: { PLAYING: 1 } });
  });

  it('lets a zero-second operator resume use zero-start when the cohort accepts it', () => {
    zeroStartFacade.accepted = true;

    handleRequestYouTubePlay(request, operatorConnection);

    expect(tryBeginYouTubeZeroStart).toHaveBeenCalledWith(VIDEO_ID, 0);
    expect(scheduleYtAutoSync).not.toHaveBeenCalled();
  });

  it('keeps an ordinary non-zero operator resume on legacy rendezvous', () => {
    playerFacade.currentTime = 12;
    zeroStartFacade.accepted = true;

    handleRequestYouTubePlay(request, operatorConnection);

    expect(tryBeginYouTubeZeroStart).not.toHaveBeenCalled();
    expect(scheduleYtAutoSync).toHaveBeenCalledWith(12);
  });

  it('falls back atomically to legacy when zero-second capability negotiation declines', () => {
    handleRequestYouTubeToggle(request, operatorConnection);

    expect(tryBeginYouTubeZeroStart).toHaveBeenCalledWith(VIDEO_ID, 0);
    expect(scheduleYtAutoSync).toHaveBeenCalledWith(0);
  });

  it('never sends an ordinary pause through zero-start', () => {
    playerFacade.currentTime = 27;
    playerFacade.state = 1;
    zeroStartFacade.accepted = true;

    handleRequestYouTubePause(request, operatorConnection);

    expect(tryBeginYouTubeZeroStart).not.toHaveBeenCalled();
    expect(scheduleYtAutoSync).toHaveBeenCalledWith(27, { state: 2 });
  });
});
