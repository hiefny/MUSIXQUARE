import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetLease,
  type FilePlaybackAssetSnapshot,
} from '../file-playback-asset-registry.ts';
import {
  copyCodecTimelineHostArtifactManifest,
  type CodecTimelineHostArtifact,
  type CodecTimelineHostArtifactBinding,
} from './codec-timeline-host-artifact.ts';
import { CODEC_TIMELINE_MANIFEST_MAX_BYTES } from './codec-timeline-manifest.ts';

const INSTALL_KEYS = Object.freeze(['registry', 'roomToken', 'lease', 'artifact'] as const);
const LEASE_ACCESS_KEYS = Object.freeze(['registry', 'roomToken', 'lease'] as const);
const REGISTRY_PROTOTYPE = FilePlaybackAssetRegistry.prototype;
const SNAPSHOT_FOR_LEASE = REGISTRY_PROTOTYPE.snapshotForLease;
const uint8ArrayFill = Uint8Array.prototype.fill;

type ExactRecord = Readonly<Record<string, unknown>>;

export interface CodecTimelineHostArtifactLeaseDiagnostics {
  readonly codec: Readonly<CodecTimelineHostArtifact>['codec'];
  readonly manifestByteLength: number;
  readonly manifestSha256B64: string;
}

interface ArtifactClaim {
  readonly registry: FilePlaybackAssetRegistry;
  readonly lease: FilePlaybackAssetLease;
}

interface LeaseClaim {
  readonly registry: FilePlaybackAssetRegistry;
  readonly artifact: Readonly<CodecTimelineHostArtifact>;
}

interface LiveAssociation extends ArtifactClaim, LeaseClaim {
  readonly roomToken: object;
  readonly binding: Readonly<CodecTimelineHostArtifactBinding>;
}

/**
 * Store-local authority failure. The asset registry remains the only owner of
 * asset lifecycle; this module never promotes, acquires, discards, or retires.
 */
export class CodecTimelineHostArtifactLeaseStoreError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CodecTimelineHostArtifactLeaseStoreError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

const ASSOCIATIONS_BY_REGISTRY = new WeakMap<
  FilePlaybackAssetRegistry,
  WeakMap<FilePlaybackAssetLease, LiveAssociation>
>();

// Claims intentionally outlive a live association. In particular, a manifest
// issued for a discarded provisional lease must never be rebound to a later
// lease whose public diagnostics happen to be identical.
const ARTIFACT_CLAIMS = new WeakMap<object, ArtifactClaim>();
const LEASE_CLAIMS = new WeakMap<object, LeaseClaim>();
const TERMINAL_ARTIFACT_CLAIMS = new WeakSet<object>();
const TERMINAL_LEASE_CLAIMS = new WeakSet<object>();

function fail(message: string, cause?: unknown): never {
  throw new CodecTimelineHostArtifactLeaseStoreError(message, cause);
}

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): ExactRecord {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail(`${label} must be an exact data record`);
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail(`${label} must have a plain or null prototype`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set(expectedKeys);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return fail(`${label} fields are not exact`);
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        return fail(`${label} field ${key} must be enumerable data`);
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof CodecTimelineHostArtifactLeaseStoreError) throw error;
    return fail(`${label} could not be inspected`, error);
  }
}

function exactRegistry(value: unknown): FilePlaybackAssetRegistry {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      Reflect.getPrototypeOf(value) !== REGISTRY_PROTOTYPE
    ) {
      return fail('Host artifact lease registry is not an exact FilePlaybackAssetRegistry');
    }
    return value as FilePlaybackAssetRegistry;
  } catch (error) {
    if (error instanceof CodecTimelineHostArtifactLeaseStoreError) throw error;
    return fail('Host artifact lease registry could not be inspected', error);
  }
}

function objectAuthority<T extends object>(value: unknown, label: string): T {
  if (value === null || typeof value !== 'object') {
    return fail(`${label} must be an opaque object authority`);
  }
  return value as T;
}

function liveSnapshot(
  registry: FilePlaybackAssetRegistry,
  roomToken: object,
  lease: FilePlaybackAssetLease,
): Readonly<FilePlaybackAssetSnapshot> | null {
  try {
    return SNAPSHOT_FOR_LEASE.call(registry, roomToken, lease);
  } catch (error) {
    return fail('Host artifact lease snapshot failed closed', error);
  }
}

