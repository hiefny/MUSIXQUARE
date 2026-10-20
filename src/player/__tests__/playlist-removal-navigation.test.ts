/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setLanguageMode } from '../../i18n/index.ts';
import type {
  DataConnection,
  PlaylistItem,
  QueueItemId,
  RoomCapability,
} from '../../types/index.ts';
import { initPlaylistView } from '../../ui/playlist-view.ts';
import { setPlaybackYouTubePlaying } from '../ownership.ts';
import { initPlaylist, playNextTrack, playPrevTrack } from '../playlist.ts';
import { setQueueRemovalCommit } from '../queue-removal-gate.ts';
import { registerProRoomMediaHooks, type ProRoomMediaHooks } from '../../pro-room/media-hooks.ts';
import {
  registerProPlaybackCommandHandler,
  resetProPlaybackAuthorityHooks,
  type ProPlaybackUserIntent,
} from '../../pro-room/playback-authority-hooks.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../ui/playlist-title-marquee.ts', () => ({
  initPlaylistTitleMarquee: vi.fn(),
  schedulePlaylistTitleMarqueeMeasure: vi.fn(),
}));

/** Matches the playlist removal controller's undo window. */
const PLAYLIST_REMOVAL_UNDO_MS = 3000;

const ONE = '20000000-0000-4000-8000-000000000001';
const TWO = '20000000-0000-4000-8000-000000000002';
const THREE = '20000000-0000-4000-8000-000000000003';
const FOUR = '20000000-0000-4000-8000-000000000004';

function video(queueItemId: QueueItemId, videoId: string): PlaylistItem {
  return { queueItemId, type: 'youtube', name: videoId, title: videoId, videoId, playlistId: null };
}

function queue(): PlaylistItem[] {
  return [
    video(ONE, 'VIDEO_ONE_01'),
    video(TWO, 'VIDEO_TWO_02'),
    video(THREE, 'VIDEO_THREE'),
    video(FOUR, 'VIDEO_FOUR4'),
  ];
}

function queueIds(): QueueItemId[] {
  return getState('playlist.items').map((item) => item.queueItemId);
}

function selectionBar(): HTMLElement {
  return document.querySelector<HTMLElement>('.playlist-selection-bar')!;
}

/** Delete rows through the real deletion mode; the Undo pill is then offered. */
function deleteRows(...queueItemIds: QueueItemId[]): HTMLButtonElement {
  for (const queueItemId of queueItemIds) {
    document
      .querySelector<HTMLButtonElement>(
        `.btn-playlist-remove[data-queue-item-id="${queueItemId}"]`,
      )!
      .click();
  }
  const pill = document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!;
  pill.click();
  expect(pill.dataset.selectionAction).toBe('undo');
  expect(selectionBar().hidden).toBe(false);
  return pill;
}

function expectUndoGone(pill: HTMLButtonElement, removals: Mock): void {
  expect(selectionBar().hidden).toBe(true);
  // The old pill no longer undoes anything, and nothing is sent twice.
  pill.click();
  vi.advanceTimersByTime(20_000);
  expect(removals).toHaveBeenCalledTimes(1);
}

let events: string[];
let loads: Mock<(videoId: string | null) => void>;
let removals: Mock<(queueItemIds: QueueItemId[]) => void>;

function startHost(current: QueueItemId = ONE): void {
  setState('network.appRole', 'host');
  setState('playlist.items', queue());
  setState('playlist.currentQueueItemId', current);
  setState('youtube.currentSubIndex', 0);
  setPlaybackYouTubePlaying();
  initPlaylist();
  initPlaylistView();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  resetState();
  bus.clear();
  clearAllManagedTimers();
  registerProRoomMediaHooks(null);
  registerProPlaybackCommandHandler(null);
  resetProPlaybackAuthorityHooks();
  setLanguageMode('en');
  document.body.innerHTML =
    '<nav class="bottom-nav"><button type="button" class="nav-item" data-tab="play">Play</button></nav>' +
    '<section id="tab-playlist" class="tab-content active" tabindex="-1">' +
    '<div class="tab-header"><span class="tab-title">Playlist</span>' +
    '<div class="playlist-title-area"></div></div>' +
    '<div class="tab-body"><ul id="playlist-ui"></ul></div></section>';
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  events = [];
  loads = vi.fn((videoId: string | null) => {
    events.push(`load:${videoId}`);
  });
  removals = vi.fn((queueItemIds: QueueItemId[]) => {
    events.push(`remove:${queueItemIds.join()}`);
  });
  bus.on('playlist:remove-tracks', removals);
  bus.on('youtube:load', loads);
  bus.on('youtube:try-next-internal', (done: (success: boolean) => void) => done(false));
  bus.on('youtube:try-prev-internal', (done: (success: boolean) => void) => done(false));
});

