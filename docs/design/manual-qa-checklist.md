# Manual QA Checklist — Pre-Launch (Playback State Machine Refactor)

> **Historical pre-launch checklist.** This was written for the April 2026
> `mxqr_temp` migration. Its branch name, test count, remote-guest assumptions,
> UI copy, and launch criteria are frozen evidence and must not be used as the
> current release checklist. Use
> [runtime-scenario-verification-2026-05-31.md](../runtime-scenario-verification-2026-05-31.md)
> plus the current automated suites for release work.

**Target launch:** 2026-04-28 (Tue)
**Stabilization window:** 2026-04-21 → 2026-04-27 (1 week)
**Scope:** verify the state-machine refactor + recent hardening (repeat/shuffle,
decode timeout, sync UI) holds up in realistic multi-device conditions before
merging `mxqr_temp` → `main`.

---

## How to use this doc

1. Run through the scenarios in order. Each scenario has a setup, the
   action to perform, and the expected result. If something deviates, log
   it against the scenario number.
2. Test matrix: **Chrome (desktop) host + Safari (iPhone) guest** covers
   the main pairing. If something's flaky there, also try the same pair on
   Firefox desktop and Chrome Android.
3. Some scenarios require specific file sizes. Prepare these in advance:
   - `small.mp3` — ~3 MB (128 kbps, 3 min)
   - `flac.flac` — ~30 MB (lossless, 5 min)
   - `huge.wav` — ~80–100 MB (96 kHz, 8+ min) — the bug-triggering size
   - `broken.mp3` — any 0-byte or truncated file
   - `video.mp4` — short H.264 clip (~10 MB)

---

## 🔥 Scenario 1 — The bug that started this refactor

**Priority:** BLOCKER. If this fails, don't merge.

**Setup:**
- Host: `huge.wav` (or `flac.flac`) + `small.mp3` in playlist, in that order
- One guest connected on same Wi-Fi
- Host plays track 0 (the large file) through to the end, so preload of
  track 1 (`small.mp3`) is complete and guest has cached it

**Action:**
1. Host skips to track 1 while preload of track 2 is still in flight
2. Observe guest's loader

**Expected:**
- Guest momentarily shows "다운로드 마무리 중..." (download finishing) while
  preload assembles, then plays seamlessly
- The "수신 중... 0%" loader does NOT appear
- Playback on guest starts within 1–2 s of host, in sync
- DevTools console on guest shows `[Lifecycle] AWAITING_PRELOAD → DECODING`

