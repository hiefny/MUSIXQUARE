import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { queryCurrent } from './release-deployment-state.mts';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_MAX_BYTES = 512 * 1024;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const SIGNALING_CONFIG = 'cloudflare/wrangler.signaling.toml';
const SIGNALING_STATE_FILE = 'signaling-state.json';
const DEPLOYMENT_ID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const EDGE_DETACH_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 15_000, 30_000]);

export const SIGNALING_SERVICE = 'musixquare-signaling';
export const PRIMARY_SIGNALING_DOMAIN = 'signal.musixquare.com';
export const ALTERNATE_SIGNALING_DOMAIN = 'signal-alt.musixquare.com';
const ALTERNATE_SIGNALING_HTTP_ORIGIN = `https://${ALTERNATE_SIGNALING_DOMAIN}`;
export const SIGNALING_DOMAIN_CHECKPOINT_FILE = 'signaling-domain-checkpoint.json';
export const SIGNALING_DOMAIN_ATTEMPT_FILE = 'signaling-domain-attempt.json';
export const SIGNALING_DOMAIN_RECOVERY_FILE = 'signaling-domain-recovery.json';
export const SIGNALING_DOMAIN_VERIFICATION_FILE = 'signaling-domain-recovery-verification.json';
export const SIGNALING_DOMAIN_CANDIDATE_VERIFICATION_FILE =
  'signaling-domain-candidate-verification.json';

const KNOWN_HOSTNAMES = Object.freeze([PRIMARY_SIGNALING_DOMAIN, ALTERNATE_SIGNALING_DOMAIN]);
const RELEASE_TARGETS = new Set([
  'all',
  'app',
  'developer-api',
  'pro-room',
  'remote-share',
  'signaling',
]);
const DOMAIN_ID_RE = /^[0-9a-f]{32,64}$/u;
const ZONE_ID_RE = /^[0-9a-f]{32}$/u;
const RELEASE_MESSAGE_RE = /^git:[0-9a-f]{40}$/u;
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

type DomainFetcher = typeof fetch;
type DomainEnvironment = Readonly<Record<string, string | undefined>>;

export interface SignalingDomainIdentity {
  readonly id: string;
  readonly hostname: string;
  readonly service: string;
  readonly environment: 'production';
  readonly zoneId: string;
  readonly zoneName: string;
}

export interface WorkerDomainIdentity {
  readonly id: string;
  readonly hostname: string;
  readonly service: string;
  readonly environment: string | null;
  readonly zoneId: string;
  readonly zoneName: string;
}

interface SignalingDomainCheckpoint {
  readonly schemaVersion: 1;
  readonly releaseTarget: string;
  readonly releaseMessage: string;
  readonly capturedAt: string;
  readonly status: 'captured';
  readonly inventoryFingerprint: string;
  readonly domains: readonly SignalingDomainIdentity[];
}

interface SignalingDomainAttempt {
  readonly schemaVersion: 1;
  readonly releaseTarget: string;
  readonly releaseMessage: string;
  readonly authorizedAt: string;
  readonly startedAt: string | null;
  readonly recordedAt: string | null;
  readonly status: 'authorized' | 'deploy-started' | 'recorded';
  readonly baselineFingerprint: string;
  readonly candidateFingerprint: string | null;
  readonly candidateDeployment: SignalingDeploymentIdentity | null;
  readonly domains: readonly SignalingDomainIdentity[] | null;
}

interface SignalingDeploymentIdentity {
  readonly deploymentId: string;
  readonly versionId: string;
  readonly message: string | null;
}

interface SignalingDomainRecoveryReport {
  readonly schemaVersion: 1;
  readonly releaseTarget: string;
  readonly recordedAt: string;
  readonly status: 'restored' | 'already-restored' | 'verified' | 'failed';
  readonly mutation: 'none' | 'detach-requested' | 'detached-alternate';
  readonly error?: string;
}

export interface SignalingDomainStateOptions {
  readonly fetcher?: DomainFetcher;
  readonly edgeFetcher?: DomainFetcher;
  readonly env?: DomainEnvironment;
  readonly now?: () => string;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly edgeRetryDelaysMs?: readonly number[];
  readonly querySignalingDeployment?: (outputPath: string) => SignalingDeploymentIdentity;
}

