import { describe, expect, it, vi } from 'vitest';

import {
  DeveloperApiKeyCliError,
  parseDeveloperApiKeyCommand,
  runDeveloperApiKeyCli,
} from '../../../scripts/developer-api-key.mts';

describe('Developer API key CLI', () => {
  it('defaults to read-only access and accepts all room-bound v1 scopes explicitly', () => {
    expect(
      parseDeveloperApiKeyCommand([
        'issue',
        '--room',
        '000001',
        '--label',
        'Friend API',
        '--days',
        '30',
      ]),
    ).toEqual({
      command: 'issue',
      roomCode: '000001',
      label: 'Friend API',
      days: 30,
      scopes: ['room:read', 'playback:read', 'queue:read', 'effects:read'],
    });
    expect(
      parseDeveloperApiKeyCommand([
        'issue',
        '--room',
        '000001',
        '--label',
        'Friend full API',
        '--scopes',
        'room:read,playback:read,playback:control,queue:read,queue:write,media:upload,effects:read,effects:control',
      ]),
    ).toMatchObject({
      roomCode: '000001',
      scopes: [
        'room:read',
        'playback:read',
        'playback:control',
        'queue:read',
        'queue:write',
        'media:upload',
        'effects:read',
        'effects:control',
      ],
    });
    expect(() =>
      parseDeveloperApiKeyCommand([
        'issue',
        '--room',
        '000001',
        '--label',
        'Unknown scope',
        '--scopes',
        'admin:write',
      ]),
    ).toThrow(DeveloperApiKeyCliError);
    expect(() =>
      parseDeveloperApiKeyCommand(['issue', '--room', '000001', '--label', 'Friend & shell']),
    ).toThrow(DeveloperApiKeyCliError);
  });

  const now = 1_784_262_910_000;
  const keyId = 'A'.repeat(16);
  const apiKey = `mxqr_live_${keyId}.${'B'.repeat(43)}`;
  const requestId = '12345678-1234-4234-8234-123456789abc';
  const env = {
    CF_ACCESS_CLIENT_ID: 'fixture-access-id',
    CF_ACCESS_CLIENT_SECRET: 'fixture-access-secret',
    MXQR_ADMIN_PASSWORD: 'fixture-admin-password',
  };
  function fixture(
    overrides: {
      post?: (body: Record<string, unknown>, attempt: number) => Response | Promise<Response>;
      detail?: unknown;
      session?: boolean;
    } = {},
  ) {
    let output = '';
    let attempts = 0;
    const execute = vi.fn(() => []);
    const confirmation = (body: Record<string, unknown>) => ({
      roomCode: '000001',
      roomGeneration: 7,
      apiKey,
      key: {
        keyId,
        roomGeneration: 7,
        label: body.label,
        scopes: body.scopes,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + Number(body.days) * 86_400_000,
        revokedAt: null,
        lastUsedAt: null,
      },
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/login'))
        return Response.json(
          { ok: true },
          {
            headers: {
              'set-cookie': '__Host-mxqr_admin=fixture.signature; Path=/; Secure; HttpOnly',
            },
          },
        );
      if (init?.method === 'GET')
        return Response.json(
          overrides.detail ?? { roomCode: '000001', roomGeneration: 7, maxActiveKeys: 3, keys: [] },
        );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      attempts++;
      return overrides.post
        ? overrides.post(body, attempts)
        : Response.json(confirmation(body), {
            status: 201,
            headers: { 'cache-control': 'no-store' },
          });
    });
    const run = (scopes?: string) =>
      runDeveloperApiKeyCli({
        argv: [
          'issue',
          '--room',
          '000001',
          '--label',
          "Friend's API",
          '--days',
          '30',
          ...(scopes ? ['--scopes', scopes] : []),
        ],
        env: overrides.session
          ? {
              ...env,
              MXQR_ADMIN_PASSWORD: undefined,
              MXQR_ADMIN_SESSION_COOKIE: 'existing.signature',
            }
          : env,
        now: () => now,
        randomUUID: () => requestId,
        fetcher,
        execute,
        stdout: {
          write: (value) => {
            output += value;
          },
        },
      });
    return { run, fetcher, execute, confirmation, output: () => output };
  }

  it('issues through canonical admin authority without local pepper or D1 and prints once', async () => {
    const context = fixture();
    await expect(context.run()).resolves.toEqual({ apiKey, keyId });
    expect(context.execute).not.toHaveBeenCalled();
    expect(context.fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      'https://musixquare.com/api/admin/login',
      'https://musixquare.com/api/admin/pro-rooms/000001/api-keys',
      'https://musixquare.com/api/admin/pro-rooms/000001/api-keys',
    ]);
    for (const [, init] of context.fetcher.mock.calls) {
      expect(init?.redirect).toBe('error');
      expect(init?.cache).toBe('no-store');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('CF-Access-Client-Secret')).toBe(
        env.CF_ACCESS_CLIENT_SECRET,
      );
    }
    const post = context.fetcher.mock.calls[2]?.[1];
    expect(new Headers(post?.headers).get('X-MXQR-Admin-CSRF')).toBe('1');
    expect(new Headers(post?.headers).get('Cookie')).toBe('__Host-mxqr_admin=fixture.signature');
    expect(JSON.parse(String(post?.body))).toEqual({
      label: "Friend's API",
      days: 30,
      scopes: ['room:read', 'playback:read', 'queue:read', 'effects:read'],
      requestId,
      roomGeneration: 7,
    });
    expect(context.output().split(apiKey)).toHaveLength(2);
    expect(JSON.parse(context.output())).toMatchObject({ apiKey, keyId, roomGeneration: 7 });
    expect(context.output()).not.toContain(env.MXQR_ADMIN_PASSWORD);
  });

  it('supports an existing admin session and all scopes without reading D1', async () => {
    const context = fixture({ session: true });
    await context.run(
      'room:read,playback:read,playback:control,queue:read,queue:write,media:upload,effects:read,effects:control',
    );
    expect(context.fetcher).toHaveBeenCalledTimes(2);
    expect(context.execute).not.toHaveBeenCalled();
    expect(JSON.parse(context.output()).scopes).toHaveLength(8);
  });

  it('retries only a lost transport result using the same generation and request ID', async () => {
    let confirmation: ReturnType<ReturnType<typeof fixture>['confirmation']>;
    const context = fixture({
      post: (body, attempt) => {
        confirmation = context.confirmation(body);
        if (attempt === 1) throw new TypeError('fixture-secret-must-not-be-printed');
        return Response.json(confirmation, { headers: { 'cache-control': 'no-store' } });
      },
    });
    await context.run();
    const posts = context.fetcher.mock.calls
      .filter(([input]) => !String(input).endsWith('/login'))
      .slice(1);
    expect(posts).toHaveLength(2);
    expect(posts[0]?.[1]?.body).toBe(posts[1]?.[1]?.body);
    expect(context.output().split(apiKey)).toHaveLength(2);
    expect(context.output()).not.toContain('fixture-secret');
  });

  it.each([
    'generation',
    'key-generation',
    'key-id',
    'scopes',
    'days',
    'status',
    'extra',
    'cache',
    'http',
  ] as const)('does not print a key or retry an invalid %s confirmation', async (kind) => {
    const context = fixture({
      post: (body) => {
        const value = context.confirmation(body);
        if (kind === 'generation') value.roomGeneration = 8;
        if (kind === 'key-generation') value.key.roomGeneration = 8;
        if (kind === 'key-id') value.key.keyId = 'C'.repeat(16);
        if (kind === 'scopes') value.key.scopes = ['media:upload'];
        if (kind === 'days') value.key.expiresAt++;
        if (kind === 'status') value.key.status = 'revoked';
        if (kind === 'extra') Object.assign(value, { secret: 'unexpected' });
        if (kind === 'http')
          return Response.json(
            { error: 'PRO_ROOM_GENERATION_CONFLICT' },
            { status: 409, headers: { 'cache-control': 'no-store' } },
          );
        return Response.json(value, {
          headers: kind === 'cache' ? {} : { 'cache-control': 'no-store' },
        });
      },
    });
    await expect(context.run()).rejects.toBeInstanceOf(DeveloperApiKeyCliError);
    expect(context.output()).toBe('');
    expect(context.fetcher).toHaveBeenCalledTimes(3);
    expect(context.execute).not.toHaveBeenCalled();
  });

  it('rejects incorrect room detail before issuing', async () => {
    const context = fixture({
      detail: { roomCode: '000002', roomGeneration: 7, maxActiveKeys: 3, keys: [] },
    });
    await expect(context.run()).rejects.toThrow('incarnation could not be verified');
    expect(context.fetcher).toHaveBeenCalledTimes(2);
    expect(context.output()).toBe('');
  });

  it('requires Access and administrator authentication without falling back to local pepper', async () => {
    const fetcher = vi.fn();
    const execute = vi.fn();
    await expect(
      runDeveloperApiKeyCli({
        argv: ['issue', '--room', '000001', '--label', 'Fixture'],
        env: { MXQR_DEVELOPER_API_KEY_PEPPER: 'p'.repeat(32) },
        fetcher,
        execute,
      }),
    ).rejects.toThrow('CF_ACCESS_CLIENT_ID');
    expect(fetcher).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('revokes by public key id without requiring or printing the secret', async () => {
    const execute = vi.fn(() => [{ key_id: 'A'.repeat(16) }]);
    let output = '';
    await runDeveloperApiKeyCli({
      argv: ['revoke', '--id', 'A'.repeat(16)],
      env: {},
      now: () => 1_784_262_910_000,
      execute,
      stdout: { write: (value: string) => (output += value) },
    });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status = 'revoked'"));
    expect(output).toContain('"revoked":true');
    expect(output).not.toContain('mxqr_live_');
  });
});
