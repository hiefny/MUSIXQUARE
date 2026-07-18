/**
 * Fake YouTube IFrame API stub for Playwright E2E tests.
 *
 * Installs a deterministic `window.YT` BEFORE any page script runs so the
 * app's iframe loader (`src/youtube/iframe.ts::loadYouTubeVideo`) takes the
 * "already loaded" branch and uses our stub instead of fetching the real
 * `https://www.youtube.com/iframe_api` script. Every API call is pushed
 * onto `window.__fakeYtLog` with a `Date.now()` timestamp so tests can
 * assert on call order and timing from the test runner side via
 * `page.evaluate(() => window.__fakeYtLog)`.
 *
 * Why not just use the real YT API in headless Chromium?
 *   - Autoplay/cookie policies in headless mode block playback.
 *   - Region restrictions + bot detection make flaky.
 *   - We can't control timing for drift/sync regression assertions.
 *   - Real iframe startup adds network latency to every test.
 *
 * The stub handles: playVideo, pauseVideo, stopVideo, seekTo, loadVideoById,
 * loadPlaylist, playVideoAt, nextVideo, previousVideo, setVolume, destroy,
 * and all the getter APIs the app uses. onReady fires after a 20ms delay to
 * model iframe lazy initialization.
 */

import type { Page } from '@playwright/test';

export interface FakeYtOptions {
  /** Keep false by default so legacy rendezvous E2E retains its old timing. */
  autoPlayOnLoad?: boolean;
  /** Advance getCurrentTime from Date.now while PLAYING. */
  advanceClock?: boolean;
  /** Emit BUFFERING before a delayed PLAYING transition. */
  emitBuffering?: boolean;
  readyDelayMs?: number;
  stateChangeDelayMs?: number;
  loadDelayMs?: number;
  playDelayMs?: number;
  hardMuteDelayMs?: number;
  hardMuteFails?: boolean;
  unmuteDelayMs?: number;
  loadedFraction?: number;
}

export interface FakeYtLogEntry {
  op: string;
  args?: unknown[];
  at: number;
  state?: number;
  currentTime?: number;
  muted?: boolean;
  volume?: number;
  videoId?: string;
}

export interface FakeYtSnapshot {
  state: number;
  currentTime: number;
  duration: number;
  videoId: string;
  playlistIndex: number;
  muted: boolean;
  volume: number;
  loadedFraction: number;
  destroyed: boolean;
}

export interface FakeYtControl {
  state?: number;
  currentTime?: number;
  duration?: number;
  videoId?: string;
  muted?: boolean;
  volume?: number;
  loadedFraction?: number;
  emitStateChange?: boolean;
}

