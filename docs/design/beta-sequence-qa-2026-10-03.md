# Beta sequence QA — 2026-10-03

| Field            | Value                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Status           | Dated discovery evidence — SQ01 confirmed, not repaired                                                             |
| Tested checkout  | `mxqr_beta`, `edbfebedc12290d767bab79afc858c3046d8696c`                                                             |
| Product baseline | `79f3a687a7222a69ff865846e0c715aa197d0f10`; subsequent commits only changed documentation                           |
| Main comparison  | `35759e8b07f1ee0b272afbd0af03c770a858889e`                                                                          |
| Environment      | Windows, Node 24.20.0, Vitest, local Chromium + PeerJS                                                              |
| Related records  | [Living release record](../beta-release-readiness.md), [2026-10-01 full audit](main-beta-merge-audit-2026-10-01.md) |

## Result and scope

**One additional defect was confirmed: SQ01, a recoverable direct-file receive
ordering defect.** It also reproduces against archived main source and is not
a beta-introduced regression. No product code, tracked test, dependency,
version/cache, server contract or production deployment changed in this round.

The product tree was unchanged since the previous full audit. This round added
multi-stage sequence probes rather than repeating that entire suite. The prior
audit's zero new findings remains a dated observation; it is not the current
unresolved-defect count. Current unresolved runtime findings from this round: **1**.

## SQ01 — delayed PREPARE discards an accepted direct-file prefix

**Priority: P2. Status: confirmed, unfixed.** Affects standard-room direct local
file transfer. This is not evidence of the same defect in PRO/R2 downloads.

The actual sender publishes PREPARE when a track is selected, then repeats it
when the decoded file is ready for debounced broadcast. PREPARE and START use
the control RTC channel; file chunks and END use the separate bulk channel.
Each channel is ordered, but there is no ordering guarantee between channels.

Minimal reachable sequence, with the first selection PREPARE delivered normally:

1. A valid chunk prefix arrives on bulk and is accepted into the RAM store.
2. Repeated PREPARE arrives on control for the **same queue occurrence and
   transfer session**.
3. PREPARE calls `player:stop-all-media`. The real playback subscriber resets
   `transfer.state` to `IDLE`, while the prefix still exists in RAM.
4. START arrives before the next bulk chunk. Its prefix-preservation guard
   requires `RECEIVING`, so it rejects the matching prefix and issues a fresh
   `STORAGE_START`, erasing those bytes.
5. The remaining suffix and END cannot complete the file. Recovery requests
   `nextChunk: 0`, retransmitting the whole file unnecessarily.

The minimized three-chunk reproduction tested both one- and two-chunk prefixes.
In a fresh recovery state, the first recovery request was sent after the
configured **2,000 ms** delay. Replaying the requested full stream completed
byte-for-byte and invoked decode once. This establishes an avoidable delay and
extra transfer, **not permanent data loss, an infinite retry loop, or a measured
production occurrence rate**. Larger files can incur more retransmission cost;
real-network throughput was not measured here.

Decisive current source boundaries:

- [Sender](../../src/storage/transfer-send.ts): `broadcastFileDebounced` repeats
  PREPARE before START/chunks, called from [decode](../../src/player/decode.ts).
- [Cloudflare transport](../../src/network/transport/cloudflare-signaling.ts):
  `isBulkPayload` and `send` choose the independent ordered channels.
- [Receive](../../src/storage/transfer-receive.ts): unconditional stop at line
  1076, exact-prefix `RECEIVING` requirement around 1385, fresh storage start at 1468.
- [Playback subscriber](../../src/player/playback.ts) →
  [transport stop](../../src/player/transport.ts) →
  [ownership projection](../../src/player/ownership.ts): `setPlaybackIdle` at
  lines 573–577 clears transfer state before START checks it.
- [Recovery](../../src/storage/recovery.ts): the missing prefix produces the
  full-resend request after backoff.

### Verification and neighboring controls

The discovery harness uses the real sender, Cloudflare frame encoding/decoding,
protocol validation, playback subscriber, transfer receiver and RAM store.
Native final decode is an observation stub; RTC channel delivery is controlled
at the channel boundary. It does not forge state to force `IDLE`.

- All **84** FIFO-preserving mergers of three control and six bulk frames for
  current file plus same-name preload: **78 pass, 6 fail**. The six failures
  share SQ01's cause; they are not six independent defects.
- Root independently reran all 84: the same 78/6 result.
- Removing preload and playlist reorder, and using the repeated-PREPARE sender
  path, still reproduced both partial-prefix losses and subsequent recovery.
- Three neighboring controls completed without recovery: repeated PREPARE
  before the prefix, full file before late PREPARE/START, and all headers before
  chunks. These preserve control and bulk FIFO.
- A second reviewer independently checked the sender call chain and reran
  minimized controls plus a repeated-PREPARE variant.
- The same five final observation/control tests ran against `git archive main
src/` in ignored scratch: identical prefix loss, recovery and successful
  controls. Main was never checked out or modified. The replay used current
  installed dependencies and the shared network guard, not a full historical
  main build or a production session.

