/**
 * Deferred DOM runtime for the manual-sync overlay.
 *
 * The main player controls keep only availability checks and a tiny import
 * facade eager. Input normalization, focus trapping, and editor bindings are
 * needed only after the participant opens this panel.
 */

import { MANUAL_SYNC_OFFSET_LIMIT_MS } from '../core/constants.ts';
import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { getCurrentAudioBuffer } from '../player/_state.ts';
import {
  isPlaybackModeFile,
  isPlaybackModeSystemAudio,
  isPlaybackModeYouTube,
} from '../player/ownership.ts';
import { getCurrentQueueItemId } from '../player/queue-model.ts';
import { isFilePipelineBusyForPlay } from '../player/transport.ts';
import { getRoomContext, isActiveStandardRoomCoordinator } from '../rooms/authority.ts';
import { broadcastYouTubeSync, guestRendezvousSync } from '../youtube/sync.ts';
import { isYouTubeZeroStartProtocolActive } from '../youtube/zero-start.ts';
import { normalizeEmptyContentEditable, syncOverlayState } from './dom.ts';
import { t } from '../i18n/index.ts';
import { showToast } from './toast.ts';

type MainSyncUnavailableReason = 'no-media' | 'not-ready' | 'system-audio';

interface ManualSyncControllerBridge {
  getUnavailableReason(): MainSyncUnavailableReason | null;
  getUnavailableMessage(reason: MainSyncUnavailableReason): string;
  beginRequest(): number;
  finishRequest(token: number): void;
}

let previousFocus: HTMLElement | null = null;
const boundOverlays = new WeakSet<HTMLElement>();
const boundEditors = new WeakSet<HTMLElement>();

function getManualSyncOffsetMs(): number {
  const seconds = isPlaybackModeYouTube()
    ? getState('sync.youtubeLocalOffset') || 0
    : getState('sync.localOffset') || 0;
  return Math.max(
    -MANUAL_SYNC_OFFSET_LIMIT_MS,
    Math.min(MANUAL_SYNC_OFFSET_LIMIT_MS, Math.round(seconds * 1000)),
  );
}

function formatManualSyncOffsetMs(ms: number): string {
  return ms > 0 ? `+${ms}` : `${ms}`;
}

function renderEditorValue(editor: HTMLElement, ms = getManualSyncOffsetMs()): void {
  editor.textContent = formatManualSyncOffsetMs(ms);
  editor.setAttribute('aria-invalid', 'false');
}

function sanitizeDraft(raw: string): string {
  let normalized = raw;
  try {
    normalized = raw.normalize('NFKC');
  } catch {
    // Old embedded engines may not implement every normalization form.
  }
  normalized = normalized.replace(/\u2212/g, '-').replace(/\s+/g, '');
  const sign = normalized.startsWith('-') ? '-' : normalized.startsWith('+') ? '+' : '';
  const unsigned = sign ? normalized.slice(1) : normalized;
  // Preserve one overflow digit so commit clamps instead of silently turning
  // an out-of-range value into a different in-range value.
  return `${sign}${unsigned.replace(/\D/g, '').slice(0, String(MANUAL_SYNC_OFFSET_LIMIT_MS).length + 1)}`;
}

function placeCaretAtEnd(editor: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function selectEditorText(editor: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection || !editor.textContent) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
}

function normalizeDraft(editor: HTMLElement): void {
  const draft = sanitizeDraft(editor.textContent || '');
  if ((editor.textContent || '') !== draft) {
    editor.textContent = draft;
    placeCaretAtEnd(editor);
  }
  editor.setAttribute('aria-invalid', 'false');
}

