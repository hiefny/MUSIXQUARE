/** Toast notifications and the shared header progress indicator. */

import { log } from '../core/log.ts';
import { createBusScope } from '../core/events.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import { hasRoomCapability } from '../rooms/authority.ts';
import type { StandardOperatorFileUplinkProgress } from '../types/index.ts';
import { suppressViewTransitions } from './dom.ts';
import { applyUserTextFontFallback } from './user-text-font.ts';

const TOAST_MAX_LINE_CHARS = 50;
const TOAST_DYNAMIC_VALUE_CHARS = 28;
const ELLIPSIS = '…';

// ─── Loader (Header Progress Bar) ────────────────────────────────

const DEFAULT_LOADER_ID = '_default';
const OPERATOR_UPLINK_LOADER_PREFIX = 'standard-operator-file-uplink:';
const MAX_REMEMBERED_UPLINK_TERMINALS = 64;
const OPERATOR_UPLINK_FILE_NAME_CHARS = 22;
const HEADER_LOADING_INDICATOR_SELECTOR =
  '#main-header .material-elastic-spinner, #main-header .header-loading-spinner';
const HEADER_PROGRESS_TAU_MS = 160;
const HEADER_PROGRESS_FRAME_MS = 1000 / 60;
const HEADER_PROGRESS_EPSILON = 0.05;

interface LoaderHolder {
  text: string;
  percent: number;
  order: number;
}

// A holder owns the full visual state, not only a visibility hold. This lets a
// foreground operation temporarily cover a background transfer and restore
// the background operation's exact text/progress when it finishes.
const _loaderHolders = new Map<string, LoaderHolder>();
let _loaderOrder = 0;
let _headerProgressElement: HTMLElement | null = null;
let _headerProgressDisplayed = 0;
let _headerProgressTarget = 0;
let _headerProgressFrame: number | null = null;
let _headerProgressLastFrameAt: number | null = null;
let _headerProgressVisibilityBound = false;

const _toastBusScope = createBusScope();
const _operatorUplinkLoaderIds = new Set<string>();
const _operatorUplinkTerminalIds = new Set<string>();
const _operatorUplinkTerminalOrder: string[] = [];

function clampProgress(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

function readInitialProgress(progressBg: HTMLElement): number {
  const transformMatch = progressBg.style.transform.match(/^scaleX\(([^)]+)\)$/);
  const transformScale = transformMatch ? Number.parseFloat(transformMatch[1] ?? '') : Number.NaN;
  if (Number.isFinite(transformScale)) return clampProgress(transformScale * 100);

  // Preserve isolated embeds that still carry the old inline width until this
  // module takes ownership of the compositor-backed surface.
  const legacyWidth = Number.parseFloat(progressBg.style.width);
  return Number.isFinite(legacyWidth) ? clampProgress(legacyWidth) : 0;
}

function cancelHeaderProgressFrame(): void {
  if (
    _headerProgressFrame !== null &&
    typeof window !== 'undefined' &&
    typeof window.cancelAnimationFrame === 'function'
  ) {
    window.cancelAnimationFrame(_headerProgressFrame);
  }
  _headerProgressFrame = null;
  _headerProgressLastFrameAt = null;
}

function headerProgressNow(): number | null {
  try {
    const now = performance.now();
    return Number.isFinite(now) ? now : null;
  } catch {
    return null;
  }
}

function paintHeaderProgress(progressBg: HTMLElement, percent: number): void {
  const clamped = clampProgress(percent);
  _headerProgressDisplayed = clamped;
  const scale = Math.round((clamped / 100) * 1_000_000) / 1_000_000;
  progressBg.style.transform = `scaleX(${scale})`;
}

function attachHeaderProgress(progressBg: HTMLElement): void {
  if (_headerProgressElement === progressBg) return;

  cancelHeaderProgressFrame();
  _headerProgressElement = progressBg;
  _headerProgressDisplayed = readInitialProgress(progressBg);
  _headerProgressTarget = _headerProgressDisplayed;
  // CSS owns the full width; only transform changes from now on.
  progressBg.style.width = '';
  paintHeaderProgress(progressBg, _headerProgressDisplayed);
}

function shouldSnapHeaderProgress(): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.requestAnimationFrame !== 'function' ||
    typeof window.cancelAnimationFrame !== 'function'
  ) {
    return true;
  }
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return true;
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