/** Script content injected into every page before navigation. */
const FAKE_YT_INIT = `
(function() {
  'use strict';
  if (window.__fakeYtInstalled) return;
  window.__fakeYtInstalled = true;
  window.__fakeYtLog = [];
  window.__fakeYtInstanceId = 0;

  var config = window.__fakeYtConfig = Object.assign({
    autoPlayOnLoad: false,
    advanceClock: false,
    emitBuffering: false,
    readyDelayMs: 20,
    stateChangeDelayMs: 0,
    loadDelayMs: 20,
    playDelayMs: 0,
    hardMuteDelayMs: 0,
    hardMuteFails: false,
    unmuteDelayMs: 0,
    loadedFraction: 1
  }, window.__fakeYtConfig || {});

  function finiteDelay(value) {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  function syncClock(player) {
    if (!player || !config.advanceClock || player.__state !== 1 || player.__playStartedAt === null) {
      return;
    }
    player.__currentTime = Math.min(
      player.__duration,
      player.__playStartedFrom + Math.max(0, Date.now() - player.__playStartedAt) / 1000
    );
  }

  function pushLog(op, args, player) {
    if (player) syncClock(player);
    window.__fakeYtLog.push({
      op: op,
      args: args,
      at: Date.now(),
      state: player ? player.__state : undefined,
      currentTime: player ? player.__currentTime : undefined,
      muted: player ? player.__muted : undefined,
      volume: player ? player.__volume : undefined,
      videoId: player ? player.__videoId : undefined
    });
  }

  function emitStateChange(player, state) {
    setTimeout(function() {
      if (player.__destroyed || !player.__events.onStateChange) return;
      player.__events.onStateChange({ data: state, target: player });
    }, finiteDelay(config.stateChangeDelayMs));
  }

  function applyState(player, state, emit) {
    syncClock(player);
    player.__state = state;
    if (state === 1) {
      player.__playStartedFrom = player.__currentTime;
      player.__playStartedAt = Date.now();
    } else {
      player.__playStartedAt = null;
    }
    if (emit !== false) emitStateChange(player, state);
  }

  function beginPlaying(player, delayMs, generation) {
    if (config.emitBuffering) applyState(player, 3, true);
    var start = function() {
      if (player.__destroyed || player.__transitionGeneration !== generation) return;
      applyState(player, 1, true);
    };
    var delay = finiteDelay(delayMs);
    if (delay === 0) start();
    else setTimeout(start, delay);
  }

  function FakePlayer(containerId, opts) {
    var self = this;
    self.__id = ++window.__fakeYtInstanceId;
    self.__state = -1; // UNSTARTED
    self.__currentTime = 0;
    self.__duration = 300;
    self.__videoId = (opts && opts.videoId) || 'FAKE_VIDEO_ID';
    self.__playlistIdx = 0;
    self.__playlist = [];
    self.__opts = opts || {};
    self.__destroyed = false;
    self.__events = (opts && opts.events) || {};
    self.__volume = 100;
    self.__muted = false;
    self.__loadedFraction = Number.isFinite(config.loadedFraction) ? config.loadedFraction : 1;
    self.__transitionGeneration = 0;
    self.__muteGeneration = 0;
    self.__playStartedAt = null;
    self.__playStartedFrom = 0;

    self.playVideo = function() {
      if (self.__destroyed) return;
      pushLog('playVideo', undefined, self);
      var generation = ++self.__transitionGeneration;
      beginPlaying(self, config.playDelayMs, generation);
    };
    self.pauseVideo = function() {
      if (self.__destroyed) return;
      pushLog('pauseVideo', undefined, self);
      ++self.__transitionGeneration;
      applyState(self, 2, true);
    };
    self.stopVideo = function() {
      if (self.__destroyed) return;
      pushLog('stopVideo', undefined, self);
      ++self.__transitionGeneration;
      applyState(self, 0, true);
    };
    self.seekTo = function(t, allowAhead) {
      if (self.__destroyed) return;
      pushLog('seekTo', [t, allowAhead], self);
      self.__currentTime = t;
      if (self.__state === 1) {
        self.__playStartedFrom = t;
        self.__playStartedAt = Date.now();
      }
    };
    self.cueVideoById = function(id, startSeconds) {
      if (self.__destroyed) return;
      pushLog('cueVideoById', [id, startSeconds], self);
      ++self.__transitionGeneration;
      self.__videoId = typeof id === 'string' ? id : (id && id.videoId) || self.__videoId;
      self.__currentTime = Number.isFinite(startSeconds) ? startSeconds : 0;
      applyState(self, 5, true);
    };
    self.loadVideoById = function(id, startSeconds) {
      if (self.__destroyed) return;
      pushLog('loadVideoById', [id, startSeconds], self);
      var generation = ++self.__transitionGeneration;
      self.__videoId = typeof id === 'string' ? id : (id && id.videoId) || self.__videoId;
      var objectStart = id && typeof id === 'object' ? id.startSeconds : undefined;
      self.__currentTime = Number.isFinite(startSeconds)
        ? startSeconds
        : Number.isFinite(objectStart)
          ? objectStart
          : 0;
      if (config.autoPlayOnLoad) beginPlaying(self, config.loadDelayMs, generation);
    };
    self.loadPlaylist = function(playlist, idx, start) {
      if (self.__destroyed) return;
      pushLog('loadPlaylist', [playlist, idx, start], self);
      if (Array.isArray(playlist)) {
        self.__playlist = playlist;
      } else if (playlist && playlist.list) {
        self.__playlist = [playlist.list];
      }
      self.__playlistIdx = idx || 0;
      self.__currentTime = Number.isFinite(start) ? start : 0;
    };
    self.playVideoAt = function(idx) {
      if (self.__destroyed) return;
      pushLog('playVideoAt', [idx], self);
      self.__playlistIdx = idx;
    };
    self.nextVideo = function() {
      if (self.__destroyed) return;
      pushLog('nextVideo', undefined, self);
      self.__playlistIdx = Math.min(self.__playlistIdx + 1, self.__playlist.length - 1);
    };
    self.previousVideo = function() {
      if (self.__destroyed) return;
      pushLog('previousVideo', undefined, self);
      self.__playlistIdx = Math.max(self.__playlistIdx - 1, 0);
    };
    self.setVolume = function(v) {
      pushLog('setVolume', [v], self);
      self.__volume = Math.max(0, Math.min(100, Number(v) || 0));
    };
    self.mute = function() {
      pushLog('mute', undefined, self);
      var generation = ++self.__muteGeneration;
      var apply = function() {
        if (self.__destroyed || self.__muteGeneration !== generation) return;
        if (config.hardMuteFails) return;
        self.__muted = true;
      };
      var delay = finiteDelay(config.hardMuteDelayMs);
      if (delay === 0) apply();
      else setTimeout(apply, delay);
    };
    self.unMute = function() {
      pushLog('unMute', undefined, self);
      var generation = ++self.__muteGeneration;
      var apply = function() {
        if (self.__destroyed || self.__muteGeneration !== generation) return;
        self.__muted = false;
      };
      var delay = finiteDelay(config.unmuteDelayMs);
      if (delay === 0) apply();
      else setTimeout(apply, delay);
    };
    self.isMuted = function() { return self.__muted; };
    self.destroy = function() {
      pushLog('destroy', undefined, self);
      self.__destroyed = true;
      ++self.__transitionGeneration;
      ++self.__muteGeneration;
    };

    // Getters — these are NOT logged to keep __fakeYtLog focused on mutations
    self.getPlayerState = function() { return self.__state; };
    self.getCurrentTime = function() {
      syncClock(self);
      return self.__currentTime;
    };
    self.getDuration = function() { return self.__duration; };
    self.getVideoData = function() { return { video_id: self.__videoId, title: 'Fake Title' }; };
    self.getPlaylistIndex = function() { return self.__playlistIdx; };
    self.getPlaylist = function() { return self.__playlist; };
    self.getVolume = function() { return self.__volume; };
    self.getIframe = function() { return document.createElement('div'); };
    self.getVideoLoadedFraction = function() { return self.__loadedFraction; };

    // Deterministic controls for focused zero-start E2E assertions.
    self.__setState = function(state, emit) {
      ++self.__transitionGeneration;
      applyState(self, state, emit !== false);
    };
    self.__setCurrentTime = function(time) {
      self.__currentTime = time;
      if (self.__state === 1) {
        self.__playStartedFrom = time;
        self.__playStartedAt = Date.now();
      }
    };
    self.__snapshot = function() {
      syncClock(self);
      return {
        state: self.__state,
        currentTime: self.__currentTime,
        duration: self.__duration,
        videoId: self.__videoId,
        playlistIndex: self.__playlistIdx,
        muted: self.__muted,
        volume: self.__volume,
        loadedFraction: self.__loadedFraction,
        destroyed: self.__destroyed
      };
    };

    // Track the latest instance for the test helper
    window.__fakeYtLastPlayer = self;

    // Fire onReady after a short delay to match real IFrame lazy init
    setTimeout(function() {
      if (self.__destroyed) return;
      var readyGeneration = self.__transitionGeneration;
      applyState(self, 5, false);
      if (self.__events.onReady) {
        self.__events.onReady({ target: self });
      }
      // Do not emit a stale CUED event if onReady synchronously loaded a track.
      if (self.__transitionGeneration === readyGeneration) emitStateChange(self, 5);
    }, finiteDelay(config.readyDelayMs));
  }

  window.YT = {
    Player: FakePlayer,
    PlayerState: {
      UNSTARTED: -1,
      ENDED: 0,
      PLAYING: 1,
      PAUSED: 2,
      BUFFERING: 3,
      CUED: 5,
    },
    ready: function(fn) { if (typeof fn === 'function') fn(); },
  };

  // Also mark the API as ready so the iframe loader's "already loaded" branch
  // succeeds without waiting for onYouTubeIframeAPIReady.
  window.isYouTubeAPIReady = true;

  // If the app already set onYouTubeIframeAPIReady callback, call it now.
  if (typeof window.onYouTubeIframeAPIReady === 'function') {
    try { window.onYouTubeIframeAPIReady(); } catch (e) { /* noop */ }
  }
})();
`;

