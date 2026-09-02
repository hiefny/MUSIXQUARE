import { readFile, stat } from 'node:fs/promises';
import { request as requestHttp } from 'node:http';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { countExecutableInlineScripts } from '../../../scripts/check-authored-inline-js-inventory.mts';
import {
  AUXILIARY_BROWSER_ASSETS,
  assertAuxiliaryBrowserHtmlContract,
  assertAuxiliaryBrowserSourceCompleteness,
  auxiliaryBrowserAssetForRequestUrl,
  auxiliaryBrowserAssets,
  compileAuxiliaryBrowserAsset,
  compileAuxiliaryBrowserAssets,
  materializeFileUrlAuxiliaryAssets,
} from '../../../scripts/auxiliary-browser-assets.ts';
import { startViteMiddlewareTestServer } from './helpers/vite-middleware-test-server.ts';

const REPOSITORY = resolve(process.cwd());

async function startAuxiliaryDevServer(): Promise<{
  readonly origin: string;
  close(): Promise<void>;
}> {
  return startViteMiddlewareTestServer(
    {
      appType: 'custom',
      configFile: false,
      publicDir: false,
      root: REPOSITORY,
      plugins: [auxiliaryBrowserAssets()],
      optimizeDeps: { include: [], noDiscovery: true },
    },
    'Auxiliary browser',
  );
}

