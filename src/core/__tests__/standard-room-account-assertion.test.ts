import { describe, expect, it } from 'vitest';

import {
  createStandardRoomAccountAssertion,
  createStandardRoomAccountDeletionAssertion,
  deriveStandardRoomAccountSubject,
  deriveStandardRoomMemberId,
  verifyStandardRoomAccountAssertion,
  verifyStandardRoomAccountDeletionAssertion,
} from '../../../cloudflare/standard-room-account-assertion.ts';

const assertionSecret = 'standard-room-assertion-secret-at-least-32-bytes';
const accountId = 'acct_0123456789abcdefghijkl';
const GOLDEN_ATTACH_ASSERTION =
  'eyJ2IjoxLCJhdWQiOiJzdGFuZGFyZC1yb29tIiwicm9vbUNvZGUiOiIxMjM0NTYiLCJhY2NvdW50U3ViamVjdCI6InN1Yl91R1pmOExfa28wbWhwUElyQXNjQjZYIiwibmlja25hbWUiOiJNaW5zdSIsInBlZXJJZCI6Imd1ZXN0LWRldmljZS1hIiwicm9sZSI6Imd1ZXN0IiwiaWF0IjoxNzg0NTI0ODAwLCJleHAiOjE3ODQ1MjQ4NjB9.EVDErgXac263AJdTtSKhZ2rQsIQCjN8BejuDiMTVcnY';
const GOLDEN_DELETE_ASSERTION =
  'eyJ2IjoxLCJhdWQiOiJzdGFuZGFyZC1yb29tLWRlbGV0ZSIsInJvb21Db2RlIjoiMTIzNDU2IiwiYWNjb3VudFN1YmplY3QiOiJzdWJfdUdaZjhMX2tvMG1ocFBJckFzY0I2WCIsInBlZXJJZCI6Imd1ZXN0LWRldmljZS1hIiwicm9sZSI6Imd1ZXN0IiwiaWF0IjoxNzg0NTI0ODAwLCJleHAiOjE3ODQ1MjQ4NjB9.bDkMVD84uFEWB6bYaftItGX11od3VceBW7z76X460to';

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function signRawAssertionPayload(bytes: Uint8Array): Promise<string> {
  const payloadPart = base64Url(bytes);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(assertionSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`standard-room-assertion:v1\u0000${payloadPart}`),
  );
  return `${payloadPart}.${base64Url(new Uint8Array(signature))}`;
}

