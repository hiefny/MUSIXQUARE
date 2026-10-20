# Documentation Hub

| Field              | Value                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| Status             | Maintained index                                                      |
| Applies to         | Repository documentation and its lifecycle classification             |
| Last source review | 2026-10-13                                                            |
| Governance         | [Documentation governance](documentation-governance.md)               |
| Latest audit       | [Documentation audit — 2026-08-30](documentation-audit-2026-08-30.md) |

Use this hub to choose the current contract before following a dated audit or
prototype. “Maintained” means the document is intended to describe the present
repository boundary; it does not mean that a checked-in expectation proves the
live provider dashboard matches it.

## Start here

| Need                                      | Primary reference                                               | Then read                                                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Run or contribute locally                 | [Contributor guide](../CONTRIBUTING.md)                         | [Configuration reference](configuration-reference.md), [Local Worker integration](local-worker-integration.md)                              |
| Understand the product architecture       | [Root overview](../README.md)                                   | [Account/room authority](design/account-identity-and-room-authority.md), [PRO architecture](design/pro-room-architecture-and-operations.md) |
| Prepare or recover a production change    | [Production hotfix and rollback](hotfix-procedure.md)           | [Release versioning](release-versioning.md), [Runtime verification](runtime-scenario-verification-2026-05-31.md)                            |
| Check current production state            | [Release record](release-record.md)                             | [Release history](release-history.md), [production hotfix and rollback](hotfix-procedure.md)                                                |
| Operate Cloudflare services               | [Configuration drift checks](../cloudflare/config-drift-ops.md) | Owning Worker runbook below                                                                                                                 |
| Review intentional tradeoffs              | [Known and accepted risks](known-accepted.md)                   | Owning ADR and [security/performance policy](security-performance-tier-policy.md)                                                           |
| Decide whether an old document is current | [Documentation governance](documentation-governance.md)         | [Latest documentation audit](documentation-audit-2026-08-30.md)                                                                             |

## Maintained architecture and accepted decisions

These documents define current ownership or an accepted decision. Amend or
supersede them explicitly when the product boundary changes.

- [Account identity and room authority](design/account-identity-and-room-authority.md)
- [PRO room architecture and operations](design/pro-room-architecture-and-operations.md)
- [Coordinator-free PRO server authority](design/pro-room-server-authority.md)
- [Realtime runtime ownership](design/realtime-runtime-ownership.md)
- [Signaling liveness](design/signaling-liveness.md)
- [Static asset delivery and PRO heartbeat persistence](design/static-assets-and-pro-heartbeat-optimization.md)
- [Initial bundle and lazy-loading policy](design/initial-bundle-loading-policy.md)
- [Browser media storage policy](design/browser-media-storage-policy.md)
- [Playback concurrency invariants](design/playback-concurrency-invariants.md)
- [Queue item identity and reorder](design/queue-item-identity-and-reorder.md)
- [Source complexity safety limits](design/source-complexity-ratchet.md)
- [Mobile application zoom policy](mobile-app-zoom-policy.md)
- [Security and hot-path performance policy](security-performance-tier-policy.md)
- [Known and accepted risks](known-accepted.md)

## Maintained operations and release runbooks

Before QA or a production release, start with the
[release record](release-record.md). It holds the current deployed state, open
checks, and release rules; the append-only [release history](release-history.md)
lists every production release since 8.6.61 (2026-09-20); earlier runs are
queried from GitHub Actions. Plan QA scope with the
[QA domains guide](qa-domains.md). Neither record replaces the canonical
release procedure.

| Boundary                        | Current runbooks                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release, recovery, and identity | [Production hotfix and rollback](hotfix-procedure.md), [release versioning](release-versioning.md), [runtime verification](runtime-scenario-verification-2026-05-31.md)      |
| Configuration and local routing | [Configuration reference](configuration-reference.md), [Local Worker integration](local-worker-integration.md), [Cloudflare drift checks](../cloudflare/config-drift-ops.md) |
| App, accounts, and admin        | [Account authentication](account-auth-operations.md), [admin access](admin-access.md), [admin dashboard operations](../cloudflare/admin-dashboard-ops.md)                    |
| Standard rooms                  | [Signaling liveness](design/signaling-liveness.md), [Standard-room PIN operations](../cloudflare/standard-room-pin-ops.md)                                                   |
| PRO rooms                       | [PRO architecture and operations](design/pro-room-architecture-and-operations.md), [server authority](design/pro-room-server-authority.md)                                   |
| Remote Share                    | [Remote Share operations](../cloudflare/remote-share-ops.md)                                                                                                                 |
| Developer API                   | [OpenAPI contract](../public/developers/openapi.yaml), [Cloudflare drift checks](../cloudflare/config-drift-ops.md)                                                          |

The six production Worker Wrangler configs and checked-in manifests remain the
decisive non-secret binding/schema inventories. Worker runtime secret-name
expectations are single-sourced in
[`cloudflare/ops-drift.contract.json`](../cloudflare/ops-drift.contract.json),
while workflow and operator credentials remain owned by their workflows and
runbooks. Neither belongs in a general setup document.

## Maintained engineering guides and contracts

- [Whole-project QA domains](qa-domains.md) — 30 domains and 122
  detailed scopes with criteria, source/test entry points, verification methods,
  and cross-feature sequences. This is a QA planning guide, not new pass evidence.
- [Playback state consumption](state-patterns.md)
- [AppState decomposition and surviving contract](appstate-decomposition.md)
- [System sync compensation](system-sync-compensation.md)
- [Repository-wide TypeScript migration](typescript-migration/README.md)
- [Translation guide](i18n-translation-guide.md)
- [Reusable migration audit prompt](migration-audit-prompt.md)
- [Developer API OpenAPI contract](../public/developers/openapi.yaml)
- [Font assets and verification](../fonts/README.md)
- [Public design-system guide](../public/designsystem/README.md)
- [Third-party runtime notices](../THIRD-PARTY-NOTICES.md)

## Maintained evidence and completed records

- [Playlist delete mode with an Undo window — 2026-10-20](design/playlist-delete-mode-undo-2026-10-20.md) —
  selecting rows turns the playlist title into the selected count with one Select all / Deselect all text button,
  and a blue Delete and grey Cancel pill replace the icon pill; tapping outside the list or changing tabs ends the
  mode. Delete hides the rows and morphs into an Undo pill for 3 s before `playlist:remove-tracks` runs. Three new
  keys use WordPress core translations in 42 locales. Unit, lint and screenshot checks pass; e2e not run.
- [Skip link translation — 2026-10-20](design/skip-link-translation-2026-10-20.md) —
  the keyboard skip link at the top of the app read "Skip to content" in English for all 42 locales; 8.11.31 binds
  it to `common.skip_to_content`, using the WordPress community translation of the same source string (theme
  first, core where the theme has none), with Wikipedia's "Jump to content" listed for comparison.
- [Editorial header label and redeem hint centering — 2026-10-20](design/editorial-header-and-redeem-hint-2026-10-20.md) —
  the History header said "Open app" after its 2026-08-23 rebuild while every other editorial header said "Try it
  now", and 8.11.30 matches it; the event page's redeem code hint sat 1.5–2.5 px low in Chromium, which draws the
  placeholder on the larger typed text's baseline, so the empty field now uses the hint's size (within half a pixel
  of center in Chromium and WebKit). Contract tests pin both.
- [Standard HTTPS bridge failure diagnostics — 2026-10-20](design/standard-signaling-bridge-diagnostics-2026-10-20.md) —
  after two 8.11.28 runs failed on a bare bridge-open 502, 8.11.29 makes the next one readable: the smoke prints
  role, status, allowlisted code, elapsed ms and Ray ID for any failed open/send/poll/close, and the App Worker logs
  one credential-free `standard_signaling_bridge` record per 5xx (operation, reason, upstream status and code,
  timing). The bridge object's own 502s, which the App passes through, are now told apart from App-side ones.