interface WorkerDomainFilter {
  readonly hostname?: string;
  readonly service?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function signalingSelected(releaseTarget: string): boolean {
  if (!RELEASE_TARGETS.has(releaseTarget)) throw new Error('Release target is invalid.');
  return releaseTarget === 'all' || releaseTarget === 'signaling';
}

function writeJson(filePath: string, value: unknown): void {
  const absolute = resolve(filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(resolve(filePath), 'utf8')) as unknown;
}

function cancelBody(response: Response, reason: string): void {
  try {
    const cancellation = response.body?.cancel(reason);
    if (cancellation && typeof cancellation.catch === 'function') {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // Cleanup must not replace the bounded protocol error.
  }
}

async function readBoundedJson(response: Response, label: string): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_MAX_BYTES) {
    cancelBody(response, `${label} response exceeded its size limit.`);
    throw new Error(`${label} response exceeded its size limit.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} returned an empty response.`);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > RESPONSE_MAX_BYTES) {
        void reader.cancel(`${label} response exceeded its size limit.`).catch(() => undefined);
        throw new Error(`${label} response exceeded its size limit.`);
      }
      chunks.push(next.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The bounded read error remains authoritative.
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} did not return valid UTF-8 JSON.`);
  }
}

function credentials(env: DomainEnvironment): {
  readonly accountId: string;
  readonly token: string;
} {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || '';
  const token = env.CLOUDFLARE_API_TOKEN || '';
  if (!ZONE_ID_RE.test(accountId) || !token) {
    throw new Error('Signaling domain state requires Cloudflare account credentials.');
  }
  return { accountId, token };
}

async function cloudflareRequest(
  path: string,
  method: 'GET' | 'DELETE',
  label: string,
  { fetcher, env }: { readonly fetcher: DomainFetcher; readonly env: DomainEnvironment },
): Promise<unknown> {
  const { accountId, token } = credentials(env);
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(`${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}${path}`, {
      method,
      redirect: 'error',
      signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error(`${label} request failed.`);
  }
  if (!response.ok) {
    cancelBody(response, `${label} returned a non-success status.`);
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
  return readBoundedJson(response, label);
}

function parseDomain(value: unknown): WorkerDomainIdentity {
  if (!isRecord(value)) throw new Error('Cloudflare domain inventory contains a malformed row.');
  const id = value.id;
  const hostname = value.hostname;
  const service = value.service;
  const zoneId = value.zone_id;
  const zoneName = value.zone_name;
  const environment = value.environment;
  if (
    typeof id !== 'string' ||
    !DOMAIN_ID_RE.test(id) ||
    typeof hostname !== 'string' ||
    !HOSTNAME_RE.test(hostname) ||
    hostname !== hostname.toLowerCase() ||
    typeof service !== 'string' ||
    !service ||
    typeof zoneId !== 'string' ||
    !ZONE_ID_RE.test(zoneId) ||
    typeof zoneName !== 'string' ||
    !HOSTNAME_RE.test(zoneName) ||
    (environment !== undefined &&
      environment !== null &&
      (typeof environment !== 'string' || !environment))
  ) {
    throw new Error('Cloudflare domain inventory contains a malformed identity.');
  }
  return {
    id,
    hostname,
    service,
    environment: typeof environment === 'string' ? environment : null,
    zoneId,
    zoneName,
  };
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Cloudflare domain pagination has an invalid ${label}.`);
  }
  return Number(value);
}

function parseListEnvelope(
  value: unknown,
  requestedPage: number,
): {
  readonly domains: WorkerDomainIdentity[];
  readonly page: number;
  readonly perPage: number;
  readonly totalCount: number;
  readonly totalPages: number;
} {
  if (
    !isRecord(value) ||
    value.success !== true ||
    !Array.isArray(value.errors) ||
    value.errors.length !== 0 ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.result) ||
    !isRecord(value.result_info)
  ) {
    throw new Error('Cloudflare domain list returned an invalid API envelope.');
  }
  const page = integer(value.result_info.page, 'page');
  const perPage = integer(value.result_info.per_page, 'per-page count');
  const count = integer(value.result_info.count, 'page count');
  const totalCount = integer(value.result_info.total_count, 'total count');
  if (page !== requestedPage || perPage < 1 || count !== value.result.length || count > perPage) {
    throw new Error('Cloudflare domain list returned inconsistent pagination.');
  }
  const calculatedPages = Math.max(1, Math.ceil(totalCount / perPage));
  const declaredPages =
    value.result_info.total_pages === undefined || value.result_info.total_pages === null
      ? calculatedPages
      : integer(value.result_info.total_pages, 'total pages');
  if (declaredPages !== calculatedPages || declaredPages > MAX_PAGES) {
    throw new Error('Cloudflare domain list returned an unsafe page count.');
  }
  return {
    domains: value.result.map(parseDomain),
    page,
    perPage,
    totalCount,
    totalPages: declaredPages,
  };
}

export async function listWorkerDomains(
  { fetcher = globalThis.fetch, env = process.env }: SignalingDomainStateOptions = {},
  filter: WorkerDomainFilter = {},
): Promise<WorkerDomainIdentity[]> {
  // Cloudflare documents `result_info.total_count` as the account-wide total
  // before search parameters are applied. Fetching with hostname/service
  // filters and comparing the filtered rows with that total therefore cannot
  // prove completeness. Read the exact account inventory first, validate its
  // full pagination boundary, and only then apply release-owned filters in
  // memory.
  const domains: WorkerDomainIdentity[] = [];
  let expectedTotal = -1;
  let expectedPages = -1;
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: String(PAGE_SIZE) });
    const payload = await cloudflareRequest(
      `/workers/domains?${query.toString()}`,
      'GET',
      'Cloudflare signaling domain inventory',
      { fetcher, env },
    );
    const parsed = parseListEnvelope(payload, page);
    if (page === 1) {
      expectedTotal = parsed.totalCount;
      expectedPages = parsed.totalPages;
    } else if (parsed.totalCount !== expectedTotal || parsed.totalPages !== expectedPages) {
      throw new Error('Cloudflare domain inventory changed during pagination.');
    }
    domains.push(...parsed.domains);
    if (page === expectedPages) break;
  }
  if (domains.length !== expectedTotal) {
    throw new Error('Cloudflare domain inventory returned an incomplete result set.');
  }
  const ids = new Set<string>();
  const hostnames = new Set<string>();
  for (const domain of domains) {
    if (ids.has(domain.id) || hostnames.has(domain.hostname)) {
      throw new Error('Cloudflare domain inventory contains a duplicate identity.');
    }
    ids.add(domain.id);
    hostnames.add(domain.hostname);
  }
  return domains.filter(
    (domain) =>
      (!filter.hostname || domain.hostname === filter.hostname) &&
      (!filter.service || domain.service === filter.service),
  );
}

