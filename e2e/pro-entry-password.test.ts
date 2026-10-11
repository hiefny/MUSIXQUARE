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
        // An explicit membership choice is echoed; the legacy body is not.
        return reply({
          ok: true,
          passwordRequired: snapshot.passwordRequired,
          ...(body.existingParticipants === undefined
            ? {}
            : { existingParticipants: body.existingParticipants }),
        });
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

// The dialog ignores action presses just after a page swap (double-press
// guard), so a scripted press waits that long, as a person reading would.
async function afterPageSwap(page: Page) {
  await page.waitForTimeout(450);
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
    await expect(page.locator('#dialog-title')).toHaveText(
      'What should happen to current participants?',
    );
    expect(state.changes).toHaveLength(1);
    await afterPageSwap(page);
    await page.locator('#btn-dialog-ok').click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // Keeping the people in the room is the default choice.
    expect(state.changes).toEqual([
      { pin: null },
      { pin: '00000034', existingParticipants: 'keep_present' },
    ]);
    state.failNextChange();
    await toggle.click();
    await expect.poll(() => state.changes.length).toBe(3);
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });
}

test('owner sets the PIN, then chooses who stays on a second page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  const state = await openRoom(page, true, false);
  await waitForState(page, 'room.context.kind', 'pro');
  const toggle = await showPasswordSettings(page);
  const title = page.locator('#dialog-title');
  const next = page.locator('#btn-dialog-ok');
  const secondary = page.locator('#btn-dialog-secondary');
  const segments = page.locator('.dialog-input-segment');
  const keep = page.locator('input[name="pro-pin-existing-participants"][value="keep_present"]');
  const rejoin = page.locator('input[name="pro-pin-existing-participants"][value="revoke_all"]');
  const checks = page.locator('.dialog-choice-check');

  await toggle.click();
  // Step 1 is the minimal PIN page: no choice, Cancel / Next.
  await expect(title).toHaveText('Set room password');
  await expect(page.locator('#dialog-message')).toContainText('Set a new 8-digit password.');
  await expect(page.locator('.dialog-choice-frame')).toBeHidden();
  await expect(secondary).toHaveText('Cancel');
  await expect(next).toHaveText('Next');
  await segments.first().fill('0000');
  await segments.last().fill('0034');
  await settleDialog(page);
  const titleTop = async () => (await title.boundingBox())!.y;
  const stepOneTitleTop = await titleTop();
  await next.click();
  await settleDialog(page);
  // The taller step 2 grows downwards: the title stays where it was.
  expect(Math.abs((await titleTop()) - stepOneTitleTop)).toBeLessThanOrEqual(1);

  // Step 2 replaces the title, has no subtitle, and keeps people by default.
  await expect(title).toHaveText('What should happen to current participants?');
  await expect(page.locator('#dialog-message')).toBeHidden();
  await expect(page.locator('[role="radiogroup"]')).toBeVisible();
  await expect(keep).toBeChecked();
  await expect(keep).toBeFocused();
  await expect(rejoin).not.toBeChecked();
  await expect(secondary).toHaveText('Back');
  await expect(next).toHaveText('OK');
  await expect(checks.first()).toHaveCSS('opacity', '1');
  await expect(checks.last()).toHaveCSS('opacity', '0');
  // Each row's transparent radio covers the row, so touch exploration, the
  // screen reader's focus outline and taps all land on the radio itself.
  expect(await radioUnderRowCentres(page)).toEqual([true, true]);
  expect(state.changes).toEqual([]);
  await afterPageSwap(page);
  await next.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(state.changes).toEqual([{ pin: '00000034', existingParticipants: 'keep_present' }]);

  await page
    .locator('#room-password-refresh:visible, #desktop-room-password-refresh:visible')
    .click();
  await expect(title).toHaveText('Change room password');
  await segments.first().fill('1111');
  await segments.last().fill('2222');
  await next.click();
  await afterPageSwap(page);
  await page.locator('.dialog-choice-option', { hasText: 'Everyone rejoins' }).click();
  await expect(rejoin).toBeChecked();
  await expect(checks.last()).toHaveCSS('opacity', '1');
  // Back keeps the typed PIN and the choice; nothing is sent yet.
  await afterPageSwap(page);
  await secondary.click();
  await expect(title).toHaveText('Change room password');
  await expect(segments.first()).toHaveValue('1111');
  await expect(segments.last()).toHaveValue('2222');
  await expect(segments.first()).toBeFocused();
  expect(state.changes).toHaveLength(1);
  await afterPageSwap(page);
  await next.click();
  await expect(rejoin).toBeChecked();
  // Arrow keys move the single choice like any radio group.
  await rejoin.press('ArrowUp');
  await expect(keep).toBeChecked();
  await keep.press('ArrowDown');
  await expect(rejoin).toBeChecked();
  await afterPageSwap(page);
  await rejoin.press('Enter');
  await expect.poll(() => state.changes.length).toBe(2);
  // "Everyone rejoins" sends the legacy body every Worker understands.
  expect(state.changes[1]).toEqual({ pin: '11112222' });

  // A double click on Next stops on the second page (its OK is not pressed),
  // and Escape there closes without a change.
  await page
    .locator('#room-password-refresh:visible, #desktop-room-password-refresh:visible')
    .click();
  await segments.first().fill('3333');
  await segments.last().fill('4444');
  await next.dblclick();
  await expect(title).toHaveText('What should happen to current participants?');
  await expect(keep).toBeChecked();
  expect(state.changes).toHaveLength(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('#dialog-overlay')).not.toHaveClass(/show/);
  expect(state.changes).toHaveLength(2);
});

