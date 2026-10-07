import { expect, test } from '@playwright/test';
import { cleanupContexts, createHostGuestContexts } from './helpers/context-factory.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  clickPlayButton,
  readState,
  waitForFilePlaybackReady,
  waitForPlaybackProjection,
} from './helpers/wait.ts';

type DecodeWindow = Window & {
  __releaseGuestDecode?: () => void;
  __guestDecodeSettled?: boolean;
  __guestSourceStarts?: number;
  __MUSIXQUARE_GET_STATE__?: (key: string) => unknown;
};

for (const result of ['success', 'failure'] as const) {
  test(`terminal disconnect silences a guest whose native decode later reports ${result}`, async ({
    browser,
  }) => {
    const pair = await createHostGuestContexts(browser);
    const { hostPage: host, guestPage: guest } = pair;
    try {
      await connectHostAndGuest(host, guest);
      await guest.evaluate((outcome) => {
        const root = window as DecodeWindow;
        const decode = AudioContext.prototype.decodeAudioData;
        const start = AudioBufferSourceNode.prototype.start;
        root.__guestSourceStarts = 0;
        AudioBufferSourceNode.prototype.start = function (...args) {
          root.__guestSourceStarts! += 1;
          return start.apply(this, args);
        };
        AudioContext.prototype.decodeAudioData = async function (bytes) {
          AudioContext.prototype.decodeAudioData = decode;
          const buffer = await decode.call(this, bytes);
          // Model a native decoder completing after its room disappears.
          // The file, transfer, AudioBuffer, disconnect, and teardown are real;
          // only this first decoder completion is deliberately delayed.
          await new Promise<void>((resolve) => {
            root.__releaseGuestDecode = resolve;
          });
          root.__guestDecodeSettled = true;
          if (outcome === 'failure') throw new DOMException('Decoder rejected', 'EncodingError');
          return buffer;
        };
      }, result);
      await uploadFixture(host, 'test01');
      await waitForFilePlaybackReady(host);
      await clickPlayButton(host);
      await waitForPlaybackProjection(host, 'PLAYING_AUDIO');
      await guest.waitForFunction(
        () => typeof (window as DecodeWindow).__releaseGuestDecode === 'function',
      );

      // Close the real host-side RTC channel before disposing its context;
      // abrupt process loss can leave ICE waiting for its native timeout.
      // Do not emit an artificial UI error or call guest teardown directly.
      await host.evaluate(() => {
        const peers = (window as DecodeWindow).__MUSIXQUARE_GET_STATE__?.(
          'network.connectedPeers',
        ) as Array<{ conn: { close(): void } }>;
        if (!peers?.[0]) throw new Error('Connected guest is missing');
        peers[0].conn.close();
      });
      await expect(guest.locator('#dialog-overlay.show')).toBeVisible();
      await pair.hostContext.close();
      expect(await readState(guest, 'network.hostConn')).toBeNull();
      expect(await readState(guest, 'playback.activity')).toBe('idle');
      const startsBefore = await guest.evaluate(() => (window as DecodeWindow).__guestSourceStarts);
      await guest.evaluate(() => (window as DecodeWindow).__releaseGuestDecode?.());
      await guest.waitForFunction(() => (window as DecodeWindow).__guestDecodeSettled === true);

      expect(await readState(guest, 'playback.activity')).toBe('idle');
      expect(await readState(guest, 'files.current')).toBeNull();
      expect(
        await guest.evaluate(
          () =>
            (
              (window as DecodeWindow).__MUSIXQUARE_GET_STATE__?.(
                'playback.failedTrackKeys',
              ) as Set<string>
            ).size,
        ),
      ).toBe(0);
      expect(await guest.evaluate(() => (window as DecodeWindow).__guestSourceStarts)).toBe(
        startsBefore,
      );
      await expect(guest.locator('#dialog-overlay.show')).toBeVisible();
    } finally {
      await cleanupContexts(pair);
    }
  });
}