function bindingFromSnapshot(
  snapshot: Readonly<FilePlaybackAssetSnapshot>,
): Readonly<CodecTimelineHostArtifactBinding> {
  return Object.freeze(
    Object.assign(Object.create(null), {
      queueItemId: snapshot.queueItemId,
      sourceIdentity: snapshot.sourceIdentity,
      transferSessionId: snapshot.transferSessionId,
      encodedSize: snapshot.size,
      name: snapshot.name,
      mime: snapshot.mime,
    }),
  ) as Readonly<CodecTimelineHostArtifactBinding>;
}

function sameBinding(
  left: Readonly<CodecTimelineHostArtifactBinding>,
  right: Readonly<CodecTimelineHostArtifactBinding>,
): boolean {
  return (
    left.queueItemId === right.queueItemId &&
    left.sourceIdentity === right.sourceIdentity &&
    left.transferSessionId === right.transferSessionId &&
    left.encodedSize === right.encodedSize &&
    left.name === right.name &&
    left.mime === right.mime
  );
}

function authenticateArtifact(
  artifact: Readonly<CodecTimelineHostArtifact>,
  binding: Readonly<CodecTimelineHostArtifactBinding>,
): void {
  let authenticationCopy: Uint8Array | null = null;
  try {
    authenticationCopy = copyCodecTimelineHostArtifactManifest({ artifact, binding });
    if (
      authenticationCopy.byteLength === 0 ||
      authenticationCopy.byteLength > CODEC_TIMELINE_MANIFEST_MAX_BYTES
    ) {
      return fail('Host artifact authentication body is outside the manifest bound');
    }
  } finally {
    if (authenticationCopy) uint8ArrayFill.call(authenticationCopy, 0);
  }
}

function registryAssociations(
  registry: FilePlaybackAssetRegistry,
): WeakMap<FilePlaybackAssetLease, LiveAssociation> {
  const existing = ASSOCIATIONS_BY_REGISTRY.get(registry);
  if (existing) return existing;
  const created = new WeakMap<FilePlaybackAssetLease, LiveAssociation>();
  ASSOCIATIONS_BY_REGISTRY.set(registry, created);
  return created;
}

function dropLiveAssociation(association: LiveAssociation): void {
  const associations = ASSOCIATIONS_BY_REGISTRY.get(association.registry);
  if (associations?.get(association.lease) === association) {
    associations.delete(association.lease);
  }
  if (ARTIFACT_CLAIMS.get(association.artifact) === association) {
    ARTIFACT_CLAIMS.delete(association.artifact);
  }
  if (LEASE_CLAIMS.get(association.lease) === association) {
    LEASE_CLAIMS.delete(association.lease);
  }
  // Terminal weak membership preserves the ABA fence without retaining the
  // counterpart, registry, room token, or manifest body through a stale key.
  TERMINAL_ARTIFACT_CLAIMS.add(association.artifact);
  TERMINAL_LEASE_CLAIMS.add(association.lease);
}

/**
 * Authenticate and install one reusable, body-free host artifact for one exact
 * registry lease. Replaying the exact tuple is idempotent; neither the artifact
 * nor the lease may be rebound to a different authority later.
 */
export function installCodecTimelineHostArtifactForLease(optionsValue: unknown): void {
  const options = snapshotExactDataRecord(
    optionsValue,
    INSTALL_KEYS,
    'Host artifact lease install options',
  );
  const registry = exactRegistry(options.registry);
  const roomToken = objectAuthority<object>(options.roomToken, 'Host artifact room token');
  const lease = objectAuthority<FilePlaybackAssetLease>(options.lease, 'Host artifact asset lease');
  const artifact = objectAuthority<Readonly<CodecTimelineHostArtifact>>(
    options.artifact,
    'Host artifact',
  );
  const snapshot = liveSnapshot(registry, roomToken, lease);
  if (!snapshot) return fail('Host artifact asset lease is forged, foreign, or stale');
  const binding = bindingFromSnapshot(snapshot);

  if (TERMINAL_ARTIFACT_CLAIMS.has(artifact)) {
    return fail('Host artifact claim is no longer live');
  }
  if (TERMINAL_LEASE_CLAIMS.has(lease)) {
    return fail('Host artifact lease claim is no longer live');
  }

  const artifactClaim = ARTIFACT_CLAIMS.get(artifact);
  if (artifactClaim && (artifactClaim.registry !== registry || artifactClaim.lease !== lease)) {
    return fail('Host artifact is already claimed by another exact registry lease');
  }
  const leaseClaim = LEASE_CLAIMS.get(lease);
  if (leaseClaim && (leaseClaim.registry !== registry || leaseClaim.artifact !== artifact)) {
    return fail('Host artifact lease is already claimed by another exact artifact');
  }

  const associations = registryAssociations(registry);
  const existing = associations.get(lease);
  if (existing) {
    if (
      existing.artifact !== artifact ||
      existing.roomToken !== roomToken ||
      !sameBinding(existing.binding, binding)
    ) {
      return fail('Host artifact lease association is inconsistent');
    }
    return;
  }
  if (artifactClaim || leaseClaim) {
    return fail('Host artifact lease claim is no longer live');
  }

  // copyCodecTimelineHostArtifactManifest is the artifact module's private-map
  // authenticator. Its bounded disposable copy is scrubbed before publication.
  authenticateArtifact(artifact, binding);

  const association = Object.freeze({
    registry,
    roomToken,
    lease,
    artifact,
    binding,
  }) satisfies LiveAssociation;
  ARTIFACT_CLAIMS.set(artifact, association);
  LEASE_CLAIMS.set(lease, association);
  associations.set(lease, association);
}

