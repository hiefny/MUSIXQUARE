# MUSIXQUARE — Translation Guide

Last reviewed against the locale loader and translation tests on 2026-08-09.

A reference for translating `src/i18n/<lang>.ts` locale files — whether by AI, a
contributor, or a native reviewer. Born from a real failure: machine translations
rendered context-free one-word UI labels with the **wrong sense** of a homonym
("Right" → *correct*, "Kick" → *football*, "Grant" → *subsidy*). This guide exists
to prevent that. **The glossary in §4 is the most important part — read it.**

> **About the app (give this context to any translator/LLM):** MUSIXQUARE turns
> several phones/laptops, locally or remotely, into one synchronized multi-speaker
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
   or reorder the letters inside. Preserve the placeholders in each source key;
   examples include:
   `{{cmd}}` `{{code}}` `{{count}}` `{{idx}}` `{{label}}` `{{max}}` `{{msg}}`
   `{{name}}` `{{pct}}` `{{sec}}` `{{status}}` `{{target}}` `{{time}}`
   `{{usage}}` `{{val}}`
2. **Preserve `\n` newlines** and any leading/trailing spaces inside multi-line
   messages.
3. **Never translate** brand/technical tokens:
   `MUSIXQUARE` · `YouTube` · `Cloudflare` · `QR` · `API` ·
   and units `Hz` `kHz` `dB` `ms` `%` (+ the numbers).
4. **Respect the target locale's established ellipsis style.** Both three ASCII
   periods `...` and the single `…` (U+2026) are intentional across the locale
   files. When revising an existing locale, preserve each key's current form
   unless the translation itself needs correction; never apply a global
   style-only normalization from one form to the other.
5. **Escape apostrophes** for a single-quoted JS string (`'it\'s'`) or use the
   language's typographic quote (`'`, `’`, `»`). A raw `'` inside `'...'` breaks
   the build.
6. **Keep ALL-CAPS** only where the target script has letter case (Latin,
   Cyrillic). Caseless scripts (CJK, Thai) ignore it. Caps source values:
   `youtube.tap_to_play` = "TAP TO PLAY", `chat.system_sender` = "SYSTEM".
7. **Keep toast lines short; the toast never cuts authored copy.** Since
   2026-10-15, `src/ui/toast.ts` shows authored toast copy in full. A long line
   wraps, and the toast stays up longer (50 ms per character, up to 7 s). It
   still shortens dynamic values with `…`:
   - a line over 120 characters;
   - the text after the first `: ` when over 64 characters, such as a file
     name or an error message;
   - quoted text over 28 characters.

   This applies to every `toast.*` key and to any other key that reaches
   `showToast` or `bus.emit('ui:show-toast')` (for example `transfer.*`,
   `system_audio.*`, `error.*`, `share.remote.*`, and the
   `player.seek_unavailable_*` family). Authored text must stay within those
   three limits, or the toast would cut it; the toast copy guard test enforces
   this. Aim for about 50 characters per line anyway: on a phone a longer line
   wraps, and a long toast grows tall. Do not lengthen a toast that already
   fits.
8. **Do not end a toast sentence with a period** (decided 2026-10-15). This
   covers `.`, `。`, `।` and `۔`. When a toast has two sentences, put the second
   on its own line with `\n` instead of a period and a space. A question or
   exclamation mark may stay. Abbreviation periods (`etc.`, `maks.`) and
   ellipses stay. Line breaks still follow the English reference (rule 2).
   `src/i18n/__tests__/toast-copy-policy.test.ts` lists the toast keys and
   fails on a violation.
