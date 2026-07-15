import {
  parseProRoomClaimToken,
  parseProRoomOwnerRecoveryClaimToken,
  type ProRoomClaimToken,
  type ProRoomOwnerRecoveryClaimToken,
} from './credentials.ts';

const PRO_ROOM_CLAIM_FRAGMENT_KEY = 'pro-claim';
const PRO_ROOM_RECOVERY_FRAGMENT_KEY = 'pro-recovery';
const PRO_ROOM_EARLY_HANDOFF_KEY = '__mxqrTakeProRoomFragmentClaims';

interface ClaimLocation {
  hash: string;
  pathname: string;
  search: string;
}

interface ClaimHistory {
  state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

interface ProRoomFragmentClaims {
  activationClaimToken: ProRoomClaimToken | null;
  ownerRecoveryClaimToken: ProRoomOwnerRecoveryClaimToken | null;
  ownerRecoveryClaimPresent: boolean;
}

interface EarlyClaimHandoff {
  activationClaim: unknown;
  recoveryClaim: unknown;
  recoveryPresent: boolean;
}

declare global {
  interface Window {
    __mxqrTakeProRoomFragmentClaims?: () => unknown;
  }
}

function readOwnDataProperty(value: object, key: keyof EarlyClaimHandoff): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function parseEarlyClaimHandoff(value: unknown): ProRoomFragmentClaims | null {
  if (!value || typeof value !== 'object') return null;
  const activationClaim = readOwnDataProperty(value, 'activationClaim');
  const recoveryClaim = readOwnDataProperty(value, 'recoveryClaim');
  const recoveryPresent = readOwnDataProperty(value, 'recoveryPresent');
  if (typeof recoveryPresent !== 'boolean') return null;
  return {
    activationClaimToken: parseProRoomClaimToken(activationClaim),
    ownerRecoveryClaimToken: parseProRoomOwnerRecoveryClaimToken(recoveryClaim),
    ownerRecoveryClaimPresent: recoveryPresent,
  };
}

function takeEarlyClaimHandoff(): ProRoomFragmentClaims | null {
  if (typeof window === 'undefined') return null;
  const descriptor = Object.getOwnPropertyDescriptor(window, PRO_ROOM_EARLY_HANDOFF_KEY);
  const take = descriptor?.value;
  if (typeof take !== 'function') return null;

  try {
    return parseEarlyClaimHandoff(Reflect.apply(take, undefined, []));
  } catch {
    return null;
  }
}

// setup-flow is in the eagerly imported setup graph, so this consumes the
// non-enumerable bootstrap closure during module evaluation. The credential
// then lives only in this module closure until the direct-entry flow takes it.
let earlyFragmentClaims = takeEarlyClaimHandoff();

/**
 * Consume every owner credential from the URL fragment in one synchronous
 * operation and immediately remove the complete fragment from the address
 * bar. Claims are deliberately never accepted from the query string, where
 * proxies and analytics commonly log them.
 */
export function takeProRoomClaimsFromFragment(
  location?: ClaimLocation,
  history?: ClaimHistory,
): ProRoomFragmentClaims {
  if (!location && !history && earlyFragmentClaims) {
    const claims = earlyFragmentClaims;
    earlyFragmentClaims = null;
    return claims;
  }

  const currentLocation = location ?? window.location;
  const currentHistory = history ?? window.history;
  const rawHash = currentLocation.hash.startsWith('#')
    ? currentLocation.hash.slice(1)
    : currentLocation.hash;
  if (!rawHash) {
    return {
      activationClaimToken: null,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
    };
  }

  const params = new URLSearchParams(rawHash);
  const activationClaims = params.getAll(PRO_ROOM_CLAIM_FRAGMENT_KEY);
  const recoveryClaims = params.getAll(PRO_ROOM_RECOVERY_FRAGMENT_KEY);
  if (activationClaims.length === 0 && recoveryClaims.length === 0) {
    return {
      activationClaimToken: null,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
    };
  }

  // Scrub first, before validation or any asynchronous work. Even malformed or
  // duplicated credentials must not remain copyable from the address bar.
  currentHistory.replaceState(
    currentHistory.state,
    '',
    `${currentLocation.pathname}${currentLocation.search}`,
  );
  return {
    activationClaimToken:
      activationClaims.length === 1 ? parseProRoomClaimToken(activationClaims[0]) : null,
    ownerRecoveryClaimToken:
      recoveryClaims.length === 1 ? parseProRoomOwnerRecoveryClaimToken(recoveryClaims[0]) : null,
    ownerRecoveryClaimPresent: recoveryClaims.length > 0,
  };
}
