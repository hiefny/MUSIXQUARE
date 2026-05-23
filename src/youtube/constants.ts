/**
 * MUSIXQUARE — YouTube Module Constants
 *
 * Centralizes all tunable parameters for the YouTube watch-together sync
 * protocol, iframe management, and playlist handling. Keeping these in one
 * place makes it obvious which numbers encode protocol contracts (e.g. the
 * 2-stage rendezvous delay the host and guest both depend on) versus which
 * are local heuristics (e.g. ad-detection threshold, buffer poll interval).
 *
 * Group the values by concern, not by file, so that a reviewer looking at
 * "rendezvous timing" sees the related host + guest numbers side by side.
 */

// ─── Sync Protocol Timing ─────────────────────────────────────────────
// Numbers shared across host (scheduleYtAutoSync) and guest
// (handleYouTubeState / guestRendezvousSync). Changing these without
// matching tweaks on the other side WILL break synchronization.

/** 1s lead the host uses when stamping hostPlayAt for late-join bootstrap. */
export const YT_AUTO_SYNC_MS = 1000;

/**
 * Stage-2 rendezvous broadcast delay in scheduleYtAutoSync.
 * Host fires YOUTUBE_STATE immediately, waits this long, then fires the
 * "precision" YOUTUBE_SYNC{isManual:true} so late-buffering guests re-align.
 */
export const STAGE2_RENDEZVOUS_BROADCAST_MS = 2000;

/** Rendezvous delay for sub-video / playlist-item track transitions — gives
 *  guests time to loadVideoById a different video before synced play fires. */
export const TRACK_TRANSITION_RENDEZVOUS_MS = 4000;

/** Host heartbeat interval (periodic YOUTUBE_SYNC drift broadcast). */
export const HEARTBEAT_INTERVAL_MS = 3000;

/** Minimum gap between `youtube:broadcast-sync` bus-event broadcasts.
 *  The heartbeat timer already throttles itself via HEARTBEAT_INTERVAL_MS,
 *  but this is a defense-in-depth floor in case other call sites
 *  (manual syncs, future additions) emit the event rapidly. */
export const BROADCAST_SYNC_MIN_INTERVAL_MS = 500;

/** UI poll interval (updateYouTubeUI — seekbar, title, crash detection). */
export const UI_LOOP_INTERVAL_MS = 500;

/** Duplicate-broadcast suppression window for onStateChange. Same state
 *  fired within this gap is treated as noise (PAUSED→BUFFERING→PLAYING). */
export const STATE_BROADCAST_DEDUP_MS = 300;

// ─── Drift Correction Cooldowns ──────────────────────────────────────
// Window during which handleYouTubeSync's periodic drift correction is
// suppressed so a scheduled action (seek+play) doesn't get fought by
// the very next heartbeat arriving a few hundred ms later.

/** Drift threshold (seconds) before handleYouTubeSync issues a corrective seek. */
export const DRIFT_SEEK_THRESHOLD_SEC = 3;

/** Extra cushion on top of waitMs after a scheduled play — keeps drift
 *  correction quiet until the player has settled post-playVideo. */
export const POST_SCHEDULED_ACTION_COOLDOWN_MS = 1500;

/** Fallback drift-suppress window used for short-wait / immediate /
 *  videoId-mismatch paths that don't have a precise wait computation. */
export const IMMEDIATE_ACTION_COOLDOWN_MS = 3000;

/** Drift suppression after loadVideoById/loadPlaylist in iframe.ts — long
 *  enough that the previous video's stale heartbeat can't wake the guest
 *  into playing from position 0 before YOUTUBE_STATE arrives. */
export const LOAD_DRIFT_SUPPRESS_MS = 5000;

/** Threshold (ms) separating "short wait" from "auto-sync wait" branches
 *  in handleYouTubeState. Below it we use compensated-time seek+play;
 *  above it we pause the guest and use the full rendezvous sequence. */
export const SHORT_WAIT_THRESHOLD_MS = 300;

