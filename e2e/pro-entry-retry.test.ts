import { devices, expect, test, type Page } from '@playwright/test';
import type { ProRoomSnapshot } from '../src/pro-room/contracts.ts';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { installFakeYt } from './helpers/fake-yt.ts';
import {
  ownerSnapshot,
  PRESENCE_INCARNATION_ID,
  PRO_ROOM_CODE,
  PRO_SIGNALING_ORIGIN,
} from './helpers/pro-room-fixture.ts';
import { waitForState } from './helpers/wait.ts';

test.use({ serviceWorkers: 'block' });

async function installFailedFirstConnection(page: Page) {
  const snapshot = ownerSnapshot() as unknown as ProRoomSnapshot;
  snapshot.passwordRequired = false;
  snapshot.viewer = {
    ...snapshot.viewer!,
    memberId: 'member_guest000001',
    memberDisplayNumber: 1,
    displayName: 'Guest',
    isAuthenticated: false,
    role: 'member',
    capabilities: [],
  };
  snapshot.presence.participants = [
    {
      ...snapshot.presence.participants[0]!,
      memberId: snapshot.viewer.memberId,
      memberDisplayNumber: 1,
      displayName: 'Guest',
      isAuthenticated: false,
      role: 'member',
      capabilities: [],
    },
  ];
  snapshot.administrators[0]!.onlineDeviceCount = 0;

  let connections = 0;
  let admissions = 0;
  let closedSessions = 0;
  await page.addInitScript((signalingUrl) => {
    localStorage.setItem('musixquare-lang', 'en');
    localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
    localStorage.setItem('musixquare-app-used-v1', '1');
    (window as unknown as Record<string, unknown>).__MUSIXQUARE_TRANSPORT__ = {
      provider: 'cloudflare',
      signalingUrl,
    };
  }, `${PRO_SIGNALING_ORIGIN}/api/rooms`);
  await installFakeYt(page, { playDelayMs: 50 });
  await page.routeWebSocket(
    (url) => url.pathname.includes('/api/pro-rooms/'),
    async (socket) => {
      connections += 1;
      if (connections === 1) {
        // Close before the routing handler returns, so OPEN is never emitted.
        // The real bridge has already projected its temporary media-engine role.
        await socket.close({ code: 1013, reason: 'TEST_FIRST_OPEN_UNAVAILABLE' });
        return;
      }
      socket.onMessage((raw) => {
        if (typeof raw !== 'string') return;
        const frame = JSON.parse(raw) as Record<string, unknown>;
        if (frame.type !== 'pro-clock') return;
        socket.send(
          JSON.stringify({
            type: 'pro-clock',
            version: 1,
            requestId: frame.requestId,
            clientSentAtMs: frame.clientSentAtMs,
            serverTimeMs: Date.now(),
          }),
        );
      });
    },
  );
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (url.pathname === '/api/auth/session')
      return reply({ configured: true, authenticated: false, account: null });
    if (url.pathname.startsWith('/api/pro-room/')) {
      if (url.pathname.endsWith('/bootstrap'))
        return reply({ roomCode: PRO_ROOM_CODE, status: 'open', passwordRequired: false });
      if (url.pathname.endsWith('/presence/enter'))
        return reply({ error: 'SESSION_REQUIRED' }, 401);
      if (url.pathname.endsWith('/sessions')) {
        admissions += 1;
        return reply({ snapshot, session: { expiresAtMs: Date.now() + 60_000 } });
      }
      if (url.pathname.endsWith('/sessions/current/close')) {
        closedSessions += 1;
        return reply({ ok: true });
      }
      if (url.pathname.endsWith('/signaling-tickets'))
        return reply({
          ticket: `${'c'.repeat(32)}.${'D'.repeat(43)}`,
          expiresAtMs: Date.now() + 60_000,
          role: 'member',
          coordinatorEpoch: 2,
          presenceIncarnationId: PRESENCE_INCARNATION_ID,
          ticketSequence: admissions,
          pendingPlaybackTransition: null,
        });
      if (
        url.pathname.endsWith('/snapshot') ||
        url.pathname.endsWith('/presence/heartbeat') ||
        url.pathname.endsWith('/sessions/current/account')
      )
        return reply({ snapshot });
      return reply({ error: 'TEST_ADJUNCT_UNAVAILABLE' }, 503);
    }
    if (url.pathname.startsWith('/api/')) return reply({ error: 'LOCAL_FIXTURE_UNAVAILABLE' }, 503);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    return route.continue();
  });
  return {
    connections: () => connections,
    admissions: () => admissions,
    closedSessions: () => closedSessions,
  };
}

async function verifyRetry(page: Page, entry: 'code' | 'invite') {
  const fixture = await installFailedFirstConnection(page);
  await page.goto(entry === 'invite' ? `/${PRO_ROOM_CODE}` : '/');
  await waitForBootstrapReady(page);
  if (entry === 'code') {
    await page.locator('#btn-setup-guest').click();
    await page.locator('#setup-join-code').fill(PRO_ROOM_CODE);
  }
  const start = page.locator('#btn-setup-confirm');
  await expect(start).toBeEnabled();
  await start.click();
  const error = page.locator(entry === 'code' ? '#setup-guest-error' : '#setup-auto-join-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Could not connect to the PRO room.');
  await expect(start).toHaveText('Retry');
  await expect(start).toBeEnabled();
  expect(fixture.admissions()).toBe(1);
  expect(fixture.connections()).toBe(1);
  await expect.poll(fixture.closedSessions).toBe(1);
  if (entry === 'code') await expect(page.locator('#setup-join-code')).toHaveValue(PRO_ROOM_CODE);

  // Retry on this page, without Back, reload, or entering the code again.
  await start.click();
  await expect.poll(fixture.admissions).toBe(2);
  await waitForState(page, 'setup.sessionStarted', true);
  await waitForState(page, 'room.context.kind', 'pro');
  await waitForState(page, 'room.context.role', 'member');
  await waitForState(page, 'room.context.capabilities', []);
  expect(fixture.connections()).toBe(2);
  await expect(error).toBeHidden();
}

test('manual PRO entry retries a failed signaling open without re-entering the code', async ({
  page,
}) => {
  await verifyRetry(page, 'code');
});

test.describe('mobile PRO invite retry', () => {
  test.use({
    userAgent: devices['iPhone 13'].userAgent,
    viewport: devices['iPhone 13'].viewport,
    isMobile: true,
    hasTouch: true,
  });

  test('an invite retries failed signaling after the YouTube activation flow', async ({ page }) => {
    // Chromium with an iPhone UA exercises application activation wiring;
    // the fake player cannot establish Safari's real autoplay permissions.
    await verifyRetry(page, 'invite');
  });
});
