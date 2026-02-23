import { log } from './log.js';
import { DELAY } from './constants.js';

export const BlobURLManager = {
    _activeURL: null,
    _preparingURL: null,

    // url -> timeoutId (scheduled revocation)
    _pendingRevocations: new Map(),

    // If we attempted to revoke while the URL was still attached to <video>,
    // we defer until the source is detached (e.g., stopAllMedia / clearPreviousTrackState).
    _deferredUntilDetached: new Set(),

    // BlobURL Queue: Avoid memory pressure during fast switching (Strict 5)
    MAX_PENDING: 5,

    _normalizeOptions(options) {
        if (!options || typeof options !== 'object') return {};
        return options;
    },

    _isUrlAttached(url) {
        try {
            const vid = document.getElementById('main-video');
            return !!(url && typeof url === 'string' && vid && vid.src === url);
        } catch (_) {
            return false;
        }
    },

    _clearScheduled(url) {
        const t = this._pendingRevocations.get(url);
        if (t) {
            try { clearTimeout(t); } catch (_) { }
        }
        this._pendingRevocations.delete(url);
    },

    _revokeNow(url, reason = '') {
        if (!url) return;

        // Cancel any scheduled revocation first
        this._clearScheduled(url);
        this._deferredUntilDetached.delete(url);

        try {
            URL.revokeObjectURL(url);
            log.debug(`[BlobURL] Revoked: ${url}${reason ? ` (${reason})` : ''}`);
        } catch (e) {
            log.debug('[BlobURL] Revoke failed (non-critical):', e?.message || e);
        }

        if (this._activeURL === url) this._activeURL = null;
        if (this._preparingURL === url) this._preparingURL = null;
    },

    /**
     * Create a new Blob URL in 'Preparing' state.
     * Use confirm() to move it to 'Active' state and schedule previous URL for revocation.
     */
    create(blob) {
        if (!blob) {
            log.warn('[BlobURLManager] create() called with null/undefined blob');
            return null;
        }

        // If we were preparing something else that never got confirmed, revoke it immediately
        if (this._preparingURL) {
            this._revokeNow(this._preparingURL, 'abandoned-preparing');
        }

        this._preparingURL = URL.createObjectURL(blob);
        log.debug(`[BlobURL] Prepared: ${this._preparingURL}`);
        return this._preparingURL;
    },

    /**
     * Confirm the prepared URL as the active one.
     * This schedules the previous active URL for delayed revocation.
     */
    confirm(_blobUnused) {
        if (!this._preparingURL) return;

        const nextUrl = this._preparingURL;
        const prevUrl = this._activeURL;

        this._activeURL = nextUrl;
        this._preparingURL = null;

        // Schedule previous ACTIVE URL for delayed revocation
        if (prevUrl && prevUrl !== nextUrl) {
            this.safeRevoke(prevUrl);
        }

        log.debug(`[BlobURL] Confirmed Active: ${this._activeURL}`);
    },

    /**
     * Schedule a specific URL for revocation after a safety delay.
     * If the URL is still attached to <video>, we defer until detached.
     *
     * @param {string} url
     * @param {object} options  { delayMs?: number, force?: boolean }
     */
    safeRevoke(url, options) {
        if (!url) return;

        const opt = this._normalizeOptions(options);
        const force = opt.force === true;
        const delayMs = (typeof opt.delayMs === 'number' && opt.delayMs >= 0) ? opt.delayMs : DELAY.BLOB_REVOCATION;

        // Already scheduled
        if (this._pendingRevocations.has(url)) return;

        // If it's still attached, don't risk breaking playback/paused state. Defer until detached.
        if (!force && this._isUrlAttached(url)) {
            this._deferredUntilDetached.add(url);
            log.debug(`[BlobURL] Deferred revocation (still attached): ${url}`);
            return;
        }

        // Strict Queue management (Max 5 scheduled revocations)
        if (this._pendingRevocations.size >= this.MAX_PENDING) {
            const oldest = this._pendingRevocations.keys().next().value;
            log.debug(`[BlobURL] Queue full. Revoking oldest immediately: ${oldest}`);
            this._revokeNow(oldest, 'queue-overflow');
        }

        if (delayMs === 0) {
            this._revokeNow(url, 'delay=0');
            return;
        }

        const t = setTimeout(() => {
            this._revokeNow(url, 'scheduled');
        }, delayMs);

        this._pendingRevocations.set(url, t);
        log.debug(`[BlobURL] Scheduled for revocation (${delayMs}ms): ${url}`);
    },

    /**
     * Flush deferred URLs that were blocked because they were still attached to <video>.
     * Call this right after videoElement.src is detached/reset.
     */
    flushDeferred(reason = '') {
        if (!this._deferredUntilDetached.size) return;

        const urls = Array.from(this._deferredUntilDetached);
        let flushed = 0;

        for (const url of urls) {
            if (!this._isUrlAttached(url)) {
                // Force scheduling now that it is detached
                this._deferredUntilDetached.delete(url);
                this.safeRevoke(url, { force: true });
                flushed++;
            }
        }

        if (flushed) log.debug(`[BlobURL] Flushed deferred: ${flushed}${reason ? ` (${reason})` : ''}`);
    },

    /**
     * Attempt to revoke the currently active URL (and any preparing URL).
     * If still attached, it will be deferred until detached.
     */
    revoke(options) {
        // Preparing URL: safe to revoke quickly (it should not be attached yet)
        if (this._preparingURL) {
            this.safeRevoke(this._preparingURL, { force: true, delayMs: 0 });
        }
        if (this._activeURL) {
            this.safeRevoke(this._activeURL, options);
        }
    },

    /**
     * Force revoke everything (use ONLY after detaching media sources).
     */
    revokeAllNow(reason = 'force') {
        // Cancel scheduled revocations (and revoke)
        const scheduled = Array.from(this._pendingRevocations.keys());
        for (const url of scheduled) {
            this._revokeNow(url, reason);
        }

        // Deferred revocations
        const deferred = Array.from(this._deferredUntilDetached);
        for (const url of deferred) {
            this._revokeNow(url, reason);
        }

        // Active/preparing
        if (this._activeURL) this._revokeNow(this._activeURL, reason);
        if (this._preparingURL) this._revokeNow(this._preparingURL, reason);

        this._pendingRevocations.clear();
        this._deferredUntilDetached.clear();
        this._activeURL = null;
        this._preparingURL = null;
    }
};
