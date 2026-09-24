import { bus, createBusScope } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { MSG } from '../core/constants.ts';
import { t } from '../i18n/index.ts';
import { loadDemoFile } from '../player/decode.ts';
import {
  getCurrentAudioBuffer,
  isLocalFilePaused,
  newLoadEpoch,
  setCurrentAudioBuffer,
  setLocalFilePaused,
} from '../player/_state.ts';
import {
  releaseFilePlaybackResource,
  retainFilePlaybackResource,
  type FilePlaybackResource,
} from '../player/file-playback-resource.ts';
import { prepareMediaSession } from '../player/media-session-loader.ts';
import {
  getPlaybackModeActivitySnapshot,
  setPlaybackFilePaused,
  setPlaybackIdle,
  setPlaybackTrackMeta,
} from '../player/ownership.ts';
import {
  fmtTime,
  getLocalFilePendingStartDeadlineMs,
  getTrackPosition,
  isLocalFileStartPending,
  pause,
  play,
  stopAllMedia,
} from '../player/transport.ts';
import { cancelOutgoingFileTransfers } from '../storage/transfer.ts';
import { applySettingsAsync, syncRoomEffectsUI } from '../audio/effects.ts';
import { setChannelMode } from '../audio/channel.ts';
import { getHostNow, isClockCalibrated } from '../network/shared-clock.ts';
import { broadcast, safeSend } from '../network/peer.ts';
import { registerHandlers } from '../network/protocol.ts';
import { hideSetupOverlay } from '../ui/setup-shared.ts';
import { showDialog } from '../ui/dialog.ts';
import { showLoader, showToast, updateLoader } from '../ui/toast.ts';
import { updateOverlayOpenClass } from '../ui/dom.ts';
import { syncExclusivePressedState } from '../core/aria-state.ts';
import { syncAppThemeChrome, syncDemoThemeChrome } from '../ui/theme-chrome.ts';
import type { FileMeta, QueueItemId, ResidentFile, TrackMeta } from '../types/index.ts';
import {
  DEMO_TRACKS,
  createDemoTrackMeta,
  getDemoTrackByIndex,
  getNextDemoTrackIndex,
  type DemoTrack,
} from './tracks.ts';
import { hasAppUseRecord, hasSeenDemoPrompt, markAppUsed, markDemoPromptSeen } from './storage.ts';
import { isProRoomCode } from '../pro-room/room-code.ts';
import type { DataConnection } from '../types/index.ts';
import type { PlaybackModeActivity } from '../player/ownership.ts';
import { shouldRestoreDemoSnapshotMedia } from './restore-policy.ts';
import {
  DEMO_PLAY_SCHEDULE_AHEAD_MS,
  DEMO_PLAY_START_LEAD_MS,
  getPendingDemoHostStartAt,
  projectDemoPlay,
  setDemoHostStartAt,
} from './playback-timing.ts';
import { getQueueItemById } from '../player/queue-model.ts';
import {
  getRoomContext,
  hasRoomCapability,
  isCoordinator,
  verifyPeerCapability,
} from '../rooms/authority.ts';

type DemoRoomIdentity = Readonly<{
  kind: 'standard' | 'pro';
  roomId: string | null;
  epoch: number;
  standardPeerId: string | null;
  standardHostConnection: DataConnection | null;
  coordinatorAtCapture: boolean;
}>;

type DemoSnapshot = {
  room: DemoRoomIdentity;
  channelMode: number;
  reverbMix: number;
  reverbDecay: number;
  reverbPreDelay: number;
  reverbLowCut: number;
  reverbHighCut: number;
  eqValues: number[];
  stereoWidth: number;
  virtualBass: number;
  exciter: boolean;
  userPreampGain: number;
  subFreq: number;
  currentTrackMeta: TrackMeta | null;
  currentQueueItemId: QueueItemId | null;
  currentFile: ResidentFile | null;
  // transfer.meta describes the active generation while currentFile keeps
  // the resident Blob and its queue/session owner atomic.
  transferMeta: Partial<FileMeta>;
  currentAudioBuffer: FilePlaybackResource | null;
  pausedAt: number;
  duration: number;
  playback: PlaybackModeActivity;
};

type RestoreSnapshotOptions = {
  audio?: boolean;
  media?: boolean;
  isCurrent?: () => boolean;
};

type ExitDemoOptions = {
  broadcastExit?: boolean;
  restoreSnapshot?: boolean;
  restoreAudioSettings?: boolean;
};

type DemoEffectState = {
  reverbOn: boolean;
  bassOn: boolean;
  trebleOn: boolean;
  surroundOn: boolean;
};

type DemoPlaybackIntent = Readonly<{
  index: number;
  time: number;
  connection: DataConnection;
  room: DemoRoomIdentity;
}> &
  (
    | Readonly<{ kind: 'play'; hostPlayAt: number; hostStartAt?: number; receivedAt: number }>
    | Readonly<{ kind: 'pause' }>
  );

const FLAT_EQ = [0, 0, 0, 0, 0];
const WARM_EQ = [5, 3, 0, -2, -3];
const BRIGHT_EQ = [0, -2, 0, 4, 6];
const V_SHAPE_EQ = [5, 3, 0, 4, 6];
const MOBILE_QUERY = '(max-width: 1279px)';
const DEMO_OVERLAY_FADE_MS = 340;
const DEMO_OVERLAY_EXIT_TIMER = 'demo-overlay-exit';
const DEMO_STEP_COLLAPSE_MS = 320;
const DEMO_LAYOUT_REFRESH_DELAYS_MS = [40, 180, 420, 720] as const;
const _busScope = createBusScope();

function observeDemoOperation(operation: Promise<unknown>, source: string): void {
  operation.catch((error) => {
    log.warn(`[Demo] ${source} failed outside its interaction boundary`, error);
  });
}

let _snapshot: DemoSnapshot | null = null;
let _visualizerPlaceholder: Comment | null = null;
let _promptInFlight = false;
let _suppressFirstRunPrompt = false;
let _demoStep = 1;
let _demoTrackIndex = 0;
type DemoLoadOwner = Readonly<{ generation: number; room: DemoRoomIdentity }>;
type DemoAsyncResult = Readonly<{
  status: 'applied' | 'superseded';
  generation: number;
}>;

let _demoLoadGeneration = 0;
let _activeDemoLoadOwner: DemoLoadOwner | null = null;
let _activeDemoTrackMeta: TrackMeta | null = null;
let _demoPlaybackIntent: DemoPlaybackIntent | null = null;
let _appliedDemoPlaybackIntent: DemoPlaybackIntent | null = null;
let _hostDemoPlayOwner: object | null = null;
// Hold DEMO_ENTER/PLAY received during a demo track load. Dropping them would
// leave guests on the prior track while SYNC_PONG follows the host's timeline.
let _queuedDemoEnterIndex: number | null = null;
// Exit-completion closure (snapshot restore + DOM teardown). Token-style:
// nulled on first run so the curtain onfinish, the fallback timer, and a
// racing re-entry can never run it twice.
let _pendingDemoExitFinish: (() => void) | null = null;
let _demoEnterRevealRaf = 0;
let _demoCurtainAnimation: Animation | null = null;
let _lastDemoStateBroadcastKey = '';
const _demoStepCollapseTimers = new WeakMap<HTMLElement, number>();
const _demoBlobCache = new Map<string, Blob>();
const _demoPreloadInFlight = new Map<string, Promise<Blob>>();
const _demoBlobRequests = new Set<XMLHttpRequest>();
let _demoBlobCacheGeneration = 0;

function isProRoomDemoBlocked(): boolean {
  return getState('room.context').kind === 'pro' || isProRoomCode(getState('network.sessionCode'));
}

function shouldShowFirstRunDemoPrompt(): boolean {
  if (_suppressFirstRunPrompt || hasSeenDemoPrompt()) return false;
  if (isProRoomDemoBlocked()) return false;
  if (/^\/\d{6}\/?$/.test(window.location.pathname)) return false;
  if (getState('network.appRole') !== 'host') return false;
  if (!getState('setup.sessionStarted')) return false;
  if (document.getElementById('setup-overlay')?.classList.contains('active')) return false;
  return true;
}

function captureDemoRoomIdentity(): DemoRoomIdentity {
  const room = getRoomContext();
  return Object.freeze({
    kind: room.kind,
    roomId:
      room.kind === 'standard'
        ? (room.roomId ?? (getState('network.sessionCode') || null))
        : room.roomId,
    epoch: room.epoch,
    standardPeerId: room.kind === 'standard' ? getState('network.myId') : null,
    standardHostConnection:
      room.kind === 'standard' && !isCoordinator() ? getState('network.hostConn') : null,
    coordinatorAtCapture: isCoordinator(),
  });
}

function isCurrentDemoRoom(expected: Readonly<DemoRoomIdentity>): boolean {
  const room = getRoomContext();
  const roomId =
    room.kind === 'standard'
      ? (room.roomId ?? (getState('network.sessionCode') || null))
      : room.roomId;
  return (
    room.kind === expected.kind &&
    roomId === expected.roomId &&
    room.epoch === expected.epoch &&
    (expected.kind !== 'standard' ||
      (getState('network.myId') === expected.standardPeerId &&
        getState('network.hostConn') === expected.standardHostConnection))
  );
}

function hasCurrentDemoRestoreAuthority(expected: Readonly<DemoRoomIdentity>): boolean {
  if (!isCurrentDemoRoom(expected)) return false;
  if (expected.kind !== 'standard') return true;
  if (expected.coordinatorAtCapture) return isCoordinator();
  return (
    expected.standardHostConnection !== null &&
    getState('network.hostConn') === expected.standardHostConnection &&
    !isCoordinator()
  );
}

