# Repository workflow

- Keep `main` as the only long-lived local and remote branch, per the owner's
  preference. Use a temporary `codex/` branch when a pull request is required.
- The owner-approved `mxqr_beta` branch is an exception for dependency and
  toolchain upgrades. Keep it based on current `main`, validate it with the same
  CI gates, and retain it until the owner ends the experiment. It does not
  authorize a production release or bypass the reviewed `main` release path.
- After a task is merged, delete its temporary local and remote branches and
  return the checkout to `main`. Do not delete another task's active branch or
  discard uncommitted work.
- Merged pull request branches are automatically deleted on GitHub. Keep routine
  Dependabot version updates in the single `dependencies` multi-ecosystem group
  for npm and GitHub Actions. Its open bot branch is an intentional exception
  to completed-task cleanup; retain security updates, alerts, and checks.
- Follow `docs/hotfix-procedure.md` and `docs/release-versioning.md` for production
  changes, including the exact-commit CI candidate and release workflow.
