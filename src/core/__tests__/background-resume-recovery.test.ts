import { describe, expect, it, vi } from 'vitest';
import { runBackgroundResumeRecovery } from '../background-resume-recovery.ts';

describe('runBackgroundResumeRecovery', () => {
  it('runs the background-return sync once after audio recovery rejects', async () => {
    const order: string[] = [];
    const audioError = new Error('AudioContext resume denied');
    const syncRoom = vi.fn((recovery: { peer: unknown; audio: boolean | null }) => {
      order.push('sync');
      expect(recovery).toEqual({ peer: { status: 'not-applicable' }, audio: null });
    });
    const onAudioRecoveryError = vi.fn();

    await runBackgroundResumeRecovery(4_000, {
      recoverPeer: (hiddenMs) => {
        order.push(`peer:${hiddenMs}`);
        return { status: 'not-applicable' as const };
      },
      reacquireWakeLock: () => {
        order.push('wake-lock');
      },
      recoverAudio: async (): Promise<boolean> => {
        order.push('audio');
        throw audioError;
      },
      syncRoom,
      onAudioRecoveryError,
    });

    expect(order).toEqual(['peer:4000', 'wake-lock', 'audio', 'sync']);
    expect(onAudioRecoveryError).toHaveBeenCalledOnce();
    expect(onAudioRecoveryError).toHaveBeenCalledWith(audioError);
    expect(syncRoom).toHaveBeenCalledOnce();
  });

  it('hands the sync step both the peer probe and the audio ownership outcome', async () => {
    const syncRoom = vi.fn();

    await runBackgroundResumeRecovery(20_000, {
      recoverPeer: () => ({ status: 'monitoring' as const }),
      reacquireWakeLock: vi.fn(),
      recoverAudio: async () => true,
      syncRoom,
    });

    // A probing connection no longer suppresses the step; it decides per room.
    expect(syncRoom).toHaveBeenCalledOnce();
    expect(syncRoom).toHaveBeenCalledWith({ peer: { status: 'monitoring' }, audio: true });
  });

  it('waits for audio recovery (for example a gesture dialog) before syncing', async () => {
    let releaseAudio!: (owned: boolean) => void;
    const syncRoom = vi.fn();
    const recovery = runBackgroundResumeRecovery(4_000, {
      recoverPeer: () => ({ status: 'not-applicable' as const }),
      reacquireWakeLock: vi.fn(),
      recoverAudio: () =>
        new Promise<boolean>((resolve) => {
          releaseAudio = resolve;
        }),
      syncRoom,
    });

    await Promise.resolve();
    expect(syncRoom).not.toHaveBeenCalled();
    releaseAudio(true);
    await recovery;
    expect(syncRoom).toHaveBeenCalledWith({ peer: { status: 'not-applicable' }, audio: true });
  });
});
