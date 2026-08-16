# Security and hot-path performance policy

Status: maintained architecture and audit policy.

This policy prevents a security audit from protecting one risk by silently
moving unrelated, cross-tier, or best-effort controls onto the standard-room
startup path. It does not permit removing an authorization boundary to improve
latency. It requires the strength and placement of a control to match the asset
being protected.

## Security tiers

| Tier                 | Assets and examples                                                                             | Required boundary                                                                                                                                                                       | Synchronous work policy                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard/free room   | Ephemeral six-digit room, ordinary signaling, locally held media                                | Signed short-lived capability where an API has direct cost; Origin validation; host secret and first-frame host authentication; bounded pending sockets, messages, rooms, and lifetimes | Keep room-code claim independent of TURN completion. At most one remote atomic security decision may precede a TURN credential mint. Standard WebSocket admission must not add a service-control decision in front of the room Durable Object. |
| PRO and stored media | Persistent room authority, PRO signaling tickets, D1 ownership, remote-share and R2 bytes       | Server-authoritative owner/member tickets, D1 compare-and-set/generation/tombstone rules, exact allocation and byte quotas, private R2 objects and scoped signed URLs                   | Exact D1/DO/R2 decisions are permitted when they protect durable authority, allocation, or billable bytes. They must not become a dependency of a standard/free-room flow.                                                                     |
| Admin and release    | Administrative state, secrets, schema migrations, production artifacts and deployment authority | Cloudflare Access or equivalent strong identity, CSRF/session boundaries, secret separation, immutable artifact identity, append-only migration and deployment-order guards             | Strong fail-closed checks are expected. Release-only checks do not count against runtime latency, but their code or service owner must not be imported into a standard-room request merely for reuse.                                          |

Provider credentials stay server-side in every tier. Input and response bounds,
strict parsing, Origin checks, cryptographic verification, in-process
authorization, and cancellation/stale-attempt guards are not optional and do
not consume the remote-hop budget.

## Standard-room hot paths

The user-visible startup milestones are distinct:

1. the signaling service atomically claims the requested random room code and
   authenticates the host;
2. the UI may display that claimed invite code;
3. TURN configuration completes, or explicitly settles to the STUN-only
   fallback;
4. the transport may create an `RTCPeerConnection` and declare full network
   readiness.

Starting the TURN request in parallel is encouraged, but waiting for TURN
before starting signaling is prohibited. Displaying a claimed invite code does
not weaken authentication: the code is an address, while the host secret is the
credential. A guest that arrives between milestones 2 and 3 may wait behind the
RTC-configuration gate; it must not create an offer using provisional ICE
configuration.

The standard-room security/control budget is:

- zero synchronous service-control abuse decisions before an ordinary
  WebSocket upgrade reaches its room Durable Object;
- no more than one synchronous atomic service-control decision before minting
  TURN credentials; when two identities must be limited, one composite atomic
  operation must evaluate them in the required order;
- no synchronous D1, R2, PRO-room, grant-campaign, admin, or release dependency
  before an invite code is displayed;
- no serial TURN-before-signaling dependency;
- security/control work owned by MUSIXQUARE should target no more than 250 ms
  added p95 latency on a warm Korean connection. This is a control budget, not
  a claim that total internet or provider latency is always below 250 ms.

Maintenance mode is an operational availability control, not an authorization
primitive. Safe reads should use a bounded stale cache or fail open when that
does not expose cost or mutable authority. Cost-bearing operations and
authority-changing writes may fail closed. A maintenance lookup must never be
stacked with a second standard-room abuse-control lookup merely because both
helpers already exist.

## Threat and cost rationale

- TURN deserves a server-side capability and one atomic admission decision
  because credential minting can enable relay bandwidth spend. Per-IP counters
  alone do not cap distributed abuse or relay bytes, so provider spend alerts,
  a global cost ceiling, credential lifetime, and idempotent credential reuse
  remain the more direct controls.
- Standard WebSocket opens are cheap and already converge on the room Durable
  Object, which enforces room, pending-auth, socket, message, and lifetime
  bounds. A separate cross-service exact counter adds a cold Worker/DO hop but
  does not stop a distributed botnet; coarse edge controls may supplement the
  room limits without joining the startup critical path.
- PRO ownership, D1 mutations, R2 allocation, remote-share quotas, and admin
  actions protect durable authority or direct cost. Exact fail-closed decisions
  remain appropriate there even when they are slower.
- Proof of work is friction, not human authentication. Its baseline and
  adaptive envelope must remain bounded and covered by automated compatibility
  tests. The production adaptive flag stays off until its higher difficulty is
  benchmarked on supported iPhones, and proof of work must not be treated as a
  substitute for a capability or cost cap.

### Adaptive proof-of-work envelope

