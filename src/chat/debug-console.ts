/**
 * MUSIXQUARE — Debug Console (/debug subsystem)
 *
 * Developer diagnostics reached through the `/debug` command: UA/OS parsing,
 * the text/screen debug overlays, and the live memory profiler with canvas
 * graphing. It is the ONLY part of the chat domain that imports audio / storage
 * / player internals, so it is isolated here; commands.ts re-exposes it through
 * the COMMANDS_DEF registry via the single exported cmdDebug entry point.
 */

import { getState } from '../core/state.ts';
import { t } from '../i18n/index.ts';
import { addSystemChatMessage } from '../ui/chat-render.ts';
import { showToast } from '../ui/toast.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { isAudioReady, getAudioContext } from '../audio/engine.ts';
import { getPreloadMemoryStats } from '../storage/preload.ts';
import { getTransferMemoryStats } from '../storage/transfer-receive.ts';
import { ramStats } from '../storage/ramstore.ts';
import { getCurrentAudioBuffer, liveAudioBufferCount } from '../player/_state.ts';
import { getCurrentQueueItemId, getCurrentQueueItemIndex } from '../player/queue-model.ts';
import { getCapturedLogs } from '../core/log-capture.ts';
import { log } from '../core/log.ts';
import { getPlaybackOwnership } from '../player/ownership.ts';
import { collectSystemAudioDebugText } from '../network/system-audio-debug.ts';
import {
  collectSyncFlightRecorderText,
  markSyncFlightRecorderIncident,
} from '../diagnostics/sync-flight-recorder.ts';
import type { ConnectedPeer } from '../types/index.ts';
import { parseDebugBrowser } from './debug-user-agent.ts';
import {
  appendDebugMemoryGraphSample,
  createDebugMemoryGraphHistory,
  type DebugMemoryGraphHistory,
} from './debug-memory-history.ts';
import {
  getContrastStatus,
  setContrastPreference,
  type ContrastPreference,
  type ContrastStatus,
} from '../core/contrast.ts';

type NavigatorDebugInfo = Navigator & {
  standalone?: boolean;
  connection?: {
    effectiveType?: unknown;
    downlink?: unknown;
    rtt?: unknown;
  };
};

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
};

const debugNavigator = navigator as NavigatorDebugInfo;
const debugPerformance = performance as PerformanceWithMemory;

function formatContrastStatus(status: ContrastStatus): string {
  const authored = status.authoredContrastActive ? 'more' : 'normal';
  const system = status.systemPrefersMore ? 'more' : 'normal';
  const forcedColors = status.forcedColorsActive ? 'active' : 'inactive';
  return `Contrast: ${status.preference} | authored:${authored} | OS:${system} | forced-colors:${forcedColors}`;
}

function cmdDebugContrast(args: string[]): void {
  if (args.length === 1) {
    addSystemChatMessage(formatContrastStatus(getContrastStatus()));
    return;
  }

  const requested = (args[1] || '').toLowerCase();
  if (args.length !== 2 || !['on', 'off', 'auto'].includes(requested)) {
    addSystemChatMessage('Usage: /debug contrast [on | off | auto]');
    return;
  }

  const status = setContrastPreference(requested as ContrastPreference);
  addSystemChatMessage(formatContrastStatus(status));
}

