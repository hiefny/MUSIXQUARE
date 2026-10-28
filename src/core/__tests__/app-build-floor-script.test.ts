import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  APP_BUILD_FLOOR_CLIENT_PATH,
  APP_BUILD_FLOOR_EDGE_CACHE_TTL_S,
  APP_BUILD_FLOOR_OPS_AUDIENCE,
  APP_BUILD_FLOOR_OPS_PATH,
  APP_BUILD_FLOOR_PUBLIC_STATUS_PATH,
  APP_BUILD_HEADER,
  effectiveAppBuildFloor,
  parseAppBuild,
} from '../../../cloudflare/app-build-floor-contract.ts';
import {
  APP_BUILD_FLOOR_CLIENT_READ_TIMEOUT_MS,
  APP_BUILD_FLOOR_CRON_REPORT_TIMEOUT_MS,
  formatAppBuildFloorSummary,
  parseAppBuildFloorArgs,
  readStableLiveAppBuild,
  runAppBuildFloorCommand,
  runSignalingProbe,
  type AppBuildFloorDependencies,
  type SignalingFloorProbe,
} from '../../../scripts/app-build-floor.mts';

const ORIGIN = 'https://musixquare.com';
const OIDC_REQUEST_URL = 'https://pipelines.actions.example/idtoken?api-version=2.0';
const OIDC_REQUEST_TOKEN = 'actions-request-token';
const OIDC_TOKEN = 'oidc-header.oidc-payload.oidc-signature';
const T0 = Date.parse('2026-10-26T00:00:30.000Z');
const ACTIONS_ENV = Object.freeze({
  ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_REQUEST_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: OIDC_REQUEST_TOKEN,
  GITHUB_RUN_ID: '123456',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: 'a'.repeat(40),
});

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

interface WorldOptions {
  stored?: number;
  revision?: number;
  liveBuild?: number;
  serviceWorkerBuilds?: Array<number | null>;
  cron?: boolean;
  clientLag?: number;
  clientNeverUpdates?: boolean;
  proIgnoresFloor?: boolean;
  signalingAdmitsBelowFloor?: number;
  opsFailuresBeforeSuccess?: number;
  statusUnavailable?: boolean;
  /** The PRO front door answers `proTransientStatus` until this time. */
  proTransientUntil?: number;
  proTransientStatus?: number;
  proRetryAfterS?: number;
  /** Room 000001 has no entry password (the PRO Worker answers `open`). */
  proRoomOpen?: boolean;
  /** An admitted bootstrap answers this body instead of the entry policy. */
  proAdmittedBody?: Record<string, unknown>;
}

/**
 * Production as the floor script sees it: the App Worker routes, the control
 * object's stored floor and live report, a minute cron, the PRO front door,
 * the Signaling gate and the GitHub OIDC token endpoint, on one fake clock.
 */
class FloorWorld {
  time = T0;
  stored: number;
  revision: number;
  updatedAt: number | null = T0 - 3_600_000;
  liveBuild: number;
  reportedLive: number | null;
  reportedAt: number | null;
  cron: boolean;
  clientLag: number;
  clientNeverUpdates: boolean;
  proIgnoresFloor: boolean;
  signalingAdmitsBelowFloor: number;
  opsFailuresBeforeSuccess: number;
  statusUnavailable: boolean;
  proTransientUntil: number;
  proTransientStatus: number;
  proRetryAfterS: number | null;
  proRoomOpen: boolean;
  proAdmittedBody: Record<string, unknown> | null;
  serviceWorkerBuilds: Array<number | null>;
  clientValue: number;
  requests: Array<{ method: string; url: string; headers: Headers; body: unknown; time: number }> =
    [];
  logs: string[] = [];
  summaries: string[] = [];
  signalingProbes: number[] = [];

  constructor(options: WorldOptions = {}) {
    this.stored = options.stored ?? 0;
    this.revision = options.revision ?? 0;
    this.liveBuild = options.liveBuild ?? 785;
    this.reportedLive = this.liveBuild;
    this.reportedAt = T0 - 20_000;
    this.cron = options.cron ?? true;
    this.clientLag = options.clientLag ?? 0;
    this.clientNeverUpdates = options.clientNeverUpdates ?? false;
    this.proIgnoresFloor = options.proIgnoresFloor ?? false;
    this.signalingAdmitsBelowFloor = options.signalingAdmitsBelowFloor ?? 0;
    this.opsFailuresBeforeSuccess = options.opsFailuresBeforeSuccess ?? 0;
    this.statusUnavailable = options.statusUnavailable ?? false;
    this.proTransientUntil = options.proTransientUntil ?? -Infinity;
    this.proTransientStatus = options.proTransientStatus ?? 429;
    this.proRetryAfterS = options.proRetryAfterS ?? null;
    this.proRoomOpen = options.proRoomOpen ?? false;
    this.proAdmittedBody = options.proAdmittedBody ?? null;
    this.serviceWorkerBuilds = options.serviceWorkerBuilds ?? [];
    this.clientValue = this.clientAnswer();
  }

  effective(): number {
    return effectiveAppBuildFloor(
      {
        minAppBuild: this.stored,
        liveAppBuild: this.reportedLive,
        liveReportedAt: this.reportedAt,
      },
      this.time,
    );
  }

  clientAnswer(): number {
    return Math.min(this.effective(), this.liveBuild);
  }

  status() {
    return {
      minAppBuild: this.stored,
      effectiveMinAppBuild: this.effective(),
      revision: this.revision,
      updatedAt: this.updatedAt,
      liveAppBuild: this.liveBuild,
      reportedLiveAppBuild: this.reportedLive,
      reportedAt: this.reportedAt,
      state: 'valid',
      generatedAt: this.time,
    };
  }

  advance(milliseconds: number): void {
    const end = this.time + milliseconds;
    for (;;) {
      const nextMinute = Math.floor(this.time / 60_000) * 60_000 + 60_000;
      if (nextMinute > end) break;
      this.time = nextMinute;
      if (this.cron) {
        this.reportedLive = this.liveBuild;
        this.reportedAt = this.time;
      }
    }
    this.time = end;
  }

  fetcher = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    this.requests.push({ method, url: url.toString(), headers, body, time: this.time });

