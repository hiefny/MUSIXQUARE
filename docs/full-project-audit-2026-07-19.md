# MUSIXQUARE Full Project Audit — 2026-07-19

Baseline: `e61408da` on `main` (`CACHE_VERSION` v181).

> **Maintained operational addendum:** The residual boundaries and verification
> contract below were revalidated against the repository on 2026-08-17. The
> baseline SHA, cache epoch, and original defect narrative remain the dated
> audit snapshot.

This audit reviewed current intent before changing behavior. A suspicious path
was changed only after its callers, state owner, protocol boundary, cleanup
path, tests, operational contract, and relevant history agreed that the behavior
was a defect. Historical proposals were not treated as current requirements.
Security or abuse changes must also follow the maintained
[security and hot-path performance policy](security-performance-tier-policy.md):
identify the protected asset and tier, inventory every new synchronous hop, and
provide the required before/after latency evidence before changing a
standard-room startup path.

## Scope and method

| Area                          | Evidence reviewed                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Playback and playlist         | ownership/lifecycle writers, async load and preload handoff, queue identity, rapid replacement tests           |
| File transfer and storage     | RAM-only policy, chunk pumps, main/preload sessions, recovery, remote-share descriptors and quotas             |
| YouTube and synchronization   | current rendezvous/zero-start contracts, repeated queue occurrences, clock and platform compensation           |
| Network and system audio      | standard and PRO signaling, reconnect identity, WebSocket admission, P2P/SFU handoff, MediaConnection cleanup  |
| Cloudflare services           | app, signaling, remote-share, PRO room, Developer API/facade, D1/R2/KV boundaries and Wrangler configuration   |
| PWA and public web            | service-worker lifecycle/cache retirement, metadata, sitemap, static pages, desktop/mobile layouts             |
| Security and abuse boundaries | authorization, origin/identity checks, request/frame limits, rate limits, relay canonicalization, secret scope |
| UI, accessibility, i18n       | dialogs, focus restoration, skip link, option semantics, translated/static pages, browser console and overflow |
| Release and recovery          | immutable artifact path, deployment ownership, smoke timeouts, rollback conflicts, cross-service compatibility |
| Repository health             | dependency graph, engine contract, audits, formatting, lint/typecheck, Worker syntax, generated/static guards  |

The audit also replayed the intended behavior against Git history where a guard
looked unusually strict or a compatibility branch looked redundant. This kept
intentional RAM-only media storage, AudioBuffer playback, best-effort edge
rate limiting on low-risk endpoints, atomic resource-bearing gates, and
device-specific sync compensation intact.

## Confirmed defects corrected

1. **Async playback ownership:** a superseded play call could clear the newer
   call's loader/watchdog or unlock the wrong queue item. Invocation generations
   and exact transfer/preload owners now fence every post-await continuation.
2. **Service-worker fetch lifetime:** cache writes were started after an awaited
   response path and could outlive the fetch event. Responses are cloned first
   and cache writes are synchronously registered with `waitUntil`.
3. **Service-worker release boundary:** runtime app changes could be committed
   without a cache-version bump. A first-parent, full-history guard now fails
   closed until a monotonic bump covers the changed runtime tree.
4. **Standard signaling credentials:** the host bearer secret was present in a
   WebSocket URL. Current clients authenticate in the first frame. On
   2026-07-22 the owner approved a prelaunch exception and removed the temporary
   legacy URL bridge without waiting for the planned 30-day rollout and seven
   consecutive zero-event days: production D1 had recorded two legacy events
   dated 2026-07-18 through 2026-07-19, the unpromoted beta cohort was small and
   contactable, and every known user could be recovered by refreshing the app.
   Historical D1 buckets remain harmless audit data and are ignored by the
   current metric inventory; no data deletion or migration is required.
5. **Signaling admission races:** host reconnect, stale host close, room expiry,
   guest admission, and last-guest cleanup could overwrite one another across
   awaited Durable Object storage. Standard-room ownership mutations now share
   one queue and revalidate exact socket identity after every wait.
6. **Pre-auth amplification and ghost guests:** pending hosts had no bounded
   first-frame state, pending guests could enqueue repeated auth callbacks, and
   a guest closing during auth could later become a permanent admitted socket.
   Host/guest auth is now a size-bounded, rate-accounted one-frame operation;
   close and admission are serialized and tested under gated storage races.
7. **System-audio replacement:** stale MediaConnection close/error callbacks
   could remove a successor. Exact connection identity now protects host and
   guest slots. A same-channel replacement that never emits a usable stream has
   an identity-fenced 30-second watchdog instead of remaining permanently
   `receiving=true` with silence.
