#!/usr/bin/env node
/**
 * Static ratchet for the room-authority compatibility boundary.
 *
 * `network.appRole` and `network.isOperator` are legacy standard-room state.
 * PRO projects values into those fields only so the shared transport/media
 * runtime keeps working; they must never become PRO authority. New authority
 * decisions must use `getRoomContext()`, `isCoordinator()`, or
 * `hasRoomCapability()` from src/rooms/authority.ts.
 *
 * The manifest below freezes every existing production read, state-event
 * subscription, and write. Counts are exact on purpose: when compatibility
 * debt is removed, lower the matching count in the same change; never raise a
 * count without an explicit authority-boundary review.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type LegacyField = 'appRole' | 'isOperator';

interface ReadAllowance {
  readonly appRole: number;
  readonly isOperator: number;
  readonly reason: 'canonical-authority-adapter' | 'standard-fenced' | 'compatibility-consumer';
}

interface EventAllowance {
  readonly appRole: number;
  readonly isOperator: number;
}

interface WriteAllowance {
  readonly appRoleDirect: number;
  readonly isOperatorDirect: number;
  readonly appRoleObject: number;
  readonly isOperatorObject: number;
}

type LegacyAccessKind = 'read' | 'event' | 'write-direct' | 'write-object';

interface CallsiteAllowance {
  /** Why this file still touches the legacy compatibility projection. */
  readonly reason:
    | ReadAllowance['reason']
    | 'compatibility-event'
    | 'compatibility-projection'
    | 'standard-lifecycle';
  /**
   * Formatting-insensitive, AST-scoped use-site descriptions. These freeze
   * where and how each grandfathered access is used, rather than only its
   * per-file count.
   */
  readonly fingerprints: readonly string[];
}

const READ_ALLOWLIST = new Map<string, ReadAllowance>([
  ['src/app.ts', { appRole: 4, isOperator: 0, reason: 'compatibility-consumer' }],
  ['src/audio/effects.ts', { appRole: 2, isOperator: 3, reason: 'standard-fenced' }],
  ['src/chat/commands.ts', { appRole: 1, isOperator: 0, reason: 'standard-fenced' }],
  ['src/chat/debug-console.ts', { appRole: 0, isOperator: 1, reason: 'compatibility-consumer' }],
  ['src/demo/mode.ts', { appRole: 3, isOperator: 0, reason: 'standard-fenced' }],
  [
    'src/diagnostics/sync-flight-recorder.ts',
    { appRole: 1, isOperator: 0, reason: 'compatibility-consumer' },
  ],
  ['src/network/guest.ts', { appRole: 0, isOperator: 4, reason: 'compatibility-consumer' }],
  ['src/network/host.ts', { appRole: 1, isOperator: 0, reason: 'standard-fenced' }],
  ['src/network/operator-file-uplink.ts', { appRole: 3, isOperator: 0, reason: 'standard-fenced' }],
  ['src/network/orchestrator.ts', { appRole: 1, isOperator: 0, reason: 'compatibility-consumer' }],
  ['src/network/peer.ts', { appRole: 8, isOperator: 0, reason: 'compatibility-consumer' }],
  ['src/network/protocol.ts', { appRole: 1, isOperator: 0, reason: 'compatibility-consumer' }],
  [
    'src/network/queue-mutation-authority.ts',
    { appRole: 2, isOperator: 0, reason: 'standard-fenced' },
  ],
  [
    'src/network/signaling-health.ts',
    { appRole: 2, isOperator: 0, reason: 'compatibility-consumer' },
  ],
  ['src/network/sync.ts', { appRole: 3, isOperator: 0, reason: 'standard-fenced' }],
  [
    'src/network/system-audio-debug.ts',
    { appRole: 1, isOperator: 0, reason: 'compatibility-consumer' },
  ],
  [
    'src/network/system-audio-guest.ts',
    { appRole: 1, isOperator: 0, reason: 'compatibility-consumer' },
  ],
  [
    'src/network/system-audio-host.ts',
    { appRole: 3, isOperator: 0, reason: 'compatibility-consumer' },
  ],
  [
    'src/network/system-audio-sfu.ts',
    { appRole: 11, isOperator: 0, reason: 'compatibility-consumer' },
  ],
  ['src/player/playlist.ts', { appRole: 1, isOperator: 0, reason: 'standard-fenced' }],
  ['src/rooms/authority.ts', { appRole: 4, isOperator: 1, reason: 'canonical-authority-adapter' }],
  ['src/share/remote-share.ts', { appRole: 4, isOperator: 0, reason: 'compatibility-consumer' }],
  ['src/storage/preload.ts', { appRole: 1, isOperator: 0, reason: 'compatibility-consumer' }],
  [
    'src/storage/transfer-receive.ts',
    { appRole: 1, isOperator: 0, reason: 'compatibility-consumer' },
  ],
  ['src/sw-register.ts', { appRole: 1, isOperator: 0, reason: 'compatibility-consumer' }],
  ['src/ui/announcement.ts', { appRole: 1, isOperator: 0, reason: 'compatibility-consumer' }],
  ['src/ui/chat.ts', { appRole: 0, isOperator: 1, reason: 'standard-fenced' }],
  ['src/ui/connect.ts', { appRole: 2, isOperator: 0, reason: 'compatibility-consumer' }],
  ['src/ui/player-controls.ts', { appRole: 4, isOperator: 0, reason: 'compatibility-consumer' }],
  ['src/ui/seekbar.ts', { appRole: 1, isOperator: 0, reason: 'compatibility-consumer' }],
  ['src/ui/setup.ts', { appRole: 1, isOperator: 0, reason: 'compatibility-consumer' }],
  ['src/ui/setup-guest.ts', { appRole: 1, isOperator: 0, reason: 'compatibility-consumer' }],
  ['src/ui/setup-host.ts', { appRole: 2, isOperator: 0, reason: 'compatibility-consumer' }],
  ['src/ui/setup-shared.ts', { appRole: 1, isOperator: 0, reason: 'compatibility-consumer' }],
  ['src/youtube/player.ts', { appRole: 3, isOperator: 0, reason: 'standard-fenced' }],
]);

const EVENT_ALLOWLIST = new Map<string, EventAllowance>([
  ['src/app.ts', { appRole: 2, isOperator: 0 }],
  ['src/audio/effects.ts', { appRole: 0, isOperator: 1 }],
  ['src/audio/system-capture.ts', { appRole: 1, isOperator: 0 }],
  ['src/demo/mode.ts', { appRole: 1, isOperator: 0 }],
  ['src/network/operator-file-uplink.ts', { appRole: 1, isOperator: 1 }],
  ['src/network/queue-mutation-authority.ts', { appRole: 1, isOperator: 1 }],
  ['src/network/sync.ts', { appRole: 1, isOperator: 0 }],
  ['src/ui/announcement.ts', { appRole: 1, isOperator: 0 }],
  ['src/ui/connect.ts', { appRole: 1, isOperator: 0 }],
  ['src/ui/player-controls.ts', { appRole: 2, isOperator: 1 }],
  ['src/ui/playlist-view.ts', { appRole: 1, isOperator: 1 }],
  ['src/ui/seekbar.ts', { appRole: 1, isOperator: 1 }],
  ['src/ui/settings.ts', { appRole: 1, isOperator: 0 }],
  ['src/youtube/player.ts', { appRole: 1, isOperator: 0 }],
]);

