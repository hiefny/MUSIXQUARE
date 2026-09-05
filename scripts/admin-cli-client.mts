// Shared transport for explicit operator CLI actions. No credential is logged.
type Environment = Readonly<Record<string, string | undefined>>;
type ErrorConstructor = new (message: string) => Error;
const ADMIN_SESSION_COOKIE = '__Host-mxqr_admin';
const MAX_JSON_BYTES = 1024 * 1024;
export interface AdminCliRequestOptions {
  method?: string;
  body?: unknown;
  sensitive?: boolean;
}
export interface AdminCliClient {
  request(path: string, options?: AdminCliRequestOptions): Promise<unknown>;
}
export class AdminCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminCliError';
  }
}
export function isAdminCliTransportFailure(error: unknown): boolean {
  return error instanceof Error && 'transportFailure' in error && error.transportFailure === true;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function accessHeaders(env: Environment, ErrorType: ErrorConstructor): Record<string, string> {
  const clientId = env.CF_ACCESS_CLIENT_ID;
  const clientSecret = env.CF_ACCESS_CLIENT_SECRET;
  if (!!clientId !== !!clientSecret) {
    throw new ErrorType(
      'CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be supplied together',
    );
  }
  return clientId && clientSecret
    ? {
        'CF-Access-Client-Id': clientId,
        'CF-Access-Client-Secret': clientSecret,
      }
    : {};
}

function normalizeSessionCookie(
  value: string | undefined,
  ErrorType: ErrorConstructor,
): string | null {
  const input = String(value || '').trim();
  if (!input) return null;
  const token = input.startsWith(`${ADMIN_SESSION_COOKIE}=`)
    ? input.slice(ADMIN_SESSION_COOKIE.length + 1).split(';', 1)[0]
    : input;
  if (token === undefined || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
    throw new ErrorType('MXQR_ADMIN_SESSION_COOKIE is malformed');
  }
  return `${ADMIN_SESSION_COOKIE}=${token}`;
}

function extractAdminCookie(response: Response, ErrorType: ErrorConstructor): string {
  const headers = response.headers;
  const setCookies =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie') || ''];
  for (const value of setCookies) {
    const match = new RegExp(`(?:^|[,;]\\s*)${ADMIN_SESSION_COOKIE}=([^;\\s,]+)`, 'u').exec(value);
    const token = match?.[1];
    if (token && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
      return `${ADMIN_SESSION_COOKIE}=${token}`;
    }
  }
  throw new ErrorType('Admin login did not return a valid session');
}

async function readJsonResponse(
  response: Response,
  label: string,
  ErrorType: ErrorConstructor,
): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') || '')) {
    throw new ErrorType(`${label} returned invalid JSON`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ErrorType(`${label} returned invalid JSON`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new ErrorType(`${label} returned an unreadable response`), {
            transportFailure: true,
          }),
        ),
      30_000,
    );
  });
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), timeout]);
      } catch {
        throw Object.assign(new ErrorType(`${label} returned an unreadable response`), {
          transportFailure: true,
        });
      }
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_JSON_BYTES)
        throw new ErrorType(`${label} response exceeded the safe size limit`);
      chunks.push(chunk.value);
    }
  } finally {
    clearTimeout(timer);
    // Stream cancellation must not delay the bounded CLI error.
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ErrorType(`${label} returned invalid JSON`);
  }
  if (!response.ok) {
    const error = isRecord(payload) ? payload.error : undefined;
    const errorCode =
      typeof error === 'string' && /^[A-Z0-9_]{3,80}$/u.test(error) ? error : 'REQUEST_FAILED';
    throw new ErrorType(`${label} failed (${response.status} ${errorCode})`);
  }
  return payload;
}

export function createAdminCliClient({
  origin,
  env,
  fetcher = globalThis.fetch,
  ErrorType = AdminCliError,
  requestLabel = 'Admin request',
  sensitiveLabel = 'Sensitive admin response',
}: {
  origin: string;
  env: Environment;
  fetcher?: typeof fetch;
  ErrorType?: ErrorConstructor;
  requestLabel?: string;
  sensitiveLabel?: string;
}): AdminCliClient {
  if (typeof fetcher !== 'function') {
    throw new ErrorType('A fetch implementation is required');
  }
  const baseHeaders = accessHeaders(env, ErrorType);
  let cookie = normalizeSessionCookie(env.MXQR_ADMIN_SESSION_COOKIE, ErrorType);

  async function login(): Promise<string> {
    if (cookie) return cookie;
    const password = env.MXQR_ADMIN_PASSWORD;
    if (typeof password !== 'string' || !password) {
      throw new ErrorType('MXQR_ADMIN_PASSWORD or MXQR_ADMIN_SESSION_COOKIE must be supplied');
    }
    let response: Response;
    try {
      response = await fetcher(`${origin}/api/admin/login`, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
        headers: {
          ...baseHeaders,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
          'X-MXQR-Admin-CSRF': '1',
        },
        body: JSON.stringify({ password }),
      });
    } catch {
      throw new ErrorType('Admin login request failed');
    }
    await readJsonResponse(response, 'Admin login', ErrorType);
    cookie = extractAdminCookie(response, ErrorType);
    return cookie;
  }

  async function request(
    path: string,
    { method = 'GET', body = null, sensitive = false }: AdminCliRequestOptions = {},
  ): Promise<unknown> {
    const authenticatedCookie = await login();
    let response: Response;
    try {
      response = await fetcher(`${origin}${path}`, {
        method,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
        headers: {
          ...baseHeaders,
          Accept: 'application/json',
          Cookie: authenticatedCookie,
          ...(body === null
            ? {}
            : {
                'Content-Type': 'application/json',
                Origin: origin,
                'Sec-Fetch-Site': 'same-origin',
                'X-MXQR-Admin-CSRF': '1',
              }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw Object.assign(new ErrorType(`${requestLabel} failed`), { transportFailure: true });
    }
    if (sensitive && !/\bno-store\b/iu.test(response.headers.get('cache-control') || '')) {
      throw new ErrorType(`${sensitiveLabel} was not marked no-store`);
    }
    return readJsonResponse(response, requestLabel, ErrorType);
  }

  return { request };
}
