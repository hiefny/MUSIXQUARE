# MUSIXQUARE

**Multi-Device Synchronized Audio System**

MUSIXQUARE is a web app that turns phones, tablets, and desktops into a synchronized wireless audio system. It supports local-room playback, remote file sharing, YouTube Together, and desktop system audio sharing through WebRTC.

**https://musixquare.com/about**

**Source code:** https://github.com/hiefny/MUSIXQUARE

---

## OpenAI Build Week 2026

MUSIXQUARE existed before OpenAI Build Week. This submission is based on the
meaningful extensions I developed with Codex and GPT-5.6 during the official
submission period, rather than on the pre-existing product alone.

### Build Week Baseline and Evidence

- **Pre-event baseline:** [`0483a000`](https://github.com/hiefny/MUSIXQUARE/commit/0483a000d8d745cab9e7091a83199a7ebdc32375)
- **Build Week changes:** [`0483a000...main`](https://github.com/hiefny/MUSIXQUARE/compare/0483a000d8d745cab9e7091a83199a7ebdc32375...main)
- **Development period:** July 14–21, 2026 KST
- **Primary Codex `/feedback` session:** `019f495f-b46e-7ad1-966b-9dfe679c5321`

### What I Built During Build Week

The largest extension was a persistent PRO room architecture. Before Build
Week, rooms were temporary and coordinated by a host browser. During the event,
I added stable room identities, private media storage, durable playlists,
repeat and shuffle persistence, participant presence, server-owned playback
authority, and recovery from sleeping or disconnected clients.

I also added room-scoped Developer APIs for queue management, playback, and
audio effects; optional account identity with account-bound permissions;
collaborative playlist controls; remote-media preloading; global drag-and-drop
media loading; media delivery designed for rooms of up to 100 connected
devices; safer reconnect identities; atomic session resets; more reliable
YouTube transitions and rendezvous timing; locale-aware pluralization; and
clearer real-time interface feedback.

Behind the product, I built release manifests, deployment-state verification,
live signaling and reconnection smoke tests, Cloudflare configuration
safeguards, rollback procedures, and extensive unit and end-to-end regression
coverage.

### How I Collaborated With Codex and GPT-5.6

I used Codex powered by GPT-5.6 as an engineering partner throughout the full
development cycle: analyzing the real-time architecture, designing system
boundaries, implementing features, tracing asynchronous failures, building
regression tests, auditing security assumptions, and validating production
deployments.

Codex accelerated implementation, review, testing, and the investigation of
complex edge cases across the browser, Web Audio, WebRTC, Cloudflare Workers,
Durable Objects, D1, R2, and the production release pipeline. I reviewed the
proposed changes, chose the product scope, defined the authority and privacy
boundaries, rejected or revised unsuitable approaches, and made the final
product, engineering, and design decisions.

---

## Open Source

MUSIXQUARE is open-source software licensed under the **GNU Affero General Public License v3.0 or later** (`AGPL-3.0-or-later`).

You may run, study, modify, and share the source code under the license terms. Because MUSIXQUARE is a networked web application, if you run a modified network-accessible version, the AGPL requires you to make the corresponding source code available to users of that version.

The public repository does not include production secrets, API keys, TURN
credentials, Cloudflare account credentials, or other private deployment
material. Use the tracked Wrangler structure (and the remote-share example)
as a reference, then configure sensitive values through your own Worker
secrets.

---

## Features

- **6-Digit Code Join**: Guests enter a short code to connect instantly.
- **Speaker Role Routing**: Each device picks its role: Center (stereo), Left,
  Right, or Subwoofer.
- **Local File Sharing**: Host sends audio files directly to nearby guests when
  a direct WebRTC path is available. Precise sync supported. Local video files
  are rejected; video playback uses the YouTube path.
- **Remote File Sharing**: Remote guests can receive temporary file handoffs
  through private Cloudflare-backed storage with participant-authorized
  downloads. The 200 MiB figure is the remote wire/storage ceiling. The legacy
  AudioBuffer engine does not pre-reject files from a predicted device-memory
  budget; transfer and native decode are attempted on a best-effort basis. A
  browser may still reject an allocation or terminate a memory-constrained tab.
- **YouTube Together**: Watch together with synced playback. Works across different networks.
- **System Audio Sharing**: Stream desktop or tab audio to connected devices in real-time stereo.
- **Audio Effects**: 5-band EQ, reverb, stereo widener, virtual bass, all processed locally via Web Audio API.
- **Chat**: Real-time P2P messaging with commands, whisper, and moderation.
- **Precision Sync**: NTP-style rolling RTT measurement with min-latency selection for file mode. 2-stage rendezvous-synchronized playback for YouTube mode.

---

## Tech Stack

- **TypeScript + Vite**: ES modules, strict mode, hot module replacement.
- **Web Audio API**: Native browser audio graph, no external audio library.
- **WebRTC Transport**: Data channels for control, chat, sync, and file transfer. Media streams for system audio.
- **Cloudflare Signaling**: Durable Object signaling transport for production room connection and raw WebRTC negotiation.
- **PeerJS Local Adapter**: PeerJS remains available for localhost and explicit
  local-development configurations. Public production hosts force the
  Cloudflare signaling transport; there is no automatic production failover
  to PeerJS.
- **Remote Share Worker**: Cloudflare Worker + private R2 path for temporary,
  participant-authorized remote file sharing.
- **STUN + TURN**: Browser ICE with Cloudflare TURN support.
- **RAM-only media storage**: Local playback buffers and received chunks stay
  in browser memory. Practical file capacity is device- and codec-dependent.

The production browser-media storage boundary and the conditions for revisiting
OPFS are documented in [the RAM-only storage ADR](./docs/design/browser-media-storage-policy.md).

---

## Environment Variables

Server-only variables are configured as Cloudflare Worker secrets
(`wrangler secret put ...`) on the Worker that consumes them; do not copy them
into browser build variables.

The capability-token signing secret and Cloudflare TURN credentials are
required for the protected production paths. The YouTube API key is required
when server-side search is enabled, and Cloudflare Realtime credentials are
required only for the remote system-audio SFU path. Turnstile keys are required
only when Turnstile is enabled. Keep all API keys and signing secrets
server-only.

Security-sensitive backend endpoints fail closed unless capability-token protection is configured. Unguarded fallback flags are for local/emergency use only and must stay disabled in production.

Current production policy keeps Turnstile disabled. Capability tokens remain
IP-bound and paid endpoints remain rate-limited. Token minting uses a
short-lived, scope/IP-bound proof-of-work challenge; Origin, Sec-Fetch, and Host
headers are CORS/routing signals and never authenticate capability issuance.

Do not expose the YouTube key as a `VITE_` variable; Vite variables are bundled into browser code.

---

## How to Use

**https://musixquare.com**, no install needed.

### Host

1. Open the app and tap **"I'll host"**
2. Share the **6-digit code** with guests
3. Choose a media source:
   - **Load local file**: audio from your device
   - **YouTube**: paste a video link, playlist URL, or search term
   - **System Audio**: stream desktop, tab, or system audio from a supported browser

### Guest

1. Open the app and tap **"Join a session"**
2. Enter the **6-digit code**
3. Join as the default Center speaker. After joining, use Settings to change
   the device to Left, Right, or Subwoofer when needed.

For the lowest latency and strongest sync, keep devices on the same local network. Remote connections are supported, but the transport path depends on browser and network conditions.

---

## Related Pages

- **App**: https://musixquare.com/
- **About**: https://musixquare.com/about
- **History**: https://musixquare.com/history
- **Design System**: https://musixquare.com/designsystem
- **Source**: https://github.com/hiefny/MUSIXQUARE
- **Repository documentation**: [docs/README.md](./docs/README.md)

---

## License

Copyright (c) 2025-2026 MUSIXQUARE.

MUSIXQUARE is free software licensed under the **GNU Affero General Public License v3.0 or later**. See [LICENSE](./LICENSE).

## Third-Party Licenses

- **PeerJS**: MIT License
- **qrcode** and **content-shield**: MIT License; see
  [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
- **Google Material Icons** (selected inline SVG paths): Apache License 2.0;
  see [the distributed license text](./public/licenses/material-icons-apache-2.0.txt).
- **Pretendard** (font): SIL Open Font License 1.1, see
  [PRETENDARD_LICENSE.txt](./fonts/PRETENDARD_LICENSE.txt).
- **Noto Sans JP/SC/TC/Thai/Cyrillic** (fonts): SIL Open Font License 1.1, see
  [the CJK license](./fonts/NOTO_CJK_LICENSE.txt),
  [the Thai license](./fonts/NOTO_THAI_LICENSE.txt), and
  [the Noto Sans license](./fonts/NOTO_SANS_LICENSE.txt).
