/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import type { DataConnection, PeerInstance } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({ getPeer: vi.fn() }));

vi.mock('../../network/peer-state.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/peer-state.ts')>()),
  getPeer: mocks.getPeer,
  detectConnectionType: vi.fn(async () => 'remote'),
}));
vi.mock('../../network/peer.ts', async () => {
  const peerState = await import('../../network/peer-state.ts');
  return {
    isRemoteGuest: peerState.isRemoteGuest,
    waitForGuestConnectionType: peerState.waitForGuestConnectionType,
    sendToHost: peerState.sendToHost,
    broadcast: peerState.broadcast,
    cancelPendingSessionSetup: vi.fn(),
  };
});
vi.mock('../../network/sync-worker.ts', () => ({ startWorkerTimer: vi.fn() }));
vi.mock('../../network/standard-room-prerequisites.ts', () => ({
  scheduleStandardRoomPrerequisiteWarmup: vi.fn(),
}));
vi.mock('../../share/remote-share.ts', () => ({
  cancelRemoteShareWait: vi.fn(),
  prepareRemoteShareWait: vi.fn(),
  shouldWaitForRemoteShare: vi.fn(() => true),
}));
vi.mock('../../chat/protocol.ts', () => ({ announceSystemMessageLocally: vi.fn() }));
vi.mock('../../core/capability.ts', () => ({ cancelCapabilityChallenge: vi.fn() }));
vi.mock('../../core/session-reset.ts', () => ({
  scheduleDocumentReload: vi.fn(),
  scheduleSessionReset: vi.fn(),
}));
vi.mock('../../i18n/index.ts', () => ({
  t: (key: string) => key,
  synchronizeCurrentLocalizedAppHead: vi.fn(),
}));
vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn(), showLoader: vi.fn() }));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: vi.fn(() => new Promise(() => {})) }));
vi.mock('../../ui/player-controls.ts', () => ({ updateRoleBadge: vi.fn() }));
vi.mock('../../ui/settings.ts', () => ({ openLanguageDialog: vi.fn() }));
vi.mock('../../ui/onboarding-diagnostics.ts', () => ({
  initOnboardingDiagnostics: vi.fn(),
  openOnboardingDiagnostics: vi.fn(),
}));
vi.mock('../../ui/setup-host.ts', () => ({ startHostFlow: vi.fn(), setHostGoBack: vi.fn() }));
vi.mock('../../ui/setup-guest.ts', () => ({
  startGuestFlow: vi.fn(),
  setGuestGoBack: vi.fn(),
  handleSetupJoinWithRole: vi.fn(),
  promptForRoomPassword: vi.fn(),
  clearPendingRoomPasswordJoin: vi.fn(),
  restoreGuestJoinControlsAfterFailure: vi.fn(),
}));
vi.mock('../../ui/setup-shared.ts', () => ({
  syncDesktopLeftPanel: vi.fn(),
  setupEl: vi.fn(() => null),
  showSetupOverlay: vi.fn(),
  hideSetupOverlay: vi.fn(),
  setupShowCodeArea: vi.fn(),
  setupShowJoinArea: vi.fn(),
  setupShowAutoJoinArea: vi.fn(),
  setupShowRoleArea: vi.fn(),
  setupShowWelcome: vi.fn(),
  setupSetGuestJoinBusy: vi.fn(),
  setupSetGuestJoinError: vi.fn(),
  setupRenderActions: vi.fn(),
  initObCarousel: vi.fn(),
  updateObSlider: vi.fn(),
  handleSetupRolePreview: vi.fn(),
  setCurrentObSlide: vi.fn(),
  setPendingGuestRoleMode: vi.fn(),
  incrementHostCodeFlowId: vi.fn(),
  getSetupOverlayEverShown: vi.fn(() => true),
  getSetupOverlayAbort: vi.fn(() => null),
  setSetupOverlayAbort: vi.fn(),
  getPendingGuestRoleMode: vi.fn(() => null),
  setPendingAutoJoinCode: vi.fn(),
}));

import { joinSession } from '../../network/guest.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import {
  beginFileRequest,
  resetFileRequestAuthority,
  sendFileRequest,
} from '../../network/file-request-authority.ts';
import { initSetup } from '../../ui/setup.ts';
import { showDialog } from '../../ui/dialog.ts';
import { showLoader, showToast } from '../../ui/toast.ts';
import { stopAllMedia } from '../../player/transport.ts';
import { handleFileWait } from '../transfer-receive.ts';
import { resetRecoveryAuthority } from '../recovery.ts';

const Q = '00000000-0000-4000-8000-000000000001';
type FiringConnection = DataConnection & { fire(event: string, ...args: unknown[]): void };