const WRITE_ALLOWLIST = new Map<string, WriteAllowance>([
  [
    'src/network/guest.ts',
    { appRoleDirect: 0, isOperatorDirect: 6, appRoleObject: 0, isOperatorObject: 0 },
  ],
  [
    'src/network/peer.ts',
    { appRoleDirect: 0, isOperatorDirect: 0, appRoleObject: 1, isOperatorObject: 1 },
  ],
  [
    'src/pro-room/network-bridge.ts',
    { appRoleDirect: 0, isOperatorDirect: 0, appRoleObject: 2, isOperatorObject: 2 },
  ],
  [
    'src/pro-room/runtime.ts',
    { appRoleDirect: 0, isOperatorDirect: 0, appRoleObject: 0, isOperatorObject: 1 },
  ],
  [
    'src/ui/setup.ts',
    { appRoleDirect: 1, isOperatorDirect: 0, appRoleObject: 0, isOperatorObject: 0 },
  ],
  [
    'src/ui/setup-guest.ts',
    { appRoleDirect: 1, isOperatorDirect: 0, appRoleObject: 0, isOperatorObject: 0 },
  ],
  [
    'src/ui/setup-host.ts',
    { appRoleDirect: 1, isOperatorDirect: 0, appRoleObject: 0, isOperatorObject: 0 },
  ],
]);