9. **Accessible names and hover hints are short phrases, not sentences**
   (decided 2026-10-27). They are the `*_aria` and `*_tip` keys and every
   other key a screen reader reads as a control's name or a hover hint shows
   (`src/i18n/__tests__/control-name-copy-policy.test.ts` lists them all).
   - Follow the English structure: a phrase stays a phrase, on one line,
     without a final period (`.`, `。`, `।`, `۔`), with the same placeholders.
   - Actions read as your UI's action form (imperative or noun), like the
     buttons around them: `Kick {{name}}`, `Scan QR code`.
   - A toggle keeps one name and the screen reader says its state, so never
     add "toggle", "switch", "on/off" or "expand/collapse" to it: `Mute`,
     `Shuffle`, `Full screen`, `Connected devices for {{name}}`.
   - A mode or state name stays a mode or state phrase, not an action:
     `Repeat off`, `Repeat all`, `Repeat current track`, `Syncing`.
   - A reason hint names the state that blocks the control in one phrase
     (`Playback control permission required`, `Not ready yet`). The toast for
     the same denial keeps its own sentences.
   - Use the words your locale already uses in the app: the kick verb of
     `connect.kick_yes`, the role of `connect.administrator_role`, the track
     word of `playlist.slot_tracks` and the pause of `common.pause`.
   - Korean (the source) ends a name or hint in a noun form: an action noun
     (`삭제`, `이동`), a native verb with -기 (`닫기`, `열기`) or a state noun
     (`필요`, `중`, `없음`). Never -하기, a 해요체 sentence, `클릭하여` or `탭하여`.
10. **Lock reasons read before a section description are sentences** (decided
    2026-10-28). A screen reader joins a locked group's reason and the
    section's own description (`settings.reverb_desc`, `settings.eq_desc`,
    `settings.virtual_effects_desc`) with a single space, so the reason there
    has sentence keys of its own (`settings.audio_locked_desc`,
    `settings.audio_lock_checking_desc`).
    - Write each on one line, ending the way your locale ends
      `settings.reverb_desc` (`.`, `。`, `।`, `۔`). Thai ends without a mark,
      because a space already separates Thai sentences, and may keep the
      tip's words.
    - The `*_tip` phrase (rule 9) stays the hover hint.
    - Other description keys follow the English source's punctuation, in
      your locale's marks (Thai uses none).
    - A key name ending in `_desc` is not enough: `common.next_desc` is a
      button name (rule 9).
    - `src/i18n/__tests__/control-name-copy-policy.test.ts` checks both
      sentence keys in every locale.

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
- **Roles, not channels:** a device's assignment is framed as its **role** (역할),
  not an "audio channel" — the experience is "this device acts as the left
  speaker," not "separate an audio channel." Keep `setup.*` prompts on role
  wording, never "channel."
- **Role labels carry "speaker":** `role.center` / `role.left` / `role.right` read
  as **"[position] speaker"** in every language (Left Speaker, 왼쪽 스피커, Altavoz
  izquierdo, 左音箱 / 左喇叭) — even if it wraps to two lines on the selection cards.
  Use each region's everyday word for *speaker* (zh-Hans 音箱, zh-Hant 喇叭 — not a
  forced match). `common.left` / `common.right` stay the bare direction word.
- **One word for "admin":** pick a single term for the admin/operator role and use
  it consistently across every key (`connect.administrator_role`,
  `connect.administrator_grant_aria`, `chat.cmd_d_op`,
  `toast.operator_required`, `network.op_granted`, …). Don't alternate
  admin/operator/manager.
- **Computer, not desktop hardware:** system-audio hosting requires a
  Chromium-based browser running on a computer. This includes laptops. Translate
  “computer” as the general device class and never as a desktop tower/form factor.
- **Chat mute is not audio mute:** every `chat.*mute*` string restricts a device
  from sending chat messages. Translate it as chat restriction/moderation, never
  as muting the device speaker, microphone, or playback audio.
- **GLOBAL / LOCAL are fixed badges:** outside the Korean source locale,
  `settings.host_ctrl` and `settings.self_ctrl` intentionally use the compact
  uppercase tokens `GLOBAL` and `LOCAL`. Do not expand, translate, or replace
  them with the obsolete `HOST-CTRL` / `SELF-CTRL` labels.
- **Subwoofer cutoff is not a full crossover:** `settings.subwoofer_adjust` and
  `settings.subwoofer_cutoff` control a low-pass cutoff on the subwoofer path.
  Translate “cutoff frequency”; do not claim a complementary crossover that the
  audio graph does not implement.
