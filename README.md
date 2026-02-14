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
- **🔊 Role‑based Routing**: Host assigns devices sequentially:
  1) Left Speaker → 2) Right Speaker → 3) Subwoofer (optional)
- **🎥 YouTube + Local Files**: Host can load local files or add a YouTube link (within in‑app constraints).
- **🛠️ Pro Audio Engine**: Mixing / FX powered by Tone.js.

---

## 🛠️ Technology Stack

- **Tone.js**: Web Audio engine (FX / mixing)
- **PeerJS**: WebRTC P2P networking for low‑latency messaging
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

### Host (방장)

1. Open the app and tap **“제가 방장할래요”**
2. The app shows a **6‑digit code**
3. Connect devices in order:
   - **Left Speaker** device enters code
   - **Right Speaker** device enters code
   - **Subwoofer** device enters code *(optional)*
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
For Toss In‑App release, it is intended to be served from **Toss infrastructure** (no Netlify dependencies).

---

## 📲 PWA

- `manifest.webmanifest` and `service-worker.js` are included.
- Service worker is registered from `js/app.js` on secure contexts.
