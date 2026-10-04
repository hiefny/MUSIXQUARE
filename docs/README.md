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
| Promote the current beta to production    | [Living beta release record](beta-release-readiness.md)         | [Production hotfix and rollback](hotfix-procedure.md), [release versioning](release-versioning.md)                                          |
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

For the next `mxqr_beta` promotion, start with the
[living beta release record](beta-release-readiness.md). It tracks the current
release scope, remaining checks and dated QA updates without replacing the
canonical release procedure.

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

- [Follow-up beta sequence QA — 2026-10-04](design/beta-sequence-qa-2026-10-04-round-2.md) —
  63 new module cases, 18 new mobile-view browser plans and 1,014 selected
  maintained cases pass. A repeated transient native post-seek difference
  recovers automatically; an unsupported room-projection diagnostic stays
  separate with actual teardown controls. Product source is unchanged, and
  this focused round does not replace the complete verification below.
- [Large beta QA — 2026-10-04](design/beta-large-qa-2026-10-04.md) —
  Full unit/coverage and browser verification, 41 new media/PRO composite cases,
  production artifacts and six Worker dry-run bundles. Two test-oracle defects
  repaired with original failures and controls preserved; product code unchanged.
  Existing security/cache promotion gates and physical-device checks remain.
- [Full local beta verification — 2026-10-03](design/beta-full-local-verification-2026-10-03.md) —
  Complete local unit/coverage, Chromium, official WebKit, production-artifact
  and Worker bundle checks on the unchanged beta code. Functional suites pass;
  existing dependency security and cache-history promotion gates remain.
- [Beta sequence QA, round 7 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-7.md) —
  No new confirmed defect in file/queue mutations, PRO prepare/commit, YouTube
  controls and UI lifetime checks. 1,348 module/Worker and 10 Chromium cases
  pass. A conditional watchdog failure remains separate because its native
  trigger is unproven; this is focused evidence, not a complete release sign-off.
- [Beta sequence QA, round 6 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-6.md) —
  SQ14–SQ15 discovery and repair: preserve the first PRO repeat/shuffle gesture,
  retry failed required reads, and retire conflicted intent without losing a
  newer gesture. Independent native-parser/Worker-body replays, 31 new regression
  tests, full unit and focused Chromium verification retain their stated limits.
- [Beta sequence QA, round 5 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-5.md) —
  SQ10–SQ13 discovery and repair: preserve file pause checkpoints, retire PRO
  field intent correctly, retain known-rejected chat drafts, and restore
  semantic YouTube playback after sharing. Original failures and independent
  revalidation preserved, with module and Chromium regressions; native-media
  and public-release limits remain explicit.
- [Beta sequence QA, round 4 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-4.md) —
  SQ07–SQ09 discovery and repair: failed-file selection retires outgoing output,
  PRO slowmode preserves drafts, and reconnect fences stale HTTP PREPARE.
  Original failures preserved; 45 new module regressions, reconciled 10,503
  unique unit passes and 75 focused Chromium passes. Cache/version and other
  release gates remain separate from beta verification.
- [Beta sequence QA, round 3 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-3.md) —
  SQ05–SQ06 discovery and repair: failed-demo settings rollback and PRO
  one-shot observation loss before heartbeat catch-up. Preserves failing evidence,
  independent reproductions and excluded reachability candidates; records fixes,
  authority/permission controls, full unit and focused browser verification.
- [Beta sequence QA, round 2 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-2.md) —
  SQ02–SQ04 discovery and repair: late resume progress rollback, obsolete file
  recovery during system-audio takeover, and pending YouTube start overriding
  a newer seek. Preserves failing evidence and records the beta fixes,
  independent reviews, cancellation controls and regression results.
- [Beta sequence QA — 2026-10-03](design/beta-sequence-qa-2026-10-03.md) —
  fresh asynchronous sequence probes; SQ01 direct-file prefix loss confirmed
  in beta and archived main, with recovery and neighboring controls. A dated
  repair addendum records the beta fix and integrated regression evidence.
- [main → beta merge-readiness audit — 2026-10-01](design/main-beta-merge-audit-2026-10-01.md) —
  full cumulative diff review and current-SHA local verification, with dependency
  audit blockers and remaining device/exact-main release gates recorded separately.
- [Beta defect harvest — 2026-09-27](design/beta-defect-harvest-2026-09-27.md) —
  discovery-only evidence, four defects confirmed at that checkout. The
  [living release record](beta-release-readiness.md) tracks their disposition.
- [Beta defect repair — 2026-09-27](design/beta-defect-repair-2026-09-27.md) —
  follow-up repairs and regression evidence for those four defects on beta.
- [Beta defect harvest, round 2 — 2026-09-27](design/beta-defect-harvest-2026-09-27-round-2.md) —
  discovery-only evidence for three additional defects after those repairs;
  the release record tracks their resolution and verification limits.
- [Beta defect repair, round 2 — 2026-09-27](design/beta-defect-repair-2026-09-27-round-2.md) —
  PRO playback restoration, ordered preload completion, and translation author deletion fences.
- [Beta defect harvest, round 3 — 2026-09-27](design/beta-defect-harvest-2026-09-27-round-3.md) —
  one confirmed PRO late-join playback race during live system-audio sharing;
  discovery only, with focused controls and explicit reproduction limits.
- [Beta defect harvest, round 4 and repair — 2026-09-27](design/beta-defect-harvest-2026-09-27-round-4.md) —
  no additional confirmed defects in the bounded review; repairs and verifies
  the previously discovered PRO live-share snapshot restoration race.
- [Luna combination audit and ASTRA verification — 2026-09-27](design/beta-luna-combination-audit-2026-09-27.md) —
  1,250 new local probe cases with explicit composition, outcome-variant, and
  helper counts; no new confirmed defects or product changes. Native device,
  live transport, and full E2E coverage are not implied.
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
