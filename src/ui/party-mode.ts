/**
 * MUSIXQUARE 3.0 — Beat Pulse FX (Party Mode)
 *
 * When party mode is active (/party on):
 *   - Background brightness pulse on each beat
 *   - ALL visible elements jitter randomly on each beat (earthquake)
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { isPartyMode } from '../audio/beat-detector.ts';

// ─── Config ─────────────────────────────────────────────────────

const FLASH_OPACITY = 0.12;
const FADE_MS = 300;
const SHAKE_TRANSLATE = 0.5;   // px
const SHAKE_ROTATE = 0.2;      // deg
const SHAKE_CYCLES = 2;        // oscillation count per beat
const SHAKE_CYCLE_MS = 25;     // ms per cycle

// ─── State ───────────────────────────────────────────────────────

let _overlay: HTMLDivElement | null = null;
let _overlayReady = false;
let _quakeElements: HTMLElement[] | null = null;

// ─── Init ────────────────────────────────────────────────────────

export function initBeatVibration(): void {
  bus.on('beat:pulse', onBeat);
  log.info('[BeatVibration] Initialized');
}

// ─── Overlay ────────────────────────────────────────────────────

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

// ─── Earthquake: collect ALL visible elements ────────────────────

function collectElements(): HTMLElement[] {
  const all = document.querySelectorAll<HTMLElement>(
    'header, nav, button, span, div, canvas, svg, a, input, label, h1, h2, h3, p, img, video',
  );
  const result: HTMLElement[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el === _overlay) continue;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
    result.push(el);
  }
  return result;
}

// ─── Beat handler ────────────────────────────────────────────────

function onBeat(): void {
  if (!isPartyMode()) return;

  // Background flash
  if (ensureOverlay()) {
    _overlay!.style.transition = 'none';
    _overlay!.style.opacity = String(FLASH_OPACITY);
    _overlay!.offsetWidth;
    _overlay!.style.transition = `opacity ${FADE_MS}ms cubic-bezier(.1,.6,.3,1)`;
    _overlay!.style.opacity = '0';
  }

  // Shake: 모든 요소 부르르 떨기
  if (!_quakeElements) _quakeElements = collectElements();

  let cycle = 0;
  const shakeStep = (): void => {
    if (!_quakeElements) return;

    if (cycle >= SHAKE_CYCLES) {
      // Reset all transforms
      for (const el of _quakeElements) {
        el.style.transition = `transform ${SHAKE_CYCLE_MS}ms ease-out`;
        el.style.transform = '';
      }
      return;
    }

    // Alternate direction each cycle for tremor feel
    const sign = cycle % 2 === 0 ? 1 : -1;
    for (const el of _quakeElements) {
      const tx = sign * (Math.random() * SHAKE_TRANSLATE);
      const ty = sign * (Math.random() * SHAKE_TRANSLATE) * -1;
      const rot = sign * (Math.random() * SHAKE_ROTATE);
      el.style.transition = 'none';
      el.style.transform = `translate(${tx.toFixed(1)}px,${ty.toFixed(1)}px) rotate(${rot.toFixed(1)}deg)`;
    }

    cycle++;
    setTimeout(shakeStep, SHAKE_CYCLE_MS);
  };

  shakeStep();
}
