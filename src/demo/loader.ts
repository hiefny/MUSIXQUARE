/** Lightweight app-shell bridge for the interaction-only demo runtime. */

import { bus, createBusScope } from '../core/events.ts';
import { MSG } from '../core/constants.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { registerHandlers } from '../network/protocol.ts';
import type { DataConnection } from '../types/index.ts';
import { hasAppUseRecord } from './storage.ts';

type DemoRuntime = typeof import('./mode.ts');

const scope = createBusScope();
let runtime: DemoRuntime | null = null;
let runtimeLoad: Promise<DemoRuntime> | null = null;
let pendingEnter = false;
let suppressFirstRunPromptOnRuntimeInit = false;

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
  // Every early frame awaits the same import promise. Promise reactions retain
  // registration order, so an initial ENTER -> PLAY bootstrap cannot overtake
  // itself while the interaction chunk is still loading.
  return loadRuntime(false).then((loaded) => loaded.handleDemoProtocolMessage(data, conn));
}

export function initDemoModeLoader(): void {
  scope.dispose();
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
  });
  scope.on('demo:enter', () => {
    if (runtime) return;
    pendingEnter = true;
    void loadRuntime(false)
      .then(() => {
        if (!pendingEnter) return;
        pendingEnter = false;
        bus.emit('demo:enter');
      })
      .catch((error) => log.warn('[Demo] Runtime failed to load:', error));
  });
  scope.on('state:setup.sessionStarted', (started) => {
    if (!started || runtime) return;
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
