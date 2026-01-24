const DEMO_VIDEO_URL = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4";

// Robust Demo Loader with Progress
async function loadDemoMedia() {
    // Prevent Guest from running Demo
    if (window.hostConn) {
        showToast("Host만 실행할 수 있습니다.");
        return;
    }

    if (confirm("시연 영상(Tears of Steel, ~15MB)을 다운로드하고 재생하시겠습니까?\n(데이터 요금이 부과될 수 있습니다)")) {

        // 1. Notify everyone IMMEDIATELY after confirmation
        const toastMsg = "곧 시연 영상과 음성이 재생됩니다.\n\"설정 탭\"에서 본인의 기기 역할을 설정해주세요!";
        if (window.broadcast) {
            window.broadcast({ type: 'sys-toast', message: toastMsg });
        }
        showToast(toastMsg);

        try {
            showLoader(true, "Demo 다운로드 중...");

            const response = await fetch(DEMO_VIDEO_URL);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const contentLength = +response.headers.get('Content-Length');
            if (!contentLength) {
                // Fallback if no content-length
                showLoader(true, "다운로드 중... (크기 알 수 없음)");
            }

            const reader = response.body.getReader();
            let receivedLength = 0;
            let chunks = [];

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                chunks.push(value);
                receivedLength += value.length;

                if (contentLength) {
                    const percent = Math.floor((receivedLength / contentLength) * 100);
                    document.getElementById('loader-text').innerText = `Demo 다운로드 중... ${percent}%`;
                    if (window.updateLoader) window.updateLoader(percent);
                }
            }

            // Combine chunks
            const blob = new Blob(chunks, { type: 'video/mp4' });

            const file = new File([blob], "Tears_of_Steel_Demo.mp4", { type: "video/mp4" });

            showLoader(true, "플레이리스트 추가 중...");

            // Integrate with App Logic
            if (window.playlist && window.playTrack) {
                // Add to playlist with correct object format (matching app.js structure)
                window.playlist.push({
                    type: 'local',
                    file: file,
                    name: file.name
                });
                window.updatePlaylistUI();

                // Broadcast playlist update
                if (window.broadcast) {
                    window.broadcast({
                        type: 'playlist-update',
                        list: window.playlist.map(item => ({
                            type: item.type || 'local',
                            name: item.name || item.file?.name || 'Unknown',
                            videoId: item.videoId || null,
                            playlistId: item.playlistId || null
                        }))
                    });
                }

                // Play it (it's the last one)
                window.playTrack(window.playlist.length - 1);
                showLoader(false);

            } else {
                console.error("App logic not found");
                alert("App initialization failed.");
                showLoader(false);
            }
        } catch (e) {
            console.error(e);
            showLoader(false);
            alert("Demo 로드 실패: " + e.message);
        }
    }
}
