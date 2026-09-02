# Domain Audit 22 - 2026-06-10 (Cross-Domain Review)

> **Historical audit record.** Statuses, counts, paths, line numbers, and references to "current" behavior reflect the code as of 2026-06-10 or the later commits named in this document. Do not treat this as the current open-issue list. Recheck the latest source and tests.

> **Methodology:** The audit covered fifteen review areas across seven domains: room passwords; role misunderstandings; UI rendering; chat and scale; mixed remote and local operation; mixed YouTube and file playback; inefficient paths; language, themes, and spectrum rendering; effect conflicts; copy inconsistencies; QR and invite codes; device limits; the Connect-tab password flow; demo recovery; and security. The review recorded both findings and verified behaviors. Twenty findings selected for correction then underwent independent validation (workflow `wf_efea3c77`).
>
> **Classification note:** The original audit used Red, Orange, Yellow, and Blue labels without defining a separate severity rubric. This translation preserves those labels as plain text.
>
> **Summary:** Red 0 / Orange 1 / Yellow 19 / Blue 17, for 37 findings in the initial review, plus several P4 observations. **The security review produced no new Red-, Orange-, or Yellow-classified findings.**
>
> This audit ran on the same day as Audit 21, the scenario audit in `scenario-audit-2026-06-10.md`. Its IDs are independent of SA-01 through SA-13.

## Validation (Phase 1) and Fix Results

- **20 independent validations:** confirmed 18 / partial 2 / refuted 0. The two partial findings were: (1) UI-1, where the symptom was real but the rAF branch was unreachable through the normal entry path, so the actual fix was a `state:playback.mode` listener that clears the duration on entry and repaints it when returning to file playback; and (2) UI-2, where the Settings-tab device list was `display:none` on every platform, making this a latent defect in dead UI. UI-2 was downgraded to P4, but its source was still corrected.
- **Four unsafe initial fixes rejected by validators:** ROLE-1 snapshot resends must not include VOLUME because that would overwrite each guest's personal volume; the HET-1 alternative of recording `localSessionId` on the remote path would create a recovery churn loop, so only the same-file short-circuit is safe; a guest-side HET-3 guard conflicts with an existing regression test because descriptors are one-shot, so the fix must be host-side only; and the DEMO-1(b) SYNC_PONG guard must be scoped to demo mode, because a global guard would regress initial remote-load bootstrap.
- **30 fixes / 5 record-only items:** CONN-2, ROLE-4, SEC-1, SEC-2, and UI-10 were initially recorded only because they were self-healing, theoretical, or copy follow-up items. No Phase 4 large-scale refactoring was required.
- **Verification:** 1061 tests, including 10 new regression pins (HET-1 x2, CHAT-1 x3, CONN-1 x2, DEMO-1/4 x3), plus typecheck, lint, and bus pairing 149:149, including the new `effects:resync-peer` event. All passed, with the 1051 existing tests intact.

## Fix Groups

| Group                                    | Scope                                                | Character                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. UI/i18n/visualization**             | UI-1 through UI-10                                   | Mostly one- to five-line, low-risk fixes                                                                                                                                                           |
| **B. Role/connection/chat consistency**  | CONN-1, ROLE-1 through ROLE-4, CHAT-1 through CHAT-2 | Protocol and UI synchronization                                                                                                                                                                    |
| **C. Mixed sessions (R2 cancel parity)** | HET-1 through HET-6, CATCH-2                         | Make remote-guest module-local state visible                                                                                                                                                       |
| **D. Demo recovery paths**               | DEMO-1 through DEMO-4, CATCH-3, PERF-2               | Snapshot invariants and queuing                                                                                                                                                                    |
| **E. System/performance**                | CATCH-1, PERF-1                                      | Service-worker policy and subscriber storms                                                                                                                                                        |
| **Record only (final disposition)**      | CONN-2, ROLE-4, SEC-1 through SEC-2                  | Self-healing or theoretical. ROLE-5 (ratchet), ROLE-6 (wiring), and HET-5 were promoted to fixes after review. UI-10 was resolved in follow-up commit `62f21211` with the 16-locale policy update. |

---

## 1. Connection and Authentication (CONN)

### CONN-1 [Yellow] - Reducing the guest limit evicts guests by slot index rather than guest count

- **Scenario:** Start with max=4 and four guests in slots 1 through 4. The guest in slot 2 leaves, producing sparse occupancy at 1, 3, and 4. The host then reduces the limit from 4 to 3. The UI guard (`connect.ts:136-142`) checks only `newValue < peers.length`, so it allows the change. Enforcement (`host.ts:511-528`) truncates the slot array and **evicts the guest in slot 4**, even though there are only three guests for three slots.
- **Cause:** The guard is count-based, while enforcement is slot-index-based.
- **Fix direction:** Remap occupied slots to the lowest available indices before truncation. Invariant: occupied slots are always `1..count`.
- Status: Fixed

### CONN-2 [Blue] - One extra password prompt when the password is removed during entry

- If the host removes the password while a guest is pending authentication, that authentication attempt fails with INVALID/REQUIRED and the eight-digit prompt appears again. **The next submission opens a new socket and joins without a password, so the flow self-heals.** This is a UX defect with no security impact.
- Status: Recorded only (self-healing)

### Verified Behaviors (Connection and Authentication)

- There is no max-device admission race. Counting and insertion occur synchronously in the host handler, and the event loop serializes them. Slot arithmetic has no off-by-one error: slot 0 is reserved for the host and guests use slots `1..max`.
- Reconnecting with the same peerId reuses its sticky slot. At capacity, only new peers receive SESSION_FULL. The previously fixed concurrent-rejection slot leak remains fixed.
- **Passwords are enforced by the server-side Durable Object worker; no client trust is involved.** The eight-digit format (`/^\d{8}$/`) is consistent at every layer. The latest value is resent after signaling interruptions with latest-write-wins behavior. Guests are blocked from toggling passwords at three separate layers.
- QR codes, invite links, and clipboard data contain only the six-digit room code, never the password. Expired codes return HOST_NOT_AVAILABLE. Metadata is removed after the 60-second release grace period, and a host reload creates a new code because hostSecret is ephemeral. A generation counter prevents QR-generation races.
- The worker reclaims pending-guest slots with an alarm sweep. Rename requests are fully validated server-side for trimming, a 20-character limit, reserved terms, profanity, and duplicates.
- Note: the worker itself has no device-count cap. Host-side enforcement plus the per-IP WebSocket rate limit of 120/minute is considered sufficient. Non-constant-time password comparison and plaintext storage are acceptable under the threat model.

