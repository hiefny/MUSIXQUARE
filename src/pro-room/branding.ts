import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { isProRoomCode } from './room-code.ts';

const PRO_BADGE_ID = 'header-pro-badge';

export function syncProRoomBranding(roomCode: unknown = getState('network.sessionCode')): void {
  const badge = document.getElementById(PRO_BADGE_ID);
  if (!badge) return;

  badge.hidden = !isProRoomCode(roomCode);
}

export function initProRoomBranding(): void {
  syncProRoomBranding();
  bus.on('state:network.sessionCode', (roomCode) => syncProRoomBranding(roomCode));
}
