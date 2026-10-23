/**
 * The real account pulse copies, each in its own document on one FakeOrigin
 * (structural plan C8, Phase 0c; registry RO-28).
 *
 * - App documents: the Vitest jsdom global (the real src/account/session.ts
 *   and, when a suite initializes it, src/ui/account.ts), and any number of
 *   JSDOM app documents that run an esbuild bundle of the real session.ts and
 *   state.ts. A bundled app document leaves out the account UI receiver: in a
 *   tab that did not start the login, that receiver filters every pulse out by
 *   accountClient, which the "success for another tab" row of
 *   account-pulse-contract.test.ts pins.
 * - The OAuth completion producer: the compiled classic runtime
 *   account-complete.js in public/account-complete.html, opened through a
 *   popup handle that records what the opener did to it.
 * - The events page: the compiled classic runtime events/event.js in
 *   public/events/index.html.
 *
 * `FakeAccountServer` is the origin's cookie session. Its completion redirect
 * is calibrated against cloudflare/account-auth.ts: the callback always
 * appends `accountAuth=<outcome>` to the sanitized returnTo. Every JSDOM
 * document's timers and Date run on the Vitest global clock, so
 * vi.useFakeTimers() drives all documents at once.
 *
 * Left out: real OAuth, cookies (the server holds one account for the whole
 * origin), service workers, the app shell outside the account dialog.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JSDOM, type DOMWindow } from 'jsdom';
import type * as SessionModule from '../../session.ts';
import type * as StateModule from '../../state.ts';
import {
  FakeOrigin,
  type FakeDocument,
  type FakeDocumentOptions,
  type FakeRealmWindow,
} from './fake-broadcast-channel.ts';

// Vitest runs from the repository root (import.meta.url is not a file URL under jsdom).
const REPOSITORY = process.cwd();
const SESSION_BUNDLE_GLOBAL = '__mxqrPulseAppDocument';

const PULSE_CAMPAIGN_SLUG = 'pulse-contract';
const EVENTS_SESSION_PATH = `/api/pro-grants/campaigns/${PULSE_CAMPAIGN_SLUG}/session`;
const ACCOUNT_SESSION_PATH = '/api/auth/session';

/** Replace one literal in a copy's source to prove a contract test notices drift. */
export interface SourceDrift {
  readonly find: string;
  readonly replace: string;
  /**
   * For a bundled app document, the repository file of its module graph to
   * edit (default src/account/session.ts); the app's wire literals live in
   * src/account/account-sync-protocol.ts. Classic runtimes are one file.
   */
  readonly path?: string;
}

// ─── The origin's account server ────────────────────────────────────

export interface ServerAccount {
  readonly nickname: string;
  readonly profileComplete: boolean;
  readonly statsScope: string;
}

export interface RecordedRequest {
  readonly doc: string;
  readonly method: string;
  readonly path: string;
}

export class FakeAccountServer {
  readonly origin: string;
  account: ServerAccount | null = null;
  readonly requests: RecordedRequest[] = [];
  private held: Array<() => void> | null = null;

  constructor(origin: string) {
    this.origin = origin;
  }

  /** Session reads by `doc` (the account session or the events campaign session). */
  sessionReads(doc: string): number {
    return this.requests.filter(
      (request) =>
        request.doc === doc &&
        request.method === 'GET' &&
        (request.path === ACCOUNT_SESSION_PATH || request.path === EVENTS_SESSION_PATH),
    ).length;
  }

  /**
   * Responses wait until release(). A held request ignores its abort signal;
   * the callers race their own deadlines (core/request-lifetime.ts, event.ts).
   */
  hold(): void {
    this.held ??= [];
  }

  release(): void {
    const waiting = this.held ?? [];
    this.held = null;
    for (const resume of waiting) resume();
  }

