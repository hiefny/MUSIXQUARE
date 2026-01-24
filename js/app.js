let player, toneSplit, toneMerge;
let gainL, gainR, masterGain;
let reverb, rvbLowCut, rvbHighCut, rvbCrossFade, eqNodes = [];
let vbFilter, vbCheby, vbGain;
let preamp, widener;
let globalLowPass = null;
let analyser;
let buffer; // Holds the Tone.Buffer or AudioBuffer

// Audio State
let isPlaying = false;
let startTime = 0;
let pausedAt = 0;
let startedAt = 0;

let animationId;
let isSeeking = false;
let channelMode = 0; // 0=Stereo, -1=Left, 1=Right, 2=Sub
let isSurroundMode = false; // New 7.1 Mode
let surroundChannelIndex = -1; // 0..7
let surroundSplitter = null; // Split Source into 8 channels
let surroundGain = null; // Gain for selected surround channel
let mediaDownmixNode = null; // Stereo Downmixer for Standard Mode

let virtualBass = 0; // 0.0 ~ 1.0
let stereoWidth = 1.0;
let reverbMix = 0;
let reverbType = 'hall';
let subFreq = 120; // VB Crossover
let masterVolume = 1.0;



let myId = null, peer = null, hostConn = null;
window.hostConn = null; // Expose to other scripts (demo.js)
let localOffset = 0;

let connectedPeers = [];
let isOperator = false;
let deviceCounter = 0; // Host-side counter for unique device names

// Beta Relay State
let upstreamDataConn = null; // Connection to receive file chunks from (Host or Relay info)
let downstreamDataPeers = []; // Peers I need to forward file chunks to
const MAX_DIRECT_DATA_PEERS = 2; // Host sends data to max 2 people directly

// [FIX #19] Global Constants for Magic Numbers
const CHUNK_SIZE = 16384; // 16KB per chunk
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100MB
const RELAY_MONITOR_INTERVAL = 10000; // 10 seconds
const ENDED_CHECK_THROTTLE = 500; // 500ms throttle for handleEnded
const WATCHDOG_TIMEOUT = 12000; // 12 seconds for chunk watchdog

let chunkWatchdog = null, prepareWatchdog = null;
let lastChunkTime = 0;
let _isProcessingBlob = false; // Guard to prevent redundant decoding and sync storm

// YouTube Sub-item State (Host tracking)
let currentYouTubeSubIndex = -1;
let youtubeSubItemsMap = {}; // playlistId -> { ids: [], titles: [] }
let currentFileBlob = null; // Cache for serving late joiners


// Playlist State
let playlist = [];
let currentTrackIndex = -1;
let repeatMode = 0;
let isShuffle = false;
let autoPlayTimer = null;  // Track 3-second auto-play timer
let isFirstTrackLoad = true;  // Track if this is the first file load

// Video State
let isVideoMode = false;
const videoElement = document.getElementById('main-video');


// Preload State (Host)
let nextTrackIndex = -1;
let nextBuffer = null;
let nextFileBlob = null;
let isPreloading = false;
let nextMeta = null; // Store metadata for preloaded file
let preloadSessionId = 0; // Session ID for cancellation support

// Preload State (Guest)
let preloadChunks = [];
let preloadCount = 0;
let preloadMeta = null;

// Helper: Clear all preload state (call on track change, session leave, etc.)
function clearPreloadState() {
    // Host side
    nextTrackIndex = -1;
    nextBuffer = null;
    nextFileBlob = null;
    nextMeta = null;
    isPreloading = false;

    // Guest side
    preloadChunks = [];
    preloadCount = 0;
    preloadMeta = null;
    window._skipIncomingPreload = false;

    console.log("[Preload] State cleared");
}

// --- Worker for Background Timers (Blob URL for file:// support) ---
const workerCode = `
const timers = {};
self.onmessage = function (e) {
    const { command, id, interval } = e.data;
    if (command === 'START_TIMER') {
        if (timers[id]) clearInterval(timers[id]);
        timers[id] = setInterval(() => {
            self.postMessage({ type: 'TICK', id: id });
        }, interval);
        // console.log(\`[Worker] Started: \${id} (\${interval}ms)\`);
    }
    else if (command === 'STOP_TIMER') {
        if (timers[id]) {
            clearInterval(timers[id]);
            delete timers[id];
            // console.log(\`[Worker] Stopped: \${id}\`);
        }
    }
};
`;

const blob = new Blob([workerCode], { type: 'application/javascript' });
const timerWorker = new Worker(URL.createObjectURL(blob));

timerWorker.onmessage = (e) => {
    if (e.data.type === 'TICK') {
        const id = e.data.id;
        // console.log(`[Worker Tick] ${id}`); // Debug Verification

        if (id === 'heartbeat') {
            if (hostConn && hostConn.open) hostConn.send({ type: 'heartbeat' });
        } else if (id === 'ping') {
            if (hostConn && hostConn.open) hostConn.send({ type: 'ping-latency', timestamp: Date.now() });
        } else if (id === 'video-sync') {
            checkVideoSync();
        }
    }
};

function checkVideoSync() {
    if (isPlaying && isVideoMode && videoElement && !videoElement.paused) {
        // [Latency Compensation V3 for Video]
        // Sync Video to Audio Time (Tone.now)
        const t = (Tone.now() - startedAt) + localOffset;
        const diff = videoElement.currentTime - t;
        if (Math.abs(diff) > 0.2) {
            console.log(`[VideoSync] Correcting drift: ${diff.toFixed(3)}s`);
            videoElement.currentTime = t;
        }
    }
}


// --- Theme Logic ---
function setTheme(mode) {
    let theme = mode;
    if (mode === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        theme = prefersDark ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.theme-opt').forEach(el => el.classList.remove('active'));
    document.getElementById(`theme-${mode}`).classList.add('active');
    localStorage.setItem('musixquare-theme', mode);
}

(function initTheme() {
    const saved = localStorage.getItem('musixquare-theme') || 'system';
    setTheme(saved);
})();

// --- Tab Switching ---
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
    const tabs = ['play', 'playlist', 'connect', 'settings'];
    const idx = tabs.indexOf(tabId);
    if (idx >= 0) document.querySelectorAll('.nav-item')[idx].classList.add('active');

    // FIX: YouTube Black Screen - Force refresh container when switching to 'play' tab
    if (tabId === 'play' && isYouTubeMode) {
        // Use timeout to ensure tab transition is complete
        setTimeout(() => refreshYouTubeDisplay(), 50);
    }
}

// --- Audio System (Tone.js) ---
async function initAudio() {
    if (Tone.context.state !== 'running') await Tone.start();
    if (player) return; // Already Initialized

    // 1. Core Player
    player = new Tone.Player({
        fadeIn: 0.05,
        fadeOut: 0.05
    });
    player.loop = false;
    player.toDestination(); // Debug connection
    player.disconnect(); // Disconnect default destination

    // 2. Channel & Stereo Processing
    toneSplit = new Tone.Split();
    toneMerge = new Tone.Merge();
    gainL = new Tone.Gain(1);
    gainR = new Tone.Gain(1);

    // player.connect(toneSplit); // Removed: Now routing through widener -> preamp
    toneSplit.connect(gainL, 0); // L -> gainL
    toneSplit.connect(gainR, 1); // R -> gainR

    // Default Routing: Stereo (L->0, R->1 of merge)
    gainL.connect(toneMerge, 0, 0);
    gainR.connect(toneMerge, 0, 1);

    // 3. Effects Chain
    masterGain = new Tone.Gain(1);

    // EQ (5-Band) - Using 5 Peaking Filters
    const freqs = [60, 230, 910, 3600, 14000];
    eqNodes = freqs.map(f => {
        const filt = new Tone.Filter({
            type: "peaking",
            frequency: f,
            Q: 1.0,
            gain: 0
        });
        return filt;
    });

    // Preamplifier
    preamp = new Tone.Gain(1);
    widener = new Tone.StereoWidener(1);

    // Reverb
    reverb = new Tone.Reverb({
        decay: 5.0,
        preDelay: 0.1
    });
    reverb.wet.value = 1; // 100% Wet for parallel routing
    await reverb.generate();

    // Damping & Mixing (New)
    // Smooth filters (-12dB/oct) for natural sound
    rvbLowCut = new Tone.Filter(20, "highpass", -12);
    rvbHighCut = new Tone.Filter(20000, "lowpass", -12);
    rvbCrossFade = new Tone.CrossFade(0); // Initially Dry

    // 4. Virtual Bass Chain (The "Secret Sauce")
    // Parallel Path: Source -> LPF -> Chebyshev -> Gain -> Master
    vbFilter = new Tone.Filter(subFreq, "lowpass"); // Dynamic Crossover
    vbCheby = new Tone.Chebyshev(50); // Harmonics Generator
    vbGain = new Tone.Gain(0); // Mix Level

    // Connections
    // New Order: Player -> Widener -> Preamp -> Split -> (Channel Logic) -> Merge -> EQ -> Reverb -> Master

    // 1. Pre-Processing (Stereo Width & Preamp)
    player.connect(widener);
    widener.connect(preamp);

    // 2. Channel Splitting
    preamp.connect(toneSplit);

    // toneSplit connects to gainL/gainR (already set above: toneSplit.connect(gainL, 0)...)
    // gainL/gainR connect to toneMerge (managed by setChannelMode)

    // 3. Post-Processing (EQ & Reverb after Merge)
    // Chain: Merge -> GlobalLowPass -> EQ -> Reverb -> Master
    globalLowPass = new Tone.Filter(20000, "lowpass"); // Default Open

    toneMerge.connect(globalLowPass);
    let eqIn = globalLowPass;
    eqNodes.forEach(fx => {
        eqIn.connect(fx);
        eqIn = fx;
    });

    // [Wet/Dry Routing with Damping]
    // 1. Dry Path
    eqIn.connect(rvbCrossFade.a);

    // 2. Wet Path (Reverb -> LowCut -> HighCut -> CrossFade)
    eqIn.connect(reverb);
    reverb.connect(rvbLowCut);
    rvbLowCut.connect(rvbHighCut);
    rvbHighCut.connect(rvbCrossFade.b);

    // 3. Output
    rvbCrossFade.connect(masterGain);

    // 4. Virtual Bass Chain (Parallel from Preamp)
    // Tapping after Preamp means it gets the Widened & Boosted signal
    preamp.connect(vbFilter);
    vbFilter.connect(vbCheby);
    vbCheby.connect(vbGain);
    vbGain.connect(masterGain);

    // Visualizer
    analyser = new Tone.Analyser("fft", 2048);
    analyser.smoothing = 0.3; // Lower = more immediate/punchy response
    masterGain.connect(analyser);
    masterGain.toDestination();

    // Initial Defaults
    applySettings();
}

// --- Gesture Unlock ---
// --- Onboarding Logic ---
let obCurrentSlide = 0;

function initOnboarding() {
    // 1. Determine Type
    const params = new URLSearchParams(window.location.search);
    const hostId = params.get('host');

    // [Critical Fix for LTE] Pre-fill ID immediately. 
    // waiting for peer.on('open') is too slow on mobile networks.
    if (hostId) {
        document.getElementById('join-id-input').value = hostId;
    }

    const actionArea = document.getElementById('ob-actions');

    if (hostId) {
        // [Popup B] Guest Mode
        actionArea.innerHTML = `
            <button class="btn-ob-primary" onclick="actionEnterSession()">모임에 초대됐어요!</button>
        `;
    } else {
        // [Popup A] New User
        actionArea.innerHTML = `
            <button class="btn-ob-primary" onclick="actionCreateRoom()">방 만들기</button>
            <button class="btn-ob-secondary" onclick="actionJoinRoom()">참여하기</button>
        `;
    }
}

window.goToSlide = function (idx) {
    obCurrentSlide = idx;
    const track = document.getElementById('ob-track');
    const dots = document.querySelectorAll('.ob-dot');

    track.style.transform = `translateX(-${idx * 100}%)`;

    dots.forEach((d, i) => {
        d.classList.toggle('active', i === idx);
    });
};

window.nextSlide = function () {
    if (obCurrentSlide < 2) goToSlide(obCurrentSlide + 1);
    else goToSlide(0); // Optional loop
};

window.prevSlide = function () {
    if (obCurrentSlide > 0) goToSlide(obCurrentSlide - 1);
};

/* Actions */
let wakeLock = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('Screen Wake Lock active');
            wakeLock.addEventListener('release', () => {
                console.log('Screen Wake Lock released');
            });
        }
    } catch (err) {
        console.warn(`${err.name}, ${err.message}`);
    }
}

// Re-request wake lock when visibility changes
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        await requestWakeLock();
    }
});

async function activateAudio() {
    // 1. Start Tone.js Context (User Gesture)
    if (Tone.context.state !== 'running') {
        await Tone.start();
    }

    // 2. Initialize Graph
    // initAudio Checks if player exists, but calling it ensures setup
    await initAudio();
    initMediaSession();

    // 3. Silent Mode Bypass (iOS) - Play HTML5 Audio
    const silentAudio = document.getElementById('silent-trigger');
    if (silentAudio) {
        silentAudio.play().catch(e => console.log("Silent Audio play failed", e));
    }

    // 4. Manual Sync Mic Permission - REMOVED for better audio quality
    // (User Tap Sync replaces Sonic Sync)

    // 5. Wake Lock
    requestWakeLock();
}

window.actionCreateRoom = async function () {
    await activateAudio();
    // Using setTimeout to allow UI update if needed, but alert blocks anyway.
    setTimeout(() => {
        alert("이제 당신이 호스트입니다.\n다른 사람을 초대하거나 다른 기기를 추가하려면\n'Connect' 탭의 QR코드 또는 링크를 공유하세요.");
        document.getElementById('onboarding-overlay').style.display = 'none';
        switchTab('connect');
    }, 50);
};

window.actionJoinRoom = async function () {
    await activateAudio();
    setTimeout(() => {
        alert("호스트가 제공한 QR코드나 링크를 통해 접속하세요.\n'Connect' 탭에서 링크(ID)를 수동으로 입력하여 접속하실 수도 있습니다.");
        document.getElementById('onboarding-overlay').style.display = 'none';
        switchTab('connect');
    }, 50);
};

window.actionEnterSession = async function () {
    await activateAudio();
    document.getElementById('onboarding-overlay').style.display = 'none';
    joinSession(); // This handles the connection and logic
    switchTab('play'); // Guest goes to visualizer
};

// Wrapper function to check guest before triggering file input
function openFileSelector() {
    if (hostConn) {
        showToast("Host만 실행할 수 있습니다.");
        return;
    }
    document.getElementById('file-input').click();
}

// Auto-run init
document.addEventListener('DOMContentLoaded', initOnboarding);

// --- Playlist & Player Logic ---
document.getElementById('file-input').addEventListener('change', async (e) => {
    // File upload is Host-only (OP cannot relay file data to other guests)
    if (hostConn) return showToast("Host만 파일을 추가할 수 있습니다.");

    // Initialize AudioContext immediately on user gesture
    try {
        if (Tone.context.state !== 'running') await Tone.start();
        await initAudio();
    } catch (err) { console.error(err); }

    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    files.forEach(f => playlist.push({ type: 'local', file: f, name: f.name }));
    updatePlaylistUI();

    const metaList = playlist.map(item => ({
        type: item.type,
        name: item.name || item.title,
        videoId: item.videoId || null,
        playlistId: item.playlistId || null
    }));
    broadcast({ type: 'playlist-update', list: metaList });

    // [Optimization] Clear all cache metadata on Host side when playlist structure changes
    connectedPeers.forEach(p => { if (p.preloadedIndexes) p.preloadedIndexes.clear(); });
    console.log("[Host] Playlist changed, cleared all peer cache tracking");

    if (currentTrackIndex === -1) {
        playTrack(0);
    } else {
        showToast(`${files.length}곡 추가됨`);

        // Re-evaluate preload when new songs are added
        // Case 1: No preload queued yet -> trigger
        // Case 2: Current preload target is outdated (was looping to 0, but now there are new songs) -> re-trigger
        const wasLastTrack = (currentTrackIndex === playlist.length - files.length - 1);
        const shouldRePreload = !isPreloading && (nextTrackIndex === -1 || wasLastTrack);

        if (shouldRePreload) {
            // Clear previous preload state if any
            if (nextTrackIndex !== -1) {
                console.log("[Preload] New songs added, re-evaluating next track...");
                clearPreloadState();
            }
            preloadNextTrack();
        }
    }
    // Reset inputs
    e.target.value = '';
});

function toggleRepeat() {
    repeatMode = (repeatMode + 1) % 3;
    const btn = document.getElementById('btn-repeat');
    btn.classList.remove('active', 'active-one');
    if (repeatMode === 1) {
        btn.classList.add('active');
        showToast("반복 재생: 전체");
    } else if (repeatMode === 2) {
        btn.classList.add('active-one');
        showToast("반복 재생: 한 곡");
    } else {
        showToast("반복 재생: 끔");
    }
}

function toggleShuffle() {
    isShuffle = !isShuffle;
    document.getElementById('btn-shuffle').classList.toggle('active', isShuffle);
    showToast(isShuffle ? "셔플: 켜짐" : "셔플: 꺼짐");
}

function updatePlaylistUI() {
    const ul = document.getElementById('playlist-ui');
    ul.innerHTML = '';
    if (playlist.length === 0) {
        ul.innerHTML = '<li style="color:var(--text-sub); font-size:13px; text-align:center; padding:20px;">파일이 없습니다.</li>';
        return;
    }

    playlist.forEach((item, idx) => {
        const isCurrent = (idx === currentTrackIndex);
        const li = document.createElement('li');
        li.className = `track-item ${isCurrent ? 'active' : ''} ${item.playlistId ? 'is-playlist' : ''}`;

        // Expansion Toggle for Playlists
        let expandBtn = '';
        if (item.playlistId) {
            expandBtn = `
                <div class="expand-toggle ${item.isExpanded ? 'active' : ''}" onclick="event.stopPropagation(); toggleExpansion(${idx});">
                    <svg viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>
                </div>
            `;
        }

        const icon = item.type === 'youtube'
            ? '<svg class="type-icon" viewBox="0 0 24 24" style="fill:#ff0000;"><path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47.13-1.33.22-2.65.28-1.3.07-2.49.1-3.59.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47-.13 1.33.22 2.65.28 1.3.07 2.49.1 3.59.1L12 5c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z"/></svg>'
            : '<svg class="type-icon" viewBox="0 0 24 24"><path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.16-1.75 4.45-4H15V6h4V3h-7z"/></svg>';

        const displayName = item.name || item.title || 'Unknown';
        li.onclick = () => {
            if (!hostConn) playTrack(idx);
            else if (isOperator) hostConn.send({ type: 'request-track-change', index: idx });
        };

        li.innerHTML = `
            <div class="track-idx">${idx + 1}</div>
            <div class="track-name">${icon} ${displayName}</div>
            ${expandBtn}
            <div class="playing-indicator">
                <div class="bar"></div>
                <div class="bar"></div>
                <div class="bar"></div>
            </div>
        `;
        ul.appendChild(li);

        // Render Sub-items if expanded
        if (item.playlistId && item.isExpanded) {
            const subUl = document.createElement('ul');
            subUl.className = 'sub-playlist';

            // If we have data about this playlist items
            const subData = youtubeSubItemsMap[item.playlistId];
            if (subData && subData.ids) {
                subData.ids.forEach((sid, sIdx) => {
                    const sli = document.createElement('li');
                    const isActiveSub = (isCurrent && sIdx === currentYouTubeSubIndex);
                    sli.className = `sub-track-item ${isActiveSub ? 'active' : ''}`;

                    const sTitle = (subData.titles && subData.titles[sIdx]) ? subData.titles[sIdx] : `Video ${sIdx + 1}`;
                    sli.innerHTML = `
                        <span class="sub-idx">${sIdx + 1}</span> 
                        <span class="sub-name">${sTitle}</span>
                        <div class="playing-indicator">
                            <div class="bar"></div>
                            <div class="bar"></div>
                            <div class="bar"></div>
                        </div>
                    `;

                    sli.onclick = (e) => {
                        e.stopPropagation();
                        if (hostConn && !isOperator) return;
                        if (!hostConn) {
                            if (isCurrent && youtubePlayer && youtubePlayer.playVideoAt) {
                                youtubePlayer.playVideoAt(sIdx);
                            } else {
                                // Not playing this playlist yet? Start it at this index.
                                // We'd need to modify loadYouTubeVideo to take a start index.
                                currentYouTubeSubIndex = sIdx;
                                playTrack(idx);
                            }
                        } else {
                            // OP request
                            hostConn.send({ type: 'request-youtube-sub-seek', playlistIdx: idx, subIdx: sIdx });
                        }
                    };
                    subUl.appendChild(sli);
                });
            } else {
                subUl.innerHTML = '<li class="sub-track-item loading">재생 정보 대기 중...</li>';
            }
            ul.appendChild(subUl);
        }
    });
}

// --- Media Session API (System Controls) ---
function initMediaSession() {
    if (!('mediaSession' in navigator)) return;

    console.log("[MediaSession] Initializing action handlers...");

    navigator.mediaSession.setActionHandler('play', () => {
        if (!isPlaying) togglePlay();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
        if (isPlaying) togglePlay();
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
        playPrevTrack();
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
        playNextTrack();
    });
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        skipTime(-(details.seekOffset || 10));
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
        skipTime(details.seekOffset || 10);
    });

    try {
        navigator.mediaSession.setActionHandler('stop', () => {
            stop();
        });
    } catch (e) { }
}

function updateMediaSessionMetadata(item) {
    if (!('mediaSession' in navigator) || !item) return;

    let title = item.name || item.title || 'Unknown Track';
    let artist = item.channel || (item.type === 'youtube' ? 'YouTube' : 'MUSIXQUARE');
    let artwork = [];

    if (item.type === 'youtube') {
        // If it's a playlist item and we have a sub-title, use it
        if (item.playlistId && currentYouTubeSubIndex !== -1) {
            const subData = youtubeSubItemsMap[item.playlistId];
            if (subData && subData.titles[currentYouTubeSubIndex]) {
                title = subData.titles[currentYouTubeSubIndex];
            } else {
                title = `${item.title || 'Playlist'} (${currentYouTubeSubIndex + 1})`;
            }
        }

        if (item.thumbnail) {
            artwork = [{ src: item.thumbnail, sizes: '480x360', type: 'image/jpeg' }];
        }
    } else {
        artwork = [{ src: 'HFNY4ren.svg', sizes: '512x512', type: 'image/svg+xml' }];
    }

    navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: artist,
        album: 'MUSIXQUARE',
        artwork: artwork
    });
}

function toggleExpansion(idx) {
    if (playlist[idx]) {
        playlist[idx].isExpanded = !playlist[idx].isExpanded;

        if (playlist[idx].isExpanded && playlist[idx].playlistId) {
            let ids = [];
            let pid = playlist[idx].playlistId;

            // 1. Try to get IDs from current player if it matches
            if (youtubePlayer && youtubePlayer.getPlaylist && playlist[currentTrackIndex] && playlist[currentTrackIndex].playlistId === pid) {
                try {
                    ids = youtubePlayer.getPlaylist() || [];
                } catch (e) { }
            }

            // 2. Initial map setup
            if (ids.length > 0) {
                if (!youtubeSubItemsMap[pid]) {
                    youtubeSubItemsMap[pid] = { ids: ids, titles: [] };
                } else if (!youtubeSubItemsMap[pid].ids || youtubeSubItemsMap[pid].ids.length === 0) {
                    youtubeSubItemsMap[pid].ids = ids;
                }
            }

            // 3. Trigger background title fetcher (Host Only)
            if (!hostConn) {
                if (youtubeSubItemsMap[pid] && youtubeSubItemsMap[pid].ids && youtubeSubItemsMap[pid].ids.length > 0) {
                    fetchPlaylistSubTitles(pid, youtubeSubItemsMap[pid].ids);
                }
            } else {
                // Guest: Request info from Host if map is missing or empty
                if (!youtubeSubItemsMap[pid] || !youtubeSubItemsMap[pid].ids || youtubeSubItemsMap[pid].ids.length === 0) {
                    hostConn.send({ type: 'request-youtube-playlist-info', playlistId: pid });
                }
            }
        }
        updatePlaylistUI();
    }
}

// Background fetcher for YouTube titles (No API Key needed)
async function fetchPlaylistSubTitles(playlistId, ids) {
    if (hostConn) return; // Host only
    if (!ids || ids.length === 0) return;

    const data = youtubeSubItemsMap[playlistId];
    if (!data) return;

    if (data._isFetching) return; // Dedupe
    data._isFetching = true;

    console.log(`[YouTube Feed] Starting title fetch for playlist: ${playlistId} (${ids.length} items)`);

    for (let i = 0; i < ids.length; i++) {
        // Skip if already has title
        if (data.titles[i]) continue;

        try {
            const videoId = ids[i];
            // Sequential fetching with a small delay to avoid rate limiting
            const response = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
            const json = await response.json();

            if (json && json.title) {
                data.titles[i] = json.title;
                console.log(`[YouTube Feed] Fetched Title [${i}]: ${json.title}`);

                // Update UI and broadcast to guests
                updatePlaylistUI();
                broadcast({
                    type: 'youtube-sub-title-update',
                    playlistId: playlistId,
                    subIdx: i,
                    title: json.title
                });
            }
        } catch (e) {
            console.warn(`[YouTube Feed] Failed to fetch title for ${ids[i]}:`, e);
        }

        // 200ms delay between requests
        await new Promise(r => setTimeout(r, 200));
    }
    data._isFetching = false;
}

async function playTrack(index) {
    if (index < 0 || index >= playlist.length) return;

    // FIX: Clear existing autoplay timer to prevent audio overlap
    if (autoPlayTimer) {
        clearTimeout(autoPlayTimer);
        autoPlayTimer = null;
    }

    // Auto-switch to Play tab when starting a track (Host only)
    if (!hostConn) switchTab('play');

    // Check if this track is already preloaded (Host Side Check)
    if (index === nextTrackIndex && (nextBuffer || nextFileBlob) && !hostConn) {
        console.log("[Host] Using Preloaded Track:", index);
        currentTrackIndex = index;
        updatePlaylistUI();

        // 1. Host Switches Locally Fast
        await loadPreloadedTrack();

        // 2. Get track info for Guest fallback
        const item = playlist[index];
        const fileName = item?.file?.name || item?.name || `Track ${index}`;

        // 3. Broadcast ONLY play-preloaded command
        // Guests who have preload will use it
        // Guests who DON'T have preload will send request-data-recovery
        // This saves Host upload bandwidth by not sending file to everyone
        broadcast({ type: 'play-preloaded', index: index, name: fileName });

        // 4. Start Playback (with delay for Guests to switch buffers or request file)
        setTimeout(() => {
            play(0); // This broadcasts { type: 'play', time: ... }
        }, 500);

        // Schedule Auto-Sync (5s later)
        setTimeout(() => {
            handleMainSyncBtn();
        }, 5000);

        // Trigger Next Preload
        preloadNextTrack();
        return;
    }




    currentTrackIndex = index;
    updatePlaylistUI();

    const item = playlist[index];
    updateMediaSessionMetadata(item);

    // Route based on type
    if (item.type === 'youtube') {
        // YouTube playback (Host only)
        if (!hostConn) {
            // Stop local playback first (prevent overlap)
            stop();

            // Cancel any running preload immediately
            preloadSessionId++;
            isPreloading = false;

            // IMMEDIATELY broadcast to guests so they switch too
            broadcast({
                type: 'youtube-play',
                videoId: item.videoId,
                playlistId: item.playlistId,
                index: index,
                autoplay: false  // Will send 'play' command separately
            });

            // Same logic as local: first track = wait for button, else = 3s countdown
            if (isFirstTrackLoad) {
                isFirstTrackLoad = false;
                // Load YouTube but DON'T auto-play (playerVars.autoplay will be 0)
                loadYouTubeVideo(item.videoId, item.playlistId, false);
                showToast("YouTube 준비 완료! 재생 버튼을 눌러주세요.");
            } else {
                // Load first (paused), then auto-play after 3s
                loadYouTubeVideo(item.videoId, item.playlistId, false);
                showToast("3초 후 YouTube 재생...");
                autoPlayTimer = setTimeout(() => {
                    autoPlayTimer = null;
                    if (youtubePlayer && youtubePlayer.playVideo) {
                        youtubePlayer.playVideo();
                        // Broadcast play state sync
                        broadcastYouTubeSync();
                    }
                }, 3000);
            }
        }
        return;
    }

    // Local file playback
    // Stop YouTube mode if active (restore visualizer)
    if (isYouTubeMode) {
        stopYouTubeMode();
        // Notify guests to stop YouTube too
        if (!hostConn) {
            broadcast({ type: 'youtube-stop' });
        }
    }
    // Also stop any local audio
    stop();

    const file = item.file;
    if (!hostConn) {
        // Standard Load
        broadcast({ type: 'file-prepare', name: file.name, index: index });
        await loadAndBroadcastFile(file);

        // After loading current, start preloading next
        // preloadNextTrack is already called inside loadAndBroadcastFile (line 773)
        // so we don't need to call it here.

        // AUTO PLAY with 3s Delay - Only on track advancement, not first load
        if (isFirstTrackLoad) {
            isFirstTrackLoad = false;  // Mark first load as done
            showToast("파일 준비 완료! 재생 버튼을 눌러주세요.");
        } else {
            showToast("3초 후 재생 시작...");
            autoPlayTimer = setTimeout(() => {
                autoPlayTimer = null;
                play(0);
                broadcast({ type: 'play', time: 0 });
            }, 3000);
        }
    }
}

