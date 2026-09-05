/** @vitest-environment jsdom */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCapturedLogs: vi.fn(() => '(no console output captured yet)'),
  getState: vi.fn<(path: string) => unknown>(),
  logWarn: vi.fn(),
}));

vi.mock('../../core/log-capture.ts', () => ({
  getCapturedLogs: mocks.getCapturedLogs,
}));

vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: mocks.logWarn,
  },
}));

vi.mock('../../core/state.ts', () => ({
  getState: mocks.getState,
}));

import { bus } from '../../core/events.ts';
import { bindOnboardingDebugGesture } from '../onboarding-debug-gesture.ts';
import { closeDialog, showDialog } from '../dialog.ts';
import { syncOverlayState } from '../dom.ts';
import {
  onboardingDiagnosticsForTests,
  initOnboardingDiagnostics,
  openOnboardingDiagnostics,
} from '../onboarding-diagnostics.ts';

const { collectOnboardingDiagnosticSnapshot, resetOnboardingDiagnosticsForTests } =
  onboardingDiagnosticsForTests;

const TIMELINE_STORAGE_KEY = 'mxqr:diagnostics:lifecycle-v1';

const originalNavigatorDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>(
  [
    'serviceWorker',
    'storage',
    'connection',
    'clipboard',
    'platform',
    'language',
    'userAgent',
    'hardwareConcurrency',
    'deviceMemory',
  ].map((key) => [key, Object.getOwnPropertyDescriptor(navigator, key)]),
);

interface DiagnosticHarness {
  activeWorker: ServiceWorker;
  workerPostMessage: ReturnType<typeof vi.fn>;
  workerAddEventListener: ReturnType<typeof vi.spyOn>;
  registration: ServiceWorkerRegistration;
  registrationAddEventListener: ReturnType<typeof vi.spyOn>;
  registrationUpdate: ReturnType<typeof vi.fn>;
  serviceWorkerContainer: ServiceWorkerContainer;
  getRegistration: ReturnType<typeof vi.fn>;
  connection: EventTarget;
  cacheKeys: ReturnType<typeof vi.fn>;
  storageEstimate: ReturnType<typeof vi.fn>;
}

let harness: DiagnosticHarness;

function defineNavigatorValue(key: PropertyKey, value: unknown): void {
  Object.defineProperty(navigator, key, { configurable: true, value });
}

function createHarness(): DiagnosticHarness {
  const workerPostMessage = vi.fn();
  const activeWorker = Object.assign(new EventTarget(), {
    scriptURL: 'https://musixquare.test/service-worker.js?token=worker-query-secret',
    state: 'activated' as ServiceWorkerState,
    postMessage: workerPostMessage,
  }) as unknown as ServiceWorker;
  const workerAddEventListener = vi.spyOn(activeWorker, 'addEventListener');

  const registrationUpdate = vi.fn(() => Promise.resolve());
  const registration = Object.assign(new EventTarget(), {
    active: activeWorker,
    installing: null,
    waiting: null,
    scope: 'https://musixquare.test/',
    updateViaCache: 'imports' as ServiceWorkerUpdateViaCache,
    update: registrationUpdate,
  }) as unknown as ServiceWorkerRegistration;
  const registrationAddEventListener = vi.spyOn(registration, 'addEventListener');

  const getRegistration = vi.fn(() => Promise.resolve(registration));
  const serviceWorkerContainer = Object.assign(new EventTarget(), {
    controller: activeWorker,
    getRegistration,
  }) as unknown as ServiceWorkerContainer;

  const connection = Object.assign(new EventTarget(), {
    type: 'wifi',
    effectiveType: '4g',
    downlink: 42,
    rtt: 18,
    saveData: false,
  });
  const cacheKeys = vi.fn(() =>
    Promise.resolve(['unrelated-cache', 'musixquare-runtime-v900', 'musixquare-static-v900']),
  );
  const storageEstimate = vi.fn(() =>
    Promise.resolve({ usage: 5 * 1048576, quota: 100 * 1048576 }),
  );

  return {
    activeWorker,
    workerPostMessage,
    workerAddEventListener,
    registration,
    registrationAddEventListener,
    registrationUpdate,
    serviceWorkerContainer,
    getRegistration,
    connection,
    cacheKeys,
    storageEstimate,
  };
}

function restoreNavigatorDescriptors(): void {
  for (const [key, descriptor] of originalNavigatorDescriptors) {
    if (descriptor) Object.defineProperty(navigator, key, descriptor);
    else Reflect.deleteProperty(navigator, key);
  }
}

function countOccurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

beforeEach(() => {
  resetOnboardingDiagnosticsForTests();
  vi.clearAllMocks();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-mxqr-navigation-source');
  window.history.replaceState({}, '', '/654321?token=url-query-secret&view=diagnostics');

  mocks.getState.mockImplementation((path: string) => {
    const values: Record<string, unknown> = {
      'network.appRole': 'idle',
      'network.connectedPeers': [{}, {}],
      'network.connectionType': 'unknown',
      'network.hostConn': { open: false },
      'network.isConnecting': true,
      'network.signalingHealth': { status: 'reconnecting', attempt: 2, maxAttempts: 5 },
      'room.context': {
        kind: 'standard',
        roomId: null,
        role: 'idle',
        coordinatorId: null,
        epoch: 0,
        snapshotRevision: 0,
        capabilities: [],
      },
      'setup.sessionStarted': false,
    };
    return values[path];
  });

  harness = createHarness();
  defineNavigatorValue('serviceWorker', harness.serviceWorkerContainer);
  defineNavigatorValue('connection', harness.connection);
  defineNavigatorValue('storage', { estimate: harness.storageEstimate });
  defineNavigatorValue('clipboard', undefined);
  defineNavigatorValue('platform', 'TestPhoneOS');
  defineNavigatorValue('language', 'ko-KR');
  defineNavigatorValue('userAgent', 'MUSIXQUARE Diagnostic Mobile Browser Chrome/140.0.0.0');
  defineNavigatorValue('hardwareConcurrency', 8);
  defineNavigatorValue('deviceMemory', 4);
  vi.stubGlobal('caches', { keys: harness.cacheKeys });
});

afterEach(() => {
  resetOnboardingDiagnosticsForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  restoreNavigatorDescriptors();
  window.history.replaceState({}, '', '/');
});

afterAll(() => {
  restoreNavigatorDescriptors();
});

describe('onboarding diagnostics snapshot', () => {
  it('collects useful passive runtime, PWA, cache, and network state without mutating it', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const intervalSpy = vi.spyOn(window, 'setInterval');

    const snapshot = await collectOnboardingDiagnosticSnapshot();

    expect(snapshot).toContain('MUSIXQUARE ONBOARDING DIAGNOSTICS');
    expect(snapshot).toContain(
      '[Runtime] ua=MUSIXQUARE Diagnostic Mobile Browser Chrome/140.0.0.0 | platform=TestPhoneOS | language=ko-KR | hardwareConcurrency=8 | deviceMemory=4',
    );
    expect(snapshot).toContain('[Location] pathKind=room-invite queryKeys=token,view');
    expect(snapshot).toContain('[NetworkInfo] type=wifi effective=4g downlink=42 rtt=18');
    expect(snapshot).toContain(
      '[App Network] room=standard/idle sessionStarted=false isConnecting=true',
    );
    expect(snapshot).toContain('[ServiceWorker] controller=activated@/service-worker.js');
    expect(snapshot).toContain('active=activated@/service-worker.js waiting=none installing=none');
    expect(snapshot).toContain('[Caches] generations=2');
    expect(snapshot).toContain('musixquare-runtime-v900');
    expect(snapshot).toContain('[Storage] usage=5.0MiB quota=100.0MiB');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(harness.registrationUpdate).not.toHaveBeenCalled();
    expect(harness.workerPostMessage).not.toHaveBeenCalled();
  });

  it('redacts JSON, query, bearer, PIN/code, identifier, IP, and email secrets', async () => {
    mocks.getCapturedLogs.mockReturnValue(
      [
        '11:22:33.444 WARN [Transport] Bearer bearer-secret',
        '{"token":"json-token-secret","roomPassword":"12345678","peerId":"peer-secret","roomId":"room-secret"}',
        'https://example.test/path?token=url-token-secret&code=654321',
        'standalone 123456 and 87654321',
        'guest peers mx-aBcDeFgHiJkLmNo_ and mx-aBcDeFgHiJkLmNo-',
        'opaque abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_',
        '550e8400-e29b-41d4-a716-446655440000 user@example.com 192.0.2.10',
        '11:22:34.000 INFO [Host] Minji iPhone connection established (peer: mx-privateDeviceId_)',
        '11:22:35.000 DEBUG [Preload] Starting for: divorce-documents.mp3 session: 1',
        '11:22:36.000 INFO [SW] Existing waiting worker detected',
        '11:22:37.000 ERROR [App] room-session feature load failed; reload required: TypeError',
      ].join('\n'),
    );
    sessionStorage.setItem(
      TIMELINE_STORAGE_KEY,
      JSON.stringify([
        {
          at: Date.now(),
          event: 'restored',
          detail: 'token=timeline-secret peerId=timeline-peer 999999',
        },
      ]),
    );
    initOnboardingDiagnostics();

    const snapshot = await collectOnboardingDiagnosticSnapshot();

    for (const secret of [
      'bearer-secret',
      'json-token-secret',
      '12345678',
      'peer-secret',
      'room-secret',
      'url-token-secret',
      '654321',
      '123456',
      '87654321',
      'mx-aBcDeFgHiJkLmNo_',
      'mx-aBcDeFgHiJkLmNo-',
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_',
      '550e8400-e29b-41d4-a716-446655440000',
      'user@example.com',
      '192.0.2.10',
      'timeline-secret',
      'timeline-peer',
      '999999',
      'url-query-secret',
      'worker-query-secret',
      'Minji iPhone',
      'divorce-documents.mp3',
      'mx-privateDeviceId_',
    ]) {
      expect(snapshot).not.toContain(secret);
    }
    expect(snapshot).toContain('Bearer [redacted]');
    expect(snapshot).toContain('[6-digit-redacted]');
    expect(snapshot).toContain('[8-digit-redacted]');
    expect(snapshot).toContain('[id-redacted]');
    expect(snapshot).toContain('[email-redacted]');
    expect(snapshot).toContain('[ip-redacted]');
    expect(snapshot).toContain('[App] room-session feature load failed');
  });
});

