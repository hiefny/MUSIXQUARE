import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
  createAccountAssertion,
  verifyAccountAssertion,
} from '../../../cloudflare/account-assertion.js';

const secret = '0123456789abcdef0123456789abcdef';

describe('account room assertions', () => {
  it('round-trips only a bounded room-scoped account identity', async () => {
    const issuedAt = 1_784_524_800;
    const token = await createAccountAssertion(
      {
        accountId: 'acct_0123456789abcdefghijkl',
        nickname: ' 민수 ',
        roomCode: '000001',
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
      },
      secret,
      issuedAt,
    );

    await expect(
      verifyAccountAssertion(token, secret, {
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
        roomCode: '000001',
        nowSeconds: issuedAt,
      }),
    ).resolves.toMatchObject({
      accountId: 'acct_0123456789abcdefghijkl',
      nickname: '민수',
      roomCode: '000001',
    });
  });

  it('rejects another room, a modified signature, and an expired assertion', async () => {
    const issuedAt = 1_784_524_800;
    const token = await createAccountAssertion(
      {
        accountId: 'acct_0123456789abcdefghijkl',
        nickname: 'Minsu',
        roomCode: '000001',
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
      },
      secret,
      issuedAt,
    );
    expect(token).toBeTruthy();

    await expect(
      verifyAccountAssertion(token, secret, {
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
        roomCode: '000002',
      }),
    ).resolves.toBeNull();
    await expect(
      verifyAccountAssertion(`${token!.slice(0, -1)}x`, secret, {
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
        roomCode: '000001',
      }),
    ).resolves.toBeNull();
    await expect(
      verifyAccountAssertion(token, secret, {
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
        roomCode: '000001',
        nowSeconds: issuedAt + 61,
      }),
    ).resolves.toBeNull();
  });

  it('does not mint assertions for malformed identities or weak secrets', async () => {
    await expect(
      createAccountAssertion(
        {
          accountId: 'google-email@example.com',
          nickname: 'Peer',
          roomCode: '000001',
          audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
        },
        secret,
      ),
    ).resolves.toBeNull();
    await expect(
      createAccountAssertion(
        {
          accountId: 'acct_0123456789abcdefghijkl',
          nickname: 'Peer',
          roomCode: '000001',
          audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
        },
        'short',
      ),
    ).resolves.toBeNull();
  });
});
