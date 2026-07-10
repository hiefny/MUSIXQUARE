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

/** Script content injected into every page before navigation. */
const FAKE_YT_INIT = `
(function() {
  'use strict';
  if (window.__fakeYtInstalled) return;
  window.__fakeYtInstalled = true;
  window.__fakeYtLog = [];
  window.__fakeYtInstanceId = 0;

  function pushLog(op, args) {
    window.__fakeYtLog.push({ op: op, args: args, at: Date.now() });
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

    self.playVideo = function() {
      if (self.__destroyed) return;
      pushLog('playVideo');
      self.__state = 1;
      // onStateChange fires after a microtask to match real IFrame behavior
      setTimeout(function() {
        if (self.__events.onStateChange) {
          self.__events.onStateChange({ data: 1, target: self });
        }
      }, 0);
    };
    self.pauseVideo = function() {
      if (self.__destroyed) return;
      pushLog('pauseVideo');
      self.__state = 2;
      setTimeout(function() {
        if (self.__events.onStateChange) {
          self.__events.onStateChange({ data: 2, target: self });
        }
      }, 0);
    };
    self.stopVideo = function() {
      if (self.__destroyed) return;
      pushLog('stopVideo');
      self.__state = 0;
    };
    self.seekTo = function(t, allowAhead) {
      if (self.__destroyed) return;
      pushLog('seekTo', [t, allowAhead]);
      self.__currentTime = t;
    };
    self.loadVideoById = function(id) {
      if (self.__destroyed) return;
      pushLog('loadVideoById', [id]);
      self.__videoId = typeof id === 'string' ? id : (id && id.videoId) || self.__videoId;
      self.__currentTime = 0;
    };
    self.loadPlaylist = function(playlist, idx, start) {
      if (self.__destroyed) return;
      pushLog('loadPlaylist', [playlist, idx, start]);
      if (Array.isArray(playlist)) {
        self.__playlist = playlist;
      } else if (playlist && playlist.list) {
        self.__playlist = [playlist.list];
      }
      self.__playlistIdx = idx || 0;
    };
    self.playVideoAt = function(idx) {
      if (self.__destroyed) return;
      pushLog('playVideoAt', [idx]);
      self.__playlistIdx = idx;
    };
    self.nextVideo = function() {
      pushLog('nextVideo');
      self.__playlistIdx = Math.min(self.__playlistIdx + 1, self.__playlist.length - 1);
    };
    self.previousVideo = function() {
      pushLog('previousVideo');
      self.__playlistIdx = Math.max(self.__playlistIdx - 1, 0);
    };
    self.setVolume = function(v) { pushLog('setVolume', [v]); };
    self.mute = function() { pushLog('mute'); };
    self.unMute = function() { pushLog('unMute'); };
    self.isMuted = function() { return false; };
    self.destroy = function() {
      pushLog('destroy');
      self.__destroyed = true;
    };

    // Getters — these are NOT logged to keep __fakeYtLog focused on mutations
    self.getPlayerState = function() { return self.__state; };
    self.getCurrentTime = function() { return self.__currentTime; };
    self.getDuration = function() { return self.__duration; };
    self.getVideoData = function() { return { video_id: self.__videoId, title: 'Fake Title' }; };
    self.getPlaylistIndex = function() { return self.__playlistIdx; };
    self.getPlaylist = function() { return self.__playlist; };
    self.getVolume = function() { return 100; };
    self.getIframe = function() { return document.createElement('div'); };
    self.getVideoLoadedFraction = function() { return 1.0; };

    // Track the latest instance for the test helper
    window.__fakeYtLastPlayer = self;

    // Fire onReady after a short delay to match real IFrame lazy init
    setTimeout(function() {
      if (self.__destroyed) return;
      if (self.__events.onReady) {
        self.__events.onReady({ target: self });
      }
      // Immediately transition to CUED → tracks what real player does
      // after onReady for a videoId-only constructor.
      self.__state = 5;
      setTimeout(function() {
        if (self.__destroyed || !self.__events.onStateChange) return;
        self.__events.onStateChange({ data: 5, target: self });
      }, 5);
    }, 20);
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
export async function installFakeYt(page: Page): Promise<void> {
  await page.addInitScript({ content: FAKE_YT_INIT });
  // Route interception is a safety net for any loader path that bypasses the
  // preinstalled stub.
  await page.route(/youtube\.com\/iframe_api/, (route) => route.abort());
}

/**
 * Read the fake YT call log from a page.
 * Returns array of { op, args, at } entries.
 */
export async function readFakeYtLog(page: Page): Promise<Array<{ op: string; args?: unknown[]; at: number }>> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return (w.__fakeYtLog as Array<{ op: string; args?: unknown[]; at: number }>) || [];
  });
}

/** Clear the fake YT call log on a page. */
export async function clearFakeYtLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__fakeYtLog = [];
  });
}
