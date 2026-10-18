# Standard-room startup transport delay investigation

Date: 2026-10-19 KST. Investigation base:
`f92229f8835e506dfe35da1253134ea1c46f5aed`.
Scope: local diagnosis, not a runtime change or production release.

## Question and decision

The earlier A192 and AF19216 candidates shortened file transfer but failed
control-delay budgets. Their decisive startup samples occurred before credit
expanded beyond 128 KiB. This round investigates that startup delay rather than
changing another buffer/window combination.

Two otherwise identical captures of the frozen B128 product reproduced both
the approximately 0.81-second and 1.89-second first-chunk states. The slow capture
contains a specific causal sequence: a delivered control message receives a
delayed SCTP acknowledgment; the acknowledgment reaches the sender just after
an unnecessary retransmission; the sender subsequently emits immediate-ACK
requests and starts bulk transfer in a reduced congestion state. The pinned
browser source identifies the matching T3 timeout/congestion-reduction path.

This identifies the mechanism in the **new slow reproduction**. The old runs
did not record SCTP packets, so their similar timing signatures alone cannot
prove that every old failure had this cause. The entire 64–72-second transfer
cost is also not explained by a single startup timeout. No candidate is adopted,
no prior failed gate is waived, and production remains unchanged.

The read-only audit of ten earlier runs also distinguishes dynamic AF19216's
first enlarged `probe-warmup` observation (+15.8258 s) from its later `probe`
observation (+16.723 s) and accepted phase (+18.795 s). The decisive old samples
at approximately +0.722, +0.877 and +2.716 s precede all three. This clarifies
phase naming without changing the original failure or adopting the candidate.

## Frozen product and diagnostic environment

- Tested runtime: saved B128 source
  `49a877c12d5e1efc695693797f9823d957e7d992`. Its difference from investigation
  main is documentation only; the saved source/build were checked byte-for-byte
  (2,324 source files and 856 build files). The build was not regenerated.
- Windows; Node `v24.13.1`; Chromium `153.0.8010.12`, source
  `971a7443b0c9b0a9b2860529b33331b76077ec62`, WebRTC
  `9ea5afcad008b940468c2a15aec339592cf5a935` from its DEPS.
- One real Standard host and guest; normal product preload entry through the
  file input; controlled advancing YouTube fixture, zero manual/output offsets,
  no ICE servers. Local app/Worker servers and browser processes belong only to
  this diagnosis. No production room, global traffic shaping, or router change.
- Existing 120-second WAV, 23,040,044 bytes, SHA-256
  `5749688e4e6306234de4add49e9191c5e8974e4d60de48671c4bd57dca4db83d`.
- Logical chunk/local threshold/receipt window remain **64/64/128 KiB**.
  No adaptive credit or 16 KiB candidate is used. Product gates choose sends.
- Ten-second unshaped warmup, guest-side 8 Mbps each direction, two-second
  settling interval, 24-second no-file baseline, then the first eight seconds
  of preload. The 100 ms latency applies separately to send and receive.
  HTTP/WebSocket requests are exempt; the P2P global rule is shaped.
- Existing app/native observers, driver and shaper are imported unchanged.
  The extra bounded `bufferedamountlow` listener only observes; it does not
  change thresholds, send traffic, or poll. Capture begins before PC setup.

The original performance runs used Windows **headless-shell**. Three preserved
capability attempts could not enable its renderer TextPcap logging. The pinned
source shows a child-process logging-initialization difference. The full bundled
Chrome executable in headless mode at the same revision did emit packet logs,
so these diagnostic runs use it, with verbose logging and tracing. These are
explicit environment differences, not replacement qualification measurements.
The smoke-only mDNS override was not retained in product captures.

## Captures and counterfactual

