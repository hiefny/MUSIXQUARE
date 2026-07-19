# ADR: Static Asset Delivery and PRO Heartbeat Persistence

- **Status:** Accepted
- **Decision date:** 2026-07-19
- **Applies to:** the production App Worker static-asset route and ordinary
  PRO-room presence heartbeats

## Context

Two measured costs do not contribute to MUSIXQUARE's playback behavior:

1. content-hashed JavaScript, CSS, and Pretendard WOFF2 files currently enter
   the App Worker before the Static Assets binding serves them; and
2. every authenticated PRO-room heartbeat persists a complete v2 core record,
   even when the only mutation is a participant's `lastSeenAtMs` renewal.

An isolated Cloudflare routing probe verified that the reviewed content-hashed
asset types can be served directly by Static Assets while retaining the current
immutable cache policy, MIME types, security headers, CSP, and same-origin CORS
behavior. A 100-participant benchmark also showed that one-second heartbeat
coalescing substantially reduces v2 core writes without changing request
authentication, validation, or responses. Reproduction notes and raw evidence
live in [the static-asset probe](../app-static-assets-staging.md) and
[the heartbeat benchmark](../performance/pro-room-heartbeat-benchmark.md).

## Decision

### 1. Bypass the App Worker only for reviewed hashed assets

Production Static Assets routing bypasses App Worker code only for existing
top-level `/assets/*.js`, `/assets/*.css`, and `/assets/*.woff2` files.

- HTML, `/`, six-digit room routes, `/api/*`, `/admin`, the service worker, and
  stable bootstrap files remain Worker-first.
- The bypass does not broaden CORS and does not change the asset bytes or URLs.
- Equivalent immutable caching and security headers are materialized into the
  production build artifact so direct Static Assets responses retain the
  current response contract.
- The production build fails closed if a bypass candidate does not end in the
  same eight-character Vite content hash recognized by the service worker.
- A plain `npm run build` materializes the canonical header file, while the
  checked-build guard verifies byte parity instead of mutating the artifact.
- Unsupported files and missing module URLs must not fall back to HTML.
- The change does not alter service-worker cache selection. An already active
  service worker still handles its own cached and retired-cache assets before
  a request reaches the origin.

Rollback is configuration-only: restore `run_worker_first = ["/*"]`. Because
the PWA runtime and asset bytes do not change solely for this routing decision,
the routing change does not itself require a service-worker cache-version bump.

### 2. Coalesce only pure PRO presence-heartbeat durability

A pure authenticated PRO heartbeat still validates the participant and
presence incarnation, updates the in-memory `lastSeenAtMs`, evaluates expiry
and compatibility conditions, and responds immediately. The first heartbeat
after a quiet period persists inline, exactly as before. If another pure
heartbeat arrives inside the following one-second window, only those dense
renewals are coalesced until the end of that window.

This heartbeat belongs to the canonical PRO room Durable Object. It renews the
authoritative HTTP presence lease; it is not a ping emitted by a browser
coordinator and it does not own a WebSocket. Hibernatable browser sockets,
attachments, and realtime fan-out belong to the separate signaling Durable
Object. The optimization therefore changes neither socket membership nor the
server-owned playback timeline.

Every semantically meaningful mutation remains an immediate full persistence
boundary, including:

- participant join, explicit leave, expiry removal, or session invalidation;
- room-control incarnation, presence topology, or authorization changes;
- PIN, room lifecycle, system-audio, playback transition/READY, playlist,
  quota, or media mutations; and
- Developer API command changes and required legacy rollback-shadow refreshes.

An immediate persistence absorbs any pending heartbeat flush, cancels its
timer, and generation-fences an already-dispatched callback so older work
cannot overwrite or redundantly persist newer state. Failures are contained,
kept retryable by a later heartbeat or the existing room alarm, and must not
produce an unhandled rejection.

`DurableObjectState.waitUntil()` is deliberately not used as a lifecycle
mechanism: [Cloudflare documents it as a compatibility no-op for Durable
Objects](https://developers.cloudflare.com/durable-objects/api/state/#waituntil).
A [`setTimeout` prevents hibernation while it is
pending](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/),
so no timer is created for a solitary heartbeat. The timer is opened only after
a second heartbeat is observed inside an already-persisted one-second window,
and only for that window's remaining duration. A 100-request aligned burst
therefore requires at most two v2 core writes (the immediate anchor and one
trailing flush), while a one-participant room keeps its current
one-write-per-heartbeat behavior and adds no idle timer.

Cloudflare SQLite storage accounting is row-based: each pure durability flush
in this schema writes one `pro-room:v2:core` row. Serialized-byte and CPU
reductions remain real, but they are not themselves a byte-billed storage-cost
forecast. Conversely, the dense-traffic timer prevents hibernation for its
remaining sub-second lifetime and may add Durable Object duration. Net cost is
therefore workload-dependent; the hybrid primarily avoids penalizing quiet and
single-participant rooms while reducing dense write amplification.

The schema stays at v2. A Durable Object interruption can discard only pure
renewals accepted during the open window of at most one second; it cannot lose
a committed participant topology or room-control change. For an affected
participant the durable timestamp can fall back to its preceding client
heartbeat (normally about 15 seconds earlier), still leaving roughly 30 seconds
inside the default 45-second expiry lease for the next heartbeat to recover.
A 17-second expiry guard (15-second client interval + one-second coalescing +
one-second retry allowance) forces inline persistence if that safety margin is
not present. Configured presence TTLs at or below that guard safely disable
coalescing. At the nominal 15-second cadence, TTLs up to 32 seconds also make
periodic renewals persist inline. The runtime accepts a 15-second minimum for
compatibility, but a TTL that equals the nominal client interval has no network
or scheduling margin and must not be used operationally; keep production at 45
seconds and do not lower it below 30 seconds without redesigning the client
interval contract.

## Deliberately deferred: stable core/presence schema split

Separating stable room state from presence into new persistence keys could
reduce write amplification further, but it is not unfinished work required by
this decision. It would introduce a new schema, migration, rollback, and
cross-record consistency contract while PRO rooms remain a private beta.

Reconsider that split only if production evidence shows at least one of these
conditions:

- dozens of PRO rooms are simultaneously active for sustained periods;
- Durable Object write volume or CPU becomes a material operating cost; or
- one-second coalescing still causes observable mutation latency or capacity
  pressure.

Any later proposal must define an atomic migration and a rollback that can read
the preceding v2 representation. Until then, v2 core plus per-row playlist
persistence remains the source of truth.

## Non-goals

This decision does not modify fonts, media transport, preload, R2 behavior,
playback synchronization, queue semantics, public API contracts, room limits,
or visible interaction timing.
