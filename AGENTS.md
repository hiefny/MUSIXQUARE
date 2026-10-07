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

## Living beta release record

- Read `docs/beta-release-readiness.md` before each beta QA round and before
  preparing a main merge or production release.
- At the end of each QA/change, update that document in the same change when
  release scope, dependencies, schema/secrets/bindings, compatibility, version
  requirements, verification evidence, unresolved issues, or recovery steps
  change. If none changed, do not add a repetitive log entry.
- Keep its current-state checklist and dated change log aligned. Record the
  tested code SHA, environment, pass/fail/skip limits, and remaining actions;
  preserve old QA reports as dated evidence. Never treat beta tests as the
  successful exact-main-SHA release candidate.
- This record tracks evidence; owner authorization and the release procedure
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
