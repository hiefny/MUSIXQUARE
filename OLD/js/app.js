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
let localOffset = 0;

let connectedPeers = [];
let isOperator = false;

// Beta Relay State
let upstreamDataConn = null; // Connection to receive file chunks from (Host or Relay info)
let downstreamDataPeers = []; // Peers I need to forward file chunks to
const MAX_DIRECT_DATA_PEERS = 2; // Host sends data to max 2 people directly
let chunkWatchdog = null;
let lastChunkTime = 0;
let currentFileBlob = null; // Cache for serving late joiners


// Playlist State
let playlist = [];
let currentTrackIndex = -1;
let repeatMode = 0;
let isShuffle = false;

// Video State
let isVideoMode = false;
const videoElement = document.getElementById('main-video');


// Preload State
let nextTrackIndex = -1;
let nextBuffer = null;
let nextFileBlob = null;
let isPreloading = false;
let nextMeta = null; // Store metadata for preloaded file

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
    const tabs = ['play', 'playlist', 'connect', 'settings', 'help'];
    const idx = tabs.indexOf(tabId);
    if (idx >= 0) document.querySelectorAll('.nav-item')[idx].classList.add('active');
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
    analyser.smoothing = 0.9;
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

// Auto-run init
document.addEventListener('DOMContentLoaded', initOnboarding);

// --- Playlist & Player Logic ---
document.getElementById('file-input').addEventListener('change', async (e) => {
    if (hostConn) return showToast("Host만 파일을 추가할 수 있습니다.");

    // Initialize AudioContext immediately on user gesture
    try {
        if (Tone.context.state !== 'running') await Tone.start();
        await initAudio();
    } catch (err) { console.error(err); }

    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    files.forEach(f => playlist.push(f));
    updatePlaylistUI();

    const metaList = playlist.map(f => ({ name: f.name }));
    broadcast({ type: 'playlist-update', list: metaList });

    if (currentTrackIndex === -1) {
        playTrack(0);
    } else {
        showToast(`${files.length}곡 추가됨`);
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
        const li = document.createElement('li');
        li.className = `track-item ${idx === currentTrackIndex ? 'active' : ''}`;
        li.onclick = () => { if (!hostConn) playTrack(idx); };
        li.innerHTML = `
                <div class="track-idx">${idx + 1}</div>
                <div class="track-name">${item.name}</div>
                <svg class="playing-icon" viewBox="0 0 24 24"><path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.16-1.75 4.45-4H15V6h4V3h-7z"/></svg>
            `;
        ul.appendChild(li);
    });
}

