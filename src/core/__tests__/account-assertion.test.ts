import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
  createAccountAssertion,
  verifyAccountAssertion,
} from '../../../cloudflare/account-assertion.js';

const secret = '0123456789abcdef0123456789abcdef';

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function signRawPayload(bytes: Uint8Array): Promise<string> {
  const payloadPart = base64Url(bytes);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadPart));
  return `${payloadPart}.${base64Url(new Uint8Array(signature))}`;
}

describe('account room assertions', () => {
  it('round-trips only a bounded room-scoped account identity', async () => {
    const issuedAt = 1_784_524_800;
    const token = await createAccountAssertion(
      {
        accountId: 'acct_0123456789abcdefghijkl',
        nickname: ' 민수 ',
        roomCode: '000001',
        roomGeneration: 0,
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
        roomGeneration: 0,
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

  it('binds an assertion to one immutable PRO room generation', async () => {
    const issuedAt = 1_784_524_800;
    const initial = await createAccountAssertion(
      {
        accountId: 'acct_0123456789abcdefghijkl',
        nickname: 'Initial owner',
        roomCode: '000001',
        roomGeneration: 0,
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
      },
      secret,
      issuedAt,
    );
    const replacement = await createAccountAssertion(
      {
        accountId: 'acct_0123456789abcdefghijkl',
        nickname: 'Replacement owner',
        roomCode: '000001',
        roomGeneration: 1,
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
      },
      secret,
      issuedAt,
    );

    const decodePayload = (token: string | null) =>
      JSON.parse(
        Buffer.from(
          String(token).split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/'),
          'base64',
        ).toString('utf8'),
      ) as Record<string, unknown>;
    expect(decodePayload(initial)).toMatchObject({ roomGeneration: 0 });
    expect(decodePayload(replacement)).toMatchObject({ roomGeneration: 1 });

    await expect(
      verifyAccountAssertion(initial, secret, {
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
        roomCode: '000001',
        roomGeneration: 1,
        nowSeconds: issuedAt,
      }),
    ).resolves.toBeNull();
    await expect(
      verifyAccountAssertion(replacement, secret, {
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
        roomCode: '000001',
        roomGeneration: 0,
        nowSeconds: issuedAt,
      }),
    ).resolves.toBeNull();
    await expect(
      verifyAccountAssertion(replacement, secret, {
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
        roomCode: '000001',
        roomGeneration: 1,
        nowSeconds: issuedAt,
      }),
    ).resolves.toMatchObject({
      roomCode: '000001',
      roomGeneration: 1,
      accountId: 'acct_0123456789abcdefghijkl',
    });
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

  it('rejects a correctly signed payload whose JSON contains malformed UTF-8', async () => {
    const nowSeconds = 1_784_524_800;
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        aud: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
        roomCode: '000001',
        roomGeneration: 0,
        accountId: 'acct_0123456789abcdefghijkl',
        nickname: 'XX',
        iat: nowSeconds,
        exp: nowSeconds + 60,
      }),
    );
    const marker = new TextEncoder().encode('"nickname":"XX"');
    const markerIndex = Buffer.from(encoded).indexOf(Buffer.from(marker));
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    encoded[markerIndex + marker.byteLength - 3] = 0xc3;
    encoded[markerIndex + marker.byteLength - 2] = 0x28;
    const token = await signRawPayload(encoded);

    await expect(
      verifyAccountAssertion(token, secret, {
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
        roomCode: '000001',
        roomGeneration: 0,
        nowSeconds,
      }),
    ).resolves.toBeNull();
  });
});
