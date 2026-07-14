import type { Plugin } from 'vite';

const PRODUCT_RUNTIME_MODULE = '/src/player/file-playback-product-runtime.ts';
const PRODUCT_SINGLETON = `const filePlaybackProductBuildProfile = getFilePlaybackBuildProfile();
const filePlaybackProductRuntime = new FilePlaybackProductRuntime({
  ...(filePlaybackProductBuildProfile.boundedRoutePolicy
    ? { boundedRoutePolicy: filePlaybackProductBuildProfile.boundedRoutePolicy }
    : {}),
});`;

interface ProductionBuildProfileEvidencePluginOptions {
  readonly label: string;
  readonly bridgeMarker: string;
  readonly evidence: Readonly<{
    readonly profileId: string;
    readonly engine: 'legacy' | 'v2';
    readonly policyMode: string;
    readonly hasBoundedRoutePolicy: boolean;
    readonly semanticPlaybackCohortId: string;
    readonly artifactMarker: string;
  }>;
}

/** Injects an E2E-only fail-closed assertion into one production-mode control artifact. */
export function installProductionBuildProfileEvidence(
  options: Readonly<ProductionBuildProfileEvidencePluginOptions>,
): Plugin {
  const label = JSON.stringify(options.label);
  const bridgeMarker = JSON.stringify(options.bridgeMarker);
  const profileId = JSON.stringify(options.evidence.profileId);
  const engine = JSON.stringify(options.evidence.engine);
  const policyMode = JSON.stringify(options.evidence.policyMode);
  const hasBoundedRoutePolicy = JSON.stringify(options.evidence.hasBoundedRoutePolicy);
  const semanticPlaybackCohortId = JSON.stringify(options.evidence.semanticPlaybackCohortId);
  const artifactMarker = JSON.stringify(options.evidence.artifactMarker);
  const replacement = `const productionEvidenceBuildProfile = getFilePlaybackBuildProfile();
const productionEvidenceBuildProfileMarker = ${artifactMarker};
const productionEvidenceHasBoundedRoutePolicy =
  productionEvidenceBuildProfile.boundedRoutePolicy !== null;
if (
  productionEvidenceBuildProfile.id !== ${profileId} ||
  productionEvidenceBuildProfile.engine !== ${engine} ||
  productionEvidenceBuildProfile.boundedRouteMode !== ${policyMode} ||
  productionEvidenceHasBoundedRoutePolicy !== ${hasBoundedRoutePolicy} ||
  (productionEvidenceBuildProfile.boundedRoutePolicy !== null &&
    productionEvidenceBuildProfile.boundedRoutePolicy.mode !== ${policyMode}) ||
  productionEvidenceBuildProfile.semanticPlaybackCohortId !== ${semanticPlaybackCohortId}
) {
  throw new Error(${label} + ' build profile is not exact');
}
const filePlaybackProductRuntime = new FilePlaybackProductRuntime({
  ...(productionEvidenceBuildProfile.boundedRoutePolicy
    ? { boundedRoutePolicy: productionEvidenceBuildProfile.boundedRoutePolicy }
    : {}),
});
Object.defineProperty(globalThis, ${bridgeMarker}, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: Object.freeze({
    schemaVersion: 1,
    buildProfileMarker: productionEvidenceBuildProfileMarker,
    profileId: productionEvidenceBuildProfile.id,
    engine: productionEvidenceBuildProfile.engine,
    policyMode: productionEvidenceBuildProfile.boundedRouteMode,
    semanticPlaybackCohortId: productionEvidenceBuildProfile.semanticPlaybackCohortId,
    enabled: filePlaybackProductRuntime.enabled(),
  }),
});`;
  let transformedModules = 0;

  return {
    name: `install-${options.label}-build-profile-evidence`,
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      if (config.mode !== 'production') {
        throw new Error(
          `${options.label} evidence requires exact production mode, received ${config.mode}`,
        );
      }
    },
    transform(source, rawId) {
      const id = rawId.replace(/\\/g, '/').split('?', 1)[0];
      if (!id?.endsWith(PRODUCT_RUNTIME_MODULE)) return null;

      const occurrences = source.split(PRODUCT_SINGLETON).length - 1;
      if (occurrences !== 1) {
        throw new Error(`${options.label} expected one product singleton, found ${occurrences}`);
      }
      transformedModules += 1;
      return {
        code: source.replace(PRODUCT_SINGLETON, replacement),
        map: null,
      };
    },
    buildEnd(error) {
      if (!error && transformedModules !== 1) {
        throw new Error(
          `${options.label} transformed ${transformedModules} product runtime modules; expected exactly one`,
        );
      }
    },
  };
}
