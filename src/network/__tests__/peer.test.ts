/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { detectConnectionType } from '../peer-state.ts';
import { forceStereoSdp, safeSend, isRemoteGuest, isTrustedSystemAudioMediaCall } from '../peer.ts';
import type { AnyProtocolMsg, DataConnection } from '../../types/index.ts';

beforeEach(() => {
  vi.useRealTimers();
  resetState();
  bus.clear();
});

function makeConnection(overrides: Partial<DataConnection>): DataConnection {
  return overrides as DataConnection;
}

function makeMessage(): AnyProtocolMsg {
  return { type: MSG.SYSTEM_AUDIO_START };
}

function makeIceStats(
  pairs: Array<{
    id: string;
    localType: string;
    remoteType: string;
    selected?: boolean;
    nominated?: boolean;
  }>,
): RTCStatsReport {
  const entries: [string, RTCStats][] = [
    ['transport', { id: 'transport', type: 'transport', timestamp: 0 } as RTCStats],
  ];

  for (const pair of pairs) {
    const localId = `${pair.id}-local`;
    const remoteId = `${pair.id}-remote`;
    entries.push([
      localId,
      {
        id: localId,
        type: 'local-candidate',
        timestamp: 0,
        candidateType: pair.localType,
      } as unknown as RTCStats,
    ]);
    entries.push([
      remoteId,
      {
        id: remoteId,
        type: 'remote-candidate',
        timestamp: 0,
        candidateType: pair.remoteType,
      } as unknown as RTCStats,
    ]);
    entries.push([
      pair.id,
      {
        id: pair.id,
        type: 'candidate-pair',
        timestamp: 0,
        state: 'succeeded',
        localCandidateId: localId,
        remoteCandidateId: remoteId,
        selected: pair.selected,
        nominated: pair.nominated,
      } as unknown as RTCStats,
    ]);
  }

  return new Map(entries) as unknown as RTCStatsReport;
}

describe('safeSend', () => {
  it('returns false for null connection', () => {
    expect(safeSend(null, makeMessage())).toBe(false);
  });

  it('returns false for undefined connection', () => {
    expect(safeSend(undefined, makeMessage())).toBe(false);
  });

  it('returns false when conn.open is false', () => {
    const conn = makeConnection({ open: false, send: vi.fn() });
    expect(safeSend(conn, makeMessage())).toBe(false);
    expect(conn.send).not.toHaveBeenCalled();
  });

  it('returns true and calls send when conn.open is true', () => {
    const conn = makeConnection({ open: true, send: vi.fn() });
    const msg = makeMessage();
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

describe('detectConnectionType', () => {
  it('classifies the selected host-host ICE pair as local', async () => {
    const stats = makeIceStats([
      { id: 'pair-host', localType: 'host', remoteType: 'host', selected: true },
    ]);
    const conn = makeConnection({
      open: true,
      peerConnection: {
        getStats: vi.fn().mockResolvedValue(stats),
      } as unknown as RTCPeerConnection,
    });

    await expect(detectConnectionType(conn)).resolves.toBe('local');
  });

  it('does not classify an unselected host-host pair as local when relay is selected', async () => {
    vi.useFakeTimers();
    const stats = makeIceStats([
      { id: 'pair-relay', localType: 'relay', remoteType: 'srflx', selected: true },
      { id: 'pair-host', localType: 'host', remoteType: 'host' },
    ]);
    const conn = makeConnection({
      open: true,
      peerConnection: {
        getStats: vi.fn().mockResolvedValue(stats),
      } as unknown as RTCPeerConnection,
    });

    const result = detectConnectionType(conn);
    await vi.advanceTimersByTimeAsync(2500);

    await expect(result).resolves.toBe('remote');
  });
});

describe('forceStereoSdp', () => {
  it('preserves the required fmtp payload separator when replacing first params', () => {
    const sdp = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 stereo=1;minptime=10;useinbandfec=1',
      '',
    ].join('\r\n');

    const result = forceStereoSdp(sdp);

    expect(result).toContain('a=fmtp:111 minptime=10; stereo=1;');
    expect(result).not.toContain('a=fmtp:111;');
  });

  it('preserves unrelated fmtp params while replacing stereo tuning params', () => {
    const sdp = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=32000',
      '',
    ].join('\r\n');

    const result = forceStereoSdp(sdp);

    expect(result).toContain(
      'a=fmtp:111 minptime=10; stereo=1; sprop-stereo=1; maxaveragebitrate=128000; useinbandfec=1',
    );
  });

  it('adds an fmtp line when opus has none', () => {
    const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', ''].join(
      '\r\n',
    );

    const result = forceStereoSdp(sdp);

    expect(result).toContain(
      'a=fmtp:111 stereo=1; sprop-stereo=1; maxaveragebitrate=128000; useinbandfec=1',
    );
  });
});

describe('isTrustedSystemAudioMediaCall', () => {
  it('accepts system-audio media calls from the connected host peer', () => {
    setState('network.hostConn', makeConnection({ peer: 'host-123' }));

    expect(
      isTrustedSystemAudioMediaCall({
        peer: 'host-123',
        metadata: { type: 'system-audio-synced' },
      }),
    ).toBe(true);
  });

  it('rejects system-audio media calls from non-host peers', () => {
    setState('network.hostConn', makeConnection({ peer: 'host-123' }));

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
    setState('network.hostConn', makeConnection({ peer: 'host-123' }));

    expect(
      isTrustedSystemAudioMediaCall({
        peer: 'host-123',
        metadata: { type: 'camera-call' },
      }),
    ).toBe(false);
  });
});
