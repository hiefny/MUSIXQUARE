import { describe, expect, it } from 'vitest';

import {
  createStandardRoomAccountAssertion,
  createStandardRoomAccountDeletionAssertion,
  deriveStandardRoomAccountSubject,
  deriveStandardRoomMemberId,
  verifyStandardRoomAccountAssertion,
  verifyStandardRoomAccountDeletionAssertion,
} from '../../../cloudflare/standard-room-account-assertion.js';

const assertionSecret = 'standard-room-assertion-secret-at-least-32-bytes';
const accountId = 'acct_0123456789abcdefghijkl';

describe('standard-room account assertions', () => {
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
});
