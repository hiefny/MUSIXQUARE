# ADR: Defer Session-Only Feature Graphs with Guaranteed Headroom

- **Status:** Accepted
- **Decision date:** 2026-08-15
- **Applies to:** the Vite application entry graph, room-session readiness,
  the service-worker app shell, and initial-transfer budgets

## Context

The checked production build remained below its architectural transfer limits,
but several metrics had effectively no maintenance reserve. In particular, the
entry raw size was within roughly 1 KiB of its ceiling. A passing build could
therefore regress through an otherwise routine fix while still appearing
healthy.

After the deferred boundaries below landed, the eager total raw graph still sat
only 5.27% below its architectural limit. That left roughly 4.6 KB before the
mandatory 5% maintenance ceiling, so the historical limits no longer provided
a useful operating envelope even though the conditional loading boundaries were
working as designed.

The eager graph also contained standard-room and PRO system-audio listener
implementations before a user had selected or entered any room. Those modules
are not needed to render setup, restore local settings, recover the service
worker, or present the first usable application state. They are needed before
the first signaling transport or PRO presence can deliver a system-audio
frame, so a fire-and-forget import would not be a safe boundary.

Demo mode is not a safe conditional boundary today. Its protocol handlers must
exist before an incoming demo frame and its first-run prompt observes bootstrap
state. Loading it unconditionally through `await import()` would reduce an HTML
graph measurement without reducing readiness work, so demo remains eager and
is counted honestly in the entry.

## Decision

Add genuinely conditional session boundaries. The room-session boundary
contains:

- standard host system-audio routing;
- standard guest system-audio reception;
- the standard-room SFU route;
- the PRO system-audio service; and
- local-output rejoin, which is meaningful only for an entered room.

Media Session controls use a separate shared optional loader. Room entry starts
it from the listener runtime, while guided-demo entry starts it directly because
demo playback creates no signaling transport. Late initialization seeds the OS
metadata and playback state from canonical app state, so neither route loses a
track update during the import race. Failure remains an isolated enhancement
failure and never blocks playback.

The Connect boundary contains the panel, which loads after a host/guest
role is selected or when the Connect tab is explicitly opened.

`room-session-feature-loader.ts` owns a shared import promise. Standard-room
transport creation awaits that promise before creating a signaling peer. Every
PRO room open path (resume, join, activate, owner recovery, and owner transfer)
awaits the same promise before calling its controller. Each caller races the
shared import against its own AbortSignal, so cancelling setup settles that
caller immediately without cancelling a load another room entry can reuse.
This makes role-driven concurrency and direct/autojoin calls converge on one
initialization and fails closed if the reviewed listener graph cannot load. No
protocol frame can race ahead of listener registration. Protocol-critical
listeners fail closed; optional Media Session and local-output enhancements
fail independently. A terminal ESM load/evaluation failure is retained for the
document and shown as an explicit reload action rather than a same-specifier
retry that browsers may not re-evaluate. The PRO runtime import uses the same
terminal document-scoped policy, so one-time claim flows cannot mistake an ESM
failure for a replayable network operation. Connect replays the canonical
device-list and PRO administrator snapshots after registering its listeners so
an update cannot be lost during import.

The deferred roots remain part of the deterministic offline contract. The Vite
service-worker manifest includes the Connect, room-session, and Media Session
roots plus their static JS/CSS closure, even though they are absent from the
HTML-declared eager graph. A newly installed or updated worker therefore caches
the exact hashed chunks required to initialize these reviewed deferred
boundaries after an offline shell launch. This shifts parse/evaluation work out
of the HTML critical path; the service-worker install still downloads the
deferred closure in the background and is not claimed as a reduction in total
first-install wire bytes.

The build enforces both sides of the decision:

- Connect, room-session, and Media Session implementation modules must not
  re-enter the static closure of `src/app.ts`; and
- every positive initial-transfer budget must retain at least 5% headroom.
  Zero-byte budgets, such as eager fonts, remain strict zero-byte contracts.

Raise every positive architectural limit by exactly 10% from its previous
value. Keep the 5% reserve unchanged, so the enforceable maintenance ceiling
remains 95% of each revised limit. This is a one-time re-baseline backed by the
measurements below, not permission to make session-only features eager or to
silently raise the limits again.

