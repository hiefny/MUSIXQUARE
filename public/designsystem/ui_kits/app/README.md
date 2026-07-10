# MUSIXQUARE App — UI Kit

Click-through design prototype of the MUSIXQUARE PWA. It is a component sample,
not an authoritative copy of the current onboarding or room flow; verify
production behavior in `index.html` and `src/` before reusing it.

- `index.html` — full prototype (iPhone frame + app)
- `AppShell.jsx` — header + bottom nav chrome + tab routing
- `Start.jsx` — pre-session landing (`I'll host` / `Join a session` / Demo)
- `RoleSetup.jsx` — channel role picker (Center / Left / Right / Subwoofer)
- `Home.jsx` — main player tab (track info + transport + visualizer)
- `Playlist.jsx` — track list tab
- `Connect.jsx` — invite-code + connected devices tab
- `Settings.jsx` — theme + audio effects tab
- `Toast.jsx` — pill toast
- `icons.jsx` — inline Material Filled SVG icons used across the kit

All components pull tokens from `../../colors_and_type.css`.
