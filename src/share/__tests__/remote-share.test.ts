/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { MSG } from '../../core/constants.ts';
import { DEMO_TRACK } from '../../demo/tracks.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection, RemoteFileSharePayload } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  downloadRemoteFile: vi.fn(),
  transition: vi.fn(),
}));

vi.mock('../remote-download.ts', () => ({
  downloadRemoteFile: mocks.downloadRemoteFile,
}));

vi.mock('../remote-upload.ts', () => ({
  uploadRemoteFile: vi.fn(),
}));

vi.mock('../r2-client.ts', () => ({
  isRemoteShareConfigured: vi.fn(() => true),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  isRemoteGuest: vi.fn(() => true),
  safeSend: vi.fn(),
  waitForGuestConnectionType: vi.fn(async () => 'remote'),
}));

vi.mock('../../player/lifecycle.ts', () => ({
  transition: mocks.transition,
}));

vi.mock('../../ui/toast.ts', () => ({
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
}));

vi.mock('../../chat/protocol.ts', () => ({
  sendSystemNotice: vi.fn(),
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const conn = { open: true, peer: 'host-1' } as DataConnection;

function descriptor(overrides: Partial<RemoteFileSharePayload> = {}): RemoteFileSharePayload {
  return {
    roomId: 'room',
    objectId: 'object-1',
    keyB64: 'a2V5',
    ivB64: 'aXY=',
    name: 'song.mp3',
    mime: 'audio/mpeg',
    size: 4,
    encryptedSize: 4,
    index: 0,
    sessionId: 7,
    expiresAt: Date.now() + 300_000,
    ...overrides,
  };
}

describe('remote file share policy', () => {
  beforeEach(async () => {
    resetState();
    vi.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:remote-file'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    mocks.downloadRemoteFile.mockResolvedValue(
      new File(['data'], 'song.mp3', { type: 'audio/mpeg' }),
    );
    setState('network.hostConn', conn);
    setState('network.connectionType', 'remote');

    const { initRemoteShare } = await import('../remote-share.ts');
    initRemoteShare();
  });

  it('ignores legacy remote preload descriptors', async () => {
    const { handleData } = await import('../../network/protocol.ts');

    await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor({ preload: true }) }, conn);

    expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it('ignores demo descriptors because remote guests use the HTTP demo path', async () => {
    const { handleData } = await import('../../network/protocol.ts');

    await handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ name: DEMO_TRACK.fileName }) },
      conn,
    );

    expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it('accepts the active remote descriptor while currently in YouTube playback', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    setPlaybackYouTubePlaying();

    await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor() }, conn);

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(mocks.transition).toHaveBeenCalledWith({ type: 'PRELOAD_FILE_READY', index: 0 });
  });
});
