/**
 * Mechanism check for the lab's P2P outage (the "M0" step of the 2026-10-19/20
 * labs), and the two shaping defects the independent verification found.
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { LAB_APP_ORIGIN, LAB_SIGNALING_ORIGIN, LAB_SIGNALING_URL } from './lab-env.ts';
import {
  H8_PROFILE,
  HTTP_WS_EXEMPTIONS,
  p2pShapingParams,
  primeP2PShaping,
} from './p2p-shaping.ts';

const LAB_URLS = [
  `${LAB_APP_ORIGIN}/`,
  `${LAB_APP_ORIGIN}/assets/main.js`,
  `${LAB_SIGNALING_ORIGIN}/api/rooms`,
  `${LAB_SIGNALING_URL}/123456`,
];

function exempted(patterns: readonly string[], url: string): boolean {
  return patterns.some((pattern) => new URLPattern(pattern).test(url));
}

test.describe('lab P2P shaping parameters', () => {
  test('exemptions match the ported loopback app and signaling URLs', () => {
    for (const url of LAB_URLS) expect(exempted(HTTP_WS_EXEMPTIONS, url), url).toBe(true);
    // The 2026-10-19 form left the port empty, which matches only default ports.
    const portless = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'];
    for (const url of LAB_URLS) expect(exempted(portless, url), url).toBe(false);
  });

  test('cut and restore send only per-rule offline flags', () => {
    for (const interrupted of [true, false]) {
      const params = p2pShapingParams(H8_PROFILE, interrupted);
      expect(Object.keys(params)).toEqual(['matchedNetworkConditions']);
      const p2p = params.matchedNetworkConditions.filter((rule) => rule.urlPattern === '');
      expect(p2p).toHaveLength(1);
      expect(p2p[0]!.offline).toBe(interrupted);
      for (const rule of params.matchedNetworkConditions.filter((r) => r.urlPattern !== '')) {
        expect(rule.offline).toBe(false);
      }
    }
  });
});

/** Two loopback RTCPeerConnections in one page exchanging a numbered message every 50 ms. */
async function startLoopbackChannel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    // A late candidate after the pair connected is harmless here.
    a.onicecandidate = (event) => {
      if (event.candidate) b.addIceCandidate(event.candidate).catch(() => undefined);
    };
    b.onicecandidate = (event) => {
      if (event.candidate) a.addIceCandidate(event.candidate).catch(() => undefined);
    };
    const received: number[] = [];
    b.ondatachannel = (event) => {
      event.channel.onmessage = () => received.push(Date.now());
    };
    const channel = a.createDataChannel('lab-loopback');
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription!);
    await new Promise<void>((resolve) => {
      channel.onopen = () => resolve();
    });
    setInterval(() => {
      if (channel.readyState === 'open') channel.send('x');
    }, 50);
    (window as unknown as { __labReceived: number[] }).__labReceived = received;
  });
}

function receivedBetween(page: Page, from: number, to: number): Promise<number> {
  return page.evaluate(
    ({ from, to }) =>
      (window as unknown as { __labReceived: number[] }).__labReceived.filter(
        (at) => at >= from && at <= to,
      ).length,
    { from, to },
  );
}

/** Whether a ported loopback URL loads; a no-cors request settles opaque on success. */
function loads(page: Page, url: string): Promise<boolean> {
  return page.evaluate(
    (url) =>
      fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(3_000) }).then(
        () => true,
        () => false,
      ),
    url,
  );
}

async function sendRaw(session: CDPSession, params: unknown): Promise<void> {
  await session.send(
    'Network.emulateNetworkConditionsByRule' as Parameters<CDPSession['send']>[0],
    params as never,
  );
}

test.describe('lab P2P outage in this Chromium', () => {
  test('the cut stops page P2P while ported HTTP stays up, and restore resumes it', async ({
    page,
  }) => {
    const shaping = await primeP2PShaping(page, H8_PROFILE);
    await page.goto('/favicon.svg');
    await startLoopbackChannel(page);
    await page.waitForTimeout(1_000);

    const cut = await shaping.set(true, 'cut');
    await page.waitForTimeout(500);
    const cutObservedFrom = Date.now();
    expect(await loads(page, `${LAB_APP_ORIGIN}/favicon.svg`)).toBe(true);
    expect(await loads(page, `${LAB_SIGNALING_ORIGIN}/`)).toBe(true);
    await page.waitForTimeout(2_500);
    const cutObservedTo = Date.now();
    const restore = await shaping.set(false, 'restore');
    await page.waitForTimeout(3_000);

    expect(await receivedBetween(page, cut.returnedAt - 2_000, cut.sentAt)).toBeGreaterThan(5);
    expect(await receivedBetween(page, cutObservedFrom, cutObservedTo)).toBe(0);
    expect(await receivedBetween(page, restore.returnedAt, Date.now())).toBeGreaterThan(5);
  });

  test('both 2026-10-19 defects reproduce, so the fixed form is load-bearing', async ({ page }) => {
    const shaping = await primeP2PShaping(page, H8_PROFILE);
    await page.goto('/favicon.svg');
    await startLoopbackChannel(page);
    await page.waitForTimeout(1_000);

    // Defect 1: a top-level offline:false overrides the outage rule's own flag.
    await sendRaw(shaping.session, { offline: false, ...p2pShapingParams(H8_PROFILE, true) });
    await page.waitForTimeout(500);
    const from = Date.now();
    await page.waitForTimeout(2_000);
    expect(await receivedBetween(page, from, Date.now())).toBeGreaterThan(5);
    await shaping.set(false, 'restore-after-defect-1');

    // Defect 2: port-less exemptions do not cover ported loopback URLs.
    const cut = p2pShapingParams(H8_PROFILE, true);
    await sendRaw(shaping.session, {
      matchedNetworkConditions: cut.matchedNetworkConditions.map((rule) =>
        rule.urlPattern === '' ? rule : { ...rule, urlPattern: rule.urlPattern.replace(':*', '') },
      ),
    });
    expect(await loads(page, `${LAB_APP_ORIGIN}/favicon.svg`)).toBe(false);
    await shaping.set(false, 'restore-after-defect-2');
    expect(await loads(page, `${LAB_APP_ORIGIN}/favicon.svg`)).toBe(true);
  });
});
