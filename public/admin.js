const root = document.querySelector('.admin-shell');
const loginPanel = document.querySelector('[data-login-panel]');
const dashboard = document.querySelector('[data-dashboard]');
const dashboardTitle = document.querySelector('[data-dashboard-title]');
const loginForm = document.querySelector('[data-login-form]');
const loginStatus = document.querySelector('[data-login-status]');
const cardsEl = document.querySelector('[data-metric-cards]');
const hourlyEl = document.querySelector('[data-hourly-chart]');
const dailyEl = document.querySelector('[data-daily-list]');
const monthlyEl = document.querySelector('[data-monthly-chart]');
const signalEl = document.querySelector('[data-signal-grid]');
const adminTabs = [...document.querySelectorAll('[data-admin-tab]')];
const adminViews = [...document.querySelectorAll('[data-admin-view]')];
const proRoomForm = document.querySelector('[data-pro-room-form]');
const proRoomCodeEl = document.querySelector('[data-pro-room-code]');
const proRoomLabelEl = document.querySelector('[data-pro-room-label]');
const proRoomRegisterBtn = document.querySelector('[data-pro-room-register]');
const proRoomStatusEl = document.querySelector('[data-pro-room-status]');
const proRoomListStatusEl = document.querySelector('[data-pro-room-list-status]');
const proRoomListEl = document.querySelector('[data-pro-room-list]');
const proRoomClaimEl = document.querySelector('[data-pro-room-claim]');
const proRoomClaimTitleEl = document.querySelector('[data-pro-room-claim-title]');
const proRoomClaimExpiryEl = document.querySelector('[data-pro-room-claim-expiry]');
const proRoomClaimUrlEl = document.querySelector('[data-pro-room-claim-url]');
const proRoomClaimCopyBtn = document.querySelector('[data-pro-room-claim-copy]');
const proRoomClaimDismissBtn = document.querySelector('[data-pro-room-claim-dismiss]');
const articleListEl = document.querySelector('[data-article-list]');
const articleStatusEl = document.querySelector('[data-article-status]');
const announcementForm = document.querySelector('[data-announcement-form]');
const announcementMessageEl = document.querySelector('[data-announcement-message]');
const announcementEnabledEl = document.querySelector('[data-announcement-enabled]');
const announcementExpiresEl = document.querySelector('[data-announcement-expires]');
const announcementStatusEl = document.querySelector('[data-announcement-status]');
const announcementPreviewEl = document.querySelector('[data-announcement-preview]');
const announcementClearBtn = document.querySelector('[data-announcement-clear]');
const announcementHistoryStatusEl = document.querySelector('[data-announcement-history-status]');
const announcementHistoryListEl = document.querySelector('[data-announcement-history-list]');
const updatedAtEl = document.querySelector('[data-updated-at]');
const refreshBtn = document.querySelector('[data-refresh]');
const logoutBtn = document.querySelector('[data-logout]');

const formatter = new Intl.NumberFormat();
let currentAdminTab = 'operations';
let proRoomsLoaded = false;
let articlesLoaded = false;
let announcementLoaded = false;
const issuedActivationLinks = new Set();
const issuedOwnerRecoveryLinks = new Set();
const expandedProRooms = new Set();
const proRoomApiCache = new Map();
const proRoomApiSecrets = new Map();
const proRoomApiRequestGenerations = new Map();
let proRoomDestroyDialogElements = null;
let proRoomDestroyTarget = null;
let visibleProRoomClaimIncarnation = null;
const developerApiScopeLabels = Object.freeze({
  'room:read': 'Room',
  'playback:read': 'Playback read',
  'playback:control': 'Playback control',
  'queue:read': 'Playlist read',
  'queue:write': 'Playlist write',
  'media:upload': 'File upload',
  'effects:read': 'Effects read',
  'effects:control': 'Effects control',
});
const developerApiPresets = Object.freeze({
  read: ['room:read', 'playback:read', 'queue:read', 'effects:read'],
  playlist: [
    'room:read',
    'playback:read',
    'playback:control',
    'queue:read',
    'queue:write',
    'media:upload',
    'effects:read',
  ],
  full: Object.keys(developerApiScopeLabels),
});

function createAdminRequestId() {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function setStatus(message, isError = false) {
  if (!loginStatus) return;
  loginStatus.textContent = message || '';
  loginStatus.classList.toggle('is-error', isError);
}

async function fetchJson(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const { headers: optionHeaders = {}, ...requestOptions } = options;
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...requestOptions,
    headers: {
      'Content-Type': 'application/json',
      ...(!['GET', 'HEAD'].includes(method) ? { 'X-MXQR-Admin-CSRF': '1' } : {}),
      ...optionHeaders,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/admin/login') {
      showLogin('Admin session expired.');
    }
    const error = new Error(body.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.payload = body;
    throw error;
  }
  return body;
}

function showLogin(message = '') {
  closeProRoomDestroyDialog({ restoreFocus: false });
  clearProRoomClaimState();
  clearAllProRoomApiSecrets();
  expandedProRooms.clear();
  proRoomApiCache.clear();
  proRoomApiRequestGenerations.clear();
  proRoomsLoaded = false;
  articlesLoaded = false;
  announcementLoaded = false;
  root?.classList.add('is-login');
  root?.classList.remove('is-dashboard');
  loginPanel.hidden = false;
  dashboard.hidden = true;
  setStatus(message);
}

function showDashboard() {
  root?.classList.remove('is-login');
  root?.classList.add('is-dashboard');
  loginPanel.hidden = true;
  dashboard.hidden = false;
}

function formatDelta(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (value === 0) return 'same as previous 24h';
  return `${value > 0 ? '+' : ''}${value}% vs previous 24h`;
}

function formatArticleDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function formatAdminDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function toDatetimeLocalValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function parseAnnouncementExpiresValue(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2}))?)?$/);
  if (match) {
    const [, year, month, day, hour = '23', minute = '59'] = match;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
    );
    if (
      date.getFullYear() === Number(year) &&
      date.getMonth() === Number(month) - 1 &&
      date.getDate() === Number(day) &&
      date.getHours() === Number(hour) &&
      date.getMinutes() === Number(minute)
    ) {
      if (date.getTime() <= Date.now()) throw new Error('Expires must be in the future.');
      return date.toISOString();
    }
  }
  const fallback = new Date(text);
  if (!Number.isNaN(fallback.getTime())) {
    if (fallback.getTime() <= Date.now()) throw new Error('Expires must be in the future.');
    return fallback.toISOString();
  }
  throw new Error('Use YYYY-MM-DD HH:MM for Expires.');
}

function adminErrorMessage(error, fallback) {
  const message = error?.message || '';
  if (message === 'EXPIRES_AT_IN_PAST') return 'Expires must be in the future.';
  if (message === 'INVALID_EXPIRES_AT') return 'Use YYYY-MM-DD HH:MM for Expires.';
  if (message === 'INVALID_PASSWORD') return 'Invalid password.';
  if (message === 'INVALID_PRO_ROOM') return 'Use a six-digit room number beginning with 0.';
  if (message === 'PRO_ROOM_NOT_FOUND') return 'This PRO room is not registered.';
  if (message === 'PRO_ROOM_ACTIVATION_UNAVAILABLE') return 'This room is already active.';
  if (message === 'PRO_ROOM_ADMIN_NOT_CONFIGURED')
    return 'PRO room administration is not configured.';
  if (message === 'PRO_ROOM_ADMIN_UNAVAILABLE') return 'The PRO room service is unavailable.';
  if (message === 'PRO_ROOM_AUDIT_UNAVAILABLE') {
    return 'The action was withheld because the audit log is unavailable.';
  }
  if (message === 'PRO_ROOM_PROVISIONING_INCOMPLETE') {
    return 'Provisioning is incomplete. Retry from the room list.';
  }
  if (message === 'PRO_ROOM_REGISTRY_CAPACITY_REACHED') {
    return 'The PRO room registry has reached its current capacity.';
  }
  if (message === 'PRO_ROOM_GENERATION_MISMATCH') {
    return 'This room number now refers to a different room. Refresh before making changes.';
  }
  if (message === 'PRO_ROOM_GENERATION_CUTOVER_NOT_READY') {
    return 'Room-number reuse is temporarily unavailable until the generation safety rollout is verified.';
  }
  if (message === 'DEVELOPER_API_ADMIN_NOT_CONFIGURED') {
    return 'Developer API key management is not configured.';
  }
  if (message === 'DEVELOPER_API_ACTIVE_KEY_LIMIT') {
    return 'This room already has three active API keys. Revoke one before issuing another.';
  }
  if (message === 'DEVELOPER_API_KEY_NOT_FOUND') return 'This API key is no longer active.';
  if (message === 'DEVELOPER_API_IDEMPOTENCY_CONFLICT') {
    return 'This issuance request was already used with different settings. Try again.';
  }
  if (message === 'DEVELOPER_API_AUDIT_UNAVAILABLE') {
    return 'The action was withheld because the API audit log is unavailable.';
  }
  if (message === 'PRO_ROOM_NOT_ACTIVE') return 'Only an active room can be suspended.';
  if (message === 'PRO_ROOM_NOT_SUSPENDED') return 'This room is already active.';
  if (message === 'PRO_ROOM_SUSPENDED') return 'Resume this room before issuing an API key.';
  if (message === 'PRO_ROOM_NOT_READY') return 'Finish provisioning this room first.';
  if (message === 'PRO_ROOM_DELETE_CONFIRMATION_MISMATCH') {
    return 'Enter the room number exactly as shown to confirm deletion.';
  }
  if (message === 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED') {
    return 'This room has already been permanently deleted.';
  }
  if (message === 'PRO_ROOM_DECOMMISSION_NOT_CONFIGURED') {
    return 'Permanent deletion is not fully configured.';
  }
  return message || fallback;
}