The reviewed ordinary baseline remains difficulty 12. When Turnstile is
disabled, the App Worker may raise an individual IP's newly issued challenge
directly from 12 to the bounded maximum 16 only after a Cloudflare Workers Rate
Limiting binding reports pressure above its fixed location-local allowance. See
the [Cloudflare Workers Rate Limiting binding contract](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
Calls to `limit({ key })` update eventually consistent counters in the serving
Cloudflare location; awaiting the API does not wait on a network request. A
concurrent multi-isolate burst may overshoot the nominal cutover, and no access
or spending decision relies on an exact threshold.

The official browser client mints the bundled scope set `realtime`,
`remote-share`, `turn`, and `youtube-search`. Because that bundle contains both
`turn` and `realtime`, it always uses the room path: the existing best-effort
Cache admission limit remains 300 challenges/minute and the separate room
pressure binding allows 150 events/minute before returning difficulty 16. One
bundled challenge per browser keeps the documented 100-browser same-NAT venue
below the adaptive threshold. The general path is only for bespoke clients that
request neither `turn` nor `realtime`; it retains Cache admission at 30/minute
and uses a distinct Rate Limiting namespace with a 15/minute pressure allowance.

An attempted invalid proof consumes one additional event from the appropriate
pressure binding; an absent proof and a successful mint do not. The Cache API
counter remains admission-only and does not choose PoW difficulty. The Rate
Limiting key is an HMAC pseudonym of the client IP. This shared-IP signal is
acceptable only with the room headroom above and must not be described as a
user quota or exact global counter.

A missing binding, thrown call, or malformed binding result produces difficulty
12 so an optional friction signal cannot create an outage. This availability
fallback does not grant access: signed, IP/scope-bound capabilities and each
paid endpoint's independent atomic rate/cost limits remain authoritative and
keep their existing fail-closed behavior. The adaptive call adds no
Service-Control, D1, R2, or provider hop to startup.

The current client advertises the accepted baseline-to-maximum envelope. If a
five-minute cached security config rejects a newly adaptive challenge, it
invalidates that config, performs one strict refetch, and renegotiates the
challenge once. Tabs running the pre-envelope client still compare difficulty
for exact equality and may require a reload after their location crosses the
threshold; keeping ordinary 100-browser venues below 150 limits that rollout
residual.

The production configuration keeps `MXQR_CAPABILITY_POW_ADAPTIVE_ENABLED=false`,
so ordinary releases use difficulty 12 and do not require a physical-device
artifact. Before enabling adaptive difficulty in production, the operator must
complete and archive the standalone exact-SHA QA record described in
[`runtime-scenario-verification-2026-05-31.md`](runtime-scenario-verification-2026-05-31.md)
with supported-iPhone and desktop timing observations for difficulty 16. That
policy prerequisite is a reviewed operational decision, not a release-workflow
input or automated mutation gate.

Raising the ordinary baseline above 12, reducing either 150/60s or 15/60s
allowance, raising the ceiling above 16, or replacing the location-local signal
with an exact remote decision also requires an explicit policy and automated
guard update.
If adaptive difficulty is later enabled, rollback is disabling
`MXQR_CAPABILITY_POW_ADAPTIVE_ENABLED`; that returns every newly issued
challenge to the baseline without weakening capability verification or
paid-resource caps.

Low traffic is not a reason to expose provider credentials or remove authority
checks. It is a reason to prefer a small number of high-value boundaries over
several correlated counters that add latency without materially changing an
attacker's cost.

## Required evidence for security audit changes

Any change that adds or moves work onto a standard-room startup path must include
all of the following in its pull request or audit record:

1. the protected asset, concrete attacker action, maximum direct monetary or
   authority impact, and why an existing boundary is insufficient;
2. a before/after sequence of synchronous network, service-binding, DO, D1,
   R2, challenge, and provider calls;
3. cold and warm p50/p95 measurements for invite-code display and full RTC
   readiness, including one supported iPhone and one desktop browser on a
   Korean connection; retain timestamps, build SHA, colo, and sample count;
4. timeout and dependency-failure behavior, including whether the flow fails
   open, fails closed, or settles to a documented degraded mode;
5. a lower-latency alternative considered, the rollback trigger, and the
   narrowest expiry or review condition for any exception;
6. explicit product-owner approval if the change introduces a cross-tier
   synchronous dependency, exceeds a budget above, or changes when the invite
   code becomes visible.

“Defense in depth”, a generic audit recommendation, or a passing unit test is
not sufficient latency-impact justification. A benchmark that begins after the
new security work has already completed is also not valid evidence.

## Automated guard and exception process

Run `npm run guard:standard-room-hot-path`. CI and the Vitest suite run the same
contract. The guard fails when:

- standard TURN can reach more than one atomic service-control consume;
- standard signaling adds an exact service-control rate decision;
- the default proof-of-work cost is raised above difficulty 12 without updating
  the reviewed latency policy and evidence;
- host signaling or the invite-code return is moved behind an awaited TURN
  request; or
- the RTC configuration fence that makes parallel code claim safe is removed.

Do not weaken a pattern merely to make the guard pass. If a new threat truly
requires a budget exception, update this policy and the executable guard in the
same reviewed change, attach the evidence above, and obtain explicit
product-owner approval. PRO/R2/admin/release controls are intentionally outside
the standard-room allowance; moving their implementation into a shared helper
does not make the dependency same-tier.
