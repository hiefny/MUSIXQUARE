/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { applyAccountSession, setAccountAnonymous } from '../../account/state.ts';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import { clearManagedTimer } from '../../core/timers.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  ProRoomApiClient,
  ProRoomApiError,
  type UpdateProRoomCompactSnapshotInput,
  type ProRoomSignalingAccess,
} from '../api.ts';
import {
  capabilitiesForProRoomRole,
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPermissionSet,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import {
  captureProRoomMediaHookSession,
  handleProRoomFiles,
  handleProRoomTrackMetadata,
  handleProRoomTrackRemoval,
  handleProRoomTrackReorder,
  handleProRoomYouTubeForSession,
} from '../media-hooks.ts';
import { ProRoomMediaTransfer } from '../media-transfer.ts';
import { getProRoomUploadRows } from '../upload-queue.ts';
import { acceptProRoomRealtimeFrameForTests, joinProRoom } from '../runtime.ts';

const ROOM = '000001';
const ITEM = '58000000-0000-4000-8000-000000000001' as QueueItemId;
const NEXT_ITEM = '58000000-0000-4000-8000-000000000002' as QueueItemId;
const ADDED_ITEM = '59000000-0000-4000-8000-000000000003' as QueueItemId;
const nativeCreateSession = ProRoomApiClient.prototype.createSession;
const nativeMutation = ProRoomApiClient.prototype.updateCompactSnapshot;
const nativeUpload = ProRoomMediaTransfer.prototype.upload;

function snapshot(revision = 1, canMutate = true): ProRoomSnapshot {
  const permissions: ProRoomPermissionSet = {
    'media.add': canMutate,
    'playback.control': true,
    'members.kick': false,
    'chat.notice': false,
  };
  const capabilities = [...capabilitiesForProRoomRole('controller', permissions)];
  const member = {
    memberId: 'member_0000000002',
    memberDisplayNumber: 1,
    isAuthenticated: true,
    displayName: 'Controller',
    role: 'controller' as const,
  };
  return {
    schemaVersion: 1,
    roomCode: ROOM,
    status: 'active',
    runtime: 'awake',
    revision,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [
      {
        queueItemId: ITEM,
        name: 'Track',
        source: {
          kind: 'youtube',
          videoId: 'dQw4w9WgXcQ',
          playlistId: 'PL_CONTROL_AUTHORITY',
          videoIds: ['dQw4w9WgXcQ', 'M7lc1UVf-VE'],
        },
      },
      {
        queueItemId: NEXT_ITEM,
        name: 'Next track',
        source: { kind: 'youtube', videoId: 'M7lc1UVf-VE' },
      },
    ],
    currentQueueItemId: ITEM,
    playback: {
      coordinatorEpoch: 1,
      revision: 1,
      state: 'paused',
      queueItemId: ITEM,
      positionSeconds: 0,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
      updatedAtMs: 1,
    },
    presence: {
      coordinatorEpoch: 1,
      revision,
      coordinatorParticipantId: null,
      participants: [
        {
          ...member,
          participantId: 'participant_00002',
          capabilities,
          devicePlatform: 'other',
          joinedAtMs: 1,
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
      ...member,
      participantId: 'participant_00002',
      presenceIncarnationId: 'presence_0000000002',
      capabilities,
      coordinatorEligible: false,
    },
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: 'member_0000000001',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        onlineDeviceCount: 0,
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
      },
      { ...member, permissions, inheritedPermissions: [], onlineDeviceCount: 1 },
    ],
  };
}

describe('PRO queued media mutations across authority changes', () => {
  let canonical: ProRoomSnapshot;
  let mutations: UpdateProRoomCompactSnapshotInput[];
  let body: ReadableStreamDefaultController<Uint8Array>;
  let responseCancelled: boolean;
  let holdFirstMutation: boolean;
  let upload: MockInstance<ProRoomMediaTransfer['upload']>;

  beforeEach(async () => {
    resetState();
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Controller', profileComplete: true },
      statsScope: 'a'.repeat(43),
    });
    canonical = snapshot();
    mutations = [];
    responseCancelled = false;
    holdFirstMutation = true;
    const client = new ProRoomApiClient({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/sessions')) {
          return Response.json({
            snapshot: canonical,
            session: { expiresAtMs: Date.now() + 60_000 },
          });
        }
        expect(url.pathname.endsWith('/snapshot/compact')).toBe(true);
        const mutation = JSON.parse(String(init?.body)) as UpdateProRoomCompactSnapshotInput;
        mutations.push(mutation);
        if (!canonical.viewer?.capabilities.includes('queue.mutate')) {
          return Response.json({ error: 'FORBIDDEN' }, { status: 403 });
        }
        if (mutation.baseRevision !== canonical.revision) {
          return Response.json({ error: 'REVISION_CONFLICT' }, { status: 409 });
        }
        const byId = new Map(canonical.playlist.map((item) => [item.queueItemId, item]));
        for (const item of mutation.upserts) byId.set(item.queueItemId, item);
        canonical = {
          ...canonical,
          revision: canonical.revision + 1,
          playlistRevision: canonical.playlistRevision + 1,
          playlist: (
            mutation.playlistOrder ?? canonical.playlist.map((item) => item.queueItemId)
          ).map((id) => byId.get(id)!),
        };
        if (mutations.length === 1 && holdFirstMutation) {
          // Server has committed the metadata update; the genuine async HTTP
          // body, not an application helper, keeps the serial mutation lane busy.
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller;
                controller.enqueue(
                  new TextEncoder().encode(JSON.stringify({ snapshot: canonical }).slice(0, -1)),
                );
              },
              cancel() {
                responseCancelled = true;
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        return Response.json({ snapshot: canonical });
      },
    });
    vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockImplementation((input, signal) =>
      nativeCreateSession.call(client, input, signal),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'updateCompactSnapshot').mockImplementation(
      (input, signal) => nativeMutation.call(client, input, signal),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockImplementation(async () => canonical);
    vi.spyOn(ProRoomApiClient.prototype, 'getSnapshot').mockImplementation(async () => canonical);
    vi.spyOn(ProRoomApiClient.prototype, 'attachCurrentAccount').mockImplementation(
      async () => canonical,
    );
    vi.spyOn(ProRoomApiClient.prototype, 'renewCurrentAccountLease').mockImplementation(
      async () => ({
        leaseExpiresAtMs: Date.now() + 120_000,
      }),
    );
    upload = vi
      .spyOn(ProRoomMediaTransfer.prototype, 'upload')
      .mockImplementation(async (input) => {
        if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return {
          asset: {
            kind: 'pro-r2',
            assetId: 'asset_queued_upload_19',
            version: 1,
            byteLength: input.file.size,
            mime: 'audio/mp3',
          },
          quota: canonical.quota,
        };
      });
    vi.spyOn(ProRoomApiClient.prototype, 'createSignalingTicket').mockResolvedValue({
      ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
      expiresAtMs: Date.now() + 60_000,
      role: 'member',
      coordinatorEpoch: 1,
      presenceIncarnationId: 'presence_0000000002',
      ticketSequence: 1,
      pendingPlaybackTransition: null,
    });
    vi.spyOn(ProRoomApiClient.prototype, 'getSettingsSync').mockResolvedValue({
      schemaVersion: 1,
      view: 'settings-sync',
      roomCode: ROOM,
      revision: 0,
      updatedAtMs: 1,
      masterVolume: 1,
      effects: createDefaultRoomEffectsState(),
    });
    vi.spyOn(ProRoomApiClient.prototype, 'getQueueMode').mockImplementation(async () => ({
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: ROOM,
      revision: 0,
      playlistRevision: canonical.playlistRevision,
      updatedAtMs: 1,
      repeatMode: 0,
      shuffleEnabled: false,
      shuffleOrder: [],
    }));
    vi.spyOn(ProRoomApiClient.prototype, 'getSystemAudioState').mockResolvedValue({
      generation: 0,
      status: 'idle',
      ownerParticipantId: null,
      claimExpiresAt: null,
      liveExpiresAt: null,
      publication: null,
    });
    vi.spyOn(ProRoomApiClient.prototype, 'closePresenceOnUnload').mockResolvedValue(undefined);
    vi.spyOn(ProRoomApiClient.prototype, 'closeSessionFenced').mockResolvedValue(undefined);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'reconfigure').mockResolvedValue(undefined);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {});
    await joinProRoom({ code: ROOM, pin: '12345678' });
    await vi.waitFor(() => expect(ProRoomApiClient.prototype.getQueueMode).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.attachCurrentAccount).toHaveBeenCalled(),
    );
    await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
    clearManagedTimer('preloadScheduleTimer');
    vi.useFakeTimers();
  });

  afterEach(async () => {
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalled(),
    );
    vi.useRealTimers();
    setAccountAnonymous();
    vi.restoreAllMocks();
    resetState();
  });

  async function authority(canMutate: boolean) {
    const next = snapshot(canonical.revision + 1, canMutate);
    canonical = {
      ...canonical,
      revision: next.revision,
      presence: next.presence,
      viewer: next.viewer,
      administrators: next.administrators,
    };
    acceptProRoomRealtimeFrameForTests({
      type: 'pro-server-event',
      version: 1,
      roomCode: ROOM,
      coordinatorEpoch: 1,
      event: { type: 'pro-presence-snapshot', presenceRevision: canonical.presence.revision },
    });
    await vi.waitFor(() =>
      expect(getState('room.context').capabilities.includes('queue.mutate')).toBe(canMutate),
    );
    await vi.advanceTimersByTimeAsync(0);
  }

  async function queueRemoval() {
    expect(handleProRoomTrackMetadata(ITEM, { name: 'Renamed track' })).toBe(true);
    await vi.waitFor(() => expect(mutations).toHaveLength(1));
    expect(handleProRoomTrackRemoval([NEXT_ITEM])).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mutations).toHaveLength(1);
  }

  async function releaseBody() {
    if (!responseCancelled) {
      body.enqueue(new TextEncoder().encode('}'));
      body.close();
    }
    await vi.advanceTimersByTimeAsync(0);
  }

  it('does not revive a queued removal when the queue permission is revoked and regranted', async () => {
    await queueRemoval();
    await authority(false);
    await authority(true);
    await releaseBody();
    expect(mutations).toHaveLength(1);
    expect(canonical.playlist.map((item) => item.queueItemId)).toContain(NEXT_ITEM);
    expect(getState('playlist.items').map((item) => item.queueItemId)).toContain(NEXT_ITEM);

    // Fresh intent after the new grant remains actionable.
    expect(handleProRoomTrackRemoval([NEXT_ITEM])).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mutations).toHaveLength(2);
    expect(canonical.playlist.map((item) => item.queueItemId)).not.toContain(NEXT_ITEM);
  });

  it('preserves queued removals while the grant remains uninterrupted', async () => {
    await queueRemoval();
    // Ordinary presence snapshots produce fresh context objects and a newer
    // CAS revision without ending the media-management grant.
    await authority(true);
    await releaseBody();
    expect(mutations).toHaveLength(2);
    expect(canonical.playlist.map((item) => item.queueItemId)).not.toContain(NEXT_ITEM);
  });

  const delayedIntents = ['reorder', 'metadata', 'youtube', 'upload'] as const;
  function invokeDelayedIntent(kind: (typeof delayedIntents)[number]) {
    if (kind === 'reorder') {
      return handleProRoomTrackReorder(NEXT_ITEM, ITEM, getState('playlist.revision'));
    }
    if (kind === 'metadata') return handleProRoomTrackMetadata(NEXT_ITEM, { name: 'Stale rename' });
    if (kind === 'upload')
      return handleProRoomFiles([new File(['1234'], 'queued.mp3', { type: 'audio/mp3' })]);
    return handleProRoomYouTubeForSession(
      captureProRoomMediaHookSession()!,
      {
        queueItemId: ADDED_ITEM,
        type: 'youtube',
        name: 'New video',
        videoId: 'M7lc1UVf-VE',
        playlistId: null,
      },
      'https://www.youtube.com/watch?v=M7lc1UVf-VE',
    );
  }

  it.each(delayedIntents)(
    'retires a queued %s intent on a queue permission lapse',
    async (kind) => {
      expect(handleProRoomTrackMetadata(ITEM, { name: 'Renamed track' })).toBe(true);
      await vi.waitFor(() => expect(mutations).toHaveLength(1));
      expect(invokeDelayedIntent(kind)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(mutations).toHaveLength(1);
      expect(upload).not.toHaveBeenCalled();
      await authority(false);
      await authority(true);
      await releaseBody();
      expect(mutations).toHaveLength(1);
      expect(upload).not.toHaveBeenCalled();
      expect(canonical.playlist.map((item) => item.queueItemId)).toEqual([ITEM, NEXT_ITEM]);
      expect(canonical.playlist[1]?.name).toBe('Next track');

      expect(invokeDelayedIntent(kind)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(mutations).toHaveLength(2);
      if (kind === 'upload') expect(upload).toHaveBeenCalledTimes(1);
    },
  );

  it('does not submit a queued removal while the queue permission remains revoked', async () => {
    await queueRemoval();
    await authority(false);
    await releaseBody();
    expect(mutations).toHaveLength(1);
    expect(canonical.playlist.map((item) => item.queueItemId)).toContain(NEXT_ITEM);
  });

  it('does not carry an old account removal into a successor account with the same permission', async () => {
    await queueRemoval();
    const previousHookSession = captureProRoomMediaHookSession()!;
    const attach = vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount);
    attach.mockClear();
    const successorGrant = snapshot(canonical.revision + 1);
    vi.spyOn(ProRoomApiClient.prototype, 'detachCurrentAccount').mockImplementation(async () => {
      canonical = {
        ...canonical,
        revision: canonical.revision + 1,
        presence: {
          ...canonical.presence,
          revision: canonical.presence.revision + 1,
          participants: canonical.presence.participants.map((participant) => ({
            ...participant,
            memberId: 'member_anonymous_19',
            memberDisplayNumber: 3,
            isAuthenticated: false,
            displayName: 'Guest',
            role: 'member',
            capabilities: [],
          })),
        },
        viewer: {
          ...canonical.viewer!,
          memberId: 'member_anonymous_19',
          memberDisplayNumber: 3,
          isAuthenticated: false,
          displayName: 'Guest',
          role: 'member',
          capabilities: [],
        },
        administrators: canonical.administrators.map((administrator) => ({
          ...administrator,
          onlineDeviceCount: 0,
        })),
      };
      return { ok: true, detached: true, snapshot: canonical };
    });
    attach
      .mockRejectedValueOnce(new ProRoomApiError('SESSION_ACCOUNT_CONFLICT', 409))
      .mockImplementation(async () => {
        const memberId = 'member_0000000003';
        canonical = {
          ...canonical,
          revision: canonical.revision + 1,
          presence: {
            ...canonical.presence,
            revision: canonical.presence.revision + 1,
            participants: canonical.presence.participants.map((participant) => ({
              ...participant,
              role: 'controller',
              isAuthenticated: true,
              capabilities: successorGrant.viewer!.capabilities,
              memberDisplayNumber: 2,
              memberId,
              displayName: 'Successor',
            })),
          },
          viewer: {
            ...successorGrant.viewer!,
            memberId,
            memberDisplayNumber: 2,
            displayName: 'Successor',
          },
          administrators: successorGrant.administrators.map((administrator) =>
            administrator.role === 'owner'
              ? administrator
              : { ...administrator, memberId, memberDisplayNumber: 2, displayName: 'Successor' },
          ),
        };
        return canonical;
      });
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Successor', profileComplete: true },
      statsScope: 'b'.repeat(43),
    });
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(getState('network.myMemberId')).toBe('member_0000000003'));
    await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
    await vi.waitFor(() => expect(getState('room.context').capabilities).toContain('queue.mutate'));
    expect(previousHookSession.signal.aborted).toBe(true);
    await releaseBody();
    expect(mutations).toHaveLength(1);
    expect(canonical.playlist.map((item) => item.queueItemId)).toContain(NEXT_ITEM);

    expect(handleProRoomTrackRemoval([NEXT_ITEM])).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mutations).toHaveLength(2);
    expect(canonical.playlist.map((item) => item.queueItemId)).not.toContain(NEXT_ITEM);
  });

  it('aborts an active PUT and releases its reservation before a fresh grant uploads another file', async () => {
    holdFirstMutation = false;
    const requests: XMLHttpRequest[] = [];
    const aborts = vi.fn();
    const deleted = vi.fn(async (input: { assetId: string }) => ({
      assetId: input.assetId,
      quota: canonical.quota,
    }));
    const completed = vi.fn(async (input: { assetId: string }) => ({
      asset: {
        kind: 'pro-r2' as const,
        assetId: input.assetId,
        version: 1,
        byteLength: 4,
        mime: 'audio/flac',
      },
      quota: canonical.quota,
    }));
    let reservationSequence = 0;
    const transfer = new ProRoomMediaTransfer({
      api: {
        endpoint: 'http://127.0.0.1:8789/api/pro-room',
        createMediaReservation: async () => ({
          assetId: `asset_upload_round19_${++reservationSequence}`,
          version: 1,
          byteLength: 4,
          expiresAtMs: Date.now() + 60_000,
          upload: {
            method: 'PUT',
            url: 'http://127.0.0.1:8789/local-upload',
            headers: { 'content-type': 'audio/flac' },
          },
          quota: canonical.quota,
        }),
        completeMedia: completed,
        getMediaDownload: vi.fn(),
        deleteMedia: deleted,
      },
      xhrFactory: () => {
        const request = {
          upload: { onprogress: null },
          open: vi.fn(),
          setRequestHeader: vi.fn(),
          send: vi.fn(),
          onabort: null,
          onload: null,
          status: 200,
          responseURL: 'http://127.0.0.1:8789/local-upload',
          abort() {
            aborts();
            request.onabort?.call(request, new ProgressEvent('abort'));
          },
        } as unknown as XMLHttpRequest;
        requests.push(request);
        return request;
      },
    });
    upload.mockImplementation((input) => nativeUpload.call(transfer, input));
    expect(
      handleProRoomFiles([new File(['1234'], 'old.flac'), new File(['5678'], 'queued.flac')]),
    ).toBe(true);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await vi.waitFor(() => expect(requests[0]!.send).toHaveBeenCalledOnce());
    expect(getProRoomUploadRows()).toHaveLength(2);
    const progress = requests[0]!.upload.onprogress;
    expect(progress).toBeTypeOf('function');
    Reflect.apply(progress!, requests[0]!.upload, [
      new ProgressEvent('progress', { loaded: 2, total: 4, lengthComputable: true }),
    ]);
    await authority(false);
    expect(aborts).toHaveBeenCalledOnce();
    expect(deleted).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 'asset_upload_round19_1' }),
    );
    expect(getProRoomUploadRows()).toHaveLength(0);
    expect(completed).not.toHaveBeenCalled();
    expect(mutations).toHaveLength(0);

    await authority(true);
    expect(handleProRoomFiles([new File(['abcd'], 'fresh.flac')])).toBe(true);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await vi.waitFor(() => expect(requests[1]!.send).toHaveBeenCalledOnce());
    requests[1]!.onload?.call(requests[1]!, new ProgressEvent('load'));
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toHaveBeenCalledOnce();
    expect(mutations).toHaveLength(1);
    expect(canonical.playlist.map((item) => item.name)).toContain('fresh.flac');
    expect(canonical.playlist.map((item) => item.name)).not.toContain('old.flac');
    expect(canonical.playlist.map((item) => item.name)).not.toContain('queued.flac');
    expect(getProRoomUploadRows()).toHaveLength(0);
  });
});
