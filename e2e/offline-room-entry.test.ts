/**
 * Offline room guidance: what the setup screen says when a room cannot be
 * made or joined because the device has no network.
 *
 * Every answer is synthetic: the signaling URLs point at a closed local port,
 * the app's /api requests get no answer, and the room codes are fixtures
 * (482913 for a Standard room, 012345 for a PRO room), never a real room. The
 * UI is Korean.
 *
 * Service workers are blocked here (the WebKit lane blocks them in its
 * config), so nothing precaches a room chunk. An installed app has the
 * Standard room chunks in its install precache but not the PRO runtime, so
 * the Standard rows first load their room chunks online in the same document:
 * they choose the role and make one attempt, which the closed port fails, then
 * go offline and press Retry. The cold-chunk row keeps the uncontrolled path
 * on purpose, and the candidate row lets the real service worker answer the
 * PRO runtime it never cached. WebKit's offline emulation rejects navigations
 * before a service worker sees them, so no row navigates while offline there.
 *
 * Each row saves a full-page screenshot of every end state before its
 * assertions and logs navigator.onLine at that moment, so the same file also
 * takes the pictures of a build without the guidance. The copy assertions are
 * soft, so such a build still reaches every end state and fails on its copy.
 */
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import type { ProRoomSnapshot } from '../src/pro-room/contracts.ts';
import {
  waitForBootstrapCachedNavigationFallback,
  waitForBootstrapReady,
} from './helpers/bootstrap.ts';
import { installFakeYt } from './helpers/fake-yt.ts';
import {
  heartbeatReply,
  ownerSnapshot,
  PRESENCE_INCARNATION_ID,
} from './helpers/pro-room-fixture.ts';
import { waitForState } from './helpers/wait.ts';

test.use({ serviceWorkers: 'block', locale: 'ko-KR' });

type Theme = 'light' | 'dark';

const STANDARD_ROOM_CODE = '482913';
const PRO_ROOM_CODE = '012345';
/** Nothing listens on port 9 (discard), so every signaling socket fails at once. */
const SIGNALING_URL = 'ws://127.0.0.1:9/api/rooms';
const SIGNALING_FALLBACK_URL = 'ws://localhost:9/api/rooms';
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

const PRO_RUNTIME_CHUNK = /^\/assets\/runtime-[\w-]+\.js$/;
const QR_DECODER_CHUNK = /^\/assets\/jsQR-[\w-]+\.js$/;
const CONNECT_CHUNK = /^\/assets\/connect-session-runtime-[\w-]+\.js$/;
const ROOM_SESSION_CHUNK = /^\/assets\/room-session-feature-runtime-[\w-]+\.js$/;
const ANNOUNCEMENT_CHUNK = /^\/assets\/announcement-[\w-]+\.js$/;
const BRIDGE_OPEN_PATH = '/api/standard-signaling/v1/bridge/open';

/** The Korean texts these screens can show (src/i18n/ko.ts). */
const KO = {
  networkIssue: '네트워크 연결에 문제가 있어요\n인터넷 연결을 확인해 주세요',
  sessionCreateFail: '세션을 만들지 못했어요',
  networkGeneric: '네트워크 오류가 발생했어요',
  proConnectFailed: 'PRO 방에 연결하지 못했어요',
  featureRefreshTitle: '새로고침이 필요해요',
  featureRefreshMessage:
    'MUSIXQUARE가 업데이트되었어요.\n정상적으로 사용하려면 새로고침이 필요해요.',
  updateLine: '새 버전이 준비되었어요\n새로고침하면 업데이트가 적용돼요',
  cameraUnavailable: '카메라를 시작할 수 없어요',
  retry: '다시 시도',
  refresh: '새로고침',
  close: '닫기',
  back: '돌아가기',
  start: '시작하기',
} as const;

/** The copy is already on screen when it is read; only a wrong text waits. */
const COPY = { timeout: 2_000 };

