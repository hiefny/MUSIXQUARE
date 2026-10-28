# MUSIXQUARE Design System

MUSIXQUARE is a browser-based synchronized audio system. A host creates a
room, guests join from other devices, and the room shares playback controls,
chat, local audio, YouTube, or live system audio.

The production app is a responsive PWA. Public About, Blog, History, legal,
and design-system pages share the same brand but are not part of the in-room
application shell.

## Design principles

MUSIXQUARE pursues minimal, spacious design with a toasty feel: warm, soft,
and welcoming. Concise language, clear hierarchy, rounded forms, and smooth
motion make the interface easy to follow and comfortable to use.

The foundations are typography, spacing, contrast, and predictable interaction.
Accessibility is part of those foundations, including legible text, generous
targets, keyboard access, and reduced-motion support.

These are the product's own design principles. Describe them directly; do not
infer another product's influence from a shared color, font, shape, or pattern.

## Source of truth

Use production files as the authority for implementation details:

| Area                                      | Authoritative source                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| App layout and components                 | `index.html`, `css/style.css`, `css/desktop.css`                                                              |
| Color, spacing, radius, and motion tokens | `css/style.css`                                                                                               |
| Fonts and locale fallbacks                | `css/pretendard.css`, `css/fonts/`, `fonts/README.md`                                                         |
| In-room app copy                          | `src/i18n/`                                                                                                   |
| About, policy, and Developer page copy    | `.workshop/`; About locales in `browser/classic-runtime/landing-i18n.ts`                                      |
| Other static public page copy             | The corresponding source under `public/events/`, `public/blog/`, `public/history/`, or `public/designsystem/` |
| Interaction behavior                      | `src/ui/`, `src/player/`, `src/network/`                                                                      |
| Public editorial shell                    | `public/editorial-*.css`, `.workshop/landing/`                                                                |
| Brand assets                              | `public/designsystem/assets/`, `public/favicon.svg`, `public/icons/`                                          |

Files under `src_ref/` are extraction snapshots for design archaeology, not
production source. They are not synchronized automatically. The exception is
`src_ref/pretendard.css`, which is still loaded by the public Blog, History,
and Design System pages; keep its font URL compatible with the deployed
`public/designsystem/fonts/` directory.

## Product architecture that affects design

- Production rooms use Cloudflare signaling. PeerJS is retained for localhost
  and explicitly configured development environments, not as automatic
  production failover.
- Decoded local-file buffers and received standard-room chunks remain in browser
  memory and use the AudioBuffer playback clock. YouTube uses the IFrame player,
  while system audio uses live MediaStream paths.
- Ordinary remote file sharing uses authenticated temporary whole objects in
  private Cloudflare R2 storage. PRO originals persist in a separate private R2
  bucket, while decoded browser working sets remain RAM-only.
- Standard rooms use browser-host/P2P authority. PRO room playback, playlist,
  permissions, and sleep/wake state are server-authoritative.
- The app supports light and dark themes, mobile and wide layouts, installed
  PWAs, safe-area insets, reduced motion, and keyboard navigation.

## Voice and content

The voice is friendly, direct, brief, and action-first. In-room app copy belongs
in `src/i18n/`; do not add user-facing strings directly to TypeScript or HTML
when an i18n key can express them. About, policy, and Developer editorial pages
own their English fallback in `.workshop/`, and About-page translations live in
`browser/classic-runtime/landing-i18n.ts`. Other static public pages own their
copy in the corresponding `public/` source directory.

- Address the user directly.
- Prefer short instructions and specific recovery actions.
- Describe network or browser failures without blaming the user.
- Use sentence case except for established compact badges.
- Always write the product name as **MUSIXQUARE** in user-facing UI, metadata,
  notices, and documentation. Mixed-case and standalone lowercase variants are
  not brand spellings.
- Preserve the lowercase form only inside technical identifiers whose spelling
  is fixed or case-sensitive, including domains, URLs, email
  addresses, package names, code symbols, HTTP headers, configuration and
  binding names, storage or cache keys, filenames, and paths. Do not rename
  those identifiers during a branding copy edit.
- Examples: write `MUSIXQUARE is available` in copy, while preserving
  `musixquare.com`, `contact@musixquare.com`, `MusixquareServiceControl`, and
  `X-Musixquare-Navigation-Source` as technical spellings.
- Run `npm run guard:brand-capitalization` after changing copy. If a standalone
  technical parser token cannot be inferred from its syntax, annotate that
  source line with `brand-capitalization: allow-technical`; never use the escape
  for user-facing prose.
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
- Keep every text weight at 700 or below, including titles, codes and badges.
  Heavier weights lose legibility on low-resolution screens.
