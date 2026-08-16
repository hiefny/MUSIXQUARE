# MUSIXQUARE App — UI Kit

Click-through design prototype of the MUSIXQUARE PWA. It is a component sample,
not an authoritative copy of the current onboarding or room flow; verify
production behavior in `index.html` and `src/` before reusing it.

- `index.html` — full prototype shell (iPhone frame + app mount)
- `/designsystem/ui_kits/app/app.js` — stable compiled browser entry
- `browser/ui-kit/app/AppShell.tsx` — header + bottom nav chrome + tab routing
- `browser/ui-kit/app/Start.tsx` — pre-session landing (`I'll host` / `Join a session` / Demo)
- `browser/ui-kit/app/RoleSetup.tsx` — channel role picker (Center / Left / Right / Subwoofer)
- `browser/ui-kit/app/Home.tsx` — main player tab (track info + transport + visualizer)
- `browser/ui-kit/app/Playlist.tsx` — track list tab
- `browser/ui-kit/app/Connect.tsx` — invite-code + connected devices tab
- `browser/ui-kit/app/Settings.tsx` — theme + audio effects tab
- `browser/ui-kit/app/Toast.tsx` — pill toast
- `browser/ui-kit/app/icons.tsx` — inline Material Filled SVG icons used across the kit

The authored TSX lives outside `public/`; Vite compiles the complete ordered
source manifest into the stable browser entry without Babel or a sourcemap.

All components pull tokens from `../../colors_and_type.css`.