| Capture | Guest one-way shaping | First logical chunk received | Packet observation |
| --- | ---: | ---: | --- |
| B128 r1 | 100 ms | 809.20 ms | No repeated DATA TSN or I-bit transition |
| B128 r2, identical protocol | 100 ms | 1,885.20 ms | One pre-bulk control TSN retransmitted; I-bit changes to true and remains true into bulk |
| B128 r3, latency-only counterfactual | 80 ms | 652.00 ms | No repeated DATA TSN or I-bit transition before the end of the planned baseline/startup window |

The r3 prediction was recorded before execution: reducing each direction from
100 to 80 ms should move delayed-SACK arrival below the approximately 400 ms
timeout boundary, removing this retransmission/I-bit sequence. The other
product inputs, 24-second baseline and eight-second capture are unchanged.
The packet prediction matched. A single lower-latency capture is corroborating
evidence, not an independent estimate of timeout frequency or a performance
qualification: lower latency also directly speeds delivery. There were no
automatic retries or further product measurements.

All three diagnostic captures completed without observer errors/drops or trace
data loss. Whole logs contain 8,054 / 7,554 / 10,786 SCTP observations respectively,
with zero decoder length/CRC errors. These counts include both endpoints and
capture tails, not that many unique transmitted packets. r3 has repeated DATA
observations **after** the measurement ended, at +9,136 to +9,161 ms; its planned
window ended at +8,014 ms and observers stopped at +8,021 ms. Exact dispose/close
timestamps were not recorded, so the tail cause is unconfirmed, not attributed
to cleanup. It prevents a whole-capture “zero retransmissions” claim. Original
tail data and ambiguous duplicate-packet matching remain in the evidence.

## Packet evidence from the slow reproduction

In r2, shaping was enabled about 853 ms before the following control send,
during the settling interval, before the 24-second baseline. Times below are
relative to the original DATA send; its TSN is `1783811118`, stream 3,
`sync-pong` pingId 15.

| Event | Elapsed | Evidence |
| --- | ---: | --- |
| Host sends DATA | 0 ms | Original payload, I-bit false |
| Guest receives the original DATA | 101 ms | Exact TSN and payload match |
| Guest emits SACK | 302 ms | 201 ms after receipt, cumulative ACK includes this TSN, no gap |
| Host retransmits the same TSN | 416 ms | Same payload, now I-bit true |
| Host receives the original SACK | 416 ms | Same millisecond; same network-thread log records retransmit first |
| Guest receives the duplicate and acknowledges it | 518 ms | SACK explicitly lists the duplicate TSN |

The trace further orders the retransmission attempt before the original SACK's
actual host UDP receipt by about 0.44 ms. Sub-millisecond precision is not taken
from the text log: it comes from the shared trace clock and independently
identified app socket boundaries. The first original DATA was delivered; this
is not evidence of a lost original packet or an exhausted application window.

The pinned implementation has an initial RTO of 500 ms, a minimum of 400 ms,
and delayed SACK up to 200 ms. T3 expiry reduces congestion allowance to one
MTU. DATA requests immediate acknowledgment while congestion allowance is below
ten MTUs. After the r2 retransmission this I-bit remains set through the sparse
baseline and initial bulk sends. Its first bulk flight is much smaller than
r1's; further segments advance with ACK rounds. This low-window, ACK-paced
startup accompanies the 1,885.20 ms first logical receipt versus r1's 809.20 ms.
The difference between those two timings is not a separately isolated estimate
of the timeout's entire cost.

ACKs alone do not unconditionally grow congestion allowance: the implementation
also requires `unacked_bytes + MTU >= cwnd`. Elapsed idle time does not restore
the initial value, explaining how sparse baseline traffic can leave the reduced
state in place. The DATA RTT sample includes the delayed ACK interval; a
retransmitted TSN is excluded from RTT updates by the Karn rule.

Live internal RTO/cwnd values are not directly exposed in these logs. The
timeout/congestion interpretation combines the observed retransmission,
I-bit transition, ACK ordering and exact implementation; it is not a claim to
have read a live `cwnd=1191` counter. In particular, r1's initial four-packet
burst is consistent with `max_burst=4`, not proof of a four-MTU congestion window.

