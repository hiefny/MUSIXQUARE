const BENIGN_PAGE_ERROR_MESSAGES = new Set([
  'ResizeObserver loop limit exceeded',
  'ResizeObserver loop completed with undelivered notifications.',
]);

/** Keep the browser-error allowlist exact so application failures stay visible. */
export function isBenignPageError(error: Error | string): boolean {
  const message = typeof error === 'string' ? error : error.message;
  return BENIGN_PAGE_ERROR_MESSAGES.has(message.trim());
}
