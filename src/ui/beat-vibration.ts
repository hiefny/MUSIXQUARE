/**
 * MUSIXQUARE 3.0 — Beat Vibration FX
 *
 * On every 'beat:pulse' event, applies a quick CSS transform
 * jitter to the header app logo. Snaps back via CSS transition.
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';

// ─── Config ──────────────────────────────────────────────────────

const SCALE_UP = 1.08;
const VIBRATION_MS = 120;

// ─── State ───────────────────────────────────────────────────────

let _logo: HTMLElement | null = null;
let _ready = false;

// ─── Init ────────────────────────────────────────────────────────

export function initBeatVibration(): void {
  bus.on('beat:pulse', onBeat);
  log.info('[BeatVibration] Initialized');
}

function ensureLogo(): boolean {
  if (_ready) return !!_logo;
  _ready = true;
  _logo = document.querySelector<HTMLElement>('.app-logo');
  if (_logo) {
    _logo.style.transition = `transform ${VIBRATION_MS}ms cubic-bezier(.25,.1,.25,1)`;
    _logo.style.willChange = 'transform';
    _logo.style.transformOrigin = 'center center';
  }
  return !!_logo;
}

// ─── Beat handler ────────────────────────────────────────────────

function onBeat(): void {
  if (!ensureLogo()) return;

  _logo!.style.transform = `scale(${SCALE_UP})`;
  setTimeout(() => { _logo!.style.transform = 'scale(1)'; }, VIBRATION_MS);
}
