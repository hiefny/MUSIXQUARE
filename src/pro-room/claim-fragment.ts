import {
  parseProRoomClaimToken,
  parseProRoomOwnerRecoveryClaimToken,
  parseProRoomOwnerTransferClaimToken,
  type ProRoomClaimToken,
  type ProRoomOwnerRecoveryClaimToken,
  type ProRoomOwnerTransferClaimToken,
} from './credentials.ts';

const PRO_ROOM_CLAIM_FRAGMENT_KEY = 'pro-claim';
const PRO_ROOM_RECOVERY_FRAGMENT_KEY = 'pro-recovery';
const PRO_ROOM_TRANSFER_FRAGMENT_KEY = 'pro-transfer';
const PRO_ROOM_EARLY_HANDOFF_KEY = '__mxqrTakeProRoomFragmentClaims';

type ClaimPurpose = 'activation' | 'recovery' | 'transfer';

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
  activationClaimPresent: boolean;
  ownerRecoveryClaimToken: ProRoomOwnerRecoveryClaimToken | null;
  ownerRecoveryClaimPresent: boolean;
  ownerTransferClaimToken: ProRoomOwnerTransferClaimToken | null;
  ownerTransferClaimPresent: boolean;
}

interface EarlyClaimHandoff {
  activationClaim: unknown;
  activationPresent: boolean;
  recoveryClaim: unknown;
  recoveryPresent: boolean;
  transferClaim: unknown;
  transferPresent: boolean;
}

interface QueryClaimScan {
  activationPresent: boolean;
  recoveryPresent: boolean;
  transferPresent: boolean;
  sanitizedSearch: string;
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
  const activationPresent = readOwnDataProperty(value, 'activationPresent');
  const recoveryClaim = readOwnDataProperty(value, 'recoveryClaim');
  const recoveryPresent = readOwnDataProperty(value, 'recoveryPresent');
  const transferClaim = readOwnDataProperty(value, 'transferClaim');
  const transferPresent = readOwnDataProperty(value, 'transferPresent');
  if (
    typeof activationPresent !== 'boolean' ||
    typeof recoveryPresent !== 'boolean' ||
    typeof transferPresent !== 'boolean'
  )
    return null;
  return {
    activationClaimToken: parseProRoomClaimToken(activationClaim),
    activationClaimPresent: activationPresent,
    ownerRecoveryClaimToken: parseProRoomOwnerRecoveryClaimToken(recoveryClaim),
    ownerRecoveryClaimPresent: recoveryPresent,
    ownerTransferClaimToken: parseProRoomOwnerTransferClaimToken(transferClaim),
    ownerTransferClaimPresent: transferPresent,
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

function claimPurposeForKey(key: string): ClaimPurpose | null {
  switch (key.toLowerCase()) {
    case PRO_ROOM_CLAIM_FRAGMENT_KEY:
      return 'activation';
    case PRO_ROOM_RECOVERY_FRAGMENT_KEY:
      return 'recovery';
    case PRO_ROOM_TRANSFER_FRAGMENT_KEY:
      return 'transfer';
    default:
      return null;
  }
}

function scanQueryClaims(search: string): QueryClaimScan {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const claimKeys: string[] = [];
  let activationPresent = false;
  let recoveryPresent = false;
  let transferPresent = false;
  params.forEach((_value, key) => {
    const purpose = claimPurposeForKey(key);
    if (!purpose) return;
    claimKeys.push(key);
    if (purpose === 'activation') activationPresent = true;
    if (purpose === 'recovery') recoveryPresent = true;
    if (purpose === 'transfer') transferPresent = true;
  });
  for (const key of claimKeys) params.delete(key);
  const sanitized = params.toString();
  return {
    activationPresent,
    recoveryPresent,
    transferPresent,
    sanitizedSearch: sanitized ? `?${sanitized}` : '',
  };
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
  const queryClaims = scanQueryClaims(currentLocation.search);
  const queryClaimPresent =
    queryClaims.activationPresent || queryClaims.recoveryPresent || queryClaims.transferPresent;
  const rawHash = currentLocation.hash.startsWith('#')
    ? currentLocation.hash.slice(1)
    : currentLocation.hash;
  if (!rawHash && !queryClaimPresent) {
    return {
      activationClaimToken: null,
      activationClaimPresent: false,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: false,
    };
  }

  const params = new URLSearchParams(rawHash);
  const activationClaims = params.getAll(PRO_ROOM_CLAIM_FRAGMENT_KEY);
  const recoveryClaims = params.getAll(PRO_ROOM_RECOVERY_FRAGMENT_KEY);
  const transferClaims = params.getAll(PRO_ROOM_TRANSFER_FRAGMENT_KEY);
  const fragmentClaimPresent =
    activationClaims.length > 0 || recoveryClaims.length > 0 || transferClaims.length > 0;
  if (!fragmentClaimPresent && !queryClaimPresent) {
    return {
      activationClaimToken: null,
      activationClaimPresent: false,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: false,
    };
  }

  // Scrub first, before validation or any asynchronous work. Even malformed or
  // duplicated credentials must not remain copyable from the address bar.
  currentHistory.replaceState(
    currentHistory.state,
    '',
    `${currentLocation.pathname}${
      queryClaimPresent ? queryClaims.sanitizedSearch : currentLocation.search
    }${fragmentClaimPresent ? '' : currentLocation.hash}`,
  );
  if (queryClaimPresent) {
    // Query-string credentials are categorically invalid. Preserve only
    // purpose markers so the caller shows the terminal damaged-link UX; no
    // query value is parsed as a claim or retained after the synchronous scrub.
    return {
      activationClaimToken: null,
      activationClaimPresent: queryClaims.activationPresent || activationClaims.length > 0,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: queryClaims.recoveryPresent || recoveryClaims.length > 0,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: queryClaims.transferPresent || transferClaims.length > 0,
    };
  }
  return {
    activationClaimToken:
      activationClaims.length === 1 ? parseProRoomClaimToken(activationClaims[0]) : null,
    activationClaimPresent: activationClaims.length > 0,
    ownerRecoveryClaimToken:
      recoveryClaims.length === 1 ? parseProRoomOwnerRecoveryClaimToken(recoveryClaims[0]) : null,
    ownerRecoveryClaimPresent: recoveryClaims.length > 0,
    ownerTransferClaimToken:
      transferClaims.length === 1 ? parseProRoomOwnerTransferClaimToken(transferClaims[0]) : null,
    ownerTransferClaimPresent: transferClaims.length > 0,
  };
}
