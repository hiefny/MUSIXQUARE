import { describe, expect, it, vi } from 'vitest';
import { runBackgroundResumeRecovery } from '../background-resume-recovery.ts';

describe('runBackgroundResumeRecovery', () => {
  it('continues one standard-room sync after audio recovery rejects', async () => {
    const order: string[] = [];
    const audioError = new Error('AudioContext resume denied');
    const recoverRoom = vi.fn(() => {
      order.push('room');
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
      recoverAudio: async () => {
        order.push('audio');
        throw audioError;
      },
      shouldRecoverRoom: (peerRecovery) => peerRecovery.status === 'not-applicable',
      recoverRoom,
      onAudioRecoveryError,
    });

    expect(order).toEqual(['peer:4000', 'wake-lock', 'audio', 'room']);
    expect(onAudioRecoveryError).toHaveBeenCalledOnce();
    expect(onAudioRecoveryError).toHaveBeenCalledWith(audioError);
    expect(recoverRoom).toHaveBeenCalledOnce();
  });

  it('keeps the PRO/peer-owned branch suppressed after audio recovery rejects', async () => {
    const recoverRoom = vi.fn();

    await runBackgroundResumeRecovery(4_000, {
      recoverPeer: () => ({ status: 'probing' as const }),
      reacquireWakeLock: vi.fn(),
      recoverAudio: async () => {
        throw new Error('resume denied');
      },
      shouldRecoverRoom: () => false,
      recoverRoom,
    });

    expect(recoverRoom).not.toHaveBeenCalled();
  });
});
