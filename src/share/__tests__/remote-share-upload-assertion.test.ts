import { describe, expect, it, vi } from 'vitest';
import {
  REMOTE_SHARE_UPLOAD_ASSERTION_AUDIENCE,
  REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING_PREFIX,
  REMOTE_SHARE_UPLOAD_ASSERTION_SCOPE,
  REMOTE_SHARE_UPLOAD_ASSERTION_TTL_SECONDS,
  createRemoteShareUploadAssertion,
  parseRemoteShareUploadAssertionKeyring,
  verifyRemoteShareUploadAssertion,
} from '../../../cloudflare/remote-share-upload-assertion.ts';

const SECRET = 'remote-share-upload-assertion-secret-for-tests';
const NEXT_SECRET = 'next-remote-share-upload-assertion-secret-for-tests';
const NOW_SECONDS = 1_800_000_000;
const GOLDEN_JTI = '30000000-0000-4000-8000-000000000003';
const GOLDEN_ASSERTION =
  'eyJ2IjoxLCJhdWQiOiJtdXNpeHF1YXJlLXJlbW90ZS1zaGFyZS11cGxvYWQiLCJzY29wZSI6InJlbW90ZS1zaGFyZS51cGxvYWQiLCJyb2xlIjoiaG9zdCIsInJvb21JZCI6IjEyMzQ1NiIsImhvc3RQZWVySWQiOiJob3N0X3BlZXJfMSIsInNlc3Npb25JZCI6NywicXVldWVJdGVtSWQiOiIxMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJzaXplIjoyMCwiYWN0b3JJZCI6InJzYV9BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIiwicmVxdWVzdElkIjoicnMzX0JCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkIiLCJib2R5U2hhMjU2IjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsImp0aSI6IjMwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMyIsImlhdCI6MTgwMDAwMDAwMCwiZXhwIjoxODAwMDAwMDYwfQ.HUNg8c7aXfJmPWdEVVwwyls_B3zjHZfMdm-E7UshXAE';
const INPUT = {
  roomId: '123456',
  hostPeerId: 'host_peer_1',
  sessionId: 7,
  queueItemId: '10000000-0000-4000-8000-000000000001',
  size: 20,
  actorId: `rsa_${'A'.repeat(43)}`,
  requestId: `rs3_${'B'.repeat(43)}`,
  bodySha256: 'A'.repeat(43),
};

