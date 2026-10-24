/**
 * A Standard-room guest's last logical-connection close, kept across the
 * reload that ends its session (Phase 4 4B, owner decision P4-D5 B,
 * 2026-10-25).
 *
 * The Standard transport notes the first cause of every logical close (RO-15,
 * the 4A "Logical connection closed" info line). When the guest's disconnect
 * dialog reloads the page, or the page reloads after the host removed the
 * guest, setup keeps the page's last close in this tab's sessionStorage, and
 * the next page logs it once as an info line for `/debug console` and removes
 * it. Only the cause token and the close time are kept: no peer id, no room
 * code, no network traffic, no UI besides `/debug`. Storage may be refused
 * (iOS Safari private mode); the line is then absent and nothing else changes.
 */

import { log } from '../core/log.ts';
import { PREVIOUS_LINK_CLOSE_KEY } from '../core/navigation-contract.ts';

let lastClose = '';

/** Notes a logical connection's first close cause, at the time it closed. */
export function noteLinkClose(cause: string): void {
  lastClose = `${cause} ${Date.now()}`;
}

/** Keeps this page's last close, if any, for the next page in this tab. */
export function keepLinkCloseForNextPage(): void {
  if (!lastClose) return;
  try {
    sessionStorage.setItem(PREVIOUS_LINK_CLOSE_KEY, lastClose);
  } catch {
    // Refused storage only drops this diagnostic line.
  }
}

/** Logs the previous page's kept close once, then removes it. */
export function reportPreviousPageClose(): void {
  let kept: string | null;
  try {
    kept = sessionStorage.getItem(PREVIOUS_LINK_CLOSE_KEY);
    if (kept === null) return;
    sessionStorage.removeItem(PREVIOUS_LINK_CLOSE_KEY);
  } catch {
    return;
  }
  // A cause token and a millisecond time before the year 2287 (4-digit years).
  const [, cause, closedAt] = /^([a-z:-]{1,40}) (\d{1,13})$/u.exec(kept) ?? [];
  if (!cause || !closedAt) return;
  const time = new Date(Number(closedAt)).toISOString().slice(11, 19);
  log.info(`[Transport] Previous page closed (${cause}) at ${time} UTC`);
}
