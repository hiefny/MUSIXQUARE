const ADMIN_SCRIPT_VERSION = '8.3.59';
window.__MXQR_ADMIN_SCRIPT_VERSION__ = ADMIN_SCRIPT_VERSION;

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
const announcementTabEl = document.querySelector('[data-admin-tab="announcements"]');
const serviceStatusTrigger = document.querySelector('[data-service-status-trigger]');
const serviceStatusDot = document.querySelector('[data-service-status-dot]');
const serviceStatusLabel = document.querySelector('[data-service-status-label]');
const serviceStatusDialog = document.querySelector('[data-service-status-dialog]');
const serviceStatusForm =
  document.querySelector('[data-service-status-form]') ||
  document.querySelector('[data-service-status-confirm]')?.closest('form');
const serviceStatusStateEl = document.querySelector('[data-service-status-state]');
const serviceStatusDescriptionEl = document.querySelector('[data-service-status-description]');
const serviceStatusUpdatedAtEl = document.querySelector('[data-service-status-updated]');
const serviceStatusErrorEl = document.querySelector('[data-service-status-error]');
const serviceStatusConfirmBtn = document.querySelector('[data-service-status-confirm]');
const serviceStatusPreviewBtn = document.querySelector('[data-service-status-preview]');
const serviceStatusCancelBtns = [...document.querySelectorAll('[data-service-status-cancel]')];
const updatedAtEl = document.querySelector('[data-updated-at]');
const refreshBtn = document.querySelector('[data-refresh]');
const logoutBtn = document.querySelector('[data-logout]');

const formatter = new Intl.NumberFormat();
const ADMIN_REQUEST_TIMEOUT_MS = 20_000;
const ADMIN_RESPONSE_MAX_BYTES = 1_048_576;
let currentAdminTab = 'operations';
let proRoomsLoaded = false;
let articlesLoaded = false;
let announcementLoaded = false;
let currentAnnouncementRevision = null;
let pendingAnnouncementMutation = null;
let announcementMutationBusy = false;
let serviceStatusLoaded = false;
let currentServiceStatus = null;
let serviceStatusBusy = false;
let serviceStatusRestoreFocus = null;
let serviceStatusRequestId = null;
let serviceStatusSettleTimer = null;
let announcementExpiryTimer = null;
let adminSessionEpoch = 0;
let adminLogoutInFlight = null;
const adminRequestControllers = new Set();
const adminLatestLoads = new Map();
const issuedActivationLinks = new Set();
const issuedOwnerRecoveryLinks = new Set();
const issuedOwnerTransferLinks = new Set();
const expandedProRooms = new Set();
const proRoomApiCache = new Map();
const proRoomApiSecrets = new Map();
const proRoomApiRequestGenerations = new Map();
let proRoomDestroyDialogElements = null;
let proRoomDestroyTarget = null;
let proRoomLegacyOwnerDetachDialogElements = null;
let proRoomLegacyOwnerDetachTarget = null;
let proRoomTransferDialogElements = null;
let proRoomTransferTarget = null;
let visibleProRoomClaimIncarnation = null;
let proGrantCampaignLoaded = false;
let proGrantCampaignState = null;
let proGrantCampaigns = [];
let selectedProGrantCampaignSlug = null;
let proGrantCampaignDraft = null;
let verifiedProGrantPool = null;
let proGrantCampaignBusy = false;
let pendingProGrantVoucherExport = null;
let proGrantCampaignPanelEl = null;
let proGrantCampaignListEl = null;
let proGrantCampaignDetailEl = null;
let proGrantCampaignTitleEl = null;
let proGrantCampaignMetaEl = null;
let proGrantCampaignEventLinkEl = null;
let proGrantCampaignStateEl = null;
let proGrantCampaignStatusEl = null;
let proGrantCampaignCountsEl = null;
let proGrantCampaignNewBtn = null;
let proGrantCampaignImportBtn = null;
let proGrantCampaignImportInput = null;
let proGrantCampaignFormEl = null;
let proGrantCampaignFormCancelBtn = null;
let proGrantCampaignVerifyBtn = null;
let proGrantCampaignCreateBtn = null;
let proGrantCampaignApplyBtn = null;
let proGrantCampaignPauseBtn = null;
let proGrantCampaignEndBtn = null;
let proGrantCampaignRevokeBtn = null;
let proGrantCampaignExportEl = null;
let proGrantCampaignDownloadBtn = null;
let proGrantCampaignCopyBtn = null;
let proGrantCampaignLinkCopyBtn = null;
const PRO_GRANT_ASAMO_SLUG = 'asamo-0';
const PRO_GRANT_ASAMO_TITLE = 'MUSIXQUARE 아사모 이벤트';
const PRO_GRANT_ASAMO_ROOM_CODES = Object.freeze(
  Array.from({ length: 50 }, (_, index) => String(100 + index).padStart(6, '0')),
);
const PRO_GRANT_MAX_CAMPAIGN_ROOMS = 100;
const PRO_GRANT_BUILTIN_CAMPAIGNS = Object.freeze({
  [PRO_GRANT_ASAMO_SLUG]: Object.freeze({
    slug: PRO_GRANT_ASAMO_SLUG,
    title: PRO_GRANT_ASAMO_TITLE,
    roomCodes: PRO_GRANT_ASAMO_ROOM_CODES,
    roomLabelPrefix: 'ASAMO 0',
  }),
});

function proGrantBuiltinCampaign(slug) {
  return typeof slug === 'string' && Object.hasOwn(PRO_GRANT_BUILTIN_CAMPAIGNS, slug)
    ? PRO_GRANT_BUILTIN_CAMPAIGNS[slug]
    : null;
}
const PRO_GRANT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PRO_GRANT_VOUCHER_CODE_RE = /^MXQ(?:-[0-9A-HJKMNP-TV-Z]{5}){4}$/;
const PRO_GRANT_BATCH_REQUEST_ID_RE = /^batch_[A-Za-z0-9_-]{22}$/;
const PRO_GRANT_VOUCHER_FILE_MAX_BYTES = 256 * 1024;
const PRO_GRANT_ROOM_PROVISION_CONCURRENCY = 4;
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

function bytesToAdminBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function createProGrantBatchRequestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `batch_${bytesToAdminBase64Url(bytes)}`;
}

function createProGrantVoucherCode() {
  const entropy = new Uint8Array(13);
  crypto.getRandomValues(entropy);
  let bits = 0;
  let bitCount = 0;
  let encoded = '';
  for (const byte of entropy) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && encoded.length < 20) {
      bitCount -= 5;
      encoded += PRO_GRANT_CODE_ALPHABET[(bits >>> bitCount) & 31];
      bits &= (1 << bitCount) - 1;
    }
  }
  if (encoded.length !== 20) throw new Error('Secure voucher generation failed.');
  return `MXQ-${encoded.slice(0, 5)}-${encoded.slice(5, 10)}-${encoded.slice(10, 15)}-${encoded.slice(15)}`;
}

function campaignRoomCodesFromRange(startCode, roomCount) {
  const normalizedStart = normalizeProRoomCode(startCode);
  const normalizedCount = Number(roomCount);
  if (
    !normalizedStart ||
    !Number.isSafeInteger(normalizedCount) ||
    normalizedCount < 1 ||
    normalizedCount > PRO_GRANT_MAX_CAMPAIGN_ROOMS
  ) {
    throw new Error(`방 번호와 방 개수(최대 ${PRO_GRANT_MAX_CAMPAIGN_ROOMS}개)를 확인해 주세요.`);
  }
  const first = Number(normalizedStart);
  const last = first + normalizedCount - 1;
  if (last > 99_999) throw new Error('이 범위는 0으로 시작하는 6자리 PRO 방 번호를 벗어나요.');
  return Object.freeze(
    Array.from({ length: normalizedCount }, (_, index) => String(first + index).padStart(6, '0')),
  );
}

function normalizeCampaignTimestamp(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function formatCampaignLocalDateTime(value) {
  const timestamp = normalizeCampaignTimestamp(value);
  if (timestamp === null) return '';
  const date = new Date(timestamp);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(timestamp - offset).toISOString().slice(0, 16);
}

function parseCampaignLocalDateTime(value, { required = false } = {}) {
  const normalized = String(value || '').trim();
  if (!normalized && !required) return null;
  const timestamp = new Date(normalized).getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(required ? '시작 시간을 입력해 주세요.' : '종료 시간을 확인해 주세요.');
  }
  return timestamp;
}

function proGrantCampaignRoomCodes(entry) {
  const campaign = entry?.campaign || entry;
  const explicit = entry?.roomCodes || campaign?.roomCodes;
  if (Array.isArray(explicit) && explicit.length > 0) {
    const normalized = explicit.map(normalizeProRoomCode);
    if (normalized.every(Boolean) && new Set(normalized).size === normalized.length) {
      return Object.freeze(normalized);
    }
  }
  const builtin = proGrantBuiltinCampaign(campaign?.slug);
  if (builtin) return builtin.roomCodes;
  const pool = entry?.pool || campaign?.pool;
  if (pool && typeof pool === 'object') {
    const firstRoomCode = normalizeProRoomCode(pool.firstRoomCode);
    const lastRoomCode = normalizeProRoomCode(pool.lastRoomCode);
    const roomCount = Number(pool.roomCount);
    if (
      firstRoomCode &&
      lastRoomCode &&
      Number.isSafeInteger(roomCount) &&
      roomCount > 0 &&
      Number(lastRoomCode) - Number(firstRoomCode) + 1 === roomCount
    ) {
      try {
        return campaignRoomCodesFromRange(firstRoomCode, roomCount);
      } catch {
        return Object.freeze([]);
      }
    }
    return Object.freeze([]);
  }
  const startCode =
    entry?.roomStartCode ||
    campaign?.roomStartCode ||
    entry?.firstRoomCode ||
    campaign?.firstRoomCode;
  const roomCount = Number(entry?.roomCount || campaign?.roomCount);
  try {
    return campaignRoomCodesFromRange(startCode, roomCount);
  } catch {
    return Object.freeze([]);
  }
}

function proGrantCampaignConfig(entry = selectedProGrantCampaign()) {
  if (!entry) return null;
  const campaign = entry.campaign || entry;
  const roomCodes = proGrantCampaignRoomCodes(entry);
  const builtin = proGrantBuiltinCampaign(campaign.slug);
  return {
    campaign: {
      slug: campaign.slug,
      title: campaign.title,
      startsAt: normalizeCampaignTimestamp(campaign.startsAt, Date.now()),
      endsAt: normalizeCampaignTimestamp(campaign.endsAt),
      perAccountLimit: Number(campaign.perAccountLimit) || 1,
      ...(roomCodes.length > 0 ? { roomStartCode: roomCodes[0], roomCount: roomCodes.length } : {}),
    },
    roomCodes,
    roomLabelPrefix:
      entry.roomLabelPrefix || builtin?.roomLabelPrefix || String(campaign.title || campaign.slug),
    isDraft: entry.isDraft === true,
  };
}

function selectedProGrantCampaign() {
  if (
    proGrantCampaignDraft?.campaign?.slug &&
    proGrantCampaignDraft.campaign.slug === selectedProGrantCampaignSlug
  ) {
    return proGrantCampaignDraft;
  }
  return (
    proGrantCampaigns.find(
      (entry) => (entry?.campaign?.slug || entry?.slug) === selectedProGrantCampaignSlug,
    ) || null
  );
}

function createProGrantVoucherExport(config = proGrantCampaignConfig()) {
  if (!config?.campaign?.slug || config.roomCodes.length === 0) {
    throw new Error('먼저 이벤트와 방 범위를 확인해 주세요.');
  }
  const requestId = createProGrantBatchRequestId();
  const seen = new Set();
  const vouchers = config.roomCodes.map((roomCode) => {
    let code;
    do code = createProGrantVoucherCode();
    while (seen.has(code));
    seen.add(code);
    return { roomCode, code };
  });
  return {
    format: 'mxqr-pro-grant-vouchers-v1',
    warning: 'PLAINTEXT VOUCHER CODES. Store and distribute securely.',
    exportedAt: new Date().toISOString(),
    requestId,
    campaign: {
      slug: config.campaign.slug,
      title: config.campaign.title,
      startsAt: config.campaign.startsAt,
      endsAt: config.campaign.endsAt,
      perAccountLimit: 1,
    },
    pool: {
      firstRoomCode: config.roomCodes[0],
      lastRoomCode: config.roomCodes.at(-1),
      roomCount: config.roomCodes.length,
    },
    roomLabelPrefix: config.roomLabelPrefix,
    vouchers,
  };
}

function proGrantVoucherFilename(batch) {
  const suffix = String(batch?.requestId || '').replace(/^batch_/u, '');
  const slug = String(batch?.campaign?.slug || 'pro-event');
  return `${slug}-${suffix || 'vouchers'}.json`;
}

function objectHasOnlyKeys(value, allowed) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}

function parseProGrantVoucherExport(value) {
  if (
    !objectHasOnlyKeys(value, [
      'format',
      'warning',
      'exportedAt',
      'requestId',
      'campaign',
      'pool',
      'roomLabelPrefix',
      'vouchers',
    ]) ||
    value.format !== 'mxqr-pro-grant-vouchers-v1' ||
    typeof value.warning !== 'string' ||
    !Number.isFinite(Date.parse(value.exportedAt || '')) ||
    !PRO_GRANT_BATCH_REQUEST_ID_RE.test(value.requestId || '')
  ) {
    throw new Error('지원하지 않거나 손상된 코드 파일이에요.');
  }
  const campaign = value.campaign;
  if (
    !objectHasOnlyKeys(campaign, ['slug', 'title', 'startsAt', 'endsAt', 'perAccountLimit']) ||
    typeof campaign.slug !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(campaign.slug || '') ||
    campaign.slug.length > 63 ||
    typeof campaign.title !== 'string' ||
    campaign.title.trim() !== campaign.title ||
    campaign.title.length < 1 ||
    campaign.title.length > 100 ||
    !Number.isSafeInteger(campaign.startsAt) ||
    campaign.startsAt < 0 ||
    (campaign.endsAt !== null &&
      (!Number.isSafeInteger(campaign.endsAt) || campaign.endsAt <= campaign.startsAt)) ||
    campaign.perAccountLimit !== 1
  ) {
    throw new Error('코드 파일의 이벤트 정보가 올바르지 않아요.');
  }
  if (
    !Array.isArray(value.vouchers) ||
    value.vouchers.length < 1 ||
    value.vouchers.length > PRO_GRANT_MAX_CAMPAIGN_ROOMS
  ) {
    throw new Error('코드 파일의 리딤 코드 개수가 올바르지 않아요.');
  }
  const seenCodes = new Set();
  const seenRooms = new Set();
  const vouchers = value.vouchers.map((voucher) => {
    if (
      !objectHasOnlyKeys(voucher, ['roomCode', 'code']) ||
      !/^0\d{5}$/u.test(voucher.roomCode || '') ||
      seenRooms.has(voucher.roomCode) ||
      !PRO_GRANT_VOUCHER_CODE_RE.test(voucher.code || '') ||
      seenCodes.has(voucher.code)
    ) {
      throw new Error('코드 파일의 방 번호 또는 리딤 코드가 올바르지 않아요.');
    }
    seenRooms.add(voucher.roomCode);
    seenCodes.add(voucher.code);
    return { roomCode: voucher.roomCode, code: voucher.code };
  });
  const roomCodes = campaignRoomCodesFromRange(vouchers[0].roomCode, vouchers.length);
  if (vouchers.some((voucher, index) => voucher.roomCode !== roomCodes[index])) {
    throw new Error('코드 파일의 방 번호는 오름차순의 연속된 범위여야 해요.');
  }
  if (value.pool !== undefined) {
    const pool = value.pool;
    if (
      !objectHasOnlyKeys(pool, ['firstRoomCode', 'lastRoomCode', 'roomCount']) ||
      pool.firstRoomCode !== roomCodes[0] ||
      pool.lastRoomCode !== roomCodes.at(-1) ||
      pool.roomCount !== roomCodes.length
    ) {
      throw new Error('코드 파일의 방 범위가 서로 일치하지 않아요.');
    }
  }
  const roomLabelPrefix =
    value.roomLabelPrefix === undefined ? campaign.title : String(value.roomLabelPrefix);
  if (
    !roomLabelPrefix ||
    roomLabelPrefix.length > 100 ||
    roomLabelPrefix.trim() !== roomLabelPrefix
  ) {
    throw new Error('코드 파일의 방 라벨이 올바르지 않아요.');
  }
  return {
    format: value.format,
    warning: value.warning,
    exportedAt: value.exportedAt,
    requestId: value.requestId,
    campaign: { ...campaign },
    pool: {
      firstRoomCode: roomCodes[0],
      lastRoomCode: roomCodes.at(-1),
      roomCount: roomCodes.length,
    },
    roomLabelPrefix,
    vouchers,
  };
}

