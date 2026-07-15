import { log } from '../core/log.ts';
import { batchSetState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { resetRoomContext, setRoomContext } from '../rooms/authority.ts';
import type { RoomContext } from '../types/index.ts';
import {
  ProRoomApiClient,
  type ActivateProRoomInput,
  type CreateProRoomSessionInput,
  type ProRoomBootstrap,
} from './api.ts';
import type { ProRoomSnapshot } from './contracts.ts';
import { registerProRoomLeaveHandler } from './lifecycle-hook.ts';
import { LegacyProRoomNetworkBridge } from './network-bridge.ts';
import { ProRoomSessionController, type ProRoomSessionObserver } from './session-controller.ts';

const HEARTBEAT_INTERVAL_MS = 15_000;
const SIGNALING_REFRESH_INTERVAL_MS = 45_000;
const HEARTBEAT_TIMER = 'pro-room-heartbeat';
const SIGNALING_REFRESH_TIMER = 'pro-room-signaling-refresh';

type SnapshotListener = (snapshot: ProRoomSnapshot | null) => void;

const api = new ProRoomApiClient();
const bridge = new LegacyProRoomNetworkBridge();
const listeners = new Set<SnapshotListener>();
let active = false;
let heartbeatInFlight = false;
let refreshInFlight = false;
let visibilityBound = false;

function notifySnapshot(snapshot: ProRoomSnapshot | null): void {
  for (const listener of [...listeners]) {
    try {
      listener(snapshot);
    } catch (error) {
      log.warn('[PRO] Snapshot observer failed', error);
    }
  }
}

function applyAuthority(context: RoomContext): void {
  setRoomContext(context);
  batchSetState({
    'network.sessionCode': context.roomId ?? '',
    'network.lastJoinCode': context.roomId ?? '',
    // Compatibility flag for legacy controls. Real authorization remains the
    // server-projected capability set in room.context.
    'network.isOperator': context.role === 'member',
  });
}

function stopLifecycle(): void {
  active = false;
  heartbeatInFlight = false;
  refreshInFlight = false;
  clearManagedTimer(HEARTBEAT_TIMER);
  clearManagedTimer(SIGNALING_REFRESH_TIMER);
}

const observer: ProRoomSessionObserver = {
  snapshot(snapshot) {
    notifySnapshot(snapshot);
  },
  authority(context) {
    applyAuthority(context);
  },
  cleared() {
    stopLifecycle();
    resetRoomContext();
    notifySnapshot(null);
  },
};

const controller = new ProRoomSessionController(api, bridge, observer);

async function runHeartbeat(): Promise<void> {
  if (!active || heartbeatInFlight) return;
  heartbeatInFlight = true;
  try {
    await controller.heartbeat();
  } catch (error) {
    // Presence is eventually reconciled by the DO TTL. A transient heartbeat
    // failure must not tear down healthy P2P media.
    log.warn('[PRO] Presence heartbeat failed', error);
  } finally {
    heartbeatInFlight = false;
    if (active) setManagedTimer(HEARTBEAT_TIMER, () => void runHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }
}

async function refreshSignalingCredential(): Promise<void> {
  if (!active || refreshInFlight) return;
  refreshInFlight = true;
  try {
    await controller.refreshSignaling();
  } catch (error) {
    // Existing data channels remain valid without signaling. Retry soon so a
    // later coordinator failover or new member can still connect.
    log.warn('[PRO] Signaling credential refresh failed', error);
  } finally {
    refreshInFlight = false;
    if (active) {
      setManagedTimer(
        SIGNALING_REFRESH_TIMER,
        () => void refreshSignalingCredential(),
        SIGNALING_REFRESH_INTERVAL_MS,
      );
    }
  }
}

function bindVisibilityRefresh(): void {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (!active || document.visibilityState !== 'visible') return;
    clearManagedTimer(HEARTBEAT_TIMER);
    clearManagedTimer(SIGNALING_REFRESH_TIMER);
    void runHeartbeat();
    void refreshSignalingCredential();
  });
}

function startLifecycle(): void {
  active = true;
  bindVisibilityRefresh();
  clearManagedTimer(HEARTBEAT_TIMER);
  clearManagedTimer(SIGNALING_REFRESH_TIMER);
  setManagedTimer(HEARTBEAT_TIMER, () => void runHeartbeat(), HEARTBEAT_INTERVAL_MS);
  setManagedTimer(
    SIGNALING_REFRESH_TIMER,
    () => void refreshSignalingCredential(),
    SIGNALING_REFRESH_INTERVAL_MS,
  );
}

export function getProRoomBootstrap(code: string, signal?: AbortSignal): Promise<ProRoomBootstrap> {
  return api.getBootstrap(code, signal);
}

export async function resumeProRoom(code: string, signal?: AbortSignal): Promise<ProRoomSnapshot> {
  const snapshot = await controller.resume(code, signal);
  startLifecycle();
  return snapshot;
}

export async function joinProRoom(
  input: CreateProRoomSessionInput,
  signal?: AbortSignal,
): Promise<ProRoomSnapshot> {
  const snapshot = await controller.join(input, signal);
  startLifecycle();
  return snapshot;
}

export async function activateProRoom(
  input: ActivateProRoomInput,
  signal?: AbortSignal,
): Promise<ProRoomSnapshot> {
  const snapshot = await controller.activate(input, signal);
  startLifecycle();
  return snapshot;
}

export function changeActiveProRoomPin(pin: string, signal?: AbortSignal): Promise<void> {
  const code = controller.snapshot?.roomCode;
  if (!code) return Promise.reject(new Error('PRO_ROOM_SESSION_INACTIVE'));
  return api.changePin(code, pin, signal);
}

export async function leaveActiveProRoom(signal?: AbortSignal): Promise<void> {
  // `leave()` also supersedes an authentication/transport open that has not
  // published a snapshot yet. Skipping it when snapshot is null can let a
  // cancelled setup request finish later and silently re-enter the room.
  await controller.leave(signal);
}

export function getActiveProRoomSnapshot(): ProRoomSnapshot | null {
  return controller.snapshot;
}

export function subscribeProRoomSnapshot(listener: SnapshotListener): () => void {
  listeners.add(listener);
  listener(controller.snapshot);
  return () => listeners.delete(listener);
}

export function getProRoomApiClient(): ProRoomApiClient {
  return api;
}

export function getProRoomSessionController(): ProRoomSessionController {
  return controller;
}

registerProRoomLeaveHandler(() => leaveActiveProRoom());