  fetchFor(doc: string): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), this.origin);
      const method = String(init?.method ?? 'GET').toUpperCase();
      this.requests.push({ doc, method, path: url.pathname });
      if (this.held) await new Promise<void>((resume) => this.held!.push(resume));
      return this.respond(method, url.pathname, init?.body);
    }) as typeof fetch;
  }

  private respond(method: string, path: string, body: unknown): Response {
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (method === 'GET' && path === ACCOUNT_SESSION_PATH) return json(this.sessionBody());
    if (method === 'POST' && (path === '/api/auth/logout' || path === '/api/auth/logout-all')) {
      this.account = null;
      return json({ ok: true });
    }
    if (method === 'DELETE' && path === '/api/auth/account' && this.account) {
      this.account = null;
      return json({ ok: true });
    }
    if (method === 'PATCH' && path === '/api/auth/profile' && this.account) {
      const nickname = (JSON.parse(String(body)) as { nickname: string }).nickname;
      this.account = { ...this.account, nickname, profileComplete: true };
      return json(this.sessionBody());
    }
    if (method === 'GET' && path === EVENTS_SESSION_PATH) {
      return json({
        campaign: { slug: PULSE_CAMPAIGN_SLUG, status: 'active', title: 'MUSIXQUARE PRO Pulse' },
        account: {
          authenticated: this.account !== null,
          profileComplete: this.account?.profileComplete === true,
          statsScope: this.account?.statsScope ?? null,
        },
        redemption: null,
      });
    }
    return json({ error: 'NOT_FOUND' }, 404);
  }

  private sessionBody() {
    return {
      configured: true,
      authenticated: this.account !== null,
      account: this.account
        ? { nickname: this.account.nickname, profileComplete: this.account.profileComplete }
        : null,
      statsScope: this.account?.statsScope ?? null,
    };
  }
}

// ─── Compiled copies ────────────────────────────────────────────────

const COMPILER = 'src/account/__tests__/__helpers__/compile-pulse-documents.mts';
const compileCache = new Map<string, Promise<string>>();

/** Compile in a plain Node process (see compile-pulse-documents.mts); cached per test file. */
function compileOnce(request: Record<string, unknown>): Promise<string> {
  const key = JSON.stringify(request);
  let compiled = compileCache.get(key);
  if (!compiled) {
    compiled = new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [join(REPOSITORY, COMPILER)], {
        cwd: REPOSITORY,
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
        else
          reject(
            new Error(`${COMPILER} exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`),
          );
      });
      // The request travels on stdin: a frozen source copy exceeds Windows' argv limit.
      child.stdin.end(key);
    });
    compileCache.set(key, compiled);
  }
  return compiled;
}

function applyDrift(code: string, drift: SourceDrift | undefined, label: string): string {
  if (!drift) return code;
  if (!code.includes(drift.find)) throw new Error(`${label} has no ${drift.find} to drift`);
  return code.replaceAll(drift.find, drift.replace);
}

/** A classic runtime compiled as the build compiles it, optionally with one literal drifted. */
async function classicRuntime(outputPath: string, drift?: SourceDrift): Promise<string> {
  return applyDrift(await compileOnce({ kind: 'classic', outputPath }), drift, outputPath);
}

/**
 * An IIFE of the real session.ts and state.ts for a JSDOM app document.
 * `sources` replaces whole repository files in that module graph (a frozen
 * older copy for a mixed-version tab); `drift` edits one file on top
 * (session.ts unless it names another).
 */
async function sessionBundle(
  drift?: SourceDrift,
  sources: Readonly<Record<string, string>> = {},
): Promise<string> {
  const overrides = { ...sources };
  if (drift) {
    const path = drift.path ?? 'src/account/session.ts';
    overrides[path] = applyDrift(overrides[path] ?? (await repositoryFile(path)), drift, path);
  }
  return compileOnce({
    kind: 'session',
    globalName: SESSION_BUNDLE_GLOBAL,
    ...(Object.keys(overrides).length > 0 ? { sources: overrides } : {}),
  });
}

async function repositoryFile(path: string): Promise<string> {
  return readFile(join(REPOSITORY, path), 'utf8');
}

let accountDialogMarkup: Promise<string> | null = null;

/**
 * Put the app's real account dialog markup (cut from index.html) into the
 * Vitest document, so ui/account.ts runs against the shipped element ids.
 */
export async function mountAccountDialog(): Promise<void> {
  accountDialogMarkup ??= repositoryFile('index.html').then((html) => {
    const parsed = new JSDOM(html);
    const overlay = parsed.window.document.getElementById('account-dialog-overlay');
    if (!overlay) throw new Error('index.html has no #account-dialog-overlay');
    const markup = overlay.outerHTML;
    parsed.window.close();
    return markup;
  });
  document.body.innerHTML = await accountDialogMarkup;
}

