import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createStandardRoomAccountAssertion } from '../../../cloudflare/standard-room-account-assertion.ts';
import { localWorkerdPort } from './helpers/local-workerd-port.ts';

// All admission, PIN, identity, rate-limit, storage, and WebSocket operations
// run in the shipped handlers inside local workerd. Only account login itself
// is a fixture: assertions use the real signer and a deliberately local secret.
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const compatibilityDate = readFileSync(
  new URL('../../../cloudflare/wrangler.signaling.toml', import.meta.url),
  'utf8',
).match(/compatibility_date = "([^"]+)"/)![1]!;
const ACCOUNT_SECRET = 'standard-burst-local-account-assertion-secret';
const PIN_MUTATION_ID = 'standard_burst_pin_confirmation';
const DEADLINE_MS = 15_000;
const GUEST_CAPACITY = 99;
type Frame = Record<string, unknown>;
type LocalSocket = WebSocket;
type Client = ReturnType<typeof observeSocket>;
type Guest = { peerId: string; secret: string; accountAssertion?: string };
type Attempt = { guest: Guest; client: Client; outcome: Frame };
type RoomSnapshot = {
  guests: string[];
  pendingGuests: number;
  bindings: string[];
  live: { role: string; peerId: string; auth: string }[];
};
let runtime: Miniflare;
const clients = new Set<Client>();
const outboundRequests: string[] = [];

function observeSocket(socket: LocalSocket, label: string) {
  const frames: Frame[] = [];
  const listeners = new Set<() => void>();
  const record = (frame: Frame) => {
    frames.push(frame);
    for (const listener of listeners) listener();
  };
  socket.addEventListener('message', (event) => {
    try {
      record(JSON.parse(String(event.data)) as Frame);
    } catch {
      record({ type: 'invalid-json' });
    }
  });
  socket.addEventListener('close', (event) => {
    record({ type: 'socket-close', code: event.code, reason: event.reason });
  });
  socket.addEventListener('error', () => record({ type: 'socket-error' }));
  return {
    socket,
    frames,
    send(frame: Frame) {
      socket.send(JSON.stringify(frame));
    },
    wait(predicate: (frame: Frame) => boolean, operation: string): Promise<Frame> {
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          listeners.delete(check);
          clearTimeout(timer);
        };
        const check = () => {
          const found = frames.find(predicate);
          if (found) {
            finish();
            resolve(found);
          } else if (frames.some((frame) => frame.type === 'socket-error')) {
            finish();
            reject(new Error(`${label}: transport error during ${operation}`));
          }
        };
        timer = setTimeout(() => {
          finish();
          reject(
            new Error(
              `${label}: ${operation} deadline; state=${socket.readyState}; frames=${JSON.stringify(frames)}`,
            ),
          );
        }, DEADLINE_MS);
        listeners.add(check);
        check();
      });
    },
  };
}

// Register every virtual user before releasing the gate. Each operation starts
// without awaiting another user's request. workerd still serializes DO commits;
// this is simultaneous arrival pressure, not a claim of identical wire times.
async function burst<T, R>(items: readonly T[], operation: (item: T) => Promise<R>): Promise<R[]> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let registered = 0;
  const pending = items.map(async (item) => {
    registered += 1;
    await gate;
    expect(registered).toBe(items.length);
    return operation(item);
  });
  expect(registered).toBe(items.length);
  release();
  return Promise.all(pending);
}

