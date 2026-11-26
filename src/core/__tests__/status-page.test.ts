import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';

const PAGE_PATH = '.workshop/status/status.html';
const RUNTIME_PATH = 'browser/classic-runtime/status-page.ts';
const STYLE_PATH = '.workshop/status/status.css';
const DESIGN_TOKENS_PATH = 'public/designsystem/colors_and_type.css';
const FIXTURE_DIRECTORY = 'e2e/fixtures/status';
const MINUTE_MS = 60_000;
const COMPONENTS = ['website', 'rooms', 'connection', 'pro'] as const;
const SHOWN_SLOTS = 96;

type Fixture = Record<string, unknown>;

interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

interface StatusRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

interface StatusPage {
  readonly document: Document;
  readonly requests: readonly StatusRequest[];
  /** Moves the page's monotonic clock on, as a tab left open would. */
  advance(ms: number): void;
  /** Brings the tab back to the front, which reads /api/status again. */
  refocus(): Promise<void>;
}

let runtime = '';
let pageHtml = '';
const openPages: JSDOM[] = [];

beforeAll(async () => {
  const asset = CLASSIC_RUNTIME_ASSETS.find(
    (candidate) => candidate.outputPath === 'status-page.js',
  );
  if (!asset) throw new Error('The status page runtime is missing from the manifest.');
  [runtime, pageHtml] = await Promise.all([
    compileClassicRuntimeAsset(resolve('.'), asset).then(({ code }) => code),
    readFile(PAGE_PATH, 'utf8'),
  ]);
});

afterEach(() => {
  for (const dom of openPages.splice(0)) dom.window.close();
});

async function fixture(name: string): Promise<Fixture> {
  return JSON.parse(await readFile(`${FIXTURE_DIRECTORY}/${name}.json`, 'utf8')) as Fixture;
}

