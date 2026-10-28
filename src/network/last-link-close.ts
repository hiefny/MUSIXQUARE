/**
 * A Standard-room guest's last logical-connection close, kept across the
 * reload that ends its session (Phase 4 4B, owner decision P4-D5 B,
 * 2026-10-25).
 *
 * The Standard transport notes the first cause of every logical close (RO-15,
 * the 4A "Logical connection closed" info line). When the guest's disconnect
 * dialog or the lost-session dialog (network/peer.ts) reloads the page, or the
 * page reloads after the host removed the guest, the page keeps its last close
 * in this tab's sessionStorage, and the next page in the tab that logs info
 * lines logs it once for `/debug console` and removes it. It is the page's most recent Standard close,
 * which its time identifies, not necessarily the host link's: the removal
 * reload is decided while that link is still open, so it usually keeps an
 * earlier close or nothing. Only the cause token and the close time are kept:
 * no peer id, no room code, no network traffic, no UI besides `/debug`.
 * Storage may be refused (iOS Safari private mode); the line is then absent
 * and nothing else changes.
 */

import { log, logsInfo } from '../core/log.ts';
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

/**
 * Logs the previous page's kept close once, then removes it. A page that logs
 * no info lines leaves it for the next page in this tab that does: production
 * logs at WARN, and the joined guest's address has lost ?mxqrLog=info by the
 * time its disconnect reload lands.
 */
export function reportPreviousPageClose(): void {
  if (!logsInfo()) return;
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
