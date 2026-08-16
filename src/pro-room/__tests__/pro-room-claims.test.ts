import { describe, expect, it } from 'vitest';

import {
  createProRoomOwnerTransferCommitProof,
  inspectProRoomOwnerTransferClaim,
  issueProRoomActivationClaim,
  issueProRoomOwnerRecoveryClaim,
  issueProRoomOwnerTransferClaim,
  issueProRoomOwnerTransferRevocationReceipt,
  verifyProRoomActivationClaim,
  verifyProRoomOwnerRecoveryClaim,
  verifyProRoomOwnerTransferCommitProof,
  verifyProRoomOwnerTransferRevocationReceipt,
} from '../../../cloudflare/pro-room-claims.ts';

const NOW_MS = 1_700_000_000_000;
const EXPIRES_AT_MS = NOW_MS + 60_000;
const SECRET = 'characterization-secret'.padEnd(48, 's');
const ROOM_CODE = '000000';
const TARGET_ACCOUNT_ID = 'acct_0123456789abcdefghijkl';

const EXPECTED_ACTIVATION_TOKEN =
  'v1.eyJ2IjoxLCJwdXJwb3NlIjoicHJvLXJvb20tYWN0aXZhdGlvbiIsInJvb21Db2RlIjoiMDAwMDAwIiwiaWF0IjoxNzAwMDAwMDAwMDAwLCJleHAiOjE3MDAwMDAwNjAwMDAsIm5vbmNlIjoiYWN0aXZhdGlvbi1ub25jZS0wMDAxIiwiZ2VuZXJhdGlvbiI6Nywicm9vbUdlbmVyYXRpb24iOjMsInRhcmdldEFjY291bnRJZCI6ImFjY3RfMDEyMzQ1Njc4OWFiY2RlZmdoaWprbCJ9.ZnmvNDmrZ5UzhFrsrWltz8asFi37qnNtfdmsfwMS9cc';
const EXPECTED_RECOVERY_TOKEN =
  'v1.eyJ2IjoxLCJwdXJwb3NlIjoicHJvLXJvb20tb3duZXItcmVjb3ZlcnkiLCJyb29tQ29kZSI6IjAwMDAwMCIsImlhdCI6MTcwMDAwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMDYwMDAwLCJub25jZSI6InJlY292ZXJ5LW5vbmNlLTAwMDAxIiwib3duZXJBdXRob3JpdHlFcG9jaCI6OSwicm9vbUdlbmVyYXRpb24iOjN9.NtfHDkJ5mfeCXAoZlHe137z-ZIayWn_AGT6ja9coBzk';
const EXPECTED_TRANSFER_TOKEN =
  'v1.eyJ2IjoxLCJwdXJwb3NlIjoicHJvLXJvb20tb3duZXItdHJhbnNmZXIiLCJyb29tQ29kZSI6IjAwMDAwMCIsInJvb21HZW5lcmF0aW9uIjozLCJ0YXJnZXRBY2NvdW50SWQiOiJhY2N0XzAxMjM0NTY3ODlhYmNkZWZnaGlqa2wiLCJjbGFpbUdlbmVyYXRpb24iOjQsIm93bmVyQXV0aG9yaXR5RXBvY2giOjksImlhdCI6MTcwMDAwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMDYwMDAwLCJub25jZSI6InRyYW5zZmVyLW5vbmNlLTAwMDAxIn0.YEbNSqIl_vLZmbkg5Qlvtdz6Ia6yJTLsEkfhWBbwKEY';
const EXPECTED_TRANSFER_COMMIT_PROOF =
  'v1.eyJ2IjoxLCJwdXJwb3NlIjoicHJvLXJvb20tb3duZXItdHJhbnNmZXItY29tbWl0Iiwicm9vbUNvZGUiOiIwMDAwMDAiLCJyb29tR2VuZXJhdGlvbiI6MywidHJhbnNmZXJJZCI6InRyYW5zZmVyXzAxMjM0NTY3ODlhYmNkZWZBQkNERUYiLCJyZXF1ZXN0SWQiOiJyZXF1ZXN0LWlkLTAwMDAwMSIsInRhcmdldEFjY291bnRJZCI6ImFjY3RfMDEyMzQ1Njc4OWFiY2RlZmdoaWprbCIsIm93bmVyQXV0aG9yaXR5RXBvY2giOjksInByZXBhcmVkQXRNcyI6MTcwMDAwMDAwMDAwMH0.XRij_PN-4v9jqPZ5eV2xUk6g9R7Y9jWuI5fPlkI8dWE';
