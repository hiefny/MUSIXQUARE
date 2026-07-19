/**
 * @vitest-environment jsdom
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import { ProRoomApiClient, type ProRoomBotCommandResult } from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  capabilitiesForProRoomRole,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { LegacyProRoomNetworkBridge } from '../network-bridge.ts';
import { joinProRoom, requestActiveProRoomBotCommand } from '../runtime.ts';

const ROOM_CODE = '000002';
const PARTICIPANT_ID = 'participant_00002';

function roomSnapshot(): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 0,
    playlist: [],
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
      revision: 1,
      coordinatorParticipantId: PARTICIPANT_ID,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          displayName: 'Owner',
          role: 'owner',
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
      memberId: 'member_0000000002',
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: 'presence_0000000002',
      displayName: 'Owner',
      role: 'owner',
      capabilities: [...capabilitiesForProRoomRole('owner')],
      coordinatorEligible: true,
    },
  };
}

describe.sequential('PRO BOT runtime session lease', () => {
  const restoreSpies: Array<{ mockRestore(): void }> = [];

  afterAll(async () => {
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    for (const spy of restoreSpies.reverse()) spy.mockRestore();
  });

  it('rejects a late BOT result after the originating PRO session is left', async () => {
    resetState();
    const snapshot = roomSnapshot();
    let resolveBot!: (result: ProRoomBotCommandResult) => void;

    restoreSpies.push(
      vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockResolvedValue(snapshot),
      vi.spyOn(ProRoomApiClient.prototype, 'createSignalingTicket').mockResolvedValue({
        ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}`,
        expiresAtMs: Date.now() + 60_000,
        role: 'coordinator',
        coordinatorEpoch: 1,
        presenceIncarnationId: snapshot.viewer!.presenceIncarnationId,
        ticketSequence: 1,
      }),
      vi.spyOn(ProRoomApiClient.prototype, 'getEffects').mockResolvedValue({
        schemaVersion: 1,
        view: 'effects',
        roomCode: ROOM_CODE,
        revision: 0,
        updatedAtMs: 1,
        effects: createDefaultRoomEffectsState(),
      }),
      vi.spyOn(ProRoomApiClient.prototype, 'getQueueMode').mockResolvedValue({
        schemaVersion: 1,
        view: 'queue-mode',
        roomCode: ROOM_CODE,
        revision: 0,
        playlistRevision: 0,
        updatedAtMs: 1,
        repeatMode: 0,
        shuffleEnabled: false,
        shuffleOrder: [],
      }),
      vi.spyOn(ProRoomApiClient.prototype, 'getSystemAudioState').mockResolvedValue({
        generation: 0,
        status: 'idle',
        ownerParticipantId: null,
        claimExpiresAt: null,
        liveExpiresAt: null,
        publication: null,
      }),
      vi.spyOn(ProRoomApiClient.prototype, 'closePresenceOnUnload').mockResolvedValue(undefined),
      vi.spyOn(ProRoomApiClient.prototype, 'closeSessionFenced').mockResolvedValue(undefined),
      vi.spyOn(ProRoomApiClient.prototype, 'runBotCommand').mockImplementation(
        () =>
          new Promise<ProRoomBotCommandResult>((resolve) => {
            resolveBot = resolve;
          }),
      ),
      vi.spyOn(LegacyProRoomNetworkBridge.prototype, 'connect').mockResolvedValue(undefined),
      vi.spyOn(LegacyProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {}),
    );

    await joinProRoom({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });

    const request = requestActiveProRoomBotCommand(
      ROOM_CODE,
      'play something',
      'runtime-bot-session-lease-test',
    );
    await vi.waitFor(() => expect(ProRoomApiClient.prototype.runBotCommand).toHaveBeenCalledOnce());

    const rejection = expect(request).rejects.toMatchObject({
      code: 'BOT_SESSION_SUPERSEDED',
    });
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    resolveBot({ ok: true, summary: 'stale result', addedCount: 1, playbackChanged: true });

    await rejection;
  });
});