function _parseOS(ua: string): string {
  if (/iPhone OS ([\d_]+)/.test(ua)) return `iOS ${RegExp.$1.replace(/_/g, '.')}`;
  if (/iPad.*OS ([\d_]+)/.test(ua)) return `iPadOS ${RegExp.$1.replace(/_/g, '.')}`;
  if (/Mac OS X ([\d_.]+)/.test(ua)) return `macOS ${RegExp.$1.replace(/_/g, '.')}`;
  if (/Android ([\d.]+)/.test(ua)) return `Android ${RegExp.$1}`;
  if (/Windows NT ([\d.]+)/.test(ua)) {
    const ver: Record<string, string> = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' };
    return `Windows ${ver[RegExp.$1] || RegExp.$1}`;
  }
  if (/CrOS/.test(ua)) return 'Chrome OS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}

export function cmdDebug(args: string[]): void {
  // Hidden subcommands. Not surfaced in /help / autocomplete (the chat
  // command framework doesn't expose subcommand discovery, so passing
  // any string after `/debug ` works only for users who already know).
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'memory' || sub === 'mem') {
    cmdDebugMemory().catch((error) => {
      log.warn('[Debug] Memory snapshot failed', error);
    });
    return;
  }
  if (sub === 'screen' || sub === 'viewport' || sub === 'vp') {
    cmdDebugScreen();
    return;
  }
  if (sub === 'systemaudio' || sub === 'sysaudio' || sub === 'sa') {
    cmdDebugSystemAudio();
    return;
  }
  if (sub === 'console' || sub === 'log' || sub === 'logs') {
    cmdDebugConsole();
    return;
  }
  if (sub === 'sync' || sub === 'clock' || sub === 'drift') {
    cmdDebugSync();
    return;
  }
  if (sub === 'contrast') {
    cmdDebugContrast(args);
    return;
  }

  const lines: string[] = ['SYSTEM DEBUG INFO'];

  // Device & Browser
  const ua = navigator.userAgent;
  const browser = parseDebugBrowser(ua);
  const os = _parseOS(ua);
  const lang = navigator.language;
  const screen = `${window.screen.width}×${window.screen.height}`;
  const viewport = `${window.innerWidth}×${window.innerHeight}`;
  const dpr = window.devicePixelRatio?.toFixed(1) || '?';
  const touch = 'ontouchstart' in window ? 'yes' : 'no';
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || debugNavigator.standalone
      ? 'yes'
      : 'no';
  lines.push(`[Browser] ${browser}`);
  lines.push(`[OS] ${os}`);
  lines.push(`[Screen] ${screen} (${viewport}) @${dpr}x | touch:${touch} | PWA:${standalone}`);
  lines.push(`[Lang] ${lang}`);

  // Network
  const connType = getState('network.connectionType') || 'unknown';
  const sessionCode = getState('network.sessionCode') || '-';
  const myId = getState('network.myId') || '-';
  const myOrder = getState('network.myJoinOrder') ?? 0;
  const myLabel = getState('network.myDeviceLabel') || '-';
  const peers = getState('network.connectedPeers') as ConnectedPeer[];
  const isOp = getState('network.isOperator') ? 'yes' : 'no';
  lines.push(
    `[Network] #${myOrder} ${myLabel} | code:${sessionCode} | conn:${connType} | OP:${isOp}`,
  );
  lines.push(`[PeerID] ${myId}`);
  lines.push(`[Peers] ${peers.length} connected`);
  for (const p of peers) {
    const flags = [p.isOp ? 'OP' : '', p.connectionType || ''].filter(Boolean).join(',');
    lines.push(`  #${p.joinOrder} ${p.label} [${flags}]`);
  }

  // Chat moderation
  const frozen = getState('network.chatFrozen') ? 'ON' : 'off';
  const slowmode = getState('network.slowmodeSeconds');
  const filter = getState('network.filterEnabled') ? 'ON' : 'off';
  const mutedCount = getState('network.mutedPeers').size;
  lines.push(
    `[Chat] freeze:${frozen} | slowmode:${slowmode}s | filter:${filter} | muted:${mutedCount}`,
  );

  // Audio
  const playback = getPlaybackOwnership();
  const channelMode = getState('audio.channelMode') ?? 0;
  const channelNames: Record<number, string> = {
    0: 'Center',
    '-1': 'Left',
    1: 'Right',
    2: 'Subwoofer',
  };
  const chName = channelNames[channelMode] || String(channelMode);
  const reverbMix = getState('audio.reverbMix') ?? 0;
  const eqValues = getState('audio.eqValues') || [];
  const eqActive = Array.isArray(eqValues) && eqValues.some((v: number) => v !== 0);
  const vbass = getState('audio.virtualBass') ?? 0;
  const volume = getState('audio.masterVolume') ?? 1;
  lines.push(
    `[Audio] mode:${playback.mode ?? 'none'}/${playback.activity} | ch:${chName} | vol:${Math.round(volume * 100)}%`,
  );
  lines.push(
    `[FX] EQ:${eqActive ? 'ON' : 'off'} | reverb:${reverbMix > 0 ? `${Math.round(reverbMix * 100)}%` : 'off'} | vbass:${vbass > 0 ? 'ON' : 'off'}`,
  );

  // AudioContext does not exist before the engine initializes.
  if (isAudioReady()) {
    try {
      const ctx = getAudioContext();
      lines.push(
        `[AudioCtx] sr:${ctx.sampleRate}Hz | state:${ctx.state} | time:${ctx.currentTime.toFixed(1)}s`,
      );
    } catch {
      /* ignore */
    }
  }

  // Playlist
  const currentQueueItemId = getCurrentQueueItemId();
  const trackIdx = getCurrentQueueItemIndex();
  const playlist = getState('playlist.items') || [];
  const currentTitle =
    trackIdx >= 0 && playlist[trackIdx] ? playlist[trackIdx].title || playlist[trackIdx].name : '-';
  lines.push(
    `[Playlist] ${playlist.length} tracks | current:#${trackIdx >= 0 ? trackIdx : '-'} qid:${currentQueueItemId || '-'} ${currentTitle}`,
  );

  // Session timing
  const sessionStarted = getState('setup.sessionStarted');
  lines.push(`[Session] started:${sessionStarted ? 'yes' : 'no'}`);

  // Memory (if available)
  try {
    const mem = debugPerformance.memory;
    if (mem) {
      const used = (mem.usedJSHeapSize / 1048576).toFixed(1);
      const limit = (mem.jsHeapSizeLimit / 1048576).toFixed(0);
      lines.push(`[Memory] ${used}MB / ${limit}MB`);
    }
  } catch {
    /* ignore */
  }

  // Network info (if available)
  try {
    const conn = debugNavigator.connection;
    if (conn) {
      lines.push(
        `[NetInfo] type:${conn.effectiveType || '?'} | downlink:${conn.downlink || '?'}Mbps | rtt:${conn.rtt || '?'}ms`,
      );
    }
  } catch {
    /* ignore */
  }

  const debugText = lines.join('\n');
  addSystemChatMessage(debugText);

  // Auto-copy to clipboard
  try {
    navigator.clipboard
      .writeText(debugText)
      .then(() => {
        showToast(t('chat.debug_copied'));
      })
      .catch(() => {
        /* clipboard not available */
      });
  } catch {
    /* ignore */
  }
}

// ─── /debug memory ──────────────────────────────────────────────
//
// Hidden subcommand for diagnosing memory pressure. Not surfaced in
// /help, autocomplete, or i18n — by design. Operators who know the
// command type `/debug memory` to dump a per-domain snapshot.
//
// Captures everything that could plausibly accumulate per-track, so
// repeated calls during a 100-track playback session expose which
// domain grows monotonically. Domains:
//   - Heap (performance.memory if Chromium)
//   - Audio buffer (current decoded PCM in RAM)
//   - Files (current blob, preload blob, playlist file refs sum)
//   - Transfer (main reorder buffer)
//   - Preload (reorder buffer + sessionState + ackSent)
//   - Network (peer connections)
//   - Lifecycle (state machine + recovery target)
// /debug screen: local-only live viewport/PWA diagnostics.
// /debug systemaudio (sa): local-only live system-audio sharing diagnostics.
// Same fullscreen-overlay UX as /debug screen — the dump is too dense to
// scan in chat, and most signals (track muted, pc state, watchdog timers)
// are time-sensitive enough that a 1s live refresh matters.
// ─── Shared live debug overlay (text) ────────────────────────────
// One fullscreen text overlay at a time. /debug screen, systemaudio, and
// console all render through this helper; /debug memory keeps its own (graph
// canvases) but shares the single-open invariant via closeActiveTextDebugOverlay()
// + stopDebugMemorySession().
interface TextDebugOverlayOptions {
  id: string;
  ariaLabel: string;
  hint: string;
  collect: () => string | Promise<string>;
  /** screen: re-render on viewport resize/scroll. */
  watchViewport?: boolean;
  /** console: long buffer — scroll the content + close on backdrop tap only. */
  scrollable?: boolean;
}

