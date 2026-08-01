export const INITIAL_PRO_ROOM_GENERATION = 0;
export const MAX_PRO_ROOM_GENERATION = Number.MAX_SAFE_INTEGER;

const PRO_ROOM_CODE_RE = /^0\d{5}$/;

export function isProRoomGeneration(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= INITIAL_PRO_ROOM_GENERATION &&
    value <= MAX_PRO_ROOM_GENERATION
  );
}

export function normalizeProRoomGeneration(value) {
  return isProRoomGeneration(value) ? value : null;
}

export function proRoomObjectName(roomCode, roomGeneration) {
  if (!PRO_ROOM_CODE_RE.test(roomCode || '') || !isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid PRO room generation address');
  }
  return `${roomCode}:generation:${roomGeneration}`;
}

export function proRoomMediaPrefix(roomCode, roomGeneration) {
  if (!PRO_ROOM_CODE_RE.test(roomCode || '') || !isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid PRO room generation address');
  }
  return `pro-room-incarnations/${roomCode}/generation-${roomGeneration}`;
}

export function proRoomGenerationHeaderValue(roomGeneration) {
  if (!isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid PRO room generation');
  }
  return String(roomGeneration);
}
