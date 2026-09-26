# Beta QA — 2026-09-26, round 7

Baseline: `mxqr_beta` at `30b07da4`. Scope: delayed file reads, upload
cancellation and replacement, administrator authority changes, delayed YouTube
search/playlist responses, and PRO upload/chat session ownership. Work stays on
beta without a production deployment or app/cache version change.

## Confirmed finding

A standard-room administrator's cancelled upload retained the active sender
slots while an in-progress `Blob.arrayBuffer()` read was still pending. Losing
upload authority or replacing the host correctly marked the batch cancelled,
but releasing the slots depended on that uncancellable read returning. A valid
new upload after regrant or host replacement was therefore rejected as
`host-busy`. The delay could outlast the cancelled session's useful lifetime.

Cancellation now releases the batch and file owner slots immediately, before
sending abort/progress events. The old operation keeps its cancelled batch and
failure state. Existing chunk-pump predicates check cancellation after the
file read; existing identity checks in cleanup preserve any replacement owner.
No transport protocol, permission policy, UI, or retry policy changed.

## Reproduction and review

- The initial unit regression failed on the baseline: the replacement host
  received zero new upload START messages instead of one while the cancelled
  file read remained pending.
- Four regression variants cover host replacement and revoke/regrant, each
  with late read resolution or rejection. The replacement's first file is
  deliberately waiting for its final ACK when old cleanup runs. Its ACK,
  subsequent file, progress, and batch summary must all survive that cleanup.
- Two adjacent cases verify a late final ACK after revocation and trailing
  receiver frames after room reset. These are additional passing coverage,
  not separate newly discovered defects.
- The browser regression uses two independent Chromium contexts and local
  signaling, actual administrator grant/revoke UI, real MP3 fixtures, and the
  real file-transfer pump. It delays only the first file chunk's asynchronous
  read. On the baseline, a second selection after regrant left the host's
  playlist empty. The corrected build admits that second file; releasing the
  retired read does not append the old file to either peer's playlist.
- Independent review checked event reentrancy, late cleanup, status response
  identity, and cancellation after chunk reads. No additional change was
  required.

## Other investigation

- Added two YouTube response-body tests: search replacement while the old
  streamed-body cancellation is pending, and closing/reopening the same
  playlist preview while its old metadata and manifest bodies are pending.
  Both passed on unchanged application code. The search suite passed 61 tests;
  public metadata caching did not require a new room-scoped policy.
- Reviewed PRO upload queue cancellation, retry-dialog ownership, playlist
  commit/reconciliation, and chat/bot session lifetime. Seven focused suites
  passed 158 tests. No separate production defect was confirmed.

## Verification

- Final Chromium selection: **22 passed**, including the new cancellation
  regression, standard file transfer, administrator grant/revoke, YouTube
  search interactions, chat link splitting, and browser upload signing.
  Eleven of these also passed on the baseline; they are not additional
  distinct cases.
- Full repository typecheck and lint passed. Import graph, dead exports, bus
  pairing, lifecycle writes, source complexity, room-authority boundary, and
  shared chunk-pump guards passed without baseline changes.
- Final full unit suite: **464 files, 9,687 passed, 1 skipped**, including eight
  new tests. The existing release-deployment-state case needs `jq`, which is
  unavailable in this Windows environment; CI does not permit that skip.
- Local production-mode build and eight artifact guards passed: test-hook
  exclusion, security configuration, legacy TV syntax, service worker, UI kit,
  transfer budget, fonts, and app-shell completeness. App `8.6.61` and cache
  `v630` are unchanged; this build check did not deploy production.

## Limits

The browser regression controls the duration of a real asynchronous Blob
read; it demonstrates correctness across that boundary, not the frequency of
slow disk/cloud-backed file reads in use. Browser checks use local Chromium
and signaling with test service responses. They do not establish live
Cloudflare behavior, physical-device performance, or iPhone/WebKit behavior.
Beta pushes do not trigger the main-only CI workflow or deploy production.
