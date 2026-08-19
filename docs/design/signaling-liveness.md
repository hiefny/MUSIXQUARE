# Standard-Host Signaling Liveness and Reclaim Safety

- **Status:** Accepted
- **Decision date:** 2026-08-20
- **Scope:** Standard-room host signaling only

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

## Unchanged policies

- UI layout, copy, and interaction flow are unchanged.
- Media loading remains best-effort until the browser/device itself fails.
- The 200 MiB limit remains a remote transfer/private-storage protocol ceiling, not a RAM
  admission limit.
- Existing CI and production release workflows remain unchanged.