async function preloadNextTrack() {
    if (playlist.length <= 1) return;

    // Cancel previous preload if running
    if (isPreloading) {
        console.log("[Preload] Cancelling previous preload session");
    }
    preloadSessionId++;  // Invalidate previous session
    const currentSession = preloadSessionId;

    // Determine Next Index logic (copy of playNextTrack logic)
    let nextIdx;
    if (repeatMode === 2) nextIdx = currentTrackIndex; // Repeat One
    else if (isShuffle) {
        // Simple shuffle: valid random
        do {
            nextIdx = Math.floor(Math.random() * playlist.length);
        } while (nextIdx === currentTrackIndex && playlist.length > 1);
    } else {
        nextIdx = currentTrackIndex + 1;
        if (nextIdx >= playlist.length) nextIdx = 0; // Loop list
    }

    // Update State
    nextTrackIndex = nextIdx;
    const item = playlist[nextIdx];

    // Skip preload for YouTube items
    if (item.type === 'youtube') {
        console.log("[Preload] Next is YouTube, skipping preload");
        isPreloading = false;
        return;
    }

    const file = item.file;
    console.log("[Preload] Starting for:", file.name, "session:", currentSession);
    isPreloading = true;

    // 1. Host Loads Locally (Background)
    // We don't want to decode yet if using AudioBuffer to save RAM? 
    // Actually decoding 2 tracks is fine.
    // But for Video/Large file, we just hold the Blob.

    // 2. Broadcast Preload
    // Special function to broadcast without stopping playback
    await broadcastPreloadFile(file, nextIdx, currentSession);

    // Only mark complete if this session wasn't cancelled
    if (preloadSessionId === currentSession) {
        isPreloading = false;
    }
}


// New: Broadcast for Background Preloading
async function broadcastPreloadFile(file, index, sessionId) {
    if (file.type.startsWith('video/') && !hostConn) {
        // Host Logic for Video: Extract Audio -> Broadcast WAV (Background)
        try {
            // Check session before expensive operation
            if (preloadSessionId !== sessionId) return;
            const wavFile = await extractAudioToWav(file);
            console.log("[Preload] Audio Extracted:", wavFile.name);
            await backgroundTransfer(wavFile, index, sessionId);
        } catch (e) {
            console.error("Preload Extraction Failed", e);
            await backgroundTransfer(file, index, sessionId);
        }
    } else {
        await backgroundTransfer(file, index, sessionId);
    }
}

// Transfer without UI blocking
async function backgroundTransfer(file, index, sessionId) {
    const CHUNK = 16384;
    const total = Math.ceil(file.size / CHUNK);
    const header = {
        type: 'preload-start',
        name: file.name,
        mime: file.type,
        total: total,
        size: file.size,
        index: index,
        sessionId: sessionId // [Optimization] Included for tracking/cancellation
    };

    // Transfer to direct data targets (who will relay to others)
    const getTargets = () => {
        return connectedPeers.filter(p =>
            p.status === 'connected' &&
            p.conn.open &&
            p.isDataTarget !== false
        );
    };

    const targets = getTargets();

    if (targets.length === 0) {
        console.log("[Preload] No active data targets, skipping transfer");
        return;
    }

    // Determine which targets actually need the data chunks
    const targetsWhoNeedChunks = targets.filter(p => !p.preloadedIndexes || !p.preloadedIndexes.has(index));

    // [Optimization] Send header UNICAST so we can tell each peer if we are skipping chunks
    targets.forEach(p => {
        const peerNeedsChunks = !p.preloadedIndexes || !p.preloadedIndexes.has(index);
        if (p.conn.open) {
            // [Fix] Peer-specific header
            p.conn.send({ ...header, skipped: !peerNeedsChunks });
        }
    });

    const sendToTargets = (msg, chunksOnly = false) => {
        const list = chunksOnly ? targetsWhoNeedChunks : targets;
        list.forEach(p => {
            if (p.conn.open) p.conn.send(msg);
        });
    };

    for (let i = 0; i < total; i++) {
        // Check if this preload session was cancelled
        if (preloadSessionId !== sessionId) {
            console.log("[Preload] Session cancelled, stopping transfer at chunk", i);
            return;
        }

        // Flow Control: check primary targets only (they handle downstream)
        let congested = true;
        while (congested) {
            congested = false;
            for (const p of targets) {
                if (p.conn.open && p.conn.dataChannel && p.conn.dataChannel.bufferedAmount > 1 * 1024 * 1024) {
                    congested = true;
                    break;
                }
            }
            if (congested) await new Promise(r => setTimeout(r, 100));
        }

        const start = i * CHUNK;
        const end = Math.min(start + CHUNK, file.size);
        const chunkBlob = file.slice(start, end);
        const chunkBuf = await chunkBlob.arrayBuffer();
        const chunk = new Uint8Array(chunkBuf);

        const chunkMsg = { type: 'preload-chunk', chunk: chunk, index: i };
        sendToTargets(chunkMsg, true); // true = send only to those who need chunks

        // Slow down sending to save CPU/Network for playback
        if (i % 10 === 0) await new Promise(r => setTimeout(r, 20));
    }

    // Final session check before completing
    if (preloadSessionId === sessionId) {
        sendToTargets({ type: 'preload-end', name: file.name, index: index, sessionId: sessionId });
        console.log("[Preload] Complete for index:", index);
    }
}


function playNextTrack() {
    // Guest (non-OP): blocked
    if (hostConn && !isOperator) return showToast("Host만 실행할 수 있습니다.");

    // OP: request Host to change track
    if (hostConn && isOperator) {
        hostConn.send({ type: 'request-next-track' });
        return;
    }

    // Host: execute directly

    // YouTube Playlist Internal Navigation
    if (isYouTubeMode && youtubePlayer && youtubePlayer.getPlaylist) {
        try {
            const playlistIds = youtubePlayer.getPlaylist() || [];
            const currentIndex = youtubePlayer.getPlaylistIndex();

            if (playlistIds.length > 0 && currentIndex < playlistIds.length - 1) {
                console.log("[YouTube] Next internal video:", currentIndex + 1);
                youtubePlayer.nextVideo();
                return; // Stay on the same MUSIXQUARE track
            }
        } catch (e) {
            console.warn("[YouTube] Internal next failed:", e);
        }
    }

    // If we have a preloaded track ready with actual data, use it (respects shuffle decision)
    if (nextTrackIndex !== -1 && (nextBuffer || nextFileBlob)) {
        playTrack(nextTrackIndex);
        return;
    }

    let nextIndex;
    if (playlist.length === 0) return;

    if (repeatMode === 2) {
        nextIndex = currentTrackIndex;
    } else if (isShuffle) {
        nextIndex = Math.floor(Math.random() * playlist.length);
    } else {
        nextIndex = currentTrackIndex + 1;
        if (nextIndex >= playlist.length) {
            if (repeatMode === 1) nextIndex = 0;
            else return; // Stop at end
        }
    }
    playTrack(nextIndex);
}

function playPrevTrack() {
    // Guest (non-OP): blocked
    if (hostConn && !isOperator) return showToast("Host만 실행할 수 있습니다.");

    // OP: request Host to change track
    if (hostConn && isOperator) {
        hostConn.send({ type: 'request-prev-track' });
        return;
    }

    // Host: execute directly

    // YouTube mode
    if (isYouTubeMode && youtubePlayer) {
        try {
            const currentTime = youtubePlayer.getCurrentTime();
            const playlistIds = youtubePlayer.getPlaylist ? youtubePlayer.getPlaylist() : null;
            const subIndex = youtubePlayer.getPlaylistIndex ? youtubePlayer.getPlaylistIndex() : -1;

            if (currentTime > 3) {
                youtubePlayer.seekTo(0, true);
                broadcast({ type: 'youtube-state', state: youtubePlayer.getPlayerState ? youtubePlayer.getPlayerState() : 1, time: 0 });
                return;
            }

            // Internal YouTube Playlist Navigation
            if (playlistIds && playlistIds.length > 0 && subIndex > 0) {
                console.log("[YouTube] Prev internal video:", subIndex - 1);
                youtubePlayer.previousVideo();
                return;
            }
        } catch (e) {
            console.error("[YouTube] Prev track error:", e);
        }
        // If < 3 seconds or at start of sub-playlist, go to previous track in MUSIXQUARE playlist
        if (currentTrackIndex > 0) playTrack(currentTrackIndex - 1);
        else playTrack(0);
        return;
    }

    // Local mode
    if (Tone.context && Tone.now() - startedAt > 3) {
        play(0); // Restart current
        broadcast({ type: 'play', time: 0 });
        return;
    }
    if (currentTrackIndex > 0) playTrack(currentTrackIndex - 1);
    else playTrack(0);
}

// Track ObjectURL for cleanup (prevents memory leak)
let currentMediaObjectURL = null;

async function loadAndBroadcastFile(file) {
    showLoader(true, `준비 중: ${file.name} `);
    stop();

    // Stop YouTube mode if active
    if (isYouTubeMode) {
        stopYouTubeMode();
    }

    try {
        await initAudio();
        if (Tone.context.state === 'suspended') await Tone.start();

        // Cleanup previous ObjectURL to prevent memory leak
        if (currentMediaObjectURL) {
            URL.revokeObjectURL(currentMediaObjectURL);
            currentMediaObjectURL = null;
        }

        const url = URL.createObjectURL(file);
        currentMediaObjectURL = url; // Track for later cleanup

        // Determine Mode: Large File or Video -> Streaming Mode
        // Threshold: 100MB (Arbitrary safety limit for mobile decoding)
        let isLargeFile = file.size > 100 * 1024 * 1024;
        let isVideo = false;

        if (file.type.startsWith('video/')) {
            isVideo = true;
        } else if (!file.type && file.name) {
            const ext = file.name.split('.').pop().toLowerCase();
            if (['mp4', 'mkv', 'webm', 'mov'].includes(ext)) isVideo = true;
        }

        // Force Streaming Mode if Video or Large File
        if (isVideo || isLargeFile) {
            console.log("Large File/Video detected. Using Streaming Mode (MediaElementSource).");
            buffer = null; // No Tone.Buffer
            isVideoMode = true; // Use Video Element for timing/playback even if it's just chunks

            // UI Info Update
            updateTitleWithMarquee(file.name);
            document.getElementById('track-artist').innerText = `Track ${currentTrackIndex + 1} `;

            // Setup Video Element
            document.body.classList.add('mode-video');
            videoElement.style.display = isVideo ? 'block' : 'none'; // Hide if just audio-large
            videoElement.src = url;

            // Wait for metadata to get duration
            videoElement.onloadedmetadata = () => {
                const dur = videoElement.duration;
                // Safety check: sometimes duration is Infinity for streams
                if (dur && isFinite(dur)) {
                    document.getElementById('time-dur').innerText = fmtTime(dur);
                    const sSlider = document.getElementById('seek-slider');
                    sSlider.max = dur;
                    sSlider.value = 0;
                }
            };

            videoElement.load();

            // Connect Video Element to Tone.js Graph
            setupMediaSource();

            showToast(isVideo ? "Video Mode (Streaming)" : "Large File Mode (Streaming)");
        } else {
            // Standard Tone.Buffer Mode (Small Files)
            isVideoMode = false;
            document.body.classList.remove('mode-video');
            videoElement.style.display = 'none';
            videoElement.removeAttribute('src');
            videoElement.load();

            // Load into RAM (Safe Loader)
            buffer = null; // Clear old buffer
            const tempBuffer = new Tone.Buffer();
            await tempBuffer.load(url);

            // Only assign after fully loaded
            buffer = tempBuffer;

            updateTitleWithMarquee(file.name);
            document.getElementById('track-artist').innerText = `Track ${currentTrackIndex + 1} `;
            document.getElementById('time-dur').innerText = fmtTime(buffer.duration);

            const sSlider = document.getElementById('seek-slider');
            sSlider.max = buffer.duration;
            sSlider.value = 0;
        }

        // Enable Play Button
        const isGuest = !!hostConn;
        document.getElementById('play-btn').disabled = isGuest && !isOperator;

        if (connectedPeers.length > 0) {
            if (isVideo && !hostConn) {
                // Host Logic for Video: Extract Audio -> Broadcast WAV
                showLoader(true, "오디오 추출 및 변환 중...");
                showToast("게스트용 오디오 추출 중...");

                // Yield to UI
                await new Promise(r => setTimeout(r, 100));

                try {
                    const wavFile = await extractAudioToWav(file);
                    console.log("[Host] Audio Extracted:", wavFile.name, wavFile.size);
                    showToast("오디오 변환 완료! 전송 시작...");

                    // Broadcast the WAV file instead of the huge video
                    await broadcastFile(wavFile);
                } catch (e) {
                    console.error("Audio Extraction Failed", e);
                    showToast("오디오 추출 실패. 원본 전송 시도...");
                    await broadcastFile(file);
                }
            } else {
                showToast("파일 전송 중...");
                await broadcastFile(file);
            }
        }

        // Trigger Preload for next track (Host only)
        if (!hostConn) {
            preloadNextTrack();
        }

    } catch (err) {
        console.error(err);
        showToast(`Load Failed: ${err.message} `);
    } finally {
        showLoader(false);
        pausedAt = 0;
        updatePlayState(false);
    }
}

// --- Playback Engine (Tone.js) ---
let mediaSourceNode = null;

function setupMediaSource() {
    if (!videoElement) return;

    // HOST VIDEO BYPASS: On Host, skip Tone.js routing for video
    // This enables hardware acceleration on iOS/iPadOS
    // Guests still use Tone.js (they receive WAV, not video)
    const isHost = !hostConn;
    if (isHost && isVideoMode) {
        console.log("[Host] Video mode: Using native playback (Tone.js bypassed for HW acceleration)");
        videoElement.muted = false; // Use native audio
        // Don't create MediaElementSource - let video play natively
        return;
    }

    // Ensure Context
    if (Tone.context.state !== 'running') Tone.context.resume();

    // Create Source ONLY ONCE per element to avoid errors
    if (!mediaSourceNode) {
        // Use rawContext for native MediaElementSource
        mediaSourceNode = Tone.context.rawContext.createMediaElementSource(videoElement);
    }

    if (!mediaDownmixNode) {
        mediaDownmixNode = new Tone.Gain(1);
        // FORCE DOWNMIX (Standard Mode): 5.1/7.1 -> Stereo
        mediaDownmixNode.channelCount = 2;

        mediaDownmixNode.channelInterpretation = 'speakers';
    }

    if (!surroundSplitter) {
        // 8 Channel Splitter for 7.1
        // (0:L, 1:R, 2:C, 3:LFE, 4:SL, 5:SR, 6:BL, 7:BR)
        surroundSplitter = new Tone.Split(8);
    }

    if (!surroundGain) {
        surroundGain = new Tone.Gain(1); // Mono feeder
    }

    // Connect logic
    try {
        if (player) player.disconnect();

        try { mediaSourceNode.disconnect(); } catch (e) { }
        try { mediaDownmixNode.disconnect(); } catch (e) { }
        try { surroundSplitter.disconnect(); } catch (e) { }
        try { surroundGain.disconnect(); } catch (e) { }

        // Branch 1: Standard Stereo Path (Downmix -> Widener)
        // If Surround Mode is OFF, we use this.
        // If Surround Mode is ON, we use Branch 2.

        // Actually, we can run both or switch? 
        // Let's connect MEDIA SOURCE to both "Downmixer" and "Splitter".
        // Then we choose who feeds the "Widener/Preamp" based on mode.

        if (isSurroundMode) {
            // Surround Path: Source -> Splitter -> (Select 1) -> SurroundGain -> Preamp
            Tone.connect(mediaSourceNode, surroundSplitter);

            // Fix: Connect Music Player to Surround Splitter as well
            if (player) player.connect(surroundSplitter);

            // Connector from Splitter to SurroundGain is managed by setSurroundChannel()
            // But we need to ensure SurroundGain connects to graph
            // We inject into Preamp (bypassing Widener because it expects Stereo)
            // Actually Preamp is mono-capable? Preamp is Tone.Gain.
            // Let's connect SurroundGain -> Preamp.
            surroundGain.connect(preamp);

            // Ensure Widener is disconnected from Preamp?
            // Widener connects to Preamp setup in initAudio. 
            // We need to disconnect Widener from Preamp to avoid noise?
            // Or just mute Widener inputs.
            // mediaDownmixNode -> Widener path is broken if we don't connect it.
            // So just don't connect mediaSourceNode to mediaDownmixNode here.

            // Restore Channel Selection (Routing: Splitter -> Gain)
            // We pass true to skip calling setupMediaSource again (recursion)
            if (surroundChannelIndex !== -1) {
                setSurroundChannel(surroundChannelIndex, null, true);
            }

        } else {
            // Standard Path: Source -> Downmix -> Widener -> Preamp
            Tone.connect(mediaSourceNode, mediaDownmixNode);
            mediaDownmixNode.connect(widener);

            // Fix: Connect Music Player to Widener (Standard Path)
            if (player) player.connect(widener);

            // Safety Re-connect Chain
            try {
                widener.disconnect();
                widener.connect(preamp);

                preamp.disconnect();
                preamp.connect(toneSplit);
                // Preamp also feeds vbFilter (Virtual Bass)
                preamp.connect(vbFilter);
            } catch (e) { console.warn("Chain reconnect warn", e); }
        }

        videoElement.muted = false;

    } catch (e) {
        console.warn("MediaSource Setup Error:", e);
    }
}

async function play(offset) {
    if (isYouTubeMode) {
        console.warn("[Audio] Blocked play() call while in YouTube mode");
        return;
    }

    if (Tone.context.state !== 'running') {
        try { await Tone.context.resume(); } catch (e) { console.warn("Resume failed:", e); }
    }

    if (!buffer && !isVideoMode) return;
    initAudio();

    if (player.state === 'started') player.stop();

    if (buffer) {
        // --- BUFFER MODE ---
        // Ensure Buffer is Ready (Tone.Buffer has .loaded, raw AudioBuffer does not)
        if (buffer instanceof Tone.Buffer && !buffer.loaded) {
            console.log("Buffer still loading, waiting...");
            try { await buffer.loaded; } catch (e) { console.error("Buffer load failed", e); return; }
        }

        // Connect player to graph
        player.disconnect();
        if (isSurroundMode) player.connect(surroundSplitter);
        else player.connect(widener);

        if (player.buffer !== buffer) player.buffer = buffer;
        player.start(undefined, offset);
    } else if (isVideoMode) {
        // --- STREAMING MODE ---
        // Ensure routing is set
        setupMediaSource();
        // Seek & Play
        videoElement.currentTime = offset;
        videoElement.play().catch(e => console.log('Video play failed', e));
    }

    // [Time Sync Correction]
    // startedAt is the GLOBAL time when the track "started" (virtual start time).
    // We adjust this by our local Manual Offset AND the Auto Sync Offset.
    // [NOTE #10] Offsets are applied ONCE at play start - not accumulated per tick.
    // localOffset = manual user adjustment, autoSyncOffset = network sync correction
    startedAt = Tone.now() - offset + (localOffset + autoSyncOffset);
    pausedAt = offset;
    isPlaying = true;

    updatePlayState(true);
    startVisualizer();

    if (isVideoMode) {
        timerWorker.postMessage({ command: 'START_TIMER', id: 'video-sync', interval: 500 });
    }

    loopUI();
}

function handleEnded() {
    const duration = buffer ? buffer.duration : (videoElement ? videoElement.duration : 0);

    // Safety: Skip if duration is invalid (prevents infinite time increase)
    if (!duration || !isFinite(duration) || duration <= 0) {
        return;
    }

    let curr = 0;
    if (buffer) {
        // [Fix] Don't rely strictly on player.state === 'started' because it can stop 
        // almost instantly if seeking to the very end. Use global playback time.
        curr = (Tone.now() - startedAt) + localOffset;
    } else if (isVideoMode && videoElement) {
        curr = videoElement.currentTime;
    }

    // Safety: Clamp current time to duration to prevent runaway values after end
    // but check for end logic using the raw value
    const isPastEnd = (curr >= duration - 0.3); // Tightened threshold

    if (isPlaying && isPastEnd) {
        console.log(`Track ended at ${curr.toFixed(2)} s / ${duration.toFixed(2)} s`);
        isPlaying = false;
        updatePlayState(false);
        pausedAt = 0;
        document.getElementById('seek-slider').value = 0;
        document.getElementById('time-curr').innerText = fmtTime(0);

        // Stop playback explicitly
        if (player && player.state === 'started') {
            try { player.stop(); } catch (e) { /* ignore */ }
        }
        if (isVideoMode && videoElement && !videoElement.paused) {
            videoElement.pause();
        }

        // Auto Advance (Host Only)
        // Guests wait for Host command
        if (!hostConn) {
            if (repeatMode === 2) {
                // Repeat One: Play same track again
                console.log("Repeat One: Replaying current track...");
                setTimeout(() => playTrack(currentTrackIndex), 500);
            } else {
                console.log("Auto-advancing to next track...");
                setTimeout(() => playNextTrack(), 500);
            }
        }
    }
}

function stop() {
    if (player && player.state === 'started') player.stop();
    if (isVideoMode && videoElement) { videoElement.pause(); videoElement.currentTime = 0; }
    isPlaying = false;
    updatePlayState(false);

    timerWorker.postMessage({ command: 'STOP_TIMER', id: 'video-sync' });
}


function togglePlay() {
    if (hostConn && !isOperator) return showToast("Host만 실행할 수 있습니다.");

    // YouTube Mode: Control via YT API
    if (isYouTubeMode && youtubePlayer) {
        // OP: request Host to control YouTube
        if (hostConn && isOperator) {
            try {
                const state = youtubePlayer.getPlayerState();
                if (state === YT.PlayerState.PLAYING) {
                    hostConn.send({ type: 'request-youtube-pause' });
                } else {
                    hostConn.send({ type: 'request-youtube-play' });
                }
            } catch (e) {
                console.error("[YouTube] OP toggle error:", e);
            }
            return;
        }

        // Host: execute directly
        try {
            const state = youtubePlayer.getPlayerState();
            if (state === YT.PlayerState.PLAYING) {
                youtubePlayer.pauseVideo();
                broadcast({ type: 'youtube-state', state: 2, time: youtubePlayer.getCurrentTime() });
            } else {
                youtubePlayer.playVideo();
                broadcast({ type: 'youtube-state', state: 1, time: youtubePlayer.getCurrentTime() });
            }
        } catch (e) {
            console.error("[YouTube] Toggle play error:", e);
        }
        return;
    }

    if (!buffer && !isVideoMode) return;

    // Cancel pending auto-play timer if host manually controls playback
    if (!hostConn && autoPlayTimer) {
        clearTimeout(autoPlayTimer);
        autoPlayTimer = null;
        showToast("자동 재생 취소됨");
    }

    if (isPlaying) {
        if (!hostConn) { pause(); broadcast({ type: 'pause' }); }
        else if (isOperator) hostConn.send({ type: 'request-pause' });
    } else {
        if (!hostConn) { play(pausedAt); broadcast({ type: 'play', time: pausedAt }); }
        else if (isOperator) hostConn.send({ type: 'request-play', time: pausedAt });
    }
}

function pause() {
    if (isPlaying) {
        if (player) player.stop();
        if (isVideoMode && videoElement) videoElement.pause();

        // Calculate pause position
        if (buffer) pausedAt = Tone.now() - startedAt;
        else pausedAt = videoElement.currentTime;

        if (isVideoMode && videoElement) videoElement.currentTime = pausedAt;
    }
    isPlaying = false;
    updatePlayState(false);

    timerWorker.postMessage({ command: 'STOP_TIMER', id: 'video-sync' });
}

function skipTime(sec) {
    // Guest (non-OP): blocked
    if (hostConn && !isOperator) return showToast("Host만 실행할 수 있습니다.");

    // OP: request Host to skip time
    if (hostConn && isOperator) {
        hostConn.send({ type: 'request-skip-time', sec: sec });
        return;
    }

    // Host: execute directly
    // YouTube mode: use YouTube API
    if (isYouTubeMode && youtubePlayer) {
        try {
            const currentTime = youtubePlayer.getCurrentTime();
            const duration = youtubePlayer.getDuration();
            let target = currentTime + sec;

            if (target < 0) target = 0;
            if (target > duration) target = duration;

            youtubePlayer.seekTo(target, true);

            // Broadcast to guests
            broadcast({ type: 'youtube-state', state: youtubePlayer.getPlayerState(), time: target });
        } catch (e) {
            console.error("[YouTube] Skip time error:", e);
        }
        return;
    }

    // Local mode
    if (!buffer && !isVideoMode) return;

    let current = isPlaying ? (Tone.now() - startedAt) : pausedAt;
    if (isVideoMode && !buffer) current = videoElement.currentTime;

    let target = current + sec;
    const duration = buffer ? buffer.duration : (videoElement ? videoElement.duration : 0);

    if (target < 0) target = 0;
    if (target > duration) target = duration;

    // Broadcast
    play(target);
    broadcast({ type: 'play', time: target });
}

function updatePlayState(playing) {
    document.getElementById('icon-play').style.display = playing ? 'none' : 'block';
    document.getElementById('icon-pause').style.display = playing ? 'block' : 'none';
}

function adjustSync(val) {
    localOffset += val;
    showToast(`Sync: ${val > 0 ? '+' : ''}${val.toFixed(2)} s`);
    // Use Tone.now()
    if (isPlaying) play((Tone.now() - startedAt) + val);
    else pausedAt += val;
}

