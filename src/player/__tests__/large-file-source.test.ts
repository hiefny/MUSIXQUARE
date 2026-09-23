/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { isLargeFileSource, type LargeAudioTrack } from '../file-playback-resource.ts';
import { createLargeFileSource } from '../large-file-source.ts';

type StartOptions = Parameters<LargeAudioTrack['createPlayback']>[0];

function fixture() {
  let startOptions: StartOptions | undefined;
  let ended = false;
  const playback = {
    get ended() {
      return ended;
    },
    stop: vi.fn(() => {
      ended = true;
    }),
    disconnect: vi.fn(),
  };
  const track: LargeAudioTrack = {
    kind: 'large-audio',
    duration: 3_600,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: 172_800_000,
    bufferedPcmBytes: 1_024,
    prepare: vi.fn(async () => {}),
    createPlayback: vi.fn((options: StartOptions) => {
      startOptions = options;
      return playback;
    }),
    dispose: vi.fn(),
  };
  const context = { currentTime: 10 } as AudioContext;
  const destination = {} as AudioNode;
  const onerror = vi.fn();
  const source = createLargeFileSource(track, context, destination, onerror);
  const onended = vi.fn();
  source.onended = onended;
  return {
    track,
    source,
    playback,
    context,
    destination,
    onerror,
    onended,
    finish: () => {
      ended = true;
      startOptions!.onended();
    },
    fail: (error: unknown) => startOptions!.onerror(error),
  };
}

describe('bounded file source adapter', () => {
  it('preserves the original track identity while passing absolute start timing to the backend', () => {
    const { source, track, context, destination, playback } = fixture();
    expect(isLargeFileSource(source)).toBe(true);
    expect(source.buffer).toBe(track);
    expect(source.ended).toBe(false);
    source.start(12.75, 1_234.5);
    expect(track.createPlayback).toHaveBeenCalledExactlyOnceWith({
      context,
      destination,
      when: 12.75,
      offset: 1_234.5,
      onended: expect.any(Function),
      onerror: expect.any(Function),
    });
    expect(source.buffer).toBe(track);
    source.disconnect();
    expect(playback.disconnect).toHaveBeenCalledExactlyOnceWith();
    expect(source.buffer).toBe(track);
    source.stop();
    expect(playback.stop).toHaveBeenCalledExactlyOnceWith();
    expect(track.dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it('allows only one start and releases even an unstarted source exactly once', () => {
    const { source, track } = fixture();
    source.stop();
    source.stop();
    expect(source.ended).toBe(true);
    expect(track.dispose).toHaveBeenCalledExactlyOnceWith();
    expect(track.createPlayback).not.toHaveBeenCalled();
    expect(() => source.start(0, 0)).toThrow();

    const started = fixture();
    started.source.start(1, 2);
    expect(() => started.source.start(2, 3)).toThrow();
    expect(started.track.createPlayback).toHaveBeenCalledOnce();
    started.source.stop();
  });

  it.each([0, 5, 10, 12.75])(
    'normalizes native start time %s without changing the requested track offset',
    (when) => {
      const { source, track, context } = fixture();
      source.start(when, 345.5);
      expect(track.createPlayback).toHaveBeenCalledWith(
        expect.objectContaining({
          when: Math.max(context.currentTime, when),
          offset: 345.5,
        }),
      );
      source.stop();
    },
  );

  it('suppresses queued terminal callbacks after explicit stop', () => {
    const { source, finish, fail, onended, onerror, track } = fixture();
    source.start(0, 0);
    source.stop();
    finish();
    fail(new Error('stale decoder failure'));
    expect(onended).not.toHaveBeenCalled();
    expect(onerror).not.toHaveBeenCalled();
    expect(track.dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it('publishes natural end once and never turns it into a late decoding failure', () => {
    const { source, finish, fail, onended, onerror, track } = fixture();
    source.start(0, 0);
    finish();
    finish();
    fail(new Error('late decoder failure'));
    expect(source.ended).toBe(true);
    expect(onended).toHaveBeenCalledExactlyOnceWith(expect.any(Event));
    expect(onerror).not.toHaveBeenCalled();
    expect(track.dispose).not.toHaveBeenCalled();
    source.stop();
    source.stop();
    expect(track.dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it('publishes failure once without treating a later terminal callback as track completion', () => {
    const { source, finish, fail, onended, onerror, track } = fixture();
    const failure = new Error('decode failed');
    source.start(0, 0);
    fail(failure);
    fail(new Error('duplicate decode failure'));
    finish();
    expect(source.ended).toBe(true);
    expect(onerror).toHaveBeenCalledExactlyOnceWith(failure);
    expect(onended).not.toHaveBeenCalled();
    source.stop();
    expect(track.dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it('can release source ownership after a synchronous decoder factory failure', () => {
    const { source, track, playback } = fixture();
    vi.mocked(track.createPlayback).mockImplementationOnce(() => {
      throw new Error('cannot start decoder');
    });
    expect(() => source.start(0, 0)).toThrow('cannot start decoder');
    source.stop();
    source.stop();
    expect(track.dispose).toHaveBeenCalledExactlyOnceWith();
    expect(playback.stop).not.toHaveBeenCalled();
  });

  it('rejects a synchronous backend error before transport can publish the candidate source', () => {
    const { source, track, playback, onerror, onended } = fixture();
    const failure = new Error('first PCM source could not start');
    vi.mocked(track.createPlayback).mockImplementationOnce((options) => {
      options.onerror(failure);
      options.onended();
      return playback;
    });
    expect(() => source.start(0, 0)).toThrow(failure);
    expect(source.ended).toBe(true);
    expect(onerror).not.toHaveBeenCalled();
    expect(onended).not.toHaveBeenCalled();
    source.stop();
    expect(playback.stop).toHaveBeenCalledExactlyOnceWith();
    expect(track.dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it('releases the decoder even if the backend stop throws', () => {
    const { source, track, playback } = fixture();
    source.start(0, 0);
    playback.stop.mockImplementationOnce(() => {
      throw new Error('backend teardown failure');
    });
    expect(() => source.stop()).toThrow('backend teardown failure');
    expect(track.dispose).toHaveBeenCalledExactlyOnceWith();
    expect(() => source.stop()).not.toThrow();
    expect(track.dispose).toHaveBeenCalledExactlyOnceWith();
  });
});
