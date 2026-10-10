# Repository workflow

## Competition freeze ended (owner instruction, 2026-10-07)

- The owner explicitly ended the competition and authorized promotion of the
  accumulated `mxqr_beta` changes to `main`, production deployment, and
  reactivation of Operations Drift Audit on 2026-10-07.
- The 2026-09-23 freeze and its 2026-09-25 beta-push exception are historical.
  Follow the normal workflow below, including PR review, the successful
  exact-main-SHA CI candidate, and the production release procedure.
- Reactivate only Operations Drift Audit; this authorization does not restore
  unrelated disabled workflows. Audit-tooling-only changes need no App release.

## Release record

- Read `docs/release-record.md` before each QA round and before preparing a
  main merge or production release.
- `docs/release-record.md` holds only the current state. After each production
  deployment or rollback (a Production Release run, a local emergency deploy,
  or a CLI rollback), overwrite all of its §1 and its `Last source review` line,
  and append exactly one row to the bottom of `docs/release-history.md`. Do not
  keep superseded values in the record.
- At the end of each QA round or product/runtime change, write the tested code
  SHA, environment, and pass/fail/skip limits in a dated report under
  `docs/design/` and list it in the `docs/README.md` evidence section;
  documentation- or audit-tooling-only changes need no report. For any change,
  update the record in the same change only when release scope, dependencies,
  schema/secrets/bindings, compatibility, version requirements, open items,
  recovery steps, or owner decisions change, and link the report from any open
  item it adds or changes. If none changed, leave the record alone.
- Remove an open item only with evidence, cited in the pull request. Never
  treat local or branch tests as the successful exact-main-SHA release
  candidate.
- `docs/beta-release-readiness-archive-2026-10-10.md` is the frozen beta-era
  record. Do not edit it except to keep links working.
- The record tracks evidence; owner authorization and the release procedure
  remain authoritative. The 2026-10-07 promotion authorization is recorded above.

## Normal workflow

- Keep `main` as the only long-lived local and remote branch, per the owner's
  preference. Use a temporary `agent/` branch when a pull request is required.
- After a task is merged, delete its temporary local and remote branches and
  return the checkout to `main`. Do not delete another task's active branch or
  discard uncommitted work.
- Merged pull request branches are automatically deleted on GitHub. Keep routine
  Dependabot version updates in the single `dependencies` multi-ecosystem group
  for npm and GitHub Actions. Its open bot branch is an intentional exception
  to completed-task cleanup; retain security updates, alerts, and checks.
- Follow `docs/hotfix-procedure.md` and `docs/release-versioning.md` for production
  changes, including the exact-commit CI candidate and release workflow.
