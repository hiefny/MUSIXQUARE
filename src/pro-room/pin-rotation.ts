/**
 * Finish a PIN rotation only after the authoritative heartbeat has rebuilt
 * transport for the new coordinator epoch. A stale local session deliberately
 * skips the follow-up instead of mutating whichever room replaced it.
 */
export async function completeProRoomPinRotation(operations: {
  changePin: () => Promise<void>;
  isSessionCurrent: () => boolean;
  heartbeat: () => Promise<void>;
}): Promise<boolean> {
  await operations.changePin();
  if (!operations.isSessionCurrent()) return false;
  await operations.heartbeat();
  return true;
}