function sameImportedCampaign(existing, imported) {
  if (!existing) return true;
  const campaign = existing.campaign || existing;
  return (
    campaign.slug === imported.slug &&
    campaign.title === imported.title &&
    normalizeCampaignTimestamp(campaign.startsAt) === imported.startsAt &&
    normalizeCampaignTimestamp(campaign.endsAt) === imported.endsAt &&
    Number(campaign.perAccountLimit) === imported.perAccountLimit
  );
}

async function importProGrantVoucherExport(file) {
  if (!file || proGrantCampaignBusy) return;
  setProGrantCampaignBusy(true);
  try {
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > PRO_GRANT_VOUCHER_FILE_MAX_BYTES
    ) {
      throw new Error('코드 파일은 256KB 이하의 JSON 파일이어야 해요.');
    }
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      throw new Error('코드 파일을 읽지 못했어요. 올바른 JSON 파일인지 확인해 주세요.');
    }
    const batch = parseProGrantVoucherExport(parsed);
    if (pendingProGrantVoucherExport && pendingProGrantVoucherExport.applied !== true) {
      const { applied: _applied, ...pendingBatch } = pendingProGrantVoucherExport;
      if (
        pendingBatch.requestId !== batch.requestId ||
        JSON.stringify(pendingBatch) !== JSON.stringify(batch)
      ) {
        throw new Error(
          `${pendingProGrantVoucherExport.campaign.title}의 코드 파일이 이미 적용 대기 중이에요.`,
        );
      }
    }
    await loadProGrantCampaignStatus();
    const existing = proGrantCampaigns.find(
      (entry) => (entry.campaign || entry).slug === batch.campaign.slug,
    );
    const existingCampaign = existing?.campaign || existing;
    if (existingCampaign && ['ended', 'revoked'].includes(existingCampaign.status)) {
      throw new Error('이미 종료된 이벤트에는 코드 파일을 불러올 수 없어요.');
    }
    if (!sameImportedCampaign(existing, batch.campaign)) {
      throw new Error('서버에 저장된 이벤트 정보와 코드 파일이 일치하지 않아요.');
    }
    const existingRoomCodes = proGrantCampaignRoomCodes(existing);
    if (
      existingRoomCodes.length > 0 &&
      (existingRoomCodes.length !== batch.vouchers.length ||
        existingRoomCodes.some((roomCode, index) => roomCode !== batch.vouchers[index].roomCode))
    ) {
      throw new Error('서버에 저장된 방 범위와 코드 파일이 일치하지 않아요.');
    }
    pendingProGrantVoucherExport = batch;
    proGrantCampaignDraft = {
      campaign: {
        ...batch.campaign,
        status: existingCampaign?.status || 'not-created',
        roomStartCode: batch.pool.firstRoomCode,
        roomCount: batch.pool.roomCount,
      },
      counts: existing?.counts || {},
      pool: { ...batch.pool },
      roomCodes: batch.vouchers.map((voucher) => voucher.roomCode),
      roomLabelPrefix: batch.roomLabelPrefix,
      isDraft: true,
    };
    selectedProGrantCampaignSlug = batch.campaign.slug;
    proGrantCampaignState = proGrantCampaignDraft;
    verifiedProGrantPool = null;
    closeProGrantCampaignForm();
    renderProGrantCampaignState(proGrantCampaignDraft);
    setProGrantCampaignMessage(
      `${batch.campaign.title}의 코드 ${formatter.format(batch.vouchers.length)}개를 메모리에 불러왔어요. 3단계에서 동일 배치를 안전하게 이어갈 수 있어요.`,
    );
  } finally {
    setProGrantCampaignBusy(false);
  }
}