function captureSnapshot(): DemoSnapshot {
  const playback = getPlaybackModeActivitySnapshot();
  const currentAudioBuffer = getCurrentAudioBuffer();
  const fallbackPausedAt = getState('player.pausedAt') ?? 0;
  const legacyFilePosition =
    playback.mode === 'file' &&
    (playback.activity === 'playing' || playback.activity === 'paused') &&
    currentAudioBuffer
      ? getTrackPosition()
      : fallbackPausedAt;
  const snapshot: DemoSnapshot = {
    room: captureDemoRoomIdentity(),
    channelMode: getState('audio.channelMode'),
    reverbMix: getState('audio.reverbMix'),
    reverbDecay: getState('audio.reverbDecay'),
    reverbPreDelay: getState('audio.reverbPreDelay'),
    reverbLowCut: getState('audio.reverbLowCut'),
    reverbHighCut: getState('audio.reverbHighCut'),
    eqValues: [...(getState('audio.eqValues') || [])],
    stereoWidth: getState('audio.stereoWidth'),
    virtualBass: getState('audio.virtualBass'),
    exciter: getState('audio.exciter'),
    userPreampGain: getState('audio.userPreampGain'),
    subFreq: getState('audio.subFreq'),
    currentTrackMeta: getState('player.currentTrackMeta') as TrackMeta | null,
    currentQueueItemId: getState('playlist.currentQueueItemId'),
    currentFile: getState('files.current'),
    transferMeta: { ...(getState('transfer.meta') || {}) },
    currentAudioBuffer,
    pausedAt: Number.isFinite(legacyFilePosition)
      ? Math.max(0, legacyFilePosition)
      : fallbackPausedAt,
    duration: currentAudioBuffer?.duration ?? 0,
    playback,
  };
  // Demo playback replaces the current resource. Its prior large-track
  // decoder remains owned by this snapshot until restoration or dismissal.
  if (currentAudioBuffer) retainFilePlaybackResource(currentAudioBuffer);
  return snapshot;
}

function releaseSnapshotResource(snapshot: DemoSnapshot | null): void {
  if (!snapshot?.currentAudioBuffer) return;
  const resource = snapshot.currentAudioBuffer;
  snapshot.currentAudioBuffer = null;
  releaseFilePlaybackResource(resource);
}

function failClosedDemoMediaRestore(snapshot: DemoSnapshot): void {
  // Only clear the captured selection. A newer queue choice is not ours to
  // erase even when its playback has not reached a non-idle lifecycle yet.
  const selectedQueueItemId = getState('playlist.currentQueueItemId');
  const stillSelected = selectedQueueItemId === snapshot.currentQueueItemId;
  const successor =
    selectedQueueItemId !== null && selectedQueueItemId !== snapshot.currentQueueItemId
      ? getQueueItemById(selectedQueueItemId)
      : null;
  if (stillSelected) {
    setState('playlist.currentQueueItemId', null);
  }
  if (getState('files.current')?.queueItemId === snapshot.currentQueueItemId) {
    setState('files.current', null);
  }
  if (getState('transfer.meta')?.queueItemId === snapshot.currentQueueItemId) {
    setState('transfer.meta', {});
  }
  if (stillSelected) setCurrentAudioBuffer(null);
  if (successor) {
    setCurrentAudioBuffer(null);
    setPlaybackTrackMeta(successor);
    setPlaybackIdle();
    bus.emit('ui:play-btn-state', false);
    return;
  }
  if (
    stillSelected ||
    getState('player.currentTrackMeta')?.queueItemId === snapshot.currentQueueItemId
  ) {
    setPlaybackTrackMeta(null);
    setPlaybackIdle();
    bus.emit('ui:play-btn-state', false);
  }
}

function restoreSnapshot(
  snapshot: DemoSnapshot | null,
  options: RestoreSnapshotOptions = {},
): void {
  if (!snapshot) return;
  const restoreAudio = options.audio ?? true;
  const restoreMedia = options.media ?? true;

  if (restoreAudio) {
    setChannelMode(snapshot.channelMode);
    setState('audio.reverbMix', snapshot.reverbMix);
    setState('audio.reverbDecay', snapshot.reverbDecay);
    setState('audio.reverbPreDelay', snapshot.reverbPreDelay);
    setState('audio.reverbLowCut', snapshot.reverbLowCut);
    setState('audio.reverbHighCut', snapshot.reverbHighCut);
    setState('audio.eqValues', [...snapshot.eqValues]);
    setState('audio.stereoWidth', snapshot.stereoWidth);
    setState('audio.virtualBass', snapshot.virtualBass);
    setState('audio.exciter', snapshot.exciter);
    setState('audio.userPreampGain', snapshot.userPreampGain);
    setState('audio.subFreq', snapshot.subFreq);
    syncRoomEffectsUI();
  }
  if (restoreMedia && hasCurrentDemoRestoreAuthority(snapshot.room)) {
    if (
      snapshot.playback.mode === 'file' &&
      snapshot.currentAudioBuffer &&
      snapshot.currentFile &&
      snapshot.currentQueueItemId &&
      getState('playlist.currentQueueItemId') === snapshot.currentQueueItemId &&
      snapshot.currentFile.queueItemId === snapshot.currentQueueItemId &&
      getQueueItemById(snapshot.currentQueueItemId)?.type === 'file'
    ) {
      setState('playlist.currentQueueItemId', snapshot.currentQueueItemId);
      setPlaybackTrackMeta(
        snapshot.currentTrackMeta ?? getQueueItemById(snapshot.currentQueueItemId),
      );
      setState('transfer.meta', snapshot.transferMeta);
      setState('files.current', snapshot.currentFile);
      setCurrentAudioBuffer(snapshot.currentAudioBuffer);
      setState(
        'player.pausedAt',
        Math.min(snapshot.pausedAt, snapshot.duration || snapshot.pausedAt),
      );
      setPlaybackFilePaused();
      bus.emit('ui:play-btn-state', true);
      if (snapshot.duration > 0) bus.emit('ui:duration-update', snapshot.duration);
      if (
        snapshot.room.kind === 'standard' &&
        snapshot.room.coordinatorAtCapture &&
        isCoordinator() &&
        (options.isCurrent?.() ?? true) &&
        getState('playlist.currentQueueItemId') === snapshot.currentQueueItemId &&
        getState('player.currentTrackMeta')?.queueItemId === snapshot.currentQueueItemId &&
        getPlaybackModeActivitySnapshot().mode === 'file' &&
        getPlaybackModeActivitySnapshot().activity === 'paused'
      ) {
        broadcast({
          type: MSG.PAUSE,
          time: Math.min(snapshot.pausedAt, snapshot.duration || snapshot.pausedAt),
          queueItemId: snapshot.currentQueueItemId,
          reason: 'seek',
        });
      }
    } else {
      if (snapshot.playback.mode === 'youtube' || snapshot.playback.mode === 'system-audio') {
        setState('playlist.currentQueueItemId', snapshot.currentQueueItemId);
        setState('files.current', null);
        setState('transfer.meta', {});
        setPlaybackTrackMeta(null);
        setPlaybackIdle();
        bus.emit('ui:play-btn-state', false);
      } else if (snapshot.playback.mode === 'file') {
        failClosedDemoMediaRestore(snapshot);
      }
    }
  }

  void applySettingsAsync();
}

function stopPlaybackForDemoEntry(playback: PlaybackModeActivity): void {
  if (playback.mode === 'system-audio') {
    bus.emit('system-audio:force-stop');
  }

  stopAllMedia({
    silent: true,
    cancelInFlight: true,
  });

  // The demo takes over the room. Guests drop any still-streaming
  // file chunks via their lifecycle gates anyway — cancel the host's
  // outgoing broadcast/unicast loops so the share doesn't burn bandwidth
  // for the entire demo session.
  cancelOutgoingFileTransfers();

  const afterStop = getPlaybackModeActivitySnapshot();
  if (afterStop.mode === 'system-audio') {
    setPlaybackIdle();
  }

  if (playback.mode === 'youtube' || playback.mode === 'system-audio') {
    showToast(t('demo.external_playback_stopped'));
  }
}

function clearDemoLayoutRefreshTimers(): void {
  DEMO_LAYOUT_REFRESH_DELAYS_MS.forEach((delayMs) => {
    clearManagedTimer(`demo-layout-refresh-${delayMs}`);
  });
}

function cancelDemoBlobRequests(): void {
  _demoBlobCacheGeneration += 1;
  _demoPreloadInFlight.clear();
  _demoBlobCache.clear();

  for (const xhr of _demoBlobRequests) {
    try {
      xhr.abort();
    } catch {
      /* ignore */
    }
  }
  _demoBlobRequests.clear();
}

// demo-overlay-exit and demo-first-run-prompt timers belong to separate
// lifecycles (curtain animation / first-time prompt) and are cleared at
// their own call sites. Don't fold them in here — exitDemoMode immediately
// re-schedules demo-overlay-exit via setDemoDomActive(false).
function clearDemoRuntimeWork(): void {
  setDemoHostStartAt(null);
  clearManagedTimer('demo-effect-state-sync');
  clearManagedTimer('demo-play-host-sync');
  clearDemoLayoutRefreshTimers();
  cancelDemoBlobRequests();
}

function getCurrentDemoTrack(): DemoTrack {
  return getDemoTrackByIndex(_demoTrackIndex);
}

function normalizeDemoTrackIndex(index: unknown): number {
  const value = Number(index);
  if (!Number.isInteger(value) || value < 0 || value >= DEMO_TRACKS.length) return 0;
  return value;
}

function isDemoHost(): boolean {
  return !isProRoomDemoBlocked() && isCoordinator();
}

function isTrustedDemoHostMessage(conn?: DataConnection): boolean {
  if (isProRoomDemoBlocked()) return false;
  const hostConn = getState('network.hostConn');
  return !!hostConn && conn === hostConn;
}

function createDemoEnterMessage(index = _demoTrackIndex) {
  return {
    type: MSG.DEMO_ENTER,
    index,
    reverbOn: !!getState('demo.reverbOn'),
    bassBoostOn: !!getState('demo.bassBoostOn'),
    trebleBoostOn: !!getState('demo.trebleBoostOn'),
    surroundOn: !!getState('demo.surroundOn'),
  } as const;
}

