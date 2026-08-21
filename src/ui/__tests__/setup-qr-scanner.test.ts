/** @vitest-environment jsdom */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  decodeQr: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('jsqr', () => ({
  default: mocks.decodeQr,
}));

vi.mock('../../core/log.ts', () => ({
  log: { warn: mocks.warn },
}));

import { initGuestQrScanner, stopGuestQrScanner } from '../setup-qr-scanner.ts';

type FrameCallback = (now: number) => void;

interface FakeCamera {
  stream: MediaStream;
  track: MediaStreamTrack;
  stop: ReturnType<typeof vi.fn>;
}

let frameCallbacks = new Map<number, FrameCallback>();
let nextFrameId = 0;
let getUserMedia = vi.fn();
let play = vi.fn();
let pause = vi.fn();
let drawImage = vi.fn();
let getImageData = vi.fn();

function renderScanner(): void {
  document.body.innerHTML = `
    <div id="setup-guest-qr-stage">
      <input id="setup-join-code" />
      <button id="btn-setup-qr-scan" type="button"></button>
      <div id="setup-qr-camera" hidden>
        <video id="setup-qr-video"></video>
        <button id="btn-setup-qr-close" type="button"></button>
      </div>
    </div>
  `;
}

function fakeCamera(settings: MediaTrackSettings = {}): FakeCamera {
  const stop = vi.fn();
  const track = Object.assign(new EventTarget(), {
    kind: 'video',
    readyState: 'live' as MediaStreamTrackState,
    muted: false,
    enabled: true,
    stop,
    getSettings: () => settings,
  }) as unknown as MediaStreamTrack;
  const stream = {
    active: true,
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track, stop };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function setVisibility(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
}

function setVideoFrameReady(ready: boolean): void {
  const video = document.getElementById('setup-qr-video') as HTMLVideoElement;
  Object.defineProperties(video, {
    readyState: {
      configurable: true,
      value: ready ? HTMLMediaElement.HAVE_CURRENT_DATA : HTMLMediaElement.HAVE_NOTHING,
    },
    videoWidth: { configurable: true, value: ready ? 1 : 0 },
    videoHeight: { configurable: true, value: ready ? 1 : 0 },
    requestVideoFrameCallback: { configurable: true, value: undefined },
    cancelVideoFrameCallback: { configurable: true, value: undefined },
  });
}

async function flushScannerStart(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function runNextFrame(now: number): void {
  const entry = frameCallbacks.entries().next().value as [number, FrameCallback] | undefined;
  if (!entry) throw new Error('Expected a queued scanner frame');
  frameCallbacks.delete(entry[0]);
  entry[1](now);
}

async function runLayoutFrame(): Promise<void> {
  await flushScannerStart();
  expect(frameCallbacks.size).toBeGreaterThan(0);
  runNextFrame(0);
  await flushScannerStart();
}

async function openScannerWithReadyCamera(camera: FakeCamera): Promise<void> {
  getUserMedia.mockResolvedValue(camera.stream);
  document.getElementById('btn-setup-qr-scan')?.click();
  await runLayoutFrame();
  document.getElementById('setup-qr-video')?.dispatchEvent(new Event('loadeddata'));
  await flushScannerStart();
}

async function waitForScannerFrame(): Promise<void> {
  await vi.waitFor(() => expect(frameCallbacks.size).toBeGreaterThan(0));
}

function cameraError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

beforeAll(() => {
  renderScanner();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameCallback) => {
    const id = ++nextFrameId;
    frameCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frameCallbacks.delete(id));

  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: (...args: unknown[]) => play(...args),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: (...args: unknown[]) => pause(...args),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ drawImage, getImageData }),
  });
});

beforeEach(() => {
  stopGuestQrScanner();
  vi.clearAllMocks();
  frameCallbacks.clear();
  setVisibility('visible');
  setVideoFrameReady(true);
  play.mockResolvedValue(undefined);
  getImageData.mockReturnValue({
    data: new Uint8ClampedArray(4),
    width: 1,
    height: 1,
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: (...args: unknown[]) => getUserMedia(...args) },
  });

  const button = document.getElementById('btn-setup-qr-scan') as HTMLButtonElement;
  button.disabled = false;
  button.hidden = false;
});

afterEach(() => {
  stopGuestQrScanner();
  vi.useRealTimers();
});