---

## 2. Roles and Audio Effects (ROLE)

### ROLE-1 [Yellow] - Optimistic local application plus silent rejection leaves a revoked operator permanently out of sync

- **Scenario (a):** An operator is dragging the reverb slider, whose preview changes the actual audio state, when the host revokes the role. On release, `_isGuestLocked` blocks the action, so there is neither a send nor a rollback. **Scenario (b):** An operator clicks VBass, applies it locally, and sends REQUEST_SETTING (`effects.ts:343-395 -> 309-323`). The host has already processed the revocation, so `verifyOperator` fails and the request is **silently dropped** (`playlist.ts:1043-1053`) without a NACK. VBass remains enabled only for that guest.
- **Cause:** The request/response protocol has no NACK, and revocation does not rebaseline settings. Repeat and shuffle have the same failure mode.
- **Fix direction:** On OPERATOR_REVOKE, or on rejection, the host should resend the existing settings bootstrap block (`effects.ts:427-477`), which is the complete snapshot serializer, to that connection.
- Status: Fixed

### ROLE-2 [Yellow] - Operator REQUEST_SETTING leaves the host settings UI stale, and Surround has a dead click path

- **Scenario:** An operator enables Surround. The host applies and broadcasts it, and guests update through `ui:sync-surround`, but **the host's own UI does nothing** because `handleRequestSetting` only calls the setter (`playlist.ts:1085-1147`). If the host clicks Surround while its chip is visually off, `setSurroundOn` takes its idempotent early return (`settings.ts:476-478`) **before updating the chip**, so the click appears to do nothing. The five reverb types and the VBass and Exciter sliders and chips have the same stale-UI behavior.
- **Evidence:** The eq and REVERB_TYPE paths work because their setters emit events, confirming that the omission was not intentional.
- **Fix direction:** Emit the same `ui:sync-*` events used by the guest handlers from `handleRequestSetting`, or move those emissions into the setters, and update the chip before the early return.
- Status: Fixed

### ROLE-3 [Blue] - False "the host changed settings" toast on every guest join

- Of roughly 13 bootstrap frames, only VOLUME sets `_bootstrap: true` to suppress the toast. The other 12 trigger the debounced `_notifyHostChanged()` toast. The fix adds `_bootstrap` to every bootstrap send and gates the notification on it.
- Status: Fixed

### ROLE-4 [Blue] - Operator changes are attributed to the host and echoed back to the operator

- The broadcast echo serves as an implicit ACK and must remain. Add an origin label or `_echo` flag to suppress the sender's toast and correct the attribution.
- Status: Recorded only. The guest self-ID path was not verified, so requesterId design must come first. This is a minor toast-copy issue.

### ROLE-5 [Blue] - `network.isOperator` is reset only in leaveSession

- This path is currently unreachable because all reconnection paths fully reload the page. A future in-place reconnection could leave the operator UI stale indefinitely. The ratchet is to reset it to false in `handleWelcome`, which is safe because the host restores the role through GRANT, or to synchronize from the current peer's `isOp` field in DEVICE_LIST_UPDATE.
- Status: Fixed with the `handleWelcome` reset ratchet

### ROLE-6 [Blue] - `SYNC_PONG.trackIndex` is a dead field

- It is produced at `sync.ts:223` but had no reader. **DEMO-1 fix (b) uses this field and resolves the issue as part of that change.**
- Status: Fixed in DEMO-1(b) by comparing trackIndex in the demo-scoped `handleSyncPong` path

### Verified Behaviors (Roles and Effects)

- Role gates are complete on both sides. Every host-side REQUEST\_\* handler verifies `verifyOperator` or the demo subset, and the client-side pre-gates match. All 14 effect broadcast handlers use `isHostBroadcast`, so guests cannot alter or impersonate host audio state.
- Concurrent host and operator changes converge through absolute-value wire messages, host-side serialization, and echo. There is no ping-pong loop.
- Validator ranges exactly match UI ranges, so valid slider values are not dropped. Settings received before `audio:ready` are safe because they pass through setState and are fully reapplied later.
- Both control and bulk channels are ordered and reliable. Role and settings messages always use control, preserving FIFO order between GRANT/REVOKE and subsequent settings.
- GRANT/REVOKE changes state only after confirming that the channel is open and the send succeeds. Rate limits allow legitimate commit bursts, including the seven-frame demo toggle.
- P4 observations: PREAMP in REQUEST_SETTING is dead allowance because the client never sends it; optimistic demo-button flips self-heal; operator repeat and shuffle produce duplicate toasts.

---

## 3. UI, i18n, Themes, and Visualization (UI)

### UI-1 [Yellow] - Total duration is not cleared when entering system-audio mode because `time-total` is a dead ID

- The clearing branch at `seekbar.ts:115` calls `getElementById('time-total')`, while the actual ID in index.html is `time-dur`. Every other writer uses `time-dur`. The UI shows `0:00 / previous track duration` for the entire sharing session.
- **Fix:** Change `'time-total'` to `'time-dur'` and consider a one-time clear on mode entry.
- Status: Fixed

### UI-2 [Yellow] - Changing language empties the Settings-tab device list by reading the wrong state source

- The `i18n:changed` handler at `settings.ts:1007-1012` rerenders from `network.connectedPeers`, a host-only raw list that is empty for guests and excludes the host's own row. The canonical source is `network.lastKnownDeviceList`. connect.ts correctly uses its `_lastDeviceList` cache; only settings.ts was wrong.
- **Fix:** Replace the source with `lastKnownDeviceList`.
- Status: Fixed

### UI-3 [Yellow] - SESSION_FULL is translated in the host locale before transmission

