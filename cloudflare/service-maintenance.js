export const SERVICE_CONTROL_OBJECT_NAME = 'musixquare-global-service-control-v1';
export const SERVICE_CONTROL_STATUS_PATH = '/internal/service-maintenance/v1/status';
export const SERVICE_CONTROL_STATE_PATH = '/internal/service-maintenance/v1/state';
export const ADMIN_ANNOUNCEMENT_STATUS_PATH = '/internal/admin-announcement/v1/status';
export const ADMIN_ANNOUNCEMENT_STATE_PATH = '/internal/admin-announcement/v1/state';

const SERVICE_CONTROL_CACHE_TTL_MS = 1_000;
const ADMIN_ANNOUNCEMENT_CACHE_TTL_MS = 30_000;
const ADMIN_ANNOUNCEMENT_FAILURE_CACHE_TTL_MS = 1_000;
const ADMIN_ANNOUNCEMENT_HISTORY_LIMIT = 100;
const ADMIN_ANNOUNCEMENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
// 100 canonical history rows can legitimately contain 280 JSON-escaped
// message code units each. Keep this above that worst case while still
// bounding a corrupted internal response.
const SERVICE_CONTROL_RESPONSE_MAX_BYTES = 256 * 1024;
export const SERVICE_CONTROL_READ_TIMEOUT_MS = 2_000;
// This is only the worst-case edge/isolate cache propagation window. It is
// deliberately not presented as a storage-write drain: an R2 PUT authorized
// before maintenance begins bypasses Workers and may still finish afterward.
const SERVICE_CONTROL_EDGE_PROPAGATION_MS = 2_000;
const SERVICE_CONTROL_ORIGIN = 'https://service-control.internal';
const SERVICE_MAINTENANCE_RETRY_AFTER_SECONDS = 60;

let serviceStatusCacheByBinding = new WeakMap();
let adminAnnouncementCacheByBinding = new WeakMap();

const localizedDescriptions = Object.freeze({
  de: 'Wir führen gerade eine Serviceprüfung durch. Bitte versuche es gleich noch einmal.',
  en: 'We’re carrying out a service check. Please try again shortly.',
  es: 'Estamos realizando una revisión del servicio. Vuelve a intentarlo en breve.',
  fr: 'Nous effectuons une vérification du service. Réessayez dans quelques instants.',
  id: 'Kami sedang melakukan pemeriksaan layanan. Silakan coba lagi sebentar lagi.',
  it: 'Stiamo eseguendo un controllo del servizio. Riprova tra poco.',
  ja: 'サービスの点検を行っています。しばらくしてからもう一度お試しください。',
  ko: '안전한 서비스 점검을 진행 중이에요. 잠시 후 다시 시도해 주세요.',
  nl: 'We voeren een servicecontrole uit. Probeer het binnenkort opnieuw.',
  pl: 'Trwa kontrola usługi. Spróbuj ponownie za chwilę.',
  'pt-br': 'Estamos realizando uma verificação do serviço. Tente novamente em instantes.',
  ru: 'Мы проводим проверку сервиса. Повторите попытку чуть позже.',
  th: 'เรากำลังตรวจสอบบริการ โปรดลองอีกครั้งในอีกสักครู่',
  tr: 'Hizmet kontrolü yapıyoruz. Lütfen kısa süre sonra tekrar deneyin.',
  vi: 'Chúng tôi đang kiểm tra dịch vụ. Vui lòng thử lại sau ít phút.',
  'zh-hans': '我们正在进行服务检查，请稍后再试。',
  'zh-hant': '我們正在進行服務檢查，請稍後再試。',
});

export function inactiveServiceMaintenanceState() {
  return {
    enabled: false,
    revision: 0,
    updatedAt: null,
    activatedAt: null,
    settlesAt: null,
    controlUnavailable: true,
  };
}

