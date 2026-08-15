import type { AccountSnapshot } from '../account/state.ts';
import type { ProRoomSnapshot } from './contracts.ts';

/**
 * Exact browser/session identity that authorizes media-hook renewal after an
 * account transition. Display names and roles are deliberately excluded:
 * neither is a stable authority fence.
 */
export interface ProRoomAccountCommitIdentity {
  roomCode: string;
  participantId: string;
  presenceIncarnationId: string;
  memberId: string;
  isAuthenticated: boolean;
}

export function projectProRoomAccountCommitIdentity(
  snapshot: Readonly<ProRoomSnapshot>,
): ProRoomAccountCommitIdentity | null {
  const viewer = snapshot.viewer;
  if (!viewer) return null;
  return {
    roomCode: snapshot.roomCode,
    participantId: viewer.participantId,
    presenceIncarnationId: viewer.presenceIncarnationId,
    memberId: viewer.memberId,
    isAuthenticated: viewer.isAuthenticated,
  };
}

export function proRoomAccountCommitIdentityMatchesSnapshot(
  expected: Readonly<ProRoomAccountCommitIdentity>,
  snapshot: Readonly<ProRoomSnapshot> | null,
): boolean {
  const current = snapshot ? projectProRoomAccountCommitIdentity(snapshot) : null;
  return current !== null && sameProRoomAccountCommitIdentity(expected, current);
}

export function sameProRoomAccountCommitIdentity(
  left: Readonly<ProRoomAccountCommitIdentity>,
  right: Readonly<ProRoomAccountCommitIdentity>,
): boolean {
  return (
    left.roomCode === right.roomCode &&
    left.participantId === right.participantId &&
    left.presenceIncarnationId === right.presenceIncarnationId &&
    left.memberId === right.memberId &&
    left.isAuthenticated === right.isAuthenticated
  );
}

/** A definitive local target for recovering a lost detach response. */
export function isProRoomAccountDetachRecoveryTarget(account: Readonly<AccountSnapshot>): boolean {
  return (
    account.status === 'anonymous' ||
    (account.status === 'authenticated' && account.account?.profileComplete === false)
  );
}

/**
 * Key for account projections that can change a live room identity. The
 * opaque stats scope distinguishes account replacement even when two accounts
 * have the same nickname.
 */
export function proRoomAccountIdentityProjectionKey(
  snapshot: Readonly<AccountSnapshot>,
  accountStatsScope: string | null,
): string {
  if (snapshot.status === 'authenticated' && snapshot.account) {
    return JSON.stringify([
      'authenticated',
      accountStatsScope,
      snapshot.account.nickname,
      snapshot.account.profileComplete,
    ]);
  }
  return JSON.stringify([snapshot.status, snapshot.configured]);
}
