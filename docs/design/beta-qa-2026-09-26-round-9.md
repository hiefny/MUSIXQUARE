# Beta QA — 2026-09-26, round 9

Baseline: `mxqr_beta` at `02ac5f10`. Scope: late work after standard-room
disconnect, PRO room replacement or permission changes, demo exit, and pending
native/bounded file decoding. Work stays on beta without a production deployment
or app/cache version change.

## Confirmed finding

### A retired FILE_WAIT timer could repaint remote-file failure after disconnect

A remote guest can receive a correlated FILE_WAIT while the host has no file
ready. If that connection closes or errors before the ten-second deadline, the
real guest handler clears `hostConn` and the setup error handler stops media and
opens the terminal disconnect dialog. The pending file request and wait timer
can still exist while that dialog is open.

The timer checked request identity but entered its remote-unavailable fallback
before checking the exact current host connection. It therefore displayed a
new remote-file error toast, reset loader state, and rewrote track metadata after
the room had already disconnected. The later connection check only guarded the
local recovery branch.

The timer now validates both request identity and its exact live host connection
before any fallback or recovery side effect. The remote fallback, retry delay,
and same-connection recovery policy are otherwise unchanged. No UI copy, layout,
transport protocol, or room permission policy changes were needed.

The regression exercises real `joinSession` close/error handlers, `initSetup`
network-error handling, `stopAllMedia`, and the managed FILE_WAIT timer. Transport
events and UI renderers are controlled. On the baseline, both terminal outcomes
incorrectly called `showToast('share.remote.unavailable')`; four control cases
passed. The controls cover a live remote fallback, recovery on the same
connection, a superseding request, and request-authority reset.

## Other investigation

- Standard-room receive, recovery, request correlation, and connection
  replacement: eight focused suites, **190 passed**, including the six
  FILE_WAIT cases. No additional receive or recovery defect was confirmed.
- Native/bounded resource ownership, late decode completion, output recovery,
  and concurrency invariants: seven focused suites, **289 passed**, without a
  new engine defect.
- Demo entry, late fetch/decode/play, exit, and settings restoration: five
  focused suites, **99 passed**, without a new confirmed defect. The host-leave
  flow normally navigates away; a hypothetical failed navigation was not
  counted as a reproducible surviving-demo bug.
- PRO API/socket completion, file-source resolution, queued commands, and
  room/account leases: five suites with a lifecycle filter, **93 passed**;
  118 tests outside that filter were not run in this focused check. Existing
  generation, room, asset, abort, and operation-epoch checks covered the
  inspected cases. No PRO source change was required.
- Two new Chromium checks hold a real guest MP3 decoder completion across
  terminal host departure. A late valid AudioBuffer and a simulated native
  EncodingError must both leave the guest idle, without a published file,
  new output start, or failed-track mark. They passed on unchanged application
  code and are additional coverage, not additional product findings.

## Verification

- Independent review confirmed that the moved check covers remote UI side
  effects without changing ownership, recovery delay, or same-connection ICE
  recovery. The callback contains no intervening asynchronous boundary, so
  removing its now-redundant downstream connection check is safe.
- Final Chromium selection: **12 passed**, covering terminal disconnect with
  late decode success/failure, departure and replacement guests, confirmed
  leave, foreground output recovery, and demo download/playback recovery.
  Ten existing cases passed before the product correction; the two new cases
  also passed on that baseline after correcting their setup to explicitly
  start host playback and use terminal RTC closure.
- Full repository typecheck and lint passed. Import graph, dead exports, bus
  pairing, lifecycle writes, source complexity, room-authority boundary, and
  shared chunk-pump guards passed without baseline changes.
- Local production-mode build and eight artifact guards passed: test-hook
  exclusion, security configuration, legacy TV syntax, service worker, UI kit,
  transfer budget, fonts, and app-shell completeness. App `8.6.61` and cache
  `v630` are unchanged; the build check did not deploy production.
- Full unit suite: **466 files, 9,706 passed, 1 skipped**, including six new
  FILE_WAIT tests. The existing release-deployment-state case needs `jq`,
  unavailable in this Windows environment; CI does not permit that skip.

## Limits

Browser checks use local Chromium and PeerJS signaling. The decoder completion
is deliberately delayed; the real RTC connection is explicitly closed before
disposing the host context, so these checks isolate terminal teardown rather
than ICE timeout duration after abrupt process loss. They do not establish
physical-device sync accuracy, iPhone behavior, or production network recovery
timing. PRO checks use controlled API responses rather than live Cloudflare.
Beta pushes do not trigger the main-only CI workflow or deploy production.
