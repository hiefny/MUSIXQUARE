<p align="center">
  <a href="https://musixquare.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/logo-wordmark-white.svg">
      <source media="(prefers-color-scheme: light)" srcset="./docs/assets/logo-wordmark-black.svg">
      <img alt="MUSIXQUARE Wordmark" src="./docs/assets/logo-wordmark-white.svg" width="380">
    </picture>
  </a>
</p>

<p align="center">
  <strong>Multi-Device Synchronized Audio System</strong>
</p>

<p align="center">
  <a href="https://musixquare.com">musixquare.com</a> &bull;
  <a href="https://musixquare.com/about">About</a> &bull;
  <a href="https://musixquare.com/history">History</a> &bull;
  <a href="https://musixquare.com/designsystem">Design System</a> &bull;
  <a href="./docs/README.md">Documentation</a> &bull;
  <a href="https://github.com/hiefny/MUSIXQUARE">GitHub</a>
</p>

---

## Overview

MUSIXQUARE transforms smartphones, tablets, and desktop computers into a zero-installation, synchronized multi-speaker wireless sound system.

By combining low-latency Web Audio DSP graphs, peer-to-peer WebRTC data/media transports, and Cloudflare distributed edge services (Durable Objects, D1, R2), MUSIXQUARE enables real-time collaborative listening, spatial speaker role mapping, YouTube Together synchronization, and desktop system audio streaming across heterogeneous hardware.

---

## Product Demo

