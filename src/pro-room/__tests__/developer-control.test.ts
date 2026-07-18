import { describe, expect, it, vi } from 'vitest';
import type {
  DeveloperCommandFrame,
  DeveloperCommandResultCode,
} from '../../network/transport/types.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { DeveloperControlExecutor } from '../developer-control.ts';

const CURRENT_QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_QUEUE_ITEM_ID = '22222222-2222-4222-8222-222222222222';

function snapshot(): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: '000001',
    status: 'active',
    runtime: 'awake',
    revision: 10,
    playlistRevision: 4,
    playlist: [
      {
        queueItemId: CURRENT_QUEUE_ITEM_ID,
        name: 'Current',
        source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      },
      {
        queueItemId: OTHER_QUEUE_ITEM_ID,
        name: 'Other',
        source: { kind: 'youtube', videoId: '9bZkp7q19f0' },
      },
    ],
    currentQueueItemId: CURRENT_QUEUE_ITEM_ID,
    playback: {
      coordinatorEpoch: 3,
      revision: 9,
      state: 'paused',
      queueItemId: CURRENT_QUEUE_ITEM_ID,
      positionSeconds: 12,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
      updatedAtMs: 1_800_000_000_000,
    },
    presence: {
      coordinatorEpoch: 3,
      revision: 5,
      coordinatorParticipantId: 'participant_00001',
      participants: [
        {
          participantId: 'participant_00001',
          displayName: 'Owner',
          role: 'owner',
          joinedAtMs: 1_800_000_000_000,
        },
      ],
    },
    quota: {
      limitBytes: PRO_ROOM_QUOTA_BYTES,
      perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
      usedBytes: 0,
      reservedBytes: 0,
    },
    viewer: {
      memberId: 'member_0000000001',
      participantId: 'participant_00001',
      presenceIncarnationId: 'presence_0000000001',
      displayName: 'Owner',
      role: 'owner',
      capabilities: [
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'coordinator.eligible',
        'members.manage',
        'room.configure',
      ],
      coordinatorEligible: true,
    },
  };
}

function frame(
  command: DeveloperCommandFrame['command'] = { type: 'play' },
  commandId = 'cmd_1234567890123456789012',
): DeveloperCommandFrame {
  return {
    type: 'developer-command',
    version: command.type === 'next' ? 3 : command.type === 'set_effects' ? 2 : 1,
    roomCode: '000001',
    coordinatorEpoch: 3,
    commandId,
    expiresAtMs: 1_900_000_000_000,
    expected: {
      queueItemId: CURRENT_QUEUE_ITEM_ID,
      playlistRevision: 4,
      playbackRevision: 9,
    },
    command,
  };
}

function fixtures(
  options: {
    snapshot?: ProRoomSnapshot | null;
    active?: boolean;
    coordinator?: boolean;
    result?: Exclude<DeveloperCommandResultCode, 'already_applied' | 'expired'>;
    dedupeCapacity?: number;
    refreshedSnapshot?: ProRoomSnapshot | null;
  } = {},
) {
  let currentSnapshot = options.snapshot === undefined ? snapshot() : options.snapshot;
  let now = 1_800_000_000_000;
  const execute = vi.fn(async () => options.result ?? ('applied' as const));
  const acknowledge = vi.fn(async () => undefined);
  const refreshSnapshot = vi.fn(async () => {
    currentSnapshot = options.refreshedSnapshot ?? currentSnapshot;
    return currentSnapshot;
  });
  const dependencies: ConstructorParameters<typeof DeveloperControlExecutor>[0] = {
    now: () => now,
    isActive: () => options.active ?? true,
    isCoordinator: () => options.coordinator ?? true,
    snapshot: () => currentSnapshot,
    refreshSnapshot,
    execute,
    acknowledge,
  };
  const executor = new DeveloperControlExecutor(dependencies, {
    dedupeCapacity: options.dedupeCapacity,
  });
  return {
    executor,
    execute,
    acknowledge,
    refreshSnapshot,
    setNow: (value: number) => {
      now = value;
    },
    setSnapshot: (value: ProRoomSnapshot | null) => {
      currentSnapshot = value;
    },
  };
}

