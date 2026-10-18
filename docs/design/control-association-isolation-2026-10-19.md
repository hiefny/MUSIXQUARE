# Control association isolation and receipt window experiment

2026-10-19. Local sequential investigation requested by the owner. This is an
experimental transport study, not a product integration or production release.
The planned sequential screens and seven final mixed/lifecycle executions are
complete. SA192 is promising within the measured scope; production integration
and deployment remain separate work.

## Question and source identity

Can control traffic avoid the browser's bulk SCTP queue while a bounded larger
receipt window recovers the observed 65–72 second file-transfer cost?

The reviewed main SHA is `38c1292163d1557af81867d48183f61c95d3f41f`.
The saved B128 source/build is `49a877c12d5e1efc695693797f9823d957e7d992`;
the intervening five files are documentation only and the runtime trees match.
Both arms include the same undeployed Qlease protection. This is not an exact
production-versus-candidate comparison: production remains `416f5ee4`, App
8.11.20/cache v723. No product source, dependency, schema, binding or secret was
changed in the main checkout, and no release workflow was run.

Inputs and raw observations are preserved under
`scratch/transport-isolation-2026-10-19/`. `root-plan.md` and
`decision-s256-screen.md` record the decisions before the corresponding results.
Timed native runs are serial on the same Windows machine. Independent analysis
and complete source/build hashing run only after native execution returns the CPU.

## What differs

| Arm | Browser transport | Logical chunk / local threshold / receipt window |
| --- | --- | --- |
| B128 | Existing product PC, separate ordered control and bulk channels within the same SCTP association | 64 / 64 / 128 KiB |
| S128 | Control on a second actual RTCPeerConnection; bulk remains on the original | 64 / 64 / 128 KiB |
| S256 | Same control isolation as S128 | 64 / 64 / 256 KiB |
| SA192 | Same control isolation; unchanged original A192 sender controller | 64 / 64 / adaptive 128–192 KiB |

Receipt batching remains 64 KiB/20 ms. The S256 scratch source is a verified copy
of B128 with exactly `WINDOW_BYTES = 128 * 1024` changed to `256 * 1024`.
That is a one-constant **source** change; B128 versus S256 is a combined transport
topology and receipt-window intervention, not a one-factor causal comparison.

The local harness brokers side-PC SDP/ICE and performs a bounded, ordered handoff
before the no-file baseline. Actual encoded application messages pass through
the native channel, existing decoder, storage and receipt handlers. Synthetic
delivery at the original channel boundary is recorded separately from native
receipt and reconciled exactly once. There is no manufactured application
traffic, extra heartbeat, application-message replay or direct store mutation.
Failure closes the exact experimental logical connection; it does not silently
fall back. This does not implement production signaling or reconnect negotiation.

Both PCs share the guest's P2P shaping profile. HTTP/WebSocket signaling is exempt.
Pinned Chromium source establishes one directional P2P queue per profile; native
calibration corroborates it: one PC 6.983 Mbps, two simultaneous PCs aggregate
7.182 Mbps, rolling two-second maxima 7.602/7.668 Mbps under an 8 Mbps limit.
All three calibration payload hashes match. The calibration's large-buffer
control latencies are not product latency passes.

## Measurement contract

Use full Chromium `153.0.8010.12`, revision
`971a7443b0c9b0a9b2860529b33331b76077ec62`, fresh host/guest contexts,
real product admission/RTC/file handling, and an advancing controlled YouTube
provider. The 23 MB fixture is 23,040,044 bytes/352 chunks; headline completion
is first application chunk send to last application chunk receipt, followed by final receipts,
resident SHA, 30 seconds of recovery and 15 seconds of late-control drain.
Native send/receipt rows independently verify route and credit accounting;
they do not define the headline elapsed time. Both experimental arms use
Node 24.13.1, below the repository's required
24.20.0 release runtime; this local comparison is not release-environment QA.

High RTT is 8 Mbps with 100 ms delay in each direction. The initial screen
establishes connections unshaped, then measures its own 24-second no-file
baseline after shaping. This deliberately retains the previously observed
latency-transition prehistory. It is not evidence for connections shaped from
establishment. Ordinary transfer, slow links and bandwidth changes are separate
conditions; one successful screen cannot replace them.

Frozen candidate budgets: application control maximum 1,000 ms; paired excess
maximum increase at most 250 ms; excess-p95 increase at most 100 ms only when
both loaded groups have at least 20 observations and their own no-file baseline
has at least six. Sparse groups remain unavailable. Throughput qualification
requires at least 20% improvement at high RTT in both workloads/orders and at
most 10% regression elsewhere. S128's first causal isolation screen does not
require the 20% speed gain.

Exact bytes/hash/order/identity, cumulative sent/received/acknowledged counters,
window bounds, final ACK/READY where applicable, complete control routing and
observer coverage are mandatory. Playback preservation includes playing state
and independent relative player-position residuals sampled every 250 ms,
plus all intercepted player calls, not merely zero corrective calls. This
does not prove the state at every instant or measure audible sync/live YouTube.

## Sequential results

Rows are YouTube-plus-file preload unless explicitly marked ordinary transfer.
Each fresh pair retains its own baseline; results are not pooled or selected
from the best repeated run.