// --- Audio Graph Settings ---
// --- Audio Graph Settings (Tone.js) ---
function setChannelMode(mode) {
    channelMode = mode;

    // Remove Cutoff Visibility Toggle (Always Visible now)

    if (!player) return; // Not init
    const ramp = 0.05;

    // Reset LowPass to Full Range by default (Safety)
    if (globalLowPass) globalLowPass.frequency.value = 20000;

    // Reset Routing first
    try {
        gainL.disconnect();
        gainR.disconnect();
    } catch (e) { }

    if (mode === 0) { // Stereo
        // L -> Merge 0, R -> Merge 1
        gainL.connect(toneMerge, 0, 0);
        gainR.connect(toneMerge, 0, 1);

        gainL.gain.rampTo(1, ramp);
        gainR.gain.rampTo(1, ramp);
        showToast("Mode: Stereo");

    } else if (mode === -1) { // Left (Dual Mono)
        // L -> Merge 0 AND 1
        gainL.connect(toneMerge, 0, 0);
        gainL.connect(toneMerge, 0, 1);

        gainL.gain.rampTo(1, ramp);
        showToast("Mode: Left Channel");

    } else if (mode === 1) { // Right (Dual Mono)
        // R -> Merge 0 AND 1
        gainR.connect(toneMerge, 0, 0);
        gainR.connect(toneMerge, 0, 1);

        gainR.gain.rampTo(1, ramp);
        showToast("Mode: Right Channel");

    } else if (mode === 2) { // Sub
        // Apply Subwoofer Frequency Immediately
        if (globalLowPass) {
            globalLowPass.frequency.value = subFreq;
        }

        // Summing L+R to both speakers
        gainL.connect(toneMerge, 0, 0);
        gainL.connect(toneMerge, 0, 1);
        gainR.connect(toneMerge, 0, 0);
        gainR.connect(toneMerge, 0, 1);

        // Instant Gain Drop to prevent +6dB Spike during summing
        gainL.gain.value = 0.5;
        gainR.gain.value = 0.5;

        showToast(`Mode: Subwoofer(${subFreq}Hz)`);
    } else {
        // Fallback
        gainL.gain.rampTo(1, ramp);
        gainR.gain.rampTo(1, ramp);
    }
    applySettings();
}

// --- 7.1 Surround Logic ---
function toggleSurroundMode(enabled) {
    isSurroundMode = enabled;

    // UI Toggle
    document.getElementById('grid-standard').style.display = enabled ? 'none' : 'grid';
    document.getElementById('grid-surround').style.display = enabled ? 'grid' : 'none';

    // Logic Switch
    if (enabled) {
        // Ensure 7.1 Graph Nodes exist
        if (!surroundSplitter) setupMediaSource();

        // Buffer Mode: Re-route Player
        if (buffer) {
            player.disconnect();
            player.connect(surroundSplitter);

            // Smart Default for Stereo Files
            if (buffer.numberOfChannels <= 2 && surroundChannelIndex === -1) {
                setSurroundChannel(0, null); // Force FL
                showToast("7.1 Mode: Stereo File (FL Active)");
            } else {
                // Default to Center (2) for Multichannel
                if (surroundChannelIndex === -1) setSurroundChannel(2, null);
                else setSurroundChannel(surroundChannelIndex, null);
            }
        } else {
            // Streaming/No Buffer defaults to Center
            if (surroundChannelIndex === -1) setSurroundChannel(2, null);
            else setSurroundChannel(surroundChannelIndex, null);
        }

        showToast("Surround Mode: Enabled");
    } else {
        // Revert to Standard
        // Buffer Mode: Restore Player
        if (buffer) {
            player.disconnect();
            player.connect(widener);
        }

        // Streaming Mode: Restore MediaSource
        setupMediaSource();
        setChannelMode(channelMode); // Restore standard channel
        showToast("Surround Mode: Disabled");
    }
}

function setSurroundChannel(idx, el, skipSetup = false) {
    surroundChannelIndex = idx;

    // UI Highlight Logic
    const allOpts = document.querySelectorAll('.surround-grid .ch-opt');
    allOpts.forEach(e => e.classList.remove('active'));

    if (el) {
        el.classList.add('active');
    } else {
        // Programmatic Update: Find button by onclick content
        // This ensures the UI reflects default selection (e.g. FL)
        for (let btn of allOpts) {
            const onclickVal = btn.getAttribute('onclick');
            if (onclickVal && onclickVal.includes(`(${idx}, `)) {
                btn.classList.add('active');
                break;
            }
        }
    }

    if (!surroundSplitter) return; // Wait for media setup

    // Routing Logic:
    // 1. Ensure Graph is in Surround Mode 
    if (!isSurroundMode) return;

    // 2. Re-connect MediaSource if needed (to Splitter)
    if (!skipSetup) setupMediaSource();

    // 3. Connect selected Splitter Output to SurroundGain
    try {
        surroundGain.disconnect();
        surroundGain.connect(preamp); // Feed into main chain

        surroundSplitter.disconnect();

        // 5.1 / 7.1 Compatibility Routing
        // 5.1 Layout: L, R, C, LFE, SL, SR (No Rear L/R)
        // 7.1 Layout: L, R, C, LFE, SL, SR, BL, BR

        if (idx === 6) {
            // User selected "Rear Left"
            // If file is 5.1, Ch 6 is empty. capture Side Left (4) as fallback/fill.
            surroundSplitter.connect(surroundGain, 6, 0); // Real Rear L
            surroundSplitter.connect(surroundGain, 4, 0); // Side L (Fallback for 5.1)
        } else if (idx === 7) {
            // User selected "Rear Right"
            surroundSplitter.connect(surroundGain, 7, 0); // Real Rear R
            surroundSplitter.connect(surroundGain, 5, 0); // Side R (Fallback for 5.1)
        } else if (idx === 3) {
            // LFE (Sub) - Special Bass Management or Direct
            // Just connect LFE. If user wants Bass Management, we can mix L/R here too?
            // For now, Direct 1:1.
            surroundSplitter.connect(surroundGain, 3, 0);
        } else {
            // Standard 1:1 Mapping
            surroundSplitter.connect(surroundGain, idx, 0);
        }

        // Reset LowPass Filter (Safety for non-LFE channels)
        // IF LFE (3), set to subFreq. ELSE set to 20000.
        if (globalLowPass) {
            if (idx === 3) globalLowPass.frequency.value = subFreq;
            else globalLowPass.frequency.value = 20000;
        }

        // 4. Force Output to Dual Mono (L+R)
        gainL.disconnect();
        gainR.disconnect();

        // Direct Mapping: GainL -> Left Spk, GainR -> Right Spk
        // Since input is Mono (duplicated), this results in Dual Mono output.
        gainL.connect(toneMerge, 0, 0);
        gainR.connect(toneMerge, 0, 1);

        gainL.gain.rampTo(1, 0.1);
        gainR.gain.rampTo(1, 0.1);

        const names = ["Front Left (L)", "Front Right (R)", "Center (Dialog)", "LFE (Sub)", "Side Left", "Side Right", "Rear Left (Back)", "Rear Right (Back)"];
        showToast(`Ch: ${names[idx]}`);

    } catch (e) {
        console.warn(e);
    }
}

function setChannel(mode, el) {
    if (!player) initAudio();
    document.querySelectorAll('.ch-opt').forEach(e => e.classList.remove('active'));
    el.classList.add('active');
    setChannelMode(mode);
}

function updateSettings(type, val) {
    if (type === 'cutoff') {
        subFreq = Number(val);
        document.getElementById('val-cutoff').innerText = subFreq + ' Hz';

        if (vbFilter) vbFilter.frequency.rampTo(subFreq, 0.1);

        // Update Main Filter ONLY if currently in Subwoofer/LFE mode
        const isSubMode = (channelMode === 2 && !isSurroundMode);
        const isLFE = (isSurroundMode && surroundChannelIndex === 3);

        if (globalLowPass && (isSubMode || isLFE)) {
            globalLowPass.frequency.rampTo(subFreq, 0.1);
        }
    }
}

function onReverbInput(val) { setReverb(val); }
function onReverbChange(val) {
    if (!hostConn) broadcast({ type: 'reverb', value: val });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'reverb', value: val });
}

function setReverb(val) {
    reverbMix = val / 100;
    document.getElementById('val-reverb').innerText = val + '%';
    document.getElementById('reverb-slider').value = val;
    applySettings();
}

function resetReverbMix() {
    setReverb(0);
    onReverbChange(0);
}

function setReverbType(type) {
    if (!reverb) return;
    reverbType = type;
    document.querySelectorAll('.rvb-chip').forEach(el => el.classList.remove('active'));
    document.getElementById(`rvb - ${type}`).classList.add('active');

    // Preset Decay Times
    let decay = 1.5;
    if (type === 'room') decay = 1.5;
    else if (type === 'hall') decay = 3.0; // Standard Hall
    else if (type === 'church') decay = 6.0; // Long
    else if (type === 'plate') decay = 2.5; // Bright/Medium

    // Update Audio & Slider UI
    setReverbDecay(decay);

    if (!hostConn) broadcast({ type: 'reverb-type', value: type });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'reverb-type', value: type });
}

function onReverbDecayInput(val) {
    document.getElementById('val-rvb-decay').innerText = val + 's';
}
function onReverbDecayChange(val) {
    setReverbDecay(val);
    if (!hostConn) broadcast({ type: 'reverb-decay', value: val });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'reverb-decay', value: val });
}
function setReverbDecay(val) {
    const v = Number(val);
    if (reverb) {
        reverb.decay = v;
        reverb.generate();
    }
    const label = document.getElementById('val-rvb-decay');
    if (label) label.innerText = v + 's';
    const slider = document.getElementById('reverb-decay-slider');
    if (slider) slider.value = v;
}
function resetReverbDecay() {
    setReverbDecay(5.0);
    onReverbDecayChange(5.0);
}

function onReverbPreDelayInput(val) {
    document.getElementById('val-rvb-predelay').innerText = val + 's';
}
function onReverbPreDelayChange(val) {
    setReverbPreDelay(val);
    if (!hostConn) broadcast({ type: 'reverb-predelay', value: val });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'reverb-predelay', value: val });
}
function setReverbPreDelay(val) {
    const v = Number(val);
    if (reverb) {
        reverb.preDelay = v;
        reverb.generate();
    }
    const label = document.getElementById('val-rvb-predelay');
    if (label) label.innerText = v + 's';
    const slider = document.getElementById('reverb-predelay-slider');
    if (slider) slider.value = v;
}
function resetReverbPreDelay() {
    setReverbPreDelay(0.1);
    onReverbPreDelayChange(0.1);
}

// Reverb Low Cut (HPF)
function onReverbLowCutInput(val) {
    const v = Number(val);
    const freq = 20 * Math.pow(50, v / 100);
    const txt = freq >= 1000 ? (freq / 1000).toFixed(1) + 'k' : Math.round(freq) + 'Hz';
    document.getElementById('val-rvb-lowcut').innerText = txt;
}
function onReverbLowCutChange(val) {
    setReverbLowCut(val);
    if (!hostConn) broadcast({ type: 'reverb-lowcut', value: val });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'reverb-lowcut', value: val });
}
function setReverbLowCut(val) {
    const v = Number(val);
    // 0% -> 20Hz (Off), 100% -> 1000Hz
    const freq = 20 * Math.pow(50, v / 100);
    if (rvbLowCut) rvbLowCut.frequency.rampTo(freq, 0.1);

    const txt = freq >= 1000 ? (freq / 1000).toFixed(1) + 'k' : Math.round(freq) + 'Hz';
    const label = document.getElementById('val-rvb-lowcut');
    if (label) label.innerText = txt;
    const slider = document.getElementById('reverb-lowcut-slider');
    if (slider) slider.value = v;
}
function resetReverbLowCut() {
    setReverbLowCut(0);
    onReverbLowCutChange(0);
}

// Reverb High Cut (LPF)
function onReverbHighCutInput(val) {
    const v = Number(val);
    const freq = 20000 * Math.pow(0.025, v / 100);
    const txt = freq >= 1000 ? (freq / 1000).toFixed(1) + 'k' : Math.round(freq) + 'Hz';
    document.getElementById('val-rvb-highcut').innerText = txt;
}
function onReverbHighCutChange(val) {
    setReverbHighCut(val);
    if (!hostConn) broadcast({ type: 'reverb-highcut', value: val });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'reverb-highcut', value: val });
}
function setReverbHighCut(val) {
    const v = Number(val);
    // 0% -> 20k (Off), 100% -> 500Hz
    const freq = 20000 * Math.pow(0.025, v / 100);
    if (rvbHighCut) rvbHighCut.frequency.rampTo(freq, 0.1);

    const txt = freq >= 1000 ? (freq / 1000).toFixed(1) + 'k' : Math.round(freq) + 'Hz';
    const label = document.getElementById('val-rvb-highcut');
    if (label) label.innerText = txt;
    const slider = document.getElementById('reverb-highcut-slider');
    if (slider) slider.value = v;
}
function resetReverbHighCut() {
    setReverbHighCut(0);
    onReverbHighCutChange(0);
}

// Graphic EQ
function setEQ(idx, val, localOnly = false, fromSync = false) {
    const bandIdx = Number(idx);
    const bandVal = Number(val);

    // Tone.js Update
    if (eqNodes && eqNodes[bandIdx]) {
        // eqNodes are Tone.Filter(peaking)
        eqNodes[bandIdx].gain.value = bandVal;
    }

    // UI Update
    const bands = document.querySelectorAll('.eq-band');
    if (bands[bandIdx]) {
        const slider = bands[bandIdx].querySelector('.eq-slider');
        if (slider && parseFloat(slider.value) !== bandVal) slider.value = bandVal;
    }

    const label = document.getElementById(`eq - val - ${bandIdx}`);
    if (label) label.innerText = bandVal > 0 ? `+ ${bandVal}` : bandVal;

    if (localOnly || fromSync) return;

    if (!hostConn) {
        broadcast({ type: 'eq-update', band: bandIdx, value: bandVal });
    }
    else if (isOperator) {
        hostConn.send({ type: 'request-setting', settingType: 'eq', band: bandIdx, value: bandVal });
    }
}

// Global:
let userPreampGain = 1.0;

function setPreamp(val, localOnly = false, fromSync = false) {
    const db = Number(val);
    userPreampGain = Math.pow(10, db / 20); // Store user intent

    // UI Update
    const disp = document.getElementById('val-preamp');
    if (disp) disp.innerText = (db > 0 ? '+' : '') + db + 'dB';

    const slider = document.getElementById('preamp-slider');
    if (slider && slider.value != db) slider.value = db;

    // Apply immediately via common function
    applySettings();

    if (localOnly || fromSync) return;

    if (!hostConn) broadcast({ type: 'preamp', value: db });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'preamp', value: db });
}

function resetEQ(fromSync = false) {
    if (isOperator && !fromSync) {
        hostConn.send({ type: 'request-eq-reset' });
        return;
    }
    document.querySelectorAll('.eq-slider').forEach((el, idx) => {
        setEQ(idx, 0, false, true);
    });
    setPreamp(0, false, true);
    if (!hostConn && !fromSync) broadcast({ type: 'eq-reset' });
}

// Virtual Stereo Width
function setStereoWidth(val) {
    stereoWidth = val / 100;
    document.getElementById('val-width').innerText = val + '%';
    document.getElementById('width-slider').value = val;
    applySettings();
}

function onStereoWidthChange(val) {
    if (!hostConn) broadcast({ type: 'stereo-width', value: val });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'stereo', value: val });
}

function resetStereo() { setStereoWidth(100); onStereoWidthChange(100); }

// Virtual Bass Control
function setVirtualBass(val) {
    virtualBass = val / 100;
    document.getElementById('val-vbass').innerText = val + '%';
    document.getElementById('vbass-slider').value = val;
    applySettings();
}

function onVirtualBassChange(val) {
    if (!hostConn) broadcast({ type: 'vbass', value: val });
    else if (isOperator) hostConn.send({ type: 'request-setting', settingType: 'vbass', value: val });
}

function applySettings() {
    if (!player) return;

    // Reverb Mix (CrossFade)
    if (rvbCrossFade) rvbCrossFade.fade.rampTo(reverbMix, 0.1);

    // Stereo Width & Gain Compensation
    if (widener) {
        // Active in ALL modes now (Pre-Split processing)
        widener.wet.rampTo(1, 0.1);
        // Fix Mapping: 100% UI = 0.5 Tone.Widener (Normal)
        // 200% UI = 1.0 Tone.Widener (Wide)
        widener.width.rampTo(stereoWidth * 0.5, 0.1);

        // Mono Compensation: When width -> 0, L+R sums energy (up to +6dB).
        // We reduce gain to approx 0.6x (-4.5dB) at Mono to keep level consistent.
        let compensation = 1.0;
        if (stereoWidth < 1.0) {
            compensation = 0.6 + (0.4 * stereoWidth);
        }

        if (preamp) preamp.gain.rampTo(userPreampGain * compensation, 0.1);
    }

    // Virtual Bass
    // Boost factor: 0 to 1
    if (vbGain) vbGain.gain.rampTo(virtualBass, 0.1);
}

function onVolInput(val) { setVolume(val / 100); }
function onVolChange(val) { if (!hostConn) broadcast({ type: 'volume', value: val / 100 }); }

function setVolume(val) {
    masterVolume = val;
    // Tone.Master.volume is dB. We want linear gain on masterGain node.
    if (masterGain) masterGain.gain.rampTo(masterVolume, 0.1);
    const vSlider = document.getElementById('volume-slider');
    if (vSlider) vSlider.value = val * 100;
}

// ==============================================================
// [Visualizer] Light/Dark Mode Supported
// ==============================================================
function startVisualizer() {
    const canvas = document.getElementById('visualizerCanvas');
    const ctx = canvas.getContext('2d');

    // Check type of global analyser (Tone or Native)
    const isToneAnalyser = (analyser && !analyser.getByteFrequencyData);

    // Determine buffer size
    const bufferLength = isToneAnalyser ? analyser.size : analyser.frequencyBinCount;
    // Tone analyzer size is usually 1024 or 2048.
    // If Tone, we map Float32 to Uint8 manually for compatibility with drawing logic
    const dataArray = isToneAnalyser ? new Float32Array(bufferLength) : new Uint8Array(bufferLength);

    // Canvas Scale Logic (High DPI)
    const logicalSize = 240;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== logicalSize * dpr) {
        canvas.width = logicalSize * dpr;
        canvas.height = logicalSize * dpr;
        canvas.style.width = `${logicalSize}px`;
        canvas.style.height = `${logicalSize}px`;
        ctx.scale(dpr, dpr);
    }

    function draw() {
        if (!isPlaying) return;
        animationId = requestAnimationFrame(draw);

        if (isToneAnalyser) {
            const dbData = analyser.getValue();
            for (let i = 0; i < bufferLength; i++) {
                // Map -100dB ~ -30dB to 0 ~ 255 (brightness coefficient: 2.5)
                let val = (dbData[i] + 100) * 2.5;
                if (val < 0) val = 0; if (val > 255) val = 255;
                dataArray[i] = val;
            }
        } else {
            analyser.getByteFrequencyData(dataArray);
        }

        const theme = document.documentElement.getAttribute('data-theme');
        const isLight = (theme === 'light');

        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = isLight ? 'rgba(255, 255, 255, 0.9)' : 'rgba(18, 18, 18, 0.9)';
        ctx.fillRect(0, 0, logicalSize, logicalSize);

        // Bass: 0 ~ 260Hz (12 bins - sync.html style for better punch)
        let bassSum = 0;
        let bassCount = 12;
        // Safety check for array bounds
        if (bassCount > bufferLength) bassCount = bufferLength;
        for (let i = 0; i < bassCount; i++) { bassSum += dataArray[i]; }
        const bassAverage = bassSum / bassCount;

        // Per-band smoothing: Bass only (0.8 = smooth, High = immediate)
        if (typeof smoothedBass === 'undefined') smoothedBass = bassAverage;
        smoothedBass = smoothedBass * 0.8 + bassAverage * 0.2;

        const bassPunch = Math.pow(smoothedBass / 255, 2.5);

        // High: 7.5kHz ~ 20kHz (0.7 ~ 1.0 of buffer)
        let highSum = 0;
        const highStart = Math.floor(bufferLength * 0.7);
        const highEnd = bufferLength;
        let highCountVal = highEnd - highStart;
        if (highCountVal < 1) highCountVal = 1;

        for (let i = highStart; i < highEnd; i++) { highSum += dataArray[i]; }
        const highAverage = highSum / highCountVal;
        const highPunch = Math.pow(highAverage / 255, 1.0);

        if (isLight) ctx.globalCompositeOperation = 'source-over';
        else ctx.globalCompositeOperation = 'lighter';

        ctx.shadowBlur = 0;
        ctx.lineWidth = 0;

        const centerX = logicalSize / 2;
        const centerY = logicalSize / 2;

        // Circle 1: Bass (increased amplification: 80 -> 150)
        const bassRadius = 40 + (bassPunch * 150);
        const bassLightness = 20 + (bassPunch * 60);

        if (isLight) ctx.fillStyle = `rgba(59, 130, 246, 0.6)`;
        else ctx.fillStyle = `hsla(217, 91 %, ${bassLightness + 40}%, 0.4)`;

        ctx.beginPath();
        ctx.arc(centerX, centerY, bassRadius, 0, 2 * Math.PI);
        ctx.fill();

        // Circle 2: High (30~130 range)
        const highRadius = 30 + (highPunch * 100);
        const highLightness = 40 + (highPunch * 60);

        if (isLight) {
            ctx.fillStyle = `rgba(96, 165, 250, 0.6)`;
        } else {
            ctx.fillStyle = `hsla(217, 100 %, ${highLightness + 30}%, 0.4)`;
        }

        ctx.beginPath();
        ctx.arc(centerX, centerY, highRadius, 0, 2 * Math.PI);
        ctx.fill();
    }
    draw();
}

function fmtTime(s) {
    if (isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec} `;
}

// --- Marquee Helper for Long Titles ---
function updateTitleWithMarquee(text) {
    const el = document.getElementById('track-title');
    if (!el) return;

    // Reset marquee state to measure accurately
    el.classList.remove('marquee');
    el.style.animation = 'none'; // Temporarily stop animation
    el.innerText = text;
    el.removeAttribute('data-text'); // No longer needed for CSS content

    // Clear inline styles from previous marquee
    el.style.removeProperty('--marquee-offset');
    el.style.removeProperty('--marquee-duration');

    // Use a small delay to allow DOM to calculate widths
    setTimeout(() => {
        const parent = el.parentElement;
        if (!parent) return;

        // Calculate Overflow
        // scrollWidth: actual text width, clientWidth: visible container width
        const overflowWidth = el.scrollWidth - parent.clientWidth;

        // Add a small buffer (e.g., 32px) to ensure it clears the edge fully
        const targetOffset = -(overflowWidth + 32); // +32 for padding/mask buffer

        if (overflowWidth > 0) {
            el.classList.add('marquee');

            // Set CSS Variable for the exact travel distance
            el.style.setProperty('--marquee-offset', `${targetOffset}px`);

            // Calculate Duration based on Speed (Constant Pixels Per Second)
            // e.g., 40px per second + 4s pause (2s start + 2s end)
            const speed = 40; // px per second
            const travelDuration = (Math.abs(targetOffset) / speed);
            const totalDuration = travelDuration * 2 + 4; // *2 for round trip, +4 for pauses

            el.style.setProperty('--marquee-duration', `${totalDuration}s`);

            // Re-apply animation
            el.style.animation = '';
        }
    }, 100);
}


// --- Seek & Interactions ---
const slider = document.getElementById('seek-slider');
slider.addEventListener('mousedown', () => isSeeking = true);
slider.addEventListener('touchstart', () => isSeeking = true);
slider.addEventListener('input', () => document.getElementById('time-curr').innerText = fmtTime(slider.value));
slider.addEventListener('change', () => {
    isSeeking = false;
    const t = parseFloat(slider.value);

    // Guest (non-OP): local only, wait for Host sync
    if (hostConn && !isOperator) {
        return; // Guests can't seek
    }

    // OP: request Host to seek
    if (hostConn && isOperator) {
        hostConn.send({ type: 'request-seek', time: t });
        return;
    }

    // Host: execute directly
    // YouTube mode: use YouTube API
    if (isYouTubeMode && youtubePlayer) {
        try {
            youtubePlayer.seekTo(t, true);  // t is already in seconds
            broadcast({ type: 'youtube-state', state: youtubePlayer.getPlayerState(), time: t });
        } catch (e) {
            console.error("[YouTube] Slider seek error:", e);
        }
        return;
    }

    // Local mode
    if (isPlaying) play(t); else pausedAt = t;
    broadcast({ type: 'play', time: t });

    // Schedule global resync after seek (Host only)
    setTimeout(() => {
        broadcast({ type: 'global-resync-request' });
        console.log("[Host] Global resync requested after seek");
    }, 1000);
});

// --- Sync Button Logic ---
function handleMainSyncBtn() {
    console.log("Sync Btn Clicked. HostConn:", !!hostConn, "Playing:", isPlaying);
    if (!hostConn) {
        // Host: Reset local offset and trigger Guest-side Sync
        localOffset = 0;
        updateSyncDisplay();
        showToast("모든 기기 재동기화 요청...");
        broadcast({ type: 'global-resync-request' });
    } else {
        // Guest: Manual local sync
        syncReset();
    }
}

function syncReset() {
    if (!hostConn || !hostConn.open) return;
    localOffset = 0; // Manual Reset
    updateSyncDisplay();

    showToast("동기화(Median Pattern) 적용 중...");
    syncRequestTime = Date.now();
    hostConn.send({ type: 'get-sync-time' });
}

function updateSyncBtnState(isGuest) {
    const btn = document.getElementById('btn-auto-sync');
    if (!btn) return; // Safety check

    // Unify Icon (Refresh) and Text (AUTO SYNC) for both roles
    btn.innerHTML = `< svg width = "14" height = "14" viewBox = "0 0 24 24" fill = "currentColor" > <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" /></svg > AUTO SYNC`;
}

// --- Networking (Updated from network.html) ---
// [수정된 네트워크 초기화 코드]
async function initNetwork() {
    try {
        let turnConfig = { username: "", credential: "" };

        try {
            // 1. 배달원에게 설정값 요청 (Netlify Function 호출)
            const response = await fetch('/.netlify/functions/get-turn-config');

            // [로컬 환경 대응] response.ok 확인 및 Content-Type 체크로 HTML(404) 파싱 방지
            if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
                turnConfig = await response.json();
                console.log("TURN 설정 로드 완료 (Netlify)");
            } else {
                console.warn("Netlify Function 사용 불가 - 로컬 환경 또는 미설정 상태로 초기화합니다. (STUN 전용)");
            }
        } catch (fetchErr) {
            console.warn("네트워크 설정 요청 중 오류 (개발 환경인 경우 정상):", fetchErr.message);
        }

        // 2. 받아온 설정으로 옵션 만들기
        const peerOpts = {
            debug: 2,
            config: {
                iceServers: [
                    { urls: "stun:stun.l.google.com:19302" },
                    {
                        urls: "stun:stun.relay.metered.ca:80",
                    },
                    {
                        urls: "turn:standard.relay.metered.ca:443",
                        username: turnConfig.username,
                        credential: turnConfig.credential
                    },
                    {
                        urls: "turn:standard.relay.metered.ca:443?transport=tcp",
                        username: turnConfig.username,
                        credential: turnConfig.credential
                    },
                    {
                        urls: "turns:standard.relay.metered.ca:443?transport=tcp",
                        username: turnConfig.username,
                        credential: turnConfig.credential
                    }
                ],
                bundlePolicy: 'max-bundle',
                sdpSemantics: 'unified-plan',
                iceTransportPolicy: 'all',
                iceCandidatePoolSize: 10
            }
        };

        // 3. PeerJS 시작
        peer = new Peer(null, peerOpts);

        // --- 기존 이벤트 리스너들 ---
        setupPeerEvents();

    } catch (e) {
        console.error("네트워크 초기화 중 치명적 오류:", e);
        showToast("네트워크 초기화 실패 (새로고침 하세요)");
    }
}