Vite's `chunkSizeWarningLimit` is derived from the same entry-script raw-byte
architectural limit, converted to Vite's decimal kB unit. The post-build guard
remains stricter because it enforces the 5% reserve and also measures gzip and
the complete HTML-declared eager graph. Because Vite applies that setting to
every chunk, a build plugin separately fails any non-main JavaScript chunk over
the original 500 kB raw boundary. Raising the main-entry envelope therefore
does not make lazy or secondary page chunks invisible.

## Measurement

On the checked production build used for this decision, the generated main
entry moved from 1,334.19 kB raw / 390.13 kB gzip to 1,243.94 kB raw /
362.85 kB gzip. The deterministic guard measured:

| Metric                | Actual bytes | Previous limit | Revised limit | 95% ceiling | Revised headroom |
| --------------------- | -----------: | -------------: | ------------: | ----------: | ---------------: |
| Entry script raw      |    1,243,939 |      1,335,000 |     1,468,500 |   1,395,075 |           15.29% |
| Entry script gzip     |      362,851 |        400,000 |       440,000 |     418,000 |           17.53% |
| Eager JavaScript gzip |      367,136 |        400,000 |       440,000 |     418,000 |           16.56% |
| Eager total raw       |    1,610,438 |      1,700,000 |     1,870,000 |   1,776,500 |           13.88% |
| Eager total gzip      |      429,901 |        460,000 |       506,000 |     480,700 |           15.04% |
| Eager fonts           |            0 |              0 |             0 |           0 |       fixed zero |

### 2026-08-27 Chromium 79 compatibility addendum

The 2026-08-15 one-time re-baseline above remains the rule for ordinary
feature work. This addendum explicitly supersedes only its numeric ceilings to
restore the supported-browser floor on 2021 LG webOS televisions. It is not a
silent feature-budget increase: no session-only boundary became eager.

The compatibility build lowers the application JavaScript from ES2022 to the
Chromium 79 syntax floor and expands cascade layers and `:is()` selectors into
equivalent legacy selectors before asset hashing. Those transformations trade
raw parse bytes for compatibility and account for the measured increase. The
same post-build guard still reserves 5% of every positive limit, the secondary
chunk ceiling remains unchanged, and eager fonts remain a strict zero-byte
contract.

The final checked production build for this addendum measured:

| Metric                | Actual bytes | Prior limit | Compatibility limit | 95% ceiling | Headroom |
| --------------------- | -----------: | ----------: | ------------------: | ----------: | -------: |
| Entry script raw      |    1,446,225 |   1,468,500 |           1,525,000 |   1,448,750 |    5.17% |
| Entry script gzip     |      418,616 |     440,000 |             442,000 |     419,900 |    5.29% |
| Eager JavaScript gzip |      424,235 |     440,000 |             448,000 |     425,600 |    5.30% |
| Eager total raw       |    1,858,184 |   1,870,000 |           1,965,000 |   1,866,750 |    5.44% |
| Eager total gzip      |      491,802 |     506,000 |             520,000 |     494,000 |    5.42% |
| Eager fonts           |            0 |           0 |                   0 |           0 |    fixed |

Future compatibility or feature changes must update this decision again with
fresh measurements; the new ceilings are not spendable targets.

### 2026-09-06 readability and maintenance addendum

The audited 8.4.63 candidate (`7cb2577d`) measured 493,942 B eager gzip:
only 58 B below the enforced 494,000 B ceiling. Entry-script gzip had 1,221 B
available. Preserving that envelope encouraged repeated source rewrites for
very small gzip differences, including duplicating a named refresh callback
and making touch/abort cleanup less explicit. A passing build no longer left
useful working room for ordinary maintenance.

This reviewed re-baseline raises each positive architectural limit by exactly
10% from the Chromium 79 addendum. It supersedes those numeric limits while
retaining the 5% protected reserve, the zero-byte eager-font contract, the
500,000 B secondary JavaScript chunk limit, and all eager/deferred readiness
and offline-installation boundaries. It is a capacity decision, not a target
to add 10% more JavaScript or permission for automatic future increases.

The 8.4.64 checked build restores the shared player-text callback, gives
Android range cancellation an explicit release operation, and clarifies why
YouTube seek reschedules the pending rendezvous. It retains useful semantic
deduplication and generated production minification. Product/version mirrors
and the service-worker epoch advance together to 8.4.64 / v552.

