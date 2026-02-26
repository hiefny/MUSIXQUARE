/**
 * MUSIXQUARE 2.0 — Shared Type Definitions
 */

// NOTE: AppState / TransferState live in core/constants.ts (APP_STATE, TRANSFER_STATE).
//       Removed duplicate const enums that were never imported.

import type { AppStateValue } from '../core/constants.ts';

// ─── Channel Modes ─────────────────────────────────────────────────
/** -1 = Left, 0 = Stereo/Original, 1 = Right, 2 = Sub/LFE */
export type ChannelMode = -1 | 0 | 1 | 2;

// ─── Peer / Network ────────────────────────────────────────────────
export interface PeerSlot {
  id: string;
  slot: number;
  label: string;
  conn: DataConnection | null;
  isOp: boolean;
  preloadedIndexes: Set<number>;
  status: 'connecting' | 'connected' | 'disconnected';
}

/* eslint-disable @typescript-eslint/no-explicit-any -- PeerJS external API boundary */

/** PeerJS DataConnection (minimal typing for our use) */
export interface DataConnection {
  peer: string;
  open: boolean;
  metadata?: Record<string, unknown>;
  send(data: unknown): void;
  close(): void;
  on(event: string, fn: (...args: any[]) => void): void;
  once(event: string, fn: (...args: any[]) => void): void;
  off(event: string, fn: (...args: any[]) => void): void;
  dataChannel?: RTCDataChannel;
  // Relay extensions
  _relayQueue?: unknown[];
  _relayBusy?: boolean;
}

/** Peer instance (minimal PeerJS typing) */
export interface PeerInstance {
  id: string;
  open: boolean;
  on(event: string, fn: (...args: any[]) => void): void;
  once(event: string, fn: (...args: any[]) => void): void;
  off(event: string, fn: (...args: any[]) => void): void;
  connect(id: string, options?: Record<string, unknown>): DataConnection;
  destroy(): void;
  disconnect(): void;
  reconnect(): void;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── File Transfer ─────────────────────────────────────────────────
export interface FileMeta {
  name: string;
  type: string;
  index: number;
  size: number;
  mime: string;
  sessionId: number;
  total: number;
}

export interface PreloadSessionEntry {
  skipped: boolean;
  progress: number;
  total: number;
  name: string;
  index: number;
  size: number;
  mime: string;
  nextExpectedChunk: number;
  finalized: boolean;
}

// ─── Playlist ──────────────────────────────────────────────────────
export interface PlaylistItem {
  type: 'file' | 'youtube';
  file?: File;
  name: string;
  title?: string;
  artist?: string;
  thumbnail?: string;
  videoId?: string | null;
  playlistId?: string | null;
  isExpanded?: boolean;
}

// ─── Worker Messages ───────────────────────────────────────────────
export interface WorkerCommand {
  command: string;
  id?: string;
  interval?: number;
  filename?: string;
  sessionId?: number;
  index?: number;
  chunk?: ArrayBuffer;
  isPreload?: boolean;
  requestId?: string;
  total?: number;
  totalSize?: number;
  size?: number;
  keepExisting?: boolean;
  instanceId?: string;
}

export interface WorkerResponse {
  type: string;
  filename?: string;
  sessionId?: number;
  index?: number;
  chunk?: ArrayBuffer;
  isPreload?: boolean;
  requestId?: string;
  error?: string;
  command?: string;
}

// ─── Device List ───────────────────────────────────────────────────
export interface DeviceInfo {
  id: string;
  label: string;
  isOp: boolean;
  isHost: boolean;
}

// ─── EventBus typed events ─────────────────────────────────────────
export interface EventMap {
  // ── Audio ─────────────────────────────────────────────────────────
  'audio:ready': [];
  'audio:activate': [];
  'audio:set-volume': [volume: number];
  'audio:volume-changed': [volume: number];
  'audio:apply-youtube-volume': [];
  'audio:connect-surround': [playerNode: unknown, channelIdx: number];
  'audio:set-channel-mode': [mode: number];
  'audio:toggle-surround': [enabled: boolean];
  'audio:set-surround-channel': [idx: number];
  'audio:update-effect': [type: string, param: string, value: number, isPreview?: boolean];
  'audio:set-preamp': [value: number, isPreview?: boolean];
  'audio:set-eq': [band: number, value: number, isPreview?: boolean];
  'audio:reset-reverb': [];
  'audio:reset-eq': [];
  'audio:reset-stereo': [];
  'audio:reset-vbass': [];
  'audio:surround-toggled': [];
  'audio:channel-changed': [mode: ChannelMode];

  // ── Player ────────────────────────────────────────────────────────
  'player:ended': [];
  'player:state-changed': [state: AppStateValue, prev?: AppStateValue];
  'player:toggle-play': [];
  'player:seek': [time: number];
  'player:seek-to-time': [time: number];
  'player:stop-all-media': [];
  'player:metadata-update': [item: PlaylistItem];
  'player:sync-video-volume': [volume: number];
  'player:check-ended': [];

