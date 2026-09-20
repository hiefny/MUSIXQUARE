/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isYouTubePrimeReadyForGesture: vi.fn<() => boolean>(),
  waitForYouTubePrimeReady: vi.fn<(signal?: AbortSignal) => Promise<void>>(),
}));

vi.mock('../../youtube/player.ts', () => mocks);

import { gateSetupYouTubeGesture } from '../setup-youtube-gate.ts';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function buttons(): { startButton: HTMLButtonElement; scanButton: HTMLButtonElement } {
  return {
    startButton: document.getElementById('start') as HTMLButtonElement,
    scanButton: document.getElementById('scan') as HTMLButtonElement,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isYouTubePrimeReadyForGesture.mockReturnValue(false);
  document.body.innerHTML = '<button id="start">Start</button><button id="scan">Scan</button>';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('setup YouTube gesture gate', () => {
  it('leaves already ready controls and unrelated disabled state untouched', () => {
    mocks.isYouTubePrimeReadyForGesture.mockReturnValue(true);
    const controls = buttons();
    controls.scanButton.disabled = true;
    const gate = gateSetupYouTubeGesture({ ...controls, waitingLabel: 'Wait' });

    expect(gate.pending).toBe(false);
    expect(mocks.waitForYouTubePrimeReady).not.toHaveBeenCalled();
    expect(controls.startButton.disabled).toBe(false);
    expect(controls.startButton.textContent).toBe('Start');
    gate.cancel();
    expect(controls.scanButton.disabled).toBe(true);
  });

  it('reserves both controls until ready without replaying a click', async () => {
    const readiness = deferred();
    mocks.waitForYouTubePrimeReady.mockReturnValue(readiness.promise);
    const controls = buttons();
    const click = vi.fn();
    controls.startButton.addEventListener('click', click);
    controls.scanButton.addEventListener('click', click);
    const gate = gateSetupYouTubeGesture({ ...controls, waitingLabel: 'Wait' });

    expect(gate.pending).toBe(true);
    expect(controls.startButton.disabled).toBe(true);
    expect(controls.scanButton.disabled).toBe(true);
    expect(controls.startButton.textContent).toBe('Wait');
    expect(controls.startButton.getAttribute('aria-busy')).toBe('true');
    expect(controls.scanButton.getAttribute('aria-busy')).toBe('true');
    controls.startButton.click();
    controls.scanButton.click();
    expect(click).not.toHaveBeenCalled();

    mocks.isYouTubePrimeReadyForGesture.mockReturnValue(true);
    readiness.resolve();
    await Promise.resolve();

    expect(gate.pending).toBe(false);
    expect(controls.startButton.disabled).toBe(false);
    expect(controls.scanButton.disabled).toBe(false);
    expect(controls.startButton.textContent).toBe('Start');
    expect(controls.startButton.hasAttribute('aria-busy')).toBe(false);
    expect(controls.scanButton.getAttribute('aria-busy')).toBe('false');
    expect(click).not.toHaveBeenCalled();
    controls.startButton.click();
    expect(click).toHaveBeenCalledOnce();
  });

  it('releases the controls when the bounded wait expires without readiness', async () => {
    vi.useFakeTimers();
    mocks.waitForYouTubePrimeReady.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    );
    const controls = buttons();
    const gate = gateSetupYouTubeGesture({ ...controls, waitingLabel: 'Wait' });

    await vi.advanceTimersByTimeAsync(4999);
    expect(gate.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.isYouTubePrimeReadyForGesture()).toBe(false);
    expect(gate.pending).toBe(false);
    expect(controls.startButton.disabled).toBe(false);
    expect(controls.scanButton.disabled).toBe(false);
    expect(controls.startButton.textContent).toBe('Start');
  });

  it('releases the controls if preparation rejects', async () => {
    const readiness = deferred();
    mocks.waitForYouTubePrimeReady.mockReturnValue(readiness.promise);
    const controls = buttons();
    const gate = gateSetupYouTubeGesture({ ...controls, waitingLabel: 'Wait' });

    readiness.reject(new Error('API unavailable'));
    await Promise.resolve();

    expect(gate.pending).toBe(false);
    expect(controls.startButton.disabled).toBe(false);
    expect(controls.scanButton.disabled).toBe(false);
    expect(controls.startButton.textContent).toBe('Start');
  });

  it('aborts its wait immediately and keeps a late completion from unlocking the next gate', async () => {
    const first = deferred();
    const second = deferred();
    mocks.waitForYouTubePrimeReady
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const controls = buttons();
    const owner = new AbortController();
    const gate = gateSetupYouTubeGesture({
      ...controls,
      waitingLabel: 'Wait',
      signal: owner.signal,
    });
    const waitSignal = mocks.waitForYouTubePrimeReady.mock.calls[0]?.[0];

    owner.abort();
    expect(gate.pending).toBe(false);
    expect(waitSignal?.aborted).toBe(true);
    expect(controls.startButton.textContent).toBe('Start');
    const next = gateSetupYouTubeGesture({ ...controls, waitingLabel: 'Preparing next room' });
    first.resolve();
    await Promise.resolve();

    expect(next.pending).toBe(true);
    expect(controls.startButton.disabled).toBe(true);
    expect(controls.scanButton.disabled).toBe(true);
    expect(controls.startButton.textContent).toBe('Preparing next room');
    second.resolve();
    await Promise.resolve();
    expect(next.pending).toBe(false);
  });

  it('does not modify replacement controls when detached controls finish preparing', async () => {
    const readiness = deferred();
    mocks.waitForYouTubePrimeReady.mockReturnValue(readiness.promise);
    const gate = gateSetupYouTubeGesture({ ...buttons(), waitingLabel: 'Wait' });
    document.body.innerHTML =
      '<button id="start" disabled aria-busy="true">Joining</button><button id="scan" disabled>Scan</button>';
    const replacements = buttons();

    readiness.resolve();
    await Promise.resolve();

    expect(gate.pending).toBe(false);
    expect(replacements.startButton.disabled).toBe(true);
    expect(replacements.scanButton.disabled).toBe(true);
    expect(replacements.startButton.textContent).toBe('Joining');
    expect(replacements.startButton.getAttribute('aria-busy')).toBe('true');
  });

  it('does not reserve controls for an already aborted owner', () => {
    const owner = new AbortController();
    owner.abort();
    const controls = buttons();
    const gate = gateSetupYouTubeGesture({
      ...controls,
      waitingLabel: 'Wait',
      signal: owner.signal,
    });

    expect(gate.pending).toBe(false);
    expect(mocks.waitForYouTubePrimeReady).not.toHaveBeenCalled();
    expect(controls.startButton.disabled).toBe(false);
    expect(controls.scanButton.disabled).toBe(false);
    expect(controls.startButton.textContent).toBe('Start');
  });
});