export function normalizeServiceMaintenanceState(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.enabled !== 'boolean') return null;
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) return null;
  const updatedAt = value.updatedAt === null ? null : Number(value.updatedAt);
  const activatedAt = value.activatedAt === null ? null : Number(value.activatedAt);
  if (updatedAt !== null && (!Number.isSafeInteger(updatedAt) || updatedAt <= 0)) return null;
  if (activatedAt !== null && (!Number.isSafeInteger(activatedAt) || activatedAt <= 0)) return null;
  if (value.enabled && activatedAt === null) return null;
  return {
    enabled: value.enabled,
    revision: value.revision,
    updatedAt,
    activatedAt,
    settlesAt: updatedAt === null ? null : updatedAt + SERVICE_CONTROL_EDGE_PROPAGATION_MS,
  };
}

function serviceControlBinding(env) {
  const binding = env?.MUSIXQUARE_SERVICE_CONTROL;
  return binding && (typeof binding === 'object' || typeof binding === 'function') ? binding : null;
}

function serviceControlStub(binding) {
  if (typeof binding.getByName === 'function') {
    return binding.getByName(SERVICE_CONTROL_OBJECT_NAME);
  }
  if (typeof binding.idFromName !== 'function' || typeof binding.get !== 'function') return null;
  return binding.get(binding.idFromName(SERVICE_CONTROL_OBJECT_NAME));
}

function unavailableServiceMaintenanceState() {
  return {
    enabled: true,
    revision: 0,
    updatedAt: null,
    activatedAt: null,
    settlesAt: null,
    controlUnavailable: true,
  };
}

function serviceStatusCache(binding) {
  let cache = serviceStatusCacheByBinding.get(binding);
  if (!cache) {
    cache = {
      value: null,
      expiresAt: 0,
      refresh: null,
      refreshVersion: -1,
      version: 0,
      mutationGeneration: 0,
      activeMutationGeneration: null,
      canonicalRevision: -1,
      canonicalValue: null,
    };
    serviceStatusCacheByBinding.set(binding, cache);
  }
  return cache;
}

function rememberCanonicalServiceStatus(cache, state) {
  if (
    !state ||
    state.controlUnavailable === true ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    state.revision <= cache.canonicalRevision
  ) {
    return false;
  }
  cache.canonicalRevision = state.revision;
  cache.canonicalValue = state;
  return true;
}

function beginServiceStatusMutation(binding) {
  const cache = serviceStatusCache(binding);
  const generation = cache.mutationGeneration + 1;
  cache.mutationGeneration = generation;
  cache.activeMutationGeneration = generation;
  cache.version += 1;
  cache.value = unavailableServiceMaintenanceState();
  cache.expiresAt = Date.now() + SERVICE_CONTROL_CACHE_TTL_MS;
  return generation;
}

function cancelServiceControlBody(reader) {
  try {
    Promise.resolve(reader?.cancel()).catch(() => {});
  } catch {
    // Cancellation is best-effort and must never delay the fail-closed result.
  }
}

