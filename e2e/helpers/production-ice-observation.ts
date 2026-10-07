export interface CandidatePairObservation {
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  localType: RTCIceCandidateType | null;
  remoteType: RTCIceCandidateType | null;
  evidence: {
    source: 'native' | 'refined-selected-stats' | 'selected-stats' | 'unproven';
    nativeLocalType: RTCIceCandidateType | null;
    nativeRemoteType: RTCIceCandidateType | null;
    statsLocalType: RTCIceCandidateType | null;
    statsRemoteType: RTCIceCandidateType | null;
    selectedTransportCount: number | null;
    sampleStable: boolean | null;
    endpointProof: boolean | null;
    problem: string | null;
  };
}

/** Independent browser evidence for the nine-local-guest live-test precondition.
 * Keep every runtime helper nested: Playwright serializes this function alone.
 * Evidence contains no addresses, SDP, foundations or ICE credentials.
 */
export async function observeProductionIceTopology(
  key: string,
): Promise<CandidatePairObservation[]> {
  type Candidate = Record<string, unknown>;
  const field = (value: unknown, name: string): unknown => (value as Candidate | undefined)?.[name];
  const string = (value: unknown, name: string): string | undefined => {
    const result = field(value, name);
    return typeof result === 'string' && result ? result : undefined;
  };
  const candidateType = (value: unknown, name: string): RTCIceCandidateType | null => {
    const type = string(value, name);
    return type === 'host' || type === 'prflx' || type === 'srflx' || type === 'relay'
      ? type
      : null;
  };
  const visibleAddress = (candidate: Candidate): string | undefined => {
    const address = string(candidate, 'address');
    return !address ||
      ['redacted-ip.invalid', 'redacted-literal.invalid', '0.0.0.0', '::'].includes(address)
      ? undefined
      : address.toLowerCase();
  };
  const validEndpoint = (candidate: Candidate): boolean => {
    const port = field(candidate, 'port');
    const protocol = string(candidate, 'protocol');
    return (
      typeof port === 'number' &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535 &&
      (protocol === 'udp' || protocol === 'tcp')
    );
  };
  const sameEndpoint = (native: Candidate, stats: Candidate): boolean => {
    const nativeAddress = visibleAddress(native);
    const statsAddress = visibleAddress(stats);
    return (
      validEndpoint(native) &&
      validEndpoint(stats) &&
      native.port === stats.port &&
      native.protocol === stats.protocol &&
      (!nativeAddress || !statsAddress || nativeAddress === statsAddress)
    );
  };
  const sameOptionalField = (native: Candidate, stats: Candidate, name: string): boolean => {
    const left = string(native, name);
    const right = string(stats, name);
    return !left || !right || left === right;
  };
  const readNative = (pc: RTCPeerConnection) => {
    let sctpTransport: RTCSctpTransport | null | undefined;
    let dtlsTransport: RTCDtlsTransport | undefined;
    let transport: RTCIceTransport | undefined;
    try {
      sctpTransport = pc.sctp;
      dtlsTransport = sctpTransport?.transport;
      transport = dtlsTransport?.iceTransport;
      const pair = transport?.getSelectedCandidatePair?.();
      const copy = (candidate: RTCIceCandidate): Candidate =>
        Object.fromEntries(
          ['type', 'address', 'port', 'protocol', 'foundation', 'usernameFragment'].map((name) => [
            name,
            field(candidate, name),
          ]),
        );
      return {
        sctpTransport,
        dtlsTransport,
        transport,
        pair: pair ? { local: copy(pair.local), remote: copy(pair.remote) } : null,
      };
    } catch {
      return {
        sctpTransport,
        dtlsTransport,
        transport,
        pair: null,
      };
    }
  };
  const registry = () =>
    (window as unknown as Record<string, unknown>)[key] as RTCPeerConnection[] | undefined;
  const connections = registry() ?? [];
  const observations: CandidatePairObservation[] = [];

  for (let index = 0; index < connections.length; index += 1) {
    const connection = connections[index]!;
    if (connection.connectionState === 'closed') continue;
    const native = readNative(connection);
    const nativeLocalType = candidateType(native.pair?.local, 'type');
    const nativeRemoteType = candidateType(native.pair?.remote, 'type');
    const evidence: CandidatePairObservation['evidence'] = {
      source: nativeLocalType && nativeRemoteType ? 'native' : 'unproven',
      nativeLocalType,
      nativeRemoteType,
      statsLocalType: null,
      statsRemoteType: null,
      selectedTransportCount: null,
      sampleStable: null,
      endpointProof: null,
      problem: null,
    };
    let localType = nativeLocalType;
    let remoteType = nativeRemoteType;
    const mayRefine = nativeLocalType === 'host' && nativeRemoteType === 'prflx';

    // A complete native route is authoritative except for the documented
    // host/prflx snapshot refinement. Never reinterpret relay/srflx as local.
    if (!nativeLocalType || !nativeRemoteType || mayRefine) {
      const connectionState = connection.connectionState;
      const iceConnectionState = connection.iceConnectionState;
      try {
        const stats = await connection.getStats();
        const current = readNative(connection);
        evidence.sampleStable =
          registry() === connections &&
          connections[index] === connection &&
          connection.connectionState === connectionState &&
          connection.iceConnectionState === iceConnectionState &&
          current.sctpTransport === native.sctpTransport &&
          current.dtlsTransport === native.dtlsTransport &&
          current.transport === native.transport &&
          JSON.stringify(current.pair) === JSON.stringify(native.pair);
        const transports = [...stats.values()].filter(
          (report) => report.type === 'transport' && string(report, 'selectedCandidatePairId'),
        );
        evidence.selectedTransportCount = transports.length;
        const transport = transports.length === 1 ? transports[0] : undefined;
        const pairId = string(transport, 'selectedCandidatePairId');
        const pair = pairId ? stats.get(pairId) : undefined;
        const localId = string(pair, 'localCandidateId');
        const remoteId = string(pair, 'remoteCandidateId');
        const local = localId ? stats.get(localId) : undefined;
        const remote = remoteId ? stats.get(remoteId) : undefined;
        evidence.statsLocalType = candidateType(local, 'candidateType');
        evidence.statsRemoteType = candidateType(remote, 'candidateType');
        const validGraph =
          !!transport &&
          !!string(transport, 'id') &&
          pair?.type === 'candidate-pair' &&
          string(pair, 'state') === 'succeeded' &&
          string(pair, 'transportId') === transport.id &&
          local?.type === 'local-candidate' &&
          remote?.type === 'remote-candidate' &&
          !!evidence.statsLocalType &&
          !!evidence.statsRemoteType;

        if (!evidence.sampleStable) {
          localType = null;
          remoteType = null;
          evidence.source = 'unproven';
          evidence.problem = 'stale-sample';
        } else if (!validGraph || !local || !remote) {
          evidence.problem =
            transports.length !== 1 ? 'ambiguous-selection' : 'invalid-selected-graph';
        } else if (mayRefine && native.pair) {
          evidence.endpointProof =
            sameEndpoint(native.pair.local, local) &&
            sameEndpoint(native.pair.remote, remote) &&
            sameOptionalField(native.pair.local, local, 'foundation') &&
            sameOptionalField(native.pair.local, local, 'usernameFragment') &&
            sameOptionalField(native.pair.remote, remote, 'usernameFragment');
          if (
            evidence.endpointProof &&
            evidence.statsLocalType === 'host' &&
            evidence.statsRemoteType === 'host'
          ) {
            localType = 'host';
            remoteType = 'host';
            evidence.source = 'refined-selected-stats';
          } else {
            evidence.problem = evidence.endpointProof
              ? 'selected-route-not-local'
              : 'endpoint-mismatch';
          }
        } else {
          // When native evidence is absent, use only the explicitly selected
          // graph; an arbitrary succeeded/nominated host pair proves nothing.
          localType = evidence.statsLocalType;
          remoteType = evidence.statsRemoteType;
          evidence.source = 'selected-stats';
        }
      } catch {
        evidence.problem = 'stats-unavailable';
      }
    }

    observations.push({
      connectionState: connection.connectionState,
      iceConnectionState: connection.iceConnectionState,
      localType,
      remoteType,
      evidence,
    });
  }
  return observations;
}