/** Upper cap for handleYouTubeState's auto-sync branch. Above this, the
 *  rendezvous has already expired and we fall through to executeImmediate. */
export const AUTO_SYNC_MAX_WAIT_MS = 3000;

/** Minimum delay applied after a videoId mismatch — gives loadVideoById
 *  enough time to reach CUED before we fire the scheduled playVideo. */
export const MISMATCH_MIN_WAIT_MS = 500;

/** Guest-side fallback after "pause-seek" in executeImmediate — play fires
 *  this long after pauseVideo+seekTo to let YouTube commit the seek. */
export const SEEK_PLAY_GAP_MS = 150;

// ─── Rendezvous Sync (Guest SMPTE-style) ─────────────────────────────

/** Seek-ahead margin — target = hostPosNow + MARGIN for buffer headroom. */
export const RENDEZVOUS_MARGIN_SEC = 1.5;

/** Max age of a host snapshot (stale heartbeats are rejected as no-data). */
export const RENDEZVOUS_SNAPSHOT_MAX_AGE_MS = 10_000;

/** Cooldown between rendezvous calls — rapid-fire crashes the YT iframe. */
export const RENDEZVOUS_COOLDOWN_MS = 3000;

/** Retry cadence when a manual/late-join rendezvous arrives before iframe readiness. */
export const MANUAL_RENDEZVOUS_RETRY_MS = 250;

/** Maximum window to keep a deferred manual/late-join rendezvous alive. */
export const MANUAL_RENDEZVOUS_RETRY_MAX_MS = 6000;

/** Buffer-check poll interval (setManagedTimer) during the pause-and-wait phase. */
export const RENDEZVOUS_BUFFER_CHECK_INTERVAL_MS = 50;

/** Max buffer polls before we declare the rendezvous timed out. */
export const RENDEZVOUS_BUFFER_MAX_CHECKS = 100;

/** Offset subtracted from the buffer deadline so we still have time to fire
 *  playVideo() before the target host-clock instant passes. */
export const RENDEZVOUS_BUFFER_DEADLINE_OFFSET_MS = 150;

/** Delay after playVideo before measuring drift for EMA calibration. */
export const RENDEZVOUS_CALIBRATE_DELAY_MS = 800;

/** Drift suppression cushion on top of MARGIN for the rendezvous's own play. */
export const RENDEZVOUS_DRIFT_SUPPRESS_MS = 2000;

// ─── Latency EMA Calibration ─────────────────────────────────────────
// Self-calibration of the guest's playVideo → audible-start latency using
// drift measurements from successful rendezvous.

/** Learning rate for the EMA update (0.3 = 30% weight on each new sample). */
export const LATENCY_EMA_RATE = 0.3;

/** Android no longer gets a platform default; rendezvous calibration handles it. */
export const ANDROID_YOUTUBE_PLAY_LATENCY_FLOOR_MS = 0;

/** Clamp max — anything beyond this is unrealistic for playVideo() latency. */
export const LATENCY_CLAMP_MAX_MS = 600;

/** Outlier cutoff — drift samples larger than this are ignored (buffering /
 *  seek in progress / ad produces huge driftMs that would corrupt the EMA). */
export const LATENCY_OUTLIER_REJECT_MS = 2000;

// ─── Host-Ad Detection (Guest-side) ──────────────────────────────────

/** Number of consecutive stale heartbeat frames before declaring a host ad.
 *  N × HEARTBEAT_INTERVAL_MS = detection window (default: 3 × 3s = 9s). */
export const HOST_AD_STALE_THRESHOLD = 3;

/** Max drift between two consecutive host positions to still count as "stale".
 *  Frame-to-frame host movement smaller than this is interpreted as an ad
 *  freezing the host's playback at roughly the same timestamp. */
export const HOST_AD_STALE_DIFF_SEC = 1.0;

// ─── Iframe Health & iOS ─────────────────────────────────────────────

/** iOS watchdog — if the player stays UNSTARTED this long, show the tap-to-play
 *  overlay so the user can satisfy the iOS gesture requirement. */
