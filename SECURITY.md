# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to
[`contact@musixquare.com`](mailto:contact@musixquare.com). Do not open a public
issue for an unpatched vulnerability, leaked credential, private endpoint,
account identifier, or user data. The canonical machine-readable contact is
[`/.well-known/security.txt`](https://musixquare.com/.well-known/security.txt).

Include the affected URL or component, tested commit/version, impact, minimal
reproduction steps, and any suggested mitigation. Use synthetic data and
redact tokens, cookies, room credentials, media, and Cloudflare identifiers.
Do not perform denial-of-service testing, access another user's data, or
retain data beyond what is necessary to demonstrate the issue.

## Supported code

Security fixes target the current production release and the current `main`
branch. Historical commits and private forks are not maintained release lines.

## Secrets and local development

Worker runtime secrets belong in Cloudflare Worker secret storage. Release,
audit, and smoke credentials belong in protected GitHub environment or
repository secrets. Neither category belongs in Git or browser-visible `VITE_`
variables. `.env.local` and `.dev.vars` are ignored for local use, but
contributors must still use non-production values. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the safe local API boundary and the
Worker-specific configuration map.