function answer(body: unknown): FakeResponse {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

/** Lets the page's fetch, JSON read and render finish. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((done) => setTimeout(done, 0));
  }
}

async function openStatusPage(
  reply: () => FakeResponse | Promise<FakeResponse>,
): Promise<StatusPage> {
  const dom = new JSDOM(pageHtml, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'https://musixquare.com/status',
  });
  openPages.push(dom);
  const { window } = dom;
  let monotonicMs = 1_000;
  Object.defineProperty(window.performance, 'now', {
    configurable: true,
    value: () => monotonicMs,
  });
  const requests: StatusRequest[] = [];
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return reply();
    },
  });
  window.eval(runtime);
  await settle();
  return {
    document: window.document,
    requests,
    advance(ms) {
      monotonicMs += ms;
    },
    async refocus() {
      window.document.dispatchEvent(new window.Event('visibilitychange'));
      await settle();
    },
  };
}

async function openWithFixture(name: string): Promise<StatusPage> {
  const body = await fixture(name);
  return openStatusPage(() => answer(body));
}

function element(document: Document, selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

function overall(document: Document): { state: string | undefined; text: string | null } {
  return {
    state: element(document, '.status-overall').dataset.state,
    text: element(document, '[data-slot="overall"]').textContent,
  };
}

function shownText(node: HTMLElement): string | null {
  return node.hidden ? null : node.textContent;
}

function meta(document: Document): string | null {
  return shownText(element(document, '[data-slot="meta"]'));
}

function row(document: Document, id: string): HTMLElement {
  return element(document, `.status-row[data-component="${id}"]`);
}

function rowWords(document: Document): Record<string, string | null> {
  return Object.fromEntries(
    COMPONENTS.map((id) => [
      id,
      row(document, id).querySelector('[data-slot="word"]')!.textContent,
    ]),
  );
}

function rowStates(document: Document): Record<string, string | undefined> {
  return Object.fromEntries(COMPONENTS.map((id) => [id, row(document, id).dataset.state]));
}

function marks(document: Document, id: string): string {
  return [...row(document, id).querySelectorAll<HTMLElement>('.status-checks__cell')]
    .map((cell) => cell.dataset.result)
    .join('');
}

function summary(document: Document, id: string): string | null {
  return row(document, id).querySelector('.status-checks__summary')?.textContent ?? null;
}

function note(document: Document): {
  message: string | null;
  posted: string | null;
  lang: string | null;
} | null {
  if (element(document, '[data-slot="notice"]').hidden) return null;
  const message = element(document, '[data-slot="notice-message"]');
  return {
    message: message.textContent,
    posted: shownText(element(document, '[data-slot="notice-posted"]')),
    lang: message.getAttribute('lang'),
  };
}

function withAnnouncement(body: Fixture, message: string): Fixture {
  return {
    ...body,
    announcement: { id: 'test-note', message, postedAt: body.generatedAt, expiresAt: null },
  };
}

/** The custom properties declared in the first `selector {` block. */
function customProperties(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing ${selector} block`);
  const block = css.slice(start, css.indexOf('}', start));
  return new Map(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/gu)].map(([, name, value]) => [
      name!,
      value!.trim(),
    ]),
  );
}

describe('the /status page runtime', () => {
  it('reads /api/status without a cache or credentials', async () => {
    const page = await openWithFixture('ok');
    expect(page.requests).toHaveLength(1);
    expect(page.requests[0]?.url).toBe('/api/status');
    expect(page.requests[0]?.init).toMatchObject({
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
  });

  it('shows every check passing with 96 bars per service', async () => {
    const { document } = await openWithFixture('ok');
    expect(overall(document)).toEqual({ state: 'ok', text: 'All checks passed' });
    expect(meta(document)).toBe('Checked 3 minutes ago');
    expect(rowStates(document)).toEqual({
      website: 'ok',
      rooms: 'ok',
      connection: 'ok',
      pro: 'ok',
    });
    expect(rowWords(document)).toEqual({
      website: 'Normal',
      rooms: 'Normal',
      connection: 'Normal',
      pro: 'Normal',
    });
    for (const id of COMPONENTS) {
      const checks = row(document, id).querySelector<HTMLElement>('[data-slot="checks"]')!;
      expect(checks.hidden, id).toBe(false);
      expect(marks(document, id), id).toBe('o'.repeat(SHOWN_SLOTS));
      expect(summary(document, id), id).toBe('Last 24 hours: all 96 checks passed');
      expect(checks.querySelector('.status-checks__cells')?.getAttribute('aria-hidden')).toBe(
        'true',
      );
      const cells = [...checks.querySelectorAll<HTMLElement>('.status-checks__cell')];
      expect(
        cells.every((cell) => cell.title.endsWith(' · Passed')),
        id,
      ).toBe(true);
    }
    expect(note(document)).toBeNull();
  });

  it('pads a record shorter than a day with leading cells the summary does not count', async () => {
    const { document } = await openWithFixture('short-record');
    expect(overall(document)).toEqual({ state: 'ok', text: 'All checks passed' });
    for (const id of COMPONENTS) {
      expect(marks(document, id), id).toBe(`${'x'.repeat(SHOWN_SLOTS - 6)}${'o'.repeat(6)}`);
      expect(summary(document, id), id).toBe('Last 24 hours: all 6 checks passed');
      const first = row(document, id).querySelector<HTMLElement>('.status-checks__cell')!;
      expect(first.title.endsWith(' · Before monitoring began')).toBe(true);
    }
  });

  it('names the one service with a problem, when it started, and the operator note', async () => {
    const { document } = await openWithFixture('problem');
    expect(overall(document)).toEqual({ state: 'problem', text: 'PRO rooms have a problem' });
    expect(meta(document)).toBe('Started 21 minutes ago, checked 7 minutes ago');
    expect(rowWords(document)).toEqual({
      website: 'Normal',
      rooms: 'Normal',
      connection: 'Normal',
      pro: 'Problem',
    });
    // One failed check keeps a row Normal; it still shows as one red bar.
    expect(marks(document, 'rooms')).toBe(`${'o'.repeat(83)}p${'o'.repeat(12)}`);
    expect(summary(document, 'rooms')).toBe('Last 24 hours: 1 failed check');
    expect(marks(document, 'pro')).toBe(`${'o'.repeat(94)}pp`);
    expect(summary(document, 'pro')).toBe('Last 24 hours: 2 failed checks');
    expect(note(document)).toEqual({
      message: "We're looking into problems joining PRO rooms. Regular rooms are working.",
      posted: 'Posted 4 minutes ago',
      lang: 'en',
    });
  });

  it("keeps the server's overall problem even when no row shows one", async () => {
    const { document } = await openWithFixture('server-problem');
    expect(overall(document)).toEqual({ state: 'problem', text: 'Some services have a problem' });
    expect(meta(document)).toBe('Checked 3 minutes ago');
    expect(Object.values(rowWords(document))).toEqual(['Normal', 'Normal', 'Normal', 'Normal']);
  });

  it('shows maintenance with its start, the maintenance bars and the note', async () => {
    const { document } = await openWithFixture('maintenance');
    expect(overall(document)).toEqual({ state: 'maintenance', text: 'Under maintenance' });
    expect(meta(document)).toBe('Started 12 minutes ago');
    expect(Object.values(rowWords(document))).toEqual([
      'Maintenance',
      'Maintenance',
      'Maintenance',
      'Maintenance',
    ]);
    for (const id of COMPONENTS) {
      expect(marks(document, id), id).toBe(`${'o'.repeat(95)}m`);
      expect(summary(document, id), id).toBe('Last 24 hours: 1 check during maintenance');
    }
    expect(note(document)).toEqual({
      message: "We're updating our servers. This should take about 30 minutes.",
      posted: 'Posted 14 minutes ago',
      lang: 'en',
    });
  });

  it('shows one service under maintenance without global maintenance', async () => {
    const { document } = await openWithFixture('maintenance-row');
    expect(overall(document)).toEqual({
      state: 'maintenance',
      text: 'Some services are under maintenance',
    });
    expect(meta(document)).toBe('Checked 3 minutes ago');
    expect(rowWords(document)).toEqual({
      website: 'Normal',
      rooms: 'Normal',
      connection: 'Normal',
      pro: 'Maintenance',
    });
    expect(summary(document, 'pro')).toBe('Last 24 hours: 1 check during maintenance');
  });

  it('says which services were not checked recently and for how long', async () => {
    const { document } = await openWithFixture('some-stale');
    expect(overall(document)).toEqual({
      state: 'stale',
      text: 'Some services weren’t checked recently',
    });
    expect(meta(document)).toBe('Not checked for 42 minutes');
    expect(rowWords(document)).toEqual({
      website: 'Not checked',
      rooms: 'Normal',
      connection: 'Not checked',
      pro: 'Normal',
    });
    expect(summary(document, 'website')).toBe('Last 24 hours: 2 missed checks');
    expect(marks(document, 'website')).toBe(`${'o'.repeat(94)}nn`);
  });

  it('shows no recent checks when every service is stale', async () => {
    const { document } = await openWithFixture('stale');
    expect(overall(document)).toEqual({ state: 'stale', text: 'No recent checks' });
    expect(meta(document)).toBe('Last checked 47 minutes ago');
    expect(Object.values(rowWords(document))).toEqual([
      'Not checked',
      'Not checked',
      'Not checked',
      'Not checked',
    ]);
    for (const id of COMPONENTS) {
      expect(summary(document, id), id).toBe('Last 24 hours: 3 missed checks');
    }
  });

  it('still shows the note while the results are unavailable', async () => {
    const { document } = await openWithFixture('unavailable-notice');
    expect(overall(document)).toEqual({ state: 'stale', text: 'Status is unavailable right now' });
    expect(meta(document)).toBe('Please try again shortly.');
    for (const id of COMPONENTS) {
      expect(row(document, id).dataset.state, id).toBe('empty');
      expect(row(document, id).querySelector('[data-slot="word"]')?.textContent, id).toBe('');
      const checks = row(document, id).querySelector<HTMLElement>('[data-slot="checks"]')!;
      expect(checks.hidden, id).toBe(true);
      expect(checks.childElementCount, id).toBe(0);
    }
    expect(note(document)).toEqual({
      message: "We're looking into connection problems.",
      posted: 'Posted 13 minutes ago',
      lang: 'en',
    });
  });

  it.each([
    ['a failed request', () => ({ ok: false, status: 503, json: () => Promise.resolve({}) })],
    ['a network error', () => Promise.reject(new Error('offline'))],
    ['an unknown schema', () => answer({ schemaVersion: 2 })],
  ] as const)('shows the unavailable view with no note after %s', async (_case, reply) => {
    const { document } = await openStatusPage(reply);
    expect(overall(document)).toEqual({ state: 'stale', text: 'Status is unavailable right now' });
    expect(meta(document)).toBe('Please try again shortly.');
    expect(note(document)).toBeNull();
    expect(Object.values(rowStates(document))).toEqual(['empty', 'empty', 'empty', 'empty']);
  });

  it('hides the note once it expires while the page stays open', async () => {
    const page = await openWithFixture('maintenance');
    expect(note(page.document)).not.toBeNull();

    // The note expires at 15:30, 25 minutes 40 seconds after this answer.
    page.advance(26 * MINUTE_MS);
    await page.refocus();
    expect(page.requests).toHaveLength(2);
    expect(note(page.document)).toBeNull();
    expect(overall(page.document)).toEqual({ state: 'maintenance', text: 'Under maintenance' });
    expect(meta(page.document)).toBe('Started 38 minutes ago');
  });

  it('ages an open page toward not checked and never back to normal', async () => {
    const page = await openWithFixture('ok');
    page.advance(31 * MINUTE_MS);
    await page.refocus();
    expect(overall(page.document)).toEqual({ state: 'stale', text: 'No recent checks' });
    expect(meta(page.document)).toBe('Last checked 34 minutes ago');
    expect(Object.values(rowWords(page.document))).toEqual([
      'Not checked',
      'Not checked',
      'Not checked',
      'Not checked',
    ]);
    expect(marks(page.document, 'rooms')).toBe('o'.repeat(SHOWN_SLOTS));
  });

  it('keeps the last good answer when a later read fails, and lets it age', async () => {
    const body = await fixture('ok');
    let failing = false;
    const page = await openStatusPage(() =>
      failing ? Promise.reject(new Error('offline')) : answer(body),
    );
    failing = true;
    page.advance(5 * MINUTE_MS);
    await page.refocus();
    expect(overall(page.document)).toEqual({ state: 'ok', text: 'All checks passed' });
    expect(meta(page.document)).toBe('Checked 8 minutes ago');

    page.advance(26 * MINUTE_MS);
    await page.refocus();
    expect(overall(page.document)).toEqual({ state: 'stale', text: 'No recent checks' });
  });

  it('keeps the newest answer when an older one arrives later', async () => {
    const [problem, ok] = await Promise.all([fixture('problem'), fixture('ok')]);
    let reply: Fixture = problem;
    const page = await openStatusPage(() => answer(reply));
    expect(overall(page.document).text).toBe('PRO rooms have a problem');
    reply = ok;
    await page.refocus();
    expect(overall(page.document).text).toBe('PRO rooms have a problem');
  });

  it('shows markup in a note as text and marks a Korean note as Korean', async () => {
    const ok = await fixture('ok');
    const markup = '<img src=x onerror="alert(1)"> <b>Back soon</b>';
    const page = await openStatusPage(() => answer(withAnnouncement(ok, markup)));
    expect(note(page.document)).toEqual({ message: markup, posted: 'Posted just now', lang: 'en' });
    expect(page.document.querySelector('[data-slot="notice-message"] *')).toBeNull();

    const korean = await openStatusPage(() =>
      answer(withAnnouncement(ok, '서버를 점검하고 있어요')),
    );
    expect(note(korean.document)?.lang).toBe('ko');
  });
});

describe('the /status page source', () => {
  it('describes the rooms check as a test guest joining a test room', async () => {
    const dom = new JSDOM(await readFile(PAGE_PATH, 'utf8'));
    try {
      const terms = [...dom.window.document.querySelectorAll('.status-how dt')].map((term) => [
        term.textContent,
        term.nextElementSibling?.textContent,
      ]);
      expect(terms).toContainEqual([
        'Creating and joining rooms',
        'A test room opens on our servers, and a test guest joins it.',
      ]);
    } finally {
      dom.window.close();
    }
  });

  it('writes its copy without em or en dashes', async () => {
    for (const file of [PAGE_PATH, RUNTIME_PATH]) {
      expect(await readFile(file, 'utf8'), file).not.toMatch(/[\u2013\u2014]/u);
    }
  });

  it('draws its state colors with the design system dark values', async () => {
    const [style, tokens] = await Promise.all([
      readFile(STYLE_PATH, 'utf8'),
      readFile(DESIGN_TOKENS_PATH, 'utf8'),
    ]);
    const page = customProperties(style, '.status-shell');
    const system = customProperties(tokens, ':root');
    for (const [pageToken, systemToken] of [
      ['--status-ok', '--success-filled'],
      ['--status-problem', '--danger-foreground'],
      ['--status-maintenance', '--warning-foreground'],
    ] as const) {
      expect(page.get(pageToken), pageToken).toMatch(/^#[0-9a-f]{6}$/u);
      expect(page.get(pageToken), pageToken).toBe(system.get(systemToken));
    }
  });
});
