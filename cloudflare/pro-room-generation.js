export const INITIAL_PRO_ROOM_GENERATION = 0;
export const MAX_PRO_ROOM_GENERATION = Number.MAX_SAFE_INTEGER;

const PRO_ROOM_CODE_RE = /^0\d{5}$/;

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isProRoomGeneration(value) {
  return (
    Number.isSafeInteger(/** @type {number} */ (value)) &&
    /** @type {number} */ (value) >= INITIAL_PRO_ROOM_GENERATION &&
    /** @type {number} */ (value) <= MAX_PRO_ROOM_GENERATION
  );
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function normalizeProRoomGeneration(value) {
  return isProRoomGeneration(value) ? value : null;
}

/**
 * @param {string | null | undefined} roomCode
 * @param {unknown} roomGeneration
 * @returns {string}
 */
export function proRoomObjectName(roomCode, roomGeneration) {
  if (!PRO_ROOM_CODE_RE.test(roomCode || '') || !isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid PRO room generation address');
  }
  return `${roomCode}:generation:${roomGeneration}`;
}

/**
 * @param {string | null | undefined} roomCode
 * @param {unknown} roomGeneration
 * @returns {string}
 */
export function proRoomMediaPrefix(roomCode, roomGeneration) {
  if (!PRO_ROOM_CODE_RE.test(roomCode || '') || !isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid PRO room generation address');
  }
  return `pro-room-incarnations/${roomCode}/generation-${roomGeneration}`;
}

/**
 * @param {unknown} roomGeneration
 * @returns {string}
 */
export function proRoomGenerationHeaderValue(roomGeneration) {
  if (!isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid PRO room generation');
  }
  return String(roomGeneration);
}
