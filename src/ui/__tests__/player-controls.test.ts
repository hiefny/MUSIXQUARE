/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setCurrentAudioBuffer } from '../../player/_state.ts';
import { clearFilePlaybackRuntime } from '../../player/file-playback-runtime.ts';
import { publishManagedFilePlaybackSource } from '../../player/__tests__/managed-file-playback-fixture.ts';
import { setPlaybackIdle, setPlaybackSystemAudioPlaying } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';
import { broadcastYouTubeSync, guestRendezvousSync } from '../../youtube/sync.ts';
import { showToast } from '../toast.ts';
import {
  getRoleLabelByChannelMode,
  getStandardRolePreset,
  getInviteCode,
  initPlayerControls,
  updateRoleBadge,
} from '../player-controls.ts';

const PLAY_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';
const PAUSE_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000002';

function setResidentFile(queueItemId: string): void {
  const blob = new File(['audio'], 'track.mp3', { type: 'audio/mpeg' });
  setState('playlist.currentQueueItemId', queueItemId);
  setState('files.current', {
    queueItemId,
    indexHint: 0,
    name: blob.name,
    sessionId: 1,
    blob,
    mime: blob.type,
    size: blob.size,
  });
}

vi.mock('../../youtube/sync.ts', () => ({
  broadcastYouTubeSync: vi.fn(),
  guestRendezvousSync: vi.fn(),
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
}));

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  setCurrentAudioBuffer(null);
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

afterEach(() => {
  clearAllManagedTimers();
  setCurrentAudioBuffer(null);
  bus.clear();
});

function makeConnection(peer: string): DataConnection {
  return { peer, open: true } as DataConnection;
}

describe('getRoleLabelByChannelMode', () => {
  it('returns Original for mode 0', () => {
    expect(getRoleLabelByChannelMode(0)).toBe('Original');
  });

  it('returns Left for mode -1', () => {
    expect(getRoleLabelByChannelMode(-1)).toBe('Left');
  });

  it('returns Right for mode 1', () => {
    expect(getRoleLabelByChannelMode(1)).toBe('Right');
  });

  it('returns Woofer for mode 2', () => {
    expect(getRoleLabelByChannelMode(2)).toBe('Woofer');
  });

  it('falls back to Original for unknown mode', () => {
    expect(getRoleLabelByChannelMode(99)).toBe('Original');
  });
});

describe('getStandardRolePreset', () => {
  it('returns center preset for mode 0', () => {
    const preset = getStandardRolePreset(0);
    expect(preset.labelKey).toBe('common.original');
    expect(preset.placementToastKey).toBe('role.center_placement');
  });

  it('returns left preset for mode -1', () => {
    const preset = getStandardRolePreset(-1);
    expect(preset.labelKey).toBe('common.left');
    expect(preset.placementToastKey).toBe('role.left_placement');
  });

  it('returns right preset for mode 1', () => {
    const preset = getStandardRolePreset(1);
    expect(preset.labelKey).toBe('common.right');
    expect(preset.placementToastKey).toBe('role.right_placement');
  });

  it('falls back to Original preset for unknown mode', () => {
    const preset = getStandardRolePreset(99);
    expect(preset.labelKey).toBe('common.original');
    expect(preset.placementToastKey).toBe('role.center_placement');
  });
});

describe('getInviteCode', () => {
  it('returns sessionCode when valid 6-digit', () => {
    setState('network.sessionCode', '123456');
    expect(getInviteCode()).toBe('123456');
  });

  it('returns lastJoinCode when sessionCode is empty', () => {
    setState('network.sessionCode', '');
    setState('network.lastJoinCode', '654321');
    expect(getInviteCode()).toBe('654321');
  });

  it('returns ------ when both are empty', () => {
    setState('network.sessionCode', '');
    setState('network.lastJoinCode', '');
    expect(getInviteCode()).toBe('------');
  });

  it('returns ------ when sessionCode is invalid format', () => {
    setState('network.sessionCode', 'abc');
    setState('network.lastJoinCode', '');
    expect(getInviteCode()).toBe('------');
  });

  it('prefers sessionCode over lastJoinCode', () => {
    setState('network.sessionCode', '111111');
    setState('network.lastJoinCode', '222222');
    expect(getInviteCode()).toBe('111111');
  });
});

