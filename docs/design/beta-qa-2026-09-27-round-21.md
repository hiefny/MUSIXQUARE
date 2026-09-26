# Beta QA round 21 — local output versus pending transport

Date: 2026-09-27 (KST)

Branch: `mxqr_beta`

Baseline: `5cca7d3aaf7371043cedde2cfe927fc32ee895a4`

## Scope and method

This round reviewed media transition boundaries, demo and manual-sync controls,
account/session ordering, playlist interactions, and system-audio capture.
Three independent review lanes reproduced candidates before proposing changes.
The primary agent made product changes; a second agent added playback
regressions and the other reviewers checked ownership and recovery behavior.

One playback-intent defect was confirmed and fixed across two caller paths.
A separate account-cookie response race was confirmed and remains unresolved;
this report does not classify that finding as fixed or owner-accepted.

## Fixed: local output refresh could replace a pending seek

### Manual sync during decoding or AudioContext setup

While a file seek was preparing, manual nudge, numeric offset edits and sync
reset called `play()` with a local-output request. The shared play lock treated
that request as a newer transport command: it advanced the recovery generation,
overwrote the queued intent and aborted indexed PCM preparation.

In a standard room, the replacement discarded the canonical-rebase timing and
the host's post-start `PLAY` publication callback. The host could start at the
new position while guests remained paused or relied on later drift recovery.
With an ordinary AudioBuffer waiting for its context to resume, the local
request could also capture the old position and replace a queued newer seek.
In PRO, it could cancel the authoritative seek completion and resume the old
position instead of the scheduled position.

Local-output requests now yield to a consistent, watchdog-protected preparing
owner or its queued successor, before changing recovery generations or the
mailbox. The existing native-buffer start reads the latest offset after setup;
bounded playback rechecks it after PCM preparation. The queued canonical
position, deadline, authority predicate and completion callback stay together.
The unlock-to-mailbox microtask handoff is protected as well. A local change
after source commitment can still queue the required replay.

A slow-preparation probe caught a remaining defect in the first implementation:
after five seconds, the ordinary stale-lock recovery path still let the local
edit cancel the canonical seek. A valid pending owner now absorbs local edits
even beyond that threshold. Real transport commands, explicit foreground
recovery, inconsistent/missing-watchdog locks and the original fifteen-second
watchdog retain their recovery paths. Offset edits do not extend the watchdog.

### Background output recovery during a seek

The standard-host local-output rejoin path emitted
`playback:refresh-current-position`, which called `play()` as an ordinary
transport request. It could replace the same pending seek and lose its room
publication. This call is now explicitly `outputOnly`, using the same ownership
rule rather than a separate seek-specific exception.

### Evidence and regression controls

Seventeen cases were added to `transport-large-file.test.ts`, which now passes
51 cases. Eight failures were captured before the source fix; three more slow
preparation failures were captured against its intermediate version.

- Nudge, numeric edit, reset and a no-input control during fast and slow PCM
  preparation.
- Actual `BoundedAudioTrack`, `BoundedPlayback` and large-file source execution,
  holding an async PCM-reader boundary during manual edits and background rejoin.
- Native-buffer transport with a suspended AudioContext setup, including a
  second queued canonical seek.
- PRO scheduled seek completion and its existing start deadline.
- Pause, YouTube and system-audio takeover after a local edit.
- An unchanged watchdog handle and original timeout, with late PCM completion
  remaining unable to restart the retired request.

Audio hardware is modeled. The bounded reader supplies PCM fixtures; these
tests do not measure physical audio alignment or decoder throughput.

## Open finding: late account responses can erase a newer browser login

**P2 reliability issue, not fixed in this round.** A native Chromium probe
reproduced this ordering with two tabs sharing the same cookie store:

1. Authenticate session A and send a logout request.
2. Let the actual Worker revoke A, but hold its successful HTTP response.
3. In the sibling tab, create session B through the actual session-mint and
   cookie-writing functions used by OAuth. Verify B is authenticated.