function formatAnnouncementAction(action) {
  if (action === 'published') return 'Published';
  if (action === 'disabled') return 'Disabled';
  if (action === 'cleared') return 'Cleared';
  return 'Updated';
}

function announcementTitle(tab) {
  if (tab === 'pro-rooms') return 'PRO Rooms';
  if (tab === 'articles') return 'Articles';
  if (tab === 'announcements') return 'Announcements';
  return 'Operations';
}

function normalizeProRoomCode(value) {
  const digits = String(value || '')
    .replace(/\D/g, '')
    .slice(0, 6);
  return /^0\d{5}$/.test(digits) ? digits : null;
}

function normalizeProRoomGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function proRoomIncarnationKey(roomCode, roomGeneration) {
  const normalizedRoomCode = normalizeProRoomCode(roomCode);
  const normalizedGeneration = normalizeProRoomGeneration(roomGeneration);
  if (!normalizedRoomCode || normalizedGeneration === null) return null;
  return `${normalizedRoomCode}:${normalizedGeneration}`;
}

function isProRoomGenerationMismatchError(error) {
  return error?.message === 'PRO_ROOM_GENERATION_MISMATCH';
}

function setProRoomStatus(message, isError = false) {
  if (!proRoomStatusEl) return;
  proRoomStatusEl.textContent = message || '';
  proRoomStatusEl.classList.toggle('is-error', isError);
}

function formatProRoomStatus(status) {
  if (status === 'active') return 'Active';
  if (status === 'suspended') return 'Suspended';
  if (status === 'decommissioning') return 'Deleting';
  if (status === 'decommissioned') return 'Permanently deleted';
  if (status === 'provisioning') return 'Provisioning incomplete';
  if (status === 'unactivated') return 'Awaiting activation';
  return 'Registered';
}

function dismissProRoomClaim() {
  visibleProRoomClaimIncarnation = null;
  if (!proRoomClaimEl) return;
  proRoomClaimEl.hidden = true;
  if (proRoomClaimUrlEl) proRoomClaimUrlEl.value = '';
  if (proRoomClaimExpiryEl) proRoomClaimExpiryEl.textContent = '';
  if (proRoomClaimTitleEl) proRoomClaimTitleEl.textContent = 'Owner activation link';
  if (proRoomClaimCopyBtn) proRoomClaimCopyBtn.textContent = 'Copy link';
}

function clearProRoomClaimState() {
  dismissProRoomClaim();
  issuedActivationLinks.clear();
  issuedOwnerRecoveryLinks.clear();
}

function showProRoomClaim(payload, kind = 'activation', expectedRoomGeneration = null) {
  if (!proRoomClaimEl || !proRoomClaimUrlEl) return;
  const roomCode = normalizeProRoomCode(payload.roomCode);
  const roomGeneration = normalizeProRoomGeneration(payload.roomGeneration);
  const incarnationKey = proRoomIncarnationKey(roomCode, roomGeneration);
  const isRecovery = kind === 'recovery';
  const claimUrl = isRecovery ? payload.recoveryUrl : payload.activationUrl;
  if (
    !roomCode ||
    roomGeneration === null ||
    roomGeneration !== expectedRoomGeneration ||
    !incarnationKey ||
    typeof claimUrl !== 'string' ||
    !claimUrl
  ) {
    throw new Error(isRecovery ? 'INVALID_OWNER_RECOVERY_LINK' : 'INVALID_ACTIVATION_LINK');
  }
  if (isRecovery) issuedOwnerRecoveryLinks.add(incarnationKey);
  else issuedActivationLinks.add(incarnationKey);
  visibleProRoomClaimIncarnation = incarnationKey;
  if (proRoomClaimTitleEl) {
    proRoomClaimTitleEl.textContent = `${roomCode} owner ${isRecovery ? 'recovery' : 'activation'} link`;
  }
  if (proRoomClaimExpiryEl) {
    const expiry = formatAdminDateTime(payload.expiresAt);
    proRoomClaimExpiryEl.textContent = expiry ? `Expires ${expiry}` : 'Short-lived link';
  }
  proRoomClaimUrlEl.value = claimUrl;
  proRoomClaimUrlEl.setAttribute(
    'aria-label',
    isRecovery ? 'Owner recovery link' : 'Owner activation link',
  );
  proRoomClaimEl.hidden = false;
  proRoomClaimEl.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
}

async function copyProRoomClaim() {
  const value = String(proRoomClaimUrlEl?.value || '');
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    proRoomClaimUrlEl?.focus();
    proRoomClaimUrlEl?.select();
    if (!document.execCommand?.('copy')) throw new Error('COPY_FAILED');
  }
  if (proRoomClaimCopyBtn) {
    proRoomClaimCopyBtn.textContent = 'Copied';
    window.setTimeout(() => {
      if (proRoomClaimCopyBtn) proRoomClaimCopyBtn.textContent = 'Copy link';
    }, 1600);
  }
}

function proRoomRawStatus(room) {
  const registryStatus = String(room?.status || 'registered');
  const activationState = String(room?.activationState || '');
  if (registryStatus === 'decommissioned') return 'decommissioned';
  if (registryStatus === 'decommissioning') return 'decommissioning';
  if (registryStatus === 'provisioning') return 'provisioning';
  if (registryStatus === 'suspended') return 'suspended';
  if (activationState === 'active') return 'active';
  if (activationState === 'unactivated') return 'unactivated';
  return 'registered';
}

function clearProRoomApiSecret(roomCode, roomGeneration) {
  const incarnationKey = proRoomIncarnationKey(roomCode, roomGeneration);
  if (!incarnationKey) return;
  proRoomApiSecrets.delete(incarnationKey);
  const panel = document.querySelector(
    `[data-pro-room-api-panel="${roomCode}"][data-pro-room-generation="${roomGeneration}"]`,
  );
  panel?.querySelector('[data-pro-room-api-secret]')?.replaceChildren();
}

function clearAllProRoomApiSecrets() {
  proRoomApiSecrets.clear();
  for (const host of document.querySelectorAll('[data-pro-room-api-secret]')) {
    host.replaceChildren();
  }
}

function resetProRoomDestroyDialog() {
  if (!proRoomDestroyDialogElements) return;
  const { dialog, form, input, cancelButton, confirmButton, error } = proRoomDestroyDialogElements;
  const restoreFocus = proRoomDestroyTarget?.restoreFocus;
  proRoomDestroyTarget = null;
  form.reset();
  form.removeAttribute('aria-busy');
  input.disabled = false;
  cancelButton.disabled = false;
  confirmButton.disabled = true;
  confirmButton.textContent = 'Delete permanently';
  error.textContent = '';
  if (restoreFocus?.isConnected) restoreFocus.focus();
  dialog.removeAttribute('data-room-code');
}

function closeProRoomDestroyDialog({ restoreFocus = true } = {}) {
  if (!proRoomDestroyDialogElements) return;
  const { dialog } = proRoomDestroyDialogElements;
  if (!restoreFocus && proRoomDestroyTarget) proRoomDestroyTarget.restoreFocus = null;
  if (!dialog.open && !dialog.hasAttribute('open')) {
    resetProRoomDestroyDialog();
    return;
  }
  if (typeof dialog.close === 'function') {
    try {
      dialog.close();
      return;
    } catch {
      // Fall through to the attribute fallback used by lightweight DOM implementations.
    }
  }
  dialog.removeAttribute('open');
  dialog.dispatchEvent(new Event('close'));
}

function setProRoomDestroyBusy(isBusy) {
  if (!proRoomDestroyDialogElements) return;
  const { form, input, cancelButton, confirmButton } = proRoomDestroyDialogElements;
  if (isBusy) form.setAttribute('aria-busy', 'true');
  else form.removeAttribute('aria-busy');
  input.disabled = isBusy;
  cancelButton.disabled = isBusy;
  confirmButton.disabled =
    isBusy || String(input.value || '') !== String(proRoomDestroyTarget?.roomCode || '');
  confirmButton.textContent = isBusy ? 'Deleting...' : 'Delete permanently';
  if (proRoomDestroyTarget) proRoomDestroyTarget.busy = isBusy;
}

function updateProRoomDestroyConfirmation() {
  if (!proRoomDestroyDialogElements) return;
  const { input, confirmButton, error } = proRoomDestroyDialogElements;
  const digits = String(input.value || '')
    .replace(/\D/g, '')
    .slice(0, 6);
  if (input.value !== digits) input.value = digits;
  error.textContent = '';
  confirmButton.disabled =
    Boolean(proRoomDestroyTarget?.busy) || digits !== proRoomDestroyTarget?.roomCode;
}

function focusProRoomListAfterDestroy() {
  const nextSummary = proRoomListEl?.querySelector('summary');
  if (nextSummary) return nextSummary;
  if (!proRoomListStatusEl) return null;
  proRoomListStatusEl.tabIndex = -1;
  return proRoomListStatusEl;
}

