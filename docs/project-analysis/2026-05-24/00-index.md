# MUSIXQUARE Project Analysis Index

Date: 2026-05-24
Workspace: `C:\Users\HEVC\Desktop\musixquare`
Scope: repository-wide architecture, runtime flow, quality gates, risk register, and follow-up plan.

This analysis intentionally does not modify production code. The only repository changes made for this pass are Markdown analysis notes under this directory.

## Verification Snapshot

Current fast-gate verification from this workspace:

| Command | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` | Pass | Main app TypeScript plus worker TypeScript config passed. |
| `npm run lint` | Pass | ESLint over `src/` passed. |
| `npm test` | Pass | 66 test files, 947 tests passed. |
| `npm run build:checked` | Pass | Vite production build plus production hook/security guards passed. |

Build warnings observed:

- `src/player/playlist.ts` is both statically imported and dynamically imported, so those dynamic imports do not create a separate chunk.
- `assets/main-*.js` is about 824 kB minified, above Vite's 500 kB warning threshold.

E2E was not executed in this pass. The repository's own `.github/workflows/e2e.yml` says the Playwright suite is manual-dispatch only, serial, about 30 minutes, and has stale scenarios.

## Document Map

1. [`01-overall-analysis.md`](./01-overall-analysis.md)
   - First-pass project-wide analysis: product purpose, stack, repository structure, module map, contracts, and current health.

2. [`02-analysis-plan.md`](./02-analysis-plan.md)
   - Second-pass and onward analysis plan: how to continue analyzing without context overload, what to inspect, and what evidence to record.

3. [`03-runtime-architecture.md`](./03-runtime-architecture.md)
   - Deep runtime architecture analysis: boot order, state/event contracts, playback flows, transfer paths, YouTube, system audio, Cloudflare edge services.

4. [`04-quality-risk-test-ops.md`](./04-quality-risk-test-ops.md)
   - Quality, test, CI/CD, security, operational risk, and concrete findings discovered during this pass.

5. [`05-next-actions.md`](./05-next-actions.md)
   - Prioritized next actions. Code-level remediation items are separated because the user requested permission before code changes.

6. [`06-state-protocol-contracts.md`](./06-state-protocol-contracts.md)
   - State tree, playback ownership, lifecycle, event bus, protocol categories, authority boundaries, and current contract mismatch.

7. [`07-flow-analysis.md`](./07-flow-analysis.md)
   - End-to-end runtime flow analysis for app boot, host/guest join, file playback, direct transfer, remote-share, preload, YouTube, system audio, and cleanup.

## Highest-Signal Findings

1. The project is a mature browser PWA for synchronized multi-device media playback, not a simple music player. The core surface area is Web Audio, WebRTC, typed protocol messages, Cloudflare edge workers, encrypted remote file transfer, YouTube iframe synchronization, system audio capture, and a dense DOM UI.

2. The main architectural contract has recently moved away from legacy broad `appState` semantics. Production code now uses `playback.mode`, `playback.activity`, and a file-specific lifecycle FSM. This is a good direction and is guarded by unit tests.

3. The most important fresh mismatch found in this pass is that multiple E2E files and `e2e/helpers/wait.ts` still refer to legacy `__MUSIXQUARE_GET_STATE__('appState')` semantics. Production code intentionally no longer exposes that state path. This explains why the E2E workflow is manual and documented as stale.

4. Fast CI health is strong right now: typecheck, lint, unit tests, build, production hook guard, and production security guard all pass locally.

5. Runtime risk is concentrated less in ordinary TypeScript correctness and more in multi-device timing: room join/leave races, host/guest authority, remote-share versus direct-transfer promotion, YouTube iframe readiness, mobile autoplay/background behavior, TURN/SFU capability flow, and cleanup of long-lived singleton resources.

6. The application has strong defensive patterns: typed central state paths, typed event bus, managed timers, session scopes, explicit cancellation tokens, protocol validators, inbound rate limiting, production test-hook guards, and R2 remote-share encryption.

7. The largest maintainability hotspots by file size are command parsing, YouTube iframe/player/sync, transfer receive/preload, playlist orchestration, playback decode/transport, UI controls, and network signaling.
