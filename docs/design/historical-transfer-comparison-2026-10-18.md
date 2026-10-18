# Historical preload speed and YouTube playback comparison

Date: 2026-10-18. Read the release record before this QA round. The owner
requested a minimal historical comparison to distinguish pre-existing problems
from the cost of recent stabilization. This is evidence only: no runtime,
transport parameter, App/cache version, dependency, schema, binding, secret,
or production deployment changes are included.

## Findings

Severe control delay predates receiver credit. The one-month-old application
completed the same 23 MB preload in about 98 s on the 2 Mbps profile, while a
YouTube heartbeat arrived almost 20 s late and the guest became about 19.6 s
behind. File speed alone is therefore not evidence of healthier playback.

Current production preserved the controlled media position and reduced control
delay in both profiles. Its cost is real: on the 8 Mbps, approximately 218 ms
unloaded-RTT profile, completion rose from 25.352 s yesterday to 71.817 s today
(2.83 times as long). On 2 Mbps, it was 101.683 s yesterday and 97.275 s today;
one observation does not establish a repeatable 4.3% slow-link speed improvement.

Keep transport congestion and erroneous playback correction as separate problems.
These results neither establish an optimal window nor justify a blanket rollback
or claim that current production is defect-free. No new transport design was
added for this comparison.

## Exact sources

Dates use Asia/Seoul: one month ago is September 18, yesterday is October 17.
Production snapshots are the last successful App deployments by each cutoff.
All four are ancestors of fetched `origin/main`; the repository is not shallow.

