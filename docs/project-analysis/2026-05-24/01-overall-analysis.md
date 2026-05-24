# 1st Pass: Project-Wide Analysis

## Executive Summary

MUSIXQUARE is a TypeScript/Vite browser application for synchronized media playback across devices. Its apparent product goal is to let a host create a room, let guests join from other devices, and then coordinate one of several media paths:

- Local audio file playback with synchronized start/pause/seek/skip.
- Direct same-LAN file transfer through WebRTC data channels.
- Encrypted remote file sharing through Cloudflare R2 when direct transfer would go through TURN or is otherwise unsuitable.
- YouTube Together playback through the official iframe player plus custom synchronization/rendezvous logic.
- System audio sharing through browser display/system capture, P2P/SFU media paths, and role-based channel assignment.
- Chat, operator controls, device slots, room password/rename/kick, demo mode, themes, visualizer, and i18n.

The codebase is large, browser-heavy, and event-driven. It has more of the shape of a real-time distributed system than a typical single-page UI app. The most important correctness axis is not only "does the function return the right value", but "does every participant converge on the same mode, track, timestamp, authority, and cleanup state despite async browser APIs and network jitter".

## Stack

| Area | Current stack |
| --- | --- |
| App language | TypeScript, strict mode |
| Bundler/dev server | Vite 6 |
| UI model | Static HTML + modular DOM controllers; no React/Vue/Svelte |
| Audio | Web Audio API, MediaStream, display/system capture |
| Realtime network | WebRTC DataChannel/MediaConnection through transport facade |
| Signaling | Cloudflare Durable Object signaling or PeerJS fallback |
| Remote object transfer | Cloudflare R2 worker, presigned upload/download URLs |
| Security gate | App Worker capability tokens, optional Turnstile, per-IP rate limits |
| Tests | Vitest unit tests, Playwright E2E suite |
| CI | GitHub Actions: fast CI on PR/push, E2E manual dispatch |
| PWA/service worker | `sw-register.ts`, service worker assets in root/public |

Runtime dependencies:

- `peerjs`
- `qrcode`
- `realtime-bpm-analyzer`
- `content-shield`

Development dependencies include TypeScript, Vite, Vitest, Playwright, ESLint, Prettier, and OG image generation utilities.

## Repository Shape

Top-level areas:

| Path | Purpose |
| --- | --- |
| `src/` | Main browser app, organized by runtime domain. |
| `cloudflare/` | App worker, signaling worker, remote-share worker, Wrangler configs, R2 CORS docs. |
| `e2e/` | Playwright integration/E2E tests and helpers. |
| `docs/` | Architecture docs and prior audit notes. |
| `scripts/` | Production build/security guards and static OG tooling. |
| `.github/workflows/` | CI and manual E2E workflows. |
| `public/`, `icons/`, `fonts/`, `css/` | Static assets. |
| `dist/`, `coverage/`, `test-results/` | Generated output or test artifacts. |

Important entry/config files:

- `src/app.ts`: browser app bootstrap and module initialization.
- `index.html`: main app shell.
- `vite.config.ts`: build inputs, dev proxy, aliasing, chunking.
- `vitest.config.ts`: unit test and coverage configuration.
- `playwright.config.ts`: serial Playwright configuration.
- `tsconfig.json`: strict app TypeScript config.
- `src/workers/tsconfig.json`: worker TypeScript config.
- `eslint.config.js`: lint rules and no raw timer restrictions.
- `package.json`: scripts and dependency manifest.

## Size and Complexity Snapshot

Production module line counts from this pass:

| Module | Files | Lines | Notes |
| --- | ---: | ---: | --- |
| `src/ui` | 34 | ~9,893 | Dense DOM control surface, overlays, settings, chat, visualizer. |
| `src/network` | 31 | ~8,645 | Transport, signaling, host/guest orchestration, sync, system audio. |
| `src/player` | 18 | ~7,489 | Playback lifecycle, transport, playlist, decode, media session, ownership. |
| `src/youtube` | 13 | ~6,919 | Iframe API, sync/rendezvous, search, handlers, module state. |
| `src/storage` | 14 | ~5,001 | RAM storage, file transfer send/receive, preload, recovery. |
| `src/core` | 23 | ~3,718 | State, event bus, timers, session, logging, capability, lifecycle helpers. |
| `src/audio` | 13 | ~2,965 | Web Audio graph, effects, channel routing, beat detection, system capture. |
| `src/chat` | 3 | ~2,137 | Commands, protocol, profanity filter. |
| `src/i18n` | 6 | ~1,616 | Korean/English dictionaries and DOM translation engine. |
| `src/share` | 7 | ~1,559 | Remote-share client, encryption, upload/download control. |
| `src/demo` | 7 | ~1,398 | Demo mode, demo tracks, storage/restore policy. |
| `src/types` | 1 | ~915 | Shared protocol, state, and event types. |
| `src/workers` | 2 | ~300 | Worker-side helpers. |

