# Container-native shaped A/B: B128, SA192 and the delay-based window

Status: independent first native comparison of the
[delay-based receipt window candidate](delay-based-credit-window-2026-10-19.md).
It is not a release record, not an exact-main candidate and not the team's
frozen native contract. Production remains App 8.11.20/cache v723.

| Arm | Source | Receipt window |
| --- | --- | --- |
| B128 | main `deb52829930d0b8a4b87e70b05f84aa7c242c799` | fixed 128 KiB, shared control association |
| SA192 | #410 head `6a5afaaefe2c301b3b37a4f5c43ebe2ef36a01f2` | isolated control, adaptive 128–192 KiB |
| DB256 | `a85831d4a5308f11adb178a47a6aca41f9d4d458` (runtime `4b83ba14`) | isolated control, delay-based 128–256 KiB |

All three are `vite build --mode e2e` of the exact source.

## Method

Linux cloud container (Ubuntu 24.04, kernel 6.18 without `sch_netem`), Node
24.20.0, Playwright 1.63, Chromium 141.0.7390.37. The team's Chromium 153 P2P
throttling is unavailable here: 141 has no `Network.emulateNetworkConditionsByRule`,
its `emulateNetworkConditions` does not shape WebRTC, and Chrome for Testing
hosts are outside this environment's network policy.

- Host and guest browsers run in separate network namespaces (`10.201.0.2`,
  `10.200.0.2`) routed through the root namespace. Each gathers one host
  candidate, ICE selects host/host and the app classifies the guest as local.
  A first layout with the host browser in the root namespace produced a
  peer-reflexive pair, remote classification and no direct transfer; it is not
  used.
- A userspace bottleneck (NFQUEUE) shapes UDP only, at each receiving
  namespace's ingress: one FIFO per direction served at the profile rate, then
  a fixed one-way delay, zero loss below a 16 MiB backlog. Both
  RTCPeerConnections of a direction share the FIFO; HTTP/WebSocket are not
  shaped. A rate change applies to packets still queued. An earlier
  egress-queue variant held packets against the sender's UDP socket buffer and
  capped throughput at 2.5 Mbps; it is not used.
- Calibration with a raw data channel and a 1 MiB send buffer: 8 Mbps with
  100 ms each way gives 203 ms RTT and 21.0 MB in 23.18 s (7.24 Mbps); 2 Mbps
  gives 1.91 Mbps.
- Local `wrangler dev --local` Standard signaling plus PRO room (its service
  control otherwise reports maintenance); a runtime override points both pages
  at it. E2E mode skips TURN/STUN, so ICE uses host candidates only.
- Fixture: generated 23,040,044-byte PCM WAV (352 chunks, SHA-256
  `f7b7bde7e586418660d0406d2889e23fcf40675e9a1b6dab23f5c2a15624af89`), not the
  team's MP3 fixture.
- Each run uses fresh contexts with shaping applied before the room is
  created: room create and join through the UI, 12 s quiet baseline, then the
  host uploads and plays the fixture (ordinary current-file transfer) until the
  guest has all 352 chunks, plus 10 s. Dynamic (dyn828): 8 Mbps, 2 Mbps from
  10 s after the first chunk, 8 Mbps again at 40 s. Two repetitions per arm
  and profile, arm order reversed on the second.
- Every `RTCDataChannel` send and receive in both pages is logged with
  `performance.timeOrigin + now()`. Both browsers share the machine clock, so
  each control message's one-way delay is measured directly, including the
  100 ms propagation. Payload time is first chunk sent to last chunk
  received; debt is credited payload sent minus the newest cumulative receipt
  seen by the host.

## Results

All 18 runs ended with the guest at `READY` holding exactly 23,040,044 bytes.
Values are run 1 / run 2. Sync-pong is host→guest one-way delay during the
transfer (about one per second); its quiet baseline median was 101.5–103.8 ms in
every run.

| Profile | Arm | Payload s | Sync-pong p50 | p95 | max (ms) | Max debt |
| --- | --- | --- | --- | --- | --- | --- |
| 8 Mbps | B128 | 66.76 / 60.78 | 159 / 152 | 420 / 237 | 1,712 / 580 | 128 KiB |
| 8 Mbps | SA192 | 36.70 / 36.57 | 106 / 108 | 130 / 131 | 133 / 136 | 192 KiB |
| 8 Mbps | DB256 | **26.98 / 26.97** | 121 / 141 | 140 / 152 | **155 / 155** | 256 KiB (85% of the time) |
| 2 Mbps | B128 | 100.82 / 100.66 | 324 / 327 | 456 / 450 | 543 / 642 | 128 KiB |
| 2 Mbps | SA192 | 101.02 / 100.88 | 260 / 260 | 328 / 326 | 341 / 337 | 128 KiB |
| 2 Mbps | DB256 | 100.88 / 101.05 | 262 / 265 | 325 / 331 | 338 / 337 | 128 KiB |
| 8→2→8 | B128 | 72.73 / 72.81 | 196 / 203 | 440 / 439 | 461 / 460 | 128 KiB |
| 8→2→8 | SA192 | 58.79 / 58.73 | 190 / 187 | 333 / 329 | 340 / 335 | 192 KiB |
| 8→2→8 | DB256 | **50.54 / 50.23** | 246 / 248 | 293 / 286 | **425 / 716** | 256 KiB |

B128's numbers reproduce the team's records closely (8 Mbps ordinary 66.18 s,
2 Mbps 101.6 s). Its large maxima occur while the shaper's downlink wait stays
at or below 33 ms, i.e. inside the shared association, not the network queue.

- **8 Mbps:** DB256 is 26% faster than SA192 and 56–60% faster than B128. Its
  sync-pong p95 is 10–20 ms above SA192 and the maximum 19–22 ms above. The
  downlink queue wait was p95 45 ms, max 68 ms (SA192 26/39 ms).
- **2 Mbps:** DB256 never grew past 128 KiB and matches SA192.
- **8→2→8:** DB256 held 256 KiB at the drop, sent nothing new after about
  0.3 s and its debt was back at 128 KiB about 0.8 s after the drop. The shaper's downlink wait
  peaked at 785/798 ms (SA192 501/519 ms, B128 255/241 ms), matching the
  predicted collapse transient. Pongs that crossed the peak saw 425 and 716 ms.
  After the drop DB256 and SA192 alternate in the same 200–320 ms band. Medians
  mix segments: DB256's shorter transfer spends a larger share in the 2 Mbps
  segment.

Against the team's frozen budgets as applied here: every control maximum is
below 1,000 ms and no p95 rises by 100 ms. The paired maximum rise of at most
250 ms holds at 8 and 2 Mbps. On 8→2→8 it holds against B128 in run 1
(−37 ms) and misses it in run 2 (+256 ms); against SA192 the rise is +84 and
+381 ms. This is the sudden-collapse limit described for the candidate.

## Limits

Chromium 141 with a userspace packet bottleneck, not Chromium 153's P2P
throttling; a WAV fixture; the ordinary current-file transfer only, with no
preload, multiple receivers, shared host uplink, reconnect or mixed versions;
two repetitions; host candidates without TURN; sync-pong sampled about once a
second, so which run catches the collapse peak is phase-dependent; no physical
devices or audible sync. The harness and raw logs are outside the repository.
