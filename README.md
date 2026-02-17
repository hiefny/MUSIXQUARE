# MUSIXQUARE 🎵

**Multi‑Device Synchronized Surround Audio (Toss In‑App Build)**

MUSIXQUARE is a web-based party app that turns multiple devices on the **same local network (same Wi‑Fi / hotspot)** into a single synchronized audio system.

> This repository version is refactored for **Toss In‑App** release constraints:
> - **No external link/QR onboarding**
> - **Local network only (no TURN / no relay)**
> - **Short 6‑digit code** to connect
> - **Direct host connections only (max 3 guest devices)**

---

## ✨ Key Features

- **🔢 Short Code Join (In‑App Safe)**: Guests type a **6‑digit code** shown on the host device.
- **📡 Local Network Only**: Designed for **same Wi‑Fi / same hotspot**.
- **🔌 Direct Host Connections (Stable)**: Host connects directly to up to **3 guest devices** (Left / Right / Sub).
- **🔊 Role‑based Routing**: Each guest device chooses a role:
  - Left Speaker / Right Speaker / Subwoofer (optional)
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

## 🧠 Playback Design (OPFS / Streaming-first)

This build is optimized to **avoid loading full media into RAM**.

- **Host**: plays the selected file directly via a `<video>` element (no `decodeAudioData`, no full PCM buffer).
- **Guests**: receive file chunks and store them in **OPFS**, then **play directly from OPFS** via a `<video>` element.
- **FX / Channel separation**: audio is routed from the media element into **Tone.js** using `MediaElementSource` → FX graph → role routing.

Why?

- Decoding a long track into an `AudioBuffer` can easily blow up memory (PCM is huge).
- Media element decoding is streaming and stable, while still allowing WebAudio/Tone.js processing.

---

## ✅ Requirements / Notes

- **Secure context required** (HTTPS or `localhost`) for WebRTC / Service Worker / OPFS.
- This build **does not use STUN/TURN** and is intended for **LAN usage**.
- **Signaling server note (PeerJS):** even with LAN-only ICE, WebRTC still needs a signaling server to exchange offers/answers.
  - In production/in-app deployments you should provide a PeerJS server via `window.__MUSIXQUARE_PEER_SERVER__` (see `js/app.js`).
  - If your app must work with internet fully disconnected, you will need an on-LAN signaling solution.

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

> NOTE: 데모 음원 파일명은 URL/서버 호환성을 위해 `demo_track.mp3` 로 포함되어 있습니다.

### Host (방장)

1. Open the app and tap **“제가 방장할래요”**
2. The app shows a **6‑digit code**
3. Guests join and select their roles:
   - **Left Speaker**
   - **Right Speaker**
   - **Subwoofer** *(optional)*
4. Once ready, the host immediately sees 3 options:
   - **로컬파일 불러오기**
   - **유튜브 링크 추가하기**
   - **앱 체험하기**

### Guest (참가자)

1. Open the app and tap **“모임에 참가할래요”**
2. Enter the **6‑digit code** shown on the host
3. Wait until the system starts (host finishes connecting devices)

---

## 🌐 Deployment

This project is a static web app (HTML/CSS/JS).

- **No external CDN dependencies**: Tone.js and PeerJS are included in the repo under `vendor/` for self-hosting / offline-first deployments.
For Toss In‑App release, it is intended to be served from **Toss infrastructure** (no Netlify dependencies).

---

## 📲 PWA

- `manifest.webmanifest` and `service-worker.js` are included.
- Service worker is registered from `js/app.js` on secure contexts.
