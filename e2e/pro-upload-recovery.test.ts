import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_APP_ORIGIN } from './config.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import {
  PRO_ROOM_CODE,
  OWNER_RECOVERY_CLAIM,
  PRESENCE_INCARNATION_ID,
  PRO_SIGNALING_ORIGIN,
  ownerSnapshot,
  fulfillProJson,
  heartbeatReply,
  setProPlaylist,
} from './helpers/pro-room-fixture.ts';

async function expectDialogInsideOverlay(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const overlay = document.getElementById('dialog-overlay')!;
    const panel = overlay.querySelector('.dialog')!;
    // Only entrance motion determines these bounds. A reading scrollbar may
    // keep its own child animation alive while the message has focus.
    return [...overlay.getAnimations(), ...panel.getAnimations()].every((animation) =>
      ['finished', 'idle'].includes(animation.playState),
    );
  });
  const geometry = await page.locator('#dialog-overlay').evaluate((overlay) => {
    const panel = overlay.querySelector('.dialog')!.getBoundingClientRect();
    const bounds = overlay.getBoundingClientRect();
    const style = getComputedStyle(overlay);
    return {
      panelTop: panel.top,
      panelBottom: panel.bottom,
      minTop: bounds.top + parseFloat(style.paddingTop),
      maxBottom: bounds.bottom - parseFloat(style.paddingBottom),
    };
  });
  expect(geometry.panelTop).toBeGreaterThanOrEqual(geometry.minTop - 1);
  expect(geometry.panelBottom).toBeLessThanOrEqual(geometry.maxBottom + 1);
  await expect(page.locator('#btn-dialog-ok')).toBeInViewport({ ratio: 1 });
}

async function uploadFixture(page: Page, completionError = 'PRO_ROOM_API_UNAVAILABLE') {
  await injectPeerServer(page);
  await page.addInitScript((signalingUrl) => {
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
        if (frame.type === 'pro-clock') {
          socket.send(JSON.stringify({ ...frame, serverTimeMs: Date.now() }));
        }
      });
    },
  );
  const snapshot = ownerSnapshot();
  setProPlaylist(snapshot, [
    {
      queueItemId: '11111111-1111-4111-8111-111111111111',
      name: 'Existing track',
      source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    },
  ]);
  const asset = {
    kind: 'pro-r2',
    assetId: 'asset_upload_00001',
    version: 1,
    byteLength: 4,
    mime: 'audio/wav',
  };
  const calls = {
    reservations: 0,
    puts: 0,
    complete: [] as Array<{ key: string | undefined; body: string | null }>,
    appends: 0,
  };
  let releaseCompletion!: () => void;
  const completionGate = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  await page.route('**/test-upload', async (route) => {
    calls.puts += 1;
    await route.fulfill({ status: 200, body: '' });
  });
  await page.route('**/api/pro-room/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/bootstrap')) {
      await fulfillProJson(page, route, {
        roomCode: PRO_ROOM_CODE,
        status: 'pin_required',
        passwordRequired: true,
      });
    } else if (pathname.endsWith('/owner-recovery') || pathname.endsWith('/snapshot')) {
      await fulfillProJson(page, route, { snapshot });
    } else if (pathname.endsWith('/signaling-tickets')) {
      await fulfillProJson(page, route, {
        ticket: `${'c'.repeat(32)}.${'D'.repeat(43)}`,
        expiresAtMs: Date.now() + 60_000,
        role: 'member',
        coordinatorEpoch: 2,
        presenceIncarnationId: PRESENCE_INCARNATION_ID,
        ticketSequence: 1,
        pendingPlaybackTransition: null,
      });
    } else if (pathname.endsWith('/presence/heartbeat')) {
      await fulfillProJson(page, route, heartbeatReply(snapshot));
    } else if (pathname.endsWith('/media/reservations')) {
      calls.reservations += 1;
      const body = request.postDataJSON() as { byteLength: number };
      expect(body.byteLength).toBe(4);
      await fulfillProJson(page, route, {
        reservation: {
          assetId: asset.assetId,
          version: 1,
          byteLength: 4,
          expiresAtMs: Date.now() + 600_000,
          upload: {
            method: 'PUT',
            url: `${E2E_APP_ORIGIN}/test-upload`,
            headers: { 'content-type': 'audio/wav' },
          },
        },
        quota: snapshot.quota,
      });
    } else if (pathname.endsWith('/complete')) {
      calls.complete.push({
        key: request.headers()['idempotency-key'],
        body: request.postData(),
      });
      if (calls.complete.length === 1) {
        await completionGate;
        await fulfillProJson(
          page,
          route,
          { error: completionError },
          completionError === 'ASSET_NOT_FOUND' ? 404 : 502,
        );
      } else {
        await fulfillProJson(page, route, { asset, quota: snapshot.quota });
      }
    } else if (pathname.endsWith('/snapshot/compact')) {
      calls.appends += 1;
      const body = request.postDataJSON() as { upserts: unknown[] };
      setProPlaylist(snapshot, [...(snapshot.playlist as unknown[]), ...body.upserts]);
      snapshot.revision = Number(snapshot.revision) + 1;
      snapshot.playlistRevision = Number(snapshot.playlistRevision) + 1;
      await fulfillProJson(page, route, { snapshot });
    } else {
      await fulfillProJson(page, route, { error: 'TEST_ADJUNCT_UNAVAILABLE' }, 503);
    }
  });
  await page.goto(`/${PRO_ROOM_CODE}#pro-recovery=${OWNER_RECOVERY_CLAIM}`);
  await page.locator('#btn-setup-confirm:not([disabled])').click();
  await expect(page.locator('#setup-overlay')).not.toHaveClass(/active/);
  const playlistTab = page.locator('#nav-playlist');
  if (await playlistTab.isVisible()) await playlistTab.click();
  await expect(page.locator('#playlist-ui')).toBeVisible();
  await expect(page.locator('#playlist-ui')).toContainText('Existing track');
  return { calls, releaseCompletion };
}

