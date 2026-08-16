# Documentation Map

Repository documentation has two different purposes: some files define the
current operating contract, while others preserve the evidence and reasoning
from a dated audit or completed migration. A dated audit is not a live backlog
or a substitute for the current source and tests.

## Current References

- [Release versioning](release-versioning.md) defines the independent product
  SemVer, PWA cache epoch, API/schema versions, document dates, and immutable
  deployment identifiers.

- [Optional account identity and room authority](design/account-identity-and-room-authority.md)
  and [account authentication provisioning](account-auth-operations.md) define
  the account model, OAuth/D1 security boundary, and production setup.

- [Security and hot-path performance policy](security-performance-tier-policy.md)
  defines the standard/PRO/admin security tiers, the standard-room synchronous
  dependency budget, and the evidence required before an audit may add latency.

- [Local Worker integration and environment boundaries](local-worker-integration.md)
  maps browser, Vite, Worker, and CI namespaces; gives the fail-closed local
  recipes; and points every Worker to its canonical binding/secret inventory.

- [Source complexity safety limits](design/source-complexity-ratchet.md) defines
  generous accident thresholds for the largest runtime and release ownership
  boundaries. File size alone must not force a new module boundary.

- [Mobile application zoom policy](mobile-app-zoom-policy.md) defines the
  main SPA's fixed-scale viewport contract, its accessibility boundary, and the
  evidence required before a future audit may change that product decision.

- [Developer API OpenAPI contract](../public/developers/openapi.yaml) defines
  the public server-to-server `/v1` route and payload surface.

- [Full project audit — 2026-07-19](full-project-audit-2026-07-19.md) — current
  cross-domain audit method, confirmed corrections, and residual boundaries.
- [PRO room architecture and operations](design/pro-room-architecture-and-operations.md) —
  persistent-room ADR, Cloudflare runbook, offline activation, rollback, and
  optional physical-device QA matrix.
- [Static asset delivery and PRO heartbeat persistence](design/static-assets-and-pro-heartbeat-optimization.md) —
  accepted scope, rollback boundary, and the explicit decision to defer a
  stable-core/presence schema split until production scale justifies it.
- [Initial bundle and lazy-loading policy](design/initial-bundle-loading-policy.md) —
  the accepted boundary for keeping the current eager/lazy graph stable, plus
  the measured failure and SLO-change criteria required before another broad
  bundle split.
- [Browser media storage policy](design/browser-media-storage-policy.md) —
  accepted RAM-only media-storage ADR and the gate for reconsidering OPFS.
- [Playback state consumption contract](state-patterns.md) — current rules for
  reading and reacting to playback mode/activity.
- [Playback concurrency invariants](design/playback-concurrency-invariants.md) —
  concurrency mechanisms and executable test/guard anchors. Exact site counts
  in the prose are a review snapshot; the linked tests and guards are decisive.
- [Queue item identity and reorder](design/queue-item-identity-and-reorder.md) —
  stable queue-occurrence IDs, snapshot revisions, and the desktop/touch/keyboard
  reorder interaction contract.
- [AppState decomposition](appstate-decomposition.md) — completed migration
  record plus the surviving mode/activity contract.
- [Production hotfix and rollback](hotfix-procedure.md) — current release and
  service-worker update procedure.
- [Known and accepted risks](known-accepted.md) — intentional tradeoffs that
  still require code-path verification before being reused.
- [Runtime scenario verification](runtime-scenario-verification-2026-05-31.md) —
  maintained first-48-hours order and optional physical-device confidence matrix;
  exact-SHA automated CI is the ordinary release gate despite the document's
  original date.
- [System sync compensation](system-sync-compensation.md) — current constants
  and the distinction between platform compensation and shared WebRTC buffering.
- [Translation guide](i18n-translation-guide.md) and
  [migration audit prompt](migration-audit-prompt.md) — reusable contributor
  references.

## Adjacent Maintained Guides

- [Admin dashboard operations](../cloudflare/admin-dashboard-ops.md) and
  [remote-share operations](../cloudflare/remote-share-ops.md)
- [Font assets and verification](../fonts/README.md)
- [Public design-system guide](../public/designsystem/README.md)
- [Third-party runtime notices](../THIRD-PARTY-NOTICES.md)

## Historical Records

The following are intentionally retained as historical evidence. Their dates,
commit references, test totals, line numbers, proposed phases, and statements
such as “current” describe their audit baseline, not today's repository:

- `project-analysis/2026-05-24/`
- `css-cleanup-2026-05-30.md`
- `large-file-split-design-2026-05-30.md` (large _source files_, not large media)
- `perf-memory-audit-2026-05-30.md`
- `type-safety-audit-2026-05-30.md`
- `device-test-2026-06-10.md`
- `domain-audit-2026-06-10.md`
- `scenario-audit-2026-06-10.md`
- `full-project-audit.md`
- `design/manual-qa-checklist.md`
- `design/playback-state-machine.md`
- `../e2e/COVERAGE-NOTES-2026-05-30.md`

Each retained file carries its own historical notice. Use Git history when an
exact old implementation is needed; do not revive a discarded plan merely
because it remains documented.

## Source Of Truth

For runtime behavior, the precedence order is:

1. production code and Cloudflare configuration;
2. executable tests and repository guards;
3. accepted/current reference documents above;
4. dated historical records.

Secret-bearing local operations notes live under ignored `docs/private/` and
must never be added to Git.
