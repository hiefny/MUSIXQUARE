# System-audio receive ownership

| Field              | Value                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | Maintained contract                                                                                                                                                                                                   |
| Applies to         | The device's one system-audio reception: the Standard direct call and SFU guest routes, and the PRO coordinator with its SFU and LAN-direct transports                                                                |
| Owner              | `src/network/system-audio-receive-slot.ts` (registry RO-04)                                                                                                                                                           |
| Last source review | 2026-10-26 (Phase 5 train 5B, increment 5B-G2)                                                                                                                                                                        |
| Executable sources | `scripts/check-resource-ownership.mts` (CHECK 4, 9 and 10, run in CI), `scripts/check-import-graph.mts` (RULE D), the four receive-slot contract suites and the tests named below                                     |
| Related documents  | [Resource ownership registry](resource-ownership-registry.md) (RO-04, RO-20), [Realtime runtime ownership](realtime-runtime-ownership.md), [Initial bundle and lazy-loading policy](initial-bundle-loading-policy.md) |

One device receives one system-audio share at a time. The receive slot is that
reception's one owner: it keeps the state that cannot be read back, runs the
start and the end, owns the slot's receive deadline and connects what a route
received to the audio graph. Route adapters keep their own transport and call
the slot; none of them sets the receiving flag, claims the `'system-audio'`
playback owner or connects to `widener.input` itself.

Phase 5 train 5A of the 2026-10-22 structural plan built the slot (increments
C4-1 to C4-8) by moving the existing code without changing its behaviour. The
gaps that train pinned as today's behaviour are listed [below](#todays-gaps);
changing one is a behaviour decision with its own failing test first. Train
5B changes them in labelled groups (owner decision P5-D5 A); each fixed gap
names its increment in the table.

## The resource

- `systemAudio.isReceiving`, the receiving flag, written through
  `setSystemAudioReceiving` in `src/player/ownership.ts`;
- the `'system-audio'` playback owner claim and its pending placeholder meta;
- the restore meta: the title that was current when the reception started;
- per route, the source node on the stereo widener's `widener.input` and the
  WebRTC decoder primer;
- the receive deadline.

## The owner and its state

The slot stores only what it cannot read back. Whether it is pending (the
placeholder meta is current) or receiving (the flag is set) is read from player
state at each input, because the `leaveSession` reset and a successor playback
owner change both.

| Phase      | Meaning                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `idle`     | No restore point is held; the next start takes the next generation.                                                             |
| `claiming` | A start is committing its generation: a trust-boundary wait opened now joins it, and another start is refused until it returns. |
| `held`     | A committed start's restore point, kept until the reception ends.                                                               |

Beside the phase and its generation it keeps the trust-boundary waiters (each
fenced by the generation it waits for), each route's source and primer, the
ports the routes registered and the timestamps the Standard guest's `/debug`
section reads.

## Routes

| Route             | Adapter                                                                                                                           | The adapter keeps                                                                                                                                                                                                                                                  | Port                                                                                     | Attach that starts the reception | Deadline |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------- | -------- |
| `standard-direct` | `src/network/system-audio-guest.ts`                                                                                               | the host START/STOP trust gate, the direct call's identity, the early prime, the 2 s unmute wait, the playout hint, its own `initAudio()` with the call re-check, the replacement watchdog                                                                         | `endReception`: cancels its waits and watchdog, detaches the route and closes the call   | `first-for-slot`                 | `slot`   |
| `standard-sfu`    | `src/network/system-audio-sfu.ts`                                                                                                 | the Realtime subscription, the subscriber-PC identity, the playout hint, its own `initAudio()` with the PC re-check, the two-hour receive limit per subscription, the frozen share route, the guest-role check                                                     | `onDeadline`: a guest drops its subscription; `retire`: the subscription and share route | `first-for-route`                | `slot`   |
| `pro-coordinator` | `src/pro-room/system-audio-service.ts`, fed by `src/network/pro-system-audio-sfu.ts` and `src/network/pro-system-audio-direct.ts` | the publication identity and its re-checks, the subscription key and the same-publication retry, the 2.5 s disconnect grace, the retry backoff, the direct receive deadline, the local-owner guard, the ended-publication mark and its force-stop reaction (5B-G2) | none                                                                                     | `every-attach`                   | `route`  |