describe('PRO developer command executor', () => {
  it.each([
    { type: 'play' } as const,
    { type: 'pause' } as const,
    { type: 'next' } as const,
    { type: 'seek', positionSeconds: 25.5 } as const,
    { type: 'play_item', queueItemId: OTHER_QUEUE_ITEM_ID } as const,
  ])('executes one fenced $type command and ACKs applied', async (command) => {
    const f = fixtures();
    const commandFrame = frame(command);

    await f.executor.handle(commandFrame);

    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledWith(
      command,
      expect.objectContaining({ roomCode: '000001' }),
    );
    expect(f.acknowledge).toHaveBeenCalledWith(commandFrame, 'applied');
  });

  it('fences set_effects only to the room and coordinator epoch, not playlist churn', async () => {
    const f = fixtures();
    const commandFrame = frame({
      type: 'set_effects',
      effects: { virtualBass: { strengthPercent: 60 } },
    });
    commandFrame.expected = {
      queueItemId: OTHER_QUEUE_ITEM_ID,
      playlistRevision: 999,
      playbackRevision: 999,
    };

    await f.executor.handle(commandFrame);

    expect(f.refreshSnapshot).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledWith(commandFrame.command, expect.any(Object));
    expect(f.acknowledge).toHaveBeenCalledWith(commandFrame, 'applied');
  });

  it('rejects expired commands before reading or executing media state', async () => {
    const f = fixtures();
    f.setNow(1_900_000_000_000);
    const commandFrame = frame();

    await f.executor.handle(commandFrame);

    expect(f.execute).not.toHaveBeenCalled();
    expect(f.acknowledge).toHaveBeenCalledWith(commandFrame, 'expired');
  });

  it.each([
    ['inactive runtime', { active: false }],
    ['non-coordinator runtime', { coordinator: false }],
    ['missing snapshot', { snapshot: null }],
  ] as const)('leaves a transiently unavailable %s unacknowledged', async (_label, options) => {
    const f = fixtures(options);
    const commandFrame = frame();
    await f.executor.handle(commandFrame);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.acknowledge).not.toHaveBeenCalled();
  });

  it.each([
    ['room', (value: DeveloperCommandFrame) => ({ ...value, roomCode: '000000' })],
    ['epoch', (value: DeveloperCommandFrame) => ({ ...value, coordinatorEpoch: 4 })],
    [
      'selected item',
      (value: DeveloperCommandFrame) => ({
        ...value,
        expected: { ...value.expected, queueItemId: OTHER_QUEUE_ITEM_ID },
      }),
    ],
    [
      'playlist revision',
      (value: DeveloperCommandFrame) => ({
        ...value,
        expected: { ...value.expected, playlistRevision: 5 },
      }),
    ],
    [
      'playback revision',
      (value: DeveloperCommandFrame) => ({
        ...value,
        expected: { ...value.expected, playbackRevision: 10 },
      }),
    ],
  ])('rejects a mismatched %s fence', async (_label, mutate) => {
    const f = fixtures();
    const commandFrame = mutate(frame()) as DeveloperCommandFrame;
    await f.executor.handle(commandFrame);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.acknowledge).toHaveBeenCalledWith(commandFrame, 'stale_queue');
  });

  it('refreshes once when the local checkpoint is behind the command frame', async () => {
    const stale = snapshot();
    stale.playlistRevision = 3;
    stale.playback.revision = 8;
    const refreshed = snapshot();
    const f = fixtures({ snapshot: stale, refreshedSnapshot: refreshed });

    await f.executor.handle(frame());

    expect(f.refreshSnapshot).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.acknowledge).toHaveBeenCalledWith(expect.any(Object), 'applied');
  });

  it('refreshes once when the local coordinator epoch trails the command frame', async () => {
    const refreshed = snapshot();
    refreshed.presence.coordinatorEpoch = 4;
    refreshed.playback.coordinatorEpoch = 4;
    const f = fixtures({ refreshedSnapshot: refreshed });
    const commandFrame: DeveloperCommandFrame = { ...frame(), coordinatorEpoch: 4 };

    await f.executor.handle(commandFrame);

    expect(f.refreshSnapshot).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.acknowledge).toHaveBeenCalledWith(commandFrame, 'applied');
  });

  it('does not refresh an already-current snapshot for a real fence mismatch', async () => {
    const f = fixtures();
    const original = frame();
    const mismatched: DeveloperCommandFrame = {
      ...original,
      expected: { ...original.expected, queueItemId: OTHER_QUEUE_ITEM_ID },
    };

    await f.executor.handle(mismatched);

    expect(f.refreshSnapshot).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.acknowledge).toHaveBeenCalledWith(mismatched, 'stale_queue');
  });

  it('leaves a failed refresh unacknowledged so bounded redelivery may retry', async () => {
    const stale = snapshot();
    stale.playback.revision = 8;
    const f = fixtures({ snapshot: stale, refreshedSnapshot: snapshot() });
    f.refreshSnapshot.mockRejectedValueOnce(new Error('offline'));
    const commandFrame = frame();

    await expect(f.executor.handle(commandFrame)).rejects.toThrow('offline');
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.acknowledge).not.toHaveBeenCalled();

    await f.executor.handle(commandFrame);
    expect(f.refreshSnapshot).toHaveBeenCalledTimes(2);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.acknowledge).toHaveBeenCalledWith(commandFrame, 'applied');
  });

  it('rejects a play-item target absent from the authoritative playlist', async () => {
    const f = fixtures();
    const commandFrame = frame({
      type: 'play_item',
      queueItemId: '33333333-3333-4333-8333-333333333333',
    });
    await f.executor.handle(commandFrame);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.acknowledge).toHaveBeenCalledWith(commandFrame, 'stale_queue');
  });

  it.each(['busy', 'no_media', 'unsupported_mode', 'stale_queue'] as const)(
    'preserves an execution rejection result: %s',
    async (resultCode) => {
      const f = fixtures({ result: resultCode });
      const commandFrame = frame();
      await f.executor.handle(commandFrame);
      expect(f.acknowledge).toHaveBeenCalledWith(commandFrame, resultCode);
    },
  );

  it('maps an action failure to execution_failed', async () => {
    const f = fixtures();
    f.execute.mockRejectedValueOnce(new Error('media failed'));
    const commandFrame = frame();
    await f.executor.handle(commandFrame);
    expect(f.acknowledge).toHaveBeenCalledWith(commandFrame, 'execution_failed');
  });

  it('serializes concurrent redelivery and never applies a command twice', async () => {
    const f = fixtures();
    const commandFrame = frame();
    await Promise.all([f.executor.handle(commandFrame), f.executor.handle(commandFrame)]);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.acknowledge.mock.calls.map((call) => call[1])).toEqual(['applied', 'already_applied']);
  });

  it('re-ACKs a rejected duplicate with the original result', async () => {
    const f = fixtures({ result: 'busy' });
    const commandFrame = frame();
    await f.executor.handle(commandFrame);
    await f.executor.handle(commandFrame);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.acknowledge.mock.calls.map((call) => call[1])).toEqual(['busy', 'busy']);
  });

  it('does not repeat an applied side effect when its first ACK fails', async () => {
    const f = fixtures();
    f.acknowledge.mockRejectedValueOnce(new Error('offline'));
    const commandFrame = frame();
    await expect(f.executor.handle(commandFrame)).rejects.toThrow('offline');
    await f.executor.handle(commandFrame);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.acknowledge).toHaveBeenLastCalledWith(commandFrame, 'already_applied');
  });

  it('rejects command-id payload substitution without executing the second payload', async () => {
    const f = fixtures();
    const first = frame({ type: 'play' });
    const substituted = frame({ type: 'pause' });
    await f.executor.handle(first);
    await f.executor.handle(substituted);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.acknowledge).toHaveBeenLastCalledWith(substituted, 'stale_queue');
  });

  it('bounds dedupe memory and reset starts a fresh coordinator lifetime', async () => {
    const f = fixtures({ dedupeCapacity: 1 });
    const first = frame({ type: 'play' }, 'cmd_1234567890123456789012');
    const second = frame({ type: 'pause' }, 'cmd_2234567890123456789012');
    await f.executor.handle(first);
    await f.executor.handle(second);
    await f.executor.handle(first);
    expect(f.execute).toHaveBeenCalledTimes(3);

    f.executor.reset();
    await f.executor.handle(first);
    expect(f.execute).toHaveBeenCalledTimes(4);
  });
});