function exactSignalingDomain(
  domain: WorkerDomainIdentity,
  expectedHostname: string,
): SignalingDomainIdentity {
  if (domain.hostname !== expectedHostname) {
    throw new Error('Cloudflare ignored an exact signaling hostname filter.');
  }
  if (domain.service !== SIGNALING_SERVICE) {
    throw new Error('A known signaling hostname is owned by another Worker.');
  }
  if (domain.zoneName !== 'musixquare.com') {
    throw new Error('A signaling Custom Domain belongs to an unexpected zone.');
  }
  if (domain.environment !== null && domain.environment !== 'production') {
    throw new Error('A signaling Custom Domain belongs to a non-production environment.');
  }
  return { ...domain, environment: 'production' };
}

function inventoryFingerprint(domains: readonly SignalingDomainIdentity[]): string {
  return createHash('sha256').update(JSON.stringify(domains)).digest('hex');
}

function sameInventory(
  left: readonly SignalingDomainIdentity[],
  right: readonly SignalingDomainIdentity[],
): boolean {
  return inventoryFingerprint(left) === inventoryFingerprint(right);
}

function sameDomain(
  left: SignalingDomainIdentity | undefined,
  right: SignalingDomainIdentity | undefined,
): boolean {
  return Boolean(left && right && sameInventory([left], [right]));
}

async function readSignalingInventory(
  options: SignalingDomainStateOptions,
): Promise<SignalingDomainIdentity[]> {
  const accountInventory = await listWorkerDomains(options);
  const primaryRows = accountInventory.filter(
    (domain) => domain.hostname === PRIMARY_SIGNALING_DOMAIN,
  );
  const alternateRows = accountInventory.filter(
    (domain) => domain.hostname === ALTERNATE_SIGNALING_DOMAIN,
  );
  const ownedRows = accountInventory.filter((domain) => domain.service === SIGNALING_SERVICE);
  if (primaryRows.length !== 1 || alternateRows.length > 1) {
    throw new Error('Cloudflare returned a missing or duplicate exact signaling hostname.');
  }
  const primaryRow = primaryRows[0];
  if (!primaryRow) throw new Error('The primary signaling Custom Domain is absent.');
  const selected = [exactSignalingDomain(primaryRow, PRIMARY_SIGNALING_DOMAIN)];
  const alternateRow = alternateRows[0];
  if (alternateRow) {
    selected.push(exactSignalingDomain(alternateRow, ALTERNATE_SIGNALING_DOMAIN));
  }
  const selectedById = new Map(selected.map((domain) => [domain.id, domain]));
  if (
    ownedRows.length !== selected.length ||
    ownedRows.some((domain) => {
      if (!KNOWN_HOSTNAMES.includes(domain.hostname as never)) return true;
      const selectedDomain = selectedById.get(domain.id);
      return !selectedDomain || domain.hostname !== selectedDomain.hostname;
    })
  ) {
    throw new Error('The signaling Worker owns an unknown or inconsistent Custom Domain.');
  }
  return selected.sort((left, right) => left.hostname.localeCompare(right.hostname));
}

function parseDomainIdentity(value: unknown): SignalingDomainIdentity {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !DOMAIN_ID_RE.test(value.id) ||
    typeof value.hostname !== 'string' ||
    !KNOWN_HOSTNAMES.includes(value.hostname as never) ||
    value.service !== SIGNALING_SERVICE ||
    value.environment !== 'production' ||
    typeof value.zoneId !== 'string' ||
    !ZONE_ID_RE.test(value.zoneId) ||
    value.zoneName !== 'musixquare.com'
  ) {
    throw new Error('Signaling domain recovery evidence contains a malformed identity.');
  }
  return {
    id: value.id,
    hostname: value.hostname,
    service: SIGNALING_SERVICE,
    environment: 'production',
    zoneId: value.zoneId,
    zoneName: value.zoneName,
  };
}

function parseEvidenceDomains(value: unknown): SignalingDomainIdentity[] {
  if (!Array.isArray(value)) {
    throw new Error('Signaling domain recovery evidence has no domain inventory.');
  }
  const parsed = value
    .map(parseDomainIdentity)
    .sort((left, right) => left.hostname.localeCompare(right.hostname));
  if (
    parsed.length < 1 ||
    parsed.length > 2 ||
    new Set(parsed.map((domain) => domain.id)).size !== parsed.length ||
    new Set(parsed.map((domain) => domain.hostname)).size !== parsed.length ||
    !parsed.some((domain) => domain.hostname === PRIMARY_SIGNALING_DOMAIN)
  ) {
    throw new Error('Signaling domain recovery evidence has an invalid exact inventory.');
  }
  return parsed;
}

function releaseMessage(env: DomainEnvironment): string {
  const value = env.RELEASE_MESSAGE || '';
  if (!RELEASE_MESSAGE_RE.test(value)) {
    throw new Error('Signaling domain recovery requires the exact release identity.');
  }
  return value;
}