function clearDestroyedProRoomState(roomCode, roomGeneration) {
  const incarnationKey = proRoomIncarnationKey(roomCode, roomGeneration);
  if (!incarnationKey) return;
  expandedProRooms.delete(roomCode);
  issuedActivationLinks.delete(incarnationKey);
  issuedOwnerRecoveryLinks.delete(incarnationKey);
  proRoomApiCache.delete(incarnationKey);
  proRoomApiRequestGenerations.set(
    incarnationKey,
    (proRoomApiRequestGenerations.get(incarnationKey) || 0) + 1,
  );
  clearProRoomApiSecret(roomCode, roomGeneration);
  const claimRoomCode = normalizeProRoomCode(
    String(proRoomClaimTitleEl?.textContent || '').slice(0, 6),
  );
  if (claimRoomCode === roomCode) dismissProRoomClaim();
}

async function permanentlyDeleteProRoom() {
  if (!proRoomDestroyDialogElements || !proRoomDestroyTarget) return;
  const { input, error } = proRoomDestroyDialogElements;
  const target = proRoomDestroyTarget;
  const roomCode = target.roomCode;
  const roomGeneration = target.roomGeneration;
  if (input.value !== roomCode || target.busy) return;

  setProRoomDestroyBusy(true);
  error.textContent = '';
  try {
    const result = await fetchJson(`/api/admin/pro-rooms/${roomCode}`, {
      method: 'DELETE',
      body: JSON.stringify({
        confirmRoomCode: roomCode,
        roomGeneration,
        requestId: target.requestId,
      }),
    });
    if (
      result?.roomCode !== roomCode ||
      normalizeProRoomGeneration(result?.roomGeneration) !== roomGeneration
    ) {
      throw new Error('PRO_ROOM_GENERATION_MISMATCH');
    }
    clearDestroyedProRoomState(roomCode, roomGeneration);
    document.querySelector(`[data-pro-room-item="${roomCode}"]`)?.remove();
    const deletionPending = result?.status === 'decommissioning';
    setProRoomStatus(
      deletionPending
        ? `${roomCode} is closed. Final storage cleanup is in progress.`
        : `${roomCode} permanently deleted.`,
    );
    try {
      await loadProRooms();
    } catch (loadError) {
      proRoomsLoaded = false;
      setProRoomStatus(
        deletionPending
          ? `${roomCode} is closed. Refresh the room list to check storage cleanup.`
          : `${roomCode} permanently deleted. Refresh the room list to confirm the latest state.`,
      );
    }
    if (proRoomDestroyTarget) {
      proRoomDestroyTarget.restoreFocus = focusProRoomListAfterDestroy();
    }
    closeProRoomDestroyDialog();
  } catch (deleteError) {
    if (proRoomDestroyTarget !== target) return;
    error.textContent = adminErrorMessage(
      deleteError,
      'The room could not be permanently deleted.',
    );
    setProRoomDestroyBusy(false);
    input.focus();
  }
}

function ensureProRoomDestroyDialog() {
  if (proRoomDestroyDialogElements) return proRoomDestroyDialogElements;

  const dialog = document.createElement('dialog');
  dialog.className = 'pro-room-destroy-dialog';
  dialog.dataset.proRoomDestroyDialog = '';
  dialog.setAttribute('aria-labelledby', 'pro-room-destroy-title');
  dialog.setAttribute('aria-describedby', 'pro-room-destroy-description');

  const form = document.createElement('form');
  form.className = 'pro-room-destroy-form';
  form.dataset.proRoomDestroyForm = '';

  const copy = document.createElement('div');
  copy.className = 'pro-room-destroy-copy';
  const eyebrow = document.createElement('span');
  eyebrow.className = 'pro-room-destroy-eyebrow';
  eyebrow.textContent = 'Permanent deletion';
  const title = document.createElement('h2');
  title.id = 'pro-room-destroy-title';
  title.dataset.proRoomDestroyTitle = '';
  const description = document.createElement('p');
  description.id = 'pro-room-destroy-description';
  description.textContent =
    'This room incarnation, playlist, uploaded media, active sessions, owner access, and API keys will be permanently removed. Connected participants will be signed out. This deletion cannot be undone; after cleanup completes, an administrator may register the room number as a new room.';
  copy.append(eyebrow, title, description);

  const field = document.createElement('label');
  field.className = 'pro-room-destroy-field';
  const fieldLabel = document.createElement('span');
  fieldLabel.dataset.proRoomDestroyLabel = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.maxLength = 6;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.proRoomDestroyInput = '';
  input.setAttribute('aria-describedby', 'pro-room-destroy-description pro-room-destroy-error');
  field.append(fieldLabel, input);

  const error = document.createElement('p');
  error.id = 'pro-room-destroy-error';
  error.className = 'pro-room-destroy-error';
  error.dataset.proRoomDestroyError = '';
  error.setAttribute('role', 'alert');
  error.setAttribute('aria-live', 'assertive');

  const actions = document.createElement('div');
  actions.className = 'pro-room-destroy-actions';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'is-secondary';
  cancelButton.textContent = 'Cancel';
  cancelButton.dataset.proRoomDestroyCancel = '';
  const confirmButton = document.createElement('button');
  confirmButton.type = 'submit';
  confirmButton.className = 'is-danger';
  confirmButton.textContent = 'Delete permanently';
  confirmButton.disabled = true;
  confirmButton.dataset.proRoomDestroyConfirm = '';
  actions.append(cancelButton, confirmButton);

  form.append(copy, field, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  proRoomDestroyDialogElements = {
    dialog,
    form,
    title,
    fieldLabel,
    input,
    error,
    cancelButton,
    confirmButton,
  };

  input.addEventListener('input', updateProRoomDestroyConfirmation);
  cancelButton.addEventListener('click', () => closeProRoomDestroyDialog());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    permanentlyDeleteProRoom().catch(() => {});
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!proRoomDestroyTarget?.busy) closeProRoomDestroyDialog();
  });
  dialog.addEventListener('close', resetProRoomDestroyDialog);
  return proRoomDestroyDialogElements;
}

function openProRoomDestroyDialog(roomCode, roomGeneration, trigger) {
  if (normalizeProRoomGeneration(roomGeneration) === null) {
    setProRoomStatus('Room generation is unavailable. Refresh before making changes.', true);
    return;
  }
  const elements = ensureProRoomDestroyDialog();
  const { dialog, form, title, fieldLabel, input, error, cancelButton, confirmButton } = elements;
  proRoomDestroyTarget = {
    roomCode,
    roomGeneration,
    restoreFocus: trigger,
    busy: false,
    requestId: createAdminRequestId(),
  };
  form.reset();
  form.removeAttribute('aria-busy');
  title.textContent = `Permanently delete PRO room ${roomCode}?`;
  fieldLabel.textContent = `Enter ${roomCode} to confirm`;
  input.disabled = false;
  cancelButton.disabled = false;
  confirmButton.disabled = true;
  confirmButton.textContent = 'Delete permanently';
  error.textContent = '';
  dialog.dataset.roomCode = roomCode;
  if (typeof dialog.showModal === 'function') {
    try {
      dialog.showModal();
    } catch {
      dialog.setAttribute('open', '');
    }
  } else {
    dialog.setAttribute('open', '');
  }
  input.focus();
}

async function copySensitiveValue(value, input, button) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    input?.focus();
    input?.select();
    if (!document.execCommand?.('copy')) throw new Error('COPY_FAILED');
  }
  const previous = button.textContent;
  button.textContent = 'Copied';
  window.setTimeout(() => {
    if (button.isConnected) button.textContent = previous;
  }, 1600);
}

function renderProRoomApiSecret(roomCode, roomGeneration) {
  const host = document.createElement('div');
  host.className = 'pro-room-api-secret';
  host.dataset.proRoomApiSecret = roomCode;
  host.setAttribute('aria-live', 'polite');
  const incarnationKey = proRoomIncarnationKey(roomCode, roomGeneration);
  const issued = incarnationKey ? proRoomApiSecrets.get(incarnationKey) : null;
  if (!issued?.apiKey) return host;

  const copy = document.createElement('div');
  copy.className = 'pro-room-api-secret-copy';
  const title = document.createElement('strong');
  title.textContent = 'API key issued';
  const warning = document.createElement('span');
  warning.textContent = 'Copy it now. The full key cannot be shown again.';
  copy.append(title, warning);

  const row = document.createElement('div');
  row.className = 'pro-room-api-secret-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.readOnly = true;
  input.autocomplete = 'off';
  input.value = issued.apiKey;
  input.setAttribute('aria-label', `${roomCode} Developer API key`);
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = 'Copy key';
  copyButton.addEventListener('click', () => {
    copySensitiveValue(issued.apiKey, input, copyButton).catch(() => {
      input.focus();
      input.select();
    });
  });
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'is-secondary';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => clearProRoomApiSecret(roomCode, roomGeneration));
  row.append(input, copyButton, dismiss);
  host.append(copy, row);
  return host;
}

