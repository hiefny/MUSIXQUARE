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
 * protected the room with the PIN 12345678.
 *
 * Owner decision 2026-10-23 (docs/design/phase2-navigation-ui-shells-2026-10-23.md, "PRO 소유권 이전 시 입장 암호 끄기"):
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

interface RoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/**
 * Records every request the App Worker sends to the room objects and the PRO
 * front door, keeping the fixture's real objects behind them.
 */
function recordRoomCalls(test: TransferFixture) {
  const internal: Request[] = [];
  const front: Request[] = [];
  const rooms = test.appEnv.PRO_ROOM_ADMIN_ROOMS as RoomNamespace;
  test.appEnv.PRO_ROOM_ADMIN_ROOMS = {
    idFromName: (name: string) => rooms.idFromName(name),
    get: (id: unknown) => {
      const room = rooms.get(id);
      return {
        fetch: (request: Request) => {
          internal.push(request.clone());
          return room.fetch(request);
        },
      };
    },
  } satisfies RoomNamespace;
  const proRoom = test.appEnv.PRO_ROOM_PUBLIC_API as { fetch(request: Request): Promise<Response> };
  test.appEnv.PRO_ROOM_PUBLIC_API = {
    fetch: (request: Request) => {
      front.push(request.clone());
      return proRoom.fetch(request);
    },
  };
  return {
    commits: () =>
      internal.filter(
        (request) => new URL(request.url).pathname === '/internal/admin/owner-transfer/commit',
      ),
    transfers: () =>
      front.filter((request) => new URL(request.url).pathname.endsWith('/owner-transfer')),
  };
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
    const calls = recordRoomCalls(test);

    // The App sends the claim, its request id and its opt-in headers only.
    const transferred = await postTransfer(test, claim, { entryPolicy: true });
    expect(transferred.status).toBe(200);
    // Since 2026-10-26 the facade no longer passes the browser's opt-ins to
    // the internal commit; the PRO room no longer reads them.
    expect(calls.commits()).toHaveLength(1);
    for (const commit of calls.commits()) {
      expect(commit.headers.get('X-MXQR-Pro-Entry-Policy')).toBeNull();
      expect(commit.headers.get('X-MXQR-Pro-Playlist-Slots')).toBeNull();
    }
    expect(transferred.headers.getSetCookie().map((cookie) => cookie.split('=')[0])).toEqual([
      `__Secure-mxqr_pro_session_${ROOM_CODE}`,
      `__Secure-mxqr_pro_owner_${ROOM_CODE}`,
    ]);
    const snapshot = await snapshotOf(transferred);
    expect(snapshot.viewer).toMatchObject({ role: 'owner' });
    // The commit's answer is snapshot schemaVersion 2 with the entry policy
    // and playlist summaries, as activation's is, so the settings show the
    // real state. The facade passes it through: the parser keeps every key.
    expect(snapshot.passwordRequired).toBe(false);
    expect(snapshot.playlistSlots).toBeDefined();
    expect(snapshot.schemaVersion).toBe(2);
    expect(parseProRoomSnapshot(snapshot)).toStrictEqual(snapshot);
    expect(test.saga()).toBe('complete');
    expect(await test.canonical()).toMatchObject({ status: 'active', owner: 'target' });
    expect(await bootstrap(test)).toEqual({
      roomCode: ROOM_CODE,
      status: 'open',
      passwordRequired: false,
    });
  });

  run(
    "refuses the PIN that Apps before 9.0.4 sent, even the old owner's, and transfers without it",
    async () => {
      const test = await transferFixture();
      const claim = await issueClaim(test);
      const calls = recordRoomCalls(test);

      // A malformed PIN, and since 2026-10-26 a well-formed one too: the App
      // facade refuses the body before it records an intent or reaches the PRO
      // room (which refuses it as well), so the link still works without the
      // PIN and never reveals whether a PIN is the old owner's.
      for (const newPin of ['1234', '12345678']) {
        const refused = await postTransfer(test, claim, { newPin, entryPolicy: true });
        expect(refused.status).toBe(400);
        await expect(refused.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
      }
      expect(calls.transfers()).toEqual([]);
      expect(test.saga()).toBeUndefined();
      expect(await test.canonical()).toMatchObject({ status: 'active', owner: 'old' });

      const transferred = await postTransfer(test, claim, { entryPolicy: true });
      expect(transferred.status).toBe(200);
      expect((await snapshotOf(transferred)).passwordRequired).toBe(false);
      expect(test.saga()).toBe('complete');
      expect(await bootstrap(test)).toEqual({
        roomCode: ROOM_CODE,
        status: 'open',
        passwordRequired: false,
      });
    },
  );

  run(
    'answers with the entry policy and playlist summaries without the opt-in headers',
    async () => {
      const test = await transferFixture();
      const claim = await issueClaim(test);

      const transferred = await postTransfer(test, claim);
      expect(transferred.status).toBe(200);
      const snapshot = await snapshotOf(transferred);
      expect(snapshot.viewer).toMatchObject({ role: 'owner' });
      // The PRO room no longer reads the opt-in headers.
      expect(snapshot.passwordRequired).toBe(false);
      expect(snapshot.playlistSlots).toBeDefined();
      expect(snapshot.schemaVersion).toBe(2);
      expect(parseProRoomSnapshot(snapshot)).toStrictEqual(snapshot);
      expect(await bootstrap(test)).toMatchObject({ status: 'open', passwordRequired: false });
    },
  );
});
