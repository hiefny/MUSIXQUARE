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
 * Owner decision 2026-10-23 (docs/design/pro-transfer-password-reset-2026-10-23.md):
 * a committed transfer turns the entry password off and the link asks for no
 * PIN. The PRO room changes first; the cases named "today" are the App
 * facade's part, which changes next.
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
  run("ignores the old owner's PIN in the link's body and leaves the room open", async () => {
    const test = await transferFixture();
    expect(await bootstrap(test)).toEqual({
      roomCode: ROOM_CODE,
      status: 'pin_required',
      passwordRequired: true,
    });
    const claim = await issueClaim(test);

    // Today the App facade still requires the PIN field.
    const withoutPin = await postTransfer(test, claim, { newPin: null, entryPolicy: true });
    expect(withoutPin.status).toBe(400);
    await expect(withoutPin.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
    expect(test.saga()).toBeUndefined();

    // An App from before the decision may send the room's current PIN. The
    // PRO room neither refuses it (no previous-owner PIN oracle) nor keeps it.
    const transferred = await postTransfer(test, claim, { newPin: '12345678', entryPolicy: true });
    expect(transferred.status).toBe(200);
    const body = (await transferred.json()) as { snapshot: Record<string, any> };
    expect(body.snapshot.viewer).toMatchObject({ role: 'owner' });
    // Today the App facade calls the commit without the browser's opt-in headers.
    expect(body.snapshot).not.toHaveProperty('passwordRequired');
    expect(test.saga()).toBe('complete');
    expect(await test.canonical()).toMatchObject({ status: 'active', owner: 'target' });
    expect(await bootstrap(test)).toEqual({
      roomCode: ROOM_CODE,
      status: 'open',
      passwordRequired: false,
    });
  });
});
