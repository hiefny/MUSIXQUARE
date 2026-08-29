# Documentation Hub

| Field              | Value                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| Status             | Maintained index                                                      |
| Applies to         | Repository documentation and its lifecycle classification             |
| Last source review | 2026-08-30                                                            |
| Governance         | [Documentation governance](documentation-governance.md)               |
| Latest audit       | [Documentation audit — 2026-08-30](documentation-audit-2026-08-30.md) |

Use this hub to choose the current contract before following a dated audit or
prototype. “Maintained” means the document is intended to describe the present
repository boundary; it does not mean that a checked-in expectation proves the
live provider dashboard matches it.

## Start here

| Need                                      | Primary reference                                               | Then read                                                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Run or contribute locally                 | [Contributor guide](../CONTRIBUTING.md)                         | [Configuration reference](configuration-reference.md), [Local Worker integration](local-worker-integration.md)                              |
| Understand the product architecture       | [Root overview](../README.md)                                   | [Account/room authority](design/account-identity-and-room-authority.md), [PRO architecture](design/pro-room-architecture-and-operations.md) |
| Prepare or recover a production change    | [Production hotfix and rollback](hotfix-procedure.md)           | [Release versioning](release-versioning.md), [Runtime verification](runtime-scenario-verification-2026-05-31.md)                            |
| Operate Cloudflare services               | [Configuration drift checks](../cloudflare/config-drift-ops.md) | Owning Worker runbook below                                                                                                                 |
| Review intentional tradeoffs              | [Known and accepted risks](known-accepted.md)                   | Owning ADR and [security/performance policy](security-performance-tier-policy.md)                                                           |
| Decide whether an old document is current | [Documentation governance](documentation-governance.md)         | [Latest documentation audit](documentation-audit-2026-08-30.md)                                                                             |

## Maintained architecture and accepted decisions

These documents define current ownership or an accepted decision. Amend or
supersede them explicitly when the product boundary changes.

- [Account identity and room authority](design/account-identity-and-room-authority.md)
- [PRO room architecture and operations](design/pro-room-architecture-and-operations.md)
- [Coordinator-free PRO server authority](design/pro-room-server-authority.md)
- [Realtime runtime ownership](design/realtime-runtime-ownership.md)
- [Signaling liveness](design/signaling-liveness.md)
- [Static asset delivery and PRO heartbeat persistence](design/static-assets-and-pro-heartbeat-optimization.md)
- [Initial bundle and lazy-loading policy](design/initial-bundle-loading-policy.md)
- [Browser media storage policy](design/browser-media-storage-policy.md)
- [Playback concurrency invariants](design/playback-concurrency-invariants.md)
- [Queue item identity and reorder](design/queue-item-identity-and-reorder.md)
- [Source complexity safety limits](design/source-complexity-ratchet.md)
- [Mobile application zoom policy](mobile-app-zoom-policy.md)
- [Security and hot-path performance policy](security-performance-tier-policy.md)
- [Known and accepted risks](known-accepted.md)

## Maintained operations and release runbooks

| Boundary                        | Current runbooks                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release, recovery, and identity | [Production hotfix and rollback](hotfix-procedure.md), [release versioning](release-versioning.md), [runtime verification](runtime-scenario-verification-2026-05-31.md)      |
| Configuration and local routing | [Configuration reference](configuration-reference.md), [Local Worker integration](local-worker-integration.md), [Cloudflare drift checks](../cloudflare/config-drift-ops.md) |
| App, accounts, and admin        | [Account authentication](account-auth-operations.md), [admin access](admin-access.md), [admin dashboard operations](../cloudflare/admin-dashboard-ops.md)                    |
| Standard rooms                  | [Signaling liveness](design/signaling-liveness.md), [Standard-room PIN operations](../cloudflare/standard-room-pin-ops.md)                                                   |
| PRO rooms                       | [PRO architecture and operations](design/pro-room-architecture-and-operations.md), [server authority](design/pro-room-server-authority.md)                                   |
| Remote Share                    | [Remote Share operations](../cloudflare/remote-share-ops.md)                                                                                                                 |
| Developer API                   | [OpenAPI contract](../public/developers/openapi.yaml), [Cloudflare drift checks](../cloudflare/config-drift-ops.md)                                                          |

The six production Worker Wrangler configs and checked-in manifests remain the
decisive non-secret binding/schema inventories. Worker runtime secret-name
expectations are single-sourced in
[`cloudflare/ops-drift.contract.json`](../cloudflare/ops-drift.contract.json),
while workflow and operator credentials remain owned by their workflows and
runbooks. Neither belongs in a general setup document.