- `host.ts` sends `message: t('network.session_full_detail')`, which the guest renders verbatim. A Korean host and an English guest therefore see a mixed-language dialog. The English copy also tells the rejected guest to set the limit in the Connect tab, where the guest has no such control.
- **Fix:** Send an `i18nKey` on the wire and call `t()` on receipt, reusing the existing pattern. Reframe the English copy to tell the guest to ask the host.
- Status: Fixed

### UI-4 [Yellow] - The visualization rAF loop never stops when paused or idle

- The draw loop exits only for YouTube mode, token changes, or errors. Three bypass entry points can start it indefinitely: resize, which also destroys a held pause frame by clearing `_isHoldingPauseFrame`; `ui:visualizer-check`, whose idle path starts because `isPlaybackPaused()` returns false; and `visualizer:set-type`, which starts unconditionally. Only the `scopePlaybackModeActivity` subscriber has an activity gate.
- **Fix:** Gate `startVisualizer` on `activity === 'playing'` and redraw the retained frame when resizing while held.
- Status: Fixed

### UI-5 [Yellow] - Singular device-count titles are restricted to English

- `connect.ts:362-367` selects `device_list_one` only when `count===1 && lang==='en'`. The grammatical singular forms for fr/de/es/it/pl/pt-br/ru are therefore unreachable, producing copy such as `1 appareils connectés` in French.
- **Fix:** Remove the `'en'` check and use the singular key whenever count is 1. A script verified that every locale has the key.
- Status: Fixed

### UI-6 [Blue] - Language changes overwrite the muted placeholder with the normal placeholder

- `data-i18n-data-placeholder` retains the normal key, so translation reapplies it. The fix also swaps the attribute when muting, following the existing pattern at `player-controls.ts:1026-1033`, or reapplies mute state in `i18n:changed`.
- Status: Fixed

### UI-7 [Blue] - YouTube URL and dialog inputs lose their placeholders after type-then-delete

- This is the same residual contentEditable `<br>` bug fixed for chat in commit `8d00a174`. Normalization was missing at `player-controls.ts:811-834` and `dialog.ts:243-270`. The fix extracts the chat normalization into a shared helper and applies it to both inputs.
- Status: Fixed

### UI-8 [Blue] - `system_audio.stopped` promises playlist resumption on paths that do not resume

- `system-capture.ts:338` emits unconditionally: on force-stop transitions, where Audit 21 explicitly established that restoration must not occur; when there is no snapshot; and even on the happy path, which restores a **paused** state. Move the toast into the explicit stop-and-restore branch or soften the copy.
- Status: Fixed

### UI-9 [Blue] - Theme changes do not update the visualization canvas while idle or paused

- The `data-theme` MutationObserver only calls `refreshThemeCache()` and does not redraw. The spectrum grid, using white or black at 0.06 alpha, then conflicts with the inverted background. Redraw the resting frame from the observer when idle.
- Status: Fixed

### UI-10 [Blue] - "Windows/Mac Chrome only" copy does not match the actual desktop-Chromium gate

- The feature also works in Edge, Opera, Brave, and Linux Chrome, but the copy says it is unavailable. This conservative mismatch is cosmetic. Change the copy to "desktop Chromium-based browsers."
- Status: Fixed across all 16 locales in follow-up commit `62f21211`, together with the remaining UI-3 locales and the repository-wide translation policy

### Verified Behaviors (UI, i18n, and Themes)

- **Locale-structure script verification:** all 16 locales contain the same 537 keys, with zero missing or extra keys and zero mismatched `{{placeholder}}` sets. All 185 `data-i18n*` keys in index.html resolve. The `t()` fallback chain and raw-key fallback for wire messages are defensive.
- Every numeric claim in copy matches implementation: 200 MB, two-hour SFU duration, 20-character nicknames, 32 slots, eight-digit passwords, six-digit codes, and the large-room threshold.
- YouTube-mode settings locking matches the copy, including the scope of `#youtube-settings-disabled-wrap` and its help text. Host-channel locking during system audio also matches.
- Language-change rerender coverage outside UI-2 and UI-6 follows the correct pattern for the Connect device list, demo copy, playlist, track title, media buttons, and QR placeholder.
- `bootstrap.js` preflight prevents theme FOUC. The theme-color and color-scheme metadata remain synchronized, including demo variants, and QR rendering is theme-aware.
- Overlay and z-order behavior, including the LIFO modal stack and inert focus trap, is sound. Toast and loader reference counting, grapheme truncation, and seekbar anti-jitter guards are also sound.
- Intentionally unchanged: English role-badge labels are a convention. The missing word for "playlist" in the Korean `enter_link_desc_html` is only a minor copy-improvement candidate.

---

## 4. Chat and Scale (CHAT)

### CHAT-1 [Yellow] - With the filter off by default, the host relays the untruncated original to every guest

- `chat/protocol.ts:199-206` truncates only a local variable. The write-back to `data.text` exists only inside the `filterEnabled` branch, so broadcast-except at `:243` fans the original length out to N-1 guests. The validator at `network/protocol.ts:231` has no length cap. Renderer-side truncation preserves the visual cap; the defect is upstream amplification at the host. The whisper handler does write back, creating an asymmetry.
- **Fix:** Move `data.text = text` outside the filter branch and add a validator length cap mirroring OPERATOR_TOAST's 300-character cap.
- Status: Fixed

### CHAT-2 [Blue] - Zero-width, RTL, and control characters can disguise display names

- Names such as `HOST\u200B`, where the escape denotes U+200B ZERO WIDTH SPACE, bypass reserved-name and duplicate checks based on raw lowercase equality. The crown badge is server-derived and cannot be forged, and rendering uses createTextNode, so this is visual impersonation, not XSS. Strip control, zero-width, and bidi characters in `handleRequestRename`, with NFKC normalization also worth considering.
- Status: Fixed

### Verified Behaviors (Chat)