The PRO coordinator is one route for both of its transports, because it holds
one source and one primer whichever transport delivered the track. The PRO
transports hand their tracks to the coordinator and never call the slot. The
coordinator reaches the Standard routes only through the slot: RULE D of
`scripts/check-import-graph.mts` fails a `src/pro-room/**` production import of
`system-audio-guest.ts` or `system-audio-sfu.ts`. Since C4-8 no route imports
the slot's names from another route.

The attach that starts the reception sets the receiving flag, claims the
owner, starts the visualizer and writes the route's connected line:

- `first-for-slot`: the first attach while the slot is not receiving. A
  replacement direct call's stream only swaps the source.
- `first-for-route`: the route's first attach since it was last detached, even
  while the slot is receiving, so each SFU subscription starts the reception
  and its two-hour limit again.
- `every-attach`: every coordinator track (a subscription, a retry, a
  promotion, a new direct route). The coordinator writes no connected line; its
  transports log the track.

## Inputs

| Input          | Slot API                                                  | What the slot does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Called by                                                                                                                                                                                                                                                         |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start          | `beginTrustedSystemAudioReception(surface, { deadline })` | Refuses while the placeholder is up or a start is claiming. Takes the restore meta, stops the current playback (`stopAllMedia`), cancels the incoming file transfer, the remote share wait and the preload watchdogs, claims the pending `'system-audio'` placeholder, emits `system-audio:host-started`, arms the slot deadline for `'slot'` or clears it for `'route'`, then answers the generation's boundary waiters.                                                                                     | The host START frame, the Standard SFU READY after a direct-route failure, the PRO coordinator's SFU and LAN-direct starts                                                                                                                                        |
| Trust boundary | `awaitTrustedSystemAudioReceptionBoundary(channel)`       | True once a start committed the placeholder (at once while it is up); false when the reception ends or no start commits within the receive deadline.                                                                                                                                                                                                                                                                                                                                                          | Every route before its attach                                                                                                                                                                                                                                     |
| Prime          | `primeSystemAudioDecoder(route, tracks, request)`         | One primer per stream key per route; a new key replaces the route's primer. The primed and primer-blocked lines keep the route's prefix.                                                                                                                                                                                                                                                                                                                                                                      | Every route                                                                                                                                                                                                                                                       |
| Attach         | `attachSystemAudioSource(route, received, request)`       | First the fence (since 5B-G1): while the slot's placeholder is not the current meta (the reception ended, or another owner plays) it returns `'not-receiving'`, writes nothing, never reaches the graph and drops the route's source and primer. Then `'graph-unavailable'`, changing nothing, while the audio graph is not built. Otherwise `'attached'`: it swaps the route's source on `widener.input`; an attach that starts the reception also clears the slot deadline when the slot was not receiving. | Every route, synchronously after its own `initAudio()` and identity re-check                                                                                                                                                                                      |
| Resume         | `resumeSystemAudioRoute(route)`                           | The reception start again, only while the route still has a source. Since 5B-G1 it has the attach's fence: once the placeholder is gone it claims nothing and drops the route's source and primer.                                                                                                                                                                                                                                                                                                            | The PRO SFU subscription's `'subscribed'` state                                                                                                                                                                                                                   |
| Interrupt      | `interruptTrustedSystemAudioReception({ deadline })`      | Drops the receiving flag; with `'slot'` arms the slot deadline from now. The placeholder and restore point stay.                                                                                                                                                                                                                                                                                                                                                                                              | The PRO coordinator's disconnect grace, retry and receiver fallback (`'route'`)                                                                                                                                                                                   |
| Handoff        | `handOffTrustedSystemAudioReception()`                    | While the placeholder is up, interrupts under the slot deadline.                                                                                                                                                                                                                                                                                                                                                                                                                                              | The Standard SFU (a failed subscription with a pending READY, or a direct call replacing it), behind its guest-role check                                                                                                                                         |
| Expire         | `expireTrustedSystemAudioReception()`                     | Every registered `onDeadline` (one that throws is logged and the rest still run, as the bus contained a throwing listener), then the end, then the `receive_failed` notice.                                                                                                                                                                                                                                                                                                                                   | The slot deadline and the direct call's replacement watchdog, each after its warn line                                                                                                                                                                            |
| Detach         | `detachSystemAudioRoute(route)`                           | Drops that route's source and primer only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The routes' own cleanups                                                                                                                                                                                                                                          |
| Adopt          | `adoptSystemAudioReceiveRoute(route)`                     | Runs every other registered route's `retire`; changes nothing in the slot.                                                                                                                                                                                                                                                                                                                                                                                                                                    | The PRO coordinator: the room turning PRO, every live reconcile, a retry's cleanup                                                                                                                                                                                |
| End            | `endTrustedSystemAudioReception()`                        | See [End of reception](#end-of-reception).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The host STOP frame, `system-audio:force-stop` (the guest's listener), a Standard route's attach failure or call close, the Standard SFU cleanup after an attach and its READY after a direct-route failure (before the new start), the PRO coordinator's cleanup |

`getSystemAudioReceiveRouteSnapshot(route)` answers whether a route attached a
source and holds a primer: the `/debug` keys of both Standard routes, whether
the Standard SFU's cleanup ends the reception, and whether the PRO direct
receive deadline still has a failure to report.

## End of reception

`endTrustedSystemAudioReception()` runs in this order:

1. It consumes the restore point and moves the slot to `idle` with the next
   generation, so a nested or repeated end never replays an earlier snapshot.
2. It answers every trust-boundary waiter with false.
3. It reads whether the slot still holds the placeholder or the
   `'system-audio'` owner, and clears the slot deadline.
4. It runs every registered `endReception` port. Only the direct call has one.
5. It drops the receiving flag.
6. Only while the slot still held the placeholder or the owner, it restores
   the title, releases the `'system-audio'` owner (forced for a placeholder)
   and sets playback idle. A newer playback owner keeps its title and
   lifecycle.

The Standard SFU and the PRO coordinator register no `endReception`: an end
leaves their transports, sources and primers to their own cleanups. Since
5B-G1 a later attach or resume on such a route is refused once the end took the
placeholder away, and the refusal drops what the route still holds. Since
5B-G2 the coordinator's own `system-audio:force-stop` listener is one of those
cleanups: while it receives a remote publication it ends its route (the pending
retry, the disconnect grace, the direct receive deadline, the source and
primer, the subscribe in flight and the SFU subscription) and marks that
publication ended, so neither a heartbeat nor a retry subscribes or begins
again until the publication changes. A force-stop nested in the coordinator's
own start (its `stopAllMedia` while local capture runs) leaves that start
alone. On LAN-direct the force-stop drops the attached source and primer, and
the receiver route stays open until the publication changes or ends or the room
resets; a receiver fallback of that route afterwards still shows
`connection_unstable` once, as before 5B-G2 (accepted with the open route,
RO-04, and pinned by the PRO row "accepted with the open LAN-direct route …").
Adopt is not an end: a retiring route drops only what it holds, and the
reception, its placeholder and restore point, the receiving flag, the owner
claim and the deadline stay.

The `'system-audio'` owner is also the sharer's own claim
(`src/audio/system-capture.ts`). The PRO coordinator never ends a reception
over this device's own publication (`!latestView.isLocalOwner` in
`cleanupCoordinatorGraph`), and `resetProSystemAudioService` runs that cleanup
before it forgets the local owner.

