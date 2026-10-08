/** Fresh authority check at the room's serialized mutation boundary. */
interface CredentialDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): { first(): Promise<unknown> };
  };
}

export const developerMutationScopes = Object.freeze({
  playback: 4,
  effects: 128,
  queue: 16,
  media: 32 | 16,
});

export async function checkDeveloperMutationCredential(
  database: CredentialDatabase | undefined,
  keyId: string,
  roomCode: string,
  roomGeneration: number,
  authorityEpoch: number,
  requiredScope: number,
): Promise<'UNAUTHORIZED' | 'FORBIDDEN' | 'BACKEND_UNAVAILABLE' | null> {
  if (!database?.prepare) return 'BACKEND_UNAVAILABLE';
  let value: unknown;
  try {
    value = await database
      .prepare(
        `SELECT key_id, room_code, room_generation, authority_epoch, status,
                revoked_at, expires_at, scope_mask
         FROM mxqr_developer_api_keys
         WHERE key_id = ?1 AND room_code = ?2 AND room_generation = ?3
         LIMIT 1`,
      )
      .bind(keyId, roomCode, roomGeneration)
      .first();
  } catch {
    return 'BACKEND_UNAVAILABLE';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'UNAUTHORIZED';
  const row = value as Record<string, unknown>;
  if (
    row.key_id !== keyId ||
    row.room_code !== roomCode ||
    row.room_generation !== roomGeneration ||
    row.authority_epoch !== authorityEpoch ||
    row.status !== 'active' ||
    row.revoked_at !== null ||
    typeof row.expires_at !== 'number' ||
    !Number.isSafeInteger(row.expires_at) ||
    row.expires_at <= Date.now() ||
    typeof row.scope_mask !== 'number' ||
    !Number.isSafeInteger(row.scope_mask) ||
    row.scope_mask < 0 ||
    row.scope_mask > 255
  ) {
    return 'UNAUTHORIZED';
  }
  return (row.scope_mask & requiredScope) === requiredScope ? null : 'FORBIDDEN';
}