// ─── Documents ──────────────────────────────────────────────────────

export interface SessionDocument {
  readonly doc: FakeDocument;
  readonly window: DOMWindow;
  readonly session: typeof SessionModule;
  readonly state: typeof StateModule;
}

export interface CompletionDocument {
  readonly doc: FakeDocument;
  readonly window: DOMWindow;
  message(): string;
}

export interface EventsDocument {
  readonly doc: FakeDocument;
  readonly window: DOMWindow;
  readonly popups: FakeLoginPopup[];
  loginMessage(): string;
  view(): string | undefined;
  /** Click the page's account button (opens its own login popup when signed out). */
  clickAccountAction(): void;
  pagehide(persisted: boolean): void;
  pageshow(persisted: boolean): void;
}

type DocumentLoadOptions = FakeDocumentOptions & { readonly drift?: SourceDrift };

/** Node returns Timeout objects and Vitest's fake clock returns numbers; documents only pass them back. */
type TimerHandle = unknown;

interface TimerApi {
  setTimeout(handler: () => void, ms?: number, ...args: unknown[]): TimerHandle;
  setInterval(handler: () => void, ms?: number, ...args: unknown[]): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  clearInterval(handle: TimerHandle): void;
}

/** The Vitest global's timers, looked up per call so a clock faked later still applies. */
function globalClock(): TimerApi {
  return globalThis as unknown as TimerApi;
}

/** One origin, its server and the real pulse documents loaded on it. */
export class AccountPulseHarness {
  readonly origin: FakeOrigin;
  readonly server: FakeAccountServer;
  private readonly windows: DOMWindow[] = [];
  private readonly foreignOrigins: FakeOrigin[] = [];
  private readonly timers = new Set<TimerHandle>();
  private readonly restorers: Array<() => void> = [];

  /** Defaults to the Vitest jsdom origin so the global document can join. */
  constructor(origin = globalThis.location?.origin ?? 'https://musixquare.com') {
    this.origin = new FakeOrigin(origin);
    this.server = new FakeAccountServer(this.origin.origin);
  }

  /**
   * Join the Vitest jsdom global as an app document: its BroadcastChannel,
   * localStorage and fetch become this origin's. Code under test imported
   * normally (session.ts, ui/account.ts) then runs as this document.
   */
  attachTestDocument(name = 'app-a', options: FakeDocumentOptions = {}): FakeDocument {
    const doc = this.origin.attach(name, window as unknown as FakeRealmWindow, options);
    this.define(globalThis, 'fetch', { value: this.server.fetchFor(name), writable: true });
    return doc;
  }

  /** A same-origin document with no app code, for injecting raw pulses. */
  loadSenderDocument(name: string, options: FakeDocumentOptions = {}): FakeDocument {
    return this.loadBareDocument(name, this.origin, options);
  }

  /** A document of another origin (its own FakeOrigin), for cross-origin window messages. */
  loadForeignDocument(name: string, origin = 'https://foreign.example'): FakeDocument {
    return this.loadBareDocument(name, new FakeOrigin(origin), {});
  }

  /**
   * A second (third, ...) app tab running the real session.ts in its own JSDOM
   * window. `sources` swaps whole files of its module graph, for example a
   * frozen pre-change session.ts to run an old tab beside new ones.
   */
  async loadSessionDocument(
    name: string,
    options: DocumentLoadOptions & { readonly sources?: Readonly<Record<string, string>> } = {},
  ): Promise<SessionDocument> {
    const code = await sessionBundle(options.drift, options.sources);
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: `${this.origin.origin}/`,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    this.windows.push(dom.window);
    this.installPlatform(dom.window, name);
    const doc = this.origin.attach(name, dom.window as unknown as FakeRealmWindow, options);
    dom.window.eval(code);
    const exports = (dom.window as unknown as Record<string, unknown>)[SESSION_BUNDLE_GLOBAL] as {
      session: typeof SessionModule;
      state: typeof StateModule;
    };
    return { doc, window: dom.window, session: exports.session, state: exports.state };
  }