/**
 * Install the fake YouTube API on a page. Must be called BEFORE navigation
 * (before `page.goto(...)`). Blocks the real iframe API script from loading
 * via route interception as a safety net.
 */
export async function installFakeYt(page: Page, options: FakeYtOptions = {}): Promise<void> {
  const initConfig = `window.__fakeYtConfig = ${JSON.stringify(options)};\n`;
  await page.addInitScript({ content: initConfig + FAKE_YT_INIT });
  // Route interception is a safety net for any loader path that bypasses the
  // preinstalled stub.
  await page.route(/youtube\.com\/iframe_api/, (route) => route.abort());
}

/**
 * Read the fake YT call log from a page.
 * Returns array of { op, args, at } entries.
 */
export async function readFakeYtLog(page: Page): Promise<FakeYtLogEntry[]> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return (w.__fakeYtLog as FakeYtLogEntry[]) || [];
  });
}

/** Clear the fake YT call log on a page. */
export async function clearFakeYtLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__fakeYtLog = [];
  });
}

/** Wait until a mutation has reached the fake player; useful across host/guest pages. */
export async function waitForFakeYtOp(
  page: Page,
  op: string,
  options: { count?: number; timeout?: number } = {},
): Promise<void> {
  const count = options.count ?? 1;
  await page.waitForFunction(
    ({ expectedOp, expectedCount }) => {
      const log = (window as unknown as Record<string, unknown>).__fakeYtLog as
        | Array<{ op: string }>
        | undefined;
      return (log?.filter((entry) => entry.op === expectedOp).length ?? 0) >= expectedCount;
    },
    { expectedOp: op, expectedCount: count },
    { timeout: options.timeout ?? 20_000 },
  );
}

