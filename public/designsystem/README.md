# MUSIXQUARE Design System

**Multi-Device Synchronized Audio System** — a web app that turns multiple
phones, tablets, and desktops into a synchronized wireless speaker array.
Guests join a host with a 6-digit code and each device picks a role
(Stereo / Left / Right / Subwoofer). Works on local network for lossless
file-sync, or across networks via YouTube Together.

- Site: **https://musixquare.com**
- Source: **github.com/hiefny/MUSIXQUARE** (MIT-compatible — see repo LICENSE)
- Locale: Korean (primary) + English
- Stack: TypeScript + Vite, Web Audio API, PeerJS (WebRTC), RAM-only storage
- Deploy: Cloudflare Workers (app worker bundles static assets + TURN/YouTube/Realtime API)

The product is a **single PWA** — there is no marketing site, no docs site,
no separate mobile app. Everything runs in one responsive web shell that
adapts to phone, tablet, and desktop breakpoints.

---

## Sources explored

| Source | What it gave us |
|---|---|
| `css/style.css` (147 KB, mobile-first) | Full token list — palette, radii, glass, motion easings, keyframes. Source of truth. |
| `css/desktop.css` | Desktop overrides (sidebar layout, larger composer). |
| `css/pretendard.css` | Font face — Pretendard Variable (SIL OFL 1.1). |
| `index.html` | DOM structure, SVG logo wordmark, icon inventory, tab/nav chrome. |
| `src/i18n/en.ts` + `ko.ts` | Every string in the app. Tone of voice = this file. |
| `src/ui/*` | Interaction patterns — dialogs, toasts, overlays, chat. |
| `public/favicon.svg` | Favicon (`M` glyph, primary blue). |
| `icons/*.png` (13 sizes, PWA) | Binary — not imported. Substituted with SVG wordmark. |

All raw reference material lives in `src_ref/` for deeper dives.

---

## Index

- `colors_and_type.css` — ready-to-use CSS variables (dark + light themes).
- `assets/` — logo wordmark, favicon.
- `preview/` — Design System tab cards.
- `ui_kits/app/` — MUSIXQUARE web app UI kit (click-thru prototype).
- `src_ref/` — raw reference CSS and HTML from the repo.
- `SKILL.md` — skill entry for Claude Code.

---

## CONTENT FUNDAMENTALS

MUSIXQUARE's voice is **friendly, direct, and low-ceremony** — the copy reads
like an app made by a thoughtful hobbyist rather than a corporate product.
Primary language is Korean; the English localization mirrors that voice.

**Person.** Second person ("you") to the user, first person contractions on
primary CTAs. The two homepage buttons are literally `"I'll host"` and
`"Join a session"` — the app speaks as the user.

**Tone.** Casual, brief, action-first. No marketing superlatives. No
"Welcome to...". Sentence fragments are fine.
- `"Listen together, anywhere / The perfect sound experience"` (tagline, 2 lines)
- `"Connect multiple devices wirelessly to create a massive audio system. Use a 6-digit code to connect."`
- `"Hi! Please choose your role."`
- `"Last step!"`

**Casing.** Sentence case for everything except:
- `OFFLINE`, `HOST-CTRL`, `SELF-CTRL`, `TAP TO PLAY` — short system badges in ALL CAPS.
- Product name always ALL CAPS: **MUSIXQUARE**.

**Microcopy quirks.**
- Questions end in `?` and feel conversational: `"Return to the start screen?"`
- Prompts are imperative: `"Please enter the 6-digit code"`, `"Press Play."`
- Status toasts are present-progressive: `"Preparing next track..."`, `"Syncing..."`, `"Loading video info..."`
- Uses ellipses liberally to signal async work (`"Just a moment..."`).
- Mixes em-dashes and periods: `"Sync failed — please try again in a moment"`

**Emoji.** None in the product. The Korean source uses a small number of
full-width punctuation marks but no emoji. Do not introduce emoji.

**Unicode niceties.** Non-breaking hyphens in "Wi‑Fi" (`Wi\u2011Fi`),
em-dashes for asides. Keep them.

**Error voice.** Apologetic-but-technical: `"Can't reach the host. Check if
you're on the same Wi‑Fi."` / `"WebRTC connection failed. Check your browser
settings."` Blame the network, not the user.

**Command syntax.** The chat has IRC-style slash commands — `/help`,
`/whisper`, `/slowmode`, `/op`, `/kick`. Keep this vocabulary if you're
extending chat.