- [Welcome wordmark alignment — 2026-10-20](design/welcome-wordmark-alignment-2026-10-20.md) — the start
  screen wordmark is 5–12% taller than the greeting that replaces it in every layout, but only the 720–1279 px
  two-column layout left its top 2–3 px above the greeting; 8.11.28 lowers it by the phone layout's 3 px (top
  0–1 px below), after a size-scaled nudge sank the tablet mark too far.
- [Login window centering on short screens — 2026-10-20](design/login-dialog-centering-2026-10-20.md) — at
  480 px tall or less, such as a phone in landscape, the account and administrator-permissions windows stuck
  12 px from the top; 8.11.27 keeps them centered like every other dialog (844×390: 12 / 68.6 px → 40.3 /
  40.3 px), pinned by a contract test.
- [Login legal link order — 2026-10-20](design/login-legal-link-order-2026-10-20.md) — 8.11.26 lists the
  privacy policy before the terms in the login dialog, matching Google's account chooser; a markup contract test
  pins the order.
- [Stop Sharing icon and label centering — 2026-10-20](design/stop-sharing-centering-2026-10-20.md) —
  the stop square filled only the middle half of its icon box, so the visible icon and label sat 1.75–2.74 px
  right of center; 8.11.25 crops the icon box to the square with the same size and visible gap (−0.75–0 px),
  pinned by the critical layout probe for 42 locales, both directions and 200% text.
- [Preload resume after an ICE interruption — 2026-10-20](design/preload-resume-after-ice-recovery-2026-10-20.md) —
  8.11.25 pauses an interrupted preload lane instead of aborting it and restarts it from chunk 0 with
  `restart: true` when the same connection recovers; the guest releases a live partial session; PeerJS
  keeps the immediate abort. Native scenario (c): `ad900e0e` 5/5 and final `c73a52e1` 3/3 exact completions
  after 10 s and 17 s cuts; baseline `2e7d6416` 0/2; the host-only first candidate failed 1/4 on a live
  guest session; one final run lost its C3 reading to a pre-cut OS media pause.
- [Side-PC ICE restart independent verification — 2026-10-20](design/side-ice-restart-independent-verification-2026-10-20.md) —
  a separate session without the owner's field notes fixed its procedure first: 10 s outages keep both
  versions, side-PC `failed` at 17 s loses 8.11.23's session while `ee8dcd28` recovers, and 25 s ends both.
  Preload abort on disconnect is pre-existing; an IP change could not be emulated.
- [Isolated control side ICE restart — 2026-10-19](design/control-isolation-side-ice-restart-2026-10-19.md) — capability-gated bounded restart of the side PC over the original lane; unit and mutation evidence at `05551d1d`; native lab and independent verification pass on `ee8dcd28`; prepared as 8.11.24 (never deployed) and ships in 8.11.25.
- [Side-PC ICE restart native lab — 2026-10-19](design/side-ice-restart-native-lab-2026-10-19.md) — candidate `ee8dcd28` passes all five CDP P2P outage runs; production main closes on side PC failure; preload abort on disconnect is a separate pre-existing follow-up; real-device IP change and TURN remain.
- [Combined transport release — 2026-10-19](design/transport-release-bundle-2026-10-19.md) —
  8.11.23/v732 bundles #410 control isolation, the delay-based receipt window with its
  evidence bound and the transfer-time clock guard. Native round r1 passes the pre-fixed
  gates: high-RTT −33%, slow link +1.3%, collapse −21%, every control maximum under 1 s,
  zero unwanted playback corrections. Side-connection ICE restart is deferred.
- [Transfer-time clock asymmetry guard — 2026-10-19](design/transfer-clock-sync-guard-2026-10-19.md) —
  keeps the quiet min-RTT clock sample for its 120 s age, gates local-file soft resync like
  YouTube auto realignment, and restores a corroborated clock after a forced re-lock;
  unit evidence here, native evidence in the combined release record.
- [Container-native shaped A/B — 2026-10-19](design/native-shaped-credit-ab-2026-10-19.md) —
  B128, SA192 and the delay-based window through a packet-level bottleneck with Chromium 141:
  8 Mbps 61–67 / 36.6 / 27.0 s, 2 Mbps unchanged, and the 8→2 collapse transient. Not the
  team's frozen native contract.
- [Delay-based receipt window candidate — 2026-10-19](design/delay-based-credit-window-2026-10-19.md) —
  experimental replacement for #410's A192 sender policy: one-chunk growth while the
  measured credit loop shows no added queueing, a 2 s / 16-chunk evidence bound above
  128 KiB, deterministic path-model results and the model's sudden-collapse limit. Not
  native evidence or a release record.
- [Product control isolation — 2026-10-19](design/control-isolation-product-integration-2026-10-19.md) —
  product negotiation, ordered handoff, compatibility, reconnect and bounded
  adaptive credit; resumed C9 qualification passes preload, mixed versions,
  user-operated reconnect and shared uplink checks. Deployment remains withheld;
  preserved failures, measurement limits and separate-candidate review are included.
- [Control association isolation — 2026-10-19](design/control-association-isolation-2026-10-19.md) —
  sequential native transport investigation, with a separate control SCTP
  association and fixed/adaptive bulk receipt windows. Preserves failed setup instrumentation,
  exact source/build evidence and untested product-integration boundaries.
- [Startup transport delay cause — 2026-10-19](design/startup-transport-cause-2026-10-19.md) —
  frozen B128 reproduces 809/1,885 ms first-chunk states; packet/trace evidence
  connects a delivered control message's delayed ACK to unnecessary retransmission
  and reduced-congestion startup. One latency-only counterfactual corroborates
  the mechanism. Preserves diagnostic binary differences, post-window tail
  uncertainty and the separate full-transfer cost; no runtime change or release.
- [Adaptive credit with 16 KiB native messages — 2026-10-18](design/adaptive-credit-fragment16-screen-2026-10-18.md) —
  eight same-main native runs: H8 preload 71.583→48.450 seconds and ordinary
  64.217→36.760, with slow2 throughput preserved. Dynamic-network initial control
  delays failed the frozen relative budgets; preserves independent audits,
  the separate small-tail analyzer repair, and ten unexecuted followups.
  No product integration or deployment.
- [Adaptive 192 KiB credit screen — 2026-10-18](design/adaptive-credit-192-screen-2026-10-18.md) —
  same-source native preload shortened 71.791 to 49.516 seconds, but the frozen
  raw/p95 control-delay gates failed. Preserves startup timing, unequal-duration
  percentile limits, independent integrity/media verification, and six skipped
  followups; no production adoption.
- [Historical preload and playback comparison — 2026-10-18](design/historical-transfer-comparison-2026-10-18.md) —
  exact initial/month-old/yesterday/current production sources, six minimal
  native RTC runs and the first-commit setup blocker. Separates older playback
  failures from current high-RTT throughput cost; no App release.
- [Automatic realignment clock safety candidate — 2026-10-18](design/automatic-realignment-clock-safety-2026-10-18.md) —
  fixed 64/64/128 KiB transport, uncertainty-aware optional YouTube correction,
  operation clock leases and bounded local diagnostics. Ten native cases retain
  the diagnostic256 performance-budget failure separately from operating128
  safety and recovery; no production release or full all-green claim.
- [Transport candidate roundtable and isolated experiments — 2026-10-18](design/transport-candidate-roundtable-2026-10-18.md) —
  rate-gated credit, native-message fragmentation, and automatic-correction clock
  leases; separates deterministic safety, native throughput/control results,
  independent verification, and unresolved real-device limits. No App release.
- [Local buffer / receiver-credit crossed comparison — 2026-10-18](design/receiver-credit-cross-matrix-2026-10-18.md) —
  fixed 64 KiB payload, six local/credit combinations, 36 exploratory native
  RTC cases and a frozen reverse-order confirmation. Separates file integrity,
  playback preservation, control latency and observed capacity waits. No App release.
