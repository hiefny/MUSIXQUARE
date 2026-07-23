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

const _toastBusScope = createBusScope();
const _operatorUplinkLoaderIds = new Set<string>();
const _operatorUplinkTerminalIds = new Set<string>();
const _operatorUplinkTerminalOrder: string[] = [];

function displayedProgress(progressBg: HTMLElement | null): number {
  if (!progressBg) return 0;
  const parsed = Number.parseFloat(progressBg.style.width);
  return Number.isFinite(parsed) ? parsed : 0;
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
  if (progressBg) progressBg.style.width = `${holder.percent}%`;
}

export function updateLoader(percent: number, id?: string): void {
  // Explicit IDs are strict ownership tokens. Once removed, a late callback
  // with that ID must not repaint a newer operation's loader.
  if (id !== undefined) {
    const holder = _loaderHolders.get(id);
    if (!holder) return;
    holder.percent = percent;
    if (foregroundLoader()?.[0] === id) renderLoader(holder);
    return;
  }

  // No-ID callers own the default holder. If a named operation is temporarily
  // in front, retain the default operation's tick without repainting that
  // foreground. Named flows must use their ID for the same reason.
  const target = _loaderHolders.get(DEFAULT_LOADER_ID);
  if (target) {
    target.percent = percent;
    if (foregroundLoader()?.[0] === DEFAULT_LOADER_ID) renderLoader(target);
    return;
  }

  // Some older flows publish a progress tick before acquiring a holder. Keep
  // that harmless direct-DOM behavior only when no operation currently owns
  // the surface; otherwise it could corrupt an unrelated named transfer.
  if (_loaderHolders.size > 0) return;
  const progressBg = document.getElementById('header-progress-bg') as HTMLElement | null;
  if (progressBg) progressBg.style.width = `${percent}%`;
}

export function showLoader(show: boolean, txt?: string, id?: string): void {
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
        if (progressBg) progressBg.style.width = '0%';
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
  if (code === 'operator-revoked') return t('network.op_revoked');
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
  if (code === 'unauthorized') return t('network.op_revoked');
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
    // Paint completion before releasing ownership. showLoader(false) keeps the
    // final width through the existing reverse transition, then resets it.
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