function getDemoStateBroadcastKey(index = _demoTrackIndex): string {
  return [
    index,
    getState('demo.reverbOn') ? 1 : 0,
    getState('demo.bassBoostOn') ? 1 : 0,
    getState('demo.trebleBoostOn') ? 1 : 0,
    getState('demo.surroundOn') ? 1 : 0,
  ].join(':');
}

function createDemoPlayMessage(index = _demoTrackIndex, time = 0, hostStartAt = getHostNow()) {
  return {
    type: MSG.DEMO_PLAY,
    index,
    time,
    hostStartAt,
    hostPlayAt: hostStartAt + DEMO_PLAY_SCHEDULE_AHEAD_MS,
  } as const;
}

function broadcastDemoEnter(index = _demoTrackIndex): void {
  if (!isDemoHost()) return;
  _lastDemoStateBroadcastKey = getDemoStateBroadcastKey(index);
  broadcast(createDemoEnterMessage(index));
}

function broadcastDemoStateIfChanged(): void {
  if (!isDemoHost() || !getState('demo.active')) return;
  const key = getDemoStateBroadcastKey();
  if (_lastDemoStateBroadcastKey === key) return;
  _lastDemoStateBroadcastKey = key;
  broadcast(createDemoEnterMessage(_demoTrackIndex));
}

function broadcastDemoExit(): void {
  if (!isDemoHost()) return;
  broadcast({ type: MSG.DEMO_EXIT });
}

function broadcastDemoPause(time: number): void {
  if (!isDemoHost()) return;
  broadcast({ type: MSG.DEMO_PAUSE, time });
}

function broadcastDemoPlay(index = _demoTrackIndex, time = 0, hostStartAt = getHostNow()): void {
  if (!isDemoHost()) return;
  broadcast(createDemoPlayMessage(index, time, hostStartAt));
}

function sendDemoBootstrap(conn: DataConnection): void {
  if (!isDemoHost() || !getState('demo.active')) return;
  safeSend(conn, createDemoEnterMessage(_demoTrackIndex));
  if (isDemoPlaying() && !getState('demo.loading') && getCurrentAudioBuffer()) {
    safeSend(
      conn,
      createDemoPlayMessage(_demoTrackIndex, getTrackPosition(), getPendingDemoHostStartAt()),
    );
  } else {
    safeSend(conn, { type: MSG.DEMO_PAUSE, time: getState('player.pausedAt') || 0 });
  }
}

function fetchDemoBlob(track: DemoTrack, reportProgress: boolean): Promise<Blob> {
  const cached = _demoBlobCache.get(track.id);
  if (cached) return Promise.resolve(cached);
  const inFlight = _demoPreloadInFlight.get(track.id);
  if (inFlight) return inFlight;

  const cacheGeneration = _demoBlobCacheGeneration;
  let xhr: XMLHttpRequest | null = null;
  return new Promise<Blob>((resolve, reject) => {
    const request = new XMLHttpRequest();
    xhr = request;
    _demoBlobRequests.add(request);
    request.open('GET', track.url, true);
    request.responseType = 'blob';
    request.timeout = 30000;
    request.onprogress = (event) => {
      if (!reportProgress || !event.lengthComputable) return;
      updateLoader(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        const blob = request.response as Blob;
        if (cacheGeneration === _demoBlobCacheGeneration) {
          _demoBlobCache.set(track.id, blob);
        }
        resolve(blob);
      } else {
        reject(new Error(`HTTP ${request.status}`));
      }
    };
    request.onerror = () => reject(new Error('Network Error'));
    request.ontimeout = () => reject(new Error('Request Timeout'));
    request.onabort = () => reject(new Error('Request Aborted'));
    request.send();
  }).finally(() => {
    if (xhr) _demoBlobRequests.delete(xhr);
    _demoPreloadInFlight.delete(track.id);
  });
}

function preloadDemoTrack(index: number): void {
  const track = getDemoTrackByIndex(index);
  if (_demoBlobCache.has(track.id) || _demoPreloadInFlight.has(track.id)) return;
  const request = fetchDemoBlob(track, false).catch((error) => {
    log.warn(`[Demo] Preload failed for ${track.id}`, error);
    throw error;
  });
  void request.catch(() => {});
  _demoPreloadInFlight.set(track.id, request);
}

function beginDemoLoad(): DemoLoadOwner {
  const owner = { generation: ++_demoLoadGeneration, room: captureDemoRoomIdentity() } as const;
  _activeDemoLoadOwner = owner;
  return owner;
}

function isCurrentDemoLoadOwner(owner: DemoLoadOwner): boolean {
  return _activeDemoLoadOwner === owner && getState('demo.active') && isCurrentDemoRoom(owner.room);
}

function getDemoLoadResult(
  owner: DemoLoadOwner,
  status: DemoAsyncResult['status'],
): DemoAsyncResult {
  return { status, generation: owner.generation };
}

function getSupersededDemoResult(): DemoAsyncResult {
  return { status: 'superseded', generation: _demoLoadGeneration };
}

function isCurrentDemoResult(result: DemoAsyncResult): boolean {
  return (
    result.status === 'applied' &&
    result.generation === _demoLoadGeneration &&
    getState('demo.active')
  );
}

function finishDemoLoad(owner: DemoLoadOwner): boolean {
  if (_activeDemoLoadOwner !== owner) return false;
  _activeDemoLoadOwner = null;
  setState('demo.loading', false);
  showLoader(false);
  return true;
}

function supersedeDemoLoad(): void {
  _demoLoadGeneration += 1;
  _activeDemoLoadOwner = null;
}

function publishDemoTrackMeta(track: DemoTrack): TrackMeta {
  const meta = createDemoTrackMeta(track);
  _activeDemoTrackMeta = meta;
  setPlaybackTrackMeta(meta);
  return meta;
}

async function fetchDemoBlobForLoad(track: DemoTrack, owner: DemoLoadOwner): Promise<Blob> {
  try {
    return await fetchDemoBlob(track, true);
  } catch (error) {
    // One retry covers a transient participant-side CDN failure. A newer host
    // request or retired room takes priority over retrying obsolete content.
    if (
      !getState('network.hostConn') ||
      !isCurrentDemoLoadOwner(owner) ||
      _queuedDemoEnterIndex !== null
    )
      throw error;
    return fetchDemoBlob(track, true);
  }
}

async function loadDemoTrack(
  index: number,
  options: { autoplay: boolean },
  owner: DemoLoadOwner,
): Promise<DemoAsyncResult> {
  if (!isCurrentDemoLoadOwner(owner)) return getDemoLoadResult(owner, 'superseded');
  // Retire output before exposing the next demo identity. Otherwise a fast
  // guest can bootstrap from a PONG advertising the old source as the new row.
  _hostDemoPlayOwner = null;
  setDemoHostStartAt(null);
  pause(0, { holdVisualizer: false, showToast: false });
  setPlaybackFilePaused();
  const track = getDemoTrackByIndex(index);
  _demoTrackIndex = index;
  setState('demo.currentTrackIndex', index);
  setCurrentAudioBuffer(null);
  const trackMeta = publishDemoTrackMeta(track);
  syncDemoTrackText();

  showLoader(true, t('transfer.demo_loading_short'));
  updateLoader(0);
  try {
    const blob = await fetchDemoBlobForLoad(track, owner);
    if (!isCurrentDemoLoadOwner(owner)) return getDemoLoadResult(owner, 'superseded');

    const file = new File([blob], track.fileName, { type: track.mime });
    try {
      await loadDemoFile(file, trackMeta, newLoadEpoch());
    } catch (error) {
      // Native content failures poison a previously successful HTTP cache hit.
      // Output permission/initialization and supersession must retain good bytes.
      if (
        isCurrentDemoLoadOwner(owner) &&
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'EncodingError' &&
        _demoBlobCache.get(track.id) === blob
      ) {
        _demoBlobCache.delete(track.id);
      }
      throw error;
    }
    if (!isCurrentDemoLoadOwner(owner)) return getDemoLoadResult(owner, 'superseded');

    preloadDemoTrack(getNextDemoTrackIndex(index));
    if (options.autoplay) {
      await play(0);
      if (!isCurrentDemoLoadOwner(owner)) return getDemoLoadResult(owner, 'superseded');
    }
    return getDemoLoadResult(owner, 'applied');
  } catch (error) {
    // Fetch/decode cannot always be cancelled by the browser. Once a newer
    // demo incarnation owns the UI, a late rejection is ordinary
    // supersession rather than a failure of the current demo.
    if (!isCurrentDemoLoadOwner(owner)) return getDemoLoadResult(owner, 'superseded');
    throw error;
  }
}

function mountVisualizerForMobile(): void {
  const slot = document.getElementById('demo-visualizer-slot');
  const wrapper = document.querySelector<HTMLElement>('.vinyl-wrapper');
  if (!slot || !wrapper || wrapper.parentElement === slot) return;

  _visualizerPlaceholder = document.createComment('demo-visualizer-placeholder');
  wrapper.parentNode?.insertBefore(_visualizerPlaceholder, wrapper);
  slot.appendChild(wrapper);
}

function restoreVisualizer(): void {
  const wrapper = document.querySelector<HTMLElement>('.vinyl-wrapper');
  if (!_visualizerPlaceholder || !wrapper) return;
  _visualizerPlaceholder.parentNode?.insertBefore(wrapper, _visualizerPlaceholder);
  _visualizerPlaceholder.parentNode?.removeChild(_visualizerPlaceholder);
  _visualizerPlaceholder = null;
}

function cancelDemoEnterReveal(): void {
  if (!_demoEnterRevealRaf) return;
  cancelAnimationFrame(_demoEnterRevealRaf);
  _demoEnterRevealRaf = 0;
}

function getDemoCurtain(): HTMLElement | null {
  return document.getElementById('demo-curtain');
}

function getDemoCurtainDuration(): number {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 1 : DEMO_OVERLAY_FADE_MS;
}

