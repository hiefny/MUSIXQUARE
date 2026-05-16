import { describe, expect, it } from 'vitest';
import {
  getPublicSignalingUrlForHost,
  isLocalTransportHost,
  resolveTransportProviderForHost,
} from '../config.ts';

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
  });

  it('keeps localhost available for PeerJS development', () => {
    expect(isLocalTransportHost('localhost')).toBe(true);
    expect(isLocalTransportHost('127.0.0.1')).toBe(true);
    expect(isLocalTransportHost('::1')).toBe(true);
    expect(getPublicSignalingUrlForHost('localhost')).toBeUndefined();
  });

  it('forces Cloudflare transport on public hosts even if PeerJS is requested', () => {
    expect(resolveTransportProviderForHost('peerjs', undefined, 'musixquare.com')).toBe(
      'cloudflare',
    );
    expect(resolveTransportProviderForHost('peerjs', undefined, 'musixquare.apps.tossmini.com')).toBe(
      'cloudflare',
    );
  });

  it('preserves local transport override behavior', () => {
    expect(resolveTransportProviderForHost('peerjs', undefined, 'localhost')).toBe('peerjs');
    expect(resolveTransportProviderForHost('auto', undefined, 'localhost')).toBe('peerjs');
    expect(resolveTransportProviderForHost('auto', 'wss://signal.example.test', 'localhost')).toBe(
      'cloudflare',
    );
  });
});