[![MUSIXQUARE Demo Video](https://img.youtube.com/vi/VbFwgt4l3Gc/maxresdefault.jpg)](https://youtu.be/VbFwgt4l3Gc?si=_i8eQa4kiDWl8kv5)

_Click the image above to watch the official MUSIXQUARE demonstration video on YouTube._

**Direct Video Link:** [https://youtu.be/VbFwgt4l3Gc](https://youtu.be/VbFwgt4l3Gc?si=_i8eQa4kiDWl8kv5)

---

## System Architecture

The architecture map below is a point-in-time overview that groups MUSIXQUARE
into **24 functional districts**. The source tree, executable contracts, and
maintained references classified in the [documentation hub](./docs/README.md)
remain authoritative as module and dependency counts evolve.

<p align="center">
  <img src="./docs/assets/musixquare_architecture_square.png" alt="MUSIXQUARE Full System Architecture Map (1:1 Square)" width="900" />
</p>

### Architecture Layout Breakdown

| Column    | Layer                        | Districts Included                                                                                                                           | Focus & Responsibilities                                                                                                                                                |
| :-------- | :--------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Col 1** | **Client & Runtime**         | `BOOTSTRAP`, `FRAMEWORKLESS UI`, `ACCOUNT & AUTH`, `CHAT & COMMANDS`, `I18N LOCALES`, `BROWSER RUNTIME`, `PLAYWRIGHT E2E & CHAOS`            | Modular bootstrap, frameworkless DOM controllers, locale pluralization, classic runtime compatibility, and automated browser/failure-injection suites.                  |
| **Col 2** | **Core Audio Engine**        | `CORE & STATE`, `AUDIO GRAPH & DSP`, `SYNC & NTP CLOCK`, `SYSTEM AUDIO WEBRTC`, `DIAGNOSTICS & REC`                                          | Web Audio node topology (5-band EQ, convolution reverb, stereo widener, virtual bass), host-relative RTT rolling clock sync, and desktop stereo LAN-direct/SFU capture. |
| **Col 3** | **Media & Verification**     | `PLAYBACK ENGINE`, `PLAYLIST & QUEUE`, `STORAGE & CHUNKS`, `YOUTUBE TOGETHER`, `STATIC INVARIANT GUARDS`                                     | Track decoding, preloaded and state-guarded transitions, queue management, RAM-only browser chunks, YouTube IFrame API synchronization, and compile-time AST guards.    |
| **Col 4** | **Edge & Distributed Cloud** | `NETWORK & WEBRTC`, `ROOM AUTHORITY`, `PRO ROOM CLIENT`, `REMOTE SHARE R2`, `CLOUDFLARE WORKERS`, `CLOUDFLARE DO ACTOR`, `CLOUDFLARE D1 SQL` | Peer-to-peer data channels, stateful Durable Object session actors, persistent PRO room authorization, Cloudflare D1 relational schemas, and private R2 asset delivery. |

---

## Key Features

- **6-Digit Room Access**:
  - `100000` to `999999`: Temporary Standard Rooms coordinated by a browser host over WebRTC, with Cloudflare signaling/TURN in production and temporary private R2 fallback when direct file delivery is unavailable.
  - `000000` to `099999`: Persistent PRO Rooms backed by dedicated Cloudflare Durable Object actors with durable state and multi-device persistence.
- **Dynamic Speaker Role Routing**:
  - Assign connected devices in real time to **Center (Stereo)**, **Left Channel**, **Right Channel**, or **Subwoofer (Low-pass filtered)**.
- **Browser-Native Web Audio DSP**:
  - In-browser 5-band parametric equalizer, convolution reverb engine, Haas stereo widener, and virtual psychoacoustic bass enhancer.
- **Latency-Aware Clock Synchronization**:
  - Standard rooms utilize rolling host-relative RTT probing; PRO rooms operate via server-coordinated epoch timelines with two-phase prepare/commit rendezvous scheduling.
- **YouTube Together Synchronization**:
  - Synchronized playback across heterogeneous network topologies with automatic drift detection, seek compensation, and buffering state alignment.
- **Desktop System Audio Streaming (Beta)**:
  - Broadcast low-latency tab or system audio from a desktop Chromium browser, with one publisher and up to three receivers.
  - PRO rooms use verified LAN-direct WebRTC when available; if any route is unavailable or fails, all listeners are routed together through Cloudflare Realtime SFU. See the [PRO room architecture](./docs/design/pro-room-architecture-and-operations.md#live-system-audio-ownership) for route and privacy details.
- **Private Media & Queue Management**:
  - In-memory browser playback for Standard Rooms, temporary private R2 fallback for remote file delivery, and persistent private R2 object storage for PRO Rooms.
- **Localized UI**:
  - Built-in support for 17 languages without a runtime translation service.

---

## Room Types Comparison

| Attribute           | Standard Room                                       | Persistent PRO Room                                                 |
| :------------------ | :-------------------------------------------------- | :------------------------------------------------------------------ |
| **Code Range**      | `100000` - `999999`                                 | `000000` - `099999`                                                 |
| **Lifecycle**       | Temporary; terminates when browser host departs     | Persistent across empty-room sleep/wake cycles                      |
| **Password**        | Optional 8-digit access PIN                         | Required 8-digit room password                                      |
| **Authority Model** | Browser host authoritative over WebRTC P2P          | Cloudflare Durable Object server-authoritative state                |
| **Storage Backend** | Browser RAM, direct WebRTC, or temporary private R2 | Private Cloudflare R2 object storage (1 GiB / room, 200 MiB / file) |
| **Presence Model**  | Host-managed peer roster                            | Server-tracked heartbeats and participant session recovery          |

PRO access remains operator-controlled. It may be issued directly or redeemed
through a one-time operator voucher; there is no paid plan or public checkout.

To inquire about PRO access, email
[contact@musixquare.com](mailto:contact@musixquare.com) or contact us on the
[official MUSIXQUARE Discord server](https://discord.gg/PmmFhGTBsX).

---

## Technology Stack

- **Frontend Core**: TypeScript (Strict Mode), Vite, HTML5 Web Audio API, WebRTC (RTCDataChannel, RTCPeerConnection), frameworkless HTML/CSS/DOM controllers.
- **Signaling & Edge Backend**: Cloudflare Workers, Cloudflare Durable Objects (Stateful Actors), Cloudflare D1 (Serverless SQL), Cloudflare R2 (Object Storage).
- **Transport Adapters**: Cloudflare TURN / STUN infrastructure, PeerJS local development adapter.
- **Quality & Verification**: Vitest, Playwright E2E and recovery/chaos scenarios, custom TypeScript AST invariant guards.

---

## Local Development

Use the exact Node.js version in [`.node-version`](./.node-version) (`24.13.1`).
Corepack then selects the pinned `npm@11.8.0` from `package.json`:

### Installation & Startup

```bash
corepack npm ci
npm run dev
```

Open `http://localhost:3000` in your browser.

Localhost selects PeerJS for Standard-room signaling and ordinary UI work needs
no Cloudflare credentials. The Vite server returns local `503` responses for
its six production-proxy routes and other unconfigured relative `/api/*` paths.
That server boundary is not a blanket production air gap: the PRO client falls
back to its canonical production facade in every build mode, while non-E2E TURN
and Realtime flows retry against the canonical production origin. These paths
can consume real quota or state when invoked. Mock or redirect them for isolated
work. Enabling
`MUSIXQUARE_DEV_PROXY_PRODUCTION_API=true` additionally forwards the six named
Vite proxy routes. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and the
[configuration reference](./docs/configuration-reference.md) before exercising
any production-backed flow.

### Test & Verification Pipeline

```bash
# Run unit and integration tests
npm test

# Run strict TypeScript compiler verification
npm run typecheck

# Run codebase linter
npm run lint

# Verify Cloudflare Worker contracts and syntax
npm run check:workers

# Run full production build with invariant validation
npm run build:checked
```

---

## Security & Privacy Policy

- **Zero Credential Exposure**: Public repository contains no secrets, private keys, or credentials.
- **Fail-Closed Endpoints**: Backend routes reject unauthorized requests by default unless explicitly authenticated with scoped capability tokens.
- **Proof-of-Work Rate Limiting**: Token minting utilizes short-lived proof-of-work challenges to safeguard against resource exhaustion.
- **RAM-Only Browser Media**: Decoded audio buffers and streamed media chunks remain in volatile memory and are not persisted to unencrypted local storage.
- **LAN Candidate Privacy**: PRO LAN-direct system audio exchanges only bounded UDP host candidates between authenticated room participants through the authoritative signaling service. A valid UUID-shaped remote `.local` name may prove RFC 6762 local-link scope without exposing or probing a caller-selected numeric destination. Numeric remote candidates, other hidden or malformed names, and global or ambiguous address evidence select SFU. The product never weakens the test or adds TURN merely to preserve the optimization.

---

## License

Copyright (c) 2025-2026 MUSIXQUARE.

MUSIXQUARE is open-source software licensed under the **GNU Affero General Public License v3.0 or later** ([AGPL-3.0-or-later](./LICENSE)).

The AGPL governs copyright permissions for the software, including covered
interface code and assets. It does not grant permission to use the MUSIXQUARE
Marks or any protected, distinctive, non-functional, source-identifying
overall visual presentation in a manner likely to make an independent product
or service appear official, affiliated, sponsored, endorsed, or operated by
MUSIXQUARE. Replacing the name, logo, or icon alone may not be sufficient where
the remaining public presentation is still likely to cause confusion. See the
[Trademark Policy](./TRADEMARKS.md), practical
[Brand and Fork Identification Guide](./BRAND_POLICY.md), and
[AGPLv3 Section 7 Additional Terms](./ADDITIONAL_TERMS.md).

The additional terms apply prospectively only to first-party material that
expressly incorporates them. They do not revoke or narrow AGPL permissions for
older copies, or prohibit distinctly branded commercial or non-commercial
forks.

### Third-Party Notices

- **PeerJS**: MIT License (see [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md))
- **qrcode & content-shield**: MIT License (see [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md))
- **Google Material Icons**: Apache License 2.0 (see [distributed license](./public/licenses/material-icons-apache-2.0.txt))
- **Pretendard Font**: SIL Open Font License 1.1 (see [PRETENDARD_LICENSE.txt](./fonts/PRETENDARD_LICENSE.txt))
- **Noto Sans Fonts**: SIL Open Font License 1.1 (see the [Latin/Cyrillic license](./fonts/NOTO_SANS_LICENSE.txt), [CJK license](./fonts/NOTO_CJK_LICENSE.txt), and [Thai license](./fonts/NOTO_THAI_LICENSE.txt))
