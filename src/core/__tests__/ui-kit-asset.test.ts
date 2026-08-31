import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as requestHttp } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { countExecutableInlineScripts } from '../../../scripts/check-authored-inline-js-inventory.mts';
import {
  UI_KIT_DECLARATION_PATH,
  UI_KIT_HTML_PATH,
  UI_KIT_OUTPUT_PATH,
  UI_KIT_PUBLIC_APP_PATH,
  UI_KIT_README_PATH,
  UI_KIT_REACT_DOM_RUNTIME,
  UI_KIT_REACT_RUNTIME,
  UI_KIT_SOURCES,
  UI_KIT_STYLE_PATH,
  assertUiKitHtmlContract,
  assertUiKitSourceCompleteness,
  compileUiKitAsset,
  uiKitAsset,
} from '../../../scripts/ui-kit-asset.ts';
import { startViteMiddlewareTestServer } from './helpers/vite-middleware-test-server.ts';

const REPO_ROOT = resolve(process.cwd());

interface TestElement {
  readonly children: readonly unknown[];
  readonly kind: 'element';
  readonly props: Readonly<Record<string, unknown>>;
  readonly type: string | symbol;
}

interface TestRef {
  current: unknown;
}

type TestComponent = (props: Readonly<Record<string, unknown>>) => unknown;
type TestStateUpdater = (previous: unknown) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTestComponent(value: unknown): value is TestComponent {
  return typeof value === 'function';
}

function isTestElement(value: unknown): value is TestElement {
  return (
    isRecord(value) &&
    value.kind === 'element' &&
    (typeof value.type === 'string' || typeof value.type === 'symbol') &&
    isRecord(value.props) &&
    Array.isArray(value.children)
  );
}

function isTestStateUpdater(value: unknown): value is TestStateUpdater {
  return typeof value === 'function';
}

function isTestEventListener(value: unknown): value is EventListener {
  return typeof value === 'function';
}

function propertiesWithChildren(
  props: unknown,
  children: readonly unknown[],
): Readonly<Record<string, unknown>> {
  const properties = isRecord(props) ? { ...props } : {};
  if (children.length === 1) properties.children = children[0];
  if (children.length > 1) properties.children = children;
  return properties;
}

function renderTestNode(document: Document, value: unknown): Node {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return document.createDocumentFragment();
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return document.createTextNode(String(value));
  }
  if (Array.isArray(value)) {
    const fragment = document.createDocumentFragment();
    for (const child of value) fragment.append(renderTestNode(document, child));
    return fragment;
  }
  if (!isTestElement(value)) {
    throw new Error('UI kit test renderer received an unsupported node.');
  }
  if (typeof value.type === 'symbol') {
    const fragment = document.createDocumentFragment();
    for (const child of value.children) fragment.append(renderTestNode(document, child));
    return fragment;
  }

  const element = document.createElement(value.type);
  for (const [name, property] of Object.entries(value.props)) {
    if (name === 'children' || name === 'key' || property === undefined) continue;
    if (name === 'className' && typeof property === 'string') {
      element.className = property;
      continue;
    }
    if (name === 'style' && isRecord(property)) {
      const declarations = Object.entries(property)
        .filter((entry) => typeof entry[1] === 'string' || typeof entry[1] === 'number')
        .map(([cssName, cssValue]) => `${cssName}:${String(cssValue)}`);
      if (declarations.length > 0) element.setAttribute('style', declarations.join(';'));
      continue;
    }
    if (name === 'onClick' && isTestEventListener(property)) {
      element.addEventListener('click', property);
      continue;
    }
    if (name === 'onChange' && isTestEventListener(property)) {
      element.addEventListener('change', property);
      continue;
    }
    if (typeof property === 'string' || typeof property === 'number') {
      element.setAttribute(name, String(property));
    }
  }
  for (const child of value.children) element.append(renderTestNode(document, child));
  return element;
}

