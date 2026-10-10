import { expect, test, type Page } from '@playwright/test';
import {
  ownerSnapshot,
  PRO_ROOM_CODE,
  PRO_SIGNALING_ORIGIN,
  PRESENCE_INCARNATION_ID,
} from './helpers/pro-room-fixture.ts';
import { waitForState } from './helpers/wait.ts';
import type { ProRoomSnapshot } from '../src/pro-room/contracts.ts';

test.use({ serviceWorkers: 'block' });

async function openRoom(page: Page, owner: boolean, initiallyProtected: boolean) {
  const snapshot = ownerSnapshot() as unknown as ProRoomSnapshot;
  snapshot.passwordRequired = initiallyProtected;
  if (!owner) {
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
        memberId: 'member_guest000001',
        memberDisplayNumber: 1,
        displayName: 'Guest',
        isAuthenticated: false,
        role: 'member',
        capabilities: [],
      },
    ];
    snapshot.administrators[0]!.onlineDeviceCount = 0;
  }
  const sessions: Array<Record<string, unknown>> = [];
  const changes: Array<Record<string, unknown>> = [];
  let failNextChange = false;
  let admitted = false;
  await page.addInitScript((signalingUrl) => {
    localStorage.setItem('musixquare-lang', 'en');
    localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
    localStorage.setItem('musixquare-app-used-v1', '1');
    (window as unknown as Record<string, unknown>).__MUSIXQUARE_TRANSPORT__ = {
      provider: 'cloudflare',
      signalingUrl,
    };
  }, `${PRO_SIGNALING_ORIGIN}/api/rooms`);
  await page.routeWebSocket(
    (url) => url.pathname.includes('/api/pro-rooms/'),
    (socket) => {
      socket.onMessage((raw) => {
        if (typeof raw !== 'string') return;
        const frame = JSON.parse(raw) as Record<string, unknown>;
        if (frame.type === 'pro-clock')
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
      return reply({
        configured: true,
        authenticated: owner,
        account: owner ? { nickname: 'Recovered owner', profileComplete: true } : null,
        ...(owner ? { statsScope: 'a'.repeat(43) } : {}),
      });
    if (url.pathname.startsWith('/api/pro-room/')) {
      expect(request.headers()['x-mxqr-pro-entry-policy']).toBe('optional-v1');
      if (url.pathname.endsWith('/bootstrap'))
        return reply({
          roomCode: PRO_ROOM_CODE,
          status: snapshot.passwordRequired ? 'pin_required' : 'open',
          passwordRequired: snapshot.passwordRequired,
        });
      if (url.pathname.endsWith('/presence/enter'))
        return admitted ? reply({ snapshot }) : reply({ error: 'SESSION_REQUIRED' }, 401);
      if (url.pathname.endsWith('/sessions')) {
        const body = request.postDataJSON() as Record<string, unknown>;
        sessions.push(body);
        if (!owner && snapshot.passwordRequired && body.pin !== '12345678')
          return reply({ error: body.pin ? 'PIN_INVALID' : 'PIN_REQUIRED' }, 401);
        admitted = true;
        return reply({ snapshot, session: { expiresAtMs: Date.now() + 60_000 } });
      }
      if (url.pathname.endsWith('/pin')) {
        const body = request.postDataJSON() as Record<string, unknown>;
        changes.push(body);
        if (failNextChange) {
          failNextChange = false;
          return reply({ error: 'TEMPORARY_UNAVAILABLE' }, 503);
        }
        snapshot.passwordRequired = body.pin !== null;
        snapshot.revision += 1;
        return reply({ ok: true, passwordRequired: snapshot.passwordRequired });
      }
      if (
        url.pathname.endsWith('/snapshot') ||
        url.pathname.endsWith('/presence/heartbeat') ||
        url.pathname.endsWith('/sessions/current/account')
      )
        return reply({ snapshot });
      if (url.pathname.endsWith('/sessions/current/account/lease'))
        return reply({ leaseExpiresAtMs: Date.now() + 60_000 });
      if (url.pathname.endsWith('/signaling-tickets'))
        return reply({
          ticket: `${'c'.repeat(32)}.${'D'.repeat(43)}`,
          expiresAtMs: Date.now() + 60_000,
          role: 'member',
          coordinatorEpoch: 2,
          presenceIncarnationId: PRESENCE_INCARNATION_ID,
          ticketSequence: 1,
          pendingPlaybackTransition: null,
        });
      return reply({ error: 'TEST_ADJUNCT_UNAVAILABLE' }, 503);
    }
    if (url.pathname.startsWith('/api/')) return reply({ error: 'LOCAL_FIXTURE_UNAVAILABLE' }, 503);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    return route.continue();
  });
  await page.goto(`/${PRO_ROOM_CODE}`);
  await page.locator('#btn-setup-confirm:not([disabled])').click();
  return {
    sessions,
    changes,
    failNextChange: () => {
      failNextChange = true;
    },
  };
}

async function showPasswordSettings(page: Page) {
  const desktop = page.locator('#settings-subtab-connect');
  if (await desktop.isVisible()) await desktop.click();
  else await page.locator('#nav-connect').click();
  return page.locator('#room-password-toggle:visible, #desktop-room-password-toggle:visible');
}

test('public guests join directly and protected guests still enter their manual PIN', async ({
  page,
}) => {
  const state = await openRoom(page, false, false);
  await waitForState(page, 'room.context.kind', 'pro');
  expect(state.sessions).toHaveLength(1);
  expect(state.sessions[0]).not.toHaveProperty('pin');
  await expect(page.locator('#dialog-overlay')).not.toHaveClass(/show/);
  await showPasswordSettings(page);
  await expect(page.locator('.room-password-section:visible')).toHaveCount(0);
});

test('protected guests are prompted after the server denies password-free admission', async ({
  page,
}) => {
  const state = await openRoom(page, false, true);
  await expect(page.locator('#dialog-title')).toHaveText('Enter room password');
  const segments = page.locator('.dialog-input-segment');
  await segments.first().fill('1234');
  await segments.last().fill('5678');
  await page.locator('#btn-dialog-ok').click();
  await waitForState(page, 'room.context.kind', 'pro');
  expect(state.sessions).toHaveLength(2);
  expect(state.sessions[0]).not.toHaveProperty('pin');
  expect(state.sessions[1]).toMatchObject({ pin: '12345678' });
});

for (const width of [390, 1280]) {
  test(`owner disables, cancels and manually restores entry protection at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 820 });
    const state = await openRoom(page, true, true);
    await waitForState(page, 'room.context.kind', 'pro');
    expect(state.sessions[0]).not.toHaveProperty('pin');
    const toggle = await showPasswordSettings(page);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(state.changes).toEqual([{ pin: null }]);
    await toggle.click();
    await expect(page.locator('.dialog-input-segment')).toHaveCount(2);
    await page.locator('#btn-dialog-secondary').click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(state.changes).toHaveLength(1);
    await toggle.click();
    await page.locator('.dialog-input-segment').first().fill('0000');
    await page.locator('.dialog-input-segment').last().fill('0034');
    await page.locator('#btn-dialog-ok').click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(state.changes).toEqual([{ pin: null }, { pin: '00000034' }]);
    state.failNextChange();
    await toggle.click();
    await expect.poll(() => state.changes.length).toBe(3);
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });
}