- **Decimals:** follow your locale's separator (`0,1 s`, `20,0 kHz` in German,
  Spanish, Italian, Portuguese, Polish, …) and keep the unit symbol itself
  intact (`s`, `Hz`, `kHz`, `dB`, `ms`, `%`). Decided 2026-10-14; earlier
  wording asked to keep the whole token unchanged.

---

## 4. ⚠️ Ambiguous-term glossary (the homonym traps)

These short labels lack sentence context, so an LLM easily picks the wrong sense.
Use the **Means** column; avoid the **✗** column (those are *real* errors seen in
the first machine pass).

| Key(s) | English | Means | ✗ Wrong sense to avoid |
|---|---|---|---|
| `common.right` / `common.left` | Right / Left | bare **direction** word (audio balance, woofer L/R) | "correct / yes / OK"; past tense of *leave* |
| `role.right` / `role.left` / `role.center` | Right / Left / Center | the device's role = **"[position] speaker"** (e.g. Left Speaker) | bare direction with no "speaker"; "channel" |
| `common.on` | On | toggle state **enabled / powered on** | preposition "on / upon / atop" |
| `common.off` | Off | toggle state **disabled** | "away / distant" |
| `connect.administrator_grant_aria`, `chat.cmd_d_op` | Grant administrator permissions to {{name}} / Grant administrator | **verb: give** someone the admin role | noun "a grant / subsidy / funding" |
| `common.revoke`, `chat.cmd_d_deop` | Revoke / Revoke administrator | **verb: take away** the admin role | "annul / invalidate" (too legalistic) |
| `connect.kick_*`, `chat.cmd_d_kick`, `toast.device_kicked` | Kick | **eject / remove** a device from the session | physical "kick / strike / football" |
| `player.seek` | Playback position | the **position slider's name**: where playback is in the track | "search / look for"; a place or location |
| `chat.seek_to` | Seek to {{time}} | **jump** playback to that time | "search / look for" |
| `player.play_media` "Play media", `player.play_together` "Play in Sync", `player.play_speakers` "Use as Speaker" | Play / Sync | **play back audio**; *sync* = synchronized playback | "play a game / have fun"; "channel" |
| `common.mix` | Mix | **audio mix** (combine sources) | "stir / blend (cooking)" |
| `common.original` | Original | **unprocessed audio** (effects off) | "novel / creative / first-ever" |
| `common.peer` | Peer | **network peer** (another device) | "nobleman / aristocrat / equal-rank" |
| `common.stay` / `common.leave` / `settings.leave_session` | Stay / Leave | **remain in** / **exit** the session | "stay (lodging)" / "leave (vacation/permission)" |
| `settings.light` / `settings.dark` | Light / Dark | **bright / dark UI theme** | "lamp / illumination" / "evil / scary" |
| `settings.eq_warm` / `settings.eq_bright` | Warm / Bright | **audio tonality** | temperature / intelligence |
| `nav.home`, `nav.go_home` | Home | **home screen** | "house / residence" |
| `common.woofer`, `role.subwoofer` | Woofer / Subwoofer | audio term — use the standard **loanword/transliteration** | literal "barker" |
| `settings.host_ctrl` / `settings.self_ctrl` | GLOBAL / LOCAL | fixed compact badges: the effect is controlled **globally** vs on **this device** | translating or expanding the badges; "self-control" (restraint) |

---

## 5. Ready-to-paste LLM prompt

Fill in the language, paste the English key→value pairs you want (re)translated
after the last line, and run it.