  // ── Playlist ──────────────────────────────────────────────────────
  'playlist:prev-track': [];
  'playlist:next-track': [];
  'playlist:toggle-repeat': [];
  'playlist:toggle-shuffle': [];
  'playlist:set-repeat-mode': [mode: number, notify?: boolean];
  'playlist:set-shuffle': [enabled: boolean, notify?: boolean];
  'playlist:play-track': [index: number];

  // ── UI ────────────────────────────────────────────────────────────
  'ui:show-toast': [message: string];
  'ui:show-loader': [visible: boolean, label?: string];
  'ui:update-loader': [percent: number];
  'ui:update-playlist': [];
  'ui:play-btn-state': [enabled: boolean];
  'ui:update-play-state': [playing: boolean];
  'ui:duration-update': [duration: number];
  'ui:seek-reset': [];
  'ui:loop-start': [];
  'ui:time-update': [currentFormatted: string, totalFormatted: string, currentTime: number, duration: number];
  'ui:switch-tab': [tabId: string];
  'ui:settings-tab-opened': [];
  'ui:visualizer-check': [];
  'ui:close-chat-drawer': [];
  'ui:toggle-chat-drawer': [];
  'chat:system-message': [text: string];

  // ── YouTube ───────────────────────────────────────────────────────
  'youtube:load': [videoId: string | null, playlistId: string | null, isSync?: boolean, startTime?: number];
  'youtube:toggle-play': [];
  'youtube:auto-play': [];
  'youtube:get-position': [callback: (pos: number) => void];
  'youtube:stop-playback': [];
  'youtube:skip-time': [seconds: number];
  'youtube:seek-to': [seconds: number];
  'youtube:try-next-internal': [callback: (success: boolean) => void];
  'youtube:try-prev-internal': [callback: (success: boolean) => void];
  'youtube:broadcast-sync': [];
  'youtube:preview': [url: string];
  'youtube:load-from-input': [];
  'youtube:load-from-chat': [url: string];
  'youtube:stop-mode': [];
  'youtube:refresh-display': [];
  'youtube:set-volume': [volumePercent: number];
  'youtube:sub-seek': [playlistIdx: number, subIdx: number, isCurrent: boolean];
  'youtube:populate-sub-items': [playlistId: string | null, playlistIdx: number];

  // ── Network ───────────────────────────────────────────────────────
  'network:peer-ready': [peerId: string];
  'network:peer-connected': [conn: DataConnection];
  'network:peer-disconnected': [peerId: string];
  'network:data': [data: unknown, conn: DataConnection];
  'network:error': [error: unknown];
  'network:broadcast': [data: unknown];
  'network:broadcast-except': [peerId: string, data: unknown];
  'network:toggle-operator': [peerId: string];
  'network:device-list': [list: unknown[]];
  'network:device-list-update': [list: unknown[]];
  'network:role-badge-update': [];
  'network:session-full': [msg: unknown];
  'network:kicked-from-session': [];

  // ── Storage / OPFS ────────────────────────────────────────────────
  'storage:transfer-progress': [progress: number, total: number];
  'storage:preload-ready': [index: number];
  'storage:request-recovery': [];
  'storage:clear-previous-track': [context: string];
  'storage:use-preloaded': [index: number, name: string];
  'storage:preload-file-ready': [filename: string, sessionId: number];
  'opfs:file-ready': [filename: string, sessionId: number, isPreload: boolean];
  'opfs:read-complete': [data: unknown];
  'opfs:read-error': [data: unknown];
  'opfs:error': [error: string, filename: string];
  'opfs:session-mismatch': [data: unknown];

  // ── Blob ──────────────────────────────────────────────────────────
  'blob:revoke-all': [];

  // ── Sync ──────────────────────────────────────────────────────────
  'sync:display-update': [];
  'sync:nudge': [ms: number];
  'sync:nudge-apply': [ms: number];
  'sync:auto-sync': [];
  'sync:close-manual': [];
  'sync:get-position': [callback: (pos: number) => void];
  'sync:response': [hostTime: number, isPlaying: boolean, oneWayLatencyMs: number];
  'sync:latency-update': [ms: number];
  'sync:youtube-nudge': [ms: number];

  // ── Relay ─────────────────────────────────────────────────────────
  'relay:incoming-connection': [conn: DataConnection];
  'relay:serve-current-file': [conn: DataConnection, msg: unknown];
  'relay:serve-recovery': [conn: DataConnection, msg: unknown];

  // ── Setup ─────────────────────────────────────────────────────────
  'setup:hide-overlay': [];
  'setup:guest-join-success': [];
  'setup:guest-join-failure': [error: unknown];

  // ── App ───────────────────────────────────────────────────────────
  'app:return-to-main': [];
  'app:load-demo': [];
  'app:files-selected': [files: FileList | null];

  // ── Visualizer ────────────────────────────────────────────────────
  'visualizer:start': [];

  // ── Dynamic State ─────────────────────────────────────────────────
  [key: `state:${string}`]: [value: unknown];
}