function downloadProGrantVoucherExport(batch = pendingProGrantVoucherExport) {
  if (!batch) return false;
  const blob = new Blob([`${JSON.stringify(batch, null, 2)}\n`], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = proGrantVoucherFilename(batch);
  link.rel = 'noopener';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

async function copyProGrantVoucherExport(batch = pendingProGrantVoucherExport) {
  if (!batch || !navigator.clipboard?.writeText) return false;
  const text = batch.vouchers.map((voucher) => `${voucher.roomCode}\t${voucher.code}`).join('\n');
  await navigator.clipboard.writeText(text);
  return true;
}

function classifyProGrantRoomInventory(payload, roomCodes) {
  if (!payload || !Array.isArray(payload.rooms)) {
    throw new Error('PRO room inventory response is invalid.');
  }
  const requested = new Set(roomCodes);
  const found = new Map();
  for (const room of payload.rooms) {
    if (!requested.has(room?.roomCode)) continue;
    if (
      found.has(room.roomCode) ||
      !Number.isSafeInteger(room.roomGeneration) ||
      room.roomGeneration < 0 ||
      typeof room.status !== 'string' ||
      !['unactivated', 'active'].includes(room.activationState)
    ) {
      throw new Error('PRO room inventory contains an invalid room record.');
    }
    found.set(room.roomCode, room);
  }
  const ready = [];
  const needsProvisioning = [];
  const unavailable = [];
  for (const roomCode of roomCodes) {
    const room = found.get(roomCode);
    if (!room) {
      needsProvisioning.push({ roomCode, reason: 'missing' });
    } else if (room.status === 'registered' && room.activationState === 'unactivated') {
      ready.push(room);
    } else if (room.status === 'provisioning' && room.activationState === 'unactivated') {
      needsProvisioning.push({ roomCode, reason: 'provisioning' });
    } else {
      unavailable.push(room);
    }
  }
  return { ready, needsProvisioning, unavailable };
}

async function loadProGrantRoomInventory(roomCodes) {
  return classifyProGrantRoomInventory(await fetchJson('/api/admin/pro-rooms'), roomCodes);
}

function validateAsamoProvisionedRoom(payload, roomCode, label) {
  const room = payload?.room;
  if (
    room?.roomCode !== roomCode ||
    room?.label !== label ||
    !Number.isSafeInteger(room?.roomGeneration) ||
    room.roomGeneration < 0 ||
    room.status !== 'registered' ||
    room.activationState !== 'unactivated'
  ) {
    throw new Error(`PRO room ${roomCode} provisioning response is invalid.`);
  }
  return room;
}

async function mapProGrantRoomPool(items, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(PRO_GRANT_ROOM_PROVISION_CONCURRENCY, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await operation(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function provisionProGrantRoomPool(config) {
  const before = await loadProGrantRoomInventory(config.roomCodes);
  if (before.unavailable.length > 0) {
    return { replayOnly: true, inventory: before, rooms: [] };
  }
  const rooms = await mapProGrantRoomPool(config.roomCodes, async (roomCode) => {
    const label = `${String(config.roomLabelPrefix).slice(0, 55)} · ${roomCode}`;
    return validateAsamoProvisionedRoom(
      await fetchJson('/api/admin/pro-rooms', {
        method: 'POST',
        body: JSON.stringify({ roomCode, label }),
      }),
      roomCode,
      label,
    );
  });
  const after = await loadProGrantRoomInventory(config.roomCodes);
  if (
    after.ready.length !== config.roomCodes.length ||
    after.needsProvisioning.length > 0 ||
    after.unavailable.length > 0
  ) {
    throw new Error('이벤트 방 번호가 모두 안전한 미활성 상태로 준비되지 않았어요.');
  }
  return { replayOnly: false, inventory: after, rooms };
}

function mountProGrantCampaignPanel() {
  const registerPanel = document.querySelector('.pro-room-register-panel');
  if (!registerPanel || document.querySelector('[data-pro-grant-campaign]')) return;
  const panel = document.createElement('section');
  panel.className = 'panel pro-grant-campaign-panel';
  panel.dataset.proGrantCampaign = '';
  panel.innerHTML = `
    <div class="panel-head pro-grant-campaign-head">
      <div>
        <h2>PRO 이벤트</h2>
        <p>이벤트를 만들고, 리딤 현황과 공개 상태를 한곳에서 관리해요.</p>
      </div>
      <div class="pro-grant-head-actions">
        <button class="is-secondary" type="button" data-pro-grant-import>코드 파일 불러오기</button>
        <button class="is-secondary" type="button" data-pro-grant-new>새 이벤트</button>
        <input data-pro-grant-import-input type="file" accept="application/json,.json" hidden>
      </div>
    </div>
    <form class="pro-grant-campaign-form" data-pro-grant-create-form hidden>
      <div class="pro-grant-form-heading">
        <div>
          <h3>새 이벤트</h3>
          <p>저장하기 전에 방 범위가 겹치지 않는지 안전하게 검사해요.</p>
        </div>
        <button class="is-quiet" type="button" data-pro-grant-form-cancel>닫기</button>
      </div>
      <div class="pro-grant-form-grid">
        <label class="pro-room-field pro-grant-form-wide">
          <span>이벤트 이름</span>
          <input name="title" maxlength="80" autocomplete="off" placeholder="MUSIXQUARE 아사모 이벤트" required>
        </label>
        <label class="pro-room-field">
          <span>URL 이름</span>
          <input name="slug" maxlength="48" inputmode="url" autocomplete="off" placeholder="asamo-1" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required>
          <small>musixquare.com/events/<b data-pro-grant-slug-preview>event</b>/</small>
        </label>
        <label class="pro-room-field">
          <span>첫 방 번호</span>
          <input name="roomStartCode" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="000200" pattern="0[0-9]{5}" required>
        </label>
        <label class="pro-room-field">
          <span>방 개수</span>
          <input name="roomCount" type="number" min="1" max="${PRO_GRANT_MAX_CAMPAIGN_ROOMS}" value="50" required>
        </label>
        <label class="pro-room-field">
          <span>시작</span>
          <input name="startsAt" type="datetime-local" required>
        </label>
        <label class="pro-room-field">
          <span>자동 종료 (선택)</span>
          <input name="endsAt" type="datetime-local">
        </label>
      </div>
      <p class="pro-grant-range-preview" data-pro-grant-range-preview>첫 방 번호와 개수를 입력해 주세요.</p>
      <button type="submit">이벤트 검토하기</button>
    </form>
    <div class="pro-grant-campaign-layout">
      <div class="pro-grant-campaign-list" data-pro-grant-list aria-label="이벤트 목록"></div>
      <section class="pro-grant-campaign-detail" data-pro-grant-detail>
        <div class="pro-grant-detail-head">
          <div>
            <h3 data-pro-grant-title>이벤트를 선택해 주세요</h3>
            <p data-pro-grant-meta>목록에서 이벤트를 선택하거나 새로 만들 수 있어요.</p>
          </div>
          <span class="pro-grant-campaign-state" data-pro-grant-state>불러오는 중</span>
        </div>
        <div class="pro-grant-event-link" data-pro-grant-event-link hidden>
          <a target="_blank" rel="noopener"></a>
          <button class="is-secondary" type="button" data-pro-grant-link-copy>주소 복사</button>
        </div>
        <div class="pro-grant-campaign-summary" data-pro-grant-counts>이벤트 상태를 불러오고 있어요.</div>
        <ol class="pro-grant-workflow" aria-label="이벤트 생성 순서">
          <li><strong>방 번호 확인</strong><span>다른 이벤트 또는 활성 방과 겹치지 않는지 검사해요.</span></li>
          <li><strong>코드 보관</strong><span>원문 코드 파일을 먼저 안전한 곳에 저장해요.</span></li>
          <li><strong>이벤트 시작</strong><span>저장한 코드 파일과 동일한 배치만 서버에 한 번 적용해요.</span></li>
        </ol>
        <div class="pro-grant-campaign-actions pro-grant-workflow-actions">
          <button class="is-secondary" type="button" data-pro-grant-verify>1. 방 번호 확인</button>
          <button type="button" data-pro-grant-create disabled>2. 코드 파일 만들기</button>
          <button type="button" data-pro-grant-apply disabled>3. 이벤트 시작</button>
        </div>
        <div class="pro-grant-campaign-export" data-pro-grant-export hidden>
          <strong>원문 코드가 이 브라우저 메모리에 있어요.</strong>
          <p>서버에서는 코드 원문을 다시 보여주지 않아요. 페이지를 닫기 전에 다운로드 파일을 안전하게 보관해 주세요.</p>
          <div>
            <button class="is-secondary" type="button" data-pro-grant-download>파일 다시 받기</button>
            <button class="is-secondary" type="button" data-pro-grant-copy>방 번호 + 코드 복사</button>
          </div>
        </div>
        <div class="pro-grant-lifecycle">
          <div class="pro-grant-lifecycle-section">
            <div><strong>공개 제어</strong><p>일시 중지는 나중에 다시 시작할 수 있어요.</p></div>
            <button class="is-secondary" type="button" data-pro-grant-pause disabled>일시 중지</button>
          </div>
          <div class="pro-grant-lifecycle-section is-danger-zone">
            <div><strong>이벤트 종료</strong><p>종료는 미사용 코드를 보존하고, 폐기는 남은 코드를 영구 무효화해요. 이미 받은 PRO 방은 바뀌지 않아요.</p></div>
            <div>
              <button class="is-secondary" type="button" data-pro-grant-end disabled>이벤트 종료</button>
              <button class="is-danger" type="button" data-pro-grant-revoke disabled>미사용 코드 폐기</button>
            </div>
          </div>
        </div>
      </section>
    </div>
    <p class="pro-room-status" role="status" aria-live="polite" data-pro-grant-status></p>
  `;
  registerPanel.insertAdjacentElement('afterend', panel);
  proGrantCampaignPanelEl = panel;
  proGrantCampaignListEl = panel.querySelector('[data-pro-grant-list]');
  proGrantCampaignDetailEl = panel.querySelector('[data-pro-grant-detail]');
  proGrantCampaignTitleEl = panel.querySelector('[data-pro-grant-title]');
  proGrantCampaignMetaEl = panel.querySelector('[data-pro-grant-meta]');
  proGrantCampaignEventLinkEl = panel.querySelector('[data-pro-grant-event-link]');
  proGrantCampaignStateEl = panel.querySelector('[data-pro-grant-state]');
  proGrantCampaignStatusEl = panel.querySelector('[data-pro-grant-status]');
  proGrantCampaignCountsEl = panel.querySelector('[data-pro-grant-counts]');
  proGrantCampaignNewBtn = panel.querySelector('[data-pro-grant-new]');
  proGrantCampaignImportBtn = panel.querySelector('[data-pro-grant-import]');
  proGrantCampaignImportInput = panel.querySelector('[data-pro-grant-import-input]');
  proGrantCampaignFormEl = panel.querySelector('[data-pro-grant-create-form]');
  proGrantCampaignFormCancelBtn = panel.querySelector('[data-pro-grant-form-cancel]');
  proGrantCampaignVerifyBtn = panel.querySelector('[data-pro-grant-verify]');
  proGrantCampaignCreateBtn = panel.querySelector('[data-pro-grant-create]');
  proGrantCampaignApplyBtn = panel.querySelector('[data-pro-grant-apply]');
  proGrantCampaignPauseBtn = panel.querySelector('[data-pro-grant-pause]');
  proGrantCampaignEndBtn = panel.querySelector('[data-pro-grant-end]');
  proGrantCampaignRevokeBtn = panel.querySelector('[data-pro-grant-revoke]');
  proGrantCampaignExportEl = panel.querySelector('[data-pro-grant-export]');
  proGrantCampaignDownloadBtn = panel.querySelector('[data-pro-grant-download]');
  proGrantCampaignCopyBtn = panel.querySelector('[data-pro-grant-copy]');
  proGrantCampaignLinkCopyBtn = panel.querySelector('[data-pro-grant-link-copy]');
}

function setStatus(message, isError = false) {
  if (!loginStatus) return;
  loginStatus.textContent = message || '';
  loginStatus.classList.toggle('is-error', isError);
}

function setLoginFormDisabled(disabled) {
  if (!loginForm) return;
  for (const control of loginForm.elements) {
    control.disabled = disabled;
  }
  if (disabled) loginForm.setAttribute('aria-busy', 'true');
  else loginForm.removeAttribute('aria-busy');
}

function adminRequestError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function invalidateAdminSession() {
  adminSessionEpoch += 1;
  for (const controller of adminRequestControllers) controller.abort();
  adminRequestControllers.clear();
  for (const controller of adminLatestLoads.values()) controller.abort();
  adminLatestLoads.clear();
}

function beginAdminSession() {
  invalidateAdminSession();
  return adminSessionEpoch;
}

function beginLatestAdminLoad(key) {
  adminLatestLoads.get(key)?.abort();
  const controller = new AbortController();
  adminLatestLoads.set(key, controller);
  return {
    key,
    controller,
    sessionEpoch: adminSessionEpoch,
  };
}

function isLatestAdminLoad(load) {
  return (
    load?.sessionEpoch === adminSessionEpoch &&
    adminLatestLoads.get(load.key) === load.controller &&
    !load.controller.signal.aborted
  );
}

function finishLatestAdminLoad(load) {
  if (adminLatestLoads.get(load.key) === load.controller) {
    adminLatestLoads.delete(load.key);
  }
}

function throwIfAdminLoadStale(load) {
  if (!isLatestAdminLoad(load)) {
    throw adminRequestError('ADMIN_REQUEST_CANCELLED', 'Request cancelled.');
  }
}

async function readAdminResponseText(response, maxBytes = ADMIN_RESPONSE_MAX_BYTES) {
  const contentLength = response.headers.get('Content-Length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw adminRequestError(
        'ADMIN_RESPONSE_TOO_LARGE',
        'The server returned an unexpectedly large response.',
      );
    }
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw adminRequestError(
        'ADMIN_RESPONSE_TOO_LARGE',
        'The server returned an unexpectedly large response.',
      );
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw adminRequestError(
          'ADMIN_RESPONSE_TOO_LARGE',
          'The server returned an unexpectedly large response.',
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function fetchJson(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const {
    headers: optionHeaders = {},
    signal: callerSignal,
    timeoutMs = ADMIN_REQUEST_TIMEOUT_MS,
    maxResponseBytes = ADMIN_RESPONSE_MAX_BYTES,
    sessionBound = url !== '/api/admin/login' && url !== '/api/admin/session',
    ...requestOptions
  } = options;
  const requestEpoch = adminSessionEpoch;
  const controller = new AbortController();
  adminRequestControllers.add(controller);
  const onCallerAbort = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  let timedOut = false;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...requestOptions,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(!['GET', 'HEAD'].includes(method) ? { 'X-MXQR-Admin-CSRF': '1' } : {}),
        ...optionHeaders,
      },
    });
    const text = await readAdminResponseText(response, maxResponseBytes);
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw adminRequestError('ADMIN_RESPONSE_INVALID', 'The server returned invalid JSON.');
      }
    }
    if (sessionBound && requestEpoch !== adminSessionEpoch) {
      throw adminRequestError('ADMIN_REQUEST_CANCELLED', 'Request cancelled.');
    }
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
  } catch (error) {
    if (Number.isInteger(error?.status)) throw error;
    if (controller.signal.aborted || error?.name === 'AbortError') {
      if (timedOut) {
        const isMutation = !['GET', 'HEAD'].includes(method);
        throw adminRequestError(
          isMutation ? 'ADMIN_MUTATION_OUTCOME_UNKNOWN' : 'ADMIN_REQUEST_TIMEOUT',
          isMutation
            ? 'Request timed out. The change may have completed; refresh before retrying.'
            : 'Request timed out. Refresh and try again.',
          error,
        );
      }
      throw adminRequestError('ADMIN_REQUEST_CANCELLED', 'Request cancelled.', error);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    callerSignal?.removeEventListener('abort', onCallerAbort);
    adminRequestControllers.delete(controller);
  }
}

function showLogin(message = '', { invalidateSession = true } = {}) {
  if (invalidateSession) invalidateAdminSession();
  closeServiceStatusDialog({ restoreFocus: false, force: true });
  closeProRoomDestroyDialog({ restoreFocus: false });
  closeProRoomLegacyOwnerDetachDialog({ restoreFocus: false });
  closeProRoomTransferDialog({ restoreFocus: false });
  clearProRoomClaimState();
  clearAllProRoomApiSecrets();
  expandedProRooms.clear();
  proRoomApiCache.clear();
  proRoomApiRequestGenerations.clear();
  proRoomsLoaded = false;
  proGrantCampaignLoaded = false;
  proGrantCampaignState = null;
  proGrantCampaigns = [];
  selectedProGrantCampaignSlug = null;
  proGrantCampaignDraft = null;
  verifiedProGrantPool = null;
  pendingProGrantVoucherExport = null;
  renderProGrantCampaignState(null);
  articlesLoaded = false;
  announcementLoaded = false;
  currentAnnouncementRevision = null;
  pendingAnnouncementMutation = null;
  setAnnouncementMutationBusy(false);
  serviceStatusLoaded = false;
  currentServiceStatus = null;
  serviceStatusRequestId = null;
  setAnnouncementActiveIndicator(false);
  renderServiceStatusUnavailable('');
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

function normalizeServiceStatusPayload(payload) {
  const value = payload?.serviceStatus;
  const revision = Number(value?.revision);
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.enabled !== 'boolean' ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw adminRequestError(
      'ADMIN_SERVICE_STATUS_INVALID',
      'The server returned an invalid service status.',
    );
  }
  const normalizeTimestamp = (timestamp) => {
    if (typeof timestamp !== 'string' || !timestamp) return null;
    return Number.isNaN(new Date(timestamp).getTime()) ? null : timestamp;
  };
  return {
    enabled: value.enabled,
    revision,
    updatedAt: normalizeTimestamp(value.updatedAt),
    activatedAt: normalizeTimestamp(value.activatedAt),
    settlesAt: normalizeTimestamp(value.settlesAt),
  };
}

function clearServiceStatusSettleTimer() {
  if (serviceStatusSettleTimer !== null) {
    window.clearTimeout(serviceStatusSettleTimer);
    serviceStatusSettleTimer = null;
  }
}

function isServiceStatusSettling(status = currentServiceStatus) {
  if (!status?.settlesAt) return false;
  const settlesAtMs = new Date(status.settlesAt).getTime();
  return Number.isFinite(settlesAtMs) && settlesAtMs > Date.now();
}

function serviceStatusStateName(status = currentServiceStatus) {
  if (!status) return 'unknown';
  if (isServiceStatusSettling(status)) return status.enabled ? 'activating' : 'resuming';
  return status.enabled ? 'maintenance' : 'operational';
}

function scheduleServiceStatusSettlement(status) {
  clearServiceStatusSettleTimer();
  if (!isServiceStatusSettling(status)) return;
  const settlesAtMs = new Date(status.settlesAt).getTime();
  const checkSettlement = () => {
    const remainingMs = settlesAtMs - Date.now();
    if (remainingMs > 0) {
      serviceStatusSettleTimer = window.setTimeout(
        checkSettlement,
        Math.min(remainingMs + 50, 2_147_000_000),
      );
      return;
    }
    serviceStatusSettleTimer = null;
    if (currentServiceStatus?.revision !== status.revision) return;
    renderServiceStatus(currentServiceStatus);
    if (currentServiceStatus.enabled) {
      if (updatedAtEl) {
        const statusTime = currentServiceStatus.activatedAt || currentServiceStatus.updatedAt;
        updatedAtEl.textContent = `Maintenance active${
          statusTime ? ` since ${formatAdminDateTime(statusTime)}` : ''
        }`;
      }
    } else if (!dashboard?.hidden) {
      refreshAllDashboardData().catch((error) => {
        if (updatedAtEl) updatedAtEl.textContent = adminErrorMessage(error, 'Refresh failed.');
      });
    }
  };
  checkSettlement();
}

function renderServiceStatusUnavailable(message = 'Service status unavailable.') {
  clearServiceStatusSettleTimer();
  serviceStatusLoaded = false;
  currentServiceStatus = null;
  const state = 'unknown';
  for (const element of [serviceStatusTrigger, serviceStatusDot, serviceStatusDialog]) {
    if (element) element.dataset.state = state;
  }
  if (serviceStatusLabel) serviceStatusLabel.textContent = 'Status unavailable';
  if (serviceStatusTrigger)
    serviceStatusTrigger.setAttribute('aria-label', 'Service status unavailable');
  if (serviceStatusStateEl) serviceStatusStateEl.textContent = 'Status unavailable';
  if (serviceStatusDescriptionEl) {
    serviceStatusDescriptionEl.textContent =
      'The current service state could not be verified. Refresh before making a change.';
  }
  if (serviceStatusUpdatedAtEl) serviceStatusUpdatedAtEl.textContent = '';
  if (serviceStatusErrorEl) {
    serviceStatusErrorEl.textContent = message;
    serviceStatusErrorEl.hidden = !message;
  }
  if (serviceStatusConfirmBtn) serviceStatusConfirmBtn.disabled = true;
}

function renderServiceStatus(status) {
  currentServiceStatus = status;
  serviceStatusLoaded = true;
  serviceStatusRequestId = null;
  const state = serviceStatusStateName(status);
  const settling = isServiceStatusSettling(status);
  const label =
    state === 'activating'
      ? 'Activating...'
      : state === 'resuming'
        ? 'Resuming...'
        : status.enabled
          ? 'Maintenance'
          : 'Operational';
  for (const element of [serviceStatusTrigger, serviceStatusDot, serviceStatusDialog]) {
    if (element) element.dataset.state = state;
  }
  if (serviceStatusLabel) serviceStatusLabel.textContent = label;
  if (serviceStatusTrigger) {
    serviceStatusTrigger.setAttribute(
      'aria-label',
      state === 'activating'
        ? 'Service status: activating maintenance mode'
        : state === 'resuming'
          ? 'Service status: resuming service'
          : status.enabled
            ? 'Service status: maintenance active'
            : 'Service status: operational',
    );
  }
  if (serviceStatusStateEl) {
    serviceStatusStateEl.textContent =
      state === 'activating'
        ? 'Activating maintenance...'
        : state === 'resuming'
          ? 'Resuming service...'
          : status.enabled
            ? 'Maintenance active'
            : 'Operational';
  }
  if (serviceStatusDescriptionEl) {
    serviceStatusDescriptionEl.textContent =
      state === 'activating'
        ? 'The new-traffic gate is propagating across App, API, Signaling, and PRO services.'
        : state === 'resuming'
          ? 'Public traffic is resuming. Some edge requests may remain unavailable for a moment.'
          : status.enabled
            ? 'New public app, API, Signaling, and PRO traffic is blocked. Direct uploads authorized earlier may still finish.'
            : 'MUSIXQUARE is available. Enter maintenance mode to block new public traffic.';
  }
  const statusTime = status.enabled ? status.activatedAt || status.updatedAt : status.updatedAt;
  if (serviceStatusUpdatedAtEl) {
    serviceStatusUpdatedAtEl.textContent = settling
      ? `${status.enabled ? 'Traffic gate propagates by' : 'Public traffic resumes by'} ${formatAdminDateTime(status.settlesAt)}`
      : statusTime
        ? `${status.enabled ? 'Active since' : 'Last changed'} ${formatAdminDateTime(statusTime)}`
        : '';
  }
  if (serviceStatusErrorEl) {
    serviceStatusErrorEl.textContent = '';
    serviceStatusErrorEl.hidden = true;
  }
  if (serviceStatusConfirmBtn) {
    serviceStatusConfirmBtn.textContent = status.enabled
      ? 'End maintenance mode'
      : 'Enter maintenance mode';
    serviceStatusConfirmBtn.dataset.action = status.enabled ? 'end' : 'enter';
    serviceStatusConfirmBtn.disabled = serviceStatusBusy || settling;
  }
  scheduleServiceStatusSettlement(status);
}

function setServiceStatusBusy(busy, targetEnabled = null) {
  serviceStatusBusy = busy;
  const busyContainer = serviceStatusForm || serviceStatusDialog;
  if (busyContainer) {
    if (busy) busyContainer.setAttribute('aria-busy', 'true');
    else busyContainer.removeAttribute('aria-busy');
  }
  if (serviceStatusTrigger) serviceStatusTrigger.disabled = busy;
  for (const button of serviceStatusCancelBtns) button.disabled = busy;
  if (serviceStatusConfirmBtn) {
    serviceStatusConfirmBtn.disabled =
      busy || !serviceStatusLoaded || isServiceStatusSettling(currentServiceStatus);
    if (busy) {
      serviceStatusConfirmBtn.textContent = targetEnabled ? 'Entering...' : 'Ending...';
    } else if (currentServiceStatus) {
      serviceStatusConfirmBtn.textContent = currentServiceStatus.enabled
        ? 'End maintenance mode'
        : 'Enter maintenance mode';
    }
  }
}

function finishServiceStatusDialogClose() {
  const restoreFocus = serviceStatusRestoreFocus;
  serviceStatusRestoreFocus = null;
  if (serviceStatusErrorEl) {
    serviceStatusErrorEl.textContent = '';
    serviceStatusErrorEl.hidden = true;
  }
  if (restoreFocus?.isConnected) restoreFocus.focus();
}

function closeServiceStatusDialog({ restoreFocus = true, force = false } = {}) {
  if (!serviceStatusDialog || (serviceStatusBusy && !force)) return;
  if (!restoreFocus) serviceStatusRestoreFocus = null;
  if (!serviceStatusDialog.open && !serviceStatusDialog.hasAttribute('open')) {
    finishServiceStatusDialogClose();
    return;
  }
  if (typeof serviceStatusDialog.close === 'function') {
    try {
      serviceStatusDialog.close();
      return;
    } catch {
      // Lightweight DOM implementations may not implement the full dialog API.
    }
  }
  serviceStatusDialog.removeAttribute('open');
  serviceStatusDialog.dispatchEvent(new Event('close'));
}

async function loadServiceStatus(options = {}) {
  const load = beginLatestAdminLoad('service-status');
  if (!serviceStatusLoaded && serviceStatusLabel) serviceStatusLabel.textContent = 'Checking...';
  try {
    const payload = await fetchJson('/api/admin/service-status', {
      signal: load.controller.signal,
    });
    throwIfAdminLoadStale(load);
    const status = normalizeServiceStatusPayload(payload);
    renderServiceStatus(status);
    if (options.updateTimestamp !== false && updatedAtEl) {
      const statusTime = status.enabled ? status.activatedAt || status.updatedAt : status.updatedAt;
      const state = serviceStatusStateName(status);
      updatedAtEl.textContent =
        state === 'activating'
          ? `Activating maintenance - traffic gate propagates by ${formatAdminDateTime(status.settlesAt)}`
          : state === 'resuming'
            ? `Resuming service - public traffic resumes by ${formatAdminDateTime(status.settlesAt)}`
            : status.enabled
              ? `Maintenance active${statusTime ? ` since ${formatAdminDateTime(statusTime)}` : ''}`
              : `Updated ${formatAdminDateTime(payload.generatedAt || Date.now())}`;
    }
    return status;
  } catch (error) {
    if (isLatestAdminLoad(load)) {
      renderServiceStatusUnavailable(adminErrorMessage(error, 'Service status refresh failed.'));
    }
    throw error;
  } finally {
    finishLatestAdminLoad(load);
  }
}

async function openServiceStatusDialog(trigger = serviceStatusTrigger) {
  if (!serviceStatusDialog || serviceStatusBusy) return;
  serviceStatusRestoreFocus = trigger;
  if (typeof serviceStatusDialog.showModal === 'function') {
    try {
      serviceStatusDialog.showModal();
    } catch {
      serviceStatusDialog.setAttribute('open', '');
    }
  } else {
    serviceStatusDialog.setAttribute('open', '');
  }
  if (serviceStatusErrorEl) {
    serviceStatusErrorEl.textContent = '';
    serviceStatusErrorEl.hidden = true;
  }
  try {
    await loadServiceStatus({ updateTimestamp: false });
  } catch (error) {
    if (serviceStatusErrorEl) {
      serviceStatusErrorEl.textContent = adminErrorMessage(error, 'Service status refresh failed.');
      serviceStatusErrorEl.hidden = false;
    }
  }
  if (serviceStatusLoaded && serviceStatusConfirmBtn && !serviceStatusConfirmBtn.disabled) {
    serviceStatusConfirmBtn.focus();
  } else serviceStatusCancelBtns[0]?.focus();
}

function abortNonStatusDashboardLoads() {
  for (const key of ['metrics', 'pro-rooms', 'articles', 'announcement']) {
    adminLatestLoads.get(key)?.abort();
  }
}

async function saveServiceStatus() {
  if (!currentServiceStatus || !serviceStatusLoaded || serviceStatusBusy) return;
  const previous = currentServiceStatus;
  const targetEnabled = !previous.enabled;
  const requestId = serviceStatusRequestId || createAdminRequestId();
  serviceStatusRequestId = requestId;
  setServiceStatusBusy(true, targetEnabled);
  if (serviceStatusErrorEl) {
    serviceStatusErrorEl.textContent = '';
    serviceStatusErrorEl.hidden = true;
  }
  try {
    const payload = await fetchJson('/api/admin/service-status', {
      method: 'POST',
      body: JSON.stringify({
        enabled: targetEnabled,
        expectedRevision: previous.revision,
        requestId,
      }),
    });
    const next = normalizeServiceStatusPayload(payload);
    if (next.enabled !== targetEnabled) {
      throw adminRequestError(
        'ADMIN_SERVICE_STATUS_MISMATCH',
        'The service returned an unexpected state. Refresh before retrying.',
      );
    }
    renderServiceStatus(next);
    if (targetEnabled) {
      abortNonStatusDashboardLoads();
    }
    if (updatedAtEl) {
      const state = serviceStatusStateName(next);
      const statusTime = next.activatedAt || next.updatedAt;
      updatedAtEl.textContent =
        state === 'activating'
          ? `Activating maintenance - traffic gate propagates by ${formatAdminDateTime(next.settlesAt)}`
          : state === 'resuming'
            ? `Resuming service - public traffic resumes by ${formatAdminDateTime(next.settlesAt)}`
            : next.enabled
              ? `Maintenance active${statusTime ? ` since ${formatAdminDateTime(statusTime)}` : ''}`
              : `Updated ${formatAdminDateTime(next.updatedAt || Date.now())}`;
    }
    setServiceStatusBusy(false);
    closeServiceStatusDialog();
    if (!targetEnabled && !isServiceStatusSettling(next)) await refreshAllDashboardData();
    return next;
  } catch (error) {
    const responseStatus = error?.payload?.serviceStatus;
    if (responseStatus) {
      try {
        renderServiceStatus(normalizeServiceStatusPayload({ serviceStatus: responseStatus }));
      } catch {
        // A malformed conflict payload must not replace the last verified state.
      }
    }
    if (
      error?.code === 'ADMIN_MUTATION_OUTCOME_UNKNOWN' ||
      error?.message === 'SERVICE_STATUS_REVISION_MISMATCH' ||
      error?.message === 'SERVICE_STATUS_CONFLICT'
    ) {
      try {
        await loadServiceStatus({ updateTimestamp: false });
      } catch {
        // Keep the original mutation error as the actionable message.
      }
    } else {
      serviceStatusRequestId = null;
    }
    if (serviceStatusErrorEl) {
      serviceStatusErrorEl.textContent = adminErrorMessage(
        error,
        'The service state could not be changed.',
      );
      serviceStatusErrorEl.hidden = false;
    }
    throw error;
  } finally {
    setServiceStatusBusy(false);
  }
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
  if (message === 'SERVICE_STATUS_REVISION_MISMATCH' || message === 'SERVICE_STATUS_CONFLICT') {
    return 'Service status changed in another session. The latest state has been loaded.';
  }
  if (message === 'SERVICE_STATUS_AUDIT_UNAVAILABLE') {
    return 'The change was withheld because the service-status audit is unavailable.';
  }
  if (message === 'SERVICE_STATUS_UNAVAILABLE' || message === 'SERVICE_CONTROL_UNAVAILABLE') {
    return 'Service status is temporarily unavailable.';
  }
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
  if (message === 'PRO_ROOM_LEGACY_OWNER_DETACH_INTENT_MISMATCH') {
    return 'This repair was started with a different retained room. Retry with the exact same retained room number.';
  }
  if (message === 'PRO_ROOM_OWNER_DETACH_AUDIT_PENDING') {
    return 'The owner repair is awaiting its completion audit. Keep this page open and retry the exact same repair; retrying is safe.';
  }
  if (message === 'ADMIN_ANNOUNCEMENT_CONFLICT') {
    return 'The announcement changed in another session. The latest state has been loaded.';
  }
  if (message === 'ADMIN_ANNOUNCEMENT_CONTROL_UNAVAILABLE') {
    return 'The announcement control is temporarily unavailable. If this followed a save, keep the page open and retry the same save; retrying is safe.';
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
  if (message === 'OWNER_TRANSFER_TARGET_UNAVAILABLE') {
    return 'That account is missing, disabled, incomplete, or being deleted.';
  }
  if (message === 'PRO_ROOM_OWNER_TRANSFER_RECONCILIATION_REQUIRED') {
    return 'A transfer is already pending. The recipient must retry the same link, or wait for it to expire before issuing another.';
  }
  if (message === 'PRO_ROOM_OWNER_TRANSFER_UNAVAILABLE') {
    return 'Ownership transfer is unavailable in this room state.';
  }
  if (message === 'PRO_ROOM_OWNER_RECOVERY_UNAVAILABLE') {
    return 'Recovery requires the same linked owner account. Use ownership transfer to assign a different or previously unlinked account.';
  }
  if (message === 'PRO_ROOM_OWNERSHIP_RECOVERY_REQUIRED') {
    return 'This room requires ownership recovery and cannot be resumed manually.';
  }
  if (message === 'DEVELOPER_API_ADMIN_NOT_CONFIGURED') {
    return 'Developer API key management is not configured.';
  }
  if (message === 'DEVELOPER_API_ACTIVE_KEY_LIMIT') {
    return 'This room already has three active API keys. Revoke one before issuing another.';
  }
  if (message === 'DEVELOPER_API_AUTHORITY_FENCED') {
    return 'API key issuance is blocked while room ownership is being recovered.';
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
  return 'Analytics';
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

function formatProRoomStatus(
  status,
  suspensionReason = null,
  ownerAccountLinked = null,
  ownerTransferPrepared = false,
) {
  if (status === 'active') {
    if (ownerAccountLinked === false) return 'Ownership transfer required';
    if (ownerAccountLinked !== true) return 'Owner status unavailable';
    return 'Active';
  }
  if (status === 'suspended') {
    if (suspensionReason === 'owner_account_deleted') return 'Ownership transfer required';
    if (suspensionReason === 'ownership_transfer_pending') {
      return ownerTransferPrepared ? 'Transfer pending' : 'Ownership transfer required';
    }
    return 'Suspended';
  }
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
  issuedOwnerTransferLinks.clear();
}

function showProRoomClaim(payload, kind = 'activation', expectedRoomGeneration = null) {
  if (!proRoomClaimEl || !proRoomClaimUrlEl) return;
  const roomCode = normalizeProRoomCode(payload.roomCode);
  const roomGeneration = normalizeProRoomGeneration(payload.roomGeneration);
  const incarnationKey = proRoomIncarnationKey(roomCode, roomGeneration);
  const isRecovery = kind === 'recovery';
  const isTransfer = kind === 'transfer';
  const claimUrl = isTransfer
    ? payload.transferUrl
    : isRecovery
      ? payload.recoveryUrl
      : payload.activationUrl;
  if (
    !roomCode ||
    roomGeneration === null ||
    roomGeneration !== expectedRoomGeneration ||
    !incarnationKey ||
    typeof claimUrl !== 'string' ||
    !claimUrl
  ) {
    throw new Error(
      isTransfer
        ? 'INVALID_OWNER_TRANSFER_LINK'
        : isRecovery
          ? 'INVALID_OWNER_RECOVERY_LINK'
          : 'INVALID_ACTIVATION_LINK',
    );
  }
  if (isTransfer) issuedOwnerTransferLinks.add(incarnationKey);
  else if (isRecovery) issuedOwnerRecoveryLinks.add(incarnationKey);
  else issuedActivationLinks.add(incarnationKey);
  visibleProRoomClaimIncarnation = incarnationKey;
  if (proRoomClaimTitleEl) {
    proRoomClaimTitleEl.textContent = `${roomCode} owner ${
      isTransfer ? 'transfer' : isRecovery ? 'recovery' : 'activation'
    } link`;
  }
  if (proRoomClaimExpiryEl) {
    const expiry = formatAdminDateTime(payload.expiresAt);
    proRoomClaimExpiryEl.textContent = expiry ? `Expires ${expiry}` : 'Short-lived link';
  }
  proRoomClaimUrlEl.value = claimUrl;
  proRoomClaimUrlEl.setAttribute(
    'aria-label',
    isTransfer
      ? 'Owner transfer link'
      : isRecovery
        ? 'Owner recovery link'
        : 'Owner activation link',
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
  issuedOwnerTransferLinks.delete(incarnationKey);
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
    } catch {
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

function resetProRoomLegacyOwnerDetachDialog() {
  if (!proRoomLegacyOwnerDetachDialogElements) return;
  const { dialog, form, retainedInput, targetInput, cancelButton, confirmButton, error } =
    proRoomLegacyOwnerDetachDialogElements;
  const restoreFocus = proRoomLegacyOwnerDetachTarget?.restoreFocus;
  proRoomLegacyOwnerDetachTarget = null;
  form.reset();
  form.removeAttribute('aria-busy');
  retainedInput.disabled = false;
  targetInput.disabled = false;
  cancelButton.disabled = false;
  confirmButton.disabled = true;
  confirmButton.textContent = 'Detach legacy owner';
  error.textContent = '';
  dialog.removeAttribute('data-room-code');
  if (restoreFocus?.isConnected) restoreFocus.focus();
}

function closeProRoomLegacyOwnerDetachDialog({ restoreFocus = true } = {}) {
  if (!proRoomLegacyOwnerDetachDialogElements) return;
  const { dialog } = proRoomLegacyOwnerDetachDialogElements;
  if (!restoreFocus && proRoomLegacyOwnerDetachTarget) {
    proRoomLegacyOwnerDetachTarget.restoreFocus = null;
  }
  if (!dialog.open && !dialog.hasAttribute('open')) {
    resetProRoomLegacyOwnerDetachDialog();
    return;
  }
  if (typeof dialog.close === 'function') {
    try {
      dialog.close();
      return;
    } catch {
      // Lightweight DOM implementations use the attribute fallback.
    }
  }
  dialog.removeAttribute('open');
  dialog.dispatchEvent(new Event('close'));
}

function normalizeProRoomConfirmationInput(input) {
  const digits = String(input?.value || '')
    .replace(/\D/g, '')
    .slice(0, 6);
  if (input && input.value !== digits) input.value = digits;
  return digits;
}

function syncProRoomLegacyOwnerDetachDialog() {
  if (!proRoomLegacyOwnerDetachDialogElements) return;
  const { retainedInput, targetInput, error, confirmButton } =
    proRoomLegacyOwnerDetachDialogElements;
  const retainedRoomCode = normalizeProRoomConfirmationInput(retainedInput);
  const targetRoomCode = normalizeProRoomConfirmationInput(targetInput);
  const expectedTarget = proRoomLegacyOwnerDetachTarget?.roomCode || '';
  error.textContent = '';
  confirmButton.disabled =
    Boolean(proRoomLegacyOwnerDetachTarget?.busy) ||
    !/^0\d{5}$/.test(retainedRoomCode) ||
    retainedRoomCode === expectedTarget ||
    targetRoomCode !== expectedTarget;
}

function setProRoomLegacyOwnerDetachBusy(isBusy) {
  if (!proRoomLegacyOwnerDetachDialogElements) return;
  const { form, retainedInput, targetInput, cancelButton, confirmButton } =
    proRoomLegacyOwnerDetachDialogElements;
  if (isBusy) form.setAttribute('aria-busy', 'true');
  else form.removeAttribute('aria-busy');
  retainedInput.disabled = isBusy;
  targetInput.disabled = isBusy;
  cancelButton.disabled = isBusy;
  confirmButton.textContent = isBusy ? 'Detaching...' : 'Detach legacy owner';
  if (proRoomLegacyOwnerDetachTarget) proRoomLegacyOwnerDetachTarget.busy = isBusy;
  syncProRoomLegacyOwnerDetachDialog();
}

async function detachProRoomLegacyOwner() {
  if (!proRoomLegacyOwnerDetachDialogElements || !proRoomLegacyOwnerDetachTarget) return;
  const { retainedInput, targetInput, error } = proRoomLegacyOwnerDetachDialogElements;
  const target = proRoomLegacyOwnerDetachTarget;
  const retainedRoomCode = normalizeProRoomConfirmationInput(retainedInput);
  const confirmedTargetRoomCode = normalizeProRoomConfirmationInput(targetInput);
  if (
    target.busy ||
    !/^0\d{5}$/.test(retainedRoomCode) ||
    retainedRoomCode === target.roomCode ||
    confirmedTargetRoomCode !== target.roomCode
  ) {
    return;
  }

  setProRoomLegacyOwnerDetachBusy(true);
  error.textContent = '';
  try {
    const payload = await fetchJson(`/api/admin/pro-rooms/${target.roomCode}/legacy-owner-detach`, {
      method: 'POST',
      body: JSON.stringify({
        roomGeneration: target.roomGeneration,
        retainRoomCode: retainedRoomCode,
        confirmRoomCode: target.roomCode,
      }),
    });
    const containsSensitiveOwnerRemovalField = [
      'previousOwnerAccountId',
      'accountId',
      'removalId',
    ].some((key) => Object.prototype.hasOwnProperty.call(payload || {}, key));
    if (
      containsSensitiveOwnerRemovalField ||
      payload?.ok !== true ||
      payload?.roomCode !== target.roomCode ||
      normalizeProRoomGeneration(payload?.roomGeneration) !== target.roomGeneration ||
      payload?.status !== 'suspended' ||
      payload?.suspensionReason !== 'ownership_transfer_pending' ||
      payload?.ownerAccountLinked !== false ||
      payload?.retainedRoomCode !== retainedRoomCode
    ) {
      throw new Error('PRO_ROOM_ADMIN_INVALID_RESPONSE');
    }

    const incarnationKey = proRoomIncarnationKey(target.roomCode, target.roomGeneration);
    if (incarnationKey) {
      issuedOwnerRecoveryLinks.delete(incarnationKey);
      issuedOwnerTransferLinks.delete(incarnationKey);
      proRoomApiCache.delete(incarnationKey);
      clearProRoomApiSecret(target.roomCode, target.roomGeneration);
      if (visibleProRoomClaimIncarnation === incarnationKey) dismissProRoomClaim();
    }
    setProRoomStatus(
      `${target.roomCode} owner authority detached. The room is suspended pending ownership transfer; ${retainedRoomCode} was verified as the retained room when this repair began.`,
    );
    try {
      await loadProRooms();
    } catch {
      proRoomsLoaded = false;
      setProRoomStatus(
        `${target.roomCode} owner authority detached. Refresh the room list before issuing a transfer link.`,
      );
    }
    target.restoreFocus = document.querySelector(
      `[data-pro-room-item="${target.roomCode}"] > summary`,
    );
    closeProRoomLegacyOwnerDetachDialog();
  } catch (detachError) {
    if (proRoomLegacyOwnerDetachTarget !== target) return;
    const safeRetryRequired =
      detachError?.message === 'PRO_ROOM_OWNER_DETACH_RECONCILIATION_REQUIRED' ||
      detachError?.message === 'PRO_ROOM_OWNER_DETACH_AUDIT_PENDING' ||
      detachError?.code === 'ADMIN_MUTATION_OUTCOME_UNKNOWN';
    setProRoomLegacyOwnerDetachBusy(false);
    error.textContent = safeRetryRequired
      ? 'The repair may be incomplete or its result is unknown. Keep this page open and retry the same repair; retrying is safe. Do not refresh.'
      : adminErrorMessage(detachError, 'The legacy owner could not be detached.');
    retainedInput.focus();
  }
}

function ensureProRoomLegacyOwnerDetachDialog() {
  if (proRoomLegacyOwnerDetachDialogElements) return proRoomLegacyOwnerDetachDialogElements;

  const dialog = document.createElement('dialog');
  dialog.className = 'pro-room-owner-detach-dialog';
  dialog.dataset.proRoomOwnerDetachDialog = '';
  dialog.setAttribute('aria-labelledby', 'pro-room-owner-detach-title');
  dialog.setAttribute('aria-describedby', 'pro-room-owner-detach-description');

  const form = document.createElement('form');
  form.className = 'pro-room-owner-detach-form';
  const copy = document.createElement('div');
  copy.className = 'pro-room-owner-detach-copy';
  const eyebrow = document.createElement('span');
  eyebrow.className = 'pro-room-owner-detach-eyebrow';
  eyebrow.textContent = 'Legacy owner repair';
  const title = document.createElement('h2');
  title.id = 'pro-room-owner-detach-title';
  const description = document.createElement('p');
  description.id = 'pro-room-owner-detach-description';
  description.textContent =
    'Use only when a legacy beta account is linked to two PRO rooms. This revokes the target room owner, sessions, PIN, delegated admins, credentials, and API keys, then suspends the room until ownership transfer. The room number, playlist, uploads, and settings stay intact. This does not transfer or delete the room.';
  copy.append(eyebrow, title, description);

  const retainedField = document.createElement('label');
  retainedField.className = 'pro-room-owner-detach-field';
  const retainedLabel = document.createElement('span');
  retainedLabel.textContent = 'Retained room code (same owner)';
  const retainedInput = document.createElement('input');
  retainedInput.type = 'text';
  retainedInput.inputMode = 'numeric';
  retainedInput.maxLength = 6;
  retainedInput.autocomplete = 'off';
  retainedInput.spellcheck = false;
  retainedInput.placeholder = '000001';
  retainedInput.dataset.proRoomOwnerDetachRetained = '';
  retainedInput.setAttribute(
    'aria-describedby',
    'pro-room-owner-detach-description pro-room-owner-detach-note pro-room-owner-detach-error',
  );
  retainedField.append(retainedLabel, retainedInput);

  const targetField = document.createElement('label');
  targetField.className = 'pro-room-owner-detach-field';
  const targetLabel = document.createElement('span');
  targetLabel.dataset.proRoomOwnerDetachTargetLabel = '';
  const targetInput = document.createElement('input');
  targetInput.type = 'text';
  targetInput.inputMode = 'numeric';
  targetInput.maxLength = 6;
  targetInput.autocomplete = 'off';
  targetInput.spellcheck = false;
  targetInput.dataset.proRoomOwnerDetachTarget = '';
  targetInput.setAttribute(
    'aria-describedby',
    'pro-room-owner-detach-description pro-room-owner-detach-note pro-room-owner-detach-error',
  );
  targetField.append(targetLabel, targetInput);

  const note = document.createElement('p');
  note.id = 'pro-room-owner-detach-note';
  note.className = 'pro-room-owner-detach-note';
  note.textContent =
    'The server will verify that both rooms have the same canonical owner. Use ownership transfer after this repair to assign the target room to a different account.';
  const error = document.createElement('p');
  error.id = 'pro-room-owner-detach-error';
  error.className = 'pro-room-owner-detach-error';
  error.dataset.proRoomOwnerDetachError = '';
  error.setAttribute('role', 'alert');
  error.setAttribute('aria-live', 'assertive');

  const actions = document.createElement('div');
  actions.className = 'pro-room-owner-detach-actions';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'is-secondary';
  cancelButton.textContent = 'Cancel';
  cancelButton.dataset.proRoomOwnerDetachCancel = '';
  const confirmButton = document.createElement('button');
  confirmButton.type = 'submit';
  confirmButton.className = 'is-danger';
  confirmButton.textContent = 'Detach legacy owner';
  confirmButton.disabled = true;
  confirmButton.dataset.proRoomOwnerDetachConfirm = '';
  actions.append(cancelButton, confirmButton);

  form.append(copy, retainedField, targetField, note, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  proRoomLegacyOwnerDetachDialogElements = {
    dialog,
    form,
    title,
    targetLabel,
    retainedInput,
    targetInput,
    error,
    cancelButton,
    confirmButton,
  };
  retainedInput.addEventListener('input', syncProRoomLegacyOwnerDetachDialog);
  targetInput.addEventListener('input', syncProRoomLegacyOwnerDetachDialog);
  cancelButton.addEventListener('click', () => closeProRoomLegacyOwnerDetachDialog());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    detachProRoomLegacyOwner().catch(() => {});
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!proRoomLegacyOwnerDetachTarget?.busy) closeProRoomLegacyOwnerDetachDialog();
  });
  dialog.addEventListener('close', resetProRoomLegacyOwnerDetachDialog);
  return proRoomLegacyOwnerDetachDialogElements;
}

function openProRoomLegacyOwnerDetachDialog(roomCode, roomGeneration, trigger) {
  if (normalizeProRoomGeneration(roomGeneration) === null) {
    setProRoomStatus('Room generation is unavailable. Refresh before making changes.', true);
    return;
  }
  const elements = ensureProRoomLegacyOwnerDetachDialog();
  const {
    dialog,
    form,
    title,
    targetLabel,
    retainedInput,
    targetInput,
    error,
    cancelButton,
    confirmButton,
  } = elements;
  proRoomLegacyOwnerDetachTarget = {
    roomCode,
    roomGeneration,
    restoreFocus: trigger,
    busy: false,
  };
  form.reset();
  form.removeAttribute('aria-busy');
  title.textContent = `Detach legacy owner from PRO room ${roomCode}?`;
  targetLabel.textContent = `Enter ${roomCode} to confirm the target room`;
  retainedInput.disabled = false;
  targetInput.disabled = false;
  error.textContent = '';
  cancelButton.disabled = false;
  confirmButton.disabled = true;
  confirmButton.textContent = 'Detach legacy owner';
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
  retainedInput.focus();
}

function resetProRoomTransferDialog() {
  if (!proRoomTransferDialogElements) return;
  const { form, input, error, issueButton } = proRoomTransferDialogElements;
  const restoreFocus = proRoomTransferTarget?.restoreFocus;
  proRoomTransferTarget = null;
  form.reset();
  form.removeAttribute('aria-busy');
  input.disabled = false;
  error.textContent = '';
  issueButton.disabled = false;
  issueButton.textContent = 'Issue transfer link';
  restoreFocus?.focus?.({ preventScroll: true });
}

function closeProRoomTransferDialog({ restoreFocus = true } = {}) {
  if (!proRoomTransferDialogElements) return;
  const { dialog } = proRoomTransferDialogElements;
  if (!restoreFocus && proRoomTransferTarget) proRoomTransferTarget.restoreFocus = null;
  if (!dialog.open && !dialog.hasAttribute('open')) {
    resetProRoomTransferDialog();
    return;
  }
  if (typeof dialog.close === 'function') {
    try {
      dialog.close();
      return;
    } catch {
      // Lightweight DOM implementations use the attribute fallback.
    }
  }
  dialog.removeAttribute('open');
  dialog.dispatchEvent(new Event('close'));
}

function syncProRoomTransferDialog() {
  if (!proRoomTransferDialogElements) return;
  const { input, error, issueButton } = proRoomTransferDialogElements;
  const value = String(input.value || '').trim();
  error.textContent = '';
  const validAccountId = /^acct_[A-Za-z0-9_-]{22}$/.test(value);
  const validNickname =
    value.length >= 1 && value.length <= 128 && Array.from(value.normalize('NFC')).length <= 20;
  issueButton.disabled = Boolean(proRoomTransferTarget?.busy) || !(validAccountId || validNickname);
}

async function issueProRoomOwnerTransfer() {
  if (!proRoomTransferDialogElements || !proRoomTransferTarget) return;
  const { input, error, cancelButton, issueButton, form } = proRoomTransferDialogElements;
  const target = proRoomTransferTarget;
  const targetAccount = String(input.value || '').trim();
  const validAccountId = /^acct_[A-Za-z0-9_-]{22}$/.test(targetAccount);
  const validNickname =
    targetAccount.length >= 1 &&
    targetAccount.length <= 128 &&
    Array.from(targetAccount.normalize('NFC')).length <= 20;
  if (target.busy || !(validAccountId || validNickname)) return;

  target.busy = true;
  form.setAttribute('aria-busy', 'true');
  input.disabled = true;
  cancelButton.disabled = true;
  issueButton.disabled = true;
  issueButton.textContent = 'Issuing...';
  error.textContent = '';
  try {
    const payload = await fetchJson(
      `/api/admin/pro-rooms/${target.roomCode}/owner-transfer-claim`,
      {
        method: 'POST',
        body: JSON.stringify({
          roomGeneration: target.roomGeneration,
          targetAccount,
        }),
      },
    );
    if (
      payload?.roomCode !== target.roomCode ||
      normalizeProRoomGeneration(payload?.roomGeneration) !== target.roomGeneration ||
      !/^acct_[A-Za-z0-9_-]{22}$/.test(payload?.targetAccountId || '') ||
      (validAccountId && payload.targetAccountId !== targetAccount) ||
      typeof payload?.targetNickname !== 'string' ||
      !payload.targetNickname.trim()
    ) {
      throw new Error('PRO_ROOM_GENERATION_MISMATCH');
    }
    closeProRoomTransferDialog({ restoreFocus: false });
    showProRoomClaim(payload, 'transfer', target.roomGeneration);
    setProRoomStatus(
      `${target.roomCode} transfer link issued${
        typeof payload.targetNickname === 'string' && payload.targetNickname
          ? ` for ${payload.targetNickname}`
          : ''
      }.`,
    );
    proRoomClaimUrlEl?.focus({ preventScroll: true });
  } catch (issueError) {
    if (proRoomTransferTarget !== target) return;
    target.busy = false;
    form.removeAttribute('aria-busy');
    input.disabled = false;
    cancelButton.disabled = false;
    issueButton.textContent = 'Issue transfer link';
    syncProRoomTransferDialog();
    error.textContent = adminErrorMessage(
      issueError,
      'The owner transfer link could not be issued.',
    );
    input.focus();
  }
}

function ensureProRoomTransferDialog() {
  if (proRoomTransferDialogElements) return proRoomTransferDialogElements;
  const dialog = document.createElement('dialog');
  dialog.className = 'pro-room-transfer-dialog';
  dialog.setAttribute('aria-labelledby', 'pro-room-transfer-title');
  dialog.setAttribute('aria-describedby', 'pro-room-transfer-description');

  const form = document.createElement('form');
  form.className = 'pro-room-transfer-form';
  const eyebrow = document.createElement('span');
  eyebrow.className = 'pro-room-transfer-eyebrow';
  eyebrow.textContent = 'Ownership transfer';
  const title = document.createElement('h2');
  title.id = 'pro-room-transfer-title';
  const description = document.createElement('p');
  description.id = 'pro-room-transfer-description';
  description.textContent =
    'Bind a one-time link to one active, fully configured MUSIXQUARE account. When redeemed, the old owner is signed out and every existing Developer API key is revoked.';

  const field = document.createElement('label');
  field.className = 'pro-room-transfer-field';
  const fieldLabel = document.createElement('span');
  fieldLabel.textContent = 'Target nickname or account ID';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 128;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Nickname or acct_…';
  input.setAttribute('aria-describedby', 'pro-room-transfer-description pro-room-transfer-error');
  field.append(fieldLabel, input);

  const note = document.createElement('p');
  note.className = 'pro-room-transfer-note';
  note.textContent =
    'Enter the exact unique nickname or immutable account ID. The recipient must sign in to the verified account before opening the link. No account search or suggestions are exposed, and the full link is shown only once.';
  const error = document.createElement('p');
  error.id = 'pro-room-transfer-error';
  error.className = 'pro-room-transfer-error';
  error.setAttribute('role', 'alert');
  error.setAttribute('aria-live', 'assertive');

  const actions = document.createElement('div');
  actions.className = 'pro-room-transfer-actions';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'is-secondary';
  cancelButton.textContent = 'Cancel';
  const issueButton = document.createElement('button');
  issueButton.type = 'submit';
  issueButton.textContent = 'Issue transfer link';
  issueButton.disabled = true;
  actions.append(cancelButton, issueButton);
  form.append(eyebrow, title, description, field, note, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  proRoomTransferDialogElements = {
    dialog,
    form,
    title,
    input,
    error,
    cancelButton,
    issueButton,
  };
  input.addEventListener('input', syncProRoomTransferDialog);
  cancelButton.addEventListener('click', () => closeProRoomTransferDialog());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    issueProRoomOwnerTransfer().catch(() => {});
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!proRoomTransferTarget?.busy) closeProRoomTransferDialog();
  });
  dialog.addEventListener('close', resetProRoomTransferDialog);
  return proRoomTransferDialogElements;
}

function openProRoomTransferDialog(roomCode, roomGeneration, trigger) {
  if (normalizeProRoomGeneration(roomGeneration) === null) {
    setProRoomStatus('Room generation is unavailable. Refresh before making changes.', true);
    return;
  }
  const elements = ensureProRoomTransferDialog();
  const { dialog, form, title, input, error, cancelButton, issueButton } = elements;
  proRoomTransferTarget = {
    roomCode,
    roomGeneration,
    restoreFocus: trigger,
    busy: false,
  };
  form.reset();
  form.removeAttribute('aria-busy');
  title.textContent = `Transfer PRO room ${roomCode}`;
  input.disabled = false;
  error.textContent = '';
  cancelButton.disabled = false;
  issueButton.disabled = true;
  issueButton.textContent = issuedOwnerTransferLinks.has(
    proRoomIncarnationKey(roomCode, roomGeneration),
  )
    ? 'Issue another link'
    : 'Issue transfer link';
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
      status.textContent =
        payload.changed === false ? 'Label is already up to date.' : 'Label saved.';
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
  const suspensionReason =
    typeof room?.suspensionReason === 'string' ? room.suspensionReason : null;
  const ownerAccountLinked =
    rawStatus === 'active' && typeof room?.ownerAccountLinked === 'boolean'
      ? room.ownerAccountLinked
      : null;
  const ownerTransferPrepared = room?.ownerTransferPrepared === true;
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
    rawStatus === 'provisioning' ? null : renderProRoomLabelEditor(room, roomCode, roomGeneration);

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
  } else if (rawStatus === 'active' && ownerAccountLinked === true) {
    activation.textContent = issuedOwnerRecoveryLinks.has(incarnationKey)
      ? 'Issue another owner recovery link'
      : 'Issue owner recovery link';
    activation.title =
      'Recovery works only for the same account already linked as owner. To assign a different or previously unlinked account, use ownership transfer.';
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
  } else if (
    (rawStatus === 'active' && ownerAccountLinked === false) ||
    (rawStatus === 'suspended' &&
      (suspensionReason === 'owner_account_deleted' ||
        (suspensionReason === 'ownership_transfer_pending' && !ownerTransferPrepared)))
  ) {
    activation.textContent = issuedOwnerTransferLinks.has(incarnationKey)
      ? 'Issue another owner transfer link'
      : 'Assign a new owner';
    activation.title =
      'Ownership transfer required. Bind a one-time ownership transfer link to one active MUSIXQUARE account.';
    activation.addEventListener('click', () =>
      openProRoomTransferDialog(roomCode, roomGeneration, activation),
    );
  } else if (rawStatus === 'active') {
    activation.textContent = 'Owner status unavailable';
    activation.title = 'Refresh the room list before issuing an owner-authority link.';
    activation.disabled = true;
  } else if (
    rawStatus === 'suspended' &&
    suspensionReason === 'ownership_transfer_pending' &&
    ownerTransferPrepared
  ) {
    activation.textContent = 'Replace expired transfer link';
    activation.title =
      'If the current transfer is still valid, the service will preserve it. Once it expires, this issues a replacement bound to the account you choose.';
    activation.addEventListener('click', () =>
      openProRoomTransferDialog(roomCode, roomGeneration, activation),
    );
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

  if (rawStatus === 'active' && ownerAccountLinked === true) {
    const transfer = document.createElement('button');
    transfer.type = 'button';
    transfer.className = 'is-secondary';
    transfer.textContent = issuedOwnerTransferLinks.has(incarnationKey)
      ? 'Issue another transfer link'
      : 'Transfer ownership';
    transfer.title =
      'Bind a one-time link to the exact recipient account. Redemption signs out the old owner and revokes API keys.';
    transfer.addEventListener('click', () =>
      openProRoomTransferDialog(roomCode, roomGeneration, transfer),
    );
    actions.append(transfer);
  }

  if (
    rawStatus === 'active' ||
    (rawStatus === 'suspended' && suspensionReason === 'operator_suspended')
  ) {
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

function renderProRoomLegacyOwnerRepair(room, roomCode, roomGeneration, rawStatus) {
  const suspensionReason =
    typeof room?.suspensionReason === 'string' ? room.suspensionReason : null;
  const eligibleStatus =
    rawStatus === 'active' ||
    (rawStatus === 'suspended' && suspensionReason === 'operator_suspended');
  if (room?.ownerAccountLinked !== true || !eligibleStatus) {
    return document.createDocumentFragment();
  }

  const section = document.createElement('section');
  section.className = 'pro-room-owner-repair';
  const copy = document.createElement('div');
  const heading = document.createElement('strong');
  heading.textContent = 'Legacy owner repair';
  const description = document.createElement('p');
  description.textContent =
    'Only for a legacy beta account linked to two PRO rooms. Detach this room before assigning it to another account; room data is preserved. This is not transfer or deletion.';
  copy.append(heading, description);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'is-danger';
  button.textContent = 'Detach legacy owner';
  button.dataset.proRoomOwnerDetach = roomCode;
  button.addEventListener('click', () =>
    openProRoomLegacyOwnerDetachDialog(roomCode, roomGeneration, button),
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
  const ownerAccountLinked =
    rawStatus === 'active' && typeof room?.ownerAccountLinked === 'boolean'
      ? room.ownerAccountLinked
      : null;
  const ownerTransferPrepared = room?.ownerTransferPrepared === true;
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
  const displayStatus =
    rawStatus === 'active' && ownerAccountLinked !== true
      ? ownerAccountLinked === false
        ? 'suspended'
        : 'provisioning'
      : rawStatus;
  status.className = `pro-room-state is-${displayStatus.replace(/[^a-z-]/g, '')}`;
  status.textContent = formatProRoomStatus(
    rawStatus,
    room?.suspensionReason,
    ownerAccountLinked,
    ownerTransferPrepared,
  );
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
  const ownerRepair = incarnationKey
    ? renderProRoomLegacyOwnerRepair(room, roomCode, roomGeneration, rawStatus)
    : document.createDocumentFragment();
  expanded.append(controls, ownerRepair, apiPanel, dangerZone);
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
    issuedOwnerTransferLinks,
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

function setProGrantCampaignMessage(message, isError = false) {
  if (!proGrantCampaignStatusEl) return;
  proGrantCampaignStatusEl.textContent = message || '';
  proGrantCampaignStatusEl.classList.toggle('is-error', isError);
}

function proGrantCampaignStatusCopy(status) {
  return (
    {
      active: '진행 중',
      paused: '일시 중지',
      scheduled: '시작 전',
      ended: '종료됨',
      revoked: '미사용 코드 폐기됨',
      draft: '초안',
      review: '검토 중',
      'not-created': '생성 전',
    }[status] ||
    status ||
    '알 수 없음'
  );
}

function proGrantCampaignPublicPath(slug) {
  const normalized = String(slug || '')
    .trim()
    .toLowerCase();
  const numbered = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(\d+)$/u.exec(normalized);
  if (numbered) return `/events/${encodeURIComponent(numbered[1])}/${numbered[2]}/`;
  return `/events/${encodeURIComponent(normalized)}/`;
}

function proGrantCampaignPublicUrl(slug) {
  return new URL(proGrantCampaignPublicPath(slug), window.location.origin).href;
}

function proGrantPoolFingerprint(config) {
  return config ? `${config.campaign.slug}:${config.roomCodes.join(',')}` : '';
}

function normalizeProGrantCampaignEntries(payload) {
  if (!Array.isArray(payload?.campaigns)) return null;
  return payload.campaigns
    .map((entry) => {
      const campaign = entry?.campaign || entry;
      if (!campaign || typeof campaign.slug !== 'string' || typeof campaign.title !== 'string') {
        return null;
      }
      return {
        ...(entry?.campaign ? entry : {}),
        campaign,
        counts: entry?.counts || entry?.voucherCounts || campaign.counts || {},
        ...(Array.isArray(entry?.roomCodes) ? { roomCodes: entry.roomCodes } : {}),
      };
    })
    .filter(Boolean);
}

function renderProGrantCampaignList() {
  if (!proGrantCampaignListEl) return;
  const draftSlug = proGrantCampaignDraft?.campaign?.slug;
  const entries = proGrantCampaigns.filter((entry) => (entry.campaign || entry).slug !== draftSlug);
  if (proGrantCampaignDraft) entries.unshift(proGrantCampaignDraft);
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pro-grant-campaign-empty';
    empty.innerHTML =
      '<strong>아직 이벤트가 없어요.</strong><span>새 이벤트를 눌러 시작해 보세요.</span>';
    proGrantCampaignListEl.replaceChildren(empty);
    return;
  }
  const rows = entries.map((entry) => {
    const campaign = entry.campaign || entry;
    const counts = normalizedProGrantCounts(entry);
    const state = entry.isDraft ? 'review' : campaign.status || 'not-created';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pro-grant-campaign-item';
    button.dataset.proGrantCampaignSelect = campaign.slug;
    button.setAttribute('aria-pressed', String(campaign.slug === selectedProGrantCampaignSlug));
    button.disabled = proGrantCampaignBusy;
    const title = document.createElement('strong');
    title.textContent = campaign.title;
    const meta = document.createElement('span');
    meta.textContent = `${campaign.slug} · ${formatter.format(counts.redeemed)}/${formatter.format(counts.total)} 사용`;
    const status = document.createElement('span');
    status.className = 'pro-grant-campaign-item-state';
    status.dataset.state = state;
    status.textContent = proGrantCampaignStatusCopy(state);
    button.append(title, meta, status);
    if (
      pendingProGrantVoucherExport?.campaign?.slug === campaign.slug &&
      !pendingProGrantVoucherExport.applied
    ) {
      const pending = document.createElement('span');
      pending.className = 'pro-grant-campaign-pending';
      pending.textContent = '적용 대기 중인 코드 파일';
      button.append(pending);
    }
    button.addEventListener('click', () => {
      const restoreFocus = document.activeElement === button;
      selectedProGrantCampaignSlug = campaign.slug;
      proGrantCampaignState = entry;
      renderProGrantCampaignState(entry);
      if (restoreFocus) {
        proGrantCampaignListEl
          ?.querySelector(`[data-pro-grant-campaign-select="${campaign.slug}"]`)
          ?.focus({ preventScroll: true });
      }
    });
    return button;
  });
  proGrantCampaignListEl.replaceChildren(...rows);
}

function setProGrantCampaignBusy(busy) {
  proGrantCampaignBusy = busy;
  proGrantCampaignPanelEl?.toggleAttribute('aria-busy', busy);
  for (const button of [
    proGrantCampaignNewBtn,
    proGrantCampaignImportBtn,
    proGrantCampaignVerifyBtn,
    proGrantCampaignCreateBtn,
    proGrantCampaignApplyBtn,
    proGrantCampaignPauseBtn,
    proGrantCampaignEndBtn,
    proGrantCampaignRevokeBtn,
    proGrantCampaignDownloadBtn,
    proGrantCampaignCopyBtn,
  ]) {
    if (button) button.disabled = busy;
  }
  if (proGrantCampaignFormEl) {
    for (const control of proGrantCampaignFormEl.elements) control.disabled = busy;
  }
  if (!busy) renderProGrantCampaignState(proGrantCampaignState);
}

function normalizedProGrantCounts(payload) {
  const raw = payload?.counts || payload?.voucherCounts || {};
  const source = Array.isArray(raw)
    ? Object.fromEntries(
        raw
          .filter((entry) => typeof entry?.status === 'string')
          .map((entry) => [entry.status, Number(entry.count)]),
      )
    : raw;
  const count = (key) => {
    const value = Number(source[key] || 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  const available = count('available');
  const redeemed = count('redeemed');
  const revoked = count('revoked');
  const explicitTotal = count('total');
  return {
    total: explicitTotal || available + redeemed + revoked,
    available,
    redeemed,
    revoked,
  };
}

function renderProGrantCampaignState(payload) {
  if (!proGrantCampaignPanelEl) return;
  const entry = payload?.campaign || payload?.slug ? payload : selectedProGrantCampaign();
  const campaign = entry?.campaign || (entry?.slug ? entry : null);
  const config = campaign ? proGrantCampaignConfig(entry) : null;
  const state = entry?.isDraft ? 'review' : campaign?.status || 'not-created';
  const counts = normalizedProGrantCounts(entry);
  const hasExactPendingBatch = Boolean(
    pendingProGrantVoucherExport &&
    campaign?.slug &&
    pendingProGrantVoucherExport.campaign?.slug === campaign.slug,
  );
  const pendingApplied = hasExactPendingBatch && pendingProGrantVoucherExport.applied === true;
  const hasUnappliedBatch = Boolean(
    pendingProGrantVoucherExport && pendingProGrantVoucherExport.applied !== true,
  );
  const poolVerified =
    verifiedProGrantPool?.fingerprint &&
    verifiedProGrantPool.fingerprint === proGrantPoolFingerprint(config);
  proGrantCampaignPanelEl.dataset.proGrantCampaign = campaign?.slug || '';
  proGrantCampaignDetailEl?.toggleAttribute('data-empty', !campaign);
  if (proGrantCampaignTitleEl) {
    proGrantCampaignTitleEl.textContent = campaign?.title || '이벤트를 선택해 주세요';
  }
  if (proGrantCampaignMetaEl) {
    if (!campaign) {
      proGrantCampaignMetaEl.textContent = '목록에서 이벤트를 선택하거나 새로 만들 수 있어요.';
    } else {
      const rooms = config?.roomCodes || [];
      const roomRange =
        rooms.length > 0
          ? `${rooms[0]}–${rooms.at(-1)} · ${formatter.format(rooms.length)}개 방`
          : '방 범위 정보 없음';
      const starts = normalizeCampaignTimestamp(campaign.startsAt);
      const ends = normalizeCampaignTimestamp(campaign.endsAt);
      proGrantCampaignMetaEl.textContent = `${campaign.slug} · ${roomRange} · 계정당 1개 · ${
        starts ? formatAdminDateTime(starts) : '시작 시각 미정'
      }${ends ? `–${formatAdminDateTime(ends)}` : '–직접 종료'}`;
    }
  }
  if (proGrantCampaignStateEl) {
    proGrantCampaignStateEl.textContent = proGrantCampaignStatusCopy(state);
    proGrantCampaignStateEl.dataset.state = state;
  }
  if (proGrantCampaignEventLinkEl) {
    proGrantCampaignEventLinkEl.hidden = !campaign;
    const link = proGrantCampaignEventLinkEl.querySelector('a');
    if (link && campaign) {
      link.href = proGrantCampaignPublicUrl(campaign.slug);
      link.textContent = proGrantCampaignPublicPath(campaign.slug);
    }
  }
  if (proGrantCampaignCountsEl) {
    proGrantCampaignCountsEl.textContent = campaign
      ? `${formatter.format(counts.total)}개 발급 · ${formatter.format(counts.available)}개 사용 가능 · ${formatter.format(counts.redeemed)}개 사용 · ${formatter.format(counts.revoked)}개 폐기`
      : '새 이벤트를 만들거나 목록에서 선택해 주세요.';
  }
  const issuanceClosed =
    !campaign ||
    ['ended', 'revoked'].includes(state) ||
    (!entry?.isDraft && counts.total > 0 && !hasExactPendingBatch);
  if (proGrantCampaignCreateBtn) {
    proGrantCampaignCreateBtn.disabled =
      proGrantCampaignBusy ||
      !campaign ||
      issuanceClosed ||
      !poolVerified ||
      (pendingProGrantVoucherExport && !hasExactPendingBatch);
    proGrantCampaignCreateBtn.textContent = hasExactPendingBatch
      ? '2. 같은 코드 파일 다시 받기'
      : '2. 코드 파일 만들기';
  }
  if (proGrantCampaignApplyBtn) {
    proGrantCampaignApplyBtn.disabled =
      proGrantCampaignBusy || !hasExactPendingBatch || pendingApplied;
    proGrantCampaignApplyBtn.textContent = pendingApplied ? '3. 시작 완료' : '3. 이벤트 시작';
  }
  if (proGrantCampaignVerifyBtn) {
    proGrantCampaignVerifyBtn.disabled = proGrantCampaignBusy || !campaign || issuanceClosed;
  }
  if (proGrantCampaignPauseBtn) {
    const canRecoverIssuedDraft = state === 'draft' && counts.total > 0;
    proGrantCampaignPauseBtn.disabled =
      proGrantCampaignBusy ||
      !campaign ||
      (!canRecoverIssuedDraft && !['active', 'paused', 'scheduled'].includes(state));
    proGrantCampaignPauseBtn.textContent = canRecoverIssuedDraft
      ? '이벤트 시작'
      : state === 'paused'
        ? '다시 시작'
        : '일시 중지';
  }
  if (proGrantCampaignEndBtn) {
    proGrantCampaignEndBtn.disabled =
      proGrantCampaignBusy ||
      !campaign ||
      !['draft', 'active', 'paused', 'scheduled'].includes(state);
  }
  if (proGrantCampaignRevokeBtn) {
    proGrantCampaignRevokeBtn.disabled =
      proGrantCampaignBusy || !campaign || counts.available < 1 || state === 'revoked';
  }
  if (proGrantCampaignExportEl) proGrantCampaignExportEl.hidden = !hasExactPendingBatch;
  if (proGrantCampaignDownloadBtn) proGrantCampaignDownloadBtn.disabled = proGrantCampaignBusy;
  if (proGrantCampaignCopyBtn) proGrantCampaignCopyBtn.disabled = proGrantCampaignBusy;
  if (proGrantCampaignNewBtn) {
    proGrantCampaignNewBtn.disabled = proGrantCampaignBusy || hasUnappliedBatch;
  }
  if (proGrantCampaignImportBtn) {
    proGrantCampaignImportBtn.disabled = proGrantCampaignBusy || hasUnappliedBatch;
  }
  renderProGrantCampaignList();
}

async function loadProGrantCampaignStatus() {
  if (!proGrantCampaignPanelEl) return null;
  try {
    let entries = null;
    let usedLegacyStatusRoute = false;
    try {
      const listPayload = await fetchJson('/api/admin/pro-grants/campaigns');
      entries = normalizeProGrantCampaignEntries(listPayload);
    } catch (error) {
      if (![404, 405].includes(error?.status)) throw error;
    }
    if (entries === null) {
      usedLegacyStatusRoute = true;
      try {
        const legacy = await fetchJson(
          `/api/admin/pro-grants/campaigns/${PRO_GRANT_ASAMO_SLUG}/status`,
        );
        entries = legacy?.campaign ? [legacy] : [];
      } catch (error) {
        if (error?.status === 404 || error?.message === 'PRO_GRANT_CAMPAIGN_NOT_FOUND')
          entries = [];
        else throw error;
      }
    }
    if (usedLegacyStatusRoute && entries.length === 0) {
      entries = [
        {
          campaign: {
            slug: PRO_GRANT_ASAMO_SLUG,
            title: PRO_GRANT_ASAMO_TITLE,
            status: 'not-created',
            startsAt: null,
            endsAt: null,
            perAccountLimit: 1,
          },
          counts: {},
          roomCodes: PRO_GRANT_ASAMO_ROOM_CODES,
          roomLabelPrefix: 'ASAMO 0',
          isDraft: true,
        },
      ];
    }
    proGrantCampaigns = entries;
    if (
      !selectedProGrantCampaignSlug ||
      !proGrantCampaigns.some(
        (entry) => (entry.campaign || entry).slug === selectedProGrantCampaignSlug,
      )
    ) {
      selectedProGrantCampaignSlug =
        proGrantCampaignDraft?.campaign?.slug ||
        (proGrantCampaigns[0]?.campaign || proGrantCampaigns[0])?.slug ||
        null;
    }
    proGrantCampaignState = selectedProGrantCampaign();
    proGrantCampaignLoaded = true;
    renderProGrantCampaignState(proGrantCampaignState);
    return proGrantCampaignState;
  } catch (error) {
    proGrantCampaignLoaded = false;
    throw error;
  }
}

function campaignMutationBody(config, dryRun) {
  return {
    slug: config.campaign.slug,
    title: config.campaign.title,
    startsAt: config.campaign.startsAt,
    endsAt: config.campaign.endsAt,
    perAccountLimit: 1,
    dryRun,
  };
}

function findProGrantCampaignOverlap(config) {
  const requested = new Set(config.roomCodes);
  for (const entry of proGrantCampaigns) {
    const campaign = entry.campaign || entry;
    if (campaign.slug === config.campaign.slug) continue;
    const overlap = proGrantCampaignRoomCodes(entry).find((roomCode) => requested.has(roomCode));
    if (overlap) return { roomCode: overlap, campaign };
  }
  return null;
}

async function verifyProGrantCampaignPool() {
  if (proGrantCampaignBusy) return;
  const config = proGrantCampaignConfig();
  if (!config || config.roomCodes.length === 0) {
    setProGrantCampaignMessage('이 이벤트의 연속된 방 번호 범위 정보가 올바르지 않아요.', true);
    return;
  }
  setProGrantCampaignBusy(true);
  setProGrantCampaignMessage(
    `${config.roomCodes[0]}–${config.roomCodes.at(-1)} 범위를 변경 없이 검사하고 있어요...`,
  );
  try {
    await loadProGrantCampaignStatus();
    const overlap = findProGrantCampaignOverlap(config);
    if (overlap) {
      throw new Error(`${overlap.roomCode}번 방이 ${overlap.campaign.title}와 겹쳐요.`);
    }
    await fetchJson('/api/admin/pro-grants/campaigns', {
      method: 'POST',
      body: JSON.stringify(campaignMutationBody(config, true)),
    });
    const inventory = await loadProGrantRoomInventory(config.roomCodes);
    if (inventory.unavailable.length > 0) {
      const first = inventory.unavailable[0];
      setProGrantCampaignMessage(
        `${formatter.format(inventory.unavailable.length)}개 방을 사용할 수 없어요. ${first.roomCode} 상태: ${first.status}/${first.activationState}.`,
        true,
      );
      return;
    }
    verifiedProGrantPool = {
      fingerprint: proGrantPoolFingerprint(config),
      inventory,
      verifiedAt: Date.now(),
    };
    setProGrantCampaignMessage(
      inventory.needsProvisioning.length > 0
        ? `${formatter.format(inventory.needsProvisioning.length)}개 방은 적용 단계에서 새로 준비돼요. 먼저 코드 파일을 저장해 주세요.`
        : `전체 ${formatter.format(config.roomCodes.length)}개 방이 미활성 상태로 준비됐어요.`,
    );
  } catch (error) {
    verifiedProGrantPool = null;
    setProGrantCampaignMessage(
      adminErrorMessage(error, '이벤트 방 번호를 검증하지 못했어요.'),
      true,
    );
    throw error;
  } finally {
    setProGrantCampaignBusy(false);
  }
}

function assertSecretFreeProGrantConfirmation(payload, batch, inventory) {
  if (/"(?:code|codeDigest|code_digest)"\s*:/iu.test(JSON.stringify(payload))) {
    throw new Error('PRO_GRANT_SECRET_ECHO_REJECTED');
  }
  const mappings = payload?.mappings;
  if (
    payload?.requestId !== batch.requestId ||
    payload?.campaign?.slug !== batch.campaign.slug ||
    payload?.count !== batch.vouchers.length ||
    !Array.isArray(mappings) ||
    mappings.length !== batch.vouchers.length
  ) {
    throw new Error('PRO_GRANT_BATCH_CONFIRMATION_MISMATCH');
  }
  const expectedRooms = new Set(batch.vouchers.map((voucher) => voucher.roomCode));
  const expectedGenerations = new Map();
  for (const room of [...(inventory?.ready || []), ...(inventory?.unavailable || [])]) {
    if (
      expectedRooms.has(room?.roomCode) &&
      Number.isSafeInteger(room?.roomGeneration) &&
      room.roomGeneration >= 0
    ) {
      expectedGenerations.set(room.roomCode, room.roomGeneration);
    }
  }
  const voucherIds = new Set();
  for (const mapping of mappings) {
    const expectedGeneration = expectedGenerations.get(mapping?.roomCode);
    if (
      !/^voucher_[A-Za-z0-9_-]{22}$/u.test(mapping?.voucherId || '') ||
      voucherIds.has(mapping.voucherId) ||
      !expectedRooms.delete(mapping?.roomCode) ||
      !Number.isSafeInteger(mapping?.roomGeneration) ||
      mapping.roomGeneration < 0 ||
      (expectedGeneration !== undefined && mapping.roomGeneration !== expectedGeneration) ||
      !['available', 'redeemed', 'revoked'].includes(mapping?.status)
    ) {
      throw new Error('PRO_GRANT_BATCH_CONFIRMATION_MISMATCH');
    }
    voucherIds.add(mapping.voucherId);
  }
  if (expectedRooms.size !== 0) throw new Error('PRO_GRANT_BATCH_CONFIRMATION_MISMATCH');
  return payload;
}

async function applyPendingProGrantVoucherBatch() {
  const batch = pendingProGrantVoucherExport;
  if (!batch || proGrantCampaignBusy) return;
  const config = {
    campaign: batch.campaign,
    roomCodes: batch.vouchers.map((voucher) => voucher.roomCode),
    roomLabelPrefix: batch.roomLabelPrefix || batch.campaign.title,
  };
  setProGrantCampaignBusy(true);
  setProGrantCampaignMessage(
    '저장한 코드 파일과 같은 방 번호를 다시 확인하고 이벤트를 시작하고 있어요...',
  );
  try {
    const overlap = findProGrantCampaignOverlap(config);
    if (overlap) {
      throw new Error(`${overlap.roomCode}번 방이 ${overlap.campaign.title}와 겹쳐요.`);
    }
    const provisioning = await provisionProGrantRoomPool(config);
    await fetchJson('/api/admin/pro-grants/campaigns', {
      method: 'POST',
      body: JSON.stringify(campaignMutationBody(config, false)),
    });
    const confirmation = await fetchJson(
      `/api/admin/pro-grants/campaigns/${encodeURIComponent(batch.campaign.slug)}/vouchers`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: batch.requestId,
          dryRun: false,
          vouchers: batch.vouchers,
        }),
      },
    );
    assertSecretFreeProGrantConfirmation(confirmation, batch, provisioning.inventory);
    if (provisioning.replayOnly && confirmation.replayed !== true) {
      throw new Error('Unavailable rooms may only be accepted for an exact existing batch replay.');
    }
    await fetchJson(
      `/api/admin/pro-grants/campaigns/${encodeURIComponent(batch.campaign.slug)}/status`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: batch.requestId,
          status: 'active',
          dryRun: false,
        }),
      },
    );
    batch.applied = true;
    setProGrantCampaignMessage(
      confirmation.replayed
        ? '기존 배치와 정확히 일치해요. 새 코드는 만들지 않았어요.'
        : `${formatter.format(batch.vouchers.length)}개 코드가 적용됐어요. 다운로드 파일을 안전하게 보관해 주세요.`,
    );
    proGrantCampaignDraft = null;
    await loadProGrantCampaignStatus();
  } catch (error) {
    setProGrantCampaignMessage(
      `${adminErrorMessage(error, '코드를 적용하지 못했어요.')} 같은 배치를 메모리에 보존했으니 상태를 확인한 뒤 다시 시도할 수 있어요.`,
      true,
    );
    throw error;
  } finally {
    setProGrantCampaignBusy(false);
  }
}

async function createAndDownloadProGrantVouchers() {
  if (proGrantCampaignBusy) return;
  if (pendingProGrantVoucherExport) {
    if (pendingProGrantVoucherExport.campaign.slug !== selectedProGrantCampaignSlug) {
      setProGrantCampaignMessage(
        `${pendingProGrantVoucherExport.campaign.title}의 미적용 코드 파일이 메모리에 있어요. 먼저 해당 이벤트를 적용하거나 페이지를 나가 폐기해 주세요.`,
        true,
      );
      return;
    }
    downloadProGrantVoucherExport();
    setProGrantCampaignMessage(
      '같은 코드 파일을 다시 받았어요. 파일을 확인한 뒤 이벤트를 시작해 주세요.',
    );
    return;
  }
  const config = proGrantCampaignConfig();
  if (!config || verifiedProGrantPool?.fingerprint !== proGrantPoolFingerprint(config)) {
    setProGrantCampaignMessage('먼저 1단계에서 방 번호를 확인해 주세요.', true);
    return;
  }
  pendingProGrantVoucherExport = createProGrantVoucherExport(config);
  renderProGrantCampaignState(proGrantCampaignState);
  // This phase performs no remote mutation. The operator explicitly applies
  // only after confirming that the recoverable plaintext file was saved.
  downloadProGrantVoucherExport(pendingProGrantVoucherExport);
  setProGrantCampaignMessage('코드 파일을 만들었어요. 다운로드를 확인한 뒤 3단계를 눌러 주세요.');
}

async function setProGrantCampaignOperationalStatus(status) {
  if (proGrantCampaignBusy || !['active', 'paused', 'ended'].includes(status)) return;
  const campaign = selectedProGrantCampaign()?.campaign || selectedProGrantCampaign();
  if (!campaign?.slug) return;
  if (status === 'ended') {
    const confirmed = window.confirm(
      `${campaign.title} 이벤트를 종료할까요?\n\n남은 코드는 보존되지만 더 이상 등록할 수 없어요. 종료 후에는 다시 시작할 수 없습니다. 이미 받은 PRO 방은 유지됩니다.`,
    );
    if (!confirmed) return;
  }
  setProGrantCampaignBusy(true);
  setProGrantCampaignMessage(
    status === 'paused'
      ? '이벤트를 일시 중지하고 있어요...'
      : status === 'ended'
        ? '이벤트를 종료하고 있어요...'
        : '이벤트를 다시 시작하고 있어요...',
  );
  try {
    await fetchJson(`/api/admin/pro-grants/campaigns/${encodeURIComponent(campaign.slug)}/status`, {
      method: 'POST',
      body: JSON.stringify({ requestId: createProGrantBatchRequestId(), status, dryRun: false }),
    });
    await loadProGrantCampaignStatus();
    setProGrantCampaignMessage(
      status === 'paused'
        ? '이벤트를 일시 중지했어요.'
        : status === 'ended'
          ? '이벤트를 종료했어요. 미사용 코드는 보존돼요.'
          : '이벤트를 다시 시작했어요.',
    );
  } finally {
    setProGrantCampaignBusy(false);
  }
}

async function revokeProGrantCampaign() {
  if (proGrantCampaignBusy) return;
  const entry = selectedProGrantCampaign();
  const campaign = entry?.campaign || entry;
  if (!campaign?.slug) return;
  const available = normalizedProGrantCounts(entry).available;
  const confirmed = window.confirm(
    `${campaign.title}의 미사용 코드 ${formatter.format(available)}개를 영구 폐기할까요?\n\n이 작업은 되돌릴 수 없습니다. 이미 사용된 코드와 지급된 PRO 방은 유지됩니다.`,
  );
  if (!confirmed) return;
  setProGrantCampaignBusy(true);
  setProGrantCampaignMessage('미사용 코드를 영구 폐기하고 있어요...');
  try {
    await fetchJson(`/api/admin/pro-grants/campaigns/${encodeURIComponent(campaign.slug)}/revoke`, {
      method: 'POST',
      body: JSON.stringify({
        requestId: createProGrantBatchRequestId(),
        reason: 'operator_revoked',
      }),
    });
    await loadProGrantCampaignStatus();
    setProGrantCampaignMessage('미사용 코드를 폐기했어요. 이미 지급된 PRO 방은 바뀌지 않았어요.');
  } finally {
    setProGrantCampaignBusy(false);
  }
}

function updateProGrantCampaignFormPreview() {
  if (!proGrantCampaignFormEl) return;
  const slugInput = proGrantCampaignFormEl.elements.namedItem('slug');
  const startInput = proGrantCampaignFormEl.elements.namedItem('roomStartCode');
  const countInput = proGrantCampaignFormEl.elements.namedItem('roomCount');
  const slug = String(slugInput?.value || '')
    .trim()
    .toLowerCase();
  const slugPreview = proGrantCampaignFormEl.querySelector('[data-pro-grant-slug-preview]');
  if (slugPreview)
    slugPreview.textContent = slug ? proGrantCampaignPublicPath(slug).slice(8) : 'event/';
  const rangePreview = proGrantCampaignFormEl.querySelector('[data-pro-grant-range-preview]');
  if (!rangePreview) return;
  try {
    const roomCodes = campaignRoomCodesFromRange(startInput?.value, Number(countInput?.value));
    rangePreview.textContent = `${roomCodes[0]}–${roomCodes.at(-1)} · ${formatter.format(roomCodes.length)}개 방 · 계정당 1개`;
    rangePreview.classList.remove('is-error');
  } catch (error) {
    rangePreview.textContent = error.message;
    rangePreview.classList.add('is-error');
  }
}

function openProGrantCampaignForm() {
  if (!proGrantCampaignFormEl) return;
  if (pendingProGrantVoucherExport && pendingProGrantVoucherExport.applied !== true) {
    selectedProGrantCampaignSlug = pendingProGrantVoucherExport.campaign.slug;
    proGrantCampaignState = selectedProGrantCampaign();
    renderProGrantCampaignState(proGrantCampaignState);
    setProGrantCampaignMessage(
      `${pendingProGrantVoucherExport.campaign.title}의 코드 파일이 적용 대기 중이에요. 먼저 해당 이벤트를 시작하거나 페이지를 나가 폐기해 주세요.`,
      true,
    );
    return;
  }
  if (pendingProGrantVoucherExport?.applied === true) {
    pendingProGrantVoucherExport = null;
    renderProGrantCampaignState(proGrantCampaignState);
  }
  proGrantCampaignFormEl.reset();
  proGrantCampaignFormEl.hidden = false;
  const startsAt = proGrantCampaignFormEl.elements.namedItem('startsAt');
  if (startsAt && !startsAt.value) startsAt.value = formatCampaignLocalDateTime(Date.now());
  updateProGrantCampaignFormPreview();
  proGrantCampaignFormEl.querySelector('input[name="title"]')?.focus();
}

function closeProGrantCampaignForm() {
  if (!proGrantCampaignFormEl) return;
  proGrantCampaignFormEl.hidden = true;
  proGrantCampaignNewBtn?.focus();
}

function stageProGrantCampaignFromForm() {
  if (!proGrantCampaignFormEl) return;
  const form = new FormData(proGrantCampaignFormEl);
  const title = String(form.get('title') || '').trim();
  const slug = String(form.get('slug') || '')
    .trim()
    .toLowerCase();
  if (!title || title.length > 80) throw new Error('이벤트 이름을 확인해 주세요.');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || slug.length > 48) {
    throw new Error('URL 이름은 영문 소문자, 숫자, 하이픈만 사용할 수 있어요.');
  }
  if (
    pendingProGrantVoucherExport &&
    pendingProGrantVoucherExport.applied !== true &&
    pendingProGrantVoucherExport?.campaign?.slug !== slug
  ) {
    throw new Error(
      `${pendingProGrantVoucherExport.campaign.title}의 코드 파일이 적용 대기 중이에요. 먼저 해당 이벤트를 시작하거나 페이지를 나가 폐기해 주세요.`,
    );
  }
  if (proGrantCampaigns.some((entry) => (entry.campaign || entry).slug === slug)) {
    throw new Error('이미 같은 URL 이름을 사용하는 이벤트가 있어요.');
  }
  const roomCodes = campaignRoomCodesFromRange(
    form.get('roomStartCode'),
    Number(form.get('roomCount')),
  );
  const startsAt = parseCampaignLocalDateTime(form.get('startsAt'), { required: true });
  const endsAt = parseCampaignLocalDateTime(form.get('endsAt'));
  if (endsAt !== null && endsAt <= startsAt) {
    throw new Error('종료 시간은 시작 시간보다 뒤여야 해요.');
  }
  const draft = {
    campaign: {
      slug,
      title,
      status: 'not-created',
      startsAt,
      endsAt,
      perAccountLimit: 1,
      roomStartCode: roomCodes[0],
      roomCount: roomCodes.length,
    },
    counts: {},
    roomCodes,
    roomLabelPrefix: title,
    isDraft: true,
  };
  const overlap = findProGrantCampaignOverlap(proGrantCampaignConfig(draft));
  if (overlap) throw new Error(`${overlap.roomCode}번 방이 ${overlap.campaign.title}와 겹쳐요.`);
  proGrantCampaignDraft = draft;
  selectedProGrantCampaignSlug = slug;
  proGrantCampaignState = draft;
  verifiedProGrantPool = null;
  closeProGrantCampaignForm();
  renderProGrantCampaignState(draft);
  setProGrantCampaignMessage('이벤트 정보를 검토했어요. 이제 1단계에서 방 번호를 확인해 주세요.');
}