function runHeaderProgressFrame(now: number): void {
  _headerProgressFrame = null;
  const progressBg = _headerProgressElement;
  if (!progressBg) return;

  if (shouldSnapHeaderProgress()) {
    paintHeaderProgress(progressBg, _headerProgressTarget);
    _headerProgressLastFrameAt = null;
    return;
  }

  const elapsedSinceLastFrame =
    _headerProgressLastFrameAt === null ? Number.NaN : now - _headerProgressLastFrameAt;
  const elapsed =
    Number.isFinite(elapsedSinceLastFrame) && elapsedSinceLastFrame >= 0
      ? elapsedSinceLastFrame
      : HEADER_PROGRESS_FRAME_MS;
  _headerProgressLastFrameAt = now;
  const alpha = 1 - Math.exp(-elapsed / HEADER_PROGRESS_TAU_MS);
  const next =
    _headerProgressDisplayed + (_headerProgressTarget - _headerProgressDisplayed) * alpha;
  paintHeaderProgress(progressBg, next);

  if (Math.abs(_headerProgressTarget - _headerProgressDisplayed) <= HEADER_PROGRESS_EPSILON) {
    paintHeaderProgress(progressBg, _headerProgressTarget);
    _headerProgressLastFrameAt = null;
    return;
  }

  _headerProgressFrame = window.requestAnimationFrame(runHeaderProgressFrame);
}

function setHeaderProgressTarget(progressBg: HTMLElement, percent: number): void {
  attachHeaderProgress(progressBg);
  _headerProgressTarget = clampProgress(percent);

  // Visible completion follows the same EMA as every other target. Callers may
  // release their holder immediately after publishing 100; the existing 400 ms
  // opacity fade leaves the frame loop enough time to converge naturally without
  // delaying the underlying work or snapping the final visible gap.
  if (shouldSnapHeaderProgress()) {
    cancelHeaderProgressFrame();
    paintHeaderProgress(progressBg, _headerProgressTarget);
    return;
  }

  if (Math.abs(_headerProgressTarget - _headerProgressDisplayed) <= HEADER_PROGRESS_EPSILON) {
    cancelHeaderProgressFrame();
    paintHeaderProgress(progressBg, _headerProgressTarget);
    return;
  }

  if (_headerProgressFrame === null) {
    // requestAnimationFrame timestamps share performance.now()'s time origin.
    // Record the real idle-to-frame gap so 60/90/120 Hz displays and delayed
    // frames all follow the same 160 ms time constant.
    _headerProgressLastFrameAt = headerProgressNow();
    _headerProgressFrame = window.requestAnimationFrame(runHeaderProgressFrame);
  }
}

function resetHeaderProgress(progressBg: HTMLElement): void {
  attachHeaderProgress(progressBg);
  cancelHeaderProgressFrame();
  _headerProgressTarget = 0;
  paintHeaderProgress(progressBg, 0);
}

function displayedProgress(progressBg: HTMLElement | null): number {
  if (!progressBg) return 0;
  attachHeaderProgress(progressBg);
  // The old width transition retained its destination through the fade. Keep
  // that logical value so a quick hide/show cannot lose an update that had
  // not reached the screen before its first animation frame.
  return _headerProgressTarget;
}

function handleHeaderProgressVisibility(): void {
  if (document.visibilityState === 'visible' || !_headerProgressElement) return;
  cancelHeaderProgressFrame();
  paintHeaderProgress(_headerProgressElement, _headerProgressTarget);
}

function removeHeaderLoadingIndicators(): void {
  // Header progress stays intentionally text + determinate background only.
  // Remove stale or dynamically reintroduced spinners in addition to the CSS
  // guard so they cannot keep animating while visually hidden.
  document.querySelectorAll(HEADER_LOADING_INDICATOR_SELECTOR).forEach((indicator) => {
    indicator.remove();
  });
}

function foregroundLoader(): [string, LoaderHolder] | null {
  let foreground: [string, LoaderHolder] | null = null;
  for (const entry of _loaderHolders) {
    if (!foreground || entry[1].order > foreground[1].order) foreground = entry;
  }
  return foreground;
}

