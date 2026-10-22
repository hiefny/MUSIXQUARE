import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
  ACCOUNT_ASSERTION_HEADER,
  createAccountAssertion,
} from '../../../cloudflare/account-assertion.ts';
import { issueProRoomActivationClaim } from '../../../cloudflare/pro-room-claims.ts';
import { SIGNALING_BROADCAST_BODY_KEYS } from '../../pro-room/__tests__/__helpers__/signaling-broadcast-contract.ts';
import { localWorkerdPort } from './helpers/local-workerd-port.ts';

/**
 * C7-0 workerd contract: the PRO room Durable Object's broadcasts against the
 * real signaling Worker (resource RO-07). Local workerd runs the shipped PRO
 * room and signaling bundles with real SQLite Durable Objects, as in
 * pro-room-burst.test.ts. The only addition is a recording wrapper around the
 * PRO room's PRO_SIGNALING_ROOMS binding: it forwards every request unchanged
 * and copies the request body and the signaling answer to a log Worker.
 *
 * This is the evidence a change to the broadcast request builder (plan step
 * C7-3) needs: signaling refuses any extra or missing body key with 400
 * (hasExactKeys), the in-process fakes accept what they are told to, and the
 * live smokes never reach this path. The owner-account-deletion fence that
 * only a newer-epoch presence snapshot reopens is pinned on the signaling side
 * ("durably fences owner-deleted PRO signaling until a newer non-empty
 * authority snapshot" in cloudflare-signaling-worker.test.ts).
 */

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const origin = 'http://localhost:5173';
const roomCode = '000000';
const accountId = 'acct_ContractOwner000000001';
const videoId = 'dQw4w9WgXcQ';
const queueItemId = '11111111-1111-4111-8111-111111111111';
const secret = (purpose: string) => `local-contract-${purpose}-`.padEnd(48, 'x');
const date = (name: string) =>
  readFileSync(new URL(`../../../cloudflare/wrangler.${name}.toml`, import.meta.url), 'utf8').match(
    /compatibility_date = "([^"]+)"/,
  )![1]!;

let proScript: string;
let signalingScript: string;
let runtime: Miniflare | undefined;
const outboundRequests: string[] = [];
const sockets: TestSocket[] = [];

interface TestSocket {
  accept(): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, callback: (event: { data?: unknown }) => void): void;
}
type LocalService = {
  fetch(input: string, init?: RequestInit): Promise<Response & { webSocket?: TestSocket }>;
};
interface Broadcast {
  path: string;
  body: Record<string, any>;
  status: number;
  response: Record<string, unknown>;
}