export const IOS_WATCHDOG_MS = 3000;

/** Unavailable-video heuristic — if the host's player sits in a non-playing
 *  state (UNSTARTED / CUED / BUFFERING) for this long without recovering AND
 *  none of the legitimate-stall exceptions apply (iOS gate, tab hidden,
 *  playlist scraping), treat the video as unplayable and auto-skip. Covers
 *  the region-lock / age-gate cases where YouTube renders an error UI inside
 *  the iframe but never fires onError through the API.
 *  Chosen conservatively (18s) so slow networks and preroll-ad buffering
 *  won't false-trigger. Ads are PLAYING-state so they never reach here. */
export const UNAVAILABLE_STUCK_THRESHOLD_MS = 18000;

/** Number of consecutive getCurrentTime() throws before we assume the iframe
 *  has crashed (sad-face icon) and rebuild the player.
 *  N × UI_LOOP_INTERVAL_MS = detection window (default: 6 × 500ms = 3s). */
export const CRASH_FAIL_THRESHOLD = 6;

/** YouTube API script load timeout — guards against infinite "loading..." UI. */
export const SCRIPT_LOAD_TIMEOUT_MS = 15000;

/** Display-refresh hack delay — forces a reflow after iframe creation to
 *  avoid the "black frame" bug on some browsers. */
export const REFRESH_DISPLAY_DELAY_MS = 500;

/** Guest ENDED-fallback — if the host doesn't send a next-track command
 *  within this window, the guest transitions to IDLE on its own. */
export const GUEST_ENDED_FALLBACK_MS = 5000;

// ─── Playlist / Sub-Item Data ────────────────────────────────────────

/** Delay after player-ready before snapshotting the iframe's internal
 *  queue. YouTube populates getPlaylist() lazily; too-early snapshots
 *  return [] or a single-element "current video" array. */
export const PLAYLIST_SNAPSHOT_DELAY_MS = 3500;

/** Aggressive first-track fisher interval — catches the first video_id
 *  from an RD (Mix) playlist the moment it's available. */
export const FIRST_TRACK_FISHER_INTERVAL_MS = 100;

/** Max fisher polls before giving up (2s ceiling at FIRST_TRACK_FISHER_INTERVAL_MS). */
export const FIRST_TRACK_FISHER_MAX_POLLS = 20;

/** getVideoData() cross-iframe poll frequency: every Nth UI tick.
 *  Calling it on every tick is a major memory-pressure contributor on
 *  weaker devices, so we batch it — N × UI_LOOP_INTERVAL_MS = ~5s. */
export const VIDEO_DATA_POLL_EVERY_NTH_TICK = 10;

/** Duration-cache commit threshold. getDuration() jitters by ±0.01s even
 *  on a stable video; ignore deltas smaller than this to reduce state churn. */
export const DURATION_CACHE_EPSILON = 0.05;

/** Threshold (seconds) for try-prev-internal: below it, restart current
 *  video instead of navigating to the previous sub-video (standard music-
 *  player UX: "back" means "restart" if > 3s into the track). */
export const PREV_TRACK_RESTART_THRESHOLD_SEC = 3;

// ─── oEmbed Title Fetch ──────────────────────────────────────────────

export const OEMBED_CACHE_MAX = 100;
export const OEMBED_CACHE_TTL_MS = 30 * 60 * 1000;
export const OEMBED_FETCH_TIMEOUT_MS = 5000;

/** Initial-phase threshold in fetchPlaylistSubTitles: first N items are
 *  flushed one-by-one (fast UI feedback); after N we batch to amortize. */
export const OEMBED_INITIAL_BATCH_SIZE = 10;

/** Throttle between oEmbed calls during the low-priority background phase. */
export const OEMBED_BACKGROUND_THROTTLE_MS = 800;

/** Debounce before the URL-input oEmbed preview fires (user is still typing). */
export const OEMBED_PREVIEW_DEBOUNCE_MS = 500;
