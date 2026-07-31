# MUSIXQUARE Design System

MUSIXQUARE is a browser-based synchronized audio system. A host creates a
room, guests join from other devices, and the room shares playback controls,
chat, local audio, YouTube, or live system audio.

The production app is a responsive PWA. Public About, Blog, History, legal,
and design-system pages share the same brand but are not part of the in-room
application shell.

## Source of truth

Use production files as the authority for implementation details:

| Area                                      | Authoritative source                                          |
| ----------------------------------------- | ------------------------------------------------------------- |
| App layout and components                 | `index.html`, `css/style.css`, `css/desktop.css`              |
| Color, spacing, radius, and motion tokens | `css/style.css`                                               |
| Fonts and locale fallbacks                | `css/pretendard.css`, `css/fonts/`, `fonts/README.md`         |
| Product copy                              | `src/i18n/`                                                   |
| Interaction behavior                      | `src/ui/`, `src/player/`, `src/network/`                      |
| Public editorial shell                    | `public/editorial-*.css`, `.workshop/landing/`                |
| Brand assets                              | `public/designsystem/assets/`, `public/favicon.svg`, `icons/` |

Files under `src_ref/` are extraction snapshots for design archaeology, not
production source. They are not synchronized automatically. The exception is
`src_ref/pretendard.css`, which is still loaded by the public Blog, History,
and Design System pages; keep its font URL compatible with the deployed
`public/designsystem/fonts/` directory.

## Product architecture that affects design

- Production rooms use Cloudflare signaling. PeerJS is retained for localhost
  and explicitly configured development environments, not as automatic
  production failover.
- Browser media transfer and playback are RAM-only and use the shared
  AudioBuffer playback clock. Do not introduce a browser-specific playback
  presentation without reviewing the storage and synchronization ADR.
- Remote file sharing uses authenticated temporary whole objects in private
  Cloudflare R2 storage; read authority is delivered only to room participants.
- The app supports light and dark themes, mobile and wide layouts, installed
  PWAs, safe-area insets, reduced motion, and keyboard navigation.

## Voice and content

The voice is friendly, direct, brief, and action-first. Product copy belongs in
`src/i18n/`; do not add user-facing strings directly to TypeScript or HTML when
an i18n key can express them.

- Address the user directly.
- Prefer short instructions and specific recovery actions.
- Describe network or browser failures without blaming the user.
- Use sentence case except for established compact badges.
- Keep the product name uppercase: **MUSIXQUARE**.
- Do not introduce decorative emoji into product UI.
- Preserve deliberate punctuation and non-breaking hyphens in translations.

Translations vary substantially in length. Test controls with Korean, German,
and other longer labels instead of sizing from English alone.

## Typography

Pretendard Variable is the primary face for Latin and Korean. The complete font
is self-hosted so arbitrary Korean chat text does not fall back glyph by glyph
to a platform font. Japanese, Simplified Chinese, Traditional Chinese, Thai,
and Cyrillic use locale-specific self-hosted Noto fallback shards where
Pretendard lacks coverage.

- Use the existing variable-weight range instead of separate font files.
- Use tabular numerals for clocks, invite codes, counters, and latency.
- Keep compact labels legible; do not rely on extreme tracking or uppercase
  for hierarchy.
- Verify font changes with `npm run guard:font-assets` and
  `npm run guard:font-build`.

## Visual foundations

The app is dark-first, flat, and surface-driven. Light mode uses the same
semantic token structure.

- `--primary` is the signature blue and the main interactive accent.
- `--bg`, `--surface-1`, `--surface-2`, and `--surface-3` establish depth.
- `--text-main`, `--text-sub`, and `--text-muted` establish text hierarchy.
- `--divider` separates dense sections without creating card borders.
- Reuse the existing radius, safe-area, motion, and range-control tokens from
  `css/style.css`; do not duplicate token values in feature styles.

Depth comes primarily from surface contrast. Shadows and blur are reserved for
places where they communicate layering, such as dialogs, fixed chrome, and
temporary overlays. Gradients in the app are functional—slider fills, masks,
or visualization effects—not decorative backgrounds.

## Layout

Mobile uses one active tab with its own scrolling body and fixed navigation.
Compact landscape uses a sidebar arrangement. At wide desktop sizes, Play,
Playlist/Chat, and Settings occupy a three-column dashboard.

- Respect `--app-height` and safe-area variables instead of adding raw
  viewport-height assumptions.
- Keep headers outside scrolling bodies where the current layout does so.
- Preserve at least a 44px interactive target even when the visible control is
  smaller.
- Test overlays with the software keyboard, iOS PWA safe areas, and short
  landscape viewports.

## Components and interaction

- Buttons use pill or capsule hit surfaces unless they are list rows or
  card-like choices.
- Press feedback is compact and immediate; avoid long decorative motion.
- Use `:focus-visible` and retain semantic buttons, labels, and ARIA state.
- `aria-disabled` is intentional on controls that must remain clickable to
  explain why an action is unavailable.
- Slider thumbs are visually quiet while their input elements retain generous
  touch targets.
- Chat bubbles group adjacent messages by sender; embedded YouTube cards own
  their own bubble surface.
- Respect `prefers-reduced-motion` for every new animation.

## Iconography and brand assets

The app uses filled Material-style inline SVG icons. Prefer an existing path
from `index.html` before introducing a new icon.

- Inherit color through `currentColor`.
- Keep the established viewBox and optical weight of neighboring icons.
- Do not add an icon font or runtime icon dependency for a single glyph.
- Use `assets/logo-wordmark.svg` for the full custom wordmark and
  `assets/favicon.svg` for compact brand placement.
- PNGs under `icons/` are PWA and platform icon assets, not general UI art.

## Change checklist

When changing the visual system:

1. Update the production source first.
2. Verify light/dark, mobile/wide, keyboard focus, reduced motion, and at least
   one long translation.
3. Update `colors_and_type.css`, previews, or the UI kit only when their public
   guidance changed.
4. Keep extraction snapshots clearly non-authoritative; do not copy behavior
   back from `src_ref/` into production.
5. Run the normal typecheck, lint, tests, and production build guards.
