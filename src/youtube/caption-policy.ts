/**
 * Best-effort caption policy for the embedded YouTube player.
 *
 * The public IFrame API has no supported "captions off" command. Some player
 * builds expose an undocumented `captions.track` option, so we may ask those
 * builds to clear it. `captions.fontSize = -1` is the documented fallback and
 * keeps captions at YouTube's smallest supported size when clearing the track
 * is ignored.
 *
 * This module deliberately has no playback methods in its surface: caption
 * compatibility must never mutate room authority, play/pause, or seek state.
 */

interface YouTubeCaptionPolicyPlayer {
  getOptions?(module?: string): string[];
  getOption?(module: string, option: string): unknown;
  setOption?(module: string, option: string, value: unknown): void;
  getVideoData?(): { video_id?: string };
}

type YouTubeCaptionPolicyResult = 'applied' | 'already-applied' | 'unavailable' | 'failed';

const CAPTIONS_MODULE = 'captions';
const appliedKeys = new WeakMap<YouTubeCaptionPolicyPlayer, string>();
const applyingPlayers = new WeakSet<YouTubeCaptionPolicyPlayer>();

function readVideoId(player: YouTubeCaptionPolicyPlayer): string {
  try {
    return player.getVideoData?.()?.video_id || '';
  } catch {
    return '';
  }
}

function readTrackState(player: YouTubeCaptionPolicyPlayer): {
  active: boolean | null;
  signature: string;
} {
  if (!player.getOption) return { active: null, signature: 'unknown' };

  try {
    const value = player.getOption(CAPTIONS_MODULE, 'track');
    if (value == null || value === '') return { active: false, signature: 'none' };
    if (typeof value !== 'object') return { active: true, signature: String(value) };

    const record = value as Record<string, unknown>;
    const fields = ['id', 'languageCode', 'kind', 'vss_id', 'name']
      .map((field) => (typeof record[field] === 'string' ? record[field] : ''))
      .join('|');
    const active = Object.keys(record).length > 0;
    return { active, signature: active ? fields || 'active' : 'none' };
  } catch {
    return { active: null, signature: 'unknown' };
  }
}

/**
 * Ask a live YouTube player to hide captions when its runtime supports the
 * legacy option, while independently applying the supported minimum size.
 */
export function applyYouTubeCaptionPolicy(
  player: YouTubeCaptionPolicyPlayer,
  sessionId: number,
): YouTubeCaptionPolicyResult {
  if (!player.getOptions || !player.setOption) return 'unavailable';

  let modules: string[];
  let options: string[];
  try {
    modules = player.getOptions();
    if (!Array.isArray(modules) || !modules.includes(CAPTIONS_MODULE)) {
      // YouTube unloads and reloads modules between some persistent-player
      // transitions. Forget the prior key so the next load can be handled.
      appliedKeys.delete(player);
      return 'unavailable';
    }
    options = player.getOptions(CAPTIONS_MODULE);
  } catch {
    return 'unavailable';
  }

  if (!Array.isArray(options) || options.length === 0) {
    appliedKeys.delete(player);
    return 'unavailable';
  }

  const supportedOptions = [...options].sort();
  const track = readTrackState(player);
  const key = [sessionId, readVideoId(player), supportedOptions.join(','), track.signature].join(
    '\u0000',
  );
  if (appliedKeys.get(player) === key || applyingPlayers.has(player)) return 'already-applied';

  // Set the key before calling into the third-party API. A player build may
  // synchronously emit onApiChange from setOption; that callback must not
  // recurse into the policy indefinitely.
  appliedKeys.set(player, key);
  applyingPlayers.add(player);

  let applied = false;
  try {
    if (supportedOptions.includes('track') && track.active !== false) {
      try {
        // Undocumented and explicitly best-effort. Current player builds may
        // accept this call but ignore it, hence the independent font fallback.
        player.setOption(CAPTIONS_MODULE, 'track', {});
        applied = true;
      } catch {
        /* continue to the supported fallback */
      }
    }

    if (supportedOptions.includes('fontSize')) {
      try {
        // Official IFrame API range is -1..3; -1 is the smallest caption size.
        player.setOption(CAPTIONS_MODULE, 'fontSize', -1);
        applied = true;
      } catch {
        /* best-effort compatibility policy */
      }
    }
  } finally {
    applyingPlayers.delete(player);
  }

  return applied ? 'applied' : 'failed';
}
