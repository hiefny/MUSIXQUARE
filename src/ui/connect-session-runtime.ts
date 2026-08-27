/** Initialize the room-only Connect surface when its reviewed chunk loads. */

import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { getRoomContext } from '../rooms/authority.ts';
import { initConnect } from './connect.ts';

initConnect();

// A device update may win the import race. Re-publish the canonical snapshot
// after Connect has installed its listeners so the panel cannot open stale.
const devices = getState('network.lastKnownDeviceList');
if (devices) bus.emit('network:device-list-update', [...devices]);

// A direct PRO claim/owner transfer publishes its authority directory before
// network.appRole triggers this chunk. Replay that canonical snapshot after
// Connect has subscribed so the administrator panel cannot open empty.
async function replayProRoomAdministrators(): Promise<void> {
  const { getActiveProRoomAdministrators } = await import('../pro-room/runtime.ts');
  bus.emit('pro-room:administrators-updated', getActiveProRoomAdministrators());
}

export const connectSessionRuntimeReady: Promise<void> =
  getRoomContext().kind === 'pro' ? replayProRoomAdministrators() : Promise.resolve();