function stopDemoCurtainAnimation(): void {
  _demoCurtainAnimation?.cancel();
  _demoCurtainAnimation = null;
}

function setDemoChromeHiding(active: boolean): void {
  document.body.classList.toggle('demo-chrome-hiding', active);
}

function animateDemoCurtain(
  curtain: HTMLElement,
  from: string,
  to: string,
  onFinish?: () => void,
): void {
  stopDemoCurtainAnimation();
  const duration = getDemoCurtainDuration();
  if (!curtain.animate || duration <= 1) {
    curtain.style.opacity = to;
    onFinish?.();
    return;
  }

  curtain.style.opacity = from;
  const animation = curtain.animate([{ opacity: from }, { opacity: to }], {
    duration,
    easing: 'ease',
    fill: 'forwards',
  });
  _demoCurtainAnimation = animation;
  animation.onfinish = () => {
    if (_demoCurtainAnimation !== animation) return;
    _demoCurtainAnimation = null;
    curtain.style.opacity = to;
    onFinish?.();
  };
  animation.oncancel = () => {
    if (_demoCurtainAnimation === animation) _demoCurtainAnimation = null;
  };
}

function revealDemoCurtain(curtain: HTMLElement, onFinish?: () => void): void {
  cancelDemoEnterReveal();
  _demoEnterRevealRaf = requestAnimationFrame(() => {
    _demoEnterRevealRaf = requestAnimationFrame(() => {
      _demoEnterRevealRaf = 0;
      animateDemoCurtain(curtain, '1', '0', onFinish);
    });
  });
}

function transitionThroughDemoCurtain(onCovered: () => void, onRevealed?: () => void): void {
  const curtain = getDemoCurtain();
  if (!curtain) {
    onCovered();
    onRevealed?.();
    return;
  }

  cancelDemoEnterReveal();
  stopDemoCurtainAnimation();
  const from = getComputedStyle(curtain).opacity || '0';
  animateDemoCurtain(curtain, from, '1', () => {
    onCovered();
    revealDemoCurtain(curtain, onRevealed);
  });
}

function applyDemoDomActive(overlay: HTMLElement | null): void {
  document.body.classList.add('mode-demo', 'demo-mobile');
  syncDemoThemeChrome();
  if (overlay) {
    overlay.classList.remove('entering', 'exiting');
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
  }
  mountVisualizerForMobile();
  updateOverlayOpenClass();
  if (overlay) bus.emit('ui:scrollbar-reveal', overlay);
  scheduleDemoLayoutRefresh();
}

function applyDemoDomInactive(overlay: HTMLElement | null): void {
  setDemoChromeHiding(false);
  document.body.classList.remove('mode-demo', 'demo-mobile');
  syncAppThemeChrome();
  overlay?.classList.remove('active', 'entering', 'exiting');
  restoreVisualizer();
  bus.emit('visualizer:refresh-presentation');
  updateOverlayOpenClass();
}

function setDemoDomActive(active: boolean, options: { afterCovered?: () => void } = {}): void {
  cancelDemoEnterReveal();
  clearManagedTimer(DEMO_OVERLAY_EXIT_TIMER);

  const overlay = document.getElementById('demo-overlay');

  if (active) {
    if (overlay?.classList.contains('active')) {
      applyDemoDomActive(overlay);
    } else {
      setDemoChromeHiding(true);
      transitionThroughDemoCurtain(
        () => applyDemoDomActive(overlay),
        () => setDemoChromeHiding(false),
      );
    }
  } else {
    const wasActive = !!overlay?.classList.contains('active');
    if (overlay) {
      overlay.classList.remove('entering');
      overlay.classList.add('exiting');
      overlay.setAttribute('aria-hidden', 'true');
    }
    if (wasActive) {
      // Single-run exit completion. Three possible invokers — the curtain
      // onfinish, the fallback timer (hidden-tab WAAPI defers onfinish), and
      // a re-entry's finishPendingDemoExitRestore() — the token guarantees
      // exactly one runs the snapshot restore.
      const finishExit = (): void => {
        if (_pendingDemoExitFinish !== finishExit) return;
        _pendingDemoExitFinish = null;
        clearManagedTimer(DEMO_OVERLAY_EXIT_TIMER);
        options.afterCovered?.();
        applyDemoDomInactive(overlay);
      };
      _pendingDemoExitFinish = finishExit;
      transitionThroughDemoCurtain(() => finishExit());
      setManagedTimer(
        DEMO_OVERLAY_EXIT_TIMER,
        () => {
          // Cancel the curtain animation so a deferred onfinish
          // can't fire again after visibility returns.
          stopDemoCurtainAnimation();
          finishExit();
          const curtain = getDemoCurtain();
          if (curtain) curtain.style.opacity = '0';
        },
        DEMO_OVERLAY_FADE_MS * 2 + 240,
      );
    } else {
      // Entry can fail before its covering animation publishes the overlay.
      // Retire that callback too, or it can reopen an already exited demo.
      stopDemoCurtainAnimation();
      const curtain = getDemoCurtain();
      if (curtain) curtain.style.opacity = '0';
      options.afterCovered?.();
      applyDemoDomInactive(overlay);
    }
  }

  syncDemoTrackText();
  syncDemoSessionCopy();
  syncDemoStep();
}

function refreshDemoLayout(): void {
  if (!getState('demo.active')) return;
  bus.emit('ui:scrollbar-relayout');
  window.dispatchEvent(new Event('resize'));
}

function scheduleDemoLayoutRefresh(): void {
  DEMO_LAYOUT_REFRESH_DELAYS_MS.forEach((delayMs) => {
    setManagedTimer(`demo-layout-refresh-${delayMs}`, refreshDemoLayout, delayMs);
  });
}

function syncDemoTrackText(): void {
  const track = getCurrentDemoTrack();
  document.querySelectorAll<HTMLElement>('.demo-track-title').forEach((el) => {
    el.textContent = track.title;
  });
  document.querySelectorAll<HTMLElement>('.demo-track-artist').forEach((el) => {
    el.textContent = `© ${track.artist}`;
  });

  syncDemoTrackList();
}

function syncDemoTrackList(): void {
  document.querySelectorAll<HTMLElement>('[data-demo-track-index]').forEach((row) => {
    const index = Number(row.dataset.demoTrackIndex);
    const active = index === _demoTrackIndex;
    row.classList.toggle('active', active);
    row.setAttribute('aria-current', active ? 'true' : 'false');
    const title = row.querySelector<HTMLElement>('strong');
    if (title && DEMO_TRACKS[index]) title.textContent = DEMO_TRACKS[index].title;
  });
}

function getDemoSessionCode(): string {
  const code = getState('network.sessionCode') || getState('network.lastJoinCode');
  return /^\d{6}$/.test(code) ? code : '------';
}

function getDemoDeviceCount(): number {
  const deviceList = getState('network.lastKnownDeviceList') as unknown;
  if (Array.isArray(deviceList) && deviceList.length > 0) {
    const connected = deviceList.filter((peer) => {
      if (!peer || typeof peer !== 'object') return false;
      const status = (peer as { status?: unknown }).status;
      return status !== 'disconnected';
    }).length;
    if (connected > 0) return connected;
  }

  const peers = getState('network.connectedPeers') as unknown;
  if (!Array.isArray(peers)) return 1;
  const connectedGuests = peers.filter((peer) => {
    if (!peer || typeof peer !== 'object') return false;
    return (peer as { status?: unknown }).status !== 'disconnected';
  }).length;
  return Math.max(1, connectedGuests + (getState('network.hostConn') ? 0 : 1));
}

function syncDemoSessionCopy(): void {
  const code = getDemoSessionCode();
  const count = getDemoDeviceCount();
  document.querySelectorAll<HTMLElement>('[data-demo-session-title]').forEach((el) => {
    el.textContent = t('demo.session_title', { code });
  });
  document.querySelectorAll<HTMLElement>('[data-demo-session-subtitle]').forEach((el) => {
    el.textContent = t('demo.session_subtitle');
  });
  document.querySelectorAll<HTMLElement>('[data-demo-session-body]').forEach((el) => {
    el.textContent =
      count > 1 ? t('demo.session_body_connected', { count }) : t('demo.session_body_alone');
  });
  observeDemoOperation(renderDemoQRCode(code), 'QR render');
}

let _demoQrGeneration = 0;
// Last code whose SVG actually committed to the DOM. Same-code calls are
// no-ops: syncDemoSessionCopy re-runs on every connectedPeers/device-list
// event, and regenerating an identical QR per event is pure waste.
let _lastQrRenderedCode: string | null = null;
async function renderDemoQRCode(code: string): Promise<void> {
  const container = document.getElementById('demo-session-qr');
  if (!container) return;

  // Dedup BEFORE the generation bump so a deduped call is equivalent to
  // never having been made, preserving stale-async token semantics.
  if (code === _lastQrRenderedCode) return;

  // Bump generation BEFORE validating, so a later invalid-code call invalidates
  // a pending valid-code await — without this, a stale SVG from the prior valid
  // code could clobber the placeholder set on the subsequent invalid call.
  const gen = ++_demoQrGeneration;

  if (!/^\d{6}$/.test(code)) {
    const p = document.createElement('p');
    p.className = 'demo-session-qr-placeholder';
    p.textContent = t('connect.no_session');
    container.replaceChildren(p);
    // Placeholder is never cached: it must re-render on i18n changes, and
    // the next valid code must always render.
    _lastQrRenderedCode = null;
    return;
  }

  try {
    const { default: QRCode } = await import('qrcode');
    const svgString = await QRCode.toString(`MUSIXQUARE.COM/${code}`, {
      type: 'svg',
      margin: 2,
      errorCorrectionLevel: 'L',
      color: {
        dark: '#000000',
        light: '#00000000',
      },
    });
    if (gen !== _demoQrGeneration) return;
    container.innerHTML = svgString;
    _lastQrRenderedCode = code;
    const svg = container.querySelector('svg');
    if (svg) {
      svg.classList.add('qr-svg');
      svg.removeAttribute('width');
      svg.removeAttribute('height');
    }
  } catch (error) {
    log.warn('[Demo] QR generation failed', error);
  }
}

