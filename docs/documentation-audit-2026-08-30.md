# Documentation Audit — 2026-08-30

| Field             | Value                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------- |
| Status            | Dated audit record                                                                      |
| Applies to        | Tracked Markdown, documentation-linked workflows/tests, and current operations runbooks |
| Baseline          | `e125c139a50d8caaa354df12a197697b61133446` on `main`                                    |
| Audit date        | 2026-08-30                                                                              |
| Related documents | [Documentation hub](README.md), [governance policy](documentation-governance.md)        |

## Scope and method

The audit treated runtime source, checked-in Cloudflare configuration, schemas,
manifests, tests, and guards as executable evidence. It then reviewed all 67
Markdown files tracked at baseline `e125c139` for lifecycle, discoverability,
duplicated current-state claims, local relative links, operating commands,
release boundaries, and secret hygiene. Historical statements were compared
with their dated baseline rather than rewritten to match current counts.

The source-only operations contract was also reconciled across six Workers,
three D1 databases, 15 D1 migration entries, 19 current admin application
tables, 39 expected per-Worker secret-name entries (30 unique names), 63
bindings, six custom domains, two automated minimum GitHub history-protection
rules, and four manual policy checks. These repository contracts define
expected state; they do not by themselves prove the live provider dashboard
matches it.

## Findings and corrections

| Finding                                                                                            | Correction                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full Chromium and targeted WebKit E2E ran only monthly                                             | Changed the scheduled workflow and all maintained consumers to every Tuesday at 03:17 KST while retaining manual dispatch and keeping it outside release gate |
| The documentation map mixed current contracts with evidence and omitted five maintained references | Rebuilt the hub around lifecycle and operator journeys; added admin access, config drift, Standard-room PIN, realtime ownership, and signaling liveness       |
| No repository-wide documentation lifecycle policy existed                                          | Added metadata, classification, source-precedence, update-trigger, review, and publication rules                                                              |
| Environment variables and fallback behavior were spread across source and guides                   | Added one non-secret configuration reference and kept Worker runtime secret-name expectations single-sourced in the operations contract                       |
| Local guides described the Vite fail-closed middleware as a blanket production air gap             | Limited the claim to relative Vite routes and documented explicit PRO, TURN, and Realtime production fallbacks                                                |
| Current config-drift runbook said 18 admin tables while executable SQL defines 19                  | Corrected the maintained runbook and added an executable tooling contract test against both current schema inventories                                        |
| Config-drift conclusion listed only three of four manual policy checks                             | Added GitHub review/required-check policy and separated it from the two automatically verified minimum history rules                                          |
| Recovery workflow ceilings could be misread as service objectives                                  | Clarified that four-hour/90-minute timeouts are execution caps, not RTO/RPO, and that the checkpoint is not a D1/DO/R2 object-data backup                     |
| Provider limit review date was stale                                                               | Rechecked current official Cloudflare documentation and updated only the maintained review date; the documented values did not change                         |

## Intentional non-changes

- Accepted product and architecture decisions in `known-accepted.md` and the
  maintained ADRs were not reopened.
- Dated audits retain the counts, events, line references, and conclusions true
  at their baseline. In particular, the 2026-08-17 documentation audit's
  18-table observation remains historical because the nineteenth table was
  added later.
- `design/runtime-v2-prototype.md` remains partial-adoption design evidence, not
  a declaration that the prototype architecture is fully current.
- `performance/pro-room-heartbeat-benchmark.md` remains benchmark evidence, not
  an operational SLO.
- No formal uptime/latency SLO, RTO/RPO, paging target, or restore-drill result
  was invented where the repository defines none.
- No Worker runtime or hosted App artifact input was changed. This branch is
  limited to repository documentation, example configuration, GitHub workflows,
  and a tooling contract test, so it does not require product SemVer, a PWA
  cache epoch, or a Cloudflare release.

## Pre-publication verification

The final working tree passed these checks before commit:

- Markdown relative-link and image audit: all 70 final-tree Markdown files pass,
  including case-sensitive path verification.
- Focused documentation/tooling contract: 32 tests pass across the tooling and
  operations-drift contract files.
- Source-only operations drift contract: passes with six Worker policies, 39
  expected per-Worker secret-name entries, 63 bindings, six custom domains, two
  minimum GitHub rules, and four manual checks.
- Repository typecheck, lint, format, high-severity dependency audit, and Worker
  contract ladder: pass; the dependency audit reports zero vulnerabilities.
- Full Vitest suite: 376 files and 6,796 tests pass.
- Checked production build: passes at product version `8.4.42` and service-worker
  cache epoch `v519`, including initial-transfer and production-security guards.

## Post-publication verification

The exact merge-SHA `main` CI result and active weekly `Full E2E` workflow are
external publication evidence. Verify and link them in the pull request/release
report after merge; do not create a follow-up documentation commit merely to
replace a circular “pending” field in this dated record.

This record describes the repository state reviewed on the date above. Future
operators must use maintained documents and executable sources for current
behavior, not assume every dated result remains live.
