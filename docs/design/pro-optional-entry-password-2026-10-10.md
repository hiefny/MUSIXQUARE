# PRO optional entry password — 2026-10-10

## Scope

The owner approved optional PRO entry passwords and production deployment.
New activations confirm the signed-in account and create a public room without
a PIN prompt. Existing rooms retain their current protection until their owner
disables it. PRO owners enable or change protection with a manually chosen
eight-digit password; Standard rooms retain random password generation.

The room code remains a public address. Entry policy does not grant ownership,
controller capabilities, upload authority, or Developer API privileges. A
verified current owner account can enter a protected room without its PIN and
reset the password in settings. An ordinary signed-in member cannot do so.

## Contracts and compatibility

- Persist explicit `passwordRequired`; absent historical values mean `true`.
  Never infer public admission from a null PIN, which also occurs during owner
  lifecycle transitions.
- New clients opt in with `X-MXQR-Pro-Entry-Policy: optional-v1`. Public bootstrap
  uses `open` with `passwordRequired: false`; snapshots include flat
  `passwordRequired`. Legacy clients retain
  their exact response shapes and may still show a PIN prompt for a public
  room. Their valid eight-digit input grants ordinary public admission only.
- New activation omits PIN fields and retains claim validation, confirmed
  account scope, entitlement checks, one-time consumption, and account fences.
  Valid legacy activation requests still create a protected room.
- Owner-only `POST /pin` accepts null to disable or eight digits to enable/change.
  Disable preserves live sessions and playback. Enable/change preserves the
  existing authentication-epoch revocation behavior.
- Public admission retains bounded requests, stable request-ID receipts,
  session cookies, presence requirements, capacity limits, and existing
  activation/security rate limits.
  App actor hints accept the exact no-PIN request shape without accepting
  client-spoofed authority headers.
- No new dependencies, secrets, bindings, D1 schemas, or R2 policies. The DO
  field is additive, initialized fail-closed for existing state.

## Release and recovery

Product `8.8.0`, PWA cache `v646`. Deploy `all` with Developer API D1 application
disabled, using a successful exact-main-SHA CI candidate and the normal release
checkpoint/live-smoke process. PRO must deploy before App.

An older PRO Worker cannot safely interpret persisted public-room state. It
would reject fresh admission with a null PIN, and could preserve the unknown
false flag while writing a new PIN, which a later upgraded Worker would read as
public again. Recovery must retain the compatible PRO/App candidate once the
new contract can have been written. Do not remove the flag, install a dummy
PIN, automatically open existing rooms, or roll back below the entry-policy
contract floor. Use forward repair or a proven matched code/data recovery.

## Verification

Implementation code is `835be57ca6281f0106e13d67c756183b48328889` on
`agent/pro-optional-entry-password`, based on main `6ec501c1`.
Windows local verification uses Node 24.20.0 / npm 12.0.2 and the
existing jq executable for the real shell-plan contract test.

- Full unit run followed by replacement of affected-file results: 531 files,
  11,075 passed, zero failures/skips. The final replacements include 345 PRO
  Worker tests and 827 affected App/client/UI/tooling tests.
- The initial full run found four contract mismatches: obsolete client
  bootstrap-PIN helper, public-document dates/sitemap (two assertions), and the
  bootstrap cache URL mirror. Removed the unused helper and updated the actual
  documents, generated sitemap, and cache URL; affected tests now pass.
- Independent review identified account-linked admission replay after logout
  or account switching. Both stored-receipt and receipt-pruned recovery paths
  now require matching fresh account proof. Legacy unlinked owner replay also
  requires its owner credential. Public/protected and omitted/string-PIN
  variants are covered; anonymous member retry deduplication is retained.
- Real API-client-to-DO tests cover new activation cookies, negotiated
  bootstrap/snapshot parsing, public admission, owner enable/disable, member
  refusal without a PIN, and re-entry. Lifecycle coverage includes persistence
  failure, suspend/resume, owner deletion, recovery, and transfer.
- Full typecheck, lint, formatting, App syntax, Developer API/D1/operations
  guards, source complexity, and room-authority guards pass. Recovery-floor
  tests cover an untouched baseline, partially deployed candidate, missing or
  truncated checkpoints, and later compatible rollback.

- Chromium: 26 unique cases passed after correcting an activation fixture that
  confused the device label with the account nickname. The four new entry and
  owner-settings cases passed on their first run; the corrected activation
  suite passed all 12 cases. Account scope and exact no-PIN body checks remain.
- Current-tree iPhone WebKit: 19 passed, zero failed/skipped. Covers account
  confirmation in Korean/English at 320–1180 px, public/protected admission,
  manual password dialogs, owner toggles, cancellation, and error restoration
  at 390/1280 px. This is browser-engine simulation, not physical iPhone or
  live Cloudflare room verification.
- Final setup-flow suite: 63 passed, including the pre-upgrade pending request
  ID with no admission-mode field. Whole affected-file counts above are not
  added a second time for overlapping runs.

Committed production build at `735bc8cc` and its production-browser candidate
suite (17 passed) completed. PR #281 automatic review completed with no inline
findings. The first PR CI (`38043975233`) found one additional stale date in the
independent localized-sitemap fixture; update its two expected document dates
without changing production code or weakening assertions. Its other lanes
passed. Final PR CI, exact-main CI, and production release remain pending.
Browser routes are local synthetic API fixtures; they do not consume customer
claims or change customer room settings.
