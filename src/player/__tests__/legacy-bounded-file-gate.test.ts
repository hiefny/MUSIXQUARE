import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../legacy-bounded-file-gate.ts';
const RELEASE_LATCH_MODULE_PATH = '../legacy-bounded-file-beta-latch.ts';

function installEnvironment(options: {
  readonly dev: boolean;
  readonly prod: boolean;
  readonly mode?: string;
  readonly betaBoundedFlag?: string;
  readonly betaArtifact?: boolean;
}): void {
  vi.stubEnv('DEV', options.dev);
  vi.stubEnv('PROD', options.prod);
  vi.stubEnv('MODE', options.mode);
  vi.stubEnv('VITE_MUSIXQUARE_LEGACY_BOUNDED', options.betaBoundedFlag);
  vi.stubGlobal('__MXQR_LEGACY_BOUNDED_BETA_ARTIFACT__', options.betaArtifact ?? false);
}

function installLocation(search: unknown): void {
  vi.stubGlobal('location', { search });
}

async function loadGate(options: { readonly releaseLatch?: boolean } = {}) {
  vi.doMock(RELEASE_LATCH_MODULE_PATH, () => ({
    LEGACY_BOUNDED_FILE_BETA_RELEASE_ENABLED: options.releaseLatch ?? true,
  }));
  return import(MODULE_PATH);
}