- **All XSS sinks are clean:** every `parseMessageContent` branch escapes before reaching a sink, using escapeHtml for text and escapeAttr for attributes. Sender names, system messages, whispers, and announcements all use textContent-style paths. i18n parameters cannot inject markup because replacement is a plain replaceAll with no HTML evaluation.
- Badge spoofing is blocked because the host overwrites identity fields from canonical state for both CHAT and WHISPER. Administrative commands are authorized through isFromHost on guests, rejection of hostConn-null on the host, and server verification of REQUEST_CHAT_COMMAND for operators.
- Two token buckets apply: general traffic at 60 per 20 seconds and chat at 10 per second, with cleanup on disconnect. The DOM is capped at 200 nodes and dedup at 50 entries. Dedup keys derive from authenticated `conn.peer` and cannot be poisoned.
- The profanity filter has no ReDoS exposure: it is built once at module load and input is capped at 500 characters. Slash-command edge cases pass. Newlines cannot enter because paste strips them and beforeinput blocks them.

---

## 5. Mixed Sessions (HET)

> **Cross-cutting pattern:** Four of the six HET findings share one shape. The R2/remote subsystem manages its lifecycle in module-local state such as `_activeDownload`, `_activeUploads`, descriptor caches, and an unrecorded `transfer.localSessionId`. Mode-transition and recovery machinery built around `transfer.state` and lifecycle cannot see that state. Add a "remote-share module state" column to Blind Spot 8, the cancellation matrix, and Blind Spot 9, sibling-mode parity.

### HET-1 [Yellow] - Promotion from remote to local kills loaded audio and retransmits the full file

- A LAN guest initially misclassified by ICE is playing the current track through R2. The 30-second fallback recheck promotes it to local, so the host unicasts the current file. On the guest, `handleFileStart` sees `incomingSid > localSessionId (= 0, unused by the remote path)`, treats it as a false new session, and **destructively clears state before the same-file check**. Playback cuts out and the already-present file downloads again in full. The promotion guard `shouldAcceptLocalDirectFileStart` covers only mid-download AWAITING_PRELOAD.
- **Fix:** Before the isNewSession clear in handleFileStart, short-circuit when the current blob and metadata match the header, mirroring `replayLoadedSameFile`. The alternative of recording the descriptor sessionId in localSessionId on the remote path is unsafe.
- Status: Fixed

### HET-2 [Yellow] - OS media-key STOP during YouTube playback never broadcasts YOUTUBE_STOP

- The YouTube branch of `stopPlayback` (`transport.ts:808-819`) calls `setPlaybackIdle()` **first** to suppress an ENDED race. `stopYouTubeMode` then observes `wasInYouTube === false` and skips the broadcast. Every guest remains stuck in YouTube mode: later file tracks are ignored by the FILE_PREPARE YouTube-owner guard, guests spam REQUEST_CURRENT_FILE, and host unicasts are wasted. Sibling paths `handleEndOfPlaylist` and `stopAllMedia` capture the state before setting idle, so only this path diverged (Blind Spot 9).
- **Fix:** Capture `wasInYouTube` in stopPlayback before setting idle, then pass it through or broadcast explicitly.
- Status: Fixed

### HET-3 [Yellow] - Switching from file playback to YouTube or system audio broadcasts an in-progress R2 descriptor after it becomes stale

- The YouTube branch of playTrack neither clears `files.currentFileBlob` nor cancels the upload. `cancelInFlightUpload` was dead code with no callers. When the upload completes, the blob-identity branch of `isHostActiveFile` still passes and broadcasts the descriptor for track A even though the room is playing YouTube. The remote guest's `handleRemoteFileShare` has no external-owner guard, unlike handleFilePrepare, so it overwrites currentTrackIndex, flips title UI during YouTube playback, downloads the full file over mobile data, and discards it at activation.
- **Fix:** On the host, add `!isExternalOwner()` to `isHostActiveFile`, or wire the dead upload-cancellation code into mode transitions. A guest-side guard was rejected because descriptors are one-shot; the host-side fix is required.
- Status: Fixed

### HET-4 [Yellow] - In-progress R2 downloads are not canceled on mode changes

- Both `cancelInFlightTransfer` for YOUTUBE_PLAY and `cancelIncomingFileTransfer` for SYSTEM_AUDIO_START, introduced in SA-08, are keyed to RECEIVING in `transfer.state`. The remote path does not use that state. None of the three callers of `cancelRemoteShareWait` handles mode changes. `_activeDownload` continues streaming and repainting the loader, and its 5-minute-15-second timer remains active. This is the R2 variant of Blind Spot 8.
- **Fix:** Export a `cancelActiveRemoteDownload(reason)` wrapper and call it from both cancellation blocks.
- Status: Fixed

### HET-5 [Blue] - `handlePlayPreloaded` lacks a remote-guest branch and relies on FSM safety promotion

- PLAY_PRELOADED is the only track-change message without an isRemoteGuest branch. An R2 descriptor self-heals in the current deployment, where musixquare.com has R2 configured, so the finding remained Blue-classified. In deployments without R2, the loader remains indefinitely because the host silently drops REQUEST_DATA_RECOVERY: the transport guard in `unicastFile` returns without FILE_WAIT.
- **Fix:** Add a branch at the top of the handlePlayPreloaded fallback that mirrors handlePlayMsg, and respond with FILE_WAIT when unicastFile skips a remote target.
- Status: Fixed

### HET-6 [Yellow] - Every remote-guest failure path is terminal

- **Decode failure:** The guest sends REQUEST_CURRENT_FILE, but there is no remote branch. The host's unicastFile silently skips the remote target. Because a blob was found, it does not send FILE_WAIT. The guest remains FAILED and silent until the track ends. **Download failure:** Only a toast and status update occur; there is no retry or lifecycle transition, so the guest waits for the five-minute timeout. This differs from the local pipeline's three-retry backoff.
- **Fix:** On the host, route remote or unknown requesters to `shareRemoteFileIfNeeded` so the descriptor is resent or reuploaded. On the guest, add one bounded retry for non-abort failures.
- Status: Fixed

### Verified Behaviors (Mixed Sessions)

