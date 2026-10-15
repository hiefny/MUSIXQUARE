# Lazy ambient screensaver — 2026-10-16

| Field | Value |
| --- | --- |
| Status | Implementation and local verification; production evidence pending |
| Source baseline | `60148998acca59295963764a5286a155e0aa4256`, temporary branch `agent/screensaver` |
| Product / cache | `8.11.0` / `v694` |
| Release scope | App only; Developer API D1 application disabled |
| Authorization | Owner requested implementation and production deployment on 2026-10-16 |

## Behavior and boundaries

`/screensaver` (also `/스크린세이버`) is a local command available to room members.
The chat command emits a local UI intent; the chat UI dynamically imports the
host controller, then loads a same-origin document and
its separately compiled strict TypeScript renderer. No screensaver document,
renderer, background, font, or weather request is part of the initial App graph
or service-worker precache. Closing removes the frame, state subscriptions, and
subtitle observer. Playback state and room messages are not changed.

The preserved source is `ambient-display-v5.html`, SHA-256
`7e07e0eddb767f89e891ed3473595a52f3b049b70a912cce1cc2ab7adff0c3f0`.
That standalone source remains untouched. The migrated renderer retains clock
afterglow, vector seconds morphing, large moon, proportional layout, English
information scenes, and decoded-background crossfades.

The host rejects a selected YouTube mode or YouTube track, even while paused or
pending. Either state changing to YouTube immediately disposes the active
screensaver and shows the same translated toast. This follows YouTube's
[overlays and frames requirement](https://developers.google.com/youtube/terms/required-minimum-functionality#overlays-and-frames),
which prohibits obscuring any part of an embedded player. Local files and system
audio remain available.

Back and Show music info controls fade after five seconds of pointer inactivity,
return on input, and remain visible during keyboard focus. Back/Escape restore
the previous usable focus. The toggle defaults on and persists only on this
device. A music scene appears immediately before clock in the ten-second cycle
when a usable title exists; its secondary text comes from the existing App
track subtitle (codec, bitrate, or system capture profile). Long titles scroll.
Back, toggle, and YouTube refusal have 42 locale translations; information scenes
remain English and use Google Sans. The original third-party notices are retained.

## Security and compatibility

Only App documents (root, index, locale entries, and room invites) enable self
geolocation and same-origin frames. The screensaver document has a separate CSP:
same-origin external script, Google Fonts styles/fonts, Open-Meteo weather and air
endpoints, data images, no child frames/workers/media, and self-only embedding.
The iframe delegates geolocation/fullscreen, uses a scripts/same-origin sandbox
with popup permission for the user-clicked external attribution link,
and both bridge directions validate origin and WindowProxy identity. No arbitrary
HTML from track metadata is rendered.

The visited document can be reused offline, but its service-worker navigation
fallback never substitutes the main App inside the frame. The build binds each
HTML document to its content-hashed renderer URL so an active older service worker
cannot return a stale runtime under a newer document. Weather requests use
`no-store`. New location access still requires the browser's user permission.
The privacy page discloses the direct Google Fonts/Open-Meteo requests, rounded
in-memory coordinates, local music preference, and browser permission controls.
No npm dependencies, API protocol, schema, secret, binding, or recovery floor is
added. Mixed App versions are compatible. Rolling back the App removes the
feature while the local toggle preference is harmless.

## Verification

Local environment: Windows, Node 24.13.1, npm 11.8.0, repository test tooling.
The configured CI toolchain is Node 24.20.0 / npm 12.0.2; local results do not
replace that exact candidate. Initial focused
checks on the baseline plus working changes: translation parity/token/toast
policies 52 pass; command suite 52 pass; host lifecycle suite 21 pass; scoped CSP,
SW caching and auxiliary compiler checks 150 pass. These are branch tests, not
an exact-main production candidate.

The first whole-project typecheck found a test passing a command name instead of
the parsed command; corrected. Initial focused lint found an optional promise
chain and an empty storage catch in the host; corrected without weakening rules.
Independent review reproduced and fixed a BFCache/font warmup race (two animation
loops became one) and duplicate weather listener registration. A cache-pair review
replaced the initial stable renderer URL with a content-hashed URL. Initial
browser runs exposed a first-payload scene race and two incorrect test assumptions
(case-sensitive scene label and exact focus target); the corrected focused six
browser cases passed. Source-engine regression passed 84/84 with the original
rendering fixtures, followed by weather 21/21 after adding no-store.

The initial full unit run found command autocomplete ordering (three assertions),
privacy date/sitemap alignment (two), import layering (one), and Worker coverage
inventory (one). Fixed by preserving existing command order, updating the dated
sitemap, routing the command through a typed UI intent, and including the Worker
security suite in its coverage profile. Corrective host/chat/graph/CI checks:
228 pass; privacy 11 pass. These early failures remain distinct from final gates.

Full gate and browser evidence will be recorded after completion. Real phone
hardware, live YouTube playback, live system capture, and all 42 locales' visual
layout have not been tested by these synthetic checks.

## Release and recovery

Pending successful PR review, exact merged-main CI candidate, App Production
Release, live smoke, and deployment identity verification. No production success
is claimed by this implementation report.
