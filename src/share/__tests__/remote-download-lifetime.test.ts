/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { DataConnection, RemoteFileSharePayload } from '../../types/index.ts';

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  isRemoteGuest: vi.fn(() => true),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
  waitForGuestConnectionType: vi.fn(async () => 'remote'),
}));
vi.mock('../../ui/toast.ts', () => ({
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
}));
vi.mock('../../chat/protocol.ts', () => ({
  broadcastSystemMessage: vi.fn(),
  sendSystemMessage: vi.fn(),
}));
vi.mock('../../i18n/index.ts', () => ({ t: vi.fn((key: string) => key) }));
vi.mock('../../player/decode-admission.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../player/decode-admission.ts')>();
  return { ...actual, resolveDecodeMemoryBudget: vi.fn(actual.resolveDecodeMemoryBudget) };
});

import { handleData } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { handleFilePrepare } from '../../storage/transfer-receive.ts';
import { resetStoredFileAdmissionsForTests } from '../../storage/storage.ts';
import { showToast } from '../../ui/toast.ts';
import { initRemoteShare } from '../remote-share.ts';
import {
  reserveRemoteTransportMemoryWithinBudget,
  resolveDecodeMemoryBudget,
} from '../../player/decode-admission.ts';

const Q1 = '10000000-0000-4000-8000-000000000001';
const Q2 = '10000000-0000-4000-8000-000000000002';
const OBJECT = '20000000-0000-4000-8000-000000000001';
const ENDPOINT = 'https://share.example.test';
const SIZE = 400;

class DownloadXhr {
  static instances: DownloadXhr[] = [];
  status = 200;
  response: unknown = null;
  responseURL = '';
  responseType = '';
  aborted = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onprogress: ((event: ProgressEvent) => void) | null = null;
  constructor() {
    DownloadXhr.instances.push(this);
  }
  open(_method: string, url: string): void {
    this.responseURL = url;
  }
  setRequestHeader(): void {}
  send(): void {}
  abort(): void {
    this.aborted = true;
  }
  progress(loaded: number): void {
    if (!this.aborted)
      this.onprogress?.(
        new ProgressEvent('progress', {
          lengthComputable: true,
          loaded,
          total: SIZE,
        }),
      );
  }
  finish(): void {
    if (this.aborted) return;
    this.response = new ArrayBuffer(SIZE);
    this.onload?.();
  }
}

let conn: DataConnection;
function descriptor(sessionId: number): RemoteFileSharePayload {
  return {
    roomId: '123456',
    objectId: OBJECT,
    downloadUrl: `${ENDPOINT}/download/123456/${OBJECT}`,
    storageFormat: 'whole-v1',
    storedSize: SIZE,
    size: SIZE,
    downloadToken: `eyJ2IjoxLCJraW5kIjoid2hvbGUtZG93bmxvYWQifQ.${'a'.repeat(43)}`,
    name: 'a.mp3',
    mime: 'audio/mpeg',
    queueItemId: Q1,
    sessionId,
    expiresAt: Date.now() + 60 * 60_000,
    delivery: 'r2',
  };
}
async function prepare(queueItemId: string, sessionId: number): Promise<void> {
  await handleFilePrepare(
    {
      type: MSG.FILE_PREPARE,
      queueItemId,
      sessionId,
      delivery: 'r2',
      name: queueItemId === Q1 ? 'a.mp3' : 'b.mp3',
      size: SIZE,
      mime: 'audio/mpeg',
    },
    conn,
  );
}

beforeEach(async () => {
  vi.useFakeTimers();
  resetState();
  bus.emit('state:network.sessionCode', null, 'network.sessionCode');
  bus.clear();
  clearAllManagedTimers();
  resetStoredFileAdmissionsForTests();
  vi.clearAllMocks();
  const admission = await vi.importActual<typeof import('../../player/decode-admission.ts')>(
    '../../player/decode-admission.ts',
  );
  vi.mocked(resolveDecodeMemoryBudget).mockImplementation(admission.resolveDecodeMemoryBudget);
  DownloadXhr.instances = [];
  vi.stubGlobal('XMLHttpRequest', DownloadXhr);
  Object.defineProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__', {
    configurable: true,
    value: ENDPOINT,
  });
  conn = { peer: 'host', open: true, send: vi.fn(), close: vi.fn(), on: () => undefined };
  markQueueAuthorityReady(conn);
  setState('network.appRole', 'guest');
  setState('network.hostConn', conn);
  setState('network.connectionType', 'remote');
  setState('network.sessionCode', '123456');
  setState(
    'playlist.items',
    [Q1, Q2].map((queueItemId, index) => ({
      queueItemId,
      type: 'file' as const,
      name: index === 0 ? 'a.mp3' : 'b.mp3',
      videoId: null,
      playlistId: null,
    })),
  );
  setState('playlist.currentQueueItemId', Q1);
  initRemoteShare();
});

