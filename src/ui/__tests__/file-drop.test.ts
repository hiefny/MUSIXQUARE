/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { showDialog } from '../dialog.ts';
import { __resetGlobalFileDropForTests, initGlobalFileDrop } from '../file-drop.ts';

vi.mock('../dialog.ts', () => ({
  showDialog: vi.fn(),
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string, params?: Record<string, unknown>) =>
    params?.count === undefined ? key : `${key}:${String(params.count)}`,
  ),
}));

const mockedShowDialog = vi.mocked(showDialog);

function makeTransfer(
  files: readonly File[],
  options: {
    types?: readonly string[];
    directoryIndexes?: readonly number[];
    nullItemIndexes?: readonly number[];
  } = {},
): DataTransfer {
  const directoryIndexes = new Set(options.directoryIndexes ?? []);
  const nullItemIndexes = new Set(options.nullItemIndexes ?? []);
  return {
    files,
    items: files.map((file, index) => ({
      kind: 'file',
      type: file.type,
      getAsFile: () => (nullItemIndexes.has(index) ? null : file),
      webkitGetAsEntry: () => ({
        isDirectory: directoryIndexes.has(index),
        name: file.name,
      }),
    })),
    types: options.types ?? ['Files'],
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

function dispatchDrag(type: 'dragenter' | 'dragover' | 'drop', dataTransfer: DataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  document.dispatchEvent(event);
  return event;
}

function enableActiveHost(): void {
  setState('setup.sessionStarted', true);
  setState('network.appRole', 'host');
  setState('network.hostConn', null);
  setState('demo.active', false);
  setState('demo.loading', false);
}

beforeEach(() => {
  __resetGlobalFileDropForTests();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  document.body.innerHTML = '';
  enableActiveHost();
  initGlobalFileDrop();
});

afterEach(() => {
  __resetGlobalFileDropForTests();
  bus.clear();
  document.body.innerHTML = '';
});

describe('global local-file drop', () => {
  it('accepts dragover only for an eligible host and shields cross-origin iframes', () => {
    const transfer = makeTransfer([new File(['a'], 'one.flac', { type: 'audio/flac' })]);
    const feedback = document.getElementById('file-drop-feedback');

    expect(feedback).not.toBeNull();
    expect(feedback?.getAttribute('aria-hidden')).toBe('true');
    const eligibleEvent = dispatchDrag('dragover', transfer);

    expect(eligibleEvent.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe('copy');
    expect(document.documentElement.classList.contains('file-drop-drag-active')).toBe(true);
    expect(feedback?.classList.contains('is-visible')).toBe(true);
    expect(feedback?.getAttribute('aria-hidden')).toBe('true');

    setState('network.appRole', 'guest');
    const blockedEvent = dispatchDrag('dragover', transfer);
    expect(blockedEvent.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe('none');
    expect(feedback?.classList.contains('is-visible')).toBe(false);
    expect(feedback?.getAttribute('aria-hidden')).toBe('true');

    dispatchDrag('drop', transfer);
    expect(document.documentElement.classList.contains('file-drop-drag-active')).toBe(false);
    expect(feedback?.classList.contains('is-visible')).toBe(false);
  });

  it('clears the visual feedback when an external drag is cancelled without a drop event', () => {
    vi.useFakeTimers();
    try {
      const transfer = makeTransfer([new File(['a'], 'one.flac', { type: 'audio/flac' })]);
      dispatchDrag('dragover', transfer);

      const feedback = document.getElementById('file-drop-feedback');
      expect(feedback?.classList.contains('is-visible')).toBe(true);

      vi.advanceTimersByTime(1500);

      expect(document.documentElement.classList.contains('file-drop-drag-active')).toBe(false);
      expect(feedback?.classList.contains('is-visible')).toBe(false);
      expect(feedback?.getAttribute('aria-hidden')).toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the visual feedback immediately when the drag leaves the document', () => {
    const transfer = makeTransfer([new File(['a'], 'one.flac', { type: 'audio/flac' })]);
    dispatchDrag('dragover', transfer);
    expect(document.getElementById('file-drop-feedback')?.classList.contains('is-visible')).toBe(
      true,
    );

    const leaveEvent = new Event('dragleave', { bubbles: true, cancelable: true });
    Object.defineProperty(leaveEvent, 'relatedTarget', { value: null });
    document.dispatchEvent(leaveEvent);

    expect(document.documentElement.classList.contains('file-drop-drag-active')).toBe(false);
    expect(document.getElementById('file-drop-feedback')?.classList.contains('is-visible')).toBe(
      false,
    );
  });

  it('confirms the accepted track count, then reuses the existing file-selection event', async () => {
    const files = [
      new File(['a'], 'one.flac', { type: 'audio/flac' }),
      new File(['b'], 'two.wav', { type: 'audio/wav' }),
    ];
    mockedShowDialog.mockResolvedValue({ action: 'ok' });
    const selected = vi.fn();
    bus.on('app:files-selected', selected);

    const transfer = makeTransfer(files);
    const event = dispatchDrag('drop', transfer);

    expect(event.defaultPrevented).toBe(true);
    expect(mockedShowDialog).toHaveBeenCalledWith({
      title: 'dialog.file_drop.title',
      message: 'dialog.file_drop.message:2',
      buttonText: 'common.ok',
      secondaryText: 'common.cancel',
      defaultFocus: 'secondary',
    });
    await vi.waitFor(() => expect(selected).toHaveBeenCalledTimes(1));
    expect(selected.mock.calls[0]?.[0]).toEqual(files);
    expect(selected.mock.calls[0]?.[0]).not.toBe(files);
  });

  it('counts only audio candidates in a mixed drop but preserves the full validation payload', async () => {
    const audio = new File(['a'], 'one.flac', { type: 'audio/flac' });
    const video = new File(['v'], 'clip.mp4', { type: 'video/mp4' });
    mockedShowDialog.mockResolvedValue({ action: 'ok' });
    const selected = vi.fn();
    bus.on('app:files-selected', selected);

    dispatchDrag('drop', makeTransfer([audio, video]));

    expect(mockedShowDialog).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'dialog.file_drop.message:1' }),
    );
    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith([audio, video]));
  });

  it('recovers FileList entries when DataTransferItem.getAsFile returns null', async () => {
    const files = [
      new File(['a'], 'cloud.flac', { type: 'audio/flac' }),
      new File(['b'], 'local.wav', { type: 'audio/wav' }),
    ];
    mockedShowDialog.mockResolvedValue({ action: 'ok' });
    const selected = vi.fn();
    bus.on('app:files-selected', selected);

    dispatchDrag('drop', makeTransfer(files, { nullItemIndexes: [0] }));

    expect(mockedShowDialog).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'dialog.file_drop.message:2' }),
    );
    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith(files));
  });

  it('does not add files when the user chooses No', async () => {
    mockedShowDialog.mockResolvedValue({ action: 'secondary' });
    const selected = vi.fn();
    bus.on('app:files-selected', selected);

    dispatchDrag('drop', makeTransfer([new File(['a'], 'one.mp3', { type: 'audio/mpeg' })]));

    await vi.waitFor(() => expect(mockedShowDialog).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(selected).not.toHaveBeenCalled();
  });

  it.each([
    ['initial setup', () => setState('setup.sessionStarted', false)],
    ['guest role', () => setState('network.appRole', 'guest')],
    ['demo mode', () => setState('demo.active', true)],
    [
      'registered overlay',
      () => {
        document.body.innerHTML = '<div id="setup-overlay" class="active"></div>';
      },
    ],
    [
      'dialog overlay',
      () => {
        document.body.innerHTML = '<div id="dialog-overlay" class="show"></div>';
      },
    ],
    [
      'language dialog overlay',
      () => {
        document.body.innerHTML = '<div id="language-dialog-overlay" class="show"></div>';
      },
    ],
    [
      'manual sync overlay',
      () => {
        document.body.innerHTML = '<div id="manual-sync-overlay" class="show"></div>';
      },
    ],
    [
      'dynamic YouTube overlay',
      () => {
        document.body.innerHTML = '<div id="youtube-ios-sync-overlay"></div>';
      },
    ],
    [
      'debug overlay',
      () => {
        document.body.innerHTML = '<div class="debug-memory-overlay"></div>';
      },
    ],
  ])('blocks addition on %s while still preventing browser navigation', (_label, arrange) => {
    arrange();
    const event = dispatchDrag(
      'drop',
      makeTransfer([new File(['a'], 'one.flac', { type: 'audio/flac' })]),
    );

    expect(event.defaultPrevented).toBe(true);
    expect(mockedShowDialog).not.toHaveBeenCalled();
  });

  it('rechecks host eligibility after the asynchronous confirmation', async () => {
    let resolveDialog: ((result: { action: string }) => void) | undefined;
    mockedShowDialog.mockReturnValue(
      new Promise((resolve) => {
        resolveDialog = resolve;
      }),
    );
    const selected = vi.fn();
    bus.on('app:files-selected', selected);

    dispatchDrag('drop', makeTransfer([new File(['a'], 'one.wav', { type: 'audio/wav' })]));
    setState('network.appRole', 'guest');
    resolveDialog?.({ action: 'ok' });

    await Promise.resolve();
    expect(selected).not.toHaveBeenCalled();
  });

  it('does not add when an overlay opens while confirmation is pending', async () => {
    let resolveDialog: ((result: { action: string }) => void) | undefined;
    mockedShowDialog.mockReturnValue(
      new Promise((resolve) => {
        resolveDialog = resolve;
      }),
    );
    const selected = vi.fn();
    bus.on('app:files-selected', selected);

    dispatchDrag('drop', makeTransfer([new File(['a'], 'one.wav', { type: 'audio/wav' })]));
    document.body.innerHTML = '<div id="language-dialog-overlay" class="show"></div>';
    resolveDialog?.({ action: 'ok' });

    await Promise.resolve();
    expect(selected).not.toHaveBeenCalled();
  });

  it('suppresses a second drop while a confirmation is already open', async () => {
    let resolveDialog: ((result: { action: string }) => void) | undefined;
    mockedShowDialog.mockReturnValue(
      new Promise((resolve) => {
        resolveDialog = resolve;
      }),
    );

    const transfer = makeTransfer([new File(['a'], 'one.wav', { type: 'audio/wav' })]);
    dispatchDrag('drop', transfer);
    dispatchDrag('drop', transfer);

    expect(mockedShowDialog).toHaveBeenCalledTimes(1);
    resolveDialog?.({ action: 'secondary' });
    await vi.waitFor(() => expect(mockedShowDialog).toHaveBeenCalledTimes(1));

    mockedShowDialog.mockResolvedValue({ action: 'secondary' });
    dispatchDrag('drop', transfer);
    await vi.waitFor(() => expect(mockedShowDialog).toHaveBeenCalledTimes(2));
  });

  it('routes video-only drops straight to the existing rejection path', () => {
    const selected = vi.fn();
    bus.on('app:files-selected', selected);
    const video = new File(['v'], 'clip.mp4', { type: 'video/mp4' });

    dispatchDrag('drop', makeTransfer([video]));

    expect(mockedShowDialog).not.toHaveBeenCalled();
    expect(selected).toHaveBeenCalledWith([video]);
  });

  it('ignores non-file drags and drops directory entries', () => {
    const textTransfer = makeTransfer([], { types: ['text/plain'] });
    const textEvent = dispatchDrag('drop', textTransfer);
    expect(textEvent.defaultPrevented).toBe(false);

    const folder = new File([], 'Album', { type: '' });
    const folderEvent = dispatchDrag('drop', makeTransfer([folder], { directoryIndexes: [0] }));
    expect(folderEvent.defaultPrevented).toBe(true);
    expect(mockedShowDialog).not.toHaveBeenCalled();
  });
});