- Text takes one of five weight roles and nothing else (owner decision
  2026-10-28). Title 700 (`--font-weight-title`): headings and display
  values, such as dialog, sheet and section titles, the setup greeting, the
  playlist title switch, the account title, the player track title, the
  invite code and PIN digits and the code entry digits (the guest's invite
  code entry, the room PIN entry and the manual sync value). Selected 700
  and unselected 500
  (`--font-weight-selected`, `--font-weight-unselected`): in a list or group
  where one item is selected, current or playing and turns the accent color,
  that item and every other item, such as track rows (name and index),
  device rows (name and order number) and device sub-rows, choice chips,
  the desktop settings section tabs, the bottom navigation labels and the
  language, playlist slot and transfer lists. Label 600
  (`--font-weight-label`): names on controls and markers, such as action
  button labels, badges, small meta labels and form field labels, and
  transient text, which appears because something happened and goes away
  on its own or when that moment or mode ends (owner rule 2026-10-29):
  toasts, loading and waiting lines (the header loading status that takes
  the logo's place beside the account pill, 'Syncing...' over a YouTube
  video, 'Generating QR code...'), the full-screen session message,
  progress and result lines such as 'Searching YouTube...' and 'No videos
  found', red error lines, and mode notes over a blurred panel such as
  'Sharing System Audio'. Body 400 (`--font-weight-body`): text that is
  there whenever you open the screen and stays if left alone, such as
  descriptions, dialog body text (in dialogs that close themselves too),
  hints and resting prompts, empty-list hints such as 'No media yet', chat
  messages, the small line under a name, timestamps, counters, input text
  and placeholders.
  Each rule reads its role's token itself.
- Titles and display values track by script (owner decision 2026-10-28).
  Every rule on the title weight reads `--title-letter-spacing`: -0.02em in
  Latin, Cyrillic and Greek UI languages and 0 in Korean, Japanese,
  Chinese, Thai, the Indic scripts, Arabic, Urdu, Persian and Hebrew,
  chosen with `html:lang()` on the document language. Codes and PIN digits
  keep their own wider tracking, and no other text uses a negative letter
  spacing; small uppercase labels may track wider. The body kerns its text
  with `font-kerning: normal`.
- Use tabular numerals for clocks, invite codes, counters, and latency.
- Keep compact labels legible; do not rely on extreme tracking or uppercase
  for hierarchy.
- Button labels take one of three size roles, and labels in one role differ
  only by color (owner decision 2026-10-28). Every role shares normal letter
  spacing. CTA, every action button: 15px with line height 1.25 (dialogs,
  setup, the play tab's chat preview text and Sync / Media / Stop Sharing,
  the account dialog, the connect tab, the help tab pills, manual sync, the
  YouTube link dialog, the deletion-mode Select all and the media source
  options). Chip, the choice chips (`.ch-opt`): 14px. Tab, the desktop
  settings section tabs: 13px. Action buttons take the label weight 600 in
  every size slot, including the narrow members that borrow the chip or tab
  size (the earlier 700 clumped in dark mode, Korean most of all). Choice
  chips and section tabs are selection groups and take 700 selected and 500
  unselected. Each component rule reads `--button-label-size` (or
  `--button-label-chip-size` or `--button-label-tab-size`), its weight role
  token, `--button-label-line-height`, and `--button-label-letter-spacing`
  itself; do not retype the values.
- Narrow slots stay inside the roles. A button whose CTA label wraps, splits
  a word or stacks its pair where 9.0.18 did not carries `.btn-label-compact`
  and takes the chip role's 14px in the phone layout up to 719px: Sign out
  and Delete account (always the same size) and the media source options.
  The demo finish pair's two 54px pills take the tab role's 13px on phones
  up to 420px and keep the label weight; the demo effect choice cards are
  choice chips and take 700 selected and 500 unselected. The demo tour's
  step indicator and role switch keep their own sizes and are selection
  groups too (the current step and the chosen role 700, the others 500), and
  the media source Close hides its label in the two-column 40px icon circle.
- Verify font changes with `npm run guard:font-assets` and
  `npm run guard:font-build`.

## Visual foundations

The app is dark-first, flat, and surface-driven. Light mode uses the same
semantic token structure.