afterEach(() => {
  bus.emit('state:network.sessionCode', null, 'network.sessionCode');
  clearAllManagedTimers();
  resetStoredFileAdmissionsForTests();
  bus.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, '__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__');
});

describe('remote download ownership across selection', () => {
  it('keeps a progressing GET alive when returning to its object under a newer session', async () => {
    const usePreloaded = vi.fn();
    bus.on('storage:use-preloaded', usePreloaded);
    await prepare(Q1, 7);
    const pending = handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor(7) }, conn);
    expect(DownloadXhr.instances).toHaveLength(1);
    const xhr = DownloadXhr.instances[0]!;
    xhr.progress(1);

    // Host selects B and returns to A before B's new upload is ready. The
    // cached A descriptor reuses its current GET with the new transfer SID.
    await prepare(Q2, 8);
    await prepare(Q1, 9);
    await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor(9) }, conn);
    expect(DownloadXhr.instances).toHaveLength(1);
    expect(getState('preload.activeTarget')).toMatchObject({ queueItemId: Q1, sessionId: 9 });

    // Every interval is shorter than the real transport's 90-second stall
    // watchdog; only the obsolete room-level 315-second timer can abort it.
    for (let minute = 1; minute <= 6; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      xhr.progress(minute + 1);
    }
    expect.soft(xhr.aborted).toBe(false);
    expect.soft(showToast).not.toHaveBeenCalledWith('share.remote.timeout');
    xhr.finish();
    await pending;
    expect(getState('preload.ready')).toMatchObject({ queueItemId: Q1, sessionId: 9 });
    expect(usePreloaded).toHaveBeenCalledExactlyOnceWith(Q1, 'a.mp3', 9);
  });

  it('keeps the admission wait deadline when the same object has not started its GET', async () => {
    // The production ledger also supports explicit finite budgets. Exercise
    // its real lease wait rather than delaying an already-resolved operation.
    const budget = {
      tier: 'standard' as const,
      maxDecodedPcmBytes: 320 * 1024 * 1024,
      maxDecodeWorkingSetBytes: 320 * 1024 * 1024,
    };
    vi.mocked(resolveDecodeMemoryBudget).mockReturnValue(budget);
    const olderTransport = reserveRemoteTransportMemoryWithinBudget(160 * 1024 * 1024, { budget });
    try {
      await prepare(Q1, 7);
      const pending = handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor(7) }, conn);
      expect(DownloadXhr.instances).toHaveLength(0);
      await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor(9) }, conn);
      await vi.advanceTimersByTimeAsync(315_001);
      await pending;
      expect(DownloadXhr.instances).toHaveLength(0);
      expect(showToast).toHaveBeenCalledExactlyOnceWith('share.remote.timeout');
    } finally {
      olderTransport.release();
    }
  });

  it('still lets the transport stall watchdog retry and fail a rebound GET', async () => {
    await prepare(Q1, 7);
    const pending = handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor(7) }, conn);
    await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor(9) }, conn);
    await vi.advanceTimersByTimeAsync(180_001);
    await pending;
    expect(DownloadXhr.instances).toHaveLength(2);
    expect(DownloadXhr.instances.every((xhr) => xhr.aborted)).toBe(true);
    expect(getState('share.remote').download.status).toBe('error');
    expect(showToast).toHaveBeenCalledWith('share.remote.download_failed');
    expect(showToast).not.toHaveBeenCalledWith('share.remote.timeout');
  });

  it('aborts a rebound GET and stays silent after the host connection is replaced', async () => {
    const usePreloaded = vi.fn();
    bus.on('storage:use-preloaded', usePreloaded);
    await prepare(Q1, 7);
    const pending = handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor(7) }, conn);
    await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor(9) }, conn);
    setState('network.hostConn', { ...conn, peer: 'replacement-host' });
    await pending;
    await vi.advanceTimersByTimeAsync(360_000);
    expect(DownloadXhr.instances).toHaveLength(1);
    expect(DownloadXhr.instances[0]?.aborted).toBe(true);
    expect(getState('share.remote').download.status).toBe('idle');
    expect(usePreloaded).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });
});