function parseDeploymentIdentity(value: unknown): SignalingDeploymentIdentity {
  if (
    !isRecord(value) ||
    typeof value.deploymentId !== 'string' ||
    !DEPLOYMENT_ID_RE.test(value.deploymentId) ||
    typeof value.versionId !== 'string' ||
    !DEPLOYMENT_ID_RE.test(value.versionId) ||
    (value.message !== null &&
      (typeof value.message !== 'string' ||
        value.message.length < 1 ||
        value.message.length > 200 ||
        /[\u0000-\u001f\u007f]/u.test(value.message)))
  ) {
    throw new Error('Signaling domain evidence has a malformed Worker deployment identity.');
  }
  return {
    deploymentId: value.deploymentId,
    versionId: value.versionId,
    message: value.message,
  };
}

function assertRecordedDeploymentBoundary(
  directory: string,
  current: SignalingDeploymentIdentity,
  expectedReleaseMessage: string,
): SignalingDeploymentIdentity {
  const value = readJson(resolve(directory, SIGNALING_STATE_FILE));
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.target !== 'signaling' ||
    value.config !== SIGNALING_CONFIG ||
    value.releaseMessage !== expectedReleaseMessage ||
    value.attempted !== true
  ) {
    throw new Error('Recorded signaling Worker ownership evidence is missing or malformed.');
  }
  const baseline = parseDeploymentIdentity({
    deploymentId: value.beforeDeploymentId,
    versionId: value.beforeVersionId,
    message: value.beforeMessage ?? null,
  });
  if (!sameDeployment(current, baseline) && current.message !== expectedReleaseMessage) {
    throw new Error('Live signaling Worker is neither the captured baseline nor this release.');
  }
  return current;
}

function queryLiveSignalingDeployment(outputPath: string): SignalingDeploymentIdentity {
  const current = queryCurrent('signaling', SIGNALING_CONFIG, outputPath);
  return parseDeploymentIdentity({
    deploymentId: current.deploymentId,
    versionId: current.versionId,
    message: current.message,
  });
}

function sameDeployment(
  left: SignalingDeploymentIdentity,
  right: SignalingDeploymentIdentity,
): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.versionId === right.versionId &&
    left.message === right.message
  );
}

function parseCheckpoint(
  releaseTarget: string,
  directory: string,
  env: DomainEnvironment,
): SignalingDomainCheckpoint {
  const value = readJson(resolve(directory, SIGNALING_DOMAIN_CHECKPOINT_FILE));
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.releaseTarget !== releaseTarget ||
    value.releaseMessage !== releaseMessage(env) ||
    typeof value.capturedAt !== 'string' ||
    value.status !== 'captured' ||
    typeof value.inventoryFingerprint !== 'string'
  ) {
    throw new Error('Signaling domain recovery checkpoint is missing or malformed.');
  }
  const domains = parseEvidenceDomains(value.domains);
  if (value.inventoryFingerprint !== inventoryFingerprint(domains)) {
    throw new Error('Signaling domain recovery checkpoint fingerprint does not match.');
  }
  return {
    schemaVersion: 1,
    releaseTarget,
    releaseMessage: value.releaseMessage,
    capturedAt: value.capturedAt,
    status: 'captured',
    inventoryFingerprint: value.inventoryFingerprint,
    domains,
  };
}

function parseAttempt(
  releaseTarget: string,
  directory: string,
  checkpoint: SignalingDomainCheckpoint,
): SignalingDomainAttempt {
  const value = readJson(resolve(directory, SIGNALING_DOMAIN_ATTEMPT_FILE));
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.releaseTarget !== releaseTarget ||
    value.releaseMessage !== checkpoint.releaseMessage ||
    typeof value.authorizedAt !== 'string' ||
    (value.startedAt !== null && typeof value.startedAt !== 'string') ||
    (value.recordedAt !== null && typeof value.recordedAt !== 'string') ||
    (value.status !== 'authorized' &&
      value.status !== 'deploy-started' &&
      value.status !== 'recorded') ||
    value.baselineFingerprint !== checkpoint.inventoryFingerprint ||
    (value.candidateFingerprint !== null && typeof value.candidateFingerprint !== 'string')
  ) {
    throw new Error('Signaling domain attempt evidence is missing or malformed.');
  }
  const domains = value.domains === null ? null : parseEvidenceDomains(value.domains);
  const candidateDeployment =
    value.candidateDeployment === null ? null : parseDeploymentIdentity(value.candidateDeployment);
  if (
    (value.status === 'authorized' &&
      (value.startedAt !== null ||
        value.recordedAt !== null ||
        value.candidateFingerprint !== null ||
        candidateDeployment !== null ||
        domains !== null)) ||
    (value.status === 'deploy-started' &&
      (!value.startedAt ||
        value.recordedAt !== null ||
        value.candidateFingerprint !== null ||
        candidateDeployment !== null ||
        domains !== null)) ||
    (value.status === 'recorded' &&
      (!value.startedAt ||
        !value.recordedAt ||
        !value.candidateFingerprint ||
        !candidateDeployment ||
        !domains ||
        value.candidateFingerprint !== inventoryFingerprint(domains)))
  ) {
    throw new Error('Signaling domain attempt evidence has an inconsistent state.');
  }
  return {
    schemaVersion: 1,
    releaseTarget,
    releaseMessage: checkpoint.releaseMessage,
    authorizedAt: value.authorizedAt,
    startedAt: value.startedAt,
    recordedAt: value.recordedAt,
    status: value.status,
    baselineFingerprint: checkpoint.inventoryFingerprint,
    candidateFingerprint: value.candidateFingerprint,
    candidateDeployment,
    domains,
  };
}