function getLoadingTextContent(loadingText: HTMLElement | null): HTMLElement | null {
  if (!loadingText) return null;

  const existing = loadingText.querySelector<HTMLElement>('.header-loading-text-content');
  if (existing) return existing;

  // Preserve compatibility with isolated embeds and tests that still provide
  // the legacy container without the inner ellipsis element.
  const content = document.createElement('span');
  content.className = 'header-loading-text-content';
  content.textContent = loadingText.textContent || '';
  loadingText.replaceChildren(content);
  return content;
}

function renderLoader(holder: LoaderHolder): void {
  const loadingText = document.getElementById('header-loading-text');
  const loadingTextContent = getLoadingTextContent(loadingText);
  const progressBg = document.getElementById('header-progress-bg') as HTMLElement | null;
  if (loadingTextContent) loadingTextContent.textContent = holder.text;
  if (progressBg) setHeaderProgressTarget(progressBg, holder.percent);
}

export function updateLoader(percent: number, id?: string): void {
  // Explicit IDs are strict ownership tokens. Once removed, a late callback
  // with that ID must not repaint a newer operation's loader.
  if (id !== undefined) {
    const holder = _loaderHolders.get(id);
    if (!holder) return;
    holder.percent = clampProgress(percent);
    if (foregroundLoader()?.[0] === id) renderLoader(holder);
    return;
  }

  // No-ID callers own the default holder. If a named operation is temporarily
  // in front, retain the default operation's tick without repainting that
  // foreground. Named flows must use their ID for the same reason.
  const target = _loaderHolders.get(DEFAULT_LOADER_ID);
  if (target) {
    target.percent = clampProgress(percent);
    if (foregroundLoader()?.[0] === DEFAULT_LOADER_ID) renderLoader(target);
    return;
  }

  // Some older flows publish a progress tick before acquiring a holder. Keep
  // that harmless direct-DOM behavior only when no operation currently owns
  // the surface; otherwise it could corrupt an unrelated named transfer.
  if (_loaderHolders.size > 0) return;
  const progressBg = document.getElementById('header-progress-bg') as HTMLElement | null;
  if (progressBg) {
    attachHeaderProgress(progressBg);
    cancelHeaderProgressFrame();
    _headerProgressTarget = clampProgress(percent);
    paintHeaderProgress(progressBg, _headerProgressTarget);
  }
}

export function showLoader(show: boolean, txt?: string, id?: string): void {
  removeHeaderLoadingIndicators();
  const key = id ?? DEFAULT_LOADER_ID;
  const header = document.getElementById('main-header');
  const loadingText = document.getElementById('header-loading-text');
  const loadingTextContent = getLoadingTextContent(loadingText);
  const progressBg = document.getElementById('header-progress-bg') as HTMLElement | null;

  if (show) {
    const existing = _loaderHolders.get(key);
    const holder: LoaderHolder = existing
      ? {
          ...existing,
          text: txt ?? existing.text,
        }
      : {
          text: txt ?? loadingTextContent?.textContent ?? '',
          // Retaining the displayed value preserves the legacy quick
          // hide/show transition. New determinate flows should publish their
          // initial 0 tick.
          percent: key === DEFAULT_LOADER_ID ? displayedProgress(progressBg) : 0,
          order: ++_loaderOrder,
        };
    _loaderHolders.set(key, holder);
    clearManagedTimer('loader-reset');
    // Suppress View Transitions while the loading CSS transition plays
    // (1s transform + buffer) to prevent snapshot-replay double-animation
    suppressViewTransitions(1200);
    header?.classList.add('loading');
    // Repeated progress/text updates for an existing background holder must
    // not promote it over a newer foreground operation.
    if (foregroundLoader()?.[0] === key) renderLoader(holder);
  } else {
    _loaderHolders.delete(key);
    const foreground = foregroundLoader();
    if (foreground) {
      renderLoader(foreground[1]);
      return;
    }
    // Suppress through the reverse CSS transition as well
    suppressViewTransitions(1200);
    header?.classList.remove('loading');
    setManagedTimer(
      'loader-reset',
      () => {
        if (progressBg && _loaderHolders.size === 0) resetHeaderProgress(progressBg);
      },
      400,
    );
  }
}

// ─── Toast ───────────────────────────────────────────────────────

function charCount(value: string): number {
  return Array.from(value).length;
}

