/**
 * Fake YouTube IFrame Player for integration tests.
 *
 * Records every API call into `__log` with a `Date.now()` timestamp (which
 * is controlled by vitest fake timers in tests), so tests can assert on
 * call order, method names, arguments, and timing deltas.
 *
 * State model mirrors a subset of the real YT IFrame API:
 *   -1 UNSTARTED | 0 ENDED | 1 PLAYING | 2 PAUSED | 3 BUFFERING | 5 CUED
 */

export interface FakeYtPlayerCall {
  op:
    | 'playVideo'
    | 'pauseVideo'
    | 'seekTo'
    | 'stopVideo'
    | 'cueVideoById'
    | 'loadVideoById'
    | 'nextVideo'
    | 'previousVideo'
    | 'setVolume'
    | 'mute'
    | 'unMute'
    | 'destroy';
  args?: unknown[];
  at: number;
}

export interface FakeYtStateChangeEvent {
  data: number;
  target: FakeYtPlayer;
}

export interface FakeYtPlayer {
  // Internal inspection
  __log: FakeYtPlayerCall[];
  __state: number;
  __currentTime: number;
  __duration: number;
  __videoId: string;
  __playlistIdx: number;
  __playlist: string[];
  __volume: number;
  __muted: boolean;
  __loadedFraction: number;
  /**
   * Opt-in clock model for zero-start tests. Legacy sync tests keep the old,
   * manually controlled currentTime semantics unless this is set to true.
   */
  __advanceClock: boolean;
  /** Real loadVideoById autoplays; kept opt-in so existing sync tests stay deterministic. */
  __autoPlayOnLoad: boolean;
  /** Opt-in hard-mute failure/delay for timeout and fallback tests. */
  __hardMuteFails: boolean;
  __hardMuteDelayMs: number;
  __onStateChange?: (event: FakeYtStateChangeEvent) => void;
  // YT IFrame API surface used by sync.ts / player.ts
  playVideo: () => void;
  pauseVideo: () => void;
  stopVideo: () => void;
  seekTo: (t: number, allowAhead?: boolean) => void;
  cueVideoById: (id: string, startSeconds?: number) => void;
  loadVideoById: (id: string, startSeconds?: number) => void;
  nextVideo: () => void;
  previousVideo: () => void;
  setVolume: (v: number) => void;
  mute: () => void;
  unMute: () => void;
  isMuted: () => boolean;
  destroy: () => void;
  getPlayerState: () => number;
  getCurrentTime: () => number;
  getDuration: () => number;
  getVideoData: () => { video_id: string; title?: string };
  getPlaylistIndex: () => number;
  getPlaylist: () => string[];
  getVolume: () => number;
  getVideoLoadedFraction: () => number;
  /** Test-only deterministic state injection, optionally notifying the app callback. */
  __setState: (state: number, emit?: boolean) => void;
}

