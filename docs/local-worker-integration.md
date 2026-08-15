# Local Worker Integration and Environment Boundaries

This guide is the public, non-secret map for local development. Production
secret names remain canonical in
[`cloudflare/ops-drift.contract.json`](../cloudflare/ops-drift.contract.json),
and live values must never be copied into a checkout.

## Choose the smallest boundary

| Task                                              | Start                                               | Credentials                             | What it proves                                                           |
| ------------------------------------------------- | --------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| Browser UI, playback state, and ordinary P2P work | `npm run dev`                                       | None                                    | Vite UI and localhost PeerJS behavior                                    |
| Deterministic Worker behavior                     | The focused Vitest file                             | None                                    | Request, binding, timeout, and failure contracts with in-memory fixtures |
| One Worker in a local runtime                     | `npm run wrangler -- dev --local --config <config>` | Local-only values for that Worker       | Workerd compatibility and that Worker's standalone routes                |
| Cross-Worker or browser/device behavior           | The relevant tests, then the physical-device matrix | Never production values in the checkout | Contract composition and actual browser/device behavior                  |

A single `wrangler dev` process is not a complete MUSIXQUARE stack. App, PRO,
signaling, remote-share, Developer API, and service-control paths use service,
Durable Object, D1, and R2 bindings owned by different deployments. Prefer the
existing multi-boundary fixtures over silently replacing a missing binding
with production.

## Browser-only default

```powershell
corepack npm ci
npm run dev
```

The safe default is `MUSIXQUARE_DEV_PROXY_PRODUCTION_API=false`. Protected API
routes return an explicit local `503`; Vite does not fall through to SPA HTML
and does not send browser traffic to production. Copy `.env.example` to the
ignored `.env.local` only for an intentional override.

Localhost selects PeerJS automatically. To point the browser at a separately
running local signaling Worker, set both values in `.env.local` and restart
Vite:

```dotenv
VITE_MUSIXQUARE_TRANSPORT=cloudflare
VITE_MUSIXQUARE_SIGNALING_URL=ws://127.0.0.1:8787/api/rooms
```

That setting changes routing; it does not fabricate the account assertions,
PRO authority, service-control state, or paired secrets required by protected
flows.

## Selected Worker runtime

Use the checked-in config for exactly one boundary:

```powershell
npm run wrangler -- dev --local --config cloudflare/wrangler.signaling.toml --port 8787
```

Wrangler accepts `--env-file <ignored-path>` when a focused path needs
local-only values. Put only that Worker's values in the ignored file. Never use
`--remote` as a shortcut for a missing local binding, and never commit
`.dev.vars`, `.env.local`, credentials, account identifiers, response captures,
or user media.

The non-secret `[vars]`, D1, Durable Object, R2, service, and asset binding
inventory is authoritative in these files:

| Worker                                        | Config                                                                                                                                                               | Secret-name/runbook source                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App, admin, auth, YouTube, TURN, and Realtime | [`wrangler.app.toml`](../cloudflare/wrangler.app.toml)                                                                                                               | [`config-drift-ops.md`](../cloudflare/config-drift-ops.md), [`account-auth-operations.md`](account-auth-operations.md), [`admin-access.md`](admin-access.md) |
| Standard signaling                            | [`wrangler.signaling.toml`](../cloudflare/wrangler.signaling.toml)                                                                                                   | [`config-drift-ops.md`](../cloudflare/config-drift-ops.md)                                                                                                   |
| PRO rooms and service control                 | [`wrangler.pro-room.toml`](../cloudflare/wrangler.pro-room.toml)                                                                                                     | [`pro-room architecture and operations`](design/pro-room-architecture-and-operations.md)                                                                     |
| Remote Share                                  | [`wrangler.remote-share.toml`](../cloudflare/wrangler.remote-share.toml)                                                                                             | [`remote-share-ops.md`](../cloudflare/remote-share-ops.md)                                                                                                   |
| Developer API/facade                          | [`wrangler.developer-api.toml`](../cloudflare/wrangler.developer-api.toml), [`wrangler.developer-api-facade.toml`](../cloudflare/wrangler.developer-api-facade.toml) | [`config-drift-ops.md`](../cloudflare/config-drift-ops.md), [OpenAPI](../public/developers/openapi.yaml)                                                     |

## Environment namespaces

- `VITE_*` values are public browser build inputs. Never place an API key,
  bearer, pepper, signing secret, or private endpoint in this namespace.
- `MUSIXQUARE_DEV_*` values configure the local Vite server and are not Worker
  production configuration.
- Wrangler `[vars]` are checked-in, non-secret Worker configuration.
- Wrangler secrets are server-only and are provisioned only on their consuming
  Worker. Cross-Worker pairs must match only where the owning runbook says so.
- `CLOUDFLARE_*`, `GITHUB_*`, release smoke values, and drift-audit tokens used
  by Actions belong in protected GitHub environments, not `.env.local`.
- `MXQR_QA_*` values in the real-device evidence workflow are ephemeral action
  inputs used to construct the exact-SHA attestation; they are not runtime
  Worker configuration.

## Verification routes

Use the smallest focused command while iterating:

```powershell
npx vitest run src/core/__tests__/app-worker-cors.test.ts
npx vitest run src/network/transport/__tests__/cloudflare-signaling-worker.test.ts
npx vitest run src/share/__tests__/remote-share-worker.test.ts
npx vitest run src/pro-room/__tests__/pro-room-worker.test.ts
npm run check:workers
npm run check:worker-bundles
```

Before handoff, run the repository verification ladder in `CONTRIBUTING.md`.
Browser media, WebRTC network transitions, system audio, and background/resume
still require the maintained physical-device matrix; local emulation and green
E2E cannot prove those platform behaviors.