let _activeTextDebugOverlay: { cleanup: () => void } | null = null;
const DEBUG_TEXT_OVERLAY_TIMER = 'debug-text-overlay-poll';
const DEBUG_TEXT_OVERLAY_POLL_MS = 1000;

function closeActiveTextDebugOverlay(): void {
  const active = _activeTextDebugOverlay;
  _activeTextDebugOverlay = null;
  if (active) {
    try {
      active.cleanup();
    } catch {
      /* ignore */
    }
  }
}

function openTextDebugOverlay(opts: TextDebugOverlayOptions): void {
  // Single-overlay invariant across ALL /debug overlays (including memory).
  closeActiveTextDebugOverlay();
  stopDebugMemorySession();

  document.getElementById(opts.id)?.remove();

  const overlay = document.createElement('div');
  overlay.id = opts.id;
  overlay.className = 'debug-memory-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', opts.ariaLabel);

  const pre = document.createElement('pre');
  pre.className = 'debug-memory-content';
  if (opts.scrollable) {
    pre.style.overflowY = 'auto';
    pre.style.maxHeight = '85vh';
    pre.style.pointerEvents = 'auto';
    pre.style.userSelect = 'text';
    pre.style.touchAction = 'pan-y';
  }
  overlay.appendChild(pre);

  const hint = document.createElement('div');
  hint.className = 'debug-memory-hint';
  hint.textContent = opts.hint;
  overlay.appendChild(hint);

  let disposed = false;
  // Re-entrancy + stale-write guard: an async collect (systemaudio awaits
  // RTCStats) can outlast the 1s tick — skip overlapping ticks and drop a
  // resolved write if the overlay was torn down meanwhile.
  let inFlight = false;
  const refresh = (): void => {
    if (inFlight) return;
    inFlight = true;
    const stick = !!opts.scrollable && pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    (async () => {
      let text: string;
      try {
        text = await opts.collect();
      } catch (e) {
        text = `[debug collect error] ${e instanceof Error ? e.message : String(e)}`;
      }
      inFlight = false;
      if (disposed) return;
      pre.textContent = text;
      if (stick) pre.scrollTop = pre.scrollHeight;
    })().catch((error) => {
      inFlight = false;
      log.warn('[Debug] Text overlay refresh failed', error);
    });
  };

  const close = (): void => closeActiveTextDebugOverlay();
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  const cleanup = (): void => {
    disposed = true;
    clearManagedTimer(DEBUG_TEXT_OVERLAY_TIMER);
    document.removeEventListener('keydown', onKey);
    if (opts.watchViewport) {
      window.removeEventListener('resize', refresh);
      window.visualViewport?.removeEventListener('resize', refresh);
      window.visualViewport?.removeEventListener('scroll', refresh);
    }
    if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
  };

  if (opts.scrollable) {
    // Backdrop tap only — let the user scroll the content without closing.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  } else {
    overlay.addEventListener('click', close);
  }
  document.addEventListener('keydown', onKey);
  if (opts.watchViewport) {
    window.addEventListener('resize', refresh, { passive: true });
    window.visualViewport?.addEventListener('resize', refresh, { passive: true });
    window.visualViewport?.addEventListener('scroll', refresh, { passive: true });
  }

  _activeTextDebugOverlay = { cleanup };
  document.body.appendChild(overlay);
  refresh();
  setManagedTimer(DEBUG_TEXT_OVERLAY_TIMER, refresh, DEBUG_TEXT_OVERLAY_POLL_MS, {
    interval: true,
  });

  // One-shot clipboard copy of the first sample.
  (async () => {
    let text: string;
    try {
      text = await opts.collect();
    } catch {
      return;
    }
    try {
      await navigator.clipboard?.writeText(text);
      showToast(t('chat.debug_copied'));
    } catch {
      /* clipboard unavailable */
    }
  })().catch((error) => log.warn('[Debug] Clipboard snapshot failed', error));
}

function cmdDebugSystemAudio(): void {
  openTextDebugOverlay({
    id: 'debug-system-audio-overlay',
    ariaLabel: 'Debug system audio live overlay',
    hint: 'tap to close | live 1s | copied once',
    collect: collectSystemAudioDebugText,
  });
}

function cmdDebugScreen(): void {
  openTextDebugOverlay({
    id: 'debug-screen-overlay',
    ariaLabel: 'Debug screen live overlay',
    hint: 'tap to close | live 1s | copied once',
    collect: collectScreenDebugText,
    watchViewport: true,
  });
}

// ─── /debug console ──────────────────────────────────────────────
// On-device console viewer. iOS has no DevTools without a tethered Mac, so
// this surfaces the captured console ring buffer (core/log-capture.ts) as a
// scrollable overlay. Same look as /debug screen; tap the edge / ESC to close.
function cmdDebugConsole(): void {
  openTextDebugOverlay({
    id: 'debug-console-overlay',
    ariaLabel: 'Debug console live overlay',
    hint: 'tap edge / ESC to close | live 1s | newest at bottom',
    collect: getCapturedLogs,
    scrollable: true,
  });
}

