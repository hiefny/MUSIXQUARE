/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAccountSession, setAccountAnonymous } from '../../account/state.ts';
import { bus } from '../../core/events.ts';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { t } from '../../i18n/index.ts';
import { togglePlay } from '../../player/transport.ts';
import type { PlaylistSlotsSummary, QueueItemId } from '../../types/index.ts';
import { ProRoomApiClient, type ProRoomSignalingAccess } from '../api.ts';
import { ProRoomApiError } from '../api-error.ts';
import {
  capabilitiesForProRoomRole,
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPermissionSet,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { captureProRoomMediaHookSession } from '../media-hooks.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import {
  registerProPlaybackMediaEndpoint,
  routeProPlaybackCommand,
} from '../playback-authority-hooks.ts';
import { joinProRoom, requestFirstAppendSelectionForTests } from '../runtime.ts';
import { proHeartbeat } from './__helpers__/pro-heartbeat.ts';
import { proSnapshot } from './__helpers__/pro-snapshot.ts';

/**
 * A full PRO room receipt ledger refuses playback commands with
 * ROOM_STATE_CAPACITY_EXCEEDED too (RO-53). Nothing changed and the receipts
 * expire within minutes, so a person who pressed a control is told the room
 * cannot take more changes for now, as on the playlist paths. Only the newest
 * gesture is told; the app's own commands stay silent.
 */
const ROOM = '012345';
const FIRST = '5c000000-0000-4000-8000-000000000001' as QueueItemId;
const SECOND = '5c000000-0000-4000-8000-000000000002' as QueueItemId;
const FIRST_VIDEO = 'dQw4w9WgXcQ';
const SECOND_VIDEO = 'M7lc1UVf-VE';
const SLOTS: PlaylistSlotsSummary = {
  activeSlot: 0,
  slots: [
    { count: 2, bytes: null },
    { count: 0, bytes: null },
    { count: 0, bytes: null },
  ],
};
const FULL_LEDGER = new ProRoomApiError('ROOM_STATE_CAPACITY_EXCEEDED', 409);

type RoutedCommand = Parameters<typeof routeProPlaybackCommand>[0];

type CommandCase = {
  readonly kind: string;
  readonly command: RoutedCommand;
  /** Passed by the controls that show pending feedback (play, pause, seek). */
  readonly ui?: Parameters<typeof routeProPlaybackCommand>[1];
};

const PLAY: CommandCase = {
  kind: 'play',
  command: { kind: 'play', queueItemId: FIRST, positionSeconds: 0 },
  ui: { wasPlaying: false },
};
const NEXT: RoutedCommand = { kind: 'next', queueItemId: FIRST, positionSeconds: 0 };
// The app's report that the first track reached its end.
const TRACK_END: RoutedCommand = {
  kind: 'ended',
  queueItemId: FIRST,
  positionSeconds: 212,
  observedPositionSeconds: 212,
  durationSeconds: 212,
  mediaKind: 'youtube',
  youtubeSubIndex: 0,
  youtubeVideoId: FIRST_VIDEO,
};

// A person's commands, routed the way their controls route them.
const PERSON_COMMANDS: readonly CommandCase[] = [
  PLAY,
  {
    kind: 'pause',
    command: { kind: 'pause', queueItemId: FIRST, positionSeconds: 0 },
    ui: { wasPlaying: true },
  },
  { kind: 'stop', command: { kind: 'stop', queueItemId: FIRST, positionSeconds: 0 } },
  {
    kind: 'seek',
    command: { kind: 'seek', queueItemId: FIRST, positionSeconds: 30 },
    ui: { wasPlaying: false },
  },
  { kind: 'next', command: NEXT },
  { kind: 'previous', command: { kind: 'previous', queueItemId: FIRST, positionSeconds: 0 } },
  {
    kind: 'select',
    command: {
      kind: 'select',
      queueItemId: SECOND,
      positionSeconds: 0,
      youtubeSubIndex: 0,
      youtubeVideoId: SECOND_VIDEO,
    },
  },
];

// What src/youtube/native-control-authority.ts routes for an OS media key or the
// YouTube player's own control. Its Play shows no pending feedback.
const NATIVE_COMMANDS: readonly CommandCase[] = [
  { kind: 'play', command: { kind: 'play', queueItemId: FIRST, positionSeconds: 12 } },
  {
    kind: 'pause',
    command: { kind: 'pause', queueItemId: FIRST, positionSeconds: 12 },
    ui: { wasPlaying: true },
  },
];

// The app's own commands for what the media did, and the command each sends.
const APP_OBSERVATIONS: readonly (CommandCase & { readonly sent: string })[] = [
  { kind: 'ended', sent: 'ended', command: TRACK_END },
  {
    kind: 'unavailable',
    sent: 'unavailable',
    command: {
      kind: 'unavailable',
      queueItemId: FIRST,
      positionSeconds: 0,
      observedPositionSeconds: 0,
      durationSeconds: null,
      mediaKind: 'youtube',
      youtubeSubIndex: 0,
      youtubeVideoId: FIRST_VIDEO,
    },
  },
  {
    kind: 'advance-sub-video',
    sent: 'next',
    command: { kind: 'advance-sub-video', queueItemId: FIRST, positionSeconds: 212 },
  },
];

