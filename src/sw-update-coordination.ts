const UPDATE_DISMISSAL_KEY = 'mxqr-sw-update-dismissal-v1';
const UPDATE_PROMPT_LEASE_KEY = 'mxqr-sw-update-prompt-lease-v1';
const UPDATE_CHECK_LEASE_KEY = 'mxqr-sw-update-check-lease-v1';
const KNOWN_GENERATION_DISMISSAL_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_GENERATION_DISMISSAL_MS = 30 * 60 * 1000;
const PRESENTATION_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const UPDATE_PROMPT_LEASE_MS = 5 * 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const WORKER_GENERATION_TIMEOUT_MS = 750;

const SW_GENERATION_REQUEST = 'MXQR_SW_GENERATION_REQUEST';
const SW_GENERATION_RESPONSE = 'MXQR_SW_GENERATION_RESPONSE';

interface StoredDismissal {
  identity: string;
  expiresAt: number;
}

interface StoredLease {
  identity?: string;
  owner: string;
  updatedAt: number;
  expiresAt: number;
}

interface ServiceWorkerGeneration {
  cacheVersion: string | null;
  promptIdentity: string;
}

interface ServiceWorkerGenerationResolver {
  consumeMessage(data: unknown): boolean;
  resolve(worker: ServiceWorker): Promise<ServiceWorkerGeneration>;
}