function cmdDebugSync(): void {
  markSyncFlightRecorderIncident();
  openTextDebugOverlay({
    id: 'debug-sync-flight-overlay',
    ariaLabel: 'Sync flight recorder',
    hint: 'tap edge / ESC to close | RAM only | copied once',
    collect: collectSyncFlightRecorderText,
    scrollable: true,
  });
}

function collectScreenDebugText(): string {
  const root = document.documentElement;
  const body = document.body;
  const vv = window.visualViewport;
  const ua = navigator.userAgent;
  const safe = readSafeAreaProbe();
  const rootRect = root.getBoundingClientRect();
  const bodyRect = body?.getBoundingClientRect() ?? null;
  const activeTab = document.querySelector('.tab-content.active');
  const activeTabRect = activeTab?.getBoundingClientRect() ?? null;
  const rootStyle = getComputedStyle(root);
  const bodyStyle = body ? getComputedStyle(body) : null;
  const activeElement = document.activeElement as HTMLElement | null;
  const lines: string[] = ['SCREEN / PWA DEBUG'];

  lines.push(`[Time] ${new Date().toISOString()}`);
  lines.push(`[Browser] ${parseDebugBrowser(ua)} | ${_parseOS(ua)}`);
  lines.push(`[UA] ${ua}`);
  lines.push(
    `[Mode] display:${getDisplayMode()} | standalone:${fmtBool(isStandaloneLike())} | touch:${fmtBool('ontouchstart' in window)} | dpr:${fmtNum(window.devicePixelRatio, 2)}`,
  );
  lines.push(
    `[Orientation] media:${getOrientationMedia()} | screen:${screen.orientation?.type ?? '-'} @${screen.orientation?.angle ?? '-'}`,
  );
  lines.push(
    `[Window] inner:${fmtSize(window.innerWidth, window.innerHeight)} | outer:${fmtSize(window.outerWidth, window.outerHeight)}`,
  );
  lines.push(
    `[Screen] size:${fmtSize(screen.width, screen.height)} | avail:${fmtSize(screen.availWidth, screen.availHeight)} | colorDepth:${screen.colorDepth}`,
  );
  if (vv) {
    lines.push(
      `[VisualViewport] size:${fmtSize(vv.width, vv.height)} | offset:${fmtPoint(vv.offsetLeft, vv.offsetTop)} | page:${fmtPoint(vv.pageLeft, vv.pageTop)} | scale:${fmtNum(vv.scale, 3)}`,
    );
  } else {
    lines.push('[VisualViewport] unavailable');
  }
  lines.push(
    `[Document] client:${fmtSize(root.clientWidth, root.clientHeight)} | scroll:${fmtSize(root.scrollWidth, root.scrollHeight)} | bodyClient:${body ? fmtSize(body.clientWidth, body.clientHeight) : '-'}`,
  );
  lines.push(
    `[Scroll] page:${fmtPoint(window.scrollX, window.scrollY)} | root:${fmtPoint(root.scrollLeft, root.scrollTop)} | body:${body ? fmtPoint(body.scrollLeft, body.scrollTop) : '-'}`,
  );
  lines.push(
    `[SafeArea env] top:${safe.top} right:${safe.right} bottom:${safe.bottom} left:${safe.left}`,
  );
  lines.push(
    `[CSS vars] app:${readCssVar('--app-height')} safeTop:${readCssVar('--safe-top')} safeBottom:${readCssVar('--safe-bottom')} navSafe:${readCssVar('--safe-nav-bottom')} kb:${readCssVar('--keyboard-overlap')}`,
  );
  lines.push(
    `[CSS vars] header:${readCssVar('--header-height')} nav:${readCssVar('--nav-height')} right:${readCssVar('--safe-right')} left:${readCssVar('--safe-left')}`,
  );
  lines.push(`[Classes] html:${root.className || '-'} | body:${body?.className || '-'}`);
  lines.push(
    `[Root style] height:${rootStyle.height} min:${rootStyle.minHeight} max:${rootStyle.maxHeight} overflow:${rootStyle.overflow}`,
  );
  if (bodyStyle) {
    lines.push(
      `[Body style] height:${bodyStyle.height} min:${bodyStyle.minHeight} max:${bodyStyle.maxHeight} overflow:${bodyStyle.overflow} pos:${bodyStyle.position}`,
    );
  }
  lines.push(
    `[Bottom gaps] html->inner:${fmtPx(window.innerHeight - rootRect.bottom)} body->inner:${bodyRect ? fmtPx(window.innerHeight - bodyRect.bottom) : '-'} tab->inner:${activeTabRect ? fmtPx(window.innerHeight - activeTabRect.bottom) : '-'}`,
  );
  if (vv) {
    lines.push(
      `[Bottom gaps@vv] html:${fmtPx(vv.height - rootRect.bottom)} body:${bodyRect ? fmtPx(vv.height - bodyRect.bottom) : '-'} tab:${activeTabRect ? fmtPx(vv.height - activeTabRect.bottom) : '-'}`,
    );
  }
  lines.push('[Rects]');
  lines.push(`  html ${fmtElement(root)}`);
  lines.push(`  body ${fmtElement(body)}`);
  lines.push(`  header ${fmtElement(document.querySelector('header'))}`);
  lines.push(`  bottomNav ${fmtElement(document.querySelector('.bottom-nav'))}`);
  lines.push(`  activeTab ${fmtElement(activeTab)}`);
  lines.push(`  tabBody ${fmtElement(document.querySelector('.tab-content.active .tab-body'))}`);
  lines.push(`  chatInput ${fmtElement(document.querySelector('#chat-input'))}`);
  lines.push(`  setup ${fmtElement(document.querySelector('#setup-overlay'))}`);
  lines.push(`  dialog ${fmtElement(document.querySelector('#dialog-overlay'))}`);
  lines.push(
    `[ActiveElement] ${activeElement ? `${activeElement.tagName.toLowerCase()}#${activeElement.id || '-'} .${activeElement.className || '-'}` : '-'}`,
  );

  return lines.join('\n');
}

