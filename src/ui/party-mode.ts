/**
 * MUSIXQUARE 3.0 — Party Mode (Visual Feedback)
 * 
 * High-performance 'Spring Jolt' animation using elastic Bezier curves.
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { isPartyMode } from '../audio/beat-detector.ts';

// ─── Config ─────────────────────────────────────────────────────

const FLASH_OPACITY = 0.12;
const FADE_MS = 300;

// High-speed spring physical constants (Pulse Only)
const JOLT_SCALE = 1.02;      // Constant pulse factor
const JOLT_DURATION_MS = 160; // Settle time
const JOLT_BEZIER = 'cubic-bezier(.17, .89, .32, 1.27)'; // "Back" easing for bouncy feels

// ─── State ───────────────────────────────────────────────────────

let _overlay: HTMLDivElement | null = null;
let _overlayReady = false;

// ─── Init ────────────────────────────────────────────────────────

export function initBeatVibration(): void {
  bus.on('beat:pulse', onBeat);
  log.info('[PartyMode] Initialized');
}

function ensureOverlay(): boolean {
  if (_overlayReady) return !!_overlay;
  _overlayReady = true;

  _overlay = document.createElement('div');
  _overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'pointer-events:none',
    'z-index:0',
    'background:#fff',
    'opacity:0',
    `transition:opacity ${FADE_MS}ms cubic-bezier(.1,.6,.3,1)`,
    'will-change:opacity',
  ].join(';');

  document.body.prepend(_overlay);
  return true;
}

// ─── Beat handler ────────────────────────────────────────────────

function onBeat(): void {
  if (!isPartyMode()) return;

  // 1) Background flash
  if (ensureOverlay()) {
    _overlay!.style.transition = 'none';
    _overlay!.style.opacity = String(FLASH_OPACITY);
    _overlay!.offsetWidth; // Force reflow
    _overlay!.style.transition = `opacity ${FADE_MS}ms cubic-bezier(.1,.6,.3,1)`;
    _overlay!.style.opacity = '0';
  }

  // 2) Beat Pulse (Real-time collection)
  const targets = collectElements();

  for (const el of targets) {
    // Web Animations API (WAAPI)
    // Removed 'fill: forwards' to ensure the animation layer is cleared after finish,
    // allowing native CSS transitions (like toast slides) to work perfectly.
    el.animate([
      { transform: `scale(${JOLT_SCALE})`, offset: 0 },
      { transform: 'scale(1)', offset: 1 }
    ], {
      duration: JOLT_DURATION_MS,
      easing: JOLT_BEZIER
    });
  }
}

// ─── Earthquake: collect ALL visible elements ────────────────────

function collectElements(): HTMLElement[] {
  // Exclude critical UI like header and toast from pulsing to maintain legibility
  const all = document.querySelectorAll<HTMLElement>(
    'header, nav, button, span, div, canvas, svg, a, input, label, h1, h2, h3, p, img, video',
  );
  
  const candidates = Array.from(all);
  const result: HTMLElement[] = [];
  
  for (const el of candidates) {
    if (el === _overlay) continue;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
    
    // EXCLUSIONS: Header (too important), Toasts (transient), Onboarding (setup)
    if (el.tagName === 'HEADER' || el.closest('header')) continue;
    if (el.closest('.toast') || el.closest('[class*="toast"]')) continue;
    if (el.closest('.onboarding-overlay')) continue;
    
    // Only add if no parent of this element is also a candidate.
    // This prevents "Double Scaling" on nested elements.
    let isChildOfCandidate = false;
    for (const other of candidates) {
      if (other !== el && other.contains(el)) {
        isChildOfCandidate = true;
        break;
      }
    }

    if (!isChildOfCandidate) {
      result.push(el);
    }
  }
  return result;
}
