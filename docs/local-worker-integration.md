# Local Worker Integration and Environment Boundaries

This guide is the public, non-secret map for local development. Production
Worker runtime secret-name expectations remain canonical in
[`cloudflare/ops-drift.contract.json`](../cloudflare/ops-drift.contract.json),
and live values must never be copied into a checkout.

## Choose the smallest boundary

| Task                                                            | Start                                               | Credentials                             | What it proves                                                           |
| --------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| Browser UI and playback/state work before protected setup flows | `npm run dev`                                       | None                                    | Vite UI and localhost PeerJS selection                                   |
| Deterministic Worker behavior                                   | The focused Vitest file                             | None                                    | Request, binding, timeout, and failure contracts with in-memory fixtures |
| One Worker in a local runtime                                   | `npm run wrangler -- dev --local --config <config>` | Local-only values for that Worker       | Workerd compatibility and that Worker's standalone routes                |
| Cross-Worker behavior                                           | Relevant integration tests                          | Never production values in the checkout | Contract composition                                                     |

A single `wrangler dev` process is not a complete MUSIXQUARE stack. App, PRO,
signaling, remote-share, Developer API, and service-control paths use service,
Durable Object, D1, and R2 bindings owned by different deployments. Prefer the
existing multi-boundary fixtures over silently replacing a missing binding
with production.

## Browser-oriented default

```powershell
corepack npm ci
npm run dev
```

The safe Vite-server default is
`MUSIXQUARE_DEV_PROXY_PRODUCTION_API=false`. Its six explicit production-proxy
routes return `503 LOCAL_API_PROXY_DISABLED`; any other unconfigured relative
`/api/*` route returns `503 LOCAL_API_NOT_CONFIGURED`. Vite does not fall
through to SPA HTML for either case. Copy `.env.example` to ignored
`.env.local` only for an intentional override.

This protects Vite-relative routing, and the browser API clients also fail
closed on loopback by default. When `VITE_PRO_ROOM_ENDPOINT` is absent or
invalid, PRO resolves to the same-origin `/api/pro-room` facade; TURN and
Realtime try only their relative same-origin routes. With an ordinary local
Vite server, those unconfigured requests therefore receive the local `503`
boundary instead of retrying `https://musixquare.com`.

A non-E2E loopback build reaches the canonical production APIs only when
`VITE_MUSIXQUARE_ALLOW_LOCAL_PRODUCTION_API_FALLBACK` resolves to the exact
`true` string after trim/case normalization. E2E builds ignore that implicit
fallback flag, while a separately validated
`VITE_PRO_ROOM_ENDPOINT` remains an explicit routing decision and takes
precedence. Public production and staging origins retain their canonical
fallback. For an isolated test, mock the relative path or provide a validated
local endpoint before entering the flow. See the
[configuration reference](configuration-reference.md) for the exact matrix.

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

The complete public variable catalog, accepted values, fallback behavior, and
test/operator separation are maintained in
[`configuration-reference.md`](configuration-reference.md). Worker runtime
secret-name expectations remain single-sourced in
`cloudflare/ops-drift.contract.json`; workflow/operator credentials remain owned
by their workflows and runbooks rather than duplicated here.

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
cannot be fully proven on specific hardware by local emulation or green E2E.