interface RowNetwork {
  /** Set with the browser's offline switch: nothing answers any request. */
  offline: boolean;
  /** How the PRO front door answers while online. */
  pro: 'unreachable' | 'unavailable' | 'open';
  /** The Standard HTTPS bridge's answer to its open, or null for no answer. */
  bridgeOpenStatus: number | null;
  /** A room chunk this build no longer serves (the stale-chunk control). */
  missingChunk: RegExp | null;
  /** Local paths the page requested while online (offline, nothing is downloaded). */
  requested: string[];
}

interface ScreenRecord {
  onLine: boolean;
  lines: string[];
  buttons: string[];
  dialog: { title: string; message: string; buttons: string[] } | null;
  toast: string | null;
}

function deviceName(testInfo: TestInfo): string {
  return testInfo.project.name.startsWith('webkit') ? 'webkit-iphone13' : 'chromium-desktop';
}

function memberSnapshot(): ProRoomSnapshot {
  const fixture = ownerSnapshot();
  fixture.roomCode = PRO_ROOM_CODE;
  const snapshot = fixture as unknown as ProRoomSnapshot;
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
  return snapshot;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  });
}

/** An open PRO room that admits this page as a member (e2e/pro-entry-retry.test.ts). */
async function answerOpenProRoom(route: Route, path: string, snapshot: ProRoomSnapshot) {
  if (path.endsWith('/bootstrap'))
    return json(route, { roomCode: PRO_ROOM_CODE, status: 'open', passwordRequired: false });
  if (path.endsWith('/presence/enter')) return json(route, { error: 'SESSION_REQUIRED' }, 401);
  if (path.endsWith('/sessions'))
    return json(route, { snapshot, session: { expiresAtMs: Date.now() + 60_000 } });
  if (path.endsWith('/signaling-tickets'))
    return json(route, {
      ticket: `${'c'.repeat(32)}.${'D'.repeat(43)}`,
      expiresAtMs: Date.now() + 60_000,
      role: 'member',
      coordinatorEpoch: 2,
      presenceIncarnationId: PRESENCE_INCARNATION_ID,
      ticketSequence: 1,
      pendingPlaybackTransition: null,
    });
  if (path.endsWith('/presence/heartbeat')) return json(route, heartbeatReply(snapshot));
  if (path.endsWith('/snapshot') || path.endsWith('/sessions/current/account'))
    return json(route, { snapshot });
  return json(route, { error: 'TEST_ADJUNCT_UNAVAILABLE' }, 503);
}

async function routeNetwork(page: Page, network: RowNetwork): Promise<void> {
  const snapshot = memberSnapshot();
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    // Offline, nothing answers, whatever the browser does with a routed request.
    if (network.offline) return route.abort('internetdisconnected');
    if (!LOCAL_HOSTS.has(url.hostname)) return route.abort();
    network.requested.push(url.pathname);
    if (url.pathname === '/api/auth/session')
      return json(route, { configured: true, authenticated: false, account: null });
    if (url.pathname === BRIDGE_OPEN_PATH && network.bridgeOpenStatus !== null)
      return json(route, { error: 'TEST_BRIDGE_UNAVAILABLE' }, network.bridgeOpenStatus);
    if (url.pathname.startsWith('/api/pro-room/') && network.pro === 'unavailable')
      return json(route, { error: 'TEST_PRO_ROOM_UNAVAILABLE' }, 503);
    if (url.pathname.startsWith('/api/pro-room/') && network.pro === 'open')
      return answerOpenProRoom(route, url.pathname, snapshot);
    // The signaling service, TURN and every other API: no answer at all.
    if (url.pathname.startsWith('/api/')) return route.abort('internetdisconnected');
    if (network.missingChunk?.test(url.pathname))
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
    return route.continue();
  });
}

