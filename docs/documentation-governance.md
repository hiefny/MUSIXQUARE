# Documentation Governance

| Field              | Value                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------- |
| Status             | Maintained policy                                                                       |
| Applies to         | Tracked repository documentation, runbooks, public copies, and audit records            |
| Last source review | 2026-08-30                                                                              |
| Executable sources | Git tree, CI workflows, package scripts, Wrangler configs, manifests, tests, and guards |
| Related documents  | [Documentation hub](README.md), [release procedure](hotfix-procedure.md)                |

## Purpose

Documentation is an operating surface, not a parallel implementation. Each
document must make clear whether it defines current behavior, guides an
operator, records a decision, or preserves dated evidence. A dated file may
remain useful without being promoted to a current contract.

## Document classes

| Class                   | Meaning                                                                                         | Maintenance rule                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Maintained contract     | Current architecture, behavior, security, or engineering policy                                 | Update in the same change as the executable contract; link decisive source/tests                                   |
| Runbook                 | Current operator procedure, verification, rollback, or provisioning path                        | Recheck commands and ownership when the workflow, provider surface, binding, or schema changes                     |
| Accepted decision / ADR | Deliberate tradeoff and its reconsideration gate                                                | Amend or supersede explicitly; do not silently reverse it in an unrelated guide                                    |
| Contributor guide       | Repeatable local development or review practice                                                 | Keep commands runnable and environment boundaries precise                                                          |
| Evidence / benchmark    | Measured result, prototype, audit output, or completed migration record                         | Preserve its baseline; point to the maintained contract that interprets it                                         |
| Historical record       | Dated context retained for provenance                                                           | Do not modernize old counts, line numbers, or events; add a clearly labeled maintained addendum only when required |
| Hosted public copy      | Documentation under `public/**` or hosted `.workshop/**` trees that ships with the App artifact | Treat as product input with the version/cache/release path in the canonical hotfix procedure                       |

The [documentation hub](README.md) is the current classification index. If a
document's header conflicts with the hub, resolve the conflict in the same pull
request rather than relying on filename intuition.

## Metadata for new maintained documents

New maintained contracts, runbooks, and guides should begin with this compact
table after the title:

```markdown
| Field              | Value                                                     |
| ------------------ | --------------------------------------------------------- |
| Status             | Maintained contract / Runbook / Accepted decision / Guide |
| Applies to         | Owned components, workflows, or audience                  |
| Last source review | YYYY-MM-DD                                                |
| Executable sources | Source, config, manifest, test, or guard links            |
| Related documents  | Owning and adjacent references                            |
```

Use `Supersedes` or `Amended by` when a decision relationship would otherwise
be ambiguous. Existing documents need not receive metadata mechanically; add
it when a substantive edit makes the lifecycle clearer.

## Location and naming

- Put current engineering and operator references in `docs/` unless an existing
  boundary owns them more clearly.
- Keep Cloudflare operator runbooks next to their configuration in
  `cloudflare/*ops.md`.
- Put architecture and accepted decisions in `docs/design/`.
- Put reproducible measurements in `docs/performance/` and include commit,
  environment, command, and interpretation.
- Use an ISO date in filenames for audit snapshots and other evidence whose
  statements are tied to a baseline.
- Keep secret-bearing local notes only in ignored `docs/private/`. Never link or
  copy their values into a tracked document.
- Avoid broad file moves. Paths are referenced by tests, guards, public links,
  and operator habits; improve discovery through the hub unless a move has a
  concrete ownership benefit and all consumers are updated.

## Source precedence

For a behavior or configuration claim, use this order:

1. production code, checked-in provider configuration, and schema;
2. executable tests, guards, manifests, and generated contracts;
3. maintained contracts and runbooks classified by the hub;
4. evidence, benchmarks, prototypes, and completed migration records;
5. historical audits and plans.

Live provider state is a separate observation. A checked-in contract can define
the expected state without proving the dashboard currently matches it. Mark the
difference explicitly and use a read-only audit where one exists.

## Change triggers

| Change                                                        | Documentation action                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Environment variable, fallback, or local routing boundary     | Update [configuration reference](configuration-reference.md), `.env.example` when safe, and affected guide |
| Worker binding, secret name, route, domain, D1/DO/R2 contract | Update owning Wrangler/manifest contract and operator runbook; keep secret inventory single-sourced        |
| Release, recovery, or CI cadence                              | Update workflows, canonical hotfix procedure, verification checklist, and contract tests                   |
| Architecture authority or accepted product tradeoff           | Amend or supersede the owning ADR and update the hub classification                                        |
| Provider limit or price used for an operating decision        | Recheck the official provider source and record the review date; do not present an allowance as a hard cap |
| Dated audit count or historical observation                   | Preserve the old statement; correct only a maintained addendum or current runbook                          |
| Public `public/**` or hosted `.workshop/**` copy              | Follow the App artifact version/cache/release path                                                         |

## Review checklist

Before publication:

1. Identify the document class and owning executable source.
2. Verify every current-state count, command, schedule, endpoint, and fallback.
3. Search for duplicated claims and update all maintained consumers.
4. Preserve accepted decisions and dated facts unless the change explicitly
   amends them.
5. Check relative links, headings, terminology, and secret hygiene.
6. Run the repository verification ladder appropriate to the changed surface.
7. Record what was source-verified versus what still requires a live provider
   or physical-device check.

## Publication boundary

Repository-only documentation (`README.md`, `CONTRIBUTING.md`, `docs/**`, and
`cloudflare/*ops.md`), example configuration, GitHub workflow, and test/guard
changes that feed neither an App nor Worker bundle are published by a reviewed
merge to GitHub `main`; they do not justify a Cloudflare Production Release.
Files under `public/**`, hosted
`.workshop/{landing,privacy,terms,faq,developers}/**`, and App/Worker runtime
inputs must use the applicable version/cache/exact-SHA release path in
[`hotfix-procedure.md`](hotfix-procedure.md).