function setupPeerEvents() {

    peer.on('error', (err) => {
        console.error("PeerJS Global Error:", err);
        console.error("Error Type:", err.type);

        let message = "네트워크 오류가 발생했습니다.";
        if (err.type === 'browser-incompatible') {
            message = "브라우저가 오디오 동기화(WebRTC)를 지원하지 않습니다.";
        } else if (err.type === 'server-error') {
            message = "PeerJS 서버와 연결할 수 없습니다. (현재 밴되었거나 서버 점검 중일 수 있습니다)";
        } else if (err.type === 'network') {
            message = "네트워크 환경이 불안정하거나 방화벽에서 차단되었습니다.";
        } else if (err.type === 'id-taken') {
            message = "이미 사용 중인 ID입니다. 다시 시도해주세요.";
        } else if (err.type === 'peer-unavailable') {
            // This is often handled in joinSession, but as a global error it's good to log
            message = "연결하려는 대상(Host)을 찾을 수 없습니다.";
        }

        showToast(message);

        // If it's a critical initialization/network error, show the overlay with tips
        if (['server-error', 'network', 'browser-incompatible'].includes(err.type)) {
            showConnectionFailedOverlay(
                message + "\n\n" +
                "1. VPN을 사용 중이라면 끄고 시도해보세요.\n" +
                "2. 브라우저 캐시를 지우거나 다른 브라우저(Chrome/Safari 권장)를 사용해보세요.\n" +
                "3. 공용 Wi-Fi나 회사/학교 망은 차단될 수 있습니다."
            );
        }
    });

    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });

    peer.on('open', id => {
        myId = id;
        document.getElementById('my-id').innerText = id;

        updateQrCode(myId);

        const params = new URLSearchParams(window.location.search);
        if (params.get('host')) {
            document.getElementById('join-id-input').value = params.get('host');
            // Check if gesture-overlay exists (might be deprecated)
            const go = document.getElementById('gesture-overlay');
            if (go) go.style.display = 'flex';
        } else {
            document.getElementById('host-panel').classList.add('visible');
            document.getElementById('role-text').innerText = "HOST (ME)";
            document.getElementById('role-badge').classList.add('connected');
            updateSyncBtnState(false);

            renderDeviceList([
                { id: myId, label: 'HOST', status: 'connected', isHost: true }
            ]);

            // Heartbeat Monitor (Host checks for voluntary signals)
            setInterval(() => {
                const now = Date.now();
                let changed = false;

                // 1. Check for Timeouts
                connectedPeers.forEach(p => {
                    if (p.status === 'connected') {
                        // Host does NOT ping. Waits for Guest.

                        // Timeout: 15 seconds (allows 2 lost signals from 5s interval)
                        if (now - p.lastHeartbeat > 15000) {
                            console.warn(`Peer ${p.label} timed out.`);
                            p.status = 'disconnected';
                            changed = true;
                            showToast(`${p.label} 제거됨(무응답)`);
                        }
                    }
                });

                // 2. Boldly Remove Disconnected Peers
                if (changed) {
                    // FORCE UPDATE: Reassign global array and CLEAN UP orphans
                    const disconnected = connectedPeers.filter(p => p.status !== 'connected');
                    disconnected.forEach(p => {
                        if (p._relayMonitor) clearInterval(p._relayMonitor);
                        if (p._heartbeatTimer) clearInterval(p._heartbeatTimer);
                    });
                    connectedPeers = connectedPeers.filter(p => p.status === 'connected');
                    broadcastDeviceList();
                }
            }, 1000);
        }
    });

    function updateQrCode(id) {
        document.getElementById("qrcode").innerHTML = "";

        // QR Code Color - Adaptive? qrcode.js only supports static colors.
        // We will stick to B/W for max contrast.
        new QRCode(document.getElementById("qrcode"), {
            text: `${window.location.origin}${window.location.pathname}?host=${id}`,
            width: 160, height: 160, colorDark: "#000000", colorLight: "#ffffff"
        });

        if (hostConn) {
            document.getElementById('my-id').innerText = "Host ID: " + id;
        } else {
            document.getElementById('my-id').innerText = id;
        }
    }

    function broadcastDeviceList() {
        const list = [
            { id: myId, label: 'HOST', status: 'connected', isHost: true },
            ...connectedPeers.map(p => ({
                id: p.id, label: p.label, status: p.status, isHost: false, isOp: p.isOp
            }))
        ];

        const msg = { type: 'device-list-update', list: list };
        broadcast(msg);
        renderDeviceList(list);
    }

    // Host Logic
    peer.on('connection', conn => {
        // Check for Data Relay Connection
        if (conn.metadata && conn.metadata.type === 'data-relay') {
            handleRelayConnection(conn);
            return;
        }

        deviceCounter++;
        const deviceName = `DEVICE ${deviceCounter} `;
        const peerObj = {
            id: conn.peer,
            label: deviceName,
            status: 'connected',
            conn: conn,
            isOp: false,
            isDataTarget: true, // Default: Receive data from Host
            lastHeartbeat: Date.now() // Heartbeat Init
        };
        connectedPeers.push(peerObj);

        broadcastDeviceList();

        conn.on('open', () => {
            showToast(`${deviceName} 연결됨`);

            // --- Relay Assignment Logic ---
            // --- Relay Assignment Logic (2-Lane Stabilized) ---
            if (connectedPeers.length > MAX_DIRECT_DATA_PEERS) {
                // 2-Lane System: Try to find a parent in the same lane (Odd/Even)
                // Search backwards with Step 2 (jump over the other lane) to find nearest active ancestor
                // New Peer Index = connectedPeers.length - 1
                // Target Parent Index = (connectedPeers.length - 1) - 2 = connectedPeers.length - 3

                let assigned = false;
                for (let i = connectedPeers.length - 3; i >= 0; i -= 2) {
                    const candidate = connectedPeers[i];
                    // Must be connected AND have open channel to serve as relay
                    if (candidate && candidate.status === 'connected' && candidate.conn.open) {
                        conn.send({ type: 'assign-data-source', targetId: candidate.id });
                        showToast(`Data Relay: ${deviceName} -> ${candidate.label} `);

                        // Do NOT send data directly from Host to this new peer
                        peerObj.isDataTarget = false;
                        peerObj.assignedRelay = candidate.id; // [FIX #8] Track for monitoring
                        assigned = true;
                        break;
                    }
                }
                if (!assigned) {
                    // If no active parent found in lane, fall back to Host (keep isDataTarget = true)
                    showToast(`Relay Lane Unavailable: ${deviceName} joined Host Direct`);
                }
            }
            // -----------------------------

            // [FIX #8] Set up relay lane reassignment on parent disconnect
            if (!peerObj.isDataTarget && peerObj.assignedRelay) {
                // Monitor the assigned relay peer
                const monitorRelay = () => {
                    const relay = connectedPeers.find(p => p.id === peerObj.assignedRelay);
                    if (!relay || relay.status !== 'connected') {
                        console.log(`[Relay] Parent ${peerObj.assignedRelay} disconnected, reassigning ${deviceName}`);
                        peerObj.isDataTarget = true; // Fall back to Host direct
                        showToast(`${deviceName} -> Host Direct (릴레이 끊김)`);

                        // [Fix] Stop monitoring once reassigned to prevent interval spam
                        if (peerObj._relayMonitor) {
                            clearInterval(peerObj._relayMonitor);
                            peerObj._relayMonitor = null;
                        }
                    }
                };
                // Check every RELAY_MONITOR_INTERVAL ms
                peerObj._relayMonitor = setInterval(monitorRelay, RELAY_MONITOR_INTERVAL);
            }
            // -----------------------------

            conn.send({ type: 'welcome', label: deviceName });
            conn.send({ type: 'volume', value: masterVolume });
            conn.send({ type: 'reverb', value: reverbMix * 100 });
            conn.send({
                type: 'playlist-update',
                list: playlist.map(item => ({
                    type: item.type,
                    name: item.name || item.title,
                    videoId: item.videoId || null,
                    playlistId: item.playlistId || null
                }))
            });

            // Send current YouTube state if active
            if (isYouTubeMode && youtubePlayer) {
                try {
                    const videoData = youtubePlayer.getVideoData();
                    const curItem = playlist[currentTrackIndex];
                    conn.send({
                        type: 'youtube-play',
                        videoId: (videoData && videoData.video_id) ? videoData.video_id : (curItem ? curItem.videoId : null),
                        playlistId: curItem ? curItem.playlistId : null,
                        index: currentTrackIndex,
                        subIndex: currentYouTubeSubIndex
                    });
                    // Send current time sync after short delay (let guest load player first)
                    setTimeout(() => {
                        if (youtubePlayer && conn.open) {
                            conn.send({
                                type: 'youtube-sync',
                                time: youtubePlayer.getCurrentTime(),
                                state: youtubePlayer.getPlayerState(),
                                subIndex: currentYouTubeSubIndex
                            });
                        }
                    }, 3000);
                } catch (e) {
                    console.error("[YouTube] Failed to send state to new guest:", e);
                }
            }

            broadcastDeviceList();

            if (currentTrackIndex !== -1 && playlist[currentTrackIndex]) {
                const item = playlist[currentTrackIndex];
                // ONLY send 'file-prepare' for local files. 
                // YouTube tracks handle UI via 'youtube-play' above.
                if (item.type !== 'youtube') {
                    conn.send({ type: 'file-prepare', name: item.name, index: currentTrackIndex });
                }

                // Only send actual data if they are a direct data target
                // (If they are relayed, the relay should technically sync them, but for now 
                // the relay logic handles 'live' chunks. Late join during playback might need catchup logic.
                // For Beta, we'll let 'broadcastFile' handle new files. 
                // If playing mid-file, they might miss out until next track or manual restart. 
                // Simplification: If direct, send. If relay, wait for next msg.)
                if (peerObj.isDataTarget && playlist[currentTrackIndex]?.file) {
                    unicastFile(conn, playlist[currentTrackIndex].file);
                }
            }
        });

        conn.on('data', data => {
            if (data.type === 'heartbeat' || data.type === 'heartbeat-ack') {
                peerObj.lastHeartbeat = Date.now();

                // [Optimization] Playlist-Centric Sync: Respond with current status
                if (!hostConn) { // Only genuine Host responds
                    conn.send({
                        type: 'status-sync',
                        currentTrackIndex: currentTrackIndex,
                        isPlaying: isPlaying,
                        playlistMeta: playlist.map(item => ({
                            type: item.type,
                            name: item.name || item.title,
                            videoId: item.videoId || null,
                            playlistId: item.playlistId || null
                        }))
                    });
                }
                return;
            }

            // Latency Monitor: Reply to Guest pings for latency check
            if (data.type === 'ping-latency') {
                conn.send({ type: 'pong-latency', timestamp: data.timestamp });
                return;
            }

            // Sync Completion Report
            // Removed Sync Handler

            if (data.type === 'get-sync-time') {
                const currentTime = isPlaying ? (Tone.now() - startedAt) : pausedAt;
                conn.send({ type: 'sync-response', time: currentTime, isPlaying: isPlaying });
            }
            // Removed Ping Handler
            // Operator Requests
            else if (peerObj.isOp) {
                handleOperatorRequest(data);
            }
            // Preload Acknowledgment (Guest tells Host it has preload)
            else if (data.type === 'preload-ack') {
                const peer = connectedPeers.find(p => p.conn === conn);
                if (peer) {
                    if (!peer.preloadedIndexes) peer.preloadedIndexes = new Set();
                    peer.preloadedIndexes.add(data.index);
                    console.log(`[Host] Guest ${peer.id} confirmed preload for index ${data.index}`);
                }
            }
            // YouTube Playlist Info Request
            else if (data.type === 'request-youtube-playlist-info') {
                const pid = data.playlistId;
                if (youtubeSubItemsMap[pid]) {
                    conn.send({
                        type: 'youtube-playlist-info',
                        playlistId: pid,
                        ids: youtubeSubItemsMap[pid].ids,
                        titles: youtubeSubItemsMap[pid].titles
                    });
                }
            }
            // Auto-Recovery Request

            else if (data.type === 'status-sync') {
                // [Synchronization Logic] Playlist-Centric Model
                const { playlistMeta, currentTrackIndex: hostTrackIndex, isPlaying: hostIsPlaying } = data;

                // 1. Sync Playlist Structure if different
                const isPlaylistDifferent = JSON.stringify(playlist.map(it => it.name)) !== JSON.stringify(playlistMeta.map(it => it.name));
                if (isPlaylistDifferent) {
                    console.log("[Sync] Playlist out of sync, updating...");
                    playlist = playlistMeta;
                    updatePlaylistUI();
                }

                // 2. Sync Track Index and Trigger Auto-Recovery if needed
                if (hostTrackIndex !== -1 && hostTrackIndex !== currentTrackIndex) {
                    const prevIndex = currentTrackIndex;
                    currentTrackIndex = hostTrackIndex;
                    updatePlaylistUI();

                    const item = playlist[currentTrackIndex];
                    if (item && item.type !== 'youtube') {
                        // Check if we already have the file (decode buffer or blob)
                        const hasFile = buffer || currentFileBlob || nextFileBlob;

                        // If it's a new track and we don't have it, ask for it
                        if (!hasFile || (meta && meta.name !== item.name)) {
                            console.log("[Sync] Current track missing, requesting from host:", item.name);
                            showLoader(true, `파일 동기화 중: ${item.name}`);
                            clearPreviousTrackState('status-sync mismatch');

                            if (hostConn && hostConn.open) {
                                hostConn.send({
                                    type: 'request-data-recovery',
                                    nextChunk: 0,
                                    fileName: item.name,
                                    index: hostTrackIndex
                                });
                            }
                        }
                    } else if (item && item.type === 'youtube') {
                        if (!isYouTubeMode || currentTrackIndex !== prevIndex) {
                            console.log("[Sync] Switching to YouTube mode for sync");
                            // YouTube mode switch is usually handled by youtube-play message, 
                            // but this provides a fallback for late joiners.
                        }
                    }
                }
            }
            else if (data.type === 'request-data-recovery') {
                const fileName = data.fileName;
                const recoveryIndex = data.index;
                const nextChunk = data.nextChunk || 0;
                const peerId = conn.peer;

                // Prevent duplicate recovery requests from same peer
                if (!window._recoveryInProgress) window._recoveryInProgress = {};
                if (window._recoveryInProgress[peerId]) {
                    console.log("[Recovery] Already in progress for:", peerId);
                    return;
                }

                // Try to find file by name first, then fall back to index
                let item = playlist.find(f => f.name === fileName);
                if (!item && recoveryIndex !== undefined && playlist[recoveryIndex]) {
                    item = playlist[recoveryIndex];
                    console.log("[Recovery] Using index fallback:", recoveryIndex);
                }

                if (item && item.file) {
                    // Mark recovery as in progress
                    window._recoveryInProgress[peerId] = true;

                    // Queue recovery with small delay to stagger multiple requests
                    const queueDelay = Object.keys(window._recoveryInProgress).length * 200;
                    console.log(`[Recovery] Queuing ${peerObj.label} with ${queueDelay}ms delay`);

                    setTimeout(async () => {
                        // [FIX #7] Wrap in try-finally to ensure cleanup on any error
                        try {
                            if (conn.open) {
                                showToast(`Recovering ${peerObj.label}: chunk ${nextChunk}`);
                                await unicastFile(conn, item.file, nextChunk);
                            }
                        } catch (recoveryErr) {
                            console.error("[Recovery] Error during unicast:", recoveryErr);
                        } finally {
                            delete window._recoveryInProgress[peerId];
                        }
                    }, queueDelay);
                } else {
                    console.error("[Recovery] Failed - no file found for:", fileName, "index:", recoveryIndex);
                }
            }
            // Chat Message from Guest: Display locally and rebroadcast to others (not sender)
            else if (data.type === 'chat') {
                // Show on Host UI
                addChatMessage(data.sender, data.text, false);
                // Broadcast to all guests EXCEPT the original sender
                connectedPeers.forEach(p => {
                    if (p.status === 'connected' && p.conn.open && p.id !== conn.peer) {
                        p.conn.send({ type: 'chat', sender: data.sender, text: data.text });
                    }
                });
            }
        });

        conn.on('close', () => {
            // [FIX #14] Clean up relay monitor interval
            if (peerObj._relayMonitor) {
                clearInterval(peerObj._relayMonitor);
                peerObj._relayMonitor = null;
            }
            peerObj.status = 'disconnected';
            peerObj.lastSeen = Date.now(); // [Optimization] Track for pruning
            broadcastDeviceList();
            showToast(`${deviceName} 연결 끊김`);

            // [Optimization] Prune dead peers after 5 minutes to save resources
            setTimeout(() => {
                if (peerObj.status === 'disconnected') {
                    connectedPeers = connectedPeers.filter(p => p.id !== peerObj.id);
                    console.log(`[Host] Pruned stale peer ${peerObj.id} after inactivity`);
                    broadcastDeviceList();
                }
            }, 300000); // 5 minutes
        });
        conn.on('error', () => {
            peerObj.status = 'disconnected';
            broadcastDeviceList();
        });
    });
}

// 4. 실행
initNetwork();

// Guest Logic
let connectionRetryCount = 0;
const MAX_CONNECTION_RETRIES = 3;
const CONNECTION_TIMEOUT_MS = 10000;
let connectionTimeoutId = null;

function joinSession(retryAttempt = 0) {
    const hostId = document.getElementById('join-id-input').value.trim();
    if (!hostId) return showToast("ID 입력 필요");

    // Show connection status
    if (retryAttempt === 0) {
        showToast("Host에 연결 중...");
        document.getElementById('role-text').innerText = "연결 중...";
    } else {
        showToast(`재연결 시도 중... (${retryAttempt} / ${MAX_CONNECTION_RETRIES})`);
        document.getElementById('role-text').innerText = `재연결 ${retryAttempt}/${MAX_CONNECTION_RETRIES}`;
    }

    initAudio();
    if (hostConn) hostConn.close();

    // Clear any existing timeout
    if (connectionTimeoutId) {
        clearTimeout(connectionTimeoutId);
        connectionTimeoutId = null;
    }

    hostConn = peer.connect(hostId, { reliable: true });
    window.hostConn = hostConn; // Sync for demo.js access

    // Connection Timeout Handler
    connectionTimeoutId = setTimeout(() => {
        if (hostConn && !hostConn.open) {
            console.warn(`Connection timeout after ${CONNECTION_TIMEOUT_MS}ms`);
            hostConn.close();

            if (retryAttempt < MAX_CONNECTION_RETRIES) {
                showToast(`연결 시간 초과. 재시도 중... (${retryAttempt + 1}/${MAX_CONNECTION_RETRIES})`);
                setTimeout(() => joinSession(retryAttempt + 1), 1000);
            } else {
                showConnectionFailedOverlay("연결 시간이 초과되었습니다. Host가 온라인인지 확인하세요.");
            }
        }
    }, CONNECTION_TIMEOUT_MS);

    hostConn.on('open', () => {
        // Clear timeout on successful connection
        if (connectionTimeoutId) {
            clearTimeout(connectionTimeoutId);
            connectionTimeoutId = null;
        }
        connectionRetryCount = 0; // Reset retry counter

        // Remove connection failed overlay if present (from retry)
        const failedOverlay = document.getElementById('connection-failed-overlay');
        if (failedOverlay) failedOverlay.remove();

        showToast("Host 연결됨!");
        document.getElementById('role-badge').classList.add('connected');
        updateSyncBtnState(true);

        updateQrCode(hostId);
        document.getElementById('host-panel').classList.add('visible');

        // Volunteer Heartbeat: Send to Host every 5s (Worker)
        timerWorker.postMessage({ command: 'START_TIMER', id: 'heartbeat', interval: 5000 });

        // Latency Ping (2s) (Worker)
        timerWorker.postMessage({ command: 'START_TIMER', id: 'ping', interval: 2000 });

        // Detect ICE connection type after connection stabilizes
        setTimeout(() => detectConnectionType(), 2000);

        document.getElementById('btn-leave-session').style.display = 'flex';
        switchTab('play');
    });

    hostConn.on('error', (err) => {
        console.error("PeerJS Connection Error:", err);

        // Clear timeout
        if (connectionTimeoutId) {
            clearTimeout(connectionTimeoutId);
            connectionTimeoutId = null;
        }

        // Retry logic
        if (retryAttempt < MAX_CONNECTION_RETRIES) {
            showToast(`연결 오류. 재시도 중... (${retryAttempt + 1}/${MAX_CONNECTION_RETRIES})`);
            setTimeout(() => joinSession(retryAttempt + 1), 1500);
        } else {
            let errorMsg = "연결에 실패했습니다.";
            if (err.type === 'peer-unavailable') {
                errorMsg = "Host를 찾을 수 없습니다. ID를 확인하세요.";
            } else if (err.type === 'network') {
                errorMsg = "네트워크 오류. 인터넷 연결을 확인하세요.";
            } else if (err.type === 'server-error') {
                errorMsg = "서버 오류. 잠시 후 다시 시도하세요.";
            }
            showConnectionFailedOverlay(errorMsg);
        }
    });

    hostConn.on('data', handleData);
    hostConn.on('close', () => {
        // Clear timeout if still pending
        if (connectionTimeoutId) {
            clearTimeout(connectionTimeoutId);
            connectionTimeoutId = null;
        }

        showToast("Host 끊김");
        document.getElementById('role-text').innerText = "OFFLINE";
        document.getElementById('role-badge').classList.remove('connected');
        updateSyncBtnState(false);

        // Stop Worker Timers
        timerWorker.postMessage({ command: 'STOP_TIMER', id: 'heartbeat' });
        timerWorker.postMessage({ command: 'STOP_TIMER', id: 'ping' });

        // Show Disconnect Overlay
        showConnectionFailedOverlay("Host와 연결이 끊어졌습니다");
    });
}

// Helper: Show connection failed overlay with retry option
function showConnectionFailedOverlay(message) {
    // Remove existing overlay if any
    const existing = document.getElementById('connection-failed-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'connection-failed-overlay';
    overlay.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.85); 
        z-index: 9999; display: flex; flex-direction: column; 
        align-items: center; justify-content: center; gap: 20px;
    `;
    overlay.innerHTML = `
        <h2 style="color:white; font-size: 24px; text-align: center; padding: 0 20px;">${message}</h2>
        <div style="display: flex; gap: 12px; flex-wrap: wrap; justify-content: center;">
            <button onclick="document.getElementById('connection-failed-overlay').remove(); joinSession(0);" style="
                padding: 12px 30px; background: var(--primary, #3b82f6); color: white; 
                border: none; border-radius: 12px; font-weight: bold; font-size: 16px; cursor: pointer;
            ">다시 시도</button>
            <button onclick="window.location.href = window.location.pathname" style="
                padding: 12px 30px; background: #ef4444; color: white; 
                border: none; border-radius: 12px; font-weight: bold; font-size: 16px; cursor: pointer;
            ">나가기</button>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('role-text').innerText = "연결 실패";
}

function leaveSession() {
    if (confirm("모임에서 나가시겠습니까?")) {
        if (hostConn) hostConn.close();
        // Reload without query parameters to become fresh Host
        window.location.href = window.location.pathname;
    }
}

// --- Data Handling ---
let incomingChunks = [], meta = {}, receivedCount = 0;
// Note: preloadChunks, preloadMeta, preloadCount are declared at the top of file (line ~72)
let lastProgressAck = 0;
let myDeviceLabel = 'GUEST'; // Store my label for UI updates
let lastLatencyMs = 0; // Store Median RTT (Robust)
let latencyHistory = []; // Buffer to filter noise
let syncRequestTime = 0; // Capture exact time of sync request
let autoSyncOffset = 0; // NEW: Store the Auto-Sync (Latency) Offset in Seconds
let usePingCompensation = true; // Default: apply RTT/2 compensation (set false for local network)

// Detect ICE candidate type and set compensation mode
async function detectConnectionType() {
    if (!hostConn || !hostConn.peerConnection) {
        console.log("[ICE] No peer connection available");
        return;
    }

    try {
        const stats = await hostConn.peerConnection.getStats();
        let connectionType = 'unknown';

        stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                // Check local and remote candidate types
                const localId = report.localCandidateId;
                const remoteId = report.remoteCandidateId;

                stats.forEach(candidate => {
                    if (candidate.id === localId || candidate.id === remoteId) {
                        if (candidate.candidateType === 'relay') {
                            connectionType = 'relay';
                        } else if (connectionType !== 'relay') {
                            connectionType = candidate.candidateType; // 'host' or 'srflx'
                        }
                    }
                });
            }
        });

        if (connectionType === 'relay') {
            usePingCompensation = true;
            console.log("[ICE] TURN Relay detected - Using RTT/2 compensation");
            showToast("원격 네트워크 감지 - 자동 보정 활성화");
        } else if (connectionType === 'host' || connectionType === 'srflx') {
            usePingCompensation = false;
            console.log(`[ICE] Direct connection (${connectionType}) - No ping compensation`);
            showToast("로컬 네트워크 감지 - 직접 동기화");
        } else {
            usePingCompensation = true; // Fallback: apply compensation
            console.log("[ICE] Unknown connection type - Using RTT/2 compensation as fallback");
        }
    } catch (e) {
        console.error("[ICE] Detection failed:", e);
        usePingCompensation = true; // Fallback
    }
}

// Helper: Clear all previous track state to prevent data mixing
function clearPreviousTrackState(reason = '') {
    console.log(`[State Clear] Clearing previous track state. Reason: ${reason}`);

    // Stop chunk/prepare watchdogs if running
    if (chunkWatchdog) {
        clearInterval(chunkWatchdog);
        chunkWatchdog = null;
    }
    if (prepareWatchdog) {
        clearTimeout(prepareWatchdog);
        prepareWatchdog = null;
    }

    // Clear incoming file state (explicit null for GC before reassign)
    incomingChunks = null; // [FIX #2] Force GC eligibility for large arrays
    incomingChunks = [];
    receivedCount = 0;
    meta = {};

    // Clear cached blob (CRITICAL: prevents serving stale data to late joiners)
    currentFileBlob = null;

    // Reset skip and guard flags
    window._skipIncomingFile = false;
    _isProcessingBlob = false;

    // [FIX] Clear early chunks buffer to prevent data mixing
    window._pendingEarlyChunks = [];

    // Note: We do NOT clear preload state here (nextFileBlob, preloadChunks, etc.)
    // Those are intentionally preserved for upcoming track switch
}

// --- Data Message Handlers ---
async function handleFilePrepare(data) {
    // Check if we already have this track preloaded!
    // Match by index OR by filename
    const hasPreloadedByIndex = nextMeta && data.index !== undefined && data.index === nextMeta.index;
    const hasPreloadedByName = nextMeta && data.name && data.name === nextMeta.name;

    // Also check if preload is IN PROGRESS for this track
    const preloadInProgressByIndex = preloadMeta && data.index !== undefined && data.index === preloadMeta.index;
    const preloadInProgressByName = preloadMeta && data.name && data.name === preloadMeta.name;

    // DEBUG: Log preload matching status
    console.log("[file-prepare] Checking preload:", {
        dataIndex: data.index,
        dataName: data.name,
        nextMetaIndex: nextMeta?.index,
        nextMetaName: nextMeta?.name,
        hasNextFileBlob: !!nextFileBlob,
        matchByIndex: hasPreloadedByIndex,
        matchByName: hasPreloadedByName,
        preloadInProgress: preloadInProgressByIndex || preloadInProgressByName
    });

    if (nextFileBlob && (hasPreloadedByIndex || hasPreloadedByName)) {

        console.log("[Guest] ?? Using preloaded track instead of re-downloading:", data.name);
        showToast("프리로드된 파일 사용!");

        stop();
        currentTrackIndex = data.index !== undefined ? data.index : currentTrackIndex;
        updatePlaylistUI();

        // Use preloaded file directly
        await loadPreloadedTrack();

        // CRITICAL: Hide loader so play() doesn't think we're still downloading
        showLoader(false);

        // Mark that we already loaded this track (prevent duplicate load from play-preloaded)
        window._preloadUsedForIndex = data.index;

        // Mark that we're skipping incoming file transfer
        window._skipIncomingFile = true;
        return;
    }


    // CHECK: If preload is IN PROGRESS for this track, wait for it instead of starting new download
    if (preloadInProgressByIndex || preloadInProgressByName) {
        console.log("[file-prepare] Preload in progress for this track, waiting...");
        showLoader(true, `프리로드 완료 대기 중: ${data.name}`);

        // Set pending info
        window._pendingFileName = data.name;
        window._pendingFileIndex = data.index;
        window._waitingForPreload = true;
        window._skipIncomingFile = true; // Skip any file-start that might come

        currentTrackIndex = data.index !== undefined ? data.index : currentTrackIndex;
        updatePlaylistUI();
        return; // Don't start new download
    }

    // Normal flow: No preload available, prepare for download
    window._skipIncomingFile = false;
    window._waitingForPreload = false;

    // Store pending file name for recovery requests
    window._pendingFileName = data.name;
    window._pendingFileIndex = data.index;

    // CRITICAL: Don't clear state if we're resuming the SAME file!
    // This preserves already-received chunks during recovery
    const isSameFile = (meta && meta.name === data.name) ||
        (window._pendingFileIndex !== undefined && window._pendingFileIndex === data.index);
    const isResuming = isSameFile && receivedCount > 0;

    if (isResuming) {
        console.log(`[file-prepare] Same file in progress (${receivedCount} chunks), skipping reset`);
        showLoader(true, `복구 대기 중: ${data.name}`);
    } else {
        // Clear previous track state before receiving new file
        clearPreviousTrackState('file-prepare (new download)');

        showLoader(true, `준비 중: ${data.name}`);
        stop();
        if (data.index !== undefined) {
            currentTrackIndex = data.index;
            updatePlaylistUI();
        }
        // [FIX] Stop YouTube mode AFTER updatePlaylistUI to prevent title overwrite
        if (isYouTubeMode) {
            console.log("[file-prepare] Stopping YouTube mode for incoming local file");
            stopYouTubeMode();
        }
        // [FIX] Set title LAST to ensure it's not overwritten
        updateTitleWithMarquee(data.name);
        document.getElementById('track-artist').innerText = `Track ${data.index + 1}`;
    } // Close the else block from isResuming check

    // FIX 5: Prepare Watchdog (Prevent Infinite Preparing...)
    if (prepareWatchdog) clearTimeout(prepareWatchdog);
    prepareWatchdog = setTimeout(() => {
        if (!meta || meta.name !== data.name || receivedCount === 0) {
            console.warn("[Prepare Watchdog] Timeout waiting for data start!");
            showToast("준비 지연 중... Host 복구 요청");

            // Fallback: Request recovery directly from Host
            if (hostConn && hostConn.open) {
                const recoveryFileName = window._pendingFileName || '';
                const recoveryIndex = window._pendingFileIndex !== undefined ? window._pendingFileIndex : currentTrackIndex;

                console.log("[Prepare Watchdog Recovery] Requesting from Host:", recoveryFileName);
                hostConn.send({
                    type: 'request-data-recovery',
                    nextChunk: 0,
                    fileName: recoveryFileName,
                    index: recoveryIndex
                });
            }
        }
    }, 15000); // 15s safety timer
}

