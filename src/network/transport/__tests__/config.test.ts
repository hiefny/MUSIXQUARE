import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPublicSignalingUrlForHost,
  getRuntimeTransportConfig,
  isLocalTransportHost,
  normalizeSignalingFallbackUrl,
  resolveTransportProviderForHost,
} from '../config.ts';

beforeEach(() => {
  vi.stubGlobal('window', {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('transport config', () => {
  it('uses public Cloudflare signaling on production and preview hosts', () => {
    expect(getPublicSignalingUrlForHost('musixquare.com')).toBe(
      'wss://signal.musixquare.com/api/rooms',
    );
    expect(getPublicSignalingUrlForHost('www.musixquare.com')).toBe(
      'wss://signal.musixquare.com/api/rooms',
    );
    expect(getPublicSignalingUrlForHost('musixquare.apps.tossmini.com')).toBe(
      'wss://signal.musixquare.com/api/rooms',
    );
    expect(getPublicSignalingUrlForHost('musixquare.private-apps.tossmini.com')).toBe(
      'wss://signal.musixquare.com/api/rooms',
    );
    expect(getRuntimeTransportConfig('musixquare.com').signalingFallbackUrl).toBe(
      'wss://signal-alt.musixquare.com/api/rooms',
    );
  });

  it('keeps localhost available for PeerJS development', () => {
    expect(isLocalTransportHost('localhost')).toBe(true);
    expect(isLocalTransportHost('127.0.0.1')).toBe(true);
    expect(isLocalTransportHost('::1')).toBe(true);
    expect(getPublicSignalingUrlForHost('localhost')).toBeUndefined();
    expect(getRuntimeTransportConfig('localhost').signalingFallbackUrl).toBeUndefined();
  });

  it('defaults the fallback only for the exact public signaling route', () => {
    expect(getRuntimeTransportConfig('musixquare.com').signalingFallbackUrl).toBe(
      'wss://signal-alt.musixquare.com/api/rooms',
    );

    (
      window as Window & {
        __MUSIXQUARE_TRANSPORT__?: { signalingUrl?: string };
      }
    ).__MUSIXQUARE_TRANSPORT__ = {
      signalingUrl: 'wss://custom-signal.example.test/api/rooms',
    };
    expect(getRuntimeTransportConfig('musixquare.com').signalingFallbackUrl).toBeUndefined();
  });

  it('validates and deduplicates a separately configured fallback route', () => {
    expect(
      normalizeSignalingFallbackUrl(
        'https://signal.example.test/api/rooms/',
        'wss://signal-alt.example.test/api/rooms/',
      ),
    ).toBe('wss://signal-alt.example.test/api/rooms');
    expect(
      normalizeSignalingFallbackUrl(
        'wss://signal.example.test/api/rooms',
        'wss://signal.example.test/api/rooms',
      ),
    ).toBeUndefined();
    expect(
      normalizeSignalingFallbackUrl(
        'wss://signal.example.test/api/rooms',
        'ws://signal-alt.example.test/api/rooms',
      ),
    ).toBeUndefined();
    expect(
      normalizeSignalingFallbackUrl(
        'wss://signal.example.test/api/rooms',
        'wss://signal-alt.example.test/api/other',
      ),
    ).toBeUndefined();
    expect(
      normalizeSignalingFallbackUrl(
        'wss://signal.example.test/api/rooms',
        'wss://user:secret@signal-alt.example.test/api/rooms?token=secret',
      ),
    ).toBeUndefined();
  });

  it('forces Cloudflare transport on public hosts even if PeerJS is requested', () => {
    expect(resolveTransportProviderForHost('peerjs', undefined, 'musixquare.com')).toBe(
      'cloudflare',
    );
    expect(
      resolveTransportProviderForHost('peerjs', undefined, 'musixquare.apps.tossmini.com'),
    ).toBe('cloudflare');
    expect(
      resolveTransportProviderForHost('peerjs', undefined, 'musixquare.private-apps.tossmini.com'),
    ).toBe('cloudflare');
  });

  it('preserves local transport override behavior', () => {
    expect(resolveTransportProviderForHost('peerjs', undefined, 'localhost')).toBe('peerjs');
    expect(resolveTransportProviderForHost('auto', undefined, 'localhost')).toBe('peerjs');
    expect(resolveTransportProviderForHost('auto', 'wss://signal.example.test', 'localhost')).toBe(
      'cloudflare',
    );
  });
});
