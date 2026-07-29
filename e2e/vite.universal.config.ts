import { resolve } from 'node:path';
import { defineConfig, mergeConfig, type Plugin } from 'vite';
import baseConfig from '../vite.config.ts';
import { UNIVERSAL_BUILD_PROFILE_EVIDENCE } from './universal-bounded/build-profile-evidence.ts';

const PRODUCT_RUNTIME_MODULE = '/src/player/file-playback-product-runtime.ts';
const PEER_RANGE_DIAGNOSTICS_IMPORT =
  "import { PeerRangeHostResponder as UniversalE2ePeerRangeHostResponder } from './sources/peer-range-transport.ts';";
const LIFECYCLE_DIAGNOSTICS_IMPORT =
  "import { acquireFilePlaybackUniversalLifecycleLease as acquireUniversalE2eLifecycleLease, getFilePlaybackUniversalLifecycleSnapshotForTests as getUniversalE2eLifecycleSnapshot } from './diagnostics/file-playback-universal-lifecycle-diagnostics.ts';";
const PRODUCT_SINGLETON = `const filePlaybackProductBuildProfile = getFilePlaybackBuildProfile();
const filePlaybackProductRuntime = new FilePlaybackProductRuntime({
  ...(filePlaybackProductBuildProfile.boundedRoutePolicy
    ? { boundedRoutePolicy: filePlaybackProductBuildProfile.boundedRoutePolicy }
    : {}),
});`;
const UNIVERSAL_PROFILE_ID = JSON.stringify(UNIVERSAL_BUILD_PROFILE_EVIDENCE.profileId);
const UNIVERSAL_POLICY_MODE = JSON.stringify(UNIVERSAL_BUILD_PROFILE_EVIDENCE.policyMode);
const UNIVERSAL_SEMANTIC_COHORT_ID = JSON.stringify(
  UNIVERSAL_BUILD_PROFILE_EVIDENCE.semanticPlaybackCohortId,
);
const UNIVERSAL_ARTIFACT_MARKER = JSON.stringify(UNIVERSAL_BUILD_PROFILE_EVIDENCE.artifactMarker);
const UNIVERSAL_SINGLETON = `const universalE2eBuildProfile = getFilePlaybackBuildProfile();
const universalE2eBuildProfileMarker = ${UNIVERSAL_ARTIFACT_MARKER};
if (
  universalE2eBuildProfile.id !== ${UNIVERSAL_PROFILE_ID} ||
  universalE2eBuildProfile.engine !== 'v2' ||
  universalE2eBuildProfile.boundedRouteMode !== ${UNIVERSAL_POLICY_MODE} ||
  universalE2eBuildProfile.boundedRoutePolicy === null ||
  universalE2eBuildProfile.boundedRoutePolicy.mode !== ${UNIVERSAL_POLICY_MODE} ||
  universalE2eBuildProfile.semanticPlaybackCohortId !== ${UNIVERSAL_SEMANTIC_COHORT_ID}
) {
  throw new Error('Universal E2E build profile is not exact');
}
const universalE2eTransportEvents = [];
const summarizeUniversalE2eFrame = (frame) => {
  if (frame === null || typeof frame !== 'object') return { valueType: typeof frame };
  try {
    return Object.freeze({
      type: typeof frame.type === 'string' ? frame.type : null,
      kind: typeof frame.kind === 'string' ? frame.kind : null,
      revision: Number.isSafeInteger(frame.revision) ? frame.revision : null,
      queueItemId: typeof frame.queueItemId === 'string' ? frame.queueItemId : null,
      runId: typeof frame.runId === 'string' ? frame.runId : null,
      rendezvousId: typeof frame.rendezvousId === 'string' ? frame.rendezvousId : null,
      status: typeof frame.status === 'string' ? frame.status : null,
      reasonCode: typeof frame.reasonCode === 'string' ? frame.reasonCode : null,
      backend: typeof frame.backend === 'string' ? frame.backend : null,
      transport: typeof frame.transport === 'string' ? frame.transport : null,
      codec: typeof frame.codec === 'string' ? frame.codec : null,
      manifestByteLength: Number.isSafeInteger(frame.manifestByteLength)
        ? frame.manifestByteLength
        : null,
      controlSequence: Number.isSafeInteger(frame.controlSequence) ? frame.controlSequence : null,
      startAtRoomTimeMs: Number.isFinite(frame.startAtRoomTimeMs)
        ? frame.startAtRoomTimeMs
        : null,
      finalizeByRoomTimeMs: Number.isFinite(frame.finalizeByRoomTimeMs)
        ? frame.finalizeByRoomTimeMs
        : null,
      finalizedAtRoomTimeMs: Number.isFinite(frame.finalizedAtRoomTimeMs)
        ? frame.finalizedAtRoomTimeMs
        : null,
      observedAtRoomTimeMs: Number.isFinite(frame.observedAtRoomTimeMs)
        ? frame.observedAtRoomTimeMs
        : null,
      leaseUntilRoomTimeMs: Number.isFinite(frame.leaseUntilRoomTimeMs)
        ? frame.leaseUntilRoomTimeMs
        : null,
      renderedFrame: Number.isSafeInteger(frame.renderedFrame) ? frame.renderedFrame : null,
    });
  } catch (error) {
    return Object.freeze({ summaryError: error instanceof Error ? error.message : String(error) });
  }
};
const shouldRecordUniversalE2eTransport = (frame) => {
  if (frame === null || typeof frame !== 'object') return true;
  return frame.type !== 'read' && frame.type !== 'chunk';
};
const recordUniversalE2eTransport = (direction, frame) => {
  if (!shouldRecordUniversalE2eTransport(frame)) return;
  universalE2eTransportEvents.push(Object.freeze({
    direction,
    atMonotonicMs: performance.now(),
    frame: summarizeUniversalE2eFrame(frame),
  }));
};
const universalE2eBaseSessions = productionSessionAdapter();
const universalE2eSessions = Object.freeze({
  ...universalE2eBaseSessions,
  sendRequired: (connection, frame) => {
    const sent = universalE2eBaseSessions.sendRequired(connection, frame);
    recordUniversalE2eTransport(sent ? 'required-sent' : 'required-rejected', frame);
    return sent;
  },
  sendWire: (connection, lease, payload) => {
    const sent = universalE2eBaseSessions.sendWire(connection, lease, payload);
    recordUniversalE2eTransport(sent ? 'wire-sent' : 'wire-rejected', sent ?? payload);
    return sent;
  },
  closeConnection: (connection) => {
    recordUniversalE2eTransport('connection-closed', null);
    universalE2eBaseSessions.closeConnection(connection);
  },
});
const filePlaybackProductRuntime = new FilePlaybackProductRuntime({
  boundedRoutePolicy: universalE2eBuildProfile.boundedRoutePolicy,
  sessions: universalE2eSessions,
});

Object.defineProperty(globalThis, '__MUSIXQUARE_FILE_PLAYBACK_E2E__', {
  configurable: false,
  enumerable: false,
  writable: false,
  value: Object.freeze({
    schemaVersion: 1,
    buildProfileMarker: universalE2eBuildProfileMarker,
    profileId: universalE2eBuildProfile.id,
    engine: universalE2eBuildProfile.engine,
    policyMode: universalE2eBuildProfile.boundedRoutePolicy.mode,
    semanticPlaybackCohortId: universalE2eBuildProfile.semanticPlaybackCohortId,
    enabled: () => filePlaybackProductRuntime.enabled(),
    hostRoomSnapshot: () => filePlaybackProductRuntime.hostRoomSnapshot(),
    hostRendererSnapshot: () => filePlaybackProductRuntime.currentHostRendererSnapshot(),
    controllerSnapshot: () => filePlaybackProductRuntime.controller()?.snapshot() ?? null,
    peerRangePhysicalReads: () =>
      UniversalE2ePeerRangeHostResponder.physicalReadDiagnostics(),
    lifecycleDiagnostics: () => getUniversalE2eLifecycleSnapshot(),
    stopProductPlayback: () =>
      filePlaybackProductRuntime.stopCurrent({ signal: new AbortController().signal }),
    endProductRoom: () => filePlaybackProductRuntime.endRoom(),
    injectForcedLifecycleRetirement: () => {
      const retirement = acquireUniversalE2eLifecycleLease('timers').beginRetire();
      retirement.forceUnconfirmed();
      return getUniversalE2eLifecycleSnapshot();
    },
    transportEvents: () => universalE2eTransportEvents.slice(),
  }),
});`;

