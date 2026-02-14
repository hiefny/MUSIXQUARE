# MUSIXQUARE 🎵

**Multi-Device Synchronized Surround Audio System**

MUSIXQUARE is a web-based party app that transforms multiple smartphones into a single, massive **synchronized surround sound** system.
No installation required—just open your browser and start the party.

**Live Demo**: https://musixquare.netlify.app

---

## ✨ Key Features

- **🚀 Instant Connection, No App Needed**: Works instantly on iOS, Android, and PC via any modern web browser.
- **⏱️ Precision Synchronization**: Real-time playback tracking allows all guest devices to sync with the host (sub-second).
- **🔊 Virtual Surround & 7.1 Support**: Configure devices as Left, Right, Center, Woofer, and more.
- **🎥 YouTube Sync**: Watch YouTube videos together with synchronized audio across connected devices.
- **🛠️ Pro Audio Engine**: EQ / Reverb / Virtual Bass / Stereo Width controls powered by Tone.js.
- **💬 Smart Social Chat**: Share links and timestamps in real time. (YouTube titles are auto-fetched.)
- **💾 OPFS Storage**: Uses Origin Private File System (OPFS) for efficient large media handling.

---

## 🛠️ Technology Stack

- **Tone.js**: Web Audio engine (FX / mixing)
- **PeerJS**: WebRTC P2P networking for low-latency communication
- **QRCode.js**: Easy session joining via QR codes
- **OPFS (Origin Private File System)**: Efficient local storage for large media

---

## ✅ Requirements / Notes

- **HTTPS is required** (or `localhost` during development).
  - WebRTC / Clipboard / Service Worker / OPFS require a secure context.
- OPFS is recommended.
  - Older iOS Safari versions may have limitations.

---

## 🚀 Getting Started

### Local Development

> Opening via `file://` may break some features (especially Service Worker / OPFS).

#### Option A) Python

```bash
python -m http.server 5173
```

Then open:

- `http://localhost:5173/`

#### Option B) VSCode Live Server

- Use VSCode extension **Live Server**

---

## 📖 How to Use

1. **Host (The DJ)**
   - Open the app and press **Connect** to get your link or QR code.
   - Upload local files or paste a YouTube link.
   - Control playback, volume, and FX for the room.

2. **Guest (The Speakers)**
   - Scan the QR code or open the shared link.
   - Choose your speaker channel (Left / Right / Center / Rear / Sub, etc.).
   - Enjoy synchronized surround audio.

---

## 🌐 Deployment

This project is **static-hosting friendly** (HTML/CSS/JS).

### Netlify (Recommended)

- `netlify.toml` is included for routing & security headers.
- A sample serverless function is included:
  - `netlify/functions/get-turn-config.js`

#### Environment Variables (TURN)

Recommended:

- `TURN_USERNAME`
- `TURN_CREDENTIAL`

Optional (recommended):

- `ALLOWED_ORIGINS`
  - CORS allowlist for `/.netlify/functions/get-turn-config` (comma-separated)
  - If omitted, the function defaults to **same-origin (+ localhost dev)** only.

> ⚠️ Security: avoid shipping long-lived TURN credentials to all clients.
> For production, prefer **ephemeral / time-limited** TURN credentials issued server-side.

### GitHub Pages / Vercel

- Works as a static site.
- If you want TURN support, you’ll need a serverless function / backend.

---

## 📲 PWA (Installable)

- `manifest.webmanifest` and `service-worker.js` are included.
- The app registers the Service Worker from `js/app.js` on secure contexts.
- Update behavior:
  - When a new version is available, the app shows an in-app dialog.
  - On confirmation, it activates the new SW (`SKIP_WAITING`) and reloads.

---

## 🔒 Security & Quality Improvements (included)

- Removed `alert()` → replaced with **non-blocking in-app dialogs**
- Hardened UI rendering against attribute-based injection
  - Added `escapeAttr()`
  - Device list rendering moved away from raw `innerHTML` toward safer DOM creation
- Removed 3rd-party `noembed` dependency → unified to **YouTube oEmbed**
- Added clipboard fallback for environments where `navigator.clipboard` fails
- Added Netlify security headers (HSTS / COOP / CORP / CSP, etc.)
- Service Worker & manifest are served with `no-cache` to avoid stale PWA updates

---

## 🧱 Project Structure

- `index.html` : main UI
- `css/style.css` : styles
- `js/app.js` : app logic
- `js/sync.worker.js` : sync/compute worker
- `js/transfer.worker.js` : file transfer worker
- `manifest.webmanifest` : PWA manifest
- `service-worker.js` : PWA service worker
- `icons/` : app icons
- `netlify/functions/get-turn-config.js` : TURN config function (sample)

---

## 👨‍💻 Author

Created with ❤️ by **HIEFNY**

Buy me a coffee:
- https://buymeacoffee.com/hiefny

---

## 📝 License

Distributed under the **MIT License**.