function syncDemoStep(step = _demoStep, revealScrollbar = false): void {
  _demoStep = Math.min(4, Math.max(1, Number(step) || 1));
  document.querySelectorAll<HTMLElement>('[data-demo-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.demoPanel === String(_demoStep));
  });
  const stepButtons = document.querySelectorAll<HTMLElement>('[data-demo-step]');
  stepButtons.forEach((btn) => {
    const active = btn.dataset.demoStep === String(_demoStep);
    const wasActive = btn.classList.contains('active');
    const collapseTimer = _demoStepCollapseTimers.get(btn);
    if (collapseTimer) window.clearTimeout(collapseTimer);

    if (wasActive && !active) {
      btn.classList.add('is-collapsing');
      _demoStepCollapseTimers.set(
        btn,
        window.setTimeout(() => {
          btn.classList.remove('is-collapsing');
          _demoStepCollapseTimers.delete(btn);
        }, DEMO_STEP_COLLAPSE_MS),
      );
    } else {
      btn.classList.remove('is-collapsing');
      _demoStepCollapseTimers.delete(btn);
    }
  });
  syncExclusivePressedState(stepButtons, (button) => button.dataset.demoStep === String(_demoStep));
  document.querySelectorAll<HTMLElement>('[data-demo-next]').forEach((btn) => {
    const isFinal = _demoStep >= 4;
    btn.classList.toggle('active', isFinal);
    btn.classList.toggle('is-final', isFinal);
    btn.setAttribute('aria-label', t(isFinal ? 'demo.step_finish' : 'common.next'));
    btn.setAttribute('title', t(isFinal ? 'demo.step_finish' : 'common.next'));
  });
  const overlay = document.getElementById('demo-overlay');
  if (revealScrollbar && overlay?.classList.contains('active')) {
    bus.emit('ui:scrollbar-reveal', overlay);
  } else {
    bus.emit('ui:scrollbar-relayout');
  }
  window.dispatchEvent(new Event('resize'));
}

function syncRoleButtons(): void {
  const mode = getState('audio.channelMode');
  document.querySelectorAll<HTMLElement>('[data-demo-role]').forEach((btn) => {
    const active = Number(btn.dataset.demoRole) === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  document
    .querySelectorAll<HTMLElement>('[data-role-diagram="demo"] .graphic-speaker[data-role-mode]')
    .forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.roleMode) === mode);
    });
}

function syncEffectButtons(): void {
  const reverbOn = getState('demo.reverbOn');
  const bassOn = getState('demo.bassBoostOn');
  const trebleOn = getState('demo.trebleBoostOn');
  const surroundOn = getState('demo.surroundOn');
  document.querySelectorAll<HTMLElement>('[data-demo-effect="reverb"]').forEach((btn) => {
    btn.classList.toggle('active', reverbOn);
    btn.setAttribute('aria-pressed', String(reverbOn));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-effect="bass"]').forEach((btn) => {
    btn.classList.toggle('active', bassOn);
    btn.setAttribute('aria-pressed', String(bassOn));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-effect="treble"]').forEach((btn) => {
    btn.classList.toggle('active', trebleOn);
    btn.setAttribute('aria-pressed', String(trebleOn));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-effect="surround"]').forEach((btn) => {
    btn.classList.toggle('active', surroundOn);
    btn.setAttribute('aria-pressed', String(surroundOn));
  });
}

function eqMatches(
  values: readonly number[] | null | undefined,
  preset: readonly number[],
): boolean {
  if (!Array.isArray(values) || values.length < preset.length) return false;
  return preset.every((value, index) => Number(values[index]) === value);
}

function getDemoEqPreset(bassOn: boolean, trebleOn: boolean): number[] {
  if (bassOn && trebleOn) return V_SHAPE_EQ;
  if (bassOn) return WARM_EQ;
  if (trebleOn) return BRIGHT_EQ;
  return FLAT_EQ;
}

function applyDemoToneState(
  bassOn = getState('demo.bassBoostOn'),
  trebleOn = getState('demo.trebleBoostOn'),
): void {
  // Bass, treble, and their EQ curve are one user action. Apply the first
  // mutations as previews so settings sync publishes only the final complete
  // snapshot instead of a burst of intermediate authority states.
  bus.emit('audio:update-effect', 'vbass', 'mix', bassOn ? 60 : 0, true);
  bus.emit('audio:update-effect', 'exciter', 'mix', trebleOn ? 1 : 0, true);
  applyDemoEqPreset(getDemoEqPreset(!!bassOn, !!trebleOn));
}

function readDemoEffectStateFromAudio(fallbackTreble = false): DemoEffectState {
  const eqValues = getState('audio.eqValues');
  const eqIsFlat = eqMatches(eqValues, FLAT_EQ);
  const eqIsWarm = eqMatches(eqValues, WARM_EQ);
  const eqIsBright = eqMatches(eqValues, BRIGHT_EQ);
  const eqIsVShape = eqMatches(eqValues, V_SHAPE_EQ);
  const exciterOn = !!getState('audio.exciter');
  const trebleOn =
    exciterOn || eqIsBright || eqIsVShape ? true : eqIsFlat || eqIsWarm ? false : fallbackTreble;

  return {
    reverbOn: (getState('audio.reverbMix') || 0) > 0.001,
    bassOn: (getState('audio.virtualBass') || 0) > 0.001,
    trebleOn,
    surroundOn: (getState('audio.stereoWidth') || 1) > 1.001,
  };
}

function applyDemoEffectState(state: DemoEffectState): void {
  if (getState('demo.reverbOn') !== state.reverbOn) {
    setState('demo.reverbOn', state.reverbOn);
  }
  if (getState('demo.bassBoostOn') !== state.bassOn) {
    setState('demo.bassBoostOn', state.bassOn);
  }
  if (getState('demo.trebleBoostOn') !== state.trebleOn) {
    setState('demo.trebleBoostOn', state.trebleOn);
  }
  if (getState('demo.surroundOn') !== state.surroundOn) {
    setState('demo.surroundOn', state.surroundOn);
  }
}

function syncDemoEffectStateFromAudio(): void {
  if (!getState('demo.active')) return;
  applyDemoEffectState(readDemoEffectStateFromAudio(!!getState('demo.trebleBoostOn')));
  syncEffectButtons();
  broadcastDemoStateIfChanged();
}

function scheduleDemoEffectStateSync(): void {
  if (!getState('demo.active')) return;
  setManagedTimer('demo-effect-state-sync', syncDemoEffectStateFromAudio, 40);
}

function isDemoPlaying(): boolean {
  const playback = getPlaybackModeActivitySnapshot();
  return getState('demo.active') && playback.mode === 'file' && playback.activity === 'playing';
}

function syncPlayButton(): void {
  const playing = isDemoPlaying();
  const loading =
    !!getState('demo.loading') || (getState('demo.active') && isLocalFileStartPending());
  document
    .querySelectorAll<HTMLButtonElement>('[data-demo-play], .demo-settings-button')
    .forEach((button) => {
      button.classList.toggle('is-loading', loading);
      button.setAttribute('aria-busy', loading ? 'true' : 'false');
      if (button.matches('[data-demo-play]')) {
        const disabled = loading || !!getState('network.hostConn');
        button.disabled = disabled;
        button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      } else {
        button.disabled = false;
        button.removeAttribute('aria-disabled');
      }
    });
  document.querySelectorAll<HTMLElement>('[data-demo-play-icon]').forEach((path) => {
    path.setAttribute('d', playing ? 'M6 19h4V5H6v14zm8-14v14h4V5h-4z' : 'M8 5v14l11-7z');
  });
}

function isCurrentDemoPlaybackIntent(intent: DemoPlaybackIntent): boolean {
  return (
    _demoPlaybackIntent === intent &&
    getState('demo.active') &&
    _demoTrackIndex === intent.index &&
    getState('network.hostConn') === intent.connection &&
    isCurrentDemoRoom(intent.room)
  );
}

function pauseDemoAt(time: number): void {
  pause(time, { holdVisualizer: false, showToast: false });
  // Transport pause deliberately no-ops for READY/paused buffers. The host's
  // desired position still owns the post-decode projection on a late join.
  setState('player.pausedAt', time);
  setPlaybackFilePaused();
  const duration = getCurrentAudioBuffer()?.duration ?? 0;
  bus.emit('ui:time-update', fmtTime(time), fmtTime(duration), time, duration);
}

function applyPendingDemoPlayback(): void {
  const intent = _demoPlaybackIntent;
  const buffer = getCurrentAudioBuffer();
  if (
    !intent ||
    !buffer ||
    intent === _appliedDemoPlaybackIntent ||
    !isCurrentDemoPlaybackIntent(intent)
  )
    return;
  _appliedDemoPlaybackIntent = intent;
  clearManagedTimer('demo-play-host-sync');
  if (intent.kind === 'pause') {
    pauseDemoAt(Math.min(intent.time, buffer.duration));
  } else {
    const now = Date.now();
    const generation = _demoLoadGeneration;
    const projected = projectDemoPlay(
      intent,
      now,
      intent.hostPlayAt > 0 && isClockCalibrated() ? getHostNow() : null,
      buffer.duration,
    );
    const isCurrent = () =>
      generation === _demoLoadGeneration &&
      isCurrentDemoPlaybackIntent(intent) &&
      getCurrentAudioBuffer() === buffer &&
      !isLocalFilePaused();
    if (projected.ended) {
      // Transport clamps an out-of-range start back to zero. Wait for the
      // host's next track instead of briefly replaying this expired one.
      pauseDemoAt(projected.position);
    } else {
      observeDemoOperation(
        play(
          projected.position,
          projected.delay,
          performance.now() + projected.delay * 1_000,
          isCurrent,
        ),
        'guest playback',
      );
      bus.emit('sync:arm-initial');
    }
    setManagedTimer(
      'demo-play-host-sync',
      () => {
        if (isCurrent() && intent.connection.open) bus.emit('sync:request-immediate-ping');
      },
      250,
    );
  }
  syncPlayButton();
}

