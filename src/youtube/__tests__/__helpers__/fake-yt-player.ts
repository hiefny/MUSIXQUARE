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
    | 'loadVideoById'
    | 'nextVideo'
    | 'previousVideo'
    | 'setVolume'
    | 'destroy';
  args?: unknown[];
  at: number;
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
  // YT IFrame API surface used by sync.ts / player.ts
  playVideo: () => void;
  pauseVideo: () => void;
  stopVideo: () => void;
  seekTo: (t: number, allowAhead?: boolean) => void;
  loadVideoById: (id: string) => void;
  nextVideo: () => void;
  previousVideo: () => void;
  setVolume: (v: number) => void;
  destroy: () => void;
  getPlayerState: () => number;
  getCurrentTime: () => number;
  getDuration: () => number;
  getVideoData: () => { video_id: string; title?: string };
  getPlaylistIndex: () => number;
  getPlaylist: () => string[];
}

export function makeFakeYtPlayer(init?: Partial<FakeYtPlayer>): FakeYtPlayer {
  const self: FakeYtPlayer = {
    __log: [],
    __state: init?.__state ?? 2, // default PAUSED
    __currentTime: init?.__currentTime ?? 0,
    __duration: init?.__duration ?? 300,
    __videoId: init?.__videoId ?? 'FAKE_VIDEO',
    __playlistIdx: init?.__playlistIdx ?? 0,
    __playlist: init?.__playlist ?? [],

    playVideo() {
      self.__log.push({ op: 'playVideo', at: Date.now() });
      self.__state = 1;
    },
    pauseVideo() {
      self.__log.push({ op: 'pauseVideo', at: Date.now() });
      self.__state = 2;
    },
    stopVideo() {
      self.__log.push({ op: 'stopVideo', at: Date.now() });
      self.__state = 0;
    },
    seekTo(t: number, allowAhead?: boolean) {
      self.__log.push({ op: 'seekTo', args: [t, allowAhead], at: Date.now() });
      self.__currentTime = t;
    },
    loadVideoById(id: string) {
      self.__log.push({ op: 'loadVideoById', args: [id], at: Date.now() });
      self.__videoId = id;
      self.__currentTime = 0;
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
    },
    destroy() {
      self.__log.push({ op: 'destroy', at: Date.now() });
    },

    getPlayerState: () => self.__state,
    getCurrentTime: () => self.__currentTime,
    getDuration: () => self.__duration,
    getVideoData: () => ({ video_id: self.__videoId }),
    getPlaylistIndex: () => self.__playlistIdx,
    getPlaylist: () => self.__playlist,
  };
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
