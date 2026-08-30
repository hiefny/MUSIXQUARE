import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_LARGE_TRACK_WARNING_BYTES } from '../../core/constants.ts';
import { resetState, setState } from '../../core/state.ts';
import type { QueueItemId } from '../../types/index.ts';
import type { DecodeMemoryEstimate } from '../decode-admission.ts';

const announceSystemMessageLocally = vi.fn();

vi.mock('../../chat/protocol.ts', () => ({
  announceSystemMessageLocally,
}));

const Q0 = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const Q1 = '00000000-0000-4000-8000-000000000002' as QueueItemId;
const MIB = 1024 * 1024;

function riskyIosEstimate(overrides: Partial<DecodeMemoryEstimate> = {}): DecodeMemoryEstimate {
  return {
    durationSeconds: 600,
    probedChannelCount: 2,
    hasReliableMetadata: true,
    channelCount: 2,
    outputSampleRate: 48_000,
    estimatedPcmBytes: 193 * MIB,
    ownDecodeFootprintBytes: 250 * MIB,
    estimatedWorkingSetBytes: 250 * MIB,
    budget: {
      tier: 'ios',
      maxDecodedPcmBytes: Number.MAX_SAFE_INTEGER,
      maxDecodeWorkingSetBytes: Number.MAX_SAFE_INTEGER,
    },
    ...overrides,
  };
}

describe('large local track compatibility warning', () => {
  beforeEach(async () => {
    resetState();
    vi.clearAllMocks();
    const { resetLargeLocalTrackWarningsForTests } =
      await import('../large-local-track-warning.ts');
    resetLargeLocalTrackWarningsForTests();
  });

  it('announces each standard-room queue occurrence once above 200 MiB', async () => {
    const { maybeAnnounceLargeLocalTrackWarning } = await import('../large-local-track-warning.ts');

    expect(maybeAnnounceLargeLocalTrackWarning(Q0, LOCAL_LARGE_TRACK_WARNING_BYTES + 1)).toBe(true);
    expect(maybeAnnounceLargeLocalTrackWarning(Q0, LOCAL_LARGE_TRACK_WARNING_BYTES + 1)).toBe(
      false,
    );
    expect(maybeAnnounceLargeLocalTrackWarning(Q1, LOCAL_LARGE_TRACK_WARNING_BYTES + 1)).toBe(true);

    expect(announceSystemMessageLocally).toHaveBeenCalledTimes(2);
    expect(announceSystemMessageLocally).toHaveBeenCalledWith(
      'chat.large_local_track_system_message',
    );
  });

  it('keeps the exact threshold and smaller files silent', async () => {
    const { maybeAnnounceLargeLocalTrackWarning } = await import('../large-local-track-warning.ts');

    expect(maybeAnnounceLargeLocalTrackWarning(Q0, LOCAL_LARGE_TRACK_WARNING_BYTES)).toBe(false);
    expect(maybeAnnounceLargeLocalTrackWarning(Q1, LOCAL_LARGE_TRACK_WARNING_BYTES - 1)).toBe(
      false,
    );
    expect(announceSystemMessageLocally).not.toHaveBeenCalled();
  });

  it('does not apply the local-file warning to PRO rooms', async () => {
    const { maybeAnnounceLargeLocalTrackWarning } = await import('../large-local-track-warning.ts');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });

    expect(maybeAnnounceLargeLocalTrackWarning(Q0, LOCAL_LARGE_TRACK_WARNING_BYTES + 1)).toBe(
      false,
    );
    expect(announceSystemMessageLocally).not.toHaveBeenCalled();
  });

  it('announces a memory-risk estimate once with projected MiB', async () => {
    const { maybeAnnounceDecodeMemoryRiskWarning } =
      await import('../large-local-track-warning.ts');

    expect(maybeAnnounceDecodeMemoryRiskWarning(Q0, riskyIosEstimate())).toBe(true);
    expect(maybeAnnounceDecodeMemoryRiskWarning(Q0, riskyIosEstimate())).toBe(false);
    expect(announceSystemMessageLocally).toHaveBeenCalledOnce();
    expect(announceSystemMessageLocally).toHaveBeenCalledWith(
      'chat.decode_memory_risk_system_message',
      { estimatedMiB: 250 },
    );
  });

  it('applies device-local memory warnings in PRO rooms', async () => {
    const { maybeAnnounceDecodeMemoryRiskWarning } =
      await import('../large-local-track-warning.ts');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });

    expect(maybeAnnounceDecodeMemoryRiskWarning(Q0, riskyIosEstimate())).toBe(true);
    expect(announceSystemMessageLocally).toHaveBeenCalledWith(
      'chat.decode_memory_risk_system_message',
      { estimatedMiB: 250 },
    );
  });

  it('keeps safe or unreliable estimates silent and shares dedupe with the size fallback', async () => {
    const { maybeAnnounceDecodeMemoryRiskWarning, maybeAnnounceLargeLocalTrackWarning } =
      await import('../large-local-track-warning.ts');

    expect(
      maybeAnnounceDecodeMemoryRiskWarning(Q0, riskyIosEstimate({ estimatedPcmBytes: 100 * MIB })),
    ).toBe(false);
    expect(
      maybeAnnounceDecodeMemoryRiskWarning(Q0, riskyIosEstimate({ hasReliableMetadata: false })),
    ).toBe(false);
    expect(maybeAnnounceLargeLocalTrackWarning(Q0, LOCAL_LARGE_TRACK_WARNING_BYTES + 1)).toBe(true);
    expect(maybeAnnounceDecodeMemoryRiskWarning(Q0, riskyIosEstimate())).toBe(false);
    expect(announceSystemMessageLocally).toHaveBeenCalledOnce();
  });

  it('allows the same occurrence to be warned again in a new room session', async () => {
    const { maybeAnnounceLargeLocalTrackWarning } = await import('../large-local-track-warning.ts');

    maybeAnnounceLargeLocalTrackWarning(Q0, LOCAL_LARGE_TRACK_WARNING_BYTES + 1);
    setState('setup.sessionStarted', true);
    maybeAnnounceLargeLocalTrackWarning(Q0, LOCAL_LARGE_TRACK_WARNING_BYTES + 1);

    expect(announceSystemMessageLocally).toHaveBeenCalledTimes(2);
  });
});
