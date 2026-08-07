import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ProGrantCampaignCliError,
  classifyProGrantRoomInventory,
  createProGrantAdminClient,
  createProGrantRoomLabel,
  expandProGrantRoomSelection,
  generateProGrantVoucherCode,
  parseProGrantCampaignCommand,
  reserveProGrantArtifact,
  runProGrantCampaignCli,
} from '../../../scripts/pro-grant-campaign.mjs';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mxqr-pro-grants-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('PRO grant campaign operator CLI', () => {
  it('expands exact room selections and defaults mutations to dry-run', () => {
    expect(expandProGrantRoomSelection('000100-000102,000105')).toEqual([
      '000100',
      '000101',
      '000102',
      '000105',
    ]);
    expect(
      parseProGrantCampaignCommand([
        'create',
        '--slug',
        'asamo-0',
        '--title',
        'MUSIXQUARE 아사모 이벤트',
        '--rooms',
        '000100-000149',
      ]),
    ).toMatchObject({
      command: 'create',
      slug: 'asamo-0',
      apply: false,
      perAccountLimit: 1,
      roomCodes: expect.arrayContaining(['000100', '000149']),
    });
    expect(() => expandProGrantRoomSelection('000149-000100')).toThrow(ProGrantCampaignCliError);
    expect(() => expandProGrantRoomSelection('100000')).toThrow(ProGrantCampaignCliError);
    expect(() => expandProGrantRoomSelection('000100,000100')).toThrow(ProGrantCampaignCliError);
  });

  it('generates a human-readable 100-bit Crockford code from 13 CSPRNG bytes', () => {
    const randomBytes = vi.fn((size: number) => Buffer.from([...Array(size).keys()]));
    const code = generateProGrantVoucherCode(randomBytes);
    expect(randomBytes).toHaveBeenCalledWith(13);
    expect(code).toMatch(/^MXQ(?:-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    expect(code.replaceAll('-', '').slice(3)).toHaveLength(20);
    expect(code).not.toMatch(/[ILOU]/);
  });

  it('reports rooms needing provisioning without minting or transmitting transient vouchers', async () => {
    const requests: Array<{ path: string; options?: any }> = [];
    let output = '';
    let randomCall = 0;
    const randomBytes = vi.fn((size: number) => Buffer.alloc(size, ++randomCall));
    const summary = await runProGrantCampaignCli({
      argv: [
        'create',
        '--slug',
        'asamo-0',
        '--title',
        'MUSIXQUARE 아사모 이벤트',
        '--rooms',
        '000100-000101',
      ],
      client: {
        request: vi.fn(async (path: string, options?: any) => {
          requests.push({ path, options });
          return path === '/api/admin/pro-rooms'
            ? { rooms: [] }
            : { dryRun: true, campaign: { slug: 'asamo-0', status: 'draft' } };
        }),
      },
      randomBytes,
      stdout: { write: (value: string) => (output += value) },
    });
    expect(summary).toMatchObject({
      mode: 'dry-run',
      roomCount: 2,
      canApply: true,
      roomInventory: { readyCount: 0, needsProvisioningCount: 2, unavailableCount: 0 },
    });
    expect(randomBytes).toHaveBeenCalledTimes(1);
    expect(randomBytes).toHaveBeenNthCalledWith(1, 16);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.path)).toEqual([
      '/api/admin/pro-grants/campaigns',
      '/api/admin/pro-rooms',
    ]);
    expect(requests.some((request) => request.options?.body?.vouchers)).toBe(false);
    expect(output).not.toMatch(/MXQ-/);
  });

  it('classifies exact room incarnations and derives stable operator labels', () => {
    expect(
      classifyProGrantRoomInventory(
        {
          rooms: [
            {
              roomCode: '000100',
              roomGeneration: 3,
              status: 'registered',
              activationState: 'unactivated',
            },
            {
              roomCode: '000101',
              roomGeneration: 1,
              status: 'registered',
              activationState: 'active',
            },
          ],
        },
        ['000100', '000101', '000102'],
      ),
    ).toMatchObject({
      ready: [{ roomCode: '000100', roomGeneration: 3 }],
      needsProvisioning: [{ roomCode: '000102', reason: 'missing' }],
      unavailable: [
        {
          roomCode: '000101',
          roomGeneration: 1,
          status: 'registered',
          activationState: 'active',
        },
      ],
    });
    expect(createProGrantRoomLabel('asamo-0', '000100')).toBe('ASAMO 0 · 000100');
  });

  it('persists plaintext exclusively before mutation and prints only a secret-free summary', async () => {
    const root = temporaryRoot();
    let output = '';
    let issuedCode = '';
    let artifactPath = '';
    let randomCall = 0;
    const provisionedRooms = new Map<string, any>();
    const client = {
      request: vi.fn(async (path: string, options?: any) => {
        if (!artifactPath) {
          const files = await import('node:fs');
          const folder = join(root, 'release-artifacts', 'pro-grants');
          const names = files.readdirSync(folder);
          expect(names).toHaveLength(1);
          artifactPath = join(folder, names[0] as string);
          const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
          issuedCode = artifact.vouchers[0].code;
          expect(issuedCode).toMatch(/^MXQ-/);
        }
        if (path === '/api/admin/pro-rooms' && !options?.body) {
          return { rooms: [...provisionedRooms.values()] };
        }
        if (path === '/api/admin/pro-rooms' && options?.body) {
          const { roomCode, label } = options.body;
          const room = {
            roomCode,
            roomGeneration: 0,
            label,
            status: 'registered',
            activationState: 'unactivated',
          };
          provisionedRooms.set(roomCode, room);
          return { room };
        }
        if (path === '/api/admin/pro-grants/campaigns') {
          return { campaign: { id: `campaign_${'A'.repeat(22)}`, slug: 'asamo-0' } };
        }
        if (path.endsWith('/status')) return { campaign: { slug: 'asamo-0', status: 'active' } };
        const vouchers = options?.body?.vouchers;
        expect(vouchers?.[0]?.code).toBe(issuedCode);
        return {
          requestId: options.body.requestId,
          campaign: { slug: 'asamo-0' },
          count: 2,
          mappings: [
            {
              voucherId: `voucher_${'A'.repeat(22)}`,
              roomCode: '000100',
              roomGeneration: 0,
              status: 'available',
            },
            {
              voucherId: `voucher_${'B'.repeat(22)}`,
              roomCode: '000101',
              roomGeneration: 3,
              status: 'available',
            },
          ],
        };
      }),
    };

    const summary = await runProGrantCampaignCli({
      argv: [
        'create',
        '--slug',
        'asamo-0',
        '--title',
        'MUSIXQUARE 아사모 이벤트',
        '--rooms',
        '000100-000101',
        '--apply',
      ],
      root,
      client,
      randomBytes: (size: number) => {
        randomCall += 1;
        return Buffer.alloc(size, randomCall);
      },
      now: () => Date.parse('2026-08-08T00:00:00Z'),
      stdout: { write: (value: string) => (output += value) },
    });

    expect(summary).toMatchObject({ mode: 'apply', voucherCount: 2 });
    expect(artifactPath).not.toBe('');
    const artifactText = readFileSync(artifactPath, 'utf8');
    expect(artifactText).toContain(issuedCode);
    expect(output).not.toContain(issuedCode);
    expect(output).not.toMatch(/MXQ-/);
    expect(client.request).toHaveBeenCalledTimes(7);
    expect(
      client.request.mock.calls.filter(
        ([path, options]: any[]) => path === '/api/admin/pro-rooms' && options?.method === 'POST',
      ),
    ).toHaveLength(2);
  });

  it('replays the exact persisted operation without minting replacement codes', async () => {
    const root = temporaryRoot();
    const requestId = `batch_${'A'.repeat(22)}`;
    const code = 'MXQ-01234-56789-ABCDE-FGHJK';
    const artifact = reserveProGrantArtifact(root, null, 'asamo-0', requestId);
    artifact.write({
      format: 'mxqr-pro-grant-vouchers-v1',
      warning: 'secret',
      exportedAt: '2026-08-08T00:00:00.000Z',
      requestId,
      campaign: {
        slug: 'asamo-0',
        title: 'MUSIXQUARE 아사모 이벤트',
        startsAt: 1_786_147_200_000,
        endsAt: null,
        perAccountLimit: 1,
      },
      vouchers: [{ roomCode: '000100', code }],
    });
    let output = '';
    const client = {
      request: vi.fn(async (path: string, options?: any) => {
        if (path === '/api/admin/pro-rooms') {
          return {
            rooms: [
              {
                roomCode: '000100',
                roomGeneration: 4,
                label: 'ASAMO 0 · 000100',
                status: 'registered',
                activationState: 'active',
              },
            ],
          };
        }
        if (path.endsWith('/status')) return { campaign: { slug: 'asamo-0', status: 'active' } };
        if (path.endsWith('/vouchers')) {
          expect(options.body.vouchers).toEqual([{ roomCode: '000100', code }]);
          return {
            requestId,
            replayed: true,
            campaign: { slug: 'asamo-0' },
            count: 1,
            mappings: [
              {
                voucherId: `voucher_${'A'.repeat(22)}`,
                roomCode: '000100',
                roomGeneration: 4,
                status: 'available',
              },
            ],
          };
        }
        return { campaign: { slug: 'asamo-0' } };
      }),
    };
    const summary = await runProGrantCampaignCli({
      argv: ['apply', '--artifact', artifact.path],
      root,
      client,
      randomBytes: () => {
        throw new Error('replay must not mint randomness');
      },
      stdout: { write: (value: string) => (output += value) },
    });
    expect(summary).toMatchObject({ replaySafe: true, voucherCount: 1 });
    expect(output).not.toContain(code);
  });

  it('refuses overwrite and paths outside the ignored release artifact boundary', () => {
    const root = temporaryRoot();
    const requestId = `batch_${'A'.repeat(22)}`;
    const artifact = reserveProGrantArtifact(root, null, 'asamo-0', requestId);
    artifact.write({ ok: true });
    expect(() => reserveProGrantArtifact(root, artifact.path, 'asamo-0', requestId)).toThrow(
      /already exists/i,
    );
    expect(() =>
      reserveProGrantArtifact(root, 'voucher-export.json', 'asamo-0', requestId),
    ).toThrow(/under release-artifacts\/pro-grants/i);
  });

  it('never accepts voucher material from status endpoints', async () => {
    await expect(
      runProGrantCampaignCli({
        argv: ['status', '--slug', 'asamo-0'],
        client: {
          request: vi.fn(async () => ({ campaign: {}, codeDigest: 'forbidden' })),
        },
        stdout: { write: () => true },
      }),
    ).rejects.toThrow(/unexpectedly contained voucher material/i);
  });

  it('logs in with the admin password but never sends it to the grant endpoint', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/admin/login')) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `${'__Host-mxqr_admin'}=payload.signature; Secure; HttpOnly`,
          },
        });
      }
      return new Response(JSON.stringify({ campaign: { slug: 'asamo-0' } }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    });
    const client = createProGrantAdminClient({
      origin: 'https://musixquare.com',
      env: { MXQR_ADMIN_PASSWORD: 'operator-secret' },
      fetcher,
    });
    await client.request('/api/admin/pro-grants/campaigns/asamo-0/status');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init?.body).toContain('operator-secret');
    expect(calls[1]?.init?.body).toBeUndefined();
    expect((calls[1]?.init?.headers as Record<string, string>).Cookie).toBe(
      '__Host-mxqr_admin=payload.signature',
    );
  });

  it('fails closed when a voucher mutation response is cacheable', async () => {
    const client = createProGrantAdminClient({
      origin: 'https://musixquare.com',
      env: { MXQR_ADMIN_SESSION_COOKIE: 'payload.signature' },
      fetcher: vi.fn(async () => Response.json({ ok: true })),
    });
    await expect(
      client.request('/api/admin/pro-grants/campaigns/asamo-0/vouchers', {
        method: 'POST',
        body: {},
        sensitive: true,
      }),
    ).rejects.toThrow(/not marked no-store/i);
  });
});
