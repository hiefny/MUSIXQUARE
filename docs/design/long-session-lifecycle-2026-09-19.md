# Long-session lifecycle corrections

- Status: implemented; release verification recorded with the pull request
- Baseline reviewed: 8.6.48 / service-worker v615
- Release: 8.6.49 / service-worker v616

The audit separated elapsed-time boundaries from accumulated work. A room can
remain healthy under steady heartbeats yet fail after background suspension,
credential expiry, many historical visitors, or deletion of an unfinished upload.
This change addresses those boundaries without changing media admission, room
permissions, the physical device limit, or the system-audio duration policy.

## Standard connections

TURN credential expiry now accompanies the configuration used by the transport.
The owning peer renews before expiry with a bounded request and retry schedule,
updates its existing peer connections, and retains the same configuration for
future connections. Background recovery and necessary ICE work also check the
credential deadline. A failed refresh preserves live channels; it never grants
local delivery privileges or pretends an expired relay credential is valid.
Destroying the peer cancels its renewal owner and timer.
The refresh uses the provider-documented `setConfiguration()` path; it does not
force a healthy connection through ICE restart. Continuous relay allocation
longevity still requires real-browser verification past the credential lifetime.

An admitted room's replacement signaling socket has its own admission watchdog.
A successor stuck connecting, or open without authenticated admission, no longer
blocks every later automatic/manual retry. Only the exact logical socket
generation is retired. Existing RTC channels and the WebKit-safe physical-socket
retirement path remain intact.

Host offer/departure sequence records are reclaimed only after the peer has no
connection, negotiation, or pending asynchronous offer owner. This preserves the
fence that prevents a departed peer's delayed offer from creating a new connection.

## Historical Standard account labels

The bounded signaling directory stores display labels, not account permissions.
It keeps remembered numbers while space remains. Once all guest labels or all
100 directory entries are occupied, a departed member's label can be reused.
Current same-account devices keep their common number. Replacing one physical
device's account does not require reserving that departing identity's label when
no other device still uses it.
A pending reconnect cannot release its still-live predecessor's number before
admission succeeds; only an in-place identity refresh can replace its own label.

The member ID is still derived from the verified account and unchanged room
secret. Returning accounts therefore retain their host-held grants even when a
historical visible number was reclaimed. No account-deletion event is emitted
for label eviction. Authentication must not silently disappear merely because
99 different accounts previously visited an otherwise lightly occupied room.

## PRO presence and member lifetime

Expired presence is distinct from a real tab takeover. Only a request whose
participant and incarnation still exactly match its room session can receive the
recoverable expiry result. Missing/mismatched identity continues to fail closed.
New clients opt into `PRESENCE_EXPIRED` and use normal presence entry without
takeover, accepting the new authoritative snapshot and transport. Older clients
receive the existing `SESSION_REQUIRED` recovery path. A live replacement tab
continues to receive full protection from the superseded document.

An expired account identity lease or logout removes account authority immediately.
A private detached-member reference retains only the ordinary member's lifecycle
association until its final room session is removed; it cannot authenticate an
account or grant capabilities. Cleanup preserves owner and delegated-admin
records. Stable-boundary pruning also repairs old orphaned ordinary records.
Capacity handling may retire wholly offline ordinary-member sessions under
pressure, while current devices and persistent authority remain protected.
Re-entry completion is fenced across asynchronous playlist acceptance, so leaving
or opening another room during recovery cannot restart or terminate the wrong
session.

## Remote file work

Changing tracks while the old occurrence remains in the queue can still finish
its useful cache-warming upload. Removing that occurrence now aborts its upload
owner through the existing authenticated transport cleanup. A promoted/shared
waiter cannot publish a canceled result or clear a successor's progress UI.

Completed descriptor metadata is pruned on expiry and removal of its last live
File reference. One named timer covers the earliest expiry; room teardown clears
it. A 256-entry recent-use bound limits metadata for unusually large queues.
Eviction only affects reuse of a future upload; it does not stop current audio or
delete a live file. Completed R2 objects retain the server's existing TTL policy.

## Validation boundaries

Regression coverage includes historical account churn, fully occupied live
labels with one device changing accounts, multiple devices sharing one member,
expired presence versus actual takeover, stale recovery completion, orphan
member cleanup and admission pressure, credential renewal and teardown,
unadmitted reconnect sockets, delayed-offer fences, removed uploads, promoted
waiters, descriptor expiry, and duplicate File reuse.

The read-only audit also simulated 72 hours of Standard clock sampling, 24 hours
of steady PRO heartbeat/account renewal, and 24 hours of bounded diagnostics.
These prove application-state bounds, not a days-long physical-device soak or
native decoder memory reclamation. Real iPhone PWA screen lock, Wi-Fi/cellular
handoff, and long-lived relay allocations remain manual verification items.

The release follows the exact-commit CI candidate and Production Release
workflow. Mixed-version handling is backward-compatible; no D1 migration or
global active-client reload is introduced.