function writeRecoveryReport(
  directory: string,
  file: string,
  report: SignalingDomainRecoveryReport,
): void {
  writeJson(resolve(directory, file), report);
}

export async function captureSignalingDomainCheckpoint(
  releaseTarget: string,
  directory: string,
  {
    fetcher = globalThis.fetch,
    env = process.env,
    now = () => new Date().toISOString(),
  }: SignalingDomainStateOptions = {},
): Promise<SignalingDomainCheckpoint | null> {
  if (!signalingSelected(releaseTarget)) return null;
  const domains = await readSignalingInventory({ fetcher, env });
  const checkpoint: SignalingDomainCheckpoint = {
    schemaVersion: 1,
    releaseTarget,
    releaseMessage: releaseMessage(env),
    capturedAt: now(),
    status: 'captured',
    inventoryFingerprint: inventoryFingerprint(domains),
    domains,
  };
  writeJson(resolve(directory, SIGNALING_DOMAIN_CHECKPOINT_FILE), checkpoint);
  return checkpoint;
}

export async function authorizeSignalingDomainAttempt(
  releaseTarget: string,
  directory: string,
  {
    fetcher = globalThis.fetch,
    env = process.env,
    now = () => new Date().toISOString(),
  }: SignalingDomainStateOptions = {},
): Promise<SignalingDomainAttempt | null> {
  if (!signalingSelected(releaseTarget)) return null;
  const checkpoint = parseCheckpoint(releaseTarget, directory, env);
  const current = await readSignalingInventory({ fetcher, env });
  if (!sameInventory(current, checkpoint.domains)) {
    throw new Error('Signaling Custom Domain state changed after its checkpoint was captured.');
  }
  const attempt: SignalingDomainAttempt = {
    schemaVersion: 1,
    releaseTarget,
    releaseMessage: checkpoint.releaseMessage,
    authorizedAt: now(),
    startedAt: null,
    recordedAt: null,
    status: 'authorized',
    baselineFingerprint: checkpoint.inventoryFingerprint,
    candidateFingerprint: null,
    candidateDeployment: null,
    domains: null,
  };
  writeJson(resolve(directory, SIGNALING_DOMAIN_ATTEMPT_FILE), attempt);
  return attempt;
}

export async function preflightSignalingDomainAttempt(
  releaseTarget: string,
  directory: string,
  { fetcher = globalThis.fetch, env = process.env }: SignalingDomainStateOptions = {},
): Promise<void> {
  if (!signalingSelected(releaseTarget)) return;
  const checkpoint = parseCheckpoint(releaseTarget, directory, env);
  const attempt = parseAttempt(releaseTarget, directory, checkpoint);
  if (attempt.status !== 'authorized') {
    throw new Error('Signaling domain mutation authorization is not in its pre-deploy state.');
  }
  const current = await readSignalingInventory({ fetcher, env });
  if (!sameInventory(current, checkpoint.domains)) {
    throw new Error('Signaling Custom Domain state changed before deployment.');
  }
}

export async function startSignalingDomainAttempt(
  releaseTarget: string,
  directory: string,
  {
    fetcher = globalThis.fetch,
    env = process.env,
    now = () => new Date().toISOString(),
  }: SignalingDomainStateOptions = {},
): Promise<SignalingDomainAttempt | null> {
  if (!signalingSelected(releaseTarget)) return null;
  const checkpoint = parseCheckpoint(releaseTarget, directory, env);
  const attempt = parseAttempt(releaseTarget, directory, checkpoint);
  if (attempt.status !== 'authorized') {
    throw new Error('Signaling domain mutation authorization was already consumed.');
  }
  const current = await readSignalingInventory({ fetcher, env });
  if (!sameInventory(current, checkpoint.domains)) {
    throw new Error('Signaling Custom Domain state changed before deployment was started.');
  }
  const started: SignalingDomainAttempt = {
    ...attempt,
    startedAt: now(),
    status: 'deploy-started',
  };
  writeJson(resolve(directory, SIGNALING_DOMAIN_ATTEMPT_FILE), started);
  return started;
}

