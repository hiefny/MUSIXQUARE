export const SERVICE_CONTROL_OBJECT_NAME = 'musixquare-global-service-control-v1';
export const ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME = 'musixquare-global-admin-announcement-v1';
export const SERVICE_CONTROL_STATUS_PATH = '/internal/service-maintenance/v1/status';
export const SERVICE_CONTROL_STATE_PATH = '/internal/service-maintenance/v1/state';
export const SERVICE_CONTROL_STATUS_VERSION_HEADER = 'X-Musixquare-Service-Control-Version';
export const SERVICE_CONTROL_STATUS_ENABLED_HEADER = 'X-Musixquare-Service-Control-Enabled';
export const SERVICE_CONTROL_STATUS_REVISION_HEADER = 'X-Musixquare-Service-Control-Revision';
export const SERVICE_CONTROL_STATUS_UPDATED_AT_HEADER = 'X-Musixquare-Service-Control-Updated-At';
export const SERVICE_CONTROL_STATUS_ACTIVATED_AT_HEADER =
  'X-Musixquare-Service-Control-Activated-At';
export const ADMIN_ANNOUNCEMENT_STATUS_PATH = '/internal/admin-announcement/v1/status';
export const ADMIN_ANNOUNCEMENT_STATE_PATH = '/internal/admin-announcement/v1/state';
export const ADMIN_ANNOUNCEMENT_MIGRATION_HEADER = 'X-Musixquare-Admin-Announcement-Migration';
export const ABUSE_RATE_CONSUME_PATH = '/internal/abuse-rate/v1/consume';
export const ABUSE_RATE_IDEMPOTENT_CONSUME_PATH = '/internal/abuse-rate/v2/consume';
export const ABUSE_RATE_PAIR_CONSUME_PATH = '/internal/abuse-rate/v3/consume-pair';
export const ABUSE_RATE_RESPONSE_PROTOCOL_HEADER = 'X-Musixquare-Abuse-Rate-Response';
export const ABUSE_RATE_RESPONSE_RESULT_HEADER = 'X-Musixquare-Abuse-Rate-Result';
export const ABUSE_RATE_RESPONSE_PROTOCOL = 'headers-v1';

const SERVICE_CONTROL_CACHE_TTL_MS = 1_000;
const ADMIN_ANNOUNCEMENT_CACHE_TTL_MS = 30_000;
const ADMIN_ANNOUNCEMENT_FAILURE_CACHE_TTL_MS = 1_000;
const ADMIN_ANNOUNCEMENT_HISTORY_LIMIT = 100;
const ADMIN_ANNOUNCEMENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ADMIN_ANNOUNCEMENT_SOURCE_EMPTY_SEPARATED = 0;
const ADMIN_ANNOUNCEMENT_SOURCE_LEGACY = 1;
const ADMIN_ANNOUNCEMENT_SOURCE_POSITIVE_SEPARATED = 2;
// 100 canonical history rows can legitimately contain 280 JSON-escaped
// message code units each. Keep this above that worst case while still
// bounding a corrupted internal response.
const SERVICE_CONTROL_RESPONSE_MAX_BYTES = 256 * 1024;
export const SERVICE_CONTROL_READ_TIMEOUT_MS = 2_000;
// This is an operator-UI grace window, not a hard propagation bound. The App
// refreshes maintenance state off the public request path, so a cold isolate
// can admit traffic before its first snapshot arrives. An R2 PUT authorized
// before maintenance begins also bypasses Workers and may finish afterward.
const SERVICE_CONTROL_EDGE_PROPAGATION_MS = 2_000;
const SERVICE_CONTROL_ORIGIN = 'https://service-control.internal';
const ABUSE_RATE_OBJECT_PREFIX = 'musixquare-abuse-rate-v1';
const ABUSE_RATE_PAIR_OBJECT_PREFIX = 'musixquare-abuse-rate-pair-v1';
const ABUSE_RATE_OPERATION_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const ABUSE_RATE_OPERATION_HISTORY_LIMIT = 1024;
const ABUSE_RATE_PAIR_PRIMARY_LIMIT = 1024;
const ABUSE_RATE_RESPONSE_RESULT_MAX_LENGTH = 2_048;
const SERVICE_MAINTENANCE_RETRY_AFTER_SECONDS = 60;

type UnknownRecord = Record<string, unknown>;
type ServiceControlBinding = object;

interface ServiceControlReader {
  read(): unknown;
  cancel(): unknown;
  releaseLock(): void;
}

interface ServiceControlReadableBody {
  getReader(): unknown;
  cancel(): unknown;
}

type CancelableServiceControlBody =
  | ServiceControlReadableBody
  | ServiceControlReader
  | null
  | undefined;

interface ServiceControlHttpResponse {
  body: ServiceControlReadableBody | null;
  headers: { get(name: string): unknown };
  ok: boolean;
  status: number;
}

interface ServiceControlStub {
  fetch(request: Request): unknown;
}

interface ServiceControlResponse {
  kind: 'response';
  response: ServiceControlHttpResponse;
  payload: unknown;
}

interface ServiceControlUnavailable {
  kind: 'unavailable';
}

type ServiceControlOutcome = ServiceControlResponse | ServiceControlUnavailable;
const SERVICE_CONTROL_STATUS_HEADERS_ABSENT = Symbol('service-control-status-headers-absent');

export interface ServiceMaintenanceState {
  enabled: boolean;
  revision: number;
  updatedAt: number | null;
  activatedAt: number | null;
  /** Operator-UI grace deadline; not a hard traffic or direct-storage drain bound. */
  settlesAt: number | null;
  controlUnavailable?: boolean;
}

export interface ServiceMaintenanceEnvironment {
  readonly MUSIXQUARE_SERVICE_CONTROL?: unknown;
}

export interface AdminAnnouncementControlResult {
  status: 'ok' | 'conflict' | 'rejected' | 'unavailable' | 'unbound';
  payload: unknown;
  responseStatus?: number;
}

export interface AbuseRateCounterResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterSeconds: number;
}

export interface AbuseRateLimitInput {
  scope: string;
  identity: string;
  limit: number;
  windowMs: number;
  cost?: number;
  operationId?: string;
}

export type AbuseRateLimitResult =
  | ({ status: 'ok' } & AbuseRateCounterResult)
  | { status: 'unavailable' | 'unbound' };

export interface AbuseRateLimitPairInput {
  scope: string;
  identity: string;
  limit: number;
  windowMs: number;
  cost?: number;
  /**
   * Already-pseudonymous identity, 1-64 URL-safe characters. Its cost must
   * not exceed the primary cost so persisted pair-state accounting remains
   * canonically bounded by the primary counter.
   */
  secondary?: null | { identity: string; limit: number; cost?: number };
}

export type AbuseRateLimitPairResult =
  | {
      status: 'ok';
      allowed: boolean;
      deniedBy: 'primary' | 'secondary' | null;
      retryAfterSeconds: number;
      primary: AbuseRateCounterResult;
      secondary: AbuseRateCounterResult | null;
    }
  | { status: 'unavailable' | 'unbound' };

export interface ServiceMaintenanceUpdateInput {
  enabled: boolean;
  expectedRevision: number;
  requestId: string;
}

export interface ServiceMaintenanceUpdateResult {
  status: 'ok' | 'conflict' | 'unavailable';
  state: ServiceMaintenanceState;
}

export interface AdminAnnouncementUpdateInput {
  message: string;
  enabled: boolean;
  expiresAt: string | null;
  expectedRevision: number;
  requestId: string;
  baseHistory?: Array<Record<string, unknown>>;
}

interface ServiceMaintenanceReadOptions {
  fresh?: boolean;
}

export interface CachedServiceMaintenanceRead {
  state: ServiceMaintenanceState | null;
  refreshNeeded: boolean;
}