## Maintained engineering guides and contracts

- [Playback state consumption](state-patterns.md)
- [AppState decomposition and surviving contract](appstate-decomposition.md)
- [System sync compensation](system-sync-compensation.md)
- [Repository-wide TypeScript migration](typescript-migration/README.md)
- [Translation guide](i18n-translation-guide.md)
- [Reusable migration audit prompt](migration-audit-prompt.md)
- [Developer API OpenAPI contract](../public/developers/openapi.yaml)
- [Font assets and verification](../fonts/README.md)
- [Public design-system guide](../public/designsystem/README.md)
- [Third-party runtime notices](../THIRD-PARTY-NOTICES.md)

## Maintained evidence and completed records

These files contain dated measurements or completed work, while a clearly
labeled portion still supports a current guard or operating interpretation:

- [Full project audit — 2026-07-19](full-project-audit-2026-07-19.md) — dated
  defect record with a maintained residual-boundary and verification addendum.
- [Runtime scenario verification — 2026-05-31](runtime-scenario-verification-2026-05-31.md) —
  dated origin with a maintained verification checklist.
- [TypeScript migration roadmap](typescript-migration/ROADMAP.md) and
  [status](typescript-migration/STATUS.md) — completed execution evidence; the
  migration README and guards define the surviving contract.
- [Runtime v2 prototype](design/runtime-v2-prototype.md) — partial-adoption
  design evidence, not a claim that the whole prototype is current.
- [PRO heartbeat benchmark](performance/pro-room-heartbeat-benchmark.md) —
  reproducible evidence, not an uptime or latency SLO.

## Historical archive

The following files preserve a dated baseline. Their “current” wording, counts,
line numbers, proposed phases, and test totals describe that baseline unless a
clearly labeled maintained addendum says otherwise:

- [Documentation truth audit — 2026-08-17](documentation-truth-audit-2026-08-17.md)
- [Project analysis — 2026-05-24](project-analysis/2026-05-24/00-index.md)
- [CSS cleanup — 2026-05-30](css-cleanup-2026-05-30.md)
- [Large source-file split design — 2026-05-30](large-file-split-design-2026-05-30.md)
- [Performance and memory audit — 2026-05-30](perf-memory-audit-2026-05-30.md)
- [Type-safety audit — 2026-05-30](type-safety-audit-2026-05-30.md)
- [Device test — 2026-06-10](device-test-2026-06-10.md)
- [Domain audit — 2026-06-10](domain-audit-2026-06-10.md)
- [Scenario audit — 2026-06-10](scenario-audit-2026-06-10.md)
- [Earlier full-project audit](full-project-audit.md)
- [Manual QA checklist](design/manual-qa-checklist.md)
- [Playback state-machine design](design/playback-state-machine.md)
- [E2E coverage notes — 2026-05-30](../e2e/COVERAGE-NOTES-2026-05-30.md)

Use Git history when an exact old implementation is needed. Do not revive a
discarded plan merely because its record remains in the repository.

## Repository policy, legal, and public copy

- [Security policy](../SECURITY.md)
- [Trademark policy](../TRADEMARKS.md), [brand/fork guide](../BRAND_POLICY.md),
  and [AGPL additional terms](../ADDITIONAL_TERMS.md)
- [Third-party notices](../THIRD-PARTY-NOTICES.md)
- Hosted design-system material under
  [`public/designsystem/`](../public/designsystem/README.md)

Files under `public/**` and hosted `.workshop/**` trees are App artifact inputs,
even when their content is documentation. Follow the App version/cache/release
path rather than the repository-only publication path.

## Source of truth and publication

For behavior claims, precedence is: production source/configuration, executable
tests/guards/manifests, maintained documents above, evidence, then historical
records. Live provider state requires a live read; never infer it from a green
source-only check.

Repository-only documentation, example configuration, GitHub workflow, and
test/guard changes that feed neither an App nor Worker bundle publish with a
reviewed GitHub `main` merge. They do not require product SemVer, a PWA
cache-epoch bump, or a Cloudflare Production Release. Hosted public copy and
runtime inputs follow the separate exact-SHA path in the canonical
[hotfix procedure](hotfix-procedure.md).

Secret-bearing local operations notes live under ignored `docs/private/` and
must never be added to Git.
