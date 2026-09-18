import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearManagedTimer } from '../../core/timers.ts';
import { cancelRemoteShareWait } from '../../share/remote-share.ts';
import { cancelIncomingFileTransfer } from '../../storage/transfer-receive.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import { setLocalYouTubePaused } from '../../youtube/_state.ts';
import { handleYouTubePlay } from '../../youtube/handlers.ts';
import { loadYouTubeVideo } from '../../youtube/iframe.ts';
import { handleData, registerHandler } from '../protocol.ts';
import { markQueueAuthorityReady } from '../queue-authority.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../core/timers.ts', () => ({ clearManagedTimer: vi.fn() }));
vi.mock('../peer.ts', () => ({ safeSend: vi.fn(() => true) }));
vi.mock('../../storage/transfer-receive.ts', () => ({ cancelIncomingFileTransfer: vi.fn() }));
vi.mock('../../share/remote-share.ts', () => ({ cancelRemoteShareWait: vi.fn() }));
vi.mock('../../youtube/_state.ts', () => ({
  getYouTubePlayer: vi.fn(() => null),
  setLocalYouTubePaused: vi.fn(),
  setYouTubeSubIndex: vi.fn(),
}));
vi.mock('../../youtube/iframe.ts', () => ({
  adoptResidentYouTubeOccurrence: vi.fn(),
  loadYouTubeVideo: vi.fn(),
}));
vi.mock('../../youtube/local-offset.ts', () => ({
  toCanonicalYouTubeTime: vi.fn((seconds: number) => seconds),
}));

const FILE_ID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const YOUTUBE_ID = '00000000-0000-4000-8000-000000000002' as QueueItemId;
const REMOVED_ID = '00000000-0000-4000-8000-000000000003' as QueueItemId;
const VIDEO_ID = 'M7lc1UVf-VE';
const hostConn = { open: true, peer: 'admission-host' } as DataConnection;

function playFrame(queueItemId: QueueItemId) {
  return {
    type: MSG.YOUTUBE_PLAY,
    queueItemId,
    videoId: VIDEO_ID,
    playlistId: null,
    autoplay: false,
    subIndex: 0,
  };
}

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  setState('network.appRole', 'guest');
  setState('network.hostConn', hostConn);
  markQueueAuthorityReady(hostConn);
  setState('playlist.items', [
    {
      queueItemId: FILE_ID,
      type: 'file',
      name: 'Still downloading.flac',
      videoId: null,
      playlistId: null,
    },
    {
      queueItemId: YOUTUBE_ID,
      type: 'youtube',
      name: 'Next video',
      videoId: VIDEO_ID,
      playlistId: null,
    },
  ]);
  setState('playlist.currentQueueItemId', FILE_ID);
  registerHandler(MSG.YOUTUBE_PLAY, handleYouTubePlay);
});

describe('YouTube PLAY protocol admission', () => {
  it.each([
    ['removed queue item', REMOVED_ID],
    ['file queue item', FILE_ID],
  ] as const)('does not retire current media for a %s', async (_label, queueItemId) => {
    await handleData(playFrame(queueItemId), hostConn);

    expect(cancelIncomingFileTransfer).not.toHaveBeenCalled();
    expect(cancelRemoteShareWait).not.toHaveBeenCalled();
    expect(setLocalYouTubePaused).not.toHaveBeenCalled();
    expect(clearManagedTimer).not.toHaveBeenCalled();
    expect(loadYouTubeVideo).not.toHaveBeenCalled();
    expect(getState('playlist.currentQueueItemId')).toBe(FILE_ID);
  });

  it('retires the file transfer after a current-host command selects a known YouTube item', async () => {
    await handleData(playFrame(YOUTUBE_ID), hostConn);

    expect(cancelIncomingFileTransfer).toHaveBeenCalledWith('youtube-play');
    expect(cancelRemoteShareWait).toHaveBeenCalledWith('youtube-play');
    expect(setLocalYouTubePaused).toHaveBeenCalledWith(false);
    expect(loadYouTubeVideo).toHaveBeenCalledWith(VIDEO_ID, null, false, 0);
    expect(getState('playlist.currentQueueItemId')).toBe(YOUTUBE_ID);
  });
});
