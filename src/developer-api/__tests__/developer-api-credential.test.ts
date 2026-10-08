import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkDeveloperMutationCredential,
  developerMutationScopes,
} from '../../../cloudflare/developer-api-credential.ts';
import { developerApiScopes } from '../../../cloudflare/developer-api-worker.ts';

const nowMs = 1_791_504_000_000;
const keyId = 'A'.repeat(16);
const roomCode = '000001';

function fixture(overrides: Record<string, unknown> = {}) {
  const row = {
    key_id: keyId,
    room_code: roomCode,
    room_generation: 3,
    authority_epoch: 2,
    status: 'active',
    revoked_at: null,
    expires_at: nowMs + 60_000,
    scope_mask: 255,
    ...overrides,
  };
  const first = vi.fn(async (): Promise<unknown> => row);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  const database = { prepare };
  const check = (scope: number = developerMutationScopes.queue) =>
    checkDeveloperMutationCredential(database, keyId, roomCode, 3, 2, scope);
  return { check, database, row, first, bind, prepare };
}

afterEach(() => vi.useRealTimers());

describe('Developer mutation credential policy', () => {
  it('uses the same scope values as the public API', () => {
    expect(developerMutationScopes).toEqual({
      playback: developerApiScopes['playback:control'],
      effects: developerApiScopes['effects:control'],
      queue: developerApiScopes['queue:write'],
      media: developerApiScopes['media:upload'] | developerApiScopes['queue:write'],
    });
  });

  it('admits an active scoped credential for its exact room incarnation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const current = fixture();
    await expect(current.check()).resolves.toBeNull();
    expect(current.bind).toHaveBeenCalledWith(keyId, roomCode, 3);
  });

  it.each([
    { status: 'revoked', revoked_at: nowMs - 1 },
    { revoked_at: nowMs - 1 },
    { expires_at: nowMs },
    { expires_at: nowMs - 1 },
    { expires_at: Number.NaN },
    { key_id: 'B'.repeat(16) },
    { room_code: '000002' },
    { room_generation: 2 },
    { authority_epoch: 1 },
    { scope_mask: -1 },
  ])('rejects an inactive or mismatched credential: %j', async (row) => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    await expect(fixture(row).check()).resolves.toBe('UNAUTHORIZED');
  });

  it('checks expiry against the time the lookup finishes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const current = fixture();
    current.first.mockImplementation(async () => {
      vi.setSystemTime(nowMs + 60_000);
      return current.row;
    });
    await expect(current.check()).resolves.toBe('UNAUTHORIZED');
  });

  it('requires both upload and queue scopes for media changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const current = fixture({ scope_mask: developerApiScopes['media:upload'] });
    await expect(current.check(developerMutationScopes.media)).resolves.toBe('FORBIDDEN');
  });

  it('fails closed on missing credentials or an unavailable database', async () => {
    const current = fixture();
    current.first.mockResolvedValueOnce(null);
    await expect(current.check()).resolves.toBe('UNAUTHORIZED');
    current.first.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(current.check()).resolves.toBe('BACKEND_UNAVAILABLE');
    await expect(
      checkDeveloperMutationCredential(undefined, keyId, roomCode, 3, 2, 16),
    ).resolves.toBe('BACKEND_UNAVAILABLE');
  });
});
