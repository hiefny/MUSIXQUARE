/**
 * Fake YouTube IFrame Player for integration tests.
 *
 * Records every API call into `__log` with a `Date.now()` timestamp (which
 * is controlled by vitest fake timers in tests), so tests can assert on
 * call order, method names, arguments, and timing deltas.
 *
 * State model mirrors a subset of the real YT IFrame API:
 *   -1 UNSTARTED | 0 ENDED | 1 PLAYING | 2 PAUSED | 3 BUFFERING | 5 CUED
 *
 * Fault knobs (all off by default, so a suite that sets none of them sees the
 * player it always had): `__unMuteIgnoreCount`, `__unMuteDelayMs`,
 * `__unMuteThrowCount`, `__volumeReadFault` and `__seekStateSequence`. Each is
 * a plain field read when the call happens, so a harness that copies the
 * method references (the scripted IFrame API) still sees a knob set later.
 * Their values model WebKit behaviour described in code comments (for example
 * "WebKit can ignore the first unmute", youtube/player.ts) and the late-unMute
 * mimic in sync-integration.test.ts; no device trace calibrates them. The
 * throwing unMute models no device either: it pins how each caller handles a
 * command that throws.
 *
 * State notifications reach `__onStateChange` synchronously, inside the
 * command that caused them, unless `__stateNotifyDelayMs` is set (opt-in,
 * default null): then each one arrives in a later task, as the real IFrame
 * API delivers onStateChange over postMessage.
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
  /**
   * Fault knob: the next N unMute() calls are logged but leave isMuted()
   * true, as when WebKit ignores the first unmute after an iframe
   * transition. Each ignored call counts the knob down by one and changes
   * nothing else (a pending delayed mute still lands). Default 0.
   */
  __unMuteIgnoreCount: number;
  /**
   * Fault knob: an accepted unMute() turns isMuted() false only this many
   * milliseconds later. The pending unmute is fenced by the same generation
   * as __hardMuteDelayMs, which every mute() and accepted unMute() advance:
   * a later mute() wins, and a repeated unMute() restarts the delay from its
   * own call. A restore loop that re-issues unMute() every 120 ms therefore
   * never sees a 250 ms delay land. The restart is a choice of this fake's
   * model, not a measured WebKit behaviour: a row whose outcome depends on it
   * pins the model, and says so. Default 0 (immediate).
   */
  __unMuteDelayMs: number;
  /**
   * Fault knob: the next N accepted unMute() calls take effect (as
   * __unMuteDelayMs says) and then throw, as a command that reaches the
   * iframe but reports an error. Each one counts the knob down by one; an
   * ignored unMute() neither throws nor counts. Default 0.
   */
  __unMuteThrowCount: number;
  /** Fault knob for getVolume(): null (default), 'nan' returns NaN, 'throw' throws. */
  __volumeReadFault: null | 'nan' | 'throw';
  /**
   * Fault knob: the player states seekTo() delivers, in order and
   * synchronously, through the same transition (and onStateChange) as
   * pause and play. Default [] keeps seekTo silent.
   */
  __seekStateSequence: number[];
  /**
   * Opt-in delivery delay for state notifications. null (default) calls
   * __onStateChange synchronously inside the command, as every existing suite
   * expects. A number delivers each notification in its own fake-timer task
   * that many milliseconds later (0: one task later; fake-timers makes a
   * zero delay 1 ms when the command itself runs inside a timer or its
   * microtasks). Each event carries the state of its own transition, and the
   * handler is read from __onStateChange when the event arrives.
   * getPlayerState() still answers the new state at once; the real API
   * answers from a cache that the same messages update, which this fake does
   * not model.
   */
  __stateNotifyDelayMs: number | null;
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
    if (!emit) return;
    const event: FakeYtStateChangeEvent = { data: state, target: self };
    if (self.__stateNotifyDelayMs === null) {
      self.__onStateChange?.(event);
      return;
    }
    setTimeout(() => self.__onStateChange?.(event), self.__stateNotifyDelayMs);
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
    __unMuteIgnoreCount: init?.__unMuteIgnoreCount ?? 0,
    __unMuteDelayMs: init?.__unMuteDelayMs ?? 0,
    __unMuteThrowCount: init?.__unMuteThrowCount ?? 0,
    __volumeReadFault: init?.__volumeReadFault ?? null,
    __seekStateSequence: init?.__seekStateSequence ?? [],
    __stateNotifyDelayMs: init?.__stateNotifyDelayMs ?? null,
    __onStateChange: init?.__onStateChange,

    playVideo() {
      self.__log.push({ op: 'playVideo', at: Date.now() });
      if (self.__state === 0 && self.__currentTime >= self.__duration) {
        return;
      }
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
      for (const state of [...self.__seekStateSequence]) transition(self, state);
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
      if (self.__unMuteIgnoreCount > 0) {
        self.__unMuteIgnoreCount -= 1;
        return;
      }
      const generation = ++muteGeneration;
      if (self.__unMuteDelayMs <= 0) {
        self.__muted = false;
      } else {
        setTimeout(() => {
          if (muteGeneration === generation) self.__muted = false;
        }, self.__unMuteDelayMs);
      }
      if (self.__unMuteThrowCount > 0) {
        self.__unMuteThrowCount -= 1;
        throw new Error('Fake unMute command fault');
      }
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
    getVolume: () => {
      if (self.__volumeReadFault === 'nan') return Number.NaN;
      if (self.__volumeReadFault === 'throw') throw new Error('Fake getVolume read fault');
      return self.__volume;
    },
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
