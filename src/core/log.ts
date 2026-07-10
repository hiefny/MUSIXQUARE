const LOG_LEVEL = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4,
} as const;

type LogLevelValue = (typeof LOG_LEVEL)[keyof typeof LOG_LEVEL];
type LogLevelName = keyof typeof LOG_LEVEL;

function parseLogLevel(level: unknown): LogLevelValue | null {
  if (typeof level !== 'string') return null;
  const key = level.trim().toUpperCase() as LogLevelName;
  return LOG_LEVEL[key] ?? null;
}

function getConfiguredLogLevel(): LogLevelValue | null {
  const envLevel = parseLogLevel(import.meta.env?.VITE_MUSIXQUARE_LOG_LEVEL);
  if (envLevel !== null) return envLevel;

  try {
    const params = new URLSearchParams(globalThis.location?.search || '');
    const queryLevel = parseLogLevel(params.get('mxqrLog') || params.get('logLevel'));
    if (queryLevel !== null) return queryLevel;
  } catch {
    /* ignore */
  }

  try {
    const storedLevel = parseLogLevel(globalThis.localStorage?.getItem('mxqr:logLevel'));
    if (storedLevel !== null) return storedLevel;
  } catch {
    /* ignore */
  }

  return null;
}

let _logLevel: LogLevelValue = import.meta.env?.PROD ? LOG_LEVEL.WARN : LOG_LEVEL.INFO;

try {
  const host = globalThis.location?.hostname;
  if (
    !import.meta.env?.PROD &&
    (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0')
  ) {
    _logLevel = LOG_LEVEL.DEBUG;
  }
} catch {
  // ignore (worker context, etc.)
}

const configuredLogLevel = getConfiguredLogLevel();
if (configuredLogLevel !== null) _logLevel = configuredLogLevel;

/** Change the runtime threshold; the same function is exposed to the developer console. */
export function setLogLevel(level: LogLevelName | Lowercase<LogLevelName>): void {
  const v = parseLogLevel(level);
  if (v !== null) _logLevel = v;
}

declare global {
  // Dev-console hook exposed below. Optional because workers may not have a writable global.
  var setLogLevel: ((level: LogLevelName | Lowercase<LogLevelName>) => void) | undefined;
}

try {
  globalThis.setLogLevel = setLogLevel;
} catch {
  /* worker context */
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
