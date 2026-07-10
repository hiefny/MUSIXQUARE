/**
 * Mirrors console output and uncaught failures into a bounded RAM buffer for
 * the on-device `/debug console` view. Patched methods still invoke their
 * originals, so capture does not replace normal browser logging.
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

/** Install early enough to capture boot failures; repeated calls are harmless. */
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

  // Browsers do not consistently route these events through patched console
  // methods, so capture them explicitly.
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
