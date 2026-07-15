# Cloudflare Access For Admin

This runbook defines the intended Cloudflare Access boundary for the
MUSIXQUARE administrator UI and API. Access is an outer identity gate; the
existing MUSIXQUARE administrator password and session cookie remain enabled
as a second, independent authentication layer.

## Application

Create one self-hosted Access application named `MUSIXQUARE Admin` with a
12-hour application session. Protect exactly these paths on both hostnames:

| Host                 | Paths                                |
| -------------------- | ------------------------------------ |
| `musixquare.com`     | `/admin`, `/admin/*`, `/api/admin/*` |
| `www.musixquare.com` | `/admin`, `/admin/*`, `/api/admin/*` |

Do not replace these path entries with a site-wide wildcard. In particular,
the public app shell, static assets, blog, `/api/announcement/current`,
`/api/security-config`, `/api/capability-*`, media-service APIs, signaling, and
the remote-share `/session` endpoint must remain outside this Access
application. The public `admin.js` and `admin.css` assets do not contain
credentials and do not need a separate Access path; the protected page and API
are the security boundary.

## Policy

Create one `Allow` policy with both of the following conditions:

- Include: email equals `hevc@kakao.com`.
- Require: login method is `One-time PIN`.

Both conditions are required. A policy that only requires `One-time PIN` would
allow any email address that can complete an OTP challenge. Do not remove or
bypass the app's existing password login after Access is enabled.

## Activation Safety

Cloudflare may require activating a Zero Trust plan before an Access
application can be created. Even a free plan may present terms authorizing
charges for usage beyond the free allowance. Do not accept billing terms,
activate the plan, or authorize a saved payment method without explicit owner
approval.

Record the Access application ID and the activation date in the private
operations record after activation. Do not commit account tokens, OTPs,
passwords, or payment details to this repository.

## Verification

Verify in a private browser session before considering the change complete:

1. `/admin` and `/api/admin/session` are blocked or redirected to Cloudflare
   Access while signed out.
2. Signing in as `hevc@kakao.com` with One-time PIN reaches the existing
   MUSIXQUARE password screen, rather than an authenticated admin dashboard.
3. Before entering the MUSIXQUARE password, protected admin data such as
   `/api/admin/metrics` still returns the app's unauthorized response.
4. After entering the MUSIXQUARE password, the dashboard and its admin APIs
   work normally.
5. `/`, `/blog`, `/api/announcement/current`, capability/session creation,
   signaling, and remote sharing remain usable without an Access login.
6. Repeat the administrator and public-route checks on both the apex and
   `www` hostnames.

Keep the existing internal password login test in the release smoke checks;
Access success alone is not sufficient authentication.

## Rollback

If Access blocks legitimate administration or affects public traffic, delete
the `MUSIXQUARE Admin` Access application. This removes the outer gate and
immediately restores the existing password-only administrator flow; no Worker
rollback is required. Then verify `/admin`, `/api/admin/session`, and the public
routes above again.

Deleting the Access application does not remove the internal MUSIXQUARE
password or its session handling. Do not weaken that second layer as part of
an Access rollback.
