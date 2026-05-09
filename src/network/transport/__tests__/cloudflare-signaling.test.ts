/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { CloudflareSignalingPeer } from '../cloudflare-signaling.ts';

function createPeer(): CloudflareSignalingPeer {
  return new CloudflareSignalingPeer(null, {
    provider: 'cloudflare',
    signalingUrl: 'wss://signal.example.test/api/rooms',
  });
}

describe('CloudflareSignalingPeer signaling lifecycle', () => {
  it('does not close a live data channel when only signaling reports peer-left', async () => {
    const peer = createPeer();
    const close = vi.fn();
    const conn = {
      open: true,
      close,
      peerConnection: { connectionState: 'connected' },
    };

    (peer as unknown as { connections: Map<string, unknown> }).connections.set('guest-1', conn);

    await (peer as unknown as { handleHostMessage(raw: string): Promise<void> }).handleHostMessage(
      JSON.stringify({ type: 'peer-left', peerId: 'guest-1' }),
    );

    expect(close).not.toHaveBeenCalled();
  });

  it('closes the data channel when signaling peer-left matches a failed transport', async () => {
    const peer = createPeer();
    const close = vi.fn();
    const conn = {
      open: true,
      close,
      peerConnection: { connectionState: 'failed' },
    };

    (peer as unknown as { connections: Map<string, unknown> }).connections.set('guest-1', conn);

    await (peer as unknown as { handleHostMessage(raw: string): Promise<void> }).handleHostMessage(
      JSON.stringify({ type: 'peer-left', peerId: 'guest-1' }),
    );

    expect(close).toHaveBeenCalledTimes(1);
  });
});