function snapshot(phase: 'idle' | 'paused' = 'paused'): ProRoomSnapshot {
  const permissions: ProRoomPermissionSet = {
    'media.add': true,
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
  // Paused on the first track, or idle where an added first track starts.
  const current = phase === 'paused' ? FIRST : null;
  return proSnapshot({
    roomCode: ROOM,
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [
      { queueItemId: FIRST, name: 'First', source: { kind: 'youtube', videoId: FIRST_VIDEO } },
      { queueItemId: SECOND, name: 'Second', source: { kind: 'youtube', videoId: SECOND_VIDEO } },
    ],
    currentQueueItemId: current,
    playback: {
      coordinatorEpoch: 1,
      revision: 1,
      state: phase,
      queueItemId: current,
      positionSeconds: 0,
      youtubeVideoId: current ? FIRST_VIDEO : null,
      youtubeSubIndex: current ? 0 : null,
      updatedAtMs: 1,
    },
    presence: {
      coordinatorEpoch: 1,
      revision: 1,
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
    },
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
    playlistSlots: SLOTS,
  });
}

/** Let a late toast or settlement surface before the lists are read. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The playback command types this tab has sent, in order. */
function sentCommands(): string[] {
  const executeCommand = vi.mocked(ProRoomApiClient.prototype.executePlaybackCommand);
  return executeCommand.mock.calls.map(([input]) => input.command.type);
}

async function join(canonical: ProRoomSnapshot, failure: Error): Promise<void> {
  resetState();
  applyAccountSession({
    configured: true,
    authenticated: true,
    account: { nickname: 'Controller', profileComplete: true },
    statsScope: 'a'.repeat(43),
  });
  // A local media endpoint applies the persisted checkpoint, as the player
  // does. The app fences its own media reports to that applied checkpoint.
  let checkpointApplied = false;
  registerProPlaybackMediaEndpoint({
    prepare: async (request) => ({
      status: 'ready',
      authority: request.authority,
      queueItemId: request.queueItemId,
      mediaKind: 'youtube',
      durationSeconds: 212,
      youtubeVideoId: request.youtubeVideoId ?? null,
      youtubeSubIndex: request.youtubeSubIndex ?? null,
    }),
    commit: async (request) => {
      setState('playlist.currentQueueItemId', request.queueItemId);
      checkpointApplied = true;
      return { status: 'applied', authority: request.authority };
    },
  });
  vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockResolvedValue(canonical);
  vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockResolvedValue(proHeartbeat(canonical));
  vi.spyOn(ProRoomApiClient.prototype, 'getSnapshot').mockResolvedValue(canonical);
  vi.spyOn(ProRoomApiClient.prototype, 'attachCurrentAccount').mockResolvedValue(canonical);
  vi.spyOn(ProRoomApiClient.prototype, 'renewCurrentAccountLease').mockImplementation(async () => ({
    leaseExpiresAtMs: Date.now() + 120_000,
  }));
  vi.spyOn(ProRoomApiClient.prototype, 'executePlaybackCommand').mockRejectedValue(failure);
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
  vi.spyOn(ProRoomApiClient.prototype, 'getQueueMode').mockResolvedValue({
    schemaVersion: 1,
    view: 'queue-mode',
    roomCode: ROOM,
    revision: 0,
    playlistRevision: canonical.playlistRevision,
    updatedAtMs: 1,
    repeatMode: 0,
    shuffleEnabled: false,
    shuffleOrder: [],
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
  vi.spyOn(ServerProRoomNetworkBridge.prototype, 'reconfigure').mockResolvedValue(undefined);
  vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {});
  await joinProRoom({ code: ROOM, pin: '12345678' });
  await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
  await vi.waitFor(() => expect(getState('playlist.slots')).toEqual(SLOTS));
  await vi.waitFor(() => expect(checkpointApplied).toBe(true));
  await nextTask();
}

describe('PRO playback feedback when the room receipt ledger is full', () => {
  let stopObserving: (() => void) | null = null;

  afterEach(async () => {
    stopObserving?.();
    stopObserving = null;
    // Wait for this session's own close: a test that left and rejoined has
    // already closed one, and restoring the mocks first would send this one.
    const closeSession = vi.mocked(ProRoomApiClient.prototype.closeSessionFenced);
    const closedBefore = closeSession.mock.calls.length;
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await vi.waitFor(() => expect(closeSession.mock.calls.length).toBeGreaterThan(closedBefore));
    registerProPlaybackMediaEndpoint(null);
    setAccountAnonymous();
    vi.restoreAllMocks();
    resetState();
  });

  /** Collect toasts and settled control feedback from now on. */
  function observeFeedback(): { readonly toasts: string[]; readonly settled: string[] } {
    const toasts: string[] = [];
    const settled: string[] = [];
    const stops = [
      bus.on('ui:show-toast', (message) => {
        toasts.push(String(message));
      }),
      bus.on('pro-playback:ui-control-settled', (event) => {
        settled.push(event.status);
      }),
    ];
    stopObserving = () => {
      for (const stop of stops) stop();
    };
    return { toasts, settled };
  }

  async function expectRoomLimitToast({ command, ui }: CommandCase): Promise<void> {
    await join(snapshot(), FULL_LEDGER);
    const { toasts, settled } = observeFeedback();

    expect(routeProPlaybackCommand(command, ui)).toBe(true);
    await vi.waitFor(() => expect(toasts).not.toEqual([]));
    await nextTask();

    expect(toasts).toEqual([t('pro.room_state_limit')]);
    // A control that showed pending feedback gets its failure back as before.
    await vi.waitFor(() => expect(settled).toEqual(ui ? ['failed'] : []));
  }

  it.each(PERSON_COMMANDS)(
    'says the room cannot take more changes when it refuses $kind',
    expectRoomLimitToast,
  );

  it.each(NATIVE_COMMANDS)(
    'says the room cannot take more changes when it refuses a media key or player $kind',
    expectRoomLimitToast,
  );

  it('says it only for the newest of two refused gestures', async () => {
    await join(snapshot(), FULL_LEDGER);
    const { toasts } = observeFeedback();

    // A double tap: the second command waits behind the first, and both fail.
    expect(routeProPlaybackCommand(NEXT)).toBe(true);
    expect(routeProPlaybackCommand(NEXT)).toBe(true);
    await vi.waitFor(() => expect(sentCommands()).toEqual(['next', 'next']));
    await vi.waitFor(() => expect(toasts).not.toEqual([]));
    await nextTask();

    expect(toasts).toEqual([t('pro.room_state_limit')]);
  });

  it.each(APP_OBSERVATIONS)(
    'stays silent when it refuses the app sending $kind',
    async ({ command, sent }) => {
      await join(snapshot(), FULL_LEDGER);
      const { toasts } = observeFeedback();

      expect(routeProPlaybackCommand(command)).toBe(true);
      await vi.waitFor(() => expect(sentCommands()).toEqual([sent]));
      await nextTask();

      expect(toasts).toEqual([]);
    },
  );

  it('stays silent when it refuses to start the first added track', async () => {
    await join(snapshot('idle'), FULL_LEDGER);
    const { toasts } = observeFeedback();

    await requestFirstAppendSelectionForTests({
      roomCode: ROOM,
      queueItemId: FIRST,
      coordinatorEpoch: 1,
      basePlaybackRevision: 1,
      youtubeVideoId: FIRST_VIDEO,
      youtubeSubIndex: 0,
    });
    await nextTask();

    expect(sentCommands()).toEqual(['select']);
    expect(toasts).toEqual([]);
  });

  it.each([
    ['NETWORK_ERROR', 0, 'failed'],
    ['RATE_LIMITED', 429, 'failed'],
    ['PLAYBACK_REVISION_CONFLICT', 409, 'superseded'],
  ] as const)('keeps a play refused with %s silent', async (code, status, settlement) => {
    await join(snapshot(), new ProRoomApiError(code, status));
    const { toasts, settled } = observeFeedback();

    expect(routeProPlaybackCommand(PLAY.command, PLAY.ui)).toBe(true);
    await vi.waitFor(() => expect(settled).toEqual([settlement]));
    await nextTask();

    expect(toasts).toEqual([]);
  });

  it('stays silent when a refusal arrives after leaving and rejoining the room', async () => {
    await join(snapshot(), FULL_LEDGER);
    const executeCommand = vi.mocked(ProRoomApiClient.prototype.executePlaybackCommand);
    let refuse!: (reason: unknown) => void;
    executeCommand.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    );
    const { toasts } = observeFeedback();

    expect(routeProPlaybackCommand(NEXT)).toBe(true);
    await vi.waitFor(() => expect(sentCommands()).toEqual(['next']));
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await joinProRoom({ code: ROOM, pin: '12345678' });
    await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
    refuse(FULL_LEDGER);
    await nextTask();

    expect(toasts).not.toContain(t('pro.room_state_limit'));
  });

  it('says it for Play after the room refused the app ending the track', async () => {
    await join(snapshot(), FULL_LEDGER);
    const { toasts, settled } = observeFeedback();

    // The app's own track end is refused silently, so playback stops there.
    expect(routeProPlaybackCommand(TRACK_END)).toBe(true);
    await vi.waitFor(() => expect(sentCommands()).toEqual(['ended']));
    await nextTask();
    expect(toasts).toEqual([]);

    // In a PRO room the Play button sends play before any local end-of-track
    // advance (src/player/transport.ts), so this tap is a person's command.
    togglePlay();
    await vi.waitFor(() => expect(toasts).not.toEqual([]));
    await nextTask();

    expect(sentCommands()).toEqual(['ended', 'play']);
    expect(toasts).toEqual([t('pro.room_state_limit')]);
    await vi.waitFor(() => expect(settled).toEqual(['failed']));
  });
});
