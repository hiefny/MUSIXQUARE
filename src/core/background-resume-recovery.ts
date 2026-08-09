interface BackgroundResumeRecoveryDeps<PeerRecovery> {
  recoverPeer: (hiddenMs: number) => PeerRecovery;
  reacquireWakeLock: () => void;
  recoverAudio: () => Promise<void>;
  shouldRecoverRoom: (peerRecovery: PeerRecovery) => boolean;
  recoverRoom: (peerRecovery: PeerRecovery) => void | Promise<void>;
  onAudioRecoveryError?: (error: unknown) => void;
}

/**
 * Preserve the foreground recovery order while isolating browser-owned audio
 * failures from the independent room rendezvous that follows them.
 */
export async function runBackgroundResumeRecovery<PeerRecovery>(
  hiddenMs: number,
  deps: BackgroundResumeRecoveryDeps<PeerRecovery>,
): Promise<void> {
  const peerRecovery = deps.recoverPeer(hiddenMs);
  deps.reacquireWakeLock();

  try {
    await deps.recoverAudio();
  } catch (error) {
    deps.onAudioRecoveryError?.(error);
  }

  if (!deps.shouldRecoverRoom(peerRecovery)) return;
  await deps.recoverRoom(peerRecovery);
}