// Reviewed AST use-sites for every count above. The normalized snippets omit
// comments and whitespace, but retain the enclosing function/callback and the
// decision expression so moving or repurposing an access requires an explicit
// baseline review.
const CALLSITE_FINGERPRINTS = new Map<string, readonly string[]>([
  [
    'src/app.ts',
    [
      'event:appRole @ callback-call:safeInit("Connect")#1 :: bus.on("state:network.appRole", (role) => { if (role === \'host\' || role === \'guest\') load(); })',
      'event:appRole @ function:initBackButtonGuard :: bus.on("state:network.appRole", controller.handleSessionStateChange)',
      "read:appRole @ callback-call:safeInit(\"Connect\")#1 :: variable role = getState('network.appRole') => consumers [role -> if (role === 'host' || role === 'guest')]",
      "read:appRole @ callback-property:getRole :: concise-return getState('network.appRole')",
      "read:appRole @ callback-property:isSessionActive :: concise-return getState('setup.sessionStarted') && getState('network.appRole') !== 'idle'",
      "read:appRole @ function:hasActiveBackgroundResumeSession :: return (getState('setup.sessionStarted') && getState('network.appRole') !== 'idle' && getState('network.sessionCode').trim().length > 0)",
    ],
  ],
  [
    'src/audio/effects.ts',
    [
      'event:isOperator @ function:registerSettingsSyncBusHandlers :: bus.on("state:network.isOperator", handleSettingsSyncAuthorityProjectionChanged)',
      "read:appRole @ function:canPublishSynchronizedSettings :: if (context.kind === 'standard' && getState('network.appRole') === 'host')",
      "read:appRole @ function:hasRetainedStandardSettingsAuthority :: if (getState('room.context').kind !== 'standard' || getState('network.appRole') !== 'guest' || !getState('network.isOperator'))",
      "read:isOperator @ function:flushPendingStandardSettingsPublish :: if (!hostConn?.open || getState('network.isConnecting') || !getState('network.isOperator') || getState('network.standardRoomCapabilities')?.includes('effects.control') !== true)",
      "read:isOperator @ function:handleSettingsSyncAuthorityProjectionChanged :: if (getState('network.hostConn')?.open && getState('network.isOperator') && capabilities !== null && !capabilities.includes('effects.control'))",
      "read:isOperator @ function:hasRetainedStandardSettingsAuthority :: if (getState('room.context').kind !== 'standard' || getState('network.appRole') !== 'guest' || !getState('network.isOperator'))",
    ],
  ],
  [
    'src/audio/system-capture.ts',
    [
      'event:appRole @ function:registerSystemCaptureListeners :: bus.on("state:network.appRole", stopAfterCoordinatorAuthorityLoss)',
    ],
  ],
  [
    'src/chat/commands.ts',
    [
      "read:appRole @ function:isPhysicalStandardHost :: return (isStandardRoom() && getState('network.appRole') === 'host' && !getState('network.hostConn'))",
    ],
  ],
  [
    'src/chat/debug-console.ts',
    [
      "read:isOperator @ function:cmdDebug :: variable isOp = getState('network.isOperator') ? 'yes' : 'no' => consumers [isOp -> lines.push(`[Network] #${myOrder} ${myLabel} | code:${sessionCode} | conn:${connType} | OP:${isOp}`)]",
    ],
  ],
  [
    'src/demo/mode.ts',
    [
      'event:appRole @ function:initDemoMode :: _busScope.on("state:network.appRole", (role) => { if (role === \'guest\') _suppressFirstRunPrompt = true; })',
      "read:appRole @ callback-call:_busScope.on(\"state:setup.sessionStarted\")#1 :: if (!started || getState('network.appRole') !== 'host')",
      "read:appRole @ function:isDemoHost :: return (!isProRoomDemoBlocked() && !getState('network.hostConn') && getState('network.appRole') === 'host')",
      "read:appRole @ function:shouldShowFirstRunDemoPrompt :: if (getState('network.appRole') !== 'host')",
    ],
  ],
  [
    'src/diagnostics/sync-flight-recorder.ts',
    [
      "read:appRole @ function:captureSyncFlightRecorderSampleForTests :: property role = `${getState('network.appRole')}/${context.role}`",
    ],
  ],
  [
    'src/network/guest.ts',
    [
      "read:isOperator @ function:handleOperatorGrant :: variable wasOperator = getState('network.isOperator') => consumers [wasOperator -> if (!wasOperator && data.silent !== true && !isOwnerProjection)]",
      "read:isOperator @ function:handleOperatorRevoke :: variable wasOperator = getState('network.isOperator') => consumers [wasOperator -> if (wasOperator && data.silent !== true && !wasOwnerProjection)]",
      "read:isOperator @ function:handleOperatorToast :: if (!hostConn || conn !== hostConn || !getState('network.isOperator'))",
      "read:isOperator @ function:handleWelcome :: if (getState('network.isOperator'))",
      "write-direct:isOperator @ function:handleOperatorGrant :: setState('network.isOperator', true)",
      "write-direct:isOperator @ function:handleOperatorGrant :: setState('network.isOperator', true)",
      "write-direct:isOperator @ function:handleOperatorRevoke :: setState('network.isOperator', false)",
      "write-direct:isOperator @ function:handleOperatorRevoke :: setState('network.isOperator', true)",
      "write-direct:isOperator @ function:handleWelcome :: setState('network.isOperator', false)",
      "write-direct:isOperator @ function:handleWelcome :: setState('network.isOperator', true)",
    ],
  ],
  [
    'src/network/host.ts',
    [
      "read:appRole @ function:localStandardHostAuthorityKey :: if (!isStandardRoom() || getState('network.appRole') !== 'host' || getState('network.hostConn'))",
    ],
  ],
  [
    'src/network/operator-file-uplink.ts',
    [
      "event:appRole @ function:initStandardOperatorFileUplink :: bus.on(\"state:network.appRole\", () => { if (getState('network.appRole') === 'idle') { cancelOutgoing('session-reset', false); abortAllHostUploads('session-reset'); hostBatchCommits.clear(); announcedHostBatches.clear(); } })",
      'event:isOperator @ function:initStandardOperatorFileUplink :: bus.on("state:network.isOperator", cancelIfOutgoingAuthorityWasRevoked)',
      "read:appRole @ callback-call:bus.on(\"state:network.appRole\")#1 :: if (getState('network.appRole') === 'idle')",
      "read:appRole @ function:isCurrentOutgoingAuthority :: return (getRoomContext().kind === 'standard' && getState('network.appRole') === 'guest' && getState('network.hostConn') === conn && conn.open === true && hasRoomCapability('asset.upload'))",
      "read:appRole @ function:isExactAuthorizedHostConnection :: return (getRoomContext().kind === 'standard' && getState('network.appRole') === 'host' && !getState('network.hostConn') && !!conn.peer && getState('network.activeHostConnByPeerId').get(conn.peer) === conn && verifyPeerCapability(conn, 'asset.upload'))",
    ],
  ],
  [
    'src/network/orchestrator.ts',
    [
      "read:appRole @ function:isHost :: return getState('network.appRole') === 'host' && !getState('network.hostConn')",
    ],
  ],
  [
    'src/network/peer.ts',
    [
      "read:appRole @ callback-call:peer.on(\"connection\")#1 :: variable appRole = getState('network.appRole') => consumers [appRole -> if (appRole !== 'host')]",
      "read:appRole @ callback-call:peer.on(\"disconnected\")#1 :: variable appRole = getState('network.appRole') => consumers [appRole -> if (appRole !== 'host' && appRole !== 'guest')]",
      "read:appRole @ callback-call:peer.on(\"error\")#1 :: variable appRole = getState('network.appRole') => consumers [appRole -> if (!appRole) | appRole -> if (appRole === 'guest') | appRole -> if (appRole === 'host' && !hostConn)]",
      "read:appRole @ callback-call:peer.on(\"room-identity\")#1 :: batchSetState({ 'network.myMemberId': identity?.memberId ?? null, 'network.myMemberDisplayNumber': identity?.memberDisplayNumber ?? null, 'network.myMemberAuthenticated': identity?.isAuthenticated === true, ...(identity?.nickname ? { 'network.myDeviceLabel': identity.nickname } : getState('network.appRole') === 'host' ? { 'network.myDeviceLabel': 'HOST' } : {}), })",
      "read:appRole @ callback-call:peer.on(\"room-identity\")#1 :: if (getState('network.appRole') === 'host')",
      "read:appRole @ callback-call:setManagedTimer(\"peer-disconnect-grace\")#1 :: variable role = getState('network.appRole') => consumers [role -> if (role !== 'host' && role !== 'guest') | role -> if (role === 'guest') | role -> if (role === 'host')]",
      "read:appRole @ callback-call:setManagedTimer(\"setup-cancel-intent-reset\")#1 :: if (getState('network.appRole') === 'idle' && !getState('setup.sessionStarted'))",
      "read:appRole @ function:isNetworkInitStillActive :: variable appRole = getState('network.appRole') => consumers [appRole -> return appRole === 'guest' && getState('network.isConnecting') | appRole -> return appRole === 'host']",
      "write-object:appRole @ function:leaveSession :: 'network.appRole': 'idle'",
      "write-object:isOperator @ function:leaveSession :: 'network.isOperator': false",
    ],
  ],
  [
    'src/network/protocol.ts',
    [
      "read:appRole @ function:handleData :: variable appRole = getState('network.appRole') => consumers [appRole -> if (appRole === 'host' && (!conn?.peer || getState('network.activeHostConnByPeerId').get(conn.peer) !== conn)) | appRole -> variable isGuest = appRole === 'guest']",
    ],
  ],
  [
    'src/network/queue-mutation-authority.ts',
    [
      'event:appRole @ function:initStandardQueueMutationAuthority :: guestLifecycleScope.on("state:network.appRole", (role) => { if (role !== \'guest\') cancelAllGuestMutations(); })',
      'event:isOperator @ function:initStandardQueueMutationAuthority :: guestLifecycleScope.on("state:network.isOperator", (isOperator) => { if (isOperator !== true) cancelAllGuestMutations(); })',
      "read:appRole @ function:isExactLiveStandardGuestConnection :: return (getRoomContext().kind === 'standard' && getState('network.appRole') === 'host' && !getState('network.hostConn') && conn.open === true && !!conn.peer && getState('network.activeHostConnByPeerId').get(conn.peer) === conn && getState('network.connectedPeers').some((peer) => peer.id === conn.peer && peer.conn === conn))",
      "read:appRole @ function:sendStandardQueueMutationRequest :: if (getRoomContext().kind !== 'standard' || getState('network.appRole') !== 'guest' || conn?.open !== true || !hasRoomCapability(requiredQueueMutationCapability(message)))",
    ],
  ],
  [
    'src/network/signaling-health.ts',
    [
      "read:appRole @ function:canRecoverSignalingInPlace :: return getState('network.appRole') === 'host' && /^\\d{6}$/.test(getState('network.sessionCode'))",
      "read:appRole @ function:hasOpenStandardRoomChannel :: variable role = getState('network.appRole') => consumers [role -> if (role === 'guest') | role -> if (role === 'host')]",
    ],
  ],
  [
    'src/network/sync.ts',
    [
      "event:appRole @ function:initSync :: bus.on(\"state:network.appRole\", () => { const role = getState('network.appRole'); setIsHostClock(role === 'host'); if (role !== 'host' && role !== 'guest') resetClockState(); })",
      "read:appRole @ callback-call:bus.on(\"state:network.appRole\")#1 :: variable role = getState('network.appRole') => consumers [role -> if (role !== 'host' && role !== 'guest') | role -> setIsHostClock(role === 'host')]",
      "read:appRole @ callback-call:bus.on(\"state:network.hostConn\")#1 :: if (getState('network.appRole') !== 'guest')",
      "read:appRole @ function:resolveRequestedKickTarget :: if (getState('network.hostConn') || getState('network.appRole') !== 'host')",
    ],
  ],
  [
    'src/network/system-audio-debug.ts',
    [
      "read:appRole @ function:collectSystemAudioDebugText :: lines.push(`[App] role:${getState('network.appRole')} conn:${getState('network.connectionType')} my:${short(getState('network.myId'))} code:${getState('network.sessionCode') || '-'}`)",
    ],
  ],
  [
    'src/network/system-audio-guest.ts',
    [
      "read:appRole @ callback-call:bus.on(\"system-audio:delivery-handoff\")#1 :: if (getState('network.appRole') !== 'guest')",
    ],
  ],
  [
    'src/network/system-audio-host.ts',
    [
      "read:appRole @ callback-call:bus.on(\"network:peer-connected\")#1 :: if (getState('network.appRole') !== 'host')",
      "read:appRole @ callback-call:bus.on(\"system-audio:sfu-fallback\")#1 :: if (getState('network.appRole') !== 'host')",
      "read:appRole @ function:sendActiveSystemAudioToPeer :: if (getState('network.appRole') !== 'host')",
    ],
  ],
  [
    'src/network/system-audio-sfu.ts',
    [
      "read:appRole @ callback-call:bus.on(\"network:peer-connected\")#1 :: if (getState('network.appRole') !== 'guest')",
      "read:appRole @ callback-call:bus.on(\"network:peer-connection-replaced\")#1 :: if (getState('network.appRole') !== 'host')",
      "read:appRole @ callback-call:bus.on(\"network:peer-disconnected\")#1 :: if (getState('network.appRole') === 'guest' && !getState('network.hostConn'))",
      "read:appRole @ callback-call:bus.on(\"network:peer-disconnected\")#1 :: if (getState('network.appRole') === 'host')",
      "read:appRole @ callback-call:bus.on(\"system-audio:incoming-call\")#1 :: if (getState('network.appRole') !== 'guest')",
      "read:appRole @ callback-call:bus.on(\"system-audio:receive-timeout\")#1 :: if (getState('network.appRole') !== 'guest')",
      "read:appRole @ callback-call:bus.on(\"system-audio:streams-ready\")#1 :: if (getState('network.appRole') !== 'host')",
      "read:appRole @ function:beginBoundedHostRetry :: if (hostRetryCount >= HOST_SFU_MAX_RETRIES || !isSystemAudioActive() || getState('network.appRole') !== 'host' || !hasLocalSfuHostPeers())",
      "read:appRole @ function:handleSfuCapability :: if (getState('network.appRole') !== 'host' || !conn?.peer)",
      "read:appRole @ function:publishToEligiblePeer :: if (getState('network.appRole') !== 'host')",
      "read:appRole @ function:runBoundedHostRetry :: if (!isSystemAudioActive() || getState('network.appRole') !== 'host')",
    ],
  ],
  [
    'src/player/playlist.ts',
    [
      "read:appRole @ function:appendStandardHostFiles :: if (files.length === 0 || getState('network.appRole') !== 'host' || getState('network.hostConn') || getRoomContext().kind !== 'standard')",
    ],
  ],
  [
    'src/pro-room/network-bridge.ts',
    [
      "write-object:appRole @ method:#open :: 'network.appRole': 'host'",
      "write-object:appRole @ method:disconnect :: 'network.appRole': 'idle'",
      "write-object:isOperator @ method:#open :: 'network.isOperator': true",
      "write-object:isOperator @ method:disconnect :: 'network.isOperator': false",
    ],
  ],
  [
    'src/pro-room/runtime.ts',
    [
      "write-object:isOperator @ function:applyAuthority :: 'network.isOperator': acceptedContext.role === 'member'",
    ],
  ],
  [
    'src/rooms/authority.ts',
    [
      "read:appRole @ function:hasRoomCapability :: if (getState('network.appRole') === 'guest' && hostConn?.open === true && getState('network.isOperator'))",
      "read:appRole @ function:hasRoomCapability :: if (getState('network.appRole') === 'host' && !getState('network.hostConn'))",
      "read:appRole @ function:isCoordinator :: return getState('network.appRole') === 'host' && !getState('network.hostConn')",
      "read:appRole @ function:isStandardRoomMember :: return getRoomContext().kind === 'standard' && getState('network.appRole') === 'guest'",
      "read:isOperator @ function:hasRoomCapability :: if (getState('network.appRole') === 'guest' && hostConn?.open === true && getState('network.isOperator'))",
    ],
  ],
  [
    'src/share/remote-share.ts',
    [
      "read:appRole @ callback-call:bus.on(\"network:peer-connected\")#1 :: if (getState('network.appRole') !== 'guest')",
      "read:appRole @ callback-call:bus.on(\"network:peer-connection-replaced\")#1 :: if (getState('network.appRole') !== 'host')",
      "read:appRole @ callback-call:bus.on(\"network:peer-disconnected\")#1 :: if (getState('network.appRole') !== 'host')",
      "read:appRole @ function:handleFileR2Capability :: if (getState('network.appRole') !== 'host' || !conn?.peer)",
    ],
  ],
  [
    'src/storage/preload.ts',
    [
      "read:appRole @ function:isActiveHostPreloadChunkForRateLimit :: if (getState('network.appRole') !== 'guest' || conn.open !== true || !isHostBroadcast(conn) || data.type !== MSG.PRELOAD_CHUNK || Object.keys(data).length !== 5)",
    ],
  ],
  [
    'src/storage/transfer-receive.ts',
    [
      "read:appRole @ function:isActiveHostFileChunkForRateLimit :: if (getState('network.appRole') !== 'guest' || conn.open !== true || !isHostBroadcast(conn))",
    ],
  ],
  [
    'src/sw-register.ts',
    [
      "read:appRole @ callback-variable:handlePassiveControllerChange :: if (getState('network.appRole') !== 'idle')",
    ],
  ],
  [
    'src/ui/announcement.ts',
    [
      'event:appRole @ function:initAnnouncementPolling :: bus.on("state:network.appRole", () => { if (isSessionActive()) startAnnouncementPolling(); else stopAnnouncementPolling(); })',
      "read:appRole @ function:isSessionActive :: return getState('network.appRole') !== 'idle'",
    ],
  ],
  [
    'src/ui/chat.ts',
    [
      "read:isOperator @ function:sendChatMessage :: variable isOp = isProRoom ? ownProParticipant?.role === 'owner' || ownProParticipant?.role === 'controller' : getState('network.isOperator') || false => consumers [isOp -> if (chatFrozen && !isHost && !isOp) | isOp -> if (slowmode > 0 && !isHost && !isOp) | isOp -> variable chatMsg = { type: MSG.CHAT, senderId: myId, ...(senderMemberId ? { senderMemberId } : {}), sender: senderLabel, senderLabel: senderLabel, isHost, isOp, text: text, ts: Date.now(), joinOrder: myJoinOrder, ...(botRequestId ? { botRequestId } : {}), } | isOp -> variable localBadge = isProRoom ? ownProParticipant?.role === 'owner' ? 'host' : ownProParticipant?.role === 'controller' ? 'op' : undefined : isHost ? 'host' : isOp ? 'op' : undefined]",
    ],
  ],
  [
    'src/ui/connect.ts',
    [
      'event:appRole @ function:initConnect :: _busScope.on("state:network.appRole", () => { syncRoomPasswordControls(); syncHostOwnedConnectSections(); renderSignalingRecoveryControls(); })',
      "read:appRole @ function:_canEditHostOwnedSetting :: return getState('network.appRole') === 'host' && !getState('network.hostConn')",
      "read:appRole @ function:signalingRecoveryBoundary :: return [ room.kind, room.roomId ?? '', getState('network.appRole'), getState('network.sessionCode'), ].join(':')",
    ],
  ],
  [
    'src/ui/player-controls.ts',
    [
      'event:appRole @ function:initPlayerControls :: _busScope.on("state:network.appRole", () => { updateRoleBadge(); syncMediaSourceButtonAuthority(); syncQueueModeButtonAuthority(); syncPlayButtonAuthority(); syncMainSyncButtonState(); })',
      'event:appRole @ function:initPlayerControls :: _busScope.on("state:network.appRole", closeManualSyncIfInvalid)',
      'event:isOperator @ function:initPlayerControls :: _busScope.on("state:network.isOperator", (isOperator) => { if (!isOperator && isProRoomTrackChangeIntentPending()) { clearProRoomTrackChangeIntent(); } syncMediaSourceButtonAuthority(); syncQueueModeButtonAuthority(); syncPlayButtonAuthority(); })',
      "read:appRole @ function:getConnectedDeviceCount :: variable appRole = getState('network.appRole') => consumers [appRole -> if (!hostConn && (appRole === 'host' || sessionStarted || peerConnected > 0))]",
      "read:appRole @ function:handleLogoReturnToMain :: variable appRole = getState('network.appRole') => consumers [appRole -> variable hasSession = !!(hostConn || appRole === 'host')]",
      "read:appRole @ function:shouldPulseRoleClock :: variable appRole = getState('network.appRole') => consumers [appRole -> if (appRole === 'host')]",
      "read:appRole @ function:syncPlayButtonAuthority :: variable roomAuthorityApplies = context.kind === 'pro' || getState('network.appRole') !== 'idle' => consumers [roomAuthorityApplies -> variable hasAuthority = !roomAuthorityApplies || hasRoomCapability('playback.control')]",
    ],
  ],
  [
    'src/ui/playlist-view.ts',
    [
      'event:appRole @ function:initPlaylistView :: _busScope.on("state:network.appRole", (role: unknown) => { if (role === \'idle\') { _followController?.reset(); _expansionOverrides.clear(); _reorderController?.cancel(); _removalController?.cancel(); _currentJumpController?.refresh(); } })',
      'event:isOperator @ function:initPlaylistView :: _busScope.on("state:network.isOperator", (isOperator) => { if (!isOperator || !canEditQueueStructure()) { _reorderController?.cancel(); _removalController?.cancel(); } schedulePlaylistUpdate(); })',
    ],
  ],
  [
    'src/ui/seekbar.ts',
    [
      'event:appRole @ function:initSeekBarBusHandlers :: _busScope.on("state:network.appRole", refreshAvailability)',
      'event:isOperator @ function:initSeekBarBusHandlers :: _busScope.on("state:network.isOperator", refreshAvailability)',
      "read:appRole @ function:getSeekUnavailableReason :: variable roomAuthorityApplies = getRoomContext().kind === 'pro' || getState('network.appRole') !== 'idle' => consumers [roomAuthorityApplies -> if (roomAuthorityApplies && !hasRoomCapability('playback.control'))]",
    ],
  ],
  [
    'src/ui/settings.ts',
    [
      'event:appRole @ function:initSettings :: _busScope.on("state:network.appRole", () => _updateHostCtrlLockUI())',
    ],
  ],
  [
    'src/ui/setup-guest.ts',
    [
      "read:appRole @ function:handleSetupJoinWithRole :: variable appRole = getState('network.appRole') => consumers [appRole -> if (appRole !== 'guest')]",
      "write-direct:appRole @ function:startGuestFlow :: setState('network.appRole', 'guest')",
    ],
  ],
  [
    'src/ui/setup-host.ts',
    [
      "read:appRole @ function:proceedToHostCode :: variable appRole = getState('network.appRole') => consumers [appRole -> if (appRole !== 'host')]",
      "read:appRole @ function:startSessionFromHost :: variable appRole = getState('network.appRole') => consumers [appRole -> if (appRole !== 'host' || getState('setup.sessionStarted'))]",
      "write-direct:appRole @ function:startHostFlow :: setState('network.appRole', 'host')",
    ],
  ],
  [
    'src/ui/setup-shared.ts',
    [
      "read:appRole @ function:handleSetupRolePreview :: variable appRole = getState('network.appRole') => consumers [appRole -> if (appRole !== 'guest' && appRole !== 'host')]",
    ],
  ],
  [
    'src/ui/setup.ts',
    [
      "read:appRole @ callback-call:bus.on(\"network:error\")#1 :: variable appRole = getState('network.appRole') => consumers [appRole -> if (appRole === 'guest' && !getState('setup.sessionStarted'))]",
      "write-direct:appRole @ function:initSetupOverlay :: setState('network.appRole', 'idle')",
    ],
  ],
  [
    'src/youtube/player.ts',
    [
      'event:appRole @ function:initYouTube :: bus.on("state:network.appRole", reconcileZeroStartAuthority)',
      "read:appRole @ callback-variable:getZeroStartAuthoritySignature :: return [ room.kind, room.roomId ?? '', room.role, room.coordinatorId ?? '', room.epoch, getState('network.appRole') ?? '', getState('network.hostConn')?.peer ?? '', ].join('|')",
      "read:appRole @ function:getYouTubeZeroStartRole :: return getState('network.appRole') === 'guest' ? 'guest' : 'host'",
      "read:appRole @ function:isLiveStandardOperatorConnection :: return (getRoomContext().kind === 'standard' && getState('network.appRole') === 'host' && !getState('network.hostConn') && getState('network.sessionCode') === roomCode && conn.open === true && getState('network.activeHostConnByPeerId').get(conn.peer) === conn && verifyPeerCapability(conn, 'media.add'))",
    ],
  ],
] as const);

