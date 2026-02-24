// @ts-check
/**
 * MUSIXQUARE 2.0 - Logging
 *
 * 중앙 로그 시스템. 프로덕션에서는 warn 이상만 출력.
 */

export const LOG_LEVEL = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 99,
});

let _level = LOG_LEVEL.WARN; // Production default

/** @param {number} level */
export function setLogLevel(level) { _level = level; }
export function getLogLevel() { return _level; }

const PREFIX = '[MXQR]';

export const log = {
  debug: (...args) => { if (_level <= LOG_LEVEL.DEBUG) console.debug(PREFIX, ...args); },
  info:  (...args) => { if (_level <= LOG_LEVEL.INFO)  console.info(PREFIX, ...args); },
  warn:  (...args) => { if (_level <= LOG_LEVEL.WARN)  console.warn(PREFIX, ...args); },
  error: (...args) => { if (_level <= LOG_LEVEL.ERROR) console.error(PREFIX, ...args); },
};

// Dev mode: enable debug logging
if (typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  _level = LOG_LEVEL.DEBUG;
}
