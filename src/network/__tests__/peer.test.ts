/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wakeLockMocks = vi.hoisted(() => ({
  deactivateNoSleep: vi.fn(),
}));

vi.mock('../../core/wake-lock.ts', () => ({
  deactivateNoSleep: wakeLockMocks.deactivateNoSleep,
}));

import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { clearAllManagedTimers, getManagedTimer, setManagedTimer } from '../../core/timers.ts';
import { detectConnectionType, getPeer, setPeer } from '../peer-state.ts';
import {
  cancelPendingSessionSetup,
  forceStereoSdp,
  isRemoteGuest,
  isTrustedSystemAudioMediaCall,
  leaveSession,
  safeSend,
  sdpPrefersOpusStereo,
  waitForGuestConnectionType,
} from '../peer.ts';
import type { AnyProtocolMsg, DataConnection, PeerInstance } from '../../types/index.ts';
import {
  __accountLoginReturnForTests,
  rememberAccountLoginReturn,
} from '../../account/login-return.ts';

beforeEach(() => {
  vi.useRealTimers();
  clearAllManagedTimers();
  resetState();
  setPeer(null);
  bus.clear();
  sessionStorage.clear();
  localStorage.clear();
  wakeLockMocks.deactivateNoSleep.mockClear();
});

afterEach(() => {
  clearAllManagedTimers();
  setPeer(null);
});

type ConnectionOverrides = Omit<Partial<DataConnection>, 'peerConnection'> & {
  peerConnection?: Pick<RTCPeerConnection, 'getStats'> & Partial<Pick<RTCPeerConnection, 'sctp'>>;
};

function makeConnection(overrides: ConnectionOverrides): DataConnection {
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

function makeSelectedPairPeerConnection(
  localType: RTCIceCandidateType | null,
  remoteType: RTCIceCandidateType | null,
  getStats = vi.fn<RTCPeerConnection['getStats']>(),
): Pick<RTCPeerConnection, 'getStats'> & Partial<Pick<RTCPeerConnection, 'sctp'>> {
  const selectedPair = {
    local: { type: localType },
    remote: { type: remoteType },
  } as RTCIceCandidatePair;
  return {
    getStats,
    sctp: {
      transport: {
        iceTransport: {
          getSelectedCandidatePair: vi.fn(() => selectedPair),
        },
      },
    } as unknown as RTCSctpTransport,
  };
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
    expect(isRemoteGuest()).toBe(true);
  });

  it('returns false when connectionType is local', () => {
    setState('network.connectionType', 'local');
    expect(isRemoteGuest()).toBe(false);
  });
});

