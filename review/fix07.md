# fix07 — Deep Analysis Round 7

## Summary
- **Total fixes**: 11 (High 2, Medium 8, Low 1)
- **Cumulative**: fix01–fix07 = 126 fixes

## Agents Deployed (6)
1. playlist.ts deep audit
2. playback + transport audit
3. relay + orchestrator audit
4. preload + recovery audit
5. connect + setup + dialog UI audit
6. effects + channel + engine audit

## Fixes Applied

### H1 — Guest join back button: dangling PeerJS connection
| Key | Value |
|-----|-------|
| File | `src/ui/setup-guest.ts` |
| Severity | **High** |
| Confidence | 9/10 |

**Bug**: Back button during guest join (`startGuestFlow()`) did not cancel the in-flight PeerJS connection. The pending `conn` could open after the user navigated away, triggering `setup:guest-join-success` → `hideSetupOverlay()`. Alternatively, the 15s timeout would fire a spurious `HOST_UNREACHABLE` error.

**Fix**: Added cleanup block to `startGuestFlow()` — when `isConnecting` is true, clears `join-timeout`/`join-retry` timers, sets `isConnecting = false`, `isIntentionalDisconnect = true`, and closes `hostConn`.

---

### H2 — Play lock watchdog leaves app in stuck "playing" state
| Key | Value |
|-----|-------|
| File | `src/player/transport.ts` |
| Severity | **High** |
| Confidence | 9/10 |

**Bug**: The 5s play lock watchdog called `stopPlayerNode()` but did not reset `appState`. UI remained in PLAYING state with no audio output and no way to recover without manual stop.

**Fix**: After `stopPlayerNode()` in the watchdog, reset `appState` to IDLE and emit `player:state-changed`.

---

### M1 — `files.currentFileOpfs` not reset in `leaveSession()`
| Key | Value |
|-----|-------|
| File | `src/network/peer.ts` |
| Severity | **Medium** |
| Confidence | 9/10 |

**Bug**: `batchSetState` in `leaveSession()` reset `files.currentFileBlob` to null but missed `files.currentFileOpfs`, leaving a stale OPFS filename from the previous session.

**Fix**: Added `'files.currentFileOpfs': { name: null }` to the `batchSetState` call.

---

### M2 — Heartbeat stale detection: `peerLabels` not cleaned up
| Key | Value |
|-----|-------|
| File | `src/network/sync.ts` |
| Severity | **Medium** |
| Confidence | 9/10 |

**Bug**: When heartbeat stale detection fires, it removes peers from `activeHostConnByPeerId` and `connectedPeers`, but not from `peerLabels`. The host.ts close handler won't fire because the `activeHostConnByPeerId` guard skips (entry already deleted). `peerLabels` entries accumulate indefinitely.

**Fix**: Added immutable peerLabels cleanup in the stale peer removal block.

---

### M3 — `ended-advance` timers not cleared on manual track change
| Key | Value |
|-----|-------|
| File | `src/player/playlist.ts` |
| Severity | **Medium** |
| Confidence | 9/10 |

**Bug**: When a track ends, `setManagedTimer('ended-advance-retry/next')` fires in 300-500ms. If the user clicks a different track during this window, the stale timer overrides their selection.

**Fix**: Added `clearManagedTimer('ended-advance-retry')` and `clearManagedTimer('ended-advance-next')` at the top of `playTrack()`.

---

### M4 — YouTube `playPrevTrack` ignores repeat-all wrap-around
| Key | Value |
|-----|-------|
| File | `src/player/playlist.ts` |
| Severity | **Medium** |
| Confidence | 9/10 |

**Bug**: In YouTube mode, `playPrevTrack` at track 0 always replayed track 0, ignoring repeat-all mode. Local file mode correctly wrapped to the last track.

**Fix**: Added repeat-all wrap-around logic to the YouTube branch, mirroring the local file branch.

---