function createTestReactRuntime(document: Document): {
  readonly react: Readonly<Record<string, unknown>>;
  readonly reactDom: Readonly<Record<string, unknown>>;
} {
  const fragmentType = Symbol('Fragment');
  const states: unknown[] = [];
  const refs: TestRef[] = [];
  let stateCursor = 0;
  let refCursor = 0;
  let rootComponent: TestComponent | null = null;
  let rootContainer: Element | DocumentFragment | null = null;

  const renderRoot = (): unknown => {
    if (!rootComponent) return null;
    stateCursor = 0;
    refCursor = 0;
    const tree = rootComponent({});
    if (rootContainer) rootContainer.replaceChildren(renderTestNode(document, tree));
    return tree;
  };

  const react = {
    Fragment: fragmentType,
    createElement(type: unknown, props: unknown, ...children: unknown[]): unknown {
      const properties = propertiesWithChildren(props, children);
      if (isTestComponent(type)) {
        if (type.name === 'App') {
          rootComponent = type;
          return renderRoot();
        }
        return type(properties);
      }
      if (typeof type !== 'string' && type !== fragmentType) {
        throw new Error('UI kit test renderer received an unsupported element type.');
      }
      return { kind: 'element', type, props: properties, children } satisfies TestElement;
    },
    useEffect(effect: unknown): void {
      if (typeof effect !== 'function') throw new Error('Invalid UI kit effect.');
      effect();
    },
    useRef(initialValue: unknown): TestRef {
      const index = refCursor;
      refCursor += 1;
      let reference = refs[index];
      if (!reference) {
        reference = { current: initialValue };
        refs[index] = reference;
      }
      return reference;
    },
    useState(initialState: unknown): readonly [unknown, (action: unknown) => void] {
      const index = stateCursor;
      stateCursor += 1;
      if (!(index in states)) {
        states[index] = isTestStateUpdater(initialState) ? initialState(undefined) : initialState;
      }
      const setState = (action: unknown): void => {
        states[index] = isTestStateUpdater(action) ? action(states[index]) : action;
        renderRoot();
      };
      return [states[index], setState];
    },
  };

  const reactDom = {
    createRoot(container: Element | DocumentFragment) {
      rootContainer = container;
      return {
        render(node: unknown): void {
          container.replaceChildren(renderTestNode(document, node));
        },
      };
    },
  };

  return { react, reactDom };
}

