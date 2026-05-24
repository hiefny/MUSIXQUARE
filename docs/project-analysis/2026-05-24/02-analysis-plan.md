# 2nd Pass and Onward: Analysis Plan

## Ground Rules

The user requested detailed analysis and explicitly asked that code changes require permission first. Therefore:

- Production code should not be changed during analysis.
- Markdown documentation under `docs/project-analysis/2026-05-24/` is allowed.
- Any remediation should be proposed first, then implemented only after approval.
- Findings should be tied to files, contracts, commands, or observed behavior.
- Because this project is large, analysis should be written incrementally to Markdown instead of trying to hold every detail in chat context.

## Analysis Method

The project should be analyzed in layers:

1. Inventory
   - Identify stack, scripts, entry points, build/test configuration, module layout, large files, generated directories, and CI workflows.

2. Contract map
   - Identify the contracts that multiple modules rely on: state paths, event names, protocol messages, lifecycle states, transport interfaces, storage policies, and security gates.

3. Runtime flow analysis
   - Trace real user flows end to end rather than reading modules in isolation.

4. Risk and verification analysis
   - Cross-check tests, guards, accepted risks, E2E status, build warnings, and operational flags.

5. Remediation plan
   - Convert findings into permission-gated implementation candidates.

## Phase 1: Project-Wide Baseline

Status: completed in this pass.

Questions answered:

- What does the product do?
- What are the runtime domains?
- How is the repository structured?
- What scripts and gates exist?
- Which files are complexity centers?
- Does the current fast CI baseline pass?

Evidence recorded:

- `package.json`
- `vite.config.ts`
- `vitest.config.ts`
- `playwright.config.ts`
- `tsconfig.json`
- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `docs/full-project-audit.md`
- `docs/appstate-decomposition.md`
- `docs/state-patterns.md`
- `docs/known-accepted.md`
- `rg --files`
- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build:checked`

## Phase 2: Contract Analysis

Status: documented here, partially performed in this pass.

Targets:

- `src/types/index.ts`
- `src/core/state.ts`
- `src/core/events.ts`
- `src/core/constants.ts`
- `src/network/protocol.ts`
- `src/player/ownership.ts`
- `src/player/lifecycle.ts`
- `src/network/transport/types.ts`

Questions to answer:

- Which state paths are public cross-module contracts?
- Which state paths are local implementation details?
- Which event names are domain-level signals versus UI convenience events?
- Which protocol messages are host-only, guest-only, OP-only, or any-peer?
- Which protocol messages are rate-limited or schema-validated?
- Which lifecycle state transitions are legal and which are ignored?
- Which helpers must be used instead of raw state writes?

Expected output:

- A state path ownership table.
- A protocol authority table.
- A lifecycle transition summary.
- A list of "do not bypass" helpers.

Current key conclusion:

- The broad legacy `appState` contract has been removed from production state.
- Correct consumers should use `playback.mode`, `playback.activity`, file lifecycle helpers, and ownership helpers.
- Unit tests enforce this production contract.
- E2E tests have not fully migrated.

## Phase 3: Runtime Flow Deep Dive

Status: partially performed in this pass; further investigation should continue flow by flow.

Recommended flow order:

1. App boot
   - `src/app.ts`
   - Initialization order.
   - Module idempotency.
   - Service worker registration.
   - Global keyboard/visibility/error handlers.

2. Host room creation
   - `src/network/peer.ts`
   - `src/network/host.ts`
   - Transport selection and retry behavior.
   - Session code generation and duplicate room handling.

3. Guest room join
   - `src/network/guest.ts`
   - Setup UI.
   - Password/auth behavior.
   - Duplicate host connection cleanup.
   - Welcome/device-list processing.

4. Local file playback
   - `src/player/playlist.ts`
   - `src/player/decode.ts`
   - `src/player/transport.ts`
   - `src/player/playback.ts`
   - `src/storage/transfer-send.ts`
   - `src/storage/transfer-receive.ts`

5. Remote guest file playback
   - `src/share/remote-share.ts`
   - `src/share/r2-client.ts`
   - `src/share/crypto.ts`
   - `src/storage/transfer-receive.ts`
   - `src/network/peer-state.ts`

6. Background preload
   - `src/storage/preload.ts`
   - `src/player/playlist.ts`
   - `src/storage/transfer-send.ts`
   - `src/storage/transfer-receive.ts`

7. YouTube Together
   - `src/youtube/player.ts`
   - `src/youtube/iframe.ts`
   - `src/youtube/sync.ts`
   - `src/youtube/search.ts`
   - `src/youtube/handlers.ts`

8. System audio
   - `src/audio/system-capture.ts`
   - `src/network/system-audio-host.ts`
   - `src/network/system-audio-guest.ts`
   - `src/network/system-audio-sfu.ts`

9. Leave/cleanup
   - `src/network/peer.ts`
   - `src/player/transport.ts`
   - `src/player/ownership.ts`
   - `src/share/remote-share.ts`
   - `src/storage/preload.ts`

Expected output:

- A flow diagram per major user action.
- A list of race/cancellation points per flow.
- A list of tests that cover each flow.
- A list of uncovered browser/device behaviors.

## Phase 4: Test, CI, Build, and Security Analysis

Status: partially completed in this pass.

Targets:

- Unit test distribution under `src/**/__tests__`.
- E2E tests under `e2e/`.
- `vitest.config.ts`
- `playwright.config.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `scripts/assert-production-build-clean.mjs`
- `scripts/assert-production-security-config.mjs`
- Cloudflare Wrangler configs.