Largest production files:

| File | Lines | Why it matters |
| --- | ---: | --- |
| `src/chat/commands.ts` | 1,575 | Large command/debug surface. |
| `src/youtube/iframe.ts` | 1,444 | Browser API readiness, iframe lifecycle, iOS behavior, crash recovery. |
| `src/youtube/player.ts` | 1,386 | YouTube mode coordinator and autosync. |
| `src/storage/transfer-receive.ts` | 1,319 | Most race-sensitive file receive path. |
| `src/player/playlist.ts` | 1,277 | Track switching, preload, shuffle/repeat, cross-mode transitions. |
| `src/storage/preload.ts` | 1,255 | Background preload and unicast transfer coordination. |
| `src/youtube/sync.ts` | 1,241 | Host/guest YouTube timing convergence. |
| `src/demo/mode.ts` | 1,162 | Demo orchestration and restore behavior. |
| `src/ui/player-controls.ts` | 1,068 | User-facing playback control state. |
| `src/network/transport/cloudflare-signaling.ts` | 931 | Signaling transport facade implementation. |

These files are not automatically "bad", but they are the natural blast-radius centers for future changes.

## Current Health

Strong points:

- Strict TypeScript is enabled for the app, with `noUnusedLocals`, `noUnusedParameters`, `isolatedModules`, and bundler-style resolution.
- Unit test coverage is broad across core, audio, network, player, storage, share, UI, YouTube, demo, and workers.
- Fast gates pass locally: typecheck, lint, unit tests, and build guards.
- Production bundle is guarded against leaking E2E test hooks.
- Production security config is explicitly checked by script.
- Network protocol handling includes typed messages, validators, and inbound rate limiting.
- File data is intentionally kept out of TURN paths; remote or unknown peers use encrypted remote-share.
- Storage has moved to RAM-first behavior, avoiding OPFS/disk lifecycle complexity.
- Playback state ownership has been decomposed into more precise contracts.

Weak or risky areas:

- E2E suite is large, serial, manually triggered, and documented as stale.
- E2E helper code still references removed legacy `appState` behavior.
- Main JS chunk is large, and some dynamic imports cannot split because of static imports.
- Runtime correctness depends on real browser/device behavior that unit tests can only approximate.
- Several files exceed 1,000 lines and encode multiple responsibilities.
- Cloudflare production config currently allows a Turnstile-disabled grace-period fallback. It is guarded and documented, but it remains an operational switch to monitor.
- DOM UI is manually managed and therefore depends heavily on IDs, classes, and data attributes staying aligned with HTML.

## Architectural Spine

The application has five central contracts:

1. Typed state tree
   - `src/core/state.ts` owns `getState`, `setState`, `batchSetState`, snapshots, reset behavior, and development/E2E hooks.
   - `src/types/index.ts` defines `StateTree` and `StatePath`.
   - State changes emit `state:*` events through the typed event bus.

2. Typed event bus
   - `src/core/events.ts` provides `bus.on`, `bus.once`, `bus.off`, `bus.emit`, `bus.clear`, and scoped cleanup.
   - `EventMap` in `src/types/index.ts` constrains valid event names and payloads.

3. Playback ownership
   - Production code has moved away from broad `appState`.
   - `playback.mode` tells which domain owns the room: file, YouTube, system-audio, or none.
   - `playback.activity` tells the observable state: idle, paused, playing, pending.
   - `playback.lifecycle` is file-specific and uses `PLAYBACK_STATE`.
   - `src/player/ownership.ts` centralizes write helpers and derived ownership behavior.

4. Protocol authority
   - `src/types/index.ts` defines the message protocol.
   - `src/network/protocol.ts` validates and dispatches incoming messages.
   - Host-only and operator-only boundaries are enforced in handlers and request paths.

5. Data path policy
   - Same-LAN direct file transfer can use WebRTC data channels.
   - Remote/unknown guests use encrypted R2 remote-share.
   - File data is explicitly prevented from flowing over TURN for cost and policy reasons.
   - System audio can use P2P or SFU-style paths depending on topology and capability.

## Major Runtime Domains

### Core

`src/core` provides the basic runtime substrate:

