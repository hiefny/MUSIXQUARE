import { test, expect, type Page } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { waitForFilePlaybackReady, clickPlayButton } from './helpers/wait.ts';

interface RecordedSource {
  node: AudioBufferSourceNode;
  when: number;
  offset: number;
  callAt: number;
  stopped: boolean;
}

type OutputWindow = Window & {
  __manualStartSources: RecordedSource[];
  __MUSIXQUARE_GET_STATE__(key: string): unknown;
  __MUSIXQUARE_BUS__: { emit(name: string, ...args: unknown[]): void };
};

function makeWav(): Buffer {
  const rate = 16000;
  const samples = 60 * rate;
  const size = samples * 2;
  const buffer = Buffer.alloc(44 + size);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + size, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(size, 40);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(1000 * Math.sin((i * 440 * 2 * Math.PI) / rate)), 44 + i * 2);
  }
  return buffer;
}

async function recordNativeOutput(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as OutputWindow;
    w.__manualStartSources = [];
    const prototype = AudioBufferSourceNode.prototype;
    const start = prototype.start;
    const stop = prototype.stop;
    // Observe real decoded PCM and native scheduling without replacing audio.
    prototype.start = function (when = 0, offset = 0, duration?: number) {
      start.call(this, when, offset, duration);
      w.__manualStartSources.push({
        node: this,
        when,
        offset,
        callAt: this.context.currentTime,
        stopped: false,
      });
    };
    prototype.stop = function (when = 0) {
      for (const source of w.__manualStartSources) {
        if (source.node === this) source.stopped = true;
      }
      stop.call(this, when);
    };
  });
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as OutputWindow;
    const source = w.__manualStartSources
      .filter((s) => (s.node.buffer?.duration ?? 0) > 5 && !s.stopped)
      .at(-1);
    return {
      at: Date.now(),
      queueItemId: w.__MUSIXQUARE_GET_STATE__('playlist.currentQueueItemId'),
      requested: w.__MUSIXQUARE_GET_STATE__('sync.localOffset'),
      activity: w.__MUSIXQUARE_GET_STATE__('playback.activity'),
      output: source
        ? {
            position:
              source.offset +
              Math.max(0, source.node.context.currentTime - Math.max(source.when, source.callAt)),
            pending: source.node.context.currentTime < source.when,
            state: source.node.context.state,
          }
        : null,
    };
  });
}

async function editOffset(page: Page, ms: number): Promise<void> {
  await expect(page.locator('#btn-sync')).toHaveAttribute('aria-disabled', 'false');
  await page.locator('#btn-sync').click();
  const input = page.locator('#manual-sync-value');
  await expect(input).toBeVisible();
  await input.fill(String(ms));
  await input.press('Enter');
  await page.locator('#btn-sync-done').click();
}

for (const [label, hostMs, guestMs] of [
  ['guest minimum', 0, -9999],
  ['host minimum', -9999, 0],
  ['guest maximum', 0, 9999],
  ['zero control', 0, 0],
] as const) {
  test(`preserves ${label} in actual PCM output through the next file`, async ({ browser }) => {
    test.setTimeout(100000);
    const pair = await createHostGuestContexts(browser);
    try {
      await recordNativeOutput(pair.hostPage);
      await recordNativeOutput(pair.guestPage);
      await connectHostAndGuest(pair.hostPage, pair.guestPage);
      const buffer = makeWav();
      await pair.hostPage.locator('#file-input').setInputFiles([
        { name: 'native-a.wav', mimeType: 'audio/wav', buffer },
        { name: 'native-b.wav', mimeType: 'audio/wav', buffer },
      ]);
      await waitForFilePlaybackReady(pair.hostPage, 25000);
      await clickPlayButton(pair.hostPage);
      for (const page of [pair.hostPage, pair.guestPage]) {
        await expect
          .poll(async () => Boolean((await snapshot(page)).output), { timeout: 25000 })
          .toBe(true);
      }
      await pair.hostPage.waitForTimeout(13000);
      if (hostMs) await editOffset(pair.hostPage, hostMs);
      if (guestMs) await editOffset(pair.guestPage, guestMs);
      await pair.hostPage.waitForTimeout(1500);

      const assertOutputOffset = async () => {
        const [host, guest] = await Promise.all([
          snapshot(pair.hostPage),
          snapshot(pair.guestPage),
        ]);
        expect(host.requested).toBe(hostMs / 1000);
        expect(guest.requested).toBe(guestMs / 1000);
        expect(host.output?.state).toBe('running');
        expect(guest.output?.state).toBe('running');
        expect(host.output?.pending).toBe(false);
        expect(guest.output?.pending).toBe(false);
        const difference =
          guest.output!.position + (host.at - guest.at) / 1000 - host.output!.position;
        // Native audio-clock read quantization and local PeerJS clock error are
        // permitted, but silently losing a 9.999-second offset is not.
        expect(Math.abs(difference - (guestMs - hostMs) / 1000)).toBeLessThan(0.15);
      };
      await assertOutputOffset();
      const previous = (await snapshot(pair.hostPage)).queueItemId;
      await pair.hostPage.evaluate(() => {
        const w = window as unknown as OutputWindow;
        const items = w.__MUSIXQUARE_GET_STATE__('playlist.items') as Array<{
          queueItemId: string;
        }>;
        w.__MUSIXQUARE_BUS__.emit('playlist:play-track', items[1].queueItemId);
      });
      for (const page of [pair.hostPage, pair.guestPage]) {
        await expect
          .poll(
            async () => {
              const state = await snapshot(page);
              return (
                state.queueItemId !== previous &&
                Boolean(state.output) &&
                state.activity === 'playing'
              );
            },
            { timeout: 25000 },
          )
          .toBe(true);
      }
      // The canonical room has started, but a negative participant still owes
      // silence. A late corrective seek must not hide an early audible start.
      if (hostMs < 0) expect((await snapshot(pair.hostPage)).output?.pending).toBe(true);
      if (guestMs < 0) expect((await snapshot(pair.guestPage)).output?.pending).toBe(true);
      await pair.hostPage.waitForTimeout(12000);
      await assertOutputOffset();
    } finally {
      await cleanupContexts(pair);
    }
  });
}