| Stage | B128 payload | Candidate payload | B128 / candidate sync-pong maximum | Disposition |
| --- | --- | --- | --- | --- |
| Logged B128 → S128 | 72.507 s | 66.940 s | 1,184.5 / 163.4 ms | Diagnostic only: private setup marker leaked into the app; FAIL retained |
| Corrected unlogged S128 → B128 | 72.566 s | 66.940 s | 1,169.2 / 149.5 ms | Independent isolation screen PASS; only 7.75% faster |
| Unlogged S256 after that preselected B128 | 72.566 s | 28.125 s | 1,169.2 / 153.4 ms | Independent first combined-candidate screen PASS; 61.24% faster |
| Unlogged slow2 B128 → S256 | 101.593 s | 97.604 s | 1,154.6 / 868.7 ms | Independent FAIL: excess-p95 increases exceed the unchanged budget |
| Unlogged slow2 isolated128 discriminator | 101.593 s | 97.510 s | 1,154.6 / 320.5 ms | Independent PASS against the sole preselected v4 B128 |
| Fresh unlogged highRTT8 B128 → SA192 | 73.103 s | 40.193 s | 1,122.1 / 151.3 ms | Independent screen PASS; actual adaptive expansion exercised; 45.02% faster |
| Fresh unlogged slow2 B128 → SA192 | 101.608 s | 97.476 s | 1,067.7 / 317.9 ms | Independent PASS; actual controller stays at128; 4.07% faster |
| Unlogged dynamic8→2→8 SA192 → B128 | 151.276 s | 115.623 s | 432.8 / 319.5 ms | Independent PASS; accepted192 drop and128 fallback exercised |
| Initially shaped highRTT8 B128 → SA192 | 72.375 s | 40.108 s | 1,254.3 / 152.7 ms | Independent PASS; 44.58% faster; separate connection prehistory |
| Ordinary highRTT8 B128 → SA192 | 66.184 s | 40.344 s | 721.7 / 166.8 ms | Independent PASS; 39.04% faster; actual current-file READY |
| Ordinary highRTT8 SA192 → B128 | 66.271 s | 40.523 s | 721.9 / 166.4 ms | Independent PASS; 38.85% faster; separate reverse pair |
| Preload highRTT8 SA192 → B128 | 66.425 s | 40.673 s | 299.4 / 152.3 ms | Independent PASS; 38.77% faster; separate reverse pair |

The S256 screen's denominator was selected before that B128 execution, not from
the fastest/slowest available outcomes. It retains the v2 page observers, driver,
shim and network shaping byte-for-byte. S256's YouTube sync maximum is 146 ms;
all scored bulk-period application-control maximum is 175.50 ms (PRELOAD_END).
Its YouTube sample count is nine, so whole-run YouTube p95 is not evaluated.
Seven unavailable comparisons remain explicit; applicable latency violations
are zero. The received file matches its exact SHA, S=R=A=23,040,044 bytes and
maximum debt is 262,144 bytes. Private leaks, missing/extra delivery, observer
drops and player mutations are zero. The full observed player residual is
−0.450 to +1.450 ms; maximum displacement from its own baseline is 0.950 ms.

### Slow-link rejection and next discriminator

At 2 Mbps/100 ms each direction, S256 improves completion by only 3.93% while
sync-pong excess p95 increases 317.400→749.700 ms (+432.300 ms) and YouTube
sync excess p95 increases 391.000→743.100 ms (+352.100 ms). Both comparisons
have at least 20 loaded samples. The allowed increase is 100 ms. S256's raw
maximum staying below 1,000 ms and zero playback mutations do not waive those
failures. Both files, routing and credit ledgers pass; this fixed256 candidate
is rejected. Its prepared dynamic and ordinary/reverse cases were not executed.

Independent timing decomposition finds almost identical median eight-chunk
receiver rates (238,302/238,194 B/s), but chunk-send→completion increases
433.8→984.2 ms and send→receipt 548.0→1,098.3 ms. Receiver completion→receipt
send remains 0.1/0.2 ms and receipt return latency 113.9/114.2 ms. App→native
send is at most 0.2 ms and native receive→app at most 0.6 ms; observed loop lag
is at most 17.2 ms. This supports accumulated transport/link waiting rather
than extra application work. No packet logging was enabled in this pair, so
it does not locate the queue precisely inside SCTP or the shaper.

The first cadence derivation included an initial zero-byte setup receipt;
`receipt-rhythm-diagnostic-v2.json` excludes non-progress receipts and preserves
the original derivation. Raw observations and pass/fail decisions are unchanged.
The next decision, frozen before execution, was isolated128 on slow2 against
the sole v4 B128 baseline. Reusing the unchanged earlier A192 controller with
isolation was conditional on that base passing; no new threshold was fitted
to these results.

That S128 discriminator passes: sync-pong excess p95 improves by 131.500 ms,
YouTube by 207.500 ms, maximum scored application control is 335.400 ms, and
completion improves by 4.02%. File/SRA/route/media checks pass, maximum debt is
131,072 bytes and maximum residual displacement from its own baseline is
1.100 ms. This establishes a useful slow-link base in the measured condition,
not the safety of growth or of every network.

The subsequent candidate reuses the original A192 controller without native16
fragmentation or threshold changes. Two eligible blocks of at least two seconds
and eight receipts must justify an expansion to 192 KiB; acknowledged rate is
observed locally, not inferred from a receiver-provided clock. Its original
rate gate is at least 262,144 B/s for the extra 64 KiB/250 ms allowance. This
is conservative observed goodput, not proof of available physical capacity.
The previous A192 failure remains recorded; its decisive samples occurred
before growth, which is the specific gap addressed by control isolation.
Already sent debt cannot be recalled after a sudden bandwidth drop.

That original controller's 2,325 source entries and 856 build assets were
independently verified before reuse. Its only runtime difference from B128 is
`bulk-flow-control.ts`; no native16 fragmentation or new threshold was added.
The saved diagnostic getter is required for adaptive observations; fixed-window
fallback is not accepted for SA192.

