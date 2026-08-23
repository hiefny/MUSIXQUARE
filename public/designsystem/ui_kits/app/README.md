# MUSIXQUARE App UI Kit

This is a click-through component sample, not an authoritative or complete copy
of the current onboarding, room, settings, or playback flows. Before reusing a
pattern, verify its production behavior in `index.html`, `css/style.css`, and
`src/ui/`.

The sample currently demonstrates:

- solid header and edge-to-edge bottom navigation chrome;
- all five production portrait navigation glyphs, including Help;
- a 64px playback action with a 28px filled icon;
- playlist capsules with source glyphs, current play/pause state, reorder affordance, and remove action;
- flat, divider-separated General settings sections and two-column choice cards;
- a dedicated leave-session action, separate from the header account badge;
- the filled-first icon language plus intentional stroked exceptions such as language, device, and reorder glyphs.

Files:

- `index.html` — prototype shell and phone frame;
- `/designsystem/ui_kits/app/app.js` — generated browser entry;
- `browser/ui-kit/app/AppShell.tsx` — header, sample bottom navigation, and tab routing;
- `browser/ui-kit/app/Start.tsx` — prototype-only pre-session landing;
- `browser/ui-kit/app/RoleSetup.tsx` — prototype-only role picker;
- `browser/ui-kit/app/Home.tsx` — player sample;
- `browser/ui-kit/app/Playlist.tsx` — current playlist-row anatomy sample;
- `browser/ui-kit/app/Connect.tsx` — invite and device-list sample;
- `browser/ui-kit/app/Settings.tsx` — General settings anatomy sample;
- `browser/ui-kit/app/Toast.tsx` — solid capsule toast sample;
- `browser/ui-kit/app/icons.tsx` — inline SVG examples.

The portrait header intentionally shows the role/account badge without a second
Help action; Help belongs to the fifth bottom tab. The badge only raises a sample
toast here because the production account dialog is outside this prototype.

The authored TSX lives outside `public/`. Vite compiles the ordered source
manifest into the stable browser entry without Babel or a sourcemap. The sample
loads the public design-system token sheet, but production source remains the
contract whenever the two differ.
