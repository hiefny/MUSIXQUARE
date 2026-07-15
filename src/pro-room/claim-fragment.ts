import { parseProRoomClaimToken, type ProRoomClaimToken } from './credentials.ts';

export const PRO_ROOM_CLAIM_FRAGMENT_KEY = 'pro-claim';

interface ClaimLocation {
  hash: string;
  pathname: string;
  search: string;
}

interface ClaimHistory {
  state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/**
 * Consume an owner activation claim from the URL fragment and immediately
 * remove it from the address bar. Claim credentials are deliberately never
 * accepted from the query string, where proxies and analytics commonly log
 * them.
 */
export function takeProRoomClaimFromFragment(
  location: ClaimLocation = window.location,
  history: ClaimHistory = window.history,
): ProRoomClaimToken | null {
  const rawHash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!rawHash) return null;

  const params = new URLSearchParams(rawHash);
  const rawClaim = params.get(PRO_ROOM_CLAIM_FRAGMENT_KEY);
  if (rawClaim === null) return null;

  // Scrub first, before validation or any asynchronous work. Even a malformed
  // credential should not remain copyable from the address bar.
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  return parseProRoomClaimToken(rawClaim);
}

