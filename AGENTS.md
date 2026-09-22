# Repository workflow

## Competition freeze (owner instruction, 2026-09-23)

- Until the owner explicitly says the competition has ended, work on
  `mxqr_beta`. Keep this branch and leave the checkout on it between tasks.
- Do not modify or advance `main`, merge changes into it, or deploy production
  during this freeze. Local edits, commits, builds, and tests on `mxqr_beta`
  are allowed.
- The existing push hold remains in force: do not push or create remote pull
  requests until the owner explicitly authorizes remote publication. Keep the
  Operations Drift Audit workflow disabled until the owner ends the freeze.
- This temporary exception takes precedence over the branch cleanup rules
  below. Once the owner ends the freeze, follow their publication instructions
  and the normal release workflow; audit-tooling-only changes need no App release.

## Normal workflow

- Outside the competition freeze, keep `main` as the only long-lived local and remote branch, per the owner's
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