describe('leaveSession', () => {
  it('deactivates keep-awake at the common session cleanup boundary', () => {
    leaveSession();

    expect(wakeLockMocks.deactivateNoSleep).toHaveBeenCalledOnce();
  });

  it('preserves page-lifetime service-worker polling while clearing session timers', () => {
    setManagedTimer('sw-update-check', vi.fn(), 60_000, { interval: true });
    setManagedTimer('session-only-test', vi.fn(), 60_000, { interval: true });

    leaveSession();

    expect(getManagedTimer('sw-update-check')).not.toBeNull();
    expect(getManagedTimer('session-only-test')).toBeNull();
  });

  it('settles connection-type waits before clearing session timers', async () => {
    setState('network.connectionType', 'unknown');
    const pending = waitForGuestConnectionType(60_000);

    leaveSession();

    await expect(pending).resolves.toBe('remote');
  });

  it('clears an abandoned login return on explicit leave but preserves it for pagehide', () => {
    rememberAccountLoginReturn('/000001', '000001');
    leaveSession({ preserveAccountLoginReturn: true });
    expect(sessionStorage.getItem(__accountLoginReturnForTests.SESSION_STORAGE_KEY)).not.toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).not.toBeNull();

    leaveSession();
    expect(sessionStorage.getItem(__accountLoginReturnForTests.SESSION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).toBeNull();
  });

  it('clears stale track metadata together with the playlist and playback state', () => {
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'old-room.wav',
      title: 'Old room track',
    });
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');

    leaveSession();

    expect(getState('player.currentTrackMeta')).toBeNull();
    expect(getState('playlist.items')).toEqual([]);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('resets session-scoped setup, transfer, sync, and identity state', () => {
    setState('setup.sessionStarted', true);
    setState('network.myJoinOrder', 3);
    setState('network.lastJoinCode', '123456');
    setState('network.roomPasswordRequired', true);
    setState('network.roomPassword', '12345678');
    setState('transfer.lastReceivedCountSnapshot', 42);
    setState('preload.isPreloading', true);
    setState('preload.sessionId', 7);
    setState('sync.lastLatencyMs', 18);
    setState('sync.latencyHistory', [12, 18]);
    setState('player.isSeeking', true);
    setState('player.decodeFailureCount', 2);
    setState('youtube.currentSubIndex', 4);
    setState('systemAudio.isReceiving', true);

    leaveSession();

    expect(getState('setup.sessionStarted')).toBe(false);
    expect(getState('network.myJoinOrder')).toBe(0);
    expect(getState('network.lastJoinCode')).toBe('');
    expect(getState('network.roomPasswordRequired')).toBe(false);
    expect(getState('network.roomPassword')).toBe('');
    expect(getState('transfer.lastReceivedCountSnapshot')).toBe(0);
    expect(getState('preload.isPreloading')).toBe(false);
    expect(getState('preload.sessionId')).toBe(0);
    expect(getState('sync.lastLatencyMs')).toBe(0);
    expect(getState('sync.latencyHistory')).toEqual([]);
    expect(getState('player.isSeeking')).toBe(false);
    expect(getState('player.decodeFailureCount')).toBe(0);
    expect(getState('youtube.currentSubIndex')).toBe(-1);
    expect(getState('systemAudio.isReceiving')).toBe(false);
  });
});

describe('cancelPendingSessionSetup', () => {
  it('destroys a provisional peer without clearing the local playlist', () => {
    const destroy = vi.fn();
    setPeer({ destroy } as unknown as PeerInstance);
    setState('network.appRole', 'idle');
    setState('setup.sessionStarted', false);
    setState('network.myId', 'provisional-host');
    setState('network.sessionCode', '123456');
    setState('playlist.items', [
      {
        queueItemId: 'queue-1',
        type: 'file',
        name: 'keep-me.wav',
        title: 'Keep me',
        videoId: null,
        playlistId: null,
      },
    ]);

    cancelPendingSessionSetup();

    expect(wakeLockMocks.deactivateNoSleep).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(getPeer()).toBeNull();
    expect(getState('network.myId')).toBeNull();
    expect(getState('network.sessionCode')).toBe('');
    expect(getState('playlist.items')).toHaveLength(1);
  });

  it('does not tear down an already-started session', () => {
    const destroy = vi.fn();
    setPeer({ destroy } as unknown as PeerInstance);
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('network.myId', 'active-host');

    cancelPendingSessionSetup();

    expect(wakeLockMocks.deactivateNoSleep).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(getPeer()).not.toBeNull();
    expect(getState('network.myId')).toBe('active-host');
  });
});

