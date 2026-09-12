/** A Standard host rejoins its advancing room clock without stopping guests. */
import { bus } from '../core/events.ts';
import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../core/timers.ts';
import type { YouTubePlayerInstance } from './_state.ts';
import { setYtAutoplayIntent } from './_state.ts';
import { RENDEZVOUS_MARGIN_SEC } from './constants.ts';
import {
  resolveProCoordinatorYouTubeTarget,
  shouldNeutralizeStandardHostYouTubeOffsetAtEnd,
} from './local-offset.ts';
import { getEffectiveYouTubePlayLatencyMs } from './play-latency.ts';

const PLAY_TIMER = 'yt-standard-host-rendezvous-play';
const PREPARE_TIMEOUT_MS = 2_000;
const LATE_PLAY_LIMIT_MS = 150;
const POSITION_TOLERANCE_SEC = 0.025;

interface HostRendezvousOptions {
  player: YouTubePlayerInstance;
  videoId: string;
  duration: number;
  requestedOffset: number;
  detachPlaylist: boolean;
  isCurrent(): boolean;
  canonicalNow(): number;
  onDetach(): void;
  onWake(): void;
}

type HostRendezvousStatus = 'pending' | 'resumed' | 'failed';

export interface HostLocalRendezvous {
  start(): void;
  poll(): HostRendezvousStatus;
  cancel(): void;
}

/** The caller owns the lease and verification timer throughout this plan. */
export function createHostLocalRendezvous(options: HostRendezvousOptions): HostLocalRendezvous {
  const { player } = options;
  let phase: 'detach' | 'pause' | 'buffer' | 'wait' | 'resumed' | 'failed' = 'pause';
  let prepareDeadline = 0;
  let playAt = 0;
  let targetPosition = 0;
  let baselinePosition = 0;
  let seekObserved = false;
  let correctedUnexpectedPlay = false;
  let cancelled = false;

  const clear = (): void => {
    clearManagedTimer(PLAY_TIMER);
    bus.emit('youtube:sync-loading', false, 'rendezvous');
  };
  const fail = (): HostRendezvousStatus => {
    phase = 'failed';
    clear();
    return 'failed';
  };
  const liveIdentity = (): boolean => player.getVideoData?.()?.video_id === options.videoId;
  const schedulePlay = (): void => {
    if (getManagedTimer(PLAY_TIMER) !== null) return;
    setManagedTimer(PLAY_TIMER, options.onWake, Math.max(0, playAt - Date.now()));
  };

  return {
    start() {
      prepareDeadline = Date.now() + PREPARE_TIMEOUT_MS;
      bus.emit('youtube:sync-loading', true, 'rendezvous');
      if (options.detachPlaylist) {
        if (!player.cueVideoById) throw new Error('YouTube cannot detach a paused playlist');
        const position = player.getCurrentTime();
        if (!Number.isFinite(position)) throw new Error('YouTube position is unavailable');
        phase = 'detach';
        options.onDetach();
        player.cueVideoById(options.videoId, position);
      } else {
        player.pauseVideo();
      }
    },
    poll() {
      if (cancelled || !options.isCurrent()) return fail();
      if (phase === 'failed' || phase === 'resumed') return phase;
      const now = Date.now();
      if (phase === 'detach' || phase === 'pause') {
        if (now >= prepareDeadline) return fail();
        if (!liveIdentity()) return 'pending';
        if (phase === 'detach') {
          if (player.getPlaylistIndex?.() !== -1) return 'pending';
          phase = 'pause';
          player.pauseVideo();
          return 'pending';
        }
        const state = player.getPlayerState?.();
        if (state !== 2 && state !== 5) return 'pending';
        const canonical = options.canonicalNow() + RENDEZVOUS_MARGIN_SEC;
        const target = resolveProCoordinatorYouTubeTarget(
          canonical,
          options.requestedOffset,
          options.duration,
        );
        if (
          shouldNeutralizeStandardHostYouTubeOffsetAtEnd(
            target.localTime,
            target.canonicalTime,
            options.duration,
            target.effectiveOffset,
          ) ||
          (options.duration > 0 && target.canonicalTime >= options.duration)
        ) {
          return fail();
        }
        baselinePosition = player.getCurrentTime();
        if (!Number.isFinite(baselinePosition)) return fail();
        targetPosition = target.localTime;
        playAt = now + RENDEZVOUS_MARGIN_SEC * 1000 - getEffectiveYouTubePlayLatencyMs();
        phase = 'buffer';
        player.seekTo(targetPosition, true);
        return 'pending';
      }

      if (!liveIdentity() || (options.detachPlaylist && player.getPlaylistIndex?.() !== -1)) {
        return now >= playAt ? fail() : 'pending';
      }
      const state = player.getPlayerState?.();
      const position = player.getCurrentTime();
      if (!Number.isFinite(position)) return now >= playAt ? fail() : 'pending';
      if (
        state === 3 ||
        Math.abs(position - baselinePosition) > POSITION_TOLERANCE_SEC ||
        Math.abs(position - targetPosition) <= POSITION_TOLERANCE_SEC
      ) {
        seekObserved = true;
      }
      // A seek from CUED may start playback. Pause that operation once and
      // prepare a fresh future target: time already played cannot be treated
      // as if the original seek position were still waiting at its deadline.
      if (state === 1 && !correctedUnexpectedPlay) {
        correctedUnexpectedPlay = true;
        phase = 'pause';
        seekObserved = false;
        clearManagedTimer(PLAY_TIMER);
        player.pauseVideo();
        return now >= prepareDeadline ? fail() : 'pending';
      }
      const ready = seekObserved && (state === 2 || state === 5);
      if (!ready) return now >= playAt ? fail() : 'pending';
      phase = 'wait';
      if (now < playAt) {
        schedulePlay();
        return 'pending';
      }
      if (now - playAt > LATE_PLAY_LIMIT_MS) return fail();
      phase = 'resumed';
      clear();
      setYtAutoplayIntent(true);
      player.playVideo();
      return 'resumed';
    },
    cancel() {
      cancelled = true;
      clear();
    },
  };
}
