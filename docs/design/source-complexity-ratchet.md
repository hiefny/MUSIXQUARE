# Source Complexity Safety Limits

Status: accepted
Date: 2026-08-16

## Decision

The source-size guard is a generous accident detector, not an architecture
target and not a signal that a file should be split. Its limits intentionally
leave substantial room above the current production sources:

| Source boundary | Safety limit |
| --- | ---: |
| App and PRO Workers | 20,000 lines |
| Signaling Worker, PRO browser runtime, and admin runtime | 10,000 lines |
| Service Control Durable Object | 2,000 lines |
| Signaling wire protocol | 1,000 lines |
| Shared bounded request-body helper | 500 lines |
| Production/recovery workflows | 2,000 / 1,000 lines |
| Largest inline workflow `run` block | 200 lines |

These round limits are deliberately not tight ratchets. Approaching one means
that ownership should be reviewed; it does not prescribe extraction. Raising a
limit is an acceptable outcome when co-location preserves a clearer lifecycle,
transaction, or recovery path.

## Co-location policy

Large coordinators and Workers are acceptable when they remain the clearest
owner of a single runtime lifecycle, authority boundary, or atomic mutation
path. In particular, source extraction must not be performed solely to reduce
line count.

Prefer co-location when a proposed module would:

- keep reading or mutating the parent's state through a wide callback surface;
- add a one-consumer forwarding API without independent behavior;
- introduce module-global configuration or initialization ordering merely to
  avoid a large source file;
- separate mutation, rollback, persistence, post-commit publication, or alarm
  scheduling that must remain atomic; or
- make one behavior require more files to understand without reducing the
  number of states, dependencies, or failure modes.

A new production module should normally justify itself through at least one of
the following:

- independent state and start/stop/recovery lifecycle;
- a contract shared by multiple production consumers;
- a security or wire-protocol invariant with focused tests;
- a real lazy-loading, Worker, Durable Object, or deployment boundary; or
- removal of a circular dependency through a narrow, explicit port.

## Existing boundaries

The Service Control Durable Object, signaling protocol, shared request-body
reader, shared cryptographic assertions, and reviewed lazy feature entries have
runtime or contract meaning beyond file size and remain separate. Conversely,
one-consumer capability helpers were returned to the App Worker because their
wide internal API duplicated common crypto primitives and left request
orchestration in the parent. Small cycle-breaking ports may be consolidated
into an existing domain module when the dependency graph remains acyclic.

## Guard behavior

`scripts/check-source-complexity.mts` runs in `build:checked` and main CI. It
continues to catch accidental source generation, pasted artifacts, and
unreviewed workflow growth. Typechecking, ESLint, dead-export/import-graph
checks, Worker bundle validation, security checks, and behavior tests remain
the authoritative correctness evidence.

When a safety limit is crossed, reviewers should choose the simpler system:

1. keep the code co-located and deliberately raise the documented limit; or
2. extract only when ownership, dependency count, or failure isolation
   measurably improves.

Neither option should be chosen to make the line counter look tidy.
