const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value) {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomToken(bytes = 24) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64UrlEncode(value);
}

export function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function sha256Bytes(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Base64Url(value) {
  return base64UrlEncode(await sha256Bytes(value));
}

export async function hmacBytes(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    typeof secret === 'string' ? encoder.encode(secret) : secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      typeof value === 'string' ? encoder.encode(value) : value,
    ),
  );
}

export async function hmacBase64Url(secret, value) {
  return base64UrlEncode(await hmacBytes(secret, value));
}

export async function createSignedToken(payload, secret) {
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `v1.${encoded}.${await hmacBase64Url(secret, `v1.${encoded}`)}`;
}

export async function verifySignedToken(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return null;
    const expected = await hmacBase64Url(secret, `${parts[0]}.${parts[1]}`);
    if (!constantTimeEqual(expected, parts[2])) return null;
    return JSON.parse(decoder.decode(base64UrlDecode(parts[1])));
  } catch {
    return null;
  }
}
