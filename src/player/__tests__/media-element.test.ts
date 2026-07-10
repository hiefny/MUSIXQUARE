/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';
import { setCurrentAudioBuffer } from '../_state.ts';

const mocks = vi.hoisted(() => ({
  createMediaElementSource: vi.fn(),
  widenerInput: {} as AudioNode,
}));

vi.mock('../../audio/context.ts', () => ({
  getAudioContext: vi.fn(() => ({
    createMediaElementSource: mocks.createMediaElementSource,
  })),
}));

vi.mock('../../audio/engine.ts', () => ({
  getWidener: vi.fn(() => ({ input: mocks.widenerInput })),
}));

import {
  commitPreparedMediaElementSource,
  disposeActiveMediaElementSource,
  disposePreparedMediaElementSource,
  getActiveMediaElementPosition,
  getFilePlaybackDuration,
  hasActiveMediaElementSource,
  pauseActiveMediaElement,
  playActiveMediaElement,
  prepareMediaElementSource,
  prepareMediaElementUrlSource,
  seekActiveMediaElement,
} from '../media-element.ts';

interface FakeAudio {
  element: HTMLAudioElement;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
}

const originalCreateElement = document.createElement.bind(document);
let audioQueue: FakeAudio[];
let createObjectUrl: ReturnType<typeof vi.fn>;
let revokeObjectUrl: ReturnType<typeof vi.fn>;
let originalCreateObjectUrl: PropertyDescriptor | undefined;
let originalRevokeObjectUrl: PropertyDescriptor | undefined;

function fakeAudio(duration = 123): FakeAudio {
  const element = originalCreateElement('audio');
  let currentTime = 0;
  let ended = false;
  Object.defineProperties(element, {
    duration: { configurable: true, get: () => duration },
    readyState: { configurable: true, get: () => HTMLMediaElement.HAVE_METADATA },
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
      },
    },
    ended: {
      configurable: true,
      get: () => ended,
      set: (value: boolean) => {
        ended = value;
      },
    },
  });
  const play = vi.fn().mockResolvedValue(undefined);
  const pause = vi.fn();
  Object.defineProperties(element, {
    load: { configurable: true, value: vi.fn() },
    play: { configurable: true, value: play },
    pause: { configurable: true, value: pause },
  });
  return { element, play, pause };
}

beforeEach(() => {
  resetState();
  setCurrentAudioBuffer(null);
  audioQueue = [];
  mocks.createMediaElementSource.mockReset();

  vi.spyOn(document, 'createElement').mockImplementation(((
    tagName: string,
    options?: ElementCreationOptions,
  ) => {
    if (tagName.toLowerCase() === 'audio') {
      const next = audioQueue.shift();
      if (!next) throw new Error('missing fake audio element');
      return next.element;
    }
    return originalCreateElement(tagName, options);
  }) as typeof document.createElement);

  originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  createObjectUrl = vi.fn(() => `blob:test-${createObjectUrl.mock.calls.length}`);
  revokeObjectUrl = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
});

afterEach(() => {
  disposeActiveMediaElementSource();
  vi.restoreAllMocks();
  if (originalCreateObjectUrl)
    Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl);
  else delete (URL as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
  if (originalRevokeObjectUrl)
    Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl);
  else delete (URL as { revokeObjectURL?: typeof URL.revokeObjectURL }).revokeObjectURL;
  vi.useRealTimers();
});