function readSafeAreaProbe(): { top: string; right: string; bottom: string; left: string } {
  const parent = document.body || document.documentElement;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);visibility:hidden;pointer-events:none;';
  parent.appendChild(probe);
  const style = getComputedStyle(probe);
  const safe = {
    top: style.paddingTop || '0px',
    right: style.paddingRight || '0px',
    bottom: style.paddingBottom || '0px',
    left: style.paddingLeft || '0px',
  };
  probe.remove();
  return safe;
}

function readCssVar(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || '-';
}

function getDisplayMode(): string {
  const modes = ['fullscreen', 'standalone', 'minimal-ui', 'browser'];
  return modes.find((mode) => window.matchMedia?.(`(display-mode: ${mode})`).matches) || 'unknown';
}

function isStandaloneLike(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches || Boolean(debugNavigator.standalone)
  );
}

function getOrientationMedia(): string {
  if (window.matchMedia?.('(orientation: portrait)').matches) return 'portrait';
  if (window.matchMedia?.('(orientation: landscape)').matches) return 'landscape';
  return 'unknown';
}

function fmtNum(value: unknown, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '-';
}

function fmtPx(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}px` : '-';
}

function fmtBool(value: unknown): string {
  return value ? 'yes' : 'no';
}

function fmtSize(width: unknown, height: unknown): string {
  return `${fmtNum(width)}x${fmtNum(height)}`;
}

function fmtPoint(x: unknown, y: unknown): string {
  return `${fmtNum(x)},${fmtNum(y)}`;
}

function fmtElement(el: Element | null | undefined): string {
  if (!el) return '-';
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className ? `.${el.className}` : '';
  return `${el.tagName.toLowerCase()}${id}${cls} rect:${fmtRect(rect)} disp:${style.display} pos:${style.position} overflow:${style.overflow} h:${style.height} max:${style.maxHeight} padT/B:${style.paddingTop}/${style.paddingBottom}`;
}

function fmtRect(rect: DOMRect): string {
  return `x:${fmtPx(rect.x)} y:${fmtPx(rect.y)} w:${fmtPx(rect.width)} h:${fmtPx(rect.height)} b:${fmtPx(rect.bottom)}`;
}

interface MemSnapshot {
  lines: string[];
  /** usedJSHeapSize in MB (Chromium only — null on Safari/iOS). */
  heapMB: number | null;
  /** navigator.storage.estimate().usage in MB. 0 if unsupported. */
  storageMB: number;
}

async function cmdDebugMemory(): Promise<void> {
  // Build the first sample synchronously so the overlay opens with data,
  // then hand off to the live session for continuous updates + graphs.
  const snapshot = await collectMemorySnapshot();

  // Replaces any in-flight session — single-overlay invariant preserved.
  startDebugMemorySession(snapshot);

  // Clipboard copy and its toast are intentionally one-shot; repeating them
  // on every sampling tick would spam the user.
  try {
    navigator.clipboard
      .writeText(snapshot.lines.join('\n'))
      .then(() => showToast(t('chat.debug_copied')))
      .catch(() => {
        /* clipboard not available */
      });
  } catch {
    /* ignore */
  }
}

async function collectMemorySnapshot(): Promise<MemSnapshot> {
  const lines: string[] = ['MEMORY SNAPSHOT'];
  let heapMB: number | null = null;
  let storageMB = 0;

  // Track sum-of-known allocations as a Chromium-independent lower bound.
  // Safari/iOS WebKit doesn't expose performance.memory, so this is the
  // primary monotonic-leak signal for those platforms — compare snapshots
  // taken at different points in the session and watch which line grew.
  let trackedBytes = 0;

  // ── Heap (Chromium only) ──
  try {
    const mem = debugPerformance.memory;
    if (mem) {
      const used = mem.usedJSHeapSize / 1048576;
      const total = mem.totalJSHeapSize / 1048576;
      const limit = mem.jsHeapSizeLimit / 1048576;
      const pct = ((used / limit) * 100).toFixed(1);
      heapMB = used;
      lines.push(
        `[Heap] ${used.toFixed(1)}MB used / ${total.toFixed(0)}MB total / ${limit.toFixed(0)}MB limit (${pct}%)`,
      );
    } else {
      lines.push('[Heap] performance.memory unavailable (Safari/iOS). See [Tracked]');
    }
  } catch {
    /* ignore */
  }

  // ── Storage (IndexedDB + Cache + SW on disk) ──
  // Safari supports navigator.storage.estimate(). Chromium additionally
  // exposes `usageDetails` with a per-backend breakdown (indexedDB / caches /
  // serviceWorkerRegistrations) so we can tell whether a "storage growing
  // forever" symptom is SW Cache API, IndexedDB, or something else without
  // a long bisect.
  try {
    if (navigator.storage?.estimate) {
      const est = (await navigator.storage.estimate()) as StorageEstimate & {
        usageDetails?: Record<string, number>;
      };
      const used = (est.usage || 0) / 1048576;
      const quota = (est.quota || 0) / 1048576;
      const pct = quota > 0 ? ((used / quota) * 100).toFixed(1) : '?';
      storageMB = used;
      lines.push(`[Storage] disk:${used.toFixed(1)}MB / quota:${quota.toFixed(0)}MB (${pct}%)`);

      // Sort the breakdown so the largest backend bubbles to the top —
      // that's where any growth signal will show first.
      if (est.usageDetails && typeof est.usageDetails === 'object') {
        const entries = Object.entries(est.usageDetails)
          .filter(([, v]) => typeof v === 'number')
          .sort((a, b) => (b[1] as number) - (a[1] as number));
        if (entries.length > 0) {
          const parts = entries.map(([k, v]) => `${k}:${((v as number) / 1048576).toFixed(1)}MB`);
          lines.push(`          breakdown: ${parts.join(' | ')}`);
        }
      } else {
        lines.push(`          breakdown: unavailable (Safari/iOS)`);
      }
    }
  } catch {
    /* ignore */
  }

  // ── Cache API (Service Worker caches) ──
  // iOS doesn't ship `usageDetails` so we can't see the cache split from
  // `navigator.storage.estimate()`. Iterate the Cache API directly
  // instead — `caches.keys()` + `cache.keys()` are cheap (just metadata),
  // entry count alone is a strong leak signal. On Windows we already saw
  // `caches: 2.4GB` was the dominant backend; this block makes the same
  // bisection possible from iOS.
  try {
    if (typeof caches !== 'undefined' && caches.keys) {
      const cacheNames = await caches.keys();
      let totalEntries = 0;
      const stats: Array<{ name: string; entries: number }> = [];
      for (const name of cacheNames) {
        try {
          const cache = await caches.open(name);
          const reqs = await cache.keys();
          stats.push({ name, entries: reqs.length });
          totalEntries += reqs.length;
        } catch {
          /* skip cache that errored — partial info is still useful */
        }
      }
      if (stats.length > 0) {
        lines.push(`[Caches] ${stats.length} caches, ${totalEntries} entries`);
        // Stable sort by entry count desc — biggest cache lands on top.
        stats.sort((a, b) => b.entries - a.entries);
        for (const s of stats) {
          const noun = s.entries === 1 ? 'entry' : 'entries';
          lines.push(`         ${s.name}: ${s.entries} ${noun}`);
        }
      }
    }
  } catch {
    /* ignore — Cache API not critical */
  }

  // ── Audio ──
  try {
    const audioBuf = getCurrentAudioBuffer();
    if (audioBuf) {
      // PCM bytes = numberOfChannels × length × 4 (Float32)
      const pcmBytes = audioBuf.numberOfChannels * audioBuf.length * 4;
      trackedBytes += pcmBytes;
      lines.push(
        `[Audio] buffer:${(pcmBytes / 1048576).toFixed(1)}MB (${audioBuf.duration.toFixed(1)}s × ${audioBuf.numberOfChannels}ch @ ${audioBuf.sampleRate}Hz)`,
      );
    } else {
      lines.push('[Audio] buffer:none');
    }
    // WeakRef-based count of every AudioBuffer ever decoded vs how many
    // are still alive in the JS heap. `live` should hover at 1 (the
    // current buffer); a value that climbs across track switches means
    // iOS hasn't reclaimed retired AudioBufferSourceNodes / their buffers
    // yet — the smoking gun for the "track-switch leak" pattern. `everSeen`
    // is the cumulative decode count for the session and should match the
    // number of distinct tracks loaded.
    const bufStats = liveAudioBufferCount();
    lines.push(`        live AudioBuffers:${bufStats.live} (everSeen:${bufStats.everSeen})`);
  } catch {
    /* ignore */
  }

  // ── Files ──
  try {
    const currentBlob = getState('files.current')?.blob ?? null;
    const preloadBlob = getState('preload.ready')?.blob ?? null;
    if (currentBlob) trackedBytes += currentBlob.size;
    if (preloadBlob) trackedBytes += preloadBlob.size;
    const currentMB = currentBlob ? (currentBlob.size / 1048576).toFixed(1) : '0.0';
    const preloadMB = preloadBlob ? (preloadBlob.size / 1048576).toFixed(1) : '0.0';
    lines.push(`[Files] currentBlob:${currentMB}MB preloadBlob:${preloadMB}MB`);

    const playlist = getState('playlist.items') || [];
    let plBytes = 0;
    let plFileCount = 0;
    for (const item of playlist) {
      if (item.file && typeof item.file.size === 'number') {
        plBytes += item.file.size;
        plFileCount++;
      }
    }
    // This is a logical retained-media byte inventory, not a heap measurement.
    // Browsers may externally back File/Blob data, and one object can appear in
    // multiple slots below, so the estimate can double-count references.
    trackedBytes += plBytes;
    lines.push(
      `[Playlist] ${playlist.length} items, ${plFileCount} with file ref, ~${(plBytes / 1048576).toFixed(0)}MB total`,
    );
  } catch {
    /* ignore */
  }

  // ── Transfer (main) ──
  try {
    const ts = getTransferMemoryStats();
    trackedBytes += ts.reorderBytes;
    const meta = getState('transfer.meta');
    const total = (meta?.total as number) || 0;
    const received = (getState('transfer.receivedCount') as number) || 0;
    lines.push(
      `[Transfer] owner:${ts.ownerSessions}sess reorderBuf:${ts.reorderSessions}sess/${ts.reorderChunks}ch/${(ts.reorderBytes / 1048576).toFixed(2)}MB`,
    );
    lines.push(`           progress:${received}/${total}`);
  } catch {
    /* ignore */
  }

  // ── Preload ──
  try {
    const ps = getPreloadMemoryStats();
    trackedBytes += ps.reorderBytes;
    const sessionState = (getState('preload.sessionState') as Map<number, unknown>) || new Map();
    const ackSent = getState('preload.ackSent') || new Map();
    let finalized = 0;
    let skipped = 0;
    let inProgress = 0;
    for (const s of sessionState.values()) {
      const e = s as { finalized?: boolean; skipped?: boolean };
      if (e.finalized) finalized++;
      else if (e.skipped) skipped++;
      else inProgress++;
    }
    lines.push(
      `[Preload] reorderBuf:${ps.reorderSessions}sess/${ps.reorderChunks}ch/${(ps.reorderBytes / 1048576).toFixed(2)}MB`,
    );
    lines.push(
      `          sessionState:${sessionState.size} (final:${finalized}/skip:${skipped}/active:${inProgress}) | ackSent:${ackSent.size} | latestSid:${ps.latestSessionId}`,
    );
  } catch {
    /* ignore */
  }

  // ── RAM Store ──
  try {
    const rs = ramStats();
    const totalRamBytes = rs.mainBytes + rs.preloadBytes;
    const mainSlots = rs.mainBytes > 0 ? 1 : 0;
    trackedBytes += totalRamBytes;
    lines.push(
      `[RamStore] main:${(rs.mainBytes / 1048576).toFixed(2)}MB preload:${(rs.preloadBytes / 1048576).toFixed(2)}MB`,
    );
    lines.push(
      `           slots:${mainSlots + rs.preloadCount} (preload:${rs.preloadCount}, final:${rs.finalizedCount}, active:${rs.inFlightCount})`,
    );
  } catch {
    /* ignore */
  }

  // ── Network ──
  try {
    const peers = (getState('network.connectedPeers') || []) as ConnectedPeer[];
    const openPeers = peers.filter((p) => (p.conn as { open?: boolean } | undefined)?.open).length;
    const hostConn = getState('network.hostConn') as { open?: boolean } | null;
    lines.push(
      `[Network] hostConn:${hostConn?.open ? 'open' : hostConn ? 'closed' : 'none'} | peers:${peers.length}(${openPeers} open)`,
    );
  } catch {
    /* ignore */
  }

  // ── Lifecycle ──
  try {
    const lifecycle = getState('playback.lifecycle') || '?';
    const loadSource = getState('playback.loadSource') || 'none';
    const target = getState('playback.pendingRecoveryTarget');
    const failed = (getState('playback.failedTrackKeys') as Set<string>) || new Set();
    lines.push(`[Lifecycle] ${lifecycle} (loadSource:${loadSource}) | failedTracks:${failed.size}`);
    if (target) {
      lines.push(
        `            recoveryTarget: qid:${target.queueItemId} idxHint:${target.indexHint} name:${target.name || '-'}`,
      );
    }
  } catch {
    /* ignore */
  }

  // ── Tracked Total (sum of the logical byte counters above) ──
  // This is diagnostic inventory, not a heap lower bound: backing storage may
  // be external, references may be counted twice, and engine/DOM costs are not
  // included. Compare component lines and post-cleanup baselines together.
  lines.push(`[Tracked] sum of above: ${(trackedBytes / 1048576).toFixed(1)}MB`);

  return { lines, heapMB, storageMB };
}

// ─── Live Debug Session ──────────────────────────────────────────
// One overlay at a time; reopening replaces the prior session. The
// session owns the polling timer and the time-series history so the
// graph survives across sample updates without sliding off the left.

interface DebugSession {
  overlay: HTMLElement;
  pre: HTMLPreElement;
  heapCanvas: HTMLCanvasElement;
  storageCanvas: HTMLCanvasElement;
  /** Bounded cumulative histories retain the complete session time span. */
  heapHistory: DebugMemoryGraphHistory;
  storageHistory: DebugMemoryGraphHistory;
  pollInFlight: boolean;
  cleanup: () => void;
}

let _activeDebugSession: DebugSession | null = null;
const DEBUG_POLL_TIMER = 'debug-memory-poll';
const DEBUG_POLL_INTERVAL_MS = 1000;

function stopDebugMemorySession(): void {
  if (!_activeDebugSession) return;
  try {
    _activeDebugSession.cleanup();
  } catch {
    /* ignore */
  }
  _activeDebugSession = null;
}

// Render the memory snapshot as a fullscreen translucent overlay with
// live-updating text + heap/storage graphs. Self-contained (no static
// markup in index.html keeps this stealth-feature isolated). Polling
// stops when the overlay is dismissed (tap / ESC).
function startDebugMemorySession(initial: MemSnapshot): void {
  stopDebugMemorySession();
  closeActiveTextDebugOverlay();

  // Drop any zombie overlay from a prior crash where cleanup didn't run.
  const existing = document.getElementById('debug-memory-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'debug-memory-overlay';
  overlay.className = 'debug-memory-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Debug memory live overlay');

  const pre = document.createElement('pre');
  pre.className = 'debug-memory-content';
  pre.textContent = initial.lines.join('\n');
  overlay.appendChild(pre);

  // Graph block sits between the text and the dismiss hint. Two stacked
  // canvases so each has independent Y-scaling — heap can swing 50–500MB
  // while storage hovers at 6GB without one squashing the other.
  const graphs = document.createElement('div');
  graphs.className = 'debug-memory-graphs';

  const heapCanvas = appendGraphRow(graphs, 'Heap MB', '#ffb454');
  const storageCanvas = appendGraphRow(graphs, 'Storage MB', '#5fc8ff');

  overlay.appendChild(graphs);

  const hint = document.createElement('div');
  hint.className = 'debug-memory-hint';
  hint.textContent = 'tap to close · live 1s';
  overlay.appendChild(hint);

  const session: DebugSession = {
    overlay,
    pre,
    heapCanvas,
    storageCanvas,
    heapHistory: createDebugMemoryGraphHistory(initial.heapMB),
    storageHistory: createDebugMemoryGraphHistory(initial.storageMB),
    pollInFlight: false,
    cleanup: () => {
      /* replaced below */
    },
  };

  // Polling loop — managed timer so standard teardown channels can stop it
  // if the page navigates away with the overlay still mounted.
  setManagedTimer(
    DEBUG_POLL_TIMER,
    () => {
      // A callback already queued before replacement must not tear down or
      // sample the newer session that now owns the shared timer name.
      if (_activeDebugSession !== session) return;
      if (!document.body.contains(overlay)) {
        stopDebugMemorySession();
        return;
      }
      if (session.pollInFlight) return;
      session.pollInFlight = true;
      tickDebugMemorySession(session)
        .catch((error) => {
          log.warn('[Debug] Memory polling failed', error);
        })
        .finally(() => {
          session.pollInFlight = false;
        });
    },
    DEBUG_POLL_INTERVAL_MS,
    { interval: true },
  );

  // Resize handler — keep canvas backing-store in sync with CSS width on
  // device rotation. Without this the graphs render blurry after rotate.
  const onResize = (): void => {
    syncCanvasSize(heapCanvas);
    syncCanvasSize(storageCanvas);
    drawAccumulatingGraph(
      heapCanvas,
      session.heapHistory,
      '#ffb454',
      session.heapHistory.sampleCount === 0,
    );
    drawAccumulatingGraph(storageCanvas, session.storageHistory, '#5fc8ff', false);
  };
  window.addEventListener('resize', onResize);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      stopDebugMemorySession();
    }
  };
  overlay.addEventListener('click', () => stopDebugMemorySession());
  document.addEventListener('keydown', onKey);

  session.cleanup = () => {
    clearManagedTimer(DEBUG_POLL_TIMER);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
  };

  document.body.appendChild(overlay);
  // After mount: size the canvases from their actual layout width.
  syncCanvasSize(heapCanvas);
  syncCanvasSize(storageCanvas);
  drawAccumulatingGraph(
    heapCanvas,
    session.heapHistory,
    '#ffb454',
    session.heapHistory.sampleCount === 0,
  );
  drawAccumulatingGraph(storageCanvas, session.storageHistory, '#5fc8ff', false);

  _activeDebugSession = session;
}

async function tickDebugMemorySession(session: DebugSession): Promise<void> {
  const next = await collectMemorySnapshot();
  // Bail if the user dismissed during the await — overlay is gone.
  if (_activeDebugSession !== session) return;

  session.pre.textContent = next.lines.join('\n');
  appendDebugMemoryGraphSample(session.heapHistory, next.heapMB);
  appendDebugMemoryGraphSample(session.storageHistory, next.storageMB);

  drawAccumulatingGraph(
    session.heapCanvas,
    session.heapHistory,
    '#ffb454',
    session.heapHistory.sampleCount === 0,
  );
  drawAccumulatingGraph(session.storageCanvas, session.storageHistory, '#5fc8ff', false);
}

function appendGraphRow(parent: HTMLElement, label: string, color: string): HTMLCanvasElement {
  const row = document.createElement('div');
  row.className = 'debug-memory-graph-row';

  const labelEl = document.createElement('div');
  labelEl.className = 'debug-memory-graph-label';
  labelEl.textContent = label;
  labelEl.style.color = color;
  row.appendChild(labelEl);

  const canvas = document.createElement('canvas');
  canvas.className = 'debug-memory-graph';
  // Backing-store size is set at mount time once layout is known; CSS
  // controls displayed size.
  canvas.width = 1;
  canvas.height = 1;
  row.appendChild(canvas);

  parent.appendChild(row);
  return canvas;
}

function syncCanvasSize(canvas: HTMLCanvasElement): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Guard against zero-rect (overlay not yet laid out). The resize listener
  // corrects on first real layout pass.
  const cssW = Math.max(1, Math.round(rect.width));
  const cssH = Math.max(1, Math.round(rect.height));
  const w = cssW * dpr;
  const h = cssH * dpr;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

// Cumulative-since-start renderer. Bounded min/max downsampling keeps the
// complete session time span, and original sample indexes keep the X axis
// truthful after compaction. Y autoscales against the exact running max.
function drawAccumulatingGraph(
  canvas: HTMLCanvasElement,
  history: DebugMemoryGraphHistory,
  color: string,
  unavailable: boolean,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ctx.clearRect(0, 0, w, h);

  // Faint baseline so an empty graph still has structure.
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - 0.5);
  ctx.lineTo(w, h - 0.5);
  ctx.stroke();

  if (unavailable) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = `${10 * dpr}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N/A (Safari/iOS)', w / 2, h / 2);
    return;
  }
  const points = history.points;
  if (points.length === 0 || history.currentValue === null) return;

  // Y headroom + minimum scale so a flat-zero series doesn't divide by zero.
  const max = Math.max((history.maxValue ?? 0) * 1.1, 1);
  const sampleSpan = Math.max(1, history.sampleCount - 1);
  const xOf = (point: DebugMemoryGraphHistory['points'][number]): number =>
    history.sampleCount === 1 ? w / 2 : (point.sampleIndex / sampleSpan) * w;

  // Filled area beneath the line for visual weight.
  ctx.fillStyle = color + '33';
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (const point of points) {
    const y = h - (point.value / max) * h;
    ctx.lineTo(xOf(point), y);
  }
  const latest = points[points.length - 1];
  if (!latest) return;
  ctx.lineTo(xOf(latest), h);
  ctx.closePath();
  ctx.fill();

  // Line on top of the fill.
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, 1.2 * dpr);
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!point) continue;
    const x = xOf(point);
    const y = h - (point.value / max) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Current value + sample count, top-right corner.
  ctx.fillStyle = color;
  ctx.font = `${10 * dpr}px ui-monospace, monospace`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(
    `${history.currentValue.toFixed(1)} (n=${history.sampleCount})`,
    w - 4 * dpr,
    2 * dpr,
  );
}