export async function recordSignalingDomainAttempt(
  releaseTarget: string,
  directory: string,
  {
    fetcher = globalThis.fetch,
    env = process.env,
    now = () => new Date().toISOString(),
    querySignalingDeployment = queryLiveSignalingDeployment,
  }: SignalingDomainStateOptions = {},
): Promise<SignalingDomainAttempt | null> {
  if (!signalingSelected(releaseTarget)) return null;
  const checkpoint = parseCheckpoint(releaseTarget, directory, env);
  const attempt = parseAttempt(releaseTarget, directory, checkpoint);
  if (attempt.status !== 'deploy-started') {
    throw new Error('Signaling domain deployment-start evidence is unavailable.');
  }
  const current = await readSignalingInventory({ fetcher, env });
  const primary = current.find((domain) => domain.hostname === PRIMARY_SIGNALING_DOMAIN);
  const baselinePrimary = checkpoint.domains.find(
    (domain) => domain.hostname === PRIMARY_SIGNALING_DOMAIN,
  );
  const alternate = current.find((domain) => domain.hostname === ALTERNATE_SIGNALING_DOMAIN);
  const baselineAlternate = checkpoint.domains.find(
    (domain) => domain.hostname === ALTERNATE_SIGNALING_DOMAIN,
  );
  if (!sameDomain(primary, baselinePrimary) || !alternate || current.length !== 2) {
    throw new Error('Signaling deployment did not produce the expected exact domain inventory.');
  }
  if (baselineAlternate && !sameDomain(alternate, baselineAlternate)) {
    throw new Error('The pre-existing alternate signaling domain identity changed during deploy.');
  }
  if (
    !baselineAlternate &&
    !sameInventory(
      current.filter((domain) => domain !== alternate),
      checkpoint.domains,
    )
  ) {
    throw new Error(
      'The baseline signaling domain identity changed while attaching the alternate.',
    );
  }
  const liveDeployment = querySignalingDeployment(
    resolve(directory, 'signaling-domain-record-current.json'),
  );
  const candidateDeployment = assertRecordedDeploymentBoundary(
    directory,
    liveDeployment,
    checkpoint.releaseMessage,
  );
  const recorded: SignalingDomainAttempt = {
    ...attempt,
    recordedAt: now(),
    status: 'recorded',
    candidateFingerprint: inventoryFingerprint(current),
    candidateDeployment,
    domains: current,
  };
  writeJson(resolve(directory, SIGNALING_DOMAIN_ATTEMPT_FILE), recorded);
  return recorded;
}

async function detachDomain(
  domainId: string,
  { fetcher, env }: { readonly fetcher: DomainFetcher; readonly env: DomainEnvironment },
): Promise<void> {
  const payload = await cloudflareRequest(
    `/workers/domains/${encodeURIComponent(domainId)}`,
    'DELETE',
    'Cloudflare signaling domain detach',
    { fetcher, env },
  );
  if (
    !isRecord(payload) ||
    payload.success !== true ||
    !Array.isArray(payload.errors) ||
    payload.errors.length !== 0 ||
    !Array.isArray(payload.messages) ||
    ('result' in payload && payload.result !== null && payload.result !== undefined)
  ) {
    throw new Error('Cloudflare signaling domain detach returned an invalid API envelope.');
  }
}

function networkErrorCode(error: unknown): string {
  if (!isRecord(error) || !isRecord(error.cause)) return '';
  return typeof error.cause.code === 'string' ? error.cause.code : '';
}

