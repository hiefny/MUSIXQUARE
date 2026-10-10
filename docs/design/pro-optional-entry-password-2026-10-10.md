# PRO optional entry password — 2026-10-10

Status: production `8.8.0` / `v646` is deployed. Release
[`38045004901`](https://github.com/hiefny/MUSIXQUARE/actions/runs/38045004901)
attempt 1 succeeded at 2026-10-10 10:33:22 UTC (19:33:22 KST).

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
- Replaying an account-linked admission requires matching current account
  proof, even when the original request supplied a syntactically valid PIN.
  A legacy unlinked owner must present its owner credential. These checks
  cover both stored receipts and deterministic recovery after receipt expiry;
  an anonymous member retry stays anonymous rather than gaining authority.
- Fresh entry probes server-verified ownership even while account UI state
  is loading. An uncertain request retains its admission ID and PIN/no-PIN
  mode; pre-upgrade IDs without that mode remain PIN attempts. The mode is
  persisted before its ID and bound to that exact ID to prevent partial writes
  from changing a retry's fingerprint.
- No new dependencies, secrets, bindings, D1 schemas, or R2 policies. The DO
  field is additive, initialized fail-closed for existing state.

## Release and recovery

Product `8.8.0`, PWA cache `v646`. [PR #281](https://github.com/hiefny/MUSIXQUARE/pull/281)
merged as main `6e59d96c14ff78de8cff476b074250428007265e`. Its successful
[exact-main CI `38044634408`](https://github.com/hiefny/MUSIXQUARE/actions/runs/38044634408)
supplies the candidate for Release `38045004901`, target `all`,
`apply_developer_api_d1=false`. The exact-main candidate's 782 files were
verified. PRO deployed before App; all six Workers report this SHA at 100%,
all ten live smoke steps passed, final deployment ownership was verified,
the PRO generation marker is `ready` at this SHA, and the coherent production
commit artifact records this SHA with target `all`. Recovery was not needed.

| Target               | Deployment ID                          | Version ID (100%)                      |
| -------------------- | -------------------------------------- | -------------------------------------- |
| PRO room             | `5ff9c162-c4c0-4a6f-b036-4a3d550417cb` | `02315da2-e600-411c-8208-2b24484da51e` |
| Remote share         | `36b6a480-0fcb-4db0-b2f2-baaf17a0e6c0` | `1af55797-1733-40ed-a90b-0c3c7f840617` |
| Signaling            | `d536be33-e7b3-48eb-b0ff-f79c389a1e6d` | `aa1628cd-ee6c-459c-995f-b541f5b70201` |
| Developer API facade | `581757df-4c82-4efb-af1f-5187acd313dd` | `bd0b4771-ca61-4eb1-9468-d6a2c4ee1440` |
| Developer API        | `d2e3532e-852d-45a6-815c-a89984dac7a7` | `d29f2e31-551f-44bd-aa26-ace122a4d159` |
| App                  | `a30027a5-30f9-4720-b32c-4229d69f5e30` | `b79c8cb5-2f5a-4ce5-83b1-e9c971d4b520` |

The release log, pre-mutation checkpoint, final Worker records, readiness
record, and production commit artifact are preserved under
`scratch/pro-optional-password/`: `release-success.log`,
`release-artifacts/recovery-checkpoint/`, `release-artifacts/deployments/`, and
`release-commit/production-committed.json`. The final verification report and
all six `*-final-current.json` records agree on ownership, SHA, and percentage.
This post-release documentation update does not require another App release.

An older PRO Worker cannot safely interpret persisted public-room state. It
would reject fresh admission with a null PIN, and could preserve the unknown
false flag while writing a new PIN, which a later upgraded Worker would read as
public again. Recovery must retain the compatible PRO/App candidate once the
new contract can have been written. Do not remove the flag, install a dummy
PIN, automatically open existing rooms, or roll back below the entry-policy
contract floor. Use forward repair or a proven matched code/data recovery.
The executable marker is
`cloudflare/pro-room-entry-policy-contract-version.txt` with
`pro-room-optional-entry-password-v1`. Both release and recovery workflows
evaluate it against checkpoint and live deployment state. An unchanged old
baseline before deployment remains eligible for its normal recovery; once the
new contract may be live, automatic recovery retains the compatible PRO/App
pair. Subsequent compatible baselines may use normal rollback.

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
findings. The first [PR CI `38043975233`](https://github.com/hiefny/MUSIXQUARE/actions/runs/38043975233)
found one additional stale date in the independent localized-sitemap fixture.
Its two expected document dates were corrected without changing production
code or weakening assertions; the affected local suite passed all 15 tests.
The initial failure remains part of the evidence, rather than being described
as an uninterrupted green run.

Final [PR CI `38044325582`](https://github.com/hiefny/MUSIXQUARE/actions/runs/38044325582)
and exact-main CI `38044634408` succeeded. The exact-main run reports 531 test
files, 11,074 passed, zero failures, and one existing Windows-only
pro-grant-campaign CLI skip. The Windows local results above include that test
and have no skips; jq was also available for the separate shell-plan contract.
All four coverage suites, the 17-case production candidate suite, and the
22-case critical browser suite passed. These are the remote exact-main release
results; local branch results above are supporting evidence, not a substitute
release candidate.

Browser routes are local synthetic API fixtures; they do not consume customer
claims or change customer room settings. Physical iPhone/PWA behavior,
customer-room activation/password changes, and already-open production tabs
are outside that local verification. These are verification limits, not
uncompleted implementation or new release requirements.

After deployment, a read-only bootstrap check of the existing protected room
`000001` returned HTTP 200 for both client generations. The legacy response is
exactly `{roomCode: "000001", status: "pin_required"}`; the negotiated
`optional-v1` response adds `passwordRequired: true`. Before deployment both
requests had the legacy shape. `live-after.json` preserves the post-release
responses. This confirms the deployed policy negotiation without activating a
customer room, changing its PIN, or turning off its protection.

The release generation smoke reported `productionGenerationConverged: true`,
three consecutive reads of the expected `/assets/main-BUAdw9y5.js`, 25 assets
verified against candidate hashes, and a 437,889-byte main asset. Subsequent
read-only public GETs returned HTTP 200 for `/service-worker.js` with cache
`v646` and that main asset with the expected byte length. Their response hashes
and lengths are in `live-assets-corrected.json`; the generation/hash verdict is
in `release-success.log`.

The initial ad-hoc asset probe guessed `/sw.js` (404) and incorrectly expected
the cache marker in bootstrap. It was corrected using source-backed paths;
these were probe mistakes, not observed production failures. Public responses
and candidate convergence do not prove that an already-open tab or installed
PWA has reloaded the new code.
