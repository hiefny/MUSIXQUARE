# MUSIXQUARE App — UI Kit

Click-thru recreation of the MUSIXQUARE PWA. Shows the host onboarding → role
setup → home player → settings flow.

- `index.html` — full prototype (iPhone frame + app)
- `AppShell.jsx` — header + bottom nav chrome + tab routing
- `Start.jsx` — pre-session landing (`I'll host` / `Join a session` / Demo)
- `RoleSetup.jsx` — channel role picker (Center / Left / Right / Subwoofer)
- `Home.jsx` — main player tab (track info + transport + visualizer)
- `Playlist.jsx` — track list tab
- `Connect.jsx` — invite-code + connected devices tab
- `Settings.jsx` — theme + audio effects tab
- `Toast.jsx` — glass pill toast
- `icons.jsx` — inline Material Filled SVG icons used across the kit

All components pull tokens from `../../colors_and_type.css`.