function decodePayload(assertion: string): Record<string, unknown> {
  const payloadPart = assertion.split('.')[0];
  const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(
    atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')),
    (character) => character.charCodeAt(0),
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

function keyring(
  current: { kid: string; secret: string },
  previous?: { kid: string; secret: string },
): string {
  return `${REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING_PREFIX}${JSON.stringify({
    v: 1,
    current,
    ...(previous ? { previous } : {}),
  })}`;
}

describe('remote share upload assertion', () => {
  it('matches the frozen payload-order and HMAC byte vector', async () => {
    const randomUuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue(GOLDEN_JTI);
    try {
      await expect(createRemoteShareUploadAssertion(INPUT, SECRET, NOW_SECONDS)).resolves.toEqual({
        assertion: GOLDEN_ASSERTION,
        expiresAt: NOW_SECONDS + REMOTE_SHARE_UPLOAD_ASSERTION_TTL_SECONDS,
      });
    } finally {
      randomUuid.mockRestore();
    }
  });

  it('issues a host-only, short-lived assertion and verifies every bound field', async () => {
    const issued = await createRemoteShareUploadAssertion(INPUT, SECRET, NOW_SECONDS);

    expect(issued).not.toBeNull();
    expect(issued!.expiresAt).toBe(NOW_SECONDS + REMOTE_SHARE_UPLOAD_ASSERTION_TTL_SECONDS);
    expect(decodePayload(issued!.assertion)).toMatchObject({
      v: 1,
      aud: REMOTE_SHARE_UPLOAD_ASSERTION_AUDIENCE,
      scope: REMOTE_SHARE_UPLOAD_ASSERTION_SCOPE,
      role: 'host',
      ...INPUT,
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + REMOTE_SHARE_UPLOAD_ASSERTION_TTL_SECONDS,
    });
    await expect(
      verifyRemoteShareUploadAssertion(issued!.assertion, SECRET, {
        ...INPUT,
        nowSeconds: NOW_SECONDS,
      }),
    ).resolves.toMatchObject({
      ...INPUT,
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + REMOTE_SHARE_UPLOAD_ASSERTION_TTL_SECONDS,
    });
  });

  it.each([
    ['roomId', '654321'],
    ['sessionId', 8],
    ['queueItemId', '20000000-0000-4000-8000-000000000002'],
    ['size', 21],
    ['actorId', `rsa_${'D'.repeat(43)}`],
    ['requestId', `rs3_${'E'.repeat(43)}`],
    ['bodySha256', 'E'.repeat(43)],
  ] as const)('rejects a mismatched %s without expanding authority', async (field, value) => {
    const issued = await createRemoteShareUploadAssertion(INPUT, SECRET, NOW_SECONDS);

    await expect(
      verifyRemoteShareUploadAssertion(issued!.assertion, SECRET, {
        ...INPUT,
        [field]: value,
        nowSeconds: NOW_SECONDS,
      }),
    ).resolves.toBeNull();
  });

  it('rejects tampering, the wrong secret, expiry, and excessive future issuance', async () => {
    const issued = await createRemoteShareUploadAssertion(INPUT, SECRET, NOW_SECONDS);
    const tampered = `${issued!.assertion.slice(0, -1)}${issued!.assertion.endsWith('A') ? 'B' : 'A'}`;

    await expect(
      verifyRemoteShareUploadAssertion(tampered, SECRET, { nowSeconds: NOW_SECONDS }),
    ).resolves.toBeNull();
    await expect(
      verifyRemoteShareUploadAssertion(issued!.assertion, `${SECRET}-wrong`, {
        nowSeconds: NOW_SECONDS,
      }),
    ).resolves.toBeNull();
    await expect(
      verifyRemoteShareUploadAssertion(issued!.assertion, SECRET, {
        nowSeconds: NOW_SECONDS + REMOTE_SHARE_UPLOAD_ASSERTION_TTL_SECONDS,
      }),
    ).resolves.toBeNull();
    await expect(
      verifyRemoteShareUploadAssertion(issued!.assertion, SECRET, {
        nowSeconds: NOW_SECONDS - 31,
      }),
    ).resolves.toBeNull();
  });

  it('rejects invalid inputs and weak secrets without issuing authority', async () => {
    await expect(
      createRemoteShareUploadAssertion({ ...INPUT, roomId: '012345' }, SECRET, NOW_SECONDS),
    ).resolves.toBeNull();
    await expect(
      createRemoteShareUploadAssertion(
        { ...INPUT, requestId: `rs_${'B'.repeat(43)}` },
        SECRET,
        NOW_SECONDS,
      ),
    ).resolves.toBeNull();
    await expect(createRemoteShareUploadAssertion(INPUT, 'weak', NOW_SECONDS)).resolves.toBeNull();
  });

  it('keeps a plain shared secret fully compatible with the original unkeyed assertion', async () => {
    expect(parseRemoteShareUploadAssertionKeyring(SECRET)).toEqual({
      current: { kid: null, secret: SECRET },
      previous: null,
    });
    const issued = await createRemoteShareUploadAssertion(INPUT, SECRET, NOW_SECONDS);

    expect(decodePayload(issued!.assertion)).not.toHaveProperty('kid');
    await expect(
      verifyRemoteShareUploadAssertion(issued!.assertion, SECRET, { nowSeconds: NOW_SECONDS }),
    ).resolves.not.toBeNull();
  });

  it('selects current and previous verification slots by signed kid during staged rotation', async () => {
    const oldOnly = keyring({ kid: '2026-08-old', secret: SECRET });
    const rotating = keyring(
      { kid: '2026-09-current', secret: NEXT_SECRET },
      { kid: '2026-08-old', secret: SECRET },
    );
    const currentOnly = keyring({ kid: '2026-09-current', secret: NEXT_SECRET });
    const oldIssued = await createRemoteShareUploadAssertion(INPUT, oldOnly, NOW_SECONDS);
    const currentIssued = await createRemoteShareUploadAssertion(INPUT, rotating, NOW_SECONDS);

    expect(decodePayload(oldIssued!.assertion)).toMatchObject({ kid: '2026-08-old' });
    expect(decodePayload(currentIssued!.assertion)).toMatchObject({ kid: '2026-09-current' });
    await expect(
      verifyRemoteShareUploadAssertion(oldIssued!.assertion, rotating, {
        nowSeconds: NOW_SECONDS,
      }),
    ).resolves.toMatchObject({ kid: '2026-08-old' });
    await expect(
      verifyRemoteShareUploadAssertion(currentIssued!.assertion, rotating, {
        nowSeconds: NOW_SECONDS,
      }),
    ).resolves.toMatchObject({ kid: '2026-09-current' });
    await expect(
      verifyRemoteShareUploadAssertion(oldIssued!.assertion, currentOnly, {
        nowSeconds: NOW_SECONDS,
      }),
    ).resolves.toBeNull();
  });

  it('accepts an in-flight unkeyed assertion through the previous slot, then retires it', async () => {
    const legacyIssued = await createRemoteShareUploadAssertion(INPUT, SECRET, NOW_SECONDS);
    const rotating = keyring(
      { kid: '2026-09-current', secret: NEXT_SECRET },
      { kid: '2026-08-old', secret: SECRET },
    );
    const currentOnly = keyring({ kid: '2026-09-current', secret: NEXT_SECRET });

    await expect(
      verifyRemoteShareUploadAssertion(legacyIssued!.assertion, rotating, {
        nowSeconds: NOW_SECONDS,
      }),
    ).resolves.not.toBeNull();
    await expect(
      verifyRemoteShareUploadAssertion(legacyIssued!.assertion, currentOnly, {
        nowSeconds: NOW_SECONDS,
      }),
    ).resolves.toBeNull();
  });

  it('rejects malformed, ambiguous, and weak keyring configuration', async () => {
    const malformed = `${REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING_PREFIX}{`;
    const duplicateKid = keyring(
      { kid: 'same-kid', secret: NEXT_SECRET },
      { kid: 'same-kid', secret: SECRET },
    );
    const duplicateSecret = keyring(
      { kid: 'current', secret: SECRET },
      { kid: 'previous', secret: SECRET },
    );
    const weakCurrent = keyring({ kid: 'current', secret: 'weak' });

    expect(parseRemoteShareUploadAssertionKeyring(malformed)).toBeNull();
    expect(parseRemoteShareUploadAssertionKeyring(duplicateKid)).toBeNull();
    expect(parseRemoteShareUploadAssertionKeyring(duplicateSecret)).toBeNull();
    expect(parseRemoteShareUploadAssertionKeyring(weakCurrent)).toBeNull();
    await expect(
      createRemoteShareUploadAssertion(INPUT, malformed, NOW_SECONDS),
    ).resolves.toBeNull();
  });
});
