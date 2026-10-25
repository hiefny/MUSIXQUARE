import type { ControlIsolation } from '../../control-isolation.ts';
import { LinkLiveness } from '../../link-liveness.ts';

let sequence = 0;

/**
 * A real LinkLiveness as the outage owner of one ControlIsolation tested on
 * its own (Phase 4 C5-9 moved the side PC's outage deadline into it). Its
 * original route is a stand-in PC that `original` turns up (connected) or down
 * (disconnected) and reports, as the connection's PC would. The owner closes
 * nothing here: these suites read the side route's own failure, so the
 * stand-in's grace running out has no effect.
 */
export function sideOutageOwner(route: () => ControlIsolation | undefined) {
  const pc = { connectionState: 'connected' as RTCPeerConnectionState };
  const original = pc as unknown as RTCPeerConnection;
  const liveness = new LinkLiveness(`side-outage-owner-test-${++sequence}`, {
    route: () => original,
    open: () => true,
    snapshot: () => ({
      original,
      side: route()?.peerConnection,
      channelsOpen: true,
      sideChannelDown: false,
      controlOpen: true,
    }),
    ping: () => undefined,
    close: () => undefined,
    changed: () => undefined,
    sideMayRestart: () => route()?.mayRestart(),
    recovered: () => undefined,
  });
  return {
    liveness,
    original(up: boolean): void {
      pc.connectionState = up ? 'connected' : 'disconnected';
      liveness.routeChanged(original);
    },
  };
}
