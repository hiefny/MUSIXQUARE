import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import type { Draft } from '../.workshop/translate/drafts.ts';
import { E2E_APP_ORIGIN } from './config.ts';

const storageKey = 'musixquare.translate.drafts.v1';
const scope = 'A'.repeat(43);
interface Submission {
  requestId: string;
  draft: Draft;
}

async function setup(context: BrowserContext, handler: (route: Route) => Promise<void>) {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== E2E_APP_ORIGIN) return route.abort();
    if (url.pathname === '/api/auth/session')
      return route.fulfill({
        json: {
          configured: true,
          authenticated: true,
          statsScope: scope,
          account: { nickname: 'Contributor', profileComplete: true },
        },
      });
    if (url.pathname.startsWith('/api/translations/suggestions')) {
      if (route.request().method() === 'GET')
        return route.fulfill({ json: { suggestions: [], nextCursor: null } });
      return handler(route);
    }
    if (url.pathname.startsWith('/api/'))
      return route.fulfill({ status: 503, json: { error: 'LOCAL_ONLY' } });
    return route.continue();
  });
}

async function boot(page: Page) {
  await page.goto('/translate.html');
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#submit-suggestion')).toHaveText('Submit publicly');
}

function receipt(body: Submission) {
  return {
    suggestion: {
      ...body.draft,
      id: 'c52bff23-52e7-4e84-a791-c55557801902',
      author: 'Contributor',
      createdAt: Date.now(),
      status: 'pending',
      revision: 1,
      votes: 0,
      voted: false,
      owned: true,
      outdated: false,
      applied: false,
    },
  };
}

async function rejectDraftWrites(page: Page) {
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'musixquare.translate.drafts.v1')
        throw new DOMException('Quota', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
}

test('translation input persists and submits its saved revision without randomUUID', async ({
  context,
  page,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requests: Submission[] = [];
  await setup(context, async (route) => {
    const body = route.request().postDataJSON() as Submission;
    requests.push(body);
    await route.fulfill({ json: receipt(body) });
  });
  await boot(page);
  await page.locator('#proposal').fill('Portable revision<br>wording');
  await page.locator('#reason').fill('Natural wording');
  await expect(page.locator('#save-status')).toHaveText('Saved locally');
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!).drafts[0] as Draft,
    storageKey,
  );
  expect(saved.revisionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  await page.reload();
  await expect(page.locator('#proposal')).toHaveValue(saved.proposed);
  await expect(page.locator('#reason')).toHaveValue(saved.reason);
  await page.locator('#submit-suggestion').click();
  await expect(page.locator('#submit-status')).toContainText('Submitted');
  expect(requests).toHaveLength(1);
  expect(requests[0]!.draft).toEqual(saved);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  expect(errors).toEqual([]);
});

test('translation retry survives response loss and reload without changing request identity', async ({
  context,
  page,
}) => {
  const requests: Submission[] = [];
  await setup(context, async (route) => {
    requests.push(route.request().postDataJSON() as Submission);
    if (requests.length === 1) await route.abort('connectionreset');
    else await route.fulfill({ json: receipt(requests.at(-1)!) });
  });
  await boot(page);
  await page.locator('#proposal').fill('Retry after reload<br>wording');
  await page.locator('#submit-suggestion').click();
  await expect(page.locator('#submit-status')).toContainText('Connection failed');
  await page.reload();
  await expect(page.locator('#proposal')).toHaveValue('Retry after reload<br>wording');
  await page.locator('#submit-suggestion').click();
  await expect(page.locator('#submit-status')).toContainText('Submitted');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

test('two native tabs submit the same saved revision under the same request ID', async ({
  context,
  page,
}) => {
  const pending: { route: Route; body: Submission }[] = [];
  await setup(context, async (route) => {
    pending.push({ route, body: route.request().postDataJSON() as Submission });
  });
  await boot(page);
  await page.locator('#proposal').fill('Shared saved draft<br>wording');
  await expect(page.locator('#save-status')).toHaveText('Saved locally');
  const other = await context.newPage();
  await boot(other);
  await Promise.all([
    page.locator('#submit-suggestion').click(),
    other.locator('#submit-suggestion').click(),
  ]);
  await expect.poll(() => pending.length).toBe(2);
  expect(pending[0]!.body).toEqual(pending[1]!.body);
  await Promise.all(pending.map(({ route, body }) => route.fulfill({ json: receipt(body) })));
  await expect(page.locator('#proposal')).toHaveValue('');
  await expect(other.locator('#proposal')).toHaveValue('');
});

test('a failed post-success draft cleanup reuses the receipt after reload', async ({
  context,
  page,
}) => {
  const pending: { route: Route; body: Submission }[] = [];
  await setup(context, async (route) => {
    pending.push({ route, body: route.request().postDataJSON() as Submission });
  });
  await boot(page);
  await page.locator('#proposal').fill('Cleanup retry<br>wording');
  await page.locator('#submit-suggestion').click();
  await expect.poll(() => pending.length).toBe(1);
  await rejectDraftWrites(page);
  await pending[0]!.route.fulfill({ json: receipt(pending[0]!.body) });
  await expect(page.locator('#submit-status')).toContainText('Submitted');
  await expect(page.locator('#storage-warning')).toBeVisible();
  await page.reload();
  await expect(page.locator('#proposal')).toHaveValue('Cleanup retry<br>wording');
  await page.locator('#submit-suggestion').click();
  await expect.poll(() => pending.length).toBe(2);
  expect(pending[1]!.body).toEqual(pending[0]!.body);
  await pending[1]!.route.fulfill({ json: receipt(pending[1]!.body) });
  await expect(page.locator('#submit-status')).toContainText('Submitted');
});

test('submission stops when the current draft cannot be saved', async ({ context, page }) => {
  const requests: Submission[] = [];
  await setup(context, async (route) => {
    requests.push(route.request().postDataJSON() as Submission);
    await route.abort();
  });
  await boot(page);
  await rejectDraftWrites(page);
  await page.locator('#proposal').fill('Keep my unsaved<br>wording');
  await expect(page.locator('#save-status')).toHaveText('Not saved. Copy your changes.');
  await page.locator('#submit-suggestion').click();
  await expect(page.locator('#submit-status')).toHaveText(
    'Save and review this draft before submitting.',
  );
  expect(requests).toEqual([]);
  await expect(page.locator('#proposal')).toHaveValue('Keep my unsaved<br>wording');
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull();
});

test('an independently composed identical proposal receives a new identity', async ({
  context,
  page,
}) => {
  const requests: Submission[] = [];
  await setup(context, async (route) => {
    const body = route.request().postDataJSON() as Submission;
    requests.push(body);
    await route.fulfill({ json: receipt(body) });
  });
  await boot(page);
  for (let index = 0; index < 2; index++) {
    await page.locator('#proposal').fill('Independent proposal<br>wording');
    await page.locator('#submit-suggestion').click();
    await expect(page.locator('#proposal')).toHaveValue('');
  }
  expect(requests).toHaveLength(2);
  expect(requests[0]!.requestId).not.toBe(requests[1]!.requestId);
});
