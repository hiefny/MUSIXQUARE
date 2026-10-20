interface BackgroundResumeRecovery<PeerRecovery, AudioRecovery> {
  readonly peer: PeerRecovery;
  /** Null when audio recovery threw before reporting an outcome. */
  readonly audio: AudioRecovery | null;
}

interface BackgroundResumeRecoveryDeps<PeerRecovery, AudioRecovery> {
  recoverPeer: (hiddenMs: number) => PeerRecovery;
  reacquireWakeLock: () => void;
  recoverAudio: () => Promise<AudioRecovery>;
  /**
   * The return's Sync-button-equivalent step. It runs after every recovery,
   * including one whose audio stage failed, and decides from both outcomes
   * which room alignment still belongs to it.
   */
  syncRoom: (
    recovery: BackgroundResumeRecovery<PeerRecovery, AudioRecovery>,
  ) => void | Promise<void>;
  onAudioRecoveryError?: (error: unknown) => void;
}

/**
 * Preserve the foreground recovery order while isolating browser-owned audio
 * failures from the background-return Sync that follows them.
 */
export async function runBackgroundResumeRecovery<PeerRecovery, AudioRecovery>(
  hiddenMs: number,
  deps: BackgroundResumeRecoveryDeps<PeerRecovery, AudioRecovery>,
): Promise<void> {
  const peer = deps.recoverPeer(hiddenMs);
  deps.reacquireWakeLock();

  let audio: AudioRecovery | null = null;
  try {
    audio = await deps.recoverAudio();
  } catch (error) {
    deps.onAudioRecoveryError?.(error);
  }

  await deps.syncRoom({ peer, audio });
}