The fresh highRTT pair passes: 73.103→40.193 seconds (45.0187% shorter),
maximum scored application control 184.5 ms, sync-pong excess p95 improvement
414.10 ms and excess maximum improvement 969.70 ms. YouTube sync has 13 loaded
samples, so its p95 comparison remains unavailable. First probe192 is at
+5.400 seconds and accepted192 at +8.069 seconds. Native send admission at
192 KiB occurs 329 times, with debt above 128 KiB on 328 of them. The real
getter and independent native S/A ledger agree; this is not a split128 run
with an adaptive label. Exact file/SRA, route, full observed media and zero
player-mutation checks pass. Slow2 and bandwidth-drop qualification are
separate gates.

The fresh slow2 pair also passes: 101.608→97.476 seconds (4.0666% shorter),
maximum scored application control 335.200 ms, sync-pong excess p95/max deltas
−148.600/−749.600 ms and YouTube deltas −119.700/−571.500 ms. All352 native
admission observations and740 sampled getter states remain in baseline128;
probe and accepted192 counts are zero. This is the expected rate-gated slow
behavior, not expansion evidence. Exact file/SRA/route and full observed media
checks pass; six unavailable comparisons remain. Dynamic shrink is not proven
by this steady slow-link result.

The dynamic pair uses a46,080,044-byte/704-chunk fixture, with24-second
no-file baselines for both rates before transfer. Rate changes remain fixed
at first native bulk+30 and+90 seconds. SA192 completes in115.623 seconds
against151.276 seconds for its fresh B128 (23.57% shorter). Its actual
before/after drop snapshots are accepted192, epoch2 and196,608 bytes of debt;
the native sequence remains4071 with no intervening ledger event. Both
transitions precede file completion and all three phases contain actual send
and receive data. Subsequent128/cooldown is observed; already sent debt is
not refunded. Whole and phase-specific applicable latency budgets, exact
file/SRA/route and media checks pass. Candidate player residual stays within
+10.450..+12.500 ms around its pre-transfer +11.600 ms baseline; final
+11.400 ms is not accumulated transfer drift. This is one paired dynamic
trace, not a guarantee for every bandwidth change or an atomic shaper/getter
measurement.

Independent replay retains15 unavailable latency comparisons, with zero
applicable violations. Whole sync-pong excess p95/max deltas are
−87.800/−115.800 ms; YouTube deltas are −97.900/−116.300 ms. The first
post-drop cooldown admission is observed at+735 ms, while snapshots only
bound the change between+348 ms accepted and+596 ms cooldown. Recovery
probe/accepted observations occur at+2,895/+5,617 ms. One qualifying receipt
block spans the rate transition and the next is post-recovery: this does not
prove that two wholly new post-recovery blocks were required or collected.

### Initially shaped connection discriminator

V10 applies the same 8 Mbps/100 ms each-way P2P profile before first navigation
and before any actual original or side PC. It retains the unlimited profile
priming, HTTP/WebSocket exemptions, warmup, settle and no-file baseline. The
only common passive observer addition records native PC construction; a setup
clock mapping bounds those page timestamps in Node time. Both arms have exactly
the prime and H8 profile applications. Every PC's earliest possible construction
is more than 2.956 seconds after H8 completes. No-file directional medians of
106.5–115.4 ms corroborate the active delay.

This fresh pair completes in 72.375→40.108 seconds (44.5831% shorter).
Sync-pong maximum improves from 1,254.300 to 152.700 ms; excess p95/max deltas
are −196.300/−1,110.300 ms. Candidate maximum across all scored control is
169.700 ms. YouTube has 13 loaded samples, so its p95 remains unavailable.
Actual accepted192 admission and debt above128 are exercised; file/SRA/route
and full media checks pass. Candidate player residual ranges +4.600..+6.550 ms
around its own +5.600 ms baseline, with maximum baseline displacement 1 ms
and zero corrective calls. Seven unavailable comparisons are retained.

The poor B128 result is therefore not explained solely by changing RTT after
an established connection in the preceding screens. This does not establish
a particular initial SCTP congestion state or prove absence of retransmission.
V10 is a separate prehistory condition; it does not replace or pool earlier
baselines. Its 66 pure harness pins and targeted scratch typecheck pass.
Independent initial-order auditing adds 15 passing pure pins. One setup
original-channel sync-pong was sent before shim installation and drained once
before activation; it is retained as valid in-flight traffic. No private marker
reaches the app, and all 129/449 active side deliveries match their exact app
events. Final unmatched pings outside each frozen late-control drain remain
recorded rather than counted as in-scope loss.

### Ordinary transfer and order checks

The first ordinary pair completes in 66.184→40.344 seconds (39.0427% shorter).
Candidate maximum across scored control is 177.100 ms, including FILE_END.
Actual FILE chunks, the complete resident active Blob SHA, current queue/session
identity, READY and cumulative receiver-credit settlement are checked. The
candidate exercises 192 KiB admission and debt. Its 240-second/24 kHz fixture
has the same byte count as the preload fixture and remains within the frozen
pre-EOF observation boundary. Continuous fake-YouTube playback preservation
is not applicable to this current-file test and remains null, not a media pass.

An ordinary run also contains a same-target `preload-ack` application message;
the audit retains it among controls but does not depend on that message type
as a substitute for active Blob/READY completion. Copy-derived wording that
called the ordinary pair preload or implied that no such ACK existed is
corrected in a separate preserved audit revision; numeric gates are unchanged.
Independent forward auditing retains four unavailable comparisons. Whole
sync-pong excess p95/max improves by 101.300/556.400 ms. The probe and accepted
192 KiB states occur at +5.452/+8.170 seconds, with 328 enlarged admissions
and 327 debt-over128 admissions. Seven new ordinary-reader pins pass separately
from the 54 harness pins; continuous media preservation remains N/A.

