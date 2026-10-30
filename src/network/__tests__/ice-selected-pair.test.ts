import { describe, expect, it } from 'vitest';
import {
  findRefinedHostPair,
  getIceEndpoint,
  nativePairIdentity,
  visibleIceAddress,
} from '../ice-selected-pair.ts';

/**
 * The refinement shared by Standard classification and the PRO LAN-direct
 * rule. iOS Safari (WebKit) clears host and prflx addresses from statistics
 * but keeps foundation, port, protocol and username fragment; Chromium
 * reports them as empty strings. Both keep a native host-to-prflx snapshot
 * after the connection refined to the signaled host candidate.
 */
type Report = Record<string, unknown>;
type Shape = 'webkit' | 'chromium';

function fixture(shape: Shape = 'webkit') {
  const hidden = shape === 'chromium' ? { address: '' } : {};
  const native = {
    local: {
      type: 'host',
      address: '123e4567-e89b-42d3-a456-426614174010.local',
      port: 54321,
      protocol: 'udp',
      foundation: '1394829115',
      usernameFragment: 'ufragLocal9',
    },
    remote: {
      type: 'prflx',
      address: 'redacted-ip.invalid',
      port: 5000,
      protocol: 'udp',
      foundation: '2788118142',
      usernameFragment: 'ufragRemote9',
    },
  } as RTCIceCandidatePair;
  const reports = new Map<string, Report>([
    ['T01', { id: 'T01', type: 'transport', selectedCandidatePairId: 'CP1' }],
    [
      'CP1',
      {
        id: 'CP1',
        type: 'candidate-pair',
        state: 'succeeded',
        transportId: 'T01',
        localCandidateId: 'IL',
        remoteCandidateId: 'IR',
      },
    ],
    [
      'IL',
      {
        id: 'IL',
        type: 'local-candidate',
        candidateType: 'host',
        port: 54321,
        protocol: 'udp',
        foundation: '1394829115',
        usernameFragment: 'ufragLocal9',
        ...hidden,
      },
    ],
    [
      'IR',
      {
        id: 'IR',
        type: 'remote-candidate',
        candidateType: 'host',
        port: 5000,
        protocol: 'udp',
        foundation: 'auto',
        usernameFragment: 'ufragRemote9',
        ...hidden,
      },
    ],
  ]);
  const stats = () => reports as unknown as RTCStatsReport;
  return { native, reports, stats };
}

type Fixture = ReturnType<typeof fixture>;

