# MUSIXQUARE

**Multi-Device Synchronized Audio System**

MUSIXQUARE is a web app that turns phones, tablets, and desktops into a synchronized wireless audio system. It supports local-room playback, remote file sharing, YouTube Together, and desktop system audio sharing through WebRTC.

**https://musixquare.com/about**

**Source code:** https://github.com/hiefny/MUSIXQUARE

---

## Open Source

MUSIXQUARE is open-source software licensed under the **GNU Affero General Public License v3.0 or later** (`AGPL-3.0-or-later`).

You may run, study, modify, and share the source code under the license terms. Because MUSIXQUARE is a networked web application, if you run a modified network-accessible version, the AGPL requires you to make the corresponding source code available to users of that version.

The public repository does not include production secrets, API keys, TURN credentials, Cloudflare account credentials, or other private deployment material. Use the example environment files and configure sensitive values through your own deployment secrets.

---

## Features

- **6-Digit Code Join**: Guests enter a short code to connect instantly.
- **Speaker Role Routing**: Each device picks its role: Stereo, Left, Right, or Subwoofer.
- **Local File Sharing**: Host sends audio/video files directly to nearby guests when a direct WebRTC path is available. Precise sync supported.
- **Remote File Sharing**: Remote guests can receive encrypted temporary file handoffs through Cloudflare-backed storage.
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
- **PeerJS Fallback**: PeerJS remains available as a fallback transport and for local development when no Cloudflare signaling URL is configured.
- **Remote Share Worker**: Cloudflare Worker + R2 path for encrypted temporary remote file sharing.
- **STUN + TURN**: Browser ICE with Cloudflare TURN support and optional Metered fallback.
- **RAM-only media storage**: Local playback buffers and received chunks stay in browser memory.

The production browser-media storage boundary and the conditions for revisiting
OPFS are documented in [the RAM-only storage ADR](./docs/design/browser-media-storage-policy.md).

---

## Environment Variables

Server-only variables are configured as Cloudflare Worker secrets (`wrangler secret put ...`) bound to the app worker.

Required production secrets include the YouTube API key, Cloudflare TURN/Realtime credentials, the capability-token signing secret, and Cloudflare Turnstile keys. Keep all API keys and signing secrets server-only.

Security-sensitive backend endpoints fail closed unless capability-token protection is configured. Unguarded fallback flags are for local/emergency use only and must stay disabled in production.

Turnstile can stay disabled as a product policy while traffic is low-risk, but capability tokens and per-IP rate limits must remain enabled. In that mode, only the explicit trusted-origin capability fallback is allowed.

Do not expose the YouTube key as a `VITE_` variable; Vite variables are bundled into browser code.

---

## How to Use

**https://musixquare.com**, no install needed.

### Host

1. Open the app and tap **"I'll host"**
2. Share the **6-digit code** with guests
3. Choose a media source:
   - **Load local file**: audio/video from your device
   - **YouTube**: paste a video link, playlist URL, or search term
   - **System Audio**: stream desktop, tab, or system audio from a supported browser

### Guest

1. Open the app and tap **"Join a session"**
2. Enter the **6-digit code**
3. Select your speaker role (Stereo / Left / Right / Woofer)

For the lowest latency and strongest sync, keep devices on the same local network. Remote connections are supported, but the transport path depends on browser and network conditions.

---

## Related Pages

- **App**: https://musixquare.com/
- **About**: https://musixquare.com/about
- **History**: https://musixquare.com/history
- **Design System**: https://musixquare.com/designsystem
- **Source**: https://github.com/hiefny/MUSIXQUARE

---

## License

Copyright (c) 2025-2026 MUSIXQUARE.

MUSIXQUARE is free software licensed under the **GNU Affero General Public License v3.0 or later**. See [LICENSE](./LICENSE).

## Third-Party Licenses

- **PeerJS**: MIT License
- **Pretendard** (font): SIL Open Font License 1.1, see `fonts/PRETENDARD_LICENSE.txt`
- **Noto Sans JP/SC/TC/Thai/Cyrillic** (fonts): SIL Open Font License 1.1, see the Noto license files under `fonts/`
