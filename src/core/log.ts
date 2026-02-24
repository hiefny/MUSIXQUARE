/**
 * MUSIXQUARE 2.0 — Logging System
 * Extracted from original app.js lines 37-49
 */

export const LOG_LEVEL = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4,
} as const;

export type LogLevelValue = (typeof LOG_LEVEL)[keyof typeof LOG_LEVEL];

let _logLevel: LogLevelValue = LOG_LEVEL.INFO;

// Auto-enable DEBUG on localhost
try {
  const host = globalThis.location?.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
    _logLevel = LOG_LEVEL.DEBUG;
  }
} catch {
  // ignore (worker context, etc.)
}

export function setLogLevel(level: LogLevelValue): void {
  _logLevel = level;
  console.info(`[Log] Level set to ${Object.keys(LOG_LEVEL).find(k => LOG_LEVEL[k as keyof typeof LOG_LEVEL] === level) ?? level}`);
}

export function getLogLevel(): LogLevelValue {
  return _logLevel;
}

export const log = {
  debug: (...args: unknown[]): void => {
    if (_logLevel <= LOG_LEVEL.DEBUG) console.debug(...args);
  },
  info: (...args: unknown[]): void => {
    if (_logLevel <= LOG_LEVEL.INFO) console.info(...args);
  },
  warn: (...args: unknown[]): void => {
    if (_logLevel <= LOG_LEVEL.WARN) console.warn(...args);
  },
  error: (...args: unknown[]): void => {
    if (_logLevel <= LOG_LEVEL.ERROR) console.error(...args);
  },
};