- [Adaptive receiver-credit and clock-quality experiment — 2026-10-18](design/receiver-credit-adaptive-design-2026-10-18.md) —
  isolated adaptive-window and automatic-realignment candidates, native ordinary/
  preload comparisons, retained tail-latency rejection, and long-congestion
  controls. Experimental source only; deployed 64/128 KiB policy is unchanged.
- [Receiver-credit window comparison — 2026-10-18](design/receiver-credit-window-comparison-2026-10-18.md) —
  Fixed 64 KiB local threshold with 128/256/384/512 KiB receipt windows across
  ordinary transfer/preload, eight receivers, slow links and high RTT. Records
  counterbalanced native RTC measurements, playback-preservation failures,
  lifecycle checks and the limits of choosing one fixed window. No App release.
- [Receiver-confirmed direct file flow control — 2026-10-18](design/receiver-credit-file-transfer-2026-10-18.md) —
  ordinary/preload shared credit, local 64 KiB thresholds, compatibility,
  cancellation and promotion; final product verification, high-RTT throughput
  tradeoff and App 8.11.20/v723 deployment/recovery evidence.
- [Native RTC control-queue root-cause investigation — 2026-10-18](design/preload-control-queue-root-cause-2026-10-18.md) —
  Separates the app from transport behavior using shared/separate PeerConnections
  and receiver-confirmed flow control. Records native file integrity, directional
  timing, controlled slow-link limits, and the evidence needed before a protocol change.
- [Preload capacity: slow links, multiple recipients, and lifecycle — 2026-10-18](design/preload-capacity-validation-2026-10-18.md) —
  Records 38 verified native RTC transfers, slow-link and eight-recipient comparisons,
  cancellation/channel-replacement/promotion pins, local release checks, and the remaining
  slow-receiver/control-queue limits. App 8.11.19/v721 release preparation.
- [Setup buttons swapped inside the screen transition — 2026-10-18](design/setup-actions-transition-2026-10-18.md) —
  The setup actions changed before the transition captured the outgoing screen, so the
  centered phone middle block jumped 36px and the buttons skipped the crossfade when entering
  방 만들기 or 방 참여하기 and coming back. They now swap inside the same transition. Records
  the transition frames and tests. App 8.11.18/v720.
- [Welcome carousel spacing and a fainter dark icon circle — 2026-10-18](design/setup-carousel-spacing-2026-10-18.md) —
  The first screen's carousel shows 28px from the icon circle to the title, 20px to the
  description, and 36px to the dots on phones (owner decision); the two-column panel scales
  the same ratio with its title size. Dark draws the icon circle on surface-1, as faint as in
  light. Records the measurements and tests. App 8.11.17/v719.
- [Phone portrait setup centered by its visible edges — 2026-10-18](design/setup-mobile-visible-centering-2026-10-18.md) —
  Follows 8.11.15: the bottom paddings balance the empty space inside the header and the
  middle block (the QR margin, the 84% scan button, text spacing), so the visible gaps above
  and below match within 0.5px on four phones. Records the measurements and tests. App
  8.11.16/v718.
- [Phone portrait setup with a centered middle block — 2026-10-18](design/setup-mobile-centering-2026-10-18.md) —
  On phone portrait, the first screen's carousel, the invite QR with its code, and the QR
  scanner with the code field sit midway between the header and the actions, with equal
  gaps. Records the layout measurements on five phones, tests, and limits. App 8.11.15/v717.
- [Local repeat and native Android Pixel preload comparison — 2026-10-18](design/preload-local-pixel-retest-2026-10-18.md) —
  Repeats the same scratch builds on Windows and checks native Android Chrome in
  the existing Pixel AVD. Separates transfer/message timing from an unstable
  no-preload media baseline, preserves setup failures, and records scope limits.
  Pixel results do not confirm a consistent benefit from the 64 KiB threshold.
- [Preload control-message priority investigation — 2026-10-18](design/preload-control-priority-investigation-2026-10-18.md) —
  nine actual-YouTube direct-RTC trials compare the unchanged sender, a smaller
  preload buffer threshold, and fixed pacing. Records latency/throughput tradeoffs,
  unchanged product sources, and the remaining multi-device/lifecycle checks.
- [Actual file preload during YouTube playback — 2026-10-18](design/youtube-preload-live-ab-2026-10-18.md) —
  Compares 8.11.13 and 8.11.14 with real WebRTC/RAM file transfer through the
  product Cloudflare adapter, both controlled and actual YouTube providers.
  Separates delayed control messages from buffering, playback mutation, and
  physical Android/audio claims. No product code or production change.
- [Standard YouTube heartbeat correction — 2026-10-17](design/youtube-heartbeat-delay-fix-2026-10-17.md) —
  Uses one current host position for coarse seek, Android BUFFERING recovery,
  and small-drift observation. Preserves output/manual compensation and records
  the reviewed tail-hold boundary, 13,036 local passing tests, exact-main CI,
  App 8.11.14/v716 Release 39039136092, operational smokes, public asset hashes,
  recovery checkpoint, successful automated drift checks, and device limits.
- [Host QR reveal without the double flicker — 2026-10-17](design/setup-qr-reveal-2026-10-17.md) —
  The carousel stays in the tap transition's snapshot (no empty frames), the desktop left
  panel keeps an unchanged QR stage mounted, and the QR encoder loads from the host tap.
  Records the frame captures, unit and browser tests, and limits. App 8.11.13/v714.
- [Standard YouTube delayed-heartbeat reproduction — 2026-10-17](design/youtube-heartbeat-delay-reproduction-2026-10-17.md) —
  Real handler and SharedClock with a fake iframe reproduce two incorrect seek
  paths: delayed-frame coarse correction and Android BUFFERING recovery. New
  tests: 15 pass / 6 fail / 0 skip; existing focused tests: 281 pass. No runtime
  change or deployment; actual preload causation remains unverified.
- [Deferred Back guard (R policy) — 2026-10-17](design/ios-back-deferred-guard-2026-10-17.md) —
  Owner-tested iPhone diagnostic, shared deferred history registration, actual
  window-close completion and owned-history leave. Records App 8.11.12/v712,
  exact-main CI 39008608569, Release 39009031876, public asset hashes,
  operational smokes, recovery checkpoint and successful drift audit.
  Native iOS swipe verification remains open; browser coverage is targeted.
- [One update dialog everywhere — 2026-10-17](design/update-dialog-everywhere-2026-10-17.md) —
  A waiting update gets the same dialog (적용하기 / 나중에) on every screen, rooms and the
  demo included, with copy that says what applying costs. 나중에 lasts for the page, and a
  room guest returns to the room's Start screen. Replaces the in-room notice and the 8.11.6
  apply on reopen. Records the tests, a local browser check, and limits.
- [Screensaver caption glow and combined centering — 2026-10-17](design/screensaver-caption-glow-centering-2026-10-17.md) —
  Weak blue description glow, combined weather/AQI/moon alignment, and preserved
  local Safari diagnosis; records the visual-test adjudication, local validation,
  and 8.11.10 release, public-asset, and recovery evidence.
- [Back closes the topmost window — 2026-10-17](design/back-closes-top-window-2026-10-17.md) —
  History Back closes only the topmost window, in rooms and on the setup screens; with no window
  open it asks before leaving a room or moves to the previous page. Also closes the PRO re-entry
  gap. Records the window table, local browser checks, limits, and the 8.11.9 release evidence.
- [Approved diffusion clock background — 2026-10-17](design/screensaver-diffusion-clock-2026-10-17.md) —
  Uses the selected lighter artwork for the clock, preserves other scenes and
  previous immutable image URLs, and records validation and release evidence.
