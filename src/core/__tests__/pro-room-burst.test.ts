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
import { parseProRoomSnapshot } from '../../pro-room/snapshot.ts';
import type { ProRoomSnapshot } from '../../pro-room/contracts.ts';
import { localWorkerdPort } from './helpers/local-workerd-port.ts';

// Local workerd executes the shipped front doors and real SQLite Durable
// Objects. Only the registry delay and initial account/registry data are test
// fixtures. No production requests, overridden clocks, or relaxed rate limits.
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const origin = 'http://localhost:5173';
const roomCode = '000000';
const secret = (purpose: string) => `local-burst-${purpose}-`.padEnd(48, 'x');
const accountId = 'acct_0123456789ABCDEFGHIJKL';
const date = (name: string) =>
  readFileSync(new URL(`../../../cloudflare/wrangler.${name}.toml`, import.meta.url), 'utf8').match(
    /compatibility_date = "([^"]+)"/,
  )![1]!;
let frontScript: string;
let signalingScript: string;
let runtime: Miniflare | undefined;
const sockets: TestSocket[] = [];
const outboundRequests: string[] = [];
const cleanupTasks: Array<() => Promise<void>> = [];
const backgroundFailures: string[] = [];

interface TestSocket {
  accept(): void;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, callback: (event: { data?: unknown }) => void): void;
  removeEventListener(type: string, callback: (event: { data?: unknown }) => void): void;
}
type LocalService = {
  fetch(input: string, init?: RequestInit): Promise<Response & { webSocket?: TestSocket }>;
};
interface Result {
  status: number;
  cookie: string;
  body: Record<string, unknown>;
}
interface Client {
  cookie: string;
  snapshot: ProRoomSnapshot;
  ip: string;
}