function callsiteAllowanceReason(relPath: string): CallsiteAllowance['reason'] {
  const readAllowance = READ_ALLOWLIST.get(relPath);
  if (readAllowance) return readAllowance.reason;
  if (WRITE_ALLOWLIST.has(relPath)) {
    return relPath.startsWith('src/pro-room/') ? 'compatibility-projection' : 'standard-lifecycle';
  }
  return 'compatibility-event';
}

const CALLSITE_ALLOWLIST = new Map<string, CallsiteAllowance>(
  [...CALLSITE_FINGERPRINTS].map(([relPath, fingerprints]) => [
    relPath,
    { reason: callsiteAllowanceReason(relPath), fingerprints },
  ]),
);

interface AccessCounts {
  appRoleReads: number;
  isOperatorReads: number;
  appRoleEvents: number;
  isOperatorEvents: number;
  appRoleDirectWrites: number;
  isOperatorDirectWrites: number;
  appRoleObjectWrites: number;
  isOperatorObjectWrites: number;
}

interface SourceAnalysis {
  readonly counts: AccessCounts;
  readonly fingerprints: readonly string[];
  readonly snapshotLegacyReads: number;
}

export interface RoomAuthorityBoundaryResult {
  readonly productionFiles: number;
  readonly directReads: number;
  readonly stateEvents: number;
  readonly writes: number;
  readonly proDirectReads: 0;
  readonly snapshotLegacyReads: 0;
  readonly proSnapshotLegacyReads: 0;
}

