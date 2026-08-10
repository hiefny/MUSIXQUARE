import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  cancelProPlaybackPreparation,
  commitProPlaybackAuthority,
  createProPlaybackAuthorityToken,
  isProPlaybackTrackSelectionPending,
  prepareCurrentProPlaybackRendezvousAuthority,
  prepareProPlaybackAuthority,
  reconcileCurrentProPlaybackAuthority,
  rendezvousCurrentProPlaybackAuthority,
  refreshProPlaybackUiControlTimeout,
  registerProPlaybackCommandHandler,
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
  routeProPlaybackCommand,
  type ProPlaybackPrepareRequest,
  type ProPlaybackCommitResult,
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
  it('drops controls that race an admitted track selection request', async () => {
    let resolveSelection!: () => void;
    const selection = new Promise<void>((resolve) => {
      resolveSelection = resolve;
    });
    const handler = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => selection)
      .mockResolvedValue(undefined);
    registerProPlaybackCommandHandler(handler);

    expect(
      routeProPlaybackCommand({
        kind: 'select',
        queueItemId: Q1,
        positionSeconds: 0,
        youtubeSubIndex: 0,
        youtubeVideoId: 'dQw4w9WgXcQ',
      }),
    ).toBe(true);
    expect(isProPlaybackTrackSelectionPending()).toBe(true);

    expect(
      routeProPlaybackCommand(
        { kind: 'seek', queueItemId: Q1, positionSeconds: 42 },
        { wasPlaying: true },
      ),
    ).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    resolveSelection();
    await vi.waitFor(() => expect(isProPlaybackTrackSelectionPending()).toBe(false));

    routeProPlaybackCommand(
      { kind: 'seek', queueItemId: Q1, positionSeconds: 42 },
      { wasPlaying: true },
    );
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('consumes every member control and queue-mutating media observation locally', async () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 7,
      snapshotRevision: 1,
      capabilities: [],
    });
    const handler = vi.fn();
    registerProPlaybackCommandHandler(handler);
    const pending = vi.fn();
    const offPending = bus.on('pro-playback:ui-control-pending', pending);

    try {
      expect(
        routeProPlaybackCommand(
          { kind: 'play', queueItemId: Q1, positionSeconds: 0 },
          { wasPlaying: false },
        ),
      ).toBe(true);
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
      expect(
        routeProPlaybackCommand({
          kind: 'unavailable',
          queueItemId: Q1,
          positionSeconds: 9.9,
          observedPositionSeconds: 9.9,
          durationSeconds: 10,
          mediaKind: 'file',
        }),
      ).toBe(true);

      await Promise.resolve();
      expect(pending).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      offPending();
    }
  });

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
      role: 'coordinator',
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

  it('composes an upstream owner into every canonical PREPARE wait', async () => {
    let ownerCurrent = true;
    let resolvePreparation!: (result: ProPlaybackPrepareResult) => void;
    const token = authority(3);
    const prepare = vi.fn(
      (_request: Readonly<ProPlaybackPrepareRequest>) =>
        new Promise<ProPlaybackPrepareResult>((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    registerProPlaybackMediaEndpoint({ prepare, commit: vi.fn() });

    const pending = prepareProPlaybackAuthority({
      authority: token,
      queueItemId: Q1,
      positionSeconds: 0,
      isCurrent: () => ownerCurrent,
    });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    const endpointRequest = prepare.mock.calls[0]?.[0];
    expect(endpointRequest?.isCurrent?.()).toBe(true);

    ownerCurrent = false;
    expect(endpointRequest?.isCurrent?.()).toBe(false);
    resolvePreparation(ready(token));

    await expect(pending).resolves.toMatchObject({
      status: 'superseded',
      reason: 'superseded',
    });
  });

  it.each(['stale', 'rejected'] as const)(
    'releases exact preparation when its COMMIT becomes %s',
    async (outcome) => {
      let ownerCurrent = true;
      let resolveCommit!: (result: ProPlaybackCommitResult) => void;
      let rejectCommit!: (reason: unknown) => void;
      const token = authority(3);
      const successor = authority(3, 'successor');
      const prepare = vi.fn(async (request) => ready(request.authority));
      const commit = vi.fn(
        () =>
          new Promise<ProPlaybackCommitResult>((resolve, reject) => {
            resolveCommit = resolve;
            rejectCommit = reject;
          }),
      );
      const cancel = vi.fn();
      registerProPlaybackMediaEndpoint({ prepare, commit, cancel });
      await expect(
        prepareProPlaybackAuthority({
          authority: token,
          queueItemId: Q1,
          positionSeconds: 0,
          isCurrent: () => ownerCurrent,
        }),
      ).resolves.toMatchObject({ status: 'ready' });
      const pendingCommit = commitProPlaybackAuthority({
        authority: token,
        committedPlaybackRevision: 4,
        queueItemId: Q1,
        state: 'playing',
        positionSeconds: 0,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
        isCurrent: () => ownerCurrent,
      });
      await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
      ownerCurrent = false;
      if (outcome === 'stale') {
        resolveCommit({ status: 'applied', authority: token });
        await expect(pendingCommit).resolves.toMatchObject({
          status: 'superseded',
          reason: 'superseded',
        });
      } else {
        rejectCommit(new Error('commit failed'));
        await expect(pendingCommit).rejects.toThrow('commit failed');
      }

      expect(cancel).toHaveBeenCalledWith(token);
      await expect(
        prepareProPlaybackAuthority({
          authority: successor,
          queueItemId: Q1,
          positionSeconds: 0,
        }),
      ).resolves.toMatchObject({ status: 'ready' });
      expect(prepare).toHaveBeenCalledTimes(2);
    },
  );

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

  it('re-applies only the exact current revision without advancing authority state', async () => {
    const commit = vi.fn(async (request) => ({
      status: 'applied' as const,
      authority: request.authority,
    }));
    registerProPlaybackMediaEndpoint({ prepare: vi.fn(), commit });

    await expect(
      commitProPlaybackAuthority({
        authority: authority(8, null),
        committedPlaybackRevision: 9,
        queueItemId: Q1,
        state: 'playing',
        positionSeconds: 12,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'applied' });

    const current = authority(8, null);
    await expect(
      reconcileCurrentProPlaybackAuthority({
        authority: current,
        committedPlaybackRevision: 9,
        queueItemId: Q1,
        state: 'playing',
        positionSeconds: 18,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'applied' });

    await expect(
      reconcileCurrentProPlaybackAuthority({
        authority: authority(7, null),
        committedPlaybackRevision: 8,
        queueItemId: Q1,
        state: 'playing',
        positionSeconds: 18,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'superseded', reason: 'stale-authority' });

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ committedPlaybackRevision: 9, positionSeconds: 18 }),
    );
  });

  it('arms and rendezvous-releases only the exact current revision without advancing it', async () => {
    const prepare = vi.fn(async (request) => ready(request.authority));
    const commit = vi.fn(async (request) => ({
      status: 'applied' as const,
      authority: request.authority,
    }));
    registerProPlaybackMediaEndpoint({ prepare, commit });

    await expect(
      commitProPlaybackAuthority({
        authority: authority(8, null),
        committedPlaybackRevision: 9,
        queueItemId: Q1,
        state: 'playing',
        positionSeconds: 12,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'applied' });

    const localRendezvous = authority(8, 'local-sync');
    await expect(
      prepareCurrentProPlaybackRendezvousAuthority({
        authority: localRendezvous,
        queueItemId: Q1,
        positionSeconds: 18,
      }),
    ).resolves.toMatchObject({ status: 'ready' });
    await expect(
      rendezvousCurrentProPlaybackAuthority({
        authority: localRendezvous,
        committedPlaybackRevision: 9,
        queueItemId: Q1,
        state: 'playing',
        positionSeconds: 18.7,
        scheduleDelayMs: 700,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'applied' });

    // A participant-local rendezvous must not consume the next canonical
    // server revision.
    await expect(
      commitProPlaybackAuthority({
        authority: authority(9, null),
        committedPlaybackRevision: 10,
        queueItemId: Q1,
        state: 'paused',
        positionSeconds: 19,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'applied' });

    expect(prepare).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledTimes(3);
    expect(commit.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ committedPlaybackRevision: 9, scheduleDelayMs: 700 }),
    );
  });

  it('lets a newer canonical PREPARE cancel and supersede a local rendezvous arm', async () => {
    let resolveLocal!: (result: ProPlaybackPrepareResult) => void;
    const localToken = authority(8, 'local-sync-pending');
    const serverToken = authority(9, 'server-transition-next');
    const prepare = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ProPlaybackPrepareResult>((resolve) => {
            resolveLocal = resolve;
          }),
      )
      .mockImplementationOnce(async () => ready(serverToken));
    const commit = vi.fn(async (request) => ({
      status: 'applied' as const,
      authority: request.authority,
    }));
    const cancel = vi.fn();
    registerProPlaybackMediaEndpoint({ prepare, commit, cancel });

    await commitProPlaybackAuthority({
      authority: authority(8, null),
      committedPlaybackRevision: 9,
      queueItemId: Q1,
      state: 'playing',
      positionSeconds: 12,
      scheduleDelayMs: 0,
      timingMode: 'scheduled-control',
    });
    const localPreparation = prepareCurrentProPlaybackRendezvousAuthority({
      authority: localToken,
      queueItemId: Q1,
      positionSeconds: 18,
    });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());

    const serverPreparation = prepareProPlaybackAuthority({
      authority: serverToken,
      queueItemId: Q1,
      positionSeconds: 20,
    });
    await expect(serverPreparation).resolves.toMatchObject({ status: 'ready' });
    expect(cancel).toHaveBeenCalledWith(localToken);

    resolveLocal(ready(localToken));
    await expect(localPreparation).resolves.toMatchObject({
      status: 'superseded',
      reason: 'superseded',
    });
    await expect(
      rendezvousCurrentProPlaybackAuthority({
        authority: localToken,
        committedPlaybackRevision: 9,
        queueItemId: Q1,
        state: 'playing',
        positionSeconds: 18.7,
        scheduleDelayMs: 700,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'superseded' });

    await expect(
      commitProPlaybackAuthority({
        authority: serverToken,
        committedPlaybackRevision: 10,
        queueItemId: Q1,
        state: 'playing',
        positionSeconds: 20,
        scheduleDelayMs: 700,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'applied' });
  });

  it('allows current-revision rendezvous after a newer canonical PREPARE is cancelled', async () => {
    const prepare = vi.fn(async (request) => ready(request.authority));
    const commit = vi.fn(async (request) => ({
      status: 'applied' as const,
      authority: request.authority,
    }));
    const cancel = vi.fn();
    registerProPlaybackMediaEndpoint({ prepare, commit, cancel });

    await commitProPlaybackAuthority({
      authority: authority(8, null),
      committedPlaybackRevision: 9,
      queueItemId: Q1,
      state: 'playing',
      positionSeconds: 12,
      scheduleDelayMs: 0,
      timingMode: 'scheduled-control',
    });

    const serverToken = authority(9, 'server-transition-cancelled');
    await expect(
      prepareProPlaybackAuthority({
        authority: serverToken,
        queueItemId: Q1,
        positionSeconds: 20,
      }),
    ).resolves.toMatchObject({ status: 'ready' });

    const localToken = authority(8, 'local-sync-after-cancel');
    // Historical high-water state must not let local work preempt a server
    // PREPARE that is still active.
    await expect(
      prepareCurrentProPlaybackRendezvousAuthority({
        authority: localToken,
        queueItemId: Q1,
        positionSeconds: 18,
      }),
    ).resolves.toMatchObject({ status: 'superseded', reason: 'stale-authority' });
    expect(prepare).toHaveBeenCalledOnce();

    expect(cancelProPlaybackPreparation(serverToken)).toBe(true);
    expect(cancel).toHaveBeenCalledWith(serverToken);
    await expect(
      prepareCurrentProPlaybackRendezvousAuthority({
        authority: localToken,
        queueItemId: Q1,
        positionSeconds: 18,
      }),
    ).resolves.toMatchObject({ status: 'ready' });
    await expect(
      rendezvousCurrentProPlaybackAuthority({
        authority: localToken,
        committedPlaybackRevision: 9,
        queueItemId: Q1,
        state: 'playing',
        positionSeconds: 18.7,
        scheduleDelayMs: 700,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toMatchObject({ status: 'applied' });

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('does not publish a commit result that lost its participant-local fence while awaiting media', async () => {
    let current = true;
    let resolveCommit!: (value: {
      status: 'applied';
      authority: ReturnType<typeof authority>;
    }) => void;
    const commit = vi.fn(
      (_request) =>
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