beforeAll(async () => {
  const bundled = await build({
    absWorkingDir: repository,
    stdin: {
      resolveDir: repository,
      loader: 'ts',
      contents: `
        import front, { MusixquareRoom } from './cloudflare/signaling-worker.ts';
        export { MusixquareServiceControl } from './cloudflare/service-control-object.ts';
        // Read-only instrumentation; no admission method/state is replaced.
        export class ObservedRoom extends MusixquareRoom {
          constructor(state, env) { super(state, env); this.observedState = state; }
          fetch(request) {
            if (new URL(request.url).pathname === '/__snapshot') {
              return this.enqueueHostAdmission(async () => {
                const bindings = await this.observedState.storage.get('guestReconnectBindings');
                return Response.json({
                  guests: [...this.guests.keys()].sort(),
                  pendingGuests: this.pendingGuests.size,
                  bindings: (bindings?.entries ?? []).map(entry => entry.peerId).sort(),
                  live: this.observedState.getWebSockets().filter(ws => ws.readyState === 1)
                    .map(ws => ws.deserializeAttachment()).filter(Boolean)
                    .map(({ role, peerId, auth }) => ({ role, peerId, auth })),
                });
              });
            }
            return super.fetch(request);
          }
        }
        export default { fetch(request, env, ctx) {
          const url = new URL(request.url);
          if (url.pathname === '/__snapshot') {
            return env.MUSIXQUARE_ROOMS.getByName(url.searchParams.get('room')).fetch(request);
          }
          return front.fetch(request, env, ctx);
        } };
      `,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      port: await localWorkerdPort(),
      log: new Log(LogLevel.NONE),
      modules: true,
      compatibilityDate,
      script: bundled.outputFiles[0]!.text,
      durableObjects: {
        MUSIXQUARE_ROOMS: { className: 'ObservedRoom', useSQLite: true },
        MUSIXQUARE_SERVICE_CONTROL: { className: 'MusixquareServiceControl', useSQLite: true },
      },
      bindings: {
        ALLOWED_ORIGINS: 'https://musixquare.test',
        PRO_SIGNALING_SECRET: 'standard-burst-local-signaling-rate-secret',
        MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: ACCOUNT_SECRET,
        MXQR_STANDARD_ROOM_PIN_PEPPER: 'standard-burst-local-pin-pepper-secret',
      },
      outboundService: (request) => {
        outboundRequests.push(new URL(request.url).origin);
        throw new Error('Standard burst fixture forbids external network access');
      },
    }),
  );
  await runtime.ready;
}, 30_000);

afterEach(async () => {
  try {
    await Promise.all(
      [...clients].map(async (client) => {
        if (client.socket.readyState === 1) client.socket.close(1000, 'test complete');
        if (client.socket.readyState !== 3) {
          await client.wait((frame) => frame.type === 'socket-close', 'test cleanup');
        }
      }),
    );
  } finally {
    for (const client of clients) client.socket.terminate();
    clients.clear();
  }
  expect(outboundRequests, 'No external network requests may escape workerd').toEqual([]);
}, 20_000);

afterAll(async () => {
  await runtime?.dispose();
}, 30_000);

async function open(room: string, role: 'host' | 'guest', peerId: string, network: number) {
  const url = new URL(`/api/rooms/${room}/ws?role=${role}&peerId=${peerId}`, await runtime.ready);
  expect(['127.0.0.1', '[::1]', 'localhost']).toContain(url.hostname);
  url.protocol = 'ws:';
  // Use the actual local TCP WebSocket with bounded handshake and shutdown.
  // ws otherwise waits 30 s for TCP FIN after some pre-auth server rejections;
  // its close event still retains the server's actual close code and reason.
  const socketOptions = {
    handshakeTimeout: DEADLINE_MS,
    closeTimeout: 1_000,
    headers: {
      Origin: 'https://musixquare.test',
      // Each wave shares one venue/NAT address, exercising the real rate DO.
      'CF-Connecting-IP': `192.0.2.${network}`,
    },
  };
  const socket = new WebSocket(url, socketOptions);
  const client = observeSocket(socket, peerId);
  clients.add(client);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return client;
}

async function confirmHost(client: Client, password = '') {
  client.send({
    type: 'host-auth',
    secret: 'local-standard-room-secret',
    desiredRoomPassword: password,
    pinMutationId: PIN_MUTATION_ID,
  });
  await client.wait((frame) => frame.type === 'peer-open', 'host peer-open');
  client.send({ type: 'room-password-set', password, pinMutationId: PIN_MUTATION_ID });
  expect(
    await client.wait((frame) => frame.type === 'room-password-result', 'host PIN ready'),
  ).toMatchObject({ applied: true, mutationId: PIN_MUTATION_ID });
}