function createConnection(): FiringConnection {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const conn = {
    peer: '123456',
    open: false,
    send: vi.fn(),
    close: vi.fn(),
    off: vi.fn(),
    on(event: string, handler: (...args: unknown[]) => void) {
      const listeners = handlers.get(event) ?? [];
      listeners.push(handler);
      handlers.set(event, listeners);
    },
    fire(event: string, ...args: unknown[]) {
      if (event === 'open') conn.open = true;
      if (event === 'close' || event === 'error') conn.open = false;
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
  return conn as unknown as FiringConnection;
}

async function joinAndWaitForFile(): Promise<FiringConnection> {
  const conn = createConnection();
  mocks.getPeer.mockReturnValue({ open: true, connect: () => conn } as unknown as PeerInstance);
  bus.on('network:peer-bootstrap-apply', (frame, connection, acknowledge) => {
    if ((frame as { type?: string }).type === MSG.PLAYLIST_UPDATE) {
      markQueueAuthorityReady(connection);
    }
    acknowledge(true);
  });
  joinSession('123456');
  conn.fire('open');
  conn.fire('data', { type: MSG.WELCOME, lockChannel: false, label: 'Guest' });
  conn.fire('data', {
    type: MSG.PLAYLIST_UPDATE,
    list: [],
    revision: 0,
    currentQueueItemId: null,
    bootstrap: true,
  });
  conn.fire('data', { type: MSG.REPEAT_MODE, value: 0, _bootstrap: true });
  conn.fire('data', { type: MSG.SHUFFLE_MODE, value: false, _bootstrap: true });
  await Promise.resolve();
  expect(getState('network.hostConn')).toBe(conn);
  expect(getState('network.isConnecting')).toBe(false);
  expect(getState('network.connectionType')).toBe('remote');

  setState('playlist.items', [
    { queueItemId: Q, type: 'file', name: 'waiting.mp3', videoId: null, playlistId: null },
  ]);
  setState('playlist.currentQueueItemId', Q);
  setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
  const owner = beginFileRequest(conn, Q, 7);
  expect(sendFileRequest(owner, { type: MSG.REQUEST_CURRENT_FILE, name: 'waiting.mp3' })).toBe(
    true,
  );
  handleFileWait(
    {
      type: MSG.FILE_WAIT,
      queueItemId: owner.queueItemId,
      sessionId: owner.sessionId,
      requestId: owner.requestId,
    },
    conn,
  );
  expect(getManagedTimer('fileWaitTimeout')).not.toBeNull();
  vi.mocked(showToast).mockClear();
  vi.mocked(showLoader).mockClear();
  return conn;
}

beforeEach(() => {
  vi.useFakeTimers();
  clearAllManagedTimers();
  bus.clear();
  resetState();
  resetFileRequestAuthority();
  vi.clearAllMocks();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  initSetup();
  // Same terminal-stop implementation subscribed by initPlayback in the app.
  bus.on('player:stop-all-media', stopAllMedia);
});

afterEach(() => {
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
});

describe('FILE_WAIT after standard-room host loss', () => {
  it.each(['close', 'error'])(
    'keeps the terminal %s dialog free of a late file fallback',
    async (event) => {
      const conn = await joinAndWaitForFile();
      conn.fire(event, new Error('transport lost'));
      expect(getState('network.hostConn')).toBeNull();
      expect(showDialog).toHaveBeenCalledOnce();
      expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
      const stoppedMeta = getState('player.currentTrackMeta');
      vi.mocked(showToast).mockClear();
      vi.mocked(showLoader).mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(showToast).not.toHaveBeenCalledWith('share.remote.unavailable');
      expect(showLoader).not.toHaveBeenCalled();
      expect(getState('player.currentTrackMeta')).toBe(stoppedMeta);
    },
  );

  it('retains the ordinary remote fallback on its live connection', async () => {
    await joinAndWaitForFile();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(showToast).toHaveBeenCalledWith('share.remote.unavailable');
    expect(showLoader).toHaveBeenCalledWith(false);
  });

  it('retains the wait when the same connection recovers before its deadline', async () => {
    const conn = await joinAndWaitForFile();
    await vi.advanceTimersByTimeAsync(1_000);
    conn.fire('ice-recovered');
    expect(getState('network.connectionType')).toBe('unknown');
    await Promise.resolve();
    expect(getState('network.hostConn')).toBe(conn);
    expect(getState('network.connectionType')).toBe('remote');
    await vi.advanceTimersByTimeAsync(9_000);
    expect(showToast).toHaveBeenCalledWith('share.remote.unavailable');
  });

  it.each(['superseded', 'reset'])(
    'ignores a %s request at its original deadline',
    async (action) => {
      const conn = await joinAndWaitForFile();
      if (action === 'superseded') beginFileRequest(conn, Q, 8);
      else resetRecoveryAuthority();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(showToast).not.toHaveBeenCalledWith('share.remote.unavailable');
      expect(showLoader).not.toHaveBeenCalled();
    },
  );
});