| Label | Exact source SHA | Identity and provenance |
| --- | --- | --- |
| FIRST | `df5e1555d1de507c03abda9d970a57f6bd829062` | Only reachable root, January 25 04:54:13 KST; classic static app. Deployment of this exact root is not established. |
| MONTH | `20271a3313c1946fb2e83cc78d3fcdd52d7017bb` | App 8.6.43/v610, [Release 35358853769](https://github.com/hiefny/MUSIXQUARE/actions/runs/35358853769), September 18 23:53:42 KST. Also day-end main. |
| YESTERDAY | `e47d0bb5216c9d66bbbc7e28a0cc1cf52bb72c1b` | App 8.11.14/v716, [Release 39039136092](https://github.com/hiefny/MUSIXQUARE/actions/runs/39039136092), October 17 23:05:49 KST. Day-end main `256f1f92988248462de857dd69232bda8c7ea474` differs only in five documentation files. |
| NOW | `416f5ee48e3708ae33d82aa1c6d925a72bcab6f3` | App 8.11.20/v723, [Release 39081701815](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081701815), October 18 09:11 KST; current production at selection. |

Initial workspace main was `ac354035cfeaab246096943c2a0e83c9aaea474e`, App
8.11.21/v725. Its newer automatic-realignment clock-safety candidate is **not
deployed and is not NOW**. Local historical tests do not replace exact-main CI.

Archives retained original tracked source bytes, checked before/after builds.
MONTH used its own lockfile installation. YESTERDAY/NOW had the same resolved
dependency versions as the workspace and reused those installed dependencies.
Builds used original Vite configurations in `e2e` mode with each exact archived
`GITHUB_SHA`. These are local instrumentable source builds, not byte-identical
downloaded production artifacts.

## Frozen minimal workload

- One Standard-room host and one guest on one Windows PC, fresh Chromium
  contexts/storage per case. Chromium `153.0.8010.12`, Node `v24.13.1` throughout.
  Node is below the current repository 24.20 target, not the production toolchain.
- Same advancing controlled YouTube provider, `FAKEVID0001`, duration 600 s;
  add the next local file using original UI and genuine preload. No injected
  drift, manual offset 0, desktop UA, modeled output advance 0.
- WAV: 120 s, 48 kHz stereo 16-bit, **23,040,044 bytes**, SHA-256
  `5749688e4e6306234de4add49e9191c5e8974e4d60de48671c4bd57dca4db83d`.
- Native Chromium P2P shaping: **8 Mbps or 2 Mbps**, configured 100 ms latency
  per direction, no injected loss/reordering. URL requests/local signaling are
  exempt. Unloaded RTC RTT approximately 218 ms. File and controls use actual
  RTC; YouTube media is controlled, not the live provider.
- Local historical signaling and direct RTC (`iceServers: []`) for every source.
  No production rooms, remote participants, TURN, R2, or external upload.
- Warmup 10 s + settle 2 s; no-file baseline 24 s; preload deadline 240 s;
  recovery 30 s; extra 15 s for already-sent controls. Total deadline 360 s.
  No concurrent builds/other test browsers during measurements.
- Frozen order: 8 Mbps MONTH → YESTERDAY → NOW; 2 Mbps NOW → YESTERDAY → MONTH.
  One formal run per cell, no hidden retries. Formal execution 12:30:44.335–
  12:46:34.917 UTC: 15 min 50.582 s including setup/baselines/tails.

Planned four versions × two profiles. FIRST's original setup failed in preflight,
so its two formal cells are **not run/unavailable**, not two completed failures.
Six formal runs remain. Historical constants, transport and playback policies
were not normalized or backported.

## Transfer and control results

Payload time: first actual application payload send → last decoded received
payload. Controls: original connection `send` → opposite decoded `data` delivery,
including original serialization/queueing. This common boundary is not sender
queue completion or a mix of app/native latencies. Maxima are observed, not bounds.

| Version | Profile | Integrity/observation | Payload time | YouTube heartbeat maximum (n) | Sync-pong maximum (n) |
| --- | --- | --- | ---: | ---: | ---: |
| FIRST | 8 Mbps | Not run: original setup defect | — | — | — |
| FIRST | 2 Mbps | Not run: same blocker | — | — | — |
| MONTH | 8 Mbps | Pass | 25.365 s | 4.859 s (8) | 4.919 s (25) |
| YESTERDAY | 8 Mbps | Pass | 25.352 s | 4.901 s (8) | 4.925 s (25) |
| NOW | 8 Mbps | Pass | 71.817 s | 0.824 s (24) | 1.077 s (72) |
| MONTH | 2 Mbps | Pass | 97.588 s | 19.974 s (32) | 20.077 s (80) |
| YESTERDAY | 2 Mbps | Pass | 101.683 s | 1.137 s (34) | 2.101 s (101) |
| NOW | 2 Mbps | Pass | 97.275 s | 0.426 s (32) | 0.442 s (97) |

Every formal case received 352 original chunks in order, exactly 23,040,044 bytes,
expected resident Blob SHA and original final ACK. **File/observation pass does
not mean every version passed playback quality.** NOW's 1.077 s pong maximum
is retained, not converted into a pass against another experiment's 1 s budget.

Operation-start → first payload preparation was 1.010/1.024/1.030 s for
MONTH/YESTERDAY/NOW at 8 Mbps and 1.027/1.016/1.019 s at 2 Mbps. Last-payload →
final-ACK delay was 131/127/129 ms and 133/124/132 ms respectively.

Per-case no-file heartbeat medians were 109.5/112.2/113.7 ms at 8 Mbps and
115.6/112.3/109.1 ms at 2 Mbps. Additional maxima above those medians were
4,749/4,788/710 ms and 19,858/1,025/317 ms. Each baseline has only seven YouTube
heartbeats; no headline p95 comparison is justified. Raw distributions/counts
are retained, and different control message types are not pooled.

## Playback results

Residual is guest position minus independently projected playing host position;
negative means behind. Common-PC monotonic timestamps are used, not the selected
network clock. Final values stop at 30 s recovery; the extra control-drain tail
is separate. Initial residual is shown, not silently subtracted away.

| Version/profile | Baseline median | Bulk signed residual range | Largest change from baseline | Final residual | Calls during bulk + recovery |
| --- | ---: | ---: | ---: | ---: | --- |
| MONTH / 8 Mbps | +3.50 ms | −3,995.75 to +4.25 ms | 3,999.25 ms | −106.95 ms | 2 seeks |
| YESTERDAY / 8 Mbps | +0.50 ms | −0.30 to +1.30 ms | 0.80 ms | +0.50 ms | 0 |
| NOW / 8 Mbps | +2.35 ms | +1.40 to +3.20 ms | 0.95 ms | +2.75 ms | 0 |
| MONTH / 2 Mbps | +8.50 ms | −19,631.90 to +9.20 ms | 19,640.40 ms | −109.10 ms | 9 seeks |
| YESTERDAY / 2 Mbps | −0.50 ms | −206.45 to +0.50 ms | 205.95 ms | −8.60 ms | 2 pause → seek → play sequences (6 calls) |
| NOW / 2 Mbps | +0.50 ms | −0.45 to +1.40 ms | 0.95 ms | +0.75 ms | 0 |

MONTH's coarse heartbeat path uses the sent media position without projecting
packet age. In the 8 Mbps case, at 11.939 s after first payload a seek moved
48.9935 → 44.995 seconds: a previously aligned guest became about 3.995 s late.
At 26.045 s a later seek largely recovered it. At 2 Mbps, the first five seeks
progressively produced approximately −4.589/−8.255/−11.971/−15.937/−19.631 s;
four later seeks recovered most of this. This is not just a count of harmless
corrections or a final-value comparison that hides the middle of transfer.

YESTERDAY already projects timestamped heartbeats. Its 8 Mbps case stayed
aligned despite almost five-second control delay: **late messages alone do not
prove wrong playback position**. Its 2 Mbps first realignment began at 65.781 s
while independent residual was about −1 ms, paused/seeked, then played at
67.289 s with about −205.5 ms residual. The second began at 107.017 s and
played at 108.522 s, recovering the induced error to about −7.8 ms. Thus six
API calls are **two** sequences; the second addresses an already-present error,
not another independently unnecessary initial correction.

The first induced error persists for approximately 39.7 s until the second
pause, not just during the first pause itself. The exact selected clock sample
at admission was not logged, so its raw-sample/eviction cause is not established
by these traces. Independent position and API calls establish the false first
operation and later recovery without making that stronger causal claim.

Those pauses lasted 1.508 s and 1.505 s by API timestamps. Sample-based
non-playing interval estimates total 2.996 s, not exact acoustic silence.
Other cases have no observed non-playing interval and all have zero BUFFERING
samples, but the controlled provider does not model real seek/CDN buffering.
Current production has zero player calls and preserved logical position in
these two runs; this does not close all clock-quality or real-device issues.

## Policy differences and causal limits

| Policy | FIRST | MONTH | YESTERDAY | NOW |
| --- | --- | --- | --- | --- |
| Payload chunk | 16 KiB | 64 KiB | 64 KiB | 64 KiB |
| Preload native-buffer wait threshold | 1 MiB | 256 KiB | 256 KiB | 64 KiB |
| App cumulative receiver-credit window | None | None | None | 128 KiB |
| Small automatic YouTube realignment | Absent | Absent | Present | Present |

Thresholds are admission conditions, not caps on all queued bytes. Every source
has native congestion/flow control. MONTH polls; YESTERDAY/NOW have native
low-buffer events plus fallback, and NOW also wakes on receipts. There is no
mandatory extra 50 ms sleep after each ACK. YESTERDAY/NOW `src/youtube/sync.ts`
are byte-identical, but these are whole applications with other differences,
not a one-variable credit or buffer experiment.

Earlier comparisons used an already-64-KiB preload baseline from October 18;
that is not this October 17 YESTERDAY snapshot. A diagnostic **256 KiB credit
window** is also different from a **256 KiB local buffer**. Older sources lack
small-drift correction; zero calls in them would not prove better sync.

## Preserved exclusions

FIRST has YouTube/preload code, but guest connection `open` in `js/app.js:3020`
calls `updateQrCode(hostId)`, local to separate `setupPeerEvents()` at `:2590`.
Preflight records `ReferenceError: updateQrCode is not defined`, before guest
heartbeat/ping registration (`:3024/:3027`). Host liveness handling at
`:2566–2583` removes the guest from connected send targets after 15 s. This
does not establish that the underlying RTC channel physically closed.

Initial video played, but there was no preload target/payload at file addition;
the fixed preflight timed out. No shim, next commit, or product repair was
substituted to produce a first-commit throughput number.

Three preflight attempts are excluded from the formal table:

1. FIRST: original setup exception, zero preload chunks, unavailable throughput.
2. NOW r1: all 352 chunks, correct SHA and ACK at about 71.5 s, but observer
   ordering handled old `index` and not current `chunkIndex`. **Harness assertion
   failure**, not product file corruption; original output preserved.
3. NOW r2: passive observer retained original fields and normalized the index;
   integrity/order passed at 71.542 s. Shorter baseline/tail, not pooled with formal.

Observer repair and nine analysis pins preceded the 36-file freeze. No frozen
input/historical source changed during formal execution; no result was rerun away.

## Evidence and scope

Retained local directory: `scratch/historical-transport-comparison-2026-10-18/`.
Contains exact Git archives, source/build manifests, FIRST vendor files,
adapters, common observer/analysis, frozen configs, raw JSON, logs, summaries
and independent audits. These are local evidence, not remote CI artifacts.

| Raw formal file (without `.json`) | SHA-256 |
| --- | --- |
| `formal-highrtt8-MONTH` | `f11453cc4eef878ed7d16927a650915c182f2e864284f5b91a8d7aa354762ecc` |
| `formal-highrtt8-YESTERDAY` | `13b587be0a480afd1168eee9f64cec884db7c00922c0b825dd422705a0d4c647` |
| `formal-highrtt8-NOW` | `5ad9c1837aae347f7ae2578ddd57e129556c1798ee047f637ce43bdb50efb8e1` |
| `formal-slow2-MONTH` | `3131cc067f83296b0ea1618406e5cb947b1a0fcc42c8113bba014f535b566c7c` |
| `formal-slow2-YESTERDAY` | `5938326db869e1d33d0adb96a70bbde5bff4c95a5ca225927c823df815668433` |
| `formal-slow2-NOW` | `54f9ba5333c6644f3da4c57063b9fe4d5d08d5604616f00a10afc32149abc7fc` |

`execution-freeze.json`: SHA-256
`a3487d1cffba76247d74b66271865f57e91f4f039c9e0c92f433c2f6735efa0d`,
12:28:38.660 UTC, before formal runs. Nested manifests cover all archived source
and built assets; cases verify mandatory served assets. Executor manifest:
`executor-evidence-manifest.json`, 77 files / 33,793,042 bytes, SHA-256
`bd6ca9b61d400a112f7fd8ec521af9d1cce2aba003a4e2dc990fea15c9dc4fde`.
It inventories executor inputs/results; archives/assets and independent audit
outputs remain separately identified, not silently counted as included files.

Independent raw reconstruction matched all six results and 36 frozen inputs:
file order/bytes/SHA, exact-target ACK, config/raw hashes, phase boundaries and
derived metrics. Zero observer drops, exceptions, or connection replacements.
Final media samples precede measurement end by 24–200 ms, not by the extra
15 s drain. An independent media/source review also matched mutation sequences
and the distinction between induced error and subsequent recovery.

The audit preserves 57 controls that arrived after their bulk-send phase and
finds no unmatched measured-send control. Maximum valid wall/monotonic mapping
range is 1.200 ms and combined read bracket is 0.500 ms. The only 12 excluded
media samples inside the measurement windows are YESTERDAY slow2's actual
non-playing samples; its pause intervals remain visible. Earlier unready
samples elsewhere in the raw recording do not enter the headline windows.

| Independent audit output | SHA-256 |
| --- | --- |
| `independent-audit.json` | `c984dce1ef4d0d172f7ba2f517c21d7714b382259a2dd0b823c0322829426b8e` |
| `independent-audit.md` | `afe454f91da7e65c30000a2a6b718f8897bcdd92014e7d41d4534f7a77d4edbe` |
| `independent-audit.py` | `c02b956d69cfd866cbd3674089aa8d26f69a86e4223890e6f7aa0a8cc0cc1155` |
| `media-interpretation-audit.json` | `fff9b9406364d0a1715e96f3f67b3bd2459c33654522001514fe456228b6423b` |
| `media-interpretation-audit.md` | `de85e28ee50f4f84187b2bf6f0cf515c240d9602d1012526d9c2c4ead6fa1e22` |
| `media-interpretation-audit.py` | `e927fcb8c19f70d1b4384236aadf998a8029634260de9f76a4ab1fc5c9d90013` |

This is a one-receiver ordinary-room **preload** comparison, not ordinary active
transfer, many receivers, lifecycle cancellation/promotion, mixed versions,
real YouTube buffering, acoustic sync, physical Android/iOS, Wi-Fi radios,
TURN/R2, or all networks. No full unit/E2E suite rerun. Millisecond fake-media
residuals are not real-speaker accuracy. All task-owned browsers/local servers
were closed; evidence remains on disk. Production is unchanged.
