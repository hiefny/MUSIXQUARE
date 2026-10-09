/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { DataConnection } from '../../types/index.ts';

vi.mock('../../network/peer.ts', async () => {
  const peer = await import('../../network/peer-state.ts');
  return { sendToHost: peer.sendToHost, broadcast: peer.broadcast };
});
vi.mock('../../core/log.ts', () => ({
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../player-controls.ts', () => ({
  getRoleLabelByChannelMode: () => 'Left',
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
}));
vi.mock('../../player/transport.ts', () => ({ seekTo: vi.fn() }));
vi.mock('../../youtube/oembed.ts', () => ({ fetchOEmbedTitle: vi.fn(async () => 'Mock Title') }));
vi.mock('../../i18n/locale-fonts.ts', () => ({
  default: { preloadLocaleFontGlyphs: vi.fn(async () => true) },
}));

let input: HTMLDivElement;
let host: DataConnection;
beforeEach(async () => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  document.body.innerHTML = new DOMParser().parseFromString(
    readFileSync('index.html', 'utf8'),
    'text/html',
  ).body.innerHTML;
  input = document.getElementById('chat-input') as HTMLDivElement;
  host = { peer: 'host', open: true, send: vi.fn(), close: vi.fn() } as unknown as DataConnection;
  setState('network.appRole', 'guest');
  setState('network.myId', 'guest');
  setState('network.myJoinOrder', 1);
  setState('network.hostConn', host);
  setState('network.lastKnownDeviceList', [
    { id: host.peer, label: 'HOST', isHost: true, isOp: true, joinOrder: 0, status: 'connected' },
  ]);
  (await import('../chat.ts')).initChat();
});
afterEach(() => {
  clearAllManagedTimers();
  vi.restoreAllMocks();
});

describe('Standard chat transport admission', () => {
  it.each(['ordinary', 'whisper'] as const)(
    'retains a rejected %s draft and admits an immediate exact retry',
    (kind) => {
      setState('network.slowmodeSeconds', 30);
      vi.mocked(host.send).mockImplementationOnce(() => {
        throw new DOMException('DataChannel rejected send', 'InvalidStateError');
      });
      const draft =
        kind === 'ordinary' ? 'Keep this exact draft' : '/w #0 Keep this exact private draft';
      input.textContent = draft;
      document.getElementById('btn-chat-send')!.click();
      expect(host.send).toHaveBeenCalledOnce();
      expect(input.textContent).toBe(draft);
      expect(document.querySelector('.chat-bubble.mine')).toBeNull();
      expect(document.querySelector('.chat-group.system')).not.toBeNull();
      // Same tick and same draft: a failed send must not consume dedup or slowmode.
      document.getElementById('btn-chat-send')!.click();
      expect(host.send).toHaveBeenCalledTimes(2);
      expect(input.textContent).toBe('');
      expect(document.querySelectorAll('.chat-bubble.mine')).toHaveLength(1);
      if (kind === 'ordinary') {
        input.textContent = 'Slowmode applies after the admitted send';
        document.getElementById('btn-chat-send')!.click();
        expect(host.send).toHaveBeenCalledTimes(2);
        expect(input.textContent).toBe('Slowmode applies after the admitted send');
      }
    },
  );
});