describe('updateRoleBadge', () => {
  function renderBadge(): HTMLElement {
    document.body.innerHTML = `
      <div class="role-badge" id="role-badge">
        <span class="role-dot"></span>
        <span id="role-text"></span>
      </div>
    `;
    return document.getElementById('role-badge') as HTMLElement;
  }

  it('marks a connected remote guest with the remote class', () => {
    const badge = renderBadge();
    setState('network.hostConn', makeConnection('host-1'));
    setState('network.myDeviceLabel', 'GUEST 1');
    setState('network.connectionType', 'remote');

    updateRoleBadge();

    expect(badge.classList.contains('connected')).toBe(true);
    expect(badge.classList.contains('remote')).toBe(true);
    expect(document.getElementById('role-text')?.textContent).toContain('GUEST 1');
  });

  it('keeps a connected local guest blue by clearing the remote class', () => {
    const badge = renderBadge();
    badge.classList.add('remote');
    setState('network.hostConn', makeConnection('host-1'));
    setState('network.myDeviceLabel', 'GUEST 1');
    setState('network.connectionType', 'local');

    updateRoleBadge();

    expect(badge.classList.contains('connected')).toBe(true);
    expect(badge.classList.contains('remote')).toBe(false);
  });

  it('pulses the role dot twice per host-clock second', () => {
    vi.useFakeTimers();
    try {
      const badge = renderBadge();
      const dot = badge.querySelector('.role-dot') as HTMLElement;
      vi.setSystemTime(0);
      setState('network.appRole', 'host');

      updateRoleBadge();
      expect(dot.classList.contains('clock-beat')).toBe(true);

      vi.advanceTimersByTime(120);
      expect(dot.classList.contains('clock-beat')).toBe(false);

      vi.advanceTimersByTime(119);
      expect(dot.classList.contains('clock-beat')).toBe(false);

      vi.advanceTimersByTime(1);
      expect(dot.classList.contains('clock-beat')).toBe(true);

      vi.advanceTimersByTime(120);
      expect(dot.classList.contains('clock-beat')).toBe(false);

      vi.advanceTimersByTime(640);
      expect(dot.classList.contains('clock-beat')).toBe(true);
    } finally {
      clearAllManagedTimers();
      vi.useRealTimers();
    }
  });
});

