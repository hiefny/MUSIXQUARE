/**
 * Remote file sharing over temporary encrypted object storage.
 *
 * This is intentionally a side path: LAN P2P transfer remains the primary
 * path, while remote/unknown guests receive an encrypted R2 descriptor.
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE } from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { registerHandlers } from '../network/protocol.ts';
import {
  broadcast,
  isRemoteGuest,
  hasActiveRelay,
  safeSend,
  waitForGuestConnectionType,
} from '../network/peer.ts';
import { transition } from '../player/lifecycle.ts';
import { setPendingRecoveryTarget } from '../player/_state.ts';
import { showLoader, showToast, updateLoader } from '../ui/toast.ts';
import { uploadRemoteFile } from './remote-upload.ts';
import { downloadRemoteFile } from './remote-download.ts';
import { isRemoteShareConfigured } from './r2-client.ts';
import type { AnyProtocolMsg, DataConnection, RemoteFileSharePayload } from '../types/index.ts';

const REMOTE_WAIT_TIMER = 'remote-share-wait-timeout';
const REMOTE_WAIT_MS = 90_000;

let _activeUpload:
  | { key: string; promise: Promise<RemoteFileSharePayload> }
  | null = null;
let _lastDescriptor: RemoteFileSharePayload | null = null;
const _downloads = new Set<string>();

function toRemoteShareMessage(descriptor: RemoteFileSharePayload): AnyProtocolMsg {
  return { type: MSG.REMOTE_FILE_SHARE, ...descriptor } as AnyProtocolMsg;
}

function hasRemoteTargets(): boolean {
  const peers = getState('network.connectedPeers') || [];
  return peers.some(
    (peer) =>
      peer.status === 'connected' &&
      peer.conn?.open &&
      (peer.connectionType === 'remote' || peer.connectionType === 'unknown'),
  );
}

function sameDescriptor(file: File, sessionId: number, index: number): boolean {
  return (
    !!_lastDescriptor &&
    _lastDescriptor.sessionId === sessionId &&
    _lastDescriptor.index === index &&
    _lastDescriptor.name === file.name &&
    _lastDescriptor.size === file.size
  );
}

function descriptorKey(file: File, sessionId: number, index: number): string {
  return `${sessionId}:${index}:${file.name}:${file.size}:${file.lastModified}`;
}

export function shouldWaitForRemoteShare(): boolean {
  return isRemoteShareConfigured();
}

export async function shareRemoteFileIfNeeded(
  file: File,
  sessionId: number | null,
  targetConn?: DataConnection,
): Promise<void> {
  if (getState('network.hostConn')) return;
  if (!isRemoteShareConfigured()) return;
  if (sessionId === null) return;
  if (!targetConn && !hasRemoteTargets()) return;

  const index = getState('playlist.currentTrackIndex');
  if (!Number.isFinite(index) || index < 0) return;
  const key = descriptorKey(file, sessionId, index);

  try {
    let descriptor: RemoteFileSharePayload;
    if (sameDescriptor(file, sessionId, index)) {
      descriptor = _lastDescriptor as RemoteFileSharePayload;
    } else {
      if (_activeUpload?.key === key) {
        descriptor = await _activeUpload.promise;
      } else {
        _activeUpload = { key, promise: uploadRemoteFile(file, sessionId, index) };
        descriptor = await _activeUpload.promise;
        _lastDescriptor = descriptor;
        if (_activeUpload?.key === key) _activeUpload = null;
      }
    }

    if (!targetConn && getState('files.currentFileBlob') !== file) {
      log.debug('[RemoteShare] Upload completed for stale track; descriptor not broadcast');
      return;
    }

    const msg = toRemoteShareMessage(descriptor);
    if (targetConn) {
      safeSend(targetConn, msg);
    } else {
      broadcast(msg);
    }
    bus.emit('share:remote-file', descriptor);
    log.info(`[RemoteShare] Shared encrypted descriptor for ${descriptor.name}`);
  } catch (error) {
    if (_activeUpload?.key === key) _activeUpload = null;
    const message = error instanceof Error ? error.message : String(error);
    setState('share.remote', {
      ...getState('share.remote'),
      upload: {
        status: 'error',
        progress: 0,
        objectId: null,
        expiresAt: null,
        error: message,
      },
    });
    log.warn('[RemoteShare] Upload/share failed:', error);
    showToast('Remote file share failed');
  }
}

export function prepareRemoteShareWait(index: number, name: string, sessionId: number): void {
  if (!shouldWaitForRemoteShare()) return;

  setPendingRecoveryTarget(index, name);
  setState('playlist.currentTrackIndex', index);
  setState('preload.meta', {
    name,
    title: name.replace(/\.[^/.]+$/, ''),
    index,
    size: 0,
    mime: '',
    sessionId,
  });
  setState('preload.nextTrackIndex', index);
  setState('transfer.meta', {
    name,
    index,
    size: 0,
    mime: '',
    sessionId,
  });

  const playlist = getState('playlist.items') || [];
  if (playlist[index]) {
    setState('player.currentTrackMeta', playlist[index]);
  }

  transition({ type: 'FILE_PREPARE', variant: 'preload-waiting', index, name });
  showLoader(true, 'Waiting for encrypted remote file...');

  clearManagedTimer(REMOTE_WAIT_TIMER);
  setManagedTimer(
    REMOTE_WAIT_TIMER,
    () => {
      if (getState('preload.nextFileBlob')) return;
      log.warn('[RemoteShare] Wait timed out before descriptor/download completed');
      showToast('Remote file share timed out');
      showLoader(false);
    },
    REMOTE_WAIT_MS,
  );
}

async function handleRemoteFileShare(
  descriptor: RemoteFileSharePayload,
  conn?: DataConnection,
): Promise<void> {
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;
  if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) return;
  if (hasActiveRelay()) return;

  if (getState('network.connectionType') === 'unknown') {
    const resolved = await waitForGuestConnectionType(3000);
    if (resolved === 'local') return;
  } else if (!isRemoteGuest()) {
    return;
  }

  if (_downloads.has(descriptor.objectId)) return;
  _downloads.add(descriptor.objectId);

  try {
    setState('share.remote', {
      ...getState('share.remote'),
      download: {
        status: 'fetching',
        progress: 0,
        blobUrl: null,
        error: null,
      },
    });

    prepareRemoteShareWait(descriptor.index, descriptor.name, descriptor.sessionId);
    bus.emit('player:stop-all-media');
    showLoader(true, 'Downloading encrypted remote file...');

    const file = await downloadRemoteFile(descriptor, (progress) => {
      updateLoader(Math.round(progress * 100));
      const remote = getState('share.remote');
      setState('share.remote', {
        ...remote,
        download: {
          ...remote.download,
          status: 'fetching',
          progress,
        },
      });
      bus.emit('remote-file:progress', 'download', progress);
    });

    const previousBlobUrl = getState('share.remote').download.blobUrl;
    if (previousBlobUrl) URL.revokeObjectURL(previousBlobUrl);
    const objectUrl = URL.createObjectURL(file);
    const meta = {
      name: descriptor.name,
      title: descriptor.name.replace(/\.[^/.]+$/, ''),
      index: descriptor.index,
      size: file.size,
      mime: descriptor.mime,
      sessionId: descriptor.sessionId,
    };

    setState('preload.nextFileBlob', file);
    setState('preload.meta', meta);
    setState('preload.nextTrackIndex', descriptor.index);
    setState('files.currentTrack', { name: descriptor.name });
    setState('share.remote', {
      ...getState('share.remote'),
      download: {
        status: 'ready',
        progress: 1,
        blobUrl: objectUrl,
        error: null,
      },
    });

    clearManagedTimer(REMOTE_WAIT_TIMER);
    transition({ type: 'PRELOAD_FILE_READY', index: descriptor.index });
    bus.emit('remote-file:ready', descriptor.index, descriptor.name);
    bus.emit('storage:use-preloaded', descriptor.index, descriptor.name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setState('share.remote', {
      ...getState('share.remote'),
      download: {
        status: 'error',
        progress: 0,
        blobUrl: null,
        error: message,
      },
    });
    log.warn('[RemoteShare] Download/decrypt failed:', error);
    showToast('Remote file download failed');
    showLoader(false);
  } finally {
    _downloads.delete(descriptor.objectId);
  }
}

export function initRemoteShare(): void {
  registerHandlers({
    [MSG.REMOTE_FILE_SHARE]: handleRemoteFileShare,
  });

  bus.on('orchestrator:peer-joined', (peerId) => {
    const hostConn = getState('network.hostConn');
    if (hostConn || !isRemoteShareConfigured()) return;

    const peers = getState('network.connectedPeers') || [];
    const peer = peers.find((item) => item.id === peerId);
    if (!peer?.conn?.open) return;
    if (peer.connectionType === 'local') return;

    const currentBlob = getState('files.currentFileBlob');
    if (!(currentBlob instanceof File)) return;
    const sessionId = getState('transfer.currentSessionId') || getState('transfer.localSessionId');
    void shareRemoteFileIfNeeded(currentBlob, sessionId || null, peer.conn);
  });

  bus.on('state:network.sessionCode', (code) => {
    if (!code) {
      _activeUpload = null;
      _lastDescriptor = null;
      _downloads.clear();
      clearManagedTimer(REMOTE_WAIT_TIMER);
      const blobUrl = getState('share.remote').download.blobUrl;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      setState('share.remote', {
        upload: {
          status: 'idle',
          progress: 0,
          objectId: null,
          expiresAt: null,
          error: null,
        },
        download: {
          status: 'idle',
          progress: 0,
          blobUrl: null,
          error: null,
        },
      });
    }
  });

  log.info('[RemoteShare] Handlers registered');
}