describe('bounded media-element playback source', () => {
  it('keeps a prepared source private until the caller commits it', async () => {
    const fake = fakeAudio(321);
    const node = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as MediaElementAudioSourceNode;
    audioQueue.push(fake);
    mocks.createMediaElementSource.mockReturnValueOnce(node);

    const prepared = await prepareMediaElementSource(new Blob(['audio']), 'long.wav');

    expect(hasActiveMediaElementSource()).toBe(false);
    expect(getFilePlaybackDuration()).toBe(0);

    commitPreparedMediaElementSource(prepared);

    expect(hasActiveMediaElementSource()).toBe(true);
    expect(getFilePlaybackDuration()).toBe(321);
    expect(node.connect).toHaveBeenCalledWith(mocks.widenerInput);
  });

  it('disposes a superseded Blob source by revoking only its object URL', async () => {
    const fake = fakeAudio();
    const node = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as MediaElementAudioSourceNode;
    audioQueue.push(fake);
    mocks.createMediaElementSource.mockReturnValueOnce(node);
    const blob = new Blob(['shared']);

    const prepared = await prepareMediaElementSource(blob, 'stale.mp3');
    disposePreparedMediaElementSource(prepared);

    expect(hasActiveMediaElementSource()).toBe(false);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test-1');
  });

  it('uses and releases a virtual media URL without creating a Blob URL', async () => {
    const fake = fakeAudio(240);
    const node = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as MediaElementAudioSourceNode;
    const release = vi.fn();
    audioQueue.push(fake);
    mocks.createMediaElementSource.mockReturnValueOnce(node);

    const prepared = await prepareMediaElementUrlSource({
      url: `${location.origin}/__mxqr_media/abcdefghijklmnopqrstuv/song%20name.flac`,
      fileName: 'song name.flac',
      release,
    });

    expect(fake.element.src).toBe(
      `${location.origin}/__mxqr_media/abcdefghijklmnopqrstuv/song%20name.flac`,
    );
    expect(createObjectUrl).not.toHaveBeenCalled();
    disposePreparedMediaElementSource(prepared);
    disposePreparedMediaElementSource(prepared);
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases a virtual URL when preparation fails', async () => {
    const fake = fakeAudio();
    const release = vi.fn();
    audioQueue.push(fake);
    mocks.createMediaElementSource.mockImplementationOnce(() => {
      throw new Error('graph failed');
    });

    await expect(
      prepareMediaElementUrlSource({
        url: `${location.origin}/__mxqr_media/abcdefghijklmnopqrstuv/failure.mp3`,
        release,
      }),
    ).rejects.toThrow('graph failed');

    expect(release).toHaveBeenCalledOnce();
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
  });

  it('rejects non-virtual URLs and still releases their lease', async () => {
    const release = vi.fn();

    await expect(
      prepareMediaElementUrlSource({ url: 'https://attacker.example/audio.mp3', release }),
    ).rejects.toThrow('MEDIA_ELEMENT_SOURCE_URL_INVALID');

    expect(release).toHaveBeenCalledOnce();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it('supports seek, play, pause, and active-source cleanup', async () => {
    const fake = fakeAudio(90);
    const node = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as MediaElementAudioSourceNode;
    const blob = new Blob(['active']);
    audioQueue.push(fake);
    mocks.createMediaElementSource.mockReturnValueOnce(node);
    const prepared = await prepareMediaElementSource(blob, 'podcast.mp3');
    commitPreparedMediaElementSource(prepared);

    seekActiveMediaElement(25);
    expect(getActiveMediaElementPosition()).toBe(25);
    await expect(playActiveMediaElement(30)).resolves.toBe(true);
    expect(fake.play).toHaveBeenCalledOnce();
    expect(getActiveMediaElementPosition()).toBe(30);

    pauseActiveMediaElement();
    expect(fake.pause).toHaveBeenCalled();
    disposeActiveMediaElementSource();

    expect(node.disconnect).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test-1');
  });

  it('cancels a shared-clock scheduled play when playback is paused', async () => {
    vi.useFakeTimers();
    const fake = fakeAudio();
    const node = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as MediaElementAudioSourceNode;
    audioQueue.push(fake);
    mocks.createMediaElementSource.mockReturnValueOnce(node);
    const prepared = await prepareMediaElementSource(new Blob(['audio']), 'scheduled.wav');
    commitPreparedMediaElementSource(prepared);

    const scheduled = playActiveMediaElement(10, 0.2);
    pauseActiveMediaElement();

    await expect(scheduled).resolves.toBe(false);
    await vi.runAllTimersAsync();
    expect(fake.play).not.toHaveBeenCalled();
  });

  it('emits ended only for the currently committed source', async () => {
    const fake = fakeAudio();
    const node = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as MediaElementAudioSourceNode;
    audioQueue.push(fake);
    mocks.createMediaElementSource.mockReturnValueOnce(node);
    const prepared = await prepareMediaElementSource(new Blob(['audio']), 'ended.wav');
    const ended = vi.fn();
    const unsubscribe = bus.on('player:media-element-ended', ended);

    fake.element.dispatchEvent(new Event('ended'));
    expect(ended).not.toHaveBeenCalled();

    commitPreparedMediaElementSource(prepared);
    fake.element.dispatchEvent(new Event('ended'));
    expect(ended).toHaveBeenCalledOnce();

    disposeActiveMediaElementSource();
    fake.element.dispatchEvent(new Event('ended'));
    expect(ended).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