interface ServiceMaintenanceResponseOptions {
  format?: 'auto' | 'html' | 'json';
}

type ServiceMaintenanceGateOptions = ServiceMaintenanceReadOptions &
  ServiceMaintenanceResponseOptions;

interface ServiceStatusCache {
  value: ServiceMaintenanceState | null;
  expiresAt: number;
  refresh: Promise<ServiceMaintenanceState> | null;
  refreshVersion: number;
  version: number;
  mutationGeneration: number;
  activeMutationGeneration: number | null;
  uncertainMutations: Map<number, ServiceStatusMutationFence>;
  canonicalRevision: number;
  canonicalValue: ServiceMaintenanceState | null;
}

interface ServiceStatusMutationFence {
  expectedRevision: number;
  enabled: boolean;
  requestId: string;
}

type AdminAnnouncementSourcePriority = 0 | 1 | 2;
type AdminAnnouncementAction = 'published' | 'disabled' | 'cleared';

interface CanonicalAdminAnnouncementRecord {
  id: string;
  message: string;
  enabled: boolean;
  expiresAt: string | null;
  updatedAt: string;
  action?: AdminAnnouncementAction;
}

interface CanonicalAdminAnnouncementState {
  revision: number;
  announcement: CanonicalAdminAnnouncementRecord;
  history: CanonicalAdminAnnouncementRecord[];
  rawHistory: unknown[];
}

interface CanonicalAdminAnnouncementValue {
  status: 'ok';
  payload: unknown;
}

interface AdminAnnouncementCache {
  value: AdminAnnouncementControlResult | null;
  expiresAt: number;
  refresh: Promise<AdminAnnouncementControlResult> | null;
  refreshVersion: number;
  version: number;
  mutationGeneration: number;
  activeMutationGeneration: number | null;
  canonicalRevision: number;
  canonicalSourcePriority: number;
  canonicalValue: CanonicalAdminAnnouncementValue | null;
}

interface PreparedAdminAnnouncementMutation {
  result?: AdminAnnouncementControlResult;
  sourcePriority?: AdminAnnouncementSourcePriority;
  expectedRevision?: number | undefined;
  baseHistory?: unknown[] | undefined;
  migrating?: boolean | undefined;
}

let serviceStatusCacheByBinding = new WeakMap<ServiceControlBinding, ServiceStatusCache>();
let adminAnnouncementCacheByBinding = new WeakMap<ServiceControlBinding, AdminAnnouncementCache>();

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function recordProperty(value: unknown, property: string): unknown {
  return isUnknownRecord(value) ? value[property] : undefined;
}

function isServiceControlStub(value: unknown): value is ServiceControlStub {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof Reflect.get(value, 'fetch') === 'function'
  );
}

function isServiceControlReadableBody(value: unknown): value is ServiceControlReadableBody {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof Reflect.get(value, 'getReader') === 'function' &&
    typeof Reflect.get(value, 'cancel') === 'function'
  );
}

function isServiceControlReader(value: unknown): value is ServiceControlReader {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof Reflect.get(value, 'read') === 'function' &&
    typeof Reflect.get(value, 'cancel') === 'function' &&
    typeof Reflect.get(value, 'releaseLock') === 'function'
  );
}

function isServiceControlHttpResponse(value: unknown): value is ServiceControlHttpResponse {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const headers = Reflect.get(value, 'headers');
  const body = Reflect.get(value, 'body');
  return (
    headers !== null &&
    (typeof headers === 'object' || typeof headers === 'function') &&
    typeof Reflect.get(headers, 'get') === 'function' &&
    (body === null || isServiceControlReadableBody(body)) &&
    typeof Reflect.get(value, 'ok') === 'boolean' &&
    isSafeInteger(Reflect.get(value, 'status'))
  );
}

const localizedDescriptions = Object.freeze({
  ar: 'نجري فحصًا للخدمة حاليًا. يُرجى المحاولة مرة أخرى بعد قليل.',
  bg: 'В момента проверяваме услугата. Опитайте отново след малко.',
  bn: 'আমরা পরিষেবাটি পরীক্ষা করছি। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।',
  cs: 'Právě kontrolujeme službu. Zkuste to prosím za chvíli znovu.',
  de: 'Wir überprüfen gerade den Dienst. Bitte versuche es gleich noch einmal.',
  da: 'Vi gennemfører et servicetjek. Prøv igen om et øjeblik.',
  el: 'Πραγματοποιούμε έλεγχο της υπηρεσίας. Δοκιμάστε ξανά σε λίγο.',
  en: 'We’re carrying out a service check. Please try again shortly.',
  es: 'Estamos realizando una revisión del servicio. Vuelve a intentarlo en breve.',
  fa: 'در حال بررسی سرویس هستیم. لطفاً تا لحظاتی دیگر دوباره تلاش کنید.',
  fi: 'Tarkistamme parhaillaan palvelua. Yritä hetken kuluttua uudelleen.',
  fil: 'Sinusuri namin ang serbisyo. Pakisubukan ulit maya-maya.',
  fr: 'Nous effectuons une vérification du service. Réessayez dans quelques instants.',
  he: 'אנחנו מבצעים בדיקה של השירות. נסו שוב בעוד זמן קצר.',
  hi: 'हम सेवा की जाँच कर रहे हैं। कृपया थोड़ी देर बाद फिर से कोशिश करें।',
  hu: 'Éppen ellenőrizzük a szolgáltatást. Próbáld újra hamarosan.',
  id: 'Kami sedang memeriksa layanan. Silakan coba lagi sebentar lagi.',
  it: 'Stiamo controllando il servizio. Riprova tra poco.',
  ja: 'サービスの点検を行っています。しばらくしてからもう一度お試しください。',
  ko: '안전한 서비스 점검을 진행 중이에요. 잠시 후 다시 시도해 주세요.',
  gu: 'અમે સેવાની તપાસ કરી રહ્યા છીએ. કૃપા કરીને થોડીવાર પછી ફરી પ્રયાસ કરો.',
  kn: 'ನಾವು ಸೇವೆಯನ್ನು ಪರಿಶೀಲಿಸುತ್ತಿದ್ದೇವೆ. ದಯವಿಟ್ಟು ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',
  ms: 'Kami sedang menjalankan pemeriksaan perkhidmatan. Sila cuba lagi sebentar lagi.',
  ml: 'സേവനം പരിശോധിച്ചുകൊണ്ടിരിക്കുകയാണ്. ദയവായി അൽപ്പസമയത്തിന് ശേഷം വീണ്ടും ശ്രമിക്കുക.',
  mr: 'आम्ही सेवेची तपासणी करत आहोत. कृपया थोड्या वेळाने पुन्हा प्रयत्न करा.',
  nb: 'Vi gjennomfører en servicekontroll. Prøv igjen om en liten stund.',
  nl: 'We controleren momenteel de service. Probeer het over een ogenblik opnieuw.',
  pl: 'Sprawdzamy działanie usługi. Spróbuj ponownie za chwilę.',
  pa: 'ਅਸੀਂ ਸੇਵਾ ਦੀ ਜਾਂਚ ਕਰ ਰਹੇ ਹਾਂ। ਕਿਰਪਾ ਕਰਕੇ ਥੋੜ੍ਹੀ ਦੇਰ ਬਾਅਦ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ।',
  'pt-br': 'Estamos verificando o serviço. Tente novamente em instantes.',
  ru: 'Мы проводим проверку сервиса. Повторите попытку чуть позже.',
  ro: 'Verificăm serviciul în acest moment. Încearcă din nou în scurt timp.',
  ta: 'சேவையைச் சரிபார்த்து வருகிறோம். சிறிது நேரம் கழித்து மீண்டும் முயலவும்.',
  sv: 'Vi genomför en servicekontroll. Försök igen om en liten stund.',
  te: 'మేము సేవను తనిఖీ చేస్తున్నాము. దయచేసి కాసేపటి తర్వాత మళ్లీ ప్రయత్నించండి.',
  th: 'กำลังตรวจสอบบริการอยู่ ลองอีกครั้งในอีกสักครู่',
  tr: 'Hizmeti kontrol ediyoruz. Lütfen kısa süre sonra tekrar dene.',
  uk: 'Ми перевіряємо роботу сервісу. Спробуйте ще раз трохи згодом.',
  ur: 'ہم سروس کی جانچ کر رہے ہیں۔ براہِ کرم کچھ دیر بعد دوبارہ کوشش کریں۔',
  vi: 'Chúng tôi đang kiểm tra dịch vụ. Vui lòng thử lại sau giây lát.',
  'zh-hans': '我们正在检查服务，请稍后重试。',
  'zh-hant': '我們正在進行服務檢查，請稍後再試。',
});

