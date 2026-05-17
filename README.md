# MUSIXQUARE

**Multi-Device Synchronized Audio System**

MUSIXQUARE is a web app that turns phones, tablets, and desktops into a synchronized wireless audio system. It supports local-room playback, remote file sharing, YouTube Together, and desktop system audio sharing through WebRTC.

**https://musixquare.com/about**

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
- **RAM-first playback**: Local playback buffers and received chunks stay in browser memory.

---

## Environment Variables

Server-only variables are configured as Cloudflare Worker secrets (`wrangler secret put ...`) bound to the app worker.

- `YOUTUBE_API_KEY`: YouTube Data API v3 key used by `/api/youtube-search`.
- `YOUTUBE_SEARCH_MAX_RESULTS` (optional): Search result count, capped at 12. Default is 10.
- `YOUTUBE_REGION_CODE` (optional): Two-letter region bias such as `KR`.
- `YOUTUBE_RELEVANCE_LANGUAGE` (optional): Language bias such as `ko`.
- `MXQR_CAPABILITY_SECRET` (optional): Enables short-lived signed capability tokens for paid-resource endpoints (`/api/get-turn-config`, `/api/cloudflare-realtime`, `/api/youtube-search`).
- `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (optional): Require Cloudflare Turnstile before minting capability tokens. Keep the secret key server-only.
- `MXQR_CAPABILITY_TTL` (optional): Capability-token lifetime in seconds, clamped from 60 to 1800. Default is 600.
- `MXQR_ALLOW_INFERRED_CAPABILITY_FALLBACK` (optional): Set to `true` only if you deliberately need the legacy no-Origin/no-Sec-Fetch same-origin fallback for old WebViews. Default is disabled.

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

---

## License

All Rights Reserved. See [LICENSE](./LICENSE).

## Third-Party Licenses

- **PeerJS**: MIT License
- **Pretendard** (font): SIL Open Font License 1.1, see `fonts/PRETENDARD_LICENSE.txt`