// Whether the point at each visible row's centre hit-tests to that row's radio.
function radioUnderRowCentres(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.dialog-choice-option')].map((row) => {
      const rect = row.getBoundingClientRect();
      const radio = row.querySelector('.dialog-choice-radio');
      const radioRect = radio!.getBoundingClientRect();
      return (
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === radio &&
        Math.abs(radioRect.width - rect.width) < 0.5 &&
        Math.abs(radioRect.height - rect.height) < 0.5
      );
    }),
  );
}

async function settleDialog(page: Page) {
  await page.waitForFunction(() =>
    document
      .getElementById('dialog-overlay')!
      .getAnimations({ subtree: true })
      .every((animation) => ['finished', 'idle'].includes(animation.playState)),
  );
}

function measureDialog(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#dialog-overlay .dialog')!;
    const box = panel.getBoundingClientRect();
    const hit = (element: Element | null) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return (
        rect.top >= box.top &&
        rect.bottom <= box.bottom &&
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element
      );
    };
    const overflowing = [...panel.querySelectorAll<HTMLElement>('*')].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5);
    }).length;
    return {
      panelInside:
        box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
      panelScrollX: panel.scrollWidth - panel.clientWidth,
      overflowing,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      okHit: hit(document.getElementById('btn-dialog-ok')),
      secondaryHit: hit(document.getElementById('btn-dialog-secondary')),
    };
  });
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 844, height: 390 },
  { width: 740, height: 360 },
]) {
  test(`both PIN pages fit without clipping at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openRoom(page, true, true);
    await waitForState(page, 'room.context.kind', 'pro');
    await showPasswordSettings(page);
    await page
      .locator('#room-password-refresh:visible, #desktop-room-password-refresh:visible')
      .click();
    await page.locator('.dialog-input-segment').first().fill('1234');
    await page.locator('.dialog-input-segment').last().fill('5678');
    await settleDialog(page);
    expect(await measureDialog(page)).toMatchObject({
      panelInside: true,
      panelScrollX: 0,
      overflowing: 0,
      pageOverflow: 0,
    });
    await page.locator('#btn-dialog-ok').click();
    await settleDialog(page);
    // Both actions stay visible and hit-testable without scrolling the panel.
    expect(await measureDialog(page)).toEqual({
      panelInside: true,
      panelScrollX: 0,
      overflowing: 0,
      pageOverflow: 0,
      okHit: true,
      secondaryHit: true,
    });
    // Every row can be reached and chosen, scrolling the list when needed.
    const rejoin = page.locator('.dialog-choice-option', { hasText: 'Everyone rejoins' });
    await afterPageSwap(page);
    await rejoin.scrollIntoViewIfNeeded();
    await rejoin.click();
    await expect(
      page.locator('input[name="pro-pin-existing-participants"][value="revoke_all"]'),
    ).toBeChecked();
    expect((await measureDialog(page)).okHit).toBe(true);
    // The chosen row was scrolled fully into view and its radio covers it.
    expect((await radioUnderRowCentres(page))[1]).toBe(true);
  });
}