## Attach failures

Each route keeps its own policy when its attach fails (for example a context
that does not resume, or no audio graph, `'graph-unavailable'`): the Standard
routes end the reception with `receive_failed`, the PRO SFU fails into a
backed-off retry that keeps the placeholder, and the PRO LAN-direct route fails
into a receiver fallback whose placeholder waits for the promotion.

A refused attach (`'not-receiving'`, since 5B-G1) is no failure: the slot
ended or another owner plays, so there is nothing to retry and nothing to
notify. The slot has already dropped the route's source and primer, and no
route ends the reception, throws or shows a notice:

- Standard direct: the call stays open and current, and its replacement
  deadline is cleared. A guest close would send `media-close`, and while the
  share is active the host would hand the guest to the SFU with STOP, START and
  READY, whose START stops a successor. STOP or the reception's end closes the
  call through the end port.
- Standard SFU: the subscription closes (`cleanupGuestSfu()`, as for the trust
  boundary's refusal; only Cloudflare hears it) and the share route stays
  frozen. It attached nothing, so the cleanup ends no reception.
- PRO coordinator: since 5B-G2 a refused SFU track, by the fence or by the
  trust boundary's refusal, stops the SFU subscriber and marks the publication
  ended, with no retry and no notice; the subscribe it aborts in flight is no
  failure (no warn, no `connection_unstable`). A refused LAN-direct track leaves
  the route open (a close would fail the share over to the SFU or invite a
  re-offer; the open route carries no Cloudflare traffic). A refused resume (a
  `'subscribed'` after another owner replaced the placeholder of an attached SFU
  reception) drops the source and primer but leaves the SFU subscription open
  until the publication changes, as before 5B-G2: of the refusals only a refused
  attach and the boundary's refusal end the route (RO-04; pinned by the PRO row
  "5B-G1: a 'subscribed' for the live publication after a successor replaced
  the placeholder …").

The fence reads only the placeholder, not the slot's phase (a start that ran
through a nested end leaves the phase `idle` over its own placeholder). Two
writers set the meta to null while a listener receives (the PRO projection's
`stopProjectedMedia` and the Standard guest's current-item removal); in that
window an attach or a resume is refused too, and the sharer's own media stop
ends the share within one round trip.

## Deadlines and timings

Each start and interrupt names who bounds the wait for a route's audio
(`ReceiveDeadline`):

- `'slot'`: the slot's 30 s receive deadline (timer
  `sys-audio-guest-receive-watchdog`), for the Standard routes. When it passes
  with nothing playing and the placeholder still up, it logs its warn line and
  expires the reception.