beforeAll(async () => {
  const [pro, signaling] = await Promise.all([
    build({
      absWorkingDir: repository,
      stdin: {
        resolveDir: repository,
        loader: 'ts',
        // Forward-only recorder: the room's own requests and signaling's own
        // answers, copied to BROADCAST_LOG after each exchange completes.
        contents: `
          import front, { MusixquareProRoom as Room } from './cloudflare/pro-room-worker.ts';
          export { MusixquareServiceControl } from './cloudflare/pro-room-worker.ts';
          function recorded(namespace, log) {
            return {
              idFromName: (name) => namespace.idFromName(name),
              get: (id) => {
                const stub = namespace.get(id);
                return {
                  async fetch(request) {
                    const body = await request.clone().text();
                    const response = await stub.fetch(request);
                    const answer = await response.clone().text();
                    await log.fetch('http://log/append', {
                      method: 'POST',
                      body: JSON.stringify({
                        path: new URL(request.url).pathname,
                        body: JSON.parse(body),
                        status: response.status,
                        response: JSON.parse(answer),
                      }),
                    });
                    return response;
                  },
                };
              },
            };
          }
          export class MusixquareProRoom extends Room {
            constructor(state, env) {
              super(state, {
                ...env,
                PRO_SIGNALING_ROOMS: recorded(env.PRO_SIGNALING_ROOMS, env.BROADCAST_LOG),
              });
            }
          }
          export default front;
        `,
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
    }),
    build({
      absWorkingDir: repository,
      entryPoints: ['cloudflare/signaling-worker.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
    }),
  ]);
  proScript = pro.outputFiles[0]!.text;
  signalingScript = signaling.outputFiles[0]!.text;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close(1000, 'test complete');
  await runtime?.dispose();
  runtime = undefined;
  expect(outboundRequests.splice(0)).toEqual([]);
});

function sqlStatements(source: string): string[] {
  const statements: string[] = [];
  let current = '';
  let trigger = false;
  for (const line of source.split('\n')) {
    const text = line.replace(/--.*$/, '').trim();
    if (!text) continue;
    trigger ||= /^CREATE TRIGGER/i.test(text);
    current += `${text}\n`;
    if (text.endsWith(';') && (!trigger || /^END;$/i.test(text))) {
      statements.push(current);
      current = '';
      trigger = false;
    }
  }
  if (current.trim()) throw new Error('Incomplete fixture migration');
  return statements;
}

async function harness() {
  const blockOutbound = async (request: Request) => {
    outboundRequests.push(request.url);
    return new Response('External network disabled', { status: 502 });
  };
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      port: await localWorkerdPort(),
      log: new Log(LogLevel.NONE),
      workers: [
        {
          name: 'pro',
          modules: true,
          compatibilityDate: date('pro-room'),
          script: proScript,
          bindings: {
            ALLOWED_ORIGINS: origin,
            PRO_ROOM_ACTIVATION_SECRET: secret('activation'),
            PRO_ROOM_PIN_PEPPER: secret('pin'),
            PRO_ROOM_SESSION_SECRET: secret('session'),
            PRO_ROOM_RATE_LIMIT_SECRET: secret('rate'),
            MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: secret('account'),
            PRO_SIGNALING_SECRET: secret('signaling'),
          },
          d1Databases: ['MUSIXQUARE_ADMIN_DB', 'MUSIXQUARE_AUTH_DB'],
          durableObjects: {
            PRO_ROOMS: { className: 'MusixquareProRoom', useSQLite: true },
            MUSIXQUARE_SERVICE_CONTROL: { className: 'MusixquareServiceControl', useSQLite: true },
            PRO_SIGNALING_ROOMS: {
              className: 'MusixquareRoom',
              scriptName: 'signaling',
              useSQLite: true,
            },
          },
          serviceBindings: { BROADCAST_LOG: 'broadcast-log' },
          outboundService: blockOutbound,
        },
        {
          name: 'signaling',
          modules: true,
          compatibilityDate: date('signaling'),
          script: signalingScript,
          bindings: { ALLOWED_ORIGINS: origin, PRO_SIGNALING_SECRET: secret('signaling') },
          durableObjects: {
            MUSIXQUARE_ROOMS: { className: 'MusixquareRoom', useSQLite: true },
            MUSIXQUARE_SERVICE_CONTROL: {
              className: 'MusixquareServiceControl',
              scriptName: 'pro',
              useSQLite: true,
            },
          },
          outboundService: blockOutbound,
        },
        {
          name: 'broadcast-log',
          modules: true,
          compatibilityDate: date('pro-room'),
          outboundService: blockOutbound,
          durableObjects: {
            SIGNALING_ROOMS: {
              className: 'MusixquareRoom',
              scriptName: 'signaling',
              useSQLite: true,
            },
          },
          // The broadcast log, plus /send: deliver a body to the room's
          // signaling object exactly as the PRO room's binding would.
          script: `const entries = [];
          export default { async fetch(request, env) {
            const path = new URL(request.url).pathname;
            if (path === '/append') entries.push(await request.json());
            if (path === '/send') {
              const roomCode = request.headers.get('x-mxqr-pro-room-code');
              const stub = env.SIGNALING_ROOMS.get(
                env.SIGNALING_ROOMS.idFromName(roomCode + ':generation:0'),
              );
              const response = await stub.fetch(
                'https://signaling.internal/internal/realtime/v1/broadcast',
                {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    'x-mxqr-pro-room-code': roomCode,
                    'x-mxqr-pro-room-generation': '0',
                  },
                  body: await request.text(),
                },
              );
              return Response.json({ status: response.status, body: await response.json() });
            }
            return Response.json(entries);
          } };`,
        },
      ],
    }),
  );
  await runtime.ready;
  const db = await runtime.getD1Database('MUSIXQUARE_ADMIN_DB', 'pro');
  const schema = `
    CREATE TABLE mxqr_pro_room_registry (
      room_code TEXT PRIMARY KEY, label TEXT NOT NULL, status TEXT NOT NULL,
      suspension_reason TEXT, activation_state TEXT NOT NULL,
      room_generation INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE mxqr_pro_room_admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, action TEXT NOT NULL,
      result TEXT NOT NULL, room_code TEXT NOT NULL, room_generation INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `;
  const migration = readFileSync(
    new URL('../../../cloudflare/admin-metrics.pro-grants.migration.sql', import.meta.url),
    'utf8',
  );
  for (const sql of sqlStatements(schema + migration)) await db.prepare(sql).run();
  await db
    .prepare(
      `INSERT INTO mxqr_pro_room_registry
       VALUES (?1, 'Contract fixture', 'registered', NULL, 'unactivated', 0, 1, 1)`,
    )
    .bind(roomCode)
    .run();
  await db
    .prepare(
      "INSERT INTO mxqr_pro_grant_audit (actor_id, action, result, created_at) VALUES ('system:entitlement-backfill', 'entitlement.backfill', 'complete', 1)",
    )
    .run();
  const authDb = await runtime.getD1Database('MUSIXQUARE_AUTH_DB', 'pro');
  await authDb
    .prepare('CREATE TABLE mxqr_accounts (account_id TEXT PRIMARY KEY, status TEXT NOT NULL)')
    .run();
  await authDb.prepare('CREATE TABLE mxqr_account_deletions (account_id TEXT PRIMARY KEY)').run();
  await authDb.prepare("INSERT INTO mxqr_accounts VALUES (?1, 'active')").bind(accountId).run();
  const pro = (await runtime.getWorker('pro')) as unknown as LocalService;
  const signaling = (await runtime.getWorker('signaling')) as unknown as LocalService;
  const log = (await runtime.getWorker('broadcast-log')) as unknown as LocalService;

  let cookie = '';
  let viewer: Record<string, string> = {};
  async function request(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = {
      Origin: origin,
      // Isolate each exchange, as pro-room-burst.test.ts does.
      Connection: 'close',
      'cf-connecting-ip': '192.0.2.1',
      'x-mxqr-pro-entry-policy': 'optional-v1',
      ...init.headers,
    };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) {
      headers.cookie = cookie;
      headers['x-mxqr-pro-participant-id'] = viewer.participantId!;
      headers['x-mxqr-pro-presence-incarnation'] = viewer.presenceIncarnationId!;
    }
    const response = await pro.fetch(`https://pro.test/v1/rooms/${roomCode}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json()) as Record<string, any>;
    return { status: response.status, setCookie: response.headers.getSetCookie(), body };
  }

  const assertion = await createAccountAssertion(
    {
      accountId,
      nickname: 'Owner',
      roomCode,
      roomGeneration: 0,
      audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
    },
    secret('account'),
  );
  const activation = await request('/activation', {
    body: {
      claimToken: await issueProRoomActivationClaim(roomCode, secret('activation')),
      ownerName: 'Owner',
    },
    headers: { [ACCOUNT_ASSERTION_HEADER]: assertion! },
  });
  expect(activation.status, JSON.stringify(activation.body)).toBe(200);
  cookie =
    activation.setCookie
      .find((value) => value.startsWith('__Host-mxqr_pro_session_'))
      ?.split(';')[0] ?? '';
  viewer = activation.body.snapshot.viewer;
  const frames: Array<Record<string, any>> = [];

  async function broadcasts(): Promise<Broadcast[]> {
    return (await (await log.fetch('http://log/entries')).json()) as Broadcast[];
  }

  return {
    request,
    frames,
    broadcasts,
    /** Poll the log until `count` broadcasts of `type` were answered. */
    async waitFor(type: string, count = 1): Promise<Broadcast[]> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const entries = await broadcasts();
        if (entries.filter((entry) => entry.body.event?.type === type).length >= count) {
          return entries;
        }
        if (Date.now() > deadline) throw new Error(`broadcast log: ${JSON.stringify(entries)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    /** Open the owner's signaling socket with a fresh ticket. */
    async connect() {
      const ticket = await request('/signaling-tickets', { method: 'POST' });
      expect(ticket.status, JSON.stringify(ticket.body)).toBe(200);
      const response = await signaling.fetch(`https://signal.test/api/pro-rooms/${roomCode}/ws`, {
        headers: {
          Origin: origin,
          Upgrade: 'websocket',
          'cf-connecting-ip': '192.0.2.1',
          'Sec-WebSocket-Protocol': `mxqr.pro-signaling.v1, mxqr.ticket.${ticket.body.ticket}`,
        },
        signal: AbortSignal.timeout(20_000),
      });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      sockets.push(socket);
      const opened = new Promise<void>((resolve) => {
        socket.addEventListener('message', (event) => {
          const frame = JSON.parse(String(event.data)) as Record<string, any>;
          frames.push(frame);
          if (frame.type === 'peer-open') resolve();
        });
      });
      socket.accept();
      await opened;
    },
    /** Send a body straight to the room's signaling object, as the PRO room would. */
    async sendToSignaling(body: unknown) {
      const response = await log.fetch('http://log/send', {
        method: 'POST',
        headers: { 'x-mxqr-pro-room-code': roomCode },
        body: JSON.stringify(body),
      });
      return (await response.json()) as { status: number; body: Record<string, unknown> };
    },
    async selectAndCommit() {
      const current = await request('/snapshot');
      const compact = await request('/snapshot/compact', {
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: {
          baseRevision: current.body.snapshot.revision,
          playlistOrder: [queueItemId],
          upserts: [{ queueItemId, name: 'Contract video', source: { kind: 'youtube', videoId } }],
          currentQueueItemId: null,
          playback: { ...current.body.snapshot.playback, state: 'idle', queueItemId: null },
        },
      });
      expect(compact.status, JSON.stringify(compact.body)).toBe(200);
      return this.select();
    },
    /** Select the playlist's one track and report ready: one PREPARE, then one COMMIT. */
    async select() {
      const after = await request('/snapshot');
      const selected = await request('/playback/commands', {
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: {
          type: 'select',
          baseRevision: after.body.snapshot.playback.revision,
          queueItemId,
          state: 'playing',
          positionSeconds: 0,
        },
      });
      expect(selected.status, JSON.stringify(selected.body)).toBe(202);
      const transition = selected.body.transition;
      const ready = await request(`/playback/transitions/${transition.transitionId}/ready`, {
        body: { basePlaybackRevision: transition.basePlaybackRevision, status: 'ready' },
      });
      expect(ready.status, JSON.stringify(ready.body)).toBe(200);
      expect(ready.body.status).toBe('committed');
      return transition.transitionId as string;
    },
  };
}