async function storeKoreanUi(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript(
    ({ storedTheme, signalingUrl, signalingFallbackUrl }) => {
      localStorage.setItem('musixquare-lang', 'ko');
      localStorage.setItem('musixquare-theme', storedTheme);
      localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
      localStorage.setItem('musixquare-app-used-v1', '1');
      (window as unknown as Record<string, unknown>).__MUSIXQUARE_TRANSPORT__ = {
        provider: 'cloudflare',
        signalingUrl,
        signalingFallbackUrl,
      };
    },
    {
      storedTheme: theme,
      signalingUrl: SIGNALING_URL,
      signalingFallbackUrl: SIGNALING_FALLBACK_URL,
    },
  );
}

/**
 * Load the app font's faces for every text these screens can show, old and
 * new, as an installed app has the shards it drew before. A text first drawn
 * offline would fall back to a system font, so the before and after pictures
 * would differ in more than their words.
 */
async function loadCopyFaces(page: Page): Promise<void> {
  await page.evaluate(async (texts) => {
    const family = getComputedStyle(document.body).fontFamily;
    const text = texts.join('');
    await Promise.all(
      ['400', '500', '600', '700'].map((weight) =>
        document.fonts.load(`${weight} 16px ${family}`, text).catch(() => []),
      ),
    );
  }, Object.values(KO));
}

