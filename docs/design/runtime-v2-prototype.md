# Runtime V2 Prototype

Status: adopted incrementally in the production runtime after validation on the isolated
`mxqr_beta` worktree.

## Goal

The prototype tests whether room orchestration can move toward explicit lifecycle ownership and
domain-scoped asynchronous ordering without rewriting the product or changing its authority model.
It targets two recurring failure modes:

1. asynchronous preparation completing in a different order from message arrival; and
2. timers, subscriptions, abort controllers, and pending work being torn down through separate
   handwritten lists.

## Implemented runtime pieces

### `SessionScope`

`SessionScope` remains compatible with its existing timer API and now owns arbitrary cleanup
functions and child scopes. Disposal has these invariants:

- abort is published before resource cleanup starts;
- owned resources are released once, in reverse registration order;
- one failed cleanup does not strand the remaining resources;
- a resource registered after disposal is cleaned immediately; and
- disposing a parent disposes its children, while an early-finished child detaches from its parent.

### `OrderedCommitLane`

An ordered-commit lane separates work into two phases:

- `prepare(signal)` starts immediately and may overlap other preparations;
- `commit(value, signal)` runs in enqueue order and only while the owning scope is live.

A failed task does not poison the lane. Independent lanes do not block each other. Disposing the
owning room scope prevents queued commits, although a commit that has already crossed an async
boundary must still inspect its signal before any later side effect.

## Production slices migrated

### Standard-room operator YouTube additions

Playlist metadata resolution still begins concurrently, while queue publication remains ordered by
request arrival. The handwritten promise tail and room-code reset were replaced by an
`OrderedCommitLane` owned by a room `SessionScope`. A room-code, role, or authority-kind transition
disposes the old lane, so a stalled old-room resolver cannot block or mutate the next room.

The existing exact-connection, capability, request-id, queue-capacity, and revision fences remain in
place. Runtime infrastructure coordinates execution; it does not become the source of product
authority.

### Standard-room queue mutation feedback

Event subscriptions and accept/settle timers now belong to a lifecycle scope. Pending request timers
belong to a child mutation scope, so an authority transition releases them as one unit instead of
requiring timer ownership to be reconstructed from global names. Reinitialization disposes the old
subscriptions before installing their replacements.

## Dispatch policies discovered

One global asynchronous message queue would be incorrect. The current runtime needs at least these
separate policies:

| Policy             | Suitable work                                | Reason                                                         |
| ------------------ | -------------------------------------------- | -------------------------------------------------------------- |
| Concurrent         | heartbeats and independent data-plane work   | unrelated latency must not create head-of-line blocking        |
| Ordered commit     | queue/settings mutations with parallel reads | preserves intent order without serializing network preparation |
| Latest/superseding | remote download and preload ownership        | a successor must be able to abort a predecessor immediately    |
| Fully serial       | selected server CAS/reconciliation loops     | both read and write phases may depend on the prior result      |

Protocol registration should only gain an execution-policy option after each message family has
been classified. Making ordered execution the default would retain large file chunks behind slow
control requests and would break the current successor-aborts-predecessor behavior in remote share.

## What the prototype does not replace

- exact live connection checks;
- room/session, queue-item, revision, and operation-epoch fences;
- post-`await` freshness checks inside domain commits;
- server authority and canonical snapshots in PRO rooms; or
- the full `leaveSession()` teardown and all module-local resources.

PRO-room migration is a separate follow-up. Its effects and queue-mode tails are fully serial
server-reconciliation loops, while transfer and remote-share paths use superseding ownership. They
can share `SessionScope`, but they should not all be converted to `OrderedCommitLane`.

## Prototype conclusion

The shared primitives are small and testable; choosing the correct policy and retaining the existing
authority fences is the expensive part. This supports an incremental V2 runtime kernel inside the
current repository. It does not support a clean-room rewrite or a mechanical replacement of every
promise tail with one queue abstraction.

Recommended next gate: introduce one top-level room scope at the Standard room join/leave boundary,
migrate a small resource family at a time, and require focused race tests plus the full regression
suite before moving to the PRO runtime.

## Verification performed

- focused core, queue-authority, and YouTube tests: 4 files, 71 tests;
- complete Vitest suite;
- complete TypeScript project checks, including browser, Worker, tooling, and tests;
- application and tooling ESLint;
- dead-export and room-authority boundary ratchets; and
- checked production build, transfer budgets, service-worker shell, and production security guards.
