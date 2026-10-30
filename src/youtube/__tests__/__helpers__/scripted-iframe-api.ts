/**
 * A scripted YouTube IFrame API for suites that run the real iframe module
 * (youtube/iframe.ts) instead of injecting a player into youtube/_state.ts.
 *
 * Factories only. This module declares no vi.mock and keeps no state between
 * calls: every module mock stays in the test file that needs it, and the
 * caller undoes the YT global with vi.unstubAllGlobals() in its afterEach.
 *
 * Each YT.Player the App constructs becomes a fake from makeFakeYtPlayer. As
 * with the real API, the player methods appear only when the iframe
 * handshake completes: until ready() is called the instance is a facade
 * without them, and ready() then fires the App's onReady. The `init` option
 * reaches every iframe the App creates, so a fault knob of fake-yt-player.ts
 * applies to an iframe the test never constructs itself.
 *
 * pro-late-prepare-reload.test.ts still carries the first copy of this API;
 * it moves to this helper once that suite's pull request has merged.
 */
import { vi } from 'vitest';
import { bus } from '../../../core/events.ts';
import { setState } from '../../../core/state.ts';
import { setPlaybackYouTubePaused } from '../../../player/ownership.ts';
import type { QueueItemId } from '../../../types/index.ts';
import { makeFakeYtPlayer, type FakeYtPlayer } from './fake-yt-player.ts';

/** The player API a real IFrame API player gains only when its iframe handshake completes. */
const IFRAME_API_METHODS = [
  'playVideo',
  'pauseVideo',
  'stopVideo',
  'seekTo',
  'cueVideoById',
  'loadVideoById',
  'nextVideo',
  'previousVideo',
  'setVolume',
  'mute',
  'unMute',
  'isMuted',
  'getPlayerState',
  'getCurrentTime',
  'getDuration',
  'getVideoData',
  'getPlaylistIndex',
  'getPlaylist',
  'getVolume',
  'getVideoLoadedFraction',
] as const;

export interface ScriptedIframe {
  readonly fake: FakeYtPlayer;
  /** The videoId the App passed to the YT.Player constructor ('' for none). */
  readonly videoId: string;
  /** Completes the iframe handshake: the API appears and onReady fires. */
  ready(): void;
}

export type ScriptedIframeInit =
  Partial<FakeYtPlayer> | ((index: number, videoId: string) => Partial<FakeYtPlayer>);

export interface ScriptedIframeApi {
  readonly iframes: ScriptedIframe[];
  readonly Player: ReturnType<typeof vi.fn>;
}

interface ScriptedPlayerOptions {
  videoId?: string;
  events: {
    onReady: (event: { target: unknown }) => void;
    onStateChange: (event: { data: number; target: unknown }) => void;
  };
}

/**
 * Stub the YT namespace with a scripted Player constructor. By default each
 * iframe starts CUED at 0 s of a 240 s video with the fake's clock running,
 * the late-join suite's setup; `init` overrides or extends that per iframe.
 */
export function installScriptedIframeApi(init: ScriptedIframeInit = {}): ScriptedIframeApi {
  const iframes: ScriptedIframe[] = [];
  const Player = vi.fn(function (_element: string, options: ScriptedPlayerOptions) {
    const videoId = options.videoId ?? '';
    const extra = typeof init === 'function' ? init(iframes.length, videoId) : init;
    const fake = makeFakeYtPlayer({
      __videoId: videoId,
      __state: 5,
      __duration: 240,
      __advanceClock: true,
      ...extra,
    });
    const api = Object.fromEntries(IFRAME_API_METHODS.map((name) => [name, fake[name]]));
    for (const name of IFRAME_API_METHODS) Reflect.deleteProperty(fake, name);
    fake.__onStateChange = options.events.onStateChange;
    iframes.push({
      fake,
      videoId,
      ready: () => {
        Object.assign(fake, api);
        options.events.onReady({ target: fake });
      },
    });
    return fake;
  });
  vi.stubGlobal('YT', {
    Player,
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  });
  return { iframes, Player };
}

/**
 * Load one queue occurrence the App's way (youtube:load) and complete the
 * new iframe's handshake, so the device already shows the video, ready and
 * paused at positionSeconds. Returns the ready fake. The caller clears any
 * toast mock afterwards if its rows count toasts.
 */
export async function loadResidentIframe(
  api: ScriptedIframeApi,
  occurrence: { queueItemId: QueueItemId; videoId: string; positionSeconds: number },
): Promise<FakeYtPlayer> {
  setState('playlist.currentQueueItemId', occurrence.queueItemId);
  bus.emit('youtube:load', occurrence.videoId, null, occurrence.queueItemId, false, 0);
  const iframe = api.iframes.at(-1);
  if (!iframe) throw new Error('youtube:load built no scripted iframe');
  iframe.ready();
  iframe.fake.__currentTime = occurrence.positionSeconds;
  iframe.fake.__setState(2, false);
  setPlaybackYouTubePaused();
  await vi.advanceTimersByTimeAsync(0);
  return iframe.fake;
}
