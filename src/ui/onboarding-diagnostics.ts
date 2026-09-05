/**
 * Lightweight, main-bundle diagnostics for failures that happen before the
 * chat/debug lazy chunk is available. The collector is deliberately passive:
 * it never probes, updates, reconnects, or reloads a network/service-worker
 * resource, so opening it cannot accidentally heal the state being observed.
 */

import { bus } from '../core/events.ts';
import { getCapturedLogs } from '../core/log-capture.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { getRoomContext } from '../rooms/authority.ts';
import { syncOverlayState } from './dom.ts';

const OVERLAY_ID = 'onboarding-diagnostics-overlay';
const TIMELINE_STORAGE_KEY = 'mxqr:diagnostics:lifecycle-v1';
const TIMELINE_MAX_ENTRIES = 80;
const TIMELINE_MAX_AGE_MS = 30 * 60 * 1000;
const SNAPSHOT_READ_TIMEOUT_MS = 1500;

interface DiagnosticTimelineEntry {
  at: number;
  event: string;
  detail: string;
}

type SnapshotReadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'timeout' }
  | { status: 'error'; error: unknown };

interface DebugNetworkInformation extends EventTarget {
  type?: unknown;
  effectiveType?: unknown;
  downlink?: unknown;
  rtt?: unknown;
  saveData?: unknown;
}

type DebugNavigator = Navigator & {
  standalone?: boolean;
  connection?: DebugNetworkInformation;
  deviceMemory?: unknown;
};

let diagnosticsInitialized = false;
let timeline: DiagnosticTimelineEntry[] = [];
let activeOverlayCleanup: (() => void) | null = null;
let diagnosticsGeneration = 0;
const lifecycleDisposers: Array<() => void> = [];
let deferredRegistrationTimer: number | null = null;
let observedWorkers = new WeakSet<ServiceWorker>();
let observedRegistrations = new WeakSet<ServiceWorkerRegistration>();

function safeString(value: unknown, fallback = '?'): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(
      /(["'])(authorization|password|passcode|pin|secret|token|assertion|credential|roomPassword|roomCode|roomId|sessionCode|sessionId|peerId|memberId|participantId|coordinatorId|userId|objectId)\1\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}]+)/giu,
      '$1$2$1=[redacted]',
    )
    .replace(
      /\b(authorization|password|passcode|pin|secret|token|assertion|credential|roomPassword|roomCode|roomId|sessionCode|sessionId|peerId|memberId|participantId|coordinatorId|userId|objectId)\b\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}]+)/giu,
      '$1=[redacted]',
    )
    .replace(
      /([?&](?:authorization|password|passcode|pin|secret|token|assertion|credential|code)=)[^&#\s]+/giu,
      '$1[redacted]',
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[email-redacted]')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
      '[id-redacted]',
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, (match, offset: number, source: string) => {
      const prefix = source.slice(Math.max(0, offset - 16), offset);
      return /(?:Chrome|Chromium|CriOS|Edg|EdgA|EdgiOS|OPR)\/$/iu.test(prefix)
        ? match
        : '[ip-redacted]';
    })
    .replace(/\b\d{6}\b/gu, '[6-digit-redacted]')
    .replace(/\b\d{8}\b/gu, '[8-digit-redacted]')
    .replace(/(?<![A-Za-z0-9_-])mx-[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/gu, '[peer-id-redacted]')
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/gu, '[opaque-redacted]');
}

function restoreTimeline(): DiagnosticTimelineEntry[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(TIMELINE_STORAGE_KEY) || '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - TIMELINE_MAX_AGE_MS;
    return parsed
      .filter((entry): entry is DiagnosticTimelineEntry => {
        if (!entry || typeof entry !== 'object') return false;
        const candidate = entry as Partial<DiagnosticTimelineEntry>;
        return (
          typeof candidate.at === 'number' &&
          candidate.at >= cutoff &&
          typeof candidate.event === 'string' &&
          typeof candidate.detail === 'string'
        );
      })
      .map((entry) => ({
        at: entry.at,
        event: redactDiagnosticText(entry.event).slice(0, 80),
        detail: redactDiagnosticText(entry.detail).slice(0, 240),
      }))
      .slice(-TIMELINE_MAX_ENTRIES);
  } catch {
    return [];
  }
}