async function readAlternateEdgeState(
  attempt: number,
  edgeFetcher: DomainFetcher,
): Promise<'present' | 'absent' | 'ambiguous'> {
  const url = new URL(
    `/internal/mxqr-domain-detach-probe/${attempt}-${randomUUID()}`,
    ALTERNATE_SIGNALING_HTTP_ORIGIN,
  );
  let response: Response;
  try {
    response = await edgeFetcher(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return networkErrorCode(error) === 'ENOTFOUND' ? 'absent' : 'ambiguous';
  }
  const contentType = response.headers.get('content-type') || '';
  const cacheControl = response.headers.get('cache-control') || '';
  const couldBeAttachedFingerprint =
    response.status === 404 &&
    /^application\/json(?:;|$)/iu.test(contentType) &&
    /(?:^|,)\s*no-store\s*(?:,|$)/iu.test(cacheControl);
  if (!couldBeAttachedFingerprint) {
    cancelBody(response, 'Alternate signaling edge detach probe completed.');
    return (response.status >= 200 && response.status < 300) ||
      response.status === 404 ||
      response.status === 410 ||
      response.status === 421
      ? 'absent'
      : 'ambiguous';
  }
  let body: unknown;
  try {
    body = await readBoundedJson(response, 'Alternate signaling edge detach probe');
  } catch {
    return 'ambiguous';
  }
  if (isRecord(body) && Object.keys(body).length === 1 && body.error === 'NOT_FOUND') {
    return 'present';
  }
  return 'absent';
}

async function verifyAlternateEdgeDetached({
  edgeFetcher,
  retryDelaysMs,
  wait,
}: {
  readonly edgeFetcher: DomainFetcher;
  readonly retryDelaysMs: readonly number[];
  readonly wait: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  let consecutiveAbsent = 0;
  for (let attempt = 1; ; attempt += 1) {
    const state = await readAlternateEdgeState(attempt, edgeFetcher);
    consecutiveAbsent = state === 'absent' ? consecutiveAbsent + 1 : 0;
    if (consecutiveAbsent >= 2) return;
    const delayMs = retryDelaysMs[attempt - 1];
    if (delayMs === undefined) {
      throw new Error('Alternate signaling edge detach did not converge to verified absence.');
    }
    await wait(delayMs);
  }
}

export async function restoreSignalingDomainBaseline(
  releaseTarget: string,
  directory: string,
  {
    fetcher = globalThis.fetch,
    edgeFetcher = globalThis.fetch,
    env = process.env,
    now = () => new Date().toISOString(),
    wait = (milliseconds: number) =>
      new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds)),
    edgeRetryDelaysMs = EDGE_DETACH_RETRY_DELAYS_MS,
    querySignalingDeployment = queryLiveSignalingDeployment,
  }: SignalingDomainStateOptions = {},
): Promise<SignalingDomainRecoveryReport | null> {
  if (!signalingSelected(releaseTarget)) return null;
  let issuedMutation: SignalingDomainRecoveryReport['mutation'] = 'none';
  try {
    const checkpoint = parseCheckpoint(releaseTarget, directory, env);
    const attempt = parseAttempt(releaseTarget, directory, checkpoint);
    const current = await readSignalingInventory({ fetcher, env });
    if (sameInventory(current, checkpoint.domains)) {
      const baselineHasAlternate = checkpoint.domains.some(
        (domain) => domain.hostname === ALTERNATE_SIGNALING_DOMAIN,
      );
      if (!baselineHasAlternate && attempt.status === 'deploy-started') {
        throw new Error(
          'An unrecorded signaling deployment may still attach the alternate domain later.',
        );
      }
      if (!baselineHasAlternate && attempt.status === 'recorded') {
        await verifyAlternateEdgeDetached({
          edgeFetcher,
          retryDelaysMs: edgeRetryDelaysMs,
          wait,
        });
        const confirmedBaseline = await readSignalingInventory({ fetcher, env });
        if (!sameInventory(confirmedBaseline, checkpoint.domains)) {
          throw new Error('Signaling domain state changed during edge-detach verification.');
        }
      }
      const report: SignalingDomainRecoveryReport = {
        schemaVersion: 1,
        releaseTarget,
        recordedAt: now(),
        status: 'already-restored',
        mutation: 'none',
      };
      writeRecoveryReport(directory, SIGNALING_DOMAIN_RECOVERY_FILE, report);
      return report;
    }
    if (checkpoint.domains.some((domain) => domain.hostname === ALTERNATE_SIGNALING_DOMAIN)) {
      throw new Error(
        'A pre-existing alternate signaling domain changed; automatic detach is forbidden.',
      );
    }
    if (attempt.status !== 'recorded' || !attempt.domains) {
      throw new Error('Candidate-created signaling domain identity evidence is unavailable.');
    }
    const baselinePrimary = checkpoint.domains.find(
      (domain) => domain.hostname === PRIMARY_SIGNALING_DOMAIN,
    );
    const currentPrimary = current.find((domain) => domain.hostname === PRIMARY_SIGNALING_DOMAIN);
    const currentAlternate = current.find(
      (domain) => domain.hostname === ALTERNATE_SIGNALING_DOMAIN,
    );
    const recordedAlternate = attempt.domains.find(
      (domain) => domain.hostname === ALTERNATE_SIGNALING_DOMAIN,
    );
    if (
      current.length !== 2 ||
      !baselinePrimary ||
      !currentPrimary ||
      !sameDomain(currentPrimary, baselinePrimary) ||
      !currentAlternate ||
      !recordedAlternate ||
      currentAlternate.id !== recordedAlternate.id ||
      !sameInventory(current, attempt.domains)
    ) {
      throw new Error('Current signaling domain identity does not match the recorded candidate.');
    }
    if (!attempt.candidateDeployment) {
      throw new Error('Recorded signaling Worker deployment identity is unavailable.');
    }
    assertRecordedDeploymentBoundary(
      directory,
      attempt.candidateDeployment,
      checkpoint.releaseMessage,
    );
    const currentDeployment = querySignalingDeployment(
      resolve(directory, 'signaling-domain-recovery-current.json'),
    );
    if (!sameDeployment(currentDeployment, attempt.candidateDeployment)) {
      throw new Error('Current signaling Worker no longer matches the recorded deployment.');
    }
    const fresh = await readSignalingInventory({ fetcher, env });
    if (!sameInventory(fresh, current)) {
      throw new Error('Signaling domain identity changed immediately before detach.');
    }
    const confirmedDeployment = querySignalingDeployment(
      resolve(directory, 'signaling-domain-recovery-confirmed.json'),
    );
    if (
      !sameDeployment(confirmedDeployment, currentDeployment) ||
      !sameDeployment(confirmedDeployment, attempt.candidateDeployment)
    ) {
      throw new Error('Signaling Worker ownership changed immediately before domain detach.');
    }
    issuedMutation = 'detach-requested';
    await detachDomain(currentAlternate.id, { fetcher, env });
    issuedMutation = 'detached-alternate';
    const restored = await readSignalingInventory({ fetcher, env });
    if (!sameInventory(restored, checkpoint.domains)) {
      throw new Error('Signaling domain baseline verification failed after detach.');
    }
    await verifyAlternateEdgeDetached({
      edgeFetcher,
      retryDelaysMs: edgeRetryDelaysMs,
      wait,
    });
    const confirmedBaseline = await readSignalingInventory({ fetcher, env });
    if (!sameInventory(confirmedBaseline, checkpoint.domains)) {
      throw new Error('Signaling domain state changed during edge-detach verification.');
    }
    const report: SignalingDomainRecoveryReport = {
      schemaVersion: 1,
      releaseTarget,
      recordedAt: now(),
      status: 'restored',
      mutation: issuedMutation,
    };
    writeRecoveryReport(directory, SIGNALING_DOMAIN_RECOVERY_FILE, report);
    return report;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown signaling domain recovery error.';
    writeRecoveryReport(directory, SIGNALING_DOMAIN_RECOVERY_FILE, {
      schemaVersion: 1,
      releaseTarget,
      recordedAt: now(),
      status: 'failed',
      mutation: issuedMutation,
      error: message,
    });
    throw error;
  }
}

