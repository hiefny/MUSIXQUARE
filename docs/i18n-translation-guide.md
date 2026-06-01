# MUSIXQUARE — Translation Guide

A reference for translating `src/i18n/<lang>.ts` locale files — whether by AI, a
contributor, or a native reviewer. Born from a real failure: machine translations
rendered context-free one-word UI labels with the **wrong sense** of a homonym
("Right" → *correct*, "Kick" → *football*, "Grant" → *subsidy*). This guide exists
to prevent that. **The glossary in §4 is the most important part — read it.**

> **About the app (give this context to any translator/LLM):** MUSIXQUARE turns
> several phones/laptops in the same room into one synchronized multi-speaker
> sound system. Devices take **roles** (Left / Right / Center / Subwoofer), a
> **host** invites others into a **session/room** via code or QR, and everyone
> hears the same audio in sync. Most ambiguous words below come from this domain.

---

## 1. File format

Each locale is a flat TypeScript dictionary. Keys are fixed; only the string
values are translated.

```ts
import type { I18nKey } from './ko.ts';

const xx: Record<I18nKey, string> = {
  'common.ok': '...',
  'common.cancel': '...',
  // ... every key from ko.ts, in the same order
};

export default xx;
```

`ko.ts` is the key source-of-truth; `en.ts` is the English reference value for
each key. `Record<I18nKey, string>` makes TypeScript **fail the build if any key
is missing** — so a complete file must define every key.

---

## 2. Hard rules (never break these)

1. **Preserve every `{{placeholder}}` token exactly** — do not translate, space,
   or reorder the letters inside. The full set in use:
   `{{cmd}}` `{{code}}` `{{count}}` `{{idx}}` `{{label}}` `{{max}}` `{{msg}}`
   `{{name}}` `{{pct}}` `{{sec}}` `{{status}}` `{{target}}` `{{time}}`
   `{{usage}}` `{{val}}`
2. **Preserve `\n` newlines** and any leading/trailing spaces inside multi-line
   messages.
3. **Never translate** brand/technical tokens:
   `MUSIXQUARE` · `YouTube` · `Cloudflare` · `QR` · `API` ·
   `HOST-CTRL` · `SELF-CTRL` · and units `Hz` `kHz` `dB` `ms` `%` (+ the numbers).
4. **Ellipsis = three ASCII periods `...`**, never the single `…` (U+2026)
   character. (Keeps the codebase consistent.)
5. **Escape apostrophes** for a single-quoted JS string (`'it\'s'`) or use the
   language's typographic quote (`'`, `’`, `»`). A raw `'` inside `'...'` breaks
   the build.
6. **Keep ALL-CAPS** only where the target script has letter case (Latin,
   Cyrillic, Greek). Caseless scripts (CJK, Arabic, Hebrew, Devanagari, Thai)
   ignore it. Caps source values: `youtube.tap_to_play` = "TAP TO PLAY",
   `chat.system_sender` = "SYSTEM".

---

## 3. Tone & conventions

- **Register:** friendly and casual — this is a consumer party/music app, not
  enterprise software.
- **Buttons & labels:** short and idiomatic. Use the imperative or a noun as your
  language's UI convention dictates — **not** dictionary infinitives ("Stop", not
  "To stop").
- **Greetings** (`setup.hello_select_role` "Hi! Please choose your role."): use a
  natural casual local greeting. For CJK/East-Asian languages a literal "Hello!"
  reads jarring at app start — prefer the idiomatic onboarding/welcome phrasing.
- **`demo.session_title`** (en: "This is room {{code}}.") → translate to the
  natural **"Your room: {{code}}"** form, not the literal "This is room X."
- **One word for "admin":** pick a single term for the admin/operator role and use
  it consistently across every key (`common.grant`, `chat.cmd_d_op`,
  `toast.operator_required`, `network.op_granted`, …). Don't alternate
  admin/operator/manager.
- **Decimals:** follow your locale's separator in prose, but keep unit tokens
  intact (`0.1s`, `20.0kHz`, `20Hz`).

---

## 4. ⚠️ Ambiguous-term glossary (the homonym traps)

These short labels lack sentence context, so an LLM easily picks the wrong sense.
Use the **Means** column; avoid the **✗** column (those are *real* errors seen in
the first machine pass).

| Key(s) | English | Means | ✗ Wrong sense to avoid |
|---|---|---|---|
| `common.right`, `role.right` | Right | **right-hand side** (speaker position) | "correct / yes / OK / sure" |
| `common.left`, `role.left` | Left | **left-hand side** | past tense of *leave*; "remaining" |
| `common.on` | On | toggle state **enabled / powered on** | preposition "on / upon / atop" |
| `common.off` | Off | toggle state **disabled** | "away / distant" |
| `common.grant`, `chat.cmd_d_op` | Grant admin | **verb: give** someone the admin role | noun "a grant / subsidy / funding" |
| `common.revoke`, `chat.cmd_d_deop` | Revoke admin | **verb: take away** the admin role | "annul / invalidate" (too legalistic) |
| `connect.kick_*`, `chat.cmd_d_kick`, `toast.device_kicked` | Kick | **eject / remove** a device from the session | physical "kick / strike / football" |
| `player.seek` | Seek | **scrub** the playback position | "search / look for" |
| `player.play_media`, `player.play_together`, `player.play_speakers` | Play | **play back media (audio)** | "play a game / have fun / frolic" |
| `common.mix` | Mix | **audio mix** (combine sources) | "stir / blend (cooking)" |
| `common.original` | Original | **unprocessed audio** (effects off) | "novel / creative / first-ever" |
| `common.peer` | Peer | **network peer** (another device) | "nobleman / aristocrat / equal-rank" |
| `common.stay` / `common.leave` / `settings.leave_session` | Stay / Leave | **remain in** / **exit** the session | "stay (lodging)" / "leave (vacation/permission)" |
| `settings.light` / `settings.dark` | Light / Dark | **bright / dark UI theme** | "lamp / illumination" / "evil / scary" |
| `settings.eq_warm` / `settings.eq_bright` | Warm / Bright | **audio tonality** | temperature / intelligence |
| `nav.home`, `nav.go_home` | Home | **home screen** | "house / residence" |
| `common.woofer`, `role.subwoofer` | Woofer / Subwoofer | audio term — use the standard **loanword/transliteration** | literal "barker" |
| `settings.host_ctrl` / `settings.self_ctrl` | HOST-CTRL / SELF-CTRL | **keep as-is** (UI abbreviation) | translating the abbreviation |

