# Standard-Host Signaling Liveness and Reclaim Safety

- **Status:** Accepted
- **Decision date:** 2026-08-20
- **Scope:** Standard-room signaling and established RTC recovery
- **Recovery review:** 2026-09-18

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
the exact socket generation is retired and the existing 1/2/4/8/15-second recovery loop starts
automatically. Existing WebRTC data channels, playback, and system-audio media stay intact.

The Worker advertises protocol version 1 only from deployed Workers carrying version metadata.
Durable Objects use `setWebSocketAutoResponse()` when available, with an explicit local/test
fallback. Guests and PRO rooms do not run the periodic probe. Browser `offline` and `online`
events are fast hints for the same Standard-host recovery path.

The Standard-host reclaim grace is extended from 60 to 120 seconds. New guests remain rejected
while no live host socket exists; the longer grace only preserves the authenticated host's
right to reclaim the same room epoch.

## Established RTC recovery

Signaling and RTC have separate lifecycles. A signaling socket closing is not proof that
an existing peer's audio or data channel failed, nor is it an intentional idle shutdown.
The browser reports the signaling interruption with its role and surviving channel count;
the provider separately records socket close and host liveness-probe failures. These records
locate the failed layer without claiming a network or server root cause from a warning alone.

Updated Standard clients advertise `iceRestartVersion: 1` in the initial SDP exchange.
Both ends must support it. A guest can then restart ICE on the existing peer connection,
including after a host network change, using `restartOf` to bind the offer to that exact
initial negotiation. The host's authenticated signaling route, member identity, departure
sequence, and live connection ownership remain mandatory. Recovery does not rejoin the room,
replace its data channels, or bypass access checks. PRO retains its existing recovery path;
older clients retain their previous failure handling.

One interruption has a non-renewing 15-second transport grace. The host heartbeat monitor
respects this exact provider-owned deadline only while both channels are still open, so its
ordinary failed-ICE threshold cannot prematurely consume the recovery window. Expired grace
or closed channels still terminate the connection. A recovered path or selected-candidate-pair
change invalidates the old local/remote classification before an asynchronous recheck, with
generation guards against stale results. Existing per-transfer delivery decisions stay frozen;
a new transfer must wait for evidence about the new path.

Local/remote describes the selected ICE path, not the Wi-Fi network name. A host/host pair
is required to prove direct local routing. Router isolation, NAT, VPNs, or incomplete browser
evidence may therefore produce a remote classification on the same Wi-Fi. Recovery must not
grant local transfer privileges from an SSID or reuse the previous path's classification.

Standard classification also handles Chromium retaining a native host/prflx snapshot after
the signaled remote host candidate refines the selected connection. It accepts that refinement
only when one transport explicitly selects a succeeded host/host statistics pair, both endpoint
ports and protocols match, and any visible addresses, local foundation, and ICE username
fragments agree. Browser-redacted addresses are unavailable for comparison; missing ports or
protocols are not accepted. The exact connection, ICE transport, and native pair's
endpoint/generation fields must remain unchanged while statistics are read. An unselected or
merely nominated host pair cannot establish this proof. Other native remote candidate types
retain conservative classification; the PRO direct-audio policy is separate.

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
