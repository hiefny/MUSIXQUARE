import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { setPeer } from '../../network/peer-state.ts';
import type { PeerInstance } from '../../types/index.ts';
import * as accountApi from '../api.ts';
import { AccountApiError } from '../api.ts';
import {
  __resetAccountRoomIdentityForTests,
  initAccountRoomIdentity,
  requestStandardRoomAccountAssertion,
} from '../room-identity.ts';
import { __resetAccountStateForTests, applyAccountSession } from '../state.ts';

function authenticate(nickname = 'Minsu'): void {
  applyAccountSession({
    configured: true,
    authenticated: true,
    account: { nickname, profileComplete: true },
    statsScope: 's'.repeat(43),
  });
}

beforeEach(() => {
  __resetAccountRoomIdentityForTests();
  __resetAccountStateForTests();
  resetState();
  setPeer(null);
});

afterEach(() => {
  __resetAccountRoomIdentityForTests();
  __resetAccountStateForTests();
  setPeer(null);
  vi.restoreAllMocks();
});

describe('account identity room projection', () => {
  it('refreshes the signed signaling identity once a standard room starts', () => {
    authenticate();
    const refreshStandardRoomIdentity = vi.fn(async () => {});
    setPeer({ refreshStandardRoomIdentity } as unknown as PeerInstance);
    initAccountRoomIdentity();

    setState('setup.sessionStarted', true);

    expect(refreshStandardRoomIdentity).toHaveBeenCalledOnce();
  });

  it('does not project anonymous identity or bypass the PRO account attach path', () => {
    setState('setup.sessionStarted', true);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
    const refreshStandardRoomIdentity = vi.fn(async () => {});
    setPeer({ refreshStandardRoomIdentity } as unknown as PeerInstance);
    initAccountRoomIdentity();
    authenticate();

    expect(refreshStandardRoomIdentity).not.toHaveBeenCalled();
  });

  it('refreshes even when the visible nickname is unchanged so the lease stays live', () => {
    authenticate();
    setState('network.myDeviceLabel', 'Minsu');
    setState('setup.sessionStarted', true);
    const refreshStandardRoomIdentity = vi.fn(async () => {});
    setPeer({ refreshStandardRoomIdentity } as unknown as PeerInstance);

    initAccountRoomIdentity();

    expect(refreshStandardRoomIdentity).toHaveBeenCalledOnce();
  });

  it('clears on authoritative 401 but retains only through transient auth outages', async () => {
    authenticate();
    const input = { roomCode: '123456', peerId: 'guest-a', role: 'guest' as const };
    vi.spyOn(accountApi, 'getStandardRoomIdentityAssertions').mockRejectedValueOnce(
      new AccountApiError('AUTH_REQUIRED', 401),
    );
    await expect(requestStandardRoomAccountAssertion(input)).resolves.toEqual({
      accountAssertion: null,
      deletionAssertion: null,
    });

    vi.spyOn(accountApi, 'getStandardRoomIdentityAssertions').mockRejectedValueOnce(
      new AccountApiError('AUTH_TEMPORARILY_UNAVAILABLE', 503),
    );
    await expect(requestStandardRoomAccountAssertion(input)).resolves.toBeUndefined();
  });

  it('sends the self-bound deletion signal only for an active standard room', () => {
    authenticate();
    setState('setup.sessionStarted', true);
    const refreshStandardRoomIdentity = vi.fn(async () => {});
    const deleteStandardRoomIdentity = vi.fn();
    setPeer({
      refreshStandardRoomIdentity,
      deleteStandardRoomIdentity,
    } as unknown as PeerInstance);
    initAccountRoomIdentity();
    deleteStandardRoomIdentity.mockClear();

    bus.emit('account:deleted');

    expect(deleteStandardRoomIdentity).toHaveBeenCalledOnce();

    deleteStandardRoomIdentity.mockClear();
    bus.emit('account:deletion-pending');

    expect(deleteStandardRoomIdentity).toHaveBeenCalledOnce();
  });

  it('asks the server even after another tab became anonymous so tombstoned cookies can revoke', async () => {
    applyAccountSession({
      configured: true,
      authenticated: false,
      account: null,
      statsScope: null,
    });
    const input = { roomCode: '123456', peerId: 'guest-a', role: 'guest' as const };
    const deletion = {
      accountAssertion: null,
      deletionAssertion: 'deleted-session-proof',
    };
    vi.spyOn(accountApi, 'getStandardRoomIdentityAssertions').mockResolvedValue(deletion);

    await expect(requestStandardRoomAccountAssertion(input)).resolves.toEqual(deletion);
  });

  it('keeps the Stage-1 flags-off path anonymous without calling an unavailable auth route', async () => {
    applyAccountSession({
      configured: false,
      authenticated: false,
      account: null,
      statsScope: null,
    });
    const request = vi.spyOn(accountApi, 'getStandardRoomIdentityAssertions');

    await expect(
      requestStandardRoomAccountAssertion({
        roomCode: '123456',
        peerId: 'guest-a',
        role: 'guest',
      }),
    ).resolves.toEqual({ accountAssertion: null, deletionAssertion: null });
    expect(request).not.toHaveBeenCalled();
  });
});