    if (url.toString().startsWith('https://pipelines.actions.example/idtoken')) {
      if (headers.get('Authorization') !== `Bearer ${OIDC_REQUEST_TOKEN}`) {
        return json({ message: 'denied' }, 401);
      }
      if (url.searchParams.get('audience') !== APP_BUILD_FLOOR_OPS_AUDIENCE) {
        return json({ message: 'wrong audience' }, 400);
      }
      return json({ value: OIDC_TOKEN });
    }
    if (url.origin !== ORIGIN) throw new Error(`Unexpected origin ${url.origin}`);
    if (url.pathname === '/service-worker.js') {
      const build = this.serviceWorkerBuilds.length
        ? this.serviceWorkerBuilds.shift()
        : this.liveBuild;
      if (build === null || build === undefined) return new Response('', { status: 404 });
      return new Response(`self.x=1;\nconst CACHE_VERSION = 'v${build}';\n`, { status: 200 });
    }
    if (url.pathname === APP_BUILD_FLOOR_PUBLIC_STATUS_PATH) {
      if (this.statusUnavailable) return json({ error: 'APP_BUILD_FLOOR_UNAVAILABLE' }, 503);
      return json(this.status(), 200, { 'Cache-Control': 'no-store' });
    }
    if (url.pathname === APP_BUILD_FLOOR_CLIENT_PATH) {
      const target = this.clientAnswer();
      if (target !== this.clientValue && !this.clientNeverUpdates) {
        if (this.clientLag > 0) this.clientLag -= 1;
        else this.clientValue = target;
      }
      return json({ effectiveMinAppBuild: this.clientValue }, 200, { 'Cache-Control': 'no-store' });
    }
    if (url.pathname === APP_BUILD_FLOOR_OPS_PATH) return this.ops(headers, body);
    if (url.pathname === '/api/pro-room/v1/rooms/000001/bootstrap') {
      if (this.time < this.proTransientUntil) {
        return json(
          { error: this.proTransientStatus === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE' },
          this.proTransientStatus,
          this.proRetryAfterS === null ? {} : { 'Retry-After': String(this.proRetryAfterS) },
        );
      }
      const build = parseAppBuild(headers.get(APP_BUILD_HEADER)) ?? 0;
      const floor = this.proIgnoresFloor ? 0 : this.effective();
      if (floor > 0 && build < floor) {
        return json({ error: 'APP_UPDATE_REQUIRED', minAppBuild: floor }, 426);
      }
      // The PRO Worker reports the room's entry policy with the status.
      return json(
        this.proAdmittedBody ?? {
          roomCode: '000001',
          status: this.proRoomOpen ? 'open' : 'pin_required',
          passwordRequired: !this.proRoomOpen,
        },
      );
    }
    throw new Error(`Unexpected request ${method} ${url.toString()}`);
  };

  ops(headers: Headers, body: unknown): Response {
    if (headers.get('Authorization') !== `Bearer ${OIDC_TOKEN}`) {
      return json({ error: 'OIDC_TOKEN_INVALID' }, 401);
    }
    if (this.opsFailuresBeforeSuccess > 0) {
      this.opsFailuresBeforeSuccess -= 1;
      return json({ error: 'APP_BUILD_FLOOR_UNAVAILABLE' }, 503);
    }
    const command = body as Record<string, unknown>;
    if (command.action === 'check') {
      return json({ ok: true, action: 'check', workflow: 'wf', appBuildFloor: this.status() });
    }
    const minAppBuild = Number(command.minAppBuild);
    if (command.expectedRevision !== this.revision) {
      return json(
        { error: 'APP_BUILD_FLOOR_REVISION_CONFLICT', appBuildFloor: this.status() },
        409,
      );
    }
    const raise = minAppBuild > this.stored;
    if (raise && command.action === 'lower') {
      return json({ error: 'APP_BUILD_FLOOR_LOWER_ONLY', appBuildFloor: this.status() }, 409);
    }
    if (raise && minAppBuild > this.liveBuild) {
      return json({ error: 'APP_BUILD_FLOOR_ABOVE_LIVE', appBuildFloor: this.status() }, 409);
    }
    const changed = minAppBuild !== this.stored;
    if (changed) {
      this.stored = minAppBuild;
      this.revision += 1;
      this.updatedAt = this.time;
      if (raise) {
        this.reportedLive = this.liveBuild;
        this.reportedAt = this.time;
      }
    }
    return json({
      ok: true,
      action: command.action,
      workflow: 'wf',
      changed,
      replayed: false,
      appBuildFloor: this.status(),
    });
  }

  probeSignaling = async (appBuild: number): Promise<SignalingFloorProbe> => {
    this.signalingProbes.push(appBuild);
    const floor = this.effective();
    if (this.signalingAdmitsBelowFloor > 0) {
      this.signalingAdmitsBelowFloor -= 1;
      return { outcome: 'admitted' };
    }
    if (floor > 0 && appBuild < floor) {
      return {
        outcome: 'below-floor',
        minAppBuild: floor,
        closeCode: 1008,
        closeReason: 'APP_UPDATE_REQUIRED',
      };
    }
    return { outcome: 'admitted' };
  };

  deps(env: Record<string, string | undefined> = ACTIONS_ENV): AppBuildFloorDependencies {
    return {
      fetcher: this.fetcher,
      now: () => this.time,
      sleep: async (milliseconds: number) => this.advance(milliseconds),
      log: (line: string) => this.logs.push(line),
      writeSummary: (line: string) => this.summaries.push(line),
      env,
      releaseBuild: () => 785,
      probeSignaling: this.probeSignaling,
    };
  }

  opsRequests() {
    return this.requests.filter(
      (request) => new URL(request.url).pathname === APP_BUILD_FLOOR_OPS_PATH,
    );
  }

  tokenRequests() {
    return this.requests.filter((request) =>
      request.url.startsWith(OIDC_REQUEST_URL.split('?')[0]!),
    );
  }
}

