import type { Page, Route } from '@playwright/test';
import { E2E_APP_ORIGIN } from '../config.ts';
export const PRO_ROOM_CODE = '000001';
export const OWNER_RECOVERY_CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;
export const PARTICIPANT_ID = 'participant_00001';
export const PRESENCE_INCARNATION_ID = 'presence_0000000001';
export const MEMBER_ID = 'member_0000000001';
export const PRO_SIGNALING_ORIGIN = E2E_APP_ORIGIN.replace(/^http/u, 'ws');

export function ownerSnapshot(): Record<string, unknown> {
  const capabilities = [
    'queue.mutate',
    'playback.control',
    'effects.control',
    'asset.upload',
    'members.manage',
    'room.configure',
  ];
  const permissions = {
    'media.add': true,
    'playback.control': true,
    'members.kick': true,
    'chat.notice': true,
  };
  return {
    schemaVersion: 1,
    roomCode: PRO_ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 4,
    playlistRevision: 0,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [],
    currentQueueItemId: null,
    playback: {
      coordinatorEpoch: 2,
      revision: 0,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: Date.now(),
    },
    presence: {
      coordinatorEpoch: 2,
      revision: 3,
      coordinatorParticipantId: null,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          memberId: MEMBER_ID,
          memberDisplayNumber: 0,
          isAuthenticated: true,
          displayName: 'Recovered owner',
          devicePlatform: 'other',
          role: 'owner',
          capabilities,
          joinedAtMs: Date.now(),
        },
      ],
    },
    quota: {
      limitBytes: 1024 * 1024 * 1024,
      perAssetLimitBytes: 200 * 1024 * 1024,
      usedBytes: 0,
      reservedBytes: 0,
    },
    viewer: {
      memberId: MEMBER_ID,
      memberDisplayNumber: 0,
      isAuthenticated: true,
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: PRESENCE_INCARNATION_ID,
      displayName: 'Recovered owner',
      role: 'owner',
      capabilities,
      coordinatorEligible: false,
    },
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: MEMBER_ID,
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Recovered owner',
        role: 'owner',
        permissions,
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
      },
    ],
  };
}

export function proCorsHeaders(page: Page): Record<string, string> {
  return {
    'access-control-allow-origin': new URL(page.url()).origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers':
      'content-type,idempotency-key,x-mxqr-pro-participant-id,x-mxqr-pro-presence-incarnation,x-mxqr-pro-effects-version,x-mxqr-pro-entry-policy',
    'content-type': 'application/json; charset=utf-8',
  };
}

export async function fulfillProJson(
  page: Page,
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    headers: proCorsHeaders(page),
    body: JSON.stringify(body),
  });
}