function sliceChars(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join('');
}

function truncateValue(value: string, maxChars: number): string {
  if (charCount(value) <= maxChars) return value;

  const extension = value.match(/(\.[a-z0-9]{1,8})$/i)?.[1] || '';
  const suffixLength = charCount(extension);

  if (extension && maxChars > suffixLength + 2) {
    const headLength = maxChars - suffixLength - charCount(ELLIPSIS);
    return `${sliceChars(value, 0, headLength)}${ELLIPSIS}${extension}`;
  }

  return `${sliceChars(value, 0, Math.max(1, maxChars - charCount(ELLIPSIS)))}${ELLIPSIS}`;
}

function truncateQuotedValues(line: string): string {
  return line.replace(/"([^"]+)"/g, (match, value: string) => {
    const overhead = charCount(line) - charCount(value);
    const lineFitLimit = TOAST_MAX_LINE_CHARS - overhead;
    const valueLimit = Math.min(TOAST_DYNAMIC_VALUE_CHARS, Math.max(8, lineFitLimit));
    if (charCount(value) <= valueLimit) return match;
    return `"${truncateValue(value, valueLimit)}"`;
  });
}

function truncateColonValue(line: string): string {
  if (charCount(line) <= TOAST_MAX_LINE_CHARS) return line;

  const colonIndex = line.indexOf(': ');
  if (colonIndex < 0) return line;

  const prefix = line.slice(0, colonIndex + 2);
  const value = line.slice(colonIndex + 2);
  const remaining = TOAST_MAX_LINE_CHARS - charCount(prefix);
  if (remaining < 8) return line;

  return `${prefix}${truncateValue(value, remaining)}`;
}

function formatToastLine(line: string): string {
  let formatted = truncateQuotedValues(line);
  formatted = truncateColonValue(formatted);

  if (charCount(formatted) <= TOAST_MAX_LINE_CHARS) return formatted;
  return truncateValue(formatted, TOAST_MAX_LINE_CHARS);
}

function formatToastText(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map(formatToastLine).join('\n');
}

export function showToast(msg: unknown, options: { durationMs?: number } = {}): void {
  try {
    const t = document.getElementById('toast');
    const msgEl = document.getElementById('toast-msg');
    const text = msg === undefined || msg === null ? '' : String(msg);
    const displayText = formatToastText(text);

    if (!t || !msgEl) {
      console.info('[Toast]', displayText);
      return;
    }

    msgEl.innerText = displayText;
    applyUserTextFontFallback(msgEl, displayText);
    msgEl.title = displayText === text ? '' : text;
    // If `.show` is already on (back-to-back toasts), briefly remove it and
    // force a reflow so the entrance animation replays — otherwise the new
    // text swaps in mid-display without any visual cue.
    if (t.classList.contains('show')) {
      t.classList.remove('show');
      // Access offsetWidth to flush pending style changes before re-adding.
      void t.offsetWidth;
    }
    t.classList.add('show');

    setManagedTimer(
      'toast-hide',
      () => {
        try {
          t.classList.remove('show');
        } catch {
          /* noop */
        }
      },
      Math.max(1000, options.durationMs || 2000),
    );
  } catch {
    console.info('[Toast fallback]', msg);
  }
}

// ─── Init ────────────────────────────────────────────────────────

function operatorUplinkLoaderId(progress: StandardOperatorFileUplinkProgress): string {
  return `${OPERATOR_UPLINK_LOADER_PREFIX}${encodeURIComponent(progress.requestId)}:${encodeURIComponent(progress.sessionId)}`;
}

function rememberOperatorUplinkTerminal(loaderId: string): boolean {
  if (_operatorUplinkTerminalIds.has(loaderId)) return false;

  _operatorUplinkTerminalIds.add(loaderId);
  _operatorUplinkTerminalOrder.push(loaderId);
  while (_operatorUplinkTerminalOrder.length > MAX_REMEMBERED_UPLINK_TERMINALS) {
    const staleId = _operatorUplinkTerminalOrder.shift();
    if (staleId) _operatorUplinkTerminalIds.delete(staleId);
  }
  return true;
}

function closeOperatorUplinkLoader(loaderId: string): void {
  showLoader(false, undefined, loaderId);
  _operatorUplinkLoaderIds.delete(loaderId);
}

