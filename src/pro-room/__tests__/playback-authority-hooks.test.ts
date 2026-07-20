import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  cancelProPlaybackPreparation,
  commitProPlaybackAuthority,
  createProPlaybackAuthorityToken,
  prepareProPlaybackAuthority,
  refreshProPlaybackUiControlTimeout,
  registerProPlaybackCommandHandler,
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
  routeProPlaybackCommand,
  type ProPlaybackPrepareResult,
} from '../playback-authority-hooks.ts';

const Q1 = '10000000-0000-4000-8000-000000000001' as QueueItemId;

function authority(revision: number, transitionId: string | null = `transition-${revision}`) {
  return createProPlaybackAuthorityToken({
    roomId: '000001',
    roomEpoch: 7,
    basePlaybackRevision: revision,
    transitionId,
  });
}

function ready(token = authority(1)): ProPlaybackPrepareResult {
  return {
    status: 'ready',
    authority: token,
    queueItemId: Q1,
    mediaKind: 'file',
    durationSeconds: 10,
    youtubeSubIndex: null,
    youtubeVideoId: null,
  };
}

beforeEach(() => {
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role: 'member',
    coordinatorId: null,
    epoch: 7,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
});

afterEach(() => {
  registerProPlaybackCommandHandler(null);
  registerProPlaybackMediaEndpoint(null);
  resetProPlaybackAuthorityHooks();
  clearAllManagedTimers();
  setState('room.context', {
    kind: 'standard',
    roomId: null,
    role: 'idle',
    coordinatorId: null,
    epoch: 0,
    snapshotRevision: 0,
    capabilities: [],
  });
});