  /**
   * The OAuth completion page at `url`. `opener` is the document its
   * window.opener reaches, or null when the opener was severed.
   */
  async loadCompletionDocument(
    name: string,
    url: string,
    opener: FakeDocument | null,
    options: DocumentLoadOptions & { readonly onClose?: () => void } = {},
  ): Promise<CompletionDocument> {
    const [html, code] = await Promise.all([
      repositoryFile('public/account-complete.html'),
      classicRuntime('account-complete.js', options.drift),
    ]);
    const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
    this.windows.push(dom.window);
    this.installPlatform(dom.window, name);
    const doc = this.origin.attach(name, dom.window as unknown as FakeRealmWindow, options);
    this.define(dom.window, 'opener', { value: opener ? doc.windowProxy(opener) : null });
    this.define(dom.window, 'close', {
      value: () => {
        options.onClose?.();
        doc.unload();
      },
    });
    dom.window.eval(code);
    return {
      doc,
      window: dom.window,
      message: () =>
        dom.window.document.getElementById('account-complete-message')?.textContent ?? '',
    };
  }

  /** The events page for PULSE_CAMPAIGN_SLUG; resolves after its first session read settles. */
  async loadEventsDocument(
    name = 'events',
    options: DocumentLoadOptions = {},
  ): Promise<EventsDocument> {
    const [html, code] = await Promise.all([
      repositoryFile('public/events/index.html'),
      classicRuntime('events/event.js', options.drift),
    ]);
    const dom = new JSDOM(html, {
      url: `${this.origin.origin}/events/${PULSE_CAMPAIGN_SLUG}`,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    this.windows.push(dom.window);
    this.installPlatform(dom.window, name);
    installDialogMethods(dom.window);
    const doc = this.origin.attach(name, dom.window as unknown as FakeRealmWindow, options);
    const popups = this.interceptPopups(dom.window, doc);
    dom.window.eval(code);
    await this.origin.settle();
    const document = dom.window.document;
    return {
      doc,
      window: dom.window,
      popups,
      loginMessage: () => document.getElementById('login-message')?.textContent ?? '',
      view: () => document.documentElement.dataset.view,
      clickAccountAction: () => document.getElementById('account-action')!.click(),
      pagehide: (persisted) =>
        dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted })),
      pageshow: (persisted) =>
        dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted })),
    };
  }

  /**
   * Make `window.open` in `target` return login popups whose completion runs
   * on this origin. Returns the list the popups are appended to.
   */
  interceptPopups(target: object, opener: FakeDocument): FakeLoginPopup[] {
    const popups: FakeLoginPopup[] = [];
    this.define(target, 'open', {
      writable: true,
      value: () => {
        const popup = new FakeLoginPopup(this, opener, `popup-${opener.name}-${popups.length + 1}`);
        popups.push(popup);
        return popup.window;
      },
    });
    return popups;
  }

  /** Close JSDOM windows, cancel their timers and restore every patched global. */
  dispose(): void {
    for (const timer of this.timers) {
      globalClock().clearTimeout(timer);
      globalClock().clearInterval(timer);
    }
    this.timers.clear();
    this.origin.dispose();
    for (const origin of this.foreignOrigins.splice(0)) origin.dispose();
    for (const restore of this.restorers.splice(0).reverse()) restore();
    for (const window of this.windows.splice(0)) window.close();
  }

  private loadBareDocument(
    name: string,
    origin: FakeOrigin,
    options: FakeDocumentOptions,
  ): FakeDocument {
    const dom = new JSDOM('<!doctype html>', {
      url: `${origin.origin}/${name}`,
      runScripts: 'outside-only',
    });
    this.windows.push(dom.window);
    if (origin !== this.origin) this.foreignOrigins.push(origin);
    return origin.attach(name, dom.window as unknown as FakeRealmWindow, options);
  }

  /** Route a JSDOM window's fetch, timers, Date and animation frames to this harness. */
  private installPlatform(window: DOMWindow, name: string): void {
    const timers = this.timers;
    const clock = globalClock;
    const track = (handle: TimerHandle): TimerHandle => {
      timers.add(handle);
      return handle;
    };
    const define = (key: string, descriptor: PropertyDescriptor) =>
      Object.defineProperty(window, key, { configurable: true, ...descriptor });
    define('fetch', { value: this.server.fetchFor(name), writable: true });
    define('setTimeout', {
      value: (handler: () => void, ms?: number, ...args: unknown[]) =>
        track(clock().setTimeout(handler, ms, ...args)),
    });
    define('setInterval', {
      value: (handler: () => void, ms?: number, ...args: unknown[]) =>
        track(clock().setInterval(handler, ms, ...args)),
    });
    define('clearTimeout', { value: (handle: TimerHandle) => clock().clearTimeout(handle) });
    define('clearInterval', { value: (handle: TimerHandle) => clock().clearInterval(handle) });
    define('requestAnimationFrame', {
      value: (callback: (time: number) => void) =>
        track(clock().setTimeout(() => callback(globalThis.performance.now()), 16)),
    });
    define('cancelAnimationFrame', {
      value: (handle: TimerHandle) => clock().clearTimeout(handle),
    });
    define('Date', { get: () => globalThis.Date });
  }

  private define(target: object, key: string, descriptor: PropertyDescriptor): void {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    this.restorers.push(() => {
      if (previous) Object.defineProperty(target, key, previous);
      else delete (target as Record<string, unknown>)[key];
    });
  }
}

