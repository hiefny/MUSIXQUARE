import { readdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import {
  LEGACY_CURRENT_BUILD_PROFILE_EVIDENCE,
  UNIVERSAL_BUILD_PROFILE_EVIDENCE,
  V2_CURRENT_BUILD_PROFILE_EVIDENCE,
} from './build-profile-evidence.ts';
import { FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED } from '../../src/player/file-playback-production-release-latch.ts';

const UNIVERSAL_DIR = resolve('.vite/e2e-universal');
const CURRENT_DIR = resolve('.vite/e2e-current');
const PRODUCTION_LATCH_DIR = resolve('.vite/e2e-production-latched');
const LEGACY_BOUNDED_PRODUCTION_DIR = resolve('.vite/e2e-legacy-bounded-production');
const UNIVERSAL_BRIDGE_MARKER = '__MUSIXQUARE_FILE_PLAYBACK_E2E__';
const CURRENT_BRIDGE_MARKER = '__MUSIXQUARE_FILE_PLAYBACK_CURRENT_ISOLATION__';
const PRODUCTION_LATCH_BRIDGE_MARKER = '__MUSIXQUARE_FILE_PLAYBACK_PRODUCTION_LATCH_ISOLATION__';
const LEGACY_BOUNDED_PRODUCTION_ARTIFACT_MARKER =
  '__MXQR_PRODUCTION_LEGACY_BOUNDED_GATE_MATCHES_LATCH_V2_FALSE__';
const expectedCurrentControlProfile = FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED
  ? V2_CURRENT_BUILD_PROFILE_EVIDENCE
  : LEGACY_CURRENT_BUILD_PROFILE_EVIDENCE;
const expectedProductionProfile = FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED
  ? UNIVERSAL_BUILD_PROFILE_EVIDENCE
  : LEGACY_CURRENT_BUILD_PROFILE_EVIDENCE;
const profileEvidence = [
  LEGACY_CURRENT_BUILD_PROFILE_EVIDENCE,
  V2_CURRENT_BUILD_PROFILE_EVIDENCE,
  UNIVERSAL_BUILD_PROFILE_EVIDENCE,
] as const;

function assertExactProfileEvidence(
  artifact: string,
  expected: (typeof profileEvidence)[number],
  label: string,
): void {
  if (!artifact.includes(expected.artifactMarker)) {
    throw new Error(`${label} artifact does not assert its exact profile and cohort`);
  }
  for (const evidence of profileEvidence) {
    if (evidence !== expected && artifact.includes(evidence.artifactMarker)) {
      throw new Error(`${label} artifact leaked ${evidence.profileId} profile evidence`);
    }
  }
}

async function javascriptText(directory: string): Promise<string> {
  const files: string[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (extname(entry.name) === '.js') files.push(child);
    }
  };
  await visit(directory);
  return (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n');
}

const [universal, current, productionLatch, legacyBoundedProduction] = await Promise.all([
  javascriptText(UNIVERSAL_DIR),
  javascriptText(CURRENT_DIR),
  javascriptText(PRODUCTION_LATCH_DIR),
  javascriptText(LEGACY_BOUNDED_PRODUCTION_DIR),
]);

if (!universal.includes(UNIVERSAL_BRIDGE_MARKER)) {
  throw new Error('Universal E2E artifact does not contain its body-free runtime bridge');
}
if (
  universal.includes(CURRENT_BRIDGE_MARKER) ||
  universal.includes(PRODUCTION_LATCH_BRIDGE_MARKER)
) {
  throw new Error('Universal E2E artifact leaked a production control runtime bridge');
}
assertExactProfileEvidence(universal, UNIVERSAL_BUILD_PROFILE_EVIDENCE, 'Universal E2E');

if (!current.includes(CURRENT_BRIDGE_MARKER)) {
  throw new Error('Production-current artifact does not contain its runtime profile bridge');
}
if (current.includes(UNIVERSAL_BRIDGE_MARKER) || current.includes(PRODUCTION_LATCH_BRIDGE_MARKER)) {
  throw new Error('Production-current artifact leaked another build runtime bridge');
}
assertExactProfileEvidence(current, expectedCurrentControlProfile, 'Production-current control');

if (!productionLatch.includes(PRODUCTION_LATCH_BRIDGE_MARKER)) {
  throw new Error('Production-latch artifact does not contain its runtime profile bridge');
}
if (
  productionLatch.includes(UNIVERSAL_BRIDGE_MARKER) ||
  productionLatch.includes(CURRENT_BRIDGE_MARKER)
) {
  throw new Error('Production-latch artifact leaked a control-build runtime bridge');
}
assertExactProfileEvidence(productionLatch, expectedProductionProfile, 'Production-latch');

const boundedMarkerOccurrences =
  legacyBoundedProduction.split(LEGACY_BOUNDED_PRODUCTION_ARTIFACT_MARKER).length - 1;
if (boundedMarkerOccurrences !== 1) {
  throw new Error(
    `Bounded V1 production artifact contains ${boundedMarkerOccurrences} exact gate markers`,
  );
}
if (
  legacyBoundedProduction.includes(UNIVERSAL_BRIDGE_MARKER) ||
  legacyBoundedProduction.includes(CURRENT_BRIDGE_MARKER) ||
  legacyBoundedProduction.includes(PRODUCTION_LATCH_BRIDGE_MARKER)
) {
  throw new Error('Bounded V1 production artifact leaked an old V2 build runtime bridge');
}

process.stdout.write(
  `Universal, production-current-control=${expectedCurrentControlProfile.profileId}, production-latch=${String(FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED)}:${expectedProductionProfile.profileId}, and bounded-V1-production profiles/gates verified.\n`,
);
