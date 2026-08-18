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
  <a href="https://github.com/hiefny/MUSIXQUARE">GitHub</a>
</p>

---

## Overview

MUSIXQUARE transforms smartphones, tablets, and desktop computers into a zero-installation, synchronized multi-speaker wireless sound system. 

By combining low-latency Web Audio DSP graphs, peer-to-peer WebRTC data/media transports, and Cloudflare distributed edge actors (Durable Objects, D1, R2), MUSIXQUARE enables real-time collaborative listening, spatial speaker role mapping, YouTube Together synchronization, and desktop system audio streaming across heterogeneous hardware.

---

## Product Demo

[![MUSIXQUARE Demo Video](https://img.youtube.com/vi/VbFwgt4l3Gc/maxresdefault.jpg)](https://youtu.be/VbFwgt4l3Gc?si=_i8eQa4kiDWl8kv5)

*Click the image above to watch the official MUSIXQUARE demonstration video on YouTube.*  
**Direct Video Link:** [https://youtu.be/VbFwgt4l3Gc](https://youtu.be/VbFwgt4l3Gc?si=_i8eQa4kiDWl8kv5)

---

## OpenAI Build Week 2026

MUSIXQUARE existed before OpenAI Build Week. This submission is based on the
meaningful extensions I developed with Codex and GPT-5.6 during the official
submission period, rather than on the pre-existing product alone.

### Build Week Baseline and Evidence

- **Pre-event baseline:** [`0483a000`](https://github.com/hiefny/MUSIXQUARE/commit/0483a000d8d745cab9e7091a83199a7ebdc32375)
- **Build Week changes:** [`0483a000...main`](https://github.com/hiefny/MUSIXQUARE/compare/0483a000d8d745cab9e7091a83199a7ebdc32375...main)
- **Development period:** July 14–21, 2026 KST
- **Primary Codex `/feedback` session:** `019f495f-b46e-7ad1-966b-9dfe679c5321`

### What I Built During Build Week

The largest extension was a persistent PRO room architecture. Before Build
Week, rooms were temporary and coordinated by a host browser. During the event,
I added stable room identities, private media storage, durable playlists,
repeat and shuffle persistence, participant presence, server-owned playback
authority, and recovery from sleeping or disconnected clients.

I also added room-scoped Developer APIs for queue management, playback, and
audio effects; optional account identity with account-bound permissions;
collaborative playlist controls; remote-media preloading; global drag-and-drop
media loading; media delivery designed for rooms of up to 100 connected
devices; safer reconnect identities; atomic session resets; more reliable
YouTube transitions and rendezvous timing; locale-aware pluralization; and
clearer real-time interface feedback.

Behind the product, I built release manifests, deployment-state verification,
live signaling and reconnection smoke tests, Cloudflare configuration
safeguards, rollback procedures, and extensive unit and end-to-end regression
coverage.

### How I Collaborated With Codex and GPT-5.6

I used Codex powered by GPT-5.6 as an engineering partner throughout the full
development cycle: analyzing the real-time architecture, designing system
boundaries, implementing features, tracing asynchronous failures, building
regression tests, auditing security assumptions, and validating production
deployments.

Codex accelerated implementation, review, testing, and the investigation of
complex edge cases across the browser, Web Audio, WebRTC, Cloudflare Workers,
Durable Objects, D1, R2, and the production release pipeline. I reviewed the
proposed changes, chose the product scope, defined the authority and privacy
boundaries, rejected or revised unsuitable approaches, and made the final
product, engineering, and design decisions.

---

## System Architecture

The MUSIXQUARE architecture is organized into **24 specialized functional districts** spanning **848 modules** and **3,021 dependency edges**.

<p align="center">
  <img src="./docs/assets/musixquare_architecture_square.png" alt="MUSIXQUARE Full System Architecture Map (1:1 Square)" width="900" />
</p>

### Architecture Layout Breakdown

| Column | Layer | Districts Included | Focus & Responsibilities |
| :--- | :--- | :--- | :--- |
| **Col 1** | **Client & Runtime** | `BOOTSTRAP`, `FRAMEWORKLESS UI`, `ACCOUNT & AUTH`, `CHAT & COMMANDS`, `I18N LOCALES`, `BROWSER RUNTIME`, `PLAYWRIGHT E2E & CHAOS` | Micro-bundle hydration, reactive vanilla DOM rendering, locale pluralization, classic runtime compatibility, and automated integration/chaos suites. |
| **Col 2** | **Core Audio Engine** | `CORE & STATE`, `AUDIO GRAPH & DSP`, `SYNC & NTP CLOCK`, `SYSTEM AUDIO SFU`, `DIAGNOSTICS & REC` | Web Audio node topology (5-band EQ, convolution reverb, stereo widener, virtual bass), host-relative RTT rolling clock sync, and desktop stereo SFU capture. |
| **Col 3** | **Media & Verification** | `PLAYBACK ENGINE`, `PLAYLIST & QUEUE`, `STORAGE & CHUNKS`, `YOUTUBE TOGETHER`, `STATIC INVARIANT GUARDS` | Track decoding, gapless state transition, queue management, chunked RAM-only storage, YouTube IFrame API synchronizer, and compile-time AST invariant guards. |
| **Col 4** | **Edge & Distributed Cloud** | `NETWORK & WEBRTC`, `ROOM AUTHORITY`, `PRO ROOM CLIENT`, `REMOTE SHARE R2`, `CLOUDFLARE WORKERS`, `CLOUDFLARE DO ACTOR`, `CLOUDFLARE D1 SQL` | Peer-to-peer data channels, stateful Durable Object session actors, persistent PRO room authorization, Cloudflare D1 relational schemas, and private R2 asset delivery. |

---

## Key Features

- **6-Digit Room Access**:
  - `100000` to `999999`: Temporary Standard Rooms hosted entirely in-browser over direct WebRTC data channels.
  - `000000` to `099999`: Persistent PRO Rooms backed by dedicated Cloudflare Durable Object actors with durable state and multi-device persistence.
- **Dynamic Speaker Role Routing**:
  - Assign connected devices in real time to **Center (Stereo)**, **Left Channel**, **Right Channel**, or **Subwoofer (Low-pass filtered)**.
- **Hardware-Accelerated Web Audio DSP**:
  - In-browser 5-band parametric equalizer, convolution reverb engine, Haas stereo widener, and virtual psychoacoustic bass enhancer.
- **Sub-Millisecond Clock Synchronization**:
  - Standard rooms utilize rolling host-relative RTT probing; PRO rooms operate via server-coordinated epoch timelines with two-phase prepare/commit rendezvous scheduling.
- **YouTube Together Synchronization**:
  - Synchronized playback across heterogeneous network topologies with automatic drift detection, seek compensation, and buffering state alignment.
- **Desktop System Audio Streaming (Beta)**:
  - Low-latency tab or system audio broadcast from desktop Chromium browsers to up to 4 concurrent client devices.
- **Private Media & Queue Management**:
  - In-memory RAM audio pipeline for standard rooms and private Cloudflare R2 chunked storage for persistent PRO rooms.
- **Localized UI**:
  - Built-in support for 17 languages with zero external dependencies.

---

## Room Types Comparison

| Attribute | Standard Room | Persistent PRO Room |
| :--- | :--- | :--- |
| **Code Range** | `100000` - `999999` | `000000` - `099999` |
| **Lifecycle** | Temporary; terminates when browser host departs | Persistent across empty-room sleep/wake cycles |
| **Password** | Optional 8-digit access PIN | Required 8-digit room password |
| **Authority Model** | Browser host authoritative over WebRTC P2P | Cloudflare Durable Object server-authoritative state |
| **Storage Backend** | Ephemeral browser RAM / Direct WebRTC stream | Private Cloudflare R2 bucket (1 GiB / room, 200 MiB / file) |
| **Presence Model** | Host-managed peer roster | Server-tracked heartbeats and participant session recovery |

---

## Technology Stack

- **Frontend Core**: TypeScript (Strict Mode), Vite, HTML5 Web Audio API, WebRTC (RTCDataChannel, RTCPeerConnection), Native Web Components.
- **Signaling & Edge Backend**: Cloudflare Workers, Cloudflare Durable Objects (Stateful Actors), Cloudflare D1 (Serverless SQL), Cloudflare R2 (Object Storage).
- **Transport Adapters**: Cloudflare TURN / STUN infrastructure, PeerJS local development adapter.
- **Quality & Verification**: Vitest, Playwright E2E with network throttling and packet loss simulation, Custom TypeScript AST invariant linters.

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

Local development runs entirely on the browser-only PeerJS transport by default and requires no external Cloudflare credentials or API keys.

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

---

## License

Copyright (c) 2025-2026 MUSIXQUARE.

MUSIXQUARE is open-source software licensed under the **GNU Affero General Public License v3.0 or later** ([AGPL-3.0-or-later](./LICENSE)).

### Third-Party Notices

- **PeerJS**: MIT License
- **qrcode & content-shield**: MIT License (see [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md))
- **Google Material Icons**: Apache License 2.0 (see [distributed license](./public/licenses/material-icons-apache-2.0.txt))
- **Pretendard Font**: SIL Open Font License 1.1 (see [PRETENDARD_LICENSE.txt](./fonts/PRETENDARD_LICENSE.txt))
- **Noto Sans Fonts**: SIL Open Font License 1.1 (see [NOTO_SANS_LICENSE.txt](./fonts/NOTO_SANS_LICENSE.txt))
