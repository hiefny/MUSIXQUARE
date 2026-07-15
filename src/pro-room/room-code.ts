const PRO_ROOM_CODE_RE = /^0\d{5}$/;
const PRO_ROOM_PIN_RE = /^\d{8}$/;

export const INITIAL_PRO_ROOM_CODES = ['000000', '000001'] as const;

export type InitialProRoomCode = (typeof INITIAL_PRO_ROOM_CODES)[number];

/**
 * PRO rooms occupy the 000000-099999 range. Standard ephemeral sessions are
 * generated only in the 100000-999999 range, so the two namespaces can never
 * collide even when a client is offline or running an older app build.
 */
export function isProRoomCode(value: unknown): value is string {
  return typeof value === 'string' && PRO_ROOM_CODE_RE.test(value);
}

export function isInitialProRoomCode(value: unknown): value is InitialProRoomCode {
  return isProRoomCode(value) && (INITIAL_PRO_ROOM_CODES as readonly string[]).includes(value);
}

/**
 * Temporary bootstrap PIN required by the product contract. It is never a
 * standalone room credential: activation also requires the owner-only,
 * one-time claim token issued by the PRO room backend.
 */
export function deriveTemporaryProRoomPin(roomCode: string): string {
  if (!isProRoomCode(roomCode)) throw new Error('Invalid PRO room code');
  return roomCode.padStart(8, '0');
}

export function normalizeProRoomPin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D+/g, '').slice(0, 8);
  return PRO_ROOM_PIN_RE.test(digits) ? digits : null;
}

export function formatProRoomPin(value: string): string {
  const pin = normalizeProRoomPin(value);
  if (!pin) throw new Error('Invalid PRO room PIN');
  return `${pin.slice(0, 4)}-${pin.slice(4)}`;
}
