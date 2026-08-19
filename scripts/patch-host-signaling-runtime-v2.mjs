import { readFileSync, writeFileSync } from 'node:fs';

function read(path) {
  return readFileSync(path, 'utf8');
}

function write(path, content) {
  writeFileSync(path, content, 'utf8');
}

function replaceOnce(path, before, after, label = before.slice(0, 100)) {
  const source = read(path);
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${path}: expected one ${label} anchor, found ${count}`);
  }
  write(path, source.replace(before, after));
}

function replaceRegexOnce(path, pattern, replacement, label) {
  const source = read(path);
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`${path}: expected one ${label} match, found ${matches.length}`);
  }
  write(path, source.replace(pattern, replacement));
}

const signalingPath = 'src/network/transport/cloudflare-signaling.ts';
let signaling = read(signalingPath);
signaling = signaling.replace(
  'this.retireSignalingSocket(socket, true);',
  'this.retireHostSignalingSocket(socket, true);',
);

const guestRetireStart = signaling.indexOf('  private retireGuestSignalingSocket(');
const reconnectStart = signaling.indexOf('  reconnect(): void {', guestRetireStart);
if (guestRetireStart < 0 || reconnectStart < 0) {
  throw new Error(`${signalingPath}: generated guest retirement block not found`);
}
const hostOnlyUnavailable = `  markSignalingUnavailable(): boolean {
    if (this.destroyed || this.proSignalingAccess || !this.hostRoomId) return false;
    const socket = this.hostSocket;
    return socket ? this.retireHostSignalingSocket(socket, true) : false;
  }

`;
signaling = signaling.slice(0, guestRetireStart) + hostOnlyUnavailable + signaling.slice(reconnectStart);

signaling = signaling.replace(
  "    socket.addEventListener('message', (event) => {\n      if (this.signalingLiveness.noteMessage(socket, event.data)) return;\n      this.handleGuestMessage(roomId, socket, conn, metadata, event.data).catch((error) =>\n",
  "    socket.addEventListener('message', (event) => {\n      this.handleGuestMessage(roomId, socket, conn, metadata, event.data).catch((error) =>\n",
);

const generatedGuestClose = `    socket.addEventListener('close', (event) => {
      if (this.destroyed) {
        this.signalingLiveness.stop(socket);
        return;
      }
      if ((event as CloseEvent).reason === 'PRO_COORDINATOR_EPOCH_ADVANCED') {
        this.signalingLiveness.stop(socket);
        if (this.roomSockets.get(roomId) === socket) this.roomSockets.delete(roomId);
        this.handleProEpochAdvanced();
        return;
      }
      this.retireGuestSignalingSocket(roomId, socket, conn, false);
    });
`;
const originalGuestClose = `    socket.addEventListener('close', (event) => {
      if (this.destroyed) return;
      if ((event as CloseEvent).reason === 'PRO_COORDINATOR_EPOCH_ADVANCED') {
        if (this.roomSockets.get(roomId) === socket) this.roomSockets.delete(roomId);
        this.handleProEpochAdvanced();
        return;
      }
      if (this.roomSockets.get(roomId) === socket) {
        this.roomSockets.delete(roomId);
        if (conn.peerConnection) {
          const wasDisconnected = this.disconnected;
          this.disconnected = true;
          this.reconcileGuestBackgroundRecovery(roomId, true);
          if (!wasDisconnected) this.emit('disconnected');
        }
      }
    });
`;
if (!signaling.includes(generatedGuestClose)) {
  throw new Error(`${signalingPath}: generated guest close handler not found`);
}
signaling = signaling.replace(generatedGuestClose, originalGuestClose);

signaling = signaling.replace(
  `    if (message.type === 'peer-open') {
      if (message.signalingLivenessVersion === SIGNALING_LIVENESS_VERSION) {
        this.signalingLiveness.start(socket);
      }
      // Only the Worker's peer-open proves that guest-auth won admission for
`,
  `    if (message.type === 'peer-open') {
      // Only the Worker's peer-open proves that guest-auth won admission for
`,
);

signaling = signaling.replace(
  `    if (message.type === 'peer-open') {
      if (sourceSocket && message.signalingLivenessVersion === SIGNALING_LIVENESS_VERSION) {
        this.signalingLiveness.start(sourceSocket);
      }
      if (message.remoteShareUploadAssertionVersion === 1) {
`,
  `    if (message.type === 'peer-open') {
      if (
        !this.proSignalingAccess &&
        sourceSocket &&
        message.signalingLivenessVersion === SIGNALING_LIVENESS_VERSION
      ) {
        this.signalingLiveness.start(sourceSocket);
      }
      if (message.remoteShareUploadAssertionVersion === 1) {
`,
);

if (signaling.includes('retireGuestSignalingSocket') || signaling.includes('retireSignalingSocket')) {
  throw new Error(`${signalingPath}: guest-wide liveness retirement remained`);
}
write(signalingPath, signaling);

const peerPath = 'src/network/peer.ts';
let peer = read(peerPath);
peer = peer.replace(
  `import {
  requestProRoomTransportRecovery,
  restartProRoomTransportRecovery,
} from '../pro-room/transport-recovery.ts';`,
  `import { requestProRoomTransportRecovery } from '../pro-room/transport-recovery.ts';`,
);
peer = peer.replace(
  `import { getRoomContext } from '../rooms/authority.ts';`,
  `import {
  getRoomContext,
  isActiveStandardRoomCoordinator,
} from '../rooms/authority.ts';`,
);
write(peerPath, peer);
replaceRegexOnce(
  peerPath,
  /const RECONNECT_BACKOFF_MS = \[1000, 2000, 4000, 8000, 15000\];\nlet _browserConnectivityRecoveryBound = false;[\s\S]*?\nasync function performScheduledPeerReconnect/,
  `const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
let _browserConnectivityRecoveryBound = false;

function isRecoverableStandardHost(): boolean {
  return isActiveStandardRoomCoordinator();
}

function bindBrowserConnectivityRecovery(): void {
  if (_browserConnectivityRecoveryBound || typeof window === 'undefined') return;
  _browserConnectivityRecoveryBound = true;

  window.addEventListener('offline', () => {
    if (!isRecoverableStandardHost()) return;
    const peer = getPeer();
    if (!peer || peer.destroyed) return;
    if (peer.markSignalingUnavailable?.()) {
      log.warn('[Transport] Browser reported offline; host signaling recovery started');
    }
  });

  window.addEventListener('online', () => {
    if (!isRecoverableStandardHost()) return;
    const peer = getPeer();
    if (!peer || peer.destroyed) return;
    const health = getState('network.signalingHealth').status;
    if (!peer.disconnected && health !== 'exhausted') return;

    clearManagedTimer('peer-signaling-reconnect');
    retryPeerSignalingConnection();
  });
}

async function performScheduledPeerReconnect`,
  'host-only browser connectivity recovery',
);
peer = read(peerPath);
if (peer.includes('restartProRoomTransportRecovery')) {
  throw new Error(`${peerPath}: PRO connectivity recovery import remained`);
}
write(peerPath, peer);

const workerPath = 'cloudflare/signaling-worker.ts';
let worker = read(workerPath);
worker = worker.replace('const HOST_RECLAIM_GRACE_MS = 60_000;', 'const HOST_RECLAIM_GRACE_MS = 120_000;');
worker = worker.replace(
  `function workerVersionFields(env: SignalingEnvPort): {
  workerVersionId?: string;
  signalingLivenessVersion: typeof SIGNALING_LIVENESS_VERSION;
} {
  const metadata = env.CF_VERSION_METADATA;
  const workerVersionId = isRecord(metadata) ? metadata.id : undefined;
  return {
    signalingLivenessVersion: SIGNALING_LIVENESS_VERSION,
    ...(typeof workerVersionId === 'string' && workerVersionId ? { workerVersionId } : {}),
  };
}
`,
  `function workerVersionFields(env: SignalingEnvPort): {
  workerVersionId?: string;
  signalingLivenessVersion?: typeof SIGNALING_LIVENESS_VERSION;
} {
  const metadata = env.CF_VERSION_METADATA;
  const workerVersionId = isRecord(metadata) ? metadata.id : undefined;
  return typeof workerVersionId === 'string' && workerVersionId
    ? { workerVersionId, signalingLivenessVersion: SIGNALING_LIVENESS_VERSION }
    : {};
}
`,
);
if (!worker.includes('const HOST_RECLAIM_GRACE_MS = 120_000;')) {
  throw new Error(`${workerPath}: host reclaim grace was not extended`);
}
write(workerPath, worker);

console.log('Patched host-only signaling runtime and reclaim grace.');