/**
 * Builds one candidate artifact without adding a runtime switch to the product.
 * Exact matching is intentional: source drift must fail this lane closed instead
 * of silently exercising the production-default policy.
 */
function installUniversalBoundedCandidate(): Plugin {
  let transformedModules = 0;

  return {
    name: 'install-universal-bounded-e2e-candidate',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      if (config.mode !== 'e2e-universal') {
        throw new Error(
          `Universal E2E config requires exact e2e-universal mode, received ${config.mode}`,
        );
      }
    },
    transform(source, rawId) {
      const id = rawId.replace(/\\/g, '/').split('?', 1)[0];
      if (!id?.endsWith(PRODUCT_RUNTIME_MODULE)) return null;

      const occurrences = source.split(PRODUCT_SINGLETON).length - 1;
      if (occurrences !== 1) {
        throw new Error(`Universal E2E expected one product singleton, found ${occurrences}`);
      }
      transformedModules += 1;
      return {
        code: `${PEER_RANGE_DIAGNOSTICS_IMPORT}\n${LIFECYCLE_DIAGNOSTICS_IMPORT}\n${source.replace(PRODUCT_SINGLETON, UNIVERSAL_SINGLETON)}`,
        map: null,
      };
    },
    buildEnd(error) {
      if (!error && transformedModules !== 1) {
        throw new Error(
          `Universal E2E transformed ${transformedModules} product runtime modules; expected exactly one`,
        );
      }
    },
  };
}

export default defineConfig(
  mergeConfig(baseConfig, {
    define: {
      'import.meta.env.VITE_MUSIXQUARE_LEGACY_BOUNDED': JSON.stringify('0'),
      'import.meta.env.VITE_MUSIXQUARE_FILE_ENGINE_V2': JSON.stringify('1'),
      'import.meta.env.VITE_MUSIXQUARE_FILE_ENGINE_UNIVERSAL_V1': JSON.stringify('1'),
      'import.meta.env.VITE_MUSIXQUARE_TEST_HOOKS': JSON.stringify('1'),
    },
    plugins: [installUniversalBoundedCandidate()],
    build: {
      outDir: resolve(__dirname, '../.vite/e2e-universal'),
      emptyOutDir: true,
    },
    preview: {
      host: '127.0.0.1',
      port: 4174,
      strictPort: true,
    },
  }),
);
