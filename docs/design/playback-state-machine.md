# Playback State Machine — Design Doc (v2)

**Status:** VERIFIED — transitions cross-checked against a comprehensive code audit
**Branch:** `mxqr_temp`
**Launch target (revised):** 2026-04-28 (Tue)
**Author:** hiefny + Claude

**Motivation:** The pre-launch audit surfaced a bug where `stale-audio-recovery`
fires during an active preload hand-off, triggering a redundant full
re-download. Root cause: **non-atomic transitions between "previous track
loaded" and "next track ready"**. A bandaid-ish fix (`Option Z`) was drafted
but would accumulate debt and make future changes harder. Instead we refactor
the ad-hoc flag soup into an explicit playback-lifecycle state machine.

---

## 0. TL;DR

Today we have **at least seven** partially-overlapping flags governing "what
is this player doing right now?":

- `appState` (APP_STATE.* — mode: audio/video/youtube/system-audio)
- `transfer.state` (TRANSFER_STATE.* — main download pipeline)
- `preload.isPreloading` (boolean, host-side intent)
- `preload.sessionState` (Map<sid, {skipped, finalized, progress, ...}>)
- `transfer.waitingForPreload` (boolean, guest-side wait)
- `transfer.skipIncomingFile` (boolean, drop incoming chunks)
- `recovery.pendingFileIndex` / `recovery.pendingFileName`

Different subsystems inspect different subsets to decide what to do. That
disagreement is the class of bug we're killing.

**Goal:** One `playback.lifecycle` enum on the guest side that every handler
branches on, with a single allowed `transition()` function. Ad-hoc flags
become derived views or get deleted.

---

## 1. Scope

