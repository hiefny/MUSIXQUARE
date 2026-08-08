(function () {
  'use strict';

  var CAMPAIGN_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
  var CAMPAIGN_SLUG = campaignSlugFromPathname(window.location.pathname);
  var CAMPAIGN_API_BASE = CAMPAIGN_SLUG
    ? '/api/pro-grants/campaigns/' + encodeURIComponent(CAMPAIGN_SLUG)
    : '';
  var SESSION_ENDPOINT = CAMPAIGN_API_BASE + '/session';
  var REDEEM_ENDPOINT = CAMPAIGN_API_BASE + '/redeem';
  var SETUP_LINK_ENDPOINT = CAMPAIGN_API_BASE + '/setup-link';
  var ACCOUNT_SYNC_CHANNEL = 'mxqr-account-v1';
  var ACCOUNT_SYNC_STORAGE_KEY = 'mxqr-account-refresh';
  var REQUEST_TIMEOUT_MS = 15000;
  var RESPONSE_MAX_BYTES = 64 * 1024;
  var ROOM_CODE_PATTERN = /^0\d{5}$/;

  var steps = Array.from(document.querySelectorAll('.step'));
  var eventPanel = document.querySelector('.event-panel');
  var eventBrand = document.querySelector('.event-brand');
  var campaignName = document.getElementById('campaign-name');
  var accountAction = document.getElementById('account-action');
  var accountActionLabel = document.getElementById('account-action-label');
  var loginDescription = document.getElementById('login-description');
  var loginMessage = document.getElementById('login-message');
  var redeemCode = document.getElementById('redeem-code');
  var redeemMessage = document.getElementById('redeem-message');
  var redeemSubmit = document.getElementById('redeem-submit');
  var noticeTitle = document.getElementById('notice-title');
  var noticeMessage = document.getElementById('notice-message');
  var noticeActions = document.getElementById('notice-actions');
  var noticeRetry = document.getElementById('notice-retry');
  var nicknameDialog = document.getElementById('nickname-dialog');
  var nicknameForm = document.getElementById('nickname-form');
  var nicknameInput = document.getElementById('nickname-input');
  var nicknameMessage = document.getElementById('nickname-message');
  var nicknameSubmit = document.getElementById('nickname-submit');
  var nicknameCancel = document.getElementById('nickname-cancel');
  var successRoomInline = document.getElementById('success-room-inline');
  var successRoomGuide = document.getElementById('success-room-guide');
  var setupGuide = document.getElementById('setup-guide');
  var copyRoomButton = document.getElementById('copy-room');
  var openRoomButton = document.getElementById('open-room');
  var toast = document.getElementById('toast');

  var currentRoomCode = '';
  var currentRoomGeneration = null;
  var roomSetupRequired = false;
  var needsProfile = false;
  var profilePromptOffered = false;
  var authPopup = null;
  var authPopupMonitor = 0;
  var authRefreshInFlight = null;
  var sessionGeneration = 0;
  var toastTimer = 0;
  var authChannel = null;
  var accountClientId = createClientId();

  function campaignSlugFromPathname(pathname) {
    var path = String(pathname || '').replace(/\/$/, '');
    var direct = /^\/events\/([^/]+)$/.exec(path);
    if (direct && CAMPAIGN_SLUG_PATTERN.test(direct[1])) return direct[1];
    var legacy = /^\/events\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(\d+)$/.exec(path);
    if (!legacy) return '';
    var slug = legacy[1] + '-' + legacy[2];
    return CAMPAIGN_SLUG_PATTERN.test(slug) ? slug : '';
  }

  function normalizeCampaignTitle(value) {
    if (typeof value !== 'string') return '';
    var title = value.trim();
    if (!title || title.length > 100 || /[\u0000-\u001f\u007f]/.test(title)) return '';
    return title;
  }

  function renderCampaignTitle(title) {
    var normalized = normalizeCampaignTitle(title) || 'MUSIXQUARE PRO 이벤트';
    var shortTitle = normalized.replace(/^MUSIXQUARE\s+/i, '') || 'PRO 이벤트';
    document.title = normalized;
    campaignName.textContent = shortTitle;
    eventPanel.setAttribute('aria-label', normalized);
    eventBrand.setAttribute('aria-label', normalized);
  }

  function createClientId() {
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

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function safeFocus(element) {
    if (!element || typeof element.focus !== 'function') return;
    try {
      element.focus({ preventScroll: true });
    } catch (_error) {
      element.focus();
    }
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('is-visible');
    toastTimer = window.setTimeout(function () {
      toast.classList.remove('is-visible');
    }, 2200);
  }

  function setView(view, focus) {
    document.documentElement.dataset.view = view;
    steps.forEach(function (step) {
      var active = step.dataset.step === view;
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
      if (view === 'redeem') safeFocus(redeemCode);
      else safeFocus(document.querySelector('[data-step="' + view + '"] h1'));
    });
  }

  function setBusy(button, busy, busyText, idleText) {
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
    if (busyText && idleText) button.textContent = busy ? busyText : idleText;
  }

  function makeApiError(code, status) {
    var error = new Error(code);
    error.code = code;
    error.status = status;
    return error;
  }

  async function requestJson(path, options) {
    var controller = new AbortController();
    var timeout = window.setTimeout(function () {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      var response = await fetch(path, {
        method: options && options.method ? options.method : 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: Object.assign(
          { Accept: 'application/json' },
          options && options.headers ? options.headers : {},
        ),
        body: options && options.body ? options.body : undefined,
        signal: controller.signal,
      });
      var declaredLength = Number(response.headers.get('Content-Length') || '0');
      if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_MAX_BYTES) {
        throw makeApiError('INVALID_RESPONSE', 502);
      }
      var text = await response.text();
      if (text.length > RESPONSE_MAX_BYTES) throw makeApiError('INVALID_RESPONSE', 502);
      var payload = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (_error) {
          throw makeApiError('INVALID_RESPONSE', response.status || 502);
        }
      }
      if (!response.ok) {
        var code =
          isObject(payload) && typeof payload.error === 'string' ? payload.error : 'REQUEST_FAILED';
        throw makeApiError(code, response.status);
      }
      if (!isObject(payload)) throw makeApiError('INVALID_RESPONSE', 502);
      return payload;
    } catch (error) {
      if (error && typeof error.code === 'string') throw error;
      throw makeApiError(
        error && error.name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
        0,
      );
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function normalizeRoomCode(value) {
    return typeof value === 'string' && ROOM_CODE_PATTERN.test(value) ? value : '';
  }

  function normalizeRoomGeneration(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function safeRoomTarget(value, expectedRoomCode) {
    if (typeof value !== 'string' || !value || value.length > 4096) return '';
    try {
      var url = new URL(value, window.location.origin);
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

  function normalizeSession(payload) {
    if (!isObject(payload.campaign) || !isObject(payload.account)) {
      throw makeApiError('INVALID_RESPONSE', 502);
    }
    var campaignStatus =
      typeof payload.campaign.status === 'string' ? payload.campaign.status.toLowerCase() : '';
    if (
      payload.campaign.slug !== CAMPAIGN_SLUG ||
      !campaignStatus ||
      typeof payload.account.authenticated !== 'boolean'
    ) {
      throw makeApiError('INVALID_RESPONSE', 502);
    }
    var campaignTitle = normalizeCampaignTitle(payload.campaign.title);
    if (payload.campaign.title !== undefined && !campaignTitle) {
      throw makeApiError('INVALID_RESPONSE', 502);
    }
    var redemption = null;
    if (payload.redemption !== null && payload.redemption !== undefined) {
      if (!isObject(payload.redemption)) throw makeApiError('INVALID_RESPONSE', 502);
      var roomCode = normalizeRoomCode(payload.redemption.roomCode);
      var roomGeneration = normalizeRoomGeneration(payload.redemption.roomGeneration);
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
      authenticated: payload.account.authenticated,
      profileComplete: payload.account.profileComplete === true,
      redemption: redemption,
    };
  }

  function campaignNotice(status) {
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

  function showNotice(title, message, retryable) {
    noticeTitle.textContent = title;
    noticeMessage.textContent = message;
    noticeActions.hidden = !retryable;
    setView('notice');
  }

  function renderLogin(profileIncomplete) {
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

  function renderSuccess(redemption) {
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

  function replaceGuideRow(index, parts) {
    var item = setupGuide.children[index];
    var row = item && item.querySelector('span');
    if (!row) return;
    row.replaceChildren(
      ...parts.map(function (part) {
        return typeof part === 'string' ? document.createTextNode(part) : part;
      }),
    );
  }

  function createStrong(text) {
    var strong = document.createElement('strong');
    strong.textContent = text;
    return strong;
  }

  async function loadSession(options) {
    var generation = ++sessionGeneration;
    if (!options || options.keepView !== true) setView('loading', false);
    try {
      if (!CAMPAIGN_SLUG) throw makeApiError('INVALID_CAMPAIGN_PATH', 400);
      var session = normalizeSession(await requestJson(SESSION_ENDPOINT));
      if (generation !== sessionGeneration) return;
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
        var notice = campaignNotice(session.campaignStatus);
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

  function monitorAuthPopup(popup) {
    stopAuthPopupMonitor();
    authPopupMonitor = window.setInterval(function () {
      if (authPopup !== popup) {
        stopAuthPopupMonitor();
        return;
      }
      var closed = false;
      try {
        closed = popup.closed;
      } catch (_error) {
        return;
      }
      if (!closed) return;
      authPopup = null;
      stopAuthPopupMonitor();
      resetAccountAction();
      void refreshAfterAuthSignal();
    }, 250);
  }

  function refreshAfterAuthSignal() {
    if (authRefreshInFlight) return authRefreshInFlight;
    authRefreshInFlight = loadSession({ keepView: true }).finally(function () {
      authRefreshInFlight = null;
      resetAccountAction();
    });
    return authRefreshInFlight;
  }

  function handleAuthSignal(data) {
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
    void refreshAfterAuthSignal();
  }

  function openGoogleLogin() {
    loginMessage.textContent = '';
    accountAction.disabled = true;
    accountAction.setAttribute('aria-busy', 'true');
    accountActionLabel.textContent = '로그인 창을 확인해 주세요';

    var completionPath =
      '/account-complete.html?accountClient=' + encodeURIComponent(accountClientId);
    var loginUrl = '/api/auth/google/start?returnTo=' + encodeURIComponent(completionPath);
    var popup = null;
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

  function openNicknameDialog() {
    if (!needsProfile || nicknameDialog.open) return;
    nicknameMessage.textContent = '12자 이내로 입력해 주세요.';
    nicknameMessage.classList.remove('is-error');
    nicknameInput.setAttribute('aria-invalid', 'false');
    try {
      nicknameDialog.showModal();
    } catch (_error) {
      nicknameDialog.setAttribute('open', '');
    }
    window.requestAnimationFrame(function () {
      safeFocus(nicknameInput);
    });
  }

  function nicknameValidationMessage(value) {
    var normalized = value.normalize('NFC');
    if (!normalized) return '닉네임을 입력해 주세요.';
    if (/\s/u.test(normalized) || /[\u115f\u1160\u2800\u3164\uffa0]/iu.test(normalized)) {
      return '닉네임에는 공백이나 보이지 않는 문자를 사용할 수 없어요.';
    }
    if (Array.from(normalized).length > 12) return '12자 이내로 입력해 주세요.';
    return '';
  }

  function showNicknameError(message) {
    nicknameMessage.textContent = message;
    nicknameMessage.classList.add('is-error');
    nicknameInput.setAttribute('aria-invalid', 'true');
    safeFocus(nicknameInput);
  }

  async function saveNickname(event) {
    event.preventDefault();
    var nickname = nicknameInput.value.normalize('NFC');
    var validationMessage = nicknameValidationMessage(nickname);
    if (validationMessage) {
      showNicknameError(validationMessage);
      return;
    }
    nicknameInput.disabled = true;
    setBusy(nicknameSubmit, true, '저장하는 중', '확인');
    nicknameCancel.disabled = true;
    try {
      await requestJson('/api/auth/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-MXQR-Account-CSRF': '1',
        },
        body: JSON.stringify({ nickname: nickname }),
      });
      nicknameDialog.close();
      nicknameInput.value = '';
      showToast('닉네임을 설정했어요.');
      await loadSession({ keepView: true });
    } catch (error) {
      if (error.code === 'NICKNAME_TAKEN') {
        showNicknameError('이미 사용 중인 닉네임이에요.');
      } else if (error.code === 'NICKNAME_INVALID') {
        showNicknameError('사용할 수 없는 닉네임이에요.');
      } else if (error.status === 401 || error.code === 'AUTH_REQUIRED') {
        nicknameDialog.close();
        renderLogin(false);
        loginMessage.textContent = '로그인이 만료됐어요. 다시 로그인해 주세요.';
      } else {
        showNicknameError('닉네임을 설정하지 못했어요. 잠시 후 다시 시도해 주세요.');
      }
    } finally {
      nicknameInput.disabled = false;
      setBusy(nicknameSubmit, false, '저장하는 중', '확인');
      nicknameCancel.disabled = false;
    }
  }

  function resetRedeemForm() {
    redeemCode.value = '';
    redeemCode.disabled = false;
    redeemCode.setAttribute('aria-invalid', 'false');
    redeemMessage.textContent = '';
    setBusy(redeemSubmit, false, '확인하는 중', '확인하기');
  }

  function showRedeemError(message) {
    redeemCode.setAttribute('aria-invalid', 'true');
    redeemMessage.textContent = message;
    safeFocus(redeemCode);
  }

  async function submitRedeem(event) {
    event.preventDefault();
    var code = redeemCode.value.trim().toUpperCase().replace(/\s+/g, '');
    if (!code) {
      showRedeemError('리딤 코드를 입력해 주세요.');
      return;
    }
    redeemCode.value = code;
    redeemCode.disabled = true;
    setBusy(redeemSubmit, true, '확인하는 중', '확인하기');
    redeemCode.setAttribute('aria-invalid', 'false');
    redeemMessage.textContent = '';

    try {
      var payload = await requestJson(REDEEM_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MXQR-Account-CSRF': '1',
        },
        body: JSON.stringify({ code: code }),
      });
      if (payload.outcome !== 'redeemed' && payload.outcome !== 'already_redeemed') {
        throw makeApiError('INVALID_RESPONSE', 502);
      }
      var roomCode = normalizeRoomCode(payload.roomCode);
      var roomGeneration = normalizeRoomGeneration(payload.roomGeneration);
      if (!roomCode || roomGeneration === null || typeof payload.setupRequired !== 'boolean') {
        throw makeApiError('INVALID_RESPONSE', 502);
      }
      redeemCode.value = '';
      renderSuccess({
        roomCode: roomCode,
        roomGeneration: roomGeneration,
        setupRequired: payload.setupRequired,
      });
    } catch (error) {
      if (error.code === 'REDEEM_CODE_USED') {
        resetRedeemForm();
        setView('used');
        return;
      }
      if (error.code === 'INVALID_REDEEM_CODE' || error.code === 'REDEEM_CODE_INVALID') {
        showRedeemError('리딤 코드를 확인해 주세요.');
      } else if (error.code === 'ACCOUNT_SESSION_REQUIRED' || error.status === 401) {
        resetRedeemForm();
        renderLogin(false);
        loginMessage.textContent = '로그인이 만료됐어요. 다시 로그인해 주세요.';
      } else if (error.code === 'ACCOUNT_PROFILE_REQUIRED') {
        resetRedeemForm();
        needsProfile = true;
        profilePromptOffered = true;
        renderLogin(true);
        openNicknameDialog();
      } else if (error.code === 'ACCOUNT_CAMPAIGN_LIMIT_REACHED') {
        resetRedeemForm();
        showNotice(
          '이미 이 이벤트의 PRO 방을 받았어요',
          '이번 이벤트에서는 계정당 하나의 방을 받을 수 있어요.',
          false,
        );
      } else if (error.code === 'ACCOUNT_PRO_ROOM_LIMIT_REACHED') {
        resetRedeemForm();
        showNotice(
          '이 계정에는 이미 PRO 방이 있어요',
          'PRO 방은 계정당 하나만 받을 수 있어요.',
          false,
        );
      } else if (error.code === 'CAMPAIGN_NOT_ACTIVE') {
        resetRedeemForm();
        void loadSession();
      } else if (error.code === 'PRO_GRANT_UNAVAILABLE') {
        resetRedeemForm();
        showNotice('준비된 PRO 방이 모두 지급되었어요', '다음 이벤트를 기다려 주세요.', false);
      } else {
        showRedeemError('연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요.');
      }
    } finally {
      if (document.documentElement.dataset.view === 'redeem') {
        redeemCode.disabled = false;
        setBusy(redeemSubmit, false, '확인하는 중', '확인하기');
      }
    }
  }

  async function copyText(value) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return;
    }
    var textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    var copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('COPY_FAILED');
  }

  async function requestSetupTarget(expectedRoomCode, expectedRoomGeneration) {
    var payload = await requestJson(SETUP_LINK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MXQR-Account-CSRF': '1',
      },
      body: JSON.stringify({}),
    });
    var roomCode = normalizeRoomCode(payload.roomCode);
    var roomGeneration = normalizeRoomGeneration(payload.roomGeneration);
    if (
      roomCode !== expectedRoomCode ||
      roomGeneration !== expectedRoomGeneration ||
      typeof payload.setupRequired !== 'boolean'
    ) {
      throw makeApiError('INVALID_RESPONSE', 502);
    }
    if (!payload.setupRequired) return '/' + expectedRoomCode;

    var target = safeRoomTarget(payload.activationUrl, expectedRoomCode);
    var expiresAt = Number.isSafeInteger(payload.expiresAt) ? payload.expiresAt : 0;
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
    var normalized = redeemCode.value.toUpperCase().replace(/\s+/g, '');
    if (normalized !== redeemCode.value) redeemCode.value = normalized;
    redeemCode.setAttribute('aria-invalid', 'false');
    redeemMessage.textContent = '';
  });
  redeemSubmit.addEventListener('click', submitRedeem);
  redeemCode.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    void submitRedeem(event);
  });

  document.getElementById('try-another').addEventListener('click', function () {
    resetRedeemForm();
    setView('redeem');
  });

  noticeRetry.addEventListener('click', function () {
    void loadSession();
  });

  nicknameForm.addEventListener('submit', saveNickname);
  nicknameCancel.addEventListener('click', function () {
    nicknameDialog.close();
    safeFocus(accountAction);
  });
  nicknameInput.addEventListener('input', function () {
    nicknameInput.setAttribute('aria-invalid', 'false');
    nicknameMessage.textContent = '12자 이내로 입력해 주세요.';
    nicknameMessage.classList.remove('is-error');
  });

  copyRoomButton.addEventListener('click', async function () {
    if (!currentRoomCode) return;
    try {
      await copyText(currentRoomCode);
      showToast(currentRoomCode + '을 복사했어요.');
    } catch (_error) {
      showToast('방 번호는 ' + currentRoomCode + '이에요.');
    }
  });

  openRoomButton.addEventListener('click', async function () {
    if (!currentRoomCode || currentRoomGeneration === null) return;
    if (!roomSetupRequired) {
      window.location.assign('/' + currentRoomCode);
      return;
    }

    var expectedRoomCode = currentRoomCode;
    var expectedRoomGeneration = currentRoomGeneration;
    setBusy(openRoomButton, true, '불러오는 중', '방 설정 시작하기');
    try {
      var target = await requestSetupTarget(expectedRoomCode, expectedRoomGeneration);
      if (
        currentRoomCode !== expectedRoomCode ||
        currentRoomGeneration !== expectedRoomGeneration
      ) {
        throw makeApiError('INVALID_RESPONSE', 502);
      }
      window.location.assign(target);
    } catch (error) {
      if (error.code === 'ACCOUNT_SESSION_REQUIRED' || error.status === 401) {
        showToast('로그인 상태를 다시 확인해 주세요.');
        await loadSession();
      } else if (error.code === 'ACCOUNT_PROFILE_REQUIRED') {
        await loadSession();
      } else {
        showToast('방 설정 링크를 불러오지 못했어요. 다시 시도해 주세요.');
      }
    } finally {
      if (document.documentElement.dataset.view === 'success') {
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
      void refreshAfterAuthSignal();
      return;
    }
    try {
      handleAuthSignal(JSON.parse(event.newValue));
    } catch (_error) {
      void refreshAfterAuthSignal();
    }
  });
  window.addEventListener('focus', function () {
    if (authPopup) void refreshAfterAuthSignal();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && authPopup) void refreshAfterAuthSignal();
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

  void loadSession();
})();
