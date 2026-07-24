export const LEGACY_PRO_ROOM_GENERATION = 0;
export const MAX_PRO_ROOM_GENERATION = Number.MAX_SAFE_INTEGER;

const PRO_ROOM_CODE_RE = /^0\d{5}$/;

export function isProRoomGeneration(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= LEGACY_PRO_ROOM_GENERATION &&
    value <= MAX_PRO_ROOM_GENERATION
  );
}

export function normalizeProRoomGeneration(value) {
  return isProRoomGeneration(value) ? value : null;
}

export function proRoomObjectName(roomCode, roomGeneration = LEGACY_PRO_ROOM_GENERATION) {
  if (!PRO_ROOM_CODE_RE.test(roomCode || '') || !isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid PRO room generation address');
  }
  // Generation zero preserves every Durable Object created before reusable
  // room numbers existed. Later generations are separate objects, so their
  // state, alarms and permanent deletion tombstones can never be revived.
  return roomGeneration === LEGACY_PRO_ROOM_GENERATION
    ? roomCode
    : `${roomCode}:generation:${roomGeneration}`;
}

export function proRoomMediaPrefix(roomCode, roomGeneration = LEGACY_PRO_ROOM_GENERATION) {
  if (!PRO_ROOM_CODE_RE.test(roomCode || '') || !isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid PRO room generation address');
  }
  // Do not place reusable generations below `rooms/{roomCode}/`. Generation
  // zero's permanent repair sweep intentionally owns that entire legacy
  // prefix and would otherwise delete media belonging to a later room.
  return roomGeneration === LEGACY_PRO_ROOM_GENERATION
    ? `rooms/${roomCode}`
    : `pro-room-incarnations/${roomCode}/generation-${roomGeneration}`;
}

export function proRoomGenerationHeaderValue(roomGeneration) {
  if (!isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid PRO room generation');
  }
  return String(roomGeneration);
}