type MaintenanceLanguage = keyof typeof localizedDescriptions;

function isMaintenanceLanguage(value: string): value is MaintenanceLanguage {
  return Object.hasOwn(localizedDescriptions, value);
}

export function inactiveServiceMaintenanceState(): ServiceMaintenanceState {
  return {
    enabled: false,
    revision: 0,
    updatedAt: null,
    activatedAt: null,
    settlesAt: null,
    controlUnavailable: true,
  };
}

export function normalizeServiceMaintenanceState(value: unknown): ServiceMaintenanceState | null {
  if (!isUnknownRecord(value)) return null;
  if (typeof value.enabled !== 'boolean') return null;
  if (!isSafeInteger(value.revision) || value.revision < 0) return null;
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

function serviceControlBinding(
  env: ServiceMaintenanceEnvironment | null | undefined,
): ServiceControlBinding | null {
  const binding = env?.MUSIXQUARE_SERVICE_CONTROL;
  return binding && (typeof binding === 'object' || typeof binding === 'function') ? binding : null;
}

function serviceControlStub(binding: ServiceControlBinding): unknown {
  const getByName = Reflect.get(binding, 'getByName');
  if (typeof getByName === 'function') {
    return Reflect.apply(getByName, binding, [SERVICE_CONTROL_OBJECT_NAME]);
  }
  const idFromName = Reflect.get(binding, 'idFromName');
  const get = Reflect.get(binding, 'get');
  if (typeof idFromName !== 'function' || typeof get !== 'function') return null;
  const id = Reflect.apply(idFromName, binding, [SERVICE_CONTROL_OBJECT_NAME]);
  return Reflect.apply(get, binding, [id]);
}

function namedServiceControlStub(binding: ServiceControlBinding, name: string): unknown {
  const getByName = Reflect.get(binding, 'getByName');
  if (typeof getByName === 'function') return Reflect.apply(getByName, binding, [name]);
  const idFromName = Reflect.get(binding, 'idFromName');
  const get = Reflect.get(binding, 'get');
  if (typeof idFromName !== 'function' || typeof get !== 'function') return null;
  const id = Reflect.apply(idFromName, binding, [name]);
  return Reflect.apply(get, binding, [id]);
}

function unavailableServiceMaintenanceState(): ServiceMaintenanceState {
  return {
    enabled: true,
    revision: 0,
    updatedAt: null,
    activatedAt: null,
    settlesAt: null,
    controlUnavailable: true,
  };
}

function serviceStatusCache(binding: ServiceControlBinding): ServiceStatusCache {
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
      uncertainMutations: new Map(),
      canonicalRevision: -1,
      canonicalValue: null,
    };
    serviceStatusCacheByBinding.set(binding, cache);
  }
  return cache;
}

function rememberCanonicalServiceStatus(
  cache: ServiceStatusCache,
  state: ServiceMaintenanceState | null,
): boolean {
  if (
    !state ||
    state.controlUnavailable === true ||
    !isSafeInteger(state.revision) ||
    state.revision < 0 ||
    state.revision <= cache.canonicalRevision
  ) {
    return false;
  }
  cache.canonicalRevision = state.revision;
  cache.canonicalValue = state;
  return true;
}

function beginServiceStatusMutation(
  binding: ServiceControlBinding,
  input: ServiceMaintenanceUpdateInput,
): number {
  const cache = serviceStatusCache(binding);
  const generation = cache.mutationGeneration + 1;
  cache.mutationGeneration = generation;
  cache.activeMutationGeneration = generation;
  cache.uncertainMutations.set(generation, {
    expectedRevision: input.expectedRevision,
    enabled: input.enabled,
    requestId: input.requestId,
  });
  cache.version += 1;
  cache.value = unavailableServiceMaintenanceState();
  cache.expiresAt = Date.now() + SERVICE_CONTROL_CACHE_TTL_MS;
  return generation;
}

function serviceStatusReconcilesMutation(
  state: ServiceMaintenanceState,
  mutation: ServiceStatusMutationFence,
): boolean {
  if (state.controlUnavailable === true) return false;
  if (state.revision > mutation.expectedRevision) return true;
  return state.revision === mutation.expectedRevision && state.enabled === mutation.enabled;
}

function cancelServiceControlBody(reader: CancelableServiceControlBody): void {
  try {
    Promise.resolve(reader?.cancel()).catch(() => {});
  } catch {
    // Cancellation is best-effort and must never delay the fail-closed result.
  }
}

function deferServiceControlBodyCancellation(reader: CancelableServiceControlBody): void {
  if (!reader) return;
  setTimeout(() => cancelServiceControlBody(reader), 0);
}

type ServiceControlStatusHeaderResult =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'state'; state: ServiceMaintenanceState };

type AbuseRateResponseHeaderResult =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'payload'; payload: unknown };