function renderProRoomApiKey(roomCode, roomGeneration, roomStatus, panel, key, refresh) {
  const item = document.createElement('article');
  item.className = 'pro-room-api-key';
  const identity = document.createElement('div');
  identity.className = 'pro-room-api-key-identity';
  const label = document.createElement('strong');
  label.textContent = String(key?.label || 'Unnamed integration');
  const id = document.createElement('code');
  id.textContent = String(key?.keyId || '');
  identity.append(label, id);

  const metadata = document.createElement('div');
  metadata.className = 'pro-room-api-key-meta';
  const state = document.createElement('span');
  const keyStatus = ['active', 'expired', 'revoked'].includes(key?.status) ? key.status : 'revoked';
  state.className = `pro-room-api-key-state is-${keyStatus}`;
  state.textContent = keyStatus[0].toUpperCase() + keyStatus.slice(1);
  const expiry = document.createElement('small');
  const expiresAt = formatAdminDateTime(key?.expiresAt);
  expiry.textContent = expiresAt ? `Expires ${expiresAt}` : 'Expiry unavailable';
  const lastUsed = document.createElement('small');
  const lastUsedAt = formatAdminDateTime(key?.lastUsedAt ?? key?.lastUsedHour);
  lastUsed.textContent = lastUsedAt ? `Last used ${lastUsedAt}` : 'Not used yet';
  metadata.append(state, expiry, lastUsed);

  const scopes = document.createElement('div');
  scopes.className = 'pro-room-api-key-scopes';
  for (const scope of Array.isArray(key?.scopes) ? key.scopes : []) {
    const chip = document.createElement('span');
    chip.textContent = developerApiScopeLabels[scope] || scope;
    scopes.append(chip);
  }

  const actions = document.createElement('div');
  actions.className = 'pro-room-api-key-actions';
  if (keyStatus === 'active' && key?.keyId && normalizeProRoomGeneration(roomGeneration) !== null) {
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.textContent = 'Revoke';
    revoke.setAttribute('aria-label', `Revoke ${label.textContent}`);
    revoke.addEventListener('click', async () => {
      if (!window.confirm(`Revoke “${label.textContent}”? This cannot be undone.`)) return;
      revoke.disabled = true;
      revoke.textContent = 'Revoking...';
      try {
        const revoked = await fetchJson(`/api/admin/pro-rooms/${roomCode}/api-keys/${key.keyId}`, {
          method: 'DELETE',
          body: JSON.stringify({ roomGeneration }),
        });
        if (
          revoked?.roomCode !== roomCode ||
          normalizeProRoomGeneration(revoked?.roomGeneration) !== roomGeneration
        ) {
          throw new Error('PRO_ROOM_GENERATION_MISMATCH');
        }
        const incarnationKey = proRoomIncarnationKey(roomCode, roomGeneration);
        if (incarnationKey && proRoomApiSecrets.get(incarnationKey)?.keyId === key.keyId) {
          clearProRoomApiSecret(roomCode, roomGeneration);
        }
        await refresh('API key revoked.');
      } catch (error) {
        revoke.disabled = false;
        revoke.textContent = 'Revoke';
        if (isProRoomGenerationMismatchError(error)) {
          const incarnationKey = proRoomIncarnationKey(roomCode, roomGeneration);
          if (incarnationKey) proRoomApiCache.delete(incarnationKey);
          clearProRoomApiSecret(roomCode, roomGeneration);
          renderProRoomApiPanel(
            roomCode,
            null,
            roomStatus,
            panel,
            { keys: [], maxActiveKeys: 3 },
            adminErrorMessage(error, 'API key revocation failed.'),
            true,
          );
          loadProRooms({ updateTimestamp: false }).catch(() => {});
          return;
        }
        await refresh(adminErrorMessage(error, 'API key revocation failed.'), true, false);
      }
    });
    actions.append(revoke);
  }
  item.append(identity, metadata, scopes, actions);
  return item;
}

function renderProRoomApiShell(roomCode, panel) {
  panel.replaceChildren();
  panel.classList.add('is-loading');
  panel.setAttribute('aria-busy', 'true');

  const head = document.createElement('div');
  head.className = 'pro-room-api-head';
  const heading = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = 'Developer API';
  const description = document.createElement('span');
  description.textContent = 'Issue room-bound credentials for servers, bots, and integrations.';
  heading.append(title, description);
  const count = document.createElement('span');
  count.className = 'pro-room-api-skeleton-line is-count';
  count.setAttribute('aria-hidden', 'true');
  head.append(heading, count);

  const form = document.createElement('div');
  form.className = 'pro-room-api-form is-loading';
  form.setAttribute('aria-hidden', 'true');
  for (const labelText of ['Integration name', 'Access', 'Expires']) {
    const field = document.createElement('div');
    field.className = 'pro-room-api-field';
    const label = document.createElement('span');
    label.textContent = labelText;
    const control = document.createElement('span');
    control.className = 'pro-room-api-skeleton-control';
    field.append(label, control);
    form.append(field);
  }
  const issue = document.createElement('span');
  issue.className = 'pro-room-api-skeleton-button';
  form.append(issue);

  const status = document.createElement('p');
  status.className = 'pro-room-api-status';
  status.dataset.proRoomApiStatus = roomCode;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Loading API keys...';

  const list = document.createElement('div');
  list.className = 'pro-room-api-key-list';
  list.setAttribute('aria-hidden', 'true');
  const key = document.createElement('div');
  key.className = 'pro-room-api-key is-loading';
  for (const className of ['is-identity', 'is-metadata', 'is-scopes', 'is-action']) {
    const placeholder = document.createElement('span');
    placeholder.className = `pro-room-api-skeleton-line ${className}`;
    key.append(placeholder);
  }
  list.append(key);

  panel.append(head, form, status, list);
}

function renderProRoomApiPanel(
  roomCode,
  roomGeneration,
  roomStatus,
  panel,
  payload,
  message = '',
  isError = false,
) {
  const validRoomGeneration = normalizeProRoomGeneration(roomGeneration) !== null;
  const keys = Array.isArray(payload?.keys) ? payload.keys : [];
  const activeCount = keys.filter((key) => key?.status === 'active').length;
  const maxActiveKeys = Number.isSafeInteger(payload?.maxActiveKeys) ? payload.maxActiveKeys : 3;
  panel.replaceChildren();
  panel.classList.remove('is-loading');
  panel.removeAttribute('aria-busy');

  const head = document.createElement('div');
  head.className = 'pro-room-api-head';
  const heading = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = 'Developer API';
  const description = document.createElement('span');
  description.textContent = 'Issue room-bound credentials for servers, bots, and integrations.';
  heading.append(title, description);
  const count = document.createElement('span');
  count.textContent = `${activeCount} active · ${maxActiveKeys} max`;
  head.append(heading, count);

  const status = document.createElement('p');
  status.className = `pro-room-api-status${isError ? ' is-error' : ''}`;
  status.dataset.proRoomApiStatus = roomCode;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = message;

  const form = document.createElement('form');
  form.className = 'pro-room-api-form';
  form.dataset.proRoomApiForm = roomCode;
  const labelField = document.createElement('label');
  labelField.className = 'pro-room-api-field';
  const labelTitle = document.createElement('span');
  labelTitle.textContent = 'Integration name';
  const labelInput = document.createElement('input');
  labelInput.name = 'label';
  labelInput.maxLength = 64;
  labelInput.placeholder = 'Cafe controller';
  labelInput.autocomplete = 'off';
  labelInput.required = true;
  labelField.append(labelTitle, labelInput);

  const accessField = document.createElement('label');
  accessField.className = 'pro-room-api-field';
  const accessTitle = document.createElement('span');
  accessTitle.textContent = 'Access';
  const accessSelect = document.createElement('select');
  accessSelect.name = 'preset';
  for (const [value, text] of [
    ['read', 'Read only'],
    ['playlist', 'Playback, playlist & upload'],
    ['full', 'Full control'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    if (value === 'read') option.selected = true;
    accessSelect.append(option);
  }
  accessField.append(accessTitle, accessSelect);

  const expiryField = document.createElement('label');
  expiryField.className = 'pro-room-api-field';
  const expiryTitle = document.createElement('span');
  expiryTitle.textContent = 'Expires';
  const expirySelect = document.createElement('select');
  expirySelect.name = 'days';
  for (const days of [30, 90, 180, 365]) {
    const option = document.createElement('option');
    option.value = String(days);
    option.textContent = `${days} days`;
    if (days === 90) option.selected = true;
    expirySelect.append(option);
  }
  expiryField.append(expiryTitle, expirySelect);

  const issue = document.createElement('button');
  issue.type = 'submit';
  issue.textContent = 'Issue API key';
  issue.disabled = !validRoomGeneration || activeCount >= maxActiveKeys || roomStatus !== 'active';
  if (!validRoomGeneration) {
    issue.title = 'Refresh the room list before issuing a key.';
  } else if (roomStatus !== 'active') {
    issue.title = 'Activate or resume this room before issuing a key.';
  }
  form.append(labelField, accessField, expiryField, issue);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!validRoomGeneration) return;
    const preset = developerApiPresets[accessSelect.value] || developerApiPresets.read;
    const requestBody = JSON.stringify({
      roomGeneration,
      label: labelInput.value.trim(),
      days: Number(expirySelect.value),
      scopes: preset,
      requestId: createAdminRequestId(),
    });
    issue.disabled = true;
    issue.textContent = 'Issuing...';
    try {
      let issued;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          issued = await fetchJson(`/api/admin/pro-rooms/${roomCode}/api-keys`, {
            method: 'POST',
            body: requestBody,
          });
          break;
        } catch (error) {
          if (error?.status || attempt === 1) throw error;
        }
      }
      if (typeof issued?.apiKey !== 'string' || !issued.apiKey.startsWith('mxqr_live_')) {
        throw new Error('INVALID_DEVELOPER_API_KEY_RESPONSE');
      }
      const incarnationKey = proRoomIncarnationKey(roomCode, roomGeneration);
      if (!incarnationKey) throw new Error('PRO_ROOM_GENERATION_MISMATCH');
      if (
        issued?.roomCode !== roomCode ||
        normalizeProRoomGeneration(issued?.roomGeneration) !== roomGeneration
      ) {
        throw new Error('PRO_ROOM_GENERATION_MISMATCH');
      }
      proRoomApiSecrets.set(incarnationKey, {
        apiKey: issued.apiKey,
        keyId: typeof issued?.key?.keyId === 'string' ? issued.key.keyId : '',
      });
      form.reset();
      await loadProRoomApiKeys(
        roomCode,
        roomGeneration,
        roomStatus,
        panel,
        'API key issued. Copy it now.',
      );
      panel
        .querySelector(`[aria-label="${roomCode} Developer API key"]`)
        ?.focus({ preventScroll: true });
    } catch (error) {
      if (isProRoomGenerationMismatchError(error)) {
        const incarnationKey = proRoomIncarnationKey(roomCode, roomGeneration);
        if (incarnationKey) proRoomApiCache.delete(incarnationKey);
        clearProRoomApiSecret(roomCode, roomGeneration);
        renderProRoomApiPanel(
          roomCode,
          null,
          roomStatus,
          panel,
          { keys: [], maxActiveKeys: 3 },
          adminErrorMessage(error, 'API key issuance failed.'),
          true,
        );
        loadProRooms({ updateTimestamp: false }).catch(() => {});
        return;
      }
      await loadProRoomApiKeys(
        roomCode,
        roomGeneration,
        roomStatus,
        panel,
        adminErrorMessage(error, 'API key issuance failed.'),
        true,
      );
    }
  });

  const list = document.createElement('div');
  list.className = 'pro-room-api-key-list';
  const refresh = async (nextMessage = '', nextIsError = false, reload = true) => {
    if (reload) {
      await loadProRoomApiKeys(
        roomCode,
        roomGeneration,
        roomStatus,
        panel,
        nextMessage,
        nextIsError,
      );
      return;
    }
    renderProRoomApiPanel(
      roomCode,
      roomGeneration,
      roomStatus,
      panel,
      payload,
      nextMessage,
      nextIsError,
    );
  };
  const rows = keys.map((key) =>
    renderProRoomApiKey(roomCode, roomGeneration, roomStatus, panel, key, refresh),
  );
  if (rows.length) list.append(...rows);
  else {
    const empty = document.createElement('p');
    empty.className = 'pro-room-api-empty';
    empty.textContent = 'No API keys issued for this room.';
    list.append(empty);
  }

  panel.append(head, renderProRoomApiSecret(roomCode, roomGeneration), form, status, list);
}

