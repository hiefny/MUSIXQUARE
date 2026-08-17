# PRO room heartbeat persistence benchmark

This benchmark compares the pre-optimization Worker at
`8cedc0815456984a61929891a820ef85978bb5ae` with the current working-tree
hybrid scheduler. Both versions execute their real
`MusixquareProRoom.fetch()` and persistence paths. The candidate is not a
simulation or a monkey-patched `persist()`.

## Reproduce

From the repository root:

```powershell
node scripts/benchmark-pro-room-heartbeats.mts `
  --json docs/performance/results/pro-room-heartbeat-hybrid-working-tree.json
```

The script loads the baseline with `git show`, instruments both modules only in
memory, and reports whether the working-tree Worker is dirty. The direct
before/after capture is
[`pro-room-heartbeat-hybrid-working-tree.json`](./results/pro-room-heartbeat-hybrid-working-tree.json).

## Workload

- 100 active participants and 100 live session records
- 1,000 already-persisted YouTube playlist rows
- warm v2 persistence, so unchanged playlist rows are not rewritten
- four bursts of 100 authenticated heartbeat requests (400 total)
- compact revision payloads, matching the normal not-modified response path
- a 15-second quiet gap modeled by resetting only the candidate's in-memory
  heartbeat anchor before each round

Setup, credential creation, activation, and initial 1,000-row persistence are
excluded. The candidate uses its actual one-second timer: response-path time is
measured separately from the intentional timer-drain wall time.

## Measured result

Recorded with Node 24.13.1 on a Windows i7-13800H machine on 2026-07-19:

| Mode                       | Heartbeats | Durability flushes | Core-row puts | Serialized bytes | Response path | Persist CPU | Timer drain |
| -------------------------- | ---------: | -----------------: | ------------: | ---------------: | ------------: | ----------: | ----------: |
| Baseline immediate persist |        400 |                400 |           400 |       43.689 MiB |      2,991 ms |    2,192 ms |        0 ms |
| Current hybrid 1 s         |        400 |                  8 |             8 |        0.874 MiB |      1,238 ms |       73 ms |    4,116 ms |

Each flush rewrote one 114,527-byte `pro-room:v2:core` value. It did not rewrite
a playlist row, the legacy rollback shadow, or the alarm. The hybrid therefore
reduced core-row writes, serialized bytes, and full validation/serialization
passes by 98% for aligned bursts: one immediate anchor plus one trailing flush
per round.

The deterministic uniformly staggered model spreads 100 participants across
each 15-second interval. The hybrid requires approximately 64 flushes instead
of 400 (one immediate anchor plus fifteen trailing windows per round), an 84%
reduction. This is the more conservative model when client timers are not
aligned.

### CPU diagnostics

The diagnostics below execute exact unexported Worker helpers through an
in-memory benchmark-only export. They overlap and must not be added together.

| Phase, 400 iterations            |  Total |     Mean |      p95 |
| -------------------------------- | -----: | -------: | -------: |
| Core serialization               | 100 ms | 0.249 ms | 0.328 ms |
| Playlist serialization           | 143 ms | 0.358 ms | 0.424 ms |
| 1,000-item signature scan        |  81 ms | 0.202 ms | 0.272 ms |
| Complete bounded-state invariant | 516 ms | 1.289 ms | 1.862 ms |

The baseline persistence total includes 1,144 ms spent cloning all fake
storage for unit-test transaction rollback. Production SQLite Durable Object
transactions do not perform that clone in JavaScript, so the local speedup is
not a production latency forecast.

## Cost interpretation

Cloudflare SQLite storage accounting counts rows written, not the JSON byte
totals above. Each measured pure heartbeat flush writes one v2 core row. The
98%/84% row-count reduction and avoided serialization work are real; the
43.689-to-0.874 MiB comparison is a write-amplification diagnostic, not a
byte-billed storage saving.

A pending `setTimeout` also prevents Durable Object hibernation and can add
duration charges. The hybrid therefore persists the first heartbeat after a
quiet period inline and creates no timer for isolated 15-second heartbeats. A
timer exists only after a second heartbeat arrives inside the already-open
one-second window, and only for that window's remainder. Net cost benefit
depends on room density and arrival shape.

## Correctness boundary

Only `lastSeenAtMs` durability from an otherwise pure, authenticated presence
heartbeat is coalescible. Authentication, request validation, pruning,
Developer command evaluation, and the response remain immediate.

The measured request reaches the canonical PRO room Durable Object and renews
its authoritative presence lease. It is separate from the signaling Durable
Object that owns hibernatable browser sockets, clock replies, and realtime
event delivery. Consequently the benchmark does not measure socket wakeups,
fan-out latency, PREPARE delivery, or canonical playback scheduling.

The following remain immediate full-persistence boundaries:

- participant join, explicit leave, expiry removal, or session invalidation
- room-control incarnation, presence topology, or authorization changes
- PIN, lifecycle, system-audio, playback transition/READY, playlist, quota, and
  media mutations
- Developer command changes and every other semantically meaningful full room
  mutation; the current persistence-v2 contract has no legacy rollback shadow

An immediate mutation cancels and generation-fences an older timer only after
its full transaction and alarm maintenance succeed. A failed deferred flush
keeps its state dirty and is retryable by the next heartbeat or room alarm.

An interrupted timer can discard the pure renewal accepted inside that window,
so the durable timestamp may return to the participant's preceding successful
heartbeat, normally about 15 seconds earlier. The 17-second guard consists of
the 15-second client heartbeat interval plus one second each for coalescing and
retry. It forces inline recovery before expiry can race the next heartbeat. The
default presence TTL remains 45 seconds. TTLs at or below 17 seconds always
disable coalescing; at the nominal 15-second cadence, TTLs up to 32 seconds
also make periodic renewals persist inline. Operational deployments should not
lower the TTL below 30 seconds without changing the client interval contract.

## Caveats

- This is an in-process Node benchmark, not Cloudflare production latency.
- Fake storage uses the unit-test rollback-clone pattern; production SQLite
  does not clone the complete storage map in JavaScript.
- Response timing excludes the intentional trailing timer wait; timer-drain
  time is reported separately.
- The benchmark proves scheduler behavior and operation counts, not total
  Cloudflare invoice savings. Production observability is needed for that.