async function handleFileStart(data) {
    // Skip if we're using preloaded file (already have the data)
    if (window._skipIncomingFile) {
        console.log("[file-start] Skipping - already using preloaded file");
        return;
    }

    // Clear Prepare Watchdog as we've started receiving
    if (prepareWatchdog) { clearTimeout(prepareWatchdog); prepareWatchdog = null; }

    // [FIX] Always reset processing guard at file-start to prevent stuck loader
    // This is safe because file-start means we're (re)starting the transfer
    _isProcessingBlob = false;

    const sourceLabel = upstreamDataConn ? `Relay(${upstreamDataConn.peer.substr(-4)})` : "Host";

    let sizeText = "";
    if (data.size) {
        sizeText = ` (${(data.size / 1024 / 1024).toFixed(1)}MB)`;
    }

    // CRITICAL: Check if we're receiving the SAME file (recovery scenario)
    // If so, preserve existing chunks!
    const isSameFile = meta && meta.name === data.name && meta.total === data.total;

    if (isSameFile && receivedCount > 0) {
        // RECOVERY MODE: Keep existing chunks
        console.log(`[file-start] Same file detected! Keeping ${receivedCount}/${data.total} chunks`);

        // [FIX] If file is already 100% complete, reset guard and skip to end
        if (receivedCount >= data.total) {
            console.log("[file-start] File already complete, triggering immediate processing");
            _isProcessingBlob = false; // Reset guard to allow reprocessing
            meta = data; // Update meta first

            // Trigger processing immediately via setTimeout to avoid blocking
            setTimeout(() => {
                // Simulate the processing that would happen in file-chunk completion
                if (receivedCount >= meta.total && !_isProcessingBlob) {
                    _isProcessingBlob = true;
                    const validChunks = incomingChunks.filter(chunk => chunk !== undefined && chunk !== null);
                    if (validChunks.length >= meta.total) {
                        console.log("[file-start] Processing cached complete file");
                        const blob = new Blob(validChunks.slice(0, meta.total), { type: meta.mime });
                        currentFileBlob = blob;
                        window._waitingForRelayData = false;

                        const isLarge = blob.size > 100 * 1024 * 1024;
                        const isVideo = meta.mime.startsWith('video/') || (meta.name && /\.(mp4|mkv|webm|mov)$/i.test(meta.name));

                        if (isLarge || isVideo) {
                            buffer = null;
                            isVideoMode = true;
                            if (currentMediaObjectURL) URL.revokeObjectURL(currentMediaObjectURL);
                            const url = URL.createObjectURL(blob);
                            currentMediaObjectURL = url;
                            videoElement.src = url;
                            if (isVideo) {
                                document.body.classList.add('mode-video');
                                videoElement.style.display = 'block';
                            } else {
                                videoElement.style.display = 'none';
                            }
                            videoElement.onloadedmetadata = () => {
                                document.getElementById('seek-slider').max = videoElement.duration;
                                document.getElementById('time-dur').innerText = fmtTime(videoElement.duration);
                            };
                            videoElement.load();
                            document.getElementById('play-btn').disabled = !isOperator;
                            showLoader(false);
                            showToast("재생 준비 완료 (캐시 사용)");
                        } else {
                            blob.arrayBuffer().then(buf => {
                                const ctx = Tone.context.rawContext;
                                return ctx.decodeAudioData(buf);
                            }).then(decoded => {
                                buffer = decoded;
                                isVideoMode = false;
                                document.body.classList.remove('mode-video');
                                videoElement.style.display = 'none';
                                document.getElementById('seek-slider').max = buffer.duration;
                                document.getElementById('time-dur').innerText = fmtTime(buffer.duration);
                                document.getElementById('play-btn').disabled = !isOperator;
                                showLoader(false);
                                pausedAt = 0;
                                updatePlayState(false);
                                showToast("재생 준비 완료 (캐시 사용)");
                                setTimeout(() => syncReset(), 1000);
                            }).catch(err => {
                                console.error("Decoding Fail:", err);
                                showLoader(false);
                                _isProcessingBlob = false;
                            });
                        }
                    } else {
                        _isProcessingBlob = false;
                    }
                }
            }, 100);
            return; // Skip rest of file-start handler
        } else {
            showToast(`${sourceLabel}로부터 전송 이어받기`);
            const pct = Math.round((receivedCount / data.total) * 100);
            showLoader(true, `${sourceLabel} 수신 중... ${pct}%${sizeText}`);
        }
        // Update meta but don't touch incomingChunks or receivedCount
        meta = data;
    } else {
        // NEW FILE: Initialize fresh
        console.log(`[file-start] New file, initializing array for ${data.total} chunks`);
        showToast(`${sourceLabel}로부터 파일 수신 시작`);
        showLoader(true, `${sourceLabel} 수신 중... 0%${sizeText}`);
        // Allocate fixed size array to support out-of-order delivery
        incomingChunks = new Array(data.total);
        receivedCount = 0;
        meta = data;

        // [FIX] Apply any pending chunks that arrived before file-start
        if (window._pendingEarlyChunks && window._pendingEarlyChunks.length > 0) {
            console.log(`[file-start] Applying ${window._pendingEarlyChunks.length} early chunks`);
            window._pendingEarlyChunks.forEach(pending => {
                if (pending.index >= 0 && pending.index < data.total && !incomingChunks[pending.index]) {
                    incomingChunks[pending.index] = pending.chunk;
                    receivedCount++;
                }
            });
            window._pendingEarlyChunks = []; // Clear pending buffer
            console.log(`[file-start] After applying early chunks: ${receivedCount}/${data.total}`);
        }
    }

    updateTitleWithMarquee(data.name);

    // Watchdog Start
    if (chunkWatchdog) clearInterval(chunkWatchdog);
    lastChunkTime = Date.now();
    chunkWatchdog = setInterval(() => {
        const timeSinceLast = Date.now() - lastChunkTime;
        const isMetaInvalid = !meta || !meta.total;

        if (timeSinceLast > WATCHDOG_TIMEOUT || (incomingChunks.length > 0 && isMetaInvalid)) {
            // Timeout or Invalid State!
            clearInterval(chunkWatchdog);
            showToast("데이터 수신 불안정. Host 복구 요청...");

            // Detach bad relay info if present (so we show 'Host' in UI next time)
            if (upstreamDataConn) upstreamDataConn = null;

            if (hostConn && hostConn.open) {
                const recoveryFileName = (meta && meta.name) ? meta.name : (window._pendingFileName || '');
                const recoveryIndex = window._pendingFileIndex !== undefined ? window._pendingFileIndex : currentTrackIndex;

                // GAP-BASED RECOVERY: Find first missing chunk index instead of using receivedCount
                let firstMissing = 0;
                if (incomingChunks && incomingChunks.length > 0) {
                    for (let j = 0; j < incomingChunks.length; j++) {
                        if (!incomingChunks[j]) {
                            firstMissing = j;
                            break;
                        }
                    }
                } else {
                    firstMissing = receivedCount || 0;
                }

                console.log("[Watchdog Recovery] Requesting from index:", firstMissing, "FileName:", recoveryFileName);
                hostConn.send({
                    type: 'request-data-recovery',
                    nextChunk: firstMissing,
                    fileName: recoveryFileName,
                    index: recoveryIndex
                });
            }
        }
    }, 1000);

    // RELAY LOGIC: Forward 'file-start' header to downstream (simplified)
    // [FIX] Removed _waitingForFileStart logic that caused duplicate transmissions
    if (downstreamDataPeers.length > 0) {
        downstreamDataPeers.forEach(p => {
            if (p.open) p.send(data);
        });
    }
}

async function handleFileResume(data) {
    // Clear Prepare Watchdog
    if (prepareWatchdog) { clearTimeout(prepareWatchdog); prepareWatchdog = null; }

    // RESUME TRANSFER: Don't reinitialize array! Just continue receiving
    window._skipIncomingFile = false;

    const sourceLabel = upstreamDataConn ? `Relay(${upstreamDataConn.peer.substr(-4)})` : "Host";
    const startChunk = data.startChunk || 0;

    console.log(`[Resume] Continuing from chunk ${startChunk}, already have ${receivedCount} chunks`);
    showToast(`${sourceLabel}로부터 전송 재개 (${startChunk}부터)`);

    // Only initialize array if it doesn't exist or has wrong size
    if (!incomingChunks || incomingChunks.length !== data.total) {
        console.log("[Resume] Array needs initialization");
        incomingChunks = new Array(data.total);
        receivedCount = 0;
    } else {
        console.log(`[Resume] Keeping existing ${receivedCount} chunks`);
    }

    // Update meta
    meta = data;
    updateTitleWithMarquee(data.name);

    let sizeText = data.size ? ` (${(data.size / 1024 / 1024).toFixed(1)}MB)` : "";
    const pct = meta.total > 0 ? Math.round((receivedCount / meta.total) * 100) : 0;
    showLoader(true, `${sourceLabel} 수신 중... ${pct}%${sizeText}`);

    // Restart watchdog
    if (chunkWatchdog) clearInterval(chunkWatchdog);
    lastChunkTime = Date.now();
    chunkWatchdog = setInterval(() => {
        const timeSinceLast = Date.now() - lastChunkTime;
        if (timeSinceLast > 12000) {
            clearInterval(chunkWatchdog);
            showToast("데이터 수신 불안정. Host 복구 요청...");
            if (upstreamDataConn) upstreamDataConn = null;

            if (hostConn && hostConn.open) {
                const recoveryFileName = meta?.name || window._pendingFileName || '';
                const recoveryIndex = window._pendingFileIndex !== undefined ? window._pendingFileIndex : currentTrackIndex;

                // Find first missing chunk
                let firstMissing = 0;
                if (incomingChunks && incomingChunks.length > 0) {
                    for (let j = 0; j < incomingChunks.length; j++) {
                        if (!incomingChunks[j]) {
                            firstMissing = j;
                            break;
                        }
                    }
                } else {
                    firstMissing = receivedCount || 0;
                }

                console.log("[Resume Watchdog] Requesting from index:", firstMissing);
                hostConn.send({
                    type: 'request-data-recovery',
                    nextChunk: firstMissing,
                    fileName: recoveryFileName,
                    index: recoveryIndex
                });
            }
        }
    }, 1000);
}

async function handleFileChunk(data) {
    // Skip if we're using preloaded file
    if (window._skipIncomingFile) {
        console.log("[Chunk] Skipped - _skipIncomingFile is true");
        return; // Silently ignore chunks when using preload
    }

    // CRITICAL: Clone the chunk! The underlying buffer might be reused or detached by PeerJS.
    const chunkCopy = new Uint8Array(data.chunk);

    // INDEX-BASED REASSEMBLY (Fixes Data Corruption)
    const idx = data.index;

    // Debug logging for first few chunks
    if (idx < 5 || idx % 100 === 0) {
        console.log(`[Chunk] Received idx=${idx}, arrayLen=${incomingChunks.length}, total=${meta?.total}`);
    }

    // [FIX #12] Enhanced bounds check with meta.total validation
    const isValidIndex = idx >= 0 &&
        incomingChunks.length > 0 &&
        idx < incomingChunks.length &&
        (!meta || !meta.total || idx < meta.total);

    if (isValidIndex && !incomingChunks[idx]) {
        incomingChunks[idx] = chunkCopy;
        receivedCount++;
    } else if (incomingChunks.length === 0) {
        // [FIX] Buffer early chunks that arrive before file-start
        console.log(`[Chunk] Buffering early chunk idx=${idx} (waiting for file-start)`);
        if (!window._pendingEarlyChunks) window._pendingEarlyChunks = [];
        window._pendingEarlyChunks.push({ index: idx, chunk: chunkCopy });
    }

    lastChunkTime = Date.now();

    // [Active Keep-Alive]
    // If receiving bloated data, send explicit ACK to Host every 2s
    // This prevents Host from timing us out during long transfers
    if (hostConn && hostConn.open) {
        const now = Date.now();
        if (now - lastProgressAck > 2000) {
            hostConn.send({ type: 'heartbeat-ack' });
            lastProgressAck = now;
        }
    }


    // RELAY LOGIC: Forward COPY to downstream WITH INDEX
    if (downstreamDataPeers.length > 0) {
        const fwdMsg = { type: 'file-chunk', chunk: chunkCopy, index: idx };
        downstreamDataPeers.forEach(p => {
            if (p.open) p.send(fwdMsg);
        });
    }

    // Calculate percent with safety check
    let percent = 0;
    if (meta && meta.total > 0) {
        percent = Math.min(100, Math.floor((receivedCount / meta.total) * 100));
    }

    const sourceLabel = upstreamDataConn ? `Relay(${upstreamDataConn.peer.substr(-4)})` : "Host";

    let progressText = `${percent}%`;

    if (meta && meta.size) {
        const totalMB = (meta.size / 1024 / 1024).toFixed(1);
        // Estimate current based on chunks
        // CHUNK size is 16384 (16KB) defined in broadcastFile/unicastFile
        const currentBytes = receivedCount * 16384;
        const currentMB = (currentBytes / 1024 / 1024).toFixed(1);
        progressText = `${currentMB}MB / ${totalMB}MB (${percent}%)`;
    }

    document.getElementById('loader-text').innerText = `${sourceLabel} 수신 중... ${progressText}`;
    updateLoader(percent);

    // [FIX] Use >= instead of === to handle edge cases where receivedCount slightly exceeds total
    if (receivedCount >= meta.total && !_isProcessingBlob) {
        // [FIX #4] Set guard BEFORE any async operation to prevent race conditions
        _isProcessingBlob = true;
        const processingFileName = meta.name; // Capture filename for validation
        const processingIndex = meta.index;   // [Fix] Capture track index for ACK

        // [New] Notify Host that we have this file now
        // This ensures Host knows we have it even if received via real-time transfer
        if (hostConn && hostConn.open && processingIndex !== undefined) {
            hostConn.send({ type: 'preload-ack', index: processingIndex });
            console.log(`[Guest] Confirmed cache for index ${processingIndex} to Host`);
        }

        // CRITICAL: Filter out undefined/null chunks before creating Blob
        // This can happen if relay sent data with gaps
        const validChunks = incomingChunks.filter(chunk => chunk !== undefined && chunk !== null);

        if (validChunks.length !== meta.total) {
            console.error(`[ERROR] Chunk count mismatch: expected ${meta.total}, got ${validChunks.length} valid chunks`);
            showToast("파일 수신 불완전 - 재전송 요청");
            _isProcessingBlob = false; // [FIX] Reset guard to allow retry
            // Request recovery from host
            if (hostConn && hostConn.open) {
                hostConn.send({
                    type: 'request-data-recovery',
                    nextChunk: 0,
                    fileName: meta.name
                });
            }
            return;
        }

        const blob = new Blob(validChunks, { type: meta.mime });
        currentFileBlob = blob; // Cache for Relay Serving

        // [FIX] Clear relay wait flag on file completion
        window._waitingForRelayData = false;

        // Check for Large File / Video to avoid Decoding Crash
        const isLarge = blob.size > 100 * 1024 * 1024;
        const isVideo = meta.mime.startsWith('video/') || (meta.name && /\.(mp4|mkv|webm|mov)$/i.test(meta.name));

        if (isLarge || isVideo) {
            // --- STREAMING MODE (No Decode) ---
            console.log("Guest: Large File/Video detected. Using Streaming Mode.");
            buffer = null;
            isVideoMode = true;

            // Cleanup previous ObjectURL to prevent memory leak
            if (currentMediaObjectURL) {
                URL.revokeObjectURL(currentMediaObjectURL);
                currentMediaObjectURL = null;
            }

            const url = URL.createObjectURL(blob);
            currentMediaObjectURL = url; // Track for later cleanup
            videoElement.src = url;
            // If just audio-large, hide video? Guest mirrors Host usually.
            // Assuming Host sets 'isVideoMode' correctly via visual cues, but here we enforce logic.
            if (isVideo) {
                document.body.classList.add('mode-video');
                videoElement.style.display = 'block';
            } else {
                // Large Audio File
                videoElement.style.display = 'none';
            }

            // Get Duration from Video Element Metadata
            videoElement.onloadedmetadata = () => {
                document.getElementById('seek-slider').max = videoElement.duration;
                document.getElementById('seek-slider').value = 0;
                document.getElementById('time-dur').innerText = fmtTime(videoElement.duration);
            };
            videoElement.load();

            document.getElementById('play-btn').disabled = !isOperator;
            if (Tone.context.state === 'suspended') Tone.context.resume();

            showLoader(false);
            if (chunkWatchdog) clearInterval(chunkWatchdog);
            pausedAt = 0;
            updatePlayState(false);
            showToast("재생 준비 완료");

            // Auto-sync after file load (1 second delay to avoid storm)
            setTimeout(() => {
                console.log("[Guest] Auto-sync after streaming file load");
                syncReset();
            }, 1000);

            // Execute pending play command if any (streaming mode)
            if (window._pendingPlayTime !== undefined) {
                console.log("[Guest] Executing pending play after streaming download");
                const target = window._pendingPlayTime + localOffset;
                play(target);
                window._pendingPlayTime = undefined;
            }

        } else {
            // --- BUFFER MODE ---
            blob.arrayBuffer().then(buf => {
                // Fix: Ensure we have a valid AudioContext (Tone.js wrapper)
                const ctx = Tone.context.rawContext;
                return ctx.decodeAudioData(buf);
            }).then(decoded => {
                buffer = decoded;
                isVideoMode = false; // Explicitly ensure video mode is off for small audio
                document.body.classList.remove('mode-video');
                videoElement.style.display = 'none';

                document.getElementById('seek-slider').max = buffer.duration;
                document.getElementById('seek-slider').value = 0;
                document.getElementById('time-dur').innerText = fmtTime(buffer.duration);
                // Guest receives file -> Enable only if Operator
                document.getElementById('play-btn').disabled = !isOperator;
                if (Tone.context.state === 'suspended') Tone.context.resume();

                showLoader(false);
                if (chunkWatchdog) clearInterval(chunkWatchdog); // Stop watchdog
                pausedAt = 0;
                updatePlayState(false);
                showToast("재생 준비 완료");

                // Auto-sync after file load (1 second delay to avoid storm)
                setTimeout(() => {
                    console.log("[Guest] Auto-sync after buffer file load");
                    syncReset();
                }, 1000);

                // Execute pending play command if any
                if (window._pendingPlayTime !== undefined) {
                    console.log("[Guest] Executing pending play after download");
                    const target = window._pendingPlayTime + localOffset;
                    play(target);
                    window._pendingPlayTime = undefined;
                }
            }).catch(err => {
                console.error("Decoding Fail:", err);
                showLoader(false);
                showToast("오디오 디코딩 실패: 지원하지 않는 형식이거나 손상됨");
            });
        }
    }
}

async function handleFileWait(data) {
    console.log("[Guest] Relay has no data yet, waiting for forwarded data...");
    showToast("릴레이 대기 중... 잠시만 기다려주세요");

    // Mark that we're waiting for relay data
    window._waitingForRelayData = true;

    // Set timeout: If no data comes within 10 seconds, fall back to Host
    if (window._relayWaitTimeout) clearTimeout(window._relayWaitTimeout);
    window._relayWaitTimeout = setTimeout(() => {
        if (window._waitingForRelayData && receivedCount === 0) {
            console.log("[Guest] Relay wait timeout - falling back to Host");
            showToast("릴레이 응답 없음. Host에서 직접 수신...");
            window._waitingForRelayData = false;

            // Disconnect from relay
            if (upstreamDataConn) {
                upstreamDataConn.close();
                upstreamDataConn = null;
            }

            // Request file from Host
            if (hostConn && hostConn.open) {
                const recoveryFileName = window._pendingFileName || '';
                const recoveryIndex = window._pendingFileIndex !== undefined ? window._pendingFileIndex : currentTrackIndex;

                // VALIDATION: Don't send recovery request with invalid index
                if (recoveryIndex < 0 || recoveryIndex >= playlist.length) {
                    console.warn("[file-wait timeout] Invalid index, skipping recovery:", recoveryIndex);
                    showLoader(false);
                    return;
                }

                // Check if preload is in progress for this track
                if (preloadMeta && preloadMeta.index === recoveryIndex) {
                    console.log("[file-wait timeout] Preload in progress for this track, waiting...");
                    showToast("프리로드 완료 대기 중...");
                    return; // Let preload finish naturally
                }

                console.log("[file-wait timeout] Requesting from Host:", recoveryFileName, "index:", recoveryIndex);
                hostConn.send({
                    type: 'request-data-recovery',
                    nextChunk: 0,
                    fileName: recoveryFileName,
                    index: recoveryIndex
                });
            }
        }
    }, 10000); // 10 second timeout
}

async function handleSyncResponse(data) {
    // YouTube mode: Skip local audio sync (YouTube has its own sync)
    if (isYouTubeMode) {
        showToast("YouTube 모드에서는 자동 싱크가 적용되지 않습니다");
        return;
    }

    // [Latency Compensation - Conditional based on ICE type]
    // For relay (TURN): apply RTT/2 compensation
    // For direct (host/srflx): skip compensation (local network has minimal latency)
    let oneWayLatencySeconds = 0;

    if (usePingCompensation) {
        oneWayLatencySeconds = (lastLatencyMs / 2) / 1000;
    }

    autoSyncOffset = oneWayLatencySeconds; // Store for UI

    // compensatedTime = HostCurrentTime (approx)
    const compensatedTime = data.time + oneWayLatencySeconds;

    if (data.isPlaying) play(compensatedTime + localOffset);
    else {
        stop();
        pausedAt = compensatedTime;
        loopUI();
    }

    if (usePingCompensation) {
        showToast(`자동 싱크 보정 완료, +${Math.round(lastLatencyMs / 2)}ms`);
    } else {
        showToast(`직접 동기화 완료 (로컬 네트워크)`);
    }
    updateSyncDisplay();
}

async function handleYouTubePlay(data) {
    // Guest receives YouTube play command from Host
    console.log("[Guest] Received youtube-play:", data);

    // 1. Stop any local audio/video first
    stop();

    // 2. [Reliability] Reset preload state when entering YouTube
    clearPreloadState();
    window._skipIncomingPreload = false;
    if (prepareWatchdog) { clearTimeout(prepareWatchdog); prepareWatchdog = null; }

    isYouTubeMode = true;
    // 3. Stop existing YouTube if playing
    if (isYouTubeMode && youtubePlayer) {
        try { youtubePlayer.destroy(); } catch (e) { }
        youtubePlayer = null;
    }

    // 4. Sync track index
    if (data.index !== undefined) {
        currentTrackIndex = data.index;
        updatePlaylistUI();
    }

    // 4. Load YouTube (autoplay based on Host's command)
    showToast("YouTube 같이 보기 - 고급 오디오 효과가 비활성화됩니다");
    loadYouTubeVideo(data.videoId, data.playlistId, data.autoplay !== false, data.subIndex || 0);

    // 5. Hide Loader (Prevent hang from accidental file-prepare)
    showLoader(false);
}

async function handleYouTubeSync(data) {
    if (typeof handleYouTubeSyncInternal === 'function') {
        handleYouTubeSyncInternal(data);
    } else {
        // Fallback or direct implementation if handleYouTubeSyncInternal is not defined
        // In the original code it was calling handleYouTubeSync(data) which was a recursive call or meant a different function.
        // Wait, looking at original code:
        // else if (data.type === 'youtube-sync') { handleYouTubeSync(data); }
        // This implies handleYouTubeSync is a separate function already?
        // Let's check.
    }
}

async function handlePreloadStart(data) {
    if (prepareWatchdog) { clearTimeout(prepareWatchdog); prepareWatchdog = null; }

    // [Fix] Reliability: Match cache by Index OR Name (Fallback to currentTrackIndex)
    const matchIndex = (idx) => Number(idx) === Number(data.index);
    const matchName = (n) => n && data.name && n === data.name;

    const isCurrentlyPlaying = (buffer || currentFileBlob) && (matchIndex(currentTrackIndex) || matchName(meta?.name));
    const isNextPreloaded = nextFileBlob && (matchIndex(nextMeta?.index) || matchName(nextMeta?.name));
    const alreadyCachedLocally = isCurrentlyPlaying || isNextPreloaded;

    // Skip if Host explicitly said so, or if we detected cache ourselves
    if (data.skipped || alreadyCachedLocally) {
        console.log(`[Preload] Skipping download for ${data.name} - Already cached (Host Skip: ${!!data.skipped}, Local: ${alreadyCachedLocally})`);

        // Mark this session as a skip in current state to suppress warnings later
        preloadChunks = [];
        preloadCount = 0;
        preloadMeta = { ...data, isSkipped: true };
        window._skipIncomingPreload = true;

        // Relay from whatever cache we have to downstream
        const sourceBlob = isNextPreloaded ? nextFileBlob : (currentFileBlob || null);

        if (downstreamDataPeers.length > 0) {
            console.log(`[Relay] Forwarding preload-start for cached track ${data.index} (relayed from this node)`);
            // [CRITICAL FIX] Always clear skipped=true for downstream peers because THIS node will send chunks!
            const forwardHeader = { ...data, skipped: false };
            downstreamDataPeers.forEach(p => { if (p.open) p.send(forwardHeader); });
        }

        if (sourceBlob) {
            relayPreloadFromCache(sourceBlob, data.index, data.sessionId);
        }
        return;
    }

    window._skipIncomingPreload = false;
    console.log("Preload Started:", data.name);
    // Do NOT show loader, this is background
    preloadChunks = new Array(data.total);
    preloadCount = 0;
    preloadMeta = { ...data, isSkipped: false };

    // RELAY SUPPORT: Forward to downstream peers using existing mesh topology
    if (downstreamDataPeers.length > 0) {
        console.log(`[Relay] Forwarding preload-start to ${downstreamDataPeers.length} downstream peers`);
        const forwardHeader = { ...data, skipped: false }; // [Safety] Always false for downstream
        downstreamDataPeers.forEach(p => {
            if (p.open) p.send(forwardHeader);
        });
    }
}