/** Throw with the full operation trace when a zero-start ordering invariant fails. */
export function assertFakeYtOpOrder(log: FakeYtLogEntry[], expected: readonly string[]): void {
  let cursor = -1;
  for (const op of expected) {
    const next = log.findIndex((entry, index) => index > cursor && entry.op === op);
    if (next < 0) {
      throw new Error(
        `Expected fake YouTube order ${expected.join(' -> ')}; got ${log
          .map((entry) => entry.op)
          .join(' -> ')}`,
      );
    }
    cursor = next;
  }
}

/** Update transition behavior after navigation (for timeout/failure scenarios). */
export async function configureFakeYt(page: Page, options: FakeYtOptions): Promise<void> {
  await page.evaluate((next) => {
    const w = window as unknown as Record<string, unknown>;
    const current = (w.__fakeYtConfig as Record<string, unknown> | undefined) ?? {};
    Object.assign(current, next);
    w.__fakeYtConfig = current;
  }, options);
}

/** Read the latest fake player without exposing implementation fields to specs. */
export async function readFakeYtSnapshot(page: Page): Promise<FakeYtSnapshot | null> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const player = w.__fakeYtLastPlayer as { __snapshot?: () => FakeYtSnapshot } | undefined;
    return player?.__snapshot?.() ?? null;
  });
}

/** Deterministically inject state/clock/mute conditions into the latest fake player. */
export async function controlFakeYt(page: Page, control: FakeYtControl): Promise<void> {
  await page.evaluate((next) => {
    const w = window as unknown as Record<string, unknown>;
    const player = w.__fakeYtLastPlayer as
      | {
          __state: number;
          __currentTime: number;
          __duration: number;
          __videoId: string;
          __muted: boolean;
          __volume: number;
          __loadedFraction: number;
          __setState?: (state: number, emit?: boolean) => void;
          __setCurrentTime?: (time: number) => void;
        }
      | undefined;
    if (!player) throw new Error('Fake YouTube player is not available');
    if (typeof next.currentTime === 'number') {
      player.__setCurrentTime?.(next.currentTime);
      if (!player.__setCurrentTime) player.__currentTime = next.currentTime;
    }
    if (typeof next.duration === 'number') player.__duration = next.duration;
    if (typeof next.videoId === 'string') player.__videoId = next.videoId;
    if (typeof next.muted === 'boolean') player.__muted = next.muted;
    if (typeof next.volume === 'number') player.__volume = next.volume;
    if (typeof next.loadedFraction === 'number') player.__loadedFraction = next.loadedFraction;
    if (typeof next.state === 'number') {
      player.__setState?.(next.state, next.emitStateChange !== false);
      if (!player.__setState) player.__state = next.state;
    }
  }, control);
}