- [One dialog when returning from the background — 2026-10-17](design/resume-dialog-dedup-2026-10-17.md) —
  A return from the background shows at most one dialog: a warning answered late no longer
  repeats, and the audio recovery dialog replaces the generic warning. Records both paths and the 8.11.7 release evidence.
- [Apply a waiting update on reopen — 2026-10-16](design/update-apply-on-reopen-2026-10-16.md) —
  A reload or reopen outside a room, including an invite link before Start, now applies
  a waiting update without asking again. Records the cause, the room guard, test limits, and the 8.11.6 release evidence.
  Replaced on 2026-10-17 by [one update dialog everywhere](design/update-dialog-everywhere-2026-10-17.md).
- [Screensaver caption rendering regression — 2026-10-16](design/screensaver-caption-rendering-2026-10-16.md) —
  restores whole-caption rendering after missing small-letter strokes were reported;
  records the source regression and browser-reproduction limits.
- [Image backgrounds and compatible screensaver effects — 2026-10-16](design/screensaver-image-backgrounds-2026-10-16.md) —
  The approved all-image background version, lazy immutable assets, and compatible
  foreground effects, with integration verification and release evidence.
- [Safari screensaver blur diagnosis — 2026-10-16](design/screensaver-safari-filter-diagnosis-2026-10-16.md) —
  Historical Canvas filter failure reproduced in native Windows WebKit before the
  8.11.4 compatibility repair; preserves the original probe and physical iPhone
  verification limits, with links to the subsequent repair and release evidence.

- [Maximum text weight 700 — 2026-10-16](design/max-font-weight-700-2026-10-16.md) —
  Every text weight in the project is capped at 700, including badges, code
  fields, public pages, the admin console and the static OG cards, with a
  unit test that keeps it there. Shipped App 8.11.3/v700 with exact-main CI,
  production ownership/smoke, public stylesheet, OG image and Drift Audit
  evidence.

- [Display title weight 700 — 2026-10-16](design/display-weight-700-2026-10-16.md) —
  Every display use (titles, dialog titles, invite code and the rest) moves
  from 800 to 700 in all locales, and the design system documents the same
  weight. Shipped App 8.11.2/v699 with exact-main CI, production
  ownership/smoke, public stylesheet and Drift Audit evidence.

- [Lazy ambient screensaver — 2026-10-16](design/screensaver-integration-2026-10-16.md) —
  local command, YouTube exclusion, fullscreen restoration, fading track details, scoped
  permissions, and release evidence.

- [Desktop action button width — 2026-10-16](design/desktop-action-width-2026-10-16.md) —
  Sync and Media retain their existing maximum width from the 1280px desktop
  breakpoint. Shipped App 8.10.27/v693 with exact-main CI, production
  ownership/smoke, live 1280/1360/1440px geometry and Drift Audit evidence.

- [Keep-open dialog in PRO rooms — 2026-10-16](design/keep-open-pro-2026-10-16.md) —
  First-time PRO participants also get the one-time keep-open dialog when the
  room's first media appears, without the host sentence. Shipped App
  8.10.26/v692 with exact-main CI, production ownership/smoke and Drift Audit
  evidence.

- [Host presence and keep-open guidance — 2026-10-16](design/host-presence-keep-open-2026-10-16.md) —
  Standard-room guests see a waiting loader, refusal and hold toasts, and an
  offer to leave when the host's app is in the background or frozen.
  First-time visitors get a one-time keep-open dialog, and the account pill
  stays visible while any loader shows. Shipped App 8.10.25/v691 with
  exact-main CI, production ownership/smoke and Drift Audit evidence; the first
  release attempt rolled back automatically after a signaling smoke 503.

- [Unused toast keys — 2026-10-15](design/unused-toast-keys-2026-10-15.md) —
  Twelve toast keys that no code referenced are removed from all 42 locales.
  Shipped App 8.10.24/v690 with exact-main CI, production ownership/smoke and
  Drift Audit evidence.

- [Toast line length — 2026-10-15](design/toast-line-length-2026-10-15.md) —
  Toasts stop cutting authored copy at 50 characters (921 values in 38 locales
  ended in an ellipsis), stay up longer for longer text, and 77 verbose
  translations in 20 locales are trimmed. Shipped App 8.10.23/v689 with
  exact-main CI, production ownership/smoke and Drift Audit evidence; device
  rendering checks remain.

- [Toast punctuation policy — 2026-10-15](design/toast-punctuation-policy-2026-10-15.md) —
  Toasts drop sentence-final periods and put each sentence on its own line in
  42 locales, with a guard test. Shipped App 8.10.22/v688 with exact-main CI,
  production ownership/smoke and Drift Audit evidence; device rendering checks
  remain.

- [Update notice line breaks — 2026-10-15](design/update-notice-line-breaks-2026-10-15.md) —
  The four update notices put each sentence on its own line in 42 locales,
  which also ends toast truncation for 102 of 126 values. Shipped App
  8.10.21/v687 with exact-main CI, production ownership/smoke and Drift Audit
  evidence; device rendering checks remain.

- [PRO playlist reorder feedback — 2026-10-14](design/pro-playlist-reorder-optimistic-2026-10-14.md) —
  A dropped PRO reorder shows its order at once instead of redrawing the old one
  until the server answers; a rejection restores the server order with a toast in
  42 locales. Shipped App 8.10.20/v686 with exact-main CI, production
  ownership/smoke and Drift Audit evidence; the production reproduction and
  physical-device checks remain.

- [PRO silent-endpoint transport — 2026-10-14](design/pro-silent-endpoint-transport-2026-10-14.md) —
  The transport acts on the icon it shows, so Play on a silent PRO endpoint
  rejoins only that endpoint instead of pausing the room; YouTube restores and
  local rejoins show the loading state. Shipped App 8.10.19/v685 with exact-main
  CI, production ownership/smoke and Drift Audit evidence; the production
  reproduction and physical-device checks remain.

- [YouTube rejoin synchronization — 2026-10-14](design/youtube-rejoin-sync-2026-10-14.md) —
  PRO local rejoins and late joins settle at a planned release instant instead of
  seeking during release; Standard guests re-align after late starts. Shipped App
  8.10.18/v684 with exact-main CI, production ownership/smoke and Drift Audit
  evidence, plus production before/after measurements including server seeks;
  physical-device and full E2E limits remain.

- [Sharing action failure isolation and spacing — 2026-10-14](design/sharing-action-fallback-2026-10-14.md) —
  Eager visible/accessibility state, optional motion failure cleanup and one gap
  token. Shipped App 8.10.17/v683 with exact-main CI, production ownership/smoke,
  browser update and Drift Audit evidence; full E2E and physical-capture limits remain.

- [Shared app double-tap policy — 2026-10-14](design/shared-touch-policy-2026-10-14.md) —
  Common touch default preserving existing zoom locks, inner scrolling and
  component gestures. App 8.10.16/v682; affected iOS 17.6.1 PWA displacement and
  scroll/volume/reorder checks confirmed by the owner. Broader device/update limits remain.
- [System audio sender action surface — 2026-10-14](design/system-audio-sharing-actions-2026-10-14.md) —
  Sender-only merged Stop Sharing control, stable hover motion, room/demo CSS
  readiness, accessibility and 42-locale layout verification. App 8.10.14/v680;
  optional-motion failure and shared gap-token follow-ups recorded on 2026-10-14.
- [입장 대기·장황 버튼 라벨 축약 — 2026-10-14](design/short-wait-labels-2026-10-14.md) —
  `common.wait`·`setup.joining` 28건과 2026-10-13 길이 조사의 장황 버튼 25키 222건을 칩·2버튼 행
  ≤14자, 전폭 ≤22자 관용구로 축약(31키·250건). 8.10.15/v681,
  Production Release `target=app`.
