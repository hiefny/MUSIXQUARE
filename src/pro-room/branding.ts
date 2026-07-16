import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { isProRoomCode } from './room-code.ts';

const PRO_BADGE_ID = 'header-pro-badge';

function syncProRoomBranding(roomCode: unknown = getState('network.sessionCode')): void {
  const isProRoom = isProRoomCode(roomCode);
  document.documentElement.toggleAttribute('data-pro-room', isProRoom);

  const badge = document.getElementById(PRO_BADGE_ID);
  if (!badge) return;

  badge.hidden = !isProRoom;
}

export { syncProRoomBranding as syncProRoomBrandingForTests };

export function initProRoomBranding(): void {
  syncProRoomBranding();
  bus.on('state:network.sessionCode', (roomCode) => syncProRoomBranding(roomCode));
}