async function handlePreloadChunk(data) {
    if (window._skipIncomingPreload) return; // DISCARD Host chunks while relaying from cache
    // Clone
    const chunkCopy = new Uint8Array(data.chunk);
    const idx = data.index;
    if (idx >= 0 && idx < preloadChunks.length && !preloadChunks[idx]) {
        preloadChunks[idx] = chunkCopy;
        preloadCount++;
    }

    // RELAY: Forward chunk to downstream peers
    if (downstreamDataPeers.length > 0) {
        const fwdMsg = { type: 'preload-chunk', chunk: chunkCopy, index: idx };
        downstreamDataPeers.forEach(p => {
            if (p.open) p.send(fwdMsg);
        });
    }
    // No progress UI for preload (silent)
}

async function handlePreloadEnd(data) {
    // [Fix] Reliable Session Matching: Ignore end signals from previous/cancelled sessions
    if (preloadMeta && data.sessionId !== undefined && preloadMeta.sessionId !== data.sessionId) {
        console.log(`[Preload] Ignoring stale end signal for session ${data.sessionId}`);
        return;
    }

    // [Reliable Skip Detection]
    const isActuallySkipped = window._skipIncomingPreload || (preloadMeta && preloadMeta.isSkipped);

    if (isActuallySkipped || preloadCount === 0) {
        console.log(`[Preload] Finished (Skip/No Chunks): ${data.name}`);
        window._skipIncomingPreload = false;
        return;
    }

    console.log("[Preload] Finished:", data.name);

    // RELAY: Forward preload-end only if it matches current session
    if (downstreamDataPeers.length > 0) {
        const endMsg = { type: 'preload-end', name: data.name, index: data.index, sessionId: data.sessionId };
        downstreamDataPeers.forEach(p => { if (p.open) p.send(endMsg); });
    }

    // Verify chunk integrity
    let missingCount = 0;
    for (let i = 0; i < preloadChunks.length; i++) {
        if (!preloadChunks[i]) missingCount++;
    }

    if (missingCount > 0) {
        // [Final Guard] If NO chunks arrived (573/573 missing), this is likely a discarded/stale session.
        // Just clear and move on without warning the user.
        if (preloadCount === 0) {
            console.log(`[Preload] Session ${data.sessionId} reached end with no chunks. Discarding silently.`);
            clearPreloadState();
            return;
        }

        console.warn(`[Preload] Integrity Check: ${missingCount} / ${preloadChunks.length} chunks missing`);
        clearPreloadState();
        return;
    }

    console.log("[Preload] Success, saving to buffer cache");

    showToast("다음 곡 다운로드 완료! (대기 중)");

    const blob = new Blob(preloadChunks, { type: preloadMeta.mime });

    // Decide: Cache as Blob or Decode?
    // To be safe and ready, let's just store the Blob and Meta
    // We will process it in 'play-preloaded'
    nextFileBlob = blob;
    nextMeta = preloadMeta;

    // [FIX #3] Clear temp arrays with explicit null for GC
    preloadChunks = null; // Force GC eligibility
    preloadChunks = [];
    preloadCount = 0;
    preloadMeta = null;

    // NOTIFY HOST: I have this preload now (prevents duplicate transmission)
    if (hostConn && hostConn.open) {
        hostConn.send({ type: 'preload-ack', index: data.index });
        console.log("[Guest] Sent preload-ack to Host for index:", data.index);
    }

    // CHECK: If we were waiting for this preload, use it immediately!
    if (window._waitingForPreload) {
        console.log("[preload-end] Was waiting for this preload, loading now!");
        window._waitingForPreload = false;

        await loadPreloadedTrack();
        window._preloadUsedForIndex = window._pendingFileIndex;
        showLoader(false);

        // Ready for play command from Host
    }
}

async function handlePlayPreloaded(data) {
    // Host Command: "Switch to what you downloaded!"
    console.log("Command: Play Preloaded Track, index:", data.index);

    // Skip if we already loaded this track via file-prepare
    if (window._preloadUsedForIndex === data.index) {
        console.log("[Guest] Already loaded track via file-prepare, skipping play-preloaded");
        window._preloadUsedForIndex = undefined; // Reset flag
        return;
    }

    currentTrackIndex = data.index;
    updatePlaylistUI(); // Update active highlight

    // [Fix] If Guest was in YouTube mode, stop it before loading file
    if (isYouTubeMode) {
        console.log("[Guest] Switching from YouTube to Preloaded Local Track");
        stopYouTubeMode();
    }

    if (nextFileBlob) {
        // 프리로드된 파일이 있으면 사용
        console.log("[Guest] Using preloaded file for track", data.index);
        await loadPreloadedTrack();

        // CRITICAL: Hide loader so play() doesn't think we're still downloading
        showLoader(false);

        // CRITICAL: Skip any incoming file transfer (Host might send file-start after play-preloaded)
        window._skipIncomingFile = true;

        // Host will send 'play' command shortly

    } else {
        // 프리로드 실패 - Host에게 파일 요청
        console.warn("[Guest] No preloaded file found for track", data.index, "- requesting from Host");
        showLoader(true, "파일 요청 중...");

        // Clear any stale state
        clearPreviousTrackState('play-preloaded fallback');

        // Request file from Relay (if available) or Host
        const trackName = data.name || playlist[data.index]?.name || '';
        window._pendingFileName = trackName;
        window._pendingFileIndex = data.index;

        if (upstreamDataConn && upstreamDataConn.open) {
            console.log("[Guest] Requesting file from Relay:", trackName);
            upstreamDataConn.send({ type: 'request-current-file' });
            showToast("릴레이에 파일 요청 중...");
        } else if (hostConn && hostConn.open) {
            console.log("[Guest] Requesting file from Host:", trackName, "index:", data.index);
            hostConn.send({
                type: 'request-data-recovery',
                nextChunk: 0,
                fileName: trackName,
                index: data.index
            });
            showToast("Host에 파일 요청 중...");
        } else {
            showToast("Host 연결 끊김 - 파일을 받을 수 없습니다");
            showLoader(false);
        }

        showToast("프리로드 누락 - 파일 수신 중...");
    }
}

async function handleStatusSync(data) {
    // [Synchronization Logic] Playlist-Centric Model
    const { playlistMeta, currentTrackIndex: hostTrackIndex, isPlaying: hostIsPlaying } = data;

    // 1. Sync Playlist Structure if different
    const isPlaylistDifferent = JSON.stringify(playlist.map(it => it.name)) !== JSON.stringify(playlistMeta.map(it => it.name));
    if (isPlaylistDifferent) {
        console.log("[Sync] Playlist out of sync, updating...");
        playlist = playlistMeta;
        updatePlaylistUI();
    }

    // 2. Sync Track Index and Trigger Auto-Recovery if needed
    if (hostTrackIndex !== -1 && hostTrackIndex !== currentTrackIndex) {
        const prevIndex = currentTrackIndex;
        currentTrackIndex = hostTrackIndex;
        updatePlaylistUI();

        const item = playlist[currentTrackIndex];
        if (item && item.type !== 'youtube') {
            // Check if we already have the file (decode buffer or blob)
            const hasFile = buffer || currentFileBlob || nextFileBlob;

            // If it's a new track and we don't have it, ask for it
            if (!hasFile || (meta && meta.name !== item.name)) {
                console.log("[Sync] Current track missing, requesting from host:", item.name);
                showLoader(true, `파일 동기화 중: ${item.name}`);
                clearPreviousTrackState('status-sync mismatch');

                // [Fix] If in YouTube mode, stop it for the new local track
                if (isYouTubeMode) stopYouTubeMode();

                if (hostConn && hostConn.open) {
                    hostConn.send({
                        type: 'request-data-recovery',
                        nextChunk: 0,
                        fileName: item.name,
                        index: hostTrackIndex
                    });
                }
            }
        } else if (item && item.type === 'youtube') {
            if (!isYouTubeMode || currentTrackIndex !== prevIndex) {
                console.log("[Sync] Switching to YouTube mode for sync");
                // YouTube mode switch is usually handled by youtube-play message, 
                // but this provides a fallback for late joiners.
            }
        }
    }
}



// --- Data Message Handlers ---

async function handleHeartbeat(data) {
    if (hostConn && hostConn.open) hostConn.send({ type: 'heartbeat-ack' });
}

async function handlePongLatency(data) {
    const ms = Date.now() - data.timestamp;
    latencyHistory.push(ms);
    if (latencyHistory.length > 10) latencyHistory.shift();
    lastLatencyMs = Math.min(...latencyHistory);
    const roleText = document.getElementById('role-text');
    if (roleText && myDeviceLabel !== 'GUEST' && myDeviceLabel !== 'HOST') {
        roleText.innerText = `${myDeviceLabel} (${Math.round(lastLatencyMs)}ms)`;
    }
}

async function handleWelcome(data) {
    document.getElementById('role-text').innerText = data.label;
}

async function handlePlay(data) {
    const loaderEl = document.getElementById('loader');
    const loaderVisible = loaderEl && loaderEl.style.display !== 'none';
    const isDownloading = loaderVisible || window._waitingForRelayData;
    if (isDownloading) {
        console.log("[Guest] Play command received but still downloading, queuing...");
        showToast("다운로드 완료 후 재생됩니다");
        window._pendingPlayTime = data.time;
        return;
    }
    const target = data.time + localOffset;
    if (!isPlaying || Math.abs((Tone.now() - startedAt) - target) > 0.15) play(target);
}

async function handlePause(data) {
    pause();
}

async function handleVolume(data) {
    setVolume(data.value);
    showToast(`Volume: ${Math.round(data.value * 100)}%`);
}

async function handleReverb(data) { setReverb(data.value); }
async function handleReverbType(data) { setReverbType(data.value); }
async function handleReverbDecay(data) { setReverbDecay(data.value); }
async function handleReverbPreDelay(data) { setReverbPreDelay(data.value); }
async function handleReverbLowCut(data) { setReverbLowCut(data.value); }
async function handleReverbHighCut(data) { setReverbHighCut(data.value); }

async function handleEQUpdate(data) {
    setEQ(data.band, data.value, false, true);
}

async function handlePreamp(data) {
    setPreamp(data.value, false, true);
}

async function handleEQReset(data) {
    resetEQ(true);
}

async function handleStereoWidth(data) {
    setStereoWidth(data.value);
}

async function handleVBass(data) {
    setVirtualBass(data.value);
}

async function handlePlaylistUpdate(data) {
    playlist = data.list;
    updatePlaylistUI();
}

async function handleGlobalResyncRequest(data) {
    showToast("Host 요청: 동기화 재설정 중...");
    setTimeout(() => syncReset(), Math.random() * 500);
}

async function handleManualSyncPrepare(data) {
    startSonicSyncGuest(data.time);
}

async function handleForceSyncPlay(data) {
    const t = data.time;
    showToast(`Host 강제 동기화: ${fmtTime(t)}`);
    play(t);
}

async function handleYouTubeSyncWrapper(data) {
    handleYouTubeSync(data);
}

async function handleYouTubeStateWrapper(data) {
    handleYouTubeSync(data);
}

async function handleYouTubeSubTitleUpdateWrapper(data) {
    handleYouTubeSubTitleUpdate(data);
}

async function handleYouTubePlaylistInfo(data) {
    const { playlistId, ids, titles } = data;
    youtubeSubItemsMap[playlistId] = { ids: ids, titles: titles || [] };
    updatePlaylistUI();
}

async function handleYouTubeStop(data) {
    console.log("[Guest] Received youtube-stop, switching to local mode");
    if (isYouTubeMode) stopYouTubeMode();
    stop();
}

async function handleOperatorGrant(data) {
    isOperator = true;
    showToast("Operator 권한이 부여되었습니다.");
    document.getElementById('play-btn').disabled = false;
    document.getElementById('role-badge').innerHTML = `<span class="role-dot"></span> HOST SYNC (OP)`;
}

async function handleOperatorRevoke(data) {
    isOperator = false;
    showToast("Operator 권한이 회수되었습니다.");
    document.getElementById('play-btn').disabled = true;
    document.getElementById('role-badge').innerHTML = `<span class="role-dot"></span> HOST SYNC`;
}

async function handleDeviceListUpdate(data) {
    const amIStillConnected = data.list.find(p => p.id === myId);
    if (hostConn && !amIStillConnected) {
        console.error("Removed from Host List. Reloading...");
        location.reload();
        return;
    }
    const me = data.list.find(p => p.id === myId);
    if (me) myDeviceLabel = me.label;
    renderDeviceList(data.list);
}

async function handleSysToast(data) {
    showToast(data.message);
}

async function handleChat(data) {
    const isMine = (data.sender === myDeviceLabel);
    addChatMessage(data.sender, data.text, isMine);
}

async function handleAssignDataSource(data) {
    const targetId = data.targetId;
    if (targetId && targetId !== myId) {
        showToast(`Connecting to Relay: ...${targetId.substr(-4)}`);
        connectToRelay(targetId);
    }
}

async function handleRequestDataRecoveryGuest(data) {
    // Guest implementation - usually empty or legacy
}

const handlers = {
    'heartbeat': handleHeartbeat,
    'pong-latency': handlePongLatency,
    'welcome': handleWelcome,
    'file-prepare': handleFilePrepare,
    'file-start': handleFileStart,
    'file-resume': handleFileResume,
    'file-chunk': handleFileChunk,
    'file-wait': handleFileWait,
    'play': handlePlay,
    'pause': handlePause,
    'volume': handleVolume,
    'reverb': handleReverb,
    'reverb-type': handleReverbType,
    'reverb-decay': handleReverbDecay,
    'reverb-predelay': handleReverbPreDelay,
    'reverb-lowcut': handleReverbLowCut,
    'reverb-highcut': handleReverbHighCut,
    'eq-update': handleEQUpdate,
    'preamp': handlePreamp,
    'eq-reset': handleEQReset,
    'stereo-width': handleStereoWidth,
    'vbass': handleVBass,
    'playlist-update': handlePlaylistUpdate,
    'sync-response': handleSyncResponse,
    'global-resync-request': handleGlobalResyncRequest,
    'manual-sync-prepare': handleManualSyncPrepare,
    'force-sync-play': handleForceSyncPlay,
    'youtube-play': handleYouTubePlay,
    'youtube-sync': handleYouTubeSyncWrapper,
    'youtube-state': handleYouTubeStateWrapper,
    'youtube-sub-title-update': handleYouTubeSubTitleUpdateWrapper,
    'youtube-playlist-info': handleYouTubePlaylistInfo,
    'youtube-stop': handleYouTubeStop,
    'operator-grant': handleOperatorGrant,
    'operator-revoke': handleOperatorRevoke,
    'device-list-update': handleDeviceListUpdate,
    'sys-toast': handleSysToast,
    'chat': handleChat,
    'assign-data-source': handleAssignDataSource,
    'preload-start': handlePreloadStart,
    'preload-chunk': handlePreloadChunk,
    'preload-end': handlePreloadEnd,
    'play-preloaded': handlePlayPreloaded,
    'status-sync': handleStatusSync,
    'request-data-recovery': handleRequestDataRecoveryGuest
};

async function handleData(data) {
    const handler = handlers[data.type];
    if (handler) {
        try {
            await handler(data);
        } catch (e) {
            console.error(`Error handling ${data.type}:`, e);
        }
    }
}



// --- Relay Functions ---
function connectToRelay(targetId) {
    const conn = peer.connect(targetId, {
        metadata: { type: 'data-relay', label: myId }
    });

    // Timeout: If Relay doesn't accept connection in 10s, Fallback to Host
    const FAIL_TIMEOUT = 10000;
    const connTimer = setTimeout(() => {
        if (!conn.open) {
            console.warn("Relay Connect Timeout");
            conn.close();
            upstreamDataConn = null;

            showToast("Relay 응답 없음. Host 직결 전환...");

            if (hostConn && hostConn.open) {
                // Use stored pending file name from file-prepare, or meta if available
                const recoveryFileName = window._pendingFileName || (meta ? meta.name : '');
                const recoveryIndex = window._pendingFileIndex !== undefined ? window._pendingFileIndex : currentTrackIndex;

                console.log("[Recovery] Requesting from Host:", recoveryFileName, "index:", recoveryIndex, "received:", receivedCount);
                hostConn.send({
                    type: 'request-data-recovery',
                    nextChunk: receivedCount || 0,  // Use actual received count, not 0!
                    fileName: recoveryFileName,
                    index: recoveryIndex
                });
            }
        }
    }, FAIL_TIMEOUT);

    conn.on('open', () => {
        clearTimeout(connTimer);
        upstreamDataConn = conn;
        showToast("Connected to Relay Node");
        conn.on('data', handleData); // Use same handler for data chunks

        // [FIX] 구버전처럼 단순화 - 재시도 로직 제거
        // 릴레이에게 한 번만 파일 요청, 중복 요청 방지
        console.log("Requesting file from relay...");
        conn.send({ type: 'request-current-file' });
    });

    conn.on('close', () => {
        showToast("Relay Disconnected. Recovering...");
        upstreamDataConn = null;

        // AUTO-RECOVERY: Ask Host for missing chunks
        const totalExpected = meta?.total || 0;
        if (receivedCount < totalExpected) {
            if (hostConn && hostConn.open) {
                const recoveryFileName = meta?.name || window._pendingFileName || '';
                const recoveryIndex = window._pendingFileIndex !== undefined ? window._pendingFileIndex : currentTrackIndex;

                // Find first missing chunk
                let firstMissing = 0;
                if (incomingChunks && incomingChunks.length > 0) {
                    for (let j = 0; j < incomingChunks.length; j++) {
                        if (!incomingChunks[j]) {
                            firstMissing = j;
                            break;
                        }
                    }
                } else {
                    firstMissing = receivedCount || 0;
                }

                showToast(`Recovering from chunk ${firstMissing}...`);
                hostConn.send({
                    type: 'request-data-recovery',
                    nextChunk: firstMissing,
                    fileName: recoveryFileName,
                    index: recoveryIndex
                });
            }
        }
    });
}


// --- Manual Sync Logic (Sonic Sync) ---
// --- Manual Sync Logic (Tap Nudge) ---
// Note: Microphone logic removed due to iOS audio routing issues.

function openManualSyncUI() {
    document.getElementById('manual-sync-overlay').classList.add('show');
    updateSyncDisplay();
}

window.closeManualSync = function () {
    document.getElementById('manual-sync-overlay').classList.remove('show');
};

function handleManualSync() {
    // Both Host and Guest can adjust their local offset manually
    openManualSyncUI();
}

function handleAutoSync() {
    handleMainSyncBtn(); // Original network sync
}

// Tap Sync Logic
let syncDebounceTimer = null;

function nudgeSync(ms) {
    // 1. Update State Immediately
    const sec = ms / 1000;
    localOffset += sec;
    updateSyncDisplay();

    // 2. YouTube Mode: Apply immediately via seek
    if (isYouTubeMode && youtubePlayer) {
        try {
            const currentTime = youtubePlayer.getCurrentTime();
            // Nudge = shift current position by the offset delta
            youtubePlayer.seekTo(currentTime + sec, true);
            showToast(`YouTube Sync: ${ms > 0 ? '+' : ''}${ms}ms`);
        } catch (e) {
            console.error("[YouTube] Nudge sync error:", e);
        }
        if (navigator.vibrate) navigator.vibrate(5);
        return;
    }

    // 3. Local Media: Debounce Audio Application
    // Rapidly restarting the audio buffer causes cumulative timing drift.
    // We wait until the user stops tapping before applying the sync jump.
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);

    syncDebounceTimer = setTimeout(() => {
        if (isPlaying) {
            // Apply the new offset to audio
            // We calculate current track position using the 'old' startedAt
            // play() will then recalculate a 'new' startedAt including the new localOffset
            play(Tone.now() - startedAt);
            showToast("Sync Applied");
        }
    }, 300); // 300ms wait

    // Tiny haptic feedback
    if (navigator.vibrate) navigator.vibrate(5);
}

function resetTotalSync() {
    // Clear offsets
    localOffset = 0;
    autoSyncOffset = 0;
    updateSyncDisplay();

    // Trigger Active Sync (Uses Median History)
    if (hostConn && hostConn.open) {
        showToast("초기화 및 재보정 시작...");
        syncReset();
    } else {
        // Fallback if no host
        showToast("호스트 연결 없음. 로컬 초기화 완료.");
        if (isPlaying) play(Tone.now() - startedAt);
    }
}

function updateSyncDisplay() {
    const totalMs = Math.round((localOffset + autoSyncOffset) * 1000);
    const autoMs = Math.round(autoSyncOffset * 1000);
    const manualMs = Math.round(localOffset * 1000);

    const el = document.getElementById('manual-sync-value');
    if (el) el.innerText = (totalMs > 0 ? '+' : '') + totalMs;

    // Update Sub-details if exists
    const detailEl = document.getElementById('sync-details');
    if (detailEl) {
        detailEl.innerHTML = `<span style="opacity:0.7">Auto: ${autoMs}ms</span> <span style="opacity:0.4">|</span> <span style="opacity:0.7">Manual: ${manualMs}ms</span>`;
    }
}



function handleRelayConnection(conn) {
    conn.on('open', () => {
        console.log("Accepted Relay Connection from", conn.peer);
        showToast(`Relay: ${conn.peer.substr(-4)} 연결됨`);
        downstreamDataPeers.push(conn);

        // [FIX] 자동 전송 제거 - 중복 전송 방지
        // downstream이 request-current-file 보낼 때만 전송
        // 또는 Host로부터 file-chunk 수신 시 자동 포워딩
    });

    // LISTENER: We must listen to requests from downstream!
    conn.on('data', async data => {
        if (data.type === 'request-current-file') {
            // VALIDATION: Check if we have valid data for current track
            const currentTrackName = playlist[currentTrackIndex]?.name;
            const hasValidMeta = meta && meta.name && meta.name === currentTrackName;

            // Case 1: File is fully complete.
            // [Optimization] If we have raw chunks, use them directly (Zero-Copy Relay)
            // This is much faster than re-slicing the Blob.
            if (incomingChunks.length > 0 && hasValidMeta && receivedCount === meta.total) {
                showToast(`Fast Relay: Streaming to ${conn.peer.substr(-4)}`);

                (async () => {
                    // 1. header
                    conn.send(meta);
                    await new Promise(r => setTimeout(r, 100));

                    // 2. Stream existing chunks
                    for (let i = 0; i < incomingChunks.length; i++) {
                        // Flow Control
                        if (conn.dataChannel.bufferedAmount > 512 * 1024) {
                            await new Promise(r => {
                                const timer = setInterval(() => {
                                    if (conn.dataChannel.bufferedAmount < 256 * 1024) { clearInterval(timer); r(); }
                                }, 50);
                            });
                        }

                        if (incomingChunks[i]) {
                            conn.send({ type: 'file-chunk', chunk: incomingChunks[i], index: i });
                        }
                        if (i % 20 === 0) await new Promise(r => setTimeout(r, 10));
                    }

                    // 3. End
                    conn.send({ type: 'file-end', name: meta.name, mime: meta.mime });
                })();
            }
            else if (currentFileBlob && meta) {
                // [FIX] Relaxed validation - if we have blob and meta, serve it
                // hasValidMeta check removed to prevent file-wait infinite loading
                showToast(`Relay Request: Serving blob to ${conn.peer.substr(-4)}`);
                unicastFile(conn, currentFileBlob);
            }
            else if (incomingChunks.length > 0 && meta && meta.total > 0) {
                // Case 2: File is in-progress. Serve partial data.
                // NOTE: Relaxed validation for in-progress - allows relay during initial download
                // Strict validation only applies to completed files
                console.log(`[Relay] Serving in-progress file: ${receivedCount}/${meta.total} chunks`);
                showToast(`Relay Request: Syncing stream to ${conn.peer.substr(-4)}`);

                // 1. Send Header First (CRITICAL for NaN fix)
                conn.send(meta);

                // 2. Wait a bit ensuring header arrives first
                await new Promise(r => setTimeout(r, 100));

                // 3. Blast existing chunks (Throttled)
                for (let i = 0; i < incomingChunks.length; i++) {
                    // clone check not needed here as we don't modify incomingChunks, but 'conn.send' might transfer?
                    // Safe approach: just send. Cloning is done in handleData.

                    // Strong Flow Control for Sync
                    if (conn.dataChannel.bufferedAmount > 512 * 1024) {
                        await new Promise(r => setTimeout(r, 50));
                    }

                    // Pause every 10 chunks to prevent bursting
                    if (i % 10 === 0) await new Promise(r => setTimeout(r, 10));

                    // Send with Index!
                    if (incomingChunks[i]) {
                        conn.send({ type: 'file-chunk', chunk: incomingChunks[i], index: i });
                    }
                }
            }
            else if (preloadMeta && preloadChunks.length > 0) {
                // Case 3: We are currently preloading a track. Serve it.
                showToast(`Relay Request: Serving preload to ${conn.peer.substr(-4)}`);
                console.log(`[Relay] Syncing preload buffer: ${preloadCount}/${preloadMeta.total} chunks`);

                (async () => {
                    // 1. Header
                    conn.send(preloadMeta);
                    await new Promise(r => setTimeout(r, 100));

                    // 2. Chunks
                    for (let i = 0; i < preloadChunks.length; i++) {
                        if (preloadChunks[i]) {
                            // Flow Control
                            if (conn.dataChannel.bufferedAmount > 512 * 1024) {
                                await new Promise(r => setTimeout(r, 50));
                            }
                            if (i % 20 === 0) await new Promise(r => setTimeout(r, 10));

                            conn.send({ type: 'preload-chunk', chunk: preloadChunks[i], index: i });
                        }
                    }
                })();
            }
            else {
                // No data yet - tell downstream to WAIT, don't fall back to Host
                // Data will be forwarded automatically once relay starts receiving chunks
                console.log("[Relay] No data yet, telling downstream to wait...");
                conn.send({ type: 'file-wait', message: 'Relay waiting for data from upstream' });

                // Mark this connection as waiting for file-start OR preload-start
                // When we receive data, we'll forward it
                conn._waitingForDataRelay = true;

                showToast(`${conn.peer.substr(-4)}에게 대기 요청`);
            }
        }
    });

    // Forward file-start to any waiting downstream peers when we receive it
    conn._waitingForFileStart = false;

    conn.on('close', () => {
        downstreamDataPeers = downstreamDataPeers.filter(p => p !== conn);
    });
}
/**
 * [Optimization] Relays a preloaded file from local cache to downstream peers.
 * This takes the load off the Host and leverages the already distributed data.
 */
async function relayPreloadFromCache(blob, index, sessionId) {
    if (!blob) {
        console.warn("[Relay] Cannot relay null blob for index:", index);
        return;
    }
    const CHUNK = 16384;
    const total = Math.ceil(blob.size / CHUNK);

    // Robust name lookup from playlist or global meta
    let fileName = "Preloaded Track";
    if (playlist[index]) fileName = playlist[index].name;
    else if (meta && meta.index === index) fileName = meta.name;
    else if (nextMeta && nextMeta.index === index) fileName = nextMeta.name;

    if (downstreamDataPeers.length === 0) return;

    console.log(`[Preload Relay] Relaying ${fileName} (${total} chunks) to ${downstreamDataPeers.length} peers`);

    for (let i = 0; i < total; i++) {
        // Check if we have downstream peers left
        const activeDownstream = downstreamDataPeers.filter(p => p.open);
        if (activeDownstream.length === 0) break;

        const start = i * CHUNK;
        const end = Math.min(start + CHUNK, blob.size);
        const chunkBlob = blob.slice(start, end);
        const chunkBuf = await chunkBlob.arrayBuffer();
        const chunk = new Uint8Array(chunkBuf);

        const chunkMsg = { type: 'preload-chunk', chunk: chunk, index: i };
        activeDownstream.forEach(p => p.send(chunkMsg));

        // Throttle to avoid CPU spikes during playback
        if (i % 10 === 0) await new Promise(r => setTimeout(r, 40));
    }

    const endMsg = { type: 'preload-end', name: fileName, index: index, sessionId: sessionId };
    downstreamDataPeers.forEach(p => {
        if (p.open) p.send(endMsg);
    });
    console.log(`[Preload Relay] Finished relaying index ${index}`);
}