describe('coordinator-free PRO playback authority seam', () => {
  it('refuses to re-arm a UI control after its fail-open deadline', () => {
    vi.useFakeTimers();
    const handler = vi.fn(() => new Promise<void>(() => {}));
    registerProPlaybackCommandHandler(handler);
    let token = 0;
    const offPending = bus.on('pro-playback:ui-control-pending', (event) => {
      token = event.token;
    });
    const settled: unknown[] = [];
    const offSettled = bus.on('pro-playback:ui-control-settled', (event) => settled.push(event));
    try {
      routeProPlaybackCommand(
        { kind: 'play', queueItemId: Q1, positionSeconds: 0 },
        { wasPlaying: false },
      );
      vi.advanceTimersByTime(15_000);

      expect(settled).toEqual([expect.objectContaining({ token, kind: 'play', status: 'failed' })]);
      expect(refreshProPlaybackUiControlTimeout(token)).toBe(false);
    } finally {
      offPending();
      offSettled();
      vi.useRealTimers();
    }
  });

  it('projects tokenized UI controls and supersedes only the previous token', async () => {
    const handler = vi.fn(() => new Promise<void>(() => {}));
    registerProPlaybackCommandHandler(handler);
    const pending: unknown[] = [];
    const settled: unknown[] = [];
    const offPending = bus.on('pro-playback:ui-control-pending', (event) => pending.push(event));
    const offSettled = bus.on('pro-playback:ui-control-settled', (event) => settled.push(event));
    try {
      expect(
        routeProPlaybackCommand(
          { kind: 'seek', queueItemId: Q1, positionSeconds: 18 },
          { wasPlaying: true },
        ),
      ).toBe(true);
      expect(
        routeProPlaybackCommand(
          { kind: 'play', queueItemId: Q1, positionSeconds: 18 },
          { wasPlaying: false },
        ),
      ).toBe(true);

      expect(pending).toEqual([
        expect.objectContaining({ kind: 'seek', targetSeconds: 18 }),
        expect.objectContaining({ kind: 'play', targetSeconds: 18 }),
      ]);
      const firstToken = (pending[0] as { token: number }).token;
      const secondToken = (pending[1] as { token: number }).token;
      expect(settled).toEqual([
        expect.objectContaining({ token: firstToken, kind: 'seek', status: 'superseded' }),
      ]);
      expect(handler).toHaveBeenLastCalledWith(
        expect.objectContaining({ clientUiControlToken: secondToken, kind: 'play' }),
      );

      resetProPlaybackAuthorityHooks();
      expect(settled).toEqual([
        expect.objectContaining({ token: firstToken, status: 'superseded' }),
        expect.objectContaining({ token: secondToken, kind: 'play', status: 'failed' }),
      ]);
    } finally {
      offPending();
      offSettled();
    }
  });

  it('routes a PRO action through the registered server handler', async () => {
    const handler = vi.fn();
    registerProPlaybackCommandHandler(handler);

    expect(
      routeProPlaybackCommand({
        kind: 'select',
        queueItemId: Q1,
        positionSeconds: 0,
        youtubeSubIndex: 2,
        youtubeVideoId: 'dQw4w9WgXcQ',
      }),
    ).toBe(true);

    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith({
      kind: 'select',
      roomId: '000001',
      roomEpoch: 7,
      queueItemId: Q1,
      positionSeconds: 0,
      youtubeSubIndex: 2,
      youtubeVideoId: 'dQw4w9WgXcQ',
    });
  });

  it('stamps an automatic media observation with the exact locally accepted revision', async () => {
    registerProPlaybackMediaEndpoint({
      prepare: vi.fn(),
      commit: vi.fn(async (request) => ({
        status: 'applied' as const,
        authority: request.authority,
      })),
    });
    await expect(
      commitProPlaybackAuthority({
        authority: authority(6, null),
        committedPlaybackRevision: 7,
        queueItemId: Q1,
        state: 'playing',
        positionSeconds: 9,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'applied' });

    const handler = vi.fn();
    registerProPlaybackCommandHandler(handler);
    expect(
      routeProPlaybackCommand({
        kind: 'ended',
        queueItemId: Q1,
        positionSeconds: 9.9,
        observedPositionSeconds: 9.9,
        durationSeconds: 10,
        mediaKind: 'file',
      }),
    ).toBe(true);

    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ended',
        queueItemId: Q1,
        observedPlaybackRevision: 7,
        observedPositionSeconds: 9.9,
        durationSeconds: 10,
        mediaKind: 'file',
      }),
    );

    handler.mockClear();
    expect(
      routeProPlaybackCommand({
        kind: 'advance-sub-video',
        queueItemId: Q1,
        positionSeconds: 9.9,
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'advance-sub-video',
        queueItemId: Q1,
        observedPlaybackRevision: 7,
      }),
    );
  });

  it('fails closed during PRO wiring while leaving standard rooms untouched', () => {
    expect(
      routeProPlaybackCommand({
        kind: 'play',
        queueItemId: Q1,
        positionSeconds: 0,
      }),
    ).toBe(true);

    registerProPlaybackCommandHandler(vi.fn());
    setState('room.context', {
      kind: 'standard',
      roomId: '123456',
      role: 'host',
      coordinatorId: null,
      epoch: 0,
      snapshotRevision: 0,
      capabilities: [],
    });
    expect(
      routeProPlaybackCommand({
        kind: 'play',
        queueItemId: Q1,
        positionSeconds: 0,
      }),
    ).toBe(false);
  });

  it('supersedes a slow preparation without granting its async call stack globally', async () => {
    let resolveFirst!: (result: ProPlaybackPrepareResult) => void;
    const first = new Promise<ProPlaybackPrepareResult>((resolve) => {
      resolveFirst = resolve;
    });
    const token1 = authority(1);
    const token2 = authority(2);
    const prepare = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(ready(token2));
    registerProPlaybackMediaEndpoint({
      prepare,
      commit: vi.fn(),
    });

    const pendingFirst = prepareProPlaybackAuthority({
      authority: token1,
      queueItemId: Q1,
      positionSeconds: 0,
    });
    const second = await prepareProPlaybackAuthority({
      authority: token2,
      queueItemId: Q1,
      positionSeconds: 0,
    });
    resolveFirst(ready(token1));

    expect(second.status).toBe('ready');
    await expect(pendingFirst).resolves.toMatchObject({
      status: 'superseded',
      reason: 'superseded',
    });
  });

  it('rejects a stale commit after a newer revision has applied', async () => {
    const commit = vi.fn(async (request) => ({
      status: 'applied' as const,
      authority: request.authority,
    }));
    registerProPlaybackMediaEndpoint({
      prepare: vi.fn(),
      commit,
    });

    const newer = await commitProPlaybackAuthority({
      authority: authority(9, null),
      committedPlaybackRevision: 10,
      queueItemId: Q1,
      state: 'paused',
      positionSeconds: 3,
      scheduleDelayMs: 0,
      timingMode: 'scheduled-control',
    });
    const stale = await commitProPlaybackAuthority({
      authority: authority(8, null),
      committedPlaybackRevision: 9,
      queueItemId: Q1,
      state: 'playing',
      positionSeconds: 3,
      scheduleDelayMs: 0,
      timingMode: 'scheduled-control',
    });

    expect(newer.status).toBe('applied');
    expect(stale).toMatchObject({ status: 'superseded', reason: 'stale-authority' });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('does not publish a commit result that lost its participant-local fence while awaiting media', async () => {
    let current = true;
    let resolveCommit!: (value: {
      status: 'applied';
      authority: ReturnType<typeof authority>;
    }) => void;
    const commit = vi.fn(
      (request) =>
        new Promise<{ status: 'applied'; authority: ReturnType<typeof authority> }>((resolve) => {
          resolveCommit = resolve;
        }),
    );
    registerProPlaybackMediaEndpoint({ prepare: vi.fn(), commit });
    const token = authority(30, null);
    const applying = commitProPlaybackAuthority({
      authority: token,
      committedPlaybackRevision: 31,
      queueItemId: Q1,
      state: 'playing',
      positionSeconds: 0,
      scheduleDelayMs: 0,
      timingMode: 'scheduled-control',
      isCurrent: () => current,
    });
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());

    current = false;
    resolveCommit({ status: 'applied', authority: token });

    await expect(applying).resolves.toMatchObject({
      status: 'superseded',
      reason: 'superseded',
    });
  });

  it('rejects a late PREPARE whose base revision was already committed', async () => {
    registerProPlaybackMediaEndpoint({
      prepare: vi.fn(async (request) => ready(request.authority)),
      commit: vi.fn(async (request) => ({
        status: 'applied' as const,
        authority: request.authority,
      })),
    });

    await expect(
      commitProPlaybackAuthority({
        authority: authority(5, null),
        committedPlaybackRevision: 6,
        queueItemId: Q1,
        state: 'paused',
        positionSeconds: 0,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'applied' });

    await expect(
      prepareProPlaybackAuthority({
        authority: authority(5, 'late-transition'),
        queueItemId: Q1,
        positionSeconds: 0,
      }),
    ).resolves.toMatchObject({ status: 'superseded', reason: 'stale-authority' });
  });

  it('rejects authority from a different room epoch before touching media', async () => {
    const commit = vi.fn();
    registerProPlaybackMediaEndpoint({ prepare: vi.fn(), commit });
    const oldEpoch = createProPlaybackAuthorityToken({
      roomId: '000001',
      roomEpoch: 6,
      basePlaybackRevision: 100,
      transitionId: 'old-room-incarnation',
    });

    await expect(
      commitProPlaybackAuthority({
        authority: oldEpoch,
        committedPlaybackRevision: 101,
        queueItemId: Q1,
        state: 'playing',
        positionSeconds: 0,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'inactive-room' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('cancels only the exact active transition and rejects its late commit', async () => {
    const token = authority(12);
    const cancel = vi.fn();
    registerProPlaybackMediaEndpoint({
      prepare: vi.fn().mockResolvedValue(ready(token)),
      commit: vi.fn(),
      cancel,
    });

    await expect(
      prepareProPlaybackAuthority({
        authority: token,
        queueItemId: Q1,
        positionSeconds: 0,
      }),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(cancelProPlaybackPreparation(token)).toBe(true);
    expect(cancel).toHaveBeenCalledWith(token);
    await expect(
      commitProPlaybackAuthority({
        authority: token,
        committedPlaybackRevision: 13,
        queueItemId: Q1,
        state: 'playing',
        positionSeconds: 0,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'superseded', reason: 'stale-authority' });
  });

  it('cancels participant media preparation when room authority is reset', async () => {
    const token = authority(18);
    const cancel = vi.fn();
    registerProPlaybackMediaEndpoint({
      prepare: vi.fn().mockResolvedValue(ready(token)),
      commit: vi.fn(),
      cancel,
    });

    await expect(
      prepareProPlaybackAuthority({
        authority: token,
        queueItemId: Q1,
        positionSeconds: 0,
      }),
    ).resolves.toMatchObject({ status: 'ready' });

    resetProPlaybackAuthorityHooks();

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(token);
  });

  it('allows a replacement transition at the same base revision after cancellation', async () => {
    const first = authority(20, 'transition-first');
    const replacement = authority(20, 'transition-replacement');
    registerProPlaybackMediaEndpoint({
      prepare: vi.fn(async (request) => ready(request.authority)),
      commit: vi.fn(async (request) => ({
        status: 'applied' as const,
        authority: request.authority,
      })),
    });

    await prepareProPlaybackAuthority({ authority: first, queueItemId: Q1, positionSeconds: 0 });
    expect(cancelProPlaybackPreparation(first)).toBe(true);
    await expect(
      prepareProPlaybackAuthority({
        authority: replacement,
        queueItemId: Q1,
        positionSeconds: 0,
      }),
    ).resolves.toMatchObject({ status: 'ready' });
    await expect(
      commitProPlaybackAuthority({
        authority: replacement,
        committedPlaybackRevision: 21,
        queueItemId: Q1,
        state: 'paused',
        positionSeconds: 4,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'applied' });
  });
});
