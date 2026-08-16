import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  formatProRoomActivationFragment,
  formatProRoomOwnerRecoveryFragment,
  parseProRoomClaimRequest,
  parseProRoomClaimRoomCode,
  runProRoomActivationClaimCli,
} from '../../../scripts/issue-pro-room-activation-claim.mjs';

const SECRET = 'offline-activation-secret'.padEnd(48, 's');
const CLAIM = `v1.${'a'.repeat(32)}.${'b'.repeat(43)}`;

describe('offline PRO room activation-claim CLI', () => {
  it('accepts only the generation-zero developer canary', () => {
    expect(parseProRoomClaimRoomCode(['000000'])).toBe('000000');
    for (const argv of [[], ['000001'], ['099999'], ['0'], ['000000', '000001']]) {
      expect(() => parseProRoomClaimRoomCode(argv)).toThrow(
        'Usage: npm run pro-room:issue-claim -- 000000 | --recovery 000000',
      );
    }
  });

  it('keeps activation as the default and requires an explicit recovery mode', () => {
    expect(parseProRoomClaimRequest(['000000'])).toEqual({
      mode: 'activation',
      roomCode: '000000',
    });
    expect(parseProRoomClaimRequest(['--recovery', '000000'])).toEqual({
      mode: 'recovery',
      roomCode: '000000',
    });
    for (const argv of [['recovery', '000000'], ['--recovery'], ['--recovery', '000001']]) {
      expect(() => parseProRoomClaimRequest(argv)).toThrow('Usage:');
    }
  });

  it('prints only an encoded fragment and never prints the environment secret', async () => {
    const write = vi.fn();
    const issueClaim = vi.fn(async (roomCode: string, secret: string) => {
      expect(roomCode).toBe('000000');
      expect(secret).toBe(SECRET);
      return CLAIM;
    });

    const fragment = await runProRoomActivationClaimCli({
      argv: ['000000'],
      env: { PRO_ROOM_ACTIVATION_SECRET: SECRET },
      stdout: { write },
      issueClaim,
    });

    expect(fragment).toBe(`#pro-claim=${CLAIM}`);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(`${fragment}\n`);
    expect(JSON.stringify(write.mock.calls)).not.toContain(SECRET);
  });

  it('fails closed without the environment secret before invoking the issuer', async () => {
    const issueClaim = vi.fn();
    const write = vi.fn();
    await expect(
      runProRoomActivationClaimCli({
        argv: ['000000'],
        env: {},
        stdout: { write },
        issueClaim,
      }),
    ).rejects.toThrow('PRO_ROOM_ACTIVATION_SECRET must be supplied through the environment');
    expect(issueClaim).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('prints only the recovery fragment when explicitly requested', async () => {
    const write = vi.fn();
    const issueClaim = vi.fn();
    const issueRecoveryClaim = vi.fn(async (roomCode: string, secret: string) => {
      expect(roomCode).toBe('000000');
      expect(secret).toBe(SECRET);
      return CLAIM;
    });

    const fragment = await runProRoomActivationClaimCli({
      argv: ['--recovery', '000000'],
      env: { PRO_ROOM_ACTIVATION_SECRET: SECRET },
      stdout: { write },
      issueClaim,
      issueRecoveryClaim,
    });

    expect(fragment).toBe(`#pro-recovery=${CLAIM}`);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(`${fragment}\n`);
    expect(issueClaim).not.toHaveBeenCalled();
    expect(JSON.stringify(write.mock.calls)).not.toContain(SECRET);
  });

  it('rejects malformed issuer output instead of allowing fragment injection', () => {
    expect(() => formatProRoomActivationFragment(`${CLAIM}&view=debug`)).toThrow(
      'Activation claim generation failed',
    );
    expect(() => formatProRoomOwnerRecoveryFragment(`${CLAIM}&view=debug`)).toThrow(
      'Owner recovery claim generation failed',
    );
  });

  it('runs the real CLI entrypoint against the standalone claim module', () => {
    const output = execFileSync(
      process.execPath,
      [resolve('scripts/issue-pro-room-activation-claim.mjs'), '000000'],
      {
        cwd: resolve('.'),
        encoding: 'utf8',
        env: { ...process.env, PRO_ROOM_ACTIVATION_SECRET: SECRET },
      },
    );

    expect(output.trim()).toMatch(/^#pro-claim=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(output).not.toContain(SECRET);
  });
});