---

## VISUAL FOUNDATIONS

**Overall vibe.** Dark-first, flat, deep. Think "premium audio hardware app"
— heavy use of near-black surfaces, one signature blue accent, no
gradients, no skeuomorphism. Secondary vibe is Toss-influenced
(the Korean fintech): floating pill buttons, generous radii, glass chrome.

**Palette — dark (default).**
| Token | Value | Role |
|---|---|---|
| `--bg` | `#121212` | App background |
| `--surface-1` | `#1A1A1A` | Cards, header, nav resting |
| `--surface-2` | `#262626` | Inputs, buttons, dividers |
| `--surface-3` | `#404040` | Hover, active |
| `--primary` | `#3b82f6` | The only accent. Blue. |
| `--text-main` | `#ffffff` | Primary text |
| `--text-sub` | `#a1a1aa` | Secondary text |
| `--text-muted` | `#71717a` | Tertiary / disabled |

**Palette — light.** Swaps to soft neutrals: `--bg: #f8f9fa`,
`--surface-1: #ffffff`, `--surface-2: #f1f3f5`, text `#212529` / `#495057` /
`#868e96`. Primary blue stays identical across themes — this is intentional
and the only accent color in the whole system.

**Type.** Pretendard Variable (weights 45–920) is the sole family. Pretendard
is a Korean-first sans that also covers Latin elegantly, with tight metrics
and good mono figures. Scale:
- **28/800 / -0.03em** — tab titles (`.tab-title`)
- **24/800 / -0.03em** — overlay headings (`.setup-header-text h2`)
- **20/700 / -0.5px** — track titles
- **16/500** — body / input text
- **14/600** — buttons, nav
- **13/500** — help text
- **12/600** — captions, time labels (tabular-nums)
- **11/700** — role badges
- **9/800 / 0.10em uppercase** — stepper counts, invite label

**Spacing.** No fixed 4px/8px grid in code — values read as 4, 8, 12, 16,
20, 24, 28, 32, 40, 56. Card padding 28–32px horizontal. Component gaps
mostly 12–16px.

**Corner radii.** Three steps: `14` / `20` / `32` — plus `50%` for circular
controls and `100px` pills for badges and FABs. Every meaningful container
is rounded; no hard corners except overlays in full-screen mode.

**Backgrounds.** Flat solid colors. **No gradients anywhere in the UI.** The
two exceptions are both functional: (a) `radial-gradient` circles that make
up the tab-action button's 36px hit target inside a 44px square, and (b)
`linear-gradient` masks that fade marquee edges. No illustrations, no
photography, no patterns, no noise textures. The visualizer canvas is the
only "imagery."

**Glass & blur.** The header and bottom nav use `backdrop-filter: blur(16px)`
over `rgba(38,38,38,0.75)` (dark) / `rgba(255,255,255,0.85)` (light). Glass
is reserved for fixed chrome — never applied to cards, modals, or buttons.

**Animation.**
- Entrance: `cubic-bezier(0.22, 1, 0.36, 1)` — emphasized decelerate.
- Interaction: `cubic-bezier(0.2, 0.8, 0.2, 1)` — generic ease-out.
- Bouncy: `cubic-bezier(0.08, 0.82, 0.17, 1)` — spring feel for toasts.
- Durations: 200ms for press-level feedback, 300ms for state changes,
  600–900ms for entrances.
- Named keyframes in `style.css`: `fadeIn`, `fadeInScale`, `modalSlideUp`,
  `bubbleIn`, `shake`, `playingWave`, `marquee-pingpong`, `wlr/wrl/wtb/wbt`
  (clip-path wipes).
- No physics, no parallax, no bounce-overshoot elastic curves.

**Hover state.** Light lift + color tint: `translateY(-2px)` + swap
`--surface-2` → `--surface-3`. Icons inside buttons switch from muted color
to `--primary` on hover.

**Press state.** `transform: scale(0.97)` + darken. Never a distinct color
tint — pressing is always "smaller + darker".

**Borders.** Almost no borders. Separation is done with surface steps. A
couple of 1px dividers use `rgba(0,0,0,0.06)` in light mode. Focused inputs
get a 2px bottom border in `--primary`. Keyboard focus rings use
`outline: 2px solid #fff` with 2px offset.