function parseServiceControlNullableTimestamp(value: unknown): number | null | undefined {
  if (value === 'null') return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function serviceControlStatusFromHeaders(
  response: ServiceControlHttpResponse,
): ServiceControlStatusHeaderResult {
  let version: unknown;
  try {
    version = response.headers.get(SERVICE_CONTROL_STATUS_VERSION_HEADER);
  } catch {
    return { kind: 'invalid' };
  }
  if (version === null) return { kind: 'absent' };
  if (version !== '1') return { kind: 'invalid' };

  try {
    const enabledValue = response.headers.get(SERVICE_CONTROL_STATUS_ENABLED_HEADER);
    const revisionValue = response.headers.get(SERVICE_CONTROL_STATUS_REVISION_HEADER);
    const updatedAt = parseServiceControlNullableTimestamp(
      response.headers.get(SERVICE_CONTROL_STATUS_UPDATED_AT_HEADER),
    );
    const activatedAt = parseServiceControlNullableTimestamp(
      response.headers.get(SERVICE_CONTROL_STATUS_ACTIVATED_AT_HEADER),
    );
    if (
      (enabledValue !== '0' && enabledValue !== '1') ||
      typeof revisionValue !== 'string' ||
      !/^\d+$/.test(revisionValue) ||
      updatedAt === undefined ||
      activatedAt === undefined
    ) {
      return { kind: 'invalid' };
    }
    const revision = Number(revisionValue);
    if (!Number.isSafeInteger(revision)) return { kind: 'invalid' };
    const state = normalizeServiceMaintenanceState({
      enabled: enabledValue === '1',
      revision,
      updatedAt,
      activatedAt,
    });
    return state ? { kind: 'state', state } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function abuseRateResultFromHeaders(
  response: ServiceControlHttpResponse,
): AbuseRateResponseHeaderResult {
  try {
    const protocol = response.headers.get(ABUSE_RATE_RESPONSE_PROTOCOL_HEADER);
    if (protocol === null) return { kind: 'absent' };
    if (protocol !== ABUSE_RATE_RESPONSE_PROTOCOL) return { kind: 'invalid' };
    const encoded = response.headers.get(ABUSE_RATE_RESPONSE_RESULT_HEADER);
    if (
      typeof encoded !== 'string' ||
      encoded.length < 2 ||
      encoded.length > ABUSE_RATE_RESPONSE_RESULT_MAX_LENGTH ||
      !/^[\x20-\x7e]+$/.test(encoded)
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'payload', payload: JSON.parse(encoded) as unknown };
  } catch {
    return { kind: 'invalid' };
  }
}

async function readServiceControlJson(
  response: ServiceControlHttpResponse,
  registerReader: (reader: ServiceControlReader | null) => void,
): Promise<unknown> {
  const rawLength = response.headers.get('content-length');
  if (rawLength !== null && typeof rawLength !== 'string') {
    cancelServiceControlBody(response.body);
    return null;
  }
  const length = rawLength;
  if (
    length !== null &&
    (!/^\d+$/.test(length.trim()) || Number(length) > SERVICE_CONTROL_RESPONSE_MAX_BYTES)
  ) {
    cancelServiceControlBody(response.body);
    return null;
  }
  const reader = response.body?.getReader();
  if (!isServiceControlReader(reader)) return null;
  registerReader(reader);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const readResult = await reader.read();
      if (!isUnknownRecord(readResult) || typeof readResult.done !== 'boolean') {
        cancelServiceControlBody(reader);
        return null;
      }
      const { done, value } = readResult;
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
    const payload: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return payload;
  } catch {
    return null;
  }
}

async function fetchServiceControlResponse(
  stub: ServiceControlStub,
  request: Request,
  options: {
    readStatusHeaders?: boolean;
    returnWhenStatusHeadersAbsent?: boolean;
    readAbuseRateHeaders?: boolean;
  } = {},
): Promise<ServiceControlOutcome> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let activeReader: ServiceControlReader | null = null;
  let abuseLegacyBodyReadStarted = false;
  let timedOut = false;
  const responseOutcome: Promise<ServiceControlOutcome> = Promise.resolve()
    .then(() => stub.fetch(request))
    // Promise.race keeps handlers on the losing promise, but normalize both
    // branches explicitly so a binding that rejects after the timeout can
    // never surface as an unhandled rejection.
    .then(
      async (response): Promise<ServiceControlOutcome> => {
        if (!isServiceControlHttpResponse(response)) return { kind: 'unavailable' };
        if (timedOut) {
          if (!options.readStatusHeaders && !options.readAbuseRateHeaders) {
            cancelServiceControlBody(response.body);
          } else if (options.readAbuseRateHeaders) {
            const lateHeaderResult = abuseRateResultFromHeaders(response);
            if (lateHeaderResult.kind === 'absent') {
              deferServiceControlBodyCancellation(response.body);
            }
          }
          return { kind: 'unavailable' };
        }
        if (options.readStatusHeaders) {
          const headerResult = serviceControlStatusFromHeaders(response);
          if (headerResult.kind === 'invalid') return { kind: 'unavailable' };
          if (headerResult.kind === 'state') {
            return { kind: 'response', response, payload: headerResult.state };
          }
          if (options.returnWhenStatusHeadersAbsent) {
            return {
              kind: 'response',
              response,
              payload: SERVICE_CONTROL_STATUS_HEADERS_ABSENT,
            };
          }
        }
        if (options.readAbuseRateHeaders) {
          // Negotiated errors are status-only. Opening their body would
          // reintroduce the cross-Worker stream dependency this protocol
          // exists to remove.
          if (!response.ok) return { kind: 'response', response, payload: null };
          const headerResult = abuseRateResultFromHeaders(response);
          if (headerResult.kind === 'invalid') return { kind: 'unavailable' };
          if (headerResult.kind === 'payload') {
            return { kind: 'response', response, payload: headerResult.payload };
          }
          // A missing protocol header means an older producer. Parse this same
          // response body once; never replay the mutating POST.
          abuseLegacyBodyReadStarted = true;
        }
        const payload = await readServiceControlJson(response, (reader) => {
          activeReader = reader;
        });
        return timedOut ? { kind: 'unavailable' } : { kind: 'response', response, payload };
      },
      (): ServiceControlUnavailable => ({ kind: 'unavailable' }),
    );
  const timeoutOutcome = new Promise<ServiceControlUnavailable>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      resolve({ kind: 'unavailable' });
      if (!options.readStatusHeaders && !options.readAbuseRateHeaders) {
        cancelServiceControlBody(activeReader);
      } else if (options.readAbuseRateHeaders && abuseLegacyBodyReadStarted) {
        // Resolve the caller first. A legacy stream cancel that wedges inside
        // the runtime must not hold the protected user request open.
        deferServiceControlBodyCancellation(activeReader);
      }
    }, SERVICE_CONTROL_READ_TIMEOUT_MS);
  });

  try {
    return await Promise.race([responseOutcome, timeoutOutcome]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

export async function consumeAbuseRateLimit(
  env: ServiceMaintenanceEnvironment,
  input: AbuseRateLimitInput,
): Promise<AbuseRateLimitResult> {
  const scope = typeof input?.scope === 'string' ? input.scope : '';
  const identity = typeof input?.identity === 'string' ? input.identity : '';
  const limit = input?.limit;
  const windowMs = input?.windowMs;
  const cost = input?.cost ?? 1;
  const operationId = input?.operationId === undefined ? null : input.operationId;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope) ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(identity) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1_000_000 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1_000 ||
    windowMs > 24 * 60 * 60 * 1_000 ||
    !Number.isSafeInteger(cost) ||
    cost < 1 ||
    cost > limit ||
    (operationId !== null &&
      (typeof operationId !== 'string' ||
        !ABUSE_RATE_OPERATION_ID_RE.test(operationId) ||
        limit > ABUSE_RATE_OPERATION_HISTORY_LIMIT))
  ) {
    return { status: 'unavailable' };
  }

  const binding = serviceControlBinding(env);
  if (!binding) return { status: 'unbound' };
  try {
    const objectName = `${ABUSE_RATE_OBJECT_PREFIX}:${scope}:${identity}`;
    const stub = namedServiceControlStub(binding, objectName);
    if (!isServiceControlStub(stub)) return { status: 'unavailable' };
    const outcome = await fetchServiceControlResponse(
      stub,
      new Request(
        `${SERVICE_CONTROL_ORIGIN}${
          operationId === null ? ABUSE_RATE_CONSUME_PATH : ABUSE_RATE_IDEMPOTENT_CONSUME_PATH
        }`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [ABUSE_RATE_RESPONSE_PROTOCOL_HEADER]: ABUSE_RATE_RESPONSE_PROTOCOL,
          },
          body: JSON.stringify({
            limit,
            windowMs,
            cost,
            ...(operationId === null ? {} : { operationId }),
          }),
        },
      ),
      { readAbuseRateHeaders: true },
    );
    if (outcome.kind !== 'response' || !outcome.response.ok) return { status: 'unavailable' };
    const value = outcome.payload;
    const keys = isUnknownRecord(value) ? Object.keys(value).sort() : [];
    if (
      !isUnknownRecord(value) ||
      keys.join(',') !== 'allowed,limit,remaining,resetAtMs,retryAfterSeconds' ||
      typeof value.allowed !== 'boolean' ||
      value.limit !== limit ||
      !isSafeInteger(value.remaining) ||
      value.remaining < 0 ||
      value.remaining > limit ||
      !isSafeInteger(value.resetAtMs) ||
      value.resetAtMs <= 0 ||
      !isSafeInteger(value.retryAfterSeconds) ||
      value.retryAfterSeconds < 0
    ) {
      return { status: 'unavailable' };
    }
    return {
      status: 'ok',
      allowed: value.allowed,
      limit,
      remaining: value.remaining,
      resetAtMs: value.resetAtMs,
      retryAfterSeconds: value.retryAfterSeconds,
    };
  } catch {
    return { status: 'unavailable' };
  }
}

