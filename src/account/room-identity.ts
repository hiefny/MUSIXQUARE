import { createBusScope } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { getPeer } from '../network/peer-state.ts';
import type { StandardRoomAssertionRequest } from '../network/transport/types.ts';
import { getRoomContext } from '../rooms/authority.ts';
import {
  AccountApiError,
  getStandardRoomIdentityAssertions,
  type StandardRoomIdentityAssertions,
} from './api.ts';
import { getAccountSnapshot, subscribeAccount } from './state.ts';

const _busScope = createBusScope();
let _unsubscribeAccount: (() => void) | null = null;

export async function requestStandardRoomAccountAssertion(
  input: StandardRoomAssertionRequest,
): Promise<StandardRoomIdentityAssertions | undefined> {
  const snapshot = getAccountSnapshot();
  if (snapshot.status === 'loading' || snapshot.status === 'unavailable') return undefined;
  if (snapshot.configured === false) {
    return { accountAssertion: null, deletionAssertion: null };
  }
  try {
    return await getStandardRoomIdentityAssertions(input);
  } catch (error) {
    // An authoritative session rejection must clear the signaling identity.
    // Network/5xx failures retain it only until the Worker's signed lease
    // expires, avoiding a transient auth outage becoming an instant downgrade.
    if (error instanceof AccountApiError && error.status === 401) {
      return { accountAssertion: null, deletionAssertion: null };
    }
    // Login is optional. Authentication/storage outages must never block the
    // existing anonymous host/guest handshake.
    return undefined;
  }
}

function refreshCurrentStandardRoomIdentity(): void {
  if (!getState('setup.sessionStarted') || getRoomContext().kind === 'pro') return;
  void getPeer()?.refreshStandardRoomIdentity?.();
}

/** Refresh the server-owned room identity when login/profile state changes. */
export function initAccountRoomIdentity(): void {
  _unsubscribeAccount?.();
  _unsubscribeAccount = subscribeAccount(refreshCurrentStandardRoomIdentity);
  _busScope.dispose();
  _busScope.on('state:setup.sessionStarted', refreshCurrentStandardRoomIdentity);
  _busScope.on('setup:guest-join-success', refreshCurrentStandardRoomIdentity);
  _busScope.on('account:deleted', () => {
    if (!getState('setup.sessionStarted') || getRoomContext().kind === 'pro') return;
    getPeer()?.deleteStandardRoomIdentity?.();
  });
  refreshCurrentStandardRoomIdentity();
}

export function __resetAccountRoomIdentityForTests(): void {
  _unsubscribeAccount?.();
  _unsubscribeAccount = null;
  _busScope.dispose();
}