async function guests(room: string, count: number, prefix = 'guest'): Promise<Guest[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const peerId = `${prefix}_${index}`;
      const accountAssertion =
        index % 2 === 0
          ? await createStandardRoomAccountAssertion(
              {
                accountId: `acct_${String(index).padStart(22, '0')}`,
                nickname: `Guest ${index}`,
                roomCode: room,
                peerId,
                role: 'guest',
              },
              ACCOUNT_SECRET,
            )
          : null;
      if (index % 2 === 0) expect(accountAssertion).toBeTruthy();
      return {
        peerId,
        secret: peerId.padEnd(43, '_'),
        ...(accountAssertion ? { accountAssertion } : {}),
      };
    }),
  );
}

async function join(room: string, guest: Guest, network: number, password = ''): Promise<Attempt> {
  const client = await open(room, 'guest', guest.peerId, network);
  // An over-capacity pending socket may have closed before the client sees 101.
  if (client.socket.readyState === 1)
    client.send({
      type: 'guest-auth',
      password,
      reconnectSecret: guest.secret,
      ...(guest.accountAssertion ? { accountAssertion: guest.accountAssertion } : {}),
    });
  const outcome = await client.wait(
    (frame) => ['peer-open', 'error', 'socket-close'].includes(String(frame.type)),
    'guest admission',
  );
  return { guest, client, outcome };
}