- [점검 안내 번역 14건·숨은 YouTube 패널 접근성 수정 — 2026-10-14](design/maintenance-copy-and-a11y-release-2026-10-14.md) —
  Worker 6종 공유 점검 안내 문구 14개 로케일 관용구 수정, 화면 밖에 주차된 YouTube 래퍼
  `inert`로 역방향 키보드 포커스 차단. 8.10.12/v678, Production Release `target=all`.
- [42개 로케일 번역 품질 업데이트 — 2026-10-14](design/i18n-quality-update-2026-10-14.md) —
  전수 조사 제안을 오너 결정으로 걸러 사전 값 1,718건 변경(PRO 활성화 7키 신규 번역
  70건 포함), 복수형·계정 페이지·`<bdi>` 복구, 토스트 50자 상한 보정, compact 라벨은
  CI 레이아웃 게이트에 따라 base 유지, 영어 폴백 동기화. App 범위(8.10.11/v675), 점검
  안내는 Worker 후속.
- [YouTube playlist and native administrator repair — 2026-10-14](design/youtube-playlist-native-control-repair-2026-10-14.md) —
  Complete Standard manifests, atomic PRO reentry projection, native control
  ownership and browser/release evidence with provider limitations.
- [YouTube 목록·관리자 iframe 조작 조사 — 2026-10-14](design/youtube-playlist-native-control-audit-2026-10-14.md) —
  일반방 부분 목록 채택, PRO 재입장 투영 유실, 관리자 iframe 재개·탐색 경로를
  조사했다. 실제 공급자 관측과 합성 피드백 재현의 한계를 구분하며 제품 수정·배포는 없다.
- [Component pill and cascade refactor — 2026-10-13](design/component-cascade-refactor-2026-10-13.md) —
  Component-owned shape, presentation layer precedence, retained safety guards,
  and browser comparison/release evidence.
- [YouTube popup focus repair — 2026-10-13](design/youtube-popup-focus-repair-2026-10-13.md) —
  자연 실패의 타이머·focus·키 이벤트로 후반 Tab 경합 원인을 확인하고 초기 focus
  fallback을 수정했다. 로컬·원격 전체 Chromium 각 627개와 exact-main CI를 통과하고
  8.10.8/v669로 배포했다. 반복검사의 타이머 경계 한계와 단위 회귀 근거를 함께 기록한다.

- [YouTube keyboard focus remote diagnostic — 2026-10-13](design/youtube-focus-linux-diagnostic-2026-10-13.md) —
  같은 코드의 Ubuntu·Windows 반복 검사에서 최초 focus 실패를 재현했다.
  준비 확인·실제 Tab 진입은 60회 통과했지만 전체 비교는 57 pass / 후반 Tab 3 fail이다.
  제품·main 테스트 수정이나 배포 없이 결과와 해석 한계를 기록한다.

- [YouTube input guidance — 2026-10-13](design/youtube-input-guidance-2026-10-13.md)

- [공지 외부 리뷰 후속 수정 — 2026-10-13](design/announcement-review-followup-2026-10-13.md) —
  `/clear` 서비스 공지 소유권, RTL 닫기 영역, 관리자 초안 확인, legacy 정규화 및
  플라이트 레코더 빌드 식별을 재현·수정하고 검증·배포 근거를 기록한다.

- [일반·PRO 동시 입장 시뮬레이션 — 2026-10-13](design/session-admission-burst-simulation-2026-10-13.md) —
  실제 로컬 workerd·SQLite DO에서 동시 입장, 정원 초과, 암호·공유망, 재시도·재접속,
  퇴장 후 자리 재사용을 검사한다. 반복 실행 명령과 fixture·실기기 한계를 기록한다.

- [PRO 입장 복구·서버 진단 — 2026-10-13](design/pro-admission-repair-2026-10-13.md) —
  활성/휴면 번호 분리, TTL 경계 정원 판정, 공유 조회의 수명과 제한된 서버 진단.
  수정·검증·배포 근거와 과거 행사 원인을 확정할 수 없는 한계를 기록한다.

- [PRO 행사 외부 리뷰 재검증 — 2026-10-13](design/pro-event-report-verification-2026-10-13.md) —
  정원 판정 도중 TTL이 끝나는 경계의 거절을 당시·현재 소스에서 재현했다.
  절전·재입장·캐시·계측 주장의 사실/정책/추정을 구분하고 복구 관련 92개 테스트를
  통과했다. 원문 보고서 보존, 제품 수정·운영 변경·배포 없음.

- [PRO 행사 입장·Peer 번호 심층 감사 — 2026-10-13](design/pro-event-admission-deep-audit-2026-10-13.md) —
  당시·현재 소스에서 최대 4대의 `Peer 101`과 앱 입장 응답 거부, 공유 registry 조회 취소의 후속
  요청 차단을 로컬 재현했다. 행사 방의 Cloudflare 오류·객체 통계 및 D1 카운터를
  대조했다. 현장 정원 초과 여부는 미확정이며 제품 수정·로그 추가·배포는 없다.

- [공지 철회·관리자 편집·전체보기 수정 — 2026-10-13](design/announcement-repair-2026-10-13.md) —
  공지 철회/조회 실패 구분, 오래된 서버 캐시 응답 차단, 관리자 초안·만료 처리,
  긴 공지 전체보기와 초기 알림 정책, 리뷰에서 찾은 관리자 초기 초안 경계를 수정했다.
  exact-main CI와 Release 38293505122로 8.10.4/v665 전체 Worker 배포 완료.
  운영 smoke 10종·Drift Audit 통과, 실서비스 5분 철회·PWA·실기기 한계는 별도 기록.

- [공지 전체 경로 감사 — 2026-10-13](design/announcement-full-audit-2026-10-13.md) —
  철회·조회 장애 구분·관리자 초안/만료 처리의 기능 결함 6개, 표시·알림 UX 2개를
  분리했다. 기존 선택 검사 383건, 추가 탐사 30건 및 관리자 harness로 검증.
  제품 수정·배포 없이 근거와 후속 수정 조건을 기록했다.

- [일반방 공지 초기화 수정 — 2026-10-13](design/standard-announcement-bootstrap-2026-10-13.md) —
  새 방장·참여자 앱 초기화에서 누락된 공지 로딩, 수정 전 재현과 필수 브라우저 회귀 검사.
  exact-main CI 확인 뒤 Release 38273449653으로 8.10.3/v662 App 배포 완료,
  운영 smoke 4종·사후 Drift Audit 통과, 실제 운영 일반방 공지 표시 확인.
  기존 설치 PWA·실기 확인 한계는 남는다.
  후속 운영 검증에서 공지 비활성화 후 5분 20초가 지나도 기존 배너가 남는 별도
  철회 처리 누락을 확인했다. 공지는 비활성화 상태이며 후속 로컬 수정은 위
  공지 수정 보고서에 기록했다. 추가 배포는 하지 않았다.

- [동기화 점검 배포 준비 — 2026-10-12](design/sync-maintenance-release-preparation-2026-10-12.md) —
  최신 main 통합, 리뷰 보완, 초기 로딩 경계, 강제 버전 차단 없이 점검 후 배포하는
  오너 결정과 로컬 전체 단위 12,354건·후보 17건·선택 브라우저 61건의 검증.
  exact-main CI 확인 뒤 2026-10-13 Release 38267400052로 8.10.2/v661 배포 완료, 운영 smoke 4종·사후 Drift Audit 통과. 실기 한계는 남는다.
- [Android YouTube 공통 기준·기기별 출력 보정 — 2026-10-12](design/android-youtube-output-baseline-2026-10-12.md) —
  일반·PRO의 own 250 ms, 방장 수동값 격리, 곡 끝 처리와 로컬 검증.
  실음향·구버전 혼용의 남은 한계를 구분한다. 8.10.2/v661 배포 완료(위 점검 배포 기록).