describe('App build floor script arguments', () => {
  it('parses the read-only, setter, release and emergency actions', () => {
    expect(parseAppBuildFloorArgs(['status'], {})).toEqual({ action: 'status' });
    expect(parseAppBuildFloorArgs(['check'], {})).toEqual({ action: 'check' });
    expect(parseAppBuildFloorArgs(['emergency-guard'], {})).toEqual({
      action: 'emergency-guard',
    });
    expect(
      parseAppBuildFloorArgs(['set', '785'], { MXQR_APP_BUILD_FLOOR_REASON: 'Turn it on' }),
    ).toEqual({ action: 'set', minAppBuild: 785, reason: 'Turn it on' });
    expect(parseAppBuildFloorArgs(['lower', '0'], { GITHUB_RUN_ID: '42' })).toEqual({
      action: 'lower',
      minAppBuild: 0,
      reason: 'Lowered by the App Build Floor workflow (run 42)',
    });
    expect(parseAppBuildFloorArgs(['raise'], { GITHUB_RUN_ID: '42' })).toEqual({
      action: 'raise',
      reason: 'Raised to the released build by Production Release (run 42)',
    });
    // The workflow passes an empty build input for the read-only actions.
    expect(parseAppBuildFloorArgs(['status', ''], {})).toEqual({ action: 'status' });
  });

  it.each([
    [[]],
    [['unknown']],
    [['set']],
    [['set', '']],
    [['set', '-1']],
    [['set', '785.5']],
    [['set', '0785']],
    [['set', '2147483648']],
    [['lower', 'abc']],
    [['status', '785']],
    [['raise', '785']],
    [['set', '785', 'extra']],
  ])('rejects %j', (argv) => {
    expect(() => parseAppBuildFloorArgs(argv, {})).toThrow('Usage');
  });

  it('rejects a reason the control object would refuse', () => {
    expect(() =>
      parseAppBuildFloorArgs(['set', '785'], { MXQR_APP_BUILD_FLOOR_REASON: 'two\nlines' }),
    ).toThrow('reason');
    expect(() =>
      parseAppBuildFloorArgs(['set', '785'], { MXQR_APP_BUILD_FLOOR_REASON: 'x'.repeat(201) }),
    ).toThrow('reason');
  });

  it('reads the App build the PRO Worker requires from the release workflow value', () => {
    // An empty or missing value means the PRO Worker requires no App build.
    expect(parseAppBuildFloorArgs(['pro-room-guard'], {})).toEqual({
      action: 'pro-room-guard',
      requiredAppBuild: null,
    });
    expect(
      parseAppBuildFloorArgs(['pro-room-guard', ''], { MXQR_PRO_ROOM_REQUIRED_APP_BUILD: '' }),
    ).toEqual({ action: 'pro-room-guard', requiredAppBuild: null });
    expect(
      parseAppBuildFloorArgs(['pro-room-guard'], { MXQR_PRO_ROOM_REQUIRED_APP_BUILD: '794' }),
    ).toEqual({ action: 'pro-room-guard', requiredAppBuild: 794 });
    for (const value of ['0', '-1', '794.5', '0794', 'v794', '2147483648']) {
      expect(
        () =>
          parseAppBuildFloorArgs(['pro-room-guard'], { MXQR_PRO_ROOM_REQUIRED_APP_BUILD: value }),
        value,
      ).toThrow('MXQR_PRO_ROOM_REQUIRED_APP_BUILD');
    }
    expect(() =>
      parseAppBuildFloorArgs(['pro-room-guard', '794'], {
        MXQR_PRO_ROOM_REQUIRED_APP_BUILD: '794',
      }),
    ).toThrow('Usage');
  });
});

describe('App build floor live App build', () => {
  it('needs three consecutive equal reads that the public status confirms', async () => {
    const world = new FloorWorld({ serviceWorkerBuilds: [784, 785, 785, 785] });
    await expect(readStableLiveAppBuild(world.deps())).resolves.toBe(785);
    const serviceWorkerReads = world.requests.filter((request) =>
      request.url.endsWith('/service-worker.js'),
    );
    expect(serviceWorkerReads).toHaveLength(4);
    for (const read of serviceWorkerReads) {
      expect(read.method).toBe('GET');
    }
  });

  it('fails when the live App build never settles', async () => {
    const flapping = Array.from({ length: 200 }, (_, index) => (index % 2 ? 785 : 784));
    const world = new FloorWorld({ serviceWorkerBuilds: flapping });
    await expect(readStableLiveAppBuild(world.deps())).rejects.toThrow(
      'live App build did not settle',
    );
  });
});

