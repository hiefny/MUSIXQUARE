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

interface HeldSystemAudioPicker {
  calls: number;
  /** Whether each call still ran inside the press's user activation. */
  activations: boolean[];
  pending: Array<{ select: () => void; cancel: () => void }>;
}

type HeldPickerWindow = Window & {
  __MUSIXQUARE_HELD_SYSTEM_AUDIO_PICKER__?: HeldSystemAudioPicker;
};

/**
 * Keep every browser share window open until the test chooses for the person:
 * select delegates to the synthetic capture above, cancel rejects as Chrome
 * does and creates no capture. Install after installSyntheticSystemAudio.
 */
export async function holdSyntheticSystemAudioPicker(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as HeldPickerWindow;
    const selectDisplay = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    const held: HeldSystemAudioPicker = { calls: 0, activations: [], pending: [] };
    win.__MUSIXQUARE_HELD_SYSTEM_AUDIO_PICKER__ = held;
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: (options?: DisplayMediaStreamOptions) => {
        held.calls += 1;
        held.activations.push(navigator.userActivation?.isActive === true);
        return new Promise<MediaStream>((resolve, reject) => {
          held.pending.push({
            select: () => void selectDisplay(options).then(resolve, reject),
            cancel: () => reject(new DOMException('Permission denied', 'NotAllowedError')),
          });
        });
      },
    });
  });
}

export async function readHeldSystemAudioPicker(page: Page): Promise<{
  calls: number;
  activations: boolean[];
  open: number;
}> {
  return page.evaluate(() => {
    const held = (window as HeldPickerWindow).__MUSIXQUARE_HELD_SYSTEM_AUDIO_PICKER__;
    if (!held) throw new Error('The system audio picker is not held');
    return { calls: held.calls, activations: [...held.activations], open: held.pending.length };
  });
}

async function answerHeldSystemAudioPicker(page: Page, answer: 'select' | 'cancel') {
  await page.evaluate((choice) => {
    const next = (
      window as HeldPickerWindow
    ).__MUSIXQUARE_HELD_SYSTEM_AUDIO_PICKER__?.pending.shift();
    if (!next) throw new Error('No system audio picker is open');
    next[choice]();
  }, answer);
}

/** Choose a surface with its audio in the open share window. */
export function selectHeldSystemAudioPicker(page: Page): Promise<void> {
  return answerHeldSystemAudioPicker(page, 'select');
}

/** Close the open share window with Cancel. */
export function cancelHeldSystemAudioPicker(page: Page): Promise<void> {
  return answerHeldSystemAudioPicker(page, 'cancel');
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
