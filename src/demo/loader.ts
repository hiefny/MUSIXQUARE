/** Lightweight app-shell bridge for the interaction-only demo runtime. */

import { bus, createBusScope } from '../core/events.ts';
import { MSG } from '../core/constants.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import { registerHandlers } from '../network/protocol.ts';
import {
  getRoomContext,
  isCoordinator,
  subscribeRoomAuthorityLifecycle,
  verifyPeerCapability,
} from '../rooms/authority.ts';
import type { DataConnection } from '../types/index.ts';
import { hasAppUseRecord } from './storage.ts';

type DemoRuntime = typeof import('./mode.ts');

const scope = createBusScope();
let runtime: DemoRuntime | null = null;
let runtimeLoad: Promise<DemoRuntime> | null = null;
let suppressFirstRunPromptOnRuntimeInit = false;
const RETRY_DELAYS_MS = [500, 1_500, 3_000] as const;
const RETRY_TIMER = 'demo-runtime-retry';
type DeferredIntent =
  | { kind: 'local' }
  | { kind: 'request'; conn: DataConnection; message: Record<string, unknown> }
  | {
      kind: 'remote';
      conn: DataConnection;
      entry: Record<string, unknown> | null;
      control: Record<string, unknown> | null;
    };
type PendingWork = {
  isCurrentRoom: () => boolean;
  intent: DeferredIntent;
  failures: number;
};
let pending: PendingWork | null = null;
let intentRevision = 0;
let processing: Promise<void> | null = null;
let unsubscribeAuthority: (() => void) | null = null;

function captureRoom(): () => boolean {
  const room = getRoomContext();
  const sessionCode = getState('network.sessionCode');
  const hostConnection = getState('network.hostConn');
  const coordinator = isCoordinator();
  return () => {
    const current = getRoomContext();
    return (
      current.kind === room.kind &&
      current.roomId === room.roomId &&
      current.epoch === room.epoch &&
      isCoordinator() === coordinator &&
      getState('network.sessionCode') === sessionCode &&
      getState('network.hostConn') === hostConnection
    );
  };
}

function isCurrent(work: PendingWork): boolean {
  if (pending !== work || !work.isCurrentRoom()) return false;
  const intent = work.intent;
  if (intent.kind === 'local') return true;
  if (intent.kind === 'request') return verifyPeerCapability(intent.conn, 'room.configure');
  return intent.conn.open && getState('network.hostConn') === intent.conn;
}

function cancelPending(): void {
  pending = null;
  intentRevision++;
  clearManagedTimer(RETRY_TIMER);
}

function drainPending(loaded: DemoRuntime): void {
  const work = pending;
  if (!work) return;
  if (!isCurrent(work)) {
    cancelPending();
    return;
  }
  const intent = work.intent;
  cancelPending();
  const revision = intentRevision;
  if (intent.kind === 'local') bus.emit('demo:enter');
  else if (intent.kind === 'request') loaded.handleDemoProtocolMessage(intent.message, intent.conn);
  else {
    if (intent.entry) loaded.handleDemoProtocolMessage(intent.entry, intent.conn);
    if (intent.control && revision === intentRevision && work.isCurrentRoom())
      loaded.handleDemoProtocolMessage(intent.control, intent.conn);
  }
}

function processPending(): Promise<void> {
  if (processing) return processing;
  // New snapshots replace the mailbox without accelerating an in-flight
  // retry budget. A missing chunk must not become a frame-driven retry loop.
  if (getManagedTimer(RETRY_TIMER)) return Promise.resolve();
  processing = loadRuntime(false).then(
    (loaded) => {
      processing = null;
      drainPending(loaded);
    },
    (error: unknown) => {
      processing = null;
      const work = pending;
      if (!work || !isCurrent(work)) {
        cancelPending();
        return;
      }
      log.warn('[Demo] Runtime failed to load:', error);
      const retryDelay = RETRY_DELAYS_MS[work.failures++];
      if (retryDelay !== undefined) {
        setManagedTimer(
          RETRY_TIMER,
          () => {
            if (isCurrent(work)) return processPending();
            else cancelPending();
          },
          retryDelay,
        );
      } else {
        cancelPending();
        bus.emit('ui:show-toast', t('transfer.demo_load_fail'));
      }
    },
  );
  return processing;
}

