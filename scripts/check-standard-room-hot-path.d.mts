export interface StandardRoomHotPathSources {
  appWorker: string;
  signalingWorker: string;
  peer: string;
}

export interface StandardRoomHotPathResult {
  capabilityPowDifficulty: 12;
  turnAtomicConsumes: 1;
  standardWebSocketServiceControlConsumes: 0;
  signalingStartsBeforeTurn: true;
  inviteReturnsBeforeTurn: true;
  rtcConfigurationFence: true;
}

export function loadStandardRoomHotPathSources(root?: string): Promise<StandardRoomHotPathSources>;
export function assertStandardRoomHotPath(
  sources: StandardRoomHotPathSources,
): StandardRoomHotPathResult;
