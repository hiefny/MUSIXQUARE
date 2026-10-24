/**
 * Page-level WebRTC P2P shaping through CDP `Network.emulateNetworkConditionsByRule`.
 *
 * Chromium applies the empty-pattern rule to the page's P2P sockets and the URL
 * rules to HTTP and WebSocket requests, so an outage can cut the page's
 * RTCPeerConnections while its signaling socket and page loads stay up. Prime it
 * before navigation: P2P sockets attach to the interceptor when they are created.
 *
 * Two defects of the 2026-10-19 shaping module, found by the independent
 * verification (docs/design/side-ice-restart-independent-verification-2026-10-20.md),
 * are fixed here and pinned by p2p-shaping.lab.ts:
 * - The deprecated top-level `offline` parameter is never sent. When present,
 *   Chromium copies it over every rule's own `offline`, so a top-level
 *   `offline: false` silently cancelled the outage rule.
 * - Exemptions spell the port as a wildcard. A pattern without a port
 *   component (the old host-and-path-only form) matches only the scheme's
 *   default port and never the ported loopback app and Worker URLs, so the
 *   signaling socket was cut together with P2P.
 */
import type { CDPSession, Page } from '@playwright/test';

export interface LinkProfile {
  readonly latencyMs: number;
  readonly uploadBytesPerSecond: number;
  readonly downloadBytesPerSecond: number;
}

/** "H8": the direct-transfer QA profile of the 2026-10-19/20 labs (1 MB/s, 100 ms). */
export const H8_PROFILE: LinkProfile = {
  latencyMs: 100,
  uploadBytesPerSecond: 1_000_000,
  downloadBytesPerSecond: 1_000_000,
};

export const HTTP_WS_EXEMPTIONS = ['http://*:*/*', 'https://*:*/*', 'ws://*:*/*', 'wss://*:*/*'];

export interface NetworkConditionRule {
  readonly urlPattern: string;
  readonly latency: number;
  readonly downloadThroughput: number;
  readonly uploadThroughput: number;
  readonly offline: boolean;
  readonly packetLoss: number;
  readonly packetQueueLength: number;
  readonly packetReordering: boolean;
}

/** The exact CDP parameters: a rule list and no top-level `offline`. */
export function p2pShapingParams(
  profile: LinkProfile,
  interrupted: boolean,
): { matchedNetworkConditions: NetworkConditionRule[] } {
  const unrestricted = {
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
    offline: false,
    packetLoss: 0,
    packetQueueLength: 0,
    packetReordering: false,
  };
  return {
    matchedNetworkConditions: [
      ...HTTP_WS_EXEMPTIONS.map((urlPattern) => ({ urlPattern, ...unrestricted })),
      {
        urlPattern: '',
        latency: profile.latencyMs,
        downloadThroughput: profile.downloadBytesPerSecond,
        uploadThroughput: profile.uploadBytesPerSecond,
        offline: interrupted,
        packetLoss: 0,
        packetQueueLength: 0,
        packetReordering: false,
      },
    ],
  };
}

export interface ShapingRecord {
  readonly label: string;
  readonly interrupted: boolean;
  readonly sentAt: number;
  readonly returnedAt: number;
}

export interface P2PShaping {
  readonly session: CDPSession;
  readonly history: ShapingRecord[];
  /** Apply the profile, cut (`true`) or restored (`false`); resolves when Chromium returns. */
  set(interrupted: boolean, label: string): Promise<ShapingRecord>;
}

export async function primeP2PShaping(page: Page, profile: LinkProfile): Promise<P2PShaping> {
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  const history: ShapingRecord[] = [];
  const shaping: P2PShaping = {
    session,
    history,
    async set(interrupted, label) {
      const sentAt = Date.now();
      // The method is newer than Playwright's protocol typings.
      await session.send(
        'Network.emulateNetworkConditionsByRule' as Parameters<CDPSession['send']>[0],
        p2pShapingParams(profile, interrupted) as never,
      );
      const record = { label, interrupted, sentAt, returnedAt: Date.now() };
      history.push(record);
      return record;
    },
  };
  await shaping.set(false, 'initial');
  return shaping;
}
