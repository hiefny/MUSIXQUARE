import { log } from './log.js';

export const BlobURLManager = {
    _urls: new Set(),

    create: (blob) => {
        if (!blob) {
            log.warn('[BlobURLManager] create() called with null/undefined blob');
            return null;
        }
        const url = URL.createObjectURL(blob);
        BlobURLManager._urls.add(url);
        return url;
    },

    revoke: (url) => {
        if (!url) return;
        URL.revokeObjectURL(url);
        BlobURLManager._urls.delete(url);
    },

    revokeAll: () => {
        BlobURLManager._urls.forEach(url => URL.revokeObjectURL(url));
        BlobURLManager._urls.clear();
        log.info('[BlobURLManager] All URLs revoked');
    }
};
