export const LOG_LEVEL = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    NONE: 4
};

let currentLogLevel = LOG_LEVEL.INFO;

export const log = {
    setLogLevel: (level) => {
        currentLogLevel = level;
    },
    debug: (...args) => {
        if (currentLogLevel <= LOG_LEVEL.DEBUG) console.log('[DEBUG]', ...args);
    },
    info: (...args) => {
        if (currentLogLevel <= LOG_LEVEL.INFO) console.info('[INFO]', ...args);
    },
    warn: (...args) => {
        if (currentLogLevel <= LOG_LEVEL.WARN) console.warn('[WARN]', ...args);
    },
    error: (...args) => {
        if (currentLogLevel <= LOG_LEVEL.ERROR) console.error('[ERROR]', ...args);
    }
};

// Global polyfill for inline scripts (safe: no-op in Worker context)
if (typeof window !== 'undefined') {
    window.log = log;
    window.LOG_LEVEL = LOG_LEVEL;
}