Questions:

- Which high-risk flows have unit tests?
- Which high-risk flows are only E2E/manual?
- Which tests encode stale state assumptions?
- Which production guards exist?
- Which operational flags are allowed in production and why?
- Which build warnings matter for user experience?

Current known findings:

- Fast CI passes.
- E2E is manual only and documented as stale.
- E2E files still query removed `appState`.
- Production hook guard prevents `__MUSIXQUARE_GET_STATE__`, `__MUSIXQUARE_SET_STATE__`, and `__MUSIXQUARE_BUS__` from leaking into `dist/`.
- Production security guard permits one documented Turnstile-disabled trusted-origin fallback during grace period.
- Main bundle size and playlist import chunking warnings should be tracked.

## Phase 5: Risk Register and Remediation Plan

Status: this pass creates the first register.

Each risk should be classified by:

- Severity: P0, P1, P2, P3.
- Confidence: confirmed, likely, speculative.
- Area: state, network, storage, playback, YouTube, system audio, UI, Cloudflare, tests, build.
- Evidence: file path, test result, command output, or existing doc.
- Recommended action.
- Whether code changes are required.

Expected categories:

- Confirmed stale tests.
- Runtime race risks.
- Browser/API compatibility risks.
- Operational/security flag risks.
- Maintainability hotspots.
- Build/performance risks.

## Phase 6: Permission-Gated Fix Pass

Status: not started.

Only start this after user approval.

Candidate first fixes:

1. Migrate stale E2E `appState` checks to `playback.mode`, `playback.activity`, and/or lifecycle-specific helpers.
2. Add an E2E helper that exposes a stable playback expectation API instead of raw state path reads.
3. Investigate bundle splitting opportunities around YouTube/system-audio/playlist without changing behavior.
4. Add targeted unit tests for any uncovered contract found during the E2E migration.
5. Review production Turnstile grace-period config and document the intended removal criteria.

## Continuation Checklist

When resuming this analysis, start here:

- Re-run `git status --short --branch`.
- Check whether any code changed since these docs were written.
- Re-run the fast gates if code changed.
- Use `rg "appState|__MUSIXQUARE_GET_STATE__\\('appState'|VALID_APP_STATES" e2e src docs`.
- Pick one runtime flow from Phase 3 and trace it end to end.
- Write the result to a new Markdown file in this directory.