describe('onboarding diagnostics lifecycle', () => {
  it('binds once, observes each worker/registration once, and fully resets singleton listeners', async () => {
    vi.useFakeTimers();

    initOnboardingDiagnostics();
    initOnboardingDiagnostics();
    await vi.advanceTimersByTimeAsync(1500);
    harness.serviceWorkerContainer.dispatchEvent(new Event('controllerchange'));
    await Promise.resolve();
    window.dispatchEvent(new Event('online'));
    bus.emit('state:network.isConnecting', true, 'network.isConnecting');

    let snapshot = await collectOnboardingDiagnosticSnapshot();
    expect(countOccurrences(snapshot, 'window:online')).toBe(1);
    expect(countOccurrences(snapshot, 'state:isConnecting')).toBe(1);
    expect(
      harness.registrationAddEventListener.mock.calls.filter(
        (call: unknown[]) => call[0] === 'updatefound',
      ),
    ).toHaveLength(1);
    expect(
      harness.workerAddEventListener.mock.calls.filter(
        (call: unknown[]) => call[0] === 'statechange',
      ),
    ).toHaveLength(1);

    resetOnboardingDiagnosticsForTests();
    initOnboardingDiagnostics();
    window.dispatchEvent(new Event('online'));
    snapshot = await collectOnboardingDiagnosticSnapshot();
    expect(countOccurrences(snapshot, 'window:online')).toBe(1);
    expect(countOccurrences(snapshot, 'state:isConnecting')).toBe(0);
  });
});

