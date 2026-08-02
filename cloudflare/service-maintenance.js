export const SERVICE_CONTROL_OBJECT_NAME = 'musixquare-global-service-control-v1';
export const SERVICE_CONTROL_STATUS_PATH = '/internal/service-maintenance/v1/status';
export const SERVICE_CONTROL_STATE_PATH = '/internal/service-maintenance/v1/state';

const SERVICE_CONTROL_CACHE_TTL_MS = 1_000;
// This is only the worst-case edge/isolate cache propagation window. It is
// deliberately not presented as a storage-write drain: an R2 PUT authorized
// before maintenance begins bypasses Workers and may still finish afterward.
const SERVICE_CONTROL_EDGE_PROPAGATION_MS = 2_000;
const SERVICE_CONTROL_ORIGIN = 'https://service-control.internal';
const SERVICE_MAINTENANCE_RETRY_AFTER_SECONDS = 60;

let serviceStatusCacheByBinding = new WeakMap();

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
    settlesAt:
      updatedAt === null ? null : updatedAt + SERVICE_CONTROL_EDGE_PROPAGATION_MS,
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

async function fetchServiceMaintenanceState(binding) {
  try {
    const stub = serviceControlStub(binding);
    if (!stub || typeof stub.fetch !== 'function') return unavailableServiceMaintenanceState();
    const response = await stub.fetch(
      new Request(`${SERVICE_CONTROL_ORIGIN}${SERVICE_CONTROL_STATUS_PATH}`, { method: 'GET' }),
    );
    if (!response.ok) return unavailableServiceMaintenanceState();
    const payload = await response.json().catch(() => null);
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
  let cache = serviceStatusCacheByBinding.get(binding);
  if (!cache) {
    cache = { value: null, expiresAt: 0, refresh: null };
    serviceStatusCacheByBinding.set(binding, cache);
  }
  if (options.fresh !== true && cache.value && cache.expiresAt > now) return cache.value;
  if (!cache.refresh) {
    cache.refresh = fetchServiceMaintenanceState(binding)
      .then((value) => {
        cache.value = value;
        cache.expiresAt = Date.now() + SERVICE_CONTROL_CACHE_TTL_MS;
        return value;
      })
      .finally(() => {
        cache.refresh = null;
      });
  }
  return cache.refresh;
}

function updateCachedServiceStatus(binding, state) {
  let cache = serviceStatusCacheByBinding.get(binding);
  if (!cache) {
    cache = { value: null, expiresAt: 0, refresh: null };
    serviceStatusCacheByBinding.set(binding, cache);
  }
  cache.value = state;
  cache.expiresAt = Date.now() + SERVICE_CONTROL_CACHE_TTL_MS;
}

export async function updateServiceMaintenance(env, input) {
  const binding = serviceControlBinding(env);
  if (!binding) {
    return { status: 'unavailable', state: inactiveServiceMaintenanceState() };
  }

  try {
    const stub = serviceControlStub(binding);
    if (!stub || typeof stub.fetch !== 'function') {
      const state = unavailableServiceMaintenanceState();
      updateCachedServiceStatus(binding, state);
      return { status: 'unavailable', state };
    }
    const response = await stub.fetch(
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
    const payload = await response.json().catch(() => null);
    const state = normalizeServiceMaintenanceState(payload?.serviceStatus || payload?.state);
    if (response.ok && state) {
      updateCachedServiceStatus(binding, state);
      return { status: 'ok', state };
    }
    if (response.status === 409 && state) {
      updateCachedServiceStatus(binding, state);
      return { status: 'conflict', state };
    }
    const unavailable = unavailableServiceMaintenanceState();
    updateCachedServiceStatus(binding, unavailable);
    return { status: 'unavailable', state: unavailable };
  } catch {
    const state = unavailableServiceMaintenanceState();
    updateCachedServiceStatus(binding, state);
    return { status: 'unavailable', state };
  }
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
    if (
      tag === 'zh-hant' ||
      tag.startsWith('zh-hant-') ||
      /^(zh-(tw|hk|mo))(?:-|$)/.test(tag)
    ) {
      return 'zh-hant';
    }
    if (
      tag === 'zh-hans' ||
      tag.startsWith('zh-hans-') ||
      /^(zh-(cn|sg))(?:-|$)/.test(tag)
    ) {
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
  const acceptsHtml = String(request?.headers?.get('Accept') || '').toLowerCase().includes('text/html');
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
}
