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

Copy `.env.example` to `.env.local` only when you need an override. The safe
default does **not** send these production-backed API calls to
`musixquare.com`:

- `/api/security-config`
- `/api/capability-challenge`
- `/api/capability-token`
- `/api/youtube-search`
- `/api/youtube-playlist-entry`
- `/api/youtube-playlist-manifest`

They return a non-cacheable `503 LOCAL_API_PROXY_DISABLED` response before
Vite's SPA fallback. Other unconfigured `/api/*` paths return
`503 LOCAL_API_NOT_CONFIGURED`; mock them in the browser/test harness when
relevant.
Production proxying is reserved for an intentional integration check: set
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
npm run check:workers
npm run build:checked
```

The exact-SHA automated suite is the ordinary release-confidence gate. The
production workflow requires the physical-device/browser matrix when the
candidate crosses a checked-in WebRTC, background/resume, audio routing,
playback, YouTube/iOS, or service-worker risk boundary; operators may also opt
in for other changes. See
[`docs/runtime-scenario-verification-2026-05-31.md`](docs/runtime-scenario-verification-2026-05-31.md)
for the first-48-hours order and evidence checklist.

## Worker configuration

Frontend work does not require a Worker. When a change crosses a Worker
boundary, use only the configuration and runbook for that Worker; do not copy
every repository environment identifier into one local file.

| Boundary                                 | Binding and non-secret source of truth                                                                                                                                                        | Provisioning / contract guide                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| App, admin, account auth                 | [`cloudflare/wrangler.app.toml`](cloudflare/wrangler.app.toml)                                                                                                                                | [`docs/account-auth-operations.md`](docs/account-auth-operations.md), [`docs/admin-access.md`](docs/admin-access.md) |
| Persistent PRO rooms and service control | [`cloudflare/wrangler.pro-room.toml`](cloudflare/wrangler.pro-room.toml)                                                                                                                      | [`docs/design/pro-room-architecture-and-operations.md`](docs/design/pro-room-architecture-and-operations.md)         |
| Standard-room signaling                  | [`cloudflare/wrangler.signaling.toml`](cloudflare/wrangler.signaling.toml)                                                                                                                    | [`cloudflare/admin-dashboard-ops.md`](cloudflare/admin-dashboard-ops.md)                                             |
| Remote file sharing                      | [`cloudflare/wrangler.remote-share.toml`](cloudflare/wrangler.remote-share.toml), [`cloudflare/wrangler.remote-share.example.toml`](cloudflare/wrangler.remote-share.example.toml) (template) | [`cloudflare/remote-share-ops.md`](cloudflare/remote-share-ops.md)                                                   |
| Developer API and private facade         | [`cloudflare/wrangler.developer-api.toml`](cloudflare/wrangler.developer-api.toml), [`cloudflare/wrangler.developer-api-facade.toml`](cloudflare/wrangler.developer-api-facade.toml)          | [`public/developers/openapi.yaml`](public/developers/openapi.yaml)                                                   |

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
- Report security issues privately as described in [`SECURITY.md`](SECURITY.md).