function operatorUplinkPercent(loaded: number, total: number): number {
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(99, Math.max(0, Math.round((loaded / total) * 100)));
}

function operatorUplinkLoaderText(progress: StandardOperatorFileUplinkProgress): string {
  const count = progress.fileCount;
  const index = progress.fileIndex;
  if (
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(index) ||
    count === undefined ||
    index === undefined ||
    count <= 0 ||
    index < 0 ||
    index >= count
  ) {
    return t('transfer.file_sending');
  }
  const fileName = truncateValue(progress.fileName, OPERATOR_UPLINK_FILE_NAME_CHARS);
  return `${t('transfer.file_sending')} ${index + 1}/${count} · ${fileName}`;
}

function operatorUplinkErrorMessage(code: string | undefined): string {
  if (code === 'operator-revoked') return t('toast.media_management_required');
  if (code === 'file-too-large') return t('share.remote.too_large');
  if (code === 'invalid-file') return t('toast.no_supported_audio_files');
  if (code === 'host-busy') return t('transfer.host_busy');
  if (code === 'queue-full') return t('playlist.queue_full');
  return t('error.network_generic');
}

function standardQueueMutationErrorMessage(reason: string, code: string | null): string {
  if (reason === 'accept-timeout') return t('playlist.host_update_required');
  if (code === 'queue-full') return t('playlist.queue_full');
  if (code === 'invalid-source') return t('youtube.invalid_link');
  if (code === 'resolution-failed') return t('youtube.fetch_failed');
  if (code === 'unauthorized') return t('toast.media_management_required');
  if (reason === 'settle-timeout' || code === 'conflict' || code === 'invalid-target') {
    return t('playlist.mutation_retry');
  }
  return t('error.network_generic');
}

function handleOperatorFileUplinkProgress(progress: StandardOperatorFileUplinkProgress): void {
  // The host already has queue-level feedback when it accepts the completed
  // File. Showing every receive tick would make one upload appear twice.
  if (progress.direction !== 'send') return;

  const loaderId = operatorUplinkLoaderId(progress);
  if (progress.phase === 'waiting') {
    if (_operatorUplinkTerminalIds.has(loaderId)) return;
    _operatorUplinkLoaderIds.add(loaderId);
    showLoader(true, operatorUplinkLoaderText(progress), loaderId);
    updateLoader(0, loaderId);
    return;
  }

  if (progress.phase === 'uploading' || progress.phase === 'assembling') {
    if (_operatorUplinkTerminalIds.has(loaderId)) return;
    _operatorUplinkLoaderIds.add(loaderId);
    showLoader(true, operatorUplinkLoaderText(progress), loaderId);
    updateLoader(operatorUplinkPercent(progress.loaded, progress.total), loaderId);
    return;
  }

  if (!rememberOperatorUplinkTerminal(loaderId)) return;

  if (progress.phase === 'complete') {
    // Publish completion before releasing ownership. The progress EMA keeps
    // following 100 through the existing reverse transition, then resets.
    updateLoader(100, loaderId);
    closeOperatorUplinkLoader(loaderId);
    return;
  }

  closeOperatorUplinkLoader(loaderId);
  // Explicit cancellation is user intent, not an error. Authority loss and
  // transport failures remain actionable and get one terminal toast.
  if (
    progress.code === 'cancelled' ||
    (progress.code === 'operator-revoked' && !hasRoomCapability('asset.upload'))
  ) {
    return;
  }
  showToast(operatorUplinkErrorMessage(progress.code));
}

export function initToast(): void {
  removeHeaderLoadingIndicators();
  if (!_headerProgressVisibilityBound) {
    document.addEventListener('visibilitychange', handleHeaderProgressVisibility);
    _headerProgressVisibilityBound = true;
  }
  _toastBusScope.dispose();
  for (const loaderId of _operatorUplinkLoaderIds) showLoader(false, undefined, loaderId);
  _operatorUplinkLoaderIds.clear();
  _toastBusScope.on(
    'standard-room:operator-file-uplink-progress',
    handleOperatorFileUplinkProgress,
  );
  _toastBusScope.on('standard-room:queue-mutation-failed', (reason, code) => {
    showToast(standardQueueMutationErrorMessage(reason, code));
  });
  log.info('[Toast] Initialized');
}
