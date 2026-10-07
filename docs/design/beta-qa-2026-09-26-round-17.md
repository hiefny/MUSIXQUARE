# Beta QA — 2026-09-26, round 17

Baseline: `mxqr_beta` at `fef1cfe8`. Scope: reconnect, late join, session and
authority replacement, background recovery, and asynchronous media preparation
across standard rooms, PRO rooms, demo mode, and system-audio sharing.

## Confirmed finding

### Foreground wake-lock recovery could be lost behind an older native request

Setup requests the native screen wake lock. Foreground visibility and background
recovery call `reacquireWakeLockIfActive()`, but an existing pending request made
that call return without recording the recovery intent. If the older native
request subsequently rejected or returned an already-released sentinel, no
active lock remained. Its completion retried only when a deactivate/activate
transition had changed the session generation. Returning to the foreground
does not itself change that generation.

This could leave a session without the requested screen-sleep protection until
another explicit recovery event. It is not evidence that this race caused a
reported audio or network disconnection, and the correction cannot override a
browser or operating system that denies wake locks.

The state machine now retains one explicit foreground recovery while a native
request is pending. The exact owning request consumes that intent on completion.
An already-live sentinel still prevents duplicate acquisition. Deactivation and
test reset retire the pending intent; a rejected replacement does not schedule
another attempt without a new explicit recovery. The existing session-generation
check still releases obsolete native results before serving a new activation.

Four new cases cover rejected and already-released original results, coalesced
foreground requests followed by a denied replacement, and deactivation before
settlement. Three failed before the product fix. Existing assertions were also
strengthened to check successful acquisition deduplication and the absence of
automatic retries after an ordinary policy denial. The wake-lock and background
recovery suites pass all 26 tests after the change. An independent reviewer
checked the production callers, pending intent ownership, and failure behavior.

These regressions hold the real API boundary represented by a controlled
`navigator.wakeLock.request()` promise. They do not suspend synchronous app
functions, and they do not claim reproduction on a physical iPhone.

## Other investigation

- Standard-room admission, bootstrap, exact-connection recovery, HTTP/RTC
  signaling, late join, and media catch-up: 13 existing suites, 277 tests passed.
  A focused Cloudflare run intentionally excluded 141 unrelated cases. No new
  defect was confirmed; late callbacks and file reads retain connection, session,
  and source ownership checks.
- PRO session/account replacement, bridge tickets, download cancellation,
  canonical media identity, native preparation cancellation, and preload reorder:
  six existing suites, 141 tests passed. Session epochs, presence incarnations,
  download leases, and exact-owner cleanup block the examined stale completions.
- Demo and system-audio capture/receive/recovery: 12 existing suites, 278 tests
  passed. Reviewed native picker and audio initialization completion, track end,
  stop/leave, replacement receiver ownership, demo decoding/restoration, and
  output recovery. No additional actionable issue was confirmed.
- UI setup, guest/host recovery, YouTube entry gating, connection sessions,
  account dialogs, and player controls: seven existing suites, 226 tests passed.
  Reviewed setup generations, QR acquisition cleanup, dialog lifetime, and manual
  sync request identity. No product change was needed in these paths.

## Verification

- Full unit run: **479 files passed; 9,802 tests passed, 1 skipped**. All four new
  cases ran. The existing deployment-artifact classifier test skips locally
  without `jq`; this environment limitation is unchanged.
- Local Chromium: **10 checks passed**, covering background file-output recovery,
  guest disconnection/rejoin, and demo pause/resume, late join, superseded download,
  and decoder retry. They use the local app, signaling, and media fixtures.
- Full repository typecheck, app/tooling lint, changed TypeScript formatting,
  and `git diff --check` passed.
- Seven source guards passed: import graph, dead exports, bus pairing, lifecycle
  writes, source complexity, room authority, and chunk pump.
- Production build and eight artifact guards passed: production hooks/security,
  legacy TV, service worker, UI kit, initial transfer budget, fonts, and app shell.
  Building artifacts locally does not deploy them.

## Limits

PRO and native-failure races use controlled HTTP/browser API fixtures. This round
does not measure physical-device screen sleep, live service behavior, or acoustic
sync precision, and does not claim all possible event interleavings are covered.

Work stays on `mxqr_beta`. UI, room policy, app **8.6.61**, and cache **v630** stay
unchanged. No main advancement, production deployment, pull request, or Operations
Drift Audit re-enablement is part of this round.