export async function verifySignalingDomainBaseline(
  releaseTarget: string,
  directory: string,
  {
    fetcher = globalThis.fetch,
    env = process.env,
    now = () => new Date().toISOString(),
  }: SignalingDomainStateOptions = {},
): Promise<SignalingDomainRecoveryReport | null> {
  if (!signalingSelected(releaseTarget)) return null;
  try {
    const checkpoint = parseCheckpoint(releaseTarget, directory, env);
    const current = await readSignalingInventory({ fetcher, env });
    if (!sameInventory(current, checkpoint.domains)) {
      throw new Error('Final signaling Custom Domain state differs from its immutable baseline.');
    }
    const report: SignalingDomainRecoveryReport = {
      schemaVersion: 1,
      releaseTarget,
      recordedAt: now(),
      status: 'verified',
      mutation: 'none',
    };
    writeRecoveryReport(directory, SIGNALING_DOMAIN_VERIFICATION_FILE, report);
    return report;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown signaling domain verification error.';
    writeRecoveryReport(directory, SIGNALING_DOMAIN_VERIFICATION_FILE, {
      schemaVersion: 1,
      releaseTarget,
      recordedAt: now(),
      status: 'failed',
      mutation: 'none',
      error: message,
    });
    throw error;
  }
}

export async function verifySignalingDomainCandidate(
  releaseTarget: string,
  directory: string,
  {
    fetcher = globalThis.fetch,
    env = process.env,
    now = () => new Date().toISOString(),
    querySignalingDeployment = queryLiveSignalingDeployment,
  }: SignalingDomainStateOptions = {},
): Promise<SignalingDomainRecoveryReport | null> {
  if (!signalingSelected(releaseTarget)) return null;
  try {
    const checkpoint = parseCheckpoint(releaseTarget, directory, env);
    const attempt = parseAttempt(releaseTarget, directory, checkpoint);
    if (
      attempt.status !== 'recorded' ||
      !attempt.domains ||
      !attempt.candidateFingerprint ||
      !attempt.candidateDeployment
    ) {
      throw new Error('Recorded signaling Custom Domain candidate evidence is unavailable.');
    }
    assertRecordedDeploymentBoundary(
      directory,
      attempt.candidateDeployment,
      checkpoint.releaseMessage,
    );

    const current = await readSignalingInventory({ fetcher, env });
    if (
      !sameInventory(current, attempt.domains) ||
      inventoryFingerprint(current) !== attempt.candidateFingerprint
    ) {
      throw new Error('Current signaling Custom Domain state differs from the recorded candidate.');
    }
    const currentDeployment = querySignalingDeployment(
      resolve(directory, 'signaling-domain-candidate-current.json'),
    );
    if (!sameDeployment(currentDeployment, attempt.candidateDeployment)) {
      throw new Error('Current signaling Worker no longer matches the recorded candidate.');
    }

    const confirmed = await readSignalingInventory({ fetcher, env });
    if (
      !sameInventory(confirmed, current) ||
      inventoryFingerprint(confirmed) !== attempt.candidateFingerprint
    ) {
      throw new Error('Signaling Custom Domain ownership changed during final verification.');
    }
    const confirmedDeployment = querySignalingDeployment(
      resolve(directory, 'signaling-domain-candidate-confirmed.json'),
    );
    if (
      !sameDeployment(confirmedDeployment, currentDeployment) ||
      !sameDeployment(confirmedDeployment, attempt.candidateDeployment)
    ) {
      throw new Error('Signaling Worker ownership changed during final candidate verification.');
    }

    const report: SignalingDomainRecoveryReport = {
      schemaVersion: 1,
      releaseTarget,
      recordedAt: now(),
      status: 'verified',
      mutation: 'none',
    };
    writeRecoveryReport(directory, SIGNALING_DOMAIN_CANDIDATE_VERIFICATION_FILE, report);
    return report;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown signaling domain candidate verification.';
    writeRecoveryReport(directory, SIGNALING_DOMAIN_CANDIDATE_VERIFICATION_FILE, {
      schemaVersion: 1,
      releaseTarget,
      recordedAt: now(),
      status: 'failed',
      mutation: 'none',
      error: message,
    });
    throw error;
  }
}

async function main(): Promise<void> {
  const [mode, target = '', directory = 'release-artifacts/recovery-checkpoint'] =
    process.argv.slice(2);
  if (mode === 'capture') await captureSignalingDomainCheckpoint(target, directory);
  else if (mode === 'authorize') await authorizeSignalingDomainAttempt(target, directory);
  else if (mode === 'start') await startSignalingDomainAttempt(target, directory);
  else if (mode === 'preflight') await preflightSignalingDomainAttempt(target, directory);
  else if (mode === 'record-attempt') await recordSignalingDomainAttempt(target, directory);
  else if (mode === 'verify-candidate') await verifySignalingDomainCandidate(target, directory);
  else if (mode === 'restore') await restoreSignalingDomainBaseline(target, directory);
  else if (mode === 'verify') await verifySignalingDomainBaseline(target, directory);
  else {
    throw new Error(
      'Usage: node scripts/release-signaling-domain-state.mts <capture|authorize|preflight|start|record-attempt|verify-candidate|restore|verify> <release-target> [directory]',
    );
  }
  console.log('[signaling-domain-state] completed without exposing domain identities.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(
      `[signaling-domain-state] ${error instanceof Error ? error.message : 'Unknown failure.'}`,
    );
    process.exitCode = 1;
  });
}