interface ServiceWorkerUpdateLedger {
  isDismissed(generation: ServiceWorkerGeneration, now?: number): boolean;
  claimPrompt(generation: ServiceWorkerGeneration, now?: number): boolean;
  releasePrompt(generation: ServiceWorkerGeneration): void;
  rememberDismissal(generation: ServiceWorkerGeneration, now?: number): void;
  rememberPresentationFailure(generation: ServiceWorkerGeneration, now?: number): void;
  claimUpdateCheck(now?: number): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCacheVersion(value: unknown): value is string {
  return typeof value === 'string' && /^v[1-9]\d*$/.test(value);
}

function readStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readStoredRecord<T>(storage: Storage, key: string): T | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) || 'null');
    return isRecord(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

function writeStoredRecord(storage: Storage, key: string, value: object): boolean {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeStoredRecord(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage cleanup is advisory; update activation must keep working.
  }
}

function ownerId(): string {
  try {
    return `client:${crypto.randomUUID()}`;
  } catch {
    return `client:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }
}

function unknownWorkerIdentity(worker: ServiceWorker): string {
  try {
    const url = new URL(worker.scriptURL, globalThis.location?.href);
    url.hash = '';
    return `unknown:${url.href}`;
  } catch {
    return 'unknown:/service-worker.js';
  }
}

export function createServiceWorkerGenerationResolver(): ServiceWorkerGenerationResolver {
  let requestSequence = 0;
  const requestOwner = ownerId();
  const pending = new Map<
    string,
    { finish: (cacheVersion: string | null) => void; worker: ServiceWorker }
  >();
  const cached = new WeakMap<ServiceWorker, Promise<ServiceWorkerGeneration>>();

  const resolve = (worker: ServiceWorker): Promise<ServiceWorkerGeneration> => {
    const existing = cached.get(worker);
    if (existing) return existing;

    const resolution = new Promise<string | null>((complete) => {
      const requestId = `${requestOwner}:${Date.now().toString(36)}:${(requestSequence += 1).toString(
        36,
      )}`;
      let settled = false;
      const finish = (cacheVersion: string | null) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        pending.delete(requestId);
        complete(cacheVersion);
      };
      const timeout = globalThis.setTimeout(() => finish(null), WORKER_GENERATION_TIMEOUT_MS);
      pending.set(requestId, { finish, worker });
      try {
        worker.postMessage({ type: SW_GENERATION_REQUEST, requestId });
      } catch {
        finish(null);
      }
    }).then((cacheVersion): ServiceWorkerGeneration => {
      return {
        cacheVersion,
        promptIdentity: cacheVersion || unknownWorkerIdentity(worker),
      };
    });

    cached.set(worker, resolution);
    return resolution;
  };

  return {
    consumeMessage(data) {
      if (!isRecord(data) || data.type !== SW_GENERATION_RESPONSE) return false;
      if (typeof data.requestId !== 'string') return true;
      const request = pending.get(data.requestId);
      if (!request) return true;
      request.finish(isCacheVersion(data.cacheVersion) ? data.cacheVersion : null);
      return true;
    },
    resolve,
  };
}

export function createServiceWorkerUpdateLedger(): ServiceWorkerUpdateLedger {
  const storage = readStorage();
  const owner = ownerId();

  const isDismissed = (generation: ServiceWorkerGeneration, now = Date.now()): boolean => {
    if (!storage) return false;
    const dismissal = readStoredRecord<StoredDismissal>(storage, UPDATE_DISMISSAL_KEY);
    if (
      !dismissal ||
      typeof dismissal.identity !== 'string' ||
      typeof dismissal.expiresAt !== 'number'
    ) {
      return false;
    }
    if (dismissal.expiresAt <= now) {
      removeStoredRecord(storage, UPDATE_DISMISSAL_KEY);
      return false;
    }
    return dismissal.identity === generation.promptIdentity;
  };

  const storeDismissal = (
    generation: ServiceWorkerGeneration,
    duration: number,
    now: number,
  ): void => {
    if (!storage) return;
    writeStoredRecord(storage, UPDATE_DISMISSAL_KEY, {
      identity: generation.promptIdentity,
      expiresAt: now + duration,
    });
  };

  return {
    isDismissed,
    claimPrompt(generation, now = Date.now()) {
      if (!storage) return true;
      const current = readStoredRecord<StoredLease>(storage, UPDATE_PROMPT_LEASE_KEY);
      if (
        current &&
        current.identity === generation.promptIdentity &&
        current.owner !== owner &&
        current.expiresAt > now
      ) {
        return false;
      }
      const claimed = writeStoredRecord(storage, UPDATE_PROMPT_LEASE_KEY, {
        identity: generation.promptIdentity,
        owner,
        updatedAt: now,
        expiresAt: now + UPDATE_PROMPT_LEASE_MS,
      });
      if (!claimed) return true;
      return readStoredRecord<StoredLease>(storage, UPDATE_PROMPT_LEASE_KEY)?.owner === owner;
    },
    releasePrompt(generation) {
      if (!storage) return;
      const current = readStoredRecord<StoredLease>(storage, UPDATE_PROMPT_LEASE_KEY);
      if (current?.owner === owner && current.identity === generation.promptIdentity) {
        removeStoredRecord(storage, UPDATE_PROMPT_LEASE_KEY);
      }
    },
    rememberDismissal(generation, now = Date.now()) {
      const duration = generation.cacheVersion
        ? KNOWN_GENERATION_DISMISSAL_MS
        : UNKNOWN_GENERATION_DISMISSAL_MS;
      storeDismissal(generation, duration, now);
    },
    rememberPresentationFailure(generation, now = Date.now()) {
      storeDismissal(generation, PRESENTATION_FAILURE_COOLDOWN_MS, now);
    },
    claimUpdateCheck(now = Date.now()) {
      if (!storage) return true;
      const current = readStoredRecord<StoredLease>(storage, UPDATE_CHECK_LEASE_KEY);
      if (current && current.updatedAt > now - UPDATE_CHECK_INTERVAL_MS) return false;
      const claimed = writeStoredRecord(storage, UPDATE_CHECK_LEASE_KEY, {
        owner,
        updatedAt: now,
        expiresAt: now + UPDATE_CHECK_INTERVAL_MS,
      });
      if (!claimed) return true;
      return readStoredRecord<StoredLease>(storage, UPDATE_CHECK_LEASE_KEY)?.owner === owner;
    },
  };
}
