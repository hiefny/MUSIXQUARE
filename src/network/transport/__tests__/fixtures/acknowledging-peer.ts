import { expect, vi } from 'vitest';
import type { CloudflareDataConnection } from '../../cloudflare-signaling.ts';

const TYPE = 'mxqr-bulk-flow';
const PEER_NONCE = 'ac'.repeat(16);

/**
 * Stands in for a current receiver's bulk-flow credit while a fixture captures
 * a sender's wire before that receiver exists. Every end since 8.11.23 sends
 * its hello once admission settles, and since the old-version removal train 2
 * (survey OV-F01) a sender that never gets one stops after its first 128 KiB
 * window instead of sending without credit after 1 s. This peer delivers its
 * hello on the sender's control channel and then, after every send, a receipt
 * for every payload byte sent so far, so credit never limits the capture.
 *
 * `senderHello` is the sender's own hello frame. The sender answers this
 * peer's hello at once with a receipt of nothing received, on its control
 * channel; `takeReply` removes that frame from the fixture's record of sent
 * frames and returns it, and it is checked here.
 */
export async function admitAcknowledgingPeer(
  sender: CloudflareDataConnection,
  control: { deliver(data: string): void },
  senderHello: string,
  takeReply: () => unknown,
): Promise<void> {
  const senderNonce = (JSON.parse(senderHello) as { nonce: string }).nonce;
  control.deliver(JSON.stringify({ type: TYPE, version: 1, kind: 'hello', nonce: PEER_NONCE }));
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(String(takeReply()))).toEqual({
    type: TYPE,
    version: 1,
    kind: 'receipt',
    nonce: PEER_NONCE,
    receivedBytes: 0,
  });
  let acknowledged = 0;
  const send = sender.send.bind(sender);
  sender.send = (data: unknown): void => {
    send(data);
    const { sentBytes } = sender.bulkFlowControl.diagnosticSnapshot;
    if (sentBytes <= acknowledged) return;
    acknowledged = sentBytes;
    control.deliver(
      JSON.stringify({
        type: TYPE,
        version: 1,
        kind: 'receipt',
        nonce: senderNonce,
        receivedBytes: sentBytes,
      }),
    );
  };
}