```text
You are localizing the UI of MUSIXQUARE — a web app that turns several phones and
laptops, locally or remotely, into one synchronized multi-speaker sound system. Devices
take roles (Left / Right / Center / Subwoofer); a host invites others into a
session/room by code or QR; everyone hears the same audio in sync.

Translate the English UI strings at the bottom into: <LANGUAGE> (<native name>).

Output rules:
- Output ONLY lines of the form  'key': 'translation',  — same keys, same order.
- Preserve every {{placeholder}} token exactly (don't translate/space/reorder it).
- Preserve \n newlines and leading/trailing spaces.
- Never translate: MUSIXQUARE, YouTube, Cloudflare, QR, API, GLOBAL, LOCAL,
  or units (Hz, kHz, dB, ms, %).
- Follow the target locale's established ellipsis style; never globally normalize
  ... (three periods) to … (U+2026), or vice versa, as a style-only change.
- Escape an apostrophe inside the value as \' (or use the language's curly quote).
- Tone: friendly, casual — a party/music app. Labels short & idiomatic (imperative
  or noun per your language's UI norm, not dictionary infinitives).
- Keys ending in _aria or _tip are accessible names and hover hints: a short phrase
  on one line, no final period, no sentence. Toggle, mode and state names stay
  mode or state phrases (Mute, Shuffle, Repeat off, Syncing), never "Toggle …",
  "on/off" or "expand/collapse". Use the words the app already uses in your
  language for kick, administrator, track and pause.

These short labels are AMBIGUOUS. Use the intended meaning, NOT the wrong sense:
- Right / Left  = speaker SIDE (right-hand / left-hand), not "correct" or "departed"
- On / Off      = toggle state (enabled / disabled), not the preposition "on"
- Grant / Revoke admin = give / take away the admin ROLE (verbs), not a "subsidy"
- Kick          = eject a device from the session, not a physical kick/football
- Seek          = jump the playback position, not "search"
- Playback position = the position slider's name, not a place
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

## 6. High-risk keys to verify / re-translate

When adding or auditing a locale, double-check these keys (the historical trap set).
Their current English sources — paste into the §5 prompt if re-doing them:

```
'common.left': 'Left',
'common.right': 'Right',
'common.on': 'On',
'common.off': 'Off',
'connect.administrator_grant_aria': 'Grant administrator permissions to {{name}}',
'common.revoke': 'Revoke',
'common.mix': 'Mix',
'common.original': 'Original',
'common.peer': 'Peer',
'common.stay': 'Stay',
'common.leave': 'Leave',
'role.center': 'Center Speaker',
'role.left': 'Left Speaker',
'role.right': 'Right Speaker',
'player.seek': 'Playback position',
'chat.seek_to': 'Seek to {{time}}',
'player.play_together': 'Play in Sync',
'player.play_speakers': 'Use as Speaker',
'settings.light': 'Light',
'settings.dark': 'Dark',
'settings.leave_session': 'Leave Session',
'nav.home': 'Home',
'nav.go_home': 'Go to home screen',
'connect.kick_title': 'Kick device',
'connect.kick_yes': 'Kick',
'connect.kicked_title': 'Kicked',
'chat.cmd_d_kick': 'Kick device',
'chat.cmd_d_op': 'Grant administrator',
'chat.cmd_d_deop': 'Revoke administrator',
'toast.device_kicked': '{{name}} has been kicked',
'demo.session_title': 'This is room {{code}}.',
```

---

## 7. QA checklist (after any translation)

- [ ] `npm run typecheck` passes (no missing keys or unescaped quotes).
- [ ] `npm exec vitest run -- src/i18n/__tests__` passes.
- [ ] Every `{{placeholder}}` from the English source still present, unaltered.
- [ ] Existing ellipses follow the target locale's established form; no global
      style-only normalization between `...` and `…` was applied.
- [ ] Spot-check **every key in the §4 glossary** for the right sense.
- [ ] `common.right` ≠ the same value as `common.ok` (the classic tell).
- [ ] Direction labels match: `common.left`/`role.left` and
      `common.right`/`role.right` are real left/right words.
- [ ] Action buttons read as actions (imperative or noun, per your language), not
      infinitives. Toggle, mode and status names (`Mute`, `Repeat off`,
      `Repeat all`, `Syncing`) stay mode or state phrases.
- [ ] `*_aria` and `*_tip` values are one-line phrases without a final period
      (`npm exec vitest run -- src/i18n/__tests__/control-name-copy-policy.test.ts`).
- [ ] The lock-reason descriptions (`settings.audio_locked_desc`,
      `settings.audio_lock_checking_desc`) are one-line sentences ending like
      your locale's `settings.reverb_desc`, not the `*_tip` phrase (Thai may
      keep the tip's words).
- [ ] Register feels casual/friendly, not machine-formal.