function persistTimeline(): void {
  try {
    sessionStorage.setItem(TIMELINE_STORAGE_KEY, JSON.stringify(timeline));
  } catch {
    // Diagnostics must keep working when storage is denied or full.
  }
}

function recordLifecycle(event: string, detail: string): void {
  timeline.push({
    at: Date.now(),
    event: redactDiagnosticText(event).slice(0, 80),
    detail: redactDiagnosticText(detail).slice(0, 240),
  });
  if (timeline.length > TIMELINE_MAX_ENTRIES) {
    timeline.splice(0, timeline.length - TIMELINE_MAX_ENTRIES);
  }
  persistTimeline();
}

function connectionSummary(): string {
  try {
    const connection = (navigator as DebugNavigator).connection;
    if (!connection) return 'unavailable';
    return [
      `type=${safeString(connection.type)}`,
      `effective=${safeString(connection.effectiveType)}`,
      `downlink=${safeString(connection.downlink)}`,
      `rtt=${safeString(connection.rtt)}`,
      `saveData=${safeString(connection.saveData, 'false')}`,
    ].join(' ');
  } catch {
    return 'unreadable';
  }
}

function workerSummary(worker: ServiceWorker | null | undefined): string {
  if (!worker) return 'none';
  let pathname = 'unknown';
  try {
    pathname = new URL(worker.scriptURL, location.href).pathname;
  } catch {
    // Keep the path opaque when a synthetic/old browser object is malformed.
  }
  return redactDiagnosticText(`${worker.state}@${pathname}`);
}

function markerAge(key: string, now: number): string {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return 'missing';
    const timestamp = Number(raw);
    if (!Number.isFinite(timestamp)) return 'invalid';
    const age = Math.max(0, now - timestamp);
    return `${Math.round(age / 1000)}s ago`;
  } catch {
    return 'unavailable';
  }
}

function navigationSummary(): string {
  try {
    const navigation = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (!navigation) return 'unavailable';
    return [
      `type=${navigation.type}`,
      `duration=${Math.round(navigation.duration)}ms`,
      `transfer=${navigation.transferSize || 0}`,
      `encoded=${navigation.encodedBodySize || 0}`,
    ].join(' ');
  } catch {
    return 'unreadable';
  }
}

function mainAssetPath(): string {
  try {
    const scripts = Array.from(document.scripts);
    const main = scripts.find(
      (script) => script.type === 'module' && /\/assets\/main-[^/]+\.js$/u.test(script.src),
    );
    return main ? new URL(main.src, location.href).pathname : 'unknown';
  } catch {
    return 'unreadable';
  }
}

function displayMode(): string {
  try {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as DebugNavigator).standalone === true;
    return standalone ? 'standalone' : 'browser';
  } catch {
    return 'unknown';
  }
}

function formatTimeline(entries: readonly DiagnosticTimelineEntry[]): string {
  if (entries.length === 0) return '(no lifecycle events recorded)';
  return entries
    .map((entry) => {
      const time = new Date(entry.at).toISOString().slice(11, 23);
      return `${time} ${entry.event} ${entry.detail}`.trimEnd();
    })
    .join('\n');
}

function capturedSupportLogs(): string {
  const captured = getCapturedLogs();
  if (captured === '(no console output captured yet)') return captured;

  const entryStart = /^\d{2}:\d{2}:\d{2}\.\d{3}\s+[A-Z]+\s+/u;
  const relevantTag =
    /\[(?:App|SW|Network|Transport|Setup|Join|Peer|Guest|Account|Diagnostics|Global)\]/u;
  const result: string[] = [];
  let includeEntry = false;
  for (const line of captured.split('\n')) {
    if (entryStart.test(line)) {
      includeEntry = relevantTag.test(line) || /\s(?:UNCAUGHT|REJECT)\s/u.test(line);
    }
    if (includeEntry) result.push(line);
  }
  return result.length > 0
    ? redactDiagnosticText(result.join('\n'))
    : '(no setup/update diagnostic console entries captured)';
}

/**
 * Bound browser-owned diagnostic reads without abandoning their eventual
 * Promise outcome. A wedged SW/CacheStorage IPC must not wedge the support UI.
 */
