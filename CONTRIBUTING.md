# Contributing to MUSIXQUARE

## Quick start

Use the exact Node.js version in `.node-version`. `package.json` declares the
same single supported Node runtime so local tooling, types, and CI cannot drift.
Corepack resolves the repository's pinned npm version from `packageManager`.
A browser-only development session needs no Cloudflare account, binding, or
secret.

```bash
corepack npm ci
npm run dev
```

Vite serves the app at `http://localhost:3000`. Localhost selects the PeerJS
transport unless you explicitly configure a local signaling Worker.

Copy `.env.example` to `.env.local` only when you need an override. By default,
the Vite server does **not** forward these six relative API routes to
`musixquare.com`:

- `/api/security-config`
- `/api/capability-challenge`
- `/api/capability-token`
- `/api/youtube-search`
- `/api/youtube-playlist-entry`
- `/api/youtube-playlist-manifest`

They return a non-cacheable `503 LOCAL_API_PROXY_DISABLED` response before
Vite's SPA fallback. Other unconfigured relative `/api/*` paths return
`503 LOCAL_API_NOT_CONFIGURED`.

This Vite control is not a blanket production air gap. In every build mode, the
PRO facade falls back to `https://musixquare.com/api/pro-room` when
`VITE_PRO_ROOM_ENDPOINT` is absent or invalid. Outside E2E mode, TURN and
Realtime calls try a relative endpoint and then the canonical production
origin. Invoking those flows can therefore consume production quota or state
even while Standard-room signaling uses local PeerJS. Mock the requests or
configure validated local endpoints before exercising them. The complete
boundary and variable inventory lives in
[`docs/configuration-reference.md`](docs/configuration-reference.md).

Forwarding the six routes above is reserved for an intentional integration
check: set
`MUSIXQUARE_DEV_PROXY_PRODUCTION_API=true` in untracked `.env.local`, restart
Vite, and remove the override afterward. That mode can consume production
quotas and must never be the default development setup.

## Verification ladder

Run the smallest relevant unit test while iterating, then use this non-E2E
baseline before handing off a change:

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run check:workers
npm run build:checked
```

The exact-SHA automated suite is the ordinary release-confidence gate. It also
runs the security/coverage ratchets, Worker bundle dry-runs, and blocking
Chromium owner-recovery, OAuth-return, host/guest, background-resume, and signed
upload paths. A defect
that depends on WebRTC, background/resume, audio routing, playback hardware, or
a particular mobile browser may still need reproduction on the affected
hardware during diagnosis. See
[`docs/runtime-scenario-verification-2026-05-31.md`](docs/runtime-scenario-verification-2026-05-31.md)
for the automated verification order and the limits of browser automation.

## Worker configuration

Frontend work does not require a Worker. When a change crosses a Worker
boundary, use only the configuration and runbook for that Worker; do not copy
every repository environment identifier into one local file.

| Boundary                                 | Binding and non-secret source of truth                                                                                                                                                        | Provisioning / contract guides                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App, admin, account auth                 | [`cloudflare/wrangler.app.toml`](cloudflare/wrangler.app.toml)                                                                                                                                | [Account auth](docs/account-auth-operations.md), [admin access](docs/admin-access.md), [admin dashboard](cloudflare/admin-dashboard-ops.md), [drift checks](cloudflare/config-drift-ops.md)          |
| Persistent PRO rooms and service control | [`cloudflare/wrangler.pro-room.toml`](cloudflare/wrangler.pro-room.toml)                                                                                                                      | [PRO architecture and operations](docs/design/pro-room-architecture-and-operations.md), [server authority](docs/design/pro-room-server-authority.md), [drift checks](cloudflare/config-drift-ops.md) |
| Standard-room signaling                  | [`cloudflare/wrangler.signaling.toml`](cloudflare/wrangler.signaling.toml)                                                                                                                    | [Signaling liveness](docs/design/signaling-liveness.md), [PIN operations](cloudflare/standard-room-pin-ops.md), [drift checks](cloudflare/config-drift-ops.md)                                       |
| Remote file sharing                      | [`cloudflare/wrangler.remote-share.toml`](cloudflare/wrangler.remote-share.toml), [`cloudflare/wrangler.remote-share.example.toml`](cloudflare/wrangler.remote-share.example.toml) (prod ref) | [Remote Share operations](cloudflare/remote-share-ops.md), [drift checks](cloudflare/config-drift-ops.md)                                                                                            |
| Developer API and private facade         | [`cloudflare/wrangler.developer-api.toml`](cloudflare/wrangler.developer-api.toml), [`cloudflare/wrangler.developer-api-facade.toml`](cloudflare/wrangler.developer-api-facade.toml)          | [OpenAPI contract](public/developers/openapi.yaml), [drift checks](cloudflare/config-drift-ops.md)                                                                                                   |

The Remote Share example is a production reference mirror for review only; do
not deploy it directly.

The Wrangler files declare the authoritative D1, Durable Object, R2, KV,
service, and asset bindings and list baseline Worker secret names beside each
consumer. Use
[`cloudflare/config-drift-ops.md`](cloudflare/config-drift-ops.md) and the owning
runbook for the complete current production requirements. For local Wrangler
work, put only the selected Worker's local-only values in an ignored
`.dev.vars`; never use production values and never commit the file. Cross-Worker
flows need their paired Workers and bindings, so a single standalone
`wrangler dev` process is not a complete stack.

Production provisioning, deployment, migrations, live smoke calls, and secret
rotation are operator actions. Do not run them as part of ordinary local
development or a pull request test.

## Change hygiene

- Keep unrelated existing worktree changes intact.
- Add focused regression coverage for behavior changes.
- Never commit `.env.local`, `.dev.vars`, credentials, account identifiers,
  production response bodies, or captured user media.
- Update the owning runbook when a binding or cross-Worker contract changes.
- Classify and maintain documentation according to the
  [documentation governance policy](docs/documentation-governance.md); do not
  rewrite a dated historical record as though it were the current contract.
- Report security issues privately as described in [`SECURITY.md`](SECURITY.md).
