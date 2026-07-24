import { describe, expect, it, vi } from 'vitest';

import {
  DeveloperApiKeyCliError,
  parseDeveloperApiKeyCommand,
  resolveCurrentProRoomGeneration,
  runDeveloperApiKeyCli,
} from '../../../scripts/developer-api-key.mjs';

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

  it('stores only a digest and emits the full random key exactly once', async () => {
    const sql: string[] = [];
    let randomCall = 0;
    let output = '';
    const result = await runDeveloperApiKeyCli({
      argv: ['issue', '--room', '000001', '--label', "Friend's API"],
      env: { MXQR_DEVELOPER_API_KEY_PEPPER: 'p'.repeat(32) },
      now: () => 1_784_262_910_000,
      randomBytes: (size: number) => {
        randomCall += 1;
        return Buffer.alloc(size, randomCall);
      },
      execute: (statement: string) => {
        sql.push(statement);
        const match = statement.match(/VALUES \('([^']+)'/);
        return [{ key_id: match?.[1] }];
      },
      resolveRoomGeneration: vi.fn(() => 7),
      stdout: { write: (value: string) => (output += value) },
    });
    expect(result.apiKey).toMatch(/^mxqr_live_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(
      output.match(new RegExp(result.apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')),
    ).toHaveLength(1);
    expect(sql).toHaveLength(1);
    expect(sql[0]).not.toContain(result.apiKey);
    expect(sql[0]).not.toContain(result.apiKey.split('.')[1] || 'missing-secret');
    expect(sql[0]).toContain("Friend''s API");
    expect(sql[0]).toContain('room_generation');
    expect(sql[0]).toMatch(/'000001', 7,/);
    expect(sql[0]).toContain(', 75,');
    expect(output).toContain('"roomGeneration": 7');
  });

  it('stores the complete v1 permission set as scope mask 255', async () => {
    let insert = '';
    await runDeveloperApiKeyCli({
      argv: [
        'issue',
        '--room',
        '000001',
        '--label',
        'Friend full API',
        '--scopes',
        'room:read,playback:read,playback:control,queue:read,queue:write,media:upload,effects:read,effects:control',
      ],
      env: { MXQR_DEVELOPER_API_KEY_PEPPER: 'p'.repeat(32) },
      randomBytes: (size: number) => Buffer.alloc(size, 7),
      execute: (statement: string) => {
        insert = statement;
        const match = statement.match(/VALUES \('([^']+)'/);
        return [{ key_id: match?.[1] }];
      },
      resolveRoomGeneration: vi.fn(() => 0),
      stdout: { write: () => true },
    });
    expect(insert).toContain(', 255,');
  });

  it('requires the same key pepper before generating any credential', async () => {
    const execute = vi.fn();
    await expect(
      runDeveloperApiKeyCli({
        argv: ['issue', '--room', '000001', '--label', 'Friend API'],
        env: {},
        execute,
        resolveRoomGeneration: vi.fn(),
      }),
    ).rejects.toThrow('MXQR_DEVELOPER_API_KEY_PEPPER');
    expect(execute).not.toHaveBeenCalled();
  });

  it('resolves only the current active registry incarnation before issuing', () => {
    const execute = vi.fn(() => [
      {
        room_code: '000001',
        room_generation: 7,
        status: 'registered',
        activation_state: 'active',
      },
    ]);
    expect(resolveCurrentProRoomGeneration('000001', execute)).toBe(7);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('FROM mxqr_pro_room_registry'));

    for (const row of [
      null,
      {
        room_code: '000001',
        room_generation: 7,
        status: 'decommissioned',
        activation_state: 'unactivated',
      },
      {
        room_code: '000001',
        room_generation: -1,
        status: 'registered',
        activation_state: 'active',
      },
    ]) {
      expect(() => resolveCurrentProRoomGeneration('000001', () => (row ? [row] : []))).toThrow(
        'current active PRO room incarnation',
      );
    }
  });

  it('removes the key without printing it when the registry generation changes mid-issue', async () => {
    const sql: string[] = [];
    const resolveRoomGeneration = vi.fn().mockReturnValueOnce(3).mockReturnValueOnce(4);
    let output = '';
    await expect(
      runDeveloperApiKeyCli({
        argv: ['issue', '--room', '000001', '--label', 'Racing API'],
        env: { MXQR_DEVELOPER_API_KEY_PEPPER: 'p'.repeat(32) },
        randomBytes: (size: number) => Buffer.alloc(size, 9),
        execute: (statement: string) => {
          sql.push(statement);
          const match = statement.match(/VALUES \('([^']+)'/);
          return match ? [{ key_id: match[1] }] : [];
        },
        resolveRoomGeneration,
        stdout: { write: (value: string) => (output += value) },
      }),
    ).rejects.toThrow('incarnation changed');
    expect(sql).toHaveLength(2);
    expect(sql[0]).toMatch(/'000001', 3,/);
    expect(sql[1]).toMatch(
      /DELETE FROM mxqr_developer_api_keys .*room_generation = 3 .*secret_digest = /,
    );
    expect(output).toBe('');
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
