# Image backgrounds and compatible screensaver effects — 2026-10-16

## Scope and source

The owner approved the local all-image background comparison and requested its
integration and production deployment. Implementation starts from `44a58c453e1a9de755c02b4521ae3e2b666ba2fb`
(App 8.11.3 / cache v700). The release advances App to 8.11.4 and cache to v701.
Only the App target changes; no service binding, secret, database, protocol,
permission, CSP, or third-party dependency changes are required.

The approved local prototype is `ambient-display-compatible-v4-images.html`,
SHA-256 `a4d4cb35c5729088490d07709e54c7b6e1401065ec1c604ef2ecce10a8283117`.
Its foreground compatibility renderer and image backgrounds are ported to the
strict TypeScript auxiliary entry instead of shipping the prototype's debug
globals, comparison controls, or inline scripts.

## Resulting behavior

Clock, date, weather, air quality, and moon use the same decoded-image background
pipeline. The clock image captures the original blue gradients and three blurred
lights at their starting position. The lights no longer move independently.
Seasonal/weather/night photos include their original blur, brightness, saturation,
and veil. AQI colors are baked in the same way. Foreground glyphs, moon,
directional trails, glow, grain, and scene transitions remain separate.

The asset bank contains 23 scene/brightness combinations and 139 viewport variants,
totalling 2,422,698 bytes of WebP quality 96 images. It includes cloudy storm day
and night variants. Six main aspect/size variants cover portrait, large portrait,
landscape, classic, wide, and square screens; the clock also has a tiny variant.
Intermediate sizes use cover cropping, so these are not pixel-identical
reconstructions at every possible aspect ratio.

`browser/screensaver-backgrounds.ts` supplies a compact typed manifest. Files
under `/assets/screensaver/backgrounds/` carry eight-character content hashes,
using the existing immutable HTTP/service-worker asset path. The manifest is
bundled into the auxiliary renderer loaded by the command, not the app entry.
Background images are selected and loaded on demand; the complete bank is not
preloaded or included in the application shell.

The existing local command, YouTube exclusion/forced exit, fullscreen restoration,
entry/exit fades, translated back button, music footer, five-second controls idle
timer, location consent, English slide content, and provider attribution remain.
The previous canvas-filter implementation did not produce the intended glow in
Windows WebKit. The port uses cached glyph rendering and CSS compositor layers
for compatible transitions, retaining the approved blue appearance.

## Verification

Final committed-source checks and integration evidence are recorded here before
release. Local browser checks are automated desktop Chromium/WebKit checks and
do not establish physical iPhone Safari behavior, real weather observations,
or audible multi-device synchronization.

The earlier prototype benchmark compared static background phase zero in an
ABBA sequence with unchanged foreground transitions. Windows WebKit landscape
median frame intervals changed from 158 to 120 ms (clock), 174 to 79 ms (weather),
and 202 to 116 ms (clock/weather crossfade). Chromium was about 16.7 ms for both
variants. These are prototype comparison results, not measurements of the
integrated production application or a physical iPhone.

## Release and recovery

Production uses a reviewed PR, successful exact-main push CI candidate, and the
normal `Production Release` workflow with `target=app` and
`apply_developer_api_d1=false`. The deployment identifiers, public asset checks,
and recovery checkpoint will be recorded after that workflow completes.

An authorized rollback restores the previous screensaver renderer/background
approach. No stored data or wire contract changes; existing release ownership and
compatibility floors still apply. Original local comparison files and the primary
checkout's uncommitted diagnostic documentation are preserved.
