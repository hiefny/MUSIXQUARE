/**
 * MUSIXQUARE 2.0 — Shared Type Definitions
 */

// ─── App State Machine ─────────────────────────────────────────────
export const enum AppState {
  IDLE = 'IDLE',
  PAUSED = 'PAUSED',
  PLAYING_AUDIO = 'PLAYING_AUDIO',
  PLAYING_VIDEO = 'PLAYING_VIDEO',
  PLAYING_YOUTUBE = 'PLAYING_YOUTUBE',
}

export const enum TransferState {
  IDLE = 'IDLE',
  RECEIVING = 'RECEIVING',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
}

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
  videoId?: string | null;
  playlistId?: string | null;
  isExpanded?: boolean;
}

export interface PlaylistMetaItem {
  type: string | undefined;
  name: string;
  videoId: string | null;
  playlistId: string | null;
}

// ─── Worker Messages ───────────────────────────────────────────────
export interface WorkerCommand {
  command: string;
  id?: string;
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
}

// ─── Audio Settings ────────────────────────────────────────────────
export interface AudioSettings {
  masterVolume: number;
  preMuteVolume: number;
  reverbMix: number;
  reverbDecay: number;
  reverbPreDelay: number;
  reverbLowCut: number;
  reverbHighCut: number;
  reverbType: string;
  eqValues: number[];
  stereoWidth: number;
  virtualBass: number;
  subFreq: number;
  userPreampGain: number;
}

// ─── Device List ───────────────────────────────────────────────────
export interface DeviceInfo {
  id: string;
  label: string;
  isOp: boolean;
  isHost: boolean;
}

// ─── Dialog ────────────────────────────────────────────────────────
export interface DialogOptions {
  title: string;
  message: string;
  buttonText?: string;
  dismissible?: boolean;
  cancelText?: string;
}

export interface DialogResult {
  action: 'ok' | 'cancel' | 'dismiss';
}

// ─── EventBus typed events ─────────────────────────────────────────
export interface EventMap {
  // Audio
  'audio:ready': [];
  'audio:effects-changed': [setting: string, value: number];
  'audio:channel-changed': [mode: ChannelMode];
  // Network
  'network:peer-ready': [peerId: string];
  'network:peer-connected': [conn: DataConnection];
  'network:peer-disconnected': [peerId: string];
  'network:data': [data: unknown, conn: DataConnection];
  'network:error': [error: unknown];
  // Storage
  'storage:opfs-ready': [];
  'storage:file-ready': [filename: string, sessionId: number];
  'storage:transfer-progress': [progress: number, total: number];
  'storage:preload-ready': [index: number];
  // Player
  'player:play': [offset: number];
  'player:pause': [position: number];
  'player:stop': [];
  'player:ended': [];
  'player:track-changed': [index: number];
  'player:state-changed': [state: AppState, prev: AppState];
  'player:position': [position: number, duration: number];
  // YouTube
  'youtube:play': [videoId: string];
  'youtube:stop': [];
  'youtube:state-changed': [state: number];
  // UI
  'ui:play-clicked': [];
  'ui:pause-clicked': [];
  'ui:seek': [position: number];
  'ui:volume-changed': [volume: number];
  'ui:tab-changed': [tabId: string];
  'ui:theme-changed': [theme: string];
  // State
  [key: `state:${string}`]: [value: unknown, path: string];
}