async function playTrack(index) {
    if (index < 0 || index >= playlist.length) return;

    // Check if this track is already preloaded (Host Side Check)
    if (index === nextTrackIndex && (nextBuffer || nextFileBlob) && !hostConn) {
        console.log("[Host] Using Preloaded Track:", index);
        currentTrackIndex = index;
        updatePlaylistUI();

        // 1. Host Switches Locally Fast
        await loadPreloadedTrack();

        // 2. Broadcast Command to Guests
        // Guests should already have the file.
        broadcast({ type: 'play-preloaded', index: index });

        // 3. Start Playback
        // Give guests a tiny moment to switch buffers? usually 100-200ms is enough
        // But play(0) broadcasts a future timestamp, so it's fine.
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

    const file = playlist[index];
    if (!hostConn) {
        // Standard Load
        broadcast({ type: 'file-prepare', name: file.name, index: index });
        await loadAndBroadcastFile(file);

        // After loading current, start preloading next
        // preloadNextTrack is already called inside loadAndBroadcastFile (line 773)
        // so we don't need to call it here.

        // AUTO PLAY with 3s Delay (User Request)
        showToast("3초 후 재생 시작...");
        setTimeout(() => {
            play(0);
            broadcast({ type: 'play', time: 0 });
        }, 3000);
    }
}

async function preloadNextTrack() {
    if (playlist.length <= 1) return;

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
    const file = playlist[nextIdx];

    console.log("Starting Preload for:", file.name);
    isPreloading = true;

    // 1. Host Loads Locally (Background)
    // We don't want to decode yet if using AudioBuffer to save RAM? 
    // Actually decoding 2 tracks is fine.
    // But for Video/Large file, we just hold the Blob.

    // 2. Broadcast Preload
    // Special function to broadcast without stopping playback
    await broadcastPreloadFile(file, nextIdx);
    isPreloading = false;
}

// New: Broadcast for Background Preloading
async function broadcastPreloadFile(file, index) {
    if (file.type.startsWith('video/') && !hostConn) {
        // Host Logic for Video: Extract Audio -> Broadcast WAV (Background)
        try {
            const wavFile = await extractAudioToWav(file);
            console.log("[Preload] Audio Extracted:", wavFile.name);
            await backgroundTransfer(wavFile, index);
        } catch (e) {
            console.error("Preload Extraction Failed", e);
            await backgroundTransfer(file, index);
        }
    } else {
        await backgroundTransfer(file, index);
    }
}

// Transfer without UI blocking
async function backgroundTransfer(file, index) {
    const CHUNK = 16384;
    const total = Math.ceil(file.size / CHUNK);
    const header = {
        type: 'preload-start',
        name: file.name,
        mime: file.type,
        total: total,
        size: file.size,
        index: index
    };

    broadcast(header);

    for (let i = 0; i < total; i++) {
        // Heavy throttling to prevent affecting current playback audio (Jitter)
        // Wait if buffer is full

        // Flow Control (Aggressive for Background)
        let congested = true;
        while (congested) {
            congested = false;
            for (const p of connectedPeers) {
                if (p.status === 'connected' && p.conn.open && p.isDataTarget !== false) {
                    if (p.conn.dataChannel.bufferedAmount > 1 * 1024 * 1024) { // 1MB limit (Lower than main)
                        congested = true;
                        break;
                    }
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
        broadcast(chunkMsg);

        // Slow down sending to save CPU/Network for playback
        if (i % 10 === 0) await new Promise(r => setTimeout(r, 20));
    }

    broadcast({ type: 'preload-end', name: file.name, index: index });
    console.log("Preload Complete for index:", index);
}


function playNextTrack() {
    // If we have a preloaded track ready, play it directly
    if (nextTrackIndex !== -1 && !hostConn) {
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
    if (Tone.context && Tone.now() - startedAt > 3) {
        play(0); // Restart current
        return;
    }
    if (currentTrackIndex > 0) playTrack(currentTrackIndex - 1);
    else playTrack(0);
}

// Track ObjectURL for cleanup (prevents memory leak)
let currentMediaObjectURL = null;

async function loadAndBroadcastFile(file) {
    showLoader(true, `준비 중: ${file.name}`);
    stop();

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
            document.getElementById('track-title').innerText = file.name;
            document.getElementById('track-artist').innerText = `Track ${currentTrackIndex + 1}`;

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

            document.getElementById('track-title').innerText = file.name;
            document.getElementById('track-artist').innerText = `Track ${currentTrackIndex + 1}`;
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
        showToast(`Load Failed: ${err.message}`);
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
        // Helper to switch to preloaded track
        async function loadPreloadedTrack() {
            console.log("Switching to Preloaded Track...");
            stop();

            // Swap Buffers
            if (nextBuffer) {
                buffer = nextBuffer;
                isVideoMode = false;
                document.body.classList.remove('mode-video');
                videoElement.style.display = 'none';

                document.getElementById('seek-slider').max = buffer.duration;
                document.getElementById('seek-slider').value = 0;
                document.getElementById('time-dur').innerText = fmtTime(buffer.duration);
            } else if (nextFileBlob) {
                // It was a large file/video cached as blob
                // Determine mode again
                const file = nextFileBlob; // Blob
                // ... (Similar decode logic as loadAndBroadcastFile)
                // Simplified:
                const url = URL.createObjectURL(file);

                // Re-check large file logic or just assume streaming if blob is here?
                // Let's assume functionality matches 'loadAndBroadcastFile' logic

                let isLargeFile = file.size > 100 * 1024 * 1024;
                // Metadata check is tricky on Blob, rely on stored?
                // For now, treat as Large if it was preloaded as blob

                if (isLargeFile || (nextMeta && nextMeta.mime.startsWith('video/'))) {
                    isVideoMode = true;
                    document.body.classList.add('mode-video');
                    videoElement.style.display = 'block';
                    videoElement.src = url;
                    setupMediaSource();
                    // Wait for metadata
                    await new Promise(r => {
                        videoElement.onloadedmetadata = () => {
                            document.getElementById('seek-slider').max = videoElement.duration;
                            document.getElementById('time-dur').innerText = fmtTime(videoElement.duration);
                            r();
                        };
                    });
                    videoElement.load();
                } else {
                    // Decode
                    const tempBuffer = new Tone.Buffer();
                    await tempBuffer.load(url);
                    buffer = tempBuffer;
                    isVideoMode = false;
                    document.body.classList.remove('mode-video');
                    videoElement.style.display = 'none';
                    document.getElementById('seek-slider').max = buffer.duration;
                    document.getElementById('time-dur').innerText = fmtTime(buffer.duration);
                }
            }

            // Update UI Titles
            if (currentTrackIndex !== -1 && playlist[currentTrackIndex]) {
                document.getElementById('track-title').innerText = playlist[currentTrackIndex].name;
                document.getElementById('track-artist').innerText = `Track ${currentTrackIndex + 1}`;
            }

            // Clear Preload
            nextBuffer = null;
            nextFileBlob = null;
            nextMeta = null;
            nextTrackIndex = -1;
        }

        // Ensure first play triggers preload
        // Modifying loadAndBroadcastFile to trigger preload at end

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
    if (Tone.context.state !== 'running') {
        try { await Tone.context.resume(); } catch (e) { console.warn("Resume failed:", e); }
    }

    if (!buffer && !isVideoMode) return;
    initAudio();

    if (player.state === 'started') player.stop();

    if (buffer) {
        // --- BUFFER MODE ---
        // Ensure Buffer is Ready
        if (!buffer.loaded) {
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
    if (buffer && player && player.state === 'started') {
        curr = Tone.now() - startedAt;
    } else if (isVideoMode && videoElement) {
        curr = videoElement.currentTime;
    }

    // Safety: Clamp current time to duration to prevent runaway values
    if (curr > duration) {
        curr = duration;
    }

    // Check if we are near end
    if (isPlaying && (curr >= duration - 0.5)) {
        console.log(`Track ended at ${curr.toFixed(2)}s / ${duration.toFixed(2)}s`);
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
            console.log("Auto-advancing to next track...");
            setTimeout(() => playNextTrack(), 500);
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
    if (!buffer && !isVideoMode) return;
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
    if (!buffer && !isVideoMode) return;

    let current = isPlaying ? (Tone.now() - startedAt) : pausedAt;
    if (isVideoMode && !buffer) current = videoElement.currentTime;

    let target = current + sec;
    const duration = buffer ? buffer.duration : (videoElement ? videoElement.duration : 0);

    if (target < 0) target = 0;
    if (target > duration) target = duration;

    // Broadcast or Request
    if (!hostConn) {
        play(target);
        broadcast({ type: 'play', time: target });
    } else if (isOperator) {
        hostConn.send({ type: 'request-play', time: target });
    }
}

function updatePlayState(playing) {
    document.getElementById('icon-play').style.display = playing ? 'none' : 'block';
    document.getElementById('icon-pause').style.display = playing ? 'block' : 'none';
}

function adjustSync(val) {
    localOffset += val;
    showToast(`Sync: ${val > 0 ? '+' : ''}${val.toFixed(2)}s`);
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

        showToast(`Mode: Subwoofer (${subFreq}Hz)`);
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
            if (onclickVal && onclickVal.includes(`(${idx},`)) {
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
    document.getElementById(`rvb-${type}`).classList.add('active');

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

    const label = document.getElementById(`eq-val-${bandIdx}`);
    if (label) label.innerText = bandVal > 0 ? `+${bandVal}` : bandVal;

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
                // Map -100dB ~ -30dB to 0 ~ 255 roughly
                let val = (dbData[i] + 100) * 3;
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

        // Bass
        let bassSum = 0;
        let bassCount = 10;
        // Safety check for array bounds
        if (bassCount > bufferLength) bassCount = bufferLength;
        for (let i = 0; i < bassCount; i++) { bassSum += dataArray[i]; }
        const bassAverage = bassSum / bassCount;
        const bassPunch = Math.pow(bassAverage / 255, 3.0);

        // High
        let highSum = 0;
        const highStart = Math.floor(bufferLength * 0.7);
        const highEnd = Math.floor(bufferLength * 0.95);
        let highCountVal = highEnd - highStart;
        if (highCountVal < 1) highCountVal = 1;

        for (let i = highStart; i < highEnd; i++) { highSum += dataArray[i]; }
        const highAverage = highSum / highCountVal;
        const highPunch = Math.pow(highAverage / 255, 1.5);

        if (isLight) ctx.globalCompositeOperation = 'source-over';
        else ctx.globalCompositeOperation = 'lighter';

        ctx.shadowBlur = 0;
        ctx.lineWidth = 0;

        const centerX = logicalSize / 2;
        const centerY = logicalSize / 2;

        // Circle 1: Bass
        const bassRadius = 40 + (bassPunch * 80);
        const bassLightness = 20 + (bassPunch * 60);

        if (isLight) ctx.fillStyle = `rgba(59, 130, 246, 0.6)`;
        else ctx.fillStyle = `hsla(217, 91%, ${bassLightness + 40}%, 0.4)`;

        ctx.beginPath();
        ctx.arc(centerX, centerY, bassRadius, 0, 2 * Math.PI);
        ctx.fill();

        // Circle 2: High
        const highRadius = 30 + (highPunch * 100);
        const highLightness = 40 + (highPunch * 60);

        if (isLight) {
            ctx.fillStyle = `rgba(96, 165, 250, 0.6)`;
        } else {
            ctx.fillStyle = `hsla(217, 100%, ${highLightness + 30}%, 0.4)`;
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
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

// --- Seek & Interactions ---
const slider = document.getElementById('seek-slider');
slider.addEventListener('mousedown', () => isSeeking = true);
slider.addEventListener('touchstart', () => isSeeking = true);
slider.addEventListener('input', () => document.getElementById('time-curr').innerText = fmtTime(slider.value));
slider.addEventListener('change', () => {
    isSeeking = false;
    const t = parseFloat(slider.value);
    if (isPlaying) play(t); else pausedAt = t;
    if (!hostConn) broadcast({ type: 'play', time: t });
});

// --- Sync Button Logic ---
function handleMainSyncBtn() {
    console.log("Sync Btn Clicked. HostConn:", !!hostConn, "Playing:", isPlaying);
    if (!hostConn) {
        // Host: Trigger Guest-side Sync (More accurate Latency Comp)
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
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg> AUTO SYNC`;
}

// --- Networking (Updated from network.html) ---
const peerOpts = {
    debug: 2, // Enhanced logging to debug connection issues
    config: {
        iceServers: [
            // 1. Google Public STUN (High reliability fallback)
            { urls: "stun:stun.l.google.com:19302" },

            // 2. Metered TURN (Standard Relay - Provided by User)
            {
                urls: "stun:stun.relay.metered.ca:80",
            },
            {
                urls: "turn:standard.relay.metered.ca:443",
                username: "a40cdd09e54bb04f0c932251",
                credential: "h0CUiIE7cwbMHFa7",
            },
            {
                urls: "turn:standard.relay.metered.ca:443?transport=tcp",
                username: "a40cdd09e54bb04f0c932251",
                credential: "h0CUiIE7cwbMHFa7",
            },
            {
                urls: "turns:standard.relay.metered.ca:443?transport=tcp",
                username: "a40cdd09e54bb04f0c932251",
                credential: "h0CUiIE7cwbMHFa7",
            },
            {
                urls: "turn:standard.relay.metered.ca:80",
                username: "a40cdd09e54bb04f0c932251",
                credential: "h0CUiIE7cwbMHFa7",
            },
            {
                urls: "turn:standard.relay.metered.ca:80?transport=tcp",
                username: "a40cdd09e54bb04f0c932251",
                credential: "h0CUiIE7cwbMHFa7",
            }
        ],
        bundlePolicy: 'max-bundle',
        sdpSemantics: 'unified-plan',
        iceTransportPolicy: 'all',
        iceCandidatePoolSize: 10 // Pre-fetch candidates for faster connection
    }
};

peer = new Peer(null, peerOpts);

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
                        showToast(`${p.label} 제거됨 (무응답)`);
                    }
                }
            });

            // 2. Boldly Remove Disconnected Peers
            if (changed) {
                // FORCE UPDATE: Reassign global array
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

    const deviceName = `DEVICE ${connectedPeers.length + 1}`;
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
                    showToast(`Data Relay: ${deviceName} -> ${candidate.label}`);

                    // Do NOT send data directly from Host to this new peer
                    peerObj.isDataTarget = false;
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
        // -----------------------------

        conn.send({ type: 'welcome', label: deviceName });
        conn.send({ type: 'volume', value: masterVolume });
        conn.send({ type: 'reverb', value: reverbMix * 100 });
        conn.send({ type: 'playlist-update', list: playlist.map(f => ({ name: f.name })) });

        broadcastDeviceList();

        if (currentTrackIndex !== -1 && playlist[currentTrackIndex]) {
            // ALWAYS send 'file-prepare' so Guest UI is updated (Loader/Title) immediately
            conn.send({ type: 'file-prepare', name: playlist[currentTrackIndex].name, index: currentTrackIndex });

            // Only send actual data if they are a direct data target
            // (If they are relayed, the relay should technically sync them, but for now 
            // the relay logic handles 'live' chunks. Late join during playback might need catchup logic.
            // For Beta, we'll let 'broadcastFile' handle new files. 
            // If playing mid-file, they might miss out until next track or manual restart. 
            // Simplification: If direct, send. If relay, wait for next msg.)
            if (peerObj.isDataTarget) {
                unicastFile(conn, playlist[currentTrackIndex]);
            }
        }
    });

    conn.on('data', data => {
        if (data.type === 'heartbeat' || data.type === 'heartbeat-ack') {
            peerObj.lastHeartbeat = Date.now();
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
        // Auto-Recovery Request
        else if (data.type === 'request-data-recovery') {
            const fileName = data.fileName;
            const nextChunk = data.nextChunk;
            const file = playlist.find(f => f.name === fileName);
            if (file) {
                showToast(`Recovering ${peerObj.label}: chunk ${nextChunk}`);
                unicastFile(conn, file, nextChunk);
            }
        }
    });

    conn.on('close', () => {
        peerObj.status = 'disconnected';
        broadcastDeviceList();
        showToast(`${deviceName} 연결 끊김`);
    });
    conn.on('error', () => {
        peerObj.status = 'disconnected';
        broadcastDeviceList();
    });
});

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
        showToast(`재연결 시도 중... (${retryAttempt}/${MAX_CONNECTION_RETRIES})`);
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

        showToast("Host 연결됨!");
        document.getElementById('role-badge').classList.add('connected');
        updateSyncBtnState(true);

        updateQrCode(hostId);
        document.getElementById('host-panel').classList.add('visible');

        // Volunteer Heartbeat: Send to Host every 5s (Worker)
        timerWorker.postMessage({ command: 'START_TIMER', id: 'heartbeat', interval: 5000 });

        // Latency Ping (2s) (Worker)
        timerWorker.postMessage({ command: 'START_TIMER', id: 'ping', interval: 2000 });

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
            <button onclick="location.reload()" style="
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
// Preload Incoming State
let preloadChunks = [], preloadMeta = {}, preloadCount = 0;
let lastProgressAck = 0;
let myDeviceLabel = 'GUEST'; // Store my label for UI updates
let lastLatencyMs = 0; // Store Median RTT (Robust)
let latencyHistory = []; // Buffer to filter noise
let syncRequestTime = 0; // Capture exact time of sync request
let autoSyncOffset = 0; // NEW: Store the Auto-Sync (Latency) Offset in Seconds

// Helper: Clear all previous track state to prevent data mixing
function clearPreviousTrackState(reason = '') {
    console.log(`[State Clear] Clearing previous track state. Reason: ${reason}`);

    // Stop chunk watchdog if running
    if (chunkWatchdog) {
        clearInterval(chunkWatchdog);
        chunkWatchdog = null;
    }

    // Clear incoming file state
    incomingChunks = [];
    receivedCount = 0;
    meta = {};

    // Clear cached blob (CRITICAL: prevents serving stale data to late joiners)
    currentFileBlob = null;

    // Reset skip flag
    window._skipIncomingFile = false;

    // Note: We do NOT clear preload state here (nextFileBlob, preloadChunks, etc.)
    // Those are intentionally preserved for upcoming track switch
}


async function handleData(data) {
    if (data.type === 'heartbeat') {
        if (hostConn && hostConn.open) hostConn.send({ type: 'heartbeat-ack' });
        return;
    }

    // [Latency UI Update & Calculation]
    if (data.type === 'pong-latency') {
        const ms = Date.now() - data.timestamp;

        // Add to history (Max 10 samples ~ approx 20 sec window)
        // We use MINIMUM value to filter out 'fake pings' caused by heavy JS/Redraw blocking.
        latencyHistory.push(ms);
        if (latencyHistory.length > 10) latencyHistory.shift();

        // Use Minimum
        lastLatencyMs = Math.min(...latencyHistory);

        const roleText = document.getElementById('role-text');
        // Update ONLY if we are logged in as a device
        if (roleText && myDeviceLabel !== 'GUEST' && myDeviceLabel !== 'HOST') {
            roleText.innerText = `${myDeviceLabel} (${Math.round(lastLatencyMs)}ms)`;
        }
        return;
    }

    if (data.type === 'welcome') {
        document.getElementById('role-text').innerText = data.label;
    }
    else if (data.type === 'file-prepare') {
        // Check if we already have this track preloaded!
        // Match by index OR by filename
        const hasPreloadedByIndex = nextMeta && data.index !== undefined && data.index === nextMeta.index;
        const hasPreloadedByName = nextMeta && data.name && data.name === nextMeta.name;

        if (nextFileBlob && (hasPreloadedByIndex || hasPreloadedByName)) {
            console.log("[Guest] 🎉 Using preloaded track instead of re-downloading:", data.name);
            showToast("프리로드된 파일 사용!");

            stop();
            currentTrackIndex = data.index !== undefined ? data.index : currentTrackIndex;
            updatePlaylistUI();

            // Use preloaded file directly
            await loadPreloadedTrack();

            // Mark that we're skipping incoming file transfer
            window._skipIncomingFile = true;
            return;
        }

        // Normal flow: No preload available, prepare for download
        window._skipIncomingFile = false;

        // Clear previous track state before receiving new file
        clearPreviousTrackState('file-prepare (new download)');

        showLoader(true, `준비 중: ${data.name}`);
        stop();
        if (data.index !== undefined) {
            currentTrackIndex = data.index;
            updatePlaylistUI();
        }
    }
    else if (data.type === 'file-start') {
        // Skip if we're using preloaded file
        if (window._skipIncomingFile) {
            console.log("[Guest] Skipping file-start (using preloaded)");
            return;
        }

        const sourceLabel = upstreamDataConn ? `Relay(${upstreamDataConn.peer.substr(-4)})` : "Host";
        showToast(`${sourceLabel}로부터 파일 수신 시작`);

        let sizeText = "";
        if (data.size) {
            sizeText = ` (${(data.size / 1024 / 1024).toFixed(1)}MB)`;
        }
        showLoader(true, `${sourceLabel} 수신 중... 0%${sizeText}`);
        // Allocate fixed size array to support out-of-order delivery
        incomingChunks = new Array(data.total);
        receivedCount = 0;
        meta = data;
        document.getElementById('track-title').innerText = data.name;

        // Watchdog Start
        if (chunkWatchdog) clearInterval(chunkWatchdog);
        lastChunkTime = Date.now();
        chunkWatchdog = setInterval(() => {
            const timeSinceLast = Date.now() - lastChunkTime;
            const isMetaInvalid = !meta || !meta.total;

            if (timeSinceLast > 5000 || (incomingChunks.length > 0 && isMetaInvalid)) {
                // Timeout or Invalid State!
                clearInterval(chunkWatchdog);
                showToast("데이터 수신 불안정. Host 복구 요청...");

                // Detach bad relay info if present (so we show 'Host' in UI next time)
                if (upstreamDataConn) upstreamDataConn = null;

                if (hostConn && hostConn.open) {
                    hostConn.send({
                        type: 'request-data-recovery',
                        nextChunk: incomingChunks.length,
                        fileName: meta ? meta.name : 'unknown'
                    });
                }
            }
        }, 1000);

        // RELAY LOGIC: Forward 'file-start' header to downstream
        // Also send to any peers that were waiting for data
        if (downstreamDataPeers.length > 0) {
            downstreamDataPeers.forEach(p => {
                if (p.open) {
                    // If this peer was waiting for file-start, send prepare first
                    if (p._waitingForFileStart) {
                        console.log("[Relay] Sending delayed file-start to waiting peer");
                        p.send({ type: 'file-prepare', name: data.name, index: currentTrackIndex });
                        p._waitingForFileStart = false;
                    }
                    p.send(data);
                }
            });
        }
    }
    else if (data.type === 'file-chunk') {
        // Skip if we're using preloaded file
        if (window._skipIncomingFile) {
            return; // Silently ignore chunks when using preload
        }

        // CRITICAL: Clone the chunk! The underlying buffer might be reused or detached by PeerJS.
        const chunkCopy = new Uint8Array(data.chunk);

        // INDEX-BASED REASSEMBLY (Fixes Data Corruption)
        const idx = data.index;
        // Verify index is valid and we haven't received it yet
        if (idx >= 0 && idx < incomingChunks.length && !incomingChunks[idx]) {
            incomingChunks[idx] = chunkCopy;
            receivedCount++;
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

        if (receivedCount === meta.total) {
            // CRITICAL: Filter out undefined/null chunks before creating Blob
            // This can happen if relay sent data with gaps
            const validChunks = incomingChunks.filter(chunk => chunk !== undefined && chunk !== null);

            if (validChunks.length !== meta.total) {
                console.error(`[ERROR] Chunk count mismatch: expected ${meta.total}, got ${validChunks.length} valid chunks`);
                showToast("파일 수신 불완전 - 재전송 요청");
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
                handleMainSyncBtn();

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

                    // Auto-Sync after load
                    handleMainSyncBtn();

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
    else if (data.type === 'play') {
        // Check if we're still downloading a file (loader visible means download in progress)
        const loaderVisible = document.getElementById('loader')?.classList.contains('visible');
        const isDownloading = loaderVisible || window._waitingForRelayData;

        if (isDownloading) {
            // Queue the play command for after download completes
            console.log("[Guest] Play command received but still downloading, queuing...");
            showToast("다운로드 완료 후 재생됩니다");
            window._pendingPlayTime = data.time;
            return; // Don't play old track!
        }

        const target = data.time + localOffset;
        if (!isPlaying || Math.abs((Tone.now() - startedAt) - target) > 0.15) play(target);

        if (hostConn && hostConn.open) {
            if (window.syncTimer) clearTimeout(window.syncTimer);
            window.syncTimer = setTimeout(() => {
                syncRequestTime = Date.now(); // Record start time
                hostConn.send({ type: 'get-sync-time' });
            }, 500);
        }
    }
    else if (data.type === 'pause') pause();
    else if (data.type === 'volume') { setVolume(data.value); showToast(`Volume: ${Math.round(data.value * 100)}%`); }
    else if (data.type === 'reverb') { setReverb(data.value); }
    else if (data.type === 'reverb-type') { setReverbType(data.value); }
    else if (data.type === 'reverb-decay') { setReverbDecay(data.value); }
    else if (data.type === 'reverb-predelay') { setReverbPreDelay(data.value); }
    else if (data.type === 'reverb-lowcut') { setReverbLowCut(data.value); }
    else if (data.type === 'reverb-highcut') { setReverbHighCut(data.value); }
    else if (data.type === 'eq-update') {
        // Guest receives EQ update. 
        // We set directly to nodes and UI without rebroadcasting (setEQ logic handles checks usually, 
        // but here we used !hostConn check in setEQ which is perfect. Guests have hostConn, won't broadcast.)
        // but here we used !hostConn check in setEQ which is perfect. Guests have hostConn, won't broadcast.)
        setEQ(data.band, data.value, false, true); // true = fromSync
    }
    else if (data.type === 'preamp') { setPreamp(data.value, false, true); }
    else if (data.type === 'eq-reset') { resetEQ(true); }
    else if (data.type === 'stereo-width') { setStereoWidth(data.value); }
    else if (data.type === 'vbass') { setVirtualBass(data.value); }
    else if (data.type === 'playlist-update') {
        playlist = data.list;
        updatePlaylistUI();
    }
    else if (data.type === 'sync-response') {
        // [Latency Compensation]
        // data.time is when Host SENT the message.
        // It took roughly (lastLatencyMs / 2) ms to get here.
        // So we should be ahead by that amount estimate.
        const oneWayLatencySeconds = (lastLatencyMs / 2) / 1000;
        autoSyncOffset = oneWayLatencySeconds; // Store for UI

        // compensatedTime = HostCurrentTime (approx)
        const compensatedTime = data.time + oneWayLatencySeconds;

        if (data.isPlaying) play(compensatedTime + localOffset);
        else {
            stop();
            pausedAt = compensatedTime;
            loopUI();
        }
        showToast(`자동 싱크 보정 완료, +${Math.round(lastLatencyMs / 2)}ms`);
        updateSyncDisplay();
    }
    else if (data.type === 'global-resync-request') {
        showToast("Host 요청: 동기화 재설정 중...");
        setTimeout(() => syncReset(), Math.random() * 500);
    }
    else if (data.type === 'manual-sync-prepare') {
        startSonicSyncGuest(data.time);
    }
    else if (data.type === 'force-sync-play') {
        // Direct Command: Play specific time NOW.
        const t = data.time;
        showToast(`Host 강제 동기화: ${fmtTime(t)}`);
        play(t);
    }
    else if (data.type === 'operator-grant') {
        isOperator = true;
        showToast("Operator 권한이 부여되었습니다.");
        document.getElementById('play-btn').disabled = false;
        document.getElementById('role-badge').innerHTML = `<span class="role-dot"></span> HOST SYNC (OP)`;
    }
    else if (data.type === 'operator-revoke') {
        isOperator = false;
        showToast("Operator 권한이 회수되었습니다.");
        document.getElementById('play-btn').disabled = true;
        document.getElementById('role-badge').innerHTML = `<span class="role-dot"></span> HOST SYNC`;
    }
    else if (data.type === 'device-list-update') {
        const amIStillConnected = data.list.find(p => p.id === myId);
        if (hostConn && !amIStillConnected) {
            console.error("Removed from Host List. Reloading...");
            location.reload();
            return;
        }

        // Find my own label to update the global variable
        const me = data.list.find(p => p.id === myId);
        if (me) myDeviceLabel = me.label;

        renderDeviceList(data.list);
    }
    else if (data.type === 'sys-toast') {
        showToast(data.message);
    }
    // RELAY: Command to connect to another peer for data
    else if (data.type === 'assign-data-source') {
        const targetId = data.targetId;
        if (targetId && targetId !== myId) {
            showToast(`Connecting to Relay: ...${targetId.substr(-4)}`);
            // showLoader(true, `Relay 연결 중... (${targetId.substr(-4)})`); // Removed to keep UI active
            connectToRelay(targetId);
        }
    }
    // Relay says it's waiting for data - don't fall back to Host, just wait
    else if (data.type === 'file-wait') {
        console.log("[Guest] Relay has no data yet, waiting for forwarded data...");
        // Just show toast, don't block UI with loader
        showToast("릴레이 대기 중... 잠시만 기다려주세요");
        // Mark that we're waiting for relay data - disable retry fallback
        window._waitingForRelayData = true;
    }
    // --- PRELOAD HANDLERS ---
    else if (data.type === 'preload-start') {
        console.log("Preload Started:", data.name);
        // Do NOT show loader, this is background
        preloadChunks = new Array(data.total);
        preloadCount = 0;
        preloadMeta = data;
    }
    else if (data.type === 'preload-chunk') {
        // Clone
        const chunkCopy = new Uint8Array(data.chunk);
        const idx = data.index;
        if (idx >= 0 && idx < preloadChunks.length && !preloadChunks[idx]) {
            preloadChunks[idx] = chunkCopy;
            preloadCount++;
        }
        // No progress UI for preload (silent)
    }
    else if (data.type === 'preload-end') {
        console.log("Preload Finished:", data.name);
        showToast("다음 곡 다운로드 완료! (대기 중)");

        const blob = new Blob(preloadChunks, { type: preloadMeta.mime });

        // Decide: Cache as Blob or Decode?
        // To be safe and ready, let's just store the Blob and Meta
        // We will process it in 'play-preloaded'
        nextFileBlob = blob;
        nextMeta = preloadMeta;

        // If small, maybe decode ahead? 
        // Decoding takes CPU... might stutter playback?
        // Let's hold Blob. 'loadPreloadedTrack' handles Blob -> Buffer conversion quickly.

        // Clear temp
        preloadChunks = [];
    }
    else if (data.type === 'play-preloaded') {
        // Host Command: "Switch to what you downloaded!"
        console.log("Command: Play Preloaded Track");
        if (nextFileBlob) {
            currentTrackIndex = data.index;
            updatePlaylistUI(); // Update active highlight

            await loadPreloadedTrack();
            // loadPreloadedTrack switches buffers but does not start playing automatically?
            // Host will send 'play' command shortly, OR we can start if logic dictates.
            // But usually Host sends 'play' time.
            // Wait for specific 'play' packet or rely on host auto-play flow.
            // Host's playTrack sends a play command? 
            // Host's playTrack calls play(0). 
            // app.js standard play() broadcasts 'play' with time.
            // So we just need to be READY.

            // BUT: 'loadPreloadedTrack' stops playback.
            // We need to be careful not to play until Host says so.
            // The host code sends 'play-preloaded' -> play(0).
            // play(0) broadcasts { type: 'play', time: ... }
            // So we will receive 'play' soon.
        } else {
            console.warn("No preloaded file found, waiting for standard load...");
            // Fallback?
        }
    }
    else if (data.type === 'request-data-recovery') {
        // This block is legacy/unused in Guest logic, but kept empty for safety or future P2P recovery
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
            // showLoader(true, "Host 연결 중... (Relay 실패)");

            if (hostConn && hostConn.open) {
                // Ask Host for everything from start
                hostConn.send({
                    type: 'request-data-recovery',
                    nextChunk: 0,
                    fileName: (typeof meta !== 'undefined' && meta) ? meta.name : ''
                });
            }
        }
    }, FAIL_TIMEOUT);

    conn.on('open', () => {
        clearTimeout(connTimer);
        upstreamDataConn = conn;
        showToast("Connected to Relay Node");
        conn.on('data', handleData); // Use same handler for data chunks

        // Active Pull: Ask for the file immediately!
        const requestFile = () => {
            console.log("Requesting active file from relay...");
            showToast("Relay에게 파일 요청 중...");
            conn.send({ type: 'request-current-file' });
        };
        requestFile();

        // Retry Logic: If file start doesn't happen in 2s, ask again.
        let retryCount = 0;
        const retryInterval = setInterval(() => {
            if (incomingChunks.length > 0 || currentFileBlob) {
                // We got data! Stop nagging.
                clearInterval(retryInterval);
                window._waitingForRelayData = false;
            } else if (window._waitingForRelayData) {
                // Relay told us to wait - don't fall back, just keep waiting
                // Data will be forwarded automatically when relay receives it
                console.log("[Guest] Still waiting for relay data...");
            } else {
                retryCount++;
                if (retryCount > 5) { // Increased from 3 to 5 for initial download timing
                    clearInterval(retryInterval);
                    showToast("Relay 응답 없음. Host에게 직접 요청합니다.");
                    upstreamDataConn = null; // Detach from useless relay
                    if (hostConn && hostConn.open) {
                        hostConn.send({
                            type: 'request-data-recovery',
                            nextChunk: 0,
                            fileName: meta ? meta.name : ''
                        });
                    }
                } else {
                    showToast(`Relay 응답 지연. 재요청 (${retryCount}/5)...`);
                    requestFile();
                }
            }
        }, 2000);
    });

    conn.on('close', () => {
        showToast("Relay Disconnected. Recovering...");
        upstreamDataConn = null;

        // AUTO-RECOVERY: Ask Host for missing chunks
        // We know 'incomingChunks.length' is what we have.
        // We know 'meta.total' is what we need.
        if (incomingChunks.length < meta.total) {
            if (hostConn && hostConn.open) {
                showToast(`Recovering from chunk ${incomingChunks.length}...`);
                hostConn.send({
                    type: 'request-data-recovery',
                    nextChunk: incomingChunks.length,
                    fileName: meta.name
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

    // 2. Debounce Audio Application
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

        // IF I already have the file, serve it to the new child!
        // VALIDATION: Only serve if we have valid current track data
        if (currentFileBlob && meta && meta.name && currentTrackIndex !== -1) {
            // Check if our cached data matches current playing track
            const currentTrackName = playlist[currentTrackIndex]?.name;
            if (currentTrackName && meta.name === currentTrackName) {
                showToast(`Serving cached file to ${conn.peer.substr(-4)}`);
                unicastFile(conn, currentFileBlob);
            } else {
                console.warn("[Relay] Cached data doesn't match current track, not serving.");
            }
        }
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
            else if (currentFileBlob && hasValidMeta) {
                // Fallback: If for some reason chunks are gone but blob remains (rare), use standard Unicast
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
            else {
                // No data yet - tell downstream to WAIT, don't fall back to Host
                // Data will be forwarded automatically once relay starts receiving chunks
                console.log("[Relay] No data yet, telling downstream to wait...");
                conn.send({ type: 'file-wait', message: 'Relay waiting for data from upstream' });

                // Mark this connection as waiting for file-start
                // When we receive file-start, we'll forward it
                conn._waitingForFileStart = true;

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
        play(data.time);
        broadcast({ type: 'play', time: data.time });
    } else if (data.type === 'request-pause') {
        pause();
        broadcast({ type: 'pause' });
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
    }
}

async function broadcastFile(file) {
    // 1. Send Header to all eligible targets
    const CHUNK = 16384;
    const total = Math.ceil(file.size / CHUNK);
    const header = { type: 'file-start', name: file.name, mime: file.type, total: total, size: file.size };

    connectedPeers.forEach(p => {
        if (p.status === 'connected' && p.conn.open && p.isDataTarget !== false) {
            p.conn.send(header);
        }
    });

    // OPTIMIZATION: Slice the file iteratively instead of loading entire ArrayBuffer
    for (let i = 0; i < total; i++) {
        // Flow Control: Check EVERY target peer's buffer
        let congested = true;
        let attempts = 0;
        while (congested && attempts < 10) {
            congested = false;
            for (const p of connectedPeers) {
                if (p.status === 'connected' && p.conn.open && p.isDataTarget !== false) {
                    if (p.conn.dataChannel.bufferedAmount > 10 * 1024 * 1024) { // 10MB limit
                        congested = true;
                        break;
                    }
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

        // Send to all eligible targets
        for (const p of connectedPeers) {
            if (p.status === 'connected' && p.conn.open && p.isDataTarget !== false) {
                p.conn.send(chunkMsg);
            }
        }

        // Small breathing room every 50 chunks
        if (i % 50 === 0) await new Promise(r => setTimeout(r, 10));
    }

    // Send End
    const endMsg = { type: 'file-end', name: file.name, mime: file.type };
    connectedPeers.forEach(p => {
        if (p.status === 'connected' && p.conn.open && p.isDataTarget !== false) {
            p.conn.send(endMsg);
        }
    });
}

async function unicastFile(conn, file, startChunkIndex = 0) {
    const CHUNK = 16384;
    const total = Math.ceil(file.size / CHUNK);

    // Only send header if starting from 0, otherwise it's a resume
    if (startChunkIndex === 0) {
        conn.send({ type: 'file-start', name: file.name, mime: file.type, total: total, size: file.size });
        // Wait for header to settle
        await new Promise(r => setTimeout(r, 100));
    } else {
        showToast("Resuming transfer...");
    }

    for (let i = startChunkIndex; i < total; i++) {
        if (conn.dataChannel.bufferedAmount > 512 * 1024) { // 512KB Limit
            let attempts = 0;
            await new Promise(r => {
                const interval = setInterval(() => {
                    attempts++;
                    // If stuck for 2 seconds (40 * 50ms), force break
                    if (conn.dataChannel.bufferedAmount < 256 * 1024 || attempts > 40) {
                        clearInterval(interval);
                        r();
                    }
                }, 50);
            });
        }

        // Slice Optimization
        const start = i * CHUNK;
        const end = Math.min(start + CHUNK, file.size);
        const chunkBlob = file.slice(start, end);
        const chunkBuf = await chunkBlob.arrayBuffer();
        const chunk = new Uint8Array(chunkBuf);

        // Explicitly clone not strictly needed for unicast but safer
        conn.send({ type: 'file-chunk', chunk: chunk, index: i });

        // Throttle: Pause every 10 chunks to prevent bursting
        if (i % 10 === 0) await new Promise(r => setTimeout(r, 10));
    }
    conn.send({ type: 'file-end', name: file.name, mime: file.type });
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
        const t = (Tone.now() - startedAt) + localOffset;
        if (!isSeeking) {
            document.getElementById('seek-slider').value = t;
            document.getElementById('time-curr').innerText = fmtTime(t);
        }

        // Video Sync is now handled by Worker (checkVideoSync)

        handleEnded();

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

    // CRITICAL: Clear previous track state to prevent relay serving stale data
    clearPreviousTrackState('loadPreloadedTrack');

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
        document.getElementById('track-title').innerText = playlist[currentTrackIndex].name;
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