The fresh reverse ordinary pair separately completes in 66.271→40.523 seconds
(38.8526% shorter). Candidate control maximum is 184.500 ms. Whole sync-pong
excess p95/max deltas are −99.700/−555.100 ms; sync-ping increases by
8.000/8.100 ms and stays within the frozen budgets. Four comparisons remain
unavailable. File/READY, exact routing and actual adaptive-growth gates pass;
the two ordinary order results are not averaged into a replacement denominator.

The fresh reverse preload pair completes in 66.425→40.673 seconds. Candidate
maximum across controls is 188.700 ms; YouTube sync maximum is 153.800 ms,
with 13 loaded samples and unavailable p95. The independent audit passes with
seven unavailable comparisons. Whole sync-pong excess p95/max deltas are
−103.900/−149.300 ms. Candidate player residual ranges +0.400..+2.400 ms,
with maximum baseline displacement 1.100 ms; invalid samples, nonplaying
observations and player mutations are zero. All 55 frozen inputs, exact file
and S/R/A ledgers, and 131/449 side-to-application deliveries match.
Notably, this baseline's sync-pong
maximum is only 299.400 ms yet its transfer still takes 66.425 seconds. The
whole transfer cost cannot be attributed solely to the roughly one-second
startup stall observed in other traces. This pair retains its own baseline
and does not replace the earlier 73.103→40.193-second preload comparison.

### Two-receiver and lifecycle contract

V11 is a separately frozen seven-case extension: ordinary B128→SA192,
preload SA192→B128, then candidate cancel/re-add, preload promotion and
targeted side-PC failure. Authorization remains sequential after independent
auditing; preparing a case does not mean that it ran or passed.

One actual host file-input action starts the product's two concurrent fanout
pumps. Guest1 has its own slow2 profile and guest2 its own highRTT8 profile;
both PCs belonging to each guest share that guest's profile. The host is
unlimited. This tests receiver-specific behavior and local host interference,
not a saturated shared uplink, shared Wi-Fi, a large room or mobile resources.

Each peer retains its own no-file baseline and at most 10% completion regression.
The unchanged raw/relative control budgets apply both to its own file interval
and to the room's first payload→last receiver completion interval. A fast
receiver's post-completion control tail cannot disappear from scoring. No new
20% mixed-room speed requirement is introduced. Each candidate mixed run must
exercise at least one actual H8 admission in accepted192 with independently
reconstructed debt above128; otherwise adaptive exposure is unproven.

The three lifecycle cases are unpaired functional evidence. Their actions must
occur in the same browser task as a genuine H8 accepted192/debt-over128 check.
Cancellation retains old bytes in the lifetime ledger and requires a distinct
replacement occurrence; promotion requires active Blob/READY and settled
credit, without inventing a preload-final-ACK requirement. Side failure retains
the failed prefix and outstanding debt while checking the other peer's actual
post-action payload, bidirectional controls and final file. Neither case proves
production reconnect or hot fallback. The frozen one-second old-payload cutoff
retains and reports the preceding first second; it is not an instantaneous-stop
claim.

V11 preparation passes 75 pure harness pins and targeted scratch types, with
a later separate 75-pin revalidation for served-asset byte metadata. The
independent multi/lifetime reader adds nine pins and paired budgets add six;
these counts are distinct. The initial Node strip-only test-loader failure
and the pre-clarification runner/README are preserved. Preparation tests do not
replace native outcomes below.

The mixed ordinary pair independently passes:

| Receiver | B128 | SA192 | Completion change | Candidate scored-control maximum |
| --- | --- | --- | --- | --- |
| slow2 | 97.295 s | 97.578 s | +0.2909% | 337.700 ms |
| highRTT8 | 65.667 s | 39.912 s | −39.2206% | 198.200 ms |

Both peers pass their own and whole-room control budgets. H8 whole-room
sync-pong excess p95/max improves by 100.900/586.100 ms; sync-ping increases
by 9.900/11.000 ms, within the unchanged limits. Slow2 pong improvements are
99.500/510.600 ms. The candidate has 303 actual accepted192 H8 admissions
with debt above128; slow2 stays at128 for all352 admissions. All four active
Blobs, exact target/session identity, READY and lifetime S=R=reported=A pass.
Media preservation remains N/A. Each side route has 160/506 exact deliveries,
with zero private/setup leaks or observer loss. Eight unavailable comparisons
are nonperiodic FILE_END/ordinary preload-ack groups lacking no-file baselines;
periodic ping/pong p95 has sufficient samples for both peers/scopes.

The first independent reader incorrectly required the candidate-only adaptive
exposure flag on fixed B128 as well. Its preserved R1 result is an audit-schema
failure, not a changed product outcome. R2 changes only that arm-specific
condition, adds three passing pins, and verifies that raw calculations,
budgets and unavailable comparisons are identical. No file is retransferred
to repair this audit error. The final audit verifies all58 frozen inputs.

The reverse-order mixed preload pair also independently passes:

| Receiver | B128 | SA192 | Completion change | Candidate scored-control maximum |
| --- | --- | --- | --- | --- |
| slow2 | 97.321 s | 97.539 s | +0.2240% | 333.200 ms |
| highRTT8 | 66.214 s | 40.084 s | −39.4630% | 195.700 ms |

Slow2 remains128 for352 admissions; H8 exercises302 accepted192 admissions
with debt above128. All four preload Blobs, target/session/order, final app
ACK and lifetime ledgers pass. Each side route has206/506 exact deliveries.
The H8 own-file YouTube p95 is unavailable (22/13 samples), while its whole-room
YouTube comparison has32/32 samples and improves excess p95/max by
145.900/137.100 ms. Thus the fast peer's post-completion tail is measured,
not excluded. Slow2 YouTube excess p95/max improves133.400/142.100 ms.
All applicable own/room budgets pass, with six unavailable comparisons retained.

