/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectConnectionType } from '../peer-state.ts';
import type { DataConnection } from '../../types/index.ts';

type Report = Record<string, unknown>;

function fixture() {
  const nativePair = {
    local: { type: 'host', address: '192.0.2.1', port: 41000, protocol: 'udp' },
    remote: { type: 'prflx', address: 'redacted-ip.invalid', port: 42000, protocol: 'udp' },
  } as RTCIceCandidatePair;
  const reports = new Map<string, Report>([
    ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
    [
      'pair',
      {
        id: 'pair',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
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
      },
    ],
  ]);
  const getStats = vi.fn().mockImplementation(async () => reports as unknown as RTCStatsReport);
  const getSelectedCandidatePair = vi.fn(() => nativePair);
  const iceTransport = { getSelectedCandidatePair };
  const pc = { getStats, sctp: { transport: { iceTransport } } };
  const conn = { open: true, peerConnection: pc } as unknown as DataConnection;
  return { nativePair, reports, getStats, getSelectedCandidatePair, iceTransport, pc, conn };
}

async function classify(conn: DataConnection) {
  const result = detectConnectionType(conn);
  await vi.advanceTimersByTimeAsync(12_000);
  return result;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('selected host candidate refinement', () => {
  it('reconciles a privacy-redacted native prflx with the transport-selected host pair', async () => {
    const f = fixture();
    expect(await classify(f.conn)).toBe('local');
    expect(f.getStats).toHaveBeenCalledOnce();
  });

  it('allows mDNS native addresses with browser-redacted stats addresses', async () => {
    const f = fixture();
    Object.assign(f.nativePair.local, { address: 'local-device.local' });
    f.reports.get('local')!.address = '';
    f.reports.get('remote')!.address = '';
    expect(await classify(f.conn)).toBe('local');
  });

  it('waits for the selected stats candidate to refine from prflx to host', async () => {
    const f = fixture();
    const early = new Map(f.reports);
    early.set('remote', { ...f.reports.get('remote'), candidateType: 'prflx' });
    f.getStats.mockResolvedValueOnce(early as unknown as RTCStatsReport);
    expect(await classify(f.conn)).toBe('local');
    expect(f.getStats).toHaveBeenCalledTimes(2);
  });

  it('accepts fresh native dictionaries with unchanged endpoint and generation fields', async () => {
    const f = fixture();
    f.getSelectedCandidatePair.mockImplementation(() => ({
      local: { ...f.nativePair.local },
      remote: { ...f.nativePair.remote },
    }));
    expect(await classify(f.conn)).toBe('local');
  });

  it.each([
    [
      'no transport selection',
      (f: ReturnType<typeof fixture>) => {
        delete f.reports.get('transport')!.selectedCandidatePairId;
        f.reports.get('pair')!.selected = true;
      },
    ],
    [
      'only nominated candidate',
      (f: ReturnType<typeof fixture>) => {
        delete f.reports.get('transport')!.selectedCandidatePairId;
      },
    ],
    [
      'transport selected another route',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('transport')!.selectedCandidatePairId = 'other';
        f.reports.set('other', {
          ...f.reports.get('pair'),
          id: 'other',
          remoteCandidateId: 'relay',
        });
        f.reports.set('relay', { ...f.reports.get('remote'), id: 'relay', candidateType: 'relay' });
      },
    ],
    [
      'ambiguous transport selections',
      (f: ReturnType<typeof fixture>) => {
        f.reports.set('other-transport', { type: 'transport', selectedCandidatePairId: 'other' });
        f.reports.set('other', { ...f.reports.get('pair'), id: 'other' });
      },
    ],
    [
      'in-progress selected pair',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('pair')!.state = 'in-progress';
      },
    ],
    [
      'wrong candidate role',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('remote')!.type = 'local-candidate';
      },
    ],
    [
      'wrong transport backlink',
      (f: ReturnType<typeof fixture>) => {
        f.reports.get('pair')!.transportId = 'other';
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
      'missing stats protocol',
      (f: ReturnType<typeof fixture>) => {
        delete f.reports.get('remote')!.protocol;
      },
    ],
    [
      'missing native port',
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.nativePair.remote, { port: null });
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
        Object.assign(f.nativePair.local, { foundation: 'current' });
        f.reports.get('local')!.foundation = 'other';
      },
    ],
    [
      'different remote ICE generation',
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.nativePair.remote, { usernameFragment: 'current' });
        f.reports.get('remote')!.usernameFragment = 'other';
      },
    ],
  ])('rejects %s as refinement proof', async (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(await classify(f.conn)).toBe('remote');
  });

  it.each(['srflx', 'relay'] as const)('does not reconcile native %s routes', async (type) => {
    const f = fixture();
    Object.assign(f.nativePair.remote, { type });
    expect(await classify(f.conn)).toBe('remote');
    expect(f.getStats).not.toHaveBeenCalled();
  });

  it('keeps the native host/host fast path', async () => {
    const f = fixture();
    Object.assign(f.nativePair.remote, { type: 'host' });
    expect(await classify(f.conn)).toBe('local');
    expect(f.getStats).not.toHaveBeenCalled();
  });

  it('fails closed when stats cannot be read', async () => {
    const f = fixture();
    f.getStats.mockRejectedValue(new Error('stats unavailable'));
    expect(await classify(f.conn)).toBe('remote');
  });

  it.each([
    'closed',
    'native-pair-replaced',
    'ice-transport-replaced',
    'peer-connection-replaced',
    'native-endpoint-mutated',
    'native-generation-mutated',
  ] as const)('rejects a pending stats response after %s', async (change) => {
    const f = fixture();
    let resolve!: (stats: RTCStatsReport) => void;
    f.getStats.mockReturnValue(
      new Promise<RTCStatsReport>((done) => {
        resolve = done;
      }),
    );
    const result = detectConnectionType(f.conn);
    expect(f.getStats).toHaveBeenCalledOnce();
    if (change === 'closed') Object.assign(f.conn, { open: false });
    if (change === 'native-pair-replaced') {
      f.getSelectedCandidatePair.mockReturnValue({
        ...f.nativePair,
        remote: { ...f.nativePair.remote, usernameFragment: 'new-generation' },
      });
    }
    if (change === 'ice-transport-replaced') {
      f.pc.sctp.transport.iceTransport = { getSelectedCandidatePair: vi.fn(() => f.nativePair) };
    }
    if (change === 'peer-connection-replaced')
      Object.assign(f.conn, { peerConnection: { ...f.pc } });
    if (change === 'native-endpoint-mutated') Object.assign(f.nativePair.remote, { port: 42001 });
    if (change === 'native-generation-mutated')
      Object.assign(f.nativePair.remote, { usernameFragment: 'new-generation' });
    resolve(f.reports as unknown as RTCStatsReport);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await result).toBe('remote');
  });
});