async function loadProRooms(options = {}) {
  const load = beginLatestAdminLoad('pro-rooms');
  if (proRoomListStatusEl) proRoomListStatusEl.textContent = 'Refreshing...';
  try {
    const payload = await fetchJson('/api/admin/pro-rooms', {
      signal: load.controller.signal,
    });
    throwIfAdminLoadStale(load);
    renderProRooms(payload);
    proRoomsLoaded = true;
    if (options.updateTimestamp !== false) {
      updatedAtEl.textContent = `Updated ${formatAdminDateTime(payload.generatedAt || Date.now())}`;
    }
    return payload;
  } finally {
    finishLatestAdminLoad(load);
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
  const load = beginLatestAdminLoad('metrics');
  updatedAtEl.textContent = 'Refreshing...';
  try {
    const metrics = await fetchJson('/api/admin/metrics', {
      signal: load.controller.signal,
    });
    throwIfAdminLoadStale(load);
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
    return metrics;
  } finally {
    finishLatestAdminLoad(load);
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
  const load = beginLatestAdminLoad('articles');
  if (articleStatusEl) articleStatusEl.textContent = 'Refreshing...';
  try {
    const payload = await fetchJson('/api/admin/articles', {
      signal: load.controller.signal,
    });
    throwIfAdminLoadStale(load);
    renderArticles(payload);
    articlesLoaded = true;
    if (options.updateTimestamp !== false) {
      updatedAtEl.textContent = `Updated ${formatAdminDateTime(payload.generatedAt)}`;
    }
    return payload;
  } finally {
    finishLatestAdminLoad(load);
  }
}

function clearAnnouncementExpiryTimer() {
  if (announcementExpiryTimer !== null) {
    window.clearTimeout(announcementExpiryTimer);
    announcementExpiryTimer = null;
  }
}

function setAnnouncementActiveIndicator(active, expiresAt = null) {
  clearAnnouncementExpiryTimer();
  const isActive = Boolean(active);
  announcementTabEl?.classList.toggle('has-active-announcement', isActive);
  if (announcementTabEl) {
    announcementTabEl.setAttribute(
      'aria-label',
      isActive ? 'Announcements, active announcement' : 'Announcements',
    );
  }
  if (!isActive || !expiresAt) return;

  const expiryMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiryMs)) return;
  const scheduleExpiryCheck = () => {
    const remainingMs = expiryMs - Date.now();
    if (remainingMs <= 0) {
      setAnnouncementActiveIndicator(false);
      return;
    }
    announcementExpiryTimer = window.setTimeout(
      scheduleExpiryCheck,
      Math.min(remainingMs + 50, 2_147_000_000),
    );
  };
  scheduleExpiryCheck();
}

