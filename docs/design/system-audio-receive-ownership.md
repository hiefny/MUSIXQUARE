# System-audio receive ownership

| Field              | Value                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | Maintained contract                                                                                                                                                                                                   |
| Applies to         | The device's one system-audio reception: the Standard direct call and SFU guest routes, and the PRO coordinator with its SFU and LAN-direct transports                                                                |
| Owner              | `src/network/system-audio-receive-slot.ts` (registry RO-04)                                                                                                                                                           |
| Last source review | 2026-10-27 (Phase 5 train 5B, through 5B-OV3)                                                                                                                                                                         |
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

| Phase      | Meaning                                                                                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idle`     | No restore point is held; the next start takes the next generation.                                                                                                                                                              |
| `claiming` | A start is committing its generation: a trust-boundary wait opened now joins it, and another start is refused until it returns. An end nested in it before its placeholder claim keeps it, restore point included (since 5B-G5). |
| `held`     | A committed start's restore point, kept until the reception ends.                                                                                                                                                                |

Beside the phase and its generation it keeps the trust-boundary waiters (each
fenced by the generation it waits for), each route's source and primer, the
ports the routes registered and the timestamps the Standard guest's `/debug`
section reads.

## Routes

| Route             | Adapter                                                                                                                           | The adapter keeps                                                                                                                                                                                                                                                                                                                                                                                                                        | Port                                                                                     | Attach that starts the reception | Deadline |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------- | -------- |
| `standard-direct` | `src/network/system-audio-guest.ts`                                                                                               | the host START/STOP trust gate, the direct call's identity, the early prime, the 2 s unmute wait, the playout hint, its own `initAudio()` with the call re-check, the replacement watchdog                                                                                                                                                                                                                                               | `endReception`: cancels its waits and watchdog, detaches the route and closes the call   | `first-for-slot`                 | `slot`   |
| `standard-sfu`    | `src/network/system-audio-sfu.ts`                                                                                                 | the Realtime subscription, the subscriber-PC identity, the playout hint, its own `initAudio()` with the PC re-check, the two-hour receive limit per subscription, the frozen share route, the guest-role check                                                                                                                                                                                                                           | `onDeadline`: a guest drops its subscription; `retire`: the subscription and share route | `first-for-route`                | `slot`   |
| `pro-coordinator` | `src/pro-room/system-audio-service.ts`, fed by `src/network/pro-system-audio-sfu.ts` and `src/network/pro-system-audio-direct.ts` | the publication identity and its re-checks, the subscription key and the same-publication retry, the 2.5 s disconnect grace, the retry backoff, the direct receive deadline, the local-owner guard (with the slot's reception query since 5B-G4), the ended-publication mark and its force-stop reaction (5B-G2), its route-closure reactions (a LAN-direct publisher's `'stopped'` close and the SFU subscriber's budget expiry, 5B-G6) | none                                                                                     | `every-attach`                   | `route`  |

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

| Input          | Slot API                                                  | What the slot does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Called by                                                                                                                                                                                                                                                                                                                          |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start          | `beginTrustedSystemAudioReception(surface, { deadline })` | Refuses while the placeholder is up or a start is claiming. Takes the restore meta (never the sharer's title, since 5B-G4), stops the current playback (`stopAllMedia`), cancels the incoming file transfer, the remote share wait and the preload watchdogs, claims the pending `'system-audio'` placeholder, emits `system-audio:host-started`, arms the slot deadline for `'slot'` or clears it for `'route'`, then answers the generation's boundary waiters.                                             | The host START frame, the Standard SFU READY after a direct-route failure, the PRO coordinator's SFU and LAN-direct starts                                                                                                                                                                                                         |
| Trust boundary | `awaitTrustedSystemAudioReceptionBoundary(channel)`       | True once a start committed the placeholder (at once while it is up); false when the reception ends or no start commits within the receive deadline.                                                                                                                                                                                                                                                                                                                                                          | Every route before its attach                                                                                                                                                                                                                                                                                                      |
| Prime          | `primeSystemAudioDecoder(route, tracks, request)`         | One primer per stream key per route; a new key replaces the route's primer. The primed and primer-blocked lines keep the route's prefix.                                                                                                                                                                                                                                                                                                                                                                      | Every route                                                                                                                                                                                                                                                                                                                        |
| Attach         | `attachSystemAudioSource(route, received, request)`       | First the fence (since 5B-G1): while the slot's placeholder is not the current meta (the reception ended, or another owner plays) it returns `'not-receiving'`, writes nothing, never reaches the graph and drops the route's source and primer. Then `'graph-unavailable'`, changing nothing, while the audio graph is not built. Otherwise `'attached'`: it swaps the route's source on `widener.input`; an attach that starts the reception also clears the slot deadline when the slot was not receiving. | Every route, synchronously after its own `initAudio()` and identity re-check                                                                                                                                                                                                                                                       |
| Resume         | `resumeSystemAudioRoute(route)`                           | The reception start again, only while the route still has a source. Since 5B-G1 it has the attach's fence: once the placeholder is gone it claims nothing and drops the route's source and primer.                                                                                                                                                                                                                                                                                                            | The PRO SFU subscription's `'subscribed'` state                                                                                                                                                                                                                                                                                    |
| Interrupt      | `interruptTrustedSystemAudioReception({ deadline })`      | Drops the receiving flag; with `'slot'` arms the slot deadline from now. The placeholder and restore point stay.                                                                                                                                                                                                                                                                                                                                                                                              | The PRO coordinator's disconnect grace, retry and receiver fallback, and since 5B-G6 the PRO SFU subscriber's budget expiry (`'route'`)                                                                                                                                                                                            |
| Handoff        | `handOffTrustedSystemAudioReception()`                    | While the placeholder is up, interrupts under the slot deadline.                                                                                                                                                                                                                                                                                                                                                                                                                                              | The Standard SFU (a failed subscription with a pending READY; since 5B-G3 a failed re-subscription that attached nothing while the slot receives; or a direct call replacing it), behind its guest-role check                                                                                                                      |
| Expire         | `expireTrustedSystemAudioReception()`                     | Every registered `onDeadline` (one that throws is logged and the rest still run, as the bus contained a throwing listener), then the end, then the `receive_failed` notice.                                                                                                                                                                                                                                                                                                                                   | The slot deadline and the direct call's replacement watchdog, each after its warn line                                                                                                                                                                                                                                             |
| Detach         | `detachSystemAudioRoute(route)`                           | Drops that route's source and primer only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The routes' own cleanups                                                                                                                                                                                                                                                                                                           |
| Adopt          | `adoptSystemAudioReceiveRoute(route)`                     | Runs every other registered route's `retire`; changes nothing in the slot.                                                                                                                                                                                                                                                                                                                                                                                                                                    | The PRO coordinator: the room turning PRO and a retry's cleanup (until 5B-OV1 also every live reconcile, which had nothing to retire: a PRO room starts no Standard SFU subscription)                                                                                                                                              |
| End            | `endTrustedSystemAudioReception()`                        | See [End of reception](#end-of-reception).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The host STOP frame, `system-audio:force-stop` (the guest's listener), a Standard route's attach failure or call close, the Standard SFU cleanup after an attach and its READY after a direct-route failure (before the new start), the PRO coordinator's cleanup and, since 5B-G6, a PRO LAN-direct publisher's `'stopped'` close |

`getSystemAudioReceiveRouteSnapshot(route)` answers whether a route attached a
source and holds a primer: the `/debug` keys of both Standard routes, whether
the Standard SFU's cleanup ends the reception, and whether the PRO direct
receive deadline still has a failure to report.

`hasTrustedSystemAudioReception()` (since 5B-G4) answers whether the slot still
holds a reception: a start is claiming or holds its restore point, the
placeholder is the current meta, or the receiving flag is set. It is read-only.
The PRO coordinator asks it before it ends the slot over this device's own
publication (see [End of reception](#end-of-reception)).

## End of reception

`endTrustedSystemAudioReception()` runs in this order:

1. It consumes the restore point and moves the slot to `idle` with the next
   generation, so a nested or repeated end never replays an earlier snapshot.
   An end nested in a start before its placeholder claim consumes nothing
   (since 5B-G5, below).
2. It answers every trust-boundary waiter with false.
3. It reads whether the slot still holds the placeholder or the
   `'system-audio'` owner whose meta is not the sharer's (since 5B-G4), and
   clears the slot deadline.
4. It runs every registered `endReception` port. Only the direct call has one.
5. It drops the receiving flag.
6. Only while the slot still held the placeholder or that owner, it restores
   the title, releases the `'system-audio'` owner (forced for a placeholder)
   and sets playback idle. A newer playback owner keeps its title and
   lifecycle, and so does this device's own share (a `'system-audio'` owner
   with sharing meta, since 5B-G4).

A start runs `stopAllMedia` before it claims the placeholder, and while local
capture runs that emits `system-audio:force-stop`, whose guest listener ends
the reception inside the start. Since 5B-G5 (gap 7) such an end, nested in a
start (`claiming`) before its placeholder claim, ends what preceded that
start, not the start: the slot stays `claiming` with the start's generation
and restore point, so the start commits into `held`, its STOP or share end
restores what it took, and a trust-boundary wait opened after the nested end
joins the start. The nested end still does steps 2 to 5 (the waiters already
open are answered false, as before) and writes no title, releases nothing and
sets nothing idle, because the start claims the slot right after. An end that
lands once the start's placeholder is up (from a listener of the claim; none
is known) ends that start as any end does. Before 5B-G5 the nested end
consumed the start's restore point, so the start's own end left no title. On
LAN-direct the coordinator still arms its direct receive deadline after the
start returns, so the nested force-stop cannot clear it (kept).

The Standard SFU and the PRO coordinator register no `endReception`: an end
leaves their transports, sources and primers to their own cleanups. A failed
Standard SFU subscription (its subscribe with no pending READY, or its
subscriber PC) ends the reception only when it attached; since 5B-G3 one that
attached nothing while the slot receives, which continued a reception a
re-publication left playing, hands that reception off to the slot deadline
instead of leaving it playing in silence. Since
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

Since 5B-G6 (gaps 11 and 12) the coordinator hears two route closures that
reached nobody before:

- A LAN-direct publisher's `'stopped'` close (gap 11). A publisher sends
  `'stopped'` only from its explicit stop, before it releases the share, so
  the server's idle state follows one release and one refresh later (up to a
  15 s heartbeat when the invalidation is lost), and no later delivery exists
  for that publication. The transport closes the current receiver route, live
  or not, and calls the coordinator's `onLiveRouteStopped`; the coordinator
  checks the live direct publication (generation, publication id, remote
  owner, its own key), clears the direct receive deadline (the stop is no
  failure to report), detaches its route and ends the reception while the
  slot still holds one (`hasTrustedSystemAudioReception()`; the end leaves a
  successor alone). No notice. It keeps the publication key, so a heartbeat
  of the unchanged live state begins nothing again, and the post-share
  restore still follows the idle state, because the view drives it. An end,
  not an interrupt: an interrupt would keep the placeholder with receiving
  off, which shows the play button's loading spinner and reports the Media
  Session as paused on every listener until the idle state. `'superseded'`
  and a non-live `'fallback'` close the route only, as before.
- The PRO SFU subscriber's own budget expiry (gap 12). Every PRO SFU
  descriptor carries the share's live budget (`liveExpiresAt`, two hours,
  or the promotion's fresh budget after a direct-to-SFU promotion), and the
  subscriber stops itself there. The server ends the share at the same
  instant (its alarm) and the publisher's capture stops then, but the
  listener's timer needs no network hop, so it usually comes first: this is
  the normal end of every PRO SFU share that reaches its two-hour limit,
  promoted or not. It also comes earlier when the listener's clock runs
  ahead of the server's, and long before a late idle state (a lost
  invalidation, up to a 15 s heartbeat); when the idle state comes first,
  the coordinator's cleanup stops the subscriber and nothing below runs.
  Its `'stopped'` event carries the expired descriptor of the live remote
  publication; the coordinator then clears the disconnect grace, detaches
  its route and interrupts with `deadline: 'route'`, with no notice,
  keeping the placeholder and the key. The idle state then ends the
  reception with the post-share restore; when it is late, the next
  heartbeat's refused subscribe (one `connection_unstable` and the
  no-network backoff, unchanged) comes first. So at a two-hour end each
  SFU listener shows the pending state (the play button's loading spinner,
  the play icon off, the Media Session reporting paused) from its budget
  until the idle state, usually about a second; before 5B-G6 it showed the
  share playing in silence for that window. An interrupt, not an end: the
  stop is the listener's own clock reading the budget, not a publisher or
  server signal, so the view still holds the share live, and an end would
  need the 5B-G2 ended mark for an unchanged expired live state so that a
  late heartbeat would not show `connection_unstable` over an idle slot,
  which would change that pinned retry path. The coordinator's own
  subscriber stops carry an unexpired descriptor or another publication, or
  come after its cleanup cleared the key or its route end marked the
  publication ended, so they change nothing; a retry's cleanup of an
  expired subscription detaches and interrupts the same way itself. The
  device sheet has no two-hour share, so this is unit evidence only.

The `'system-audio'` owner is also the sharer's own claim
(`src/audio/system-capture.ts`, with sharing meta). Since 5B-G4 (gap 6) the
slot tells the two apart by that meta: the end leaves the sharer's claim to the
capture module (step 6), and the start never takes the sharer's meta as its
restore point, whether the share is still claimed or its transition teardown
left that title idle, so a received share never ends on "System Audio Sharing"
while idle. The rule is that narrow on purpose: any other state keeps its
handling. The PRO coordinator ends the slot over this device's own publication
only while the slot still holds a reception: `cleanupCoordinatorGraph` keeps
`playback.mode === 'system-audio'` and now reads
`!latestView.isLocalOwner || hasTrustedSystemAudioReception()`, so the guard
is unchanged for a listener's view. That
is the case of a sharing claim made while this device still receives: the end
drops the receiving flag and consumes the restore point under the claim. The
end's rule itself applies to every caller, a listener's view included: a
sharer's SFU publisher recovery releases the lease and acquires it again while
capture keeps sharing, and the release's idle view is not the local owner's, so
that cleanup runs the end over the capture's claim. Capture is not told during
that expected lease transition and claims nothing again after the re-commit.
Before 5B-G4 the end released the claim and set playback idle with no title for
the rest of the share; since 5B-G4 the sharer keeps its sharing title (pinned
after the 5B-G4 review). The
guard is kept because every reconcile of the own publication (each heartbeat)
runs the cleanup, and an unguarded end would bump the generation, cancel the
waiters, run the route ports and stamp the `/debug sa` cleanup time on every
heartbeat of a sharer. `resetProSystemAudioService` runs that cleanup before it
forgets the local owner.

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

The fence reads only the placeholder, not the slot's phase, which stays
`held` when a successor or a meta-null writer replaces the placeholder (and
before 5B-G5 a start that ran through a nested end left the phase `idle` over
its own placeholder). Two writers set the meta to null while a listener
receives (the PRO projection's `stopProjectedMedia` and the Standard guest's
current-item removal); in that window an attach or a resume is refused too,
and the sharer's own media stop ends the share within one round trip.

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

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Pinned by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fixed in 5B-G3: when the host published again while a guest received and the new subscription failed (its subscribe with no pending READY, or its subscriber PC), the guest stayed "playing" in silence, with no deadline and no notice, until STOP. The failed subscription that attached nothing while the slot receives now hands the reception off: the placeholder waits under the slot deadline, and a READY within it still attaches; otherwise `receive_failed` and the previous title.                                                                                                             | Standard "re-publication, fixed in 5B-G3: …", "5B-G3: an ICE failure of the re-subscription …" (two rows) and "5B-G3 guard: a READY inside the deadline …"                                                                                                                                                                                                                                                                                                                                                             |
| 2   | Fixed in 5B-G1: a successor owner that claimed playback while an attach waited in `initAudio()` (up to 500 ms) was overwritten by that attach, on all four routes. The fence now refuses the attach and the resume.                                                                                                                                                                                                                                                                                                                                                                                         | Standard "S9, fixed in 5B-G1: …" and "S9 (SFU), fixed in 5B-G1: …"; PRO group "successor during initAudio (attach fence, PRO routes; fixed in 5B-G1)"; `system-audio-guest.test.ts` group "attach fence: the slot ended or another owner plays (5B-G1)"                                                                                                                                                                                                                                                                |
| 3   | Fixed in 5B-G1: a force-stop while a PRO track waited in `initAudio()` still connected it under the restored title, on both PRO transports. The fence now refuses it.                                                                                                                                                                                                                                                                                                                                                                                                                                       | PRO "S8b, fixed in 5B-G1: …"; transport group "S8b: a slot end while the attach waits in initAudio (real PRO transports)"                                                                                                                                                                                                                                                                                                                                                                                              |
| 4   | Fixed in 5B-G2: a PRO force-stop ended only the placeholder: the coordinator's source, primer and subscription stayed until the room reset, and a retry in its backoff still subscribed. The coordinator's force-stop listener now ends its route and marks the publication ended (not a force-stop nested in its own start); the LAN-direct receiver route stays open.                                                                                                                                                                                                                                     | PRO "5B-G2 ($route): force-stop ends the PRO reception without a restore, …" (SFU and LAN-direct), "G6 and 5B-G2: a force-stop during a retry backoff …" and "5B-G2: a force-stop while a retry's subscribe is in flight …"; transport "S8b (SFU), fixed in 5B-G1: …" and "5B-G2 (SFU): a force-stop between the exposed track and the completed subscription …"                                                                                                                                                       |
| 5   | Fixed in 5B-G2: when another owner replaced the placeholder, a PRO SFU track was dropped at the trust boundary in silence, and its subscription stayed open with nothing attached until the publication changed. A refused SFU track (the boundary or the fence) now closes its subscription and marks the publication ended, with no notice.                                                                                                                                                                                                                                                               | PRO "trusted boundary, 5B-G2: …" and "S9 (SFU), fixed in 5B-G1: …"; transport "5B-G2 (SFU): a successor owner between the exposed track and the completed subscription …"                                                                                                                                                                                                                                                                                                                                              |
| 6   | Fixed in 5B-G4: when this device started sharing while it received, the receiving flag stayed set with no source and the restore point stayed held for a later end to replay over the sharing title. On its own publication the coordinator cleanup now ends the slot while the slot still holds a reception, and the end leaves the sharer's claim alone; a start never takes the sharer's title as its restore point. The same rule keeps a sharer's claim through its SFU publisher recovery (before, the release's idle view released it and left playback idle with no title while the share went on). | PRO "S11, fixed in 5B-G4: …", "begin re-entrancy: …", "5B-G4: a remote share that begins over an idle stale sharing title …", "5B-G4: a sharer whose view passes through idle while its capture still runs …" and the two "5B-G4 guard" rows; `system-audio-service.test.ts` "ends the reception in the coordinator cleanup while this device publishes only when the slot still holds one …" and "publisher recovery reaches the slot end through the release's idle view …"; `system-audio-guest.test.ts` 5B-G4 rows |
| 7   | Fixed in 5B-G5: a start that ran through a nested force-stop had its restore point emptied, so its STOP or share end left no title, and a trust-boundary wait opened after that nested end joined a generation no start commits. The nested end now keeps the start's claim, generation and restore point. Kept: on LAN-direct the direct receive deadline, armed after that start, survives the nested force-stop (one notice at 30 s, a late track still attaches).                                                                                                                                       | `system-audio-guest.test.ts` "keeps the start's restore point through a cleanup nested in the start, …", "answers a wait opened after a cleanup nested in the start with that start (5B-G5)" and "5B-G5 guard: an end inside the start once its placeholder is up ends that start"; PRO "begin re-entrancy: …" (the nested force-stop; since 5B-G4 its start takes no restore point over the sharer's title, so its result is unchanged); transport "begin re-entrancy (LAN-direct): …" (the deadline, kept)           |
| 8   | Notices differ per route: a Standard SFU live failure, a Standard direct call that closes while receiving and losing the host connection while receiving over the SFU all go idle with no notice; the Standard slot deadline shows `receive_failed`; PRO shows `connection_unstable`.                                                                                                                                                                                                                                                                                                                       | Standard "a live subscriber connection failure …"; lifecycle "expected today: the transport closing the direct call …" and "expected today: losing the host connection …"                                                                                                                                                                                                                                                                                                                                              |
| 9   | A PRO direct-to-SFU promotion runs the start again (pending, idle, pending, with `stopAllMedia` twice); the audible gap is not measured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | PRO "S7: a direct-to-SFU promotion moves the source without overlap and keeps the restore point"                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | Fixed in 5B-C4-13, outside the slot (RO-21): a share that ended while the page was hidden, after a failed first restore, prepared the same revision twice when the page was shown (the post-share restore, then the foreground repair queued behind it). A restore that applies while the page is shown, with no hide since it began, now marks that return reconciled, and the foreground repair settles without a second prepare. Kept: the opposite order (the restore fails after the show, the foreground repair applies, the restore retry arms again).                                               | `src/pro-room/__tests__/runtime-system-audio-join.test.ts` "F3, fixed in 5B-C4-13: …", "5B-C4-13: a post-share restore still running when the page is shown, …", the 5B-C4-13 guard rows and "5B-C4-13 residual, expected today: …"                                                                                                                                                                                                                                                                                    |
| 11  | Fixed in 5B-G6: a LAN publisher's 'stopped' close closed the route without telling the slot, so receiving and the source stayed until the server's idle state arrived. The transport now reports it and the coordinator ends the reception at once with the previous title (no notice; the publication key and the post-share restore on the idle state stay). 'superseded' still closes the route only.                                                                                                                                                                                                    | Transport "gap 11, fixed in 5B-G6: …", "5B-G6: a publisher close 'stopped' before any track …" and "5B-G6 guard: a publisher close 'superseded' …"; PRO "5B-G6: a publisher's 'stopped' close ends the reception …"; `pro-system-audio-direct.test.ts` "reports only a publisher's 'stopped' close of the current receiver route …"; `system-audio-service.test.ts` "clears the direct receive deadline on the live publisher's 'stopped' close …"                                                                     |
| 12  | Fixed in 5B-G6: a PRO SFU subscription ends itself at the share's live budget (its two-hour limit, promoted or not), usually just before the server's idle state, and the coordinator did not handle that 'stopped' event: "playing" in silence on a closed transport until the idle state. The expiry now detaches the source and interrupts with no notice: pending (spinner, Media Session paused) until the idle state, usually about a second. If the idle state is late, the next heartbeat still shows one `connection_unstable` and no-network retries until the share ends.                        | Transport "5B-G6: a plain share's two-hour end (no promotion) …", "two-hour budget re-publication case, gap 12 fixed in 5B-G6: …" and "5B-G6 guard: the subscriber stop the coordinator's own cleanups run …"                                                                                                                                                                                                                                                                                                          |
| 13  | A first Standard SFU subscription that fails with no pending READY is silent; the placeholder waits for the slot deadline and its `receive_failed`, and an unchanged READY subscribes again.                                                                                                                                                                                                                                                                                                                                                                                                                | Lifecycle "expected today: a failed first SFU subscription …" and "expected today: an unchanged READY after a failed subscription …"                                                                                                                                                                                                                                                                                                                                                                                   |
| 14  | A Standard direct call error while pending closes the call and ends the placeholder without `receive_failed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Lifecycle "expected today: a call error closes the call, …"                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

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
  retires it) and, since 5B-G4, the reception query; since 5B-G6 its row
  "clears the direct receive deadline on the live publisher's 'stopped' close
  and ends the reception only while the slot holds one (5B-G6)" pins the two
  parts of the gap 11 handler the transport suite cannot see (it reads no
  timer names, and the deadline callback returns by itself once the
  placeholder is gone);
