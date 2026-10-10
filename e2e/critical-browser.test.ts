import { expect, test } from '@playwright/test';
import { E2E_APP_ORIGIN } from './config.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { openChatDrawer, sendChat, waitForState } from './helpers/wait.ts';

import {
  PRO_ROOM_CODE,
  OWNER_RECOVERY_CLAIM,
  PRESENCE_INCARNATION_ID,
  PRO_SIGNALING_ORIGIN,
  ownerSnapshot,
  proCorsHeaders,
  fulfillProJson,
} from './helpers/pro-room-fixture.ts';

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
    const proRequestOrigins = new Set<string>();
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
    await page.route('**/api/pro-room/**', async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const pathname = requestUrl.pathname;
      proRequestOrigins.add(requestUrl.origin);
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
            { kind?: unknown; role?: unknown; capabilities?: unknown } | undefined;
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
          ((path: string) => unknown) | undefined;
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
          proRequestOrigins: [...proRequestOrigins],
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
          proRequestOrigins: [...proRequestOrigins],
          pageErrors,
        })}`,
      );
    }
    await expect(page.locator('#setup-overlay')).not.toHaveClass(/active/);
    expect(recoveryRequests).toBe(1);
    expect(recoveredBody).toEqual({ claimToken: OWNER_RECOVERY_CLAIM });
    expect(signalingSocketUrl).toBe(`${PRO_SIGNALING_ORIGIN}/api/pro-rooms/${PRO_ROOM_CODE}/ws`);
    expect([...proRequestOrigins]).toEqual([E2E_APP_ORIGIN]);
    expect(pageErrors).toEqual([]);
  });

  test('PRO owner slowmode preserves an unsent draft and allows retry when disabled', async ({
    page,
  }) => {
    await injectPeerServer(page);
    await page.addInitScript((signalingUrl) => {
      (window as unknown as Record<string, unknown>).__MUSIXQUARE_TRANSPORT__ = {
        provider: 'cloudflare',
        signalingUrl,
      };
    }, `${PRO_SIGNALING_ORIGIN}/api/rooms`);

    const messages: string[] = [];
    const chatControl: { send?: (revision: number, seconds: number) => void } = {};
    await page.routeWebSocket(
      (url) => url.pathname.includes('/api/pro-rooms/'),
      (socket) => {
        chatControl.send = (revision, seconds) => {
          socket.send(
            JSON.stringify({
              type: 'pro-realtime',
              version: 1,
              eventId: `chat-control-${revision}`,
              roomCode: PRO_ROOM_CODE,
              coordinatorEpoch: 2,
              channel: 'chat-control-snapshot',
              sender: {
                participantId: 'server',
                presenceIncarnationId: 'server-chat-state',
                displayName: 'MUSIXQUARE',
              },
              payload: {
                revision,
                frozen: false,
                filterEnabled: false,
                slowmodeSeconds: seconds,
                muted: false,
              },
            }),
          );
        };
        socket.onMessage((raw) => {
          if (typeof raw !== 'string') return;
          const frame = JSON.parse(raw) as Record<string, unknown>;
          if (frame.type === 'pro-clock') {
            socket.send(
              JSON.stringify({
                type: 'pro-clock',
                version: 1,
                requestId: frame.requestId,
                clientSentAtMs: frame.clientSentAtMs,
                serverTimeMs: Date.now(),
              }),
            );
          }
          const payload = frame.payload as { kind?: string; text?: string } | undefined;
          if (
            frame.type === 'pro-realtime' &&
            frame.channel === 'chat' &&
            payload?.kind === 'message'
          ) {
            messages.push(payload.text ?? '');
          }
        });
      },
    );

    const snapshot = ownerSnapshot();
    await page.route('**/api/pro-room/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: proCorsHeaders(page), body: '' });
      } else if (pathname.endsWith(`/v1/rooms/${PRO_ROOM_CODE}/bootstrap`)) {
        await fulfillProJson(page, route, { roomCode: PRO_ROOM_CODE, status: 'pin_required' });
      } else if (
        pathname.endsWith(`/v1/rooms/${PRO_ROOM_CODE}/owner-recovery`) ||
        pathname.endsWith(`/v1/rooms/${PRO_ROOM_CODE}/presence/heartbeat`)
      ) {
        await fulfillProJson(page, route, { snapshot });
      } else if (pathname.endsWith(`/v1/rooms/${PRO_ROOM_CODE}/signaling-tickets`)) {
        await fulfillProJson(page, route, {
          ticket: `${'c'.repeat(32)}.${'D'.repeat(43)}`,
          expiresAtMs: Date.now() + 60_000,
          role: 'member',
          coordinatorEpoch: 2,
          presenceIncarnationId: PRESENCE_INCARNATION_ID,
          ticketSequence: 1,
          pendingPlaybackTransition: null,
        });
      } else {
        await fulfillProJson(page, route, { error: 'TEST_ADJUNCT_UNAVAILABLE' }, 503);
      }
    });

    await page.goto(`/${PRO_ROOM_CODE}#pro-recovery=${OWNER_RECOVERY_CLAIM}`);
    await page.locator('#btn-setup-confirm:not([disabled])').click();
    await waitForState(page, 'room.context.kind', 'pro');
    await openChatDrawer(page);
    await page.waitForFunction(() => {
      const getState = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as (
        path: string,
      ) => unknown;
      const participants = getState('network.lastKnownDeviceList') as {
        id: string;
        role?: string;
      }[];
      return participants.some(
        (participant) =>
          participant.id === getState('network.myId') && participant.role === 'owner',
      );
    });
    await expect.poll(() => typeof chatControl.send).toBe('function');
    chatControl.send!(1, 60);
    await waitForState(page, 'network.slowmodeSeconds', 60);

    await sendChat(page, 'First accepted PRO message');
    await expect.poll(() => messages).toEqual(['First accepted PRO message']);
    await expect(page.locator('#chat-input')).toHaveText('');
    await sendChat(page, 'Second PRO message remains a draft');
    await expect(page.locator('#chat-input')).toHaveText('Second PRO message remains a draft');
    await expect(page.locator('.chat-bubble.mine')).toHaveCount(1);
    await expect(page.locator('#chat-messages')).toContainText(
      /seconds before sending|초 후에 메시지/u,
    );
    expect(messages).toEqual(['First accepted PRO message']);

    // The rejected attempt must not consume the draft or the duplicate-send stamp.
    chatControl.send!(2, 0);
    await waitForState(page, 'network.slowmodeSeconds', 0);
    await page.locator('#btn-chat-send').click();
    await expect
      .poll(() => messages)
      .toEqual(['First accepted PRO message', 'Second PRO message remains a draft']);
    await expect(page.locator('#chat-input')).toHaveText('');
    await expect(page.locator('.chat-bubble.mine')).toHaveCount(2);
  });

  for (const scenario of [
    { kind: 'message', draft: 'Recovered ordinary draft' },
    { kind: 'whisper', draft: '/w Recipient Recovered private draft' },
    { kind: 'freeze', draft: '/freeze on' },
  ]) {
    test(`PRO recovery preserves a rejected ${scenario.kind} submission for explicit retry`, async ({
      page,
    }) => {
      await injectPeerServer(page);
      await page.addInitScript((signalingUrl) => {
        (window as unknown as Record<string, unknown>).__MUSIXQUARE_TRANSPORT__ = {
          provider: 'cloudflare',
          signalingUrl,
        };
      }, `${PRO_SIGNALING_ORIGIN}/api/rooms`);
      const frames: Record<string, unknown>[] = [];
      let connections = 0;
      let closeSocket: (() => Promise<void>) | undefined;
      let ticketCount = 0;
      let ticketBlocked = false;
      let releaseTicket = () => {};
      const ticketGate = new Promise<void>((resolve) => {
        releaseTicket = resolve;
      });
      await page.routeWebSocket(
        (url) => url.pathname.includes('/api/pro-rooms/'),
        (socket) => {
          connections++;
          closeSocket = () => socket.close({ code: 1001, reason: 'Test transient disconnect' });
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
            if (frame.type === 'pro-realtime' && frame.channel === 'chat') {
              frames.push(frame.payload as Record<string, unknown>);
            }
          });
        },
      );
      const snapshot = ownerSnapshot();
      (snapshot.presence as { participants: unknown[] }).participants.push({
        participantId: 'participant_00002',
        memberId: 'member_0000000002',
        memberDisplayNumber: 7,
        isAuthenticated: false,
        displayName: 'Recipient',
        devicePlatform: 'other',
        role: 'member',
        capabilities: [],
        joinedAtMs: Date.now(),
      });
      await page.route('**/api/pro-room/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: proCorsHeaders(page), body: '' });
        } else if (path.endsWith('/bootstrap')) {
          await fulfillProJson(page, route, { roomCode: PRO_ROOM_CODE, status: 'pin_required' });
        } else if (path.endsWith('/owner-recovery') || path.endsWith('/presence/heartbeat')) {
          await fulfillProJson(page, route, { snapshot });
        } else if (path.endsWith('/signaling-tickets')) {
          ticketCount++;
          if (ticketCount > 1) {
            ticketBlocked = true;
            await ticketGate;
          }
          await fulfillProJson(page, route, {
            ticket: `${'c'.repeat(32)}.${'D'.repeat(43)}`,
            expiresAtMs: Date.now() + 60_000,
            role: 'member',
            coordinatorEpoch: 2,
            presenceIncarnationId: PRESENCE_INCARNATION_ID,
            ticketSequence: ticketCount,
            pendingPlaybackTransition: null,
          });
        } else {
          await fulfillProJson(page, route, { error: 'TEST_ADJUNCT_UNAVAILABLE' }, 503);
        }
      });
      await page.goto(`/${PRO_ROOM_CODE}#pro-recovery=${OWNER_RECOVERY_CLAIM}`);
      await page.locator('#btn-setup-confirm:not([disabled])').click();
      await waitForState(page, 'room.context.kind', 'pro');
      await openChatDrawer(page);
      await sendChat(page, 'Connected control');
      await expect.poll(() => frames.length).toBe(1);
      expect(frames[0]).toMatchObject({ kind: 'message', text: 'Connected control' });
      await closeSocket!();
      await expect.poll(() => ticketBlocked).toBe(true);
      try {
        await sendChat(page, scenario.draft);
        await expect(page.locator('#chat-input')).toHaveText(scenario.draft);
        await expect(page.locator('.chat-bubble.mine')).toHaveCount(1);
        await expect(page.locator('#chat-messages')).toContainText(
          /Could not connect|연결하지 못/u,
        );
        await waitForState(page, 'network.chatFrozen', false);
        expect(frames).toHaveLength(1);
      } finally {
        releaseTicket();
      }
      await expect.poll(() => connections).toBe(2);
      // Recovery itself must not automatically publish the retained command.
      expect(frames).toHaveLength(1);
      await page.locator('#btn-chat-send').click();
      await expect.poll(() => frames.length).toBe(2);
      expect(frames[1]).toMatchObject({ kind: scenario.kind });
      await expect(page.locator('#chat-input')).toHaveText('');
      if (scenario.kind === 'freeze') {
        expect(frames[1]).toMatchObject({ on: true });
        await waitForState(page, 'network.chatFrozen', true);
      } else {
        expect(frames[1]).toMatchObject({
          text: scenario.kind === 'message' ? scenario.draft : 'Recovered private draft',
        });
        await expect(page.locator('.chat-bubble.mine')).toHaveCount(2);
      }
    });
  }

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
