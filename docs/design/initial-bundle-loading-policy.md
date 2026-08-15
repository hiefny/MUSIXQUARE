# ADR: Preserve the Current Initial Bundle Boundaries

- **Status:** Accepted
- **Decision date:** 2026-08-15
- **Applies to:** the Vite application entry graph, feature-level dynamic imports,
  the service-worker app shell, and optional font loading

## Context

MUSIXQUARE is a realtime, multi-device audio application for modern,
high-capability browsers. Its intended operating environment is a venue or room
with a good network, not a low-bandwidth content-reading path. Correct startup,
session recovery, synchronized state, and a dependable offline app shell are
more important to that product than reducing the headline entry-chunk size in
isolation.

The build already maintains deliberate loading boundaries:

- PeerJS and QR encoding stay outside the static closure of `src/app.ts` and are
  loaded only after session actions need them;
- optional primary-font assets stay outside the initial script and stylesheet
  graph; and
- the checked build measures the complete HTML-declared eager graph and rejects
  growth beyond its raw, gzip, JavaScript, total-transfer, and eager-font
  budgets.

The service worker also derives its deterministic app-shell closure from the
rendered entry graph. Adding more feature-level chunks is therefore not only a
transfer-size change. Each new boundary can add an asynchronous initialization
and recovery seam, loading and failure states, cancellation and stale-result
races, and another asset set whose cold-offline install and update behavior must
remain coherent.

Current measurements remain inside the checked-build budgets. No supported
field or venue measurement currently shows that JavaScript transfer, parsing,
or execution at the existing boundary prevents the app from meeting an agreed
startup objective. Under the current product and network assumptions, the
expected benefit of another broad bundle split is lower than its runtime,
recovery, and offline-stability cost.

## Decision

Preserve the current initial and lazy-loading boundaries. Do not introduce an
additional feature-level bundle split solely to improve a static bundle-size
recommendation or the size of one generated chunk.

In particular:

- keep bootstrap, shared state/event registration, lifecycle recovery, and the
  controls needed for the first usable application state in the existing eager
  graph;
- retain the established session-only dependency and optional-font lazy
  boundaries;
- keep the initial-transfer budget and app-shell guards as shrink-or-hold
  ratchets; this decision is not permission for unmeasured eager growth; and
- prefer removing unused work, reducing bytes within an existing boundary, or
  deferring non-runtime media before adding a new asynchronous application
  seam.

No bundle or runtime code changes are part of this decision.

## Consequences

The entry chunk may remain larger than a generic website-oriented audit would
recommend. In exchange, the application keeps one well-tested bootstrap path,
fewer partial-initialization states, and a smaller recovery and offline-update
surface. Performance reviews must evaluate the full eager graph and observable
startup behavior rather than treating a single chunk size as the outcome.

Existing lazy paths are still contracts. A change that accidentally pulls
PeerJS, QR encoding, optional fonts, or another reviewed deferred asset into the
initial graph must continue to fail the relevant build guard.

## Reconsideration Criteria

Reopen this decision when measured evidence shows at least one of the following:

- representative cold-start tests on supported devices and venue networks miss
  an adopted startup or interaction-readiness SLO, and profiling attributes a
  material share of the miss to eager JavaScript transfer, parse, compile, or
  execution;
- production or controlled field evidence shows repeated startup failure,
  browser termination, or unusable first interaction attributable to the eager
  graph;
- the product SLO, supported device class, or network target changes to include
  materially slower hardware, constrained links, or an offline-first startup
  requirement;
- the eager graph cannot remain inside the checked-build budget after unused
  code and assets have been removed and the proposed product work is otherwise
  justified; or
- cold-offline installation or service-worker update reliability fails because
  of the size or composition of the current app-shell closure.

A future split proposal must include representative before/after raw and gzip
bytes, browser parse/execute and main-thread measurements, and cold-cache and
offline install/update results. It must also define chunk ownership, loading
UI, timeout/cancellation behavior, stale-result recovery, service-worker cache
migration, real-device verification, and rollback. A smaller generated chunk
without those end-to-end results is not sufficient evidence.

## Non-goals

This decision does not freeze the module graph, remove current dynamic imports,
weaken the initial-transfer budget, or forbid a later evidence-backed split. It
records why further broad separation is intentionally deferred under the
current product assumptions.