- The main race, PLAY arriving before a remote guest is ready, is fully handled through lifecycle deferral, age correction for pendingPlayTime, and SYNC_PONG bootstrap.
- Track changes work for mixed audiences: local chunks and remote descriptors, idempotent handling of reversed arrival order, objectId-based aborts on rapid A-to-B changes, remote guests joining mid-transfer, promotion mid-download with test coverage, mixed preloadedIndexes bookkeeping, and targeted PRELOAD_ABORT.
- Rapid YouTube/file crossings are correct. FIFO ensures YOUTUBE_STOP precedes FILE_PREPARE, preload works at the YouTube-to-file boundary, and shuffle/repeat clears caches when it lands on YouTube, preserving the SA-01 contract.
- Three P4 observations: an old-file broadcast loop can remain after a transition but wastes only bandwidth; an upload finishes after the only remote peer disconnects but is harmless; and `cancelInFlightUpload` was dead code before HET-3 wired it.

---

## 6. Security (SEC) - Clean Pass

**No new Red-, Orange-, or Yellow-classified findings.** Six threat surfaces were traced end to end: all XSS sinks use escaping or textContent; authorization is rederived from canonical state through `verifyOperator` and `isHostBroadcast` in more than 40 handlers; every file uses a fresh AES-256-GCM key and IV, with keys sent only over WebRTC and only ciphertext stored in R2; DoS controls include two token buckets, an `isHostBroadcast` first-line guard on chunks that prevents amplification, and numeric validators that reject NaN and Infinity; signaling validates a 24-byte CSPRNG hostSecret server-side; and the `__health` reconnaissance endpoint remains absent. **All earlier audit fixes remain intact,** including role-badge XSS, lastJoinCode, double decoding of titles, and DATA_RELAY removal.

### SEC-1 [Blue] - Chat YouTube-button DOM IDs use Math.random

- This is not security-sensitive. A theoretical collision could write an oEmbed title to the wrong message, but the write uses textContent and cannot cause XSS.
- Status: Recorded only

### SEC-2 [Blue] - Rate limiting fails open when peer ID is absent

- `allowInboundFromPeer` and `allowChatFromPeer` fail open without a peer ID. The current transport always supplies `conn.peer`, so the path is unreachable. Record this as a defensive note for future transports.
- Status: Recorded only

---

## 7. Demo Recovery, Catch-All, and Performance (DEMO/CATCH/PERF)

> **Summary:** Demo timeline desynchronization has complete recovery coverage through one-second SYNC_PING/PONG checks, correction when drift exceeds two seconds, no-buffer bootstrap, and forced resynchronization after background resume. **Demo track-identity desynchronization had no recovery path; DEMO-1, DEMO-3, and DEMO-4 cover that gap.**

### DEMO-4 [Orange] - A guest joining during demo remains permanently silent after demo exit

- First, the one-shot orchestrator file bootstrap is consumed and lost at the demo gate in `playback.ts:962`. Second, the first PLAY after exit returns from its index-mismatch branch because it assumes another bootstrap will arrive. Third, the next PLAY's SA-03 recovery request cannot match either side of `findMatchingBlob` because host `transfer.meta` still describes the demo track: the snapshot does not save or restore metadata, and `loadDemoFile` overwrites it. The guest remains in **FILE_WAIT indefinitely** and silent until the track changes. The root cause is a violation of the atomic `(currentFileBlob, transfer.meta)` pair invariant documented at `decode.ts:205-211`.
- **Fix:** Include transfer.meta in the demo snapshot so the pair invariant is restored. That alone allows the second PLAY to recover through SA-03. Ideally, demo exit should also rerun bootstrapLocalPeerFile for isDataTarget peers that have no file.
- Status: Fixed

### DEMO-1 [Yellow] - A loading guest silently drops host track advancement and synchronizes the wrong track to the host timeline

- The first-line `demo.loading` early return in `enterDemoMode` drops DEMO_ENTER for track n+1. The pending action is also a no-op because its index does not match, and nothing retriggers it. Within one second, SYNC_PONG bootstrap starts track n's audio at track n+1's position. The receiver did not compare the PONG payload's trackIndex, the dead field from ROLE-6.
- **Fix:** (a) Queue the requested index while loading and redispatch it from the load's finally block; and (b) defensively skip bootstrap in handleSyncPong when trackIndex is finite and does not match.
- Status: Fixed

### DEMO-3 [Yellow] - Demo track-advance fetch failure has no in-demo retry and splits the room when Play is pressed

- The index advances and broadcasts **before** loading. On failure, only the host has a null buffer. Pressing Play broadcasts DEMO_PLAY first, so guests play while the host is silent and shows an unrelated "playlist empty" toast. Pressing it again does not refetch because of the same-index guard. Only exiting and reentering demo recovers.
- **Fix:** In toggleDemoPlay or startDemoPlayback, call `loadDemoTrack(_demoTrackIndex, autoplay)` when `demo.active && !buffer`, or retry from the catch path.
- Status: Fixed

### DEMO-2 [Blue] - Rapid exit and reentry can run an old restore during the new demo

- On reentry within roughly 340 ms, the active fast path does not stop the old curtain animation. Its old `afterCovered` callback runs `restoreSnapshot` over the new demo, and the new snapshot then captures demo settings, potentially losing the original settings permanently. This is the exit-side sibling of SA-11's intentionally unchanged entry-side issue and is tracked separately.
- **Fix:** In the active fast path, call `stopDemoCurtainAnimation()`, synchronously finish the pending afterCovered callback, and only then capture the new snapshot.
- Status: Fixed

### CATCH-1 [Yellow] - Service-worker controllerchange hard-reloads live sessions in other tabs without prompting

- Tab B accepts an update, triggering SKIP_WAITING. Every controlled client receives controllerchange, so Tab A can die while hosting a live session. `markIntentionalNav` also suppresses its beforeunload prompt. On a second deployment within the 30-second cooldown, the client calls SKIP_WAITING with **no dialog**. This has practical impact because colocated multi-tab testing is common for this product.
- **Fix:** In controllerchange, defer reload and show an "update ready" toast when `network.appRole !== 'idle'`. Auto-reload only idle tabs.
- Status: Fixed

### CATCH-2 [Yellow] - Every remote track change leaks one object URL and pins the full decrypted blob