Each receiver has613–615 media samples with a maximum267.600 ms gap.
Candidate slow2 residual is +0.600..+2.600 ms (maximum baseline displacement
1.000 ms); H8 is +0.550..+2.600 ms (1.050 ms). Invalid/nonplaying samples and
player mutations are zero. Observed fake-video times12..165 seconds remain
within its600-second duration; the120-second WAV stays an unplayed preload.
The final audit verifies all62 frozen inputs. Eleven independent lifecycle
boundary pins pass during the subsequent CPU gap; they do not qualify a
native lifecycle case.

Cancel/re-add independently passes its single unpaired case. The actual H8
action occurs in accepted192, epoch2, with S=3,276,800 and A=3,080,192 bytes:
196,608 bytes remain unacknowledged. The same-task before/after state keeps
that debt; cancellation does not refund it. Slow2/H8 old prefixes contain
28/50 chunks (1,835,008/3,276,800 bytes). Adding each complete replacement
produces final lifetime S=R=reported=A of24,875,052/26,316,844 bytes.
Both replacement occurrences, resident SHAs, pending-preload state and final
app ACKs match; this is not an active-file READY assertion.
The independent old-target send count is zero both immediately after the
action and after the one-second cutoff. The1.5-second re-add gap allows old
ACKs to drain, so this is not evidence of overlapping old/new debt.

Candidate control maxima are320.100/184.100 ms. Full sampled media residuals
remain −1.600..+0.400 and −0.550..+1.350 ms, with maximum baseline displacement
1.100/0.950 ms and zero invalid/nonplaying samples or player mutations.
The audit verifies72 frozen inputs and adds seven passing prefix-reader pins,
separate from the earlier11 boundary pins. Paired performance is N/A.

Promotion independently passes its single unpaired case. The actual H8 action
has accepted192/epoch2 and S−A=196,608 bytes, unchanged across the8.7 ms
same-task bracket. Both receivers keep the existing queue occurrence/session
and complete352 PRELOAD chunks into the active Blob/current target/READY,
with exact SHA and S=R=reported=A=23,040,044 bytes. The observed app preload
ACK remains evidence, not an invented completion requirement. Control maxima
are342.800/221.200 ms. Completion times97.477/39.992 seconds are descriptive,
not a paired performance comparison.

Each peer has134 valid pre-action YouTube samples. Maximum baseline-relative
displacements are0.850/0.900 ms, with maximum gaps264.6/265.8 ms and no
pre-action nonplaying samples or player mutations. The requested mute/pause/
stop/destroy calls and file-mode samples after promotion are retained as the
intentional transition; continuous post-action YouTube quality is N/A.

The original promotion audit R1 fails and is preserved. It matches identical
`youtube-zero-start-capability` payloads without their physical channel, so an
earlier setup-original message is incorrectly consumed for a later measured
side-channel message. Exact sequence review confirms one real delivery per
post-promotion message. The new R3 reader uses the exact channel, retains
missing/duplicate/wrong-channel rejection, and verifies that all non-route
numeric results, source contract and inputs are unchanged from R1. It explicitly
requires zero pre-active logical sends/queued events/queued bytes on all four
routes; a queued handoff is unsupported, not silently accepted. Independent
read-only review agrees with this bounded interpretation. The original raw
is not rerun or rewritten. Seven promotion-boundary pins, seven route pins and
three scope pins pass separately; the final audit verifies79 frozen inputs.

The final side-failure case also passes its scoped independent R2 audit. At
accepted192/epoch2 with S−A=196,608 bytes, the harness closes the actual H8
side PC; the counters are unchanged across the1.3 ms same-task bracket.
The exact failed logical connection then closes at both ends. The healthy
slow2 peer retains its original connection and credit nonce, performs323 native
payload sends/325 receives after the action, and completes352 chunks with
S=R=reported=A=23,040,044 bytes, resident preload SHA and application ACK.
Its159 downward/120 upward matched sync/YT controls are sent after the action
and received before measurement end; the collector's larger drain-inclusive
counts are a different pool. Completion97.473 seconds is unpaired descriptive
evidence. Control maximum335.400 ms passes the absolute limit. Its614 media
samples have maximum baseline-relative displacement1.100 ms and gap265.8 ms,
with zero invalid/nonplaying samples or unsolicited player calls.

The failed peer retains an incomplete52-send/51-receive prefix: S=3,407,872,
R=reported=3,342,336, A=3,211,264 bytes. The196,608-byte unacknowledged debt is
not refunded or presented as physical queue occupancy. Three accepted side
messages have no captured remote receipt across shutdown (one sync-ping and
two cumulative receipts); they are shutdown-censored, not delivered or assigned
zero latency. Post-fatal old-target sends are zero, including the first second.
No replacement generation is observed; this does not qualify reconnect.
The failed peer's post-disconnect idle/teardown is expected and excluded from
a continuity claim; its pre-action134 media samples pass. A healthy message
sent outside measurement during the export tail lacks captured receipt and
remains explicitly outside the scored send interval.

Side-failure audit R1 is preserved as FAIL: its unconditional no-native-error
rule rejected three `[object RTCErrorEvent]` strings on the deliberately
closed guest endpoint. R2 retains them and permits only the exact independently
owned failed endpoint, with post-action fatal/close evidence and both original
and side connections closed. Healthy endpoints still require zero errors and
closes. The observer lacks individual channel-error timestamps/details, so
their precise cause/order is unresolved; these are not silently converted to
observer or page errors. All86 frozen inputs, source, budgets and non-route
peer results remain identical. Eight failed-prefix/control pins and four
closed-endpoint scope pins pass. This is an unpaired functional check, with no
relative throughput or p95 claim.

### Preserved experimental failure