function stopDemoPlaybackForIncomingTrack(index: number): void {
  if (!getState('demo.active') || _demoTrackIndex === index) return;
  pause(0, { holdVisualizer: false, showToast: false });
  bus.emit('ui:seek-reset');
  syncPlayButton();
}

function startDemoPlayback(time = 0): void {
  const owner = {};
  _hostDemoPlayOwner = owner;
  const generation = _demoLoadGeneration;
  const index = _demoTrackIndex;
  const buffer = getCurrentAudioBuffer();
  const room = captureDemoRoomIdentity();
  const isCurrent = () =>
    _hostDemoPlayOwner === owner &&
    generation === _demoLoadGeneration &&
    getState('demo.active') &&
    _demoTrackIndex === index &&
    getCurrentAudioBuffer() === buffer &&
    buffer !== null &&
    isCurrentDemoRoom(room) &&
    isDemoHost();
  let published = false;
  const publishOnce = (): void => {
    if (published || !isCurrent() || !isDemoPlaying()) return;
    published = true;
    const pendingDeadline = getLocalFilePendingStartDeadlineMs();
    const hostStartAt =
      getHostNow() + Math.max(0, (pendingDeadline ?? performance.now()) - performance.now());
    setDemoHostStartAt(hostStartAt);
    broadcastDemoPlay(index, getTrackPosition(), hostStartAt);
  };
  const startLeadSeconds = getState('network.connectedPeers').some((peer) => peer.conn?.open)
    ? DEMO_PLAY_START_LEAD_MS / 1_000
    : 0;
  observeDemoOperation(
    play(time, startLeadSeconds, undefined, isCurrent, {
      timing: 'canonical-rebase',
      onRecoveredStarted: publishOnce,
    }).then((started) => {
      if (started) publishOnce();
    }),
    'host playback',
  );
  syncPlayButton();
}

type EnterDemoOptions = {
  index?: number;
  autoplay?: boolean;
  broadcastEntry?: boolean;
};

/**
 * Synchronously complete a still-animating exit's snapshot restore.
 * Called at the top of a fresh demo entry: without it the old exit's curtain
 * callback fires MID-new-demo (restoring stale settings into it), and the new
 * entry's snapshot — captured before the pending restore ran — would record
 * demo-flavored settings as "pre-demo", losing the user's originals.
 */
function finishPendingDemoExitRestore(): void {
  if (!_pendingDemoExitFinish) return;
  stopDemoCurtainAnimation();
  _pendingDemoExitFinish();
}

/**
 * Re-dispatch the newest host track command that was dropped by the
 * demo.loading guard while a load was in flight. Consumed before
 * dispatch, so a drain → enterDemoMode → drain chain is bounded.
 */
function drainQueuedDemoEnter(): void {
  const queued = _queuedDemoEnterIndex;
  _queuedDemoEnterIndex = null;
  if (queued === null) return;
  if (!getState('demo.active') || getState('demo.loading')) return;
  if (queued !== _demoTrackIndex || !getCurrentAudioBuffer()) {
    void enterDemoMode({ index: queued, autoplay: false, broadcastEntry: false }).catch(
      (error: unknown) => log.warn('[Demo] Queued demo enter failed:', error),
    );
    return;
  }
  applyPendingDemoPlayback();
}

function drainAfterFailedDemoLoad(owner: DemoLoadOwner): boolean {
  if (!isCurrentDemoLoadOwner(owner) || _queuedDemoEnterIndex === null) return false;
  // Consume only an independently received newer host request. A failed
  // attempt does not enqueue itself, so this cannot become an automatic loop.
  finishDemoLoad(owner);
  drainQueuedDemoEnter();
  return true;
}

async function enterDemoMode(options: EnterDemoOptions = {}): Promise<DemoAsyncResult> {
  // The guided demo is a standard-room host/guest protocol. PRO rooms use a
  // server-owned timeline and deliberately expose no coordinator, so entering
  // this legacy local overlay would pause only this device while the room kept
  // advancing. Keep the guard here as well as in CSS so synthetic events and
  // stale markup cannot split a PRO participant from the canonical session.
  if (isProRoomDemoBlocked()) return getSupersededDemoResult();
  if (getState('demo.loading')) return getSupersededDemoResult();
  // Guided demo playback never creates a room transport. Start the same
  // document-scoped optional Media Session loader used by room entry so lock
  // screen/hardware controls are not silently lost after the bundle split.
  observeDemoOperation(prepareMediaSession(), 'Media Session preparation');
  if (getState('demo.active')) {
    const nextIndex = normalizeDemoTrackIndex(options.index ?? _demoTrackIndex);
    // Reload also when the buffer is missing: a guest whose own fetch failed
    // would otherwise be stranded — the same-index skip plus
    // applyPendingDemoPlayback's null-buffer guard leave nothing to re-trigger
    // the load.
    if (nextIndex !== _demoTrackIndex || !getCurrentAudioBuffer()) {
      const owner = beginDemoLoad();
      setState('demo.loading', true);
      let result: DemoAsyncResult;
      try {
        result = await loadDemoTrack(nextIndex, { autoplay: !!options.autoplay }, owner);
      } catch (error) {
        if (drainAfterFailedDemoLoad(owner)) return getDemoLoadResult(owner, 'superseded');
        throw error;
      } finally {
        finishDemoLoad(owner);
      }
      if (!isCurrentDemoResult(result)) return getDemoLoadResult(owner, 'superseded');
    }
    // Re-check after the await because the listener exits demo if hostConn drops
    // mid-load. Without this guard, setDemoDomActive(true) would force the
    // DOM back into demo state while state.demo.active is already false.
    if (!getState('demo.active')) return getSupersededDemoResult();
    setDemoDomActive(true);
    applyPendingDemoPlayback();
    drainQueuedDemoEnter();
    return { status: 'applied', generation: _demoLoadGeneration };
  }

  markDemoPromptSeen();
  markAppUsed();
  finishPendingDemoExitRestore();
  _snapshot = captureSnapshot();
  const initialEffectState = readDemoEffectStateFromAudio(false);
  stopPlaybackForDemoEntry(_snapshot.playback);
  setCurrentAudioBuffer(null);
  _demoStep = 1;
  _demoTrackIndex = normalizeDemoTrackIndex(options.index ?? 0);
  setState('demo.active', true);
  const owner = beginDemoLoad();
  setState('demo.loading', true);
  applyDemoEffectState(initialEffectState);
  setState('demo.currentTrackIndex', _demoTrackIndex);
  publishDemoTrackMeta(getCurrentDemoTrack());
  hideSetupOverlay();
  bus.emit('ui:switch-tab', 'play');
  setDemoDomActive(true);
  syncRoleButtons();
  syncEffectButtons();
  if (options.broadcastEntry ?? true) broadcastDemoEnter(_demoTrackIndex);

  let result: DemoAsyncResult;
  try {
    result = await loadDemoTrack(_demoTrackIndex, { autoplay: !!options.autoplay }, owner);
    if (!isCurrentDemoResult(result)) return result;
    applyPendingDemoPlayback();
    showToast(t('transfer.demo_loaded'));
  } catch (error: unknown) {
    if (!isCurrentDemoLoadOwner(owner)) return getDemoLoadResult(owner, 'superseded');
    if (drainAfterFailedDemoLoad(owner)) return getDemoLoadResult(owner, 'superseded');
    log.error('[Demo] Enter failed:', error);
    showToast(`${t('transfer.demo_load_fail')} ${(error as Error).message || ''}`.trim());
    exitDemoMode({ restoreAudioSettings: true });
    return getDemoLoadResult(owner, 'superseded');
  } finally {
    finishDemoLoad(owner);
  }
  // A host advance that landed during the load above was dropped by the
  // demo.loading guard — re-dispatch it now (no-op if nothing queued or the
  // catch path exited demo, which also clears the queue).
  if (isCurrentDemoResult(result)) drainQueuedDemoEnter();
  return result;
}

function exitDemoMode(options: ExitDemoOptions = {}): void {
  if (!getState('demo.active') && !getState('demo.loading')) return;
  if (options.broadcastExit ?? true) broadcastDemoExit();
  supersedeDemoLoad();
  const exitGeneration = _demoLoadGeneration;
  const snapshot = _snapshot;
  const activeDemoTrackMeta = _activeDemoTrackMeta;
  _activeDemoTrackMeta = null;
  _demoPlaybackIntent = null;
  _appliedDemoPlaybackIntent = null;
  _hostDemoPlayOwner = null;
  _queuedDemoEnterIndex = null;
  _lastDemoStateBroadcastKey = '';
  stopAllMedia({
    cancelInFlight: true,
  });
  // stopAllMedia deliberately preserves track metadata for ordinary transport
  // transitions. Demo metadata is synthetic, however, and must not survive an
  // exit that has no real media snapshot to restore. Clear only the exact
  // synthetic object still owned by this demo incarnation: a successor may
  // already have published real metadata while the exit curtain is opening.
  if (getState('player.currentTrackMeta') === activeDemoTrackMeta) {
    setPlaybackTrackMeta(null);
  }
  setCurrentAudioBuffer(null);
  setState('demo.active', false);
  setState('demo.loading', false);
  showLoader(false);
  setState('demo.currentTrackIndex', -1);
  setState('demo.reverbOn', false);
  setState('demo.bassBoostOn', false);
  setState('demo.trebleBoostOn', false);
  setState('demo.surroundOn', false);
  clearDemoRuntimeWork();
  _snapshot = null;
  setDemoDomActive(false, {
    afterCovered: () => {
      try {
        if (options.restoreSnapshot === false) return;
        const restoreMedia = shouldRestoreDemoSnapshotMedia(
          getPlaybackModeActivitySnapshot(),
          getState('playback.lifecycle'),
        );
        if (!restoreMedia) {
          log.info(
            '[Demo] Skipping stale media snapshot restore; new playback started during exit',
          );
        }
        // Completing the demo commits the role and effects the user just chose.
        // Failed/interrupted entry paths opt back into restoring the audio
        // snapshot, while media restoration remains independent.
        // Clear the demo timeline before restoring the captured owner. The
        // restored file-mode projection must be the final writer.
        if (restoreMedia) bus.emit('ui:seek-reset');
        restoreSnapshot(snapshot, {
          audio: options.restoreAudioSettings ?? false,
          media: restoreMedia,
          isCurrent: () =>
            _demoLoadGeneration === exitGeneration &&
            !getState('demo.active') &&
            !getState('demo.loading') &&
            !!snapshot &&
            hasCurrentDemoRestoreAuthority(snapshot.room),
        });
      } finally {
        // The state setter retains a restored resource before this releases
        // the snapshot. Authority resets and superseded restores release it
        // too, so an abandoned decoder cannot survive a room/demo transition.
        releaseSnapshotResource(snapshot);
      }
    },
  });
}

