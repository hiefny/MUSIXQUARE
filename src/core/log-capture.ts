/**
 * MUSIXQUARE — Console capture ring buffer
 *
 * Tees console.{log,info,warn,error,debug} (and uncaught errors / rejections)
 * into a bounded in-memory ring buffer so the output can be shown on-device via
 * `/debug console`. This is the only practical way to read the console on iOS,
 * where Safari Web Inspector needs a tethered Mac. The tee always calls the
 * original method, so normal logging is unchanged.
 */

const MAX_ENTRIES = 300;
const _buffer: string[] = [];
let _installed = false;

function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function push(level: string, args: unknown[]): void {
  // HH:MM:SS.mmm — date is noise on a single-session overlay.
  const ts = new Date().toISOString().slice(11, 23);
  _buffer.push(`${ts} ${level} ${args.map(fmtArg).join(' ')}`);
  if (_buffer.length > MAX_ENTRIES) _buffer.shift();
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';
type MutableConsole = Record<ConsoleMethod, (...args: unknown[]) => void>;

/** Install once, as early as possible at boot. Idempotent. */
export function installConsoleCapture(): void {
  if (_installed) return;
  _installed = true;

  const methods: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];
  const c = console as unknown as MutableConsole;
  for (const m of methods) {
    const orig = c[m]?.bind(console);
    c[m] = (...args: unknown[]): void => {
      try {
        push(m.toUpperCase(), args);
      } catch {
        /* never let capture break logging */
      }
      orig?.(...args);
    };
  }

  // Uncaught errors / unhandled rejections are usually the most useful and
  // never reach console.error in a way we'd otherwise tee.
  try {
    window.addEventListener('error', (e) => {
      push('UNCAUGHT', [e.message, e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '']);
    });
    window.addEventListener('unhandledrejection', (e) => {
      push('REJECT', [String((e as PromiseRejectionEvent).reason)]);
    });
  } catch {
    /* non-window context */
  }
}

export function getCapturedLogs(): string {
  return _buffer.length ? _buffer.join('\n') : '(no console output captured yet)';
}

export function clearCapturedLogs(): void {
  _buffer.length = 0;
}
