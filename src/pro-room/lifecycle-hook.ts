let leaveHandler: (() => void | Promise<void>) | null = null;

/** Keep the network teardown layer independent from the PRO runtime graph. */
export function registerProRoomLeaveHandler(handler: (() => void | Promise<void>) | null): void {
  leaveHandler = handler;
}

export function requestProRoomLeave(): void {
  if (!leaveHandler) return;
  void Promise.resolve(leaveHandler()).catch(() => undefined);
}