function canonicalAbuseRateResult(
  value: unknown,
  limit: number,
  cost: number,
  windowMs: number,
): AbuseRateCounterResult | null {
  const keys = isUnknownRecord(value) ? Object.keys(value).sort() : [];
  if (
    !isUnknownRecord(value) ||
    keys.join(',') !== 'allowed,limit,remaining,resetAtMs,retryAfterSeconds' ||
    typeof value.allowed !== 'boolean' ||
    value.limit !== limit ||
    !isSafeInteger(value.remaining) ||
    value.remaining < 0 ||
    value.remaining > limit ||
    !isSafeInteger(value.resetAtMs) ||
    value.resetAtMs <= 0 ||
    value.resetAtMs % windowMs !== 0 ||
    !isSafeInteger(value.retryAfterSeconds) ||
    (value.allowed
      ? value.remaining > limit - cost || value.retryAfterSeconds !== 0
      : value.remaining >= cost ||
        value.retryAfterSeconds < 1 ||
        value.retryAfterSeconds > Math.ceil(windowMs / 1_000))
  ) {
    return null;
  }
  return {
    allowed: value.allowed,
    limit,
    remaining: value.remaining,
    resetAtMs: value.resetAtMs,
    retryAfterSeconds: value.retryAfterSeconds,
  };
}

