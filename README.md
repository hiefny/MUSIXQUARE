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
- **Per-Device Output Routing**: Every device starts in Stereo and can switch to Left, Right, or Subwoofer at any time in Settings.
- **Local File Sharing**: Host sends audio files directly to nearby guests when a direct WebRTC path is available. Precise sync supported.
- **Remote File Sharing**: Remote guests receive end-to-end encrypted temporary file handoffs. Current clients upload ciphertext directly from the browser to Cloudflare R2 without a 64 MiB product cap.
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
- **PeerJS Alternate Transport**: PeerJS is available for local development or explicitly configured deployments. It is not an automatic runtime failover from Cloudflare signaling.
- **Remote Share Worker**: Cloudflare Worker issues scoped multipart sessions, while encrypted part bodies upload directly from the browser to R2.
- **STUN + TURN**: Browser ICE with Cloudflare TURN support and optional Metered fallback.
- **Bounded large-file handling**: No media path uses a persistent browser file system. The host encrypts and uploads one 8 MiB record at a time; guests authenticate and decrypt only the ranges requested by `HTMLAudioElement`. Audio that exceeds the decoded PCM budget also uses `MediaElementAudioSourceNode` locally.

---

## Environment Variables

Server-only variables are configured as Cloudflare Worker secrets (`wrangler secret put ...`) bound to the app worker.

Required production secrets include the YouTube API key, Cloudflare TURN/Realtime credentials, and `MXQR_CAPABILITY_SECRET`. Turnstile keys are optional and are needed only if Turnstile is explicitly enabled. Keep all API keys and signing secrets server-only.

Security-sensitive backend endpoints fail closed unless capability-token protection is configured. Unguarded fallback flags are for local/emergency use only and must stay disabled in production.

The checked production configuration keeps Turnstile disabled. Paid API access is instead protected by a short-lived HMAC-signed proof-of-work challenge bound to the client IP and requested scope, solved asynchronously without a user prompt. Capability tokens and per-IP rate limits remain mandatory; an `Origin` header by itself is never accepted as authorization.

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
3. Playback starts in Stereo. Change the device output to Left / Right / Woofer in **Settings** when needed.

For the lowest latency and strongest sync, keep devices on the same local network. Remote connections are supported, but the transport path depends on browser and network conditions.

### Remote File Size and Compatibility

Protocol v4 removes the old 64 MiB product limit and accepts plaintext files up to exactly 5 GiB (5,368,709,120 bytes). It maps each independently authenticated 8 MiB record to one R2 multipart part, so neither encryption nor playback creates a whole-file temporary copy. Deployments may configure a lower limit.

Tabs still running legacy clients retain their previous behavior until they refresh. V2 remains capped at 64 MiB through the Worker and v3 remains available during rolling deployment; refreshed clients use direct multipart upload and range playback.

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
