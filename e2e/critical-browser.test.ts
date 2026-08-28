import { expect, test, type Page, type Route } from '@playwright/test';
import { E2E_APP_ORIGIN } from './config.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';

const PRO_ROOM_CODE = '000001';
const OWNER_RECOVERY_CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;
const PARTICIPANT_ID = 'participant_00001';
const PRESENCE_INCARNATION_ID = 'presence_0000000001';
const MEMBER_ID = 'member_0000000001';
const PRO_SIGNALING_ORIGIN = E2E_APP_ORIGIN.replace(/^http/u, 'ws');

function ownerSnapshot(): Record<string, unknown> {
  const capabilities = [
    'queue.mutate',
    'playback.control',
    'effects.control',
    'asset.upload',
    'members.manage',
    'room.configure',
  ];
  const permissions = {
    'media.add': true,
    'playback.control': true,
    'members.kick': true,
    'chat.notice': true,
  };
  return {
    schemaVersion: 1,
    roomCode: PRO_ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 4,
    playlistRevision: 0,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [],
    currentQueueItemId: null,
    playback: {
      coordinatorEpoch: 2,
      revision: 0,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: Date.now(),
    },
    presence: {
      coordinatorEpoch: 2,
      revision: 3,
      coordinatorParticipantId: null,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          memberId: MEMBER_ID,
          memberDisplayNumber: 0,
          isAuthenticated: true,
          displayName: 'Recovered owner',
          devicePlatform: 'other',
          role: 'owner',
          capabilities,
          joinedAtMs: Date.now(),
        },
      ],
    },
    quota: {
      limitBytes: 1024 * 1024 * 1024,
      perAssetLimitBytes: 200 * 1024 * 1024,
      usedBytes: 0,
      reservedBytes: 0,
    },
    viewer: {
      memberId: MEMBER_ID,
      memberDisplayNumber: 0,
      isAuthenticated: true,
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: PRESENCE_INCARNATION_ID,
      displayName: 'Recovered owner',
      role: 'owner',
      capabilities,
      coordinatorEligible: false,
    },
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: MEMBER_ID,
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Recovered owner',
        role: 'owner',
        permissions,
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
      },
    ],
  };
}

function proCorsHeaders(page: Page): Record<string, string> {
  return {
    'access-control-allow-origin': new URL(page.url()).origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers':
      'content-type,idempotency-key,x-mxqr-pro-participant-id,x-mxqr-pro-presence-incarnation,x-mxqr-pro-effects-version',
    'content-type': 'application/json; charset=utf-8',
  };
}

async function fulfillProJson(
  page: Page,
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    headers: proCorsHeaders(page),
    body: JSON.stringify(body),
  });
}