function readSnapshotValue<T>(read: () => PromiseLike<T>): Promise<SnapshotReadResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: number | null = null;
    const finish = (result: SnapshotReadResult<T>): void => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      resolve(result);
    };

    let operation: PromiseLike<T>;
    try {
      operation = read();
    } catch (error) {
      finish({ status: 'error', error });
      return;
    }

    timeoutId = window.setTimeout(() => finish({ status: 'timeout' }), SNAPSHOT_READ_TIMEOUT_MS);
    Promise.resolve(operation).then(
      (value) => finish({ status: 'ok', value }),
      (error: unknown) => finish({ status: 'error', error }),
    );
  });
}

async function serviceWorkerSnapshot(): Promise<string[]> {
  if (!('serviceWorker' in navigator)) return ['[ServiceWorker] unsupported'];
  const registrationRead = await readSnapshotValue(() =>
    navigator.serviceWorker.getRegistration('/'),
  );
  if (registrationRead.status === 'timeout') {
    return [`[ServiceWorker] read-timeout=${SNAPSHOT_READ_TIMEOUT_MS}ms`];
  }
  if (registrationRead.status === 'error') {
    return [
      `[ServiceWorker] snapshot-error=${redactDiagnosticText(registrationRead.error instanceof Error ? registrationRead.error.message : String(registrationRead.error))}`,
    ];
  }
  const registration = registrationRead.value;
  return [
    `[ServiceWorker] controller=${workerSummary(navigator.serviceWorker.controller)}`,
    `[SW Registration] active=${workerSummary(registration?.active)} waiting=${workerSummary(registration?.waiting)} installing=${workerSummary(registration?.installing)} updateViaCache=${registration?.updateViaCache ?? 'unknown'}`,
  ];
}

async function cacheSnapshot(): Promise<string[]> {
  const lines: string[] = [];
  const cacheRead = typeof caches === 'undefined' ? null : readSnapshotValue(() => caches.keys());
  const storageEstimate = navigator.storage?.estimate;
  const storageRead =
    typeof storageEstimate === 'function'
      ? readSnapshotValue(() => storageEstimate.call(navigator.storage))
      : null;
  const [cacheResult, storageResult] = await Promise.all([cacheRead, storageRead] as const);

  if (cacheResult === null) {
    lines.push('[Caches] unsupported');
  } else if (cacheResult.status === 'timeout') {
    lines.push(`[Caches] read-timeout=${SNAPSHOT_READ_TIMEOUT_MS}ms`);
  } else if (cacheResult.status === 'error') {
    lines.push(
      `[Caches] snapshot-error=${redactDiagnosticText(cacheResult.error instanceof Error ? cacheResult.error.message : String(cacheResult.error))}`,
    );
  } else {
    const keys = cacheResult.value
      .filter((key) => key.startsWith('musixquare-')) // brand-capitalization: allow-technical
      .sort();
    lines.push(`[Caches] generations=${keys.length}`);
    lines.push(keys.length ? `  ${redactDiagnosticText(keys.join('\n  '))}` : '  (none)');
  }

  if (storageResult?.status === 'timeout') {
    lines.push(`[Storage] read-timeout=${SNAPSHOT_READ_TIMEOUT_MS}ms`);
  } else if (storageResult?.status === 'error') {
    lines.push(
      `[Storage] snapshot-error=${redactDiagnosticText(storageResult.error instanceof Error ? storageResult.error.message : String(storageResult.error))}`,
    );
  } else if (storageResult?.status === 'ok') {
    const estimate = storageResult.value;
    const usageMiB = ((estimate.usage || 0) / 1048576).toFixed(1);
    const quotaMiB = ((estimate.quota || 0) / 1048576).toFixed(1);
    lines.push(`[Storage] usage=${usageMiB}MiB quota=${quotaMiB}MiB`);
  }
  return lines;
}