The v1 shim incorrectly assumed a later capture listener would intercept a
private barrier before the RTCDataChannel's previously registered application
listener. One marker reached each endpoint's app boundary. Media/file integrity
did not make that a pass. V1 inputs/raw outputs remain immutable; v2 registers
the interceptor before product listeners, adds registration-order pins, and
repeats in reverse order with diagnostic logging disabled in both arms.

The initial frozen root-plan prefix is preserved as `root-plan-v1-frozen.md`
(SHA-256 `0c86d6e7d3dff980837c131b98116d5b016778b0625961f045f72ded0e595dd2`).
The later append records the next decision and does not rewrite that contract.
V3 also retains a preparation-only missing empty typecheck-log error and its
fix before native execution. Neither is silently dropped or called a production
defect.

V4 retains a preparation-only TypeScript invocation failure: TypeScript 6's
default strictness exposed 18 errors in copied scratch helpers. The intended
existing targeted non-strict configuration passes, as do 37 pure pins. This
is not a full strict repository typecheck. V7's 35 pure harness pins and the
same targeted typecheck also pass; the saved controller's earlier 46 unit
tests are prior evidence, not tests rerun in this study.

### Mechanism evidence, separate from qualification

The logged pair preserves 62,743/63,264 SCTP observations with zero CRC or parser
failures. B128's delivered pre-bulk control packet races delayed SACK against
retransmission; control later waits roughly one second before a logged SCTP
send attempt. With isolation the analogous prehistory occurs on the control
association, while bulk starts on its separate association. Thus separation
changes both message scheduling and which association holds congestion history.
It is not proof of a pure queue-only effect or direct cwnd/RTO telemetry.

S128's logged control native-call-to-attempt observations have no comparable
one-second stall, but the clock alignment has a −7 ms artifact; do not claim an
exact 5 ms upper bound. TextPcap outgoing records are send attempts, not confirmed
UDP delivery. The logged setup failure remains a qualification failure despite
the useful packet evidence. The corrected unlogged comparison independently
establishes the control improvement.

## Evidence identities

All paths below are relative to the scratch root. Raw files are local synthetic
sessions, not uploaded customer data. Manifests pin the full inputs and assets.