describe('App build floor script', () => {
  it('reads the status without minting a token or changing anything', async () => {
    const world = new FloorWorld({ stored: 785, revision: 2 });
    const result = await runAppBuildFloorCommand({ action: 'status' }, world.deps({}));
    expect(result?.status.minAppBuild).toBe(785);
    expect(world.opsRequests()).toHaveLength(0);
    expect(world.tokenRequests()).toHaveLength(0);
    expect(world.summaries).toEqual([result?.summary]);
    expect(result?.summary).toBe(
      'App build floor: stored 785, effective 785, revision 2, updated 2026-10-25T23:00:30.000Z; ' +
        'live App 785, reported 785 at 2026-10-26T00:00:10.000Z; client read 785',
    );
  });

  it('authenticates a check through GitHub OIDC without mutating', async () => {
    const world = new FloorWorld({ stored: 785, revision: 2 });
    await runAppBuildFloorCommand({ action: 'check' }, world.deps());
    expect(world.tokenRequests()).toHaveLength(1);
    expect(world.opsRequests()).toHaveLength(1);
    expect(world.opsRequests()[0]?.body).toEqual({ action: 'check' });
    expect(world.revision).toBe(2);
    expect(world.logs.join('\n')).not.toContain(OIDC_TOKEN);
  });

  it('refuses a setter without GitHub Actions OIDC before any request to the App', async () => {
    const world = new FloorWorld();
    await expect(
      runAppBuildFloorCommand(
        { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
        world.deps({}),
      ),
    ).rejects.toThrow('GitHub Actions OIDC');
    expect(world.opsRequests()).toHaveLength(0);
  });

  it('refuses to set the floor above the live App build without posting', async () => {
    const world = new FloorWorld({ liveBuild: 785 });
    await expect(
      runAppBuildFloorCommand({ action: 'set', minAppBuild: 786, reason: 'Too far' }, world.deps()),
    ).rejects.toThrow('above the live App build 785');
    expect(world.opsRequests()).toHaveLength(0);
    expect(world.tokenRequests()).toHaveLength(0);
  });

  it('sets the floor, proves every gate and the client read, and prints one summary', async () => {
    const world = new FloorWorld({ stored: 0, revision: 0 });
    const result = await runAppBuildFloorCommand(
      { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
      world.deps(),
    );

    const [post] = world.opsRequests();
    expect(post?.method).toBe('POST');
    expect(post?.headers.get('Authorization')).toBe(`Bearer ${OIDC_TOKEN}`);
    expect(post?.headers.get('Content-Type')).toMatch(/^application\/json/u);
    expect(post?.body).toEqual({
      action: 'set',
      minAppBuild: 785,
      expectedRevision: 0,
      requestId: 'gha-123456-1-set',
      reason: 'Turn it on',
    });
    expect(world.stored).toBe(785);

    const bootstraps = world.requests.filter((request) => request.url.endsWith('/bootstrap'));
    expect(bootstraps.map((request) => request.headers.get(APP_BUILD_HEADER))).toEqual(
      expect.arrayContaining(['784', '785']),
    );
    expect(world.signalingProbes).toEqual([784]);
    expect(world.reportedAt).toBeGreaterThan(world.updatedAt ?? Infinity);
    expect(result?.clientFloor).toBe(785);
    expect(result?.changed).toBe(true);
    expect(world.summaries).toEqual([result?.summary]);
    expect(result?.summary).toContain('stored 785, effective 785, revision 1');
    for (const line of [...world.logs, ...world.summaries]) {
      expect(line).not.toContain(OIDC_TOKEN);
      expect(line).not.toContain(OIDC_REQUEST_TOKEN);
    }
  });

  it('repeats a transient ops failure with the same request id', async () => {
    const world = new FloorWorld({ opsFailuresBeforeSuccess: 1 });
    await runAppBuildFloorCommand(
      { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
      world.deps(),
    );
    const bodies = world.opsRequests().map((request) => request.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it('fails a set that leaves the floor without a later App cron report', async () => {
    const world = new FloorWorld({ cron: false });
    const outcome = runAppBuildFloorCommand(
      { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
      world.deps(),
    );
    await expect(outcome).rejects.toThrow('No App cron report');
    // The floor stays set; only the report check failed.
    expect(world.stored).toBe(785);
    expect(world.time - T0).toBeGreaterThanOrEqual(APP_BUILD_FLOOR_CRON_REPORT_TIMEOUT_MS);
  });

  it('waits for the client read to reach the new floor through the edge cache', async () => {
    const world = new FloorWorld({ clientLag: 3 });
    const result = await runAppBuildFloorCommand(
      { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
      world.deps(),
    );
    expect(result?.clientFloor).toBe(785);
  });

  it('fails when the client read never shows the new floor, leaving the floor set', async () => {
    const world = new FloorWorld({ clientNeverUpdates: true });
    let startedClientPollAt = 0;
    const deps = world.deps();
    const fetcher = deps.fetcher;
    deps.fetcher = async (input, init) => {
      if (!startedClientPollAt && String(input).endsWith(APP_BUILD_FLOOR_CLIENT_PATH)) {
        startedClientPollAt = world.time;
      }
      return fetcher(input, init);
    };
    await expect(
      runAppBuildFloorCommand({ action: 'set', minAppBuild: 785, reason: 'Turn it on' }, deps),
    ).rejects.toThrow('start and resume check would not see it');
    expect(world.stored).toBe(785);
    // The step summary still records the floor that is set, with the stale read.
    expect(world.summaries).toEqual([
      expect.stringMatching(/stored 785, effective 785, revision 1[^\n]*client read 0$/u),
    ]);
    expect(APP_BUILD_FLOOR_CLIENT_READ_TIMEOUT_MS).toBe(
      (APP_BUILD_FLOOR_EDGE_CACHE_TTL_S + 30) * 1_000,
    );
    expect(world.time - startedClientPollAt).toBeGreaterThanOrEqual(
      APP_BUILD_FLOOR_CLIENT_READ_TIMEOUT_MS,
    );
  });

  it('fails when the PRO front door still admits a build below the floor', async () => {
    const world = new FloorWorld({ proIgnoresFloor: true });
    await expect(
      runAppBuildFloorCommand(
        { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
        world.deps(),
      ),
    ).rejects.toThrow('PRO');
  });

  it('proves the PRO gate on an open canary room and sends the entry-policy opt-in', async () => {
    const world = new FloorWorld({ proRoomOpen: true });
    const result = await runAppBuildFloorCommand(
      { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
      world.deps(),
    );
    expect(result?.status.minAppBuild).toBe(785);
    const bootstraps = world.requests.filter((request) => request.url.endsWith('/bootstrap'));
    expect(bootstraps.length).toBeGreaterThan(0);
    // With the opt-in, the PRO Worker before and after the 2026-10-26
    // old-version removal give the same answer.
    for (const request of bootstraps) {
      expect(request.headers.get('X-MXQR-Pro-Entry-Policy')).toBe('optional-v1');
    }
  });

  it.each([
    { roomCode: '000001', status: 'pin_required' },
    { roomCode: '000001', status: 'pin_required', passwordRequired: false },
    { roomCode: '000001', status: 'open', passwordRequired: true },
    { roomCode: '000001', status: 'open' },
    { roomCode: '000002', status: 'pin_required', passwordRequired: true },
  ])('fails when the admitted PRO canary answers %o', async (proAdmittedBody) => {
    const world = new FloorWorld({ proAdmittedBody });
    await expect(
      runAppBuildFloorCommand(
        { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
        world.deps(),
      ),
    ).rejects.toThrow('PRO front door did not refuse build 784 and admit build 785');
    expect(world.stored).toBe(785);
  });

  it('waits out a rate-limited PRO front door for its Retry-After beyond the propagation budget', async () => {
    const world = new FloorWorld({ proTransientUntil: T0 + 40_000, proRetryAfterS: 15 });
    const result = await runAppBuildFloorCommand(
      { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
      world.deps(),
    );
    expect(result?.status.minAppBuild).toBe(785);
    // Three rate-limited polls, each followed by the 15 s Retry-After instead
    // of the 3 s poll, then the refusal and the admission after the limit.
    const times = world.requests
      .filter((request) => request.url.endsWith('/bootstrap'))
      .map((request) => request.time);
    expect(times).toHaveLength(8);
    const polls = [times[0]!, times[2]!, times[4]!, times[6]!];
    expect(polls.slice(1).map((time, index) => time - polls[index]!)).toEqual([
      15_000, 15_000, 15_000,
    ]);
    expect(polls[3]).toBeGreaterThanOrEqual(T0 + 40_000);
    expect(world.logs.filter((line) => line.includes('PRO front door answered'))).toHaveLength(3);
  });

  it('fails a PRO front door that stays unavailable, naming its answers', async () => {
    const world = new FloorWorld({ proTransientUntil: Infinity, proTransientStatus: 503 });
    await expect(
      runAppBuildFloorCommand(
        { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
        world.deps(),
      ),
    ).rejects.toThrow(/PRO front door.*HTTP 503, HTTP 503/u);
    // The floor stays set; only the verification failed, within a bounded wait.
    expect(world.stored).toBe(785);
    expect(world.time - T0).toBeLessThan(120_000);
  });

  it('retries a Signaling admission while the floor propagates, then requires the refusal', async () => {
    const recovering = new FloorWorld({ signalingAdmitsBelowFloor: 1 });
    await runAppBuildFloorCommand(
      { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
      recovering.deps(),
    );
    expect(recovering.signalingProbes).toEqual([784, 784]);

    const broken = new FloorWorld({ signalingAdmitsBelowFloor: 10 });
    await expect(
      runAppBuildFloorCommand(
        { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
        broken.deps(),
      ),
    ).rejects.toThrow('Signaling');
    expect(broken.signalingProbes.length).toBeLessThanOrEqual(3);
  });

  it('repeats a Signaling probe that could not connect, within the same attempt budget', async () => {
    const recovering = new FloorWorld();
    const deps = recovering.deps();
    let failures = 1;
    deps.probeSignaling = async (appBuild) => {
      if (failures > 0) {
        failures -= 1;
        recovering.signalingProbes.push(appBuild);
        throw new Error('The Signaling probe upgrade answered HTTP 503.');
      }
      return recovering.probeSignaling(appBuild);
    };
    await runAppBuildFloorCommand({ action: 'set', minAppBuild: 785, reason: 'Turn it on' }, deps);
    expect(recovering.signalingProbes).toEqual([784, 784]);

    const unreachable = new FloorWorld();
    const unreachableDeps = unreachable.deps();
    let probes = 0;
    unreachableDeps.probeSignaling = async () => {
      probes += 1;
      throw new Error('The Signaling probe upgrade answered HTTP 503.');
    };
    await expect(
      runAppBuildFloorCommand(
        { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
        unreachableDeps,
      ),
    ).rejects.toThrow('HTTP 503');
    expect(probes).toBe(3);
  });

  it('repeats a Signaling refusal at another floor, then requires the exact close', async () => {
    // An isolate that still holds the floor from before the change.
    const stale = new FloorWorld();
    const deps = stale.deps();
    let staleProbes = 1;
    deps.probeSignaling = async (appBuild) => {
      if (staleProbes > 0) {
        staleProbes -= 1;
        stale.signalingProbes.push(appBuild);
        return {
          outcome: 'below-floor',
          minAppBuild: 786,
          closeCode: 1008,
          closeReason: 'APP_UPDATE_REQUIRED',
        };
      }
      return stale.probeSignaling(appBuild);
    };
    await runAppBuildFloorCommand({ action: 'set', minAppBuild: 785, reason: 'Turn it on' }, deps);
    expect(stale.signalingProbes).toEqual([784, 784]);

    const wrongClose = new FloorWorld();
    const wrongCloseDeps = wrongClose.deps();
    let probes = 0;
    wrongCloseDeps.probeSignaling = async () => {
      probes += 1;
      return {
        outcome: 'below-floor',
        minAppBuild: 785,
        closeCode: 1011,
        closeReason: 'APP_UPDATE_REQUIRED',
      };
    };
    await expect(
      runAppBuildFloorCommand(
        { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
        wrongCloseDeps,
      ),
    ).rejects.toThrow('close 1011');
    expect(probes).toBe(1);
  });

  it('fails at once when the Signaling Worker refuses the probe as an invalid first frame', async () => {
    // The probe's host-auth no longer matches the shape the Worker requires,
    // or a Signaling Worker older than 9.0.14 refuses its appBuild (a rollback
    // outside the procedure): repeating it cannot help, the message names both
    // causes, and 'deploy signaling first' would be wrong.
    const world = new FloorWorld();
    const deps = world.deps();
    let probes = 0;
    deps.probeSignaling = async () => {
      probes += 1;
      return { outcome: 'invalid-frame' };
    };
    const failure = await runAppBuildFloorCommand(
      { action: 'set', minAppBuild: 785, reason: 'Turn it on' },
      deps,
    ).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toContain('HOST_AUTH_FIRST_FRAME_INVALID');
    expect(failure).toContain('the probe does not send the host-auth shape the Worker requires');
    expect(failure).toContain('older than 9.0.14');
    expect(failure).not.toContain('deploy signaling first');
    expect(probes).toBe(1);
  });

  it('keeps a set at the stored floor as a re-verification without posting', async () => {
    const world = new FloorWorld({ stored: 785, revision: 3 });
    const result = await runAppBuildFloorCommand(
      { action: 'set', minAppBuild: 785, reason: 'Again' },
      world.deps(),
    );
    expect(world.opsRequests()).toHaveLength(0);
    expect(result?.changed).toBe(false);
    expect(world.signalingProbes).toEqual([784]);
  });

  it('sends a lower to the lower action instead of the set action', async () => {
    const world = new FloorWorld({ stored: 785, revision: 3 });
    await expect(
      runAppBuildFloorCommand({ action: 'set', minAppBuild: 784, reason: 'Down' }, world.deps()),
    ).rejects.toThrow('use lower');
    expect(world.opsRequests()).toHaveLength(0);
  });

  it('lowers without reading the live App build and proves the lower floor', async () => {
    const world = new FloorWorld({
      stored: 785,
      revision: 3,
      serviceWorkerBuilds: Array.from({ length: 50 }, () => null),
    });
    const result = await runAppBuildFloorCommand(
      { action: 'lower', minAppBuild: 0, reason: 'Turn it off' },
      world.deps(),
    );
    expect(world.opsRequests()[0]?.body).toEqual({
      action: 'lower',
      minAppBuild: 0,
      expectedRevision: 3,
      requestId: 'gha-123456-1-lower',
      reason: 'Turn it off',
    });
    expect(world.stored).toBe(0);
    // Floor 0: a build-less PRO entry is admitted and no Signaling room is opened.
    const bootstraps = world.requests.filter((request) => request.url.endsWith('/bootstrap'));
    expect(bootstraps.some((request) => request.headers.get(APP_BUILD_HEADER) === null)).toBe(true);
    expect(world.signalingProbes).toEqual([]);
    expect(result?.clientFloor).toBe(0);
  });

  it('keeps a lower that no later App cron report confirms, with a warning and the summary', async () => {
    const world = new FloorWorld({ stored: 785, revision: 3, cron: false });
    const result = await runAppBuildFloorCommand(
      { action: 'lower', minAppBuild: 0, reason: 'Turn it off' },
      world.deps(),
    );
    expect(world.stored).toBe(0);
    expect(result?.changed).toBe(true);
    expect(result?.clientFloor).toBe(0);
    expect(world.summaries).toEqual([result?.summary]);
    expect(result?.summary).toContain('stored 0, effective 0, revision 4');
    expect(world.logs).toContainEqual(expect.stringMatching(/^::warning::.*No App cron report/u));
    expect(world.time - T0).toBeGreaterThanOrEqual(APP_BUILD_FLOOR_CRON_REPORT_TIMEOUT_MS);
  });

  it('refuses a lower that would raise the floor', async () => {
    const world = new FloorWorld({ stored: 784, revision: 1 });
    await expect(
      runAppBuildFloorCommand({ action: 'lower', minAppBuild: 785, reason: 'Up' }, world.deps()),
    ).rejects.toThrow('use set');
    expect(world.opsRequests()).toHaveLength(0);
  });

  describe('Production Release raise', () => {
    it('raises only to the released build that is live', async () => {
      const world = new FloorWorld({ stored: 0, liveBuild: 785 });
      const result = await runAppBuildFloorCommand(
        { action: 'raise', reason: 'Released' },
        world.deps(),
      );
      expect(world.opsRequests()[0]?.body).toMatchObject({
        action: 'set',
        minAppBuild: 785,
        requestId: 'gha-123456-1-raise',
      });
      expect(result?.status.minAppBuild).toBe(785);
    });

    it('refuses when the live App is not the released build', async () => {
      const world = new FloorWorld({ liveBuild: 784 });
      await expect(
        runAppBuildFloorCommand({ action: 'raise', reason: 'Released' }, world.deps()),
      ).rejects.toThrow('not this release');
      expect(world.opsRequests()).toHaveLength(0);
      expect(world.tokenRequests()).toHaveLength(0);
    });

    it('does nothing when the floor is already at or above the released build', async () => {
      const world = new FloorWorld({ stored: 785, revision: 4, liveBuild: 785 });
      const result = await runAppBuildFloorCommand(
        { action: 'raise', reason: 'Released' },
        world.deps(),
      );
      expect(world.opsRequests()).toHaveLength(0);
      expect(world.tokenRequests()).toHaveLength(0);
      expect(result?.changed).toBe(false);
      expect(world.logs.join('\n')).toContain('already');
    });
  });

  describe('emergency deployment guard', () => {
    it('refuses a local build below the stored floor and names the lower command', async () => {
      const world = new FloorWorld({ stored: 786, liveBuild: 786 });
      await expect(
        runAppBuildFloorCommand({ action: 'emergency-guard' }, world.deps({})),
      ).rejects.toThrow(
        /below the stored App build floor 786[\s\S]*action=lower[\s\S]*min_app_build=785/u,
      );
    });

    it('allows a local build at or above the stored floor', async () => {
      const world = new FloorWorld({ stored: 785 });
      await expect(
        runAppBuildFloorCommand({ action: 'emergency-guard' }, world.deps({})),
      ).resolves.toBeNull();
      expect(world.opsRequests()).toHaveLength(0);
    });

    it('warns and continues when the status cannot be read', async () => {
      const world = new FloorWorld({ stored: 900, statusUnavailable: true });
      await expect(
        runAppBuildFloorCommand({ action: 'emergency-guard' }, world.deps({})),
      ).resolves.toBeNull();
      expect(world.logs.join('\n')).toContain('continuing without the App build floor check');
    });
  });

  describe('Production Release check of the App build the PRO Worker requires', () => {
    function check(requiredAppBuild: number | null) {
      return { action: 'pro-room-guard', requiredAppBuild } as const;
    }

    function statusReads(world: FloorWorld) {
      return world.requests.filter(
        (request) => new URL(request.url).pathname === APP_BUILD_FLOOR_PUBLIC_STATUS_PATH,
      );
    }

    it('skips without a request while the PRO Worker requires no App build', async () => {
      const world = new FloorWorld({ stored: 787, liveBuild: 793 });
      await expect(runAppBuildFloorCommand(check(null), world.deps({}))).resolves.toBeNull();
      expect(world.requests).toEqual([]);
      expect(world.logs.join('\n')).toContain('requires no App build');
    });

    it('passes when the stored and the effective floor reach the required build', async () => {
      const world = new FloorWorld({ stored: 794, revision: 3, liveBuild: 795 });
      await expect(runAppBuildFloorCommand(check(794), world.deps({}))).resolves.toBeNull();
      // Read-only: one public status read, no token, no change, no proof.
      expect(world.requests.map((request) => new URL(request.url).pathname)).toEqual([
        APP_BUILD_FLOOR_PUBLIC_STATUS_PATH,
      ]);
      expect(world.tokenRequests()).toHaveLength(0);
      expect(world.signalingProbes).toEqual([]);
      expect(world.revision).toBe(3);
      expect(world.time).toBe(T0);
      expect(world.logs.join('\n')).toContain('stored 794 and effective 794 reach build 794');
    });

    it('stops at once when the stored floor is below the required build', async () => {
      const world = new FloorWorld({ stored: 793, liveBuild: 794 });
      await expect(runAppBuildFloorCommand(check(794), world.deps({}))).rejects.toThrow(
        'The stored App build floor 793 is below build 794, which the PRO Worker of this release requires',
      );
      expect(statusReads(world)).toHaveLength(1);
      expect(world.time).toBe(T0);
    });

    it('stops at once when the effective floor is below the required build', async () => {
      // The live App reports build 793, so the entry gates enforce 793.
      const world = new FloorWorld({ stored: 794, liveBuild: 793 });
      await expect(runAppBuildFloorCommand(check(794), world.deps({}))).rejects.toThrow(
        'The effective App build floor 793 is below build 794, which the PRO Worker of this release requires',
      );
      expect(statusReads(world)).toHaveLength(1);
      expect(world.time).toBe(T0);
    });

    it('waits for a new App report while the effective floor is 0, then passes', async () => {
      const world = new FloorWorld({ stored: 794, liveBuild: 794 });
      // The last App report is more than five minutes old: nothing is enforced.
      world.reportedAt = T0 - 360_000;
      expect(world.effective()).toBe(0);
      await expect(runAppBuildFloorCommand(check(794), world.deps({}))).resolves.toBeNull();
      expect(world.logs.join('\n')).toContain('waiting for a new App report');
      // The minute cron reported at the next minute, 30 s after the first read.
      expect(world.time - T0).toBe(30_000);
    });

    it('stops when the effective floor is still 0 after the App report wait', async () => {
      const world = new FloorWorld({ stored: 794, liveBuild: 794, cron: false });
      world.reportedAt = T0 - 360_000;
      await expect(runAppBuildFloorCommand(check(794), world.deps({}))).rejects.toThrow(
        'The effective App build floor stayed 0',
      );
      expect(world.time - T0).toBeGreaterThanOrEqual(APP_BUILD_FLOOR_CRON_REPORT_TIMEOUT_MS);
    });

    it('stops when the status stays unreadable through the re-reads', async () => {
      const world = new FloorWorld({ stored: 794, liveBuild: 794, statusUnavailable: true });
      await expect(runAppBuildFloorCommand(check(794), world.deps({}))).rejects.toThrow(
        /could not be read within 30 s.*HTTP 503 \(APP_BUILD_FLOOR_UNAVAILABLE\)/u,
      );
      expect(statusReads(world).length).toBeGreaterThan(1);
      expect(world.time - T0).toBeGreaterThanOrEqual(30_000);
    });

    it('passes once a failing status read recovers within the re-reads', async () => {
      const world = new FloorWorld({ stored: 794, liveBuild: 794 });
      const deps = world.deps({});
      const fetcher = deps.fetcher;
      let failures = 2;
      deps.fetcher = async (input, init) => {
        if (failures > 0 && new URL(input).pathname === APP_BUILD_FLOOR_PUBLIC_STATUS_PATH) {
          failures -= 1;
          return json({ minAppBuild: 794 }, 200);
        }
        return fetcher(input, init);
      };
      await expect(runAppBuildFloorCommand(check(794), deps)).resolves.toBeNull();
      expect(failures).toBe(0);
      expect(world.time - T0).toBeGreaterThan(0);
      expect(world.time - T0).toBeLessThan(30_000);
    });
  });

  it('formats unknown values in the summary', () => {
    expect(
      formatAppBuildFloorSummary(
        {
          minAppBuild: 0,
          effectiveMinAppBuild: 0,
          revision: 0,
          updatedAt: null,
          liveAppBuild: null,
          reportedLiveAppBuild: null,
          reportedAt: null,
          state: null,
        },
        null,
      ),
    ).toBe(
      'App build floor: stored 0, effective 0, revision 0, updated never; ' +
        'live App unreadable, reported none; client read unreadable',
    );
  });
});

function workflowStep(workflow: string, name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const end = workflow.indexOf('\n      - name:', start + 1);
  return workflow.slice(start, end < 0 ? undefined : end);
}

describe('App build floor workflows', () => {
  const release = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
  const floor = readFileSync(resolve('.github/workflows/app-build-floor.yml'), 'utf8');

  it('offers the release raise as an opt-in for App releases only', () => {
    const inputs = release.slice(release.indexOf('inputs:'), release.indexOf('\npermissions:'));
    expect(inputs).toMatch(
      /raise_app_build_floor:\n\s+description: [^\n]+\n\s+required: true\n\s+default: false\n\s+type: boolean/u,
    );
    const validation = workflowStep(release, 'Validate release options');
    expect(validation).toContain('inputs.raise_app_build_floor');
    expect(validation).toContain(`"\${{ inputs.target }}" != "app"`);
    expect(validation).toContain(`"\${{ inputs.target }}" != "all"`);
  });

  it('lets only the deploy job mint an OIDC token', () => {
    const top = release.slice(release.indexOf('\npermissions:'), release.indexOf('\njobs:'));
    expect(top).not.toContain('id-token');
    const deploy = release.slice(release.indexOf('\n  deploy:'), release.indexOf('\n  recovery:'));
    expect(deploy).toMatch(
      /\n {4}permissions:\n {6}actions: read\n {6}contents: read\n {6}id-token: write\n/u,
    );
    const validate = release.slice(
      release.indexOf('\n  validate:'),
      release.indexOf('\n  deploy:'),
    );
    expect(validate).not.toContain('id-token');
  });

  it('runs the trusted jobs as their own steps, so workflow_ref names them', () => {
    // The App Worker matches workflow_ref and refuses a token minted inside a
    // reusable workflow (a job_workflow_ref naming another workflow).
    const deploy = release.slice(release.indexOf('\n  deploy:'), release.indexOf('\n  recovery:'));
    expect(deploy).toMatch(/\n {4}steps:\n/u);
    expect(deploy).not.toMatch(/\n {4}uses:/u);
    const floorJob = floor.slice(floor.indexOf('\n  floor:'));
    expect(floorJob).toMatch(/\n {4}steps:\n/u);
    expect(floorJob).not.toMatch(/\n {4}uses:/u);
    expect(floor).not.toContain('workflow_call');
    // The one reusable workflow the release calls mints no token.
    const recovery = readFileSync(resolve('.github/workflows/release-recovery.yml'), 'utf8');
    expect(recovery).toContain('workflow_call:');
    expect(recovery).not.toContain('id-token');
  });

  it('raises only after the production commit marker is persisted', () => {
    const step = workflowStep(release, 'Raise App build floor to the released build');
    expect(step).toContain('id: app_build_floor_raise');
    expect(step).toContain(
      "if: success() && inputs.raise_app_build_floor && steps.production_commit.outputs.committed == 'true'",
    );
    expect(step).toContain('run: node scripts/app-build-floor.mts raise');
    expect(step).not.toContain('secrets.');
    const commit = release.indexOf('- name: Mark coherent production candidate committed');
    const marker = release.indexOf('- name: Persist coherent production commit marker');
    const raise = release.indexOf('- name: Raise App build floor to the released build');
    const firstRecovery = release.indexOf('- name: Assess R2 recovery constraints');
    expect(commit).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(commit);
    expect(raise).toBeGreaterThan(marker);
    expect(firstRecovery).toBeGreaterThan(raise);
    // A failed raise never triggers rollback: recovery keys on the marker.
    expect(release).toContain("needs.deploy.outputs.production_committed != 'true'");
    expect(workflowStep(release, 'Release summary')).toContain(
      "App build floor raise: \\`${{ steps.app_build_floor_raise.outcome || 'not-requested' }}\\`",
    );
  });

  it('checks the App build the PRO Worker requires before a PRO release changes anything', () => {
    const step = workflowStep(release, 'Check the App build floor the PRO Worker requires');
    expect(step).toContain('id: pro_room_app_build_floor_check');
    expect(step).toContain("if: inputs.target == 'pro-room' || inputs.target == 'all'");
    // Its own budget: the status re-reads and the App report wait fit in it.
    expect(step).toMatch(/\n {8}timeout-minutes: 10\n/u);
    // The value lives in this workflow, outside every runtime path list; empty
    // means the PRO Worker requires no App build.
    expect(step).toMatch(/\n {10}MXQR_PRO_ROOM_REQUIRED_APP_BUILD: '(?:[1-9]\d*)?'\n/u);
    expect(step).toContain('run: node scripts/app-build-floor.mts pro-room-guard');
    expect(step).not.toContain('secrets.');
    expect(step).not.toContain('continue-on-error');

    // Read-only, beside the partial-release compatibility check: after Node and
    // the dependencies, before the recovery checkpoint, the mutation
    // authorization and the room-code fence, so a stop changes nothing and
    // starts no recovery.
    const deploy = release.slice(release.indexOf('\n  deploy:'), release.indexOf('\n  recovery:'));
    const at = (name: string): number => {
      const index = deploy.indexOf(`\n      - name: ${name}\n`);
      expect(index, name).toBeGreaterThan(-1);
      return index;
    };
    const checkStep = at('Check the App build floor the PRO Worker requires');
    expect(checkStep).toBeGreaterThan(at('Install dependencies with pinned npm'));
    expect(checkStep).toBeGreaterThan(at('Verify partial release dependency compatibility'));
    for (const later of [
      'Capture immutable Worker and R2 recovery checkpoint',
      'Authorize production mutations from persisted checkpoint',
      'Fence room-code reuse during dependency rollout',
      'Deploy and record PRO room Worker',
    ]) {
      expect(checkStep, later).toBeLessThan(at(later));
    }
    expect(workflowStep(release, 'Release summary')).toContain(
      "PRO App build floor check: \\`${{ steps.pro_room_app_build_floor_check.outcome || 'not-requested' }}\\`",
    );
  });

  it('runs the standalone floor workflow on main in the release concurrency group', () => {
    expect(floor).toMatch(/\non:\n {2}workflow_dispatch:\n/u);
    expect(floor).not.toMatch(/\n {2}(?:push|pull_request|schedule|workflow_run):/u);
    for (const option of ['status', 'check', 'set', 'lower']) {
      expect(floor).toContain(`          - ${option}\n`);
    }
    expect(floor).toContain(
      'concurrency:\n  group: musixquare-production-release\n  cancel-in-progress: false',
    );
    expect(floor).toContain("if: github.ref == 'refs/heads/main'");
    expect(floor).toMatch(/environment:\n\s+name: production/u);
    expect(floor).toMatch(/permissions:\n {6}contents: read\n {6}id-token: write\n/u);
    expect(floor).toContain('permissions:\n  contents: read\n');
    expect(floor).toContain(
      'node scripts/app-build-floor.mts "$FLOOR_ACTION" "$FLOOR_MIN_APP_BUILD"',
    );
    expect(floor).toContain('MXQR_APP_BUILD_FLOOR_REASON: ${{ inputs.reason }}');
    expect(floor).not.toContain('secrets.');
    // Inputs reach the script only through the environment, never the shell text.
    const runBlocks = floor.match(/run: [|]\n(?: {10}[^\n]*\n)+/gu) ?? [];
    expect(runBlocks.length).toBeGreaterThan(0);
    for (const block of runBlocks) expect(block).not.toContain('${{');
    for (const action of floor.match(/uses: [^\n]+/gu) ?? []) {
      expect(action).toMatch(/@[0-9a-f]{40} # v/u);
      expect(release).toContain(action);
    }
  });

  it('names the floor workflow that the App Worker OIDC policy trusts', () => {
    const appWorker = readFileSync(resolve('cloudflare/app-worker.ts'), 'utf8');
    expect(appWorker).toContain(
      "'hiefny/MUSIXQUARE/.github/workflows/app-build-floor.yml@refs/heads/main'",
    );
    expect(appWorker).toContain(
      "'hiefny/MUSIXQUARE/.github/workflows/release.yml@refs/heads/main'",
    );
  });
});

class FakeProbeSocket extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  terminated = 0;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  terminate(): void {
    this.terminated += 1;
  }
}

describe('App build floor Signaling probe', () => {
  function startProbe(appBuild = 784) {
    const socket = new FakeProbeSocket();
    const outcome = runSignalingProbe(socket, appBuild);
    socket.emit('open');
    return { socket, outcome };
  }

  function frame(value: Record<string, unknown>): Buffer {
    return Buffer.from(JSON.stringify(value));
  }

  it('sends one host-auth with the build and reports the exact refusal and close', async () => {
    const { socket, outcome } = startProbe(784);
    expect(socket.sent).toHaveLength(1);
    // The Signaling Worker requires the desired PIN ('' for none) and its
    // mutation ID before it reads the build (old-version removal W-3).
    expect(socket.sent[0]).toMatchObject({
      type: 'host-auth',
      appBuild: 784,
      desiredRoomPassword: '',
      pinMutationId: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/),
    });
    expect(Object.keys(socket.sent[0] ?? {}).sort()).toEqual([
      'appBuild',
      'desiredRoomPassword',
      'pinMutationId',
      'secret',
      'type',
    ]);
    socket.emit(
      'message',
      frame({
        type: 'error',
        errorType: 'app-update-required',
        message: 'APP_UPDATE_REQUIRED',
        minAppBuild: 785,
      }),
    );
    socket.emit('close', 1008, Buffer.from('APP_UPDATE_REQUIRED'));
    await expect(outcome).resolves.toEqual({
      outcome: 'below-floor',
      minAppBuild: 785,
      closeCode: 1008,
      closeReason: 'APP_UPDATE_REQUIRED',
    });
    expect(socket.terminated).toBe(1);
  });

  it('reports an admission at once and closes the probe room', async () => {
    const { socket, outcome } = startProbe();
    socket.emit('message', frame({ type: 'peer-open', roomId: '123456' }));
    await expect(outcome).resolves.toEqual({ outcome: 'admitted' });
    expect(socket.terminated).toBe(1);
  });

  it('tells an invalid first frame apart from any other refusal', async () => {
    const invalid = startProbe();
    invalid.socket.emit(
      'message',
      frame({ type: 'error', errorType: 'invalid-id', message: 'HOST_AUTH_FIRST_FRAME_INVALID' }),
    );
    invalid.socket.emit('close', 1008, Buffer.from('HOST_AUTH_FIRST_FRAME_INVALID'));
    await expect(invalid.outcome).resolves.toEqual({ outcome: 'invalid-frame' });

    const silent = startProbe();
    silent.socket.emit('message', Buffer.from('not json'));
    silent.socket.emit('close', 1006, Buffer.alloc(0));
    await expect(silent.outcome).resolves.toEqual({ outcome: 'refused' });
  });

  it('fails on an upgrade refused over HTTP and on silence', async () => {
    const socket = new FakeProbeSocket();
    const resume = vi.fn();
    const refused = runSignalingProbe(socket, 784);
    socket.emit('unexpected-response', {}, { statusCode: 503, resume });
    await expect(refused).rejects.toThrow('HTTP 503');
    expect(resume).toHaveBeenCalledOnce();
    expect(socket.terminated).toBe(1);

    vi.useFakeTimers();
    try {
      const quiet = new FakeProbeSocket();
      const timedOut = runSignalingProbe(quiet, 784).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(String(await timedOut)).toContain('timed out');
      expect(quiet.terminated).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