- [일반방 시계·학습 브라우저 실험 — 2026-10-12](design/standard-clock-browser-simulation-2026-10-12.md) —
  실제 일반방 P2P와 YouTube, 지연 통제 60회 및 실제 시계 모듈 150,400회 모형.
  초기 표본 교체 시 학습 제외와 안정 후 재개 확인, 제품 수정·배포 없음.
- [일반방 랑데부 학습·시계 관측 수정 — 2026-10-12](design/standard-start-learning-repair-2026-10-12.md) —
  C11 timer 지연 제외, 계획·예약·호출·측정 시계 검사, SharedClock 선택 사유와
  flight recorder 관측. 시간 경계·취소 관측 재현, 단일 seek 핀 위치와 로컬 검증. 8.10.2/v661 배포 완료(위 점검 배포 기록).
- [일반방 시작 시계·학습 제안 재검증 — 2026-10-12](design/standard-start-review-2026-10-12.md) —
  C11 영속 학습 오염 9조건 재현, C13 감지 한계, 일반방 시계·파일 보정 경계,
  관측·QA 기준. 제품 수정 없이 로컬 검증.
- [PRO 시작 시계·관측 수정 — 2026-10-12](design/pro-start-clock-safety-2026-10-12.md) —
  작업별 시계 snapshot, 미보정 COMMIT 차단, 늦은 READY 대기 분리, C11 callback
  지연 구분과 관측 전용 YouTube 표본. 리뷰 후 소켓 단절 중 확정된 시작을 보존하고
  파일·YouTube 실제 적용 경로를 재검증. 8.10.2/v661 배포 완료(위 점검 배포 기록).
- [PRO 시작 싱크 원인 후보 재검증 — 2026-10-12](design/pro-start-sync-candidate-validation-2026-10-12.md) —
  C1–C14 반박 검증, 시계 갱신·미보정 COMMIT 예약 결함 재현,
  YouTube 제어·파일 PCM 비교와 실기 측정 한계. 수정 전 분석 기록; 후속 수정은 위 보고서.
- [PRO file duration registration and backfill — 2026-10-12](design/pro-file-duration-registration-2026-10-12.md) —
  bounded upload metadata, immutable asset duration retention, late authorized
  preparation reports, legacy backfill, compatibility and verification limits.

These files contain dated measurements or completed work, while a clearly
labeled portion still supports a current guard or operating interpretation:

- [PRO duration hardening (8.10.1) — 2026-10-12](design/pro-duration-hardening-2026-10-12.md) —
  App 8.10.1 / v660 (released 2026-10-12, target `all`): stricter MP3/MP4 duration
  readers, versioned server file durations re-measured on play, ignored upload
  lengths, the 0.9x controller floor, alarm and metadata backoff fixes, and
  the two-answer skip for deleted YouTube videos; three adversarial review
  rounds plus a ship gate, and production verification. No real-device review.
- [8.10.0 merge and 8.9.4–8.9.6 review — 2026-10-12](design/release-8-10-0-merge-review-2026-10-12.md) —
  App 8.10.0 / v659 after merging 8.9.6: merge resolution, four read-only
  reviews (no P1/P2), the replaced-tab takeover copy fix, the PRO Worker
  follow-ups deferred to 8.10.1, the owner decisions on order and deleted
  YouTube videos, and the exact-main CI rerun and production verification of
  the 2026-10-12 release. No real-device review.
- [PRO autonomous natural completion — 2026-10-12](design/pro-autonomous-playback-2026-10-12.md) —
  server-owned end deadlines, bounded file headers and authenticated YouTube
  metadata, controller sleep/departure, queue transitions and rollback compatibility;
  App 8.9.5 / v656 release, exact-main CI and production verification evidence.
- [PRO PWA force-close and relaunch — 2026-10-12](design/pro-pwa-force-close-audit-2026-10-12.md) —
  missing-exit presence retention, 45-second lease probes and approved continuation
  copy in all 42 locales; App 8.9.4 / v655 release and verification evidence.
- [In-room update prompt — 2026-10-11](design/in-room-update-prompt-2026-10-11.md) —
  App 8.10.0/v659 (released 2026-10-12), same release as the Standard-room owner PIN:
  in a room (standard or PRO, including the create and join screens and PRO
  presence re-entry) or the demo, a waiting update no longer opens the
  blocking dialog. It is an automatic "나중에" with no stored dismissal and
  one local chat notice per generation ("페이지를 새로고침하면" in a tab,
  "앱을 다시 열면" in a home-screen app), never sent to peers, or a toast
  where the chat cannot be seen, followed by the chat notice once the room
  starts. Another tab's activation posts the same notice, and back on setup
  the dialog is offered once. Devices on older code (production v657) show
  the old dialog once for this update, so the first deployment must avoid
  live events. Owner decisions after the review (2026-10-11): the create and
  join screens keep the toast, and the lazy-feature recovery dialog keeps
  opening in a room (not dismissible, Refresh only) with its own copy
  ("새로고침이 필요해요" / "MUSIXQUARE가 업데이트되었어요. 정상적으로
  사용하려면 새로고침이 필요해요.", 42 locales; v658 follow-up, v659 after
  merging App 8.9.6). Local unit, coverage, build, and Chromium browser checks
  with screenshots; no real-device or native-speaker review. The chat notice, toast, and
  deferral were replaced on 2026-10-17 by [one update dialog everywhere](design/update-dialog-everywhere-2026-10-17.md).
- [Standard-room owner PIN — 2026-10-11](design/standard-room-owner-pin-2026-10-11.md) —
  App 8.10.0 with the signaling Worker (released 2026-10-12, target `all`; tested at
  v655, ships as v659 with the in-room update prompt):
  Standard-room hosts type the 8-digit PIN in the shared two-step dialog,
  step 2 is skipped when nobody else is in the room (both room types), the PIN
  is masked in both, "모두 재입장" closes guest sockets in the Worker before
  the host's reasoned kick, kept devices reconnect without the new PIN, and the
  Worker limits wrong PINs per room and address block (live buckets are never
  evicted; by owner decision B, blocks past 256 are not limited rather than
  sharing a bucket that could lock every newcomer, and devices already in the
  room keep their signaling recovery), and a guest locked out by wrong
  PINs sees the Standard room's own "암호를 여러 번 틀렸어요" copy instead of
  the PRO join-limit wording (v655 follow-up). Also fixes forced colors:
  selected-row text, the pressed PIN toggle, selected tab and option icons, and
  the invite QR in light high-contrast themes. Local unit, Worker, coverage,
  build and browser checks; no real-device or native-speaker review.
- [PRO entry failure retry audit — 2026-10-11](design/pro-entry-retry-audit-2026-10-11.md) —
  retained-role defect after failed PRO entry, local same-page retry repair,
  lifecycle fencing and admission regression evidence; shipped in 8.9.4.
- [PRO clock budget and concurrent admission — 2026-10-11](design/pro-clock-and-admission-races-2026-10-11.md) —
  delayed clock replies within the caller budget, still-active admission
  tickets overtaken by another arrival, and unchanged admission limits.
  Local repairs and regression evidence; shipped in 8.9.4.
- [PRO PIN two-step dialog — 2026-10-11](design/pro-pin-two-step-2026-10-11.md) —
  shipped with App 8.9.4/v655: a minimal PIN page with Cancel /
  Next, then "현재 참여자를 어떻게 할까요?" with "그대로 두기" / "모두 재입장" rows
  styled like the language list, replacing the 8.9.0 in-dialog radio group that
  clipped on small phones and in landscape. Local unit, build, browser, and
  headless Chromium layout checks with screenshots; no real-device or
  native-speaker review.
- [PRO PIN membership choice and removal reasons — 2026-10-11](design/pro-pin-member-choice-2026-10-11.md) —
  "Let them stay" / "Make everyone rejoin" on PIN enable or change, and a
  `reason` on the unchanged `SESSION_REQUIRED` 401 for kicked, disconnected,
  and PIN-revoked sessions (PRO Worker and App, 8.9.0/v651, code `4319a2a0` merged with #290
  on main `13a25ee4`). Local tests only; not merged or deployed. Real-device
  checks remain open.