async function readServiceControlJson(response, registerReader) {
  const length = response.headers.get('content-length');
  if (
    length !== null &&
    (!/^\d+$/.test(length.trim()) || Number(length) > SERVICE_CONTROL_RESPONSE_MAX_BYTES)
  ) {
    cancelServiceControlBody(response.body);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  registerReader(reader);
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (
        !(value instanceof Uint8Array) ||
        value.byteLength > SERVICE_CONTROL_RESPONSE_MAX_BYTES - totalBytes
      ) {
        cancelServiceControlBody(reader);
        return null;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } catch {
    cancelServiceControlBody(reader);
    return null;
  } finally {
    registerReader(null);
    try {
      reader.releaseLock();
    } catch {
      // A timed-out or failed body can already have released its lock.
    }
  }
  try {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

async function fetchServiceControlResponse(stub, request) {
  let timeoutId = null;
  let activeReader = null;
  let timedOut = false;
  const responseOutcome = Promise.resolve()
    .then(() => stub.fetch(request))
    // Promise.race keeps handlers on the losing promise, but normalize both
    // branches explicitly so a binding that rejects after the timeout can
    // never surface as an unhandled rejection.
    .then(
      async (response) => {
        if (timedOut) {
          cancelServiceControlBody(response.body);
          return { kind: 'unavailable' };
        }
        const payload = await readServiceControlJson(response, (reader) => {
          activeReader = reader;
        });
        return timedOut ? { kind: 'unavailable' } : { kind: 'response', response, payload };
      },
      () => ({ kind: 'unavailable' }),
    );
  const timeoutOutcome = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      cancelServiceControlBody(activeReader);
      resolve({ kind: 'unavailable' });
    }, SERVICE_CONTROL_READ_TIMEOUT_MS);
  });

  try {
    return await Promise.race([responseOutcome, timeoutOutcome]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

async function fetchServiceControlStatus(stub) {
  return fetchServiceControlResponse(
    stub,
    new Request(`${SERVICE_CONTROL_ORIGIN}${SERVICE_CONTROL_STATUS_PATH}`, { method: 'GET' }),
  );
}

async function fetchServiceMaintenanceState(binding) {
  try {
    const stub = serviceControlStub(binding);
    if (!stub || typeof stub.fetch !== 'function') return unavailableServiceMaintenanceState();
    const outcome = await fetchServiceControlStatus(stub);
    if (outcome.kind !== 'response') return unavailableServiceMaintenanceState();
    const { response } = outcome;
    if (!response.ok) return unavailableServiceMaintenanceState();
    const payload = outcome.payload;
    const normalized = normalizeServiceMaintenanceState(payload?.serviceStatus || payload);
    return normalized || unavailableServiceMaintenanceState();
  } catch {
    return unavailableServiceMaintenanceState();
  }
}

export async function readServiceMaintenance(env, options = {}) {
  const binding = serviceControlBinding(env);
  // Unit tests, local development, and bootstrap deployments may intentionally
  // omit the binding. Every production Worker config binds the control object.
  if (!binding) return inactiveServiceMaintenanceState();

  const now = Date.now();
  const cache = serviceStatusCache(binding);
  // A local mutation may be enabling maintenance. Until its bounded outcome
  // is known, an older status response must not reopen the request gate.
  if (cache.activeMutationGeneration !== null) return cache.value;
  if (options.fresh !== true && cache.value && cache.expiresAt > now) return cache.value;
  if (!cache.refresh || cache.refreshVersion !== cache.version) {
    const version = cache.version;
    const refresh = fetchServiceMaintenanceState(binding)
      .then((value) => {
        const advanced = rememberCanonicalServiceStatus(cache, value);
        // A maintenance mutation is authoritative over any read that began on
        // the previous generation. Returning that old value could reopen the
        // gate after maintenance was enabled.
        if (cache.version !== version) {
          if (
            advanced &&
            cache.activeMutationGeneration === null &&
            cache.value?.controlUnavailable !== true
          ) {
            cache.value = cache.canonicalValue;
            cache.expiresAt = Date.now() + SERVICE_CONTROL_CACHE_TTL_MS;
          }
          return cache.value || unavailableServiceMaintenanceState();
        }
        cache.value = value.controlUnavailable === true ? value : cache.canonicalValue || value;
        cache.expiresAt = Date.now() + SERVICE_CONTROL_CACHE_TTL_MS;
        return cache.value;
      })
      .finally(() => {
        if (cache.refresh === refresh) {
          cache.refresh = null;
          cache.refreshVersion = -1;
        }
      });
    cache.refresh = refresh;
    cache.refreshVersion = version;
  }
  return cache.refresh;
}

function updateCachedServiceStatus(binding, state, mutationGeneration) {
  const cache = serviceStatusCache(binding);
  const advanced = rememberCanonicalServiceStatus(cache, state);
  // Responses can complete out of order even though the DO committed them in
  // order. A superseded local call cannot replace a newer local outcome, but
  // it can carry a still-newer canonical revision committed elsewhere.
  if (cache.activeMutationGeneration !== mutationGeneration) {
    if (
      advanced &&
      cache.activeMutationGeneration === null &&
      cache.value?.controlUnavailable !== true
    ) {
      cache.version += 1;
      cache.value = cache.canonicalValue;
      cache.expiresAt = Date.now() + SERVICE_CONTROL_CACHE_TTL_MS;
    }
    return;
  }
  cache.activeMutationGeneration = null;
  cache.version += 1;
  cache.value = state.controlUnavailable === true ? state : cache.canonicalValue || state;
  cache.expiresAt = Date.now() + SERVICE_CONTROL_CACHE_TTL_MS;
}

export async function updateServiceMaintenance(env, input) {
  const binding = serviceControlBinding(env);
  if (!binding) {
    return { status: 'unavailable', state: inactiveServiceMaintenanceState() };
  }
  const mutationGeneration = beginServiceStatusMutation(binding);

  try {
    const stub = serviceControlStub(binding);
    if (!stub || typeof stub.fetch !== 'function') {
      const state = unavailableServiceMaintenanceState();
      updateCachedServiceStatus(binding, state, mutationGeneration);
      return { status: 'unavailable', state };
    }
    const outcome = await fetchServiceControlResponse(
      stub,
      new Request(`${SERVICE_CONTROL_ORIGIN}${SERVICE_CONTROL_STATE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: input?.enabled,
          expectedRevision: input?.expectedRevision,
          requestId: input?.requestId,
        }),
      }),
    );
    if (outcome.kind !== 'response') {
      const state = unavailableServiceMaintenanceState();
      updateCachedServiceStatus(binding, state, mutationGeneration);
      return { status: 'unavailable', state };
    }
    const { response, payload } = outcome;
    const state = normalizeServiceMaintenanceState(payload?.serviceStatus || payload?.state);
    if (response.ok && state) {
      updateCachedServiceStatus(binding, state, mutationGeneration);
      return { status: 'ok', state };
    }
    if (response.status === 409 && state) {
      updateCachedServiceStatus(binding, state, mutationGeneration);
      return { status: 'conflict', state };
    }
    const unavailable = unavailableServiceMaintenanceState();
    updateCachedServiceStatus(binding, unavailable, mutationGeneration);
    return { status: 'unavailable', state: unavailable };
  } catch {
    const state = unavailableServiceMaintenanceState();
    updateCachedServiceStatus(binding, state, mutationGeneration);
    return { status: 'unavailable', state };
  }
}

async function callAdminAnnouncementControl(env, path, init) {
  const binding = serviceControlBinding(env);
  if (!binding) return { status: 'unbound', payload: null };
  try {
    const stub = serviceControlStub(binding);
    if (!stub || typeof stub.fetch !== 'function') {
      return { status: 'unavailable', payload: null };
    }
    const outcome = await fetchServiceControlResponse(
      stub,
      new Request(`${SERVICE_CONTROL_ORIGIN}${path}`, init),
    );
    if (outcome.kind !== 'response') return { status: 'unavailable', payload: null };
    const { response, payload } = outcome;
    const canonicalRevision = canonicalAdminAnnouncementRevision(payload);
    if (response.ok && canonicalRevision !== null) return { status: 'ok', payload };
    if (response.status === 409 && canonicalRevision !== null) {
      return { status: 'conflict', payload };
    }
    if (response.status === 409) return { status: 'unavailable', payload };
    if (response.status >= 400 && response.status < 500) {
      return { status: 'rejected', payload, responseStatus: response.status };
    }
    return { status: 'unavailable', payload };
  } catch {
    return { status: 'unavailable', payload: null };
  }
}

function adminAnnouncementCache(binding) {
  let cache = adminAnnouncementCacheByBinding.get(binding);
  if (!cache) {
    cache = {
      value: null,
      expiresAt: 0,
      refresh: null,
      refreshVersion: -1,
      version: 0,
      mutationGeneration: 0,
      activeMutationGeneration: null,
      canonicalRevision: -1,
      canonicalValue: null,
    };
    adminAnnouncementCacheByBinding.set(binding, cache);
  }
  return cache;
}

function canonicalAdminAnnouncementRecord(value, { allowEmpty = false, history = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    typeof value.id !== 'string' ||
    typeof value.message !== 'string' ||
    typeof value.enabled !== 'boolean' ||
    typeof value.updatedAt !== 'string' ||
    value.message !== value.message.trim() ||
    value.message.length > 280
  ) {
    return null;
  }
  const id = value.id;
  if (!id) {
    if (
      !allowEmpty ||
      value.message ||
      value.enabled ||
      value.expiresAt !== null ||
      value.updatedAt
    ) {
      return null;
    }
  } else {
    const updatedAtMs = new Date(value.updatedAt).getTime();
    if (
      !ADMIN_ANNOUNCEMENT_ID_RE.test(id) ||
      Number.isNaN(updatedAtMs) ||
      new Date(updatedAtMs).toISOString() !== value.updatedAt
    ) {
      return null;
    }
  }
  if (value.enabled && !value.message) return null;
  if (value.expiresAt !== null) {
    if (typeof value.expiresAt !== 'string') return null;
    const expiresAtMs = new Date(value.expiresAt).getTime();
    if (Number.isNaN(expiresAtMs) || new Date(expiresAtMs).toISOString() !== value.expiresAt) {
      return null;
    }
  }
  const record = {
    id,
    message: value.message,
    enabled: value.enabled,
    expiresAt: value.expiresAt,
    updatedAt: value.updatedAt,
  };
  if (!history) return record;
  const action =
    record.enabled && record.message ? 'published' : record.message ? 'disabled' : 'cleared';
  return value.action === action ? { ...record, action } : null;
}

function canonicalAdminAnnouncementRevision(payload) {
  const state = payload?.announcementState;
  if (
    !state ||
    typeof state !== 'object' ||
    Array.isArray(state) ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !Array.isArray(state.history) ||
    state.history.length > ADMIN_ANNOUNCEMENT_HISTORY_LIMIT
  ) {
    return null;
  }
  const announcement = canonicalAdminAnnouncementRecord(state.announcement, { allowEmpty: true });
  const history = state.history.map((entry) =>
    canonicalAdminAnnouncementRecord(entry, { history: true }),
  );
  if (!announcement || history.some((entry) => entry === null)) return null;
  if (state.revision === 0) return !announcement.id && history.length === 0 ? 0 : null;
  const head = history[0];
  if (
    !announcement.id ||
    !head ||
    head.id !== announcement.id ||
    head.message !== announcement.message ||
    head.enabled !== announcement.enabled ||
    head.expiresAt !== announcement.expiresAt ||
    head.updatedAt !== announcement.updatedAt ||
    head.action !==
      (announcement.enabled && announcement.message
        ? 'published'
        : announcement.message
          ? 'disabled'
          : 'cleared')
  ) {
    return null;
  }
  return state.revision;
}

function rememberCanonicalAdminAnnouncement(cache, result) {
  if (result?.status !== 'ok' && result?.status !== 'conflict') return false;
  const revision = canonicalAdminAnnouncementRevision(result?.payload);
  if (!Number.isSafeInteger(revision) || revision < 0 || revision <= cache.canonicalRevision) {
    return false;
  }
  cache.canonicalRevision = revision;
  cache.canonicalValue = { status: 'ok', payload: result.payload };
  return true;
}

export async function readAdminAnnouncementControl(env, options = {}) {
  const binding = serviceControlBinding(env);
  if (!binding) return { status: 'unbound', payload: null };
  const cache = adminAnnouncementCache(binding);
  if (cache.activeMutationGeneration !== null) {
    return cache.value || { status: 'unavailable', payload: null };
  }
  const now = Date.now();
  if (options.fresh !== true && cache.value && cache.expiresAt > now) return cache.value;
  if (!cache.refresh || cache.refreshVersion !== cache.version) {
    const version = cache.version;
    const refresh = callAdminAnnouncementControl(env, ADMIN_ANNOUNCEMENT_STATUS_PATH, {
      method: 'GET',
    })
      .then((result) => {
        const advanced = rememberCanonicalAdminAnnouncement(cache, result);
        if (cache.version !== version) {
          if (advanced && cache.activeMutationGeneration === null && cache.value?.status === 'ok') {
            cache.value = cache.canonicalValue;
            cache.expiresAt = Date.now() + ADMIN_ANNOUNCEMENT_CACHE_TTL_MS;
          }
          return cache.value || { status: 'unavailable', payload: null };
        }
        cache.value = result.status === 'ok' ? cache.canonicalValue || result : result;
        cache.expiresAt =
          Date.now() +
          (result.status === 'ok'
            ? ADMIN_ANNOUNCEMENT_CACHE_TTL_MS
            : ADMIN_ANNOUNCEMENT_FAILURE_CACHE_TTL_MS);
        return result;
      })
      .finally(() => {
        // A mutation can advance the cache generation and start a replacement
        // read before this older request settles. Only clear the refresh that
        // this promise installed.
        if (cache.refresh === refresh) {
          cache.refresh = null;
          cache.refreshVersion = -1;
        }
      });
    cache.refresh = refresh;
    cache.refreshVersion = version;
  }
  return cache.refresh;
}

export async function updateAdminAnnouncementControl(env, input) {
  const binding = serviceControlBinding(env);
  let mutationGeneration = null;
  if (binding) {
    const cache = adminAnnouncementCache(binding);
    mutationGeneration = cache.mutationGeneration + 1;
    cache.mutationGeneration = mutationGeneration;
    cache.activeMutationGeneration = mutationGeneration;
    cache.version += 1;
    cache.value = null;
    cache.expiresAt = 0;
  }
  const result = await callAdminAnnouncementControl(env, ADMIN_ANNOUNCEMENT_STATE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: input?.message,
      enabled: input?.enabled,
      expiresAt: input?.expiresAt,
      expectedRevision: input?.expectedRevision,
      requestId: input?.requestId,
      baseHistory: input?.baseHistory,
    }),
  });
  if (binding) {
    const cache = adminAnnouncementCache(binding);
    const advanced = rememberCanonicalAdminAnnouncement(cache, result);
    if (cache.activeMutationGeneration !== mutationGeneration) {
      if (advanced && cache.activeMutationGeneration === null && cache.value?.status === 'ok') {
        cache.version += 1;
        cache.value = cache.canonicalValue;
        cache.expiresAt = Date.now() + ADMIN_ANNOUNCEMENT_CACHE_TTL_MS;
      }
      return result;
    }
    cache.activeMutationGeneration = null;
    cache.version += 1;
    if (
      (result.status === 'ok' || result.status === 'conflict') &&
      result.payload &&
      typeof result.payload === 'object'
    ) {
      cache.value = cache.canonicalValue || { status: 'ok', payload: result.payload };
      cache.expiresAt = Date.now() + ADMIN_ANNOUNCEMENT_CACHE_TTL_MS;
    } else {
      // A timeout can be outcome-unknown. Force the next read onto the new
      // generation instead of serving a positive cache from before the POST.
      cache.value = null;
      cache.expiresAt = 0;
    }
  }
  return result;
}

function normalizedLanguageTag(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
}

function matchedMaintenanceLanguage(request) {
  const weighted = String(request?.headers?.get('Accept-Language') || '')
    .split(',')
    .map((part, index) => {
      const [rawTag, ...parameters] = part.trim().split(';');
      const qualityParameter = parameters.find((value) => /^\s*q=/i.test(value));
      const quality = qualityParameter ? Number(qualityParameter.split('=')[1]) : 1;
      return { tag: normalizedLanguageTag(rawTag), quality, index };
    })
    .filter((item) => item.tag && Number.isFinite(item.quality) && item.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index);

  for (const { tag } of weighted) {
    if (tag === '*') return 'en';
    if (tag === 'pt-br' || tag.startsWith('pt-br-')) return 'pt-br';
    if (tag === 'zh-hant' || tag.startsWith('zh-hant-') || /^(zh-(tw|hk|mo))(?:-|$)/.test(tag)) {
      return 'zh-hant';
    }
    if (tag === 'zh-hans' || tag.startsWith('zh-hans-') || /^(zh-(cn|sg))(?:-|$)/.test(tag)) {
      return 'zh-hans';
    }
    const primary = tag.split('-')[0];
    if (primary === 'zh') return 'zh-hans';
    if (Object.hasOwn(localizedDescriptions, primary)) return primary;
  }
  return 'en';
}

function maintenanceHeaders(contentType, language) {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    'Content-Language': language,
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Content-Type': contentType,
    'Cross-Origin-Opener-Policy': 'same-origin',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'Retry-After': String(SERVICE_MAINTENANCE_RETRY_AFTER_SECONDS),
    Vary: 'Accept-Language',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow',
  };
}

function maintenanceHtml(language) {
  const description = localizedDescriptions[language] || localizedDescriptions.en;
  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>MUSIXQUARE · Service check</title>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08090b;color:#f7f7f8;font-family:Inter,Pretendard,system-ui,-apple-system,sans-serif;padding:28px}.card{width:min(620px,100%);padding:clamp(28px,7vw,64px);border:1px solid #25272d;border-radius:28px;background:linear-gradient(145deg,#15171c,#0d0e12);box-shadow:0 28px 90px #0009}.mark{display:flex;align-items:center;gap:10px;margin-bottom:34px;font-size:12px;font-weight:800;letter-spacing:.2em}.dot{width:9px;height:9px;border-radius:50%;background:#ff4d5f;box-shadow:0 0 20px #ff4d5faa}h1{margin:0;font-size:clamp(29px,6vw,48px);line-height:1.08;letter-spacing:-.04em}p{margin:18px 0 0;color:#b8bbc5;font-size:clamp(16px,3.5vw,19px);line-height:1.65}.pulse{margin-top:38px;width:44px;height:3px;border-radius:999px;background:#ff4d5f;animation:pulse 1.4s ease-in-out infinite}@keyframes pulse{50%{opacity:.25;transform:scaleX(.45)}}@media(prefers-reduced-motion:reduce){.pulse{animation:none}}
  </style>
</head>
<body>
  <main class="card">
    <div class="mark"><span class="dot" aria-hidden="true"></span>MUSIXQUARE</div>
    <h1>Musixquare is temporarily unavailable.</h1>
    <p>${description}</p>
    <div class="pulse" aria-hidden="true"></div>
  </main>
</body>
</html>`;
}

export function serviceMaintenanceResponse(request, state = {}, options = {}) {
  const language = matchedMaintenanceLanguage(request);
  const format = options.format || 'auto';
  const acceptsHtml = String(request?.headers?.get('Accept') || '')
    .toLowerCase()
    .includes('text/html');
  const useHtml = format === 'html' || (format === 'auto' && acceptsHtml);
  if (useHtml) {
    return new Response(request?.method === 'HEAD' ? null : maintenanceHtml(language), {
      status: 503,
      headers: maintenanceHeaders('text/html; charset=utf-8', language),
    });
  }

  const error = state.controlUnavailable
    ? 'SERVICE_MAINTENANCE_STATUS_UNAVAILABLE'
    : 'SERVICE_MAINTENANCE';
  const body = JSON.stringify({
    error,
    maintenance: true,
    revision: Number.isSafeInteger(state.revision) ? state.revision : 0,
    activatedAt: Number.isSafeInteger(state.activatedAt) ? state.activatedAt : null,
    settlesAt: Number.isSafeInteger(state.settlesAt) ? state.settlesAt : null,
  });
  return new Response(request?.method === 'HEAD' ? null : body, {
    status: 503,
    headers: maintenanceHeaders('application/json; charset=utf-8', language),
  });
}

export async function gateServiceMaintenance(request, env, options = {}) {
  const state = await readServiceMaintenance(env, options);
  return state.enabled ? serviceMaintenanceResponse(request, state, options) : null;
}

export function clearServiceMaintenanceCacheForTests() {
  serviceStatusCacheByBinding = new WeakMap();
  adminAnnouncementCacheByBinding = new WeakMap();
}