async function loadProRoomApiKeys(
  roomCode,
  roomGeneration,
  roomStatus,
  panel,
  message = '',
  isError = false,
) {
  if (!panel?.isConnected) return;
  const incarnationKey = proRoomIncarnationKey(roomCode, roomGeneration);
  if (!incarnationKey) {
    renderProRoomApiPanel(
      roomCode,
      roomGeneration,
      roomStatus,
      panel,
      { keys: [], maxActiveKeys: 3 },
      'Room generation is unavailable. Refresh before making changes.',
      true,
    );
    return;
  }
  const requestGeneration = (proRoomApiRequestGenerations.get(incarnationKey) || 0) + 1;
  proRoomApiRequestGenerations.set(incarnationKey, requestGeneration);
  if (!message) {
    const status = panel.querySelector('[data-pro-room-api-status]');
    if (status) status.textContent = 'Loading API keys...';
  }
  try {
    const payload = await fetchJson(`/api/admin/pro-rooms/${roomCode}/api-keys`);
    if (proRoomApiRequestGenerations.get(incarnationKey) !== requestGeneration) return;
    if (normalizeProRoomGeneration(payload?.roomGeneration) !== roomGeneration) {
      throw new Error('PRO_ROOM_GENERATION_MISMATCH');
    }
    proRoomApiCache.set(incarnationKey, payload);
    if (panel.isConnected) {
      renderProRoomApiPanel(roomCode, roomGeneration, roomStatus, panel, payload, message, isError);
    }
  } catch (error) {
    if (proRoomApiRequestGenerations.get(incarnationKey) !== requestGeneration) return;
    const generationMismatch = isProRoomGenerationMismatchError(error);
    if (generationMismatch) {
      proRoomApiCache.delete(incarnationKey);
      clearProRoomApiSecret(roomCode, roomGeneration);
    }
    const cached = generationMismatch
      ? { keys: [], maxActiveKeys: 3 }
      : proRoomApiCache.get(incarnationKey) || { keys: [], maxActiveKeys: 3 };
    if (panel.isConnected) {
      renderProRoomApiPanel(
        roomCode,
        generationMismatch ? null : roomGeneration,
        roomStatus,
        panel,
        cached,
        adminErrorMessage(error, 'API keys could not be loaded.'),
        true,
      );
    }
    if (generationMismatch) loadProRooms({ updateTimestamp: false }).catch(() => {});
  }
}

function renderProRoomLabelEditor(room, roomCode, roomGeneration) {
  const form = document.createElement('form');
  form.className = 'pro-room-label-form';
  form.dataset.proRoomLabelForm = roomCode;

  const field = document.createElement('label');
  field.className = 'pro-room-label-field';
  const title = document.createElement('span');
  title.textContent = 'Room label';
  const input = document.createElement('input');
  input.name = 'label';
  input.value = String(room?.label || '');
  input.maxLength = 64;
  input.autocomplete = 'off';
  input.required = true;
  input.setAttribute('aria-label', `${roomCode} room label`);
  field.append(title, input);

  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = 'Save label';
  save.disabled = true;

  const status = document.createElement('p');
  status.className = 'pro-room-label-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const syncSaveState = () => {
    const nextLabel = input.value.trim();
    save.disabled =
      !nextLabel || nextLabel.length > 64 || nextLabel === String(room?.label || '').trim();
  };
  input.addEventListener('input', syncSaveState);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const nextLabel = input.value.trim();
    if (!nextLabel || nextLabel.length > 64 || save.disabled) return;
    input.disabled = true;
    save.disabled = true;
    save.textContent = 'Saving...';
    status.textContent = '';
    status.classList.remove('is-error');
    try {
      const payload = await fetchJson(`/api/admin/pro-rooms/${roomCode}/label`, {
        method: 'POST',
        body: JSON.stringify({ roomGeneration, label: nextLabel }),
      });
      if (
        payload?.roomCode !== roomCode ||
        normalizeProRoomGeneration(payload?.roomGeneration) !== roomGeneration ||
        typeof payload?.label !== 'string' ||
        !payload.label.trim()
      ) {
        throw new Error('PRO_ROOM_GENERATION_MISMATCH');
      }
      room.label = payload.label.trim();
      input.value = room.label;
      const summaryLabel = form
        .closest('[data-pro-room-item]')
        ?.querySelector('[data-pro-room-label-value]');
      if (summaryLabel) summaryLabel.textContent = room.label;
      status.textContent = payload.changed === false ? 'Label is already up to date.' : 'Label saved.';
    } catch (error) {
      status.textContent = adminErrorMessage(error, 'Room label could not be saved.');
      status.classList.add('is-error');
      if (isProRoomGenerationMismatchError(error)) {
        loadProRooms({ updateTimestamp: false }).catch(() => {});
      }
    } finally {
      input.disabled = false;
      save.textContent = 'Save label';
      syncSaveState();
    }
  });

  form.append(field, save, status);
  return form;
}