| Evidence | SHA-256 |
| --- | --- |
| `executor/shared-capacity-calibration-r1.json` | `a4de35cb92a564609f7ce2b998ad4d8f983d2cd7d9cd855bcf0691b91173bf65` |
| `executor/v2/execution-freeze.json` | `64bd0abd651d1a22d149ce6043fc479ad7e6f907400cbb2325835b620036a4d1` |
| `executor/v2/unlogged-r2-highrtt8-preload-S128.json` | `3c49fbdaacbcc7f15135c472fd04da579d8b4845daf56160b7a10bbc2fc890fb` |
| `executor/v2/unlogged-r2-highrtt8-preload-B128.json` | `d9a0cb9c0ba86b0f04875e9122d839284a6c92b3dc54574ab2721118d2b9419b` |
| `source-S256-manifest.json` | `44149954e989746213b726a529e842f8ef649122f1526fe61a47e3e3e4a2027b` |
| `build-S256-manifest.json` | `cd15e63dcb31911418e715f12cbd31efee7f28ad5c0f425326134ed052bf7f86` |
| `executor/v3/execution-freeze.json` | `f1a87adc45d565ba0542936dc3a43b41173d88c74f8b421e934f120bf4148194` |
| `executor/v3/unlogged-s256-screen-highrtt8-preload-S256.json` | `8963fefb5524276ade3e68540bb5dd877e38132ee0ed996723eff892dc41a995` |
| `audit/unlogged-s256-independent.json` | `74d9692577b157524bb269cb0e093ac664b172133dc62c999bf154105ca5fc77` |
| `audit/unlogged-s256-independent-report.md` | `e92eaeeb36449cc27082d65ff9dbd7b1d322a52d32e4c9d21bc0c7d0d4222eee` |
| `executor/v4/execution-freeze-slow2.json` | `f82a3f656461fdfdd1488702c40ec733dff8935f9c33f17de1a11cb0bb3e5b7c` |
| `executor/v4/unlogged-v4-slow2-preload-B128.json` | `d8b838ce499b4a45004e2393d340b73700b010876da8f98f3c26524711bfbbf6` |
| `executor/v4/unlogged-v4-slow2-preload-S256.json` | `9b89c828d57e01b22cd78bd8e68388b783b66e6f2d9c3c4a3716650f9bf222bd` |
| `audit/unlogged-v4-slow2-independent.json` | `38067d25b4a4d7a5716ffa68ddb12c545477516b75fb74dab5ab8a02bfedb979` |
| `audit/receipt-rhythm-diagnostic-v2.json` | `a381b791b79049eb571652d6c30aaa8d35f84574269fc7070c208779a2f323c4` |
| `executor/v6/execution-freeze.json` | `ee9019e684a7f3828c3f6b4c705b0b16e4fc9fcae94fd6c6b6f278f97cf3548a` |
| `executor/v6/unlogged-v6-slow2-preload-S128.json` | `b3db803795a1b4cbb03a7032f46e19739f59189dc07274012e6455c879704f34` |
| `audit/unlogged-v6-s128-slow-independent.json` | `8337a437f4586d585ee5ee4b0d4f1f197aa9f9bbcc33dac30070e7c1b2e01170` |
| `audit/original-a192-reuse-verification.json` | `917eb24b8bcae70a7df6d6898f9317b36b174039f3d7812d044b4d6dc79cb2e7` |
| `executor/v7/execution-freeze.json` | `3cfb1a48eb7209c512a6609bb8792a9fc3c5f2c64852626d379bc0d6e55d7508` |
| `executor/v7/unlogged-v7-highrtt8-preload-B128.json` | `2dcb593f7d684cbe1fe03e00dad7187b43374144c5216baa60f176db38f16cee` |
| `executor/v7/unlogged-v7-highrtt8-preload-SA192.json` | `effeebdfbe3133af6c2c7eb0323a949d7d3ad1c73dd8298d293a162ae77da29a` |
| `audit/unlogged-v7-adaptive192-independent.json` | `d27a91c0ffd5c72d4738ce5ee6625255c0ebef2f5deca85fbdd553430f02dd7c` |
| `executor/v8/execution-freeze-slow2.json` | `02c5e1dc9811a5da68449961d86cae4971dc2c3a78812c913351056afcd2c42a` |
| `executor/v8/unlogged-v8-slow2-preload-B128.json` | `cf019669f5e269bb6df4c27346b359ebe70527240a8c1ad83c25246add1e8e38` |
| `executor/v8/unlogged-v8-slow2-preload-SA192.json` | `822bbb8c73ef44e0123f973c761ecd6323c9f7a0b3bb65c7dd5f4ba0f2dfd4d6` |
| `audit/unlogged-v8-adaptive192-slow-independent.json` | `7c6300baffe6933551d6a262f1b6a48cabfc1bacb7f2d262acb541ce7bcc443c` |
| `executor/v8/execution-freeze-dynamic.json` | `0a4c1aa809d027ba68dcb88efb142f0c66d06a60bca14fff145af0fdb2018a4e` |
| `executor/v8/unlogged-v8-dynamic-preload-SA192.json` | `51c73cfca2a56afaddb551d2342019f251c02dd5544eb6c47a45fa72676d1542` |
| `executor/v8/unlogged-v8-dynamic-preload-B128.json` | `e1c85c055a3c4e90af4c1055eee367b3e95741856ef3a15592f92f250b96cbe0` |
| `audit/unlogged-v8-adaptive192-dynamic-independent.json` | `eddbae328c7999e7ef44d915f456567abba762d53f44ded489305cdd75bfa743` |
| `executor/v10/execution-freeze.json` | `a057a2e5819d46f96782740541907a0c82aebf622ac6302a9ddc422baf9e9063` |
| `executor/v10/unlogged-v10-initially-shaped-highrtt8-preload-B128.json` | `caa33ad112940a54af70c5d460f48146b333ab9cfd7d6c7a8bce4b07ef0c66dd` |
| `executor/v10/unlogged-v10-initially-shaped-highrtt8-preload-SA192.json` | `11ec08cb3d6570f251a9256b964dd857237341a29ece5929f9de724eab76aa98` |
| `audit/unlogged-v10-initialshape-independent.json` | `fa2a19dab1c07a45e2d29436862b7dbaaf10456ecaf7b56177261894a9234c5d` |
| `executor/v9/execution-freeze-active-forward.json` | `85b34b4f29cab477c4948f000076e320685bdb009710fd6ced5702d5927d0531` |
| `executor/v9/unlogged-v9-highrtt8-active-forward-B128.json` | `325f732f322f2e31757792df8f490d2c4e49c7b76efcb0aa50e50702402e2461` |
| `executor/v9/unlogged-v9-highrtt8-active-forward-SA192.json` | `0ee25ba6081e1a08645565639bd10f510f6c87e3c5b35f664bb671fb0dfd50f7` |
| `audit/unlogged-v9-ordinary-forward-independent-r2.json` | `19411437f8e86e2a5136931080efb2cdb73f01d5b53eba9954c15df44215ca72` |
| `executor/v9/execution-freeze-active-reverse.json` | `2cd894fce0edab017c91f28837029e0baaff40ac2d9d79106e2d64c57f16c2d4` |
| `executor/v9/unlogged-v9-highrtt8-active-reverse-SA192.json` | `4f471270fb8e4380b14c36f54df61319f79116cd3e3dd4bf1b0b5961ebfea1b8` |
| `executor/v9/unlogged-v9-highrtt8-active-reverse-B128.json` | `aa13a16bacd38f9dfda9afeb19a72c86298bdd4ccbcfc4654e5dd1214a564c51` |
| `audit/unlogged-v9-ordinary-reverse-independent.json` | `474c0759c8b8e5ad20565edd76f94d79b003900fef23a462ef50a766ad13f2e5` |
| `executor/v9/execution-freeze-preload-reverse.json` | `d08e4f9e30f7e09c73d3a1e4073a6348474f9d312c6c1fa11012bd8cb7db9046` |
| `executor/v9/unlogged-v9-highrtt8-preload-reverse-SA192.json` | `bf1046d7d75b07a66b5449adaeb9cc06890ae5e8bda2f6dbac54e79b391a9501` |
| `executor/v9/unlogged-v9-highrtt8-preload-reverse-B128.json` | `1f83433e4ed75eb83d3d3612300aef53e8e74343c67b5aebade9b34b3ae6ceb3` |
| `audit/unlogged-v9-preload-reverse-independent.json` | `72c56ba2db08dae04e3f3c6804a7e79007b89791250cf36988aeb56e86c77426` |
| `executor/v11/execution-freeze-mixed-active.json` | `f6f82992b6077327a526dd778ebb0cc55ab6547200d53f9ac5a3cc1578a8739e` |
| `executor/v11/unlogged-v11-mixed-active-B128.json` | `1cb43193bda6d7e564716f4d8573ccb4fc2ddd7e0ca5119b6665280d59789d58` |
| `executor/v11/unlogged-v11-mixed-active-SA192.json` | `1703ea3275969b50740a9a38381cb5400b8c04d5e159ad89288f5725f9b04730` |
| `audit/unlogged-v11-mixed-active-independent-r2.json` | `17a5f5db01f6db9c5480f84370edf246ba03a49d3e04c04b376f46bb824ec5f7` |
| `executor/v11/execution-freeze-mixed-preload.json` | `f4c843777e7db837a766e955bc7cbfe63c96103e80f2168f296c15f794bfe5c6` |
| `executor/v11/unlogged-v11-mixed-preload-SA192.json` | `82f0e14451bdf8e6294b210f2c5ad33b3f3d9fad64702280fe12acf2fb7e5a0f` |
| `executor/v11/unlogged-v11-mixed-preload-B128.json` | `b718c7c62e3f78147fe168ebbf1ec40b6c1424511ea572c1a8867de65117d28a` |
| `audit/unlogged-v11-mixed-preload-independent.json` | `31ba4db4b56b39f3251bfc28b3e88223d7f58780979d19d41e25982f0581e379` |
| `executor/v11/execution-freeze-cancel-readd.json` | `6550bc52b7348ca82ee3f595f13268e877186aa4a8cd9a80b9af0081edd3d24e` |
| `executor/v11/unlogged-v11-cancel-readd-SA192.json` | `78202f4b2e59896694a3fffa480595f14722a185745fbde0761d53d6d87a3d6f` |
| `audit/unlogged-v11-cancel-readd-independent.json` | `6ae75259d33e0bd4f9d2e095aef94892c3cedb170719ec42a71e6280721d244d` |
| `executor/v11/execution-freeze-promotion.json` | `859c89ce0d17eadbf327eaab4597809f7b9f8e0953b01f430249fa69c96ca277` |
| `executor/v11/unlogged-v11-promotion-SA192.json` | `25b0f2d1de4bf2dfe98c2dd0316ed814b4d59f2257e6032a01cdb58bcf75e013` |
| `audit/unlogged-v11-promotion-independent-r3.json` | `46144cd5e5f104e527c1e18e07cde11663b3040e96d724278a3d49ef7171200a` |
| `executor/v11/execution-freeze-side-failure.json` | `4ba5a8166d57db23a0532aca221ace06e177935b98640068402cbd39441ce0b1` |
| `executor/v11/unlogged-v11-side-failure-SA192.json` | `e6bbf0de93700aced61a2376e26f17af231dccef3e5f08510b9f0b8fef5dae58` |
| `audit/unlogged-v11-side-failure-independent-r2.json` | `d6628e1b5513538432638c227d89cc1821012511b233f1a8d994af9ca3cba524` |
| `infra/cleanup-result-r2.json` | `ff67e3dc7ad99521e7d00d657cbf40a1575a0273cacb8bd949dbb0a5751ad00b` |