describe('initPlayerControls playback mode rendering', () => {
  function renderPlaybackControls(): void {
    document.body.innerHTML = `
      <button id="play-btn"><svg><path d=""></path></svg></button>
      <button id="btn-media-source"><span data-i18n="player.play_media">Play media</span></button>
    `;
  }

  function renderDualIconPlaybackControls(): void {
    document.body.innerHTML = `
      <button id="play-btn">
        <svg id="icon-play"><path d="M8 5v14l11-7z"></path></svg>
        <svg id="icon-pause" display="none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path></svg>
      </button>
      <button id="btn-media-source"><span data-i18n="player.play_media">Play media</span></button>
    `;
  }

  it('renders the current playback mode immediately and stays reactive afterward', () => {
    renderPlaybackControls();
    setPlaybackSystemAudioPlaying();

    initPlayerControls();

    const icon = document.querySelector('#play-btn path');
    const mediaBtn = document.getElementById('btn-media-source');
    const mediaLabel = mediaBtn?.querySelector('span');

    expect(icon?.getAttribute('d')).toBe('M6 19h4V5H6v14zm8-14v14h4V5h-4z');
    expect(mediaLabel?.getAttribute('data-i18n')).toBe('system_audio.stop');

    setPlaybackIdle();

    expect(icon?.getAttribute('d')).toBe('M8 5v14l11-7z');
    expect(mediaLabel?.getAttribute('data-i18n')).toBe('player.play_media');
    expect(mediaBtn?.classList.contains('sys-audio-guest')).toBe(false);
  });

  it('uses playback mode for YouTube play-state events', () => {
    renderPlaybackControls();
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    initPlayerControls();

    const icon = document.querySelector('#play-btn path');
    expect(icon?.getAttribute('d')).toBe('M8 5v14l11-7z');

    bus.emit('ui:update-play-state', true);
    expect(icon?.getAttribute('d')).toBe('M6 19h4V5H6v14zm8-14v14h4V5h-4z');
  });

  it('toggles the real play and pause SVG elements instead of mutating only one path', () => {
    renderDualIconPlaybackControls();
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');

    initPlayerControls();

    const playIcon = document.getElementById('icon-play');
    const pauseIcon = document.getElementById('icon-pause');
    expect(playIcon?.getAttribute('display')).toBe('none');
    expect(pauseIcon?.getAttribute('display')).toBe('block');

    setPlaybackIdle();
    expect(playIcon?.getAttribute('display')).toBe('block');
    expect(pauseIcon?.getAttribute('display')).toBe('none');
  });

  it('shows the loading play button while a local file is preparing', () => {
    renderPlaybackControls();
    setState('playback.lifecycle', PLAYBACK_STATE.DECODING);

    initPlayerControls();

    const playBtn = document.getElementById('play-btn');
    expect(playBtn?.classList.contains('yt-syncing')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');

    setState('playback.lifecycle', PLAYBACK_STATE.READY);

    expect(playBtn?.classList.contains('yt-syncing')).toBe(false);
    expect(playBtn?.getAttribute('aria-busy')).toBe('false');
  });

  it('keeps V2 host seek loading tokenized and ORed with lifecycle loading', () => {
    renderPlaybackControls();
    setState('playback.lifecycle', PLAYBACK_STATE.READY);
    initPlayerControls();

    const playBtn = document.getElementById('play-btn');
    bus.emit('player:v2-host-seek-pending', {
      token: 202,
      queueItemId: PLAY_QUEUE_ITEM_ID,
      targetSeconds: 36,
    });
    expect(playBtn?.classList.contains('yt-syncing')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');

    bus.emit('player:v2-host-seek-settled', {
      token: 201,
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'superseded',
      positionSeconds: 10,
    });
    expect(playBtn?.classList.contains('yt-syncing')).toBe(true);

    setState('playback.lifecycle', PLAYBACK_STATE.DECODING);
    bus.emit('player:v2-host-seek-settled', {
      token: 202,
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'committed',
      positionSeconds: 36,
    });
    expect(playBtn?.classList.contains('yt-syncing')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');

    setState('playback.lifecycle', PLAYBACK_STATE.READY);
    expect(playBtn?.classList.contains('yt-syncing')).toBe(false);
    expect(playBtn?.getAttribute('aria-busy')).toBe('false');
  });

  it.each(['stop', 'seek-reset'] as const)(
    'clears V2 host seek loading on a transport-bypassing %s teardown',
    (teardown) => {
      renderPlaybackControls();
      setState('playback.lifecycle', PLAYBACK_STATE.READY);
      initPlayerControls();

      const playBtn = document.getElementById('play-btn');
      bus.emit('player:v2-host-seek-pending', {
        token: 303,
        queueItemId: PLAY_QUEUE_ITEM_ID,
        targetSeconds: 48,
      });
      expect(playBtn?.classList.contains('yt-syncing')).toBe(true);
      expect(playBtn?.getAttribute('aria-busy')).toBe('true');

      if (teardown === 'stop') bus.emit('player:stop-all-media');
      else bus.emit('ui:seek-reset');

      expect(playBtn?.classList.contains('yt-syncing')).toBe(false);
      expect(playBtn?.getAttribute('aria-busy')).toBe('false');
    },
  );
});

describe('initPlayerControls volume icon', () => {
  function renderVolumeControls(): HTMLElement {
    document.body.innerHTML = `
      <button id="vol-icon-btn" aria-label="Toggle mute">
        <svg class="volume-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path class="volume-speaker" d="M3 9v6h4l5 5V4L7 9H3z"></path>
          <path class="volume-wave volume-wave-inner" d="M15.2 8.5a4.9 4.9 0 0 1 0 7"></path>
          <path class="volume-wave volume-wave-outer" d="M18 5.7a8.9 8.9 0 0 1 0 12.6"></path>
          <g class="volume-muted-backdrop">
            <circle class="volume-muted-ring" cx="17" cy="12" r="4.8"></circle>
            <path class="volume-muted-slash" d="M13.6 8.6l6.8 6.8"></path>
          </g>
          <g class="volume-muted-mark">
            <circle class="volume-muted-ring" cx="17" cy="12" r="4.8"></circle>
            <path class="volume-muted-slash" d="M13.6 8.6l6.8 6.8"></path>
          </g>
        </svg>
      </button>
      <input type="range" id="volume-slider" min="0" max="100" value="100" />
    `;
    return document.getElementById('vol-icon-btn') as HTMLElement;
  }

  it('uses a class-driven muted mark instead of swapping icon paths', () => {
    const button = renderVolumeControls();
    setState('audio.masterVolume', 0);

    initPlayerControls();

    expect(button.classList.contains('is-muted')).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(
      document.getElementById('volume-slider')?.style.getPropertyValue('--range-progress'),
    ).toBe('0%');

    setState('audio.masterVolume', 0.65);
    bus.emit('audio:volume-changed', 0.65);

    expect(button.classList.contains('is-muted')).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect((document.getElementById('volume-slider') as HTMLInputElement).value).toBe('65');
    expect(
      document.getElementById('volume-slider')?.style.getPropertyValue('--range-progress'),
    ).toBe('65%');
  });
});

describe('initPlayerControls sync button', () => {
  function renderSyncControls(): void {
    document.body.innerHTML = `
      <button id="btn-sync"></button>
      <button id="play-btn"><svg><path d=""></path></svg></button>
      <button id="btn-media-source"><span data-i18n="player.play_media">Play media</span></button>
      <div id="manual-sync-overlay"></div>
      <span id="manual-sync-value"></span>
      <span id="auto-sync-value"></span>
    `;
  }

  it('runs guest YouTube rendezvous before opening the manual sync panel', () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    setState('sync.youtubeLocalOffset', 0.25);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    const guestSync = vi.mocked(guestRendezvousSync);
    expect(guestSync).toHaveBeenCalledTimes(1);
    const opts = guestSync.mock.calls[0][0];
    expect(opts?.suppressProgressToast).toBe(true);
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);

    opts?.onComplete?.();

    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
    expect((document.getElementById('manual-sync-value') as HTMLElement | null)?.innerText).toBe(
      '+250',
    );
    expect(showToast).toHaveBeenCalledWith(
      'Automatic sync was just attempted.\nIf it still feels delayed, adjust the value now',
    );
  });

  it('sends a YouTube rendezvous request when the host presses sync', () => {
    renderSyncControls();
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(broadcastYouTubeSync).toHaveBeenCalledWith(true);
    expect(guestRendezvousSync).not.toHaveBeenCalled();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      'Precision sync requested.\nAdjust manual sync on a guest device.',
    );
  });

  it('does not treat a closed YouTube host connection as either host or guest sync', () => {
    renderSyncControls();
    setState('network.hostConn', { peer: 'host-1', open: false } as DataConnection);
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(broadcastYouTubeSync).not.toHaveBeenCalled();
    expect(guestRendezvousSync).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('broadcasts an authoritative local-file PLAY sync when the host presses sync', () => {
    renderSyncControls();
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('playlist.currentQueueItemId', PLAY_QUEUE_ITEM_ID);
    setState('player.pausedAt', 42);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    const broadcastSpy = vi.fn();
    bus.on('network:broadcast', broadcastSpy);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PLAY,
        queueItemId: PLAY_QUEUE_ITEM_ID,
        time: expect.any(Number),
        hostPlayAt: expect.any(Number),
      }),
    );
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      'Precision sync requested.\nAdjust manual sync on a guest device.',
    );
  });

  it('broadcasts a local-file PAUSE position sync when the host is paused', () => {
    renderSyncControls();
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    setState('playlist.currentQueueItemId', PAUSE_QUEUE_ITEM_ID);
    setState('player.pausedAt', 33);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    const broadcastSpy = vi.fn();
    bus.on('network:broadcast', broadcastSpy);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(broadcastSpy).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 33,
      queueItemId: PAUSE_QUEUE_ITEM_ID,
      reason: 'seek',
    });
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
  });

  it('runs one local-file resync before opening the guest manual sync panel', () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('sync.localOffset', 0.12);
    setResidentFile(PLAY_QUEUE_ITEM_ID);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    const forceResyncSpy = vi.fn();
    bus.on('sync:force-resync', forceResyncSpy);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(forceResyncSpy).toHaveBeenCalledTimes(1);
    expect(getState('sync.localOffset')).toBe(0.12);
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
  });

  it('opens manual sync for an exact managed source without a legacy AudioBuffer', async () => {
    await publishManagedFilePlaybackSource(PLAY_QUEUE_ITEM_ID);
    try {
      renderSyncControls();
      setState('network.hostConn', makeConnection('host-1'));
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');
      setResidentFile(PLAY_QUEUE_ITEM_ID);
      const forceResyncSpy = vi.fn();
      bus.on('sync:force-resync', forceResyncSpy);

      initPlayerControls();
      document.getElementById('btn-sync')?.click();

      expect(forceResyncSpy).toHaveBeenCalledOnce();
      expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
    } finally {
      await clearFilePlaybackRuntime();
    }
  });

  it('does not open the local-file manual panel before the guest has a decoded buffer', () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    const forceResyncSpy = vi.fn();
    bus.on('sync:force-resync', forceResyncSpy);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(forceResyncSpy).not.toHaveBeenCalled();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('closes the local-file manual panel if the decoded buffer is cleared', () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setResidentFile(PLAY_QUEUE_ITEM_ID);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);

    setCurrentAudioBuffer(null);

    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
  });
});
