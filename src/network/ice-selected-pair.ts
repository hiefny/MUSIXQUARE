/**
 * Selected ICE pair refinement, shared by the Standard connection-type
 * classification (`peer-state.ts`) and the PRO system-audio LAN-direct
 * locality rule (`pro-system-audio-direct.ts`). Leaf module: it imports
 * nothing.
 *
 * libwebrtc creates a peer-reflexive (prflx) remote candidate when a peer's
 * connectivity check arrives before the signaled candidate for that address is
 * usable, for example while its mDNS name is still being resolved. Adding the
 * resolved host candidate later turns that same connection's remote candidate
 * into the host one in place (`Connection::MaybeUpdatePeerReflexiveCandidate`
 * requires the same address, port, protocol, username fragment and
 * generation), but no selected-pair change fires. Chromium's and WebKit's
 * native `RTCIceTransport.getSelectedCandidatePair()` snapshot therefore keeps
 * the prflx remote while getStats() already reports the refined host
 * candidate.
 *
 * Only the uniquely transport-selected, succeeded host-to-host statistics pair
 * whose endpoints and generation fields match the native snapshot can stand in
 * for it. Nominated or merely succeeded pairs never can. Callers add their own
 * policy: the PRO rule still requires its mDNS candidate ledger and address
 * checks on the returned candidates.
 */

interface IceEndpoint {
  port: number;
  protocol: string;
  address?: string;
}

/** The refined statistics graph that may stand in for a native host-to-prflx snapshot. */
interface RefinedHostPair {
  pairId: string;
  local: RTCStats;
  remote: RTCStats;
}

function readString(report: unknown, key: string): string | undefined {
  const value = (report as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** A native or statistics candidate's port and protocol, and its address when exposed. */
export function getIceEndpoint(candidate: unknown): IceEndpoint | null {
  const port = (candidate as Record<string, unknown> | undefined)?.port;
  const protocol = readString(candidate, 'protocol');
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65535 ||
    (protocol !== 'udp' && protocol !== 'tcp')
  )
    return null;
  const address = readString(candidate, 'address');
  return { port, protocol, ...(address ? { address } : {}) };
}

/** An address the browser actually exposed: redacted and unspecified values are hidden. */
export function visibleIceAddress(address: string | null | undefined): string | undefined {
  // Browsers redact prflx addresses and may omit host addresses from stats.
  if (
    !address ||
    ['redacted-ip.invalid', 'redacted-literal.invalid', '0.0.0.0', '::'].includes(address)
  ) {
    return undefined;
  }
  return address.toLowerCase();
}

function sameIceEndpoint(native: IceEndpoint, statsCandidate: unknown): boolean {
  const stats = getIceEndpoint(statsCandidate);
  if (!stats || native.port !== stats.port || native.protocol !== stats.protocol) return false;
  const nativeAddress = visibleIceAddress(native.address);
  const statsAddress = visibleIceAddress(stats.address);
  return !nativeAddress || !statsAddress || nativeAddress === statsAddress;
}

/** Native dictionaries can be fresh per call: compare their endpoint and generation fields. */
export function nativePairIdentity(pair: RTCIceCandidatePair): string {
  return JSON.stringify(
    [pair.local, pair.remote].map((candidate) => [
      candidate.type,
      candidate.address,
      candidate.port,
      candidate.protocol,
      candidate.foundation,
      candidate.usernameFragment,
    ]),
  );
}

/**
 * The uniquely transport-selected, succeeded host-to-host statistics pair that
 * refines this native snapshot, or null. Its endpoints must match the native
 * pair's (port, protocol and any address both sides expose), and where exposed
 * the ICE username fragments and the local foundation must agree. A native
 * candidate without a port or protocol never matches.
 */
export function findRefinedHostPair(
  stats: RTCStatsReport,
  native: RTCIceCandidatePair,
): RefinedHostPair | null {
  const localEndpoint = getIceEndpoint(native.local);
  const remoteEndpoint = getIceEndpoint(native.remote);
  if (!localEndpoint || !remoteEndpoint) return null;
  const selectedTransports = [...stats.values()].filter(
    (report) => report.type === 'transport' && readString(report, 'selectedCandidatePairId'),
  );
  if (selectedTransports.length !== 1) return null;
  const transport = selectedTransports[0]!;
  const pairId = readString(transport, 'selectedCandidatePairId')!;
  const pair = stats.get(pairId);
  if (
    pair?.type !== 'candidate-pair' ||
    readString(pair, 'state') !== 'succeeded' ||
    readString(pair, 'transportId') !== transport.id
  )
    return null;
  const localId = readString(pair, 'localCandidateId');
  const remoteId = readString(pair, 'remoteCandidateId');
  const local: RTCStats | undefined = localId ? stats.get(localId) : undefined;
  const remote: RTCStats | undefined = remoteId ? stats.get(remoteId) : undefined;
  if (
    !local ||
    !remote ||
    local.type !== 'local-candidate' ||
    remote.type !== 'remote-candidate' ||
    readString(local, 'candidateType') !== 'host' ||
    readString(remote, 'candidateType') !== 'host' ||
    !sameIceEndpoint(localEndpoint, local) ||
    !sameIceEndpoint(remoteEndpoint, remote)
  )
    return null;
  // Where exposed, preserve the local candidate and ICE-generation identities.
  for (const [nativeCandidate, statsCandidate] of [
    [native.local, local],
    [native.remote, remote],
  ] as const) {
    const statsUfrag = readString(statsCandidate, 'usernameFragment');
    if (
      nativeCandidate.usernameFragment &&
      statsUfrag &&
      nativeCandidate.usernameFragment !== statsUfrag
    )
      return null;
  }
  const localFoundation = readString(local, 'foundation');
  if (native.local.foundation && localFoundation && native.local.foundation !== localFoundation)
    return null;
  return { pairId, local, remote };
}
