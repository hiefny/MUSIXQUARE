/**
 * Effective guest receive deadlines (RO-19).
 *
 * The chunk, FILE_PREPARE and awaited-preload waits each give a remote
 * connection 60 s and a local one less. These tests drive the real handlers
 * and managed timers under fake time and pin the instant each wait expires.
 * A remote row is a session admitted for direct delivery before ICE
 * reclassified the route, which is how a remote guest reaches these waits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { resetFileRequestAuthority } from '../../network/file-request-authority.ts';
import {
  recordGuestFileDelivery,
  resetFileDeliveryPolicies,
} from '../../share/file-delivery-policy.ts';
import type { DataConnection } from '../../types/index.ts';
import { showToast } from '../../ui/toast.ts';
import { __resetRamStoreForTests } from '../ramstore.ts';
import { resetStoredFileAdmissionsForTests } from '../storage.ts';
import {
  handleFilePrepare,
  handleFileStart,
  resetIncomingTransferAuthority,
} from '../transfer-receive.ts';

const route = vi.hoisted(() => ({ remoteGuest: false }));

vi.mock('../../network/peer.ts', () => ({
  sendToHost: vi.fn(),
  isRemoteGuest: () => route.remoteGuest,
  waitForGuestConnectionType: vi.fn(),
}));

vi.mock('../../share/remote-share.ts', () => ({
  cancelRemoteShareWait: vi.fn(),
  prepareRemoteShareWait: vi.fn(),
  shouldWaitForRemoteShare: vi.fn(() => true),
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const Q0 = '00000000-0000-4000-8000-000000000001';
const send = vi.fn();
const conn = { open: true, peer: 'host-deadline', send } as unknown as DataConnection;
const recoveryRequested = vi.fn();

const prepareMsg = (sessionId: number) => ({
  type: MSG.FILE_PREPARE,
  queueItemId: Q0,
  sessionId,
  name: 'track.mp3',
  mime: 'audio/mpeg',
});

function enterRoute(connectionType: 'local' | 'remote', sessionId: number): void {
  setState('network.connectionType', connectionType);
  route.remoteGuest = connectionType === 'remote';
  if (connectionType === 'remote') recordGuestFileDelivery(Q0, sessionId, 'direct-local');
}

function preparationDelayedToasts(): number {
  return vi.mocked(showToast).mock.calls.filter(([text]) => text === 'transfer.preparation_delayed')
    .length;
}

function currentFileRequests(): number {
  return send.mock.calls.filter(
    ([message]) => (message as { type?: unknown }).type === MSG.REQUEST_CURRENT_FILE,
  ).length;
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
  vi.mocked(showToast).mockClear();
  send.mockClear();
  recoveryRequested.mockClear();
  route.remoteGuest = false;
  bus.on('storage:request-recovery', recoveryRequested);
  setState('network.hostConn', conn);
  setState('playlist.items', [
    { queueItemId: Q0, type: 'file', name: 'track.mp3', videoId: null, playlistId: null },
  ]);
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('guest receive deadlines', () => {
  it.each([
    ['local', 12_000],
    ['remote', 60_000],
  ] as const)(
    'requests recovery at the first watchdog check after %s chunks stall for %i ms',
    async (connectionType, deadlineMs) => {
      enterRoute(connectionType, 7);
      await handleFilePrepare(prepareMsg(7), conn);
      handleFileStart(
        {
          type: MSG.FILE_START,
          queueItemId: Q0,
          sessionId: 7,
          name: 'track.mp3',
          mime: 'audio/mpeg',
          total: 2,
          size: CHUNK_SIZE + 1,
        },
        conn,
      );
      expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);

      // The watchdog checks once a second and fires once the gap exceeds the deadline.
      await vi.advanceTimersByTimeAsync(deadlineMs + 999);
      expect(recoveryRequested).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(recoveryRequested).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['local', 15_000],
    ['remote', 60_000],
  ] as const)(
    'reports a delayed %s FILE_PREPARE after %i ms without data',
    async (connectionType, deadlineMs) => {
      enterRoute(connectionType, 7);
      await handleFilePrepare(prepareMsg(7), conn);
      expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);

      await vi.advanceTimersByTimeAsync(deadlineMs - 1);
      expect(preparationDelayedToasts()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(preparationDelayedToasts()).toBe(1);
    },
  );

  it.each([
    ['local', 30_000],
    ['remote', 60_000],
  ] as const)(
    'requests the current file after a %s awaited preload stalls for %i ms',
    async (connectionType, deadlineMs) => {
      setState('transfer.localSessionId', 5);
      setState('preload.isPreloading', true);
      setState('preload.activeTarget', {
        queueItemId: Q0,
        indexHint: 0,
        name: 'track.mp3',
        sessionId: 5,
      });
      enterRoute(connectionType, 5);
      await handleFilePrepare(prepareMsg(5), conn);
      expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);

      await vi.advanceTimersByTimeAsync(deadlineMs - 1);
      expect(currentFileRequests()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(currentFileRequests()).toBe(1);
    },
  );
});