- Completion stores `download.blobUrl`. The next descriptor's fetch start overwrites it with null **without revoking it**, so later revoke logic reads null. A remote guest on mobile can accumulate 5-50 MB per track. A search found **zero consumers of `blobUrl`**, so removing the createObjectURL call entirely is the best fix.
- Status: Fixed

### CATCH-3 [Blue] - Demo-exit fallback does not cancel the curtain animation and may run snapshot restoration twice

- If exit occurs while hidden, such as a host drop on the lock screen, the 920 ms fallback runs once. On visibility return, onfinish runs it a second time. The path is nearly idempotent today and causes only a UI blip. Add `stopDemoCurtainAnimation()` to the fallback timer body.
- Status: Fixed

### PERF-1 [Yellow] - Every guest SYNC_PING recreates a hidden demo QR code

- Each guest sends one SYNC_PING per second. Every ping recreates the connectedPeers array through setState for a liveness update. Its only subscriber, `syncDemoSessionCopy`, has neither a `demo.active` gate nor same-code dedup, so it runs QRCode.toString, SVG, and innerHTML N times per second for a host who never opened demo. This wastes battery and is a hazard for future subscribers.
- **Fix:** (1) Move lastHeartbeat to a module Map because the heartbeat monitor is its only reader; (2) add an early return for `!demo.active` in syncDemoSessionCopy; and (3) cache identical QR codes. Items 1 and 2 are recommended.
- Status: Fixed

### PERF-2 [Blue] - One demo-effect toggle causes triple transmission, repeated enterDemoMode, and five synthetic resizes per guest

- A bass toggle already emits seven audio SETTING messages, followed by an informationally redundant DEMO_ENTER rebroadcast. Guests already derive the flags from settings, yet each guest reruns the full setDemoDomActive path, including roughly five resize events. Four toggles cause roughly 20 relayouts per guest.
- **Fix:** Reserve DEMO_ENTER for bootstrap and track changes. Send nothing for flag changes because guests derive them, or use a lightweight message. Skip setDemoDomActive when the same index is already active.
- Status: Fixed

### Unnumbered Note - Missing catch in the active guest enterDemoMode branch

- The try/finally has no catch, so failure creates unhandled-rejection noise even though the flow self-heals. Add a catch while implementing DEMO-1.

### Verified Behaviors (Demo and Catch-All)

- Every demo timeline-recovery path described in the summary works. Guest bootstrap during demo is correct, and the demo gate on normal-playback bootstrap prevents conflicting PLAY messages. The only post-exit gap was DEMO-4.
- Earlier demo fixes remain intact: Audit 11 H-3, Audit 12 recheck, SA-13, the Audit 13 QR token, and load-token. Timers, page lifecycle, AudioContext statechange, blob manager, and all 148 bus pairings are sound.
- Storage is confirmed RAM-only, with zero navigator.storage writes and no remaining OPFS surface. Ramstore integrity gates and backpressure are correct. Peak demo memory is roughly 200 MB, within the iOS budget. The pre-demo buffer pinned by the snapshot is a known cost.

---

## External Review Follow-Up (Same Day, Commit `78a60487`)

Two externally reported findings were validated. As in Audit 13, close reading revealed residual issues after the initial review.

### EXT-1 [Yellow, P2] - A captured local bypasses preload index-mismatch clearing

- This bug predates Audit 22. On mismatch, `handleFilePrepare` clears preload **state**, but captures the match-decision locals `nextFileBlob` and `hasPreloadedByName` **before** that clear. A same-name track at another index, including a duplicate filename or the same song added twice, enters the preload-match branch through name matching. Contrary to the review claim, it does not decode a stale blob because the consumer reads null from state. Instead, it waits on a **phantom preload and drops the real transfer** at the skip gate until watchdog recovery.
- **Fix:** Add `!isMismatch` to the branch. Index match and mismatch are mutually exclusive, so this blocks only name-match entry while preserving the fallback and regression pin for missing indices.
- Status: Fixed

### EXT-2 [Blue, P4] - CONN-1 relocation does not update `ConnectedPeer.slot`

- Only one of the review's three claims was valid: the slot field was stale. There were no production readers, so this had no functional effect, but the hygiene fix was applied. Preserving label and joinOrder and omitting rebroadcast were **intentional**. Label is identity at join time under rename semantics, joinOrder is admission order, and the device list exposes no slot, so relocation changes no visible data.
- Status: Fixed by synchronizing slot and extending the test assertion

### New Blind-Spot Candidate 14 - Captured locals versus state clearing

If a scope captures state into a local, conditionally clears the state, and then branches on the captured value, the clear is ineffective. Whenever adding or reviewing a state-clear guard, check whether an earlier capture bypasses it. Audit 22 missed this because validation focused on changed code while the domain review focused on cross-module flow. Both lenses missed a temporal inconsistency separated by 20 lines inside one function.

## Physical-Device Test Findings (Same Day, Commit `7adf11c6`)

User testing on physical devices found two issues. Each received a dedicated investigation and fix.

### DV-1 [Red, P1] - Host playback resets every new guest transfer to 0 percent

