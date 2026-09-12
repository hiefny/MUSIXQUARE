import type { Page } from '@playwright/test';

interface SystemAudioFixture {
  streams: MediaStream[];
  connections: RTCPeerConnection[];
}

type FixtureWindow = Window & {
  __MUSIXQUARE_SYSTEM_AUDIO_FIXTURE__?: SystemAudioFixture;
};

/** Supply synthetic stereo without opening a picker or capturing the desktop. */
export async function installSyntheticSystemAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as FixtureWindow;
    if (win.__MUSIXQUARE_SYSTEM_AUDIO_FIXTURE__) return;
    const fixture: SystemAudioFixture = { streams: [], connections: [] };
    win.__MUSIXQUARE_SYSTEM_AUDIO_FIXTURE__ = fixture;
    // Keep native connections intact while observing the real guest receiver.
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(target, args, newTarget) {
        const connection = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
        fixture.connections.push(connection);
        return connection;
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        const context = new AudioContext({ sampleRate: 48000 });
        await context.resume();
        const destination = context.createMediaStreamDestination();
        const merger = context.createChannelMerger(2);
        const oscillators = [440, 660].map((frequency, channel) => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.frequency.value = frequency;
          gain.gain.value = 0.025;
          oscillator.connect(gain).connect(merger, 0, channel);
          oscillator.start();
          return oscillator;
        });
        merger.connect(destination);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 2;
        const video = canvas.captureStream(1).getVideoTracks()[0];
        const audio = destination.stream.getAudioTracks()[0];
        const stream = new MediaStream([audio, video]);
        const stopAudio = audio.stop.bind(audio);
        let stopped = false;
        audio.stop = () => {
          if (stopped) return;
          stopped = true;
          stopAudio();
          for (const oscillator of oscillators) oscillator.stop();
          void context.close().catch(() => {});
        };
        fixture.streams.push(stream);
        return stream;
      },
    });
  });
}

/** Observe capture cleanup and a live, unmuted remote audio track. */
export async function readSyntheticSystemAudio(page: Page): Promise<{
  activeCaptures: number;
  liveAudioReceivers: number;
}> {
  return page.evaluate(() => {
    const fixture = (window as FixtureWindow).__MUSIXQUARE_SYSTEM_AUDIO_FIXTURE__;
    if (!fixture) throw new Error('Synthetic system audio fixture is not installed');
    return {
      activeCaptures: fixture.streams.filter((stream) =>
        stream.getAudioTracks().some((track) => track.readyState === 'live'),
      ).length,
      liveAudioReceivers: fixture.connections.reduce(
        (total, connection) =>
          total +
          (connection.connectionState === 'connected'
            ? connection
                .getReceivers()
                .filter(
                  ({ track }) =>
                    track.kind === 'audio' && track.readyState === 'live' && !track.muted,
                ).length
            : 0),
        0,
      ),
    };
  });
}
