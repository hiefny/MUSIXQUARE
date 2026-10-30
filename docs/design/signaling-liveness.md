# Standard-Host Signaling Liveness and Reclaim Safety

- **Status:** Accepted
- **Decision date:** 2026-08-20
- **Scope:** Standard-room signaling and established RTC recovery
- **Recovery review:** 2026-09-20
- **Amended:** 2026-10-25, the link-liveness owner of established RTC recovery (Phase 4),
  including the isolated control side route's outage deadline (Phase 4 C5-9, train 4D);
  2026-10-26, the host probe and the ICE restart binding no longer read Worker or peer
  markers (old-version removal train 2); 2026-10-29, the initial SDP exchange and the restart
  answer no longer carry `iceRestartVersion`, and the Worker's peer-open no longer advertises the
  liveness protocol (old-version removal train 3)

## Problem

Windows Chromium can retain a dead signaling WebSocket in the `OPEN` state after the
network route disappears. The signaling Durable Object may already have observed the host
close and started its reclaim deadline while the browser has not emitted `close` or
`error`. During that gap, automatic recovery does not start and a room code can lose
its authenticated host epoch before the host knows it must reconnect.

## Decision

An authenticated Standard-room host monitors only its exact signaling WebSocket. After ten
seconds without any server traffic it sends one fixed application-level probe. Any ordinary
server frame or the fixed pong proves liveness. If eight more seconds pass without a response,
the exact socket generation is retired and the existing 1/2/4/8/15-second recovery loop
(`SIGNALING_RECOVERY_BACKOFF_MS` in `src/network/signaling-health.ts`) starts automatically.
Existing WebRTC data channels, playback, and system-audio media stay intact.

Every Durable Object answers the fixed probe: it uses `setWebSocketAutoResponse()` when
available, with an explicit local/test fallback. Since old-version removal train 2 (App build
floor 787, 2026-10-26) the host probes every admitted Standard host WebSocket without reading a
peer-open advertisement. Until train 3 (App build floor 789) deployed Workers carrying version
metadata still advertised protocol version 1 there; since then the version metadata adds only
`workerVersionId` to the peer-open. The HTTP bridge socket, guests and PRO rooms do not run the
periodic probe. Browser `offline` and `online` events are fast hints for the same Standard-host
recovery path.

Returning to the foreground also restarts an exhausted Standard-host signaling
budget, without replacing the room identity, RTC channels, or local playback.
This is necessary when Android blocks a background browser's network without
an `offline`/`online` event. An already running retry flight keeps its original
budget, and a terminated guest session is not silently revived.

On an Android 16 Pixel emulator with stock Chrome 151, local Web Audio playback
did not prevent the OS from marking Chrome's UID `APP_BACKGROUND` and denying
network traffic. YouTube playback in the same browser kept network access.
Media Session metadata and `playbackState` alone are therefore not evidence
that Web Audio has foreground media-service privileges. The foreground retry
fix restores the app-owned signaling recovery opportunity; it cannot promise
survival of an RTC connection that the OS has already terminated. Keep the
browser visible when uninterrupted Standard-room hosting is required. A native
file picker can also background the browser, so prepare local files before
inviting participants where possible. This observation does not establish identical behavior
on every physical Android device or installed PWA.

The Standard-host reclaim grace is extended from 60 to 120 seconds. New guests remain rejected
while no live host socket exists; the longer grace only preserves the authenticated host's
right to reclaim the same room epoch.

After an established host or guest starts a replacement signaling attempt, that
exact socket has eight seconds to reach authenticated admission. A socket stuck
in `CONNECTING`, or `OPEN` without `peer-open`, is retired so the bounded recovery
loop can try again. This deadline does not close surviving RTC channels. Initial
room admission retains its existing deadline and access checks.

## Established RTC recovery

### Explicit Standard-room expiry

Owner decision, 2026-10-24; ships with the Phase 3 app batch. A current Standard
guest signaling socket closed with exactly `1012 / ROOM_EXPIRED` ends automatic
signaling recovery for that admission. The provider retains this reason and the
existing `peer.ts` recovery owner cancels its pending retry. A stale socket's
close cannot expire its successor. An ordinary network close, another `1012`
reason, or `HOST_NOT_AVAILABLE` without an explicit expiry keeps the existing
bounded recovery policy. PRO behavior is unchanged.

Expiry of signaling admission does not close an existing RTC connection, stop
playback, or replace the playlist. The connection's existing liveness owner
still handles a later real data-channel failure. The Connect surface reports
that the room connection ended; a user can explicitly enter again. This is a
new admission, not an automatic recovery of the expired room. It intentionally
gives up the old automatic retry opportunity when a host returns only after the
120-second reclaim grace and creates another room at the same public code.

Entering again returns to the room's Start screen marked as a reconnect (owner
decision, 2026-10-24), like the `HOST_DISCONNECTED` reconnect and the
service-worker update return. Expiry means the host stayed away past its grace,
so if the host is still missing the join fails with "host left" rather than
asking the user to check a code they never typed. Account activity statistics
count the entry as a continuing session, as they do for those two returns.

Internal diagnostics retain only recognized close reasons, recovery phase and
whether a data connection survived. Unrecognized reason text is not copied into
diagnostics. The recognized list names reasons the signaling Worker sends with
`1012`, pinned by a source parity test; other real Worker reasons stay
`unknown` while the list lives in the eager bundle. The server's aggregate
host-missing subcounters describe observed host state, not user intent or
network root cause. See the
[Phase 3 evidence](phase3-update-and-expiry-recovery-2026-10-24.md) and
[admin metric definitions](../../cloudflare/admin-dashboard-ops.md).

