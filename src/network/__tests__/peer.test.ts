/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { safeSend, isRemoteGuest, isTrustedSystemAudioMediaCall } from '../peer.ts';

beforeEach(() => {
  resetState();
  bus.clear();
});

describe('safeSend', () => {
  it('returns false for null connection', () => {
    expect(safeSend(null, { type: 'PING' } as any)).toBe(false);
  });

  it('returns false for undefined connection', () => {
    expect(safeSend(undefined, { type: 'PING' } as any)).toBe(false);
  });

  it('returns false when conn.open is false', () => {
    const conn = { open: false, send: vi.fn() } as any;
    expect(safeSend(conn, { type: 'PING' } as any)).toBe(false);
    expect(conn.send).not.toHaveBeenCalled();
  });

  it('returns true and calls send when conn.open is true', () => {
    const conn = { open: true, send: vi.fn() } as any;
    const msg = { type: 'PING' } as any;
    expect(safeSend(conn, msg)).toBe(true);
    expect(conn.send).toHaveBeenCalledWith(msg);
  });
});

describe('isRemoteGuest', () => {
  it('returns true when connectionType is remote', () => {
    setState('network.connectionType', 'remote');
    expect(isRemoteGuest()).toBe(true);
  });

  it('returns true when connectionType is unknown (default)', () => {
    // default connectionType is 'unknown'
    expect(isRemoteGuest()).toBe(true);
  });

  it('returns false when connectionType is local', () => {
    setState('network.connectionType', 'local');
    expect(isRemoteGuest()).toBe(false);
  });
});

describe('isTrustedSystemAudioMediaCall', () => {
  it('accepts system-audio media calls from the connected host peer', () => {
    setState('network.hostConn', { peer: 'host-123' } as any);

    expect(
      isTrustedSystemAudioMediaCall({
        peer: 'host-123',
        metadata: { type: 'system-audio-synced' },
      }),
    ).toBe(true);
  });

  it('rejects system-audio media calls from non-host peers', () => {
    setState('network.hostConn', { peer: 'host-123' } as any);

    expect(
      isTrustedSystemAudioMediaCall({
        peer: 'guest-evil',
        metadata: { type: 'system-audio-synced' },
      }),
    ).toBe(false);
  });

  it('rejects system-audio media calls when there is no host connection', () => {
    expect(
      isTrustedSystemAudioMediaCall({
        peer: 'guest-evil',
        metadata: { type: 'system-audio-synced' },
      }),
    ).toBe(false);
  });

  it('rejects non-system-audio media calls', () => {
    setState('network.hostConn', { peer: 'host-123' } as any);

    expect(
      isTrustedSystemAudioMediaCall({
        peer: 'host-123',
        metadata: { type: 'camera-call' },
      }),
    ).toBe(false);
  });
});