async function openApp(
  page: Page,
  testInfo: TestInfo,
  path: string,
  theme: Theme,
  setup: Partial<RowNetwork> = {},
): Promise<RowNetwork> {
  const network: RowNetwork = {
    offline: false,
    pro: 'unreachable',
    bridgeOpenStatus: null,
    missingChunk: null,
    requested: [],
    ...setup,
  };
  if (!testInfo.project.name.startsWith('webkit')) await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.emulateMedia({ colorScheme: theme });
  await storeKoreanUi(page, theme);
  await installFakeYt(page, { playDelayMs: 50 });
  await routeNetwork(page, network);
  await page.goto(path);
  await waitForBootstrapReady(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await loadCopyFaces(page);
  return network;
}

async function readOnLine(page: Page): Promise<boolean> {
  return page.evaluate(() => navigator.onLine);
}

async function goOffline(page: Page, network: RowNetwork): Promise<void> {
  network.offline = true;
  await page.context().setOffline(true);
  await expect
    .poll(() => readOnLine(page), { message: 'the browser reports no network' })
    .toBe(false);
}

async function goOnline(page: Page, network: RowNetwork): Promise<void> {
  await page.context().setOffline(false);
  network.offline = false;
  await expect
    .poll(() => readOnLine(page), { message: 'the browser reports a network' })
    .toBe(true);
}

/** Wait for the finite animations under `root` (the dialog, the toast, a View Transition). */
async function settle(page: Page, root = 'html'): Promise<void> {
  await page.locator(root).evaluate(async (element) => {
    const deadline = performance.now() + 5_000;
    const running = () =>
      element.getAnimations({ subtree: true }).filter((animation) => {
        const end = animation.effect?.getComputedTiming().endTime;
        return animation.playState === 'running' && typeof end === 'number' && Number.isFinite(end);
      });
    for (let left = running(); left.length > 0 && performance.now() < deadline; left = running()) {
      await Promise.race([
        Promise.all(left.map((animation) => animation.finished.catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - performance.now()))),
      ]);
    }
    await Promise.race([
      document.fonts.ready,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function readScreen(page: Page): Promise<ScreenRecord> {
  return page.evaluate(() => {
    const shown = (element: Element | null): element is HTMLElement =>
      element instanceof HTMLElement &&
      !element.hidden &&
      (element.checkVisibility?.() ?? element.getClientRects().length > 0);
    const label = (button: HTMLElement) =>
      `${button.getAttribute('aria-label') ?? button.innerText.trim()}${
        (button as HTMLButtonElement).disabled ? ' (disabled)' : ''
      }`;
    const lines = ['setup-host-error', 'setup-guest-error', 'setup-auto-join-error']
      .map((id) => document.getElementById(id))
      .filter(shown)
      .map((line) => line.innerText);
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('#setup-actions button'))
      .filter(shown)
      .map(label);
    const overlay = document.getElementById('dialog-overlay');
    const dialog = overlay?.classList.contains('show')
      ? {
          title: document.getElementById('dialog-title')?.innerText ?? '',
          message: document.getElementById('dialog-message')?.innerText ?? '',
          buttons: ['btn-dialog-secondary', 'btn-dialog-ok']
            .map((id) => document.getElementById(id))
            .filter(shown)
            .map(label),
        }
      : null;
    const toast = document.getElementById('toast')?.classList.contains('show')
      ? (document.getElementById('toast-msg')?.innerText ?? '')
      : null;
    return { onLine: navigator.onLine, lines, buttons, dialog, toast };
  });
}

/** A full-page screenshot of one end state, logged with what it shows and navigator.onLine. */
async function capture(
  page: Page,
  testInfo: TestInfo,
  flow: string,
  theme: Theme,
  settleRoot = 'html',
): Promise<ScreenRecord> {
  await settle(page, settleRoot);
  const screen = await readScreen(page);
  const name = `${flow}-ko-${deviceName(testInfo)}-${theme}.png`;
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
  const record = `${name} ${JSON.stringify(screen)}`;
  testInfo.annotations.push({ type: 'capture', description: record });
  console.log(`[capture] ${record}`);
  return screen;
}

/** Arm before a Retry tap: the line is cleared when that attempt starts. */
async function armLineCleared(page: Page, line: string): Promise<void> {
  await page.locator(line).evaluate((element) => {
    const flags = window as Window & { __offlineRowLineCleared?: boolean };
    flags.__offlineRowLineCleared = false;
    const observer = new MutationObserver(() => {
      if (!(element as HTMLElement).hidden) return;
      flags.__offlineRowLineCleared = true;
      observer.disconnect();
    });
    observer.observe(element, { attributes: true, attributeFilter: ['hidden'] });
  });
}

async function expectActions(page: Page, confirm: string): Promise<void> {
  await expect(page.locator('#btn-setup-back')).toBeVisible();
  await expect(page.locator('#btn-setup-back')).toBeEnabled();
  // An attribute, not the accessible name: an open dialog hides the page from it.
  await expect(page.locator('#btn-setup-back')).toHaveAttribute('aria-label', KO.back);
  await expect(page.locator('#btn-setup-confirm')).toHaveText(confirm);
  await expect(page.locator('#btn-setup-confirm')).toBeEnabled();
}

/** The line under the code (or on the invite screen) with Back and `confirm` below it. */
async function expectLine(page: Page, line: string, confirm: string = KO.retry): Promise<void> {
  await expect(page.locator(line)).toBeVisible();
  await expect(page.locator(line)).not.toBeEmpty();
  await expectActions(page, confirm);
}

/** Press Retry and wait for that attempt's own line. */
async function retry(page: Page, line: string): Promise<void> {
  await armLineCleared(page, line);
  await page.locator('#btn-setup-confirm').click();
  await page.waitForFunction(
    () => (window as Window & { __offlineRowLineCleared?: boolean }).__offlineRowLineCleared,
    undefined,
    { timeout: 15_000 },
  );
  await expectLine(page, line);
}

/** The lazy-feature recovery dialog, its title and buttons unchanged. */
async function expectFeatureDialog(page: Page): Promise<void> {
  await expect(page.locator('#dialog-overlay')).toBeVisible();
  await expect(page.locator('#dialog-message')).not.toBeEmpty();
  await expect(page.locator('#dialog-title')).toHaveText(KO.featureRefreshTitle);
  await expect(page.locator('#btn-dialog-secondary')).toHaveText(KO.close);
  await expect(page.locator('#btn-dialog-ok')).toHaveText(KO.refresh);
}

async function closeFeatureDialog(page: Page): Promise<void> {
  await page.locator('#btn-dialog-secondary').click();
  await expect(page.locator('#dialog-overlay')).toBeHidden();
}

/**
 * A camera that keeps drawing frames without a capture device: the headless
 * Chromium shell answers getUserMedia with NotSupportedError even with the
 * fake device flag. Like installSyntheticSystemAudio, it is a canvas stream,
 * and the scanner still waits for its first presented frame.
 */
async function installSyntheticCamera(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const fixture = window as Window & { __syntheticCameraStarts?: number };
    fixture.__syntheticCameraStarts = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        fixture.__syntheticCameraStarts = (fixture.__syntheticCameraStarts ?? 0) + 1;
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const context = canvas.getContext('2d')!;
        let frame = 0;
        const draw = () => {
          frame += 1;
          context.fillStyle = frame % 2 === 0 ? '#2a2d33' : '#2c2f35';
          context.fillRect(0, 0, canvas.width, canvas.height);
        };
        draw();
        const timer = window.setInterval(draw, 33);
        const stream = canvas.captureStream(30);
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            window.clearInterval(timer);
            stop();
          };
        }
        return stream;
      },
    });
  });
}