test('PRO mixed upload explains size rejection and retries completion without sending the file again', async ({
  page,
}, testInfo) => {
  const folder = await mkdtemp(join(tmpdir(), 'mxqr-upload-browser-'));
  const oversized = join(folder, 'oversized.wav');
  const valid = join(folder, 'valid.wav');
  const handle = await open(oversized, 'w');
  await handle.truncate(200 * 1024 * 1024 + 1);
  await handle.close();
  await writeFile(valid, Buffer.from([1, 2, 3, 4]));
  try {
    const { calls, releaseCompletion } = await uploadFixture(page);
    await page.locator('#file-input').setInputFiles([oversized, valid]);
    await expect.poll(() => calls.complete.length).toBe(1);
    await expect(page.locator('#main-header')).toContainText(/Finishing upload|업로드 확정 중/);
    releaseCompletion();
    await expect(page.locator('#dialog-overlay.show')).toBeVisible();
    await expect(page.locator('#dialog-message')).toContainText(/200\s?MB/);
    await expect(page.locator('#dialog-message')).toContainText('oversized.wav');
    await expect(page.locator('#btn-dialog-ok')).toHaveText(/Retry|다시 시도/);
    await page.screenshot({
      path: testInfo.outputPath('mixed-upload-reasons.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.locator('#btn-dialog-ok').click();
    await expect(page.locator('#playlist-ui')).toContainText('valid');
    await expect.poll(() => calls.appends).toBe(1);
    expect(calls.reservations).toBe(1);
    expect(calls.puts).toBe(1);
    expect(calls.complete).toHaveLength(2);
    expect(calls.complete[1]).toEqual(calls.complete[0]);
    await expect(page.locator('#dialog-overlay.show')).not.toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('completion-retry-succeeded.png'),
      fullPage: true,
      animations: 'disabled',
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('PRO empty upload shows its reason and cannot be retried', async ({ page }, testInfo) => {
  const { calls } = await uploadFixture(page);
  await page.locator('#file-input').setInputFiles({
    name: 'empty.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.alloc(0),
  });
  await expect(page.locator('#dialog-message')).toContainText(/empty file|빈 파일/);
  await expect(page.locator('#dialog-message')).toContainText('empty.wav');
  await expect(page.locator('#btn-dialog-secondary')).not.toBeVisible();
  await expect(page.locator('#btn-dialog-ok')).toHaveText(/Close|닫기/);
  expect(calls.reservations).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath('empty-file-reason.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.locator('#btn-dialog-ok').click();
  await expect(page.locator('#dialog-overlay.show')).not.toBeVisible();
  expect(calls.puts).toBe(0);
});

test('PRO large failed batch keeps its close action visible and releases every terminal file', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { calls } = await uploadFixture(page);
  await page.locator('#file-input').setInputFiles(
    Array.from({ length: 24 }, (_, index) => ({
      name: `empty-long-filename-for-batch-readability-${index + 1}.wav`,
      mimeType: 'audio/wav',
      buffer: Buffer.alloc(0),
    })),
  );
  await expect(page.locator('#dialog-message')).toContainText(
    'empty-long-filename-for-batch-readability-24.wav',
  );
  await expectDialogInsideOverlay(page);
  await expect(page.locator('#dialog-title')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#dialog-message')).toHaveCSS('overflow-y', 'auto');
  await expect(page.locator('#btn-dialog-secondary')).not.toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('large-batch-reasons.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.locator('#btn-dialog-ok').click();
  await expect(page.locator('#dialog-overlay.show')).not.toBeVisible();
  expect(calls.reservations).toBe(0);
  expect(calls.puts).toBe(0);
});

test('PRO expired upload checkpoint asks for file selection instead of retrying a missing asset', async ({
  page,
}, testInfo) => {
  const { calls, releaseCompletion } = await uploadFixture(page, 'ASSET_NOT_FOUND');
  await page.locator('#file-input').setInputFiles({
    name: 'expired.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from([1, 2, 3, 4]),
  });
  await expect.poll(() => calls.complete.length).toBe(1);
  releaseCompletion();
  await expect(page.locator('#dialog-message')).toContainText(
    /Select the file again|파일을 다시 선택/,
  );
  await expect(page.locator('#btn-dialog-secondary')).not.toBeVisible();
  await expect(page.locator('#btn-dialog-ok')).toHaveText(/Close|닫기/);
  await expectDialogInsideOverlay(page);
  await page.screenshot({
    path: testInfo.outputPath('expired-upload-reason.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.locator('#btn-dialog-ok').click();
  await expect(page.locator('#dialog-overlay.show')).not.toBeVisible();
  expect(calls.reservations).toBe(1);
  expect(calls.puts).toBe(1);
  expect(calls.complete).toHaveLength(1);
  expect(calls.appends).toBe(0);
});

test('PRO upload rows number on from the playlist and keep their ring in the icon column', async ({
  page,
}, testInfo) => {
  // Owner decision 2026-10-31 (option B): a provisional number in the number
  // column and the ring in the source icon's cell, so every title starts on
  // one line; the file going up now leads the upload rows.
  await page.setViewportSize({ width: 390, height: 844 });
  const { calls, releaseCompletion } = await uploadFixture(page);
  try {
    await page.locator('#file-input').setInputFiles(
      ['first.wav', 'second.wav', 'third.wav'].map((name) => ({
        name,
        mimeType: 'audio/wav',
        buffer: Buffer.from([1, 2, 3, 4]),
      })),
    );
    await expect.poll(() => calls.complete.length).toBe(1);
    const uploads = page.locator('#playlist-ui > .pro-upload-entry');
    await expect(uploads).toHaveCount(3);
    await expect(uploads.first()).toHaveClass(/\bis-confirming\b/);
    // Hover the first upload row: no reorder grip takes its number's place.
    await uploads.first().hover();
    await page.waitForTimeout(300);
    const rows = await page.locator('#playlist-ui').evaluate((list) => {
      const round = (value: number) => Math.round(value * 100) / 100;
      return Array.from(list.querySelectorAll<HTMLElement>(':scope > .playlist-entry'), (entry) => {
        const row = entry.querySelector('.track-item')!.getBoundingClientRect();
        const number = entry.querySelector<HTMLElement>('.track-idx');
        const numberStyle = number ? getComputedStyle(number) : null;
        const slot = entry.querySelector('.track-type-slot')?.getBoundingClientRect();
        const title = entry.querySelector('.track-name-text')!.getBoundingClientRect();
        const spinner = entry.querySelector<HTMLElement>('.track-type-slot > .pro-upload-spinner');
        const spinnerStyle = spinner ? getComputedStyle(spinner) : null;
        const size = parseFloat(spinnerStyle?.getPropertyValue('--material-elastic-size') ?? '');
        const stroke = parseFloat(
          spinnerStyle?.getPropertyValue('--material-elastic-stroke') ?? '',
        );
        return {
          upload: entry.classList.contains('pro-upload-entry'),
          title: entry.querySelector('.track-name-text')!.textContent,
          number: number?.textContent ?? null,
          numberShown: numberStyle?.opacity ?? null,
          numberColor: numberStyle?.color ?? null,
          numberWeight: numberStyle?.fontWeight ?? null,
          leadingHidden: entry.querySelector('.track-leading')!.getAttribute('aria-hidden'),
          grip: entry.querySelector('.playlist-reorder-grip') !== null,
          slotCenter: slot ? round(slot.left + slot.width / 2 - row.left) : null,
          titleStart: round(title.left - row.left),
          ring: spinner
            ? {
                outer: round(((36 + stroke) * size) / 44),
                line: round((stroke * size) / 44),
                color: spinnerStyle!.color,
              }
            : null,
          cancel: entry
            .querySelector('[data-pro-upload-action="cancel"]')
            ?.getAttribute('aria-label'),
        };
      });
    });
    expect(rows.map((row) => [row.upload, row.title, row.number])).toEqual([
      [false, 'Existing track', '1'],
      [true, 'first.wav', '2'],
      [true, 'second.wav', '3'],
      [true, 'third.wav', '4'],
    ]);
    const [committed, ...uploadRows] = rows;
    for (const row of uploadRows) {
      expect(row.numberShown).toBe('1');
      expect(row.numberColor).toBe(committed!.numberColor);
      expect(row.numberWeight).toBe('500');
      expect(row.leadingHidden).toBe('true');
      expect(row.grip).toBe(false);
      expect(row.slotCenter).toBe(committed!.slotCenter);
      expect(row.titleStart).toBe(committed!.titleStart);
      expect(row.ring).toEqual({ outer: 13, line: 1.73, color: committed!.numberColor });
      // The provisional number never enters a name.
      expect(row.cancel).toContain(row.title);
      expect(row.cancel).not.toMatch(/\d/u);
    }
    await page.screenshot({
      path: testInfo.outputPath('upload-rows.png'),
      animations: 'disabled',
    });
  } finally {
    releaseCompletion();
  }
  await expect(page.locator('#dialog-overlay.show')).toBeVisible();
});
