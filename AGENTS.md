# Repository workflow

- Keep `main` as the only long-lived local and remote branch, per the owner's
  preference. Use a temporary `codex/` branch when a pull request is required.
- After a task is merged, delete its temporary local and remote branches and
  return the checkout to `main`. Do not delete another task's active branch or
  discard uncommitted work.
- Merged pull request branches are automatically deleted on GitHub. Routine
  Dependabot version-update PRs are paused; retain security alerts and checks.
- Follow `docs/hotfix-procedure.md` and `docs/release-versioning.md` for production
  changes, including the exact-commit CI candidate and release workflow.
