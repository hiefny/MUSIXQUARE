import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../file-playback-engine-gate.ts';

function installEnvironment(options: {
  readonly dev: boolean;
  readonly prod: boolean;
  readonly productionFlag?: string;
}): void {
  vi.stubEnv('DEV', options.dev);
  vi.stubEnv('PROD', options.prod);
  vi.stubEnv('VITE_MUSIXQUARE_FILE_ENGINE_V2', options.productionFlag);
}

function installLocation(search: unknown): void {
  vi.stubGlobal('location', { search });
}

async function loadGate() {
  return import(MODULE_PATH);
}

describe('file playback engine bootstrap gate', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    { dev: false, prod: false },
    { dev: true, prod: true },
  ])('defaults to legacy for an unavailable or ambiguous build mode: %o', async (mode) => {
    installEnvironment({ ...mode, productionFlag: '1' });
    installLocation('?fileEngineV2=1');

    const gate = await loadGate();

    expect(gate.getFilePlaybackEngineMode()).toBe('legacy');
    expect(gate.isFilePlaybackEngineV2Enabled()).toBe(false);
  });

  it('allows one exact development query opt-in', async () => {
    installEnvironment({ dev: true, prod: false });
    installLocation('?panel=audio&fileEngineV2=1');

    const gate = await loadGate();

    expect(gate.getFilePlaybackEngineMode()).toBe('v2');
    expect(gate.isFilePlaybackEngineV2Enabled()).toBe(true);
  });

  it.each([
    '',
    '?fileEngineV2=',
    '?fileEngineV2=true',
    '?fileEngineV2=01',
    '?fileEngineV2=%20%31',
    '?fileEngineV2=%E0%A4%A',
    '?FileEngineV2=1',
    '?fileEngineV2',
  ])('rejects a non-exact development opt-in: %s', async (search) => {
    installEnvironment({ dev: true, prod: false });
    installLocation(search);

    const gate = await loadGate();

    expect(gate.getFilePlaybackEngineMode()).toBe('legacy');
  });

  it.each([
    '?fileEngineV2=1&fileEngineV2=1',
    '?fileEngineV2=1&fileEngineV2=0',
    '?fileEngineV2=0&fileEngineV2=1',
  ])('rejects duplicate or conflicting development parameters: %s', async (search) => {
    installEnvironment({ dev: true, prod: false });
    installLocation(search);

    const gate = await loadGate();

    expect(gate.isFilePlaybackEngineV2Enabled()).toBe(false);
  });

  it('ignores both query state and the production flag in development without opt-in', async () => {
    installEnvironment({ dev: true, prod: false, productionFlag: '1' });
    installLocation('?fileEngineV2=0');

    const gate = await loadGate();

    expect(gate.getFilePlaybackEngineMode()).toBe('legacy');
  });

  it('ignores the query in production', async () => {
    installEnvironment({ dev: false, prod: true, productionFlag: '0' });
    installLocation('?fileEngineV2=1');

    const gate = await loadGate();

    expect(gate.getFilePlaybackEngineMode()).toBe('legacy');
  });

  it('enables production only for the exact build-time value', async () => {
    installEnvironment({ dev: false, prod: true, productionFlag: '1' });
    installLocation('?fileEngineV2=0');

    const gate = await loadGate();

    expect(gate.getFilePlaybackEngineMode()).toBe('v2');
    expect(gate.isFilePlaybackEngineV2Enabled()).toBe(true);
  });

  it.each([undefined, '', 'true', '01', ' 1 ', '0'])(
    'rejects a non-exact production flag: %s',
    async (productionFlag) => {
      installEnvironment({ dev: false, prod: true, productionFlag });
      installLocation('');

      const gate = await loadGate();

      expect(gate.getFilePlaybackEngineMode()).toBe('legacy');
    },
  );

  it('keeps the module-evaluation snapshot after URL and environment changes', async () => {
    installEnvironment({ dev: true, prod: false });
    const location = { search: '?fileEngineV2=1' };
    vi.stubGlobal('location', location);
    const gate = await loadGate();

    location.search = '?fileEngineV2=0';
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_MUSIXQUARE_FILE_ENGINE_V2', '0');

    expect(gate.getFilePlaybackEngineMode()).toBe('v2');
    expect(gate.isFilePlaybackEngineV2Enabled()).toBe(true);
  });

  it.each([undefined, null, 1, { malformed: true }])(
    'fails closed when location.search is unavailable: %s',
    async (search) => {
      installEnvironment({ dev: true, prod: false });
      installLocation(search);

      const gate = await loadGate();

      expect(gate.getFilePlaybackEngineMode()).toBe('legacy');
    },
  );

  it('fails closed when location itself is unavailable', async () => {
    installEnvironment({ dev: true, prod: false });
    vi.stubGlobal('location', undefined);

    const gate = await loadGate();

    expect(gate.getFilePlaybackEngineMode()).toBe('legacy');
  });

  it('fails closed when reading location.search throws', async () => {
    installEnvironment({ dev: true, prod: false });
    const location = Object.defineProperty({}, 'search', {
      configurable: true,
      get() {
        throw new Error('location.search blocked');
      },
    });
    vi.stubGlobal('location', location);

    const gate = await loadGate();

    expect(gate.getFilePlaybackEngineMode()).toBe('legacy');
    expect(gate.isFilePlaybackEngineV2Enabled()).toBe(false);
  });
});