4. Release A's response. Its fixed-name `Set-Cookie` expiry removes B's cookie.
5. The browser becomes anonymous even though B's server session remains valid.

The healthy ordering, where A's response lands before B is installed, preserves
B. The primary agent independently reran both schedules. The fixture uses the
actual account-auth handler and tracked SQLite schema, but bypasses Google
verification at the OAuth session-commit boundary; it is not a full OAuth test.
All requests were intercepted locally, with no production traffic.

Related response writers require consideration: invalid session/authorization
responses and anonymous standard-room assertions clear the same cookie, while
account-deletion replies can replace it with a shortened deletion-proof token.
Those adjacent paths were identified by code review, not all independently
reproduced in a browser.

Omitting only logout cleanup is incomplete. Making OAuth the sole cookie writer
would retain revoked opaque cookies until their original expiry and alter the
existing deletion-token retention contract. Client generation checks cannot
prevent the browser from applying an already-delayed HttpOnly cookie header.

A session-scoped cookie protocol could target only the predecessor, but needs
reviewed active-session selection, predecessor pruning, legacy compatibility,
bounded cookie counts and deletion-proof behavior. In particular, logging out
the newest session must not accidentally reveal an older valid cookie as a
fallback login. That protocol work remains separate; this round does not
silently change cleanup or retention policy. Server revocation remains effective;
the probe demonstrated neither unauthorized access nor persistent account-data
loss.

## Other reviewed areas

- Demo loading, exit/re-entry, authority changes, effect restoration, manual
  drafts and focus, and shared volume UI: **319 tests in 12 files** passed.
  A lazy-import suspicion was rejected: the actual `playTrack()` transition
  suppressed the stale Sync click and a fresh click on the successor succeeded.
- Account identity/API and signaling session ownership: **517 tests in 17
  files** passed. Existing signaling epoch/sequence fences correctly reject
  older tickets before replacing the current connection.
- Playlist removal/reordering, focus/drop interactions, capture ownership and
  system-audio delivery: **246 tests in ten files** passed. No additional
  verified defect. A mocked asynchronous stop was not treated as evidence of
  a race in the actual synchronous media-stop implementation.
- Final playback regression slice: **390 tests in 12 files** passed.
  YouTube-focused review passed **323 tests in nine files**. Independent
  lock/recovery review passed **27 selected tests** against the final change.

Focused counts overlap and are not additional unique full-suite totals.
Local evidence is under ignored `scratch/qa-beta-round21-2026-09-27/`.

## Final verification and publication

- Full unit run: **482 files passed; 9,885 tests passed, one skipped**.
  The existing deployment-artifact classifier case skips locally without `jq`;
  no new test is skipped. The run used four parallel workers without relaxing
  assertions or timeouts.
- Full repository typecheck passed, followed by a test-project typecheck after
  the last watchdog case was added. App/tooling lint, changed-file formatting
  and diff checks passed.
- Eight source guards passed: import graph, dead exports, bus pairing,
  lifecycle writes, source complexity, standard-room hot path, room authority
  and chunk pump.
- A local production build and eight artifact guards passed: production hooks,
  security, legacy TV, service worker, UI kit, initial transfer budget, fonts
  and app shell. The shell check verified 90 assets. The build was not deployed.
- `main`, `origin/main` and the remote main branch remain at
  `35759e8b07f1ee0b272afbd0af03c770a858889e`. Operations Drift Audit remains
  `disabled_manually`.

The competition freeze remains active. Work is committed and pushed only to
`mxqr_beta`; no PR, main advancement or production deployment is authorized.
UI design, room policy, app **8.6.61** and cache **v630** remain unchanged.
These controlled tests do not certify every physical device, network handover,
acoustic outcome or possible interleaving, and the account-cookie finding above
remains open.