function isAnnouncementActiveForAdmin(payload, announcement) {
  if (!announcement?.enabled || !announcement?.message) return false;
  if (typeof payload?.active === 'boolean' && !payload.active) return false;
  if (!announcement.expiresAt) return payload?.active !== false;
  const expiryMs = new Date(announcement.expiresAt).getTime();
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) return false;
  return payload?.active !== false;
}

function renderAnnouncement(payload) {
  const announcement = payload.announcement || {};
  const message = announcement.message || '';
  const active = isAnnouncementActiveForAdmin(payload, announcement);
  setAnnouncementActiveIndicator(active, announcement.expiresAt);
  if (announcementMessageEl) announcementMessageEl.value = message;
  if (announcementEnabledEl) announcementEnabledEl.checked = Boolean(announcement.enabled);
  if (announcementExpiresEl)
    announcementExpiresEl.value = toDatetimeLocalValue(announcement.expiresAt);

  const statusParts = [];
  statusParts.push(active ? 'Active' : announcement.enabled ? 'Expired' : 'Disabled');
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

function setAnnouncementMutationBusy(busy) {
  announcementMutationBusy = busy;
  const controls = new Set([
    announcementMessageEl,
    announcementEnabledEl,
    announcementExpiresEl,
    announcementClearBtn,
    ...(announcementForm?.querySelectorAll('button, input, textarea') || []),
  ]);
  for (const control of controls) {
    if (control) control.disabled = busy;
  }
}

async function loadAnnouncement(options = {}) {
  if (announcementMutationBusy) return null;
  const load = beginLatestAdminLoad('announcement');
  if (announcementStatusEl) announcementStatusEl.textContent = 'Refreshing...';
  try {
    const payload = await fetchJson('/api/admin/announcement', {
      signal: load.controller.signal,
    });
    throwIfAdminLoadStale(load);
    if (!Number.isSafeInteger(payload?.revision) || payload.revision < 0) {
      throw adminRequestError(
        'ADMIN_RESPONSE_INVALID',
        'The server returned an invalid announcement revision.',
      );
    }
    currentAnnouncementRevision = payload.revision;
    pendingAnnouncementMutation = null;
    renderAnnouncement(payload);
    renderAnnouncementHistory(payload);
    announcementLoaded = true;
    if (options.updateTimestamp !== false) {
      updatedAtEl.textContent = `Updated ${formatAdminDateTime(payload.generatedAt)}`;
    }
    return payload;
  } finally {
    finishLatestAdminLoad(load);
  }
}

async function saveAnnouncement({ clear = false } = {}) {
  if (announcementMutationBusy) return null;
  const message = clear ? '' : String(announcementMessageEl?.value || '').trim();
  const enabled = clear ? false : Boolean(announcementEnabledEl?.checked);
  const expiresValue = clear ? '' : String(announcementExpiresEl?.value || '').trim();
  if (!Number.isSafeInteger(currentAnnouncementRevision) || currentAnnouncementRevision < 0) {
    throw adminRequestError(
      'ADMIN_ANNOUNCEMENT_STATE_UNAVAILABLE',
      'Refresh the announcement before saving.',
    );
  }
  const expiresAt = parseAnnouncementExpiresValue(expiresValue);
  const signature = JSON.stringify({
    message,
    enabled,
    expiresAt,
    expectedRevision: currentAnnouncementRevision,
  });
  if (pendingAnnouncementMutation?.signature !== signature) {
    pendingAnnouncementMutation = { signature, requestId: createAdminRequestId() };
  }
  const mutation = pendingAnnouncementMutation;
  const expectedRevision = currentAnnouncementRevision;
  setAnnouncementMutationBusy(true);
  if (announcementStatusEl) announcementStatusEl.textContent = clear ? 'Clearing...' : 'Saving...';
  try {
    const payload = await fetchJson('/api/admin/announcement', {
      method: 'POST',
      body: JSON.stringify({
        message,
        enabled,
        expiresAt,
        expectedRevision,
        requestId: mutation.requestId,
      }),
    });
    if (!Number.isSafeInteger(payload?.revision) || payload.revision < 1) {
      throw adminRequestError(
        'ADMIN_RESPONSE_INVALID',
        'The server returned an invalid announcement revision.',
      );
    }
    currentAnnouncementRevision = payload.revision;
    if (pendingAnnouncementMutation === mutation) pendingAnnouncementMutation = null;
    renderAnnouncement(payload);
    renderAnnouncementHistory(payload);
    announcementLoaded = true;
    updatedAtEl.textContent = `Updated ${formatAdminDateTime(Date.now())}`;
  } catch (error) {
    if (
      error?.message === 'ADMIN_ANNOUNCEMENT_CONFLICT' &&
      Number.isSafeInteger(error?.payload?.revision) &&
      error.payload.revision >= currentAnnouncementRevision
    ) {
      currentAnnouncementRevision = error.payload.revision;
      renderAnnouncement(error.payload);
      renderAnnouncementHistory(error.payload);
      if (pendingAnnouncementMutation === mutation) pendingAnnouncementMutation = null;
    } else if (
      error?.message !== 'ADMIN_ANNOUNCEMENT_CONTROL_UNAVAILABLE' &&
      error?.code !== 'ADMIN_MUTATION_OUTCOME_UNKNOWN'
    ) {
      if (pendingAnnouncementMutation === mutation) pendingAnnouncementMutation = null;
    }
    throw error;
  } finally {
    setAnnouncementMutationBusy(false);
  }
}

async function loadAuthenticatedDashboard({ activateAnalytics = true } = {}) {
  showDashboard();
  if (activateAnalytics) setActiveTab('operations');
  // Keep a rolling admin asset update usable if an older server-rendered shell
  // is briefly paired with this script. Production shells expose the control.
  if (!serviceStatusTrigger) {
    await loadMetrics({ activateOperations: activateAnalytics });
    return null;
  }
  if (updatedAtEl) updatedAtEl.textContent = 'Checking service status...';

  let status = null;
  try {
    status = await loadServiceStatus({ updateTimestamp: false });
  } catch {
    // Keep the dashboard usable if the control plane is temporarily
    // unavailable. Mutations remain disabled until a verified status loads.
  }
  if (!status) {
    if (updatedAtEl) updatedAtEl.textContent = 'Service status unavailable';
    return null;
  }
  if (status && (status.enabled || isServiceStatusSettling(status))) {
    const state = serviceStatusStateName(status);
    const statusTime = status.activatedAt || status.updatedAt;
    if (updatedAtEl) {
      updatedAtEl.textContent =
        state === 'activating'
          ? `Activating maintenance - traffic gate propagates by ${formatAdminDateTime(status.settlesAt)}`
          : state === 'resuming'
            ? `Resuming service - public traffic resumes by ${formatAdminDateTime(status.settlesAt)}`
            : `Maintenance active${statusTime ? ` since ${formatAdminDateTime(statusTime)}` : ''}`;
    }
    return status;
  }

  try {
    await loadMetrics({ activateOperations: activateAnalytics });
  } catch (error) {
    if (updatedAtEl)
      updatedAtEl.textContent = adminErrorMessage(error, 'Analytics refresh failed.');
  }
  if (dashboard?.hidden) return status;
  await loadAnnouncement({ updateTimestamp: false }).catch((error) => {
    if (announcementStatusEl) {
      announcementStatusEl.textContent = adminErrorMessage(error, 'Announcement refresh failed.');
    }
  });
  return status;
}

async function refreshAllDashboardData() {
  const refreshEpoch = adminSessionEpoch;
  const activeTab = currentAdminTab;
  if (serviceStatusTrigger) {
    updatedAtEl.textContent = 'Checking service status...';
    let status = null;
    try {
      status = await loadServiceStatus({ updateTimestamp: false });
    } catch {
      // Do not fan out requests while the control-plane state is unknown. This
      // keeps the maintenance control available even if data APIs are gated.
    }
    if (refreshEpoch !== adminSessionEpoch || dashboard?.hidden) return;
    if (!status) {
      updatedAtEl.textContent = 'Service status unavailable';
      setActiveTab(activeTab);
      return;
    }
    if (status.enabled || isServiceStatusSettling(status)) {
      const state = serviceStatusStateName(status);
      const statusTime = status.activatedAt || status.updatedAt;
      updatedAtEl.textContent =
        state === 'activating'
          ? `Activating maintenance - traffic gate propagates by ${formatAdminDateTime(status.settlesAt)}`
          : state === 'resuming'
            ? `Resuming service - public traffic resumes by ${formatAdminDateTime(status.settlesAt)}`
            : `Maintenance active${statusTime ? ` since ${formatAdminDateTime(statusTime)}` : ''}`;
      setActiveTab(activeTab);
      return;
    }
  }
  updatedAtEl.textContent = 'Refreshing...';
  await Promise.all([
    loadMetrics({ updateTimestamp: false }),
    loadProRooms({ updateTimestamp: false }).catch((error) => {
      if (proRoomListStatusEl) {
        proRoomListStatusEl.textContent = adminErrorMessage(error, 'PRO rooms refresh failed.');
      }
    }),
    loadProGrantCampaignStatus().catch((error) => {
      setProGrantCampaignMessage(
        adminErrorMessage(error, 'PRO grant campaign refresh failed.'),
        true,
      );
    }),
    loadArticles({ updateTimestamp: false }),
    loadAnnouncement({ updateTimestamp: false }),
  ]);
  if (refreshEpoch !== adminSessionEpoch || dashboard?.hidden) return;
  setActiveTab(activeTab);
  updatedAtEl.textContent = `Updated ${formatAdminDateTime(Date.now())}`;
}

async function init() {
  const productionHost = /(^|\.)musixquare\.com$/i.test(window.location.hostname);
  if (productionHost) {
    const retryKey = `mxqr-admin-asset-retry-${ADMIN_SCRIPT_VERSION}`;
    if (root?.dataset.adminAssetVersion === ADMIN_SCRIPT_VERSION) {
      try {
        window.sessionStorage.removeItem(retryKey);
      } catch {
        // Storage can be unavailable in hardened browser profiles.
      }
    } else {
      let attempts = 0;
      try {
        attempts = Number(window.sessionStorage.getItem(retryKey) || 0);
      } catch {
        // Storage can be unavailable in hardened browser profiles.
      }
      if (attempts >= 8) {
        setStatus('Admin update is still propagating. Refresh in a moment.');
        return;
      }
      try {
        window.sessionStorage.setItem(retryKey, String(attempts + 1));
      } catch {
        // Storage can be unavailable in hardened browser profiles.
      }
      setStatus('Synchronizing admin controls...');
      window.setTimeout(() => window.location.reload(), 500 + attempts * 250);
      return;
    }
  }
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
    beginAdminSession();
    await loadAuthenticatedDashboard();
  } catch (error) {
    showLogin(error.message || 'Failed to load admin session.');
  }
}

loginForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  // The logout response clears the server cookie. Never allow a newer login
  // to race ahead of that response and then have its fresh cookie removed.
  if (adminLogoutInFlight) {
    setStatus('Signing out...');
    return;
  }
  const form = new FormData(loginForm);
  const password = String(form.get('password') || '');
  setStatus('Checking...');
  try {
    await fetchJson('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
      sessionBound: false,
    });
    loginForm.reset();
    beginAdminSession();
    await loadAuthenticatedDashboard();
  } catch (error) {
    if (!dashboard?.hidden) showLogin(adminErrorMessage(error, 'Dashboard load failed.'));
    else setStatus(adminErrorMessage(error, 'Login failed.'), true);
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
    if (tab === 'pro-rooms' && !proGrantCampaignLoaded) {
      loadProGrantCampaignStatus().catch((error) => {
        setProGrantCampaignMessage(
          adminErrorMessage(error, 'PRO grant campaign refresh failed.'),
          true,
        );
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

serviceStatusTrigger?.addEventListener('click', () => {
  openServiceStatusDialog(serviceStatusTrigger).catch(() => {});
});

for (const button of serviceStatusCancelBtns) {
  button.addEventListener('click', () => closeServiceStatusDialog());
}

serviceStatusDialog?.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeServiceStatusDialog();
});

serviceStatusDialog?.addEventListener('close', finishServiceStatusDialogClose);

serviceStatusPreviewBtn?.addEventListener('click', () => {
  window.open('/admin/maintenance-preview', '_blank', 'noopener');
});

serviceStatusForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  saveServiceStatus().catch(() => {});
});

