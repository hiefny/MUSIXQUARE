/**
 * FILE_PREPARE loader copy names the file as people should see it.
 *
 * macOS hands file names over decomposed (NFD). The loader composes the name
 * (NFC) for display, the way track titles and PRO upload rows do, while the
 * transfer keeps the name exactly as the host sent it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { resetFileRequestAuthority } from '../../network/file-request-authority.ts';
import { resetFileDeliveryPolicies } from '../../share/file-delivery-policy.ts';
import type { DataConnection } from '../../types/index.ts';
import { showLoader } from '../../ui/toast.ts';
import { __resetRamStoreForTests } from '../ramstore.ts';
import { resetStoredFileAdmissionsForTests } from '../storage.ts';
import { handleFilePrepare, resetIncomingTransferAuthority } from '../transfer-receive.ts';

vi.mock('../../network/peer.ts', () => ({
  sendToHost: vi.fn(),
  isRemoteGuest: () => false,
  waitForGuestConnectionType: vi.fn(),
}));

vi.mock('../../share/remote-share.ts', () => ({
  cancelRemoteShareWait: vi.fn(),
  prepareRemoteShareWait: vi.fn(),
  shouldWaitForRemoteShare: vi.fn(() => false),
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string, params?: Record<string, string>) =>
    params?.name === undefined ? key : `${key}|${params.name}`,
  ),
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const Q0 = '00000000-0000-4000-8000-000000000001';
const conn = { open: true, peer: 'host-name', send: vi.fn() } as unknown as DataConnection;
const NAME = '밤의 드라이브.mp3';
const DECOMPOSED = NAME.normalize('NFD');

const prepareMsg = (sessionId: number) => ({
  type: MSG.FILE_PREPARE,
  queueItemId: Q0,
  sessionId,
  name: DECOMPOSED,
  mime: 'audio/mpeg',
  size: 4_096,
});

function loaderTexts(): string[] {
  return vi
    .mocked(showLoader)
    .mock.calls.filter(([show]) => show)
    .map(([, text]) => text ?? '');
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  bus.clear();
  clearAllManagedTimers();
  __resetRamStoreForTests();
  resetStoredFileAdmissionsForTests();
  resetIncomingTransferAuthority();
  resetFileDeliveryPolicies();
  resetFileRequestAuthority();
  vi.mocked(showLoader).mockClear();
  setState('network.hostConn', conn);
  setState('network.connectionType', 'local');
  setState('playlist.items', [
    { queueItemId: Q0, type: 'file', name: DECOMPOSED, videoId: null, playlistId: null },
  ]);
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('FILE_PREPARE loader names', () => {
  it('composes the name of a fresh download and keeps the sent name for the transfer', async () => {
    expect(DECOMPOSED).not.toBe(NAME);

    await handleFilePrepare(prepareMsg(7), conn);

    expect(loaderTexts()).toContain(`transfer.preparing_name|${NAME}`);
    expect(getState('transfer.meta')?.name).toBe(DECOMPOSED);
  });

  it('composes the name while a same-session transfer resumes', async () => {
    setState('transfer.localSessionId', 7);
    setState('transfer.meta', {
      queueItemId: Q0,
      name: DECOMPOSED,
      indexHint: 0,
      size: 4_096,
      mime: 'audio/mpeg',
      sessionId: 7,
    });
    setState('transfer.receivedCount', 2);

    await handleFilePrepare(prepareMsg(7), conn);

    expect(loaderTexts()).toContain(`transfer.waiting_recovery|${NAME}`);
  });

  it('composes the name while the track waits for its preload', async () => {
    setState('transfer.localSessionId', 7);
    setState('preload.isPreloading', true);
    setState('preload.activeTarget', {
      queueItemId: Q0,
      indexHint: 0,
      name: DECOMPOSED,
      mime: 'audio/mpeg',
      size: 4_096,
      total: 1,
      sessionId: 5,
    });

    await handleFilePrepare(prepareMsg(7), conn);

    expect(loaderTexts()).toContain(`transfer.preload_pending|${NAME}`);
    expect(getState('playback.pendingRecoveryTarget')?.name).toBe(DECOMPOSED);
  });
});