- `src/network/__tests__/system-audio-host.test.ts` "keeps an opened direct
  call with no close or error for 60 s with no SFU handoff" (5B-G1): with the
  Standard suite's S9 row (the refused call stays open until STOP) it shows that
  a refused direct attach causes no host handoff;
- the Standard suite's "OV-B06 acceptance" rows (5B-OV2, pass before and
  after): the READY `{ audience: 'remote', handoffFromDirect: true }` that a
  host sends a failed-direct remote peer since 5B-OV2 (`'all'` before) is taken
  from the `'direct'` route and, after the host's STOP and START, from
  `'unselected'`; the guest freezes `'sfu-remote'`, subscribes and refuses a
  late direct call;
- `src/network/__tests__/protocol.test.ts` "system-audio START frame
  validation" and "rejects a READY without an audience (5B-OV3)": since
  5B-OV3 the slot's Standard inputs come only from a START with a bounded
  `surface` string (an unknown one reads as DISPLAY) and a READY with an
  `audience`;
- `src/network/__tests__/pro-system-audio-direct.test.ts` "reports only a
  publisher's 'stopped' close of the current receiver route …" (5B-G6): the
  transport's `onLiveRouteStopped` fires once for the current route, never for
  `'superseded'`, another negotiation or another sender, and sends no close
  back;
- the receive evidence-log suites named above;
- the resource-ownership guard (CHECK 4, 9 and 10), the import-graph guard
  (RULE D) and the dead-export guard;
- the local Playwright suite `e2e/system-audio-controls.test.ts` (Standard
  direct calls; outside CI by owner choice).

Real devices are outside these checks: the timing gaps above and the PRO
routes on real networks need device runs.