beforeAll(async () => {
  const [front, signaling] = await Promise.all([
    build({
      absWorkingDir: repository,
      stdin: {
        resolveDir: repository,
        loader: 'ts',
        contents: `
          import front from './cloudflare/pro-room-worker.ts';
          export { MusixquareProRoom, MusixquareServiceControl } from './cloudflare/pro-room-worker.ts';
          let db;
          function registry(env) {
            return { prepare(sql) {
              let statement = env.MUSIXQUARE_ADMIN_DB.prepare(sql);
              return {
                bind(...values) { statement = statement.bind(...values); return this },
                async all() {
                  await env.REGISTRY_DELAY.fetch('http://fixture/read');
                  return statement.all();
                },
                first() { return statement.first() },
              };
            } };
          }
          export default { async fetch(request, env, ctx) {
            if (new URL(request.url).pathname === '/fixture/cold') {
              db = registry(env);
              return env.REGISTRY_DELAY.fetch('http://fixture/reset', {
                method: 'POST', body: await request.text(),
              });
            }
            db ??= registry(env);
            return front.fetch(request, { ...env, MUSIXQUARE_ADMIN_DB: db }, ctx);
          } };
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
  frontScript = front.outputFiles[0]!.text;
  signalingScript = signaling.outputFiles[0]!.text;
});

afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()));
  for (const socket of sockets.splice(0)) socket.close(1000, 'test complete');
  await runtime?.dispose();
  runtime = undefined;
  expect(outboundRequests.splice(0)).toEqual([]);
  expect(backgroundFailures.splice(0)).toEqual([]);
});

// Every producer reaches this gate before any request is launched. This
// models a simultaneous release; server-side serialization remains real.
async function burst<T>(count: number, action: (index: number) => Promise<T>): Promise<T[]> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = Array.from({ length: count }, async (_, index) => {
    await gate;
    return action(index);
  });
  release();
  const settled = await Promise.allSettled(ready);
  const failed = settled.filter((result) => result.status === 'rejected');
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      `${failed.length}/${count} burst clients failed`,
    );
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}

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

function client(result: Result, ip: string): Client {
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const snapshot = parseProRoomSnapshot(result.body.snapshot);
  expect(snapshot, 'Every successful admission must pass the real client parser').not.toBeNull();
  expect(result.cookie).toMatch(/^__Host-mxqr_pro_session_/);
  return { cookie: result.cookie, snapshot: snapshot!, ip };
}

function assertRoster(snapshot: ProRoomSnapshot, count: number): void {
  const participants = snapshot.presence.participants;
  expect(participants).toHaveLength(count);
  expect(new Set(participants.map((participant) => participant.participantId)).size).toBe(count);
  const members = participants.filter((participant) => participant.role !== 'owner');
  expect(members.length).toBeLessThanOrEqual(99);
  expect(new Set(members.map((participant) => participant.memberDisplayNumber)).size).toBe(
    members.length,
  );
  expect(
    members.every(
      (participant) =>
        participant.memberDisplayNumber >= 1 && participant.memberDisplayNumber <= 100,
    ),
  ).toBe(true);
  expect(snapshot.presence.coordinatorParticipantId).toBeNull();
}

async function harness(passwordRequired = false) {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      port: await localWorkerdPort(),
      log: new Log(LogLevel.NONE),
      workers: [
        {
          name: 'pro',
          modules: true,
          compatibilityDate: date('pro-room'),
          script: frontScript,
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
          serviceBindings: { REGISTRY_DELAY: 'registry-delay' },
          outboundService: async (request) => {
            outboundRequests.push(request.url);
            return new Response('External network disabled', { status: 502 });
          },
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
          outboundService: async (request) => {
            outboundRequests.push(request.url);
            return new Response('External network disabled', { status: 502 });
          },
        },
        {
          name: 'registry-delay',
          modules: true,
          compatibilityDate: date('pro-room'),
          outboundService: async (request) => {
            outboundRequests.push(request.url);
            return new Response('External network disabled', { status: 502 });
          },
          script: `let reads = 0, delay = 0, active = 0, peak = 0;
          export default { async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === '/reset') { reads = 0; peak = 0; delay = Number(await request.text()); }
            if (path === '/read') { reads++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, delay)); active--; }
            return Response.json({ reads, peak });
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
      "INSERT INTO mxqr_pro_room_registry VALUES ('000000', 'Burst fixture', 'registered', NULL, 'unactivated', 0, 1, 1)",
    )
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
  const delay = (await runtime.getWorker('registry-delay')) as unknown as LocalService;
  const liveClients = new Map<string, Client>();
  const socketFailures: string[] = [];

  async function request(
    path: string,
    options: {
      body?: unknown;
      method?: string;
      ip?: string;
      client?: Client;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Result> {
    const headers: Record<string, string> = {
      Origin: origin,
      // Slow PIN bursts can reset a reused Miniflare/workerd idle connection;
      // a minimal local DO reproduces this without any product code. Isolate
      // each HTTP exchange so this transport artifact cannot mask admission.
      Connection: 'close',
      'cf-connecting-ip': options.ip ?? options.client?.ip ?? '192.0.2.1',
      'x-mxqr-pro-entry-policy': 'optional-v1',
      ...options.headers,
    };
    if (path === '/presence/current' && options.method === 'DELETE' && options.client) {
      liveClients.delete(options.client.cookie);
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.client) {
      headers.cookie = options.client.cookie;
      headers['x-mxqr-pro-participant-id'] = options.client.snapshot.viewer!.participantId;
      headers['x-mxqr-pro-presence-incarnation'] =
        options.client.snapshot.viewer!.presenceIncarnationId;
    }
    const response = await pro.fetch(`https://pro.test/v1/rooms/${roomCode}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const responseBody = await response.text();
    if (!responseBody.startsWith('{'))
      throw new Error(`${path}: ${response.status} ${responseBody}`);
    const result = {
      status: response.status,
      cookie:
        response.headers
          .getSetCookie()
          .find((value) => value.startsWith('__Host-mxqr_pro_session_'))
          ?.split(';')[0] ?? '',
      body: JSON.parse(responseBody) as Record<string, unknown>,
    };
    if (
      result.status === 200 &&
      result.body.snapshot &&
      path !== '/presence/current' &&
      path !== '/presence/heartbeat'
    ) {
      const snapshot = parseProRoomSnapshot(result.body.snapshot);
      const cookie = result.cookie || options.client?.cookie;
      if (snapshot && cookie)
        liveClients.set(cookie, {
          cookie,
          snapshot,
          ip: options.ip ?? options.client?.ip ?? '192.0.2.1',
        });
    }
    return result;
  }
  const claimToken = await issueProRoomActivationClaim(roomCode, secret('activation'));
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
  const owner = client(
    await request('/activation', {
      body: {
        claimToken,
        ownerName: 'Owner',
        ...(passwordRequired ? { temporaryPin: '00000000', newPin: '12345678' } : {}),
      },
      headers: { [ACCOUNT_ASSERTION_HEADER]: assertion! },
    }),
    '192.0.2.1',
  );
  // Keep the real 45-second presence TTL even on slow CI. Established devices
  // send the same authenticated heartbeat used by the App; failures are fatal.
  let heartbeat: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = Promise.all(
      [...liveClients.values()].map(async (who) => {
        const result = await request('/presence/heartbeat', { method: 'POST', client: who });
        // A leave or new incarnation may supersede an already-in-flight beat.
        if (
          liveClients.get(who.cookie)?.snapshot.viewer?.presenceIncarnationId !==
          who.snapshot.viewer?.presenceIncarnationId
        )
          return;
        if (result.status !== 200) throw new Error(`Heartbeat: ${JSON.stringify(result.body)}`);
      }),
    )
      .then(() => undefined)
      .catch((error: unknown) => {
        backgroundFailures.push(String(error));
      })
      .finally(() => {
        heartbeat = undefined;
      });
  }, 10_000);
  cleanupTasks.push(async () => {
    clearInterval(timer);
    await heartbeat;
  });

  return {
    owner,
    request,
    async coldRegistry(delayMs = 150) {
      const response = await pro.fetch('https://pro.test/fixture/cold', {
        method: 'POST',
        body: String(delayMs),
      });
      expect(response.status).toBe(200);
    },
    async assertRegistryCoalesced() {
      const counts = (await (await delay.fetch('http://fixture/counts')).json()) as {
        reads: number;
        peak: number;
      };
      // Later reads after the production five-second cache TTL are valid.
      expect(counts.reads).toBeGreaterThanOrEqual(1);
      expect(counts.peak).toBe(1);
    },
    join(
      index: number,
      ip = `198.51.100.${index + 1}`,
      requestId = `burst-session-request-${index.toString().padStart(5, '0')}`,
    ) {
      return request('/sessions', {
        ip,
        body: { requestId, ...(passwordRequired ? { pin: '12345678' } : {}) },
      });
    },
    async snapshot(who = owner) {
      const result = await request('/snapshot', { client: who });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const parsed = parseProRoomSnapshot(result.body.snapshot);
      expect(parsed).not.toBeNull();
      return parsed!;
    },
    async connect(who: Client) {
      const ticket = await request('/signaling-tickets', { method: 'POST', client: who });
      expect(ticket.status, JSON.stringify(ticket.body)).toBe(200);
      const response = await signaling.fetch(`https://signal.test/api/pro-rooms/${roomCode}/ws`, {
        headers: {
          Origin: origin,
          Upgrade: 'websocket',
          'cf-connecting-ip': who.ip,
          'Sec-WebSocket-Protocol': `mxqr.pro-signaling.v1, mxqr.ticket.${ticket.body.ticket}`,
        },
        signal: AbortSignal.timeout(20_000),
      });
      expect(response.status).toBe(101);
      expect(response.webSocket).toBeDefined();
      const socket = response.webSocket!;
      sockets.push(socket);
      socket.addEventListener('close', () =>
        socketFailures.push(`closed:${who.snapshot.viewer!.participantId}`),
      );
      socket.addEventListener('error', () =>
        socketFailures.push(`error:${who.snapshot.viewer!.participantId}`),
      );
      socket.addEventListener('message', (event) => {
        const value = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (value.type === 'error') socketFailures.push(JSON.stringify(value));
      });
      const opened = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('PRO peer-open deadline'));
        }, 10_000);
        const cleanup = () => {
          clearTimeout(timeout);
          socket.removeEventListener('message', message);
          socket.removeEventListener('close', closed);
        };
        const closed = () => {
          cleanup();
          reject(new Error('PRO socket closed before peer-open'));
        };
        const message = (event: { data?: unknown }) => {
          const value = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (value.type === 'peer-open') {
            cleanup();
            resolve(value);
          }
          if (value.type === 'error') {
            cleanup();
            reject(new Error(`PRO signaling error: ${JSON.stringify(value)}`));
          }
        };
        socket.addEventListener('message', message);
        socket.addEventListener('close', closed);
      });
      socket.accept();
      const peer = await opened;
      expect(peer.peerId).toBe(who.snapshot.viewer!.participantId);
      return socket;
    },
    async assertConnected() {
      expect(socketFailures).toEqual([]);
      await burst(sockets.length, async (index) => {
        const socket = sockets[index]!;
        const pong = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('PRO liveness deadline'));
          }, 10_000);
          const cleanup = () => {
            clearTimeout(timeout);
            socket.removeEventListener('message', message);
          };
          const message = (event: { data?: unknown }) => {
            const value = JSON.parse(String(event.data)) as Record<string, unknown>;
            if (value.type === 'signaling-liveness-pong' && value.version === 1) {
              cleanup();
              resolve();
            }
          };
          socket.addEventListener('message', message);
        });
        socket.send('{"type":"signaling-liveness-ping","version":1}');
        await pong;
      });
      expect(socketFailures).toEqual([]);
    },
  };
}