async function requestDevServer(
  origin: string,
  pathname: string,
  method: 'GET' | 'HEAD',
): Promise<{
  readonly body: string;
  readonly cacheControl: string | undefined;
  readonly contentType: string | undefined;
  readonly status: number;
}> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = requestHttp(new URL(pathname, origin), { method }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', rejectRequest);
      response.once('end', () => {
        const cacheControl = response.headers['cache-control'];
        const contentType = response.headers['content-type'];
        resolveRequest({
          body: Buffer.concat(chunks).toString('utf8'),
          cacheControl: Array.isArray(cacheControl) ? cacheControl.join(', ') : cacheControl,
          contentType: Array.isArray(contentType) ? contentType.join(', ') : contentType,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.once('error', rejectRequest);
    request.end();
  });
}

function reportFixture(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    total: 1,
    passed: 0,
    failed: 1,
    skipped: 0,
    completed: 1,
    running: null,
    finishedAt: '2026-08-17T00:00:00.000Z',
    finalStatus: 'failed',
    durationMs: 1250,
    tests: [
      {
        title: 'interrupted playback',
        file: 'e2e/playback.test.ts',
        status: 'interrupted',
        duration: 1250,
        error: 'browser closed',
      },
    ],
    ...overrides,
  };
}

function javaScriptDataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

interface MusicNoteFixtureState {
  backgroundHex?: number;
  camera?: {
    aspect: number;
    position: { x: number; y: number; z: number };
    projectionUpdates: number;
  };
  controls?: {
    autoRotate: boolean;
    target: { x: number; y: number; z: number };
  };
  rendererClearColor?: number;
  rendererSize?: readonly [number, number];
}

const MUSIC_NOTE_THREE_MOCK = String.raw`
const state = globalThis.__MUSIC_NOTE_FIXTURE_STATE__;
export const NoToneMapping = 0;
export const SRGBColorSpace = 'srgb';
export class Vector2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  copy(value) { this.x = value.x; this.y = value.y; this.z = value.z; return this; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
export class Color {
  constructor(hex) { this.hex = hex; }
  setHex(hex) { this.hex = hex; state.backgroundHex = hex; return this; }
}
export class WebGLRenderer {
  constructor(options) { state.rendererCanvas = options.canvas; }
  setPixelRatio(value) { state.pixelRatio = value; }
  setSize(width, height) { state.rendererSize = [width, height]; }
  setClearColor(hex) { state.rendererClearColor = hex; }
  render() { state.rendererRenders = (state.rendererRenders ?? 0) + 1; }
}
export class Scene { add() {} }
export class PerspectiveCamera {
  constructor(fieldOfView, aspect) {
    this.fieldOfView = fieldOfView;
    this.aspect = aspect;
    this.position = new Vector3();
    this.projectionUpdates = 0;
    state.camera = this;
  }
  updateProjectionMatrix() { this.projectionUpdates += 1; }
}
export class PMREMGenerator {
  fromScene() { return { texture: {} }; }
}
export class AmbientLight {}
export class DirectionalLight { constructor() { this.position = new Vector3(); } }
export class Group { constructor() { this.rotation = { x: 0 }; } add() {} }
export class MeshPhysicalMaterial {}
export class ExtrudeGeometry { center() {} }
export class Mesh {}
export class GridHelper {
  constructor() { this.rotation = { x: 0 }; this.position = { z: 0 }; }
}
`;

const MUSIC_NOTE_REMOTE_MOCKS: Readonly<Record<string, string>> = {
  'https://esm.sh/three@0.162.0': MUSIC_NOTE_THREE_MOCK,
  'https://esm.sh/three@0.162.0/examples/jsm/controls/OrbitControls.js': String.raw`
    const state = globalThis.__MUSIC_NOTE_FIXTURE_STATE__;
    class Target {
      constructor() { this.x = 0; this.y = 0; this.z = 0; }
      set(x, y, z) { this.x = x; this.y = y; this.z = z; }
    }
    export class OrbitControls {
      constructor() { this.autoRotate = false; this.target = new Target(); state.controls = this; }
      update() { state.controlUpdates = (state.controlUpdates ?? 0) + 1; }
    }
  `,
  'https://esm.sh/three@0.162.0/examples/jsm/loaders/SVGLoader.js': String.raw`
    export class SVGLoader {
      parse() { return { paths: [] }; }
      static createShapes() { return []; }
    }
  `,
  'https://esm.sh/three@0.162.0/examples/jsm/environments/RoomEnvironment.js':
    'export class RoomEnvironment {}',
};

function replaceRemoteModuleSpecifiers(
  code: string,
  mocks: Readonly<Record<string, string>>,
): string {
  let executable = code;
  for (const [specifier, moduleSource] of Object.entries(mocks)) {
    const replacement = JSON.stringify(javaScriptDataUrl(moduleSource));
    executable = executable
      .replaceAll(JSON.stringify(specifier), replacement)
      .replaceAll(`'${specifier}'`, replacement);
  }
  return executable;
}

async function executeMusicNoteModule(): Promise<{
  cleanup(): void;
  readonly dom: JSDOM;
  readonly state: MusicNoteFixtureState;
}> {
  const asset = AUXILIARY_BROWSER_ASSETS.find((candidate) =>
    candidate.outputPath.endsWith('music-note-3d.js'),
  );
  if (!asset) throw new Error('Missing music note asset.');
  const [html, compiled] = await Promise.all([
    readFile(resolve(REPOSITORY, asset.htmlPath), 'utf8'),
    compileAuxiliaryBrowserAsset(REPOSITORY, asset),
  ]);
  const executable = replaceRemoteModuleSpecifiers(compiled.code, MUSIC_NOTE_REMOTE_MOCKS);
  if (executable.includes('https://esm.sh/')) {
    throw new Error('Music note fixture did not replace every remote module.');
  }

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://promo.local/' });
  const state: MusicNoteFixtureState = {};
  const injectedGlobals: Readonly<Record<string, unknown>> = {
    __MUSIC_NOTE_FIXTURE_STATE__: state,
    document: dom.window.document,
    HTMLCanvasElement: dom.window.HTMLCanvasElement,
    requestAnimationFrame: () => 1,
    window: dom.window,
  };
  const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(injectedGlobals)) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Reflect.set(globalThis, name, value);
  }
  const cleanup = (): void => {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
  try {
    await import(javaScriptDataUrl(executable));
  } catch (error: unknown) {
    cleanup();
    dom.window.close();
    throw error;
  }
  return { cleanup, dom, state };
}