const emptyCounts = (): AccessCounts => ({
  appRoleReads: 0,
  isOperatorReads: 0,
  appRoleEvents: 0,
  isOperatorEvents: 0,
  appRoleDirectWrites: 0,
  isOperatorDirectWrites: 0,
  appRoleObjectWrites: 0,
  isOperatorObjectWrites: 0,
});

function walkProductionSources(directory: string, output: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') walkProductionSources(absolute, output);
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      output.push(absolute);
    }
  }
  return output;
}

export function loadRoomAuthoritySources(root = repoRoot): ReadonlyMap<string, string> {
  const rootSource = path.resolve(root, 'src');
  return new Map(
    walkProductionSources(rootSource).map((absolute) => [
      path.relative(root, absolute).replaceAll('\\', '/'),
      readFileSync(absolute, 'utf8'),
    ]),
  );
}

function collect(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function literalText(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function fieldForKey(value: string | null): LegacyField | null {
  if (value === 'network.appRole') return 'appRole';
  if (value === 'network.isOperator') return 'isOperator';
  return null;
}

function fieldForEvent(value: string | null): LegacyField | null {
  if (value === 'state:network.appRole') return 'appRole';
  if (value === 'state:network.isOperator') return 'isOperator';
  return null;
}

function callableName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function callableAliases(parsed: ts.SourceFile, canonicalName: string): Set<string> {
  const aliases = new Set([canonicalName]);
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === canonicalName) {
        aliases.add(element.name.text);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of collect(parsed, ts.isVariableDeclaration)) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        aliases.has(node.initializer.text) &&
        !aliases.has(node.name.text)
      ) {
        aliases.add(node.name.text);
        changed = true;
      }
    }
  }
  return aliases;
}

interface StateSnapshotAliases {
  readonly identifiers: ReadonlySet<string>;
  readonly namespaces: ReadonlySet<string>;
}

function isCoreStateModuleSpecifier(value: string | null): boolean {
  return value !== null && /(?:^|\/)core\/state\.(?:ts|js)$/u.test(value.replaceAll('\\', '/'));
}

function stateSnapshotAliases(parsed: ts.SourceFile): StateSnapshotAliases {
  const identifiers = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !isCoreStateModuleSpecifier(literalText(statement.moduleSpecifier))
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === 'snapshot') {
        identifiers.add(element.name.text);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const raw of collect(parsed, ts.isVariableDeclaration)) {
      if (!ts.isVariableDeclaration(raw) || !raw.initializer) continue;
      const initializer = unwrapAliasExpression(raw.initializer);
      if (
        ts.isObjectBindingPattern(raw.name) &&
        ts.isIdentifier(initializer) &&
        namespaces.has(initializer.text)
      ) {
        for (const element of raw.name.elements) {
          if (
            !element.dotDotDotToken &&
            staticPropertyName(element.propertyName ?? element.name) === 'snapshot' &&
            ts.isIdentifier(element.name) &&
            !identifiers.has(element.name.text)
          ) {
            identifiers.add(element.name.text);
            changed = true;
          }
        }
        continue;
      }
      if (!ts.isIdentifier(raw.name)) continue;
      const aliasesIdentifier = ts.isIdentifier(initializer) && identifiers.has(initializer.text);
      const aliasesNamespace = ts.isIdentifier(initializer) && namespaces.has(initializer.text);
      const aliasesNamespaceMember =
        (ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer)) &&
        ts.isIdentifier(initializer.expression) &&
        namespaces.has(initializer.expression.text) &&
        (ts.isPropertyAccessExpression(initializer)
          ? initializer.name.text
          : literalText(initializer.argumentExpression)) === 'snapshot';
      if ((aliasesIdentifier || aliasesNamespaceMember) && !identifiers.has(raw.name.text)) {
        identifiers.add(raw.name.text);
        changed = true;
      }
      if (aliasesNamespace && !namespaces.has(raw.name.text)) {
        namespaces.add(raw.name.text);
        changed = true;
      }
    }
  }
  return { identifiers, namespaces };
}