function openDemoInfo(): void {
  window.open(getCurrentDemoTrack().infoUrl, '_blank', 'noopener');
}

function requestDemoExit(): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) {
    if (hasRoomCapability('room.configure') && hostConn.open) {
      safeSend(hostConn, { type: MSG.REQUEST_DEMO_EXIT });
      showToast(t('demo.try_later_toast'));
      return;
    }
    showToast(t('demo.host_only_exit'));
    return;
  }
  exitDemoMode();
  showToast(t('demo.try_later_toast'));
}

function enforceDemoRoomBoundary(): void {
  if (!isProRoomDemoBlocked()) return;
  if (!getState('demo.active') && !getState('demo.loading')) return;

  // A same-page standard -> PRO transition must not carry a local demo or its
  // captured standard-room media into the server-owned PRO session.
  exitDemoMode({ broadcastExit: false, restoreSnapshot: false });
}

function advanceDemoStep(): void {
  if (_demoStep >= 4) {
    bus.emit('demo:request-exit');
    return;
  }
  syncDemoStep(_demoStep + 1, true);
}

function getPlacementToastKey(mode: number): Parameters<typeof t>[0] {
  if (mode === -1) return 'role.left_placement';
  if (mode === 1) return 'role.right_placement';
  return 'role.center_placement';
}

function setDemoRole(mode: number): void {
  if (!Number.isFinite(mode)) return;
  bus.emit('audio:set-channel-mode', mode);
  syncRoleButtons();
  showToast(t(getPlacementToastKey(mode)));
}

function toggleDemoReverb(): void {
  const next = !getState('demo.reverbOn');
  setState('demo.reverbOn', next);
  bus.emit('audio:reverb-type-change', next ? 'arena' : 'off');
  syncEffectButtons();
}

function applyDemoEqPreset(values: number[]): void {
  values.forEach((value, band) => {
    bus.emit('audio:set-eq', band, value, band < values.length - 1);
  });
}

function toggleDemoBass(): void {
  const next = !getState('demo.bassBoostOn');
  setState('demo.bassBoostOn', next);
  applyDemoToneState(next, !!getState('demo.trebleBoostOn'));
  syncEffectButtons();
}

function toggleDemoTreble(): void {
  const next = !getState('demo.trebleBoostOn');
  setState('demo.trebleBoostOn', next);
  applyDemoToneState(!!getState('demo.bassBoostOn'), next);
  syncEffectButtons();
}

function toggleDemoSurround(): void {
  const next = !getState('demo.surroundOn');
  setState('demo.surroundOn', next);
  bus.emit('audio:update-effect', 'stereo', 'mix', next ? 120 : 100, false);
  syncEffectButtons();
}

function toggleDemoPlay(): void {
  if (!getState('demo.active')) return;
  if (getState('demo.loading')) return;
  if (getState('network.hostConn')) {
    showToast(t('demo.host_only_exit'));
    return;
  }
  if (isDemoPlaying()) {
    _hostDemoPlayOwner = null;
    setDemoHostStartAt(null);
    pause(undefined, { showToast: false });
    broadcastDemoPause(getState('player.pausedAt') || 0);
    syncPlayButton();
    return;
  }
  // Buffer can be null after a failed track-advance fetch (the index moved
  // before the load, and a same-index re-enter skips the load): refetch and
  // broadcast DEMO_PLAY only AFTER success. A bare play() here no-ops with a
  // misleading "add media" toast while guests whose fetch succeeded start
  // playing — splitting the room.
  if (!getCurrentAudioBuffer()) {
    const owner = beginDemoLoad();
    setState('demo.loading', true);
    void loadDemoTrack(_demoTrackIndex, { autoplay: false }, owner)
      .then((result) => {
        if (!isCurrentDemoResult(result)) return;
        startDemoPlayback(0);
      })
      .catch((error: unknown) => {
        if (!isCurrentDemoLoadOwner(owner)) return;
        log.warn('[Demo] Failed to reload demo track on play tap', error);
        showToast(`${t('transfer.demo_load_fail')} ${(error as Error).message || ''}`.trim());
      })
      .finally(() => {
        finishDemoLoad(owner);
      });
    return;
  }
  const offset = getState('player.pausedAt') || 0;
  startDemoPlayback(offset);
}

function advanceDemoTrack(): void {
  if (!isDemoHost() || !getState('demo.active') || getState('demo.loading')) return;
  const nextIndex = getNextDemoTrackIndex(_demoTrackIndex);
  const owner = beginDemoLoad();
  setState('demo.loading', true);
  const loading = loadDemoTrack(nextIndex, { autoplay: false }, owner);
  broadcastDemoEnter(nextIndex);
  void loading
    .then((result) => {
      // Exit-during-load: a late DEMO_PLAY broadcast would re-enter guests
      // into demo after the host already left.
      if (!isCurrentDemoResult(result)) return;
      startDemoPlayback(0);
    })
    .catch((error: unknown) => {
      if (!isCurrentDemoLoadOwner(owner)) return;
      log.warn('[Demo] Failed to advance demo track', error);
      showToast(`${t('transfer.demo_load_fail')} ${(error as Error).message || ''}`.trim());
    })
    .finally(() => {
      finishDemoLoad(owner);
    });
}

function handleDemoEnterMessage(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isTrustedDemoHostMessage(conn)) return;
  const index = normalizeDemoTrackIndex(data.index);
  if (_demoPlaybackIntent?.index !== index) _demoPlaybackIntent = null;
  // A load in flight drops the enterDemoMode call below on its
  // demo.loading guard — queue the index so the post-load drain converges.
  if (getState('demo.loading')) _queuedDemoEnterIndex = index === _demoTrackIndex ? null : index;
  stopDemoPlaybackForIncomingTrack(index);

  const applyEffectFlags = (): void => {
    if (!getState('demo.active')) return;
    setState('demo.reverbOn', !!data.reverbOn);
    setState('demo.bassBoostOn', !!data.bassBoostOn);
    setState('demo.trebleBoostOn', !!data.trebleBoostOn);
    setState('demo.surroundOn', !!data.surroundOn);
    syncEffectButtons();
  };

  // Effect-toggle rebroadcasts (already active, same loaded track)
  // must not re-run the full enterDemoMode DOM path — that fired ~5 synthetic
  // resize storms per toggle on every guest. Flags-only apply.
  if (
    getState('demo.active') &&
    !getState('demo.loading') &&
    index === _demoTrackIndex &&
    getCurrentAudioBuffer()
  ) {
    applyEffectFlags();
    return;
  }

  const entry = enterDemoMode({ index, autoplay: false, broadcastEntry: false });
  // Entry publishes demo.active synchronously before fetching media. Apply
  // host flags at this message boundary, including while a track is loading,
  // so an older fetch completion cannot overwrite a newer effect update.
  applyEffectFlags();
  void entry.catch((error: unknown) => log.warn('[Demo] Guest demo enter failed:', error));
}

function handleDemoPlayMessage(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!conn || !isTrustedDemoHostMessage(conn)) return;
  setLocalFilePaused(false);
  const index = normalizeDemoTrackIndex(data.index);
  // See handleDemoEnterMessage: this uses the same dropped-while-loading queue.
  if (getState('demo.loading')) _queuedDemoEnterIndex = index === _demoTrackIndex ? null : index;
  stopDemoPlaybackForIncomingTrack(index);
  _demoPlaybackIntent = {
    kind: 'play',
    connection: conn,
    room: captureDemoRoomIdentity(),
    index,
    time: Math.max(0, Number(data.time) || 0),
    hostPlayAt: Number(data.hostPlayAt) || 0,
    ...(typeof data.hostStartAt === 'number' ? { hostStartAt: data.hostStartAt } : {}),
    receivedAt: Date.now(),
  };

  if (!getState('demo.active') || _demoTrackIndex !== index || !getCurrentAudioBuffer()) {
    void enterDemoMode({ index, autoplay: false, broadcastEntry: false }).catch((error: unknown) =>
      log.warn('[Demo] Guest demo play-enter failed:', error),
    );
    return;
  }
  applyPendingDemoPlayback();
}

function handleDemoPauseMessage(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!conn || !isTrustedDemoHostMessage(conn)) return;
  setLocalFilePaused(false);
  const time = Math.max(0, Number(data.time) || 0);
  if (!getState('demo.active')) return;
  _demoPlaybackIntent = {
    kind: 'pause',
    index: _queuedDemoEnterIndex ?? _demoTrackIndex,
    time,
    connection: conn,
    room: captureDemoRoomIdentity(),
  };
  // Stop an already scheduled source immediately; decode completion reapplies
  // the same latest position after loadDemoFile's position reset.
  pause(time, { showToast: false });
  applyPendingDemoPlayback();
}

function handleDemoExitMessage(_data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isTrustedDemoHostMessage(conn)) return;
  exitDemoMode({ broadcastExit: false });
}

