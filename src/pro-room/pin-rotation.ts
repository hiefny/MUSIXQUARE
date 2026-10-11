/**
 * Finish a PIN change only after the authoritative heartbeat has read its
 * result. When the change made everyone re-enter, that heartbeat also rebuilds
 * transport for the new room incarnation; when it kept the people present, the
 * incarnation is unchanged and the heartbeat is an ordinary forced read. A
 * stale local session deliberately skips the follow-up instead of mutating
 * whichever room replaced it.
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