function renderProRoomActions(room, roomCode, roomGeneration, rawStatus) {
  const section = document.createElement('section');
  section.className = 'pro-room-controls';
  const heading = document.createElement('strong');
  heading.textContent = 'Room controls';
  const actions = document.createElement('div');
  actions.className = 'pro-room-actions';
  const incarnationKey = proRoomIncarnationKey(roomCode, roomGeneration);
  if (!incarnationKey) {
    const message = document.createElement('p');
    message.className = 'pro-room-terminal-copy';
    message.textContent =
      'Room generation is unavailable. Refresh before making administrative changes.';
    section.append(heading, message);
    return section;
  }

  if (rawStatus === 'decommissioning' || rawStatus === 'decommissioned') {
    const message = document.createElement('p');
    message.className = 'pro-room-terminal-copy';
    message.textContent =
      rawStatus === 'decommissioning'
        ? 'The room is closed while the final storage sweep completes.'
        : 'This room incarnation is permanently deleted. An administrator may register the room number as a new room.';
    section.append(heading, message);
    return section;
  }

  const labelEditor =
    rawStatus === 'provisioning'
      ? null
      : renderProRoomLabelEditor(room, roomCode, roomGeneration);

  if (rawStatus !== 'provisioning' && rawStatus !== 'suspended') {
    const open = document.createElement('a');
    open.href = `/${roomCode}`;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = 'Open room';
    actions.append(open);
  }

  const activation = document.createElement('button');
  activation.type = 'button';
  if (rawStatus === 'provisioning') {
    activation.textContent = 'Retry provisioning';
    activation.addEventListener('click', async () => {
      activation.disabled = true;
      activation.textContent = 'Retrying...';
      setProRoomStatus('');
      try {
        await fetchJson('/api/admin/pro-rooms', {
          method: 'POST',
          body: JSON.stringify({ roomCode, label: room.label || undefined }),
        });
        setProRoomStatus(`${roomCode} provisioned.`);
        await loadProRooms();
      } catch (error) {
        activation.disabled = false;
        activation.textContent = 'Retry provisioning';
        setProRoomStatus(adminErrorMessage(error, 'Provisioning retry failed.'), true);
      }
    });
  } else if (rawStatus === 'active') {
    activation.textContent = issuedOwnerRecoveryLinks.has(incarnationKey)
      ? 'Issue another owner recovery link'
      : 'Issue owner recovery link';
    activation.title =
      'Sign in to the intended owner account first, then open this one-time link in the same browser. It replaces the room owner credential; an already-linked room requires that same account.';
    activation.addEventListener('click', async () => {
      activation.disabled = true;
      activation.textContent = 'Issuing...';
      setProRoomStatus('');
      try {
        const payload = await fetchJson(`/api/admin/pro-rooms/${roomCode}/owner-recovery-claim`, {
          method: 'POST',
          body: JSON.stringify({ roomGeneration }),
        });
        showProRoomClaim(payload, 'recovery', roomGeneration);
        activation.textContent = 'Issue another owner recovery link';
        activation.disabled = false;
      } catch (error) {
        activation.disabled = false;
        activation.textContent = 'Issue owner recovery link';
        setProRoomStatus(adminErrorMessage(error, 'Owner recovery link failed.'), true);
        loadProRooms({ updateTimestamp: false }).catch(() => {});
      }
    });
  } else {
    activation.textContent = issuedActivationLinks.has(incarnationKey)
      ? 'Reissue activation link'
      : 'Issue activation link';
    activation.disabled = rawStatus === 'suspended';
    if (rawStatus === 'suspended') activation.title = 'Resume the room before issuing a link.';
    activation.addEventListener('click', async () => {
      activation.disabled = true;
      activation.textContent = 'Issuing...';
      setProRoomStatus('');
      try {
        const payload = await fetchJson(`/api/admin/pro-rooms/${roomCode}/activation-claim`, {
          method: 'POST',
          body: JSON.stringify({ roomGeneration }),
        });
        showProRoomClaim(payload, 'activation', roomGeneration);
        activation.textContent = 'Reissue activation link';
        activation.disabled = false;
      } catch (error) {
        activation.disabled = false;
        activation.textContent = 'Issue activation link';
        setProRoomStatus(adminErrorMessage(error, 'Activation link failed.'), true);
        loadProRooms({ updateTimestamp: false }).catch(() => {});
      }
    });
  }
  actions.append(activation);

  if (rawStatus === 'active' || rawStatus === 'suspended') {
    const targetStatus = rawStatus === 'active' ? 'suspended' : 'active';
    const stateButton = document.createElement('button');
    stateButton.type = 'button';
    stateButton.className = rawStatus === 'active' ? 'is-danger' : 'is-secondary';
    stateButton.textContent = rawStatus === 'active' ? 'Suspend room' : 'Resume room';
    stateButton.addEventListener('click', async () => {
      if (
        targetStatus === 'suspended' &&
        !window.confirm(`Suspend room ${roomCode}? Connected participants will be signed out.`)
      ) {
        return;
      }
      stateButton.disabled = true;
      stateButton.textContent = targetStatus === 'suspended' ? 'Suspending...' : 'Resuming...';
      try {
        const result = await fetchJson(`/api/admin/pro-rooms/${roomCode}/state`, {
          method: 'POST',
          body: JSON.stringify({ roomGeneration, status: targetStatus }),
        });
        if (
          result?.roomCode !== roomCode ||
          normalizeProRoomGeneration(result?.roomGeneration) !== roomGeneration ||
          result?.status !== targetStatus
        ) {
          throw new Error('PRO_ROOM_GENERATION_MISMATCH');
        }
        setProRoomStatus(
          targetStatus === 'suspended' ? `${roomCode} suspended.` : `${roomCode} resumed.`,
        );
        await loadProRooms();
      } catch (error) {
        stateButton.disabled = false;
        stateButton.textContent = rawStatus === 'active' ? 'Suspend room' : 'Resume room';
        setProRoomStatus(adminErrorMessage(error, 'Room status update failed.'), true);
      }
    });
    actions.append(stateButton);
  }

  section.append(heading);
  if (labelEditor) section.append(labelEditor);
  section.append(actions);
  return section;
}