function bindDemoDom(): void {
  if (document.body.dataset.demoBound === '1') return;
  document.body.dataset.demoBound = '1';

  document.querySelectorAll<HTMLElement>('[data-demo-role]').forEach((btn) => {
    btn.addEventListener('click', () => bus.emit('demo:set-role', Number(btn.dataset.demoRole)));
  });
  document
    .querySelectorAll<HTMLElement>('[data-role-diagram="demo"] .graphic-speaker[data-role-mode]')
    .forEach((el) => {
      el.addEventListener('click', () => bus.emit('demo:set-role', Number(el.dataset.roleMode)));
    });
  document.querySelectorAll<HTMLElement>('[data-demo-effect="reverb"]').forEach((btn) => {
    btn.addEventListener('click', () => bus.emit('demo:toggle-reverb'));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-effect="bass"]').forEach((btn) => {
    btn.addEventListener('click', () => bus.emit('demo:toggle-bass'));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-effect="treble"]').forEach((btn) => {
    btn.addEventListener('click', () => bus.emit('demo:toggle-treble'));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-effect="surround"]').forEach((btn) => {
    btn.addEventListener('click', () => bus.emit('demo:toggle-surround'));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-info]').forEach((btn) => {
    btn.addEventListener('click', () => bus.emit('demo:open-info'));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-exit]').forEach((btn) => {
    btn.addEventListener('click', () => bus.emit('demo:request-exit'));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-play]').forEach((btn) => {
    btn.addEventListener('click', () => bus.emit('demo:toggle-play'));
  });
  document.querySelectorAll<HTMLElement>('[data-demo-next]').forEach((btn) => {
    btn.addEventListener('click', () => advanceDemoStep());
  });
  document.querySelectorAll<HTMLElement>('[data-demo-step]').forEach((btn) => {
    btn.addEventListener('click', () => syncDemoStep(Number(btn.dataset.demoStep), true));
  });
}

function maybeShowFirstRunPrompt(): void {
  if (_promptInFlight || !shouldShowFirstRunDemoPrompt()) return;
  _promptInFlight = true;
  showDialog({
    title: t('demo.prompt_title'),
    message: t('demo.prompt_message'),
    buttonText: t('demo.prompt_cta'),
    secondaryText: t('demo.prompt_later'),
    defaultFocus: 'primary',
  })
    .then((result) => {
      markDemoPromptSeen();
      if (result.action === 'ok') {
        bus.emit('demo:enter');
      } else {
        showToast(t('demo.try_later_toast'));
      }
    })
    .catch((error) => log.warn('[Demo] Prompt failed:', error))
    .finally(() => {
      _promptInFlight = false;
    });
}

export function reconcileDemoFirstRunPrompt(): void {
  if (!getState('setup.sessionStarted') || getState('network.appRole') !== 'host') return;
  clearManagedTimer('demo-first-run-prompt');
  setManagedTimer('demo-first-run-prompt', maybeShowFirstRunPrompt, 700);
}

function handleRequestDemoEnterMessage(
  _data: Record<string, unknown>,
  conn?: DataConnection,
): void {
  if (!isDemoHost() || !conn) return;
  if (!verifyPeerCapability(conn, 'room.configure')) return;
  bus.emit('demo:enter');
}

function handleRequestDemoExitMessage(_data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isDemoHost() || !conn) return;
  if (!verifyPeerCapability(conn, 'room.configure')) return;
  bus.emit('demo:request-exit');
}

export function handleDemoProtocolMessage(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
  switch (data.type) {
    case MSG.DEMO_ENTER:
      handleDemoEnterMessage(data, conn);
      return;
    case MSG.DEMO_PLAY:
      handleDemoPlayMessage(data, conn);
      return;
    case MSG.DEMO_PAUSE:
      handleDemoPauseMessage(data, conn);
      return;
    case MSG.DEMO_EXIT:
      handleDemoExitMessage(data, conn);
      return;
    case MSG.REQUEST_DEMO_ENTER:
      handleRequestDemoEnterMessage(data, conn);
      return;
    case MSG.REQUEST_DEMO_EXIT:
      handleRequestDemoExitMessage(data, conn);
      return;
  }
}

export function initDemoMode(
  options: { protocolHandlersRegistered?: boolean; suppressFirstRunPrompt?: boolean } = {},
): void {
  _busScope.dispose();
  bindDemoDom();
  if (!options.protocolHandlersRegistered) {
    registerHandlers({
      [MSG.DEMO_ENTER]: handleDemoEnterMessage,
      [MSG.DEMO_PLAY]: handleDemoPlayMessage,
      [MSG.DEMO_PAUSE]: handleDemoPauseMessage,
      [MSG.DEMO_EXIT]: handleDemoExitMessage,
      [MSG.REQUEST_DEMO_ENTER]: handleRequestDemoEnterMessage,
      [MSG.REQUEST_DEMO_EXIT]: handleRequestDemoExitMessage,
    });
  }
  _suppressFirstRunPrompt = options.suppressFirstRunPrompt ?? hasAppUseRecord();

  _busScope.on('demo:enter', () => {
    if (isProRoomDemoBlocked()) return;
    if (!isDemoHost()) {
      const hostConn = getState('network.hostConn');
      if (hasRoomCapability('room.configure') && hostConn?.open) {
        safeSend(hostConn, { type: MSG.REQUEST_DEMO_ENTER });
        return;
      }
      showToast(t('demo.host_only_exit'));
      return;
    }
    observeDemoOperation(
      enterDemoMode({ index: 0, autoplay: false, broadcastEntry: true }).then((result) => {
        if (!isCurrentDemoResult(result)) return;
        startDemoPlayback(0);
      }),
      'entry',
    );
  });
  _busScope.on('demo:authority-reset', () => {
    exitDemoMode({ broadcastExit: false, restoreSnapshot: false });
  });
  _busScope.on('demo:request-exit', () => requestDemoExit());
  _busScope.on('demo:open-info', () => openDemoInfo());
  _busScope.on('demo:toggle-play', () => toggleDemoPlay());
  _busScope.on('demo:next-track', advanceDemoTrack);
  _busScope.on('demo:set-role', (mode) => setDemoRole(mode));
  _busScope.on('demo:toggle-reverb', () => toggleDemoReverb());
  _busScope.on('demo:toggle-bass', () => toggleDemoBass());
  _busScope.on('demo:toggle-treble', () => toggleDemoTreble());
  _busScope.on('demo:toggle-surround', () => toggleDemoSurround());
  _busScope.on('state:audio.channelMode', () => syncRoleButtons());
  _busScope.on('state:demo.reverbOn', () => syncEffectButtons());
  _busScope.on('state:demo.bassBoostOn', () => syncEffectButtons());
  _busScope.on('state:demo.trebleBoostOn', () => syncEffectButtons());
  _busScope.on('state:demo.surroundOn', () => syncEffectButtons());
  _busScope.on('state:demo.loading', () => syncPlayButton());
  _busScope.on('state:audio.reverbMix', () => scheduleDemoEffectStateSync());
  _busScope.on('state:audio.virtualBass', () => scheduleDemoEffectStateSync());
  _busScope.on('state:audio.exciter', () => scheduleDemoEffectStateSync());
  _busScope.on('state:audio.eqValues', () => scheduleDemoEffectStateSync());
  _busScope.on('state:audio.stereoWidth', () => scheduleDemoEffectStateSync());
  _busScope.on('state:playback.activity', () => syncPlayButton());
  _busScope.on('ui:play-loading-state', () => syncPlayButton());
  _busScope.on('player:ended', () => {
    if (!getState('demo.active')) return;
    setState('player.pausedAt', 0);
    syncPlayButton();
    advanceDemoTrack();
  });
  _busScope.on('i18n:changed', () => {
    syncDemoTrackText();
    syncDemoStep();
    syncDemoSessionCopy();
  });
  _busScope.on('network:device-list-update', () => syncDemoSessionCopy());
  _busScope.on('network:peer-connected', (conn) => sendDemoBootstrap(conn as DataConnection));
  // HOT path: the host rewrites connectedPeers on every guest SYNC_PING
  // (1/s per guest) — without the demo.active gate this regenerated the
  // hidden demo panel's QR + DOM continuously for the whole session.
  // Demo entry itself calls syncDemoSessionCopy via setDemoDomActive.
  _busScope.on('state:network.connectedPeers', () => {
    if (getState('demo.active')) syncDemoSessionCopy();
  });
  _busScope.on('state:network.sessionCode', () => syncDemoSessionCopy());
  _busScope.on('state:network.lastJoinCode', () => syncDemoSessionCopy());
  // Guest-side: when the host drops mid-demo, exit so the overlay / body
  // classes / audio settings / REQUEST_SETTING fanout don't stay stuck.
  // Broadcast=false since there's no host to receive a DEMO_EXIT anyway.
  // Host's own demo path is unaffected — host has no hostConn so this
  // listener only fires for guests on hostConn null transition.
  _busScope.on('state:network.hostConn', (hc) => {
    if (!hc && getState('demo.active')) {
      exitDemoMode({ broadcastExit: false, restoreAudioSettings: true });
    }
  });
  _busScope.on('state:network.appRole', (role) => {
    if (role === 'guest') _suppressFirstRunPrompt = true;
  });
  _busScope.on('state:room.context', enforceDemoRoomBoundary);
  _busScope.on('state:network.sessionCode', enforceDemoRoomBoundary);
  _busScope.on('state:setup.sessionStarted', (started) => {
    if (started) reconcileDemoFirstRunPrompt();
  });

  try {
    enforceDemoRoomBoundary();
    const mql = window.matchMedia(MOBILE_QUERY);
    mql.addEventListener('change', () => {
      if (getState('demo.active')) setDemoDomActive(true);
    });
  } catch {
    window.addEventListener('resize', () => {
      if (getState('demo.active')) setDemoDomActive(true);
    });
  }

  clearManagedTimer('demo-first-run-prompt');
}