describe('standard-room account assertions', () => {
  it('matches the frozen attach/deletion byte vectors and generation pseudonyms', async () => {
    const nowSeconds = 1_784_524_800;
    const input = {
      accountId,
      roomCode: '123456',
      peerId: 'guest-device-a',
      role: 'guest' as const,
    };

    await expect(
      createStandardRoomAccountAssertion(
        { ...input, nickname: 'Minsu' },
        assertionSecret,
        nowSeconds,
      ),
    ).resolves.toBe(GOLDEN_ATTACH_ASSERTION);
    await expect(
      createStandardRoomAccountDeletionAssertion(input, assertionSecret, nowSeconds),
    ).resolves.toBe(GOLDEN_DELETE_ASSERTION);
    await expect(
      deriveStandardRoomAccountSubject(accountId, '123456', assertionSecret),
    ).resolves.toBe('sub_uGZf8L_ko0mhpPIrAscB6X');
    await expect(
      deriveStandardRoomMemberId('first-room-secret', 'sub_uGZf8L_ko0mhpPIrAscB6X'),
    ).resolves.toBe('member_y5y-9bVlKopa1O_BwtyO7n');
  });

  it('projects a short-lived room/peer/role-bound pseudonym without the global account ID', async () => {
    const nowSeconds = 1_784_524_800;
    const token = await createStandardRoomAccountAssertion(
      {
        accountId,
        nickname: ' 민수 ',
        roomCode: '123456',
        peerId: 'guest-device-a',
        role: 'guest',
      },
      assertionSecret,
      nowSeconds,
    );

    expect(token).toBeTruthy();
    expect(token).not.toContain(accountId);
    await expect(
      verifyStandardRoomAccountAssertion(token, assertionSecret, {
        roomCode: '123456',
        peerId: 'guest-device-a',
        role: 'guest',
        nowSeconds,
      }),
    ).resolves.toMatchObject({
      roomCode: '123456',
      nickname: '민수',
      peerId: 'guest-device-a',
      role: 'guest',
      accountSubject: expect.stringMatching(/^sub_[A-Za-z0-9_-]{22}$/),
    });
  });

  it('rejects cross-room, cross-device, cross-role, modified, and expired reuse', async () => {
    const nowSeconds = 1_784_524_800;
    const token = await createStandardRoomAccountAssertion(
      {
        accountId,
        nickname: 'Minsu',
        roomCode: '123456',
        peerId: 'guest-device-a',
        role: 'guest',
      },
      assertionSecret,
      nowSeconds,
    );
    expect(token).toBeTruthy();

    for (const binding of [
      { roomCode: '654321', peerId: 'guest-device-a', role: 'guest' as const },
      { roomCode: '123456', peerId: 'guest-device-b', role: 'guest' as const },
      { roomCode: '123456', peerId: 'guest-device-a', role: 'host' as const },
    ]) {
      await expect(
        verifyStandardRoomAccountAssertion(token, assertionSecret, {
          ...binding,
          nowSeconds,
        }),
      ).resolves.toBeNull();
    }
    await expect(
      verifyStandardRoomAccountAssertion(`${token!.slice(0, -1)}x`, assertionSecret, {
        roomCode: '123456',
        peerId: 'guest-device-a',
        role: 'guest',
        nowSeconds,
      }),
    ).resolves.toBeNull();
    await expect(
      verifyStandardRoomAccountAssertion(token, assertionSecret, {
        roomCode: '123456',
        peerId: 'guest-device-a',
        role: 'guest',
        nowSeconds: nowSeconds + 61,
      }),
    ).resolves.toBeNull();
  });

  it('keeps one account subject per room while rotating member IDs with the room secret', async () => {
    const subjectA = await deriveStandardRoomAccountSubject(accountId, '123456', assertionSecret);
    const subjectB = await deriveStandardRoomAccountSubject(accountId, '123456', assertionSecret);
    const otherRoomSubject = await deriveStandardRoomAccountSubject(
      accountId,
      '654321',
      assertionSecret,
    );
    expect(subjectA).toBe(subjectB);
    expect(subjectA).not.toBe(otherRoomSubject);

    const firstGeneration = await deriveStandardRoomMemberId('first-room-secret', subjectA);
    const firstGenerationAgain = await deriveStandardRoomMemberId('first-room-secret', subjectA);
    const reusedCodeGeneration = await deriveStandardRoomMemberId('second-room-secret', subjectA);
    expect(firstGeneration).toBe(firstGenerationAgain);
    expect(firstGeneration).not.toBe(reusedCodeGeneration);
  });

  it('keeps deletion proof on a separate audience that can never attach an account', async () => {
    const nowSeconds = 1_784_524_800;
    const token = await createStandardRoomAccountDeletionAssertion(
      {
        accountId,
        roomCode: '123456',
        peerId: 'guest-device-a',
        role: 'guest',
      },
      assertionSecret,
      nowSeconds,
    );

    expect(token).toBeTruthy();
    await expect(
      verifyStandardRoomAccountDeletionAssertion(token, assertionSecret, {
        roomCode: '123456',
        peerId: 'guest-device-a',
        role: 'guest',
        nowSeconds,
      }),
    ).resolves.toMatchObject({
      roomCode: '123456',
      peerId: 'guest-device-a',
      role: 'guest',
      accountSubject: expect.stringMatching(/^sub_[A-Za-z0-9_-]{22}$/),
    });
    await expect(
      verifyStandardRoomAccountAssertion(token, assertionSecret, {
        roomCode: '123456',
        peerId: 'guest-device-a',
        role: 'guest',
        nowSeconds,
      }),
    ).resolves.toBeNull();
  });

  it('never accepts an attach assertion as a deletion proof', async () => {
    const nowSeconds = 1_784_524_800;
    const token = await createStandardRoomAccountAssertion(
      {
        accountId,
        nickname: 'Minsu',
        roomCode: '123456',
        peerId: 'guest-device-a',
        role: 'guest',
      },
      assertionSecret,
      nowSeconds,
    );

    await expect(
      verifyStandardRoomAccountDeletionAssertion(token, assertionSecret, {
        roomCode: '123456',
        peerId: 'guest-device-a',
        role: 'guest',
        nowSeconds,
      }),
    ).resolves.toBeNull();
  });

  it('rejects a correctly signed assertion whose JSON contains malformed UTF-8', async () => {
    const nowSeconds = 1_784_524_800;
    const accountSubject = await deriveStandardRoomAccountSubject(
      accountId,
      '123456',
      assertionSecret,
    );
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        aud: 'standard-room',
        roomCode: '123456',
        accountSubject,
        nickname: 'XX',
        peerId: 'guest-device-a',
        role: 'guest',
        iat: nowSeconds,
        exp: nowSeconds + 60,
      }),
    );
    const marker = new TextEncoder().encode('"nickname":"XX"');
    const markerIndex = Buffer.from(encoded).indexOf(Buffer.from(marker));
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    encoded[markerIndex + marker.byteLength - 3] = 0xc3;
    encoded[markerIndex + marker.byteLength - 2] = 0x28;
    const token = await signRawAssertionPayload(encoded);

    await expect(
      verifyStandardRoomAccountAssertion(token, assertionSecret, {
        roomCode: '123456',
        peerId: 'guest-device-a',
        role: 'guest',
        nowSeconds,
      }),
    ).resolves.toBeNull();
  });

  it('rejects a correctly signed payload that adds authority outside the exact schema', async () => {
    const nowSeconds = 1_784_524_800;
    const token = await signRawAssertionPayload(
      new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          aud: 'standard-room',
          roomCode: '123456',
          accountSubject: 'sub_uGZf8L_ko0mhpPIrAscB6X',
          nickname: 'Minsu',
          peerId: 'guest-device-a',
          role: 'guest',
          iat: nowSeconds,
          exp: nowSeconds + 60,
          capability: 'admin',
        }),
      ),
    );

    await expect(
      verifyStandardRoomAccountAssertion(token, assertionSecret, { nowSeconds }),
    ).resolves.toBeNull();
  });
});