Independent S256 review verified all 2,324 source entries and 856 built assets
per arm, the single source difference, both input freezes (28/35 entries), and
12 unchanged common v2/v3 files. Pure shim, routing, early-interceptor and fixed
credit-reader pins and targeted scratch TypeScript checks pass. They do not
replace product unit/full E2E or an exact-main release candidate.

## Product integration boundary

This broker cannot be pasted into the application as a second ordinary offer.
`CloudflareDataConnection.attach` currently owns one peer connection and the
signaling negotiation map owns one generation per peer. A second control PC
needs a distinct owner and negotiation generation without replacing the original
data/audio PC. Existing authenticated DTLS control could carry an additive
capability and side SDP/ICE exchange after application admission; that is a
proposed narrower integration, not what this local broker implements.

Production must preserve ordered handoff, exact connection identity and S/A
accounting across cancellation, promotion, reconnect and late ICE/answers.
The quiet setup screen does not test handoff during active traffic. The
prototype's single forced side failure passes, but production negotiation and
failure ownership, original-PC media renegotiation and ICE restart need their
own implementation and tests.
Zero-loss shaping does not establish control/START versus bulk/CHUNK ordering
across two associations under asymmetric loss or reordering.
Each logical peer that enables isolation acquires one additional PC; using R2
for its file does not automatically eliminate that connection's resource cost.
Mobile CPU/memory, TURN usage and the activation policy are not measured here.
The verified source seams are recorded in the local
`design-integration-boundaries.md` alongside the experiment.

## Final disposition and remaining work

Fixed256 did not pass the slow2 gate. S128 establishes a safe base in the
measured slow2 case; SA192 passes both ordinary and preload highRTT orders,
steady slow2, one dynamic and initially shaped highRTT screens, plus mixed-link
two-receiver ordinary transfer and preload. Lifecycle cases remain separate
gates: cancellation/re-addition, next-track promotion and exact-owned side
failure all pass the bounded, independently audited cases recorded above.
The result supports an integration candidate, not a claim that every network,
queue transition or real device will behave identically. Production
negotiation, old/new peers, ICE restart, media renegotiation and reconnect
are not implemented by this local broker. No operating default or deployment
decision has changed. Current production remains App8.11.20/cachev723 with
128 KiB credit. In particular, a second PC alone improved control but only
reduced file time7.75%; the bounded adaptive window supplies the additional
throughput gain. Fixed256 shows why unrestricted enlargement is not the result.

The next product step is an additive authenticated negotiation/ownership design
for the second control PC, retaining64 KiB chunks/local threshold and bounded
128–192 KiB credit, followed by product regression and actual-device/network
validation. This report does not authorize or substitute for that release.

All task browsers exited after the final native case. Cleanup independently
verified four owned server roots and14 process identities before stopping only
their trees; ports4470/4471/4472/8870/9370 have no remaining listeners and no
matching process remains. Raw data, source/build copies and local Worker state
are retained. The first cleanup attempt stopped nothing: JSON date conversion
made a creation-time comparison fail. Its failure record is preserved; R2
compares the actual timestamp and passes without weakening ownership checks.

Only this report, its evidence-index link and the related open-item evidence
change in the repository. No App/Worker source, version or release-history
entry changes. Repository documentation is published through the normal PR/CI
path; no Cloudflare release is needed.
