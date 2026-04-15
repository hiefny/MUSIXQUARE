/**
 * MUSIXQUARE 3.0 — Party Mode (Visual Feedback)
 * 
 * Emergency Refactor:
 * - REMOVED all UI bouncing/scaling as it interferes with touch interactions.
 * - ADDED dynamic background pulsing synchronized with the beat.
 * - Pulse color: Blue for Light mode, White for Dark mode.
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { isPartyMode } from '../audio/beat-detector.ts';

// ─── Config ─────────────────────────────────────────────────────

const FADE_MS = 500;

// ─── State ───────────────────────────────────────────────────────

let _overlay: HTMLDivElement | null = null;
let _overlayReady = false;

// ─── Init ────────────────────────────────────────────────────────

export function initBeatVibration(): void {
  bus.on('beat:pulse', onBeat);
  log.info('[PartyMode] Initialized (Ambient Lighting Mode)');
}

function ensureOverlay(): boolean {
  if (_overlayReady) return !!_overlay;
  _overlayReady = true;

  _overlay = document.createElement('div');
  _overlay.id = 'party-flash-overlay';
  _overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'pointer-events:none',
    'z-index:9999',
    'opacity:0',
    'will-change:opacity',
  ].join(';');

  document.body.prepend(_overlay);
  return true;
}

// ─── Beat handler ────────────────────────────────────────────────

function onBeat(): void {
  if (!isPartyMode()) return;

  if (ensureOverlay()) {
    // Determine Flash params based on Theme
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    const isLight = theme === 'light';
    
    // Light Mode requires higher opacity to be visible against bright backgrounds
    const opacity = isLight ? 0.35 : 0.12;
    const color = isLight ? '#f0f8ff' : '#ffffff'; // Subtle cool-white for Light mode punch
    
    _overlay!.style.backgroundColor = color;
    _overlay!.style.transition = 'none';
    _overlay!.style.opacity = String(opacity);
    
    // Force reflow
    void _overlay!.offsetWidth;
    
    // Smooth Fade out (Ambient Long-Tail)
    _overlay!.style.transition = `opacity ${FADE_MS}ms cubic-bezier(.05, .7, .1, 1)`;
    _overlay!.style.opacity = '0';
  }
}