**Shadows.** **Effectively no shadow system.** `box-shadow: none !important`
appears 60+ times in the codebase. The only shadow-like effect is a
`text-shadow: 0 0 6px rgba(59,130,246,0.4)` glow on copied invite-codes, and
an `inset box-shadow` flash used to pulse a button when activated. Depth
comes from surface-step color, not shadow. **Do not add drop shadows.**

**Protection gradients.** None. Text-on-video uses solid pill-shaped
buttons (role badge is `rgba(128,128,128,0.15)` + `backdrop-filter: blur(4px)`
— a capsule, not a gradient).

**Transparency & blur.** Used very sparingly: header, nav, toasts, role
badge, dialog backdrop. Cards and inputs are always solid.

**Cards.** Solid `--surface-1` background, `--radius-m` (20px), no border,
no shadow. Padding 20–28px. Section groups have a header row
(title + optional `HOST-CTRL` / `SELF-CTRL` badge) separated by 12px from the
content.

**Layout rules.**
- Fixed chrome: `<header>` top (60px + safe-inset), `.bottom-nav` bottom
  (pill tabbar).
- Desktop: nav collapses to a left sidebar centered vertically.
- Mobile: single-column scrollable tab body, max-width derived from
  viewport.
- Generous outer padding (24px min) so content never hits the edge.

**Imagery.** The app doesn't ship any marketing imagery. The only visuals
are:
- Material-style filled SVG icons (24×24, viewBox `0 0 24 24`).
- Role diagrams in the setup overlay (simple monochrome SVG).
- The live audio visualizer (circular or spectrum, driven by Web Audio).

If you need a hero image, you're designing outside the existing system —
ask the user.

---

## ICONOGRAPHY

**System used.** Google Material Icons (Filled). Every icon in `index.html`
is a 24×24 SVG with a `viewBox="0 0 24 24"`, single `<path>`, and
`fill="currentColor"`. A handful use the Material Symbols viewBox
`0 -960 960 960` (the EQ bars). These are all copy-pasted inline — there is
no icon font, no sprite sheet, no external icon package.

**How to add icons in this system.**
1. Prefer copying the exact Material Icon SVG path already used in
   `index.html` (see DOM grep of `viewBox="0 0 24 24"`).
2. If you need a new icon, pull from **Material Icons (Filled)** on the web
   — the visual style (solid fills, no stroke, chunky proportions) is the
   match.
3. All icons inherit color via `fill="currentColor"`. Never hard-code
   `#3b82f6` or any other color on the icon itself.
4. Sizes: 18px (sidebar nav on desktop), 20px (inline), 24px (default),
   28–40px (large buttons).
5. Icons in buttons are always left of the label with a 12px gap.

**Emoji.** Not used. Do not introduce.

**Unicode glyphs as icons.** Used in exactly one place: the language picker
uses the characters `가` (Hangul placeholder) and `A` (Latin placeholder)
rendered as `<text>` inside an SVG at font-weight 700, as a language-sample
icon. This is a deliberate pattern and is fine to reuse for
language/alphabet selection.

**Substitution note.** The 13 PNG app icons in `icons/` (sizes 16–512) are
PWA manifest icons only — they're the favicon rendered at different sizes.
They're **not** imported into this design system because they're binary and
we already have the vector source in `assets/favicon.svg` and
`assets/logo-wordmark.svg`. Use the SVG wordmark for any brand placement.

**Logo.**
- `assets/logo-wordmark.svg` — the full "MUSIXQUARE" wordmark (custom
  geometric letterforms, not a font). Use this for headers and hero
  placements. `fill="currentColor"` so it inherits.
- `assets/favicon.svg` — the "M" glyph on its own, primary blue `#3b82f6`.
  Use for favicons, tab icons, compact placements.
- No secondary lockup, no tagline lockup, no logo-with-icon combo exists
  in the source. Flag any new combinations.

---

## Fonts

**Font:** Pretendard Variable, `45–920` weight axis, SIL OFL 1.1.
Self-hosted at `fonts/PretendardVariable.woff2`.

---

## Caveats / open questions

1. **No `scripts/` directory accessible** on GitHub for the font-fetch
   script — CDN fallback in use.
2. **`icons/*.png` (PWA icons) not imported** — they're binary. If you want
   them copied in, say so and I'll pull them as a batch.
3. **No marketing imagery exists** in the product. Any hero / OG imagery
   is out-of-system and needs design work from scratch.
4. **Korean primary.** Several strings are longer in Korean than English —
   when designing new components, reserve 1.3× horizontal space for labels.