if (!serviceStatusForm || serviceStatusConfirmBtn?.type !== 'submit') {
  serviceStatusConfirmBtn?.addEventListener('click', () => {
    saveServiceStatus().catch(() => {});
  });
}

mountProGrantCampaignPanel();
renderProGrantCampaignState(null);

proGrantCampaignNewBtn?.addEventListener('click', openProGrantCampaignForm);
proGrantCampaignImportBtn?.addEventListener('click', () => {
  if (!proGrantCampaignImportInput) return;
  proGrantCampaignImportInput.value = '';
  proGrantCampaignImportInput.click();
});
proGrantCampaignImportInput?.addEventListener('change', () => {
  const file = proGrantCampaignImportInput.files?.[0];
  importProGrantVoucherExport(file)
    .catch((error) => {
      setProGrantCampaignMessage(adminErrorMessage(error, '코드 파일을 불러오지 못했어요.'), true);
    })
    .finally(() => {
      proGrantCampaignImportInput.value = '';
    });
});
proGrantCampaignFormCancelBtn?.addEventListener('click', closeProGrantCampaignForm);
proGrantCampaignFormEl?.addEventListener('input', (event) => {
  if (['slug', 'roomStartCode', 'roomCount'].includes(event.target?.name)) {
    updateProGrantCampaignFormPreview();
  }
});
proGrantCampaignFormEl?.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    stageProGrantCampaignFromForm();
  } catch (error) {
    setProGrantCampaignMessage(adminErrorMessage(error, '이벤트 정보를 확인해 주세요.'), true);
  }
});
proGrantCampaignVerifyBtn?.addEventListener('click', () => {
  verifyProGrantCampaignPool().catch(() => {});
});
proGrantCampaignCreateBtn?.addEventListener('click', () => {
  createAndDownloadProGrantVouchers().catch(() => {});
});
proGrantCampaignApplyBtn?.addEventListener('click', () => {
  applyPendingProGrantVoucherBatch().catch(() => {});
});
proGrantCampaignPauseBtn?.addEventListener('click', () => {
  const selected = selectedProGrantCampaign();
  const campaign = selected?.campaign || selected;
  const counts = normalizedProGrantCounts(selected);
  const next =
    campaign?.status === 'paused' || (campaign?.status === 'draft' && counts.total > 0)
      ? 'active'
      : 'paused';
  setProGrantCampaignOperationalStatus(next).catch((error) => {
    setProGrantCampaignMessage(adminErrorMessage(error, '이벤트 상태를 바꾸지 못했어요.'), true);
  });
});
proGrantCampaignEndBtn?.addEventListener('click', () => {
  setProGrantCampaignOperationalStatus('ended').catch((error) => {
    setProGrantCampaignMessage(adminErrorMessage(error, '이벤트를 종료하지 못했어요.'), true);
  });
});
proGrantCampaignRevokeBtn?.addEventListener('click', () => {
  revokeProGrantCampaign().catch((error) => {
    setProGrantCampaignMessage(adminErrorMessage(error, '미사용 코드를 폐기하지 못했어요.'), true);
  });
});
proGrantCampaignDownloadBtn?.addEventListener('click', () => {
  downloadProGrantVoucherExport();
});
proGrantCampaignCopyBtn?.addEventListener('click', () => {
  copyProGrantVoucherExport()
    .then((copied) =>
      setProGrantCampaignMessage(
        copied ? '방 번호와 리딤 코드를 복사했어요.' : '클립보드를 사용할 수 없어요.',
        !copied,
      ),
    )
    .catch(() => setProGrantCampaignMessage('복사하지 못했어요.', true));
});
proGrantCampaignLinkCopyBtn?.addEventListener('click', () => {
  const campaign = selectedProGrantCampaign()?.campaign || selectedProGrantCampaign();
  const value = campaign?.slug ? proGrantCampaignPublicUrl(campaign.slug) : '';
  if (!value || !navigator.clipboard?.writeText) {
    setProGrantCampaignMessage('클립보드를 사용할 수 없어요.', true);
    return;
  }
  navigator.clipboard
    .writeText(value)
    .then(() => setProGrantCampaignMessage('이벤트 페이지 주소를 복사했어요.'))
    .catch(() => setProGrantCampaignMessage('주소를 복사하지 못했어요.', true));
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
  clearAnnouncementExpiryTimer();
  clearServiceStatusSettleTimer();
  closeServiceStatusDialog({ restoreFocus: false, force: true });
  closeProRoomDestroyDialog({ restoreFocus: false });
  closeProRoomLegacyOwnerDetachDialog({ restoreFocus: false });
  closeProRoomTransferDialog({ restoreFocus: false });
  clearProRoomClaimState();
  clearAllProRoomApiSecrets();
  pendingProGrantVoucherExport = null;
});
window.addEventListener('beforeunload', (event) => {
  if (pendingProGrantVoucherExport) {
    event.preventDefault();
    event.returnValue = '';
    return;
  }
  clearAnnouncementExpiryTimer();
  clearServiceStatusSettleTimer();
  closeServiceStatusDialog({ restoreFocus: false, force: true });
  closeProRoomDestroyDialog({ restoreFocus: false });
  closeProRoomLegacyOwnerDetachDialog({ restoreFocus: false });
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
  if (adminLogoutInFlight) return;
  clearProRoomClaimState();
  invalidateAdminSession();
  showLogin('Signing out...', { invalidateSession: false });
  setLoginFormDisabled(true);
  const logoutRequest = fetchJson('/api/admin/logout', {
    method: 'POST',
    sessionBound: false,
  }).catch(() => {});
  adminLogoutInFlight = logoutRequest;
  try {
    await logoutRequest;
  } finally {
    if (adminLogoutInFlight === logoutRequest) {
      adminLogoutInFlight = null;
      setLoginFormDisabled(false);
      if (dashboard?.hidden) setStatus('');
    }
  }
});

init();
