import { describe, expect, it, vi } from 'vitest';

import {
  readDeveloperApiAdminPepper,
  syncDeveloperApiAdminPepper,
} from '../../../scripts/sync-developer-api-admin-secret.mts';

describe('Developer API admin secret sync', () => {
  it('prefers the environment and never reads the local secret file', () => {
    const readFile = vi.fn();
    const pepper = readDeveloperApiAdminPepper({
      env: { MXQR_DEVELOPER_API_KEY_PEPPER: 'e'.repeat(64) },
      readFile,
    });

    expect(pepper).toBe('e'.repeat(64));
    expect(readFile).not.toHaveBeenCalled();
  });

  it('falls back to the ignored local secret document', () => {
    const pepper = readDeveloperApiAdminPepper({
      env: {},
      secretFile: 'private.json',
      readFile: vi.fn(() => JSON.stringify({ developerApiKeyPepper: 'l'.repeat(64) })),
    });

    expect(pepper).toBe('l'.repeat(64));
  });

  it('rejects malformed local JSON shapes instead of coercing secret material', () => {
    expect(() =>
      readDeveloperApiAdminPepper({
        env: {},
        secretFile: 'private.json',
        readFile: vi.fn(() =>
          JSON.stringify({ developerApiKeyPepper: ['not-a-string'.repeat(8)] }),
        ),
      }),
    ).toThrow('does not contain a valid developerApiKeyPepper');
  });

  it('pipes the secret to Wrangler without placing it in arguments or output', () => {
    const execute = vi.fn();
    const write = vi.fn();
    syncDeveloperApiAdminPepper({
      env: {
        MXQR_DEVELOPER_API_KEY_PEPPER: 's'.repeat(64),
        npm_execpath: 'C:\\node\\npm-cli.js',
      },
      execute,
      stdout: { write },
    });

    const [executable, args, options] = execute.mock.calls[0];
    expect(executable).toBe(process.execPath);
    expect(args[0]).toBe('C:\\node\\npm-cli.js');
    expect(args).toContain('MXQR_DEVELOPER_API_KEY_PEPPER');
    expect(JSON.stringify(args)).not.toContain('s'.repeat(64));
    expect(options.input).toBe(`${'s'.repeat(64)}\n`);
    expect(write.mock.calls.flat().join('')).not.toContain('s'.repeat(64));
  });

  it('requires the npm entrypoint so Windows never spawns npm.cmd directly', () => {
    expect(() =>
      syncDeveloperApiAdminPepper({
        env: { MXQR_DEVELOPER_API_KEY_PEPPER: 's'.repeat(64) },
        execute: vi.fn(),
        stdout: { write: vi.fn() },
      }),
    ).toThrow('npm run developer-api:admin-secret:sync');
  });

  it('redacts child-process failures that may contain the piped secret', () => {
    const secret = 's'.repeat(64);
    expect(() =>
      syncDeveloperApiAdminPepper({
        env: {
          MXQR_DEVELOPER_API_KEY_PEPPER: secret,
          npm_execpath: 'C:\\node\\npm-cli.js',
        },
        execute: () => {
          throw new Error(`failed input: ${secret}`);
        },
        stdout: { write: vi.fn() },
      }),
    ).toThrow('Failed to sync MXQR_DEVELOPER_API_KEY_PEPPER');
    try {
      syncDeveloperApiAdminPepper({
        env: {
          MXQR_DEVELOPER_API_KEY_PEPPER: secret,
          npm_execpath: 'C:\\node\\npm-cli.js',
        },
        execute: () => {
          throw new Error(`failed input: ${secret}`);
        },
        stdout: { write: vi.fn() },
      });
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(secret);
    }
  });
});
