import type { ProRoomSystemAudioState } from './contracts.ts';
import type { ProRoomSystemAudioViewState } from './system-audio-controller.ts';

/**
 * Opaque ownership for one capture-start lease request. Async rollback may
 * release only through this handle; active capture stop keeps the explicit
 * current-owner release below so publisher recovery can rotate generations.
 */
export interface ProSystemAudioLeaseAttempt {
  readonly result: Promise<ProRoomSystemAudioState>;
  releaseIfCurrent(): Promise<ProRoomSystemAudioState | null>;
}

interface ProSystemAudioBridgeAdapter {
  beginLeaseAttempt(signal?: AbortSignal): ProSystemAudioLeaseAttempt;
  publish(track: MediaStreamTrack): Promise<ProRoomSystemAudioState>;
  release(): Promise<ProRoomSystemAudioState | null>;
  view(): ProRoomSystemAudioViewState;
  ownerDisplayName(): string | null;
  isLocalOwner(): boolean;
  coordinatorSupportsPublishing(): boolean;
}

const unavailableView = (): ProRoomSystemAudioViewState => ({
  roomCode: null,
  initialized: false,
  phase: 'idle',
  generation: null,
  ownerParticipantId: null,
  isLocalOwner: false,
  localRequestPending: false,
  canStart: false,
  canStop: false,
  claimExpiresAt: null,
  liveExpiresAt: null,
  publication: null,
});

let adapter: ProSystemAudioBridgeAdapter = {
  beginLeaseAttempt: () => ({
    result: Promise.reject(new Error('PRO_SYSTEM_AUDIO_NOT_CONFIGURED')),
    releaseIfCurrent: () => Promise.resolve(null),
  }),
  publish: () => Promise.reject(new Error('PRO_SYSTEM_AUDIO_NOT_CONFIGURED')),
  release: () => Promise.resolve(null),
  view: unavailableView,
  ownerDisplayName: () => null,
  isLocalOwner: () => false,
  coordinatorSupportsPublishing: () => false,
};

/**
 * Installs the authenticated implementation without making the low-level
 * capture graph import the PRO runtime (which would create an audio cycle).
 */
export function configureProSystemAudioBridge(next: ProSystemAudioBridgeAdapter): void {
  adapter = next;
}

export function beginLocalProSystemAudioLeaseAttempt(
  signal?: AbortSignal,
): ProSystemAudioLeaseAttempt {
  return adapter.beginLeaseAttempt(signal);
}

export function publishLocalProSystemAudio(
  track: MediaStreamTrack,
): Promise<ProRoomSystemAudioState> {
  return adapter.publish(track);
}

export function releaseLocalProSystemAudioLease(): Promise<ProRoomSystemAudioState | null> {
  return adapter.release();
}

export function getProSystemAudioViewState(): ProRoomSystemAudioViewState {
  return adapter.view();
}

export function getProSystemAudioOwnerDisplayName(): string | null {
  return adapter.ownerDisplayName();
}

export function isLocalProSystemAudioOwner(): boolean {
  return adapter.isLocalOwner();
}

/**
 * Whether this participant currently has the server-issued playback authority
 * required to publish. PRO rooms have no browser coordinator; the adapter
 * derives this answer from the authenticated viewer projection.
 */
export function canPublishProSystemAudioWithCurrentCoordinator(): boolean {
  return adapter.coordinatorSupportsPublishing();
}
