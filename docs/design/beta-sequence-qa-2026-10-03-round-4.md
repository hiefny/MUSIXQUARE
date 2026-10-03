# Beta sequence QA, round 4 — 2026-10-03

| Field | Value |
| --- | --- |
| Status | Dated discovery evidence — SQ07–SQ09 confirmed, not repaired |
| Tested checkout | `mxqr_beta`, `ed6552805d57ccd30bfc64a5dfa474ba0378c729` |
| Product/test code | `d4dd4bbb94c58624f50887d12dc5dd017fb95f7a` — includes SQ05–SQ06 repairs |
| Main reference | `35759e8b07f1ee0b272afbd0af03c770a858889e` |
| Environment | Windows, pinned Node 24.20.0, Vitest/jsdom, local Chromium and PeerJS; controlled external service/media boundaries |
| Related records | [Living release record](../beta-release-readiness.md), [previous discovery and repairs](beta-sequence-qa-2026-10-03-round-3.md) |

## Result and scope

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
