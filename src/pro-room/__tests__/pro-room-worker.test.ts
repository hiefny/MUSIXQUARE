import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
  ACCOUNT_ASSERTION_HEADER,
  createAccountAssertion,
} from '../../../cloudflare/account-assertion.js';
import {
  MusixquareProRoom,
  issueProRoomActivationClaim,
  issueProRoomOwnerRecoveryClaim,
  default as proRoomWorker,
} from '../../../cloudflare/pro-room-worker.js';
import developerApiFacadeWorker from '../../../cloudflare/developer-api-facade-worker.js';
import developerApiWorker, {
  deriveDeveloperApiKeyDigest,
  developerApiScopes,
} from '../../../cloudflare/developer-api-worker.js';
import { MAX_SYSTEM_AUDIO_DEVICES, SYSTEM_AUDIO_SHARE_LIMIT_MS } from '../../core/constants.ts';
import { ProRoomApiError, type UpdateProRoomSnapshotInput } from '../api.ts';
import type { ProRoomR2Source, ProRoomSnapshot } from '../contracts.ts';
import {
  ProRoomPlaylistStateManager,
  type ProRoomFirstAppendSelectionRequest,
  type ProRoomPlaylistMediaTransferForTests,
  type ProRoomPlaylistStateApiForTests,
} from '../playlist-state-manager.ts';
import { parseProRoomSnapshot } from '../snapshot.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('PRO room server-authoritative playback', () => {
  const firstQueueItemId = '11111111-1111-4111-8111-111111111111';
  const secondQueueItemId = '22222222-2222-4222-8222-222222222222';
  const duplicateVideoPlaylist = [
    {
      queueItemId: firstQueueItemId,
      name: 'Repeated video A',
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    },
    {
      queueItemId: secondQueueItemId,
      name: 'Repeated video B',
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    },
  ];
  const playlistManifest = [
    {
      queueItemId: firstQueueItemId,
      name: 'Server playlist',
      source: {
        kind: 'youtube',
        videoId: 'dQw4w9WgXcQ',
        playlistId: 'PL_SERVER_AUTHORITY',
        videoIds: ['9bZkp7q19f0', 'dQw4w9WgXcQ', 'M7lc1UVf-VE', 'jNQXAC9IVRw'],
      },
    },
    {
      queueItemId: secondQueueItemId,
      name: 'Outer video',
      source: { kind: 'youtube', videoId: 'aqz-KE-bpKQ' },
    },
  ];

  async function addMember(context: Awaited<ReturnType<typeof activatedRoom>>) {
    const response = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-mxqr-account-linked')).toBeNull();
    const cookie = cookieFrom(response);
    const envelope = await responseJson(response);
    bindCookiePresence(cookie, envelope);
    return { cookie, envelope };
  }

  function installRealtimeRecorder(context: Awaited<ReturnType<typeof activatedRoom>>) {
    const messages: Record<string, any>[] = [];
    const fetch = vi.fn(async (request: Request) => {
      messages.push((await request.clone().json()) as Record<string, any>);
      return Response.json({ broadcast: true, eligible: 2, sent: 2 });
    });
    const internal = context.worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch })),
    };
    return { internal, fetch, messages };
  }

  async function selectAndCommit(
    context: Awaited<ReturnType<typeof activatedRoom>>,
    queueItemId: string,
    options: {
      state?: 'playing' | 'paused';
      positionSeconds?: number;
      youtubeVideoId?: string;
      youtubeSubIndex?: number;
      key?: string;
    } = {},
  ) {
    const before = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const selectedResponse = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: before.snapshot.playback.revision,
          queueItemId,
          state: options.state || 'playing',
          positionSeconds: options.positionSeconds || 0,
          ...(options.youtubeVideoId === undefined
            ? {}
            : {
                youtubeVideoId: options.youtubeVideoId,
                youtubeSubIndex: options.youtubeSubIndex,
              }),
        },
        context.ownerCookie,
        options.key || `authority-select-${queueItemId}`,
      ),
    );
    expect(selectedResponse.status).toBe(202);
    const selected = await responseJson(selectedResponse);
    const internal = context.worker as unknown as { room: Record<string, any> };
    expect(
      internal.room.pendingPlaybackTransition.deadlineAtMs -
        internal.room.pendingPlaybackTransition.createdAtMs,
    ).toBe(2_999);
    expect(internal.room.pendingPlaybackTransition).not.toHaveProperty('timingMode');
    const readyResponse = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${selected.transition.transitionId}/ready`,
        'POST',
        {
          basePlaybackRevision: selected.transition.basePlaybackRevision,
          status: 'ready',
        },
        context.ownerCookie,
      ),
    );
    expect(readyResponse.status).toBe(200);
    await expect(readyResponse.json()).resolves.toMatchObject({ status: 'committed' });
    return responseJson(await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)));
  }

  async function commitCurrentTransition(context: Awaited<ReturnType<typeof activatedRoom>>) {
    const internal = context.worker as unknown as { room: Record<string, any> };
    const pending = internal.room.pendingPlaybackTransition;
    expect(pending).not.toBeNull();
    expect(pending.deadlineAtMs - pending.createdAtMs).toBe(2_999);
    expect(pending).not.toHaveProperty('timingMode');
    const response = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${pending.transitionId}/ready`,
        'POST',
        { basePlaybackRevision: pending.basePlaybackRevision, status: 'ready' },
        context.ownerCookie,
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'committed' });
    return internal.room.playback as Record<string, any>;
  }

  it('never elects a browser coordinator and signs every signaling ticket as a named member', async () => {
    const context = await activatedRoom();
    expect(context.activationEnvelope.snapshot.presence.coordinatorParticipantId).toBeNull();
    expect(context.activationEnvelope.snapshot.viewer.coordinatorEligible).toBe(false);
    expect(context.activationEnvelope.snapshot.viewer.capabilities).not.toContain(
      'coordinator.eligible',
    );

    const response = await context.worker.fetch(
      request('/signaling-tickets', { method: 'POST' }, context.ownerCookie),
    );
    expect(response.status).toBe(200);
    const envelope = await responseJson(response);
    expect(envelope).toMatchObject({
      role: 'member',
      coordinatorEpoch: context.activationEnvelope.snapshot.presence.coordinatorEpoch,
      pendingPlaybackTransition: null,
    });
    const [encodedPayload] = String(envelope.ticket).split('.');
    const payload = JSON.parse(
      Buffer.from(encodedPayload!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: 'pro-signaling',
      role: 'member',
      displayName: 'Owner',
    });
    expect(payload).not.toHaveProperty('developerControlVersion');
  });

  it('persists and publicly restores the bounded ordered YouTube manifest in a v2 row', async () => {
    const context = await activatedRoom();
    const response = await replacePlaylist(context, playlistManifest, 'manifest-persistence');
    expect(response.status).toBe(200);
    const envelope = await responseJson(response);
    expect(envelope.snapshot.playlist[0].source).toEqual(playlistManifest[0].source);
    expect(
      context.state.storage.data.get(`pro-room:v2:playlist:${firstQueueItemId}`),
    ).toMatchObject({
      source: playlistManifest[0].source,
    });

    const restarted = new MusixquareProRoom(
      context.state as never,
      environment(context.bucket) as never,
    );
    const restored = await restarted.fetch(request('/snapshot', {}, context.ownerCookie));
    expect(restored.status).toBe(200);
    const restoredEnvelope = await responseJson(restored);
    expect(restoredEnvelope.snapshot.playlist[0].source).toEqual(playlistManifest[0].source);
  });

  it('accepts 5,000 ordered manifest entries including duplicates within the row budget', async () => {
    const context = await activatedRoom();
    const videoIds = Array.from({ length: 5_000 }, () => 'dQw4w9WgXcQ');
    const response = await replacePlaylist(
      context,
      [
        {
          queueItemId: firstQueueItemId,
          name: 'Maximum manifest',
          source: {
            kind: 'youtube',
            videoId: 'dQw4w9WgXcQ',
            playlistId: 'PL_MAXIMUM_MANIFEST',
            videoIds,
          },
        },
      ],
      'manifest-maximum',
    );
    expect(response.status).toBe(200);
    const stored = context.state.storage.data.get(
      `pro-room:v2:playlist:${firstQueueItemId}`,
    ) as Record<string, any>;
    expect(stored.source.videoIds).toHaveLength(5_000);
    expect(new TextEncoder().encode(JSON.stringify(stored)).byteLength).toBeLessThanOrEqual(
      128 * 1024,
    );
  });

  it('allows one canonical legacy manifest upgrade and rejects every later manifest mutation', async () => {
    const context = await activatedRoom();
    const legacy = playlistManifest.map((item, index) =>
      index === 0
        ? {
            ...item,
            source: {
              kind: 'youtube',
              videoId: item.source.videoId,
              playlistId: item.source.playlistId,
            },
          }
        : item,
    );
    expect((await replacePlaylist(context, legacy, 'manifest-legacy')).status).toBe(200);
    expect((await replacePlaylist(context, playlistManifest, 'manifest-upgrade')).status).toBe(200);

    const changed = structuredClone(playlistManifest);
    changed[0]!.source.videoIds = ['dQw4w9WgXcQ', 'M7lc1UVf-VE'];
    const mutation = await replacePlaylist(context, changed, 'manifest-mutation');
    expect(mutation.status).toBe(409);
    await expect(mutation.json()).resolves.toEqual({ error: 'PLAYLIST_MANIFEST_IMMUTABLE' });
  });

  it('uses the same manifest reducer for participant, Developer API, and BOT next commands', async () => {
    const context = await activatedRoom();
    const internal = context.worker as unknown as { room: Record<string, any> };
    expect(
      (await replacePlaylist(context, playlistManifest, 'manifest-shared-reducer')).status,
    ).toBe(200);
    const entered = await selectAndCommit(context, firstQueueItemId, {
      key: 'manifest-shared-select-0001',
    });
    expect(entered.snapshot.playback).toMatchObject({
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 1,
    });

    const participantNext = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        { type: 'next', baseRevision: internal.room.playback.revision },
        context.ownerCookie,
        'manifest-shared-participant-next-0002',
      ),
    );
    expect(participantNext.status).toBe(202);
    expect(internal.room.pendingPlaybackTransition.target).toMatchObject({
      queueItemId: firstQueueItemId,
      youtubeVideoId: 'M7lc1UVf-VE',
      youtubeSubIndex: 2,
    });
    await commitCurrentTransition(context);
    await expect(
      internalDeveloperRead(context.worker, 'playback').then(responseJson),
    ).resolves.toMatchObject({
      youtubeVideoId: 'M7lc1UVf-VE',
      youtubeSubIndex: 2,
    });

    const developerNext = await createInternalDeveloperCommand(
      context.worker,
      DEVELOPER_KEY_ID,
      'manifest-shared-developer-next-0003',
      { type: 'next' },
    );
    expect(developerNext.status).toBe(202);
    await expect(developerNext.json()).resolves.toMatchObject({ status: 'pending' });
    expect(internal.room.pendingPlaybackTransition.target).toMatchObject({
      queueItemId: firstQueueItemId,
      youtubeVideoId: 'jNQXAC9IVRw',
      youtubeSubIndex: 3,
    });
    await commitCurrentTransition(context);

    const requestId = 'manifest-shared-bot-next-0004';
    const botContext = await internalBotRequest(
      context.worker,
      'context',
      { roomCode: ROOM_CODE, requestId, prompt: 'next' },
      context.ownerCookie,
    );
    expect(botContext.status).toBe(200);
    const { leaseToken } = await responseJson(botContext);
    const botNext = await internalBotRequest(
      context.worker,
      'execute',
      {
        roomCode: ROOM_CODE,
        requestId,
        leaseToken,
        plan: { intent: 'playback', playbackCommand: 'next' },
        tracks: [],
      },
      context.ownerCookie,
    );
    expect(botNext.status).toBe(200);
    expect(internal.room.pendingPlaybackTransition.target).toMatchObject({
      queueItemId: secondQueueItemId,
      youtubeVideoId: 'aqz-KE-bpKQ',
      youtubeSubIndex: 0,
    });
    await commitCurrentTransition(context);
  });

  it('applies shuffle and repeat-all only when manifest traversal reaches an outer boundary', async () => {
    const context = await activatedRoom();
    const internal = context.worker as unknown as { room: Record<string, any> };
    expect(
      (await replacePlaylist(context, playlistManifest, 'manifest-outer-boundary')).status,
    ).toBe(200);
    internal.room.queueMode = {
      revision: internal.room.queueMode.revision + 1,
      updatedAtMs: Date.now(),
      repeatMode: 1,
      shuffleEnabled: true,
      shuffleOrder: [secondQueueItemId, firstQueueItemId],
    };
    await selectAndCommit(context, firstQueueItemId, {
      youtubeVideoId: 'M7lc1UVf-VE',
      youtubeSubIndex: 2,
      key: 'manifest-boundary-select-0001',
    });

    await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        { type: 'next', baseRevision: internal.room.playback.revision },
        context.ownerCookie,
        'manifest-boundary-internal-next-0002',
      ),
    );
    expect(internal.room.pendingPlaybackTransition.target).toMatchObject({
      queueItemId: firstQueueItemId,
      youtubeVideoId: 'jNQXAC9IVRw',
      youtubeSubIndex: 3,
    });
    await commitCurrentTransition(context);

    await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        { type: 'next', baseRevision: internal.room.playback.revision },
        context.ownerCookie,
        'manifest-boundary-outer-next-0003',
      ),
    );
    expect(internal.room.pendingPlaybackTransition.target).toMatchObject({
      queueItemId: secondQueueItemId,
      youtubeVideoId: 'aqz-KE-bpKQ',
      youtubeSubIndex: 0,
    });
  });

  it('navigates previous and unavailable inside a manifest and repeats the exact inner item', async () => {
    const context = await activatedRoom();
    const internal = context.worker as unknown as { room: Record<string, any> };
    expect(
      (await replacePlaylist(context, playlistManifest, 'manifest-inner-semantics')).status,
    ).toBe(200);
    await selectAndCommit(context, firstQueueItemId, {
      youtubeVideoId: 'M7lc1UVf-VE',
      youtubeSubIndex: 2,
      key: 'manifest-inner-select-0001',
    });

    const previous = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        { type: 'previous', baseRevision: internal.room.playback.revision },
        context.ownerCookie,
        'manifest-inner-previous-0002',
      ),
    );
    expect(previous.status).toBe(202);
    expect(internal.room.pendingPlaybackTransition.target).toMatchObject({
      queueItemId: firstQueueItemId,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 1,
    });
    await commitCurrentTransition(context);

    const unavailable = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'unavailable',
          baseRevision: internal.room.playback.revision,
          queueItemId: firstQueueItemId,
          mediaKind: 'youtube',
          observedPositionSeconds: 0,
          durationSeconds: null,
          youtubeVideoId: 'dQw4w9WgXcQ',
          youtubeSubIndex: 1,
        },
        context.ownerCookie,
        'manifest-inner-unavailable-0003',
      ),
    );
    expect(unavailable.status).toBe(202);
    expect(internal.room.pendingPlaybackTransition.target).toMatchObject({
      queueItemId: firstQueueItemId,
      youtubeVideoId: 'M7lc1UVf-VE',
      youtubeSubIndex: 2,
    });
    await commitCurrentTransition(context);

    const endedForward = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'ended',
          baseRevision: internal.room.playback.revision,
          queueItemId: firstQueueItemId,
          mediaKind: 'youtube',
          observedPositionSeconds: 0.1,
          durationSeconds: 0.1,
          youtubeVideoId: 'M7lc1UVf-VE',
          youtubeSubIndex: 2,
        },
        context.ownerCookie,
        'manifest-inner-ended-forward-0004',
      ),
    );
    expect(endedForward.status).toBe(202);
    expect(internal.room.pendingPlaybackTransition.target).toMatchObject({
      queueItemId: firstQueueItemId,
      youtubeVideoId: 'jNQXAC9IVRw',
      youtubeSubIndex: 3,
    });
    await commitCurrentTransition(context);
    await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        { type: 'previous', baseRevision: internal.room.playback.revision },
        context.ownerCookie,
        'manifest-inner-return-0005',
      ),
    );
    await commitCurrentTransition(context);

    const mode = await updateInternalDeveloperQueueMode(
      context.worker,
      DEVELOPER_KEY_ID,
      'manifest-inner-repeat-one-0006',
      {
        baseRevision: internal.room.queueMode.revision,
        repeatMode: 'one',
        shuffleEnabled: false,
      },
    );
    expect(mode.status).toBe(200);
    const ended = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'ended',
          baseRevision: internal.room.playback.revision,
          queueItemId: firstQueueItemId,
          mediaKind: 'youtube',
          observedPositionSeconds: 0.1,
          durationSeconds: 0.1,
          youtubeVideoId: 'M7lc1UVf-VE',
          youtubeSubIndex: 2,
        },
        context.ownerCookie,
        'manifest-inner-ended-repeat-0007',
      ),
    );
    expect(ended.status).toBe(202);
    expect(internal.room.pendingPlaybackTransition.target).toMatchObject({
      queueItemId: firstQueueItemId,
      positionSeconds: 0,
      youtubeVideoId: 'M7lc1UVf-VE',
      youtubeSubIndex: 2,
    });
  });

  it('rejects forged or out-of-range manifest selects and requires a manifest for traversal', async () => {
    const context = await activatedRoom();
    expect((await replacePlaylist(context, playlistManifest, 'manifest-select-guard')).status).toBe(
      200,
    );
    const before = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const invalidSelections = [
      { youtubeVideoId: 'M7lc1UVf-VE', youtubeSubIndex: 1 },
      { youtubeVideoId: 'aqz-KE-bpKQ', youtubeSubIndex: 4 },
    ];
    for (const [index, identity] of invalidSelections.entries()) {
      const response = await context.worker.fetch(
        jsonRequest(
          '/playback/commands',
          'POST',
          {
            type: 'select',
            baseRevision: before.snapshot.playback.revision,
            queueItemId: firstQueueItemId,
            ...identity,
          },
          context.ownerCookie,
          `manifest-invalid-select-000${index}`,
        ),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'INVALID_PLAYBACK_TARGET' });
    }

    const legacyContext = await activatedRoom();
    const legacyPlaylist = structuredClone(playlistManifest);
    delete legacyPlaylist[0]!.source.videoIds;
    expect(
      (await replacePlaylist(legacyContext, legacyPlaylist, 'manifest-missing-seed')).status,
    ).toBe(200);
    await selectAndCommit(legacyContext, firstQueueItemId, {
      key: 'manifest-missing-select-0003',
    });
    const internal = legacyContext.worker as unknown as { room: Record<string, any> };
    const commands = [
      { type: 'next' },
      { type: 'previous' },
      {
        type: 'ended',
        queueItemId: firstQueueItemId,
        mediaKind: 'youtube',
        observedPositionSeconds: 0.1,
        durationSeconds: 0.1,
        youtubeVideoId: 'dQw4w9WgXcQ',
        youtubeSubIndex: 0,
      },
      {
        type: 'unavailable',
        queueItemId: firstQueueItemId,
        mediaKind: 'youtube',
        observedPositionSeconds: 0,
        durationSeconds: null,
        youtubeVideoId: 'dQw4w9WgXcQ',
        youtubeSubIndex: 0,
      },
    ];
    for (const [index, command] of commands.entries()) {
      const response = await legacyContext.worker.fetch(
        jsonRequest(
          '/playback/commands',
          'POST',
          { ...command, baseRevision: internal.room.playback.revision },
          legacyContext.ownerCookie,
          `manifest-required-command-000${index}`,
        ),
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: 'PLAYLIST_MANIFEST_REQUIRED' });
    }
  });

  it('rendezvous-loads once, coalesces duplicate ended observations, and commits at the deadline', async () => {
    const context = await activatedRoom();
    const realtime = installRealtimeRecorder(context);
    const friend = await addMember(context);
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-rendezvous')).status,
    ).toBe(200);

    const before = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const select = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: before.snapshot.playback.revision,
          queueItemId: firstQueueItemId,
        },
        context.ownerCookie,
        'authority-select-command-0001',
      ),
    );
    expect(select.status).toBe(202);
    const selecting = await responseJson(select);
    expect(selecting).toMatchObject({
      status: 'preparing',
      transition: {
        type: 'pro-playback-prepare',
        basePlaybackRevision: before.snapshot.playback.revision,
        target: { queueItemId: firstQueueItemId, state: 'playing', positionSeconds: 0 },
      },
    });
    expect(realtime.internal.room.pendingPlaybackTransition.cohort).toHaveLength(2);

    const readyBody = {
      basePlaybackRevision: selecting.transition.basePlaybackRevision,
      status: 'ready',
    };
    const ownerReady = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${selecting.transition.transitionId}/ready`,
        'POST',
        readyBody,
        context.ownerCookie,
      ),
    );
    expect(await responseJson(ownerReady)).toMatchObject({ status: 'waiting' });
    const friendReady = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${selecting.transition.transitionId}/ready`,
        'POST',
        readyBody,
        friend.cookie,
      ),
    );
    expect(await responseJson(friendReady)).toMatchObject({
      status: 'committed',
      playbackRevision: before.snapshot.playback.revision + 1,
    });
    expect(realtime.internal.room.playback).toMatchObject({
      queueItemId: firstQueueItemId,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
      state: 'playing',
    });

    const endedBaseRevision = realtime.internal.room.playback.revision;
    const endedBody = {
      type: 'ended',
      baseRevision: endedBaseRevision,
      queueItemId: firstQueueItemId,
      mediaKind: 'youtube',
      observedPositionSeconds: 0.1,
      durationSeconds: 0.1,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    };
    const firstEnded = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        endedBody,
        context.ownerCookie,
        'authority-ended-command-0001',
      ),
    );
    const firstTransition = await responseJson(firstEnded);
    expect(firstEnded.status).toBe(202);
    expect(firstTransition.transition.target.queueItemId).toBe(secondQueueItemId);
    const originalDeadline = firstTransition.transition.deadlineAtMs;

    const duplicateEnded = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        endedBody,
        friend.cookie,
        'authority-ended-command-0002',
      ),
    );
    const duplicateTransition = await responseJson(duplicateEnded);
    expect(duplicateEnded.status).toBe(202);
    expect(duplicateTransition.transition.transitionId).toBe(
      firstTransition.transition.transitionId,
    );
    expect(duplicateTransition.transition.deadlineAtMs).toBe(originalDeadline);
    expect(
      realtime.messages.filter(
        (message) =>
          message.event?.type === 'pro-playback-prepare' &&
          message.event.transitionId === firstTransition.transition.transitionId,
      ),
    ).toHaveLength(1);

    realtime.internal.room.pendingPlaybackTransition.deadlineAtMs = Date.now() - 1;
    const committed = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(committed.snapshot.playback).toMatchObject({
      revision: endedBaseRevision + 1,
      queueItemId: secondQueueItemId,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
      state: 'playing',
    });
    expect(realtime.internal.room.pendingPlaybackTransition).toBeNull();

    const staleObservation = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        endedBody,
        context.ownerCookie,
        'authority-ended-command-stale-0003',
      ),
    );
    expect(staleObservation.status).toBe(409);
    await expect(staleObservation.json()).resolves.toEqual({
      error: 'PLAYBACK_REVISION_CONFLICT',
    });

    const superseded = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: realtime.internal.room.playback.revision,
          queueItemId: firstQueueItemId,
        },
        context.ownerCookie,
        'authority-superseded-select-0004',
      ),
    );
    expect(superseded.status).toBe(202);
    const pending = await responseJson(superseded);
    const paused = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        { type: 'pause', baseRevision: realtime.internal.room.playback.revision },
        context.ownerCookie,
        'authority-superseding-pause-0005',
      ),
    );
    expect(paused.status).toBe(200);
    const cancel = realtime.messages.find(
      (message) =>
        message.event?.type === 'pro-playback-cancel' &&
        message.event.transitionId === pending.transition.transitionId,
    )?.event;
    expect(cancel).toEqual({
      type: 'pro-playback-cancel',
      transitionId: pending.transition.transitionId,
      serverTimeMs: expect.any(Number),
      reason: 'superseded',
    });
  });

  it('accepts ENDED only for the exact playing identity at a defensible end position', async () => {
    const context = await activatedRoom();
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-ended-guards')).status,
    ).toBe(200);
    await selectAndCommit(context, firstQueueItemId, {
      key: 'authority-ended-guards-select-0001',
    });
    const internal = context.worker as unknown as { room: Record<string, any> };
    const command = (extra: Record<string, unknown> = {}) => ({
      type: 'ended',
      baseRevision: internal.room.playback.revision,
      queueItemId: firstQueueItemId,
      mediaKind: 'youtube',
      observedPositionSeconds: 299.9,
      durationSeconds: 300,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
      ...extra,
    });

    // A local player must not advance the room merely because it emitted an
    // early/spurious ENDED event. The canonical server clock is authoritative.
    const early = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        command(),
        context.ownerCookie,
        'authority-ended-guards-early-0002',
      ),
    );
    expect(early.status).toBe(409);
    await expect(early.json()).resolves.toEqual({ error: 'PLAYBACK_OBSERVATION_NOT_AT_END' });

    internal.room.playback.positionSeconds = 299.9;
    internal.room.playback.updatedAtMs = Date.now();
    internal.room.playback.state = 'paused';
    const paused = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        command(),
        context.ownerCookie,
        'authority-ended-guards-paused-0003',
      ),
    );
    expect(paused.status).toBe(409);
    await expect(paused.json()).resolves.toEqual({ error: 'PLAYBACK_OBSERVATION_STALE' });

    internal.room.playback.state = 'playing';
    const wrongMedia = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        command({ mediaKind: 'file' }),
        context.ownerCookie,
        'authority-ended-guards-media-0004',
      ),
    );
    expect(wrongMedia.status).toBe(409);
    await expect(wrongMedia.json()).resolves.toEqual({ error: 'PLAYBACK_OBSERVATION_STALE' });

    const accepted = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        command(),
        context.ownerCookie,
        'authority-ended-guards-valid-0005',
      ),
    );
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({
      status: 'preparing',
      transition: { target: { queueItemId: secondQueueItemId } },
    });
  });

  it('supports an aligned unknown-duration ENDED observation after a bounded playing floor', async () => {
    const context = await activatedRoom();
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-ended-live')).status,
    ).toBe(200);
    await selectAndCommit(context, firstQueueItemId, {
      positionSeconds: 40,
      key: 'authority-ended-live-select-0001',
    });
    const internal = context.worker as unknown as { room: Record<string, any> };
    internal.room.playback.updatedAtMs = Date.now() - 1_000;

    const response = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'ended',
          baseRevision: internal.room.playback.revision,
          queueItemId: firstQueueItemId,
          mediaKind: 'youtube',
          observedPositionSeconds: 41,
          durationSeconds: null,
          youtubeVideoId: 'dQw4w9WgXcQ',
          youtubeSubIndex: 0,
        },
        context.ownerCookie,
        'authority-ended-live-valid-0002',
      ),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: 'preparing',
      transition: { target: { queueItemId: secondQueueItemId } },
    });
  });

  it('commits immediately once every frozen cohort member has reported ready or failed', async () => {
    const context = await activatedRoom();
    const realtime = installRealtimeRecorder(context);
    const friend = await addMember(context);
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-terminal-reports')).status,
    ).toBe(200);

    const before = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const selectedResponse = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: before.snapshot.playback.revision,
          queueItemId: firstQueueItemId,
        },
        context.ownerCookie,
        'authority-terminal-reports-select-0001',
      ),
    );
    expect(selectedResponse.status).toBe(202);
    const selected = await responseJson(selectedResponse);
    expect(realtime.internal.room.pendingPlaybackTransition.cohort).toHaveLength(2);

    const ownerReady = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${selected.transition.transitionId}/ready`,
        'POST',
        { basePlaybackRevision: selected.transition.basePlaybackRevision, status: 'ready' },
        context.ownerCookie,
      ),
    );
    await expect(ownerReady.json()).resolves.toMatchObject({ status: 'waiting' });

    const friendFailed = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${selected.transition.transitionId}/ready`,
        'POST',
        { basePlaybackRevision: selected.transition.basePlaybackRevision, status: 'failed' },
        friend.cookie,
      ),
    );
    expect(friendFailed.status).toBe(200);
    await expect(friendFailed.json()).resolves.toMatchObject({
      status: 'committed',
      playbackRevision: before.snapshot.playback.revision + 1,
    });
    expect(realtime.internal.room.pendingPlaybackTransition).toBeNull();
    expect(realtime.internal.room.playback).toMatchObject({
      revision: before.snapshot.playback.revision + 1,
      queueItemId: firstQueueItemId,
      state: 'playing',
    });
  });

  it('commits immediately when the last unreported cohort member leaves', async () => {
    const context = await activatedRoom();
    const realtime = installRealtimeRecorder(context);
    const failed = await addMember(context);
    const departing = await addMember(context);
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-terminal-leave')).status,
    ).toBe(200);

    const before = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const selectedResponse = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: before.snapshot.playback.revision,
          queueItemId: firstQueueItemId,
        },
        context.ownerCookie,
        'authority-terminal-leave-select-0001',
      ),
    );
    expect(selectedResponse.status).toBe(202);
    const selected = await responseJson(selectedResponse);
    expect(realtime.internal.room.pendingPlaybackTransition.cohort).toHaveLength(3);

    await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${selected.transition.transitionId}/ready`,
        'POST',
        { basePlaybackRevision: selected.transition.basePlaybackRevision, status: 'ready' },
        context.ownerCookie,
      ),
    );
    const failedResponse = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${selected.transition.transitionId}/ready`,
        'POST',
        { basePlaybackRevision: selected.transition.basePlaybackRevision, status: 'failed' },
        failed.cookie,
      ),
    );
    await expect(failedResponse.json()).resolves.toMatchObject({ status: 'waiting' });
    expect(realtime.internal.room.pendingPlaybackTransition).not.toBeNull();

    const leave = await context.worker.fetch(
      request('/presence/current', { method: 'DELETE' }, departing.cookie),
    );
    expect(leave.status).toBe(200);
    expect(realtime.internal.room.pendingPlaybackTransition).toBeNull();
    expect(realtime.internal.room.playback).toMatchObject({
      revision: before.snapshot.playback.revision + 1,
      queueItemId: firstQueueItemId,
      state: 'playing',
    });
  });

  it('keeps waiting when a frozen cohort member has not reported, then commits at the deadline', async () => {
    const context = await activatedRoom();
    const realtime = installRealtimeRecorder(context);
    await addMember(context);
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-missing-report')).status,
    ).toBe(200);

    const before = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const selectedResponse = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: before.snapshot.playback.revision,
          queueItemId: firstQueueItemId,
        },
        context.ownerCookie,
        'authority-missing-report-select-0001',
      ),
    );
    expect(selectedResponse.status).toBe(202);
    const selected = await responseJson(selectedResponse);
    expect(realtime.internal.room.pendingPlaybackTransition.cohort).toHaveLength(2);

    const ownerFailed = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${selected.transition.transitionId}/ready`,
        'POST',
        { basePlaybackRevision: selected.transition.basePlaybackRevision, status: 'failed' },
        context.ownerCookie,
      ),
    );
    expect(ownerFailed.status).toBe(200);
    await expect(ownerFailed.json()).resolves.toMatchObject({
      status: 'waiting',
      playbackRevision: before.snapshot.playback.revision,
    });
    expect(realtime.internal.room.pendingPlaybackTransition).not.toBeNull();
    expect(realtime.internal.room.playback.revision).toBe(before.snapshot.playback.revision);

    realtime.internal.room.pendingPlaybackTransition.deadlineAtMs = Date.now() - 1;
    const committed = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(committed.snapshot.playback).toMatchObject({
      revision: before.snapshot.playback.revision + 1,
      queueItemId: firstQueueItemId,
      state: 'playing',
    });
    expect(realtime.internal.room.pendingPlaybackTransition).toBeNull();
  });

  it('lets a late member arm PREPARE without extending its fixed cohort', async () => {
    const context = await activatedRoom();
    const realtime = installRealtimeRecorder(context);
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-late-join')).status,
    ).toBe(200);
    const before = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const selected = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: before.snapshot.playback.revision,
          queueItemId: firstQueueItemId,
        },
        context.ownerCookie,
        'authority-late-join-select-0001',
      ),
    );
    expect(selected.status).toBe(202);
    const prepared = await responseJson(selected);
    expect(realtime.internal.room.pendingPlaybackTransition.cohort).toHaveLength(1);

    const lateMember = await addMember(context);
    expect(realtime.internal.room.pendingPlaybackTransition.cohort).toHaveLength(1);
    const lateTicket = await context.worker.fetch(
      request('/signaling-tickets', { method: 'POST' }, lateMember.cookie),
    );
    expect(lateTicket.status).toBe(200);
    await expect(lateTicket.json()).resolves.toMatchObject({
      pendingPlaybackTransition: {
        type: 'pro-playback-prepare',
        transitionId: prepared.transition.transitionId,
        deadlineAtMs: prepared.transition.deadlineAtMs,
      },
    });

    const readyBody = {
      basePlaybackRevision: prepared.transition.basePlaybackRevision,
      status: 'ready',
    };
    const lateReady = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${prepared.transition.transitionId}/ready`,
        'POST',
        readyBody,
        lateMember.cookie,
      ),
    );
    expect(lateReady.status).toBe(409);
    await expect(lateReady.json()).resolves.toEqual({
      error: 'PLAYBACK_TRANSITION_NOT_IN_COHORT',
    });
    const ownerReady = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${prepared.transition.transitionId}/ready`,
        'POST',
        readyBody,
        context.ownerCookie,
      ),
    );
    await expect(ownerReady.json()).resolves.toMatchObject({ status: 'committed' });
  });

  it('keeps takeover identity rotation and departure shrink inside the original cohort', async () => {
    const context = await activatedRoom();
    const realtime = installRealtimeRecorder(context);
    const friend = await addMember(context);
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-fixed-cohort')).status,
    ).toBe(200);
    const before = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const selected = await responseJson(
      await context.worker.fetch(
        jsonRequest(
          '/playback/commands',
          'POST',
          {
            type: 'select',
            baseRevision: before.snapshot.playback.revision,
            queueItemId: firstQueueItemId,
          },
          context.ownerCookie,
          'authority-fixed-cohort-select-0001',
        ),
      ),
    );
    const originalOwnerIncarnation = before.snapshot.viewer.presenceIncarnationId;
    const originalCohort = [...realtime.internal.room.pendingPlaybackTransition.cohort] as string[];
    expect(originalCohort).toHaveLength(2);

    const takeover = await context.worker.fetch(
      jsonRequest('/presence/enter', 'POST', { takeover: true }, context.ownerCookie),
    );
    expect(takeover.status).toBe(200);
    const takeoverEnvelope = await responseJson(takeover);
    bindCookiePresence(context.ownerCookie, takeoverEnvelope);
    const replacementIncarnation = takeoverEnvelope.snapshot.viewer.presenceIncarnationId;
    expect(replacementIncarnation).not.toBe(originalOwnerIncarnation);
    expect(realtime.internal.room.pendingPlaybackTransition.cohort).not.toContain(
      originalOwnerIncarnation,
    );
    expect(realtime.internal.room.pendingPlaybackTransition.cohort).toContain(
      replacementIncarnation,
    );
    expect(realtime.internal.room.pendingPlaybackTransition.cohort).toHaveLength(2);

    const ownerReady = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${selected.transition.transitionId}/ready`,
        'POST',
        { basePlaybackRevision: selected.transition.basePlaybackRevision, status: 'ready' },
        context.ownerCookie,
      ),
    );
    await expect(ownerReady.json()).resolves.toMatchObject({ status: 'waiting' });
    expect(
      (
        await context.worker.fetch(
          request('/presence/current', { method: 'DELETE' }, friend.cookie),
        )
      ).status,
    ).toBe(200);
    expect(realtime.internal.room.pendingPlaybackTransition).toBeNull();
    expect(realtime.internal.room.playback).toMatchObject({
      queueItemId: firstQueueItemId,
      state: 'playing',
    });
  });

  it('rendezvous-resumes paused media, rendezvous-seeks while playing, and seeks paused media directly', async () => {
    const context = await activatedRoom();
    const realtime = installRealtimeRecorder(context);
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-resume-seek')).status,
    ).toBe(200);
    const paused = await selectAndCommit(context, firstQueueItemId, {
      state: 'paused',
      positionSeconds: 12,
      key: 'authority-resume-seek-select-0001',
    });

    const resumedResponse = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        { type: 'play', baseRevision: paused.snapshot.playback.revision },
        context.ownerCookie,
        'authority-resume-seek-play-0002',
      ),
    );
    expect(resumedResponse.status).toBe(202);
    const resumed = await responseJson(resumedResponse);
    expect(resumed.transition.target).toMatchObject({
      queueItemId: firstQueueItemId,
      state: 'playing',
      positionSeconds: 12,
    });
    expect(
      realtime.internal.room.pendingPlaybackTransition.deadlineAtMs -
        realtime.internal.room.pendingPlaybackTransition.createdAtMs,
    ).toBe(3_000);
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/playback/transitions/${resumed.transition.transitionId}/ready`,
            'POST',
            { basePlaybackRevision: resumed.transition.basePlaybackRevision, status: 'ready' },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    const resumeCommit = [...realtime.messages]
      .reverse()
      .find((message) => message.event?.transitionId === resumed.transition.transitionId)?.event;
    expect(resumeCommit.executeAtMs - resumeCommit.serverTimeMs).toBe(700);

    const playingRevision = realtime.internal.room.playback.revision;
    const seekPlayingResponse = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        { type: 'seek', baseRevision: playingRevision, positionSeconds: 33 },
        context.ownerCookie,
        'authority-resume-seek-playing-0003',
      ),
    );
    expect(seekPlayingResponse.status).toBe(202);
    const seekPlaying = await responseJson(seekPlayingResponse);
    expect(seekPlaying.transition.target).toMatchObject({
      state: 'playing',
      positionSeconds: 33,
    });
    expect(
      realtime.internal.room.pendingPlaybackTransition.deadlineAtMs -
        realtime.internal.room.pendingPlaybackTransition.createdAtMs,
    ).toBe(3_000);
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/playback/transitions/${seekPlaying.transition.transitionId}/ready`,
            'POST',
            {
              basePlaybackRevision: seekPlaying.transition.basePlaybackRevision,
              status: 'ready',
            },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    const seekCommit = [...realtime.messages]
      .reverse()
      .find(
        (message) => message.event?.transitionId === seekPlaying.transition.transitionId,
      )?.event;
    expect(seekCommit.executeAtMs - seekCommit.serverTimeMs).toBe(700);

    const pauseResponse = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        { type: 'pause', baseRevision: realtime.internal.room.playback.revision },
        context.ownerCookie,
        'authority-resume-seek-pause-0004',
      ),
    );
    expect(pauseResponse.status).toBe(200);
    const pauseBody = await responseJson(pauseResponse);
    expect(pauseBody.status).toBe('committed');
    expect(realtime.internal.room.pendingPlaybackTransition).toBeNull();

    const seekPausedResponse = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'seek',
          baseRevision: pauseBody.playback.revision,
          positionSeconds: 44,
        },
        context.ownerCookie,
        'authority-resume-seek-paused-0005',
      ),
    );
    expect(seekPausedResponse.status).toBe(200);
    await expect(seekPausedResponse.json()).resolves.toMatchObject({
      status: 'committed',
      playback: { state: 'paused', positionSeconds: 44 },
    });
  });

  it('wakes resume-playing through a sole-member PREPARE from the frozen position', async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse('2026-07-20T03:00:00.000Z');
    vi.setSystemTime(startedAtMs);
    const context = await activatedRoom();
    const realtime = installRealtimeRecorder(context);
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-wake-playing')).status,
    ).toBe(200);
    await selectAndCommit(context, firstQueueItemId, {
      positionSeconds: 15,
      key: 'authority-wake-playing-select-0001',
    });
    vi.setSystemTime(startedAtMs + 10_000);
    expect(
      (
        await context.worker.fetch(
          request('/presence/current', { method: 'DELETE' }, context.ownerCookie),
        )
      ).status,
    ).toBe(200);
    const frozenPosition = realtime.internal.room.playback.positionSeconds as number;
    expect(frozenPosition).toBeCloseTo(24.301, 5);

    vi.setSystemTime(startedAtMs + 2 * 60 * 60 * 1_000);
    const returning = await addMember(context);
    const pending = realtime.internal.room.pendingPlaybackTransition;
    expect(pending).toMatchObject({
      resumeFromSleep: true,
      target: {
        queueItemId: firstQueueItemId,
        state: 'playing',
        positionSeconds: frozenPosition,
      },
    });
    expect(pending.deadlineAtMs - pending.createdAtMs).toBe(3_000);
    expect(pending.cohort).toEqual([returning.envelope.snapshot.viewer.presenceIncarnationId]);
    expect(realtime.internal.room.playback.positionSeconds).toBe(frozenPosition);

    const ticket = await context.worker.fetch(
      request('/signaling-tickets', { method: 'POST' }, returning.cookie),
    );
    expect(ticket.status).toBe(200);
    await expect(ticket.json()).resolves.toMatchObject({
      pendingPlaybackTransition: {
        type: 'pro-playback-prepare',
        transitionId: pending.transitionId,
        target: { positionSeconds: frozenPosition, state: 'playing' },
      },
    });
    const ready = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${pending.transitionId}/ready`,
        'POST',
        { basePlaybackRevision: pending.basePlaybackRevision, status: 'ready' },
        returning.cookie,
      ),
    );
    await expect(ready.json()).resolves.toMatchObject({ status: 'committed' });
    expect(realtime.internal.room.playback.positionSeconds).toBe(frozenPosition);
    const wakeCommit = [...realtime.messages]
      .reverse()
      .find((message) => message.event?.transitionId === pending.transitionId)?.event;
    expect(wakeCommit.executeAtMs - wakeCommit.serverTimeMs).toBe(700);
  });

  it('keeps paused wake paused and does not create a playback transition', async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse('2026-07-20T04:00:00.000Z');
    vi.setSystemTime(startedAtMs);
    const context = await activatedRoom();
    const realtime = installRealtimeRecorder(context);
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-wake-paused')).status,
    ).toBe(200);
    await selectAndCommit(context, firstQueueItemId, {
      state: 'paused',
      positionSeconds: 27,
      key: 'authority-wake-paused-select-0001',
    });
    await context.worker.fetch(
      request('/presence/current', { method: 'DELETE' }, context.ownerCookie),
    );
    vi.setSystemTime(startedAtMs + 6 * 60 * 60 * 1_000);
    const returning = await addMember(context);
    expect(realtime.internal.room.pendingPlaybackTransition).toBeNull();
    expect(realtime.internal.room.playback).toMatchObject({
      queueItemId: firstQueueItemId,
      state: 'paused',
      positionSeconds: 27,
    });
    const ticket = await context.worker.fetch(
      request('/signaling-tickets', { method: 'POST' }, returning.cookie),
    );
    await expect(ticket.json()).resolves.toMatchObject({ pendingPlaybackTransition: null });
  });

  it('keeps sleeping play, pause, and seek commands on the frozen timeline', async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse('2026-07-20T05:00:00.000Z');
    vi.setSystemTime(startedAtMs);
    const context = await activatedRoom();
    const realtime = installRealtimeRecorder(context);
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-sleep-clock')).status,
    ).toBe(200);
    await selectAndCommit(context, firstQueueItemId, {
      positionSeconds: 12,
      key: 'authority-sleep-clock-select-0001',
    });
    await context.worker.fetch(
      request('/presence/current', { method: 'DELETE' }, context.ownerCookie),
    );
    const frozenPosition = realtime.internal.room.playback.positionSeconds as number;

    vi.setSystemTime(startedAtMs + 60 * 60 * 1_000);
    const paused = await createInternalDeveloperCommand(
      context.worker,
      DEVELOPER_KEY_ID,
      'authority-sleep-clock-pause-0002',
      { type: 'pause' },
    );
    await expect(paused.json()).resolves.toMatchObject({ status: 'applied' });
    expect(realtime.internal.room.playback).toMatchObject({
      state: 'paused',
      positionSeconds: frozenPosition,
    });

    await createInternalDeveloperCommand(
      context.worker,
      DEVELOPER_KEY_ID,
      'authority-sleep-clock-seek-0003',
      { type: 'seek', positionSeconds: 42 },
    );
    expect(realtime.internal.room.playback).toMatchObject({
      state: 'paused',
      positionSeconds: 42,
    });
    await createInternalDeveloperCommand(
      context.worker,
      DEVELOPER_KEY_ID,
      'authority-sleep-clock-play-0004',
      { type: 'play' },
    );
    expect(realtime.internal.room.playback).toMatchObject({
      state: 'playing',
      positionSeconds: 42,
    });

    vi.setSystemTime(startedAtMs + 2 * 60 * 60 * 1_000);
    await createInternalDeveloperCommand(
      context.worker,
      DEVELOPER_KEY_ID,
      'authority-sleep-clock-seek-0005',
      { type: 'seek', positionSeconds: 7 },
    );
    expect(realtime.internal.room.playback).toMatchObject({
      state: 'playing',
      positionSeconds: 7,
    });
  });

  it('schedules a next-tick alarm when persistence observes an already-due PREPARE', async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse('2026-07-20T06:00:00.000Z');
    vi.setSystemTime(startedAtMs);
    const context = await activatedRoom();
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-due-alarm')).status,
    ).toBe(200);
    const before = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const response = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: before.snapshot.playback.revision,
          queueItemId: firstQueueItemId,
        },
        context.ownerCookie,
        'authority-due-alarm-select-0001',
      ),
    );
    expect(response.status).toBe(202);
    const internal = context.worker as unknown as {
      room: Record<string, any>;
      scheduledAlarmMs: number | null;
      persist(): Promise<boolean>;
      alarm(): Promise<void>;
    };
    context.state.storage.alarm = null;
    internal.scheduledAlarmMs = null;
    vi.setSystemTime(startedAtMs + 3_001);

    await internal.persist();
    expect(context.state.storage.alarm).toBe(startedAtMs + 3_002);
    vi.setSystemTime(startedAtMs + 3_002);
    await internal.alarm();
    expect(internal.room.pendingPlaybackTransition).toBeNull();
    expect(internal.room.playback).toMatchObject({
      queueItemId: firstQueueItemId,
      state: 'playing',
    });
  });

  it('applies Developer API playback while sleeping without a browser relay and preserves the queue', async () => {
    const context = await activatedRoom();
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-sleeping-developer'))
        .status,
    ).toBe(200);
    expect(
      (
        await context.worker.fetch(
          request('/presence/current', { method: 'DELETE' }, context.ownerCookie),
        )
      ).status,
    ).toBe(200);

    const command = await createInternalDeveloperCommand(
      context.worker,
      DEVELOPER_KEY_ID,
      'authority-sleeping-play-0001',
      { type: 'play_item', queueItemId: firstQueueItemId },
    );
    expect(command.status).toBe(202);
    await expect(command.json()).resolves.toMatchObject({
      status: 'applied',
      resultCode: 'applied',
    });
    const internal = context.worker as unknown as { room: Record<string, any> };
    expect(internal.room).toMatchObject({
      runtime: 'sleeping',
      currentQueueItemId: firstQueueItemId,
      playback: { queueItemId: firstQueueItemId, state: 'playing' },
    });

    const restarted = new MusixquareProRoom(
      context.state as never,
      environment(context.bucket) as never,
    );
    const queue = await responseJson(await internalDeveloperRead(restarted, 'queue'));
    expect(queue.items.map((item: Record<string, unknown>) => item.queueItemId)).toEqual([
      firstQueueItemId,
      secondQueueItemId,
    ]);
  });

  it('atomically stops the selected item at zero without losing its media identity', async () => {
    const context = await activatedRoom();
    const realtime = installRealtimeRecorder(context);
    expect((await replacePlaylist(context, duplicateVideoPlaylist, 'authority-stop')).status).toBe(
      200,
    );
    const before = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const select = await responseJson(
      await context.worker.fetch(
        jsonRequest(
          '/playback/commands',
          'POST',
          {
            type: 'select',
            baseRevision: before.snapshot.playback.revision,
            queueItemId: firstQueueItemId,
          },
          context.ownerCookie,
          'authority-stop-select-0001',
        ),
      ),
    );
    const ready = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${select.transition.transitionId}/ready`,
        'POST',
        { basePlaybackRevision: select.transition.basePlaybackRevision, status: 'ready' },
        context.ownerCookie,
      ),
    );
    expect(ready.status).toBe(200);

    const selected = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const stopped = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        { type: 'stop', baseRevision: selected.snapshot.playback.revision },
        context.ownerCookie,
        'authority-stop-command-0002',
      ),
    );
    expect(stopped.status).toBe(200);
    const stoppedBody = await responseJson(stopped);
    expect(stoppedBody).toMatchObject({
      status: 'committed',
      playback: {
        state: 'paused',
        queueItemId: firstQueueItemId,
        positionSeconds: 0,
        youtubeVideoId: 'dQw4w9WgXcQ',
        youtubeSubIndex: 0,
      },
    });
    const stopCommit = [...realtime.messages]
      .reverse()
      .find(
        (message) =>
          message.event?.type === 'pro-playback-commit' &&
          message.event.playback?.state === 'paused' &&
          message.event.playback?.positionSeconds === 0,
      )?.event;
    expect(stopCommit).toEqual({
      type: 'pro-playback-commit',
      transitionId: null,
      serverTimeMs: expect.any(Number),
      executeAtMs: expect.any(Number),
      playback: expect.objectContaining({
        queueItemId: firstQueueItemId,
        state: 'paused',
        positionSeconds: 0,
      }),
    });

    const stoppedAgain = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        { type: 'stop', baseRevision: stoppedBody.playback.revision },
        context.ownerCookie,
        'authority-stop-command-0003',
      ),
    );
    expect(stoppedAgain.status).toBe(200);
    await expect(stoppedAgain.json()).resolves.toMatchObject({
      status: 'unchanged',
      playback: { positionSeconds: 0 },
    });
  });

  it('persists a playback PREPARE before dispatch and removes it only after full delivery', async () => {
    const context = await activatedRoom();
    const internal = context.worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    internal.room.pendingPresenceBroadcast = null;
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'durable-outbox-persist-first'))
        .status,
    ).toBe(200);

    const dispatch = vi.fn(async (dispatchRequest: Request) => {
      const message = (await dispatchRequest.clone().json()) as Record<string, any>;
      const stored = context.state.storage.data.get('pro-room:v2:core') as {
        core: Record<string, any>;
      };
      expect(stored.core.pendingPlaybackBroadcasts).toHaveLength(1);
      expect(stored.core.pendingPlaybackBroadcasts[0].event).toEqual(message.event);
      return Response.json({ broadcast: true, eligible: 1, sent: 1 });
    });
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: dispatch })),
    };

    const response = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: internal.room.playback.revision,
          queueItemId: firstQueueItemId,
        },
        context.ownerCookie,
        'durable-outbox-persist-first-command',
      ),
    );
    expect(response.status).toBe(202);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(internal.room.pendingPlaybackBroadcasts).toEqual([]);
    expect(
      (context.state.storage.data.get('pro-room:v2:core') as { core: Record<string, any> }).core
        .pendingPlaybackBroadcasts,
    ).toEqual([]);
  });

  it('keeps a failed playback dispatch durable and clears it after a restarted alarm retry', async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.UTC(2026, 6, 20, 1, 2, 3);
    vi.setSystemTime(startedAtMs);
    const context = await activatedRoom();
    const internal = context.worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    internal.room.pendingPresenceBroadcast = null;
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'durable-outbox-restart')).status,
    ).toBe(200);
    const failedDispatch = vi.fn(async () => {
      throw new Error('signaling unavailable');
    });
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: failedDispatch })),
    };

    const response = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: internal.room.playback.revision,
          queueItemId: firstQueueItemId,
        },
        context.ownerCookie,
        'durable-outbox-restart-command',
      ),
    );
    expect(response.status).toBe(202);
    const pending = internal.room.pendingPlaybackBroadcasts[0] as Record<string, any>;
    expect(pending).toMatchObject({ kind: 'prepare', attempts: 1 });
    expect(pending.retryAtMs).toBe(startedAtMs + 1_000);
    expect(context.state.storage.alarm).toBe(pending.retryAtMs);

    const successfulDispatch = vi.fn(async () =>
      Response.json({ broadcast: true, eligible: 1, sent: 1 }),
    );
    const restarted = new MusixquareProRoom(
      context.state as never,
      {
        ...environment(context.bucket),
        PRO_SIGNALING_ROOMS: {
          idFromName: vi.fn((value: string) => value),
          get: vi.fn(() => ({ fetch: successfulDispatch })),
        },
      } as never,
    );
    vi.setSystemTime(pending.retryAtMs);
    await restarted.alarm();

    expect(successfulDispatch).toHaveBeenCalledTimes(1);
    expect(
      (restarted as unknown as { room: Record<string, any> }).room.pendingPlaybackBroadcasts,
    ).toEqual([]);
    expect(
      (context.state.storage.data.get('pro-room:v2:core') as { core: Record<string, any> }).core
        .pendingPlaybackBroadcasts,
    ).toEqual([]);
  });

  it('retries a partial playback delivery instead of treating HTTP 200 as success', async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.UTC(2026, 6, 20, 2, 3, 4);
    vi.setSystemTime(startedAtMs);
    const context = await activatedRoom();
    const internal = context.worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    internal.room.pendingPresenceBroadcast = null;
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'durable-outbox-partial')).status,
    ).toBe(200);
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ broadcast: true, eligible: 2, sent: 1 }))
      .mockResolvedValue(Response.json({ broadcast: true, eligible: 1, sent: 1 }));
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: dispatch })),
    };

    const response = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: internal.room.playback.revision,
          queueItemId: firstQueueItemId,
        },
        context.ownerCookie,
        'durable-outbox-partial-command',
      ),
    );
    expect(response.status).toBe(202);
    expect(internal.room.pendingPlaybackBroadcasts[0]).toMatchObject({ attempts: 1 });
    const retryAtMs = internal.room.pendingPlaybackBroadcasts[0].retryAtMs as number;
    vi.setSystemTime(retryAtMs);
    await context.worker.alarm();

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(internal.room.pendingPlaybackBroadcasts).toEqual([]);
  });

  it('supersedes an undelivered PREPARE with a durable CANCEL then COMMIT FIFO pair', async () => {
    const context = await activatedRoom();
    const realtime = installRealtimeRecorder(context);
    realtime.internal.room.pendingPresenceBroadcast = null;
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'durable-outbox-fifo')).status,
    ).toBe(200);
    await selectAndCommit(context, firstQueueItemId, {
      key: 'durable-outbox-fifo-initial-select',
    });
    realtime.messages.splice(0);
    realtime.fetch.mockClear();
    realtime.fetch.mockImplementationOnce(async (dispatchRequest: Request) => {
      realtime.messages.push((await dispatchRequest.clone().json()) as Record<string, any>);
      return Response.json({ broadcast: true, eligible: 2, sent: 1 });
    });
    realtime.fetch.mockImplementationOnce(async (dispatchRequest: Request) => {
      realtime.messages.push((await dispatchRequest.clone().json()) as Record<string, any>);
      const stored = context.state.storage.data.get('pro-room:v2:core') as {
        core: Record<string, any>;
      };
      expect(stored.core.pendingPlaybackBroadcasts.map((record: any) => record.kind)).toEqual([
        'cancel',
        'commit',
      ]);
      return Response.json({ broadcast: true, eligible: 1, sent: 1 });
    });

    const selected = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: realtime.internal.room.playback.revision,
          queueItemId: secondQueueItemId,
        },
        context.ownerCookie,
        'durable-outbox-fifo-pending-select',
      ),
    );
    expect(selected.status).toBe(202);
    const paused = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        { type: 'pause', baseRevision: realtime.internal.room.playback.revision },
        context.ownerCookie,
        'durable-outbox-fifo-pause',
      ),
    );
    expect(paused.status).toBe(200);
    expect(realtime.messages.map((message) => message.event.type)).toEqual([
      'pro-playback-prepare',
      'pro-playback-cancel',
      'pro-playback-commit',
    ]);
    expect(realtime.internal.room.pendingPlaybackBroadcasts).toEqual([]);
  });

  it('replaces an undelivered zero-start PREPARE with its explicitly marked COMMIT', async () => {
    const context = await activatedRoom();
    const realtime = installRealtimeRecorder(context);
    realtime.internal.room.pendingPresenceBroadcast = null;
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'durable-outbox-deadline')).status,
    ).toBe(200);
    realtime.messages.splice(0);
    realtime.fetch.mockClear();
    realtime.fetch.mockImplementation(async (dispatchRequest: Request) => {
      const message = (await dispatchRequest.clone().json()) as Record<string, any>;
      realtime.messages.push(message);
      if (message.event?.type === 'pro-playback-prepare') {
        return Response.json({ broadcast: true, eligible: 2, sent: 1 });
      }
      if (message.event?.type === 'pro-playback-commit') {
        const stored = context.state.storage.data.get('pro-room:v2:core') as {
          core: Record<string, any>;
        };
        expect(stored.core.pendingPlaybackBroadcasts).toHaveLength(1);
        expect(stored.core.pendingPlaybackBroadcasts[0].kind).toBe('commit');
      }
      return Response.json({ broadcast: true, eligible: 1, sent: 1 });
    });

    const selected = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: realtime.internal.room.playback.revision,
          queueItemId: firstQueueItemId,
        },
        context.ownerCookie,
        'durable-outbox-deadline-select',
      ),
    );
    expect(selected.status).toBe(202);
    const expiredDeadlineAtMs = Date.now() - 1;
    realtime.internal.room.pendingPlaybackTransition.createdAtMs = expiredDeadlineAtMs - 2_999;
    realtime.internal.room.pendingPlaybackTransition.deadlineAtMs = expiredDeadlineAtMs;
    const snapshot = await context.worker.fetch(request('/snapshot', {}, context.ownerCookie));
    expect(snapshot.status).toBe(200);

    const playbackMessages = realtime.messages.filter((message) =>
      String(message.event?.type || '').startsWith('pro-playback-'),
    );
    expect(playbackMessages.map((message) => message.event.type)).toEqual([
      'pro-playback-prepare',
      'pro-playback-commit',
    ]);
    const commit = playbackMessages[1]?.event;
    expect(commit.executeAtMs - commit.serverTimeMs).toBe(699);
    expect(realtime.internal.room.pendingPlaybackTransition).toBeNull();
    expect(realtime.internal.room.pendingPlaybackBroadcasts).toEqual([]);
  });

  it('migrates a stored coordinator fence without touching persisted playlist rows', async () => {
    const context = await activatedRoom();
    expect(
      (await replacePlaylist(context, duplicateVideoPlaylist, 'authority-stored-migration')).status,
    ).toBe(200);
    const stored = structuredClone(context.state.storage.data.get('pro-room:v2:core')) as {
      core: Record<string, any>;
      playlistOrder: string[];
    };
    stored.core.presence.coordinatorParticipantId =
      context.activationEnvelope.snapshot.viewer.participantId;
    stored.core.presence.coordinatorEpoch = 7;
    stored.core.playback.coordinatorEpoch = 7;
    stored.core.playback.revision = 9;
    context.state.storage.data.set('pro-room:v2:core', stored);

    const restarted = new MusixquareProRoom(
      context.state as never,
      environment(context.bucket) as never,
    );
    const snapshot = await responseJson(
      await restarted.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(snapshot.snapshot.presence).toMatchObject({
      coordinatorParticipantId: null,
      coordinatorEpoch: 8,
    });
    expect(snapshot.snapshot.playback).toMatchObject({
      coordinatorEpoch: 8,
      revision: 10,
    });
    expect(
      snapshot.snapshot.playlist.map((item: Record<string, unknown>) => item.queueItemId),
    ).toEqual([firstQueueItemId, secondQueueItemId]);
    expect(stored.playlistOrder).toEqual([firstQueueItemId, secondQueueItemId]);
  });

  it('lets any active member change shared effects and remove another member', async () => {
    const context = await activatedRoom();
    installRealtimeRecorder(context);
    const friend = await addMember(context);
    const epoch = friend.envelope.snapshot.presence.coordinatorEpoch as number;
    const effects = {
      reverb: {
        mixPercent: 20,
        decaySeconds: 1,
        preDelaySeconds: 0.02,
        lowCutPercent: 0,
        highCutPercent: 0,
      },
      equalizer: { bandsDb: [0, 0, 0, 0, 0] },
      virtualBass: { strengthPercent: 40 },
      virtualSurround: { widthPercent: 120 },
    };
    const updated = await context.worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        { coordinatorEpoch: epoch, baseRevision: 0, effects },
        friend.cookie,
      ),
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ revision: 1, effects });

    const ownerParticipantId = context.activationEnvelope.snapshot.viewer.participantId as string;
    const kicked = await context.worker.fetch(
      jsonRequest(
        '/presence/kick-device',
        'POST',
        { targetParticipantId: ownerParticipantId },
        friend.cookie,
      ),
    );
    expect(kicked.status).toBe(200);
    const kickedEnvelope = await responseJson(kicked);
    expect(kickedEnvelope.snapshot.presence.participants).toHaveLength(1);
    expect(kickedEnvelope.snapshot.presence.coordinatorParticipantId).toBeNull();

    const revokedOwner = await context.worker.fetch(request('/snapshot', {}, context.ownerCookie));
    expect(revokedOwner.status).toBe(401);
  });
});

const ROOM_CODE = '000001';
const BASE_URL = `https://pro.musixquare.com/v1/rooms/${ROOM_CODE}`;
const ACTIVATION_SECRET = 'activation-secret-'.padEnd(48, 'a');
const PIN_PEPPER = 'pin-pepper-'.padEnd(48, 'p');
const SESSION_SECRET = 'session-secret-'.padEnd(48, 's');
const SIGNALING_SECRET = 'signaling-secret-'.padEnd(48, 'g');
const ACCOUNT_ASSERTION_SECRET = 'account-assertion-secret-'.padEnd(48, 'a');
const R2_ACCOUNT_ID = '01353882e4eea3a5acaa0c45e8336af4';
const IDEMPOTENCY_KEY = '018f977e-5df5-7c8f-bb80-55d847ddec0f';
const DEVELOPER_KEY_ID = 'D'.repeat(16);
const presenceByCookie = new Map<
  string,
  { participantId: string; presenceIncarnationId: string }
>();

type StoredRoom = {
  revision: number;
  playlistRevision: number;
  playlist: unknown[];
  queueMode: {
    revision: number;
    updatedAtMs: number;
    repeatMode: number;
    shuffleEnabled: boolean;
    shuffleOrder: string[];
  };
  pin: {
    salt: string;
    iterations: number;
    hash: string;
  } | null;
  quota: {
    limitBytes: number;
    perAssetLimitBytes: number;
    usedBytes: number;
    reservedBytes: number;
  };
  assets: Record<
    string,
    {
      status: 'reserved' | 'ready';
      assetId: string;
      objectKey: string;
      stagingObjectKey: string;
      version: number;
      byteLength: number;
      mime: string;
      roomGeneration?: number;
      sha256?: string;
      expiresAtMs?: number;
      gcAfterMs?: number;
      stagingCleanupAfterMs?: number;
    }
  >;
};

class FakeStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;

  async get(key: string | string[]): Promise<unknown> {
    if (Array.isArray(key)) {
      return new Map(key.map((entryKey) => [entryKey, structuredClone(this.data.get(entryKey))]));
    }
    return structuredClone(this.data.get(key));
  }

  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === 'string') {
      this.data.set(key, structuredClone(value));
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(key)) {
      this.data.set(entryKey, structuredClone(entryValue));
    }
  }

  async delete(key: string | string[]): Promise<number | boolean> {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const entryKey of key) deleted += this.data.delete(entryKey) ? 1 : 0;
      return deleted;
    }
    return this.data.delete(key);
  }

  async transaction<T>(callback: (transaction: FakeStorage) => Promise<T>): Promise<T> {
    const before = structuredClone([...this.data.entries()]);
    try {
      return await callback(this);
    } catch (error) {
      this.data.clear();
      for (const [key, value] of before) this.data.set(key, value);
      throw error;
    }
  }

  async setAlarm(value: number): Promise<void> {
    this.alarm = value;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

class FakeState {
  readonly storage = new FakeStorage();
}

class FakeR2Bucket {
  readonly objects = new Map<string, any>();
  readonly deleted: string[] = [];
  deleteError: Error | null = null;

  async list(options: { prefix?: string; limit?: number } = {}): Promise<unknown> {
    const prefix = options.prefix ?? '';
    const limit = options.limit ?? 1000;
    const objects = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, limit)
      .map((key) => ({ key }));
    return { objects, truncated: objects.length === limit };
  }

  async head(key: string): Promise<unknown> {
    return structuredClone(this.objects.get(key)) ?? null;
  }

  async get(key: string): Promise<unknown> {
    const object = this.objects.get(key);
    return object ? { ...structuredClone(object), body: { size: object.size } } : null;
  }

  async put(
    key: string,
    body: { size?: number },
    options: { httpMetadata?: unknown; customMetadata?: unknown },
  ): Promise<void> {
    this.objects.set(key, {
      size: body.size ?? 0,
      httpMetadata: structuredClone(options.httpMetadata),
      customMetadata: structuredClone(options.customMetadata),
    });
  }

  async delete(key: string | string[]): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    for (const item of Array.isArray(key) ? key : [key]) {
      this.deleted.push(item);
      this.objects.delete(item);
    }
  }
}

function environment(bucket = new FakeR2Bucket()) {
  return {
    PRO_ROOM_ACTIVATION_SECRET: ACTIVATION_SECRET,
    PRO_ROOM_PIN_PEPPER: PIN_PEPPER,
    PRO_ROOM_SESSION_SECRET: SESSION_SECRET,
    MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: ACCOUNT_ASSERTION_SECRET,
    PRO_SIGNALING_SECRET: SIGNALING_SECRET,
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key'.padEnd(40, 'k'),
    R2_BUCKET_NAME: 'musixquare-pro-media',
    PRO_MEDIA_BUCKET: bucket,
    MUSIXQUARE_AUTH_DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
        })),
      })),
    },
  };
}

function request(path: string, init: RequestInit = {}, cookie?: string): Request {
  return requestForRoom(ROOM_CODE, path, init, cookie);
}

function detachV2Request(cookie: string): Request {
  return request(
    '/sessions/current/account',
    { method: 'DELETE', headers: { 'x-mxqr-pro-detach-version': '2' } },
    cookie,
  );
}

describe('PRO room Worker health', () => {
  it('publishes the exact deployed Worker version for release readiness checks', async () => {
    const response = await proRoomWorker.fetch(new Request('https://pro.musixquare.com/health'), {
      ...environment(),
      CF_VERSION_METADATA: { id: 'pro-version-123' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: 'musixquare-pro-room',
      workerVersionId: 'pro-version-123',
    });
  });
});

function requestWithPresence(
  path: string,
  init: RequestInit,
  cookie: string,
  identity: { participantId: string; presenceIncarnationId: string },
): Request {
  const result = request(path, init, cookie);
  result.headers.set('x-mxqr-pro-participant-id', identity.participantId);
  result.headers.set('x-mxqr-pro-presence-incarnation', identity.presenceIncarnationId);
  return result;
}

function requestForRoom(
  roomCode: string,
  path: string,
  init: RequestInit = {},
  cookie?: string,
): Request {
  const headers = new Headers(init.headers);
  headers.set('x-mxqr-pro-room-code', roomCode);
  headers.set('x-mxqr-pro-ip-hash', 'hashed-client-address');
  if (cookie) headers.set('cookie', cookie);
  const presence = cookie ? presenceByCookie.get(cookie) : null;
  if (presence) {
    headers.set('x-mxqr-pro-participant-id', presence.participantId);
    headers.set('x-mxqr-pro-presence-incarnation', presence.presenceIncarnationId);
  }
  return new Request(`https://pro.musixquare.com/v1/rooms/${roomCode}${path}`, {
    ...init,
    headers,
  });
}

function jsonRequest(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body: unknown,
  cookie?: string,
  idempotencyKey?: string,
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
  return request(path, { method, headers, body: JSON.stringify(body) }, cookie);
}

async function withAccountAssertion(
  input: Request,
  accountId: string,
  nickname: string,
  roomCode = ROOM_CODE,
): Promise<Request> {
  const assertion = await createAccountAssertion(
    {
      accountId,
      nickname,
      roomCode,
      audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
    },
    ACCOUNT_ASSERTION_SECRET,
  );
  if (!assertion) throw new Error('failed to create account assertion');
  input.headers.set(ACCOUNT_ASSERTION_HEADER, assertion);
  return input;
}

function unloadCloseRequest(
  body: Record<string, unknown>,
  cookie: string | undefined,
  key: string,
): Request {
  return request(
    '/presence/close',
    {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ idempotencyKey: key, ...body }),
    },
    cookie,
  );
}

function fencedSessionCloseRequest(
  body: Record<string, unknown>,
  cookie: string | undefined,
): Request {
  return request(
    '/sessions/current/close',
    {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(body),
    },
    cookie,
  );
}

function jsonRequestForRoom(
  roomCode: string,
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body: unknown,
  cookie?: string,
  idempotencyKey?: string,
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
  return requestForRoom(roomCode, path, { method, headers, body: JSON.stringify(body) }, cookie);
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('missing session cookie');
  return setCookie.split(';')[0] ?? '';
}

function bindCookiePresence(cookie: string, envelope: Record<string, any>): void {
  const viewer = envelope.snapshot?.viewer;
  if (!viewer) throw new Error('missing viewer presence identity');
  presenceByCookie.set(cookie, {
    participantId: viewer.participantId,
    presenceIncarnationId: viewer.presenceIncarnationId,
  });
}

async function activatedRoom(roomCode = ROOM_CODE) {
  const state = new FakeState();
  const bucket = new FakeR2Bucket();
  const worker = new MusixquareProRoom(state as never, environment(bucket) as never);
  if (roomCode !== '000000' && roomCode !== '000001') {
    const provision = await worker.fetch(
      new Request('https://pro-room.internal/internal/admin/provision', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': roomCode },
      }),
    );
    expect(provision.status).toBe(200);
  }
  const claimToken = await issueProRoomActivationClaim(roomCode, ACTIVATION_SECRET, {
    nowMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 60_000,
    nonce: 'fixed-activation-nonce',
  });
  const activation = await worker.fetch(
    jsonRequestForRoom(roomCode, '/activation', 'POST', {
      claimToken,
      temporaryPin: roomCode.padStart(8, '0'),
      newPin: '12345678',
      ownerName: 'Owner',
    }),
  );
  expect(activation.status).toBe(200);
  const ownerCookie = cookieFrom(activation);
  const ownerRecoveryCookie = activation.headers
    .getSetCookie()
    .find((value: string) => value.startsWith(`__Host-mxqr_pro_owner_${roomCode}=`))
    ?.split(';')[0];
  expect(ownerRecoveryCookie).toBeTruthy();
  const activationEnvelope = await responseJson(activation);
  bindCookiePresence(ownerCookie, activationEnvelope);
  expect(Object.keys(activationEnvelope)).toEqual(['snapshot']);
  return {
    roomCode,
    worker,
    state,
    bucket,
    ownerCookie,
    ownerRecoveryCookie: ownerRecoveryCookie!,
    activationEnvelope,
  };
}

async function completeReadyAsset(
  context: Awaited<ReturnType<typeof activatedRoom>>,
  suffix: string,
  byteLength = 4096,
) {
  const reservationResponse = await context.worker.fetch(
    jsonRequest(
      '/media/reservations',
      'POST',
      { byteLength, name: `${suffix}.flac`, mime: 'audio/flac' },
      context.ownerCookie,
      `${IDEMPOTENCY_KEY}-${suffix}-reserve`,
    ),
  );
  expect(reservationResponse.status).toBe(200);
  const reservationEnvelope = await responseJson(reservationResponse);
  const assetId = reservationEnvelope.reservation.assetId as string;
  const internal = context.worker as unknown as { room: StoredRoom };
  const asset = internal.room.assets[assetId]!;
  context.bucket.objects.set(asset.stagingObjectKey, {
    size: asset.byteLength,
    httpMetadata: { contentType: asset.mime },
    customMetadata: {
      'mxqr-room': ROOM_CODE,
      'mxqr-generation': String(asset.roomGeneration ?? 0),
      'mxqr-asset': asset.assetId,
      'mxqr-version': String(asset.version),
      'mxqr-bytes': String(asset.byteLength),
    },
  });
  const completeResponse = await context.worker.fetch(
    request(
      `/media/${assetId}/complete`,
      { method: 'POST', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-${suffix}-complete` } },
      context.ownerCookie,
    ),
  );
  expect(completeResponse.status).toBe(200);
  const completeEnvelope = await responseJson(completeResponse);
  return { assetId, asset, completeEnvelope };
}

async function replacePlaylist(
  context: Awaited<ReturnType<typeof activatedRoom>>,
  playlist: unknown[],
  suffix: string,
) {
  const current = await responseJson(
    await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
  );
  return context.worker.fetch(
    jsonRequest(
      '/snapshot',
      'PUT',
      {
        baseRevision: current.snapshot.revision,
        playlist,
        currentQueueItemId: null,
        playback: {
          coordinatorEpoch: current.snapshot.presence.coordinatorEpoch,
          revision: current.snapshot.playback.revision,
          state: 'idle',
          queueItemId: null,
          positionSeconds: 0,
          updatedAtMs: Date.now(),
          youtubeVideoId: null,
          youtubeSubIndex: null,
        },
      },
      context.ownerCookie,
      `${IDEMPOTENCY_KEY}-${suffix}-snapshot`,
    ),
  );
}

function playlistItem(
  queueItemId: string,
  asset: StoredRoom['assets'][string],
): Record<string, unknown> {
  return {
    queueItemId,
    name: 'Shared asset',
    source: {
      kind: 'pro-r2',
      assetId: asset.assetId,
      version: asset.version,
      byteLength: asset.byteLength,
      mime: asset.mime,
      ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
    },
  };
}

function realWorkerPlaylistApi(
  context: Awaited<ReturnType<typeof activatedRoom>>,
  cookie: string,
): ProRoomPlaylistStateApiForTests {
  const readSnapshot = async (response: Response): Promise<ProRoomSnapshot> => {
    const value = await responseJson(response);
    if (!response.ok) throw new ProRoomApiError(String(value.error || 'UNKNOWN'), response.status);
    const snapshot = parseProRoomSnapshot(value.snapshot);
    if (!snapshot) throw new Error('invalid real Worker snapshot');
    return snapshot;
  };
  return {
    getSnapshot: async () =>
      readSnapshot(await context.worker.fetch(request('/snapshot', {}, cookie))),
    updateSnapshot: async (input: UpdateProRoomSnapshotInput) =>
      readSnapshot(
        await context.worker.fetch(
          jsonRequest(
            '/snapshot',
            'PUT',
            {
              baseRevision: input.baseRevision,
              playlist: input.playlist,
              currentQueueItemId: input.currentQueueItemId,
              playback: input.playback,
            },
            cookie,
            input.idempotencyKey,
          ),
        ),
      ),
  };
}

function inertPlaylistMediaTransfer(): ProRoomPlaylistMediaTransferForTests {
  return {
    upload: vi.fn(async () => {
      throw new Error('unexpected upload');
    }),
    deleteAsset: vi.fn(async () => undefined),
  };
}

async function selectFirstAppendThroughWorker(
  context: Awaited<ReturnType<typeof activatedRoom>>,
  cookie: string,
  request: ProRoomFirstAppendSelectionRequest,
  suffix: string,
  readyCookies: readonly string[] = [cookie],
): Promise<void> {
  const response = await context.worker.fetch(
    jsonRequest(
      '/playback/commands',
      'POST',
      {
        type: 'select',
        baseRevision: request.basePlaybackRevision,
        queueItemId: request.queueItemId,
        state: 'playing',
        positionSeconds: 0,
        ...(request.youtubeVideoId === null
          ? {}
          : {
              youtubeVideoId: request.youtubeVideoId,
              youtubeSubIndex: request.youtubeSubIndex,
            }),
      },
      cookie,
      `${IDEMPOTENCY_KEY}-${suffix}-select`,
    ),
  );
  expect([200, 202]).toContain(response.status);
  const result = await responseJson(response);
  if (response.status !== 202) return;
  for (const readyCookie of readyCookies) {
    const ready = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${result.transition.transitionId}/ready`,
        'POST',
        {
          basePlaybackRevision: result.transition.basePlaybackRevision,
          status: 'ready',
        },
        readyCookie,
      ),
    );
    expect(ready.status).toBe(200);
  }
}

describe('PRO first-append client/Worker integration', () => {
  it('persists an observation-only first YouTube row before selecting it through server authority', async () => {
    const context = await activatedRoom();
    const initial = parseProRoomSnapshot(context.activationEnvelope.snapshot)!;
    const queueItemId = '51111111-1111-4111-8111-111111111111';
    const select = vi.fn((request: ProRoomFirstAppendSelectionRequest) =>
      selectFirstAppendThroughWorker(context, context.ownerCookie, request, 'first-youtube'),
    );
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api: realWorkerPlaylistApi(context, context.ownerCookie),
      mediaTransfer: inertPlaylistMediaTransfer(),
      sink: vi.fn(),
      requestFirstAppendSelection: select,
      createIdempotencyKey: () => `${IDEMPOTENCY_KEY}-first-youtube-snapshot`,
      createQueueItemId: () => queueItemId,
    });
    await manager.acceptSnapshot(initial);

    const appended = await manager.addYouTube({
      name: 'First YouTube',
      videoId: 'dQw4w9WgXcQ',
    });

    expect(appended.currentQueueItemId).toBeNull();
    expect(appended.playback.state).toBe('idle');
    expect(select).toHaveBeenCalledOnce();
    const canonical = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(canonical.snapshot.playlist).toHaveLength(1);
    expect(canonical.snapshot.currentQueueItemId).toBe(queueItemId);
    expect(canonical.snapshot.playback).toMatchObject({
      state: 'playing',
      queueItemId,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    });
  });

  it('keeps a completed R2 asset referenced while first-file selection uses server authority', async () => {
    const context = await activatedRoom();
    const { asset } = await completeReadyAsset(context, 'first-r2');
    const initial = parseProRoomSnapshot(
      (
        await responseJson(
          await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
        )
      ).snapshot,
    )!;
    const queueItemId = '52222222-2222-4222-8222-222222222222';
    const source: ProRoomR2Source = {
      kind: 'pro-r2',
      assetId: asset.assetId,
      version: asset.version,
      byteLength: asset.byteLength,
      mime: asset.mime,
      ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
    };
    const media = {
      upload: vi.fn(async () => ({ asset: source, quota: initial.quota })),
      deleteAsset: vi.fn(async () => undefined),
    } satisfies ProRoomPlaylistMediaTransferForTests;
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api: realWorkerPlaylistApi(context, context.ownerCookie),
      mediaTransfer: media,
      sink: vi.fn(),
      requestFirstAppendSelection: (selection) =>
        selectFirstAppendThroughWorker(context, context.ownerCookie, selection, 'first-r2'),
      createIdempotencyKey: () => `${IDEMPOTENCY_KEY}-first-r2-snapshot`,
      createQueueItemId: () => queueItemId,
    });
    await manager.acceptSnapshot(initial);

    await manager.addLocalFiles(
      [new File(['audio'], 'first-r2.flac', { type: 'audio/flac' })].map((file) => ({ file })),
    );

    expect(media.deleteAsset).not.toHaveBeenCalled();
    const canonical = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(canonical.snapshot.playlist[0].source).toMatchObject(source);
    expect(canonical.snapshot.currentQueueItemId).toBe(queueItemId);
    expect(canonical.snapshot.playback).toMatchObject({
      state: 'playing',
      queueItemId,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    });
  });

  it('lets only the canonical first append request selection during a two-actor CAS race', async () => {
    const context = await activatedRoom();
    const memberResponse = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const memberCookie = cookieFrom(memberResponse);
    bindCookiePresence(memberCookie, await responseJson(memberResponse));
    const ownerInitial = parseProRoomSnapshot(
      (
        await responseJson(
          await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
        )
      ).snapshot,
    )!;
    const memberInitial = parseProRoomSnapshot(
      (await responseJson(await context.worker.fetch(request('/snapshot', {}, memberCookie))))
        .snapshot,
    )!;
    const firstId = '53333333-3333-4333-8333-333333333333';
    const secondId = '54444444-4444-4444-8444-444444444444';
    let releaseFirstSelection!: () => void;
    const firstSelectionGate = new Promise<void>((resolve) => {
      releaseFirstSelection = resolve;
    });
    let firstSelectionStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstSelectionStarted = resolve;
    });
    const firstSelect = vi.fn(async (selection: ProRoomFirstAppendSelectionRequest) => {
      firstSelectionStarted();
      await firstSelectionGate;
      await selectFirstAppendThroughWorker(
        context,
        context.ownerCookie,
        selection,
        'concurrent-first',
        [context.ownerCookie, memberCookie],
      );
    });
    const secondSelect = vi.fn(async () => undefined);
    const firstManager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api: realWorkerPlaylistApi(context, context.ownerCookie),
      mediaTransfer: inertPlaylistMediaTransfer(),
      sink: vi.fn(),
      requestFirstAppendSelection: firstSelect,
      createIdempotencyKey: () => `${IDEMPOTENCY_KEY}-concurrent-first-snapshot`,
      createQueueItemId: () => firstId,
    });
    const secondManager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api: realWorkerPlaylistApi(context, memberCookie),
      mediaTransfer: inertPlaylistMediaTransfer(),
      sink: vi.fn(),
      requestFirstAppendSelection: secondSelect,
      createIdempotencyKey: (() => {
        let index = 0;
        return () => `${IDEMPOTENCY_KEY}-concurrent-second-snapshot-${++index}`;
      })(),
      createQueueItemId: () => secondId,
    });
    await firstManager.acceptSnapshot(ownerInitial);
    await secondManager.acceptSnapshot(memberInitial);

    const firstAppend = firstManager.addYouTube({
      name: 'Canonical first',
      videoId: 'dQw4w9WgXcQ',
    });
    await firstStarted;
    const secondAppend = await secondManager.addYouTube({
      name: 'Concurrent second',
      videoId: '9bZkp7q19f0',
    });
    expect(secondAppend.playlist.map((item) => item.queueItemId)).toEqual([firstId, secondId]);
    expect(secondSelect).not.toHaveBeenCalled();

    releaseFirstSelection();
    await firstAppend;
    const canonical = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(firstSelect).toHaveBeenCalledOnce();
    expect(
      canonical.snapshot.playlist.map((item: { queueItemId: string }) => item.queueItemId),
    ).toEqual([firstId, secondId]);
    expect(canonical.snapshot.currentQueueItemId).toBe(firstId);
  });
});

function internalDeveloperRead(
  worker: MusixquareProRoom,
  projection: 'room' | 'playback' | 'queue' | 'effects' | 'queue-mode',
  keyId = DEVELOPER_KEY_ID,
): Promise<Response> {
  return worker.fetch(
    new Request('https://pro-room.internal/internal/developer/v1/read', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mxqr-pro-room-code': ROOM_CODE,
      },
      body: JSON.stringify({ projection, keyId }),
    }),
  );
}

function updateInternalDeveloperQueueMode(
  worker: MusixquareProRoom,
  keyId: string,
  idempotencyKey: string,
  queueMode: Record<string, unknown>,
): Promise<Response> {
  return worker.fetch(
    new Request('https://pro-room.internal/internal/developer/v1/queue-mode/update', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mxqr-pro-room-code': ROOM_CODE,
      },
      body: JSON.stringify({ roomCode: ROOM_CODE, keyId, idempotencyKey, queueMode }),
    }),
  );
}

async function preparedDeveloperCommandRoom(
  dispatchFetch: Mock<(request: Request) => Promise<Response>> = vi.fn(async () =>
    Response.json({ dispatched: true }),
  ),
) {
  const context = await activatedRoom();
  const internal = context.worker as unknown as {
    env: Record<string, any>;
    room: Record<string, any>;
  };
  internal.env.PRO_SIGNALING_ROOMS = {
    idFromName: vi.fn((value: string) => value),
    get: vi.fn(() => ({ fetch: dispatchFetch })),
  };
  const queueItemId = '44444444-4444-4444-8444-444444444444';
  internal.room.playlistRevision = 2;
  internal.room.playlist = [
    {
      queueItemId,
      name: 'Developer API test',
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    },
  ];
  internal.room.currentQueueItemId = queueItemId;
  internal.room.playback = {
    coordinatorEpoch: context.activationEnvelope.snapshot.presence.coordinatorEpoch,
    revision: 4,
    state: 'paused',
    queueItemId,
    positionSeconds: 8,
    updatedAtMs: Date.now(),
    youtubeVideoId: 'dQw4w9WgXcQ',
    youtubeSubIndex: 0,
  };
  const capability = await context.worker.fetch(
    jsonRequest('/signaling-tickets', 'POST', { developerControlVersion: 1 }, context.ownerCookie),
  );
  expect(capability.status).toBe(200);
  return { ...context, dispatchFetch, internal, queueItemId };
}

function createInternalDeveloperCommand(
  worker: MusixquareProRoom,
  keyId: string,
  idempotencyKey: string,
  command: Record<string, unknown>,
): Promise<Response> {
  return worker.fetch(
    new Request('https://pro-room.internal/internal/developer/v1/commands/create', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mxqr-pro-room-code': ROOM_CODE,
      },
      body: JSON.stringify({ roomCode: ROOM_CODE, keyId, idempotencyKey, command }),
    }),
  );
}

function mutateInternalDeveloperQueue(
  worker: MusixquareProRoom,
  keyId: string,
  idempotencyKey: string,
  mutation: Record<string, unknown>,
  actorName?: string,
): Promise<Response> {
  return worker.fetch(
    new Request('https://pro-room.internal/internal/developer/v1/queue/mutate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mxqr-pro-room-code': ROOM_CODE,
      },
      body: JSON.stringify({
        roomCode: ROOM_CODE,
        keyId,
        ...(actorName === undefined ? {} : { actorName }),
        idempotencyKey,
        mutation,
      }),
    }),
  );
}

function createInternalDeveloperUpload(
  worker: MusixquareProRoom,
  keyId: string,
  idempotencyKey: string,
  media: Record<string, unknown>,
): Promise<Response> {
  return worker.fetch(
    new Request('https://pro-room.internal/internal/developer/v1/media/uploads/create', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mxqr-pro-room-code': ROOM_CODE,
      },
      body: JSON.stringify({ roomCode: ROOM_CODE, keyId, idempotencyKey, media }),
    }),
  );
}

function completeInternalDeveloperUpload(
  worker: MusixquareProRoom,
  keyId: string,
  idempotencyKey: string,
  assetId: string,
  actorName?: string,
): Promise<Response> {
  return worker.fetch(
    new Request('https://pro-room.internal/internal/developer/v1/media/uploads/complete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mxqr-pro-room-code': ROOM_CODE,
      },
      body: JSON.stringify({
        roomCode: ROOM_CODE,
        keyId,
        idempotencyKey,
        assetId,
        ...(actorName === undefined ? {} : { actorName }),
      }),
    }),
  );
}

function internalBotRequest(
  worker: MusixquareProRoom,
  path: 'context' | 'execute',
  body: Record<string, unknown>,
  cookie: string,
  options: { includePresence?: boolean; roomCode?: string } = {},
): Promise<Response> {
  const roomCode = options.roomCode ?? ROOM_CODE;
  const headers = new Headers({
    'content-type': 'application/json',
    cookie,
    'x-mxqr-pro-room-code': roomCode,
  });
  if (options.includePresence !== false) {
    const presence = presenceByCookie.get(cookie);
    if (!presence) throw new Error('missing test presence identity');
    headers.set('x-mxqr-pro-participant-id', presence.participantId);
    headers.set('x-mxqr-pro-presence-incarnation', presence.presenceIncarnationId);
  }
  return worker.fetch(
    new Request(`https://pro-room.internal/internal/bot/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe('PRO room server BOT boundary', () => {
  it('reads and controls canonical virtual treble through the BOT effects contract', async () => {
    const context = await activatedRoom();
    const internal = context.worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => Response.json({ broadcast: true, eligible: 2, sent: 2 })),
      })),
    };
    const requestId = 'bot-virtual-treble-control-0001';
    const botContext = await internalBotRequest(
      context.worker,
      'context',
      { roomCode: ROOM_CODE, requestId, prompt: 'turn virtual treble on' },
      context.ownerCookie,
    );
    expect(botContext.status).toBe(200);
    const contextPayload = await responseJson(botContext);
    expect(contextPayload.room.effects.virtualTreble).toEqual({ enabled: false });

    const execute = await internalBotRequest(
      context.worker,
      'execute',
      {
        roomCode: ROOM_CODE,
        requestId,
        leaseToken: contextPayload.leaseToken,
        plan: { intent: 'virtual_treble', virtualTrebleEnabled: true },
        tracks: [],
      },
      context.ownerCookie,
    );
    expect(execute.status).toBe(200);
    expect(internal.room.effects).toMatchObject({
      revision: 1,
      effects: { virtualTreble: { enabled: true } },
    });
  });

  it('serves every provisioned active PRO room', async () => {
    const roomCode = '000002';
    const { worker, ownerCookie } = await activatedRoom(roomCode);
    const requestId = 'bot-context-all-pro-0001';
    const context = await internalBotRequest(
      worker,
      'context',
      { roomCode, requestId, prompt: 'test' },
      ownerCookie,
      { roomCode },
    );

    expect(context.status).toBe(200);
    const contextPayload = await responseJson(context);
    expect(contextPayload).toMatchObject({ actorName: 'Owner' });

    const execute = await internalBotRequest(
      worker,
      'execute',
      {
        roomCode,
        requestId,
        leaseToken: contextPayload.leaseToken,
        plan: { intent: 'answer', answer: 'done' },
        tracks: [],
      },
      ownerCookie,
      { roomCode },
    );
    expect(execute.status).toBe(200);
    await expect(execute.json()).resolves.toMatchObject({ ok: true, summary: 'done' });
  });

  it('treats a terminally rejected Developer 202 as BOT failure on first call and replay', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const requestId = 'bot-terminal-rejection-0001';
    const context = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId, prompt: 'play now' },
      ownerCookie,
    );
    expect(context.status).toBe(200);
    const contextPayload = await responseJson(context);
    const executeBody = {
      roomCode: ROOM_CODE,
      requestId,
      leaseToken: contextPayload.leaseToken,
      plan: { intent: 'playback', playbackCommand: 'play' },
      tracks: [],
    };

    const first = await internalBotRequest(worker, 'execute', executeBody, ownerCookie);
    expect(first.status).toBe(409);
    await expect(first.json()).resolves.toEqual({ error: 'BOT_ACTION_FAILED' });
    const [command] = Object.values(internal.room.developerCommands) as Record<string, any>[];
    expect(command).toMatchObject({
      keyId: 'MxqrGeminiBot001',
      status: 'rejected',
      resultCode: 'no_media',
    });

    const replay = await internalBotRequest(worker, 'execute', executeBody, ownerCookie);
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({ error: 'BOT_ACTION_FAILED' });
    expect(Object.values(internal.room.developerCommands)).toHaveLength(1);
    expect(Object.values(internal.room.developerCommandIdempotency)[0]).toMatchObject({
      body: {
        commandId: command.commandId,
        status: 'rejected',
        resultCode: 'no_media',
      },
      status: 202,
    });
  });

  it('requires the current active presence before exposing bounded context', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const response = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId: 'bot-context-presence-0001', prompt: 'test' },
      ownerCookie,
      { includePresence: false },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'PRESENCE_SUPERSEDED' });
  });

  it('replays one context receipt without charging it twice and rate-limits new turns', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const requestIds = ['bot-context-rate-0001', 'bot-context-rate-0002', 'bot-context-rate-0003'];
    for (const requestId of requestIds) {
      const response = await internalBotRequest(
        worker,
        'context',
        { roomCode: ROOM_CODE, requestId, prompt: `request ${requestId}` },
        ownerCookie,
      );
      expect(response.status).toBe(200);
    }

    const replay = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId: requestIds[0], prompt: `request ${requestIds[0]}` },
      ownerCookie,
    );
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({ error: 'BOT_REQUEST_IN_PROGRESS' });

    const conflict = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId: requestIds[0], prompt: 'different request' },
      ownerCookie,
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: 'IDEMPOTENCY_CONFLICT' });

    const limited = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId: 'bot-context-rate-0004', prompt: 'fourth request' },
      ownerCookie,
    );
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    await expect(limited.json()).resolves.toEqual({ error: 'RATE_LIMITED' });
  });

  it('enforces 100 room requests in one anchored hour without inheriting the old daily key', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const nowMs = Date.now();
    internal.room.botRateLimits[`bot-day:${ROOM_CODE}`] = {
      count: 20,
      resetAtMs: nowMs + 23 * 60 * 60 * 1000,
    };
    internal.room.botRateLimits[`bot-room-hour-v1:${ROOM_CODE}`] = {
      count: 99,
      resetAtMs: nowMs + 60 * 60 * 1000,
    };

    const hundredth = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId: 'bot-context-hour-0100', prompt: 'hundredth' },
      ownerCookie,
    );
    expect(hundredth.status).toBe(200);
    expect(internal.room.botRateLimits[`bot-room-hour-v1:${ROOM_CODE}`]).toMatchObject({
      count: 100,
      resetAtMs: nowMs + 60 * 60 * 1000,
    });
    expect(internal.room.botRateLimits[`bot-day:${ROOM_CODE}`]).toBeUndefined();

    const limited = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId: 'bot-context-hour-0101', prompt: 'one too many' },
      ownerCookie,
    );
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(3600);
  });

  it('fails closed instead of evicting live BOT or admission rate-limit buckets at capacity', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const nowMs = Date.now();
    const botRoomKey = `bot-room-hour-v1:${ROOM_CODE}`;
    internal.room.botRateLimits[botRoomKey] = {
      count: 42,
      resetAtMs: nowMs + 60 * 60 * 1000,
    };
    for (let index = 1; index < 512; index += 1) {
      internal.room.botRateLimits[`bot-minute:protected-${index}`] = {
        count: 1,
        resetAtMs: nowMs + 60 * 1000 + index,
      };
    }

    const blockedBot = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId: 'bot-context-capacity-0001', prompt: 'capacity' },
      ownerCookie,
    );
    expect(blockedBot.status).toBe(429);
    expect(internal.room.botRateLimits[botRoomKey]).toMatchObject({
      count: 42,
      resetAtMs: nowMs + 60 * 60 * 1000,
    });
    expect(Object.keys(internal.room.botRateLimits)).toHaveLength(512);

    const protectedAdmissionKey = 'pin-failure:protected-client';
    internal.room.rateLimits[protectedAdmissionKey] = {
      count: 10,
      resetAtMs: nowMs + 60 * 60 * 1000,
    };
    for (let index = 1; Object.keys(internal.room.rateLimits).length < 512; index += 1) {
      internal.room.rateLimits[`pin-failure:protected-${index}`] = {
        count: 1,
        resetAtMs: nowMs + 60 * 60 * 1000 + index,
      };
    }
    const blockedAdmission = await worker.fetch(
      new Request(`${BASE_URL}/sessions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
          'x-mxqr-pro-ip-hash': 'new-client-at-capacity',
        },
        body: JSON.stringify({ pin: '12345678' }),
      }),
    );
    expect(blockedAdmission.status).toBe(429);
    expect(internal.room.rateLimits[protectedAdmissionKey]).toMatchObject({
      count: 10,
      resetAtMs: nowMs + 60 * 60 * 1000,
    });
    expect(Object.keys(internal.room.rateLimits)).toHaveLength(512);
  });

  it('adds a bounded YouTube batch exactly once for one executed request', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const requestId = 'bot-execute-add-0001';
    const context = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId, prompt: 'add one test song' },
      ownerCookie,
    );
    expect(context.status).toBe(200);
    const contextPayload = await responseJson(context);
    const body = {
      roomCode: ROOM_CODE,
      requestId,
      leaseToken: contextPayload.leaseToken,
      plan: {
        intent: 'add_youtube',
        trackQueries: ['Test Artist Test Song official audio'],
        playAddedIndex: -1,
        answer: '한 곡을 추가했어요.',
      },
      tracks: [
        {
          videoId: 'dQw4w9WgXcQ',
          name: 'Test Song',
          title: 'Test Song',
          artist: 'Test Artist',
        },
      ],
    };

    const first = await internalBotRequest(worker, 'execute', body, ownerCookie);
    expect(first.status).toBe(200);
    const firstPayload = await responseJson(first);
    expect(firstPayload).toEqual({
      ok: true,
      summary: 'Added 1 track.',
      addedCount: 1,
      playbackChanged: false,
    });
    expect(internal.room.playlist).toHaveLength(1);
    expect(internal.room.playlist[0]).toMatchObject({
      name: 'Test Song',
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      developerOwnerKeyId: 'MxqrGeminiBot001',
    });
    const revisionAfterFirst = internal.room.revision;
    const playlistRevisionAfterFirst = internal.room.playlistRevision;

    const terminalContextReplay = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId, prompt: 'add one test song' },
      ownerCookie,
    );
    expect(terminalContextReplay.status).toBe(200);
    await expect(terminalContextReplay.json()).resolves.toEqual({ replay: firstPayload });

    const replay = await internalBotRequest(worker, 'execute', body, ownerCookie);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(firstPayload);
    expect(internal.room.playlist).toHaveLength(1);
    expect(internal.room.revision).toBe(revisionAfterFirst);
    expect(internal.room.playlistRevision).toBe(playlistRevisionAfterFirst);

    const conflict = await internalBotRequest(
      worker,
      'execute',
      {
        ...body,
        plan: { ...body.plan, answer: '다른 요청이에요.' },
      },
      ownerCookie,
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: 'IDEMPOTENCY_CONFLICT' });
    expect(internal.room.playlist).toHaveLength(1);
  });

  it('dispatches the newly added item when add-and-play starts from an empty queue', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    expect(internal.room.playlist).toEqual([]);
    expect(internal.room.currentQueueItemId).toBeNull();

    const dispatched: Array<{ path: string; body: Record<string, any> }> = [];
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({
        fetch: vi.fn(async (request: Request) => {
          dispatched.push({
            path: new URL(request.url).pathname,
            body: (await request.json()) as Record<string, any>,
          });
          return Response.json({ dispatched: true });
        }),
      })),
    };
    const capability = await worker.fetch(
      jsonRequest('/signaling-tickets', 'POST', { developerControlVersion: 1 }, ownerCookie),
    );
    expect(capability.status).toBe(200);

    // A public request ID may occupy the full 128-character contract. Derived
    // developer keys must remain within their own 128-character limit.
    const requestId = 'b'.repeat(128);
    const context = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId, prompt: 'add and play the first song' },
      ownerCookie,
    );
    expect(context.status).toBe(200);
    const contextPayload = await responseJson(context);
    const execute = await internalBotRequest(
      worker,
      'execute',
      {
        roomCode: ROOM_CODE,
        requestId,
        leaseToken: contextPayload.leaseToken,
        plan: {
          intent: 'add_youtube',
          trackQueries: ['First Artist First Song official audio'],
          playAddedIndex: 0,
        },
        tracks: [
          {
            videoId: 'dQw4w9WgXcQ',
            name: 'First Song',
            title: 'First Song',
            artist: 'First Artist',
          },
        ],
      },
      ownerCookie,
    );

    expect(execute.status).toBe(200);
    await expect(execute.json()).resolves.toEqual({
      ok: true,
      summary: 'Added 1 track and started playback.',
      addedCount: 1,
      playbackChanged: true,
    });
    expect(internal.room.playlist).toHaveLength(1);
    const queueItemId = internal.room.playlist[0].queueItemId;
    expect(
      Object.keys(internal.room.developerMutationIdempotency).some((key) =>
        /^developer:MxqrGeminiBot001:queue:add_youtube_batch:bot-queue-[a-f0-9]{64}$/u.test(key),
      ),
    ).toBe(true);
    const command = Object.values(internal.room.developerCommands).find(
      (candidate: any) => candidate.command?.queueItemId === queueItemId,
    ) as Record<string, any>;
    expect(command).toMatchObject({
      keyId: 'MxqrGeminiBot001',
      idempotencyKey: expect.stringMatching(/^bot-command-[a-f0-9]{64}$/u),
      command: { type: 'play_item', queueItemId },
      status: 'pending',
    });
    const pending = internal.room.pendingPlaybackTransition;
    expect(pending).toMatchObject({
      developerCommandId: command.commandId,
      target: { queueItemId, state: 'playing' },
    });
    expect(dispatched.filter((entry) => entry.path === '/internal/realtime/v1/broadcast')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({
            event: expect.objectContaining({
              type: 'pro-playback-prepare',
              transitionId: pending.transitionId,
            }),
          }),
        }),
      ]),
    );

    const ready = await worker.fetch(
      jsonRequest(
        `/playback/transitions/${pending.transitionId}/ready`,
        'POST',
        { basePlaybackRevision: pending.basePlaybackRevision, status: 'ready' },
        ownerCookie,
      ),
    );
    expect(ready.status).toBe(200);
    expect(internal.room.developerCommands[command.commandId]).toMatchObject({
      status: 'applied',
      resultCode: 'applied',
    });
    expect(internal.room.playback).toMatchObject({ queueItemId, state: 'playing' });
  });

  it('removes an exact item set and clears the queue through one idempotent BOT mutation each', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const seeded = await responseJson(
      await mutateInternalDeveloperQueue(worker, 'MxqrGeminiBot001', 'bot-remove-clear-seed', {
        type: 'add_youtube_batch',
        items: [
          { videoId: 'dQw4w9WgXcQ', name: 'First' },
          { videoId: 'M7lc1UVf-VE', name: 'Second' },
          { videoId: '9bZkp7q19f0', name: 'Third' },
        ],
      }),
    );
    const [firstQueueItemId, secondQueueItemId, thirdQueueItemId] = seeded.items.map(
      (item: Record<string, any>) => item.queueItemId,
    );
    internal.room.currentQueueItemId = firstQueueItemId;
    internal.room.playback = {
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
      revision: 7,
      state: 'playing',
      queueItemId: firstQueueItemId,
      positionSeconds: 12,
      updatedAtMs: Date.now(),
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    };
    const removeRequestId = 'bot-remove-items-0001';
    const removeContext = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId: removeRequestId, prompt: 'remove first and third' },
      ownerCookie,
    );
    const removeContextPayload = await responseJson(removeContext);
    const removeBody = {
      roomCode: ROOM_CODE,
      requestId: removeRequestId,
      leaseToken: removeContextPayload.leaseToken,
      plan: {
        intent: 'remove_items',
        queueItemIds: [firstQueueItemId, thirdQueueItemId],
        answer: 'Removed the selected tracks.',
      },
      tracks: [],
    };
    const beforeRemoveRevision = internal.room.revision;
    const removed = await internalBotRequest(worker, 'execute', removeBody, ownerCookie);

    expect(removed.status).toBe(200);
    const removedPayload = await responseJson(removed);
    expect(removedPayload).toEqual({
      ok: true,
      summary: 'Removed 2 tracks.',
      addedCount: 0,
      playbackChanged: true,
    });
    expect(internal.room.playlist.map((item: Record<string, any>) => item.queueItemId)).toEqual([
      secondQueueItemId,
    ]);
    expect(internal.room.revision).toBe(beforeRemoveRevision + 1);
    expect(
      internal.room.developerMutationIdempotency[
        `developer:MxqrGeminiBot001:queue:remove_many:${removeRequestId}.queue`
      ],
    ).toMatchObject({ kind: 'developer-queue', status: 200 });

    const recovered = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId: removeRequestId, prompt: 'remove first and third' },
      ownerCookie,
    );
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({ replay: removedPayload });

    const replay = await internalBotRequest(worker, 'execute', removeBody, ownerCookie);
    expect(replay.status).toBe(200);
    expect(await responseJson(replay)).toEqual(removedPayload);
    expect(internal.room.playlist.map((item: Record<string, any>) => item.queueItemId)).toEqual([
      secondQueueItemId,
    ]);
    expect(internal.room.revision).toBe(beforeRemoveRevision + 1);

    const clearRequestId = 'bot-clear-queue-0001';
    const clearContext = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId: clearRequestId, prompt: 'clear the queue' },
      ownerCookie,
    );
    const clearContextPayload = await responseJson(clearContext);
    const cleared = await internalBotRequest(
      worker,
      'execute',
      {
        roomCode: ROOM_CODE,
        requestId: clearRequestId,
        leaseToken: clearContextPayload.leaseToken,
        plan: {
          intent: 'clear_queue',
          basePlaylistRevision: clearContextPayload.room.playlistRevision,
          answer: 'Cleared the queue.',
        },
        tracks: [],
      },
      ownerCookie,
    );

    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toEqual({
      ok: true,
      summary: 'Cleared the queue and removed 1 track.',
      addedCount: 0,
      playbackChanged: false,
    });
    expect(internal.room.playlist).toEqual([]);
    expect(
      internal.room.developerMutationIdempotency[
        `developer:MxqrGeminiBot001:queue:clear:${clearRequestId}.queue`
      ],
    ).toMatchObject({ kind: 'developer-queue', status: 200 });
  });

  it('rejects a BOT clear when the playlist changes after the model context snapshot', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    await mutateInternalDeveloperQueue(worker, 'MxqrGeminiBot001', 'bot-clear-fence-seed-1', {
      type: 'add_youtube',
      videoId: 'dQw4w9WgXcQ',
      name: 'Visible to the model',
    });
    const requestId = 'bot-clear-fence-0001';
    const context = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId, prompt: 'clear the queue' },
      ownerCookie,
    );
    const contextPayload = await responseJson(context);

    await mutateInternalDeveloperQueue(worker, 'MxqrGeminiBot001', 'bot-clear-fence-seed-2', {
      type: 'add_youtube',
      videoId: 'M7lc1UVf-VE',
      name: 'Added after the model snapshot',
    });
    const before = {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
      queueItemIds: internal.room.playlist.map((item: Record<string, any>) => item.queueItemId),
    };

    const response = await internalBotRequest(
      worker,
      'execute',
      {
        roomCode: ROOM_CODE,
        requestId,
        leaseToken: contextPayload.leaseToken,
        plan: {
          intent: 'clear_queue',
          basePlaylistRevision: contextPayload.room.playlistRevision,
          answer: 'Cleared the queue.',
        },
        tracks: [],
      },
      ownerCookie,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'BOT_CONTEXT_STALE' });
    expect(internal.room.revision).toBe(before.revision);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision);
    expect(internal.room.playlist.map((item: Record<string, any>) => item.queueItemId)).toEqual(
      before.queueItemIds,
    );
  });

  it('rechecks the BOT clear fence inside the queue handler immediately before mutation', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as {
      room: Record<string, any>;
      handleInternalDeveloperQueueMutation(
        request: Request,
        botTerminal: Record<string, unknown>,
      ): Promise<Response>;
    };
    await mutateInternalDeveloperQueue(worker, 'MxqrGeminiBot001', 'bot-handler-fence-seed', {
      type: 'add_youtube',
      videoId: 'dQw4w9WgXcQ',
      name: 'Must survive a stale plan',
    });

    const requestId = 'bot-handler-fence-0001';
    const terminalScope = `bot-execute:${'a'.repeat(43)}`;
    const before = {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
      queueItemIds: internal.room.playlist.map((item: Record<string, any>) => item.queueItemId),
    };
    const response = await internal.handleInternalDeveloperQueueMutation(
      new Request('https://pro-room.internal/internal/developer/v1/queue/mutate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: ROOM_CODE,
          keyId: 'MxqrGeminiBot001',
          idempotencyKey: requestId,
          mutation: { type: 'clear' },
        }),
      }),
      {
        action: 'clear_queue',
        languageHint: 'Cleared the queue.',
        expectedPlaylistRevision: before.playlistRevision - 1,
        terminalScope,
        terminalKey: requestId,
        terminalFingerprint: 'f'.repeat(64),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'BOT_CONTEXT_STALE' });
    expect(internal.room.revision).toBe(before.revision);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision);
    expect(internal.room.playlist.map((item: Record<string, any>) => item.queueItemId)).toEqual(
      before.queueItemIds,
    );
    expect(internal.room.idempotency[`${terminalScope}:${requestId}`]).toBeUndefined();
  });

  it('rejects empty, duplicate, oversized, or cross-intent BOT removal plans', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const requestId = 'bot-remove-invalid-0001';
    const context = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId, prompt: 'invalid removal' },
      ownerCookie,
    );
    const contextPayload = await responseJson(context);
    const queueItemId = '61616161-6161-4616-8616-616161616161';
    const plans = [
      { intent: 'remove_items', queueItemIds: [] },
      { intent: 'remove_items', queueItemIds: [queueItemId, queueItemId] },
      {
        intent: 'remove_items',
        queueItemIds: Array.from(
          { length: 21 },
          (_, index) => `62626262-6262-4626-8626-${index.toString(16).padStart(12, '0')}`,
        ),
      },
      { intent: 'clear_queue', queueItemIds: [queueItemId] },
    ];
    const before = structuredClone(internal.room);

    for (const plan of plans) {
      const response = await internalBotRequest(
        worker,
        'execute',
        {
          roomCode: ROOM_CODE,
          requestId,
          leaseToken: contextPayload.leaseToken,
          plan,
          tracks: [],
        },
        ownerCookie,
      );
      expect(response.status).toBe(400);
      expect(await responseJson(response)).toEqual({ error: 'INVALID_REQUEST' });
      expect(internal.room.playlist).toEqual(before.playlist);
      expect(internal.room.revision).toBe(before.revision);
      expect(internal.room.playlistRevision).toBe(before.playlistRevision);
    }
  });

  it('dispatches play_existing once and replays the terminal BOT receipt', async () => {
    const { worker, ownerCookie, internal, queueItemId, dispatchFetch } =
      await preparedDeveloperCommandRoom();
    const requestId = 'bot-play-existing-0001';
    const context = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId, prompt: 'play the queued song' },
      ownerCookie,
    );
    expect(context.status).toBe(200);
    const contextPayload = await responseJson(context);
    const body = {
      roomCode: ROOM_CODE,
      requestId,
      leaseToken: contextPayload.leaseToken,
      plan: {
        intent: 'play_existing',
        queueItemId,
        answer: '이 곡을 재생할게요.',
      },
      tracks: [],
    };

    const first = await internalBotRequest(worker, 'execute', body, ownerCookie);
    expect(first.status).toBe(200);
    const firstPayload = await responseJson(first);
    expect(firstPayload).toEqual({
      ok: true,
      summary: '이 곡을 재생할게요.',
      addedCount: 0,
      playbackChanged: true,
    });
    expect(Object.values(internal.room.developerCommands)).toHaveLength(1);
    expect(Object.values(internal.room.developerCommands)[0]).toMatchObject({
      keyId: 'MxqrGeminiBot001',
      command: { type: 'play_item', queueItemId },
    });
    expect(dispatchFetch).toHaveBeenCalledTimes(1);

    const replay = await internalBotRequest(worker, 'execute', body, ownerCookie);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(firstPayload);
    expect(Object.values(internal.room.developerCommands)).toHaveLength(1);
    expect(dispatchFetch).toHaveBeenCalledTimes(1);
  });

  it('accepts a server-issued Base64URL BOT lease with a symbol prefix', async () => {
    const { worker, ownerCookie, internal } = await preparedDeveloperCommandRoom();
    const requestId = 'bot-base64url-lease-0001';
    const context = await internalBotRequest(
      worker,
      'context',
      { roomCode: ROOM_CODE, requestId, prompt: 'answer without changing playback' },
      ownerCookie,
    );
    expect(context.status).toBe(200);

    // randomToken(24) can naturally produce a leading `_`. Pin the receipt to
    // that valid shape so this regression test does not itself depend on
    // random chance.
    const leaseToken = `_${'A'.repeat(31)}`;
    const receipt = Object.entries(internal.room.idempotency).find(([key]) =>
      key.endsWith(`:${requestId}`),
    )?.[1] as { body?: { leaseToken?: string } } | undefined;
    expect(receipt?.body).toBeDefined();
    if (!receipt?.body) throw new Error('missing BOT context receipt');
    receipt.body.leaseToken = leaseToken;

    const response = await internalBotRequest(
      worker,
      'execute',
      {
        roomCode: ROOM_CODE,
        requestId,
        leaseToken,
        plan: { intent: 'answer', answer: '처리했어요.' },
        tracks: [],
      },
      ownerCookie,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      summary: '처리했어요.',
    });
  });
});

describe('PRO room private Developer API projections', () => {
  it('exposes only bounded room, playback, and queue fields', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T01:00:00.000Z'));
    const { worker, activationEnvelope } = await activatedRoom();
    const internal = worker as unknown as {
      room: {
        revision: number;
        playlistRevision: number;
        playlist: Array<Record<string, any>>;
        currentQueueItemId: string | null;
        playback: Record<string, any>;
        assets: Record<string, Record<string, any>>;
        ownerMemberId: string;
      };
    };
    const queueItemId = '11111111-1111-4111-8111-111111111111';
    const assetId = 'asset_018f977e5df57c8f';
    internal.room.revision = 9;
    internal.room.playlistRevision = 4;
    internal.room.playlist = [
      {
        queueItemId,
        name: 'Private Orchestra.flac',
        title: 'Orchestra',
        artist: 'Private Artist',
        source: {
          kind: 'pro-r2',
          assetId,
          version: 1,
          byteLength: 1_024,
          mime: 'audio/flac',
        },
      },
    ];
    internal.room.currentQueueItemId = queueItemId;
    internal.room.playback = {
      coordinatorEpoch: activationEnvelope.snapshot.presence.coordinatorEpoch,
      revision: 3,
      state: 'playing',
      queueItemId,
      positionSeconds: 10,
      updatedAtMs: Date.now() - 2_000,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    };
    internal.room.assets[assetId] = {
      status: 'ready',
      assetId,
      objectKey: 'rooms/000001/private-object.flac',
      stagingObjectKey: 'staging/000001/private-object.flac',
      version: 1,
      byteLength: 1_024,
      mime: 'audio/flac',
    };
    internal.room.ownerMemberId = 'private-owner-member-id';

    const room = await responseJson(await internalDeveloperRead(worker, 'room'));
    expect(room).toEqual({
      schemaVersion: 1,
      view: 'room',
      roomCode: ROOM_CODE,
      status: 'active',
      runtime: 'awake',
      revision: 9,
      participantCount: 1,
      controlAvailable: true,
      quota: {
        limitBytes: 1_073_741_824,
        perAssetLimitBytes: 209_715_200,
        usedBytes: 0,
        reservedBytes: 0,
      },
    });

    const playback = await responseJson(await internalDeveloperRead(worker, 'playback'));
    expect(playback).toEqual({
      schemaVersion: 1,
      view: 'playback',
      roomCode: ROOM_CODE,
      revision: 3,
      playlistRevision: 4,
      state: 'playing',
      queueItemId,
      positionSeconds: 12,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      observedAtMs: Date.now(),
      item: {
        queueItemId,
        kind: 'audio',
        name: 'Private Orchestra.flac',
        addedBy: 'participant',
        title: 'Orchestra',
        artist: 'Private Artist',
        byteLength: 1_024,
      },
    });

    const queue = await responseJson(await internalDeveloperRead(worker, 'queue'));
    expect(queue).toEqual({
      schemaVersion: 1,
      view: 'queue',
      roomCode: ROOM_CODE,
      playlistRevision: 4,
      currentQueueItemId: queueItemId,
      items: [playback.item],
    });
    const serialized = JSON.stringify({ room, playback, queue });
    for (const privateValue of [
      assetId,
      'objectKey',
      'stagingObjectKey',
      'private-owner-member-id',
      activationEnvelope.snapshot.viewer.participantId,
      activationEnvelope.snapshot.viewer.displayName,
      'source',
      'mime',
    ]) {
      expect(serialized).not.toContain(String(privateValue));
    }
    vi.useRealTimers();
  });

  it('composes the public API through the private facade into a real PRO room projection', async () => {
    const roomCode = '000002';
    const { worker } = await activatedRoom(roomCode);
    const internal = worker as unknown as {
      room: {
        playlistRevision: number;
        playlist: Array<Record<string, any>>;
        currentQueueItemId: string | null;
      };
    };
    const queueItemId = '33333333-3333-4333-8333-333333333333';
    internal.room.playlistRevision = 5;
    internal.room.playlist = [
      {
        queueItemId,
        name: 'Facade Orchestra.flac',
        title: 'Facade Orchestra',
        source: {
          kind: 'pro-r2',
          assetId: 'private-composed-asset',
          version: 1,
          byteLength: 4_096,
          mime: 'audio/flac',
        },
      },
    ];
    internal.room.currentQueueItemId = queueItemId;

    const keyId = 'C'.repeat(16);
    const keySecret = 'D'.repeat(43);
    const pepper = 'developer-api-pepper'.padEnd(48, 'p');
    const nowMs = Date.now();
    const secretDigest = await deriveDeveloperApiKeyDigest(pepper, keyId, keySecret);
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => ({
            key_id: keyId,
            room_code: roomCode,
            label: 'Composed API',
            secret_digest: secretDigest,
            digest_version: 1,
            scope_mask:
              developerApiScopes['room:read'] |
              developerApiScopes['playback:read'] |
              developerApiScopes['queue:read'],
            status: 'active',
            created_at: nowMs - 1_000,
            updated_at: nowMs - 1_000,
            expires_at: nowMs + 86_400_000,
            revoked_at: null,
            last_used_hour: null,
          })),
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
        })),
      })),
    };
    const limiter = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({
        fetch: vi.fn(async () =>
          Response.json({
            allowed: true,
            limit: 60,
            remaining: 59,
            resetAtMs: Date.now() + 60_000,
            retryAfterSeconds: 0,
          }),
        ),
      })),
    };
    const proNamespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch: (request: Request) => worker.fetch(request) })),
    };
    const facade = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        developerApiFacadeWorker.fetch(new Request(input, init), {
          PRO_ROOM_DEVELOPER_ROOMS: proNamespace,
        }),
    };
    const response = await developerApiWorker.fetch(
      new Request(`https://api.musixquare.com/v1/rooms/${roomCode}/queue`, {
        headers: {
          authorization: `Bearer mxqr_live_${keyId}.${keySecret}`,
          'cf-connecting-ip': '203.0.113.50',
        },
      }),
      {
        DEVELOPER_API_MODE: 'enabled',
        MXQR_DEVELOPER_API_KEY_PEPPER: pepper,
        MXQR_DEVELOPER_API_RATE_SECRET: 'developer-api-rate'.padEnd(48, 'r'),
        DEVELOPER_API_DB: database,
        DEVELOPER_API_LIMITERS: limiter,
        DEVELOPER_API_FACADE: facade,
      },
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      schemaVersion: 1,
      view: 'queue',
      roomCode,
      playlistRevision: 5,
      currentQueueItemId: queueItemId,
      items: [
        {
          queueItemId,
          kind: 'audio',
          name: 'Facade Orchestra.flac',
          addedBy: 'participant',
          title: 'Facade Orchestra',
          byteLength: 4_096,
        },
      ],
    });
    expect(response.headers.get('etag')).toMatch(/^"mxqr-queue-[A-Za-z0-9_-]{43}"$/);
    expect(JSON.stringify(payload)).not.toContain('private-composed-asset');
    expect(JSON.stringify(payload)).not.toContain('source');
    expect(JSON.stringify(payload)).not.toContain('mime');
  });

  it('freezes a sleeping room position instead of extrapolating it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T02:00:00.000Z'));
    const { worker } = await activatedRoom();
    const internal = worker as unknown as {
      room: {
        runtime: string;
        playlistRevision: number;
        playlist: Array<Record<string, any>>;
        currentQueueItemId: string;
        playback: Record<string, any>;
      };
    };
    const queueItemId = '22222222-2222-4222-8222-222222222222';
    internal.room.runtime = 'sleeping';
    internal.room.playlistRevision = 1;
    internal.room.playlist = [
      {
        queueItemId,
        name: 'Video',
        source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      },
    ];
    internal.room.currentQueueItemId = queueItemId;
    internal.room.playback = {
      coordinatorEpoch: 1,
      revision: 1,
      state: 'playing',
      queueItemId,
      positionSeconds: 30,
      updatedAtMs: Date.now() - 60_000,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    };
    const playback = await responseJson(await internalDeveloperRead(worker, 'playback'));
    expect(playback.positionSeconds).toBe(30);
    vi.useRealTimers();
  });

  it('clamps a frozen playback position to the persisted seven-day state bound', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T03:00:00.000Z'));
    const { worker } = await activatedRoom();
    const internal = worker as unknown as {
      room: { playback: Record<string, any> };
      freezePlayback(nowMs: number): void;
    };
    internal.room.playback.state = 'playing';
    internal.room.playback.positionSeconds = 604_799;
    internal.room.playback.updatedAtMs = Date.now() - 10_000;
    internal.freezePlayback(Date.now());
    expect(internal.room.playback.positionSeconds).toBe(604_800);
  });

  it('rejects non-active rooms and exact-body violations', async () => {
    const { worker } = await activatedRoom();
    const rollingCompatibleRead = await worker.fetch(
      new Request('https://pro-room.internal/internal/developer/v1/read', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({ projection: 'room' }),
      }),
    );
    expect(rollingCompatibleRead.status).toBe(200);
    await expect(responseJson(rollingCompatibleRead)).resolves.toMatchObject({
      view: 'room',
      roomCode: ROOM_CODE,
    });

    const invalid = await worker.fetch(
      new Request('https://pro-room.internal/internal/developer/v1/read', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({ projection: 'room', keyId: DEVELOPER_KEY_ID, admin: true }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await responseJson(invalid)).toEqual({ error: 'INVALID_REQUEST' });

    const internal = worker as unknown as { room: { status: string } };
    internal.room.status = 'suspended';
    const suspended = await internalDeveloperRead(worker, 'room');
    expect(suspended.status).toBe(404);
    expect(await responseJson(suspended)).toEqual({ error: 'ROOM_NOT_FOUND' });
  });

  it('accepts sleeping-room queue writes and replays an identical idempotent intent exactly once', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    internal.room.runtime = 'sleeping';
    internal.room.presence.coordinatorParticipantId = null;
    internal.room.presence.participants = {};
    const keyId = 'Q'.repeat(16);
    const mutation = {
      type: 'add_youtube',
      videoId: 'dQw4w9WgXcQ',
      playlistId: 'PL_SINGLE_KEEP',
      videoIds: ['dQw4w9WgXcQ', '9bZkp7q19f0'],
      name: 'Never Gonna Give You Up',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
    };

    const firstResponse = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-add-0001',
      mutation,
    );
    expect(firstResponse.status).toBe(201);
    const first = await responseJson(firstResponse);
    expect(first).toMatchObject({
      schemaVersion: 1,
      view: 'queue',
      roomCode: ROOM_CODE,
      playlistRevision: 1,
      currentQueueItemId: null,
      items: [
        {
          kind: 'youtube',
          name: mutation.name,
          title: mutation.title,
          artist: mutation.artist,
        },
      ],
    });
    expect(internal.room.runtime).toBe('sleeping');
    expect(internal.room.playlist).toHaveLength(1);
    expect(internal.room.playlist[0].source).toEqual({
      kind: 'youtube',
      videoId: mutation.videoId,
      playlistId: mutation.playlistId,
      videoIds: mutation.videoIds,
    });
    expect(internal.room.playback).toMatchObject({ state: 'idle', queueItemId: null });
    const queueIdempotencyRecord = Object.values(internal.room.developerMutationIdempotency).find(
      (record: any) => record.kind === 'developer-queue',
    ) as Record<string, unknown> | undefined;
    expect(queueIdempotencyRecord).toMatchObject({ kind: 'developer-queue', status: 201 });
    expect(queueIdempotencyRecord).not.toHaveProperty('body');

    const replayResponse = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-add-0001',
      mutation,
    );
    expect(replayResponse.status).toBe(201);
    expect(await responseJson(replayResponse)).toEqual(first);
    expect(internal.room.playlist).toHaveLength(1);

    const conflict = await mutateInternalDeveloperQueue(worker, keyId, 'developer-queue-add-0001', {
      ...mutation,
      videoId: 'M7lc1UVf-VE',
      videoIds: ['M7lc1UVf-VE', '9bZkp7q19f0'],
    });
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toEqual({ error: 'IDEMPOTENCY_CONFLICT' });
    expect(internal.room.playlist).toHaveLength(1);
  });

  it('never evicts live Developer API add or clear receipts when their ledger is saturated', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const keyId = 'S'.repeat(16);
    const addMutation = {
      type: 'add_youtube',
      videoId: 'dQw4w9WgXcQ',
      name: 'Exactly once',
    };
    const addKey = 'developer-saturation-add-0001';
    const clearKey = 'developer-saturation-clear-0001';

    expect((await mutateInternalDeveloperQueue(worker, keyId, addKey, addMutation)).status).toBe(
      201,
    );
    const seededItem = structuredClone(internal.room.playlist[0]);
    expect(
      (
        await mutateInternalDeveloperQueue(worker, keyId, clearKey, {
          type: 'clear',
        })
      ).status,
    ).toBe(200);
    expect(internal.room.playlist).toEqual([]);

    const nowMs = Date.now();
    for (
      let index = Object.keys(internal.room.developerMutationIdempotency).length;
      index < 256;
      index += 1
    ) {
      internal.room.developerMutationIdempotency[
        `developer:${keyId}:queue:add_youtube:filler-${String(index).padStart(3, '0')}`
      ] = {
        fingerprint: 'f'.repeat(43),
        kind: 'developer-queue',
        status: 201,
        expiresAtMs: nowMs + 60 * 60 * 1000 + index,
      };
    }

    const addReplay = await mutateInternalDeveloperQueue(worker, keyId, addKey, addMutation);
    expect(addReplay.status).toBe(201);
    expect(internal.room.playlist).toEqual([]);
    const clearReplay = await mutateInternalDeveloperQueue(worker, keyId, clearKey, {
      type: 'clear',
    });
    expect(clearReplay.status).toBe(200);
    expect(internal.room.playlist).toEqual([]);
    expect(Object.keys(internal.room.developerMutationIdempotency)).toHaveLength(256);

    const rejectedAdd = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-saturation-add-0002',
      { ...addMutation, videoId: 'M7lc1UVf-VE' },
    );
    expect(rejectedAdd.status).toBe(409);
    await expect(rejectedAdd.json()).resolves.toEqual({
      error: 'ROOM_STATE_CAPACITY_EXCEEDED',
    });
    expect(internal.room.playlist).toEqual([]);

    internal.room.playlist = [seededItem];
    internal.room.playlistRevision += 1;
    internal.room.revision += 1;
    const rejectedClear = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-saturation-clear-0002',
      { type: 'clear' },
    );
    expect(rejectedClear.status).toBe(409);
    await expect(rejectedClear.json()).resolves.toEqual({
      error: 'ROOM_STATE_CAPACITY_EXCEEDED',
    });
    expect(internal.room.playlist).toEqual([seededItem]);
    expect(Object.keys(internal.room.developerMutationIdempotency)).toHaveLength(256);
  });

  it('durably migrates legacy Developer receipts and BOT counters before serving API work', async () => {
    const { worker, state, bucket } = await activatedRoom();
    const internal = worker as unknown as {
      room: Record<string, any>;
      persist(): Promise<void>;
    };
    const keyId = 'M'.repeat(16);
    const idempotencyKey = 'developer-ledger-migration-0001';
    const mutation = {
      type: 'add_youtube',
      videoId: 'dQw4w9WgXcQ',
      name: 'Migrated exactly once',
    };
    expect(
      (await mutateInternalDeveloperQueue(worker, keyId, idempotencyKey, mutation)).status,
    ).toBe(201);
    const storageKey = `developer:${keyId}:queue:add_youtube:${idempotencyKey}`;
    internal.room.idempotency[storageKey] = internal.room.developerMutationIdempotency[storageKey];
    delete internal.room.developerMutationIdempotency[storageKey];
    const botKey = `bot-room-hour-v1:${ROOM_CODE}`;
    internal.room.rateLimits[botKey] = {
      count: 7,
      resetAtMs: Date.now() + 60 * 60 * 1000,
    };
    delete internal.room.botRateLimits[botKey];
    await internal.persist();

    const restarted = new MusixquareProRoom(state as never, environment(bucket) as never);
    expect((await internalDeveloperRead(restarted, 'room')).status).toBe(200);
    const restartedInternal = restarted as unknown as { room: Record<string, any> };
    expect(restartedInternal.room.idempotency[storageKey]).toBeUndefined();
    expect(restartedInternal.room.developerMutationIdempotency[storageKey]).toMatchObject({
      kind: 'developer-queue',
      status: 201,
    });
    expect(restartedInternal.room.rateLimits[botKey]).toBeUndefined();
    expect(restartedInternal.room.botRateLimits[botKey]).toMatchObject({ count: 7 });

    const persisted = state.storage.data.get('pro-room:v2:core') as Record<string, any>;
    expect(persisted.core.idempotency[storageKey]).toBeUndefined();
    expect(persisted.core.developerMutationIdempotency[storageKey]).toBeDefined();
    expect(persisted.core.rateLimits[botKey]).toBeUndefined();
    expect(persisted.core.botRateLimits[botKey]).toMatchObject({ count: 7 });

    const replay = await mutateInternalDeveloperQueue(restarted, keyId, idempotencyKey, mutation);
    expect(replay.status).toBe(201);
    expect(restartedInternal.room.playlist).toHaveLength(1);
  });

  it('atomically appends one ordered YouTube batch with one revision and caller ownership', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    internal.room.runtime = 'sleeping';
    internal.room.presence.coordinatorParticipantId = null;
    internal.room.presence.participants = {};
    const keyId = 'B'.repeat(16);
    const mutation = {
      type: 'add_youtube_batch',
      items: [
        { videoId: 'dQw4w9WgXcQ', name: 'First', title: 'First title' },
        {
          videoId: 'M7lc1UVf-VE',
          playlistId: 'PL1234567890',
          name: 'Second',
          artist: 'Second artist',
        },
      ],
    };
    const before = {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
    };

    const firstResponse = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-batch-0001',
      mutation,
      'Friend integration',
    );
    expect(firstResponse.status).toBe(201);
    const first = await responseJson(firstResponse);
    expect(first).toMatchObject({
      playlistRevision: before.playlistRevision + 1,
      currentQueueItemId: null,
      items: [
        {
          kind: 'youtube',
          name: 'First',
          title: 'First title',
          addedBy: 'current_api_key',
        },
        {
          kind: 'youtube',
          name: 'Second',
          artist: 'Second artist',
          addedBy: 'current_api_key',
        },
      ],
    });
    expect(new Set(first.items.map((item: any) => item.queueItemId)).size).toBe(2);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);
    expect(internal.room.playlist.map((item: any) => item.source.videoId)).toEqual([
      'dQw4w9WgXcQ',
      'M7lc1UVf-VE',
    ]);
    expect(internal.room.playlist.every((item: any) => item.developerOwnerKeyId === keyId)).toBe(
      true,
    );
    expect(internal.room.runtime).toBe('sleeping');
    expect(internal.room.playback).toMatchObject({ state: 'idle', queueItemId: null });

    const replay = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-batch-0001',
      mutation,
      'Friend integration',
    );
    expect(replay.status).toBe(201);
    expect(await responseJson(replay)).toEqual(first);
    expect(internal.room.playlist).toHaveLength(2);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);

    const conflict = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-batch-0001',
      {
        ...mutation,
        items: [{ videoId: '9bZkp7q19f0', name: 'Different intent' }],
      },
      'Friend integration',
    );
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toEqual({ error: 'IDEMPOTENCY_CONFLICT' });
    expect(internal.room.playlist).toHaveLength(2);
  });

  it('keeps flat videos while collapsing repeated playlist rows into ordered manifests', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const keyId = 'C'.repeat(16);
    const mutation = {
      type: 'add_youtube_batch',
      items: [
        {
          videoId: 'dQw4w9WgXcQ',
          playlistId: 'PL_ALPHA',
          name: 'Playlist alpha first',
        },
        { videoId: 'M7lc1UVf-VE', name: 'Standalone one' },
        {
          videoId: '9bZkp7q19f0',
          playlistId: 'PL_ALPHA',
          name: 'Playlist alpha duplicate',
        },
        {
          videoId: 'aqz-KE-bpKQ',
          playlistId: 'PL_BETA',
          name: 'Playlist beta first',
        },
        { videoId: 'ScMzIvxBSi4', name: 'Standalone two' },
        {
          videoId: 'jNQXAC9IVRw',
          playlistId: 'PL_BETA',
          name: 'Playlist beta duplicate',
        },
      ],
    };
    const before = {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
    };

    const firstResponse = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-batch-playlist-dedupe',
      mutation,
    );
    expect(firstResponse.status).toBe(201);
    const first = await responseJson(firstResponse);
    expect(first.items.map((item: any) => item.name)).toEqual([
      'Playlist alpha first',
      'Standalone one',
      'Playlist beta first',
      'Standalone two',
    ]);
    expect(
      internal.room.playlist.map((item: any) => ({ name: item.name, source: item.source })),
    ).toEqual([
      {
        name: 'Playlist alpha first',
        source: {
          kind: 'youtube',
          videoId: 'dQw4w9WgXcQ',
          playlistId: 'PL_ALPHA',
          videoIds: ['dQw4w9WgXcQ', '9bZkp7q19f0'],
        },
      },
      {
        name: 'Standalone one',
        source: { kind: 'youtube', videoId: 'M7lc1UVf-VE' },
      },
      {
        name: 'Playlist beta first',
        source: {
          kind: 'youtube',
          videoId: 'aqz-KE-bpKQ',
          playlistId: 'PL_BETA',
          videoIds: ['aqz-KE-bpKQ', 'jNQXAC9IVRw'],
        },
      },
      {
        name: 'Standalone two',
        source: { kind: 'youtube', videoId: 'ScMzIvxBSi4' },
      },
    ]);
    expect(internal.room.playlist.every((item: any) => item.developerOwnerKeyId === keyId)).toBe(
      true,
    );
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);

    const replay = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-batch-playlist-dedupe',
      mutation,
    );
    expect(replay.status).toBe(201);
    expect(await responseJson(replay)).toEqual(first);
    expect(internal.room.playlist).toHaveLength(4);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);

    const conflict = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-batch-playlist-dedupe',
      {
        type: 'add_youtube_batch',
        items: [{ videoId: 'jNQXAC9IVRw', name: 'Different intent' }],
      },
    );
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toEqual({ error: 'IDEMPOTENCY_CONFLICT' });
    expect(internal.room.playlist).toHaveLength(4);
  });

  it('deduplicates identical canonical batch manifests and rejects ambiguous mixed rows', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const keyId = 'M'.repeat(16);
    const videoIds = ['9bZkp7q19f0', 'dQw4w9WgXcQ', 'M7lc1UVf-VE'];
    const identical = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-identical-manifests',
      {
        type: 'add_youtube_batch',
        items: [
          {
            videoId: 'dQw4w9WgXcQ',
            playlistId: 'PL_CANONICAL',
            videoIds,
            name: 'Canonical entry',
          },
          {
            videoId: 'M7lc1UVf-VE',
            playlistId: 'PL_CANONICAL',
            videoIds,
            name: 'Same canonical manifest',
          },
        ],
      },
    );
    expect(identical.status).toBe(201);
    expect(internal.room.playlist).toHaveLength(1);
    expect(internal.room.playlist[0].source).toEqual({
      kind: 'youtube',
      videoId: 'dQw4w9WgXcQ',
      playlistId: 'PL_CANONICAL',
      videoIds,
    });

    const before = structuredClone(internal.room.playlist);
    const mixed = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-mixed-manifest-rows',
      {
        type: 'add_youtube_batch',
        items: [
          {
            videoId: 'dQw4w9WgXcQ',
            playlistId: 'PL_MIXED',
            videoIds,
            name: 'Manifest row',
          },
          {
            videoId: 'M7lc1UVf-VE',
            playlistId: 'PL_MIXED',
            name: 'Manifest-less row',
          },
        ],
      },
    );
    expect(mixed.status).toBe(400);
    await expect(mixed.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
    expect(internal.room.playlist).toEqual(before);
  });

  it('rejects invalid or over-capacity YouTube batches without a partial append', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const keyId = 'B'.repeat(16);
    const invalidMutations = [
      { type: 'add_youtube_batch', items: [] },
      {
        type: 'add_youtube_batch',
        items: Array.from({ length: 101 }, (_, index) => ({
          videoId: 'dQw4w9WgXcQ',
          name: `Track ${index}`,
        })),
      },
      {
        type: 'add_youtube_batch',
        items: [
          { videoId: 'dQw4w9WgXcQ', name: 'Valid' },
          { videoId: 'invalid', name: 'Invalid' },
        ],
      },
      {
        type: 'add_youtube_batch',
        items: [
          {
            videoId: 'dQw4w9WgXcQ',
            name: 'Manifest without playlist',
            videoIds: ['dQw4w9WgXcQ'],
          },
        ],
      },
      {
        type: 'add_youtube_batch',
        items: [
          {
            videoId: 'dQw4w9WgXcQ',
            playlistId: 'PL_INVALID_EMPTY',
            name: 'Empty manifest',
            videoIds: [],
          },
        ],
      },
      {
        type: 'add_youtube_batch',
        items: [
          {
            videoId: 'dQw4w9WgXcQ',
            playlistId: 'PL_INVALID_FIRST',
            name: 'Missing entry video',
            videoIds: ['9bZkp7q19f0', 'M7lc1UVf-VE'],
          },
        ],
      },
      {
        type: 'add_youtube_batch',
        items: [
          {
            videoId: 'dQw4w9WgXcQ',
            playlistId: 'PL_INVALID_ID',
            name: 'Invalid manifest ID',
            videoIds: ['dQw4w9WgXcQ', 'invalid'],
          },
        ],
      },
      {
        type: 'add_youtube_batch',
        items: [
          {
            videoId: 'dQw4w9WgXcQ',
            playlistId: 'PL_TOO_LONG',
            name: 'Too-long manifest',
            videoIds: Array.from({ length: 5001 }, () => 'dQw4w9WgXcQ'),
          },
        ],
      },
    ];
    for (const [index, mutation] of invalidMutations.entries()) {
      const before = structuredClone(internal.room.playlist);
      const response = await mutateInternalDeveloperQueue(
        worker,
        keyId,
        `developer-queue-batch-invalid-${index}`,
        mutation,
      );
      expect(response.status).toBe(400);
      expect(await responseJson(response)).toEqual({ error: 'INVALID_REQUEST' });
      expect(internal.room.playlist).toEqual(before);
    }

    internal.room.playlist = Array.from({ length: 999 }, (_, index) => ({
      queueItemId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      name: `Existing ${index}`,
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    }));
    const playlistBeforeCapacity = structuredClone(internal.room.playlist);
    const revisionBeforeCapacity = internal.room.revision;
    const playlistRevisionBeforeCapacity = internal.room.playlistRevision;
    const overCapacity = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-batch-over-capacity',
      {
        type: 'add_youtube_batch',
        items: [
          { videoId: 'M7lc1UVf-VE', name: 'Would fit alone' },
          { videoId: '9bZkp7q19f0', name: 'Makes batch overflow' },
        ],
      },
    );
    expect(overCapacity.status).toBe(409);
    expect(await responseJson(overCapacity)).toEqual({ error: 'PLAYLIST_CAPACITY_EXCEEDED' });
    expect(internal.room.playlist).toEqual(playlistBeforeCapacity);
    expect(internal.room.revision).toBe(revisionBeforeCapacity);
    expect(internal.room.playlistRevision).toBe(playlistRevisionBeforeCapacity);

    internal.room.playlist = [];
    internal.room.playlistRevision = Number.MAX_SAFE_INTEGER;
    const revisionOverflow = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-batch-revision-overflow',
      {
        type: 'add_youtube_batch',
        items: [{ videoId: 'M7lc1UVf-VE', name: 'Must remain absent' }],
      },
    );
    expect(revisionOverflow.status).toBe(409);
    expect(await responseJson(revisionOverflow)).toEqual({
      error: 'ROOM_STATE_CAPACITY_EXCEEDED',
    });
    expect(internal.room.playlist).toEqual([]);
  });

  it('rolls back the entire batch when the bounded room-state persist rejects it', async () => {
    const { worker, state } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const stateLimitBytes = 1_200 * 1024;
    const paddingKey = 'batch-capacity-padding';
    internal.room.rateLimits[paddingKey] = {
      count: 0,
      resetAtMs: Date.now() + 60 * 60 * 1_000,
      padding: '',
    };
    const bytesBeforePadding = new TextEncoder().encode(JSON.stringify(internal.room)).byteLength;
    const paddingLength = stateLimitBytes - 256 - bytesBeforePadding;
    expect(paddingLength).toBeGreaterThan(4_096);
    internal.room.rateLimits[paddingKey].padding = 'P'.repeat(paddingLength);
    expect(new TextEncoder().encode(JSON.stringify(internal.room)).byteLength).toBeLessThan(
      stateLimitBytes,
    );
    await state.storage.put('pro-room:v1', structuredClone(internal.room));

    const before = {
      playlist: structuredClone(internal.room.playlist),
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
      idempotency: structuredClone(internal.room.idempotency),
      developerMutationIdempotency: structuredClone(internal.room.developerMutationIdempotency),
    };
    const response = await mutateInternalDeveloperQueue(
      worker,
      'B'.repeat(16),
      'developer-queue-batch-state-capacity',
      {
        type: 'add_youtube_batch',
        items: [
          {
            videoId: 'dQw4w9WgXcQ',
            name: 'N'.repeat(512),
            title: 'T'.repeat(512),
            artist: 'A'.repeat(512),
            thumbnail: 'H'.repeat(512),
          },
          {
            videoId: 'M7lc1UVf-VE',
            name: 'M'.repeat(512),
            title: 'U'.repeat(512),
            artist: 'B'.repeat(512),
            thumbnail: 'I'.repeat(512),
          },
        ],
      },
      'State capacity test',
    );

    expect(response.status).toBe(409);
    expect(await responseJson(response)).toEqual({ error: 'ROOM_STATE_CAPACITY_EXCEEDED' });
    expect(internal.room.playlist).toEqual(before.playlist);
    expect(internal.room.revision).toBe(before.revision);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision);
    expect(internal.room.idempotency).toEqual(before.idempotency);
    expect(internal.room.developerMutationIdempotency).toEqual(before.developerMutationIdempotency);
    expect(
      Object.keys(internal.room.developerMutationIdempotency).some((key) =>
        key.includes('developer-queue-batch-state-capacity'),
      ),
    ).toBe(false);

    const persisted = state.storage.data.get('pro-room:v1') as Record<string, any>;
    expect(persisted.playlist).toEqual(before.playlist);
    expect(persisted.revision).toBe(before.revision);
    expect(persisted.playlistRevision).toBe(before.playlistRevision);
    expect(persisted.idempotency).toEqual(before.idempotency);
    expect(persisted.developerMutationIdempotency).toEqual(before.developerMutationIdempotency);
  });

  it('accepts the authenticated envelope around a near-64-KiB public batch', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const items = Array.from({ length: 100 }, (_, index) => ({
      videoId: 'dQw4w9WgXcQ',
      name: `${index}`.padEnd(304, 'N'),
      title: 'T'.repeat(304),
    }));
    const response = await mutateInternalDeveloperQueue(
      worker,
      'B'.repeat(16),
      'developer-queue-batch-boundary',
      { type: 'add_youtube_batch', items },
      'A'.repeat(64),
    );

    expect(response.status).toBe(201);
    expect(internal.room.playlist).toHaveLength(100);
    expect(internal.room.playlistRevision).toBe(1);
    expect(internal.room.revision).toBe(2);
  });

  it('returns and replays a committed batch when the full queue projection exceeds 64 KiB', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    internal.room.playlist = Array.from({ length: 100 }, (_, index) => ({
      queueItemId: `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      name: `${index}`.padEnd(512, 'N'),
      title: 'T'.repeat(512),
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    }));
    internal.room.playlistRevision = 7;
    const before = {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
    };
    const rooms = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch: (request: Request) => worker.fetch(request) })),
    };
    const facadeBody = {
      roomCode: ROOM_CODE,
      keyId: 'B'.repeat(16),
      actorName: 'Large response bot',
      idempotencyKey: 'developer-queue-batch-large-response',
      mutation: {
        type: 'add_youtube_batch',
        items: [
          { videoId: 'M7lc1UVf-VE', name: 'Batch item one' },
          { videoId: '9bZkp7q19f0', name: 'Batch item two' },
        ],
      },
    };
    const callFacade = () =>
      developerApiFacadeWorker.fetch(
        new Request('https://developer-api-facade.internal/internal/v1/queue/mutate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(facadeBody),
        }),
        { PRO_ROOM_DEVELOPER_ROOMS: rooms },
      );

    const first = await callFacade();
    expect(first.status).toBe(201);
    const firstText = await first.text();
    expect(new TextEncoder().encode(firstText).byteLength).toBeGreaterThan(64 * 1024);
    expect(JSON.parse(firstText)).toMatchObject({
      playlistRevision: before.playlistRevision + 1,
      items: expect.arrayContaining([
        expect.objectContaining({ name: 'Batch item one', addedBy: 'current_api_key' }),
        expect.objectContaining({ name: 'Batch item two', addedBy: 'current_api_key' }),
      ]),
    });
    expect(internal.room.playlist).toHaveLength(102);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);

    const replay = await callFacade();
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(firstText);
    expect(internal.room.playlist).toHaveLength(102);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);
  });

  it('keeps API ownership private while classifying legacy, participant, and per-key additions', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const legacyQueueItemId = '10000000-0000-4000-8000-000000000001';
    const participantQueueItemId = '10000000-0000-4000-8000-000000000002';
    const firstKeyId = 'A'.repeat(16);
    const secondKeyId = 'B'.repeat(16);
    internal.room.playlist = [
      {
        queueItemId: legacyQueueItemId,
        name: 'Legacy participant item',
        source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      },
    ];
    internal.room.playlistRevision = 1;
    internal.room.revision += 1;

    const firstAdded = await responseJson(
      await mutateInternalDeveloperQueue(worker, firstKeyId, 'developer-owner-first-add', {
        type: 'add_youtube',
        videoId: 'M7lc1UVf-VE',
        name: 'First integration item',
      }),
    );
    const firstOwnedId = firstAdded.items.at(-1).queueItemId;
    expect(firstAdded.items).toEqual([
      expect.objectContaining({ queueItemId: legacyQueueItemId, addedBy: 'participant' }),
      expect.objectContaining({ queueItemId: firstOwnedId, addedBy: 'current_api_key' }),
    ]);

    const secondAdded = await responseJson(
      await mutateInternalDeveloperQueue(worker, secondKeyId, 'developer-owner-second-add', {
        type: 'add_youtube',
        videoId: '9bZkp7q19f0',
        name: 'Second integration item',
      }),
    );
    const secondOwnedId = secondAdded.items.at(-1).queueItemId;
    expect(secondAdded.items).toEqual([
      expect.objectContaining({ queueItemId: legacyQueueItemId, addedBy: 'participant' }),
      expect.objectContaining({ queueItemId: firstOwnedId, addedBy: 'another_api_key' }),
      expect.objectContaining({ queueItemId: secondOwnedId, addedBy: 'current_api_key' }),
    ]);

    const publicBefore = await responseJson(
      await worker.fetch(request('/snapshot', {}, ownerCookie)),
    );
    expect(parseProRoomSnapshot(publicBefore.snapshot)).not.toBeNull();
    expect(JSON.stringify(publicBefore.snapshot)).not.toContain('developerOwnerKeyId');
    expect(JSON.stringify(publicBefore.snapshot)).not.toContain(firstKeyId);
    expect(JSON.stringify(publicBefore.snapshot)).not.toContain(secondKeyId);

    const unchangedRoundTrip = await worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: publicBefore.snapshot.revision,
          playlist: publicBefore.snapshot.playlist,
          currentQueueItemId: publicBefore.snapshot.currentQueueItemId,
          playback: publicBefore.snapshot.playback,
        },
        ownerCookie,
        'participant-unchanged-round-trip',
      ),
    );
    expect(unchangedRoundTrip.status).toBe(200);
    const unchangedEnvelope = await responseJson(unchangedRoundTrip);
    expect(unchangedEnvelope.snapshot.playlistRevision).toBe(
      publicBefore.snapshot.playlistRevision,
    );

    const participantPlaylist = [
      ...unchangedEnvelope.snapshot.playlist,
      {
        queueItemId: participantQueueItemId,
        name: 'New participant item',
        source: { kind: 'youtube', videoId: 'aqz-KE-bpKQ' },
      },
    ];
    const roundTrip = await worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: unchangedEnvelope.snapshot.revision,
          playlist: participantPlaylist,
          currentQueueItemId: unchangedEnvelope.snapshot.currentQueueItemId,
          playback: unchangedEnvelope.snapshot.playback,
        },
        ownerCookie,
        'participant-round-trip-ownership',
      ),
    );
    expect(roundTrip.status).toBe(200);
    const roundTripEnvelope = await responseJson(roundTrip);
    expect(parseProRoomSnapshot(roundTripEnvelope.snapshot)).not.toBeNull();
    expect(JSON.stringify(roundTripEnvelope.snapshot)).not.toContain('developerOwnerKeyId');

    expect(
      internal.room.playlist.find((item: any) => item.queueItemId === legacyQueueItemId),
    ).not.toHaveProperty('developerOwnerKeyId');
    expect(
      internal.room.playlist.find((item: any) => item.queueItemId === participantQueueItemId),
    ).not.toHaveProperty('developerOwnerKeyId');
    expect(
      internal.room.playlist.find((item: any) => item.queueItemId === firstOwnedId),
    ).toHaveProperty('developerOwnerKeyId', firstKeyId);
    expect(
      internal.room.playlist.find((item: any) => item.queueItemId === secondOwnedId),
    ).toHaveProperty('developerOwnerKeyId', secondKeyId);

    const firstKeyView = await responseJson(
      await internalDeveloperRead(worker, 'queue', firstKeyId),
    );
    expect(firstKeyView.items.map((item: any) => [item.queueItemId, item.addedBy])).toEqual([
      [legacyQueueItemId, 'participant'],
      [firstOwnedId, 'current_api_key'],
      [secondOwnedId, 'another_api_key'],
      [participantQueueItemId, 'participant'],
    ]);

    const rollingCompatibleView = await responseJson(
      await worker.fetch(
        new Request('https://pro-room.internal/internal/developer/v1/read', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': ROOM_CODE,
          },
          body: JSON.stringify({ projection: 'queue' }),
        }),
      ),
    );
    expect(
      rollingCompatibleView.items.every(
        (item: Record<string, unknown>) => !Object.prototype.hasOwnProperty.call(item, 'addedBy'),
      ),
    ).toBe(true);

    const forged = await worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: roundTripEnvelope.snapshot.revision,
          playlist: roundTripEnvelope.snapshot.playlist.map((item: any, index: number) =>
            index === 0 ? { ...item, developerOwnerKeyId: firstKeyId } : item,
          ),
          currentQueueItemId: roundTripEnvelope.snapshot.currentQueueItemId,
          playback: roundTripEnvelope.snapshot.playback,
        },
        ownerCookie,
        'participant-forged-ownership',
      ),
    );
    expect(forged.status).toBe(400);
    expect(await responseJson(forged)).toEqual({ error: 'INVALID_PLAYLIST' });
  });

  it('atomically removes one bounded item set and resets selected playback with one revision step', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T03:00:00.000Z'));
    const context = await activatedRoom();
    const { worker, ownerCookie } = context;
    const internal = worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    const { asset } = await completeReadyAsset(context, 'developer-remove-many');
    const audioQueueItemId = '51515151-5151-4515-8515-515151515151';
    expect(
      await replacePlaylist(
        context,
        [playlistItem(audioQueueItemId, asset)],
        'developer-remove-many',
      ),
    ).toMatchObject({ status: 200 });
    const seeded = await responseJson(
      await mutateInternalDeveloperQueue(worker, 'R'.repeat(16), 'developer-remove-many-seed', {
        type: 'add_youtube_batch',
        items: [
          { videoId: 'dQw4w9WgXcQ', name: 'Remove this too' },
          { videoId: 'M7lc1UVf-VE', name: 'Keep this' },
        ],
      }),
    );
    const removeYouTubeId = seeded.items[1].queueItemId;
    const keepQueueItemId = seeded.items[2].queueItemId;
    internal.room.currentQueueItemId = audioQueueItemId;
    internal.room.playback = {
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
      revision: 9,
      state: 'playing',
      queueItemId: audioQueueItemId,
      positionSeconds: 21,
      updatedAtMs: Date.now() - 1_000,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    };
    const capability = await worker.fetch(
      jsonRequest('/signaling-tickets', 'POST', { developerControlVersion: 1 }, ownerCookie),
    );
    expect(capability.status).toBe(200);
    const dispatched: Array<Record<string, any>> = [];
    const dispatchFetch = vi.fn(async (request: Request) => {
      dispatched.push((await request.json()) as Record<string, any>);
      return Response.json({ dispatched: true });
    });
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: dispatchFetch })),
    };
    const before = {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
      playbackRevision: internal.room.playback.revision,
    };
    const mutation = {
      type: 'remove_many',
      queueItemIds: [audioQueueItemId, removeYouTubeId],
    };

    const removed = await mutateInternalDeveloperQueue(
      worker,
      'R'.repeat(16),
      'developer-remove-many-0001',
      mutation,
    );

    expect(removed.status).toBe(200);
    const removedQueue = await responseJson(removed);
    expect(removedQueue).toMatchObject({
      playlistRevision: before.playlistRevision + 1,
      currentQueueItemId: null,
      items: [{ queueItemId: keepQueueItemId }],
    });
    expect(internal.room.playlist.map((item: Record<string, any>) => item.queueItemId)).toEqual([
      keepQueueItemId,
    ]);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);
    expect(internal.room.playback).toMatchObject({
      revision: before.playbackRevision + 1,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    });
    expect(asset.gcAfterMs).toBe(Date.now() + 15 * 60 * 1_000);
    await vi.waitFor(() => expect(dispatched).toHaveLength(2));
    expect(dispatched.map((message) => message.event?.type).sort()).toEqual([
      'pro-playback-commit',
      'pro-room-invalidated',
    ]);

    const replay = await mutateInternalDeveloperQueue(
      worker,
      'R'.repeat(16),
      'developer-remove-many-0001',
      mutation,
    );
    expect(replay.status).toBe(200);
    expect(await responseJson(replay)).toEqual(removedQueue);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);
    expect(internal.room.playback.revision).toBe(before.playbackRevision + 1);
    expect(dispatchFetch).toHaveBeenCalledTimes(2);

    const beforeMissing = structuredClone(internal.room);
    const missing = await mutateInternalDeveloperQueue(
      worker,
      'R'.repeat(16),
      'developer-remove-many-missing',
      {
        type: 'remove_many',
        queueItemIds: [keepQueueItemId, '52525252-5252-4525-8525-525252525252'],
      },
    );
    expect(missing.status).toBe(404);
    expect(await responseJson(missing)).toEqual({ error: 'QUEUE_ITEM_NOT_FOUND' });
    expect(internal.room.playlist).toEqual(beforeMissing.playlist);
    expect(internal.room.revision).toBe(beforeMissing.revision);
    expect(internal.room.playlistRevision).toBe(beforeMissing.playlistRevision);

    for (const [suffix, invalidMutation] of [
      ['empty', { type: 'remove_many', queueItemIds: [] }],
      ['duplicate', { type: 'remove_many', queueItemIds: [keepQueueItemId, keepQueueItemId] }],
      [
        'too-many',
        {
          type: 'remove_many',
          queueItemIds: Array.from(
            { length: 21 },
            (_, index) => `53535353-5353-4535-8535-${index.toString(16).padStart(12, '0')}`,
          ),
        },
      ],
    ] as const) {
      const invalid = await mutateInternalDeveloperQueue(
        worker,
        'R'.repeat(16),
        `developer-remove-many-${suffix}`,
        invalidMutation,
      );
      expect(invalid.status).toBe(400);
      expect(await responseJson(invalid)).toEqual({ error: 'INVALID_REQUEST' });
      expect(internal.room.playlist).toEqual(beforeMissing.playlist);
    }
  });

  it('atomically clears the queue, current playback, and R2 references with one revision step', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T04:00:00.000Z'));
    const context = await activatedRoom();
    const { worker, state, ownerCookie } = context;
    const internal = worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    const { asset } = await completeReadyAsset(context, 'developer-clear');
    const audioQueueItemId = '55555555-5555-4555-8555-555555555555';
    const replace = await replacePlaylist(
      context,
      [playlistItem(audioQueueItemId, asset)],
      'developer-clear',
    );
    expect(replace.status).toBe(200);
    const add = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-seed',
      { type: 'add_youtube', videoId: 'dQw4w9WgXcQ', name: 'Clear with audio' },
    );
    expect(add.status).toBe(201);
    expect(asset.gcAfterMs).toBeUndefined();

    internal.room.currentQueueItemId = audioQueueItemId;
    internal.room.playback = {
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
      revision: 7,
      state: 'playing',
      queueItemId: audioQueueItemId,
      positionSeconds: 12,
      updatedAtMs: Date.now() - 1_000,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    };
    const capability = await worker.fetch(
      jsonRequest('/signaling-tickets', 'POST', { developerControlVersion: 1 }, ownerCookie),
    );
    expect(capability.status).toBe(200);
    const dispatchedBodies: Array<Record<string, any>> = [];
    const dispatchFetch = vi.fn(async (request: Request) => {
      dispatchedBodies.push((await request.json()) as Record<string, any>);
      return Response.json({ dispatched: true });
    });
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: dispatchFetch })),
    };
    const before = {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
      playbackRevision: internal.room.playback.revision,
    };
    const clearMutation = { type: 'clear' };
    const clear = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-0001',
      clearMutation,
    );

    expect(clear.status).toBe(200);
    const clearedQueue = await responseJson(clear);
    expect(clearedQueue).toEqual({
      schemaVersion: 1,
      view: 'queue',
      roomCode: ROOM_CODE,
      playlistRevision: before.playlistRevision + 1,
      currentQueueItemId: null,
      items: [],
    });
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);
    expect(internal.room.playlist).toEqual([]);
    expect(internal.room.playback).toMatchObject({
      revision: before.playbackRevision + 1,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    });
    expect(asset.gcAfterMs).toBe(Date.now() + 15 * 60 * 1_000);
    expect((state.storage.data.get('pro-room:v1') as Record<string, any>).playlist).toEqual([]);
    await vi.waitFor(() => expect(dispatchedBodies).toHaveLength(2));
    expect(dispatchedBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          roomCode: ROOM_CODE,
          event: expect.objectContaining({
            type: 'pro-playback-commit',
            playback: expect.objectContaining({ state: 'idle', queueItemId: null }),
          }),
        }),
        expect.objectContaining({
          roomCode: ROOM_CODE,
          event: expect.objectContaining({
            type: 'pro-room-invalidated',
            playlistRevision: before.playlistRevision + 1,
          }),
        }),
      ]),
    );

    const replay = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-0001',
      clearMutation,
    );
    expect(replay.status).toBe(200);
    expect(await responseJson(replay)).toEqual(clearedQueue);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);
    expect(internal.room.playback.revision).toBe(before.playbackRevision + 1);
    expect(dispatchFetch).toHaveBeenCalledTimes(2);

    const emptyNoOp = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-0002',
      clearMutation,
    );
    expect(emptyNoOp.status).toBe(200);
    expect(await responseJson(emptyNoOp)).toEqual(clearedQueue);
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision + 1);
    expect(dispatchFetch).toHaveBeenCalledTimes(2);
  });

  it('clears only the current API key additions while preserving participant playback and replay safety', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const firstKeyId = 'A'.repeat(16);
    const secondKeyId = 'B'.repeat(16);
    const participantQueueItemId = '20000000-0000-4000-8000-000000000001';
    internal.room.playlist = [
      {
        queueItemId: participantQueueItemId,
        name: 'Participant keeps playing',
        source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      },
    ];
    internal.room.playlistRevision = 1;
    internal.room.revision += 1;

    const firstAdd = await responseJson(
      await mutateInternalDeveloperQueue(worker, firstKeyId, 'owned-clear-first-add', {
        type: 'add_youtube',
        videoId: 'M7lc1UVf-VE',
        name: 'First key item',
      }),
    );
    const firstOwnedId = firstAdd.items.at(-1).queueItemId;
    const secondAdd = await responseJson(
      await mutateInternalDeveloperQueue(worker, secondKeyId, 'owned-clear-second-add', {
        type: 'add_youtube',
        videoId: '9bZkp7q19f0',
        name: 'Second key item',
      }),
    );
    const secondOwnedId = secondAdd.items.at(-1).queueItemId;
    internal.room.currentQueueItemId = participantQueueItemId;
    internal.room.playback = {
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
      revision: 8,
      state: 'paused',
      queueItemId: participantQueueItemId,
      positionSeconds: 42,
      updatedAtMs: Date.now(),
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    };
    const before = {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
      playback: structuredClone(internal.room.playback),
    };

    const cleared = await mutateInternalDeveloperQueue(
      worker,
      firstKeyId,
      'owned-clear-current-key',
      { type: 'clear_owned' },
    );
    expect(cleared.status).toBe(200);
    expect(await responseJson(cleared)).toMatchObject({
      playlistRevision: before.playlistRevision + 1,
      currentQueueItemId: participantQueueItemId,
      items: [
        { queueItemId: participantQueueItemId, addedBy: 'participant' },
        { queueItemId: secondOwnedId, addedBy: 'another_api_key' },
      ],
    });
    expect(internal.room.playlist.map((item: any) => item.queueItemId)).toEqual([
      participantQueueItemId,
      secondOwnedId,
    ]);
    expect(internal.room.playlist.some((item: any) => item.queueItemId === firstOwnedId)).toBe(
      false,
    );
    expect(internal.room.revision).toBe(before.revision + 1);
    expect(internal.room.playback).toEqual(before.playback);

    const addedAfterClear = await responseJson(
      await mutateInternalDeveloperQueue(worker, firstKeyId, 'owned-clear-later-add', {
        type: 'add_youtube',
        videoId: 'aqz-KE-bpKQ',
        name: 'Added after clear',
      }),
    );
    const laterOwnedId = addedAfterClear.items.at(-1).queueItemId;
    const beforeReplay = {
      revision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
    };
    const replay = await mutateInternalDeveloperQueue(
      worker,
      firstKeyId,
      'owned-clear-current-key',
      { type: 'clear_owned' },
    );
    expect(replay.status).toBe(200);
    expect((await responseJson(replay)).items).toContainEqual(
      expect.objectContaining({ queueItemId: laterOwnedId, addedBy: 'current_api_key' }),
    );
    expect(internal.room.revision).toBe(beforeReplay.revision);
    expect(internal.room.playlistRevision).toBe(beforeReplay.playlistRevision);

    const noOp = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'owned-clear-empty-owner',
      { type: 'clear_owned' },
    );
    expect(noOp.status).toBe(200);
    expect(internal.room.revision).toBe(beforeReplay.revision);
    expect(internal.room.playlistRevision).toBe(beforeReplay.playlistRevision);
  });

  it('resets playback only when clear-owned removes the selected owner item', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const firstKeyId = 'A'.repeat(16);
    const secondKeyId = 'B'.repeat(16);
    const firstAdded = await responseJson(
      await mutateInternalDeveloperQueue(worker, firstKeyId, 'owned-current-first-add', {
        type: 'add_youtube',
        videoId: 'dQw4w9WgXcQ',
        name: 'Selected API item',
      }),
    );
    const firstOwnedId = firstAdded.items[0].queueItemId;
    const secondAdded = await responseJson(
      await mutateInternalDeveloperQueue(worker, secondKeyId, 'owned-current-second-add', {
        type: 'add_youtube',
        videoId: 'M7lc1UVf-VE',
        name: 'Other API item',
      }),
    );
    const secondOwnedId = secondAdded.items.at(-1).queueItemId;
    internal.room.currentQueueItemId = firstOwnedId;
    internal.room.playback = {
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
      revision: 4,
      state: 'playing',
      queueItemId: firstOwnedId,
      positionSeconds: 9,
      updatedAtMs: Date.now() - 500,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    };

    const cleared = await mutateInternalDeveloperQueue(worker, firstKeyId, 'owned-clear-selected', {
      type: 'clear_owned',
    });
    expect(cleared.status).toBe(200);
    expect(await responseJson(cleared)).toMatchObject({
      currentQueueItemId: null,
      items: [{ queueItemId: secondOwnedId, addedBy: 'another_api_key' }],
    });
    expect(internal.room.playback).toMatchObject({
      revision: 5,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    });
  });

  it('rejects clear-owned revision exhaustion without partial mutation', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const keyId = 'A'.repeat(16);
    const added = await responseJson(
      await mutateInternalDeveloperQueue(worker, keyId, 'owned-overflow-add', {
        type: 'add_youtube',
        videoId: 'dQw4w9WgXcQ',
        name: 'Overflow item',
      }),
    );
    const queueItemId = added.items[0].queueItemId;

    internal.room.playlistRevision = Number.MAX_SAFE_INTEGER;
    const playlistBefore = structuredClone(internal.room.playlist);
    const revisionOverflow = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'owned-overflow-playlist-revision',
      { type: 'clear_owned' },
    );
    expect(revisionOverflow.status).toBe(409);
    expect(await responseJson(revisionOverflow)).toEqual({ error: 'ROOM_STATE_CAPACITY_EXCEEDED' });
    expect(internal.room.playlist).toEqual(playlistBefore);

    internal.room.playlistRevision = 1;
    internal.room.revision = Number.MAX_SAFE_INTEGER;
    const roomRevisionOverflow = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'owned-overflow-room-revision',
      { type: 'clear_owned' },
    );
    expect(roomRevisionOverflow.status).toBe(409);
    expect(await responseJson(roomRevisionOverflow)).toEqual({
      error: 'ROOM_STATE_CAPACITY_EXCEEDED',
    });
    expect(internal.room.playlist).toEqual(playlistBefore);

    internal.room.revision = 1;
    internal.room.currentQueueItemId = queueItemId;
    internal.room.playback = {
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
      revision: Number.MAX_SAFE_INTEGER,
      state: 'paused',
      queueItemId,
      positionSeconds: 1,
      updatedAtMs: Date.now(),
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    };
    const playbackBefore = structuredClone(internal.room.playback);
    const playbackOverflow = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'owned-overflow-playback-revision',
      { type: 'clear_owned' },
    );
    expect(playbackOverflow.status).toBe(409);
    expect(await responseJson(playbackOverflow)).toEqual({ error: 'PLAYBACK_REVISION_EXHAUSTED' });
    expect(internal.room.playlist).toEqual(playlistBefore);
    expect(internal.room.playback).toEqual(playbackBefore);
  });

  it('rejects malformed or unsafe queue clears without partially mutating room state', async () => {
    const { worker, internal } = await preparedDeveloperCommandRoom();
    const before = structuredClone(internal.room);
    const malformed = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-invalid',
      { type: 'clear', basePlaylistRevision: internal.room.playlistRevision },
    );
    expect(malformed.status).toBe(400);
    expect(await responseJson(malformed)).toEqual({ error: 'INVALID_REQUEST' });
    expect(internal.room.playlist).toEqual(before.playlist);
    expect(internal.room.currentQueueItemId).toBe(before.currentQueueItemId);

    const malformedOwned = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-owned-invalid',
      { type: 'clear_owned', includeParticipants: true },
    );
    expect(malformedOwned.status).toBe(400);
    expect(await responseJson(malformedOwned)).toEqual({ error: 'INVALID_REQUEST' });
    expect(internal.room.playlist).toEqual(before.playlist);

    internal.room.playback.revision = Number.MAX_SAFE_INTEGER;
    const exhausted = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-exhausted',
      { type: 'clear' },
    );
    expect(exhausted.status).toBe(409);
    expect(await responseJson(exhausted)).toEqual({ error: 'PLAYBACK_REVISION_EXHAUSTED' });
    expect(internal.room.playlist).toEqual(before.playlist);
    expect(internal.room.currentQueueItemId).toBe(before.currentQueueItemId);
    expect(internal.room.playback).toMatchObject({
      revision: Number.MAX_SAFE_INTEGER,
      state: before.playback.state,
      queueItemId: before.playback.queueItemId,
    });

    internal.room.playback.revision = before.playback.revision;
    internal.room.playlistRevision = Number.MAX_SAFE_INTEGER;
    const playlistRevisionExhausted = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-playlist-revision-exhausted',
      { type: 'clear' },
    );
    expect(playlistRevisionExhausted.status).toBe(409);
    expect(await responseJson(playlistRevisionExhausted)).toEqual({
      error: 'ROOM_STATE_CAPACITY_EXCEEDED',
    });
    expect(internal.room.playlist).toEqual(before.playlist);
    expect(internal.room.currentQueueItemId).toBe(before.currentQueueItemId);
    expect(internal.room.playlistRevision).toBe(Number.MAX_SAFE_INTEGER);
    expect(internal.room.playback).toEqual(before.playback);

    internal.room.playlistRevision = before.playlistRevision;
    internal.room.revision = Number.MAX_SAFE_INTEGER;
    const roomRevisionExhausted = await mutateInternalDeveloperQueue(
      worker,
      'C'.repeat(16),
      'developer-queue-clear-room-revision-exhausted',
      { type: 'clear' },
    );
    expect(roomRevisionExhausted.status).toBe(409);
    expect(await responseJson(roomRevisionExhausted)).toEqual({
      error: 'ROOM_STATE_CAPACITY_EXCEEDED',
    });
    expect(internal.room.playlist).toEqual(before.playlist);
    expect(internal.room.currentQueueItemId).toBe(before.currentQueueItemId);
    expect(internal.room.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(internal.room.playlistRevision).toBe(before.playlistRevision);
    expect(internal.room.playback).toEqual(before.playback);
  });

  it('fences stale or non-permutation Developer API reorders by playlist revision', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const keyId = 'R'.repeat(16);
    for (const [index, videoId] of ['dQw4w9WgXcQ', 'M7lc1UVf-VE'].entries()) {
      const response = await mutateInternalDeveloperQueue(
        worker,
        keyId,
        `developer-queue-seed-000${index}`,
        { type: 'add_youtube', videoId, name: `Track ${index + 1}` },
      );
      expect(response.status).toBe(201);
    }
    const [firstId, secondId] = internal.room.playlist.map(
      (item: Record<string, unknown>) => item.queueItemId,
    );

    const stale = await mutateInternalDeveloperQueue(worker, keyId, 'developer-queue-order-0001', {
      type: 'reorder',
      basePlaylistRevision: internal.room.playlistRevision - 1,
      queueItemIds: [secondId, firstId],
    });
    expect(stale.status).toBe(409);
    expect(await responseJson(stale)).toEqual({ error: 'PLAYLIST_REVISION_CONFLICT' });

    const invalidSet = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-order-0002',
      {
        type: 'reorder',
        basePlaylistRevision: internal.room.playlistRevision,
        queueItemIds: [firstId],
      },
    );
    expect(invalidSet.status).toBe(409);
    expect(await responseJson(invalidSet)).toEqual({ error: 'PLAYLIST_REVISION_CONFLICT' });

    const accepted = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-queue-order-0003',
      {
        type: 'reorder',
        basePlaylistRevision: internal.room.playlistRevision,
        queueItemIds: [secondId, firstId],
      },
    );
    expect(accepted.status).toBe(200);
    expect(
      (await responseJson(accepted)).items.map((item: Record<string, unknown>) => item.queueItemId),
    ).toEqual([secondId, firstId]);
  });

  it('reserves a sleeping-room direct upload and completes it into one non-autoplaying queue row', async () => {
    const { worker, bucket } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    internal.room.runtime = 'sleeping';
    internal.room.presence.coordinatorParticipantId = null;
    internal.room.presence.participants = {};
    const keyId = 'U'.repeat(16);
    const media = {
      name: 'Orchestra.flac',
      byteLength: 4_096,
      mime: 'audio/flac',
      sha256: 'a'.repeat(64),
      title: 'Orchestra',
      artist: 'MUSIXQUARE',
    };

    const reservationResponse = await createInternalDeveloperUpload(
      worker,
      keyId,
      'developer-upload-reserve-0001',
      media,
    );
    expect(reservationResponse.status).toBe(201);
    const reservation = await responseJson(reservationResponse);
    expect(reservation).toMatchObject({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      assetId: expect.stringMatching(/^asset_[A-Za-z0-9_-]{32}$/),
      queueItemId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      byteLength: media.byteLength,
      upload: {
        method: 'PUT',
        url: expect.stringMatching(/^https:\/\/[a-f0-9]+\.r2\.cloudflarestorage\.com\//),
        headers: {
          'content-length': String(media.byteLength),
          'content-type': media.mime,
          'x-amz-meta-mxqr-room': ROOM_CODE,
          'x-amz-meta-mxqr-asset': expect.any(String),
          'x-amz-meta-mxqr-bytes': String(media.byteLength),
          'x-amz-meta-mxqr-sha256': media.sha256,
        },
      },
      quota: { reservedBytes: media.byteLength, usedBytes: 0 },
    });
    const legacyDeveloperUploadHeaderNames = new Set([
      'content-length',
      'content-type',
      'x-amz-meta-mxqr-room',
      'x-amz-meta-mxqr-asset',
      'x-amz-meta-mxqr-version',
      'x-amz-meta-mxqr-bytes',
      'x-amz-meta-mxqr-sha256',
    ]);
    expect(reservation.upload.headers).not.toHaveProperty('x-amz-meta-mxqr-generation');
    expect(
      Object.keys(reservation.upload.headers).every((name) =>
        legacyDeveloperUploadHeaderNames.has(name),
      ),
    ).toBe(true);
    expect(reservation.uploadExpiresAtMs).toBeLessThan(reservation.completionExpiresAtMs);

    const asset = internal.room.assets[reservation.assetId];
    expect(asset).toMatchObject({
      status: 'reserved',
      reservedByDeveloperKeyId: keyId,
      developerQueueItemId: reservation.queueItemId,
    });
    expect(asset.uploadExpiresAtMs).toBe(reservation.uploadExpiresAtMs);
    expect(asset.expiresAtMs).toBe(reservation.completionExpiresAtMs);
    bucket.objects.set(asset.stagingObjectKey, {
      size: asset.byteLength,
      httpMetadata: { contentType: asset.mime },
      customMetadata: {
        'mxqr-room': ROOM_CODE,
        'mxqr-asset': asset.assetId,
        'mxqr-version': String(asset.version),
        'mxqr-bytes': String(asset.byteLength),
        'mxqr-sha256': asset.sha256,
      },
    });

    const wrongOwner = await completeInternalDeveloperUpload(
      worker,
      'V'.repeat(16),
      'developer-upload-complete-0000',
      reservation.assetId,
    );
    expect(wrongOwner.status).toBe(404);
    expect(await responseJson(wrongOwner)).toEqual({ error: 'ASSET_NOT_FOUND' });

    const completeResponse = await completeInternalDeveloperUpload(
      worker,
      keyId,
      'developer-upload-complete-0001',
      reservation.assetId,
    );
    expect(completeResponse.status).toBe(201);
    const completed = await responseJson(completeResponse);
    expect(completed).toMatchObject({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      asset: {
        kind: 'pro-r2',
        assetId: reservation.assetId,
        version: 1,
        byteLength: media.byteLength,
        mime: media.mime,
        sha256: media.sha256,
      },
      queueItem: {
        queueItemId: reservation.queueItemId,
        kind: 'audio',
        name: media.name,
        addedBy: 'current_api_key',
        title: media.title,
        artist: media.artist,
        byteLength: media.byteLength,
      },
      playlistRevision: 1,
      quota: { reservedBytes: 0, usedBytes: media.byteLength },
    });
    expect(internal.room.runtime).toBe('sleeping');
    expect(internal.room.playlist).toHaveLength(1);
    expect(internal.room.playlist[0]).toHaveProperty('developerOwnerKeyId', keyId);
    expect(internal.room.playback).toMatchObject({ state: 'idle', queueItemId: null });

    const replayResponse = await completeInternalDeveloperUpload(
      worker,
      keyId,
      'developer-upload-complete-0001',
      reservation.assetId,
    );
    expect(replayResponse.status).toBe(201);
    expect(await responseJson(replayResponse)).toEqual(completed);
    expect(internal.room.playlist).toHaveLength(1);

    const clearOwned = await mutateInternalDeveloperQueue(
      worker,
      keyId,
      'developer-upload-clear-owned',
      { type: 'clear_owned' },
    );
    expect(clearOwned.status).toBe(200);
    expect(await responseJson(clearOwned)).toMatchObject({ items: [], currentQueueItemId: null });
    expect(internal.room.playlist).toEqual([]);
    expect(asset.gcAfterMs).toBeGreaterThan(Date.now());
  });

  it('broadcasts committed queue and upload invalidations to every active member', async () => {
    const { worker, state, bucket, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    const capability = await worker.fetch(
      jsonRequest('/signaling-tickets', 'POST', { developerControlVersion: 4 }, ownerCookie),
    );
    expect(capability.status).toBe(200);

    const dispatchedBodies: Array<Record<string, any>> = [];
    const dispatchFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, any>;
      dispatchedBodies.push(body);
      const persisted = state.storage.data.get('pro-room:v1') as Record<string, any>;
      expect(persisted.revision).toBe(body.event.roomRevision);
      expect(persisted.playlistRevision).toBe(body.event.playlistRevision);
      return Response.json({ dispatched: true });
    });
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: dispatchFetch })),
    };

    const queueResponse = await mutateInternalDeveloperQueue(
      worker,
      'H'.repeat(16),
      'developer-invalidation-queue-0001',
      { type: 'add_youtube', videoId: 'dQw4w9WgXcQ', name: 'Queue hint' },
      '🎧'.repeat(32),
    );
    expect(queueResponse.status).toBe(201);
    await vi.waitFor(() => expect(dispatchedBodies).toHaveLength(1));

    const firstRequest = dispatchFetch.mock.calls[0]?.[0];
    expect(new URL(firstRequest.url).pathname).toBe('/internal/realtime/v1/broadcast');
    const firstBody = dispatchedBodies[0]!;
    expect(firstBody).toMatchObject({
      roomCode: ROOM_CODE,
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
      event: {
        type: 'pro-room-invalidated',
        roomRevision: internal.room.revision,
        playlistRevision: internal.room.playlistRevision,
        addition: {
          type: 'pro-queue-addition',
          version: 1,
          roomCode: ROOM_CODE,
          coordinatorEpoch: internal.room.presence.coordinatorEpoch,
          playlistRevision: internal.room.playlistRevision,
          actorName: '🎧'.repeat(15),
          count: 1,
          firstTitle: 'Queue hint',
        },
      },
    });
    expect(firstBody.event.addition.actorName.length).toBe(30);
    expect(firstBody.event.addition.eventId).toMatch(/^qa_000001_\d+_\d+$/);
    expect(firstBody.targets).toHaveLength(1);

    const queueReplay = await mutateInternalDeveloperQueue(
      worker,
      'H'.repeat(16),
      'developer-invalidation-queue-0001',
      { type: 'add_youtube', videoId: 'dQw4w9WgXcQ', name: 'Queue hint' },
      '🎧'.repeat(32),
    );
    expect(queueReplay.status).toBe(201);
    await Promise.resolve();
    expect(dispatchedBodies).toHaveLength(1);

    const media = { name: 'Hint.wav', byteLength: 44, mime: 'audio/wav' };
    const reservation = await responseJson(
      await createInternalDeveloperUpload(
        worker,
        'H'.repeat(16),
        'developer-invalidation-upload-reserve',
        media,
      ),
    );
    expect(dispatchFetch).toHaveBeenCalledTimes(1);
    const asset = internal.room.assets[reservation.assetId];
    bucket.objects.set(asset.stagingObjectKey, {
      size: asset.byteLength,
      httpMetadata: { contentType: asset.mime },
      customMetadata: {
        'mxqr-room': ROOM_CODE,
        'mxqr-generation': String(asset.roomGeneration ?? 0),
        'mxqr-asset': asset.assetId,
        'mxqr-version': String(asset.version),
        'mxqr-bytes': String(asset.byteLength),
      },
    });

    const completion = await completeInternalDeveloperUpload(
      worker,
      'H'.repeat(16),
      'developer-invalidation-upload-complete',
      reservation.assetId,
      'Uploader bot',
    );
    expect(completion.status).toBe(201);
    await vi.waitFor(() => expect(dispatchedBodies).toHaveLength(2));
    const secondBody = dispatchedBodies[1]!;
    expect(secondBody.event).toMatchObject({
      type: 'pro-room-invalidated',
      roomRevision: internal.room.revision,
      playlistRevision: internal.room.playlistRevision,
    });
    expect(secondBody.event.addition).toMatchObject({
      type: 'pro-queue-addition',
      actorName: 'Uploader bot',
      count: 1,
      firstTitle: 'Hint.wav',
      playlistRevision: internal.room.playlistRevision,
    });

    const batchResponse = await mutateInternalDeveloperQueue(
      worker,
      'H'.repeat(16),
      'developer-invalidation-batch-0001',
      {
        type: 'add_youtube_batch',
        items: [
          { videoId: 'M7lc1UVf-VE', name: 'Batch one' },
          { videoId: '9bZkp7q19f0', name: 'Batch two' },
        ],
      },
      'Batch bot',
    );
    expect(batchResponse.status).toBe(201);
    await vi.waitFor(() => expect(dispatchedBodies).toHaveLength(3));
    expect(dispatchedBodies[2]?.event.addition).toMatchObject({
      type: 'pro-queue-addition',
      actorName: 'Batch bot',
      count: 2,
      firstTitle: 'Batch one',
      playlistRevision: internal.room.playlistRevision,
    });

    const current = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const participantQueueItemId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const participantMutation = await worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: current.snapshot.revision,
          playlist: [
            ...current.snapshot.playlist,
            {
              queueItemId: participantQueueItemId,
              name: 'Owner addition',
              source: { kind: 'youtube', videoId: 'aqz-KE-bpKQ' },
            },
          ],
          currentQueueItemId: current.snapshot.currentQueueItemId,
          playback: current.snapshot.playback,
        },
        ownerCookie,
        'participant-invalidation-addition-0001',
      ),
    );
    expect(participantMutation.status).toBe(200);
    // A participant queue edit first invalidates the canonical resource, then
    // emits the optional queue-addition chat hint as a second invalidation.
    await vi.waitFor(() => expect(dispatchedBodies).toHaveLength(5));
    expect(dispatchedBodies[4]?.event.addition).toMatchObject({
      type: 'pro-queue-addition',
      actorName: 'Owner',
      count: 1,
      firstTitle: 'Owner addition',
      playlistRevision: internal.room.playlistRevision,
    });
  });

  it('recovers a Developer API completion when the final object exists but staging cleanup already ran', async () => {
    const { worker, bucket } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    const keyId = 'W'.repeat(16);
    const media = { name: 'Recovery.wav', byteLength: 44, mime: 'audio/wav' };
    const reserved = await responseJson(
      await createInternalDeveloperUpload(
        worker,
        keyId,
        'developer-upload-recovery-reserve',
        media,
      ),
    );
    const asset = internal.room.assets[reserved.assetId];
    bucket.objects.set(asset.objectKey, {
      size: asset.byteLength,
      httpMetadata: { contentType: asset.mime },
      customMetadata: {
        'mxqr-room': ROOM_CODE,
        'mxqr-generation': String(asset.roomGeneration ?? 0),
        'mxqr-asset': asset.assetId,
        'mxqr-version': String(asset.version),
        'mxqr-bytes': String(asset.byteLength),
      },
    });
    expect(bucket.objects.has(asset.stagingObjectKey)).toBe(false);

    const response = await completeInternalDeveloperUpload(
      worker,
      keyId,
      'developer-upload-recovery-complete',
      reserved.assetId,
    );
    expect(response.status).toBe(201);
    expect((await responseJson(response)).queueItem).toMatchObject({
      queueItemId: reserved.queueItemId,
      kind: 'audio',
      name: media.name,
    });
    expect(internal.room.assets[reserved.assetId].status).toBe('ready');
    expect(internal.room.playlist).toHaveLength(1);
  });

  it('keeps every root internal path unreachable on the public PRO hostname', async () => {
    const response = await proRoomWorker.fetch(
      new Request('https://pro.musixquare.com/internal/developer/v1/read', {
        method: 'POST',
        headers: { origin: 'https://musixquare.com', 'content-type': 'application/json' },
        body: JSON.stringify({ projection: 'room' }),
      }),
      environment(),
    );
    expect(response.status).toBe(404);
  });

  it('persists, applies, deduplicates, and server-completes Developer API commands', async () => {
    const { worker, state, ownerCookie, activationEnvelope } = await activatedRoom();
    const dispatchFetch = vi.fn<(request: Request) => Promise<Response>>(async () =>
      Response.json({ dispatched: true }),
    );
    const internal = worker as unknown as {
      env: Record<string, any>;
      room: {
        playlistRevision: number;
        playlist: Array<Record<string, any>>;
        currentQueueItemId: string | null;
        playback: Record<string, any>;
      };
    };
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: dispatchFetch })),
    };
    const queueItemId = '44444444-4444-4444-8444-444444444444';
    internal.room.playlistRevision = 2;
    internal.room.playlist = [
      {
        queueItemId,
        name: 'Developer API test',
        source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      },
    ];
    internal.room.currentQueueItemId = queueItemId;
    internal.room.playback = {
      coordinatorEpoch: activationEnvelope.snapshot.presence.coordinatorEpoch,
      revision: 4,
      state: 'paused',
      queueItemId,
      positionSeconds: 8,
      updatedAtMs: Date.now(),
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    };

    const capability = await worker.fetch(
      jsonRequest('/signaling-tickets', 'POST', { developerControlVersion: 1 }, ownerCookie),
    );
    expect(capability.status).toBe(200);
    expect((await responseJson(await internalDeveloperRead(worker, 'room'))).controlAvailable).toBe(
      true,
    );

    const keyId = 'ApiKeyId12345678';
    const idempotencyKey = 'developer-command-0001';
    const createRequest = (command: Record<string, unknown>) =>
      worker.fetch(
        new Request('https://pro-room.internal/internal/developer/v1/commands/create', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': ROOM_CODE,
          },
          body: JSON.stringify({ roomCode: ROOM_CODE, keyId, idempotencyKey, command }),
        }),
      );
    const persistedSizes: number[] = [];
    const originalPut = state.storage.put.bind(state.storage);
    const putSpy = vi.spyOn(state.storage, 'put').mockImplementation(async (key, value) => {
      if (key === 'pro-room:v1') {
        persistedSizes.push(new TextEncoder().encode(JSON.stringify(value)).byteLength);
      }
      await originalPut(key, value);
    });
    const createdResponse = await createRequest({ type: 'play' });
    putSpy.mockRestore();
    expect(createdResponse.status).toBe(202);
    const created = await responseJson(createdResponse);
    expect(created).toMatchObject({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      status: 'pending',
    });
    expect(created).not.toHaveProperty('resultCode');
    expect(created.commandId).toMatch(/^cmd_[A-Za-z0-9_-]{22}$/);
    expect(dispatchFetch).toHaveBeenCalledTimes(1);
    expect(persistedSizes).toHaveLength(1);
    const dispatchedRequest = dispatchFetch.mock.calls[0]?.[0] as Request;
    await expect(dispatchedRequest.json()).resolves.toMatchObject({
      roomCode: ROOM_CODE,
      event: {
        type: 'pro-playback-prepare',
        target: { revision: 5, queueItemId, state: 'playing' },
      },
    });

    const replay = await responseJson(await createRequest({ type: 'play' }));
    expect(replay).toEqual(created);
    expect(dispatchFetch).toHaveBeenCalledTimes(1);
    const conflict = await createRequest({ type: 'pause' });
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toEqual({ error: 'IDEMPOTENCY_CONFLICT' });

    const pending = (internal.room as Record<string, any>).pendingPlaybackTransition;
    const ready = await worker.fetch(
      jsonRequest(
        `/playback/transitions/${pending.transitionId}/ready`,
        'POST',
        { basePlaybackRevision: pending.basePlaybackRevision, status: 'ready' },
        ownerCookie,
      ),
    );
    expect(ready.status).toBe(200);
    expect(dispatchFetch).toHaveBeenCalledTimes(2);
    expect(
      (internal.room as Record<string, any>).developerCommands[created.commandId],
    ).toMatchObject({
      status: 'applied',
      resultCode: 'applied',
    });
    const terminalReplay = await responseJson(await createRequest({ type: 'play' }));
    expect(terminalReplay).toMatchObject({
      commandId: created.commandId,
      status: 'applied',
      resultCode: 'applied',
    });

    const ack = await worker.fetch(
      jsonRequest(
        `/developer-commands/${created.commandId}/ack`,
        'POST',
        { resultCode: 'applied' },
        ownerCookie,
      ),
    );
    expect(ack.status).toBe(410);
    expect(await responseJson(ack)).toEqual({ error: 'COMMAND_ACK_NOT_REQUIRED' });
    const duplicateAck = await worker.fetch(
      jsonRequest(
        `/developer-commands/${created.commandId}/ack`,
        'POST',
        { resultCode: 'applied' },
        ownerCookie,
      ),
    );
    expect(duplicateAck.status).toBe(410);

    const status = await worker.fetch(
      new Request('https://pro-room.internal/internal/developer/v1/commands/status', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({ roomCode: ROOM_CODE, keyId, commandId: created.commandId }),
      }),
    );
    expect(await responseJson(status)).toMatchObject({ status: 'applied', resultCode: 'applied' });
  });

  it('applies next on the server without depending on a browser control version', async () => {
    const { worker, ownerCookie, dispatchFetch, internal } = await preparedDeveloperCommandRoom();
    const v2Capability = await worker.fetch(
      jsonRequest('/signaling-tickets', 'POST', { developerControlVersion: 2 }, ownerCookie),
    );
    expect(v2Capability.status).toBe(200);

    const accepted = await createInternalDeveloperCommand(
      worker,
      DEVELOPER_KEY_ID,
      'developer-next-command-v2-0001',
      { type: 'next' },
    );
    expect(accepted.status).toBe(202);
    const body = await responseJson(accepted);
    expect(body).toMatchObject({ status: 'applied', resultCode: 'applied' });
    expect(internal.room.developerCommands[body.commandId]).toMatchObject({
      developerControlVersion: 3,
      command: { type: 'next' },
      status: 'applied',
    });
    expect(dispatchFetch).toHaveBeenCalledOnce();
    await expect(
      (dispatchFetch.mock.calls[0]?.[0] as Request).clone().json(),
    ).resolves.toMatchObject({
      event: {
        type: 'pro-playback-commit',
        playback: { revision: 5, state: 'idle', queueItemId: null },
      },
    });
  });

  it('keeps command idempotency isolated from a saturated browser ledger and exact after terminal eviction', async () => {
    const { worker, ownerCookie, dispatchFetch, internal } = await preparedDeveloperCommandRoom();
    const keyId = 'ApiKeyId12345678';
    const idempotencyKey = 'developer-command-1001';
    const nowMs = Date.now();
    for (let index = 0; index < 256; index += 1) {
      internal.room.idempotency[`browser-checkpoint:${index}`] = {
        fingerprint: 'f'.repeat(43),
        body: { snapshot: true },
        status: 200,
        expiresAtMs: nowMs + 24 * 60 * 60 * 1000 + index,
      };
    }

    const first = await responseJson(
      await createInternalDeveloperCommand(worker, keyId, idempotencyKey, { type: 'play' }),
    );
    const replayWhileLive = await responseJson(
      await createInternalDeveloperCommand(worker, keyId, idempotencyKey, { type: 'play' }),
    );
    expect(replayWhileLive).toEqual(first);
    expect(dispatchFetch).toHaveBeenCalledTimes(1);
    expect(Object.keys(internal.room.idempotency)).toHaveLength(256);
    expect(Object.keys(internal.room.developerCommandIdempotency)).toHaveLength(1);

    const pending = internal.room.pendingPlaybackTransition;
    expect(
      (
        await worker.fetch(
          jsonRequest(
            `/playback/transitions/${pending.transitionId}/ready`,
            'POST',
            { basePlaybackRevision: pending.basePlaybackRevision, status: 'ready' },
            ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    expect(internal.room.developerCommands[first.commandId]).toMatchObject({
      status: 'applied',
      resultCode: 'applied',
    });

    const ack = await worker.fetch(
      jsonRequest(
        `/developer-commands/${first.commandId}/ack`,
        'POST',
        { resultCode: 'applied' },
        ownerCookie,
      ),
    );
    expect(ack.status).toBe(410);

    // Fill the bounded command-status ledger with newer terminal entries. The
    // oldest command may be evicted, but its dedicated idempotency record must
    // retain the terminal body rather than the original pending response.
    for (let index = 0; index < 63; index += 1) {
      const commandId = `cmd_${String(index).padStart(22, '0')}`;
      internal.room.developerCommands[commandId] = {
        roomCode: ROOM_CODE,
        commandId,
        keyId,
        idempotencyKey: `terminal-command-${String(index).padStart(3, '0')}`,
        command: { type: 'pause' },
        createdAtMs: nowMs + 1_000 + index,
        expiresAtMs: nowMs + 30_000,
        retainUntilMs: nowMs + 10 * 60 * 1000,
        coordinatorEpoch: internal.room.presence.coordinatorEpoch,
        developerControlVersion: 1,
        expected: {
          queueItemId: internal.room.currentQueueItemId,
          playlistRevision: internal.room.playlistRevision,
          playbackRevision: internal.room.playback.revision,
        },
        status: 'rejected',
        attempts: 1,
        resultCode: 'busy',
        completedAtMs: nowMs + 1_000 + index,
      };
    }
    expect(Object.keys(internal.room.developerCommands)).toHaveLength(64);

    await createInternalDeveloperCommand(worker, keyId, 'developer-command-1002', {
      type: 'pause',
    });
    expect(internal.room.developerCommands[first.commandId]).toBeUndefined();
    const terminalReplay = await responseJson(
      await createInternalDeveloperCommand(worker, keyId, idempotencyKey, { type: 'play' }),
    );
    expect(terminalReplay).toMatchObject({
      commandId: first.commandId,
      status: 'applied',
      resultCode: 'applied',
    });
    expect(dispatchFetch).toHaveBeenCalledTimes(3);

    const retainedStatusRequest = (requestedKeyId: string) =>
      worker.fetch(
        new Request('https://pro-room.internal/internal/developer/v1/commands/status', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': ROOM_CODE,
          },
          body: JSON.stringify({
            roomCode: ROOM_CODE,
            keyId: requestedKeyId,
            commandId: first.commandId,
          }),
        }),
      );
    const retainedStatus = await retainedStatusRequest(keyId);
    expect(retainedStatus.status).toBe(200);
    expect(await responseJson(retainedStatus)).toMatchObject({
      commandId: first.commandId,
      status: 'applied',
      resultCode: 'applied',
    });
    const otherKeyStatus = await retainedStatusRequest('B'.repeat(16));
    expect(otherKeyStatus.status).toBe(404);
  });

  it('bounds a stalled realtime broadcast without rolling back server-applied control', async () => {
    const stalledDispatch = vi.fn(
      (request: Request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const { worker, internal } = await preparedDeveloperCommandRoom(stalledDispatch);
    const startedAt = Date.now();
    const create = createInternalDeveloperCommand(
      worker,
      'ApiKeyId12345678',
      'developer-command-timeout',
      { type: 'seek', positionSeconds: 12 },
    );
    const response = await create;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(response.status).toBe(202);
    const body = await responseJson(response);
    expect(body).toMatchObject({ status: 'applied', resultCode: 'applied' });
    expect(stalledDispatch).toHaveBeenCalledTimes(1);
    expect(internal.room.developerCommands[body.commandId]).toMatchObject({
      status: 'applied',
      resultCode: 'applied',
    });
    expect(internal.room.playback).toMatchObject({ state: 'paused', positionSeconds: 12 });
  });

  it('rejects every obsolete browser ACK after server-side command completion', async () => {
    const { worker, ownerCookie, internal } = await preparedDeveloperCommandRoom();
    const created = await responseJson(
      await createInternalDeveloperCommand(
        worker,
        'ApiKeyId12345678',
        'developer-command-expired',
        { type: 'play' },
      ),
    );
    const pending = internal.room.pendingPlaybackTransition;
    expect(
      (
        await worker.fetch(
          jsonRequest(
            `/playback/transitions/${pending.transitionId}/ready`,
            'POST',
            { basePlaybackRevision: pending.basePlaybackRevision, status: 'ready' },
            ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    internal.room.developerCommands[created.commandId].expiresAtMs = Date.now() - 1;

    const expiredAck = await worker.fetch(
      jsonRequest(
        `/developer-commands/${created.commandId}/ack`,
        'POST',
        { resultCode: 'expired' },
        ownerCookie,
      ),
    );
    expect(expiredAck.status).toBe(410);
    await expect(expiredAck.json()).resolves.toEqual({ error: 'COMMAND_ACK_NOT_REQUIRED' });
    expect(internal.room.developerCommands[created.commandId]).toMatchObject({
      status: 'applied',
      resultCode: 'applied',
    });
    expect(internal.room.developerCommands[created.commandId].acknowledgedAtMs).toBeUndefined();

    const conflictingAck = await worker.fetch(
      jsonRequest(
        `/developer-commands/${created.commandId}/ack`,
        'POST',
        { resultCode: 'applied' },
        ownerCookie,
      ),
    );
    expect(conflictingAck.status).toBe(410);
  });
});

describe('persistent PRO room bootstrap and activation', () => {
  it('suspends an active room without deleting durable content and resumes only for fresh sessions', async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse('2026-07-18T01:00:00.000Z');
    vi.setSystemTime(startedAtMs);
    const context = await activatedRoom();
    const ready = await completeReadyAsset(context, 'admin-suspend');
    const queueItemId = '018f977e-5df5-4c8f-bb80-55d847ddec8f';
    expect(
      (
        await replacePlaylist(
          context,
          [playlistItem(queueItemId, ready.asset)],
          'admin-suspend-playlist',
        )
      ).status,
    ).toBe(200);

    const memberResponse = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    expect(memberResponse.status).toBe(200);
    const memberCookie = cookieFrom(memberResponse);
    bindCookiePresence(memberCookie, await responseJson(memberResponse));

    const acquiredResponse = await context.worker.fetch(
      jsonRequest('/system-audio/acquire', 'POST', {}, context.ownerCookie),
    );
    expect(acquiredResponse.status).toBe(200);
    const acquired = await responseJson(acquiredResponse);
    const internal = context.worker as unknown as { room: Record<string, any> };
    internal.room.currentQueueItemId = queueItemId;
    internal.room.playback = {
      ...internal.room.playback,
      state: 'playing',
      queueItemId,
      positionSeconds: 42,
      updatedAtMs: startedAtMs,
    };

    const preserved = structuredClone({
      playlist: internal.room.playlist,
      assets: internal.room.assets,
      quota: internal.room.quota,
      pin: internal.room.pin,
      ownerMemberId: internal.room.ownerMemberId,
      ownerCredentialHash: internal.room.ownerCredentialHash,
    });
    const authEpoch = internal.room.authEpoch as number;
    const coordinatorEpoch = internal.room.presence.coordinatorEpoch as number;
    const systemAudioGeneration = acquired.systemAudio.generation as number;
    expect(Object.keys(internal.room.sessions)).toHaveLength(2);
    expect(Object.keys(internal.room.presence.participants)).toHaveLength(2);

    vi.setSystemTime(startedAtMs + 5_000);
    const suspend = await context.worker.fetch(
      new Request('https://pro-room.internal/internal/admin/suspend', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    expect(suspend.status).toBe(200);
    expect(await responseJson(suspend)).toEqual({
      ok: true,
      roomCode: ROOM_CODE,
      roomGeneration: 0,
      status: 'suspended',
      changed: true,
    });
    expect(internal.room).toMatchObject({
      status: 'suspended',
      runtime: 'sleeping',
      authEpoch: authEpoch + 1,
      currentQueueItemId: queueItemId,
      playback: {
        state: 'playing',
        queueItemId,
        positionSeconds: 47,
        updatedAtMs: startedAtMs + 5_000,
      },
      presence: {
        coordinatorEpoch: coordinatorEpoch + 1,
        coordinatorParticipantId: null,
        participants: {},
      },
      sessions: {},
      systemAudio: {
        generation: systemAudioGeneration + 1,
        status: 'idle',
        ownerParticipantId: null,
        publication: null,
      },
    });
    expect({
      playlist: internal.room.playlist,
      assets: internal.room.assets,
      quota: internal.room.quota,
      pin: internal.room.pin,
      ownerMemberId: internal.room.ownerMemberId,
      ownerCredentialHash: internal.room.ownerCredentialHash,
    }).toEqual(preserved);
    expect(await responseJson(await context.worker.fetch(request('/bootstrap')))).toEqual({
      roomCode: ROOM_CODE,
      status: 'suspended',
    });
    expect((await context.worker.fetch(request('/snapshot', {}, context.ownerCookie))).status).toBe(
      401,
    );
    expect(
      (await context.worker.fetch(jsonRequest('/sessions', 'POST', { pin: '12345678' }))).status,
    ).toBe(423);

    const suspendedState = structuredClone(internal.room);
    const repeatedSuspend = await context.worker.fetch(
      new Request('https://pro-room.internal/internal/admin/suspend', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    expect(await responseJson(repeatedSuspend)).toEqual({
      ok: true,
      roomCode: ROOM_CODE,
      roomGeneration: 0,
      status: 'suspended',
      changed: false,
    });
    expect(internal.room).toEqual(suspendedState);

    const resume = await context.worker.fetch(
      new Request('https://pro-room.internal/internal/admin/resume', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    expect(await responseJson(resume)).toEqual({
      ok: true,
      roomCode: ROOM_CODE,
      roomGeneration: 0,
      status: 'active',
      changed: true,
    });
    expect(internal.room).toMatchObject({
      status: 'active',
      runtime: 'sleeping',
      sessions: {},
      presence: { coordinatorParticipantId: null, participants: {} },
    });
    expect((await context.worker.fetch(request('/snapshot', {}, context.ownerCookie))).status).toBe(
      401,
    );

    const resumedState = structuredClone(internal.room);
    const repeatedResume = await context.worker.fetch(
      new Request('https://pro-room.internal/internal/admin/resume', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    expect(await responseJson(repeatedResume)).toEqual({
      ok: true,
      roomCode: ROOM_CODE,
      roomGeneration: 0,
      status: 'active',
      changed: false,
    });
    expect(internal.room).toEqual(resumedState);

    const freshSession = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }, context.ownerRecoveryCookie),
    );
    expect(freshSession.status).toBe(200);
    expect((await responseJson(freshSession)).snapshot).toMatchObject({
      status: 'active',
      runtime: 'awake',
      playback: { state: 'playing', positionSeconds: 47 },
      viewer: { role: 'owner', displayName: 'Owner' },
    });
  });

  it('fails closed before decommission when the account reverse-edge store is unbound', async () => {
    const context = await activatedRoom();
    const internal = context.worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: vi.fn() })),
    };
    internal.env.DEVELOPER_API_DB = { prepare: vi.fn() };
    internal.env.DEVELOPER_API_LIMITERS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: vi.fn() })),
    };
    internal.env.MUSIXQUARE_ADMIN_DB = { prepare: vi.fn() };
    delete internal.env.MUSIXQUARE_AUTH_DB;

    const response = await context.worker.fetch(
      new Request('https://pro-room.internal/internal/admin/decommission', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({
          roomCode: ROOM_CODE,
          requestId: '018f977e-5df5-4c8f-bb80-55d847ddec9d',
        }),
      }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'PRO_ROOM_DECOMMISSION_NOT_CONFIGURED',
    });
    expect(internal.room.status).toBe('active');
  });

  it('keeps an in-progress decommission retryable when its account store binding disappears', async () => {
    const context = await activatedRoom();
    const nowMs = Date.parse('2026-07-28T00:00:00.000Z');
    const internal = context.worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
      continueDecommission(nowMs: number): Promise<boolean>;
      purgeDecommissionedMediaPrefix(): Promise<{ ok: boolean; deletedAny: boolean }>;
      decommissionSignaling(requestId: string): Promise<boolean>;
      deleteDeveloperRoomData(requestId: string, nowMs: number): Promise<boolean>;
      clearDeveloperRoomLimiter(requestId: string): Promise<boolean>;
      markRegistryDecommissioned(nowMs: number): Promise<boolean>;
    };
    internal.room.status = 'decommissioning';
    internal.room.decommission = {
      requestId: '018f977e-5df5-4c8f-bb80-55d847ddec9a',
      startedAtMs: nowMs - 10 * 60 * 1000,
      purgeAfterMs: nowMs - 2 * 60 * 1000,
      retryAtMs: nowMs,
      finalEmptySinceMs: nowMs - 2 * 60 * 1000,
      signalingCleared: true,
      initialSweepCompleted: true,
      developerDataCleared: true,
      developerLimiterCleared: true,
    };
    vi.spyOn(internal, 'purgeDecommissionedMediaPrefix').mockResolvedValue({
      ok: true,
      deletedAny: false,
    });
    vi.spyOn(internal, 'decommissionSignaling').mockResolvedValue(true);
    vi.spyOn(internal, 'deleteDeveloperRoomData').mockResolvedValue(true);
    vi.spyOn(internal, 'clearDeveloperRoomLimiter').mockResolvedValue(true);
    const markRegistryDecommissioned = vi
      .spyOn(internal, 'markRegistryDecommissioned')
      .mockResolvedValue(true);
    internal.env.DECOMMISSION_FINAL_EMPTY_WINDOW_SECONDS = 60;
    delete internal.env.MUSIXQUARE_AUTH_DB;

    await expect(internal.continueDecommission(nowMs)).resolves.toBe(false);
    expect(markRegistryDecommissioned).toHaveBeenCalledOnce();
    expect(internal.room.status).toBe('decommissioning');
    expect(internal.room.decommission).toMatchObject({
      requestId: '018f977e-5df5-4c8f-bb80-55d847ddec9a',
      retryAtMs: expect.any(Number),
    });
  });

  it('restores the active room when the initial decommission tombstone commit fails', async () => {
    const context = await activatedRoom();
    const externalCalls = {
      signaling: vi.fn(async () =>
        Response.json({ ok: true, roomCode: ROOM_CODE, status: 'decommissioned' }),
      ),
      developerDb: vi.fn(async () => ({ meta: { changes: 1 } })),
      limiter: vi.fn(async () => Response.json({ ok: true, roomCode: ROOM_CODE })),
      registry: vi.fn(async () => ({ meta: { changes: 1 } })),
    };
    const internal = context.worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: externalCalls.signaling })),
    };
    internal.env.DEVELOPER_API_DB = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ run: externalCalls.developerDb })),
      })),
    };
    internal.env.DEVELOPER_API_LIMITERS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: externalCalls.limiter })),
    };
    internal.env.MUSIXQUARE_ADMIN_DB = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: externalCalls.registry,
          first: vi.fn(async () => ({ status: 'decommissioned' })),
          all: vi.fn(async () => ({ results: [{ status: 'decommissioned' }] })),
        })),
      })),
    };

    const before = structuredClone(internal.room);
    const originalPut = context.state.storage.put.bind(context.state.storage);
    let failCoreOnce = true;
    context.state.storage.put = async (key, value) => {
      if (failCoreOnce && key === 'pro-room:v2:core') {
        failCoreOnce = false;
        throw new Error('simulated decommission fence failure');
      }
      return originalPut(key, value);
    };
    const decommissionRequest = () =>
      new Request('https://pro-room.internal/internal/admin/decommission', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({
          roomCode: ROOM_CODE,
          requestId: '018f977e-5df5-4c8f-bb80-55d847ddec9e',
        }),
      });

    await expect(context.worker.fetch(decommissionRequest())).rejects.toMatchObject({
      name: 'RoomStateStorageCommitError',
    });
    expect(internal.room).toEqual(before);
    expect(internal.room.status).toBe('active');
    expect(externalCalls.signaling).not.toHaveBeenCalled();
    expect(externalCalls.developerDb).not.toHaveBeenCalled();
    expect(externalCalls.limiter).not.toHaveBeenCalled();
    expect(externalCalls.registry).not.toHaveBeenCalled();

    context.state.storage.put = originalPut;
    const retried = await context.worker.fetch(decommissionRequest());
    expect(retried.status).toBe(202);
    await expect(retried.json()).resolves.toMatchObject({
      ok: true,
      roomCode: ROOM_CODE,
      status: 'decommissioning',
      changed: true,
    });
    expect(internal.room.status).toBe('decommissioning');
    expect(externalCalls.signaling).toHaveBeenCalledOnce();
  });

  it('permanently decommissions a room, sweeps late R2 uploads, and preserves its tombstone', async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse('2026-07-18T02:00:00.000Z');
    vi.setSystemTime(startedAtMs);
    const context = await activatedRoom();
    const ready = await completeReadyAsset(context, 'admin-decommission');
    const queueItemId = '018f977e-5df5-4c8f-bb80-55d847ddec9f';
    expect(
      (
        await replacePlaylist(
          context,
          [playlistItem(queueItemId, ready.asset)],
          'admin-decommission-playlist',
        )
      ).status,
    ).toBe(200);
    const memberResponse = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    expect(memberResponse.status).toBe(200);
    bindCookiePresence(cookieFrom(memberResponse), await responseJson(memberResponse));

    const orphanKey = `rooms/${ROOM_CODE}/assets/orphan/v1/staging_orphan`;
    const otherRoomKey = 'rooms/000002/assets/keep/v1/object_keep';
    context.bucket.objects.set(orphanKey, { size: 17 });
    context.bucket.objects.set(otherRoomKey, { size: 23 });

    let registryStatus = 'decommissioning';
    const registryRun = vi.fn(async () => {
      registryStatus = 'decommissioned';
      return { meta: { changes: 1 } };
    });
    const adminDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: registryRun,
          first: vi.fn(async () => ({
            status: registryStatus,
            room_generation: 0,
          })),
          all: vi.fn(async () => ({
            results: [{ status: registryStatus, room_generation: 0 }],
          })),
        })),
      })),
    };
    const signalingFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe('/internal/admin/v1/decommission');
      await expect(request.json()).resolves.toEqual({
        roomCode: ROOM_CODE,
        requestId: '018f977e-5df5-4c8f-bb80-55d847ddec9f',
      });
      return Response.json({
        ok: true,
        roomCode: ROOM_CODE,
        status: 'decommissioned',
      });
    });
    const developerQueries: Array<{ sql: string; values: unknown[] }> = [];
    const developerApiDb = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...values: unknown[]) => ({
          run: vi.fn(async () => {
            developerQueries.push({ sql, values });
            return { meta: { changes: 1 } };
          }),
        })),
      })),
    };
    const limiterFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe('/internal/admin/v1/decommission');
      expect(request.headers.get('x-mxqr-pro-room-code')).toBe(ROOM_CODE);
      expect(request.headers.get('x-mxqr-pro-room-generation')).toBeNull();
      await expect(request.json()).resolves.toEqual({
        roomCode: ROOM_CODE,
        requestId: '018f977e-5df5-4c8f-bb80-55d847ddec9f',
      });
      return Response.json({ ok: true, roomCode: ROOM_CODE });
    });
    const limiterIdFromName = vi.fn((name: string) => name);
    const internal = context.worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
      alarm(): Promise<void>;
    };
    internal.env.MUSIXQUARE_ADMIN_DB = adminDb;
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((roomCode: string) => roomCode),
      get: vi.fn(() => ({ fetch: signalingFetch })),
    };
    internal.env.DEVELOPER_API_DB = developerApiDb;
    internal.env.DEVELOPER_API_LIMITERS = {
      idFromName: limiterIdFromName,
      get: vi.fn(() => ({ fetch: limiterFetch })),
    };
    internal.env.DECOMMISSION_FINAL_EMPTY_WINDOW_SECONDS = 60;

    expect(internal.room).toMatchObject({
      provisioned: true,
      status: 'active',
      pin: expect.any(Object),
    });
    expect(internal.room.playlist).toHaveLength(1);
    expect(Object.keys(internal.room.sessions)).toHaveLength(2);
    expect(Object.keys(internal.room.assets)).toHaveLength(1);

    const decommissionRequest = () =>
      new Request('https://pro-room.internal/internal/admin/decommission', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({
          roomCode: ROOM_CODE,
          requestId: '018f977e-5df5-4c8f-bb80-55d847ddec9f',
        }),
      });
    const decommissioned = await context.worker.fetch(decommissionRequest());
    expect(decommissioned.status).toBe(202);
    await expect(decommissioned.json()).resolves.toMatchObject({
      ok: true,
      roomCode: ROOM_CODE,
      status: 'decommissioning',
      changed: true,
      purgeAfterMs: expect.any(Number),
      completedAtMs: null,
    });

    expect(internal.room).toMatchObject({
      provisioned: false,
      status: 'decommissioning',
      runtime: 'sleeping',
      playlist: [],
      pin: null,
      ownerMemberId: null,
      ownerCredentialHash: null,
      sessions: {},
      assets: {},
      quota: { usedBytes: 0, reservedBytes: 0 },
      decommission: {
        signalingCleared: true,
        initialSweepCompleted: true,
        developerDataCleared: true,
        developerLimiterCleared: true,
        purgeAfterMs: expect.any(Number),
      },
    });
    expect(context.bucket.objects.has(ready.asset.objectKey)).toBe(false);
    expect(context.bucket.objects.has(orphanKey)).toBe(false);
    expect(context.bucket.objects.has(otherRoomKey)).toBe(true);
    expect(signalingFetch).toHaveBeenCalledTimes(1);
    const initialDeveloperDeletes = developerQueries.filter(({ sql }) => /^DELETE FROM /.test(sql));
    expect(initialDeveloperDeletes).toHaveLength(3);
    expect(
      developerQueries.filter(({ sql }) =>
        /INSERT INTO mxqr_developer_api_room_tombstones/.test(sql),
      ),
    ).toHaveLength(1);
    expect(initialDeveloperDeletes.map(({ sql }) => sql.match(/^DELETE FROM (\S+)/)?.[1])).toEqual([
      'mxqr_developer_api_keys',
      'mxqr_developer_api_audit',
      'mxqr_developer_api_admin_audit',
    ]);
    expect(
      initialDeveloperDeletes.every(({ values }) => values[0] === ROOM_CODE && values[1] === 0),
    ).toBe(true);
    expect(limiterIdFromName).toHaveBeenCalledOnce();
    expect(limiterIdFromName).toHaveBeenCalledWith(`room:${ROOM_CODE}`);
    expect(limiterFetch).toHaveBeenCalledTimes(1);
    expect(registryStatus).toBe('decommissioning');

    const lateObjectKey = `rooms/${ROOM_CODE}/assets/late/v1/staging_late`;
    context.bucket.objects.set(lateObjectKey, { size: 29 });
    const purgeAfterMs = internal.room.decommission.purgeAfterMs as number;
    expect(context.state.storage.alarm).toBe(purgeAfterMs);
    vi.setSystemTime(purgeAfterMs + 1);
    await internal.alarm();

    expect(context.bucket.objects.has(lateObjectKey)).toBe(false);
    expect(context.bucket.objects.has(otherRoomKey)).toBe(true);
    expect(registryStatus).toBe('decommissioning');
    expect(internal.room.status).toBe('decommissioning');

    const quietWindowLateKey = `rooms/${ROOM_CODE}/assets/quiet-window/v1/staging_late`;
    context.bucket.objects.set(quietWindowLateKey, { size: 31 });
    vi.setSystemTime(purgeAfterMs + 60_001);
    await internal.alarm();
    expect(context.bucket.objects.has(quietWindowLateKey)).toBe(false);
    expect(internal.room.status).toBe('decommissioning');

    vi.setSystemTime(purgeAfterMs + 120_001);
    await internal.alarm();
    expect(registryStatus).toBe('decommissioned');
    // Completion immutably records the retired generation before the current
    // registry pointer is moved to its terminal state.
    expect(registryRun).toHaveBeenCalledTimes(2);
    expect(internal.room).toMatchObject({
      provisioned: false,
      status: 'decommissioned',
      playlist: [],
      pin: null,
      sessions: {},
      assets: {},
      decommission: {
        requestId: '018f977e-5df5-4c8f-bb80-55d847ddec9f',
        completedAtMs: purgeAfterMs + 120_001,
        maintenanceAtMs: purgeAfterMs + 120_001 + 24 * 60 * 60 * 1000,
      },
    });

    const postCompletionKey = `rooms/${ROOM_CODE}/assets/post-completion/v1/straggler`;
    context.bucket.objects.set(postCompletionKey, { size: 37 });
    const maintenanceAtMs = internal.room.decommission.maintenanceAtMs as number;
    vi.setSystemTime(maintenanceAtMs);
    await internal.alarm();
    expect(context.bucket.objects.has(postCompletionKey)).toBe(false);
    expect(internal.room).toMatchObject({
      status: 'decommissioned',
      decommission: {
        completedAtMs: purgeAfterMs + 120_001,
        maintenanceAtMs: maintenanceAtMs + 24 * 60 * 60 * 1000,
      },
    });

    const repeated = await context.worker.fetch(decommissionRequest());
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toEqual({
      ok: true,
      roomCode: ROOM_CODE,
      roomGeneration: 0,
      status: 'decommissioned',
      changed: false,
      completedAtMs: purgeAfterMs + 120_001,
    });
    expect(signalingFetch).toHaveBeenCalledTimes(5);
    expect(
      developerQueries.filter(({ sql }) =>
        /INSERT INTO mxqr_developer_api_room_tombstones/.test(sql),
      ),
    ).toHaveLength(5);
    expect(developerApiDb.prepare).toHaveBeenCalledTimes(25);
    expect(limiterFetch).toHaveBeenCalledTimes(5);

    const restarted = new MusixquareProRoom(context.state as never, internal.env as never);
    const reprovision = await restarted.fetch(
      new Request('https://pro-room.internal/internal/admin/provision', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    expect(reprovision.status).toBe(410);
    await expect(reprovision.json()).resolves.toEqual({
      error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED',
    });
  });

  it('rejects suspend and resume for rooms that have not been activated or provisioned', async () => {
    const worker = new MusixquareProRoom(new FakeState() as never, environment() as never);
    const internalRequest = (roomCode: string, operation: 'suspend' | 'resume') =>
      new Request(`https://pro-room.internal/internal/admin/${operation}`, {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': roomCode },
      });

    const inactiveSuspend = await worker.fetch(internalRequest(ROOM_CODE, 'suspend'));
    expect(inactiveSuspend.status).toBe(409);
    expect(await responseJson(inactiveSuspend)).toEqual({ error: 'ROOM_NOT_ACTIVE' });
    const inactiveResume = await worker.fetch(internalRequest(ROOM_CODE, 'resume'));
    expect(inactiveResume.status).toBe(409);
    expect(await responseJson(inactiveResume)).toEqual({ error: 'ROOM_NOT_SUSPENDED' });

    const unprovisioned = new MusixquareProRoom(new FakeState() as never, environment() as never);
    for (const operation of ['suspend', 'resume'] as const) {
      const response = await unprovisioned.fetch(internalRequest('000002', operation));
      expect(response.status).toBe(404);
      expect(await responseJson(response)).toEqual({ error: 'ROOM_NOT_FOUND' });
    }
  });

  it('fails a suspend fence atomically when its bounded revisions are exhausted', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: Record<string, any> };
    internal.room.playback.state = 'playing';
    internal.room.playback.updatedAtMs = Date.now();
    internal.room.playback.revision = Number.MAX_SAFE_INTEGER - 1;
    const before = structuredClone(internal.room);

    const response = await worker.fetch(
      new Request('https://pro-room.internal/internal/admin/suspend', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );

    expect(response.status).toBe(409);
    expect(await responseJson(response)).toEqual({ error: 'REVISION_EXHAUSTED' });
    expect(internal.room).toEqual(before);
  });

  it('never exposes an owner claim in public bootstrap and rejects invalid activation uniformly', async () => {
    const worker = new MusixquareProRoom(new FakeState() as never, environment() as never);
    const bootstrap = await worker.fetch(request('/bootstrap'));
    expect(await responseJson(bootstrap)).toEqual({
      roomCode: ROOM_CODE,
      status: 'activation_required',
    });

    const invalidClaim = `v1.${'a'.repeat(32)}.${'b'.repeat(43)}`;
    const wrongClaim = await worker.fetch(
      jsonRequest('/activation', 'POST', {
        claimToken: invalidClaim,
        temporaryPin: '00000001',
        newPin: '12345678',
      }),
    );
    const wrongTemporaryPin = await worker.fetch(
      jsonRequest('/activation', 'POST', {
        claimToken: invalidClaim,
        temporaryPin: '99999999',
        newPin: '12345678',
      }),
    );
    expect(wrongClaim.status).toBe(401);
    expect(wrongTemporaryPin.status).toBe(401);
    expect(await responseJson(wrongClaim)).toEqual({ error: 'ACTIVATION_INVALID' });
    expect(await responseJson(wrongTemporaryPin)).toEqual({ error: 'ACTIVATION_INVALID' });
  });

  it('rejects invisible owner names at the authoritative activation boundary', async () => {
    const worker = new MusixquareProRoom(new FakeState() as never, environment() as never);
    const claimToken = await issueProRoomActivationClaim(ROOM_CODE, ACTIVATION_SECRET, {
      nowMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60_000,
      nonce: 'visible-owner-name-boundary',
    });

    for (const ownerName of ['\u3164', 'Owner\u200b', 'Owner\u00a0name', '️']) {
      const response = await worker.fetch(
        jsonRequest('/activation', 'POST', {
          claimToken,
          temporaryPin: '00000001',
          newPin: '12345678',
          ownerName,
        }),
      );
      expect(response.status).toBe(400);
      expect(await responseJson(response)).toEqual({ error: 'INVALID_REQUEST' });
    }

    const valid = await worker.fetch(
      jsonRequest('/activation', 'POST', {
        claimToken,
        temporaryPin: '00000001',
        newPin: '12345678',
        ownerName: 'Replacement owner',
      }),
    );
    expect(valid.status).toBe(200);
  });

  it('atomically activates an owner session and returns a contract-valid snapshot', async () => {
    const { worker, state, ownerCookie } = await activatedRoom();
    const response = await worker.fetch(request('/snapshot', {}, ownerCookie));
    const envelope = await responseJson(response);
    const snapshot = parseProRoomSnapshot(envelope.snapshot);
    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({
      roomCode: ROOM_CODE,
      status: 'active',
      runtime: 'awake',
      viewer: { role: 'owner', displayName: 'Owner' },
      presence: { coordinatorEpoch: 1 },
    });
    expect(JSON.stringify(envelope)).not.toContain('objectKey');
    expect(JSON.stringify(envelope)).not.toContain(ACTIVATION_SECRET);
    const stored = state.storage.data.get('pro-room:v1') as StoredRoom;
    expect(stored.pin?.iterations).toBe(100_000);
  });

  it('fails closed instead of throwing for an over-limit stored PBKDF2 record', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as { room: StoredRoom };
    expect(internal.room.pin).not.toBeNull();
    internal.room.pin!.iterations = 100_001;

    const response = await worker.fetch(jsonRequest('/sessions', 'POST', { pin: '12345678' }));

    expect(response.status).toBe(401);
    expect(await responseJson(response)).toEqual({ error: 'PIN_INVALID' });
  });

  it('has no public claim-issuance endpoint', async () => {
    const worker = new MusixquareProRoom(new FakeState() as never, environment() as never);
    const response = await worker.fetch(request('/claims', { method: 'POST' }));
    expect(response.status).toBe(404);
    expect(await responseJson(response)).toEqual({ error: 'NOT_FOUND' });
  });

  it('provisions a future leading-zero room only through its direct admin DO binding', async () => {
    const roomCode = '000002';
    const worker = new MusixquareProRoom(new FakeState() as never, environment() as never);
    const before = await worker.fetch(requestForRoom(roomCode, '/bootstrap'));
    expect(before.status).toBe(404);

    const provision = await worker.fetch(
      new Request('https://pro-room.internal/internal/admin/provision', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': roomCode },
      }),
    );
    expect(provision.status).toBe(200);
    expect(await responseJson(provision)).toEqual({
      ok: true,
      roomCode,
      roomGeneration: 0,
      status: 'unactivated',
    });

    const after = await worker.fetch(requestForRoom(roomCode, '/bootstrap'));
    expect(after.status).toBe(200);
    expect(await responseJson(after)).toEqual({ roomCode, status: 'activation_required' });
  });

  it('rotates short-lived activation generations so only the newest admin link works', async () => {
    const roomCode = '000002';
    const state = new FakeState();
    const worker = new MusixquareProRoom(state as never, environment() as never);
    await worker.fetch(
      new Request('https://pro-room.internal/internal/admin/provision', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': roomCode },
      }),
    );

    const issuedAt = Date.now();
    const first = await responseJson(
      await worker.fetch(
        new Request('https://pro-room.internal/internal/admin/activation-claim', {
          method: 'POST',
          headers: { 'x-mxqr-pro-room-code': roomCode },
        }),
      ),
    );
    const second = await responseJson(
      await worker.fetch(
        new Request('https://pro-room.internal/internal/admin/activation-claim', {
          method: 'POST',
          headers: { 'x-mxqr-pro-room-code': roomCode },
        }),
      ),
    );
    expect(second.expiresAt).toBeGreaterThan(issuedAt);
    expect(second.expiresAt).toBeLessThanOrEqual(issuedAt + 15 * 60 * 1000 + 1_000);

    const claimFrom = (activationUrl: string): string => {
      const encoded = new URL(activationUrl).hash.match(/^#pro-claim=(.+)$/)?.[1];
      if (!encoded) throw new Error('missing claim fragment');
      return decodeURIComponent(encoded);
    };
    const stale = await worker.fetch(
      jsonRequestForRoom(roomCode, '/activation', 'POST', {
        claimToken: claimFrom(first.activationUrl),
        temporaryPin: '00000002',
        newPin: '12345678',
      }),
    );
    expect(stale.status).toBe(401);
    expect(await responseJson(stale)).toEqual({ error: 'ACTIVATION_INVALID' });

    const current = await worker.fetch(
      jsonRequestForRoom(roomCode, '/activation', 'POST', {
        claimToken: claimFrom(second.activationUrl),
        temporaryPin: '00000002',
        newPin: '12345678',
      }),
    );
    expect(current.status).toBe(200);
    expect(JSON.stringify(await responseJson(current))).not.toContain('pro-claim');
  });

  it('issues a short-lived owner recovery link only for an active room', async () => {
    const { worker } = await activatedRoom();
    const issuedAt = Date.now();
    const statusResponse = await worker.fetch(
      new Request('https://pro-room.internal/internal/admin/status', {
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    expect(statusResponse.status).toBe(200);
    expect(await responseJson(statusResponse)).toMatchObject({
      roomCode: ROOM_CODE,
      provisioned: true,
      status: 'active',
      ownerAccountLinked: false,
    });

    const response = await worker.fetch(
      new Request('https://pro-room.internal/internal/admin/owner-recovery-claim', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    const payload = await responseJson(response);
    expect(payload).toMatchObject({ roomCode: ROOM_CODE, ownerAccountLinked: false });
    expect(payload.expiresAt).toBeGreaterThan(issuedAt);
    expect(payload.expiresAt).toBeLessThanOrEqual(issuedAt + 10 * 60 * 1000 + 1_000);
    const recoveryUrl = new URL(payload.recoveryUrl);
    expect(recoveryUrl.origin).toBe('https://musixquare.com');
    expect(recoveryUrl.pathname).toBe(`/${ROOM_CODE}`);
    expect(recoveryUrl.hash).toMatch(/^#pro-recovery=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('serializes owner recovery issuance against an admin state transition', async () => {
    const { worker } = await activatedRoom();
    const internal = worker as unknown as {
      handleInternalOwnerRecoveryClaim(): Promise<Response>;
      handleInternalSuspend(): Promise<Response>;
    };
    let releaseRecovery: ((response: Response) => void) | undefined;
    const recoveryGate = new Promise<Response>((resolve) => {
      releaseRecovery = resolve;
    });
    const recovery = vi
      .spyOn(internal, 'handleInternalOwnerRecoveryClaim')
      .mockImplementation(() => recoveryGate);
    const suspend = vi
      .spyOn(internal, 'handleInternalSuspend')
      .mockResolvedValue(Response.json({ ok: true }));

    const recoveryResponse = worker.fetch(
      new Request('https://pro-room.internal/internal/admin/owner-recovery-claim', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledOnce());
    const suspendResponse = worker.fetch(
      new Request('https://pro-room.internal/internal/admin/suspend', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    await Promise.resolve();
    expect(suspend).not.toHaveBeenCalled();

    releaseRecovery?.(Response.json({ ok: true }));
    await expect(recoveryResponse).resolves.toMatchObject({ status: 200 });
    await expect(suspendResponse).resolves.toMatchObject({ status: 200 });
    expect(suspend).toHaveBeenCalledOnce();
  });

  it('refuses owner recovery link issuance before activation and while suspended', async () => {
    const roomCode = '000002';
    const worker = new MusixquareProRoom(new FakeState() as never, environment() as never);
    await worker.fetch(
      new Request('https://pro-room.internal/internal/admin/provision', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': roomCode },
      }),
    );

    const unactivated = await worker.fetch(
      new Request('https://pro-room.internal/internal/admin/owner-recovery-claim', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': roomCode },
      }),
    );
    expect(unactivated.status).toBe(409);
    expect(unactivated.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(await responseJson(unactivated)).toMatchObject({
      error: 'PRO_ROOM_OWNER_RECOVERY_UNAVAILABLE',
      status: 'unactivated',
    });

    const internal = worker as unknown as { room: { status: string } };
    internal.room.status = 'suspended';
    const suspended = await worker.fetch(
      new Request('https://pro-room.internal/internal/admin/owner-recovery-claim', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': roomCode },
      }),
    );
    expect(suspended.status).toBe(409);
    expect(await responseJson(suspended)).toMatchObject({
      error: 'PRO_ROOM_OWNER_RECOVERY_UNAVAILABLE',
      status: 'suspended',
    });
  });

  it('refuses activation claims whose requested lifetime exceeds fifteen minutes', async () => {
    const nowMs = Date.now();
    await expect(
      issueProRoomActivationClaim('000002', ACTIVATION_SECRET, {
        nowMs,
        expiresAtMs: nowMs + 15 * 60 * 1000 + 1,
      }),
    ).rejects.toThrow('Invalid expiry');
  });

  it('never forwards direct admin DO paths through the public Worker router', async () => {
    const env = environment() as ReturnType<typeof environment> & {
      PRO_ROOM_RATE_LIMIT_SECRET: string;
      PRO_ROOMS: {
        idFromName(value: string): string;
        get(value: string): { fetch(request: Request): Promise<Response> };
      };
    };
    env.PRO_ROOM_RATE_LIMIT_SECRET = 'rate-limit-secret-'.padEnd(48, 'r');
    let forwarded = 0;
    env.PRO_ROOMS = {
      idFromName: (value) => value,
      get: () => ({
        fetch: async () => {
          forwarded += 1;
          return new Response(null, { status: 204 });
        },
      }),
    };
    for (const path of [
      '/internal/admin/provision',
      '/internal/admin/owner-recovery-claim',
      '/internal/admin/suspend',
      '/internal/admin/resume',
      '/v1/rooms/000002/internal/admin/provision',
      '/v1/rooms/000002/internal/admin/owner-recovery-claim',
      '/v1/rooms/000002/internal/admin/suspend',
      '/v1/rooms/000002/internal/admin/resume',
    ]) {
      const response = await proRoomWorker.fetch(
        new Request(`https://pro.musixquare.com${path}`, {
          method: 'POST',
          headers: { origin: 'https://musixquare.com' },
        }),
        env as never,
      );
      expect(response.status).toBe(404);
    }
    expect(forwarded).toBe(0);
  });

  it('cold-loads a bounded registered-code cache before creating a dynamic room DO', async () => {
    let registryReads = 0;
    const forwardedCodes: string[] = [];
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            registryReads += 1;
            return {
              results: [
                { room_code: '000010' },
                // A half-finished admin registration must not reach a DO.
                { room_code: '000011', status: 'provisioning' },
              ].filter((row) => row.status === undefined),
            };
          },
        }),
      }),
    };
    const env = {
      ...environment(),
      MUSIXQUARE_ADMIN_DB: db,
      PRO_ROOM_RATE_LIMIT_SECRET: 'rate-limit-secret-'.padEnd(48, 'r'),
      PRO_ROOMS: {
        idFromName: (value: string) => value,
        get: (value: string) => ({
          fetch: async () => {
            forwardedCodes.push(value);
            return new Response(
              JSON.stringify({ roomCode: value, status: 'activation_required' }),
              {
                headers: { 'content-type': 'application/json' },
              },
            );
          },
        }),
      },
    };
    const publicBootstrap = (roomCode: string) =>
      proRoomWorker.fetch(
        new Request(`https://pro.musixquare.com/v1/rooms/${roomCode}/bootstrap`, {
          headers: { origin: 'https://musixquare.com', 'cf-connecting-ip': '192.0.2.44' },
        }),
        env as never,
      );

    expect((await publicBootstrap('000010')).status).toBe(200);
    expect((await publicBootstrap('000011')).status).toBe(404);
    expect((await publicBootstrap('000010')).status).toBe(200);
    expect(registryReads).toBe(1);
    expect(forwardedCodes).toEqual(['000010', '000010']);
  });

  it('scopes session and owner cookies per room so fixed rooms can coexist', async () => {
    const cookies: string[] = [];
    for (const roomCode of ['000000', '000001']) {
      const worker = new MusixquareProRoom(new FakeState() as never, environment() as never);
      const claimToken = await issueProRoomActivationClaim(roomCode, ACTIVATION_SECRET, {
        nowMs: Date.now() - 1_000,
        expiresAtMs: Date.now() + 60_000,
        nonce: `fixed-cookie-nonce-${roomCode}`,
      });
      const response = await worker.fetch(
        jsonRequestForRoom(roomCode, '/activation', 'POST', {
          claimToken,
          temporaryPin: roomCode.padStart(8, '0'),
          newPin: roomCode === '000000' ? '11111111' : '22222222',
        }),
      );
      expect(response.status).toBe(200);
      const setCookies = response.headers.getSetCookie();
      expect(
        setCookies.some((value: string) =>
          value.startsWith(`__Host-mxqr_pro_session_${roomCode}=`),
        ),
      ).toBe(true);
      expect(
        setCookies.some((value: string) => value.startsWith(`__Host-mxqr_pro_owner_${roomCode}=`)),
      ).toBe(true);
      cookies.push(...setCookies.map((value: string) => value.split(';')[0]!));
    }
    expect(cookies).toHaveLength(4);
    expect(new Set(cookies.map((value) => value.split('=')[0])).size).toBe(4);
  });

  it('sets credentialed CORS only for an explicit allowlisted origin', async () => {
    const state = new FakeState();
    const env = environment() as ReturnType<typeof environment> & {
      PRO_ROOM_RATE_LIMIT_SECRET: string;
      PRO_ROOMS: {
        idFromName(value: string): string;
        get(value: string): { fetch(request: Request): Promise<Response> };
      };
    };
    env.PRO_ROOM_RATE_LIMIT_SECRET = 'rate-limit-secret-'.padEnd(48, 'r');
    const durable = new MusixquareProRoom(state as never, env as never);
    env.PRO_ROOMS = {
      idFromName: (value) => value,
      get: () => ({ fetch: (incoming) => durable.fetch(incoming) }),
    };
    const allowed = await proRoomWorker.fetch(
      new Request(`${BASE_URL}/bootstrap`, {
        headers: { origin: 'https://musixquare.com', 'cf-connecting-ip': '192.0.2.1' },
      }),
      env as never,
    );
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://musixquare.com');
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    expect(allowed.headers.get('vary')).toBe('origin');
    const preflight = await proRoomWorker.fetch(
      new Request(`${BASE_URL}/snapshot`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://musixquare.com',
          'access-control-request-method': 'GET',
          'access-control-request-headers':
            'x-mxqr-pro-participant-id,x-mxqr-pro-presence-incarnation,x-mxqr-pro-effects-version',
        },
      }),
      env as never,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toBe(
      'content-type,idempotency-key,authorization,x-mxqr-pro-participant-id,x-mxqr-pro-presence-incarnation,x-mxqr-pro-effects-version,x-mxqr-pro-detach-version',
    );

    for (const previewOrigin of ['http://localhost:4173', 'http://127.0.0.1:4173']) {
      const preview = await proRoomWorker.fetch(
        new Request(`${BASE_URL}/bootstrap`, {
          headers: { origin: previewOrigin, 'cf-connecting-ip': '192.0.2.2' },
        }),
        env as never,
      );
      expect(preview.headers.get('access-control-allow-origin')).toBe(previewOrigin);
    }

    const blocked = await proRoomWorker.fetch(
      new Request(`${BASE_URL}/bootstrap`, { headers: { origin: 'https://evil.example' } }),
      env as never,
    );
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('bounds a direct public mutation body before the room Durable Object is invoked', async () => {
    const downstream = vi.fn(async (incoming: Request) => {
      await expect(incoming.json()).resolves.toEqual({ pin: '12345678' });
      return Response.json({ ok: true });
    });
    const env = {
      ...environment(),
      PRO_ROOM_RATE_LIMIT_SECRET: 'rate-limit-secret-'.padEnd(48, 'r'),
      PRO_ROOMS: {
        idFromName: (value: string) => value,
        get: () => ({ fetch: downstream }),
      },
    };
    let controlled!: ReadableStreamDefaultController<Uint8Array>;
    const controlledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controlled = controller;
        controller.enqueue(new TextEncoder().encode('{"pin":"1234'));
      },
    });
    const completedPromise = proRoomWorker.fetch(
      new Request(`${BASE_URL}/sessions`, {
        method: 'POST',
        headers: { origin: 'https://musixquare.com', 'content-type': 'application/json' },
        body: controlledBody,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      env as never,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(downstream).not.toHaveBeenCalled();
    controlled.enqueue(new TextEncoder().encode('5678"}'));
    controlled.close();
    expect((await completedPromise).status).toBe(200);
    expect(downstream).toHaveBeenCalledOnce();
    downstream.mockClear();

    vi.useFakeTimers();
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"pin":"'));
      },
    });
    const stalledPromise = proRoomWorker.fetch(
      new Request(`${BASE_URL}/sessions`, {
        method: 'POST',
        headers: { origin: 'https://musixquare.com', 'content-type': 'application/json' },
        body: stalledBody,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      env as never,
    );

    // The facade hashes the source IP before it starts consuming the body.
    // Let that native WebCrypto continuation install the bounded-body timer
    // before advancing the fake clock.
    for (let attempt = 0; attempt < 20 && vi.getTimerCount() === 0; attempt += 1) {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    }
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(10_001);
    const stalled = await stalledPromise;
    expect(stalled.status).toBe(408);
    await expect(stalled.json()).resolves.toEqual({ error: 'PRO_ROOM_REQUEST_BODY_TIMEOUT' });
    expect(downstream).not.toHaveBeenCalled();

    vi.useRealTimers();
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const oversized = await proRoomWorker.fetch(
      new Request(`${BASE_URL}/sessions`, {
        method: 'POST',
        headers: { origin: 'https://musixquare.com', 'content-type': 'application/json' },
        body: oversizedBody,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      env as never,
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      error: 'PRO_ROOM_REQUEST_BODY_TOO_LARGE',
    });
    expect(downstream).not.toHaveBeenCalled();
  });
});

describe('persistent PRO room authentication, presence, and state', () => {
  const fullDelegatedPermissions = {
    'media.add': true,
    'playback.control': true,
    'members.kick': true,
    'chat.notice': true,
  };

  function enableMemberAuthority(context: Awaited<ReturnType<typeof activatedRoom>>): void {
    const internal = context.worker as unknown as { env: Record<string, string> };
    internal.env.PRO_ROOM_MEMBER_AUTHORITY_PROJECTION = '1';
  }

  async function addAuthorityMember(context: Awaited<ReturnType<typeof activatedRoom>>) {
    const response = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    expect(response.status).toBe(200);
    const envelope = await responseJson(response);
    const cookie = cookieFrom(response);
    bindCookiePresence(cookie, envelope);
    return { response, envelope, cookie };
  }

  it('negotiates coarse device platforms without breaking cached snapshot clients', async () => {
    const context = await activatedRoom();
    const joinRequest = jsonRequest('/sessions', 'POST', { pin: '12345678' });
    joinRequest.headers.set('accept', 'application/json; mxqr-device-platform=1');
    joinRequest.headers.set(
      'user-agent',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
    );
    const joinedResponse = await context.worker.fetch(joinRequest);
    expect(joinedResponse.status).toBe(200);
    const joined = await responseJson(joinedResponse);
    expect(
      joined.snapshot.presence.participants.find(
        (participant: Record<string, unknown>) =>
          participant.participantId === joined.snapshot.viewer.participantId,
      ),
    ).toMatchObject({ devicePlatform: 'ios' });
    expect(parseProRoomSnapshot(joined.snapshot)).not.toBeNull();

    const legacy = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(
      legacy.snapshot.presence.participants.every(
        (participant: Record<string, unknown>) =>
          !Object.prototype.hasOwnProperty.call(participant, 'devicePlatform'),
      ),
    ).toBe(true);
    expect(parseProRoomSnapshot(legacy.snapshot)).not.toBeNull();

    const negotiated = await responseJson(
      await context.worker.fetch(
        request(
          '/snapshot',
          { headers: { accept: 'application/json; mxqr-device-platform=1' } },
          context.ownerCookie,
        ),
      ),
    );
    expect(
      negotiated.snapshot.presence.participants.find(
        (participant: Record<string, unknown>) =>
          participant.participantId === joined.snapshot.viewer.participantId,
      ),
    ).toMatchObject({ devicePlatform: 'ios' });
  });

  it('keeps one room member identity across several devices of the same account', async () => {
    const context = await activatedRoom();
    const internal = context.worker as unknown as {
      env: Record<string, string>;
      room: Record<string, any>;
    };
    internal.env.PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION = '1';
    const accountId = 'acct_0123456789abcdefghijkl';

    const firstResponse = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/sessions', 'POST', { pin: '12345678' }),
        accountId,
        '민수',
      ),
    );
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get('x-mxqr-account-linked')).toBe('1');
    const first = await responseJson(firstResponse);
    const firstCookie = cookieFrom(firstResponse);
    bindCookiePresence(firstCookie, first);

    const secondResponse = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/sessions', 'POST', { pin: '12345678' }),
        accountId,
        '민수',
      ),
    );
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.headers.get('x-mxqr-account-linked')).toBe('1');
    const second = await responseJson(secondResponse);
    const secondCookie = cookieFrom(secondResponse);
    bindCookiePresence(secondCookie, second);

    expect(second.snapshot.memberIdentityVersion).toBe(1);
    expect(second.snapshot.viewer).toMatchObject({
      memberId: first.snapshot.viewer.memberId,
      memberDisplayNumber: first.snapshot.viewer.memberDisplayNumber,
      isAuthenticated: true,
      displayName: '민수',
    });
    expect(second.snapshot.viewer.participantId).not.toBe(first.snapshot.viewer.participantId);
    const minsuDevices = second.snapshot.presence.participants.filter(
      (participant: Record<string, unknown>) =>
        participant.memberId === second.snapshot.viewer.memberId,
    );
    expect(minsuDevices).toHaveLength(2);
    expect(
      new Set(minsuDevices.map((participant: any) => participant.memberDisplayNumber)),
    ).toEqual(new Set([second.snapshot.viewer.memberDisplayNumber]));
    expect(parseProRoomSnapshot(second.snapshot)).not.toBeNull();
    expect(
      Object.values(internal.room.sessions).filter(
        (session: any) => session.accountId === accountId,
      ),
    ).toHaveLength(2);
    expect(Object.keys(internal.room.accountMembers)).toEqual([accountId]);

    const heartbeat = await context.worker.fetch(
      jsonRequest(
        '/presence/heartbeat',
        'POST',
        {
          revision: second.snapshot.revision,
          playlistRevision: second.snapshot.playlistRevision,
          presenceRevision: second.snapshot.presence.revision,
          playbackRevision: second.snapshot.playback.revision,
          coordinatorEpoch: second.snapshot.presence.coordinatorEpoch,
          displayName: 'Spoofed client identity',
        },
        secondCookie,
      ),
    );
    expect(heartbeat.status).toBe(400);
    await expect(heartbeat.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
    const afterHeartbeat = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, secondCookie)),
    );
    expect(afterHeartbeat.snapshot.viewer.displayName).toBe('민수');

    const revisionBeforeReproof = internal.room.revision as number;
    const reproved = await context.worker.fetch(
      await withAccountAssertion(
        request('/sessions/current/account', { method: 'POST' }, firstCookie),
        accountId,
        '민수',
      ),
    );
    expect(reproved.status).toBe(200);
    expect(internal.room.revision).toBe(revisionBeforeReproof);
  });

  it('renews a proven physical account lease and downgrades only expired devices', async () => {
    vi.useFakeTimers();
    const startedAtMs = new Date('2026-07-20T08:00:00.000Z').getTime();
    vi.setSystemTime(startedAtMs);
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const internal = context.worker as unknown as { room: Record<string, any> };
    const accountId = 'acct_leaseaccount0123456789';
    const otherAccountId = 'acct_otheraccount0123456789';
    const createDevice = async () => {
      const response = await context.worker.fetch(
        await withAccountAssertion(
          jsonRequest('/sessions', 'POST', { pin: '12345678' }),
          accountId,
          'Lease admin',
        ),
      );
      expect(response.status).toBe(200);
      const envelope = await responseJson(response);
      const cookie = cookieFrom(response);
      bindCookiePresence(cookie, envelope);
      return { cookie, envelope };
    };
    const first = await createDevice();
    const second = await createDevice();
    const memberId = first.envelope.snapshot.viewer.memberId as string;
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${memberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    const initialPlayback = structuredClone(internal.room.playback);
    const accountSessions = () =>
      Object.values(internal.room.sessions).filter(
        (session: any) => session.accountId === accountId,
      ) as any[];
    expect(accountSessions()).toHaveLength(2);
    expect(accountSessions().map((session) => session.accountLeaseExpiresAtMs)).toEqual([
      startedAtMs + 120_000,
      startedAtMs + 120_000,
    ]);

    vi.setSystemTime(startedAtMs + 70_000);
    for (const participant of Object.values(internal.room.presence.participants) as any[]) {
      participant.lastSeenAtMs = startedAtMs + 70_000;
    }
    const renewed = await context.worker.fetch(
      await withAccountAssertion(
        request('/sessions/current/account/lease', { method: 'POST' }, first.cookie),
        accountId,
        'Lease admin',
      ),
    );
    expect(renewed.status).toBe(200);
    await expect(renewed.json()).resolves.toEqual({
      ok: true,
      leaseExpiresAtMs: startedAtMs + 190_000,
    });

    const missingAppAccount = await context.worker.fetch(
      request('/sessions/current/account/lease', { method: 'POST' }, second.cookie),
    );
    expect(missingAppAccount.status).toBe(401);
    await expect(missingAppAccount.json()).resolves.toEqual({ error: 'ACCOUNT_SESSION_REQUIRED' });
    const mismatchedAccount = await context.worker.fetch(
      await withAccountAssertion(
        request('/sessions/current/account/lease', { method: 'POST' }, first.cookie),
        otherAccountId,
        'Other account',
      ),
    );
    expect(mismatchedAccount.status).toBe(409);
    await expect(mismatchedAccount.json()).resolves.toEqual({
      error: 'SESSION_ACCOUNT_CONFLICT',
    });

    vi.setSystemTime(startedAtMs + 121_000);
    // Model the ordinary 15-second presence heartbeats independently from the
    // 40-second account lease proof. Lease expiry must change identity only,
    // not remove otherwise-live participants.
    for (const participant of Object.values(internal.room.presence.participants) as any[]) {
      participant.lastSeenAtMs = startedAtMs + 121_000;
    }
    const firstViewResponse = await context.worker.fetch(request('/snapshot', {}, first.cookie));
    expect(firstViewResponse.status, JSON.stringify(await firstViewResponse.clone().json())).toBe(
      200,
    );
    const firstView = await responseJson(firstViewResponse);
    expect(firstView.snapshot.viewer).toMatchObject({
      memberId,
      isAuthenticated: true,
      role: 'controller',
    });
    const expiredView = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, second.cookie)),
    );
    expect(expiredView.snapshot.viewer).toMatchObject({
      isAuthenticated: false,
      role: 'member',
      capabilities: [],
    });
    expect(expiredView.snapshot.viewer.memberId).not.toBe(memberId);
    expect(expiredView.snapshot.presence.participants).toHaveLength(3);
    expect(internal.room.accountMembers[accountId]).toMatchObject({ memberId, role: 'controller' });
    expect(accountSessions()).toHaveLength(1);
    expect(internal.room.playback).toEqual(initialPlayback);

    const expiredRenewal = await context.worker.fetch(
      await withAccountAssertion(
        request('/sessions/current/account/lease', { method: 'POST' }, second.cookie),
        accountId,
        'Lease admin',
      ),
    );
    expect(expiredRenewal.status).toBe(409);
    await expect(expiredRenewal.json()).resolves.toEqual({ error: 'ACCOUNT_REATTACH_REQUIRED' });

    const reattached = await context.worker.fetch(
      await withAccountAssertion(
        request('/sessions/current/account', { method: 'POST' }, second.cookie),
        accountId,
        'Lease admin',
      ),
    );
    expect(reattached.status).toBe(200);
    await expect(reattached.json()).resolves.toMatchObject({
      snapshot: { viewer: { memberId, isAuthenticated: true, role: 'controller' } },
    });
    expect(accountSessions()).toHaveLength(2);
  });

  it('reserves physical admission slots while grouping every account device under its first number', async () => {
    const context = await activatedRoom();
    const internal = context.worker as unknown as {
      env: Record<string, string>;
      room: Record<string, any>;
      persist(): Promise<void>;
    };
    internal.env.PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION = '1';
    const minsuAccountId = 'acct_0123456789abcdefghijkl';
    const jisuAccountId = 'acct_abcdefghijkl0123456789';

    const createAccountDevice = async (accountId: string, nickname: string) => {
      const response = await context.worker.fetch(
        await withAccountAssertion(
          jsonRequest('/sessions', 'POST', { pin: '12345678' }),
          accountId,
          nickname,
        ),
      );
      expect(response.status).toBe(200);
      const envelope = await responseJson(response);
      const cookie = cookieFrom(response);
      bindCookiePresence(cookie, envelope);
      return { envelope, cookie };
    };
    const minsu = await Promise.all([
      createAccountDevice(minsuAccountId, '민수'),
      createAccountDevice(minsuAccountId, '민수'),
      createAccountDevice(minsuAccountId, '민수'),
    ]);
    const jisu = await Promise.all([
      createAccountDevice(jisuAccountId, '지수'),
      createAccountDevice(jisuAccountId, '지수'),
    ]);
    const anonymousResponse = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    expect(anonymousResponse.status).toBe(200);
    const anonymous = await responseJson(anonymousResponse);
    const anonymousCookie = cookieFrom(anonymousResponse);
    bindCookiePresence(anonymousCookie, anonymous);

    const sessionsFor = (accountId: string) =>
      (Object.values(internal.room.sessions) as Array<Record<string, any>>)
        .filter((session) => session.accountId === accountId)
        .sort((left, right) => left.peerOrdinal - right.peerOrdinal);
    expect(sessionsFor(minsuAccountId).map((session: any) => session.peerOrdinal)).toEqual([
      1, 2, 3,
    ]);
    expect(sessionsFor(jisuAccountId).map((session: any) => session.peerOrdinal)).toEqual([4, 5]);
    expect(minsu.map(({ envelope }) => envelope.snapshot.viewer.memberDisplayNumber)).toEqual([
      1, 1, 1,
    ]);
    expect(jisu.map(({ envelope }) => envelope.snapshot.viewer.memberDisplayNumber)).toEqual([
      4, 4,
    ]);
    expect(anonymous.snapshot.viewer).toMatchObject({
      memberDisplayNumber: 6,
      displayName: 'Peer 6',
    });
    expect(
      Object.values(internal.room.sessions).find(
        (session: any) => session.participantId === anonymous.snapshot.viewer.participantId,
      ),
    ).toMatchObject({ peerOrdinal: 6, memberDisplayNumber: 6 });

    // Exercise restart migration too: missing and duplicate durable physical
    // reservations must reconstruct to the same admission layout.
    const minsuSessions = sessionsFor(minsuAccountId);
    const jisuSessions = sessionsFor(jisuAccountId);
    delete minsuSessions[1]!.peerOrdinal;
    minsuSessions[2]!.peerOrdinal = 1;
    delete jisuSessions[1]!.peerOrdinal;
    await internal.persist();

    const restartedEnv = environment(context.bucket) as ReturnType<typeof environment> & {
      PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION: string;
    };
    restartedEnv.PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION = '1';
    const restarted = new MusixquareProRoom(context.state as never, restartedEnv as never);
    const restored = await restarted.fetch(request('/snapshot', {}, anonymousCookie));
    expect(restored.status).toBe(200);
    const restoredEnvelope = await responseJson(restored);
    expect(restoredEnvelope.snapshot.viewer).toMatchObject({
      memberDisplayNumber: 6,
      displayName: 'Peer 6',
    });
    const restartedRoom = (restarted as unknown as { room: Record<string, any> }).room;
    const restartedSlots = (accountId: string) =>
      Object.values(restartedRoom.sessions)
        .filter((session: any) => session.accountId === accountId)
        .map((session: any) => session.peerOrdinal)
        .sort((left: number, right: number) => left - right);
    expect(restartedSlots(minsuAccountId)).toEqual([1, 2, 3]);
    expect(restartedSlots(jisuAccountId)).toEqual([4, 5]);
    expect(restartedRoom.nextMemberDisplayNumber).toBe(7);
  });

  it('links the proven owner credential once and restores owner role on another account device', async () => {
    const context = await activatedRoom();
    const internal = context.worker as unknown as {
      env: Record<string, string>;
      room: Record<string, any>;
    };
    internal.env.PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION = '1';
    const accountId = 'acct_abcdefghijkl0123456789';

    const attachResponse = await context.worker.fetch(
      await withAccountAssertion(
        request('/sessions/current/account', { method: 'POST' }, context.ownerCookie),
        accountId,
        '방 주인',
      ),
    );
    expect(attachResponse.status).toBe(200);
    expect(attachResponse.headers.get('x-mxqr-account-linked')).toBe('1');
    const attached = await responseJson(attachResponse);
    expect(attached.snapshot.viewer).toMatchObject({
      role: 'owner',
      displayName: '방 주인',
      memberDisplayNumber: 0,
      isAuthenticated: true,
    });
    expect(internal.room.ownerAccountId).toBe(accountId);

    const otherDeviceResponse = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/sessions', 'POST', { pin: '12345678' }),
        accountId,
        '방 주인',
      ),
    );
    expect(otherDeviceResponse.status).toBe(200);
    expect(otherDeviceResponse.headers.get('x-mxqr-account-linked')).toBe('1');
    const otherDevice = await responseJson(otherDeviceResponse);
    expect(otherDevice.snapshot.viewer).toMatchObject({
      memberId: attached.snapshot.viewer.memberId,
      role: 'owner',
      displayName: '방 주인',
      memberDisplayNumber: 0,
      isAuthenticated: true,
    });
    expect(otherDevice.snapshot.viewer.participantId).not.toBe(
      attached.snapshot.viewer.participantId,
    );
  });

  it('detaches only the current account device and preserves persistent member authority', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const internal = context.worker as unknown as { room: Record<string, any> };
    const accountId = 'acct_groupeddevices01234567';
    const createDevice = async () => {
      const response = await context.worker.fetch(
        await withAccountAssertion(
          jsonRequest('/sessions', 'POST', { pin: '12345678' }),
          accountId,
          '민수',
        ),
      );
      expect(response.status).toBe(200);
      const envelope = await responseJson(response);
      const cookie = cookieFrom(response);
      bindCookiePresence(cookie, envelope);
      return { envelope, cookie };
    };
    const first = await createDevice();
    const second = await createDevice();
    const accountMemberId = first.envelope.snapshot.viewer.memberId as string;
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${accountMemberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);

    const freshBeforeDetach = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, first.cookie)),
    );
    const beforeRevision = internal.room.revision as number;
    const detachedResponse = await context.worker.fetch(detachV2Request(first.cookie));
    expect(detachedResponse.status).toBe(200);
    const detached = await responseJson(detachedResponse);
    expect(detached).toMatchObject({ ok: true, detached: true });
    expect(detached.snapshot.viewer).toMatchObject({
      role: 'member',
      isAuthenticated: false,
      capabilities: [],
    });
    expect(detached.snapshot.viewer.memberId).not.toBe(accountMemberId);
    expect(detached.snapshot.viewer.displayName).toBe(
      `Peer ${detached.snapshot.viewer.memberDisplayNumber}`,
    );
    expect(internal.room.accountMembers[accountId]).toMatchObject({
      memberId: accountMemberId,
      role: 'controller',
    });
    const accountSessions = Object.values(internal.room.sessions).filter(
      (session: any) => session.accountId === accountId,
    ) as any[];
    expect(accountSessions).toHaveLength(1);
    expect(accountSessions[0]).toMatchObject({
      memberId: accountMemberId,
      displayName: '민수',
      role: 'controller',
    });
    expect(
      detached.snapshot.administrators.find(
        (administrator: Record<string, unknown>) => administrator.memberId === accountMemberId,
      ),
    ).toMatchObject({ onlineDeviceCount: 1, role: 'controller' });
    expect(internal.room.revision).toBe(beforeRevision + 1);

    // Heartbeats never carry identity. A client that includes the former
    // account nickname is rejected by the exact request schema.
    const accountDisplayName = freshBeforeDetach.snapshot.viewer.displayName as string;
    const staleHeartbeat = await context.worker.fetch(
      jsonRequest(
        '/presence/heartbeat',
        'POST',
        {
          revision: freshBeforeDetach.snapshot.revision,
          playlistRevision: freshBeforeDetach.snapshot.playlistRevision,
          presenceRevision: freshBeforeDetach.snapshot.presence.revision,
          playbackRevision: freshBeforeDetach.snapshot.playback.revision,
          coordinatorEpoch: freshBeforeDetach.snapshot.presence.coordinatorEpoch,
          displayName: accountDisplayName,
        },
        first.cookie,
      ),
    );
    expect(staleHeartbeat.status).toBe(400);
    await expect(staleHeartbeat.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
    const afterStaleHeartbeat = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, first.cookie)),
    );
    expect(afterStaleHeartbeat.snapshot.viewer).toMatchObject({
      memberId: detached.snapshot.viewer.memberId,
      displayName: detached.snapshot.viewer.displayName,
      isAuthenticated: false,
    });
    expect(
      afterStaleHeartbeat.snapshot.presence.participants.filter(
        (participant: Record<string, unknown>) => participant.displayName === accountDisplayName,
      ),
    ).toHaveLength(1);

    const idempotent = await context.worker.fetch(detachV2Request(first.cookie));
    expect(idempotent.status).toBe(200);
    const idempotentEnvelope = await responseJson(idempotent);
    expect(idempotentEnvelope).toMatchObject({ ok: true, detached: true });
    expect(idempotentEnvelope.snapshot.viewer).toMatchObject({
      memberId: detached.snapshot.viewer.memberId,
      memberDisplayNumber: detached.snapshot.viewer.memberDisplayNumber,
      displayName: detached.snapshot.viewer.displayName,
      isAuthenticated: false,
    });
    expect(internal.room.revision).toBe(beforeRevision + 1);

    const legacy = await context.worker.fetch(
      request('/sessions/current/account', { method: 'DELETE' }, first.cookie),
    );
    await expect(legacy.json()).resolves.toEqual({ snapshot: idempotentEnvelope.snapshot });

    const secondSnapshot = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, second.cookie)),
    );
    expect(secondSnapshot.snapshot.viewer).toMatchObject({
      memberId: accountMemberId,
      isAuthenticated: true,
      displayName: '민수',
      role: 'controller',
    });
  });

  it('detaches an account from an offline resumable session without deleting its grant', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const internal = context.worker as unknown as { room: Record<string, any> };
    const accountId = 'acct_persistent0123456789ab';
    const response = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/sessions', 'POST', { pin: '12345678' }),
        accountId,
        'Offline admin',
      ),
    );
    const envelope = await responseJson(response);
    const cookie = cookieFrom(response);
    bindCookiePresence(cookie, envelope);
    const memberId = envelope.snapshot.viewer.memberId as string;
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${memberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (await context.worker.fetch(request('/presence/current', { method: 'DELETE' }, cookie)))
        .status,
    ).toBe(200);

    const detached = await context.worker.fetch(detachV2Request(cookie));
    expect(detached.status).toBe(200);
    await expect(detached.json()).resolves.toEqual({
      ok: true,
      detached: true,
      snapshot: null,
    });
    const legacyOffline = await context.worker.fetch(
      request('/sessions/current/account', { method: 'DELETE' }, cookie),
    );
    const legacyOfflineEnvelope = await responseJson(legacyOffline);
    expect(Object.keys(legacyOfflineEnvelope)).toEqual(['snapshot']);
    expect(legacyOfflineEnvelope.snapshot.viewer).toBeNull();
    expect(internal.room.accountMembers[accountId]).toMatchObject({
      memberId,
      role: 'controller',
    });
    expect(
      Object.values(internal.room.sessions).some((session: any) => session.accountId === accountId),
    ).toBe(false);
    const ownerView = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(ownerView.snapshot.administrators).toContainEqual(
      expect.objectContaining({ memberId, onlineDeviceCount: 0, role: 'controller' }),
    );
  });

  it('keeps the linked owner durable while logout demotes one device and disables legacy-cookie elevation', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const internal = context.worker as unknown as { room: Record<string, any> };
    const accountId = 'acct_abcdefghijkl0123456789';
    const attachedResponse = await context.worker.fetch(
      await withAccountAssertion(
        request('/sessions/current/account', { method: 'POST' }, context.ownerCookie),
        accountId,
        '방 주인',
      ),
    );
    const attached = await responseJson(attachedResponse);

    const otherDeviceResponse = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/sessions', 'POST', { pin: '12345678' }),
        accountId,
        '방 주인',
      ),
    );
    const otherDevice = await responseJson(otherDeviceResponse);
    const otherCookie = cookieFrom(otherDeviceResponse);
    bindCookiePresence(otherCookie, otherDevice);

    const detachedResponse = await context.worker.fetch(detachV2Request(context.ownerCookie));
    expect(detachedResponse.status).toBe(200);
    const detached = await responseJson(detachedResponse);
    expect(detached).toMatchObject({ ok: true, detached: true });
    expect(detached.snapshot.viewer).toMatchObject({
      role: 'member',
      isAuthenticated: false,
      capabilities: [],
    });
    expect(internal.room.ownerAccountId).toBe(accountId);
    expect(internal.room.accountMembers[accountId]).toMatchObject({
      memberId: attached.snapshot.viewer.memberId,
      role: 'owner',
    });
    const stillOwner = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, otherCookie)),
    );
    expect(stillOwner.snapshot.viewer).toMatchObject({
      memberId: attached.snapshot.viewer.memberId,
      role: 'owner',
      isAuthenticated: true,
    });

    const legacyCookieOnly = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }, context.ownerRecoveryCookie),
    );
    expect(legacyCookieOnly.status).toBe(200);
    const legacyEnvelope = await responseJson(legacyCookieOnly);
    expect(legacyEnvelope.snapshot.viewer).toMatchObject({
      role: 'member',
      isAuthenticated: false,
      capabilities: [],
    });
  });

  it('keeps an ordinary PRO member read-only, including end and unavailable observations', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const friend = await addAuthorityMember(context);

    expect(friend.envelope.snapshot).toMatchObject({
      memberIdentityVersion: 1,
      authorityVersion: 1,
      viewer: {
        role: 'member',
        capabilities: [],
      },
    });
    expect(friend.envelope.snapshot.administrators).toMatchObject([
      {
        role: 'owner',
        permissions: { 'playback.control': true },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
      },
    ]);
    expect(parseProRoomSnapshot(friend.envelope.snapshot)).not.toBeNull();

    const internal = context.worker as unknown as { room: Record<string, any> };
    const queueItemId = 'abababab-abab-4bab-8bab-abababababab';
    internal.room.playlist = [
      {
        queueItemId,
        name: 'Listener policy fixture',
        source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      },
    ];
    internal.room.currentQueueItemId = queueItemId;
    internal.room.playback = {
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
      revision: 7,
      state: 'playing',
      queueItemId,
      positionSeconds: 0,
      updatedAtMs: Date.now() - 1_000,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    };
    const deniedPause = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        { type: 'pause', baseRevision: 7 },
        friend.cookie,
        'listener-playback-policy-pause',
      ),
    );
    expect(deniedPause.status).toBe(403);
    await expect(deniedPause.json()).resolves.toEqual({ error: 'PERMISSION_REQUIRED' });
    const deniedUnavailable = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'unavailable',
          baseRevision: 7,
          queueItemId,
          mediaKind: 'youtube',
          observedPositionSeconds: 0,
          durationSeconds: null,
          youtubeVideoId: 'dQw4w9WgXcQ',
          youtubeSubIndex: 0,
        },
        friend.cookie,
        'listener-playback-policy-unavailable',
      ),
    );
    expect(deniedUnavailable.status).toBe(403);
    await expect(deniedUnavailable.json()).resolves.toEqual({ error: 'PERMISSION_REQUIRED' });
    const observedEnd = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'ended',
          baseRevision: 7,
          queueItemId,
          mediaKind: 'youtube',
          observedPositionSeconds: 0.1,
          durationSeconds: 0.1,
          youtubeVideoId: 'dQw4w9WgXcQ',
          youtubeSubIndex: 0,
        },
        friend.cookie,
        'listener-playback-policy-ended',
      ),
    );
    expect(observedEnd.status).toBe(403);
    await expect(observedEnd.json()).resolves.toEqual({ error: 'PERMISSION_REQUIRED' });
    expect(internal.room.playback).toMatchObject({
      revision: 7,
      state: 'playing',
      queueItemId,
    });

    const initialQueueMode = await responseJson(
      await context.worker.fetch(request('/queue-mode', {}, friend.cookie)),
    );
    const deniedQueueConfiguration = await context.worker.fetch(
      jsonRequest(
        '/queue-mode',
        'PUT',
        {
          coordinatorEpoch: friend.envelope.snapshot.presence.coordinatorEpoch,
          baseRevision: initialQueueMode.revision,
          playlistRevision: friend.envelope.snapshot.playlistRevision,
          repeatMode: 1,
          shuffleEnabled: false,
          shuffleOrder: [],
        },
        friend.cookie,
      ),
    );
    expect(deniedQueueConfiguration.status).toBe(403);
    await expect(deniedQueueConfiguration.json()).resolves.toEqual({
      error: 'CAPABILITY_REQUIRED',
    });

    const deniedNotice = await context.worker.fetch(
      new Request('https://pro-room.internal/internal/authority/check', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({
          participantId: friend.envelope.snapshot.viewer.participantId,
          presenceIncarnationId: friend.envelope.snapshot.viewer.presenceIncarnationId,
          permission: 'chat.notice',
        }),
      }),
    );
    expect(deniedNotice.status).toBe(403);
    await expect(deniedNotice.json()).resolves.toEqual({ error: 'PERMISSION_REQUIRED' });

    const deniedBot = await internalBotRequest(
      context.worker,
      'context',
      {
        roomCode: ROOM_CODE,
        requestId: 'bot-member-authority-denied-0001',
        prompt: 'add a song',
      },
      friend.cookie,
    );
    expect(deniedBot.status).toBe(403);
    await expect(deniedBot.json()).resolves.toEqual({ error: 'ADMINISTRATOR_REQUIRED' });

    const deniedUpload = await context.worker.fetch(
      jsonRequest(
        '/media/reservations',
        'POST',
        { byteLength: 1024, name: 'denied.wav', mime: 'audio/wav' },
        friend.cookie,
        `${IDEMPOTENCY_KEY}-member-upload-denied`,
      ),
    );
    expect(deniedUpload.status).toBe(403);
    await expect(deniedUpload.json()).resolves.toEqual({ error: 'CAPABILITY_REQUIRED' });

    const deniedSystemAudio = await context.worker.fetch(
      jsonRequest('/system-audio/acquire', 'POST', {}, friend.cookie),
    );
    expect(deniedSystemAudio.status).toBe(403);
    await expect(deniedSystemAudio.json()).resolves.toEqual({ error: 'OWNER_REQUIRED' });

    const deniedKick = await context.worker.fetch(
      jsonRequest(
        '/presence/kick',
        'POST',
        { targetParticipantId: context.activationEnvelope.snapshot.viewer.participantId },
        friend.cookie,
      ),
    );
    expect(deniedKick.status).toBe(403);
  });

  it('lets only the owner delegate canonical permissions and exposes a chat-notice check seam', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const friend = await addAuthorityMember(context);
    const memberId = friend.envelope.snapshot.viewer.memberId as string;

    const delegatedWithoutPlayback = await context.worker.fetch(
      jsonRequest(
        `/administrators/${memberId}`,
        'PUT',
        {
          permissions: { ...fullDelegatedPermissions, 'playback.control': false },
        },
        context.ownerCookie,
      ),
    );
    expect(delegatedWithoutPlayback.status).toBe(200);
    await expect(delegatedWithoutPlayback.json()).resolves.toMatchObject({
      administrators: [
        { role: 'owner' },
        {
          memberId,
          role: 'controller',
          permissions: { 'playback.control': false },
          inheritedPermissions: [],
        },
      ],
    });
    const playbackDisabled = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, friend.cookie)),
    );
    expect(playbackDisabled.snapshot.viewer).toMatchObject({
      role: 'controller',
      capabilities: ['queue.mutate', 'asset.upload', 'members.manage'],
    });

    const delegated = await context.worker.fetch(
      jsonRequest(
        `/administrators/${memberId}`,
        'PUT',
        { permissions: fullDelegatedPermissions },
        context.ownerCookie,
      ),
    );
    expect(delegated.status).toBe(200);
    const directory = await responseJson(delegated);
    expect(directory.administrators).toMatchObject([
      { role: 'owner' },
      {
        memberId,
        role: 'controller',
        isAuthenticated: false,
        permissions: fullDelegatedPermissions,
        inheritedPermissions: [],
        onlineDeviceCount: 1,
      },
    ]);

    const current = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, friend.cookie)),
    );
    expect(current.snapshot.viewer).toMatchObject({
      role: 'controller',
      capabilities: ['queue.mutate', 'playback.control', 'asset.upload', 'members.manage'],
    });
    expect(parseProRoomSnapshot(current.snapshot)).not.toBeNull();

    const deniedEffects = await context.worker.fetch(
      jsonRequest('/effects', 'PUT', {}, friend.cookie),
    );
    expect(deniedEffects.status).toBe(403);
    await expect(deniedEffects.json()).resolves.toEqual({ error: 'OWNER_REQUIRED' });

    const destructiveRequestId = 'bot-admin-destructive-allowed-0001';
    const destructiveContext = await internalBotRequest(
      context.worker,
      'context',
      { roomCode: ROOM_CODE, requestId: destructiveRequestId, prompt: 'clear the queue' },
      friend.cookie,
    );
    expect(destructiveContext.status).toBe(200);
    const destructiveContextBody = await responseJson(destructiveContext);
    const destructiveBot = await internalBotRequest(
      context.worker,
      'execute',
      {
        roomCode: ROOM_CODE,
        requestId: destructiveRequestId,
        leaseToken: destructiveContextBody.leaseToken,
        plan: {
          intent: 'clear_queue',
          basePlaylistRevision: destructiveContextBody.room.playlistRevision,
        },
        tracks: [],
      },
      friend.cookie,
    );
    expect(destructiveBot.status).toBe(200);

    const delegatedModeRequestId = 'bot-admin-queue-mode-allowed-0001';
    const delegatedModeContext = await internalBotRequest(
      context.worker,
      'context',
      { roomCode: ROOM_CODE, requestId: delegatedModeRequestId, prompt: 'enable shuffle' },
      friend.cookie,
    );
    expect(delegatedModeContext.status).toBe(200);
    const delegatedModeContextBody = await responseJson(delegatedModeContext);
    const delegatedModeBot = await internalBotRequest(
      context.worker,
      'execute',
      {
        roomCode: ROOM_CODE,
        requestId: delegatedModeRequestId,
        leaseToken: delegatedModeContextBody.leaseToken,
        plan: { intent: 'queue_mode', shuffleEnabled: true },
        tracks: [],
      },
      friend.cookie,
    );
    expect(delegatedModeBot.status).toBe(200);

    const ownerModeRequestId = 'bot-owner-queue-mode-allowed-0001';
    const ownerModeContext = await internalBotRequest(
      context.worker,
      'context',
      { roomCode: ROOM_CODE, requestId: ownerModeRequestId, prompt: 'enable shuffle' },
      context.ownerCookie,
    );
    expect(ownerModeContext.status).toBe(200);
    const ownerModeContextBody = await responseJson(ownerModeContext);
    const ownerModeBot = await internalBotRequest(
      context.worker,
      'execute',
      {
        roomCode: ROOM_CODE,
        requestId: ownerModeRequestId,
        leaseToken: ownerModeContextBody.leaseToken,
        plan: { intent: 'queue_mode', shuffleEnabled: true },
        tracks: [],
      },
      context.ownerCookie,
    );
    expect(ownerModeBot.status).toBe(200);
    expect(
      (context.worker as unknown as { room: Record<string, any> }).room.queueMode,
    ).toMatchObject({
      shuffleEnabled: true,
    });

    const authorityCheck = await context.worker.fetch(
      new Request('https://pro-room.internal/internal/authority/check', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({
          participantId: current.snapshot.viewer.participantId,
          presenceIncarnationId: current.snapshot.viewer.presenceIncarnationId,
          permission: 'chat.notice',
        }),
      }),
    );
    expect(authorityCheck.status).toBe(200);
    await expect(authorityCheck.json()).resolves.toMatchObject({
      allowed: true,
      memberId,
      permission: 'chat.notice',
    });

    const forbiddenDelegation = await context.worker.fetch(
      jsonRequest(
        `/administrators/${context.activationEnvelope.snapshot.viewer.memberId}`,
        'PUT',
        { permissions: fullDelegatedPermissions },
        friend.cookie,
      ),
    );
    expect(forbiddenDelegation.status).toBe(403);
    await expect(forbiddenDelegation.json()).resolves.toEqual({ error: 'OWNER_REQUIRED' });

    const immutableOwner = await context.worker.fetch(
      jsonRequest(
        '/presence/kick',
        'POST',
        { targetParticipantId: context.activationEnvelope.snapshot.viewer.participantId },
        friend.cookie,
      ),
    );
    expect(immutableOwner.status).toBe(409);
    await expect(immutableOwner.json()).resolves.toEqual({ error: 'OWNER_AUTHORITY_IMMUTABLE' });
  });

  it('does not let BOT widen a delegated administrator playback permission', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const friend = await addAuthorityMember(context);
    const memberId = friend.envelope.snapshot.viewer.memberId as string;
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${memberId}`,
            'PUT',
            { permissions: { ...fullDelegatedPermissions, 'playback.control': false } },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);

    const execute = async (
      requestId: string,
      plan: Record<string, unknown>,
      tracks: Record<string, unknown>[] = [],
    ) => {
      const botContext = await internalBotRequest(
        context.worker,
        'context',
        { roomCode: ROOM_CODE, requestId, prompt: 'permission boundary' },
        friend.cookie,
      );
      expect(botContext.status).toBe(200);
      const contextBody = await responseJson(botContext);
      return internalBotRequest(
        context.worker,
        'execute',
        { roomCode: ROOM_CODE, requestId, leaseToken: contextBody.leaseToken, plan, tracks },
        friend.cookie,
      );
    };

    const addRequestId = 'bot-playback-disabled-add-0001';
    const addContext = await internalBotRequest(
      context.worker,
      'context',
      { roomCode: ROOM_CODE, requestId: addRequestId, prompt: 'add and play' },
      friend.cookie,
    );
    const addContextBody = await responseJson(addContext);
    const track = { videoId: 'dQw4w9WgXcQ', name: 'Permission fixture' };
    const deniedAddAndPlay = await internalBotRequest(
      context.worker,
      'execute',
      {
        roomCode: ROOM_CODE,
        requestId: addRequestId,
        leaseToken: addContextBody.leaseToken,
        plan: {
          intent: 'add_youtube',
          trackQueries: ['Permission fixture official audio'],
          playAddedIndex: 0,
        },
        tracks: [track],
      },
      friend.cookie,
    );
    expect(deniedAddAndPlay.status).toBe(403);
    await expect(deniedAddAndPlay.json()).resolves.toEqual({ error: 'PERMISSION_REQUIRED' });

    // The same valid context may still perform the separately delegated media
    // addition when it does not also request playback.
    const allowedAddOnly = await internalBotRequest(
      context.worker,
      'execute',
      {
        roomCode: ROOM_CODE,
        requestId: addRequestId,
        leaseToken: addContextBody.leaseToken,
        plan: {
          intent: 'add_youtube',
          trackQueries: ['Permission fixture official audio'],
          playAddedIndex: -1,
        },
        tracks: [track],
      },
      friend.cookie,
    );
    expect(allowedAddOnly.status).toBe(200);
    const internal = context.worker as unknown as { room: Record<string, any> };
    const queueItemId = internal.room.playlist[0].queueItemId as string;

    const deniedPlayback = await execute('bot-playback-disabled-command-0002', {
      intent: 'playback',
      playbackCommand: 'play',
    });
    expect(deniedPlayback.status).toBe(403);
    await expect(deniedPlayback.json()).resolves.toEqual({ error: 'PERMISSION_REQUIRED' });

    const deniedSelection = await execute('bot-playback-disabled-select-0003', {
      intent: 'play_existing',
      queueItemId,
    });
    expect(deniedSelection.status).toBe(403);
    await expect(deniedSelection.json()).resolves.toEqual({ error: 'PERMISSION_REQUIRED' });
  });

  it('authorizes privileged realtime chat from canonical server-side facts', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const friend = await addAuthorityMember(context);
    const memberId = friend.envelope.snapshot.viewer.memberId as string;
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${memberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    const owner = context.activationEnvelope.snapshot.viewer;
    const controller = friend.envelope.snapshot.viewer;
    const authority = (
      viewer: Record<string, any>,
      permission: string,
      details: Record<string, unknown> = {},
    ) =>
      context.worker.fetch(
        new Request('https://pro-room.internal/internal/authority/check', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': ROOM_CODE,
          },
          body: JSON.stringify({
            participantId: viewer.participantId,
            presenceIncarnationId: viewer.presenceIncarnationId,
            permission,
            ...details,
          }),
        }),
      );

    expect((await authority(owner, 'room.configure')).status).toBe(200);
    expect((await authority(controller, 'room.configure')).status).toBe(403);
    expect((await authority(controller, 'chat.manage')).status).toBe(200);
    expect(
      (
        await authority(controller, 'system.broadcast', {
          i18nKey: 'chat.decode_skip_system_message',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await authority(controller, 'system.broadcast', {
          i18nKey: 'chat.system_audio_started_system_message',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await authority(owner, 'system.broadcast', {
          i18nKey: 'chat.system_audio_started_system_message',
        })
      ).status,
    ).toBe(200);

    const requestId = 'bot-authority-result-proof-0001';
    const botContext = await internalBotRequest(
      context.worker,
      'context',
      { roomCode: ROOM_CODE, requestId, prompt: 'say done' },
      context.ownerCookie,
    );
    const botContextBody = await responseJson(botContext);
    const executed = await internalBotRequest(
      context.worker,
      'execute',
      {
        roomCode: ROOM_CODE,
        requestId,
        leaseToken: botContextBody.leaseToken,
        plan: { intent: 'answer', answer: 'Done.' },
        tracks: [],
      },
      context.ownerCookie,
    );
    expect(executed.status).toBe(200);
    expect(
      (
        await authority(owner, 'bot.result', {
          requestId,
          result: { kind: 'answer', text: 'Done.' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await authority(owner, 'bot.result', {
          requestId,
          result: { kind: 'answer', text: 'Forged.' },
        })
      ).status,
    ).toBe(403);
  });

  it('keeps system-audio publishing owner-only even when media addition is delegated', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const friend = await addAuthorityMember(context);
    const memberId = friend.envelope.snapshot.viewer.memberId as string;
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${memberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);

    const delegatedAcquire = await context.worker.fetch(
      jsonRequest('/system-audio/acquire', 'POST', {}, friend.cookie),
    );
    expect(delegatedAcquire.status).toBe(403);
    await expect(delegatedAcquire.json()).resolves.toEqual({ error: 'OWNER_REQUIRED' });

    const ownerAcquire = await context.worker.fetch(
      jsonRequest('/system-audio/acquire', 'POST', {}, context.ownerCookie),
    );
    expect(ownerAcquire.status).toBe(200);
  });

  it('grants add, remove, and reorder through the stable media permission', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const firstAuthorityQueueItemId = '61111111-1111-4111-8111-111111111111';
    const secondAuthorityQueueItemId = '62222222-2222-4222-8222-222222222222';
    const authorityPlaylist = [
      {
        queueItemId: firstAuthorityQueueItemId,
        name: 'First authority item',
        source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      },
      {
        queueItemId: secondAuthorityQueueItemId,
        name: 'Second authority item',
        source: { kind: 'youtube', videoId: '9bZkp7q19f0' },
      },
    ];
    const friend = await addAuthorityMember(context);
    const memberId = friend.envelope.snapshot.viewer.memberId as string;
    const noMediaAdd = { ...fullDelegatedPermissions, 'media.add': false };
    const mediaManagerPermissions = {
      ...fullDelegatedPermissions,
      'playback.control': false,
    };
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${memberId}`,
            'PUT',
            { permissions: noMediaAdd },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    expect((await replacePlaylist(context, authorityPlaylist, 'authority-queue-seed')).status).toBe(
      200,
    );
    const before = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, friend.cookie)),
    );
    expect(before.snapshot.viewer.capabilities).not.toContain('queue.mutate');
    expect(before.snapshot.viewer.capabilities).not.toContain('asset.upload');

    const queueModeBeforeGrant = await responseJson(
      await context.worker.fetch(request('/queue-mode', {}, friend.cookie)),
    );
    const deniedQueueModeBeforeGrant = await context.worker.fetch(
      jsonRequest(
        '/queue-mode',
        'PUT',
        {
          coordinatorEpoch: before.snapshot.presence.coordinatorEpoch,
          baseRevision: queueModeBeforeGrant.revision,
          playlistRevision: before.snapshot.playlistRevision,
          repeatMode: 1,
          shuffleEnabled: false,
          shuffleOrder: [],
        },
        friend.cookie,
      ),
    );
    expect(deniedQueueModeBeforeGrant.status).toBe(403);
    await expect(deniedQueueModeBeforeGrant.json()).resolves.toEqual({
      error: 'CAPABILITY_REQUIRED',
    });

    const addRequestId = 'bot-admin-media-add-denied-0001';
    const addContext = await internalBotRequest(
      context.worker,
      'context',
      { roomCode: ROOM_CODE, requestId: addRequestId, prompt: 'add a song' },
      friend.cookie,
    );
    expect(addContext.status).toBe(200);
    const addContextBody = await responseJson(addContext);
    const deniedBotAddition = await internalBotRequest(
      context.worker,
      'execute',
      {
        roomCode: ROOM_CODE,
        requestId: addRequestId,
        leaseToken: addContextBody.leaseToken,
        plan: {
          intent: 'add_youtube',
          trackQueries: ['Test Artist Test Song official audio'],
          playAddedIndex: -1,
        },
        tracks: [{ videoId: 'M7lc1UVf-VE', name: 'Denied BOT addition' }],
      },
      friend.cookie,
    );
    expect(deniedBotAddition.status).toBe(403);
    await expect(deniedBotAddition.json()).resolves.toEqual({ error: 'PERMISSION_REQUIRED' });

    const queueModeRequestId = 'bot-admin-queue-mode-denied-without-media-0001';
    const queueModeContext = await internalBotRequest(
      context.worker,
      'context',
      { roomCode: ROOM_CODE, requestId: queueModeRequestId, prompt: 'enable shuffle' },
      friend.cookie,
    );
    expect(queueModeContext.status).toBe(200);
    const queueModeContextBody = await responseJson(queueModeContext);
    const deniedBotQueueMode = await internalBotRequest(
      context.worker,
      'execute',
      {
        roomCode: ROOM_CODE,
        requestId: queueModeRequestId,
        leaseToken: queueModeContextBody.leaseToken,
        plan: { intent: 'queue_mode', shuffleEnabled: true },
        tracks: [],
      },
      friend.cookie,
    );
    expect(deniedBotQueueMode.status).toBe(403);
    await expect(deniedBotQueueMode.json()).resolves.toEqual({
      error: 'PERMISSION_REQUIRED',
    });

    const reordered = await context.worker.fetch(
      jsonRequest(
        '/snapshot/compact',
        'POST',
        {
          baseRevision: before.snapshot.revision,
          playlistOrder: [secondAuthorityQueueItemId, firstAuthorityQueueItemId],
          upserts: [],
          currentQueueItemId: null,
          playback: null,
        },
        friend.cookie,
        `${IDEMPOTENCY_KEY}-authority-reorder`,
      ),
    );
    expect(reordered.status).toBe(403);
    await expect(reordered.json()).resolves.toEqual({ error: 'CAPABILITY_REQUIRED' });

    const deniedAddition = await context.worker.fetch(
      jsonRequest(
        '/snapshot/compact',
        'POST',
        {
          baseRevision: before.snapshot.revision,
          playlistOrder: [
            firstAuthorityQueueItemId,
            secondAuthorityQueueItemId,
            '63333333-3333-4333-8333-333333333333',
          ],
          upserts: [
            {
              queueItemId: '63333333-3333-4333-8333-333333333333',
              name: 'Denied addition',
              source: { kind: 'youtube', videoId: '9bZkp7q19f0' },
            },
          ],
          currentQueueItemId: null,
          playback: null,
        },
        friend.cookie,
        `${IDEMPOTENCY_KEY}-authority-add-denied`,
      ),
    );
    expect(deniedAddition.status).toBe(403);
    await expect(deniedAddition.json()).resolves.toEqual({ error: 'CAPABILITY_REQUIRED' });

    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${memberId}`,
            'PUT',
            { permissions: mediaManagerPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    const afterGrant = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, friend.cookie)),
    );
    expect(afterGrant.snapshot.viewer.capabilities).toContain('queue.mutate');
    expect(afterGrant.snapshot.viewer.capabilities).not.toContain('playback.control');
    expect(afterGrant.snapshot.viewer.capabilities).not.toContain('effects.control');
    const initialQueueMode = await responseJson(
      await context.worker.fetch(request('/queue-mode', {}, friend.cookie)),
    );
    const managedQueueMode = await context.worker.fetch(
      jsonRequest(
        '/queue-mode',
        'PUT',
        {
          coordinatorEpoch: afterGrant.snapshot.presence.coordinatorEpoch,
          baseRevision: initialQueueMode.revision,
          playlistRevision: afterGrant.snapshot.playlistRevision,
          repeatMode: 1,
          shuffleEnabled: false,
          shuffleOrder: [],
        },
        friend.cookie,
      ),
    );
    expect(managedQueueMode.status).toBe(200);
    await expect(managedQueueMode.json()).resolves.toMatchObject({ repeatMode: 1 });
    const afterQueueMode = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, friend.cookie)),
    );
    const managedReorder = await context.worker.fetch(
      jsonRequest(
        '/snapshot/compact',
        'POST',
        {
          baseRevision: afterQueueMode.snapshot.revision,
          playlistOrder: [secondAuthorityQueueItemId, firstAuthorityQueueItemId],
          upserts: [],
          currentQueueItemId: null,
          playback: null,
        },
        friend.cookie,
        `${IDEMPOTENCY_KEY}-authority-reorder-with-add-alias`,
      ),
    );
    expect(managedReorder.status).toBe(200);
    const afterReorder = await responseJson(managedReorder);
    expect(
      afterReorder.snapshot.playlist.map((item: { queueItemId: string }) => item.queueItemId),
    ).toEqual([secondAuthorityQueueItemId, firstAuthorityQueueItemId]);

    const added = await context.worker.fetch(
      jsonRequest(
        '/snapshot/compact',
        'POST',
        {
          baseRevision: afterReorder.snapshot.revision,
          playlistOrder: [
            secondAuthorityQueueItemId,
            firstAuthorityQueueItemId,
            '63333333-3333-4333-8333-333333333333',
          ],
          upserts: [
            {
              queueItemId: '63333333-3333-4333-8333-333333333333',
              name: 'Allowed addition',
              source: { kind: 'youtube', videoId: 'M7lc1UVf-VE' },
            },
          ],
          currentQueueItemId: null,
          playback: null,
        },
        friend.cookie,
        `${IDEMPOTENCY_KEY}-authority-add-allowed`,
      ),
    );
    expect(added.status).toBe(200);

    const afterAddition = await responseJson(added);
    const managedRemoval = await context.worker.fetch(
      jsonRequest(
        '/snapshot/compact',
        'POST',
        {
          baseRevision: afterAddition.snapshot.revision,
          playlistOrder: [secondAuthorityQueueItemId, firstAuthorityQueueItemId],
          upserts: [],
          currentQueueItemId: null,
          playback: null,
        },
        friend.cookie,
        `${IDEMPOTENCY_KEY}-authority-remove-allowed`,
      ),
    );
    expect(managedRemoval.status).toBe(200);
    const afterRemoval = await responseJson(managedRemoval);
    expect(
      afterRemoval.snapshot.playlist.map((item: { queueItemId: string }) => item.queueItemId),
    ).toEqual([secondAuthorityQueueItemId, firstAuthorityQueueItemId]);

    const deniedMetadataRewrite = await context.worker.fetch(
      jsonRequest(
        '/snapshot/compact',
        'POST',
        {
          baseRevision: afterRemoval.snapshot.revision,
          playlistOrder: [secondAuthorityQueueItemId, firstAuthorityQueueItemId],
          upserts: [
            {
              queueItemId: firstAuthorityQueueItemId,
              name: 'Rewritten authority item',
              source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
            },
          ],
          currentQueueItemId: null,
          playback: null,
        },
        friend.cookie,
        `${IDEMPOTENCY_KEY}-authority-rewrite-denied`,
      ),
    );
    expect(deniedMetadataRewrite.status).toBe(403);
    await expect(deniedMetadataRewrite.json()).resolves.toEqual({ error: 'OWNER_REQUIRED' });
  });

  it('projects administrators as owner, online member number, then deterministic offline nickname', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);

    const addAccountAdministrator = async (index: number, nickname: string) => {
      const accountId = `acct_${String(index).padStart(22, '0')}`;
      const response = await context.worker.fetch(
        await withAccountAssertion(
          jsonRequest('/sessions', 'POST', { pin: '12345678' }),
          accountId,
          nickname,
        ),
      );
      expect(response.status).toBe(200);
      const envelope = await responseJson(response);
      const cookie = cookieFrom(response);
      bindCookiePresence(cookie, envelope);
      const memberId = envelope.snapshot.viewer.memberId as string;
      const memberDisplayNumber = envelope.snapshot.viewer.memberDisplayNumber as number;
      const delegated = await context.worker.fetch(
        jsonRequest(
          `/administrators/${memberId}`,
          'PUT',
          { permissions: fullDelegatedPermissions },
          context.ownerCookie,
        ),
      );
      expect(delegated.status).toBe(200);
      return { accountId, cookie, memberId, memberDisplayNumber, nickname };
    };
    const leavePresence = async (cookie: string) => {
      const response = await context.worker.fetch(
        request('/presence/current', { method: 'DELETE' }, cookie),
      );
      expect(response.status).toBe(200);
    };
    const administratorSnapshot = async (cookie: string) =>
      (await responseJson(await context.worker.fetch(request('/snapshot', {}, cookie)))).snapshot
        .administrators as Array<{
        memberId: string;
        memberDisplayNumber: number;
        displayName: string;
        role: 'owner' | 'controller';
        onlineDeviceCount: number;
      }>;

    // The oldest member number deliberately becomes offline. If the projection
    // accidentally returns to number-only sorting it will jump ahead of both
    // live administrators.
    const zulu = await addAccountAdministrator(1, 'Zulu Offline');
    const onlineTwo = await addAccountAdministrator(2, 'Online Two');
    const onlineThree = await addAccountAdministrator(3, 'Online Three');
    const korean = await addAccountAdministrator(4, '가나다 Offline');
    const alpha = await addAccountAdministrator(5, 'Alpha Offline');
    const sameHighId = await addAccountAdministrator(6, 'Same Offline');
    const sameLowId = await addAccountAdministrator(7, 'Same Offline');
    for (const { cookie } of [zulu, korean, alpha, sameHighId, sameLowId]) {
      await leavePresence(cookie);
    }

    const ownerMemberId = context.activationEnvelope.snapshot.viewer.memberId as string;
    const sameMemberIds = [sameHighId.memberId, sameLowId.memberId].sort();
    const expectedOnlineIds = [onlineTwo.memberId, onlineThree.memberId];
    const expectedOfflineIds = [alpha.memberId, ...sameMemberIds, zulu.memberId, korean.memberId];
    const initial = await administratorSnapshot(onlineTwo.cookie);
    expect(initial.map(({ memberId }) => memberId)).toEqual([
      ownerMemberId,
      ...expectedOnlineIds,
      ...expectedOfflineIds,
    ]);
    expect(initial[0]).toMatchObject({ role: 'owner', onlineDeviceCount: 1 });
    expect(initial.slice(1, 3).map(({ memberDisplayNumber }) => memberDisplayNumber)).toEqual([
      onlineTwo.memberDisplayNumber,
      onlineThree.memberDisplayNumber,
    ]);
    expect(initial.slice(3).map(({ displayName }) => displayName)).toEqual([
      'Alpha Offline',
      'Same Offline',
      'Same Offline',
      'Zulu Offline',
      '가나다 Offline',
    ]);

    // A live/offline transition changes only presence, but must immediately
    // move the persistent grant into the nickname-sorted offline group.
    await leavePresence(onlineThree.cookie);
    const afterLeave = await administratorSnapshot(onlineTwo.cookie);
    expect(afterLeave.map(({ memberId }) => memberId)).toEqual([
      ownerMemberId,
      onlineTwo.memberId,
      alpha.memberId,
      onlineThree.memberId,
      ...sameMemberIds,
      zulu.memberId,
      korean.memberId,
    ]);
    expect(afterLeave.find(({ memberId }) => memberId === onlineThree.memberId)).toMatchObject({
      onlineDeviceCount: 0,
    });

    const reenteredResponse = await context.worker.fetch(
      request('/presence/enter', { method: 'POST' }, onlineThree.cookie),
    );
    expect(reenteredResponse.status).toBe(200);
    const reentered = await responseJson(reenteredResponse);
    bindCookiePresence(onlineThree.cookie, reentered);
    const reenteredAdministrators = reentered.snapshot.administrators as Array<{
      memberId: string;
      memberDisplayNumber: number;
      onlineDeviceCount: number;
    }>;
    const reenteredOnline = reenteredAdministrators.filter(
      ({ memberId, onlineDeviceCount }) => memberId !== ownerMemberId && onlineDeviceCount > 0,
    );
    expect(new Set(reenteredOnline.map(({ memberId }) => memberId))).toEqual(
      new Set(expectedOnlineIds),
    );
    expect(reenteredOnline.map(({ memberDisplayNumber }) => memberDisplayNumber)).toEqual(
      reenteredOnline
        .map(({ memberDisplayNumber }) => memberDisplayNumber)
        .sort((left, right) => left - right),
    );
    const reenteredOnlineIds = reenteredOnline.map(({ memberId }) => memberId);
    expect(reenteredAdministrators.map(({ memberId }) => memberId)).toEqual([
      ownerMemberId,
      ...reenteredOnlineIds,
      ...expectedOfflineIds,
    ]);

    // The owner remains the first row even while its own presence is offline.
    await leavePresence(context.ownerCookie);
    const ownerOffline = await administratorSnapshot(onlineTwo.cookie);
    expect(ownerOffline[0]).toMatchObject({
      memberId: ownerMemberId,
      role: 'owner',
      onlineDeviceCount: 0,
    });
    expect(ownerOffline.slice(1, 3).map(({ memberId }) => memberId)).toEqual(reenteredOnlineIds);
  });

  it('persists account delegation offline while anonymous delegation dies with its session', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const accountId = 'acct_persistent0123456789ab';
    const accountResponse = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/sessions', 'POST', { pin: '12345678' }),
        accountId,
        'Persistent admin',
      ),
    );
    const accountEnvelope = await responseJson(accountResponse);
    const accountCookie = cookieFrom(accountResponse);
    bindCookiePresence(accountCookie, accountEnvelope);
    const accountMemberId = accountEnvelope.snapshot.viewer.memberId as string;
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${accountMemberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await context.worker.fetch(
          request('/sessions/current', { method: 'DELETE' }, accountCookie),
        )
      ).status,
    ).toBe(200);
    const offline = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(offline.snapshot.administrators).toContainEqual(
      expect.objectContaining({ memberId: accountMemberId, onlineDeviceCount: 0 }),
    );

    const rejoinedResponse = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/sessions', 'POST', { pin: '12345678' }),
        accountId,
        'Persistent admin',
      ),
    );
    const rejoined = await responseJson(rejoinedResponse);
    const rejoinedCookie = cookieFrom(rejoinedResponse);
    bindCookiePresence(rejoinedCookie, rejoined);
    expect(rejoined.snapshot.viewer).toMatchObject({
      memberId: accountMemberId,
      role: 'controller',
    });
    const revoked = await context.worker.fetch(
      request(`/administrators/${accountMemberId}`, { method: 'DELETE' }, context.ownerCookie),
    );
    expect(revoked.status).toBe(200);
    const afterRevoke = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, rejoinedCookie)),
    );
    expect(afterRevoke.snapshot.viewer).toMatchObject({
      memberId: accountMemberId,
      role: 'member',
      capabilities: [],
    });

    const anonymous = await addAuthorityMember(context);
    const anonymousMemberId = anonymous.envelope.snapshot.viewer.memberId as string;
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${anonymousMemberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await context.worker.fetch(
          request('/sessions/current', { method: 'DELETE' }, anonymous.cookie),
        )
      ).status,
    ).toBe(200);
    const afterAnonymousLeave = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(
      afterAnonymousLeave.snapshot.administrators.some(
        (administrator: Record<string, unknown>) => administrator.memberId === anonymousMemberId,
      ),
    ).toBe(false);
  });

  it('restores an authenticated administrator grant after a Durable Object restart', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const accountId = 'acct_restartadmin0123456789';
    const joinedResponse = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/sessions', 'POST', { pin: '12345678' }),
        accountId,
        'Restart admin',
      ),
    );
    expect(joinedResponse.status).toBe(200);
    const joined = await responseJson(joinedResponse);
    const joinedCookie = cookieFrom(joinedResponse);
    bindCookiePresence(joinedCookie, joined);
    const memberId = joined.snapshot.viewer.memberId as string;
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${memberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (await context.worker.fetch(request('/sessions/current', { method: 'DELETE' }, joinedCookie)))
        .status,
    ).toBe(200);

    const restartedEnv = environment(context.bucket) as ReturnType<typeof environment> & {
      PRO_ROOM_MEMBER_AUTHORITY_PROJECTION: string;
    };
    restartedEnv.PRO_ROOM_MEMBER_AUTHORITY_PROJECTION = '1';
    const restarted = new MusixquareProRoom(context.state as never, restartedEnv as never);
    const rejoinedResponse = await restarted.fetch(
      await withAccountAssertion(
        jsonRequest('/sessions', 'POST', { pin: '12345678' }),
        accountId,
        'Restart admin',
      ),
    );
    expect(rejoinedResponse.status).toBe(200);
    const rejoined = await responseJson(rejoinedResponse);
    expect(rejoined.snapshot.viewer).toMatchObject({
      memberId,
      role: 'controller',
      isAuthenticated: true,
      capabilities: ['queue.mutate', 'playback.control', 'asset.upload', 'members.manage'],
    });
    expect(rejoined.snapshot.administrators).toContainEqual(
      expect.objectContaining({ memberId, role: 'controller', isAuthenticated: true }),
    );
  });

  it('revokes an anonymous administrator when its final presence expires but keeps the session resumable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T08:00:00.000Z'));
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const anonymous = await addAuthorityMember(context);
    const memberId = anonymous.envelope.snapshot.viewer.memberId as string;
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${memberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);

    vi.advanceTimersByTime(46_000);
    await context.worker.alarm();
    const internal = context.worker as unknown as { room: Record<string, any> };
    expect(internal.room.anonymousAdministrators[memberId]).toBeUndefined();
    const resumableSession = Object.values(internal.room.sessions).find(
      (session: any) => session.participantId === anonymous.envelope.snapshot.viewer.participantId,
    ) as any;
    expect(resumableSession).toMatchObject({ memberId, role: 'member' });

    const reenteredResponse = await context.worker.fetch(
      request('/presence/enter', { method: 'POST' }, anonymous.cookie),
    );
    expect(reenteredResponse.status).toBe(200);
    const reentered = await responseJson(reenteredResponse);
    expect(reentered.snapshot.viewer).toMatchObject({ memberId, role: 'member' });
    expect(
      reentered.snapshot.administrators.some(
        (administrator: Record<string, unknown>) => administrator.memberId === memberId,
      ),
    ).toBe(false);
  });

  it('keeps anonymous delegation until the same member final live device leaves', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const first = await addAuthorityMember(context);
    const second = await addAuthorityMember(context);
    const internal = context.worker as unknown as { room: Record<string, any> };
    const memberId = first.envelope.snapshot.viewer.memberId as string;
    const memberDisplayNumber = first.envelope.snapshot.viewer.memberDisplayNumber as number;
    const secondParticipantId = second.envelope.snapshot.viewer.participantId as string;
    const secondParticipant = internal.room.presence.participants[secondParticipantId];
    const secondSession = internal.room.sessions[secondParticipant.sessionHash];
    secondSession.memberId = memberId;
    secondSession.memberDisplayNumber = memberDisplayNumber;
    secondSession.displayName = 'Shared anonymous member';
    secondParticipant.memberId = memberId;
    secondParticipant.memberDisplayNumber = memberDisplayNumber;
    secondParticipant.displayName = 'Shared anonymous member';

    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${memberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (await context.worker.fetch(request('/presence/current', { method: 'DELETE' }, first.cookie)))
        .status,
    ).toBe(200);
    expect(internal.room.anonymousAdministrators[memberId]).toBeDefined();
    const afterFirstLeave = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, second.cookie)),
    );
    expect(afterFirstLeave.snapshot.viewer).toMatchObject({ role: 'controller' });
    expect(afterFirstLeave.snapshot.administrators).toContainEqual(
      expect.objectContaining({ memberId, onlineDeviceCount: 1 }),
    );

    expect(
      (
        await context.worker.fetch(
          request('/presence/current', { method: 'DELETE' }, second.cookie),
        )
      ).status,
    ).toBe(200);
    expect(internal.room.anonymousAdministrators[memberId]).toBeUndefined();
    expect(secondSession.role).toBe('member');
  });

  it('does not promote an ephemeral anonymous grant into a persistent account grant on sign-in', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const anonymous = await addAuthorityMember(context);
    const anonymousMemberId = anonymous.envelope.snapshot.viewer.memberId as string;
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${anonymousMemberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);

    const attachedResponse = await context.worker.fetch(
      await withAccountAssertion(
        request('/sessions/current/account', { method: 'POST' }, anonymous.cookie),
        'acct_attachdemotion01234567',
        'Signed-in member',
      ),
    );
    expect(attachedResponse.status).toBe(200);
    expect(attachedResponse.headers.get('x-mxqr-account-linked')).toBe('1');
    const attached = await responseJson(attachedResponse);
    expect(attached.snapshot.viewer).toMatchObject({
      displayName: 'Signed-in member',
      role: 'member',
      isAuthenticated: true,
      capabilities: [],
    });
    expect(attached.snapshot.viewer.memberId).not.toBe(anonymousMemberId);
    expect(
      attached.snapshot.administrators.some(
        (administrator: Record<string, unknown>) =>
          administrator.memberId === anonymousMemberId ||
          administrator.memberId === attached.snapshot.viewer.memberId,
      ),
    ).toBe(false);
  });

  it('applies an explicit owner grant after an anonymous participant signs in', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const anonymous = await addAuthorityMember(context);
    const attachedResponse = await context.worker.fetch(
      await withAccountAssertion(
        request('/sessions/current/account', { method: 'POST' }, anonymous.cookie),
        'acct_explicitgrant012345678',
        'Member Admin',
      ),
    );
    expect(attachedResponse.status).toBe(200);
    const attached = await responseJson(attachedResponse);
    const accountMemberId = attached.snapshot.viewer.memberId as string;
    expect(attached.snapshot.viewer).toMatchObject({
      memberId: accountMemberId,
      role: 'member',
      isAuthenticated: true,
      capabilities: [],
    });

    const grantedResponse = await context.worker.fetch(
      jsonRequest(
        `/administrators/${accountMemberId}`,
        'PUT',
        { permissions: fullDelegatedPermissions },
        context.ownerCookie,
      ),
    );
    expect(grantedResponse.status).toBe(200);

    const targetView = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, anonymous.cookie)),
    );
    expect(targetView.snapshot.viewer).toMatchObject({
      memberId: accountMemberId,
      role: 'controller',
      isAuthenticated: true,
      capabilities: ['queue.mutate', 'playback.control', 'asset.upload', 'members.manage'],
    });
    expect(targetView.snapshot.administrators).toContainEqual(
      expect.objectContaining({
        memberId: accountMemberId,
        role: 'controller',
        isAuthenticated: true,
        permissions: fullDelegatedPermissions,
      }),
    );
    expect(parseProRoomSnapshot(targetView.snapshot)).not.toBeNull();
  });

  it('kicks every device in one account and prevents delegated admins from kicking peers', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const accountId = 'acct_groupeddevices01234567';
    const createAccountDevice = async () => {
      const response = await context.worker.fetch(
        await withAccountAssertion(
          jsonRequest('/sessions', 'POST', { pin: '12345678' }),
          accountId,
          'Grouped listener',
        ),
      );
      const envelope = await responseJson(response);
      const cookie = cookieFrom(response);
      bindCookiePresence(cookie, envelope);
      return { response, envelope, cookie };
    };
    const first = await createAccountDevice();
    const second = await createAccountDevice();
    expect(second.envelope.snapshot.viewer.memberId).toBe(first.envelope.snapshot.viewer.memberId);

    const delegated = await addAuthorityMember(context);
    const delegatedMemberId = delegated.envelope.snapshot.viewer.memberId as string;
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${delegatedMemberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    const otherAdministrator = await addAuthorityMember(context);
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${otherAdministrator.envelope.snapshot.viewer.memberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    const forbidden = await context.worker.fetch(
      jsonRequest(
        '/presence/kick-device',
        'POST',
        { targetParticipantId: otherAdministrator.envelope.snapshot.viewer.participantId },
        delegated.cookie,
      ),
    );
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({ error: 'ADMINISTRATOR_TARGET_FORBIDDEN' });
    expect(
      (await context.worker.fetch(request('/snapshot', {}, otherAdministrator.cookie))).status,
    ).toBe(200);

    const immutableOwner = await context.worker.fetch(
      jsonRequest(
        '/presence/kick-device',
        'POST',
        { targetParticipantId: context.activationEnvelope.snapshot.viewer.participantId },
        delegated.cookie,
      ),
    );
    expect(immutableOwner.status).toBe(409);
    await expect(immutableOwner.json()).resolves.toEqual({
      error: 'OWNER_AUTHORITY_IMMUTABLE',
    });
    expect((await context.worker.fetch(request('/snapshot', {}, context.ownerCookie))).status).toBe(
      200,
    );

    const kicked = await context.worker.fetch(
      jsonRequest(
        '/presence/kick',
        'POST',
        { targetParticipantId: first.envelope.snapshot.viewer.participantId },
        delegated.cookie,
      ),
    );
    expect(kicked.status).toBe(200);
    expect((await context.worker.fetch(request('/snapshot', {}, first.cookie))).status).toBe(401);
    expect((await context.worker.fetch(request('/snapshot', {}, second.cookie))).status).toBe(401);
  });

  it('lets a delegated controller disconnect its sibling device while preserving its current session and authority', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const internal = context.worker as unknown as { room: Record<string, any> };
    const accountId = 'acct_singledevice0123456789';
    const createAccountDevice = async () => {
      const response = await context.worker.fetch(
        await withAccountAssertion(
          jsonRequest('/sessions', 'POST', { pin: '12345678' }),
          accountId,
          'Device administrator',
        ),
      );
      expect(response.status).toBe(200);
      const envelope = await responseJson(response);
      const cookie = cookieFrom(response);
      bindCookiePresence(cookie, envelope);
      return { envelope, cookie };
    };
    const first = await createAccountDevice();
    const second = await createAccountDevice();
    const memberId = first.envelope.snapshot.viewer.memberId as string;
    expect(second.envelope.snapshot.viewer.memberId).toBe(memberId);
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${memberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);

    const memberShape = await context.worker.fetch(
      jsonRequest(
        '/presence/kick-device',
        'POST',
        { targetMemberId: memberId },
        context.ownerCookie,
      ),
    );
    expect(memberShape.status).toBe(400);
    await expect(memberShape.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });

    const currentParticipantId = second.envelope.snapshot.viewer.participantId as string;
    const currentDevice = await context.worker.fetch(
      jsonRequest(
        '/presence/kick-device',
        'POST',
        { targetParticipantId: currentParticipantId },
        second.cookie,
      ),
    );
    expect(currentDevice.status).toBe(409);
    await expect(currentDevice.json()).resolves.toEqual({ error: 'CANNOT_KICK_SELF' });
    expect((await context.worker.fetch(request('/snapshot', {}, second.cookie))).status).toBe(200);

    const kicked = await context.worker.fetch(
      jsonRequest(
        '/presence/kick-device',
        'POST',
        { targetParticipantId: first.envelope.snapshot.viewer.participantId },
        second.cookie,
      ),
    );
    expect(kicked.status).toBe(200);
    expect((await context.worker.fetch(request('/snapshot', {}, first.cookie))).status).toBe(401);

    const siblingSnapshot = await context.worker.fetch(request('/snapshot', {}, second.cookie));
    expect(siblingSnapshot.status).toBe(200);
    const sibling = await responseJson(siblingSnapshot);
    const remainingParticipantIds = sibling.snapshot.presence.participants.map(
      (participant: Record<string, unknown>) => participant.participantId,
    );
    expect(remainingParticipantIds).not.toContain(first.envelope.snapshot.viewer.participantId);
    expect(remainingParticipantIds).toContain(second.envelope.snapshot.viewer.participantId);
    expect(sibling.snapshot.viewer).toMatchObject({
      memberId,
      role: 'controller',
      isAuthenticated: true,
      capabilities: ['queue.mutate', 'playback.control', 'asset.upload', 'members.manage'],
    });
    expect(sibling.snapshot.administrators).toContainEqual(
      expect.objectContaining({
        memberId,
        role: 'controller',
        isAuthenticated: true,
        permissions: fullDelegatedPermissions,
      }),
    );
    expect(internal.room.accountMembers[accountId]).toMatchObject({
      memberId,
      role: 'controller',
      permissions: fullDelegatedPermissions,
    });
  });

  it('lets an account-linked owner disconnect a sibling owner device without weakening owner authority', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const internal = context.worker as unknown as { room: Record<string, any> };
    const accountId = 'acct_ownerdevices0123456789';
    const attachedResponse = await context.worker.fetch(
      await withAccountAssertion(
        request('/sessions/current/account', { method: 'POST' }, context.ownerCookie),
        accountId,
        'Owner devices',
      ),
    );
    expect(attachedResponse.status).toBe(200);
    const attached = await responseJson(attachedResponse);
    const ownerMemberId = attached.snapshot.viewer.memberId as string;
    const currentParticipantId = attached.snapshot.viewer.participantId as string;

    const siblingResponse = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/sessions', 'POST', { pin: '12345678' }),
        accountId,
        'Owner devices',
      ),
    );
    expect(siblingResponse.status).toBe(200);
    const sibling = await responseJson(siblingResponse);
    const siblingCookie = cookieFrom(siblingResponse);
    bindCookiePresence(siblingCookie, sibling);
    const siblingParticipantId = sibling.snapshot.viewer.participantId as string;
    expect(sibling.snapshot.viewer).toMatchObject({
      memberId: ownerMemberId,
      role: 'owner',
      isAuthenticated: true,
    });
    expect(siblingParticipantId).not.toBe(currentParticipantId);

    const currentDevice = await context.worker.fetch(
      jsonRequest(
        '/presence/kick-device',
        'POST',
        { targetParticipantId: currentParticipantId },
        context.ownerCookie,
      ),
    );
    expect(currentDevice.status).toBe(409);
    await expect(currentDevice.json()).resolves.toEqual({ error: 'CANNOT_KICK_SELF' });
    expect((await context.worker.fetch(request('/snapshot', {}, context.ownerCookie))).status).toBe(
      200,
    );

    const kicked = await context.worker.fetch(
      jsonRequest(
        '/presence/kick-device',
        'POST',
        { targetParticipantId: siblingParticipantId },
        context.ownerCookie,
      ),
    );
    expect(kicked.status).toBe(200);
    expect((await context.worker.fetch(request('/snapshot', {}, siblingCookie))).status).toBe(401);

    const ownerSnapshotResponse = await context.worker.fetch(
      request('/snapshot', {}, context.ownerCookie),
    );
    expect(ownerSnapshotResponse.status).toBe(200);
    const ownerSnapshot = await responseJson(ownerSnapshotResponse);
    const remainingParticipantIds = ownerSnapshot.snapshot.presence.participants.map(
      (participant: Record<string, unknown>) => participant.participantId,
    );
    expect(remainingParticipantIds).toContain(currentParticipantId);
    expect(remainingParticipantIds).not.toContain(siblingParticipantId);
    expect(ownerSnapshot.snapshot.viewer).toMatchObject({
      memberId: ownerMemberId,
      participantId: currentParticipantId,
      role: 'owner',
      isAuthenticated: true,
      capabilities: expect.arrayContaining([
        'queue.mutate',
        'playback.control',
        'asset.upload',
        'members.manage',
      ]),
    });
    expect(ownerSnapshot.snapshot.administrators).toContainEqual(
      expect.objectContaining({
        memberId: ownerMemberId,
        role: 'owner',
        isAuthenticated: true,
        onlineDeviceCount: 1,
        permissions: fullDelegatedPermissions,
      }),
    );
    expect(internal.room.ownerAccountId).toBe(accountId);
    expect(internal.room.accountMembers[accountId]).toMatchObject({
      memberId: ownerMemberId,
      role: 'owner',
      permissions: fullDelegatedPermissions,
    });
    expect(
      Object.values(internal.room.sessions).filter(
        (session: any) => session.accountId === accountId,
      ),
    ).toHaveLength(1);
  });

  it('revokes an authenticated administrator account when the owner kicks that member', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const internal = context.worker as unknown as { room: Record<string, any> };
    const accountId = 'acct_kickadmin0123456789abc';
    const createAccountDevice = async () => {
      const response = await context.worker.fetch(
        await withAccountAssertion(
          jsonRequest('/sessions', 'POST', { pin: '12345678' }),
          accountId,
          'Kicked administrator',
        ),
      );
      expect(response.status).toBe(200);
      const envelope = await responseJson(response);
      const cookie = cookieFrom(response);
      bindCookiePresence(cookie, envelope);
      return { envelope, cookie };
    };
    const first = await createAccountDevice();
    const second = await createAccountDevice();
    const memberId = first.envelope.snapshot.viewer.memberId as string;
    expect(second.envelope.snapshot.viewer.memberId).toBe(memberId);
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${memberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);

    const kicked = await context.worker.fetch(
      jsonRequest('/presence/kick', 'POST', { targetMemberId: memberId }, context.ownerCookie),
    );
    expect(kicked.status).toBe(200);
    expect((await context.worker.fetch(request('/snapshot', {}, first.cookie))).status).toBe(401);
    expect((await context.worker.fetch(request('/snapshot', {}, second.cookie))).status).toBe(401);
    expect(internal.room.accountMembers[accountId]).toBeUndefined();
    expect(
      (await responseJson(kicked)).snapshot.administrators.some(
        (administrator: Record<string, unknown>) => administrator.memberId === memberId,
      ),
    ).toBe(false);

    const rejoinedResponse = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/sessions', 'POST', { pin: '12345678' }),
        accountId,
        'Kicked administrator',
      ),
    );
    expect(rejoinedResponse.status).toBe(200);
    const rejoined = await responseJson(rejoinedResponse);
    expect(rejoined.snapshot.viewer).toMatchObject({
      role: 'member',
      isAuthenticated: true,
      capabilities: [],
    });
    expect(rejoined.snapshot.viewer.memberId).not.toBe(memberId);
  });

  it('purges account-bound authority through the internal account-deletion seam', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const accountId = 'acct_purgeauthority01234567';
    const response = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/sessions', 'POST', { pin: '12345678' }),
        accountId,
        'Soon deleted',
      ),
    );
    const envelope = await responseJson(response);
    const cookie = cookieFrom(response);
    bindCookiePresence(cookie, envelope);
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${envelope.snapshot.viewer.memberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);

    const purged = await context.worker.fetch(
      new Request('https://pro-room.internal/internal/admin/account-authority/purge', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({ accountId }),
      }),
    );
    expect(purged.status).toBe(200);
    await expect(purged.json()).resolves.toEqual({
      ok: true,
      roomCode: ROOM_CODE,
      roomGeneration: 0,
      removedSessions: 1,
    });
    expect((await context.worker.fetch(request('/snapshot', {}, cookie))).status).toBe(401);
    const ownerSnapshot = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(
      ownerSnapshot.snapshot.administrators.some(
        (administrator: Record<string, unknown>) =>
          administrator.memberId === envelope.snapshot.viewer.memberId,
      ),
    ).toBe(false);
  });

  it('purges every owner-account device and removes the durable owner association', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const internal = context.worker as unknown as { room: Record<string, any> };
    const accountId = 'acct_abcdefghijkl0123456789';
    const attachedResponse = await context.worker.fetch(
      await withAccountAssertion(
        request('/sessions/current/account', { method: 'POST' }, context.ownerCookie),
        accountId,
        'Deleted owner',
      ),
    );
    expect(attachedResponse.status).toBe(200);
    const attached = await responseJson(attachedResponse);
    const ownerMemberId = attached.snapshot.viewer.memberId as string;

    const secondResponse = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/sessions', 'POST', { pin: '12345678' }),
        accountId,
        'Deleted owner',
      ),
    );
    expect(secondResponse.status).toBe(200);
    const second = await responseJson(secondResponse);
    const secondCookie = cookieFrom(secondResponse);
    bindCookiePresence(secondCookie, second);
    expect(second.snapshot.viewer).toMatchObject({ memberId: ownerMemberId, role: 'owner' });

    const purged = await context.worker.fetch(
      new Request('https://pro-room.internal/internal/admin/account-authority/purge', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({ accountId }),
      }),
    );
    expect(purged.status).toBe(200);
    await expect(purged.json()).resolves.toEqual({
      ok: true,
      roomCode: ROOM_CODE,
      roomGeneration: 0,
      removedSessions: 2,
    });
    expect((await context.worker.fetch(request('/snapshot', {}, context.ownerCookie))).status).toBe(
      401,
    );
    expect((await context.worker.fetch(request('/snapshot', {}, secondCookie))).status).toBe(401);
    expect(internal.room.ownerAccountId).toBeNull();
    expect(internal.room.accountMembers[accountId]).toBeUndefined();
    expect(
      Object.values(internal.room.sessions).some((session: any) => session.accountId === accountId),
    ).toBe(false);
  });

  it('rejects a pre-issued account assertion that arrives after account deletion', async () => {
    vi.useFakeTimers();
    const startedAtMs = new Date('2026-07-20T06:00:00.000Z').getTime();
    vi.setSystemTime(startedAtMs);
    const context = await activatedRoom();
    const accountId = 'acct_0123456789ABCDEFGHIJKL';
    const delayedJoin = await withAccountAssertion(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
      accountId,
      'Deleted arrival',
    );

    const purged = await context.worker.fetch(
      new Request('https://pro-room.internal/internal/admin/account-authority/purge', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
        },
        body: JSON.stringify({ accountId }),
      }),
    );
    expect(purged.status).toBe(200);
    await expect(purged.json()).resolves.toEqual({
      ok: true,
      roomCode: ROOM_CODE,
      roomGeneration: 0,
      removedSessions: 0,
    });

    // Recreate the Durable Object isolate to prove the deletion fence was
    // committed even though the account had not yet created a room member.
    const restarted = new MusixquareProRoom(
      context.state as never,
      environment(context.bucket) as never,
    );
    const rejected = await restarted.fetch(delayedJoin);
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ error: 'ACCOUNT_ASSERTION_INVALID' });
    const internal = restarted as unknown as { room: Record<string, any> };
    expect(internal.room.accountDeletionTombstones[accountId]).toBe(startedAtMs + 5 * 60 * 1000);
    expect(internal.room.accountMembers[accountId]).toBeUndefined();
    expect(
      Object.values(internal.room.sessions).some((session: any) => session.accountId === accountId),
    ).toBe(false);

    vi.setSystemTime(startedAtMs + 5 * 60 * 1000 + 1);
    await restarted.alarm();
    expect(internal.room.accountDeletionTombstones[accountId]).toBeUndefined();
  });

  it('restores the owner role from the separate host-only owner credential', async () => {
    const { worker, ownerCookie, ownerRecoveryCookie, activationEnvelope } = await activatedRoom();
    const closed = await worker.fetch(
      request('/sessions/current', { method: 'DELETE' }, ownerCookie),
    );
    expect(closed.status).toBe(200);
    expect(closed.headers.get('set-cookie')).toBeNull();
    const restored = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }, ownerRecoveryCookie),
    );
    const restoredEnvelope = await responseJson(restored);
    expect(restoredEnvelope.snapshot.viewer).toMatchObject({
      role: 'owner',
      memberId: activationEnvelope.snapshot.viewer.memberId,
    });
  });

  it('assigns server-owned physical names and rejects heartbeat identity fields', async () => {
    const { worker } = await activatedRoom();
    const rejectedLegacyJoin = await worker.fetch(
      jsonRequest('/sessions', 'POST', {
        pin: '12345678',
        displayName: 'Legacy device name',
      }),
    );
    expect(rejectedLegacyJoin.status).toBe(400);
    expect(await responseJson(rejectedLegacyJoin)).toEqual({ error: 'INVALID_REQUEST' });

    const firstResponse = await worker.fetch(jsonRequest('/sessions', 'POST', { pin: '12345678' }));
    const firstCookie = cookieFrom(firstResponse);
    const first = await responseJson(firstResponse);
    bindCookiePresence(firstCookie, first);
    expect(first.snapshot.viewer.displayName).toBe('Peer 1');

    const secondPeerResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const secondPeerCookie = cookieFrom(secondPeerResponse);
    const secondPeer = await responseJson(secondPeerResponse);
    bindCookiePresence(secondPeerCookie, secondPeer);
    expect(secondPeer.snapshot.viewer.displayName).toBe('Peer 2');

    const secondResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const secondCookie = cookieFrom(secondResponse);
    const second = await responseJson(secondResponse);
    bindCookiePresence(secondCookie, second);
    expect(second.snapshot.viewer.displayName).toBe('Peer 3');

    const claimedNumberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const claimedNumber = await responseJson(claimedNumberResponse);
    expect(claimedNumber.snapshot.viewer.displayName).toBe('Peer 4');

    const rejectedIdentityResponse = await worker.fetch(
      jsonRequest(
        '/presence/heartbeat',
        'POST',
        {
          revision: first.snapshot.revision,
          playlistRevision: first.snapshot.playlistRevision,
          presenceRevision: first.snapshot.presence.revision,
          playbackRevision: first.snapshot.playback.revision,
          coordinatorEpoch: first.snapshot.presence.coordinatorEpoch,
          displayName: 'Peer 4',
        },
        firstCookie,
      ),
    );
    expect(rejectedIdentityResponse.status).toBe(400);
    await expect(rejectedIdentityResponse.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
    const unchanged = await responseJson(await worker.fetch(request('/snapshot', {}, firstCookie)));
    expect(unchanged.snapshot.viewer.displayName).toBe('Peer 1');

    const leave = await worker.fetch(
      request('/presence/current', { method: 'DELETE' }, firstCookie),
    );
    expect(leave.status).toBe(200);
    const reentryResponse = await worker.fetch(
      request('/presence/enter', { method: 'POST' }, firstCookie),
    );
    const reentry = await responseJson(reentryResponse);
    bindCookiePresence(firstCookie, reentry);
    expect(reentry.snapshot.viewer).toMatchObject({
      participantId: first.snapshot.viewer.participantId,
      displayName: 'Peer 1',
    });

    const takeoverResponse = await worker.fetch(
      jsonRequest('/presence/enter', 'POST', { takeover: true }, firstCookie),
    );
    const takeover = await responseJson(takeoverResponse);
    bindCookiePresence(firstCookie, takeover);
    expect(takeover.snapshot.viewer).toMatchObject({
      participantId: first.snapshot.viewer.participantId,
      displayName: 'Peer 1',
    });
    expect(takeover.snapshot.viewer.presenceIncarnationId).not.toBe(
      reentry.snapshot.viewer.presenceIncarnationId,
    );
  });

  it('restarts physical display ordering at one after an empty presence epoch', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const devices: Array<{ cookie: string; participantId: string }> = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await worker.fetch(jsonRequest('/sessions', 'POST', { pin: '12345678' }));
      const envelope = await responseJson(response);
      const cookie = cookieFrom(response);
      bindCookiePresence(cookie, envelope);
      devices.push({ cookie, participantId: envelope.snapshot.viewer.participantId });
    }
    for (const cookie of [ownerCookie, ...devices.map((device) => device.cookie)]) {
      const leave = await worker.fetch(request('/presence/current', { method: 'DELETE' }, cookie));
      expect(leave.status).toBe(200);
    }

    // The newest durable cookie used to retain Peer 3 (and production rooms
    // could reach #12+). Empty presence is a new visible ordering epoch.
    const firstReturnResponse = await worker.fetch(
      request('/presence/enter', { method: 'POST' }, devices[2]!.cookie),
    );
    const firstReturn = await responseJson(firstReturnResponse);
    bindCookiePresence(devices[2]!.cookie, firstReturn);
    expect(firstReturn.snapshot.viewer).toMatchObject({
      participantId: devices[2]!.participantId,
      displayName: 'Peer 1',
    });

    const secondReturnResponse = await worker.fetch(
      request('/presence/enter', { method: 'POST' }, devices[0]!.cookie),
    );
    const secondReturn = await responseJson(secondReturnResponse);
    bindCookiePresence(devices[0]!.cookie, secondReturn);
    expect(secondReturn.snapshot.viewer).toMatchObject({
      participantId: devices[0]!.participantId,
      displayName: 'Peer 2',
    });
  });

  it('preserves same-account grouping while restarting an empty presence epoch at one', async () => {
    const context = await activatedRoom();
    const internal = context.worker as unknown as { env: Record<string, string> };
    internal.env.PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION = '1';
    const accountId = 'acct_epochgroup0123456789AB';
    const accountDevices: Array<{ cookie: string; participantId: string }> = [];
    for (let index = 0; index < 2; index += 1) {
      const response = await context.worker.fetch(
        await withAccountAssertion(
          jsonRequest('/sessions', 'POST', { pin: '12345678' }),
          accountId,
          'Minsu',
        ),
      );
      const envelope = await responseJson(response);
      const cookie = cookieFrom(response);
      bindCookiePresence(cookie, envelope);
      accountDevices.push({ cookie, participantId: envelope.snapshot.viewer.participantId });
    }
    const anonymousResponse = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const anonymous = await responseJson(anonymousResponse);
    const anonymousCookie = cookieFrom(anonymousResponse);
    bindCookiePresence(anonymousCookie, anonymous);

    for (const cookie of [
      context.ownerCookie,
      ...accountDevices.map((device) => device.cookie),
      anonymousCookie,
    ]) {
      expect(
        (await context.worker.fetch(request('/presence/current', { method: 'DELETE' }, cookie)))
          .status,
      ).toBe(200);
    }

    for (const device of [accountDevices[1]!, accountDevices[0]!]) {
      const response = await context.worker.fetch(
        request('/presence/enter', { method: 'POST' }, device.cookie),
      );
      const envelope = await responseJson(response);
      bindCookiePresence(device.cookie, envelope);
    }
    const grouped = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, accountDevices[0]!.cookie)),
    );
    expect(grouped.snapshot.viewer).toMatchObject({
      memberDisplayNumber: 1,
      displayName: 'Minsu',
    });
    const accountParticipants = grouped.snapshot.presence.participants.filter(
      (participant: Record<string, unknown>) =>
        participant.memberId === grouped.snapshot.viewer.memberId,
    );
    expect(accountParticipants).toHaveLength(2);
    expect(
      new Set(accountParticipants.map((participant: any) => participant.memberDisplayNumber)),
    ).toEqual(new Set([1]));

    const anonymousReturnResponse = await context.worker.fetch(
      request('/presence/enter', { method: 'POST' }, anonymousCookie),
    );
    const anonymousReturn = await responseJson(anonymousReturnResponse);
    bindCookiePresence(anonymousCookie, anonymousReturn);
    expect(anonymousReturn.snapshot.viewer).toMatchObject({
      displayName: 'Peer 3',
      memberDisplayNumber: 3,
    });
  });

  it('keeps account rows unique when the representative device leaves before another account joins', async () => {
    const context = await activatedRoom();
    const internal = context.worker as unknown as {
      env: Record<string, string>;
      room: Record<string, any>;
    };
    internal.env.PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION = '1';
    const firstAccountId = 'acct_0123456789abcdefghijkl';
    const secondAccountId = 'acct_abcdefghijkl0123456789';

    const createAccountDevice = async (accountId: string, nickname: string) => {
      const response = await context.worker.fetch(
        await withAccountAssertion(
          jsonRequest('/sessions', 'POST', { pin: '12345678' }),
          accountId,
          nickname,
        ),
      );
      expect(response.status).toBe(200);
      const envelope = await responseJson(response);
      const cookie = cookieFrom(response);
      bindCookiePresence(cookie, envelope);
      return { cookie, envelope };
    };

    const firstDevice = await createAccountDevice(firstAccountId, 'Minsu');
    const remainingDevice = await createAccountDevice(firstAccountId, 'Minsu');
    expect(firstDevice.envelope.snapshot.viewer.memberDisplayNumber).toBe(1);
    expect(remainingDevice.envelope.snapshot.viewer.memberDisplayNumber).toBe(1);

    expect(
      (
        await context.worker.fetch(
          request('/presence/current', { method: 'DELETE' }, firstDevice.cookie),
        )
      ).status,
    ).toBe(200);

    const nextAccount = await createAccountDevice(secondAccountId, 'Jisu');
    expect(nextAccount.envelope.snapshot.viewer.memberDisplayNumber).toBe(2);

    const snapshot = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, remainingDevice.cookie)),
    );
    const memberRows = snapshot.snapshot.presence.participants
      .filter((participant: Record<string, unknown>) => participant.role !== 'owner')
      .map((participant: Record<string, unknown>) => participant.memberDisplayNumber);
    expect(memberRows).toEqual([1, 2]);

    const remainingSession = Object.values(internal.room.sessions).find(
      (session: any) =>
        session.participantId === remainingDevice.envelope.snapshot.viewer.participantId,
    ) as any;
    const nextAccountSession = Object.values(internal.room.sessions).find(
      (session: any) =>
        session.participantId === nextAccount.envelope.snapshot.viewer.participantId,
    ) as any;
    expect(remainingSession.peerOrdinal).toBe(1);
    expect(nextAccountSession.peerOrdinal).toBe(2);
  });

  it('allocates consecutive server-owned Peer names', async () => {
    const { worker } = await activatedRoom();
    const firstResponse = await worker.fetch(jsonRequest('/sessions', 'POST', { pin: '12345678' }));
    const first = await responseJson(firstResponse);
    expect(first.snapshot.viewer.displayName).toBe('Peer 1');

    const claimedNumberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const claimedNumber = await responseJson(claimedNumberResponse);
    expect(claimedNumber.snapshot.viewer.displayName).toBe('Peer 2');
  });

  it('fences and persists a stored anonymous identity migration across restart', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const memberResponse = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const memberCookie = cookieFrom(memberResponse);
    const member = await responseJson(memberResponse);
    bindCookiePresence(memberCookie, member);
    const participantId = member.snapshot.viewer.participantId as string;
    const memberId = member.snapshot.viewer.memberId as string;
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${memberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    const known = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, memberCookie)),
    );
    const internal = context.worker as unknown as {
      room: {
        sessions: Record<
          string,
          {
            participantId: string;
            displayName: string;
            memberDisplayNumber: number;
            peerOrdinal?: number;
          }
        >;
        anonymousAdministrators: Record<string, { displayName: string; displayNumber: number }>;
        presence: {
          participants: Record<string, { displayName: string; memberDisplayNumber: number }>;
        };
      };
      persist(): Promise<void>;
    };
    const legacySession = Object.values(internal.room.sessions).find(
      (session) => session.participantId === participantId,
    );
    expect(legacySession).toBeDefined();
    legacySession!.displayName = 'Legacy Tablet';
    delete legacySession!.peerOrdinal;
    internal.room.presence.participants[participantId]!.displayName = 'Legacy Tablet';
    internal.room.anonymousAdministrators[memberId]!.displayName = 'Legacy Tablet';
    await internal.persist();

    const restartedEnv = environment(context.bucket) as ReturnType<typeof environment> & {
      PRO_ROOM_MEMBER_AUTHORITY_PROJECTION: string;
    };
    restartedEnv.PRO_ROOM_MEMBER_AUTHORITY_PROJECTION = '1';
    const restarted = new MusixquareProRoom(context.state as never, restartedEnv as never);
    const migratedResponse = await restarted.fetch(
      jsonRequest(
        '/presence/heartbeat',
        'POST',
        {
          revision: known.snapshot.revision,
          playlistRevision: known.snapshot.playlistRevision,
          presenceRevision: known.snapshot.presence.revision,
          playbackRevision: known.snapshot.playback.revision,
          coordinatorEpoch: known.snapshot.presence.coordinatorEpoch,
        },
        memberCookie,
      ),
    );
    expect(migratedResponse.status).toBe(200);
    const migrated = await responseJson(migratedResponse);
    expect(migrated.snapshot.viewer.displayName).toBe('Peer 1');
    expect(migrated.snapshot.presence.participants).toContainEqual(
      expect.objectContaining({ participantId, displayName: 'Peer 1' }),
    );
    expect(migrated.snapshot.revision).toBe(known.snapshot.revision + 1);
    expect(migrated.snapshot.presence.revision).toBe(known.snapshot.presence.revision + 1);
    const restartedInternal = restarted as unknown as { room: Record<string, any> };
    const migratedSession = Object.values(restartedInternal.room.sessions).find(
      (session: any) => session.participantId === participantId,
    );
    expect(migratedSession).toMatchObject({
      displayName: 'Peer 1',
      memberDisplayNumber: 1,
      peerOrdinal: 1,
    });
    expect(restartedInternal.room.anonymousAdministrators[memberId]).toMatchObject({
      displayName: 'Peer 1',
      displayNumber: 1,
    });
    const storedCore = context.state.storage.data.get('pro-room:v2:core') as Record<string, any>;
    expect(storedCore.core.sessions).toEqual(restartedInternal.room.sessions);
    expect(storedCore.core.presence.revision).toBe(known.snapshot.presence.revision + 1);
  });

  it('repairs a duplicated stored Peer ordinal and its visible name on heartbeat', async () => {
    const { worker } = await activatedRoom();
    const firstResponse = await worker.fetch(jsonRequest('/sessions', 'POST', { pin: '12345678' }));
    const firstCookie = cookieFrom(firstResponse);
    bindCookiePresence(firstCookie, await responseJson(firstResponse));
    const secondResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const secondCookie = cookieFrom(secondResponse);
    const second = await responseJson(secondResponse);
    bindCookiePresence(secondCookie, second);
    const secondParticipantId = second.snapshot.viewer.participantId as string;
    const internal = worker as unknown as {
      room: {
        sessions: Record<
          string,
          { participantId: string; displayName: string; peerOrdinal?: number }
        >;
        presence: { participants: Record<string, { displayName: string }> };
      };
    };
    const secondSession = Object.values(internal.room.sessions).find(
      (session) => session.participantId === secondParticipantId,
    );
    expect(secondSession).toBeDefined();
    secondSession!.peerOrdinal = 1;
    secondSession!.displayName = 'Peer 1';
    internal.room.presence.participants[secondParticipantId]!.displayName = 'Peer 1';

    const repairedResponse = await worker.fetch(
      jsonRequest(
        '/presence/heartbeat',
        'POST',
        {
          revision: second.snapshot.revision,
          playlistRevision: second.snapshot.playlistRevision,
          presenceRevision: second.snapshot.presence.revision,
          playbackRevision: second.snapshot.playback.revision,
          coordinatorEpoch: second.snapshot.presence.coordinatorEpoch,
        },
        secondCookie,
      ),
    );
    const repaired = await responseJson(repairedResponse);
    expect(repaired.snapshot.viewer.displayName).toBe('Peer 2');
    expect(secondSession).toMatchObject({ displayName: 'Peer 2', peerOrdinal: 2 });
    expect(repaired.snapshot.presence.participants).toContainEqual(
      expect.objectContaining({ participantId: secondParticipantId, displayName: 'Peer 2' }),
    );
  });

  it('rolls back every anonymous and account identity field when revisions are exhausted', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const anonymousResponse = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const anonymous = await responseJson(anonymousResponse);
    const anonymousCookie = cookieFrom(anonymousResponse);
    bindCookiePresence(anonymousCookie, anonymous);
    const anonymousMemberId = anonymous.snapshot.viewer.memberId as string;
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            `/administrators/${anonymousMemberId}`,
            'PUT',
            { permissions: fullDelegatedPermissions },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);

    const accountId = 'acct_rollbackacct0123456789';
    const accountResponse = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/sessions', 'POST', { pin: '12345678' }),
        accountId,
        'Rollback account',
      ),
    );
    const account = await responseJson(accountResponse);
    const accountCookie = cookieFrom(accountResponse);
    bindCookiePresence(accountCookie, account);

    const internal = context.worker as unknown as {
      room: Record<string, any>;
      handleHeartbeat(request: Request): Promise<Response>;
    };
    const anonymousParticipantId = anonymous.snapshot.viewer.participantId as string;
    const accountParticipantId = account.snapshot.viewer.participantId as string;
    const anonymousParticipant = internal.room.presence.participants[anonymousParticipantId];
    const accountParticipant = internal.room.presence.participants[accountParticipantId];
    const anonymousSession = internal.room.sessions[anonymousParticipant.sessionHash];
    const accountSession = internal.room.sessions[accountParticipant.sessionHash];
    delete anonymousSession.peerOrdinal;
    anonymousSession.displayName = 'Legacy controller';
    anonymousSession.memberDisplayNumber = 7;
    anonymousParticipant.displayName = 'Legacy controller';
    anonymousParticipant.memberDisplayNumber = 7;
    internal.room.anonymousAdministrators[anonymousMemberId].displayName = 'Legacy controller';
    internal.room.anonymousAdministrators[anonymousMemberId].displayNumber = 7;
    delete accountSession.peerOrdinal;
    accountSession.memberDisplayNumber = 8;
    accountParticipant.memberDisplayNumber = 8;
    internal.room.accountMembers[accountId].displayNumber = 8;
    internal.room.revision = Number.MAX_SAFE_INTEGER;
    internal.room.presence.revision = Number.MAX_SAFE_INTEGER;

    const anonymousBefore = structuredClone({
      session: anonymousSession,
      participant: anonymousParticipant,
      administrator: internal.room.anonymousAdministrators[anonymousMemberId],
    });
    const accountBefore = structuredClone({
      session: accountSession,
      participant: accountParticipant,
      member: internal.room.accountMembers[accountId],
    });
    const heartbeatBody = {
      revision: Number.MAX_SAFE_INTEGER,
      playlistRevision: internal.room.playlistRevision,
      presenceRevision: Number.MAX_SAFE_INTEGER,
      playbackRevision: internal.room.playback.revision,
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
    };

    // Public fetches normalize account projections before dispatch. Call the
    // handler seam directly so its defensive account rollback branch actually mutates.
    const accountHeartbeat = await internal.handleHeartbeat(
      jsonRequest('/presence/heartbeat', 'POST', heartbeatBody, accountCookie),
    );
    expect(accountHeartbeat.status).toBe(409);
    expect(await responseJson(accountHeartbeat)).toEqual({ error: 'REVISION_EXHAUSTED' });
    expect({
      session: accountSession,
      participant: accountParticipant,
      member: internal.room.accountMembers[accountId],
    }).toEqual(accountBefore);

    const anonymousHeartbeat = await context.worker.fetch(
      jsonRequest('/presence/heartbeat', 'POST', heartbeatBody, anonymousCookie),
    );
    expect(anonymousHeartbeat.status).toBe(409);
    expect(await responseJson(anonymousHeartbeat)).toEqual({ error: 'REVISION_EXHAUSTED' });
    expect({
      session: anonymousSession,
      participant: anonymousParticipant,
      administrator: internal.room.anonymousAdministrators[anonymousMemberId],
    }).toEqual(anonymousBefore);
    expect(internal.room.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(internal.room.presence.revision).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('redeems a short-lived owner recovery claim once and revokes prior owner credentials', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const { worker, ownerCookie } = context;
    const recoveryAccountId = 'acct_recoverowner0123456789';
    const controllerResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const controllerCookie = cookieFrom(controllerResponse);
    bindCookiePresence(controllerCookie, await responseJson(controllerResponse));
    const nowMs = Date.now();
    const wrongRoomClaim = await issueProRoomOwnerRecoveryClaim('000000', ACTIVATION_SECRET, {
      nowMs: nowMs - 1_000,
      expiresAtMs: nowMs + 60_000,
      nonce: 'wrong-room-recovery-nonce',
    });
    const wrongRoom = await worker.fetch(
      await withAccountAssertion(
        jsonRequest('/owner-recovery', 'POST', { claimToken: wrongRoomClaim }),
        recoveryAccountId,
        'Recovered owner',
      ),
    );
    expect(wrongRoom.status).toBe(401);
    expect(await responseJson(wrongRoom)).toEqual({ error: 'RECOVERY_INVALID' });
    await expect(
      issueProRoomOwnerRecoveryClaim(ROOM_CODE, ACTIVATION_SECRET, {
        nowMs,
        expiresAtMs: nowMs + 16 * 60_000,
        nonce: 'too-long-recovery-nonce',
      }),
    ).rejects.toThrow('Invalid expiry');
    const claimToken = await issueProRoomOwnerRecoveryClaim(ROOM_CODE, ACTIVATION_SECRET, {
      nowMs: nowMs - 1_000,
      expiresAtMs: nowMs + 60_000,
      nonce: 'fixed-owner-recovery-nonce',
    });
    const internal = worker as unknown as { room: Record<string, any> };
    const originalOwnerCredentialHash = internal.room.ownerCredentialHash;
    const rejectedLegacyRecovery = await worker.fetch(
      await withAccountAssertion(
        jsonRequest('/owner-recovery', 'POST', {
          claimToken,
          displayName: 'Legacy recovered device',
        }),
        recoveryAccountId,
        'Recovered owner',
      ),
    );
    expect(rejectedLegacyRecovery.status).toBe(400);
    expect(await responseJson(rejectedLegacyRecovery)).toEqual({ error: 'INVALID_REQUEST' });
    expect(internal.room.consumedRecoveryNonces).toEqual({});
    const anonymous = await worker.fetch(jsonRequest('/owner-recovery', 'POST', { claimToken }));
    expect(anonymous.status).toBe(401);
    expect(await responseJson(anonymous)).toEqual({ error: 'ACCOUNT_SESSION_REQUIRED' });
    expect(internal.room.ownerAccountId).toBeNull();
    expect(internal.room.ownerCredentialHash).toBe(originalOwnerCredentialHash);
    expect(internal.room.consumedRecoveryNonces).toEqual({});
    expect((await worker.fetch(request('/snapshot', {}, ownerCookie))).status).toBe(200);

    const recovered = await worker.fetch(
      await withAccountAssertion(
        jsonRequest('/owner-recovery', 'POST', { claimToken }),
        recoveryAccountId,
        'Recovered owner',
      ),
    );
    expect(recovered.status).toBe(200);
    const recoveryEnvelope = await responseJson(recovered);
    expect(recoveryEnvelope.snapshot.viewer).toMatchObject({
      role: 'owner',
      isAuthenticated: true,
      displayName: 'Recovered owner',
    });
    expect(recovered.headers.getSetCookie()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^__Host-mxqr_pro_session_000001=/),
        expect.stringMatching(/^__Host-mxqr_pro_owner_000001=/),
      ]),
    );
    expect((await worker.fetch(request('/snapshot', {}, ownerCookie))).status).toBe(401);
    expect((await worker.fetch(request('/snapshot', {}, controllerCookie))).status).toBe(200);

    const replay = await worker.fetch(
      await withAccountAssertion(
        jsonRequest('/owner-recovery', 'POST', { claimToken }),
        recoveryAccountId,
        'Recovered owner',
      ),
    );
    expect(replay.status).toBe(409);
    expect(await responseJson(replay)).toEqual({ error: 'RECOVERY_CLAIM_USED' });
  });

  it('promotes a signed-in member account through recovery without leaving a ghost device', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const accountId = 'acct_abcdefghijkl0123456789';
    const joinDevice = async () => {
      const response = await context.worker.fetch(
        await withAccountAssertion(
          jsonRequest('/sessions', 'POST', { pin: '12345678' }),
          accountId,
          'Room owner',
        ),
      );
      expect(response.status).toBe(200);
      const envelope = await responseJson(response);
      const cookie = cookieFrom(response);
      bindCookiePresence(cookie, envelope);
      return { cookie, envelope };
    };
    const first = await joinDevice();
    const second = await joinDevice();
    expect(first.envelope.snapshot.viewer.role).toBe('member');
    expect(second.envelope.snapshot.presence.participants).toHaveLength(3);

    const nowMs = Date.now();
    const claimToken = await issueProRoomOwnerRecoveryClaim(ROOM_CODE, ACTIVATION_SECRET, {
      nowMs: nowMs - 1_000,
      expiresAtMs: nowMs + 60_000,
      nonce: 'signed-in-member-recovery-nonce',
    });
    const recovered = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/owner-recovery', 'POST', { claimToken }, first.cookie),
        accountId,
        'Room owner',
      ),
    );
    expect(recovered.status).toBe(200);
    const recoveryEnvelope = await responseJson(recovered);
    expect(recoveryEnvelope.snapshot.viewer).toMatchObject({
      role: 'owner',
      isAuthenticated: true,
      memberDisplayNumber: 0,
      displayName: 'Room owner',
    });
    expect(recoveryEnvelope.snapshot.presence.participants).toHaveLength(2);
    expect(
      recoveryEnvelope.snapshot.presence.participants.every(
        (participant: Record<string, unknown>) => participant.role === 'owner',
      ),
    ).toBe(true);
    expect((await context.worker.fetch(request('/snapshot', {}, first.cookie))).status).toBe(401);
    const secondDevice = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, second.cookie)),
    );
    expect(secondDevice.snapshot.viewer).toMatchObject({
      role: 'owner',
      isAuthenticated: true,
      memberDisplayNumber: 0,
    });
    expect((await context.worker.fetch(request('/snapshot', {}, context.ownerCookie))).status).toBe(
      401,
    );
    const internal = context.worker as unknown as { room: Record<string, any> };
    expect(internal.room.ownerAccountId).toBe(accountId);
    expect(
      Object.values(internal.room.sessions).filter(
        (session: any) => session.accountId === accountId,
      ),
    ).toHaveLength(2);
  });

  it('does not recover an account-bound owner as a different signed-in account', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const ownerAccountId = 'acct_abcdefghijkl0123456789';
    const foreignAccountId = 'acct_ZYXWVUTSRQPO9876543210';
    const attached = await context.worker.fetch(
      await withAccountAssertion(
        request('/sessions/current/account', { method: 'POST' }, context.ownerCookie),
        ownerAccountId,
        'Original owner',
      ),
    );
    expect(attached.status).toBe(200);
    const nowMs = Date.now();
    const claimToken = await issueProRoomOwnerRecoveryClaim(ROOM_CODE, ACTIVATION_SECRET, {
      nowMs: nowMs - 1_000,
      expiresAtMs: nowMs + 60_000,
      nonce: 'foreign-account-recovery-nonce',
    });

    const invalidClaim = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/owner-recovery', 'POST', { claimToken: 'not-a-recovery-claim' }),
        foreignAccountId,
        'Foreign owner',
      ),
    );
    expect(invalidClaim.status).toBe(401);
    expect(await responseJson(invalidClaim)).toEqual({ error: 'RECOVERY_INVALID' });

    const rejected = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/owner-recovery', 'POST', { claimToken }),
        foreignAccountId,
        'Foreign owner',
      ),
    );

    expect(rejected.status).toBe(409);
    expect(await responseJson(rejected)).toEqual({ error: 'OWNER_ACCOUNT_LINK_CONFLICT' });
    expect((await context.worker.fetch(request('/snapshot', {}, context.ownerCookie))).status).toBe(
      200,
    );
    const internal = context.worker as unknown as { room: Record<string, any> };
    expect(internal.room.ownerAccountId).toBe(ownerAccountId);
    expect(internal.room.accountMembers[foreignAccountId]).toBeUndefined();
    expect(internal.room.consumedRecoveryNonces).toEqual({});

    const recoveredByLinkedAccount = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/owner-recovery', 'POST', { claimToken }, context.ownerCookie),
        ownerAccountId,
        'Original owner',
      ),
    );
    expect(recoveredByLinkedAccount.status).toBe(200);
    await expect(recoveredByLinkedAccount.json()).resolves.toMatchObject({
      snapshot: {
        viewer: { role: 'owner', isAuthenticated: true, displayName: 'Original owner' },
      },
    });
  });

  it('leaves the claim and existing owner untouched when owner account capacity is full', async () => {
    const context = await activatedRoom();
    enableMemberAuthority(context);
    const internal = context.worker as unknown as { room: Record<string, any> };
    const nowMs = Date.now();
    for (let index = 1; index <= 100; index += 1) {
      const accountId = `acct_cap${String(index).padStart(19, '0')}`;
      internal.room.accountMembers[accountId] = {
        memberId: `member_capacity_${String(index).padStart(3, '0')}`,
        displayName: `Capacity member ${index}`,
        displayNumber: index,
        role: 'member',
        permissions: {
          'media.add': false,
          'playback.control': false,
          'members.kick': false,
          'chat.notice': false,
        },
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
    }
    const ownerCredentialHash = internal.room.ownerCredentialHash;
    const ownerSessionCount = Object.values(internal.room.sessions).filter(
      (session: any) => session.role === 'owner',
    ).length;
    const claimToken = await issueProRoomOwnerRecoveryClaim(ROOM_CODE, ACTIVATION_SECRET, {
      nowMs: nowMs - 1_000,
      expiresAtMs: nowMs + 60_000,
      nonce: 'account-capacity-recovery-nonce',
    });
    const accountId = 'acct_capacitytarg0123456789';
    const rejected = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/owner-recovery', 'POST', { claimToken }),
        accountId,
        'Capacity target',
      ),
    );
    expect(rejected.status).toBe(409);
    expect(await responseJson(rejected)).toEqual({
      error: 'ACCOUNT_MEMBER_CAPACITY_EXCEEDED',
    });
    expect(internal.room.ownerAccountId).toBeNull();
    expect(internal.room.ownerCredentialHash).toBe(ownerCredentialHash);
    expect(internal.room.accountMembers[accountId]).toBeUndefined();
    expect(internal.room.consumedRecoveryNonces).toEqual({});
    expect(
      Object.values(internal.room.sessions).filter((session: any) => session.role === 'owner'),
    ).toHaveLength(ownerSessionCount);
    expect((await context.worker.fetch(request('/snapshot', {}, context.ownerCookie))).status).toBe(
      200,
    );

    delete internal.room.accountMembers.acct_cap0000000000000000100;
    const recovered = await context.worker.fetch(
      await withAccountAssertion(
        jsonRequest('/owner-recovery', 'POST', { claimToken }),
        accountId,
        'Capacity target',
      ),
    );
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      snapshot: { viewer: { role: 'owner', isAuthenticated: true } },
    });
  });

  it('revokes controller sessions on owner PIN rotation while retaining the owner session', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const controller = await worker.fetch(jsonRequest('/sessions', 'POST', { pin: '12345678' }));
    expect(controller.status).toBe(200);
    const controllerCookie = cookieFrom(controller);
    expect(controllerCookie).toMatch(/^__Host-mxqr_pro_session_000001=/);
    expect(controller.headers.get('set-cookie')).not.toMatch(/Domain=/i);
    const sessionEnvelope = await responseJson(controller);
    bindCookiePresence(controllerCookie, sessionEnvelope);
    expect(Object.keys(sessionEnvelope)).toEqual(['snapshot', 'session']);
    expect(Object.keys(sessionEnvelope.session)).toEqual(['expiresAtMs']);
    expect(sessionEnvelope.snapshot.viewer).toMatchObject({
      role: 'controller',
      capabilities: [
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'members.manage',
      ],
    });
    expect(sessionEnvelope.snapshot.viewer.capabilities).not.toContain('room.configure');
    const epochBeforeRotation = sessionEnvelope.snapshot.presence.coordinatorEpoch as number;

    const rotate = await worker.fetch(
      jsonRequest('/pin', 'POST', { pin: '87654321' }, ownerCookie),
    );
    expect(await responseJson(rotate)).toEqual({ ok: true });
    const ownerAfterRotationResponse = await worker.fetch(request('/snapshot', {}, ownerCookie));
    expect(ownerAfterRotationResponse.status).toBe(200);
    const ownerAfterRotation = await responseJson(ownerAfterRotationResponse);
    expect(ownerAfterRotation.snapshot.presence.coordinatorEpoch).toBe(epochBeforeRotation + 1);
    expect(ownerAfterRotation.snapshot.presence.coordinatorParticipantId).toBeNull();
    expect((await worker.fetch(request('/snapshot', {}, controllerCookie))).status).toBe(401);

    const oldPin = await worker.fetch(jsonRequest('/sessions', 'POST', { pin: '12345678' }));
    const newPin = await worker.fetch(jsonRequest('/sessions', 'POST', { pin: '87654321' }));
    expect(oldPin.status).toBe(401);
    expect(newPin.status).toBe(200);
  });

  it('bulk-revokes multiple controllers with exactly one PIN security epoch advance', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const firstMemberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const firstMemberCookie = cookieFrom(firstMemberResponse);
    bindCookiePresence(firstMemberCookie, await responseJson(firstMemberResponse));
    const secondMemberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const secondMemberCookie = cookieFrom(secondMemberResponse);
    bindCookiePresence(secondMemberCookie, await responseJson(secondMemberResponse));

    const leaveOwner = await worker.fetch(
      request('/presence/current', { method: 'DELETE' }, ownerCookie),
    );
    expect(leaveOwner.status).toBe(200);
    const memberAfterOwnerLeave = await responseJson(
      await worker.fetch(request('/snapshot', {}, firstMemberCookie)),
    );
    expect(memberAfterOwnerLeave.snapshot.presence.coordinatorParticipantId).toBeNull();

    const ownerReentryResponse = await worker.fetch(
      request('/presence/enter', { method: 'POST' }, ownerCookie),
    );
    expect(ownerReentryResponse.status).toBe(200);
    const ownerReentry = await responseJson(ownerReentryResponse);
    bindCookiePresence(ownerCookie, ownerReentry);
    const epochBeforeRotation = ownerReentry.snapshot.presence.coordinatorEpoch as number;
    const presenceRevisionBeforeRotation = ownerReentry.snapshot.presence.revision as number;
    const playbackRevisionBeforeRotation = ownerReentry.snapshot.playback.revision as number;
    expect(ownerReentry.snapshot.presence.participants).toHaveLength(3);
    expect(ownerReentry.snapshot.presence.coordinatorParticipantId).toBeNull();

    const rotate = await worker.fetch(
      jsonRequest('/pin', 'POST', { pin: '87654321' }, ownerCookie),
    );
    expect(rotate.status).toBe(200);
    const ownerAfterRotation = await responseJson(
      await worker.fetch(request('/snapshot', {}, ownerCookie)),
    );
    expect(ownerAfterRotation.snapshot.presence.coordinatorEpoch).toBe(epochBeforeRotation + 1);
    expect(ownerAfterRotation.snapshot.presence.coordinatorParticipantId).toBeNull();
    expect(ownerAfterRotation.snapshot.presence.participants).toEqual([
      expect.objectContaining({ participantId: ownerAfterRotation.snapshot.viewer.participantId }),
    ]);
    expect(ownerAfterRotation.snapshot.presence.revision).toBe(presenceRevisionBeforeRotation + 1);
    expect(ownerAfterRotation.snapshot.playback).toMatchObject({
      coordinatorEpoch: epochBeforeRotation + 1,
      revision: playbackRevisionBeforeRotation + 1,
    });
    expect(ownerAfterRotation.snapshot.runtime).toBe('awake');
    expect((await worker.fetch(request('/snapshot', {}, firstMemberCookie))).status).toBe(401);
    expect((await worker.fetch(request('/snapshot', {}, secondMemberCookie))).status).toBe(401);
  });

  it('charges the IP limiter only for failed PIN verification', async () => {
    const { worker } = await activatedRoom();
    for (let index = 0; index < 10; index += 1) {
      const failedRequest = jsonRequest('/sessions', 'POST', {
        pin: '99999999',
      });
      failedRequest.headers.set('x-mxqr-pro-ip-hash', 'failed-pin-address');
      expect((await worker.fetch(failedRequest)).status).toBe(401);
    }
    const blockedRequest = jsonRequest('/sessions', 'POST', {
      pin: '99999999',
    });
    blockedRequest.headers.set('x-mxqr-pro-ip-hash', 'failed-pin-address');
    const blocked = await worker.fetch(blockedRequest);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/);

    const validOtherAddress = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    expect(validOtherAddress.status).toBe(200);
  });

  it('freezes an empty room, wakes on return, and scopes member tickets to the room epoch', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const asleep = await worker.fetch(
      request('/presence/current', { method: 'DELETE' }, ownerCookie),
    );
    const asleepEnvelope = await responseJson(asleep);
    expect(Object.keys(asleepEnvelope)).toEqual(['snapshot']);
    expect(asleepEnvelope.snapshot).toMatchObject({
      runtime: 'sleeping',
      presence: { coordinatorParticipantId: null },
    });

    const rejectedHeartbeat = await worker.fetch(
      request('/presence/heartbeat', { method: 'POST' }, ownerCookie),
    );
    expect(rejectedHeartbeat.status).toBe(409);
    expect(await responseJson(rejectedHeartbeat)).toEqual({ error: 'PRESENCE_SUPERSEDED' });
    // Cloudflare can expose an application-level empty POST as a non-null body
    // stream. Treat the zero-byte transport body exactly like an absent body.
    const awake = await worker.fetch(
      request('/presence/enter', { method: 'POST', body: '' }, ownerCookie),
    );
    const awakeEnvelope = await responseJson(awake);
    bindCookiePresence(ownerCookie, awakeEnvelope);
    expect(Object.keys(awakeEnvelope)).toEqual(['snapshot']);
    const awakeSnapshot = awakeEnvelope.snapshot;
    expect(awakeSnapshot).toMatchObject({ runtime: 'awake', presence: { coordinatorEpoch: 3 } });

    const access = await worker.fetch(
      request('/signaling-tickets', { method: 'POST' }, ownerCookie),
    );
    const envelope = await responseJson(access);
    expect(Object.keys(envelope)).toEqual([
      'ticket',
      'expiresAtMs',
      'role',
      'coordinatorEpoch',
      'presenceIncarnationId',
      'ticketSequence',
      'pendingPlaybackTransition',
    ]);
    expect(envelope).toMatchObject({
      role: 'member',
      coordinatorEpoch: 3,
      pendingPlaybackTransition: null,
    });
    expect(envelope.ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(envelope.expiresAtMs).toBeGreaterThan(Date.now());
    const [payload] = String(envelope.ticket).split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(decoded)).toEqual([
      'v',
      'kind',
      'roomCode',
      'participantId',
      'memberId',
      'displayName',
      'role',
      'coordinatorEpoch',
      'presenceIncarnationId',
      'presenceRevision',
      'ticketSequence',
      'jti',
      'iat',
      'exp',
    ]);
    expect(decoded).toMatchObject({
      v: 1,
      kind: 'pro-signaling',
      roomCode: ROOM_CODE,
      displayName: 'Owner',
      role: 'member',
      coordinatorEpoch: 3,
      presenceIncarnationId: awakeSnapshot.viewer.presenceIncarnationId,
      presenceRevision: awakeSnapshot.presence.revision,
      ticketSequence: 1,
    });
    expect(decoded.memberId).toMatch(/^(?:member|owner)_[A-Za-z0-9_-]{16,128}$/);
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(90);
  });

  it('returns compact heartbeats and rejects client-authored identity fields', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const before = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const known = before.snapshot;
    const compact = await worker.fetch(
      jsonRequest(
        '/presence/heartbeat',
        'POST',
        {
          revision: known.revision,
          playlistRevision: known.playlistRevision,
          presenceRevision: known.presence.revision,
          playbackRevision: known.playback.revision,
          coordinatorEpoch: known.presence.coordinatorEpoch,
        },
        ownerCookie,
      ),
    );

    expect(compact.status).toBe(200);
    await expect(compact.json()).resolves.toEqual({
      notModified: true,
      revision: known.revision,
      playlistRevision: known.playlistRevision,
      presenceRevision: known.presence.revision,
      playbackRevision: known.playback.revision,
      coordinatorEpoch: known.presence.coordinatorEpoch,
    });

    const rejectedIdentity = await worker.fetch(
      jsonRequest(
        '/presence/heartbeat',
        'POST',
        {
          revision: known.revision,
          playlistRevision: known.playlistRevision,
          presenceRevision: known.presence.revision,
          playbackRevision: known.playback.revision,
          coordinatorEpoch: known.presence.coordinatorEpoch,
          displayName: 'Mix Room',
        },
        ownerCookie,
      ),
    );
    expect(rejectedIdentity.status).toBe(400);
    await expect(rejectedIdentity.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
    const unchanged = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    expect(unchanged.snapshot.viewer.displayName).toBe(known.viewer.displayName);
    expect(unchanged.snapshot.revision).toBe(known.revision);
    expect(unchanged.snapshot.presence.revision).toBe(known.presence.revision);

    const stale = await worker.fetch(
      jsonRequest(
        '/presence/heartbeat',
        'POST',
        {
          revision: known.revision + 1,
          playlistRevision: known.playlistRevision,
          presenceRevision: known.presence.revision,
          playbackRevision: known.playback.revision,
          coordinatorEpoch: known.presence.coordinatorEpoch,
        },
        ownerCookie,
      ),
    );
    expect(Object.keys(await responseJson(stale))).toEqual(['snapshot']);

    const bodyless = await worker.fetch(
      request('/presence/heartbeat', { method: 'POST' }, ownerCookie),
    );
    expect(Object.keys(await responseJson(bodyless))).toEqual(['snapshot']);
  });

  it('durably retries a presence snapshot after transient signaling failures and isolate restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T03:00:00.000Z'));
    const context = await activatedRoom();
    const dispatched: Array<Record<string, any>> = [];
    let signalingAvailable = false;
    const dispatchFetch = vi.fn(async (request: Request) => {
      dispatched.push((await request.json()) as Record<string, any>);
      return signalingAvailable
        ? Response.json({ broadcast: true, eligible: 2, sent: 2 })
        : Response.json({ error: 'temporary signaling outage' }, { status: 503 });
    });
    const signalingNamespace = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: dispatchFetch })),
    };
    const internal = context.worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    internal.env.PRO_SIGNALING_ROOMS = signalingNamespace;

    const memberResponse = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    expect(memberResponse.status).toBe(200);
    bindCookiePresence(cookieFrom(memberResponse), await responseJson(memberResponse));

    await vi.waitFor(() => expect(dispatchFetch).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(internal.room.pendingPresenceBroadcast).not.toBeNull());
    const firstRetry = structuredClone(internal.room.pendingPresenceBroadcast) as Record<
      string,
      number
    >;
    expect(firstRetry).toMatchObject({
      coordinatorEpoch: internal.room.presence.coordinatorEpoch,
      presenceRevision: internal.room.presence.revision,
      roomRevision: internal.room.revision,
      attempts: 0,
    });
    expect(firstRetry.retryAtMs).toBeGreaterThan(Date.now());
    expect(firstRetry.retryAtMs).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(context.state.storage.alarm).toBe(firstRetry.retryAtMs);
    expect(
      (context.state.storage.data.get('pro-room:v2:core') as Record<string, any>).core
        .pendingPresenceBroadcast,
    ).toEqual(firstRetry);

    const restarted = new MusixquareProRoom(
      context.state as never,
      {
        ...environment(context.bucket),
        PRO_SIGNALING_ROOMS: signalingNamespace,
      } as never,
    );
    const restartedInternal = restarted as unknown as {
      alarm(): Promise<void>;
      room: Record<string, any>;
    };
    vi.setSystemTime(firstRetry.retryAtMs);
    await restartedInternal.alarm();
    expect(dispatchFetch).toHaveBeenCalledTimes(4);
    const secondRetry = restartedInternal.room.pendingPresenceBroadcast as Record<string, number>;
    expect(secondRetry).toMatchObject({
      coordinatorEpoch: firstRetry.coordinatorEpoch,
      presenceRevision: firstRetry.presenceRevision,
      attempts: 1,
      retryAtMs: firstRetry.retryAtMs + 2_000,
    });
    expect(context.state.storage.alarm).toBe(secondRetry.retryAtMs);

    signalingAvailable = true;
    vi.setSystemTime(secondRetry.retryAtMs);
    await restartedInternal.alarm();
    expect(dispatchFetch).toHaveBeenCalledTimes(5);
    expect(restartedInternal.room.pendingPresenceBroadcast).toBeNull();
    expect(
      (context.state.storage.data.get('pro-room:v2:core') as Record<string, any>).core
        .pendingPresenceBroadcast,
    ).toBeNull();
    expect(dispatched.at(-1)).toMatchObject({
      coordinatorEpoch: firstRetry.coordinatorEpoch,
      targets: expect.arrayContaining(
        Object.values(restartedInternal.room.presence.participants).map(
          (participant: any) => participant.presenceIncarnationId,
        ),
      ),
      event: {
        type: 'pro-presence-snapshot',
        presenceRevision: firstRetry.presenceRevision,
        roomRevision: firstRetry.roomRevision,
      },
    });
  });

  it('checkpoints the legacy shadow and alarm without rewriting both on every heartbeat', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie } = await activatedRoom();
    const put = vi.spyOn(state.storage, 'put');
    const setAlarm = vi.spyOn(state.storage, 'setAlarm');

    await expect(
      worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie)),
    ).resolves.toMatchObject({ status: 200 });
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v1')).toHaveLength(0);
    expect(setAlarm).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_001);
    await expect(
      worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie)),
    ).resolves.toMatchObject({ status: 200 });
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v1')).toHaveLength(1);
    expect(setAlarm).not.toHaveBeenCalled();
  });

  it('persists the first heartbeat immediately and coalesces the other 99 into one write', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie } = await activatedRoom();
    const put = vi.spyOn(state.storage, 'put');
    const coreWrites = () => put.mock.calls.filter(([key]) => key === 'pro-room:v2:core').length;

    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie)),
      ),
    );
    expect(responses.every((response: Response) => response.status === 200)).toBe(true);
    expect(coreWrites()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(coreWrites()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(coreWrites()).toBe(2);
  });

  it('persists isolated heartbeats inline without creating non-hibernateable timers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie } = await activatedRoom();
    const put = vi.spyOn(state.storage, 'put');
    const coreWrites = () => put.mock.calls.filter(([key]) => key === 'pro-room:v2:core').length;

    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    expect(coreWrites()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(15_000);
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    expect(coreWrites()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes a dense second heartbeat at the first write window boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie } = await activatedRoom();
    const put = vi.spyOn(state.storage, 'put');
    const coreWrites = () => put.mock.calls.filter(([key]) => key === 'pro-room:v2:core').length;

    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    await vi.advanceTimersByTimeAsync(400);
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    expect(coreWrites()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(599);
    expect(coreWrites()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(coreWrites()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves each participant lease when different peers share a trailing flush', async () => {
    vi.useFakeTimers();
    const startedAtMs = new Date('2026-07-19T06:00:00.000Z').getTime();
    vi.setSystemTime(startedAtMs);
    const { worker, state, bucket, ownerCookie, activationEnvelope } = await activatedRoom();
    const ownerParticipantId = activationEnvelope.snapshot.viewer.participantId as string;
    const memberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const memberCookie = cookieFrom(memberResponse);
    const member = await responseJson(memberResponse);
    const memberParticipantId = member.snapshot.viewer.participantId as string;
    bindCookiePresence(memberCookie, member);
    const put = vi.spyOn(state.storage, 'put');

    await vi.advanceTimersByTimeAsync(100);
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    await vi.advanceTimersByTimeAsync(100);
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, memberCookie));
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(900);
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(2);
    const stored = state.storage.data.get('pro-room:v2:core') as Record<string, any>;
    expect(stored.core.presence.participants[ownerParticipantId].lastSeenAtMs).toBe(
      startedAtMs + 100,
    );
    expect(stored.core.presence.participants[memberParticipantId].lastSeenAtMs).toBe(
      startedAtMs + 200,
    );

    const restarted = new MusixquareProRoom(state as never, environment(bucket) as never);
    const snapshot = await responseJson(
      await restarted.fetch(request('/snapshot', {}, ownerCookie)),
    );
    expect(snapshot.snapshot.presence.participants).toHaveLength(2);
  });

  it('serializes an expired heartbeat timer behind an in-flight semantic mutation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie, activationEnvelope } = await activatedRoom();
    const internal = worker as unknown as {
      mutationTail: Promise<unknown>;
      pendingHeartbeatFlushGeneration: number | null;
    };
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    expect(internal.pendingHeartbeatFlushGeneration).not.toBeNull();

    const originalPut = state.storage.put.bind(state.storage);
    let releaseCoreWrite!: () => void;
    let reportBlocked!: () => void;
    const coreWriteGate = new Promise<void>((resolve) => {
      releaseCoreWrite = resolve;
    });
    const coreWriteBlocked = new Promise<void>((resolve) => {
      reportBlocked = resolve;
    });
    let blockNextCoreWrite = true;
    const put = vi.spyOn(state.storage, 'put').mockImplementation(async (key, value) => {
      if (key === 'pro-room:v2:core' && blockNextCoreWrite) {
        blockNextCoreWrite = false;
        reportBlocked();
        await coreWriteGate;
      }
      await originalPut(key, value);
    });
    const mutation = worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        {
          coordinatorEpoch: activationEnvelope.snapshot.presence.coordinatorEpoch,
          baseRevision: 0,
          effects: {
            reverb: {
              mixPercent: 15,
              decaySeconds: 2,
              preDelaySeconds: 0.02,
              lowCutPercent: 0,
              highCutPercent: 0,
            },
            equalizer: { bandsDb: [0, 0, 0, 0, 0] },
            virtualBass: { strengthPercent: 0 },
            virtualSurround: { widthPercent: 100 },
          },
        },
        ownerCookie,
      ),
    );
    await coreWriteBlocked;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(internal.pendingHeartbeatFlushGeneration).not.toBeNull();
    releaseCoreWrite();
    await expect(mutation).resolves.toMatchObject({ status: 200 });
    await internal.mutationTail;

    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(1);
    expect(internal.pendingHeartbeatFlushGeneration).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers a lost deferred timer before the prior lease can expire after restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, bucket, ownerCookie, activationEnvelope } = await activatedRoom();
    const ownerParticipantId = activationEnvelope.snapshot.viewer.participantId as string;
    const memberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const memberCookie = cookieFrom(memberResponse);
    bindCookiePresence(memberCookie, await responseJson(memberResponse));
    const internal = worker as unknown as {
      invalidatePendingHeartbeatFlush(): void;
      pendingHeartbeatFlushGeneration: number | null;
    };
    const put = vi.spyOn(state.storage, 'put');

    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    await vi.advanceTimersByTimeAsync(27_999);
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, memberCookie));
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    expect(internal.pendingHeartbeatFlushGeneration).not.toBeNull();
    internal.invalidatePendingHeartbeatFlush();
    expect(vi.getTimerCount()).toBe(0);

    const restarted = new MusixquareProRoom(state as never, environment(bucket) as never);
    const restartedInternal = restarted as unknown as { alarm(): Promise<void> };
    await vi.advanceTimersByTimeAsync(15_000);
    await restartedInternal.alarm();
    const beforeRecovery = await responseJson(
      await restarted.fetch(request('/snapshot', {}, memberCookie)),
    );
    expect(beforeRecovery.snapshot.presence.participants).toHaveLength(2);
    await restarted.fetch(request('/presence/heartbeat', { method: 'POST' }, memberCookie));
    await expect(
      restarted.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie)),
    ).resolves.toMatchObject({ status: 200 });
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
    const stored = state.storage.data.get('pro-room:v2:core') as Record<string, any>;
    expect(stored.core.presence.participants[ownerParticipantId].lastSeenAtMs).toBe(Date.now());
    const snapshot = await responseJson(
      await restarted.fetch(request('/snapshot', {}, ownerCookie)),
    );
    expect(snapshot.snapshot.presence.participants).toHaveLength(2);
  });

  it('lets an immediate mutation absorb pending heartbeat durability and fences its old timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie, activationEnvelope } = await activatedRoom();
    const internal = worker as unknown as {
      flushHeartbeatDurability(generation: number): Promise<void>;
      pendingHeartbeatFlushGeneration: number | null;
    };
    const put = vi.spyOn(state.storage, 'put');
    const coreWrites = () => put.mock.calls.filter(([key]) => key === 'pro-room:v2:core').length;
    const effects = {
      reverb: {
        mixPercent: 20,
        decaySeconds: 2,
        preDelaySeconds: 0.02,
        lowCutPercent: 0,
        highCutPercent: 0,
      },
      equalizer: { bandsDb: [0, 0, 0, 0, 0] },
      virtualBass: { strengthPercent: 0 },
      virtualSurround: { widthPercent: 100 },
    };

    await expect(
      worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie)),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie)),
    ).resolves.toMatchObject({ status: 200 });
    const oldGeneration = internal.pendingHeartbeatFlushGeneration;
    expect(oldGeneration).not.toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    const updated = await worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        {
          coordinatorEpoch: activationEnvelope.snapshot.presence.coordinatorEpoch,
          baseRevision: 0,
          effects,
        },
        ownerCookie,
      ),
    );
    expect(updated.status).toBe(200);
    expect(coreWrites()).toBe(2);
    expect(internal.pendingHeartbeatFlushGeneration).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    await expect(
      worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie)),
    ).resolves.toMatchObject({ status: 200 });
    const newGeneration = internal.pendingHeartbeatFlushGeneration;
    expect(newGeneration).not.toBeNull();
    expect(newGeneration).not.toBe(oldGeneration);
    expect(vi.getTimerCount()).toBe(1);
    await internal.flushHeartbeatDurability(oldGeneration!);
    expect(internal.pendingHeartbeatFlushGeneration).toBe(newGeneration);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(coreWrites()).toBe(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(coreWrites()).toBe(3);
  });

  it('does not absorb a pending heartbeat until an immediate persist succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie, activationEnvelope } = await activatedRoom();
    const internal = worker as unknown as {
      room: { effects: { revision: number } };
      heartbeatDurabilityDirty: boolean;
      pendingHeartbeatFlushGeneration: number | null;
    };
    const originalPut = state.storage.put.bind(state.storage);
    let rejectCoreOnce = false;
    const put = vi.spyOn(state.storage, 'put').mockImplementation(async (key, value) => {
      if (key === 'pro-room:v2:core' && rejectCoreOnce) {
        rejectCoreOnce = false;
        throw new Error('benchmark storage failure');
      }
      await originalPut(key, value);
    });

    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    const generation = internal.pendingHeartbeatFlushGeneration;
    expect(generation).not.toBeNull();
    rejectCoreOnce = true;
    await expect(
      worker.fetch(
        jsonRequest(
          '/effects',
          'PUT',
          {
            coordinatorEpoch: activationEnvelope.snapshot.presence.coordinatorEpoch,
            baseRevision: 0,
            effects: {
              reverb: {
                mixPercent: 10,
                decaySeconds: 2,
                preDelaySeconds: 0.02,
                lowCutPercent: 0,
                highCutPercent: 0,
              },
              equalizer: { bandsDb: [0, 0, 0, 0, 0] },
              virtualBass: { strengthPercent: 0 },
              virtualSurround: { widthPercent: 100 },
            },
          },
          ownerCookie,
        ),
      ),
    ).rejects.toThrow('benchmark storage failure');
    expect(internal.heartbeatDurabilityDirty).toBe(true);
    expect(internal.pendingHeartbeatFlushGeneration).toBe(generation);
    expect(internal.room.effects.revision).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(internal.heartbeatDurabilityDirty).toBe(false);
    expect(internal.pendingHeartbeatFlushGeneration).toBeNull();
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(3);
    expect(internal.room.effects.revision).toBe(0);
    expect(
      (state.storage.data.get('pro-room:v2:core') as Record<string, any>).core.effects.revision,
    ).toBe(0);

    const retried = await worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        {
          coordinatorEpoch: activationEnvelope.snapshot.presence.coordinatorEpoch,
          baseRevision: 0,
          effects: {
            reverb: {
              mixPercent: 10,
              decaySeconds: 2,
              preDelaySeconds: 0.02,
              lowCutPercent: 0,
              highCutPercent: 0,
            },
            equalizer: { bandsDb: [0, 0, 0, 0, 0] },
            virtualBass: { strengthPercent: 0 },
            virtualSurround: { widthPercent: 100 },
          },
        },
        ownerCookie,
      ),
    );
    expect(retried.status).toBe(200);
    expect(internal.room.effects.revision).toBe(1);
  });

  it('keeps a committed mutation successful when post-commit alarm maintenance fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie, activationEnvelope } = await activatedRoom();
    const internal = worker as unknown as {
      room: { effects: { revision: number } };
      scheduledAlarmMs: number | null;
      alarmMaintenanceDirty: boolean;
      alarmMaintenanceRetryAttempt: number;
    };
    internal.scheduledAlarmMs = null;
    state.storage.alarm = null;
    const originalSetAlarm = state.storage.setAlarm.bind(state.storage);
    let failOnce = true;
    const setAlarm = vi.spyOn(state.storage, 'setAlarm').mockImplementation(async (value) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated alarm failure');
      }
      await originalSetAlarm(value);
    });

    const response = await worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        {
          coordinatorEpoch: activationEnvelope.snapshot.presence.coordinatorEpoch,
          baseRevision: 0,
          effects: {
            reverb: {
              mixPercent: 15,
              decaySeconds: 2,
              preDelaySeconds: 0.02,
              lowCutPercent: 0,
              highCutPercent: 0,
            },
            equalizer: { bandsDb: [0, 0, 0, 0, 0] },
            virtualBass: { strengthPercent: 0 },
            virtualSurround: { widthPercent: 100 },
          },
        },
        ownerCookie,
      ),
    );

    expect(response.status).toBe(200);
    expect(internal.room.effects.revision).toBe(1);
    expect(
      (state.storage.data.get('pro-room:v2:core') as Record<string, any>).core.effects.revision,
    ).toBe(1);
    expect(internal.alarmMaintenanceDirty).toBe(true);
    expect(internal.alarmMaintenanceRetryAttempt).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(setAlarm).toHaveBeenCalledTimes(2);
    expect(internal.alarmMaintenanceDirty).toBe(false);
    expect(internal.alarmMaintenanceRetryAttempt).toBe(0);
    expect(state.storage.alarm).not.toBeNull();
  });

  it('keeps failed deferred durability retryable by the next heartbeat and alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as {
      alarm(): Promise<void>;
      heartbeatDurabilityDirty: boolean;
      pendingHeartbeatFlushGeneration: number | null;
    };
    const originalPut = state.storage.put.bind(state.storage);
    let failuresRemaining = 0;
    vi.spyOn(state.storage, 'put').mockImplementation(async (key, value) => {
      if (key === 'pro-room:v2:core' && failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error('deferred storage failure');
      }
      await originalPut(key, value);
    });

    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    failuresRemaining = 1;
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(internal.heartbeatDurabilityDirty).toBe(true);
    expect(internal.pendingHeartbeatFlushGeneration).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(state.storage.alarm).toBe(Date.now() + 1_000);

    await expect(
      worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie)),
    ).resolves.toMatchObject({ status: 200 });
    expect(internal.heartbeatDurabilityDirty).toBe(false);

    failuresRemaining = 1;
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(internal.heartbeatDurabilityDirty).toBe(true);
    expect(internal.pendingHeartbeatFlushGeneration).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    failuresRemaining = 0;
    await internal.alarm();
    expect(internal.heartbeatDurabilityDirty).toBe(false);
  });

  it('persists developer-command heartbeat mutations immediately without scheduling a timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as {
      processDeveloperCommands(nowMs: number): Promise<boolean>;
    };
    const processDeveloperCommands = vi
      .spyOn(internal, 'processDeveloperCommands')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const put = vi.spyOn(state.storage, 'put');

    await expect(
      worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie)),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie)),
    ).resolves.toMatchObject({ status: 200 });
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(2);
    expect(processDeveloperCommands).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a 17-second recovery guard around deferred heartbeat durability', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const outside = await activatedRoom();
    const outsidePut = vi.spyOn(outside.state.storage, 'put');
    const outsideParticipantId = outside.activationEnvelope.snapshot.viewer.participantId as string;

    await outside.worker.fetch(
      request('/presence/heartbeat', { method: 'POST' }, outside.ownerCookie),
    );
    const outsideInternal = outside.worker as unknown as {
      persistedPresenceLastSeenAtMs: Map<string, number>;
    };
    outsideInternal.persistedPresenceLastSeenAtMs.set(outsideParticipantId, Date.now() - 27_999);

    await expect(
      outside.worker.fetch(request('/presence/heartbeat', { method: 'POST' }, outside.ownerCookie)),
    ).resolves.toMatchObject({ status: 200 });
    expect(outsidePut.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);

    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const boundary = await activatedRoom();
    const boundaryPut = vi.spyOn(boundary.state.storage, 'put');
    const boundaryParticipantId = boundary.activationEnvelope.snapshot.viewer
      .participantId as string;
    await boundary.worker.fetch(
      request('/presence/heartbeat', { method: 'POST' }, boundary.ownerCookie),
    );
    const boundaryInternal = boundary.worker as unknown as {
      persistedPresenceLastSeenAtMs: Map<string, number>;
    };
    boundaryInternal.persistedPresenceLastSeenAtMs.set(boundaryParticipantId, Date.now() - 28_000);

    await expect(
      boundary.worker.fetch(
        request('/presence/heartbeat', { method: 'POST' }, boundary.ownerCookie),
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(boundaryPut.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not postpone an earlier alarm when a deferred heartbeat persist fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as {
      pendingHeartbeatFlushGeneration: number | null;
      scheduledAlarmMs: number | null;
    };
    const originalPut = state.storage.put.bind(state.storage);
    let rejectCoreWrites = false;
    vi.spyOn(state.storage, 'put').mockImplementation(async (key, value) => {
      if (key === 'pro-room:v2:core' && rejectCoreWrites) {
        throw new Error('deferred storage failure');
      }
      await originalPut(key, value);
    });

    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    expect(internal.pendingHeartbeatFlushGeneration).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    rejectCoreWrites = true;
    const earlierAlarmMs = Date.now() + 1_500;
    state.storage.alarm = earlierAlarmMs;
    internal.scheduledAlarmMs = earlierAlarmMs;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.storage.alarm).toBe(earlierAlarmMs);
    expect(internal.scheduledAlarmMs).toBe(earlierAlarmMs);
  });

  it.each(['leave', 'close'] as const)(
    'lets an immediate %s absorb heartbeat durability without a stale timer rewrite',
    async (mode) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
      const { worker, state, ownerCookie, activationEnvelope } = await activatedRoom();
      const internal = worker as unknown as {
        pendingHeartbeatFlushGeneration: number | null;
      };
      const put = vi.spyOn(state.storage, 'put');
      await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
      await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
      expect(internal.pendingHeartbeatFlushGeneration).not.toBeNull();
      expect(vi.getTimerCount()).toBe(1);

      const response =
        mode === 'leave'
          ? await worker.fetch(request('/presence/current', { method: 'DELETE' }, ownerCookie))
          : await worker.fetch(
              unloadCloseRequest(
                {
                  expectedParticipantId: activationEnvelope.snapshot.viewer.participantId,
                  expectedPresenceIncarnationId:
                    activationEnvelope.snapshot.viewer.presenceIncarnationId,
                  baseRevision: activationEnvelope.snapshot.revision,
                  currentQueueItemId: activationEnvelope.snapshot.currentQueueItemId,
                  playback: activationEnvelope.snapshot.playback,
                },
                ownerCookie,
                `${IDEMPOTENCY_KEY}-heartbeat-${mode}`,
              ),
            );
      expect(response.status).toBe(200);
      expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(2);
      expect(internal.pendingHeartbeatFlushGeneration).toBeNull();
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(2);
      const stored = state.storage.data.get('pro-room:v2:core') as Record<string, any>;
      expect(Object.keys(stored.core.presence.participants)).toHaveLength(0);
    },
  );

  it('keeps the remaining member and room epoch authoritative after the prior heartbeat timer fires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as {
      pendingHeartbeatFlushGeneration: number | null;
    };
    const memberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const memberCookie = cookieFrom(memberResponse);
    const member = await responseJson(memberResponse);
    bindCookiePresence(memberCookie, member);
    const beforeEpoch = member.snapshot.presence.coordinatorEpoch as number;
    const memberParticipantId = member.snapshot.viewer.participantId as string;
    const put = vi.spyOn(state.storage, 'put');

    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    expect(internal.pendingHeartbeatFlushGeneration).not.toBeNull();
    const leave = await worker.fetch(
      request('/presence/current', { method: 'DELETE' }, ownerCookie),
    );
    expect(leave.status).toBe(200);
    const elected = await responseJson(await worker.fetch(request('/snapshot', {}, memberCookie)));
    expect(elected.snapshot.presence).toMatchObject({
      coordinatorParticipantId: null,
      coordinatorEpoch: beforeEpoch,
      participants: [expect.objectContaining({ participantId: memberParticipantId })],
    });
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(2);
    expect(internal.pendingHeartbeatFlushGeneration).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(2);
    const stored = state.storage.data.get('pro-room:v2:core') as Record<string, any>;
    expect(stored.core.presence).toMatchObject({
      coordinatorParticipantId: null,
      coordinatorEpoch: beforeEpoch,
    });
  });

  it('does not let an old heartbeat timer undo a PIN security rotation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as {
      pendingHeartbeatFlushGeneration: number | null;
    };
    const memberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const memberCookie = cookieFrom(memberResponse);
    bindCookiePresence(memberCookie, await responseJson(memberResponse));
    const put = vi.spyOn(state.storage, 'put');

    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    expect(internal.pendingHeartbeatFlushGeneration).not.toBeNull();
    const rotated = await worker.fetch(
      jsonRequest('/pin', 'POST', { pin: '87654321' }, ownerCookie),
    );
    expect(rotated.status).toBe(200);
    expect((await worker.fetch(request('/snapshot', {}, memberCookie))).status).toBe(401);
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(2);
    expect(internal.pendingHeartbeatFlushGeneration).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(2);
    const stored = state.storage.data.get('pro-room:v2:core') as Record<string, any>;
    expect(Object.keys(stored.core.sessions)).toHaveLength(1);
    expect(Object.keys(stored.core.presence.participants)).toHaveLength(1);
  });

  it('does not let an old heartbeat timer resurrect a suspended room', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as {
      pendingHeartbeatFlushGeneration: number | null;
    };
    const put = vi.spyOn(state.storage, 'put');
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie));
    expect(internal.pendingHeartbeatFlushGeneration).not.toBeNull();

    const suspended = await worker.fetch(
      new Request('https://pro-room.internal/internal/admin/suspend', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': ROOM_CODE },
      }),
    );
    expect(suspended.status).toBe(200);
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(2);
    expect(internal.pendingHeartbeatFlushGeneration).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(2);
    const stored = state.storage.data.get('pro-room:v2:core') as Record<string, any>;
    expect(stored.core).toMatchObject({
      status: 'suspended',
      runtime: 'sleeping',
      sessions: {},
      presence: { coordinatorParticipantId: null, participants: {} },
    });
  });

  it('keeps a multi-peer leave response contract-valid without electing a browser manager', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const controller = await worker.fetch(jsonRequest('/sessions', 'POST', { pin: '12345678' }));
    const controllerCookie = cookieFrom(controller);
    bindCookiePresence(controllerCookie, await responseJson(controller));
    const leave = await responseJson(
      await worker.fetch(request('/presence/current', { method: 'DELETE' }, ownerCookie)),
    );
    expect(parseProRoomSnapshot(leave.snapshot)).not.toBeNull();
    const current = await responseJson(
      await worker.fetch(request('/snapshot', {}, controllerCookie)),
    );
    expect(current.snapshot.presence.participants).toHaveLength(1);
    expect(current.snapshot.presence.coordinatorParticipantId).toBeNull();
  });

  it('keeps room authority stable while a confirmed tab takeover rotates only its incarnation', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const before = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));

    const blockedResponse = await worker.fetch(
      request('/presence/enter', { method: 'POST' }, ownerCookie),
    );
    expect(blockedResponse.status).toBe(409);
    expect(await responseJson(blockedResponse)).toEqual({
      error: 'PRESENCE_ACTIVE_ELSEWHERE',
    });
    const blockedEmptyStreamResponse = await worker.fetch(
      request('/presence/enter', { method: 'POST', body: '' }, ownerCookie),
    );
    expect(blockedEmptyStreamResponse.status).toBe(409);
    expect(await responseJson(blockedEmptyStreamResponse)).toEqual({
      error: 'PRESENCE_ACTIVE_ELSEWHERE',
    });
    const rejectedUnconfirmedTakeover = await worker.fetch(
      jsonRequest('/presence/enter', 'POST', { takeover: false }, ownerCookie),
    );
    expect(rejectedUnconfirmedTakeover.status).toBe(400);
    expect(await responseJson(rejectedUnconfirmedTakeover)).toEqual({
      error: 'INVALID_REQUEST',
    });
    const rejectedNonJsonTakeover = await worker.fetch(
      request('/presence/enter', { method: 'POST', body: '{}' }, ownerCookie),
    );
    expect(rejectedNonJsonTakeover.status).toBe(400);
    expect(await responseJson(rejectedNonJsonTakeover)).toEqual({
      error: 'INVALID_REQUEST',
    });
    const unchanged = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    expect(unchanged.snapshot.viewer.presenceIncarnationId).toBe(
      before.snapshot.viewer.presenceIncarnationId,
    );
    expect(unchanged.snapshot.presence.coordinatorEpoch).toBe(
      before.snapshot.presence.coordinatorEpoch,
    );

    const enteredResponse = await worker.fetch(
      jsonRequest('/presence/enter', 'POST', { takeover: true }, ownerCookie),
    );
    expect(enteredResponse.status).toBe(200);
    const entered = await responseJson(enteredResponse);
    bindCookiePresence(ownerCookie, entered);
    expect(entered.snapshot.viewer.participantId).toBe(before.snapshot.viewer.participantId);
    expect(entered.snapshot.viewer.presenceIncarnationId).not.toBe(
      before.snapshot.viewer.presenceIncarnationId,
    );
    expect(entered.snapshot.presence.coordinatorEpoch).toBe(
      before.snapshot.presence.coordinatorEpoch,
    );

    const refreshed = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    expect(refreshed.snapshot.viewer.presenceIncarnationId).toBe(
      entered.snapshot.viewer.presenceIncarnationId,
    );
  });

  it('requires confirmation to move a member tab without advancing the room epoch', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const memberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const memberCookie = cookieFrom(memberResponse);
    const memberBefore = await responseJson(memberResponse);
    bindCookiePresence(memberCookie, memberBefore);
    const ownerBefore = await responseJson(
      await worker.fetch(request('/snapshot', {}, ownerCookie)),
    );

    const blockedResponse = await worker.fetch(
      request('/presence/enter', { method: 'POST' }, memberCookie),
    );
    expect(blockedResponse.status).toBe(409);
    expect(await responseJson(blockedResponse)).toEqual({
      error: 'PRESENCE_ACTIVE_ELSEWHERE',
    });

    const enteredResponse = await worker.fetch(
      jsonRequest('/presence/enter', 'POST', { takeover: true }, memberCookie),
    );
    expect(enteredResponse.status).toBe(200);
    const entered = await responseJson(enteredResponse);
    bindCookiePresence(memberCookie, entered);

    expect(entered.snapshot.viewer.participantId).toBe(memberBefore.snapshot.viewer.participantId);
    expect(entered.snapshot.viewer.presenceIncarnationId).not.toBe(
      memberBefore.snapshot.viewer.presenceIncarnationId,
    );
    expect(entered.snapshot.presence.coordinatorEpoch).toBe(
      ownerBefore.snapshot.presence.coordinatorEpoch,
    );
    expect(entered.snapshot.presence.coordinatorParticipantId).toBeNull();
  });

  it('fences every old-tab active request after a same-cookie tab enters', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const before = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const oldIdentity = {
      participantId: before.snapshot.viewer.participantId as string,
      presenceIncarnationId: before.snapshot.viewer.presenceIncarnationId as string,
    };
    const oldEpoch = before.snapshot.presence.coordinatorEpoch as number;

    // Pre-issue but do not deliver the old tab's signaling credential.
    const oldTicket = await responseJson(
      await worker.fetch(request('/signaling-tickets', { method: 'POST' }, ownerCookie)),
    );
    expect(oldTicket).toMatchObject({
      ticketSequence: 1,
      presenceIncarnationId: oldIdentity.presenceIncarnationId,
    });

    const enteredResponse = await worker.fetch(
      jsonRequest('/presence/enter', 'POST', { takeover: true }, ownerCookie),
    );
    const entered = await responseJson(enteredResponse);
    bindCookiePresence(ownerCookie, entered);
    expect(entered.snapshot.presence.coordinatorEpoch).toBe(oldEpoch);

    const staleRequests = [
      requestWithPresence('/snapshot', {}, ownerCookie, oldIdentity),
      requestWithPresence('/presence/heartbeat', { method: 'POST' }, ownerCookie, oldIdentity),
      requestWithPresence('/signaling-tickets', { method: 'POST' }, ownerCookie, oldIdentity),
      requestWithPresence(
        '/pin',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pin: '87654321' }),
        },
        ownerCookie,
        oldIdentity,
      ),
      requestWithPresence(
        '/media/reservations',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `${IDEMPOTENCY_KEY}-stale-tab-reserve`,
          },
          body: JSON.stringify({ byteLength: 1024, name: 'stale.wav', mime: 'audio/wav' }),
        },
        ownerCookie,
        oldIdentity,
      ),
    ];
    for (const staleRequest of staleRequests) {
      const response = await worker.fetch(staleRequest);
      expect(response.status).toBe(409);
      expect(await responseJson(response)).toEqual({ error: 'PRESENCE_SUPERSEDED' });
    }

    const newTicket = await responseJson(
      await worker.fetch(request('/signaling-tickets', { method: 'POST' }, ownerCookie)),
    );
    expect(newTicket).toMatchObject({
      ticketSequence: 2,
      presenceIncarnationId: entered.snapshot.viewer.presenceIncarnationId,
      coordinatorEpoch: oldEpoch,
    });
    expect(
      (await worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie))).status,
    ).toBe(200);
  });

  it('revokes exactly the captured server session without a racy cookie tombstone', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const before = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const identity = {
      expectedParticipantId: before.snapshot.viewer.participantId,
      expectedPresenceIncarnationId: before.snapshot.viewer.presenceIncarnationId,
    };
    const atomic = await worker.fetch(
      unloadCloseRequest(
        {
          ...identity,
          baseRevision: before.snapshot.revision,
          currentQueueItemId: null,
          playback: null,
        },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-atomic-before-fenced-session`,
      ),
    );
    expect(atomic.status).toBe(200);

    const fenced = await worker.fetch(fencedSessionCloseRequest(identity, ownerCookie));
    expect(fenced.status).toBe(200);
    expect(await responseJson(fenced)).toEqual({ ok: true });
    // A successful response can arrive after another tab installed a newer
    // same-name cookie, so even the success path must never clear it.
    expect(fenced.headers.get('set-cookie')).toBeNull();

    const internal = worker as unknown as {
      room: {
        presence: { participants: Record<string, unknown> };
        sessions: Record<string, unknown>;
      };
    };
    expect(Object.keys(internal.room.presence.participants)).toHaveLength(0);
    expect(Object.keys(internal.room.sessions)).toHaveLength(0);
  });

  it('preserves a resumed same-cookie tab against both delayed explicit-leave phases', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const before = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const oldIdentity = {
      expectedParticipantId: before.snapshot.viewer.participantId,
      expectedPresenceIncarnationId: before.snapshot.viewer.presenceIncarnationId,
    };

    const entered = await worker.fetch(
      jsonRequest('/presence/enter', 'POST', { takeover: true }, ownerCookie),
    );
    expect(entered.status).toBe(200);
    const enteredEnvelope = await responseJson(entered);
    bindCookiePresence(ownerCookie, enteredEnvelope);
    expect(enteredEnvelope.snapshot.viewer.participantId).toBe(oldIdentity.expectedParticipantId);
    expect(enteredEnvelope.snapshot.viewer.presenceIncarnationId).not.toBe(
      oldIdentity.expectedPresenceIncarnationId,
    );
    const resumedRevision = enteredEnvelope.snapshot.revision;

    const staleAtomic = await worker.fetch(
      unloadCloseRequest(
        {
          ...oldIdentity,
          baseRevision: before.snapshot.revision,
          currentQueueItemId: null,
          playback: null,
        },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-stale-atomic-before-fenced-session`,
      ),
    );
    expect(staleAtomic.status).toBe(409);
    expect(await responseJson(staleAtomic)).toEqual({
      error: 'PRESENCE_IDENTITY_MISMATCH',
    });

    const staleFenced = await worker.fetch(fencedSessionCloseRequest(oldIdentity, ownerCookie));
    expect(staleFenced.status).toBe(409);
    expect(await responseJson(staleFenced)).toEqual({
      error: 'PRESENCE_IDENTITY_MISMATCH',
    });
    expect(staleFenced.headers.get('set-cookie')).toBeNull();

    const current = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    expect(current.snapshot.revision).toBe(resumedRevision);
    expect(current.snapshot.viewer.presenceIncarnationId).toBe(
      enteredEnvelope.snapshot.viewer.presenceIncarnationId,
    );
    expect(current.snapshot.presence.participants).toHaveLength(1);
    const internal = worker as unknown as {
      room: { sessions: Record<string, unknown> };
    };
    expect(Object.keys(internal.room.sessions)).toHaveLength(1);
  });

  it('atomically leaves on unload without letting a browser checkpoint replace server playback', async () => {
    const context = await activatedRoom();
    const { worker, ownerCookie } = context;
    const queueItemId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    expect(
      (
        await replacePlaylist(
          context,
          [
            {
              queueItemId,
              name: 'Persistent video',
              source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
            },
          ],
          'unload-server-authority',
        )
      ).status,
    ).toBe(200);
    const queued = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const prepare = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/playback/commands',
          'POST',
          {
            type: 'select',
            baseRevision: queued.snapshot.playback.revision,
            queueItemId,
            state: 'paused',
            positionSeconds: 10,
          },
          ownerCookie,
          `${IDEMPOTENCY_KEY}-unload-select`,
        ),
      ),
    );
    expect(
      (
        await worker.fetch(
          jsonRequest(
            `/playback/transitions/${prepare.transition.transitionId}/ready`,
            'POST',
            {
              basePlaybackRevision: prepare.transition.basePlaybackRevision,
              status: 'ready',
            },
            ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);
    const selected = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const closeBody = {
      expectedParticipantId: selected.snapshot.viewer.participantId,
      expectedPresenceIncarnationId: selected.snapshot.viewer.presenceIncarnationId,
      baseRevision: selected.snapshot.revision,
      currentQueueItemId: queueItemId,
      playback: {
        coordinatorEpoch: selected.snapshot.presence.coordinatorEpoch,
        revision: selected.snapshot.playback.revision + 1,
        state: 'playing',
        queueItemId,
        positionSeconds: 42.25,
        updatedAtMs: Date.now(),
        youtubeVideoId: '9bZkp7q19f0',
        youtubeSubIndex: 7,
      },
    };
    // A legacy periodic snapshot may still arrive during a rolling deploy,
    // but it can only round-trip the canonical selection, never advance it.
    const periodic = await worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: selected.snapshot.revision,
          playlist: selected.snapshot.playlist,
          currentQueueItemId: queueItemId,
          playback: selected.snapshot.playback,
        },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-unload-periodic-race`,
      ),
    );
    expect(periodic.status).toBe(200);
    const closeKey = `${IDEMPOTENCY_KEY}-unload-close`;
    const first = await worker.fetch(unloadCloseRequest(closeBody, ownerCookie, closeKey));
    expect(first.status).toBe(200);
    expect(await responseJson(first)).toEqual({ ok: true });
    expect(first.headers.get('set-cookie')).toBeNull();

    const internal = worker as unknown as {
      room: {
        revision: number;
        runtime: string;
        playback: Record<string, any>;
        presence: { participants: Record<string, unknown> };
        sessions: Record<string, unknown>;
      };
    };
    expect(internal.room.runtime).toBe('sleeping');
    expect(Object.keys(internal.room.presence.participants)).toHaveLength(0);
    expect(Object.keys(internal.room.sessions)).toHaveLength(1);
    expect(internal.room.playback).toMatchObject({
      state: 'paused',
      positionSeconds: 10,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
    });
    const committedRevision = internal.room.revision;

    const replay = await worker.fetch(unloadCloseRequest(closeBody, ownerCookie, closeKey));
    expect(replay.status).toBe(200);
    expect(await responseJson(replay)).toEqual({ ok: true });
    expect(internal.room.revision).toBe(committedRevision);

    // Ordinary refresh must not resurrect a closed presence. Resume has one
    // explicit enter endpoint that rotates the server-issued incarnation.
    const refreshWhileClosed = await worker.fetch(request('/snapshot', {}, ownerCookie));
    expect(refreshWhileClosed.status).toBe(409);
    expect(await responseJson(refreshWhileClosed)).toEqual({ error: 'PRESENCE_SUPERSEDED' });

    const entered = await worker.fetch(request('/presence/enter', { method: 'POST' }, ownerCookie));
    expect(entered.status).toBe(200);
    const enteredEnvelope = await responseJson(entered);
    bindCookiePresence(ownerCookie, enteredEnvelope);
    expect(enteredEnvelope.snapshot.viewer.role).toBe('owner');
    expect(enteredEnvelope.snapshot.viewer.participantId).toBe(closeBody.expectedParticipantId);
    expect(enteredEnvelope.snapshot.viewer.presenceIncarnationId).not.toBe(
      closeBody.expectedPresenceIncarnationId,
    );
    const resumedRevision = internal.room.revision;

    // A retry of the already-processed old close replays harmlessly even
    // after enter rotated the incarnation.
    const oldReplayAfterEnter = await worker.fetch(
      unloadCloseRequest(closeBody, ownerCookie, closeKey),
    );
    expect(oldReplayAfterEnter.status).toBe(200);
    expect(await responseJson(oldReplayAfterEnter)).toEqual({ ok: true });
    expect(internal.room.revision).toBe(resumedRevision);

    // The same captured body under a never-processed key is stale and cannot
    // close or checkpoint the new incarnation.
    const staleUnprocessed = await worker.fetch(
      unloadCloseRequest(
        closeBody,
        ownerCookie,
        `${IDEMPOTENCY_KEY}-unload-close-stale-after-enter`,
      ),
    );
    expect(staleUnprocessed.status).toBe(409);
    expect(await responseJson(staleUnprocessed)).toEqual({
      error: 'PRESENCE_IDENTITY_MISMATCH',
    });
    expect(internal.room.revision).toBe(resumedRevision);
    expect(Object.keys(internal.room.presence.participants)).toHaveLength(1);
  });

  it('validates unload identity and revisions while treating playback as an observation only', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const controllerResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const controllerEnvelope = await responseJson(controllerResponse);
    const controllerCookie = cookieFrom(controllerResponse);
    bindCookiePresence(controllerCookie, controllerEnvelope);
    const current = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const baseBody = {
      expectedParticipantId: current.snapshot.viewer.participantId,
      expectedPresenceIncarnationId: current.snapshot.viewer.presenceIncarnationId,
      baseRevision: current.snapshot.revision,
      currentQueueItemId: null,
      playback: current.snapshot.playback,
    };

    const preflightShape = await worker.fetch(
      jsonRequest(
        '/presence/close',
        'POST',
        { idempotencyKey: `${IDEMPOTENCY_KEY}-json-close`, ...baseBody },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-json-close`,
      ),
    );
    expect(preflightShape.status).toBe(400);
    expect(await responseJson(preflightShape)).toEqual({ error: 'INVALID_REQUEST' });

    const nonStringKey = await worker.fetch(
      unloadCloseRequest(
        { ...baseBody, idempotencyKey: 1234567890123456 },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-ignored`,
      ),
    );
    expect(nonStringKey.status).toBe(400);
    expect(await responseJson(nonStringKey)).toEqual({ error: 'INVALID_REQUEST' });

    const unauthenticated = await worker.fetch(
      unloadCloseRequest(
        { ...baseBody, playback: null },
        undefined,
        `${IDEMPOTENCY_KEY}-unload-unauth`,
      ),
    );
    expect(unauthenticated.status).toBe(401);

    const wrongCookieIdentity = await worker.fetch(
      unloadCloseRequest(
        baseBody,
        controllerCookie,
        `${IDEMPOTENCY_KEY}-unload-wrong-cookie-identity`,
      ),
    );
    expect(wrongCookieIdentity.status).toBe(409);
    expect(await responseJson(wrongCookieIdentity)).toEqual({
      error: 'PRESENCE_IDENTITY_MISMATCH',
    });

    const memberClose = await worker.fetch(
      unloadCloseRequest(
        {
          ...baseBody,
          expectedParticipantId: controllerEnvelope.snapshot.viewer.participantId,
          expectedPresenceIncarnationId: controllerEnvelope.snapshot.viewer.presenceIncarnationId,
        },
        controllerCookie,
        `${IDEMPOTENCY_KEY}-unload-member-playback`,
      ),
    );
    expect(memberClose.status).toBe(200);
    expect(await responseJson(memberClose)).toEqual({ ok: true });

    const futureRevision = await worker.fetch(
      unloadCloseRequest(
        { ...baseBody, baseRevision: current.snapshot.revision + 100 },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-unload-future`,
      ),
    );
    expect(futureRevision.status).toBe(400);
    expect(await responseJson(futureRevision)).toEqual({ error: 'INVALID_REVISION' });

    const invalidSelection = await worker.fetch(
      unloadCloseRequest(
        { ...baseBody, currentQueueItemId: 'not-a-queue-item' },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-unload-invalid-selection`,
      ),
    );
    expect(invalidSelection.status).toBe(400);
    expect(await responseJson(invalidSelection)).toEqual({ error: 'INVALID_PLAYBACK' });
    const stillPresent = await responseJson(
      await worker.fetch(request('/snapshot', {}, ownerCookie)),
    );
    expect(stillPresent.snapshot.presence.participants).toHaveLength(1);
  });

  it('allows 100 total same-NAT devices and evicts only inactive sessions during long churn', async () => {
    const { worker } = await activatedRoom();
    const activeCookies: string[] = [];
    // activatedRoom() already enters the owner/coordinator, leaving 99 member
    // places under the host-inclusive 100-device room ceiling.
    for (let index = 0; index < 99; index += 1) {
      const joined = await worker.fetch(
        jsonRequest('/sessions', 'POST', {
          pin: '12345678',
        }),
      );
      expect(joined.status).toBe(200);
      const cookie = cookieFrom(joined);
      bindCookiePresence(cookie, await responseJson(joined));
      activeCookies.push(cookie);
    }
    const full = await worker.fetch(jsonRequest('/sessions', 'POST', { pin: '12345678' }));
    expect(full.status).toBe(409);
    expect(await responseJson(full)).toEqual({ error: 'ROOM_FULL' });
    const internal = worker as unknown as {
      room: { sessions: Record<string, unknown>; rateLimits: Record<string, unknown> };
    };
    expect(Object.keys(internal.room.rateLimits)).not.toContain(
      'pin-failure:hashed-client-address',
    );

    for (const cookie of activeCookies) {
      await worker.fetch(request('/sessions/current', { method: 'DELETE' }, cookie));
    }
    for (let index = 0; index < 140; index += 1) {
      const joined = await worker.fetch(
        jsonRequest('/sessions', 'POST', {
          pin: '12345678',
        }),
      );
      expect(joined.status).toBe(200);
      const cookie = cookieFrom(joined);
      bindCookiePresence(cookie, await responseJson(joined));
      expect(
        (await worker.fetch(request('/presence/current', { method: 'DELETE' }, cookie))).status,
      ).toBe(200);
    }
    expect(Object.keys(internal.room.sessions).length).toBeLessThanOrEqual(128);
    // This stress scenario intentionally performs hundreds of serialized Worker
    // requests. Keep the assertion strict while allowing slower local/CI runners
    // enough time to reach it instead of reporting a scheduler-only timeout.
  }, 60_000);

  it('requires live presence for state/media mutations and for creator-only completion', async () => {
    const context = await activatedRoom();
    const reservation = await responseJson(
      await context.worker.fetch(
        jsonRequest(
          '/media/reservations',
          'POST',
          { byteLength: 2048, name: 'presence.wav', mime: 'audio/wav' },
          context.ownerCookie,
          `${IDEMPOTENCY_KEY}-presence-reserve`,
        ),
      ),
    );
    const assetId = reservation.reservation.assetId as string;
    const internal = context.worker as unknown as { room: StoredRoom };
    const asset = internal.room.assets[assetId]!;
    context.bucket.objects.set(asset.stagingObjectKey, {
      size: asset.byteLength,
      httpMetadata: { contentType: asset.mime },
      customMetadata: {
        'mxqr-room': ROOM_CODE,
        'mxqr-generation': String(asset.roomGeneration ?? 0),
        'mxqr-asset': asset.assetId,
        'mxqr-version': String(asset.version),
        'mxqr-bytes': String(asset.byteLength),
      },
    });
    const beforeLeave = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const controller = await context.worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const controllerCookie = cookieFrom(controller);
    bindCookiePresence(controllerCookie, await responseJson(controller));
    const wrongCompleter = await context.worker.fetch(
      request(
        `/media/${assetId}/complete`,
        { method: 'POST', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-wrong-completer` } },
        controllerCookie,
      ),
    );
    expect(wrongCompleter.status).toBe(403);
    expect(await responseJson(wrongCompleter)).toEqual({
      error: 'RESERVATION_OWNER_REQUIRED',
    });
    await context.worker.fetch(
      request('/presence/current', { method: 'DELETE' }, context.ownerCookie),
    );
    const completeWhileAway = await context.worker.fetch(
      request(
        `/media/${assetId}/complete`,
        { method: 'POST', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-presence-complete` } },
        context.ownerCookie,
      ),
    );
    expect(completeWhileAway.status).toBe(409);
    expect(await responseJson(completeWhileAway)).toEqual({ error: 'PRESENCE_SUPERSEDED' });
    const mutateWhileAway = await context.worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: beforeLeave.snapshot.revision,
          playlist: [],
          currentQueueItemId: null,
          playback: beforeLeave.snapshot.playback,
        },
        context.ownerCookie,
        `${IDEMPOTENCY_KEY}-presence-away`,
      ),
    );
    expect(mutateWhileAway.status).toBe(409);
    expect(await responseJson(mutateWhileAway)).toEqual({ error: 'PRESENCE_SUPERSEDED' });

    expect((await context.worker.fetch(request('/snapshot', {}, context.ownerCookie))).status).toBe(
      409,
    );
    const reentered = await context.worker.fetch(
      request('/presence/enter', { method: 'POST' }, context.ownerCookie),
    );
    expect(reentered.status).toBe(200);
    bindCookiePresence(context.ownerCookie, await responseJson(reentered));
    const completed = await context.worker.fetch(
      request(
        `/media/${assetId}/complete`,
        { method: 'POST', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-presence-complete` } },
        context.ownerCookie,
      ),
    );
    expect(completed.status).toBe(200);
  });

  it('applies one exact revision and replays the same idempotent mutation', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const current = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const queueItemId = '11111111-1111-4111-8111-111111111111';
    const body = {
      baseRevision: current.snapshot.revision,
      playlist: [
        {
          queueItemId,
          name: 'Video',
          source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
        },
      ],
      currentQueueItemId: null,
      // During the rolling cutover the field remains on the wire, but it is
      // only an observation. Queue mutations cannot mint playback authority.
      playback: current.snapshot.playback,
    };
    const first = await worker.fetch(
      jsonRequest('/snapshot', 'PUT', body, ownerCookie, IDEMPOTENCY_KEY),
    );
    expect(first.status).toBe(200);
    const firstEnvelope = await responseJson(first);
    expect(firstEnvelope.snapshot.playback).toEqual(current.snapshot.playback);
    expect(
      firstEnvelope.snapshot.presence.participants.every(
        (participant: Record<string, unknown>) =>
          !Object.prototype.hasOwnProperty.call(participant, 'devicePlatform'),
      ),
    ).toBe(true);
    const controller = await worker.fetch(jsonRequest('/sessions', 'POST', { pin: '12345678' }));
    expect(controller.status).toBe(200);
    const negotiatedReplay = jsonRequest('/snapshot', 'PUT', body, ownerCookie, IDEMPOTENCY_KEY);
    negotiatedReplay.headers.set('accept', 'application/json; mxqr-device-platform=1');
    const replay = await worker.fetch(negotiatedReplay);
    const replayEnvelope = await responseJson(replay);
    expect(replayEnvelope.snapshot.revision).toBeGreaterThan(firstEnvelope.snapshot.revision);
    expect(replayEnvelope.snapshot.playlist).toEqual(firstEnvelope.snapshot.playlist);
    expect(
      replayEnvelope.snapshot.presence.participants.every(
        (participant: Record<string, unknown>) => typeof participant.devicePlatform === 'string',
      ),
    ).toBe(true);
    const legacyReplay = await responseJson(
      await worker.fetch(jsonRequest('/snapshot', 'PUT', body, ownerCookie, IDEMPOTENCY_KEY)),
    );
    expect(
      legacyReplay.snapshot.presence.participants.every(
        (participant: Record<string, unknown>) =>
          !Object.prototype.hasOwnProperty.call(participant, 'devicePlatform'),
      ),
    ).toBe(true);
    const internal = worker as unknown as {
      room: { idempotency: Record<string, Record<string, unknown>> };
    };
    const record = Object.values(internal.room.idempotency).find(
      (candidate) => candidate.kind === 'snapshot',
    );
    expect(record).toMatchObject({
      kind: 'snapshot',
      committedRevision: firstEnvelope.snapshot.revision,
      status: 200,
    });
    expect(record).not.toHaveProperty('body');
  });

  it('keeps queue snapshots observation-only and validates server playback commands', async () => {
    const context = await activatedRoom();
    const queueItemId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const playlist = [
      {
        queueItemId,
        name: 'Video',
        source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      },
    ];
    expect((await replacePlaylist(context, playlist, 'authority-command-validation')).status).toBe(
      200,
    );
    const current = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );

    const forgedSnapshot = await context.worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: current.snapshot.revision,
          playlist,
          currentQueueItemId: queueItemId,
          playback: {
            ...current.snapshot.playback,
            revision: current.snapshot.playback.revision + 1,
            state: 'paused',
            queueItemId,
            positionSeconds: 42,
            updatedAtMs: Date.now(),
            youtubeVideoId: 'dQw4w9WgXcQ',
            youtubeSubIndex: 0,
          },
        },
        context.ownerCookie,
        `${IDEMPOTENCY_KEY}-forged-snapshot`,
      ),
    );
    expect(forgedSnapshot.status).toBe(409);
    await expect(forgedSnapshot.json()).resolves.toEqual({ error: 'PLAYBACK_COMMAND_REQUIRED' });

    const invalidCommands = [
      {
        type: 'seek',
        baseRevision: current.snapshot.playback.revision,
        positionSeconds: 8 * 24 * 60 * 60,
      },
      {
        type: 'select',
        baseRevision: current.snapshot.playback.revision,
        queueItemId,
        youtubeVideoId: 'dQw4w9WgXcQ',
      },
      {
        type: 'select',
        baseRevision: current.snapshot.playback.revision,
        queueItemId,
        updatedAtMs: Date.now(),
      },
    ];
    for (const [index, command] of invalidCommands.entries()) {
      const rejected = await context.worker.fetch(
        jsonRequest(
          '/playback/commands',
          'POST',
          command,
          context.ownerCookie,
          `${IDEMPOTENCY_KEY}-invalid-command-${index}`,
        ),
      );
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
    }

    const stale = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: current.snapshot.playback.revision + 99,
          queueItemId,
        },
        context.ownerCookie,
        `${IDEMPOTENCY_KEY}-stale-command`,
      ),
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: 'PLAYBACK_REVISION_CONFLICT' });

    const missing = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: current.snapshot.playback.revision,
          queueItemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
        context.ownerCookie,
        `${IDEMPOTENCY_KEY}-missing-target`,
      ),
    );
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: 'INVALID_PLAYBACK_TARGET' });

    const accepted = await context.worker.fetch(
      jsonRequest(
        '/playback/commands',
        'POST',
        {
          type: 'select',
          baseRevision: current.snapshot.playback.revision,
          queueItemId,
          state: 'paused',
          positionSeconds: 42,
          youtubeVideoId: 'dQw4w9WgXcQ',
          youtubeSubIndex: 0,
        },
        context.ownerCookie,
        `${IDEMPOTENCY_KEY}-valid-command`,
      ),
    );
    expect(accepted.status).toBe(202);
    const prepared = await responseJson(accepted);
    const ready = await context.worker.fetch(
      jsonRequest(
        `/playback/transitions/${prepared.transition.transitionId}/ready`,
        'POST',
        {
          basePlaybackRevision: prepared.transition.basePlaybackRevision,
          status: 'ready',
        },
        context.ownerCookie,
      ),
    );
    expect(ready.status).toBe(200);
    const envelope = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(envelope.snapshot.playback).toMatchObject({
      revision: current.snapshot.playback.revision + 1,
      state: 'paused',
      queueItemId,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
      positionSeconds: 42,
    });
    expect(envelope.snapshot.currentQueueItemId).toBe(queueItemId);
  });

  it('persists a playlist above the legacy single-record budget and restores it from v2 rows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T06:00:00.000Z'));
    const { worker, state, ownerCookie } = await activatedRoom();
    const before = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const longText = 'x'.repeat(1_900);
    const playlist = Array.from({ length: 220 }, (_, index) => ({
      queueItemId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-${index
        .toString(16)
        .padStart(12, '0')}`,
      name: longText,
      title: longText,
      artist: longText,
      thumbnail: longText,
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    }));
    const mutation = {
      baseRevision: before.snapshot.revision,
      playlist,
      currentQueueItemId: null,
      playback: before.snapshot.playback,
    };
    expect(new TextEncoder().encode(JSON.stringify(mutation)).byteLength).toBeGreaterThan(
      1_500 * 1024,
    );
    await vi.advanceTimersByTimeAsync(30_001);
    const accepted = await worker.fetch(
      jsonRequest('/snapshot', 'PUT', mutation, ownerCookie, `${IDEMPOTENCY_KEY}-state-budget`),
    );
    expect(accepted.status).toBe(200);
    const after = await responseJson(accepted);
    expect(after.snapshot.playlist).toHaveLength(220);
    expect(state.storage.data.get('pro-room:v2:core')).toBeDefined();
    // The old record remains the last exact rollback shadow instead of being
    // overwritten with an over-budget value.
    const legacyShadow = state.storage.data.get('pro-room:v1') as StoredRoom;
    expect(legacyShadow.revision).toBe(before.snapshot.revision);
    expect(legacyShadow.playlist).toEqual([]);

    const put = vi.spyOn(state.storage, 'put');
    await expect(
      worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie)),
    ).resolves.toMatchObject({ status: 200 });
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(1);
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v1')).toHaveLength(0);
    await expect(
      worker.fetch(request('/presence/heartbeat', { method: 'POST' }, ownerCookie)),
    ).resolves.toMatchObject({ status: 200 });
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(1);
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v1')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v2:core')).toHaveLength(2);
    expect(put.mock.calls.filter(([key]) => key === 'pro-room:v1')).toHaveLength(0);

    const restarted = new MusixquareProRoom(state as never, environment() as never);
    const restored = await responseJson(
      await restarted.fetch(request('/snapshot', {}, ownerCookie)),
    );
    expect(restored.snapshot.playlist).toEqual(playlist);
  });

  it('migrates a legacy v1 room on its next successful mutation', async () => {
    const { state, bucket, ownerCookie } = await activatedRoom();
    for (const key of [...state.storage.data.keys()]) {
      if (key.startsWith('pro-room:v2:')) state.storage.data.delete(key);
    }
    const restarted = new MusixquareProRoom(state as never, environment(bucket) as never);
    const before = await responseJson(await restarted.fetch(request('/snapshot', {}, ownerCookie)));
    const item = {
      queueItemId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'Migrated row',
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    };
    const mutated = await restarted.fetch(
      jsonRequest(
        '/snapshot/compact',
        'POST',
        {
          baseRevision: before.snapshot.revision,
          playlistOrder: [item.queueItemId],
          upserts: [item],
          currentQueueItemId: null,
          playback: before.snapshot.playback,
        },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-v1-migration`,
      ),
    );

    expect(mutated.status).toBe(200);
    expect(state.storage.data.get('pro-room:v2:core')).toBeDefined();
    expect(state.storage.data.get(`pro-room:v2:playlist:${item.queueItemId}`)).toEqual(item);
    expect((state.storage.data.get('pro-room:v1') as StoredRoom).playlist).toEqual([item]);
  });

  it('rejects a playlist above the bounded public snapshot budget before writing v2 rows', async () => {
    const { worker, state } = await activatedRoom();
    const internal = worker as unknown as {
      room: Record<string, any>;
      persist(): Promise<void>;
    };
    const beforeCore = structuredClone(state.storage.data.get('pro-room:v2:core'));
    const longText = 'x'.repeat(2_000);
    internal.room.playlist = Array.from({ length: 400 }, (_, index) => ({
      queueItemId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-${index
        .toString(16)
        .padStart(12, '0')}`,
      name: longText,
      title: longText,
      artist: longText,
      thumbnail: longText,
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    }));

    await expect(internal.persist()).rejects.toMatchObject({ name: 'RoomStateCapacityError' });
    expect(state.storage.data.get('pro-room:v2:core')).toEqual(beforeCore);
  });

  it('rolls back playlist rows and core together when a v2 transaction fails', async () => {
    const { worker, state } = await activatedRoom();
    const internal = worker as unknown as {
      room: StoredRoom & { playlist: any[] };
      persist(): Promise<void>;
    };
    const before = structuredClone([...state.storage.data.entries()]);
    const item = {
      queueItemId: 'eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee',
      name: 'Atomic row',
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    };
    internal.room.playlist = [item];
    const originalPut = state.storage.put.bind(state.storage);
    let failCoreOnce = true;
    state.storage.put = async (key, value) => {
      if (failCoreOnce && key === 'pro-room:v2:core') {
        failCoreOnce = false;
        throw new Error('simulated core write failure');
      }
      return originalPut(key, value);
    };

    await expect(internal.persist()).rejects.toThrow('simulated core write failure');
    expect([...state.storage.data.entries()]).toEqual(before);
    expect(state.storage.data.has(`pro-room:v2:playlist:${item.queueItemId}`)).toBe(false);

    state.storage.put = originalPut;
    await internal.persist();
    expect(state.storage.data.get(`pro-room:v2:playlist:${item.queueItemId}`)).toEqual(item);
    expect(
      (state.storage.data.get('pro-room:v2:core') as Record<string, any>).playlistOrder,
    ).toEqual([item.queueItemId]);
  });

  it('applies compact participant mutations without resending unchanged row metadata', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const before = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const item = {
      queueItemId: '11111111-1111-4111-8111-111111111111',
      name: 'A'.repeat(2_000),
      title: 'First title',
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    };
    const first = await worker.fetch(
      jsonRequest(
        '/snapshot/compact',
        'POST',
        {
          baseRevision: before.snapshot.revision,
          playlistOrder: [item.queueItemId],
          upserts: [item],
          currentQueueItemId: null,
          playback: before.snapshot.playback,
        },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-compact-first`,
      ),
    );
    expect(first.status).toBe(200);
    const accepted = await responseJson(first);
    expect(accepted.snapshot.playlist).toEqual([item]);

    const second = await worker.fetch(
      jsonRequest(
        '/snapshot/compact',
        'POST',
        {
          baseRevision: accepted.snapshot.revision,
          playlistOrder: null,
          upserts: [],
          currentQueueItemId: null,
          playback: accepted.snapshot.playback,
        },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-compact-checkpoint`,
      ),
    );
    expect(second.status).toBe(200);
    expect((await responseJson(second)).snapshot.playlist).toEqual([item]);
  });

  it('keeps stale playlist CAS errors below the browser error-body budget', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const before = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const playlist = Array.from({ length: 64 }, (_, index) => ({
      queueItemId: `${index.toString(16).padStart(8, '0')}-2222-4222-8222-${index
        .toString(16)
        .padStart(12, '0')}`,
      name: `Track ${index} ${'N'.repeat(180)}`,
      title: `Title ${index} ${'T'.repeat(180)}`,
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    }));
    const populated = await worker.fetch(
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: before.snapshot.revision,
          playlist,
          currentQueueItemId: null,
          playback: before.snapshot.playback,
        },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-populate-conflict-budget`,
      ),
    );
    expect(populated.status).toBe(200);
    const current = await responseJson(populated);
    expect(
      new TextEncoder().encode(
        JSON.stringify({ error: 'REVISION_CONFLICT', snapshot: current.snapshot }),
      ).byteLength,
    ).toBeGreaterThan(16 * 1024);

    const staleRequests = [
      jsonRequest(
        '/snapshot',
        'PUT',
        {
          baseRevision: before.snapshot.revision,
          playlist: current.snapshot.playlist,
          currentQueueItemId: current.snapshot.currentQueueItemId,
          playback: current.snapshot.playback,
        },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-stale-legacy-budget`,
      ),
      jsonRequest(
        '/snapshot/compact',
        'POST',
        {
          baseRevision: before.snapshot.revision,
          playlistOrder: null,
          upserts: [],
          currentQueueItemId: current.snapshot.currentQueueItemId,
          playback: current.snapshot.playback,
        },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-stale-compact-budget`,
      ),
    ];
    for (const staleRequest of staleRequests) {
      const response = await worker.fetch(staleRequest);
      expect(response.status).toBe(409);
      const text = await response.text();
      expect(new TextEncoder().encode(text).byteLength).toBeLessThan(16 * 1024);
      expect(JSON.parse(text)).toEqual({ error: 'REVISION_CONFLICT' });
    }
  });

  it('accepts a bounded compact upsert batch above the retired 512 KiB ceiling', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const before = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const longText = 'x'.repeat(2_000);
    const upserts = Array.from({ length: 80 }, (_, index) => ({
      queueItemId: `${index.toString(16).padStart(8, '0')}-1111-4111-8111-${index
        .toString(16)
        .padStart(12, '0')}`,
      name: longText,
      title: longText,
      artist: longText,
      thumbnail: longText,
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    }));
    const body = {
      baseRevision: before.snapshot.revision,
      playlistOrder: upserts.map((item) => item.queueItemId),
      upserts,
      currentQueueItemId: null,
      playback: before.snapshot.playback,
    };
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeGreaterThan(512 * 1024);

    const response = await worker.fetch(
      jsonRequest(
        '/snapshot/compact',
        'POST',
        body,
        ownerCookie,
        `${IDEMPOTENCY_KEY}-compact-large-batch`,
      ),
    );
    expect(response.status).toBe(200);
    expect((await responseJson(response)).snapshot.playlist).toHaveLength(80);
  });
});

describe('persistent PRO room private media accounting', () => {
  it('recovers participant completion after final R2 creation outlives a failed room commit', async () => {
    const context = await activatedRoom();
    const reservationResponse = await context.worker.fetch(
      jsonRequest(
        '/media/reservations',
        'POST',
        { byteLength: 4096, name: 'recover.flac', mime: 'audio/flac' },
        context.ownerCookie,
        `${IDEMPOTENCY_KEY}-participant-recover-reserve`,
      ),
    );
    const reservation = await responseJson(reservationResponse);
    const assetId = reservation.reservation.assetId as string;
    const internal = context.worker as unknown as { room: StoredRoom };
    const asset = structuredClone(internal.room.assets[assetId]!);
    context.bucket.objects.set(asset.stagingObjectKey, {
      size: asset.byteLength,
      httpMetadata: { contentType: asset.mime },
      customMetadata: {
        'mxqr-room': ROOM_CODE,
        'mxqr-generation': String(asset.roomGeneration ?? 0),
        'mxqr-asset': asset.assetId,
        'mxqr-version': String(asset.version),
        'mxqr-bytes': String(asset.byteLength),
      },
    });

    const originalPut = context.state.storage.put.bind(context.state.storage);
    let failCoreOnce = true;
    context.state.storage.put = async (key, value) => {
      if (failCoreOnce && key === 'pro-room:v2:core') {
        failCoreOnce = false;
        throw new Error('simulated participant completion commit failure');
      }
      return originalPut(key, value);
    };
    const completion = () =>
      request(
        `/media/${assetId}/complete`,
        {
          method: 'POST',
          headers: {
            'idempotency-key': `${IDEMPOTENCY_KEY}-participant-recover-complete`,
          },
        },
        context.ownerCookie,
      );

    await expect(context.worker.fetch(completion())).rejects.toMatchObject({
      name: 'RoomStateStorageCommitError',
    });
    expect(internal.room.assets[assetId]).toMatchObject({ status: 'reserved' });
    expect(internal.room.quota).toMatchObject({ usedBytes: 0, reservedBytes: asset.byteLength });
    expect(context.bucket.objects.get(asset.objectKey)).toMatchObject({
      size: asset.byteLength,
      httpMetadata: { contentType: asset.mime },
    });
    expect(context.bucket.objects.has(asset.stagingObjectKey)).toBe(true);

    // Recreate the isolate after the client-uploaded staging object has gone
    // away. The exact final object is sufficient to finish the reserved
    // transaction without charging the room twice.
    context.state.storage.put = originalPut;
    context.bucket.objects.delete(asset.stagingObjectKey);
    const restarted = new MusixquareProRoom(
      context.state as never,
      environment(context.bucket) as never,
    );
    const recovered = await restarted.fetch(completion());
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      asset: { assetId },
      quota: { usedBytes: asset.byteLength, reservedBytes: 0 },
    });
    const restartedInternal = restarted as unknown as { room: StoredRoom };
    expect(restartedInternal.room.assets[assetId]).toMatchObject({ status: 'ready' });
    expect(restartedInternal.room.quota).toMatchObject({
      usedBytes: asset.byteLength,
      reservedBytes: 0,
    });

    const replay = await restarted.fetch(completion());
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      quota: { usedBytes: asset.byteLength, reservedBytes: 0 },
    });
  });

  it('completes and indexes a local upload beside a playlist above the legacy state budget', async () => {
    const { worker, bucket, ownerCookie } = await activatedRoom();
    const internal = worker as unknown as {
      room: StoredRoom & {
        playlistRevision: number;
        playlist: any[];
      };
      persist(): Promise<void>;
    };
    const longText = 'x'.repeat(1_900);
    internal.room.playlist = Array.from({ length: 160 }, (_, index) => ({
      queueItemId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-${index
        .toString(16)
        .padStart(12, '0')}`,
      name: longText,
      title: longText,
      artist: longText,
      thumbnail: longText,
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    }));
    internal.room.playlistRevision += 1;
    internal.room.revision += 1;
    await internal.persist();

    const reserve = await worker.fetch(
      jsonRequest(
        '/media/reservations',
        'POST',
        { byteLength: 1024, name: 'Track.flac', mime: 'audio/flac' },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-large-playlist-reserve`,
      ),
    );
    expect(reserve.status).toBe(200);
    const reservation = await responseJson(reserve);
    const asset = internal.room.assets[reservation.reservation.assetId]!;
    bucket.objects.set(asset.stagingObjectKey, {
      size: asset.byteLength,
      httpMetadata: { contentType: asset.mime },
      customMetadata: {
        'mxqr-room': ROOM_CODE,
        'mxqr-generation': String(asset.roomGeneration ?? 0),
        'mxqr-asset': reservation.reservation.assetId,
        'mxqr-version': '1',
        'mxqr-bytes': String(asset.byteLength),
      },
    });
    const complete = await worker.fetch(
      request(
        `/media/${reservation.reservation.assetId}/complete`,
        {
          method: 'POST',
          headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-large-playlist-complete` },
        },
        ownerCookie,
      ),
    );
    expect(complete.status).toBe(200);
    const completed = await responseJson(complete);
    const snapshot = await responseJson(await worker.fetch(request('/snapshot', {}, ownerCookie)));
    const queueItemId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    const indexed = await worker.fetch(
      jsonRequest(
        '/snapshot/compact',
        'POST',
        {
          baseRevision: snapshot.snapshot.revision,
          playlistOrder: [
            ...snapshot.snapshot.playlist.map((item: any) => item.queueItemId),
            queueItemId,
          ],
          upserts: [
            {
              queueItemId,
              name: 'Track.flac',
              source: completed.asset,
            },
          ],
          currentQueueItemId: snapshot.snapshot.currentQueueItemId,
          playback: snapshot.snapshot.playback,
        },
        ownerCookie,
        `${IDEMPOTENCY_KEY}-large-playlist-index`,
      ),
    );
    expect(indexed.status).toBe(200);
    expect((await responseJson(indexed)).snapshot.playlist).toHaveLength(161);
  });

  it('reserves, HEAD-validates, downloads, and safely deletes a private R2 asset', async () => {
    const { worker, state, bucket, ownerCookie } = await activatedRoom();
    const reserve = await worker.fetch(
      jsonRequest(
        '/media/reservations',
        'POST',
        { byteLength: 1024, name: 'Track.flac', mime: 'audio/flac', sha256: 'a'.repeat(64) },
        ownerCookie,
        IDEMPOTENCY_KEY,
      ),
    );
    expect(reserve.status).toBe(200);
    const reservation = await responseJson(reserve);
    expect(Object.keys(reservation)).toEqual(['reservation', 'quota']);
    expect(Object.keys(reservation.reservation)).toEqual([
      'assetId',
      'version',
      'byteLength',
      'expiresAtMs',
      'upload',
    ]);
    expect(reservation.reservation.upload.url).toContain(
      `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/`,
    );
    expect(reservation.reservation.upload.headers).not.toHaveProperty('content-length');
    expect(
      new URL(reservation.reservation.upload.url).searchParams
        .get('X-Amz-SignedHeaders')
        ?.split(';'),
    ).toContain('content-length');
    expect(reservation.reservation.upload.headers).not.toHaveProperty('x-amz-meta-mxqr-generation');
    expect(JSON.stringify(reservation)).not.toContain('objectKey');

    const stored = state.storage.data.get('pro-room:v1') as StoredRoom;
    const asset = stored.assets[reservation.reservation.assetId];
    bucket.objects.set(asset.stagingObjectKey, {
      size: asset.byteLength,
      httpMetadata: { contentType: asset.mime },
      customMetadata: {
        'mxqr-room': ROOM_CODE,
        'mxqr-generation': String(asset.roomGeneration ?? 0),
        'mxqr-asset': reservation.reservation.assetId,
        'mxqr-version': '1',
        'mxqr-bytes': String(asset.byteLength),
        'mxqr-sha256': 'a'.repeat(64),
      },
    });
    const complete = await worker.fetch(
      request(
        `/media/${reservation.reservation.assetId}/complete`,
        { method: 'POST', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-complete` } },
        ownerCookie,
      ),
    );
    expect(complete.status).toBe(200);
    const completeEnvelope = await responseJson(complete);
    expect(Object.keys(completeEnvelope)).toEqual(['asset', 'quota']);
    expect(completeEnvelope.quota).toMatchObject({
      usedBytes: 1024,
      reservedBytes: 0,
    });

    const download = await worker.fetch(
      request(`/media/${reservation.reservation.assetId}/download`, {}, ownerCookie),
    );
    const downloadEnvelope = await responseJson(download);
    expect(Object.keys(downloadEnvelope)).toEqual(['asset', 'download']);
    expect(downloadEnvelope.download.url).toContain(
      `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/`,
    );
    const remove = await worker.fetch(
      request(
        `/media/${reservation.reservation.assetId}`,
        { method: 'DELETE', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-delete` } },
        ownerCookie,
      ),
    );
    const deleteEnvelope = await responseJson(remove);
    expect(Object.keys(deleteEnvelope)).toEqual(['ok', 'assetId', 'quota']);
    expect(deleteEnvelope.quota).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    expect(bucket.deleted).toContain(asset.objectKey);
    expect(bucket.deleted).toContain(asset.stagingObjectKey);
  });

  it('serializes quota reservations so six 200 MiB requests cannot exceed 1 GiB', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const results: Response[] = [];
    for (let index = 0; index < 6; index += 1) {
      results.push(
        await worker.fetch(
          jsonRequest(
            '/media/reservations',
            'POST',
            { byteLength: 200 * 1024 * 1024, name: `${index}.wav`, mime: 'audio/wav' },
            ownerCookie,
            `${IDEMPOTENCY_KEY}-quota-${index}`,
          ),
        ),
      );
    }
    expect(results.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 409]);
    expect(await responseJson(results[5]!)).toEqual({ error: 'ROOM_QUOTA_EXCEEDED' });
  });

  it('cancels a staged reservation only after its R2 object is safely deleted', async () => {
    const { worker, state, bucket, ownerCookie } = await activatedRoom();
    const reservation = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/media/reservations',
          'POST',
          { byteLength: 4096, name: 'cancelled.wav', mime: 'audio/wav' },
          ownerCookie,
          IDEMPOTENCY_KEY,
        ),
      ),
    );
    const assetId = reservation.reservation.assetId as string;
    const asset = (state.storage.data.get('pro-room:v1') as StoredRoom).assets[assetId]!;
    bucket.objects.set(asset.stagingObjectKey, { staged: true });

    const remove = await worker.fetch(
      request(
        `/media/${assetId}`,
        { method: 'DELETE', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-cancel` } },
        ownerCookie,
      ),
    );
    expect(remove.status).toBe(200);
    const removeEnvelope = await responseJson(remove);
    expect(removeEnvelope).toMatchObject({
      ok: true,
      assetId,
      quota: { usedBytes: 0, reservedBytes: 0 },
    });
    expect(bucket.deleted).toContain(asset.stagingObjectKey);
    expect(bucket.objects.has(asset.stagingObjectKey)).toBe(false);
    const stored = state.storage.data.get('pro-room:v1') as StoredRoom & {
      quota: { usedBytes: number; reservedBytes: number };
    };
    expect(stored.assets[assetId]).toBeUndefined();
    expect(stored.quota).toMatchObject({ usedBytes: 0, reservedBytes: 0 });

    const replay = await worker.fetch(
      request(
        `/media/${assetId}`,
        { method: 'DELETE', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-cancel` } },
        ownerCookie,
      ),
    );
    expect(await responseJson(replay)).toEqual(removeEnvelope);
    expect(bucket.deleted.filter((key) => key === asset.stagingObjectKey)).toHaveLength(1);
  });

  it('keeps an abort tombstone until a reusable staging URL has expired and is cleaned again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T05:00:00.000Z'));
    const { worker, bucket, ownerCookie } = await activatedRoom();
    const reservation = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/media/reservations',
          'POST',
          { byteLength: 4096, name: 'replay.wav', mime: 'audio/wav' },
          ownerCookie,
          `${IDEMPOTENCY_KEY}-tombstone-reserve`,
        ),
      ),
    );
    const assetId = reservation.reservation.assetId as string;
    const internal = worker as unknown as {
      room: StoredRoom & {
        stagingTombstones: Record<
          string,
          { objectKey: string; cleanupAfterMs: number; emptySinceMs?: number }
        >;
      };
      alarm(): Promise<void>;
    };
    const stagingObjectKey = internal.room.assets[assetId]!.stagingObjectKey;
    bucket.objects.set(stagingObjectKey, { staged: true });
    const removed = await worker.fetch(
      request(
        `/media/${assetId}`,
        {
          method: 'DELETE',
          headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-tombstone-delete` },
        },
        ownerCookie,
      ),
    );
    expect(removed.status).toBe(200);
    expect(internal.room.assets[assetId]).toBeUndefined();
    expect(internal.room.stagingTombstones[assetId]?.objectKey).toBe(stagingObjectKey);

    // Model a malicious reuse of the still-valid presigned PUT after abort.
    bucket.objects.set(stagingObjectKey, { staged: 'recreated' });
    internal.room.stagingTombstones[assetId]!.cleanupAfterMs = Date.now() - 1;
    await internal.alarm();
    expect(bucket.objects.has(stagingObjectKey)).toBe(false);
    expect(internal.room.stagingTombstones[assetId]).toMatchObject({
      objectKey: stagingObjectKey,
      emptySinceMs: Date.now(),
    });

    // A second slow PUT completing well after the first delete restarts the
    // continuous-empty proof instead of surviving a one-shot cleanup.
    vi.setSystemTime(new Date(Date.now() + 30 * 60 * 1000));
    bucket.objects.set(stagingObjectKey, { staged: 'completed-late' });
    internal.room.stagingTombstones[assetId]!.cleanupAfterMs = Date.now() - 1;
    await internal.alarm();
    expect(bucket.objects.has(stagingObjectKey)).toBe(false);
    expect(internal.room.stagingTombstones[assetId]?.emptySinceMs).toBe(Date.now());

    vi.setSystemTime(new Date(Date.now() + 60 * 60 * 1000 - 1));
    internal.room.stagingTombstones[assetId]!.cleanupAfterMs = Date.now() - 1;
    await internal.alarm();
    expect(internal.room.stagingTombstones[assetId]).toBeDefined();

    vi.setSystemTime(new Date(Date.now() + 2));
    internal.room.stagingTombstones[assetId]!.cleanupAfterMs = Date.now() - 1;
    await internal.alarm();
    expect(internal.room.stagingTombstones[assetId]).toBeUndefined();
  });

  it('promotes a verified staging upload to an immutable final key before exposing download', async () => {
    const context = await activatedRoom();
    const { assetId, asset } = await completeReadyAsset(context, 'immutable', 4096);
    const finalObjectKey = asset.objectKey;
    const stagingObjectKey = asset.stagingObjectKey;
    expect(finalObjectKey).toContain('/object_');
    expect(stagingObjectKey).toContain('/staging_');
    expect(context.bucket.objects.get(finalObjectKey)?.size).toBe(4096);
    expect(context.bucket.objects.has(stagingObjectKey)).toBe(false);

    // Reusing the upload URL can only recreate staging; it cannot overwrite
    // the fresh final key referenced by the ready asset and download URL.
    context.bucket.objects.set(stagingObjectKey, { size: 5 * 1024 * 1024 * 1024 });
    const download = await responseJson(
      await context.worker.fetch(request(`/media/${assetId}/download`, {}, context.ownerCookie)),
    );
    expect(download.download.url).toContain('/object_');
    expect(download.download.url).not.toContain('/staging_');
    expect(context.bucket.objects.get(finalObjectKey)?.size).toBe(4096);

    const internal = context.worker as unknown as { alarm(): Promise<void> };
    asset.stagingCleanupAfterMs = Date.now() - 1;
    await internal.alarm();
    expect(context.bucket.objects.has(stagingObjectKey)).toBe(false);
    expect(context.bucket.objects.get(finalObjectKey)?.size).toBe(4096);
    expect((asset as any).stagingEmptySinceMs).toBeTypeOf('number');

    context.bucket.objects.set(stagingObjectKey, { size: 9 * 1024 * 1024 * 1024 });
    asset.stagingCleanupAfterMs = Date.now() - 1;
    await internal.alarm();
    expect(context.bucket.objects.has(stagingObjectKey)).toBe(false);
    expect(context.bucket.objects.get(finalObjectKey)?.size).toBe(4096);
    expect(asset.stagingObjectKey).toBe(stagingObjectKey);

    (asset as any).stagingEmptySinceMs = Date.now() - 60 * 60 * 1000 - 1;
    asset.stagingCleanupAfterMs = Date.now() - 1;
    await internal.alarm();
    expect(asset.stagingObjectKey).toBeUndefined();
  });

  it('keeps staged quota reserved when R2 deletion fails so cleanup can be retried', async () => {
    const { worker, state, bucket, ownerCookie } = await activatedRoom();
    const reservation = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/media/reservations',
          'POST',
          { byteLength: 8192, name: 'retry.wav', mime: 'audio/wav' },
          ownerCookie,
          IDEMPOTENCY_KEY,
        ),
      ),
    );
    const assetId = reservation.reservation.assetId as string;
    const asset = (state.storage.data.get('pro-room:v1') as StoredRoom).assets[assetId]!;
    bucket.objects.set(asset.stagingObjectKey, { staged: true });
    bucket.deleteError = new Error('temporary R2 failure');

    const failed = await worker.fetch(
      request(
        `/media/${assetId}`,
        { method: 'DELETE', headers: { 'idempotency-key': `${IDEMPOTENCY_KEY}-retry` } },
        ownerCookie,
      ),
    );
    expect(failed.status).toBe(503);
    expect(await responseJson(failed)).toEqual({ error: 'MEDIA_STORAGE_UNAVAILABLE' });
    let stored = state.storage.data.get('pro-room:v1') as StoredRoom & {
      quota: { usedBytes: number; reservedBytes: number };
    };
    expect(stored.assets[assetId]).toBeDefined();
    expect(stored.quota).toMatchObject({ usedBytes: 0, reservedBytes: 8192 });

    const internal = worker as unknown as {
      room: {
        assets: Record<
          string,
          { expiresAtMs: number; objectKey: string; stagingObjectKey: string }
        >;
        quota: { reservedBytes: number };
      };
      alarm(): Promise<void>;
    };
    internal.room.assets[assetId]!.expiresAtMs = Date.now() - 1;
    bucket.deleteError = null;
    await internal.alarm();
    stored = state.storage.data.get('pro-room:v1') as StoredRoom & {
      quota: { usedBytes: number; reservedBytes: number };
    };
    expect(stored.assets[assetId]).toBeUndefined();
    expect(stored.quota).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    expect(bucket.deleted).toContain(asset.stagingObjectKey);
  });

  it('scopes idempotency replay records to one authenticated member', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const controller = await worker.fetch(jsonRequest('/sessions', 'POST', { pin: '12345678' }));
    const controllerCookie = cookieFrom(controller);
    bindCookiePresence(controllerCookie, await responseJson(controller));
    const body = { byteLength: 1024, name: 'same.wav', mime: 'audio/wav' };
    const ownerReservation = await responseJson(
      await worker.fetch(
        jsonRequest('/media/reservations', 'POST', body, ownerCookie, IDEMPOTENCY_KEY),
      ),
    );
    const controllerReservation = await responseJson(
      await worker.fetch(
        jsonRequest('/media/reservations', 'POST', body, controllerCookie, IDEMPOTENCY_KEY),
      ),
    );
    expect(controllerReservation.reservation.assetId).not.toBe(
      ownerReservation.reservation.assetId,
    );
    expect(controllerReservation.quota.reservedBytes).toBe(2048);
  });

  it('cleans an expired staged object by alarm before releasing reserved quota', async () => {
    const { worker, bucket, ownerCookie } = await activatedRoom();
    const reservation = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/media/reservations',
          'POST',
          { byteLength: 4096, name: 'expired.wav', mime: 'audio/wav' },
          ownerCookie,
          IDEMPOTENCY_KEY,
        ),
      ),
    );
    const internal = worker as unknown as {
      room: {
        assets: Record<
          string,
          { expiresAtMs: number; objectKey: string; stagingObjectKey: string }
        >;
        quota: { reservedBytes: number };
      };
      alarm(): Promise<void>;
    };
    const asset = internal.room.assets[reservation.reservation.assetId]!;
    const objectKey = asset.stagingObjectKey;
    asset.expiresAtMs = Date.now() - 1;
    await internal.alarm();
    expect(bucket.deleted).toContain(objectKey);
    expect(internal.room.assets[reservation.reservation.assetId]).toBeUndefined();
    expect(internal.room.quota.reservedBytes).toBe(0);
  });
});

describe('PRO room system-audio ownership lease', () => {
  const publication = {
    publicationId: 'publication_018f977e5df57c8f',
    sessionId: 'session_018f977e5df57c8fbb80',
    tracks: [
      { trackName: 'mxqr-system-audio-000001-L-track', channel: 'L' },
      { trackName: 'mxqr-system-audio-000001-R-track', channel: 'R', mid: '1' },
    ],
  } as const;

  async function acquireSystemAudio(
    worker: MusixquareProRoom,
    cookie: string,
  ): Promise<Record<string, any>> {
    const response = await worker.fetch(jsonRequest('/system-audio/acquire', 'POST', {}, cookie));
    expect(response.status).toBe(200);
    return responseJson(response);
  }

  it('keeps the v1 snapshot shape unchanged and exposes live state only through its own API', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const snapshotResponse = await worker.fetch(request('/snapshot', {}, ownerCookie));
    const snapshotEnvelope = await responseJson(snapshotResponse);
    expect(parseProRoomSnapshot(snapshotEnvelope.snapshot)).not.toBeNull();
    expect(snapshotEnvelope.snapshot).not.toHaveProperty('systemAudio');
    expect(snapshotEnvelope.snapshot.viewer.capabilities).not.toContain('system-audio.publish');

    const stateResponse = await worker.fetch(request('/system-audio', {}, ownerCookie));
    expect(stateResponse.status).toBe(200);
    expect(await responseJson(stateResponse)).toEqual({
      systemAudio: {
        generation: 0,
        status: 'idle',
        ownerParticipantId: null,
        claimExpiresAt: null,
        liveExpiresAt: null,
        publication: null,
      },
    });
  });

  it('requires an authenticated active presence and fences mutations by owner, generation, and lease', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    expect((await worker.fetch(jsonRequest('/system-audio/acquire', 'POST', {}))).status).toBe(401);

    const memberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const memberCookie = cookieFrom(memberResponse);
    bindCookiePresence(memberCookie, await responseJson(memberResponse));
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    const generation = acquired.systemAudio.generation as number;
    const leaseId = acquired.leaseId as string;
    expect(leaseId).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const wrongOwner = await worker.fetch(
      jsonRequest(
        '/system-audio/commit',
        'POST',
        { generation, leaseId, publication },
        memberCookie,
      ),
    );
    expect(wrongOwner.status).toBe(409);
    expect(await responseJson(wrongOwner)).toEqual({ error: 'SYSTEM_AUDIO_NOT_OWNER' });

    const wrongGeneration = await worker.fetch(
      jsonRequest(
        '/system-audio/heartbeat',
        'POST',
        { generation: generation + 1, leaseId },
        ownerCookie,
      ),
    );
    expect(wrongGeneration.status).toBe(409);
    expect(await responseJson(wrongGeneration)).toEqual({
      error: 'SYSTEM_AUDIO_GENERATION_MISMATCH',
    });

    const wrongLease = await worker.fetch(
      jsonRequest(
        '/system-audio/release',
        'POST',
        { generation, leaseId: 'x'.repeat(43) },
        ownerCookie,
      ),
    );
    expect(wrongLease.status).toBe(409);
    expect(await responseJson(wrongLease)).toEqual({ error: 'SYSTEM_AUDIO_LEASE_INVALID' });
  });

  it('returns the same private lease on an owner retry without extending the fixed claim', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    const internal = worker as unknown as {
      room: {
        presence: {
          participants: Record<string, { lastSeenAtMs: number }>;
        };
      };
    };
    const participant =
      internal.room.presence.participants[acquired.systemAudio.ownerParticipantId]!;
    const staleButActiveLastSeenAtMs = Date.now() - 40_000;
    participant.lastSeenAtMs = staleButActiveLastSeenAtMs;

    const retry = await acquireSystemAudio(worker, ownerCookie);

    expect(retry.leaseId).toBe(acquired.leaseId);
    expect(retry.systemAudio).toEqual(acquired.systemAudio);
    expect(participant.lastSeenAtMs).toBeGreaterThan(staleButActiveLastSeenAtMs);
  });

  it('never publishes the lease, owner incarnation, or Cloudflare session owner token', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    const generation = acquired.systemAudio.generation as number;
    const leaseId = acquired.leaseId as string;
    expect(Object.keys(acquired).sort()).toEqual(['leaseId', 'systemAudio']);
    expect(JSON.stringify(acquired.systemAudio)).not.toContain(leaseId);
    expect(acquired.systemAudio).not.toHaveProperty('ownerPresenceIncarnationId');

    const leakedToken = await worker.fetch(
      jsonRequest(
        '/system-audio/commit',
        'POST',
        {
          generation,
          leaseId,
          publication: { ...publication, sessionOwnerToken: 'must-never-be-stored' },
        },
        ownerCookie,
      ),
    );
    expect(leakedToken.status).toBe(400);
    expect(await responseJson(leakedToken)).toEqual({ error: 'INVALID_REQUEST' });

    const committed = await worker.fetch(
      jsonRequest(
        '/system-audio/commit',
        'POST',
        { generation, leaseId, publication },
        ownerCookie,
      ),
    );
    expect(committed.status).toBe(200);
    const committedEnvelope = await responseJson(committed);
    expect(committedEnvelope).toEqual({
      systemAudio: expect.objectContaining({ status: 'live', publication }),
    });
    expect(JSON.stringify(committedEnvelope)).not.toContain(leaseId);
    expect(JSON.stringify(committedEnvelope)).not.toContain('sessionOwnerToken');

    const observed = await responseJson(
      await worker.fetch(request('/system-audio', {}, ownerCookie)),
    );
    expect(JSON.stringify(observed)).not.toContain(leaseId);
    expect(observed.systemAudio).not.toHaveProperty('ownerPresenceIncarnationId');
  });

  it('makes commit response-loss retries idempotent without extending the two-hour deadline', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    const body = {
      generation: acquired.systemAudio.generation,
      leaseId: acquired.leaseId,
      publication,
    };
    const first = await responseJson(
      await worker.fetch(jsonRequest('/system-audio/commit', 'POST', body, ownerCookie)),
    );
    const retry = await responseJson(
      await worker.fetch(jsonRequest('/system-audio/commit', 'POST', body, ownerCookie)),
    );
    expect(retry).toEqual(first);

    const conflicting = await worker.fetch(
      jsonRequest(
        '/system-audio/commit',
        'POST',
        {
          ...body,
          publication: { ...publication, publicationId: 'publication_018f977e5df57c9f' },
        },
        ownerCookie,
      ),
    );
    expect(conflicting.status).toBe(409);
    expect(await responseJson(conflicting)).toEqual({
      error: 'SYSTEM_AUDIO_ALREADY_COMMITTED',
    });
  });

  it('fails closed and durably fences malformed stored live state', async () => {
    const { worker, state, ownerCookie, activationEnvelope } = await activatedRoom();
    const internal = worker as unknown as {
      room: { systemAudio: Record<string, unknown> };
    };
    internal.room.systemAudio = {
      generation: 11,
      status: 'live',
      ownerParticipantId: activationEnvelope.snapshot.viewer.participantId,
      ownerPresenceIncarnationId: activationEnvelope.snapshot.viewer.presenceIncarnationId,
      leaseId: 'z'.repeat(43),
      claimExpiresAt: null,
      liveExpiresAt: Date.now() + 60_000,
      publication: { ...publication, sessionOwnerToken: 'must-not-survive-migration' },
    };

    const observed = await responseJson(
      await worker.fetch(request('/system-audio', {}, ownerCookie)),
    );
    expect(observed).toEqual({
      systemAudio: {
        generation: 12,
        status: 'idle',
        ownerParticipantId: null,
        claimExpiresAt: null,
        liveExpiresAt: null,
        publication: null,
      },
    });
    const stored = (await state.storage.get('pro-room:v1')) as {
      systemAudio: Record<string, unknown>;
    };
    expect(stored.systemAudio).toEqual(
      expect.objectContaining({ generation: 12, status: 'idle', leaseId: null }),
    );
    expect(JSON.stringify(stored.systemAudio)).not.toContain('sessionOwnerToken');
  });

  it('migrates an old stored room when its alarm fires before any HTTP request', async () => {
    const context = await activatedRoom();
    const legacyRoom = (await context.state.storage.get('pro-room:v1')) as Record<string, unknown>;
    delete legacyRoom.systemAudio;

    const reloadedState = new FakeState();
    reloadedState.storage.data.set('pro-room:v1', legacyRoom);
    const reloadedWorker = new MusixquareProRoom(
      reloadedState as never,
      environment(context.bucket) as never,
    ) as MusixquareProRoom & { alarm(): Promise<void> };

    await expect(reloadedWorker.alarm()).resolves.toBeUndefined();

    const migrated = (await reloadedState.storage.get('pro-room:v1')) as {
      systemAudio: Record<string, unknown>;
    };
    expect(migrated.systemAudio).toEqual({
      generation: 0,
      status: 'idle',
      ownerParticipantId: null,
      ownerPresenceIncarnationId: null,
      leaseId: null,
      claimExpiresAt: null,
      liveExpiresAt: null,
      publication: null,
    });
    expect(reloadedState.storage.alarm).toEqual(expect.any(Number));
  });

  it('holds preparing for at most 45 seconds and live for at most two hours without heartbeat extension', async () => {
    const { worker, state, ownerCookie } = await activatedRoom();
    const acquiredAt = Date.now();
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    expect(acquired.systemAudio.claimExpiresAt).toBeGreaterThanOrEqual(acquiredAt + 45_000);
    expect(acquired.systemAudio.claimExpiresAt).toBeLessThanOrEqual(Date.now() + 45_000);
    const claimExpiresAt = acquired.systemAudio.claimExpiresAt as number;

    const preparingHeartbeat = await worker.fetch(
      jsonRequest(
        '/system-audio/heartbeat',
        'POST',
        { generation: acquired.systemAudio.generation, leaseId: acquired.leaseId },
        ownerCookie,
      ),
    );
    expect((await responseJson(preparingHeartbeat)).systemAudio.claimExpiresAt).toBe(
      claimExpiresAt,
    );

    const committedAt = Date.now();
    const committed = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/system-audio/commit',
          'POST',
          {
            generation: acquired.systemAudio.generation,
            leaseId: acquired.leaseId,
            publication,
          },
          ownerCookie,
        ),
      ),
    );
    expect(committed.systemAudio.liveExpiresAt).toBeGreaterThanOrEqual(
      committedAt + SYSTEM_AUDIO_SHARE_LIMIT_MS,
    );
    expect(committed.systemAudio.liveExpiresAt).toBeLessThanOrEqual(
      Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS,
    );
    const liveExpiresAt = committed.systemAudio.liveExpiresAt as number;
    const liveHeartbeat = await responseJson(
      await worker.fetch(
        jsonRequest(
          '/system-audio/heartbeat',
          'POST',
          { generation: acquired.systemAudio.generation, leaseId: acquired.leaseId },
          ownerCookie,
        ),
      ),
    );
    expect(liveHeartbeat.systemAudio.liveExpiresAt).toBe(liveExpiresAt);

    const internal = worker as unknown as {
      room: { systemAudio: { generation: number; liveExpiresAt: number } };
      alarm(): Promise<void>;
    };
    const liveGeneration = internal.room.systemAudio.generation;
    internal.room.systemAudio.liveExpiresAt = Date.now() - 1;
    await internal.alarm();
    expect(internal.room.systemAudio).toMatchObject({
      generation: liveGeneration + 1,
      status: 'idle',
    });
    expect(state.storage.alarm).not.toBe(liveExpiresAt);
  });

  it('expires an abandoned preparing claim and allows a new participant to acquire afterward', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    const internal = worker as unknown as {
      room: {
        systemAudio: { generation: number; status: string; claimExpiresAt: number };
      };
      alarm(): Promise<void>;
    };
    internal.room.systemAudio.claimExpiresAt = Date.now() - 1;
    await internal.alarm();
    expect(internal.room.systemAudio).toMatchObject({
      generation: acquired.systemAudio.generation + 1,
      status: 'idle',
    });

    const memberResponse = await worker.fetch(
      jsonRequest('/sessions', 'POST', { pin: '12345678' }),
    );
    const memberCookie = cookieFrom(memberResponse);
    bindCookiePresence(memberCookie, await responseJson(memberResponse));
    const next = await acquireSystemAudio(worker, memberCookie);
    expect(next.systemAudio).toMatchObject({
      generation: acquired.systemAudio.generation + 2,
      status: 'preparing',
    });
  });

  it('rejects acquisition above four devices and revokes a live share when the fifth joins', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    for (let index = 1; index < MAX_SYSTEM_AUDIO_DEVICES; index += 1) {
      const response = await worker.fetch(
        jsonRequest('/sessions', 'POST', {
          pin: '12345678',
        }),
      );
      const cookie = cookieFrom(response);
      bindCookiePresence(cookie, await responseJson(response));
    }
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    const committed = await worker.fetch(
      jsonRequest(
        '/system-audio/commit',
        'POST',
        {
          generation: acquired.systemAudio.generation,
          leaseId: acquired.leaseId,
          publication,
        },
        ownerCookie,
      ),
    );
    expect(committed.status).toBe(200);

    const fifth = await worker.fetch(
      jsonRequest('/sessions', 'POST', {
        pin: '12345678',
      }),
    );
    expect(fifth.status).toBe(200);
    const fifthCookie = cookieFrom(fifth);
    bindCookiePresence(fifthCookie, await responseJson(fifth));

    const afterJoin = await responseJson(
      await worker.fetch(request('/system-audio', {}, ownerCookie)),
    );
    expect(afterJoin.systemAudio).toMatchObject({
      generation: acquired.systemAudio.generation + 1,
      status: 'idle',
      ownerParticipantId: null,
      publication: null,
    });
    const blocked = await worker.fetch(
      jsonRequest('/system-audio/acquire', 'POST', {}, fifthCookie),
    );
    expect(blocked.status).toBe(409);
    expect(await responseJson(blocked)).toEqual({ error: 'SYSTEM_AUDIO_DEVICE_LIMIT' });
  });

  it('revokes ownership when its exact presence leaves or is superseded', async () => {
    const { worker, ownerCookie } = await activatedRoom();
    const acquired = await acquireSystemAudio(worker, ownerCookie);
    const takeover = await worker.fetch(
      jsonRequest('/presence/enter', 'POST', { takeover: true }, ownerCookie),
    );
    expect(takeover.status).toBe(200);
    const takeoverEnvelope = await responseJson(takeover);
    bindCookiePresence(ownerCookie, takeoverEnvelope);
    expect(takeoverEnvelope.snapshot).not.toHaveProperty('systemAudio');
    const superseded = await responseJson(
      await worker.fetch(request('/system-audio', {}, ownerCookie)),
    );
    expect(superseded.systemAudio).toMatchObject({
      generation: acquired.systemAudio.generation + 1,
      status: 'idle',
    });

    const reacquired = await acquireSystemAudio(worker, ownerCookie);
    const left = await worker.fetch(
      request('/presence/current', { method: 'DELETE' }, ownerCookie),
    );
    expect(left.status).toBe(200);
    const internal = worker as unknown as {
      room: { systemAudio: { generation: number; status: string } };
    };
    expect(internal.room.systemAudio).toMatchObject({
      generation: reacquired.systemAudio.generation + 1,
      status: 'idle',
    });
  });
});

describe('persistent PRO room orphan asset garbage collection', () => {
  it('marks a completed orphan without sliding its grace deadline and schedules it', async () => {
    const context = await activatedRoom();
    const beforeCompleteMs = Date.now();
    const { asset } = await completeReadyAsset(context, 'gc-orphan');

    expect(asset.status).toBe('ready');
    expect(asset.gcAfterMs).toBeGreaterThanOrEqual(beforeCompleteMs + 15 * 60 * 1000);
    const originalDeadline = asset.gcAfterMs;

    const accepted = await replacePlaylist(context, [], 'gc-orphan-empty');
    expect(accepted.status).toBe(200);
    expect(asset.gcAfterMs).toBe(originalDeadline);

    await context.worker.fetch(
      request('/presence/current', { method: 'DELETE' }, context.ownerCookie),
    );
    expect(context.state.storage.alarm).toBe(asset.stagingCleanupAfterMs);
    expect(context.state.storage.alarm).toBeLessThan(originalDeadline!);
  });

  it('cancels orphan collection when an accepted snapshot references the asset', async () => {
    const context = await activatedRoom();
    const { asset } = await completeReadyAsset(context, 'gc-reference');
    expect(asset.gcAfterMs).toEqual(expect.any(Number));

    const response = await replacePlaylist(
      context,
      [playlistItem('11111111-1111-4111-8111-111111111111', asset)],
      'gc-reference-add',
    );
    expect(response.status).toBe(200);
    expect(asset.gcAfterMs).toBeUndefined();
    expect(context.bucket.objects.has(asset.objectKey)).toBe(true);
  });

  it('deletes an expired unreferenced asset before releasing used quota', async () => {
    const context = await activatedRoom();
    const { assetId, asset } = await completeReadyAsset(context, 'gc-success', 8192);
    const internal = context.worker as unknown as {
      room: StoredRoom;
      alarm(): Promise<void>;
    };
    const revisionBeforeGc = internal.room.revision;
    asset.gcAfterMs = Date.now() - 1;

    await internal.alarm();

    expect(context.bucket.deleted).toContain(asset.objectKey);
    expect(context.bucket.objects.has(asset.objectKey)).toBe(false);
    expect(internal.room.assets[assetId]).toBeUndefined();
    expect(internal.room.quota).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    expect(internal.room.revision).toBe(revisionBeforeGc + 1);
  });

  it('postpones failed R2 collection without releasing quota, then retries safely', async () => {
    const context = await activatedRoom();
    const { assetId, asset } = await completeReadyAsset(context, 'gc-retry', 16_384);
    const internal = context.worker as unknown as {
      room: StoredRoom;
      alarm(): Promise<void>;
    };
    await context.worker.fetch(
      request('/presence/current', { method: 'DELETE' }, context.ownerCookie),
    );
    const revisionBeforeFailure = internal.room.revision;
    asset.gcAfterMs = Date.now() - 1;
    context.bucket.deleteError = new Error('temporary R2 outage');

    await internal.alarm();

    expect(internal.room.assets[assetId]).toBe(asset);
    expect(internal.room.quota).toMatchObject({ usedBytes: 16_384, reservedBytes: 0 });
    expect(internal.room.quota.usedBytes + internal.room.quota.reservedBytes).toBeLessThanOrEqual(
      internal.room.quota.limitBytes,
    );
    expect(internal.room.revision).toBe(revisionBeforeFailure);
    expect(asset.gcAfterMs).toBeGreaterThan(Date.now());
    expect(context.state.storage.alarm).toBe(asset.gcAfterMs);

    context.bucket.deleteError = null;
    asset.gcAfterMs = Date.now() - 1;
    await internal.alarm();
    expect(internal.room.assets[assetId]).toBeUndefined();
    expect(internal.room.quota).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    expect(context.bucket.deleted).toContain(asset.objectKey);
  });

  it('keeps a shared asset until the final playlist reference is removed', async () => {
    const context = await activatedRoom();
    const { assetId, asset } = await completeReadyAsset(context, 'gc-shared');
    const first = playlistItem('22222222-2222-4222-8222-222222222222', asset);
    const second = playlistItem('33333333-3333-4333-8333-333333333333', asset);
    expect((await replacePlaylist(context, [first, second], 'gc-shared-two')).status).toBe(200);
    expect(asset.gcAfterMs).toBeUndefined();

    expect((await replacePlaylist(context, [second], 'gc-shared-one')).status).toBe(200);
    expect(asset.gcAfterMs).toBeUndefined();

    // Even a stale/corrupt marker is rechecked against every remaining
    // reference at collection time.
    asset.gcAfterMs = Date.now() - 1;
    const internal = context.worker as unknown as {
      room: StoredRoom;
      alarm(): Promise<void>;
    };
    await internal.alarm();
    expect(internal.room.assets[assetId]).toBe(asset);
    expect(asset.gcAfterMs).toBeUndefined();
    expect(context.bucket.deleted).not.toContain(asset.objectKey);

    expect((await replacePlaylist(context, [], 'gc-shared-none')).status).toBe(200);
    expect(asset.gcAfterMs).toEqual(expect.any(Number));
  });
});

describe('persistent PRO room audio effects', () => {
  const defaultEffects = {
    reverb: {
      mixPercent: 0,
      decaySeconds: 5,
      preDelaySeconds: 0.1,
      lowCutPercent: 0,
      highCutPercent: 0,
    },
    equalizer: { bandsDb: [0, 0, 0, 0, 0] },
    virtualBass: { strengthPercent: 0 },
    virtualSurround: { widthPercent: 100 },
  };
  const configuredEffects = {
    reverb: {
      mixPercent: 40,
      decaySeconds: 1,
      preDelaySeconds: 0.02,
      lowCutPercent: 0,
      highCutPercent: 0,
    },
    equalizer: { bandsDb: [0, -2, 0, 4, 6] },
    virtualBass: { strengthPercent: 60 },
    virtualSurround: { widthPercent: 120 },
  };
  const configuredEffectsV2 = {
    ...configuredEffects,
    virtualTreble: { enabled: true },
  };

  it('negotiates virtual treble v2 while legacy full updates preserve the canonical value', async () => {
    const context = await activatedRoom();
    const epoch = context.activationEnvelope.snapshot.presence.coordinatorEpoch as number;
    const v2Get = request(
      '/effects',
      {
        headers: { 'x-mxqr-pro-effects-version': '2' },
      },
      context.ownerCookie,
    );
    await expect((await context.worker.fetch(v2Get)).json()).resolves.toEqual({
      schemaVersion: 2,
      view: 'effects',
      roomCode: ROOM_CODE,
      revision: 0,
      updatedAtMs: 0,
      effects: { ...defaultEffects, virtualTreble: { enabled: false } },
    });

    const v2Update = jsonRequest(
      '/effects',
      'PUT',
      { coordinatorEpoch: epoch, baseRevision: 0, effects: configuredEffectsV2 },
      context.ownerCookie,
    );
    v2Update.headers.set('x-mxqr-pro-effects-version', '2');
    await expect((await context.worker.fetch(v2Update)).json()).resolves.toMatchObject({
      schemaVersion: 2,
      revision: 1,
      effects: configuredEffectsV2,
    });

    const legacyUpdate = await context.worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        {
          coordinatorEpoch: epoch,
          baseRevision: 1,
          effects: { ...configuredEffects, virtualBass: { strengthPercent: 25 } },
        },
        context.ownerCookie,
      ),
    );
    const legacyPayload = await responseJson(legacyUpdate);
    expect(legacyPayload).toMatchObject({
      schemaVersion: 1,
      effects: { ...configuredEffects, virtualBass: { strengthPercent: 25 } },
    });
    expect(legacyPayload.effects).toEqual({
      ...configuredEffects,
      virtualBass: { strengthPercent: 25 },
    });
    expect(legacyPayload.effects).not.toHaveProperty('virtualTreble');
    const internal = context.worker as unknown as { room: Record<string, any> };
    expect(internal.room.effects.effects.virtualTreble).toEqual({ enabled: true });

    const v2AfterLegacy = request(
      '/effects',
      {
        headers: { 'x-mxqr-pro-effects-version': '2' },
      },
      context.ownerCookie,
    );
    await expect((await context.worker.fetch(v2AfterLegacy)).json()).resolves.toMatchObject({
      schemaVersion: 2,
      revision: 2,
      effects: {
        virtualBass: { strengthPercent: 25 },
        virtualTreble: { enabled: true },
      },
    });
  });

  it('keeps rollback-readable effects in core and restores virtual treble from its sidecar', async () => {
    const context = await activatedRoom();
    const epoch = context.activationEnvelope.snapshot.presence.coordinatorEpoch as number;
    const update = jsonRequest(
      '/effects',
      'PUT',
      { coordinatorEpoch: epoch, baseRevision: 0, effects: configuredEffectsV2 },
      context.ownerCookie,
    );
    update.headers.set('x-mxqr-pro-effects-version', '2');
    expect((await context.worker.fetch(update)).status).toBe(200);

    const storedCore = structuredClone(context.state.storage.data.get('pro-room:v2:core')) as {
      core: Record<string, any>;
    };
    const legacyShadow = context.state.storage.data.get('pro-room:v1') as Record<string, any>;
    expect(storedCore.core.effects.effects).toEqual(configuredEffects);
    expect(legacyShadow.effects.effects).toEqual(configuredEffects);
    expect(context.state.storage.data.get('pro-room:v2:effects:virtual-treble')).toEqual({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      enabled: true,
    });

    // Simulate an old Worker changing a legacy effect while leaving the
    // unknown sidecar untouched, then roll forward to the new Worker again.
    storedCore.core.effects = {
      revision: 2,
      updatedAtMs: 4321,
      effects: {
        ...configuredEffects,
        reverb: { ...configuredEffects.reverb, mixPercent: 15 },
      },
    };
    context.state.storage.data.set('pro-room:v2:core', storedCore);
    const restarted = new MusixquareProRoom(
      context.state as never,
      environment(context.bucket) as never,
    );
    const get = request(
      '/effects',
      {
        headers: { 'x-mxqr-pro-effects-version': '2' },
      },
      context.ownerCookie,
    );
    await expect((await restarted.fetch(get)).json()).resolves.toMatchObject({
      schemaVersion: 2,
      revision: 2,
      effects: {
        reverb: { mixPercent: 15 },
        virtualTreble: { enabled: true },
      },
    });
  });

  it('persists one strict effects resource and publishes its revision head in snapshot v1', async () => {
    const context = await activatedRoom();
    const beforeSnapshot = context.activationEnvelope.snapshot;
    const dispatchFetch = vi.fn<(request: Request) => Promise<Response>>(async () =>
      Response.json({ broadcast: true, eligible: 1, sent: 1 }),
    );
    const internal = context.worker as unknown as { env: Record<string, any> };
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: dispatchFetch })),
    };
    const before = await responseJson(
      await context.worker.fetch(request('/effects', {}, context.ownerCookie)),
    );
    expect(before).toEqual({
      schemaVersion: 1,
      view: 'effects',
      roomCode: ROOM_CODE,
      revision: 0,
      updatedAtMs: 0,
      effects: defaultEffects,
    });

    const epoch = context.activationEnvelope.snapshot.presence.coordinatorEpoch as number;
    const updatedResponse = await context.worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        { coordinatorEpoch: epoch, baseRevision: 0, effects: configuredEffects },
        context.ownerCookie,
      ),
    );
    expect(updatedResponse.status).toBe(200);
    const updated = await responseJson(updatedResponse);
    expect(updated).toMatchObject({
      schemaVersion: 1,
      view: 'effects',
      revision: 1,
      effects: configuredEffects,
    });
    expect(updated.updatedAtMs).toBeGreaterThan(0);

    const snapshot = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(parseProRoomSnapshot(snapshot.snapshot)).not.toBeNull();
    expect(snapshot.snapshot).not.toHaveProperty('effects');
    expect(snapshot.snapshot).toMatchObject({
      revision: beforeSnapshot.revision + 1,
      effectsRevision: 1,
      queueModeRevision: 0,
    });
    const recovered = await responseJson(
      await context.worker.fetch(
        jsonRequest(
          '/presence/heartbeat',
          'POST',
          {
            revision: beforeSnapshot.revision,
            playlistRevision: beforeSnapshot.playlistRevision,
            presenceRevision: beforeSnapshot.presence.revision,
            playbackRevision: beforeSnapshot.playback.revision,
            coordinatorEpoch: beforeSnapshot.presence.coordinatorEpoch,
          },
          context.ownerCookie,
        ),
      ),
    );
    expect(recovered).not.toHaveProperty('notModified');
    expect(recovered.snapshot).toMatchObject({
      revision: beforeSnapshot.revision + 1,
      effectsRevision: 1,
    });
    expect(dispatchFetch).toHaveBeenCalledOnce();
    await expect(
      (dispatchFetch.mock.calls[0]?.[0] as Request).clone().json(),
    ).resolves.toMatchObject({
      event: { type: 'pro-room-invalidated', effectsRevision: 1 },
    });

    const developerRead = await internalDeveloperRead(context.worker, 'effects');
    expect(developerRead.status).toBe(200);
    await expect(developerRead.json()).resolves.toMatchObject({
      view: 'effects',
      revision: 1,
      effects: configuredEffects,
    });

    const restarted = new MusixquareProRoom(
      context.state as never,
      environment(context.bucket) as never,
    );
    const afterRestart = await responseJson(
      await restarted.fetch(request('/effects', {}, context.ownerCookie)),
    );
    expect(afterRestart).toMatchObject({ revision: 1, effects: configuredEffects });
  });

  it('rejects stale effects writers with the canonical resource and leaves revision unchanged', async () => {
    const context = await activatedRoom();
    const dispatchFetch = vi.fn(async () =>
      Response.json({ broadcast: true, eligible: 1, sent: 1 }),
    );
    const internal = context.worker as unknown as { env: Record<string, any> };
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: dispatchFetch })),
    };
    const epoch = context.activationEnvelope.snapshot.presence.coordinatorEpoch as number;

    const first = await context.worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        { coordinatorEpoch: epoch, baseRevision: 0, effects: configuredEffects },
        context.ownerCookie,
      ),
    );
    expect(first.status).toBe(200);

    const staleEffects = {
      ...configuredEffects,
      virtualBass: { strengthPercent: 10 },
    };
    const stale = await context.worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        { coordinatorEpoch: epoch, baseRevision: 0, effects: staleEffects },
        context.ownerCookie,
      ),
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      error: 'EFFECTS_REVISION_CONFLICT',
      effects: expect.objectContaining({ revision: 1, effects: configuredEffects }),
    });
    expect(dispatchFetch).toHaveBeenCalledOnce();

    const unchangedRetry = await context.worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        { coordinatorEpoch: epoch, baseRevision: 1, effects: configuredEffects },
        context.ownerCookie,
      ),
    );
    expect(unchangedRetry.status).toBe(200);
    await expect(unchangedRetry.json()).resolves.toMatchObject({
      revision: 1,
      effects: configuredEffects,
    });
    expect(dispatchFetch).toHaveBeenCalledOnce();
  });

  it('fences updates to the active room epoch and rejects malformed full state', async () => {
    const context = await activatedRoom();
    const epoch = context.activationEnvelope.snapshot.presence.coordinatorEpoch as number;

    const missingBaseRevision = await context.worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        { coordinatorEpoch: epoch, effects: configuredEffects },
        context.ownerCookie,
      ),
    );
    expect(missingBaseRevision.status).toBe(400);
    await expect(missingBaseRevision.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });

    const stale = await context.worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        { coordinatorEpoch: epoch + 1, baseRevision: 0, effects: configuredEffects },
        context.ownerCookie,
      ),
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: 'ROOM_EPOCH_MISMATCH' });

    const malformed = await context.worker.fetch(
      jsonRequest(
        '/effects',
        'PUT',
        {
          coordinatorEpoch: epoch,
          baseRevision: 0,
          effects: { ...configuredEffects, virtualBass: { strengthPercent: 101 } },
        },
        context.ownerCookie,
      ),
    );
    expect(malformed.status).toBe(400);
    const unchanged = await responseJson(
      await context.worker.fetch(request('/effects', {}, context.ownerCookie)),
    );
    expect(unchanged).toMatchObject({ revision: 0, effects: defaultEffects });
  });

  it('migrates pre-effects rooms to a neutral dedicated resource', async () => {
    const context = await activatedRoom();
    const stored = structuredClone(context.state.storage.data.get('pro-room:v2:core')) as {
      core: Record<string, unknown>;
    };
    delete stored.core.effects;
    context.state.storage.data.set('pro-room:v2:core', stored);

    const restarted = new MusixquareProRoom(
      context.state as never,
      environment(context.bucket) as never,
    );
    const response = await restarted.fetch(request('/effects', {}, context.ownerCookie));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      revision: 0,
      effects: defaultEffects,
    });
    expect(
      (
        context.state.storage.data.get('pro-room:v2:core') as {
          core: Record<string, unknown>;
        }
      ).core.effects,
    ).toBeDefined();
  });

  it('migrates stored effects without virtual treble to off without losing the revision', async () => {
    const context = await activatedRoom();
    const stored = structuredClone(context.state.storage.data.get('pro-room:v2:core')) as {
      core: Record<string, any>;
    };
    stored.core.effects = {
      revision: 7,
      updatedAtMs: 1234,
      effects: configuredEffects,
    };
    context.state.storage.data.set('pro-room:v2:core', stored);
    context.state.storage.data.delete('pro-room:v2:effects:virtual-treble');

    const restarted = new MusixquareProRoom(
      context.state as never,
      environment(context.bucket) as never,
    );
    const get = request(
      '/effects',
      {
        headers: { 'x-mxqr-pro-effects-version': '2' },
      },
      context.ownerCookie,
    );
    await expect((await restarted.fetch(get)).json()).resolves.toMatchObject({
      schemaVersion: 2,
      revision: 7,
      updatedAtMs: 1234,
      effects: { ...configuredEffects, virtualTreble: { enabled: false } },
    });
    expect(context.state.storage.data.get('pro-room:v2:effects:virtual-treble')).toMatchObject({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      enabled: false,
    });
  });

  it('applies set_effects on the server without a browser control capability', async () => {
    const dispatchFetch = vi.fn<(request: Request) => Promise<Response>>(async () =>
      Response.json({ dispatched: true }),
    );
    const context = await activatedRoom();
    const internal = context.worker as unknown as {
      env: Record<string, any>;
      room: Record<string, any>;
    };
    internal.env.PRO_SIGNALING_ROOMS = {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: dispatchFetch })),
    };
    const legacyCapability = await context.worker.fetch(
      jsonRequest(
        '/signaling-tickets',
        'POST',
        { developerControlVersion: 1 },
        context.ownerCookie,
      ),
    );
    expect(legacyCapability.status).toBe(200);
    const applied = await createInternalDeveloperCommand(
      context.worker,
      DEVELOPER_KEY_ID,
      'developer-effects-legacy-0001',
      { type: 'set_effects', effects: { virtualBass: { strengthPercent: 60 } } },
    );
    expect(applied.status).toBe(202);
    const body = await responseJson(applied);
    expect(body).toMatchObject({
      status: 'applied',
      resultCode: 'applied',
    });
    expect(internal.room.developerCommands[body.commandId].command).toEqual({
      type: 'set_effects',
      effects: { virtualBass: { strengthPercent: 60 } },
    });
    expect(internal.room.developerCommands[body.commandId].developerControlVersion).toBe(2);
    expect(dispatchFetch).toHaveBeenCalledOnce();
    await expect(
      (dispatchFetch.mock.calls[0]?.[0] as Request).clone().json(),
    ).resolves.toMatchObject({
      event: {
        type: 'pro-room-invalidated',
        effectsRevision: 1,
      },
    });

    expect(internal.room.effects).toMatchObject({
      revision: 1,
      effects: { virtualBass: { strengthPercent: 60 } },
    });
    const ack = await context.worker.fetch(
      jsonRequest(
        `/developer-commands/${body.commandId}/ack`,
        'POST',
        { resultCode: 'applied' },
        context.ownerCookie,
      ),
    );
    expect(ack.status).toBe(410);
    await expect(ack.json()).resolves.toEqual({ error: 'COMMAND_ACK_NOT_REQUIRED' });

    const second = await createInternalDeveloperCommand(
      context.worker,
      DEVELOPER_KEY_ID,
      'developer-effects-command-0002',
      { type: 'set_effects', effects: { reverb: { mixPercent: 40 } } },
    );
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toMatchObject({
      status: 'applied',
      resultCode: 'applied',
    });
    expect(internal.room.effects).toMatchObject({
      revision: 2,
      effects: { reverb: { mixPercent: 40 }, virtualBass: { strengthPercent: 60 } },
    });

    const treble = await createInternalDeveloperCommand(
      context.worker,
      DEVELOPER_KEY_ID,
      'developer-effects-command-0003',
      { type: 'set_effects', effects: { virtualTreble: { enabled: true } } },
    );
    expect(treble.status).toBe(202);
    expect(internal.room.effects).toMatchObject({
      revision: 3,
      effects: { virtualTreble: { enabled: true } },
    });
  });
});

describe('persistent PRO room repeat and shuffle mode', () => {
  const firstQueueItemId = '11111111-1111-4111-8111-111111111111';
  const secondQueueItemId = '22222222-2222-4222-8222-222222222222';
  const thirdQueueItemId = '33333333-3333-4333-8333-333333333333';
  const items = [
    {
      queueItemId: firstQueueItemId,
      name: 'First video',
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    },
    {
      queueItemId: secondQueueItemId,
      name: 'Second video',
      source: { kind: 'youtube', videoId: '9bZkp7q19f0' },
    },
    {
      queueItemId: thirdQueueItemId,
      name: 'Third video',
      source: { kind: 'youtube', videoId: 'M7lc1UVf-VE' },
    },
  ];

  it('persists the exact shuffle traversal outside strict snapshot v1', async () => {
    const context = await activatedRoom();
    expect((await replacePlaylist(context, items, 'queue-mode-seed')).status).toBe(200);
    const current = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const before = await responseJson(
      await context.worker.fetch(request('/queue-mode', {}, context.ownerCookie)),
    );
    expect(before).toEqual({
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: ROOM_CODE,
      revision: 0,
      playlistRevision: current.snapshot.playlistRevision,
      updatedAtMs: 0,
      repeatMode: 0,
      shuffleEnabled: false,
      shuffleOrder: [],
    });

    const shuffleOrder = [thirdQueueItemId, firstQueueItemId, secondQueueItemId];
    const update = await context.worker.fetch(
      jsonRequest(
        '/queue-mode',
        'PUT',
        {
          coordinatorEpoch: current.snapshot.presence.coordinatorEpoch,
          baseRevision: 0,
          playlistRevision: current.snapshot.playlistRevision,
          repeatMode: 1,
          shuffleEnabled: true,
          shuffleOrder,
        },
        context.ownerCookie,
      ),
    );
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      revision: 1,
      repeatMode: 1,
      shuffleEnabled: true,
      shuffleOrder,
    });

    const publicSnapshot = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    expect(parseProRoomSnapshot(publicSnapshot.snapshot)).not.toBeNull();
    expect(publicSnapshot.snapshot).not.toHaveProperty('queueMode');
    expect(publicSnapshot.snapshot).toMatchObject({
      revision: current.snapshot.revision + 1,
      effectsRevision: 0,
      queueModeRevision: 1,
    });
    const recovered = await responseJson(
      await context.worker.fetch(
        jsonRequest(
          '/presence/heartbeat',
          'POST',
          {
            revision: current.snapshot.revision,
            playlistRevision: current.snapshot.playlistRevision,
            presenceRevision: current.snapshot.presence.revision,
            playbackRevision: current.snapshot.playback.revision,
            coordinatorEpoch: current.snapshot.presence.coordinatorEpoch,
          },
          context.ownerCookie,
        ),
      ),
    );
    expect(recovered).not.toHaveProperty('notModified');
    expect(recovered.snapshot).toMatchObject({
      revision: current.snapshot.revision + 1,
      queueModeRevision: 1,
    });

    const restarted = new MusixquareProRoom(
      context.state as never,
      environment(context.bucket) as never,
    );
    await expect(
      responseJson(await restarted.fetch(request('/queue-mode', {}, context.ownerCookie))),
    ).resolves.toMatchObject({
      revision: 1,
      repeatMode: 1,
      shuffleEnabled: true,
      shuffleOrder,
    });
  });

  it('migrates an existing room to neutral queue behavior without changing its playlist', async () => {
    const context = await activatedRoom();
    expect((await replacePlaylist(context, items, 'queue-mode-migration-seed')).status).toBe(200);
    const stored = structuredClone(context.state.storage.data.get('pro-room:v2:core')) as {
      core: Record<string, unknown>;
    };
    delete stored.core.queueMode;
    context.state.storage.data.set('pro-room:v2:core', stored);

    const restarted = new MusixquareProRoom(
      context.state as never,
      environment(context.bucket) as never,
    );
    const response = await restarted.fetch(request('/queue-mode', {}, context.ownerCookie));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      revision: 0,
      repeatMode: 0,
      shuffleEnabled: false,
      shuffleOrder: [],
    });
    const persisted = context.state.storage.data.get('pro-room:v2:core') as {
      core: { queueMode?: unknown };
      playlistOrder: unknown[];
    };
    expect(persisted.core.queueMode).toBeDefined();
    expect(persisted.playlistOrder).toHaveLength(items.length);
  });

  it('preserves surviving order and appends new rows when the playlist changes', async () => {
    const context = await activatedRoom();
    expect((await replacePlaylist(context, items, 'queue-mode-reconcile-seed')).status).toBe(200);
    const current = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const shuffleOrder = [thirdQueueItemId, firstQueueItemId, secondQueueItemId];
    expect(
      (
        await context.worker.fetch(
          jsonRequest(
            '/queue-mode',
            'PUT',
            {
              coordinatorEpoch: current.snapshot.presence.coordinatorEpoch,
              baseRevision: 0,
              playlistRevision: current.snapshot.playlistRevision,
              repeatMode: 2,
              shuffleEnabled: true,
              shuffleOrder,
            },
            context.ownerCookie,
          ),
        )
      ).status,
    ).toBe(200);

    expect((await replacePlaylist(context, [items[0], items[2]], 'queue-mode-remove')).status).toBe(
      200,
    );
    const afterRemoval = await responseJson(
      await context.worker.fetch(request('/queue-mode', {}, context.ownerCookie)),
    );
    expect(afterRemoval).toMatchObject({
      repeatMode: 2,
      shuffleEnabled: true,
      shuffleOrder: [thirdQueueItemId, firstQueueItemId],
    });

    expect((await replacePlaylist(context, items, 'queue-mode-add')).status).toBe(200);
    const afterAddition = await responseJson(
      await context.worker.fetch(request('/queue-mode', {}, context.ownerCookie)),
    );
    expect(afterAddition.shuffleOrder).toEqual([
      thirdQueueItemId,
      firstQueueItemId,
      secondQueueItemId,
    ]);
    expect(afterAddition.revision).toBeGreaterThan(afterRemoval.revision);
  });

  it('lets the Developer API atomically set and replay canonical queue mode', async () => {
    const context = await activatedRoom();
    expect((await replacePlaylist(context, items, 'developer-queue-mode')).status).toBe(200);
    const internal = context.worker as unknown as {
      room: StoredRoom;
      env: Record<string, unknown>;
    };
    const roomRevisionBefore = internal.room.revision;

    const before = await internalDeveloperRead(context.worker, 'queue-mode');
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toEqual({
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: ROOM_CODE,
      revision: 0,
      playlistRevision: internal.room.playlistRevision,
      updatedAtMs: 0,
      repeatMode: 'off',
      shuffleEnabled: false,
    });

    const mutation = { baseRevision: 0, repeatMode: 'all', shuffleEnabled: true };
    const first = await updateInternalDeveloperQueueMode(
      context.worker,
      DEVELOPER_KEY_ID,
      'developer-queue-mode-0001',
      mutation,
    );
    expect(first.status).toBe(200);
    const firstBody = await responseJson(first);
    expect(firstBody).toMatchObject({
      view: 'queue-mode',
      revision: 1,
      repeatMode: 'all',
      shuffleEnabled: true,
    });
    expect(firstBody).not.toHaveProperty('shuffleOrder');
    expect(new Set(internal.room.queueMode.shuffleOrder)).toEqual(
      new Set(items.map((item) => item.queueItemId)),
    );
    expect(internal.room.revision).toBe(roomRevisionBefore + 1);
    const storedOrder = [...internal.room.queueMode.shuffleOrder];

    const replay = await updateInternalDeveloperQueueMode(
      context.worker,
      DEVELOPER_KEY_ID,
      'developer-queue-mode-0001',
      mutation,
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(firstBody);
    expect(internal.room.queueMode.shuffleOrder).toEqual(storedOrder);
    expect(internal.room.queueMode.revision).toBe(1);

    const stale = await updateInternalDeveloperQueueMode(
      context.worker,
      DEVELOPER_KEY_ID,
      'developer-queue-mode-0002',
      mutation,
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: 'QUEUE_MODE_REVISION_CONFLICT' });
  });

  it('preserves an enabled shuffle order and clears it only when explicitly disabled', async () => {
    const context = await activatedRoom();
    expect((await replacePlaylist(context, items, 'developer-queue-mode-preserve')).status).toBe(
      200,
    );
    const internal = context.worker as unknown as { room: StoredRoom };
    expect(
      (
        await updateInternalDeveloperQueueMode(
          context.worker,
          DEVELOPER_KEY_ID,
          'developer-queue-mode-preserve-1',
          { baseRevision: 0, repeatMode: 'off', shuffleEnabled: true },
        )
      ).status,
    ).toBe(200);
    const enabledOrder = [...internal.room.queueMode.shuffleOrder];

    const repeatOnly = await updateInternalDeveloperQueueMode(
      context.worker,
      DEVELOPER_KEY_ID,
      'developer-queue-mode-preserve-2',
      { baseRevision: 1, repeatMode: 'one', shuffleEnabled: true },
    );
    expect(repeatOnly.status).toBe(200);
    expect(internal.room.queueMode.shuffleOrder).toEqual(enabledOrder);

    const disabled = await updateInternalDeveloperQueueMode(
      context.worker,
      DEVELOPER_KEY_ID,
      'developer-queue-mode-preserve-3',
      { baseRevision: 2, repeatMode: 'one', shuffleEnabled: false },
    );
    expect(disabled.status).toBe(200);
    expect(internal.room.queueMode).toMatchObject({
      revision: 3,
      repeatMode: 2,
      shuffleEnabled: false,
      shuffleOrder: [],
    });
  });

  it('fences writes to the exact room epoch and playlist revision', async () => {
    const context = await activatedRoom();
    expect((await replacePlaylist(context, items, 'queue-mode-fence')).status).toBe(200);
    const current = await responseJson(
      await context.worker.fetch(request('/snapshot', {}, context.ownerCookie)),
    );
    const body = {
      coordinatorEpoch: current.snapshot.presence.coordinatorEpoch,
      baseRevision: 0,
      playlistRevision: current.snapshot.playlistRevision,
      repeatMode: 1,
      shuffleEnabled: true,
      shuffleOrder: [secondQueueItemId, thirdQueueItemId, firstQueueItemId],
    };

    const wrongEpoch = await context.worker.fetch(
      jsonRequest(
        '/queue-mode',
        'PUT',
        { ...body, coordinatorEpoch: body.coordinatorEpoch + 1 },
        context.ownerCookie,
      ),
    );
    expect(wrongEpoch.status).toBe(409);

    const wrongPlaylistRevision = await context.worker.fetch(
      jsonRequest(
        '/queue-mode',
        'PUT',
        { ...body, playlistRevision: body.playlistRevision + 1 },
        context.ownerCookie,
      ),
    );
    expect(wrongPlaylistRevision.status).toBe(409);
    await expect(wrongPlaylistRevision.json()).resolves.toMatchObject({
      error: 'PLAYLIST_REVISION_CONFLICT',
      queueMode: { revision: 0, repeatMode: 0, shuffleEnabled: false },
    });

    const wrongQueueModeRevision = await context.worker.fetch(
      jsonRequest(
        '/queue-mode',
        'PUT',
        { ...body, baseRevision: body.baseRevision + 1 },
        context.ownerCookie,
      ),
    );
    expect(wrongQueueModeRevision.status).toBe(409);
    await expect(wrongQueueModeRevision.json()).resolves.toMatchObject({
      error: 'QUEUE_MODE_REVISION_CONFLICT',
      queueMode: { revision: 0, repeatMode: 0, shuffleEnabled: false },
    });
  });
});

describe('PRO room immutable generation isolation', () => {
  const generationHeader = 'x-mxqr-pro-room-generation';

  function requestForGeneration(
    roomGeneration: number,
    path: string,
    init: RequestInit = {},
    cookie?: string,
  ): Request {
    const result = requestForRoom(ROOM_CODE, path, init, cookie);
    result.headers.set(generationHeader, String(roomGeneration));
    return result;
  }

  function jsonRequestForGeneration(
    roomGeneration: number,
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body: unknown,
    cookie?: string,
    idempotencyKey?: string,
  ): Request {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
    return requestForGeneration(
      roomGeneration,
      path,
      { method, headers, body: JSON.stringify(body) },
      cookie,
    );
  }

  async function activatedGenerationOne(bucket = new FakeR2Bucket()) {
    const state = new FakeState();
    const worker = new MusixquareProRoom(state as never, environment(bucket) as never);
    const provision = await worker.fetch(
      new Request('https://pro-room.internal/internal/admin/provision', {
        method: 'POST',
        headers: {
          'x-mxqr-pro-room-code': ROOM_CODE,
          [generationHeader]: '1',
        },
      }),
    );
    expect(provision.status).toBe(200);

    const claimToken = await issueProRoomActivationClaim(ROOM_CODE, ACTIVATION_SECRET, {
      nowMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60_000,
      nonce: 'generation-one-activation',
      roomGeneration: 1,
    });
    const activation = await worker.fetch(
      jsonRequestForGeneration(1, '/activation', 'POST', {
        claimToken,
        temporaryPin: ROOM_CODE.padStart(8, '0'),
        newPin: '12345678',
        ownerName: 'Replacement owner',
      }),
    );
    expect(activation.status).toBe(200);
    const ownerCookie = cookieFrom(activation);
    const activationEnvelope = await responseJson(activation);
    bindCookiePresence(ownerCookie, activationEnvelope);
    return { state, bucket, worker, ownerCookie, activationEnvelope };
  }

  it('rejects generation-zero activation, recovery, and session credentials in generation one', async () => {
    const state = new FakeState();
    const bucket = new FakeR2Bucket();
    const replacement = new MusixquareProRoom(state as never, environment(bucket) as never);
    expect(
      (
        await replacement.fetch(
          new Request('https://pro-room.internal/internal/admin/provision', {
            method: 'POST',
            headers: {
              'x-mxqr-pro-room-code': ROOM_CODE,
              [generationHeader]: '1',
            },
          }),
        )
      ).status,
    ).toBe(200);

    const legacyActivationClaim = await issueProRoomActivationClaim(ROOM_CODE, ACTIVATION_SECRET, {
      nowMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60_000,
      nonce: 'retired-generation-activation',
      roomGeneration: 0,
    });
    const legacyActivationPayload = JSON.parse(
      Buffer.from(legacyActivationClaim.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(legacyActivationPayload).not.toHaveProperty('roomGeneration');
    const rejectedActivation = await replacement.fetch(
      jsonRequestForGeneration(1, '/activation', 'POST', {
        claimToken: legacyActivationClaim,
        temporaryPin: ROOM_CODE.padStart(8, '0'),
        newPin: '12345678',
      }),
    );
    expect(rejectedActivation.status).toBe(401);
    await expect(rejectedActivation.json()).resolves.toEqual({ error: 'ACTIVATION_INVALID' });

    const currentActivationClaim = await issueProRoomActivationClaim(ROOM_CODE, ACTIVATION_SECRET, {
      nowMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60_000,
      nonce: 'current-generation-activation',
      roomGeneration: 1,
    });
    const currentActivationPayload = JSON.parse(
      Buffer.from(currentActivationClaim.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(currentActivationPayload.roomGeneration).toBe(1);
    const activation = await replacement.fetch(
      jsonRequestForGeneration(1, '/activation', 'POST', {
        claimToken: currentActivationClaim,
        temporaryPin: ROOM_CODE.padStart(8, '0'),
        newPin: '12345678',
      }),
    );
    expect(activation.status).toBe(200);
    const replacementCookie = cookieFrom(activation);
    const replacementEnvelope = await responseJson(activation);
    bindCookiePresence(replacementCookie, replacementEnvelope);

    const legacyRecoveryClaim = await issueProRoomOwnerRecoveryClaim(ROOM_CODE, ACTIVATION_SECRET, {
      nowMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60_000,
      nonce: 'retired-generation-recovery',
      roomGeneration: 0,
    });
    const legacyRecoveryPayload = JSON.parse(
      Buffer.from(legacyRecoveryClaim.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(legacyRecoveryPayload).not.toHaveProperty('roomGeneration');
    const accountAssertion = await createAccountAssertion(
      {
        accountId: 'acct_0123456789abcdefghijkl',
        nickname: 'Replacement owner',
        roomCode: ROOM_CODE,
        roomGeneration: 1,
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
      },
      ACCOUNT_ASSERTION_SECRET,
    );
    expect(accountAssertion).toBeTruthy();
    const recoveryRequest = jsonRequestForGeneration(1, '/owner-recovery', 'POST', {
      claimToken: legacyRecoveryClaim,
    });
    recoveryRequest.headers.set(ACCOUNT_ASSERTION_HEADER, accountAssertion!);
    const rejectedRecovery = await replacement.fetch(recoveryRequest);
    expect(rejectedRecovery.status).toBe(401);
    await expect(rejectedRecovery.json()).resolves.toEqual({ error: 'RECOVERY_INVALID' });

    const legacy = await activatedRoom();
    const legacyStateBehindGenerationOneRoute = new MusixquareProRoom(
      legacy.state as never,
      environment(legacy.bucket) as never,
    );
    const rejectedLegacyState = await legacyStateBehindGenerationOneRoute.fetch(
      requestForGeneration(1, '/snapshot'),
    );
    expect(rejectedLegacyState.status).toBe(404);
    await expect(rejectedLegacyState.json()).resolves.toEqual({ error: 'ROOM_NOT_FOUND' });

    const legacyInternal = legacy.worker as unknown as {
      room: { sessions: Record<string, Record<string, unknown>> };
    };
    const replacementInternal = replacement as unknown as {
      room: { sessions: Record<string, Record<string, unknown>> };
    };
    const [legacyHash, legacySession] = Object.entries(legacyInternal.room.sessions)[0]!;
    expect(legacySession.roomGeneration).toBe(0);
    // Model a cryptographically valid retired session surviving in an
    // incorrectly copied state record. The generation fence must still win.
    replacementInternal.room.sessions[legacyHash] = structuredClone(legacySession);

    const rejectedSession = await replacement.fetch(
      requestForGeneration(1, '/snapshot', {}, legacy.ownerCookie),
    );
    expect(rejectedSession.status).toBe(401);
    await expect(rejectedSession.json()).resolves.toEqual({ error: 'SESSION_REQUIRED' });
    expect(replacementInternal.room.sessions[legacyHash]).toBeUndefined();
  });

  it('keeps generation-one uploads outside the legacy prefix and legacy sweeps', async () => {
    const legacy = await activatedRoom();
    const replacement = await activatedGenerationOne(legacy.bucket);
    const reservation = await replacement.worker.fetch(
      jsonRequestForGeneration(
        1,
        '/media/reservations',
        'POST',
        { byteLength: 4096, name: 'replacement.flac', mime: 'audio/flac' },
        replacement.ownerCookie,
        'generation-one-r2-reservation',
      ),
    );
    expect(reservation.status).toBe(200);
    const envelope = await responseJson(reservation);
    expect(envelope.reservation.upload.headers['x-amz-meta-mxqr-generation']).toBe('1');
    const assetId = envelope.reservation.assetId as string;
    const replacementInternal = replacement.worker as unknown as {
      room: {
        assets: Record<
          string,
          { objectKey: string; stagingObjectKey: string; roomGeneration: number }
        >;
      };
    };
    const asset = replacementInternal.room.assets[assetId]!;
    expect(asset.roomGeneration).toBe(1);
    expect(asset.objectKey).toMatch(/^pro-room-incarnations\/000001\/generation-1\/assets\//);
    expect(asset.stagingObjectKey).toMatch(
      /^pro-room-incarnations\/000001\/generation-1\/assets\/.*\/staging_/,
    );
    expect(asset.objectKey).not.toContain('rooms/000001/');

    const lateLegacyKey = `rooms/${ROOM_CODE}/assets/late-generation-zero/v1/object`;
    legacy.bucket.objects.set(lateLegacyKey, { size: 1 });
    legacy.bucket.objects.set(asset.stagingObjectKey, { size: 4096 });
    const legacyInternal = legacy.worker as unknown as {
      purgeDecommissionedMediaPrefix(): Promise<{ ok: boolean; deletedAny: boolean }>;
    };
    await expect(legacyInternal.purgeDecommissionedMediaPrefix()).resolves.toEqual({
      ok: true,
      deletedAny: true,
    });

    expect(legacy.bucket.objects.has(lateLegacyKey)).toBe(false);
    expect(legacy.bucket.objects.has(asset.stagingObjectKey)).toBe(true);
    expect(legacy.bucket.deleted).not.toContain(asset.stagingObjectKey);
  });

  it('requires an exact generation on every generation-one Developer boundary and keeps BOT commands working', async () => {
    const replacement = await activatedGenerationOne();
    const read = (body: Record<string, unknown>, header: string | null) => {
      const headers = new Headers({
        'content-type': 'application/json',
        'x-mxqr-pro-room-code': ROOM_CODE,
      });
      if (header !== null) headers.set(generationHeader, header);
      return replacement.worker.fetch(
        new Request('https://pro-room.internal/internal/developer/v1/read', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
      );
    };

    expect(
      (await read({ projection: 'room', keyId: DEVELOPER_KEY_ID, roomGeneration: 1 }, '1')).status,
    ).toBe(200);
    for (const [body, header, status] of [
      [{ projection: 'room', keyId: DEVELOPER_KEY_ID }, null, 404],
      [{ projection: 'room', keyId: DEVELOPER_KEY_ID, roomGeneration: 1 }, null, 404],
      [{ projection: 'room', keyId: DEVELOPER_KEY_ID }, '1', 400],
      [{ projection: 'room', keyId: DEVELOPER_KEY_ID, roomGeneration: 1 }, '0', 404],
      [{ projection: 'room', keyId: DEVELOPER_KEY_ID, roomGeneration: 0 }, '0', 404],
      [{ projection: 'room', keyId: DEVELOPER_KEY_ID, roomGeneration: 0 }, '1', 400],
    ] as const) {
      const rejected = await read(body, header);
      expect(rejected.status).toBe(status);
      await expect(responseJson(rejected)).resolves.toEqual({
        error: status === 404 ? 'ROOM_NOT_FOUND' : 'INVALID_REQUEST',
      });
    }

    const developerUpload = await replacement.worker.fetch(
      new Request('https://pro-room.internal/internal/developer/v1/media/uploads/create', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': ROOM_CODE,
          [generationHeader]: '1',
        },
        body: JSON.stringify({
          roomCode: ROOM_CODE,
          roomGeneration: 1,
          keyId: DEVELOPER_KEY_ID,
          idempotencyKey: 'generation-one-developer-upload',
          media: {
            name: 'replacement.flac',
            byteLength: 4096,
            mime: 'audio/flac',
          },
        }),
      }),
    );
    expect(developerUpload.status).toBe(201);
    const developerUploadEnvelope = await responseJson(developerUpload);
    expect(developerUploadEnvelope.upload.headers['x-amz-meta-mxqr-generation']).toBe('1');

    const internal = replacement.worker as unknown as {
      room: { effects: { effects: { virtualTreble: { enabled: boolean } } } };
      runBotDeveloperCommand(requestId: string, command: Record<string, unknown>): Promise<boolean>;
    };
    await expect(
      internal.runBotDeveloperCommand('generation-one-bot-effects', {
        type: 'set_effects',
        effects: { virtualTreble: { enabled: true } },
      }),
    ).resolves.toBe(true);
    expect(internal.room.effects.effects.virtualTreble.enabled).toBe(true);
  });

  it('treats an old generation registry repair as complete without overwriting the replacement', async () => {
    const context = await activatedRoom();
    const registry = {
      room_code: ROOM_CODE,
      room_generation: 1,
      status: 'registered',
      label: 'Replacement room',
    };
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
            if (
              sql.includes('UPDATE mxqr_pro_room_registry') &&
              Number(values[1]) === registry.room_generation
            ) {
              registry.status = 'decommissioned';
              registry.label = 'Decommissioned PRO room';
            }
            return { success: true, meta: { changes: 0 } };
          },
          first: async () => ({ ...registry }),
          all: async () => ({ results: [{ ...registry }] }),
        }),
      }),
    };
    const internal = context.worker as unknown as {
      env: Record<string, unknown>;
      room: Record<string, any>;
      markRegistryDecommissioned(nowMs: number): Promise<boolean>;
    };
    internal.env.MUSIXQUARE_ADMIN_DB = db;
    internal.room.decommission = {
      requestId: 'admin-old-generation-repair',
      completedAtMs: 1,
      maintenanceAtMs: 2,
    };

    await expect(internal.markRegistryDecommissioned(1_784_524_800_000)).resolves.toBe(true);
    expect(registry).toEqual({
      room_code: ROOM_CODE,
      room_generation: 1,
      status: 'registered',
      label: 'Replacement room',
    });
    const update = calls.find((call) => call.sql.startsWith('UPDATE mxqr_pro_room_registry'));
    expect(update?.sql).toContain('WHERE room_code = ?1 AND room_generation = ?2');
    expect(update?.values).toEqual([ROOM_CODE, 0, 1_784_524_800_000]);
  });

  it('fails closed on transient Developer D1 errors and only uses the legacy fallback for a missing generation schema', async () => {
    const context = await activatedRoom();
    const internal = context.worker as unknown as {
      env: Record<string, unknown>;
      deleteDeveloperRoomData(requestId: string, nowMs: number): Promise<boolean>;
    };

    const transientSql: string[] = [];
    internal.env.DEVELOPER_API_DB = {
      prepare: (sql: string) => ({
        bind: () => ({
          run: async () => {
            transientSql.push(sql.replace(/\s+/g, ' ').trim());
            throw new Error('D1_ERROR: transient network failure');
          },
        }),
      }),
    };
    await expect(
      internal.deleteDeveloperRoomData('admin-transient-d1-failure', 1_784_524_800_000),
    ).resolves.toBe(false);
    expect(transientSql).toHaveLength(1);
    expect(transientSql[0]).toContain('mxqr_developer_api_room_generation_tombstones');
    expect(transientSql[0]).not.toContain('mxqr_developer_api_room_tombstones');

    const missingSchemaSql: Array<{ sql: string; values: unknown[] }> = [];
    internal.env.DEVELOPER_API_DB = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            const normalized = sql.replace(/\s+/g, ' ').trim();
            missingSchemaSql.push({ sql: normalized, values });
            if (normalized.includes('mxqr_developer_api_room_generation_tombstones')) {
              throw new Error(
                'D1_ERROR: no such table: mxqr_developer_api_room_generation_tombstones',
              );
            }
            return { success: true, meta: { changes: 1 } };
          },
        }),
      }),
    };
    await expect(
      internal.deleteDeveloperRoomData('admin-missing-generation-schema', 1_784_524_800_000),
    ).resolves.toBe(true);

    expect(missingSchemaSql).toHaveLength(5);
    expect(missingSchemaSql[1]?.sql).toContain('mxqr_developer_api_room_tombstones');
    for (const statement of missingSchemaSql.slice(2)) {
      expect(statement.sql).toMatch(
        /^DELETE FROM mxqr_developer_api_(?:keys|audit|admin_audit) WHERE room_code = \?1$/,
      );
      expect(statement.values).toEqual([ROOM_CODE]);
    }
  });
});