export function makeFakeYtPlayer(init?: Partial<FakeYtPlayer>): FakeYtPlayer {
  let playStartedAt: number | null = null;
  let playStartedFrom = 0;
  let muteGeneration = 0;

  function syncClock(self: FakeYtPlayer): void {
    if (!self.__advanceClock || self.__state !== 1 || playStartedAt === null) return;
    self.__currentTime = Math.min(
      self.__duration,
      playStartedFrom + Math.max(0, Date.now() - playStartedAt) / 1000,
    );
  }

  function transition(self: FakeYtPlayer, state: number, emit = true): void {
    syncClock(self);
    self.__state = state;
    if (state === 1) {
      playStartedFrom = self.__currentTime;
      playStartedAt = Date.now();
    } else {
      playStartedAt = null;
    }
    if (emit) self.__onStateChange?.({ data: state, target: self });
  }

  const self: FakeYtPlayer = {
    __log: [],
    __state: init?.__state ?? 2, // default PAUSED
    __currentTime: init?.__currentTime ?? 0,
    __duration: init?.__duration ?? 300,
    __videoId: init?.__videoId ?? 'FAKE_VIDEO',
    __playlistIdx: init?.__playlistIdx ?? 0,
    __playlist: init?.__playlist ?? [],
    __volume: init?.__volume ?? 100,
    __muted: init?.__muted ?? false,
    __loadedFraction: init?.__loadedFraction ?? 1,
    __advanceClock: init?.__advanceClock ?? false,
    __autoPlayOnLoad: init?.__autoPlayOnLoad ?? false,
    __hardMuteFails: init?.__hardMuteFails ?? false,
    __hardMuteDelayMs: init?.__hardMuteDelayMs ?? 0,
    __onStateChange: init?.__onStateChange,

    playVideo() {
      self.__log.push({ op: 'playVideo', at: Date.now() });
      transition(self, 1);
    },
    pauseVideo() {
      self.__log.push({ op: 'pauseVideo', at: Date.now() });
      transition(self, 2);
    },
    stopVideo() {
      self.__log.push({ op: 'stopVideo', at: Date.now() });
      transition(self, 0);
    },
    seekTo(t: number, allowAhead?: boolean) {
      self.__log.push({ op: 'seekTo', args: [t, allowAhead], at: Date.now() });
      self.__currentTime = t;
      if (self.__state === 1) {
        playStartedFrom = t;
        playStartedAt = Date.now();
      }
    },
    cueVideoById(id: string, startSeconds = 0) {
      self.__log.push({ op: 'cueVideoById', args: [id, startSeconds], at: Date.now() });
      self.__videoId = id;
      self.__currentTime = startSeconds;
      transition(self, 5);
    },
    loadVideoById(id: string, startSeconds?: number) {
      self.__log.push({
        op: 'loadVideoById',
        args: startSeconds === undefined ? [id] : [id, startSeconds],
        at: Date.now(),
      });
      self.__videoId = id;
      self.__currentTime = startSeconds ?? 0;
      if (self.__autoPlayOnLoad) transition(self, 1);
    },
    nextVideo() {
      self.__log.push({ op: 'nextVideo', at: Date.now() });
      self.__playlistIdx = Math.min(self.__playlistIdx + 1, self.__playlist.length - 1);
    },
    previousVideo() {
      self.__log.push({ op: 'previousVideo', at: Date.now() });
      self.__playlistIdx = Math.max(self.__playlistIdx - 1, 0);
    },
    setVolume(v: number) {
      self.__log.push({ op: 'setVolume', args: [v], at: Date.now() });
      self.__volume = v;
    },
    mute() {
      self.__log.push({ op: 'mute', at: Date.now() });
      const generation = ++muteGeneration;
      if (self.__hardMuteFails) return;
      if (self.__hardMuteDelayMs <= 0) {
        self.__muted = true;
        return;
      }
      setTimeout(() => {
        if (muteGeneration === generation && !self.__hardMuteFails) self.__muted = true;
      }, self.__hardMuteDelayMs);
    },
    unMute() {
      self.__log.push({ op: 'unMute', at: Date.now() });
      ++muteGeneration;
      self.__muted = false;
    },
    destroy() {
      self.__log.push({ op: 'destroy', at: Date.now() });
    },

    getPlayerState: () => self.__state,
    getCurrentTime: () => {
      syncClock(self);
      return self.__currentTime;
    },
    getDuration: () => self.__duration,
    getVideoData: () => ({ video_id: self.__videoId }),
    getPlaylistIndex: () => self.__playlistIdx,
    getPlaylist: () => self.__playlist,
    getVolume: () => self.__volume,
    isMuted: () => self.__muted,
    getVideoLoadedFraction: () => self.__loadedFraction,
    __setState(state: number, emit = true) {
      transition(self, state, emit);
    },
  };

  if (self.__advanceClock && self.__state === 1) {
    playStartedFrom = self.__currentTime;
    playStartedAt = Date.now();
  }
  return self;
}

/** Return operation names without arguments or timestamps. */
export function ops(player: FakeYtPlayer): string[] {
  return player.__log.map((c) => c.op);
}

/** Return behavior operations while excluding teardown. */
export function mutationOps(player: FakeYtPlayer): string[] {
  return player.__log.filter((c) => c.op !== 'destroy').map((c) => c.op);
}

/** Return the first call index, throwing a useful assertion-style error when absent. */
export function callIndex(player: FakeYtPlayer, op: FakeYtPlayerCall['op']): number {
  const index = player.__log.findIndex((call) => call.op === op);
  if (index < 0)
    throw new Error(`Expected fake YouTube call ${op}; got: ${ops(player).join(', ')}`);
  return index;
}

/**
 * Focused zero-start invariant: the real track must load only after hard mute,
 * and unmute must happen only after playback was paused and returned to zero.
 */
export function assertHardMutedWarmupOrder(player: FakeYtPlayer): void {
  const mute = callIndex(player, 'mute');
  const load = callIndex(player, 'loadVideoById');
  const pause = callIndex(player, 'pauseVideo');
  const seek = callIndex(player, 'seekTo');
  const unmute = callIndex(player, 'unMute');
  if (!(mute < load && load < pause && pause < seek && seek < unmute)) {
    throw new Error(`Invalid zero-start warmup order: ${ops(player).join(' -> ')}`);
  }
}