Both captures use DATA rather than negotiated I-DATA. The source scheduler
finishes a user message before switching streams without interleaving. Thus
two data channels on one SCTP association do not give control traffic an
independent congestion allowance or remove large-message scheduling delays.
The original 64 KiB app message is itself split into MTU-sized SCTP pieces.

For r2's maximum startup `sync-pong`, the recorded 1,106.2 ms app-to-app delay
contains approximately 0.3 ms app-to-native submission, 1,000.3 ms from that
submission to first SCTP DATA emission, 101 ms SCTP endpoint delivery, 4.5 ms
receiver-log-to-native callback and 0.1 ms native-to-app handling. The residual
fraction reflects finite cross-clock/log resolution. The decisive delay is
therefore after the host has submitted its answer and before transport emission,
not a one-second host JavaScript response time.

## Application buffer and receipt distinctions

Chromium's JS `bufferedAmount` is cached. This exact WebRTC implementation only
publishes a decrease when actual unsent data reaches zero or the decrease is
greater than **100 KiB**. The adjacent source comment says 10kb; the executable
constant is `100 * 1024`. Changing the JS low-event threshold does not change
this native notification granularity.

Consequently a roughly 65.7 KB JS plateau does not show a stopped wire. In r2,
the next logical send follows the buffer-low event by roughly 1–3 ms while
the first application's receipt has not arrived. The 128 KiB receipt window
still permits a second 64 KiB chunk: receipt exhaustion did not cause that
first wait. In later r1 samples, credit and local buffer gates both occur.
Neither gate is eliminated as a steady-state throughput constraint.

The first six r2 send intervals shrink from 1,786.7 to 978.2, 775.0, 659.4,
469.6 and 452.2 ms as transport progresses. This is a startup recovery pattern,
not a reason to extrapolate eight seconds into a complete-file timing result.
Sampled gate counts do not measure exact blocked-time percentages.

## Validation, provenance and limits

Raw files live under ignored local
`scratch/startup-transport-cause-2026-10-19/`, in `executor/`, `audit/` and
`design/`. They contain only the task's synthetic/local sessions. Prior raw
results and every unavailable capability attempt are retained.

The independent decoder uses SCTP declared lengths and padding, validates
CRC32C, reconstructs user messages, and matches both observed endpoints.
Outgoing TextPcap records are send attempts, not delivery proof; repeated
identical attempts are not assigned invented one-way latencies. Inner TextPcap
timestamps wrap and have a formatting defect, so outer timestamp/PID/endpoint
and trace clocks are preserved. Same-PID transports are still distinct endpoints.

The decoder's ten pure checks pass, including lengths/padding, CRC vector,
SACK gaps/duplicates, repeated-attempt ambiguity, duplicate-after-completion,
same-PID endpoint distinction and I-DATA reassembly. Final decoder SHA-256:
`7f534ff985da6bfad955e2dcf1b29808bc6e32533ba6ba46d8583babe65ce6b3`.
The earlier 64 KiB capability fixture was reconstructed at both endpoints with
its known hash; product binary envelopes are decoded separately.

| Primary evidence manifest under `executor/` | SHA-256 |
| --- | --- |
| `product-startup-primary-evidence-manifest.json` (r1) | `7833b36c8fa73e860d5ffd67feaadb40238530f7daccb4b19fab0cc4f76cf769` |
| `product-startup-r2-primary-evidence-manifest.json` | `9632610c80f1ba6e4ac447113edab4cf8d2b6ecb6acf3c9798b52e881c71ecbe` |
| `product-startup-r3-primary-evidence-manifest.json` | `11c0640d0524029082d0357d2865e4f2a08d7c5debda96ee04c52a2e6559a2f8` |