### M5 — Double `stopAllMedia()` defeats `silent: true` (IDLE flash)
| Key | Value |
|-----|-------|
| File | `src/player/decode.ts` |
| Severity | **Medium** |
| Confidence | 9/10 |

**Bug**: `playlist.ts` calls `stopAllMedia({ silent: true })` to suppress IDLE flash during track change. But `loadAndBroadcastFile` calls `stopAllMedia()` again without `silent`, causing the IDLE state flash anyway.

**Fix**: Changed `stopAllMedia()` in `loadAndBroadcastFile` to `stopAllMedia({ silent: true })`.

---

### M6 — `finalizeGuestFile` has zero stale-load protection
| Key | Value |
|-----|-------|
| File | `src/player/decode.ts` |
| Severity | **Medium** |
| Confidence | 8/10 |

**Bug**: `finalizeGuestFile` performs async `arrayBuffer()` + `decodeAudioData()` but has no load token/session ID check. Two concurrent calls (from rapid host track switching) could race to set `_currentAudioBuffer`, playing the wrong track.

**Fix**: Added `incrementLoadSessionId()` capture at function start and `getActiveLoadSessionId()` stale check after each async boundary.

---

### M7 — Recovery `chunkToAsk` captured before backoff delay
| Key | Value |
|-----|-------|
| File | `src/storage/recovery.ts` |
| Severity | **Medium** |
| Confidence | 8/10 |

**Bug**: `receivedCount` was read at `sendRecoveryRequest()` call time, but the actual send happens 2-10s later (backoff). More chunks may have arrived during the delay, causing redundant retransmission from an already-received index.

**Fix**: Moved `chunkToAsk` computation inside the timer callback, reading fresh `transfer.receivedCount` after backoff.

---

### M8 — `masterGain` volume not synced by `applySettings()`
| Key | Value |
|-----|-------|
| File | `src/audio/effects.ts` |
| Severity | **Medium** |
| Confidence | 9/10 |

**Bug**: `applySettings()` syncs reverb, EQ, stereo width, preamp, virtual bass, and lowpass, but NOT `masterVolume`. After late audio init on guest (volume set before audio context exists), `masterGain` stays at 1.0 even though state says 0.5. Audio plays at full volume despite UI showing 50%.

**Fix**: Added `masterVolume` → `masterGain.gain.rampTo()` sync at the end of `applySettings()`.

---

### L1 — `setChannelMode` instantaneous lowpass frequency jump (audible click)
| Key | Value |
|-----|-------|
| File | `src/audio/channel.ts` |
| Severity | **Low** |
| Confidence | 8/10 |

**Bug**: `setChannelMode()` used `lowPass.frequency.value = 20000` (instantaneous) when switching modes. Jumping from 120Hz (Sub mode) to 20kHz in one sample produces an audible click. All other code paths use `rampTo()`.

**Fix**: Replaced `.value =` with `.rampTo(..., 0.02)` for both the reset (20kHz) and Sub mode (subFreq) assignments.

---

## Findings Evaluated but NOT Fixed

| # | Finding | Reason Skipped |
|---|---------|----------------|
| relay mid-download catch-up pump fixed endpoint | Structural — recovery handles it; document in fix10 |
| preload direct state mutation | No current subscribers; structural pattern issue for fix10 |
| `backgroundTransfer` sends to disconnected peers | Performance waste only, no crash |
| `handlePreloadEnd` before drain complete | Complex fix, low confidence (7), defer to fix10 |
| reconnect dialog race (concurrent network:error) | Narrow timing window, dialog queue handles sequencing |
| `isIntentionalDisconnect` reset race | Narrow timing, `_errorHandled` flag provides defense |
| surround BL/BR routing mismatch | Currently unreachable (always overwritten by play restart) |
| reverb retry infinite loop | Rate-limited to ~9s/cycle, unlikely in practice |

## Verification
- `npx tsc --noEmit` — 0 errors
- Preview: 0 console errors, 0 failed network requests
- App renders correctly (screenshot verified)
