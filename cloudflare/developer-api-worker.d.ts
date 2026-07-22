export function parseDeveloperApiKey(value: unknown): { keyId: string; secret: string } | null;
export function deriveDeveloperApiKeyDigest(
  pepper: string,
  keyId: string,
  secret: string,
): Promise<string>;
export function expireDeveloperApiKeys(env: unknown, nowMs?: number): Promise<unknown>;
export function isDeveloperApiRequestId(value: unknown): boolean;
export const developerApiScopes: Readonly<Record<string, number>>;
export class DeveloperApiRateLimiter {
  constructor(state: unknown, env?: unknown);
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}
declare const worker: {
  fetch(request: Request, env: unknown, context?: unknown): Promise<Response>;
  scheduled(
    event: unknown,
    env: unknown,
    context: { waitUntil(promise: Promise<unknown>): void },
  ): void;
};
export default worker;
