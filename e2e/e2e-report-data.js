window.__E2E_REPORT__ = {
  "startedAt": "2026-03-24T11:24:07.008Z",
  "finishedAt": null,
  "total": 296,
  "completed": 234,
  "passed": 234,
  "failed": 0,
  "skipped": 0,
  "running": "preload.test.ts › Preload System › backward navigation clears preload state",
  "tests": [
    {
      "title": "guest connects with Left channel (mode=-1)",
      "file": "e2e/audio-channel.test.ts",
      "suite": "Audio Channel Selection",
      "status": "passed",
      "duration": 5357
    },
    {
      "title": "guest connects with Center channel (mode=0)",
      "file": "e2e/audio-channel.test.ts",
      "suite": "Audio Channel Selection",
      "status": "passed",
      "duration": 5058
    },
    {
      "title": "guest connects with Right channel (mode=1)",
      "file": "e2e/audio-channel.test.ts",
      "suite": "Audio Channel Selection",
      "status": "passed",
      "duration": 4907
    },
    {
      "title": "guest connects with Subwoofer channel (mode=2)",
      "file": "e2e/audio-channel.test.ts",
      "suite": "Audio Channel Selection",
      "status": "passed",
      "duration": 5103
    },
    {
      "title": "host and guest have different channels",
      "file": "e2e/audio-channel.test.ts",
      "suite": "Audio Channel Selection",
      "status": "passed",
      "duration": 5107
    },
    {
      "title": "EQ sliders exist and are adjustable",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 8404
    },
    {
      "title": "EQ preset \"bright\" applies correct values",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 8159
    },
    {
      "title": "EQ preset \"warm\" applies correct values",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 7908
    },
    {
      "title": "EQ preset \"off\" resets all bands to 0",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 7941
    },
    {
      "title": "EQ value display updates with slider",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 7886
    },
    {
      "title": "reverb mix slider changes state",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 8222
    },
    {
      "title": "reverb preset \"studio\" applies settings",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 7886
    },
    {
      "title": "reverb preset \"off\" resets mix to 0",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 7938
    },
    {
      "title": "reverb decay slider adjusts decay time",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 7995
    },
    {
      "title": "stereo width toggle changes state",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 8293
    },
    {
      "title": "stereo width off resets to 1.0",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 8004
    },
    {
      "title": "virtual bass toggle enables enhancement",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 8069
    },
    {
      "title": "virtual bass off resets to 0",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 7822
    },
    {
      "title": "volume slider changes master volume",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 5234
    },
    {
      "title": "volume slider at 0 mutes",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 4998
    },
    {
      "title": "volume slider at 100 is full volume",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 4896
    },
    {
      "title": "subwoofer cutoff slider visible in sub mode",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 4875
    },
    {
      "title": "subwoofer cutoff changes subFreq state",
      "file": "e2e/audio-effects.test.ts",
      "suite": "Audio Effects",
      "status": "passed",
      "duration": 4971
    },
    {
      "title": "host refresh during playback does not permanently break guests",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Host Page Refresh",
      "status": "passed",
      "duration": 9157
    },
    {
      "title": "host refresh + re-create session, old guest gone, new guest joins",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Host Page Refresh",
      "status": "passed",
      "duration": 11214
    },
    {
      "title": "seek commands during guest join do not desync",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Seek Position Chaos",
      "status": "passed",
      "duration": 6370
    },
    {
      "title": "rapid seeks during playback with guest connected",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Seek Position Chaos",
      "status": "passed",
      "duration": 7549
    },
    {
      "title": "all 3 guests disconnect simultaneously, host remains stable",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Total Guest Wipeout",
      "status": "passed",
      "duration": 22473
    },
    {
      "title": "guests disconnect 2 seconds apart during playback",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Staggered Disconnect Cascade",
      "status": "passed",
      "duration": 42396
    },
    {
      "title": "20x rapid play/pause toggle does not crash with guest",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Rapid Play/Pause Cycling",
      "status": "passed",
      "duration": 9462
    },
    {
      "title": "next→next→next→prev→prev rapid sequence syncs correctly",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Rapid Track Navigation",
      "status": "passed",
      "duration": 16274
    },
    {
      "title": "track change during guest file transfer",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Rapid Track Navigation",
      "status": "passed",
      "duration": 6041
    },
    {
      "title": "50 rapid EQ/volume changes while guest disconnects",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Audio Settings Cascade + Disconnect",
      "status": "passed",
      "duration": 8404
    },
    {
      "title": "shuffle enabled before late join, guest receives shuffle state",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Shuffle Repeat + Late Join",
      "status": "passed",
      "duration": 6066
    },
    {
      "title": "toggle repeat mode 5 times rapidly then late join",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Shuffle Repeat + Late Join",
      "status": "passed",
      "duration": 7694
    },
    {
      "title": "guest1→upload→guest2→upload→guest3→upload chain",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Interleaved Join Upload",
      "status": "passed",
      "duration": 10689
    },
    {
      "title": "host + 2 guests send chat messages simultaneously",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Concurrent Chat Flood",
      "status": "passed",
      "duration": 9962
    },
    {
      "title": "10 rapid chat messages from host while guest sends simultaneously",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Concurrent Chat Flood",
      "status": "passed",
      "duration": 28731
    },
    {
      "title": "guest disconnect and immediate rejoin 3 times",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Connection Flapping",
      "status": "passed",
      "duration": 49924
    },
    {
      "title": "seek + volume change + next track fired simultaneously",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Triple Combo Operations",
      "status": "passed",
      "duration": 5642
    },
    {
      "title": "guest reloads page during file transfer, host survives",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Guest Reload During Transfer",
      "status": "passed",
      "duration": 5642
    },
    {
      "title": "reset all audio settings to defaults during playback with guest",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Settings Reset Mid-Session",
      "status": "passed",
      "duration": 5768
    },
    {
      "title": "switch media source 3 times rapidly with guest connected",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Mode Toggle Storm",
      "status": "passed",
      "duration": 7021
    },
    {
      "title": "change YouTube URL mid-playback with guest connected",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "YouTube URL Switch",
      "status": "passed",
      "duration": 11133
    },
    {
      "title": "host creates 3 sessions back-to-back, guests join each",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Sequential Sessions",
      "status": "passed",
      "duration": 52628
    },
    {
      "title": "3 guests join sequentially with track uploads between, all converge",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Late Join Chain",
      "status": "passed",
      "duration": 10982
    },
    {
      "title": "clear all tracks then new guest joins empty session",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Playlist Clear + Join",
      "status": "passed",
      "duration": 4923
    },
    {
      "title": "upload same fixture twice, both synced to guest",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Duplicate Upload Chaos",
      "status": "passed",
      "duration": 5107
    },
    {
      "title": "chat + upload + settings change all at once",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Chat Upload Settings Triple",
      "status": "passed",
      "duration": 6859
    },
    {
      "title": "guest sends chat then disconnects immediately",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Disconnect During Chat",
      "status": "passed",
      "duration": 17360
    },
    {
      "title": "set EQ to max/min extremes during playback",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "EQ Extreme Values",
      "status": "passed",
      "duration": 5343
    },
    {
      "title": "cycle through all channel modes during playback",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Channel Mode Switching",
      "status": "passed",
      "duration": 7359
    },
    {
      "title": "upload new track during playback while guest disconnects",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Upload During Playback + Disconnect",
      "status": "passed",
      "duration": 11225
    },
    {
      "title": "host pauses playback while file is transferring to guest",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Pause During Transfer",
      "status": "passed",
      "duration": 6011
    },
    {
      "title": "guest joins on different channel, session still works",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Channel Mismatch",
      "status": "passed",
      "duration": 4768
    },
    {
      "title": "guest joins while host is removing a track",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Late Join During Track Removal",
      "status": "passed",
      "duration": 5079
    },
    {
      "title": "host reorders playlist while guest disconnects",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Playlist Reorder + Disconnect",
      "status": "passed",
      "duration": 20193
    },
    {
      "title": "two guests with same default name do not conflict",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Device Name Collision",
      "status": "passed",
      "duration": 7824
    },
    {
      "title": "file upload while in YouTube mode queues properly",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Upload During YouTube Mode",
      "status": "passed",
      "duration": 6916
    },
    {
      "title": "toggle operator grant 5 times rapidly",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Rapid Operator Toggle",
      "status": "passed",
      "duration": 5141
    },
    {
      "title": "guest joins while host is paused at specific seek position",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Late Join During Pause + Seek",
      "status": "passed",
      "duration": 6388
    },
    {
      "title": "100 rapid state mutations do not crash the bus",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "State Mutation Burst",
      "status": "passed",
      "duration": 5062
    },
    {
      "title": "host toggles play while guest sends 5 chat messages",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Play Stop Chat Race",
      "status": "passed",
      "duration": 17201
    },
    {
      "title": "two guests join simultaneously during playback",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Double Late Join",
      "status": "passed",
      "duration": 6581
    },
    {
      "title": "upload all 3 fixtures at once, guest receives all",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Batch Upload Stress",
      "status": "passed",
      "duration": 4944
    },
    {
      "title": "session idle for 15 seconds then guest joins",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Idle Session + Late Join",
      "status": "passed",
      "duration": 20042
    },
    {
      "title": "host uploads, plays, skips, seeks, changes settings — all alone",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Host Solo Stress",
      "status": "passed",
      "duration": 92287
    },
    {
      "title": "15-step lifecycle: upload, join, play, seek, settings, chat, disconnect, rejoin, mode switch, repeat",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Nuclear Meltdown v2",
      "status": "passed",
      "duration": 122398
    },
    {
      "title": "session code remains valid after multiple guest joins and leaves",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Session Code Stability",
      "status": "passed",
      "duration": 80101
    },
    {
      "title": "guest joins after track ends naturally",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Playback End + Late Join",
      "status": "passed",
      "duration": 94136
    },
    {
      "title": "connect 3 → upload → play → disconnect all → rejoin 3, all sync",
      "file": "e2e/chaos-scenarios-2.test.ts",
      "suite": "Full Cycle Stress",
      "status": "passed",
      "duration": 30451
    },
    {
      "title": "host survives simultaneous disconnect of 2 out of 3 guests",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Mass Exodus",
      "status": "passed",
      "duration": 22385
    },
    {
      "title": "playlist state survives rapid guest join/leave cycles",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Revolving Door",
      "status": "passed",
      "duration": 34856
    },
    {
      "title": "settings changes during file transfer do not corrupt guest state",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Settings Storm During Transfer",
      "status": "passed",
      "duration": 5022
    },
    {
      "title": "late-joining guest syncs track index when host changes track mid-join",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Track Change + Late Join",
      "status": "passed",
      "duration": 5947
    },
    {
      "title": "uploads survive disconnect cascade and new guest gets full playlist",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Upload Barrage + Disconnect Cascade",
      "status": "passed",
      "duration": 30016
    },
    {
      "title": "operator chat survives simultaneous peer disconnect",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Operator + Chaos",
      "status": "passed",
      "duration": 19433
    },
    {
      "title": "operator grant to newly joined guest after disconnect",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Operator + Chaos",
      "status": "passed",
      "duration": 20039
    },
    {
      "title": "YouTube mode switch survives guest disconnect and late join",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Mode Switch + Disconnect",
      "status": "passed",
      "duration": 22620
    },
    {
      "title": "chat remains functional during mass disconnect",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Chat Flood + Mass Disconnect",
      "status": "passed",
      "duration": 23492
    },
    {
      "title": "playlist manipulation during disconnect storm produces consistent final state",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Playlist + Disconnect Storm",
      "status": "passed",
      "duration": 30185
    },
    {
      "title": "uploads, joins, disconnects, settings, chat — final guest sees correct state",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Full Lifecycle Chaos",
      "status": "passed",
      "duration": 35211
    },
    {
      "title": "maxGuestSlots=1 rejects second guest after first is connected",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Simultaneous Join Attempts",
      "status": "passed",
      "duration": 7269
    },
    {
      "title": "3 consecutive disconnect/reconnect cycles without stale peers",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Rapid Reconnect Cycle",
      "status": "passed",
      "duration": 50243
    },
    {
      "title": "guest joining mid-settings-chain receives final settings state",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Settings Chain + Late Join",
      "status": "passed",
      "duration": 6316
    },
    {
      "title": "preload continues after guest disconnect and new guest syncs correctly",
      "file": "e2e/chaos-scenarios.test.ts",
      "suite": "Preload + Disconnect",
      "status": "passed",
      "duration": 20079
    },
    {
      "title": "/help shows command list to host only (local)",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 10970
    },
    {
      "title": "/help shows fewer commands for regular guest",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 8159
    },
    {
      "title": "/users shows connected device list (local)",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 8249
    },
    {
      "title": "/freeze on blocks guest chat",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 12166
    },
    {
      "title": "/freeze off re-enables guest chat",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 11113
    },
    {
      "title": "host can still chat while frozen",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 11119
    },
    {
      "title": "/mute blocks specific guest, /unmute unblocks",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 11278
    },
    {
      "title": "/clear removes all chat messages on all devices",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 11178
    },
    {
      "title": "/notice broadcasts notice-style message to all",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 11110
    },
    {
      "title": "/nick changes device name",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 8121
    },
    {
      "title": "/nick rejects reserved names for guest",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 8176
    },
    {
      "title": "/nick rejects #번호 format",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 7985
    },
    {
      "title": "/w sends private message only to target",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 11089
    },
    {
      "title": "/slowmode limits chat rate",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 12354
    },
    {
      "title": "/filter on enables profanity filter",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 7997
    },
    {
      "title": "guest cannot use host-only commands",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 8026
    },
    {
      "title": "unknown command shows error message",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 8506
    },
    {
      "title": "/op grants operator and enables host+op commands",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 11074
    },
    {
      "title": "/deop revokes operator permissions",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 11146
    },
    {
      "title": "commands are not broadcast as regular chat",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 11206
    },
    {
      "title": "/freeze + late-join guest cannot chat",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 11987
    },
    {
      "title": "target resolution works by both #number and nickname",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 7990
    },
    {
      "title": "/mute target not found shows error",
      "file": "e2e/chat-commands.test.ts",
      "suite": "Chat Commands",
      "status": "passed",
      "duration": 8078
    },
    {
      "title": "host sends chat message and guest receives it",
      "file": "e2e/chat.test.ts",
      "suite": "Chat System",
      "status": "passed",
      "duration": 10914
    },
    {
      "title": "guest sends reply and host receives it",
      "file": "e2e/chat.test.ts",
      "suite": "Chat System",
      "status": "passed",
      "duration": 11144
    },
    {
      "title": "bidirectional chat exchange",
      "file": "e2e/chat.test.ts",
      "suite": "Chat System",
      "status": "passed",
      "duration": 11312
    },
    {
      "title": "Audio -> YouTube -> Audio roundtrip preserves playlist",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Mode Switching Chains",
      "status": "passed",
      "duration": 6163
    },
    {
      "title": "rapid mode switching does not corrupt state",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Mode Switching Chains",
      "status": "passed",
      "duration": 5631
    },
    {
      "title": "removing current track during playback stops and loads next",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Playlist Manipulation During Playback",
      "status": "passed",
      "duration": 6199
    },
    {
      "title": "uploading file while another file is still processing",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Playlist Manipulation During Playback",
      "status": "passed",
      "duration": 4994
    },
    {
      "title": "next/prev rapidly during file decode does not crash",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Playlist Manipulation During Playback",
      "status": "passed",
      "duration": 9567
    },
    {
      "title": "host uploads file while guest sends chat -- both succeed",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Concurrent Host+Guest Operations",
      "status": "passed",
      "duration": 11064
    },
    {
      "title": "both host and guest send chat simultaneously",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Concurrent Host+Guest Operations",
      "status": "passed",
      "duration": 11222
    },
    {
      "title": "host changes settings while guest browses tabs",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Concurrent Host+Guest Operations",
      "status": "passed",
      "duration": 5478
    },
    {
      "title": "changing EQ while audio is playing does not crash",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Settings Changes During Playback",
      "status": "passed",
      "duration": 5285
    },
    {
      "title": "changing volume to 0 and back during playback",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Settings Changes During Playback",
      "status": "passed",
      "duration": 5478
    },
    {
      "title": "toggling reverb on/off during playback",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Settings Changes During Playback",
      "status": "passed",
      "duration": 5415
    },
    {
      "title": "switching audio channel mode during playback",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Settings Changes During Playback",
      "status": "passed",
      "duration": 5590
    },
    {
      "title": "repeat one with single track -- play button toggles correctly",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Repeat & Shuffle Edge Cases",
      "status": "passed",
      "duration": 5424
    },
    {
      "title": "shuffle with 2 tracks -- next always plays the other track",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Repeat & Shuffle Edge Cases",
      "status": "passed",
      "duration": 7932
    },
    {
      "title": "changing repeat mode mid-playlist does not skip tracks",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Repeat & Shuffle Edge Cases",
      "status": "passed",
      "duration": 5693
    },
    {
      "title": "operator grant persists through file upload",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Operator Privilege Scenarios",
      "status": "passed",
      "duration": 4965
    },
    {
      "title": "revoking operator during playback does not crash guest",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Operator Privilege Scenarios",
      "status": "passed",
      "duration": 5487
    },
    {
      "title": "host continues normally if guest disconnects mid-transfer",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Guest Disconnect During Transfer",
      "status": "passed",
      "duration": 5319
    },
    {
      "title": "new guest after disconnect receives full playlist",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Guest Disconnect During Transfer",
      "status": "passed",
      "duration": 7664
    },
    {
      "title": "opening chat while media source popup is open",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Dialog & UI Overlap Edge Cases",
      "status": "passed",
      "duration": 11077
    },
    {
      "title": "triggering dialog during tab switch",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "Dialog & UI Overlap Edge Cases",
      "status": "passed",
      "duration": 11099
    },
    {
      "title": "full session lifecycle: upload, play, pause, next, prev, remove, upload again",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "State Consistency After Complex Flows",
      "status": "passed",
      "duration": 16272
    },
    {
      "title": "guest state remains consistent through host upload-play-pause-upload cycle",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "State Consistency After Complex Flows",
      "status": "passed",
      "duration": 5653
    },
    {
      "title": "multi-guest: all guests consistent after host performs many operations",
      "file": "e2e/complex-scenarios.test.ts",
      "suite": "State Consistency After Complex Flows",
      "status": "passed",
      "duration": 8747
    },
    {
      "title": "host creates session and gets 6-digit code",
      "file": "e2e/connection.test.ts",
      "suite": "Host-Guest Connection",
      "status": "passed",
      "duration": 1832
    },
    {
      "title": "host starts session and overlay closes",
      "file": "e2e/connection.test.ts",
      "suite": "Host-Guest Connection",
      "status": "passed",
      "duration": 2224
    },
    {
      "title": "guest joins host session successfully",
      "file": "e2e/connection.test.ts",
      "suite": "Host-Guest Connection",
      "status": "passed",
      "duration": 4874
    },
    {
      "title": "host sees guest in device list after connection",
      "file": "e2e/connection.test.ts",
      "suite": "Host-Guest Connection",
      "status": "passed",
      "duration": 5120
    },
    {
      "title": "guest with invalid code sees error",
      "file": "e2e/connection.test.ts",
      "suite": "Host-Guest Connection",
      "status": "passed",
      "duration": 6134
    },
    {
      "title": "guest selects different channel modes",
      "file": "e2e/connection.test.ts",
      "suite": "Host-Guest Connection",
      "status": "passed",
      "duration": 4969
    },
    {
      "title": "demo track file is accessible via HTTP",
      "file": "e2e/demo-track.test.ts",
      "suite": "Demo Track",
      "status": "passed",
      "duration": 4929
    },
    {
      "title": "demo track has valid audio content-type",
      "file": "e2e/demo-track.test.ts",
      "suite": "Demo Track",
      "status": "passed",
      "duration": 5106
    },
    {
      "title": "demo track can be fetched as blob",
      "file": "e2e/demo-track.test.ts",
      "suite": "Demo Track",
      "status": "passed",
      "duration": 4976
    },
    {
      "title": "host can add demo track to playlist via file input",
      "file": "e2e/demo-track.test.ts",
      "suite": "Demo Track",
      "status": "passed",
      "duration": 4858
    },
    {
      "title": "guest receives demo track playlist entry",
      "file": "e2e/demo-track.test.ts",
      "suite": "Demo Track",
      "status": "passed",
      "duration": 5209
    },
    {
      "title": "host device list shows connected guest",
      "file": "e2e/device-management.test.ts",
      "suite": "Device Management",
      "status": "passed",
      "duration": 5065
    },
    {
      "title": "host can kick guest",
      "file": "e2e/device-management.test.ts",
      "suite": "Device Management",
      "status": "passed",
      "duration": 4866
    },
    {
      "title": "session full rejects extra guest",
      "file": "e2e/device-management.test.ts",
      "suite": "Device Management",
      "status": "passed",
      "duration": 6546
    },
    {
      "title": "rapid next/prev clicks do not crash",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 10725
    },
    {
      "title": "rapid play/pause clicks do not crash",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 7142
    },
    {
      "title": "next/prev on empty playlist does not crash",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 5063
    },
    {
      "title": "play button on empty playlist is disabled",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 5053
    },
    {
      "title": "uploading new file while playing does not interrupt current track",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 5452
    },
    {
      "title": "uploading same fixture twice adds two playlist entries",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 4924
    },
    {
      "title": "empty chat message is not sent",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 7016
    },
    {
      "title": "long chat message is handled (500+ chars)",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 6966
    },
    {
      "title": "special characters in chat are preserved",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 6921
    },
    {
      "title": "rapid chat messages do not lose messages",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 7072
    },
    {
      "title": "volume slider at 0 does not crash",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 4933
    },
    {
      "title": "volume slider at max does not crash",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 5079
    },
    {
      "title": "seek slider manipulation on empty track does not crash",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 5058
    },
    {
      "title": "rapid tab switching does not crash",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 5005
    },
    {
      "title": "invite code is exactly 6 digits on host",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 4944
    },
    {
      "title": "uploading all 3 fixtures at once adds all to playlist",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 4868
    },
    {
      "title": "guest file input is not visible or disabled",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 4882
    },
    {
      "title": "guest detects when host page navigates away",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 5054
    },
    {
      "title": "host and guest have consistent appState after upload",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 5203
    },
    {
      "title": "dialog OK/Cancel buttons function correctly",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 12991
    },
    {
      "title": "navigating tabs during file upload does not break upload",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 11130
    },
    {
      "title": "repeat mode persists across tab switches",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 10958
    },
    {
      "title": "shuffle state persists across tab switches",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 11054
    },
    {
      "title": "guest playlist does not have remove buttons",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 4921
    },
    {
      "title": "track title updates in now-playing area after upload",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 4869
    },
    {
      "title": "volume icon toggles mute state",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 4965
    },
    {
      "title": "host message appears on guest chat",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 6822
    },
    {
      "title": "guest message appears on host chat",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 7069
    },
    {
      "title": "host myId and guest myId are different",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 4859
    },
    {
      "title": "setup overlay is dismissed on both host and guest",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Edge Cases",
      "status": "passed",
      "duration": 4968
    },
    {
      "title": "upload all 3 files, navigate through all, verify indices",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Stress Tests",
      "status": "passed",
      "duration": 25704
    },
    {
      "title": "remove all tracks one by one reduces playlist count",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Stress Tests",
      "status": "passed",
      "duration": 8183
    },
    {
      "title": "chat messages maintain order with many messages",
      "file": "e2e/edge-cases.test.ts",
      "suite": "Stress Tests",
      "status": "passed",
      "duration": 6989
    },
    {
      "title": "host uploads file and it appears in playlist",
      "file": "e2e/file-transfer.test.ts",
      "suite": "File Transfer",
      "status": "passed",
      "duration": 4851
    },
    {
      "title": "guest receives file after host uploads",
      "file": "e2e/file-transfer.test.ts",
      "suite": "File Transfer",
      "status": "passed",
      "duration": 4968
    },
    {
      "title": "host uploads multiple files",
      "file": "e2e/file-transfer.test.ts",
      "suite": "File Transfer",
      "status": "passed",
      "duration": 5546
    },
    {
      "title": "transfer state returns to idle after completion",
      "file": "e2e/file-transfer.test.ts",
      "suite": "File Transfer",
      "status": "passed",
      "duration": 5431
    },
    {
      "title": "guest receives playlist that was built before joining",
      "file": "e2e/late-join.test.ts",
      "suite": "Late-Join: Guest joins after file upload",
      "status": "passed",
      "duration": 5146
    },
    {
      "title": "guest sees correct currentTrackIndex from host",
      "file": "e2e/late-join.test.ts",
      "suite": "Late-Join: Guest joins after file upload",
      "status": "passed",
      "duration": 6281
    },
    {
      "title": "guest receives track title from host after late join",
      "file": "e2e/late-join.test.ts",
      "suite": "Late-Join: Guest joins after file upload",
      "status": "passed",
      "duration": 5430
    },
    {
      "title": "guest receives PLAYING state when host is already playing",
      "file": "e2e/late-join.test.ts",
      "suite": "Late-Join: Guest joins during playback",
      "status": "passed",
      "duration": 6552
    },
    {
      "title": "guest receives PAUSED state when host has paused",
      "file": "e2e/late-join.test.ts",
      "suite": "Late-Join: Guest joins during playback",
      "status": "passed",
      "duration": 6919
    },
    {
      "title": "guest receives YouTube mode when host is in PLAYING_YOUTUBE",
      "file": "e2e/late-join.test.ts",
      "suite": "Late-Join: Guest joins during YouTube mode",
      "status": "passed",
      "duration": 5837
    },
    {
      "title": "guest joins and sees host device in connect list",
      "file": "e2e/late-join.test.ts",
      "suite": "Late-Join: Guest joins after settings changed",
      "status": "passed",
      "duration": 4954
    },
    {
      "title": "host with repeat mode set — guest receives same state",
      "file": "e2e/late-join.test.ts",
      "suite": "Late-Join: Guest joins after settings changed",
      "status": "passed",
      "duration": 6602
    },
    {
      "title": "second late guest gets full playlist built by first guest era",
      "file": "e2e/late-join.test.ts",
      "suite": "Late-Join: Multiple guests join at different times",
      "status": "passed",
      "duration": 8009
    },
    {
      "title": "guest joins after another guest was kicked",
      "file": "e2e/late-join.test.ts",
      "suite": "Late-Join: Multiple guests join at different times",
      "status": "passed",
      "duration": 10053
    },
    {
      "title": "late guest does not see chat history from before joining",
      "file": "e2e/late-join.test.ts",
      "suite": "Late-Join: Chat history",
      "status": "passed",
      "duration": 5035
    },
    {
      "title": "late guest receives new messages sent after joining",
      "file": "e2e/late-join.test.ts",
      "suite": "Late-Join: Chat history",
      "status": "passed",
      "duration": 4933
    },
    {
      "title": "3 guests all connect successfully",
      "file": "e2e/multi-guest.test.ts",
      "suite": "Multi-Guest",
      "status": "passed",
      "duration": 10678
    },
    {
      "title": "file transfer reaches all 3 guests",
      "file": "e2e/multi-guest.test.ts",
      "suite": "Multi-Guest",
      "status": "passed",
      "duration": 11019
    },
    {
      "title": "all guests see same playlist after multiple uploads",
      "file": "e2e/multi-guest.test.ts",
      "suite": "Multi-Guest",
      "status": "passed",
      "duration": 11114
    },
    {
      "title": "chat message reaches all guests",
      "file": "e2e/multi-guest.test.ts",
      "suite": "Multi-Guest",
      "status": "passed",
      "duration": 7997
    },
    {
      "title": "kicking one guest keeps others connected",
      "file": "e2e/multi-guest.test.ts",
      "suite": "Multi-Guest",
      "status": "passed",
      "duration": 8137
    },
    {
      "title": "device list shows correct count for all guests",
      "file": "e2e/multi-guest.test.ts",
      "suite": "Multi-Guest",
      "status": "passed",
      "duration": 10748
    },
    {
      "title": "guest starts as non-operator",
      "file": "e2e/operator.test.ts",
      "suite": "Operator Mode",
      "status": "passed",
      "duration": 5041
    },
    {
      "title": "host can grant operator to guest via device list",
      "file": "e2e/operator.test.ts",
      "suite": "Operator Mode",
      "status": "passed",
      "duration": 8087
    },
    {
      "title": "host can revoke operator from guest",
      "file": "e2e/operator.test.ts",
      "suite": "Operator Mode",
      "status": "passed",
      "duration": 8124
    },
    {
      "title": "operator badge appears in device list after grant",
      "file": "e2e/operator.test.ts",
      "suite": "Operator Mode",
      "status": "passed",
      "duration": 8176
    },
    {
      "title": "guest role badge shows OP after operator grant",
      "file": "e2e/operator.test.ts",
      "suite": "Operator Mode",
      "status": "passed",
      "duration": 8178
    },
    {
      "title": "repeat button cycles through modes: off → all → one → off",
      "file": "e2e/playback-advanced.test.ts",
      "suite": "Advanced Playback",
      "status": "passed",
      "duration": 5232
    },
    {
      "title": "repeat all shows active class on button",
      "file": "e2e/playback-advanced.test.ts",
      "suite": "Advanced Playback",
      "status": "passed",
      "duration": 5114
    },
    {
      "title": "repeat one shows active-one class on button",
      "file": "e2e/playback-advanced.test.ts",
      "suite": "Advanced Playback",
      "status": "passed",
      "duration": 5228
    },
    {
      "title": "shuffle button toggles shuffle mode",
      "file": "e2e/playback-advanced.test.ts",
      "suite": "Advanced Playback",
      "status": "passed",
      "duration": 5067
    },
    {
      "title": "play real MP3 reaches PLAYING_AUDIO state",
      "file": "e2e/playback-advanced.test.ts",
      "suite": "Advanced Playback",
      "status": "passed",
      "duration": 5273
    },
    {
      "title": "pause from PLAYING_AUDIO transitions to PAUSED",
      "file": "e2e/playback-advanced.test.ts",
      "suite": "Advanced Playback",
      "status": "passed",
      "duration": 5437
    },
    {
      "title": "resume from PAUSED returns to PLAYING_AUDIO",
      "file": "e2e/playback-advanced.test.ts",
      "suite": "Advanced Playback",
      "status": "passed",
      "duration": 5525
    },
    {
      "title": "track title updates after file upload",
      "file": "e2e/playback-advanced.test.ts",
      "suite": "Advanced Playback",
      "status": "passed",
      "duration": 5208
    },
    {
      "title": "time display updates during playback",
      "file": "e2e/playback-advanced.test.ts",
      "suite": "Advanced Playback",
      "status": "passed",
      "duration": 5574
    },
    {
      "title": "seek slider exists and is interactive",
      "file": "e2e/playback-advanced.test.ts",
      "suite": "Advanced Playback",
      "status": "passed",
      "duration": 5037
    },
    {
      "title": "guest appState updates when host plays real MP3",
      "file": "e2e/playback-advanced.test.ts",
      "suite": "Advanced Playback",
      "status": "passed",
      "duration": 5420
    },
    {
      "title": "guest state updates when host pauses",
      "file": "e2e/playback-advanced.test.ts",
      "suite": "Advanced Playback",
      "status": "passed",
      "duration": 5388
    },
    {
      "title": "next button advances track with real audio",
      "file": "e2e/playback-advanced.test.ts",
      "suite": "Advanced Playback",
      "status": "passed",
      "duration": 5357
    },
    {
      "title": "prev button goes back with real audio",
      "file": "e2e/playback-advanced.test.ts",
      "suite": "Advanced Playback",
      "status": "passed",
      "duration": 5175
    },
    {
      "title": "host file upload sets transfer meta and track index",
      "file": "e2e/playback-sync.test.ts",
      "suite": "Playback Sync",
      "status": "passed",
      "duration": 5357
    },
    {
      "title": "host play button changes app state",
      "file": "e2e/playback-sync.test.ts",
      "suite": "Playback Sync",
      "status": "passed",
      "duration": 5457
    },
    {
      "title": "guest playlist syncs with host after file upload",
      "file": "e2e/playback-sync.test.ts",
      "suite": "Playback Sync",
      "status": "passed",
      "duration": 5058
    },
    {
      "title": "host pause changes state to PAUSED",
      "file": "e2e/playback-sync.test.ts",
      "suite": "Playback Sync",
      "status": "passed",
      "duration": 5613
    },
    {
      "title": "multiple files appear in playlist on both sides",
      "file": "e2e/playlist.test.ts",
      "suite": "Playlist Management",
      "status": "passed",
      "duration": 5091
    },
    {
      "title": "host track navigation updates current index via state",
      "file": "e2e/playlist.test.ts",
      "suite": "Playlist Management",
      "status": "passed",
      "duration": 5270
    },
    {
      "title": "host can remove tracks from playlist",
      "file": "e2e/playlist.test.ts",
      "suite": "Playlist Management",
      "status": "passed",
      "duration": 5964
    },
    {
      "title": "playlist sync: guest sees same track count as host",
      "file": "e2e/playlist.test.ts",
      "suite": "Playlist Management",
      "status": "passed",
      "duration": 5039
    },
    {
      "title": "preload state initializes correctly",
      "file": "e2e/preload.test.ts",
      "suite": "Preload System",
      "status": "passed",
      "duration": 4906
    },
    {
      "title": "host playlist with multiple files sets preload meta",
      "file": "e2e/preload.test.ts",
      "suite": "Preload System",
      "status": "passed",
      "duration": 5207
    }
  ],
  "finalStatus": null,
  "durationMs": 2501373
};