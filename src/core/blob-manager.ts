/**
 * MUSIXQUARE — Blob URL Manager
 *
 * Centralized Blob URL lifecycle management to prevent memory leaks.
 * Historically supported deferred revocation while a URL was attached to a
 * local <video>; since local-video playback was dropped, nothing holds a
 * long-lived reference to these URLs and the defer branch is a no-op.
 */

import { DELAY } from './constants.ts';
import { log } from './log.ts';

interface RevokeOptions {
  delayMs?: number;
  force?: boolean;
}

export const BlobURLManager = {
  _activeURL: null as string | null,
  _preparingURL: null as string | null,
  _pendingRevocations: new Map<string, ReturnType<typeof setTimeout>>(),
  _deferredUntilDetached: new Set<string>(),
  MAX_PENDING: 5,

  _isUrlAttached(_url: string): boolean {
    // Local <video> was removed; blob URLs are never attached to a live element.
    return false;
  },

  _clearScheduled(url: string): void {
    const t = this._pendingRevocations.get(url);
    if (t) {
      try { clearTimeout(t); } catch { /* */ }
    }
    this._pendingRevocations.delete(url);
  },

  _revokeNow(url: string | null, reason = ''): void {
    if (!url) return;
    this._clearScheduled(url);
    this._deferredUntilDetached.delete(url);

    try {
      URL.revokeObjectURL(url);
      log.debug(`[BlobURL] Revoked: ${url}${reason ? ` (${reason})` : ''}`);
    } catch (e) {
      log.debug('[BlobURL] Revoke failed (non-critical):', e);
    }

    if (this._activeURL === url) this._activeURL = null;
    if (this._preparingURL === url) this._preparingURL = null;
  },

  /**
   * Create a new Blob URL in 'Preparing' state.
   */
  create(blob: Blob): string | null {
    if (!blob) return null;

    if (this._preparingURL) {
      this._revokeNow(this._preparingURL, 'abandoned-preparing');
    }

    this._preparingURL = URL.createObjectURL(blob);
    log.debug(`[BlobURL] Prepared: ${this._preparingURL}`);
    return this._preparingURL;
  },

  /**
   * Confirm the prepared URL as the active one.
   */
  confirm(): void {
    if (!this._preparingURL) return;

    const nextUrl = this._preparingURL;
    const prevUrl = this._activeURL;

    this._activeURL = nextUrl;
    this._preparingURL = null;

    if (prevUrl && prevUrl !== nextUrl) {
      this.safeRevoke(prevUrl);
    }

    log.debug(`[BlobURL] Confirmed Active: ${this._activeURL}`);

    // Auto-flush deferred URLs that are no longer attached after source change
    if (this._deferredUntilDetached.size) {
      this.flushDeferred('post-confirm');
    }
  },

  /**
   * Schedule a URL for revocation after a safety delay.
   */
  safeRevoke(url: string | null, options?: RevokeOptions): void {
    if (!url) return;

    const force = options?.force === true;
    const delayMs = (typeof options?.delayMs === 'number' && options.delayMs >= 0)
      ? options.delayMs
      : DELAY.BLOB_REVOCATION;

    if (!force && this._pendingRevocations.has(url)) return;

    if (!force && this._isUrlAttached(url)) {
      this._deferredUntilDetached.add(url);
      log.debug(`[BlobURL] Deferred revocation (still attached): ${url}`);
      return;
    }

    // Queue overflow protection — evict oldest non-attached URL, or force-revoke if all attached
    if (this._pendingRevocations.size >= this.MAX_PENDING) {
      let evicted = false;
      for (const candidate of this._pendingRevocations.keys()) {
        if (!this._isUrlAttached(candidate)) {
          this._revokeNow(candidate, 'queue-overflow');
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        // All pending are attached — defer oldest to prevent unbounded growth
        const oldest = this._pendingRevocations.keys().next().value;
        if (oldest) {
          this._clearScheduled(oldest);
          this._deferredUntilDetached.add(oldest);
        }
      }
    }

    if (delayMs === 0) {
      this._revokeNow(url, 'delay=0');
      return;
    }

    this._clearScheduled(url);
    const t = setTimeout(() => {
      this._revokeNow(url, 'scheduled');
    }, delayMs);
    this._pendingRevocations.set(url, t);
    log.debug(`[BlobURL] Scheduled for revocation (${delayMs}ms): ${url}`);
  },

  /**
   * Flush deferred URLs that are no longer attached to <video>.
   */
  flushDeferred(reason = ''): void {
    if (!this._deferredUntilDetached.size) return;

    const urls = Array.from(this._deferredUntilDetached);
    let flushed = 0;

    for (const url of urls) {
      if (!this._isUrlAttached(url)) {
        this._deferredUntilDetached.delete(url);
        this.safeRevoke(url, { force: true });
        flushed++;
      }
    }

    if (flushed) log.debug(`[BlobURL] Flushed deferred: ${flushed}${reason ? ` (${reason})` : ''}`);
  },

  /**
   * Revoke the currently active/preparing URL (deferred if attached).
   */
  revoke(options?: RevokeOptions): void {
    if (this._preparingURL) {
      this.safeRevoke(this._preparingURL, { force: true, delayMs: 0 });
    }
    if (this._activeURL) {
      this.safeRevoke(this._activeURL, options);
    }
  },

  /**
   * Force revoke everything. Use ONLY after detaching media sources.
   */
  revokeAllNow(reason = 'force'): void {
    for (const url of Array.from(this._pendingRevocations.keys())) {
      this._revokeNow(url, reason);
    }
    for (const url of Array.from(this._deferredUntilDetached)) {
      this._revokeNow(url, reason);
    }
    if (this._activeURL) this._revokeNow(this._activeURL, reason);
    if (this._preparingURL) this._revokeNow(this._preparingURL, reason);

    this._pendingRevocations.clear();
    this._deferredUntilDetached.clear();
    this._activeURL = null;
    this._preparingURL = null;
  },

  /** Get the currently active URL (read-only) */
  get activeURL(): string | null {
    return this._activeURL;
  },
};
