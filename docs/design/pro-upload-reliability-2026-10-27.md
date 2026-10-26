# PRO upload completion and authority feedback — 2026-10-27

| Field                 | Value                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| Status                | [PR #503](https://github.com/hiefny/MUSIXQUARE/pull/503) open for owner review; not merged or deployed |
| Base                  | Initial `cb1598516`; integrated main `5dd7cc1f6` (#502, 9.0.15 / v788) in `4a99f44ba`                  |
| Proposed identity     | 9.0.16 / v790; App build floor unchanged                                                               |
| Scope                 | Browser PRO uploads, completion deadlines, bounded diagnostics, Standard/PRO authority feedback        |
| Release authorization | Owner requested a reviewable PR only; merge and deployment remain withheld                             |

## Runtime increments

1. **Keep the file copy inside R2.** Browser completion sends a bounded,
   server-authenticated CopyObject request with a durably pinned staging ETag as
   a condition. The Worker no longer reads and retransmits the full file.
   Completion retains serialized authorization, generation, quota and
   idempotency checks, a distinct final key, and final HEAD validation.
   The copy budget is 8 seconds and the completion facade budget is 10 seconds;
   both come from `cloudflare/pro-room-media-timing.ts`. Other control requests retain
   5 seconds and the browser retains its 15-second control budget.
   Developer API completion retains its existing stream-copy path. No new
   job, polling protocol, service binding or D1 schema is introduced.
2. **Resume the existing file attempt.** The queue task owns its RAM-only
   continuation. An explicit retry uses the original asset and completion
   key/body after a successful PUT; a completed asset is reused for insertion.
   Canonical reconciliation prevents duplicate queue entries. Uncertain
   completion/insertion is left to existing server orphan cleanup, not
   immediate client deletion. Reset and authority retirement release local
   state. Upload-idle deadlines remain unchanged.
3. **Explain terminal input failures.** A zero-byte or over-limit file never
   reaches reservation/PUT, carries its reason to the dialog, and is excluded
   from retry. Other selected files continue. The header distinguishes byte
   transfer from completion confirmation. Missing/expired asset continuations
   ask for file selection instead of offering an ineffective retry. New copy is
   present in 42 locales. Long failure lists reuse the reading dialog's internal
   scroll; dialog height is bounded by its actual overlay on short/mobile screens.
4. **Pending authority is not denial.** PRO account reconciliation projects
   pending feedback with no usable capabilities; confirmed revocation remains
   denied. Standard assertion work waits for the matching signaling identity
   and a fresh host roster after its ordered grant/revoke projection. Standard
   and PRO button titles/ARIA descriptions consume the same
   permission status as blocked-action toasts and refresh when it changes.
5. **Useful bounded diagnostics.** App proxy failures identify
   `media_reserve` and `media_complete` instead of `other`.
   Existing failure sampling and credential-free allowlists remain in force.

## Design evidence and safety

Cloudflare documents CopyObject and its source ETag condition in the
[S3 compatibility reference](https://developers.cloudflare.com/r2/api/s3/api/).
The [consistency reference](https://developers.cloudflare.com/r2/reference/consistency/)
explains why a negative read does not exclude a late in-flight upload. The
separate staging/final-key contract and its existing expiry/tombstone owner
therefore remain intact: a reusable upload URL cannot replace bytes returned
by an already-issued final download URL after deletion.

`RoomAsset.completionSourceEtag` is persisted before the first copy. Retries
use that same source identity; final metadata records `mxqr-copy-source-etag`.
An uncertain response never authorizes a retry from replacement staging bytes.
`StagingTombstone.finalObjectKey` lets the existing alarm cleanup also collect
a final object committed after a timed-out copy and later deletion. These are
additive private fields, not a new storage owner or public protocol.

Completion requires the creator's active authorized presence and checks
reserved bytes, MIME, room, generation, asset, version and optional SHA metadata.
It does not newly claim to hash the body. Existing R2 objects are not migrated.
The 200 MiB per-file and 1 GiB room limits are unchanged.

The upload queue remains the owner of user retries, media-transfer performs
one stage, and the room Durable Object remains the sole metadata/cleanup owner.
No independent retry scheduler is added. Header confirmation uses the
existing named loader holder (RO-47); account reconciliation remains the source
of pending authority.

## QA rounds

### 1. Production diagnosis (unchanged 9.0.14 App / a3893f04 Workers)

- Windows in-app browser, authorized PRO room, 2026-10-27 06:10 KST.
- A 171,657,316-byte WAV reached the control completion request and the UI
  reported failure. Live App logs recorded `media.complete`,
  `upstream_timeout`, `reason=response`, HTTP 502 at 06:10:53 KST.
  The same room's heartbeat recorded a response timeout at 06:10:59 KST.
- A 757,241,205-byte FLAC was rejected locally with
  `PRO_ROOM_MEDIA_UPLOAD_SIZE_INVALID`, but the UI showed only a generic
  failure count and Retry. This is a reproduced feedback defect.
- These observations prove completion-response timeout and misleading input
  feedback. They do not separately measure copy time versus queue wait.
- No production code, CORS, credentials or deployment was changed. Neither
  attempt appended a playlist row. Screenshots and sanitized logs are private;
  the public report contains no room, account, file-name or credential data.

### 2. Development and integration checks

Environment: Windows, Node 24.20.0, npm 12.0.2, Vitest 5.0.3, local Chromium.
The integration round began at `c50a0d9c8` after incorporating main `5dd7cc1f6`.
Its full run had 675/680 files and 16,099/16,112 assertions pass. Failures exposed
stale tool/fixture expectations and one unused export: runtime path mapping,
the critical-browser script list, dialog sizing, cache bootstrap parity, and
duration-test R2 metadata/copy stubs. These were corrected before the final
runtime commit. Some corrections overlapped that diagnostic run, so it is not
an immutable candidate result.

The integrated build's critical Chromium suite passed 65/65 cases, including
four new upload cases, playback, background recovery, and host/guest flows.
The file-reason dialog was also inspected on desktop and a short mobile
viewport; long lists scroll internally and the Close action remains reachable.
This local browser run preceded the last Standard authority feedback fixes;
the final-SHA CI browser gate below covers the resulting runtime.

Independent review then found two Standard feedback regressions: a pending
account assertion must not mask an existing host grant, and a trusted explicit
host revoke must end the pending state. Both were fixed with regression cases.
The final focused authority run passed 131/131 assertions in five files.

### 3. Frozen runtime verification

Tested code: `f2f25d902c1f36b0d8df7a45f3871f9e7c563104`
(9.0.16 / v790). Environment: the pinned local toolchain above, plus GitHub CI.
Later report-only commits do not change this runtime evidence.

- **Full local unit run:** 678/680 files and 16,110/16,112 assertions passed.
  Two release-tooling tests exceeded their existing 30-second and 15-second
  wall-clock limits while other local checks were running. Both passed in an
  isolated, single-worker rerun at the same SHA (2 passed; 142 unrelated cases
  skipped because the full run had already covered them). No timeout was
  increased and no product assertion failed. Thus every one of the 16,112
  assertions passed across the full run and those two isolated reruns; the
  first full invocation itself was not green.
- **Types and static checks:** typecheck, lint, formatting, App Worker syntax,
  Developer API boundary, D1 contract, operations drift contract and resource
  ownership checks passed. The ownership registry retains 48 records; the
  room-authority guard remains at 81 reads / 22 subscriptions / 13 writes after
  integration, with only the existing feedback repaint fingerprints updated.
- **Production build:** `npm run build:checked` passed, including source,
  release identity and service-worker cache guards. Eager JavaScript is
  455.7 KiB gzip; minimum budget headroom is 5%; 96 app-shell assets were built.
  This is a local artifact, not a deployment.
- **Worker bundles:** all six Worker dry-run bundles passed on the integrated
  tree; no Worker runtime changed between that check and the frozen SHA.
- **GitHub CI:** [run 40407895179](https://github.com/hiefny/MUSIXQUARE/actions/runs/40407895179)
  tests the frozen SHA. Both unit shards, critical browser gate, production
  release candidate, static checks, lint/format, types/source guards, Worker
  runtime coverage, release-tooling coverage, critical runtime coverage and
  broad unit coverage all passed: 11/11 checks. Subsequent report-only commits
  may start another CI run; the PR check state is authoritative for that head.
- **Automated review:** the [Codex review summary](https://github.com/hiefny/MUSIXQUARE/pull/503#issuecomment-6428202976)
  records completed code review at this SHA with no findings. This is not a
  claim that a separate security review ran.

Local logs and screenshots remain in ignored private notes. Neither local
results nor PR CI replace the exact-main-SHA candidate required after merge.

## Release and recovery

- App and PRO Worker changes require the normal coordinated `all` release
  after owner review, merge, and exact-main CI. No release is authorized here.
- No CORS change, new secret, dependency, service binding, D1 migration,
  or API response shape. The private asset and cleanup records gain the optional
  fields described above. CopyObject uses the existing
  server-only R2 credentials and its response is never exposed to browsers.
- Reverting App restores whole-file retry behavior without changing ready media.
  Prefer a forward fix for the PRO Worker when copies have uncertain outcomes:
  older Workers do not enforce the pinned source or collect late final objects
  through the new tombstone field. A Worker rollback requires accounting for
  outstanding copies and their cleanup first; unchanged object keys alone are
  not evidence that rollback is safe.
- Browser retry continuation is session-local, not a persistent resumable
  upload protocol. Closing/reloading the document discards it.
- Developer API completion still copies; this PR addresses the reported
  browser upload path.

## Limits and deferred live confirmation

The changed code is not deployed. Production success for the previously failing
large file and production CopyObject latency are not claimed. R2 internal copy
can still fail or exceed its bounded deadline; explicit completion retry safely
recovers a final object whose response was lost. Deterministic Worker and browser
tests exercise those contracts locally. Copy completion remains serialized in
the existing room mutation owner, so concurrent control requests may still wait;
this PR does not claim to eliminate every heartbeat timeout. In particular,
post-merge production validation must use the final released SHA. Existing
playback behavior is covered by regression tests, not by a new multi-device
audio or mobile soak run.