**Fail symptoms** (the bug we killed):
- "수신 중... 0%" followed by a full re-download
- Guest falls 5+ seconds behind host
- Console shows `stale-audio-recovery` log (it shouldn't exist anymore)

---

## Scenario 2 — Rapid Next clicks (supersede)

**Setup:** playlist with 5 tracks, host + 1 guest, Shuffle OFF, Repeat OFF

**Action:**
1. Host plays track 0
2. While playing, host rapidly clicks Next 3 times (within ~200ms)

**Expected:**
- Host ends up on track 3
- Guest follows to track 3 (may see transient loading states for 1/2 before
  settling on 3, that's fine)
- No stuck "수신 중" loaders, no audio from a mid-sequence track, no console
  errors

---

## Scenario 3 — Repeat-one asymmetry fix

**Setup:** playlist with 3 tracks, host + guest, repeat mode = one (반복
 아이콘 한 번)

**Action:**
1. Host plays track 1
2. Let it play for 30 seconds
3. Host clicks **Next** button

**Expected:**
- Host skips to track 2 (NOT restart of track 1)
- Guest follows to track 2

**Fail symptoms** (the pre-`fb5d5f0` bug):
- Track 1 restarts from 0 when host hits Next

Also verify:
- Host clicks **Prev** on track 2 → back to track 1, still in repeat-one
- Natural end of track 2 → repeats track 2 (repeat-one on natural end
  preserved)

---

## Scenario 4 — Persistent shuffle order round-trip

**Setup:** playlist with 5 tracks, host + guest, **Shuffle ON**

**Action:**
1. Host plays track 0 (or wherever shuffle starts)
2. Host clicks Next → let it play briefly → Next → Next (2 forward)
3. Host clicks Prev → Prev → Prev (3 back to the start)
4. Host clicks Next → Next → Next again

**Expected:**
- The tracks visited in step 2 (forward) match the tracks visited in step 4
  in the same order. Round-trip prev/next returns to the same track.

**Fail symptoms** (the pre-`fb5d5f0` bug):
- Step 4 visits different random tracks than step 2

---

## Scenario 5 — Prev after end-of-playlist

**Setup:** playlist with 3 tracks, Repeat OFF

**Action:**
1. Host plays track 2 (last) to the end
2. App shows "재생목록 끝" toast, playback stops, index = -1
3. Host clicks **Prev**

**Expected:**
- Track 0 (first track) starts playing (NOT silent no-op)

**Fail symptoms** (the pre-`fb5d5f0` bug):
- Prev is silent, nothing plays, `currentTrackIndex` stays -1

---

## Scenario 6 — Decode timeout auto-skip

**Setup:** playlist with 3 tracks: `small.mp3`, `broken.mp3` (corrupt or
pathological-bitrate file), `small2.mp3`. Host + guest.

**Action:**
1. Play starts at track 0, auto-advances to track 1 (`broken.mp3`)
2. Track 1's decode takes too long or fails

**Expected:**
- Within 10 seconds of attempting track 1, a toast appears (`"디코딩이
  너무 오래 걸려요. 다음 곡으로 넘어갑니다."`)
- Playback auto-advances to track 2 (`small2.mp3`)
- Console shows `[Lifecycle] DECODING → FAILED` then a new `DOWNLOADING`
  from the host's advance
- Guest follows

**Fail symptoms:**
- Tab hangs / freezes
- Loader stuck at some % forever
- Track 1 keeps retrying in a loop (→ check `markTrackFailed` is being called)

---

## Scenario 7 — Single-track playlist + repeat-all

**Setup:** playlist with 1 track only (`small.mp3`), repeat mode = all

**Action:**
1. Play the track through to the end
2. Let the natural end trigger

**Expected:**
- Track restarts from 0 immediately
- No "수신 중" flicker (fast-path same-track replay)

---

## Scenario 8 — Video playback

**Setup:** playlist with `video.mp4`, host + guest

**Action:**
1. Play the video
2. Seek backward
3. Seek forward
4. Pause, wait, play

**Expected:**
- Video plays with synchronized audio on both devices
- Seek works correctly on both devices
- Pause/play syncs

---

## Scenario 9 — YouTube mode

**Setup:** Add a YouTube video via URL input, host + guest

**Action:**
1. Play the YouTube video
2. Pause, seek, play
3. Skip to next track (another YouTube or local file)

**Expected:**
- YouTube plays in sync on both devices
- Transition between YouTube and local file tracks works
- Lifecycle is IDLE throughout YouTube playback (YouTube has its own
  state path; our machine is a no-op in that mode)

---

## Scenario 10 — Sync UI labels show "ms" in header

**Setup:** Host + guest, playing any local file

**Action:**
1. Tap Sync button on the guest
2. Observe the nudge popup

**Expected:**
- Column headers read `"자동 싱크 (ms)"` and `"수동 싱크 (ms)"`
- Values display as plain numbers (`+1022`, `-30`, etc.) without the
  "ms" suffix
- Numbers don't overflow at 4-digit values

---

## Scenario 11 — Late-join bootstrap

**Setup:** host is mid-playback of a track

**Action:**
1. New guest joins via QR code
2. Observe their experience from first tap

**Expected:**
- Guest receives the track meta immediately
- Guest downloads the current file, decodes, and catches up
- No stuck loaders after 30 s on local Wi-Fi
- Playback syncs within 1–2 s of first chunks arriving

---

## Scenario 12 — Remote guest (no relay)

**Setup:** host on Wi-Fi, guest on mobile data (remote, no relay peer available)

**Action:**
1. Guest tries to join

**Expected:**
- Guest sees the "같은 Wi-Fi에 연결해주세요" guide UI
- No file transfer attempt (avoids TURN billing)
- No console errors

---

## Scenario 13 — Toggling shuffle mid-playback

**Setup:** host playing a track, preload for next in flight

**Action:**
1. Toggle shuffle ON

**Expected:**
- Preload is regenerated for the new shuffle-next track
- No "수신 중" or stuck loader on guest
- Next track on advance is the newly-chosen shuffle-next

---

## Scenario 14 — Toggling repeat mid-playback

**Setup:** host playing, repeat mode = off

**Action:**
1. While playing track 0 (of a 3-track playlist), toggle repeat mode to
   "all", then to "one", then back to "off"

**Expected:**
- Each toggle shows the right toast
- Preload regenerates if needed
- Playback continues uninterrupted

---

## Scenario 15 — Network drop during preload

**Setup:** host + guest, preload of next track underway

**Action:**
1. Disable the guest's Wi-Fi for 3 seconds, then re-enable

**Expected:**
- Preload pauses during disconnect
- After reconnect, preload resumes OR falls back to fresh download via
  recovery
- Playback continues on the current track unaffected
- Console logs show watchdog fires but no crashes

---

## Scenario 16 — Very long file (30+ min podcast)

**Setup:** `long-podcast.mp3` (~40 MB, 60 min runtime)

**Action:**
1. Play the file on host
2. Observe guest's experience

**Expected:**
- File decodes successfully (does NOT hit the 10 s decode timeout for
  legitimate large files)
- Playback plays in sync
- Seek to mid-point works without hanging

**Why this matters:** the 10 s decode timeout was added to kill pathological
files (e.g. 50,000 kbps WAV). This scenario confirms a legitimate long file
still decodes fine.

---

## Post-run: diagnostic grep

After testing, spot-check the codebase for any references that would indicate
incomplete migration:

```bash
# These should return 0 hits except in the design doc:
git grep "stale-audio-recovery"
git grep "transfer.waitingForPreload"

# This should return only the transition() helper itself:
git grep "setState('playback.lifecycle'"

# These are OK to stay (Phase 4.4/4.5 deferred):
git grep "transfer.skipIncomingFile"
```

---

## Issues template

When logging a regression, use this format:

````markdown
### Scenario N — [short title]

**Environment:** host=[browser/device], guest=[browser/device], network=[wifi/remote]

**Steps performed:** [quick recap]

**Expected:** [from checklist]

**Observed:** [what actually happened]

**Console logs (guest):**
```
[paste relevant [Lifecycle] / [Preload] / [Guest] / [SharedClock] lines]
```

**State snapshot at failure** (guest DevTools):
```js
window.__musixquare_state?.playback
window.__musixquare_state?.transfer
window.__musixquare_state?.preload
```
````

---

## Sign-off

Launch criteria (must all be ✅ before `mxqr_temp` merges to `main`):

- [ ] Scenarios 1–6 pass without issue
- [ ] Scenarios 7–11 pass without issue
- [ ] No regressions in existing flows that we didn't change
- [ ] 685+ automated tests still pass (`npx vitest run`)
- [ ] TypeScript strict-check clean (`npx tsc --noEmit`)
- [ ] `git grep stale-audio-recovery` returns only design-doc matches
- [ ] `git grep transfer.waitingForPreload` returns only design-doc matches
- [ ] Smoke test against **musixquare.com** (current production) and the Toss
      webapp copy after deploy, both host and guest roles
