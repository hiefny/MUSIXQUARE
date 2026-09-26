/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { log } from '../../core/log.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { t } from '../../i18n/index.ts';
import { registerProPlaybackMediaEndpoint } from '../../pro-room/playback-authority-hooks.ts';
import { showToast } from '../../ui/toast.ts';
import { initPlaylist } from '../playlist.ts';
import { MAX_QUEUE_ITEMS } from '../queue-model.ts';

vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn() }));

function populate(count: number) {
  const items = Array.from({ length: count }, (_, index) => ({
    queueItemId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    type: 'file' as const,
    name: `${index}.mp3`,
    file: new File([new Uint8Array([index % 256])], `${index}.mp3`, { type: 'audio/mpeg' }),
    videoId: null,
    playlistId: null,
  }));
  setState('playlist.items', items);
  setState('playlist.currentQueueItemId', items[0]!.queueItemId);
  setState('playlist.revision', 10);
  return items;
}

function file(name = 'new.mp3') {
  return new File([new Uint8Array([1])], name, { type: 'audio/mpeg' });
}

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  vi.spyOn(log, 'error').mockImplementation(() => undefined);
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  initPlaylist();
});

afterEach(() => {
  clearAllManagedTimers();
  registerProPlaybackMediaEndpoint(null);
  bus.clear();
  vi.restoreAllMocks();
});

describe('standard host file selection at the queue capacity boundary', () => {
  it.each([
    { size: MAX_QUEUE_ITEMS, added: 1 },
    { size: MAX_QUEUE_ITEMS - 1, added: 2 },
  ])(
    'reports queue full without throwing or partially appending $added files to $size rows',
    async ({ size, added }) => {
      const original = populate(size);
      const additions = vi.fn();
      bus.on('playlist:items-added', additions);

      bus.emit(
        'app:files-selected',
        Array.from({ length: added }, (_, i) => file(`${i}-new.mp3`)),
      );
      // Observe the EventBus rejection handler as well as the synchronous queue
      // mutation. The picker/drop consumer is an async handler even without I/O.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(showToast).toHaveBeenCalledExactlyOnceWith(t('playlist.queue_full'));
      expect(log.error).not.toHaveBeenCalled();
      expect(getState('playlist.items')).toBe(original);
      expect(getState('playlist.revision')).toBe(10);
      expect(getState('playlist.currentQueueItemId')).toBe(original[0]!.queueItemId);
      expect(additions).not.toHaveBeenCalled();
    },
  );

  it('counts accepted audio files only and permits a batch that exactly fills the queue', () => {
    const original = populate(MAX_QUEUE_ITEMS - 2);
    const first = file('first-new.mp3');
    const second = file('second-new.mp3');
    bus.emit('app:files-selected', [
      first,
      new File(['image'], 'cover.png', { type: 'image/png' }),
      second,
    ]);

    expect(getState('playlist.items')).toHaveLength(MAX_QUEUE_ITEMS);
    expect(
      getState('playlist.items')
        .slice(-2)
        .map((item) => item.file),
    ).toEqual([first, second]);
    expect(getState('playlist.currentQueueItemId')).toBe(original[0]!.queueItemId);
    expect(getState('playlist.revision')).toBe(11);
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      `${t('toast.added_tracks', { count: 2 })}\n${t('toast.unsupported_files_excluded', { count: 1 })}`,
    );
  });

  it('accepts a file after removing a row from a full queue', () => {
    const original = populate(MAX_QUEUE_ITEMS);
    bus.emit('playlist:remove-tracks', [original.at(-1)!.queueItemId]);
    const added = file();
    bus.emit('app:files-selected', [added]);

    expect(getState('playlist.items')).toHaveLength(MAX_QUEUE_ITEMS);
    expect(getState('playlist.items').at(-1)?.file).toBe(added);
    expect(getState('playlist.revision')).toBe(12);
    expect(getState('playlist.currentQueueItemId')).toBe(original[0]!.queueItemId);
    expect(showToast).toHaveBeenCalledExactlyOnceWith(t('toast.added_tracks', { count: 1 }));
  });
});