/**
 * jsdom has HTMLDialogElement without showModal()/close(). The events page
 * calls close() after a nickname save, so give the window the attribute and
 * `close` event behaviour every engine with <dialog> has (no top layer).
 */
function installDialogMethods(window: DOMWindow): void {
  const prototype = window.HTMLDialogElement.prototype as HTMLDialogElement;
  Object.defineProperty(prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      this.dispatchEvent(new window.Event('close'));
    },
  });
}

/**
 * The handle `window.open` returns for a login popup. It records what the
 * opener does (sever `opener`, replace the location, focus, close) and runs
 * the real completion page when the test finishes the OAuth round trip.
 */
export class FakeLoginPopup {
  readonly harness: AccountPulseHarness;
  readonly opener: FakeDocument;
  readonly name: string;
  readonly window: Window;
  replacedUrl: string | null = null;
  openerSevered = false;
  closed = false;
  focusCalls = 0;
  completion: CompletionDocument | null = null;

  constructor(harness: AccountPulseHarness, opener: FakeDocument, name: string) {
    this.harness = harness;
    this.opener = opener;
    this.name = name;
    const handle = {
      focus: () => {
        this.focusCalls += 1;
      },
      close: () => {
        this.closed = true;
      },
      location: {
        replace: (url: string) => {
          this.replacedUrl = String(url);
        },
      },
    };
    Object.defineProperties(handle, {
      closed: { enumerable: true, get: () => this.closed },
      opener: {
        enumerable: true,
        get: () => (this.openerSevered ? null : this.opener.window),
        set: (value: unknown) => {
          if (value === null) this.openerSevered = true;
        },
      },
    });
    this.window = handle as unknown as Window;
  }

  /** The return path the opener put into the OAuth start URL. */
  get returnTo(): string {
    if (!this.replacedUrl) throw new Error(`${this.name} was never sent to the OAuth start URL`);
    const start = new URL(this.replacedUrl, this.harness.origin.origin);
    return start.searchParams.get('returnTo') ?? '';
  }

  /** The accountClient the opener correlates its completion with. */
  get accountClient(): string | null {
    return new URL(this.returnTo, this.harness.origin.origin).searchParams.get('accountClient');
  }

  /** Where the OAuth callback redirects (cloudflare/account-auth.ts appends accountAuth). */
  completionUrl(outcome: 'success' | 'cancelled' | 'error'): string {
    const destination = new URL(this.returnTo, this.harness.origin.origin);
    destination.searchParams.set('accountAuth', outcome);
    return destination.toString();
  }

  /** Finish OAuth: the popup navigates to the real completion page. */
  async complete(
    outcome: 'success' | 'cancelled' | 'error',
    options: DocumentLoadOptions = {},
  ): Promise<CompletionDocument> {
    if (this.closed) throw new Error(`${this.name} is closed`);
    this.completion = await this.harness.loadCompletionDocument(
      this.name,
      this.completionUrl(outcome),
      this.openerSevered ? null : this.opener,
      {
        ...options,
        onClose: () => {
          this.closed = true;
        },
      },
    );
    return this.completion;
  }

  /**
   * The popup window is gone: the user closed it, or the completion page
   * closed itself while the opener was not running timers.
   */
  closeWindow(): void {
    this.closed = true;
    this.completion?.doc.unload();
  }
}
