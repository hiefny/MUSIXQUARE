/**
 * The PIN record a PRO room stores for an entry password: PBKDF2-SHA-256
 * over the PIN, a NUL and the pepper, 100,000 iterations, 32 bytes, with a
 * fixed salt so a test run derives each record once.
 *
 * Activation starts every room without an entry password (the App's body
 * since 8.8.0). A fixture that needs a protected room writes this record in
 * place of the owner's first `POST /pin`, so the room's revisions and epochs
 * stay where activation left them.
 */
export interface StoredEntryPinRecord {
  salt: string;
  iterations: number;
  hash: string;
}

const records = new Map<string, Promise<StoredEntryPinRecord>>();

export function storedEntryPinRecord(pin: string, pepper: string): Promise<StoredEntryPinRecord> {
  const key = `${pin}\u0000${pepper}`;
  let record = records.get(key);
  if (!record) {
    record = (async () => {
      const salt = Buffer.from('fixture-pin-salt').toString('base64url');
      const material = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(`${pin}\u0000${pepper}`),
        'PBKDF2',
        false,
        ['deriveBits'],
      );
      const bits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          hash: 'SHA-256',
          salt: Buffer.from(salt, 'base64url'),
          iterations: 100_000,
        },
        material,
        256,
      );
      return { salt, iterations: 100_000, hash: Buffer.from(bits).toString('base64url') };
    })();
    records.set(key, record);
  }
  return record;
}

/**
 * Turns a just-activated room into a protected one, in memory and in its
 * stored core: the state an activation with a PIN left.
 */
export async function requireStoredEntryPin(
  room: Record<string, unknown>,
  storedCore: Record<string, unknown>,
  pin: string,
  pepper: string,
): Promise<void> {
  const record = await storedEntryPinRecord(pin, pepper);
  room.pin = structuredClone(record);
  room.passwordRequired = true;
  storedCore.pin = structuredClone(record);
  storedCore.passwordRequired = true;
}