- `'route'`: no slot deadline. The PRO coordinator owns its deadlines: the SFU
  re-subscribe backoff (2.5 s doubling to `SUBSCRIBER_RETRY_MAX_DELAY_MS`,
  30 s), the 2.5 s disconnect grace and the LAN-direct receive deadline (timer
  `pro-system-audio-direct-receive-deadline`, 30 s), which reports
  `connection_unstable` once per publication generation and keeps the
  placeholder for a late track.

The trust-boundary waits (`sys-audio-guest-trust-gate-<channel>-<n>`, 30 s)
are the slot's. The direct call's replacement watchdog
(`sys-audio-guest-replacement-watchdog-STEREO`, 30 s) and the Standard SFU's
two-hour limit per subscription (`SYSTEM_AUDIO_SHARE_LIMIT_MS`, timer
`system-audio-sfu-guest-limit`) are the routes'. The timer names keep their
`sys-audio-guest-` prefix from before the slot existed.

The timing home is `src/network/system-audio-media.ts`:
`SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS` (30 s, read by the slot deadline, the
trust-boundary wait, the replacement watchdog and the service's
`DIRECT_RECEIVE_DEADLINE_MS`), the 0.5 s playout-delay hint, the 256 kbps stereo
sender tuning and the Cloudflare Realtime STUN entry, request deadline and
response cap. `RECOVERY_DELAY_MS` and `SUBSCRIBER_RETRY_MAX_DELAY_MS` stay in
the service, because they time the coordinator's own deadlines and the
service's lease and publisher retries (RO-20).

## Writer rules

`node scripts/check-resource-ownership.mts` (run in CI) counts these writes per
file in `src/`, exactly. The counts are final since C4-8:

| Write                                                                    | Allowed                                                                             |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `setSystemAudioReceiving` value uses                                     | The slot (3: the end, the interrupt, the reception start)                           |
| `claimPlaybackOwner` uses that can claim `'system-audio'`                | The slot (2: the placeholder, the reception start) and the sharer's own capture (1) |
| `.input` reads on a receiver named `widener`                             | The slot (1: the attach) and `src/audio/engine.ts` (2: the file playback route)     |
| Raw `'systemAudio.isReceiving'` writes outside `src/player/ownership.ts` | `src/network/peer.ts` (1: the `leaveSession` batch reset)                           |

