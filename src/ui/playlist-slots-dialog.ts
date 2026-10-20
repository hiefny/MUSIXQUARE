/**
 * MUSIXQUARE — Playlist switcher and track move dialogs
 *
 * Both reuse the language picker's dialog, list and row components. The
 * switcher marks the active playlist with the picker's check and grey row;
 * confirming another playlist switches the whole room to it. The move dialog
 * lists the other playlists with the playlist's minus/check multi-select and
 * copies or moves the selected tracks there. Loaded on first use.
 */

import { setPressedState } from '../core/aria-state.ts';
import { PLAYLIST_SLOT_COUNT } from '../core/constants.ts';
import { getState } from '../core/state.ts';
import { getResolvedLanguage, t } from '../i18n/index.ts';
import { switchPlaylist, transferTracks } from '../player/playlist.ts';
import type { PlaylistSlotSummary, PlaylistTransferMode, QueueItemId } from '../types/index.ts';
import { getUiElement, onWindowBack, syncOverlayState } from './dom.ts';
import { renderPlaylistSlotName } from './playlist-slot-names.ts';

const SLOTS_OVERLAY_ID = 'playlist-slots-overlay';
const TRANSFER_OVERLAY_ID = 'playlist-transfer-overlay';
const CHECK_PATH = 'M5 12.5l4.2 4.2L19 6.9';
const MINUS_PATH = 'M7 12h10';

let _pendingSlot = 0;
let _transferIds: readonly QueueItemId[] = [];
let _transferTargets = new Set<number>();
let _onTransferred: (() => void) | null = null;
let _previousFocus: HTMLElement | null = null;
let _bound = false;

/** "12.3 MiB" in the reader's number format. */
function formatPlaylistBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const number = new Intl.NumberFormat(getResolvedLanguage(), {
    maximumFractionDigits: unit === 0 || value >= 100 ? 0 : 1,
  }).format(value);
  return `${number} ${units[unit]}`;
}

function slotDetail(summary: PlaylistSlotSummary | undefined): string {
  const count = summary?.count ?? 0;
  const tracks = t('playlist.slot_tracks', { count });
  return summary?.bytes != null ? `${tracks} · ${formatPlaylistBytes(summary.bytes)}` : tracks;
}

function createSlotRow(slot: number, trailing: 'check' | 'select'): HTMLButtonElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'language-option playlist-slot-option';
  row.dataset.slot = String(slot);
  row.setAttribute('aria-pressed', 'false');

  const label = document.createElement('span');
  label.className = 'language-option-label';
  const name = document.createElement('span');
  name.className = 'language-option-native playlist-slot-name';
  renderPlaylistSlotName(name, slot);
  const detail = document.createElement('span');
  detail.className = 'language-option-english';
  detail.textContent = slotDetail(getState('playlist.slots')?.slots[slot]);
  label.append(name, detail);

  const mark = document.createElement('span');
  mark.className =
    trailing === 'check'
      ? 'language-option-check'
      : 'language-option-check playlist-slot-select-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML =
    trailing === 'check'
      ? `<svg viewBox="0 0 24 24"><path d="${CHECK_PATH}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg viewBox="0 0 24 24"><path class="playlist-select-minus" d="${MINUS_PATH}"/><path class="playlist-select-mark" d="${CHECK_PATH}"/></svg>`;
  row.append(label, mark);
  return row;
}

function openOverlay(id: string, focusTarget: HTMLElement | null): void {
  const overlay = getUiElement(id);
  if (!overlay) return;
  _previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  syncOverlayState(id as Parameters<typeof syncOverlayState>[0]);
  window.setTimeout(() => focusTarget?.focus(), 0);
}

function closeOverlay(id: string): void {
  const overlay = getUiElement(id);
  if (!overlay?.classList.contains('show')) return;
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  syncOverlayState();
  const previous = _previousFocus;
  _previousFocus = null;
  if (previous?.isConnected) previous.focus();
}

// ─── Switcher ─────────────────────────────────────────────────────