function loadRuntime(reconcileStartedSession: boolean): Promise<DemoRuntime> {
  runtimeLoad ??= import('./mode.ts')
    .then((loaded) => {
      loaded.initDemoMode({
        protocolHandlersRegistered: true,
        suppressFirstRunPrompt: suppressFirstRunPromptOnRuntimeInit,
      });
      runtime = loaded;
      return loaded;
    })
    .catch((error: unknown) => {
      runtime = null;
      runtimeLoad = null;
      throw error;
    });
  return runtimeLoad.then((loaded) => {
    if (reconcileStartedSession) loaded.reconcileDemoFirstRunPrompt();
    return loaded;
  });
}

function forwardDemoProtocolMessage(
  data: Record<string, unknown>,
  conn: DataConnection,
): Promise<void> {
  if (getRoomContext().kind !== 'standard') return Promise.resolve();
  const request = data.type === MSG.REQUEST_DEMO_ENTER || data.type === MSG.REQUEST_DEMO_EXIT;
  if (
    request
      ? !verifyPeerCapability(conn, 'room.configure')
      : isCoordinator() || !conn.open || getState('network.hostConn') !== conn
  )
    return Promise.resolve();
  // EXIT retires the deferred entry before it can acquire a newer media owner.
  // A cold runtime has no demo playback to tear down.
  if (data.type === MSG.DEMO_EXIT) {
    cancelPending();
    runtime?.handleDemoProtocolMessage(data, conn);
    return Promise.resolve();
  }
  if (runtime && !pending) {
    intentRevision++;
    runtime.handleDemoProtocolMessage(data, conn);
    return Promise.resolve();
  }
  if (!pending || !isCurrent(pending)) {
    pending = { isCurrentRoom: captureRoom(), failures: 0, intent: { kind: 'local' } };
  }
  if (request) pending.intent = { kind: 'request', conn, message: data };
  else {
    const intent =
      pending.intent.kind === 'remote' && pending.intent.conn === conn
        ? pending.intent
        : { kind: 'remote' as const, conn, entry: null, control: null };
    if (data.type === MSG.DEMO_ENTER) {
      const previousIndex = intent.entry?.index ?? intent.control?.index;
      if (previousIndex !== data.index) intent.control = null;
      intent.entry = data;
    } else {
      if (data.type === MSG.DEMO_PLAY && intent.entry && intent.entry.index !== data.index)
        intent.entry = { ...intent.entry, index: data.index };
      intent.control = data;
    }
    pending.intent = intent;
  }
  if (runtime) {
    drainPending(runtime);
    return Promise.resolve();
  }
  return processPending();
}

export function initDemoModeLoader(): void {
  scope.dispose();
  unsubscribeAuthority?.();
  cancelPending();
  // Preserve the original eager initialization boundary. The Start gesture
  // records app use before sessionStarted, so reading this after the chunk
  // arrives would incorrectly suppress every new host's first-run prompt.
  suppressFirstRunPromptOnRuntimeInit = hasAppUseRecord();
  // Protocol registration must stay eager. A host sends the active-demo
  // bootstrap as soon as a peer joins, before the guest's session-start event
  // can fetch this runtime. The tiny forwarding handlers keep those frames
  // alive without pulling the demo implementation into the app shell.
  registerHandlers({
    [MSG.DEMO_ENTER]: forwardDemoProtocolMessage,
    [MSG.DEMO_PLAY]: forwardDemoProtocolMessage,
    [MSG.DEMO_PAUSE]: forwardDemoProtocolMessage,
    [MSG.DEMO_EXIT]: forwardDemoProtocolMessage,
    [MSG.REQUEST_DEMO_ENTER]: forwardDemoProtocolMessage,
    [MSG.REQUEST_DEMO_EXIT]: forwardDemoProtocolMessage,
  });
  scope.on('demo:enter', () => {
    if (runtime) {
      cancelPending();
      return;
    }
    if (!pending || !isCurrent(pending)) {
      pending = { isCurrentRoom: captureRoom(), failures: 0, intent: { kind: 'local' } };
    }
    pending.intent = { kind: 'local' };
    return processPending();
  });
  scope.on('demo:request-exit', cancelPending);
  scope.on('demo:authority-reset', cancelPending);
  unsubscribeAuthority = subscribeRoomAuthorityLifecycle(() => {
    if (pending && !isCurrent(pending)) cancelPending();
  });
  scope.on('state:setup.sessionStarted', (started) => {
    if (!started) {
      cancelPending();
      return;
    }
    if (runtime) return;
    void loadRuntime(true).catch((error) =>
      log.warn('[Demo] Session runtime failed to load:', error),
    );
  });

  if (getState('setup.sessionStarted') && !runtime) {
    void loadRuntime(true).catch((error) =>
      log.warn('[Demo] Restored-session runtime failed to load:', error),
    );
  }
}
