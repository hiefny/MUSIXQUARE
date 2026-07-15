/**
 * Global local-file drop entry point.
 *
 * Dropped files deliberately re-enter the same playlist pipeline as the
 * native file picker. This module owns only gesture safety and confirmation;
 * validation, queue insertion, warnings, broadcast and autoplay remain in
 * player/playlist.ts.
 */

import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { t } from '../i18n/index.ts';
import { partitionAudioFileCandidates } from '../media/audio-file.ts';
import { hasRoomCapability } from '../rooms/authority.ts';
import { showDialog } from './dialog.ts';
import { isAnyOverlayShown } from './dom.ts';

type DirectoryAwareItem = DataTransferItem & {
  webkitGetAsEntry?: () => { isDirectory?: boolean; name?: string } | null;
};

let _initialized = false;
let _dropConfirmationInFlight = false;
let _fileDragShieldTimer: number | null = null;
let _fileDropFeedback: HTMLDivElement | null = null;

function ensureFileDropFeedback(): HTMLDivElement | null {
  if (_fileDropFeedback?.isConnected) return _fileDropFeedback;
  if (!document.body) return null;

  const existing = document.getElementById('file-drop-feedback');
  if (existing instanceof HTMLDivElement) {
    _fileDropFeedback = existing;
    return existing;
  }

  const feedback = document.createElement('div');
  feedback.id = 'file-drop-feedback';
  feedback.className = 'file-drop-feedback';
  feedback.setAttribute('aria-hidden', 'true');

  const icon = document.createElement('span');
  icon.className = 'file-drop-feedback-icon';
  icon.setAttribute('aria-hidden', 'true');
  feedback.appendChild(icon);
  document.body.appendChild(feedback);
  _fileDropFeedback = feedback;
  return feedback;
}

function setFileDropFeedbackVisible(visible: boolean): void {
  const feedback = visible ? ensureFileDropFeedback() : _fileDropFeedback;
  if (!feedback) return;
  feedback.classList.toggle('is-visible', visible);
}

function transferItems(dataTransfer: DataTransfer): DataTransferItem[] {
  try {
    return dataTransfer.items ? Array.from(dataTransfer.items) : [];
  } catch {
    return [];
  }
}

function hasFilePayload(dataTransfer: DataTransfer | null): dataTransfer is DataTransfer {
  if (!dataTransfer) return false;
  if (dataTransfer.files.length > 0) return true;
  if (Array.from(dataTransfer.types).includes('Files')) return true;
  return transferItems(dataTransfer).some((item) => item.kind === 'file');
}

