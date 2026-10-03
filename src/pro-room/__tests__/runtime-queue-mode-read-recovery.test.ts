/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import { clearManagedTimer, getManagedTimer } from '../../core/timers.ts';
import { toggleRepeat, toggleShuffle } from '../../player/playlist.ts';
import type { QueueItemId } from '../../types/index.ts';
import { ProRoomApiClient, type ProRoomSignalingAccess } from '../api.ts';
import {
  capabilitiesForProRoomRole,
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPermissionSet,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import type { ProRoomQueueModeSnapshot } from '../queue-mode.ts';
import { acceptProRoomRealtimeFrameForTests, joinProRoom } from '../runtime.ts';

const ROOM = '000001';
const ITEM = '56000000-0000-4000-8000-000000000001' as QueueItemId;
const NEXT_ITEM = '56000000-0000-4000-8000-000000000002' as QueueItemId;
const CHECKPOINT_TIMER = 'pro-room-queue-mode-checkpoint-debounce';
const nativeCreateSession = ProRoomApiClient.prototype.createSession;
const nativeGetQueueMode = ProRoomApiClient.prototype.getQueueMode;
const nativeUpdateQueueMode = ProRoomApiClient.prototype.updateQueueMode;
type ModeField = 'repeat' | 'shuffle';
type ModeWrite = Pick<
  ProRoomQueueModeSnapshot,
  'repeatMode' | 'shuffleEnabled' | 'shuffleOrder' | 'playlistRevision'
> & { baseRevision: number };

function snapshot(revision = 1, canMutateQueue = true): ProRoomSnapshot {
  const permissions: ProRoomPermissionSet = {
    'media.add': canMutateQueue,
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
      { queueItemId: ITEM, name: 'Track', source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } },
    ],
    currentQueueItemId: null,
    playback: {
      coordinatorEpoch: 1,
      revision: 0,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
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

describe('PRO queue-mode required-read recovery', () => {
  let canonical: ProRoomSnapshot;
  let mode: ProRoomQueueModeSnapshot;
  let puts: ModeWrite[];
  let readStatus: number;
  let reads: number;
  let holdNextRead: boolean;
  let finishRead: (() => void) | undefined;

  beforeEach(() => {
    resetState();
    canonical = snapshot();
    mode = {
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: ROOM,
      revision: 0,
      playlistRevision: 1,
      updatedAtMs: 1,
      repeatMode: 0,
      shuffleEnabled: false,
      shuffleOrder: [],
    };
    puts = [];
    readStatus = 200;
    reads = 0;
    holdNextRead = false;
    finishRead = undefined;
    const client = new ProRoomApiClient({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/sessions')) {
          return Response.json({
            snapshot: canonical,
            session: { expiresAtMs: Date.now() + 60_000 },
          });
        }
        expect(url.pathname.endsWith('/queue-mode')).toBe(true);
        if (init?.method === 'GET') {
          reads += 1;
          const body =
            readStatus === 200
              ? mode
              : {
                  error:
                    readStatus === 401
                      ? 'SESSION_REQUIRED'
                      : readStatus === 403
                        ? 'PERMISSION_REQUIRED'
                        : 'TEMPORARILY_UNAVAILABLE',
                };
          if (!holdNextRead) return Response.json(body, { status: readStatus });
          holdNextRead = false;
          const json = JSON.stringify(body);
          let canceled = false;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(json.slice(0, -1)));
                finishRead = () => {
                  if (canceled) return;
                  canceled = true;
                  controller.enqueue(new TextEncoder().encode('}'));
                  controller.close();
                };
              },
              cancel() {
                canceled = true;
              },
            }),
            { status: readStatus, headers: { 'content-type': 'application/json' } },
          );
        }
        const body = JSON.parse(String(init?.body)) as ModeWrite;
        puts.push(body);
        expect(canonical.viewer?.capabilities).toContain('queue.mutate');
        expect(body.baseRevision).toBe(mode.revision);
        expect(body.playlistRevision).toBe(canonical.playlistRevision);
        expect(body.shuffleEnabled ? [...body.shuffleOrder].sort() : body.shuffleOrder).toEqual(
          body.shuffleEnabled ? canonical.playlist.map((item) => item.queueItemId).sort() : [],
        );
        mode = {
          ...mode,
          repeatMode: body.repeatMode,
          shuffleEnabled: body.shuffleEnabled,
          shuffleOrder: body.shuffleOrder,
          revision: mode.revision + 1,
        };
        canonical = { ...canonical, queueModeRevision: mode.revision };
        return Response.json(mode);
      },
    });
    // Transport fixtures only: join, toggle, authority, persistence and parsing
    // are production paths. A held body exercises native async JSON parsing.
    vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockImplementation((input, signal) =>
      nativeCreateSession.call(client, input, signal),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'getQueueMode').mockImplementation((code, signal) =>
      nativeGetQueueMode.call(client, code, signal),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'updateQueueMode').mockImplementation((input, signal) =>
      nativeUpdateQueueMode.call(client, input, signal),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockImplementation(async () => canonical);
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
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {});
  });

  afterEach(async () => {
    finishRead?.();
    const closeCount = vi.mocked(ProRoomApiClient.prototype.closeSessionFenced).mock.calls.length;
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalledTimes(closeCount + 1),
    );
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetState();
  });

  async function join(initialReadStatus = 200) {
    readStatus = initialReadStatus;
    await joinProRoom({ code: ROOM, pin: '12345678' });
    await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    clearManagedTimer('preloadScheduleTimer');
    vi.useFakeTimers();
  }

  function toggle(field: ModeField) {
    if (field === 'repeat') toggleRepeat();
    else toggleShuffle();
  }

  function expectEnabled(field: ModeField) {
    expect(field === 'repeat' ? mode.repeatMode : mode.shuffleEnabled).toBe(
      field === 'repeat' ? 1 : true,
    );
    expect(
      field === 'repeat' ? getState('playlist.repeatMode') : getState('playlist.isShuffle'),
    ).toBe(field === 'repeat' ? 1 : true);
  }

  async function appendFromAnotherParticipant() {
    canonical = {
      ...canonical,
      revision: canonical.revision + 1,
      playlistRevision: canonical.playlistRevision + 1,
      playlist: [
        ...canonical.playlist,
        {
          queueItemId: NEXT_ITEM,
          name: 'Next',
          source: { kind: 'youtube', videoId: 'M7lc1UVf-VE' },
        },
      ],
    };
    // The public Worker keeps the mode revision unchanged when appending while
    // shuffle is off, but its projection follows the new playlist revision.
    mode = { ...mode, playlistRevision: canonical.playlistRevision };
    acceptProRoomRealtimeFrameForTests({
      type: 'pro-server-event',
      version: 1,
      roomCode: ROOM,
      coordinatorEpoch: 1,
      event: {
        type: 'pro-room-invalidated',
        roomRevision: canonical.revision,
        playlistRevision: canonical.playlistRevision,
      },
    });
    await vi.waitFor(() => expect(getState('playlist.items')).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(0);
  }

  async function observeAuthority(canMutateQueue: boolean) {
    const authority = snapshot(canonical.revision + 1, canMutateQueue);
    canonical = {
      ...canonical,
      revision: authority.revision,
      presence: authority.presence,
      viewer: authority.viewer,
      administrators: authority.administrators,
    };
    acceptProRoomRealtimeFrameForTests({
      type: 'pro-server-event',
      version: 1,
      roomCode: ROOM,
      coordinatorEpoch: 1,
      event: { type: 'pro-presence-snapshot', presenceRevision: authority.presence.revision },
    });
    await vi.waitFor(() =>
      expect(getState('room.context').capabilities.includes('queue.mutate')).toBe(canMutateQueue),
    );
  }

  it.each(['repeat', 'shuffle'] as const)(
    'preserves the first %s gesture when initial reads recover',
    async (field) => {
      await join(503);
      readStatus = 200;
      toggle(field);
      await vi.advanceTimersByTimeAsync(400);
      expect(puts).toHaveLength(1);
      expectEnabled(field);
    },
  );

  it.each(['repeat', 'shuffle'] as const)(
    'persists the healthy first %s gesture without a required read',
    async (field) => {
      await join();
      const initialReads = reads;
      toggle(field);
      await vi.advanceTimersByTimeAsync(400);
      expect(reads).toBe(initialReads);
      expect(puts).toHaveLength(1);
      expectEnabled(field);
    },
  );

  it('continues the repeat cycle after recovering the first gesture', async () => {
    await join(503);
    readStatus = 200;
    toggleRepeat();
    await vi.advanceTimersByTimeAsync(400);
    expectEnabled('repeat');
    toggleRepeat();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts.map((put) => put.repeatMode)).toEqual([1, 2]);
    expect(mode.repeatMode).toBe(2);
    expect(getState('playlist.repeatMode')).toBe(2);
  });

  it.each(['repeat', 'shuffle'] as const)(
    'retries a transient required read and saves %s after append',
    async (field) => {
      await join();
      readStatus = 503;
      await appendFromAnotherParticipant();
      toggle(field);
      await vi.advanceTimersByTimeAsync(400);
      expect(puts).toHaveLength(0);
      readStatus = 200;
      await vi.advanceTimersByTimeAsync(1_100);
      expect(puts).toHaveLength(1);
      expectEnabled(field);
    },
  );

  it.each(['repeat', 'shuffle'] as const)('saves healthy post-append %s intent', async (field) => {
    await join();
    await appendFromAnotherParticipant();
    toggle(field);
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(1);
    expectEnabled(field);
  });

  it('does not publish defaults merely because a read recovers', async () => {
    await join(503);
    readStatus = 200;
    await observeAuthority(true);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(puts).toHaveLength(0);
  });

  it.each(['repeat', 'shuffle'] as const)(
    'merges first %s intent with the untouched canonical field',
    async (field) => {
      await join(503);
      mode = {
        ...mode,
        repeatMode: field === 'repeat' ? 0 : 2,
        shuffleEnabled: field === 'repeat',
        shuffleOrder: field === 'repeat' ? [ITEM] : [],
      };
      readStatus = 200;
      toggle(field);
      await vi.advanceTimersByTimeAsync(400);
      expect(puts).toHaveLength(1);
      expect(mode.repeatMode).toBe(field === 'repeat' ? 1 : 2);
      expect(mode.shuffleEnabled).toBe(true);
      expect(mode.shuffleOrder).toEqual([ITEM]);
    },
  );

  it('bounds failed-read retries and lets a new gesture recover after exhaustion', async () => {
    await join(503);
    toggleRepeat();
    const initialReads = reads;
    await vi.advanceTimersByTimeAsync(14_500);
    expect(reads - initialReads).toBe(4);
    expect(puts).toHaveLength(0);
    expect(getManagedTimer(CHECKPOINT_TIMER)).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads - initialReads).toBe(4);
    readStatus = 200;
    toggleShuffle();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(1);
    expect(mode).toMatchObject({ repeatMode: 1, shuffleEnabled: true });
  });

  it.each(['repeat', 'shuffle'] as const)(
    'keeps a newer %s gesture made while the successful required read is pending',
    async (freshField) => {
      await join(503);
      readStatus = 200;
      holdNextRead = true;
      toggleRepeat();
      await vi.advanceTimersByTimeAsync(400);
      expect(finishRead).toBeTypeOf('function');
      expect(puts).toHaveLength(0);
      toggle(freshField);
      finishRead!();
      await vi.advanceTimersByTimeAsync(400);
      expect(puts).toHaveLength(1);
      expect(mode).toMatchObject({
        repeatMode: freshField === 'repeat' ? 2 : 1,
        shuffleEnabled: freshField === 'shuffle',
      });
    },
  );

  it.each([401, 403])(
    'retires an intent after required GET status %s and permits a fresh other-field edit',
    async (status) => {
      await join(503);
      readStatus = status;
      toggleRepeat();
      await vi.advanceTimersByTimeAsync(400);
      expect(puts).toHaveLength(0);
      expect(getManagedTimer(CHECKPOINT_TIMER)).toBeNull();
      readStatus = 200;
      toggleShuffle();
      await vi.advanceTimersByTimeAsync(400);
      expect(puts).toHaveLength(1);
      expect(mode).toMatchObject({ repeatMode: 0, shuffleEnabled: true });
      expect(getState('playlist.repeatMode')).toBe(0);
    },
  );

  it.each([401, 403, 503])(
    'handles a pending GET status %s without replacing a newer other-field debounce',
    async (status) => {
      await join(503);
      readStatus = status;
      holdNextRead = true;
      toggleRepeat();
      await vi.advanceTimersByTimeAsync(400);
      expect(finishRead).toBeTypeOf('function');
      toggleShuffle();
      readStatus = 200;
      finishRead!();
      await vi.advanceTimersByTimeAsync(400);
      expect(puts).toHaveLength(1);
      expect(mode).toMatchObject({ repeatMode: status === 503 ? 1 : 0, shuffleEnabled: true });
      expect(getManagedTimer(CHECKPOINT_TIMER)).toBeNull();
    },
  );

  it.each([401, 403, 503])(
    'preserves a newer same-field gesture while a GET status %s body is pending',
    async (status) => {
      await join(503);
      readStatus = status;
      holdNextRead = true;
      toggleRepeat();
      await vi.advanceTimersByTimeAsync(400);
      expect(finishRead).toBeTypeOf('function');
      toggleRepeat();
      readStatus = 200;
      finishRead!();
      await vi.advanceTimersByTimeAsync(400);
      expect(puts).toHaveLength(1);
      expect(mode).toMatchObject({ repeatMode: 2, shuffleEnabled: false });
    },
  );

  it.each([false, true])(
    'retires a pending read across revoke/regrant (fresh shuffle=%s)',
    async (freshShuffle) => {
      await join(503);
      readStatus = 200;
      holdNextRead = true;
      toggleRepeat();
      await vi.advanceTimersByTimeAsync(400);
      expect(finishRead).toBeTypeOf('function');
      await observeAuthority(false);
      await observeAuthority(true);
      if (freshShuffle) toggleShuffle();
      finishRead!();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(puts).toHaveLength(freshShuffle ? 1 : 0);
      expect(mode).toMatchObject({ repeatMode: 0, shuffleEnabled: freshShuffle });
      expect(getState('playlist.repeatMode')).toBe(0);
      expect(getManagedTimer(CHECKPOINT_TIMER)).toBeNull();
    },
  );

  it('retires a scheduled read retry across revoke/regrant', async () => {
    await join(503);
    toggleRepeat();
    await vi.advanceTimersByTimeAsync(400);
    expect(getManagedTimer(CHECKPOINT_TIMER)).not.toBeNull();
    await observeAuthority(false);
    readStatus = 200;
    await observeAuthority(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(puts).toHaveLength(0);
    toggleShuffle();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(1);
    expect(mode).toMatchObject({ repeatMode: 0, shuffleEnabled: true });
  });

  it('does not resume an old required read after leaving and rejoining the same room', async () => {
    await join(503);
    readStatus = 200;
    holdNextRead = true;
    toggleRepeat();
    await vi.advanceTimersByTimeAsync(400);
    expect(finishRead).toBeTypeOf('function');
    const oldRead = finishRead!;
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalled(),
    );
    vi.useRealTimers();
    await join();
    oldRead();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(puts).toHaveLength(0);
    expect(mode.repeatMode).toBe(0);
    toggleShuffle();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(1);
    expect(mode).toMatchObject({ repeatMode: 0, shuffleEnabled: true });
  });
});
