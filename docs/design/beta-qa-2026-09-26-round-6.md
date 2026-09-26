# Beta QA — 2026-09-26, round 6

Baseline: `mxqr_beta` at `48ad9c84`. Scope: pending system-audio capture,
source and demo transitions, bounded/native engine replacement, native media
controls, manual-sync availability, and background output recovery. Work stays
on beta without a production deployment or app/cache version change.

## Confirmed finding

An earlier system-audio request could take over playback after a newer track
had already been selected. Two real asynchronous boundaries permit this:

- While the browser's display picker is open, another room administrator can
  select a new track remotely.
- After the picker closes, audio initialization can still await the native
  AudioContext. The local user can select a different track during that wait.

The pending request checked capture cancellation, room identity, and authority,
but not the newer playback load. Before the stream becomes active, the normal
transport force-stop check cannot see it as an active system-audio source.
Consequently, the old request could finish initialization, stop the successor,
and replace its metadata with system audio.

The request now captures the existing playback load epoch and checks it after
picker, PRO lease, and initialization waits, before stopping previous media.
A superseded request releases its stream and lease without a stale failure
toast. The check deliberately stops before capture's own transport STOP, which
advances that epoch as part of a valid start. No new global counter, UI, retry
policy, or transport protocol was introduced.

Demo entry also invalidates the same load epoch through its existing media
teardown. Review traced the accessible Help/Take a Tour path after the picker
closes; no additional demo-specific cancellation mechanism was needed.

## Reproduction and review

- The initial unit regression called the real `playTrack` while capture audio
  initialization was pending. Before correction, the expected successor video
  metadata was lost. After correction, four variants cover picker/initialization
  success and failure, including resource release and absence of stale
  stop/toast events.
- A fifth regression uses the actual `stopAllMediaAsync` implementation to
  verify valid capture survives its own epoch advance and native track-end
  restores the prior media.
- The browser regression grants a guest administrator rights, holds the host's
  picker Promise, selects a different YouTube row from the guest, and confirms
  both peers have accepted it before releasing the picker. On the baseline,
  the capture remained active instead of being discarded. The fixture uses
  real synthetic MediaStreamTracks and holds only the picker completion.
- Independent review checked epoch ownership, stream cleanup, obsolete error
  handling, PRO publication, and deferred file-broadcast disposition. The
  existing suspension token still resumes only the latest valid file payload.

## Other investigation

- Demo exit/re-entry, late downloads, room/control ownership, and restored
  settings: four focused suites, **99 passed**. No separate demo defect found.
- Native/bounded source replacement, delayed PCM, worker errors, and decoder
  disposal: seven focused suites, **154 passed**. Five additional exploratory
  cases combined real bounded resources with delayed prepare/retirement and
  replacement by a native buffer; all passed. No engine change was needed.
- Native media controls, local output rejoin, manual-sync editor, and background
  recovery: five focused suites, **133 passed**. No additional defect confirmed.
- Corrected capture selection: five focused suites, **149 passed**.

## Verification

- The new browser regression failed on the baseline and passed after rebuilding
  the corrected source. Final Chromium selection: **15 passed**, including
  capture takeover/cleanup, normal sharing, administrator grant/revoke, demo
  recovery, and background recovery.
- Baseline browser selections passed **23 cases**, including 14 common-start
  and hybrid-engine transition cases. With the final selection, this is **38
  successful executions of 29 distinct browser cases**.
- Full repository typecheck and lint passed. The finalized browser regression
  also passed its E2E typecheck, file lint, and formatting checks. Import graph,
  dead exports, bus pairing, lifecycle writes, source complexity, and
  room-authority boundary guards passed without changes to their baselines.
- Final full unit suite: **464 files, 9,679 passed, 1 skipped**, including five
  new regressions. The existing release-deployment-state case needs `jq`, which
  is unavailable in this Windows environment; CI does not permit that skip.
- Local production-mode build and eight artifact guards passed: test-hook
  exclusion, security configuration, legacy TV syntax, service worker, UI kit,
  transfer budget, fonts, and app-shell completeness. App `8.6.61` and cache
  `v630` are unchanged; this build check did not deploy production.

## Limits

Browser verification uses local Chromium and signaling, controlled YouTube
frames, and synthetic system-audio tracks. It does not validate actual native
picker UI, live YouTube/Cloudflare transport, physical-device audio alignment,
or iPhone-specific browser behavior. Unit tests deliberately defer real async
API boundaries; they do not establish how frequently the race occurs in use.
Beta pushes do not trigger the main-only CI workflow or deploy production.
