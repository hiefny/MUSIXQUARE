# MUSIXQUARE

**Multi-Device Synchronized Audio System**

MUSIXQUARE is a web app that turns multiple devices into a synchronized wireless audio system. Connect phones, tablets, and desktops on the same network to create surround sound — or use YouTube Together across any network.

**https://musixquare.com**

---

## Features

- **6-Digit Code Join**: Guests enter a short code to connect instantly.
- **Speaker Role Routing**: Each device picks its role — Stereo, Left, Right, or Subwoofer.
- **Local File Sharing**: Host sends audio/video files directly to guests via P2P. Precise sync supported.
- **YouTube Together**: Watch together with synced playback. Works across different networks.
- **System Audio Sharing**: Stream desktop audio to connected devices in real-time stereo. Windows/Mac Chrome only.
- **Audio Effects**: 5-band EQ, reverb, stereo widener, virtual bass — all processed locally via Web Audio API.
- **Chat**: Real-time P2P messaging with commands, whisper, and moderation.
- **Precision Sync**: NTP-style rolling RTT measurement with min-latency selection for file mode. Countdown-synchronized simultaneous playback for YouTube mode.

---

## Tech Stack

- **TypeScript + Vite**: ES modules, strict mode, hot module replacement.
- **Web Audio API**: Native browser audio graph — no external audio library.
- **PeerJS (WebRTC)**: P2P data channels for file transfer, media streams for system audio.
- **STUN + TURN**: Google STUN for NAT traversal. Metered.ca TURN via Netlify Function for remote connections.
- **OPFS**: Origin Private File System for efficient local media storage.

---

## Getting Started

### Live Version (Recommended)

**https://musixquare.com** — no install needed.

### Local Development

```bash
npm install
npm run dev
```

> Requires HTTPS or `localhost` for WebRTC, Service Worker, and OPFS.

---

## How to Use

### Host

1. Open the app and tap **"I'll host"**
2. Share the **6-digit code** with guests
3. Choose a media source:
   - **Load local file** — audio/video from your device
   - **YouTube** — paste a link or playlist URL
   - **System Audio** — stream your desktop audio (Windows/Mac Chrome)

### Guest

1. Open the app and tap **"Join a session"**
2. Enter the **6-digit code**
3. Select your speaker role (Stereo / Left / Right / Woofer)

---

## Deployment

- **Hosting**: Netlify (auto-deploys from `main` branch)
- **Build**: `npm run build` → `dist/`
- **TURN Server**: Netlify Function (`netlify/functions/get-turn-config.js`) with Metered.ca credentials
- **Font**: Pretendard self-hosted (`css/pretendard.css` + `fonts/`)
- **PWA**: `manifest.webmanifest` + `service-worker.js` included

---

## License

All Rights Reserved. See [LICENSE](./LICENSE).

## Third-Party Licenses

- **PeerJS** — MIT License
- **Pretendard** (font) — SIL Open Font License 1.1 — see `fonts/PRETENDARD_LICENSE.txt`
