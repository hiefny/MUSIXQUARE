const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

type Base64UrlInput = Uint8Array<ArrayBufferLike> | ArrayBufferLike;

export function base64UrlEncode(value: Base64UrlInput): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomToken(bytes = 24): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64UrlEncode(value);
}

export function constantTimeEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function sha256Bytes(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : (value as BufferSource);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Base64Url(value: unknown): Promise<string> {
  return base64UrlEncode(await sha256Bytes(value));
}

export async function hmacBytes(secret: unknown, value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    'raw',
    typeof secret === 'string' ? encoder.encode(secret) : (secret as BufferSource),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      typeof value === 'string' ? encoder.encode(value) : (value as BufferSource),
    ),
  );
}

export async function hmacBase64Url(secret: unknown, value: unknown): Promise<string> {
  return base64UrlEncode(await hmacBytes(secret, value));
}

export async function createSignedToken(payload: unknown, secret: unknown): Promise<string> {
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `v1.${encoded}.${await hmacBase64Url(secret, `v1.${encoded}`)}`;
}

export async function verifySignedToken(token: unknown, secret: unknown): Promise<unknown | null> {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return null;
    const expected = await hmacBase64Url(secret, `${parts[0]}.${parts[1]}`);
    if (!constantTimeEqual(expected, parts[2])) return null;
    const payload: unknown = JSON.parse(decoder.decode(base64UrlDecode(parts[1])));
    return payload;
  } catch {
    return null;
  }
}
