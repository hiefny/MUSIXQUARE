// @ts-check
/**
 * MUSIXQUARE 2.0 - Application Entry Point
 *
 * 이 파일은 모듈 조립만 담당한다.
 * 각 모듈은 자체 초기화를 수행하고, 이벤트 버스로 통신한다.
 *
 * 마이그레이션 가이드:
 * 1. core/ 모듈이 먼저 로드됨 (state, events, constants, log)
 * 2. 도메인 모듈이 bus에 리스너를 등록함
 * 3. app.js가 부트스트랩 시퀀스를 실행함
 *
 * 1.0 → 2.0 이전 전략:
 * - 각 전역 변수를 state.js로 하나씩 이전
 * - 각 handleXxx() 함수를 protocol.js 핸들러로 이전
 * - 각 DOM 조작을 ui/ 모듈로 이전
 */

// ── Core (순서 중요: events → state → constants) ──
import { bus } from './core/events.js';
import { setState, getState, snapshot } from './core/state.js';
import { log, setLogLevel, LOG_LEVEL } from './core/log.js';
import { MSG } from './core/constants.js';

// ── Domain Modules ──
import { initAudio } from './audio/engine.js';
import { initPeer, connectTo, send, destroy as destroyPeer } from './network/peer.js';
import { onMessage, registerHandlers } from './network/protocol.js';
import { play, pause, stop, getPosition } from './player/playback.js';
import { initWorker as initOpfs, destroy as destroyOpfs } from './storage/opfs.js';

// ── Bootstrap ──
async function boot() {
  log.info('🎵 MUSIXQUARE 2.0 starting...');

  // Initialize OPFS worker
  initOpfs();

  // Theme
  const savedTheme = localStorage.getItem('mxqr-theme') || 'dark';
  setState('ui.theme', savedTheme);
  document.documentElement.setAttribute('data-theme', savedTheme);

  // Register protocol handlers
  // TODO: 1.0의 handleData() switch문에서 하나씩 이전
  registerHandlers({
    [MSG.PLAY]: (data) => {
      log.debug('[Protocol] Play received:', data);
      // TODO: implement
    },
    [MSG.PAUSE]: (data) => {
      log.debug('[Protocol] Pause received:', data);
      // TODO: implement
    },
    [MSG.HEARTBEAT]: (data, conn) => {
      send({ type: MSG.PONG, ts: Date.now() }, conn);
    },
  });

  // Audio init requires user gesture - will be triggered by setup flow
  bus.on('audio:ready', () => {
    log.info('Audio engine ready');
  });

  // Debug: expose to console
  if (typeof window !== 'undefined') {
    /** @type {any} */ (window).__MXQR = {
      bus, setState, getState, snapshot,
      initAudio, initPeer, connectTo, send, play, pause, stop, getPosition,
      MSG, LOG_LEVEL, setLogLevel,
    };
  }

  log.info('✅ MUSIXQUARE 2.0 boot complete (skeleton mode)');
  log.info('💡 Tip: window.__MXQR 에서 모든 API에 접근 가능');
}

// Run on DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