test.describe('Critical browser release gate', () => {
  test('opens the native file picker from the active media-source dialog', async ({ page }) => {
    await injectPeerServer(page);
    await setupHostAndStart(page);

    await page.locator('#btn-media-source').click();
    await expect(page.locator('#media-source-overlay')).toHaveClass(/active/u);
    await expect(page.locator('#file-input')).toHaveCount(1);
    await expect(page.locator('#media-source-overlay #file-input')).toHaveCount(1);

    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('#btn-local-file').click();
    const chooser = await chooserPromise;

    expect(chooser.isMultiple()).toBe(true);
  });

  test('consumes an owner-recovery link, joins PRO, and restores server permissions', async ({
    page,
  }) => {
    await injectPeerServer(page);
    await page.addInitScript((signalingUrl) => {
      (window as unknown as Record<string, unknown>).__MUSIXQUARE_TRANSPORT__ = {
        provider: 'cloudflare',
        signalingUrl,
      };
    }, `${PRO_SIGNALING_ORIGIN}/api/rooms`);

    let recoveredBody: unknown = null;
    let recoveryRequests = 0;
    let signalingSocketUrl = '';
    const pageErrors: string[] = [];
    const proRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    await page.routeWebSocket(
      (url) => url.pathname.includes('/api/pro-rooms/'),
      (socket) => {
        signalingSocketUrl = socket.url();
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

    const snapshot = ownerSnapshot();
    await page.route('https://musixquare.com/api/pro-room/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      proRequests.push(`${request.method()} ${pathname}`);
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: proCorsHeaders(page), body: '' });
        return;
      }
      if (pathname.endsWith(`/v1/rooms/${PRO_ROOM_CODE}/bootstrap`)) {
        await fulfillProJson(page, route, { roomCode: PRO_ROOM_CODE, status: 'pin_required' });
        return;
      }
      if (pathname.endsWith(`/v1/rooms/${PRO_ROOM_CODE}/owner-recovery`)) {
        recoveryRequests += 1;
        recoveredBody = request.postDataJSON();
        await fulfillProJson(page, route, { snapshot });
        return;
      }
      if (pathname.endsWith(`/v1/rooms/${PRO_ROOM_CODE}/signaling-tickets`)) {
        await fulfillProJson(page, route, {
          ticket: `${'c'.repeat(32)}.${'D'.repeat(43)}`,
          expiresAtMs: Date.now() + 60_000,
          role: 'member',
          coordinatorEpoch: 2,
          presenceIncarnationId: PRESENCE_INCARNATION_ID,
          ticketSequence: 1,
          pendingPlaybackTransition: null,
        });
        return;
      }
      if (pathname.endsWith(`/v1/rooms/${PRO_ROOM_CODE}/presence/heartbeat`)) {
        await fulfillProJson(page, route, { snapshot });
        return;
      }
      await fulfillProJson(page, route, { error: 'TEST_ADJUNCT_UNAVAILABLE' }, 503);
    });

    await page.goto(`/${PRO_ROOM_CODE}#pro-recovery=${OWNER_RECOVERY_CLAIM}`);
    await expect.poll(() => new URL(page.url()).hash).toBe('');

    const start = page.locator('#btn-setup-confirm:not([disabled])');
    await start.waitFor({ state: 'visible' });
    await start.click();

    try {
      await page.waitForFunction(
        () => {
          const getState = (window as unknown as Record<string, unknown>)
            .__MUSIXQUARE_GET_STATE__ as ((path: string) => unknown) | undefined;
          if (!getState) return false;
          const context = getState('room.context') as
            | { kind?: unknown; role?: unknown; capabilities?: unknown }
            | undefined;
          return (
            context?.kind === 'pro' &&
            context.role === 'member' &&
            Array.isArray(context.capabilities) &&
            context.capabilities.includes('room.configure') &&
            context.capabilities.includes('members.manage')
          );
        },
        undefined,
        { timeout: 20_000 },
      );
    } catch (error) {
      const diagnostic = await page.evaluate(() => {
        const getState = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
          | ((path: string) => unknown)
          | undefined;
        return {
          context: getState?.('room.context'),
          dialogTitle: document.getElementById('dialog-title')?.textContent,
          dialogMessage: document.getElementById('dialog-message')?.textContent,
        };
      });
      throw new Error(
        `PRO recovery browser gate did not converge: ${JSON.stringify({
          recoveryRequests,
          signalingSocketUrl,
          proRequests,
          diagnostic,
          pageErrors,
        })}`,
        { cause: error },
      );
    }

    if (await page.locator('#dialog-overlay.show').isVisible()) {
      const dialog = await page.locator('#dialog-overlay.show').textContent();
      throw new Error(
        `PRO recovery completed authority but left an error dialog: ${JSON.stringify({
          dialog,
          recoveryRequests,
          signalingSocketUrl,
          proRequests,
          pageErrors,
        })}`,
      );
    }
    await expect(page.locator('#setup-overlay')).not.toHaveClass(/active/);
    expect(recoveryRequests).toBe(1);
    expect(recoveredBody).toEqual({ claimToken: OWNER_RECOVERY_CLAIM });
    expect(signalingSocketUrl).toBe(`${PRO_SIGNALING_ORIGIN}/api/pro-rooms/${PRO_ROOM_CODE}/ws`);
    expect(pageErrors).toEqual([]);
  });

  test('consumes an OAuth callback outcome once and scrubs it from the URL', async ({ page }) => {
    await injectPeerServer(page);
    await page.route('**/api/auth/session', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: true,
          authenticated: false,
          account: null,
          statsScope: null,
        }),
      }),
    );

    await page.goto('/?accountAuth=cancelled&browserGate=1');

    await expect.poll(() => new URL(page.url()).searchParams.has('accountAuth')).toBe(false);
    expect(new URL(page.url()).searchParams.get('browserGate')).toBe('1');
    await expect(
      page.locator('.toast, [role="alert"]').filter({ hasText: /취소|cancel/i }),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.locator('.toast, [role="alert"]').filter({ hasText: /취소|cancel/i }),
    ).toHaveCount(0);
  });
});
