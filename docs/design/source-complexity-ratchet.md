# Source Complexity Ratchet

Status: accepted
Date: 2026-08-15

## Extracted ownership boundaries

The service-control Durable Object and signaling protocol are independent
production modules with their own ceilings. Their extraction also lowered the
parent PRO and signaling Worker ceilings, so moving those responsibilities back
into either parent cannot silently spend the space freed by the extraction.

Large files are not defects by themselves, but the App, PRO, signaling, PRO
browser runtime, admin runtime, and production release paths are high-blast-
radius ownership boundaries. Unbounded growth in those files makes review and
rollback harder even when type, unit, or syntax checks remain green.

`scripts/check-source-complexity.mjs` therefore keeps narrow line ceilings for
the current hotspots. The production release workflow is split from its
independent recovery workflow, and candidate/device-evidence selection lives in
the tested `scripts/release-evidence.mjs` helper. Multiline release shell blocks
also have a 100-line ceiling so new orchestration logic moves into a focused,
unit-testable script instead of accumulating in YAML.

The ceilings are ratchets, not style targets and not permission to fill the
remaining lines. A change that crosses one must extract a cohesive concern into
a named module or helper. Raising a ceiling requires an accepted ADR that
identifies why extraction would make correctness or recovery worse, names an
owner, and sets a new reduction trigger. A formatting-only line-count change is
not sufficient justification.

The guard runs in `build:checked` and explicitly in main CI. It complements,
rather than replaces, typechecking, ESLint, dead-export/import-graph checks,
Worker bundle validation, and behavior tests.