function liveAssociationForAccess(optionsValue: unknown, label: string): LiveAssociation | null {
  const options = snapshotExactDataRecord(optionsValue, LEASE_ACCESS_KEYS, label);
  const registry = exactRegistry(options.registry);
  const roomToken = objectAuthority<object>(options.roomToken, 'Host artifact room token');
  const lease = objectAuthority<FilePlaybackAssetLease>(options.lease, 'Host artifact asset lease');
  const association = ASSOCIATIONS_BY_REGISTRY.get(registry)?.get(lease);
  if (!association) return null;

  // A wrong token must fail closed without erasing the live owner's binding.
  if (association.roomToken !== roomToken) return null;
  const snapshot = liveSnapshot(registry, roomToken, lease);
  if (!snapshot || !sameBinding(association.binding, bindingFromSnapshot(snapshot))) {
    dropLiveAssociation(association);
    return null;
  }
  return association;
}

/**
 * Explicitly terminalize an installed association at the registry lifecycle
 * boundary. Callers must invoke this repeat-safe operation when the owning
 * lease is discarded, retired, or its room closes; it also works after the
 * registry transition because exact object identity was captured at install.
 */
export function revokeCodecTimelineHostArtifactForLease(optionsValue: unknown): boolean {
  const options = snapshotExactDataRecord(
    optionsValue,
    LEASE_ACCESS_KEYS,
    'Host artifact lease revoke options',
  );
  const registry = exactRegistry(options.registry);
  const roomToken = objectAuthority<object>(options.roomToken, 'Host artifact room token');
  const lease = objectAuthority<FilePlaybackAssetLease>(options.lease, 'Host artifact asset lease');
  const association = ASSOCIATIONS_BY_REGISTRY.get(registry)?.get(lease);
  if (!association || association.roomToken !== roomToken) return false;
  dropLiveAssociation(association);
  return true;
}

/**
 * Return detached, body-free diagnostics only while the exact installed lease
 * remains live or provisional. The opaque artifact authority never escapes.
 */
export function describeCodecTimelineHostArtifactForLease(
  optionsValue: unknown,
): Readonly<CodecTimelineHostArtifactLeaseDiagnostics> | null {
  const association = liveAssociationForAccess(
    optionsValue,
    'Host artifact lease describe options',
  );
  if (!association) return null;
  return Object.freeze(
    Object.assign(Object.create(null), {
      codec: association.artifact.codec,
      manifestByteLength: association.artifact.manifestByteLength,
      manifestSha256B64: association.artifact.manifestSha256B64,
    }),
  ) as Readonly<CodecTimelineHostArtifactLeaseDiagnostics>;
}

/**
 * Revalidate the exact registry lease and synchronously copy one manifest body.
 * Callers may not retain a reusable artifact authority across lease retirement.
 */
export function copyCodecTimelineHostArtifactManifestForLease(
  optionsValue: unknown,
): Uint8Array | null {
  const association = liveAssociationForAccess(optionsValue, 'Host artifact lease copy options');
  if (!association) return null;
  try {
    return copyCodecTimelineHostArtifactManifest({
      artifact: association.artifact,
      binding: association.binding,
    });
  } catch (error) {
    return fail('Host artifact manifest copy failed closed', error);
  }
}
