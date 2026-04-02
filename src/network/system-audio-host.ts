/**
 * MUSIXQUARE 3.0 — System Audio Host (MediaConnection Manager)
 *
 * Manages outgoing WebRTC media calls to all connected guests
 * during system audio sharing mode.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { getPeer } from './peer-state.ts';
import { getSystemAudioStream, isSystemAudioActive } from '../audio/system-capture.ts';
import type { MediaConnection } from 'peerjs';

// ─── Module State ─────────────────────────────────────────────────

const _mediaConns = new Map<string, MediaConnection>();

// ─── Public API ───────────────────────────────────────────────────

/**
 * Call all currently connected guests with the system audio stream.
 */
export function callAllGuests(): void {
  const stream = getSystemAudioStream();
  if (!stream) {
    log.warn('[SysAudioHost] No stream to send');
    return;
  }

  const peers = getState('network.connectedPeers');
  const peer = getPeer();
  if (!peer) return;

  for (const p of peers) {
    if (p.status === 'connected' && p.id) {
      callGuest(p.id, stream);
    }
  }
}

/**
 * Call a single guest with the system audio stream.
 */
export function callGuest(guestPeerId: string, stream?: MediaStream): void {
  const s = stream ?? getSystemAudioStream();
  if (!s) return;

  const peer = getPeer();
  if (!peer) return;

  // Don't duplicate calls
  if (_mediaConns.has(guestPeerId)) return;

  try {
    const mc = peer.call(guestPeerId, s, {
      metadata: { type: 'system-audio' },
    });

    _mediaConns.set(guestPeerId, mc);

    mc.on('close', () => {
      _mediaConns.delete(guestPeerId);
      log.debug(`[SysAudioHost] MediaConnection closed: ${guestPeerId}`);
    });

    mc.on('error', (err: unknown) => {
      _mediaConns.delete(guestPeerId);
      log.warn(`[SysAudioHost] MediaConnection error for ${guestPeerId}:`, err);
    });

    log.info(`[SysAudioHost] Called guest: ${guestPeerId}`);
  } catch (e) {
    log.warn(`[SysAudioHost] Failed to call guest ${guestPeerId}:`, e);
  }
}

/**
 * Close all outgoing media connections.
 */
export function closeAllMediaConns(): void {
  for (const mc of _mediaConns.values()) {
    try { mc.close(); } catch { /* noop */ }
  }
  _mediaConns.clear();
  log.debug('[SysAudioHost] All media connections closed');
}

/**
 * Close a specific guest's media connection.
 */
export function closeMediaConn(peerId: string): void {
  const mc = _mediaConns.get(peerId);
  if (mc) {
    try { mc.close(); } catch { /* noop */ }
    _mediaConns.delete(peerId);
  }
}

// ─── Bus Listeners ────────────────────────────────────────────────

export function registerSystemAudioHostListeners(): void {
  // When a new guest connects during active sharing, call them
  bus.on('network:peer-connected', () => {
    if (!isSystemAudioActive()) return;
    if (getState('network.appRole') !== 'host') return;

    const stream = getSystemAudioStream();
    if (!stream) return;

    // Small delay to let DataConnection establish first
    setTimeout(() => {
      const peers = getState('network.connectedPeers');
      for (const p of peers) {
        if (p.status === 'connected' && p.id && !_mediaConns.has(p.id)) {
          callGuest(p.id, stream);
        }
      }
    }, 500);
  });

  // When a guest disconnects, clean up their media connection
  bus.on('network:peer-disconnected', (peerId: string) => {
    closeMediaConn(peerId);
  });

  // Force stop cleans up everything
  bus.on('system-audio:force-stop', () => {
    closeAllMediaConns();
  });

  bus.on('system-audio:stop', () => {
    closeAllMediaConns();
  });
}
