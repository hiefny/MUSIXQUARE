/** @vitest-environment jsdom */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  decodeQr: vi.fn(),
}));

vi.mock('jsqr', () => ({
  default: mocks.decodeQr,
}));

import { initGuestQrScanner, stopGuestQrScanner } from '../setup-qr-scanner.ts';

interface FakeStream {
  getTracks: () => Array<{ stop: ReturnType<typeof vi.fn> }>;
}

type FrameCallback = (now: number) => void;

let callbacks = new Map<number, FrameCallback>();
let nextFrameId = 0;
let getUserMedia = vi.fn();
let play = vi.fn();
let pause = vi.fn();
let drawImage = vi.fn();
let getImageData = vi.fn();

function renderScanner(): void {
  document.body.innerHTML = `
    <div id="setup-guest-qr-stage">
      <button id="btn-setup-qr-scan" type="button"></button>
      <div id="setup-qr-camera" hidden>
        <video id="setup-qr-video"></video>
        <button id="btn-setup-qr-close" type="button"></button>
      </div>
    </div>
  `;
}

function fakeStream(): { stream: FakeStream; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn();
  return { stream: { getTracks: () => [{ stop }] }, stop };
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

async function flushScannerStart(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function runNextFrame(now: number): void {
  const entry = callbacks.entries().next().value as [number, FrameCallback] | undefined;
  if (!entry) throw new Error('Expected a queued scanner frame');
  callbacks.delete(entry[0]);
  entry[1](now);
}

async function waitForScannerFrame(): Promise<void> {
  await vi.waitFor(() => expect(callbacks.size).toBeGreaterThan(0));
}

function cameraError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

beforeAll(() => {
  renderScanner();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameCallback) => {
    const id = ++nextFrameId;
    callbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));

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
  callbacks.clear();
  setVisibility('visible');
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

  const video = document.getElementById('setup-qr-video') as HTMLVideoElement;
  Object.defineProperties(video, {
    readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
    videoWidth: { configurable: true, value: 1 },
    videoHeight: { configurable: true, value: 1 },
  });
  const button = document.getElementById('btn-setup-qr-scan') as HTMLButtonElement;
  button.disabled = false;
  button.hidden = false;
});

describe('guest setup QR scanner', () => {
  it('stops every camera track and clears the video when the scanner is cancelled', async () => {
    const { stream, stop } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    const onCode = vi.fn();
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode, onError });

    document.getElementById('btn-setup-qr-scan')?.click();
    await flushScannerStart();
    expect((document.getElementById('setup-qr-video') as HTMLVideoElement).srcObject).toBe(stream);

    document.getElementById('btn-setup-qr-close')?.click();

    expect(stop).toHaveBeenCalledOnce();
    expect((document.getElementById('setup-qr-video') as HTMLVideoElement).srcObject).toBeNull();
    expect(document.getElementById('setup-qr-camera')?.hidden).toBe(true);
    expect(onCode).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['NotFoundError', 'camera-not-found'],
    ['AbortError', 'camera-unavailable'],
  ] as const)('classifies %s without leaving the scanner open', async (name, expected) => {
    getUserMedia.mockRejectedValue(cameraError(name));
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    document.getElementById('btn-setup-qr-scan')?.click();
    await flushScannerStart();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expected);
    expect(document.getElementById('setup-qr-camera')?.hidden).toBe(true);
  });

  it.each(['visibilitychange', 'pagehide'] as const)(
    'discards a late camera stream after %s while permission is pending',
    async (eventName) => {
      const pending = deferred<FakeStream>();
      const { stream, stop } = fakeStream();
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
      pending.resolve(stream);
      await flushScannerStart();

      expect(stop).toHaveBeenCalledOnce();
      expect(play).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it.each(['visibilitychange', 'pagehide'] as const)(
    'stops an active camera immediately on %s',
    async (eventName) => {
      const { stream, stop } = fakeStream();
      getUserMedia.mockResolvedValue(stream);
      initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError: vi.fn() });

      document.getElementById('btn-setup-qr-scan')?.click();
      await flushScannerStart();
      if (eventName === 'visibilitychange') {
        setVisibility('hidden');
        document.dispatchEvent(new Event(eventName));
      } else {
        window.dispatchEvent(new Event(eventName));
      }

      expect(stop).toHaveBeenCalledOnce();
      expect((document.getElementById('setup-qr-video') as HTMLVideoElement).srcObject).toBeNull();
    },
  );

  it('accepts only the canonical domain and emits one join code', async () => {
    const { stream } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    mocks.decodeQr
      .mockReturnValueOnce({ data: 'https://evil.example/musixquare.com/123456' })
      .mockReturnValueOnce({ data: 'https://musixquare.com.evil/123456' })
      .mockReturnValueOnce({ data: 'https://musixquare.com/123456/extra' })
      .mockReturnValueOnce({ data: 'MUSIXQUARE.COM/654321' });
    const onCode = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode, onError: vi.fn() });

    document.getElementById('btn-setup-qr-scan')?.click();
    await waitForScannerFrame();
    runNextFrame(100);
    runNextFrame(200);
    runNextFrame(300);
    runNextFrame(400);

    expect(onCode).toHaveBeenCalledOnce();
    expect(onCode).toHaveBeenCalledWith('654321');
    expect(callbacks).toHaveLength(0);
  });

  it('cleans up the stream when video playback fails', async () => {
    const { stream, stop } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    play.mockRejectedValue(cameraError('NotSupportedError'));
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    document.getElementById('btn-setup-qr-scan')?.click();
    await flushScannerStart();

    expect(stop).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('camera-unavailable');
  });

  it('cleans up the stream when the decoder throws during a frame', async () => {
    const { stream, stop } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    mocks.decodeQr.mockImplementationOnce(() => {
      throw new Error('decoder failed');
    });
    const onError = vi.fn();
    initGuestQrScanner({ isCurrent: () => true, onCode: vi.fn(), onError });

    document.getElementById('btn-setup-qr-scan')?.click();
    await waitForScannerFrame();
    runNextFrame(100);

    expect(stop).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('camera-unavailable');
    expect(callbacks).toHaveLength(0);
  });
});