- [PRO join error copy — 2026-10-11](design/pro-join-error-copy-2026-10-11.md) —
  unreleased App 8.8.1/v648 (code `8961ff46`): localized `ROOM_FULL` and
  `RATE_LIMITED` join messages in 42 locales, with the wait in whole minutes.
  Local unit, build, and headless Chromium phone-width checks; no real-device or
  native-speaker review.
- [Grouped dependency update — 2026-10-11](design/dependency-update-2026-10-11.md) —
  Dependabot PR #288 (Mediabunny 1.61.3, Vite 8.3.3, Wrangler 4.148.0) with its
  adaptations: regenerated Worker types, HLS kept out of large-audio detection for the
  Chromium 79 build, and cache v648. Local verification only; not yet deployed.
- [PRO public-room admission protection — 2026-10-11](design/pro-room-admission-protection-2026-10-11.md) —
  owner seat, dedicated admission and presence-close receipt ledgers, and soft
  join throttle (PRO Worker only, code `95fa7a88`). Local Worker tests only; not yet
  deployed. The App error-message follow-up is the unreleased
  [PRO join error copy](design/pro-join-error-copy-2026-10-11.md) change
  (8.8.1/v648); a post-deploy check remains open.
- [PRO persisted-resource lane — 2026-10-11](design/persisted-resource-lane-2026-10-11.md) —
  unreleased behaviour-neutral refactor (8.8.0/v647): shared lock and refresh flight,
  differential and mutant evidence, and the effects/queue-mode asymmetries kept on purpose.
- [PRO optional entry password — 2026-10-10](design/pro-optional-entry-password-2026-10-10.md) —
  8.8.0/v646 contract, verification, and the PRO/App forward-repair floor. Browser
  checks used synthetic API fixtures; real customer rooms and devices remain open.
- [Header-independent tab crossfades — 2026-10-09](design/header-crossfade-2026-10-09.md) —
  8.7.9/v645 change and verification; the physical iPhone Safari/PWA check is pending.
- [App 8.7.2 전체 검증 — 2026-10-07](design/full-verification-8.7.2-2026-10-07.md) —
  full unit/Chromium/WebKit verification and the closed production R2 delay
  investigation (cause undetermined; no policy relaxation).
- [8.7.0 production release — 2026-10-07](design/release-8.7.0-2026-10-07.md) —
  the promotion of the accumulated beta to all six Workers after the release freeze.
- [3차 QA 후속 수정·예방 보강 — 2026-10-09](design/beta-qa3-repair-2026-10-09.md):
  확정 9건과 승인된 예방 보강 3건의 재검증·수정·릴리스 근거. 기존 감사 판정과 provider/실기 한계를 보존한다.
- [8.7.6 follow-up third 30-round QA — 2026-10-09](design/beta-30-round-qa3-2026-10-09.md) —
  6.1 Sol/xhigh, three agents across ten sets on main `bf4912b2`; 29 complete rounds and one partially executed safety-blocked round.
  At the audit baseline, nine confirmed findings were unrepaired, with three conditional observations kept separate. The linked follow-up repair record tracks their current disposition.
  Eight findings were independently replayed; the OAuth return-origin finding uses pre-block local evidence and source review.
  Unique focused cases, first failures, parent adjudication and physical/live/security limits are recorded. Product and deployment unchanged.
- [Post-promotion 30-round repair — 2026-10-09](design/beta-30-round-repair-2026-10-09.md) —
  Repairs the 13 confirmed findings and two owner-selected behavior requirements after fresh necessity checks.
  API mutation-time credential validation and live announcement status are now explicit contracts.
  Local verification, original failures and blocked security-depth limits are recorded separately from release evidence.
- [Post-promotion independent 30-round QA — 2026-10-09](design/beta-30-round-qa-2026-10-09.md) —
  Astra Ultra, three agents across ten sets on main `e7c5529a`.
  At the audit baseline: 13 confirmed findings, 2 provisional observations and 8 excluded candidates;
  complete baseline suites, new boundary probes, first failures and independent adjudication are separated.
  Blocked security depth and physical/live limitations remain explicit. Product code and deployment unchanged.
- [Beta 30-round repair and verification — 2026-10-07](design/beta-30-round-repair-2026-10-07.md) —
  Implements the 12 confirmed findings and two separate robustness improvements
  after owner approval. The report preserves original failures, follow-up checks,
  compatibility limits and one unresolved legacy SW update liveness observation after approval.
  At that historical checkpoint, main and production were frozen.
- [Beta independent 30-round QA — 2026-10-07](design/beta-30-round-qa-2026-10-07.md) —
  Astra Ultra, three agents per set across ten sets. Post-round adjudication
  confirmed 12 distinct unresolved defects at the discovery checkpoint; two observations remained provisional
  and two candidates are rejected. Selected maintained tests total 8,716 unique
  passing cases. At that discovery checkpoint, a newly reviewed sharp advisory failed the dev security gate;
  production-only audit remained zero. Product code and main were not changed
  during discovery; the subsequent repair is recorded separately above.
- [Beta dependency security repair — 2026-10-06](design/beta-security-repair-2026-10-06.md) —
  At the October 6 repair checkpoint, beta audit warnings fell from 13 packages
  to zero, with registry signatures verified. Dev-only patches preserve each parent's Undici/brace API requirements
  and the pinned Wrangler version. Main and production remain frozen; the report
  records the changed dependency graph and its local verification.
- [Main and beta comparison — 2026-10-06](design/main-beta-comparison-2026-10-06.md) —
  No new confirmed beta runtime defect across the 97-commit diff. Full unit
  revalidation and 54 selected Chromium cases pass; an unchanged tooling timeout
  resolves on focused rerun. Audits at this baseline match at 13 vulnerable dev
  packages, including one critical warning; prod-only audit remains clean.
  The October 6 repair cleared beta's then-known dependency warnings. The October 7
  QA above records a newly reviewed warning. Beta cache
  promotion and physical-device checks remain.
- [Final requested beta QA — 2026-10-04](design/beta-final-qa-2026-10-04.md) —
  No new confirmed product defect; further discovery ends at the owner's
  request. Full unit 10,637, new module 32, selected Chromium 43 plus four
  native delay conditions, WebKit 66 with three existing skips, production
  smoke 10 and eight artifact guards pass. Source is unchanged; physical
  timing and existing security/cache promotion gates remain.
- [Follow-up beta sequence QA — 2026-10-04](design/beta-sequence-qa-2026-10-04-round-2.md) —
  63 new module cases, 18 new mobile-view browser plans and 1,014 selected
  maintained cases pass. A repeated transient native post-seek difference
  recovers automatically; an unsupported room-projection diagnostic stays
  separate with actual teardown controls. Product source is unchanged, and
  this focused round does not replace the complete verification below.
- [Large beta QA — 2026-10-04](design/beta-large-qa-2026-10-04.md) —
  Full unit/coverage and browser verification, 41 new media/PRO composite cases,
  production artifacts and six Worker dry-run bundles. Two test-oracle defects
  repaired with original failures and controls preserved; product code unchanged.
  Existing security/cache promotion gates and physical-device checks remain.
- [Full local beta verification — 2026-10-03](design/beta-full-local-verification-2026-10-03.md) —
  Complete local unit/coverage, Chromium, official WebKit, production-artifact
  and Worker bundle checks on the unchanged beta code. Functional suites pass;
  existing dependency security and cache-history promotion gates remain.
- [Beta sequence QA, round 7 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-7.md) —
  No new confirmed defect in file/queue mutations, PRO prepare/commit, YouTube
  controls and UI lifetime checks. 1,348 module/Worker and 10 Chromium cases
  pass. A conditional watchdog failure remains separate because its native
  trigger is unproven; this is focused evidence, not a complete release sign-off.