async function snapshot(room: string): Promise<RoomSnapshot> {
  const response = await runtime.dispatchFetch(`http://localhost/__snapshot?room=${room}`, {
    signal: AbortSignal.timeout(DEADLINE_MS),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as RoomSnapshot;
}

function accepted(attempts: Attempt[]) {
  return attempts.filter(({ outcome }) => outcome.type === 'peer-open');
}

async function verifyUsable(host: Client, attempts: Attempt[], round: string) {
  await burst(attempts, async ({ guest, client, outcome }) => {
    expect(outcome).toMatchObject({ type: 'peer-open', peerId: guest.peerId });
    if (guest.accountAssertion) {
      expect(outcome.memberIdentity).toMatchObject({ nickname: expect.stringMatching(/^Guest /) });
    } else {
      expect(outcome.memberIdentity).toBeUndefined();
    }
    const negotiationId = `${round}_${guest.peerId}`.padEnd(16, '_');
    client.send({
      type: 'signal-offer',
      to: 'host',
      negotiationId,
      sdp: { type: 'offer', sdp: 'v=0\r\n' },
    });
    expect(
      await host.wait(
        (frame) =>
          frame.type === 'signal-offer' &&
          frame.from === guest.peerId &&
          frame.negotiationId === negotiationId,
        `relay from ${guest.peerId}`,
      ),
    ).toMatchObject({ sdp: { type: 'offer', sdp: 'v=0\r\n' } });
    host.send({
      type: 'signal-answer',
      to: guest.peerId,
      negotiationId,
      sdp: { type: 'answer', sdp: 'v=0\r\n' },
    });
    await client.wait(
      (frame) => frame.type === 'signal-answer' && frame.negotiationId === negotiationId,
      'relay answer',
    );
  });
}

async function verifyOccupancy(room: string, attempts: Attempt[]) {
  const state = await snapshot(room);
  const peerIds = attempts.map(({ guest }) => guest.peerId).sort();
  expect(state.guests).toEqual(peerIds);
  expect(state.pendingGuests).toBe(0);
  expect(
    state.live
      .filter((entry) => entry.role === 'guest' && entry.auth === 'ok')
      .map((entry) => entry.peerId)
      .sort(),
  ).toEqual(peerIds);
  expect(new Set(state.bindings).size).toBe(state.bindings.length);
  expect(state.bindings).toEqual(expect.arrayContaining(peerIds));
}

describe('Standard simultaneous session joins (real local workerd)', () => {
  it.each([
    { count: 30, password: '' },
    { count: 60, password: '12345678' },
    { count: 99, password: '' },
    { count: 99, password: '12345678' },
    { count: 110, password: '' },
  ])(
    'releases $count guests together (PIN "$password"), bounds capacity and relays every admitted guest',
    async ({ count, password }) => {
      const room = String(810000 + count + (password ? 1000 : 0));
      const network = password && count === 99 ? 100 : count;
      const host = await open(room, 'host', 'host', network);
      await confirmHost(host, password);
      const attempts = await burst(await guests(room, count), (guest) =>
        join(room, guest, network, password),
      );
      const admitted = accepted(attempts);
      expect(admitted).toHaveLength(Math.min(count, GUEST_CAPACITY));
      for (const attempt of attempts.filter(({ outcome }) => outcome.type !== 'peer-open')) {
        const reason = attempt.outcome.message ?? attempt.outcome.reason;
        expect([
          'ROOM_GUEST_LIMIT_REACHED',
          'ROOM_PENDING_LIMIT_REACHED',
          'PENDING_GUEST_SLOT_ROTATED',
        ]).toContain(reason);
      }
      await verifyUsable(host, admitted, 'initial');
      await verifyOccupancy(room, admitted);
    },
    30_000,
  );

  it('rejects a 60-user burst while the host is pending, then admits the same users on a simultaneous retry', async () => {
    const room = '820060';
    const host = await open(room, 'host', 'host', 121);
    const identities = await guests(room, 60);
    const early = await burst(identities, (guest) => join(room, guest, 122));
    expect(accepted(early)).toHaveLength(0);
    for (const attempt of early)
      expect(attempt.outcome).toMatchObject({ type: 'error', message: 'HOST_NOT_AVAILABLE' });
    expect((await snapshot(room)).guests).toEqual([]);
    await confirmHost(host);
    const retry = await burst(identities, (guest) => join(room, guest, 123));
    expect(accepted(retry)).toHaveLength(60);
    await verifyUsable(host, retry, 'retry');
    await verifyOccupancy(room, retry);
  }, 30_000);

  it('reconnects 30 devices at a full room and reuses 30 departed slots without phantom members', async () => {
    const room = '830099';
    const host = await open(room, 'host', 'host', 131);
    await confirmHost(host);
    const initial = await burst(await guests(room, 99), (guest) => join(room, guest, 132));
    expect(accepted(initial)).toHaveLength(99);
    const reconnecting = initial.slice(0, 30);
    const replacements = await burst(reconnecting, ({ guest }) => join(room, guest, 133));
    expect(accepted(replacements)).toHaveLength(30);
    for (const attempt of reconnecting) {
      expect(
        await attempt.client.wait((frame) => frame.type === 'socket-close', 'replaced connection'),
      ).toMatchObject({ code: 1012, reason: 'GUEST_REPLACED' });
    }
    const full = [...replacements, ...initial.slice(30)];
    await verifyOccupancy(room, full);
    await verifyUsable(host, replacements, 'reconnect');
    const overflow = await burst(await guests(room, 20, 'overflow'), (guest) =>
      join(room, guest, 134),
    );
    expect(accepted(overflow)).toHaveLength(0);
    for (const attempt of overflow)
      expect(attempt.outcome).toMatchObject({ message: 'ROOM_GUEST_LIMIT_REACHED' });
    await burst(replacements, async ({ guest, client }) => {
      client.socket.close(1000, 'leave');
      await host.wait(
        (frame) => frame.type === 'peer-left' && frame.peerId === guest.peerId,
        'authoritative departure',
      );
    });
    const newcomers = await burst(await guests(room, 30, 'newcomer'), (guest) =>
      join(room, guest, 135),
    );
    expect(accepted(newcomers)).toHaveLength(30);
    const final = [...initial.slice(30), ...newcomers];
    await verifyUsable(host, final, 'churn');
    await verifyOccupancy(room, final);
  }, 30_000);
});