describe('guest setup QR scanner', () => {
  it('stops every camera track and clears the video when the scanner is cancelled', async () => {
    const camera = fakeCamera();
    const onCode = vi.fn();
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode, onError });

    await openScannerWithReadyCamera(camera);
    expect((document.getElementById('setup-qr-video') as HTMLVideoElement).srcObject).toBe(
      camera.stream,
    );

    document.getElementById('btn-setup-qr-close')?.click();

    expect(camera.stop).toHaveBeenCalledOnce();
    expect((document.getElementById('setup-qr-video') as HTMLVideoElement).srcObject).toBeNull();
    expect(document.getElementById('setup-qr-camera')?.hidden).toBe(true);
    expect(onCode).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'camera-not-found'],
  ] as const)('classifies getUserMedia %s without retrying', async (name, expected) => {
    getUserMedia.mockRejectedValue(cameraError(name));
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    document.getElementById('btn-setup-qr-scan')?.click();
    await flushScannerStart();

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expected);
    expect(document.getElementById('setup-qr-camera')?.hidden).toBe(true);
  });

  it('classifies a synchronous getUserMedia throw without leaking the camera UI', async () => {
    getUserMedia.mockImplementation(() => {
      throw cameraError('NotAllowedError');
    });
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    document.getElementById('btn-setup-qr-scan')?.click();
    expect(getUserMedia).toHaveBeenCalledOnce();
    await flushScannerStart();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('permission-denied');
    expect(document.getElementById('setup-qr-camera')?.hidden).toBe(true);
  });

  it('retries a settled generic acquisition failure with simpler constraints', async () => {
    const camera = fakeCamera();
    getUserMedia
      .mockRejectedValueOnce(cameraError('AbortError'))
      .mockResolvedValueOnce(camera.stream);
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    document.getElementById('btn-setup-qr-scan')?.click();
    await runLayoutFrame();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({
      video: { width: { ideal: 1280 }, height: { ideal: 1280 } },
    });
    expect(getUserMedia.mock.calls[1]?.[0]).toEqual({
      audio: false,
      video: { facingMode: { ideal: 'environment' } },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('blurs the code input before requesting the camera', async () => {
    const camera = fakeCamera();
    const input = document.getElementById('setup-join-code') as HTMLInputElement;
    input.focus();
    getUserMedia.mockImplementation(() => {
      expect(document.activeElement).not.toBe(input);
      return Promise.resolve(camera.stream);
    });
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError: vi.fn() });

    document.getElementById('btn-setup-qr-scan')?.click();
    expect(getUserMedia).toHaveBeenCalledOnce();
    await runLayoutFrame();
    document.getElementById('setup-qr-video')?.dispatchEvent(new Event('loadeddata'));
    await flushScannerStart();
  });

  it.each(['visibilitychange', 'pagehide'] as const)(
    'discards a late camera stream after %s while permission is pending',
    async (eventName) => {
      const pending = deferred<MediaStream>();
      const camera = fakeCamera();
      getUserMedia.mockReturnValue(pending.promise);
      const onError = vi.fn();
      initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

      document.getElementById('btn-setup-qr-scan')?.click();
      if (eventName === 'visibilitychange') {
        setVisibility('hidden');
        document.dispatchEvent(new Event(eventName));
      } else {
        window.dispatchEvent(new Event(eventName));
      }
      pending.resolve(camera.stream);
      await flushScannerStart();

      expect(camera.stop).toHaveBeenCalledOnce();
      expect(play).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it.each(['visibilitychange', 'pagehide'] as const)(
    'stops an active camera immediately on %s',
    async (eventName) => {
      const camera = fakeCamera();
      initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError: vi.fn() });
      await openScannerWithReadyCamera(camera);

      if (eventName === 'visibilitychange') {
        setVisibility('hidden');
        document.dispatchEvent(new Event(eventName));
      } else {
        window.dispatchEvent(new Event(eventName));
      }

      expect(camera.stop).toHaveBeenCalledOnce();
      expect((document.getElementById('setup-qr-video') as HTMLVideoElement).srcObject).toBeNull();
    },
  );

  it('accepts only the canonical domain and emits one join code', async () => {
    const camera = fakeCamera();
    mocks.decodeQr
      .mockReturnValueOnce({ data: 'https://evil.example/musixquare.com/123456' })
      .mockReturnValueOnce({ data: 'https://musixquare.com.evil/123456' })
      .mockReturnValueOnce({ data: 'https://musixquare.com/123456/extra' })
      .mockReturnValueOnce({ data: 'MUSIXQUARE.COM/654321' });
    const onCode = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode, onError: vi.fn() });

    await openScannerWithReadyCamera(camera);
    await waitForScannerFrame();
    runNextFrame(100);
    runNextFrame(200);
    runNextFrame(300);
    runNextFrame(400);

    expect(onCode).toHaveBeenCalledOnce();
    expect(onCode).toHaveBeenCalledWith('654321');
    expect(frameCallbacks).toHaveLength(0);
  });

  it('accepts a proven frame even when video.play remains pending', async () => {
    const camera = fakeCamera();
    const pendingPlay = deferred<void>();
    play.mockReturnValue(pendingPlay.promise);
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    await openScannerWithReadyCamera(camera);

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect((document.getElementById('setup-qr-video') as HTMLVideoElement).srcObject).toBe(
      camera.stream,
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('falls back to post-attach media events when video frame callbacks throw', async () => {
    const camera = fakeCamera();
    const video = document.getElementById('setup-qr-video') as HTMLVideoElement;
    Object.defineProperty(video, 'requestVideoFrameCallback', {
      configurable: true,
      value: () => {
        throw new Error('partial WebKit implementation');
      },
    });
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    getUserMedia.mockResolvedValue(camera.stream);
    document.getElementById('btn-setup-qr-scan')?.click();
    await runLayoutFrame();
    video.dispatchEvent(new Event('loadeddata'));
    await flushScannerStart();

    expect(video.srcObject).toBe(camera.stream);
    expect(onError).not.toHaveBeenCalled();
  });

  it('survives a throwing video frame callback cancellation after a proven frame', async () => {
    const camera = fakeCamera();
    const video = document.getElementById('setup-qr-video') as HTMLVideoElement;
    const videoFrameProof: { callback?: VideoFrameRequestCallback } = {};
    Object.defineProperties(video, {
      requestVideoFrameCallback: {
        configurable: true,
        value: (callback: VideoFrameRequestCallback) => {
          videoFrameProof.callback = callback;
          return 7;
        },
      },
      cancelVideoFrameCallback: {
        configurable: true,
        value: () => {
          throw new Error('partial WebKit cancellation');
        },
      },
    });
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    getUserMedia.mockResolvedValue(camera.stream);
    document.getElementById('btn-setup-qr-scan')?.click();
    await runLayoutFrame();
    const proveFrame = videoFrameProof.callback;
    if (!proveFrame) throw new Error('Expected a video frame proof callback');
    proveFrame(0, {} as VideoFrameCallbackMetadata);
    await flushScannerStart();

    expect(video.srcObject).toBe(camera.stream);
    expect(onError).not.toHaveBeenCalled();
  });

  it('closes an active scanner when its camera track ends', async () => {
    const camera = fakeCamera();
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });
    await openScannerWithReadyCamera(camera);

    camera.track.dispatchEvent(new Event('ended'));

    expect(camera.stop).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('camera-start-stalled');
    expect(document.getElementById('setup-qr-camera')?.hidden).toBe(true);
  });

  it('tolerates a transient mute but closes once when the active mute persists', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const camera = fakeCamera();
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });
    await openScannerWithReadyCamera(camera);

    Object.defineProperty(camera.track, 'muted', { configurable: true, value: true });
    camera.track.dispatchEvent(new Event('mute'));
    await vi.advanceTimersByTimeAsync(1_000);
    Object.defineProperty(camera.track, 'muted', { configurable: true, value: false });
    camera.track.dispatchEvent(new Event('unmute'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(camera.stop).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    Object.defineProperty(camera.track, 'muted', { configurable: true, value: true });
    camera.track.dispatchEvent(new Event('mute'));
    await vi.advanceTimersByTimeAsync(1_500);

    expect(camera.stop).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('camera-start-stalled');
  });

  it('does not let a stale decoder failure stop the replacement scanner', async () => {
    const first = fakeCamera();
    const second = fakeCamera();
    const replacementError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError: vi.fn() });
    await openScannerWithReadyCamera(first);

    getUserMedia.mockResolvedValue(second.stream);
    mocks.decodeQr.mockImplementationOnce(() => {
      initGuestQrScanner({
        isCurrent: () => true,
        onCode: vi.fn(),
        onError: replacementError,
      });
      document.getElementById('btn-setup-qr-scan')?.click();
      throw new Error('stale decoder failure');
    });
    runNextFrame(100);
    await runLayoutFrame();
    document.getElementById('setup-qr-video')?.dispatchEvent(new Event('loadeddata'));
    await flushScannerStart();

    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();
    expect((document.getElementById('setup-qr-video') as HTMLVideoElement).srcObject).toBe(
      second.stream,
    );
    expect(replacementError).not.toHaveBeenCalled();
  });

  it('retries once after pending play produces no frame, then starts the second stream', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const first = fakeCamera();
    const second = fakeCamera();
    const pendingPlay = deferred<void>();
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    play.mockReturnValueOnce(pendingPlay.promise).mockResolvedValueOnce(undefined);
    setVideoFrameReady(false);
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    document.getElementById('btn-setup-qr-scan')?.click();
    await runLayoutFrame();
    await vi.advanceTimersByTimeAsync(3_000);
    setVideoFrameReady(true);
    await runLayoutFrame();
    await runLayoutFrame();
    document.getElementById('setup-qr-video')?.dispatchEvent(new Event('loadeddata'));
    await flushScannerStart();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();
    expect((document.getElementById('setup-qr-video') as HTMLVideoElement).srcObject).toBe(
      second.stream,
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports one distinct failure and restores the button after both attempts stall', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const first = fakeCamera();
    const second = fakeCamera({
      width: 1280,
      height: 720,
      frameRate: 30,
      facingMode: 'environment',
    });
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    play.mockReturnValue(new Promise<void>(() => undefined));
    setVideoFrameReady(false);
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    document.getElementById('btn-setup-qr-scan')?.click();
    await runLayoutFrame();
    await vi.advanceTimersByTimeAsync(3_000);
    await runLayoutFrame();
    await runLayoutFrame();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('camera-start-stalled');
    expect(document.getElementById('setup-qr-camera')?.hidden).toBe(true);
    expect(document.getElementById('btn-setup-qr-scan')?.hidden).toBe(false);
    expect(mocks.warn).toHaveBeenCalledWith(
      '[Setup QR] Camera start stalled',
      expect.objectContaining({
        attemptCount: 2,
        phase: 'timeout',
        visibility: 'visible',
        streamActive: true,
        track: expect.objectContaining({
          readyState: 'live',
          settings: {
            width: 1280,
            height: 720,
            frameRate: 30,
            facingMode: 'environment',
          },
        }),
        video: expect.objectContaining({ videoWidth: 0, videoHeight: 0 }),
      }),
    );
  });

  it('keeps a late first play settlement inert after the retry succeeds', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const first = fakeCamera();
    const second = fakeCamera();
    const firstPlay = deferred<void>();
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    play.mockReturnValueOnce(firstPlay.promise).mockResolvedValueOnce(undefined);
    setVideoFrameReady(false);
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    document.getElementById('btn-setup-qr-scan')?.click();
    await runLayoutFrame();
    await vi.advanceTimersByTimeAsync(3_000);
    setVideoFrameReady(true);
    await runLayoutFrame();
    await runLayoutFrame();
    document.getElementById('setup-qr-video')?.dispatchEvent(new Event('loadeddata'));
    await flushScannerStart();
    firstPlay.resolve();
    await flushScannerStart();

    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();
    expect((document.getElementById('setup-qr-video') as HTMLVideoElement).srcObject).toBe(
      second.stream,
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('times out a pending acquisition without starting an overlapping request', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const pending = deferred<MediaStream>();
    const late = fakeCamera();
    getUserMedia.mockReturnValue(pending.promise);
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    document.getElementById('btn-setup-qr-scan')?.click();
    await flushScannerStart();
    await vi.advanceTimersByTimeAsync(12_000);

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('camera-start-stalled');
    expect(document.getElementById('setup-qr-camera')?.hidden).toBe(true);

    pending.resolve(late.stream);
    await flushScannerStart();
    expect(late.stop).toHaveBeenCalledOnce();
  });

  it('silently cancels the watchdog while the document becomes hidden', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const camera = fakeCamera();
    const pendingPlay = deferred<void>();
    getUserMedia.mockResolvedValue(camera.stream);
    play.mockReturnValue(pendingPlay.promise);
    setVideoFrameReady(false);
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    document.getElementById('btn-setup-qr-scan')?.click();
    await runLayoutFrame();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(6_000);

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(camera.stop).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect((document.getElementById('setup-qr-video') as HTMLVideoElement).srcObject).toBeNull();
  });

  it('retries rejected video playback and reports the exhausted startup distinctly', async () => {
    const first = fakeCamera();
    const second = fakeCamera();
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    play.mockRejectedValue(cameraError('NotSupportedError'));
    setVideoFrameReady(false);
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    document.getElementById('btn-setup-qr-scan')?.click();
    await runLayoutFrame();
    await runLayoutFrame();
    await runLayoutFrame();

    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('camera-start-stalled');
  });

  it('cleans up the stream when the decoder throws during a frame', async () => {
    const camera = fakeCamera();
    mocks.decodeQr.mockImplementationOnce(() => {
      throw new Error('decoder failed');
    });
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    await openScannerWithReadyCamera(camera);
    await waitForScannerFrame();
    runNextFrame(100);

    expect(camera.stop).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('camera-unavailable');
    expect(frameCallbacks).toHaveLength(0);
  });
});