async function executeReportViewer(report: Record<string, unknown>): Promise<JSDOM> {
  const asset = AUXILIARY_BROWSER_ASSETS.find(
    (candidate) => candidate.outputPath === 'e2e/report-viewer.js',
  );
  if (!asset) throw new Error('Missing report viewer asset.');
  const [html, compiled] = await Promise.all([
    readFile(resolve(REPOSITORY, asset.htmlPath), 'utf8'),
    compileAuxiliaryBrowserAsset(REPOSITORY, asset),
  ]);
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'file:///C:/musixquare/e2e/report-viewer.html',
  });
  dom.window.eval(compiled.code);
  Reflect.set(dom.window, '__E2E_REPORT__', report);
  const reportScript = dom.window.document.getElementById('report-script');
  if (!reportScript) throw new Error('Report viewer did not create its polling script.');
  reportScript.dispatchEvent(new dom.window.Event('load'));
  return dom;
}

describe('strict TypeScript auxiliary browser assets', () => {
  it('pins local and remote Three.js types to their exact runtime versions', async () => {
    const packageManifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    const localConfig = JSON.parse(await readFile('tsconfig.auxiliary-browser.json', 'utf8')) as {
      exclude: string[];
    };
    const remoteConfig = JSON.parse(
      await readFile('tsconfig.auxiliary-browser-remote.json', 'utf8'),
    ) as {
      compilerOptions: { paths: Record<string, string[]> };
      include: string[];
    };
    const declarations = await readFile('browser/auxiliary-runtime/remote-modules.d.ts', 'utf8');

    expect(packageManifest.devDependencies.three).toBe('0.184.0');
    expect(packageManifest.devDependencies['@types/three']).toBe('0.184.0');
    expect(packageManifest.devDependencies['three-types-0162']).toBe('npm:@types/three@0.162.0');
    expect(packageManifest.devDependencies['lil-gui']).toBe('0.19.2');
    expect(remoteConfig.compilerOptions.paths).toEqual({
      three: ['node_modules/three-types-0162/index.d.ts'],
      'three/*': ['node_modules/three-types-0162/*'],
    });
    expect(remoteConfig.include).toContain('browser/auxiliary-runtime/promo/music-note-3d.ts');
    expect(localConfig.exclude).toEqual(expect.arrayContaining(remoteConfig.include));
    expect(declarations).toContain("export * from 'three-types-0162';");
    expect(declarations).not.toContain("from 'three';");
  });

  it('owns all seven external scripts and leaves no executable inline blocks', async () => {
    await expect(assertAuxiliaryBrowserSourceCompleteness(REPOSITORY)).resolves.toBeUndefined();
    expect(AUXILIARY_BROWSER_ASSETS.map((asset) => asset.outputPath)).toEqual([
      '.workshop/promo/scenes/logo-animation.js',
      '.workshop/promo/scenes/music-note-3d.js',
      '.workshop/promo/scenes/product-hero-2.js',
      '.workshop/promo/scenes/product-hero.js',
      '.workshop/promo/scenes/ui-showcase-2.js',
      '.workshop/promo/scenes/ui-showcase.js',
      'e2e/report-viewer.js',
    ]);

    for (const asset of AUXILIARY_BROWSER_ASSETS) {
      const html = await readFile(resolve(REPOSITORY, asset.htmlPath), 'utf8');
      expect(countExecutableInlineScripts(html), asset.htmlPath).toBe(0);
      expect(() => assertAuxiliaryBrowserHtmlContract(asset, html)).not.toThrow();
      expect(auxiliaryBrowserAssetForRequestUrl(`/${asset.outputPath}?v=1`)).toBe(asset);
    }
  });

  it('compiles classic and module assets without raw TypeScript or sourcemaps', async () => {
    const compiled = await compileAuxiliaryBrowserAssets(REPOSITORY);
    expect(compiled).toHaveLength(AUXILIARY_BROWSER_ASSETS.length);
    for (const asset of compiled) {
      expect(asset.code, asset.outputPath).not.toMatch(/sourceMappingURL/u);
      if (asset.scriptType === 'classic') {
        expect(() => Function(asset.code), asset.outputPath).not.toThrow();
      }
    }
    expect(compiled.find((asset) => asset.outputPath.endsWith('music-note-3d.js'))?.code).toContain(
      'from "https://esm.sh/three@0.162.0"',
    );
    expect(
      compiled.find((asset) => asset.outputPath.endsWith('ui-showcase-2.js'))?.code,
    ).not.toContain('from "three"');
  });

  it('serves every stable URL over GET and HEAD with exact compiler bytes', async () => {
    const server = await startAuxiliaryDevServer();
    try {
      for (const asset of AUXILIARY_BROWSER_ASSETS) {
        const expected = await compileAuxiliaryBrowserAsset(REPOSITORY, asset);
        const get = await requestDevServer(server.origin, `/${asset.outputPath}`, 'GET');
        expect(get.status, asset.outputPath).toBe(200);
        expect(get.contentType, asset.outputPath).toBe('text/javascript; charset=utf-8');
        expect(get.cacheControl, asset.outputPath).toBe('no-cache');
        expect(get.body, asset.outputPath).toBe(expected.code);

        const head = await requestDevServer(server.origin, `/${asset.outputPath}`, 'HEAD');
        expect(head.status, asset.outputPath).toBe(200);
        expect(head.contentType, asset.outputPath).toBe('text/javascript; charset=utf-8');
        expect(head.body, asset.outputPath).toBe('');
      }
    } finally {
      await server.close();
    }
  });

  it('executes the compiled logo controller with the original phase timing', async () => {
    const asset = AUXILIARY_BROWSER_ASSETS.find((candidate) =>
      candidate.outputPath.endsWith('logo-animation.js'),
    );
    if (!asset) throw new Error('Missing logo animation asset.');
    const [html, compiled] = await Promise.all([
      readFile(resolve(REPOSITORY, asset.htmlPath), 'utf8'),
      compileAuxiliaryBrowserAsset(REPOSITORY, asset),
    ]);
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://promo.local/' });
    try {
      dom.window.eval(compiled.code);
      const controller: unknown = Reflect.get(dom.window, '__promoSetTime');
      expect(typeof controller).toBe('function');
      if (typeof controller !== 'function') throw new Error('Missing promo timeline controller.');
      Reflect.apply(controller, dom.window, [4000]);
      expect(dom.window.document.getElementById('tagline')?.style.opacity).toBe('1');
      expect(dom.window.document.getElementById('note-stroke')?.style.opacity).toBe('1');
    } finally {
      dom.window.close();
    }
  });

  it('executes the compiled music-note controls, background toggle, and resize lifecycle', async () => {
    const { cleanup, dom, state } = await executeMusicNoteModule();
    try {
      expect(dom.window.document.body.classList.contains('dark')).toBe(true);
      expect(state.rendererClearColor).toBe(0x0a0a0a);
      expect(state.controls?.autoRotate).toBe(true);

      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Space' }));
      expect(state.controls?.autoRotate).toBe(false);
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyB' }));
      expect(state.backgroundHex).toBe(0xe4e4e7);
      expect(state.rendererClearColor).toBe(0xe4e4e7);
      expect(dom.window.document.body.classList.contains('dark')).toBe(false);
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyH' }));
      expect(dom.window.document.querySelector('.overlay')?.classList.contains('hidden')).toBe(
        true,
      );
      expect(dom.window.document.querySelector('.brand')?.classList.contains('hidden')).toBe(true);

      Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1024 });
      Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 512 });
      dom.window.dispatchEvent(new dom.window.Event('resize'));
      expect(state.camera?.aspect).toBe(2);
      expect(state.camera?.projectionUpdates).toBe(1);
      expect(state.rendererSize).toEqual([1024, 512]);
    } finally {
      cleanup();
      dom.window.close();
    }
  });

  it('executes the compiled UI timeline and preserves its synchronous global controller', async () => {
    const asset = AUXILIARY_BROWSER_ASSETS.find((candidate) =>
      candidate.outputPath.endsWith('ui-showcase.js'),
    );
    if (!asset) throw new Error('Missing UI showcase asset.');
    const [html, compiled] = await Promise.all([
      readFile(resolve(REPOSITORY, asset.htmlPath), 'utf8'),
      compileAuxiliaryBrowserAsset(REPOSITORY, asset),
    ]);
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://promo.local/' });
    try {
      dom.window.eval(compiled.code);
      const controller: unknown = Reflect.get(dom.window, '__promoSetTime');
      expect(typeof controller).toBe('function');
      if (typeof controller !== 'function')
        throw new Error('Missing UI promo timeline controller.');
      Reflect.apply(controller, dom.window, [4000]);
      expect(dom.window.document.getElementById('note-stroke')?.style.opacity).toBe('1');
      expect(dom.window.document.getElementById('note-fill')?.style.opacity).toBe('1');
      expect(dom.window.document.getElementById('promo-tagline')?.style.opacity).toBe('0');
      expect(Reflect.get(dom.window, 'appReady')).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it('executes compiled module fail-fast paths and retains both product asset contracts', async () => {
    const moduleAssets = AUXILIARY_BROWSER_ASSETS.filter(
      (candidate) =>
        candidate.outputPath.endsWith('product-hero.js') ||
        candidate.outputPath.endsWith('product-hero-2.js'),
    );
    expect(moduleAssets).toHaveLength(2);
    const productMocks: Readonly<Record<string, string>> = {
      'https://esm.sh/three@0.162.0': 'export {};',
      'https://esm.sh/three@0.162.0/examples/jsm/controls/OrbitControls.js':
        'export class OrbitControls {}',
      'https://esm.sh/three@0.162.0/examples/jsm/environments/RoomEnvironment.js':
        'export class RoomEnvironment {}',
      'https://esm.sh/lil-gui@0.19.2': 'export default class GUI {}',
    };
    const dom = new JSDOM('<!doctype html><body></body>', {
      runScripts: 'outside-only',
      url: 'https://promo.local/',
    });
    const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
    const globals: Readonly<Record<string, unknown>> = {
      document: dom.window.document,
      HTMLCanvasElement: dom.window.HTMLCanvasElement,
      window: dom.window,
    };
    for (const [name, value] of Object.entries(globals)) {
      originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Reflect.set(globalThis, name, value);
    }
    try {
      for (const asset of moduleAssets) {
        const compiled = await compileAuxiliaryBrowserAsset(REPOSITORY, asset);
        if (asset.outputPath.endsWith('product-hero-2.js')) {
          expect(compiled.code).toContain('../assets/screenshots-tablet/');
          expect(compiled.code).toContain('"01.png"');
        } else {
          expect(compiled.code).toContain('../assets/screenshots-desktop/');
          expect(compiled.code).toContain('"01-role-select.png"');
        }
        const executable = replaceRemoteModuleSpecifiers(compiled.code, productMocks);
        expect(executable).not.toContain('https://esm.sh/');
        await expect(import(javaScriptDataUrl(executable))).rejects.toThrow(
          'Missing #scene canvas.',
        );
      }
    } finally {
      for (const [name, descriptor] of originalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.window.close();
    }

    const uiModule = AUXILIARY_BROWSER_ASSETS.find((candidate) =>
      candidate.outputPath.endsWith('ui-showcase-2.js'),
    );
    if (!uiModule) throw new Error('Missing module UI showcase asset.');
    const compiledUi = await compileAuxiliaryBrowserAsset(REPOSITORY, uiModule);
    const emptyUiDom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    const uiOriginalDescriptors = new Map<string, PropertyDescriptor | undefined>();
    const uiGlobals: Readonly<Record<string, unknown>> = {
      document: emptyUiDom.window.document,
      HTMLCanvasElement: emptyUiDom.window.HTMLCanvasElement,
      window: emptyUiDom.window,
    };
    for (const [name, value] of Object.entries(uiGlobals)) {
      uiOriginalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Reflect.set(globalThis, name, value);
    }
    try {
      await expect(import(javaScriptDataUrl(compiledUi.code))).rejects.toThrow(
        'Missing promo canvas #scene.',
      );
    } finally {
      for (const [name, descriptor] of uiOriginalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      emptyUiDom.window.close();
    }
  });

  it('executes the compiled report polling and preserves failure semantics', async () => {
    const interrupted = await executeReportViewer(reportFixture());
    try {
      expect(interrupted.window.document.getElementById('badge')?.textContent).toBe('1 FAILED');
      expect(interrupted.window.document.getElementById('test-list')?.textContent).toContain(
        'interrupted playback',
      );
    } finally {
      interrupted.window.close();
    }

    const suiteFailure = await executeReportViewer(
      reportFixture({ failed: 0, tests: [], finalStatus: 'failed' }),
    );
    try {
      expect(suiteFailure.window.document.getElementById('badge')?.textContent).toBe('RUN FAILED');
    } finally {
      suiteFailure.window.close();
    }
  });

  it('owns a clipboard success-continuation failure after the report button is removed', async () => {
    const dom = await executeReportViewer(reportFixture());
    let resolveWrite!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const copyFailure = vi.spyOn(dom.window.console, 'error').mockImplementation(() => undefined);
    try {
      const button = dom.window.document.getElementById('copy-btn');
      if (!(button instanceof dom.window.HTMLElement))
        throw new Error('Missing report copy button.');
      button.click();
      button.remove();
      resolveWrite();
      await Promise.resolve();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledOnce();
      expect(copyFailure).toHaveBeenCalledWith(
        '[report-viewer] Copy failed.',
        expect.objectContaining({ message: 'Missing report viewer element #copy-btn.' }),
      );
    } finally {
      dom.window.close();
    }
  });

  it('materializes byte-exact ignored JS before the direct-file viewer opens', async () => {
    const outputs = await materializeFileUrlAuxiliaryAssets(REPOSITORY);
    expect(outputs).toEqual(['e2e/report-viewer.js']);
    const asset = AUXILIARY_BROWSER_ASSETS.find((candidate) => candidate.outputPath === outputs[0]);
    if (!asset) throw new Error('Missing materialized report viewer asset.');
    const [written, compiled, ignored, batch] = await Promise.all([
      readFile(resolve(REPOSITORY, asset.outputPath), 'utf8'),
      compileAuxiliaryBrowserAsset(REPOSITORY, asset),
      readFile(resolve(REPOSITORY, '.gitignore'), 'utf8'),
      readFile(resolve(REPOSITORY, 'e2e/run-tests.bat'), 'utf8'),
    ]);
    expect(written).toBe(compiled.code);
    expect(await stat(resolve(REPOSITORY, asset.outputPath))).toBeTruthy();
    expect(ignored).toContain('e2e/report-viewer.js');
    const materialize = batch.indexOf('node scripts\\materialize-auxiliary-browser-assets.mts');
    const failClosed = batch.indexOf('if errorlevel 1 exit /b %ERRORLEVEL%');
    const open = batch.indexOf('start "" "%~dp0report-viewer.html"');
    expect(materialize).toBeGreaterThan(-1);
    expect(failClosed).toBeGreaterThan(materialize);
    expect(open).toBeGreaterThan(failClosed);
  });
});
