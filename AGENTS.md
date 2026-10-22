# Repository workflow

## Release record

- Read `docs/release-record.md` before each QA round and before preparing a
  main merge or production release.
- `docs/release-record.md` holds only the current state. After each production
  deployment or rollback (a Production Release run, a local emergency deploy,
  or a CLI rollback), overwrite all of its §1 and its `Last source review` line,
  and append exactly one row to the bottom of `docs/release-history.md`. Do not
  keep superseded values in the record.
- Keep one dated report under `docs/design/` per release train (the increments
  that ship in one production release) and list it in the `docs/README.md`
  evidence section. The report lists each QA round and product/runtime
  increment in the train with its tested code SHA, environment, and
  pass/fail/skip limits. Tests-only, documentation-only, and guard- or
  audit-tooling-only changes need no report. For any change, update the record
  in the same change only when release scope, dependencies,
  schema/secrets/bindings, compatibility, version requirements, open items,
  recovery steps, or owner decisions change, and link the report from any open
  item it adds or changes. If none changed, leave the record alone.
- Remove an open item only with evidence, cited in the pull request. Never
  treat local or branch tests as the successful exact-main-SHA release
  candidate.
- `docs/beta-release-readiness-archive-2026-10-10.md` is the frozen beta-era
  record. Do not edit it except to keep links working or to remove third-party
  or off-project content.
- The record tracks evidence; owner authorization and the release procedure
  remain authoritative.

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

## Resource ownership

- Before adding any recovery, retry, timeout, watchdog, or lifecycle flow, find
  its resource in `docs/design/resource-ownership-registry.md` and extend the
  owner its record names instead of adding an independent machine.
- Add a record in the same change when your flow becomes the second machine on
  a resource the registry does not list yet, or on one of its checked side-flow
  resources. A flow that is its resource's only owner needs none. An owner
  change updates the registry in the same change.
- Import timing values from the home the registry names; never retype them.
  Where a runtime cannot import, pin the copy with a parity test named in the
  record.
- `node scripts/check-resource-ownership.mts` enforces the registry with exact
  counts. A baseline changes only in the pull request that changes the counted
  code, with the reason: lowering one is routine; raising one, or adding an
  entry, also needs a record update.

## Public repository

- This repository is public. The owner's own details may appear, but write
  other people's cases anonymously: no names, quoted messages, cities, event
  types, or real room codes. Summarize emails instead of quoting them, and use
  synthetic room codes in tests and examples.
- Keep working notes, session chatter, and AI tool or account notes in the
  git-ignored `docs/private/` folder, not in committed documents.