function broadcastData(msg) {
    // For Host: Send to direct peers (limit? or all connected?)
    // Host sends to EVERYONE marked as isDataTarget=true
    connectedPeers.forEach(p => {
        if (p.status === 'connected' && p.conn.open && p.isDataTarget !== false) {
            p.conn.send(msg);
        }
    });
}


function renderDeviceList(list) {
    const container = document.getElementById('device-list');
    container.innerHTML = '';

    list.forEach((p, idx) => {
        if (hostConn) {
            // Guest View
            const statusClass = p.status === 'connected' ? 'active' : 'inactive';
            const statusText = p.status === 'connected' ? 'Connected' : 'Disconnected';
            container.innerHTML += `
                <div class="section-row">
                    <span class="d-name">
                        ${p.label} <span style="font-size:11px; opacity:0.5; margin-left:4px;">(${p.id.substr(-4)})</span>
                        ${p.isOp ? '<span style="color:var(--primary); font-size:10px; font-weight:bold; margin-left:4px;">OP</span>' : ''}
                    </span>
                    <span class="d-status ${statusClass}">${statusText}</span>
                </div>`;
        } else {
            // Host View with Controls
            const statusClass = p.status === 'connected' ? 'active' : 'inactive';
            const statusText = p.status === 'connected' ? 'Connected' : 'Disconnected';
            let opBtn = '';

            // For Host View, we want to show OP badge in name just like guests
            // AND provide the toggle button

            if (!p.isHost && p.status === 'connected') {
                opBtn = `<button class="btn-action ${p.isOp ? 'active' : ''}" 
                     style="font-size:10px; padding:4px 8px; margin-right:8px; ${p.isOp ? 'background:var(--primary); color:white; border:none;' : ''}"
                     onclick="toggleOperator('${p.id}')">
                     ${p.isOp ? 'REVOKE' : 'GRANT'}
                 </button>`;
            }

            container.innerHTML += `
                <div class="section-row">
                    <span class="d-name">
                        ${p.label} <span style="font-size:11px; opacity:0.5; margin-left:4px;">(${p.id.substr(-4)})</span>
                        ${p.isOp ? '<span style="color:var(--primary); font-size:10px; font-weight:bold; margin-left:4px;">OP</span>' : ''}
                    </span>
                    <div style="display:flex; gap:4px; align-items:center;">
                        ${opBtn}
                        <span class="d-status ${statusClass}">${statusText}</span>
                    </div>
                </div>`;
        }
    });
}

// Make global for inline onclick
window.toggleOperator = function (peerId) {
    const p = connectedPeers.find(x => x.id === peerId);
    if (p) {
        p.isOp = !p.isOp;
        // 1. Notify the specific guest
        p.conn.send({ type: p.isOp ? 'operator-grant' : 'operator-revoke' });
        // 2. Update everyone else's list
        broadcastDeviceList();
        // 3. Update Host UI
        renderDeviceList([
            { id: myId, label: 'HOST', status: 'connected', isHost: true },
            ...connectedPeers.map(p => ({
                id: p.id, label: p.label, status: p.status, isHost: false, isOp: p.isOp
            }))
        ]);
        showToast(`${p.label} 권한 ${p.isOp ? '부여됨' : '회수됨'}`);
    }
};

function handleOperatorRequest(data) {
    if (data.type === 'request-play') {
        // Cancel 3-second auto-play timer (just like Host's togglePlay)
        if (autoPlayTimer) {
            clearTimeout(autoPlayTimer);
            autoPlayTimer = null;
            showToast("자동 재생 취소됨 (OP)");
        }
        play(data.time);
        broadcast({ type: 'play', time: data.time });
    } else if (data.type === 'request-pause') {
        // Also cancel timer on pause
        if (autoPlayTimer) {
            clearTimeout(autoPlayTimer);
            autoPlayTimer = null;
        }
        pause();
        broadcast({ type: 'pause' });
    } else if (data.type === 'request-youtube-play') {
        // OP requested YouTube play
        console.log("[Host] OP requested YouTube play");
        if (isYouTubeMode && youtubePlayer) {
            try {
                youtubePlayer.playVideo();
                broadcast({ type: 'youtube-state', state: 1, time: youtubePlayer.getCurrentTime() });
            } catch (e) {
                console.error("[YouTube] OP play error:", e);
            }
        }
    } else if (data.type === 'request-youtube-pause') {
        // OP requested YouTube pause
        console.log("[Host] OP requested YouTube pause");
        if (isYouTubeMode && youtubePlayer) {
            try {
                youtubePlayer.pauseVideo();
                broadcast({ type: 'youtube-state', state: 2, time: youtubePlayer.getCurrentTime() });
            } catch (e) {
                console.error("[YouTube] OP pause error:", e);
            }
        }
    } else if (data.type === 'request-track-change') {
        // OP requested track change
        console.log("[Host] OP requested track change to:", data.index);
        playTrack(data.index);
    } else if (data.type === 'request-next-track') {
        // OP requested next track
        console.log("[Host] OP requested next track");
        playNextTrack();
    } else if (data.type === 'request-prev-track') {
        // OP requested previous track
        console.log("[Host] OP requested prev track");
        playPrevTrack();
    } else if (data.type === 'request-skip-time') {
        // OP requested skip time
        console.log("[Host] OP requested skip time:", data.sec);
        skipTime(data.sec);
    } else if (data.type === 'request-seek') {
        // OP requested seek to specific time
        console.log("[Host] OP requested seek to:", data.time);

        // YouTube mode: use YouTube API
        if (isYouTubeMode && youtubePlayer) {
            try {
                youtubePlayer.seekTo(data.time, true);  // data.time is already in seconds
                broadcast({ type: 'youtube-state', state: youtubePlayer.getPlayerState(), time: data.time });
            } catch (e) {
                console.error("[YouTube] request-seek error:", e);
            }
            return;
        }

        // Local mode
        if (isPlaying) play(data.time); else pausedAt = data.time;
        broadcast({ type: 'play', time: data.time });
    } else if (data.type === 'request-eq-reset') {
        resetEQ(); // Host resets locally -> Broadcasts 'eq-reset'
    } else if (data.type === 'request-setting') {
        // Generic setting update
        if (data.settingType === 'reverb') { setReverb(data.value); broadcast({ type: 'reverb', value: data.value }); }
        else if (data.settingType === 'reverb-type') { setReverbType(data.value); broadcast({ type: 'reverb-type', value: data.value }); }
        else if (data.settingType === 'reverb-decay') { setReverbDecay(data.value); broadcast({ type: 'reverb-decay', value: data.value }); }
        else if (data.settingType === 'reverb-predelay') { setReverbPreDelay(data.value); broadcast({ type: 'reverb-predelay', value: data.value }); }
        else if (data.settingType === 'reverb-lowcut') { setReverbLowCut(data.value); broadcast({ type: 'reverb-lowcut', value: data.value }); }
        else if (data.settingType === 'reverb-highcut') { setReverbHighCut(data.value); broadcast({ type: 'reverb-highcut', value: data.value }); }
        else if (data.settingType === 'eq') {
            const band = parseInt(data.band, 10);
            const val = parseFloat(data.value);
            setEQ(band, val, false, true); // Update Host local
            broadcast({ type: 'eq-update', band: band, value: val }); // Explicitly broadcast
        }
        else if (data.settingType === 'preamp') {
            const val = parseFloat(data.value);
            setPreamp(val, false, true);
            broadcast({ type: 'preamp', value: data.value });
        }
        else if (data.settingType === 'stereo') { setStereoWidth(data.value); broadcast({ type: 'stereo-width', value: data.value }); }
        else if (data.settingType === 'vbass') { setVirtualBass(data.value); broadcast({ type: 'vbass', value: data.value }); }
    } else if (data.type === 'request-youtube-sub-seek') {
        // OP requested specific video in playlist
        console.log("[Host] OP requested YouTube sub-seek:", data.subIdx);
        if (isYouTubeMode && youtubePlayer && youtubePlayer.playVideoAt) {
            try {
                youtubePlayer.playVideoAt(data.subIdx);
                // State update will be handled by regular sync loop
            } catch (e) {
                console.error("[YouTube] OP sub-seek error:", e);
            }
        }
    }
}

async function broadcastFile(file) {
    // 1. Send Header to all eligible targets (skip those who have preload)
    const CHUNK = 16384;
    const total = Math.ceil(file.size / CHUNK);
    const header = { type: 'file-start', name: file.name, mime: file.type, total: total, size: file.size, index: currentTrackIndex };

    // Filter peers: primary data targets only
    const getEligiblePeers = () => {
        return connectedPeers.filter(p => {
            const trackIdx = currentTrackIndex;
            const alreadyHasPreload = p.preloadedIndexes && p.preloadedIndexes.has(trackIdx);
            return (p.status === 'connected' && p.conn.open && p.isDataTarget !== false && !alreadyHasPreload);
        });
    };

    const eligiblePeers = getEligiblePeers();

    if (eligiblePeers.length === 0) {
        console.log("[broadcastFile] All peers have preload, skipping file transfer");
        return;
    }

    console.log(`[broadcastFile] Sending to ${eligiblePeers.length} peers (${connectedPeers.filter(p => p.status === 'connected').length - eligiblePeers.length} skipped due to preload)`);

    eligiblePeers.forEach(p => p.conn.send(header));


    // OPTIMIZATION: Slice the file iteratively instead of loading entire ArrayBuffer
    for (let i = 0; i < total; i++) {
        // Re-evaluate eligible peers each iteration (peers may ack during transfer)
        const currentEligible = getEligiblePeers();
        if (currentEligible.length === 0) {
            console.log("[broadcastFile] All peers now have preload, stopping transfer");
            return;
        }

        // Flow Control: Check eligible peers' buffer
        let congested = true;
        let attempts = 0;
        while (congested && attempts < 10) {
            congested = false;
            for (const p of currentEligible) {
                if (p.conn.dataChannel && p.conn.dataChannel.bufferedAmount > 10 * 1024 * 1024) {
                    congested = true;
                    break;
                }
            }
            if (congested) {
                attempts++;
                await new Promise(r => setTimeout(r, 50));
            }
        }

        // Read specific chunk from File (Disk/Blob)
        const start = i * CHUNK;
        const end = Math.min(start + CHUNK, file.size);
        const chunkBlob = file.slice(start, end);
        const chunkBuf = await chunkBlob.arrayBuffer();
        const chunk = new Uint8Array(chunkBuf);

        const chunkMsg = { type: 'file-chunk', chunk: chunk, index: i };

        // Send to eligible targets only
        for (const p of currentEligible) {
            p.conn.send(chunkMsg);
        }

        // Small breathing room every 50 chunks
        if (i % 50 === 0) await new Promise(r => setTimeout(r, 10));
    }

    // Send End to eligible peers
    const endMsg = { type: 'file-end', name: file.name, mime: file.type };
    const finalEligible = getEligiblePeers();
    finalEligible.forEach(p => p.conn.send(endMsg));
}


async function unicastFile(conn, file, startChunkIndex = 0) {
    // Validate connection first
    if (!conn || !conn.open) {
        console.error("[Unicast] Connection is not open, cannot send file");
        showToast("연결 오류: 파일 전송 실패");
        return;
    }

    const CHUNK = 16384;
    const total = Math.ceil(file.size / CHUNK);

    // Send appropriate header: file-start for new, file-resume for recovery
    const isResume = startChunkIndex > 0;
    const msgType = isResume ? 'file-resume' : 'file-start';
    console.log(`[Unicast] Sending ${msgType}: ${file.name}, chunk ${startChunkIndex}/${total}`);

    try {
        conn.send({
            type: msgType,
            name: file.name,
            mime: file.type,
            total: total,
            size: file.size,
            startChunk: startChunkIndex  // Tell Guest where we're resuming from
        });
    } catch (e) {
        console.error(`[Unicast] Failed to send ${msgType}:`, e);
        return;
    }

    // Wait for header to settle
    await new Promise(r => setTimeout(r, 100));

    if (startChunkIndex > 0) {
        showToast(`Resuming transfer from ${startChunkIndex}...`);
    }

    try {
        for (let i = startChunkIndex; i < total; i++) {
            // Check connection is still open
            if (!conn.open) {
                console.error("[Unicast] Connection closed mid-transfer at chunk", i);
                return;
            }

            // Safe buffered amount check with fallback
            try {
                if (conn.dataChannel && conn.dataChannel.bufferedAmount > 512 * 1024) {
                    let attempts = 0;
                    await new Promise(r => {
                        const interval = setInterval(() => {
                            attempts++;
                            if (!conn.dataChannel || conn.dataChannel.bufferedAmount < 256 * 1024 || attempts > 40) {
                                clearInterval(interval);
                                r();
                            }
                        }, 50);
                    });
                }
            } catch (bufferErr) {
                // dataChannel might not be available, continue anyway
                console.warn("[Unicast] Buffer check failed, continuing:", bufferErr);
            }

            // Slice Optimization
            const start = i * CHUNK;
            const end = Math.min(start + CHUNK, file.size);
            const chunkBlob = file.slice(start, end);
            const chunkBuf = await chunkBlob.arrayBuffer();
            const chunk = new Uint8Array(chunkBuf);

            conn.send({ type: 'file-chunk', chunk: chunk, index: i });

            // Throttle: Pause every 50 chunks (increased from 10 for better speed)
            if (i % 50 === 0) {
                await new Promise(r => setTimeout(r, 10));
                // Log progress occasionally
                if (i % 100 === 0) {
                    console.log(`[Unicast] Progress: ${i}/${total} chunks`);
                }
            }
        }

        conn.send({ type: 'file-end', name: file.name, mime: file.type });
        console.log("[Unicast] Transfer complete:", file.name);

    } catch (e) {
        console.error("[Unicast] Transfer error:", e);
        showToast("파일 전송 중 오류 발생");
    }
}

function broadcast(msg) {
    connectedPeers.forEach(p => { if (p.status === 'connected' && p.conn.open) p.conn.send(msg); });
}

function updateLoader(percent) {
    const circle = document.getElementById('loader-ring');
    // Remove indeterminate state (stop spinning, become progress bar)
    document.querySelector('.progress-ring').classList.remove('indeterminate');
    const radius = circle.r.baseVal.value;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference - (percent / 100) * circumference;
    circle.style.strokeDashoffset = offset;
}

function showLoader(show, txt) {
    document.getElementById('loader').style.display = show ? 'flex' : 'none';
    if (txt) document.getElementById('loader-text').innerText = txt;
    if (show) {
        // Reset or Initialize -> Default to Indeterminate (Spinner)
        // updateLoader(0); // Removed to keep spinner active until progress starts
        document.querySelector('.progress-ring').classList.add('indeterminate');
    }
}
let toastTimer = null;
function showToast(msg) {
    const t = document.getElementById('toast');
    document.getElementById('toast-msg').innerText = msg;
    t.classList.add('show');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        t.classList.remove('show');
    }, 2000);
}
function copyLink() {
    const link = document.getElementById('my-id').innerText;
    if (link.includes('...')) return;
    let idToCopy = myId;
    if (hostConn) {
        const hostInput = document.getElementById('join-id-input').value;
        if (hostInput) idToCopy = hostInput;
    }
    navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?host=${idToCopy}`);
    showToast("링크 복사 완료");
}

function autoSync() {
    localOffset = 0;
    showToast("모든 기기 Auto Sync 요청...");
    broadcast({ type: 'global-resync-request' });
}

function loopUI() {
    if (isPlaying) {
        const duration = buffer ? buffer.duration : (videoElement ? videoElement.duration : 0);
        let t = (Tone.now() - startedAt) + localOffset;

        // [Fix] Clamp UI time to duration to prevent "3:07 / 3:00" visuals
        if (duration > 0 && t > duration) t = duration;

        if (!isSeeking) {
            document.getElementById('seek-slider').value = t;
            document.getElementById('time-curr').innerText = fmtTime(t);
        }

        // Video Sync is now handled by Worker (checkVideoSync)

        // [FIX #9] Throttle handleEnded to check every 500ms instead of every frame
        const now = Date.now();
        if (!window._lastEndedCheck || now - window._lastEndedCheck > 500) {
            window._lastEndedCheck = now;
            handleEnded();
        }

        requestAnimationFrame(loopUI);
    }
}

function toggleFullscreen() {
    const wrapper = document.querySelector('.video-wrapper');
    const video = document.getElementById('main-video');

    // iOS Safari Check for Video Element
    if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
        return;
    }

    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (wrapper.requestFullscreen) wrapper.requestFullscreen();
        else if (wrapper.webkitRequestFullscreen) wrapper.webkitRequestFullscreen(); // Safari
        else if (wrapper.msRequestFullscreen) wrapper.msRequestFullscreen(); // IE/Edge
    } else {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
}


// Expose for Demo Integration
window.playlist = playlist;
window.playTrack = playTrack;
window.updatePlaylistUI = updatePlaylistUI;
window.broadcast = broadcast;
window.broadcastFile = broadcastFile;
window.initAudio = initAudio;

// Expose Surround Functions
window.toggleSurroundMode = toggleSurroundMode;
window.setSurroundChannel = setSurroundChannel;

// Helper to switch to preloaded track
async function loadPreloadedTrack() {
    console.log("Switching to Preloaded Track...");

    // SAFETY CHECK: Ensure we have something to load
    if (!nextBuffer && !nextFileBlob) {
        console.error("[loadPreloadedTrack] No preloaded data available!");
        showToast("프리로드된 파일이 없습니다");
        return false; // Indicate failure
    }

    // CRITICAL: Clear previous track state to prevent relay serving stale data
    clearPreviousTrackState('loadPreloadedTrack');

    // Update global state for relaying before clearing nextFileBlob
    // This allows the relay to serve this track to any late joiners
    currentFileBlob = nextFileBlob;
    meta = nextMeta;
    receivedCount = meta ? meta.total : 0;

    // 1. 재생 중지 및 초기화
    stop();

    // 2. 버퍼 스왑 로직
    if (nextBuffer) {
        // [Case A] 이미 디코딩된 오디오 버퍼가 있는 경우 (작은 파일)
        buffer = nextBuffer;

        // 모드 전환: 오디오 모드
        isVideoMode = false;
        document.body.classList.remove('mode-video');
        videoElement.style.display = 'none';

        updateUISlider(buffer.duration);

    } else if (nextFileBlob) {
        // [Case B] 파일 Blob만 있는 경우 (대용량 파일 or 비디오)
        const file = nextFileBlob;

        // Cleanup previous ObjectURL to prevent memory leak
        if (currentMediaObjectURL) {
            URL.revokeObjectURL(currentMediaObjectURL);
            currentMediaObjectURL = null;
        }

        const url = URL.createObjectURL(file); // URL 생성
        currentMediaObjectURL = url; // Track for later cleanup

        // 대용량(100MB 이상)이거나 비디오 타입인 경우 -> 스트리밍 모드
        let isLargeFile = file.size > 100 * 1024 * 1024;
        let isVideoType = (nextMeta && nextMeta.mime.startsWith('video/'));

        if (isLargeFile || isVideoType) {
            // --- Streaming Mode (Video Element) ---
            isVideoMode = true;
            document.body.classList.add('mode-video');
            videoElement.style.display = 'block';
            videoElement.src = url;

            // 메타데이터 로딩 대기 (에러 처리 포함)
            try {
                await new Promise((resolve, reject) => {
                    videoElement.onloadedmetadata = () => resolve();
                    videoElement.onerror = (e) => reject("Video Load Error");
                });

                // 로딩 성공 후 설정
                setupMediaSource(); // 오디오 노드 연결
                updateUISlider(videoElement.duration);

                // 주의: videoElement.src에 할당된 ObjectURL은 
                // 해당 요소가 로드된 후에도 해제하면 안 되는 경우가 있어(브라우저마다 다름),
                // 보통 다음 곡으로 넘어갈 때 revoke하거나 가비지 컬렉션에 맡깁니다.
                // 여기서는 안전하게 유지합니다.

            } catch (err) {
                console.error("Failed to load video metadata:", err);
                // [FIX #13] Clean up ObjectURL on error to prevent leak
                if (currentMediaObjectURL) {
                    URL.revokeObjectURL(currentMediaObjectURL);
                    currentMediaObjectURL = null;
                }
                alert("미디어를 불러오는데 실패했습니다.");
                return; // 중단
            }

        } else {
            // --- Decode Mode (RAM Buffer) ---
            try {
                const tempBuffer = new Tone.Buffer();
                await tempBuffer.load(url);
                buffer = tempBuffer;

                // 로딩 완료 후 URL 해제 (메모리 확보 필수!)
                URL.revokeObjectURL(url);

                // 모드 전환: 오디오 모드
                isVideoMode = false;
                document.body.classList.remove('mode-video');
                videoElement.style.display = 'none';

                updateUISlider(buffer.duration);
            } catch (err) {
                console.error("Audio Decode Error:", err);
                return;
            }
        }
    }

    // 3. UI 텍스트 업데이트 (제목, 아티스트)
    if (currentTrackIndex !== -1 && playlist[currentTrackIndex]) {
        updateTitleWithMarquee(playlist[currentTrackIndex].name);
        document.getElementById('track-artist').innerText = `Track ${currentTrackIndex + 1}`;
    }

    // 4. 다음 곡 변수 초기화 (메모리 해제)
    nextBuffer = null;
    nextFileBlob = null;
    nextMeta = null;
    nextTrackIndex = -1;

    console.log("Track switched successfully.");
}

// UI 슬라이더 업데이트용 헬퍼 함수
function updateUISlider(duration) {
    const slider = document.getElementById('seek-slider');
    const timeDur = document.getElementById('time-dur');

    if (slider && isFinite(duration)) {
        slider.max = duration;
        slider.value = 0;
        slider.disabled = false;
    }

    if (timeDur && isFinite(duration)) {
        timeDur.innerText = fmtTime(duration);
    }
}

// ============================================================
// Help Modal Functions
// ============================================================
function openHelpModal() {
    document.getElementById('help-modal').classList.add('show');
}

function closeHelpModal(event) {
    // Close if clicked outside modal or close button
    if (!event || event.target === event.currentTarget) {
        document.getElementById('help-modal').classList.remove('show');
    }
}

// Expose to window for onclick handlers
window.openHelpModal = openHelpModal;
window.closeHelpModal = closeHelpModal;

// ============================================================
// Chat Functions
// ============================================================
let myChatLabel = 'HOST';  // Will be updated on connection

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();

    if (!text) return;

    // Determine sender label
    const sender = hostConn ? myDeviceLabel : 'HOST';
    myChatLabel = sender;

    // Add to local UI
    addChatMessage(sender, text, true);

    // Send via network
    const chatMsg = { type: 'chat', sender: sender, text: text };

    if (!hostConn) {
        // Host: Broadcast to all guests
        broadcast(chatMsg);
    } else {
        // Guest: Send to host (host will rebroadcast)
        hostConn.send(chatMsg);
    }

    // Clear input
    input.value = '';
}

function addChatMessage(sender, text, isMine) {
    const container = document.getElementById('chat-messages');

    // Remove empty placeholder if exists
    const empty = container.querySelector('.chat-empty');
    if (empty) empty.remove();

    // Create bubble
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${isMine ? 'mine' : 'others'}`;
    bubble.innerHTML = `
        <div class="chat-sender">${escapeHtml(sender)}</div>
        <div class="chat-text">${parseMessageContent(text)}</div>
    `;

    container.appendChild(bubble);

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// Chat Message Parsing (YouTube, Timestamps, Emoji)
// ============================================

/**
 * Parse message content to detect YouTube URLs and timestamps
 * Returns HTML with clickable elements
 */
function parseMessageContent(text) {
    // YouTube URL pattern
    const ytRegex = /(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[a-zA-Z0-9_-]{11}[^\s]*/gi;

    // Timestamp pattern (0:00, 1:23, 12:34, 1:23:45)
    const tsRegex = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;

    // Combined pattern to split text into parts
    const combinedRegex = new RegExp(
        `(${ytRegex.source})|(${tsRegex.source})`,
        'gi'
    );

    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = combinedRegex.exec(text)) !== null) {
        // Escape and add text before match
        if (match.index > lastIndex) {
            result += escapeHtml(text.slice(lastIndex, match.index));
        }

        const matchedText = match[0];

        // Check if it's a YouTube URL
        if (ytRegex.test(matchedText)) {
            ytRegex.lastIndex = 0; // Reset regex
            const cleanUrl = matchedText.startsWith('http') ? matchedText : 'https://' + matchedText;
            const safeUrl = cleanUrl.replace(/'/g, "\\'");
            result += `<button class="chat-youtube-btn" onclick="loadYouTubeFromChat('${safeUrl}')">▶ 재생</button>`;
        }
        // Check if it's a timestamp
        else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(matchedText)) {
            const seconds = parseTimestamp(matchedText);
            result += `<span class="chat-timestamp" onclick="seekToTime(${seconds})">${matchedText}</span>`;
        }
        else {
            result += escapeHtml(matchedText);
        }

        lastIndex = combinedRegex.lastIndex;
    }

    // Add remaining text
    if (lastIndex < text.length) {
        result += escapeHtml(text.slice(lastIndex));
    }

    return result;
}


/**
 * Parse timestamp string to seconds
 * Supports formats: 1:23, 12:34, 1:23:45
 */
function parseTimestamp(str) {
    const parts = str.split(':').map(Number);
    if (parts.length === 2) {
        // MM:SS or M:SS
        return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
        // H:MM:SS or HH:MM:SS
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
}

/**
 * Seek to specific time in current media
 */
function seekToTime(seconds) {
    if (isYouTubeMode && youtubePlayer && youtubePlayer.seekTo) {
        youtubePlayer.seekTo(seconds, true);
        showToast(`${fmtTime(seconds)}로 이동`);
    } else if (isVideoMode) {
        const video = document.getElementById('main-video');
        if (video) {
            video.currentTime = seconds;
            showToast(`${fmtTime(seconds)}로 이동`);
        }
    } else if (player) {
        // For Tone.js audio player
        stop();
        play(seconds);
        showToast(`${fmtTime(seconds)}로 이동`);
    } else {
        showToast("재생 중인 미디어가 없습니다");
    }
}

/**
 * Load YouTube video from chat message link
 */
function loadYouTubeFromChat(url) {
    const videoId = extractYouTubeVideoId(url);
    const playlistId = extractYouTubePlaylistId(url);

    if (!videoId && !playlistId) {
        showToast("유효하지 않은 YouTube 링크");
        return;
    }

    // Close chat drawer first
    if (isChatDrawerOpen) {
        toggleChatDrawer();
    }

    // Add to playlist and play
    const title = 'YouTube Video';
    const wasEmpty = (playlist.length === 0);

    playlist.push({
        type: 'youtube',
        videoId: videoId,
        playlistId: playlistId,
        title: title,
        name: title
    });

    updatePlaylistUI();

    // Broadcast playlist update
    const metaList = playlist.map(item => ({
        type: item.type,
        name: item.name || item.title,
        videoId: item.videoId || null,
        playlistId: item.playlistId || null
    }));
    broadcast({ type: 'playlist-update', list: metaList });

    // Play the newly added track
    playTrack(playlist.length - 1);
    showToast("YouTube 재생 시작");
}

/**
 * Insert emoji into chat input
 */
function insertEmoji(emoji) {
    const input = document.getElementById('chat-input');
    if (input) {
        input.value += emoji;
        input.focus();
    }
}

// Expose new chat functions
window.parseMessageContent = parseMessageContent;
window.seekToTime = seekToTime;
window.loadYouTubeFromChat = loadYouTubeFromChat;
window.insertEmoji = insertEmoji;

// Handle Enter key in chat input
document.addEventListener('DOMContentLoaded', () => {
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }
});

