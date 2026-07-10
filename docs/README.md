# Documentation Map

Repository documentation has two different purposes: some files define the
current operating contract, while others preserve the evidence and reasoning
from a dated audit or completed migration. A dated audit is not a live backlog
or a substitute for the current source and tests.

## Current References

- [Browser media storage policy](design/browser-media-storage-policy.md) —
  accepted RAM-only media-storage ADR and the gate for reconsidering OPFS.
- [Playback state consumption contract](state-patterns.md) — current rules for
  reading and reacting to playback mode/activity.
- [Playback concurrency invariants](design/playback-concurrency-invariants.md) —
  concurrency mechanisms and executable test/guard anchors. Exact site counts
  in the prose are a review snapshot; the linked tests and guards are decisive.
- [AppState decomposition](appstate-decomposition.md) — completed migration
  record plus the surviving mode/activity contract.
- [Production hotfix and rollback](hotfix-procedure.md) — current release and
  service-worker update procedure.
- [Known and accepted risks](known-accepted.md) — intentional tradeoffs that
  still require code-path verification before being reused.
- [Runtime scenario verification](runtime-scenario-verification-2026-05-31.md) —
  maintained focused E2E and manual-device checklist despite its original date.
- [System sync compensation](system-sync-compensation.md) — current constants
  and the distinction between platform compensation and shared WebRTC buffering.
- [Translation guide](i18n-translation-guide.md) and
  [migration audit prompt](migration-audit-prompt.md) — reusable contributor
  references.

## Adjacent Maintained Guides

- [Admin dashboard operations](../cloudflare/admin-dashboard-ops.md) and
  [remote-share operations](../cloudflare/remote-share-ops.md)
- [Font assets and verification](../fonts/README.md)
- [Public design-system guide](../public/designsystem/README.md)
- [Third-party runtime notices](../THIRD-PARTY-NOTICES.md)

## Historical Records

The following are intentionally retained as historical evidence. Their dates,
commit references, test totals, line numbers, proposed phases, and statements
such as “current” describe their audit baseline, not today's repository:

- `project-analysis/2026-05-24/`
- `css-cleanup-2026-05-30.md`
- `large-file-split-design-2026-05-30.md` (large *source files*, not large media)
- `perf-memory-audit-2026-05-30.md`
- `type-safety-audit-2026-05-30.md`
- `device-test-2026-06-10.md`
- `domain-audit-2026-06-10.md`
- `scenario-audit-2026-06-10.md`
- `full-project-audit.md`
- `design/manual-qa-checklist.md`
- `design/playback-state-machine.md`
- `../e2e/COVERAGE-NOTES-2026-05-30.md`

Each retained file carries its own historical notice. Use Git history when an
exact old implementation is needed; do not revive a discarded plan merely
because it remains documented.

## Source Of Truth

For runtime behavior, the precedence order is:

1. production code and Cloudflare configuration;
2. executable tests and repository guards;
3. accepted/current reference documents above;
4. dated historical records.

Secret-bearing local operations notes live under ignored `docs/private/` and
must never be added to Git.
