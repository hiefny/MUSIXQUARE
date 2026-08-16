export const INITIAL_PRO_ROOM_GENERATION = 0;
export const MAX_PRO_ROOM_GENERATION = Number.MAX_SAFE_INTEGER;

const PRO_ROOM_CODE_RE = /^0\d{5}$/;

export function isProRoomGeneration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= INITIAL_PRO_ROOM_GENERATION &&
    value <= MAX_PRO_ROOM_GENERATION
  );
}

export function normalizeProRoomGeneration(value: unknown): number | null {
  return isProRoomGeneration(value) ? value : null;
}

export function proRoomObjectName(
  roomCode: string | null | undefined,
  roomGeneration: unknown,
): string {
  if (!PRO_ROOM_CODE_RE.test(roomCode || '') || !isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid PRO room generation address');
  }
  return `${roomCode}:generation:${roomGeneration}`;
}

export function proRoomMediaPrefix(
  roomCode: string | null | undefined,
  roomGeneration: unknown,
): string {
  if (!PRO_ROOM_CODE_RE.test(roomCode || '') || !isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid PRO room generation address');
  }
  return `pro-room-incarnations/${roomCode}/generation-${roomGeneration}`;
}

export function proRoomGenerationHeaderValue(roomGeneration: unknown): string {
  if (!isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid PRO room generation');
  }
  return String(roomGeneration);
}