function fileSignature(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.type}\u0000${file.lastModified}`;
}

function snapshotDroppedFiles(dataTransfer: DataTransfer): File[] {
  const fallbackFiles = Array.from(dataTransfer.files);
  const fileItems = transferItems(dataTransfer).filter((item) => item.kind === 'file');
  if (fileItems.length === 0) return fallbackFiles;

  const itemFiles: File[] = [];
  const directorySignatures = new Set<string>();
  const directoryNames = new Set<string>();
  for (const item of fileItems) {
    const entry = (item as DirectoryAwareItem).webkitGetAsEntry?.();
    const file = item.getAsFile();
    if (entry?.isDirectory) {
      if (file) directorySignatures.add(fileSignature(file));
      if (entry.name) directoryNames.add(entry.name);
      continue;
    }
    if (file) itemFiles.push(file);
  }

  // `items` is more descriptive (it identifies folders), but getAsFile() can
  // return null for cloud-backed placeholders in some browsers. Merge the
  // drop-time FileList fallback without duplicating the entries both surfaces
  // expose. Descriptor counts preserve two intentionally duplicated files.
  const files = fallbackFiles.filter((file) => {
    const signature = fileSignature(file);
    return !(
      directorySignatures.has(signature) ||
      (file.type === '' && directoryNames.has(file.name))
    );
  });

  const coveredSignatures = new Map<string, number>();
  for (const file of files) {
    const signature = fileSignature(file);
    coveredSignatures.set(signature, (coveredSignatures.get(signature) ?? 0) + 1);
  }

  for (const file of itemFiles) {
    const signature = fileSignature(file);
    const covered = coveredSignatures.get(signature) ?? 0;
    if (covered > 0) {
      coveredSignatures.set(signature, covered - 1);
      continue;
    }
    files.push(file);
  }
  return files;
}

function canAcceptDroppedFiles(): boolean {
  return (
    getState('setup.sessionStarted') === true &&
    hasRoomCapability('asset.upload') &&
    !getState('demo.active') &&
    !getState('demo.loading') &&
    !isAnyOverlayShown()
  );
}

function setDropEffect(dataTransfer: DataTransfer, effect: 'copy' | 'none'): void {
  try {
    dataTransfer.dropEffect = effect;
  } catch {
    // Some browsers expose a read-only DataTransfer during dragenter.
  }
}

function deactivateFileDragShield(): void {
  if (_fileDragShieldTimer !== null) {
    window.clearTimeout(_fileDragShieldTimer);
    _fileDragShieldTimer = null;
  }
  document.documentElement.classList.remove('file-drop-drag-active');
  setFileDropFeedbackVisible(false);
}

function activateFileDragShield(): void {
  document.documentElement.classList.add('file-drop-drag-active');
  if (_fileDragShieldTimer !== null) window.clearTimeout(_fileDragShieldTimer);
  // Dragover fires continuously. This watchdog also clears the shield when an
  // external drag is cancelled with Escape and no terminal drag event arrives.
  _fileDragShieldTimer = window.setTimeout(deactivateFileDragShield, 1500);
}

function handleFileDrag(event: DragEvent): void {
  if (!hasFilePayload(event.dataTransfer)) return;

  // Always suppress browser navigation for file drags, even on screens where
  // adding is unavailable. Otherwise an accidental drop can destroy a live
  // session by opening the local file in the current tab.
  event.preventDefault();
  activateFileDragShield();
  const canAccept = !_dropConfirmationInFlight && canAcceptDroppedFiles();
  setFileDropFeedbackVisible(canAccept);
  setDropEffect(event.dataTransfer, canAccept ? 'copy' : 'none');
}

function handleFileDragLeave(event: DragEvent): void {
  // Capture listeners also see child-to-child transitions. Only a null
  // relatedTarget means the drag actually left the document surface.
  if (event.relatedTarget === null) deactivateFileDragShield();
}

async function confirmDroppedFiles(files: readonly File[], rejectedCount: number): Promise<void> {
  try {
    const message = [
      t('dialog.file_drop.message', { count: files.length }),
      rejectedCount > 0 ? t('dialog.file_drop.unsupported_notice', { count: rejectedCount }) : '',
    ]
      .filter(Boolean)
      .join('\n');
    const result = await showDialog({
      title: t('dialog.file_drop.title'),
      message,
      buttonText: t('common.ok'),
      secondaryText: t('common.cancel'),
      defaultFocus: 'secondary',
    });

    // The host can leave, become a guest, enter demo mode, or open another
    // overlay while the confirmation is visible. Re-check before mutating.
    if (result.action === 'ok' && canAcceptDroppedFiles()) {
      bus.emit('app:files-selected', files);
    }
  } finally {
    _dropConfirmationInFlight = false;
  }
}

function handleFileDrop(event: DragEvent): void {
  if (!hasFilePayload(event.dataTransfer)) return;

  event.preventDefault();
  deactivateFileDragShield();
  setDropEffect(event.dataTransfer, 'none');

  if (_dropConfirmationInFlight || !canAcceptDroppedFiles()) return;

  // DataTransfer may be cleared as soon as this event returns. Snapshot every
  // File before awaiting the confirmation dialog.
  const files = snapshotDroppedFiles(event.dataTransfer);
  if (files.length === 0) return;

  const { accepted, rejected } = partitionAudioFileCandidates(files);

  // Keep the playlist handler as the final authority for picker overrides and
  // future emitters. Routing the all-rejected case through it also centralizes
  // the user-facing rejection toast without opening a meaningless dialog.
  if (accepted.length === 0) {
    bus.emit('app:files-selected', files);
    return;
  }

  _dropConfirmationInFlight = true;
  void confirmDroppedFiles(accepted, rejected.length);
}

export function initGlobalFileDrop(): void {
  if (_initialized) return;
  _initialized = true;
  ensureFileDropFeedback();
  document.addEventListener('dragenter', handleFileDrag, true);
  document.addEventListener('dragover', handleFileDrag, true);
  document.addEventListener('dragleave', handleFileDragLeave, true);
  document.addEventListener('drop', handleFileDrop, true);
  document.addEventListener('dragend', deactivateFileDragShield, true);
}

/** @internal Test-only teardown for the document-level listeners. */
export function __resetGlobalFileDropForTests(): void {
  if (_initialized) {
    document.removeEventListener('dragenter', handleFileDrag, true);
    document.removeEventListener('dragover', handleFileDrag, true);
    document.removeEventListener('dragleave', handleFileDragLeave, true);
    document.removeEventListener('drop', handleFileDrop, true);
    document.removeEventListener('dragend', deactivateFileDragShield, true);
  }
  deactivateFileDragShield();
  _fileDropFeedback?.remove();
  _fileDropFeedback = null;
  _initialized = false;
  _dropConfirmationInFlight = false;
}
