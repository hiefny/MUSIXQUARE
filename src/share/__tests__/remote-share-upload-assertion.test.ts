import { describe, expect, it } from 'vitest';
import {
  REMOTE_SHARE_UPLOAD_ASSERTION_AUDIENCE,
  REMOTE_SHARE_UPLOAD_ASSERTION_SCOPE,
  REMOTE_SHARE_UPLOAD_ASSERTION_TTL_SECONDS,
  createRemoteShareUploadAssertion,
  verifyRemoteShareUploadAssertion,
} from '../../../cloudflare/remote-share-upload-assertion.js';

const SECRET = 'remote-share-upload-assertion-secret-for-tests';
const NOW_SECONDS = 1_800_000_000;
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

describe('remote share upload assertion', () => {
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
});