| Metric                | 8.4.63 actual B | 8.4.64 actual B | Revised limit B | 95% ceiling B | Working room B |
| --------------------- | --------------: | --------------: | --------------: | ------------: | -------------: |
| Entry script raw      |       1,436,383 |       1,436,380 |       1,677,500 |     1,593,625 |        157,245 |
| Entry script gzip     |         418,679 |         418,721 |         486,200 |       461,890 |         43,169 |
| Eager JavaScript gzip |         423,698 |         423,740 |         492,800 |       468,160 |         44,420 |
| Eager total raw       |       1,819,457 |       1,819,454 |       2,161,500 |     2,053,425 |        233,971 |
| Eager total gzip      |         493,942 |         493,984 |         572,000 |       543,400 |         49,416 |
| Eager fonts           |               0 |               0 |               0 |             0 |        fixed 0 |

Working room is the distance to the enforced 95% ceiling. It is separate from
the protected 5% reserve: eager gzip now has 49,416 B working room plus
28,600 B protected reserve. The actual eager transfer change is only +42 B
gzip and -3 B raw; increasing a guard does not itself increase transfer cost.
Both figures come from the current deterministic gzip9 HTML-graph measurement,
not all service-worker installation traffic or field network usage.

A local cold-start comparison used Chromium 147.0.7727.15, 4x CDP CPU slowdown,
150 ms network latency, 1.6 Mbit/s download and 0.75 Mbit/s upload, gzip static
responses, and a 390x844 viewport. Five fresh browser contexts per build were
run in alternating order with browser cache disabled. API calls returned the
same local 503 in both variants, external requests were blocked, and service
workers were allowed. Bootstrap reached all 52 steps with zero failures,
fallbacks, or page errors in all ten observations.

| Median observation     |     8.4.63 |     8.4.64 | Difference |
| ---------------------- | ---------: | ---------: | ---------: |
| Bootstrap ready        | 3,175.7 ms | 3,180.5 ms |    +4.8 ms |
| First contentful paint |   3,428 ms |   3,432 ms |      +4 ms |

These observations show a small difference within the ranges of these runs;
they are not a statistical performance guarantee. This simulation is not a
physical low-end TV measurement, a room-entry benchmark, or an adopted field
SLO. In particular, it does not establish that spending the entire new
envelope would preserve current performance. Raw observations and settings are
recorded in `docs/performance/readability-budget-2026-09-06.json`.

For future changes, keep readable names, explanatory comments, and explicit
cancellation/ownership paths. Share a behavior when it expresses the same
contract, not merely when a particular source spelling compresses better.
Before changing capacity again, record the affected source boundary, before/
after raw and gzip output, representative startup or room-entry observations,
and required cold-cache/offline regression evidence in a new dated decision.
Review all affected metrics together; increasing total gzip alone can leave
the entry or raw-byte guards as the next bottleneck. Do not lower the reserve,
hide eager work behind unconditional imports, or silently revise limits to
make a failing build pass. Source line limits remain a separate policy in
`source-complexity-ratchet.md`.

## Consequences

Setup, local/offline recovery, demo protocol/UI, visualizer, file-drop, and
accessibility bindings remain eager. The asynchronous seams are limited to the
Connect surface, a network-session feature graph, and the shared optional Media
Session integration started by demo or room entry. Standard and PRO entry
points explicitly own network-listener readiness rather than relying on timing.

The service worker downloads the reviewed deferred chunks during app-shell
installation. They do not block the document's eager transfer graph, but they
do consume cache storage. This is intentional: predictable offline recovery is
more important than omitting room-critical code from the installed generation.

Future changes may shrink these boundaries, but cannot spend the maintenance
reserve, make room entry race listener registration, remove the reviewed chunks
from the offline app shell, or pull them back into the initial static graph
without changing this decision and its guards.

## Reconsideration Criteria

Revisit the boundary when representative startup or room-entry measurements
show that one of the following is true:

- loading the room-session chunk materially delays room entry on a supported
  device/network despite the existing loading UI;
- service-worker installation reliability or cache pressure is harmed by the
  reviewed deferred closure;
- protocol architecture provides a smaller synchronous registration facade
  that can safely queue every affected frame; or
- the product adopts a different offline or startup SLO.

Any replacement must include before/after raw and gzip measurements, standard
and PRO race tests, cold-cache and offline update verification, and a rollback
plan.