function renderSlots(): void {
  const list = getUiElement('playlist-slots-list');
  if (!list) return;
  const rows = Array.from({ length: PLAYLIST_SLOT_COUNT }, (_, slot) => {
    const row = createSlotRow(slot, 'check');
    setPressedState(row, slot === _pendingSlot);
    row.addEventListener('click', () => {
      _pendingSlot = slot;
      list.querySelectorAll<HTMLElement>('.playlist-slot-option').forEach((option) => {
        setPressedState(option, Number(option.dataset.slot) === _pendingSlot);
      });
    });
    return row;
  });
  list.replaceChildren(...rows);

  const usage = getUiElement('playlist-storage-usage');
  const storage = getState('playlist.storageUsage');
  if (usage) {
    usage.hidden = !storage;
    usage.textContent = storage
      ? `${formatPlaylistBytes(storage.usedBytes)} / ${formatPlaylistBytes(storage.limitBytes)}`
      : '';
  }
}

function confirmSlots(): void {
  const active = getState('playlist.slots')?.activeSlot ?? 0;
  closeOverlay(SLOTS_OVERLAY_ID);
  if (_pendingSlot !== active) switchPlaylist(_pendingSlot);
}

export function openPlaylistSlotsDialog(): void {
  bindDialogs();
  _pendingSlot = getState('playlist.slots')?.activeSlot ?? 0;
  renderSlots();
  openOverlay(
    SLOTS_OVERLAY_ID,
    getUiElement('playlist-slots-list')?.querySelector<HTMLElement>(
      '.playlist-slot-option.active',
    ) ?? null,
  );
}

// ─── Move tracks ──────────────────────────────────────────────────

function syncTransferActions(): void {
  const empty = _transferTargets.size === 0;
  for (const id of ['btn-playlist-transfer-copy', 'btn-playlist-transfer-move']) {
    const button = getUiElement<HTMLButtonElement>(id);
    if (button) button.disabled = empty;
  }
}

function renderTransfer(): void {
  const title = getUiElement('playlist-transfer-title');
  if (title) title.textContent = t('playlist.move_title', { count: _transferIds.length });
  const list = getUiElement('playlist-transfer-list');
  if (!list) return;
  const active = getState('playlist.slots')?.activeSlot ?? 0;
  const rows: HTMLButtonElement[] = [];
  for (let slot = 0; slot < PLAYLIST_SLOT_COUNT; slot += 1) {
    if (slot === active) continue;
    const row = createSlotRow(slot, 'select');
    setPressedState(row, _transferTargets.has(slot));
    row.addEventListener('click', () => {
      if (_transferTargets.has(slot)) _transferTargets.delete(slot);
      else _transferTargets.add(slot);
      setPressedState(row, _transferTargets.has(slot));
      syncTransferActions();
    });
    rows.push(row);
  }
  list.replaceChildren(...rows);
  syncTransferActions();
}

function runTransfer(mode: PlaylistTransferMode): void {
  if (_transferTargets.size === 0) return;
  const done = transferTracks(_transferIds, [..._transferTargets], mode);
  closeOverlay(TRANSFER_OVERLAY_ID);
  if (done) _onTransferred?.();
}

/** Open "Move N tracks" for active-playlist tracks; `onTransferred` ends edit mode. */
export function openPlaylistTransferDialog(
  queueItemIds: readonly QueueItemId[],
  onTransferred: () => void,
): void {
  bindDialogs();
  _transferIds = [...queueItemIds];
  _transferTargets = new Set();
  _onTransferred = onTransferred;
  renderTransfer();
  openOverlay(
    TRANSFER_OVERLAY_ID,
    getUiElement('playlist-transfer-list')?.querySelector<HTMLElement>('.playlist-slot-option') ??
      null,
  );
}

function bindDialogs(): void {
  if (_bound) return;
  _bound = true;
  getUiElement('btn-playlist-slots-done')?.addEventListener('click', confirmSlots);
  getUiElement('btn-playlist-transfer-copy')?.addEventListener('click', () => runTransfer('copy'));
  getUiElement('btn-playlist-transfer-move')?.addEventListener('click', () => runTransfer('move'));
  getUiElement('btn-playlist-transfer-close')?.addEventListener('click', () =>
    closeOverlay(TRANSFER_OVERLAY_ID),
  );
  for (const id of [SLOTS_OVERLAY_ID, TRANSFER_OVERLAY_ID]) {
    const overlay = getUiElement(id);
    if (!overlay) continue;
    overlay.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeOverlay(id);
    });
    onWindowBack(overlay, () => {
      if (!overlay.classList.contains('show')) return false;
      closeOverlay(id);
      return true;
    });
  }
}