function renderProRoomDangerZone(roomCode, roomGeneration, rawStatus) {
  const section = document.createElement('section');
  section.className = 'pro-room-danger-zone';
  const copy = document.createElement('div');
  const heading = document.createElement('strong');
  heading.textContent = 'Danger zone';
  const description = document.createElement('p');
  description.textContent =
    rawStatus === 'decommissioning'
      ? 'Access is blocked. Uploaded media is being swept after old upload links expire.'
      : rawStatus === 'decommissioned'
        ? 'This room incarnation and its API access were permanently removed. The room number may be registered as a new room.'
        : 'Permanently remove this room, its uploaded media, access, and API keys.';
  copy.append(heading, description);
  if (rawStatus === 'decommissioning' || rawStatus === 'decommissioned') {
    section.append(copy);
    return section;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'is-danger';
  button.textContent = 'Delete room permanently';
  button.dataset.proRoomDestroy = roomCode;
  button.addEventListener('click', () =>
    openProRoomDestroyDialog(roomCode, roomGeneration, button),
  );
  section.append(copy, button);
  return section;
}

function renderProRoomRow(room) {
  const roomCode = normalizeProRoomCode(room?.roomCode);
  if (!roomCode) return null;
  const roomGeneration = normalizeProRoomGeneration(room?.roomGeneration);
  const incarnationKey = proRoomIncarnationKey(roomCode, roomGeneration);
  const rawStatus = proRoomRawStatus(room);
  const item = document.createElement('details');
  item.className = 'pro-room-item';
  item.dataset.proRoomItem = roomCode;
  if (roomGeneration !== null) item.dataset.proRoomGeneration = String(roomGeneration);
  item.open = expandedProRooms.has(roomCode);

  const summary = document.createElement('summary');
  summary.className = 'pro-room-summary';
  const identity = document.createElement('div');
  identity.className = 'pro-room-identity';
  const code = document.createElement('strong');
  code.textContent = roomCode;
  const label = document.createElement('span');
  label.dataset.proRoomLabelValue = roomCode;
  label.textContent = String(room.label || 'Unlabelled PRO room');
  identity.append(code, label);

  const details = document.createElement('div');
  details.className = 'pro-room-details';
  const status = document.createElement('span');
  status.className = `pro-room-state is-${rawStatus.replace(/[^a-z-]/g, '')}`;
  status.textContent = formatProRoomStatus(rawStatus);
  const created = document.createElement('small');
  const createdAt = formatAdminDateTime(room.createdAt);
  created.textContent = createdAt ? `Created ${createdAt}` : 'Creation time unavailable';
  details.append(status, created);
  const chevron = document.createElement('span');
  chevron.className = 'pro-room-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 9 5.5 5.5L17.5 9"/></svg>';
  summary.append(identity, details, chevron);

  const expanded = document.createElement('div');
  expanded.className = 'pro-room-expanded';
  const controls = renderProRoomActions(room, roomCode, roomGeneration, rawStatus);
  const apiPanel = document.createElement('section');
  apiPanel.className = 'pro-room-api-panel';
  apiPanel.dataset.proRoomApiPanel = roomCode;
  if (roomGeneration !== null) apiPanel.dataset.proRoomGeneration = String(roomGeneration);
  apiPanel.setAttribute('aria-label', `${roomCode} Developer API`);
  const isTerminal = rawStatus === 'decommissioning' || rawStatus === 'decommissioned';
  const cached = incarnationKey ? proRoomApiCache.get(incarnationKey) : null;
  if (!incarnationKey) {
    const unavailable = document.createElement('p');
    unavailable.className = 'pro-room-api-status is-error';
    unavailable.textContent =
      'Room generation is unavailable. Refresh before managing Developer API keys.';
    apiPanel.append(unavailable);
  } else if (isTerminal) {
    const unavailable = document.createElement('p');
    unavailable.className = 'pro-room-api-status';
    unavailable.textContent = 'Developer API access has been removed.';
    apiPanel.append(unavailable);
  } else if (cached) {
    renderProRoomApiPanel(roomCode, roomGeneration, rawStatus, apiPanel, cached);
  } else {
    renderProRoomApiShell(roomCode, apiPanel);
  }
  const dangerZone = incarnationKey
    ? renderProRoomDangerZone(roomCode, roomGeneration, rawStatus)
    : document.createDocumentFragment();
  expanded.append(controls, apiPanel, dangerZone);
  item.append(summary, expanded);
  item.addEventListener('toggle', () => {
    if (item.open) {
      expandedProRooms.add(roomCode);
      if (!isTerminal && incarnationKey) {
        loadProRoomApiKeys(roomCode, roomGeneration, rawStatus, apiPanel).catch(() => {});
      }
    } else {
      expandedProRooms.delete(roomCode);
      if (incarnationKey) {
        proRoomApiRequestGenerations.set(
          incarnationKey,
          (proRoomApiRequestGenerations.get(incarnationKey) || 0) + 1,
        );
        clearProRoomApiSecret(roomCode, roomGeneration);
      }
    }
  });
  return item;
}

function renderProRooms(payload) {
  const rooms = Array.isArray(payload?.rooms) ? payload.rooms : [];
  const currentIncarnations = new Set(
    rooms
      .map((room) => proRoomIncarnationKey(room?.roomCode, room?.roomGeneration))
      .filter(Boolean),
  );
  for (const collection of [
    issuedActivationLinks,
    issuedOwnerRecoveryLinks,
    proRoomApiCache,
    proRoomApiSecrets,
    proRoomApiRequestGenerations,
  ]) {
    for (const incarnationKey of collection.keys()) {
      if (!currentIncarnations.has(incarnationKey)) collection.delete(incarnationKey);
    }
  }
  if (visibleProRoomClaimIncarnation && !currentIncarnations.has(visibleProRoomClaimIncarnation)) {
    dismissProRoomClaim();
  }
  if (proRoomListStatusEl) {
    proRoomListStatusEl.textContent = `${formatter.format(rooms.length)} rooms`;
  }
  if (!proRoomListEl) return;
  const rows = rooms.map(renderProRoomRow).filter(Boolean);
  if (rows.length) {
    proRoomListEl.replaceChildren(...rows);
    for (const row of rows) {
      if (!row.open) continue;
      const roomCode = row.dataset.proRoomItem;
      const room = rooms.find((candidate) => candidate?.roomCode === roomCode);
      const panel = row.querySelector('[data-pro-room-api-panel]');
      const rawStatus = proRoomRawStatus(room);
      const roomGeneration = normalizeProRoomGeneration(room?.roomGeneration);
      if (
        roomCode &&
        roomGeneration !== null &&
        panel &&
        rawStatus !== 'decommissioning' &&
        rawStatus !== 'decommissioned'
      ) {
        loadProRoomApiKeys(roomCode, roomGeneration, rawStatus, panel).catch(() => {});
      }
    }
    return;
  }
  const empty = document.createElement('p');
  empty.className = 'pro-room-empty';
  empty.textContent = 'No PRO rooms registered yet.';
  proRoomListEl.replaceChildren(empty);
}

async function loadProRooms(options = {}) {
  if (proRoomListStatusEl) proRoomListStatusEl.textContent = 'Refreshing...';
  const payload = await fetchJson('/api/admin/pro-rooms');
  renderProRooms(payload);
  proRoomsLoaded = true;
  if (options.updateTimestamp !== false) {
    updatedAtEl.textContent = `Updated ${formatAdminDateTime(payload.generatedAt || Date.now())}`;
  }
}

async function registerProRoom() {
  const roomCode = normalizeProRoomCode(proRoomCodeEl?.value);
  const label = String(proRoomLabelEl?.value || '').trim();
  if (!roomCode) throw new Error('Room number must be six digits beginning with 0.');
  if (label.length > 64) throw new Error('Label must be 64 characters or fewer.');

  if (proRoomRegisterBtn) proRoomRegisterBtn.disabled = true;
  setProRoomStatus('Registering...');
  try {
    const payload = await fetchJson('/api/admin/pro-rooms', {
      method: 'POST',
      body: JSON.stringify({ roomCode, ...(label ? { label } : {}) }),
    });
    setProRoomStatus(`${roomCode} registered.`);
    proRoomForm?.reset();
    await loadProRooms();
    return payload;
  } finally {
    if (proRoomRegisterBtn) proRoomRegisterBtn.disabled = false;
  }
}

function setActiveTab(tab) {
  currentAdminTab = tab;
  adminTabs.forEach((button) => {
    const active = button.dataset.adminTab === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  adminViews.forEach((view) => {
    const active = view.dataset.adminView === tab;
    view.hidden = !active;
    view.classList.toggle('is-active', active);
  });
  if (dashboardTitle) dashboardTitle.textContent = announcementTitle(tab);
}

function renderCards(cards) {
  cardsEl.replaceChildren(
    ...cards.map((card) => {
      const article = document.createElement('article');
      article.className = 'metric-card';
      const value =
        typeof card.value === 'number' ? formatter.format(card.value) : String(card.value);
      article.innerHTML = `
        <span>${card.label}</span>
        <strong>${value}</strong>
        <small>${formatDelta(card.delta)}</small>
      `;
      return article;
    }),
  );
}

function hourLabel(iso) {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function dayLabel(iso) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso));
}

function compactDayLabel(iso) {
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function renderHourlyChart(hourly) {
  const max = Math.max(
    1,
    ...hourly.map((bucket) => bucket.events.room_opened + bucket.events.guest_joined),
  );
  hourlyEl.replaceChildren(
    ...hourly.map((bucket) => {
      const rooms = bucket.events.room_opened || 0;
      const guests = bucket.events.guest_joined || 0;
      const total = rooms + guests;
      const row = document.createElement('div');
      row.className = 'chart-row';
      row.innerHTML = `
        <span class="chart-label">${hourLabel(bucket.start)}</span>
        <span class="chart-track">
          <span class="bar rooms" style="width:${(rooms / max) * 100}%"></span>
          <span class="bar guests" style="width:${(guests / max) * 100}%"></span>
        </span>
        <span class="chart-value">${formatter.format(total)}</span>
      `;
      return row;
    }),
  );
}

function renderDailyList(daily) {
  const max = Math.max(
    1,
    ...daily.map((bucket) => bucket.events.room_opened + bucket.events.guest_joined),
  );
  dailyEl.replaceChildren(
    ...daily.map((bucket) => {
      const rooms = bucket.events.room_opened || 0;
      const guests = bucket.events.guest_joined || 0;
      const item = document.createElement('article');
      item.className = 'trend-item';
      item.innerHTML = `
        <div>
          <span>${dayLabel(bucket.start)}</span>
          <strong>${formatter.format(rooms)} rooms</strong>
          <small>${formatter.format(guests)} guest joins</small>
        </div>
        <div class="trend-bar" aria-hidden="true">
          <span style="width:${((rooms + guests) / max) * 100}%"></span>
        </div>
      `;
      return item;
    }),
  );
}

function renderMonthlyChart(daily30) {
  if (!monthlyEl) return;
  const totals = daily30.map((bucket) => {
    const rooms = bucket.events.room_opened || 0;
    const guests = bucket.events.guest_joined || 0;
    return rooms + guests;
  });
  const max = Math.max(1, ...totals);
  const mid = Math.ceil(max / 2);
  const ticks = max > 1 ? [max, mid, 0] : [1, 0];

  const axis = document.createElement('div');
  axis.className = 'spectrum-axis';
  axis.setAttribute('aria-hidden', 'true');
  axis.innerHTML = ticks.map((tick) => `<span>${formatter.format(tick)}</span>`).join('');

  const bars = document.createElement('div');
  bars.className = 'spectrum-bars';
  bars.setAttribute('role', 'list');

  daily30.forEach((bucket, index) => {
    const rooms = bucket.events.room_opened || 0;
    const guests = bucket.events.guest_joined || 0;
    const total = rooms + guests;
    const label = compactDayLabel(bucket.start);
    const bar = document.createElement('div');
    bar.className = 'spectrum-bar';
    bar.setAttribute('role', 'listitem');
    bar.setAttribute(
      'aria-label',
      `${label}: ${formatter.format(total)} total activity, ${formatter.format(rooms)} rooms, ${formatter.format(guests)} guest joins`,
    );
    bar.innerHTML = `
      <span class="spectrum-column" style="height:${Math.max(3, (total / max) * 100)}%">
        <span class="spectrum-fill rooms" style="height:${total ? (rooms / total) * 100 : 0}%"></span>
        <span class="spectrum-fill guests" style="height:${total ? (guests / total) * 100 : 0}%"></span>
      </span>
      <span class="spectrum-date">${index % 5 === 0 || index === daily30.length - 1 ? label : ''}</span>
    `;
    bars.appendChild(bar);
  });

  monthlyEl.replaceChildren(axis, bars);
}

function renderSignals(summary) {
  const last24 = summary.last24 || {};
  const signals = [
    ['Host missing', last24.guest_host_unavailable || 0],
    ['Password prompts', last24.guest_auth_pending || 0],
    ['Password failures', last24.guest_auth_failed || 0],
    ['Password timeouts', last24.guest_auth_timeout || 0],
    ['Host reconnects', last24.host_reconnected || 0],
  ];
  signalEl.replaceChildren(
    ...signals.map(([label, value]) => {
      const item = document.createElement('div');
      item.className = 'signal-item';
      item.innerHTML = `<span>${label}</span><strong>${formatter.format(value)}</strong>`;
      return item;
    }),
  );
}

async function loadMetrics(options = {}) {
  updatedAtEl.textContent = 'Refreshing...';
  const metrics = await fetchJson('/api/admin/metrics');
  showDashboard();
  if (options.activateOperations) setActiveTab('operations');
  renderCards(metrics.cards || []);
  renderHourlyChart(metrics.summary?.hourly || []);
  renderDailyList(metrics.summary?.daily || []);
  renderMonthlyChart(metrics.summary?.daily30 || []);
  renderSignals(metrics.summary || {});
  if (options.updateTimestamp !== false) {
    updatedAtEl.textContent = `Updated ${formatAdminDateTime(metrics.generatedAt)}`;
  }
}

function renderArticleRow(article) {
  const item = document.createElement('article');
  item.className = 'article-item';
  item.classList.toggle('is-hidden', Boolean(article.hidden));

  const body = document.createElement('div');
  body.className = 'article-body';

  const title = document.createElement('strong');
  title.textContent = article.title || article.slug;

  const meta = document.createElement('span');
  const parts = [formatArticleDate(article.pubDate), article.slug, article.source].filter(Boolean);
  meta.textContent = parts.join(' · ');

  body.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'article-actions';

  const open = document.createElement('a');
  open.href = article.href || `/blog/${article.slug}`;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.textContent = 'Open';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'article-toggle';
  toggle.textContent = article.hidden ? 'Restore' : 'Hide';
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    toggle.textContent = article.hidden ? 'Restoring...' : 'Hiding...';
    try {
      await fetchJson('/api/admin/articles/visibility', {
        method: 'POST',
        body: JSON.stringify({ slug: article.slug, hidden: !article.hidden }),
      });
      await loadArticles();
    } catch (error) {
      toggle.disabled = false;
      toggle.textContent = article.hidden ? 'Restore' : 'Hide';
      if (articleStatusEl) articleStatusEl.textContent = error.message || 'Article update failed.';
    }
  });

  actions.append(open, toggle);
  item.append(body, actions);
  return item;
}