No route adapter has an entry, so a route that writes the slot itself is an
unsanctioned writer, not a raised count. The widener match is by name: a
widener held under another name is not seen, and neither is a call through a
renamed import of the setter or the claim, so review both by hand. The same
guard keeps one deadline owner per PRO SFU attempt (armed
`beginTrustedSystemAudioReception` starts, any without the literal
`{ deadline: 'route' }`, are exactly the host START handler in
`registerSystemAudioGuestListeners` and the Standard SFU's `handleSfuReady`)
and the media tuning in its home.

The slot and its timing home are deferred-only (`DEFERRED_ENTRY_MODULES` in
`vite.config.ts`) and load with the room session; no eager module may import
them. That is why `src/network/peer.ts` keeps its raw reset.

## Logs and `/debug`

`/debug sa` reads the slot through the Standard guest's snapshot: the slot's
start, ignored-start, cleanup and deadline timestamps, and `gotStereo`,
`sourceStereo` and `decoderPrimer` as "the direct call attached a source" and
"holds a primer". The SFU section reads its own route the same way. A PRO
reception sets only the shared flags there. These lines and the device
evidence log lines keep their exact text, pinned since Phase 5 prep by
`src/network/__tests__/system-audio-receive-evidence-logs.test.ts` and
`src/pro-room/__tests__/system-audio-pro-receive-evidence-logs.test.ts`.

## Today's gaps

These are today's behaviour, pinned by the contract suites so the move could
not change them. Each change is a behaviour decision with its own failing test
first. Suites: Standard is
`src/network/__tests__/system-audio-receive-slot-contract.test.ts`, lifecycle
is `src/network/__tests__/system-audio-receive-slot-lifecycle-contract.test.ts`,
PRO is `src/pro-room/__tests__/system-audio-receive-slot-pro-contract.test.ts`
and transport is
`src/pro-room/__tests__/system-audio-receive-slot-pro-transport-contract.test.ts`.

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                     | Pinned by                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Standard SFU re-publication: when the host publishes again while a guest receives and the new subscription fails, the guest stays "playing" in silence, with no deadline and no notice, until STOP.                                                                                                                                                                     | Standard "re-publication gap: …"                                                                                                                                                                                                                                                                                                                                 |
| 2   | Fixed in 5B-G1: a successor owner that claimed playback while an attach waited in `initAudio()` (up to 500 ms) was overwritten by that attach, on all four routes. The fence now refuses the attach and the resume.                                                                                                                                                     | Standard "S9, fixed in 5B-G1: …" and "S9 (SFU), fixed in 5B-G1: …"; PRO group "successor during initAudio (attach fence, PRO routes; fixed in 5B-G1)"; `system-audio-guest.test.ts` group "attach fence: the slot ended or another owner plays (5B-G1)"                                                                                                          |
| 3   | Fixed in 5B-G1: a force-stop while a PRO track waited in `initAudio()` still connected it under the restored title, on both PRO transports. The fence now refuses it.                                                                                                                                                                                                   | PRO "S8b, fixed in 5B-G1: …"; transport group "S8b: a slot end while the attach waits in initAudio (real PRO transports)"                                                                                                                                                                                                                                        |
| 4   | Fixed in 5B-G2: a PRO force-stop ended only the placeholder: the coordinator's source, primer and subscription stayed until the room reset, and a retry in its backoff still subscribed. The coordinator's force-stop listener now ends its route and marks the publication ended (not a force-stop nested in its own start); the LAN-direct receiver route stays open. | PRO "5B-G2 ($route): force-stop ends the PRO reception without a restore, …" (SFU and LAN-direct), "G6 and 5B-G2: a force-stop during a retry backoff …" and "5B-G2: a force-stop while a retry's subscribe is in flight …"; transport "S8b (SFU), fixed in 5B-G1: …" and "5B-G2 (SFU): a force-stop between the exposed track and the completed subscription …" |
| 5   | Fixed in 5B-G2: when another owner replaced the placeholder, a PRO SFU track was dropped at the trust boundary in silence, and its subscription stayed open with nothing attached until the publication changed. A refused SFU track (the boundary or the fence) now closes its subscription and marks the publication ended, with no notice.                           | PRO "trusted boundary, 5B-G2: …" and "S9 (SFU), fixed in 5B-G1: …"; transport "5B-G2 (SFU): a successor owner between the exposed track and the completed subscription …"                                                                                                                                                                                        |
| 6   | When this device starts sharing while it receives, the receiving flag stays set with no source.                                                                                                                                                                                                                                                                         | PRO "S11 gap: …"                                                                                                                                                                                                                                                                                                                                                 |
| 7   | A start that runs through a nested force-stop empties its restore point; on LAN-direct the direct receive deadline, armed after that start, survives it (one notice at 30 s, a late track still attaches).                                                                                                                                                              | PRO "begin re-entrancy: …"; transport "begin re-entrancy (LAN-direct): …"                                                                                                                                                                                                                                                                                        |
| 8   | Notices differ per route: a Standard SFU live failure, a Standard direct call that closes while receiving and losing the host connection while receiving over the SFU all go idle with no notice; the Standard slot deadline shows `receive_failed`; PRO shows `connection_unstable`.                                                                                   | Standard "a live subscriber connection failure …"; lifecycle "expected today: the transport closing the direct call …" and "expected today: losing the host connection …"                                                                                                                                                                                        |
| 9   | A PRO direct-to-SFU promotion runs the start again (pending, idle, pending, with `stopAllMedia` twice); the audible gap is not measured.                                                                                                                                                                                                                                | PRO "S7: a direct-to-SFU promotion moves the source without overlap and keeps the restore point"                                                                                                                                                                                                                                                                 |
| 10  | Outside the slot (RO-21): a share that ends while the page is hidden, after a failed first restore, prepares the same revision twice when the page is shown.                                                                                                                                                                                                            | `src/pro-room/__tests__/runtime-system-audio-join.test.ts` "F3 baseline: …"                                                                                                                                                                                                                                                                                      |
| 11  | A LAN publisher's 'stopped' close closes the route without telling the slot: receiving and the source stay until the server's idle state arrives.                                                                                                                                                                                                                       | Transport "expected today: a publisher close 'stopped' …"                                                                                                                                                                                                                                                                                                        |
| 12  | After a direct-to-SFU promotion the PRO SFU subscription ends at the promotion's two-hour budget, and the coordinator does not handle that 'stopped' event: "playing" on a closed transport until the next heartbeat, then one `connection_unstable` and backed-off retries that fail without a request until the share ends.                                           | Transport "expected today, two-hour budget re-publication case: …"                                                                                                                                                                                                                                                                                               |
| 13  | A first Standard SFU subscription that fails with no pending READY is silent; the placeholder waits for the slot deadline and its `receive_failed`, and an unchanged READY subscribes again.                                                                                                                                                                            | Lifecycle "expected today: a failed first SFU subscription …" and "expected today: an unchanged READY after a failed subscription …"                                                                                                                                                                                                                             |
| 14  | A Standard direct call error while pending closes the call and ends the placeholder without `receive_failed`.                                                                                                                                                                                                                                                           | Lifecycle "expected today: a call error closes the call, …"                                                                                                                                                                                                                                                                                                      |

## Verification

The repository guards this contract through:

- the four receive-slot contract suites above, `system-audio-guest.test.ts`,
  `system-audio-sfu.test.ts`, `system-audio-media.test.ts` and the G1 harness
  `src/pro-room/__tests__/system-audio-subscriber-watchdog.test.ts` (the real
  guest module and slot with the service), all in the critical-runtime
  coverage profile (`vitest.critical.config.ts`) with the slot module;
- `src/pro-room/__tests__/system-audio-service.test.ts`, which hand-mocks state
  and stubs the slot's start, trust boundary and end (since 5B-G1 the stubbed
  start commits the placeholder the attach fence reads, and the stubbed end
  retires it);
- `src/network/__tests__/system-audio-host.test.ts` "keeps an opened direct
  call with no close or error for 60 s with no SFU handoff" (5B-G1): with the
  Standard suite's S9 row (the refused call stays open until STOP) it shows that
  a refused direct attach causes no host handoff;
- the receive evidence-log suites named above;
- the resource-ownership guard (CHECK 4, 9 and 10), the import-graph guard
  (RULE D) and the dead-export guard;
- the local Playwright suite `e2e/system-audio-controls.test.ts` (Standard
  direct calls; outside CI by owner choice).

Real devices are outside these checks: the timing gaps above and the PRO
routes on real networks need device runs.