// ============================================================
// Unread Message Badge
// ============================================================
let unreadChatCount = 0;
let lastChatSender = '';
let lastChatText = '';
let isChatDrawerOpen = false; // Declare here for hoisting

function updateChatBadgeDisplay() {
    const badge = document.getElementById('chat-preview-badge');
    if (!badge) return;

    if (unreadChatCount > 0) {
        badge.textContent = unreadChatCount > 9 ? '9+' : unreadChatCount;
        badge.classList.add('show');
    } else {
        badge.classList.remove('show');
    }
}

function updateChatPreviewText() {
    const previewText = document.getElementById('chat-preview-text');
    if (previewText && lastChatSender && lastChatText) {
        previewText.textContent = `${lastChatSender}: ${lastChatText}`;
    }
}

function incrementUnread() {
    // Only increment if chat drawer is not open
    if (!isChatDrawerOpen) {
        unreadChatCount++;
        updateChatBadgeDisplay();
    }
}

function clearUnread() {
    unreadChatCount = 0;
    updateChatBadgeDisplay();
}

// Hook into addChatMessage to track unread and update preview
const originalAddChatMessage = addChatMessage;
addChatMessage = function (sender, text, isMine) {
    originalAddChatMessage(sender, text, isMine);
    // Update preview text
    lastChatSender = sender;
    lastChatText = text;
    updateChatPreviewText();

    if (!isMine) {
        incrementUnread();
    }
};

// Hook into switchTab to clear unread when entering chat
const originalSwitchTab = switchTab;
switchTab = function (tabId) {
    originalSwitchTab(tabId);
    // Close chat drawer when switching tabs
    if (isChatDrawerOpen) {
        toggleChatDrawer();
    }
};

// ========================================
// Chat Drawer System
// ========================================

function toggleChatDrawer() {
    const drawer = document.getElementById('chat-drawer');
    if (!drawer) return;

    isChatDrawerOpen = !isChatDrawerOpen;
    drawer.classList.toggle('open', isChatDrawerOpen);

    if (isChatDrawerOpen) {
        clearUnread();
        // Focus input after animation
        setTimeout(() => {
            const input = document.getElementById('chat-input');
            if (input) input.focus();
        }, 300);
        // Scroll to bottom
        const messages = document.getElementById('chat-messages');
        if (messages) messages.scrollTop = messages.scrollHeight;
    }
}

// Update chat preview button with latest message and badge
function updateChatPreview(sender, text) {
    const previewText = document.getElementById('chat-preview-text');
    if (previewText && sender && text) {
        previewText.textContent = `${sender}: ${text}`;
    }
}

function updateChatBadge(count) {
    const badge = document.getElementById('chat-preview-badge');
    if (!badge) return;

    if (count > 0) {
        badge.textContent = count > 9 ? '9+' : count;
        badge.classList.add('show');
    } else {
        badge.classList.remove('show');
    }
}

/**
 * [Support] Switches the Chat UI to/from YouTube mode (mini player layout)
 */
function updateChatYouTube(active) {
    const drawer = document.getElementById('chat-drawer');
    if (!drawer) return;

    if (active) {
        drawer.classList.add('with-youtube');

        // Ensure container exists
        let container = document.getElementById('chat-youtube-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'chat-youtube-container';
            container.className = 'chat-youtube-container';
            container.innerHTML = '<div class="chat-youtube-player" id="chat-youtube-placeholder"></div>';

            // Insert before the messages container
            const messages = document.getElementById('chat-messages');
            drawer.insertBefore(container, messages);
        }
    } else {
        drawer.classList.remove('with-youtube');
        const container = document.getElementById('chat-youtube-container');
        if (container) container.remove();
    }
}

// Expose chat functions
window.sendChatMessage = sendChatMessage;
window.addChatMessage = addChatMessage;
window.toggleChatDrawer = toggleChatDrawer;
window.updateChatYouTube = updateChatYouTube;

// ============================================
// MEDIA SOURCE POPUP & YOUTUBE INTEGRATION
// ============================================

let youtubePlayer = null;
let isYouTubeMode = false;

function openMediaSourcePopup() {
    if (hostConn) {
        return showToast("Host만 실행할 수 있습니다.");
    }
    document.getElementById('media-source-overlay').classList.add('show');
}

function closeMediaSourcePopup() {
    document.getElementById('media-source-overlay').classList.remove('show');
}

function openYouTubePopup() {
    document.getElementById('youtube-url-overlay').classList.add('show');
    document.getElementById('youtube-url-input').value = '';
    document.getElementById('youtube-url-input').focus();
}

function closeYouTubePopup() {
    document.getElementById('youtube-url-overlay').classList.remove('show');
}

function extractYouTubeVideoId(url) {
    // Supports various YouTube URL formats
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

function extractYouTubePlaylistId(url) {
    const match = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

function loadYouTubeFromInput() {
    const url = document.getElementById('youtube-url-input').value.trim();
    if (!url) {
        showToast("URL을 입력해 주세요");
        return;
    }

    const videoId = extractYouTubeVideoId(url);
    const playlistId = extractYouTubePlaylistId(url);

    if (!videoId && !playlistId) {
        showToast("유효한 YouTube 링크가 아닙니다");
        return;
    }

    // Get preview info for playlist
    const previewTitle = document.getElementById('youtube-preview-title').innerText || 'YouTube Video';
    const previewThumb = document.getElementById('youtube-preview-thumb').src || '';
    const previewChannel = document.getElementById('youtube-preview-channel').innerText || '';

    // Check if playlist was empty before adding
    const wasEmpty = (playlist.length === 0);

    // Add to unified playlist
    playlist.push({
        type: 'youtube',
        videoId: videoId,
        playlistId: playlistId,
        title: previewTitle,
        name: previewTitle, // For compatibility
        thumbnail: previewThumb,
        channel: previewChannel
    });

    updatePlaylistUI();

    // Broadcast playlist update to guests
    const metaList = playlist.map(item => ({
        type: item.type,
        name: item.name || item.title,
        videoId: item.videoId || null,
        playlistId: item.playlistId || null
    }));
    broadcast({ type: 'playlist-update', list: metaList });

    closeYouTubePopup();

    // Clear input for next use
    document.getElementById('youtube-url-input').value = '';
    document.getElementById('youtube-preview').style.display = 'none';
    document.getElementById('youtube-preview-status').style.display = 'block';
    document.getElementById('youtube-preview-status').innerText = '동영상 또는 플레이리스트 링크를 입력하세요';
    document.getElementById('youtube-play-btn').disabled = true;
    document.getElementById('youtube-play-btn').style.opacity = '0.5';

    // If playlist was empty, play immediately. Otherwise just add.
    if (wasEmpty) {
        playTrack(0);
    } else {
        showToast(`"${previewTitle}" 플레이리스트에 추가됨`);
    }
}

function loadYouTubeVideo(videoId, playlistId = null, autoplay = true, subIndex = 0) {
    // Stop local playback completely
    stop();

    // Stop local video element if playing
    const localVideo = document.getElementById('main-video');
    if (localVideo) {
        localVideo.pause();
        localVideo.src = '';
    }

    isYouTubeMode = true;

    // Show toast about audio effects
    showToast("YouTube 같이 보기 - 고급 오디오 효과가 비활성화됩니다");

    // Switch to video mode via class
    document.body.classList.add('mode-video');

    const videoElement = document.getElementById('main-video');
    videoElement.style.display = 'none';

    // Create container for YouTube player
    const wrapper = document.querySelector('.video-wrapper');
    let container = document.getElementById('youtube-player-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'youtube-player-container';
        container.style.cssText = 'width:100%; height:100%; position:relative;';
        wrapper.appendChild(container);
    }
    // container.style.display = 'block'; // New CSS structure handles visibility via body.mode-video

    // ONLY clear and set placeholder if we DON'T have a player yet.
    // Overwriting this with innerHTML kills the current iframe/player.
    if (!youtubePlayer) {
        container.innerHTML = '<div id="youtube-player"></div>';
    }

    // Load YouTube API if not already loaded
    if (!window.YT || !window.YT.Player) {
        if (!window._ytScriptLoading) {
            window._ytScriptLoading = true;
            const tag = document.createElement('script');
            tag.src = 'https://www.youtube.com/iframe_api';
            document.head.appendChild(tag);
        }
        window.onYouTubeIframeAPIReady = () => {
            window.isYouTubeAPIReady = true;
            initYouTubePlayer(videoId, playlistId, autoplay, subIndex);
        };
    } else {
        initYouTubePlayer(videoId, playlistId, autoplay, subIndex);
    }

    // Update track info
    updateTitleWithMarquee('YouTube Video');
    document.getElementById('track-artist').innerText = playlistId ? '플레이리스트 재생 중' : '재생 중';

    // Enable play button for YouTube control
    document.getElementById('play-btn').disabled = false;

    // Hide MUSIXQUARE fullscreen button (YouTube has its own)
    const fsBtn = document.querySelector('.fullscreen-btn');
    if (fsBtn) fsBtn.style.setProperty('display', 'none', 'important');

    // Note: Broadcast is now handled in playTrack() before calling this function
    // to ensure guests get the message immediately

    // FIX: Force a display refresh after a short delay to prevent black screen
    setTimeout(() => refreshYouTubeDisplay(), 500);

    // Update Chat UI for YouTube mode - Temporarily disabled to fix black box issue
    // updateChatYouTube(true); 

    console.log("[YouTube] Loaded:", videoId || playlistId, "autoplay:", autoplay);
}

function initYouTubePlayer(videoId, playlistId = null, autoplay = true, subIndex = 0) {
    // FIX 9: Persistent Player (Re-use existing player to bypass iOS autoplay restrictions)
    if (youtubePlayer && youtubePlayer.loadVideoById) {
        console.log("[YouTube] Re-using existing player instance");
        try {
            if (playlistId) {
                youtubePlayer.loadPlaylist({
                    list: playlistId,
                    listType: 'playlist',
                    index: subIndex,
                    startSeconds: 0
                });
            } else if (videoId) {
                youtubePlayer.loadVideoById(videoId);
            }
            if (!autoplay) youtubePlayer.pauseVideo();
            return; // Exit, we've updated the existing player
        } catch (e) {
            console.warn("[YouTube] Failed to reuse player, recreating...", e);
            // If reuse fails, we MUST recreate the DOM placeholder
            const container = document.getElementById('youtube-player-container');
            if (container) container.innerHTML = '<div id="youtube-player"></div>';
        }
    }

    const playerVars = {
        autoplay: autoplay ? 1 : 0,
        controls: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1  // CRITICAL for iOS in-app playback
    };

    if (playlistId) {
        playerVars.listType = 'playlist';
        playerVars.list = playlistId;
    }

    const playerOptions = {
        width: '100%',
        height: '100%',
        playerVars: playerVars,
        events: {
            'onReady': onYouTubePlayerReady,
            'onStateChange': onYouTubePlayerStateChange
        }
    };

    // ONLY add videoId if it exists to avoid "Invalid Video ID" for playlists
    if (videoId) {
        playerOptions.videoId = videoId;
    }

    youtubePlayer = new YT.Player('youtube-player', playerOptions);
}

function onYouTubePlayerReady(event) {
    console.log("[YouTube] Player ready");

    // Start UI update loop for progress bar
    if (window.youtubeUILoop) clearInterval(window.youtubeUILoop);
    window.youtubeUILoop = setInterval(updateYouTubeUI, 500);

    // Host: Start sync broadcast
    if (!hostConn) {
        if (window.youtubeSyncLoop) clearInterval(window.youtubeSyncLoop);
        window.youtubeSyncLoop = setInterval(broadcastYouTubeSync, 3000);
    }
}

function onYouTubePlayerStateChange(event) {
    // States: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    const state = event.data;

    // FIX 10: iOS Manual Sync (Hide overlay if video begins playing)
    if (state === YT.PlayerState.PLAYING) {
        showYouTubeSyncOverlay(false);
        document.getElementById('icon-play').style.display = 'none';
        document.getElementById('icon-pause').style.display = 'block';
        isPlaying = true;
    } else if (state === YT.PlayerState.PAUSED) {
        document.getElementById('icon-play').style.display = 'block';
        document.getElementById('icon-pause').style.display = 'none';
        isPlaying = false;
    } else if (state === YT.PlayerState.ENDED) {
        isPlaying = false;

        // Auto-play next track in unified playlist
        if (!hostConn) {
            console.log("[YouTube] Ended, playing next track...");
            playNextTrack();
        }
    }

    // Host: Broadcast state change
    if (!hostConn && youtubePlayer && youtubePlayer.getCurrentTime) {
        broadcast({
            type: 'youtube-state',
            state: state,
            time: youtubePlayer.getCurrentTime(),
            subIndex: youtubePlayer.getPlaylistIndex ? youtubePlayer.getPlaylistIndex() : -1
        });
    }
}

function updateYouTubeUI() {
    if (!youtubePlayer || !isYouTubeMode || !youtubePlayer.getCurrentTime) return;

    try {
        const currentTime = youtubePlayer.getCurrentTime();
        const duration = youtubePlayer.getDuration ? youtubePlayer.getDuration() : 0;
        const state = youtubePlayer.getPlayerState ? youtubePlayer.getPlayerState() : -1;

        // FIX 10: iOS Autoplay Watchdog
        // If state is CUED (5) or UNSTARTED (-1) and we're supposed to be playing, 
        // show a manual sync button after a few seconds.
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        if (isIOS && (state === 5 || state === -1)) {
            if (!window._ytIOSWatchdog) window._ytIOSWatchdog = Date.now();
            if (Date.now() - window._ytIOSWatchdog > 3000) {
                showYouTubeSyncOverlay(true);
            }
        } else {
            window._ytIOSWatchdog = null;
        }

        if (duration > 0) {
            document.getElementById('time-curr').innerText = fmtTime(currentTime);
            document.getElementById('time-dur').innerText = fmtTime(duration);

            const slider = document.getElementById('seek-slider');
            slider.max = duration;  // Now using seconds, same as local mode
            slider.value = currentTime;
        }
    } catch (e) {
        // Player not ready yet
    }
}

// Logic for Fix 10: iOS Manual Sync Overlay
function showYouTubeSyncOverlay(show) {
    const overlayId = 'youtube-ios-sync-overlay';
    let overlay = document.getElementById(overlayId);

    if (show) {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = overlayId;
            overlay.style.cssText = `
                position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.6); display: flex; align-items: center;
                justify-content: center; z-index: 100; cursor: pointer;
                backdrop-filter: blur(4px); animation: fadeIn 0.3s ease-out;
            `;
            overlay.onclick = () => {
                if (youtubePlayer && youtubePlayer.playVideo) {
                    youtubePlayer.playVideo();
                    showYouTubeSyncOverlay(false);
                }
            };
            overlay.innerHTML = `
                <div style="background:var(--primary); color:white; padding:12px 24px; border-radius:100px; font-weight:bold; font-size:14px; box-shadow: 0 4px 15px rgba(0,0,0,0.3); display:flex; align-items:center; gap:8px;">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M8 5v14l11-7z"/></svg>
                    TAP TO SYNC VIDEO
                </div>
            `;
            const wrapper = document.querySelector('.video-wrapper');
            if (wrapper) wrapper.appendChild(overlay);
        }
        overlay.style.display = 'flex';
    } else if (overlay) {
        overlay.style.display = 'none';
        window._ytIOSWatchdog = null;
    }
}

function broadcastYouTubeSync() {
    if (!youtubePlayer || hostConn || !youtubePlayer.getCurrentTime) return;

    try {
        const currentTime = youtubePlayer.getCurrentTime();
        const state = youtubePlayer.getPlayerState ? youtubePlayer.getPlayerState() : -1;

        // Update current sub-index for playlists
        if (youtubePlayer.getPlaylistIndex) {
            const sIdx = youtubePlayer.getPlaylistIndex();
            if (sIdx !== currentYouTubeSubIndex) {
                currentYouTubeSubIndex = sIdx;

                // If it's a playlist item, update metadata/titles if needed
                if (playlist[currentTrackIndex] && playlist[currentTrackIndex].playlistId) {
                    const pid = playlist[currentTrackIndex].playlistId;

                    // Populate/Refresh IDs if missing
                    if (youtubePlayer.getPlaylist) {
                        try {
                            const ids = youtubePlayer.getPlaylist();
                            if (ids && ids.length > 0) {
                                if (!youtubeSubItemsMap[pid]) {
                                    youtubeSubItemsMap[pid] = { ids: ids, titles: [] };
                                    if (playlist[currentTrackIndex].isExpanded) fetchPlaylistSubTitles(pid, ids);
                                } else if (!youtubeSubItemsMap[pid].ids || youtubeSubItemsMap[pid].ids.length === 0) {
                                    youtubeSubItemsMap[pid].ids = ids;
                                    if (playlist[currentTrackIndex].isExpanded) fetchPlaylistSubTitles(pid, ids);
                                }
                            }
                        } catch (idsErr) { }
                    }

                    if (youtubeSubItemsMap[pid]) {
                        // Attempt to populate current title if missing
                        if (youtubePlayer.getVideoData) {
                            const vData = youtubePlayer.getVideoData();
                            if (vData && vData.title) {
                                if (youtubeSubItemsMap[pid].titles[sIdx] !== vData.title) {
                                    youtubeSubItemsMap[pid].titles[sIdx] = vData.title;

                                    // BROADCAST THIS TITLE to guests
                                    broadcast({
                                        type: 'youtube-sub-title-update',
                                        playlistId: pid,
                                        subIdx: sIdx,
                                        title: vData.title
                                    });
                                }
                            }
                        }
                    }
                }
                updatePlaylistUI();
                if (playlist[currentTrackIndex]) updateMediaSessionMetadata(playlist[currentTrackIndex]);
            }
        }

        broadcast({
            type: 'youtube-sync',
            time: currentTime,
            state: state,
            subIndex: currentYouTubeSubIndex // Broadcast sub-index to guests
        });
    } catch (e) {
        // Player not ready
    }
}

function handleYouTubeSync(data) {
    if (!youtubePlayer || !isYouTubeMode || !youtubePlayer.getCurrentTime) return;

    try {
        const hostTime = data.time;
        const hostState = data.state;
        const hostSubIndex = data.subIndex;

        // Sync Sub-index (Playlist internal navigation)
        if (hostSubIndex !== undefined && hostSubIndex !== -1 && hostSubIndex !== currentYouTubeSubIndex) {
            console.log(`[YouTube Sync] Sub-index change: ${currentYouTubeSubIndex} -> ${hostSubIndex}`);
            currentYouTubeSubIndex = hostSubIndex;

            // If we have a player, try to sync index
            if (youtubePlayer && youtubePlayer.playVideoAt && youtubePlayer.getPlaylistIndex) {
                if (youtubePlayer.getPlaylistIndex() !== hostSubIndex) {
                    youtubePlayer.playVideoAt(hostSubIndex);
                }
            }

            // Sync guest UI
            if (playlist[currentTrackIndex] && playlist[currentTrackIndex].playlistId) {
                const pid = playlist[currentTrackIndex].playlistId;
                if (!youtubeSubItemsMap[pid] && youtubePlayer && youtubePlayer.getPlaylist) {
                    youtubeSubItemsMap[pid] = { ids: youtubePlayer.getPlaylist(), titles: [] };
                }
                // Try to get current title
                if (youtubePlayer && youtubePlayer.getVideoData) {
                    const vData = youtubePlayer.getVideoData();
                    if (vData && vData.title) {
                        if (!youtubeSubItemsMap[pid]) youtubeSubItemsMap[pid] = { ids: [], titles: [] };
                        youtubeSubItemsMap[pid].titles[hostSubIndex] = vData.title;
                    }
                }
            }
            updatePlaylistUI();
            if (playlist[currentTrackIndex]) updateMediaSessionMetadata(playlist[currentTrackIndex]);
        }

        // Apply sync offsets (Auto + Manual)
        const compensatedTime = hostTime + autoSyncOffset + localOffset;

        const currentTime = youtubePlayer.getCurrentTime();
        const drift = Math.abs(currentTime - compensatedTime);

        // If drift > 2 seconds, seek to sync
        if (drift > 2 && youtubePlayer.seekTo) {
            console.log(`[YouTube Sync] Drift ${drift.toFixed(1)}s, seeking to ${compensatedTime.toFixed(1)}s`);
            youtubePlayer.seekTo(compensatedTime, true);
        }

        // Sync play/pause state
        if (youtubePlayer.getPlayerState && youtubePlayer.playVideo && youtubePlayer.pauseVideo) {
            const currentState = youtubePlayer.getPlayerState();
            if (hostState === 1 && currentState !== 1) {
                youtubePlayer.playVideo();
            } else if (hostState === 2 && currentState !== 2) {
                youtubePlayer.pauseVideo();
            }
        }
    } catch (e) {
        console.error("[YouTube Sync] Error:", e);
    }
}

function refreshYouTubeDisplay() {
    const container = document.getElementById('youtube-player-container');
    if (!container || !isYouTubeMode) return;

    console.log("[YouTube] Refreshing display to prevent black screen...");
    const iframe = container.querySelector('iframe');

    // 1. Force a layout reflow
    container.style.display = 'none';
    container.offsetHeight;
    container.style.display = 'block';

    // 2. Nudge the iframe visibility if it exists
    if (iframe) {
        iframe.style.visibility = 'hidden';
        iframe.offsetHeight;
        iframe.style.visibility = 'visible';
    }

    // 3. Dispatch a global resize event to nudge YouTube's internal layout
    window.dispatchEvent(new Event('resize'));
}

function handleYouTubeSubTitleUpdate(data) {
    const { playlistId, subIdx, title } = data;
    if (!youtubeSubItemsMap[playlistId]) {
        youtubeSubItemsMap[playlistId] = { ids: [], titles: [] };
    }
    youtubeSubItemsMap[playlistId].titles[subIdx] = title;
    updatePlaylistUI();

    // Update metadata if this is the currently playing video
    if (playlist[currentTrackIndex] && playlist[currentTrackIndex].playlistId === playlistId && currentYouTubeSubIndex === subIdx) {
        updateMediaSessionMetadata(playlist[currentTrackIndex]);
    }
}

function stopYouTubeMode() {
    isYouTubeMode = false;

    // Stop sync loops
    if (window.youtubeUILoop) clearInterval(window.youtubeUILoop);
    if (window.youtubeSyncLoop) clearInterval(window.youtubeSyncLoop);

    // Destroy player
    if (youtubePlayer) {
        try { youtubePlayer.destroy(); } catch (e) { }
        youtubePlayer = null;
    }

    // [FIX #5] Clean up container contents (avoid remove() to preserve structure)
    const container = document.getElementById('youtube-player-container');
    if (container) {
        container.innerHTML = ''; // Clear iframes to prevent DOM leak
    }

    // Restore UI visibility via class
    document.body.classList.remove('mode-video');

    // Also reset main-video
    const videoElement = document.getElementById('main-video');
    if (videoElement) {
        videoElement.pause();
        videoElement.src = '';
        videoElement.style.display = 'none';
    }

    // Show fullscreen button again
    const fsBtn = document.querySelector('.fullscreen-btn');
    if (fsBtn) {
        fsBtn.style.removeProperty('display');
        fsBtn.style.display = '';
    }

    // Clean up Chat tab YouTube
    updateChatYouTube(false);

    console.log("[YouTube] Mode stopped, visualizer restored");
    updatePlaylistUI();

    // Restore track title for current local file (if any)
    if (currentTrackIndex >= 0 && playlist[currentTrackIndex]) {
        const item = playlist[currentTrackIndex];
        if (item.type !== 'youtube') {
            const displayName = item.file?.name || item.name || 'Unknown';
            updateTitleWithMarquee(displayName);
            document.getElementById('track-artist').innerText = `Track ${currentTrackIndex + 1}`;
        }
    }
}

// Expose popup functions
window.openMediaSourcePopup = openMediaSourcePopup;
window.closeMediaSourcePopup = closeMediaSourcePopup;
window.openYouTubePopup = openYouTubePopup;
window.closeYouTubePopup = closeYouTubePopup;
window.loadYouTubeFromInput = loadYouTubeFromInput;

// ============================================
// YOUTUBE URL PREVIEW (oEmbed API)
// ============================================

let youtubePreviewDebounce = null;

function fetchYouTubePreview(url) {
    const previewContainer = document.getElementById('youtube-preview');
    const statusText = document.getElementById('youtube-preview-status');
    const playBtn = document.getElementById('youtube-play-btn');

    // Helper to enable/disable play button
    const setPlayBtnEnabled = (enabled) => {
        playBtn.disabled = !enabled;
        playBtn.style.opacity = enabled ? '1' : '0.5';
    };

    // Clear previous debounce
    if (youtubePreviewDebounce) clearTimeout(youtubePreviewDebounce);

    // Reset if empty
    if (!url || url.trim() === '') {
        previewContainer.style.display = 'none';
        statusText.style.display = 'block';
        statusText.innerText = '동영상 또는 플레이리스트 링크를 입력하세요';
        statusText.style.color = 'var(--text-sub)';
        setPlayBtnEnabled(false);
        return;
    }

    // Check if valid YouTube URL
    const videoId = extractYouTubeVideoId(url);
    const playlistId = extractYouTubePlaylistId(url);

    if (!videoId && !playlistId) {
        previewContainer.style.display = 'none';
        statusText.style.display = 'block';
        statusText.innerText = '유효한 YouTube 링크가 아닙니다';
        statusText.style.color = '#ef4444';
        setPlayBtnEnabled(false);
        return;
    }

    // Show loading state
    statusText.style.display = 'block';
    statusText.innerText = '영상 정보 불러오는 중...';
    statusText.style.color = 'var(--text-sub)';
    setPlayBtnEnabled(false);

    // Debounce API call
    youtubePreviewDebounce = setTimeout(async () => {
        try {
            // Use oEmbed API (no API key needed)
            const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
            const response = await fetch(oembedUrl);

            if (!response.ok) {
                throw new Error('Video not found');
            }

            const data = await response.json();

            // Update preview
            document.getElementById('youtube-preview-thumb').src = data.thumbnail_url;
            document.getElementById('youtube-preview-title').innerText = data.title;
            document.getElementById('youtube-preview-channel').innerText = data.author_name;

            // Show preview, hide status
            previewContainer.style.display = 'block';
            statusText.style.display = 'none';

            // Enable play button ?
            setPlayBtnEnabled(true);

        } catch (e) {
            console.error('[YouTube Preview] Error:', e);
            previewContainer.style.display = 'none';
            statusText.style.display = 'block';
            statusText.innerText = '영상 정보를 불러올 수 없습니다';
            statusText.style.color = '#ef4444';
            setPlayBtnEnabled(false);
        }
    }, 500); // 500ms debounce
}

window.fetchYouTubePreview = fetchYouTubePreview;

// ============================================
// YOUTUBE UI CONTROL (Seek Slider + Skip)
// ============================================

// Seek slider control for YouTube
document.getElementById('seek-slider').addEventListener('input', function () {
    if (isYouTubeMode && youtubePlayer) {
        try {
            const seekTime = parseFloat(this.value);  // this.value is already in seconds
            youtubePlayer.seekTo(seekTime, true);

            // Broadcast seek to guests
            if (!hostConn) {
                broadcast({ type: 'youtube-sync', time: seekTime, state: youtubePlayer.getPlayerState() });
            }
        } catch (e) {
            console.error("[YouTube] Seek error:", e);
        }
    }
});

// Override skipTime for YouTube support
const originalSkipTime = window.skipTime;
window.skipTime = function (seconds) {
    if (isYouTubeMode && youtubePlayer) {
        try {
            const currentTime = youtubePlayer.getCurrentTime();
            const newTime = Math.max(0, currentTime + seconds);
            youtubePlayer.seekTo(newTime, true);

            // Broadcast to guests
            if (!hostConn) {
                broadcast({ type: 'youtube-sync', time: newTime, state: youtubePlayer.getPlayerState() });
            }
        } catch (e) {
            console.error("[YouTube] Skip error:", e);
        }
        return;
    }

    // Original skipTime for local media
    if (originalSkipTime) originalSkipTime(seconds);
};