function renderArticles(payload) {
  const articles = payload.articles || [];
  const visibleCount = articles.filter((article) => !article.hidden).length;
  const hiddenCount = articles.length - visibleCount;
  if (articleStatusEl) {
    articleStatusEl.textContent = `${formatter.format(visibleCount)} visible · ${formatter.format(hiddenCount)} hidden`;
  }
  if (!articleListEl) return;
  if (!articles.length) {
    const empty = document.createElement('p');
    empty.className = 'article-empty';
    empty.textContent = 'No articles found.';
    articleListEl.replaceChildren(empty);
    return;
  }
  articleListEl.replaceChildren(...articles.map(renderArticleRow));
}

async function loadArticles(options = {}) {
  if (articleStatusEl) articleStatusEl.textContent = 'Refreshing...';
  const payload = await fetchJson('/api/admin/articles');
  renderArticles(payload);
  articlesLoaded = true;
  if (options.updateTimestamp !== false) {
    updatedAtEl.textContent = `Updated ${formatAdminDateTime(payload.generatedAt)}`;
  }
}

function renderAnnouncement(payload) {
  const announcement = payload.announcement || {};
  const message = announcement.message || '';
  if (announcementMessageEl) announcementMessageEl.value = message;
  if (announcementEnabledEl) announcementEnabledEl.checked = Boolean(announcement.enabled);
  if (announcementExpiresEl)
    announcementExpiresEl.value = toDatetimeLocalValue(announcement.expiresAt);

  const statusParts = [];
  statusParts.push(announcement.enabled ? 'Enabled' : 'Disabled');
  if (announcement.expiresAt)
    statusParts.push(`expires ${formatAdminDateTime(announcement.expiresAt)}`);
  if (announcement.updatedAt)
    statusParts.push(`updated ${formatAdminDateTime(announcement.updatedAt)}`);
  if (announcementStatusEl) announcementStatusEl.textContent = statusParts.join(' - ');

  if (!announcementPreviewEl) return;
  if (!message) {
    announcementPreviewEl.hidden = true;
    announcementPreviewEl.textContent = '';
    return;
  }
  announcementPreviewEl.hidden = false;
  announcementPreviewEl.innerHTML = `
    <span>Notice - MUSIXQUARE</span>
    <p></p>
  `;
  announcementPreviewEl.querySelector('p').textContent = message;
}

function renderAnnouncementHistory(payload) {
  const history = Array.isArray(payload.history) ? payload.history : [];
  if (announcementHistoryStatusEl) {
    announcementHistoryStatusEl.textContent = history.length
      ? `${formatter.format(history.length)} records`
      : 'No records';
  }
  if (!announcementHistoryListEl) return;
  if (!history.length) {
    const empty = document.createElement('p');
    empty.className = 'announcement-history-empty';
    empty.textContent = 'No announcement history yet.';
    announcementHistoryListEl.replaceChildren(empty);
    return;
  }

  announcementHistoryListEl.replaceChildren(
    ...history.map((entry) => {
      const item = document.createElement('article');
      const action = String(entry.action || 'updated');
      item.className = `announcement-history-item action-${action}`;

      const meta = document.createElement('div');
      meta.className = 'announcement-history-meta';

      const actionEl = document.createElement('strong');
      actionEl.textContent = formatAnnouncementAction(action);
      meta.appendChild(actionEl);

      const timeEl = document.createElement('span');
      timeEl.textContent = formatAdminDateTime(entry.updatedAt);
      meta.appendChild(timeEl);

      if (entry.expiresAt) {
        const expiresEl = document.createElement('small');
        expiresEl.textContent = `expires ${formatAdminDateTime(entry.expiresAt)}`;
        meta.appendChild(expiresEl);
      }

      const body = document.createElement('p');
      body.textContent = entry.message || 'No message';

      item.append(meta, body);
      return item;
    }),
  );
}

async function loadAnnouncement(options = {}) {
  if (announcementStatusEl) announcementStatusEl.textContent = 'Refreshing...';
  const payload = await fetchJson('/api/admin/announcement');
  renderAnnouncement(payload);
  renderAnnouncementHistory(payload);
  announcementLoaded = true;
  if (options.updateTimestamp !== false) {
    updatedAtEl.textContent = `Updated ${formatAdminDateTime(payload.generatedAt)}`;
  }
}

async function saveAnnouncement({ clear = false } = {}) {
  const message = clear ? '' : String(announcementMessageEl?.value || '').trim();
  const enabled = clear ? false : Boolean(announcementEnabledEl?.checked);
  const expiresValue = clear ? '' : String(announcementExpiresEl?.value || '').trim();
  if (announcementStatusEl) announcementStatusEl.textContent = clear ? 'Clearing...' : 'Saving...';
  const payload = await fetchJson('/api/admin/announcement', {
    method: 'POST',
    body: JSON.stringify({
      message,
      enabled,
      expiresAt: parseAnnouncementExpiresValue(expiresValue),
    }),
  });
  renderAnnouncement(payload);
  renderAnnouncementHistory(payload);
  announcementLoaded = true;
  updatedAtEl.textContent = `Updated ${formatAdminDateTime(Date.now())}`;
}

async function refreshAllDashboardData() {
  const activeTab = currentAdminTab;
  updatedAtEl.textContent = 'Refreshing...';
  await Promise.all([
    loadMetrics({ updateTimestamp: false }),
    loadProRooms({ updateTimestamp: false }).catch((error) => {
      if (proRoomListStatusEl) {
        proRoomListStatusEl.textContent = adminErrorMessage(error, 'PRO rooms refresh failed.');
      }
    }),
    loadArticles({ updateTimestamp: false }),
    loadAnnouncement({ updateTimestamp: false }),
  ]);
  setActiveTab(activeTab);
  updatedAtEl.textContent = `Updated ${formatAdminDateTime(Date.now())}`;
}

async function init() {
  if (root?.dataset.adminConfigured !== 'true') {
    showLogin('Admin secrets are not configured yet.');
    return;
  }

  try {
    const session = await fetchJson('/api/admin/session');
    if (!session.authenticated) {
      showLogin();
      return;
    }
    await loadMetrics({ activateOperations: true });
  } catch (error) {
    showLogin(error.message || 'Failed to load admin session.');
  }
}

loginForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);
  const password = String(form.get('password') || '');
  setStatus('Checking...');
  try {
    await fetchJson('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    loginForm.reset();
    await loadMetrics({ activateOperations: true });
  } catch (error) {
    setStatus(adminErrorMessage(error, 'Login failed.'), true);
  }
});

refreshBtn?.addEventListener('click', () => {
  refreshAllDashboardData().catch((error) => {
    updatedAtEl.textContent = error.message || 'Refresh failed.';
  });
});

adminTabs.forEach((button) => {
  button.addEventListener('click', () => {
    const tab = button.dataset.adminTab || 'operations';
    setActiveTab(tab);
    if (tab === 'pro-rooms' && !proRoomsLoaded) {
      loadProRooms().catch((error) => {
        if (proRoomListStatusEl) {
          proRoomListStatusEl.textContent = adminErrorMessage(error, 'Refresh failed.');
        }
      });
    }
    if (tab === 'articles' && !articlesLoaded) {
      loadArticles().catch((error) => {
        if (articleStatusEl) articleStatusEl.textContent = error.message || 'Refresh failed.';
      });
    }
    if (tab === 'announcements' && !announcementLoaded) {
      loadAnnouncement().catch((error) => {
        if (announcementStatusEl)
          announcementStatusEl.textContent = error.message || 'Refresh failed.';
      });
    }
  });
});

proRoomCodeEl?.addEventListener('input', () => {
  const digits = String(proRoomCodeEl.value || '')
    .replace(/\D/g, '')
    .slice(0, 6);
  if (proRoomCodeEl.value !== digits) proRoomCodeEl.value = digits;
  proRoomCodeEl.setCustomValidity(
    digits.length === 0 || /^0\d{5}$/.test(digits) ? '' : 'Use six digits beginning with 0.',
  );
});

proRoomForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  registerProRoom().catch((error) => {
    setProRoomStatus(adminErrorMessage(error, 'Registration failed.'), true);
    loadProRooms({ updateTimestamp: false }).catch(() => {});
  });
});

proRoomClaimCopyBtn?.addEventListener('click', () => {
  copyProRoomClaim().catch(() => {
    setProRoomStatus('Copy failed. Select and copy the link.', true);
  });
});

proRoomClaimDismissBtn?.addEventListener('click', dismissProRoomClaim);
window.addEventListener('pagehide', () => {
  closeProRoomDestroyDialog({ restoreFocus: false });
  clearProRoomClaimState();
  clearAllProRoomApiSecrets();
});
window.addEventListener('beforeunload', () => {
  closeProRoomDestroyDialog({ restoreFocus: false });
  clearProRoomClaimState();
  clearAllProRoomApiSecrets();
});

announcementForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  saveAnnouncement().catch((error) => {
    if (announcementStatusEl)
      announcementStatusEl.textContent = adminErrorMessage(error, 'Save failed.');
  });
});

announcementClearBtn?.addEventListener('click', () => {
  saveAnnouncement({ clear: true }).catch((error) => {
    if (announcementStatusEl)
      announcementStatusEl.textContent = adminErrorMessage(error, 'Clear failed.');
  });
});

logoutBtn?.addEventListener('click', async () => {
  clearProRoomClaimState();
  await fetchJson('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

init();