8. **Remote-share namespace and quota integrity:** arbitrary room IDs could
   split quota prefixes or overlap the reserved PRO namespace. Standard remote
   share now accepts only exact room codes `100000`–`999999` at every object and
   session boundary.
9. **Chunk-rate exemption:** FILE/PRELOAD-shaped traffic could bypass the generic
   message bucket without proving current host identity and an active declared
   transfer. The exemption now requires the exact live connection, session,
   bounds, size, and canonical shape.
10. **Chat relay authority:** a participant could influence sender labels and
    relay unknown fields to every peer. Labels now come from authoritative room
    state and host relays emit a canonical bounded payload.
11. **Release safety:** rollback credentials were overexposed, final deployment
    ownership was not rechecked, half-open smokes could stall recovery, and
    app/signaling rollback order could create an incompatible live pair.
    Credentials are step-scoped, D1 and Worker recovery are isolated, smokes
    have hard ceilings, final versions/messages are revalidated, and rollback
    has dependency-aware conflict handling.
12. **Forward deployment compatibility:** an app-only release could publish the
    first-frame client against an old signaling Worker. Both the approved
    workflow and emergency `emergency:deploy:app` command now prove the live
    signaling contract before touching the app.
13. **Accessibility semantics:** the manual-sync overlay lacked a complete
    modal/focus lifecycle, language/theme controls advertised listbox semantics
    without option elements, and the skip target was not programmatically
    focusable. Semantics now match the actual controls and focus is restored.
14. **Public metadata and operational drift:** invite routes could be indexed,
    sitemap modification dates were stale, one admin metric label overstated
    its meaning, and the Node engine range did not match the installed toolchain
    contract. These are now aligned with runtime behavior.

## Deliberately unchanged

- Production media payloads remain RAM-only in the browser under the current
  storage ADR; no OPFS-backed media-storage pivot was introduced. The ADR does
  not prohibit every possible use of the OPFS API outside that payload scope.
- The AudioBuffer engine remains the production decode/playback engine. It does
  not apply a predicted device-memory cap before production decode; transfer and
  native decode are attempted on a bounded-wire, best-effort basis.
- Turnstile was not reintroduced and user-visible admission policy was not made
  stricter.
- Platform sync compensation, DSP tuning, and YouTube rendezvous behavior were
  left unchanged where tests/history showed intentional calibration rather than
  a code defect.
- The full Chromium Playwright suite and targeted iPhone WebKit smoke run
  nightly and remain manually dispatchable, but stay outside the production
  release gate by product decision. The production release uses browser-free
  generation/initial-asset-graph and HTTP boundary smokes. Optional physical
  QA remains available when real iOS/Android/WebRTC/YouTube timing is needed.

## Residual, accepted boundaries

- Low-risk Cache API rate limits remain edge-local best effort. Paid-resource,
  remote-share allocation, and signaling admission limits use the shared
  service-control Durable Object for serialized atomic decisions and fail
  closed when that production binding is unavailable.
- The repository-wide TypeScript migration is complete: all six Wrangler entry
  files are TypeScript, authored JavaScript is zero, and 19 strict projects cover
  the tracked TypeScript-family source. Type-escape, declaration-ownership,
  project-coverage, Worker-bundle, and executable boundary guards prevent a
  silent return to untyped runtime ownership.
- Browser media policy, WebRTC timing, background audio, and YouTube iframe
  behavior cannot be completely proven by jsdom.
- Initial-transfer budgets, the main-chunk architectural ceiling, and the
  fail-closed secondary-chunk guard enforce the currently accepted bundle
  topology and headroom.

## Verification contract

The automated release candidate is complete only when the following all pass on
the final commit:

- full Vitest suite, typecheck, ESLint, Prettier, Worker syntax;
- the standard-room hot-path guard, including the single composite TURN
  admission, default proof-of-work cost, and invite-return-before-TURN ordering
  contracts;
- playback/storage/developer API/service-worker static guards;
- production build and browser-free generation/initial-asset-graph plus HTTP
  boundary release smokes;
- dependency and runtime vulnerability audits;
- GitHub CI for the pushed commit;
- version-aware live smoke for every deployed Cloudflare service, followed by
  a no-drift check of deployment IDs, version IDs, and release messages.

Ordinary production release confidence comes from the exact-SHA automated gate
above. Physical verification of a standard or PRO room remains an optional
hardware/runtime confidence layer for changes and incidents that warrant it;
it does not weaken or replace any automated gate.
