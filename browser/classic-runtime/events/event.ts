(function () {
  'use strict';

  interface JsonObject {
    readonly [key: string]: unknown;
  }

  interface ApiError extends Error {
    readonly code: string;
    readonly status: number;
  }

  interface JsonRequestOptions {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  }

  interface EventRedemption {
    readonly status?: string;
    readonly roomCode: string;
    readonly roomGeneration: number;
    readonly setupRequired: boolean;
  }

  interface EventSession {
    readonly campaignStatus: string;
    readonly campaignTitle: string;
    readonly authenticated: boolean;
    readonly profileComplete: boolean;
    readonly statsScope: string | null;
    readonly redemption: EventRedemption | null;
  }

  interface LoadSessionOptions {
    readonly keepView?: boolean;
  }

  type CampaignNotice = readonly [title: string, message: string, retryable: boolean];

  function reportUnexpectedAsyncFailure(error: unknown): void {
    console.error('[event] Unexpected asynchronous action failure.', error);
  }

  function addAsyncEventListener(
    target: EventTarget,
    type: string,
    listener: (event: Event) => Promise<void>,
  ): void {
    target.addEventListener(type, (event) => {
      listener(event).catch(reportUnexpectedAsyncFailure);
    });
  }

  function requiredElement(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLElement)) throw new Error('Missing event control: #' + id);
    return element;
  }

  function requiredButton(id: string): HTMLButtonElement {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLButtonElement)) throw new Error('Missing event button: #' + id);
    return element;
  }

  function requiredInput(id: string): HTMLInputElement {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLInputElement)) throw new Error('Missing event input: #' + id);
    return element;
  }

  function requiredDialog(id: string): HTMLDialogElement {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLDialogElement)) throw new Error('Missing event dialog: #' + id);
    return element;
  }

  function requiredForm(id: string): HTMLFormElement {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLFormElement)) throw new Error('Missing event form: #' + id);
    return element;
  }

  function requiredSelector(selector: string): HTMLElement {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) throw new Error('Missing event element: ' + selector);
    return element;
  }

  const CAMPAIGN_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
  const CAMPAIGN_SLUG = campaignSlugFromPathname(window.location.pathname);
  const CAMPAIGN_API_BASE = CAMPAIGN_SLUG
    ? '/api/pro-grants/campaigns/' + encodeURIComponent(CAMPAIGN_SLUG)
    : '';
  const SESSION_ENDPOINT = CAMPAIGN_API_BASE + '/session';
  const REDEEM_ENDPOINT = CAMPAIGN_API_BASE + '/redeem';
  const SETUP_LINK_ENDPOINT = CAMPAIGN_API_BASE + '/setup-link';
  const ACCOUNT_SYNC_CHANNEL = 'mxqr-account-v1';
  const ACCOUNT_SYNC_STORAGE_KEY = 'mxqr-account-refresh';
  const REQUEST_TIMEOUT_MS = 15000;
  const RESPONSE_MAX_BYTES = 64 * 1024;
  const ROOM_CODE_PATTERN = /^0\d{5}$/;

  const steps = Array.from(document.querySelectorAll<HTMLElement>('.step'));
  const eventPanel = requiredSelector('.event-panel');
  const eventBrand = requiredSelector('.event-brand');
  const campaignName = requiredElement('campaign-name');
  const accountAction = requiredButton('account-action');
  const accountActionLabel = requiredElement('account-action-label');
  const loginDescription = requiredElement('login-description');
  const loginMessage = requiredElement('login-message');
  const redeemCode = requiredInput('redeem-code');
  const redeemMessage = requiredElement('redeem-message');
  const redeemSubmit = requiredButton('redeem-submit');
  const noticeTitle = requiredElement('notice-title');
  const noticeMessage = requiredElement('notice-message');
  const noticeActions = requiredElement('notice-actions');
  const noticeRetry = requiredButton('notice-retry');
  const nicknameDialog = requiredDialog('nickname-dialog');
  const nicknameForm = requiredForm('nickname-form');
  const nicknameInput = requiredInput('nickname-input');
  const nicknameMessage = requiredElement('nickname-message');
  const nicknameSubmit = requiredButton('nickname-submit');
  const nicknameCancel = requiredButton('nickname-cancel');
  const successRoomInline = requiredElement('success-room-inline');
  const successRoomGuide = requiredElement('success-room-guide');
  const setupGuide = requiredElement('setup-guide');
  const copyRoomButton = requiredButton('copy-room');
  const openRoomButton = requiredButton('open-room');
  const toast = requiredElement('toast');
  const tryAnotherButton = requiredButton('try-another');

  let currentRoomCode = '';
  let currentRoomGeneration: number | null = null;
  let roomSetupRequired = false;
  let needsProfile = false;
  let currentAccountScope: string | null = null;
  let accountGeneration = 0;
  let viewGeneration = 0;
  let redeemIntent: object | null = null;
  let setupIntent: object | null = null;
  let nicknameIntent: { scope: string; pending: boolean } | null = null;
  let profilePromptOffered = false;
  let authPopup: Window | null = null;
  let authPopupMonitor = 0;
  let authRefreshInFlight: Promise<void> | null = null;
  let sessionGeneration = 0;
  let sessionMutationRevision = 0;
  let toastTimer = 0;
  let authChannel: BroadcastChannel | null = null;
  const accountClientId = createClientId();

  function campaignSlugFromPathname(pathname: unknown): string {
    const path = String(pathname || '').replace(/\/$/, '');
    const direct = /^\/events\/([^/]+)$/.exec(path);
    if (direct && direct[1] && CAMPAIGN_SLUG_PATTERN.test(direct[1])) return direct[1];
    const legacy = /^\/events\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(\d+)$/.exec(path);
    if (!legacy) return '';
    const slug = legacy[1] + '-' + legacy[2];
    return CAMPAIGN_SLUG_PATTERN.test(slug) ? slug : '';
  }

  function normalizeCampaignTitle(value: unknown): string {
    if (typeof value !== 'string') return '';
    const title = value.trim();
    if (!title || title.length > 100 || /[\u0000-\u001f\u007f]/.test(title)) return '';
    return title;
  }

  function renderCampaignTitle(title: unknown): void {
    const normalized = normalizeCampaignTitle(title) || 'MUSIXQUARE PRO 이벤트';
    const shortTitle = normalized.replace(/^MUSIXQUARE\s+/i, '') || 'PRO 이벤트';
    document.title = normalized;
    campaignName.textContent = shortTitle;
    eventPanel.setAttribute('aria-label', normalized);
    eventBrand.setAttribute('aria-label', normalized);
  }

  function createClientId(): string {
    try {
      if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (_error) {
      // A correlation token is not an authorization credential.
    }
    return (
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2) +
      '-' +
      Math.random().toString(36).slice(2)
    );
  }

  function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function safeFocus(element: HTMLElement | null): void {
    if (!element) return;
    try {
      element.focus({ preventScroll: true });
    } catch (_error) {
      element.focus();
    }
  }

  function showToast(message: string): void {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('is-visible');
    toastTimer = window.setTimeout(function () {
      toast.classList.remove('is-visible');
    }, 2200);
  }

  function setView(view: string, focus?: boolean): void {
    const generation = ++viewGeneration;
    if (view !== 'redeem' && redeemIntent) {
      redeemIntent = null;
      redeemCode.disabled = false;
      setBusy(redeemSubmit, false, '확인하는 중', '확인하기');
    }
    if (view !== 'success') {
      setupIntent = null;
      setBusy(openRoomButton, false, '불러오는 중', '방 설정 시작하기');
    }
    document.documentElement.dataset.view = view;
    steps.forEach(function (step) {
      const active = step.dataset.step === view;
      step.classList.toggle('is-active', active);
      step.setAttribute('aria-hidden', String(!active));
      try {
        step.inert = !active;
      } catch (_error) {
        // aria-hidden and pointer-events remain the compatibility fallback.
      }
    });
    if (focus === false) return;
    window.requestAnimationFrame(function () {
      if (generation !== viewGeneration || nicknameDialog.open) return;
      if (view === 'redeem') safeFocus(redeemCode);
      else safeFocus(document.querySelector<HTMLElement>('[data-step="' + view + '"] h1'));
    });
  }

  function setBusy(
    button: HTMLButtonElement,
    busy: boolean,
    busyText: string,
    idleText: string,
  ): void {
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
    if (busyText && idleText) button.textContent = busy ? busyText : idleText;
  }

  function makeApiError(code: string, status: number): ApiError {
    return Object.assign(new Error(code), { code: code, status: status });
  }

  function isApiError(error: unknown): error is ApiError {
    return (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      'status' in error &&
      typeof error.status === 'number'
    );
  }

  async function requestJson(path: string, options?: JsonRequestOptions): Promise<JsonObject> {
    const controller = new AbortController();
    const timeout = window.setTimeout(function () {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(path, {
        method: options && options.method ? options.method : 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: Object.assign(
          { Accept: 'application/json' },
          options && options.headers ? options.headers : {},
        ),
        ...(options && options.body ? { body: options.body } : {}),
        signal: controller.signal,
      });
      const declaredLength = Number(response.headers.get('Content-Length') || '0');
      if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_MAX_BYTES) {
        throw makeApiError('INVALID_RESPONSE', 502);
      }
      const text = await response.text();
      if (text.length > RESPONSE_MAX_BYTES) throw makeApiError('INVALID_RESPONSE', 502);
      let payload: unknown = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (_error) {
          throw makeApiError('INVALID_RESPONSE', response.status || 502);
        }
      }
      if (!response.ok) {
        const code =
          isObject(payload) && typeof payload.error === 'string' ? payload.error : 'REQUEST_FAILED';
        throw makeApiError(code, response.status);
      }
      if (!isObject(payload)) throw makeApiError('INVALID_RESPONSE', 502);
      return payload;
    } catch (error) {
      if (isApiError(error)) throw error;
      throw makeApiError(
        error instanceof Error && error.name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
        0,
      );
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function normalizeRoomCode(value: unknown): string {
    return typeof value === 'string' && ROOM_CODE_PATTERN.test(value) ? value : '';
  }

  function normalizeRoomGeneration(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function safeRoomTarget(value: unknown, expectedRoomCode: string): string {
    if (typeof value !== 'string' || !value || value.length > 4096) return '';
    try {
      const url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin || url.username || url.password) return '';
      if (url.search) return '';
      if (expectedRoomCode && url.pathname.replace(/\/+$/, '') !== '/' + expectedRoomCode) {
        return '';
      }
      return url.pathname + url.search + url.hash;
    } catch (_error) {
      return '';
    }
  }

  function normalizeSession(payload: JsonObject): EventSession {
    const campaign = payload.campaign;
    const account = payload.account;
    if (!isObject(campaign) || !isObject(account)) {
      throw makeApiError('INVALID_RESPONSE', 502);
    }
    const campaignStatus = typeof campaign.status === 'string' ? campaign.status.toLowerCase() : '';
    if (
      campaign.slug !== CAMPAIGN_SLUG ||
      !campaignStatus ||
      typeof account.authenticated !== 'boolean'
    ) {
      throw makeApiError('INVALID_RESPONSE', 502);
    }
    const campaignTitle = normalizeCampaignTitle(campaign.title);
    if (campaign.title !== undefined && !campaignTitle) {
      throw makeApiError('INVALID_RESPONSE', 502);
    }
    let redemption: EventRedemption | null = null;
    if (payload.redemption !== null && payload.redemption !== undefined) {
      if (!isObject(payload.redemption)) throw makeApiError('INVALID_RESPONSE', 502);
      const roomCode = normalizeRoomCode(payload.redemption.roomCode);
      const roomGeneration = normalizeRoomGeneration(payload.redemption.roomGeneration);
      if (
        !roomCode ||
        roomGeneration === null ||
        typeof payload.redemption.setupRequired !== 'boolean'
      ) {
        throw makeApiError('INVALID_RESPONSE', 502);
      }
      redemption = {
        status:
          typeof payload.redemption.status === 'string'
            ? payload.redemption.status.toLowerCase()
            : '',
        roomCode: roomCode,
        roomGeneration: roomGeneration,
        setupRequired: payload.redemption.setupRequired,
      };
    }
    return {
      campaignStatus: campaignStatus,
      campaignTitle: campaignTitle,
      authenticated: account.authenticated,
      profileComplete: account.profileComplete === true,
      statsScope:
        account.authenticated &&
        typeof account.statsScope === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(account.statsScope)
          ? account.statsScope
          : null,
      redemption: redemption,
    };
  }

  function campaignNotice(status: string): CampaignNotice {
    if (status === 'scheduled' || status === 'pending' || status === 'draft') {
      return ['이벤트가 아직 시작되지 않았어요', '이벤트가 시작된 뒤 다시 방문해 주세요.', false];
    }
    if (status === 'ended' || status === 'closed' || status === 'revoked') {
      return ['이 이벤트는 종료되었어요', '참여해 주셔서 감사합니다.', false];
    }
    if (status === 'exhausted' || status === 'sold_out') {
      return ['준비된 PRO 방이 모두 지급되었어요', '다음 이벤트를 기다려 주세요.', false];
    }
    return ['이벤트를 잠시 이용할 수 없어요', '잠시 후 다시 시도해 주세요.', true];
  }

  function showNotice(title: string, message: string, retryable: boolean): void {
    noticeTitle.textContent = title;
    noticeMessage.textContent = message;
    noticeActions.hidden = !retryable;
    setView('notice');
  }

  function renderLogin(profileIncomplete: boolean): void {
    needsProfile = profileIncomplete;
    loginMessage.textContent = '';
    if (profileIncomplete) {
      loginDescription.textContent = '이벤트에 참여하려면 닉네임 설정을 마쳐 주세요.';
      accountActionLabel.textContent = '닉네임 설정하기';
      accountAction.classList.remove('is-auth-pending');
      accountAction.removeAttribute('aria-busy');
      accountAction.disabled = false;
    } else {
      loginDescription.textContent = '이벤트에 참여하시려면 먼저 로그인해 주세요.';
      accountActionLabel.textContent = 'Google로 계속하기';
    }
    setView('login');
  }

  function renderSuccess(redemption: EventRedemption): void {
    if (
      currentRoomCode !== redemption.roomCode ||
      currentRoomGeneration !== redemption.roomGeneration ||
      roomSetupRequired !== redemption.setupRequired
    ) {
      setupIntent = null;
      setBusy(openRoomButton, false, '불러오는 중', '방 설정 시작하기');
    }
    currentRoomCode = redemption.roomCode;
    currentRoomGeneration = redemption.roomGeneration;
    roomSetupRequired = redemption.setupRequired;
    successRoomInline.textContent = currentRoomCode;
    successRoomGuide.textContent = currentRoomCode;
    openRoomButton.textContent = roomSetupRequired ? '방 설정 시작하기' : 'MUSIXQUARE로 이동';

    if (roomSetupRequired) {
      replaceGuideRow(0, [createStrong('방 설정 시작하기'), '를 눌러요.']);
      replaceGuideRow(1, ['MUSIXQUARE에서 ', createStrong('시작하기'), '를 선택해요.']);
      replaceGuideRow(2, [createStrong('방 암호'), '를 설정하고 사용을 시작해요.']);
      replaceGuideRow(3, ['이후에는 ', successRoomGuide, '으로 입장해요.']);
    } else {
      replaceGuideRow(0, [createStrong('MUSIXQUARE로 이동'), '해요.']);
      replaceGuideRow(1, [createStrong('방 참여하기'), '를 선택해요.']);
      replaceGuideRow(2, [
        successRoomGuide,
        '을 입력하고 ',
        createStrong('시작하기'),
        '를 눌러요.',
      ]);
      replaceGuideRow(3, [createStrong('방 암호'), '로 입장해요.']);
    }
    setView('success');
  }

  function replaceGuideRow(index: number, parts: readonly (string | Node)[]): void {
    const item = setupGuide.children[index];
    const row = item && item.querySelector('span');
    if (!row) return;
    row.replaceChildren(
      ...parts.map(function (part) {
        return typeof part === 'string' ? document.createTextNode(part) : part;
      }),
    );
  }

  function createStrong(text: string): HTMLElement {
    const strong = document.createElement('strong');
    strong.textContent = text;
    return strong;
  }

  async function loadSession(options?: LoadSessionOptions): Promise<void> {
    const generation = ++sessionGeneration;
    const mutationRevision = sessionMutationRevision;
    if (!options || options.keepView !== true) setView('loading', false);
    try {
      if (!CAMPAIGN_SLUG) throw makeApiError('INVALID_CAMPAIGN_PATH', 400);
      const session = normalizeSession(await requestJson(SESSION_ENDPOINT));
      if (generation !== sessionGeneration) return;
      if (mutationRevision !== sessionMutationRevision) {
        await loadSession({ keepView: true });
        return;
      }
      if (currentAccountScope !== session.statsScope) {
        currentAccountScope = session.statsScope;
        accountGeneration += 1;
        currentRoomCode = '';
        currentRoomGeneration = null;
        roomSetupRequired = false;
        setupIntent = null;
        setBusy(openRoomButton, false, '불러오는 중', '방 설정 시작하기');
        resetRedeemForm();
        closeNicknameDialog();
        profilePromptOffered = false;
      }
      renderCampaignTitle(session.campaignTitle);
      if (session.authenticated && session.profileComplete && session.redemption) {
        needsProfile = false;
        profilePromptOffered = false;
        if (session.redemption.status === 'orphaned' || session.redemption.status === 'revoked') {
          showNotice(
            '이 PRO 방을 사용할 수 없어요',
            '도움이 필요하면 MUSIXQUARE 운영자에게 문의해 주세요.',
            false,
          );
          return;
        }
        renderSuccess(session.redemption);
        return;
      }
      if (session.campaignStatus !== 'active') {
        const notice = campaignNotice(session.campaignStatus);
        showNotice(notice[0], notice[1], notice[2]);
        return;
      }
      if (!session.authenticated) {
        profilePromptOffered = false;
        renderLogin(false);
        return;
      }
      if (!session.profileComplete) {
        renderLogin(true);
        if (!profilePromptOffered) {
          profilePromptOffered = true;
          window.setTimeout(openNicknameDialog, 0);
        }
        return;
      }
      needsProfile = false;
      profilePromptOffered = false;
      setView('redeem');
    } catch (_error) {
      if (generation !== sessionGeneration) return;
      if (mutationRevision !== sessionMutationRevision) {
        await loadSession({ keepView: true });
        return;
      }
      showNotice('이벤트를 불러오지 못했어요', '연결을 확인한 뒤 다시 시도해 주세요.', true);
    }
  }

  function resetAccountAction() {
    if (authPopup) {
      accountAction.disabled = true;
      accountAction.setAttribute('aria-busy', 'true');
      accountActionLabel.textContent = '로그인 창을 확인해 주세요';
      return;
    }
    accountAction.disabled = false;
    accountAction.removeAttribute('aria-busy');
    accountActionLabel.textContent = needsProfile ? '닉네임 설정하기' : 'Google로 계속하기';
  }

  function stopAuthPopupMonitor() {
    if (!authPopupMonitor) return;
    window.clearInterval(authPopupMonitor);
    authPopupMonitor = 0;
  }

  function monitorAuthPopup(popup: Window): void {
    stopAuthPopupMonitor();
    authPopupMonitor = window.setInterval(function () {
      if (authPopup !== popup) {
        stopAuthPopupMonitor();
        return;
      }
      let closed = false;
      try {
        closed = popup.closed;
      } catch (_error) {
        return;
      }
      if (!closed) return;
      authPopup = null;
      stopAuthPopupMonitor();
      resetAccountAction();
      refreshAfterAuthSignal().catch(reportUnexpectedAsyncFailure);
    }, 250);
  }

  function refreshAfterAuthSignal(): Promise<void> {
    if (authRefreshInFlight) {
      // A newer auth signal may postdate the cookie sampled by the pending read.
      sessionMutationRevision += 1;
      return authRefreshInFlight;
    }
    authRefreshInFlight = loadSession({ keepView: true }).finally(function () {
      authRefreshInFlight = null;
      resetAccountAction();
    });
    return authRefreshInFlight;
  }

  function handleAuthSignal(data: unknown): void {
    if (!isObject(data) || data.type !== 'refresh') return;
    if (
      (data.accountAuth === 'cancelled' || data.accountAuth === 'error') &&
      data.accountClient === accountClientId
    ) {
      loginMessage.textContent =
        data.accountAuth === 'cancelled'
          ? '로그인이 취소됐어요.'
          : '로그인하지 못했어요. 다시 시도해 주세요.';
    }
    authPopup = null;
    stopAuthPopupMonitor();
    refreshAfterAuthSignal().catch(reportUnexpectedAsyncFailure);
  }

  function openGoogleLogin(): void {
    loginMessage.textContent = '';
    accountAction.disabled = true;
    accountAction.setAttribute('aria-busy', 'true');
    accountActionLabel.textContent = '로그인 창을 확인해 주세요';

    const completionPath =
      '/account-complete.html?accountClient=' + encodeURIComponent(accountClientId);
    const loginUrl = '/api/auth/google/start?returnTo=' + encodeURIComponent(completionPath);
    let popup = null;
    try {
      popup = window.open(
        'about:blank',
        'mxqr-event-google-' + accountClientId,
        'popup=yes,width=520,height=720,resizable=yes,scrollbars=yes',
      );
    } catch (_error) {
      popup = null;
    }
    if (!popup) {
      loginMessage.textContent = '로그인 창을 열 수 없어요. 브라우저의 팝업 설정을 확인해 주세요.';
      resetAccountAction();
      return;
    }

    authPopup = popup;
    try {
      popup.opener = null;
      popup.location.replace(loginUrl);
      popup.focus();
    } catch (_error) {
      try {
        popup.close();
      } catch (_closeError) {
        // Best-effort cleanup only.
      }
      authPopup = null;
      loginMessage.textContent = '로그인 창을 열지 못했어요. 다시 시도해 주세요.';
      resetAccountAction();
      return;
    }
    monitorAuthPopup(popup);
  }

  function openNicknameDialog(): void {
    if (!needsProfile || !currentAccountScope || nicknameDialog.open) return;
    const intent = { scope: currentAccountScope, pending: false };
    nicknameIntent = intent;
    nicknameMessage.textContent = '12자 이내로 입력해 주세요.';
    nicknameMessage.classList.remove('is-error');
    nicknameInput.setAttribute('aria-invalid', 'false');
    try {
      nicknameDialog.showModal();
    } catch (_error) {
      nicknameDialog.setAttribute('open', '');
    }
    window.requestAnimationFrame(function () {
      if (nicknameIntent !== intent || !nicknameDialog.open) return;
      safeFocus(nicknameInput);
    });
  }

  function closeNicknameDialog(): void {
    nicknameIntent = null;
    if (nicknameDialog.open) nicknameDialog.close();
    nicknameInput.value = '';
    nicknameInput.disabled = false;
    setBusy(nicknameSubmit, false, '저장하는 중', '확인');
    nicknameCancel.disabled = false;
  }

  function nicknameValidationMessage(value: string): string {
    const normalized = value.normalize('NFC');
    if (!normalized) return '닉네임을 입력해 주세요.';
    if (/\s/u.test(normalized) || /[\u115f\u1160\u2800\u3164\uffa0]/iu.test(normalized)) {
      return '닉네임에는 공백이나 보이지 않는 문자를 사용할 수 없어요.';
    }
    if (Array.from(normalized).length > 12) return '12자 이내로 입력해 주세요.';
    return '';
  }

  function showNicknameError(message: string): void {
    nicknameMessage.textContent = message;
    nicknameMessage.classList.add('is-error');
    nicknameInput.setAttribute('aria-invalid', 'true');
    safeFocus(nicknameInput);
  }

  async function saveNickname(event: Event): Promise<void> {
    event.preventDefault();
    const intent = nicknameIntent;
    if (!intent || intent.pending || !nicknameDialog.open || intent.scope !== currentAccountScope)
      return;
    const isCurrent = () =>
      nicknameIntent === intent && currentAccountScope === intent.scope && nicknameDialog.open;
    const nickname = nicknameInput.value.normalize('NFC');
    const validationMessage = nicknameValidationMessage(nickname);
    if (validationMessage) {
      showNicknameError(validationMessage);
      return;
    }
    intent.pending = true;
    nicknameInput.disabled = true;
    setBusy(nicknameSubmit, true, '저장하는 중', '확인');
    nicknameCancel.disabled = true;
    try {
      await requestJson('/api/auth/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-MXQR-Account-CSRF': '1',
          'X-MXQR-Account-Expected-Scope': intent.scope,
        },
        body: JSON.stringify({ nickname: nickname }),
      });
      if (!isCurrent()) return;
      closeNicknameDialog();
      showToast('닉네임을 설정했어요.');
      await loadSession({ keepView: true });
    } catch (error) {
      if (!isCurrent()) return;
      const apiError = isApiError(error) ? error : makeApiError('NETWORK_ERROR', 0);
      if (apiError.code === 'ACCOUNT_SESSION_CHANGED') {
        closeNicknameDialog();
        showToast('로그인 상태를 다시 확인해 주세요.');
        await loadSession({ keepView: true });
      } else if (apiError.code === 'NICKNAME_TAKEN') {
        showNicknameError('이미 사용 중인 닉네임이에요.');
      } else if (apiError.code === 'NICKNAME_INVALID') {
        showNicknameError('사용할 수 없는 닉네임이에요.');
      } else if (apiError.status === 401 || apiError.code === 'AUTH_REQUIRED') {
        closeNicknameDialog();
        renderLogin(false);
        loginMessage.textContent = '로그인이 만료됐어요. 다시 로그인해 주세요.';
      } else {
        showNicknameError('닉네임을 설정하지 못했어요. 잠시 후 다시 시도해 주세요.');
      }
    } finally {
      if (isCurrent()) {
        intent.pending = false;
        nicknameInput.disabled = false;
        setBusy(nicknameSubmit, false, '저장하는 중', '확인');
        nicknameCancel.disabled = false;
      }
    }
  }

  function resetRedeemForm(): void {
    redeemIntent = null;
    redeemCode.value = '';
    redeemCode.disabled = false;
    redeemCode.setAttribute('aria-invalid', 'false');
    redeemMessage.textContent = '';
    setBusy(redeemSubmit, false, '확인하는 중', '확인하기');
  }

  function showRedeemError(message: string): void {
    redeemCode.setAttribute('aria-invalid', 'true');
    redeemMessage.textContent = message;
    safeFocus(redeemCode);
  }

  async function submitRedeem(event: Event): Promise<void> {
    event.preventDefault();
    if (
      redeemIntent ||
      !currentAccountScope ||
      document.documentElement.dataset.view !== 'redeem'
    ) {
      return;
    }
    const code = redeemCode.value.trim().toUpperCase().replace(/\s+/g, '');
    if (!code) {
      showRedeemError('리딤 코드를 입력해 주세요.');
      return;
    }
    const intent = {};
    const generation = accountGeneration;
    const scope = currentAccountScope;
    redeemIntent = intent;
    const isCurrent = () =>
      redeemIntent === intent &&
      accountGeneration === generation &&
      currentAccountScope === scope &&
      document.documentElement.dataset.view === 'redeem';
    redeemCode.value = code;
    redeemCode.disabled = true;
    setBusy(redeemSubmit, true, '확인하는 중', '확인하기');
    redeemCode.setAttribute('aria-invalid', 'false');
    redeemMessage.textContent = '';

    try {
      const payload = await requestJson(REDEEM_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MXQR-Account-CSRF': '1',
          'X-MXQR-Account-Expected-Scope': scope,
        },
        body: JSON.stringify({ code: code }),
      });
      if (!isCurrent()) return;
      if (payload.outcome !== 'redeemed' && payload.outcome !== 'already_redeemed') {
        throw makeApiError('INVALID_RESPONSE', 502);
      }
      const roomCode = normalizeRoomCode(payload.roomCode);
      const roomGeneration = normalizeRoomGeneration(payload.roomGeneration);
      if (!roomCode || roomGeneration === null || typeof payload.setupRequired !== 'boolean') {
        throw makeApiError('INVALID_RESPONSE', 502);
      }
      redeemCode.value = '';
      // A status read started before this accepted mutation may still carry
      // the pre-redemption view. Re-read it after completion, preserving any
      // account-change signal instead of allowing that snapshot to undo success.
      sessionMutationRevision += 1;
      renderSuccess({
        roomCode: roomCode,
        roomGeneration: roomGeneration,
        setupRequired: payload.setupRequired,
      });
    } catch (error) {
      if (!isCurrent()) return;
      const apiError = isApiError(error) ? error : makeApiError('NETWORK_ERROR', 0);
      if (apiError.code === 'REDEEM_CODE_USED') {
        resetRedeemForm();
        setView('used');
        return;
      }
      if (apiError.code === 'ACCOUNT_SESSION_CHANGED') {
        resetRedeemForm();
        showToast('로그인 상태를 다시 확인해 주세요.');
        await loadSession();
      } else if (
        apiError.code === 'INVALID_REDEEM_CODE' ||
        apiError.code === 'REDEEM_CODE_INVALID'
      ) {
        showRedeemError('리딤 코드를 확인해 주세요.');
      } else if (apiError.code === 'ACCOUNT_SESSION_REQUIRED' || apiError.status === 401) {
        resetRedeemForm();
        renderLogin(false);
        loginMessage.textContent = '로그인이 만료됐어요. 다시 로그인해 주세요.';
      } else if (apiError.code === 'ACCOUNT_PROFILE_REQUIRED') {
        resetRedeemForm();
        needsProfile = true;
        profilePromptOffered = true;
        renderLogin(true);
        openNicknameDialog();
      } else if (apiError.code === 'ACCOUNT_CAMPAIGN_LIMIT_REACHED') {
        resetRedeemForm();
        showNotice(
          '이미 이 이벤트의 PRO 방을 받았어요',
          '이번 이벤트에서는 계정당 하나의 방을 받을 수 있어요.',
          false,
        );
      } else if (apiError.code === 'ACCOUNT_PRO_ROOM_LIMIT_REACHED') {
        resetRedeemForm();
        showNotice(
          '이 계정에는 이미 PRO 방이 있어요',
          'PRO 방은 계정당 하나만 받을 수 있어요.',
          false,
        );
      } else if (apiError.code === 'CAMPAIGN_NOT_ACTIVE') {
        resetRedeemForm();
        loadSession().catch(reportUnexpectedAsyncFailure);
      } else if (apiError.code === 'PRO_GRANT_UNAVAILABLE') {
        resetRedeemForm();
        showNotice('준비된 PRO 방이 모두 지급되었어요', '다음 이벤트를 기다려 주세요.', false);
      } else {
        showRedeemError('연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요.');
      }
    } finally {
      if (isCurrent()) {
        redeemIntent = null;
        redeemCode.disabled = false;
        setBusy(redeemSubmit, false, '확인하는 중', '확인하기');
      }
    }
  }

  async function copyText(value: string): Promise<void> {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('COPY_FAILED');
  }

  async function requestSetupTarget(
    expectedRoomCode: string,
    expectedRoomGeneration: number,
  ): Promise<string> {
    const payload = await requestJson(SETUP_LINK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MXQR-Account-CSRF': '1',
      },
      body: JSON.stringify({}),
    });
    const roomCode = normalizeRoomCode(payload.roomCode);
    const roomGeneration = normalizeRoomGeneration(payload.roomGeneration);
    if (
      roomCode !== expectedRoomCode ||
      roomGeneration !== expectedRoomGeneration ||
      typeof payload.setupRequired !== 'boolean'
    ) {
      throw makeApiError('INVALID_RESPONSE', 502);
    }
    if (!payload.setupRequired) return '/' + expectedRoomCode;

    const target = safeRoomTarget(payload.activationUrl, expectedRoomCode);
    const expiresAt =
      typeof payload.expiresAt === 'number' && Number.isSafeInteger(payload.expiresAt)
        ? payload.expiresAt
        : 0;
    if (!target || !expiresAt || expiresAt <= Date.now()) {
      throw makeApiError('INVALID_RESPONSE', 502);
    }
    return target;
  }

  accountAction.addEventListener('click', function () {
    if (needsProfile) openNicknameDialog();
    else openGoogleLogin();
  });

  redeemCode.addEventListener('input', function () {
    const normalized = redeemCode.value.toUpperCase().replace(/\s+/g, '');
    if (normalized !== redeemCode.value) redeemCode.value = normalized;
    redeemCode.setAttribute('aria-invalid', 'false');
    redeemMessage.textContent = '';
  });
  addAsyncEventListener(redeemSubmit, 'click', submitRedeem);
  redeemCode.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    submitRedeem(event).catch(reportUnexpectedAsyncFailure);
  });

  tryAnotherButton.addEventListener('click', function () {
    resetRedeemForm();
    setView('redeem');
  });

  noticeRetry.addEventListener('click', function () {
    loadSession().catch(reportUnexpectedAsyncFailure);
  });

  addAsyncEventListener(nicknameForm, 'submit', saveNickname);
  nicknameCancel.addEventListener('click', function () {
    closeNicknameDialog();
    safeFocus(accountAction);
  });
  nicknameDialog.addEventListener('close', function () {
    if (!nicknameDialog.open) closeNicknameDialog();
  });
  nicknameInput.addEventListener('input', function () {
    nicknameInput.setAttribute('aria-invalid', 'false');
    nicknameMessage.textContent = '12자 이내로 입력해 주세요.';
    nicknameMessage.classList.remove('is-error');
  });

  addAsyncEventListener(copyRoomButton, 'click', async function () {
    if (!currentRoomCode || document.documentElement.dataset.view !== 'success') return;
    const roomCode = currentRoomCode;
    const generation = accountGeneration;
    const isCurrent = () =>
      generation === accountGeneration &&
      roomCode === currentRoomCode &&
      document.documentElement.dataset.view === 'success';
    try {
      await copyText(roomCode);
      if (isCurrent()) showToast(roomCode + '을 복사했어요.');
    } catch (_error) {
      if (isCurrent()) showToast('방 번호는 ' + roomCode + '이에요.');
    }
  });

  addAsyncEventListener(openRoomButton, 'click', async function () {
    if (
      setupIntent ||
      !currentAccountScope ||
      !currentRoomCode ||
      currentRoomGeneration === null ||
      document.documentElement.dataset.view !== 'success'
    ) {
      return;
    }
    if (!roomSetupRequired) {
      window.location.assign('/' + currentRoomCode);
      return;
    }

    const expectedRoomCode = currentRoomCode;
    const expectedRoomGeneration = currentRoomGeneration;
    const intent = {};
    const generation = accountGeneration;
    setupIntent = intent;
    const isCurrent = () =>
      setupIntent === intent &&
      generation === accountGeneration &&
      currentRoomCode === expectedRoomCode &&
      currentRoomGeneration === expectedRoomGeneration &&
      document.documentElement.dataset.view === 'success';
    setBusy(openRoomButton, true, '불러오는 중', '방 설정 시작하기');
    try {
      const target = await requestSetupTarget(expectedRoomCode, expectedRoomGeneration);
      if (!isCurrent()) return;
      window.location.assign(target);
    } catch (error) {
      if (!isCurrent()) return;
      const apiError = isApiError(error) ? error : makeApiError('NETWORK_ERROR', 0);
      if (apiError.code === 'ACCOUNT_SESSION_REQUIRED' || apiError.status === 401) {
        showToast('로그인 상태를 다시 확인해 주세요.');
        await loadSession();
      } else if (apiError.code === 'ACCOUNT_PROFILE_REQUIRED') {
        await loadSession();
      } else {
        showToast('방 설정 링크를 불러오지 못했어요. 다시 시도해 주세요.');
      }
    } finally {
      if (isCurrent()) {
        setupIntent = null;
        setBusy(openRoomButton, false, '불러오는 중', '방 설정 시작하기');
      }
    }
  });

  window.addEventListener('message', function (event) {
    if (event.origin === window.location.origin) handleAuthSignal(event.data);
  });
  window.addEventListener('storage', function (event) {
    if (event.key !== ACCOUNT_SYNC_STORAGE_KEY) return;
    if (!event.newValue) {
      refreshAfterAuthSignal().catch(reportUnexpectedAsyncFailure);
      return;
    }
    try {
      handleAuthSignal(JSON.parse(event.newValue));
    } catch (_error) {
      refreshAfterAuthSignal().catch(reportUnexpectedAsyncFailure);
    }
  });
  window.addEventListener('focus', function () {
    if (authPopup) refreshAfterAuthSignal().catch(reportUnexpectedAsyncFailure);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && authPopup) {
      refreshAfterAuthSignal().catch(reportUnexpectedAsyncFailure);
    }
  });

  if (typeof BroadcastChannel !== 'undefined') {
    try {
      authChannel = new BroadcastChannel(ACCOUNT_SYNC_CHANNEL);
      authChannel.addEventListener('message', function (event) {
        handleAuthSignal(event.data);
      });
    } catch (_error) {
      authChannel = null;
    }
  }
  window.addEventListener('pagehide', function () {
    stopAuthPopupMonitor();
    try {
      if (authChannel) authChannel.close();
    } catch (_error) {
      // Page teardown is best-effort.
    }
  });

  loadSession().catch(reportUnexpectedAsyncFailure);
})();
