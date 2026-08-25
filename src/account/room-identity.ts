import { createBusScope } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { getPeer } from '../network/peer-state.ts';
import type { StandardRoomAssertionRequest } from '../network/transport/types.ts';
import { getRoomContext } from '../rooms/authority.ts';
import {
  AccountApiError,
  getStandardRoomIdentityAssertions,
  type StandardRoomIdentityAssertions,
} from './api.ts';
import {
  getAccountSnapshot,
  getAccountStatsScope,
  subscribeAccount,
  type AccountSnapshot,
} from './state.ts';

const _busScope = createBusScope();
let _unsubscribeAccount: (() => void) | null = null;
let _lastAccountProjectionKey: string | null = null;
let _refreshQueued = false;
let _refreshScheduleGeneration = 0;
const _assertionsInFlight = new Map<string, Promise<StandardRoomIdentityAssertions | undefined>>();

function observeStandardRoomIdentityRefresh(operation: Promise<void> | undefined): void {
  if (!operation) return;
  operation.catch((error) => {
    log.warn('[Account] Standard room identity refresh failed', error);
  });
}

function accountProjectionKey(snapshot: Readonly<AccountSnapshot>): string | null {
  if (snapshot.status === 'loading' || snapshot.status === 'unavailable') return null;
  if (snapshot.configured === false) return 'disabled';
  if (snapshot.status === 'authenticated' && snapshot.account) {
    return JSON.stringify([
      'authenticated',
      getAccountStatsScope(),
      snapshot.account.nickname,
      snapshot.account.profileComplete,
    ]);
  }
  return 'anonymous';
}

function assertionRequestKey(input: StandardRoomAssertionRequest): string {
  return JSON.stringify([
    input.roomCode,
    input.peerId,
    input.role,
    accountProjectionKey(getAccountSnapshot()),
  ]);
}

async function requestStandardRoomAccountAssertionUncoalesced(
  input: StandardRoomAssertionRequest,
): Promise<StandardRoomIdentityAssertions | undefined> {
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

export async function requestStandardRoomAccountAssertion(
  input: StandardRoomAssertionRequest,
): Promise<StandardRoomIdentityAssertions | undefined> {
  const snapshot = getAccountSnapshot();
  if (snapshot.status === 'loading' || snapshot.status === 'unavailable') return undefined;
  if (snapshot.configured === false) {
    return { accountAssertion: null, deletionAssertion: null };
  }
  const key = assertionRequestKey(input);
  const existing = _assertionsInFlight.get(key);
  if (existing) return existing;

  const request = requestStandardRoomAccountAssertionUncoalesced(input)
    .then((assertions) => {
      // Coalescing is projection-scoped, but a request can finish after the
      // browser has logged out, switched sessions, or changed profile. Never
      // return an assertion minted for the superseded account projection; the
      // account-state subscriber starts a fresh transport refresh for the new
      // projection.
      return assertionRequestKey(input) === key ? assertions : undefined;
    })
    .finally(() => {
      if (_assertionsInFlight.get(key) === request) _assertionsInFlight.delete(key);
    });
  _assertionsInFlight.set(key, request);
  return request;
}

function refreshCurrentStandardRoomIdentity(): void {
  if (!getState('setup.sessionStarted') || getRoomContext().kind === 'pro') return;
  if (_refreshQueued) return;
  _refreshQueued = true;
  const generation = _refreshScheduleGeneration;
  queueMicrotask(() => {
    if (generation !== _refreshScheduleGeneration) return;
    _refreshQueued = false;
    if (!getState('setup.sessionStarted') || getRoomContext().kind === 'pro') return;
    observeStandardRoomIdentityRefresh(getPeer()?.refreshStandardRoomIdentity?.());
  });
}

function handleAccountProjection(snapshot: Readonly<AccountSnapshot>): void {
  const key = accountProjectionKey(snapshot);
  // Loading/unavailable is deliberately non-authoritative. The signaling
  // Worker retains the previous identity only until its signed 60-second
  // lease expires, while the transport's 5-second retry remains armed.
  if (key === null || key === _lastAccountProjectionKey) return;
  _lastAccountProjectionKey = key;
  refreshCurrentStandardRoomIdentity();
}

/** Refresh the server-owned room identity when login/profile state changes. */
export function initAccountRoomIdentity(): void {
  _unsubscribeAccount?.();
  _lastAccountProjectionKey = accountProjectionKey(getAccountSnapshot());
  _unsubscribeAccount = subscribeAccount(handleAccountProjection);
  _busScope.dispose();
  _busScope.on('state:setup.sessionStarted', refreshCurrentStandardRoomIdentity);
  _busScope.on('setup:guest-join-success', refreshCurrentStandardRoomIdentity);
  const deleteCurrentStandardRoomIdentity = () => {
    if (!getState('setup.sessionStarted') || getRoomContext().kind === 'pro') return;
    getPeer()?.deleteStandardRoomIdentity?.();
  };
  _busScope.on('account:deleted', deleteCurrentStandardRoomIdentity);
  _busScope.on('account:deletion-pending', deleteCurrentStandardRoomIdentity);
  refreshCurrentStandardRoomIdentity();
}

export function __resetAccountRoomIdentityForTests(): void {
  _unsubscribeAccount?.();
  _unsubscribeAccount = null;
  _busScope.dispose();
  _lastAccountProjectionKey = null;
  _assertionsInFlight.clear();
  _refreshQueued = false;
  _refreshScheduleGeneration += 1;
}