describe('PRO simultaneous admission burst (real workerd)', () => {
  it.each([30, 60, 99])(
    'admits %i distinct-IP guests through the cold registry, ticket, and WebSocket pipeline',
    async (count) => {
      const test = await harness();
      await test.coldRegistry();
      const guests = await burst(count, async (index) => {
        const ip = `198.51.100.${index + 1}`;
        const guest = client(await test.join(index, ip), ip);
        await test.connect(guest);
        return guest;
      });
      expect(guests).toHaveLength(count);
      await test.assertRegistryCoalesced();
      assertRoster(await test.snapshot(), count + 1);
      await test.connect(test.owner);
      await test.assertConnected();
    },
    60_000,
  );

  it('admits a password-protected 99-guest same-NAT venue without bypassing rate policy', async () => {
    const test = await harness(true);
    const ip = '203.0.113.7';
    const guests = await burst(99, async (index) => {
      const guest = client(await test.join(index, ip), ip);
      await test.connect(guest);
      return guest;
    });
    expect(guests).toHaveLength(99);
    assertRoster(await test.snapshot(), 100);
    await test.connect(test.owner);
    await test.assertConnected();
  }, 60_000);

  it('rejects excess admissions atomically and reserves the absent owner slot', async () => {
    const test = await harness();
    expect(
      (await test.request('/presence/current', { method: 'DELETE', client: test.owner })).status,
    ).toBe(200);
    const results = await burst(120, (index) => test.join(index));
    const accepted = results.filter((result) => result.status === 200);
    const rejected = results.filter((result) => result.status !== 200);
    expect(accepted).toHaveLength(99);
    expect(rejected).toHaveLength(21);
    expect(
      rejected.every(
        (result) =>
          result.status === 409 && result.body.error === 'ROOM_FULL' && result.cookie === '',
      ),
    ).toBe(true);
    accepted.forEach((result, index) => client(result, `198.51.100.${index + 1}`));
    const resumed = await test.request('/presence/enter', { method: 'POST', client: test.owner });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    const snapshot = parseProRoomSnapshot(resumed.body.snapshot)!;
    expect(snapshot).not.toBeNull();
    assertRoster(snapshot, 100);
    expect(
      snapshot.presence.participants.filter((participant) => participant.role === 'owner'),
    ).toHaveLength(1);
  }, 60_000);

  it('coalesces duplicate requests and outcome-unknown retries into one session per device', async () => {
    const test = await harness();
    const ip = '203.0.113.8';
    const results = await burst(120, (index) => test.join(index % 30, ip));
    results.forEach((result) => client(result, ip));
    expect(new Set(results.map((result) => result.cookie)).size).toBe(30);
    const retries = await burst(30, (index) => test.join(index, ip));
    retries.forEach((result, index) => {
      client(result, ip);
      expect(result.cookie).toBe(results[index]!.cookie);
    });
    assertRoster(await test.snapshot(), 31);
  }, 60_000);

  it('reuses bounded ordinals across retained sessions, replacement bursts, and simultaneous re-entry', async () => {
    const test = await harness();
    const original = await burst(99, async (index) =>
      client(await test.join(index), `198.51.100.${index + 1}`),
    );
    const leavers = original.slice(0, 28);
    const stayed = original.slice(28);
    const leave = await burst(28, (index) =>
      test.request('/presence/current', { method: 'DELETE', client: leavers[index]! }),
    );
    expect(leave.every((result) => result.status === 200)).toBe(true);
    const replacements = await burst(28, async (index) =>
      client(await test.join(index + 99), `198.51.100.${index + 100}`),
    );
    // 128 retained cookie sessions now exist, while only 100 are present.
    // Ordinal assignment must use current presence, not lifetime admissions.
    assertRoster(await test.snapshot(), 100);
    const replaceLeave = await burst(28, (index) =>
      test.request('/presence/current', { method: 'DELETE', client: replacements[index]! }),
    );
    expect(replaceLeave.every((result) => result.status === 200)).toBe(true);
    const returns = await burst(28, (index) =>
      test.request('/presence/enter', { method: 'POST', client: leavers[index]! }),
    );
    expect(returns.every((result) => result.status === 200)).toBe(true);
    returns.forEach((result, index) => {
      const snapshot = parseProRoomSnapshot(result.body.snapshot);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.viewer!.participantId).toBe(leavers[index]!.snapshot.viewer!.participantId);
      expect(snapshot!.viewer!.presenceIncarnationId).not.toBe(
        leavers[index]!.snapshot.viewer!.presenceIncarnationId,
      );
    });
    const final = await test.snapshot();
    assertRoster(final, 100);
    for (const guest of stayed) {
      expect(
        final.presence.participants.find(
          (participant) => participant.participantId === guest.snapshot.viewer!.participantId,
        )?.memberDisplayNumber,
      ).toBe(guest.snapshot.viewer!.memberDisplayNumber);
    }
  }, 60_000);
});