describe('onboarding diagnostics overlay', () => {
  it('preserves a later dialog lock when diagnostics closes during setup', async () => {
    document.body.innerHTML = `
      <div id="setup-overlay" class="active"><button id="setup-action">Create room</button></div>
      <div id="dialog-overlay"><h2 id="dialog-title"></h2><div id="dialog-message"></div>
        <button id="btn-dialog-ok"></button><button id="btn-dialog-secondary"></button></div>`;
    syncOverlayState('setup-overlay');
    openOnboardingDiagnostics();
    // A late authenticated session can open this ordinary nickname dialog.
    const pending = showDialog({ title: 'Nickname', message: 'Complete your profile' });
    try {
      const diagnostics = document.getElementById('onboarding-diagnostics-overlay')!;
      const dialog = document.getElementById('dialog-overlay')!;
      expect(Number(diagnostics.style.zIndex)).toBeLessThan(Number(dialog.style.zIndex));
      expect(diagnostics.inert).toBe(true);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(diagnostics.isConnected).toBe(true);
      expect(document.getElementById('setup-overlay')?.inert).toBe(true);
      expect(dialog.inert).toBe(false);
    } finally {
      closeDialog();
      await pending;
    }
    expect(document.getElementById('onboarding-diagnostics-overlay')?.inert).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('onboarding-diagnostics-overlay')).toBeNull();
    expect(document.getElementById('setup-overlay')?.inert).toBe(false);
  });
  it('reopens after close from a second ten-tap sequence', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const controller = new AbortController();
    expect(
      bindOnboardingDebugGesture({
        target,
        signal: controller.signal,
        onOpen: openOnboardingDiagnostics,
      }),
    ).toBe(true);

    for (let index = 0; index < 10; index += 1) {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    }
    const firstOverlay = document.getElementById('onboarding-diagnostics-overlay');
    expect(firstOverlay).not.toBeNull();
    const firstClose = Array.from(firstOverlay?.querySelectorAll('button') || []).find(
      (button) => button.textContent === 'CLOSE',
    ) as HTMLButtonElement;
    firstClose.click();
    expect(document.getElementById('onboarding-diagnostics-overlay')).toBeNull();

    for (let index = 0; index < 10; index += 1) {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    }
    const reopenedOverlay = document.getElementById('onboarding-diagnostics-overlay');
    expect(reopenedOverlay).not.toBeNull();
    expect(reopenedOverlay).not.toBe(firstOverlay);
    expect(document.querySelectorAll('#onboarding-diagnostics-overlay')).toHaveLength(1);

    controller.abort();
  });

  it('replaces an already-open diagnostics surface without duplicate overlays', () => {
    const background = document.createElement('main');
    document.body.appendChild(background);

    openOnboardingDiagnostics();
    const firstOverlay = document.getElementById('onboarding-diagnostics-overlay');
    expect(background.inert).toBe(true);

    openOnboardingDiagnostics();
    const secondOverlay = document.getElementById('onboarding-diagnostics-overlay');
    expect(secondOverlay).not.toBe(firstOverlay);
    expect(document.querySelectorAll('#onboarding-diagnostics-overlay')).toHaveLength(1);
    expect(background.inert).toBe(true);

    const closeButton = Array.from(secondOverlay?.querySelectorAll('button') || []).find(
      (button) => button.textContent === 'CLOSE',
    ) as HTMLButtonElement;
    closeButton.click();
    expect(background.inert).toBe(false);
  });

  it('renders a copyable partial snapshot when browser-owned diagnostic reads hang', async () => {
    vi.useFakeTimers();
    harness.getRegistration.mockReturnValue(new Promise(() => {}));
    harness.cacheKeys.mockReturnValue(new Promise(() => {}));
    harness.storageEstimate.mockReturnValue(new Promise(() => {}));

    openOnboardingDiagnostics();
    const overlay = document.getElementById('onboarding-diagnostics-overlay');
    const copyButton = Array.from(overlay?.querySelectorAll('button') || []).find(
      (button) => button.textContent === 'COPY',
    ) as HTMLButtonElement;
    const content = overlay?.querySelector('.onboarding-diagnostics-content') as HTMLElement;
    expect(copyButton.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(1500);

    expect(copyButton.disabled).toBe(false);
    expect(content.textContent).toContain('[ServiceWorker] read-timeout=1500ms');
    expect(content.textContent).toContain('[Caches] read-timeout=1500ms');
    expect(content.textContent).toContain('[Storage] read-timeout=1500ms');
    expect(content.textContent).toContain('CAPTURED CONSOLE');
  });

  it('handles unavailable clipboard without calling then and copies after support appears', async () => {
    const backgroundButton = document.createElement('button');
    backgroundButton.textContent = 'background';
    document.body.appendChild(backgroundButton);
    backgroundButton.focus();
    openOnboardingDiagnostics();
    const overlay = document.getElementById('onboarding-diagnostics-overlay');
    expect(overlay).not.toBeNull();

    const copyButton = Array.from(overlay?.querySelectorAll('button') || []).find(
      (button) => button.textContent === 'COPY',
    ) as HTMLButtonElement;
    const status = overlay?.querySelector('.onboarding-diagnostics-status') as HTMLElement;
    await vi.waitFor(() => expect(copyButton.disabled).toBe(false));
    const closeButton = Array.from(overlay?.querySelectorAll('button') || []).find(
      (button) => button.textContent === 'CLOSE',
    ) as HTMLButtonElement;

    expect(backgroundButton.inert).toBe(true);
    expect(document.activeElement).toBe(closeButton);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(copyButton);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(closeButton);

    expect(() => copyButton.click()).not.toThrow();
    expect(status.textContent).toContain('Copy unavailable');

    const writeText = vi.fn(() => Promise.resolve());
    defineNavigatorValue('clipboard', { writeText });
    copyButton.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('MUSIXQUARE ONBOARDING'));

    closeButton.click();
    expect(backgroundButton.inert).toBe(false);
    expect(document.activeElement).toBe(backgroundButton);
  });
});