const fingerprintPrinter = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: true,
});

function normalizedNodeText(node: ts.Node, parsed: ts.SourceFile): string {
  return fingerprintPrinter
    .printNode(ts.EmitHint.Unspecified, node, parsed)
    .replace(/\s+/gu, ' ')
    .trim();
}

function declaredName(node: ts.Node | undefined, parsed: ts.SourceFile): string {
  if (!node) return '<anonymous>';
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return normalizedNodeText(node, parsed);
}

function callsiteScope(node: ts.Node, parsed: ts.SourceFile): string {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) {
      return `function:${current.name?.text ?? '<anonymous>'}`;
    }
    if (ts.isMethodDeclaration(current)) {
      return `method:${declaredName(current.name, parsed)}`;
    }
    if (ts.isConstructorDeclaration(current)) return 'constructor';
    if (ts.isGetAccessorDeclaration(current)) {
      return `getter:${declaredName(current.name, parsed)}`;
    }
    if (ts.isSetAccessorDeclaration(current)) {
      return `setter:${declaredName(current.name, parsed)}`;
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const owner = current.parent;
      if (ts.isVariableDeclaration(owner)) {
        return `callback-variable:${declaredName(owner.name, parsed)}`;
      }
      if (ts.isPropertyAssignment(owner) || ts.isPropertyDeclaration(owner)) {
        return `callback-property:${declaredName(owner.name, parsed)}`;
      }
      if (ts.isCallExpression(owner)) {
        const argumentIndex = owner.arguments.findIndex((argument) => argument === current);
        const firstArgument = literalText(owner.arguments[0]);
        return (
          `callback-call:${normalizedNodeText(owner.expression, parsed)}` +
          `${firstArgument === null ? '' : `(${JSON.stringify(firstArgument)})`}` +
          `#${argumentIndex}`
        );
      }
      return 'callback:<anonymous>';
    }
  }
  return '<module>';
}

function valueUseSite(node: ts.Node, parsed: ts.SourceFile): string {
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (ts.isVariableDeclaration(parent)) {
      return `variable ${declaredName(parent.name, parsed)} = ${normalizedNodeText(
        parent.initializer ?? current,
        parsed,
      )}`;
    }
    if (ts.isReturnStatement(parent)) {
      return `return ${parent.expression ? normalizedNodeText(parent.expression, parsed) : ''}`.trim();
    }
    if (ts.isIfStatement(parent) && parent.expression === current) {
      return `if (${normalizedNodeText(parent.expression, parsed)})`;
    }
    if (ts.isWhileStatement(parent) && parent.expression === current) {
      return `while (${normalizedNodeText(parent.expression, parsed)})`;
    }
    if (ts.isDoStatement(parent) && parent.expression === current) {
      return `do-while (${normalizedNodeText(parent.expression, parsed)})`;
    }
    if (ts.isSwitchStatement(parent) && parent.expression === current) {
      return `switch (${normalizedNodeText(parent.expression, parsed)})`;
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === current) {
      return `property ${declaredName(parent.name, parsed)} = ${normalizedNodeText(
        parent.initializer,
        parsed,
      )}`;
    }
    if (ts.isExpressionStatement(parent)) return normalizedNodeText(parent.expression, parsed);
    if (ts.isArrowFunction(parent) && parent.body === current) {
      return `concise-return ${normalizedNodeText(parent.body, parsed)}`;
    }
    if (ts.isFunctionLike(parent)) return normalizedNodeText(current, parsed);
  }
  return normalizedNodeText(node, parsed);
}

function enclosingFunctionBoundary(node: ts.Node): ts.SignatureDeclaration | ts.SourceFile {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return node.getSourceFile();
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (
    (ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  return !ts.isLabeledStatement(parent) && !ts.isBreakOrContinueStatement(parent);
}

function unwrapAliasExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function readResultConsumers(node: ts.CallExpression, parsed: ts.SourceFile): string[] {
  let declaration: ts.VariableDeclaration | null = null;
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    if (ts.isVariableDeclaration(current.parent)) {
      declaration = current.parent;
      break;
    }
    if (ts.isFunctionLike(current.parent)) break;
  }
  if (!declaration || !ts.isIdentifier(declaration.name)) return [];

  const boundary = enclosingFunctionBoundary(declaration);
  const taintedNames = new Set([declaration.name.text]);
  const declarations = collect(boundary, ts.isVariableDeclaration).filter(ts.isVariableDeclaration);
  const assignments = collect(boundary, ts.isBinaryExpression)
    .filter(ts.isBinaryExpression)
    .filter((candidate) => candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken);

  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of declarations) {
      if (
        candidate === declaration ||
        !ts.isIdentifier(candidate.name) ||
        !candidate.initializer ||
        enclosingFunctionBoundary(candidate) !== boundary
      ) {
        continue;
      }
      const initializer = unwrapAliasExpression(candidate.initializer);
      if (
        ts.isIdentifier(initializer) &&
        taintedNames.has(initializer.text) &&
        !taintedNames.has(candidate.name.text)
      ) {
        taintedNames.add(candidate.name.text);
        changed = true;
      }
    }
    for (const assignment of assignments) {
      if (enclosingFunctionBoundary(assignment) !== boundary) continue;
      const left = unwrapAliasExpression(assignment.left);
      const right = unwrapAliasExpression(assignment.right);
      if (
        ts.isIdentifier(left) &&
        ts.isIdentifier(right) &&
        taintedNames.has(right.text) &&
        !taintedNames.has(left.text)
      ) {
        taintedNames.add(left.text);
        changed = true;
      }
    }
  }

  const consumers = new Set<string>();
  for (const raw of collect(boundary, ts.isIdentifier)) {
    if (!ts.isIdentifier(raw) || !taintedNames.has(raw.text) || !isIdentifierReference(raw)) {
      continue;
    }
    if (raw.getStart(parsed) <= declaration.name.getEnd()) continue;
    if (enclosingFunctionBoundary(raw) !== boundary) continue;
    consumers.add(`${raw.text} -> ${valueUseSite(raw, parsed)}`);
  }
  return [...consumers].sort();
}

type SnapshotValueKind = 'root' | 'network';

function staticPropertyName(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return literalText(node.expression);
  return null;
}

function legacyFieldForProperty(value: string | null): LegacyField | null {
  if (value === 'appRole') return 'appRole';
  if (value === 'isOperator') return 'isOperator';
  return null;
}

