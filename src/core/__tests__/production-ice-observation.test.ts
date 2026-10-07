import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  observeProductionIceTopology,
  type CandidatePairObservation,
} from '../../../e2e/helpers/production-ice-observation.ts';

type Report = Record<string, unknown>;
const PROBE_KEY = '__production_ice_observation_fixture__';

function fixture() {
  const nativePair = {
    local: {
      type: 'host',
      address: '192.0.2.1',
      port: 41000,
      protocol: 'udp',
      foundation: 'local-foundation',
      usernameFragment: 'local-generation',
    },
    remote: {
      type: 'prflx',
      address: 'redacted-ip.invalid',
      port: 42000,
      protocol: 'udp',
      usernameFragment: 'remote-generation',
    },
  } as RTCIceCandidatePair;
  const reports = new Map<string, Report>([
    ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
    [
      'pair',
      {
        id: 'pair',
        type: 'candidate-pair',
        state: 'succeeded',
        transportId: 'transport',
        localCandidateId: 'local',
        remoteCandidateId: 'remote',
      },
    ],
    [
      'local',
      {
        id: 'local',
        type: 'local-candidate',
        candidateType: 'host',
        address: '192.0.2.1',
        port: 41000,
        protocol: 'udp',
        foundation: 'local-foundation',
        usernameFragment: 'local-generation',
      },
    ],
    [
      'remote',
      {
        id: 'remote',
        type: 'remote-candidate',
        candidateType: 'host',
        address: '192.0.2.2',
        port: 42000,
        protocol: 'udp',
        usernameFragment: 'remote-generation',
      },
    ],
  ]);
  const getStats = vi.fn(async () => reports as unknown as RTCStatsReport);
  const getSelectedCandidatePair = vi.fn<() => RTCIceCandidatePair | null>(() => nativePair);
  const iceTransport = { getSelectedCandidatePair };
  const transport = { iceTransport };
  const pc = {
    connectionState: 'connected' as RTCPeerConnectionState,
    iceConnectionState: 'connected' as RTCIceConnectionState,
    getStats,
    sctp: { transport },
  };
  vi.stubGlobal('window', { [PROBE_KEY]: [pc] });
  return { nativePair, reports, getStats, getSelectedCandidatePair, iceTransport, transport, pc };
}

