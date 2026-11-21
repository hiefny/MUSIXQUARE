/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createLazyFeatureLoadError,
  isLazyFeatureLoadError,
  wasOfflineLazyFeatureFailure,
} from '../lazy-feature-failure.ts';

/** The browser's own network report, as navigator.onLine gives it. */
function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
}

/** What a dynamic import rejects with when its chunk cannot be fetched. */
function chunkFailure(): TypeError {
  return new TypeError('Failed to fetch dynamically imported module: /assets/runtime-X.js');
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'onLine');
});

// Offline room guidance: a chunk that could not load while the browser
// reported no network was not removed by an update, so the setup line and the
// recovery dialog name the network instead of the update. The failure carries
// nothing that tells the two apart, so the network state of the moment it
// failed is recorded with the latched error and never read again later.
describe('the network state of a lazy feature failure', () => {
  it('records no network at the moment a feature chunk fails', () => {
    setOnline(false);
    const offline = createLazyFeatureLoadError('pro-room', chunkFailure());
    setOnline(true);
    const online = createLazyFeatureLoadError('pro-room', chunkFailure());

    expect(wasOfflineLazyFeatureFailure(offline)).toBe(true);
    expect(wasOfflineLazyFeatureFailure(online)).toBe(false);
  });

  it('keeps that record through a NETWORK_INIT_FAILED wrapper and after the network returns', () => {
    setOnline(false);
    const terminal = createLazyFeatureLoadError('room-session', chunkFailure());
    const wrapped = new Error('NETWORK_INIT_FAILED', { cause: terminal });
    setOnline(true);

    expect(isLazyFeatureLoadError(wrapped)).toBe(true);
    expect(wasOfflineLazyFeatureFailure(terminal)).toBe(true);
    expect(wasOfflineLazyFeatureFailure(wrapped)).toBe(true);
  });

  it('keeps a failure that happened online as an update when it is read again offline', () => {
    const terminal = createLazyFeatureLoadError('room-session', chunkFailure());
    setOnline(false);

    expect(wasOfflineLazyFeatureFailure(terminal)).toBe(false);
    expect(
      wasOfflineLazyFeatureFailure(new Error('NETWORK_INIT_FAILED', { cause: terminal })),
    ).toBe(false);
  });

  it('reads the current state for a feature error that was never latched', () => {
    const raw = chunkFailure();

    setOnline(false);
    expect(wasOfflineLazyFeatureFailure(raw)).toBe(true);
    setOnline(true);
    expect(wasOfflineLazyFeatureFailure(raw)).toBe(false);
  });

  it('reads a cause cycle once', () => {
    const looped = new Error('LOOPED');
    Object.defineProperty(looped, 'cause', { configurable: true, value: looped });

    setOnline(false);
    expect(wasOfflineLazyFeatureFailure(looped)).toBe(true);
    setOnline(true);
    expect(wasOfflineLazyFeatureFailure(looped)).toBe(false);
  });
});