function commitEditor(editor: HTMLElement): boolean {
  const draft = sanitizeDraft(editor.textContent || '');
  if (!/^[+-]?\d+$/u.test(draft)) {
    editor.setAttribute('aria-invalid', 'true');
    return false;
  }
  const parsed = Number(draft);
  if (!Number.isFinite(parsed)) {
    editor.setAttribute('aria-invalid', 'true');
    return false;
  }
  const bounded = Math.max(
    -MANUAL_SYNC_OFFSET_LIMIT_MS,
    Math.min(MANUAL_SYNC_OFFSET_LIMIT_MS, Math.round(parsed)),
  );
  const changed = bounded !== getManualSyncOffsetMs();
  renderEditorValue(editor, bounded);
  if (changed) bus.emit('sync:set-manual-offset', bounded);
  return true;
}

function close(): void {
  const overlay = document.getElementById('manual-sync-overlay');
  if (!overlay) return;
  const wasShown = overlay.classList.contains('show');
  clearManagedTimer('manual-sync-focus');
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  syncOverlayState();

  const returnFocus = previousFocus;
  previousFocus = null;
  if (!wasShown) return;
  const fallback = document.getElementById('btn-sync');
  (returnFocus?.isConnected ? returnFocus : fallback)?.focus();
}

function handleOverlayKeydown(event: KeyboardEvent): void {
  const overlay = document.getElementById('manual-sync-overlay');
  if (!overlay?.classList.contains('show')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusables = Array.from(
    overlay.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
  if (focusables.length === 0) return;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey) {
    if (active === first || !overlay.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last || !overlay.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

function bindEditor(editor: HTMLElement): void {
  if (boundEditors.has(editor)) return;
  boundEditors.add(editor);
  let isComposing = false;
  let skipNextBlurCommit = false;
  const completeEdit = () => {
    if (commitEditor(editor)) {
      skipNextBlurCommit = true;
      editor.blur();
    } else {
      selectEditorText(editor);
    }
  };

  editor.addEventListener('focus', () => {
    editor.dataset.editing = 'true';
    editor.setAttribute('aria-invalid', 'false');
    clearManagedTimer('manual-sync-select-all');
    setManagedTimer(
      'manual-sync-select-all',
      () => {
        if (document.activeElement === editor) selectEditorText(editor);
      },
      0,
    );
  });
  editor.addEventListener('compositionstart', () => {
    isComposing = true;
  });
  editor.addEventListener('compositionend', () => {
    isComposing = false;
    normalizeDraft(editor);
  });
  editor.addEventListener('beforeinput', (event) => {
    if (event.inputType !== 'insertParagraph' && event.inputType !== 'insertLineBreak') return;
    event.preventDefault();
    if (!event.isComposing && !isComposing) completeEdit();
  });
  editor.addEventListener('input', (event) => {
    normalizeEmptyContentEditable(editor, event);
    if (!isComposing) normalizeDraft(editor);
  });
  editor.addEventListener('paste', (event) => {
    event.preventDefault();
    const draft = sanitizeDraft(event.clipboardData?.getData('text/plain') || '');
    if (typeof document.execCommand === 'function') {
      document.execCommand('insertText', false, draft);
    } else {
      editor.textContent = draft;
      placeCaretAtEnd(editor);
    }
  });
  editor.addEventListener('drop', (event) => event.preventDefault());
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (event.isComposing || event.keyCode === 229 || isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      completeEdit();
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    skipNextBlurCommit = true;
    renderEditorValue(editor);
    editor.blur();
    close();
  });
  editor.addEventListener('blur', () => {
    clearManagedTimer('manual-sync-select-all');
    editor.removeAttribute('data-editing');
    if (skipNextBlurCommit) {
      skipNextBlurCommit = false;
      return;
    }
    if (!commitEditor(editor)) renderEditorValue(editor);
  });
}

function bindOverlay(): void {
  const overlay = document.getElementById('manual-sync-overlay');
  if (overlay && !boundOverlays.has(overlay)) {
    boundOverlays.add(overlay);
    overlay.addEventListener('keydown', handleOverlayKeydown);
  }
  const editor = document.getElementById('manual-sync-value');
  if (editor?.getAttribute('contenteditable') === 'true') bindEditor(editor);
}

export function canUseManualSyncPanelRuntime(): boolean {
  const hostConn = getState('network.hostConn');
  const room = getRoomContext();
  const isProRoom = room.kind === 'pro';
  if (!hostConn?.open && !isProRoom && !isActiveStandardRoomCoordinator()) return false;
  if (isPlaybackModeSystemAudio()) return false;
  if (isPlaybackModeYouTube()) return !isYouTubeZeroStartProtocolActive();
  return isPlaybackModeFile() && !!getCurrentAudioBuffer();
}

function open(): boolean {
  if (!canUseManualSyncPanelRuntime()) return false;
  const overlay = document.getElementById('manual-sync-overlay');
  if (!overlay) return false;
  bindOverlay();
  refreshManualSyncOverlayRuntime();
  if (!overlay.classList.contains('show')) {
    previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : document.getElementById('btn-sync');
  }
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  syncOverlayState('manual-sync-overlay');
  setManagedTimer(
    'manual-sync-focus',
    () => {
      if (overlay.classList.contains('show')) document.getElementById('btn-sync-done')?.focus();
    },
    0,
  );
  return true;
}

/** Execute the full Sync-button branch only after its interaction chunk loads. */
export function handleMainSyncButtonRuntime(bridge: ManualSyncControllerBridge): void {
  const unavailableReason = bridge.getUnavailableReason();
  if (unavailableReason) {
    close();
    showToast(bridge.getUnavailableMessage(unavailableReason));
    return;
  }
  if (isPlaybackModeSystemAudio()) {
    showToast(t('toast.sync_not_in_system_audio'));
    return;
  }
  if (isPlaybackModeYouTube() && isYouTubeZeroStartProtocolActive()) {
    close();
    showToast(t('toast.sync_not_ready'));
    return;
  }

  const hostConn = getState('network.hostConn');
  const room = getRoomContext();
  const isProRoom = room.kind === 'pro';
  if (!hostConn && !isPlaybackModeFile() && !isPlaybackModeYouTube()) {
    showToast(t('toast.sync_no_media'));
    return;
  }

  if (isProRoom) {
    const roomId = room.roomId;
    const requestToken = bridge.beginRequest();
    void import('../pro-room/runtime.ts')
      .then(({ requestActiveProRoomPlaybackReconciliation }) =>
        requestActiveProRoomPlaybackReconciliation(),
      )
      .then((reconciled) => {
        const currentRoom = getRoomContext();
        if (currentRoom.kind !== 'pro' || currentRoom.roomId !== roomId) return;
        if (!reconciled) {
          showToast(t('toast.sync_not_ready'));
          return;
        }
        open();
      })
      .catch((error) => {
        const currentRoom = getRoomContext();
        if (currentRoom.kind !== 'pro' || currentRoom.roomId !== roomId) return;
        log.warn('[PRO Playback] Manual synchronization failed', error);
        showToast(t('toast.sync_not_ready'));
      })
      .finally(() => bridge.finishRequest(requestToken));
    return;
  }

  if (isPlaybackModeYouTube()) {
    if (!hostConn) {
      broadcastYouTubeSync(true);
      open();
      return;
    }
    if (!hostConn.open) {
      showToast(t('toast.sync_not_ready'));
      return;
    }
    guestRendezvousSync({
      suppressProgressToast: true,
      onComplete: () => {
        if (open()) showToast(t('toast.yt_manual_sync_prompt'));
      },
    });
    return;
  }

  if (!hostConn) {
    if (isFilePipelineBusyForPlay() || !getCurrentQueueItemId() || !getCurrentAudioBuffer()) {
      showToast(t('toast.sync_not_ready'));
      return;
    }
    open();
    return;
  }
  if (!hostConn.open) {
    showToast(t('toast.sync_not_ready'));
    return;
  }
  if (!canUseManualSyncPanelRuntime()) {
    open();
    return;
  }
  bus.emit('sync:force-resync');
  open();
}

export function closeManualSyncOverlayRuntime(): void {
  close();
}

export function refreshManualSyncOverlayRuntime(): void {
  const editor = document.getElementById('manual-sync-value');
  if (editor && editor.dataset.editing !== 'true') renderEditorValue(editor);
}
