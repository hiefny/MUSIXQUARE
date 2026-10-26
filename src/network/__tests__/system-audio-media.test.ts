/**
 * The system-audio media home (registry RO-04, Phase 5 C4-1) on its own: the
 * receivers' playout-delay hint, the two sender tunings and the Realtime
 * values both SFU transports share. The routes that call it are pinned
 * through their real modules in the receive-slot contracts and the publisher
 * evidence suites; this suite holds the edges the routes differ on.
 */
import { describe, expect, it } from 'vitest';
import {
  BASE_SFU_ICE_SERVERS,
  SFU_CONTROL_REQUEST_TIMEOUT_MS,
  SFU_CONTROL_RESPONSE_MAX_BYTES,
  applySystemAudioPlayoutDelay,
  tuneSystemAudioLanDirectSender,
  tuneSystemAudioMusicSender,
} from '../system-audio-media.ts';
import { FakeSender, makeCaptureTrack } from './__helpers__/system-audio-publisher-natives.ts';

const MUSIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

type HintedReceiver = RTCRtpReceiver & { playoutDelayHint?: number };

function receiver(track: { kind: string } | null): HintedReceiver {
  return { track } as unknown as HintedReceiver;
}

function senderReturning(parameters: Partial<RTCRtpSendParameters>, track = makeCaptureTrack()) {
  const sender = new FakeSender(track);
  sender.getParameters.mockImplementation(
    () => structuredClone(parameters) as RTCRtpSendParameters,
  );
  return sender;
}

describe('system-audio media home', () => {
  it('sets the 0.5 s playout-delay hint on an audio receiver only', () => {
    const audio = receiver({ kind: 'audio' });
    const video = receiver({ kind: 'video' });
    const trackless = receiver(null);

    for (const each of [audio, video, trackless]) applySystemAudioPlayoutDelay(each);

    expect(audio.playoutDelayHint).toBe(0.5);
    expect(video).not.toHaveProperty('playoutDelayHint');
    expect(trackless).not.toHaveProperty('playoutDelayHint');
  });

  it('tunes a music sender once: the music constraints and one 256 kbps encoding', () => {
    const track = makeCaptureTrack();
    const sender = senderReturning(
      { transactionId: 'tx-1', encodings: [{ active: true }] } as Partial<RTCRtpSendParameters>,
      track,
    );

    tuneSystemAudioMusicSender(sender as unknown as RTCRtpSender);

    expect(track.constraintRequests).toEqual([MUSIC_CONSTRAINTS]);
    expect(sender.setParameters).toHaveBeenCalledTimes(1);
    expect(sender.setParameters).toHaveBeenCalledWith({
      transactionId: 'tx-1',
      encodings: [{ active: true, maxBitrate: 256_000 }],
    });
  });

  it('leaves a music sender without an audio track untouched', () => {
    const video = senderReturning({ encodings: [{}] }, {
      ...makeCaptureTrack(),
      kind: 'video',
    } as ReturnType<typeof makeCaptureTrack>);
    const trackless = new FakeSender(null as unknown as MediaStreamTrack);

    tuneSystemAudioMusicSender(video as unknown as RTCRtpSender);
    tuneSystemAudioMusicSender(trackless as unknown as RTCRtpSender);

    for (const sender of [video, trackless]) {
      expect(sender.getParameters).not.toHaveBeenCalled();
      expect(sender.setParameters).not.toHaveBeenCalled();
    }
  });

  it.each([
    { route: 'music', tune: tuneSystemAudioMusicSender, constraints: 1, noEncoding: null },
    { route: 'LAN-direct', tune: tuneSystemAudioLanDirectSender, constraints: 0, noEncoding: [] },
  ])(
    'handles the encoding-list edges of a $route sender as that route always did',
    ({ tune, constraints, noEncoding }) => {
      const omitted = senderReturning({});
      const empty = senderReturning({ encodings: [] } as Partial<RTCRtpSendParameters>);

      tune(omitted as unknown as RTCRtpSender);
      tune(empty as unknown as RTCRtpSender);

      expect(omitted.setParameters).toHaveBeenCalledWith({ encodings: [{ maxBitrate: 256_000 }] });
      if (noEncoding === null) {
        expect(empty.setParameters).not.toHaveBeenCalled();
      } else {
        expect(empty.setParameters).toHaveBeenCalledWith({ encodings: noEncoding });
      }
      for (const sender of [omitted, empty]) {
        const track = sender.track as ReturnType<typeof makeCaptureTrack>;
        expect(track.constraintRequests).toHaveLength(constraints);
      }
    },
  );

  // A rejection left unhandled would fail the run even though the assertions pass.
  it.each(['reject', 'throw'] as const)(
    'still caps the bitrate when the music constraints would %s',
    (how) => {
      const track = makeCaptureTrack();
      track.refuseConstraints(how);
      const sender = senderReturning({ encodings: [{}] }, track);

      expect(() => tuneSystemAudioMusicSender(sender as unknown as RTCRtpSender)).not.toThrow();

      expect(sender.setParameters).toHaveBeenCalledWith({ encodings: [{ maxBitrate: 256_000 }] });
    },
  );

  it.each([
    ['music', tuneSystemAudioMusicSender],
    ['LAN-direct', tuneSystemAudioLanDirectSender],
  ] as const)('keeps a %s sender whose parameters cannot be read or set', async (_route, tune) => {
    const unreadable = senderReturning({ encodings: [{}] });
    unreadable.getParameters.mockImplementation(() => {
      throw new TypeError('getParameters is not supported');
    });
    // A plain function, not a vi.fn: a vi.fn observes the promise it returns,
    // which would hide a missing .catch (an unhandled rejection) from Vitest.
    let refusals = 0;
    const refusing = {
      track: makeCaptureTrack(),
      getParameters: () => ({ encodings: [{}] }) as RTCRtpSendParameters,
      setParameters: (): Promise<void> => {
        refusals += 1;
        return Promise.reject(
          new DOMException('Cannot modify parameters', 'InvalidModificationError'),
        );
      },
    };

    expect(() => tune(unreadable as unknown as RTCRtpSender)).not.toThrow();
    expect(() => tune(refusing as unknown as RTCRtpSender)).not.toThrow();
    // Let the refused update settle: an unhandled rejection would fail the run.
    await Promise.resolve();

    expect(unreadable.setParameters).not.toHaveBeenCalled();
    expect(refusals).toBe(1);
  });

  it('holds the Realtime values both SFU transports share', () => {
    expect(BASE_SFU_ICE_SERVERS).toEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);
    expect(SFU_CONTROL_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(SFU_CONTROL_RESPONSE_MAX_BYTES).toBe(1024 * 1024);
  });
});
