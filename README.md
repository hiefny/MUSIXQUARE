# MUSIXQUARE 🎵

**Multi‑Device Synchronized Surround Audio (Toss In‑App Build)**

MUSIXQUARE is a web-based party app that turns multiple devices on the **same local network (same Wi‑Fi / hotspot)** into a single synchronized audio system.

> This repository version is refactored for **Toss In‑App** release constraints:
> - **No external link/QR onboarding**
> - **Local network only (no TURN / no relay)**
> - **Short 6‑digit code** to connect
> - **Direct host connections only (configurable guest device limit)**

---

## ✨ Key Features

- **🔢 Short Code Join (In‑App Safe)**: Guests type a **6‑digit code** shown on the host device.
- **📡 Local Network Only**: Designed for **same Wi‑Fi / same hotspot**.
- **🔌 Direct Host Connections (Stable)**: Host connects directly to multiple guest devices (configurable in Settings/Connect tab).
- **🔊 Role‑based Routing**: Guests choose their output role when joining (Original / Left / Right / Woofer).
- **🎥 YouTube + Local Files**: Host can load local files or add a YouTube link (within in‑app constraints).
- **🛠️ Pro Audio Engine**: Mixing / FX powered by Tone.js.

---

## 🛠️ Technology Stack

- **Tone.js**: Web Audio engine (FX / mixing)
  - Self-hosted (vendored) at `vendor/Tone.js`
- **PeerJS**: WebRTC P2P networking for low‑latency messaging
  - Self-hosted (vendored) at `vendor/peerjs.min.js`
- **OPFS (Origin Private File System)**: Efficient local storage for large media (where supported)

---

## ✅ Requirements / Notes

- **Secure context required** (HTTPS or `localhost`) for WebRTC / Service Worker / OPFS.
- This build **does not use STUN/TURN** and is intended for **LAN usage**.

---

## 🚀 Getting Started (Local Dev)

> Opening via `file://` may break features (Service Worker / OPFS / WebRTC).

### Option A) Python

```bash
python -m http.server 5173
```

Open:

- `http://localhost:5173/`

### Option B) VSCode Live Server

Use the VSCode **Live Server** extension.

---

## 📖 How to Use

> NOTE: The demo track filename is provided as `demo_track.mp3` for URL and server compatibility.

### Host

1. Open the app and tap **“I'll host”**
2. The app shows a **6‑digit code**
3. Guests enter the code, then select their role on their device (Original / Left / Right / Woofer).
4. Once ready, the host immediately sees 3 options:
   - **Load local file**
   - **Enter YouTube link**
   - **Try it (Demo)**

### Guest

1. Open the app and tap **“Join a session”**
2. Enter the **6‑digit code** shown on the host
3. Wait until the system starts (host finishes connecting devices)

---

## 🌐 Deployment

This project is a static web app (HTML/CSS/JS).

- **Core libs are self-hosted**: Tone.js and PeerJS are included in the repo under `vendor/` for self-hosting / offline-first deployments.
- **UI font (Pretendard)**: Loaded from **local self-hosted files** (`css/pretendard.css` + `fonts/`).
  - License is included at `fonts/PRETENDARD_LICENSE.txt`.
- For Toss In‑App release, it is intended to be served from **Toss infrastructure** (no Netlify dependencies).

---

## 📲 PWA

- `manifest.webmanifest` and `service-worker.js` are included.
- Service worker is registered from `js/app.js` on secure contexts.

## 📄 Third‑Party Licenses

This repo vendors (self-hosts) the following third-party libraries for offline/self-hosted deployments:

- **Tone.js** — MIT License — see `vendor/Tone.js.LICENSE.txt`
- **PeerJS** — MIT License — see `vendor/peerjs.LICENSE.txt`

Fonts:

- **Pretendard** — SIL Open Font License 1.1 — see `fonts/PRETENDARD_LICENSE.txt`

## Maintenance notes

### Pretendard self-hosting (no CDN)

This repo is configured to load Pretendard from **local files** (`css/pretendard.css` + `fonts/`).

To download the font files into the project:
- macOS/Linux: `./scripts/fetch-pretendard.sh`
- Windows (PowerShell): `./scripts/fetch-pretendard.ps1`

(License is included at `fonts/PRETENDARD_LICENSE.txt`.)

### Debug-only relay overlay

The old "relay debug overlay" console helpers were removed from `js/app.js` so they don't ship in production.

