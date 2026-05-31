/**
 * Inject local PeerJS server config into the page before app JS runs.
 * Uses the existing __MUSIXQUARE_PEER_SERVER__ hook in src/network/peer.ts.
 */
import type { Page } from '@playwright/test';

const PEER_CONFIG = {
  host: 'localhost',
  port: 9000,
  path: '/',
  secure: false,
  key: 'peerjs',
};

export async function injectPeerServer(page: Page): Promise<void> {
  await page.addInitScript((config) => {
    (window as unknown as Record<string, unknown>).__MUSIXQUARE_PEER_SERVER__ = config;
    localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
    localStorage.setItem('musixquare-app-used-v1', '1');

    type Getter = (path: string) => unknown;
    const stateHook = '__MUSIXQUARE_GET_STATE__';
    const projectedHook = '__MUSIXQUARE_GET_PROJECTED_APP_STATE__';
    const win = window as unknown as Record<string, unknown>;
    let rawGetState: Getter | undefined;

    const projectAppState = (): string | undefined => {
      if (!rawGetState) return undefined;

      const mode = rawGetState('playback.mode');
      const activity = rawGetState('playback.activity');
      const lifecycle = rawGetState('playback.lifecycle');
      const isReceivingSystemAudio = rawGetState('systemAudio.isReceiving');
      const meta = rawGetState('player.currentTrackMeta') as
        | { systemAudioPlaceholder?: boolean }
        | null
        | undefined;

      if (mode === 'youtube') return 'PLAYING_YOUTUBE';
      if (
        mode === 'system-audio' ||
        isReceivingSystemAudio === true ||
        meta?.systemAudioPlaceholder === true
      ) {
        return 'PLAYING_SYSTEM_AUDIO';
      }

      if (mode === 'file') {
        if (activity === 'playing' || lifecycle === 'PLAYING') return 'PLAYING_AUDIO';
        if (activity === 'paused' || lifecycle === 'PAUSED' || lifecycle === 'READY') {
          return 'PAUSED';
        }
        return 'IDLE';
      }

      if (lifecycle === 'PLAYING') return 'PLAYING_AUDIO';
      if (lifecycle === 'PAUSED' || lifecycle === 'READY') return 'PAUSED';
      return 'IDLE';
    };

    const projectedGetState: Getter = (path) => {
      if (!rawGetState) {
        if (path === 'files.currentFileBlob' || path === 'network.hostConn') return null;
        return undefined;
      }
      if (path === 'appState') return projectAppState();
      return rawGetState(path);
    };

    Object.defineProperty(win, stateHook, {
      configurable: true,
      get: () => projectedGetState,
      set: (value: unknown) => {
        rawGetState = typeof value === 'function' ? (value as Getter) : undefined;
      },
    });

    win[projectedHook] = projectAppState;
  }, PEER_CONFIG);
}