export async function consumeAbuseRateLimitPair(
  env: ServiceMaintenanceEnvironment,
  input: AbuseRateLimitPairInput,
): Promise<AbuseRateLimitPairResult> {
  const scope = typeof input?.scope === 'string' ? input.scope : '';
  const identity = typeof input?.identity === 'string' ? input.identity : '';
  const limit = input?.limit;
  const windowMs = input?.windowMs;
  const cost = input?.cost ?? 1;
  const secondary = input?.secondary ?? null;
  const secondaryValid =
    secondary === null ||
    (secondary &&
      typeof secondary === 'object' &&
      !Array.isArray(secondary) &&
      /^[A-Za-z0-9._:-]{1,64}$/.test(secondary.identity) &&
      Number.isSafeInteger(secondary.limit) &&
      secondary.limit >= 1 &&
      secondary.limit <= ABUSE_RATE_PAIR_PRIMARY_LIMIT &&
      Number.isSafeInteger(secondary.cost ?? 1) &&
      (secondary.cost ?? 1) >= 1 &&
      (secondary.cost ?? 1) <= secondary.limit &&
      (secondary.cost ?? 1) <= cost);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope) ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(identity) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ABUSE_RATE_PAIR_PRIMARY_LIMIT ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1_000 ||
    windowMs > 24 * 60 * 60 * 1_000 ||
    !Number.isSafeInteger(cost) ||
    cost < 1 ||
    cost > limit ||
    !secondaryValid
  ) {
    return { status: 'unavailable' };
  }

  const binding = serviceControlBinding(env);
  if (!binding) return { status: 'unbound' };
  try {
    const objectName = `${ABUSE_RATE_PAIR_OBJECT_PREFIX}:${scope}:${identity}`;
    const stub = namedServiceControlStub(binding, objectName);
    if (!isServiceControlStub(stub)) return { status: 'unavailable' };
    const outcome = await fetchServiceControlResponse(
      stub,
      new Request(`${SERVICE_CONTROL_ORIGIN}${ABUSE_RATE_PAIR_CONSUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [ABUSE_RATE_RESPONSE_PROTOCOL_HEADER]: ABUSE_RATE_RESPONSE_PROTOCOL,
        },
        body: JSON.stringify({
          limit,
          windowMs,
          cost,
          secondaryIdentity: secondary?.identity ?? null,
          secondaryLimit: secondary?.limit ?? null,
          secondaryCost: secondary ? (secondary.cost ?? 1) : null,
        }),
      }),
      { readAbuseRateHeaders: true },
    );
    if (outcome.kind !== 'response' || !outcome.response.ok) return { status: 'unavailable' };
    const value = outcome.payload;
    const keys = isUnknownRecord(value) ? Object.keys(value).sort() : [];
    const primary = canonicalAbuseRateResult(
      recordProperty(value, 'primary'),
      limit,
      cost,
      windowMs,
    );
    const secondaryPayload = recordProperty(value, 'secondary');
    const secondaryResult =
      secondary === null || secondaryPayload === null
        ? null
        : canonicalAbuseRateResult(
            secondaryPayload,
            secondary.limit,
            secondary.cost ?? 1,
            windowMs,
          );
    const expectedDeniedBy = !primary?.allowed
      ? 'primary'
      : secondaryResult && !secondaryResult.allowed
        ? 'secondary'
        : null;
    if (
      !isUnknownRecord(value) ||
      keys.join(',') !== 'allowed,deniedBy,primary,secondary' ||
      !primary ||
      (secondary === null
        ? value.secondary !== null
        : primary.allowed
          ? !secondaryResult
          : value.secondary !== null) ||
      (secondaryResult !== null && secondaryResult.resetAtMs !== primary.resetAtMs) ||
      typeof value.allowed !== 'boolean' ||
      value.allowed !== (primary.allowed && (secondaryResult?.allowed ?? true)) ||
      value.deniedBy !== expectedDeniedBy
    ) {
      return { status: 'unavailable' };
    }
    const deniedResult = expectedDeniedBy === 'primary' ? primary : secondaryResult;
    return {
      status: 'ok',
      allowed: value.allowed,
      deniedBy: expectedDeniedBy,
      retryAfterSeconds: value.allowed ? 0 : (deniedResult?.retryAfterSeconds ?? 0),
      primary,
      secondary: secondaryResult,
    };
  } catch {
    return { status: 'unavailable' };
  }
}

async function fetchServiceControlStatus(stub: ServiceControlStub): Promise<ServiceControlOutcome> {
  const headerOutcome = await fetchServiceControlResponse(
    stub,
    new Request(`${SERVICE_CONTROL_ORIGIN}${SERVICE_CONTROL_STATUS_PATH}`, { method: 'HEAD' }),
    { readStatusHeaders: true, returnWhenStatusHeadersAbsent: true },
  );
  if (
    headerOutcome.kind !== 'response' ||
    headerOutcome.payload !== SERVICE_CONTROL_STATUS_HEADERS_ABSENT
  ) {
    return headerOutcome;
  }
  if (![404, 405].includes(headerOutcome.response.status)) return { kind: 'unavailable' };
  return fetchServiceControlResponse(
    stub,
    new Request(`${SERVICE_CONTROL_ORIGIN}${SERVICE_CONTROL_STATUS_PATH}`, { method: 'GET' }),
    { readStatusHeaders: true },
  );
}

async function fetchServiceMaintenanceState(
  binding: ServiceControlBinding,
): Promise<ServiceMaintenanceState> {
  try {
    const stub = serviceControlStub(binding);
    if (!isServiceControlStub(stub)) return unavailableServiceMaintenanceState();
    const outcome = await fetchServiceControlStatus(stub);
    if (outcome.kind !== 'response') return unavailableServiceMaintenanceState();
    const { response } = outcome;
    if (!response.ok) return unavailableServiceMaintenanceState();
    const payload = outcome.payload;
    const normalized = normalizeServiceMaintenanceState(
      recordProperty(payload, 'serviceStatus') || payload,
    );
    return normalized || unavailableServiceMaintenanceState();
  } catch {
    return unavailableServiceMaintenanceState();
  }
}

export async function readServiceMaintenance(
  env: ServiceMaintenanceEnvironment,
  options: ServiceMaintenanceReadOptions = {},
): Promise<ServiceMaintenanceState> {
  const binding = serviceControlBinding(env);
  // Unit tests, local development, and bootstrap deployments may intentionally
  // omit the binding. Every production Worker config binds the control object.
  if (!binding) return inactiveServiceMaintenanceState();

  const now = Date.now();
  const cache = serviceStatusCache(binding);
  // A local mutation may be enabling maintenance. Until its bounded outcome
  // is known, an older status response must not reopen the request gate.
  if (cache.activeMutationGeneration !== null) {
    return cache.value || unavailableServiceMaintenanceState();
  }
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
        const canonical = value.controlUnavailable === true ? null : cache.canonicalValue || value;
        if (canonical) {
          for (const [generation, mutation] of cache.uncertainMutations) {
            if (serviceStatusReconcilesMutation(canonical, mutation)) {
              cache.uncertainMutations.delete(generation);
            }
          }
        }
        cache.value =
          value.controlUnavailable === true
            ? value
            : cache.uncertainMutations.size > 0
              ? unavailableServiceMaintenanceState()
              : canonical || value;
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
  return cache.refresh ?? unavailableServiceMaintenanceState();
}

/**
 * Returns only an already-observed canonical maintenance state. Public request
 * paths use this snapshot so a stalled cross-Worker control read can never
 * stall the user response that triggered its refresh.
 */
export function readCachedServiceMaintenance(
  env: ServiceMaintenanceEnvironment,
): CachedServiceMaintenanceRead {
  const binding = serviceControlBinding(env);
  if (!binding) {
    return { state: inactiveServiceMaintenanceState(), refreshNeeded: false };
  }

  const cache = serviceStatusCache(binding);
  if (cache.activeMutationGeneration !== null) {
    return {
      state: cache.value || unavailableServiceMaintenanceState(),
      refreshNeeded: false,
    };
  }
  const refreshNeeded =
    cache.expiresAt <= Date.now() &&
    (cache.refresh === null || cache.refreshVersion !== cache.version);
  if (cache.uncertainMutations.size > 0) {
    return {
      state: cache.value || unavailableServiceMaintenanceState(),
      refreshNeeded,
    };
  }
  const state = cache.canonicalValue;
  return { state, refreshNeeded };
}

function updateCachedServiceStatus(
  binding: ServiceControlBinding,
  state: ServiceMaintenanceState,
  mutationGeneration: number,
): void {
  const cache = serviceStatusCache(binding);
  rememberCanonicalServiceStatus(cache, state);
  if (state.controlUnavailable !== true) {
    cache.uncertainMutations.delete(mutationGeneration);
  }
  // Responses can complete out of order even though the DO committed them in
  // order. A superseded local call cannot replace a newer local outcome, but
  // it can carry a still-newer canonical revision committed elsewhere.
  if (cache.activeMutationGeneration !== mutationGeneration) {
    if (
      cache.activeMutationGeneration === null &&
      cache.uncertainMutations.size === 0 &&
      cache.canonicalValue
    ) {
      cache.version += 1;
      cache.value = cache.canonicalValue;
      cache.expiresAt = Date.now() + SERVICE_CONTROL_CACHE_TTL_MS;
    }
    return;
  }
  cache.activeMutationGeneration = null;
  cache.version += 1;
  cache.value =
    state.controlUnavailable === true || cache.uncertainMutations.size > 0
      ? unavailableServiceMaintenanceState()
      : cache.canonicalValue || state;
  cache.expiresAt = Date.now() + SERVICE_CONTROL_CACHE_TTL_MS;
}

export async function updateServiceMaintenance(
  env: ServiceMaintenanceEnvironment,
  input: ServiceMaintenanceUpdateInput,
): Promise<ServiceMaintenanceUpdateResult> {
  const binding = serviceControlBinding(env);
  if (!binding) {
    return { status: 'unavailable', state: inactiveServiceMaintenanceState() };
  }
  const mutationGeneration = beginServiceStatusMutation(binding, input);

  try {
    const stub = serviceControlStub(binding);
    if (!isServiceControlStub(stub)) {
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
    const state = normalizeServiceMaintenanceState(
      recordProperty(payload, 'serviceStatus') || recordProperty(payload, 'state'),
    );
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

async function callAdminAnnouncementControl(
  env: ServiceMaintenanceEnvironment,
  path: string,
  init: RequestInit,
  objectName: string = ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME,
): Promise<AdminAnnouncementControlResult> {
  const binding = serviceControlBinding(env);
  if (!binding) return { status: 'unbound', payload: null };
  try {
    const stub = namedServiceControlStub(binding, objectName);
    if (!isServiceControlStub(stub)) {
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

async function readAdminAnnouncementStore(
  env: ServiceMaintenanceEnvironment,
  objectName: string,
): Promise<AdminAnnouncementControlResult> {
  return callAdminAnnouncementControl(
    env,
    ADMIN_ANNOUNCEMENT_STATUS_PATH,
    { method: 'GET' },
    objectName,
  );
}

async function readSeparatedAdminAnnouncementControl(env: ServiceMaintenanceEnvironment): Promise<{
  result: AdminAnnouncementControlResult;
  sourcePriority: AdminAnnouncementSourcePriority;
}> {
  const separated = await readAdminAnnouncementStore(env, ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME);
  const separatedRevision = canonicalAdminAnnouncementRevision(separated.payload);
  const separatedSourcePriority =
    separatedRevision !== null && separatedRevision > 0
      ? ADMIN_ANNOUNCEMENT_SOURCE_POSITIVE_SEPARATED
      : ADMIN_ANNOUNCEMENT_SOURCE_EMPTY_SEPARATED;
  if (separated.status !== 'ok') {
    return { result: separated, sourcePriority: separatedSourcePriority };
  }
  if (separatedRevision !== 0) {
    return { result: separated, sourcePriority: separatedSourcePriority };
  }

  // Before the first mutation on the separated object, preserve the current
  // announcement that older releases stored beside maintenance. Once the new
  // object has any canonical revision it is permanently authoritative and no
  // longer depends on the legacy control object.
  const legacy = await readAdminAnnouncementStore(env, SERVICE_CONTROL_OBJECT_NAME);
  if (legacy.status !== 'ok') {
    return { result: legacy, sourcePriority: ADMIN_ANNOUNCEMENT_SOURCE_LEGACY };
  }
  const legacyRevision = canonicalAdminAnnouncementRevision(legacy.payload);
  return legacyRevision !== null && legacyRevision > 0
    ? { result: legacy, sourcePriority: ADMIN_ANNOUNCEMENT_SOURCE_LEGACY }
    : { result: separated, sourcePriority: ADMIN_ANNOUNCEMENT_SOURCE_EMPTY_SEPARATED };
}

async function prepareSeparatedAdminAnnouncementMutation(
  env: ServiceMaintenanceEnvironment,
  input: AdminAnnouncementUpdateInput,
  knownCanonical: { payload: unknown; sourcePriority: number } | null,
): Promise<PreparedAdminAnnouncementMutation> {
  if (
    knownCanonical &&
    knownCanonical.sourcePriority === ADMIN_ANNOUNCEMENT_SOURCE_POSITIVE_SEPARATED &&
    input?.expectedRevision === canonicalAdminAnnouncementRevision(knownCanonical.payload)
  ) {
    return {
      expectedRevision: input.expectedRevision,
      baseHistory: input?.baseHistory,
      migrating: false,
    };
  }
  const separated = await readAdminAnnouncementStore(env, ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME);
  const separatedRevision = canonicalAdminAnnouncementRevision(separated.payload);
  if (separated.status !== 'ok') {
    return {
      result: separated,
      sourcePriority:
        separatedRevision !== null && separatedRevision > 0
          ? ADMIN_ANNOUNCEMENT_SOURCE_POSITIVE_SEPARATED
          : ADMIN_ANNOUNCEMENT_SOURCE_EMPTY_SEPARATED,
    };
  }
  if (separatedRevision !== null && separatedRevision > 0) {
    return {
      expectedRevision: input?.expectedRevision,
      baseHistory: input?.baseHistory,
      migrating: false,
    };
  }

  const legacy = await readAdminAnnouncementStore(env, SERVICE_CONTROL_OBJECT_NAME);
  if (legacy.status !== 'ok') {
    return { result: legacy, sourcePriority: ADMIN_ANNOUNCEMENT_SOURCE_LEGACY };
  }
  const legacyState = canonicalAdminAnnouncementState(legacy.payload);
  const legacyRevision = legacyState?.revision ?? null;
  if (legacyState && legacyRevision !== null && legacyRevision > 0) {
    if (input?.expectedRevision !== legacyRevision) {
      return {
        result: { status: 'conflict', payload: legacy.payload },
        sourcePriority: ADMIN_ANNOUNCEMENT_SOURCE_LEGACY,
      };
    }
    return {
      expectedRevision: legacyRevision,
      baseHistory: legacyState.rawHistory,
      migrating: true,
    };
  }
  return {
    expectedRevision: input?.expectedRevision,
    baseHistory: input?.baseHistory,
    migrating: false,
  };
}

function adminAnnouncementCache(binding: ServiceControlBinding): AdminAnnouncementCache {
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
      canonicalSourcePriority: -1,
      canonicalValue: null,
    };
    adminAnnouncementCacheByBinding.set(binding, cache);
  }
  return cache;
}

function canonicalAdminAnnouncementRecord(
  value: unknown,
  { allowEmpty = false, history = false }: { allowEmpty?: boolean; history?: boolean } = {},
): CanonicalAdminAnnouncementRecord | null {
  if (!isUnknownRecord(value)) return null;
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

function canonicalAdminAnnouncementState(payload: unknown): CanonicalAdminAnnouncementState | null {
  const state = recordProperty(payload, 'announcementState');
  if (
    !isUnknownRecord(state) ||
    !isSafeInteger(state.revision) ||
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
  if (
    !announcement ||
    !history.every((entry): entry is CanonicalAdminAnnouncementRecord => entry !== null)
  ) {
    return null;
  }
  if (state.revision === 0) {
    return !announcement.id && history.length === 0
      ? { revision: 0, announcement, history, rawHistory: state.history }
      : null;
  }
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
  return { revision: state.revision, announcement, history, rawHistory: state.history };
}

function canonicalAdminAnnouncementRevision(payload: unknown): number | null {
  return canonicalAdminAnnouncementState(payload)?.revision ?? null;
}

function rememberCanonicalAdminAnnouncement(
  cache: AdminAnnouncementCache,
  result: AdminAnnouncementControlResult,
  sourcePriority: number = ADMIN_ANNOUNCEMENT_SOURCE_LEGACY,
): boolean {
  if (result?.status !== 'ok' && result?.status !== 'conflict') return false;
  const revision = canonicalAdminAnnouncementRevision(result?.payload);
  if (
    !isSafeInteger(revision) ||
    revision < 0 ||
    sourcePriority < cache.canonicalSourcePriority ||
    (sourcePriority === cache.canonicalSourcePriority && revision <= cache.canonicalRevision)
  ) {
    return false;
  }
  cache.canonicalRevision = revision;
  cache.canonicalSourcePriority = sourcePriority;
  cache.canonicalValue = { status: 'ok', payload: result.payload };
  return true;
}

export async function readAdminAnnouncementControl(
  env: ServiceMaintenanceEnvironment,
  options: ServiceMaintenanceReadOptions = {},
): Promise<AdminAnnouncementControlResult> {
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
    const refresh = readSeparatedAdminAnnouncementControl(env)
      .then(({ result, sourcePriority }): AdminAnnouncementControlResult => {
        const advanced = rememberCanonicalAdminAnnouncement(cache, result, sourcePriority);
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
        return cache.value;
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
  return cache.refresh ?? { status: 'unavailable', payload: null };
}

export async function updateAdminAnnouncementControl(
  env: ServiceMaintenanceEnvironment,
  input: AdminAnnouncementUpdateInput,
): Promise<AdminAnnouncementControlResult> {
  const binding = serviceControlBinding(env);
  let mutationGeneration = null;
  let knownCanonical = null;
  if (binding) {
    const cache = adminAnnouncementCache(binding);
    if (cache.canonicalValue?.payload) {
      knownCanonical = {
        payload: cache.canonicalValue.payload,
        sourcePriority: cache.canonicalSourcePriority,
      };
    }
    mutationGeneration = cache.mutationGeneration + 1;
    cache.mutationGeneration = mutationGeneration;
    cache.activeMutationGeneration = mutationGeneration;
    cache.version += 1;
    cache.value = null;
    cache.expiresAt = 0;
  }
  const prepared = await prepareSeparatedAdminAnnouncementMutation(env, input, knownCanonical);
  const result = prepared.result
    ? prepared.result
    : await callAdminAnnouncementControl(env, ADMIN_ANNOUNCEMENT_STATE_PATH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(prepared.migrating ? { [ADMIN_ANNOUNCEMENT_MIGRATION_HEADER]: '1' } : {}),
        },
        body: JSON.stringify({
          message: input?.message,
          enabled: input?.enabled,
          expiresAt: input?.expiresAt,
          expectedRevision: prepared.expectedRevision,
          requestId: input?.requestId,
          baseHistory: prepared.baseHistory,
        }),
      });
  if (binding) {
    const cache = adminAnnouncementCache(binding);
    const advanced = rememberCanonicalAdminAnnouncement(
      cache,
      result,
      prepared.result
        ? (prepared.sourcePriority ?? ADMIN_ANNOUNCEMENT_SOURCE_EMPTY_SEPARATED)
        : (canonicalAdminAnnouncementRevision(result.payload) ?? 0) > 0
          ? ADMIN_ANNOUNCEMENT_SOURCE_POSITIVE_SEPARATED
          : ADMIN_ANNOUNCEMENT_SOURCE_EMPTY_SEPARATED,
    );
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

function normalizedLanguageTag(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
}

function matchedMaintenanceLanguage(request: Request): MaintenanceLanguage {
  const weighted = String(request.headers.get('Accept-Language') || '')
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
    if (tag === 'pt' || tag.startsWith('pt-')) return 'pt-br';
    if (tag === 'in' || tag.startsWith('in-')) return 'id';
    if (tag === 'iw' || tag.startsWith('iw-')) return 'he';
    if (tag === 'no' || tag.startsWith('no-')) return 'nb';
    if (tag === 'tl' || tag.startsWith('tl-')) return 'fil';
    if (tag === 'zh-hant' || tag.startsWith('zh-hant-') || /^(zh-(tw|hk|mo))(?:-|$)/.test(tag)) {
      return 'zh-hant';
    }
    if (tag === 'zh-hans' || tag.startsWith('zh-hans-') || /^(zh-(cn|sg))(?:-|$)/.test(tag)) {
      return 'zh-hans';
    }
    const primary = tag.split('-')[0];
    if (primary === 'zh') return 'zh-hans';
    if (primary && isMaintenanceLanguage(primary)) return primary;
  }
  return 'en';
}

function maintenanceHeaders(
  contentType: string,
  language: MaintenanceLanguage,
): Record<string, string> {
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

function maintenanceHtml(language: MaintenanceLanguage): string {
  const description = localizedDescriptions[language];
  const direction =
    language === 'ar' || language === 'fa' || language === 'he' || language === 'ur'
      ? 'rtl'
      : 'ltr';
  return `<!doctype html>
<html lang="${language}" dir="${direction}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title lang="en">MUSIXQUARE: Service check</title>
  <style>
    :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;background:#e4e4e1;color:#171717;font-family:Inter,Pretendard,system-ui,-apple-system,sans-serif;padding:clamp(28px,7vw,88px)}main{width:min(960px,100%)}h1{margin:0}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);clip-path:inset(50%);white-space:nowrap;border:0}.headline{display:block;font-size:clamp(34px,4.3vw,52px);font-weight:560;line-height:1.08;letter-spacing:-.04em;text-wrap:balance}.headline-lead{white-space:nowrap}.wordmark{display:inline-block;width:6em;max-width:calc(100% - 2em);height:auto;margin-right:clamp(8px,.2em,11px);color:#171717;vertical-align:middle}p{max-width:38rem;margin:clamp(26px,4vw,38px) 0 0;color:#5f5f5b;font-size:clamp(16px,2.5vw,19px);line-height:1.65;word-break:keep-all}@media(max-width:520px){.headline{font-size:clamp(34px,9vw,40px)}}@media(orientation:landscape) and (max-height:520px){body{padding:24px clamp(32px,8vw,72px)}.headline{font-size:clamp(32px,4.8vw,40px)}p{margin-top:20px;font-size:16px;line-height:1.5}}
  </style>
</head>
<body>
  <main>
    <h1 lang="en" dir="ltr">
      <span class="sr-only">MUSIXQUARE is temporarily unavailable.</span>
      <span class="headline" aria-hidden="true"><span class="headline-lead"><svg class="wordmark" xmlns="http://www.w3.org/2000/svg" viewBox="43 12 214 26" fill="currentColor" focusable="false">
      <polygon points="45.4679049 17.3182774 45.4732381 35.3182767 49.9732379 35.3169433 49.9679047 17.3169441 54.4679045 17.3156108 54.4732377 35.31561 58.9732375 35.3142767 58.9679043 17.3142775 63.4679041 17.3129442 63.4732373 35.3129434 67.9732371 35.3116101 67.9679039 17.3116109 67.9665706 12.8116111 45.4665715 12.8182776 45.4679049 17.3182774"></polygon>
      <polygon points="85.971903 30.806277 76.9719034 30.8089436 76.9665702 12.8089444 72.4665704 12.8102778 72.4719036 30.810277 72.4732369 35.3102768 90.4732361 35.3049435 90.4719028 30.8049437 90.4665696 12.8049445 85.9665698 12.8062778 85.971903 30.806277"></polygon>
      <polygon points="94.9679027 17.303611 94.969236 21.8036108 94.9705693 26.3036106 108.4705687 26.2996106 108.471902 30.7996104 94.9719026 30.8036104 94.9732359 35.3036102 112.9732352 35.2982769 112.9719018 30.7982771 112.9705685 26.2982773 112.9692352 21.7982775 99.4692358 21.8022775 99.4679025 17.3022777 112.9679019 17.2982777 112.9665686 12.7982779 94.9665694 12.8036112 94.9679027 17.303611"></polygon>
      <rect x="117.4699016" y="12.7962774" width="4.5" height="22.5"></rect>
      <polygon points="139.316543 12.7904706 134.5936888 19.9509279 129.8665923 12.7932706 124.4665681 12.7948706 131.8948278 24.0426701 124.4732347 35.2948696 129.8732588 35.2932696 134.596113 28.1328123 139.3232096 35.2904696 144.7232338 35.2888696 137.294974 24.0410701 144.7165672 12.7888706 139.316543 12.7904706"></polygon>
      <path d="M147.2179004,17.2881297l.0039999,13.4999994.0013333,4.4999998,6.7499997-.002.0008,2.7000121,4.4999998-.0013333-.0008-2.7000121,6.7499997-.002-.0013333-4.4999998-.0039999-13.4999994-.0013333-4.4999998-17.9999992.0053333.0013333,4.4999998ZM160.7178998,17.2841298l.0039999,13.4999994-2.2499999.0006667-.0006667-2.2499999-4.4999998.0013333.0006667,2.2499999-2.2499999.0006667-.0039999-13.4999994,8.9999996-.0026666Z"></path>
      <polygon points="183.2218988 30.7774626 174.2218992 30.7801292 174.2165659 12.78013 169.7165661 12.7814633 169.7218994 30.7814625 169.7232327 35.2814623 187.7232319 35.2761291 187.7218986 30.7761293 187.7165653 12.7761301 183.2165655 12.7774634 183.2218988 30.7774626"></polygon>
      <path d="M192.2178984,17.2747966l.0053333,17.9999992,4.4999998-.0013333-.0026666-8.9999996,8.9999996-.0026666.0026666,8.9999996,4.4999998-.0013333-.0053333-17.9999992-.0013333-4.4999998-17.9999992.0053333.0013333,4.4999998ZM205.7178978,17.2707966l.0013333,4.4999998-8.9999996.0026666-.0013333-4.4999998,8.9999996-.0026666Z"></path>
      <path d="M232.7205633,26.2627963l-.0039999-13.4999994-17.9999992.0053333.0039999,13.4999994.0026666,8.9999996,4.4999998-.0013333-.0026666-8.9999996,4.6248777-.0013703,5.8306272,10.0920839,3.89655-2.2511546-4.5310104-7.8424689,3.6789549-.00109ZM219.2178972,17.2667967l8.9999996-.0026666.0013333,4.4999998-8.9999996.0026666-.0013333-4.4999998Z"></path>
      <rect x="237.2284599" y="12.7587935" width="18" height="4.5"></rect>
      <rect x="237.2311266" y="21.7594598" width="13.5" height="4.5"></rect>
      <rect x="237.2337931" y="30.7587928" width="18" height="4.5"></rect>
      </svg><span>is</span></span> temporarily unavailable.</span>
    </h1>
    <p>${description}</p>
  </main>
</body>
</html>`;
}

export function serviceMaintenancePreviewResponse(request: Request): Response {
  const language = matchedMaintenanceLanguage(request);
  const headers = maintenanceHeaders('text/html; charset=utf-8', language);
  delete headers['Retry-After'];
  headers['X-MXQR-Maintenance-Preview'] = '1';
  return new Response(request.method === 'HEAD' ? null : maintenanceHtml(language), {
    status: 200,
    headers,
  });
}

export function serviceMaintenanceResponse(
  request: Request,
  state: Partial<ServiceMaintenanceState> = {},
  options: ServiceMaintenanceResponseOptions = {},
): Response {
  const language = matchedMaintenanceLanguage(request);
  const format = options.format || 'auto';
  const acceptsHtml = String(request.headers.get('Accept') || '')
    .toLowerCase()
    .includes('text/html');
  const useHtml = format === 'html' || (format === 'auto' && acceptsHtml);
  if (useHtml) {
    return new Response(request.method === 'HEAD' ? null : maintenanceHtml(language), {
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
  return new Response(request.method === 'HEAD' ? null : body, {
    status: 503,
    headers: maintenanceHeaders('application/json; charset=utf-8', language),
  });
}

export async function gateServiceMaintenance(
  request: Request,
  env: ServiceMaintenanceEnvironment,
  options: ServiceMaintenanceGateOptions = {},
): Promise<Response | null> {
  const state = await readServiceMaintenance(env, options);
  return state.enabled ? serviceMaintenanceResponse(request, state, options) : null;
}

export function clearServiceMaintenanceCacheForTests() {
  serviceStatusCacheByBinding = new WeakMap<ServiceControlBinding, ServiceStatusCache>();
  adminAnnouncementCacheByBinding = new WeakMap<ServiceControlBinding, AdminAnnouncementCache>();
}