function clickButtonByText(document: Document, text: string): void {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Missing UI kit button: ${text}`);
  button.click();
}

async function createUiKitFixture(): Promise<string> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'mxqr-ui-kit-'));
  await mkdir(resolve(fixtureRoot, UI_KIT_DECLARATION_PATH, '..'), { recursive: true });
  await mkdir(resolve(fixtureRoot, UI_KIT_HTML_PATH, '..'), { recursive: true });
  await writeFile(resolve(fixtureRoot, UI_KIT_DECLARATION_PATH), 'interface Fixture {}\n', 'utf8');
  for (const sourcePath of UI_KIT_SOURCES) {
    await writeFile(resolve(fixtureRoot, sourcePath), '// fixture\n', 'utf8');
  }
  await writeFile(
    resolve(fixtureRoot, UI_KIT_HTML_PATH),
    [
      `<script src="${UI_KIT_REACT_RUNTIME.src}" integrity="${UI_KIT_REACT_RUNTIME.integrity}" crossorigin="anonymous"></script>`,
      `<script src="${UI_KIT_REACT_DOM_RUNTIME.src}" integrity="${UI_KIT_REACT_DOM_RUNTIME.integrity}" crossorigin="anonymous"></script>`,
      `<script src="/${UI_KIT_OUTPUT_PATH}"></script>`,
    ].join('\n'),
    'utf8',
  );
  await writeFile(resolve(fixtureRoot, UI_KIT_STYLE_PATH), 'body { color: white; }\n', 'utf8');
  await writeFile(resolve(fixtureRoot, UI_KIT_README_PATH), '# Fixture UI kit\n', 'utf8');
  return fixtureRoot;
}

async function startUiKitDevServer(): Promise<{
  readonly origin: string;
  close(): Promise<void>;
}> {
  return startViteMiddlewareTestServer(
    {
      appType: 'custom',
      configFile: false,
      publicDir: false,
      root: REPO_ROOT,
      plugins: [uiKitAsset()],
      optimizeDeps: { include: [], noDiscovery: true },
    },
    'UI kit',
  );
}

async function requestDevServer(
  origin: string,
  pathname: string,
  method: 'GET' | 'HEAD' | 'POST',
): Promise<{
  readonly body: string;
  readonly cacheControl: string | undefined;
  readonly contentType: string | undefined;
  readonly location: string | undefined;
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
        const location = response.headers.location;
        resolveRequest({
          body: Buffer.concat(chunks).toString('utf8'),
          cacheControl: Array.isArray(cacheControl) ? cacheControl.join(', ') : cacheControl,
          contentType: Array.isArray(contentType) ? contentType.join(', ') : contentType,
          location: Array.isArray(location) ? location.join(', ') : location,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.once('error', rejectRequest);
    request.end();
  });
}

describe('strict TypeScript UI kit asset', () => {
  it('owns all TSX sources and rejects unmanaged or public compiler bypass files', async () => {
    await expect(assertUiKitSourceCompleteness(REPO_ROOT)).resolves.toBeUndefined();
    expect(UI_KIT_SOURCES).toEqual([
      'browser/ui-kit/app/icons.tsx',
      'browser/ui-kit/app/Toast.tsx',
      'browser/ui-kit/app/Start.tsx',
      'browser/ui-kit/app/RoleSetup.tsx',
      'browser/ui-kit/app/Home.tsx',
      'browser/ui-kit/app/Playlist.tsx',
      'browser/ui-kit/app/Connect.tsx',
      'browser/ui-kit/app/Settings.tsx',
      'browser/ui-kit/app/AppShell.tsx',
      'browser/ui-kit/app/entry.tsx',
    ]);

    const fixtureRoot = await createUiKitFixture();
    try {
      await expect(assertUiKitSourceCompleteness(fixtureRoot)).resolves.toBeUndefined();

      await writeFile(
        resolve(fixtureRoot, 'browser/ui-kit/app/unmanaged.js'),
        'window.unmanaged = true;\n',
        'utf8',
      );
      await expect(assertUiKitSourceCompleteness(fixtureRoot)).rejects.toThrow(
        'unsupported: browser/ui-kit/app/unmanaged.js',
      );
      await rm(resolve(fixtureRoot, 'browser/ui-kit/app/unmanaged.js'));

      const retiredPublicDirectory = resolve(fixtureRoot, 'public/designsystem/ui_kits/app');
      await mkdir(retiredPublicDirectory, { recursive: true });
      await writeFile(
        resolve(retiredPublicDirectory, 'app.js'),
        'window.shadowed = true;\n',
        'utf8',
      );
      await expect(assertUiKitSourceCompleteness(fixtureRoot)).rejects.toThrow(
        'publicDir must not publish the development-only UI kit',
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('preserves the pinned React supply chain and removes Babel and executable inline JS', async () => {
    const html = await readFile(resolve(REPO_ROOT, UI_KIT_HTML_PATH), 'utf8');
    expect(() => assertUiKitHtmlContract(html)).not.toThrow();
    expect(countExecutableInlineScripts(html)).toBe(0);
    expect(html.match(/<script\b/gu)).toHaveLength(3);
    expect(html).not.toMatch(/text\/babel|@babel\/standalone|\.jsx(?:[?"'])/iu);
  });

  it('executes compiled output through role, tab, theme, and leave interactions', async () => {
    const compiled = await compileUiKitAsset(REPO_ROOT);
    expect(compiled.outputPath).toBe(UI_KIT_OUTPUT_PATH);
    expect(compiled.sourcePaths).toEqual(UI_KIT_SOURCES);
    expect(compiled.code).not.toContain('sourceMappingURL');
    expect(compiled.code).not.toMatch(/^\s*(?:import|export)\b/mu);

    const missingRuntime = new JSDOM(
      '<!doctype html><html><body><div id="root"></div></body></html>',
    );
    try {
      expect(() =>
        Function(
          'window',
          'document',
          'React',
          'ReactDOM',
          compiled.code,
        )(missingRuntime.window, missingRuntime.window.document, undefined, undefined),
      ).toThrow('MUSIXQUARE_UI_KIT_REACT_RUNTIME_REQUIRED');
    } finally {
      missingRuntime.window.close();
    }

    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://example.test/designsystem/ui_kits/app/',
    });
    const runtime = createTestReactRuntime(dom.window.document);
    try {
      Object.defineProperties(dom.window, {
        React: { configurable: true, value: runtime.react },
        ReactDOM: { configurable: true, value: runtime.reactDom },
      });
      Function(
        'window',
        'document',
        'React',
        'ReactDOM',
        compiled.code,
      )(dom.window, dom.window.document, runtime.react, runtime.reactDom);

      expect(dom.window.document.body.textContent).toContain("I'll host");
      expect(dom.window.document.documentElement.dataset.theme).toBe('dark');

      clickButtonByText(dom.window.document, "I'll host");
      expect(dom.window.document.body.textContent).toContain("Set this device's role");
      expect(dom.window.document.body.textContent).toContain('Invite code: 492815');

      clickButtonByText(dom.window.document, 'Left');
      expect(dom.window.document.querySelector('.mq-role.active')?.textContent).toContain('Left');
      expect(dom.window.document.body.textContent).toContain('LEFT selected');

      clickButtonByText(dom.window.document, 'Done');
      expect(dom.window.document.querySelector('.mq-title')?.textContent).toBe('Home');

      clickButtonByText(dom.window.document, 'Playlist');
      expect(dom.window.document.querySelector('.mq-title')?.textContent).toContain('Playlist');
      expect(dom.window.document.body.textContent).toContain(
        'Cello Suite No. 1, BWV 1007: Prelude',
      );

      clickButtonByText(dom.window.document, 'Connect');
      expect(dom.window.document.body.textContent).toContain('492815');
      expect(dom.window.document.body.textContent).toContain('4 Connected Devices');

      clickButtonByText(dom.window.document, 'Settings');
      clickButtonByText(dom.window.document, 'Light');
      expect(dom.window.document.documentElement.dataset.theme).toBe('light');

      const leave = dom.window.document.querySelector('button[aria-label="leave"]');
      if (!(leave instanceof dom.window.HTMLButtonElement)) {
        throw new Error('Missing UI kit leave button.');
      }
      leave.click();
      expect(dom.window.document.body.textContent).toContain("I'll host");
    } finally {
      dom.window.close();
    }
  });

  it('serves the complete UI kit only through stable GET/HEAD development URLs', async () => {
    const server = await startUiKitDevServer();
    const expectedJavaScript = (await compileUiKitAsset(REPO_ROOT)).code;
    const expectedHtml = await readFile(resolve(REPO_ROOT, UI_KIT_HTML_PATH), 'utf8');
    const expectedStyle = await readFile(resolve(REPO_ROOT, UI_KIT_STYLE_PATH), 'utf8');
    const expectedReadme = await readFile(resolve(REPO_ROOT, UI_KIT_README_PATH), 'utf8');
    const resources = [
      {
        path: `${UI_KIT_PUBLIC_APP_PATH}/`,
        contentType: 'text/html; charset=utf-8',
        body: expectedHtml,
      },
      {
        path: `${UI_KIT_PUBLIC_APP_PATH}/index.html`,
        contentType: 'text/html; charset=utf-8',
        body: expectedHtml,
      },
      {
        path: `${UI_KIT_PUBLIC_APP_PATH}/app.css`,
        contentType: 'text/css; charset=utf-8',
        body: expectedStyle,
      },
      {
        path: `${UI_KIT_PUBLIC_APP_PATH}/README.md`,
        contentType: 'text/markdown; charset=utf-8',
        body: expectedReadme,
      },
      {
        path: `/${UI_KIT_OUTPUT_PATH}`,
        contentType: 'text/javascript; charset=utf-8',
        body: expectedJavaScript,
      },
    ];
    try {
      for (const method of ['GET', 'HEAD'] as const) {
        const redirect = await requestDevServer(server.origin, UI_KIT_PUBLIC_APP_PATH, method);
        expect(redirect.status, `${method} ${UI_KIT_PUBLIC_APP_PATH}`).toBe(307);
        expect(redirect.location, `${method} ${UI_KIT_PUBLIC_APP_PATH}`).toBe(
          `${UI_KIT_PUBLIC_APP_PATH}/`,
        );
        expect(redirect.cacheControl, `${method} ${UI_KIT_PUBLIC_APP_PATH}`).toBe('no-cache');
        expect(redirect.body, `${method} ${UI_KIT_PUBLIC_APP_PATH}`).toBe('');

        for (const resource of resources) {
          const response = await requestDevServer(server.origin, `${resource.path}?dev=1`, method);
          expect(response.status, `${method} ${resource.path}`).toBe(200);
          expect(response.contentType, `${method} ${resource.path}`).toBe(resource.contentType);
          expect(response.cacheControl, `${method} ${resource.path}`).toBe('no-cache');
          expect(response.body, `${method} ${resource.path}`).toBe(
            method === 'GET' ? resource.body : '',
          );
        }
      }

      const map = await requestDevServer(server.origin, `/${UI_KIT_OUTPUT_PATH}.map`, 'GET');
      expect(map.status).toBe(404);
      const post = await requestDevServer(server.origin, `/${UI_KIT_OUTPUT_PATH}`, 'POST');
      expect(post.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
