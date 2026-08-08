import type { ProRoomSystemAudioState } from './contracts.ts';
import type { ProRoomSystemAudioViewState } from './system-audio-controller.ts';

interface ProSystemAudioBridgeAdapter {
  acquire(signal?: AbortSignal): Promise<ProRoomSystemAudioState>;
  publish(
    leftTrack: MediaStreamTrack,
    rightTrack: MediaStreamTrack,
  ): Promise<ProRoomSystemAudioState>;
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
  acquire: () => Promise.reject(new Error('PRO_SYSTEM_AUDIO_NOT_CONFIGURED')),
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

export function acquireLocalProSystemAudioLease(
  signal?: AbortSignal,
): Promise<ProRoomSystemAudioState> {
  return adapter.acquire(signal);
}

export function publishLocalProSystemAudio(
  leftTrack: MediaStreamTrack,
  rightTrack: MediaStreamTrack,
): Promise<ProRoomSystemAudioState> {
  return adapter.publish(leftTrack, rightTrack);
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