describe('detectConnectionType', () => {
  it('uses the authoritative ICE transport selected pair before getStats', async () => {
    const getStats = vi.fn<RTCPeerConnection['getStats']>();
    const conn = makeConnection({
      open: true,
      peerConnection: makeSelectedPairPeerConnection('host', 'host', getStats),
    });

    await expect(detectConnectionType(conn)).resolves.toBe('local');
    expect(getStats).not.toHaveBeenCalled();
  });

  it('does not replace an exact non-local selected pair with an unselected host-host stats pair', async () => {
    vi.useFakeTimers();
    const stats = makeIceStats([{ id: 'pair-host', localType: 'host', remoteType: 'host' }]);
    const getStats = vi.fn().mockResolvedValue(stats);
    const conn = makeConnection({
      open: true,
      peerConnection: makeSelectedPairPeerConnection('relay', 'srflx', getStats),
    });

    const result = detectConnectionType(conn);
    await vi.advanceTimersByTimeAsync(2500);

    await expect(result).resolves.toBe('remote');
    expect(getStats).not.toHaveBeenCalled();
  });

  it('falls back to selected getStats metadata when the ICE transport API has no pair', async () => {
    const stats = makeIceStats([
      { id: 'pair-host', localType: 'host', remoteType: 'host', selected: true },
    ]);
    const getStats = vi.fn().mockResolvedValue(stats);
    const conn = makeConnection({
      open: true,
      peerConnection: {
        getStats,
        sctp: {
          transport: {
            iceTransport: {
              getSelectedCandidatePair: vi.fn(() => null),
            },
          },
        } as unknown as RTCSctpTransport,
      },
    });

    await expect(detectConnectionType(conn)).resolves.toBe('local');
    expect(getStats).toHaveBeenCalledOnce();
  });

  it('falls back to selected getStats metadata when the ICE transport API throws', async () => {
    const stats = makeIceStats([
      { id: 'pair-host', localType: 'host', remoteType: 'host', selected: true },
    ]);
    const getStats = vi.fn().mockResolvedValue(stats);
    const conn = makeConnection({
      open: true,
      peerConnection: {
        getStats,
        sctp: {
          transport: {
            iceTransport: {
              getSelectedCandidatePair: vi.fn(() => {
                throw new Error('unsupported');
              }),
            },
          },
        } as unknown as RTCSctpTransport,
      },
    });

    await expect(detectConnectionType(conn)).resolves.toBe('local');
    expect(getStats).toHaveBeenCalledOnce();
  });

  it('classifies the selected host-host ICE pair as local', async () => {
    const stats = makeIceStats([
      { id: 'pair-host', localType: 'host', remoteType: 'host', selected: true },
    ]);
    const conn = makeConnection({
      open: true,
      peerConnection: { getStats: vi.fn().mockResolvedValue(stats) },
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
      peerConnection: { getStats: vi.fn().mockResolvedValue(stats) },
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
      'a=fmtp:111 minptime=10; stereo=1; sprop-stereo=1; maxaveragebitrate=256000; useinbandfec=1',
    );
  });

  it('adds an fmtp line when opus has none', () => {
    const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', ''].join(
      '\r\n',
    );

    const result = forceStereoSdp(sdp);

    expect(result).toContain(
      'a=fmtp:111 stereo=1; sprop-stereo=1; maxaveragebitrate=256000; useinbandfec=1',
    );
  });

  it('recognizes only an explicit stereo preference on an Opus payload', () => {
    const stereo = [
      'v=0',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10; STEREO = 1; useinbandfec=1',
      '',
    ].join('\r\n');
    const mono = stereo.replace('STEREO = 1', 'stereo=0');
    const wrongPayload = stereo.replace('a=fmtp:111', 'a=fmtp:112');

    expect(sdpPrefersOpusStereo(stereo)).toBe(true);
    expect(sdpPrefersOpusStereo(mono)).toBe(false);
    expect(sdpPrefersOpusStereo(wrongPayload)).toBe(false);
  });
});

describe('isTrustedSystemAudioMediaCall', () => {
  it('accepts system-audio media calls from the connected host peer', () => {
    setState('network.hostConn', makeConnection({ peer: 'host-123' }));

    expect(
      isTrustedSystemAudioMediaCall({
        peer: 'host-123',
        metadata: { type: 'system-audio-stereo' },
      }),
    ).toBe(true);
  });

  it('rejects system-audio media calls from non-host peers', () => {
    setState('network.hostConn', makeConnection({ peer: 'host-123' }));

    expect(
      isTrustedSystemAudioMediaCall({
        peer: 'guest-evil',
        metadata: { type: 'system-audio-stereo' },
      }),
    ).toBe(false);
  });

  it('rejects system-audio media calls when there is no host connection', () => {
    expect(
      isTrustedSystemAudioMediaCall({
        peer: 'guest-evil',
        metadata: { type: 'system-audio-stereo' },
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

  it.each(['system-audio', 'system-audio-dual', 'system-audio-synced'])(
    'rejects the removed %s legacy media contract',
    (type) => {
      setState('network.hostConn', makeConnection({ peer: 'host-123' }));

      expect(
        isTrustedSystemAudioMediaCall({
          peer: 'host-123',
          metadata: { type },
        }),
      ).toBe(false);
    },
  );
});