### Ordinary connection recovery

Signaling and RTC have separate lifecycles. A signaling socket closing is not proof that
an existing peer's audio or data channel failed, nor is it an intentional idle shutdown.
The browser reports the signaling interruption with its role and surviving channel count;
the provider separately records socket close and host liveness-probe failures. These records
locate the failed layer without claiming a network or server root cause from a warning alone.

Since old-version removal train 2 (App build floor 787, 2026-10-26) neither end reads an
`iceRestartVersion: 1` mark on the first offer or answer: every Standard end since 8.6.39 can
restart, and the floor admits none older. Since train 3 (App build floor 789) a Standard client
marks neither the first offer nor any answer; an end before train 3 still marks them, and the
signaling Worker relays both forms. The restart offer still carries the mark with `restartOf`,
which the host and the signaling Worker require. A guest can restart ICE on the existing peer
connection, including after a host network change, using `restartOf` to bind the offer to that
exact initial negotiation. The host's authenticated signaling route, member identity, departure
sequence, and live connection ownership remain mandatory. Recovery does not rejoin the room,
replace its data channels, or bypass access checks. PRO retains its existing recovery path.

TURN credentials retain their absolute expiry even when reused from the
page-scoped cache. Before expiry, the transport requests fresh credentials with
an eight-second deadline, applies them with `setConfiguration()` to its owned
peer connections, and retains them for subsequent offers and ICE restarts.
Foreground recovery also checks freshness after suspended browser timers. A
failed renewal retries without closing a healthy channel; teardown aborts and
fences late results. This follows the provider's
[credential-refresh guidance](https://developers.cloudflare.com/realtime/turn/generate-credentials/);
continuous relay allocation survival over a physical 48-hour session is a
separate manual verification item, not a claim established by fake-clock tests.

One interruption has a non-renewing 15-second transport grace (`RTC_INTERRUPTION_GRACE_MS` in
`src/core/constants.ts`). Since Phase 4 (2026-10-25) one owner per Cloudflare logical data
connection (Standard and PRO rooms alike), `LinkLiveness` in `src/network/transport/link-liveness.ts` (registry RO-15), holds
that grace, its published wall-clock deadline, the one-restart gate and the guest
background-resume probe, and every close of the connection goes through it with a cause (see
[Realtime runtime ownership](realtime-runtime-ownership.md)). Since C5-9 (train 4D) it also
holds the isolated control side PC's outage deadline: 15 seconds per outage, waiting while the
original route is down, re-armed to 15 seconds once it recovers and never past 30 seconds from
the outage's start, on the monotonic clock. The side route keeps its ICE restart protocol and
its own 15-second request and 30-second offer windows, and that outage never counts as an
interruption of the original route, so it neither moves the published deadline nor pauses bulk
or preload (see
[Control isolation side ICE restart](control-isolation-side-ice-restart-2026-10-19.md)). The
host heartbeat monitor respects the original route's exact owner-published deadline, read
through `src/network/transport-health.ts`, only while both channels are still open, so its
ordinary failed-ICE threshold cannot prematurely consume the recovery window. Expired grace or closed channels still close the
connection, through that owner. A recovered path or selected-candidate-pair
change invalidates the old local/remote classification before an asynchronous recheck, with
generation guards against stale results. Existing per-transfer delivery decisions stay frozen;
a new transfer must wait for evidence about the new path.

Local/remote describes the selected ICE path, not the Wi-Fi network name. A host/host pair
is required to prove direct local routing. Router isolation, NAT, VPNs, or incomplete browser
evidence may therefore produce a remote classification on the same Wi-Fi. Recovery must not
grant local transfer privileges from an SSID or reuse the previous path's classification.

Standard classification also handles Chromium retaining a native host/prflx snapshot after
the signaled remote host candidate refines the selected connection. It accepts that refinement
only when one transport explicitly selects a succeeded host/host statistics pair and both
endpoint ports and protocols match; addresses, the local foundation and ICE username fragments
are compared only where both sides expose them. The native prflx address is always redacted, so
the remote side of the match rests on port, protocol and, when exposed, the username fragment;
missing ports or protocols are not accepted. The exact connection, ICE transport, and native pair's
endpoint/generation fields must remain unchanged while statistics are read. An unselected or
merely nominated host pair cannot establish this proof. Other native remote candidate types
retain conservative classification. The refinement check lives in
`src/network/ice-selected-pair.ts`; the PRO direct-audio rule uses the same check and adds its
own mDNS candidate ledger and address rule, and waits (never refuses at once) while the pair is
unrefined.

These bounds improve recoverability; they do not guarantee uninterrupted playback across
Wi-Fi/cellular handoff or an operating-system suspension. Terminal guest-disconnect UI stops
every media source and cancels pending file loads before showing the dialog.

## Clock sampling under file traffic

The guest clock retains its established low-RTT samples when one delayed ping or pong has
an offset jump explainable by network timing. Clock-step detection must exceed the two
samples' half-RTT uncertainty plus the existing two-second threshold before discarding them.
Replies older than five seconds expire on receipt even if background timers prevented the
next ping's cleanup. This prevents asymmetric file-transfer queueing from manufacturing a
clock jump and an unnecessary hard playback correction. It does not claim to explain every
reported drift without an incident trace.

## Unchanged policies

- UI layout, copy, and interaction flow are unchanged.
- Media loading remains best-effort until the browser/device itself fails.
- The 200 MiB limit remains a remote transfer/private-storage protocol ceiling, not a RAM
  admission limit.
- Existing CI and production release workflows remain unchanged.
