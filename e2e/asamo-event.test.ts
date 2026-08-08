import { expect, test, type Page, type Route } from '@playwright/test';

const SESSION_URL = '**/api/pro-grants/campaigns/asamo-0/session';
const REDEEM_URL = '**/api/pro-grants/campaigns/asamo-0/redeem';
const SETUP_LINK_URL = '**/api/pro-grants/campaigns/asamo-0/setup-link';

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    campaign: {
      slug: 'asamo-0',
      title: 'MUSIXQUARE 아사모 이벤트',
      status: 'active',
      startsAt: null,
      endsAt: null,
    },
    account: { authenticated: true, profileComplete: true },
    redemption: null,
    ...overrides,
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  });
}

async function openEvent(page: Page): Promise<void> {
  await page.goto('/events/asamo/0/');
  await expect(page.locator('.event-panel')).toBeVisible();
}

test.describe('ASAMO PRO grant event', () => {
  test('derives a future campaign slug only from its nested pathname', async ({ page }) => {
    let requested = false;
    await page.route('**/api/pro-grants/campaigns/apple-community-2/session', (route) => {
      requested = true;
      return fulfillJson(
        route,
        activeSession({
          campaign: {
            slug: 'apple-community-2',
            title: 'MUSIXQUARE 애플 커뮤니티 이벤트',
            status: 'active',
            startsAt: null,
            endsAt: null,
          },
        }),
      );
    });

    await page.goto('/events/apple-community/2/');

    await expect(
      page.getByRole('heading', { name: '이벤트에서 받은 리딤 코드를 입력해 주세요' }),
    ).toBeVisible();
    await expect(page.locator('#campaign-name')).toHaveText('애플 커뮤니티 이벤트');
    await expect(page).toHaveTitle('MUSIXQUARE 애플 커뮤니티 이벤트');
    expect(requested).toBe(true);
    expect(new URL(page.url()).search).toBe('');
    expect(new URL(page.url()).hash).toBe('');
  });

  test('fails closed when the session campaign does not match the pathname', async ({ page }) => {
    await page.route(SESSION_URL, (route) =>
      fulfillJson(
        route,
        activeSession({
          campaign: {
            slug: 'different-0',
            title: 'MUSIXQUARE 다른 이벤트',
            status: 'active',
            startsAt: null,
            endsAt: null,
          },
        }),
      ),
    );

    await openEvent(page);
    await expect(page.getByRole('heading', { name: '이벤트를 불러오지 못했어요' })).toBeVisible();
    await expect(page.locator('#campaign-name')).toHaveText('PRO 이벤트');
    await expect(page.getByLabel('리딤 코드 입력')).toBeHidden();
  });

  test('keeps a plaintext voucher out of the URL when the event script is unavailable', async ({
    page,
  }) => {
    const secret = 'MXQ-7KDP9-V2MQ4-XR8CW-H3N6T';
    let apiCalls = 0;
    await page.route('**/events/event.js', (route) => route.abort());
    await page.route('**/api/pro-grants/**', async (route) => {
      apiCalls += 1;
      await route.abort();
    });

    await openEvent(page);
    await page.evaluate(() => {
      const redeemStep = document.querySelector<HTMLElement>('[data-step="redeem"]');
      if (!redeemStep) throw new Error('redeem step missing');
      document.querySelectorAll<HTMLElement>('.step').forEach((step) => {
        step.classList.remove('is-active');
        step.setAttribute('aria-hidden', 'true');
        step.inert = true;
      });
      redeemStep.classList.add('is-active');
      redeemStep.setAttribute('aria-hidden', 'false');
      redeemStep.inert = false;
      document.documentElement.dataset.view = 'redeem';
    });
    const input = page.locator('#redeem-code');
    await input.fill(secret);
    await input.press('Enter');
    await page.locator('#redeem-submit').click();

    const location = new URL(page.url());
    expect(location.pathname).toBe('/events/asamo/0/');
    expect(location.search).toBe('');
    expect(location.hash).toBe('');
    expect(page.url()).not.toContain(secret);
    expect(apiCalls).toBe(0);
  });

  test('redeems into the minimal setup handoff without persisting the code', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route(SESSION_URL, (route) => fulfillJson(route, activeSession()));

    let submittedCode = '';
    await page.route(REDEEM_URL, async (route) => {
      const body = route.request().postDataJSON() as { code?: string };
      submittedCode = body.code ?? '';
      expect(route.request().headers()['x-mxqr-account-csrf']).toBe('1');
      await fulfillJson(
        route,
        {
          outcome: 'redeemed',
          roomCode: '000122',
          roomGeneration: 0,
          setupRequired: true,
        },
        201,
      );
    });

    await openEvent(page);
    await expect(
      page.getByRole('heading', { name: '이벤트에서 받은 리딤 코드를 입력해 주세요' }),
    ).toBeVisible();
    await expect(page.locator('#campaign-name')).toHaveText('아사모 이벤트');
    await expect(page).toHaveTitle('MUSIXQUARE 아사모 이벤트');

    const input = page.getByLabel('리딤 코드 입력');
    await input.fill('mxq-7kdp9-v2mq4-xr8cw-h3n6t');
    await page.getByRole('button', { name: '확인하기' }).click();

    await expect(page.getByRole('heading', { name: '축하드려요!' })).toBeVisible();
    await expect(page.getByText('000122번 PRO 방을 받았어요.')).toBeVisible();
    await expect(page.getByRole('button', { name: '방 설정 시작하기' })).toBeVisible();
    await expect(page.getByText('MY PRO ROOM')).toHaveCount(0);
    expect(submittedCode).toBe('MXQ-7KDP9-V2MQ4-XR8CW-H3N6T');

    const persistence = await page.evaluate(
      (secrets) => {
        const values = [...Object.values(localStorage), ...Object.values(sessionStorage)].join(
          '\n',
        );
        return {
          stored: secrets.some((secret) => values.includes(secret)),
          address: location.href,
        };
      },
      [submittedCode],
    );
    expect(persistence.stored).toBe(false);
    expect(persistence.address).not.toContain(submittedCode);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('requires the existing account nickname completion before redeeming', async ({ page }) => {
    let profileComplete = false;
    await page.route(SESSION_URL, (route) =>
      fulfillJson(
        route,
        activeSession({
          account: { authenticated: true, profileComplete },
        }),
      ),
    );
    await page.route('**/api/auth/profile', async (route) => {
      expect(route.request().method()).toBe('PATCH');
      expect(route.request().headers()['x-mxqr-account-csrf']).toBe('1');
      expect(route.request().postDataJSON()).toEqual({ nickname: '아사모회원' });
      profileComplete = true;
      await fulfillJson(route, {
        configured: true,
        authenticated: true,
        account: { nickname: '아사모회원', profileComplete: true },
        statsScope: null,
      });
    });

    await openEvent(page);
    const dialog = page.getByRole('dialog', { name: '닉네임 설정' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('닉네임').fill('아사모회원');
    await dialog.getByRole('button', { name: '확인' }).click();

    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('heading', { name: '이벤트에서 받은 리딤 코드를 입력해 주세요' }),
    ).toBeVisible();
  });

  test('mints a setup link on click for an existing redemption after the campaign ends', async ({
    page,
  }) => {
    let reads = 0;
    let setupCalls = 0;
    const claimFragment = 'fresh-account-bound-claim';
    await page.route('**/000122', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>handoff</title>',
      }),
    );
    await page.route(SESSION_URL, (route) => {
      reads += 1;
      return fulfillJson(
        route,
        activeSession({
          campaign: {
            slug: 'asamo-0',
            status: 'ended',
            startsAt: null,
            endsAt: Date.now() - 1000,
          },
          redemption: {
            status: 'redeemed',
            roomCode: '000122',
            roomGeneration: 0,
            setupRequired: true,
          },
        }),
      );
    });
    await page.route(SETUP_LINK_URL, async (route) => {
      setupCalls += 1;
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['x-mxqr-account-csrf']).toBe('1');
      expect(route.request().postDataJSON()).toEqual({});
      await fulfillJson(route, {
        roomCode: '000122',
        roomGeneration: 0,
        setupRequired: true,
        activationUrl: `/000122#${claimFragment}`,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
    });

    await openEvent(page);
    await expect(page.getByRole('heading', { name: '축하드려요!' })).toBeVisible();
    await page.getByRole('button', { name: '방 설정 시작하기' }).click();

    await expect(page).toHaveURL(/\/000122#fresh-account-bound-claim$/);
    expect(reads).toBe(1);
    expect(setupCalls).toBe(1);
    const claimStored = await page.evaluate(
      (secret) =>
        [...Object.values(localStorage), ...Object.values(sessionStorage)].some((value) =>
          value.includes(secret),
        ),
      claimFragment,
    );
    expect(claimStored).toBe(false);
  });

  test('keeps used-code failure single-purpose and lets the user try another code', async ({
    page,
  }) => {
    await page.route(SESSION_URL, (route) => fulfillJson(route, activeSession()));
    await page.route(REDEEM_URL, (route) => fulfillJson(route, { error: 'REDEEM_CODE_USED' }, 409));

    await openEvent(page);
    await page.getByLabel('리딤 코드 입력').fill('AS1-USED-CODE');
    await page.getByRole('button', { name: '확인하기' }).click();

    await expect(
      page.getByRole('heading', { name: '아쉽게도 이미 사용된 코드예요' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '다른 코드 입력하기' }).click();
    await expect(page.getByLabel('리딤 코드 입력')).toBeFocused();
    await expect(page.getByLabel('리딤 코드 입력')).toHaveValue('');
  });

  test('explains the global one-PRO-per-account policy without offering a retry', async ({
    page,
  }) => {
    await page.route(SESSION_URL, (route) => fulfillJson(route, activeSession()));
    await page.route(REDEEM_URL, (route) =>
      fulfillJson(route, { error: 'ACCOUNT_PRO_ROOM_LIMIT_REACHED' }, 409),
    );

    await openEvent(page);
    await page.getByLabel('리딤 코드 입력').fill('AS1-OTHER-CODE');
    await page.getByRole('button', { name: '확인하기' }).click();

    await expect(
      page.getByRole('heading', { name: '이 계정에는 이미 PRO 방이 있어요' }),
    ).toBeVisible();
    await expect(page.getByText('PRO 방은 계정당 하나만 받을 수 있어요.')).toBeVisible();
    await expect(page.getByRole('button', { name: '다시 시도' })).toHaveCount(0);
  });

  test('shows the trusted Google entry point and legal links for an anonymous account', async ({
    page,
  }) => {
    await page.route(SESSION_URL, (route) =>
      fulfillJson(
        route,
        activeSession({ account: { authenticated: false, profileComplete: false } }),
      ),
    );

    await openEvent(page);
    await expect(page.getByRole('button', { name: 'Google로 계속하기' })).toBeVisible();
    await expect(page.getByRole('link', { name: '이용약관' })).toHaveAttribute('href', '/terms');
    await expect(page.getByRole('link', { name: '개인정보 처리방침' })).toHaveAttribute(
      'href',
      '/privacy',
    );
  });
});