function requested(network: RowNetwork, chunk: RegExp): boolean {
  return network.requested.some((path) => chunk.test(path));
}

async function chooseHost(page: Page): Promise<void> {
  await page.locator('#btn-setup-host').click();
}

async function typeStandardCode(page: Page, code: string): Promise<void> {
  await page.locator('#btn-setup-guest').click();
  await page.locator('#setup-join-code').fill(code);
  await page.locator('#btn-setup-confirm').click();
}

test.describe('Offline room entry', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name === 'chromium-candidate',
      'These rows read the e2e build: the candidate lane runs only the installed-app row',
    );
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`F1 (${theme}): a host who makes a room offline reads the network line above Back and Retry`, async ({
      page,
    }, testInfo) => {
      test.skip(
        theme === 'dark' && testInfo.project.name !== 'webkit-iphone',
        'The dark pictures are taken on the iPhone lane',
      );
      const network = await openApp(page, testInfo, '/', theme);
      // Online: choosing the role and one attempt load the room chunks, as an
      // installed app has them precached. The closed port fails that attempt.
      await chooseHost(page);
      await expectLine(page, '#setup-host-error');
      await expect(page.locator('#setup-host-error')).toHaveText(KO.sessionCreateFail);
      expect(requested(network, CONNECT_CHUNK)).toBe(true);
      expect(requested(network, ROOM_SESSION_CHUNK)).toBe(true);

      await goOffline(page, network);
      await retry(page, '#setup-host-error');
      const screen = await capture(page, testInfo, 'F1', theme);
      expect(screen.onLine).toBe(false);
      await expect.soft(page.locator('#setup-host-error')).toHaveText(KO.networkIssue, COPY);
      await expect(page.locator('#dialog-overlay')).toBeHidden();
    });
  }

  test('F2: a guest who types a Standard code offline reads the network line above Back and Retry', async ({
    page,
  }, testInfo) => {
    const network = await openApp(page, testInfo, '/', 'light');
    await typeStandardCode(page, STANDARD_ROOM_CODE);
    await expectLine(page, '#setup-guest-error');
    await expect(page.locator('#setup-guest-error')).toHaveText(KO.networkGeneric);
    expect(requested(network, ROOM_SESSION_CHUNK)).toBe(true);

    await goOffline(page, network);
    await retry(page, '#setup-guest-error');
    const screen = await capture(page, testInfo, 'F2', 'light');
    expect(screen.onLine).toBe(false);
    await expect.soft(page.locator('#setup-guest-error')).toHaveText(KO.networkIssue, COPY);
    // A missing network is not a wrong code: the field keeps the code, unmarked.
    await expect(page.locator('#setup-join-code')).toHaveValue(STANDARD_ROOM_CODE);
    await expect(page.locator('#setup-join-code')).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('F3: a Standard invite link opened offline reads the network line above Back and Retry', async ({
    page,
  }, testInfo) => {
    const network = await openApp(page, testInfo, `/${STANDARD_ROOM_CODE}`, 'light');
    await expect(page.locator('#btn-setup-confirm')).toHaveText(KO.start);
    await page.locator('#btn-setup-confirm').click();
    await expectLine(page, '#setup-auto-join-error');
    await expect(page.locator('#setup-auto-join-error')).toHaveText(KO.networkGeneric);
    expect(requested(network, ROOM_SESSION_CHUNK)).toBe(true);

    await goOffline(page, network);
    await retry(page, '#setup-auto-join-error');
    const screen = await capture(page, testInfo, 'F3', 'light');
    expect(screen.onLine).toBe(false);
    await expect.soft(page.locator('#setup-auto-join-error')).toHaveText(KO.networkIssue, COPY);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`F4 (${theme}): a PRO invite opened offline before its runtime was downloaded names the network in the Refresh dialog`, async ({
      page,
    }, testInfo) => {
      test.skip(
        theme === 'dark' && testInfo.project.name !== 'webkit-iphone',
        'The dark pictures are taken on the iPhone lane',
      );
      const network = await openApp(page, testInfo, `/${PRO_ROOM_CODE}`, theme);
      await expect(page.locator('#btn-setup-confirm')).toHaveText(KO.start);
      await expect(page.locator('#btn-setup-confirm')).toBeEnabled();
      await goOffline(page, network);
      await page.locator('#btn-setup-confirm').click();

      await expectFeatureDialog(page);
      const modal = await capture(page, testInfo, 'F4-modal', theme);
      expect(modal.onLine).toBe(false);
      await expect.soft(page.locator('#dialog-message')).toHaveText(KO.networkIssue, COPY);
      // This device never downloaded the PRO runtime.
      expect(requested(network, PRO_RUNTIME_CHUNK)).toBe(false);

      await closeFeatureDialog(page);
      await expectActions(page, KO.refresh);
      await expect(page.locator('#setup-auto-join-error')).toBeHidden();
      const setup = await capture(page, testInfo, 'F4-setup', theme);
      expect(setup.onLine).toBe(false);
    });
  }

  test('F5: a PRO entry whose runtime is downloaded names the network offline, and opens the room once the network is back', async ({
    page,
  }, testInfo) => {
    await page.routeWebSocket(
      (url) => url.pathname.includes('/api/pro-rooms/'),
      (socket) => {
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
    const network = await openApp(page, testInfo, '/', 'light', { pro: 'unavailable' });
    // Online: the PRO runtime loads, then the front door answers 503.
    await typeStandardCode(page, PRO_ROOM_CODE);
    await expectLine(page, '#setup-guest-error');
    await expect(page.locator('#setup-guest-error')).toHaveText(KO.proConnectFailed);
    expect(requested(network, PRO_RUNTIME_CHUNK)).toBe(true);

    await goOffline(page, network);
    await retry(page, '#setup-guest-error');
    const offline = await capture(page, testInfo, 'F5-line', 'light');
    expect(offline.onLine).toBe(false);
    await expect.soft(page.locator('#setup-guest-error')).toHaveText(KO.networkIssue, COPY);

    // Back online, Retry on the same screen opens the room.
    await goOnline(page, network);
    network.pro = 'open';
    await page.locator('#btn-setup-confirm').click();
    await waitForState(page, 'setup.sessionStarted', true);
    await waitForState(page, 'room.context.kind', 'pro');
    await waitForState(page, 'room.context.role', 'member');
    await expect(page.locator('#setup-overlay')).not.toHaveClass(/\bactive\b/);
    const room = await capture(page, testInfo, 'F5-online', 'light');
    expect(room.onLine).toBe(true);
  });

  test('F6: a QR scan offline before the decoder was downloaded names the network in its toast', async ({
    browserName,
    page,
  }, testInfo) => {
    test.skip(
      browserName === 'webkit',
      "The QR row runs in Chromium: Playwright's WebKit (checked on Windows) has no " +
        'navigator.mediaDevices or canvas.captureStream, so its scanner stops at the camera ' +
        'before it asks for the decoder',
    );
    await installSyntheticCamera(page);
    const network = await openApp(page, testInfo, '/', 'light');
    await page.locator('#btn-setup-guest').click();
    const scan = page.locator('#btn-setup-qr-scan');
    await expect(scan).toBeEnabled();
    await goOffline(page, network);
    await scan.click();

    await expect(page.locator('#toast')).toHaveClass(/\bshow\b/);
    const screen = await capture(page, testInfo, 'F6', 'light', '#toast');
    expect(screen.onLine).toBe(false);
    // The toast draws its line break as <br>, which only innerText reads.
    await expect
      .soft(page.locator('#toast-msg'))
      .toHaveText(KO.networkIssue, { ...COPY, useInnerText: true });
    // One camera start presented its frames (a stalled one is tried twice):
    // only the decoder, which this device never downloaded, was missing.
    expect(
      await page.evaluate(
        () => (window as Window & { __syntheticCameraStarts?: number }).__syntheticCameraStarts,
      ),
    ).toBe(1);
    await expect(scan).toBeVisible();
    expect(requested(network, QR_DECODER_CHUNK)).toBe(false);
  });

  test('F7: a room made offline before any room chunk loaded names the network in the dialog and the line', async ({
    page,
  }, testInfo) => {
    const network = await openApp(page, testInfo, '/', 'light');
    await goOffline(page, network);
    await chooseHost(page);

    await expectFeatureDialog(page);
    await expectLine(page, '#setup-host-error', KO.refresh);
    const modal = await capture(page, testInfo, 'F7-modal', 'light');
    expect(modal.onLine).toBe(false);
    await expect.soft(page.locator('#dialog-message')).toHaveText(KO.networkIssue, COPY);
    expect(requested(network, CONNECT_CHUNK)).toBe(false);
    expect(requested(network, ROOM_SESSION_CHUNK)).toBe(false);

    await closeFeatureDialog(page);
    await expectLine(page, '#setup-host-error', KO.refresh);
    const line = await capture(page, testInfo, 'F7-line', 'light');
    expect(line.onLine).toBe(false);
    await expect.soft(page.locator('#setup-host-error')).toHaveText(KO.networkIssue, COPY);
  });

  test('C1: a room chunk missing while online still says the app was updated', async ({
    page,
  }, testInfo) => {
    const network = await openApp(page, testInfo, '/', 'light', {
      missingChunk: ROOM_SESSION_CHUNK,
    });
    await chooseHost(page);

    await expectFeatureDialog(page);
    await expectLine(page, '#setup-host-error', KO.refresh);
    const modal = await capture(page, testInfo, 'C1-modal', 'light');
    expect(modal.onLine).toBe(true);
    await expect(page.locator('#dialog-message')).toHaveText(KO.featureRefreshMessage);
    expect(requested(network, ROOM_SESSION_CHUNK)).toBe(true);

    await closeFeatureDialog(page);
    await expectLine(page, '#setup-host-error', KO.refresh);
    const line = await capture(page, testInfo, 'C1-line', 'light');
    expect(line.onLine).toBe(true);
    await expect(page.locator('#setup-host-error')).toHaveText(KO.updateLine);
  });

  test('C3: a Standard bridge that answers 503 online still reads as a network error', async ({
    page,
  }, testInfo) => {
    const network = await openApp(page, testInfo, '/', 'light', { bridgeOpenStatus: 503 });
    await typeStandardCode(page, STANDARD_ROOM_CODE);
    await expectLine(page, '#setup-guest-error');
    const screen = await capture(page, testInfo, 'C3', 'light');
    expect(screen.onLine).toBe(true);
    await expect(page.locator('#setup-guest-error')).toHaveText(KO.networkGeneric);
    expect(network.requested).toContain(BRIDGE_OPEN_PATH);
  });
});

test.describe('Offline room entry in an installed app', () => {
  test.use({ serviceWorkers: 'allow' });

  test('F4sw: an installed app that opens a PRO invite offline names the network in the Refresh dialog', async ({
    context,
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium-candidate',
      'This row needs the production build and its service worker (the chromium-candidate lane)',
    );
    const outside: string[] = [];
    context.on('request', (request) => {
      if (!LOCAL_HOSTS.has(new URL(request.url()).hostname)) outside.push(request.url());
    });
    let phase: 'online' | 'offline' = 'online';
    const answers: Array<{ phase: string; chunk: string; status: number; worker: boolean }> = [];
    const watched = {
      connect: CONNECT_CHUNK,
      announcement: ANNOUNCEMENT_CHUNK,
      pro: PRO_RUNTIME_CHUNK,
    };
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      for (const [chunk, pattern] of Object.entries(watched)) {
        if (!pattern.test(path)) continue;
        answers.push({
          phase,
          chunk,
          status: response.status(),
          worker: response.fromServiceWorker(),
        });
      }
    });
    const answered = (wanted: string, chunk: string) =>
      answers
        .filter((answer) => answer.phase === wanted && answer.chunk === chunk)
        .map(({ status, worker }) => ({ status, worker }));

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.emulateMedia({ colorScheme: 'light' });
    await storeKoreanUi(page, 'light');
    await page.goto('/');
    await waitForBootstrapReady(page);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // The installed worker now controls the invite, and opening it online
    // loads the Connect and announcement chunks through the worker. Production
    // serves them from the install precache, but the local preview adds
    // Vary: Origin to /assets (production sends none: dist/_headers), so here a
    // precached chunk that no module request fetched misses the worker's cache.
    await page.goto(`/${PRO_ROOM_CODE}`);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await waitForBootstrapReady(page);
    for (const chunk of ['connect', 'announcement']) {
      await expect.poll(() => answered('online', chunk)).toEqual([{ status: 200, worker: true }]);
    }
    // The worker keeps the font shards this document draws.
    await loadCopyFaces(page);

    phase = 'offline';
    await context.setOffline(true);
    try {
      await expect.poll(() => readOnLine(page)).toBe(false);
      // The cached app shell opens the invite again, with its chunks from the cache.
      const navigation = await page.goto(`/${PRO_ROOM_CODE}`, { waitUntil: 'domcontentloaded' });
      expect(navigation?.fromServiceWorker()).toBe(true);
      await waitForBootstrapCachedNavigationFallback(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      const start = page.locator('#btn-setup-confirm');
      await expect(start).toHaveText(KO.start);
      await expect(start).toBeEnabled();
      for (const chunk of ['connect', 'announcement']) {
        await expect
          .poll(() => answered('offline', chunk))
          .toEqual([{ status: 200, worker: true }]);
      }
      await expect(page.locator('#dialog-overlay')).toBeHidden();
      await start.click();

      await expectFeatureDialog(page);
      const modal = await capture(page, testInfo, 'F4sw-modal', 'light');
      expect(modal.onLine).toBe(false);
      await expect.soft(page.locator('#dialog-message')).toHaveText(KO.networkIssue, COPY);
      // The worker itself answered the PRO runtime it never cached.
      expect(answered('online', 'pro')).toEqual([]);
      expect(answered('offline', 'pro')).toEqual([{ status: 503, worker: true }]);
      expect(outside).toEqual([]);
    } finally {
      await context.setOffline(false);
    }
  });
});
