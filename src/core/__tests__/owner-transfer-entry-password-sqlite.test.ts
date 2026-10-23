import { describe, expect, it } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.ts';
import { parseProRoomSnapshot } from '../../pro-room/snapshot.ts';
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
 * PIN. The new owner can turn a password on later in room settings.
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

async function snapshotOf(response: Response) {
  const body = (await response.json()) as { snapshot: Record<string, any> };
  return body.snapshot;
}

describe('owner-transfer link and the room entry password', () => {
  run('transfers without a PIN and tells the new owner the room is open', async () => {
    const test = await transferFixture();
    expect(await bootstrap(test)).toEqual({
      roomCode: ROOM_CODE,
      status: 'pin_required',
      passwordRequired: true,
    });
    const claim = await issueClaim(test);

    // The App sends the claim, its request id and its opt-in headers only.
    const transferred = await postTransfer(test, claim, { entryPolicy: true });
    expect(transferred.status).toBe(200);
    expect(transferred.headers.getSetCookie().map((cookie) => cookie.split('=')[0])).toEqual([
      `__Secure-mxqr_pro_session_${ROOM_CODE}`,
      `__Secure-mxqr_pro_owner_${ROOM_CODE}`,
    ]);
    const snapshot = await snapshotOf(transferred);
    expect(snapshot.viewer).toMatchObject({ role: 'owner' });
    // The facade passes the opt-ins to the commit, so the answer has the same
    // additive fields as activation's and the settings show the real state.
    expect(snapshot.passwordRequired).toBe(false);
    expect(snapshot.playlistSlots).toBeDefined();
    expect(parseProRoomSnapshot(snapshot)).not.toBeNull();
    expect(test.saga()).toBe('complete');
    expect(await test.canonical()).toMatchObject({ status: 'active', owner: 'target' });
    expect(await bootstrap(test)).toEqual({
      roomCode: ROOM_CODE,
      status: 'open',
      passwordRequired: false,
    });
  });

  run("accepts and ignores the PIN an earlier App sends, even the old owner's", async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);

    // The body grammar of earlier Apps is unchanged: a malformed PIN is refused
    // before any saga row exists.
    const malformed = await postTransfer(test, claim, { newPin: '1234', entryPolicy: true });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
    expect(test.saga()).toBeUndefined();

    // No OWNER_TRANSFER_PIN_REUSE: the link no longer reveals the old owner's PIN.
    const transferred = await postTransfer(test, claim, { newPin: '12345678', entryPolicy: true });
    expect(transferred.status).toBe(200);
    expect((await snapshotOf(transferred)).passwordRequired).toBe(false);
    expect(test.saga()).toBe('complete');
    expect(await bootstrap(test)).toEqual({
      roomCode: ROOM_CODE,
      status: 'open',
      passwordRequired: false,
    });
  });

  run('keeps the exact v1 snapshot for a request without the opt-in headers', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);

    const transferred = await postTransfer(test, claim);
    expect(transferred.status).toBe(200);
    const snapshot = await snapshotOf(transferred);
    expect(snapshot.viewer).toMatchObject({ role: 'owner' });
    expect(snapshot).not.toHaveProperty('passwordRequired');
    expect(snapshot).not.toHaveProperty('playlistSlots');
    expect(await bootstrap(test)).toMatchObject({ status: 'open', passwordRequired: false });
  });
});
