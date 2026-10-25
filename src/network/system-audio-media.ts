/**
 * MUSIXQUARE — System Audio Media Tuning
 *
 * The media and timing home of the system-audio routes (registry RO-04): the
 * receivers' playout-delay hint, the stereo senders' bitrate and music
 * constraints, and the Cloudflare Realtime values both SFU transports share.
 * The route adapters import it instead of keeping their own copies; the
 * resource-ownership guard (CHECK 10) keeps the hint and bitrate writes and
 * the Realtime STUN entry in this file.
 *
 * Deferred-only: every importer loads with the room session, so no eager
 * module may import it (vite.config.ts DEFERRED_ENTRY_MODULES).
 */

// ─── Receive ──────────────────────────────────────────────────────
//
// playoutDelayHint target for the WebRTC audio receivers. WebRTC's NetEq
// adapts each receiver's jitter buffer independently based on packet arrival
// pattern, so two guests in the same room drift in and out of phase with each
// other as their buffers grow/shrink at different times. Setting the same
// hint on every receiver nudges them all toward the same effective delay,
// narrowing the cross-device variance.
//
// Tuning rationale:
//   < 200ms — NetEq's natural adaptive range often exceeds this anyway, so
//             the hint doesn't cap anything and we get the same drift.
//   > 600ms — host pause/skip becomes obviously laggy on guests.
//   300-500ms — hint caps adaptation while keeping responsiveness acceptable.
//   500ms favors lower cross-device variance at the upper end of that range.
//
// The Standard direct call, the Standard SFU and the PRO SFU receivers use it;
// the PRO LAN-direct receiver sets no hint.
const SYSTEM_AUDIO_PLAYOUT_DELAY_S = 0.5;

/**
 * Pins one receiver to the shared playout-delay target when it carries an
 * audio track; any other receiver is left alone. playoutDelayHint is in the
 * WebRTC spec but not in TS's lib.dom yet. Chrome/Edge implement it; on
 * browsers that don't, the assignment is a no-op (still a regular property).
 */
export function applySystemAudioPlayoutDelay(receiver: RTCRtpReceiver): void {
  if (receiver.track?.kind !== 'audio') return;
  (receiver as RTCRtpReceiver & { playoutDelayHint?: number }).playoutDelayHint =
    SYSTEM_AUDIO_PLAYOUT_DELAY_S;
}

// ─── Send ─────────────────────────────────────────────────────────

// The former L/R contract allocated 128 kbps to each mono sender. A single
// stereo Opus sender carries both channels, so it keeps the same aggregate
// quality budget.
const SYSTEM_AUDIO_STEREO_MAX_BITRATE = 256_000;

/** Preserve music dynamics instead of applying microphone-oriented DSP. */
function relaxMusicTrackConstraints(track: MediaStreamTrack): void {
  try {
    void track
      .applyConstraints({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      })
      .catch(() => undefined);
  } catch {
    /* the browser does not expose sender-track constraints */
  }
}

/**
 * Caps the sender's first encoding at the stereo budget. Best effort: a
 * sender whose parameters cannot be read or set keeps the browser's bitrate,
 * and a missing encoding list becomes one encoding. A sender that lists no
 * encoding has nothing to cap: the music senders then leave its parameters
 * alone, while the PRO LAN-direct sender still sets them back unchanged.
 */
function capStereoBitrate(sender: RTCRtpSender, setWithoutEncoding: boolean): void {
  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings) parameters.encodings = [{}];
    const encoding = parameters.encodings[0];
    if (encoding) encoding.maxBitrate = SYSTEM_AUDIO_STEREO_MAX_BITRATE;
    else if (!setWithoutEncoding) return;
    void sender.setParameters(parameters).catch(() => undefined);
  } catch {
    /* optional sender tuning */
  }
}

/**
 * Tunes one music sender (the Standard direct call and both SFU publishers)
 * once: no microphone DSP on its track, and the stereo bitrate. Only a sender
 * with an audio track is tuned.
 */
export function tuneSystemAudioMusicSender(sender: RTCRtpSender): void {
  const track = sender.track;
  if (!track || track.kind !== 'audio') return;
  relaxMusicTrackConstraints(track);
  capStereoBitrate(sender, false);
}

/**
 * Tunes one PRO LAN-direct sender: the stereo bitrate only, never the music
 * constraints. An unreadable sender must not demote an otherwise local route.
 */
export function tuneSystemAudioLanDirectSender(sender: RTCRtpSender): void {
  capStereoBitrate(sender, true);
}

// ─── Cloudflare Realtime ──────────────────────────────────────────
//
// Shared by the Standard SFU (system-audio-sfu.ts) and PRO SFU
// (pro-system-audio-sfu.ts) transports. Their control clients stay separate
// (registry RO-39).

/** Cloudflare's STUN server, ahead of any TURN servers in an SFU peer connection. */
export const BASE_SFU_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
];
/** Deadline of one Realtime control request (and of the PRO TURN config fetch). */
export const SFU_CONTROL_REQUEST_TIMEOUT_MS = 15_000;
/** Largest Realtime control (or PRO TURN config) response body read. */
export const SFU_CONTROL_RESPONSE_MAX_BYTES = 1024 * 1024;