The five minimized tests are green because two explicitly assert the observed
defect and successful recovery. They are **not** a fix or all-green product
verification. The 84-case no-loss assertions remain red.

Existing receive-resume and preload-channel-ordering tests also passed (57).
Their focused wiring did not exercise this exact combination with the real
stop subscriber between a partial prefix and START. A repair should retain
the integrated event path instead of only extending isolated handler tests.

### Repair boundary for a later change

Preserve the exact live receive owner across duplicate PREPARE without
weakening checks for a new occurrence, changed metadata/session, superseded
connection, unsupported track or mode takeover. Still stop the previous audible
track promptly. After repair, the original no-loss matrix should pass without
recovery. Also verify resource cleanup, pending PLAY, completed decode,
new-session reset and old-sender compatibility. No repair was implemented here.

## Other executed checks

| Area                                                                | Result                        | What ran / limits                                                                                                                                                                                               |
| ------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bounded/native audio, seek, pause, output rejoin, preload promotion | 60 pass, 0 fail/skip          | Real player/resource ownership modules; delayed success/failure; decoder reservation and resource disposal assertions. Audio output, codecs and external boundaries modeled                                     |
| PRO/YouTube authority and live-share restoration                    | 19 pass, 0 fail/skip          | Revoke/regrant, occurrence/sub-video A→B→A, same-room leave/rejoin, successive live shares, repeated local pause/resume and five offset controls. Fake iframe/API/SFU boundaries                                |
| Search UI ownership                                                 | Chromium 18 pass, retry 0     | Desktop and narrow RTL layout; replacement, close/reopen, A→B→A; retired success/failure and fresh failure/retry. Actual UI; search API/YouTube responses modeled                                               |
| Demo exit/reentry                                                   | Chromium 4 pass, retry 0      | Host + guest over local PeerJS; guest download held, real host exit buttons, same-track reentry, late success/failure, latest pause/play then next track/exit. Real browser decode with MP3 fixture; CDN mocked |
| Existing receive/preload ordering checks                            | 2 files, 57 pass, 0 fail/skip | Focused baseline, not a full-suite rerun                                                                                                                                                                        |
| E2E application build                                               | Pass                          | `npm run build:e2e`; no production build/deploy in this round                                                                                                                                                   |

The browser total is **22**. The 19 PRO checks include seven clean controls;
repeated executions and main comparison are not added to distinct scenario
counts. No additional audio/PRO/YouTube/UI defect survived reproduction and
call-path review.

Initial scratch harness errors were retained locally and corrected without
changing product code or weakening timeouts. They concerned a reused one-shot
mock, an omitted advisory export, the intentional 60 ms manual-nudge replay,
latest-UI-seek supersession, and awaiting the second leave's teardown rather
than the completed first leave. They are not product findings.

## Reproduction evidence and limits

Ignored local evidence root: `scratch/qa-2026-10-03/`. This directory is not
part of the pushed documentation commit. Commands run from repository root
with the pinned Node directory on PATH; each probe uses one worker and the
existing network guard.

```powershell
node node_modules/vitest/vitest.mjs run scratch/qa-2026-10-03/transfer/channel-weave.test.ts --config scratch/qa-2026-10-03/transfer/vitest.config.ts --testNamePattern 'merger' --reporter=verbose
node node_modules/vitest/vitest.mjs run scratch/qa-2026-10-03/transfer/channel-weave.test.ts --config scratch/qa-2026-10-03/transfer/vitest.config.ts --testNamePattern 'minimal' --reporter=verbose
node node_modules/vitest/vitest.mjs run --config scratch/qa-2026-10-03/audio/vitest.config.ts --reporter=verbose
node node_modules/vitest/vitest.mjs run --config scratch/qa-2026-10-03/pro-youtube/vitest.config.ts --reporter=verbose
```

Evidence includes `transfer/root-independent.json`,
`transfer/minimal-current-final-results.json`, `transfer/minimal-main-results.json`,
`pro-youtube/transfer-review-results.json`, `audio/final-results.json`,
`pro-youtube/results.json`, `pro-youtube/runtime-share-results.json`,
`browser.json`, `demo-browser.log` and `existing-transfer.json`. Transfer-agent
artifacts call SQ01 “T01”; they refer to the same finding. Narrow-name runs list
unselected cases as skipped; that is filtering, not an environment skip.
The original 84-case matrix had no skipped cases.

Browser probes use `scratch/qa-2026-10-03/playwright.config.ts` with
`MXQR_E2E_APP_PORT=4198`, `MXQR_E2E_PEER_PORT=9028` and the pinned Playwright
browser directory. `browser.json` records 18 search cases; the four-case demo
run used the line reporter saved in `demo-browser.log`.

No live YouTube, Cloudflare, physical iPhone/PWA, Bluetooth, WAN handover or
speaker-alignment result is claimed. The complete unit/coverage/E2E and
security audit were not rerun; the 2026-10-01 dependency findings remain
unresolved release gates. SQ01 now also needs resolution before promotion.