- [Beta sequence QA, round 6 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-6.md) —
  SQ14–SQ15 discovery and repair: preserve the first PRO repeat/shuffle gesture,
  retry failed required reads, and retire conflicted intent without losing a
  newer gesture. Independent native-parser/Worker-body replays, 31 new regression
  tests, full unit and focused Chromium verification retain their stated limits.
- [Beta sequence QA, round 5 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-5.md) —
  SQ10–SQ13 discovery and repair: preserve file pause checkpoints, retire PRO
  field intent correctly, retain known-rejected chat drafts, and restore
  semantic YouTube playback after sharing. Original failures and independent
  revalidation preserved, with module and Chromium regressions; native-media
  and public-release limits remain explicit.
- [Beta sequence QA, round 4 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-4.md) —
  SQ07–SQ09 discovery and repair: failed-file selection retires outgoing output,
  PRO slowmode preserves drafts, and reconnect fences stale HTTP PREPARE.
  Original failures preserved; 45 new module regressions, reconciled 10,503
  unique unit passes and 75 focused Chromium passes. Cache/version and other
  release gates remain separate from beta verification.
- [Beta sequence QA, round 3 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-3.md) —
  SQ05–SQ06 discovery and repair: failed-demo settings rollback and PRO
  one-shot observation loss before heartbeat catch-up. Preserves failing evidence,
  independent reproductions and excluded reachability candidates; records fixes,
  authority/permission controls, full unit and focused browser verification.
- [Beta sequence QA, round 2 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-2.md) —
  SQ02–SQ04 discovery and repair: late resume progress rollback, obsolete file
  recovery during system-audio takeover, and pending YouTube start overriding
  a newer seek. Preserves failing evidence and records the beta fixes,
  independent reviews, cancellation controls and regression results.
- [Beta sequence QA — 2026-10-03](design/beta-sequence-qa-2026-10-03.md) —
  fresh asynchronous sequence probes; SQ01 direct-file prefix loss confirmed
  in beta and archived main, with recovery and neighboring controls. A dated
  repair addendum records the beta fix and integrated regression evidence.
- [main → beta merge-readiness audit — 2026-10-01](design/main-beta-merge-audit-2026-10-01.md) —
  full cumulative diff review and current-SHA local verification, with dependency
  audit blockers and remaining device/exact-main release gates recorded separately.
- [Beta defect harvest — 2026-09-27](design/beta-defect-harvest-2026-09-27.md) —
  discovery-only evidence, four defects confirmed at that checkout. The
  [beta release record archive](beta-release-readiness-archive-2026-10-10.md) tracks their disposition.
- [Beta defect repair — 2026-09-27](design/beta-defect-repair-2026-09-27.md) —
  follow-up repairs and regression evidence for those four defects on beta.
- [Beta defect harvest, round 2 — 2026-09-27](design/beta-defect-harvest-2026-09-27-round-2.md) —
  discovery-only evidence for three additional defects after those repairs;
  the [beta release record archive](beta-release-readiness-archive-2026-10-10.md)
  tracks their resolution and verification limits.
- [Beta defect repair, round 2 — 2026-09-27](design/beta-defect-repair-2026-09-27-round-2.md) —
  PRO playback restoration, ordered preload completion, and translation author deletion fences.
- [Beta defect harvest, round 3 — 2026-09-27](design/beta-defect-harvest-2026-09-27-round-3.md) —
  one confirmed PRO late-join playback race during live system-audio sharing;
  discovery only, with focused controls and explicit reproduction limits.
- [Beta defect harvest, round 4 and repair — 2026-09-27](design/beta-defect-harvest-2026-09-27-round-4.md) —
  no additional confirmed defects in the bounded review; repairs and verifies
  the previously discovered PRO live-share snapshot restoration race.
- [Luna combination audit and ASTRA verification — 2026-09-27](design/beta-luna-combination-audit-2026-09-27.md) —
  1,250 new local probe cases with explicit composition, outcome-variant, and
  helper counts; no new confirmed defects or product changes. Native device,
  live transport, and full E2E coverage are not implied.
- [Full project audit — 2026-07-19](full-project-audit-2026-07-19.md) — dated
  defect record with a maintained residual-boundary and verification addendum.
- [Runtime scenario verification — 2026-05-31](runtime-scenario-verification-2026-05-31.md) —
  dated origin with a maintained verification checklist.
- [TypeScript migration roadmap](typescript-migration/ROADMAP.md) and
  [status](typescript-migration/STATUS.md) — completed execution evidence; the
  migration README and guards define the surviving contract.
- [Runtime v2 prototype](design/runtime-v2-prototype.md) — partial-adoption
  design evidence, not a claim that the whole prototype is current.
- [PRO heartbeat benchmark](performance/pro-room-heartbeat-benchmark.md) —
  reproducible evidence, not an uptime or latency SLO.

## Historical archive

The following files preserve a dated baseline. Their “current” wording, counts,
line numbers, proposed phases, and test totals describe that baseline unless a
clearly labeled maintained addendum says otherwise:

- [Beta release record archive — 2026-10-10](beta-release-readiness-archive-2026-10-10.md) —
  the full beta-era promotion, QA, and release record (2026-09-27 to 2026-10-10),
  superseded by the [release record](release-record.md) and
  [release history](release-history.md)
- [Documentation truth audit — 2026-08-17](documentation-truth-audit-2026-08-17.md)
- [Project analysis — 2026-05-24](project-analysis/2026-05-24/00-index.md)
- [CSS cleanup — 2026-05-30](css-cleanup-2026-05-30.md)
- [Large source-file split design — 2026-05-30](large-file-split-design-2026-05-30.md)
- [Performance and memory audit — 2026-05-30](perf-memory-audit-2026-05-30.md)
- [Type-safety audit — 2026-05-30](type-safety-audit-2026-05-30.md)
- [Device test — 2026-06-10](device-test-2026-06-10.md)
- [Domain audit — 2026-06-10](domain-audit-2026-06-10.md)
- [Scenario audit — 2026-06-10](scenario-audit-2026-06-10.md)
- [Earlier full-project audit](full-project-audit.md)
- [Manual QA checklist](design/manual-qa-checklist.md)
- [Playback state-machine design](design/playback-state-machine.md)
- [E2E coverage notes — 2026-05-30](../e2e/COVERAGE-NOTES-2026-05-30.md)

Use Git history when an exact old implementation is needed. Do not revive a
discarded plan merely because its record remains in the repository.

## Repository policy, legal, and public copy

- [Security policy](../SECURITY.md)
- [Trademark policy](../TRADEMARKS.md), [brand/fork guide](../BRAND_POLICY.md),
  and [AGPL additional terms](../ADDITIONAL_TERMS.md)
- [Third-party notices](../THIRD-PARTY-NOTICES.md)
- Hosted design-system material under
  [`public/designsystem/`](../public/designsystem/README.md)

Files under `public/**` and hosted `.workshop/**` trees are App artifact inputs,
even when their content is documentation. Follow the App version/cache/release
path rather than the repository-only publication path.

## Source of truth and publication

For behavior claims, precedence is: production source/configuration, executable
tests/guards/manifests, maintained documents above, evidence, then historical
records. Live provider state requires a live read; never infer it from a green
source-only check.

Repository-only documentation, example configuration, GitHub workflow, and
test/guard changes that feed neither an App nor Worker bundle publish with a
reviewed GitHub `main` merge. They do not require product SemVer, a PWA
cache-epoch bump, or a Cloudflare Production Release. Hosted public copy and
runtime inputs follow the separate exact-SHA path in the canonical
[hotfix procedure](hotfix-procedure.md).

Secret-bearing local operations notes live under ignored `docs/private/` and
must never be added to Git.