describe('findRefinedHostPair', () => {
  it.each<Shape>(['webkit', 'chromium'])(
    'returns the transport-selected host pair that refines a %s host-to-prflx snapshot',
    (shape) => {
      const f = fixture(shape);
      expect(findRefinedHostPair(f.stats(), f.native)).toEqual({
        pairId: 'CP1',
        local: f.reports.get('IL'),
        remote: f.reports.get('IR'),
      });
    },
  );

  it('accepts matching visible addresses and fresh native dictionaries', () => {
    const f = fixture();
    f.reports.get('IL')!.address = '123E4567-E89B-42D3-A456-426614174010.local';
    const fresh = { local: { ...f.native.local }, remote: { ...f.native.remote } };
    expect(findRefinedHostPair(f.stats(), fresh as RTCIceCandidatePair)?.pairId).toBe('CP1');
  });

  it.each<[string, (f: Fixture) => void]>([
    [
      'a selected remote still prflx (not refined yet)',
      (f) => {
        f.reports.get('IR')!.candidateType = 'prflx';
      },
    ],
    [
      'a selected relay remote',
      (f) => {
        f.reports.get('IR')!.candidateType = 'relay';
      },
    ],
    [
      'a selected srflx local',
      (f) => {
        f.reports.get('IL')!.candidateType = 'srflx';
      },
    ],
    [
      'no transport selection, even with a nominated or selected pair',
      (f) => {
        delete f.reports.get('T01')!.selectedCandidatePairId;
        f.reports.get('CP1')!.nominated = true;
        f.reports.get('CP1')!.selected = true;
      },
    ],
    [
      'two transports with a selected pair',
      (f) => {
        f.reports.set('T02', { id: 'T02', type: 'transport', selectedCandidatePairId: 'CP1' });
      },
    ],
    [
      'a selected pair that has not succeeded',
      (f) => {
        f.reports.get('CP1')!.state = 'in-progress';
      },
    ],
    [
      'a selected pair without its transport backlink',
      (f) => {
        delete f.reports.get('CP1')!.transportId;
      },
    ],
    [
      'a selected pair of another transport',
      (f) => {
        f.reports.get('CP1')!.transportId = 'T02';
      },
    ],
    [
      'a selected id that is not a candidate pair',
      (f) => {
        f.reports.get('T01')!.selectedCandidatePairId = 'IL';
      },
    ],
    [
      'swapped candidate report types',
      (f) => {
        f.reports.get('IL')!.type = 'remote-candidate';
        f.reports.get('IR')!.type = 'local-candidate';
      },
    ],
    [
      'a missing remote candidate report',
      (f) => {
        f.reports.delete('IR');
      },
    ],
    [
      'another local port',
      (f) => {
        f.reports.get('IL')!.port = 54322;
      },
    ],
    [
      'another remote port',
      (f) => {
        f.reports.get('IR')!.port = 5001;
      },
    ],
    [
      'another protocol',
      (f) => {
        f.reports.get('IR')!.protocol = 'tcp';
      },
    ],
    [
      'a statistics candidate without a port',
      (f) => {
        delete f.reports.get('IR')!.port;
      },
    ],
    [
      'a statistics candidate without a protocol',
      (f) => {
        delete f.reports.get('IL')!.protocol;
      },
    ],
    [
      'a native candidate without a port',
      (f) => {
        Object.assign(f.native.remote, { port: null });
      },
    ],
    [
      'a native candidate without a protocol',
      (f) => {
        Object.assign(f.native.local, { protocol: null });
      },
    ],
    [
      'a different visible local address',
      (f) => {
        f.reports.get('IL')!.address = '192.168.1.10';
      },
    ],
    [
      'a different visible remote address',
      (f) => {
        Object.assign(f.native.remote, { address: '192.168.1.20' });
        f.reports.get('IR')!.address = '123e4567-e89b-42d3-a456-426614174000.local';
      },
    ],
    [
      'another local ICE generation',
      (f) => {
        f.reports.get('IL')!.usernameFragment = 'ufragLocal8';
      },
    ],
    [
      'another remote ICE generation',
      (f) => {
        f.reports.get('IR')!.usernameFragment = 'ufragRemote8';
      },
    ],
    [
      'another local foundation',
      (f) => {
        f.reports.get('IL')!.foundation = '1394829116';
      },
    ],
  ])('refuses %s', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(findRefinedHostPair(f.stats(), f.native)).toBeNull();
  });

  // libwebrtc marks the selected connection in-progress for one round trip
  // around each consent check. A caller that reads the same pair again and
  // again (the PRO live reproof) may accept that state once a check on this
  // connection has had a response; the Standard check keeps 'succeeded'.
  describe('with answered in-progress pairs allowed', () => {
    const options = { allowAnsweredInProgress: true } as const;

    it('accepts an in-progress selected pair that has had a check response', () => {
      const f = fixture();
      Object.assign(f.reports.get('CP1')!, { state: 'in-progress', responsesReceived: 3 });
      expect(findRefinedHostPair(f.stats(), f.native, options)?.pairId).toBe('CP1');
      // Without the option, the shared default is unchanged.
      expect(findRefinedHostPair(f.stats(), f.native)).toBeNull();
    });

    it.each<[string, Report]>([
      ['no check response yet', { state: 'in-progress', responsesReceived: 0 }],
      ['no response count', { state: 'in-progress' }],
      ['a non-numeric response count', { state: 'in-progress', responsesReceived: '3' }],
      ['a failed pair', { state: 'failed', responsesReceived: 3 }],
      ['a waiting pair', { state: 'waiting', responsesReceived: 3 }],
      ['a frozen pair', { state: 'frozen', responsesReceived: 3 }],
    ])('still refuses %s', (_name, fields) => {
      const f = fixture();
      const pair = f.reports.get('CP1')!;
      delete pair.state;
      Object.assign(pair, fields);
      expect(findRefinedHostPair(f.stats(), f.native, options)).toBeNull();
    });
  });
});

describe('ICE selected-pair helpers', () => {
  it('hides redacted and unspecified addresses and lowercases the rest', () => {
    for (const hidden of [
      undefined,
      null,
      '',
      'redacted-ip.invalid',
      'redacted-literal.invalid',
      '0.0.0.0',
      '::',
    ]) {
      expect(visibleIceAddress(hidden)).toBeUndefined();
    }
    expect(visibleIceAddress('FD00::5')).toBe('fd00::5');
  });

  it('reads an endpoint only with a valid port and protocol', () => {
    expect(getIceEndpoint({ port: 5000, protocol: 'udp', address: '' })).toEqual({
      port: 5000,
      protocol: 'udp',
    });
    expect(getIceEndpoint({ port: 0, protocol: 'udp' })).toBeNull();
    expect(getIceEndpoint({ port: 5000, protocol: 'sctp' })).toBeNull();
  });

  it('gives fresh copies one identity and any endpoint or generation change another', () => {
    const f = fixture();
    const identity = nativePairIdentity(f.native);
    expect(
      nativePairIdentity({
        local: { ...f.native.local },
        remote: { ...f.native.remote },
      } as RTCIceCandidatePair),
    ).toBe(identity);
    for (const change of [{ port: 5001 }, { usernameFragment: 'ufragRemote8' }, { type: 'host' }]) {
      expect(
        nativePairIdentity({
          local: f.native.local,
          remote: { ...f.native.remote, ...change },
        } as RTCIceCandidatePair),
      ).not.toBe(identity);
    }
  });
});