function isStateSnapshotCall(call: ts.CallExpression, aliases: StateSnapshotAliases): boolean {
  const expression = unwrapAliasExpression(call.expression);
  if (ts.isIdentifier(expression)) return aliases.identifiers.has(expression.text);
  return (
    (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
    ts.isIdentifier(expression.expression) &&
    aliases.namespaces.has(expression.expression.text) &&
    (ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : literalText(expression.argumentExpression)) === 'snapshot'
  );
}

function findSnapshotLegacyReads(parsed: ts.SourceFile): ReadonlyMap<ts.Node, LegacyField> {
  const callable = stateSnapshotAliases(parsed);
  if (callable.identifiers.size === 0 && callable.namespaces.size === 0) return new Map();

  const rootAliases = new Set<string>();
  const networkAliases = new Set<string>();
  const accesses = new Map<ts.Node, LegacyField>();

  const resolveKind = (expression: ts.Expression): SnapshotValueKind | null => {
    const current = unwrapAliasExpression(expression);
    if (ts.isCallExpression(current) && isStateSnapshotCall(current, callable)) return 'root';
    if (ts.isIdentifier(current)) {
      if (rootAliases.has(current.text)) return 'root';
      if (networkAliases.has(current.text)) return 'network';
      return null;
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const property = ts.isPropertyAccessExpression(current)
        ? current.name.text
        : literalText(current.argumentExpression);
      const parentKind = resolveKind(current.expression);
      if (parentKind === 'root' && property === 'network') return 'network';
    }
    return null;
  };

  const bindPattern = (name: ts.BindingName, kind: SnapshotValueKind): boolean => {
    if (ts.isIdentifier(name)) {
      const target = kind === 'root' ? rootAliases : networkAliases;
      if (target.has(name.text)) return false;
      target.add(name.text);
      return true;
    }
    if (!ts.isObjectBindingPattern(name)) return false;
    let changed = false;
    for (const element of name.elements) {
      if (element.dotDotDotToken) continue;
      const property = staticPropertyName(element.propertyName ?? element.name);
      if (kind === 'root' && property === 'network') {
        changed = bindPattern(element.name, 'network') || changed;
        continue;
      }
      const field = kind === 'network' ? legacyFieldForProperty(property) : null;
      if (field) accesses.set(element, field);
    }
    return changed;
  };

  const declarations = collect(parsed, ts.isVariableDeclaration).filter(ts.isVariableDeclaration);
  const assignments = collect(parsed, ts.isBinaryExpression)
    .filter(ts.isBinaryExpression)
    .filter((candidate) => candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!declaration.initializer) continue;
      const kind = resolveKind(declaration.initializer);
      if (kind) changed = bindPattern(declaration.name, kind) || changed;
    }
    for (const assignment of assignments) {
      if (!ts.isIdentifier(assignment.left)) continue;
      const kind = resolveKind(assignment.right);
      if (!kind) continue;
      const target = kind === 'root' ? rootAliases : networkAliases;
      if (!target.has(assignment.left.text)) {
        target.add(assignment.left.text);
        changed = true;
      }
    }
  }

  for (const raw of collect(
    parsed,
    (node) => ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node),
  )) {
    if (!ts.isPropertyAccessExpression(raw) && !ts.isElementAccessExpression(raw)) continue;
    const property = ts.isPropertyAccessExpression(raw)
      ? raw.name.text
      : literalText(raw.argumentExpression);
    const field = legacyFieldForProperty(property);
    if (field && resolveKind(raw.expression) === 'network') accesses.set(raw, field);
  }
  return accesses;
}

function callsiteFingerprint(
  kind: LegacyAccessKind,
  field: LegacyField,
  node: ts.CallExpression | ts.PropertyAssignment,
  parsed: ts.SourceFile,
): string {
  let useSite: string;
  if (kind === 'read' && ts.isCallExpression(node)) {
    const consumers = readResultConsumers(node, parsed);
    useSite = valueUseSite(node, parsed);
    if (consumers.length > 0) useSite += ` => consumers [${consumers.join(' | ')}]`;
  } else if (kind === 'event' && ts.isCallExpression(node)) {
    const handler = node.arguments[1];
    useSite = `${normalizedNodeText(node.expression, parsed)}(${JSON.stringify(
      literalText(node.arguments[0]),
    )}, ${handler ? normalizedNodeText(handler, parsed) : '<missing-handler>'})`;
  } else {
    useSite = normalizedNodeText(node, parsed);
  }
  return `${kind}:${field} @ ${callsiteScope(node, parsed)} :: ${useSite}`;
}

function increment(
  counts: AccessCounts,
  field: LegacyField,
  appRoleKey: keyof AccessCounts,
  isOperatorKey: keyof AccessCounts,
): void {
  const key = field === 'appRole' ? appRoleKey : isOperatorKey;
  counts[key] += 1;
}

function analyzeSource(relPath: string, source: string, findings: string[]): SourceAnalysis {
  const parsed = ts.createSourceFile(
    relPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const counts = emptyCounts();
  const fingerprints: string[] = [];
  const handledLiterals = new Set<ts.Node>();
  const readerNames = callableAliases(parsed, 'getState');
  const writerNames = callableAliases(parsed, 'setState');
  const snapshotLegacyReads = findSnapshotLegacyReads(parsed);

  for (const [node, field] of snapshotLegacyReads) {
    findings.push(
      `${relPath}: full-state snapshot reads legacy network.${field} at ` +
        `${callsiteScope(node, parsed)} :: ${valueUseSite(node, parsed)}; ` +
        'read authority through src/rooms/authority.ts instead',
    );
  }

  for (const raw of collect(parsed, ts.isCallExpression)) {
    if (!ts.isCallExpression(raw)) continue;
    const firstArgument = raw.arguments[0];
    const field = fieldForKey(literalText(firstArgument));
    const name = callableName(raw.expression);
    if (field && firstArgument && readerNames.has(name ?? '')) {
      handledLiterals.add(firstArgument);
      increment(counts, field, 'appRoleReads', 'isOperatorReads');
      fingerprints.push(callsiteFingerprint('read', field, raw, parsed));
    } else if (field && firstArgument && writerNames.has(name ?? '')) {
      handledLiterals.add(firstArgument);
      increment(counts, field, 'appRoleDirectWrites', 'isOperatorDirectWrites');
      fingerprints.push(callsiteFingerprint('write-direct', field, raw, parsed));
    }

    const eventField = fieldForEvent(literalText(firstArgument));
    if (eventField && firstArgument) {
      if (name !== 'on') {
        findings.push(
          `${relPath}: legacy state-event literals must be direct EventBus .on(...) subscriptions`,
        );
      }
      handledLiterals.add(firstArgument);
      increment(counts, eventField, 'appRoleEvents', 'isOperatorEvents');
      fingerprints.push(callsiteFingerprint('event', eventField, raw, parsed));
    }
  }

  for (const raw of collect(parsed, ts.isPropertyAssignment)) {
    if (!ts.isPropertyAssignment(raw)) continue;
    const field = fieldForKey(literalText(raw.name));
    if (!field) continue;
    handledLiterals.add(raw.name);
    increment(counts, field, 'appRoleObjectWrites', 'isOperatorObjectWrites');
    fingerprints.push(callsiteFingerprint('write-object', field, raw, parsed));
  }

  for (const raw of collect(
    parsed,
    (node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node),
  )) {
    if (handledLiterals.has(raw)) continue;
    const text = literalText(raw);
    if (fieldForKey(text) || fieldForEvent(text)) {
      findings.push(
        `${relPath}: unsupported indirect legacy authority key ${JSON.stringify(text)}; ` +
          'use the canonical room-authority helpers instead',
      );
    }
  }
  return {
    counts,
    fingerprints: fingerprints.sort(),
    snapshotLegacyReads: snapshotLegacyReads.size,
  };
}

function compareExact(
  relPath: string,
  label: string,
  actual: readonly number[],
  expected: readonly number[],
  findings: string[],
): void {
  if (actual.every((value, index) => value === expected[index])) return;
  findings.push(
    `${relPath}: ${label} changed from [${expected.join(', ')}] to [${actual.join(', ')}]. ` +
      'Route new authority through src/rooms/authority.ts; when removing legacy debt, lower the ratchet in this script.',
  );
}

function multisetDifference(left: readonly string[], right: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const value of right) remaining.set(value, (remaining.get(value) ?? 0) + 1);
  const difference: string[] = [];
  for (const value of left) {
    const count = remaining.get(value) ?? 0;
    if (count === 0) difference.push(value);
    else if (count === 1) remaining.delete(value);
    else remaining.set(value, count - 1);
  }
  return difference;
}

