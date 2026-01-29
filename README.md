# MUSIXQUARE 

**Multi-Device Synchronized Surround Audio System**

MUSIXQUARE is an innovative web-based party app that transforms multiple smartphones into a single, massive surround sound system. No installation required—just open your browser and start the party.
**Live Demo**: [musixquare.netlify.app](https://musixquare.netlify.app)
---

##  Key Features

- **Instant Connection, No App Needed**: Works instantly on iOS, Android, and PC via any modern web browser.
- **Precision Synchronization**: Real-time playback tracking allows all guest devices to sync with the host within 0.1s accuracy.
- **Virtual Surround & 7.1 Support**: Configure devices as Left, Right, Center, or Woofer. Supports advanced 7.1 surround mapping.
- **YouTube Sync**: Watch YouTube videos together with perfectly synchronized audio across all connected devices.
- **Professional Audio Engine**: Built-in 5-band EQ, Reverb, Virtual Bass, and Stereo Width controls powered by Tone.js.
- **Smart Social Chat**: Share links, timestamps, and communicate in real-time. Link titles are automatically extracted for YouTube.
- **High-Performance OPFS Storage**: Uses next-gen Origin Private File System (OPFS) for seamless streaming of large media files.

---

## Technology Stack

- **[Tone.js](https://tonejs.github.io/)**: High-performance Web Audio framework for the synchronized sound engine.
- **[PeerJS](https://peerjs.com/)**: WebRTC P2P networking for low-latency communication and relay.
- **[QRCode.js](https://davidshimjs.github.io/qrcodejs/)**: Easy session joining via QR codes.
- **OPFS (Origin Private File System)**: Advanced browser storage for efficient large file handling.

---

## Getting Started

### Local Development

1. Clone this repository.
2. Ensure you have a local server to serve files (PeerJS and OPFS require a secure context or localhost).
3. Run the included batch file for easy setup:
   ```bash
   ./start-server.bat
   ```
4. Open `http://localhost:8080` in your browser.

### Deployment

This project is optimized for deployment on **Netlify**. It includes a `netlify.toml` for proper routing and header configurations.

---

## How to Use

1. **Host (The DJ)**:
   - Open the app and click **Connect** to get your Link or QR Code.
   - Upload local files or paste a YouTube link.
   - Control playback, volume, and EQ for the entire room.

2. **Guest (The Speakers)**:
   - Scan the QR code or click the shared link.
   - Set your device channel (e.g., "Left Subwoofer" or "Rear Right").
   - Sit back and enjoy the synchronized immersive audio!

---

## Author

Created with ❤️ by **HIEFNY**

[![Buy Me A Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/hiefny)

---

## 📝 License

Distributed under the MIT License.