afterEach(() => {
  setQueueRemovalCommit(() => []);
  registerProRoomMediaHooks(null);
  registerProPlaybackCommandHandler(null);
  resetProPlaybackAuthorityHooks();
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('Standard host navigation during the Undo window', () => {
  it('commits the deletion, then Next skips the deleted track', async () => {
    startHost();
    const pill = deleteRows(TWO);
    expect(queueIds()).toEqual([ONE, TWO, THREE, FOUR]);

    playNextTrack();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([`remove:${TWO}`, 'load:VIDEO_THREE']);
    expect(queueIds()).toEqual([ONE, THREE, FOUR]);
    expect(getState('playlist.currentQueueItemId')).toBe(THREE);
    expectUndoGone(pill, removals);
  });

  it('commits before a natural end advances', async () => {
    startHost();
    deleteRows(TWO);

    bus.emit('player:ended');
    expect(events).toEqual([`remove:${TWO}`]);
    await vi.advanceTimersByTimeAsync(500);

    expect(events).toEqual([`remove:${TWO}`, 'load:VIDEO_THREE']);
    expect(getState('playlist.currentQueueItemId')).toBe(THREE);
  });

  it('commits as soon as the playing track nears its end', () => {
    startHost();
    deleteRows(TWO);

    bus.emit('ui:time-update', '0:56', '1:00', 56, 60);
    expect(removals).not.toHaveBeenCalled();
    bus.emit('ui:time-update', '0:58', '1:00', 57.5, 60);

    expect(removals).toHaveBeenCalledWith([TWO]);
    expect(selectionBar().hidden).toBe(true);
  });

  it('commits before Previous', async () => {
    startHost(THREE);
    deleteRows(TWO);

    playPrevTrack();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([`remove:${TWO}`, 'load:VIDEO_ONE_01']);
    expect(getState('playlist.currentQueueItemId')).toBe(ONE);
  });

  it('commits before another track is chosen from the list', async () => {
    startHost();
    const pill = deleteRows(TWO);

    document.querySelector<HTMLElement>(`.track-item[data-queue-item-id="${FOUR}"]`)!.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([`remove:${TWO}`, 'load:VIDEO_FOUR4']);
    expect(getState('playlist.currentQueueItemId')).toBe(FOUR);
    expectUndoGone(pill, removals);
  });

  it('commits before media-session or keyboard Next', async () => {
    startHost();
    deleteRows(TWO, THREE);

    bus.emit('playlist:next-track');
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([`remove:${TWO},${THREE}`, 'load:VIDEO_FOUR4']);
  });

  it('lets the removal of the playing row choose its successor instead of stepping twice', async () => {
    startHost();
    deleteRows(ONE, TWO);

    playNextTrack();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([`remove:${ONE},${TWO}`, 'load:VIDEO_THREE']);
    expect(getState('playlist.currentQueueItemId')).toBe(THREE);
  });

  it('leaves navigation alone when no deletion is pending', async () => {
    startHost();

    playNextTrack();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual(['load:VIDEO_TWO_02']);
    expect(removals).not.toHaveBeenCalled();
  });

  it('keeps Undo working when nothing navigates, and Undo still sends nothing', async () => {
    startHost();
    const pill = deleteRows(TWO);

    pill.click();
    playNextTrack();
    await vi.advanceTimersByTimeAsync(PLAYLIST_REMOVAL_UNDO_MS + 1_000);

    expect(removals).not.toHaveBeenCalled();
    expect(events).toEqual(['load:VIDEO_TWO_02']);
  });

  it('drops a pending deletion on a room change without sending it', async () => {
    startHost();
    deleteRows(TWO);

    setState('network.appRole', 'idle');
    playNextTrack();
    await vi.advanceTimersByTimeAsync(PLAYLIST_REMOVAL_UNDO_MS + 1_000);

    expect(removals).not.toHaveBeenCalled();
    expect(queueIds()).toEqual([ONE, TWO, THREE, FOUR]);
  });
});

describe('Standard guest navigation during the Undo window', () => {
  function startGuest(capabilities: RoomCapability[]): Mock {
    const send = vi.fn();
    setState('network.appRole', 'guest');
    setState('network.hostConn', { peer: 'host', open: true, send } as unknown as DataConnection);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', capabilities);
    setState('playlist.items', queue());
    setState('playlist.currentQueueItemId', ONE);
    initPlaylist();
    initPlaylistView();
    return send;
  }

  function sentTypes(send: Mock): string[] {
    return send.mock.calls.map(([frame]) => (frame as { type: string }).type);
  }

  const capabilities: RoomCapability[] = [
    'media.add',
    'queue.mutate',
    'asset.upload',
    'playback.control',
  ];

  it('sends the removal before the Next request on the same connection', () => {
    const send = startGuest(capabilities);
    deleteRows(TWO);

    playNextTrack();

    expect(sentTypes(send)).toEqual([MSG.REQUEST_PLAYLIST_REMOVE, MSG.REQUEST_NEXT_TRACK]);
    expect(send.mock.calls[0]![0]).toMatchObject({ queueItemIds: [TWO] });
    expect(send.mock.calls[1]![0]).toMatchObject({ queueItemId: ONE });
    // The row stays hidden until the host's snapshot drops it.
    expect(document.querySelector(`.track-item[data-queue-item-id="${TWO}"]`)).toBeNull();
  });

  it('sends the removal before a chosen track', () => {
    const send = startGuest(capabilities);
    deleteRows(TWO);

    document.querySelector<HTMLElement>(`.track-item[data-queue-item-id="${FOUR}"]`)!.click();

    expect(sentTypes(send)).toEqual([MSG.REQUEST_PLAYLIST_REMOVE, MSG.REQUEST_TRACK_CHANGE]);
    expect(send.mock.calls[1]![0]).toMatchObject({ queueItemId: FOUR });
  });

  it('commits before the host can advance at the end of the playing track', () => {
    const send = startGuest(capabilities);
    deleteRows(TWO);

    bus.emit('ui:time-update', '0:58', '1:00', 58, 60);

    expect(sentTypes(send)).toEqual([MSG.REQUEST_PLAYLIST_REMOVE]);
  });

  it('sends only the removal when it takes the playing row', () => {
    const send = startGuest(capabilities);
    deleteRows(ONE);

    playNextTrack();

    // The host's removed-current rule starts the successor itself.
    expect(sentTypes(send)).toEqual([MSG.REQUEST_PLAYLIST_REMOVE]);
  });
});

describe('PRO navigation during the Undo window', () => {
  function startPro(): { order: string[]; intents: ProPlaybackUserIntent[] } {
    const order: string[] = [];
    const intents: ProPlaybackUserIntent[] = [];
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'coordinator-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['queue.mutate', 'playback.control'],
    });
    const hooks: ProRoomMediaHooks = {
      addFiles: () => false,
      addYouTube: () => false,
      updateTrackMetadata: () => false,
      removeTracks: (queueItemIds) => {
        order.push(`remove:${queueItemIds.join()}`);
        return true;
      },
      reorderTrack: () => false,
      resolveFile: () => null,
    };
    registerProRoomMediaHooks(hooks);
    registerProPlaybackCommandHandler((intent) => {
      order.push(`command:${intent.kind}`);
      intents.push(intent);
    });
    setState('playlist.items', queue());
    setState('playlist.currentQueueItemId', ONE);
    initPlaylist();
    initPlaylistView();
    return { order, intents };
  }

  it('sends the removal mutation before the Next command', () => {
    const { order } = startPro();
    deleteRows(TWO);

    playNextTrack();

    expect(order).toEqual([`remove:${TWO}`, 'command:next']);
  });

  it('sends the removal mutation before a chosen track', () => {
    const { order, intents } = startPro();
    deleteRows(TWO);

    document.querySelector<HTMLElement>(`.track-item[data-queue-item-id="${FOUR}"]`)!.click();

    expect(order).toEqual([`remove:${TWO}`, 'command:select']);
    expect(intents[0]).toMatchObject({ kind: 'select', queueItemId: FOUR });
  });

  it('sends the removal ahead of the Worker natural advance', () => {
    const { order } = startPro();
    deleteRows(TWO);

    bus.emit('ui:time-update', '0:58', '1:00', 58, 60);

    expect(order).toEqual([`remove:${TWO}`]);
  });

  it('does not step from a playing row the deletion removed', () => {
    const { order } = startPro();
    deleteRows(ONE);

    playNextTrack();

    expect(order).toEqual([`remove:${ONE}`]);
  });
});