const EXPECTED_REVOCATION_TOKEN =
  'v1.eyJwdXJwb3NlIjoicHJvLXJvb20tb3duZXItdHJhbnNmZXItcmV2b2NhdGlvbiIsInJvb21Db2RlIjoiMDAwMDAwIiwicm9vbUdlbmVyYXRpb24iOjMsInRyYW5zZmVySWQiOiJ0cmFuc2Zlcl8wMTIzNDU2Nzg5YWJjZGVmQUJDREVGIiwidGFyZ2V0QWNjb3VudElkIjoiYWNjdF8wMTIzNDU2Nzg5YWJjZGVmZ2hpamtsIiwicmVxdWVzdElkIjoicmVxdWVzdC1pZC0wMDAwMDEiLCJyZXZva2VkQXRNcyI6MTcwMDAwMDAwMDAwMCwiZXhwaXJlc0F0TXMiOjE3MDAwMDAwNjAwMDB9.L8ecExIG9NqyKSTLcwfxoQqxHL3A0SMqTFTRKBpmYDQ';

describe('PRO room claim wire contract', () => {
  it('keeps activation token bytes and schema stable', async () => {
    const token = await issueProRoomActivationClaim(ROOM_CODE, SECRET, {
      nowMs: NOW_MS,
      expiresAtMs: EXPIRES_AT_MS,
      generation: 7,
      roomGeneration: 3,
      targetAccountId: TARGET_ACCOUNT_ID,
      nonce: 'activation-nonce-0001',
    });

    expect(token).toBe(EXPECTED_ACTIVATION_TOKEN);
    await expect(verifyProRoomActivationClaim(token, ROOM_CODE, SECRET, NOW_MS)).resolves.toEqual({
      v: 1,
      purpose: 'pro-room-activation',
      roomCode: ROOM_CODE,
      iat: NOW_MS,
      exp: EXPIRES_AT_MS,
      nonce: 'activation-nonce-0001',
      generation: 7,
      roomGeneration: 3,
      targetAccountId: TARGET_ACCOUNT_ID,
    });
  });

  it('retains the legacy generation default and fails closed for wrong-room, expired, or forged activation claims', async () => {
    const legacy = await issueProRoomActivationClaim(ROOM_CODE, SECRET, {
      nowMs: NOW_MS,
      expiresAtMs: EXPIRES_AT_MS,
      nonce: 'legacy-activation-0001',
    });

    await expect(
      verifyProRoomActivationClaim(legacy, ROOM_CODE, SECRET, NOW_MS),
    ).resolves.toMatchObject({ roomGeneration: 0 });
    await expect(
      verifyProRoomActivationClaim(legacy, '000001', SECRET, NOW_MS),
    ).resolves.toBeNull();
    await expect(
      verifyProRoomActivationClaim(legacy, ROOM_CODE, SECRET, EXPIRES_AT_MS),
    ).resolves.toBeNull();
    await expect(
      verifyProRoomActivationClaim(`${legacy.slice(0, -1)}x`, ROOM_CODE, SECRET, NOW_MS),
    ).resolves.toBeNull();
  });

  it('keeps recovery bytes stable and binds the durable owner authority epoch', async () => {
    const token = await issueProRoomOwnerRecoveryClaim(ROOM_CODE, SECRET, {
      nowMs: NOW_MS,
      expiresAtMs: EXPIRES_AT_MS,
      roomGeneration: 3,
      ownerAuthorityEpoch: 9,
      nonce: 'recovery-nonce-00001',
    });

    expect(token).toBe(EXPECTED_RECOVERY_TOKEN);
    await expect(
      verifyProRoomOwnerRecoveryClaim(token, ROOM_CODE, SECRET, NOW_MS),
    ).resolves.toEqual({
      v: 1,
      purpose: 'pro-room-owner-recovery',
      roomCode: ROOM_CODE,
      iat: NOW_MS,
      exp: EXPIRES_AT_MS,
      nonce: 'recovery-nonce-00001',
      ownerAuthorityEpoch: 9,
      roomGeneration: 3,
    });
    await expect(
      verifyProRoomOwnerRecoveryClaim(token, '000001', SECRET, NOW_MS),
    ).resolves.toBeNull();
    await expect(
      verifyProRoomOwnerRecoveryClaim(token, ROOM_CODE, SECRET, EXPIRES_AT_MS),
    ).resolves.toBeNull();
    await expect(
      issueProRoomOwnerRecoveryClaim(ROOM_CODE, SECRET, {
        ownerAuthorityEpoch: -1,
        nonce: 'recovery-nonce-00002',
      }),
    ).rejects.toThrow('Invalid owner authority epoch');
  });

  it('keeps transfer bytes stable while reporting an otherwise valid expired claim', async () => {
    const token = await issueProRoomOwnerTransferClaim(ROOM_CODE, SECRET, {
      nowMs: NOW_MS,
      expiresAtMs: EXPIRES_AT_MS,
      roomGeneration: 3,
      targetAccountId: TARGET_ACCOUNT_ID,
      claimGeneration: 4,
      ownerAuthorityEpoch: 9,
      nonce: 'transfer-nonce-00001',
    });

    expect(token).toBe(EXPECTED_TRANSFER_TOKEN);
    await expect(
      inspectProRoomOwnerTransferClaim(token, ROOM_CODE, SECRET, NOW_MS),
    ).resolves.toEqual({
      claim: {
        v: 1,
        purpose: 'pro-room-owner-transfer',
        roomCode: ROOM_CODE,
        roomGeneration: 3,
        targetAccountId: TARGET_ACCOUNT_ID,
        claimGeneration: 4,
        ownerAuthorityEpoch: 9,
        iat: NOW_MS,
        exp: EXPIRES_AT_MS,
        nonce: 'transfer-nonce-00001',
      },
      expired: false,
    });
    await expect(
      inspectProRoomOwnerTransferClaim(token, ROOM_CODE, SECRET, EXPIRES_AT_MS),
    ).resolves.toMatchObject({ expired: true });
    await expect(
      inspectProRoomOwnerTransferClaim(token, '000001', SECRET, NOW_MS),
    ).resolves.toEqual({ error: 'OWNER_TRANSFER_CLAIM_INVALID' });
  });

  it('keeps owner-transfer commit proof bytes stable across rolling Worker versions', async () => {
    const room = {
      roomCode: ROOM_CODE,
      roomGeneration: 3,
    };
    const pending = {
      transferId: 'transfer_0123456789abcdefABCDEF',
      requestId: 'request-id-000001',
      targetAccountId: TARGET_ACCOUNT_ID,
      ownerAuthorityEpoch: 9,
      preparedAtMs: NOW_MS,
    };
    const token = await createProRoomOwnerTransferCommitProof(room, pending, SECRET);

    expect(token).toBe(EXPECTED_TRANSFER_COMMIT_PROOF);
    await expect(verifyProRoomOwnerTransferCommitProof(token, room, pending, SECRET)).resolves.toBe(
      true,
    );

    const tamperedToken = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    await expect(
      verifyProRoomOwnerTransferCommitProof(tamperedToken, room, pending, SECRET),
    ).resolves.toBe(false);
    await expect(
      verifyProRoomOwnerTransferCommitProof(
        token,
        { ...room, roomGeneration: room.roomGeneration + 1 },
        pending,
        SECRET,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyProRoomOwnerTransferCommitProof(
        token,
        room,
        pending,
        'different-characterization-secret'.padEnd(48, 'x'),
      ),
    ).resolves.toBe(false);
    await expect(verifyProRoomOwnerTransferCommitProof(null, room, pending, SECRET)).resolves.toBe(
      false,
    );
  });

  it('issues and verifies the exact revocation receipt contract across the App and PRO workers', async () => {
    const identity = {
      roomCode: ROOM_CODE,
      roomGeneration: 3,
      transferId: 'transfer_0123456789abcdefABCDEF',
      targetAccountId: TARGET_ACCOUNT_ID,
      requestId: 'request-id-000001',
    };
    const token = await issueProRoomOwnerTransferRevocationReceipt(identity, SECRET, {
      revokedAtMs: NOW_MS,
      expiresAtMs: EXPIRES_AT_MS,
    });

    expect(token).toBe(EXPECTED_REVOCATION_TOKEN);
    await expect(
      verifyProRoomOwnerTransferRevocationReceipt(token, identity, SECRET, NOW_MS),
    ).resolves.toEqual({
      purpose: 'pro-room-owner-transfer-revocation',
      ...identity,
      revokedAtMs: NOW_MS,
      expiresAtMs: EXPIRES_AT_MS,
    });
    await expect(
      verifyProRoomOwnerTransferRevocationReceipt(
        token,
        { ...identity, roomGeneration: 4 },
        SECRET,
        NOW_MS,
      ),
    ).resolves.toBeNull();
    await expect(
      verifyProRoomOwnerTransferRevocationReceipt(token, identity, SECRET, EXPIRES_AT_MS),
    ).resolves.toBeNull();
  });
});