function compareCallsites(
  relPath: string,
  actual: readonly string[],
  allowance: CallsiteAllowance | undefined,
  findings: string[],
): void {
  const expected = allowance?.fingerprints ?? [];
  const added = multisetDifference(actual, expected);
  const removed = multisetDifference(expected, actual);
  if (added.length === 0 && removed.length === 0) return;

  const details = [
    ...removed.map((fingerprint) => `removed ${JSON.stringify(fingerprint)}`),
    ...added.map((fingerprint) => `added ${JSON.stringify(fingerprint)}`),
  ];
  findings.push(
    `${relPath}: legacy authority callsite fingerprints changed` +
      `${allowance ? ` (${allowance.reason})` : ''}:\n      ${details.join('\n      ')}. ` +
      'Review the use-site semantics before updating CALLSITE_ALLOWLIST.',
  );
}

function namedFunction(parsed: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const functions = collect(
    parsed,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name && node.body !== undefined,
  ).filter(ts.isFunctionDeclaration);
  const match = functions[0];
  if (functions.length !== 1 || !match?.body) {
    throw new Error(`src/rooms/authority.ts must define exactly one ${name}() function.`);
  }
  return match;
}

function assertCanonicalProGuards(authoritySource: string, findings: string[]): void {
  const parsed = ts.createSourceFile(
    'src/rooms/authority.ts',
    authoritySource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const checks = [
    {
      name: 'isCoordinator',
      guard: /if\(context\.kind===['"]pro['"]\)returncontext\.role===['"]coordinator['"];/u,
    },
    {
      name: 'hasRoomCapability',
      guard:
        /if\(context\.kind===['"]pro['"]\)returncontext\.capabilities\.includes\(capability\);/u,
    },
  ] as const;
  const readerNames = callableAliases(parsed, 'getState');

  for (const check of checks) {
    const declaration = namedFunction(parsed, check.name);
    const guard = declaration.body?.statements.find(
      (statement) =>
        ts.isIfStatement(statement) &&
        check.guard.test(normalizedNodeText(statement, parsed).replace(/\s+/gu, '')),
    );
    const legacyReads = collect(declaration.body!, ts.isCallExpression)
      .filter(ts.isCallExpression)
      .filter((call) => {
        const field = fieldForKey(literalText(call.arguments[0]));
        return field !== null && readerNames.has(callableName(call.expression) ?? '');
      });
    const firstLegacyRead = legacyReads.reduce(
      (first, call) => Math.min(first, call.getStart(parsed)),
      Number.POSITIVE_INFINITY,
    );
    if (!guard || firstLegacyRead < guard.getStart(parsed)) {
      findings.push(
        `src/rooms/authority.ts: ${check.name}() must return PRO server-projected authority before reading legacy standard-room state`,
      );
    }
  }
}

export function assertRoomAuthorityBoundaries(
  sources: ReadonlyMap<string, string>,
): RoomAuthorityBoundaryResult {
  const findings: string[] = [];
  const analyzed = new Map<string, SourceAnalysis>();
  for (const [relPath, source] of sources) {
    analyzed.set(relPath, analyzeSource(relPath, source, findings));
  }

  const allPaths = new Set([
    ...analyzed.keys(),
    ...READ_ALLOWLIST.keys(),
    ...EVENT_ALLOWLIST.keys(),
    ...WRITE_ALLOWLIST.keys(),
    ...CALLSITE_ALLOWLIST.keys(),
  ]);
  let directReads = 0;
  let stateEvents = 0;
  let writes = 0;
  let proDirectReads = 0;
  let snapshotLegacyReads = 0;
  let proSnapshotLegacyReads = 0;

  for (const relPath of allPaths) {
    const analysis = analyzed.get(relPath);
    const actual = analysis?.counts ?? emptyCounts();
    const reads = READ_ALLOWLIST.get(relPath);
    const events = EVENT_ALLOWLIST.get(relPath);
    const writesAllowed = WRITE_ALLOWLIST.get(relPath);
    compareExact(
      relPath,
      'legacy direct reads [appRole, isOperator]',
      [actual.appRoleReads, actual.isOperatorReads],
      [reads?.appRole ?? 0, reads?.isOperator ?? 0],
      findings,
    );
    compareCallsites(
      relPath,
      analysis?.fingerprints ?? [],
      CALLSITE_ALLOWLIST.get(relPath),
      findings,
    );
    compareExact(
      relPath,
      'legacy state events [appRole, isOperator]',
      [actual.appRoleEvents, actual.isOperatorEvents],
      [events?.appRole ?? 0, events?.isOperator ?? 0],
      findings,
    );
    compareExact(
      relPath,
      'legacy writes [appRole direct, isOperator direct, appRole object, isOperator object]',
      [
        actual.appRoleDirectWrites,
        actual.isOperatorDirectWrites,
        actual.appRoleObjectWrites,
        actual.isOperatorObjectWrites,
      ],
      [
        writesAllowed?.appRoleDirect ?? 0,
        writesAllowed?.isOperatorDirect ?? 0,
        writesAllowed?.appRoleObject ?? 0,
        writesAllowed?.isOperatorObject ?? 0,
      ],
      findings,
    );

    directReads += actual.appRoleReads + actual.isOperatorReads;
    stateEvents += actual.appRoleEvents + actual.isOperatorEvents;
    writes +=
      actual.appRoleDirectWrites +
      actual.isOperatorDirectWrites +
      actual.appRoleObjectWrites +
      actual.isOperatorObjectWrites;
    snapshotLegacyReads += analysis?.snapshotLegacyReads ?? 0;
    if (relPath.startsWith('src/pro-room/')) {
      proDirectReads += actual.appRoleReads + actual.isOperatorReads;
      proSnapshotLegacyReads += analysis?.snapshotLegacyReads ?? 0;
    }
  }

  if (proDirectReads > 0) {
    findings.push(
      `src/pro-room/** contains ${proDirectReads} legacy authority read(s); PRO authority must come only from room.context`,
    );
  }
  if (snapshotLegacyReads > 0) {
    findings.push(
      `production sources contain ${snapshotLegacyReads} legacy authority read(s) through ` +
        'the full-state snapshot; snapshot authority reads are forbidden',
    );
  }
  if (proSnapshotLegacyReads > 0) {
    findings.push(
      `src/pro-room/** contains ${proSnapshotLegacyReads} full-state snapshot authority read(s); ` +
        'PRO authority must come only from room.context',
    );
  }

  const authoritySource = sources.get('src/rooms/authority.ts');
  if (!authoritySource)
    findings.push('src/rooms/authority.ts is missing from the production source set');
  else assertCanonicalProGuards(authoritySource, findings);

  if (findings.length > 0) {
    throw new Error(
      `Room-authority boundary check failed:\n${findings
        .map((finding) => `  - ${finding}`)
        .join('\n')}`,
    );
  }

  return {
    productionFiles: sources.size,
    directReads,
    stateEvents,
    writes,
    proDirectReads: 0,
    snapshotLegacyReads: 0,
    proSnapshotLegacyReads: 0,
  };
}

export function collectRoomAuthorityCallsiteFingerprints(
  sources: ReadonlyMap<string, string>,
): ReadonlyMap<string, readonly string[]> {
  const findings: string[] = [];
  const fingerprints = new Map<string, readonly string[]>();
  for (const [relPath, source] of sources) {
    const analysis = analyzeSource(relPath, source, findings);
    if (analysis.fingerprints.length > 0) fingerprints.set(relPath, analysis.fingerprints);
  }
  if (findings.length > 0) {
    throw new Error(
      `Cannot collect room-authority fingerprints:\n${findings
        .map((finding) => `  - ${finding}`)
        .join('\n')}`,
    );
  }
  return fingerprints;
}

function main(): void {
  const result = assertRoomAuthorityBoundaries(loadRoomAuthoritySources());
  console.log(
    `[room-authority-boundaries] OK: ${result.directReads} grandfathered direct reads, ` +
      `${result.stateEvents} state subscriptions, ${result.writes} writes, ` +
      `${result.proDirectReads} PRO direct reads, ${result.snapshotLegacyReads} snapshot reads ` +
      `across ${result.productionFiles} production files.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
