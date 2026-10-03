# Beta sequence QA, round 4 — 2026-10-03

| Field | Value |
| --- | --- |
| Status | Dated discovery evidence with repair addendum — SQ07–SQ09 repaired and verified |
| Tested checkout | `mxqr_beta`, `ed6552805d57ccd30bfc64a5dfa474ba0378c729` |
| Product/test code | `d4dd4bbb94c58624f50887d12dc5dd017fb95f7a` — includes SQ05–SQ06 repairs |
| Main reference | `35759e8b07f1ee0b272afbd0af03c770a858889e` |
| Environment | Windows, pinned Node 24.20.0, Vitest/jsdom, local Chromium and PeerJS; controlled external service/media boundaries |
| Related records | [Living release record](../beta-release-readiness.md), [previous discovery and repairs](beta-sequence-qa-2026-10-03-round-3.md) |

## Result and scope

The original discovery record below is preserved at its original checkout.
Current resolution and tested repair SHA are in the
[repair addendum](#repair-addendum--2026-10-03).

**Three new defects were confirmed and independently checked.** This round
examined local decoder failure and later selections, PRO reconnect/command
ordering, chat moderation versus local submission, demo/settings ownership and
UI projection, and cancellation of asynchronous YouTube searches. Product code
and tracked tests were not changed. Only evidence records are committed and
pushed to beta; main, production and the disabled Operations Drift Audit remain
unchanged.

| ID | Priority | Confirmed effect | Verified scope |
| --- | --- | --- | --- |
| SQ07 | P2 | Returning to an occurrence that failed on a guest leaves that guest playing the previous healthy track | Standard room, file A failed locally → healthy file B → host selects A again |
| SQ08 | P2 | PRO owner/controller sees a sent bubble and loses the draft for a message silently rejected by slowmode | Two ordinary chat messages within the configured interval; UI and server policy disagree |
| SQ09 | P2 | A delayed command response revives obsolete preparation after reconnect and cancels the current preparation | PRO playing YouTube, two authorized seeks, missed CANCEL during socket outage, delayed older HTTP body |

These are three causes, not seven issues inferred from failed assertions.
Earlier SQ01–SQ06 remain repaired. No introduction commit was bisected and no
production incidence or physical-device prevalence was measured.

## SQ07 — failed file revisit leaves the outgoing track playing

A guest's bounded decoder fails while playing A, and the actual transport error
callback records that queue occurrence as unavailable on this device. The host
can still play A. The room subsequently plays healthy B. When the host selects A
again, the guest ignores its FILE_PREPARE, FILE_START and PLAY before stopping B
or selecting A. The installed B source, playing state and selected B row remain.

The early guards are in [PLAY admission](../../src/player/playback.ts) at line
316 and [transfer receive](../../src/storage/transfer-receive.ts) at lines 853
and 1335. Rejecting another decode attempt is intentional; letting the outgoing
track continue under a different authoritative selection is not. The host's
[selection path](../../src/player/playlist.ts) at line 1345 explicitly publishes
PREPARE before loading so guests stop the old track and show the new selection.

The reproduction uses the actual failure callback, real protocol/transfer/PLAY
handlers and real host PREPARE/PLAY generation. Normal PREPARE-first order
reproduces it; unusual packet reordering is not required. B's completed native
audio resource and native output are fixtures, not a physical download/speaker
test. Repeated commands while already waiting on failed A correctly avoid
re-decoding. An unfailed C stops B; stale sessions and unauthorized messages
correctly preserve B.

Nine new probes: **5 pass / 4 fail**, all four failures share this cause. The
primary agent independently reproduced the same results. Existing PRO failed
revisit handling (`invalidateUnavailableAuthoritativePlayback` in playlist.ts)
and its tracked regressions pass; this finding is not expanded to PRO, remote
R2 delivery or demo without corresponding evidence.

## SQ08 — PRO slowmode reports local success for dropped messages

With a two-second slowmode, an owner or controller sends two distinct ordinary
messages 600 ms apart. The actual [chat UI](../../src/ui/chat.ts) exempts those
roles at lines 1179–1186. It renders each outgoing bubble, sends it and clears
the draft at lines 1230–1280. The [signaling Worker](../../cloudflare/signaling-worker.ts)
applies slowmode to every ordinary PRO message at lines 7079–7087. It silently
drops the second; there is no rejection acknowledgement to correct the sender's
bubble or restore its draft. The bridge only serializes and sends the frame.

The Worker reproduction joins participants with signed tickets and configures
slowmode through a separate authorized moderator's public WebSocket command.
The UI reproduction uses valid owner/controller/member state projection and
the actual submission/DOM modules with transport captured. Both ordinary
members' local gate and slowmode-OFF controls pass; the server accepts another
message once the interval expires. These are controlled module boundaries, not
a live PRO chat trial.

Twelve probes: **10 pass / 2 fail**, with an independent replay agreeing. The
two failures are the owner and controller manifestations of one mismatch.
Existing Worker tests intentionally rate-limit the owner. Repair must align
the local behavior with the chosen existing contract; this finding does not
authorize inventing a server exemption. Whispers are deliberately exempt from
freeze/slowmode in the existing implementation and are not counted as a bypass.

## SQ09 — an obsolete PREPARE returns after reconnect

A playing PRO participant seeks to 30 seconds. It receives WebSocket PREPARE A,
but the matching HTTP response body is delayed. Its socket disconnects. Another
authorized device seeks to 80 seconds; the server cancels A and creates B with
the same committed base revision and next target revision. The first device
misses CANCEL A while offline. Its replacement signaling ticket correctly
contains B, which it prepares. The old HTTP body then finishes and revives A,
cancelling B's preparation.

[The controller](../../src/pro-room/playback-controller.ts) accepts the delayed
HTTP PREPARE at lines 1439–1445. Its PREPARE gate at lines 711–742 accepts another
transition with the same base revision unless its CANCEL was observed. Control
channel recovery at lines 2310–2320 retires the active preparation but does not
fence that in-flight HTTP response. Actual media cancellation invalidates the
load/preparation, so this is discarded preparation work and a path to repeated
seeking/buffering, not merely an obsolete log entry.

The actual join/runtime/API bounded reader/network bridge and reconnect path
reproduce **A → B → A** preparation and cancellation of B. A control that
receives CANCEL A before disconnect stays on B. A subsequent valid B COMMIT
recovers to B, giving **A → B → A → B**, with the final position at least 80
seconds. **Permanent stalling and acoustic desynchronization were not proved.**

Two client probes: **1 pass / 1 fail**. A separate public Worker fetch probe
passes and demonstrates playing selection, two owner devices, seek A/B,
unchanged base/target revisions, CANCEL A, ticket B and rejection of old A READY.
The primary agent independently reran both. The client uses a controlled media
endpoint; the server fixture uses in-memory persistence and a signaling recorder.

## Verification and limits

| Check | Result / interpretation |
| --- | --- |
| New executed module probes | 52 total: 45 pass / 7 fail for the three causes; includes 28 passing demo/session controls and one passing Worker reachability probe |
| Worker reachability filter | One new case executed; 312 copied existing cases excluded by name filter, not counted as passing or executed |
| Existing focused unit/Worker controls | 30 unique files / 975 pass / 0 fail / 0 skip: chat/UI/signaling 617, audio/PRO failure 245, PRO playback/bridge 113 |
| New Chromium search sequences | 8 pass: clear, replace query, close/reopen and switch to URL, each with a late old success/error response |
| Existing Chromium controls | 37 pass: search interactions, chat commands, queue operations, disconnect/rejoin |
| Browser execution | 45 total pass / 0 fail / 0 skip / 0 flaky; retries 0 |
| Build | E2E build passes; no production build/deployment in this discovery round |

The demo/session matrix covers four effects, loading/loaded states, settings
sync ON/OFF, OFF→ON, operator grant/revoke/partial capabilities, host connection
replacement, queued demo track updates, and actual settings sliders/labels.
No new defect was confirmed in those 28 cases. Directly replacing a non-null
host connection was not treated as a real reconnect trace: production first
clears the old connection. Demo-local guest effects are an intentional policy.

Early scratch harness failures are preserved separately: a held browser route
was cancelled before it had actually started, repeated fake-clock timestamps
contaminated a module-local send guard, and PRO paused seek was initially used
where the server correctly performs a direct commit. Final probes explicitly
wait for route entry, isolate clocks and use playing seeks. None of these
harness failures is counted as a product defect. No production assertion or
tracked test was weakened.

This was targeted discovery, not a whole-unit, whole-E2E, coverage, WebKit,
security-audit, live-service or physical-device rerun. Native audio/YouTube and
provider boundaries are controlled. Historical results remain tied to their
original SHA/date, not added to this round's totals.

## Evidence and remaining work

Ignored evidence root: `scratch/qa4-2026-10-03/`:

- `audio/failed-revisit.test.ts`, `root-results.json`, `controls-results.json`, `REPORT.txt`.
- `chat/{ui,server}.test.ts`, `verified-results.json`, `independent-results.json`, `controls.json`, `REPORT.md`.
- `pro/prepare-reconnect.test.ts`, `root-client-results.json`, `server-reachability.test.ts`, `root-server-results.json`, `server-generated.json`, `client-sequence-{false,true}.json`, `controls.json`, `report.md`.
- `session/matrix.test.ts`, `root-results.json`, `report.json`.
- `browser/search-sequences.test.ts`, `browser/final-sequences.json`, `browser-controls.json`, `build-e2e.log`, `summary.json`.

From the repository root, with the pinned Node 24.20.0 directory on PATH:

```powershell
node node_modules/vitest/vitest.mjs run --config scratch/qa4-2026-10-03/audio/vitest.config.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config scratch/qa4-2026-10-03/chat/vitest.config.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config scratch/qa4-2026-10-03/session/vitest.config.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config scratch/qa4-2026-10-03/pro/vitest.config.ts scratch/qa4-2026-10-03/pro/prepare-reconnect.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config scratch/qa4-2026-10-03/pro/vitest.config.ts scratch/qa4-2026-10-03/pro/server-reachability.test.ts -t 'QA4 Worker produces' --maxWorkers=1
```

Repair SQ07–SQ09 with the verified stale-owner/permission/healthy-path controls
before promotion. No new dependency, schema, secret, binding, migration,
version/cache change or recovery procedure is introduced by this records-only
change. The existing security, device and exact-main-SHA release checks remain,
along with the competition freeze.

## Repair addendum — 2026-10-03

Tested repair code: `a841b2d9315c23b71d78ca6263e3950b0a55cc82`, on `mxqr_beta`. The same source tree
was verified before committing, starting from `9ea5df404669b821bc172293df7f0f397888dd05`.
Environment: Windows, pinned Node 24.20.0, Vitest/jsdom, local Chromium/PeerJS,
and jq 1.8.2 selected through `MXQR_TEST_JQ_PATH`. Main, production, product
version `8.6.61`, cache `v630`, and the disabled Operations Drift Audit are
unchanged. This is beta verification, not an exact-main-SHA release candidate.

### SQ07: honor an unavailable selection without retrying its decoder

Validated standard-room file commands now notify one playback coordinator of
an unavailable authoritative selection. It stops the outgoing output, retires
in-flight loads and foreground transfers, clears pending recovery/loader
state, and selects the requested occurrence while retaining its failure memo.
It does not retry decoding or advance the room on the guest's behalf.

The receiver retains a session high-water mark and queue identity fence, so
old outgoing bulk tails cannot reclaim output even when PLAY precedes its
new header. Host identity, session freshness and external-owner checks still
run before retirement. Repeated commands for an already-retired occurrence
are idempotent and preserve a healthy speculative preload. The related
foreground R2 descriptor and PLAY_PRELOADED paths reproduced the same failed
occurrence admission gap and now use the same retirement behavior; speculative
R2 preload descriptors cannot select or stop the current track.

[Twenty-one composed regressions](../../src/player/__tests__/failed-file-revisit.test.ts)
cover actual receive/protocol/playback composition, host command generation,
PREPARE-first/PLAY-first/START-only order, valid old bulk frames, delayed load
completion, current watchdog/UI cleanup, repeats, healthy successors, and
R2/preload controls. Native output/decoder and HTTP boundaries are controlled;
this is not physical audio, memory-limit or two-live-WebRTC-device validation.

### SQ08: match the existing PRO slowmode contract before local submission

PRO ordinary messages now apply the same interval to owner, controller and
member before showing a sent bubble or clearing the draft. Standard-room
moderator exemption, command/whisper behavior and server policy are unchanged.
The existing wait message is reused; no UI redesign or new translation is
introduced. The authority guard's single changed callsite fingerprint was
updated for this exact predicate; read counts and guard enforcement remain.

[Eight new chat cases](../../src/ui/__tests__/chat.test.ts) cover all three
PRO roles, exact-interval retry, slowmode-OFF retry and standard-room
host/operator controls. The real UI regression in
[critical-browser](../../e2e/critical-browser.test.ts) reproduced draft loss
before the fix, then verified draft retention, one outgoing frame/bubble and
successful retry after a server snapshot disables slowmode. REST/WebSocket
responses are controlled, not live production traffic.

### SQ09: fence preparation responses by control-channel recovery

The PRO controller tracks control-channel recovery generations. A preparing
HTTP response initiated before a recovery boundary or during recovery may
retain only the exact currently active transition. It cannot revive an old
transition whose CANCEL was missed. Valid committed/unchanged responses keep
the existing revision checks; healthy new commands and same-transition
recovery remain supported.

Runtime recovery carries the generation through retries and checks both the
playlist lease and generation after asynchronous work, before consuming a
replacement ticket or finishing recovery. Repeated disconnects, stop/reset
and stale signaling refresh completions cannot finish a newer recovery.
[Sixteen regressions](../../src/pro-room/__tests__/runtime-playback-reconnect-response.test.ts)
include thirteen real runtime/API/bridge compositions and three controller
lifetime cases. The repaired trace stays A → B → B COMMIT rather than
A → B → A → B; this establishes obsolete-preparation prevention, not physical
speaker timing. One original scratch probe also asserted the buggy cancellation
of B; its repair replay flips exactly that trace assertion and preserves the
original failure evidence separately.

### Completed verification and remaining release gates

| Check | Result |
| --- | --- |
| Whole-unit run plus final affected-file replay | 505 unique files / 10,503 pass / 0 fail / 0 skip after reconciling the replay described below |
| New tracked module regressions | 45 pass: SQ07 21, SQ08 8, SQ09 16; included in the unique whole-unit total |
| Final Chromium selection | 12 files / 75 pass / 0 fail / 0 skip / 0 flaky, workers 2, retries 0 |
| Types and lint | App, unit-test, E2E and Node-script TypeScript; App ESLint and changed tooling ESLint pass |
| Static boundaries | Source complexity, room authority, chunk pump, import graph, bus pairing, lifecycle writes and Playwright API guards pass; changed-code formatting and diff checks pass |
| Local builds | E2E and production builds pass; all eight production artifact guards pass |
| `build:checked` | Stops at the existing cache-history gate: beta runtime changes follow frozen `v630`. Prefix checks and the remaining three pre-build/eight artifact checks pass separately; the gate was not bypassed or weakened |

The first whole-unit run had 10,499 pass and four failures in three older test
files. One expected the previous selected row to survive a failed new selection;
three asserted UI/watchdog calls directly inside isolated receiver modules.
Those expectations were updated to the repaired ownership boundary, retaining
stale-session rejection and no-storage-restart checks. The composed regression
explicitly checks actual watchdog cancellation and loader retirement. Its
bulk fixtures also use the protocol's real `chunkIndex` field. No product code
changed after the final browser build. The independent final replay passed
236 tests across six affected files and replaces those files' initial results
without double-counting; raw initial failures
remain in `unit-all.json`.

The Chromium selection covers critical browser/UI, file transfer, preload and
queue-mode cancellation, local common start, playback sync/advanced controls,
reconnection, chat/commands, demo reliability and YouTube sync. This is not the
whole E2E, WebKit, coverage, live-service or physical-device suite. The existing
dependency-security gate was not re-audited or resolved by this repair.

Ignored evidence root: `scratch/qa4-repair-2026-10-03/`: `audio/`, `chat/`,
`pro/`, `unit-all.json`, `final-affected.json`, `unit-reconciled.json`,
`browser-before.json`, `browser-after.json`, `browser-final.json`, build logs,
type/lint/format logs and per-guard logs. Original discovery evidence above
is retained independently.

SQ07–SQ09 are resolved within the tested scope. These changes affect the App
client, tests and an authority-guard fingerprint; no Worker policy, public
protocol, dependency, schema, secret, binding or migration changes are added.
Cumulative release scope remains `all`, Developer API D1 input remains false.
No special data recovery is introduced. Eventual release/rollback follows the
existing runbook after owner approval, version/cache advancement, dependency
remediation and exact-main-SHA verification.