### In scope
- **Guest-side** local file track lifecycle: load → decode → play → pause/end
- Preload hand-off (the path that's broken right now)
- Recovery paths (stale audio, preload stall, decode fail)
- Coexistence with the existing `APP_STATE` mode axis

### Out of scope (explicitly not touched this refactor)
- Host-side state (preload scheduling, peer cache, relay)
- YouTube mode internal state (has its own well-factored sync layer)
- System audio mode
- Audio effects pipeline (EQ, reverb, virtual surround)
- Network-layer state (peer connections, relay, clock sync)
- UI state (tabs, modals, toasts) — consumes the new enum but isn't
  restructured
- Remote guests without relay (`showRemoteGuideUI` path) — these never
  receive file transfers, so they sit in IDLE indefinitely with a UI
  banner. Not modelled as a dedicated state.

---

## 2. Two orthogonal axes

APP_STATE encodes **mode** (which subsystem owns the output). The new state
machine encodes **lifecycle within a mode**. They coexist.

```
APP_STATE        : IDLE | PLAYING_AUDIO | PLAYING_VIDEO | PLAYING_YOUTUBE | PLAYING_SYSTEM_AUDIO | PAUSED
PLAYBACK_STATE   : IDLE | DOWNLOADING | AWAITING_PRELOAD | DECODING | READY | PLAYING | PAUSED | FAILED
                           ↑ only meaningful when APP_STATE ∈ {IDLE, PAUSED, PLAYING_AUDIO, PLAYING_VIDEO}
```

For YouTube / system audio, PLAYBACK_STATE stays at IDLE (they have their own
lifecycle paths). Guards in the transition helper enforce this so the machine
is a **no-op in those modes**.

---

## 3. The enum

```ts
export const PLAYBACK_STATE = {
  IDLE: 'IDLE',                         // nothing loaded, no operation pending
  DOWNLOADING: 'DOWNLOADING',           // main transfer (FILE_PREPARE → FILE_START → chunks)
  AWAITING_PRELOAD: 'AWAITING_PRELOAD', // PLAY_PRELOADED received, preload blob not yet assembled
  DECODING: 'DECODING',                 // blob in hand, running decodeAudioData
  READY: 'READY',                       // decoded buffer loaded, waiting for PLAY (or already received → will auto-play)
  PLAYING: 'PLAYING',                   // actively producing audio
  PAUSED: 'PAUSED',                     // decoded buffer present, not advancing
  FAILED: 'FAILED',                     // decode timeout / unsupported / corrupt — waiting for host to advance or manual recovery
} as const;
```

**What the enum deliberately does NOT distinguish:**
- No separate `PREPARING` between FILE_PREPARE and FILE_START. Folded into
  DOWNLOADING; the prepareWatchdog is just a timer owned by that state.
- No `PRELOADED` state. The moment a blob is available we start DECODING; the
  distinction of "came from preload vs came from main transfer" is carried
  in a sub-attribute.
- No `RECOVERY_REQUESTED`. Recovery is a transition action, not a state.

### Sub-attributes (live alongside the state, not replacing it)

```ts
type LoadSource = 'fresh' | 'preload-promoted' | 'recovery-resume';
// Describes HOW we got here; useful for telemetry and for routing incoming
// chunks to the right ramstore slot.

type PendingPlayTime = number | undefined;
// If host sends PLAY before we reach READY, store the time here. Consumed
// when we reach READY → PLAYING.
```

---

## 4. Transitions (verified against code audit)

Every allowed transition is listed here. **Any event/state combo not listed
is rejected** (logged as warning, state unchanged). Rejection is non-fatal
per Open Question #5 decision below.

### 4.1 From IDLE

| Event | Next | Action |
|---|---|---|
| `FILE_PREPARE` (fresh — no preload / not same file) | DOWNLOADING | set transfer.meta, currentTrackIndex; arm prepareWatchdog |
| `FILE_PREPARE` (demo file) | AWAITING_PRELOAD | HTTP fetch from server; treated as preload path |
| `FILE_PREPARE` (matches completed preload blob) | DECODING | loadPreloadedTrack() |
| `FILE_PREPARE` (same file already loaded) | — (stays IDLE, but rare in IDLE) | replay-current path |
| `PLAY_PRELOADED` (blob ready) | DECODING | loadPreloadedTrack() |
| `PLAY_PRELOADED` (preload session active, blob not assembled) | AWAITING_PRELOAD | arm preload stall/ceiling watchdogs |
| `PLAY_PRELOADED` (no matching session anywhere) | DOWNLOADING | emit REQUEST_DATA_RECOVERY with nextChunk=0 |
| `PLAY(time, index)` (no file loaded — late-join bootstrap) | IDLE | set pendingPlayTime, set currentTrackIndex; wait for FILE_PREPARE |
| `PAUSE(time)` | IDLE | set pausedAt, set appState=PAUSED upstream |
| `PAUSE(endOfPlaylist=true)` | IDLE | reset currentTrackIndex=-1, currentTrackMeta=null |
| `PRELOAD_START`/`CHUNK`/`END` | IDLE | buffer into preload.sessionState; lifecycle unchanged |

### 4.2 From DOWNLOADING

| Event | Next | Action |
|---|---|---|
| `FILE_START` (same session id) | DOWNLOADING | transfer.state = RECEIVING; swap prepareWatchdog → chunkWatchdog |
| `FILE_CHUNK` | DOWNLOADING | drain reorder buffer; update progress |
| `FILE_END` (all received) | DECODING | storage finalize; call decodeWithTimeout on blob |
| `FILE_RESUME(startChunk=N)` | DOWNLOADING | seek receive to chunk N; loadSource = 'recovery-resume' |
| chunk watchdog stall (12s local / 60s remote) | DOWNLOADING | emit storage:request-recovery → REQUEST_DATA_RECOVERY |
| prepare watchdog (15s / 60s) | DOWNLOADING | emit recovery (may switch to DOWNLOADING from fresh) |
| `FILE_PREPARE` (different session id / name) | DOWNLOADING | supersede: reset buffers, accept new; loadSource='fresh' |
| `FILE_PREPARE` (same session, pendingFileName matches) | DOWNLOADING | resume path; don't reset receivedCount |
| `FILE_PREPARE` (same file already loaded) | DOWNLOADING → no-op | edge case: transfer ongoing for file that somehow matches currentFileBlob; unlikely, log-only |
| `PLAY_PRELOADED` (same index as being downloaded) | DECODING or AWAITING_PRELOAD | if preload blob for same file exists, promote; else wait |
| `PLAY_PRELOADED` (different index) | supersede → DECODING / AWAITING_PRELOAD / DOWNLOADING | stopAllMedia, switch to new track's load path |
| `PLAY(time)` | DOWNLOADING | set pendingPlayTime |
| `PAUSE(time)` | DOWNLOADING | set pausedAt (consumed on READY) |
| `PAUSE(endOfPlaylist=true)` | IDLE | reset, cancel watchdogs |
| `PRELOAD_*` (for a different track) | DOWNLOADING | session state updated; lifecycle unchanged |

### 4.3 From AWAITING_PRELOAD ⭐ (the state that kills the bug)

| Event | Next | Action |
|---|---|---|
| `PRELOAD_CHUNK` (matching session) | AWAITING_PRELOAD | drain → ramstore; reset preload stall timer on progress |
| `PRELOAD_END` (matching session) | AWAITING_PRELOAD | wait for ramstore finalization (chunks may still be in microtask queue) |
| `preload-file-ready` (blob assembled, index matches) | **DECODING** | ⭐ loadPreloadedTrack(); this is the path currently broken |
| preload stall watchdog (10s no progress) | DOWNLOADING | emit REQUEST_DATA_RECOVERY; loadSource='fresh' |
| preload ceiling watchdog (60s absolute) | DOWNLOADING | same |
| `FILE_PREPARE` (same track, dedup) | AWAITING_PRELOAD | ignore — host may resend |
| `FILE_PREPARE` (different track) | supersede → DOWNLOADING | cancel preload waiter, stopAllMedia |
| `PLAY_PRELOADED` (same index, dedup) | AWAITING_PRELOAD | ignore duplicate |
| `PLAY_PRELOADED` (different index) | supersede | handle as fresh IDLE-style entry for new index |
| `PLAY(time)` (index matches current) | AWAITING_PRELOAD | **⭐ set pendingPlayTime, NO stale-audio timer**. Consumed when DECODING→READY→PLAYING |
| `PLAY(time)` (index mismatch) | supersede | handled as new track entry |
| `PAUSE(time)` | AWAITING_PRELOAD | set pausedAt (consumed when reaching PAUSED via READY) |
| `PAUSE(endOfPlaylist=true)` | IDLE | reset, cancel waiters |

### 4.4 From DECODING

| Event | Next | Action |
|---|---|---|
| decode success | READY | setCurrentAudioBuffer; publish (transfer.meta, files.currentFileBlob) atomically |
| decode timeout (10s via Promise.race) | FAILED | markTrackFailed(key); do NOT request recovery; wait for host |
| decode error (non-timeout, e.g. corrupt) | FAILED | send REQUEST_CURRENT_FILE (might be partial download) |
| load-token mismatch after async decode | previous state restored | abort without state change |
| `FILE_PREPARE` (different track) | supersede → DOWNLOADING | bump load token → running decode aborts on completion |
| `PLAY(time)` | DECODING | set pendingPlayTime |
| `PAUSE(time)` | DECODING | set pausedAt |
| `PAUSE(endOfPlaylist=true)` | IDLE | reset |
| `PRELOAD_*` | DECODING | session state updated; lifecycle unchanged |

### 4.5 From READY

| Event | Next | Action |
|---|---|---|
| `PLAY(time, hostPlayAt)` | PLAYING | schedule via SharedClock (WebAudio hardware-timed or setTimeout fallback) |
| `PLAY(time)` with no hostPlayAt (legacy) | PLAYING | play() immediately |
| consuming pendingPlayTime (internal) | PLAYING | same as PLAY handler above |
| consuming pausedAt (internal) | PAUSED | set pausedAt, appState=PAUSED |
| `PAUSE(time)` | PAUSED | set pausedAt |
| `FILE_PREPARE` (same file, replay-current) | READY | fire playback:replay-current; respect autoPlayDelayMs |
| `FILE_PREPARE` (different file) | supersede → DOWNLOADING | stopAllMedia |
| `PLAY_PRELOADED` (different index) | supersede | |
| `PAUSE(endOfPlaylist=true)` | IDLE | reset |

### 4.6 From PLAYING

| Event | Next | Action |
|---|---|---|
| `PAUSE(time)` | PAUSED | pause audio, set pausedAt |
| track ended (audioBuffer.onended) | IDLE | host broadcasts next PAUSE/FILE_PREPARE; guest passively |
| `PLAY(time)` (same track) | PLAYING | seek to time or restart from 0 |
| `FILE_PREPARE` (same file, replay-current) | PLAYING | play(0) |
| `FILE_PREPARE` (different file) | supersede → DOWNLOADING | stopAllMedia |
| `PLAY_PRELOADED` (different track) | supersede → DECODING/AWAITING_PRELOAD | stopAllMedia |
| `PAUSE(endOfPlaylist=true)` | IDLE | reset |
| seek action (local user) | PLAYING | seek internally; host broadcasts MSG.PLAY back |

### 4.7 From PAUSED

| Event | Next | Action |
|---|---|---|
| `PLAY(time)` | PLAYING | resume at time |
| `PAUSE(time)` | PAUSED | update pausedAt |
| `FILE_PREPARE` (same file) | PAUSED → PLAYING | replay-current + auto-play delay |
| `FILE_PREPARE` (different file) | supersede → DOWNLOADING | stopAllMedia |
| `PLAY_PRELOADED` (different track) | supersede | |
| `PAUSE(endOfPlaylist=true)` | IDLE | reset |

### 4.8 From FAILED

| Event | Next | Action |
|---|---|---|
| `FILE_PREPARE` (new track from host auto-advance) | DOWNLOADING | reset failure memory for this attempt |
| `PLAY_PRELOADED` (new track) | DECODING / AWAITING_PRELOAD | |
| `PAUSE` | IDLE | clean exit |
| host-driven advance (decode-fail-advance timer, 600ms) | IDLE → DOWNLOADING/AWAITING_PRELOAD | only when we ARE the host; guest stays passive |
| user manual track click | IDLE → DOWNLOADING/AWAITING_PRELOAD | via FILE_PREPARE |

Guest's FAILED state is **passive**. We never auto-request recovery from it.
Host drives the next track; we transition when it arrives.

### 4.9 Timer ownership by state

| State | Active timers | Cancelled on exit |
|---|---|---|
| IDLE | — (pendingPlayTime persists as data) | — |
| DOWNLOADING | prepareWatchdog (until FILE_START), chunkWatchdog (after) | both |
| AWAITING_PRELOAD | preload stall (10s, resets on progress), preload ceiling (60s absolute) | both |
| DECODING | decode timeout (10s, internal Promise.race) | Promise resolution |
| READY | — | — |
| PLAYING | SharedClock scheduled play timer (if hostPlayAt > 0) | cancelled on PAUSE |
| PAUSED | — | — |
| FAILED | decode-fail-advance (host-only, 600ms) | clears on next FILE_PREPARE |

**Explicitly deleted:** `stale-audio-recovery` timer. The condition it
detected is exactly the AWAITING_PRELOAD state, which is now modelled
directly.

---

## 5. Message → state handling matrix

Inverse view of Section 4 for quick reference.

### Legend
- `→X`: transition to state X
- `stay`: stay in current state
- `super→X`: supersede current operation, transition to X
- `—`: invalid / impossible by construction (logged, state unchanged)
- `data`: update sub-attributes but stay in state

|                                      | IDLE | DOWNLOADING | AWAITING_PRELOAD | DECODING | READY | PLAYING | PAUSED | FAILED |
|--------------------------------------|------|-------------|------------------|----------|-------|---------|--------|--------|
| FILE_PREPARE (diff file)             | →DL  | super→DL    | super→DL         | super→DL | super→DL | super→DL | super→DL | →DL |
| FILE_PREPARE (same file)             | stay | stay (resume)| —               | —        | replay | replay | replay | — |
| FILE_PREPARE (preload blob match)    | →DEC | —           | —                | —        | —     | —       | —      | —      |
| FILE_PREPARE (demo)                  | →AP  | —           | —                | —        | —     | —       | —      | —      |
| FILE_START                           | stale| start recv  | stale            | stale    | stale | stale   | stale  | stale  |
| FILE_CHUNK                           | buf  | drain       | stale            | stale    | stale | stale   | stale  | stale  |
| FILE_END                             | stale| finalize→DEC| stale            | stale    | stale | stale   | stale  | stale  |
| FILE_RESUME                          | —    | accept@N    | —                | —        | —     | —       | —      | —      |
| PLAY_PRELOADED (blob ready)          | →DEC | super→DEC   | →DEC (promote)   | dedup/super | super→DEC | super→DEC | super→DEC | →DEC |
| PLAY_PRELOADED (blob waiting)        | →AP  | super→AP    | dedup            | super→AP | super→AP | super→AP | super→AP | →AP |
| PLAY_PRELOADED (no session)          | →DL  | —           | —                | —        | —     | —       | —      | →DL |
| PRELOAD_START                        | data | data        | data             | data     | data  | data    | data   | data   |
| PRELOAD_CHUNK / PRELOAD_END          | buf  | drain       | progress         | buf      | buf   | buf     | buf    | buf    |
| PLAY (same index)                    | pend | pend        | pend⭐           | pend     | →PLAY | seek    | →PLAY  | pend   |
| PLAY (diff index, no file)           | pend+idx| pend+idx | pend+idx         | pend+idx | pend+idx | super | super  | pend+idx |
| PAUSE (time only)                    | save | save        | save             | save     | →PAUSED | →PAUSED | stay | save  |
| PAUSE (endOfPlaylist=true)           | →IDLE+reset (×all states) ||||||||
| preload-file-ready (match)           | —    | —           | →DEC⭐          | —        | —     | —       | —      | —      |
| preload stall / ceiling              | —    | —           | →DL (recovery)   | —        | —     | —       | —      | —      |
| decode success                       | —    | —           | —                | →READY   | —     | —       | —      | —      |
| decode timeout                       | —    | —           | —                | →FAILED + markFailed | — | — | — | — |
| decode error (non-timeout)           | —    | —           | —                | →FAILED + REQ_CURRENT | — | — | — | — |
| chunk watchdog stall                 | —    | stay + recv | —                | —        | —     | —       | —      | —      |
| prepare watchdog                     | —    | stay + recv | —                | —        | —     | —       | —      | —      |
| audio buffer onended                 | —    | —           | —                | —        | —     | →IDLE   | —      | —      |
| load-token mismatch (post-async)     | abort| abort       | abort            | abort    | abort | abort   | abort  | abort  |

**Key (abbreviations):**
- DL = DOWNLOADING
- AP = AWAITING_PRELOAD
- DEC = DECODING
- pend = set pendingPlayTime
- save = set pausedAt
- stale = ignore chunk (session/state mismatch)
- replay = emit playback:replay-current with autoPlayDelayMs

**Critical observation:** The ⭐ cells identify the two transitions that
directly fix the current bug. `PLAY in AWAITING_PRELOAD` must store pending
time, not trigger recovery. `preload-file-ready in AWAITING_PRELOAD` must
promote to DECODING.

---

## 6. State storage

```ts
// core/state.ts addition
playback: {
  lifecycle: PlaybackStateValue;          // the enum (default 'IDLE')
  loadSource: LoadSource | null;          // 'fresh' | 'preload-promoted' | 'recovery-resume'
  pendingPlayTime: number | undefined;    // moved from _state.ts module-local
  pendingPausedAt: number | undefined;    // NEW — symmetric with pendingPlayTime
  currentTrackName: string | null;        // replaces transfer.meta.name as the "what am I loading/playing" truth
  currentTrackIndex: number;              // mirrors playlist.currentTrackIndex (already exists; we'll unify)
  failedTrackKeys: Set<string>;           // from _state.ts — already exists, moved here for observability
}
```

Transitions go through a single helper:

```ts
// src/player/lifecycle.ts
export function transition(event: PlaybackEvent): void {
  const from = getState('playback.lifecycle');
  const next = resolveTransition(from, event);  // table lookup
  if (next === from && !event.sideEffectOnly) {
    // event was a no-op or a data update (pending/save); apply side effects
    applyEventSideEffects(event, from);
    return;
  }
  if (next === null) {
    // disallowed transition — see Open Question #5
    log.error(`[Lifecycle] Rejected ${event.type} in ${from}`);
    return;
  }
  cancelTimersForState(from);
  setState('playback.lifecycle', next);
  applyEntrySideEffects(event, next);
}
```

Direct writes to `playback.lifecycle` outside the helper are forbidden and
caught by a grep check in CI.

---

## 7. Flags being deleted / demoted

| Flag | Disposition | Rationale |
|---|---|---|
| `transfer.waitingForPreload` | **deleted** | equals `lifecycle === AWAITING_PRELOAD` |
| `transfer.skipIncomingFile` | **deferred to post-launch** | target is to gate `handleFileStart/Chunk/End/Resume` on `lifecycle === DOWNLOADING` instead of a flag, but that refactor touches core transfer code paths; the flag is redundant but not harmful, so we ship the launch with it and clean up in a v1.1 pass |
| `preload.isPreloading` | **kept (host-only)** | host-side scheduling signal, not part of guest lifecycle |
| `transfer.state` | **kept** | tracks download wire state (IDLE/RECEIVING/PROCESSING/READY); useful for UI loader. Semantic: "chunk pipeline phase", not lifecycle |
| `recovery.pendingFileIndex` / `pendingFileName` | **merged** | becomes `playback.pendingRecoveryTarget: { index, name } \| null` |
| stale-audio-recovery timer + detection | **deleted** | bug was here; state machine detects it directly |
| `_state.ts`'s `_pendingPlayTime` | **moved** | into `playback.pendingPlayTime` state tree field |
| `_state.ts`'s `_failedTrackKeys` | **moved** | into `playback.failedTrackKeys` |
| `waitingForPreload` state subscription in playback.ts waiter (lines 536, 543) | **deleted** | waiter's logic moves into AWAITING_PRELOAD handler |

---

## 8. Migration plan (6 steps, tested at each)

Each step leaves `main`-deployable code. No big-bang cutover.

### Step 1 — Introduce foundation (non-breaking)
- Add `PLAYBACK_STATE` to constants.ts
- Add `playback.lifecycle` (default IDLE) to state tree
- Create `src/player/lifecycle.ts` with `transition()` stub (no-op implementation)
- Add lifecycle to all subsystems' dual-write: every existing `setState('transfer.waitingForPreload', true)` call gets a sibling `transition({ type: 'enter-awaiting-preload' })` that writes `lifecycle = 'AWAITING_PRELOAD'`
- **Existing behavior unchanged.** lifecycle is just observed in parallel.

### Step 2 — Implement full transition table
- `resolveTransition(from, event)` returns next state per Section 4
- Unit tests for every row in Section 4 + 5
- Still dual-write; still unchanged behavior

### Step 3 — Rewire **one handler at a time**, starting with `handlePlay`
- `handlePlay` now calls `transition(event)` and removes the stale-audio-recovery setManagedTimer
- AT THIS POINT, the original bug is fixed (verify by manual repro)
- All 595 tests still pass + new unit tests for handlePlay paths

### Step 4 — Rewire remaining handlers
- `handlePlayPreloaded` (preload.ts)
- `handleFilePrepare` (transfer-receive.ts)
- `handleFileStart`, `handleFileChunk`, `handleFileEnd`, `handleFileResume`
- `storage:file-ready` / `storage:preload-file-ready` handlers
- Decode success/failure branches in decode.ts
- `player:ended` listener

### Step 5 — Delete old flags
- Remove `transfer.waitingForPreload`, `transfer.skipIncomingFile` from state tree
- Remove setters, readers, subscribers
- Remove the playback.ts storage:use-preloaded waiter (its logic is now in AWAITING_PRELOAD handler)
- Grep confirms zero references to deleted flags

### Step 6 — Tests + Manual QA
- Regression: all 595 existing tests pass
- New: lifecycle transition unit tests (Section 4 rows)
- New: integration tests for 3 scenarios
  - (a) preload completes before advance
  - (b) advance during preload (the bug)
  - (c) advance before preload started
- Manual (multi-device): 3 track types × 2 network conditions × 5 edge cases

---

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|-----------|
| Missed transition row causes silent wedge | M | H | `transition()` logs rejected transitions; every Section 4 row has a unit test |
| Dual-write in Step 1 drifts from real flag setters | M | M | Grep-enforced: all setState to deprecated flags go through one helper during transition |
| Timer ownership leak (old timer not cancelled on transition) | M | M | `cancelTimersForState(oldState)` called by transition() helper before state change |
| YouTube accidentally picks up PLAYBACK_STATE changes | L | M | Guards in every handler: `if (appState === PLAYING_YOUTUBE) return` before calling transition() |
| Host-side change protocol-incompatible with refactored guest | L | H | Protocol messages unchanged. Host-side code unchanged. |
| 2-3 day estimate slips to 5-7 | M | M | Ship Step 3 alone before launch if needed (fixes the bug, leaves cleanup for post-launch) |
| Hidden `markTrackFailed` gap in decode timeout preload path | — | — | **FIXED** in pre-refactor commit (see Section 11 below) |
| Remote guest accidentally enters DOWNLOADING | L | M | `transition()` no-ops for remote-guest-no-relay state (guarded on entry) |

---

## 10. Non-goals for this PR

Explicit list of things we are **not** doing, to prevent scope creep:

- [ ] Unify with YouTube's own sync state — leave alone
- [ ] Change protocol messages — same wire format
- [ ] Change host-side preload scheduling — host stays the same
- [ ] Rework `APP_STATE` — it keeps its current meaning and value set
- [ ] UI changes — the new enum surfaces through existing loader/toast paths
- [ ] Persistent shuffle order — already shipped in `fb5d5f0`
- [ ] Repeat/shuffle improvements — shipped in `fb5d5f0`
- [ ] Decode timeout improvements — shipped in `5b1c24e`

---

## 11. Decisions on Open Questions (closed)

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | Enum name | **PLAYBACK_STATE** | matches existing APP_STATE / TRANSFER_STATE naming |
| 2 | FAILED terminal or auto-exit? | **distinct state**, auto-exit via host advance | observability; clear invariant that decode-fail is a knowable condition |
| 3 | DECODING split or unified? | **unified** with `loadSource` attribute | keeps state count down; source is a property not a phase |
| 4 | pendingPlayTime location | **state tree** (`playback.pendingPlayTime`) | observable, debuggable, integrates with state subscriptions |
| 5 | Transition violation handling | **log.error + stay in previous state** (both dev and prod) | throw-in-dev was considered too risky given the pre-launch timeline; graceful degrade always |

---

## 12. Pre-refactor prep (already done)

- `5b1c24e`: 10s decode timeout + auto-skip
- `fb5d5f0`: repeat/shuffle hardening (Fisher-Yates)
- `6dca780`: sync popup UI tweak
- `<pending>`: fix `markTrackFailed` gap in preload timeout catch block (Section 9 / audit finding #7). This is a 3-line fix committed alongside this design doc so the refactor starts from a clean slate.

---

## 13. Acceptance criteria

This refactor ships when:
- [ ] All 595 existing tests pass
- [ ] New state-machine unit tests cover every row in Section 4 + 5
- [ ] Manual repro of the current bug (advance during preload) shows instant
      DECODING transition instead of 0% restart
- [ ] `git grep transfer.waitingForPreload` returns only deletions / design-doc references
- [ ] `git grep stale-audio-recovery` returns nothing
- [ ] `git grep "setState('playback.lifecycle'` returns exactly one call site (the `transition()` helper)

---

*Design verified against comprehensive code audit (2026-04-20). Ready for
Phase 2 implementation.*