describe('PRO room to signaling broadcast contract (real workerd)', () => {
  it('sends every lane with the exact body signaling accepts and fans playback out to the live socket', async () => {
    const test = await harness();
    await test.waitFor('pro-presence-snapshot');
    await test.connect();
    const transitionId = await test.selectAndCommit();
    const current = await test.request('/snapshot');
    const queueMode = await test.request('/queue-mode', {
      method: 'PUT',
      body: {
        coordinatorEpoch: current.body.snapshot.presence.coordinatorEpoch,
        baseRevision: current.body.snapshot.queueModeRevision,
        playlistRevision: current.body.snapshot.playlistRevision,
        repeatMode: 1,
        shuffleEnabled: false,
        shuffleOrder: [],
      },
    });
    expect(queueMode.status, JSON.stringify(queueMode.body)).toBe(200);
    const entries = await test.waitFor('pro-playback-commit');

    const lanes = new Set(entries.map((entry) => entry.body.event.type));
    expect(lanes).toEqual(
      new Set([
        'pro-presence-snapshot',
        'pro-room-invalidated',
        'pro-playback-prepare',
        'pro-playback-commit',
      ]),
    );
    for (const entry of entries) {
      expect(entry.path).toBe('/internal/realtime/v1/broadcast');
      expect(Object.keys(entry.body).sort()).toEqual(SIGNALING_BROADCAST_BODY_KEYS);
      expect(entry.status, JSON.stringify(entry)).toBe(200);
      expect(entry.response).toMatchObject({ broadcast: true });
    }
    for (const type of ['pro-playback-prepare', 'pro-playback-commit']) {
      const entry = entries.find((candidate) => candidate.body.event.type === type)!;
      expect(entry.body.event.transitionId).toBe(transitionId);
      // Playback is accepted only with sent === eligible; the owner socket counts.
      expect(entry.response).toEqual({ broadcast: true, eligible: 1, sent: 1 });
    }
    expect(
      test.frames
        .filter((frame) => frame.type === 'pro-server-event')
        .map((frame) => frame.event.type),
    ).toEqual(expect.arrayContaining(['pro-playback-prepare', 'pro-playback-commit']));
  }, 60_000);

  it('lets only a presence snapshot advance the epoch fence and refuses a changed body key set', async () => {
    const test = await harness();
    const entries = await test.waitFor('pro-presence-snapshot');
    const presence = entries.find((entry) => entry.body.event.type === 'pro-presence-snapshot')!;
    await test.selectAndCommit();
    const prepare = (await test.waitFor('pro-playback-prepare')).find(
      (entry) => entry.body.event.type === 'pro-playback-prepare',
    )!;
    const epoch = prepare.body.coordinatorEpoch as number;
    expect(presence.body.coordinatorEpoch).toBe(epoch);

    // Exact key set: one extra or one missing required key is a 400.
    expect(await test.sendToSignaling({ ...prepare.body, presenceRevision: 1 })).toEqual({
      status: 400,
      body: { error: 'INVALID_REQUEST' },
    });
    const { targets: _targets, ...withoutTargets } = prepare.body;
    expect((await test.sendToSignaling(withoutTargets)).status).toBe(400);
    // Replaying the room's own body at its epoch is accepted.
    expect((await test.sendToSignaling(prepare.body)).status).toBe(200);

    // A playback event one epoch ahead is refused; the presence snapshot is
    // the only event that may move the fence.
    expect(await test.sendToSignaling({ ...prepare.body, coordinatorEpoch: epoch + 1 })).toEqual({
      status: 409,
      body: { error: 'PRO_ROOM_EPOCH_STALE' },
    });
    expect(
      (await test.sendToSignaling({ ...presence.body, coordinatorEpoch: epoch + 1 })).status,
    ).toBe(200);
    // Behind the moved fence, the room's own next playback event is refused.
    const current = await test.request('/snapshot');
    const paused = await test.request('/playback/commands', {
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: { type: 'pause', baseRevision: current.body.snapshot.playback.revision },
    });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    const commits = (await test.waitFor('pro-playback-commit', 2)).filter(
      (entry) => entry.body.event.type === 'pro-playback-commit',
    );
    expect(commits[1]).toMatchObject({
      body: { coordinatorEpoch: epoch, event: { type: 'pro-playback-commit' } },
      status: 409,
      response: { error: 'PRO_ROOM_EPOCH_STALE' },
    });
  }, 60_000);

  it('advances the fence with the room’s own presence snapshot, then refuses the old epoch', async () => {
    const test = await harness();
    await test.waitFor('pro-presence-snapshot');
    await test.selectAndCommit();
    const before = await test.waitFor('pro-playback-commit');
    const oldPresence = before.find((entry) => entry.body.event.type === 'pro-presence-snapshot')!;
    const oldPrepare = before.find((entry) => entry.body.event.type === 'pro-playback-prepare')!;
    const epoch = oldPrepare.body.coordinatorEpoch as number;
    expect(oldPresence.body.coordinatorEpoch).toBe(epoch);

    // A PIN rotation advances the room-incarnation fence once (bumpRoomEpoch)
    // and the room sends the new epoch's presence snapshot itself.
    const rotated = await test.request('/pin', { body: { pin: '24681357' } });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    const presences = (await test.waitFor('pro-presence-snapshot', 2)).filter(
      (entry) => entry.body.event.type === 'pro-presence-snapshot',
    );
    expect(presences[1]).toMatchObject({
      body: { coordinatorEpoch: epoch + 1, event: { type: 'pro-presence-snapshot' } },
      status: 200,
      response: { broadcast: true },
    });
    expect(Object.keys(presences[1]!.body).sort()).toEqual(SIGNALING_BROADCAST_BODY_KEYS);

    // The new epoch's PREPARE and COMMIT pass the moved fence and reach a
    // socket opened at that epoch.
    await test.connect();
    const transitionId = await test.select();
    const after = (await test.waitFor('pro-playback-commit', 2)).filter(
      (entry) => entry.body.event.transitionId === transitionId,
    );
    expect(after.map((entry) => entry.body.event.type)).toEqual([
      'pro-playback-prepare',
      'pro-playback-commit',
    ]);
    for (const entry of after) {
      expect(entry.body.coordinatorEpoch).toBe(epoch + 1);
      expect(Object.keys(entry.body).sort()).toEqual(SIGNALING_BROADCAST_BODY_KEYS);
      expect(entry.status, JSON.stringify(entry)).toBe(200);
      expect(entry.response).toEqual({ broadcast: true, eligible: 1, sent: 1 });
    }

    // Behind the fence, the old epoch is refused, presence included.
    for (const old of [oldPrepare, oldPresence]) {
      expect(await test.sendToSignaling(old.body)).toEqual({
        status: 409,
        body: { error: 'PRO_ROOM_EPOCH_STALE' },
      });
    }
  }, 60_000);
});