describe('legacy bounded file beta bootstrap gate', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock(RELEASE_LATCH_MODULE_PATH);
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
  ])('fails closed for an unavailable or ambiguous build environment: %o', async (environment) => {
    installEnvironment({
      ...environment,
      mode: 'beta-bounded',
      betaBoundedFlag: '1',
    });
    installLocation('?legacyBounded=1');

    expect((await loadGate()).isLegacyBoundedFileEnabled()).toBe(false);
  });

  it('allows one exact development query opt-in', async () => {
    installEnvironment({ dev: true, prod: false, mode: 'development' });
    installLocation('?panel=audio&legacyBounded=1');

    expect((await loadGate()).isLegacyBoundedFileEnabled()).toBe(true);
  });

  it.each([
    '',
    '?legacyBounded=',
    '?legacyBounded=true',
    '?legacyBounded=01',
    '?legacyBounded=%20%31',
    '?legacyBounded=%E0%A4%A',
    '?LegacyBounded=1',
    '?legacyBounded',
  ])('rejects a non-exact development opt-in: %s', async (search) => {
    installEnvironment({ dev: true, prod: false, mode: 'development' });
    installLocation(search);

    expect((await loadGate()).isLegacyBoundedFileEnabled()).toBe(false);
  });

  it.each([
    '?legacyBounded=1&legacyBounded=1',
    '?legacyBounded=1&legacyBounded=0',
    '?legacyBounded=0&legacyBounded=1',
  ])('rejects duplicate or conflicting development parameters: %s', async (search) => {
    installEnvironment({ dev: true, prod: false, mode: 'development' });
    installLocation(search);

    expect((await loadGate()).isLegacyBoundedFileEnabled()).toBe(false);
  });

  it('ignores the beta build flag and latch in development without the exact query', async () => {
    installEnvironment({
      dev: true,
      prod: false,
      mode: 'beta-bounded',
      betaBoundedFlag: '1',
    });
    installLocation('?legacyBounded=0');

    expect((await loadGate({ releaseLatch: true })).isLegacyBoundedFileEnabled()).toBe(false);
  });

  it('does not treat the existing V2 development query as a beta bounded opt-in', async () => {
    installEnvironment({ dev: true, prod: false, mode: 'development' });
    installLocation('?fileEngineV2=1');

    expect((await loadGate()).isLegacyBoundedFileEnabled()).toBe(false);
  });

  it('keeps the beta renderer off when both development engine opt-ins are present', async () => {
    installEnvironment({ dev: true, prod: false, mode: 'development' });
    installLocation('?legacyBounded=1&fileEngineV2=1');

    const betaGate = await loadGate();
    const v2Gate = await import('../file-playback-engine-gate.ts');

    expect(betaGate.isLegacyBoundedFileEnabled()).toBe(false);
    expect(v2Gate.isFilePlaybackEngineV2Enabled()).toBe(true);
  });

  it('does not treat the existing V2 build flag as the beta bounded build flag', async () => {
    installEnvironment({
      dev: false,
      prod: true,
      mode: 'beta-bounded',
    });
    vi.stubEnv('VITE_MUSIXQUARE_FILE_ENGINE_V2', '1');

    expect((await loadGate({ releaseLatch: true })).isLegacyBoundedFileEnabled()).toBe(false);
  });

  it('enables only the exact beta bounded build when the tracked latch is on', async () => {
    installEnvironment({
      dev: false,
      prod: true,
      mode: 'beta-bounded',
      betaBoundedFlag: '1',
      betaArtifact: true,
    });
    installLocation('?legacyBounded=0');

    expect((await loadGate({ releaseLatch: true })).isLegacyBoundedFileEnabled()).toBe(true);
  });

  it('keeps the exact beta bounded build disabled while the tracked latch is off', async () => {
    installEnvironment({
      dev: false,
      prod: true,
      mode: 'beta-bounded',
      betaBoundedFlag: '1',
      betaArtifact: true,
    });

    expect((await loadGate({ releaseLatch: false })).isLegacyBoundedFileEnabled()).toBe(false);
  });

  it('rejects beta mode and flags outside the isolated beta artifact config', async () => {
    installEnvironment({
      dev: false,
      prod: true,
      mode: 'beta-bounded',
      betaBoundedFlag: '1',
      betaArtifact: false,
    });

    expect((await loadGate({ releaseLatch: true })).isLegacyBoundedFileEnabled()).toBe(false);
  });

  it.each(['production', 'e2e', 'e2e-universal', 'development', undefined])(
    'fails closed outside the exact beta bounded build mode: %s',
    async (mode) => {
      installEnvironment({
        dev: false,
        prod: true,
        mode,
        betaBoundedFlag: '1',
        betaArtifact: true,
      });
      installLocation('?legacyBounded=1');

      expect((await loadGate({ releaseLatch: true })).isLegacyBoundedFileEnabled()).toBe(false);
    },
  );

  it.each([undefined, '', '0', 'true', '01', ' 1 '])(
    'requires the exact beta build flag: %s',
    async (betaBoundedFlag) => {
      installEnvironment({
        dev: false,
        prod: true,
        mode: 'beta-bounded',
        betaBoundedFlag,
        betaArtifact: true,
      });

      expect((await loadGate({ releaseLatch: true })).isLegacyBoundedFileEnabled()).toBe(false);
    },
  );

  it('ignores the development query in ordinary production', async () => {
    installEnvironment({
      dev: false,
      prod: true,
      mode: 'production',
      betaBoundedFlag: '1',
      betaArtifact: true,
    });
    installLocation('?legacyBounded=1');

    expect((await loadGate({ releaseLatch: true })).isLegacyBoundedFileEnabled()).toBe(false);
  });

  it('uses the real tracked latch for the exact beta bounded artifact', async () => {
    installEnvironment({
      dev: false,
      prod: true,
      mode: 'beta-bounded',
      betaBoundedFlag: '1',
      betaArtifact: true,
    });
    vi.doUnmock(RELEASE_LATCH_MODULE_PATH);

    expect((await import(MODULE_PATH)).isLegacyBoundedFileEnabled()).toBe(true);
  });

  it('keeps the existing V2 engine disabled in the exact beta bounded artifact', async () => {
    installEnvironment({
      dev: false,
      prod: true,
      mode: 'beta-bounded',
      betaBoundedFlag: '1',
      betaArtifact: true,
    });
    vi.stubEnv('VITE_MUSIXQUARE_FILE_ENGINE_V2', '1');
    installLocation('?fileEngineV2=1&legacyBounded=1');

    const betaGate = await loadGate({ releaseLatch: true });
    const v2Gate = await import('../file-playback-engine-gate.ts');

    expect(betaGate.isLegacyBoundedFileEnabled()).toBe(true);
    expect(v2Gate.isFilePlaybackEngineV2Enabled()).toBe(false);
  });

  it('keeps the module-evaluation decision after URL and environment changes', async () => {
    installEnvironment({ dev: true, prod: false, mode: 'development' });
    const location = { search: '?legacyBounded=1' };
    vi.stubGlobal('location', location);
    const gate = await loadGate();

    location.search = '?legacyBounded=0';
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('VITE_MUSIXQUARE_LEGACY_BOUNDED', '0');

    expect(gate.isLegacyBoundedFileEnabled()).toBe(true);
  });

  it.each([undefined, null, 1, { malformed: true }])(
    'fails closed when location.search is unavailable: %s',
    async (search) => {
      installEnvironment({ dev: true, prod: false, mode: 'development' });
      installLocation(search);

      expect((await loadGate()).isLegacyBoundedFileEnabled()).toBe(false);
    },
  );

  it('fails closed when location itself is unavailable', async () => {
    installEnvironment({ dev: true, prod: false, mode: 'development' });
    vi.stubGlobal('location', undefined);

    expect((await loadGate()).isLegacyBoundedFileEnabled()).toBe(false);
  });

  it('fails closed when reading location.search throws', async () => {
    installEnvironment({ dev: true, prod: false, mode: 'development' });
    const location = Object.defineProperty({}, 'search', {
      configurable: true,
      get() {
        throw new Error('location.search blocked');
      },
    });
    vi.stubGlobal('location', location);

    expect((await loadGate()).isLegacyBoundedFileEnabled()).toBe(false);
  });
});
