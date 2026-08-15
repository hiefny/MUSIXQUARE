import { describe, expect, it } from 'vitest';
import type { AccountSnapshot } from '../../account/state.ts';
import {
  isProRoomAccountDetachRecoveryTarget,
  proRoomAccountCommitIdentityMatchesSnapshot,
  proRoomAccountIdentityProjectionKey,
  projectProRoomAccountCommitIdentity,
  sameProRoomAccountCommitIdentity,
} from '../account-runtime-identity.ts';
import type { ProRoomSnapshot } from '../contracts.ts';

function account(
  status: AccountSnapshot['status'],
  profileComplete: boolean | null = null,
): AccountSnapshot {
  return {
    status,
    configured: status === 'loading' || status === 'unavailable' ? null : true,
    account:
      status === 'authenticated' && profileComplete !== null
        ? { nickname: 'Same nickname', profileComplete }
        : null,
  };
}

function snapshot(
  overrides: Partial<NonNullable<ProRoomSnapshot['viewer']>> = {},
): ProRoomSnapshot {
  return {
    roomCode: '000001',
    viewer: {
      memberId: 'member_0000000001',
      memberDisplayNumber: 1,
      isAuthenticated: true,
      participantId: 'participant_00001',
      presenceIncarnationId: 'presence_0000000001',
      displayName: 'Owner',
      role: 'owner',
      capabilities: [],
      coordinatorEligible: false,
      ...overrides,
    },
  } as ProRoomSnapshot;
}

describe('PRO account runtime identity policy', () => {
  it('projects only the exact authority-fencing identity fields', () => {
    const first = projectProRoomAccountCommitIdentity(snapshot());
    const renamed = projectProRoomAccountCommitIdentity(
      snapshot({ displayName: 'Renamed', role: 'member' }),
    );

    expect(first).toEqual({
      roomCode: '000001',
      participantId: 'participant_00001',
      presenceIncarnationId: 'presence_0000000001',
      memberId: 'member_0000000001',
      isAuthenticated: true,
    });
    expect(first && renamed && sameProRoomAccountCommitIdentity(first, renamed)).toBe(true);
    expect(projectProRoomAccountCommitIdentity({ ...snapshot(), viewer: null })).toBeNull();
  });

  it.each([
    ['room code', { roomCode: '000002' }],
    ['participant', { viewer: { ...snapshot().viewer!, participantId: 'participant_00002' } }],
    [
      'presence incarnation',
      { viewer: { ...snapshot().viewer!, presenceIncarnationId: 'presence_0000000002' } },
    ],
    ['member', { viewer: { ...snapshot().viewer!, memberId: 'member_0000000002' } }],
    ['authentication', { viewer: { ...snapshot().viewer!, isAuthenticated: false } }],
  ])('rejects a snapshot with a different %s fence', (_label, replacement) => {
    const baseline = snapshot();
    const expected = projectProRoomAccountCommitIdentity(baseline)!;
    const changed = { ...baseline, ...replacement } as ProRoomSnapshot;

    expect(proRoomAccountCommitIdentityMatchesSnapshot(expected, changed)).toBe(false);
  });

  it('requires a definitive anonymous or incomplete-profile detach target', () => {
    expect(isProRoomAccountDetachRecoveryTarget(account('anonymous'))).toBe(true);
    expect(isProRoomAccountDetachRecoveryTarget(account('authenticated', false))).toBe(true);
    expect(isProRoomAccountDetachRecoveryTarget(account('authenticated', true))).toBe(false);
    expect(isProRoomAccountDetachRecoveryTarget(account('loading'))).toBe(false);
    expect(isProRoomAccountDetachRecoveryTarget(account('unavailable'))).toBe(false);
  });

  it('fences same-nickname account replacement with the opaque stats scope', () => {
    const authenticated = account('authenticated', true);

    expect(proRoomAccountIdentityProjectionKey(authenticated, 'scope-a')).not.toBe(
      proRoomAccountIdentityProjectionKey(authenticated, 'scope-b'),
    );
    expect(proRoomAccountIdentityProjectionKey(authenticated, 'scope-a')).toBe(
      proRoomAccountIdentityProjectionKey(authenticated, 'scope-a'),
    );
    expect(proRoomAccountIdentityProjectionKey(account('anonymous'), 'stale-scope')).toBe(
      proRoomAccountIdentityProjectionKey(account('anonymous'), null),
    );
  });
});