/** Collect one passive, redacted snapshot suitable for sharing with support. */
async function collectOnboardingDiagnosticSnapshot(): Promise<string> {
  const now = Date.now();
  const roomContext = getRoomContext();
  const hostConn = getState('network.hostConn');
  const signalingHealth = getState('network.signalingHealth');
  const peers = getState('network.connectedPeers');
  const queryKeys = (() => {
    try {
      return [...new URLSearchParams(location.search).keys()].sort().join(',') || 'none';
    } catch {
      return 'unreadable';
    }
  })();
  const navigationSource = document.documentElement.dataset.mxqrNavigationSource || 'unknown';
  const debugNavigator = navigator as DebugNavigator;
  const pathKind = /^\/\d{6}\/?$/u.test(location.pathname)
    ? 'room-invite'
    : location.pathname === '/'
      ? 'root'
      : 'other';
  const [serviceWorkerLines, cacheLines] = await Promise.all([
    serviceWorkerSnapshot(),
    cacheSnapshot(),
  ]);
  const lines = [
    'MUSIXQUARE ONBOARDING DIAGNOSTICS',
    `Captured: ${new Date(now).toISOString()}`,
    `Main asset: ${mainAssetPath()}`,
    '',
    `[Page] ready=${document.readyState} visibility=${document.visibilityState} focused=${document.hasFocus()} online=${navigator.onLine}`,
    redactDiagnosticText(
      `[Runtime] ua=${safeString(navigator.userAgent)} | platform=${safeString(navigator.platform)} | language=${safeString(navigator.language)} | hardwareConcurrency=${safeString(navigator.hardwareConcurrency)} | deviceMemory=${safeString(debugNavigator.deviceMemory, 'unavailable')}`,
    ),
    `[PWA] mode=${displayMode()} navigationSource=${redactDiagnosticText(navigationSource)}`,
    `[Navigation] ${navigationSummary()}`,
    `[Location] pathKind=${pathKind} queryKeys=${redactDiagnosticText(queryKeys)}`,
    `[Viewport] ${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio || 1}`,
    `[NetworkInfo] ${connectionSummary()}`,
    `[App Network] room=${roomContext.kind}/${roomContext.role} sessionStarted=${getState('setup.sessionStarted')} isConnecting=${getState('network.isConnecting')} connectionType=${getState('network.connectionType')}`,
    `[Host Connection] present=${Boolean(hostConn)} open=${hostConn?.open === true}`,
    `[Signaling] status=${signalingHealth.status} attempt=${signalingHealth.attempt}/${signalingHealth.maxAttempts} peers=${Array.isArray(peers) ? peers.length : 0}`,
    `[SW Markers] updated=${markerAge('sw-updated-at', now)} controllerConfirmed=${markerAge('sw-controller-confirmed-at', now)}`,
    ...serviceWorkerLines,
    ...cacheLines,
    '',
    'LIFECYCLE TIMELINE (last 30 minutes)',
    formatTimeline(timeline),
    '',
    'CAPTURED CONSOLE (setup/update only; redacted)',
    capturedSupportLogs(),
  ];
  return lines.join('\n');
}

function isCurrentDiagnosticsGeneration(generation: number): boolean {
  return diagnosticsInitialized && diagnosticsGeneration === generation;
}

function addLifecycleListener(target: EventTarget, type: string, listener: EventListener): void {
  target.addEventListener(type, listener);
  lifecycleDisposers.push(() => target.removeEventListener(type, listener));
}

function observeWorker(
  label: string,
  worker: ServiceWorker | null | undefined,
  generation: number,
): void {
  if (!worker || !isCurrentDiagnosticsGeneration(generation) || observedWorkers.has(worker)) return;
  observedWorkers.add(worker);
  recordLifecycle(`sw:${label}`, workerSummary(worker));
  addLifecycleListener(worker, 'statechange', () => {
    if (!isCurrentDiagnosticsGeneration(generation)) return;
    recordLifecycle(`sw:${label}:statechange`, workerSummary(worker));
  });
}