The manifests pin runner/config/input freezes, browser output, trace and native
result files. The separate source inventory contains 63 pinned upstream files
and has SHA-256
`0757d775a6cafbb4ce5d19bede38810985c2a740b06b0d41bba380778c6c7f33`.
Independent packet reports and source/trace review live in `audit/` and `design/`;
these are not replacements for their immutable raw inputs.

Independent packet audit: `audit/product-startup-packet-audit.md`, SHA-256
`d5296e787454872e5ec75e6611022e1b964a8b4fb3e4b038cff738627000fddf`;
its 22-file audit/nine-file raw manifest is
`audit/product-packet-audit-manifest.json`, SHA-256
`1419a2f4b21b90b8d70665ccf2dfc6352d7c40b11d75f642ff1a7eeb2a17f601`.
The independent trace-boundary result is `design/trace-r2-boundary-check.json`,
SHA-256 `f3185c187e4c782de14c717a3944e1605b832658492d6debbd464eb318e6c42b`.

The eight-second captures deliberately stop with a transfer in flight. They do
not assert final file SHA, final READY/ACK, complete throughput, audible sync,
real Android behavior, live YouTube quality, multi-receiver behavior, or full
E2E success. There is no successful exact-main release candidate from this round.

The 0→100 ms emulation step preceded the observed timeout. This is a reproduced
transport interaction under the controlled latency transition, not proof that
all real high-RTT sessions or the owner's earlier field incident follow it.
Connections shaped from initial establishment remain a separate question.

## Next implementation boundary

Keep the operating 64/64/128 values and existing failed candidate decisions.
The browser's SCTP RTO/cwnd are not normal application settings. Do not add
unmeasured heartbeat traffic, remove receipt protection, or change playback
correction thresholds on the strength of this diagnosis.

Future candidate testing should cover both a healthy transport and a transport
that has just reduced its congestion allowance. Compare startup and later
steady-state windows separately, preserve the original whole-run budgets, and
confirm improvement in complete ordinary/preload transfers, slow/high-RTT links,
multiple receivers and lifecycle cases before adoption. This round narrows the
reason for startup variability; it does not finish that product optimization.

## Pinned primary implementation references

- [dcSCTP options](https://webrtc.googlesource.com/src/+/9ea5afcad008b940468c2a15aec339592cf5a935/net/dcsctp/public/dcsctp_options.h)
  and [transport overrides](https://webrtc.googlesource.com/src/+/9ea5afcad008b940468c2a15aec339592cf5a935/media/sctp/dcsctp_transport.cc#800).
- [T3 reduction](https://webrtc.googlesource.com/src/+/9ea5afcad008b940468c2a15aec339592cf5a935/net/dcsctp/tx/retransmission_queue.cc#359),
  [burst/I-bit](https://webrtc.googlesource.com/src/+/9ea5afcad008b940468c2a15aec339592cf5a935/net/dcsctp/socket/transmission_control_block.cc#218),
  [SACK timing](https://webrtc.googlesource.com/src/+/9ea5afcad008b940468c2a15aec339592cf5a935/net/dcsctp/rx/data_tracker.cc#176).
- [Non-interleaved scheduler](https://webrtc.googlesource.com/src/+/9ea5afcad008b940468c2a15aec339592cf5a935/net/dcsctp/tx/stream_scheduler.cc#37).
- [RTO estimator](https://webrtc.googlesource.com/src/+/9ea5afcad008b940468c2a15aec339592cf5a935/net/dcsctp/tx/retransmission_timeout.cc)
  and [RTT sample eligibility](https://webrtc.googlesource.com/src/+/9ea5afcad008b940468c2a15aec339592cf5a935/net/dcsctp/tx/outstanding_data.cc#510).
- [JS buffer publication](https://webrtc.googlesource.com/src/+/9ea5afcad008b940468c2a15aec339592cf5a935/pc/sctp_data_channel.cc#872)
  and [Blink cached getter](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/modules/peerconnection/rtc_data_channel.cc#431).
- [P2P shaping](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/services/network/throttling/throttling_p2p_network_interceptor.cc#73).