---

## 5. Ready-to-paste LLM prompt

Fill in the language, paste the English key→value pairs you want (re)translated
after the last line, and run it.

```text
You are localizing the UI of MUSIXQUARE — a web app that turns several phones and
laptops in the same room into one synchronized multi-speaker sound system. Devices
take roles (Left / Right / Center / Subwoofer); a host invites others into a
session/room by code or QR; everyone hears the same audio in sync.

Translate the English UI strings at the bottom into: <LANGUAGE> (<native name>).

Output rules:
- Output ONLY lines of the form  'key': 'translation',  — same keys, same order.
- Preserve every {{placeholder}} token exactly (don't translate/space/reorder it).
- Preserve \n newlines and leading/trailing spaces.
- Never translate: MUSIXQUARE, YouTube, Cloudflare, QR, API, HOST-CTRL, SELF-CTRL,
  or units (Hz, kHz, dB, ms, %).
- Use ... (three periods) for ellipsis, never the … character.
- Escape an apostrophe inside the value as \' (or use the language's curly quote).
- Tone: friendly, casual — a party/music app. Labels short & idiomatic (imperative
  or noun per your language's UI norm, not dictionary infinitives).

These short labels are AMBIGUOUS. Use the intended meaning, NOT the wrong sense:
- Right / Left  = speaker SIDE (right-hand / left-hand), not "correct" or "departed"
- On / Off      = toggle state (enabled / disabled), not the preposition "on"
- Grant / Revoke admin = give / take away the admin ROLE (verbs), not a "subsidy"
- Kick          = eject a device from the session, not a physical kick/football
- Seek          = scrub the playback position, not "search"
- Play          = play back audio/media, not "play a game"
- Mix           = audio mix, not "stir/blend"
- Original      = unprocessed audio (effects off)
- Peer          = a network peer device, not "nobleman"
- Stay / Leave  = remain in / exit the session
- Light / Dark  = UI theme names
- Home          = the home screen, not a house
- Woofer/Subwoofer = standard audio loanword

Strings to translate:
<paste 'key': 'English value', lines here>
```

---

## 6. Re-translating the existing AI locales (trap keys)

For the machine-translated locales (`ar`, `fil`, `hi`, `it`, `pl`, `ru`, `tr`) the
bulk is fine — only the trap keys below need re-doing. Paste these English sources
into the §5 prompt, then drop the results back into each file:

```
'common.left': 'Left',
'common.right': 'Right',
'common.on': 'On',
'common.off': 'Off',
'common.grant': 'Grant admin',
'common.revoke': 'Revoke admin',
'common.mix': 'Mix',
'common.original': 'Original',
'common.peer': 'Peer',
'common.stay': 'Stay',
'common.leave': 'Leave',
'role.left': 'Left',
'role.right': 'Right',
'player.seek': 'Seek',
'player.play_together': 'Play together',
'player.play_speakers': 'Play through speakers',
'settings.light': 'Light',
'settings.dark': 'Dark',
'settings.leave_session': 'Leave Session',
'nav.home': 'Home',
'nav.go_home': 'Go to Home',
'connect.kick_title': 'Kick device',
'connect.kick_yes': 'Kick',
'connect.kicked_title': 'Kicked',
'chat.cmd_d_kick': 'Kick device',
'chat.cmd_d_op': 'Grant admin',
'chat.cmd_d_deop': 'Revoke admin',
'toast.device_kicked': '{{name}} has been kicked',
'demo.session_title': 'This is room {{code}}.',
```

> **Arabic (`ar`) also needs more than re-translation:** several buttons used a
> conjugated verb instead of the UI noun/imperative form (`common.cancel` يلغي
> "he cancels" → إلغاء; `common.close` يغلق → إغلاق; `common.ok` نعم "yes" → موافق),
> **and** RTL layout is not yet mirrored (the CSS is ~117 physical
> `left/right/margin-*` properties vs. 4 logical). Hold `ar` from the language
> menu until RTL layout work lands.

---

## 7. QA checklist (after any translation)

- [ ] `npx tsc --noEmit` passes (no missing keys, no unescaped quotes).
- [ ] Every `{{placeholder}}` from the English source still present, unaltered.
- [ ] No `…` characters (`grep -n '…'` should be empty).
- [ ] Spot-check **every key in the §4 glossary** for the right sense.
- [ ] `common.right` ≠ the same value as `common.ok` (the classic tell).
- [ ] Direction labels match: `common.left`/`role.left` and
      `common.right`/`role.right` are real left/right words.
- [ ] Buttons read as actions, not infinitives or status nouns.
- [ ] Register feels casual/friendly, not machine-formal.