async function observeRegistration(generation: number): Promise<void> {
  if (!('serviceWorker' in navigator) || !isCurrentDiagnosticsGeneration(generation)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (!isCurrentDiagnosticsGeneration(generation)) return;
    if (!registration) {
      recordLifecycle('sw:registration', 'none');
      return;
    }
    recordLifecycle(
      'sw:registration',
      `active=${workerSummary(registration.active)} waiting=${workerSummary(registration.waiting)} installing=${workerSummary(registration.installing)}`,
    );
    observeWorker('active', registration.active, generation);
    observeWorker('waiting', registration.waiting, generation);
    observeWorker('installing', registration.installing, generation);
    if (observedRegistrations.has(registration)) return;
    observedRegistrations.add(registration);
    addLifecycleListener(registration, 'updatefound', () => {
      if (!isCurrentDiagnosticsGeneration(generation)) return;
      recordLifecycle('sw:updatefound', workerSummary(registration.installing));
      observeWorker('installing', registration.installing, generation);
    });
  } catch (error) {
    if (!isCurrentDiagnosticsGeneration(generation)) return;
    recordLifecycle(
      'sw:registration-error',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Bind low-frequency lifecycle observers once; no polling or recovery work. */
export function initOnboardingDiagnostics(): void {
  if (diagnosticsInitialized) return;
  diagnosticsInitialized = true;
  const generation = ++diagnosticsGeneration;
  timeline = restoreTimeline();
  recordLifecycle(
    'document:start',
    `online=${navigator.onLine} visibility=${document.visibilityState} mode=${displayMode()} ${connectionSummary()}`,
  );

  addLifecycleListener(window, 'online', () => {
    recordLifecycle('window:online', connectionSummary());
  });
  addLifecycleListener(window, 'offline', () => {
    recordLifecycle('window:offline', connectionSummary());
  });
  addLifecycleListener(window, 'pageshow', (event) => {
    recordLifecycle('window:pageshow', `persisted=${(event as PageTransitionEvent).persisted}`);
  });
  addLifecycleListener(window, 'pagehide', (event) => {
    recordLifecycle('window:pagehide', `persisted=${(event as PageTransitionEvent).persisted}`);
  });
  addLifecycleListener(window, 'mxqr:navigation-source', (event) => {
    const source = (event as CustomEvent<{ source?: unknown }>).detail?.source;
    recordLifecycle('navigation:source', `source=${safeString(source)}`);
  });
  addLifecycleListener(document, 'visibilitychange', () => {
    recordLifecycle('document:visibility', `visibility=${document.visibilityState}`);
  });

  const connection = (navigator as DebugNavigator).connection;
  if (connection) {
    addLifecycleListener(connection, 'change', () => {
      recordLifecycle('network:change', connectionSummary());
    });
  }

  if ('serviceWorker' in navigator) {
    addLifecycleListener(navigator.serviceWorker, 'controllerchange', () => {
      recordLifecycle(
        'sw:controllerchange',
        `controller=${workerSummary(navigator.serviceWorker.controller)}`,
      );
      observeRegistration(generation).catch((error) => {
        log.warn('[Diagnostics] Service-worker observation failed', error);
      });
    });
    addLifecycleListener(navigator.serviceWorker, 'message', (event) => {
      const data = (event as MessageEvent).data as {
        type?: unknown;
        cacheVersion?: unknown;
        proactive?: unknown;
        navigationFallback?: unknown;
      } | null;
      if (!data || typeof data.type !== 'string' || !data.type.startsWith('MXQR_CACHE_')) return;
      recordLifecycle(
        'sw:message',
        `type=${data.type} cache=${safeString(data.cacheVersion)} proactive=${safeString(data.proactive)} fallback=${safeString(data.navigationFallback)}`,
      );
    });
  }

  lifecycleDisposers.push(
    bus.on('state:room.context', () => {
      const context = getRoomContext();
      recordLifecycle('state:roomContext', `kind=${context.kind} role=${context.role}`);
    }),
    bus.on('state:setup.sessionStarted', (started) =>
      recordLifecycle('state:sessionStarted', `started=${started}`),
    ),
    bus.on('state:network.isConnecting', (connecting) =>
      recordLifecycle('state:isConnecting', `connecting=${connecting}`),
    ),
    bus.on('state:network.connectionType', (type) =>
      recordLifecycle('state:connectionType', `type=${type}`),
    ),
    bus.on('state:network.signalingHealth', () => {
      const health = getState('network.signalingHealth');
      recordLifecycle(
        'state:signalingHealth',
        `status=${health.status} attempt=${health.attempt}/${health.maxAttempts}`,
      );
    }),
    bus.on('state:network.hostConn', (connectionState) =>
      recordLifecycle(
        'state:hostConn',
        `present=${Boolean(connectionState)} open=${getState('network.hostConn')?.open === true}`,
      ),
    ),
  );

  observeRegistration(generation).catch((error) => {
    log.warn('[Diagnostics] Initial service-worker observation failed', error);
  });
  deferredRegistrationTimer = window.setTimeout(() => {
    deferredRegistrationTimer = null;
    if (!isCurrentDiagnosticsGeneration(generation)) return;
    observeRegistration(generation).catch((error) => {
      log.warn('[Diagnostics] Deferred service-worker observation failed', error);
    });
  }, 1500);
}

function createAction(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'onboarding-diagnostics-action';
  button.textContent = label;
  return button;
}

/** Open a static, manually refreshable support surface from the hidden gesture. */
export function openOnboardingDiagnostics(): void {
  activeOverlayCleanup?.();
  document.getElementById(OVERLAY_ID)?.remove();

  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'debug-memory-overlay onboarding-diagnostics-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'MUSIXQUARE onboarding diagnostics');

  const pre = document.createElement('pre');
  pre.className = 'debug-memory-content onboarding-diagnostics-content';
  pre.textContent = 'Collecting diagnostics…';
  overlay.appendChild(pre);

  const status = document.createElement('div');
  status.className = 'onboarding-diagnostics-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Passive snapshot • no network probe';

  const actions = document.createElement('div');
  actions.className = 'onboarding-diagnostics-actions';
  const copyButton = createAction('COPY');
  const refreshButton = createAction('REFRESH');
  const closeButton = createAction('CLOSE');
  copyButton.disabled = true;
  actions.append(copyButton, refreshButton, closeButton);
  overlay.append(status, actions);

  let disposed = false;
  let collectionGeneration = 0;
  let snapshot = '';
  const renderSnapshot = (): void => {
    const generation = ++collectionGeneration;
    refreshButton.disabled = true;
    status.textContent = 'Collecting passive snapshot…';
    collectOnboardingDiagnosticSnapshot()
      .then((nextSnapshot) => {
        if (disposed || generation !== collectionGeneration) return;
        snapshot = nextSnapshot;
        pre.textContent = nextSnapshot;
        copyButton.disabled = false;
        refreshButton.disabled = false;
        status.textContent = 'Snapshot ready • use COPY, then CLOSE';
      })
      .catch((error: unknown) => {
        if (disposed || generation !== collectionGeneration) return;
        pre.textContent = `[diagnostic snapshot failed] ${redactDiagnosticText(error instanceof Error ? error.message : String(error))}`;
        refreshButton.disabled = false;
        status.textContent = 'Snapshot failed • retry is safe';
      });
  };

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    collectionGeneration += 1;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    syncOverlayState();
    if (activeOverlayCleanup === cleanup) activeOverlayCleanup = null;
    try {
      previousFocus?.focus({ preventScroll: true });
    } catch {
      previousFocus?.focus();
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (overlay.hasAttribute('inert') || (event.key !== 'Escape' && event.key !== 'Tab')) return;
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      cleanup();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      overlay.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !overlay.contains(active))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (active === last || !overlay.contains(active))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  copyButton.addEventListener('click', () => {
    if (!snapshot) return;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      status.textContent = 'Copy unavailable • long-press the text to select';
      return;
    }
    clipboard
      .writeText(snapshot)
      .then(() => {
        if (!disposed) status.textContent = 'Copied • send this snapshot to support';
      })
      .catch(() => {
        if (!disposed) status.textContent = 'Copy unavailable • long-press the text to select';
      });
  });
  refreshButton.addEventListener('click', renderSnapshot);
  closeButton.addEventListener('click', cleanup);
  document.addEventListener('keydown', onKey);

  activeOverlayCleanup = cleanup;
  document.body.appendChild(overlay);
  syncOverlayState(OVERLAY_ID);
  closeButton.focus({ preventScroll: true });
  renderSnapshot();
}

function resetOnboardingDiagnosticsForTests(): void {
  activeOverlayCleanup?.();
  activeOverlayCleanup = null;
  diagnosticsGeneration += 1;
  diagnosticsInitialized = false;
  if (deferredRegistrationTimer !== null) {
    window.clearTimeout(deferredRegistrationTimer);
    deferredRegistrationTimer = null;
  }
  for (const dispose of lifecycleDisposers.splice(0)) {
    try {
      dispose();
    } catch {
      // Test reset is best-effort and must not mask the assertion result.
    }
  }
  observedWorkers = new WeakSet<ServiceWorker>();
  observedRegistrations = new WeakSet<ServiceWorkerRegistration>();
  timeline = [];
  try {
    sessionStorage.removeItem(TIMELINE_STORAGE_KEY);
  } catch {
    // ignored in storage-denied test environments
  }
}

/** @internal Narrow test seam; production callers use init/open only. */
export const onboardingDiagnosticsForTests = {
  collectOnboardingDiagnosticSnapshot,
  resetOnboardingDiagnosticsForTests,
} as const;
