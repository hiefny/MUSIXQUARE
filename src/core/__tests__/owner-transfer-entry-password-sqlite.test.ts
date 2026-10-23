import { describe, expect, it } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.ts';
import {
  issueClaim,
  postTransfer,
  ROOM_CODE,
  transferFixture,
  type TransferFixture,
  useSagaClock,
} from './helpers/owner-transfer-saga-fixture.ts';
import { nodeSqlite } from './helpers/worker-test-bindings.ts';

/**
 * The owner-transfer link and the room's entry password, end to end: the
 * real App facade, the PRO front door and room Durable Object, and node:sqlite
 * D1 (helpers/owner-transfer-saga-fixture.ts). The fixture's old owner
 * activated the room with the PIN 12345678.
 *
 * Owner decision 2026-10-23 (docs/design/pro-transfer-password-reset-2026-10-23.md)
 * changes the cases named "today".
 */

useSagaClock();
const run = nodeSqlite === null ? it.skip : it;

/** The public bootstrap through the App facade, as an optional-v1 App reads it. */
async function bootstrap(test: TransferFixture) {
  const response = await appWorker.fetch(
    new Request(`https://musixquare.com/api/pro-room/v1/rooms/${ROOM_CODE}/bootstrap`, {
      headers: { Origin: 'https://musixquare.com', 'X-MXQR-Pro-Entry-Policy': 'optional-v1' },
    }),
    test.appEnv as never,
  );
  await test.settle();
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe('owner-transfer link and the room entry password', () => {
  run(
    "today: the link needs a new PIN, refuses the old owner's PIN and protects the room",
    async () => {
      const test = await transferFixture();
      expect(await bootstrap(test)).toEqual({
        roomCode: ROOM_CODE,
        status: 'pin_required',
        passwordRequired: true,
      });
      const claim = await issueClaim(test);

      const withoutPin = await postTransfer(test, claim, { newPin: null, entryPolicy: true });
      expect(withoutPin.status).toBe(400);
      await expect(withoutPin.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
      expect(test.saga()).toBeUndefined();

      const reused = await postTransfer(test, claim, { newPin: '12345678', entryPolicy: true });
      expect(reused.status).toBe(409);
      await expect(reused.json()).resolves.toEqual({ error: 'OWNER_TRANSFER_PIN_REUSE' });
      expect(test.saga()).toBe('intent');
      expect(await test.canonical()).toMatchObject({
        status: 'active',
        owner: 'old',
        reconciliation: null,
      });

      const transferred = await postTransfer(test, claim, {
        newPin: '24681357',
        entryPolicy: true,
      });
      expect(transferred.status).toBe(200);
      const body = (await transferred.json()) as { snapshot: Record<string, any> };
      expect(body.snapshot.viewer).toMatchObject({ role: 'owner' });
      expect(body.snapshot).not.toHaveProperty('passwordRequired');
      expect(test.saga()).toBe('complete');
      expect(await test.canonical()).toMatchObject({ status: 'active', owner: 'target' });
      expect(await bootstrap(test)).toEqual({
        roomCode: ROOM_CODE,
        status: 'pin_required',
        passwordRequired: true,
      });
    },
  );
});