- Typed state store.
- Typed event bus.
- Managed timers and timer cleanup discipline.
- Blob URL manager.
- Logging level and local debug controls.
- Capability token flow for paid/sensitive endpoints.
- Session code helpers and session-scoped cancellation.
- Page lifecycle and background resume guards.

This is one of the healthiest parts of the architecture because it is relatively small, typed, and heavily reused.

### Audio

`src/audio` creates and controls the Web Audio graph:

- Player source into widening, preamp, channel split/merge, EQ, reverb, bass/sub path, master, analyser, destination.
- Role-based channel routing: stereo, left, right, sub.
- System capture through display/system audio APIs.
- Beat detection through `realtime-bpm-analyzer`.
- Audio settings broadcast/request paths for host/operator flows.

Audio risk is browser policy risk: autoplay, AudioContext resume, iOS behavior, stream track lifecycle, and capture permission behavior.

### Network

`src/network` owns room connectivity:

- Transport abstraction over Cloudflare signaling and PeerJS.
- Host room creation and incoming guest connections.
- Guest room join and host connection lifecycle.
- Device slots, labels, operator grants, kicks, room password changes.
- Shared clock and sync ping/pong.
- System audio guest/host/SFU paths.
- TURN/STUN capability retrieval and connection type detection.

Network risk is distributed-system risk: stale connections, duplicate tabs/devices, host handoff/leave cleanup, reconnect behavior, and making sure old async events cannot mutate current state.

### Player

`src/player` owns media playback state and file playback:

- File lifecycle FSM.
- Playback transport over Web Audio.
- Decode/load/finalize behavior.
- Playlist, shuffle, repeat, next/previous, same-track replay, preload handoff.
- Media Session integration.
- Ownership helpers for mode/activity.

This module is a central convergence point because file, YouTube, and system audio transitions all touch playback ownership and UI state.

### Storage

`src/storage` owns local file storage and transfer:

- RAM-only storage adapter.
- Direct file transfer send/receive.
- Background preload.
- Recovery requests and host resend.
- Remote-to-local promotion when a peer later proves local.

The hard part is not raw storage; it is deciding whether an incoming transfer is current, stale, preloaded, promoted, skipped, or superseded by another mode.

### Share

`src/share` owns remote encrypted file sharing:

- AES-GCM encryption/decryption.
- R2 client endpoint discovery.
- Capability headers for remote-share sessions.
- Presigned upload/download progress.
- Active descriptor cache.
- Abort/cancel behavior.

This is the safety valve for remote guests and TURN cost control.

### YouTube

`src/youtube` owns YouTube Together:

- Iframe API loading and player lifecycle.
- Search and URL parsing.
- Playlist scraping/indexing.
- Host autosync and two-stage rendezvous.
- Guest drift correction and latency calibration.
- Ad/unavailable/crash handling.

This is one of the most complex runtime domains because it combines third-party iframe behavior, browser autoplay rules, playlist quirks, and room-wide synchronization.

### UI

`src/ui` is a modular DOM controller layer:

- Setup overlays for host/guest/demo/media source.
- Player controls, seekbar, playlist UI.
- Device list and room controls.
- Dialog/toast systems.
- Settings and channel/audio controls.
- Chat UI and message rendering.
- Visualizer and party mode.
- Overlay inert/focus management.

The UI is not framework-driven; correctness depends on stable DOM IDs/classes/data attributes, careful event listener setup, and tests that create expected DOM fragments.

### i18n

`src/i18n` provides:

- Korean/English dictionaries.
- `t()` and `tHtml()` translation helpers.
- DOM translation through `data-i18n*` attributes.
- MutationObserver-based translation of dynamically inserted nodes.
- `i18n:changed` event for components with cached strings.

The HTML translation path is intentionally separated through `tHtml()` with interpolation escaping.

### Cloudflare

The Cloudflare layer is three separate edge services:

- `cloudflare/app-worker.js`: app API, security headers, capability token minting, Turnstile validation, YouTube search proxy, TURN credentials.
- `cloudflare/signaling-worker.js`: Durable Object signaling room service.
- `cloudflare/remote-share-worker.js`: R2 object session creation, presigned upload/download, HMAC signing, capability gate.

This layer is security and cost critical.

## 1st-Pass Conclusion

The project is currently in good fast-CI health, and its recent state architecture appears intentionally hardened. The main short-term concern is not failing TypeScript or unit tests; it is stale E2E coverage and the difficulty of validating real-time cross-device flows. Future analysis and changes should treat the state/protocol contracts as sacred, then target one runtime path at a time with small, verified changes.