function localPairs(observations: CandidatePairObservation[]) {
  return observations.filter(
    (pair) =>
      pair.connectionState === 'connected' &&
      pair.localType === 'host' &&
      pair.remoteType === 'host',
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('production selected ICE observation', () => {
  it('keeps the complete native host/host fast path', async () => {
    const f = fixture();
    Object.assign(f.nativePair.remote, { type: 'host' });
    expect(localPairs(await observeProductionIceTopology(PROBE_KEY))).toHaveLength(1);
    expect(f.getStats).not.toHaveBeenCalled();
  });

  it('refines a complete native host/prflx snapshot with canonical selected host/host stats', async () => {
    const f = fixture();
    expect(f.reports.get('pair')).not.toHaveProperty('selected');
    expect(f.reports.get('pair')).not.toHaveProperty('nominated');
    expect(localPairs(await observeProductionIceTopology(PROBE_KEY))).toHaveLength(1);
    expect(f.getStats).toHaveBeenCalledOnce();
  });

  it('uses transport selection without legacy selected or nominated flags when native data is absent', async () => {
    const f = fixture();
    f.getSelectedCandidatePair.mockReturnValue(null);
    expect(localPairs(await observeProductionIceTopology(PROBE_KEY))).toHaveLength(1);
    expect(f.getStats).toHaveBeenCalledOnce();
  });

  it('accepts fresh native dictionaries with the same endpoint and generation identity', async () => {
    const f = fixture();
    f.getSelectedCandidatePair.mockImplementation(() => ({
      local: { ...f.nativePair.local },
      remote: { ...f.nativePair.remote },
    }));
    expect(localPairs(await observeProductionIceTopology(PROBE_KEY))).toHaveLength(1);
  });

  it('allows mDNS and browser-redacted addresses without discarding endpoint and generation checks', async () => {
    const f = fixture();
    Object.assign(f.nativePair.local, { address: 'local-device.local' });
    f.reports.get('local')!.address = '';
    f.reports.get('remote')!.address = '';
    expect(localPairs(await observeProductionIceTopology(PROBE_KEY))).toHaveLength(1);
  });

  it.each(['srflx', 'relay'] as const)(
    'does not refine a native %s route into local',
    async (type) => {
      const f = fixture();
      Object.assign(f.nativePair.remote, { type });
      expect(localPairs(await observeProductionIceTopology(PROBE_KEY))).toHaveLength(0);
      expect(f.getStats).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'missing canonical selection despite a legacy selected flag',
      (f: ReturnType<typeof fixture>) => {
        delete f.reports.get('transport')!.selectedCandidatePairId;
        f.reports.get('pair')!.selected = true;
      },
    ],
    [
      'merely nominated succeeded pair',
      (f: ReturnType<typeof fixture>) => {
        delete f.reports.get('transport')!.selectedCandidatePairId;
        f.reports.get('pair')!.nominated = true;
      },
    ],
    [
      'ambiguous transport selections',
      (f: ReturnType<typeof fixture>) => {
        f.reports.set('other-transport', {
          id: 'other-transport',
          type: 'transport',
          selectedCandidatePairId: 'other-pair',
        });
        f.reports.set('other-pair', {
          ...f.reports.get('pair'),
          id: 'other-pair',
          transportId: 'other-transport',
        });
      },
    ],
    [
      'selected remote route despite a nominated host/host pair',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('pair')!.nominated = true;
        f.reports.get('transport')!.selectedCandidatePairId = 'remote-pair';
        f.reports.set('remote-pair', {
          ...f.reports.get('pair'),
          id: 'remote-pair',
          remoteCandidateId: 'relay',
        });
        f.reports.set('relay', {
          ...f.reports.get('remote'),
          id: 'relay',
          candidateType: 'relay',
        });
      },
    ],
    [
      'in-progress selected pair',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('pair')!.state = 'in-progress';
      },
    ],
    [
      'wrong transport backlink',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('pair')!.transportId = 'other';
      },
    ],
    [
      'missing transport identity and pair backlink',
      (f: ReturnType<typeof fixture>) => {
        delete f.reports.get('transport')!.id;
        delete f.reports.get('pair')!.transportId;
      },
    ],
    [
      'empty transport identity and pair backlink',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('transport')!.id = '';
        f.reports.get('pair')!.transportId = '';
      },
    ],
    [
      'wrong candidate role',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('remote')!.type = 'local-candidate';
      },
    ],
    [
      'missing selected pair',
      (f: ReturnType<typeof fixture>) => {
        f.reports.delete('pair');
      },
    ],
    [
      'missing remote candidate',
      (f: ReturnType<typeof fixture>) => {
        f.reports.delete('remote');
      },
    ],
    [
      'different local port',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('local')!.port = 41001;
      },
    ],
    [
      'different remote port',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('remote')!.port = 42001;
      },
    ],
    [
      'invalid stats port',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('remote')!.port = 0;
      },
    ],
    [
      'out-of-range native port',
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.nativePair.remote, { port: 65536 });
      },
    ],
    [
      'different protocol',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('remote')!.protocol = 'tcp';
      },
    ],
    [
      'missing stats port',
      (f: ReturnType<typeof fixture>) => {
        delete f.reports.get('remote')!.port;
      },
    ],
    [
      'missing native protocol',
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.nativePair.remote, { protocol: null });
      },
    ],
    [
      'visible local address mismatch',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('local')!.address = '192.0.2.3';
      },
    ],
    [
      'visible remote address mismatch',
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.nativePair.remote, { address: '192.0.2.3' });
      },
    ],
    [
      'different local foundation',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('local')!.foundation = 'other';
      },
    ],
    [
      'different local ICE generation',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('local')!.usernameFragment = 'other';
      },
    ],
    [
      'different remote ICE generation',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('remote')!.usernameFragment = 'other';
      },
    ],
  ])('rejects %s as host/prflx refinement proof', async (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(localPairs(await observeProductionIceTopology(PROBE_KEY))).toHaveLength(0);
  });

  it.each(['selected', 'nominated'] as const)(
    'does not accept an arbitrary %s pair when native data is absent',
    async (flag) => {
      const f = fixture();
      f.getSelectedCandidatePair.mockReturnValue(null);
      delete f.reports.get('transport')!.selectedCandidatePairId;
      f.reports.get('pair')![flag] = true;
      expect(localPairs(await observeProductionIceTopology(PROBE_KEY))).toHaveLength(0);
    },
  );

  it.each([
    'closed',
    'disconnected',
    'failed-ice',
    'sctp-transport-replaced',
    'dtls-transport-replaced',
    'ice-transport-replaced',
    'probe-registry-replaced',
    'peer-connection-replaced',
    'native-pair-replaced',
    'native-endpoint-mutated',
    'native-generation-mutated',
  ] as const)('rejects pending refinement after %s', async (change) => {
    const f = fixture();
    let resolve!: (stats: RTCStatsReport) => void;
    f.getStats.mockReturnValue(
      new Promise<RTCStatsReport>((done) => {
        resolve = done;
      }),
    );
    const pending = observeProductionIceTopology(PROBE_KEY);
    expect(f.getStats).toHaveBeenCalledOnce();
    if (change === 'closed') f.pc.connectionState = 'closed';
    if (change === 'disconnected') f.pc.connectionState = 'disconnected';
    if (change === 'failed-ice') f.pc.iceConnectionState = 'failed';
    if (change === 'sctp-transport-replaced') f.pc.sctp = { ...f.pc.sctp };
    if (change === 'dtls-transport-replaced') f.pc.sctp.transport = { ...f.transport };
    if (change === 'ice-transport-replaced')
      f.transport.iceTransport = { getSelectedCandidatePair: vi.fn(() => f.nativePair) };
    if (change === 'probe-registry-replaced') vi.stubGlobal('window', { [PROBE_KEY]: [f.pc] });
    if (change === 'peer-connection-replaced') {
      const connections = (window as unknown as Record<string, unknown>)[PROBE_KEY] as Array<
        typeof f.pc
      >;
      connections[0] = { ...f.pc };
    }
    if (change === 'native-pair-replaced') {
      f.getSelectedCandidatePair.mockReturnValue({
        local: { ...f.nativePair.local },
        remote: { ...f.nativePair.remote, usernameFragment: 'new-generation' },
      });
    }
    if (change === 'native-endpoint-mutated') Object.assign(f.nativePair.remote, { port: 42001 });
    if (change === 'native-generation-mutated')
      Object.assign(f.nativePair.remote, { usernameFragment: 'new-generation' });
    resolve(f.reports as unknown as RTCStatsReport);
    expect(localPairs(await pending)).toHaveLength(0);
  });

  it('keeps a closed connection out of the observation list', async () => {
    const f = fixture();
    f.pc.connectionState = 'closed';
    expect(await observeProductionIceTopology(PROBE_KEY)).toEqual([]);
    expect(f.getStats).not.toHaveBeenCalled();
  });

  it('fails closed if the stats request rejects', async () => {
    const f = fixture();
    f.getStats.mockRejectedValue(new Error('stats unavailable'));
    expect(localPairs(await observeProductionIceTopology(PROBE_KEY))).toHaveLength(0);
  });

  it('does not expose addresses or ICE identity values in diagnostics', async () => {
    const f = fixture();
    const output = JSON.stringify(await observeProductionIceTopology(PROBE_KEY));
    for (const value of [
      f.nativePair.local.address,
      f.nativePair.remote.address,
      f.nativePair.local.foundation,
      f.nativePair.local.usernameFragment,
      f.nativePair.remote.usernameFragment,
    ]) {
      expect(value).toBeTruthy();
      expect(output).not.toContain(value);
    }
  });

  it('can use canonical selected stats when the native getter throws', async () => {
    const f = fixture();
    f.getSelectedCandidatePair.mockImplementation(() => {
      throw new Error('native observation unavailable');
    });
    expect(localPairs(await observeProductionIceTopology(PROBE_KEY))).toHaveLength(1);
  });

  it('treats an absent probe collection as empty', async () => {
    vi.stubGlobal('window', {});
    expect(await observeProductionIceTopology(PROBE_KEY)).toEqual([]);
  });
});