- `--primary` is the signature blue and the main interactive accent.
- `--bg`, `--surface-1`, `--surface-2`, and `--surface-3` establish depth.
- `--text-main`, `--text-sub`, and `--text-muted` establish text hierarchy.
- `--divider` separates dense sections without creating card borders.
- `--danger-foreground` colors every destructive, error and validation text
  or icon, over `--control-danger` or on a plain surface (#ff3b30 in both
  default themes, #a4001d in light high contrast); never hard-code a red or
  paint text with the filled `--danger-filled`. Red surfaces use the
  `--control-danger` tints (leave session and stop sharing read its
  `--control-danger-pill` tints, Delete account its `--control-danger-dialog`
  tints of `--danger-filled`), or `--danger-filled` under white icons; white
  text on it needs its own contrast check (white on #ef4444 is 3.76:1). Only
  the YouTube mark keeps its brand red.
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

- Most buttons and interactive list rows use pill or capsule hit surfaces.
  Their component rules declare `border-radius: var(--radius-pill)` directly.
  Card-like choices, navigation tabs, underlined subtabs, and grouped chat
  bubbles keep their own geometry; do not turn `--radius-m` into a pill or add
  a global button shape override.
- Press feedback is compact and immediate; avoid long decorative motion.
- Use `:focus-visible` and retain semantic buttons, labels, and ARIA state.
- `aria-disabled` is intentional on controls that must remain clickable to
  explain why an action is unavailable.
- Slider thumbs are visually quiet while their input elements retain generous
  touch targets.
- Chat bubbles group adjacent messages by sender; embedded YouTube cards own
  their own bubble surface.
- Respect `prefers-reduced-motion` for every new animation.

### CSS ownership

`css/app.css` imports the entire app cascade before the legacy browser build
lowers its layers. Keep the order declared in `css/style.css`:

- `base`: tokens and the default component definitions.
- `desktop`: the wide dashboard's component variants.
- `components`: shared utilities, supplementary components, and RTL rules.
- `responsive`: viewport-specific layout changes.
- `states`: entrance, demo, overlay, and fullscreen states.

The `safety` layer is declared **before** these layers because `!important`
layer precedence runs in reverse. It protects accessibility and recovery
behavior. Existing base guards also protect boot, input, dragging, and editor
clear-button space; their comments explain the priority requirement.
The final `forced-colors` block stays unlayered: its normal icon paint rules
must override ordinary components alongside its important system colors.

Do not use `!important` to give ordinary layout or decoration priority. The
build rejects it in the four presentation layers after `base`. Put a default
in its component rule, a viewport variation in `responsive`, or a transient
behavior in `states`. Public editorial and administration pages own their
separate component styles and follow the same rule: keep forced priority for
explicit safety and accessibility contracts, with a reason beside the rule.

## Iconography and brand assets

The app uses inline SVG icons, with filled Material-style paths as the default.
Prefer an existing path from `index.html` before introducing a new icon.

- Inherit color through `currentColor`.
- Keep the established viewBox and optical weight of neighboring icons.
- Preserve intentional stroke or mixed-construction exceptions such as the
  reorder grip, disclosure controls, language/device diagrams, and volume
  waves; do not force them into a filled silhouette.
- Stroked marks that sit beside the filled X keep its angular construction.
  The selection check (`src/ui/selection-mark.ts`) uses butt ends and a
  mitred corner, and the selection minus, a single segment, uses butt ends.
  The playlist-row and device expand chevrons (`.expand-toggle`,
  `.device-expand-toggle`) use butt ends and a mitred corner. The chevrons
  and the minus read one 1.8 line weight from a single rule, and the minus
  draws 10 of 24 units (about 9.2px at 22px), shorter than the chevron
  beside it; the check keeps its heavier 2.4 as the selected mark. The pinned
  notice's X uses butt ends (its two strokes never join). The playlist
  switcher's title chevron (`.playlist-switch-button`) stays round, and the
  rounded stroke samples in `preview/iconography.html` are generic.
- Do not add an icon font or runtime icon dependency for a single glyph.
- Use `assets/logo-wordmark.svg` for the full custom wordmark and
  `assets/favicon.svg` for compact brand placement.
- PNGs under `public/icons/` are PWA and platform icon assets, not general UI art.

## Change checklist

When changing the visual system:

1. Update the production source first.
2. Verify light/dark, mobile/wide, keyboard focus, reduced motion, and at least
   one long translation.
3. Update `colors_and_type.css`, previews, or the local UI kit only when their
   guidance changed.
4. Keep extraction snapshots clearly non-authoritative; do not copy behavior
   back from `src_ref/` into production.
5. Run the normal typecheck, lint, tests, and production build guards.
