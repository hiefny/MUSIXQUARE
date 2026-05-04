import { describe, it, expect, vi, beforeEach } from 'vitest';

// log.ts sets _logLevel at module scope based on globalThis.location.hostname.
// In vitest (node), globalThis.location is undefined → level stays INFO.
// We re-import per test via dynamic import where needed.

describe('log', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('exports debug, info, warn, error methods', async () => {
    const { log } = await import('../log.ts');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('log.info calls console.info (default level is INFO)', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { log } = await import('../log.ts');
    log.info('hello', 42);
    expect(spy).toHaveBeenCalledWith('hello', 42);
  });

  it('log.warn calls console.warn', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { log } = await import('../log.ts');
    log.warn('warning!');
    expect(spy).toHaveBeenCalledWith('warning!');
  });

  it('log.error calls console.error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { log } = await import('../log.ts');
    log.error('err', { detail: 1 });
    expect(spy).toHaveBeenCalledWith('err', { detail: 1 });
  });

  it('log.debug is suppressed at INFO level (node env has no location)', async () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { log } = await import('../log.ts');
    log.debug('should not appear');
    // In node (no globalThis.location.hostname), level = INFO → debug suppressed
    expect(spy).not.toHaveBeenCalled();
  });

  it('log methods accept variadic arguments', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { log } = await import('../log.ts');
    log.info('a', 'b', 'c', 1, 2, 3);
    expect(spy).toHaveBeenCalledWith('a', 'b', 'c', 1, 2, 3);
  });

  it('log methods accept no arguments without error', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { log } = await import('../log.ts');
    log.info();
    expect(spy).toHaveBeenCalledWith();
  });

  it('setLogLevel accepts lowercase names and suppresses lower-priority logs', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { log, setLogLevel } = await import('../log.ts');

    try {
      setLogLevel('warn');
      log.info('quiet');
      log.warn('visible');

      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith('visible');
    } finally {
      setLogLevel('info');
    }
  });
});