- **Mechanism:** The fresh branch in handleFilePrepare emits `storage:clear-previous-track` **one bus hop after** transitioning to DOWNLOADING. setPlaybackIdle in clearPreviousTrackState then clobbers the new lifecycle back to IDLE. **Every new guest download continues with the FSM silently disengaged.** PLAY therefore bypasses the DOWNLOADING defer gate, and the SA-03 no-buffer branch added the day before sends REQUEST_CURRENT_FILE during transfer. The host replies with unicast-from-0. When handleFileStart receives FILE_START for the same sid, it treats it as "recovery resend from zero" and discards the partial download. This repeats on every PLAY. The SA-03 comment's assumption that "FILE_START transitions to DOWNLOADING within one RTT" was false at HEAD because handleFileStart performs no such transition.
- **Fix:** (1) Prevent clearPreviousTrackState from setting idle while `isFilePipelineBusyForPlay()` is true; this is the root fix. (2) Add a transfer.state RECEIVING/PROCESSING suppression belt to SA-03. The 12-second chunkWatchdog resume path covers wedges. A related optimization adds size to FILE_PREPARE and reindexes a preload blob when name and size match, avoiding repeat downloads for duplicate filenames and navigation back to a previous item.
- **Follow-up (`517f4a60`, prompted by the user's question):** There are two reuse mechanisms, the preload slot and the currently loaded file, but promotion had been wired only to preload. Clicking another playlist item for **the same file currently playing** still downloaded it again. The same-file branch now validates resident identity, repoints its index and metadata, and lets the authoritative PLAY frame restart it without another transfer. This is another example of Blind Spot 5: every fix needs a sibling-path sweep.
- Status: Fixed with 4+2 regression pins

### DV-2 [Orange, P2] - Remote-guest remote-wait is a passive dead end

- **Mechanism:** Entering remote-wait from a bare PLAY, including resume after demo exit, sends **nothing** to the host. The local sibling branch sends REQUEST_CURRENT_FILE, but the remote branch remains passive. Its original justification, that the host drops remote requests, became obsolete after HET-6 routing, but the sibling branch was not updated. Resume does not reshare the descriptor. The five-minute timer only shows a toast and leaves lifecycle permanently in AWAITING_PRELOAD, so every later PLAY defers, SYNC bootstrap skips, and the Play button remains blocked as busy.
- **Fix:** (1) When either remote-wait branch enters a new wait, send REQUEST_CURRENT_FILE with reason `remote_share_wait`. Existing host routing then resends the cached descriptor over the control plane. (2) On REMOTE_WAIT_TIMER timeout, transition AWAITING_PRELOAD to FAILED so the gate is released.
- Status: Fixed with 3+1 regression pins

### Follow-Up Observation from the DV-1 Investigation (Not Fixed)

`FILE_END`, sent on the control channel, can overtake roughly 512 KB chunks on the bulk channel. Early shortfall recovery and a backoff callback that lacks a completion check may then send pointless FILE_RESUME or INTEGRITY_FAIL messages for a finalized slot. The flow self-heals; the only impact is wire overhead. This is a candidate for the next audit.

### Blind Spot 14 Addendum

DV-1 is the sibling form of "captured locals versus state clearing": **cleanup immediately after a transition clobbers the state just written by that transition.** When adding or reviewing a transition, inspect later cleanup in the same flow, including stop-all-media and clear-previous-track, for overwrites.

## External Review Round 2 (2026-06-11)

### EXT-3 [Yellow, P2-P3] - A reuse fast path leaves an orphaned chunkWatchdog

- **Mechanism:** handleFilePrepare's new-session reset arms chunkWatchdog and sets receivedCount to zero. A subsequent reuse fast path, whether preload promotion or same-content replay, returns even though no chunk will ever arrive, without clearing the timer. Replay does not decode, so decode completion in decode.ts does not clear it either. After 12 seconds, it fires. The local-guest path in `sendRecoveryRequest` has no lifecycle gate and sends `REQUEST_DATA_RECOVERY(nextChunk=0)`, causing the host to **unicast the entire file once per local guest**. HET-1's FILE_START short-circuit discards it, so playback does not stop and progress does not reset. Physical-device testing missed it because the symptom is silent full-file retransmission.
- **Scope correction:** Remote guests are unaffected because they return before the timer is armed. Preload promotion self-heals when decoding completes within 12 seconds, leaving only the large-file decode edge. Duplicate-item reuse added in `517f4a60` reproduces the issue 100% of the time.
- **Fix:** Immediately before both reuse returns, call `clearManagedTimer('chunkWatchdog')` and defensively clear `prepareWatchdog`. Moving startChunkWatchdog later was rejected because it changes the backup-safety semantics of the preload-waiting branch. The intended rule is: paths that will receive no chunks must disarm the chunk safety timer.
- Status: Fixed with two regression pins asserting arm-then-clear call order; 1075 tests pass
- Blind Spot 5 recurred for the third time. Although `517f4a60` recorded the need to sweep siblings of the fix, the new reuse fast path was not checked against the safety mechanism armed only a few lines earlier. Fast paths and short-circuit returns need to be checked against every timer, guard, and counter armed on function entry.

### EXT-4 [Yellow, P2] - Same-objectId remote-share dedup discards a new playback context

- **Mechanism:** `_activeDownload.objectId === descriptor.objectId` returns unconditionally. It cannot distinguish a duplicate playlist item or host re-click that resends the same cached descriptor **rebased to a new index/sessionId**. The host explicitly supports "rebasing the wire descriptor to the current playback session/index." Completion publishes using the **original descriptor index and sid captured by the closure**, so the guest adopts stale track identity: the wrong playlist row is highlighted, transfer.meta has the wrong index/sid, and REMOTE_WAIT_TIMER, evaluated against the new index, shows a spurious timeout toast during normal playback. A later descriptor then misses `isCurrentRemoteFileLoaded` because of the index mismatch and may redownload the same bytes from R2.
- **Fix:** Do not abort and restart, which would discard a partial cellular download. Instead, repoint the publish context. `DownloadEntry` holds the latest descriptor. On receipt of the same objectId, update `_activeDownload.descriptor` and call `prepareRemoteShareWait` again, which skips idempotently for the same context. Completion publishes from the latest `publishDescriptor`. The bytes are identical for one objectId, so the download itself continues.
- Status: Fixed with two regression pins: mid-download context replacement at publish and pure dedup for an identical context; 1077 tests pass
- This is the intersection of Blind Spot 11, where module-local `_activeDownload` is invisible to the global machine, and Blind Spot 5, the remote sibling of local same-content reuse. When the dedup key and publish context are separate axes, dedup should merge only the work and advance the context to the latest value. Dropping the entire request also drops its context.

### EXT-5 [Yellow, P2] - A late REQUEST_CURRENT_FILE response rewinds EXT-4 repointing to a stale index

- **Mechanism, synthesized on the host:** (1) `findMatchingBlob` serves the current blob by name even when an explicit reqIndex does not match (`recovery.ts:290-293`). (2) A targeted `shareRemoteFileIfNeeded` bypasses the stale-track guard at `if (!targetConn)` in `remote-share.ts:423`. (3) `withPlaybackContext(descriptor, sid=ensureValidSessionId(), index=reqIndex)` therefore constructs a late response with **the current sessionId and a stale index**. EXT-4's unconditional repoint adopts it, so `prepareRemoteShareWait` rewinds currentTrackIndex, pendingRecoveryTarget, and metadata to the old index, and publish is stale. Before EXT-4, this direction was harmlessly dropped, making this a regression induced by EXT-4, following the Audit 15 pattern.
- **Fix, guest-side option (b), a monotonic sid gate:** Legitimate reselection always increments sid through `nextSessionId()`, while a synthesized stale response has a sid less than or equal to the tracked value. Adopt only a strictly newer sessionId; otherwise treat it as pure dedup. Because the channel is ordered, the newer-sid broadcast always arrives before any later synthesized response, covering all interleavings. Host-side option (a), strict index enforcement in the name fallback, was rejected and recorded as an observation because that machinery is shared with the local recovery pipeline and intentionally tolerates index drift.
- Status: Fixed with one regression pin: while waiting for index 1, ignore same-sid and older-sid stale descriptors and preserve publish index 1; 1078 tests pass
- **Observation (not fixed, P4):** findMatchingBlob can still serve the current blob by name for an explicit, mismatched index. The guest gate blocks the descriptor path. On local unicast, the remaining edge requires files with the same name but different content; downstream size checks catch size mismatches. Tightening the host path was deferred because the benefit did not justify the local-recovery regression risk.
- This is a sibling of Blind Spot 13: **a later message is not necessarily a newer context.** Context adoption must be gated on a monotonic token such as sessionId, not arrival order. A repoint or adoption fix also requires checking older sources that can exploit it; the EXT-4 validation did not inspect the host-side synthesis path.

### EXT-6 [Yellow, P2] - The EXT-5 gate covers only the in-flight window

- **Mechanism:** The EXT-5 gate lives inside `if (_activeDownload)`. After finally sets `_activeDownload = null`, a late composed-stale descriptor misses both isCurrentRemoteFileLoaded and isPreloadedRemoteFile because its index is wrong. With no gate, it starts a **fresh download, rewinds remote wait through prepareRemoteShareWait, and redownloads all bytes already on the device from R2**. R2 completion timing is independent of DataChannel control ordering, so a post-completion late-response window is real.
- **Fix:** Add module-level `_lastAdoptedRemoteContext {objectId, index, sessionId}`. Record it at all three adoption points: fresh start, in-flight repoint, and preload promotion. Before a fresh download, admit only a strictly newer sessionId or an exact resend with the same objectId, index, and sid. The exact exception preserves recovery retries such as decode failure. Reset it at every `state:network.sessionCode` boundary, including M13 truthy-to-truthy reconnection, so a new host with a lower sid space is not blocked. This also blocks the different-object variant found during EXT-5 analysis, where the host's preload slot serves a stale request under the current sid: an equal-sid, different-object context is neither newer nor exact.
- Status: Fixed with two regression pins: ignore same-sid and older-sid stale descriptors after completion, while still accepting a newer sid as an overblocking control; 1080 tests pass
- **Remaining observation (P3 candidate, not fixed):** Reselecting a duplicate item under a newer sid makes remote guests redownload bytes they already have. The remote sibling of local same-content reuse from `517f4a60` was not wired because remote guests return before reaching the transfer-receive same-content branch. Including objectId in metadata would allow repointing. This is a candidate for the next audit.
- The guard's lifetime did not match the lifetime of the state it protected. An in-flight guard protects only in-flight state; if the adopted context remains after completion, the guard must remain too. Tests that cover only the pending state also need a post-completion case.

### EXT-7 [Yellow, P2] - EXT-6's exact exception blocks legitimate recovery reissuance by requiring objectId

- **Mechanism:** When the host descriptor cache expires, it can reupload the same track as a **new R2 object** with the same sid and index. This is an explicit shareRemoteFileIfNeeded path used by HET-6 recovery routing. If the guest adopts `{A, 1, 9}` and the download fails, reissue `{B, 1, 9}` is neither newer because sid is equal nor exact because objectId differs. It is dropped, and the guest can never receive the file. Every retry with `{B, 1, 9}` hits the same gate until a track change raises sid.
- **Fix:** Relax the exception to **playback-context identity, index plus sessionId, and intentionally exclude objectId**. Rewind prevention only needs to block a different index with the same or lower sid. A reissue in the same context cannot rewind anything. The host increments sid monotonically on every playFile, so an equal sid identifies the same playback selection.
- **Sibling path confirmed during testing:** After the first download **succeeds**, a reissue is already safe. The isPreloadedRemoteFile fast path matches index, name, size, and sid without objectId, and promotes the existing blob without downloading it again. The original test scenario unexpectedly passed through this path and exposed the distinction. The gate is needed only for failure followed by reissue, when no blob exists.
- Status: Fixed with one regression pin: accept `{B, 1, 9}` after failure while continuing to block composed-stale `{B, 0, 9}` in the same test; 1081 tests pass
- The exception criteria did not match the violation being prevented. The violation is index rewind, so including objectId tied an unrelated axis to the exception. The invariant axis, playback context, must remain separate from the variable transport axis, the object. Recovery reissuance was a legitimate traffic class missing from the gate's allowlist.

## Meta: New Blind-Spot Candidates from This Audit

1. **Blind Spot 11 - Module-local state versus global machinery** (HET pattern): When a subsystem manages its lifecycle in module variables, cancellation and parity sweeps from Blind Spots 8 and 9 cannot see it. For every new subsystem, verify that external machinery can observe and cancel its in-flight work.
2. **Blind Spot 12 - Do not translate on the sender** (UI-3): Putting translated text on the wire leaks the sender's locale. Require the i18nKey pattern. A static check could flag results of `t(` passed into send or broadcast payloads.
3. **Blind Spot 13 - Rejection paths for optimistic application** (ROLE-1): Every request-grant protocol must define who restores local state after rejection, using a NACK or a rebaseline.
4. **Missing idle-versus-paused distinction** (UI-4): `isPlaybackPaused()` does not cover idle. Review relevant branches against all three activity states: idle, paused, and playing.
